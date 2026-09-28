/**
 * dsh-agent-room — member-side room convergence ("backfill").
 *
 * WHY THIS EXISTS (measured 2026-09-13 on live machines)
 *
 * A member's local mirror of a room it only JOINED was built from one thing: the
 * owner's handshake snapshot (bounded: 50 messages / 12 KB / 400-message scan,
 * control frames filtered out), plus whatever live frames happened to arrive.
 * Nothing ever pulled a missed message back. On the live room
 * `01a098a2-2015-7a1d-b5f7-9eca45afa65d` the owner held total=200 messages
 * (144 of them `[org:` control frames, maxSeq 270) while the member machine's
 * read view held 11 messages with holes (…, 265, [267 missing], 268, …). The
 * member's own `latestSeq` was derived FROM ITS OWN VIEW, so it could not even
 * notice it was behind — and the human looking at the room panel could not see
 * messages that demonstrably existed on the owner. Believing a speaking agent was
 * silent is the worst possible chat-UI failure.
 *
 * This module is the missing half: a bounded, self-limiting convergence loop.
 *
 * THREE PROPERTIES, IN ORDER OF IMPORTANCE
 *
 * 1. BOUNDED. Every request covers at most `batchSeqs` seqs, at most one request
 *    is in flight, requests are paced (`minIntervalMs`) and back off
 *    exponentially when the owner does not answer. The team already paid for one
 *    flooding incident (25,346 replayed exec frames, a 411 MB audit log); a
 *    convergence loop that could re-create that would be worse than the bug.
 * 2. TERMINATING. Every answered range is recorded as SETTLED. A hole that the
 *    owner answers with nothing (a control frame, a deleted row, a seq that
 *    belongs to a filtered frame) is therefore asked for exactly once — the loop
 *    converges instead of polling the same gap forever.
 * 3. MERGE, NEVER REPLACE. Backfilled rows are merged by seq into the existing
 *    read view; duplicates are dropped, and locally appended pending rows
 *    (0.1.34's negative-seq optimistic rows) are never touched — a pending row is
 *    replaced only when the owner's confirmed echo arrives.
 *
 * WHAT IS NOT HERE: transport, timers, sockets. This file is pure logic plus one
 * small state holder, so the planner can be tested without a network (see
 * test/backfill.test.mjs).
 */

import type { ChatMessage } from "../types.js";
import { isControlFrame } from "./protocol.js";

/* ------------------------------- budgets -------------------------------- */

/**
 * How far behind the owner the tail may fall before a member asks for it.
 *
 * A lag of one or two seqs is normal churn: a live frame for seq N and N+2 can
 * arrive before N+1's frame is processed. Waiting for a few seqs of distance
 * keeps a healthy stream from generating requests at all.
 */
export const BACKFILL_LAG_THRESHOLD = 3;

/** Seq span of one request. Also the owner's per-request ceiling. */
export const BACKFILL_BATCH_SEQS = 50;

/** Requests issued per round (interior holes first, then the tail). */
export const BACKFILL_MAX_RANGES = 3;

/** Minimum gap between two requests to the same owner (politeness). */
export const BACKFILL_MIN_INTERVAL_MS = 2_000;

/** Backoff after an unanswered request: 2s, 4s, 8s, … capped. */
export const BACKFILL_BACKOFF_BASE_MS = 2_000;
export const BACKFILL_BACKOFF_MAX_MS = 60_000;

/** How long an unanswered request/fetch may stay in flight before it is a failure. */
export const BACKFILL_REQUEST_TIMEOUT_MS = 8_000;

/**
 * After this long with no live frame for the room, the tail lag threshold drops
 * to zero: a quiet stream cannot be expected to fill the last few seqs itself, so
 * the lag is asked for instead of being tolerated.
 */
export const BACKFILL_QUIET_MS = 5_000;

/** Poll period for the `chat.stat` probe (the only signal a quiet room gives). */
export const BACKFILL_POLL_MS = 15_000;

/** First request after a handshake is delayed so the join can settle. */
export const BACKFILL_FIRST_DELAY_MS = 1_000;

/** Settled-seq bookkeeping ceiling (oldest entries are dropped first). */
export const BACKFILL_MAX_SETTLED = 4_096;

/**
 * How many confirmed rows the member keeps in the read view.
 *
 * Backfill can pour history into the projection; without a floor the member's
 * memory grows with the owner's store. Dropping the OLDEST is safe for
 * convergence: the planner only scans from the smallest seq it still holds, so a
 * hole below the floor is not re-requested (and no longer visible either way).
 */
export const MAX_READ_VIEW_CONFIRMED = 2_000;

