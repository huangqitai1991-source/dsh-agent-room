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
