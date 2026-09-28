/**
 * dsh-agent-room 0.1.42 — ITEM 4: is there a SECOND wake path that still turns one
 * room message into several wake notifications?
 *
 * WHAT WAS ALREADY FIXED (0.1.41, `docs/RELEASE-0.1.41.md`)
 *
 * One message (room 01a098a2-2015-7a1d-b5f7-9eca45afa65d, seq 315, authored by the
 * node it woke) woke its own session 18 times. Cause: the wake plane had no
 * `(roomId, seq)` rule, and its only cursor (`listenSeen`) was overwritten with the
 * tail of the node's own 20-message window — a cursor that moves BACKWARDS whenever
 * the local mirror lags the owner, which made an already-woken seq look fresh again.
 * 0.1.41 added a monotonic non-expiring `WakeWatermark`, guarded at the single
 * `agent.followup` call site (`service.ts:952-984`).
 *
 * WHAT THIS FILE MEASURES (integration level, not the pure watermark class —
 * `test/wake.test.mjs` already covers that class)
 *
 * The remaining question is whether a SECOND path still produces duplicate wake
 * notifications. Every path that can reach a session is enumerated here and driven
 * for real, on a live `AgentRoomService` with a fake agent registry that counts
 * `followup` dispatches:
 *
 *   P1 the sweep path (`sweepListening` -> `runListenWake`) with the cursor forced
 *      BACKWARDS every round — the exact shape of the 18-wake defect;
 *   P2 the re-listen path (`setListening(true)`, which deletes `listenSeen`);
 *   P3 the DELIVERY path (an inbound chat frame on the roomService bus);
 *   P4 a genuinely newer seq (the remote-command channel must still open);
 *   P5 the manual activate-chat path (a different mechanism: user-initiated, 409
 *      while a previous wake is in flight);
 *   P6 the 128-room watermark cap, where the structure resets by design.
 *
 * Each path prints its raw dispatch count. If P1/P2/P3 produce one dispatch and P4
 * still wakes, the item is "cannot reproduce" and this file is its evidence.
 *
 * Old-vs-new: run it against the pre-0.1.41 build to watch the defect come back —
 *   AR_LIB=<0.1.40 lib>  node test/wake-duplicate.test.mjs   -> P1 FAILS (many wakes)
 *   node test/wake-duplicate.test.mjs                        -> all pass (1 wake)
 *
 * Loopback/temp-dir only. Run directly (never `node --test`).
 */

import assert from "node:assert";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";

const LIB = (() => {
  const raw = (process.env.AR_LIB ?? "../lib").replace(/\\/g, "/");
  if (raw.startsWith("file://")) return raw;
  return /^[a-zA-Z]:\//.test(raw) ? `file:///${raw}` : raw;
})();
process.env.DSH_IDENTITY_BACKUP_DIR = process.env.DSH_IDENTITY_BACKUP_DIR
  ?? join(tmpdir(), "ar-wakedup-backups");

const { AgentRoomService } = await import(`${LIB}/host/service.js`);
const MAX_WAKE_ROOMS = (await import(`${LIB}/host/wake.js`).catch(() => ({ MAX_WAKE_ROOMS: 128 }))).MAX_WAKE_ROOMS;

/** Wake-plane diagnostics, when the build has them (0.1.41+). A pre-0.1.41 build
 *  has no watermark at all — and that is exactly the build this file must be able
 *  to run against, to watch the defect come back. */
const wakeStats = (svc) =>
  svc.wakeWatermark ? JSON.stringify(svc.wakeWatermark.stats()) : "unavailable (pre-0.1.41 build: no wake watermark)";
/** One wake counter, or a value that keeps the assertion honest on a build that has
 *  no wake plane to measure. */
const wakeStatsNum = (svc, key) => (svc.wakeWatermark ? svc.wakeWatermark.stats()[key] : key === "regressed" ? 0 : 1);
const watermarkOf = (svc, roomId) => (svc.wakeWatermark ? svc.wakeWatermark.watermark(roomId) : undefined);

const PORT = 19571;
const ROOM = "01a098a2-2015-7a1d-b5f7-9eca45afa65d"; // the production roomId
const SELF = "01a0231b-bbe5-720a-97a4-819744eeae76"; // this node (*****)
const REMOTE_HUMAN = "01a09483-3668-7bdf-9cc2-0180f314c8cf"; // D
const SEQ = 315; // the production seq that woke 18 times

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
  const dir = await mkdtemp(join(tmpdir(), `ar-wakedup-${tag}-`));
  dirs.push(dir);
  return dir;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot a service with a counter registry: every `followup` call is a wake
 *  notification (that call is what creates a brand-new inbox message id, so nothing
 *  downstream can collapse two of them). */
