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
// 0.1.45: the rule needs the SAME control-frame classifier the delivery plane uses
// (`[org:*]`). Reusing it here is what keeps "what is a control frame" one answer:
// protocol.ts owns the definition and is import-free apart from shared types.
import { isControlFrame } from "./protocol.js";
// 0.1.46: the ACK plane's own frames (receipts and absence notices) are machine chatter.
// The classifier lives in `ack.ts` next to the lines it recognises, so the writer and
// the reader of that shape can never drift.
import { isAckPlaneFrame } from "./ack.js";
/** Rooms remembered before the whole structure resets (same budget as dedupe.ts). */
export const MAX_WAKE_ROOMS = 128;
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
export function listenAuthorKind(message, selfAgentId) {
    if (selfAgentId && message.from === selfAgentId)
        return "self";
    if (message.human !== true)
        return "agent";
    return "human";
}
/** Render the label for one author class (single place, so the prompt template
 *  can never drift from the rule again). */
export function wakeKindLabel(kind) {
    if (kind === "self")
        return WAKE_LABEL_SELF;
    if (kind === "agent")
        return WAKE_LABEL_AGENT;
    return WAKE_LABEL_HUMAN;
}
/** Admitted reasons (the ones that wake this node). */
export const WAKE_ADMITTED = ["mention", "human-fallback"];
/**
 * How many room rows one sweep reads (0.1.45, raised from 20 under review).
 *
 * WHY 20 WAS TOO SMALL (C, room seq 3729 — measured, not argued): the sweep runs
 * every 30 s (`service.ts` `setInterval(..., 30_000)`) and only ever sees the rows
 * inside its read window, so any message that falls out of that window between two
 * sweeps is neither woken for nor denied — it is never a candidate at all. With 20
 * rows a normal burst evicts a message before the next sweep: measured on this fleet,
 * an exec storm pushed **152 `[org:*]` frames through the room in ~3 minutes**, i.e.
 * the 20-row window covered **< 30 s — less than one sweep period**.
 *
 * WHY 200: at that measured burst rate (≈50 rows/min) 200 rows cover ≈4 minutes, i.e.
 * 8 sweep periods — enough headroom that a dispatch survives to the next sweep with
 * margin, while the read stays a cheap tail of the room store (`recentMessages`,
 * bounded by the owner's own snapshot size). It is NOT unbounded on purpose: an
 * unbounded catch-up would wake a node for a backlog of old dispatches, which is the
 * storm this plane exists to avoid. The residue (a gap larger than the window) is
 * counted and named by the caller instead of being hidden.
 */
export const WAKE_WINDOW_ROWS = 200;
/** Per-message denial lines per room per sweep; beyond this the denials are counted
 *  (exactly, in `/state.wake`) and named by count. Bus frames are aggregated always —
 *  see `AgentRoomService.logDenials`. */
export const MAX_NAMED_DENIALS_PER_SWEEP = 20;
/**
 * A nickname shorter than this is never matched as a mention: two characters is
 * already the shortest real nickname in this fleet (A/C/B), and a
 * one-character nickname would match inside ordinary prose. The agentId path is
 * always available and has no such weakness.
 */
export const MIN_MENTION_CHARS = 2;
/**
 * A machine's self-test stamp, e.g. `A升 0.1.43 自证` / `XIAOHUANG 0.1.44 verify`
 * / `verify 0.1.44`. These MUST NOT wake anyone: all five nodes run listening, so a
 * stamp that woke its readers would be a wake storm (and it is exactly the family
 * that already took a machine offline once through per-frame amplification —
 * protocol.ts:44-53).
 *
 * The test is deliberately a STAMP test, not a keyword test — a keyword test would
 * swallow real dispatches that merely say the word "verify":
 *   - short (≤ MACHINE_FRAME_MAX_CHARS)   — a report is long, a stamp is not;
 *   - single line                          — stamps carry no body;
 *   - no question mark                     — an ask is not a stamp;
 *   - no request verb (请/麻烦/需要你/帮我…)— a work order is not a stamp;
 *   - must carry a version stamp (x.y.z)   — that is what makes it a self-test;
 *   - and then 自证/自检/self-verify/verify.
 * Measured against the two real dispatches in this room (seq 3693, a multi-line
 * report; seq 3727, a multi-line order): neither matches, by construction.
 */
