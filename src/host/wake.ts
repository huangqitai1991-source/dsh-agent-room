/**
 * dsh-agent-room — the WAKE plane's convergence rule and author classification
 * (0.1.41).
 *
 * WHY THIS EXISTS (card 04 v2 §2, measured on this fleet)
 *
 * One room message (`roomId 01a098a2-2015-7a1d-b5f7-9eca45afa65d`, seq 315,
 * authored by THIS node's own agentId, `human:true`, ts 2026-09-13T09:28:50.994Z)
 * woke this node's own session 18 times, the first re-wake 6415 s (1 h 47 min)
 * after it was written, each wake followed 0.39 s later by a full `step/start`
 * turn (142 transcripts / 415,737 frames were read to reconstruct that).
 *
 * The wake path (`AgentRoomService.runListenWake`) had NO `(roomId, seq)` rule at
 * all — the delivery plane has had one since 0.1.39 (`dedupe.ts`), the wake plane
 * did not. The only cursor it had, `listenSeen`, was a HIGH-WATER MARK THAT COULD
 * MOVE BACKWARDS: it was overwritten with the tail of this node's 20-message
 * window (`recentMessagesFor(roomId, 20)`) on every sweep, and that tail lags the
 * owner's store whenever this node's mirror is behind (measured: 15 local rows vs
 * 2200+ owner rows). Once the tail regressed below an already-woken seq, that seq
 * looked "fresh" again on the next tick (measured gap 89.6 s ≈ the 60 s
 * `listenPending` re-arm plus the 30 s sweep).
 *
 * WHY A MONOTONIC WATERMARK AND NOT A TTL
 *
 * Two independent reviewers rejected a TTL guard: the backwards-regression span
 * has NO upper bound (15 local rows vs 2200+ owner rows is one measurement, not a
 * bound), so "TTL ≥ regression span" cannot be satisfied by any finite value. The
 * owner assigns seq monotonically, so "the highest seq ever woken" is a rule that
 * is correct by construction: every seq ≤ it was written before a message this
 * node already woke for, and can therefore never be a NEW instruction. It also
 * cannot expire, so it cannot silently re-open the defect after a quiet period.
 *
 * SHAPE (deliberately the same family as `dedupe.ts`: pure state, hard caps,
 * counters)
 *
 * One NUMBER per room — a watermark, not a ring of seqs — so the memory bound is
 * `MAX_WAKE_ROOMS` numbers (a ring of 4096 seqs/room buys nothing here: the
 * monotone rule subsumes every seq below the mark). Exceeding the room cap RESETS
 * the structure, exactly like `DeliveryDedupe`: a reset costs at most one extra
 * wake per room and can never grow without bound.
 *
 * Invalid seqs (0 / negative / non-integer — this node's own optimistic rows carry
 * NEGATIVE seqs, `room-client.ts` "Pending rows carry negative seqs") are never
 * recorded, so the watermark can never swallow a row this node just sent locally.
 *
 * COUNTER RULES (same lesson as `dedupe.ts`: a per-frame log line once grew an
 * audit file to 411 MB): numeric counters in `GET /agent-room-api/state` under
 * `wake.{…}`, and — because the whole point of 0.1.41 is that the NEXT
 * investigation must not need a transcript expedition — one self-describing line
 * per admitted wake (`woken seq=X`) and per suppressed one
 * (`skipped seq=X (dedupe)`). That line is NOT rate-limited: the 30 s sweep plus
 * the 60 s `listenPending` re-arm cap this boundary at ~1 entry per room per 90 s
 * (≤128 rooms), which is four orders of magnitude below the per-frame volume the
 * 411 MB incident was made of. The two guard-trip warnings (`regressed`,
 * `roomResets`) ARE rate-limited by the caller, keyed per room so the limiter's
 * own bookkeeping cannot grow with seq count.
 * `regressed` is the guard's own tripwire: it must stay 0. A climbing value means
 * some caller bypassed `seen()` and marked a seq below the watermark.
 */

/** Rooms remembered before the whole structure resets (same budget as dedupe.ts). */
export const MAX_WAKE_ROOMS = 128;

/** The three author classes the wake plane distinguishes (0.1.41 §4.3). */
export type ListenAuthorKind = "human" | "agent" | "self";

/** Labels rendered into the wake prompt. The literal below is the one the defect
 *  produced for a bot's own message; it is now reachable ONLY for a human. */
export const WAKE_LABEL_HUMAN = "人类发言（远程指挥，最高优先级）";
export const WAKE_LABEL_AGENT = "agent 发言（不是人类指令）";
export const WAKE_LABEL_SELF = "本机自己发出的消息（不是远程指挥，不需要回应）";

/**
 * Who authored this message, as far as the wake rule may rely on?
 *
 *  - `self`  — the author IS this node's own agentId. This covers both the node's
 *              own bot AND the human sitting at this node's browser: the web
 *              client always speaks as the local agent (`client/index.tsx`
 *              "Web chat always speaks as the human at the browser"), so a
 *              browser-originated message carries `from = identity.agentId` with
 *              `human: true`. Neither is a REMOTE order, which is what this
 *              channel exists to deliver.
 *  - `agent` — the author does not claim `human: true`. Every agent/bot send path
 *              in this repo lands here by construction: the `room_send` tool does
 *              not pass `human` (`tools/index.ts`), and the pwsh fallback sends
 *              `human = $false` (`sendFallbackLine`). So no bot message can be
 *              labelled a human order.
 *  - `human` — a REMOTE author that claims `human: true`.
 *
 * Residual ambiguity, stated instead of hidden: for a remote author the wire
 * carries only that claim (§2.1 E6), so a remote agent process that hand-crafts
 * `human:true` over HTTP is indistinguishable from a remote browser human at this
 * layer. Closing that needs an end-to-end provenance field across all four nodes
 * (protocol change), which 0.1.41 deliberately does not ship; `wake.humanClaims`
 * counts the claims so the residual can be measured rather than argued.
 */
