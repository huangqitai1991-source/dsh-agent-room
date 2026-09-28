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
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";

/**
 * `AR_LIB` points the suite at ANOTHER build's lib directory, which is how the
 * 0.1.45 release gate runs the NEW assertions against the DEPLOYED 0.1.44 build and
 * shows them FAILING there (house rule: a new assertion must be able to fail on the
 * old code, or it is not an assertion).
 *
 * The import is DYNAMIC on purpose: a static `import { decideListenWake }` would
 * throw a link-time SyntaxError on the old build and take the whole suite down,
 * which would prove nothing about the individual assertions.
 */
const AR_LIB = process.env.AR_LIB;
const libBase = AR_LIB ? pathToFileURL(join(AR_LIB, "host") + "/").href : "../lib/host/";
const wake = await import(libBase + "wake.js");
const {
  listenAuthorKind,
  MAX_WAKE_ROOMS,
  WakeWatermark,
  wakeKindLabel,
  WAKE_LABEL_AGENT,
  WAKE_LABEL_HUMAN,
  WAKE_LABEL_SELF,
  // 0.1.45 — absent (undefined) on the deployed 0.1.44 build, which is what makes
  // every assertion below fail there:
  decideListenWake,
  mentionsThisNode,
  isMachineSelfTestFrame,
  WAKE_ADMITTED,
  MACHINE_FRAME_MAX_CHARS,
  MAX_NAMED_DENIALS_PER_SWEEP,
  WAKE_WINDOW_ROWS,
} = wake;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOM = "01a098a2-2015-7a1d-b5f7-9eca45afa65d";
const SELF = "01a0231b-bbe5-720a-97a4-819744eeae76"; // this node (*****)
const REMOTE_HUMAN = "01a09483-3668-7bdf-9cc2-0180f314c8cf"; // D
const REMOTE_AGENT = "01a094c1-7159-7555-9222-65241c607320"; // C
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

