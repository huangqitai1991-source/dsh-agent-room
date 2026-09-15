/**
 * dsh-agent-room — the ACTIVATION chain (0.1.47): the wake does not start a turn,
 * and every step between the two is finally observable.
 *
 * WHY THIS EXISTS (measured on this fleet, 2026-09-15/16 — all first-hand)
 *
 * 0.1.45 fixed the wake RULE (a script dispatch that names a machine now wakes it:
 * `listening: woken seq=… rule=mention`, `wake.wokenByMention` grows). 0.1.46 added the
 * ACK receipt (`[ack] <nickname> 已接手 seq=N`). **Both work. And the ack immediately
 * exposed the real gap underneath them:**
 *
 *     the wake arrives, the receipt is posted, and THE TURN NEVER STARTS.
 *
 * Three machines, three different failures, measured on their own logs the same evening:
 *
 *   小婷 — `POST /activate-chat` → `active-session: session-b7496a19…` → `registry dump —
 *          detected=… list=[…]` → `accepted … thinking=true` → `dispatching followup … to
 *          agent agent-room-duty-01a09483…` → **`followup accepted`** → 小婷 really posted
 *          into the room. WORKS. (This is the control experiment: the code path is fine.)
 *   小麦 — `activate-chat: accepted … thinking=true` → `dispatching followup … to agent
 *          agent-room-duty-01a09461…` → **and the log simply stops.** No `followup accepted`,
 *          no error, no counter. A SILENT FAILURE, and there is nothing anywhere to say
 *          whether the turn started and died, or never started at all.
 *   小黄 — `active-session: session-7f81275b… (global fallback, … dir=false)` → `registry
 *          dump — detected=session-7f81275b… list=[] roots=[]` → **no `accepted` and no
 *          `dispatching` line at all.** Its resident agent is not bound to a duty
 *          workspace, so the machine is STRUCTURALLY unable to accept a wake — and that
 *          fact was invisible from `GET /agent-room-api/state`.
 *
 * WHY `agent.followup` RETURNING PROVES ALMOST NOTHING (read from the harness, first-hand)
 *
 * `dsh-agent-loop/lib/index.js:396` is the whole implementation:
 *
 *     followup(input) { this.send(input, "next-turn", true); }
 *
 * and `send` (`:389`) does `this.inbox.splice(…); if (wakeup) this.wakeDriver(…)`, while
 * `wakeDriver` (`:444`) returns EARLY whenever the agent is not idle:
 *
 *     wakeDriver(wakeAfterAbort = false) {
 *       if (this.phase.kind !== "idle") { … this.phase.wakeRequested = true; return; }
 *       …
 *     }
 *
 * So the synchronous return value of `followup` is `undefined` in every case, and it
 * cannot throw for a busy agent. It proves exactly ONE thing — the message reached that
 * agent's INBOX. It does not prove a turn started, and it certainly does not prove a
 * model produced a token. 0.1.46's ack plane already said this out loud
 * (`ack.ts:31-44`); 0.1.47 is the version that stops ending the sentence there.
 *
 * WHAT THIS MODULE ADDS: three things, and nothing else
 *
 *   1. **ESCALATION.** When a wake was dispatched and the resident agent has not
 *      demonstrably started inside `startWindowMs`, the service does the equivalent of
 *      `activate-chat` itself — it re-resolves the resident agent and hands it the
 *      activate prompt (which REQUIRES a reply, unlike the listen prompt, which explicitly
 *      permits silence). Bounded: at most ONCE per dispatch, and a failed escalation is
 *      counted and logged, never retried in a storm.
 *   2. **THE WHOLE CHAIN IS COUNTED.** rule → dispatch → residency → followup accepted or
 *      refused → turn demonstrably started → own output in the room. One number per step,
 *      flat, in `GET /state.activation.{…}` next to 0.1.45's `wake` and 0.1.46's `ack`.
 *   3. **"THIS MACHINE CANNOT ACCEPT WORK" IS A READABLE FACT.** `resolvedViaNone` /
 *      `noResidentAgent` climbing while every other `resolvedVia*` stays 0 says it from
 *      `/state` alone — no log read, no 142,000-line expedition (小黄's case).
 *
 * WHAT "DEMONSTRABLY STARTED" MEANS HERE (the honest definition, not a vibe)
 *
 * Three independent local evidences, in this order, each counted separately so a reader
 * can see WHICH one fired:
 *
 *   - `status`      — the harness's own getter, `agent.status === "running"`
 *                     (`dsh-agent-loop/lib/index.js:380`: idle ⟺ phase.kind === "idle").
 *   - `transcript`  — a frame was appended to that session's transcript after the dispatch
 *                     (`<DSH_HOME>/sessions/<ws>/<sessionId>/session.jsonl.zstd` mtime
 *                     advanced). This is the in-repo convention `detectActiveSessionId`
 *                     already reads (`service.ts` `detectActiveSessionId`), used here as
 *                     the fallback for agents whose handle does not expose `status`.
 *   - `output`      — this node's OWN message landed in the room (the wake prompt asks the
 *                     agent to answer with `room_send`). Strongest of the three: it is
 *                     what a human reading the room sees.
 *
 * None of the three is "the model produced a token" in general — they are evidences that
 * the resident agent ACTED. `stats()` names them separately instead of merging them into
 * one heroic "started" number, because the whole defect class this family of releases is
 * about is *a signal whose scope is narrower than the claim made with it*.
 *
 * WHAT IS DELIBERATELY *NOT* OUTPUT EVIDENCE (a false positive this module refuses)
 *
 * The 0.1.46 ACK receipt is written by THIS PLUGIN, from this node's own identity, and it
 * lands in the room BEFORE the model does anything. Counting it as "the agent produced
 * output" would make every silent machine look productive — the exact "green signal for a
 * broken thing" failure recorded in 小捷's own review (room seq 4406: three harness
 * rollbacks, two of them judgement-code bugs, one release shipped with a completely broken
 * UI because "server-side all green" was read as success). So the caller filters ack-plane
 * frames and control frames out of the output evidence (`service.ts` `noteOwnReply`).
 *
 * WHY THE NUMBERS ARE THESE NUMBERS
 *
 *   - `startWindowMs = 20_000` — the only measured latency for "wake → turn" on this fleet
 *     is 0.39 s (card 04 §2: every wake was followed 0.39 s later by a full `step/start`
 *     turn, reconstructed from 142 transcripts). 20 s is ≥50× that, and it is deliberately
 *     below both the 60 s `listenPending` re-arm and 0.1.46's 120 s `ACK_WINDOW_MS`, so the
 *     escalation happens while the dispatch is still the immediately preceding event.
 *   - `outputWindowMs = 120_000` — taken from the sender's own absence signal
 *     (`ack.ts:88`, derivation: ≤30 s sweep + 30 s pendingSkip + 25-45 s measured relay
 *     RTT). Declaring "no output" earlier than the sender's "no receipt" would make two
 *     counters about the same event disagree.
 *   - `tickMs = 10_000` — half the start window, so the escalation fires inside
 *     [20 s, 30 s] after a dispatch: one order below the 30 s sweep, four below the ack
 *     window. The tick does ZERO I/O while nothing is pending (`sweepActivation` returns
 *     immediately), so a quiet machine pays nothing.
 *
 * SHAPE (the same family as `wake.ts` / `ack.ts` / `dedupe.ts`: pure state, hard caps,
 * counters, no per-frame logging)
 *
 * Bounded memory: at most `maxPending` dispatches in flight (exceeding the cap is COUNTED,
 * `pendingOverflow`, never silently dropped). Settled entries are removed, so the structure
 * cannot grow with traffic. Deliberately NOT persisted — a wake is a claim about a LIVE
 * handoff, and a restart cannot escalate a turn it did not start (same trade as
 * `ack.ts:236-242`; the consequence is written down in the release doc §10).
 */

