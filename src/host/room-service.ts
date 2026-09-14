/**
 * dsh-agent-room — RoomService.
 *
 * Authoritative owner-side logic: identity, room lifecycle, join authorization,
 * chat stream, task board, and the judging model (controller / auto).
 * The host wires this into DSH; the PeerServer broadcasts its events to member
 * sockets; tools call into it directly.
 */

import { EventEmitter } from "node:events";
import type {
  AgentIdentity,
  ChatMessage,
  JoinedRoomRecord,
  Member,
  RevokedMember,
  RoleKey,
  Room,
  RoomSettings,
  SystemEvent,
  Task,
  TaskHandoff,
} from "../types.js";
import { Persistence } from "./persistence.js";
import { nicknameProblem } from "./safety.js";
import { hashPassword, nowIso, randomToken, signRelayTicket, uuidv7, verifyPassword } from "./util.js";
import { ZERO_WEIGHT_CAPABILITIES } from "./catalog.js";

export interface CreateRoomInput {
  title: string;
  type: "persistent" | "temporary";
  settings?: Partial<RoomSettings> & { password?: string };
}

export interface RoomServiceEvents {
  chat: (roomId: string, message: ChatMessage) => void;
  task: (roomId: string, task: Task) => void;
  taskRemoved: (roomId: string, taskId: string) => void;
  system: (roomId: string, event: SystemEvent) => void;
  members: (roomId: string, members: Member[]) => void;
  roomState: (roomId: string, status: Room["status"]) => void;
  /** A member's admission rights were revoked; close their live sockets. */
  revoked: (roomId: string, agentId: string) => void;
}

export interface RoomServiceOptions {
  dataDir: string;
  /** Callback so the host can lazily start the peer server on first room. */
  onNeedServer?: () => Promise<string | undefined>;
}

/** Relay ticket lifetime in seconds. */
const RELAY_TICKET_TTL_S = 24 * 60 * 60;

/**
 * Minimum movement of `lastSeenAt` before a member touch is written to disk.
 *
 * Liveness is a diagnostic, not authoritative state: a member send already
 * appends to the message log, and a full room-file write per inbound frame would
 * be write amplification for no reader's benefit. 30s is three profile frames
 * (the 15s `profileTimer` in service.ts) — fine enough to separate "off duty"
 * from "wedged", coarse enough to keep the write rate bounded.
 */
const MEMBER_TOUCH_PERSIST_MS = 30_000;

/** Error carrying a stable code for tool/HTTP layers to map. */
export class RoomError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class RoomService extends EventEmitter {
  private readonly persistence: Persistence;
  private readonly onNeedServer?: () => Promise<string | undefined>;
  private identity: AgentIdentity | null = null;
  /** Rooms owned by this node (authoritative), keyed by roomId. */
  private readonly owned = new Map<string, Room>();
  /** Session tokens for owned rooms: roomId -> agentId -> token. */
  private readonly tokens = new Map<string, Map<string, string>>();
  /** Per-room message sequence counters. */
  private readonly seqs = new Map<string, number>();
  /** Recent rooms this node joined or created. */
  private joined: JoinedRoomRecord[] = [];

  /** Relay auth secrets (roomId -> 256-bit hex), kept OUT of the room object
   *  so snapshots never leak them to members. */
  relaySecrets: Record<string, string> = {};

  constructor(options: RoomServiceOptions) {
    super();
    this.persistence = new Persistence(options.dataDir);
    this.onNeedServer = options.onNeedServer;
  }

