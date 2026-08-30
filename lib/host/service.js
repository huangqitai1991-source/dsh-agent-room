/**
 * dsh-agent-room — AgentRoomService (Cordis Service).
 *
 * Wires the pure domain logic into DSH: persistent identity, owned-room
 * authoritative state (RoomService), remote-room membership (RoomClients),
 * the RoomGateway facade used by tools and the browser API, and a lazily
 * started PeerServer for owned rooms.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { Service } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { RoomService } from "./room-service.js";
import { PeerServer } from "./peer-server.js";
import { LanDiscovery } from "./discovery.js";
import { RoomClient } from "./room-client.js";
import { DEFAULT_PORT } from "./protocol.js";
import { capabilityForTool } from "./catalog.js";
export function resolveConfig(config = {}) {
    const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    return {
        port: config.port ?? DEFAULT_PORT,
        dataDir: config.dataDir ?? join(dshHome, "agent-room"),
        tools: config.tools ?? true,
        skills: config.skills ?? true,
        relay: config.relay ?? process.env.AGENT_ROOM_RELAY,
    };
}
export class AgentRoomService extends Service {
    roomService;
    config;
    peerServer = null;
    peerStarting = null;
    discovery = null;
    /** Joined (remote) rooms, keyed by roomId. */
    clients = new Map();
    /** Rooms where the local agent is currently "thinking" (activate-chat one-shot
     *  in flight); one thinking per room, cleared when our own reply lands. */
    activateThinkingRooms = new Set();
    /** Per joined room: live channel info (state, relay path, address). */
    connInfo = new Map();
    /** Relay bridge status for owned rooms: roomId -> relayStatus(). */
    relayBridge = new Map();
    /** Browser push subscribers (SSE). */
    browserListeners = new Set();
    /** Persisted relay config file (dataDir/relay-config.json). */
    relayConfigFile = "";
    /** Whether the relay was explicitly configured (config/env/file). */
    relayConfigured = false;
    profileTimer = null;
    constructor(ctx, config = {}) {
        super(ctx, "agentRoom");
        this.config = resolveConfig(config);
        this.roomService = new RoomService({
            dataDir: this.config.dataDir,
            onNeedServer: () => this.ensurePeerServer(),
        });
        this.roomService.on("chat", (roomId, message) => {
            this.ctx.logger?.info?.("[agent-room] chat in %s from %s", roomId, message.from);
            this.emitBrowser({ kind: "chat", roomId, message });
            this.noteOwnReply(roomId, message);
        });
        this.roomService.on("task", (roomId, task) => {
            this.ctx.logger?.info?.("[agent-room] task %s -> %s in %s", task.title, task.status, roomId);
            this.emitBrowser({ kind: "task", roomId, task });
        });
        this.roomService.on("system", (roomId, event) => this.emitBrowser({ kind: "system", roomId, event }));
        this.roomService.on("members", (roomId) => this.emitBrowser({ kind: "members", roomId }));
        this.roomService.on("roomState", () => {
            this.refreshRelayBridge();
            this.emitBrowser({ kind: "state" });
        });
        ctx.effect(() => {
            void this.boot();
            return () => {
                /* boot is fire-and-forget */
            };
        }, "agent-room: boot");
    }
    /** Recent messages for a room (owned via store, joined via client snapshot). */
    async recentMessagesFor(roomId, limit) {
        const owned = this.roomService.getOwnedRoom(roomId);
        if (owned)
            return this.roomService.recentMessages(roomId, limit);
        const client = this.clients.get(roomId);
        const all = client?.snapshot?.recentMessages ?? [];
        return all.slice(-limit);
    }
    /** True while the local agent is thinking for this room (activate-chat in flight). */
    isActivateThinking(roomId) {
        return this.activateThinkingRooms.has(roomId);
    }
    /**
     * 激活聊天 (one-shot): mark the room as thinking and ask the resident agent
     * to reply once with room_send based on the room context. Throws when the
     * room is already thinking (the web layer maps that to HTTP 409).
     */
    activateChat(roomId) {
        if (this.activateThinkingRooms.has(roomId)) {
            throw new Error("该房间正在思考中，请等待回复完成");
        }
        const identity = this.roomService.getIdentity();
        if (!identity)
            throw new Error("本机身份未就绪");
        this.activateThinkingRooms.add(roomId);
        this.emitBrowser({ kind: "state" });
        void this.runActivateChat(roomId, identity);
    }
    /** Build the context prompt and drive the resident agent; clears thinking on failure. */
    async runActivateChat(roomId, identity) {
        try {
            const owned = this.roomService.getOwnedRoom(roomId);
            const client = this.clients.get(roomId);
            const room = owned ?? client?.snapshot?.room;
            if (!room)
                throw new Error(`房间不存在: ${roomId}`);
            const [recent, tasks] = await Promise.all([
                this.recentMessagesFor(roomId, 50),
                Promise.resolve(room.tasks),
            ]);
            const member = room.members.find((m) => m.agentId === identity.agentId);
            const role = member?.roles?.length ? member.roles.join("、") : member?.role ?? "member";
            const prompt = buildActivatePrompt({
                title: room.title,
                identity,
                role,
                recent,
                tasks,
            });
            const agents = this.ctx.agents;
            const agent = agents?.list?.()[0];
            if (!agent) {
                this.ctx.logger?.warn?.("[agent-room] activate-chat: no resident agent available");
                this.activateThinkingRooms.delete(roomId);
                this.emitBrowser({ kind: "state" });
                return;
            }
            this.ctx.logger?.info?.("[agent-room] activate-chat: dispatching followup for %s", roomId);
            agent.followup(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "plugin", plugin: "dsh-agent-room" } }));
        }
        catch (error) {
            this.ctx.logger?.warn?.("[agent-room] activate-chat failed: %s", String(error));
            this.activateThinkingRooms.delete(roomId);
            this.emitBrowser({ kind: "state" });
        }
    }
    /**
     * Detect the end of an activate-chat thinking: once OUR OWN message (sent via
     * room_send) shows up in the room stream, the reply has landed — clear the
     * thinking state so the button becomes clickable again.
     */
    noteOwnReply(roomId, message) {
        if (!this.activateThinkingRooms.has(roomId))
            return;
        const identity = this.roomService.getIdentity();
        if (identity && message.from === identity.agentId) {
            this.ctx.logger?.info?.("[agent-room] activate-chat: own reply landed in %s — thinking done", roomId);
            this.activateThinkingRooms.delete(roomId);
            this.emitBrowser({ kind: "state" });
        }
    }
    async boot() {
        this.relayConfigFile = join(this.config.dataDir, "relay-config.json");
        await this.loadRelayConfig();
        await this.roomService.boot();
        const identity = await this.roomService.ensureIdentity();
        // Auto-collect capabilities: map installed tools onto the 6-family taxonomy
        // and pass skill names through directly (both best-effort).
        const caps = new Set();
        try {
            const tools = this.ctx.get("tools")?.view;
            const known = tools?.()?.knownNames;
            if (known) {
                for (const toolName of known) {
                    const cap = capabilityForTool(toolName);
                    if (cap)
                        caps.add(cap);
                }
            }
        }
        catch {
            /* non-fatal */
        }
        try {
            const skillNames = this.ctx.get("skills")?.collect;
            if (typeof skillNames === "function") {
                const summaries = (await skillNames());
                for (const s of summaries)
                    if (typeof s?.name === "string" && s.name)
                        caps.add(s.name);
            }
        }
        catch {
            /* non-fatal */
        }
        if (caps.size > 0)
            await this.roomService.mergeCapabilities([...caps]);
        this.ctx.logger?.info?.("[agent-room] node identity %s (%s)", identity.agentId, identity.nickname);
        // Eagerly start the room server so the port is always listening after
        // boot — a lazy start tied to room creation leaves persisted rooms
        // unreachable after a restart.
        try {
            const address = await this.ensurePeerServer();
            this.ctx.logger?.info?.("[agent-room] room server listening on %s", address);
            this.refreshRelayBridge();
        }
        catch (error) {
            this.ctx.logger?.warn?.("[agent-room] room server failed to start: %s", String(error));
        }
        // Same-LAN room discovery: broadcast beacons for our rooms and collect
        // beacons from nearby nodes so rooms show up by name without an address.
        try {
            const discovery = new LanDiscovery({
                serverPort: this.config.port,
                node: () => this.roomService.getIdentity() ?? {
                    agentId: "unknown",
                    nickname: "unknown",
                    capabilities: [],
                    createdAt: "",
                },
                rooms: () => this.roomService.listOwnedRooms().map((room) => ({
                    roomId: room.roomId,
                    title: room.title,
                    authMode: room.settings.authMode,
                    memberCount: room.members.length,
                    status: room.status,
                })),
            });
            await discovery.start();
            this.discovery = discovery;
        }
        catch (error) {
            this.ctx.logger?.warn?.("[agent-room] LAN discovery unavailable: %s", String(error));
        }
        // Push our live profile (nickname/capabilities) to joined rooms so member
        // lists reflect identity edits on the owner's side.
        this.profileTimer = setInterval(() => void this.syncProfile(), 15_000);
    }
    /** Broadcast our current identity to every joined room (nickname/capabilities). */
    async syncProfile() {
        if (this.clients.size === 0)
            return;
        const identity = this.roomService.getIdentity();
        if (!identity)
            return;
        for (const client of this.clients.values()) {
            try {
                client.sendProfile({ nickname: identity.nickname, capabilities: identity.capabilities });
            }
            catch { /* non-fatal */ }
        }
    }
    /* --------------------------- peer server ----------------------------- */
    async ensurePeerServer() {
        if (this.peerServer)
            return this.peerServer.address;
        this.peerStarting ??= (async () => {
            const server = new PeerServer({ port: this.config.port, service: this.roomService, relay: this.config.relay });
            const address = await server.start();
            this.peerServer = server;
            this.ctx.logger?.info?.("[agent-room] room server listening on %s", address);
            return address;
        })();
        return this.peerStarting;
    }
    /* --------------------------- gateway impl ---------------------------- */
    gateway = {
        identity: () => this.roomService.ensureIdentity(),
        createRoom: (input) => this.roomService.createRoom(input),
        closeRoom: (roomId) => this.roomService.closeRoom(roomId),
        destroyRoom: (roomId) => this.roomService.destroyRoom(roomId),
        listRooms: () => ({
            owned: this.roomService.listOwnedRooms(),
            joined: this.roomService.listJoinedRooms(),
        }),
        roomInfo: async (roomId) => {
            const owned = this.roomService.getOwnedRoom(roomId);
            if (owned)
                return { room: owned, recentMessages: await this.roomService.recentMessages(roomId), owned: true };
            const client = this.clients.get(roomId);
            if (client?.snapshot)
                return { room: client.snapshot.room, recentMessages: client.snapshot.recentMessages, owned: false };
            throw new Error(`房间不存在: ${roomId}`);
        },
        joinRoom: async (addresses, options) => {
            const identity = await this.roomService.ensureIdentity();
            const client = new RoomClient({
                addresses,
                roomId: options.roomId,
                password: options.password,
                agent: identity,
                relay: options.relay ?? this.config.relay,
                onJoinedRecord: (record) => this.roomService.recordVisited(record.roomId, record.address, record.title),
            });
            await client.connect();
            const roomId = client.currentRoomId;
            if (!roomId)
                throw new Error("加入失败：未获得房间 id");
            client.on("chat", (message) => {
                this.emitBrowser({ kind: "chat", roomId, message });
                this.noteOwnReply(roomId, message);
            });
            client.on("task", (task) => this.emitBrowser({ kind: "task", roomId, task }));
            client.on("system", (event) => this.emitBrowser({ kind: "system", roomId, event }));
            client.on("connection", (state) => {
                this.connInfo.set(roomId, { state, viaRelay: client.viaRelay, address: client.address });
                this.emitBrowser({ kind: "connection", roomId, state });
            });
            client.on("snapshot", () => this.emitBrowser({ kind: "state" }));
            this.connInfo.set(roomId, { state: client.connState, viaRelay: client.viaRelay, address: client.address });
            this.clients.set(roomId, client);
            this.ctx.logger?.info?.("[agent-room] joined room %s at %s", roomId, client.address);
            return { roomId, title: client.snapshot?.room.title ?? "" };
        },
        leaveRoom: async (roomId) => {
            if (this.roomService.getOwnedRoom(roomId)) {
                await this.roomService.closeRoom(roomId);
                return;
            }
            const client = this.clients.get(roomId);
            if (!client)
                throw new Error(`房间不存在: ${roomId}`);
            await client.leave();
            this.clients.delete(roomId);
            this.connInfo.delete(roomId);
        },
        kickMember: (roomId, agentId) => this.roomService.removeMember(roomId, agentId),
        revokeMember: async (roomId, agentId, reason) => {
            const identity = await this.roomService.ensureIdentity();
            return this.roomService.revokeMember(roomId, identity, agentId, reason);
        },
        unrevokeMember: async (roomId, agentId) => {
            const identity = await this.roomService.ensureIdentity();
            return this.roomService.unrevokeMember(roomId, identity, agentId);
        },
        sendChat: async (roomId, input) => {
            const owned = this.roomService.getOwnedRoom(roomId);
            if (owned) {
                const identity = await this.roomService.ensureIdentity();
                return this.roomService.addChatMessage(roomId, identity, input);
            }
            const client = this.clients.get(roomId);
            if (!client)
                throw new Error(`房间不存在: ${roomId}`);
            client.sendChat(input);
            return null;
        },
        updateSettings: (roomId, patch) => this.roomService.updateSettings(roomId, patch),
        transferController: (roomId, toAgentId) => this.roomService.transferController(roomId, toAgentId),
        taskCreate: async (roomId, input) => {
            const owned = this.roomService.getOwnedRoom(roomId);
            if (owned) {
                const identity = await this.roomService.ensureIdentity();
                return this.roomService.createTask(roomId, identity, input);
            }
            const client = this.clients.get(roomId);
            if (!client)
                throw new Error(`房间不存在: ${roomId}`);
            client.taskCreate(input);
            return this.projectedTask(client, input.title);
        },
        taskList: async (roomId, status) => {
            const owned = this.roomService.getOwnedRoom(roomId);
            if (owned)
                return this.roomService.listTasks(roomId).filter((t) => !status || t.status === status);
            const client = this.clients.get(roomId);
            if (!client?.snapshot)
                throw new Error(`房间不存在: ${roomId}`);
            return client.snapshot.room.tasks.filter((t) => !status || t.status === status);
        },
        taskAssign: (roomId, taskId, assignee) => this.ownedOrProxy(roomId, (identity) => this.roomService.assignTask(roomId, identity, taskId, assignee), (client) => { client.taskAssign(taskId, assignee); return this.projectedTask(client, undefined, taskId); }),
        taskClaim: (roomId, taskId) => this.ownedOrProxy(roomId, (identity) => this.roomService.claimTask(roomId, identity, taskId), (client) => { client.taskClaim(taskId); return this.projectedTask(client, undefined, taskId); }),
        taskComment: (roomId, taskId, text) => this.ownedOrProxy(roomId, (identity) => this.roomService.commentTask(roomId, identity, taskId, text), (client) => { client.taskComment(taskId, text); return this.projectedTask(client, undefined, taskId); }),
        taskStatus: (roomId, taskId, status) => this.ownedOrProxy(roomId, (identity) => this.roomService.setTaskStatus(roomId, identity, taskId, status), (client) => { client.taskStatus(taskId, status); return this.projectedTask(client, undefined, taskId); }),
        taskComplete: (roomId, taskId, note) => this.ownedOrProxy(roomId, (identity) => this.roomService.completeTask(roomId, identity, taskId, note), (client) => { client.taskComplete(taskId, note); return this.projectedTask(client, undefined, taskId); }),
        taskApprove: (roomId, taskId, note) => this.ownedOrProxy(roomId, (identity) => this.roomService.approveTask(roomId, identity, taskId, note), (client) => { client.taskApprove(taskId, note); return this.projectedTask(client, undefined, taskId); }),
        taskReject: (roomId, taskId, note) => this.ownedOrProxy(roomId, (identity) => this.roomService.rejectTask(roomId, identity, taskId, note), (client) => { client.taskReject(taskId, note); return this.projectedTask(client, undefined, taskId); }),
        taskReopen: (roomId, taskId) => this.ownedOrProxy(roomId, (identity) => this.roomService.reopenTask(roomId, identity, taskId), (client) => { client.taskReopen(taskId); return this.projectedTask(client, undefined, taskId); }),
        taskDelete: async (roomId, taskId) => {
            const owned = this.roomService.getOwnedRoom(roomId);
            if (owned) {
                const identity = await this.roomService.ensureIdentity();
                this.roomService.deleteTask(roomId, identity, taskId);
                return;
            }
            const client = this.clients.get(roomId);
            if (!client)
                throw new Error(`房间不存在: ${roomId}`);
            client.taskRemove(taskId);
        },
        taskHandoff: (roomId, taskId, handoff) => this.ownedOrProxy(roomId, (identity) => this.roomService.setTaskHandoff(roomId, identity, taskId, handoff), (client) => { client.taskHandoff(taskId, handoff); return this.projectedTask(client, undefined, taskId); }),
        setMemberRoles: async (roomId, roles) => {
            const identity = await this.roomService.ensureIdentity();
            if (this.roomService.getOwnedRoom(roomId)) {
                this.roomService.setMemberRoles(roomId, identity, roles);
                return;
            }
            // Joined room: push the role change through the client to the owner.
            const client = this.clients.get(roomId);
            if (!client)
                throw new Error(`房间不存在: ${roomId}`);
            client.sendProfile({ nickname: identity.nickname, capabilities: identity.capabilities, roles });
        },
        assignMemberRoles: async (roomId, targetAgentId, roles) => {
            const identity = await this.roomService.ensureIdentity();
            this.roomService.assignMemberRoles(roomId, identity, targetAgentId, roles);
        },
        setMemberCapabilities: async (roomId, capabilities) => {
            const identity = await this.roomService.ensureIdentity();
            if (this.roomService.getOwnedRoom(roomId)) {
                this.roomService.setMemberCapabilities(roomId, identity, capabilities);
                return;
            }
            const client = this.clients.get(roomId);
            if (!client)
                throw new Error(`房间不存在: ${roomId}`);
            client.sendProfile({ nickname: identity.nickname, manualCapabilities: capabilities });
        },
        suggestCandidates: async (roomId, caps, roles) => {
            const owned = this.roomService.getOwnedRoom(roomId);
            if (owned)
                return this.roomService.suggestCandidates(roomId, caps, roles);
            const client = this.clients.get(roomId);
            if (!client?.snapshot)
                return [];
            return client.snapshot.room.members.map((m) => ({ agentId: m.agentId, nickname: m.nickname, score: 0, roleMatch: 0 }));
        },
    };
    async ownedOrProxy(roomId, owned, proxy) {
        const isOwned = this.roomService.getOwnedRoom(roomId) !== undefined;
        if (isOwned) {
            const identity = await this.roomService.ensureIdentity();
            return owned(identity);
        }
        const client = this.clients.get(roomId);
        if (!client)
            throw new Error(`房间不存在: ${roomId}`);
        return proxy(client);
    }
    projectedTask(client, title, taskId) {
        const tasks = client.snapshot?.room.tasks ?? [];
        if (taskId) {
            const found = tasks.find((t) => t.taskId === taskId);
            if (found)
                return found;
        }
        else if (title) {
            const found = tasks.find((t) => t.title === title);
            if (found)
                return found;
        }
        throw new Error(`任务操作已发送，等待房主节点同步（可用 task_list 查看最新状态）`);
    }
    /* --------------------------- relay config ---------------------------- */
    async loadRelayConfig() {
        try {
            const text = await readFile(this.relayConfigFile, "utf8");
            const data = JSON.parse(text);
            // A persisted file wins over config/env so the UI change survives restarts.
            this.config.relay = typeof data.relay === "string" && data.relay.trim() ? data.relay : undefined;
        }
        catch {
            /* first run: no persisted file yet */
        }
        this.relayConfigured = Boolean(this.config.relay);
    }
    /** Set (or clear) the cross-network relay address; persists to disk and re-bridges owned rooms. */
    async setRelayConfig(relay) {
        const next = relay?.trim() || undefined;
        this.config.relay = next;
        this.relayConfigured = Boolean(next);
        try {
            await writeFile(this.relayConfigFile, JSON.stringify({ relay: next ?? null }, null, 2), "utf8");
        }
        catch (error) {
            this.ctx.logger?.warn?.("[agent-room] failed to persist relay config: %s", String(error));
        }
        if (this.peerServer)
            this.peerServer.setRelay(next);
        this.refreshRelayBridge();
        this.emitBrowser({ kind: "state" });
        return next;
    }
    getRelayConfig() {
        return { address: this.config.relay, configured: this.relayConfigured };
    }
    refreshRelayBridge() {
        if (!this.peerServer)
            return;
        for (const room of this.roomService.listOwnedRooms()) {
            this.relayBridge.set(room.roomId, this.peerServer.relayStatus(room.roomId));
        }
    }
    /* --------------------------- browser push ---------------------------- */
    /** Subscribe to browser push events (SSE); returns an unsubscribe function. */
    onBrowserEvent(listener) {
        this.browserListeners.add(listener);
        return () => this.browserListeners.delete(listener);
    }
    emitBrowser(event) {
        for (const listener of this.browserListeners) {
            try {
                listener(event);
            }
            catch {
                /* listener errors must not break the room loop */
            }
        }
    }
    /* --------------------------- browser state --------------------------- */
    /** Full state snapshot for the browser UI. */
    async browserState() {
        const identity = await this.roomService.ensureIdentity();
        const owned = this.roomService.listOwnedRooms();
        const joinedRooms = [...this.clients.entries()]
            .filter(([, client]) => client.snapshot !== null)
            .map(([, client]) => client.snapshot.room);
        const joinedLatest = new Map();
        for (const [roomId, client] of this.clients) {
            const msgs = client.snapshot?.recentMessages ?? [];
            joinedLatest.set(roomId, msgs.length > 0 ? msgs[msgs.length - 1].seq : 0);
        }
        const rooms = [];
        for (const room of [...owned, ...joinedRooms]) {
            const isOwned = room.ownerAgentId === identity.agentId;
            const info = this.connInfo.get(room.roomId);
            const bridgeState = isOwned ? this.relayBridge.get(room.roomId) ?? "none" : info?.state ?? "connecting";
            const bridge = isOwned
                ? { kind: (bridgeState === "none" ? "none" : "relay"), state: bridgeState, address: this.config.relay }
                : { kind: (info?.viaRelay ? "relay" : "direct"), state: info?.state ?? "connecting", address: info?.address ?? room.serverAddress };
            const latestSeq = isOwned
                ? ((await this.roomService.recentMessages(room.roomId, 1))[0]?.seq ?? 0)
                : (joinedLatest.get(room.roomId) ?? 0);
            rooms.push({
                roomId: room.roomId,
                title: room.title,
                type: room.type,
                status: room.status,
                owned: isOwned,
                authMode: room.settings.authMode,
                autoMode: room.settings.autoMode,
                allowHumanTakeover: room.settings.allowHumanTakeover,
                controllerAgentId: room.controllerAgentId,
                serverAddress: isOwned ? this.peerServer?.address ?? room.serverAddress : room.serverAddress,
                memberCount: room.members.length,
                members: room.members,
                tasks: room.tasks,
                revoked: room.revoked ?? [],
                activateThinking: this.activateThinkingRooms.has(room.roomId),
                latestSeq,
                bridge,
            });
        }
        const discovered = this.discovery?.discovered() ?? [];
        return {
            identity,
            node: { hostname: hostname(), addresses: this.peerServer?.candidates ?? [] },
            relay: { address: this.config.relay, configured: this.relayConfigured },
            discovered,
            rooms,
        };
    }
    /** Recent messages for one room (owned or joined). */
    async browserMessages(roomId, limit = 200, before) {
        const owned = this.roomService.getOwnedRoom(roomId);
        if (owned)
            return this.roomService.recentMessages(roomId, limit, before);
        const client = this.clients.get(roomId);
        const all = client?.snapshot?.recentMessages ?? [];
        const filtered = before === undefined ? all : all.filter((m) => m.seq < before);
        return filtered.slice(-limit);
    }
}
/* ------------------------- activate-chat prompt ------------------------ */
/**
 * Build the context prompt for a one-shot activate-chat reply: identity, role,
 * open tasks, and the recent message stream so the agent can reply relevantly
 * (quoting prior chat / tasks / @mentions).
 */
