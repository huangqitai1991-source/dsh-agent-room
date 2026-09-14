/**
 * dsh-agent-room 0.1.42 — D-18: a dead room's local record must actually go away.
 *
 * THE DEFECT (field)
 *
 * A node kept reconnecting to CLOSED rooms forever. Two independent causes:
 *
 *   1. the cleanup predicate required `relay && record.address !== relay`
 *      (`service.ts:1166-1169`), but a dead RELAY-hosted room's record holds
 *      EXACTLY the relay address, so the condition could never be true — the
 *      retry storm the relay log shows (`buffered for owner-less room` → 20s
 *      timeout, every round);
 *   2. `leave` on such a room answered HTTP 500 (`gateway.leaveRoom` threw
 *      "房间不存在" when no live client existed), so the operator could not even
 *      clean it up by hand.
 *
 * WHAT THIS FILE PINS
 *
 *   A. the record is dropped because the JOIN RESULT says the room is gone
 *      (room-closed / room-not-found), not because an address heuristic guessed;
 *   B. `leave` is best-effort: a remote failure still deletes the local record and
 *      the HTTP route answers 200 (not 500);
 *   C. (0.1.42, the gap left open at HEAD) a RE-join refused by the owner while the
 *      node is running drops the record IMMEDIATELY — before this, the client gave
 *      up silently (`room-client.ts` "Terminal ... no point retrying") and
 *      joined.json kept the dead room until the next boot or mode switch.
 *
 * Old-vs-new evidence (the "old build" is the 0.1.25 lib, extracted from this
 * repo's own history with `git archive 187df0b lib`):
 *
 *   AR_LIB=<0.1.25 lib>  node test/stale-room.test.mjs   -> NEW assertions FAIL
 *   node test/stale-room.test.mjs                        -> all pass
 *
 * Loopback only, temp dirs only: no fleet service is started, stopped or
 * contacted. Run directly (never `node --test`).
 */

import assert from "node:assert";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";

const LIB = (() => {
  const raw = (process.env.AR_LIB ?? "../lib").replace(/\\/g, "/");
  if (raw.startsWith("file://")) return raw;
  return /^[a-zA-Z]:\//.test(raw) ? `file:///${raw}` : raw;
})();
process.env.DSH_IDENTITY_BACKUP_DIR = process.env.DSH_IDENTITY_BACKUP_DIR
  ?? join(tmpdir(), "ar-stale-backups");

const { AgentRoomService } = await import(`${LIB}/host/service.js`);
const { RoomService } = await import(`${LIB}/host/room-service.js`);
const { PeerServer } = await import(`${LIB}/host/peer-server.js`);
const { createRouter } = await import(`${LIB}/host/web.js`);

const OWNER_PORT = 19562;
const MEMBER_PORT = 19563;
const API_PORT = 19564;
const DEAD_PORT = 19565; // nothing ever listens here

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 10_000, step = 25) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(step);
  }
  return false;
};

let failures = 0;
const guarded = (name, fn) =>
  test(name, async (t) => {
    try {
      await fn(t);
    } catch (error) {
      failures += 1;
      throw error;
    }
  });

const dirs = [];
async function mk(tag) {
  const dir = await mkdtemp(join(tmpdir(), `ar-stale-${tag}-`));
  dirs.push(dir);
  return dir;
}

const joinedFile = (dir) => join(dir, "joined.json");
const readJoined = async (dir) => {
  try {
    return JSON.parse(await readFile(joinedFile(dir), "utf8"));
  } catch {
    return [];
  }
};

/** Wait for the fire-and-forget boot in AgentRoomService's constructor to settle
 *  (same helper as selfjoin.test.mjs: boot installs discovery + timers last). */
async function settled(svc) {
  const ok = await waitFor(() => svc.profileTimer != null && svc.listenTimer != null, 8_000);
  assert.ok(ok, "the service's background boot must settle before the test touches it");
  return svc;
}

async function shutdown(svc, orphans = []) {
  if (!svc) return;
  // Cancel the bounded-backoff rejoin timers (D-18: tracked for exactly this).
  // Untracked retries kept the process alive ~45s after the assertions had passed.
  try { svc.stopRejoinRetries?.(); } catch { /* older build */ }
  for (const client of svc.clients?.values?.() ?? []) {
    try { client.destroy(); } catch { /* ignore */ }
  }
  for (const orphan of [...orphans, svc.discovery]) {
    try { orphan?.stop?.(); } catch { /* ignore */ }
  }
  try { await svc.peerServer?.stop(); } catch { /* ignore */ }
  for (const timer of [svc.profileTimer, svc.listenTimer]) {
    try { if (timer) clearInterval(timer); } catch { /* ignore */ }
  }
}

