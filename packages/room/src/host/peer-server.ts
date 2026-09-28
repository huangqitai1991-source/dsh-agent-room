/**
 * dsh-agent-room — PeerServer.
 *
 * The room server hosted by the owner node: HTTP handshake endpoints plus a
 * WebSocket channel for real-time frames. One PeerServer serves all rooms this
 * node owns. Broadcasts are driven by RoomService events.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentIdentity, ChatMessage, RoomSnapshot } from "../types.js";
import { buildRoomStatePayload } from "./room-state.js";
import type { RoomService } from "./room-service.js";
import {
  type ClientFrame,
  type JoinError,
  type JoinRequest,
  type JoinResponse,
  type ServerFrame,
  type StatusResponse,
  frameAck,
  frameError,
  HEARTBEAT_INTERVAL_MS,
  isControlFrame,
  MAX_MESSAGE_LENGTH,
  SYNC_FETCH_MAX_BYTES,
  SYNC_FETCH_MAX_MESSAGES,
  SYNC_FETCH_MAX_SPAN,
  SYNC_VERSION,
} from "./protocol.js";

/**
 * Control-frame classification now lives in protocol.ts (the outbound queue
 * needs it too); re-exported so `import { isControlFrame } from "./peer-server.js"`
 * keeps working for existing callers.
 */
export { isControlFrame };

interface SocketMeta {
  roomId: string;
  agentId: string;
}

const MAX_BODY = 64 * 1024;

/**
 * How long the relay bridge socket may stay in CONNECTING before it is torn down
 * and retried.
 *
 * `ws` never times out a connect on its own. A lossy link drops the upgrade
 * response easily, and a socket stuck in CONNECTING is worse than a dead one:
 * connectRelay refuses to replace it, so the bridge stays broken forever while
 * every outgoing frame is dropped without a trace. That is a silent, total loss
 * of the cross-machine channel.
 */
const RELAY_CONNECT_TIMEOUT_MS = 15_000;

/** Message count and byte ceiling for the join snapshot (see snapshotFor). */
const HANDSHAKE_SNAPSHOT_MESSAGES = 50;
const HANDSHAKE_SNAPSHOT_BYTES = 12 * 1024;
/** How far back to scan before filtering control frames out of the snapshot. */
const SNAPSHOT_SCAN_MESSAGES = 400;

/**
 * Control-frame classification moved to protocol.ts in 0.1.34 (the outbound
 * queue needs it too) and is re-exported at the top of this file, so
 * `import { isControlFrame } from "./peer-server.js"` keeps working.
 */

/**
 * Keep the newest items that fit in `maxBytes`.
 *
 * Guards against a single room with an outsized history turning every join into
 * a bulk transfer. At least one item is always kept — an oversized newest
 * message is returned whole rather than truncated, since a partial transcript
 * is worse than a big one.
 */
export function trimToByteBudget<T>(items: T[], maxBytes: number): T[] {
  const kept: T[] = [];
  let bytes = 2; // "[]"
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    const size = JSON.stringify(item)?.length ?? 0;
    if (kept.length > 0 && bytes + size > maxBytes) break;
    bytes += size + 1;
    kept.push(item);
  }
  return kept.reverse();
}

export interface PeerServerOptions {
  port: number;
  service: RoomService;
  /** Cross-network relay address, e.g. "ws://1.2.3.4:9320". When set, this node
   *  bridges each owned room to the relay so remote members can join it. */
  relay?: string;
}

/**
 * Take the longest PREFIX of `items` that fits in `maxBytes` (0.1.35).
 *
 * Deliberately not trimToByteBudget: a sync reply fills seq ranges from the OLD
 * end, so dropping the oldest rows would make the member re-ask for what it was
 * just denied. Returning a shorter prefix and telling it where to continue keeps
 * every batch a strict step forward.
 */
export function takeWithinBytes<T>(items: T[], maxBytes: number, maxItems = Number.POSITIVE_INFINITY): { items: T[]; truncated: boolean } {
  const kept: T[] = [];
  let bytes = 2; // "[]"
  for (const item of items) {
    if (kept.length >= maxItems) return { items: kept, truncated: true };
    const size = JSON.stringify(item)?.length ?? 0;
    if (kept.length > 0 && bytes + size > maxBytes) return { items: kept, truncated: true };
    bytes += size + 1;
    kept.push(item);
  }
  return { items: kept, truncated: false };
}

