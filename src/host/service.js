/**
 * dsh-agent-org — OrgService (Cordis Service).
 *
 * Owns the org tree, persists it, and provides hierarchy-aware visibility
 * summaries computed from dsh-agent-room rooms/tasks.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { OrgPersistence } from "./persistence.js";
import { clearRefusedMarker, ensureBackupRoot, failLoud, isUuidShaped, nicknameProblem } from "./safety.js";
import { decodeSnapshot, encodeSnapshot, shouldApply } from "./sync.js";
import { decodeExec, decodeExecResult } from "./exec.js";
import { ExecPlane } from "./exec-plane.js";
import { ExecResultCache } from "./exec-cache.js";
import { sendWithRetry } from "./delivery.js";

/** One warning per key per minute: a broken channel must not flood the log. */
const WARN_WINDOW_MS = 60_000;

/**
 * Minimum movement of a node's `lastSeenAt` before the liveness stamp is written
 * to disk (D-20, 0.2.13).
 *
 * Liveness is a diagnostic, not authoritative tree state: persisting on every
 * inbound sync frame would be write amplification (the 411 MB audit file and the
 * 923 MB join log are what that lesson cost), so the value is always updated in
 * memory and only flushed this often. A crash loses at most this much resolution.
 */
const LIVENESS_PERSIST_MS = 30_000;

import { checkPermission, canRenameNode, roleFor } from "./permission.js";
import { AuditLog } from "./audit.js";
import {
  buildTree,
  childrenOf,
  descendantNodes,
  findNode,
  memberNodesByAgent,
  memberNodesInSubtree,
  summarizeVisibleTasks,
  visibleMemberIds,
  visibleMemberNodes,
} from "./visibility.js";
import { nowIso, uuid } from "./util.js";

export class OrgError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {{ dataDir?: string, tools?: boolean, syncRoomId?: string }} config
 */
export function resolveConfig(config = {}) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return {
    dataDir: config.dataDir ?? join(dshHome, "agent-org"),
    tools: config.tools ?? true,
    syncRoomId: config.syncRoomId ?? "",
  };
}

export class OrgService extends Service {
  /**
   * @param {import("@deepseek-ai/cordis").Context} ctx
   * @param {{ dataDir?: string, tools?: boolean }} config
   */
  constructor(ctx, config = {}) {
    super(ctx, "agentOrg");
    this.config = resolveConfig(config);
    this.persistence = new OrgPersistence(this.config.dataDir);
    /** @type {import("../types.js").OrgState} */
    this.state = { version: 1, nodes: [], updatedAt: "", rev: 0 };
    this.agentRoom = ctx.agentRoom;
    this.lastEvent = null;
    this.syncReady = false;
    /**
     * Idempotency key + result cache (0.2.10): instruction id -> state
     * (executing/executed/failed) and the exact result body.
     *
     * Replaces the old `seenExecIds` set, which dropped every re-delivery and
     * sent nothing back — so the sender waited out its own timeout while the
     * target had already received and answered the frame. Bounded LRU + TTL.
     * @type {ExecResultCache}
     */
    this.execCache = new ExecResultCache();
    /**
     * The exec plane owns every delivery guarantee: exactly-once execution per
     * instruction id, an answer for every delivery (cached result, or "still
     * executing"), and the controller-side wait. Kept free of cordis so it can be
     * unit-tested directly — see test/exec-cache.test.mjs.
     * @type {ExecPlane}
     */
    this.execPlane = new ExecPlane({
      identityAgentId: async () => (await this.agentRoom?.gateway?.identity?.())?.agentId ?? "",
      roleOf: (agentId) => this.roleOf(agentId),
      send: (text, meta) => this.sendControlFrame(text, meta),
      audit: (entry) => void this.audit.append(entry),
      warn: (key, message) => this.warnRateLimited(key, message),
      cache: this.execCache,
    });
    /** Rate-limited warning bookkeeping: key -> last time it was logged. */
    this.warnAt = new Map();
    this.audit = new AuditLog(this.config.dataDir);

    /** @type {Map<string, {id: string, action: string, target: string, requester: string, approver: string, status: "pending"|"approved"|"rejected", ts: string}>} */
    this.approvals = new Map();

    // agent-org listens to agent-room's RoomService events. In v1 this is used
    // to keep a lightweight activity marker; summaries are always computed on
    // demand so no cache invalidation race is possible. v2.1 also syncs the org
    // tree across machines by watching chat messages in the sync room.
    const roomService = this.agentRoom?.roomService;
    if (roomService?.on) {
      const touch = (eventName) => () => {
        this.lastEvent = { event: eventName, at: nowIso() };
      };
      roomService.on("chat", (roomId, message) => this.onChat(roomId, message));
      roomService.on("task", touch("task"));
      roomService.on("taskRemoved", touch("taskRemoved"));
      roomService.on("system", touch("system"));
      roomService.on("members", touch("members"));
      roomService.on("revoked", touch("revoked"));
    }

    ctx.effect(() => {
      // 0.2.11: today's exit(1) for a damaged org-state.json was ACCIDENTAL — the
      // bare `void this.boot()` produced an unhandled rejection that the host's
      // process-level `installFailLoud` handler happened to catch. That made
      // "refuse to start" an emergent property of the host, not a contract this
      // plugin declares: if the host ever upgrades, or exempts the rejection, the
      // failure mode would quietly revert to "keep running on an empty tree".
      // Say it explicitly, and rethrow so the host fatal path still runs (it
      // disposes the half-built fiber before exiting).
      void this.boot().catch((error) => failLoud("[agent-org]", error, this.ctx.logger));
      return () => {};
    }, "agent-org: boot");
  }

