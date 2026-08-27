// End-to-end relay test: owner bridges a room to the relay, a member joins
// through the relay only (direct address is unreachable), chat flows both ways.
import { RoomService } from "./lib/host/room-service.js";
import { PeerServer } from "./lib/host/peer-server.js";
import { RoomClient } from "./lib/host/room-client.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RELAY = "ws://127.0.0.1:9320";
const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log(ok ? "PASS" : "FAIL", "-", name); };

const dataDir = await mkdtemp(join(tmpdir(), "ar-relay-test-"));
const service = new RoomService({ dataDir, onNeedServer: undefined });
await service.boot();
const ownerIdentity = await service.ensureIdentity();

// Owner: peer server on a local port, bridged to the relay.
const ownerServer = new PeerServer({ port: 19501, service, relay: RELAY });
await ownerServer.start();

const room = await service.createRoom({ title: "relay-e2e", type: "temporary" });
console.log("room:", room.roomId);

// Member: direct addresses are unreachable (port 1), relay fallback.
const memberAgent = { agentId: "member-e2e", nickname: "m", capabilities: [], createdAt: new Date().toISOString() };
const client = new RoomClient({
  addresses: ["127.0.0.1:1"],
  roomId: room.roomId,
  agent: memberAgent,
  relay: RELAY,
});

let gotBroadcast = false;
client.on("chat", (msg) => {
  if (msg.from === memberAgent.agentId && msg.text === "hello via relay") {
    gotBroadcast = true;
    check("member receives own broadcast back through relay", true);
    finish();
  }
});

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  setTimeout(async () => {
    check("member joined with snapshot", client.snapshot?.room.roomId === room.roomId);
    check("owner has member in room", service.getOwnedRoom(room.roomId)?.members.some((m) => m.agentId === memberAgent.agentId) ?? false);
    check("member got chat broadcast", gotBroadcast);
    const bad = results.filter(([, ok]) => !ok);
    console.log("=== RESULT:", bad.length === 0 ? "ALL PASS" : `${bad.length} FAIL`, "===");
    try { await client.destroy(); } catch {}
    try { await ownerServer.stop(); } catch {}
    await rm(dataDir, { recursive: true, force: true });
    process.exit(bad.length === 0 ? 0 : 1);
  }, 500);
}

await client.connect();
check("member connected via relay", client.connected);
client.sendChat({ text: "hello via relay" });

// Safety timeout
setTimeout(() => { if (!finished) { check("timeout waiting for broadcast", false); finish(); } }, 8000);
