/**
 * dsh-agent-room 0.1.47 — the ACTIVATION chain: the wake arrives, and the TURN does not start.
 *
 * THE DEFECT (measured first-hand on the live fleet, 2026-09-15/16)
 *
 * 0.1.45 fixed the wake RULE and 0.1.46 added the ACK receipt, and BOTH WORK — the ack is
 * what exposed the real gap underneath them. A dispatch that names a machine produces
 * `listening: woken seq=… rule=mention` in that machine's own log and `woken=N` grows, and
 * then NOTHING is produced. `pendingSkips` grows alongside it (each sweep skipped because the
 * previous wake is "still in flight"), which is DESIGN, not the bug — a turn can take minutes
 * while the sweep runs every 30 s.
 *
 * Three machines, three different failures, all first-hand:
 *   D — manual `POST /activate-chat` → `active-session: session-b7496a19…` → `registry dump
 *          — detected=…` → `accepted … thinking=true` → `dispatching followup … to agent
 *          agent-room-duty-01a09483…` → `followup accepted` → D POSTED INTO THE ROOM. Works.
 *   B — `accepted … thinking=true` → `dispatching followup … agent-room-duty-01a09461…` →
 *          **the log just stops.** No `followup accepted`, no error, no counter. SILENT.
 *   C — `active-session: session-7f81275b… (global fallback, … dir=false)` → `registry dump
 *          … list=[] roots=[]` → no `accepted`, no `dispatching`. Its resident agent is not
 *          bound to a duty workspace: STRUCTURALLY unable to accept work, and nothing in
 *          `/state` said so.
 *
 * WHAT THIS FILE PROVES (all against the built artifact — `node build.mjs` first)
 *   1. the chain is COUNTED, step by step: rule → dispatch → residency → followup accepted or
 *      refused → demonstrably started (and by which evidence) → own output in the room;
 *   2. a wake that never starts is ESCALATED — the plugin does the equivalent of
 *      `activate-chat` itself — and the escalation is bounded to ONE per dispatch: repeating
 *      the sweep for ten minutes produces no second attempt (no storm), and a failing
 *      escalation is counted and named instead of retried;
 *   3. "no resident agent" is reportable AS SUCH (`noResidentAgent` + `resolvedViaNone` +
 *      `lastResidentOk:0`) — C's machine is readable from `/state` alone;
 *   4. the timeout path is named: accepted, then silence inside the window, is
 *      `acceptedNoOutput` (B), and a refused dispatch is `refusedNoOutput` — the two can
 *      never be confused;
 *   5. THE ACCEPTANCE: a machine whose wake produced nothing ANSWERS after the escalation —
 *      and the ACK receipt is NOT counted as that answer (it is written by this plugin
 *      before the model does anything, so counting it would make every silent machine look
 *      productive);
 *   6. `/state.activation` really carries the counters, flat and numeric, next to 0.1.45's
 *      `wake` and 0.1.46's `ack` (neither of which may change);
 *   7. 0.1.45's rule behaviour and 0.1.46's ack contract are unchanged — including one
 *      deliberate 0.1.47 tightening that is asserted here rather than smuggled: a receipt is
 *      posted only when the handoff really happened.
 *
 * `AR_LIB` points this suite at ANOTHER build's lib directory (house rule: a new assertion must
 * be able to fail on the old code). On a 0.1.46 lib `host/activation.js` does not exist, so
 * every activation assertion below fails there BY CONSTRUCTION — which is the point: there is
 * no escalation, no counter and no way to tell "started and died" from "never started".
 *
 * Pure in-process state plus local HTTP-free service probes: no live room, no other machine,
 * nothing written outside a temp dir. Run directly:
 *   node test/wake-activation.test.mjs
 * (never `node --test`).
 */

import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AR_LIB = process.env.AR_LIB;
const libBase = AR_LIB ? pathToFileURL(join(AR_LIB, "host") + "/").href : "../lib/host/";

/** The 0.1.45 surface (present on every build this suite is pointed at). */
const wakeMod = await import(libBase + "wake.js");
const { decideListenWake, isMachineSelfTestFrame, WakeWatermark } = wakeMod;

/** The 0.1.46 surface (absent on a pre-0.1.46 build; guarded for the same reason). */
let ackMod = null;
try {
  ackMod = await import(libBase + "ack.js");
} catch {
  ackMod = null;
}
const { AckLedger = undefined, ACK_RATE_LIMIT_MS = undefined, formatAckReceipt = undefined, isAckPlaneFrame = undefined } = ackMod ?? {};

/**
 * The 0.1.47 surface. `host/activation.js` is ABSENT on the 0.1.46 build this suite is pointed
 * at for the old-build gate; the import is guarded so every activation test fails by NAME
 * instead of erroring at link time.
 */
let actMod = null;
let actImportError = null;
try {
  actMod = await import(libBase + "activation.js");
} catch (error) {
  actImportError = error;
}
const {
  ACTIVATION_START_WINDOW_MS = undefined,
  ACTIVATION_OUTPUT_WINDOW_MS = undefined,
  ACTIVATION_TICK_MS = undefined,
  MAX_ACTIVATION_PENDING = undefined,
  WakeActivation = undefined,
} = actMod ?? {};

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOM = "01a098a2-2015-7a1d-b5f7-9eca45afa65d";
const SELF_JIE = "01a0281a-52de-7c4d-a1e9-7e6db367d3dd"; // A
const SELF_XM = "01a09461-351d-793d-bf49-b8e08641f082"; // B