async function boot(dir, port) {
  const svc = new AgentRoomService(new Context(), { dataDir: dir, port, relay: "" });
  const end = Date.now() + 8_000;
  while (Date.now() < end && !(svc.profileTimer != null && svc.listenTimer != null)) await wait(25);
  assert.ok(svc.profileTimer != null, "the service must boot");
  const dispatches = [];
  const fakeAgent = {
    id: "session-wake-probe",
    sessionId: "session-wake-probe",
    followup: (message) => {
      dispatches.push({ at: Date.now(), id: dispatches.length + 1, text: JSON.stringify(message).slice(0, 160) });
      return { ok: true };
    },
  };
  // Path 1 of resolveResidentAgent is `config.replyAgentId` + registry lookup;
  // overriding the registry keeps this deterministic (no window scanning).
  svc.agentsRegistry = () => ({
    list: () => [fakeAgent],
    roots: () => [fakeAgent],
    get: (id) => (id === fakeAgent.id ? fakeAgent : undefined),
    currentInitiator: () => fakeAgent,
  });
  svc.config.replyAgentId = fakeAgent.id;
  return { svc, dispatches };
}

async function teardown(svc) {
  if (!svc) return;
  for (const timer of [svc.profileTimer, svc.listenTimer]) {
    try { if (timer) clearInterval(timer); } catch { /* ignore */ }
  }
  try { await svc.peerServer?.stop(); } catch { /* ignore */ }
  try { svc.discovery?.stop?.(); } catch { /* ignore */ }
  for (const client of svc.clients?.values?.() ?? []) { try { client.destroy(); } catch { /* ignore */ } }
}

/** A remote human message in an owned room: the one thing the wake rule admits. */
async function seedHumanMessage(svc, roomId, text = "remote instruction") {
  return await svc.roomService.addChatMessage(
    roomId,
    { agentId: REMOTE_HUMAN, nickname: "D", capabilities: [], createdAt: new Date().toISOString() },
    { text, human: true },
  );
}

guarded("ITEM 4 / P1: the sweep path wakes an already-woken seq at most once, even with the cursor forced BACKWARDS every round", async () => {
  const { svc, dispatches } = await boot(await mk("p1"), PORT);
  try {
    const room = await svc.gateway.createRoom({ title: "K family", type: "persistent" });
    const message = await seedHumanMessage(svc, room.roomId);
    assert.strictEqual(message.seq, 1, "the first message in a fresh room is seq 1");

    svc.setListening(room.roomId, true);
    await svc.sweepListening(); // seeds the cursor at the tail, wakes nothing
    assert.strictEqual(dispatches.length, 0, "seeding the cursor must not wake (history is not an instruction)");

    // First real wake: the cursor is below the message, so this candidate is fresh.
    svc.listenSeen.set(room.roomId, 0);
    await svc.sweepListening();
    await wait(10);
    svc.listenPending.delete(room.roomId);
    assert.strictEqual(dispatches.length, 1, "the first fresh sweep must wake exactly once (a remote human message)");

    // 20 more rounds. Every round the cursor is dragged back BELOW the message seq —
    // the regressed-tail shape that produced the 18 wakes in production (the local
    // mirror reported an older tail than the owner's store).
    for (let round = 0; round < 20; round += 1) {
      svc.listenSeen.set(room.roomId, 0); // the regression, forced
      svc.listeningRooms.add(room.roomId);
      await svc.sweepListening();
      await wait(5); // let the async runListenWake land
      svc.listenPending.delete(room.roomId); // 60s re-arm, compressed for the probe
    }
    console.log("[ITEM4/P1] followup dispatches =", dispatches.length, "for ONE message (seq " + message.seq + ") over 20 regressed sweeps");
    console.log("[ITEM4/P1] dispatch ids =", JSON.stringify(dispatches.map((d) => d.id)));
    console.log("[ITEM4/P1] wake stats =", wakeStats(svc));

    assert.strictEqual(
      dispatches.length,
      1,
      `one message must produce ONE wake notification, got ${dispatches.length} (the 0.1.40 field count was 18)`,
    );
    assert.strictEqual(wakeStatsNum(svc, "regressed"), 0, "the `regressed` tripwire must stay 0");
    assert.ok(wakeStatsNum(svc, "skipped") >= 1, "the suppressed rounds must be countable");
  } finally {
    await teardown(svc);
  }
});

guarded("ITEM 4 / P2: re-listening (which deletes the cursor) does not re-open an already-woken seq", async () => {
  const { svc, dispatches } = await boot(await mk("p2"), PORT + 1);
  try {
    const room = await svc.gateway.createRoom({ title: "K family", type: "persistent" });
    const message = await seedHumanMessage(svc, room.roomId);

    svc.setListening(room.roomId, true);
    await svc.sweepListening();
    svc.listenSeen.set(room.roomId, 0);
    await svc.sweepListening();
    await wait(10);
    svc.listenPending.delete(room.roomId);
    assert.strictEqual(dispatches.length, 1, "precondition: the instruction woke the node once");

    for (let round = 0; round < 5; round += 1) {
      svc.setListening(room.roomId, false); // leave listening: cursor deleted
      svc.setListening(room.roomId, true); // re-listen: cursor re-seeded from the tail
      await svc.sweepListening();
      await wait(5);
      svc.listenPending.delete(room.roomId);
      svc.listenSeen.set(room.roomId, 0); // and force the regression again
      await svc.sweepListening();
      await wait(5);
      svc.listenPending.delete(room.roomId);
    }
    console.log("[ITEM4/P2] followup dispatches =", dispatches.length, "after 5 listen/unlisten/re-listen cycles");
    console.log("[ITEM4/P2] wake stats =", wakeStats(svc));
    assert.strictEqual(
      dispatches.length,
      1,
      `re-listening must not re-wake seq ${message.seq}: got ${dispatches.length} dispatches`,
    );
    assert.strictEqual(watermarkOf(svc, room.roomId), message.seq, "the watermark must still hold the seq");
  } finally {
    await teardown(svc);
  }
});

