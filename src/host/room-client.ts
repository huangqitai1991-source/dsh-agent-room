/**
 * dsh-agent-room — RoomClient.
 *
 * Member-side connection to a remote room hosted by another node. Handles the
 * HTTP join handshake, the WebSocket channel, local projection state, and
 * reconnection with exponential backoff.
 */

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { AgentIdentity, RoomSnapshot, ChatMessage, SystemEvent, Task, TaskHandoff, RoleKey, JoinedRoomRecord } from "../types.js";
import type { ClientFrame, ServerFrame, TaskCreatePayload } from "./protocol.js";
import { nowIso, uuidv7 } from "./util.js";

export interface RoomClientEvents {
  snapshot: (snapshot: RoomSnapshot) => void;
  chat: (message: ChatMessage) => void;
  task: (task: Task) => void;
  system: (event: SystemEvent) => void;
  connection: (state: "connecting" | "open" | "reconnecting" | "closed") => void;
}

export interface RoomClientOptions {
  /** Server addresses (host:port) to try in order — best guess first. */
  addresses: string[];
  roomId?: string;
  password?: string;
  agent: AgentIdentity;
  /** Cross-network relay address, e.g. "ws://1.2.3.4:9320". When direct
   *  connection fails, the client joins through the relay instead. */
  relay?: string;
  onJoinedRecord?: (record: JoinedRoomRecord) => Promise<void> | void;
}

/** Per-address handshake timeout before trying the next candidate. */
const JOIN_ATTEMPT_TIMEOUT_MS = 5_000;

export class RoomClient extends EventEmitter {
  /** The address that actually connected (locked in by the handshake). */
  address: string;
  private readonly addresses: string[];
  private readonly roomIdHint?: string;
  private readonly password?: string;
  private readonly agent: AgentIdentity;
  private readonly relayAddress?: string;
  private readonly onJoinedRecord?: RoomClientOptions["onJoinedRecord"];

  private token: string | null = null;
  private roomId: string | null = null;
  private socket: WebSocket | null = null;
  private left = false;
  private usingRelay = false;
  private reconnectAttempt = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** Local projection (updated by server frames). */
  snapshot: RoomSnapshot | null = null;

