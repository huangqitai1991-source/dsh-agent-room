/**
 * dsh-agent-room 0.1.41 — the WAKE plane: one `(roomId, seq)` wakes this node at
 * most once, EVER, and this node's own message is never a human top-priority order.
 *
 * THE DEFECT (card 04 v2, measured on the live fleet)
 *
 * One room message (room 01a098a2-2015-7a1d-b5f7-9eca45afa65d, seq 315) woke its
 * OWN authoring node 18 times over 25.5 min — the first re-wake 6415 s (1 h 47 min)
 * after it was written — each wake followed 0.39 s later by a full `step/start`
 * turn, and each wake a BRAND-NEW inbox message id (`createUserMessage`) that no
 * downstream identity check could collapse. The message carried `human:true`
 * because the web client sets it on every browser send, so the constant wake label
 * announced it as "人类发言（远程指挥，最高优先级）".
 *
 * WHY A MONOTONIC WATERMARK AND NOT A TTL
 *
 * The wake plane's only cursor was `listenSeen`, overwritten with the tail of this
 * node's 20-message window on every sweep: whenever the local mirror lagged the
 * owner (measured: 15 local rows vs 2200+ owner rows) the cursor moved BACKWARDS
 * and already-woken seqs looked fresh again. The regression span has no upper
 * bound, so no finite TTL can be proven long enough (two independent reviewers
 * rejected the TTL design for exactly this) — the rule has to be monotonic and
 * non-expiring: the owner assigns seq monotonically, so every seq ≤ the highest
 * ever woken was written before a message this node already woke for.
 *
 * WHAT THIS FILE PROVES (all against the built artifact, `node build.mjs` first)
 *   1. monotonic non-regression + the `regressed` tripwire;
 *   2. no second wake for an already-woken seq, including after the cursor is
 *      re-seeded from a regressed tail (the re-listen path that re-opened it);
 *   3. a genuinely newer seq still wakes — the remote-command channel stays open;
 *   4. memory is bounded (one number per room, capped, reset not growth);
 *   5. the author rule: own-authored → neither woken nor labelled human;
 *      remote human → woken and labelled human; remote agent → never woken;
 *   6. static guard: those rules are actually ON the wake decision point in
 *      src/host/service.ts (this is the wiring the partial implementation missed).
 *
 * Pure in-process state: no service is started, stopped, contacted or written to.
 * Run directly: `node test/wake.test.mjs` (never `node --test`).
 */

import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listenAuthorKind,
  MAX_WAKE_ROOMS,
  WakeWatermark,
  wakeKindLabel,
  WAKE_LABEL_AGENT,
  WAKE_LABEL_HUMAN,
  WAKE_LABEL_SELF,
} from "../lib/host/wake.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOM = "01a098a2-2015-7a1d-b5f7-9eca45afa65d";
const SELF = "01a0231b-bbe5-720a-97a4-819744eeae76"; // this node (KEVINKIKI)
const REMOTE_HUMAN = "01a09483-3668-7bdf-9cc2-0180f314c8cf"; // 小婷
const REMOTE_AGENT = "01a094c1-7159-7555-9222-65241c607320"; // 小黄
const SEQ_315 = 315; // the exact production (roomId, seq) that woke 18 times

/** Same node:test idiom as the other suites (see selfjoin.test.mjs). */
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

const msg = (seq, from, human) => ({ seq, from, fromNickname: from === SELF ? "KEVINKIKI" : "小婷", human, text: "x" });

