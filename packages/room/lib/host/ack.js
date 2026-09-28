/**
 * dsh-agent-room — the ACK plane (0.1.46): a RECEIPT that the dispatch ARRIVED at a
 * machine and was handed to its resident agent.
 *
 * WHY THIS EXISTS (measured on this fleet, 2026-09-15, the day 0.1.45 shipped)
 *
 * 0.1.45 fixed the wake plane: a script message (`human=false`) that NAMES a node now
 * wakes it. That works — verified on C, A, D and B, whose own logs show
 * `listening: woken seq=… rule=mention`. **And that is exactly where the evidence
 * stopped.**
 *
 * The control node then dispatched a meeting call (room seq 4405) that named all four
 * machines. All four logged the wake line; two logged `activate-chat`. **One replied.**
 * The other three produced nothing — and there was NO signal anywhere, in any log, in
 * the room, or in any counter, that could distinguish
 *
 *     "I received this and started on it"   from   "I was activated and nothing happened".
 *
 * Diagnosing which one it was required reading a 142,000-line log by hand. That is the
 * defect this module removes: the absence of a receipt has to be a FACT, not an
 * inference.
 *
 * WHY `woken` WAS NOT ENOUGH (the trap this module exists to close)
 *
 * `wake.wokenByMention` and the sender-side `woken` field are a RULE PREDICTION computed
 * on the sender's own room view (`service.ts` `wakePreviewFor`). They count DISPATCHES,
 * not DELIVERIES: they are identical whether the target processed the message, was
 * offline, had listening OFF, or was in its `listenPending` window. 0.1.45 said this out
 * loud in its own `wake.note`; 0.1.46 turns it into a delivered receipt.
 *
 * WHAT A RECEIPT HERE ACTUALLY PROVES (the honest boundary — stated, not implied)
 *
 * The party that writes the receipt is the TARGET machine, at the ONE boundary this
 * plugin controls: the moment it hands the dispatch to its resident agent
 * (`agent.followup` accepted, `service.ts` `runListenWake`). It therefore proves:
 *
 *     the message reached THIS machine, passed THIS machine's wake rule, and a resident
 *     agent was actually handed it — at <time>.
 *
 * It does NOT prove the model produced a token, and it does NOT prove the work is done.
 * Nothing inside the plugin can observe that (the model runs beyond this boundary), and
 * pretending otherwise would rebuild the exact defect class this release is about:
 * a signal whose scope is narrower than the claim made with it. `ack.note` says so in
 * the returned /state block, in the same style as 0.1.45's `wake.note`.
 *
 * NOISE CONTROL IS PART OF THE DESIGN (not an afterthought)
 *
 * A receipt that floods is worse than no receipt: today's room was already unreadable
 * because long reports flooded it. So a receipt is emitted only when ALL hold:
 *   - the wake passed the rule (mention / human fallback) — never for a denial;
 *   - at most once per `(roomId, seq)` — ever (`AckLedger.allowReceipt`);
 *   - at most one per room per `ACK_RATE_LIMIT_MS` (a burst of dispatches cannot turn
 *     into a burst of lines);
 *   - one line, no prose, no `@` (so it cannot itself wake anyone: it is a
 *     machine frame, `wake.ts` `isAckPlaneFrame`).
 *
 * SENDING MUST NEVER WEDGE THE HANDLING (requirement 6)
 *
 * The receipt is posted AFTER the dispatch happened, fire-and-forget, and every failure
 * is counted (`receiptsFailed`) and logged — never awaited by the wake path, never
 * holding a lock, never blocking a sweep. The resident agent's turn has already started
 * by then; a room write that fails cannot take it back.
 */
/** The receipt tag. ASCII on purpose: it is matched, never translated. */
export const ACK_TAG = "[ack]";
/** The absence tag: posted by a SENDER when a dispatch was not acked in time. */
export const ACK_MISS_TAG = "[ack-miss]";
/**
 * Per-room receipt rate limit. Chosen as ONE ORDER OF MAGNITUDE BELOW the wake plane's
 * own boundary: a wake is at most one per room per ~90 s (30 s sweep + 60 s
 * `listenPending` re-arm, `wake.ts` header), so 2 s cannot suppress a receipt the sweep
 * would legitimately produce back-to-back — while a script that dispatches 10 mentions
 * in 10 s still produces at most 5 lines instead of 10.
 */