guarded("D-18.A: a record whose room answers 'closed' is dropped at boot (decided by the JOIN RESULT)", async (t) => {
  const servers = [];
  let svc = null;
  try {
    // The owner serves the room, then closes it — the field situation.
    const ownerService = new RoomService({ dataDir: await mk("owner") });
    await ownerService.boot();
    const ownerServer = new PeerServer({ port: OWNER_PORT, service: ownerService, relay: "" });
    servers.push(ownerServer);
    await ownerServer.start();
    const room = await ownerService.createRoom({ title: "已关闭的房间", type: "persistent" });
    const address = `127.0.0.1:${OWNER_PORT}`;
    await ownerService.closeRoom(room.roomId);

    // The member node still holds a record for it (seeded before boot, the way a
    // node that was a member when the room died has it on disk).
    const memberDir = await mk("member");
    const seed = new RoomService({ dataDir: memberDir });
    await seed.boot();
    await seed.recordVisited(room.roomId, address, room.title);
    assert.strictEqual((await readJoined(memberDir)).length, 1, "precondition: one stale record on disk");

    // The old rule, verbatim from the ledger: `relay && record.address !== relay`.
    // For a dead RELAY-hosted room the stored address IS the relay, so the
    // predicate is false and the record can never be cleaned by it.
    const relay = "ws://127.0.0.1:9320";
    const relayHosted = { roomId: room.roomId, address: relay, lastVisitedAt: new Date().toISOString() };
    const legacyWouldDrop = Boolean(relay && relayHosted.address !== relay);
    console.log("[D-18.A] legacy predicate `relay && record.address !== relay` =", legacyWouldDrop, "for", JSON.stringify(relayHosted));
    assert.strictEqual(legacyWouldDrop, false, "the ledger's predicate is structurally unable to clean a relay-hosted dead room");

    svc = await settled(new AgentRoomService(new Context(), { dataDir: memberDir, port: MEMBER_PORT, relay: "" }));

    const gone = await waitFor(
      () => !svc.roomService.listJoinedRooms().some((r) => r.roomId === room.roomId),
      8_000,
    );
    console.log("[D-18.A] records left in memory after boot =", JSON.stringify(svc.roomService.listJoinedRooms()));
    console.log("[D-18.A] joined.json on disk =", JSON.stringify(await readJoined(memberDir)));
    assert.ok(
      gone,
      "a record whose room answers room-closed must be dropped: retrying it is what pinned a node to a dead room",
    );
    assert.strictEqual(
      (await readJoined(memberDir)).some((r) => r.roomId === room.roomId),
      false,
      "the drop must be persisted, or the next boot retries the dead room again",
    );
  } finally {
    await shutdown(svc);
    for (const s of servers) { try { await s.stop(); } catch { /* ignore */ } }
  }
});

