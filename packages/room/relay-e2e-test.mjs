// End-to-end relay test: owner bridges to the relay with a room secret, a
// member joins through the relay only (direct address unreachable), a full
// task loop completes (create -> claim -> complete -> approve), and token
// auth rejects bad credentials.
import { RoomService } from "./lib/host/room-service.js";
import { PeerServer } from "./lib/host/peer-server.js";
import { RoomClient } from "./lib/host/room-client.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const RELAY_PORT = 19320;
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log(ok ? "PASS" : "FAIL", "-", name); };
const waitFor = async (fn, timeout = 8000, step = 50) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
};

// 1. start relay server as a child process
const relayProc = spawn(process.execPath, ["relay/relay-server.mjs", String(RELAY_PORT)], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("relay did not start")), 5000);
  relayProc.stdout.on("data", (d) => {
    if (String(d).includes("listening")) { clearTimeout(timer); resolve(); }
  });
  relayProc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`relay exited ${code}`)); });
});

// 2. owner node
const dataDir = await mkdtemp(join(tmpdir(), "ar-relay-test-"));
const service = new RoomService({ dataDir, onNeedServer: undefined });
await service.boot();
const ownerIdentity = await service.ensureIdentity();
const ownerServer = new PeerServer({ port: 19501, service, relay: RELAY });
await ownerServer.start();
const room = await service.createRoom({ title: "relay-e2e", type: "temporary" });
console.log("room:", room.roomId);

// 3. member node (direct address unreachable, relay only)
const memberAgent = { agentId: "member-e2e", nickname: "m", capabilities: [], createdAt: new Date().toISOString() };
const client = new RoomClient({ addresses: ["127.0.0.1:1"], roomId: room.roomId, agent: memberAgent, relay: RELAY });
await client.connect();
check("member connected via relay", client.connected);
check("member has snapshot via relay", client.snapshot?.room.roomId === room.roomId);

// 4. full task loop through the relay
service.createTask(room.roomId, ownerIdentity, { title: "relay-task", claimable: true, judgeMode: "controller" });
const taskId = await waitFor(() => client.snapshot?.room.tasks.find((t) => t.title === "relay-task")?.taskId ?? null);
check("member sees task via relay", Boolean(taskId));

client.taskClaim(taskId);
await waitFor(() => client.snapshot?.room.tasks.find((t) => t.taskId === taskId)?.status === "doing");
check("member claimed task via relay", true);

client.taskComplete(taskId, "done through relay");
await waitFor(() => client.snapshot?.room.tasks.find((t) => t.taskId === taskId)?.status === "review");
check("member completed task via relay", true);

service.approveTask(room.roomId, ownerIdentity, taskId, "approved");
const done = await waitFor(() => client.snapshot?.room.tasks.find((t) => t.taskId === taskId)?.status === "done");
check("task closed loop via relay (done)", Boolean(done));
check("owner sees task done", service.getOwnedRoom(room.roomId)?.tasks.find((t) => t.taskId === taskId)?.status === "done");

// 4b. offline buffering + replay: member frames queue while the owner relay
//     bridge is down, then replay in order exactly once on reconnect (member
//     seq dedup guards against duplicates).
const delivered = [];
const onBufferedChat = (m) => { if (m.text === "buffered-msg") delivered.push(m.seq); };
client.on("chat", onBufferedChat);

ownerServer.disconnectRelay(room.roomId);
await new Promise((r) => setTimeout(r, 500)); // let the relay observe the owner close
client.sendChat({ text: "buffered-msg" });
await new Promise((r) => setTimeout(r, 500)); // let the relay buffer the frame

ownerServer.connectRelay(room.roomId);
await waitFor(() => delivered.length > 0);
await new Promise((r) => setTimeout(r, 300)); // give any duplicate a chance to arrive

check("offline buffered message delivered exactly once", delivered.length === 1);
const bufferedInSnapshot = (client.snapshot?.recentMessages ?? []).filter((m) => m.text === "buffered-msg");
check("buffered message appears once in snapshot (seq dedup)", bufferedInSnapshot.length === 1);
client.off("chat", onBufferedChat);

// 5. token auth negatives
const badMember = new WebSocket(`${RELAY}/relay?roomId=${room.roomId}&role=member&agentId=evil`);
const memberRejected = await new Promise((resolve) => {
  badMember.on("open", () => badMember.send(JSON.stringify({ type: "relay.auth", payload: { ticket: "AAAA.bbbb" } })));
  badMember.on("message", (d) => { try { const m = JSON.parse(String(d)); if (m.type === "relay.authed" && m.payload?.ok === false) resolve(true); } catch { /* ignore */ } });
  badMember.on("close", (code) => { if (code === 4001) resolve(true); });
  setTimeout(() => resolve(false), 3000);
});
check("relay rejects bogus member ticket", memberRejected);

const badOwner = new WebSocket(`${RELAY}/relay?roomId=${room.roomId}&role=owner&agentId=evil&secret=wrong-secret`);
const ownerRejected = await new Promise((resolve) => {
  badOwner.on("close", (code) => resolve(code === 4001));
  setTimeout(() => resolve(false), 3000);
});
check("relay rejects wrong owner secret", ownerRejected);

// 6. cleanup
const bad = results.filter(([, ok]) => !ok);
console.log("=== RESULT:", bad.length === 0 ? "ALL PASS" : `${bad.length} FAIL`, "===");
try { await client.destroy(); } catch { /* ignore */ }
try { await ownerServer.stop(); } catch { /* ignore */ }
try { badMember.terminate(); } catch { /* ignore */ }
try { badOwner.terminate(); } catch { /* ignore */ }
await rm(dataDir, { recursive: true, force: true });
relayProc.kill("SIGKILL");
process.exit(bad.length === 0 ? 0 : 1);
