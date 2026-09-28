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
export function isControlFrame(text) {
    return typeof text === "string" && text.startsWith("[org:");
}
export function frameError(message) {
    return { type: "error", payload: { message } };
}
export function frameAck(seq, ok, error) {
    return { type: "ack", payload: { seq, ok, error } };
}
/** Exponential reconnect backoff: 1s, 2s, 4s, ... capped at 30s. */
export function reconnectDelay(attempt) {
    const n = Math.max(0, Math.floor(attempt));
    return Math.min(RECONNECT_BASE_MS * 2 ** n, RECONNECT_MAX_MS);
}
/**
 * Canonical task status transition (spec + reference implementation).
 * Returns the next status for an action, or `null` when the transition is invalid.
 */
export function taskStatusTransition(action, current, judgeMode = "controller") {
    switch (action) {
        case "create": return "todo";
        case "claim": return current === "todo" ? "doing" : null;
        case "status": return current === "doing" || current === "todo" ? (action === "status" ? current : current) : null;
        case "complete":
            if (current !== "doing" && current !== "todo")
                return null;
            return judgeMode === "auto" ? "done" : "review";
        case "approve": return current === "review" ? "done" : null;
        case "reject": return current === "review" ? "rejected" : null;
        case "reopen": return current === "done" || current === "rejected" || current === "review" ? "todo" : null;
        case "remove":
        case "delete": return "removed";
        default: return null;
    }
}