/** Bounded window for "the resident agent demonstrably started" (see header). */
export const ACTIVATION_START_WINDOW_MS = 20_000;

/** Bounded window for "the agent produced output"; equals 0.1.46's `ACK_WINDOW_MS`. */
export const ACTIVATION_OUTPUT_WINDOW_MS = 120_000;

/** How often the escalation/settlement sweep runs (half the start window). */
export const ACTIVATION_TICK_MS = 10_000;

/** Dispatches in flight before the structure refuses to track more (counted). */
export const MAX_ACTIVATION_PENDING = 64;

/**
 * Which resolution path produced the resident agent. One counter per path, so a reader of
 * `/state` can tell "this machine resolves a duty agent" from "this machine resolves
 * NOTHING" without reading a log — 小黄's failure, made readable.
 */
export type ResidentPath = "config" | "active-session" | "duty" | "persisted" | "identity" | "heuristic" | "none";

/** Which local evidence proved the turn started. */
export type StartEvidence = "status" | "transcript" | "output";

/** Why an escalation did not happen / did not take. */
export type EscalationFailure = "no-resident-agent" | "no-identity" | "followup-refused" | "room-gone";

/** Why a dispatch settled. The two no-output reasons are the timeout path (counted);
 *  `output` is the good case (the entry closes as soon as the agent's message lands). */
