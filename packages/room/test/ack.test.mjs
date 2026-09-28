/**
 * dsh-agent-room 0.1.46 — the ACK plane: a RECEIPT that says "this dispatch ARRIVED at
 * a machine and a resident agent was handed it".
 *
 * THE DEFECT (measured on the live fleet, 2026-09-15 — the day 0.1.45 shipped)
 *
 * 0.1.45 fixed the WAKE plane: a script message (`human=false`) that names a node wakes
 * it, and every node's own log says so (`listening: woken seq=… rule=mention`). That was
 * verified on C, A, D and B. **And that is where the evidence stopped.**
 *
 * The control node then dispatched a meeting call (room seq 4405) naming all four
 * machines. All four logged the wake; two even logged `activate-chat`. **One replied.**
 * The other three produced NOTHING — and no log, no counter and nothing in the room could
 * distinguish "I received this and started" from "I was activated and nothing happened".
 * Diagnosing it took a 142,000-line log read by hand.
 *
 * WHY `woken` DOES NOT COVER THIS
 *
 * `wake.wokenByMention` and the sender-side `woken` field are a rule PREDICTION computed
 * on the SENDER's own room view (`service.ts wakePreviewFor`). They count DISPATCHES, not
 * DELIVERIES: the number is identical whether the target processed the message, was
 * offline, had listening OFF, or was inside its `listenPending` window. 0.1.45 wrote that
 * bound into its own `wake.note`; this suite is the assertion that 0.1.46 delivers the
 * receipt instead.
 *
 * WHAT THIS FILE PROVES (all against the built artifact — `node build.mjs` first)
 *   1. the receipt line is ONE line, names the acking node's OWN nickname and the seq,
 *      and is a machine frame (carries no `@`, so it can never wake a colleague);
 *   2. at most ONE receipt per `(roomId, seq)`, EVER — the second wake for the same seq
 *      produces no second receipt;
 *   3. at most one receipt per room per rate-limit window, and the refusal is COUNTED;
 *   4. no receipt at all for a denied wake (not-addressed / machine-frame / self-authored)
 *      and none when the wake itself is skipped by the watermark;
 *   5. the sender side: a receipt from the addressed machine is OBSERVED, and a dispatch
 *      that never gets one becomes `unackedTargets` + ONE `[ack-miss]` room line — the
 *      absence is a fact, not an inference;
 *   6. `/state.ack` really carries the counters, flat and numeric, next to 0.1.45's
 *      `wake` block (which must be untouched);
 *   7. a failed receipt cannot affect the handling (the wake already happened) and is
 *      counted rather than swallowed;
 *   8. static guards: the receipt is posted only AFTER `agent.followup`, is never
 *      awaited, and the expectation is opened in the ONE place every send path funnels
 *      through;
 *   9. 0.1.45's wake behaviour is unchanged (mention wakes, human fallback wakes,
 *      machine stamps / control frames / unaddressed / self-authored never do).
 *
 * `AR_LIB` points this suite at ANOTHER build's lib directory (house rule: a new
 * assertion must be able to fail on the old code). On the 0.1.45 lib `host/ack.js` does
 * not exist, so every ack assertion below fails there BY CONSTRUCTION — which is exactly
 * the point: there is no receipt, no counter and no way to tell delivered-but-silent from
 * not-delivered.
 *
 * Pure in-process state plus one local HTTP-free service probe: no live room, no other
 * machine, nothing written outside a temp dir. Run directly:
 *   node test/ack.test.mjs
 * (never `node --test`).
 */

import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AR_LIB = process.env.AR_LIB;
const libBase = AR_LIB ? pathToFileURL(join(AR_LIB, "host") + "/").href : "../lib/host/";

/**
 * The 0.1.45 surface (present on both builds) — imported dynamically so a link-time
 * failure on an old build cannot take the whole suite down and hide the individual
 * assertions.
 */
const wake = await import(libBase + "wake.js");
const { decideListenWake, isMachineSelfTestFrame, WakeWatermark, WAKE_WINDOW_ROWS } = wake;

/**
 * The 0.1.46 surface. `host/ack.js` is ABSENT on the deployed 0.1.45 build; the import is
 * therefore guarded, and every ack test fails loudly instead of erroring at link time.
 */
let ackMod = null;
let ackImportError = null;
try {
  ackMod = await import(libBase + "ack.js");
} catch (error) {
  ackImportError = error;
}
const {
  ACK_TAG = undefined,
  ACK_MISS_TAG = undefined,
  ACK_RATE_LIMIT_MS = undefined,
  ACK_WINDOW_MS = undefined,
  ACK_RECEIPT_MAX_CHARS = undefined,
  MAX_ACK_ROOMS = undefined,
  MAX_ACK_SEQS_PER_ROOM = undefined,
  MAX_ACK_EXPECTATIONS = undefined,
  formatAckReceipt = undefined,
  formatAckMiss = undefined,
  isAckPlaneFrame = undefined,
  parseAckReceipt = undefined,
  AckLedger = undefined,
} = ackMod ?? {};

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOM = "01a098a2-2015-7a1d-b5f7-9eca45afa65d";
const SELF_JIE = "01a0281a-52de-7c4d-a1e9-7e6db367d3dd"; // A
const SELF_XM = "01a09461-351d-793d-bf49-b8e08641f082"; // B
const SEQ_4405 = 4405; // the meeting call that woke four machines and got one reply

/** Same node:test idiom as the other suites (see wake.test.mjs). */
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

/** Every ack assertion calls this first: on the 0.1.45 lib it fails the test by name. */
function needAck(what) {
  if (!ackMod) {
    failures += 1;
    throw new Error(
      `the ack plane does not exist on this build (AR_LIB=${AR_LIB ?? "(local lib)"}): ` +
        `no receipt, no counter, no way to tell delivered-but-silent from not-delivered — ${what}. ` +
        `import error: ${String(ackImportError)}`,
    );
  }
}