guarded("D-18.B: leave on a dead room returns 200 and removes the local record (best-effort)", async (t) => {
  let svc = null;
  let server = null;
  try {
    const memberDir = await mk("leave");
    const deadRoom = "01a098a2-2015-7a1d-b5f7-9eca45afa65d";
    const seed = new RoomService({ dataDir: memberDir });
    await seed.boot();
    await seed.recordVisited(deadRoom, `127.0.0.1:${DEAD_PORT}`, "死房间");
    assert.strictEqual((await readJoined(memberDir)).length, 1, "precondition: a record pointing at a dead address");

    svc = await settled(new AgentRoomService(new Context(), { dataDir: memberDir, port: MEMBER_PORT + 1, relay: "" }));
    assert.ok(
      svc.roomService.listJoinedRooms().some((r) => r.roomId === deadRoom),
      "a transient failure (nothing listening) must KEEP the record — the owner may simply be offline",
    );

    // (1) The gateway contract the web route wraps.
    let threw = null;
    try {
      await svc.gateway.leaveRoom(deadRoom);
    } catch (error) {
      threw = error;
    }
    console.log("[D-18.B] gateway.leaveRoom on a dead room threw =", threw ? String(threw.message) : "nothing");
    assert.strictEqual(threw, null, `leave must be best-effort, it threw: ${threw && threw.message}`);
    assert.strictEqual(
      svc.roomService.listJoinedRooms().some((r) => r.roomId === deadRoom),
      false,
      "leave must forget the record locally even when the owner is unreachable",
    );
    assert.strictEqual((await readJoined(memberDir)).some((r) => r.roomId === deadRoom), false, "and persist that");

    // (2) The HTTP surface (the old build answered 500 here, which is what blocked
    // a manual cleanup). The record goes back through the RUNNING service, so both
    // its in-memory list and joined.json hold it again.
    await svc.roomService.recordVisited(deadRoom, `127.0.0.1:${DEAD_PORT}`, "死房间");
    assert.strictEqual(
      svc.roomService.listJoinedRooms().some((r) => r.roomId === deadRoom),
      true,
      "precondition for the HTTP check: the record is back",
    );
    server = createServer(createRouter(svc));
    await new Promise((resolve) => server.listen(API_PORT, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${API_PORT}/agent-room-api/rooms/${deadRoom}/leave`, {
      method: "POST",
      headers: { connection: "close" }, // do not keep the test server's close() waiting
    });
    const body = await response.json();
    console.log("[D-18.B] POST /leave ->", response.status, JSON.stringify(body));
    assert.strictEqual(response.status, 200, `leave on a dead room must answer 200, got ${response.status}`);
    assert.strictEqual(body.ok, true);
    assert.strictEqual((await readJoined(memberDir)).some((r) => r.roomId === deadRoom), false, "HTTP leave must clean up too");
  } finally {
    if (server) {
      // `close()` waits for every open connection; a keep-alive socket from the
      // fetch above would hold it (and the run) open forever.
      try { server.closeIdleConnections?.(); } catch { /* ignore */ }
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      await new Promise((resolve) => server.close(resolve));
    }
    await shutdown(svc);
  }
});

guarded("D-18.C: a re-join refused while the node is RUNNING drops the record immediately (not at the next boot)", async (t) => {
  const servers = [];
  let svc = null;
  try {
    const ownerService = new RoomService({ dataDir: await mk("owner-run") });
    await ownerService.boot();
    const ownerServer = new PeerServer({ port: OWNER_PORT + 10, service: ownerService, relay: "" });
    servers.push(ownerServer);
    await ownerServer.start();
    const room = await ownerService.createRoom({ title: "先开着再关", type: "persistent" });
    const address = `127.0.0.1:${OWNER_PORT + 10}`;

    svc = await settled(new AgentRoomService(new Context(), { dataDir: await mk("member-run"), port: MEMBER_PORT + 10, relay: "" }));
    await svc.gateway.joinRoom([address], { roomId: room.roomId });
    assert.ok(
      await waitFor(() => svc.clients.get(room.roomId)?.connected === true, 8_000),
      "the member must be connected before the room is closed",
    );
    assert.ok(svc.roomService.listJoinedRooms().some((r) => r.roomId === room.roomId), "the join must be recorded locally");

    // The room dies while this node is running, and its socket drops — so the
    // reconnect happens NOW, not at the next boot. Join attempts are counted on the
    // OWNER side: "terminal" has to mean the node stops dialling a dead room, not
    // just that it forgot the record.
    let joinAttempts = 0;
    {
      const original = ownerService.joinOwnedRoom.bind(ownerService);
      ownerService.joinOwnedRoom = (...args) => {
        joinAttempts += 1;
        return original(...args);
      };
    }
    await ownerService.closeRoom(room.roomId);
    let dropped = 0;
    for (const [socket] of ownerServer.sockets ?? []) {
      try { socket.close(4009, "test-drop"); dropped += 1; } catch { /* ignore */ }
    }
    console.log("[D-18.C] owner-side member sockets dropped =", dropped);
    assert.ok(dropped > 0, "precondition: the member had a live socket on the owner");

    const gone = await waitFor(
      () => !svc.roomService.listJoinedRooms().some((r) => r.roomId === room.roomId),
      12_000,
    );
    console.log("[D-18.C] records left =", JSON.stringify(svc.roomService.listJoinedRooms()));
    assert.ok(
      gone,
      "the owner answered the re-join with room-closed: the local record must go now, not on the next boot",
    );

    // The refusal must actually STOP the client. Before the fix the failed attempt's
    // socket closed and its close handler re-armed another attempt a second later,
    // rejected again — dialling a dead room for as long as the process lived.
    const attemptsAtDrop = joinAttempts;
    await wait(2_500);
    console.log("[D-18.C] owner-side join attempts: at drop =", attemptsAtDrop, "| 2.5s later =", joinAttempts);
    assert.strictEqual(
      joinAttempts,
      attemptsAtDrop,
      "a room that answers 'join rejected' must not be dialled again (the old build re-armed every second)",
    );
    assert.strictEqual(svc.clients.get(room.roomId), undefined, "the refused client must be detached from the service");
  } finally {
    await shutdown(svc);
    for (const s of servers) { try { await s.stop(); } catch { /* ignore */ } }
  }
});

after(async () => {
  // Bounded on purpose: on Windows a temp dir can still be held by a socket/timer
  // from a service that is shutting down, and an rm that never returns would hang
  // the run forever (no summary, watchdog exit only). Temp files are disposable.
  const cleanup = Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 }).catch(() => {})),
  );
  await Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, 2_000))]);
});

/**
 * AgentRoomService does not stop its own rejoin timers when a test ends; if one is
 * still holding the event loop this watchdog ends the process after every
 * assertion has run (same idiom as selfjoin.test.mjs).
 */
const watchdog = setTimeout(() => process.exit(failures > 0 ? 1 : 0), 30_000);
watchdog.unref();