const msg = (seq, from, human) => ({ seq, from, fromNickname: from === SELF ? "*****" : "D", human, text: "x" });

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
  // 0.1.45 adds one number per RULE OUTCOME (the point: a denial must be countable),
  // and the shape rule is unchanged — flat numbers, no nesting.
  assert.deepStrictEqual(
    Object.keys(stats).sort(),
    [
      "deniedControlFrame",
      "deniedMachineFrame",
      "deniedNotAddressed",
      "deniedSelfAuthored",
      "humanClaims",
      "maxRooms",
      "pendingSkips",
      "regressed",
      "roomResets",
      "rooms",
      "seedSkips",
      "selfAuthored",
      "skipped",
      "windowGapMessages",
      "windowGaps",
      "windowRows",
      "woken",
      "wokenByHumanFallback",
      "wokenByMention",
    ],
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
  const { AgentRoomService } = await import(libBase + "service.js");
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

/* ======================= 0.1.45 — the wake RULE and the sender's view ======================= */

const SELF_JIE = "01a0281a-52de-7c4d-a1e9-7e6db367d3dd"; // A
const CTRL_TING = "01a09483-3668-7bdf-9cc2-0180f314c8cf"; // D — the room's CONTROLLER (owner's own record)
const SELF_NODE = { agentId: SELF, nickname: "*****" };

guarded("0.1.45 dispatch signal: a message that NAMES this node wakes it, whatever `human` claims", () => {
  // The production samples. seq 3267 / 3606 were `human:false` with no mention and
  // woke nobody; the SAME dispatch shape with an address must wake the target.
  // Every form below is one the fleet actually writes (or the owner stores).
  const cases = [
    ["mentions[] carries the canonical agentId", { from: REMOTE_AGENT, human: false, mentions: [SELF], text: "【派活】请跑回归" }],
    ["mentions[] carries the nickname (the pre-resolution form the tool accepts)", { from: REMOTE_AGENT, human: false, mentions: ["*****"], text: "【派活】请跑回归" }],
    ["@nickname in the text", { from: REMOTE_AGENT, human: false, text: "@***** 请跑回归" }],
    ["@agentId in the text", { from: REMOTE_AGENT, human: false, text: "@" + SELF + " 请跑回归" }],
    ["the full-width ＠ a Chinese IME produces", { from: REMOTE_AGENT, human: false, text: "＠***** 请跑回归" }],
    ["the bracketed dispatch header used in this room today", { from: REMOTE_AGENT, human: false, text: "【A → @***** · 请裁决】正文如下" }],
    ["a bare agentId (36 chars, unambiguous)", { from: REMOTE_AGENT, human: false, text: "收件人 " + SELF + " 请回复" }],
  ];
  for (const [label, message] of cases) {
    const decision = decideListenWake({ message, self: SELF_NODE });
    assert.strictEqual(decision.wake, true, `${label}: must wake (0.1.44 woke nobody for a human:false dispatch)`);
    assert.strictEqual(decision.reason, "mention", `${label}: the reason must name the rule, not just "woke"`);
    assert.ok(decision.detail, `${label}: the matched token must be reportable in the log line`);
  }
  // The boundary that keeps this from being a storm: a nickname in PROSE is not an
  // address. Measured counterexample from today's room — C's report (seq 3703)
  // names D/A/B while discussing the roster, and wakes none of them.
  const prose = decideListenWake({
    message: { from: REMOTE_AGENT, human: false, text: "分工：3/4/5/6 归D、B、A，我只说一句" },
    self: { agentId: SELF_JIE, nickname: "A" },
  });
  assert.strictEqual(prose.wake, false, "prose that merely names a colleague must not wake them (storm shape)");
  assert.strictEqual(prose.reason, "not-addressed", "and it must still carry a reason so the denial can be logged");
  assert.strictEqual(mentionsThisNode({ text: "A说这条要改" }, { agentId: SELF_JIE, nickname: "A" }), undefined);
});

guarded("0.1.45: an unaddressed post is DENIED WITH A REASON — the silent branch of 0.1.44 is gone", () => {
  // Verbatim shape of the two posts that cost today: the questionnaire (seq 3267) and
  // its reminder (seq 3606) — authored by the control node, `human:false`,
  // `mentions:null`, and addressed by a NAME LIST rather than by `@`.
  const questionnaire = {
    from: SELF,
    fromNickname: "*****",
    human: false,
    text: "【总控 · 问卷：升级后的实用性与稳定性 + B端销售缺什么 + room与org结合怎么看】\n填写人：D、C、B、A（各自单独回一条）｜汇总人：总控",
  };
  const jie = decideListenWake({ message: questionnaire, self: { agentId: SELF_JIE, nickname: "A" } });
  assert.strictEqual(jie.wake, false, "a name list is not an address: no @, no mention, no wake");
  assert.strictEqual(jie.reason, "not-addressed", "0.1.44 produced NO reason here — that silence was the defect");

  // The same questionnaire, addressed: it wakes A AND NOT C. That is the whole
  // contract of this version (and what `woken` now reports to the sender).
  const addressed = { ...questionnaire, mentions: [SELF_JIE], text: questionnaire.text.replace("A", "@A") };
  assert.strictEqual(decideListenWake({ message: addressed, self: { agentId: SELF_JIE, nickname: "A" } }).reason, "mention");
  const other = decideListenWake({ message: addressed, self: REMOTE_AGENT_ID_FOR("C") });
  assert.strictEqual(other.wake, false, "a machine that was NOT named must not wake (no storm)");
  assert.strictEqual(other.reason, "not-addressed");
  // Sanity on the fixture itself: the two nodes really are different identities.
  assert.notStrictEqual(REMOTE_AGENT, SELF_JIE);
});

/** The deciding node for C (the fleet's fourth identity). */
function REMOTE_AGENT_ID_FOR(nickname) {
  return { agentId: REMOTE_AGENT, nickname };
}

guarded("0.1.45 storm guard: machine self-test stamps and control frames NEVER wake anyone", () => {
  const stamps = [
    "A升 0.1.43 自证",
    "XIAOHUANG 0.1.44 verify",
    "verify 0.1.44",
    "B 0.1.45 自检通过",
    "***** 0.1.45 self-verify",
  ];
  for (const text of stamps) {
    assert.strictEqual(isMachineSelfTestFrame(text), true, `a self-test stamp must be recognised: ${text}`);
    // Belt and braces: the guard is checked BEFORE the mention clause, so even a
    // stamp that names a target cannot start a wake (all five nodes run listening —
    // a stamp that woke its readers is the documented wake-storm shape).
    const decision = decideListenWake({
      message: { from: REMOTE_AGENT, human: true, mentions: [SELF], text: text + " @*****" },
      self: SELF_NODE,
    });
    assert.strictEqual(decision.wake, false, `a self-test stamp must not wake anyone: ${text}`);
    assert.strictEqual(decision.reason, "machine-frame");
  }

  // The guard must NOT swallow real work. These are the shapes it must let through —
  // including a short order that merely uses the word verify, and a real report.
  const notStamps = [
    "请 verify 0.1.45 后回复 @*****",
    "0.1.45 升级后需要你自证一下吗？",
    "【总控 · 问卷】\n填写人：D、C、B、A（各自单独回一条）",
    "。【A · 漏唤缺陷修复意见】\n\n## 一、六个问题\n1. human=false 该不该唤醒？" + "x".repeat(200),
    "verify",
  ];
  for (const text of notStamps) {
    assert.strictEqual(isMachineSelfTestFrame(text), false, `must NOT be treated as a machine stamp: ${text.slice(0, 40)}`);
  }
  assert.ok(MACHINE_FRAME_MAX_CHARS >= 40 && MACHINE_FRAME_MAX_CHARS <= 400, "the stamp length bound stays in a sane range");

  // Control frames (`[org:*]`) are the work-order bus: they are acted on by
  // agent-org already, and they must never wake the room's listening agent even when
  // they name it (that is the "control frames mixed into chat" family).
  const control = decideListenWake({
    message: { from: REMOTE_AGENT, human: true, mentions: [SELF], text: "[org:exec:result] 01a0231b… exit=0 @*****" },
    self: SELF_NODE,
  });
  assert.strictEqual(control.wake, false);
  assert.strictEqual(control.reason, "control-frame");
});

guarded("0.1.45: card ④ holds, `human` is a FALLBACK not the gate, and NO author identity buys a wake", () => {
  // card ④ (0.1.41) — a node never wakes for its own message, and admitting mentions
  // must not re-open it (a node that @-mentions itself is the same defect shape).
  for (const human of [true, false]) {
    const own = decideListenWake({
      message: { from: SELF, human, mentions: [SELF], text: "@***** 我自己说的话" },
      self: SELF_NODE,
    });
    assert.strictEqual(own.wake, false, `own-authored (human=${human}) must never wake`);
    assert.strictEqual(own.reason, "self-authored");
  }
  // 0.1.44's working channel must not regress: human:true with no mention still wakes.
  const humanOnly = decideListenWake({ message: { from: REMOTE_HUMAN, human: true, text: "无点名的人类指令" }, self: SELF_NODE });
  assert.strictEqual(humanOnly.wake, true);
  assert.strictEqual(humanOnly.reason, "human-fallback", "the legacy channel is now a FALLBACK — the name says so");
  assert.deepStrictEqual([...WAKE_ADMITTED], ["mention", "human-fallback"], "only these two reasons may wake a node");

  // 0.1.45 REVIEW OUTCOME (A, room seq 3728): the first draft admitted every message
  // authored by the room's CONTROLLER, i.e. it would have turned the owner's status
  // reports into a four-machine broadcast (measured: 6 such reports that day ⇒ 24
  // wasted wakes). "Is this a dispatch" cannot be inferred from WHO wrote it — the
  // same mistake `human:true` was, one layer up. So there is no author-based clause,
  // and these two assertions are what keep it out.
  const controllerPost = decideListenWake({
    message: { from: CTRL_TING, human: false, text: "【总控 · D-28 现场验证结果：D ✓ 通过】多行汇报，不是派活" },
    self: SELF_NODE,
  });
  assert.strictEqual(
    controllerPost.wake,
    false,
    "an UN-addressed message from the room's controller must not wake anyone (0.1.45 review, A)",
  );
  assert.strictEqual(controllerPost.reason, "not-addressed");
  // The controller is woken like anyone else — by being ADDRESSED.
  assert.strictEqual(
    decideListenWake({ message: { from: REMOTE_AGENT, human: false, mentions: [CTRL_TING], text: "请D复核" }, self: { agentId: CTRL_TING, nickname: "D" } }).reason,
    "mention",
  );
});

guarded("0.1.45 counters: every rule outcome is countable, and the legacy 0.1.41 counter cannot drift", () => {
  const wm = new WakeWatermark();
  wm.noteDenied("not-addressed");
  wm.noteDenied("not-addressed");
  wm.noteDenied("control-frame");
  wm.noteDenied("machine-frame");
  wm.noteSelfAuthored(); // the 0.1.41 alias
  wm.noteWokenBy("mention");
  wm.noteWokenBy("human-fallback");
  // 0.1.45b: the three "the sweep never looked" counters (A #2/#3, C's window).
  wm.notePendingSkip();
  wm.notePendingSkip();
  wm.noteSeedSkip();
  wm.noteWindowGap(7);
  const stats = wm.stats();
  assert.strictEqual(stats.deniedNotAddressed, 2);
  assert.strictEqual(stats.deniedControlFrame, 1);
  assert.strictEqual(stats.deniedMachineFrame, 1);
  assert.strictEqual(stats.selfAuthored, 1, "the 0.1.41 counter must keep counting self-authored denials");
  assert.strictEqual(stats.deniedSelfAuthored, stats.selfAuthored, "aliases, not two numbers that can drift");
  assert.strictEqual(stats.wokenByMention, 1);
  assert.strictEqual(stats.wokenByHumanFallback, 1);
  assert.strictEqual(stats.pendingSkips, 2, "a sweep skipped while a wake was in flight must be countable");
  assert.strictEqual(stats.seedSkips, 1, "seeding the cursor must be countable — a message in that instant is not a candidate");
  assert.strictEqual(stats.windowGaps, 1);
  assert.strictEqual(stats.windowGapMessages, 7, "and the NUMBER of swallowed messages, not just the event");
  assert.strictEqual(stats.windowRows, WAKE_WINDOW_ROWS);
  assert.ok(WAKE_WINDOW_ROWS >= 200, `the read window must cover more than one sweep period, got ${WAKE_WINDOW_ROWS}`);
  assert.strictEqual(wm.stats().woken, 0, "noteWokenBy is not a watermark mark: mark() still owns stats().woken");
  // /state's wake block is a FLAT NUMERIC map (the 0.1.41 shape rule): no nesting.
  for (const [key, value] of Object.entries(stats)) {
    assert.strictEqual(typeof value, "number", `wake.${key} must stay a number, got ${typeof value}`);
  }
});

guarded("0.1.45 static guard: the decision point calls the shared rule, and no denial can be silent", () => {
  const raw = readFileSync(join(ROOT, "src", "host", "service.ts"), "utf8");
  // Comments are stripped before the structural assertions: this fix QUOTES the
  // 0.1.44 code verbatim in its own doc comment (that is the evidence), and a guard
  // that cannot tell code from its own quotation would be a guard against writing
  // the history down.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // THE DEFECT, verbatim: `human` as the only admission, `agent` falling out of the
  // loop with no report. Its absence is what this version is.
  assert.ok(
    !/if \(kind === "human"\) return message;/.test(src),
    "the 0.1.44 gate is back (`kind === \"human\"` as the whole rule): a human:false dispatch wakes nobody again",
  );
  assert.ok(
    !/if \(kind === "self"\) onSkip\?\.\(message, "self-authored"\);/.test(src),
    "the half-silent skip is back: only `self` reported, `agent` vanished",
  );
  assert.ok(raw.includes('if (kind === "human") return message;'), "the doc comment must still quote the defect it fixes");
  // One rule, shared with the sender-side preview.
  assert.match(src, /const decision = decideListenWake\(\{ message, self \}\);/, "the rule must come from src/host/wake.ts");
  // Every denial: counted AND logged, with seq + rule + author.
  assert.match(src, /this\.wakeWatermark\.noteDenied\(decision\.reason\);/, "a denial that is not counted is a denial nobody can prove");
  assert.match(
    src,
    /"listening: denied seq=" \+ message\.seq \+ " \(rule=" \+ reason \+ ", from=" \+/,
    "the denial line must name the seq, the rule and the author",
  );
  // ...and the three "the sweep never looked" paths must leave a trace too (0.1.45b):
  assert.match(src, /this\.wakeWatermark\.notePendingSkip\(\);/, "a pending-window skip must be counted (A's list item #3)");
  assert.match(src, /this\.wakeWatermark\.noteSeedSkip\(\);/, "seeding the cursor must be counted (A's list item #2 family)");
  assert.match(src, /const missed = lastSeq - seen - fresh\.length;/, "the read-window gap must be computed (C's finding, seq 3729)");
  assert.match(src, /this\.wakeWatermark\.noteWindowGap\(missed\);/, "and counted, with how many messages it swallowed");
  assert.match(src, /recentMessagesFor\(roomId, WAKE_WINDOW_ROWS\)/, "the sweep must read the widened window, not the old 20 rows");
  // The denial LOGGING policy must stay volume-bounded (the 411 MB lesson): bus frames
  // aggregate per sweep, chat denials are named per message up to a cap.
  assert.match(src, /private logDenials\(/, "the per-sweep denial report must exist");
  assert.match(src, /MAX_NAMED_DENIALS_PER_SWEEP/, "and it must be capped");
  assert.ok(
    !/for \(const \{ message, reason \} of denials\) \{\s*this\.diag\(\s*"listening: denied seq=/.test(src),
    "an unbounded per-message denial line is back: control frames alone measured 152 frames / 3 min",
  );
  // The admission line names the rule that admitted the wake.
  assert.match(src, /", rule=" \+ pick\.decision\.reason/, "the woken line must say WHICH rule woke this node");
  // NO author-based admission: the review (A, seq 3728) removed the controller
  // clause from the WAKE PATH specifically. `Room.controllerAgentId` still exists in
  // this file as DATA (it is published in /state and moved by transferController), so
  // the assertion is scoped to the wake path — the same scoping the 0.1.41 guard uses.
  const wakePath = src.slice(src.indexOf("private async sweepListening("), src.indexOf("private async boot("));
  assert.ok(wakePath.length > 0, "the wake path must be locatable in service.ts");
  assert.ok(
    !/controllerAgentId/.test(wakePath),
    "an author/controller clause is back in the wake path: identity is not evidence that a message is a dispatch",
  );
  assert.ok(!/"controller"/.test(wakePath), "the removed `controller` reason is back in the wake path");
  // Sender-side visibility, in BOTH send surfaces (HTTP route and room_send tool).
  const web = readFileSync(join(ROOT, "src", "host", "web.ts"), "utf8");
  assert.match(web, /service\.gateway\.wakePreview\(roomId, \{/, "POST /chat must consult the rule");
  assert.match(web, /\.\.\.wakeFields/, "both response branches must carry `woken`");
  const tool = readFileSync(join(ROOT, "src", "tools", "index.ts"), "utf8");
  assert.match(tool, /gateway\.wakePreview\(args\.roomId, \{/, "room_send must report the same count");
  assert.match(tool, /woken: wake\.woken/, "room_send's result must carry `woken`");
});

/**
 * The REAL sweep path, with a counting registry exactly like wake-duplicate.test.mjs:
 * one `followup` call == one wake. This is where the defect actually lived.
 */
async function bootRuleProbe(port, tag) {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { Context: CordisContext } = await import("@deepseek-ai/cordis");
  const { AgentRoomService } = await import(libBase + "service.js");
  const dir = await mkdtemp(join(tmpdir(), tag));
  const svc = new AgentRoomService(new CordisContext(), { dataDir: dir, port, relay: "" });
  const end = Date.now() + 8_000;
  while (Date.now() < end && !(svc.profileTimer != null && svc.listenTimer != null)) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(svc.listenTimer != null, `the service must boot (${tag})`);
  const dispatches = [];
  const fakeAgent = {
    id: "session-rule-probe",
    sessionId: "session-rule-probe",
    followup: (message) => {
      dispatches.push(message);
      return { ok: true };
    },
  };
  svc.agentsRegistry = () => ({
    list: () => [fakeAgent],
    roots: () => [fakeAgent],
    get: (id) => (id === fakeAgent.id ? fakeAgent : undefined),
    currentInitiator: () => fakeAgent,
  });
  svc.config.replyAgentId = fakeAgent.id;
  return { svc, dir, dispatches };
}

async function teardownRuleProbe(probe) {
  const { rm } = await import("node:fs/promises");
  for (const timer of [probe?.svc?.profileTimer, probe?.svc?.listenTimer]) {
    try { if (timer) clearInterval(timer); } catch { /* ignore */ }
  }
  try { await probe?.svc?.peerServer?.stop(); } catch { /* ignore */ }
  try { probe?.svc?.discovery?.stop?.(); } catch { /* ignore */ }
  for (const client of probe?.svc?.clients?.values?.() ?? []) { try { client.destroy(); } catch { /* ignore */ } }
  try { await rm(probe.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

guarded("0.1.45 runtime: the sweep WAKES for a mention and LOGS A REASON for every denial", async () => {
  const probe = await bootRuleProbe(19541, "ar-wake-rule-");
  const { svc, dispatches } = probe;
  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.map((a) => String(a)).join(" ")); };
  try {
    const room = await svc.gateway.createRoom({ title: "K family", type: "persistent" });
    const me = svc.roomService.getIdentity();
    assert.ok(me?.agentId, "the node needs an identity for the mention clause to target it");
    // A second member so the sender-side preview has somewhere to point (the local
    // node is always excluded from its own targets by card ④).
    svc.roomService.joinOwnedRoom(
      room.roomId,
      { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() },
      {},
    );
    svc.setListening(room.roomId, true);
    await svc.sweepListening(); // first sweep seeds the cursor: history is not an instruction

    // (a) THE FIX: the dispatch our scripts send — `human:false`, but it NAMES this node.
    const named = await svc.roomService.addChatMessage(
      room.roomId,
      { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() },
      { text: "【派活】@" + (me.nickname ?? me.agentId) + " 请跑回归", human: false, mentions: [me.agentId] },
    );
    svc.listenSeen.set(room.roomId, named.seq - 1);
    await svc.sweepListening();
    await new Promise((r) => setTimeout(r, 60));
    console.log(`  [rule] mention: dispatches=${dispatches.length} stats=${JSON.stringify(svc.wakeWatermark.stats())}`);
    assert.strictEqual(dispatches.length, 1, "a human:false message that NAMES this node must wake it (this is the fix)");
    const wokenLine = lines.find((l) => l.includes(`listening: woken seq=${named.seq}`));
    assert.ok(wokenLine, `the wake must log its seq: ${JSON.stringify(lines.slice(-4))}`);
    assert.match(wokenLine, /rule=mention/, "and it must say WHICH rule admitted it");
    assert.strictEqual(svc.wakeWatermark.stats().wokenByMention, 1, "the admission must be counted by rule");

    // (b) THE OTHER HALF: an unaddressed post wakes nobody — and leaves BOTH a log
    // line and a counter. In 0.1.44 this produced exactly nothing.
    svc.listenPending.delete(room.roomId); // the 60 s re-arm, compressed for the probe
    const unaddressed = await svc.roomService.addChatMessage(
      room.roomId,
      { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() },
      { text: "【总控 · 通知：今晚全员升级（这条不点名任何人）】", human: false },
    );
    await svc.sweepListening();
    await new Promise((r) => setTimeout(r, 60));
    console.log(`  [rule] unaddressed: dispatches=${dispatches.length} line=${lines.find((l) => l.includes("denied")) ?? "(none)"}`);
    assert.strictEqual(dispatches.length, 1, "an unaddressed post must not wake anyone (no storm)");
    const deniedLine = lines.find((l) => l.includes(`listening: denied seq=${unaddressed.seq}`));
    assert.ok(deniedLine, "a denied message MUST leave a line naming its seq (the defect was the missing line)");
    assert.match(deniedLine, /rule=not-addressed/, "the line must name the rule that denied it");
    assert.match(deniedLine, /from=A\//, "the line must name the author");
    assert.strictEqual(svc.wakeWatermark.stats().deniedNotAddressed, 1, "and the denial must be counted");
    // Nothing bypassed the guard: the tripwire stays 0.
    assert.strictEqual(svc.wakeWatermark.stats().regressed, 0);

    // (c) C's finding, made measurable (room seq 3729): with a FINITE read window,
    // messages can fall outside it and be neither woken for nor denied. The window is
    // now 200 rows — large enough to cover several sweep periods — and whatever still
    // falls through is COUNTED and NAMED instead of vanishing.
    svc.listenPending.delete(room.roomId);
    const burst = WAKE_WINDOW_ROWS + 7;
    const author = { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() };
    for (let i = 0; i < burst; i += 1) {
      await svc.roomService.addChatMessage(room.roomId, author, { text: "【org-free noise " + i + "】", human: false });
    }
    svc.listenSeen.set(room.roomId, 0); // pretend this node has never swept this room
    await svc.sweepListening();
    await new Promise((r) => setTimeout(r, 60));
    const gapStats = svc.wakeWatermark.stats();
    console.log(`  [rule] window gap: messages=${burst} windowRows=${gapStats.windowRows} windowGaps=${gapStats.windowGaps} missed=${gapStats.windowGapMessages}`);
    assert.ok(gapStats.windowRows >= WAKE_WINDOW_ROWS, "the sweep must read the widened window");
    assert.ok(gapStats.windowGaps >= 1, "a window that drops messages must COUNT the event");
    assert.ok(gapStats.windowGapMessages >= 1, "and how many messages were never candidates");
    assert.ok(
      lines.some((l) => l.includes("listening: window gap")),
      "the gap must be NAMED in the log, not just counted (this is the hole C found)",
    );
  } finally {
    console.error = realError;
    await teardownRuleProbe(probe);
  }
});

guarded("0.1.45 runtime: POST /chat answers with `woken`, so 'delivered' can never be read as 'acted on'", async () => {
  const probe = await bootRuleProbe(19542, "ar-wake-preview-");
  const { svc } = probe;
  try {
    const { createRouter } = await import(libBase + "web.js");
    const room = await svc.gateway.createRoom({ title: "K family", type: "persistent" });
    svc.roomService.joinOwnedRoom(
      room.roomId,
      { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() },
      {},
    );
    // The controller seat is deliberately LEFT with the member here: with no
    // author-based clause in the rule, neither seat changes what this node's own
    // unaddressed posts do (asserted both ways below).
    const handler = createRouter(svc);
    const server = createServer((req, res) => void handler(req, res));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body) => {
      const res = await fetch(`${base}/agent-room-api/rooms/${encodeURIComponent(room.roomId)}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };
    try {
      // The DISPATCH form our scripts send: human:false + an address.
      const named = await post({ text: "@A 请交问卷", human: false, mentions: ["A"] });
      console.log(`  [preview] addressed: ${JSON.stringify(named.json.data)}`);
      assert.strictEqual(named.status, 200);
      assert.strictEqual(named.json.data.woken, 1, "an addressed post must report exactly one woken member");
      assert.deepStrictEqual(named.json.data.wake.targets, [SELF_JIE]);
      assert.deepStrictEqual(named.json.data.wake.reasons, ["mention"]);
      assert.match(named.json.data.wake.note, /predicted/, "the note must say this is a rule prediction, not a receipt");
      // Backward compatibility: every field this branch answered before is still
      // answered, unchanged (`queued` / `reason` belong to the JOINED-room branch,
      // which has its own spread — see the static guard above).
      for (const field of ["seq", "acceptedByLocalHub", "confirmedByOwner", "confirmNote", "delivered"]) {
        assert.ok(field in named.json.data, `the 0.1.35 field \`${field}\` must still be answered`);
      }
      assert.strictEqual(named.json.data.confirmedByOwner, true, "the owner still confirms it (web.ts unchanged there)");
      // The 0.1.44 regression itself: same channel, same author, no address.
      const unaddressed = await post({ text: "【总控 · 问卷】填写人：D、C、B、A", human: false });
      console.log(`  [preview] unaddressed: woken=${unaddressed.json.data.woken} reasons=${JSON.stringify(unaddressed.json.data.wake.reasons)}`);
      assert.strictEqual(
        unaddressed.json.data.woken,
        0,
        "an unaddressed post must answer woken:0 — this is the field seq 3267's sender never had",
      );
      assert.deepStrictEqual(unaddressed.json.data.wake.targets, []);
      assert.strictEqual(unaddressed.json.data.confirmedByOwner, true, "it is still DELIVERED — that was never the problem");

      // 0.1.45 REVIEW OUTCOME (A, room seq 3728): even the room's CONTROLLER — the
      // seat that is authoritative for judging — does not get a broadcast. Give the
      // seat back to this node and the same unaddressed post must STILL report
      // woken:0; the first draft of this version admitted it and would have woken all
      // four other machines for every status report the owner posts.
      await svc.gateway.transferController(room.roomId, svc.roomService.getIdentity().agentId);
      const controllerPost = await post({ text: "【总控 · D-28 现场验证结果：通过】这是一条多行汇报，不是派活", human: false });
      console.log(`  [preview] un-addressed CONTROLLER post: woken=${controllerPost.json.data.woken} reasons=${JSON.stringify(controllerPost.json.data.wake.reasons)}`);
      assert.strictEqual(
        controllerPost.json.data.woken,
        0,
        "an un-addressed post from the room's controller must answer woken:0 too (no author-based broadcast)",
      );
      assert.ok(
        svc.roomService.getOwnedRoom(room.roomId).controllerAgentId === svc.roomService.getIdentity().agentId,
        "the fixture must really be the controller, or this assertion proves nothing",
      );
      // A machine self-test stamp is refused as well (storm guard).
      const stamp = await post({ text: "***** 0.1.45 self-verify", human: false });
      assert.strictEqual(stamp.json.data.woken, 0, "a self-test stamp must not wake anyone");
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    await teardownRuleProbe(probe);
  }
});

guarded("0.1.45 runtime: the denial LOG stays bounded — chat denials are named (capped), bus frames aggregated", async () => {
  const probe = await bootRuleProbe(19543, "ar-wake-logden-");
  const { svc } = probe;
  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.map((a) => String(a)).join(" ")); };
  try {
    const room = await svc.gateway.createRoom({ title: "K family", type: "persistent" });
    const mk = (seq, reason, text) => ({ message: { seq, from: "01a0dead", fromNickname: "C", text }, reason });
    const denials = [];
    for (let i = 0; i < MAX_NAMED_DENIALS_PER_SWEEP + 5; i += 1) denials.push(mk(100 + i, "not-addressed", "chat"));
    for (let i = 0; i < 60; i += 1) denials.push(mk(300 + i, "control-frame", "[org:exec:result] x"));
    for (let i = 0; i < 2; i += 1) denials.push(mk(500 + i, "machine-frame", "A升 0.1.45 自证"));
    svc.logDenials(room.roomId, denials);
    const named = lines.filter((l) => l.includes("listening: denied seq="));
    const busLine = lines.filter((l) => l.includes("listening: denied 60 message(s)"));
    const frameLine = lines.filter((l) => l.includes("listening: denied 2 message(s)"));
    const suppressed = lines.filter((l) => l.includes("listening: denied 5 more message(s)"));
    console.log(`  [logpolicy] lines=${lines.length} named=${named.length} agg60=${busLine.length} agg2=${frameLine.length} suppressed=${suppressed.length}`);
    assert.strictEqual(named.length, MAX_NAMED_DENIALS_PER_SWEEP, "chat denials are named per message, up to the cap");
    assert.ok(named[0].includes("(rule=not-addressed, from=C/01a0dead)"), "a named denial carries the rule AND the author");
    assert.strictEqual(busLine.length, 1, "60 control frames must be ONE aggregate line, not 60 (the 411 MB lesson)");
    assert.match(busLine[0], /seq=300\.\.359/, "and the aggregate must name the seq range it covers");
    assert.strictEqual(frameLine.length, 1, "machine frames aggregate the same way");
    assert.match(frameLine[0], /seq=500,501/, "a small aggregate lists the exact seqs instead of a range");
    assert.strictEqual(suppressed.length, 1, "the cap must say how many it did not name");
    assert.ok(lines.length <= MAX_NAMED_DENIALS_PER_SWEEP + 3, `the log must stay bounded under any traffic, got ${lines.length} lines`);
  } finally {
    console.error = realError;
    await teardownRuleProbe(probe);
  }
});

const watchdog = setTimeout(() => process.exit(failures > 0 ? 1 : 0), 25_000);
watchdog.unref();
