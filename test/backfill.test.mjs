/**
 * dsh-agent-room 0.1.35 — room convergence: lag/gap planning and merge semantics.
 *
 * Regression target (measured 2026-09-13 on live machines): a member's mirror of
 * a room it only JOINED was built from one handshake snapshot plus whatever live
 * frames arrived, and nothing ever pulled a missed message back. The owner held
 * total=200 (144 of them `[org:` control frames, maxSeq 270) while the member
 * machine's read view held 11 messages with holes (265, 266, [267 missing], 268,
 * …, 274) — and the member's own `latestSeq`, derived from that very mirror, could
 * not reveal the lag. A human on that machine could not see messages that
 * demonstrably existed on the owner.
 *
 * These tests pin the two decisions that make the fix real: WHICH ranges are
 * requested (never a whole history, never the same hole twice), and what happens
 * when the owner's answer is merged into the read view (dedupe by seq, pending
 * rows untouched, control frames never resurfacing).
 */

import assert from "node:assert";
import { test } from "node:test";
import {
  BACKFILL_BATCH_SEQS,
  BACKFILL_LAG_THRESHOLD,
  BACKFILL_MAX_SETTLED,
  BackfillState,
  mergeBackfill,
  planBackfill,
} from "../lib/host/backfill.js";
import { takeWithinBytes } from "../lib/host/peer-server.js";

/* ------------------------------ lag / gaps ------------------------------- */

test("a hole in the held range and a higher owner seq request exactly those ranges", () => {
  // The live shape: the member holds a subset with a hole and lags the owner.
  const plan = planBackfill({
    localSeqs: [265, 266, 268, 269, 270],
    ownerLatestChatSeq: 274,
  });

  assert.deepStrictEqual(plan.requests, [
    { from: 267, to: 267 }, // the interior hole: a definitive loss
    { from: 271, to: 274 }, // the tail: 4 seqs behind, above the threshold
  ]);
  assert.strictEqual(plan.reason, "gap");
  assert.strictEqual(plan.gaps, 1);
  assert.strictEqual(plan.lag, 4);
});

test("a small tail lag is tolerated while frames are still flowing, then requested once quiet", () => {
  const localSeqs = [265, 266, 267, 268];
  // Two seqs behind (< threshold) with live frames arriving: leave it to the stream.
  const busy = planBackfill({ localSeqs, ownerLatestChatSeq: 266 + 2, quietMs: 100 });
  assert.deepStrictEqual(busy.requests, []);
  assert.strictEqual(busy.reason, "converged");

  // Same lag, but the stream has gone quiet (> BACKFILL_QUIET_MS): ask for it,
  // or a room that goes silent would stay permanently short of its tail.
  const quiet = planBackfill({ localSeqs, ownerLatestChatSeq: 270, quietMs: 30_000 });
  assert.deepStrictEqual(quiet.requests, [{ from: 269, to: 270 }]);
  assert.strictEqual(quiet.reason, "lag");
  assert.ok(BACKFILL_LAG_THRESHOLD > 0);
});

test("requests are bounded to small batches and never replay a whole history", () => {
  // The member's read view was wiped (or a room was re-joined into an empty
  // projection) while the owner sits at seq 4000. A full-history pull is exactly
  // the storm this release must not create (the 2026-09-12 incident replayed
  // 25,346 frames), so only the tail batch may be requested.
  const plan = planBackfill({ localSeqs: [], ownerLatestChatSeq: 4_000 });
  assert.strictEqual(plan.requests.length, 1);
  assert.deepStrictEqual(plan.requests[0], { from: 4_000 - BACKFILL_BATCH_SEQS + 1, to: 4_000 });

  // A huge interior hole is split into at most a few batches per plan, never
  // requested in one go — and each batch is small.
  const big = planBackfill({ localSeqs: [1, 500], ownerLatestChatSeq: 500 });
  assert.ok(big.requests.length > 0 && big.requests.length <= 3, `batches=${big.requests.length}`);
  for (const range of big.requests) {
    assert.ok(range.to - range.from + 1 <= BACKFILL_BATCH_SEQS, `batch ${range.from}-${range.to} is bounded`);
  }
  assert.deepStrictEqual(big.requests[0], { from: 2, to: 1 + BACKFILL_BATCH_SEQS });
  assert.ok(big.gaps > 400, "the rest of the hole is reported, not requested at once");
});