/* -------------------------------- planner -------------------------------- */

export interface SeqRange {
  from: number;
  to: number;
}

export type BackfillReason =
  /** Nothing to ask for: the view matches what the owner reported. */
  | "converged"
  /** Interior hole(s) in the seq range we hold. */
  | "gap"
  /** The tail lags behind the owner's latest visible seq. */
  | "lag"
  /** The owner never told us its seq numbers (old owner, or nothing received). */
  | "no-owner-signal";

export interface BackfillPlan {
  /** Ranges to request, in order. Empty when there is nothing to do. */
  requests: SeqRange[];
  /** Unsettled seqs between our visible max and the owner's latest visible seq. */
  lag: number;
  /** Unsettled seqs missing INSIDE the range we hold. */
  gaps: number;
  settled: number;
  reason: BackfillReason;
}

export interface BackfillPlanInput {
  /** Confirmed seqs currently held (pending rows excluded), any order. */
  localSeqs: readonly number[];
  /** Owner-reported latest VISIBLE (non-control) seq. 0 = unknown. */
  ownerLatestChatSeq: number;
  /** Ranges already answered by the owner; never asked for again. */
  settled?: ReadonlySet<number>;
  batchSeqs?: number;
  maxRanges?: number;
  lagThreshold?: number;
  /** Ms since the last live frame for this room (quiet detection). */
  quietMs?: number;
}

function toSeqSet(input?: ReadonlySet<number>): ReadonlySet<number> {
  return input ?? new Set<number>();
}

