/**
 * dsh-agent-room — RoomClient.
 *
 * Member-side connection to a remote room hosted by another node. Handles the
 * HTTP join handshake, the WebSocket channel, local projection state, and
 * reconnection with exponential backoff.
 *
 * As of 0.1.35 it also CONVERGES: the local mirror of a joined room used to be
 * built from one handshake snapshot plus whatever live frames happened to arrive,
 * so a missed frame was lost forever and the member's `latestSeq` (derived from
 * its own incomplete view) could not even reveal it — a human on that machine
 * could not see messages that demonstrably existed on the owner. The client now
 * learns the owner's authoritative seqs, detects holes and lag, and asks for
 * exactly those seq ranges in small bounded batches (src/host/backfill.ts).
 */
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { isControlFrame, reconnectDelay, SYNC_VERSION } from "./protocol.js";
import { BACKFILL_FIRST_DELAY_MS, BACKFILL_POLL_MS, BACKFILL_REQUEST_TIMEOUT_MS, BackfillState, MAX_READ_VIEW_CONFIRMED, localSeqMax, mergeBackfill, } from "./backfill.js";
import { nowIso, uuidv7 } from "./util.js";
/** Per-address handshake timeout before trying the next candidate (LAN: quick). */
const JOIN_ATTEMPT_TIMEOUT_MS = 5_000;
/**
 * Relay handshake budget. A slow or lossy link can legitimately need tens of
 * seconds to move the snapshot frame, so the relay starts generous and grows the
 * budget after each consecutive failure instead of failing fast. Failing fast is
 * what made a healthy-but-slow link look broken and spawn retry storms.
 */
const RELAY_JOIN_TIMEOUT_MS = 20_000;
const RELAY_JOIN_TIMEOUT_MS_MAX = 120_000;
/** One warning per key per minute: a dead channel must not flood the log. */
const WARN_WINDOW_MS = 60_000;
/**
 * How many optimistic local messages to keep while they await confirmation.
 *
 * They exist so a sender sees its own message (and, once the owner echoes it,
 * its real seq) without rejoining. Only the tail is useful — a large backlog of
 * unconfirmed messages is a symptom, not history.
 */
