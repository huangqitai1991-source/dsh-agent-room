/**
 * dsh-agent-room — RoomService.
 *
 * Authoritative owner-side logic: identity, room lifecycle, join authorization,
 * chat stream, task board, and the judging model (controller / auto).
 * The host wires this into DSH; the PeerServer broadcasts its events to member
 * sockets; tools call into it directly.
 */
import { EventEmitter } from "node:events";
import { Persistence } from "./persistence.js";
import { nicknameProblem } from "./safety.js";
import { hashPassword, nowIso, randomToken, signRelayTicket, uuidv7, verifyPassword } from "./util.js";
import { ZERO_WEIGHT_CAPABILITIES } from "./catalog.js";
/** Relay ticket lifetime in seconds. */
const RELAY_TICKET_TTL_S = 24 * 60 * 60;
/** Error carrying a stable code for tool/HTTP layers to map. */
export class RoomError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export class RoomService extends EventEmitter {
    persistence;
    onNeedServer;
    identity = null;
    /** Rooms owned by this node (authoritative), keyed by roomId. */
    owned = new Map();
    /** Session tokens for owned rooms: roomId -> agentId -> token. */
    tokens = new Map();
    /** Per-room message sequence counters. */
    seqs = new Map();
    /** Recent rooms this node joined or created. */
    joined = [];
    /** Relay auth secrets (roomId -> 256-bit hex), kept OUT of the room object
     *  so snapshots never leak them to members. */
    relaySecrets = {};
    constructor(options) {
        super();
        this.persistence = new Persistence(options.dataDir);
        this.onNeedServer = options.onNeedServer;
    }
    on(event, listener) {
        return super.on(event, listener);
    }
    emit(event, ...args) {
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
    async ensureIdentity() {
        if (this.identity)
            return this.identity;
        const existing = await this.persistence.loadIdentity();
        if (existing) {
            this.identity = existing;
            return existing;
        }
        const fresh = {
            agentId: uuidv7(),
            nickname: defaultNickname(),
            capabilities: [],
            createdAt: nowIso(),
        };
        await this.persistence.saveIdentity(fresh);
        this.identity = fresh;
        return fresh;
    }
    getIdentity() {
        return this.identity;
    }
    async updateProfile(patch) {
        const id = await this.ensureIdentity();
        // G1 (0.1.38): validate a nickname where it is deliberately SET, not on every
        // save. Validating inside saveIdentity would let a pre-existing bad name —
        // the literal "NAME" that an unfilled template wrote on two machines — turn a
        // routine capability merge at boot into a startup outage.
        if (patch.nickname !== undefined) {
            const problem = nicknameProblem(patch.nickname);
            if (problem)
                throw new Error(`拒绝写入该昵称：${problem}`);
            id.nickname = patch.nickname;
        }
        if (patch.bio !== undefined)
            id.bio = patch.bio;
        if (patch.capabilities !== undefined)
            id.capabilities = [...new Set(patch.capabilities)];
        await this.persistence.saveIdentity(id);
        return id;
    }
    /** Merge auto-collected capability names (skills/tools) into identity. */
    async mergeCapabilities(names) {
        const id = await this.ensureIdentity();
        let changed = false;
        for (const name of names) {
            if (name && !id.capabilities.includes(name)) {
                id.capabilities.push(name);
                changed = true;
            }
        }
        if (changed)
            await this.persistence.saveIdentity(id);
        return id;
    }
    /* ------------------------------ boot/restore ------------------------- */
    async boot() {
        const identity = await this.ensureIdentity();
        this.joined = await this.persistence.loadJoined();
        this.relaySecrets = await this.persistence.loadRelaySecrets();
        const rooms = await this.persistence.loadPersistentRooms();
        for (const room of rooms) {
            if (room.ownerAgentId !== identity.agentId)
                continue;
            if (room.status === "suspended")
                room.status = "open";
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
    async createRoom(input) {
        const identity = await this.ensureIdentity();
        const address = this.onNeedServer ? await this.onNeedServer() : undefined;
        const now = nowIso();
        const room = {
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
        if (room.type === "persistent")
            await this.persistence.saveRoom(room);
        this.emit("roomState", room.roomId, "open");
        return room;
    }
    async closeRoom(roomId) {
        const room = this.requireOwned(roomId);
        room.status = "closed";
        this.emit("system", roomId, { kind: "room-state", text: "房间已关闭", ts: nowIso() });
        this.emit("roomState", roomId, "closed");
        if (room.type === "persistent")
            await this.persistence.saveRoom(room);
        else
            await this.persistence.deleteRoom(roomId);
    }
    async destroyRoom(roomId) {
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
    listOwnedRooms() {
        return [...this.owned.values()];
    }
    listJoinedRooms() {
        return Array.isArray(this.joined) ? [...this.joined] : [];
    }
    getOwnedRoom(roomId) {
        return this.owned.get(roomId);
    }
    /**
     * The persisted "this node listens to that room" intent (0.1.42).
     *
     * Recorded room ids are intersected with the rooms this node actually belongs
     * to (joined records on disk + owned rooms): a listening flag for a room this
     * node is no longer in is dead weight, and restoring it would make
     * `GET /state` claim a wake plane that cannot run — a diagnostic that lies is
     * worse than no diagnostic, the same rule the `bridge` field follows. The
     * filter leaves the file itself untouched, so nothing rewrites the intent
     * during boot.
     */
    async loadListeningIntent() {
        const recorded = await this.persistence.loadListening();
        if (recorded.length === 0)
            return [];
        const known = new Set([...this.joined.map((record) => record.roomId), ...this.owned.keys()]);
        return recorded.filter((roomId) => known.has(roomId));
    }
    requireOwned(roomId) {
        const room = this.owned.get(roomId);
        if (!room)
            throw new RoomError("room-not-found", `房间不存在: ${roomId}`);
        return room;
    }
    /* ------------------------------ auth/join ---------------------------- */
    /**
     * Join an owned room. Returns the session token on success.
     * Password rooms require the correct password; open rooms admit directly.
     */
    joinOwnedRoom(roomId, agent, options) {
        const room = this.requireOwned(roomId);
        if ((room.revoked ?? []).some((r) => r.agentId === agent.agentId))
            throw new RoomError("revoked", "该成员已被吊销入场资格");
        if (room.status !== "open")
            throw new RoomError("room-closed", "房间未开放");
        if (room.members.length >= room.settings.maxMembers)
            throw new RoomError("room-full", "房间人数已满");
        if (room.members.some((m) => m.agentId === agent.agentId)) {
            // Idempotent rejoin: the member already exists (e.g. their node restarted
            // and dropped the socket). Issue a fresh token instead of rejecting, so
            // the client can reconnect after any restart.
            return this.admit(room, agent, true);
        }
        if (room.settings.authMode === "password") {
            if (!room.settings.passwordHash || !options.password || !verifyPassword(options.password, room.settings.passwordHash)) {
                throw new RoomError("wrong-password", "密码错误");
            }
        }
        return this.admit(room, agent);
    }
    admit(room, agent, alreadyMember = false) {
        const now = nowIso();
        if (!alreadyMember) {
            room.members.push({
                agentId: agent.agentId,
                nickname: agent.nickname,
                role: "member",
                roles: ["observer"],
                joinedAt: now,
                capabilities: agent.capabilities,
            });
        }
        else {
            const member = room.members.find((m) => m.agentId === agent.agentId);
            if (member)
                member.nickname = agent.nickname;
        }
        const token = randomToken();
        const roomTokens = this.tokens.get(room.roomId) ?? new Map();
        roomTokens.set(agent.agentId, token);
        this.tokens.set(room.roomId, roomTokens);
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("members", room.roomId, room.members);
        this.emit("system", room.roomId, { kind: "member-joined", text: `${agent.nickname} 加入了房间`, ts: now, by: agent.agentId });
        return { token };
    }
    /** Validate a ws session token for a member of an owned room. */
    validateToken(roomId, agentId, token) {
        const roomTokens = this.tokens.get(roomId);
        return roomTokens?.get(agentId) === token;
    }
    /* ------------------------- relay auth ------------------------------ */
    /** Return the room's relay auth secret, generating and (for persistent
     *  rooms) persisting it on first use. */
    relaySecretFor(roomId) {
        const existing = this.relaySecrets[roomId];
        if (existing)
            return existing;
        const secret = randomToken();
        this.relaySecrets[roomId] = secret;
        if (this.owned.get(roomId)?.type === "persistent")
            void this.persistRelaySecrets();
        return secret;
    }
    async persistRelaySecrets() {
        await this.persistence.saveRelaySecrets(this.relaySecrets);
    }
    /** Issue a short-lived HMAC ticket a member presents to the relay. */
    issueRelayTicket(roomId, agentId) {
        return signRelayTicket(this.relaySecretFor(roomId), {
            roomId,
            agentId,
            role: "member",
            exp: Math.floor(Date.now() / 1000) + RELAY_TICKET_TTL_S,
        });
    }
    async removeMember(roomId, agentId) {
        const room = this.requireOwned(roomId);
        const member = room.members.find((m) => m.agentId === agentId);
        if (!member)
            return;
        room.members = room.members.filter((m) => m.agentId !== agentId);
        this.tokens.get(roomId)?.delete(agentId);
        if (room.type === "persistent")
            await this.persistence.saveRoom(room);
        this.emit("members", roomId, room.members);
        this.emit("system", roomId, { kind: "member-left", text: `${member.nickname} 离开了房间`, ts: nowIso(), by: agentId });
    }
    /**
     * Resolve a member reference (agentId or nickname, case-insensitive nickname)
     * to a canonical member. Throws unknown-member when absent, ambiguous-member
     * when the nickname matches more than one member.
     */
    resolveMember(room, ref) {
        const normalized = ref.toLowerCase();
        const matches = room.members.filter((m) => m.agentId === ref || m.nickname.toLowerCase() === normalized);
        if (matches.length === 0)
            throw new RoomError("unknown-member", `成员不存在: ${ref}`);
        if (matches.length > 1)
            throw new RoomError("ambiguous-member", `昵称存在同名成员: ${ref}`);
        return matches[0];
    }
    /** Resolve an assignee reference, preserving the existing not-member error semantics. */
    resolveAssignee(room, ref) {
        try {
            return this.resolveMember(room, ref).agentId;
        }
        catch (err) {
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
    async revokeMember(roomId, by, agentId, reason) {
        const room = this.requireOwned(roomId);
        if (room.ownerAgentId !== by.agentId && room.controllerAgentId !== by.agentId)
            throw new RoomError("forbidden", "只有房主或判定人可以吊销成员");
        if (agentId === room.ownerAgentId)
            throw new RoomError("forbidden", "不能吊销房主");
        const member = room.members.find((m) => m.agentId === agentId);
        const revoked = room.revoked ?? [];
        const existing = revoked.find((r) => r.agentId === agentId);
        const record = {
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
        if (room.type === "persistent")
            await this.persistence.saveRoom(room);
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
    async unrevokeMember(roomId, by, agentId) {
        const room = this.requireOwned(roomId);
        if (room.ownerAgentId !== by.agentId && room.controllerAgentId !== by.agentId)
            throw new RoomError("forbidden", "只有房主或判定人可以解除吊销");
        const revoked = room.revoked ?? [];
        if (!revoked.some((r) => r.agentId === agentId))
            return;
        room.revoked = revoked.filter((r) => r.agentId !== agentId);
        if (room.type === "persistent")
            await this.persistence.saveRoom(room);
        this.emit("system", roomId, { kind: "member-unrevoked", text: `${agentId} 已恢复入场资格`, ts: nowIso(), by: by.agentId });
    }
    /* ------------------------------ settings ----------------------------- */
    async updateSettings(roomId, patch) {
        const room = this.requireOwned(roomId);
        const s = room.settings;
        if (patch.authMode !== undefined)
            s.authMode = patch.authMode;
        if (patch.password !== undefined && patch.password.length > 0)
            s.passwordHash = hashPassword(patch.password);
        if (patch.autoMode !== undefined)
            s.autoMode = patch.autoMode;
        if (patch.maxMembers !== undefined)
            s.maxMembers = patch.maxMembers;
        if (patch.allowHumanTakeover !== undefined)
            s.allowHumanTakeover = patch.allowHumanTakeover;
        if (room.type === "persistent")
            await this.persistence.saveRoom(room);
        this.emit("system", roomId, { kind: "settings", text: "房间设置已更新", ts: nowIso() });
        return room;
    }
    async transferController(roomId, toAgentId) {
        const room = this.requireOwned(roomId);
        if (!room.members.some((m) => m.agentId === toAgentId))
            throw new RoomError("not-member", "目标不在房间内");
        room.controllerAgentId = toAgentId;
        if (room.type === "persistent")
            await this.persistence.saveRoom(room);
        this.emit("system", roomId, { kind: "settings", text: `判定权已转移`, ts: nowIso(), by: toAgentId });
        return room;
    }
    /* ------------------------------ chat --------------------------------- */
    async addChatMessage(roomId, from, input) {
        const room = this.requireOwned(roomId);
        if (input.text.length === 0)
            throw new RoomError("empty-message", "消息不能为空");
        if (input.text.length > 16 * 1024)
            throw new RoomError("message-too-long", "消息过长");
        // Resolve mentions to canonical agentIds (agentId or nickname accepted).
        let mentions;
        if (input.mentions && input.mentions.length > 0) {
            const resolved = [];
            for (const ref of input.mentions) {
                try {
                    resolved.push(this.resolveMember(room, ref).agentId);
                }
                catch (err) {
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
        const message = {
            seq,
            from: from.agentId,
            fromNickname: from.nickname,
            ts: nowIso(),
            text: input.text,
            replyTo: input.replyTo,
            mentions,
            human: input.human,
        };
        if (room.type === "persistent")
            await this.persistence.appendMessage(roomId, message);
        this.trackMessage(roomId, message);
        this.emit("chat", roomId, message);
        return message;
    }
    async recentMessages(roomId, limit = 200, before) {
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
    latestSeq(roomId) {
        return this.seqs.get(roomId) ?? 0;
    }
    /**
     * Confirmed messages in `[fromSeq, toSeq]`, oldest first, capped at `limit`
     * (0.1.35). Used only to answer a member's bounded sync request; callers pass
     * a small span and count.
     */
    async messagesInRange(roomId, fromSeq, toSeq, limit = 200) {
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
    memoryMessages = new Map();
    /** Attach a chat message to the in-memory stream (used by PeerServer for temporary rooms). */
    trackMessage(roomId, message) {
        const list = this.memoryMessages.get(roomId) ?? [];
        list.push(message);
        if (list.length > 500)
            list.splice(0, list.length - 500);
        this.memoryMessages.set(roomId, list);
    }
    /* ------------------------------ tasks -------------------------------- */
    requireTask(room, taskId) {
        const task = room.tasks.find((t) => t.taskId === taskId);
        if (!task)
            throw new RoomError("task-not-found", "任务不存在");
        return task;
    }
    requireMember(room, agentId) {
        if (!room.members.some((m) => m.agentId === agentId))
            throw new RoomError("not-member", "不是房间成员");
    }
    judgeOf(room, task) {
        return task.judge.mode === "auto" ? task.assignee ?? task.createdBy : room.controllerAgentId;
    }
    createTask(roomId, by, input) {
        const room = this.requireOwned(roomId);
        this.requireMember(room, by.agentId);
        const now = nowIso();
        const assignee = input.assignee ? this.resolveAssignee(room, input.assignee) : undefined;
        const task = {
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
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("task", roomId, task);
        return task;
    }
    assignTask(roomId, by, taskId, assignee) {
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
        if (task.status === "todo")
            task.status = "doing";
        task.updatedAt = nowIso();
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("task", roomId, task);
        return task;
    }
    claimTask(roomId, by, taskId) {
        const room = this.requireOwned(roomId);
        this.requireMember(room, by.agentId);
        const task = this.requireTask(room, taskId);
        if (!task.claimable)
            throw new RoomError("not-claimable", "该任务不可认领");
        if (task.assignee && task.assignee !== by.agentId)
            throw new RoomError("claimed", "任务已被认领");
        task.assignee = by.agentId;
        task.claimable = false;
        task.status = "doing";
        task.updatedAt = nowIso();
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("task", roomId, task);
        return task;
    }
    commentTask(roomId, by, taskId, text) {
        const room = this.requireOwned(roomId);
        this.requireMember(room, by.agentId);
        const task = this.requireTask(room, taskId);
        task.comments.push({ agentId: by.agentId, ts: nowIso(), text });
        task.updatedAt = nowIso();
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("task", roomId, task);
        return task;
    }
    setTaskStatus(roomId, by, taskId, status) {
        const room = this.requireOwned(roomId);
        this.requireMember(room, by.agentId);
        const task = this.requireTask(room, taskId);
        const involved = task.assignee === by.agentId || task.createdBy === by.agentId || room.controllerAgentId === by.agentId;
        if (!involved)
            throw new RoomError("forbidden", "无权变更该任务状态");
        task.status = status;
        task.updatedAt = nowIso();
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("task", roomId, task);
        return task;
    }
    completeTask(roomId, by, taskId, note) {
        const room = this.requireOwned(roomId);
        this.requireMember(room, by.agentId);
        const task = this.requireTask(room, taskId);
        const executor = task.assignee ?? task.createdBy;
        if (executor !== by.agentId)
            throw new RoomError("forbidden", "只有执行者可以提交完成");
        if (task.status !== "doing" && task.status !== "todo")
            throw new RoomError("bad-state", `当前状态 ${task.status} 不能提交完成`);
        if (task.judge.mode === "auto") {
            // Autonomous: executor confirms directly (self-judging allowed by design).
            task.status = "done";
            task.judge = { mode: "auto", decidedBy: by.agentId, decidedAt: nowIso(), note };
        }
        else {
            // Controller mode: no self-review.
            if (room.controllerAgentId === by.agentId && executor === by.agentId)
                throw new RoomError("self-review", "执行者与判定人相同，禁止自审：请转移判定权或切换自治模式");
            task.status = "review";
            task.judge = { mode: "controller", note };
        }
        task.updatedAt = nowIso();
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("task", roomId, task);
        this.emit("system", roomId, { kind: "judge", text: `${by.nickname} 提交了任务「${task.title}」的完成`, ts: nowIso(), by: by.agentId });
        return task;
    }
    approveTask(roomId, by, taskId, note) {
        const room = this.requireOwned(roomId);
        this.requireMember(room, by.agentId);
        const task = this.requireTask(room, taskId);
        if (task.status !== "review")
            throw new RoomError("bad-state", "只有 review 状态的任务可被判定");
        if (this.judgeOf(room, task) !== by.agentId)
            throw new RoomError("forbidden", "只有判定人可以批准");
        task.status = "done";
        task.judge = { mode: task.judge.mode, decidedBy: by.agentId, decidedAt: nowIso(), note };
        task.updatedAt = nowIso();
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("task", roomId, task);
        return task;
    }
    rejectTask(roomId, by, taskId, note) {
        const room = this.requireOwned(roomId);
        this.requireMember(room, by.agentId);
        const task = this.requireTask(room, taskId);
        if (task.status !== "review")
            throw new RoomError("bad-state", "只有 review 状态的任务可被判定");
        if (this.judgeOf(room, task) !== by.agentId)
            throw new RoomError("forbidden", "只有判定人可以驳回");
        task.status = "rejected";
        task.judge = { mode: task.judge.mode, decidedBy: by.agentId, decidedAt: nowIso(), note };
        task.updatedAt = nowIso();
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("task", roomId, task);
        return task;
    }
    reopenTask(roomId, by, taskId) {
        const room = this.requireOwned(roomId);
        this.requireMember(room, by.agentId);
        const task = this.requireTask(room, taskId);
        const allowed = task.createdBy === by.agentId || task.assignee === by.agentId || room.controllerAgentId === by.agentId;
        if (!allowed)
            throw new RoomError("forbidden", "无权重新打开该任务");
        if (task.status !== "done" && task.status !== "rejected")
            throw new RoomError("bad-state", "只有 done/rejected 的任务可重开");
        task.status = "todo";
        task.updatedAt = nowIso();
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("task", roomId, task);
        return task;
    }
    listTasks(roomId) {
        return this.requireOwned(roomId).tasks;
    }
    /** Delete a task (creator/assignee may remove only todo tasks; controller may remove any). */
    deleteTask(roomId, by, taskId) {
        const room = this.requireOwned(roomId);
        this.requireMember(room, by.agentId);
        const task = this.requireTask(room, taskId);
        const isController = room.controllerAgentId === by.agentId || room.ownerAgentId === by.agentId;
        const isCreatorOrAssignee = task.createdBy === by.agentId || task.assignee === by.agentId;
        if (!isController && !isCreatorOrAssignee)
            throw new RoomError("forbidden", "无权删除该任务");
        if (task.status !== "todo" && !isController)
            throw new RoomError("forbidden", "非待办状态的任务只有判定人可删除");
        room.tasks = room.tasks.filter((t) => t.taskId !== taskId);
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("taskRemoved", roomId, taskId);
    }
    /** Candidate agents for a task: role match first, then capability overlap. */
    suggestCandidates(roomId, requiredCapabilities, requiredRoles = []) {
        const room = this.requireOwned(roomId);
        const needCaps = new Set(requiredCapabilities);
        const needRoles = new Set(requiredRoles);
        const zeroWeight = ZERO_WEIGHT_CAPABILITIES;
        const ranked = room.members.map((m) => {
            const have = new Set([...(m.capabilities ?? []), ...(m.manualCapabilities ?? [])]);
            let score = 0;
            for (const cap of needCaps)
                if (have.has(cap) && !zeroWeight.has(cap))
                    score += 1;
            let roleMatch = 0;
            for (const role of needRoles)
                if ((m.roles ?? []).includes(role))
                    roleMatch += 1;
            return { agentId: m.agentId, nickname: m.nickname, score, roleMatch };
        });
        ranked.sort((a, b) => (b.roleMatch - a.roleMatch) || (b.score - a.score));
        return ranked;
    }
    /** Attach a structured handoff card to a task (executor or controller). */
    setTaskHandoff(roomId, by, taskId, handoff) {
        const room = this.requireOwned(roomId);
        this.requireMember(room, by.agentId);
        const task = this.requireTask(room, taskId);
        const allowed = task.assignee === by.agentId || task.createdBy === by.agentId || room.controllerAgentId === by.agentId;
        if (!allowed)
            throw new RoomError("forbidden", "无权更新交接卡");
        task.handoff = handoff;
        task.updatedAt = nowIso();
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("task", roomId, task);
        return task;
    }
    /** A member declares their own workflow roles (self-report). */
    setMemberRoles(roomId, by, roles) {
        const room = this.requireOwned(roomId);
        const member = room.members.find((m) => m.agentId === by.agentId);
        if (!member)
            throw new RoomError("not-member", "不在房间内");
        member.roles = roles;
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("members", roomId, room.members);
    }
    /** Refresh a member's live profile (nickname/capabilities/roles) pushed by that member. */
    updateMemberProfile(roomId, agentId, patch) {
        const room = this.requireOwned(roomId);
        const member = room.members.find((m) => m.agentId === agentId);
        if (!member)
            return;
        if (typeof patch.nickname === "string" && patch.nickname)
            member.nickname = patch.nickname;
        if (patch.capabilities)
            member.capabilities = patch.capabilities;
        if (patch.manualCapabilities)
            member.manualCapabilities = patch.manualCapabilities;
        if (patch.roles)
            member.roles = patch.roles;
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("members", roomId, room.members);
    }
    /** Owner (or controller) assigns workflow roles to a member. */
    assignMemberRoles(roomId, by, targetAgentId, roles) {
        const room = this.requireOwned(roomId);
        if (room.controllerAgentId !== by.agentId && room.ownerAgentId !== by.agentId)
            throw new RoomError("forbidden", "只有房主或判定人可以安排岗位");
        const member = room.members.find((m) => m.agentId === targetAgentId);
        if (!member)
            throw new RoomError("not-member", "成员不在房间内");
        member.roles = roles;
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("members", roomId, room.members);
    }
    /** Set the member's manual capability tags (kept separate from auto-collected). */
    setMemberCapabilities(roomId, by, capabilities) {
        const room = this.requireOwned(roomId);
        const member = room.members.find((m) => m.agentId === by.agentId);
        if (!member)
            throw new RoomError("not-member", "不在房间内");
        member.manualCapabilities = capabilities;
        if (room.type === "persistent")
            void this.persistence.saveRoom(room);
        this.emit("members", roomId, room.members);
    }
    /* ------------------------------ misc --------------------------------- */
    async recordJoined(roomId, address, title) {
        this.joined = this.joined.filter((r) => r.roomId !== roomId);
        this.joined.unshift({ roomId, address, title, lastVisitedAt: nowIso() });
        this.joined = this.joined.slice(0, 50);
        await this.persistence.saveJoined(this.joined);
    }
    async recordVisited(roomId, address, title) {
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
    async removeJoinedRoom(roomId) {
        const before = this.joined.length;
        if (before === 0)
            return false;
        this.joined = this.joined.filter((record) => record.roomId !== roomId);
        if (this.joined.length === before)
            return false;
        await this.persistence.saveJoined(this.joined);
        return true;
    }
    /**
     * Replace the joined-room list wholesale (used by boot-time pruning of records
     * that can no longer be reached). Returns the number actually removed.
     */
    async replaceJoinedRooms(records) {
        const removed = this.joined.length - records.length;
        this.joined = records.slice(0, 50);
        await this.persistence.saveJoined(this.joined);
        return removed;
    }
}
function defaultNickname() {
    try {
        return process.env.COMPUTERNAME || process.env.HOSTNAME || "agent";
    }
    catch {
        return "agent";
    }
}
