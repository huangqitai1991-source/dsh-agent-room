/**
 * dsh-agent-room 0.1.35 — end-to-end convergence of a member's room mirror.
 *
 * This is the acceptance test for the defect that started the release: a member's
 * read view held 11 messages with holes while the owner's store held 200
 * (maxSeq 270), and nothing ever pulled the missing ones back. A unit test of the
 * planner cannot prove convergence, so this file runs a REAL owner node
 * (RoomService + PeerServer) and a REAL member (RoomClient) in one process.
 *
 * Scope note: the fixture listens on 127.0.0.1 with an ephemeral-ish port for the
 * duration of the test only, in this throwaway process. No DSH service is started,
 * stopped or contacted — nothing here touches the caller's `dsh web`.
 *
 * Simulating loss: after the member has received the owner's frames, the test
 * removes a few rows from the member's projection. That IS the observed failure
 * mode — a frame lost in transit (bridge flap / reconnect / snapshot budget) shows
 * up exactly as "the read view does not have it" — and unlike a network-shim it is
 * deterministic.
 */

import assert from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomService } from "../lib/host/room-service.js";
import { PeerServer } from "../lib/host/peer-server.js";
import { RoomClient } from "../lib/host/room-client.js";

const PORT = 19317;

const waitFor = async (fn, timeout = 10_000, step = 50) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return null;
};

const visibleSeqs = (messages) => messages.filter((m) => !m.pending && m.seq > 0).map((m) => m.seq);