export const ACK_RATE_LIMIT_MS = 2_000;
/**
 * How long a sender waits for a receipt before calling it MISSING.
 *
 * WHY 120 s: the receipt costs the target one sweep (≤30 s) plus the room round trip
 * (measured on this fleet: relay exec round trips of 25-45 s, D-16), and the wake path
 * itself can be deferred one whole sweep by `listenPending` (counted as `pendingSkips`).
 * 120 s therefore covers 30 + 30 + RTT with margin — and it is deliberately not longer,
 * because the whole point is to say "nobody picked this up" while it still matters.
 */
export const ACK_WINDOW_MS = 120_000;
/** Rooms remembered before the ack structure resets (same budget as `dedupe.ts`). */
export const MAX_ACK_ROOMS = 128;
/** Acked seqs kept per room. On overflow the ROOM's set is cleared (never unbounded),
 *  costing at most one duplicate receipt per 512 dispatches in that room. */
export const MAX_ACK_SEQS_PER_ROOM = 512;
/** Open sender expectations at once. A dispatch addressed to more than this many targets
 *  is tracked for the first N — exceeding it is counted, never silently dropped. */
export const MAX_ACK_EXPECTATIONS = 200;
/** A receipt longer than this is not one of ours (same family bound as the storm guard). */
export const ACK_RECEIPT_MAX_CHARS = 160;
/**
 * The receipt line. ONE line, no prose, naming THIS machine's own nickname, the seq it
 * acknowledges, and that it has started handling it.
 *
 * `[ack] A 已接手 seq=4405`
 *
 * No `@` anywhere, deliberately: an `@nickname` here would make every receipt a fresh
 * mention of a colleague on four machines — a wake storm manufactured by the very
 * message whose job is to end the silence.
 */
export function formatAckReceipt(input) {
    const who = (input.nickname ?? "").trim() || input.agentId || "?";
    return `${ACK_TAG} ${who} 已接手 seq=${input.seq}`;
}
/**
 * The absence line, posted by the SENDER (an owned room) when a dispatch addressed to a
 * machine produced no receipt inside `ACK_WINDOW_MS`. Rate-limited by the caller: one
 * per `(roomId, seq)`, once.
 *
 * `[ack-miss] seq=4405 未回执：B C (waited 120s)`
 *
 * Same reasoning as the receipt: no `@`, one line, machine frame — it must be visible
 * without waking anybody.
 */
export function formatAckMiss(input) {
    const who = input.nicknames.length > 0 ? input.nicknames.join(" ") : "?";
    return `${ACK_MISS_TAG} seq=${input.seq} 未回执：${who} (waited ${Math.round(input.waitedMs / 1000)}s)`;
}
/**
 * Is this text an ACK-plane machine frame (a receipt, or an absence notice)?
 *
 * Used by the wake rule (`wake.ts`) to refuse them as `machine-frame`: they are machine
 * chatter, not addressed work, and they must aggregate into ONE log line per sweep
 * instead of consuming the per-message naming budget that real chat denials need.
 */
export function isAckPlaneFrame(text) {
    if (typeof text !== "string")
        return false;
    const t = text.trim();
    if (t.length === 0 || t.length > ACK_RECEIPT_MAX_CHARS)
        return false;
    return t.startsWith(ACK_TAG) || t.startsWith(ACK_MISS_TAG);
}
/** Pull the acknowledged seq out of a receipt line (sender side). */
export function parseAckReceipt(text) {
    if (typeof text !== "string" || !text.trim().startsWith(ACK_TAG))
        return undefined;
    const match = /seq=(\d+)/.exec(text);
    if (!match)
        return undefined;
    const seq = Number(match[1]);
    return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}
/**
 * The ack plane. Pure in-process state: hard caps, per-rule counters, and a bounded
 * memory footprint (one `Set` per room, capped; expectations capped).
 *
 * Deliberately NOT persisted: a receipt is a claim about a LIVE handoff. A restart
 * cannot deliver a receipt for a turn it did not start, and resurrecting old
 * expectations after a restart would manufacture exactly the false assurance this
 * release removes. The consequence is explicit: expectations open at restart time are
 * lost, and the sender's `pendingTargets` therefore starts at 0 on a fresh node.
 */
