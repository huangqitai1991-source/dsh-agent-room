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
import * as toolsPlugin from "../tools/index.js";
export function resolveConfig(config = {}) {
    const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    return {
        port: config.port ?? DEFAULT_PORT,
        dataDir: config.dataDir ?? join(dshHome, "agent-room"),
        tools: config.tools ?? true,
        skills: config.skills ?? true,
        relay: config.relay ?? process.env.AGENT_ROOM_RELAY,
        replyAgentId: config.replyAgentId ?? process.env.AGENT_ROOM_REPLY_AGENT,
    };
}
export class AgentRoomService extends Service {
    /** Cordis service dependencies: the DSH agent registry (ctx.agents) used by
     *  activate-chat / resident-agent resolution. Without this declaration,
     *  accessing ctx.agents throws "cannot get property \"agents\" without inject". */
    static inject = ["agents"];
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
    /** Rooms where the local agent LISTENS to the conversation and wakes itself
     *  when something needs it (rule layer + prompt; see sweepListening). */
    listeningRooms = new Set();
    /** Per-room highest processed message seq (dedup: each message wakes at most once). */
    listenSeen = new Map();
    /** Rooms with a listening wake currently in flight (skip until it settles). */
    listenPending = new Set();
    listenTimer = null;
    /** Persisted stable choice of the reply agent (dataDir/reply-agent.json). */
    replyAgentFile = "";
    persistedReplyAgentId;
    /** Dedicated duty-agent session id (agent-room-duty-<nodeAgentId>); spawned on
     *  demand so room replies never depend on "whichever session is first". */
    dutyAgentId;
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
     * to reply once with room_send based on the room context. Resolves the
     * resident agent synchronously so the web layer can return an explicit
     * HTTP 500 when no agent is available (never silently clears thinking).
     * Throws when the room is already thinking (HTTP 409) or no resident agent
     * exists (HTTP 500).
     */
    async activateChat(roomId) {
        if (this.activateThinkingRooms.has(roomId)) {
            throw new Error("该房间正在思考中，请等待回复完成");
        }
        const identity = this.roomService.getIdentity();
        if (!identity)
            throw new Error("本机身份未就绪");
        const agent = await this.resolveResidentAgent(identity);
        if (!agent) {
            this.diag("activate-chat: rejecting " + roomId + " — no resident agent found");
            throw new Error("未找到本机 agent，无法激活聊天（请确认 DSH agent 会话已就绪后重试）");
        }
        this.activateThinkingRooms.add(roomId);
        this.emitBrowser({ kind: "state" });
        void this.runActivateChat(roomId, identity, agent);
        return { agentId: agent.id ?? agent.sessionId };
    }
    /** Diagnostic logger: always lands on stderr (console.error) so activate-chat
     *  issues are visible in dsh-web-new.err.log even when ctx.logger is quiet.
     *  Also mirrors to the cordis logger when available. */
    diag(message, ...args) {
        try {
            console.error("[agent-room] " + message, ...args);
        }
        catch {
            /* logging must never throw */
        }
        try {
            this.ctx.logger?.info?.("[agent-room] " + message, ...args);
        }
        catch {
            /* ignore */
        }
    }
    /** Structural view of the DSH agent registry (ctx.agents), if present. */
    agentsRegistry() {
        return this.ctx.agents;
    }
    /**
     * Find the resident (local) agent that should reply to an activate-chat.
     * Tries several registry entry points in order, logging each attempt:
     * 1. ctx.agent — the scoped agent association when the service context is
     *    agent-derived;
     * 2. agents.currentInitiator() — the agent initiating the caller chain;
     * 3. agents.get(identity.agentId) — the room identity, when it matches a
     *    live session id;
     * 4. agents.list()[0] / agents.roots()[0] — first live / top-level agent.
     */
    async resolveResidentAgent(identity) {
        const agents = this.agentsRegistry();
        const usable = (a) => a && typeof a.followup === "function" ? a : undefined;
        // 1. explicit override (config / AGENT_ROOM_REPLY_AGENT)
        if (this.config.replyAgentId) {
            try {
                const a = usable(agents?.get?.(this.config.replyAgentId));
                if (a)
                    return a;
            }
            catch { /* ignore */ }
        }
        // 1b. dedicated duty-agent session (root-cause fix): stable, spawned on
        // demand, independent of the boss's chat sessions.
        const duty = await this.ensureDutyAgent();
        if (duty)
            return duty;
        // 2. persisted stable choice (dataDir/reply-agent.json) — survives restarts
        if (this.persistedReplyAgentId) {
            try {
                const a = usable(agents?.get?.(this.persistedReplyAgentId));
                if (a) {
                    this.diag("activate-chat: resident agent via persisted choice (id=" + (a.id ?? a.sessionId ?? "unknown") + ")");
                    return a;
                }
            }
            catch { /* ignore */ }
        }
        // 3. room identity matching a live session
        try {
            const a = usable(agents?.get?.(identity.agentId));
            if (a) {
                this.diag("activate-chat: resident agent via room identity (id=" + (a.id ?? a.sessionId ?? "unknown") + ")");
                this.saveReplyAgentId(a);
                return a;
            }
        }
        catch { /* ignore */ }
        // 4. heuristic: session-* ids first, kanban task agents excluded
        let all = [];
        try {
            all = agents?.list?.() ?? [];
        }
        catch { /* ignore */ }
        const candidates = all.filter((a) => typeof a.followup === "function" && !(a.id ?? a.sessionId ?? "").includes("herness-kanban-task-"));
        const preferred = candidates.filter((a) => (a.id ?? a.sessionId ?? "").startsWith("session-"));
        const pick = (preferred.length > 0 ? preferred : candidates)[0];
        if (pick) {
            this.diag("activate-chat: resident agent via heuristic " + (preferred.length > 0 ? "session-*" : "fallback") + " (id=" + (pick.id ?? pick.sessionId ?? "unknown") + ")");
            this.saveReplyAgentId(pick);
            return pick;
        }
        this.diag("activate-chat: NO resident agent (registry=" + (agents ? "present" : "absent") + ", agents.list()=" + all.length + ")");
        return undefined;
    }
    /* ----------------------- reply-agent persistence ---------------------- */
    async loadReplyAgentId() {
        if (!this.replyAgentFile)
            return undefined;
        try {
            const raw = await readFile(this.replyAgentFile, "utf8");
            const parsed = JSON.parse(raw);
            return typeof parsed.replyAgentId === "string" && parsed.replyAgentId ? parsed.replyAgentId : undefined;
        }
        catch {
            return undefined;
        }
    }
    saveReplyAgentId(agent) {
        const id = agent.id ?? agent.sessionId;
        if (!id || !this.replyAgentFile)
            return;
        this.persistedReplyAgentId = id;
        void writeFile(this.replyAgentFile, JSON.stringify({ replyAgentId: id }, null, 2), "utf8").catch(() => { });
    }
    /* --------------------------- duty agent (治本) ------------------------ */
    /**
     * Ensure a dedicated "值守" agent session exists and is usable. Its id is
     * deterministic (agent-room-duty-<nodeAgentId>), so restarts re-attach to the
     * SAME session instead of guessing. This makes activate-chat / listening wake
     * independent of the boss's chat sessions — the true root-cause fix.
     */
    async ensureDutyAgent() {
        const identity = this.roomService.getIdentity();
        if (!identity)
            return undefined;
        const dutyId = "agent-room-duty-" + identity.agentId;
        const agents = this.agentsRegistry();
        // Re-attach to an existing (restored) duty session first.
        try {
            const existing = agents?.get?.(dutyId);
            if (existing && typeof existing.followup === "function") {
                this.dutyAgentId = dutyId;
                return existing;
            }
        }
        catch { /* ignore */ }
        // Spawn it on demand.
        if (typeof agents?.create !== "function") {
            this.diag("duty agent: ctx.agents.create unavailable — falling back to heuristic");
            return undefined;
        }
        try {
            // Mirror the model config of an existing live session — spawned sessions
            // without an explicit provider/model can stall on their first turn.
            let provider;
            let model;
            try {
                for (const a of agents?.list?.() ?? []) {
                    const opts = a.options;
                    if (opts?.provider && opts?.model) {
                        provider = opts.provider;
                        model = opts.model;
                        break;
                    }
                }
            }
            catch { /* ignore */ }
            const handle = await agents.create({
                sessionId: dutyId,
                meta: { cwd: process.cwd() },
                agentOptions: {
                    ...(provider ? { provider } : {}),
                    ...(model ? { model } : {}),
                },
                setup(agentCtx) {
                    try {
                        agentCtx?.systemPrompt?.section?.({
                            name: "agent-room:duty",
                            order: 50,
                            text: "你是 agent-room 的「值守」agent：保持空闲，只响应来自插件 followup 的指令。" +
                                "收到激活聊天/监听唤醒的指令时，按指令用 room_send 工具回复对应房间；" +
                                "指令说不需要回应时，不要调用任何工具。不要主动闲聊。",
                        });
                    }
                    catch {
                        /* systemPrompt section is best-effort */
                    }
                    // Make the room tools (room_* / task_*) available inside this spawned
                    // session — spawned sessions do not inherit host-registered tools.
                    try {
                        agentCtx?.plugin?.(toolsPlugin);
                    }
                    catch {
                        /* tool mounting is best-effort; room replies fall back to HTTP via pwsh */
                    }
                },
            });
            const agent = handle?.agent;
            if (agent && typeof agent.followup === "function") {
                this.dutyAgentId = dutyId;
                this.saveReplyAgentId(agent);
                this.diag("duty agent: spawned " + dutyId);
                return agent;
            }
        }
        catch (error) {
            this.diag("duty agent: spawn failed — " + String(error));
        }
        return undefined;
    }
    /** Build the context prompt and drive the resident agent. Thinking is kept
     *  until our own reply lands (noteOwnReply) or the flow fails explicitly. */
    async runActivateChat(roomId, identity, agent) {
        const agentId = agent.id ?? agent.sessionId ?? "unknown";
        try {
            const owned = this.roomService.getOwnedRoom(roomId);
            const client = this.clients.get(roomId);
            const room = owned ?? client?.snapshot?.room;
            if (!room)
                throw new Error(`房间不存在: ${roomId}`);
            const [recent, tasks] = await Promise.all([
                this.recentMessagesFor(roomId, 3),
                Promise.resolve(room.tasks),
            ]);
            const member = room.members.find((m) => m.agentId === identity.agentId);
            const role = member?.roles?.length ? member.roles.join("、") : member?.role ?? "member";
            const prompt = buildActivatePrompt({
                roomId,
                title: room.title,
                identity,
                role,
                recent,
                tasks,
            });
            this.diag("activate-chat: dispatching followup for " + roomId + " to agent " + agentId);
            agent.followup?.(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "plugin", plugin: "dsh-agent-room" } }));
            this.diag("activate-chat: followup accepted for " + roomId + " — thinking stays on until own reply lands");
            this.armActivateWatchdog(roomId);
        }
        catch (error) {
            this.failActivate(roomId, "激活聊天失败: " + String(error));
        }
    }
    /** Clear thinking + notify the UI (stderr log + browser events) because the
     *  activate-chat flow failed or timed out without a reply. */
    failActivate(roomId, message) {
        if (!this.activateThinkingRooms.has(roomId))
            return;
        this.diag("activate-chat: FAIL for " + roomId + " — " + message);
        this.clearActivateTimer(roomId);
        this.activateThinkingRooms.delete(roomId);
        this.emitBrowser({ kind: "activate-error", roomId, message });
        this.emitBrowser({ kind: "state" });
    }
    /** Safety net: if the agent never replies, stop waiting so the button does
     *  not stay disabled forever. */
    static ACTIVATE_REPLY_TIMEOUT_MS = 5 * 60 * 1000;
    activateTimers = new Map();
    armActivateWatchdog(roomId) {
        this.clearActivateTimer(roomId);
        const timer = setTimeout(() => {
            this.activateTimers.delete(roomId);
            this.failActivate(roomId, "激活聊天超时（" + AgentRoomService.ACTIVATE_REPLY_TIMEOUT_MS / 1000 + "s 内未收到本机回复）");
        }, AgentRoomService.ACTIVATE_REPLY_TIMEOUT_MS);
        try {
            timer.unref();
        }
        catch { /* not available in all envs */ }
        this.activateTimers.set(roomId, timer);
    }
    clearActivateTimer(roomId) {
        const timer = this.activateTimers.get(roomId);
        if (timer) {
            clearTimeout(timer);
            this.activateTimers.delete(roomId);
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
            this.diag("activate-chat: own reply landed in " + roomId + " (seq=" + message.seq + ") — thinking done");
            this.clearActivateTimer(roomId);
            this.activateThinkingRooms.delete(roomId);
            this.emitBrowser({ kind: "state" });
        }
    }
    /* --------------------------- listening (监听) -------------------------- */
    /** True while the local agent is listening to this room. */
    isListening(roomId) {
        return this.listeningRooms.has(roomId);
    }
    /** Turn listening on/off for a room. On: catch up immediately. */
    setListening(roomId, on) {
        if (on) {
            this.listeningRooms.add(roomId);
            // Reset the cursor; the sweep initializes it from the current tail on its
            // first pass, so old history never re-triggers a wake.
            this.listenSeen.delete(roomId);
            void this.sweepListening();
        }
        else {
            this.listeningRooms.delete(roomId);
            this.listenPending.delete(roomId);
            this.listenSeen.delete(roomId);
        }
        this.emitBrowser({ kind: "state" });
    }
    /**
     * 监听扫描（省钱三层里的第 1 层，0 token）:
     * 对每个监听房间拉最近消息, 用规则过滤出「值得叫醒 agent」的消息:
     *   - 人类发言 → 必醒（远程指挥通道）
     *   - @了我 / 疑似问题(？?吗呢谁能有没有怎么办帮) → 醒
     *   - 自己的消息、闲聊、系统通知 → 忽略
     * 同一 seq 只处理一次（listenSeen 去重）。
     */
    async sweepListening() {
        const identity = this.roomService.getIdentity();
        if (!identity)
            return;
        for (const roomId of [...this.listeningRooms]) {
            if (this.listenPending.has(roomId))
                continue;
            try {
                const recent = await this.recentMessagesFor(roomId, 20);
                if (recent.length === 0)
                    continue;
                const lastSeq = recent[recent.length - 1].seq;
                const seen = this.listenSeen.get(roomId);
                if (seen === undefined) {
                    // First sweep for this room: start from the current tail and process
                    // nothing — history must never re-trigger a wake.
                    this.listenSeen.set(roomId, lastSeq);
                    continue;
                }
                const fresh = recent.filter((m) => m.seq > seen);
                this.listenSeen.set(roomId, lastSeq);
                if (fresh.length === 0)
                    continue;
                const target = this.pickListenTarget(fresh, identity);
                if (!target)
                    continue;
                this.listenPending.add(roomId);
                void this.runListenWake(roomId, identity, target);
            }
            catch (error) {
                this.diag("listening: sweep error for " + roomId + " — " + String(error));
            }
        }
    }
    /** Rule layer: which of the fresh messages deserves a wake-up. */
    pickListenTarget(fresh, identity) {
        for (let i = fresh.length - 1; i >= 0; i--) {
            const m = fresh[i];
            if (m.from === identity.agentId)
                continue;
            if (m.human)
                return m;
            if ((m.mentions ?? []).includes(identity.agentId))
                return m;
            if (/[？?]|吗|呢|谁能|有没有|能不能|怎么办|帮/.test(m.text))
                return m;
        }
        return undefined;
    }
    /** Wake the resident agent for a message that passed the rule layer. The
     *  prompt tells it to act ONLY when needed — otherwise stay silent (this is
     *  the cheap judge + executor in one call; a separate small-model judge is a
     *  v2 optimization). */
    async runListenWake(roomId, identity, message) {
        const agent = await this.resolveResidentAgent(identity);
        if (!agent) {
            this.diag("listening: no resident agent for " + roomId);
            this.listenPending.delete(roomId);
            return;
        }
        try {
            const owned = this.roomService.getOwnedRoom(roomId);
            const client = this.clients.get(roomId);
            const room = owned ?? client?.snapshot?.room;
            if (!room)
                throw new Error(`房间不存在: ${roomId}`);
            const recent = await this.recentMessagesFor(roomId, 6);
            const prompt = buildListenPrompt({
                roomId,
                title: room.title,
                identity,
                message,
                recent,
            });
            this.diag("listening: waking agent in " + roomId + " (seq=" + message.seq + ", from=" + message.fromNickname + (message.human ? ", human" : "") + ")");
            agent.followup?.(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "plugin", plugin: "dsh-agent-room" } }));
        }
        catch (error) {
            this.diag("listening: wake failed for " + roomId + " — " + String(error));
        }
        finally {
            // Re-arm after a generous window so later messages can wake again.
            const timer = setTimeout(() => this.listenPending.delete(roomId), 60_000);
            try {
                timer.unref();
            }
            catch { /* ignore */ }
        }
    }
    async boot() {
        this.relayConfigFile = join(this.config.dataDir, "relay-config.json");
        await this.loadRelayConfig();
        this.replyAgentFile = join(this.config.dataDir, "reply-agent.json");
        this.persistedReplyAgentId = await this.loadReplyAgentId();
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
        // Listening sweep: rule-layer scan of listening rooms, wake the agent only
        // when a message needs it (0-token unless something actually needs a reply).
        this.listenTimer = setInterval(() => void this.sweepListening(), 30_000);
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
                listening: this.listeningRooms.has(room.roomId),
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
    lines.push(`你在房间「${input.title}」（roomId: ${input.roomId}）中被手动激活聊天，请基于房间上下文自然回复一条相关内容。`);
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
        lines.push(`最近消息（3 条）：`);
        for (const m of input.recent.slice(0, 3)) {
            const human = m.human ? " [人类]" : "";
            const mention = m.mentions && m.mentions.length > 0 ? ` @[${m.mentions.join(",")}]` : "";
            lines.push(`- ${m.fromNickname}${human}: ${m.text}${mention}`);
        }
    }
    else {
        lines.push("房间还没有消息。");
    }
    lines.push("请用 room_send 工具向该房间发送一条与上下文相关、自然简短的中文回复（可引用之前的聊天、任务或 @提及成员）。");
    lines.push(sendFallbackLine(input.roomId));
    return lines.join("\n");
}
/* --------------------------- listening prompt --------------------------- */
/**
 * Build the wake prompt for the listening flow. Unlike activate-chat this must
 * NOT force a reply: the agent is asked to judge whether the message needs it,
 * and stay completely silent (no tool calls) when it does not. This is the
 * cheap-judge + executor combined; a separate small-model judge is a v2 option
 * if the real token burn ever gets high.
 */