  constructor(options: RoomClientOptions) {
    super();
    this.addresses = options.addresses.length > 0 ? options.addresses : ["127.0.0.1:0"];
    this.address = this.addresses[0]!;
    this.roomIdHint = options.roomId;
    this.password = options.password;
    this.agent = options.agent;
    this.relayAddress = options.relay;
    this.onJoinedRecord = options.onJoinedRecord;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  override on<K extends keyof RoomClientEvents>(event: K, listener: RoomClientEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof RoomClientEvents>(event: K, ...args: Parameters<RoomClientEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /** Full join flow: direct HTTP handshake first, relay fallback when configured. */
  async connect(): Promise<void> {
    this.left = false;
    this.emit("connection", "connecting");
    if (!this.usingRelay) {
      try {
        const join = await this.httpJoin();
        this.token = join.token;
        this.roomId = join.snapshot.room.roomId;
        this.snapshot = join.snapshot;
        this.emit("snapshot", join.snapshot);
        await this.onJoinedRecord?.({
          roomId: join.snapshot.room.roomId,
          address: this.address,
          title: join.snapshot.room.title,
          lastVisitedAt: nowIso(),
        });
        this.openSocket();
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A reachable server's rejection (wrong password / revoked / …) is a real
        // answer — do not paper over it with the relay. Only network-level
        // failures fall through to the relay.
        if (!this.relayAddress || message.startsWith("join rejected")) throw err;
        this.usingRelay = true;
      }
    }
    await this.connectViaRelay();
  }

  /** Join through the relay: WS to the relay, relay.join -> relay.auth handshake. */
  private connectViaRelay(): Promise<void> {
    const relay = this.relayAddress;
    const targetRoomId = this.roomId ?? this.roomIdHint;
    if (!relay) return Promise.reject(new Error("没有可用的连接地址"));
    if (!targetRoomId) return Promise.reject(new Error("走中继需要先知道 roomId"));
    return new Promise((resolve, reject) => {
      const base = relay.replace(/\/+$/, "");
      const url = `${base}/relay?roomId=${encodeURIComponent(targetRoomId)}&role=member&agentId=${encodeURIComponent(this.agent.agentId)}`;
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`中继加入超时: ${relay}`));
        try { socket.close(1000, "join timeout"); } catch { /* ignore */ }
      }, JOIN_ATTEMPT_TIMEOUT_MS);
      socket.on("open", () => {
        socket.send(JSON.stringify({ type: "relay.join", payload: { agent: this.agent, password: this.password } }));
      });
      socket.on("message", (data) => {
        const raw = String(data);
        if (settled) { this.handleFrame(raw); return; }
        let frame;
        try { frame = JSON.parse(raw); } catch { return; }
        if (frame.type === "relay.joined") {
          if (frame.payload?.ok && frame.payload.token && frame.payload.ticket && frame.payload.snapshot) {
            this.token = frame.payload.token;
            this.roomId = frame.payload.snapshot.room.roomId;
            this.snapshot = frame.payload.snapshot;
            socket.send(JSON.stringify({ type: "relay.auth", payload: { ticket: frame.payload.ticket } }));
          } else {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`join rejected: ${frame.payload?.error ?? "relay join failed"}`));
            try { socket.close(1000, "join rejected"); } catch { /* ignore */ }
          }
          return;
        }
        if (frame.type === "relay.authed") {
          settled = true;
          clearTimeout(timer);
          if (frame.payload?.ok) {
            this.reconnectAttempt = 0;
            this.emit("snapshot", this.snapshot!);
            void this.onJoinedRecord?.({
              roomId: this.roomId!,
              address: relay,
              title: this.snapshot?.room.title ?? "",
              lastVisitedAt: nowIso(),
            });
            this.emit("connection", "open");
            resolve();
          } else {
            reject(new Error(`relay auth rejected: ${frame.payload?.error ?? "unauthorized"}`));
            try { socket.close(1000, "auth rejected"); } catch { /* ignore */ }
          }
        }
        // 其它握手期帧忽略
      });
      socket.on("close", () => {
        this.clearHeartbeat();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("中继连接中断"));
          return;
        }
        if (this.left) { this.emit("connection", "closed"); return; }
        this.emit("connection", "reconnecting");
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
  private async httpJoin(): Promise<{ token: string; snapshot: RoomSnapshot }> {
    let lastError: Error | null = null;
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
        const data = (await res.json()) as
          | { ok: true; token: string; snapshot: RoomSnapshot }
          | { ok: false; error: string };
        if (!data.ok) throw new Error(`join rejected: ${data.error}`);
        // Reachable server answered — lock this address in for the WS channel.
        this.address = address;
        return data;
      } catch (err) {
        const error = err as Error;
        if (error.name === "AbortError") {
          lastError = new Error(`连接超时: ${address}`);
          continue;
        }
        if (error.message.startsWith("join rejected")) throw error;
        // Network-level failure — try the next candidate.
        lastError = error;
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error("没有可用的连接地址");
  }

