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
