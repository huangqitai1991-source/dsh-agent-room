/**
 * dsh-agent-room 0.1.39 — the bounded delivery-dedupe ring itself.
 *
 * `DeliveryDedupe` is the structure behind the single emission point
 * (`AgentRoomService`'s roomService bus listener): the same `(roomId, seq)` is
 * processed once, and the structure can never grow without bound.
 *
 * Bound derivation (card ②′ v2 §4.4, measured, not guessed):
 *   4096 seqs/room — the owner's authoritative store (2,361 rows / 27.494 h)
 *   showed 30 frames/s peak, 113/10 s, 918/300 s, busiest minute 278. The earlier
 *   512 was shown to be SMALLER than one measured 5-minute burst (918) and only
 *   ~110 s at the busiest-minute rate, so it evicted seqs that were still
 *   legitimately in flight and re-pushed them.
 *   128 rooms — 64× the measured room count (2), and 128 × 4096 × 26.27 B
 *   (measured heap per entry) ≈ 13.8 MB worst case.
 * Everything here is pure in-process state; no DSH service is started or contacted.
 */

import assert from "node:assert";
import { test } from "node:test";
import {
  DeliveryDedupe,
  MAX_DEDUPE_ROOMS,
  MAX_DEDUPE_SEQS_PER_ROOM,
} from "../lib/host/dedupe.js";

const ROOM = "01a098a2-2015-7a1d-b5f7-9eca45afa65d";

test("the same (roomId, seq) is a duplicate; a new seq is not", () => {
  const dedupe = new DeliveryDedupe();
  assert.strictEqual(dedupe.seen(ROOM, 2335), false, "first sighting is a delivery");
  assert.strictEqual(dedupe.seen(ROOM, 2335), true, "the second identical delivery must be dropped");
  assert.strictEqual(dedupe.seen(ROOM, 2336), false, "a different seq is a delivery");
  const stats = dedupe.stats();
  assert.strictEqual(stats.skipped, 1, "exactly one delivery was skipped");
  assert.strictEqual(stats.tracked, 2, "two seqs are tracked");
  assert.strictEqual(stats.evicted, 0, "nothing was evicted");
});

test("distinct seqs are all kept (no false duplicates)", () => {
  const dedupe = new DeliveryDedupe();
  const count = MAX_DEDUPE_SEQS_PER_ROOM;
  for (let seq = 1; seq <= count; seq += 1) {
    assert.strictEqual(dedupe.seen(ROOM, seq), false, `seq ${seq} must be a fresh delivery`);
  }
  const stats = dedupe.stats();
  assert.strictEqual(stats.skipped, 0, "no seq was reported as a duplicate");
  assert.strictEqual(stats.evicted, 0, "a full-but-not-overflowing ring evicts nothing");
  assert.strictEqual(dedupe.roomSize(ROOM), count, "the ring holds exactly its cap");
});

test("the ring is bounded and evicts the OLDEST seq first", () => {
  const dedupe = new DeliveryDedupe(4, MAX_DEDUPE_ROOMS);
  for (const seq of [10, 11, 12, 13]) assert.strictEqual(dedupe.seen(ROOM, seq), false);
  assert.strictEqual(dedupe.seen(ROOM, 14), false, "one past the cap still delivers");
  assert.strictEqual(dedupe.roomSize(ROOM), 4, "the ring never exceeds its cap");
  assert.strictEqual(dedupe.stats().evicted, 1, "exactly one entry was evicted");
  assert.strictEqual(dedupe.seen(ROOM, 13), true, "the newest entries are still remembered");
  // The evicted (oldest) seq is forgotten, so it delivers again instead of being
  // silently swallowed — a ring that is too small shows up as evictions, not as
  // a false "duplicate".
  assert.strictEqual(dedupe.seen(ROOM, 10), false, "the evicted oldest seq is deliverable again");
  assert.strictEqual(dedupe.stats().evicted, 2, "the eviction is counted");
});

test("non-positive seqs are never recorded (local optimistic rows are not deduped)", () => {
  const dedupe = new DeliveryDedupe(4, MAX_DEDUPE_ROOMS);
  for (const seq of [-1, -2, 0, Number.NaN]) {
    assert.strictEqual(dedupe.seen(ROOM, seq), false, `seq ${seq} is not a dedupe candidate`);
    assert.strictEqual(dedupe.seen(ROOM, seq), false, `seq ${seq} must never become a duplicate`);
  }
  assert.strictEqual(dedupe.roomSize(ROOM), 0, "nothing was recorded for invalid seqs");
  assert.strictEqual(dedupe.stats().skipped, 0, "nothing was skipped");
});

test("rooms are keyed separately: the same seq in two rooms is two deliveries", () => {
  const dedupe = new DeliveryDedupe();
  assert.strictEqual(dedupe.seen("room-a", 7), false);
  assert.strictEqual(dedupe.seen("room-b", 7), false, "the key is (roomId, seq), not seq alone");
  assert.strictEqual(dedupe.seen("room-a", 7), true);
  assert.strictEqual(dedupe.stats().rooms, 2);
});

test("the room count is capped by a reset (never unbounded growth)", () => {
  const resets = [];
  const dedupe = new DeliveryDedupe(MAX_DEDUPE_SEQS_PER_ROOM, MAX_DEDUPE_ROOMS, (message) => resets.push(message));
  for (let i = 0; i < MAX_DEDUPE_ROOMS; i += 1) {
    assert.strictEqual(dedupe.seen(`room-${i}`, 1), false);
  }
  assert.strictEqual(dedupe.stats().rooms, MAX_DEDUPE_ROOMS, "the cap is reached exactly");
  assert.strictEqual(resets.length, 0, "no reset while inside the cap");
  // Room MAX+1: the structure resets instead of growing.
  assert.strictEqual(dedupe.seen(`room-${MAX_DEDUPE_ROOMS}`, 1), false);
  const stats = dedupe.stats();
  assert.ok(stats.rooms <= MAX_DEDUPE_ROOMS, `rooms must stay capped, got ${stats.rooms}`);
  assert.strictEqual(stats.roomResets, 1, "the reset is counted");
  assert.strictEqual(resets.length, 1, "the caller is told, once, so it can rate-limit its warning");
  assert.ok(
    stats.tracked <= stats.rooms * stats.maxSeqsPerRoom,
    "tracked seqs can never exceed rooms × per-room cap",
  );
});

test("forget(roomId) drops that room's ring only", () => {
  const dedupe = new DeliveryDedupe();
  dedupe.seen("room-a", 1);
  dedupe.seen("room-b", 1);
  dedupe.forget("room-a");
  assert.strictEqual(dedupe.roomSize("room-a"), 0, "the left room holds no ring state");
  assert.strictEqual(dedupe.seen("room-a", 1), false, "and delivers again after a re-join");
  assert.strictEqual(dedupe.seen("room-b", 1), true, "the other room is untouched");
});