/** Same node:test idiom as the other suites (see wake.test.mjs / ack.test.mjs). */
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

/** Every activation assertion calls this first: on a 0.1.46 lib it fails the test by name. */
function needActivation(what) {
  if (!actMod) {
    failures += 1;
    throw new Error(
      `the activation chain does not exist on this build (AR_LIB=${AR_LIB ?? "(local lib)"}): ` +
        `no escalation, no counter, and no way to tell "the wake arrived and nothing started" from ` +
        `"everything is fine" — ${what}. import error: ${String(actImportError)}`,
    );
  }
}

/* ========================= 1. the chain, as a pure structure ========================= */

guarded("0.1.47 activation: every STEP of the chain is counted, and every evidence is named", () => {
  needActivation("the chain being countable is the whole release");
  const act = new WakeActivation();
  const t0 = 1_000_000;
  // rule admitted → dispatch
  const entry = act.noteDispatch(ROOM, 4405, t0);
  assert.ok(entry, "a fresh dispatch must be tracked");
  // residency
  act.noteResident("duty");
  // followup accepted (inbox insertion — NOT a start)
  act.noteAccepted(ROOM, 4405, "agent-room-duty-x", undefined);
  let stats = act.stats();
  assert.strictEqual(stats.dispatches, 1);
  assert.strictEqual(stats.accepted, 1);
  assert.strictEqual(stats.started, 0, "an accepted followup is NOT a started turn (it returns undefined and cannot throw for a busy agent)");
  assert.strictEqual(stats.residentResolved, 1);
  assert.strictEqual(stats.resolvedViaDuty, 1, "the resolution path that won must be counted");
  assert.strictEqual(stats.lastResidentOk, 1);
  assert.strictEqual(stats.outputs, 0);
  // the turn demonstrably started
  assert.strictEqual(act.noteStart(ROOM, 4405, "status", t0 + 500), true);
  assert.strictEqual(act.noteStart(ROOM, 4405, "transcript", t0 + 900), false, "the FIRST evidence wins; started can never exceed dispatches");
  // and produced output
  const settled = act.noteOutput(ROOM, 4406, t0 + 5000);
  stats = act.stats();
  console.log(`  [chain] ${JSON.stringify(stats)}`);
  assert.strictEqual(settled.length, 1, "the output closes the entry");
  assert.strictEqual(stats.started, 1);
  assert.strictEqual(stats.startedByStatus, 1, "the evidence that fired is named (status)");
  assert.strictEqual(stats.outputs, 1);
  assert.strictEqual(stats.pending, 0, "a settled dispatch leaves nothing in flight");
  assert.strictEqual(stats.settled, 1);
  assert.strictEqual(stats.acceptedNoOutput, 0, "output arrived, so this is NOT a timeout");
  // Every counter is flat and numeric — the /state contract.
  for (const [key, value] of Object.entries(stats)) {
    assert.strictEqual(typeof value, "number", `activation.${key} must be a number, got ${typeof value}`);
  }
});

guarded("0.1.47 activation: the escalation is bounded to ONE per dispatch — it is not a retry loop", () => {
  needActivation("a wake storm made of escalations would be worse than the silence");
  const act = new WakeActivation(64, 20_000, 120_000, 10_000);
  const t0 = 2_000_000;
  act.noteDispatch(ROOM, 4405, t0);
  act.noteAccepted(ROOM, 4405, "session-a");
  // Inside the window: nothing may be escalated yet (the agent may simply be slow).
  assert.deepStrictEqual(act.dueEscalation(t0 + 19_000), [], "nothing is escalated before the window closes");
  assert.strictEqual(act.stats().escalationsAttempted, 0);
  const first = act.dueEscalation(t0 + 20_000);
  assert.strictEqual(first.length, 1, "past the window with no evidence, the dispatch must be escalated");
  assert.strictEqual(first[0].seq, 4405);
  act.noteEscalationResult(true);
  // One second later, one minute later, ten minutes later: NOT ONE MORE ATTEMPT.
  for (const later of [1_000, 60_000, 600_000, 3_600_000]) {
    assert.deepStrictEqual(act.dueEscalation(t0 + 20_000 + later), [], `no second escalation after +${later}ms`);
  }
  const stats = act.stats();
  console.log(`  [bound] escalationsAttempted=${stats.escalationsAttempted} succeeded=${stats.escalationsSucceeded}`);
  assert.strictEqual(stats.escalationsAttempted, 1, "exactly one escalation, ever, for one dispatch");
  assert.strictEqual(stats.escalationsSucceeded, 1);
  assert.strictEqual(stats.escalationsFailed, 0);
});

guarded("0.1.47 activation: a dispatch that demonstrably STARTED is never escalated (any of the three evidences)", () => {
  needActivation("escalating a machine that is already working would be a second turn, i.e. duplicate work");
  for (const evidence of ["status", "transcript", "output"]) {
    const act = new WakeActivation(64, 20_000, 120_000, 10_000);
    const t0 = 3_000_000;
    act.noteDispatch(ROOM, 900 + evidence.length, t0);
    act.noteAccepted(ROOM, 900 + evidence.length, "session-" + evidence);
    if (evidence === "output") act.noteOutput(ROOM, 901 + evidence.length, t0 + 1000);
    else act.noteStart(ROOM, 900 + evidence.length, evidence, t0 + 1000);
    assert.deepStrictEqual(
      act.dueEscalation(t0 + 10 * 60_000),
      [],
      `evidence=${evidence}: a started turn must never be escalated`,
    );
    assert.strictEqual(act.stats().escalationsAttempted, 0, `evidence=${evidence}`);
    const stats = act.stats();
    if (evidence === "status") assert.strictEqual(stats.startedByStatus, 1);
    if (evidence === "transcript") assert.strictEqual(stats.startedByTranscript, 1);
    if (evidence === "output") assert.strictEqual(stats.startedByOutput, 1);
  }
});

