/**
 * dsh-agent-room 0.1.36 — delivery amplification (P0) regression.
 *
 * The defect: a frame this node RECEIVED could be re-broadcast by this node.
 * service.ts re-emits every inbound joined-room frame on the local `roomService`
 * bus (so agent-org's exec plane sees it) and PeerServer listens to that same bus
 * and turns it into a network broadcast. A node holding a live client on a room it
 * serves therefore re-received its own broadcast, re-emitted it, and fanned it out
 * again — a store-free cycle. Measured on 0.1.35: ONE send produced 3638
 * deliveries in 195 ms to every member, while the owner's store held ONE row
 * (field: 862 deliveries of one id from ~8 stored copies, `executed=1`,
 * `skipped(replay)=861`).
 *
 * Acceptance: ONE send => exactly ONE delivery per recipient, while any number of
 * deliveries still yields an identical result on the receiver (that half is
 * agent-org 0.2.10's ExecResultCache, covered by test/exec-cache.test.mjs).
 *
 * Everything runs on 127.0.0.1 in this throwaway process; no DSH service is
 * started, stopped or contacted.
 */

import assert from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomService } from "../lib/host/room-service.js";
import { PeerServer } from "../lib/host/peer-server.js";
import { RoomClient } from "../lib/host/room-client.js";

const PORT = 19460;
const SETTLE_MS = 1_500;

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

/** The production wiring of a joined room (service.ts:1138-1163). */
function wireInbound(node, roomId, sink) {
  node.client.on("chat", (message) => {
    sink.push(message.text);
    node.service.emit("chat", roomId, message);   // service.ts:1142
  });
}

test("a frame re-emitted on the local bus is broadcast only once (the amplifier choke)", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "ar-amp-bus-"));
  const service = new RoomService({ dataDir, onNeedServer: undefined });
  const server = new PeerServer({ port: PORT, service });
  let client = null;
  try {
    await service.boot();
    const owner = await service.ensureIdentity();
    await server.start();
    const room = await service.createRoom({ title: "amp-bus", type: "persistent" });

    client = new RoomClient({
      addresses: [`127.0.0.1:${PORT}`],
      roomId: room.roomId,
      agent: { agentId: "member-amp", nickname: "amp", capabilities: [], createdAt: new Date().toISOString() },
      onJoinedRecord: () => {},
    });
    await client.connect();
    await waitFor(() => client.connected, 5_000);

    const seen = [];
    client.on("chat", (message) => seen.push(message.text));

    const message = await service.addChatMessage(room.roomId, owner, { text: "[org:exec]{\"id\":\"amp-1\"}" });
    assert.ok(await waitFor(() => seen.length >= 1, 3_000), "the member received the frame");

    // Exactly the feedback a self-join produced: the frame the node already
    // received is re-emitted on the bus that PeerServer listens to (service.ts:1142
    // feeds this very bus). Before 0.1.36 each emit was broadcast again, so a node
    // with a member socket on its own room fanned the same frame out forever.
    service.emit("chat", room.roomId, message);
    service.emit("chat", room.roomId, message);
    await wait(SETTLE_MS);

    assert.strictEqual(seen.length, 1, `one stored frame must be delivered once, got ${seen.length}`);
  } finally {
    client?.destroy();
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("one send is one delivery per recipient even with a live self-join client", async (t) => {
  const dirs = [];
  const mk = async (tag) => {
    const d = await mkdtemp(join(tmpdir(), `ar-amp-${tag}-`));
    dirs.push(d);
    return d;
  };
  const clients = [];
  const servers = [];
  try {
    // ---- owner node ----
    const ownerService = new RoomService({ dataDir: await mk("owner"), onNeedServer: undefined });
    await ownerService.boot();
    const owner = await ownerService.ensureIdentity();
    const ownerServer = new PeerServer({ port: PORT + 1, service: ownerService });
    servers.push(ownerServer);
    await ownerServer.start();
    const room = await ownerService.createRoom({ title: "amp-selfjoin", type: "persistent" });

    // ---- the pathological wiring: this node serves the room AND holds a member
    // client for it (what a manual join to your own address did before 0.1.36) ----
    const selfClient = new RoomClient({
      addresses: [`127.0.0.1:${PORT + 1}`],
      roomId: room.roomId,
      agent: owner,
      onJoinedRecord: () => {},
    });
    clients.push(selfClient);
    await selfClient.connect();
    await waitFor(() => selfClient.connected, 5_000);
    const selfSeen = [];
    wireInbound({ client: selfClient, service: ownerService }, room.roomId, selfSeen);

    // ---- a normal remote member ----
    const memberService = new RoomService({ dataDir: await mk("B"), onNeedServer: undefined });
    await memberService.boot();
    const memberServer = new PeerServer({ port: PORT + 2, service: memberService });
    servers.push(memberServer);
    await memberServer.start();
    const memberClient = new RoomClient({
      addresses: [`127.0.0.1:${PORT + 1}`],
      roomId: room.roomId,
      agent: { agentId: "01a09461-351d-793d-bf49-b8e08641f082", nickname: "B", capabilities: [], createdAt: new Date().toISOString() },
      onJoinedRecord: () => {},
    });
    clients.push(memberClient);
    await memberClient.connect();
    await waitFor(() => memberClient.connected, 5_000);
    const seen = [];
    wireInbound({ client: memberClient, service: memberService }, room.roomId, seen);

    await wait(300);

    const frame = "[org:exec]{\"id\":\"d15-before-20260913-1633\",\"targetAgentId\":\"01a09461-351d-793d-bf49-b8e08641f082\",\"command\":\"echo probe\"}";
    const send = memberClient.sendChat({ text: frame });
    assert.strictEqual(send, true, "the frame went out on an open socket");

    await waitFor(() => seen.length >= 1, 3_000);
    await wait(SETTLE_MS);

    assert.strictEqual(seen.length, 1, `ONE send must be ONE delivery, got ${seen.length}`);
    assert.strictEqual(selfSeen.length, 1, `the author's own echo is one delivery too, got ${selfSeen.length}`);
    const stored = (await ownerService.recentMessages(room.roomId, 100)).filter((m) => m.text === frame).length;
    assert.strictEqual(stored, 1, `one send must be one stored row, got ${stored}`);
  } finally {
    for (const c of clients) { try { c.destroy(); } catch { /* ignore */ } }
    for (const s of servers) { try { await s.stop(); } catch { /* ignore */ } }
    for (const d of dirs) { try { await rm(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
});