/* ============================ 1. the receipt LINE ============================ */

guarded("0.1.46 receipt: ONE line naming MY nickname and the seq I am acknowledging", () => {
  needAck("the receipt line is the whole deliverable");
  const line = formatAckReceipt({ nickname: "A", agentId: SELF_JIE, seq: SEQ_4405 });
  console.log(`  [line] ${line}`);
  assert.ok(!line.includes("\n"), "a receipt is ONE line — a receipt that needs reading is not a receipt");
  assert.ok(line.length <= ACK_RECEIPT_MAX_CHARS, `the receipt must stay short, got ${line.length} chars`);
  assert.ok(line.startsWith(ACK_TAG), "the receipt must carry the machine-readable tag");
  assert.ok(line.includes("A"), "the receipt must name the ACKING node's OWN nickname");
  assert.ok(line.includes("seq=" + SEQ_4405), "the receipt must name the seq it acknowledges");
  assert.ok(line.includes("已接手"), "the receipt must say the target has started handling it");
  // NOT addressed to anyone: an `@` here would turn every receipt into a fresh mention of
  // a colleague on four machines — a wake storm made of the message that ends the silence.
  assert.ok(!line.includes("@"), "a receipt must never contain `@` (it must wake nobody)");
  assert.strictEqual(parseAckReceipt(line), SEQ_4405, "the seq must be machine-readable for the sender");
  assert.strictEqual(parseAckReceipt("no receipt here"), undefined);
  // A nickname is optional (fallback to agentId) but the shape never degrades.
  assert.ok(formatAckReceipt({ agentId: SELF_XM, seq: 7 }).includes(SELF_XM));
});

guarded("0.1.46 receipt: the receipt is a MACHINE FRAME — it wakes nobody, including its own author", () => {
  needAck("the receipt must not manufacture a wake storm");
  const receipt = formatAckReceipt({ nickname: "A", agentId: SELF_JIE, seq: SEQ_4405 });
  assert.strictEqual(isAckPlaneFrame(receipt), true, "the ack plane must recognise its own line");
  assert.strictEqual(isAckPlaneFrame("【派活】请跑回归"), false, "and must not swallow real chat");
  assert.strictEqual(isMachineSelfTestFrame(receipt), false, "it is a SEPARATE classifier, not a stamp hack");

  // A COLLEAGUE reading A's receipt: denied as a machine frame, aggregated into one
  // line per sweep instead of consuming the per-message naming budget.
  const colleague = decideListenWake({
    message: { from: SELF_JIE, fromNickname: "A", human: false, text: receipt },
    self: { agentId: SELF_XM, nickname: "B" },
  });
  assert.strictEqual(colleague.wake, false, "a receipt must never wake a colleague (four machines run listening)");
  assert.strictEqual(colleague.reason, "machine-frame", "and the denial must name a rule the caller can count");
  // The ACKER reading its own receipt: card ④ applies first — self-authored.
  const own = decideListenWake({
    message: { from: SELF_JIE, fromNickname: "A", human: false, text: receipt },
    self: { agentId: SELF_JIE, nickname: "A" },
  });
  assert.strictEqual(own.wake, false);
  assert.strictEqual(own.reason, "self-authored");
  // The absence notice is in the same family.
  const miss = formatAckMiss({ seq: SEQ_4405, nicknames: ["B"], waitedMs: ACK_WINDOW_MS });
  console.log(`  [line] ${miss}`);
  assert.ok(miss.startsWith(ACK_MISS_TAG));
  assert.strictEqual(isAckPlaneFrame(miss), true, "the absence notice must be recognised too");
  assert.ok(!miss.includes("@"), "the absence notice must not mention anyone either");
  assert.strictEqual(
    decideListenWake({ message: { from: SELF_JIE, human: false, text: miss }, self: { agentId: SELF_XM, nickname: "B" } }).wake,
    false,
    "an absence notice must not wake the machine it is complaining about",
  );
});

/* ==================== 2. the RECEIVER side: once per (room, seq) ==================== */

guarded("0.1.46: at most ONE receipt per (roomId, seq) EVER — the ledger refuses the second", () => {
  needAck("receipt dedupe is the contract the card asserts");
  const ledger = new AckLedger();
  const t0 = 1_000_000;
  assert.strictEqual(ledger.allowReceipt(ROOM, SEQ_4405, t0), "ok", "the first receipt for a seq must be allowed");
  ledger.noteReceiptPosted(ROOM, SEQ_4405, t0);
  // The second wake for the same seq — even much later, with the rate limit long past.
  assert.strictEqual(
    ledger.allowReceipt(ROOM, SEQ_4405, t0 + 10 * ACK_RATE_LIMIT_MS),
    "duplicate",
    "a second wake for the same seq must produce NO second receipt",
  );
  const stats = ledger.stats();
  assert.strictEqual(stats.receiptsPosted, 1, "exactly one receipt was posted");
  assert.strictEqual(stats.receiptsDup, 1, "and the refusal is COUNTED (never silent)");
  assert.strictEqual(stats.ackedSeqs, 1, "one distinct seq acked");
  assert.strictEqual(stats.maxAckedSeq, SEQ_4405, "the highest acked seq is exposed to the sender");
  // A DIFFERENT room with the same seq is a different dispatch and gets its own receipt.
  assert.strictEqual(ledger.allowReceipt("other-room", SEQ_4405, t0), "ok", "rooms are independent");
  // A newer seq in the same room is a new dispatch — allowed once the rate limit passes.
  assert.strictEqual(ledger.allowReceipt(ROOM, SEQ_4405 + 1, t0 + 10 * ACK_RATE_LIMIT_MS), "ok");
  // Invalid seqs (this node's own optimistic rows are NEGATIVE) are never acked.
  assert.notStrictEqual(ledger.allowReceipt(ROOM, -1234, t0 + 10 * ACK_RATE_LIMIT_MS), "ok");
});

