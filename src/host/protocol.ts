/**
 * dsh-agent-room — wire protocol between a room server (owner node) and members.
 *
 * Transport:
 *  - HTTP handshake: GET /api/status, POST /api/join
 *  - WebSocket /ws?token=...  — JSON frames, one per line is NOT required; use JSON.parse per message event.
 *  - UDP broadcast on DISCOVERY_PORT: room beacons for same-LAN discovery.
 *
 * All frames are `{ type, seq?, from?, ts?, payload }`.
 */

import type { AgentIdentity, ChatMessage, Member, RoleKey, Room, RoomSnapshot, Task, TaskHandoff, SystemEvent } from "../types.js";

export const DEFAULT_PORT = 9317;
/** UDP port for same-LAN room discovery (room beacons). */
export const DISCOVERY_PORT = 9318;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const MAX_MESSAGE_LENGTH = 16 * 1024;

/* ------------------------------ HTTP API ------------------------------ */

export interface StatusRoomSummary {
  roomId: string;
  title: string;
  type: "persistent" | "temporary";
  authMode: "open" | "password";
  memberCount: number;
  status: "open" | "suspended" | "closed";
}

export interface StatusResponse {
  node: { nickname: string; hasIdentity: boolean };
  rooms: StatusRoomSummary[];
}

export interface JoinRequest {
  roomId?: string;
  /** Required when authMode === "password". */
  password?: string;
  agent: AgentIdentity;
}

export type JoinError = "room-not-found" | "room-closed" | "wrong-password" | "room-full" | "already-member" | "revoked";

export type JoinResponse =
  | { ok: true; token: string; snapshot: RoomSnapshot }
  | { ok: false; error: JoinError };

/* ------------------------------ WS frames ----------------------------- */

export type ClientFrame =
  | { type: "hello"; payload: { token: string } }
  | { type: "chat.send"; payload: { text: string; replyTo?: number; mentions?: string[]; human?: boolean } }
  | { type: "task.create"; payload: TaskCreatePayload }
  | { type: "task.assign"; payload: { taskId: string; assignee: string } }
  | { type: "task.claim"; payload: { taskId: string } }
  | { type: "task.comment"; payload: { taskId: string; text: string } }
  | { type: "task.status"; payload: { taskId: string; status: "todo" | "doing" } }
  | { type: "task.complete"; payload: { taskId: string; note?: string } }
  | { type: "task.handoff"; payload: { taskId: string; handoff: TaskHandoff } }
  | { type: "task.approve"; payload: { taskId: string; note?: string } }
  | { type: "task.reject"; payload: { taskId: string; note?: string } }
  | { type: "task.reopen"; payload: { taskId: string } }
  | { type: "task.remove"; payload: { taskId: string } }
  | { type: "task.delete"; payload: { taskId: string } }
  | { type: "member.profile"; payload: { nickname: string; capabilities?: string[]; manualCapabilities?: string[]; roles?: RoleKey[] } }
  | { type: "room.leave"; payload: Record<string, never> }
  /** Join handshake sent through a relay when the owner is not directly reachable. */
  | { type: "relay.join"; payload: { agent: AgentIdentity; password?: string } };

export type ServerFrame =
  | { type: "room.snapshot"; payload: RoomSnapshot }
  | { type: "chat.message"; payload: ChatMessage }
  | { type: "task.event"; payload: { task: Task } }
  | { type: "task.removed"; payload: { taskId: string } }
  | { type: "members"; payload: { members: Member[] } }
  | { type: "system.event"; payload: SystemEvent }
  | { type: "ack"; payload: { seq: number; ok: boolean; error?: string } }
  | { type: "error"; payload: { message: string } }
  /** Join result delivered through a relay (targeted to one member). */
  | { type: "relay.joined"; payload: { ok: boolean; token?: string; ticket?: string; snapshot?: RoomSnapshot; error?: string } };

export interface TaskCreatePayload {
  title: string;
  description?: string;
  assignee?: string;
  claimable?: boolean;
  requiredCapabilities?: string[];
  requiredRoles?: RoleKey[];
  acceptance?: string;
  judgeMode?: "controller" | "auto";
}

export function frameError(message: string): ServerFrame {
  return { type: "error", payload: { message } };
}

export function frameAck(seq: number, ok: boolean, error?: string): ServerFrame {
  return { type: "ack", payload: { seq, ok, error } };
}

/* ------------------------------ LAN discovery -------------------------- */

/** UDP beacon broadcast by room hosts so same-LAN nodes can see rooms without an address. */
export interface RoomBeacon {
  kind: "agent-room.beacon";
  v: 2;
  /** Owner node identity. */
  nodeId: string;
  nickname: string;
  roomId: string;
  title: string;
  authMode: "open" | "password";
  memberCount: number;
  /** Reachable server addresses for this room (host:port), best guess first. */
  addresses: string[];
  ts: number;
}