  /**
   * Load the org tree (0.2.11).
   *
   * A damaged org-state.json now REJECTS this promise instead of yielding an
   * empty tree (see OrgPersistence.load). Order matters: prove the backup root
   * first, so an unresolvable backup path is a named config error rather than a
   * failure discovered halfway through a later write.
   */
  async boot() {
    await ensureBackupRoot();
    this.state = await this.persistence.load();
    if (typeof this.state.rev !== "number") this.state.rev = 0;
    const syncCfg = await this.persistence.loadSyncConfig();
    if (syncCfg.roomId) this.config.syncRoomId = String(syncCfg.roomId);
    this.syncReady = true;
    // G4: reaching the end of boot is the only claim that this node really came
    // up, and the plugin is the only party allowed to make it. The watchdog just
    // READS the marker, so a repaired machine restarts itself.
    await clearRefusedMarker(this.config.dataDir);
  }

  /** @returns {{roomId?: string}} */
  async getSyncConfig() {
    return { roomId: this.config.syncRoomId || "" };
  }

  /**
   * Set (or clear) the cross-machine sync room at runtime; persisted so it
   * survives restarts.
   * @param {string} roomId
   */
  async setSyncRoom(roomId) {
    this.config.syncRoomId = String(roomId ?? "").trim();
    await this.persistence.saveSyncConfig({ roomId: this.config.syncRoomId });
    if (this.config.syncRoomId) await this.save(); // bump rev + persist + broadcast
    return { roomId: this.config.syncRoomId };
  }

  async save() {
    this.state.updatedAt = nowIso();
    this.state.rev = (typeof this.state.rev === "number" ? this.state.rev : 0) + 1;
    await this.persistence.save(this.state);
    await this.broadcastSnapshot();
  }