export class PeerServer {
  private readonly port: number;
  private readonly service: RoomService;
  private relayAddress?: string;
  /** Throttle for "bridge not open, frame dropped" warnings, per room. */
  private readonly lastDropWarn = new Map<string, number>();
  private httpServer: HttpServer | null = null;
  private wsServer: WebSocketServer | null = null;
  private sockets = new Map<WebSocket, SocketMeta>();
  /** roomId -> this node's outbound "owner" connection to the relay. */
  private readonly relaySockets = new Map<string, WebSocket>();
  /**
   * roomId -> newest seq of a VISIBLE (non-control) message seen since boot.
   *
   * A cheap lower bound for `latestChatSeq` on the sync path; the snapshot path
   * re-derives it from the store when this is cold (owner restart, or a room whose
   * tail is older than this process).
   */
  private readonly chatSeqHint = new Map<string, number>();
  /**
   * roomId -> newest chat seq this node has ALREADY broadcast (0.1.36).
   *
   * The amplifier guard. A frame this node RECEIVED must never become a frame it
   * sends again: `service.ts` re-emits every inbound joined-room frame onto the
   * local `roomService` bus (so agent-org's exec plane sees it), and this class
   * listens to that very same bus (see the constructor), so an inbound frame used
   * to come straight back out of `broadcast()` — with nothing to stop it when the
   * node also holds a member socket for that room (a self-join), because the
   * re-broadcast path never touches the store. Measured on 0.1.35: one send ->
   * 3638 deliveries in 195 ms while the owner's store kept exactly ONE row.
   *
   * A seq that has already gone out can only be a replay or an echo of a frame
   * that was stored once, so it is not broadcast a second time. Cleaned up with
   * the room in `stop()`.
   */
  private readonly broadcastSeq = new Map<string, number>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(options: PeerServerOptions) {
    this.port = options.port;
    this.service = options.service;
    this.relayAddress = options.relay;

    // Forward service events to member sockets.
    this.service.on("chat", (roomId, message) => {
      // Keep the O(1) answer to "what is your latest visible seq" warm (0.1.35).
      // Members poll `chat.stat` to notice that they are behind; recomputing this
      // from the message store on every probe would make a busy room pay a tail
      // read per member per poll for no reason.
      if (!isControlFrame(message.text)) this.chatSeqHint.set(roomId, message.seq);
      // ONE STORED FRAME, ONE BROADCAST (0.1.36). Without this, an inbound frame
      // re-emitted on the local bus by service.ts was broadcast straight back out,
      // and a node joined to a room it serves re-received it, re-emitted it, and
      // fanned it out again — forever, without a single extra store write.
      if (this.alreadyBroadcast(roomId, message.seq)) return;
      this.broadcast(roomId, { type: "chat.message", payload: message });
    });
    this.service.on("task", (roomId, task) => this.broadcast(roomId, { type: "task.event", payload: { task } }));
    this.service.on("taskRemoved", (roomId, taskId) => this.broadcast(roomId, { type: "task.removed", payload: { taskId } }));
    this.service.on("system", (roomId, event) => this.broadcast(roomId, { type: "system.event", payload: event }));
    this.service.on("members", (roomId) => {
      const room = this.service.getOwnedRoom(roomId);
      if (room) this.broadcast(roomId, { type: "members", payload: { members: room.members } });
    });
    /**
     * 0.1.53 — the room-level record reaches members at last.
     *
     * `controllerAgentId` and `settings` had NO carrier before: their mutators only
     * emitted a text `system.event`, so members' copies stayed frozen at join time
     * (measured 2026-09-20: two member nodes still showed the old controller hours
     * after a transfer). The frame is produced HERE, from the host's own service
     * event — never forwarded from a member's inbound frame (see the type contract
     * in protocol.ts; the host relays member frames, so "arrived over the host
     * connection" is not proof of authorship).
     */
    this.service.on("roomRecord", (roomId) => {
      const room = this.service.getOwnedRoom(roomId);
      if (!room) return;
      this.broadcast(roomId, { type: "room.state", payload: buildRoomStatePayload(roomId, room) });
    });
    // Revocation closes the member's live sockets immediately.
    this.service.on("revoked", (roomId, agentId) => {
      for (const [socket, meta] of this.sockets) {
        if (meta.roomId === roomId && meta.agentId === agentId) {
          try {
            socket.close(4003, "revoked");
          } catch {
            /* ignore */
          }
        }
      }
      const relay = this.relaySockets.get(roomId);
      if (relay?.readyState === WebSocket.OPEN) {
        relay.send(JSON.stringify({ type: "relay.revoke", agentId }));
      }
    });
    // Room lifecycle drives the relay bridge: bridge open rooms, drop closed ones.
    this.service.on("roomState", (roomId, status) => {
      if (this.relayAddress) {
        if (status === "open") this.connectRelay(roomId);
        else this.disconnectRelay(roomId);
      }
    });
  }