guarded("0.1.47 activation: the TIMEOUT path is named, and accepted-no-output can never be confused with refused", () => {
  needActivation("B's 'dispatching followup … and then nothing' must be a number, not a mystery");
  const t0 = 4_000_000;
  const act = new WakeActivation(64, 20_000, 120_000, 10_000);
  // (a) ACCEPTED, then silence → acceptedNoOutput.
  act.noteDispatch(ROOM, 4405, t0);
  act.noteAccepted(ROOM, 4405, "agent-room-duty-x");
  assert.deepStrictEqual(act.dueSettlement(t0 + 119_000), [], "inside the window nothing may be declared missing");
  const accepted = act.dueSettlement(t0 + 120_001);
  console.log(`  [timeout] ${JSON.stringify(accepted)}`);
  assert.strictEqual(accepted.length, 1);
  assert.strictEqual(accepted[0].reason, "accepted-no-output");
  assert.strictEqual(accepted[0].seq, 4405);
  assert.strictEqual(act.stats().acceptedNoOutput, 1, "the accepted-then-silent dispatch is counted as such");
  assert.strictEqual(act.stats().refusedNoOutput, 0);
  assert.deepStrictEqual(act.dueSettlement(t0 + 10 * 60_000), [], "an entry settles exactly once");
  assert.strictEqual(act.stats().acceptedNoOutput, 1, "and the counter cannot drift");
  // (b) REFUSED (followup threw), then silence → refusedNoOutput, a DIFFERENT bucket.
  const refused = new WakeActivation(64, 20_000, 120_000, 10_000);
  refused.noteDispatch(ROOM, 4406, t0);
  refused.noteFollowupRefused(ROOM, 4406);
  // A refusal still gets its escalation window — a refusal is NOT a start. Asserted BEFORE
  // the settlement below, because settling removes the entry from flight.
  assert.deepStrictEqual(refused.dueEscalation(t0 + 20_001).map((e) => e.seq), [4406], "a refused dispatch is still escalated");
  const outcome = refused.dueSettlement(t0 + 120_001);
  assert.strictEqual(outcome[0].reason, "refused-no-output");
  const stats = refused.stats();
  console.log(`  [timeout] refused stats=${JSON.stringify(stats)}`);
  assert.strictEqual(stats.refusedNoOutput, 1);
  assert.strictEqual(stats.acceptedNoOutput, 0, "a refusal is never reported as an accepted-but-silent dispatch");
  assert.strictEqual(stats.followupRefused, 1);
  assert.strictEqual(stats.accepted, 0, "and nothing was credited as accepted");
});

guarded("0.1.47 activation: memory stays bounded — the pending cap counts instead of growing, duplicates are refused", () => {
  needActivation("bounded memory is a house rule (the 411 MB audit file)");
  const act = new WakeActivation(4, 20_000, 120_000, 10_000);
  const t0 = 5_000_000;
  for (let i = 0; i < 10; i += 1) act.noteDispatch(ROOM, 1000 + i, t0);
  const stats = act.stats();
  console.log(`  [cap] pending=${stats.pending} overflow=${stats.pendingOverflow} dispatches=${stats.dispatches}`);
  assert.strictEqual(stats.pending, 4, "the structure must hold at most maxPending dispatches");
  assert.strictEqual(stats.pendingOverflow, 6, "and every refusal above the cap is COUNTED, never a silent drop");
  assert.strictEqual(act.stats().maxPending, 4, "the bound is exposed as data, not folklore");
  // The same (room, seq) can never be tracked twice.
  const dup = new WakeActivation();
  assert.ok(dup.noteDispatch(ROOM, 77, t0));
  assert.strictEqual(dup.noteDispatch(ROOM, 77, t0 + 1000), undefined, "a duplicate dispatch is refused");
  assert.strictEqual(dup.stats().duplicateDispatches, 1, "and counted");
  assert.strictEqual(dup.stats().dispatches, 1);
});

/* ======================= 2. runtime: the real sweep, the real fix ======================= */

async function bootActProbe(port, tag, options = {}) {
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
  const messages = [];
  // A resident agent that answers NOTHING until it is escalated — the measured shape of B.
  const silentThenAnswer = {
    id: "session-act-probe",
    sessionId: "session-act-probe",
    followup: (message) => {
      messages.push(message);
      if (options.answerOn === "never") return;
      const text = JSON.stringify(message ?? "");
      const isEscalation = text.includes("被手动激活聊天");
      if (options.answerOn === "escalation" && !isEscalation) return; // a wake prompt is ignored
      if (options.answerOn === "wake" && isEscalation) return;
      if (options.answerOn === "throw-always") throw new Error("followup refused (probe)");
      void options.reply?.(svc);
    },
  };
  if (options.throwOnFollowup) silentThenAnswer.followup = () => { throw new Error("followup refused (probe)"); };
  if (options.status) silentThenAnswer.status = options.status;
  if (options.agents === "empty") {
    svc.agentsRegistry = () => ({ list: () => [], roots: () => [], get: () => undefined, currentInitiator: () => undefined });
  } else {
    svc.agentsRegistry = () => ({
      list: () => [silentThenAnswer],
      roots: () => [silentThenAnswer],
      get: (id) => (id === silentThenAnswer.id ? silentThenAnswer : undefined),
      currentInitiator: () => silentThenAnswer,
    });
    svc.config.replyAgentId = options.replyAgentId === "missing" ? "session-not-here" : silentThenAnswer.id;
  }
  return { svc, dir, messages };
}

