/**
 * dsh-agent-room 0.1.42 — card ⑤ / D-19: `rooms[].bridge` must describe the
 * connection that is ACTUALLY in use, and must never contradict `confirmedByOwner`.
 *
 * THE DEFECT (measured twice, in BOTH directions, on three machines)
 *
 *  C relay → lan: POST /agent-room-api/mode {"mode":"lan","address":"192.168.31.82:9317"}
 *                    returned ok:true (relay=off) and a 3 s re-read still showed
 *                    bridge={"kind":"relay","state":"closed","address":"ws://relay.example:9320"}
 *                    while POST /chat answered confirmedByOwner:true, confirmedSeq:2518.
 *  B lan → relay: POST /agent-room-api/mode {"mode":"relay"} returned ok:true and the
 *                    state showed bridge=direct/closed.
 *  主控 did NOT reproduce it: direct/open then relay/open, correctly.
 *
 * THE MECHANISM (src/host/service.ts)
 *
 *  - `connInfo` is one record per room and every RoomClient writes it from its own
 *    `connection` callback. It held exactly two writers before 0.1.42 (:1517 in the
 *    status listener, :1528 right after `connect()`), both capturing their own
 *    `client` in a closure.
 *  - A connection-mode switch re-joins every joined room through
 *    `gateway.joinRoom()`, which builds a NEW RoomClient, DESTROYS the previous one
 *    and calls `clients.set(roomId, newClient)` (:1478-1529).
 *  - `destroy()` (room-client.ts:986) only closes the socket; the socket `close`
 *    event is asynchronous, and the dead client's handler still fires afterwards:
 *    room-client.ts:416-425 emits "reconnecting", or :452-455 emits "closed" when
 *    its re-handshake is rejected. Both went straight into the same Map entry.
 *  ⇒ the record's final writer is the DEAD connection. 主控 did not reproduce it
 *    because on that machine the new client's write happened to land last: the bug
 *    is a last-writer-wins race over one Map entry, not a machine difference.
 *
 * WHAT THIS FILE PROVES (real services on loopback, real RoomClient objects)
 *   1. after a re-join through a DIFFERENT address, the bridge follows the live
 *      connection (relay/direct, state, address) — the acceptance criterion;
 *   2. a status report from a client that is no longer the live one CANNOT change
 *      the record any more (this is the assertion that fails on 0.1.41);
 *   3. `bridge` and the owner-confirmed delivery path agree — the record never says
 *      "closed" while the channel is open;
 *   4. the reader prefers the live client even if a stale record is forced in:
 *      one source of truth, no second truth left behind;
 *   5. static guard: the dead-client writer is gone from the source.
 *
 * Nothing here starts, stops or touches any real service: every port is an
 * ephemeral loopback port inside this process, and every dataDir is a temp dir.
 * (The `[agent-room] backup root ... is NOT writable (EPERM)` line on stderr is
 * 0.1.38 behaviour under this session's file sandbox — it REFUSES to overwrite
 * without a backup — and is unrelated to this suite.)
 * Run directly: `node test/bridge-state.test.mjs` (never `node --test`).
 */

import assert from "node:assert";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { AgentRoomService } from "../lib/host/service.js";

/**
 * `AR_LIB` points the suite at another build's lib directory (the 0.1.41 gate uses
 * it to run the SAME assertions against the OLD deployed build, so "the new
 * assertions fail on the old build" is a measurement and not a claim).
 * `AR_SRC` points the static guards at the matching SOURCE tree.
 */
const AR_LIB = process.env.AR_LIB;
const SRC_ROOT = process.env.AR_SRC ? dirname(process.env.AR_SRC) : null;
const libService = AR_LIB ? await import(pathToFileURL(join(AR_LIB, "host", "service.js")).href) : null;
const ServiceClass = libService ? libService.AgentRoomService : AgentRoomService;

const ROOT = SRC_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)));
const OWNER_PORT = 19611;
const MEMBER_PORT = 19612;

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