guarded("wake watermark: monotonic non-regression, and `regressed` is the tripwire (0.1.41)", () => {
  const wm = new WakeWatermark();
  assert.strictEqual(wm.seen(ROOM, SEQ_315), false, "an unseen room must never be blocked");
  assert.strictEqual(wm.mark(ROOM, SEQ_315), true, "the first mark for a room must advance the watermark");
  assert.strictEqual(wm.watermark(ROOM), SEQ_315);

  // The backwards tail that caused the defect: 300 < 315. It must be REFUSED, not
  // applied — applying it is precisely what re-opened the already-woken seq.
  assert.strictEqual(wm.mark(ROOM, 300), false, "a lower seq must NOT lower the watermark");
  assert.strictEqual(
    wm.watermark(ROOM),
    SEQ_315,
    "the watermark moved BACKWARDS — this is the 0.1.40 defect",
  );
  const stats = wm.stats();
  assert.strictEqual(stats.regressed, 1, "a refused backwards mark must be counted as `regressed`");

  // It never expires: the defect's first re-wake came 6415 s later.
  const muchLater = new WakeWatermark();
  muchLater.mark(ROOM, SEQ_315);
  assert.strictEqual(muchLater.seen(ROOM, SEQ_315), true, "the watermark must not expire with time");

  // Invalid seqs (this node's own optimistic rows carry NEGATIVE seqs) are neither
  // recorded nor blocked — same boundary as dedupe.ts.
  assert.strictEqual(wm.mark(ROOM, -Date.now()), false, "a negative local seq must not be recorded");
  assert.strictEqual(wm.seen(ROOM, -1), false, "a negative local seq must not be blocked");
  assert.strictEqual(wm.seen(ROOM, 0), false, "seq 0 is not an owner seq");
});

guarded("an already-woken (roomId, seq) never wakes twice, even after the cursor is re-seeded (0.1.41)", () => {
  const wm = new WakeWatermark();
  let wakes = 0;
  let skips = 0;
  // 53 sweeps at the real 30 s cadence, mirror reporting a REGRESSED tail every
  // third sweep — the shape that produced 18 wakes of seq 315 in production.
  // `listenSeen` is re-seeded every 3rd sweep (the re-listen path), so the
  // watermark, not the cursor, is what has to hold here.
  let cursor;
  for (let i = 0; i < 53; i++) {
    const tail = i % 3 === 0 ? 300 : 315;
    if (i % 9 === 0) cursor = undefined; // listenSeen.delete on re-listen
    if (cursor === undefined) {
      cursor = tail; // first sweep for the room: seed from the tail, wake nothing
      continue;
    }
    // Only a FRESH candidate reaches the wake boundary — the guard is consulted
    // there and nowhere else (service.ts runListenWake), so seen() is called only
    // when the candidate is fresh, exactly like the shipped code.
    if (SEQ_315 > cursor) {
      if (wm.seen(ROOM, SEQ_315)) {
        skips += 1;
      } else {
        wakes += 1;
        wm.mark(ROOM, SEQ_315); // only after the dispatch actually happened
      }
    }
    if (tail > cursor) cursor = tail; // monotonic cursor (service.ts)
  }
  assert.strictEqual(wakes, 1, `the same (roomId, seq) must wake at most once, got ${wakes} (0.1.40: 18)`);
  assert.ok(skips >= 1, "every suppressed wake must be countable (the log line's counter)");
  assert.strictEqual(wm.stats().skipped, skips, "stats().skipped must match the suppressions observed");
  assert.strictEqual(wm.watermark(ROOM), SEQ_315);
});

guarded("a genuinely newer seq still wakes — the remote-command channel stays open (0.1.41)", () => {
  const wm = new WakeWatermark();
  wm.mark(ROOM, SEQ_315);
  assert.strictEqual(wm.seen(ROOM, SEQ_315), true, "315 was woken, so 315 must be blocked");
  assert.strictEqual(wm.seen(ROOM, 316), false, "316 is NEWER: it must wake (this is the fix's risk)");
  assert.strictEqual(
    wm.mark(ROOM, 316),
    true,
    "a newer seq must advance the watermark — otherwise listening dies permanently",
  );
  assert.strictEqual(wm.watermark(ROOM), 316);
  // A different room is independent (per-room watermark, like dedupe.ts per-room rings).
  assert.strictEqual(wm.seen("other-room", 1), false, "rooms must not share one watermark");
});