export function listenAuthorKind(
  message: { from?: string; human?: boolean },
  selfAgentId?: string,
): ListenAuthorKind {
  if (selfAgentId && message.from === selfAgentId) return "self";
  if (message.human !== true) return "agent";
  return "human";
}

/** Render the label for one author class (single place, so the prompt template
 *  can never drift from the rule again). */
export function wakeKindLabel(kind: ListenAuthorKind): string {
  if (kind === "self") return WAKE_LABEL_SELF;
  if (kind === "agent") return WAKE_LABEL_AGENT;
  return WAKE_LABEL_HUMAN;
}

export interface WakeWatermarkStats {
  /** Rooms currently holding watermark state. */
  rooms: number;
  /** Wakes admitted by the guard (one per wake the caller actually dispatched). */
  woken: number;
  /** Wake candidates refused because their seq was ≤ the room's watermark. */
  skipped: number;
  /** Own-authored candidates refused by the rule layer (logged, never silent). */
  selfAuthored: number;
  /** Remote candidates that claimed `human: true` (the residual measured in the
   *  header comment: a claim this layer cannot verify end to end). */
  humanClaims: number;
  /** Marks refused because the seq was below the watermark. MUST stay 0 — a
   *  climbing value means `seen()` was bypassed. */
  regressed: number;
  /** Times the room cap forced a full reset. */
  roomResets: number;
  maxRooms: number;
}

export class WakeWatermark {
  /** roomId -> highest seq ever woken (monotonically non-decreasing). */
  private readonly high = new Map<string, number>();
  private wokenCount = 0;
  private skippedCount = 0;
  private selfAuthoredCount = 0;
  private humanClaimCount = 0;
  private regressedCount = 0;
  private roomResetCount = 0;

  constructor(
    private readonly maxRooms: number = MAX_WAKE_ROOMS,
    /** Called (at most once per reset — the caller rate-limits it) when the room cap forces a reset. */
    private readonly onRoomCapReset?: (message: string) => void,
  ) {}

  /**
   * Has this `(roomId, seq)` already been woken (or been overtaken by the mark)?
   *
   * @returns true when the caller MUST NOT wake: the seq is at or below the
   *          highest seq this node has ever woken for that room. The watermark is
   *          never lowered and never expires.
   */
  seen(roomId: string, seq: number): boolean {
    // Boundary 1: only real owner-issued seqs. Negative/zero seqs are this node's
    // own optimistic rows and are never recorded nor blocked (mirrors
    // dedupe.ts:93-96).
    if (!Number.isSafeInteger(seq) || seq <= 0) return false;
    const high = this.high.get(roomId);
    if (high === undefined) return false;
    if (seq > high) return false;
    this.skippedCount += 1;
    return true;
  }

  /**
   * Record that this node woke for `(roomId, seq)`.
   *
   * @returns true when the watermark advanced. A seq at or below the current
   *          watermark is REFUSED (counted as `regressed`) — upstream owner seqs
   *          are monotonic, so accepting a lower mark would re-open the defect.
   */
  mark(roomId: string, seq: number): boolean {
    if (!Number.isSafeInteger(seq) || seq <= 0) return false;
    let high = this.high.get(roomId);
    if (high === undefined) {
      if (this.high.size >= this.maxRooms) {
        // Boundary 2: a hard room cap, same trade as dedupe.ts: resets are
        // preferred over unbounded growth and cost at most one extra wake/room.
        this.high.clear();
        this.roomResetCount += 1;
        this.onRoomCapReset?.(
          `[agent-room] wake watermark room cap (${this.maxRooms}) reached; watermark reset (roomResets=${this.roomResetCount})`,
        );
        high = undefined;
      }
      this.high.set(roomId, seq);
      this.wokenCount += 1;
      return true;
    }
    if (seq <= high) {
      this.regressedCount += 1;
      return false;
    }
    this.high.set(roomId, seq);
    this.wokenCount += 1;
    return true;
  }

  /** Count one wake candidate the RULE layer refused because this node authored
   *  it. Not a silent drop: the caller logs `skipped seq=X (self-authored)`. */
  noteSelfAuthored(): void {
    this.selfAuthoredCount += 1;
  }

  /** Count one remote candidate that claimed `human: true` (see the header). */
  noteHumanClaim(): void {
    this.humanClaimCount += 1;
  }

  /** Drop one room's watermark (leaving the room — mirrors `DeliveryDedupe.forget`). */
  forget(roomId: string): void {
    this.high.delete(roomId);
  }

  /** Highest seq ever woken in one room (diagnostics/tests). */
  watermark(roomId: string): number | undefined {
    return this.high.get(roomId);
  }

  /** Numeric diagnostics only (never a per-frame record). */
  stats(): WakeWatermarkStats {
    return {
      rooms: this.high.size,
      woken: this.wokenCount,
      skipped: this.skippedCount,
      selfAuthored: this.selfAuthoredCount,
      humanClaims: this.humanClaimCount,
      regressed: this.regressedCount,
      roomResets: this.roomResetCount,
      maxRooms: this.maxRooms,
    };
  }
}