  private openSocket(): void {
    if (!this.token || !this.roomId) return;
    const url = `ws://${this.address}/ws?roomId=${encodeURIComponent(this.roomId)}&token=${encodeURIComponent(this.token)}&agentId=${encodeURIComponent(this.agent.agentId)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.emit("connection", "open");
      this.sendFrame({ type: "hello", payload: { token: this.token! } });
    });
    socket.on("message", (data) => this.handleFrame(String(data)));
    socket.on("close", () => {
      this.clearHeartbeat();
      if (this.left) {
        this.emit("connection", "closed");
        return;
      }
      this.emit("connection", "reconnecting");
      this.scheduleReconnect();
    });
    socket.on("error", () => {
      /* close follows */
    });
  }

  private scheduleReconnect(): void {
    if (this.left || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.left) return;
      this.emit("connection", "connecting");
      // Re-run the full handshake (not just openSocket): the owner may have
      // restarted, which invalidates the old token and resets nothing else we
      // can reuse. A fresh join also rebuilds the local snapshot, so the seq
      // dedup stays consistent with the owner's restored history.
      void this.connect().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("join rejected")) {
          // Terminal: room is gone/closed/full — no point retrying.
          this.emit("connection", "closed");
          return;
        }
        this.emit("connection", "reconnecting");
        this.scheduleReconnect();
      });
    }, delay);
  }

  private handleFrame(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case "room.snapshot":
        this.snapshot = frame.payload;
        this.emit("snapshot", frame.payload);
        break;
      case "chat.message":
        if (this.snapshot) {
          // Dedup by seq so catch-up replays never double a message.
          if (!this.snapshot.recentMessages.some((m) => m.seq === frame.payload.seq)) {
            this.snapshot.recentMessages.push(frame.payload);
          }
        }
        this.emit("chat", frame.payload);
        break;
      case "task.event": {
        if (this.snapshot) {
          const idx = this.snapshot.room.tasks.findIndex((t) => t.taskId === frame.payload.task.taskId);
          if (idx >= 0) this.snapshot.room.tasks[idx] = frame.payload.task;
          else this.snapshot.room.tasks.push(frame.payload.task);
        }
        this.emit("task", frame.payload.task);
        break;
      }
      case "task.removed":
        if (this.snapshot) this.snapshot.room.tasks = this.snapshot.room.tasks.filter((t) => t.taskId !== frame.payload.taskId);
        break;
      case "members":
        if (this.snapshot) this.snapshot.room.members = frame.payload.members;
        break;
      case "system.event":
        this.emit("system", frame.payload);
        break;
      case "ack":
      case "error":
        break;
    }
  }

  sendChat(input: { text: string; replyTo?: number; mentions?: string[]; human?: boolean }): void {
    this.sendFrame({ type: "chat.send", payload: input });
  }

  sendProfile(profile: { nickname: string; capabilities?: string[]; manualCapabilities?: string[]; roles?: RoleKey[] }): void {
    this.sendFrame({ type: "member.profile", payload: profile });
  }

  taskCreate(payload: TaskCreatePayload): void {
    this.sendFrame({ type: "task.create", payload });
  }

  taskAssign(taskId: string, assignee: string): void {
    this.sendFrame({ type: "task.assign", payload: { taskId, assignee } });
  }

  taskClaim(taskId: string): void {
    this.sendFrame({ type: "task.claim", payload: { taskId } });
  }

  taskComment(taskId: string, text: string): void {
    this.sendFrame({ type: "task.comment", payload: { taskId, text } });
  }

  taskStatus(taskId: string, status: "todo" | "doing"): void {
    this.sendFrame({ type: "task.status", payload: { taskId, status } });
  }

  taskComplete(taskId: string, note?: string): void {
    this.sendFrame({ type: "task.complete", payload: { taskId, note } });
  }

  taskHandoff(taskId: string, handoff: TaskHandoff): void {
    this.sendFrame({ type: "task.handoff", payload: { taskId, handoff } });
  }

  taskApprove(taskId: string, note?: string): void {
    this.sendFrame({ type: "task.approve", payload: { taskId, note } });
  }

  taskReject(taskId: string, note?: string): void {
    this.sendFrame({ type: "task.reject", payload: { taskId, note } });
  }

  taskReopen(taskId: string): void {
    this.sendFrame({ type: "task.reopen", payload: { taskId } });
  }

  taskRemove(taskId: string): void {
    this.sendFrame({ type: "task.remove", payload: { taskId } });
  }

  async leave(): Promise<void> {
    this.left = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendFrame({ type: "room.leave", payload: {} });
      this.socket.close(1000, "left");
    }
    this.socket = null;
    this.emit("connection", "closed");
  }

  destroy(): void {
    this.left = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
    try {
      this.socket?.close(1000, "bye");
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  private sendFrame(frame: ClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

/** Convenience for tests/scripts: build a dummy agent identity. */
export function buildAgent(agentId = uuidv7(), nickname = "agent", capabilities: string[] = []): AgentIdentity {
  return { agentId, nickname, capabilities, createdAt: nowIso() };
}
