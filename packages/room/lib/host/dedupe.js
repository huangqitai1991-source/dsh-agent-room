/**
 * dsh-agent-room — bounded delivery-level dedupe for inbound chat frames (0.1.39).
 *
 * WHY THIS EXISTS
 *
 * 0.1.39 collapsed the browser push for chat frames to ONE emission point
 * (`AgentRoomService`'s roomService bus listener). The structural double push
 * measured on 0.1.37/0.1.38 is gone with it, but the emission point itself had no
 * convergence rule: the same `(roomId, seq)` reaching it twice (a socket
 * retransmit, a backfill replay, a future second path) was pushed twice. This
 * module is that rule — the delivery boundary processes one `(roomId, seq)` once.
 *
 * WHAT IT IS NOT
 *
 *  - Not execution idempotence: agent-org 0.2.10 already answers a replayed
 *    instruction from its cache (`exec-cache.js` `executeOnce`). This is the
 *    read/delivery plane only.
 *  - Not a replay-flood shield: the archived 25,346-frame flood far exceeds any
 *    sane in-memory ring; that class stays with `backfill.ts`'s seq dedupe.
 *
 * SHAPE (deliberately the same as `outbound.ts`: pure state, hard caps, counters)
 *
 * Per room a FIFO ring of seqs (insertion-ordered `Set`): a repeat is a duplicate,
 * a full ring evicts the OLDEST entry. Rooms are capped too; exceeding the room
 * cap RESETS the whole structure (a reset costs at most one duplicate push per
 * room and can never grow without bound).
 *
 * WHY 4096 / 128 — both from measurement, not taste (card ②′ v2 §4.4)
 *
 *   Frame rates, measured on the owner's authoritative 2,361-row message store
 *   over 27.494 h (mean 0.0239 frames/s, median minute 2 frames):
 *     peak 30/s, 86/5 s, 113/10 s, 300/60 s, busiest 5 minutes 918 frames,
 *     busiest minute 278 frames.
 *   The earlier 512-entry ring covered only ~110 s at the busiest-minute rate
 *   and was SHORTER than one measured 5-minute burst (918) — it would evict seqs
 *   that were still legitimately in flight and re-push them.
 *   Footprint, measured on this machine: 26.27 bytes per entry
 *   (64 rooms × 512 entries = 860,864 B of heap).
 *   ⇒ 4096/room covers the 918-frame burst with 4.5× headroom;
 *     128 rooms × 4096 entries × 26.27 B ≈ 13.8 MB worst case — bounded, and the
 *     same order as the queue caps this repo already accepts.
 *   Invalid seqs (0/negative — local optimistic rows carry NEGATIVE seqs,
 *   `room-client.ts` "Pending rows carry negative seqs") are never recorded, so
 *   dedupe can never eat a row this node just sent locally.
 *
 * COUNTER RULES (from this team's 411 MB audit-log incident: per-frame log lines
 * grew `audit.jsonl` to 411 MB / 1.26M rows): this module keeps COUNTERS ONLY —
 * no per-frame record, no log line per hit. `stats()` is surfaced through
 * `GET /agent-room-api/state` as a numeric diagnostics block. Both counters matter:
 * `skipped` alone would make "the ring is too small so it never hits" look like
 * "there are no duplicates" — hence `evicted` and `roomResets` next to it.
 */
/** Seqs remembered per room (see the derivation above). */
export const MAX_DEDUPE_SEQS_PER_ROOM = 4096;
/** Rooms remembered before the whole structure resets (128 ≈ 64× the measured 2). */
export const MAX_DEDUPE_ROOMS = 128;
export class DeliveryDedupe {
    maxSeqsPerRoom;
    maxRooms;
    onRoomCapReset;
    byRoom = new Map();
    skippedCount = 0;
    evictedCount = 0;
    roomResetCount = 0;
    constructor(maxSeqsPerRoom = MAX_DEDUPE_SEQS_PER_ROOM, maxRooms = MAX_DEDUPE_ROOMS, 
    /** Called (at most once per reset — the caller rate-limits it) when the room cap forces a reset. */
    onRoomCapReset) {
        this.maxSeqsPerRoom = maxSeqsPerRoom;
        this.maxRooms = maxRooms;
        this.onRoomCapReset = onRoomCapReset;
    }
    /**
     * Record one delivery of `(roomId, seq)`.
     *
     * @returns true when this exact `(roomId, seq)` was ALREADY processed — the
     *          caller must drop it, and must not run any per-message side effect.
     */
    seen(roomId, seq) {
        // Boundary 1: only real owner-issued seqs. Negative/zero seqs are this node's
        // own optimistic rows (room-client.ts) and are never deduped.
        if (!Number.isFinite(seq) || seq <= 0)
            return false;
        let ring = this.byRoom.get(roomId);
        if (!ring) {
            if (this.byRoom.size >= this.maxRooms) {
                // Boundary 2: a hard room cap. Resetting is preferred over growing: it
                // costs at most one duplicate push per room and keeps the footprint fixed.
                this.byRoom.clear();
                this.roomResetCount += 1;
                this.onRoomCapReset?.(`[agent-room] delivery dedupe room cap (${this.maxRooms}) reached; ring reset (roomResets=${this.roomResetCount})`);
            }
            ring = new Set();
            this.byRoom.set(roomId, ring);
        }
        if (ring.has(seq)) {
            this.skippedCount += 1;
            return true;
        }
        if (ring.size >= this.maxSeqsPerRoom) {
            // FIFO eviction: the oldest seq is the one the ring can best afford to
            // forget. No per-entry log line — the counter is the diagnostic.
            const oldest = ring.values().next().value;
            if (typeof oldest === "number") {
                ring.delete(oldest);
                this.evictedCount += 1;
            }
        }
        ring.add(seq);
        return false;
    }
    /** Drop one room's ring (leaving the room — mirrors `OutboundHub.drop`). */
    forget(roomId) {
        this.byRoom.delete(roomId);
    }
    /** Numeric diagnostics only (never a per-frame record). */
    stats() {
        let tracked = 0;
        for (const ring of this.byRoom.values())
            tracked += ring.size;
        return {
            rooms: this.byRoom.size,
            tracked,
            skipped: this.skippedCount,
            evicted: this.evictedCount,
            roomResets: this.roomResetCount,
            maxSeqsPerRoom: this.maxSeqsPerRoom,
            maxRooms: this.maxRooms,
        };
    }
    /** Seq count held for one room (diagnostics/tests). */
    roomSize(roomId) {
        return this.byRoom.get(roomId)?.size ?? 0;
    }
}