guarded("0.1.46: the per-room rate limit is respected — a dispatch burst cannot become a line burst", () => {
  needAck("noise control is part of the design, not an afterthought");
  const ledger = new AckLedger();
  const t0 = 2_000_000;
  const verdicts = [];
  for (let i = 0; i < 5; i += 1) {
    const seq = 5000 + i; // five DIFFERENT dispatches arriving inside one rate window
    const verdict = ledger.allowReceipt(ROOM, seq, t0);
    verdicts.push(verdict);
    if (verdict === "ok") ledger.noteReceiptPosted(ROOM, seq, t0);
  }
  console.log(`  [ratelimit] verdicts=${JSON.stringify(verdicts)} rateLimitMs=${ACK_RATE_LIMIT_MS}`);
  assert.strictEqual(verdicts[0], "ok", "the first receipt goes out");
  assert.deepStrictEqual(verdicts.slice(1), ["rate-limited", "rate-limited", "rate-limited", "rate-limited"]);
  const stats = ledger.stats();
  assert.strictEqual(stats.receiptsPosted, 1, "five dispatches in one window produce ONE line, not five");
  assert.strictEqual(stats.receiptsRateLimited, 4, "and every suppression is counted");
  // After the window, the next dispatch is receipted again — the limiter is not a mute.
  assert.strictEqual(ledger.allowReceipt(ROOM, 5005, t0 + ACK_RATE_LIMIT_MS), "ok", "the limiter must clear");
  // The limiter is PER ROOM: a busy room cannot mute a quiet one.
  assert.strictEqual(ledger.allowReceipt("quiet-room", 1, t0), "ok", "the rate limit is per room");
  assert.strictEqual(ledger.stats().rateLimitMs, ACK_RATE_LIMIT_MS, "the bound is exposed as data, not folklore");
  assert.strictEqual(ledger.stats().windowMs, ACK_WINDOW_MS);
});

guarded("0.1.46: memory stays bounded — room cap, seq cap and expectation cap all reset instead of growing", () => {
  needAck("bounded memory is a house rule (the 411 MB audit file)");
  let resets = 0;
  const ledger = new AckLedger(MAX_ACK_ROOMS, ACK_RATE_LIMIT_MS, ACK_WINDOW_MS, (message) => {
    resets += 1;
    assert.match(message, /ack (plane room cap|seq set)/);
  });
  for (let i = 0; i < 500; i += 1) ledger.noteReceiptPosted("room-" + i, 1000 + i, i);
  const stats = ledger.stats();
  assert.ok(stats.rooms <= MAX_ACK_ROOMS, `rooms held ${stats.rooms} > cap ${MAX_ACK_ROOMS}`);
  assert.ok(stats.roomResets >= 1, "500 rooms against a cap of 128 must reset at least once");
  assert.strictEqual(stats.maxRooms, MAX_ACK_ROOMS);
  // One room, many seqs: the per-room set is capped (never unbounded).
  const oneRoom = new AckLedger();
  for (let i = 0; i < MAX_ACK_SEQS_PER_ROOM + 10; i += 1) oneRoom.noteReceiptPosted("r", i + 1, 0);
  assert.ok(oneRoom.stats().roomResets >= 1, "the per-room seq set must be capped and cleared");
  // Expectations are capped, and overflowing is COUNTED (never a silent drop).
  const many = new AckLedger();
  let accepted = 0;
  for (let i = 0; i < MAX_ACK_EXPECTATIONS + 5; i += 1) {
    if (many.expect("r", i + 1, [{ agentId: SELF_JIE, nickname: "A" }], 0)) accepted += 1;
  }
  assert.strictEqual(accepted, MAX_ACK_EXPECTATIONS, "only the capped number of dispatches can be tracked");
  assert.strictEqual(many.stats().expectationOverflows, 5, "and the overflow is visible, not hidden");
});

/* ==================== 3. the SENDER side: receipt observed, absence named ==================== */

guarded("0.1.46 sender: a receipt from the ADDRESSED machine is observed; nobody else's counts", () => {
  needAck("this is the half that makes 'not acked' decidable");
  const ledger = new AckLedger();
  assert.strictEqual(
    ledger.expect(ROOM, SEQ_4405, [{ agentId: SELF_JIE, nickname: "A" }, { agentId: SELF_XM, nickname: "B" }], 0),
    true,
  );
  let stats = ledger.stats();
  assert.strictEqual(stats.dispatches, 1, "the dispatch is tracked");
  assert.strictEqual(stats.expectedTargets, 2, "both addressed machines are expected to receipt it");
  assert.strictEqual(stats.pendingTargets, 2, "and both start as pending");

  // A's receipt — the exact line 0.1.46 produces, as the owner stores it (`from` = the
  // acking node's own agentId, which is what makes the match authoritative).
  const observed = ledger.observe(ROOM, [
    { seq: 4404, from: SELF_XM, text: "【汇报】先前的活儿干完了，很长的一段正文" },
    { seq: 4405, from: SELF_JIE, text: formatAckReceipt({ nickname: "A", agentId: SELF_JIE, seq: SEQ_4405 }) },
  ]);
  console.log(`  [sender] observed=${JSON.stringify(observed)} stats=${JSON.stringify(ledger.stats())}`);
  assert.deepStrictEqual(observed, [SELF_JIE], "only the machine that actually receipted is counted");
  stats = ledger.stats();
  assert.strictEqual(stats.ackedTargets, 1, "one of two targets acked");
  assert.strictEqual(stats.maxAckedObservedSeq, SEQ_4405, "the highest acked seq is readable without any log");
  assert.strictEqual(stats.pendingTargets, 1, "B is still pending — she has not been heard from");

  // A receipt that names the WRONG seq, or comes from someone who was not addressed, must
  // not count: a false positive here would be worse than no receipt at all.
  const wrongSeq = ledger.observe(ROOM, [
    { seq: 9, from: SELF_XM, text: formatAckReceipt({ nickname: "B", agentId: SELF_XM, seq: 9999 }) },
  ]);
  assert.deepStrictEqual(wrongSeq, [], "a receipt for a different seq must not close this expectation");
  const stranger = ledger.observe(ROOM, [
    { seq: 9, from: "01a0dead-0000-0000-0000-000000000000", text: formatAckReceipt({ nickname: "路人", seq: SEQ_4405 }) },
  ]);
  assert.deepStrictEqual(stranger, [], "a receipt from an un-addressed node must not count");
  assert.strictEqual(ledger.stats().ackedTargets, 1, "the count did not move on either");
  // A plain chat line that merely CONTAINS the seq is not a receipt.
  assert.deepStrictEqual(
    ledger.observe(ROOM, [{ seq: 9, from: SELF_XM, text: `我已经看到 seq=${SEQ_4405} 了，正在处理` }]),
    [],
    "prose about the seq is not a receipt — the tag is what makes it machine-checkable",
  );
});