async function teardownActProbe(probe) {
  const { rm } = await import("node:fs/promises");
  for (const timer of [probe?.svc?.profileTimer, probe?.svc?.listenTimer, probe?.svc?.activationTimer]) {
    try { if (timer) clearInterval(timer); } catch { /* ignore */ }
  }
  try { await probe?.svc?.peerServer?.stop(); } catch { /* ignore */ }
  try { probe?.svc?.discovery?.stop?.(); } catch { /* ignore */ }
  for (const client of probe?.svc?.clients?.values?.() ?? []) { try { client.destroy(); } catch { /* ignore */ } }
  try { await rm(probe.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Capture both log channels (diag → stderr, warnRateLimited → stdout-side console.warn). */
function captureLogs() {
  const lines = [];
  const realError = console.error;
  const realWarn = console.warn;
  const push = (...args) => { lines.push(args.map((a) => String(a)).join(" ")); };
  console.error = push;
  console.warn = push;
  return { lines, restore() { console.error = realError; console.warn = realWarn; } };
}

/** Put one room in listening state, then post a mention of THIS node from a colleague. */
async function dispatchMentionTo(svc, room, author) {
  const me = svc.roomService.getIdentity();
  svc.setListening(room.roomId, true);
  await svc.sweepListening(); // first sweep seeds the cursor: history is not an instruction
  const message = await svc.roomService.addChatMessage(room.roomId, author, {
    text: "【派活】@" + (me.nickname ?? me.agentId) + " 请跑回归",
    human: false,
    mentions: [me.agentId],
  });
  svc.listenSeen.set(room.roomId, message.seq - 1);
  await svc.sweepListening();
  return message;
}

const roomTexts = async (svc, roomId) =>
  (await svc.roomService.recentMessages(roomId, 200)).map((m) => m.text ?? "");

guarded("0.1.47 runtime: NO RESIDENT AGENT is reported AS SUCH and moves a counter (C's machine)", async () => {
  needActivation("this is the failure that cost a whole day: a machine that cannot accept work");
  const probe = await bootActProbe(19611, "ar-act-noagent-", { agents: "empty" });
  const { svc } = probe;
  const logs = captureLogs();
  try {
    const room = await svc.gateway.createRoom({ title: "Act no agent", type: "persistent" });
    const author = { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() };
    svc.roomService.joinOwnedRoom(room.roomId, author, {});
    await dispatchMentionTo(svc, room, author);

    const stats = svc.activation.stats();
    console.log(`  [no-agent] stats=${JSON.stringify(stats)}`);
    assert.strictEqual(stats.dispatches, 0, "nothing was handed to anyone, so no dispatch may be counted");
    assert.strictEqual(stats.noResidentAgent, 1, "the wake was ADMITTED and no resident agent existed — counted");
    assert.strictEqual(stats.resolvedViaNone, 1, "and the resolution path that failed is named");
    assert.strictEqual(stats.lastResidentOk, 0, "so /state alone says this machine cannot accept work");
    assert.strictEqual(stats.residentResolved, 0);
    assert.ok(
      stats.resolvedViaConfig + stats.resolvedViaActiveSession + stats.resolvedViaDuty + stats.resolvedViaPersisted +
        stats.resolvedViaIdentity + stats.resolvedViaHeuristic === 0,
      "every other resolution path must be zero — that combination IS the readable verdict",
    );
    const line = logs.lines.find((l) => l.includes("NO RESIDENT AGENT"));
    assert.ok(
      line,
      `a machine that cannot accept work must say so in its log: ${JSON.stringify(logs.lines.filter((l) => l.includes("listening:")))}`,
    );
    console.log(`  [no-agent] log: ${line}`);
    assert.match(line, /activation\.noResidentAgent/, "and the line must name the counter that moved");
  } finally {
    logs.restore();
    await teardownActProbe(probe);
  }
});

guarded("0.1.47 runtime: a wake that starts NOTHING is escalated ONCE — and the machine then ANSWERS (B)", async () => {
  needActivation("this is the acceptance: a machine that previously produced nothing now produces output");
  const probe = await bootActProbe(19612, "ar-act-fix-", {
    answerOn: "escalation",
    reply: async (svc) => {
      const me = svc.roomService.getIdentity();
      await svc.gateway.sendChat(svc.__probeRoom, { text: "【B 自检】收到，已开工", human: false });
    },
  });
  const { svc, messages } = probe;
  const logs = captureLogs();
  try {
    const room = await svc.gateway.createRoom({ title: "Act escalation", type: "persistent" });
    svc.__probeRoom = room.roomId;
    const author = { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() };
    svc.roomService.joinOwnedRoom(room.roomId, author, {});
    const me = svc.roomService.getIdentity();
    const woken = await dispatchMentionTo(svc, room, author);
    await new Promise((r) => setTimeout(r, 250));

    // (1) The wake happened, the receipt went out — and NOTHING was produced. The receipt is
    //     written by the plugin, so it must NOT be counted as the agent's output.
    let stats = svc.activation.stats();
    console.log(`  [before] dispatches=${stats.dispatches} accepted=${stats.accepted} started=${stats.started} outputs=${stats.outputs} escalations=${stats.escalationsAttempted}`);
    assert.strictEqual(stats.dispatches, 1, "the wake was dispatched to the resident agent (0.1.45 behaviour, unchanged)");
    assert.strictEqual(stats.accepted, 1, "followup returned, so it was accepted");
    assert.strictEqual(stats.started, 0, "and NOTHING demonstrates that a turn started — exactly B's shape");
    assert.strictEqual(stats.outputs, 0, "the [ack] receipt is OURS: it must never be read as the model producing output");
    assert.strictEqual(stats.escalationsAttempted, 0, "the window has not closed yet");
    const before = await roomTexts(svc, room.roomId);
    assert.ok(before.some((t) => t.startsWith("[ack]")), "the 0.1.46 receipt must still be posted (no regression)");
    assert.ok(!before.some((t) => t.includes("已开工")), "the machine has produced nothing yet");

    // (2) The window closes: the plugin does the equivalent of activate-chat by itself.
    await svc.sweepActivation(Date.now() + ACTIVATION_START_WINDOW_MS + 1_000);
    await new Promise((r) => setTimeout(r, 300));
    stats = svc.activation.stats();
    console.log(`  [after] escalations=${stats.escalationsAttempted}/${stats.escalationsSucceeded} messages=${messages.length} started=${stats.started} outputs=${stats.outputs}`);
    console.log(`  [after] room=${JSON.stringify(await roomTexts(svc, room.roomId))}`);
    assert.strictEqual(stats.escalationsAttempted, 1, "the escalation must fire");
    assert.strictEqual(stats.escalationsSucceeded, 1, "and be accepted by a resolved resident agent");
    assert.strictEqual(stats.escalationsFailed, 0);
    assert.strictEqual(messages.length, 2, "the agent received the wake AND the activate-chat prompt — nothing else");
    assert.strictEqual(stats.started, 1, "the turn is now demonstrably started");
    assert.strictEqual(stats.outputs, 1, "and this node's own message really landed in the room");
    assert.strictEqual(stats.startedByOutput, 1, "the evidence that fired is named");
    assert.strictEqual(stats.pending, 0, "the entry is settled — no leak");
    assert.strictEqual(stats.acceptedNoOutput, 0, "the escalation worked, so this is not a timeout");
    const after = await roomTexts(svc, room.roomId);
    assert.ok(after.some((t) => t.includes("已开工")), `THE ACCEPTANCE: the machine answered — ${JSON.stringify(after)}`);
    const escalateLine = logs.lines.find((l) => l.includes("wake-escalate: ") && l.includes("produced NO evidence"));
    assert.ok(escalateLine, `the escalation must say why it fired: ${JSON.stringify(logs.lines.filter((l) => l.includes("escalate")))}`);
    console.log(`  [escalate] log: ${escalateLine}`);
    assert.ok(
      logs.lines.some((l) => l.includes("OWN OUTPUT landed")),
      "and the last step of the chain must be logged too",
    );
    // A later sweep must not escalate again — the dispatch is settled.
    const settledSweeps = svc.activation.stats().escalationsAttempted;
    await svc.sweepActivation(Date.now() + 30 * 60_000);
    assert.strictEqual(svc.activation.stats().escalationsAttempted, settledSweeps, "a settled dispatch can never be escalated later");
    // 0.1.46's receipt contract survives all of this: ONE receipt for that seq.
    const receipts = after.filter((t) => t.startsWith("[ack]"));
    assert.strictEqual(receipts.length, 1, `exactly one receipt for the wake, got ${JSON.stringify(receipts)}`);
    assert.ok(Number.isSafeInteger(woken.seq) || woken.seq > 0, "the dispatch had a real owner seq");
  } finally {
    logs.restore();
    await teardownActProbe(probe);
  }
});

guarded("0.1.47 runtime: a FAILING escalation is counted, named, and never repeated (no storm)", async () => {
  needActivation("requirement 1: 'if it cannot escalate, that must be logged and counted, never silent'");
  const probe = await bootActProbe(19613, "ar-act-fail-", { throwOnFollowup: true });
  const { svc } = probe;
  const logs = captureLogs();
  try {
    const room = await svc.gateway.createRoom({ title: "Act fail", type: "persistent" });
    const author = { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() };
    svc.roomService.joinOwnedRoom(room.roomId, author, {});
    await dispatchMentionTo(svc, room, author);
    await new Promise((r) => setTimeout(r, 200));

    let stats = svc.activation.stats();
    console.log(`  [refused] ${JSON.stringify(stats)}`);
    assert.strictEqual(stats.followupRefused, 1, "a followup that THREW must move a counter (B's silent stop, named)");
    assert.strictEqual(stats.accepted, 0, "nothing was handed over, so nothing may be credited as accepted");
    assert.strictEqual(stats.dispatches, 1, "the dispatch was still attempted and tracked");
    assert.ok(
      logs.lines.some((l) => l.includes("followup REFUSED")),
      `a refusal must leave a line: ${JSON.stringify(logs.lines.filter((l) => l.includes("REFUSED")))}`,
    );

    // The escalation window closes: the plugin tries, and the try also fails — once.
    await svc.sweepActivation(Date.now() + ACTIVATION_START_WINDOW_MS + 1_000);
    stats = svc.activation.stats();
    console.log(`  [escalate-failed] ${JSON.stringify(stats)}`);
    assert.strictEqual(stats.escalationsAttempted, 1, "the escalation must still be attempted after a refusal");
    assert.strictEqual(stats.escalationsFailed, 1, "and its failure is COUNTED, never silent");
    assert.strictEqual(stats.escalationsFailedRefused, 1, "with the reason named");
    assert.strictEqual(stats.escalationsSucceeded, 0);
    assert.ok(
      logs.lines.some((l) => l.includes("escalate: REFUSED")),
      `a failed escalation must say so: ${JSON.stringify(logs.lines.filter((l) => l.includes("escalate")))}`,
    );
    // Ten minutes of sweeps: not one more attempt. A failing escalation is not a retry loop.
    for (const offset of [30_000, 60_000, 300_000, 600_000]) {
      await svc.sweepActivation(Date.now() + ACTIVATION_START_WINDOW_MS + offset);
    }
    stats = svc.activation.stats();
    assert.strictEqual(stats.escalationsAttempted, 1, "repeated sweeps must NOT produce repeated escalations");
    assert.strictEqual(stats.escalationsFailed, 1);
    const refusedLines = logs.lines.filter((l) => l.includes("escalate: REFUSED"));
    assert.strictEqual(refusedLines.length, 1, `one line per failed escalation, got ${refusedLines.length}`);
  } finally {
    logs.restore();
    await teardownActProbe(probe);
  }
});

guarded("0.1.47 runtime: accepted-then-silent is the TIMEOUT path, reported with its own counter", async () => {
  needActivation("requirement 2: 'accepted but never produced output within the window'");
  const probe = await bootActProbe(19614, "ar-act-timeout-", { answerOn: "never", status: undefined });
  const { svc } = probe;
  const logs = captureLogs();
  try {
    const room = await svc.gateway.createRoom({ title: "Act timeout", type: "persistent" });
    const author = { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() };
    svc.roomService.joinOwnedRoom(room.roomId, author, {});
    await dispatchMentionTo(svc, room, author);
    await new Promise((r) => setTimeout(r, 200));
    await svc.sweepActivation(Date.now() + ACTIVATION_OUTPUT_WINDOW_MS + 1_000);
    const stats = svc.activation.stats();
    console.log(`  [timeout] ${JSON.stringify(stats)}`);
    assert.strictEqual(stats.dispatches, 1, "one rule-admitted wake");
    assert.strictEqual(stats.accepted, 2, "TWO handoffs were accepted: the wake, and the escalation (accepted counts handoffs, dispatches counts wakes)");
    assert.strictEqual(stats.started, 0);
    assert.strictEqual(stats.acceptedNoOutput, 1, "the accepted dispatch that produced nothing is counted — THE number 0.1.46 lacked");
    assert.strictEqual(stats.refusedNoOutput, 0, "and it is not confused with a refusal");
    assert.strictEqual(stats.pending, 0, "the entry closes at the window (bounded memory)");
    assert.ok(
      logs.lines.some((l) => l.includes("ACCEPTED BUT NO OUTPUT")),
      `the timeout must be a line, not a silence: ${JSON.stringify(logs.lines.filter((l) => l.includes("activation:")))}`,
    );
  } finally {
    logs.restore();
    await teardownActProbe(probe);
  }
});

guarded("0.1.47 runtime: a running agent is detected as STARTED and NOT escalated (the status evidence)", async () => {
  needActivation("escalating a machine that is already working would be duplicate work");
  const probe = await bootActProbe(19615, "ar-act-status-", { answerOn: "never", status: "running" });
  const { svc, messages } = probe;
  const logs = captureLogs();
  try {
    const room = await svc.gateway.createRoom({ title: "Act status", type: "persistent" });
    const author = { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() };
    svc.roomService.joinOwnedRoom(room.roomId, author, {});
    await dispatchMentionTo(svc, room, author);
    await new Promise((r) => setTimeout(r, 200));
    await svc.sweepActivation(Date.now() + 1_000);
    const stats = svc.activation.stats();
    console.log(`  [status] ${JSON.stringify(stats)}`);
    assert.strictEqual(stats.started, 1, "agent.status=running is a first-hand proof that the turn started");
    assert.strictEqual(stats.startedByStatus, 1, "and the evidence used is named");
    await svc.sweepActivation(Date.now() + ACTIVATION_START_WINDOW_MS + 5_000);
    assert.strictEqual(svc.activation.stats().escalationsAttempted, 0, "a started turn must NOT be escalated");
    assert.strictEqual(messages.length, 1, "the agent received exactly the wake prompt");
    assert.ok(logs.lines.some((l) => l.includes("evidence=status")), "and the start is logged with its evidence");
  } finally {
    logs.restore();
    await teardownActProbe(probe);
  }
});

guarded("0.1.47: /state exposes the whole chain, flat and numeric, next to the untouched wake/ack blocks", async () => {
  needActivation("requirement 2: specific counters on GET /agent-room-api/state");
  const probe = await bootActProbe(19616, "ar-act-state-", { agents: "empty" });
  const { svc } = probe;
  try {
    const room = await svc.gateway.createRoom({ title: "Act state", type: "persistent" });
    const author = { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() };
    svc.roomService.joinOwnedRoom(room.roomId, author, {});
    await dispatchMentionTo(svc, room, author);
    const state = await svc.browserState();
    assert.ok(state.activation, "GET /agent-room-api/state must expose the activation counters");
    assert.deepStrictEqual(
      Object.keys(state.activation).sort(),
      Object.keys(new WakeActivation().stats()).sort(),
      "the /state block must have the same shape as its own stats()",
    );
    for (const [key, value] of Object.entries(state.activation)) {
      assert.strictEqual(typeof value, "number", `activation.${key} must be a number, got ${typeof value}`);
    }
    // The five counters the card names, spelled out one by one.
    for (const key of ["escalationsAttempted", "escalationsSucceeded", "escalationsFailed", "followupRefused", "noResidentAgent", "acceptedNoOutput"]) {
      assert.ok(key in state.activation, `activation.${key} must exist`);
    }
    assert.strictEqual(state.activation.noResidentAgent, 1, "the no-resident-agent machine is readable from /state alone");
    assert.strictEqual(state.activation.lastResidentOk, 0);
    assert.strictEqual(state.activation.tickMs, ACTIVATION_TICK_MS, "and the bounds are data, not folklore");
    assert.strictEqual(state.activation.startWindowMs, ACTIVATION_START_WINDOW_MS);
    assert.strictEqual(state.activation.outputWindowMs, ACTIVATION_OUTPUT_WINDOW_MS);
    assert.ok(JSON.parse(JSON.stringify(state)).activation.resolvedViaNone === 1, "the block must survive a JSON round trip");
    // 0.1.45's and 0.1.46's blocks must be untouched.
    assert.ok(state.wake && typeof state.wake.wokenByMention === "number", "the 0.1.45 wake block must not be disturbed");
    assert.strictEqual(state.wake.deniedSelfAuthored, state.wake.selfAuthored, "the 0.1.45 aliases must not drift");
    assert.ok(state.ack && typeof state.ack.receiptsPosted === "number", "the 0.1.46 ack block must not be disturbed");
    console.log(`  [state] activation keys=${Object.keys(state.activation).length} noResidentAgent=${state.activation.noResidentAgent}`);
  } finally {
    await teardownActProbe(probe);
  }
});

/* ==================== 3. static guards + the two regression locks ==================== */

guarded("0.1.47 static guard: the escalation hangs off the sweep, is bounded by the structure, and never touches the UI flag", () => {
  needActivation("the placement is the design");
  const raw = readFileSync(join(ROOT, "src", "host", "service.ts"), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // The wake path still dispatches INSIDE runListenWake (0.1.46's own static guard locates
  // `agent.followup(` there and asserts it precedes the watermark mark — a shipped regression
  // lock that must keep working).
  const wakePath = src.slice(src.indexOf("private async runListenWake("), src.indexOf("private async postAckReceipt("));
  const atFollow = wakePath.indexOf("agent.followup(");
  const atMark = wakePath.indexOf("this.wakeWatermark.mark(roomId, message.seq)");
  const atReceipt = wakePath.indexOf("void this.postAckReceipt(");
  assert.ok(atFollow >= 0 && atMark >= 0 && atReceipt >= 0, "0.1.46's ordering guard must still find all three tokens");
  assert.ok(atFollow < atMark && atMark < atReceipt, "dispatch → mark → receipt, unchanged from 0.1.46");
  assert.match(wakePath, /this\.activation\.noteDispatch\(roomId, message\.seq\)/, "the wake path must open an activation entry");
  assert.match(wakePath, /this\.activation\.noteAccepted\(/, "and record the acceptance with its transcript baseline");
  assert.match(wakePath, /this\.activation\.noteFollowupRefused\(/, "and record a refusal");
  assert.match(wakePath, /if \(accepted\) void this\.postAckReceipt\(/, "the receipt is posted only for a real handoff (0.1.47 tightening)");
  // The sweep drives the escalation, and short-circuits before ANY work when nothing is in flight.
  const sweepFn = src.slice(src.indexOf("private async sweepActivation("), src.indexOf("private async escalateWake("));
  assert.match(sweepFn, /if \(this\.activation\.pendingCount\(\) === 0\) return;/, "the tick must cost nothing when idle");
  assert.match(sweepFn, /for \(const due of this\.activation\.dueEscalation\(now\)\)/, "the escalation is driven by the tracker's own bound");
  assert.match(sweepFn, /await this\.escalateWake\(due, now\)/, "and by nothing else");
  assert.match(sweepFn, /await this\.escalateWake\(due, now\);/, "exactly one escalation call site");
  assert.strictEqual(
    (sweepFn.match(/dueEscalation\(/g) ?? []).length,
    1,
    "the sweep must consult the escalation list exactly once (a second call site is how storms start)",
  );
  // Escalation re-uses the activate-chat prompt and resolution, and does NOT claim the UI flag.
  const escalateFn = src.slice(src.indexOf("private async escalateWake("), src.indexOf("private reportSettlement("));
  assert.match(escalateFn, /await this\.buildActivatePromptFor\(due\.roomId, identity\)/, "the escalation uses the SAME prompt as the manual button");
  assert.match(escalateFn, /await this\.resolveResidentAgent\(identity, trace\)/, "and the same resolution");
  assert.ok(
    !/activateThinkingRooms/.test(escalateFn),
    "the escalation must NOT claim the browser's one-shot thinking state (it would 409 a human's click and disguise itself as a user action)",
  );
  assert.match(escalateFn, /this\.activation\.noteEscalationResult\(false, "no-resident-agent"\)/, "a machine that cannot escalate must be counted as such");
  assert.match(escalateFn, /this\.activation\.noteEscalationResult\(false, "room-gone"\)/, "and a failed escalation must be counted too (never silent)");
  // The output evidence filters the plugin's own frames out.
  const ownReplyFn = src.slice(src.indexOf("private noteOwnReply("), src.indexOf("/* --------------------------- listening"));
  assert.match(ownReplyFn, /!isAckPlaneFrame\(message\.text\)/, "the [ack] receipt is written by THIS plugin and must never count as model output");
  assert.match(ownReplyFn, /!isControlFrame\(message\.text\)/, "nor may [org:*] bus frames");
  // The timer is unref'd (it only observes) and cleared on disposal.
  assert.match(src, /this\.activationTimer\.unref\?\.\(\)/, "the activation tick must never be the reason a process stays alive");
  assert.match(src, /\[this\.profileTimer, this\.listenTimer, this\.activationTimer\]/, "and it must be cleared on disposal");
  assert.match(src, /activation: this\.activation\.stats\(\),/, "/state must carry the block");
});

guarded("0.1.45 + 0.1.46 regression lock: the rule, the watermark and the ack contract are unchanged", async () => {
  // 0.1.45's rule, case by case — every one of these is a 0.1.45 acceptance case.
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
  assert.strictEqual(isMachineSelfTestFrame("A升 0.1.45 自证"), true);
  // The monotonic, non-expiring watermark is untouched.
  const wm = new WakeWatermark();
  wm.mark(ROOM, 4405);
  assert.strictEqual(wm.seen(ROOM, 4405), true, "a woken seq is still blocked");
  assert.strictEqual(wm.seen(ROOM, 4406), false, "a newer seq still wakes");
  assert.strictEqual(wm.mark(ROOM, 4404), false, "the watermark is still monotonic");
  assert.strictEqual(wm.stats().regressed, 1, "and the tripwire still counts a refused backwards mark");
  // 0.1.46's ack contract: one receipt per (room, seq), rate-limited, and a machine frame.
  if (ackMod) {
    const ledger = new AckLedger();
    // t0 well above the rate limit, so the FIRST receipt is not itself rate-limited
    // (a fresh ledger's `lastPostAt` is 0 — exactly the trap ack.test.mjs avoids the same way).
    const t0 = 1_000_000;
    assert.strictEqual(ledger.allowReceipt(ROOM, 4405, t0), "ok");
    ledger.noteReceiptPosted(ROOM, 4405, t0);
    assert.strictEqual(ledger.allowReceipt(ROOM, 4405, t0 + 10 * ACK_RATE_LIMIT_MS), "duplicate", "0.1.46's dedupe is untouched");
    assert.strictEqual(ledger.allowReceipt(ROOM, 4406, t0), "rate-limited", "0.1.46's rate limit is untouched");
    assert.strictEqual(ledger.allowReceipt(ROOM, 4406, t0 + ACK_RATE_LIMIT_MS), "ok", "and it clears after the window");
    const receipt = formatAckReceipt({ nickname: "A", agentId: SELF_JIE, seq: 4405 });
    assert.strictEqual(isAckPlaneFrame(receipt), true);
    assert.strictEqual(
      decideListenWake({ message: { from: SELF_JIE, human: false, text: receipt }, self: { agentId: SELF_XM, nickname: "B" } }).reason,
      "machine-frame",
      "a receipt must still wake nobody",
    );
  } else {
    failures += 1;
    throw new Error("the ack plane does not exist on this build — 0.1.46's contract cannot be verified (this lock must pass on a 0.1.46 lib)");
  }
});

guarded("0.1.47: the receipt is NOT posted when nothing was handed over (the one tightening, asserted)", async () => {
  needActivation("a receipt that claims 已接手 for a refused followup would be a lie");
  const probe = await bootActProbe(19617, "ar-act-noreceipt-", { throwOnFollowup: true });
  const { svc } = probe;
  const logs = captureLogs();
  try {
    const room = await svc.gateway.createRoom({ title: "Act no receipt", type: "persistent" });
    const author = { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() };
    svc.roomService.joinOwnedRoom(room.roomId, author, {});
    await dispatchMentionTo(svc, room, author);
    await new Promise((r) => setTimeout(r, 250));
    const texts = await roomTexts(svc, room.roomId);
    console.log(`  [no-receipt] room=${JSON.stringify(texts)} receiptsPosted=${svc.ackLedger.stats().receiptsPosted}`);
    assert.strictEqual(texts.filter((t) => t.startsWith("[ack]")).length, 0, "a refused followup must produce NO receipt");
    assert.strictEqual(svc.ackLedger.stats().receiptsPosted, 0, "and the receipt counter must not move");
    assert.strictEqual(svc.activation.stats().followupRefused, 1, "while the refusal itself is counted");
    assert.ok(
      logs.lines.some((l) => l.includes("NO receipt for seq=") && l.includes("followup was refused")),
      "and the missing receipt must say why",
    );
  } finally {
    logs.restore();
    await teardownActProbe(probe);
  }
});

const watchdog = setTimeout(() => process.exit(failures > 0 ? 1 : 0), 90_000);
watchdog.unref();