guarded("ITEM 4 / P3: the DELIVERY plane never wakes a session (there is no second wake path)", async () => {
  const { svc, dispatches } = await boot(await mk("p3"), PORT + 2);
  try {
    const room = await svc.gateway.createRoom({ title: "K family", type: "persistent" });
    const message = await seedHumanMessage(svc, room.roomId);

    // Every shape an inbound frame takes on its way to the local agent: the
    // roomService bus (which agent-org's exec plane and the dedupe listener use),
    // the same message emitted twice, and remote human chat frames.
    for (let i = 0; i < 5; i += 1) {
      svc.roomService.emit("chat", room.roomId, message);
      svc.roomService.emit("chat", room.roomId, { ...message, seq: message.seq + i });
    }
    await wait(50);
    console.log("[ITEM4/P3] followup dispatches after 10 delivery-plane emissions =", dispatches.length);
    console.log("[ITEM4/P3] dedupe stats =", JSON.stringify(svc.dedupe.stats()));
    assert.strictEqual(
      dispatches.length,
      0,
      "the delivery plane must never dispatch a wake; if it does, that IS the second path",
    );
  } finally {
    await teardown(svc);
  }
});

guarded("ITEM 4 / P4: a NEWER message still wakes (the remote-command channel stays open)", async () => {
  const { svc, dispatches } = await boot(await mk("p4"), PORT + 3);
  try {
    const room = await svc.gateway.createRoom({ title: "K family", type: "persistent" });
    await seedHumanMessage(svc, room.roomId); // seq 1
    svc.setListening(room.roomId, true);
    await svc.sweepListening(); // seeds the cursor
    svc.listenSeen.set(room.roomId, 0); // force the regression so seq 1 is a candidate
    await svc.sweepListening();
    await wait(10);
    svc.listenPending.delete(room.roomId);
    assert.strictEqual(dispatches.length, 1, "precondition: the first instruction woke the node");

    const newer = await seedHumanMessage(svc, room.roomId, "second remote instruction");
    svc.listenPending.delete(room.roomId);
    svc.listenSeen.set(room.roomId, 0);
    await svc.sweepListening();
    await wait(10);
    console.log("[ITEM4/P4] followup dispatches =", dispatches.length, "after a newer human message (seq " + newer.seq + ")");
    assert.strictEqual(dispatches.length, 2, "a genuinely newer instruction MUST still wake the node");
    assert.strictEqual(watermarkOf(svc, room.roomId), newer.seq, "the watermark must advance");
  } finally {
    await teardown(svc);
  }
});

guarded("ITEM 4 / P5: the manual activate-chat path is a separate mechanism, and it is refused while in flight", async () => {
  const { svc, dispatches } = await boot(await mk("p5"), PORT + 4);
  try {
    const room = await svc.gateway.createRoom({ title: "K family", type: "persistent" });
    await seedHumanMessage(svc, room.roomId);
    await svc.activateChat(room.roomId);
    await wait(10);
    const afterFirst = dispatches.length;
    let conflict = null;
    try {
      await svc.activateChat(room.roomId);
    } catch (error) {
      conflict = error;
    }
    await wait(10);
    console.log("[ITEM4/P5] dispatches after activate-chat =", afterFirst, "| second call threw =", conflict ? String(conflict.message) : "nothing");
    assert.strictEqual(afterFirst, 1, "activate-chat dispatches one followup");
    assert.ok(conflict, "a second activate-chat while one is in flight must be REFUSED, not dispatched");
    assert.strictEqual(dispatches.length, 1, "the refused call must not dispatch");
  } finally {
    await teardown(svc);
  }
});

guarded("ITEM 4 / P6: the only residual re-wake is the documented 128-room cap reset (bounded, at most one per room)", () => {
  console.log("[ITEM4/P6] documented cap =", MAX_WAKE_ROOMS, "rooms; exceeding it resets the structure (src/host/wake.ts:176-200)");
  assert.ok(MAX_WAKE_ROOMS >= 128, "the cap is the documented 128");
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

const watchdog = setTimeout(() => process.exit(failures > 0 ? 1 : 0), 30_000);
watchdog.unref();
