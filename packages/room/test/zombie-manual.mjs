/**
 * Opt-in regression test (not part of `pnpm test` because it takes ~30s).
 *
 *   node test/zombie-manual.mjs
 *
 * Reproduces the orphan-client storm that took the studio offline on 2026-09-12:
 * a relay that completes the WebSocket handshake but never answers relay.join.
 * Before 0.1.27 the client timed out, closed the socket, and the close handler
 * scheduled a reconnect — forever, with nobody able to cancel it, because
 * service.joinRoom throws before registering the client. Every retry pulled a
 * full room snapshot, which is what flooded the relay.
 *
 * Asserts the invariant that stops it: a client whose handshake never succeeded
 * must end up "closed" and must never reconnect on its own.
 */
import assert from "node:assert";
import { WebSocketServer } from "ws";
import { RoomClient } from "../lib/host/room-client.js";

const PORT = 59998;
let connections = 0;

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (socket) => {
  connections += 1;
  // Accept the handshake, then stay silent: exactly what a stalled or lossy
  // link looks like from the client's point of view.
  socket.on("message", () => {});
  socket.on("error", () => {});
});

const agent = {
  agentId: "test-agent-0000",
  nickname: "tester",
  capabilities: [],
  createdAt: new Date().toISOString(),
};

const client = new RoomClient({
  addresses: [`127.0.0.1:${PORT}`],
  roomId: "test-room-0000",
  agent,
  relay: `ws://127.0.0.1:${PORT}`,
});

const started = Date.now();
let rejected = false;
try {
  await client.connect();
} catch (error) {
  rejected = true;
  console.log(`  connect rejected after ${Date.now() - started}ms: ${error.message}`);
}

assert.ok(rejected, "connect() must reject when the relay never answers");

// The rejection fires before the socket's close event lands, so the connection
// state is still the "connecting" set at the top of connect(). Give the close
// handler its turn — that handler is where the old code scheduled the retry.
await new Promise((resolve) => setTimeout(resolve, 1500));
assert.equal(
  client.connState,
  "closed",
  `expected connState "closed", got "${client.connState}" (a "reconnecting" here means the retry was scheduled)`,
);
console.log(`  connState after failure: ${client.connState} (must not be "reconnecting")`);

const afterFailure = connections;
console.log(`  connections so far: ${afterFailure}`);

// Long enough to cover several old backoff rounds (the old code retried at
// ~1s, 2s, 4s …), short enough to keep this test usable by hand.
await new Promise((resolve) => setTimeout(resolve, 9000));

assert.equal(
  connections,
  afterFailure,
  `orphan client reconnected (${afterFailure} -> ${connections}); the zombie guard is not working`,
);
console.log(`  connections after 9s idle: ${connections} (unchanged = no zombie)`);

client.destroy();
wss.close();
console.log("ZOMBIE GUARD OK");
process.exit(0);
