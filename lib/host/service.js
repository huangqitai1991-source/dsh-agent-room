/**
 * dsh-agent-room — AgentRoomService (Cordis Service).
 *
 * Wires the pure domain logic into DSH: persistent identity, owned-room
 * authoritative state (RoomService), remote-room membership (RoomClients),
 * the RoomGateway facade used by tools and the browser API, and a lazily
 * started PeerServer for owned rooms.
 */
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
    /** Rooms where the local agent auto-replies to incoming messages. */
    autoReplyRooms = new Set();
    /** Rooms with a followup already in flight, so the sweep doesn't double-reply. */
    autoReplyPending = new Set();
    autoReplyTimer = null;
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
            // Immediate auto-reply trigger (the 3s sweep is the backstop).
            void this.sweepAutoReply();
        });
        this.roomService.on("task", (roomId, task) => {
            this.ctx.logger?.info?.("[agent-room] task %s -> %s in %s", task.title, task.status, roomId);
        });
        ctx.effect(() => {
            void this.boot();
            return () => {
                /* boot is fire-and-forget */
            };
        }, "agent-room: boot");
    }
    /** Latest message in a room (owned via store, joined via client snapshot). */
    async lastMessageFor(roomId) {
        const owned = this.roomService.getOwnedRoom(roomId);
        if (owned) {
            const recent = await this.roomService.recentMessages(roomId, 1);
            return recent[recent.length - 1];
        }
        const client = this.clients.get(roomId);
        const recent = client?.snapshot?.recentMessages ?? [];
        return recent[recent.length - 1];
    }
    /** Drive the local agent to reply to a peer message. */
    dispatchAutoReply(roomId, message) {
        const identity = this.roomService.getIdentity();
        if (!identity || message.from === identity.agentId)
            return;
        this.autoReplyPending.add(roomId);
        try {
            const agents = this.ctx.agents;
            const agent = agents?.list?.()[0];
            if (!agent) {
                this.ctx.logger?.warn?.("[agent-room] auto-reply: no resident agent available");
                this.autoReplyPending.delete(roomId);
                return;
            }
            const prompt = `房间「${this.roomService.getOwnedRoom(roomId)?.title ?? roomId}」收到 ${message.fromNickname} 的消息:「${message.text}」。你开启了自动回复,请用 room_send 工具向该房间自然、简短地回复。`;
            agent.followup(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "plugin", plugin: "dsh-agent-room" } }));
            // Clear the in-flight guard after a generous window; a later sweep re-arms
            // if the reply never landed (e.g. the followup was silently dropped).
            setTimeout(() => this.autoReplyPending.delete(roomId), 60_000);
        }
        catch (error) {
            this.autoReplyPending.delete(roomId);
            this.ctx.logger?.warn?.("[agent-room] auto-reply failed: %s", String(error));
        }
    }
    /**
     * Auto-reply sweep: for each enabled room, reply only when the latest message
     * is from a peer (i.e. it is still unanswered); otherwise wait. Catches up on
     * messages that arrived while auto-reply was off, and never double-replies.
     */
    async sweepAutoReply() {
        const identity = this.roomService.getIdentity();
        if (!identity)
            return;
        for (const roomId of this.autoReplyRooms) {
            if (this.autoReplyPending.has(roomId))
                continue;
            const last = await this.lastMessageFor(roomId);
            if (last && last.from !== identity.agentId)
                this.dispatchAutoReply(roomId, last);
        }
    }
    /** Turn auto-reply on/off for a room (owned or joined). */
    setAutoReply(roomId, on) {
        if (on) {
            this.autoReplyRooms.add(roomId);
            // Catch up immediately: if there is an unanswered peer message, reply now.
            void this.sweepAutoReply();
        }
        else {
            this.autoReplyRooms.delete(roomId);
            this.autoReplyPending.delete(roomId);
        }
    }
    async boot() {
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
        // Auto-reply sweep: reply to unanswered peer messages in enabled rooms.
        this.autoReplyTimer = setInterval(() => void this.sweepAutoReply(), 3_000);
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
            const server = new PeerServer({ port: this.config.port, service: this.roomService });
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
                onJoinedRecord: (record) => this.roomService.recordVisited(record.roomId, record.address, record.title),
            });
            await client.connect();
            const roomId = client.currentRoomId;
            if (!roomId)
                throw new Error("加入失败：未获得房间 id");
            client.on("chat", () => void this.sweepAutoReply());
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
        setAutoReply: (roomId, on) => this.setAutoReply(roomId, on),
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
    /* --------------------------- browser state --------------------------- */
    /** Full state snapshot for the browser UI. */
    async browserState() {
        const identity = await this.roomService.ensureIdentity();
        const owned = this.roomService.listOwnedRooms();
        const joinedRooms = [...this.clients.entries()]
            .filter(([, client]) => client.snapshot !== null)
            .map(([, client]) => client.snapshot.room);
        const rooms = [...owned, ...joinedRooms].map((room) => ({
            roomId: room.roomId,
            title: room.title,
            type: room.type,
            status: room.status,
            owned: room.ownerAgentId === identity.agentId,
            authMode: room.settings.authMode,
            autoMode: room.settings.autoMode,
            allowHumanTakeover: room.settings.allowHumanTakeover,
            controllerAgentId: room.controllerAgentId,
            serverAddress: room.ownerAgentId === identity.agentId ? this.peerServer?.address ?? room.serverAddress : room.serverAddress,
            memberCount: room.members.length,
            members: room.members,
            tasks: room.tasks,
            revoked: room.revoked ?? [],
            autoReply: this.autoReplyRooms.has(room.roomId),
        }));
        const discovered = this.discovery?.discovered() ?? [];
        return {
            identity,
            node: { hostname: hostname(), addresses: this.peerServer?.candidates ?? [] },
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
