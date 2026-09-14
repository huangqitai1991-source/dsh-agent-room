/**
 * dsh-agent-room — AgentRoomService (Cordis Service).
 *
 * Wires the pure domain logic into DSH: persistent identity, owned-room
 * authoritative state (RoomService), remote-room membership (RoomClients),
 * the RoomGateway facade used by tools and the browser API, and a lazily
 * started PeerServer for owned rooms.
 */
import { writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { Service } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { RoomService } from "./room-service.js";
import { PeerServer, isControlFrame } from "./peer-server.js";
import { LanDiscovery } from "./discovery.js";
import { RoomClient } from "./room-client.js";
import { OutboundHub, OWNER_CONFIRM_WAIT_MS, toDeliveryStatus } from "./outbound.js";
import { DeliveryDedupe, MAX_DEDUPE_ROOMS, MAX_DEDUPE_SEQS_PER_ROOM } from "./dedupe.js";
import { DEFAULT_PORT } from "./protocol.js";
import { assertValidNickname, clearRefusedMarker, ensureBackupRoot, failLoud, IdentityNotReadyError, readJsonConfig } from "./safety.js";
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
/**
 * How long a joined-room record pointing somewhere other than the configured
 * relay survives before boot-time pruning. Anything older is a leftover from the
 * direct-LAN era: unroutable from another network, but still retried on boot.
 */
const STALE_JOINED_RECORD_MS = 24 * 60 * 60 * 1000;
/**
 * Bounded backoff before an auto-rejoin gives up on a room.
 *
 * Attempt 1 happens at boot; attempts 2 and 3 follow after 15s and 30s. Online
 * but briefly unreachable owners recover inside this window, so the record is
 * kept. A join that was REJECTED (room closed/gone) does not wait at all — see
 * classifyJoinFailure.
 */
const REJOIN_BACKOFF_MS = 15_000;
const REJOIN_MAX_ATTEMPTS = 3;
export function classifyJoinFailure(message) {
    if (isStaleRoomError(message))
        return "stale";
    // RoomClient prefixes every HTTP/relay refusal with "join rejected: <code>";
    // relay auth refusals say "auth rejected". Timeouts and refused connections
    // ("连接超时", "中继连接中断", ECONNREFUSED) deliberately do NOT match.
    if (/join rejected|auth rejected/i.test(message))
        return "rejected";
    return "transient";
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
    /**
     * Pending outbound control frames for joined rooms, keyed by roomId.
     *
     * OWNED BY THE SERVICE ON PURPOSE. Putting the queue on the socket (or on the
     * RoomClient instance, or behind a captured gateway reference) means a
     * reconnect that replaces the socket orphans every pending frame — exactly the
     * silent loss this queue exists to prevent.
     */
    outbound = new OutboundHub();
    /**
     * Delivery-level dedupe for inbound chat frames (0.1.39): one `(roomId, seq)`
     * is processed once at the single emission point below. Bounded by design
     * (4096 seqs/room, 128 rooms) — see src/host/dedupe.ts for the measurement
     * behind those two numbers and for why the counters are numeric-only.
     */
    dedupe = new DeliveryDedupe(MAX_DEDUPE_SEQS_PER_ROOM, MAX_DEDUPE_ROOMS, (message) => this.warnRateLimited("dedupe-rooms", message));
    /** Rate-limited warning bookkeeping: key -> last time it was logged. */
    warnAt = new Map();
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
        // THE SINGLE browser emission point for chat frames (0.1.39).
        //
        // Before 0.1.39 an inbound joined-room frame reached the browser TWICE: the
        // RoomClient `chat` handler pushed it directly AND re-injected it on this bus,
        // where this listener pushed the same object again (measured live on 0.1.37/
        // 0.1.38 three times: one frame, two SSE events, same millisecond; seq
        // 2335/2359/2368 each n=2). The control-frame filter existed on the direct
        // path only, so `[org:*]` frames — work orders, filtered from the HTTP read
        // view since 0.1.31 — still leaked one push into the browser list, and
        // `noteOwnReply` ran twice per frame. The direct emit is gone; both the guard
        // and the dedupe now live here, on the one path every frame traverses.
        //
        // Owned rooms only ever came through this listener, so their behaviour is
        // unchanged except that they too stop leaking control frames (measured: the
        // owner side pushed them once).
        this.roomService.on("chat", (roomId, message) => {
            this.ctx.logger?.info?.("[agent-room] chat in %s from %s", roomId, message.from);
            // Delivery-level dedupe: the same (roomId, seq) is processed once — no
            // browser push AND no noteOwnReply for a repeat. Counters only; a per-hit
            // log line is what grew an audit file to 411 MB once already.
            if (this.dedupe.seen(roomId, message.seq))
                return;
            // Control frames (`[org:`) are work orders, not chat, and are filtered from
            // the read view by design (0.1.31+). The browser push IS the read view — the
            // UI appends a pushed message straight into the visible list — so they must
            // not be pushed. Everything else below still runs: this bus is how
            // agent-org's exec plane sees inbound frames, and it needs every frame
            // including the control ones.
            if (!isControlFrame(message.text))
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
            // boot is fire-and-forget, but a rejection here used to escape during the
            // load phase and DSH turned it into a fatal load failure (the "hang").
            //
            // 0.1.38: a console warning is NOT an acceptable outcome for a damaged
            // config. Swallowing the rejection left the process alive with the whole
            // room host dead (boot() throws before ensurePeerServer/LAN/profileTimer),
            // so the machine looked healthy on 3080 while serving no room at all.
            // Re-throwing hands the failure to the host's fatal path
            // (`installFailLoud`: "dsh: fatal load failure: <stack>" + exit 1), which
            // disposes the half-built fiber first — strictly better than process.exit.
            void this.boot().catch((error) => failLoud("[agent-room]", error, this.ctx.logger));
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
    /* ------------------------- outbound queue (joined) ------------------------- */
    /**
     * Deliver whatever is queued for a joined room, called whenever its channel
     * becomes usable again (open after join, open after reconnect).
     *
     * The queue itself is per-room service state, so it survives the socket swap
     * that a reconnect performs.
     */
    flushOutQueue(roomId, reason) {
        const client = this.clients.get(roomId);
        if (!client)
            return;
        const queue = this.outbound.peek(roomId);
        if (!queue || queue.length === 0)
            return;
        const outcome = this.outbound.flush(roomId, client);
        if (outcome.delivered > 0) {
            this.ctx.logger?.info?.("[agent-room] flushed %d queued control frame(s) for %s (%s, %d still pending)", outcome.delivered, roomId, reason, outcome.remaining);
        }
        if (outcome.stopped) {
            this.warnRateLimited("flush:" + roomId, `[agent-room] queued flush for ${roomId} stopped after ${outcome.delivered} frame(s); ${outcome.remaining} still pending (channel closed again)`);
        }
    }
    /** One warning per key per minute; a dead channel must not flood the log. */
    warnRateLimited(key, message, windowMs = 60_000) {
        const now = Date.now();
        if (now - (this.warnAt.get(key) ?? 0) < windowMs)
            return;
        this.warnAt.set(key, now);
        try {
            console.warn(message);
        }
        catch {
            /* logging must never throw */
        }
        try {
            this.ctx.logger?.warn?.(message);
        }
        catch {
            /* ignore */
        }
    }
    /**
     * Addresses of this node's own room server, normalised for comparison.
     *
     * Used to recognise a "joined" record that actually points back at ourselves —
     * the self-join that delivered every frame twice (and grew one machine's audit
     * log to 923 MB).
     *
     * 0.1.37 REGRESSION FIX: this used to call `lanCandidates()`, which is the
     * JOIN-CANDIDATE helper — it merges the manual address and, decisively, every
     * address seen in LAN beacons, i.e. OTHER NODES' addresses (`lanCandidates`
     * is documented as "addresses seen in LAN beacons -> this node's own interface
     * candidates"). Feeding it here made every remote owner whose beacon we had
     * ever discovered look like "this machine", so `joinRoom` refused a legitimate
     * join with 不能通过本机自己的地址加入房间（self-join）: the node 主控 (own
     * interfaces .204/Tailscale/MEmu only) was locked out of 小婷's room at
     * 192.168.31.82:9317 — the owner's address, taken straight from its beacon.
     *
     * The predicate must ONLY ever contain addresses that are unambiguously ours:
     * our own listening address, loopback on our port, and our own interfaces from
     * `networkInterfaces()` (`peerServer.candidates` = hostCandidates(port), which
     * cannot report a peer).
     */
    ownAddresses() {
        const addresses = new Set();
        const add = (value) => {
            const normalised = normaliseAddress(value);
            if (normalised)
                addresses.add(normalised);
        };
        add(this.peerServer?.address);
        add(`127.0.0.1:${this.config.port}`);
        add(`localhost:${this.config.port}`);
        // OWN INTERFACES ONLY — never `lanCandidates()`, never beacon addresses.
        for (const candidate of this.peerServer?.candidates ?? [])
            add(candidate);
        return addresses;
    }
    /**
     * Drop one joined-room record and nothing else.
     *
     * Local cleanup is always possible, which is why leave is best-effort: a room
     * whose owner is gone can never be reached to say goodbye, and refusing to
     * forget it locally is what left the node retrying a closed room forever.
     */
    async forgetJoinedRoom(roomId, reason) {
        let removed = false;
        try {
            removed = await this.roomService.removeJoinedRoom(roomId);
        }
        catch (error) {
            this.warnRateLimited("forget:" + roomId, `[agent-room] failed to remove joined record ${roomId}: ${String(error)}`);
            return false;
        }
        if (removed)
            this.ctx.logger?.info?.("[agent-room] dropped joined record %s (%s)", roomId, reason);
        return removed;
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
        // Helper: agents.get() cannot find GUI sessions (session-*), so fall back
        // to searching list()/roots() by id/sessionId.
        const findById = (want) => {
            try {
                const direct = agents?.get?.(want);
                if (direct)
                    return direct;
            }
            catch { /* ignore */ }
            try {
                return agents?.list?.()?.find((x) => (x.id ?? x.sessionId) === want);
            }
            catch { /* ignore */ }
            try {
                return agents?.roots?.()?.find((x) => (x.id ?? x.sessionId) === want);
            }
            catch { /* ignore */ }
            return undefined;
        };
        if (this.config.replyAgentId) {
            const a = usable(findById(this.config.replyAgentId));
            if (a) {
                this.diag("activate-chat: resident agent via config override (id=" + (a.id ?? a.sessionId ?? "unknown") + ")");
                return a;
            }
        }
        // 1a. auto-detect the boss's active session: the session whose transcript is
        // most recently written under <DSH_HOME>/sessions/<workspace-of-cwd>.
        // This follows the boss's conversation even when the session id rotates.
        {
            const activeId = this.detectActiveSessionId();
            if (activeId) {
                const a = usable(findById(activeId));
                if (a) {
                    this.diag("activate-chat: resident agent via active-session detection (id=" + (a.id ?? a.sessionId ?? "unknown") + ")");
                    return a;
                }
            }
            // Diagnostic: dump the registry + detection so we can see what's reachable.
            try {
                const listIds = agents?.list?.()?.map((x) => x.id ?? x.sessionId ?? "?") ?? [];
                const rootIds = agents?.roots?.()?.map((x) => x.id ?? x.sessionId ?? "?") ?? [];
                this.diag("activate-chat: registry dump — detected=" + (activeId ?? "none") + " list=[" + listIds.join(", ") + "] roots=[" + rootIds.join(", ") + "]");
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
            const a = usable(findById(this.persistedReplyAgentId));
            if (a) {
                this.diag("activate-chat: resident agent via persisted choice (id=" + (a.id ?? a.sessionId ?? "unknown") + ")");
                return a;
            }
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
    /**
     * Which reply agent was remembered (0.1.38).
     *
     * MISSING -> undefined (fall back to auto-selection, unchanged).
     * PRESENT but unparseable -> CorruptConfigError, quarantined first. Previously
     * a BOM'd file silently fell back to auto-selection and the next save wrote
     * over the original.
     */
    async loadReplyAgentId() {
        if (!this.replyAgentFile)
            return undefined;
        const parsed = await readJsonConfig(this.replyAgentFile);
        if (!parsed)
            return undefined;
        return typeof parsed.replyAgentId === "string" && parsed.replyAgentId ? parsed.replyAgentId : undefined;
    }
    saveReplyAgentId(agent) {
        const id = agent.id ?? agent.sessionId;
        if (!id || !this.replyAgentFile)
            return;
        this.persistedReplyAgentId = id;
        void writeFile(this.replyAgentFile, JSON.stringify({ replyAgentId: id }, null, 2), "utf8").catch(() => { });
    }
    /**
     * Find the boss's active conversation: the session under
     * <DSH_HOME>/sessions/<workspace-of-cwd> whose transcript was most recently
     * written. The session id rotates when the boss starts new chats, so pinning
     * an id is fragile — following the freshest transcript is the robust signal.
     */
    detectActiveSessionId() {
        try {
            const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
            const root = join(dshHome, "sessions");
            // Workspace session dirs encode the path (verified against the on-disk
            // layout): drive colon is DROPPED, backslash -> "-", and any char outside
            // [A-Za-z0-9_.-] becomes "~" + 4-hex UTF-16 code unit.
            //   "D:\dsh"            -> "--D-dsh--"
            //   "D:\dsh\ITPM\数创港项目" -> "--D-dsh-ITPM-~6570~521B~6E2F~9879~76EE--"
            const encode = (s) => s
                .replace(/:/g, "")
                .replace(/[\\/]/g, "-")
                .replace(/[^\w.\-~]/g, (c) => "~" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"));
            const wsName = "--" + encode(process.cwd()) + "--";
            const dir = join(root, wsName);
            const pickFreshest = (base) => {
                let best;
                let bestTime = 0;
                for (const entry of readdirSync(base, { withFileTypes: true })) {
                    if (!entry.isDirectory())
                        continue;
                    try {
                        const st = statSync(join(base, entry.name, "session.jsonl.zstd"));
                        if (st.mtimeMs > bestTime) {
                            bestTime = st.mtimeMs;
                            best = entry.name;
                        }
                    }
                    catch {
                        /* session without a transcript yet — skip */
                    }
                }
                return best;
            };
            const detail = "cwd=" + process.cwd() + " ws=" + wsName + " dir=" + existsSync(dir);
            // 1. primary: the workspace dir matching this process's cwd
            if (existsSync(dir)) {
                const best = pickFreshest(dir);
                if (best) {
                    this.diag("active-session: " + best + " (" + detail + ")");
                    return best;
                }
            }
            // 2. fallback: cwd can differ from the boss's workspace (e.g. the web was
            // started from another directory). Scan EVERY workspace dir under
            // <DSH_HOME>/sessions and pick the globally freshest session-* transcript.
            // Prefix filter keeps out spawned helpers (agent-room-duty-*, kanban tasks).
            let globalBest;
            let globalTime = 0;
            for (const ws of readdirSync(root, { withFileTypes: true })) {
                if (!ws.isDirectory())
                    continue;
                const base = join(root, ws.name);
                for (const entry of readdirSync(base, { withFileTypes: true })) {
                    if (!entry.isDirectory() || !entry.name.startsWith("session-"))
                        continue;
                    try {
                        const st = statSync(join(base, entry.name, "session.jsonl.zstd"));
                        if (st.mtimeMs > globalTime) {
                            globalTime = st.mtimeMs;
                            globalBest = entry.name;
                        }
                    }
                    catch {
                        /* skip */
                    }
                }
            }
            if (globalBest) {
                this.diag("active-session: " + globalBest + " (global fallback, " + detail + ")");
                return globalBest;
            }
            this.diag("active-session: none (" + detail + ")");
            return undefined;
        }
        catch (err) {
            this.diag("active-session: error " + (err instanceof Error ? err.message : String(err)));
            return undefined;
        }
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
                const target = this.pickListenTarget(fresh);
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
    /** Rule layer: only human speech (human:true, typed in the web "以人类身份
     *  发言" input) wakes the agent — the remote-command channel. Agent messages
     *  (including questions/@mentions) never trigger, keeping it quiet and cheap. */
    pickListenTarget(fresh) {
        for (let i = fresh.length - 1; i >= 0; i--) {
            if (fresh[i].human)
                return fresh[i];
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
        // 0.1.38 (G2): resolve + prove the backup/quarantine root before anything is
        // read or written. A root this platform cannot resolve must stop the node
        // here, loudly, instead of failing every later identity write.
        await ensureBackupRoot();
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
        if (caps.size > 0) {
            // 0.1.38: saveIdentity can now legitimately REFUSE (an unparseable
            // identity.json is never overwritten, and a write may not proceed without a
            // verified backup). Auto-collected capabilities are cosmetic enrichment, so a
            // refusal must not take the node down at boot — the refused write itself is
            // the correct outcome and is logged here.
            try {
                await this.roomService.mergeCapabilities([...caps]);
            }
            catch (error) {
                this.ctx.logger?.warn?.("[agent-room] capability merge not persisted: %s", String(error));
            }
        }
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
        // Restore membership of rooms we joined before: recreate the client so
        // inbound sync/exec/task frames flow again without a manual re-join.
        void this.autoRejoinJoinedRooms();
        // 0.1.38 (G4): we reached the end of boot, so this node really is up. Only
        // the plugin can make that claim — the watchdog merely READS the marker, so a
        // repaired machine is started again by itself without anyone deleting a file.
        await clearRefusedMarker(this.config.dataDir);
    }
    /**
     * Persist a joined-room record — unless it is a SELF-JOIN.
     *
     * A node that records a join to its own room delivers every frame twice: the
     * room's own broadcast plus the looped-back member copy (field evidence: the
     * same exec id twice within 1ms, and one machine's audit log at 923 MB). The
     * room is served by this node, so the record carries no information worth
     * keeping — drop it, including any older copy already on disk.
     */
    async recordJoinedRecord(record) {
        if (!record?.roomId)
            return;
        if (this.roomService.getOwnedRoom(record.roomId)) {
            this.warnRateLimited("selfjoin:" + record.roomId, `[agent-room] refusing to record a join to our own room ${record.roomId} (self-join would deliver every frame twice)`);
            await this.forgetJoinedRoom(record.roomId, "room is owned by this node (self-join)");
            return;
        }
        if (this.ownAddresses().has(normaliseAddress(record.address))) {
            this.warnRateLimited("selfaddr:" + record.roomId, `[agent-room] refusing to record a join to our own address ${record.address} for room ${record.roomId} (self-join)`);
            await this.forgetJoinedRoom(record.roomId, "record points at this node's own address (self-join)");
            return;
        }
        await this.roomService.recordVisited(record.roomId, record.address, record.title);
    }
    /**
     * Reconnect to every room recorded in joined.json (idempotent).
     *
     * Records are pruned only for reasons that are actually knowable:
     *  - the room is owned by this node (self-join — see recordJoinedRecord);
     *  - the address is one of this node's own (self-join);
     *  - a legacy record pointing somewhere other than the configured relay and
     *    untouched for a day (unroutable from another network anyway).
     *
     * Everything else is retried, and staleness is decided by the JOIN RESULT:
     * the old predicate (`relay && record.address !== relay`) could never hold for
     * a dead relay-hosted room — its address IS the relay — so such a room was
     * retried forever. rejoinWithRetry now drops the record when the owner answers
     * "room-not-found/closed" and after bounded backoff when it rejects.
     */
    autoRejoinJoinedRooms() {
        const relay = this.config.relay?.replace(/\/+$/, "");
        const own = this.ownAddresses();
        const keep = [];
        let dropped = 0;
        for (const record of this.roomService.listJoinedRooms()) {
            if (!record?.roomId || !record?.address) {
                dropped += 1;
                continue;
            }
            if (this.roomService.getOwnedRoom(record.roomId)) {
                dropped += 1;
                this.warnRateLimited("boot-selfjoin:" + record.roomId, `[agent-room] pruning joined record ${record.roomId}: this node owns that room (self-join)`);
                continue;
            }
            if (own.has(normaliseAddress(record.address))) {
                dropped += 1;
                this.warnRateLimited("boot-selfaddr:" + record.roomId, `[agent-room] pruning joined record ${record.roomId}: ${record.address} is this node's own address (self-join)`);
                continue;
            }
            if (relay && normaliseAddress(record.address) !== normaliseAddress(relay)) {
                const seen = Date.parse(record.lastVisitedAt ?? "") || 0;
                if (Date.now() - seen > STALE_JOINED_RECORD_MS) {
                    dropped += 1;
                    continue;
                }
            }
            keep.push(record);
        }
        if (dropped > 0) {
            void this.roomService.replaceJoinedRooms(keep).then(() => {
                this.ctx.logger?.info?.("[agent-room] pruned %d stale joined room record(s), kept %d", dropped, keep.length);
            });
        }
        for (const record of keep) {
            void this.rejoinWithRetry(record.roomId, record.address, 0);
        }
    }
    /**
     * Best-effort rejoin with bounded backoff; manual join is still the override.
     *
     * The record is dropped once the join RESULT proves the room is unusable:
     * immediately for room-not-found/closed, and after the attempts are exhausted
     * for a refusal (wrong password / full / revoked) that no amount of retrying
     * will clear. A transient failure (owner offline) keeps the record.
     */
    async rejoinWithRetry(roomId, address, attempt) {
        if (this.clients.has(roomId))
            return; // already connected (manual join won the race)
        const maxAttempts = REJOIN_MAX_ATTEMPTS;
        try {
            await this.gateway.joinRoom([address], { roomId });
            this.ctx.logger?.info?.("[agent-room] auto-rejoined room %s at %s", roomId, address);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const kind = classifyJoinFailure(message);
            if (kind === "stale") {
                // Definitively gone: retrying is what pinned a node to a closed room.
                await this.forgetJoinedRoom(roomId, `join rejected: ${message}`);
                return;
            }
            // An offline peer is normal (someone simply switched a machine off), so warn
            // once per room and keep the rest at debug instead of flooding the log.
            if (attempt === 0) {
                this.ctx.logger?.warn?.("[agent-room] auto-rejoin failed for %s at %s: %s", roomId, address, message);
            }
            else {
                this.ctx.logger?.debug?.("[agent-room] auto-rejoin retry %d for %s: %s", attempt + 1, roomId, message);
            }
            if (attempt + 1 < maxAttempts) {
                setTimeout(() => void this.rejoinWithRetry(roomId, address, attempt + 1), REJOIN_BACKOFF_MS * (attempt + 1));
                return;
            }
            if (kind === "rejected") {
                await this.forgetJoinedRoom(roomId, `join refused after ${maxAttempts} attempts: ${message}`);
                return;
            }
            this.ctx.logger?.info?.("[agent-room] gave up auto-rejoining %s after %d attempts (owner likely offline)", roomId, maxAttempts);
        }
    }
    /** Broadcast our current identity to every joined room (nickname/capabilities). */
    async syncProfile() {
        await this.fanOutProfile();
    }
    /**
     * Push the cached profile to every joined room RIGHT NOW (0.1.40).
     *
     * The 15s `profileTimer` (armed in boot) is unchanged and still the periodic
     * path — this is the same body, callable on demand, so a rename does not have to
     * wait up to one tick to reach a room owner (card-01 §2.1: of the three
     * `sendProfile` call sites, only the timer is tick-driven; a rename must not
     * depend on it). Returns the number of clients whose channel ACCEPTED the frame
     * (a client that throws is skipped, not counted), which is what the rename
     * result reports as `profileFanout`.
     */
    async pushProfileNow() {
        return await this.fanOutProfile();
    }
    /**
     * The single fan-out body, shared by the timer and `pushProfileNow`.
     *
     * It reads the identity CACHE (`getIdentity`), never `ensureIdentity`: a
     * fan-out must not mint an identity, and an empty cache means boot has not
     * finished, which is simply nothing to send.
     */
    async fanOutProfile() {
        if (this.clients.size === 0)
            return 0;
        const identity = this.roomService.getIdentity();
        if (!identity)
            return 0;
        let sent = 0;
        for (const client of this.clients.values()) {
            try {
                client.sendProfile({ nickname: identity.nickname, capabilities: identity.capabilities });
                sent += 1;
            }
            catch { /* non-fatal */ }
        }
        return sent;
    }
    /**
     * THE rename entry point (0.1.40) — one call, three stores.
     *
     * Card-01's defect: no supported entry point existed, so a nickname could only
     * be changed by editing `identity.json` by hand. That is invisible to the
     * running process (the identity object is cached and never re-read), and the
     * next save rewrites the file from the cache — the hand fix is silently
     * reverted. This method mutates the cached object in place (through
     * `updateProfile`) and then fans out, so a rename needs NO restart.
     *
     * Order, and why:
     *   1. validate (G1) BEFORE anything is touched -> a rejected name changes
     *      nothing anywhere;
     *   2. require the identity CACHE to exist. NOT `ensureIdentity()` /
     *      `gateway.identity()`: those mint (and write) a fresh identity when the
     *      cache is empty, which for a rename is the worst possible side effect;
     *   3. `updateProfile` -> writes store A (with the verified pre-write backup
     *      that `saveIdentity` already takes) and mutates the SAME object the
     *      RoomClients and the fan-out read;
     *   4. fan out immediately to joined rooms (store B, remote owners) and update
     *      this node's own member rows in the rooms it owns (store B, local);
     *   5. ask agent-org to rename this machine's node (store C) through
     *      `ctx.get("agentOrg")` — resolved AT CALL TIME, because agent-org loads
     *      after agent-room and would be undefined during our own start-up. A
     *      missing/refusing org is REPORTED, never silently skipped.
     */
    async renameSelf(nickname) {
        const wanted = assertValidNickname(nickname);
        const cached = this.roomService.getIdentity();
        if (!cached)
            throw new IdentityNotReadyError();
        const previous = cached.nickname;
        // Store A, plus the in-place mutation of the object every reader shares.
        const identity = await this.roomService.updateProfile({ nickname: wanted });
        // Store B, immediately: joined rooms get the frame now, not on the next tick.
        const profileFanout = await this.pushProfileNow();
        // ...and the rooms THIS node owns, whose member list is served from here.
        let ownedRoomMembers = 0;
        for (const room of this.roomService.listOwnedRooms()) {
            if (!room.members.some((m) => m.agentId === identity.agentId))
                continue;
            this.roomService.updateMemberProfile(room.roomId, identity.agentId, { nickname: identity.nickname });
            ownedRoomMembers += 1;
        }
        // @-mention hazard (card-01 §4.3). `room-service` resolves a mention by
        // nickname and THROWS `ambiguous-member` when two members share one, so a
        // rename onto a name another member already uses breaks mention parsing in
        // that room. Reported, not refused: refusing would make the one supported
        // rename entry point fail because of a room the caller may not even be
        // thinking about, and the damage class this release exists to fix is a name
        // that cannot be changed at all.
        const conflicts = [];
        const collect = (roomId, members) => {
            const wanted = identity.nickname.toLowerCase();
            const clashes = members
                .filter((m) => m.agentId !== identity.agentId && (m.nickname ?? "").toLowerCase() === wanted)
                .map((m) => m.agentId);
            if (clashes.length > 0)
                conflicts.push({ roomId, agentIds: clashes });
        };
        for (const room of this.roomService.listOwnedRooms())
            collect(room.roomId, room.members);
        for (const [roomId, client] of this.clients) {
            const members = client.snapshot?.room?.members;
            if (members)
                collect(roomId, members);
        }
        // Store C: the organisation tree. Cross-plugin, in-process, no HTTP.
        const org = this.ctx.get("agentOrg");
        let orgResult;
        if (!org || typeof org.renameSelfByAgentId !== "function") {
            orgResult = {
                attempted: false,
                updated: false,
                reason: 'agent-org 服务不可用（ctx.get("agentOrg") 未返回带 renameSelfByAgentId 的服务）：' +
                    "A/B 已改，C 未改",
            };
        }
        else {
            try {
                const out = await org.renameSelfByAgentId(identity.agentId, identity.nickname);
                orgResult = { attempted: true, updated: true, nodeId: out?.nodeId, rev: out?.rev };
            }
            catch (error) {
                orgResult = {
                    attempted: true,
                    updated: false,
                    reason: `${String(error?.message ?? error)}（A/B 已改，C 未改：` +
                        "非 org owner 的机器需由 org owner 执行，见 docs/RELEASE-0.1.40.md）",
                };
            }
        }
        // The local UI reads /state and the members feed. The per-room member update
        // above already emitted `members` through the room-service bus (forwarded to
        // the browser by the listener in the constructor), so only the identity-wide
        // refresh has to be nudged here.
        this.emitBrowser({ kind: "state" });
        return {
            agentId: identity.agentId,
            previousNickname: previous,
            nickname: identity.nickname,
            changed: previous !== identity.nickname,
            identityFile: join(this.config.dataDir, "identity.json"),
            profileFanout,
            ownedRoomMembers,
            nicknameConflicts: conflicts,
            org: orgResult,
        };
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
        // NOT a plain getter: this is the SECOND minting entry point, and agent-org
        // reaches it on every snapshot (dsh-agent-org/src/host/service.js
        // `this.agentRoom?.gateway?.identity?.()`). Since 0.1.38 a damaged
        // identity.json makes this THROW CorruptConfigError instead of minting, so
        // closing boot() alone is no longer sufficient to leave this path safe.
        identity: () => this.roomService.ensureIdentity(),
        // 0.1.40: the ONE supported rename entry point. Deliberately NOT built on
        // `identity()` above, which mints a fresh identity when the cache is empty.
        renameSelf: (nickname) => this.renameSelf(nickname),
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
                onJoinedRecord: (record) => this.recordJoinedRecord(record),
            });
            try {
                await client.connect();
            }
            catch (error) {
                // Never leave an unregistered client behind: the service only tracks it
                // further down, so its close handler would otherwise keep reconnecting
                // in the background with nobody able to stop it.
                client.destroy();
                throw error;
            }
            const roomId = client.currentRoomId;
            if (!roomId) {
                client.destroy();
                throw new Error("加入失败：未获得房间 id");
            }
            /**
             * SELF-JOIN REFUSAL (0.1.36) — the live-client half of the 0.1.34 fix.
             *
             * 0.1.34 stopped a self-join from being RECORDED (`recordJoinedRecord`), but
             * that runs from the client's `onJoinedRecord` callback after the handshake
             * already succeeded, so the socket it refused to remember stayed open. A node
             * holding a live client on a room it serves re-receives every frame it
             * broadcasts, re-emits it on the local bus, and PeerServer broadcasts it
             * again — a store-free cycle that delivered one send 3638 times in 195 ms
             * (measured on 0.1.35, with the owner's store still holding a single row).
             *
             * The room id is the reliable predicate (address matching is only a
             * backstop: a room's published address may be any of this node's NICs). The
             * check happens BEFORE the client is wired into the service, so nothing else
             * needs undoing.
             */
            if (this.roomService.getOwnedRoom(roomId)) {
                client.destroy();
                this.warnRateLimited("selfjoin-live:" + roomId, `[agent-room] refusing to join ${roomId}: this node serves that room (self-join would re-broadcast every frame back into the room)`);
                throw new Error(`不能加入本机自己托管的房间（self-join）: ${roomId}`);
            }
            if (this.ownAddresses().has(normaliseAddress(client.address))) {
                client.destroy();
                this.warnRateLimited("selfaddr-live:" + roomId, `[agent-room] refusing to join ${roomId} at ${client.address}: that is this node's own address (self-join)`);
                throw new Error(`不能通过本机自己的地址加入房间（self-join）: ${client.address}`);
            }
            // Replacing a client must not LEAK the old one (0.1.36): `clients.set` used
            // to overwrite silently, and every leaked client keeps its socket, its
            // `chat` handler and its sync loop — one more delivery of every frame.
            const previous = this.clients.get(roomId);
            if (previous && previous !== client) {
                try {
                    previous.destroy();
                }
                catch {
                    /* best effort: the replacement must still go through */
                }
                this.warnRateLimited("rejoin-replace:" + roomId, `[agent-room] replacing the live client for ${roomId} (a second join leaked the previous one before 0.1.36)`);
            }
            client.on("chat", (message) => {
                // 0.1.39: this handler no longer emits to the browser and no longer calls
                // noteOwnReply — the re-injection below reaches the single emission point
                // (the roomService bus listener), which owns the control-frame filter, the
                // `(roomId, seq)` dedupe and the thinking-state update. Emitting here too
                // is exactly what delivered every inbound frame twice, byte-identical and
                // in the same millisecond, while filtering control frames on this path
                // only.
                //
                // Re-broadcast remote-room messages to the local roomService bus so
                // subscribers (agent-org sync / remote exec) see inbound frames too. This
                // clause must stay: it is the exec plane's only inbound source, control
                // frames included.
                this.roomService.emit("chat", roomId, message);
            });
            client.on("task", (task) => {
                this.emitBrowser({ kind: "task", roomId, task });
                this.roomService.emit("task", roomId, task);
            });
            client.on("system", (event) => {
                this.emitBrowser({ kind: "system", roomId, event });
                this.roomService.emit("system", roomId, event);
            });
            client.on("connection", (state) => {
                this.connInfo.set(roomId, { state, viaRelay: client.viaRelay, address: client.address });
                this.emitBrowser({ kind: "connection", roomId, state });
                // Channel usable again: drain whatever the queue held while it was not.
                if (state === "open")
                    this.flushOutQueue(roomId, "connection-open");
            });
            client.on("snapshot", () => {
                this.emitBrowser({ kind: "state" });
                // A fresh snapshot means the handshake finished — the socket is open even
                // when the "connection" event raced ahead of us.
                this.flushOutQueue(roomId, "snapshot");
            });
            this.connInfo.set(roomId, { state: client.connState, viaRelay: client.viaRelay, address: client.address });
            this.clients.set(roomId, client);
            this.flushOutQueue(roomId, "joined");
            this.ctx.logger?.info?.("[agent-room] joined room %s at %s", roomId, client.address);
            return { roomId, title: client.snapshot?.room.title ?? "" };
        },
        leaveRoom: async (roomId) => {
            if (this.roomService.getOwnedRoom(roomId)) {
                await this.roomService.closeRoom(roomId);
                return;
            }
            const client = this.clients.get(roomId);
            let remoteError;
            if (client) {
                try {
                    await client.leave();
                }
                catch (error) {
                    // Best-effort: the owner may be gone, or the socket may never have
                    // opened. That must not stop local cleanup (0.1.34).
                    remoteError = error instanceof Error ? error.message : String(error);
                }
                this.clients.delete(roomId);
                this.connInfo.delete(roomId);
                // Ring state for a room we no longer belong to is dead weight (same
                // reasoning as the outbound queue drop below).
                this.dedupe.forget(roomId);
            }
            // Pending frames for a room we are leaving are moot; drop them instead of
            // replaying them into a room we no longer belong to.
            this.outbound.drop(roomId);
            // Leaving must ALWAYS forget the record locally. It used to throw
            // "房间不存在" (HTTP 500) when there was no live client — which is exactly
            // the dead-room case the user was trying to clean up.
            const removed = await this.forgetJoinedRoom(roomId, remoteError ? `leave failed: ${remoteError}` : "left");
            if (remoteError) {
                this.warnRateLimited("leave:" + roomId, `[agent-room] remote leave of ${roomId} failed (${remoteError}); local record removed=${removed}`);
            }
            if (!client && !removed)
                throw new Error(`房间不存在: ${roomId}`);
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
            // Joined room: NOT an authoritative write, so the honest answer is a
            // delivery status. This used to be `client.sendChat(input); return null;`
            // — no confirmation at all, so a frame dropped on a socket that was not
            // OPEN was indistinguishable from success and the sender never retried.
            const outcome = this.outbound.send(roomId, input, client);
            const status = toDeliveryStatus(outcome);
            // 0.1.35: accepted-by-local-hub is NOT delivery. Wait a bounded time for the
            // owner to echo the message back with its own seq; only that echo proves the
            // owner has it. Field data showed three frames reported "delivered" while
            // the owner never stored them, and three others that did arrive — the sender
            // had no way to tell which case it was in. Now it does.
            if (status.acceptedByLocalHub && typeof client.awaitOwnerEcho === "function") {
                const seq = await client.awaitOwnerEcho(input.text, OWNER_CONFIRM_WAIT_MS);
                if (typeof seq === "number" && seq > 0) {
                    status.confirmedByOwner = true;
                    status.confirmedSeq = seq;
                    status.confirmNote = "owner-confirmed";
                }
                else {
                    status.confirmedByOwner = false;
                    status.confirmNote = "not-confirmed-in-time";
                    this.warnRateLimited("unconfirmed:" + roomId, `[agent-room] room ${roomId}: message accepted by the local hub but NOT confirmed by the owner ` +
                        `within ${OWNER_CONFIRM_WAIT_MS}ms (channel=${client.connState}${client.viaRelay ? ", via relay" : ""}) — ` +
                        "it may never have reached the room");
                }
            }
            if (outcome.delivered)
                return status;
            if (outcome.queued) {
                this.warnRateLimited("queued:" + roomId, `[agent-room] channel for ${roomId} is not open: queued control frame (${outcome.queueLength} pending)`);
            }
            else if (outcome.reason?.startsWith("queue-full")) {
                // The queue refused the NEW frame on purpose: the oldest in-flight
                // control frame is never dropped, so this one has to be reported and
                // retried by the caller instead.
                this.warnRateLimited("queuefull:" + roomId, `[agent-room] control-frame queue for ${roomId} is full (${outcome.reason}): NEW frame REJECTED, retry later`);
            }
            else {
                this.warnRateLimited("dropped:" + roomId, `[agent-room] channel for ${roomId} is not open: chat frame dropped (not queueable) — reported to the sender`);
            }
            return status;
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
    /**
     * Load the persisted relay address (0.1.38).
     *
     * MISSING -> first run, nothing persisted (unchanged). PRESENT but unparseable
     * -> CorruptConfigError. A BOM here used to mean the relay address silently
     * vanished and the node dropped off every relayed room with no diagnostic.
     */
    async loadRelayConfig() {
        const data = await readJsonConfig(this.relayConfigFile);
        if (data) {
            // A persisted file wins over config/env so the UI change survives restarts.
            this.config.relay = typeof data.relay === "string" && data.relay.trim() ? data.relay : undefined;
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
    /**
     * Direct-LAN addresses to offer the join path when switching to "lan", best-first.
     *
     * The join API accepts multiple candidates and tries them in order, so a
     * superset is safe: a candidate that does not answer costs one timeout, not a
     * failure. That is exactly what makes this switch survivable when the
     * advertised address belongs to a virtual adapter (192.168.137.1) that no
     * other machine can reach.
     *
     * Order: manual address -> addresses seen in LAN beacons -> this node's own
     * interface candidates.
     */
    lanCandidates(manual) {
        const out = [];
        // A ws:// entry is the relay, never a direct candidate — handing one to a
        // "lan" join would silently land the room back on the relay.
        const push = (value) => {
            if (typeof value !== "string")
                return;
            const trimmed = value.trim();
            if (trimmed && !/^wss?:\/\//i.test(trimmed))
                out.push(trimmed);
        };
        push(manual);
        // Beacons are loosely typed on purpose: older nodes advertise `address`,
        // current ones `addresses[]`, and a v1 beacon must not break the switch.
        for (const beacon of (this.discovery?.discovered() ?? [])) {
            push(beacon["address"]);
            const list = beacon["addresses"];
            if (Array.isArray(list))
                for (const item of list)
                    push(item);
        }
        for (const candidate of this.peerServer?.candidates ?? [])
            push(candidate);
        return [...new Set(out)];
    }
    /**
     * One-click switch between the relay and direct-LAN connection mode.
     *
     * BOTH halves must happen in the same server-side call: writing relay-config
     * alone leaves a mixed state where some rooms are direct and others still
     * relay (observed in the field — the node dropped every ~14s), so every
     * joined room is re-joined with addresses matching the new mode. Owned rooms
     * are skipped: this node serves them, and their bridge follows relay-config.
     *
     * Note for future work: the relay config is currently a bare address because
     * the relay is our own and needs no credentials. Supporting third-party
     * relays would extend it to { address, account?, token? } — not implemented
     * here on purpose.
     */
    async setConnectionMode(mode, manualAddress) {
        const relayUrl = (this.config.relay ?? "").trim();
        if (mode === "relay" && !relayUrl) {
            throw new Error("未配置中继地址，无法切换到中继：请先填写中继地址");
        }
        const relay = await this.setRelayConfig(mode === "relay" ? relayUrl : "");
        const addresses = mode === "relay" ? [relayUrl] : this.lanCandidates(manualAddress);
        if (addresses.length === 0) {
            throw new Error("没有可用的局域网地址：请手动填写 host:port（例如 192.168.31.x:9317）后重试");
        }
        const rooms = [];
        // Records we must keep in joined.json. A record whose room is gone is dropped
        // from the list instead of kept-and-retried: it would otherwise report a
        // frightening "join rejected: room-not-found" on every mode switch forever,
        // which reads as a broken switch even though every live room rejoined fine.
        const keepRecords = [];
        let cleanedCount = 0;
        for (const record of this.roomService.listJoinedRooms()) {
            const title = record.title ?? this.clients.get(record.roomId)?.snapshot?.room.title ?? record.roomId;
            if (this.roomService.getOwnedRoom(record.roomId)) {
                keepRecords.push(record);
                continue;
            }
            try {
                await this.gateway.joinRoom(addresses, { roomId: record.roomId });
                keepRecords.push(record);
                rooms.push({ roomId: record.roomId, title, ok: true });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (isStaleRoomError(message)) {
                    // Room closed or never existed: prune the record, count it as cleaned
                    // rather than failed, and let the UI say so.
                    cleanedCount += 1;
                    rooms.push({ roomId: record.roomId, title, ok: true, cleaned: true });
                }
                else {
                    keepRecords.push(record);
                    rooms.push({ roomId: record.roomId, title, ok: false, error: message });
                }
            }
        }
        if (cleanedCount > 0) {
            try {
                await this.roomService.replaceJoinedRooms(keepRecords);
                this.ctx.logger?.info?.("[agent-room] pruned %d closed/absent room record(s) while switching to %s", cleanedCount, mode);
            }
            catch (error) {
                this.ctx.logger?.warn?.("[agent-room] failed to prune stale joined rooms: %s", String(error));
            }
        }
        this.emitBrowser({ kind: "state" });
        const live = rooms.filter((room) => !room.cleaned);
        const okCount = live.filter((room) => room.ok).length;
        this.ctx.logger?.info?.("[agent-room] connection mode -> %s (relay=%s, addresses=%s, rejoined %d/%d, cleaned %d)", mode, relay ?? "(cleared)", addresses.join(", "), okCount, live.length, cleanedCount);
        return { mode, relay, addresses, rooms };
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
            // 0.1.35: prefer the OWNER's reported latest visible seq. Deriving this from
            // our own mirror (as 0.1.34 did) is circular — a mirror that is missing
            // messages reports a smaller number and therefore never shows the lag, which
            // is precisely how the missing-message defect stayed invisible.
            const ownerLatest = client.syncState().ownerLatestChatSeq;
            joinedLatest.set(roomId, ownerLatest > 0 ? ownerLatest : client.localLatestSeq());
        }
        const rooms = [];
        const seenRooms = new Set();
        for (const room of [...owned, ...joinedRooms]) {
            // A room can be both owned and joined (this node may have joined a room it
            // hosts, e.g. its own sync room through the relay). List it once — the
            // owner's view is the authoritative one.
            if (seenRooms.has(room.roomId))
                continue;
            seenRooms.add(room.roomId);
            const isOwned = room.ownerAgentId === identity.agentId;
            const info = this.connInfo.get(room.roomId);
            // Read the bridge status LIVE. This used to read a cache populated by
            // refreshRelayBridge(), which only runs on boot and on relay-config
            // changes — so the field froze at whatever was true at that instant and
            // reported "connecting" forever on a perfectly healthy bridge. A
            // diagnostic that lies is worse than no diagnostic: it sent an entire
            // outage hunt down the wrong path.
            const bridgeState = isOwned
                ? (this.peerServer?.relayStatus(room.roomId) ?? this.relayBridge.get(room.roomId) ?? "none")
                : info?.state ?? "connecting";
            const bridge = isOwned
                ? { kind: (bridgeState === "none" ? "none" : "relay"), state: bridgeState, address: this.config.relay }
                : { kind: (info?.viaRelay ? "relay" : "direct"), state: info?.state ?? "connecting", address: info?.address ?? room.serverAddress };
            const latestSeq = isOwned
                ? ((await this.roomService.recentMessages(room.roomId, 1))[0]?.seq ?? 0)
                : (joinedLatest.get(room.roomId) ?? 0);
            const client = this.clients.get(room.roomId);
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
                // Convergence diagnostics (0.1.35). For a joined room, `latestSeq` is the
                // owner-reported target and `localLatestSeq` is what this node actually
                // holds: while they differ the room is still catching up, and the panel can
                // say so instead of pretending the mirror is complete.
                localLatestSeq: isOwned ? latestSeq : (client?.localLatestSeq() ?? 0),
                sync: isOwned ? undefined : client?.syncState(),
                bridge,
            });
        }
        const discovered = this.discovery?.discovered() ?? [];
        return {
            identity,
            node: { hostname: hostname(), addresses: this.peerServer?.candidates ?? [] },
            relay: { address: this.config.relay, configured: this.relayConfigured },
            discovered,
            // Delivery-level dedupe diagnostics (0.1.39). `skipped` alone is not
            // enough: `evicted` growing alongside repeat deliveries is what says "the
            // ring is too small", and `roomResets` says the room cap was hit.
            dedupe: this.dedupe.stats(),
            rooms,
        };
    }
    /**
     * Recent messages for one room (owned via store, joined via local projection).
     *
     * The joined projection already MERGES the owner's confirmed stream with the
     * messages this node appended locally (RoomClient.appendLocal): the confirmed
     * ones carry real seqs, the local ones are `pending` with a negative seq. That
     * is what lets a sender see its own message — and, once the owner echoes it,
     * its seq — without rejoining, and lets a member read the owner's recent
     * messages without rejoining either.
     */
    async browserMessages(roomId, limit = 200, before) {
        const owned = this.roomService.getOwnedRoom(roomId);
        if (owned)
            return this.roomService.recentMessages(roomId, limit, before);
        const client = this.clients.get(roomId);
        const all = client?.snapshot?.recentMessages ?? [];
        // Paging into history must not resurface local messages: their negative seq
        // would sort below every real one and they are the tail, not the past.
        const filtered = before === undefined
            ? all
            : all.filter((m) => !m.pending && m.seq < before);
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
    const kind = "人类发言（远程指挥，最高优先级）";
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
/* --------------------------- stale joined records --------------------------- */
/**
 * Does this join error mean the recorded room no longer exists (closed or
 * deleted) rather than a transient network problem?
 *
 * Only these are treated as stale. A timeout, a refused connection or a wrong
 * password must NOT prune the record — the room may be perfectly alive and we
 * would be silently forgetting it. Both the protocol codes and the Chinese
 * messages carry the signal, depending on whether the failure came from a remote
 * owner (protocol code) or the local server (thrown message).
 */
export function isStaleRoomError(message) {
    return /room-not-found|room-closed|房间不存在|房间已关闭|room not found|room closed/i.test(message);
}
/**
 * Normalise an address for equality comparisons.
 *
 * Joined records store either a direct `host:port` or a relay URL
 * (`ws://host:port`), so "is this address me?" must ignore the scheme, any path
 * and trailing slashes — otherwise a self-join slips through and every frame is
 * delivered twice.
 */
export function normaliseAddress(value) {
    if (typeof value !== "string")
        return "";
    let text = value.trim().toLowerCase();
    if (!text)
        return "";
    text = text.replace(/^[a-z]+:\/\//, "");
    text = text.replace(/\/+$/, "");
    const pathIndex = text.indexOf("/");
    if (pathIndex >= 0)
        text = text.slice(0, pathIndex);
    return text;
}