test("a settled range is never requested again (the loop terminates on control-frame holes)", () => {
  // Control frames own seq numbers but never enter the read view, so a member's
  // seq list always has holes that the owner cannot fill. Without settling, every
  // round would ask for the same seqs forever.
  const settled = new Set([267]);
  const first = planBackfill({ localSeqs: [265, 266, 268], ownerLatestChatSeq: 268, settled });
  assert.deepStrictEqual(first.requests, []);
  assert.strictEqual(first.reason, "converged");

  const state = new BackfillState();
  state.noteOwnerSeqs(270, 274);
  state.noteRequest({ from: 271, to: 274 });
  assert.strictEqual(state.inflight, 1);
  state.noteAnswered(271, 274); // the owner examined it: nothing visible in there
  state.noteSettledInFlight();
  assert.strictEqual(state.inFlightRange, null);
  // The interior hole is asked for once...
  const hole = state.plan([265, 266, 268, 269, 270]);
  assert.deepStrictEqual(hole.requests, [{ from: 267, to: 267 }]);
  // ...and once the owner has answered it (a control frame lives at seq 267), it
  // is settled for good: the next round has nothing to ask for.
  state.noteRequest({ from: 267, to: 267 });
  state.noteAnswered(267, 267);
  state.noteSettledInFlight();
  const second = state.plan([265, 266, 268, 269, 270]);
  assert.deepStrictEqual(second.requests, [], "an answered range is settled for good");
  assert.ok(state.settledCount >= 5);
  assert.ok(second.lag === 0 && second.gaps === 0);
});

test("an owner that never reports seq numbers produces no requests at all", () => {
  // Pre-0.1.35 owners send no latestSeq/latestChatSeq: the member must not guess a
  // range from its own mirror (which is what made the defect invisible).
  const plan = planBackfill({ localSeqs: [1, 2, 3], ownerLatestChatSeq: 0 });
  assert.deepStrictEqual(plan.requests, []);
  assert.strictEqual(plan.reason, "no-owner-signal");
});

test("state holds back requests: one in flight, paced, with backoff on silence", () => {
  const state = new BackfillState();
  state.noteOwnerSeqs(40, 40);
  const now = 1_000_000;
  state.noteRequest({ from: 1, to: 10 }, now);
  assert.strictEqual(state.inflight, 1);
  assert.strictEqual(state.canRequest(now), false, "one request in flight at a time");

  // Backoff after an unanswered request: 2s, then 4s (exponential, capped).
  state.noteFailure(now);
  assert.strictEqual(state.failures, 1);
  assert.strictEqual(state.canRequest(now + 1_000), false);
  assert.strictEqual(state.canRequest(now + 2_500), true);

  state.noteRequest({ from: 1, to: 10 }, now + 2_500);
  state.noteFailure(now + 2_500);
  assert.strictEqual(state.failures, 2);
  assert.strictEqual(state.canRequest(now + 2_500 + 3_000), false, "second failure backs off for 4s");

  // An answered request resets pacing AND backoff (a healthy owner is not punished).
  state.noteRequest({ from: 11, to: 20 }, now + 10_000);
  state.noteSettledInFlight();
  assert.strictEqual(state.failures, 0);
  assert.strictEqual(state.canRequest(now + 10_000), false, "still paced by minInterval");
  assert.strictEqual(state.canRequest(now + 13_000), true);

  // The settled set stays bounded (oldest evicted, so memory cannot grow forever).
  state.noteAnswered(1, BACKFILL_MAX_SETTLED * 2);
  assert.ok(state.settledCount <= BACKFILL_MAX_SETTLED);
});