export type SettlementReason = "accepted-no-output" | "refused-no-output" | "output";

/** One dispatch still inside its windows. */
export interface ActivationPending {
  roomId: string;
  seq: number;
  /** Resident agent the wake was handed to (`agent.id ?? sessionId`), "" until accepted. */
  agentId: string;
  dispatchedAt: number;
  /** Was `agent.followup` accepted (returned without throwing)? */
  accepted: boolean;
  /** Transcript mtime observed at dispatch time — the baseline for the `transcript` evidence. */
  baselineMs?: number;
  started: boolean;
  startedAt?: number;
  evidence?: StartEvidence;
  output: boolean;
  /** Escalations fired for this dispatch: 0 or 1, ever. */
  escalations: number;
}

/** A dispatch that must be escalated now (it is past the start window and never started). */
export interface ActivationEscalation {
  roomId: string;
  seq: number;
  agentId: string;
  waitedMs: number;
}

/** A dispatch whose output window closed with nothing produced. */
export interface ActivationSettlement {
  roomId: string;
  seq: number;
  agentId: string;
  waitedMs: number;
  reason: SettlementReason;
}

/** `/state.activation` — FLAT NUMBERS ONLY, same shape as `wake` and `ack`. */
export interface ActivationStats {
  /** Wakes the rule admitted AND a resident agent accepted the dispatch for. */
  dispatches: number;
  /** Handoffs a resident agent accepted (`agent.followup` returned without throwing — inbox
   *  insertion only). This CAN exceed `dispatches`: an escalation is a second handoff for the
   *  same wake, and it is counted here as well as in `escalationsSucceeded`. */
  accepted: number;
  /** A second wake for a `(room, seq)` already in flight — refused, counted. */
  duplicateDispatches: number;
  /* ------------------------------ the failure that was silent ------------------------------ */
  /** `agent.followup` threw (or was absent): NOTHING was handed to the agent. */
  followupRefused: number;
  /** The rule admitted a wake and there was NO resident agent to hand it to (小黄's case). */
  noResidentAgent: number;
  /** Resolutions that DID produce a resident agent. */
  residentResolved: number;
  /** Resolution path counters — read them together: all zero except `resolvedViaNone` means
   *  this machine is STRUCTURALLY unable to accept work, visible from /state alone. */
  resolvedViaConfig: number;
  resolvedViaActiveSession: number;
  resolvedViaDuty: number;
  resolvedViaPersisted: number;
  resolvedViaIdentity: number;
  resolvedViaHeuristic: number;
  resolvedViaNone: number;
  /** 1 when the most recent resolution produced a resident agent, 0 when it did not. */
  lastResidentOk: number;
  /* ------------------------------ the chain, step by step ------------------------------ */
  /** Dispatches that demonstrably started a turn inside the start window (any evidence). */
  started: number;
  startedByStatus: number;
  startedByTranscript: number;
  startedByOutput: number;
  /** This node's own (non-ack, non-control) messages observed in the room after a wake. */
  outputs: number;
  /* ------------------------------ escalation ------------------------------ */
  /** Escalations fired (≤ 1 per dispatch — the bound is IN the counter's meaning). */
  escalationsAttempted: number;
  escalationsSucceeded: number;
  escalationsFailed: number;
  escalationsFailedNoAgent: number;
  escalationsFailedRefused: number;
  /* ------------------------------ settlement ------------------------------ */
  /** ACCEPTED, and no output inside the window: the "dispatching followup … then nothing"
   *  case (小麦), now a number instead of a mystery. */
  acceptedNoOutput: number;
  /** Never accepted at all, and no output inside the window. */
  refusedNoOutput: number;
  /* ------------------------------ boundaries ------------------------------ */
  /** Dispatches in flight right now. */
  pending: number;
  /** Dispatches closed (started+output, or the output window elapsed). */
  settled: number;
  /** Dispatches refused because `maxPending` was reached. */
  pendingOverflow: number;
  maxPending: number;
  startWindowMs: number;
  outputWindowMs: number;
  tickMs: number;
}