  /**
   * Stamp a node's liveness (D-20, 0.2.13).
   *
   * WHAT IT IS FOR: `GET /agent-org-api/state` could not answer "is this colleague
   * reachable". Node records carried `updatedAt`, which is an EDIT stamp — measured
   * frozen at 2026-09-12T14:26 while the machine was alive — so a reader had to
   * spend three exec timeouts (45s/25s/25s) plus a room ping and still ended up
   * asking a human whether 小捷 was off duty or wedged. `lastSeenAt` answers it from
   * state alone, and `lastExecAt`/`lastExecOk` add "and it can actually run
   * commands".
   *
   * DELIBERATELY NOT `save()`: that bumps `rev` and BROADCASTS a snapshot, so
   * stamping liveness on every inbound frame would fan a full org tree out over the
   * room at frame rate — the write-amplification class this codebase already paid
   * for twice (a 411 MB audit file, a 923 MB join log). Liveness is written on a
   * throttle and travels with the next real snapshot; the LIVE surface for "is it
   * reachable right now" is the room's own `member.lastSeenAt`, which updates on
   * every frame. `state.updatedAt` remains the snapshot's own timestamp, so a
   * reader can always tell how fresh the liveness fields are.
   *
   * @param {string} agentId
   * @param {{execOk?: boolean, address?: string}} [patch]
   * @returns {object|undefined} the node, or undefined when no node carries that agentId
   */
  touchNodeLiveness(agentId, patch = {}) {
    const id = String(agentId ?? "");
    if (!id) return undefined;
    const node = this.state.nodes.find((n) => n.agentId === id);
    if (!node) return undefined;
    const now = nowIso();
    // Decided BEFORE the update: this is the disk-write throttle.
    const moved = !node.lastSeenAt || Date.parse(now) - Date.parse(node.lastSeenAt) >= LIVENESS_PERSIST_MS;
    if (patch.address) node.lastSeenAddress = String(patch.address);
    if (patch.execOk !== undefined) {
      node.lastExecAt = now;
      // A boolean, never a coerced truthy: "unknown" must stay distinguishable.
      node.lastExecOk = patch.execOk === true;
    }
    node.lastSeenAt = now;
    if (moved || patch.execOk !== undefined) {
      void this.persistence.save(this.state).catch(() => { /* diagnostics only */ });
    }
    return node;
  }

  /** Liveness of one node, as `GET /agent-org-api/state` reports it. */
  nodeLiveness(nodeIdOrAgentId) {
    const node = this.state.nodes.find((n) => n.id === nodeIdOrAgentId || n.agentId === nodeIdOrAgentId);
    if (!node) return undefined;
    return {
      nodeId: node.id,
      name: node.name,
      agentId: node.agentId,
      lastSeenAt: node.lastSeenAt,
      lastSeenAddress: node.lastSeenAddress,
      lastExecAt: node.lastExecAt,
      lastExecOk: node.lastExecOk,
      updatedAt: node.updatedAt,
    };
  }

  /** Broadcast the org snapshot to the sync room (cross-machine sync). */
  async broadcastSnapshot() {
    if (!this.config.syncRoomId || !this.syncReady) return;
    try {
      const identity = await this.agentRoom?.gateway?.identity?.();
      const ownerAgentId = this.state.nodes.find((n) => n.kind === "company")?.leaderAgentId ?? "";
      // Verified write (0.2.10): a snapshot that silently vanished left a node
      // permanently out of date with no trace of why.
      await this.sendControlFrame(
        encodeSnapshot(this.state, { by: identity?.agentId ?? "", ownerAgentId }),
        { label: "snapshot:" + this.state.rev },
      );
    } catch (error) {
      // Sync is best-effort by design: a node that is offline simply misses a
      // snapshot and catches up on the next broadcast. sendControlFrame has
      // already retried and logged, so only an unexpected throw lands here.
      this.warnRateLimited("broadcast", `[agent-org] snapshot broadcast failed: ${String(error)}`);
    }
  }

  /** Apply an inbound org snapshot / exec instruction / exec result. */
  async onChat(roomId, message) {
    const text = message?.text;
    if (!this.config.syncRoomId || roomId !== this.config.syncRoomId) return;

    // 0. LIVENESS (D-20, 0.2.13): this frame proves the sender's plugin is alive
    //    right now. Recorded before any branch, so a snapshot, an instruction or a
    //    result all count as contact — and a colleague who is merely OFF DUTY stops
    //    looking identical to one whose plugin is wedged.
    if (message?.from) this.touchNodeLiveness(message.from);

    // 1. exec result -> resolve the pending sender (interim 202 answers ignored)
    const result = decodeExecResult(text);
    if (result) {
      // A finished answer separates "reachable" from "reachable and able to run
      // commands"; the 202 interim body is NOT a result and must not stamp `ok`.
      if (result.pending !== true) this.touchNodeLiveness(result.by ?? message.from, { execOk: result.ok === true });
      this.execPlane.handleResult(result);
      return;
    }

    // 2. exec instruction -> execute only if targeted at this machine AND the
    //    sender is authorized (owner/lead). Receiving side must NOT trust the
    //    payload alone — any room member could otherwise RCE this node.
    //    ExecPlane then guarantees: one real execution per id, and an ANSWER for
    //    every delivery (cached result / still-executing 202 / fresh result).
    const instruction = decodeExec(text);
    if (instruction) {
      const outcome = await this.execPlane.handleInstruction(instruction, message);
      // The TARGET side's own liveness: this node really did run (or refuse) the
      // command, which is the strongest liveness evidence there is.
      if (outcome?.executed) this.touchNodeLiveness(outcome.result?.by, { execOk: outcome.result?.ok === true });
      return;
    }

    // 3. org snapshot sync
    const snapshot = decodeSnapshot(text);
    if (!snapshot) return;
    const identity = await this.agentRoom?.gateway?.identity?.();
    if (!shouldApply(this.state, snapshot, identity?.agentId ?? "")) return;
    this.state = {
      version: snapshot.version,
      nodes: snapshot.nodes,
      updatedAt: snapshot.updatedAt,
      rev: snapshot.rev,
    };
    await this.persistence.save(this.state);
  }