test("a member with holes and a lagging tail converges to the owner's message set", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "ar-backfill-e2e-"));
  const service = new RoomService({ dataDir, onNeedServer: undefined });
  const server = new PeerServer({ port: PORT, service });
  let client = null;

  // Count what the OWNER is asked for: the whole point of the design is that the
  // answer is bounded, and a "no storms" claim has to be measured somewhere.
  let fetchCalls = 0;
  const originalRange = service.messagesInRange.bind(service);
  service.messagesInRange = (roomId, from, to, limit) => {
    fetchCalls += 1;
    return originalRange(roomId, from, to, limit);
  };

  try {
    await service.boot();
    const owner = await service.ensureIdentity();
    await server.start();
    const room = await service.createRoom({ title: "backfill-e2e", type: "persistent" });

    const member = { agentId: "member-backfill", nickname: "m", capabilities: [], createdAt: new Date().toISOString() };
    client = new RoomClient({
      addresses: [`127.0.0.1:${PORT}`],
      roomId: room.roomId,
      agent: member,
      onJoinedRecord: () => {},
    });
    await client.connect();
    await waitFor(() => client.connected, 5_000);
    assert.ok(client.connected, "member connected to the owner");
    assert.strictEqual(client.snapshot?.latestChatSeq ?? 0, 0, "a fresh room has no visible seq yet");

    // The owner speaks. Interleaved control frames share the same seq counter but
    // never enter the read view (0.1.31+ rule), which is exactly what creates the
    // unfillable holes the settled-set rule has to handle.
    for (let i = 1; i <= 6; i += 1) {
      await service.addChatMessage(room.roomId, owner, { text: `chat-${i}` });
      if (i % 2 === 0) await service.addChatMessage(room.roomId, owner, { text: `[org:exec]{"id":"${i}"}` });
    }
    await waitFor(() => visibleSeqs(client.snapshot?.recentMessages ?? []).length >= 6);
    // seqs: 1 chat, 2 chat, 3 org, 4 chat, 5 chat, 6 org, 7 chat, 8 chat, 9 org
    assert.deepStrictEqual(visibleSeqs(client.snapshot?.recentMessages ?? []), [1, 2, 4, 5, 7, 8], "control frames are filtered out of the read view");

    // A local, still-unconfirmed send (0.1.34 optimistic row): the backfill must
    // never clobber it.
    const pendingRow = client.appendLocal({ text: "local-only, still pending" });
    assert.strictEqual(pendingRow.pending, true);
    assert.ok(pendingRow.seq < 0);

    // ---- phase 1: interior holes ----
    // The bridge flap: two visible frames never made it into the mirror (the live
    // "265, 266, [267], 268, …, 274" shape).
    const lost = new Set([2, 5]);
    client.snapshot.recentMessages = client.snapshot.recentMessages.filter((m) => !lost.has(m.seq));
    assert.deepStrictEqual(visibleSeqs(client.snapshot.recentMessages), [1, 4, 7, 8], "mirror now has holes");

    // The stream resumes: one more visible frame arrives (seq 10), which turns the
    // lost rows into provable holes.
    await service.addChatMessage(room.roomId, owner, { text: "chat-7" });
    const gapFilled = await waitFor(() => {
      const rows = visibleSeqs(client.snapshot?.recentMessages ?? []);
      return rows.join(",") === "1,2,4,5,7,8,10" ? rows : null;
    }, 12_000);
    assert.ok(gapFilled, `gaps were never filled (held ${JSON.stringify(visibleSeqs(client.snapshot?.recentMessages ?? []))})`);

    // ---- phase 2: the tail lags ----
    // Three visible frames are missing at the END, so the mirror's max seq sits
    // below the owner's: the lag case, with no live frame left to reveal it.
    const lostTail = new Set([7, 8, 10]);
    client.snapshot.recentMessages = client.snapshot.recentMessages.filter((m) => !lostTail.has(m.seq));
    assert.strictEqual(client.localLatestSeq(), 5, "mirror now lags the owner");

    const converged = await waitFor(() => {
      const rows = visibleSeqs(client.snapshot?.recentMessages ?? []);
      return rows.join(",") === "1,2,4,5,7,8,10" ? rows : null;
    }, 12_000);
    assert.ok(converged, `member never converged (held ${JSON.stringify(visibleSeqs(client.snapshot?.recentMessages ?? []))})`);

    // The member's VISIBLE max seq now equals the owner's own read-view max.
    const ownerVisible = (await service.recentMessages(room.roomId, 400)).filter((m) => !m.text.startsWith("[org:"));
    const ownerLatestChatSeq = ownerVisible[ownerVisible.length - 1].seq;
    assert.strictEqual(client.localLatestSeq(), ownerLatestChatSeq, "visible max seq equals the owner's latest visible seq");
    assert.strictEqual(client.syncState().ownerLatestChatSeq, ownerLatestChatSeq);
    assert.strictEqual(client.syncState().ownerLatestSeq, service.latestSeq(room.roomId), "owner's raw max seq is reported too (control frames included)");

    // No duplicates, and the pending row is untouched and still last.
    const rows = client.snapshot.recentMessages;
    const confirmed = visibleSeqs(rows);
    assert.strictEqual(new Set(confirmed).size, confirmed.length, "no duplicate seqs");
    assert.deepStrictEqual(confirmed, [1, 2, 4, 5, 7, 8, 10]);
    assert.strictEqual(rows.filter((m) => m.pending).length, 1, "the pending row survived the backfill");
    assert.strictEqual(rows[rows.length - 1].text, "local-only, still pending");

    // Control frames stayed out of the read view, but still reached the consumers
    // (agent-org's exec plane subscribes to the client's "chat" event, not to the
    // read view).
    assert.strictEqual(rows.filter((m) => m.text.startsWith("[org:")).length, 0, "no control frame in the read view");

    // Bounded work: a handful of ranges for a 5-seq catch-up, not a replay storm.
    const sync = client.syncState();
    assert.ok(sync.requestsSent <= 6, `requests stayed bounded (sent=${sync.requestsSent})`);
    assert.ok(fetchCalls <= 7, `owner answered a bounded number of range queries (calls=${fetchCalls})`);
    assert.strictEqual(sync.messagesAdded, 5, "exactly the five lost messages were pulled back");
    assert.ok(sync.converged, "sync state reports convergence");

    // Converged means QUIET: further rounds must not ask for anything. The org
    // frames' seqs (3, 6, 9) are holes in the seq sequence the member cannot fill —
    // settling them once is what stops the loop from asking forever.
    const sentBefore = sync.requestsSent;
    const callsBefore = fetchCalls;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.strictEqual(client.syncState().requestsSent, sentBefore, "a converged member stops asking");
    assert.strictEqual(fetchCalls, callsBefore, "the owner was not asked for anything new");
    // Every request the member made was answered with exactly one bounded range query.
    assert.strictEqual(fetchCalls, sentBefore, `one owner query per request (requests=${sentBefore}, queries=${fetchCalls})`);
  } finally {
    client?.destroy();
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the owner's echo is what confirms a send (and its absence is reported)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ar-backfill-e2e-echo-"));
  const service = new RoomService({ dataDir, onNeedServer: undefined });
  const server = new PeerServer({ port: PORT + 2, service });
  let client = null;
  try {
    await service.boot();
    await server.start();
    const room = await service.createRoom({ title: "backfill-e2e-echo", type: "persistent" });
    client = new RoomClient({
      addresses: [`127.0.0.1:${PORT + 2}`],
      roomId: room.roomId,
      agent: { agentId: "member-echo", nickname: "echo", capabilities: [], createdAt: new Date().toISOString() },
      onJoinedRecord: () => {},
    });
    await client.connect();
    await waitFor(() => client.connected, 5_000);

    // Accepted by the local hub AND confirmed by the owner: the echo carries the
    // owner's own seq. This is the field that makes "delivered" honest — before
    // 0.1.35 the sender could not tell these two facts apart.
    const accepted = client.awaitOwnerEcho("hello owner", 3_000);
    assert.strictEqual(client.sendChat({ text: "hello owner" }), true);
    const seq = await accepted;
    assert.ok(typeof seq === "number" && seq > 0, `the owner confirmed with a real seq (got ${seq})`);

    // A send that never reaches the owner resolves to null — the honest negative
    // that the old `delivered: true` could not express.
    const lost = await client.awaitOwnerEcho("never actually sent", 300);
    assert.strictEqual(lost, null);
  } finally {
    client?.destroy();
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("control frames still reach the room bus and never enter the read view", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ar-backfill-e2e-ctl-"));
  const service = new RoomService({ dataDir, onNeedServer: undefined });
  const server = new PeerServer({ port: PORT + 1, service });
  let client = null;
  try {
    await service.boot();
    const owner = await service.ensureIdentity();
    await server.start();
    const room = await service.createRoom({ title: "backfill-e2e-ctl", type: "persistent" });
    client = new RoomClient({
      addresses: [`127.0.0.1:${PORT + 1}`],
      roomId: room.roomId,
      agent: { agentId: "member-ctl", nickname: "ctl", capabilities: [], createdAt: new Date().toISOString() },
      onJoinedRecord: () => {},
    });
    await client.connect();
    await waitFor(() => client.connected, 5_000);

    const seen = [];
    client.on("chat", (message) => seen.push(message.text));
    await service.addChatMessage(room.roomId, owner, { text: "[org:exec]{\"id\":\"a\"}" });
    await service.addChatMessage(room.roomId, owner, { text: "normal chat" });
    await waitFor(() => seen.length >= 2);

    assert.deepStrictEqual(seen, ["[org:exec]{\"id\":\"a\"}", "normal chat"], "the bus still sees control frames");
    assert.deepStrictEqual(visibleSeqs(client.snapshot.recentMessages), [2], "the read view does not");
  } finally {
    client?.destroy();
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