const MAX_LOCAL_PENDING = 50;
export class RoomClient extends EventEmitter {
    /** The address that actually connected (locked in by the handshake). */
    address;
    addresses;
    roomIdHint;
    password;
    agent;
    relayAddress;
    onJoinedRecord;
    token = null;
    roomId = null;
    socket = null;
    left = false;
    usingRelay = false;
    connectionState = "connecting";
    reconnectAttempt = 0;
    heartbeat = null;
    reconnectTimer = null;
    /**
     * True only after a handshake has fully succeeded at least once.
     *
     * Guards against orphan clients: a join that times out closes its socket, and
     * the close handler would otherwise schedule a reconnect. Such a client is
     * never registered by the service (joinRoom throws before tracking it), so
     * nothing could ever stop it — it would retry forever, and every retry pulls
     * a full room snapshot. Never let a client that never connected revive itself.
     */
    hasConnected = false;
    /** Consecutive relay handshake failures — drives the adaptive timeout. */
    relayFailures = 0;
    /** Rate-limited warning bookkeeping: key -> last time it was logged. */
    warnAt = new Map();
    /** Rate-limited sync log bookkeeping (one line a minute; requests always log). */
    syncLogAt = new Map();
    /**
     * Optimistic local messages awaiting the owner's confirmed copy, oldest first.
     *
     * Keyed by localId; each entry is ALSO present in `snapshot.recentMessages`
     * (that is the read view) until the confirmed frame adopts it and stamps the
     * real seq on it.
     */
    localPending = new Map();
    /** Monotonic negative counter for local seqs — never collides with a real seq. */
    localSeq = 0;
    /** Convergence state for this room (0.1.35). */
    backfill = new BackfillState();
    /** One-shot timer for the next sync attempt (never two at once). */
    syncTimer = null;
    /** Periodic `chat.stat` probe while the channel is open. */
    syncLoop = null;
    /** In a sync round: the request put on the wire (for the timeout + logging). */
    inFlightRange = null;
    /** What is on the wire: a fetch for a seq range, or a bare stat probe. */
    inFlightKind = null;
    /** Failure watchdog for an unanswered sync request, so it can never wedge. */
    inFlightTimer = null;
    /**
     * True once the owner has advertised sync support (0.1.35).
     *
     * An older owner never answers `chat.fetch` / `chat.stat`, so probing it would
     * be pointless traffic at best and a wedged in-flight slot at worst. Without the
     * advertisement a member simply behaves as it did before 0.1.35.
     */
    syncSupported = false;
    /**
     * Outbound sends awaiting the owner's confirmed echo (0.1.35).
     *
     * An accepted write on an OPEN socket is NOT proof the owner stored the
     * message: three frames were observed to vanish between "hub accepted" and the
     * owner's store. The only real proof is the owner echoing the message back with
     * its own seq, so a send registers here and resolves when that echo arrives.
     */
    echoWaiters = [];
    /** Local projection (updated by server frames). */
    snapshot = null;
    constructor(options) {
        super();
        this.addresses = options.addresses.length > 0 ? options.addresses : ["127.0.0.1:0"];
        this.address = this.addresses[0];
        this.roomIdHint = options.roomId;
        this.password = options.password;
        this.agent = options.agent;
        this.relayAddress = options.relay;
        this.onJoinedRecord = options.onJoinedRecord;
    }
    get connected() {
        return this.socket?.readyState === WebSocket.OPEN;
    }
    get currentRoomId() {
        return this.roomId;
    }
    /** True when the channel to the owner goes through the relay (D7). */
    get viaRelay() {
        return this.usingRelay;
    }
    /** Current connection state of the room channel. */
    get connState() {
        return this.connectionState;
    }
    setConnection(state) {
        this.connectionState = state;
        this.emit("connection", state);
    }
    on(event, listener) {
        return super.on(event, listener);
    }
    emit(event, ...args) {
        return super.emit(event, ...args);
    }
    /** Full join flow: direct HTTP handshake first, relay fallback when configured. */
    async connect() {
        this.left = false;
        this.setConnection("connecting");
        if (!this.usingRelay) {
            try {
                const join = await this.httpJoin();
                this.token = join.token;
                this.roomId = join.snapshot.room.roomId;
                this.snapshot = join.snapshot;
                this.hasConnected = true;
                this.emit("snapshot", join.snapshot);
                await this.onJoinedRecord?.({
                    roomId: join.snapshot.room.roomId,
                    address: this.address,
                    title: join.snapshot.room.title,
                    lastVisitedAt: nowIso(),
                });
                this.openSocket();
                return;
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                // A reachable server's rejection (wrong password / revoked / …) is a real
                // answer — do not paper over it with the relay. Only network-level
                // failures fall through to the relay.
                if (!this.relayAddress || message.startsWith("join rejected"))
                    throw err;
                this.usingRelay = true;
            }
        }
        try {
            await this.connectViaRelay();
        }
        catch (err) {
            // Relay path failed too — reset so the NEXT reconnect tries direct again
            // (the direct peer may have recovered while we were stuck on the relay).
            this.usingRelay = false;
            console.warn(`[agent-room] relay connect failed for room ${this.roomIdHint ?? this.roomId ?? "?"}, will retry direct next: ` +
                (err instanceof Error ? err.message : String(err)));
            throw err;
        }
    }
    /** Relay handshake with failure tracking; a success resets the escalation. */
    async connectViaRelay() {
        try {
            await this.relayHandshake();
            this.relayFailures = 0;
        }
        catch (error) {
            this.relayFailures += 1;
            throw error;
        }
    }
    /**
     * Handshake budget for the relay: 20s, doubling per consecutive failure up to
     * 120s. A link that is merely slow earns more room each round instead of being
     * written off as dead.
     */
    relayTimeoutMs() {
        const factor = 2 ** Math.min(this.relayFailures, 3);
        return Math.min(RELAY_JOIN_TIMEOUT_MS * factor, RELAY_JOIN_TIMEOUT_MS_MAX);
    }
    /** Join through the relay: WS to the relay, relay.join -> relay.auth handshake. */
    relayHandshake() {
        const relay = this.relayAddress;
        const targetRoomId = this.roomId ?? this.roomIdHint;
        if (!relay)
            return Promise.reject(new Error("没有可用的连接地址"));
        if (!targetRoomId)
            return Promise.reject(new Error("走中继需要先知道 roomId"));
        return new Promise((resolve, reject) => {
            const base = relay.replace(/\/+$/, "");
            const url = `${base}/relay?roomId=${encodeURIComponent(targetRoomId)}&role=member&agentId=${encodeURIComponent(this.agent.agentId)}`;
            let socket;
            try {
                socket = new WebSocket(url);
            }
            catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
                return;
            }
            this.socket = socket;
            let settled = false;
            const budget = this.relayTimeoutMs();
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                reject(new Error(`中继加入超时: ${relay} (${budget}ms)`));
                try {
                    socket.close(1000, "join timeout");
                }
                catch { /* ignore */ }
            }, budget);
            socket.on("open", () => {
                socket.send(JSON.stringify({ type: "relay.join", payload: { agent: this.agent, password: this.password } }));
            });
            socket.on("message", (data) => {
                const raw = String(data);
                if (settled) {
                    this.handleFrame(raw);
                    return;
                }
                let frame;
                try {
                    frame = JSON.parse(raw);
                }
                catch {
                    return;
                }
                if (frame.type === "relay.joined") {
                    if (frame.payload?.ok && frame.payload.token && frame.payload.ticket && frame.payload.snapshot) {
                        this.token = frame.payload.token;
                        this.roomId = frame.payload.snapshot.room.roomId;
                        this.snapshot = frame.payload.snapshot;
                        socket.send(JSON.stringify({ type: "relay.auth", payload: { ticket: frame.payload.ticket } }));
                    }
                    else {
                        settled = true;
                        clearTimeout(timer);
                        reject(new Error(`join rejected: ${frame.payload?.error ?? "relay join failed"}`));
                        try {
                            socket.close(1000, "join rejected");
                        }
                        catch { /* ignore */ }
                    }
                    return;
                }
                if (frame.type === "relay.authed") {
                    settled = true;
                    clearTimeout(timer);
                    if (frame.payload?.ok) {
                        this.reconnectAttempt = 0;
                        this.hasConnected = true;
                        this.emit("snapshot", this.snapshot);
                        void this.onJoinedRecord?.({
                            roomId: this.roomId,
                            address: relay,
                            title: this.snapshot?.room.title ?? "",
                            lastVisitedAt: nowIso(),
                        });
                        if (this.snapshot)
                            this.noteOwnerSnapshot(this.snapshot);
                        this.scheduleSync(BACKFILL_FIRST_DELAY_MS);
                        this.setConnection("open");
                        resolve();
                    }
                    else {
                        reject(new Error(`relay auth rejected: ${frame.payload?.error ?? "unauthorized"}`));
                        try {
                            socket.close(1000, "auth rejected");
                        }
                        catch { /* ignore */ }
                    }
                }
                // 其它握手期帧忽略
            });
            socket.on("close", () => {
                this.clearHeartbeat();
                this.stopSyncLoop();
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error("中继连接中断"));
                    return;
                }
                if (this.left) {
                    this.setConnection("closed");
                    return;
                }
                this.setConnection("reconnecting");
                this.scheduleReconnect();
            });
            socket.on("error", () => { });
        });
    }
    /**
     * Try each candidate address in order until one completes the HTTP handshake.
     * Connection-level failures (refused/timeout/unreachable) fall through to the
     * next candidate; an HTTP-level rejection (wrong password, room full, …) is a
     * real answer from a reachable server and stops the attempt chain.
     */
    async httpJoin() {
        let lastError = null;
        for (const address of this.addresses) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), JOIN_ATTEMPT_TIMEOUT_MS);
            try {
                const res = await fetch(`http://${address}/api/join`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        roomId: this.roomIdHint,
                        password: this.password,
                        agent: this.agent,
                    }),
                    signal: controller.signal,
                });
                const data = (await res.json());
                if (!data.ok)
                    throw new Error(`join rejected: ${data.error}`);
                // Reachable server answered — lock this address in for the WS channel.
                this.address = address;
                return data;
            }
            catch (err) {
                const error = err;
                if (error.name === "AbortError") {
                    lastError = new Error(`连接超时: ${address}`);
                    continue;
                }
                if (error.message.startsWith("join rejected"))
                    throw error;
                // Network-level failure — try the next candidate.
                lastError = error;
                continue;
            }
            finally {
                clearTimeout(timer);
            }
        }
        throw lastError ?? new Error("没有可用的连接地址");
    }
    openSocket() {
        if (!this.token || !this.roomId)
            return;
        const url = `ws://${this.address}/ws?roomId=${encodeURIComponent(this.roomId)}&token=${encodeURIComponent(this.token)}&agentId=${encodeURIComponent(this.agent.agentId)}`;
        const socket = new WebSocket(url);
        this.socket = socket;
        socket.on("open", () => {
            this.reconnectAttempt = 0;
            this.setConnection("open");
            this.sendFrame({ type: "hello", payload: { token: this.token } });
            // Convergence loop (0.1.35): a fresh channel is exactly when a member is
            // most likely to be behind, and exactly when a naive retry would storm.
            this.backfill.noteReconnect();
            this.scheduleSync(BACKFILL_FIRST_DELAY_MS);
        });
        socket.on("message", (data) => this.handleFrame(String(data)));
        socket.on("close", () => {
            this.clearHeartbeat();
            this.stopSyncLoop();
            if (this.left) {
                this.setConnection("closed");
                return;
            }
            this.setConnection("reconnecting");
            this.scheduleReconnect();
        });
        socket.on("error", () => {
            /* close follows */
        });
    }
    scheduleReconnect() {
        if (this.left || this.reconnectTimer)
            return;
        // A client that never completed a handshake is an orphan: the service threw
        // before registering it, so a self-scheduled retry would run forever with
        // nobody able to cancel it — each attempt costing a full room snapshot.
        if (!this.hasConnected) {
            this.setConnection("closed");
            return;
        }
        const delay = reconnectDelay(this.reconnectAttempt);
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.left)
                return;
            this.setConnection("connecting");
            // Re-run the full handshake (not just openSocket): the owner may have
            // restarted, which invalidates the old token and resets nothing else we
            // can reuse. A fresh join also rebuilds the local snapshot, so the seq
            // dedup stays consistent with the owner's restored history.
            void this.connect().catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                if (message.startsWith("join rejected")) {
                    // Terminal: room is gone/closed/full — no point retrying.
                    //
                    // TERMINAL MUST MEAN TERMINAL (D-18): this branch used to return without
                    // touching `left`, so the socket of the failed attempt closed a moment
                    // later and its close handler called `scheduleReconnect()` again — a new
                    // attempt one second later, rejected again, forever. The service side now
                    // drops the record, but a client that keeps re-dialling a dead room is
                    // exactly the "retries a dead room forever" defect this release closes.
                    this.setConnection("closed");
                    this.emit("joinRejected", this.roomId ?? this.roomIdHint ?? "", message);
                    this.stopRetrying();
                    return;
                }
                this.setConnection("reconnecting");
                this.scheduleReconnect();
            });
        }, delay);
    }
    handleFrame(raw) {
        let frame;
        try {
            frame = JSON.parse(raw);
        }
        catch {
            return;
        }
        switch (frame.type) {
            case "room.snapshot":
                this.snapshot = frame.payload;
                // A reconnect rebuilds the projection from the owner's snapshot, which
                // knows nothing about our optimistic rows. Re-attach the ones that are
                // still unconfirmed so the sender never loses sight of its own message.
                for (const local of this.pendingMessages()) {
                    if (!this.snapshot.recentMessages.some((m) => m.seq === local.seq)) {
                        this.snapshot.recentMessages.push(local);
                    }
                }
                // The owner's authoritative seqs: the ONLY way to notice that this
                // snapshot (bounded, control frames filtered) left holes behind. A
                // pre-0.1.35 owner sends neither field, and the member then simply has no
                // lag signal — the same behaviour as before, never a guess (see
                // planBackfill: ownerLatestChatSeq <= 0 means "no owner signal").
                this.noteOwnerSnapshot(frame.payload);
                this.emit("snapshot", frame.payload);
                this.scheduleSync(BACKFILL_FIRST_DELAY_MS);
                break;
            case "chat.message": {
                const message = frame.payload;
                // Control frames are work orders, not chat: they are filtered from the
                // READ VIEW by design (0.1.31+). They are still emitted below so
                // agent-org's exec plane and the local roomService bus keep seeing them —
                // only the projection a human reads stays clean.
                const control = isControlFrame(message.text);
                const adopted = this.snapshot ? this.adoptPending(message) : null;
                if (adopted) {
                    // A confirmed copy of one of our own optimistic rows adopts it (real
                    // seq, pending cleared) instead of adding a duplicate. The adopted row
                    // is emitted so noteOwnReply/activate-chat still see our own message.
                    if (control)
                        this.dropFromReadView(adopted);
                    this.resolveEchoWaiters(message);
                    this.emit("chat", { ...message, pending: false });
                    break;
                }
                if (this.snapshot && !control) {
                    // Dedup by seq so catch-up replays never double a message.
                    if (!this.snapshot.recentMessages.some((m) => m.seq === message.seq)) {
                        this.snapshot.recentMessages.push(message);
                        this.trimReadView();
                    }
                }
                this.backfill.noteLiveFrame(message.seq, control);
                // A visible frame whose seq jumps leaves a hole behind it: this is the
                // cheapest possible gap signal, and the round it schedules is bounded.
                this.resolveEchoWaiters(message);
                if (!control)
                    this.scheduleSync(0);
                this.emit("chat", message);
                break;
            }
            /**
             * Owner's answer to a sync request (0.1.35): merge, never replace.
             *
             * Duplicates are skipped by seq and locally appended pending rows are left
             * untouched, so this can run at any time without clobbering a sender's own
             * unconfirmed message or double-adding a live frame.
             */
            case "chat.backfill": {
                const payload = frame.payload;
                this.clearInFlight();
                this.backfill.noteOwnerSeqs(payload.latestSeq, payload.latestChatSeq);
                // The owner examined every seq up to `toSeq`; anything it did not return
                // is a control frame or a deleted row, so it must never be asked again.
                this.backfill.noteAnswered(payload.fromSeq, payload.toSeq);
                let added = [];
                let duplicates = 0;
                if (this.snapshot) {
                    const outcome = mergeBackfill(this.snapshot.recentMessages, payload.messages ?? []);
                    this.snapshot.recentMessages = outcome.messages;
                    added = outcome.added;
                    duplicates = outcome.duplicates;
                    for (const message of added)
                        this.emit("chat", message);
                }
                this.backfill.noteMerge(added.length, duplicates);
                this.backfill.noteSettledInFlight();
                this.backfill.trimSettled(this.confirmedSeqs());
                const examined = Math.max(0, (payload.toSeq ?? 0) - (payload.fromSeq ?? 0) + 1);
                if (added.length > 0 || duplicates > 0 || payload.truncated) {
                    this.logSync("sync", `fetched seqs ${payload.fromSeq}-${payload.toSeq} (${examined} seqs examined, ${added.length} new, ` +
                        `${duplicates} already held${payload.truncated ? ", more to come" : ""})`);
                }
                // Progress in the same range: continue promptly. Nothing gained: hold off
                // and let the pacing/backoff rules decide (a settled range with no rows is
                // a control-frame hole, and re-asking it immediately would be a loop).
                this.scheduleSync(added.length > 0 || payload.truncated ? 250 : BACKFILL_POLL_MS);
                break;
            }
            case "chat.stat": {
                this.clearInFlight();
                this.backfill.noteOwnerSeqs(frame.payload.latestSeq, frame.payload.latestChatSeq);
                this.backfill.noteSettledInFlight();
                this.scheduleSync(0);
                break;
            }
            case "task.event": {
                if (this.snapshot) {
                    const idx = this.snapshot.room.tasks.findIndex((t) => t.taskId === frame.payload.task.taskId);
                    if (idx >= 0)
                        this.snapshot.room.tasks[idx] = frame.payload.task;
                    else
                        this.snapshot.room.tasks.push(frame.payload.task);
                }
                this.emit("task", frame.payload.task);
                break;
            }
            case "task.removed":
                if (this.snapshot)
                    this.snapshot.room.tasks = this.snapshot.room.tasks.filter((t) => t.taskId !== frame.payload.taskId);
                break;
            case "members":
                if (this.snapshot)
                    this.snapshot.room.members = frame.payload.members;
                break;
            case "system.event":
                this.emit("system", frame.payload);
                break;
            case "ack":
            case "error":
                break;
        }
    }
    sendChat(input) {
        return this.sendFrame({ type: "chat.send", payload: input });
    }
    /**
     * Append an outgoing message to the local projection immediately.
     *
     * Rationale (0.1.34): the sender used to see nothing at all when the frame was
     * queued or dropped, and the browser UI's own optimistic row was wiped by the
     * next refetch because the host read view had no such message. The local copy
     * carries a NEGATIVE seq (never collides with a real one) and
     * `pending: true`; it is adopted — real seq, pending cleared — when the
     * owner's confirmed frame arrives.
     */
    appendLocal(input) {
        this.localSeq -= 1;
        const localId = uuidv7();
        const message = {
            seq: this.localSeq,
            from: this.agent.agentId,
            fromNickname: this.agent.nickname,
            ts: nowIso(),
            text: input.text,
            replyTo: input.replyTo,
            mentions: input.mentions,
            human: input.human,
            pending: true,
            localId,
        };
        this.localPending.set(localId, message);
        if (this.snapshot)
            this.snapshot.recentMessages.push(message);
        while (this.localPending.size > MAX_LOCAL_PENDING) {
            const oldest = this.localPending.keys().next().value;
            if (oldest === undefined)
                break;
            this.localPending.delete(oldest);
        }
        return message;
    }
    /** Unconfirmed local messages (oldest first). */
    pendingMessages() {
        return [...this.localPending.values()];
    }
    /**
     * Adopt a confirmed frame into a matching local message.
     *
     * Matching is by sender + text, oldest first: the owner echoes messages in the
     * order it accepted them, so the first unconfirmed copy with the same body is
     * the one this frame confirms. Adopting in place (rather than pushing a second
     * row) is what lets a sender see its message AND its real seq without rejoining.
     */
    adoptPending(message) {
        if (typeof message.localId === "string" && message.localId) {
            const local = this.localPending.get(message.localId);
            if (!local)
                return null;
            return this.stampLocal(message.localId, local, message.seq, message.ts);
        }
        for (const [localId, local] of this.localPending) {
            if (local.from !== message.from)
                continue;
            if (local.text !== message.text)
                continue;
            return this.stampLocal(localId, local, message.seq, message.ts);
        }
        return null;
    }
    /** Stamp the confirmed seq onto the local row and stop tracking it. */
    stampLocal(localId, local, seq, ts) {
        this.localPending.delete(localId);
        local.seq = seq;
        local.ts = ts;
        local.pending = false;
        delete local.localId;
        return local;
    }
    /* --------------------------- convergence (0.1.35) ------------------------ */
    /**
     * Adopt an owner snapshot's sync advertisement and seq numbers.
     *
     * A snapshot without `syncVersion`/`latestSeq` comes from a pre-0.1.35 owner:
     * sync stays off, because a member that asks a question the owner cannot answer
     * would only add traffic and a wedged in-flight slot.
     */
    noteOwnerSnapshot(payload) {
        const version = typeof payload.syncVersion === "number" ? payload.syncVersion : 0;
        const hasSeqs = typeof payload.latestSeq === "number" || typeof payload.latestChatSeq === "number";
        if (version >= SYNC_VERSION || hasSeqs)
            this.syncSupported = true;
        this.backfill.noteOwnerSeqs(payload.latestSeq ?? 0, payload.latestChatSeq ?? 0);
        this.backfill.noteReconnect();
        if (this.syncSupported)
            this.startSyncLoop();
    }
    /**
     * Confirmed (non-pending) seqs currently in the read view.
     *
     * Pending rows carry negative seqs and are excluded: they are this node's own
     * unconfirmed sends, not part of the owner's stream.
     */
    confirmedSeqs() {
        const rows = this.snapshot?.recentMessages ?? [];
        const seqs = [];
        for (const message of rows) {
            if (!message || message.pending === true)
                continue;
            if (typeof message.seq === "number" && message.seq > 0)
                seqs.push(message.seq);
        }
        return seqs;
    }
    /** Highest confirmed seq held locally (0 when nothing is held). */
    localLatestSeq() {
        return localSeqMax(this.confirmedSeqs());
    }
    /** Convergence state of this room (browser panel + diagnostics). */
    syncState() {
        const localSeqs = this.confirmedSeqs();
        return {
            ...this.backfill.diagnostics(localSeqs),
            localLatestSeq: localSeqMax(localSeqs),
            connected: this.connected,
        };
    }
    /** Remove one row from the read view by identity (control-frame adoption). */
    dropFromReadView(row) {
        if (!this.snapshot)
            return;
        const next = this.snapshot.recentMessages.filter((message) => message !== row);
        if (next.length !== this.snapshot.recentMessages.length)
            this.snapshot.recentMessages = next;
    }
    /** Keep the read view bounded; backfill may pour history into it. */
    trimReadView() {
        if (!this.snapshot)
            return;
        const rows = this.snapshot.recentMessages;
        const confirmed = rows.filter((message) => !message.pending && message.seq > 0).length;
        if (confirmed <= MAX_READ_VIEW_CONFIRMED)
            return;
        let drop = confirmed - MAX_READ_VIEW_CONFIRMED;
        const kept = [];
        for (const message of rows) {
            if (drop > 0 && !message.pending && message.seq > 0) {
                drop -= 1;
                continue;
            }
            kept.push(message);
        }
        this.snapshot.recentMessages = kept;
    }
    /** Schedule the next sync tick (one timer at a time; 0 = as soon as possible). */
    scheduleSync(delayMs) {
        if (this.left || !this.syncSupported)
            return;
        if (this.syncTimer)
            return;
        this.syncTimer = setTimeout(() => {
            this.syncTimer = null;
            this.syncTick();
        }, Math.max(0, delayMs));
    }
    startSyncLoop() {
        if (this.syncLoop || this.left || !this.syncSupported)
            return;
        this.syncLoop = setInterval(() => {
            // The probe is what lets a member notice it is behind even when it missed
            // the frames that would have told it: without it, a member that silently
            // dropped the whole stream stays behind forever.
            if (!this.connected)
                return;
            if (!this.backfill.canProbe())
                return;
            if (this.backfill.plan(this.confirmedSeqs()).requests.length > 0) {
                this.syncTick();
                return;
            }
            this.backfill.noteProbe();
            if (this.sendFrame({ type: "chat.stat", payload: {} })) {
                this.armInFlightTimeout("stat", null);
            }
            else {
                this.backfill.noteFailure();
            }
        }, BACKFILL_POLL_MS);
    }
    stopSyncLoop() {
        if (this.syncLoop)
            clearInterval(this.syncLoop);
        this.syncLoop = null;
        if (this.syncTimer)
            clearTimeout(this.syncTimer);
        this.syncTimer = null;
        this.clearInFlight();
        // The channel is gone: nothing will answer, so the in-flight slot must not
        // stay occupied (backoff is kept — a flapping owner should not be hammered).
        this.backfill.forgetInFlight();
    }
    /**
     * One bounded convergence round: at most ONE request in flight, at most
     * BACKFILL_MAX_RANGES ranges, each at most BACKFILL_BATCH_SEQS seqs wide.
     *
     * The single-in-flight rule is the floor under the whole design: it makes the
     * request rate a function of the owner's answer rate, so an unavailable or slow
     * owner can never be flooded (the 2026-09-12 incident was 25,346 replayed
     * frames from exactly that kind of missing limit).
     */
    syncTick() {
        if (this.left || !this.connected || !this.snapshot || !this.syncSupported)
            return;
        if (this.inFlightRange || this.inFlightKind)
            return;
        const now = Date.now();
        if (!this.backfill.canRequest(now)) {
            // Pacing (2s floor) or backoff: re-arm the timer instead of dropping the
            // round, otherwise a multi-range catch-up would only advance once per poll.
            const wait = this.backfill.msUntilRequestAllowed(now);
            if (wait > 0)
                this.scheduleSync(wait);
            return;
        }
        const localSeqs = this.confirmedSeqs();
        const plan = this.backfill.plan(localSeqs, now);
        if (plan.requests.length === 0) {
            this.backfill.trimSettled(localSeqs);
            return;
        }
        // Exactly one request per round, so nothing can pile up while the owner is
        // quiet. The reply schedules the next round.
        const range = plan.requests[0];
        this.backfill.noteRequest(range, now);
        if (!this.sendFrame({ type: "chat.fetch", payload: { fromSeq: range.from, toSeq: range.to } })) {
            this.backfill.noteFailure(now);
            return;
        }
        this.armInFlightTimeout("fetch", range);
        this.logSync("sync", `requesting seqs ${range.from}-${range.to} (${plan.reason}, lag=${plan.lag}, gaps=${plan.gaps}, ` +
            `held=${localSeqs.length}, owner latest visible=${this.backfill.ownerLatestChatSeq}, sent=${this.backfill.requestsSent})`);
    }
    /** Fail an unanswered request instead of letting it wedge the loop forever. */
    armInFlightTimeout(kind, range) {
        this.inFlightRange = range;
        this.inFlightKind = kind;
        if (this.inFlightTimer)
            clearTimeout(this.inFlightTimer);
        this.inFlightTimer = setTimeout(() => {
            this.inFlightTimer = null;
            const stuckKind = this.inFlightKind;
            const stuck = this.inFlightRange;
            if (!stuckKind)
                return;
            this.inFlightKind = null;
            this.inFlightRange = null;
            // An unanswered request (or probe) is a failure with the same consequence:
            // exponential backoff, so a silent owner is retired to a 60s cadence instead
            // of being re-asked every round.
            this.backfill.noteFailure();
            const what = stuck ? `seqs ${stuck.from}-${stuck.to}` : "chat.stat";
            this.logSync("warn", `no answer for ${what} within ${BACKFILL_REQUEST_TIMEOUT_MS}ms; backing off ` +
                `(attempt ${this.backfill.failures})`);
        }, BACKFILL_REQUEST_TIMEOUT_MS);
    }
    clearInFlight() {
        this.inFlightRange = null;
        this.inFlightKind = null;
        if (this.inFlightTimer)
            clearTimeout(this.inFlightTimer);
        this.inFlightTimer = null;
    }
    /**
     * Sync logging: each BOUNDED BATCH is the evidence this release is judged on, so
     * requests and their results are logged per batch with a short (5s) window —
     * enough to show what a catch-up did, far too little to flood a log. Warnings
     * keep the standard one-per-minute window.
     */
    logSync(key, message) {
        const now = Date.now();
        const last = this.syncLogAt.get(key) ?? 0;
        const windowMs = key === "warn" ? WARN_WINDOW_MS : 5_000;
        if (now - last < windowMs)
            return;
        this.syncLogAt.set(key, now);
        console.warn(`[agent-room] room ${this.label}: ${message}`);
    }
    /**
     * Wait for the owner's confirmed echo of a message we just sent (0.1.35).
     *
     * The echo is the only honest confirmation: it carries the owner's own seq, so
     * a `null` result means "the local hub accepted it, the owner never showed it
     * back" — which is exactly the failure that used to be invisible.
     */
    awaitOwnerEcho(text, timeoutMs) {
        return new Promise((resolve) => {
            const entry = {
                from: this.agent.agentId,
                text,
                resolve,
                timer: setTimeout(() => {
                    const index = this.echoWaiters.indexOf(entry);
                    if (index >= 0)
                        this.echoWaiters.splice(index, 1);
                    resolve(null);
                }, Math.max(1, timeoutMs)),
            };
            this.echoWaiters.push(entry);
            // Never grow without bound: a dead channel leaves waiters behind only for
            // the length of their own timeout.
            if (this.echoWaiters.length > MAX_LOCAL_PENDING) {
                const dropped = this.echoWaiters.shift();
                if (dropped) {
                    clearTimeout(dropped.timer);
                    dropped.resolve(null);
                }
            }
        });
    }
    /** Resolve the oldest waiter whose own message just came back confirmed. */
    resolveEchoWaiters(message) {
        if (this.echoWaiters.length === 0)
            return;
        const index = this.echoWaiters.findIndex((entry) => entry.from === message.from && entry.text === message.text);
        if (index < 0)
            return;
        const entry = this.echoWaiters[index];
        this.echoWaiters.splice(index, 1);
        clearTimeout(entry.timer);
        entry.resolve(typeof message.seq === "number" ? message.seq : null);
    }
    clearEchoWaiters() {
        for (const entry of this.echoWaiters.splice(0)) {
            clearTimeout(entry.timer);
            entry.resolve(null);
        }
    }
    sendProfile(profile) {
        this.sendFrame({ type: "member.profile", payload: profile });
    }
    taskCreate(payload) {
        this.sendFrame({ type: "task.create", payload });
    }
    taskAssign(taskId, assignee) {
        this.sendFrame({ type: "task.assign", payload: { taskId, assignee } });
    }
    taskClaim(taskId) {
        this.sendFrame({ type: "task.claim", payload: { taskId } });
    }
    taskComment(taskId, text) {
        this.sendFrame({ type: "task.comment", payload: { taskId, text } });
    }
    taskStatus(taskId, status) {
        this.sendFrame({ type: "task.status", payload: { taskId, status } });
    }
    taskComplete(taskId, note) {
        this.sendFrame({ type: "task.complete", payload: { taskId, note } });
    }
    taskHandoff(taskId, handoff) {
        this.sendFrame({ type: "task.handoff", payload: { taskId, handoff } });
    }
    taskApprove(taskId, note) {
        this.sendFrame({ type: "task.approve", payload: { taskId, note } });
    }
    taskReject(taskId, note) {
        this.sendFrame({ type: "task.reject", payload: { taskId, note } });
    }
    taskReopen(taskId) {
        this.sendFrame({ type: "task.reopen", payload: { taskId } });
    }
    taskRemove(taskId) {
        this.sendFrame({ type: "task.remove", payload: { taskId } });
    }
    async leave() {
        this.left = true;
        this.stopSyncLoop();
        this.clearEchoWaiters();
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.sendFrame({ type: "room.leave", payload: {} });
            this.socket.close(1000, "left");
        }
        this.socket = null;
        this.setConnection("closed");
    }
    /**
     * Stop for good after a TERMINAL answer from the owner (D-18).
     *
     * `left` is the flag every retry path already checks (`scheduleReconnect`,
     * `openSocket`, the sync loop, the heartbeat), so setting it is what makes
     * "terminal" actually terminal: without it the close handler of the failed socket
     * re-armed another attempt, and a room that answers `join rejected` was re-dialled
     * once a second for as long as the process lived. Deliberately NOT `leave()`: a
     * terminated client must not send a `room.leave` frame to an owner that has
     * already refused it.
     */
    stopRetrying() {
        this.left = true;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.stopSyncLoop();
        this.clearHeartbeat();
        try {
            this.socket?.close(1000, "rejected");
        }
        catch {
            /* ignore */
        }
        this.socket = null;
        this.setConnection("closed");
    }
    destroy() {
        this.left = true;
        this.stopSyncLoop();
        this.clearEchoWaiters();
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.clearHeartbeat();
        try {
            this.socket?.close(1000, "bye");
        }
        catch {
            /* ignore */
        }
        this.socket = null;
    }
    sendFrame(frame) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            try {
                this.socket.send(JSON.stringify(frame));
                return true;
            }
            catch (error) {
                // A send that throws on an OPEN socket is still a failed delivery — do
                // not report success, or the caller will never retry.
                this.warnRateLimited("send:" + frame.type, `send ${frame.type} failed on an open socket: ${error instanceof Error ? error.message : String(error)}`);
                return false;
            }
        }
        // NO silent drop (0.1.34). Frames used to vanish here with no else branch,
        // which is how a member's message to the owner's room was lost without a
        // trace. Reporting `false` lets the service queue control frames and lets
        // agent-org retry a result frame instead of waiting out its timeout.
        this.warnRateLimited("not-open:" + frame.type, `dropped ${frame.type} frame: socket ${this.socket ? "not OPEN" : "absent"} (room ${this.label})`);
        return false;
    }
    /** Room label for logs before a roomId is known. */
    get label() {
        return this.roomId ?? this.roomIdHint ?? this.address;
    }
    /** Rate-limited console warning (one per key per minute). */
    warnRateLimited(key, message) {
        const now = Date.now();
        const last = this.warnAt.get(key) ?? 0;
        if (now - last < WARN_WINDOW_MS)
            return;
        this.warnAt.set(key, now);
        console.warn(`[agent-room] room ${this.label}: ${message}`);
    }
    clearHeartbeat() {
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        this.heartbeat = null;
    }
}
/** Convenience for tests/scripts: build a dummy agent identity. */
export function buildAgent(agentId = uuidv7(), nickname = "agent", capabilities = []) {
    return { agentId, nickname, capabilities, createdAt: nowIso() };
}