  /**
   * Send a control frame and VERIFY it was accepted (0.2.10).
   *
   * `gateway.sendChat` used to return null for a joined room, so a failed result
   * write was indistinguishable from a successful one and the frame was lost
   * with the sender still waiting. Now the status is checked, the write is
   * retried with bounded exponential backoff, and an ultimate failure is logged
   * (rate-limited) instead of swallowed.
   *
   * @param {string} text
   * @param {{label?: string, roomId?: string}} [options]
   */
  async sendControlFrame(text, options = {}) {
    const roomId = options.roomId ?? this.config.syncRoomId;
    const label = options.label ?? "control-frame";
    if (!roomId) return { ok: false, attempts: 0, queued: false, unknown: false, status: undefined, reason: "no_sync_room" };
    const outcome = await sendWithRetry(
      (frame) => {
        const sent = this.agentRoom?.gateway?.sendChat?.(roomId, { text: frame, human: false });
        return sent ?? null;
      },
      text,
    );
    if (!outcome.ok) {
      this.warnRateLimited(
        "delivery:" + label,
        `[agent-org] failed to write ${label} to ${roomId} after ${outcome.attempts} attempt(s): ${outcome.reason ?? "unknown"}`,
      );
    } else if (outcome.unknown) {
      this.warnRateLimited(
        "unverified:" + label,
        `[agent-org] ${label} write to ${roomId} returned no delivery status (agent-room < 0.1.34?) — acceptance unverified`,
      );
    } else if (outcome.queued) {
      this.warnRateLimited(
        "queuedframe:" + label,
        `[agent-org] channel to ${roomId} was not open: ${label} queued by agent-room for replay`,
      );
    }
    return outcome;
  }

  /** One warning per key per minute. */
  warnRateLimited(key, message) {
    const now = Date.now();
    if (now - (this.warnAt.get(key) ?? 0) < WARN_WINDOW_MS) return;
    this.warnAt.set(key, now);
    try {
      console.warn(message);
    } catch {
      /* logging must never throw */
    }
  }

  /**
   * Send a remote exec instruction to a target machine and await its result.
   *
   * The role gate stays here (an OrgService concern); the idempotency key, the
   * verified write and the controller-side waiter live in ExecPlane.
   *
   * @param {string} targetAgentId
   * @param {string} command
   */
  async sendExec(targetAgentId, command) {
    if (!this.config.syncRoomId) throw new OrgError("no_sync_room", "未配置同步房间，无法远程执行");
    const identity = await this.agentRoom?.gateway?.identity?.();
    const callerRole = this.roleOf(identity?.agentId ?? "");
    if (callerRole !== "owner" && callerRole !== "lead") {
      throw new OrgError("exec_forbidden", `仅 owner/lead 可发起远程执行（当前 role=${callerRole}）`);
    }
    return this.execPlane.sendExec(targetAgentId, command);
  }