/** Every node this file starts — see the `after` hook: a failing assertion can skip
 *  the rest of a test body (and therefore its `stopNode(owner)`), which on the 0.1.41
 *  comparison build leaked a whole service and made the process hang for good. */
const NODES = new Set();

/** Temp data dir + a real AgentRoomService, torn down without touching anything else. */
async function startNode(port) {
  const dir = await mkdtemp(join(tmpdir(), "ar-bridge-"));
  const svc = new ServiceClass(new Context(), { dataDir: dir, port, relay: "" });
  // boot() is fire-and-forget (service.ts constructor); `peerServer` is assigned in
  // its middle, right before the timers, so waiting for the timers waits for boot.
  const end = Date.now() + 20_000;
  while (Date.now() < end && !(svc.profileTimer != null && svc.listenTimer != null)) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(svc.profileTimer != null && svc.listenTimer != null, `service on port ${port} must boot`);
  const node = { svc, dir };
  NODES.add(node);
  return node;
}

/**
 * Real teardown: timers off, server stopped, discovery stopped, then every client
 * destroyed — and re-scanned after a yield, because a client can still be registered
 * between the scan and the process going quiet (a live `RoomClient` re-arms its own
 * reconnect timer every 8 s forever, which is what previously held this file open).
 * The loop is bounded and exits as soon as no NEW client appeared.
 */
async function stopNode(node) {
  const { svc, dir } = node;
  if (!svc || node.stopped) return;
  node.stopped = true;
  for (const timer of [svc?.profileTimer, svc?.listenTimer]) {
    try { if (timer) clearInterval(timer); } catch { /* ignore */ }
  }
  try { await svc?.peerServer?.stop(); } catch { /* ignore */ }
  try { svc?.discovery?.stop?.(); } catch { /* ignore */ }
  const seen = new Set();
  for (let pass = 0; pass < 8; pass += 1) {
    for (const client of svc?.clients?.values?.() ?? []) {
      if (seen.has(client)) continue;
      seen.add(client);
      try { client.destroy(); } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 120));
    if (![...(svc?.clients?.values?.() ?? [])].some((client) => !seen.has(client))) break;
  }
  try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const bridgeOf = (state, roomId) => state.rooms.filter((r) => r.roomId === roomId)[0]?.bridge;

/**
 * The WebSocket "open" is asynchronous: `joinRoom()` resolves as soon as the HTTP
 * handshake returned, so the first snapshot legitimately says "connecting" for a
 * few hundred milliseconds (measured: 250 ms on this machine). Production reads
 * the field seconds later, and card ⑤ requires 3 s of slack. This waits for the
 * field to settle and returns the LAST value seen, so a field that never settles
 * fails with the state it got stuck in.
 */