function sanitiseSeqs(seqs: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const seq of seqs) {
    if (typeof seq === "number" && Number.isFinite(seq) && seq > 0) seen.add(Math.floor(seq));
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Split ranges into requestable runs: consecutive seqs that are not settled,
 * each capped at `batchSeqs`, taking at most `maxRanges` runs.
 */
function clipRanges(
  ranges: readonly SeqRange[],
  settled: ReadonlySet<number>,
  maxRanges: number,
  batchSeqs: number,
): SeqRange[] {
  const out: SeqRange[] = [];
  for (const range of ranges) {
    let runStart: number | null = null;
    let runLen = 0;
    const flush = (): boolean => {
      if (runStart === null || runLen === 0) return false;
      out.push({ from: runStart, to: runStart + runLen - 1 });
      runStart = null;
      runLen = 0;
      return out.length >= maxRanges;
    };
    for (let seq = range.from; seq <= range.to; seq += 1) {
      if (settled.has(seq)) {
        if (flush()) return out;
        continue;
      }
      if (runStart === null) runStart = seq;
      runLen += 1;
      if (runLen >= batchSeqs) {
        if (flush()) return out;
      }
    }
    if (flush()) return out;
  }
  return out;
}

/**
 * Decide what a member should ask the owner for.
 *
 * Interior holes are requested first (they are definitive losses: the owner's
 * seq numbers skip them, so something was missed), then the tail if it lags by
 * more than `lagThreshold` — or by anything at all once the stream has gone quiet.
 *
 * `ownerLatestChatSeq` must be the owner's newest VISIBLE (non-control) seq, not
 * its raw max: control frames never enter the read view, so a raw max would make
 * the tail look permanently lagged and generate a request per reconnect forever.
 */
export function planBackfill(input: BackfillPlanInput): BackfillPlan {
  const settled = toSeqSet(input.settled);
  const batchSeqs = Math.max(1, Math.floor(input.batchSeqs ?? BACKFILL_BATCH_SEQS));
  const maxRanges = Math.max(1, Math.floor(input.maxRanges ?? BACKFILL_MAX_RANGES));
  const threshold = Math.max(0, Math.floor(input.lagThreshold ?? BACKFILL_LAG_THRESHOLD));
  const quiet = (input.quietMs ?? 0) >= BACKFILL_QUIET_MS;
  const owner = Math.max(0, Math.floor(input.ownerLatestChatSeq || 0));

  const local = sanitiseSeqs(input.localSeqs);

  if (owner <= 0) {
    // No owner signal at all: nothing to converge to. (An old owner that does
    // not report seq numbers must never make a member guess.)
    return { requests: [], lag: 0, gaps: 0, settled: settled.size, reason: "no-owner-signal" };
  }

  if (local.length === 0) {
    // Nothing held: pull the tail only — never the whole history.
    const from = Math.max(1, owner - batchSeqs + 1);
    const requests = clipRanges([{ from, to: owner }], settled, maxRanges, batchSeqs);
    return { requests, lag: owner, gaps: 0, settled: settled.size, reason: requests.length > 0 ? "lag" : "converged" };
  }

  const minLocal = local[0]!;
  const maxLocal = local[local.length - 1]!;

  const holes: SeqRange[] = [];
  let gaps = 0;
  let prev = minLocal;
  for (const seq of local) {
    if (seq > prev + 1) {
      holes.push({ from: prev + 1, to: seq - 1 });
      for (let s = prev + 1; s < seq; s += 1) if (!settled.has(s)) gaps += 1;
    }
    prev = seq;
  }

  let lag = 0;
  for (let s = maxLocal + 1; s <= owner; s += 1) if (!settled.has(s)) lag += 1;

  const tail: SeqRange[] = maxLocal < owner ? [{ from: maxLocal + 1, to: owner }] : [];
  const tailWanted = tail.length > 0 && (quiet || owner - maxLocal > threshold);

  const requests = clipRanges(
    [...holes, ...(tailWanted ? tail : [])],
    settled,
    maxRanges,
    batchSeqs,
  );

  const reason: BackfillReason = requests.length === 0
    ? "converged"
    : (gaps > 0 ? "gap" : "lag");

  return { requests, lag, gaps, settled: settled.size, reason };
}

/* --------------------------------- merge --------------------------------- */

export interface MergeOutcome {
  /** The new read view: existing rows, merged, sorted, pending rows kept last. */
  messages: ChatMessage[];
  /** Rows that were actually new (emit these; they are the ones the member missed). */
  added: ChatMessage[];
  /** Incoming rows already present by seq — never re-added, never overwritten. */
  duplicates: number;
  /** Incoming control frames dropped from the read view (0.1.31+ rule). */
  controlSkipped: number;
  /** Local pending rows carried through untouched. */
  pendingKept: number;
  /** Confirmed rows dropped by the read-view ceiling (oldest first). */
  pruned: number;
}

/** True for a locally appended optimistic row (negative seq, pending flag). */
export function isPendingRow(message: ChatMessage): boolean {
  return message.pending === true || (typeof message.seq === "number" && message.seq <= 0);
}

/**
 * Merge authoritative messages into a read view by seq.
 *
 * Rules, in the order they are applied:
 *  - control frames are dropped (they are work orders, not chat, and must never
 *    be replayed into a read view — see isControlFrame);
 *  - a row whose seq already exists is skipped (`duplicates`), so a backfill can
 *    never duplicate a row the member already has, and can never overwrite one;
 *  - locally appended pending rows are carried through untouched and stay last,
 *    so a sender never loses its own unconfirmed message to a backfill;
 *  - confirmed rows are sorted by seq so the read view's tail stays meaningful;
 *  - the oldest confirmed rows beyond `maxConfirmed` are pruned (bounded memory).
 *
 * The returned array is always a NEW array: callers assign
 * `snapshot.recentMessages = outcome.messages` rather than mutating a shared list.
 */
export function mergeBackfill(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
  maxConfirmed: number = MAX_READ_VIEW_CONFIRMED,
): MergeOutcome {
  const confirmed = new Map<number, ChatMessage>();
  const pending: ChatMessage[] = [];
  for (const message of existing) {
    if (!message) continue;
    if (isPendingRow(message)) {
      pending.push(message);
      continue;
    }
    if (!confirmed.has(message.seq)) confirmed.set(message.seq, message);
  }

  const added: ChatMessage[] = [];
  let duplicates = 0;
  let controlSkipped = 0;
  for (const message of incoming) {
    if (!message) continue;
    if (isControlFrame(message.text)) {
      controlSkipped += 1;
      continue;
    }
    if (isPendingRow(message)) {
      // A "pending" row can only come from this node; an owner never sends one.
      controlSkipped += 1;
      continue;
    }
    if (confirmed.has(message.seq)) {
      duplicates += 1;
      continue;
    }
    confirmed.set(message.seq, message);
    added.push(message);
  }

  let rows = [...confirmed.values()].sort((a, b) => a.seq - b.seq);
  let pruned = 0;
  const ceiling = Math.max(1, Math.floor(maxConfirmed));
  if (rows.length > ceiling) {
    pruned = rows.length - ceiling;
    rows = rows.slice(pruned);
  }

  return { messages: [...rows, ...pending], added, duplicates, controlSkipped, pendingKept: pending.length, pruned };
}

/* --------------------------------- state --------------------------------- */

export interface BackfillDiagnostics {
  ownerLatestSeq: number;
  ownerLatestChatSeq: number;
  localLatestSeq: number;
  lag: number;
  gaps: number;
  settled: number;
  inflight: number;
  requestsSent: number;
  messagesAdded: number;
  duplicatesSkipped: number;
  failures: number;
  lastRequestAt: number;
  nextAttemptAt: number;
  reason: BackfillReason | "backoff" | "in-flight" | "offline";
  converged: boolean;
}

/**
 * Per-room convergence state: what the owner said, what we already asked for, and
 * the pacing/backoff that keeps this from becoming a storm.
 *
 * Deliberately free of sockets and timers — RoomClient drives it and owns the
 * clocks, so every rule below can be tested by calling it directly.
 */
export class BackfillState {
  ownerLatestSeq = 0;
  ownerLatestChatSeq = 0;
  /** Ms timestamp of the last live chat frame from the owner (quiet detection). */
  lastLiveAt = 0;
  lastRequestAt = 0;
  lastStatAt = 0;
  requestsSent = 0;
  messagesAdded = 0;
  duplicatesSkipped = 0;
  failures = 0;
  /** Ms timestamp before which nothing may be sent (backoff after a failure). */
  nextAttemptAt = 0;

  private inflightCount = 0;
  private pendingRange: SeqRange | null = null;
  private readonly settled = new Set<number>();
  private localLatest = 0;

  get inflight(): number {
    return this.inflightCount;
  }

  get settledCount(): number {
    return this.settled.size;
  }

  /** The range currently in flight, if any (diagnostics/tests). */
  get inFlightRange(): SeqRange | null {
    return this.pendingRange;
  }

  /**
   * Record the owner's seq numbers (from a snapshot, a stat reply or a backfill
   * reply). Never lets the values go backwards: a stale snapshot must not re-open
   * a range that was already settled.
   */
  noteOwnerSeqs(latestSeq: number, latestChatSeq: number): void {
    const raw = Number.isFinite(latestSeq) ? Math.floor(latestSeq) : 0;
    const chat = Number.isFinite(latestChatSeq) ? Math.floor(latestChatSeq) : 0;
    if (raw > this.ownerLatestSeq) this.ownerLatestSeq = raw;
    if (chat > this.ownerLatestChatSeq) this.ownerLatestChatSeq = chat;
  }

  /**
   * A live frame arrived. The frame's own seq is a lower bound for the owner's
   * latest VISIBLE seq — but only for visible frames: a control frame's seq says
   * nothing about the read view.
   */
  noteLiveFrame(seq: number, control: boolean, now = Date.now()): void {
    this.lastLiveAt = now;
    if (!control && Number.isFinite(seq) && seq > this.ownerLatestChatSeq) this.ownerLatestChatSeq = Math.floor(seq);
  }

  /** The channel re-opened: forget pacing/backoff, keep what we know. */
  noteReconnect(now = Date.now()): void {
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.lastRequestAt = 0;
    this.inflightCount = 0;
    this.pendingRange = null;
    this.lastStatAt = now;
  }

  /** Plan the next request against the current local view. */
  plan(localSeqs: readonly number[], now = Date.now()): BackfillPlan {
    this.localLatest = localSeqMax(localSeqs);
    return planBackfill({
      localSeqs,
      ownerLatestChatSeq: this.ownerLatestChatSeq,
      settled: this.settled,
      quietMs: this.lastLiveAt > 0 ? now - this.lastLiveAt : BACKFILL_QUIET_MS,
    });
  }

  /** True when a request may be sent right now (polite pacing, one in flight). */
  canRequest(now = Date.now()): boolean {
    if (this.inflightCount > 0) return false;
    if (now < this.nextAttemptAt) return false;
    if (this.lastRequestAt > 0 && now - this.lastRequestAt < BACKFILL_MIN_INTERVAL_MS) return false;
    return true;
  }

  /**
   * Ms until the next request is allowed (0 = now), or -1 while an answer is
   * outstanding — in that case the reply is what schedules the next round, so the
   * caller must not arm a timer of its own.
   *
   * Exists so a paced round is RE-SCHEDULED instead of dropped: a dropped round
   * used to mean the catch-up waited for the next poll (up to 15s per hole).
   */
  msUntilRequestAllowed(now = Date.now()): number {
    if (this.inflightCount > 0) return -1;
    const next = Math.max(this.nextAttemptAt, this.lastRequestAt > 0 ? this.lastRequestAt + BACKFILL_MIN_INTERVAL_MS : 0);
    return Math.max(0, next - now);
  }

  /** True when a `chat.stat` probe is due and allowed. */
  canProbe(now = Date.now()): boolean {
    if (this.inflightCount > 0) return false;
    if (now < this.nextAttemptAt) return false;
    return now - this.lastStatAt >= BACKFILL_POLL_MS;
  }

  /** Remember that a request was put on the wire. */
  noteRequest(range: SeqRange, now = Date.now()): void {
    this.inflightCount += 1;
    this.pendingRange = range;
    this.lastRequestAt = now;
    this.requestsSent += 1;
  }

  /** Remember that a probe was put on the wire. */
  noteProbe(now = Date.now()): void {
    this.lastStatAt = now;
    this.inflightCount += 1;
  }

  /**
   * The owner answered for `[from, to]`: settle every seq in it.
   *
   * This is what makes the loop terminate. The owner's reply means "every seq up
   * to `to` has been examined": the ones it did not return are control frames or
   * deleted rows, so they are not holes and must never be asked for again.
   */
  noteAnswered(from: number, to: number): void {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    const lo = Math.max(1, Math.floor(from));
    const hi = Math.floor(to);
    for (let seq = lo; seq <= hi; seq += 1) this.settled.add(seq);
    this.trimSettled();
  }

  /** Record what a merge actually changed (diagnostics). */
  noteMerge(added: number, duplicates: number): void {
    this.messagesAdded += Math.max(0, added);
    this.duplicatesSkipped += Math.max(0, duplicates);
  }

  /** Reply arrived (or failed to); the in-flight slot is free again. */
  noteSettledInFlight(): void {
    this.inflightCount = Math.max(0, this.inflightCount - 1);
    this.pendingRange = null;
    this.failures = 0;
    this.nextAttemptAt = 0;
  }

  /**
   * The channel is gone: nothing will answer, so drop the in-flight slot without
   * touching `failures` (a dropped channel is not an owner that ignored us, and
   * the backoff has to survive it).
   */
  forgetInFlight(): void {
    this.inflightCount = 0;
    this.pendingRange = null;
  }

  /** The owner did not answer in time — back off before trying again. */
  noteFailure(now = Date.now()): void {
    this.inflightCount = Math.max(0, this.inflightCount - 1);
    this.pendingRange = null;
    this.failures += 1;
    const delay = Math.min(BACKFILL_BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKFILL_BACKOFF_MAX_MS);
    this.nextAttemptAt = now + delay;
  }

  /** Keep the settled set bounded, and forget seqs we now actually hold. */
  trimSettled(localSeqs: readonly number[] = []): void {
    for (const seq of localSeqs) this.settled.delete(seq);
    if (this.settled.size <= BACKFILL_MAX_SETTLED) return;
    // Oldest-first eviction: a settled seq only matters while it is near the
    // range we hold, and that range walks forward.
    const sorted = [...this.settled].sort((a, b) => a - b);
    for (const seq of sorted) {
      if (this.settled.size <= BACKFILL_MAX_SETTLED) break;
      this.settled.delete(seq);
    }
  }

  /**
   * Diagnostics for the room panel and the logs.
   *
   * `localSeqs` is passed in rather than remembered: the lag must be computed
   * against the CURRENT read view, or a state that has fallen behind would keep
   * reporting the last planned value as if it were converged.
   */
  diagnostics(localSeqs: readonly number[] = [], now = Date.now()): BackfillDiagnostics {
    const localLatest = localSeqs.length > 0 ? localSeqMax(localSeqs) : this.localLatest;
    if (localSeqs.length > 0) this.localLatest = localLatest;
    const lag = localLatest > 0 ? Math.max(0, this.ownerLatestChatSeq - localLatest) : this.ownerLatestChatSeq;
    const converged = this.ownerLatestChatSeq <= 0 || lag <= 0;
    const reason: BackfillDiagnostics["reason"] = this.inflightCount > 0
      ? "in-flight"
      : (now < this.nextAttemptAt ? "backoff" : (converged ? "converged" : "lag"));
    return {
      ownerLatestSeq: this.ownerLatestSeq,
      ownerLatestChatSeq: this.ownerLatestChatSeq,
      localLatestSeq: localLatest,
      lag,
      gaps: 0,
      settled: this.settled.size,
      inflight: this.inflightCount,
      requestsSent: this.requestsSent,
      messagesAdded: this.messagesAdded,
      duplicatesSkipped: this.duplicatesSkipped,
      failures: this.failures,
      lastRequestAt: this.lastRequestAt,
      nextAttemptAt: this.nextAttemptAt,
      reason,
      converged,
    };
  }
}

/** Highest seq in a list of confirmed seqs (0 when empty). */
export function localSeqMax(seqs: readonly number[]): number {
  let max = 0;
  for (const seq of seqs) {
    if (typeof seq === "number" && Number.isFinite(seq) && seq > max) max = Math.floor(seq);
  }
  return max;
}