export class AckLedger {
    maxRooms;
    rateLimitMs;
    windowMs;
    onRoomCapReset;
    /** roomId -> ack state (receiver role). */
    rooms = new Map();
    /** Open sender expectations, in insertion order. */
    expectations = [];
    /** Seqs my OWN receipt notices have been posted for (one `[ack-miss]` per dispatch). */
    missPosted = new Set();
    receiptsPosted = 0;
    receiptsDup = 0;
    receiptsRateLimited = 0;
    receiptsFailed = 0;
    ackedSeqCount = 0;
    maxAckedSeq = 0;
    dispatchCount = 0;
    expectedTargetCount = 0;
    ackedTargetCount = 0;
    unackedTargetCount = 0;
    maxAckedObservedSeq = 0;
    missNoticeCount = 0;
    expectationOverflowCount = 0;
    roomResetCount = 0;
    constructor(maxRooms = MAX_ACK_ROOMS, rateLimitMs = ACK_RATE_LIMIT_MS, windowMs = ACK_WINDOW_MS, 
    /** Called (at most once per reset — the caller rate-limits it) when the room cap
     *  forces a reset, exactly like `WakeWatermark` does. */
    onRoomCapReset) {
        this.maxRooms = maxRooms;
        this.rateLimitMs = rateLimitMs;
        this.windowMs = windowMs;
        this.onRoomCapReset = onRoomCapReset;
    }
    /** Room state, created on demand under the shared cap. */
    room(roomId) {
        const existing = this.rooms.get(roomId);
        if (existing)
            return existing;
        if (this.rooms.size >= this.maxRooms) {
            this.rooms.clear();
            this.roomResetCount += 1;
            this.onRoomCapReset?.(`[agent-room] ack plane room cap (${this.maxRooms}) reached; ack state reset (ack.roomResets=${this.roomResetCount})`);
        }
        const created = { seqs: new Set(), lastPostAt: 0 };
        this.rooms.set(roomId, created);
        return created;
    }
    /**
     * May this node post a receipt for `(roomId, seq)` right now?
     *
     * @returns `"ok"` — post it and then call `noteReceiptPosted`;
     *          `"duplicate"` — this `(roomId, seq)` was already acked (the caller counts
     *          it and posts NOTHING);
     *          `"rate-limited"` — a receipt went out for this room < `rateLimitMs` ago.
     *
     * Order matters: the DUPLICATE test runs before the rate limit, so a repeat of an
     * already-acked seq is always reported as a duplicate (that is the assertion the card
     * makes about "a second wake for the same seq produces no second receipt") instead of
     * being mislabelled as timing.
     */
    allowReceipt(roomId, seq, now = Date.now()) {
        if (!Number.isSafeInteger(seq) || seq <= 0)
            return "rate-limited";
        const state = this.room(roomId);
        if (state.seqs.has(seq)) {
            this.receiptsDup += 1;
            return "duplicate";
        }
        if (now - state.lastPostAt < this.rateLimitMs) {
            this.receiptsRateLimited += 1;
            return "rate-limited";
        }
        return "ok";
    }
    /** Record a receipt that was actually handed to the room send. */
    noteReceiptPosted(roomId, seq, now = Date.now()) {
        const state = this.room(roomId);
        if (state.seqs.size >= MAX_ACK_SEQS_PER_ROOM) {
            state.seqs.clear();
            this.roomResetCount += 1;
            this.onRoomCapReset?.(`[agent-room] ack seq set for ${roomId} reached ${MAX_ACK_SEQS_PER_ROOM}; cleared (bounded memory, costs at most one duplicate receipt)`);
        }
        state.seqs.add(seq);
        state.lastPostAt = now;
        this.receiptsPosted += 1;
        this.ackedSeqCount += 1;
        if (seq > this.maxAckedSeq)
            this.maxAckedSeq = seq;
    }
    /** A receipt the room write refused. Counted — never silent, never retried in place. */
    noteReceiptFailed() {
        this.receiptsFailed += 1;
    }
    /**
     * Register a dispatch THIS node posted and whom the rule predicted it addresses.
     * Called only when at least one target exists (an unaddressed post has nothing to
     * receipt). A dispatch with no owner-assigned seq yet (a queued frame with a negative
     * local seq) is NOT trackable and is therefore not registered — honestly, rather than
     * opened with a seq that can never match a receipt.
     */
    expect(roomId, seq, targets, now = Date.now()) {
        if (!Number.isSafeInteger(seq) || seq <= 0 || targets.length === 0)
            return false;
        if (this.expectations.length >= MAX_ACK_EXPECTATIONS) {
            this.expectationOverflowCount += 1;
            return false;
        }
        const map = new Map();
        for (const target of targets)
            map.set(target.agentId, { nickname: target.nickname ?? target.agentId, acked: false });
        this.expectations.push({ roomId, seq, targets: map, openedAt: now, expired: false });
        this.dispatchCount += 1;
        this.expectedTargetCount += map.size;
        return true;
    }
    /**
     * Look for receipts in the messages this node can read for a room.
     *
     * Matching is on `from` = the target's agentId (the owner stores the acking node's own
     * identity, so this is authoritative) plus the seq inside the receipt text. Returns the
     * targets that just became acked, so the caller can log the transition.
     */
    observe(roomId, messages) {
        const fresh = [];
        for (const expectation of this.expectations) {
            if (expectation.roomId !== roomId || expectation.expired)
                continue;
            for (const [agentId, target] of expectation.targets) {
                if (target.acked)
                    continue;
                const hit = messages.find((m) => m.from === agentId && parseAckReceipt(m.text) === expectation.seq);
                if (!hit)
                    continue;
                target.acked = true;
                this.ackedTargetCount += 1;
                if (expectation.seq > this.maxAckedObservedSeq)
                    this.maxAckedObservedSeq = expectation.seq;
                fresh.push(agentId);
            }
        }
        return fresh;
    }
    /**
     * Close every expectation past its deadline. Returns the dispatches whose targets are
     * still missing a receipt — the caller posts ONE rate-limited line about each, once.
     *
     * An expectation closes when BOTH hold: its window elapsed AND no target is pending.
     * (A partially-acked dispatch is reported as incomplete, which is the honest reading:
     * three of four machines answered nothing today.)
     */
    expire(now = Date.now()) {
        const overdue = [];
        for (const expectation of this.expectations) {
            if (expectation.expired)
                continue;
            const waited = now - expectation.openedAt;
            if (waited < this.windowMs)
                continue;
            expectation.expired = true;
            const missing = [...expectation.targets.entries()].filter(([, t]) => !t.acked);
            if (missing.length === 0)
                continue;
            this.unackedTargetCount += missing.length;
            overdue.push({
                roomId: expectation.roomId,
                seq: expectation.seq,
                nicknames: missing.map(([, t]) => t.nickname),
                waitedMs: waited,
            });
        }
        // Bound the array: closed expectations are dropped instead of accumulating forever.
        for (let i = this.expectations.length - 1; i >= 0; i -= 1) {
            if (this.expectations[i].expired)
                this.expectations.splice(i, 1);
        }
        return overdue;
    }
    /** Has this node already posted an absence notice for `(roomId, seq)`? */
    needMissNotice(roomId, seq) {
        return !this.missPosted.has(roomId + ":" + seq);
    }
    /** Record that the absence notice for `(roomId, seq)` was posted. */
    noteMissPosted(roomId, seq) {
        // Bounded like every other structure here: the notices are per dispatch and the
        // dedupe is only needed while an expectation is open, so the set is capped.
        if (this.missPosted.size >= MAX_ACK_EXPECTATIONS * 4)
            this.missPosted.clear();
        this.missPosted.add(roomId + ":" + seq);
        this.missNoticeCount += 1;
    }
    /** Rooms with open sender expectations (so the sweep knows where to look). */
    expectedRooms() {
        return [...new Set(this.expectations.filter((e) => !e.expired).map((e) => e.roomId))];
    }
    /** Drop one room's ack state (leaving the room — mirrors `DeliveryDedupe.forget`). */
    forget(roomId) {
        this.rooms.delete(roomId);
        for (let i = this.expectations.length - 1; i >= 0; i -= 1) {
            if (this.expectations[i].roomId === roomId)
                this.expectations.splice(i, 1);
        }
    }
    /** Numeric diagnostics only (never a per-frame record). */
    stats() {
        let pending = 0;
        for (const expectation of this.expectations) {
            if (expectation.expired)
                continue;
            for (const target of expectation.targets.values())
                if (!target.acked)
                    pending += 1;
        }
        return {
            rooms: this.rooms.size,
            receiptsPosted: this.receiptsPosted,
            receiptsDup: this.receiptsDup,
            receiptsRateLimited: this.receiptsRateLimited,
            receiptsFailed: this.receiptsFailed,
            ackedSeqs: this.ackedSeqCount,
            maxAckedSeq: this.maxAckedSeq,
            dispatches: this.dispatchCount,
            expectedTargets: this.expectedTargetCount,
            ackedTargets: this.ackedTargetCount,
            unackedTargets: this.unackedTargetCount,
            pendingTargets: pending,
            maxAckedObservedSeq: this.maxAckedObservedSeq,
            missNotices: this.missNoticeCount,
            expectationOverflows: this.expectationOverflowCount,
            roomResets: this.roomResetCount,
            maxRooms: this.maxRooms,
            rateLimitMs: this.rateLimitMs,
            windowMs: this.windowMs,
        };
    }
}
