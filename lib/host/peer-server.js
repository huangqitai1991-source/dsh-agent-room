/**
 * dsh-agent-room — PeerServer.
 *
 * The room server hosted by the owner node: HTTP handshake endpoints plus a
 * WebSocket channel for real-time frames. One PeerServer serves all rooms this
 * node owns. Broadcasts are driven by RoomService events.
 */
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { frameError, HEARTBEAT_INTERVAL_MS, MAX_MESSAGE_LENGTH, } from "./protocol.js";
const MAX_BODY = 64 * 1024;
export class PeerServer {
    port;
    service;
    relayAddress;
    httpServer = null;
    wsServer = null;
    sockets = new Map();
    /** roomId -> this node's outbound "owner" connection to the relay. */
    relaySockets = new Map();
    heartbeat = null;
    constructor(options) {
        this.port = options.port;
        this.service = options.service;
        this.relayAddress = options.relay;
        // Forward service events to member sockets.
        this.service.on("chat", (roomId, message) => this.broadcast(roomId, { type: "chat.message", payload: message }));
        this.service.on("task", (roomId, task) => this.broadcast(roomId, { type: "task.event", payload: { task } }));
        this.service.on("taskRemoved", (roomId, taskId) => this.broadcast(roomId, { type: "task.removed", payload: { taskId } }));
        this.service.on("system", (roomId, event) => this.broadcast(roomId, { type: "system.event", payload: event }));
        this.service.on("members", (roomId) => {
            const room = this.service.getOwnedRoom(roomId);
            if (room)
                this.broadcast(roomId, { type: "members", payload: { members: room.members } });
        });
        // Revocation closes the member's live sockets immediately.
        this.service.on("revoked", (roomId, agentId) => {
            for (const [socket, meta] of this.sockets) {
                if (meta.roomId === roomId && meta.agentId === agentId) {
                    try {
                        socket.close(4003, "revoked");
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
        });
        // Room lifecycle drives the relay bridge: bridge open rooms, drop closed ones.
        this.service.on("roomState", (roomId, status) => {
            if (this.relayAddress) {
                if (status === "open")
                    this.connectRelay(roomId);
                else
                    this.disconnectRelay(roomId);
            }
        });
    }
    get address() {
        return `${pickLanAddress()}:${this.port}`;
    }
    /** Every shareable address (host:port) on this node, best guess first. */
    get candidates() {
        return hostCandidates(this.port);
    }
    async start() {
        if (this.httpServer)
            return this.address;
        const httpServer = createServer((req, res) => void this.handleHttp(req, res));
        await new Promise((resolve, reject) => {
            httpServer.once("error", reject);
            httpServer.listen(this.port, () => resolve());
        });
        this.httpServer = httpServer;
        const wsServer = new WebSocketServer({ server: httpServer, path: "/ws" });
        wsServer.on("connection", (socket, req) => this.handleConnection(socket, req));
        this.wsServer = wsServer;
        this.heartbeat = setInterval(() => {
            for (const socket of this.sockets.keys()) {
                if (socket.readyState !== WebSocket.OPEN)
                    continue;
                try {
                    socket.ping();
                }
                catch {
                    socket.terminate();
                }
            }
        }, HEARTBEAT_INTERVAL_MS);
        // Bridge existing owned rooms to the relay (rooms created later are bridged
        // via the roomState event handler).
        if (this.relayAddress) {
            for (const room of this.service.listOwnedRooms()) {
                if (room.status === "open")
                    this.connectRelay(room.roomId);
            }
        }
        return this.address;
    }
    async stop() {
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        for (const socket of this.sockets.keys()) {
            try {
                socket.close(1001, "server stopping");
            }
            catch {
                /* ignore */
            }
        }
        this.sockets.clear();
        this.wsServer?.close();
        this.wsServer = null;
        if (this.httpServer) {
            const server = this.httpServer;
            this.httpServer = null;
            await new Promise((resolve) => server.close(() => resolve()));
        }
    }
    /* ------------------------------ HTTP -------------------------------- */
    async handleHttp(req, res) {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        try {
            if (req.method === "GET" && url.pathname === "/api/status") {
                return this.json(res, 200, this.statusPayload());
            }
            if (req.method === "GET" && url.pathname === "/dist/latest.tgz") {
                return this.serveLatestTarball(res);
            }
            if (req.method === "POST" && url.pathname === "/api/join") {
                const body = (await readJsonBody(req));
                return this.json(res, 200, await this.handleJoin(body));
            }
            return this.json(res, 404, { ok: false, error: "not-found" });
        }
        catch (err) {
            return this.json(res, 500, { ok: false, error: err.message });
        }
    }
    statusPayload() {
        const identity = this.service.getIdentity();
        return {
            node: { nickname: identity?.nickname ?? "unknown", hasIdentity: identity !== null },
            rooms: this.service.listOwnedRooms().map((room) => ({
                roomId: room.roomId,
                title: room.title,
                type: room.type,
                authMode: room.settings.authMode,
                memberCount: room.members.length,
                status: room.status,
            })),
        };
    }
    async handleJoin(body) {
        if (!body?.agent?.agentId)
            return { ok: false, error: "room-not-found" };
        const identity = body.agent;
        const roomId = body.roomId ?? this.service.listOwnedRooms()[0]?.roomId;
        if (!roomId)
            return { ok: false, error: "room-not-found" };
        try {
            const result = this.service.joinOwnedRoom(roomId, identity, { password: body.password });
            return {
                ok: true,
                token: result.token,
                snapshot: await this.snapshotFor(roomId),
            };
        }
        catch (err) {
            const code = err.code ?? "room-not-found";
            const map = {
                "room-not-found": "room-not-found",
                "room-closed": "room-closed",
                "wrong-password": "wrong-password",
                "room-full": "room-full",
                "already-member": "already-member",
                "revoked": "revoked",
            };
            return { ok: false, error: map[code] ?? "room-not-found" };
        }
    }
    async snapshotFor(roomId) {
        const room = this.service.getOwnedRoom(roomId);
        if (!room)
            throw new Error("room-not-found");
        const recentMessages = await this.service.recentMessages(roomId, 200);
        return { room, recentMessages };
    }
    json(res, status, payload) {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
    }
    /** Serve this plugin's distributable tarball, so peers can `curl` the latest build. */
    async serveLatestTarball(res) {
        try {
            const here = fileURLToPath(import.meta.url);
            const pkgRoot = dirname(dirname(dirname(here)));
            const names = await readdir(pkgRoot);
            const tgz = names.find((n) => n.startsWith("dsh-agent-room-") && n.endsWith(".tgz"));
            if (!tgz)
                throw new Error("no tarball");
            const data = await readFile(join(pkgRoot, tgz));
            res.writeHead(200, {
                "content-type": "application/gzip",
                "content-length": data.length,
                "content-disposition": `attachment; filename=${tgz}`,
            });
            res.end(data);
        }
        catch {
            res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "tarball not found on this node" }));
        }
    }
    /* ------------------------------ WS ----------------------------------- */
    handleConnection(socket, req) {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const roomId = url.searchParams.get("roomId");
        const token = url.searchParams.get("token");
        const agentId = url.searchParams.get("agentId");
        if (!roomId || !token || !agentId || !this.service.validateToken(roomId, agentId, token)) {
            socket.close(4001, "unauthorized");
            return;
        }
        this.sockets.set(socket, { roomId, agentId });
        socket.on("message", (data) => void this.handleFrame(socket, String(data)));
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => this.sockets.delete(socket));
        // Send initial snapshot.
        void this.snapshotFor(roomId)
            .then((snapshot) => {
            const frame = { type: "room.snapshot", payload: snapshot };
            this.send(socket, frame);
        })
            .catch(() => socket.close(4002, "room-unavailable"));
    }
    async handleFrame(socket, raw) {
        const meta = this.sockets.get(socket);
        if (!meta)
            return;
        let frame;
        try {
            frame = JSON.parse(raw);
        }
        catch {
            this.send(socket, frameError("invalid-frame"));
            return;
        }
        // Direct sockets close themselves on leave; relay members close their own
        // relay connection after the ack (handled inside handleFrameFrom).
        if (frame.type === "room.leave") {
            await this.service.removeMember(meta.roomId, meta.agentId);
            socket.close(1000, "left");
            return;
        }
        await this.handleFrameFrom(meta.roomId, meta.agentId, frame, (f) => this.send(socket, f));
    }
    /**
     * Process a client frame with an explicit (roomId, agentId) — the transport
     * may be a direct socket or a relay bridge. `respond` delivers replies (errors,
     * join results) back to that member over the right transport.
     */
    async handleFrameFrom(roomId, agentId, frame, respond) {
        // Join handshake over a relay: no HTTP reachability, so the owner performs
        // the join here and replies with the token + snapshot.
        if (frame.type === "relay.join") {
            const payload = frame.payload;
            if (!payload?.agent?.agentId) {
                respond({ type: "relay.joined", payload: { ok: false, error: "missing agent identity" } });
                return;
            }
            try {
                const result = this.service.joinOwnedRoom(roomId, payload.agent, { password: payload.password });
                const snapshot = await this.snapshotFor(roomId);
                respond({ type: "relay.joined", payload: { ok: true, token: result.token, snapshot } });
            }
            catch (err) {
                respond({ type: "relay.joined", payload: { ok: false, error: err.message } });
            }
            return;
        }
        const identity = this.memberIdentity(roomId, agentId);
        if (!identity) {
            respond(frameError("not-member"));
            return;
        }
        try {
            switch (frame.type) {
                case "hello":
                    return;
                case "chat.send": {
                    const { text, replyTo, mentions, human } = frame.payload;
                    if (text.length > MAX_MESSAGE_LENGTH)
                        throw new Error("message-too-long");
                    await this.service.addChatMessage(roomId, identity, { text, replyTo, mentions, human });
                    return;
                }
                case "task.create":
                    this.service.createTask(roomId, identity, frame.payload);
                    return;
                case "task.assign":
                    this.service.assignTask(roomId, identity, frame.payload.taskId, frame.payload.assignee);
                    return;
                case "task.claim":
                    this.service.claimTask(roomId, identity, frame.payload.taskId);
                    return;
                case "task.comment":
                    this.service.commentTask(roomId, identity, frame.payload.taskId, frame.payload.text);
                    return;
                case "task.status":
                    this.service.setTaskStatus(roomId, identity, frame.payload.taskId, frame.payload.status);
                    return;
                case "task.complete":
                    this.service.completeTask(roomId, identity, frame.payload.taskId, frame.payload.note);
                    return;
                case "task.handoff":
                    this.service.setTaskHandoff(roomId, identity, frame.payload.taskId, frame.payload.handoff);
                    return;
                case "task.approve":
                    this.service.approveTask(roomId, identity, frame.payload.taskId, frame.payload.note);
                    return;
                case "task.reject":
                    this.service.rejectTask(roomId, identity, frame.payload.taskId, frame.payload.note);
                    return;
                case "task.reopen":
                    this.service.reopenTask(roomId, identity, frame.payload.taskId);
                    return;
                case "task.remove":
                case "task.delete":
                    this.service.deleteTask(roomId, identity, frame.payload.taskId);
                    return;
                case "member.profile":
                    this.service.updateMemberProfile(roomId, agentId, frame.payload);
                    return;
                case "room.leave":
                    await this.service.removeMember(roomId, agentId);
                    respond({ type: "ack", payload: { seq: 0, ok: true } });
                    return;
                default:
                    respond(frameError("unknown-frame-type"));
            }
        }
        catch (err) {
            respond(frameError(err.message));
        }
    }
    /* ------------------------- relay bridge ------------------------------ */
    /** Connect (or reconnect) this node to the relay as the owner of `roomId`. */
    connectRelay(roomId) {
        if (!this.relayAddress)
            return;
        const existing = this.relaySockets.get(roomId);
        if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING))
            return;
        const agentId = this.service.getIdentity()?.agentId ?? "owner";
        const base = this.relayAddress.replace(/\/+$/, "");
        const url = `${base}/relay?roomId=${encodeURIComponent(roomId)}&role=owner&agentId=${encodeURIComponent(agentId)}`;
        let socket;
        try {
            socket = new WebSocket(url);
        }
        catch {
            return;
        }
        this.relaySockets.set(roomId, socket);
        socket.on("open", () => {
            this.log(`[agent-room] relay bridge open for ${roomId}`);
        });
        socket.on("message", (data) => {
            let msg;
            try {
                msg = JSON.parse(String(data));
            }
            catch {
                return;
            }
            const m = msg;
            if (m.type === "relay.frame" && m.from && m.frame) {
                void this.handleFrameFrom(roomId, m.from, m.frame, (f) => this.sendRelay(roomId, m.from, f));
            }
        });
        socket.on("close", () => {
            if (this.relaySockets.get(roomId) === socket) {
                this.relaySockets.delete(roomId);
                // Keep trying while the room is still open and the relay is configured.
                setTimeout(() => {
                    if (this.relayAddress && this.service.getOwnedRoom(roomId)?.status === "open")
                        this.connectRelay(roomId);
                }, 5000);
            }
        });
        socket.on("error", () => { });
    }
    disconnectRelay(roomId) {
        const socket = this.relaySockets.get(roomId);
        if (socket) {
            this.relaySockets.delete(roomId);
            try {
                socket.close(1000, "room closed");
            }
            catch {
                /* ignore */
            }
        }
    }
    /** Deliver a server frame to one member through the relay (targeted). */
    sendRelay(roomId, toAgentId, frame) {
        const relay = this.relaySockets.get(roomId);
        if (relay?.readyState === WebSocket.OPEN) {
            relay.send(JSON.stringify({ type: "relay.send", to: toAgentId, frame }));
        }
    }
    log(message) {
        // The peer server has no cordis logger; keep relay diagnostics on stderr.
        console.error(message);
    }
    memberIdentity(roomId, agentId) {
        const room = this.service.getOwnedRoom(roomId);
        const member = room?.members.find((m) => m.agentId === agentId);
        if (!member)
            return null;
        return { agentId: member.agentId, nickname: member.nickname, capabilities: member.capabilities ?? [], createdAt: member.joinedAt };
    }
    broadcast(roomId, frame) {
        for (const [socket, meta] of this.sockets) {
            if (meta.roomId === roomId)
                this.send(socket, frame);
        }
        // Relay bridge: the relay fans the raw frame out to remote members.
        const relay = this.relaySockets.get(roomId);
        if (relay?.readyState === WebSocket.OPEN) {
            relay.send(JSON.stringify(frame));
        }
    }
    send(socket, frame) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(frame));
        }
    }
}
/** Interface names that indicate a virtual adapter, never a real LAN. */
const VIRTUAL_INTERFACE = /virtual|vmware|virtualbox|vbox|hyper-v|hyperv|memu|nox|leidian|tailscale|wireguard|zerotier|docker|wsl|vethernet|utun|\bppp\b|loopback/i;
/** All non-internal IPv4 addresses on this node, with their interface name. */
function lanAddressCandidates() {
    const ifaces = networkInterfaces();
    const out = [];
    for (const [name, entries] of Object.entries(ifaces)) {
        for (const entry of entries ?? []) {
            if (entry.family === "IPv4" && !entry.internal && entry.address)
                out.push({ address: entry.address, name });
        }
    }
    return out;
}
/** True for RFC1918 private LAN ranges (192.168/16, 10/8, 172.16-31/12). */
function isPrivateLan(address) {
    const parts = address.split(".");
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (a === 10)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    if (a === 192 && b === 168)
        return true;
    return false;
}
/** Candidates ordered best-first: real interfaces first, LAN ranges preferred,
 *  then real non-LAN, then virtual adapters (Tailscale, emulators) — those are
 *  still usable (Tailscale gives cross-network direct links), just not first. */
function orderedCandidates() {
    const all = lanAddressCandidates();
    if (all.length === 0)
        return [];
    const real = all.filter((candidate) => !VIRTUAL_INTERFACE.test(candidate.name));
    const pool = real.length > 0 ? real : all;
    const lan = pool.find((candidate) => isPrivateLan(candidate.address));
    const preferred = lan ? [lan, ...pool.filter((candidate) => candidate !== lan)] : pool;
    const virtual = all.filter((candidate) => !preferred.includes(candidate));
    return [...preferred, ...virtual];
}
export function pickLanAddress() {
    const ordered = orderedCandidates();
    if (ordered.length === 0)
        return "127.0.0.1";
    // Prefer a real LAN address; CGNAT/VPN ranges like Tailscale's 100.64.0.0/10
    // are excluded so the shared address works for machines on the same network.
    return ordered[0]?.address ?? "127.0.0.1";
}
/** Ordered host:port candidates for sharing/beacons, best guess first. */
export function hostCandidates(port) {
    return orderedCandidates().map((candidate) => `${candidate.address}:${port}`);
}
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY)
            throw new Error("body-too-large");
        chunks.push(chunk);
    }
    if (chunks.length === 0)
        return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
