import assert from "node:assert";
import { test } from "node:test";
import { trimToByteBudget } from "../lib/host/peer-server.js";

const msg = (seq, text = "x".repeat(40)) => ({ seq, text, nickname: "a", agentId: "b" });

test("trimToByteBudget keeps the newest messages", () => {
  const items = [1, 2, 3, 4, 5].map((n) => msg(n));
  const kept = trimToByteBudget(items, 10_000);
  assert.equal(kept.length, items.length);
  assert.deepEqual(kept.map((m) => m.seq), [1, 2, 3, 4, 5]);
});

test("trimToByteBudget drops oldest messages once the budget is hit", () => {
  // Each message serializes to well over 100 bytes, so only a few fit.
  const items = Array.from({ length: 50 }, (_, i) => msg(i + 1));
  const kept = trimToByteBudget(items, 400);
  assert.ok(kept.length > 0 && kept.length < items.length, `kept ${kept.length}`);
  // The tail must be preserved: the newest message always survives.
  assert.equal(kept[kept.length - 1].seq, 50);
  // No interior gaps — dropping is strictly oldest-first.
  assert.deepEqual(
    kept.map((m) => m.seq),
    Array.from({ length: kept.length }, (_, i) => 50 - kept.length + 1 + i),
  );
  assert.ok(JSON.stringify(kept).length <= 400 + 200, "roughly within budget");
});

test("trimToByteBudget always returns at least the newest item", () => {
  const huge = [{ seq: 1, text: "y".repeat(50_000) }];
  const kept = trimToByteBudget(huge, 128);
  assert.equal(kept.length, 1, "an oversized message is kept whole, never truncated");
  assert.equal(kept[0].text.length, 50_000);
});

test("trimToByteBudget handles an empty history", () => {
  assert.deepEqual(trimToByteBudget([], 1024), []);
});