/* --------------------------------- merge --------------------------------- */

const msg = (seq, text = `m${seq}`) => ({ seq, from: "owner", fromNickname: "owner", ts: "t", text });

test("backfill merges by seq: dedupe, never clobber, pending rows preserved", () => {
  const pending = {
    seq: -1,
    from: "me",
    fromNickname: "me",
    ts: "t",
    text: "still unconfirmed",
    pending: true,
    localId: "local-1",
  };
  const existing = [msg(1), msg(2), msg(4), pending];

  const outcome = mergeBackfill(existing, [
    msg(3), // the hole the member was missing
    msg(4), // already held: must NOT be re-added (and must not overwrite)
    { ...msg(5), text: "[org:exec]{\"id\":\"x\"}" }, // control frame: never resurfaces
  ]);

  assert.deepStrictEqual(outcome.messages.filter((m) => !m.pending).map((m) => m.seq), [1, 2, 3, 4]);
  assert.deepStrictEqual(outcome.added.map((m) => m.seq), [3]);
  assert.strictEqual(outcome.duplicates, 1);
  assert.strictEqual(outcome.controlSkipped, 1);
  assert.strictEqual(outcome.pendingKept, 1);
  // The pending row survives untouched, and stays LAST (it is the newest thing the
  // sender did, not an old hole to be sorted into the middle).
  const tail = outcome.messages[outcome.messages.length - 1];
  assert.strictEqual(tail.localId, "local-1");
  assert.strictEqual(tail.pending, true);
  assert.strictEqual(tail.seq, -1);
  assert.strictEqual(outcome.messages.length, 5);
  // A copy is returned: the caller's array is never mutated in place.
  assert.strictEqual(existing.length, 4);
});

test("merge is idempotent, so a repeated or replayed batch cannot duplicate rows", () => {
  const existing = [msg(1), msg(2)];
  const first = mergeBackfill(existing, [msg(3), msg(4)]);
  assert.strictEqual(first.added.length, 2);

  const second = mergeBackfill(first.messages, [msg(3), msg(4)]);
  assert.strictEqual(second.added.length, 0);
  assert.strictEqual(second.duplicates, 2);
  assert.deepStrictEqual(second.messages.map((m) => m.seq), [1, 2, 3, 4]);
});

test("merge keeps the read view bounded by dropping the oldest confirmed rows", () => {
  const existing = [msg(1), msg(2)];
  const outcome = mergeBackfill(existing, [msg(3), msg(4), msg(5)], 3);
  assert.deepStrictEqual(outcome.messages.map((m) => m.seq), [3, 4, 5]);
  assert.strictEqual(outcome.pruned, 2);
});

/* --------------------------- owner-side bounds ---------------------------- */

test("the owner's answer is bounded by count and bytes, and never truncates the front", () => {
  const rows = [msg(1), msg(2), msg(3)];
  // Count ceiling.
  const byCount = takeWithinBytes(rows, 1024 * 1024, 2);
  assert.deepStrictEqual(byCount.items.map((m) => m.seq), [1, 2]);
  assert.strictEqual(byCount.truncated, true);

  // Byte ceiling: the OLDEST rows are kept (unlike the snapshot trim), because a
  // sync reply fills a range from its low end — dropping the front would make the
  // member re-ask for what it was just denied.
  const big = [{ seq: 1, text: "x".repeat(400) }, { seq: 2, text: "y".repeat(400) }];
  const byBytes = takeWithinBytes(big, 500);
  assert.deepStrictEqual(byBytes.items.map((m) => m.seq), [1]);
  assert.strictEqual(byBytes.truncated, true);

  // Nothing to truncate: the whole batch fits.
  const whole = takeWithinBytes(rows, 1024 * 1024, 50);
  assert.deepStrictEqual(whole.items.map((m) => m.seq), [1, 2, 3]);
  assert.strictEqual(whole.truncated, false);
});
