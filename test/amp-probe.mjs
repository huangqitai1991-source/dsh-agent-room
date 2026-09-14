/**
 * P0 amplification probe (diagnostic, NOT part of the release suite).
 *
 * Reproduces the production wiring of a DSH node locally:
 *
 *   owner node  : RoomService + PeerServer  (owns the room)
 *   member A    : RoomClient, joined        (the "controller/lead" sender)
 *   member B    : RoomClient, joined        (the exec target)
 *
 * The wiring that matters is copied from src/host/service.ts:
 *
 *   client.on("chat", m => this.roomService.emit("chat", roomId, m))   // :1142
 *   client.on("snapshot", () => this.flushOutQueue(roomId, "snapshot")) // :1162
 *   client.on("connection", s => { if (s === "open") this.flushOutQueue() }) // :1156
 *
 * and PeerServer's own `service.on("chat") -> broadcast()` listener, which is
 * built into the class in production.
 *
 * Safety: 127.0.0.1 only, hard cap on deliveries, hard wall-clock deadline,
 * every socket destroyed in `finally`. It starts and touches no DSH service.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomService } from "../lib/host/room-service.js";
import { PeerServer } from "../lib/host/peer-server.js";
import { RoomClient } from "../lib/host/room-client.js";
import { OutboundHub } from "../lib/host/outbound.js";

const BASE_PORT = 19420;
const ROOM_PORT = BASE_PORT;
const CAP = 400;            // stop the experiment past this many deliveries
const DEADLINE_MS = 12_000; // and past this wall clock

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

const log = (...a) => console.log(...a);

async function main() {
  const dirs = [];
  const mk = async (tag) => {
    const d = await mkdtemp(join(tmpdir(), `amp-${tag}-`));
    dirs.push(d);
    return d;
  };
  const clients = [];
  const servers = [];

  try {
    // ---------------- owner node ----------------
    const ownerDir = await mk("owner");
    const owner = new RoomService({ dataDir: ownerDir, onNeedServer: undefined });
    await owner.boot();
    await owner.ensureIdentity();
    const ownerServer = new PeerServer({ port: ROOM_PORT, service: owner });
    servers.push(ownerServer);
    await ownerServer.start();
    const room = await owner.createRoom({ title: "amp-probe", type: "persistent" });
    const roomId = room.roomId;
    log(`[setup] owner room ${roomId} on 127.0.0.1:${ROOM_PORT}`);

    // ---------------- member nodes ----------------
    const makeMember = async (tag, agentId, port) => {
      const dir = await mk(tag);
      const service = new RoomService({ dataDir: dir, onNeedServer: undefined });
      await service.boot();
      // A member node still runs its own peer server in production.
      const server = new PeerServer({ port, service });
      servers.push(server);
      await server.start();

      const client = new RoomClient({
        addresses: [`127.0.0.1:${ROOM_PORT}`],
        roomId,
        agent: { agentId, nickname: tag, capabilities: [], createdAt: new Date().toISOString() },
        onJoinedRecord: () => {},
      });
      clients.push(client);
      await client.connect();
      await waitFor(() => client.connected, 5_000);

      const outbound = new OutboundHub();
      const deliveries = [];   // every frame handed to the local room bus
      const flushOutQueue = () => {
        const q = outbound.peek(roomId);
        if (q && q.length > 0) outbound.flush(roomId, client);
      };

      // ---- production wiring, verbatim in spirit ----
      client.on("chat", (message) => {
        deliveries.push({ at: Date.now(), from: message.from, text: message.text, seq: message.seq });
        service.emit("chat", roomId, message);   // service.ts:1142
      });
      client.on("connection", (state) => { if (state === "open") flushOutQueue(); }); // service.ts:1156
      client.on("snapshot", () => flushOutQueue("snapshot"));                          // service.ts:1162

      return { tag, agentId, service, server, client, outbound, deliveries, flushOutQueue,
        send: (text) => outbound.send(roomId, { text }, client) };
    };

    const A = await makeMember("A", "01a0231b-bbe5-720a-97a4-819744eeae76", BASE_PORT + 1);
    const B = await makeMember("B", "01a09461-351d-793d-bf49-b8e08641f082", BASE_PORT + 2);
    await wait(300);

    // ---- exec reactor on B: mirror of agent-org ExecPlane.handleInstruction ----
    // It ALWAYS answers a delivery of an instruction addressed to it (0.2.10),
    // and executes at most once per id.
    const EXEC = "[org:exec]";
    const RES = "[org:exec:result]";
    const execId = "d15-before-20260913-1633";
    const decoder = (line) => {
      if (typeof line !== "string" || !line.startsWith(EXEC.slice(0, 5))) return null;
      const body = line.slice(line.indexOf("]") + 1);
      try { return JSON.parse(body); } catch { return null; }
    };
    let executed = 0;
    let answers = 0;
    B.service.on("chat", (rid, message) => {
      if (rid !== roomId) return;
      const text = String(message?.text ?? "");
      if (!text.startsWith(EXEC)) return;
      const instruction = decoder(text);
      if (!instruction || instruction.targetAgentId !== B.agentId) return;
      if (executed === 0) executed = 1;
      answers += 1;
      // always answer (cache hit or fresh) -- exactly what 0.2.10 does
      B.send(`${RES}${JSON.stringify({ id: instruction.id, by: B.agentId, ok: true, code: 0, stdout: "ok", stderr: "", timedOut: false })}`);
    });
    A.service.on("chat", (rid, message) => {
      if (rid !== roomId) return;
      const text = String(message?.text ?? "");
      if (text.startsWith(RES)) return; // controller side: nothing to send back
    });

    // ---------------- the one send ----------------
    log("[probe] ONE control frame from A");
    const t0 = Date.now();
    const outcome = A.send(`${EXEC}${JSON.stringify({ id: execId, targetAgentId: B.agentId, command: "echo probe", ts: new Date().toISOString() })}`);
    log(`[probe] outbound.send -> ${JSON.stringify(outcome)}`);

    // watch until quiet, cap, or deadline
    let last = -1;
    while (Date.now() - t0 < DEADLINE_MS) {
      await wait(250);
      if (B.deliveries.length >= CAP) { log("[probe] CAP reached, aborting wait"); break; }
      if (B.deliveries.length === last && Date.now() - t0 > 2_000) break;
      last = B.deliveries.length;
    }

    const isInstruction = (t) => String(t).startsWith(EXEC) && String(t).includes(execId);
    const isAnswer = (t) => String(t).startsWith(RES) && String(t).includes(execId);
    const mine = B.deliveries.filter((d) => isInstruction(d.text));
    const answersSeenAtB = B.deliveries.filter((d) => isAnswer(d.text)).length;
    const span = mine.length > 1 ? mine[mine.length - 1].at - mine[0].at : 0;
    const stored = (await owner.recentMessages(roomId, 500)).filter((m) => isInstruction(m.text)).length;
    const storedAll = (await owner.recentMessages(roomId, 500)).length;

    log("");
    log("================ RESULT ================");
    log(`INSTRUCTION deliveries at B    : ${mine.length}`);
    log(`result frames seen at B        : ${answersSeenAtB}`);
    log(`total frames at B              : ${B.deliveries.length}`);
    log(`first->last delivery span      : ${span} ms`);
    log(`answers sent by B              : ${answers}   (executed once: ${executed === 1})`);
    log(`owner store: copies of instr   : ${stored}   (rows total: ${storedAll})`);
    log(`A deliveries total             : ${A.deliveries.length}`);
    log(`AMPLIFICATION (deliveries/send): ${mine.length}x`);
    log("========================================");
  } finally {
    for (const c of clients) { try { c.destroy(); } catch { /* ignore */ } }
    for (const s of servers) { try { await s.stop(); } catch { /* ignore */ } }
    for (const d of dirs) { try { await rm(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("PROBE FAILED:", e); process.exit(1); });