function buildActivatePrompt(input) {
    const lines = [];
    lines.push(`你在房间「${input.title}」中被手动激活聊天，请基于房间上下文自然回复一条相关内容。`);
    lines.push(`你的身份：${input.identity.nickname}（agentId: ${input.identity.agentId}，角色: ${input.role}，能力: ${input.identity.capabilities.join("、") || "无"}）。`);
    if (input.tasks.length > 0) {
        lines.push(`当前任务（${input.tasks.length} 个）：`);
        for (const t of input.tasks.slice(0, 10)) {
            const assignee = t.assignee ? `（负责人: ${t.assignee}）` : "";
            const acceptance = t.acceptance ? ` 验收: ${t.acceptance}` : "";
            lines.push(`- [${t.status}] ${t.title}${assignee}${acceptance}`);
        }
    }
    else {
        lines.push("当前房间没有任务。");
    }
    if (input.recent.length > 0) {
        lines.push(`最近消息（${input.recent.length} 条）：`);
        for (const m of input.recent) {
            const human = m.human ? " [人类]" : "";
            const mention = m.mentions && m.mentions.length > 0 ? ` @[${m.mentions.join(",")}]` : "";
            lines.push(`- ${m.fromNickname}${human}: ${m.text}${mention}`);
        }
    }
    else {
        lines.push("房间还没有消息。");
    }
    lines.push("请用 room_send 工具向该房间发送一条与上下文相关、自然简短的中文回复（可引用之前的聊天、任务或 @提及成员）。");
    return lines.join("\n");
}