guarded("0.1.46 sender: a dispatch nobody acked becomes `unackedTargets` — the ABSENCE is a fact", () => {
  needAck("a silent non-delivery is the thing that cost a whole day");
  const ledger = new AckLedger(MAX_ACK_ROOMS, ACK_RATE_LIMIT_MS, ACK_WINDOW_MS);
  const t0 = 5_000_000;
  ledger.expect(ROOM, SEQ_4405, [{ agentId: SELF_JIE, nickname: "A" }, { agentId: SELF_XM, nickname: "B" }], t0);
  ledger.observe(ROOM, [
    { seq: SEQ_4405, from: SELF_JIE, text: formatAckReceipt({ nickname: "A", agentId: SELF_JIE, seq: SEQ_4405 }) },
  ]);
  // Inside the window: nothing is declared missing yet (the target may still be working).
  assert.deepStrictEqual(ledger.expire(t0 + ACK_WINDOW_MS - 1), [], "inside the window nothing may be called missing");
  assert.strictEqual(ledger.stats().unackedTargets, 0);
  // Past the window: the ONE machine that never receipted is named — with its nickname.
  const overdue = ledger.expire(t0 + ACK_WINDOW_MS + 1);
  console.log(`  [absence] overdue=${JSON.stringify(overdue)} stats=${JSON.stringify(ledger.stats())}`);
  assert.strictEqual(overdue.length, 1, "one dispatch had a missing receipt");
  assert.deepStrictEqual(overdue[0].nicknames, ["B"], "and the missing party is named, not implied");
  assert.strictEqual(overdue[0].seq, SEQ_4405, "the seq is named — this is what makes it traceable in the room");
  const stats = ledger.stats();
  assert.strictEqual(stats.unackedTargets, 1, "the absence counter moved");
  assert.strictEqual(stats.ackedTargets, 1, "while the machine that DID answer stays counted");
  assert.strictEqual(stats.pendingTargets, 0, "nothing is left pending");
  // Expiring again must not double-count, and a dispatch that was fully acked is silent.
  assert.deepStrictEqual(ledger.expire(t0 + ACK_WINDOW_MS + 10_000), [], "an expired expectation is closed once");
  assert.strictEqual(ledger.stats().unackedTargets, 1, "and the counter cannot drift by re-expiring");
  const ok = new AckLedger();
  ok.expect(ROOM, 10, [{ agentId: SELF_JIE, nickname: "A" }], 0);
  ok.observe(ROOM, [{ seq: 10, from: SELF_JIE, text: formatAckReceipt({ nickname: "A", seq: 10 }) }]);
  assert.deepStrictEqual(ok.expire(ACK_WINDOW_MS + 1), [], "a fully acked dispatch produces no absence notice");
  assert.strictEqual(ok.stats().unackedTargets, 0);
  // One absence notice per dispatch, however many sweeps see it.
  assert.strictEqual(ok.needMissNotice(ROOM, 10), true);
  ok.noteMissPosted(ROOM, 10);
  assert.strictEqual(ok.needMissNotice(ROOM, 10), false, "the notice must be posted once per (room, seq)");
  assert.strictEqual(ok.stats().missNotices, 1);
  // Untrackable dispatches are refused HONESTLY instead of opening an expectation that a
  // receipt could never match: no targets, or a negative local (not-yet-stored) seq.
  assert.strictEqual(ledger.expect(ROOM, 11, [], 0), false, "an unaddressed post has nobody to receipt it");
  assert.strictEqual(ledger.expect(ROOM, -Date.now(), [{ agentId: SELF_JIE }], 0), false, "a local pending seq cannot be matched");
});

/* ==================== 4. runtime: the real sweep, the real receipt ==================== */