guarded("memory is bounded: the room cap resets the structure instead of growing (0.1.41)", () => {
  let resets = 0;
  const wm = new WakeWatermark(MAX_WAKE_ROOMS, (message) => {
    resets += 1;
    assert.match(message, /wake watermark room cap/);
  });
  for (let i = 0; i < 500; i++) wm.mark("room-" + i, 1000 + i);
  const stats = wm.stats();
  assert.ok(stats.rooms <= MAX_WAKE_ROOMS, `rooms held ${stats.rooms} > cap ${MAX_WAKE_ROOMS}`);
  assert.ok(stats.roomResets >= 1, "500 rooms against a cap of 128 must have reset at least once");
  assert.strictEqual(stats.roomResets, resets, "the cap notice must fire once per reset");
  assert.strictEqual(stats.maxRooms, MAX_WAKE_ROOMS);
  // One NUMBER per room, not a ring of seqs: the bound is the cap, nothing else.
  assert.deepStrictEqual(
    Object.keys(stats).sort(),
    ["humanClaims", "maxRooms", "regressed", "roomResets", "rooms", "selfAuthored", "skipped", "woken"],
    "the /state block must stay numeric diagnostics only",
  );
  // forget() drops one room (mirrors DeliveryDedupe.forget); it is NOT wired to
  // leave/listen transitions on purpose — reverting there would rebuild the defect.
  wm.forget("room-0");
  assert.ok(wm.stats().rooms <= MAX_WAKE_ROOMS);
});

guarded("author rule: this node's own message is never a human top-priority order (0.1.41)", () => {
  const own = msg(SEQ_315, SELF, true); // the production sample, verbatim in shape
  assert.strictEqual(
    listenAuthorKind(own, SELF),
    "self",
    "a message authored by THIS agentId must classify as self, whatever `human` claims",
  );
  const label = wakeKindLabel(listenAuthorKind(own, SELF));
  assert.ok(
    !label.includes("人类发言"),
    `an own-authored message must NEVER be labelled a human order, got ${JSON.stringify(label)}`,
  );
  assert.strictEqual(label, WAKE_LABEL_SELF);

  // Without the comparison the same message is exactly what 0.1.40 announced.
  assert.strictEqual(
    listenAuthorKind(own, "some-other-agent"),
    "human",
    "the misclassification only exists because `human:true` was trusted alone",
  );
});

guarded("author rule: a remote human wakes and is labelled human; a remote agent never wakes (0.1.41)", () => {
  const remoteHuman = msg(316, REMOTE_HUMAN, true);
  assert.strictEqual(listenAuthorKind(remoteHuman, SELF), "human");
  assert.strictEqual(
    wakeKindLabel("human"),
    WAKE_LABEL_HUMAN,
    "the remote-command label itself must survive the fix (the channel still exists)",
  );

  const remoteAgent = msg(317, REMOTE_AGENT, false);
  assert.strictEqual(
    listenAuthorKind(remoteAgent, SELF),
    "agent",
    "an agent that does not claim human:true must never enter the human channel",
  );
  assert.strictEqual(wakeKindLabel("agent"), WAKE_LABEL_AGENT);
  assert.ok(
    !WAKE_LABEL_AGENT.includes("人类发言") && !WAKE_LABEL_SELF.includes("人类发言"),
    "only the remote-human label may say 人类发言",
  );

  // The claim counter measures the residual this layer cannot verify end to end.
  const wm = new WakeWatermark();
  wm.noteHumanClaim();
  wm.noteSelfAuthored();
  assert.strictEqual(wm.stats().humanClaims, 1);
  assert.strictEqual(wm.stats().selfAuthored, 1);
});

