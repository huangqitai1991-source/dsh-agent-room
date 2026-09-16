import assert from "node:assert";
import { test } from "node:test";
import { shouldReassert } from "../src/host/sync-health.js";

test("a queued frame triggers exactly one re-assert", () => {
  const queued = { ok: true, queued: true };
  assert.equal(shouldReassert(queued, 0), true, "the closed-channel case is the one we repair");
  assert.equal(shouldReassert(queued, 1), false, "never a second time: a storm is not a repair");
});

test("a refused or unverified write does not re-assert", () => {
  assert.equal(shouldReassert({ ok: false, reason: "socket closed" }, 0), false);
  assert.equal(shouldReassert({ ok: true, unknown: true }, 0), false);
  assert.equal(shouldReassert({ ok: true, queued: false }, 0), false);
});

test("the attempt budget is explicit and overridable", () => {
  const queued = { ok: true, queued: true };
  assert.equal(shouldReassert(queued, 1, 2), true, "a caller may allow two, on purpose");
  assert.equal(shouldReassert(queued, 2, 2), false);
});