async function bootAckProbe(port, tag) {
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
    id: "session-ack-probe",
    sessionId: "session-ack-probe",
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

async function teardownAckProbe(probe) {
  const { rm } = await import("node:fs/promises");
  for (const timer of [probe?.svc?.profileTimer, probe?.svc?.listenTimer]) {
    try { if (timer) clearInterval(timer); } catch { /* ignore */ }
  }
  try { await probe?.svc?.peerServer?.stop(); } catch { /* ignore */ }
  try { probe?.svc?.discovery?.stop?.(); } catch { /* ignore */ }
  for (const client of probe?.svc?.clients?.values?.() ?? []) { try { client.destroy(); } catch { /* ignore */ } }
  try { await rm(probe.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Every message in the room store, newest last (the room is what a human reads). */
const roomTexts = async (svc, roomId) =>
  (await svc.roomService.recentMessages(roomId, 200)).map((m) => m.text ?? "");
const ackLines = async (svc, roomId) =>
  (await roomTexts(svc, roomId)).filter((t) => typeof t === "string" && t.startsWith("[ack]"));
const missLines = async (svc, roomId) =>
  (await roomTexts(svc, roomId)).filter((t) => typeof t === "string" && t.startsWith("[ack-miss]"));

/** Wait for the fire-and-forget receipt write to land (it is deliberately not awaited). */
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

guarded("0.1.46 runtime: a mention wakes the node AND posts exactly ONE receipt for that seq", async () => {
  needAck("the end-to-end receipt is the deliverable");
  const probe = await bootAckProbe(19561, "ar-ack-receipt-");
  const { svc, dispatches } = probe;
  const lines = [];
  const realError = console.error;
  const realWarn = console.warn;
  // Both channels are captured: `diag` writes to console.error, `warnRateLimited` to
  // console.warn, and an operator sees them in the same log file.
  const capture = (...args) => { lines.push(args.map((a) => String(a)).join(" ")); };
  console.error = capture;
  console.warn = capture;
  try {
    const room = await svc.gateway.createRoom({ title: "Ack family", type: "persistent" });
    const me = svc.roomService.getIdentity();
    assert.ok(me?.agentId && me?.nickname, "the probe node needs an identity (nickname is what the receipt names)");
    svc.roomService.joinOwnedRoom(
      room.roomId,
      { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() },
      {},
    );
    svc.setListening(room.roomId, true);
    await svc.sweepListening(); // first sweep seeds the cursor: history is not an instruction

    // The dispatch shape our scripts send: human=false, but it NAMES this node.
    const named = await svc.roomService.addChatMessage(
      room.roomId,
      { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() },
      { text: "【派活】@" + (me.nickname ?? me.agentId) + " 请跑回归", human: false, mentions: [me.agentId] },
    );
    svc.listenSeen.set(room.roomId, named.seq - 1);
    await svc.sweepListening();
    await settle();

    console.log(`  [receipt] dispatch seq=${named.seq} dispatches=${dispatches.length} lines=${JSON.stringify(await ackLines(svc, room.roomId))}`);
    console.log(`  [receipt] ack stats=${JSON.stringify(svc.ackLedger.stats())}`);
    assert.strictEqual(dispatches.length, 1, "the mention must wake the target (0.1.45 behaviour, unchanged)");
    const ack = await ackLines(svc, room.roomId);
    assert.strictEqual(ack.length, 1, `exactly ONE receipt must be posted, got ${ack.length}: ${JSON.stringify(ack)}`);
    assert.strictEqual(
      ack[0],
      formatAckReceipt({ nickname: me.nickname, agentId: me.agentId, seq: named.seq }),
      "the receipt must name THIS node's own nickname and the seq it acknowledges",
    );
    let stats = svc.ackLedger.stats();
    assert.strictEqual(stats.receiptsPosted, 1, "the receipt counter must move");
    assert.strictEqual(stats.ackedSeqs, 1);
    assert.strictEqual(stats.maxAckedSeq, named.seq, "/state must expose the highest acked seq");
    assert.strictEqual(stats.receiptsFailed, 0, "nothing failed");
    assert.ok(
      lines.some((l) => l.includes("ack: receipt posted for seq=" + named.seq)),
      "the receipt must leave a self-describing line (this is the signal the log expedition lacked)",
    );

    // (2) THE SECOND WAKE FOR THE SAME SEQ: nothing new may be posted. The wake watermark
    // is the first guard; the ack ledger's own (room, seq) rule is the second.
    const before = (await ackLines(svc, room.roomId)).length;
    svc.listenPending.delete(room.roomId);
    svc.listenSeen.set(room.roomId, named.seq - 1); // pretend the cursor regressed (the 0.1.40 shape)
    await svc.sweepListening();
    await settle();
    assert.strictEqual(dispatches.length, 1, "the wake watermark must still block the second wake");
    assert.strictEqual((await ackLines(svc, room.roomId)).length, before, "and no second receipt may appear");
    // Prove the ACK plane's own guard independently of the watermark: call the receipt
    // boundary directly for a seq that was already receipted.
    await svc.postAckReceipt(room.roomId, svc.roomService.getIdentity(), named.seq, "mention");
    await settle();
    stats = svc.ackLedger.stats();
    assert.strictEqual((await ackLines(svc, room.roomId)).length, before, "a duplicate seq must produce NO line");
    assert.strictEqual(stats.receiptsDup, 1, "and the duplicate must be counted");
    assert.ok(
      lines.some((l) => l.includes("ack: no receipt for seq=" + named.seq) && l.includes("reason=duplicate")),
      "a refused receipt must say why",
    );
  } finally {
    console.error = realError;
    console.warn = realWarn;
    await teardownAckProbe(probe);
  }
});

guarded("0.1.46 runtime: NO receipt for a denied wake, and none when the wake is skipped", async () => {
  needAck("a receipt for a message that woke nobody would be a lie");
  const probe = await bootAckProbe(19562, "ar-ack-deny-");
  const { svc, dispatches } = probe;
  const lines = [];
  const realError = console.error;
  const realWarn = console.warn;
  // Both channels are captured: `diag` writes to console.error, `warnRateLimited` to
  // console.warn, and an operator sees them in the same log file.
  const capture = (...args) => { lines.push(args.map((a) => String(a)).join(" ")); };
  console.error = capture;
  console.warn = capture;
  try {
    const room = await svc.gateway.createRoom({ title: "Ack deny", type: "persistent" });
    const author = { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() };
    svc.roomService.joinOwnedRoom(room.roomId, author, {});
    svc.setListening(room.roomId, true);
    await svc.sweepListening();

    const send = async (text, extra = {}) => {
      const message = await svc.roomService.addChatMessage(room.roomId, author, { text, human: false, ...extra });
      return message.seq;
    };

    // (a) not-addressed: wakes nobody, therefore receipts nothing.
    svc.listenPending.delete(room.roomId);
    const unaddressed = await send("【总控 · 通知：今晚全员升级（这条不点名任何人）】");
    svc.listenSeen.set(room.roomId, unaddressed - 1);
    await svc.sweepListening();
    await settle();
    // (b) a machine self-test stamp (the storm guard).
    svc.listenPending.delete(room.roomId);
    const stamp = await send("A升 0.1.45 自证");
    svc.listenSeen.set(room.roomId, stamp - 1);
    await svc.sweepListening();
    await settle();
    // (c) a control frame.
    svc.listenPending.delete(room.roomId);
    const control = await send("[org:exec:result] exit=0 派活回显");
    svc.listenSeen.set(room.roomId, control - 1);
    await svc.sweepListening();
    await settle();
    // (d) self-authored: this node's own message (card ④).
    svc.listenPending.delete(room.roomId);
    const own = await send("【自查】本机自己的话");
    svc.listenSeen.set(room.roomId, own - 1);
    await svc.sweepListening();
    await settle();

    const stats = svc.ackLedger.stats();
    console.log(`  [deny] seqs=${unaddressed},${stamp},${control},${own} receipts=${JSON.stringify(await ackLines(svc, room.roomId))} stats=${JSON.stringify(stats)}`);
    assert.strictEqual(dispatches.length, 0, "none of these four may wake the resident agent");
    assert.deepStrictEqual(await ackLines(svc, room.roomId), [], "and NONE of them may produce a receipt");
    assert.strictEqual(stats.receiptsPosted, 0, "the receipt counter must stay 0");
    const denied = svc.wakeWatermark.stats();
    assert.ok(denied.deniedNotAddressed >= 1 && denied.deniedMachineFrame >= 1 && denied.deniedControlFrame >= 1);
    assert.strictEqual(denied.deniedSelfAuthored, denied.selfAuthored, "the 0.1.45 aliases must not drift");

    // (e) a wake that is SKIPPED by the watermark (a second sighting of a woken seq) is
    // not a wake: no receipt, and nothing is counted as ackable.
    svc.roomService.joinOwnedRoom(room.roomId, { agentId: SELF_XM, nickname: "B", capabilities: [], createdAt: new Date().toISOString() }, {});
    svc.listenPending.delete(room.roomId);
    const mention = await svc.roomService.addChatMessage(room.roomId, author, {
      text: "@" + svc.roomService.getIdentity().nickname + " 请跑回归",
      human: false,
      mentions: [svc.roomService.getIdentity().agentId],
    });
    svc.listenSeen.set(room.roomId, mention.seq - 1);
    await svc.sweepListening();
    await settle();
    assert.strictEqual((await ackLines(svc, room.roomId)).length, 1, "the mention itself must be receipted once");
    const skipBefore = svc.wakeWatermark.stats().skipped;
    svc.listenPending.delete(room.roomId);
    svc.wakeWatermark.mark(room.roomId, mention.seq + 100); // an even NEWER seq was woken later
    svc.listenSeen.set(room.roomId, mention.seq - 1);
    await svc.sweepListening();
    await settle();
    const skipped = svc.wakeWatermark.stats();
    assert.ok(skipped.skipped > skipBefore, "the revival attempt must be refused by the watermark, not by luck");
    assert.strictEqual((await ackLines(svc, room.roomId)).length, 1, "a skipped wake must produce NO receipt");
    assert.strictEqual(svc.ackLedger.stats().receiptsPosted, 1, "and the receipt counter must not move");
  } finally {
    console.error = realError;
    console.warn = realWarn;
    await teardownAckProbe(probe);
  }
});

guarded("0.1.46 runtime: the sender's side — receipts observed, absence named in the room, /state.ack exposed", async () => {
  needAck("requirement 3+4: visible as data, and the absence made observable");
  const probe = await bootAckProbe(19563, "ar-ack-sender-");
  const { svc } = probe;
  const lines = [];
  const realError = console.error;
  const realWarn = console.warn;
  // Both channels are captured: `diag` writes to console.error, `warnRateLimited` to
  // console.warn, and an operator sees them in the same log file.
  const capture = (...args) => { lines.push(args.map((a) => String(a)).join(" ")); };
  console.error = capture;
  console.warn = capture;
  try {
    const room = await svc.gateway.createRoom({ title: "Ack sender", type: "persistent" });
    const me = svc.roomService.getIdentity();
    const jie = { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() };
    const xm = { agentId: SELF_XM, nickname: "B", capabilities: [], createdAt: new Date().toISOString() };
    svc.roomService.joinOwnedRoom(room.roomId, jie, {});
    svc.roomService.joinOwnedRoom(room.roomId, xm, {});

    // (1) The dispatch: this node posts a human=false mention of BOTH machines, through the
    // ONE send path every caller uses (gateway.sendChat ⇒ POST /chat and room_send).
    const dispatch = await svc.gateway.sendChat(room.roomId, {
      text: "【总控 · 会议召集】@" + jie.nickname + " @" + xm.nickname + " 请各自回一条",
      human: false,
      mentions: [jie.agentId, xm.agentId],
    });
    const seq = dispatch.seq;
    let stats = svc.ackLedger.stats();
    console.log(`  [sender] dispatch seq=${seq} stats=${JSON.stringify(stats)}`);
    assert.ok(seq > 0, "the owner must assign a real seq (an expectation on a guess would be a phantom)");
    assert.strictEqual(stats.dispatches, 1, "the dispatch must be tracked — without this nothing can be compared");
    assert.strictEqual(stats.expectedTargets, 2, "both addressed machines are expected to receipt it");

    // (2) A answers with a receipt; B does not (this is TODAY: one of four replied).
    await svc.roomService.addChatMessage(room.roomId, jie, {
      text: formatAckReceipt({ nickname: "A", agentId: jie.agentId, seq }),
      human: false,
    });
    await svc.sweepAckPlane();
    stats = svc.ackLedger.stats();
    console.log(`  [sender] after A's receipt: ackedTargets=${stats.ackedTargets} pending=${stats.pendingTargets} maxAckedObservedSeq=${stats.maxAckedObservedSeq}`);
    assert.strictEqual(stats.ackedTargets, 1, "the machine that receipted must be counted from the ROOM, not from a log");
    assert.strictEqual(stats.maxAckedObservedSeq, seq, "and the acked seq must be readable");
    assert.ok(lines.some((l) => l.includes("ack: receipt OBSERVED")), "the observation must leave a line");

    // (3) The window closes with B still silent → the absence becomes a fact.
    await svc.sweepAckPlane(Date.now() + ACK_WINDOW_MS + 1_000);
    stats = svc.ackLedger.stats();
    const miss = await missLines(svc, room.roomId);
    console.log(`  [sender] after the window: unackedTargets=${stats.unackedTargets} missNotices=${stats.missNotices} room=${JSON.stringify(miss)}`);
    assert.strictEqual(stats.unackedTargets, 1, "the silent machine must become an unacked target — THE signal 0.1.45 lacked");
    assert.strictEqual(stats.ackedTargets, 1, "without changing the machine that answered");
    assert.strictEqual(miss.length, 1, "and ONE rate-limited line must say so in the room");
    assert.ok(miss[0].includes("seq=" + seq), `the absence line must name the seq: ${miss[0]}`);
    assert.ok(miss[0].includes("B"), "and the machine that did not answer");
    assert.ok(!miss[0].includes("@"), "without waking anyone");
    assert.strictEqual(stats.missNotices, 1, "the notice is counted");
    // A second sweep must not repeat the notice (that is the noise half of the design).
    await svc.sweepAckPlane(Date.now() + 2 * ACK_WINDOW_MS);
    assert.strictEqual((await missLines(svc, room.roomId)).length, 1, "the absence notice must be posted ONCE per dispatch");
    assert.strictEqual(svc.ackLedger.stats().unackedTargets, 1, "and the counter must not drift");

    // (4) /state: the ack block, flat and numeric, next to 0.1.45's untouched wake block.
    const state = await svc.browserState();
    assert.ok(state.ack, "GET /agent-room-api/state must expose the ack counters (web.ts wires /state)");
    assert.deepStrictEqual(
      Object.keys(state.ack).sort(),
      Object.keys(new AckLedger().stats()).sort(),
      "the /state block must have the same shape as its own stats()",
    );
    for (const [key, value] of Object.entries(state.ack)) {
      assert.strictEqual(typeof value, "number", `ack.${key} must be a number, got ${typeof value}`);
    }
    assert.strictEqual(state.ack.unackedTargets, 1);
    assert.ok(JSON.parse(JSON.stringify(state)).ack.maxAckedObservedSeq === seq, "the block must survive a JSON round trip");
    // 0.1.45's block must be untouched and still present.
    assert.ok(state.wake && typeof state.wake.wokenByMention === "number", "the 0.1.45 wake block must not be disturbed");
    assert.strictEqual(state.wake.windowRows, WAKE_WINDOW_ROWS, "and its read window is unchanged");

    // (5) Requirement 6: a receipt whose room write FAILS is counted, and the handling is
    // unaffected (the wake already happened before the receipt is attempted).
    const broken = await bootAckProbe(19564, "ar-ack-fail-");
    try {
      const brokenSvc = broken.svc;
      const room2 = await brokenSvc.gateway.createRoom({ title: "Ack fail", type: "persistent" });
      brokenSvc.gateway.sendChat = async () => { throw new Error("room write refused (probe)"); };
      await brokenSvc.postAckReceipt(room2.roomId, brokenSvc.roomService.getIdentity(), 4242, "mention");
      const brokenStats = brokenSvc.ackLedger.stats();
      console.log(`  [failure] receiptsFailed=${brokenStats.receiptsFailed} receiptsPosted=${brokenStats.receiptsPosted}`);
      assert.strictEqual(brokenStats.receiptsFailed, 1, "a failed receipt must be COUNTED, never swallowed");
      assert.strictEqual(brokenStats.receiptsPosted, 0, "and must not be credited as delivered");
      assert.ok(
        lines.some((l) => l.includes("ack receipt for seq=4242") && l.includes("could NOT be posted")),
        `and must be visible to an operator: ${JSON.stringify(lines.filter((l) => l.includes("4242")))}`,
      );
      assert.strictEqual(brokenSvc.ackLedger.stats().unackedTargets, 0, "and it must not corrupt the sender-side counters");
    } finally {
      await teardownAckProbe(broken);
    }
  } finally {
    console.error = realError;
    console.warn = realWarn;
    await teardownAckProbe(probe);
  }
});

/* ==================== 5. static guards + 0.1.45 non-regression ==================== */

guarded("0.1.46 static guard: the receipt sits AFTER the dispatch, is never awaited, and cannot wedge the sweep", () => {
  needAck("the placement is the design");
  const raw = readFileSync(join(ROOT, "src", "host", "service.ts"), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const wakePath = src.slice(src.indexOf("private async runListenWake("), src.indexOf("private async postAckReceipt("));
  assert.ok(wakePath.length > 0, "the wake path must be locatable");
  const atFollow = wakePath.indexOf("agent.followup(");
  const atMark = wakePath.indexOf("this.wakeWatermark.mark(roomId, message.seq)");
  const atReceipt = wakePath.indexOf("void this.postAckReceipt(");
  assert.ok(atFollow >= 0 && atMark >= 0 && atReceipt >= 0, "the receipt must be wired into the wake path at all");
  assert.ok(
    atFollow < atMark && atMark < atReceipt,
    "the receipt must come AFTER the dispatch was marked — it describes something that already happened",
  );
  assert.ok(
    !/await this\.postAckReceipt\(/.test(wakePath),
    "the receipt must NEVER be awaited by the wake path (requirement 6: it cannot block or wedge anything)",
  );
  assert.match(
    wakePath,
    /void this\.postAckReceipt\(roomId, identity, message\.seq, pick\.decision\.reason\)/,
    "the receipt must be posted for the seq and rule that were actually dispatched",
  );
  // Its own error boundary: a failing room write is counted, never thrown into the wake path.
  const receiptFn = src.slice(src.indexOf("private async postAckReceipt("), src.indexOf("private async sweepAckPlane("));
  assert.match(receiptFn, /this\.ackLedger\.noteReceiptFailed\(\);/, "a failed receipt must be counted");
  assert.match(receiptFn, /if \(verdict !== "ok"\)/, "the dedupe/rate-limit verdict must be honoured before posting");
  // The expectation is opened in the ONE shared send path, for both room kinds.
  assert.match(src, /this\.registerAckExpectation\(roomId, input, message\?\.seq\);/, "owned-room sends must open an expectation");
  assert.match(src, /this\.registerAckExpectation\(roomId, input, status\.confirmedSeq\);/, "joined-room sends must too (on the OWNER-confirmed seq)");
  // Absence notices only via the authoritative write, and only for owned rooms.
  const sweepFn = src.slice(src.indexOf("private async sweepAckPlane("), src.indexOf("private async boot("));
  assert.match(sweepFn, /if \(!this\.roomService\.getOwnedRoom\(miss\.roomId\)\) continue;/, "absence notices require the authoritative write");
  assert.match(sweepFn, /this\.ackLedger\.expire\(now\);/, "the expiry must be clock-injectable (or the window is untestable)");
  // /state carries the block next to the wake block.
  assert.match(src, /ack: this\.ackLedger\.stats\(\),/);
  assert.match(src, /wake: this\.wakeWatermark\.stats\(\),/);
  // The rule layer knows the ack plane's frames (one answer for "what is a machine frame").
  const wakeSrc = readFileSync(join(ROOT, "src", "host", "wake.ts"), "utf8");
  assert.match(wakeSrc, /if \(isAckPlaneFrame\(message\.text\)\) return \{ wake: false, reason: "machine-frame", detail: "ack-frame" \};/);
  const ruleFn = wakeSrc.slice(wakeSrc.indexOf("export function decideListenWake("));
  assert.ok(
    ruleFn.indexOf("isAckPlaneFrame") < ruleFn.indexOf("mentionsThisNode(message, self)"),
    "the ack-frame refusal must run BEFORE the mention clause (a receipt must never wake anyone)",
  );
  // The receipt's own shape: no `@`, so it can never be read as an address. Comments are
  // stripped first — the module's own doc comment quotes `@nickname` while explaining why
  // the receipt must never contain one.
  const ackRaw = readFileSync(join(ROOT, "src", "host", "ack.ts"), "utf8");
  const ackSrc = ackRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(ackSrc, /return `\$\{ACK_TAG\} \$\{who\} 已接手 seq=\$\{input\.seq\}`;/, "the receipt line is one line, no prose");
  const template = ackSrc.split("export function formatAckReceipt")[1].split("export function formatAckMiss")[0];
  assert.ok(!template.includes("@"), "the receipt template must not contain `@` (it must wake nobody)");
});

guarded("0.1.46: 0.1.45's wake behaviour is UNCHANGED (mention wakes, human fallback wakes, denials still denied)", () => {
  // This is a regression lock, not a new feature: the whole 0.1.45 contract must survive
  // the ack plane being bolted next to it. Every case below is a 0.1.45 acceptance case.
  const self = { agentId: SELF_JIE, nickname: "A" };
  const cases = [
    ["mention by nickname", { from: SELF_XM, human: false, text: "@A 请跑回归" }, true, "mention"],
    ["mention by agentId", { from: SELF_XM, human: false, text: "收件人 " + SELF_JIE + " 请回复" }, true, "mention"],
    ["mentions[] array", { from: SELF_XM, human: false, mentions: [SELF_JIE], text: "请跑回归" }, true, "mention"],
    ["full-width ＠ (Chinese IME)", { from: SELF_XM, human: false, text: "＠A 请跑回归" }, true, "mention"],
    ["human:true fallback (no address)", { from: "01a09483-3668-7bdf-9cc2-0180f314c8cf", human: true, text: "无点名的人类指令" }, true, "human-fallback"],
    ["unaddressed human:false", { from: SELF_XM, human: false, text: "【通知】今晚全员升级" }, false, "not-addressed"],
    ["nickname in prose is not an address", { from: SELF_XM, human: false, text: "分工：A、B各一条" }, false, "not-addressed"],
    ["machine self-test stamp", { from: SELF_XM, human: true, mentions: [SELF_JIE], text: "B 0.1.45 自证 @A" }, false, "machine-frame"],
    ["control frame", { from: SELF_XM, human: true, mentions: [SELF_JIE], text: "[org:exec:result] exit=0 @A" }, false, "control-frame"],
    ["self-authored", { from: SELF_JIE, human: true, mentions: [SELF_JIE], text: "@A 我自己的话" }, false, "self-authored"],
  ];
  for (const [label, message, wakeExpected, reasonExpected] of cases) {
    const decision = decideListenWake({ message, self });
    assert.strictEqual(decision.wake, wakeExpected, `${label}: 0.1.45's admission must not have changed`);
    assert.strictEqual(decision.reason, reasonExpected, `${label}: the reason vocabulary must not have changed`);
  }
  // The watermark contract is untouched by the ack plane.
  const wm = new WakeWatermark();
  wm.mark(ROOM, SEQ_4405);
  assert.strictEqual(wm.seen(ROOM, SEQ_4405), true, "a woken seq is still blocked");
  assert.strictEqual(wm.seen(ROOM, SEQ_4405 + 1), false, "a newer seq still wakes");
  assert.strictEqual(wm.mark(ROOM, SEQ_4405 - 1), false, "the watermark is still monotonic");
  assert.strictEqual(wm.stats().regressed, 1, "and the tripwire still counts a refused backwards mark");
});

const watchdog = setTimeout(() => process.exit(failures > 0 ? 1 : 0), 60_000);
watchdog.unref();
