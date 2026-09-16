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

/**
 * Owner-side sync capability (0.1.35). A member that sees this in the join
 * snapshot knows the owner answers `chat.fetch` / `chat.stat`, so it may try to
 * close a gap instead of waiting for a manual rejoin.
 */
export const SYNC_VERSION = 1;

/**
 * Owner-side ceilings for one backfill request (0.1.35).
 *
 * Backfill exists because a member used to be able to fall behind the owner
 * forever; it must never become a bulk-transfer channel. One request examines at
 * most MAX_SPAN seqs and returns at most MAX_MESSAGES / MAX_BYTES, and the member
 * asks again only after the owner has answered — so a stream of gaps converges in
 * bounded batches instead of replaying a whole history at once.
 */
export const SYNC_FETCH_MAX_SPAN = 200;
export const SYNC_FETCH_MAX_MESSAGES = 50;
export const SYNC_FETCH_MAX_BYTES = 32 * 1024;

/* ---------------------------- frame classes ---------------------------- */

/**
 * True for agent-org's control frames (`[org:exec]…`, `[org:exec:result]…`,
 * `[org:snapshot]…`).
 *
 * These travel as ordinary room messages but they are work orders, not chat. The
 * receiving agent-org acts on EVERY org frame it sees, so putting them in a join
 * snapshot makes them replay on every reconnect. That is not theoretical: on
 * 2026-09-12 the busiest room's history reached 25,346 exec frames, every
 * reconnect replayed the tail of it, and the amplification drove a machine into
 * a ~90ms reconnect loop and eventually took it offline.
 *
 * Lives in protocol.ts because it classifies wire frames: the outbound queue
 * needs it too, and peer-server.ts must not be the only module that knows what a
 * control frame is. Re-exported from peer-server.ts for existing importers.
 */
export function isControlFrame(text: unknown): boolean {
  return typeof text === "string" && text.startsWith("[org:");
}

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
  /**
   * Ask the owner for the messages it holds in `[fromSeq, toSeq]` (0.1.35).
   *
   * Sent by a member whose local mirror has a hole or lags behind the owner's
   * `latestChatSeq`. The owner answers with `chat.backfill`; it never replies
   * with a full history, and it reports the newest seq it actually EXAMINED so
   * the member can settle the rest of the range without asking again.
   */
  | { type: "chat.fetch"; payload: { fromSeq: number; toSeq: number } }
  /** Cheap liveness/sequence probe: "what is your latest seq right now?" (0.1.35). */
  | { type: "chat.stat"; payload: Record<string, never> }
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
  /**
   * Answer to `chat.fetch` (0.1.35): the owner's visible (non-control) messages
   * in the requested range, plus its authoritative seq numbers.
   *
   * `toSeq` is the highest seq the owner EXAMINED — every seq in
   * `[fromSeq, toSeq]` is either present in `messages` or does not exist as a
   * visible message (it was a control frame, or it is gone). The member settles
   * that range and asks again from `toSeq + 1` only when `truncated` is true.
   */
  | {
      type: "chat.backfill";
      payload: {
        fromSeq: number;
        toSeq: number;
        messages: ChatMessage[];
        latestSeq: number;
        latestChatSeq: number;
        truncated: boolean;
      };
    }
  /** Answer to `chat.stat` (0.1.35). */
  | { type: "chat.stat"; payload: { latestSeq: number; latestChatSeq: number } }
  /** Join result delivered through a relay (targeted to one member). */
  | { type: "relay.joined"; payload: { ok: boolean; token?: string; ticket?: string; snapshot?: RoomSnapshot; error?: string } }
  /**
   * Owner availability, announced by the RELAY (D-49).
   *
   * A member cannot tell "the room owner is not connected" from "my link is broken": both look like a
   * handshake that never completes. Measured 2026-09-16 — one member burned 68 joins and 601 buffered
   * joins, and every one of its 1608 closes was its OWN 20 s budget expiring, not the relay kicking
   * it. The relay holds the owner slot, so it knows the difference and now says so; the member can
   * hold one socket open through the outage instead of racing the owner's reconnect.
   */
  | { type: "relay.owner-offline"; payload: { retryAfterMs?: number; roomId?: string } }
  | { type: "relay.owner-online"; payload: { roomId?: string } };

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

/** Exponential reconnect backoff: 1s, 2s, 4s, ... capped at 30s. */
export function reconnectDelay(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(RECONNECT_BASE_MS * 2 ** n, RECONNECT_MAX_MS);
}

/**
 * Canonical task status transition (spec + reference implementation).
 * Returns the next status for an action, or `null` when the transition is invalid.
 */
export function taskStatusTransition(
  action: string,
  current: string,
  judgeMode: "controller" | "auto" = "controller",
): string | null {
  switch (action) {
    case "create": return "todo";
    case "claim": return current === "todo" ? "doing" : null;
    case "status": return current === "doing" || current === "todo" ? (action === "status" ? current : current) : null;
    case "complete":
      if (current !== "doing" && current !== "todo") return null;
      return judgeMode === "auto" ? "done" : "review";
    case "approve": return current === "review" ? "done" : null;
    case "reject": return current === "review" ? "rejected" : null;
    case "reopen": return current === "done" || current === "rejected" || current === "review" ? "todo" : null;
    case "remove":
    case "delete": return "removed";
    default: return null;
  }
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
