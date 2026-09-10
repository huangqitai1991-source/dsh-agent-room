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
import { decodeSnapshot, encodeSnapshot, shouldApply } from "./sync.js";
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
      void this.boot();
      return () => {};
    }, "agent-org: boot");
  }

  async boot() {
    this.state = await this.persistence.load();
    if (typeof this.state.rev !== "number") this.state.rev = 0;
    this.syncReady = true;
  }

  async save() {
    this.state.updatedAt = nowIso();
    this.state.rev = (typeof this.state.rev === "number" ? this.state.rev : 0) + 1;
    await this.persistence.save(this.state);
    await this.broadcastSnapshot();
  }

  /** Broadcast the org snapshot to the sync room (cross-machine sync). */
  async broadcastSnapshot() {
    if (!this.config.syncRoomId || !this.syncReady) return;
    try {
      await this.agentRoom?.gateway?.sendChat?.(this.config.syncRoomId, {
        text: encodeSnapshot(this.state),
        human: false,
      });
    } catch {
      // Sync is best-effort; a node that is offline simply misses a snapshot
      // and catches up on the next broadcast.
    }
  }

  /** Apply an inbound org snapshot when it is newer than the local tree. */
  async onChat(roomId, message) {
    if (!this.config.syncRoomId || roomId !== this.config.syncRoomId) return;
    const snapshot = decodeSnapshot(message?.text);
    if (!snapshot || !shouldApply(this.state, snapshot)) return;
    this.state = snapshot;
    await this.persistence.save(this.state);
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
   */
  async updateNode(id, patch) {
    const node = this.requireNode(id);
    if (patch.name !== undefined) {
      const name = String(patch.name ?? "").trim();
      if (!name) throw new OrgError("name_required", "名称不能为空");
      node.name = name;
    }
    if (patch.agentId !== undefined) {
      if (node.kind !== "member") throw new OrgError("invalid_field", "只有成员节点可以设置 agentId");
      const agentId = String(patch.agentId ?? "").trim();
      if (!agentId) throw new OrgError("agent_required", "成员 agentId 不能为空");
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
      visibleMemberIds: [...visibleIds],
      visibleMembers: visibleMemberNodes(this.state, viewer).map((n) => ({
        id: n.id,
        name: n.name,
        agentId: n.agentId,
        parentId: n.parentId,
      })),
      summary,
      roomCount: rooms.length,
      lastEvent: this.lastEvent,
    };
  }
}