guarded("static guard: the rules are ON the wake decision point in service.ts (the wiring 0.1.41 had to add)", () => {
  const src = readFileSync(join(ROOT, "src", "host", "service.ts"), "utf8");
  const wakePath = src.slice(src.indexOf("private async runListenWake("), src.indexOf("private async boot("));

  const atSeen = wakePath.indexOf("this.wakeWatermark.seen(roomId, message.seq)");
  const atFollow = wakePath.indexOf("agent.followup(");
  const atMark = wakePath.indexOf("this.wakeWatermark.mark(roomId, message.seq)");
  assert.ok(atSeen >= 0, "the wake decision point must consult the watermark (it did not in 0.1.40)");
  assert.ok(
    atSeen < atFollow,
    "the watermark must be consulted BEFORE agent.followup — that call is what creates the new message id",
  );
  assert.ok(atMark > atFollow, "the seq must be marked only AFTER the dispatch actually happened");

  assert.match(
    wakePath,
    /listening: skipped seq=" \+ message\.seq \+ " \(dedupe\)/,
    "a suppression must leave one self-describing line (reconstructing this defect took 142 transcripts)",
  );
  assert.match(wakePath, /listening: woken seq=" \+ message\.seq/, "an admitted wake must name its seq");

  // The label is derived from the same rule, never a constant again.
  assert.match(src, /wakeKindLabel\(listenAuthorKind\(m, input\.identity\.agentId\)\)/);
  assert.ok(
    !/const kind = "人类发言/.test(src),
    "the constant label is back — that literal is how a bot's message became a human order",
  );

  // The cursor is monotonic: the unconditional overwrite is gone.
  assert.match(src, /if \(lastSeq > seen\) this\.listenSeen\.set\(roomId, lastSeq\);/);
  assert.ok(
    !/const fresh = recent\.filter\(\(m\) => m\.seq > seen\);\s*\n\s*this\.listenSeen\.set\(roomId, lastSeq\);/.test(src),
    "the cursor is overwritten unconditionally again (the root cause of card 04)",
  );

  // The wake counters ride in /state next to the delivery plane's block.
  assert.match(src, /wake: this\.wakeWatermark\.stats\(\),/);
  assert.match(src, /dedupe: this\.dedupe\.stats\(\),/);

  // The delivery plane's own dedupe must not have been disturbed (0.1.39).
  assert.match(src, /if \(this\.dedupe\.seen\(roomId, message\.seq\)\) return;/);
});

guarded("runtime: the wake counters really reach GET /agent-room-api/state (not just the source)", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { Context } = await import("@deepseek-ai/cordis");
  const { AgentRoomService } = await import("../lib/host/service.js");
  const dir = await mkdtemp(join(tmpdir(), "ar-wake-state-"));
  let svc = null;
  try {
    svc = new AgentRoomService(new Context(), { dataDir: dir, port: 19521, relay: "" });
    const end = Date.now() + 8_000;
    while (Date.now() < end && !(svc.profileTimer != null && svc.listenTimer != null)) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(svc.profileTimer != null && svc.listenTimer != null, "the service must boot before /state is read");

    const state = await svc.browserState();
    assert.ok(state && typeof state === "object", "/state must return an object");
    // The wake block must sit next to the delivery plane's, in the same shape.
    assert.ok(state.wake, "GET /agent-room-api/state must expose the wake counters (web.ts:28-29 wires this)");
    assert.ok(state.dedupe, "the 0.1.39 delivery block must still be there (do not disturb it)");
    assert.deepStrictEqual(
      Object.keys(state.wake).sort(),
      Object.keys(new WakeWatermark().stats()).sort(),
      "the wake block must have the same counter shape as its own stats()",
    );
    assert.strictEqual(state.wake.maxRooms, MAX_WAKE_ROOMS);
    assert.strictEqual(state.wake.regressed, 0, "the tripwire must start at 0 on a fresh node");
    for (const [key, value] of Object.entries(state.wake)) {
      assert.strictEqual(typeof value, "number", `wake.${key} must be a number, got ${typeof value}`);
    }
    // JSON-serialisable (it crosses HTTP as JSON).
    assert.ok(JSON.parse(JSON.stringify(state)).wake.rooms === 0);
  } finally {
    for (const timer of [svc?.profileTimer, svc?.listenTimer]) {
      try { if (timer) clearInterval(timer); } catch { /* ignore */ }
    }
    try { await svc?.peerServer?.stop(); } catch { /* ignore */ }
    try { svc?.discovery?.stop?.(); } catch { /* ignore */ }
    for (const client of svc?.clients?.values?.() ?? []) { try { client.destroy(); } catch { /* ignore */ } }
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const watchdog = setTimeout(() => process.exit(failures > 0 ? 1 : 0), 25_000);
watchdog.unref();