export const MACHINE_FRAME_MAX_CHARS = 160;
/** True when the text is a machine's own self-test stamp (never wake for one). */
export function isMachineSelfTestFrame(text) {
    if (typeof text !== "string")
        return false;
    const t = text.trim();
    if (t.length === 0 || t.length > MACHINE_FRAME_MAX_CHARS)
        return false;
    if (t.includes("\n"))
        return false;
    if (/[?？]/.test(t))
        return false;
    if (/请|麻烦|需要你|帮我|求/.test(t))
        return false;
    if (!/\d+\.\d+\.\d+/.test(t))
        return false;
    return /自证|自检|self-?verify|verify/i.test(t);
}
/**
 * Does this message NAME this node? Returns the matched token (for the log line) or
 * undefined.
 *
 * Three forms are accepted, all of them things the fleet actually writes:
 *   1. `mentions[]` — the owner resolves nicknames to canonical agentIds when it
 *      stores the message (room-service.ts:625-639), so this holds either form;
 *   2. `@<agentId>` / `@<nickname>` in the text, with the full-width `＠` normalised
 *      (the fleet's dispatch headers are `【A → @总控 …】`-shaped, so the `@` is
 *      matched wherever it sits — inside 【】 and after → included);
 *   3. a bare `<agentId>` anywhere in the text — a 36-char id is unambiguous, and it
 *      makes `@总控（01a0…）` style addressing work.
 *
 * NOT matched, deliberately: a bare nickname in prose ("A说…"). That would fire on
 * every report that merely mentions a colleague, which is the wake-storm shape.
 * Consequence, stated rather than hidden: a ROLE alias that no protocol field carries
 * (`@总控` for a node nicknamed *****) is not resolved. The supported way to be
 * addressable as 总控 is to rename the node (`agent_rename_self`), which is exactly
 * what the rename entry point converges across all three name copies.
 */
export function mentionsThisNode(message, self) {
    const refs = [];
    if (typeof self.agentId === "string" && self.agentId.length >= MIN_MENTION_CHARS)
        refs.push(self.agentId);
    if (typeof self.nickname === "string" && self.nickname.length >= MIN_MENTION_CHARS)
        refs.push(self.nickname);
    if (refs.length === 0)
        return undefined;
    if (Array.isArray(message.mentions)) {
        for (const ref of message.mentions) {
            if (typeof ref !== "string")
                continue;
            const hit = refs.find((candidate) => candidate === ref);
            if (hit)
                return "mentions[]=" + hit;
        }
    }
    const text = typeof message.text === "string" ? message.text.replace(/\uFF20/g, "@") : "";
    if (text.length === 0)
        return undefined;
    for (const ref of refs) {
        if (text.includes("@" + ref))
            return "@" + ref + " in text";
    }
    // Bare agentId only: a nickname without `@` is prose, not an address.
    if (typeof self.agentId === "string" && text.includes(self.agentId))
        return self.agentId + " in text";
    return undefined;
}
/**
 * THE wake rule (0.1.45). Pure, total, and never returns "no reason": every denial
 * carries the rule that denied it, so the caller can log it and count it.
 */