/**
 * The activation chain. Pure in-process state: hard caps, per-step counters, no per-frame
 * logging (the 411 MB audit-file lesson). Every method is O(pending), and nothing here
 * touches the filesystem, the network or a timer — the service owns all three.
 */
export class WakeActivation {
  private readonly pending: ActivationPending[] = [];
  private dispatchCount = 0;
  private acceptedCount = 0;
  private duplicateDispatchCount = 0;
  private followupRefusedCount = 0;
  private noResidentAgentCount = 0;
  private residentResolvedCount = 0;
  private lastResidentOk = 0;
  private readonly viaCount: Record<ResidentPath, number> = {
    config: 0,
    "active-session": 0,
    duty: 0,
    persisted: 0,
    identity: 0,
    heuristic: 0,
    none: 0,
  };
  private startedCount = 0;
  private startedByStatusCount = 0;
  private startedByTranscriptCount = 0;
  private startedByOutputCount = 0;
  private outputCount = 0;
  private escalationAttemptCount = 0;
  private escalationSuccessCount = 0;
  private escalationFailureCount = 0;
  private escalationFailedNoAgentCount = 0;
  private escalationFailedRefusedCount = 0;
  private acceptedNoOutputCount = 0;
  private refusedNoOutputCount = 0;
  private settledCount = 0;
  private pendingOverflowCount = 0;

  constructor(
    private readonly maxPending: number = MAX_ACTIVATION_PENDING,
    private readonly startWindowMs: number = ACTIVATION_START_WINDOW_MS,
    private readonly outputWindowMs: number = ACTIVATION_OUTPUT_WINDOW_MS,
    private readonly tickMs: number = ACTIVATION_TICK_MS,
  ) {}

  /** The dispatch in flight for one `(roomId, seq)`, if any. */
  private find(roomId: string, seq: number): ActivationPending | undefined {
    return this.pending.find((entry) => entry.roomId === roomId && entry.seq === seq);
  }

  /**
   * Record that a wake the rule admitted is about to be handed to a resident agent.
   *
   * @returns the entry, or undefined when it was refused (duplicate, or the cap was hit).
   *          Both refusals are COUNTED — the caller logs them, so "the wake happened but
   *          nothing is tracked" can never be inferred wrongly.
   */
  noteDispatch(roomId: string, seq: number, now: number = Date.now()): ActivationPending | undefined {
    if (this.find(roomId, seq)) {
      this.duplicateDispatchCount += 1;
      return undefined;
    }
    if (this.pending.length >= this.maxPending) {
      this.pendingOverflowCount += 1;
      return undefined;
    }
    const entry: ActivationPending = {
      roomId,
      seq,
      agentId: "",
      dispatchedAt: now,
      accepted: false,
      started: false,
      output: false,
      escalations: 0,
    };
    this.pending.push(entry);
    this.dispatchCount += 1;
    return entry;
  }

  /** The resident agent accepted the dispatch (followup returned; inbox insertion only). */
  noteAccepted(roomId: string, seq: number, agentId: string, baselineMs?: number): void {
    const entry = this.find(roomId, seq);
    this.acceptedCount += 1;
    if (!entry) return;
    entry.accepted = true;
    entry.agentId = agentId;
    if (typeof baselineMs === "number" && Number.isFinite(baselineMs)) entry.baselineMs = baselineMs;
  }

