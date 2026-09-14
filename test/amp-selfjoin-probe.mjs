/**
 * P0 amplification probe #2 — self-join echo loop (diagnostic, not a release test).
 *
 * Hypothesis: a node that OWNS a room AND holds a live RoomClient joined to that
 * same room re-broadcasts every inbound frame it receives (service.ts:1142 feeds
 * the local bus, and PeerServer's own `service.on("chat") -> broadcast()` listener
 * turns that into a fresh broadcast to every member socket, including its own).
 * That is the only way a frame can be delivered N times while the owner's STORE
 * keeps only one copy per send.
 *
 * Wiring is copied from src/host/service.ts:
 *   client.on("chat", m => this.roomService.emit("chat", roomId, m))       // :1142
 *   client.on("snapshot"|"connection", () => this.flushOutQueue(...))      // :1156/:1162
 *
 * Safety: 127.0.0.1 only, hard delivery cap, hard wall-clock deadline and a
 * force-exit watchdog. Starts and touches no DSH service.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomService } from "../lib/host/room-service.js";
import { PeerServer } from "../lib/host/peer-server.js";
import { RoomClient } from "../lib/host/room-client.js";
import { OutboundHub } from "../lib/host/outbound.js";

const PORT = 19440;
const CAP = 300;
const DEADLINE_MS = 6_000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 8_000, step = 25) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(step);
  }
  return null;
};

const clients = [];
const servers = [];
const dirs = [];

const hardStop = setTimeout(() => { console.error("[watchdog] forcing exit"); process.exit(2); }, 25_000);
hardStop.unref?.();

function wire(node, roomId) {
  const outbound = new OutboundHub();
  const client = node.client;
  const flush = () => { const q = outbound.peek(roomId); if (q && q.length > 0) outbound.flush(roomId, client); };
  const deliveries = [];
  client.on("chat", (message) => {
    deliveries.push({ at: Date.now(), from: message.from, text: message.text, seq: message.seq });
    node.service.emit("chat", roomId, message);      // service.ts:1142
  });
  client.on("connection", (state) => { if (state === "open") flush(); });
  client.on("snapshot", () => flush());
  node.deliveries = deliveries;
  node.outbound = outbound;
  node.send = (text) => outbound.send(roomId, { text }, client);
}

async function main() {
  const mk = async (tag) => { const d = await mkdtemp(join(tmpdir(), `sj-${tag}-`)); dirs.push(d); return d; };

  const owner = new RoomService({ dataDir: await mk("owner"), onNeedServer: undefined });
  await owner.boot();
  await owner.ensureIdentity();
  const server = new PeerServer({ port: PORT, service: owner });
  servers.push(server);
  await server.start();
  const room = await owner.createRoom({ title: "selfjoin-probe", type: "persistent" });
  const roomId = room.roomId;
  console.log(`[setup] owner room ${roomId}`);

  // ---- the SELF-JOIN: this node owns the room and joins it (what POST /join or
  // room_join does today — joinRoom has no self-check, only recordJoinedRecord
  // refuses to persist the record, which does not stop the live client).
  const selfClient = new RoomClient({
    addresses: [`127.0.0.1:${PORT}`],
    roomId,
    agent: await owner.ensureIdentity(),
    onJoinedRecord: () => {},
  });
  clients.push(selfClient);
  await selfClient.connect();
  await waitFor(() => selfClient.connected, 5_000);
  const selfNode = { service: owner, client: selfClient };
  wire(selfNode, roomId);
  console.log(`[setup] SELF-JOIN client connected: ${selfClient.connected}`);

  // ---- a normal remote member (the "小麦" analogue) ----
  const bService = new RoomService({ dataDir: await mk("B"), onNeedServer: undefined });
  await bService.boot();
  const bServer = new PeerServer({ port: PORT + 1, service: bService });
  servers.push(bServer);
  await bServer.start();
  const bClient = new RoomClient({
    addresses: [`127.0.0.1:${PORT}`],
    roomId,
    agent: { agentId: "01a09461-351d-793d-bf49-b8e08641f082", nickname: "B", capabilities: [], createdAt: new Date().toISOString() },
    onJoinedRecord: () => {},
  });
  clients.push(bClient);
  await bClient.connect();
  await waitFor(() => bClient.connected, 5_000);
  const bNode = { service: bService, client: bClient };
  wire(bNode, roomId);
  console.log(`[setup] member B connected: ${bClient.connected}`);

  await wait(400);

  // ---- ONE send from the member ----
  const frame = `[org:exec]{"id":"d15-before-20260913-1633","targetAgentId":"01a09461-351d-793d-bf49-b8e08641f082","command":"echo probe"}`;
  console.log("[probe] ONE control frame from member B");
  const t0 = Date.now();
  bNode.send(frame);

  let last = -1;
  while (Date.now() - t0 < DEADLINE_MS) {
    await wait(200);
    if (bNode.deliveries.length >= CAP) { console.log("[probe] CAP reached — cutting the loop"); break; }
    if (bNode.deliveries.length === last && Date.now() - t0 > 1_500) break;
    last = bNode.deliveries.length;
  }

  // cut the loop before touching the store: destroy the self-join client first
  try { selfClient.destroy(); } catch { /* ignore */ }

  const mine = bNode.deliveries.filter((d) => d.text === frame);
  const span = mine.length > 1 ? mine[mine.length - 1].at - mine[0].at : 0;
  const storedRows = (await owner.recentMessages(roomId, 1000));
  const stored = storedRows.filter((m) => m.text === frame).length;

  console.log("");
  console.log("================ RESULT (self-join) ================");
  console.log(`INSTRUCTION deliveries at B : ${mine.length}`);
  console.log(`total frames at B           : ${bNode.deliveries.length}`);
  console.log(`first->last span            : ${span} ms`);
  console.log(`self-join node deliveries   : ${selfNode.deliveries.length}`);
  console.log(`owner STORE copies of frame : ${stored}  (rows read: ${storedRows.length})`);
  console.log(`AMPLIFICATION               : ${mine.length}x  (one send)`);
  console.log(`still reachable on 0.1.35   : ${mine.length > 1 ? "YES" : "NO"}`);
  console.log("===================================================");
}

main()
  .then(() => { for (const c of clients) { try { c.destroy(); } catch { /* ignore */ } } return Promise.all(servers.map((s) => s.stop().catch(() => {}))); })
  .then(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {}))))
  .then(() => process.exit(0))
  .catch((e) => { console.error("PROBE FAILED:", e); process.exit(1); });