  override on<K extends keyof RoomServiceEvents>(event: K, listener: RoomServiceEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof RoomServiceEvents>(event: K, ...args: Parameters<RoomServiceEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /* ------------------------------ identity ----------------------------- */

  /**
   * Return this node's identity, minting one on a genuine first run (0.1.38).
   *
   * The mint branch below is reachable ONLY when `loadIdentity()` returns null,
   * and since 0.1.38 that means exactly one thing: `identity.json` DOES NOT
   * EXIST. A present-but-unparseable file (a UTF-8 BOM from PowerShell 5.1, a
   * truncated write, garbage) now throws CorruptConfigError from the read path,
   * so it can never reach `saveIdentity` — the silent agentId re-mint this
   * release exists to stop. `saveIdentity` independently refuses to overwrite an
   * unparseable identity.json, which keeps that property even if a future caller
   * swallows the error somewhere above.
   */
  async ensureIdentity(): Promise<AgentIdentity> {
    if (this.identity) return this.identity;
    const existing = await this.persistence.loadIdentity();
    if (existing) {
      this.identity = existing;
      return existing;
    }
    const fresh: AgentIdentity = {
      agentId: uuidv7(),
      nickname: defaultNickname(),
      capabilities: [],
      createdAt: nowIso(),
    };
    await this.persistence.saveIdentity(fresh);
    this.identity = fresh;
    return fresh;
  }

  getIdentity(): AgentIdentity | null {
    return this.identity;
  }

  async updateProfile(patch: Partial<Pick<AgentIdentity, "nickname" | "bio">> & { capabilities?: string[] }): Promise<AgentIdentity> {
    const id = await this.ensureIdentity();
    // G1 (0.1.38): validate a nickname where it is deliberately SET, not on every
    // save. Validating inside saveIdentity would let a pre-existing bad name —
    // the literal "NAME" that an unfilled template wrote on two machines — turn a
    // routine capability merge at boot into a startup outage.
    if (patch.nickname !== undefined) {
      const problem = nicknameProblem(patch.nickname);
      if (problem) throw new Error(`拒绝写入该昵称：${problem}`);
      id.nickname = patch.nickname;
    }
    if (patch.bio !== undefined) id.bio = patch.bio;
    if (patch.capabilities !== undefined) id.capabilities = [...new Set(patch.capabilities)];
    await this.persistence.saveIdentity(id);
    return id;
  }

  /** Merge auto-collected capability names (skills/tools) into identity. */
  async mergeCapabilities(names: string[]): Promise<AgentIdentity> {
    const id = await this.ensureIdentity();
    let changed = false;
    for (const name of names) {
      if (name && !id.capabilities.includes(name)) {
        id.capabilities.push(name);
        changed = true;
      }
    }
    if (changed) await this.persistence.saveIdentity(id);
    return id;
  }

  /* ------------------------------ boot/restore ------------------------- */

  async boot(): Promise<void> {
    const identity = await this.ensureIdentity();
    this.joined = await this.persistence.loadJoined();
    this.relaySecrets = await this.persistence.loadRelaySecrets();
    const rooms = await this.persistence.loadPersistentRooms();
    for (const room of rooms) {
      if (room.ownerAgentId !== identity.agentId) continue;
      if (room.status === "suspended") room.status = "open";
      // Repair a room whose member list holds more than one record for one
      // agentId (D-21). The field data is exactly this: 小捷 appeared twice with
      // joinedAt 2026-09-14T00:46:52.281Z and 2026-09-14T00:58:31.635Z, and an
      // old duplicate is never repaired by a later join — `admit` only ever
      // edited the FIRST match, so the stale copy stayed in every read view
      // (inflated memberCount, and "who is online" resolving to the old row).
      // Converging on load is what makes the invariant hold for state already on
      // disk, not just for joins that happen after the upgrade.
      const collapsed = this.collapseDuplicateMembers(room);
      if (collapsed > 0) {
        await this.persistence.saveRoom(room);
        console.log(`[agent-room] room ${room.roomId}: collapsed ${collapsed} duplicate member record(s)`);
      }
      this.owned.set(room.roomId, room);
      // Restore the message seq counter from persisted history so a restart
      // never reuses seq numbers — the member client dedups by seq, and reused
      // numbers would make it silently drop new messages.
      this.seqs.set(room.roomId, await this.persistence.loadMaxSeq(room.roomId));
      this.emit("system", room.roomId, {
        kind: "room-state",
        text: `房间已恢复开放（节点重启）`,
        ts: nowIso(),
        by: identity.agentId,
      });
      this.emit("roomState", room.roomId, room.status);
    }
  }

  /* ------------------------------ owned rooms -------------------------- */

  async createRoom(input: CreateRoomInput): Promise<Room> {
    const identity = await this.ensureIdentity();
    const address = this.onNeedServer ? await this.onNeedServer() : undefined;
    const now = nowIso();
    const room: Room = {
      roomId: uuidv7(),
      title: input.title,
      type: input.type,
      ownerAgentId: identity.agentId,
      controllerAgentId: identity.agentId,
      createdAt: now,
      settings: {
        authMode: input.settings?.authMode ?? "open",
        passwordHash: input.settings?.password ? hashPassword(input.settings.password) : input.settings?.passwordHash,
        autoMode: input.settings?.autoMode ?? false,
        maxMembers: input.settings?.maxMembers ?? 50,
        allowHumanTakeover: input.settings?.allowHumanTakeover ?? true,
      },
      members: [{ agentId: identity.agentId, nickname: identity.nickname, role: "owner", roles: ["controller"], joinedAt: now }],
      tasks: [],
      status: "open",
      serverAddress: address,
      revoked: [],
    };
    this.owned.set(room.roomId, room);
    this.seqs.set(room.roomId, 0);
    this.tokens.set(room.roomId, new Map([[identity.agentId, randomToken()]]));
    await this.recordJoined(room.roomId, address ?? "", room.title);
    if (room.type === "persistent") await this.persistence.saveRoom(room);
    this.emit("roomState", room.roomId, "open");
    return room;
  }

  async closeRoom(roomId: string): Promise<void> {
    const room = this.requireOwned(roomId);
    room.status = "closed";
    this.emit("system", roomId, { kind: "room-state", text: "房间已关闭", ts: nowIso() });
    this.emit("roomState", roomId, "closed");
    if (room.type === "persistent") await this.persistence.saveRoom(room);
    else await this.persistence.deleteRoom(roomId);
  }

  async destroyRoom(roomId: string): Promise<void> {
    const room = this.requireOwned(roomId);
    this.owned.delete(roomId);
    this.seqs.delete(roomId);
    this.tokens.delete(roomId);
    delete this.relaySecrets[roomId];
    void this.persistRelaySecrets();
    await this.persistence.deleteRoom(roomId);
    this.joined = this.joined.filter((r) => r.roomId !== roomId);
    await this.persistence.saveJoined(this.joined);
  }

  listOwnedRooms(): Room[] {
    return [...this.owned.values()];
  }

  listJoinedRooms(): JoinedRoomRecord[] {
    return Array.isArray(this.joined) ? [...this.joined] : [];
  }

  getOwnedRoom(roomId: string): Room | undefined {
    return this.owned.get(roomId);
  }

  private requireOwned(roomId: string): Room {
    const room = this.owned.get(roomId);
    if (!room) throw new RoomError("room-not-found", `房间不存在: ${roomId}`);
    return room;
  }

  /* ------------------------------ auth/join ---------------------------- */

  /**
   * Join an owned room. Returns the session token on success.
   * Password rooms require the correct password; open rooms admit directly.
   *
   * `options.address` is the TRANSPORT address the owner observed this member
   * arrive from (the socket's IP for a direct join, the relay URL over a relay).
   * It is stored as `lastSeenAddress` and updated on every re-join, which is the
   * D-21 "update in place, newest known address" half: a member whose machine
   * changed address twice must end up with ONE record carrying the newest one.
   * It is never a self-reported value, so it cannot be spoofed or left stale by
   * a client that merely claims a new address.
   */
  joinOwnedRoom(
    roomId: string,
    agent: AgentIdentity,
    options: { password?: string; address?: string },
  ): { token: string } {
    const room = this.requireOwned(roomId);
    if ((room.revoked ?? []).some((r) => r.agentId === agent.agentId))
      throw new RoomError("revoked", "该成员已被吊销入场资格");
    if (room.status !== "open") throw new RoomError("room-closed", "房间未开放");
    if (room.members.length >= room.settings.maxMembers)
      throw new RoomError("room-full", "房间人数已满");
    if (room.members.some((m) => m.agentId === agent.agentId)) {
      // Idempotent rejoin: the member already exists (e.g. their node restarted
      // and dropped the socket). Issue a fresh token instead of rejecting, so
      // the client can reconnect after any restart.
      return this.admit(room, agent, true, options.address);
    }

    if (room.settings.authMode === "password") {
      if (!room.settings.passwordHash || !options.password || !verifyPassword(options.password, room.settings.passwordHash)) {
        throw new RoomError("wrong-password", "密码错误");
      }
    }
    return this.admit(room, agent, false, options.address);
  }

  private admit(room: Room, agent: AgentIdentity, alreadyMember = false, address?: string): { token: string } {
    const now = nowIso();
    if (!alreadyMember) {
      room.members.push({
        agentId: agent.agentId,
        nickname: agent.nickname,
        role: "member",
        roles: ["observer"],
        joinedAt: now,
        lastSeenAt: now,
        lastSeenAddress: address,
        capabilities: agent.capabilities,
      });
    } else {
      const member = room.members.find((m) => m.agentId === agent.agentId);
      if (member) {
        member.nickname = agent.nickname;
        // D-20/D-21: a re-join is live contact, and it is the moment the newest
        // known address must replace the older one.
        member.lastSeenAt = now;
        if (address) member.lastSeenAddress = address;
        if (agent.capabilities?.length) member.capabilities = agent.capabilities;
      }
      // D-21: an old duplicate must not survive a re-join. `find()` above edits
      // only the FIRST match, so without this the stale copy kept being served.
      this.collapseDuplicateMembers(room, agent.agentId);
    }
    const token = randomToken();
    const roomTokens = this.tokens.get(room.roomId) ?? new Map();
    roomTokens.set(agent.agentId, token);
    this.tokens.set(room.roomId, roomTokens);
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("members", room.roomId, room.members);
    this.emit("system", room.roomId, { kind: "member-joined", text: `${agent.nickname} 加入了房间`, ts: now, by: agent.agentId });
    return { token };
  }

  /**
   * Enforce ONE member record per agentId (D-21) and return how many were removed.
   *
   * The invariant "one record per agentId" is what every reader already assumes:
   * `memberCount` counts records, `members.find(agentId)` returns the first match,
   * `@mention` resolution throws `ambiguous-member` on duplicates, and everything
   * that decides "is this colleague online" reads the list. Field state violated
   * it: one agentId held two records with different `joinedAt`
   * (2026-09-14T00:46:52.281Z / 00:58:31.635Z) after that machine's address
   * changed twice. Nothing repaired it, because a re-join only ever edited the
   * first match — the stale record (with the old address/contact time) stayed.
   *
   * The survivor is the record with the NEWEST `joinedAt` (the newest known
   * membership row, per the defect's fix note). Nothing learned about the member
   * is lost: role keeps the strongest value, and roles / capabilities /
   * manualCapabilities / liveness fields are merged, newest wins per field. When
   * `agentId` is given, only that member is collapsed (the join path); with no
   * agentId every member of the room is checked (the boot-repair path).
   */
  private collapseDuplicateMembers(room: Room, agentId?: string): number {
    if (!Array.isArray(room.members) || room.members.length === 0) return 0;
    const byAgent = new Map<string, Member[]>();
    for (const member of room.members) {
      const key = member?.agentId;
      if (!key) continue;
      if (agentId !== undefined && key !== agentId) continue;
      const list = byAgent.get(key);
      if (list) list.push(member);
      else byAgent.set(key, [member]);
    }
    const dropped = new Set<Member>();
    for (const list of byAgent.values()) {
      if (list.length <= 1) continue;
      // Newest joinedAt wins; the last one in list order breaks a tie, so the
      // record a reader would have picked is not the one discarded.
      let keep = list[0]!;
      for (const candidate of list.slice(1)) {
        if (memberStamp(candidate) >= memberStamp(keep)) keep = candidate;
      }
      for (const other of list) {
        if (other === keep) continue;
        mergeMember(keep, other);
        dropped.add(other);
      }
    }
    if (dropped.size === 0) return 0;
    room.members = room.members.filter((member) => !dropped.has(member));
    return dropped.size;
  }

  /**
   * Record live contact from a member (D-20).
   *
   * This is the room-side liveness signal, and it is deliberately NOT `joinedAt`
   * (an admission timestamp) and NOT the org tree's `updatedAt` (an edit stamp,
   * measured frozen at 2026-09-12T14:26 on a machine that was alive):
   * `lastSeenAt` moves on every frame the owner receives from that member, so a
   * reader can tell "off duty" (a long-stale stamp) from "wedged" (a fresh stamp
   * with no answer) instead of spending three exec timeouts and then asking a
   * human. `patch.execOk` additionally stamps `lastExecAt`/`lastExecOk` when the
   * member reports an exec result, which is the difference between "the plugin is
   * reachable" and "the plugin can actually run commands".
   *
   * Writes are throttled by MEMBER_TOUCH_PERSIST_MS so a chatty member cannot turn
   * every frame into a room-file write; a crash therefore loses at most that much
   * liveness resolution, never correctness (the fields are diagnostics).
   */
  touchMember(roomId: string, agentId: string, patch?: { execOk?: boolean; address?: string }): Member | undefined {
    const room = this.owned.get(roomId);
    if (!room) return undefined;
    // A duplicate row must never be refreshed instead of the canonical one.
    this.collapseDuplicateMembers(room, agentId);
    const member = room.members.find((m) => m.agentId === agentId);
    if (!member) return undefined;
    const now = nowIso();
    // Decided BEFORE the update: this is both the disk-write throttle and the
    // browser-push throttle (a members event per inbound frame would be noise).
    const moved = member.lastSeenAt === undefined
      || Date.parse(now) - Date.parse(member.lastSeenAt) >= MEMBER_TOUCH_PERSIST_MS;
    if (patch?.address) member.lastSeenAddress = patch.address;
    if (patch?.execOk !== undefined) {
      member.lastExecAt = now;
      member.lastExecOk = patch.execOk;
    }
    member.lastSeenAt = now;
    if (room.type === "persistent" && (moved || patch?.execOk !== undefined)) void this.persistence.saveRoom(room);
    // /state reads the live object, so only the PUSH is throttled: the value is
    // always fresh for a reader, and a member cannot turn chat into a fan-out.
    if (moved || patch?.execOk !== undefined) this.emit("members", roomId, room.members);
    return member;
  }

  /** Validate a ws session token for a member of an owned room. */
  validateToken(roomId: string, agentId: string, token: string): boolean {
    const roomTokens = this.tokens.get(roomId);
    return roomTokens?.get(agentId) === token;
  }

  /* ------------------------- relay auth ------------------------------ */
  /** Return the room's relay auth secret, generating and (for persistent
   *  rooms) persisting it on first use. */
  relaySecretFor(roomId: string): string {
    const existing = this.relaySecrets[roomId];
    if (existing) return existing;
    const secret = randomToken();
    this.relaySecrets[roomId] = secret;
    if (this.owned.get(roomId)?.type === "persistent") void this.persistRelaySecrets();
    return secret;
  }

  async persistRelaySecrets(): Promise<void> {
    await this.persistence.saveRelaySecrets(this.relaySecrets);
  }

  /** Issue a short-lived HMAC ticket a member presents to the relay. */
  issueRelayTicket(roomId: string, agentId: string): string {
    return signRelayTicket(this.relaySecretFor(roomId), {
      roomId,
      agentId,
      role: "member",
      exp: Math.floor(Date.now() / 1000) + RELAY_TICKET_TTL_S,
    });
  }

  async removeMember(roomId: string, agentId: string): Promise<void> {
    const room = this.requireOwned(roomId);
    const member = room.members.find((m) => m.agentId === agentId);
    if (!member) return;
    room.members = room.members.filter((m) => m.agentId !== agentId);
    this.tokens.get(roomId)?.delete(agentId);
    if (room.type === "persistent") await this.persistence.saveRoom(room);
    this.emit("members", roomId, room.members);
    this.emit("system", roomId, { kind: "member-left", text: `${member.nickname} 离开了房间`, ts: nowIso(), by: agentId });
  }

  /**
   * Resolve a member reference (agentId or nickname, case-insensitive nickname)
   * to a canonical member. Throws unknown-member when absent, ambiguous-member
   * when the nickname matches more than one member.
   */
  private resolveMember(room: Room, ref: string): Member {
    const normalized = ref.toLowerCase();
    const matches = room.members.filter((m) => m.agentId === ref || m.nickname.toLowerCase() === normalized);
    if (matches.length === 0) throw new RoomError("unknown-member", `成员不存在: ${ref}`);
    if (matches.length > 1) throw new RoomError("ambiguous-member", `昵称存在同名成员: ${ref}`);
    return matches[0]!;
  }

  /** Resolve an assignee reference, preserving the existing not-member error semantics. */
  private resolveAssignee(room: Room, ref: string): string {
    try {
      return this.resolveMember(room, ref).agentId;
    } catch (err) {
      if (err instanceof RoomError && (err.code === "unknown-member" || err.code === "ambiguous-member")) {
        throw new RoomError("not-member", `被指派者不在房间内: ${ref}`);
      }
      throw err;
    }
  }

  /**
   * Revoke a member's admission rights (owner or controller only). Removes the
   * member and their token, records an idempotent revocation entry, persists,
   * and emits members/system/revoked events.
   */
  async revokeMember(roomId: string, by: AgentIdentity, agentId: string, reason?: string): Promise<RevokedMember> {
    const room = this.requireOwned(roomId);
    if (room.ownerAgentId !== by.agentId && room.controllerAgentId !== by.agentId)
      throw new RoomError("forbidden", "只有房主或判定人可以吊销成员");
    if (agentId === room.ownerAgentId)
      throw new RoomError("forbidden", "不能吊销房主");

    const member = room.members.find((m) => m.agentId === agentId);
    const revoked = room.revoked ?? [];
    const existing = revoked.find((r) => r.agentId === agentId);
    const record: RevokedMember = {
      agentId,
      nickname: member?.nickname ?? existing?.nickname,
      revokedAt: nowIso(),
      by: by.agentId,
      reason: reason !== undefined ? reason : existing?.reason,
    };
    room.revoked = [...revoked.filter((r) => r.agentId !== agentId), record];

    if (member) {
      room.members = room.members.filter((m) => m.agentId !== agentId);
      this.tokens.get(roomId)?.delete(agentId);
    }

    if (room.type === "persistent") await this.persistence.saveRoom(room);
    this.emit("members", roomId, room.members);
    this.emit("system", roomId, {
      kind: "member-revoked",
      text: `${member?.nickname ?? agentId} 已被吊销入场资格`,
      ts: record.revokedAt,
      by: by.agentId,
    });
    this.emit("revoked", roomId, agentId);
    return record;
  }

  /** Restore a revoked member's admission rights (owner or controller only). */
  async unrevokeMember(roomId: string, by: AgentIdentity, agentId: string): Promise<void> {
    const room = this.requireOwned(roomId);
    if (room.ownerAgentId !== by.agentId && room.controllerAgentId !== by.agentId)
      throw new RoomError("forbidden", "只有房主或判定人可以解除吊销");
    const revoked = room.revoked ?? [];
    if (!revoked.some((r) => r.agentId === agentId)) return;
    room.revoked = revoked.filter((r) => r.agentId !== agentId);
    if (room.type === "persistent") await this.persistence.saveRoom(room);
    this.emit("system", roomId, { kind: "member-unrevoked", text: `${agentId} 已恢复入场资格`, ts: nowIso(), by: by.agentId });
  }

  /* ------------------------------ settings ----------------------------- */

  async updateSettings(roomId: string, patch: Partial<RoomSettings> & { password?: string }): Promise<Room> {
    const room = this.requireOwned(roomId);
    const s = room.settings;
    if (patch.authMode !== undefined) s.authMode = patch.authMode;
    if (patch.password !== undefined && patch.password.length > 0) s.passwordHash = hashPassword(patch.password);
    if (patch.autoMode !== undefined) s.autoMode = patch.autoMode;
    if (patch.maxMembers !== undefined) s.maxMembers = patch.maxMembers;
    if (patch.allowHumanTakeover !== undefined) s.allowHumanTakeover = patch.allowHumanTakeover;
    if (room.type === "persistent") await this.persistence.saveRoom(room);
    this.emit("system", roomId, { kind: "settings", text: "房间设置已更新", ts: nowIso() });
    return room;
  }

  async transferController(roomId: string, toAgentId: string): Promise<Room> {
    const room = this.requireOwned(roomId);
    if (!room.members.some((m) => m.agentId === toAgentId))
      throw new RoomError("not-member", "目标不在房间内");
    room.controllerAgentId = toAgentId;
    if (room.type === "persistent") await this.persistence.saveRoom(room);
    this.emit("system", roomId, { kind: "settings", text: `判定权已转移`, ts: nowIso(), by: toAgentId });
    return room;
  }

  /* ------------------------------ chat --------------------------------- */

  async addChatMessage(roomId: string, from: AgentIdentity, input: { text: string; replyTo?: number; mentions?: string[]; human?: boolean }): Promise<ChatMessage> {
    const room = this.requireOwned(roomId);
    if (input.text.length === 0) throw new RoomError("empty-message", "消息不能为空");
    if (input.text.length > 16 * 1024) throw new RoomError("message-too-long", "消息过长");
    // Resolve mentions to canonical agentIds (agentId or nickname accepted).
    let mentions: string[] | undefined;
    if (input.mentions && input.mentions.length > 0) {
      const resolved: string[] = [];
      for (const ref of input.mentions) {
        try {
          resolved.push(this.resolveMember(room, ref).agentId);
        } catch (err) {
          if (err instanceof RoomError && err.code === "unknown-member") {
            throw new RoomError("unknown-mention", `无法识别的成员: ${ref}`);
          }
          throw err;
        }
      }
      mentions = [...new Set(resolved)];
    }
    const seq = (this.seqs.get(roomId) ?? 0) + 1;
    this.seqs.set(roomId, seq);
    const message: ChatMessage = {
      seq,
      from: from.agentId,
      fromNickname: from.nickname,
      ts: nowIso(),
      text: input.text,
      replyTo: input.replyTo,
      mentions,
      human: input.human,
    };
    if (room.type === "persistent") await this.persistence.appendMessage(roomId, message);
    this.trackMessage(roomId, message);
    this.emit("chat", roomId, message);
    return message;
  }

  async recentMessages(roomId: string, limit = 200, before?: number): Promise<ChatMessage[]> {
    const room = this.requireOwned(roomId);
    if (room.type === "temporary") {
      const list = this.memoryMessages.get(roomId) ?? [];
      const filtered = before === undefined ? list : list.filter((m) => m.seq < before);
      return filtered.slice(-limit);
    }
    return this.persistence.loadRecentMessages(roomId, limit, before);
  }

  /**
   * Highest seq this node has assigned for an owned room, control frames
   * included (0.1.35).
   *
   * Authoritative and O(1): the counter is restored from persisted history on
   * boot and bumped by addChatMessage, so the owner can answer "what is your
   * latest seq" without touching the message file. This is the number a member
   * uses to notice it is behind (see src/host/backfill.ts).
   */
  latestSeq(roomId: string): number {
    return this.seqs.get(roomId) ?? 0;
  }

  /**
   * Confirmed messages in `[fromSeq, toSeq]`, oldest first, capped at `limit`
   * (0.1.35). Used only to answer a member's bounded sync request; callers pass
   * a small span and count.
   */
  async messagesInRange(roomId: string, fromSeq: number, toSeq: number, limit = 200): Promise<ChatMessage[]> {
    const room = this.requireOwned(roomId);
    const from = Math.max(1, Math.floor(fromSeq));
    const to = Math.max(from, Math.floor(toSeq));
    if (room.type === "temporary") {
      return (this.memoryMessages.get(roomId) ?? [])
        .filter((m) => m.seq >= from && m.seq <= to)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, Math.max(1, Math.floor(limit)));
    }
    return this.persistence.loadMessagesInRange(roomId, from, to, Math.max(1, Math.floor(limit)));
  }

  private readonly memoryMessages = new Map<string, ChatMessage[]>();
  /** Attach a chat message to the in-memory stream (used by PeerServer for temporary rooms). */
  trackMessage(roomId: string, message: ChatMessage): void {
    const list = this.memoryMessages.get(roomId) ?? [];
    list.push(message);
    if (list.length > 500) list.splice(0, list.length - 500);
    this.memoryMessages.set(roomId, list);
  }

  /* ------------------------------ tasks -------------------------------- */

  private requireTask(room: Room, taskId: string): Task {
    const task = room.tasks.find((t) => t.taskId === taskId);
    if (!task) throw new RoomError("task-not-found", "任务不存在");
    return task;
  }

  private requireMember(room: Room, agentId: string): void {
    if (!room.members.some((m) => m.agentId === agentId))
      throw new RoomError("not-member", "不是房间成员");
  }

  private judgeOf(room: Room, task: Task): string {
    return task.judge.mode === "auto" ? task.assignee ?? task.createdBy : room.controllerAgentId;
  }

  createTask(
    roomId: string,
    by: AgentIdentity,
    input: {
      title: string;
      description?: string;
      assignee?: string;
      claimable?: boolean;
      requiredCapabilities?: string[];
      requiredRoles?: RoleKey[];
      acceptance?: string;
      judgeMode?: "controller" | "auto";
    },
  ): Task {
    const room = this.requireOwned(roomId);
    this.requireMember(room, by.agentId);
    const now = nowIso();
    const assignee = input.assignee ? this.resolveAssignee(room, input.assignee) : undefined;
    const task: Task = {
      taskId: uuidv7(),
      title: input.title,
      description: input.description ?? "",
      status: "todo",
      assignee,
      claimable: input.claimable ?? false,
      requiredCapabilities: input.requiredCapabilities ?? [],
      requiredRoles: input.requiredRoles,
      acceptance: input.acceptance,
      createdBy: by.agentId,
      createdAt: now,
      updatedAt: now,
      comments: [],
      judge: {
        mode: input.judgeMode ?? (room.settings.autoMode ? "auto" : "controller"),
      },
    };
    room.tasks.push(task);
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("task", roomId, task);
    return task;
  }

  assignTask(roomId: string, by: AgentIdentity, taskId: string, assignee: string): Task {
    const room = this.requireOwned(roomId);
    this.requireMember(room, by.agentId);
    const assigneeId = this.resolveAssignee(room, assignee);
    const task = this.requireTask(room, taskId);
    const creator = task.createdBy === by.agentId;
    const judge = this.judgeOf(room, task) === by.agentId;
    const current = task.assignee === by.agentId;
    if (!creator && !judge && !current && room.controllerAgentId !== by.agentId)
      throw new RoomError("forbidden", "无权指派该任务");
    task.assignee = assigneeId;
    task.claimable = false;
    if (task.status === "todo") task.status = "doing";
    task.updatedAt = nowIso();
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("task", roomId, task);
    return task;
  }

  claimTask(roomId: string, by: AgentIdentity, taskId: string): Task {
    const room = this.requireOwned(roomId);
    this.requireMember(room, by.agentId);
    const task = this.requireTask(room, taskId);
    if (!task.claimable) throw new RoomError("not-claimable", "该任务不可认领");
    if (task.assignee && task.assignee !== by.agentId) throw new RoomError("claimed", "任务已被认领");
    task.assignee = by.agentId;
    task.claimable = false;
    task.status = "doing";
    task.updatedAt = nowIso();
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("task", roomId, task);
    return task;
  }

  commentTask(roomId: string, by: AgentIdentity, taskId: string, text: string): Task {
    const room = this.requireOwned(roomId);
    this.requireMember(room, by.agentId);
    const task = this.requireTask(room, taskId);
    task.comments.push({ agentId: by.agentId, ts: nowIso(), text });
    task.updatedAt = nowIso();
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("task", roomId, task);
    return task;
  }

  setTaskStatus(roomId: string, by: AgentIdentity, taskId: string, status: "todo" | "doing"): Task {
    const room = this.requireOwned(roomId);
    this.requireMember(room, by.agentId);
    const task = this.requireTask(room, taskId);
    const involved = task.assignee === by.agentId || task.createdBy === by.agentId || room.controllerAgentId === by.agentId;
    if (!involved) throw new RoomError("forbidden", "无权变更该任务状态");
    task.status = status;
    task.updatedAt = nowIso();
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("task", roomId, task);
    return task;
  }

  completeTask(roomId: string, by: AgentIdentity, taskId: string, note?: string): Task {
    const room = this.requireOwned(roomId);
    this.requireMember(room, by.agentId);
    const task = this.requireTask(room, taskId);
    const executor = task.assignee ?? task.createdBy;
    if (executor !== by.agentId) throw new RoomError("forbidden", "只有执行者可以提交完成");
    if (task.status !== "doing" && task.status !== "todo") throw new RoomError("bad-state", `当前状态 ${task.status} 不能提交完成`);

    if (task.judge.mode === "auto") {
      // Autonomous: executor confirms directly (self-judging allowed by design).
      task.status = "done";
      task.judge = { mode: "auto", decidedBy: by.agentId, decidedAt: nowIso(), note };
    } else {
      // Controller mode: no self-review.
      if (room.controllerAgentId === by.agentId && executor === by.agentId)
        throw new RoomError("self-review", "执行者与判定人相同，禁止自审：请转移判定权或切换自治模式");
      task.status = "review";
      task.judge = { mode: "controller", note };
    }
    task.updatedAt = nowIso();
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("task", roomId, task);
    this.emit("system", roomId, { kind: "judge", text: `${by.nickname} 提交了任务「${task.title}」的完成`, ts: nowIso(), by: by.agentId });
    return task;
  }

  approveTask(roomId: string, by: AgentIdentity, taskId: string, note?: string): Task {
    const room = this.requireOwned(roomId);
    this.requireMember(room, by.agentId);
    const task = this.requireTask(room, taskId);
    if (task.status !== "review") throw new RoomError("bad-state", "只有 review 状态的任务可被判定");
    if (this.judgeOf(room, task) !== by.agentId)
      throw new RoomError("forbidden", "只有判定人可以批准");
    task.status = "done";
    task.judge = { mode: task.judge.mode, decidedBy: by.agentId, decidedAt: nowIso(), note };
    task.updatedAt = nowIso();
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("task", roomId, task);
    return task;
  }

  rejectTask(roomId: string, by: AgentIdentity, taskId: string, note?: string): Task {
    const room = this.requireOwned(roomId);
    this.requireMember(room, by.agentId);
    const task = this.requireTask(room, taskId);
    if (task.status !== "review") throw new RoomError("bad-state", "只有 review 状态的任务可被判定");
    if (this.judgeOf(room, task) !== by.agentId)
      throw new RoomError("forbidden", "只有判定人可以驳回");
    task.status = "rejected";
    task.judge = { mode: task.judge.mode, decidedBy: by.agentId, decidedAt: nowIso(), note };
    task.updatedAt = nowIso();
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("task", roomId, task);
    return task;
  }

  reopenTask(roomId: string, by: AgentIdentity, taskId: string): Task {
    const room = this.requireOwned(roomId);
    this.requireMember(room, by.agentId);
    const task = this.requireTask(room, taskId);
    const allowed = task.createdBy === by.agentId || task.assignee === by.agentId || room.controllerAgentId === by.agentId;
    if (!allowed) throw new RoomError("forbidden", "无权重新打开该任务");
    if (task.status !== "done" && task.status !== "rejected") throw new RoomError("bad-state", "只有 done/rejected 的任务可重开");
    task.status = "todo";
    task.updatedAt = nowIso();
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("task", roomId, task);
    return task;
  }

  listTasks(roomId: string): Task[] {
    return this.requireOwned(roomId).tasks;
  }

  /** Delete a task (creator/assignee may remove only todo tasks; controller may remove any). */
  deleteTask(roomId: string, by: AgentIdentity, taskId: string): void {
    const room = this.requireOwned(roomId);
    this.requireMember(room, by.agentId);
    const task = this.requireTask(room, taskId);
    const isController = room.controllerAgentId === by.agentId || room.ownerAgentId === by.agentId;
    const isCreatorOrAssignee = task.createdBy === by.agentId || task.assignee === by.agentId;
    if (!isController && !isCreatorOrAssignee) throw new RoomError("forbidden", "无权删除该任务");
    if (task.status !== "todo" && !isController) throw new RoomError("forbidden", "非待办状态的任务只有判定人可删除");
    room.tasks = room.tasks.filter((t) => t.taskId !== taskId);
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("taskRemoved", roomId, taskId);
  }

  /** Candidate agents for a task: role match first, then capability overlap. */
  suggestCandidates(
    roomId: string,
    requiredCapabilities: string[],
    requiredRoles: RoleKey[] = [],
  ): Array<{ agentId: string; nickname: string; score: number; roleMatch: number }> {
    const room = this.requireOwned(roomId);
    const needCaps = new Set(requiredCapabilities);
    const needRoles = new Set(requiredRoles);
    const zeroWeight = ZERO_WEIGHT_CAPABILITIES as ReadonlySet<string>;
    const ranked = room.members.map((m) => {
      const have = new Set([...(m.capabilities ?? []), ...(m.manualCapabilities ?? [])]);
      let score = 0;
      for (const cap of needCaps) if (have.has(cap) && !zeroWeight.has(cap)) score += 1;
      let roleMatch = 0;
      for (const role of needRoles) if ((m.roles ?? []).includes(role)) roleMatch += 1;
      return { agentId: m.agentId, nickname: m.nickname, score, roleMatch };
    });
    ranked.sort((a, b) => (b.roleMatch - a.roleMatch) || (b.score - a.score));
    return ranked;
  }

  /** Attach a structured handoff card to a task (executor or controller). */
  setTaskHandoff(roomId: string, by: AgentIdentity, taskId: string, handoff: TaskHandoff): Task {
    const room = this.requireOwned(roomId);
    this.requireMember(room, by.agentId);
    const task = this.requireTask(room, taskId);
    const allowed = task.assignee === by.agentId || task.createdBy === by.agentId || room.controllerAgentId === by.agentId;
    if (!allowed) throw new RoomError("forbidden", "无权更新交接卡");
    task.handoff = handoff;
    task.updatedAt = nowIso();
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("task", roomId, task);
    return task;
  }

  /** A member declares their own workflow roles (self-report). */
  setMemberRoles(roomId: string, by: AgentIdentity, roles: RoleKey[]): void {
    const room = this.requireOwned(roomId);
    const member = room.members.find((m) => m.agentId === by.agentId);
    if (!member) throw new RoomError("not-member", "不在房间内");
    member.roles = roles;
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("members", roomId, room.members);
  }

  /** Refresh a member's live profile (nickname/capabilities/roles) pushed by that member. */
  updateMemberProfile(roomId: string, agentId: string, patch: { nickname?: string; capabilities?: string[]; manualCapabilities?: string[]; roles?: RoleKey[] }): void {
    const room = this.requireOwned(roomId);
    const member = room.members.find((m) => m.agentId === agentId);
    if (!member) return;
    if (typeof patch.nickname === "string" && patch.nickname) member.nickname = patch.nickname;
    if (patch.capabilities) member.capabilities = patch.capabilities;
    if (patch.manualCapabilities) member.manualCapabilities = patch.manualCapabilities;
    if (patch.roles) member.roles = patch.roles;
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("members", roomId, room.members);
  }

  /** Owner (or controller) assigns workflow roles to a member. */
  assignMemberRoles(roomId: string, by: AgentIdentity, targetAgentId: string, roles: RoleKey[]): void {
    const room = this.requireOwned(roomId);
    if (room.controllerAgentId !== by.agentId && room.ownerAgentId !== by.agentId)
      throw new RoomError("forbidden", "只有房主或判定人可以安排岗位");
    const member = room.members.find((m) => m.agentId === targetAgentId);
    if (!member) throw new RoomError("not-member", "成员不在房间内");
    member.roles = roles;
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("members", roomId, room.members);
  }

  /** Set the member's manual capability tags (kept separate from auto-collected). */
  setMemberCapabilities(roomId: string, by: AgentIdentity, capabilities: string[]): void {
    const room = this.requireOwned(roomId);
    const member = room.members.find((m) => m.agentId === by.agentId);
    if (!member) throw new RoomError("not-member", "不在房间内");
    member.manualCapabilities = capabilities;
    if (room.type === "persistent") void this.persistence.saveRoom(room);
    this.emit("members", roomId, room.members);
  }

  /* ------------------------------ misc --------------------------------- */

  private async recordJoined(roomId: string, address: string, title?: string): Promise<void> {
    this.joined = this.joined.filter((r) => r.roomId !== roomId);
    this.joined.unshift({ roomId, address, title, lastVisitedAt: nowIso() });
    this.joined = this.joined.slice(0, 50);
    await this.persistence.saveJoined(this.joined);
  }

  async recordVisited(roomId: string, address: string, title?: string): Promise<void> {
    await this.recordJoined(roomId, address, title);
  }

  /**
   * Remove ONE joined-room record (0.1.34). Returns whether a record was there.
   *
   * Used when a room is proven gone (join rejected: room-not-found/closed), when
   * `leave` cannot reach the owner, and when a record turns out to point at this
   * node's own room. All three are local cleanup, and local cleanup must never
   * depend on the remote room answering.
   */
  async removeJoinedRoom(roomId: string): Promise<boolean> {
    const before = this.joined.length;
    if (before === 0) return false;
    this.joined = this.joined.filter((record) => record.roomId !== roomId);
    if (this.joined.length === before) return false;
    await this.persistence.saveJoined(this.joined);
    return true;
  }

  /**
   * Replace the joined-room list wholesale (used by boot-time pruning of records
   * that can no longer be reached). Returns the number actually removed.
   */
  async replaceJoinedRooms(records: JoinedRoomRecord[]): Promise<number> {
    const removed = this.joined.length - records.length;
    this.joined = records.slice(0, 50);
    await this.persistence.saveJoined(this.joined);
    return removed;
  }
}

function defaultNickname(): string {
  try {
    return process.env.COMPUTERNAME || process.env.HOSTNAME || "agent";
  } catch {
    return "agent";
  }
}

/** Sort key for "which member record is the newest one we know about" (D-21). */
function memberStamp(member: Member): number {
  const joined = Date.parse(member?.joinedAt ?? "");
  return Number.isFinite(joined) ? joined : 0;
}

/**
 * Fold one duplicate member record into the survivor without losing anything
 * (D-21). Only fields that carry information are touched; the survivor's own
 * values win, and the duplicate only fills gaps or unions sets.
 */
function mergeMember(keep: Member, other: Member): void {
  if (!keep.nickname && other.nickname) keep.nickname = other.nickname;
  if (other.role === "owner") keep.role = "owner";
  const roles = new Set([...(keep.roles ?? []), ...(other.roles ?? [])]);
  if (roles.size > 0) keep.roles = [...roles] as Member["roles"];
  const capabilities = new Set([...(keep.capabilities ?? []), ...(other.capabilities ?? [])]);
  if (capabilities.size > 0) keep.capabilities = [...capabilities];
  const manual = new Set([...(keep.manualCapabilities ?? []), ...(other.manualCapabilities ?? [])]);
  if (manual.size > 0) keep.manualCapabilities = [...manual];
  // Liveness: the newest observation wins, so a duplicate can never drag the
  // surviving record back to a stale address or an old contact time.
  if (stampOf(other.lastSeenAt) > stampOf(keep.lastSeenAt)) {
    keep.lastSeenAt = other.lastSeenAt;
    if (other.lastSeenAddress) keep.lastSeenAddress = other.lastSeenAddress;
  } else if (!keep.lastSeenAddress && other.lastSeenAddress) {
    keep.lastSeenAddress = other.lastSeenAddress;
  }
  if (stampOf(other.lastExecAt) > stampOf(keep.lastExecAt)) {
    keep.lastExecAt = other.lastExecAt;
    keep.lastExecOk = other.lastExecOk;
  }
}

function stampOf(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}