  /**
   * Studio preset: idempotently build the org for the boss's AI studio.
   * company (leader = controller) → members (assistants).
   *
   * @param {{company?: string, controllerAgentId?: string, members?: Array<{agentId: string, name?: string}>}} input
   */
  async applyStudioPreset(input = {}) {
    const companyName = String(input.company ?? "AI 工作室").trim() || "AI 工作室";
    const controller = String(input.controllerAgentId ?? "").trim();
    const members = Array.isArray(input.members) ? input.members : [];

    let company = this.state.nodes.find((n) => n.kind === "company");
    if (!company) {
      company = await this.createCompany(companyName);
    }
    if (controller) {
      // 主控必须是组织内的成员，先挂在公司下（部门可留空，成员直接挂公司需要调整 ——
      // v1 要求成员挂部门/团队下，这里为公司建一个默认「总部」部门承载成员）。
      const dept = await this.ensureDepartment(company.id, "总部");
      await this.ensureMember(dept.id, controller, "主控");
      await this.setLeader(company.id, controller);
    }
    for (const m of members) {
      const agentId = String(m.agentId ?? "").trim();
      if (!agentId) continue;
      const dept = await this.ensureDepartment(company.id, "总部");
      await this.ensureMember(dept.id, agentId, m.name ?? agentId);
    }
    return this.state;
  }

  /** @param {string} companyId @param {string} name */
  async ensureDepartment(companyId, name) {
    const existing = this.state.nodes.find((n) => n.kind === "department" && n.parentId === companyId && n.name === name);
    if (existing) return existing;
    return this.createDepartment(companyId, name);
  }

  /** @param {string} parentId @param {string} agentId @param {string} name */
  async ensureMember(parentId, agentId, name) {
    const existing = this.state.nodes.find((n) => n.kind === "member" && n.agentId === agentId);
    if (existing) return existing;
    return this.addMember(parentId, { agentId, name });
  }

  /**
   * Current agent's role in the org: "controller" (leads a company/unit),
   * "member", or "none".
   * @param {string} agentId
   */
  async myRole(agentId) {
    const members = memberNodesByAgent(this.state, agentId);
    if (members.length === 0) return { role: "none", memberId: null, company: null };
    const leading = this.state.nodes.find(
      (n) => n.kind !== "member" && n.leaderAgentId === agentId,
    );
    const company = this.state.nodes.find((n) => n.kind === "company") ?? null;
    return {
      role: leading ? "controller" : "member",
      memberId: members[0].id,
      company: company ? { id: company.id, name: company.name } : null,
    };
  }

  /* --------------------- permission matrix + approvals + audit ------------- */

  /** @param {string} agentId */
  roleOf(agentId) {
    return roleFor(this.state, agentId);
  }

  /**
   * @param {string} agentId
   * @param {string} action
   */
  check(agentId, action) {
    return checkPermission(this.state, agentId, action);
  }

  /**
   * Create a pending approval for an L2 action and log it.
   * @param {string} requester
   * @param {string} action
   * @param {string} target
   */
  requestApproval(requester, action, target) {
    const decision = checkPermission(this.state, requester, action);
    if (!decision.needsApproval) {
      return { id: null, decision, note: decision.allowed ? "无需审批" : "无权执行" };
    }
    const id = uuid();
    const approval = {
      id,
      action,
      target: String(target ?? ""),
      requester,
      approver: decision.approver ?? "",
      status: "pending",
      ts: nowIso(),
    };
    this.approvals.set(id, approval);
    void this.audit.append({ agentId: requester, action, target, result: "requested" });
    return { id, decision, approval };
  }

  /**
   * @param {string} approvalId
   * @param {string} approverAgentId
   */
  decide(approvalId, approverAgentId, approve) {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new OrgError("approval_not_found", "审批单不存在");
    if (approval.approver && approverAgentId !== approval.approver) {
      throw new OrgError("not_approver", "只有指定的审批人可以处理此审批");
    }
    approval.status = approve ? "approved" : "rejected";
    approval.decidedBy = approverAgentId;
    approval.decidedAt = nowIso();
    void this.audit.append({
      agentId: approverAgentId,
      action: "approve:" + approval.action,
      target: approval.id,
      result: approve ? "approved" : "rejected",
    });
    return approval;
  }

  /**
   * @param {string} viewerAgentId
   */
  listApprovals(viewerAgentId) {
    const role = this.roleOf(viewerAgentId);
    const all = [...this.approvals.values()];
    if (role === "owner") return all;
    return all.filter((a) => a.approver === viewerAgentId || a.requester === viewerAgentId);
  }

  /** @returns {Promise<Array>} */
  exportAudit() {
    return this.audit.export();
  }