  get address(): string {
    return `${pickLanAddress()}:${this.port}`;
  }

  /** Change the relay address at runtime: re-bridge open owned rooms. */
  setRelay(relay?: string): void {
    const next = relay?.trim() || undefined;
    if (next === this.relayAddress) return;
    this.relayAddress = next;
    if (!next) {
      for (const roomId of [...this.relaySockets.keys()]) this.disconnectRelay(roomId);
      return;
    }
    for (const room of this.service.listOwnedRooms()) {
      if (room.status === "open") this.connectRelay(room.roomId);
    }
  }

  /** Relay bridge state for an owned room. */
  relayStatus(roomId: string): "none" | "connecting" | "open" | "disconnected" {
    if (!this.relayAddress) return "none";
    const socket = this.relaySockets.get(roomId);
    if (socket?.readyState === WebSocket.OPEN) return "open";
    if (socket?.readyState === WebSocket.CONNECTING) return "connecting";
    // Relay configured but the bridge socket is gone — the retry timer re-opens it.
    return "disconnected";
  }

  /** Every shareable address (host:port) on this node, best guess first. */
  get candidates(): string[] {
    return hostCandidates(this.port);
  }

  async start(): Promise<string> {
    if (this.httpServer) return this.address;
    const httpServer = createServer((req, res) => void this.handleHttp(req, res));
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(this.port, () => resolve());
    });
    this.httpServer = httpServer;

    const wsServer = new WebSocketServer({ server: httpServer, path: "/ws" });
    wsServer.on("connection", (socket, req) => this.handleConnection(socket, req));
    this.wsServer = wsServer;

    this.heartbeat = setInterval(() => {
      for (const socket of this.sockets.keys()) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Bridge existing owned rooms to the relay (rooms created later are bridged
    // via the roomState event handler).
    if (this.relayAddress) {
      for (const room of this.service.listOwnedRooms()) {
        if (room.status === "open") this.connectRelay(room.roomId);
      }
    }

    return this.address;
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.sockets.keys()) {
      try {
        socket.close(1001, "server stopping");
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
    this.broadcastSeq.clear();
    this.wsServer?.close();
    this.wsServer = null;
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /* ------------------------------ HTTP -------------------------------- */

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/status") {
        return this.json(res, 200, this.statusPayload());
      }
      if (req.method === "GET" && url.pathname === "/dist/latest.tgz") {
        return this.serveLatestTarball(res);
      }
      if (req.method === "POST" && url.pathname === "/api/join") {
        const body = (await readJsonBody(req)) as JoinRequest;
        return this.json(res, 200, await this.handleJoin(body, req.socket.remoteAddress ?? undefined));
      }
      return this.json(res, 404, { ok: false, error: "not-found" });
    } catch (err) {
      return this.json(res, 500, { ok: false, error: (err as Error).message });
    }
  }

  private statusPayload(): StatusResponse {
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

  private async handleJoin(body: JoinRequest, remoteAddress?: string): Promise<JoinResponse> {
    if (!body?.agent?.agentId) return { ok: false, error: "room-not-found" };
    const identity: AgentIdentity = body.agent;
    const roomId = body.roomId ?? this.service.listOwnedRooms()[0]?.roomId;
    if (!roomId) return { ok: false, error: "room-not-found" };
    try {
      // The member's OBSERVED address travels with the join (D-21): a re-join from
      // a machine whose address changed replaces the stored one in place instead of
      // appending a second member record.
      const result = this.service.joinOwnedRoom(roomId, identity, { password: body.password, address: remoteAddress });
      return {
        ok: true,
        token: result.token,
        snapshot: await this.snapshotFor(roomId),
      };
    } catch (err) {
      const code = (err as { code?: string }).code ?? "room-not-found";
      const map: Record<string, JoinError> = {
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

  /**
   * Handshake snapshot budget.
   *
   * This frame must survive a lossy relay link, so it is deliberately tiny. It
   * used to carry 200 messages — on a room with a long history that is 75KB,
   * i.e. ~50 TCP segments, which on a ~10% loss link stalls the handshake for
   * ~30s and pushes clients into retry storms. Members still accumulate the full
   * transcript as live messages arrive; only the initial tail is bounded.
   *
   * Since 0.1.35 the snapshot also carries the owner's authoritative seq numbers,
   * so a member can DETECT that it is behind instead of trusting its own view:
   * before this, the member's "latestSeq" was derived from the very mirror that
   * was missing messages, which made the defect invisible.
   */
  private async snapshotFor(
    roomId: string,
    maxMessages = HANDSHAKE_SNAPSHOT_MESSAGES,
    maxBytes = HANDSHAKE_SNAPSHOT_BYTES,
  ): Promise<RoomSnapshot> {
    const room = this.service.getOwnedRoom(roomId);
    if (!room) throw new Error("room-not-found");
    // Scan past the control-frame traffic and keep only real chat: a busy room's
    // tail is mostly org frames, so filtering AFTER a 50-message fetch would
    // hand the member an almost empty transcript (and, worse, still ship the
    // frames whenever chat is sparse).
    const fetched = await this.service.recentMessages(roomId, SNAPSHOT_SCAN_MESSAGES);
    const chat = fetched.filter((message) => !isControlFrame(message.text));
    const recentMessages = chat.slice(-maxMessages);
    const info = await this.seqInfo(roomId, chat);
    return {
      room,
      recentMessages: trimToByteBudget(recentMessages, maxBytes),
      latestSeq: info.latestSeq,
      latestChatSeq: info.latestChatSeq,
      syncVersion: SYNC_VERSION,
    };
  }

  /**
   * The owner's authoritative seq numbers for one owned room (0.1.35).
   *
   * `latestSeq` is the raw counter (control frames included) — the "maxSeq" an
   * operator sees in the store. `latestChatSeq` is the newest seq the READ VIEW
   * can reach, i.e. the newest non-control message: control frames are filtered
   * out of the read view by design, so a member's visible max seq can only ever
   * converge to this number.
   */
  private async seqInfo(roomId: string, chatTail?: ChatMessage[]): Promise<{ latestSeq: number; latestChatSeq: number }> {
    const latestSeq = this.service.latestSeq(roomId);
    let latestChatSeq = this.chatSeqHint.get(roomId) ?? 0;
    if (latestChatSeq <= 0) {
      // Cold (owner restarted, or nothing visible since boot): derive it from the
      // store once, and remember it.
      const tail = chatTail ?? (await this.service.recentMessages(roomId, SNAPSHOT_SCAN_MESSAGES));
      for (const message of tail) {
        if (!isControlFrame(message.text) && message.seq > latestChatSeq) latestChatSeq = message.seq;
      }
      if (latestChatSeq > 0) this.chatSeqHint.set(roomId, latestChatSeq);
    }
    return { latestSeq, latestChatSeq };
  }

  /**
   * Answer a member's bounded sync request (0.1.35).
   *
   * The reply reports `toSeq` = the highest seq actually EXAMINED, so the member
   * can settle the whole range and only re-ask from `toSeq + 1` when the answer
   * was truncated. Control frames are filtered here for the same reason as in the
   * snapshot: they are work orders, and replaying them into a member's read view
   * is exactly the amplification the 2026-09-12 incident was made of.
   */
  private async handleChatFetch(
    roomId: string,
    payload: { fromSeq?: number; toSeq?: number },
    respond: (frame: ServerFrame) => void,
  ): Promise<void> {
    const info = await this.seqInfo(roomId);
    const from = Math.max(1, Math.floor(Number(payload?.fromSeq) || 0));
    const requestedTo = Math.max(from, Math.floor(Number(payload?.toSeq) || 0));
    if (info.latestSeq <= 0 || from > info.latestSeq) {
      // Nothing to hand over; report the range as examined up to what we actually
      // have so the member settles it instead of re-asking.
      respond({
        type: "chat.backfill",
        payload: {
          fromSeq: from,
          toSeq: Math.min(requestedTo, info.latestSeq),
          messages: [],
          latestSeq: info.latestSeq,
          latestChatSeq: info.latestChatSeq,
          truncated: false,
        },
      });
      return;
    }
    const examinedTo = Math.min(requestedTo, info.latestSeq, from + SYNC_FETCH_MAX_SPAN - 1);
    const rows = await this.service.messagesInRange(roomId, from, examinedTo, SYNC_FETCH_MAX_MESSAGES + 1);
    const visible = rows.filter((message) => !isControlFrame(message.text));
    const capped = takeWithinBytes(
      visible,
      SYNC_FETCH_MAX_BYTES,
      SYNC_FETCH_MAX_MESSAGES,
    );
    const truncated = capped.truncated || examinedTo < requestedTo;
    const lastSeq = capped.items.length > 0 ? capped.items[capped.items.length - 1]!.seq : examinedTo;
    const answeredTo = capped.truncated && capped.items.length > 0 ? Math.min(examinedTo, lastSeq) : examinedTo;
    respond({
      type: "chat.backfill",
      payload: {
        fromSeq: from,
        toSeq: answeredTo,
        messages: capped.items,
        latestSeq: info.latestSeq,
        latestChatSeq: info.latestChatSeq,
        truncated: truncated || answeredTo < requestedTo,
      },
    });
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }

  /** Serve this plugin's distributable tarball, so peers can `curl` the latest build. */
  private async serveLatestTarball(res: ServerResponse): Promise<void> {
    try {
      const here = fileURLToPath(import.meta.url);
      const pkgRoot = dirname(dirname(dirname(here)));
      const names = await readdir(pkgRoot);
      const tgz = names.find((n) => n.startsWith("dsh-agent-room-") && n.endsWith(".tgz"));
      if (!tgz) throw new Error("no tarball");
      const data = await readFile(join(pkgRoot, tgz));
      res.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": data.length,
        "content-disposition": `attachment; filename=${tgz}`,
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "tarball not found on this node" }));
    }
  }

  /* ------------------------------ WS ----------------------------------- */

  private handleConnection(socket: WebSocket, req: IncomingMessage): void {
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
        const frame: ServerFrame = { type: "room.snapshot", payload: snapshot };
        this.send(socket, frame);
      })
      .catch(() => socket.close(4002, "room-unavailable"));
  }

  private async handleFrame(socket: WebSocket, raw: string): Promise<void> {
    const meta = this.sockets.get(socket);
    if (!meta) return;
    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw) as ClientFrame;
    } catch {
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
  private async handleFrameFrom(
    roomId: string,
    agentId: string,
    frame: ClientFrame,
    respond: (frame: ServerFrame) => void,
  ): Promise<void> {
    // Join handshake over a relay: no HTTP reachability, so the owner performs
    // the join here and replies with the token + snapshot.
    if (frame.type === "relay.join") {
      const payload = frame.payload as { agent?: AgentIdentity; password?: string };
      if (!payload?.agent?.agentId) {
        respond({ type: "relay.joined", payload: { ok: false, error: "missing agent identity" } });
        return;
      }
      try {
        const result = this.service.joinOwnedRoom(roomId, payload.agent, {
          password: payload.password,
          // Over a relay the transport the owner observes IS the relay; recording
          // that is honest ("last seen via") and keeps the field meaningful for a
          // member the owner can never see directly.
          address: this.relayAddress,
        });
        const snapshot = await this.snapshotFor(roomId);
        respond({ type: "relay.joined", payload: { ok: true, token: result.token, ticket: this.service.issueRelayTicket(roomId, payload.agent.agentId), snapshot } });
      } catch (err) {
        respond({ type: "relay.joined", payload: { ok: false, error: (err as Error).message } });
      }
      return;
    }

    const identity = this.memberIdentity(roomId, agentId);
    if (!identity) {
      respond(frameError("not-member"));
      return;
    }
    /**
     * 0.1.53 CONTRACT — HOST HALF.
     *
     * `room.state` is a host-only frame type. This method is the single funnel for
     * every member-originated frame (direct socket at `handleFrame`, relay bridge at
     * `connectRelay`), so a member that SENDS this type — e.g. a forged
     * `controllerAgentId` or `settings` — is dropped here: never applied, never
     * forwarded. Without this guard, re-broadcasting a member's frame of this type
     * would be a one-message privilege escalation (the same fail-open shape as the
     * org plane's "self-declared authority", F2).
     *
     * The type is not part of ClientFrame on purpose; the comparison is by wire
     * string so an unexpected value still cannot pass.
     */
    if (String((frame as { type?: unknown }).type) === "room.state") {
      console.error(
        `[agent-room] dropped a member-supplied room.state from ${agentId} in room ${roomId} (host-only frame type)`,
      );
      respond(frameError("forbidden-frame-type"));
      return;
    }
    // D-20: this method is the ONE funnel every member-originated frame goes
    // through (direct socket at handleFrame, relay bridge at connectRelay), so a
    // single touch here is what makes `member.lastSeenAt` mean "we heard from this
    // colleague at T" for any transport. It is deliberately not `joinedAt`
    // (admission) and not the org tree's `updatedAt` (an edit stamp).
    this.service.touchMember(roomId, agentId);
    try {
      switch (frame.type) {
        case "hello":
          return;
        case "chat.send": {
          const { text, replyTo, mentions, human } = frame.payload;
          if (text.length > MAX_MESSAGE_LENGTH) throw new Error("message-too-long");
          await this.service.addChatMessage(roomId, identity, { text, replyTo, mentions, human });
          // D-20 `lastExecAt`/`lastExecOk`: the exec channel is carried as a room
          // chat control frame (agent-org EXEC_RESULT_PREFIX, `[org:exec:result]`
          // + JSON). Recording that the member ANSWERED an exec — and whether it
          // was ok — is the difference between "the machine is up" and "the plugin
          // can actually run commands", which is the distinction the field
          // investigation could not make (3 exec timeouts, then a human answer).
          // Unparseable body: stamp the time only and leave `lastExecOk` at
          // whatever it was — "unknown" must never be reported as "false".
          const execOk = execResultOk(text);
          if (execOk !== undefined) this.service.touchMember(roomId, agentId, { execOk });
          else if (/^\[org:exec:result\]/.test(text)) this.service.touchMember(roomId, agentId);
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
        /**
         * Sync (0.1.35). A member that detected a hole or a lag asks for exactly
         * the seqs it is missing; the owner answers with a bounded batch and its
         * authoritative seq numbers. Both frames are member-initiated and
         * rate-limited by the member, so the owner needs no extra guarding beyond
         * the per-request span/message/byte caps.
         */
        case "chat.fetch":
          await this.handleChatFetch(roomId, frame.payload, respond);
          return;
        case "chat.stat": {
          const info = await this.seqInfo(roomId);
          respond({ type: "chat.stat", payload: info });
          return;
        }
        case "room.leave":
          await this.service.removeMember(roomId, agentId);
          respond({ type: "ack", payload: { seq: 0, ok: true } });
          return;
        default:
          respond(frameError("unknown-frame-type"));
      }
    } catch (err) {
      respond(frameError((err as Error).message));
    }
  }

  /* ------------------------- relay bridge ------------------------------ */

  /** Connect (or reconnect) this node to the relay as the owner of `roomId`. */
  private connectRelay(roomId: string): void {
    if (!this.relayAddress) return;
    const existing = this.relaySockets.get(roomId);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
    const agentId = this.service.getIdentity()?.agentId ?? "owner";
    const secret = this.service.relaySecretFor(roomId);
    const base = this.relayAddress.replace(/\/+$/, "");
    const url = `${base}/relay?roomId=${encodeURIComponent(roomId)}&role=owner&agentId=${encodeURIComponent(agentId)}&secret=${encodeURIComponent(secret)}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      return;
    }
    this.relaySockets.set(roomId, socket);

    // See RELAY_CONNECT_TIMEOUT_MS: a socket stuck in CONNECTING blocks its own
    // replacement, so it has to be torn down actively for the retry to happen.
    const connectDeadline = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) {
        this.log(`[agent-room] relay bridge connect timed out for ${roomId}; retrying`);
        try { socket.terminate(); } catch { /* ignore */ }
      }
    }, RELAY_CONNECT_TIMEOUT_MS);

    socket.on("open", () => {
      clearTimeout(connectDeadline);
      this.log(`[agent-room] relay bridge open for ${roomId}`);
    });
    socket.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const m = msg as { type?: string; from?: string; frame?: ClientFrame };
      if (m.type === "relay.frame" && m.from && m.frame) {
        void this.handleFrameFrom(roomId, m.from, m.frame, (f) => this.sendRelay(roomId, m.from!, f));
      }
    });
    socket.on("close", () => {
      clearTimeout(connectDeadline);
      if (this.relaySockets.get(roomId) === socket) {
        this.relaySockets.delete(roomId);
        // Keep trying while the room is still open and the relay is configured.
        setTimeout(() => {
          if (this.relayAddress && this.service.getOwnedRoom(roomId)?.status === "open") this.connectRelay(roomId);
        }, 5000);
      }
    });
    socket.on("error", () => { /* close follows */ });
  }

  private disconnectRelay(roomId: string): void {
    const socket = this.relaySockets.get(roomId);
    if (socket) {
      this.relaySockets.delete(roomId);
      try {
        socket.close(1000, "room closed");
      } catch {
        /* ignore */
      }
    }
  }

  /** Deliver a server frame to one member through the relay (targeted). */
  private sendRelay(roomId: string, toAgentId: string, frame: ServerFrame): void {
    const relay = this.relaySockets.get(roomId);
    if (relay?.readyState === WebSocket.OPEN) {
      relay.send(JSON.stringify({ type: "relay.send", to: toAgentId, frame }));
      return;
    }
    // Dropping this silently is what made a dead bridge look healthy: the
    // controller's instruction simply never arrived and nothing said so. Warn,
    // but at most once a minute per room so a long outage cannot flood the log.
    const now = Date.now();
    if (now - (this.lastDropWarn.get(roomId) ?? 0) > 60_000) {
      this.lastDropWarn.set(roomId, now);
      this.log(
        `[agent-room] relay bridge NOT open for ${roomId} — dropped ${frame.type} frame to ${toAgentId}; remote peers cannot receive it`,
      );
    }
  }

  private log(message: string): void {
    // The peer server has no cordis logger; keep relay diagnostics on stderr.
    console.error(message);
  }

  private memberIdentity(roomId: string, agentId: string): AgentIdentity | null {
    const room = this.service.getOwnedRoom(roomId);
    const member = room?.members.find((m) => m.agentId === agentId);
    if (!member) return null;
    return { agentId: member.agentId, nickname: member.nickname, capabilities: member.capabilities ?? [], createdAt: member.joinedAt };
  }

  /**
   * Has this chat seq already been broadcast for this room? (0.1.36)
   *
   * Only a positive, finite seq is remembered: owner-stored messages always carry
   * one, while a locally appended optimistic row is negative and is never emitted
   * on the bus. A replay of an already-broadcast seq (backfill echo, snapshot
   * replay, a member re-emitting what it just received) is dropped instead of
   * being fanned out again — which is what bounds delivery to one per stored frame.
   */
  private alreadyBroadcast(roomId: string, seq: unknown): boolean {
    if (typeof seq !== "number" || !Number.isFinite(seq) || seq <= 0) return false;
    const last = this.broadcastSeq.get(roomId) ?? 0;
    if (seq <= last) return true;
    this.broadcastSeq.set(roomId, seq);
    return false;
  }

  private broadcast(roomId: string, frame: ServerFrame): void {
    for (const [socket, meta] of this.sockets) {
      if (meta.roomId === roomId) this.send(socket, frame);
    }
    // Relay bridge: the relay fans the raw frame out to remote members.
    const relay = this.relaySockets.get(roomId);
    if (relay?.readyState === WebSocket.OPEN) {
      relay.send(JSON.stringify(frame));
    }
  }

  private send(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }
}

/** Interface names that indicate a virtual adapter, never a real LAN. */
const VIRTUAL_INTERFACE = /virtual|vmware|virtualbox|vbox|hyper-v|hyperv|memu|nox|leidian|tailscale|wireguard|zerotier|docker|wsl|vethernet|utun|\bppp\b|loopback/i;

/**
 * `ok` of an `[org:exec:result]` control frame, or undefined when the frame is
 * not an exec result / its body cannot be read (D-20).
 *
 * The exec channel is a room chat line (`agent-org/src/host/exec.js:11,105` —
 * `"[org:exec:result]" + JSON`), which is why the owner can observe it at all. The
 * prefix is matched as a literal, without importing agent-org: the two plugins are
 * separate packages, and the room owner must keep working (with the field simply
 * absent) when an older or newer peer formats the body differently. A body that
 * does not parse yields `undefined` so the caller stamps `lastExecAt` without
 * inventing a `lastExecOk` value.
 */
export function execResultOk(text: unknown): boolean | undefined {
  if (typeof text !== "string" || !text.startsWith("[org:exec:result]")) return undefined;
  try {
    const payload = JSON.parse(text.slice("[org:exec:result]".length)) as { ok?: unknown; pending?: unknown };
    // A 202 "still executing" interim answer is NOT a finished exec: stamping it
    // would report an in-flight command as the member's last result.
    if (payload && payload.pending === true) return undefined;
    return typeof payload?.ok === "boolean" ? payload.ok : undefined;
  } catch {
    return undefined;
  }
}

/** All non-internal IPv4 addresses on this node, with their interface name. */
function lanAddressCandidates(): Array<{ address: string; name: string }> {
  const ifaces = networkInterfaces();
  const out: Array<{ address: string; name: string }> = [];
  for (const [name, entries] of Object.entries(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && entry.address) out.push({ address: entry.address, name });
    }
  }
  return out;
}

/** True for RFC1918 private LAN ranges (192.168/16, 10/8, 172.16-31/12). */
function isPrivateLan(address: string): boolean {
  const parts = address.split(".");
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Candidates ordered best-first: real interfaces first, LAN ranges preferred,
 *  then real non-LAN, then virtual adapters (Tailscale, emulators) — those are
 *  still usable (Tailscale gives cross-network direct links), just not first. */
function orderedCandidates(): Array<{ address: string; name: string }> {
  const all = lanAddressCandidates();
  if (all.length === 0) return [];
  const real = all.filter((candidate) => !VIRTUAL_INTERFACE.test(candidate.name));
  const pool = real.length > 0 ? real : all;
  const lan = pool.find((candidate) => isPrivateLan(candidate.address));
  const preferred = lan ? [lan, ...pool.filter((candidate) => candidate !== lan)] : pool;
  const virtual = all.filter((candidate) => !preferred.includes(candidate));
  return [...preferred, ...virtual];
}

export function pickLanAddress(): string {
  const ordered = orderedCandidates();
  if (ordered.length === 0) return "127.0.0.1";
  // Prefer a real LAN address; CGNAT/VPN ranges like Tailscale's 100.64.0.0/10
  // are excluded so the shared address works for machines on the same network.
  return ordered[0]?.address ?? "127.0.0.1";
}

/** Ordered host:port candidates for sharing/beacons, best guess first. */
export function hostCandidates(port: number): string[] {
  return orderedCandidates().map((candidate) => `${candidate.address}:${port}`);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body-too-large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