function buildListenPrompt(input) {
    const m = input.message;
    const kind = m.human ? "人类发言（最高优先级）" : (m.mentions ?? []).includes(input.identity.agentId) ? "有人 @了你" : "疑似提问";
    const lines = [];
    lines.push(`你在房间「${input.title}」（roomId: ${input.roomId}）的监听中收到一条需要关注的消息（${kind}）。`);
    lines.push(`消息：${m.fromNickname} 说：「${m.text.slice(0, 500)}」`);
    lines.push(`你的身份：${input.identity.nickname}（agentId: ${input.identity.agentId}）。`);
    const ctx = input.recent.slice(-6);
    if (ctx.length > 0) {
        lines.push("最近对话（上下文）：");
        for (const r of ctx)
            lines.push(`- ${r.fromNickname}${r.human ? " [人类]" : ""}: ${r.text.slice(0, 120)}`);
    }
    lines.push("请判断这条消息是否需要你回应或处理：");
    lines.push("- 需要：用 room_send 工具自然、简短地回复；如果是要办事（比如统计、查数据、建任务），先回复认领再动手。");
    lines.push(sendFallbackLine(input.roomId));
    lines.push("- 不需要（闲聊、已经解决、与你无关）：不要调用任何工具，保持沉默即可。");
    return lines.join("\n");
}
/** Fallback instruction when room_send is not available in the session:
 *  reply through the local web API via pwsh (always present). */
function sendFallbackLine(roomId) {
    return (`如果没有 room_send 工具，改用 pwsh 执行 PowerShell 发送回复：` +
        `Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3080/agent-room-api/rooms/${roomId}/chat' ` +
        `-ContentType 'application/json; charset=utf-8' -Body (@{ text = '你的回复'; human = $false } | ConvertTo-Json)。`);
}