  /** @returns {import("../types.js").OrgState} */
  getState() {
    return this.state;
  }

  /** @returns {Array} */
  listNodes() {
    return this.state.nodes.slice();
  }

  /**
   * @param {string} name
   */
  async createCompany(name) {
    if (this.state.nodes.some((n) => n.kind === "company")) {
      throw new OrgError("company_exists", "公司已存在，只能有一个根公司节点");
    }
    const now = nowIso();
    const node = {
      id: uuid(),
      kind: "company",
      name: String(name ?? "").trim() || "我的公司",
      parentId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.nodes.push(node);
    await this.save();
    return node;
  }

  /**
   * @param {string} companyId
   * @param {string} name
   */
  async createDepartment(companyId, name) {
    const parent = this.requireNode(companyId);
    if (parent.kind !== "company") throw new OrgError("invalid_parent", "部门必须挂在公司下");
    const now = nowIso();
    const node = {
      id: uuid(),
      kind: "department",
      name: String(name ?? "").trim(),
      parentId: companyId,
      createdAt: now,
      updatedAt: now,
    };
    if (!node.name) throw new OrgError("name_required", "部门名称不能为空");
    this.state.nodes.push(node);
    await this.save();
    return node;
  }

  /**
   * @param {string} departmentId
   * @param {string} name
   */
  async createTeam(departmentId, name) {
    const parent = this.requireNode(departmentId);
    if (parent.kind !== "department") throw new OrgError("invalid_parent", "团队必须挂在部门下");
    const now = nowIso();
    const node = {
      id: uuid(),
      kind: "team",
      name: String(name ?? "").trim(),
      parentId: departmentId,
      createdAt: now,
      updatedAt: now,
    };
    if (!node.name) throw new OrgError("name_required", "团队名称不能为空");
    this.state.nodes.push(node);
    await this.save();
    return node;
  }

  /**
   * Add a member under a department or team. A department may contain members
   * directly, which also satisfies the v1 "公司→部门→成员" shape.
   *
   * @param {string} parentId
   * @param {{agentId: string, name?: string}} input
   */
  async addMember(parentId, input) {
    const parent = this.requireNode(parentId);
    if (parent.kind !== "department" && parent.kind !== "team") {
      throw new OrgError("invalid_parent", "成员必须挂在部门或团队下");
    }
    const agentId = input.agentId?.trim();
    if (!agentId) throw new OrgError("agent_required", "成员 agentId 不能为空");
    if (this.state.nodes.some((n) => n.kind === "member" && n.agentId === agentId)) {
      throw new OrgError("member_exists", `成员 ${agentId} 已存在于组织树`);
    }
    const now = nowIso();
    const node = {
      id: uuid(),
      kind: "member",
      name: (input.name ?? agentId).trim() || agentId,
      parentId,
      agentId,
      createdAt: now,
      updatedAt: now,
    };
    this.state.nodes.push(node);
    await this.save();
    return node;
  }

  /**
   * @param {string} id
   * @param {{name?: string, leaderAgentId?: string|null, agentId?: string}} patch
   * @param {string} [actorAgentId] the caller's own agentId. REQUIRED for a rename
   *   (0.2.12): an empty actor is denied, so a call path that forgets to identify
   *   its caller cannot rename a node.
   */
  async updateNode(id, patch, actorAgentId = "") {
    const node = this.requireNode(id);
    if (patch.name !== undefined) {
      const name = String(patch.name ?? "").trim();
      if (!name) throw new OrgError("name_required", "名称不能为空");
      // G1 (0.2.11): the same content gate as the room nickname. An org node name
      // is a display identity read by every machine's tree, and the damage classes
      // here are the ones actually observed in the field.
      const problem = nicknameProblem(name);
      if (problem) throw new OrgError("name_invalid", `名称不可用：${problem}`);
      // 0.2.12: authorization. Before this release the name was written with no
      // permission check at all and the route carried no caller identity, so any
      // caller reaching port 3080 could rename ANY node — the card-01 security
      // gap. The actor is now the caller's own agentId, checked here, in the one
      // place a name is written.
      this.assertMayRename(node, actorAgentId);
      node.name = name;
    }
    if (patch.agentId !== undefined) {
      if (node.kind !== "member") throw new OrgError("invalid_field", "只有成员节点可以设置 agentId");
      const agentId = String(patch.agentId ?? "").trim();
      if (!agentId) throw new OrgError("agent_required", "成员 agentId 不能为空");
      // G1: a member node's agentId is the ONLY link from the org tree to a
      // machine. A typo or a placeholder here silently orphans that member.
      if (!isUuidShaped(agentId)) throw new OrgError("agent_invalid", `成员 agentId 不是 UUID：${agentId}`);
      if (this.state.nodes.some((n) => n.id !== id && n.kind === "member" && n.agentId === agentId)) {
        throw new OrgError("member_exists", `成员 ${agentId} 已存在于组织树`);
      }
      node.agentId = agentId;
    }
    if (patch.leaderAgentId !== undefined) {
      await this.setLeader(id, patch.leaderAgentId === null ? null : String(patch.leaderAgentId ?? ""));
    }
    node.updatedAt = nowIso();
    await this.save();
    return node;
  }

  /**
   * Refuse a rename this actor is not authorised to perform (0.2.12).
   *
   * The decision comes from `canRenameNode` (permission.js): renaming your OWN
   * member node is L1, renaming anything else is L2 (the org owner may, everyone
   * else needs approval). Both outcomes are audited — a refused cross-machine
   * rename must leave a trace, because the card's failure mode was a rename that
   * silently reappeared in its old value.
   *
   * @param {{id: string, kind?: string, agentId?: string}} node
   * @param {string} actorAgentId
   */
  assertMayRename(node, actorAgentId) {
    const decision = canRenameNode(this.state, actorAgentId, node);
    if (!decision.allowed) {
      void this.audit.append({
        agentId: actorAgentId || "(unknown)",
        action: decision.action,
        target: node.id,
        result: "denied",
      });
      const why = decision.needsApproval
        ? `需要审批（${decision.action}，审批人 ${decision.approver ?? "无"}）`
        : `角色 ${decision.role} 无权执行 ${decision.action}`;
      throw new OrgError("rename_denied", `无权改名：${why}`);
    }
    void this.audit.append({ agentId: actorAgentId, action: decision.action, target: node.id, result: "allowed" });
    return decision;
  }

  /**
   * Rename ONE member node, addressed by agentId (0.2.12).
   *
   * This is the org-side half of card-01's three-store rename: dsh-agent-room
   * calls it in-process through `ctx.get("agentOrg")` right after it updates the
   * nickname, so the org tree node name follows immediately instead of never.
   *
   * It goes through `updateNode` on purpose: `save()` is what bumps `rev` and
   * broadcasts the snapshot, and a rename that only wrote the file would leave
   * every other machine on the old name (card-01 §4.2). The permission gate is
   * the same one every other rename uses, with the target agent's own agentId as
   * the actor — so a member may always correct their OWN node.
   *
   * @param {string} agentId the machine whose node is renamed (must equal `nickname`'s owner)
   * @param {string} nickname the new display name
   */
  async renameSelfByAgentId(agentId, nickname) {
    const target = String(agentId ?? "").trim();
    if (!target) throw new OrgError("agent_required", "agentId 不能为空");
    const node = this.state.nodes.find((n) => n.kind === "member" && n.agentId === target);
    if (!node) throw new OrgError("member_not_found", `组织树里没有 agentId=${target} 的成员节点`);
    const updated = await this.updateNode(node.id, { name: nickname }, target);
    return { nodeId: updated.id, name: updated.name, rev: this.state.rev };
  }

  /**
   * This machine's own agentId, WITHOUT ever minting one (0.2.12).
   *
   * The rename route needs to know WHO is calling. `gateway.identity()` is not a
   * getter — it mints a fresh identity (and writes it) when the cache is empty —
   * so it must not be the first choice on an authorization path: an authorization
   * check must never create the thing it is authorizing.
   *
   * Order: the room plugin's synchronous, non-minting `getIdentity()`; if that
   * accessor exists but the cache is cold (boot unfinished) return "" so the
   * permission gate denies (fail closed); only when the accessor is absent (an
   * older/mismatched room plugin) fall back to `gateway.identity()`.
   */
  async localAgentId() {
    const room = this.agentRoom;
    const getIdentity = room?.roomService?.getIdentity;
    if (typeof getIdentity === "function") {
      const cached = getIdentity.call(room.roomService);
      return cached?.agentId ?? "";
    }
    const identity = await room?.gateway?.identity?.();
    return identity?.agentId ?? "";
  }

  /**
   * Set/clear the leader of a company/department/team.
   * The leader must be a member inside the subtree, so "上级" is always a real
   * org member who can see their own branch.
   *
   * @param {string} nodeId
   * @param {string|null} agentId
   */
  async setLeader(nodeId, agentId) {
    const node = this.requireNode(nodeId);
    if (node.kind === "member") throw new OrgError("invalid_node", "成员节点不能作为组织单元设置上级");
    if (agentId === null || agentId === "") {
      node.leaderAgentId = undefined;
      node.updatedAt = nowIso();
      await this.save();
      return node;
    }
    const member = memberNodesInSubtree(this.state, nodeId).find((m) => m.agentId === agentId);
    if (!member) {
      throw new OrgError("leader_not_in_subtree", "上级必须是该组织单元树内的成员");
    }
    node.leaderAgentId = agentId;
    node.updatedAt = nowIso();
    await this.save();
    return node;
  }

  /**
   * Delete a node and its descendants. The root company cannot be deleted.
   * @param {string} id
   */
  async removeNode(id) {
    const node = this.requireNode(id);
    if (node.kind === "company") throw new OrgError("cannot_delete_company", "不能删除根公司，可以改名");
    const toRemove = new Set([id, ...descendantNodes(this.state, id).map((n) => n.id)]);
    this.state.nodes = this.state.nodes.filter((n) => !toRemove.has(n.id));
    await this.save();
  }

  /**
   * @param {string} id
   * @returns {Object}
   */
  requireNode(id) {
    const node = findNode(this.state, id);
    if (!node) throw new OrgError("node_not_found", `组织节点不存在: ${id}`);
    return node;
  }

  /** @returns {Promise<Array>} */
  async collectRooms() {
    const rooms = [];
    try {
      const { owned = [], joined = [] } = this.agentRoom?.gateway?.listRooms?.() ?? {};
      for (const room of owned) rooms.push(room);
      for (const record of joined) {
        if (!record?.roomId) continue;
        try {
          const info = await this.agentRoom.gateway.roomInfo(record.roomId);
          if (info?.room) rooms.push(info.room);
        } catch {
          // A remote room may be offline; skip it rather than failing the summary.
        }
      }
    } catch {
      // If agent-room is not ready, return an empty room list.
    }
    return rooms;
  }

  /**
   * @param {string} viewerAgentId
   */
  async visibleTasks(viewerAgentId) {
    const rooms = await this.collectRooms();
    const visibleIds = visibleMemberIds(this.state, viewerAgentId);
    return summarizeVisibleTasks(rooms, visibleIds);
  }

  /**
   * @param {string} [viewerAgentId]
   */
  async browserState(viewerAgentId) {
    const identity = await this.agentRoom?.gateway?.identity?.();
    const viewer = viewerAgentId ?? identity?.agentId ?? "";
    const rooms = await this.collectRooms();
    const visibleIds = visibleMemberIds(this.state, viewer);
    const { summary } = summarizeVisibleTasks(rooms, visibleIds);
    return {
      identity: identity ?? null,
      nodes: this.listNodes(),
      tree: buildTree(this.state),
      rev: typeof this.state.rev === "number" ? this.state.rev : 0,
      updatedAt: this.state.updatedAt ?? "",
      visibleMemberIds: [...visibleIds],
      visibleMembers: visibleMemberNodes(this.state, viewer).map((n) => ({
        id: n.id,
        name: n.name,
        agentId: n.agentId,
        parentId: n.parentId,
        // Liveness (D-20, 0.2.13): "who of my people is reachable", from state
        // alone. Absent (undefined) for a node that has not been heard from since
        // the upgrade — unknown, never "offline".
        lastSeenAt: n.lastSeenAt,
        lastSeenAddress: n.lastSeenAddress,
        lastExecAt: n.lastExecAt,
        lastExecOk: n.lastExecOk,
      })),
      summary,
      roomCount: rooms.length,
      lastEvent: this.lastEvent,
    };
  }
}