export function decideListenWake(input) {
    const { message, self } = input;
    // 1. card ④ (0.1.41): a node never wakes for its own message — its bot or its
    //    browser (the web client always speaks as the local agent).
    if (listenAuthorKind(message, self.agentId) === "self")
        return { wake: false, reason: "self-authored" };
    // 2. agent-org's `[org:*]` frames are the work-order bus, not chat: the receiving
    //    org acts on every one of them already (protocol.ts:44-53).
    if (isControlFrame(message.text))
        return { wake: false, reason: "control-frame" };
    // 3. the storm guard (see isMachineSelfTestFrame), extended in 0.1.46 to the ACK
    //    plane's own frames: a receipt (`[ack] <me> 已接手 seq=N`) or an absence notice
    //    (`[ack-miss] …`) is machine chatter by construction, is never addressed work, and
    //    — because the receipt deliberately carries no `@` — must simply never wake anyone.
    //    Grouping them under `machine-frame` is what keeps them on the AGGREGATED log path
    //    (one line per rule per sweep) instead of consuming the ≤20/message naming budget
    //    that real chat denials need.
    if (isMachineSelfTestFrame(message.text))
        return { wake: false, reason: "machine-frame" };
    if (isAckPlaneFrame(message.text))
        return { wake: false, reason: "machine-frame", detail: "ack-frame" };
    // 4. THE FIX: a message that names this node wakes it, whatever `human` claims.
    const mention = mentionsThisNode(message, self);
    if (mention)
        return { wake: true, reason: "mention", detail: mention };
    // 5. the 0.1.44 channel, demoted to a fallback so it cannot regress.
    if (message.human === true)
        return { wake: true, reason: "human-fallback", detail: "human:true" };
    // 6. denied — AND the caller logs it. This is the branch that used to be silent.
    return { wake: false, reason: "not-addressed" };
}
export class WakeWatermark {
    maxRooms;
    onRoomCapReset;
    /** roomId -> highest seq ever woken (monotonically non-decreasing). */
    high = new Map();
    wokenCount = 0;
    skippedCount = 0;
    selfAuthoredCount = 0;
    humanClaimCount = 0;
    regressedCount = 0;
    roomResetCount = 0;
    deniedNotAddressedCount = 0;
    deniedControlFrameCount = 0;
    deniedMachineFrameCount = 0;
    wokenByMentionCount = 0;
    wokenByHumanFallbackCount = 0;
    pendingSkipCount = 0;
    seedSkipCount = 0;
    windowGapCount = 0;
    windowGapMessageCount = 0;
    constructor(maxRooms = MAX_WAKE_ROOMS, 
    /** Called (at most once per reset — the caller rate-limits it) when the room cap forces a reset. */
    onRoomCapReset) {
        this.maxRooms = maxRooms;
        this.onRoomCapReset = onRoomCapReset;
    }
    /**
     * Has this `(roomId, seq)` already been woken (or been overtaken by the mark)?
     *
     * @returns true when the caller MUST NOT wake: the seq is at or below the
     *          highest seq this node has ever woken for that room. The watermark is
     *          never lowered and never expires.
     */
    seen(roomId, seq) {
        // Boundary 1: only real owner-issued seqs. Negative/zero seqs are this node's
        // own optimistic rows and are never recorded nor blocked (mirrors
        // dedupe.ts:93-96).
        if (!Number.isSafeInteger(seq) || seq <= 0)
            return false;
        const high = this.high.get(roomId);
        if (high === undefined)
            return false;
        if (seq > high)
            return false;
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
    mark(roomId, seq) {
        if (!Number.isSafeInteger(seq) || seq <= 0)
            return false;
        let high = this.high.get(roomId);
        if (high === undefined) {
            if (this.high.size >= this.maxRooms) {
                // Boundary 2: a hard room cap, same trade as dedupe.ts: resets are
                // preferred over unbounded growth and cost at most one extra wake/room.
                this.high.clear();
                this.roomResetCount += 1;
                this.onRoomCapReset?.(`[agent-room] wake watermark room cap (${this.maxRooms}) reached; watermark reset (roomResets=${this.roomResetCount})`);
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
     *  it. Not a silent drop: the caller logs `denied seq=X (rule=self-authored)`. */
    noteSelfAuthored() {
        this.noteDenied("self-authored");
    }
    /**
     * Count one candidate the RULE layer denied, by reason (0.1.45).
     *
     * Every denial path funnels through here, which is why "no counter moved" can now
     * only mean "no message reached the rule layer" — not "the rule layer dropped it
     * without a trace", which is what the defect was made of.
     */
    noteDenied(reason) {
        if (reason === "self-authored")
            this.selfAuthoredCount += 1;
        else if (reason === "control-frame")
            this.deniedControlFrameCount += 1;
        else if (reason === "machine-frame")
            this.deniedMachineFrameCount += 1;
        else if (reason === "not-addressed")
            this.deniedNotAddressedCount += 1;
        // Admitted reasons are not denials: counting them here would let a caller make
        // "denied" move for a message that was actually woken for.
    }
    /** Count one wake the caller actually DISPATCHED, by the rule that admitted it
     *  (0.1.45). Called next to `mark()`, i.e. only after `agent.followup`. */
    noteWokenBy(reason) {
        if (reason === "mention")
            this.wokenByMentionCount += 1;
        else if (reason === "human-fallback")
            this.wokenByHumanFallbackCount += 1;
    }
    /** Count one sweep skipped while a wake was in flight (0.1.45b). A message that
     *  arrives inside that window is never a candidate — it is not a rule denial. */
    notePendingSkip() {
        this.pendingSkipCount += 1;
    }
    /** Count one cursor seeding (first sweep / re-listen) (0.1.45b). */
    noteSeedSkip() {
        this.seedSkipCount += 1;
    }
    /** Count one sweep that lost messages to the read window, and how many (0.1.45b).
     *  This is the counter that makes "there is no line for my seq" decidable: it is
     *  either a rule denial (denied*) or a window gap (this one) — never nothing. */
    noteWindowGap(messages) {
        this.windowGapCount += 1;
        this.windowGapMessageCount += Number.isSafeInteger(messages) && messages > 0 ? messages : 0;
    }
    /** Count one remote candidate that claimed `human: true` (see the header). */
    noteHumanClaim() {
        this.humanClaimCount += 1;
    }
    /** Drop one room's watermark (leaving the room — mirrors `DeliveryDedupe.forget`). */
    forget(roomId) {
        this.high.delete(roomId);
    }
    /** Highest seq ever woken in one room (diagnostics/tests). */
    watermark(roomId) {
        return this.high.get(roomId);
    }
    /** Numeric diagnostics only (never a per-frame record). */
    stats() {
        return {
            rooms: this.high.size,
            woken: this.wokenCount,
            skipped: this.skippedCount,
            selfAuthored: this.selfAuthoredCount,
            humanClaims: this.humanClaimCount,
            regressed: this.regressedCount,
            roomResets: this.roomResetCount,
            maxRooms: this.maxRooms,
            // 0.1.45: the rule layer's own accounting, one number per outcome.
            deniedNotAddressed: this.deniedNotAddressedCount,
            deniedControlFrame: this.deniedControlFrameCount,
            deniedMachineFrame: this.deniedMachineFrameCount,
            deniedSelfAuthored: this.selfAuthoredCount,
            wokenByMention: this.wokenByMentionCount,
            wokenByHumanFallback: this.wokenByHumanFallbackCount,
            pendingSkips: this.pendingSkipCount,
            seedSkips: this.seedSkipCount,
            windowGaps: this.windowGapCount,
            windowGapMessages: this.windowGapMessageCount,
            windowRows: WAKE_WINDOW_ROWS,
        };
    }
}
