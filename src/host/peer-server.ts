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
import type { AgentIdentity, RoomSnapshot } from "../types.js";
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
  MAX_MESSAGE_LENGTH,
} from "./protocol.js";

interface SocketMeta {
  roomId: string;
  agentId: string;
}

const MAX_BODY = 64 * 1024;

export interface PeerServerOptions {
  port: number;
  service: RoomService;
}

export class PeerServer {
  private readonly port: number;
  private readonly service: RoomService;
  private httpServer: HttpServer | null = null;
  private wsServer: WebSocketServer | null = null;
  private sockets = new Map<WebSocket, SocketMeta>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(options: PeerServerOptions) {
    this.port = options.port;
    this.service = options.service;

    // Forward service events to member sockets.
    this.service.on("chat", (roomId, message) => this.broadcast(roomId, { type: "chat.message", payload: message }));
    this.service.on("task", (roomId, task) => this.broadcast(roomId, { type: "task.event", payload: { task } }));
    this.service.on("taskRemoved", (roomId, taskId) => this.broadcast(roomId, { type: "task.removed", payload: { taskId } }));
    this.service.on("system", (roomId, event) => this.broadcast(roomId, { type: "system.event", payload: event }));
    this.service.on("members", (roomId) => {
      const room = this.service.getOwnedRoom(roomId);
      if (room) this.broadcast(roomId, { type: "members", payload: { members: room.members } });
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
    });
  }

  get address(): string {
    return `${pickLanAddress()}:${this.port}`;
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
        return this.json(res, 200, await this.handleJoin(body));
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

  private async handleJoin(body: JoinRequest): Promise<JoinResponse> {
    if (!body?.agent?.agentId) return { ok: false, error: "room-not-found" };
    const identity: AgentIdentity = body.agent;
    const roomId = body.roomId ?? this.service.listOwnedRooms()[0]?.roomId;
    if (!roomId) return { ok: false, error: "room-not-found" };
    try {
      const result = this.service.joinOwnedRoom(roomId, identity, { password: body.password });
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

  private async snapshotFor(roomId: string): Promise<RoomSnapshot> {
    const room = this.service.getOwnedRoom(roomId);
    if (!room) throw new Error("room-not-found");
    const recentMessages = await this.service.recentMessages(roomId, 200);
    return { room, recentMessages };
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
    const identity = this.memberIdentity(meta.roomId, meta.agentId);
    if (!identity) {
      this.send(socket, frameError("not-member"));
      return;
    }
    try {
      switch (frame.type) {
        case "hello":
          return;
        case "chat.send": {
          const { text, replyTo, mentions, human } = frame.payload;
          if (text.length > MAX_MESSAGE_LENGTH) throw new Error("message-too-long");
          await this.service.addChatMessage(meta.roomId, identity, { text, replyTo, mentions, human });
          return;
        }
        case "task.create":
          this.service.createTask(meta.roomId, identity, frame.payload);
          return;
        case "task.assign":
          this.service.assignTask(meta.roomId, identity, frame.payload.taskId, frame.payload.assignee);
          return;
        case "task.claim":
          this.service.claimTask(meta.roomId, identity, frame.payload.taskId);
          return;
        case "task.comment":
          this.service.commentTask(meta.roomId, identity, frame.payload.taskId, frame.payload.text);
          return;
        case "task.status":
          this.service.setTaskStatus(meta.roomId, identity, frame.payload.taskId, frame.payload.status);
          return;
        case "task.complete":
          this.service.completeTask(meta.roomId, identity, frame.payload.taskId, frame.payload.note);
          return;
        case "task.handoff":
          this.service.setTaskHandoff(meta.roomId, identity, frame.payload.taskId, frame.payload.handoff);
          return;
        case "task.approve":
          this.service.approveTask(meta.roomId, identity, frame.payload.taskId, frame.payload.note);
          return;
        case "task.reject":
          this.service.rejectTask(meta.roomId, identity, frame.payload.taskId, frame.payload.note);
          return;
        case "task.reopen":
          this.service.reopenTask(meta.roomId, identity, frame.payload.taskId);
          return;
        case "task.remove":
        case "task.delete":
          this.service.deleteTask(meta.roomId, identity, frame.payload.taskId);
          return;
        case "member.profile":
          this.service.updateMemberProfile(meta.roomId, meta.agentId, frame.payload);
          return;
        case "room.leave":
          await this.service.removeMember(meta.roomId, meta.agentId);
          socket.close(1000, "left");
          return;
        default:
          this.send(socket, frameError("unknown-frame-type"));
      }
    } catch (err) {
      this.send(socket, frameError((err as Error).message));
    }
  }

  private memberIdentity(roomId: string, agentId: string): AgentIdentity | null {
    const room = this.service.getOwnedRoom(roomId);
    const member = room?.members.find((m) => m.agentId === agentId);
    if (!member) return null;
    return { agentId: member.agentId, nickname: member.nickname, capabilities: member.capabilities ?? [], createdAt: member.joinedAt };
  }

  private broadcast(roomId: string, frame: ServerFrame): void {
    for (const [socket, meta] of this.sockets) {
      if (meta.roomId === roomId) this.send(socket, frame);
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