async function settleBridge(svc, roomId, budgetMs = 10_000) {
  const end = Date.now() + budgetMs;
  let last = null;
  for (;;) {
    last = bridgeOf(await svc.browserState(), roomId);
    if (last && last.state === "open") return last;
    if (Date.now() >= end) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The production shape: an owner node serving a room and a member node joined to
 * it — then the member re-joins the same room through a DIFFERENT address, which
 * is exactly what `setConnectionMode()` does for every joined room.
 */
async function withModeSwitch(run) {
  const owner = await startNode(OWNER_PORT);
  const member = await startNode(MEMBER_PORT);
  try {
    const room = await owner.svc.gateway.createRoom({ title: "K family", type: "persistent" });
    const oldAddress = room.serverAddress; // e.g. 192.168.x.y:19611
    assert.ok(oldAddress && oldAddress.includes(":"), `owner must publish host:port, got ${oldAddress}`);

    await member.svc.gateway.joinRoom([oldAddress], { roomId: room.roomId });
    const stale = member.svc.clients.get(room.roomId);
    assert.ok(stale, "the member must register the first client");

    // A second join to the SAME server through a different address string: this is
    // the re-join a mode switch performs, and it destroys + replaces the client.
    const newAddress = `127.0.0.1:${OWNER_PORT}`;
    await member.svc.gateway.joinRoom([newAddress], { roomId: room.roomId });
    const live = member.svc.clients.get(room.roomId);
    assert.ok(live && live !== stale, "the re-join must install a NEW RoomClient");

    await run({ owner, member, room, stale, live, oldAddress, newAddress });
  } finally {
    await stopNode(member);
    await stopNode(owner);
  }
}

guarded("bridge follows the LIVE connection after a re-join, and cannot be rewritten by the dead one (0.1.42)", async () => {
  await withModeSwitch(async ({ member, room, stale, live, oldAddress, newAddress }) => {
    const before = await settleBridge(member.svc, room.roomId);
    console.log(
      `  live client address=${live.address} state=${live.connState} viaRelay=${live.viaRelay}` +
        ` | replaced client address=${stale.address}`,
    );
    console.log(`  bridge after the re-join settled: ${JSON.stringify(before)}`);
    assert.strictEqual(before.address, newAddress, "the bridge must name the address that actually connected");
    assert.notStrictEqual(before.address, oldAddress, "the bridge must NOT keep the replaced address");
    assert.strictEqual(before.kind, "direct", "both addresses are relay-less, so the kind is direct");
    assert.strictEqual(before.state, "open", `a healthy channel must not be reported as ${before.state}`);
    assert.strictEqual(stale.connState, "closed", "the replaced client's own state is what it would have reported");

    // The asynchronous socket close of the REPLACED client — the exact event that
    // produced the field报告. 0.1.41 wrote it straight into `connInfo` (that is the
    // defect); 0.1.42 must refuse it.
    const dropsBefore = member.svc.connDrops;
    stale.emit("connection", "closed");
    const after = bridgeOf(await member.svc.browserState(), room.roomId);
    console.log(`  after the replaced client reported "closed": ${JSON.stringify(after)}`);
    assert.deepStrictEqual(
      after,
      before,
      "a REPLACED client overwrote the bridge record — this is card ⑤ / D-19",
    );
    assert.strictEqual(after.state, "open", "the field must not say a closed channel while it is open");
    assert.strictEqual(
      member.svc.connDrops,
      dropsBefore + 1,
      "the refused write must be counted, not silently dropped",
    );
    console.log(
      `  connDrops=${member.svc.connDrops} (the replaced client's own close already contributed ` +
        `${dropsBefore}) connReplaced=${member.svc.connReplaced}`,
    );
    assert.ok(dropsBefore >= 1, "the replaced client's real socket close must already have been refused");
    assert.ok(member.svc.connReplaced >= 1, "the replacing join must be counted");
    const truth = (await member.svc.browserState()).bridgeTruth;
    assert.deepStrictEqual(
      truth,
      { connDrops: member.svc.connDrops, connReplaced: member.svc.connReplaced, tracked: 1 },
      "/state must expose the bridge-truth counters for exactly the one joined room",
    );
  });
});

guarded("bridge and the owner-confirmed delivery path agree (the field cannot contradict confirmedByOwner)", async () => {
  await withModeSwitch(async ({ member, room, newAddress }) => {
    const settled = await settleBridge(member.svc, room.roomId);
    assert.strictEqual(settled.state, "open", `the channel must be open before the delivery proof, got ${settled.state}`);
    const sent = await member.svc.gateway.sendChat(room.roomId, { text: "自证", human: false });
    const bridge = bridgeOf(await member.svc.browserState(), room.roomId);
    console.log(`  chat: confirmedByOwner=${sent.confirmedByOwner} confirmedSeq=${sent.confirmedSeq} | bridge=${JSON.stringify(bridge)}`);
    assert.strictEqual(sent.confirmedByOwner, true, "the message must be confirmed by the owner");
    // The production contradiction was `bridge.state=closed` + confirmedByOwner:true.
    assert.strictEqual(
      bridge.state,
      "open",
      `bridge.state=${bridge.state} contradicts confirmedByOwner=true (card ⑤ judging rule)`,
    );
    assert.strictEqual(bridge.address, newAddress);
  });
});

guarded("the reader has ONE source of truth: live client first, record second (0.1.42)", async () => {
  await withModeSwitch(async ({ member, room, live, newAddress }) => {
    // Force the pathological state by hand: a record left over from the dead
    // connection while a healthy live client exists. The snapshot must follow the
    // live client — a stale record must never be able to describe the field.
    member.svc.connInfo.set(room.roomId, {
      state: "closed",
      viaRelay: true,
      address: "ws://relay.example:9320",
    });
    const beforeForce = bridgeOf(await member.svc.browserState(), room.roomId);
    const bridge = await settleBridge(member.svc, room.roomId);
    console.log(`  record forced stale, live client ${live.connState}/${live.address} -> ${JSON.stringify(bridge)}`);
    assert.strictEqual(beforeForce.address, newAddress, "the stale record must not be readable at all");
    assert.strictEqual(bridge.kind, "direct", "a leftover relay record must not describe a direct connection");
    assert.strictEqual(bridge.address, newAddress, "the live client's address wins");
    assert.strictEqual(bridge.state, "open", "the live client's state wins");
  });
});

guarded("static guard: no RoomClient may write the bridge record unless it is the live one (0.1.42)", () => {
  const src = readFileSync(join(ROOT, "src", "host", "service.ts"), "utf8");
  assert.ok(
    !/this\.connInfo\.set\(roomId, \{ state, viaRelay: client\.viaRelay, address: client\.address \}\);/.test(src),
    "the status callback writes connInfo unconditionally again (the D-19 writer)",
  );
  assert.match(
    src,
    /private recordConnInfo\(roomId: string, client: RoomClient, state\?: string\): void \{/,
    "the single guarded writer must exist",
  );
  const writer = src.slice(src.indexOf("private recordConnInfo("), src.indexOf("private joinedBridge("));
  assert.match(writer, /const live = this\.clients\.get\(roomId\)/, "the guard must consult the live clients map");
  assert.match(writer, /live !== client/, "the guard must compare identity, not just liveness");
  assert.match(src, /this\.recordConnInfo\(roomId, client\);\s*\n\s*this\.clients\.set\(roomId, client\);/, "the join path must record the new client at the moment it becomes live");
  assert.match(src, /: this\.joinedBridge\(room\.roomId, room\.serverAddress\)/, "the snapshot must derive the joined bridge from the live client");
});

// Bounded, and deliberately UNREF'd: the suite tears its own two services down
// (`stopNode`), so nothing here should hold the event loop. The guard exists only to
// turn a future regression (a fresh leaked handle, e.g. a client whose reconnect
// timer re-arms forever) into a DEFINITE exit code 1 after 120 s instead of a silent
// hang, and the `after` hook below clears it on every normal run — so it can never be
// the reason the process stays alive.
const watchdog = setTimeout(() => {
  console.log(`WATCHDOG: the suite did not finish in 120 s (failures so far: ${failures})`);
  process.exit(1);
}, 120_000);
watchdog.unref?.();

after(async () => {
  clearTimeout(watchdog);
  // Safety-net sweep: stop any node a failed assertion left running.
  for (const node of NODES) await stopNode(node);
  console.log(`SUITE bridge-state: ${failures} failure(s) (every ✓/✗ above is one assertion of the 4 guarded cases)`);
  const code = failures === 0 ? 0 : 1;
  process.exitCode = code;
  // See listening.test.mjs for why this escape hatch exists: on THIS build the
  // teardown is real (measured: 2 s, exit 0, no leftover handle), while the deployed
  // 0.1.41 build that `AR_LIB` points at can finish its tests and still hold the
  // process open. Bounded (300 ms), deterministic, and loud about any leftover.
  const hardExit = setTimeout(() => {
    const leftovers = process.getActiveResourcesInfo().filter((kind) => kind !== "PipeWrap");
    if (leftovers.length > 0) {
      console.log(
        `TEARDOWN: bounded exit with ${leftovers.length} handle(s) still ref'd (${[...new Set(leftovers)].join(",")})` +
          ` — this build's teardown is incomplete; the exit code is still definite.`,
      );
    }
    process.exit(code);
  }, 300);
  hardExit.unref?.();
});