  /**
   * `agent.followup` threw: NOTHING was handed to any agent. Counted and logged.
   *
   * The entry deliberately STAYS in flight: a refusal is not a start, so the escalation
   * window still applies and the service gets one chance to re-resolve a live resident
   * agent and activate it. The settlement bucket keeps the two apart
   * (`refusedNoOutput` vs `acceptedNoOutput`), so a refusal can never be reported as an
   * accepted-but-silent dispatch.
   */
  noteFollowupRefused(roomId: string, seq: number): void {
    this.followupRefusedCount += 1;
    const entry = this.find(roomId, seq);
    if (entry) entry.accepted = false;
  }

  /** One residency resolution result — the path is counted, so the failure is readable. */
  noteResident(path: ResidentPath): void {
    this.viaCount[path] = (this.viaCount[path] ?? 0) + 1;
    if (path === "none") {
      this.lastResidentOk = 0;
      return;
    }
    this.residentResolvedCount += 1;
    this.lastResidentOk = 1;
  }

  /**
   * The wake's `(roomId, seq)` was admitted by the rule but NO resident agent exists to
   * hand it to — 小黄's failure. The two numbers answer different questions and are
   * deliberately NOT the same counter:
   * `resolvedViaNone` counts every failed resolution (a human clicking 激活聊天 on a broken
   * machine counts too), `noResidentAgent` counts only the ones that cost a real,
   * rule-admitted wake or a real escalation.
   */
  noteNoResident(): void {
    this.noResidentAgentCount += 1;
  }

  /** One local evidence that the turn started. First evidence wins; later ones are ignored
   *  (so `started` can never exceed the number of dispatches). */
  noteStart(roomId: string, seq: number, evidence: StartEvidence, now: number = Date.now()): boolean {
    const entry = this.find(roomId, seq);
    if (!entry || entry.started) return false;
    entry.started = true;
    entry.startedAt = now;
    entry.evidence = evidence;
    this.startedCount += 1;
    if (evidence === "status") this.startedByStatusCount += 1;
    else if (evidence === "transcript") this.startedByTranscriptCount += 1;
    else this.startedByOutputCount += 1;
    return true;
  }

  /**
   * This node's own message landed in the room — the strongest evidence, and the only one
   * a human reading the room can see for themselves.
   *
   * The caller MUST have filtered ack-plane frames and control frames first (see the header:
   * the receipt is written by this plugin, not by the model).
   *
   * A positive `seq` is required to be >= the woken seq, so output is never credited to a
   * wake that came after it. A pending (negative) local seq is accepted: the owner has not
   * echoed it back yet, and refusing it would lose real output.
   *
   * @returns the room's settled entries (the caller logs the closure).
   */
  noteOutput(roomId: string, seq: number, now: number = Date.now()): ActivationSettlement[] {
    const settled: ActivationSettlement[] = [];
    for (const entry of this.pending) {
      if (entry.roomId !== roomId) continue;
      if (Number.isSafeInteger(seq) && seq > 0 && Number.isSafeInteger(entry.seq) && entry.seq > 0 && seq < entry.seq) continue;
      this.outputCount += 1;
      entry.output = true;
      if (!entry.started) {
        entry.started = true;
        entry.startedAt = now;
        entry.evidence = "output";
        this.startedCount += 1;
        this.startedByOutputCount += 1;
      }
      settled.push({ roomId: entry.roomId, seq: entry.seq, agentId: entry.agentId, waitedMs: now - entry.dispatchedAt, reason: "output" });
    }
    for (const done of settled) this.close(done.roomId, done.seq);
    return settled;
  }

  /** Remove one settled entry (bounded memory). */
  private close(roomId: string, seq: number): void {
    const index = this.pending.findIndex((entry) => entry.roomId === roomId && entry.seq === seq);
    if (index >= 0) {
      this.pending.splice(index, 1);
      this.settledCount += 1;
    }
  }

  /**
   * Dispatches that must be escalated NOW: past the start window, never started, and never
   * escalated before. The escalation is MARKED here (not by the caller), which is what makes
   * "at most once per dispatch" a property of the structure rather than of the caller's
   * discipline — a slow or failing escalation can never be fired twice by a later tick.
   */
  dueEscalation(now: number = Date.now()): ActivationEscalation[] {
    const due: ActivationEscalation[] = [];
    for (const entry of [...this.pending]) {
      if (entry.started || entry.escalations > 0) continue;
      const waited = now - entry.dispatchedAt;
      if (waited < this.startWindowMs) continue;
      entry.escalations += 1;
      this.escalationAttemptCount += 1;
      due.push({ roomId: entry.roomId, seq: entry.seq, agentId: entry.agentId, waitedMs: waited });
    }
    return due;
  }

  /** The outcome of one escalation. Both outcomes are counted; a failure also names why. */
  noteEscalationResult(ok: boolean, failure?: EscalationFailure): void {
    if (ok) {
      this.escalationSuccessCount += 1;
      return;
    }
    this.escalationFailureCount += 1;
    if (failure === "no-resident-agent") {
      this.escalationFailedNoAgentCount += 1;
      this.noResidentAgentCount += 1;
      this.viaCount.none += 1;
      this.lastResidentOk = 0;
    } else if (failure === "followup-refused") {
      this.escalationFailedRefusedCount += 1;
    }
  }

  /**
   * Dispatches whose OUTPUT window has elapsed: the timeout path, named. An accepted
   * dispatch lands in `acceptedNoOutput` (小麦's "dispatching followup … and then the log
   * just stops"), a refused one in `refusedNoOutput`, so the two can never be confused.
   */
  dueSettlement(now: number = Date.now()): ActivationSettlement[] {
    const due: ActivationSettlement[] = [];
    for (const entry of [...this.pending]) {
      const waited = now - entry.dispatchedAt;
      if (waited < this.outputWindowMs) continue;
      const reason: SettlementReason = entry.accepted ? "accepted-no-output" : "refused-no-output";
      if (entry.accepted) this.acceptedNoOutputCount += 1;
      else this.refusedNoOutputCount += 1;
      due.push({ roomId: entry.roomId, seq: entry.seq, agentId: entry.agentId, waitedMs: waited, reason });
    }
    for (const done of due) this.close(done.roomId, done.seq);
    return due;
  }

  /** Entries in flight, for the service's evidence pass (a copy: callers never mutate it). */
  pendingEntries(): ActivationPending[] {
    return this.pending.map((entry) => ({ ...entry }));
  }

  /** How many dispatches are in flight (so the tick can skip ALL work when none are). */
  pendingCount(): number {
    return this.pending.length;
  }

  /** Leaving a room drops its in-flight dispatches (mirrors `WakeWatermark.forget`). */
  forget(roomId: string): void {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i]!.roomId === roomId) this.pending.splice(i, 1);
    }
  }

  /** Numeric diagnostics only (never a per-frame record). */
  stats(): ActivationStats {
    return {
      dispatches: this.dispatchCount,
      accepted: this.acceptedCount,
      duplicateDispatches: this.duplicateDispatchCount,
      followupRefused: this.followupRefusedCount,
      noResidentAgent: this.noResidentAgentCount,
      residentResolved: this.residentResolvedCount,
      resolvedViaConfig: this.viaCount.config,
      resolvedViaActiveSession: this.viaCount["active-session"],
      resolvedViaDuty: this.viaCount.duty,
      resolvedViaPersisted: this.viaCount.persisted,
      resolvedViaIdentity: this.viaCount.identity,
      resolvedViaHeuristic: this.viaCount.heuristic,
      resolvedViaNone: this.viaCount.none,
      lastResidentOk: this.lastResidentOk,
      started: this.startedCount,
      startedByStatus: this.startedByStatusCount,
      startedByTranscript: this.startedByTranscriptCount,
      startedByOutput: this.startedByOutputCount,
      outputs: this.outputCount,
      escalationsAttempted: this.escalationAttemptCount,
      escalationsSucceeded: this.escalationSuccessCount,
      escalationsFailed: this.escalationFailureCount,
      escalationsFailedNoAgent: this.escalationFailedNoAgentCount,
      escalationsFailedRefused: this.escalationFailedRefusedCount,
      acceptedNoOutput: this.acceptedNoOutputCount,
      refusedNoOutput: this.refusedNoOutputCount,
      pending: this.pending.length,
      settled: this.settledCount,
      pendingOverflow: this.pendingOverflowCount,
      maxPending: this.maxPending,
      startWindowMs: this.startWindowMs,
      outputWindowMs: this.outputWindowMs,
      tickMs: this.tickMs,
    };
  }
}
