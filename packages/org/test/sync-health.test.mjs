/**
 * sync-health.test.mjs -- card-16, the "can this node be exec'd?" half.
 *
 * Why this exists: `syncReady` is set once, at boot, and never re-evaluated. A node that leaves and
 * rejoins its room has its agent-room channel torn -- org keeps reporting itself ready while every
 * control frame comes back queued, and the only way anyone learned this was a 45 s silence.
 * The health record turns that silence into a readable fact.
 *
 * Run directly:  node test/sync-health.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { createSyncHealth, noteOutbound, noteInbound, syncHealthView, isSyncDegraded } from "../src/host/sync-health.js";

test("a fresh record claims nothing", () => {
  const h = createSyncHealth();
  const v = syncHealthView(h);
  assert.equal(v.lastOutboundOkAt, null, "no successful write may be claimed before one happened");
  assert.equal(v.lastQueuedAt, null);
  assert.equal(v.lastInboundAt, null);
  assert.equal(v.degraded, false, "nothing has failed yet, so nothing is degraded yet");
  assert.equal(isSyncDegraded(h), false);
});

test("a queued write degrades the record and remembers what was queued", () => {
  const h = createSyncHealth();
  noteOutbound(h, { ok: true, queued: true, label: "exec-instruction:abc" }, "2026-09-16T08:00:00.000Z");
  const v = syncHealthView(h);
  assert.equal(v.lastQueuedAt, "2026-09-16T08:00:00.000Z", "the queued moment is the evidence");
  assert.equal(v.lastQueuedLabel, "exec-instruction:abc");
  assert.equal(v.lastOutboundOkAt, null, "a queued frame is NOT a delivered frame");
  assert.equal(v.degraded, true, "queued means the channel was closed: that is degraded");
});

test("a later successful write clears the degradation, not the history", () => {
  const h = createSyncHealth();
  noteOutbound(h, { ok: true, queued: true, label: "snapshot:1" }, "2026-09-16T08:00:00.000Z");
  noteOutbound(h, { ok: true, queued: false, label: "snapshot:2" }, "2026-09-16T08:01:00.000Z");
  const v = syncHealthView(h);
  assert.equal(v.degraded, false, "a proven write means the channel is open again");
  assert.equal(v.lastOutboundOkAt, "2026-09-16T08:01:00.000Z");
  assert.equal(v.lastQueuedAt, "2026-09-16T08:00:00.000Z", "the past failure stays readable");
});

test("a failed write is degraded and its reason is kept", () => {
  const h = createSyncHealth();
  noteOutbound(h, { ok: false, queued: false, reason: "socket closed", label: "snapshot:3" }, "2026-09-16T08:02:00.000Z");
  const v = syncHealthView(h);
  assert.equal(v.degraded, true);
  assert.equal(v.lastErrorReason, "socket closed");
  assert.equal(v.lastErrorAt, "2026-09-16T08:02:00.000Z");
});

test("an inbound frame proves the subscription is alive, and clears an unproven state", () => {
  const h = createSyncHealth();
  noteOutbound(h, { ok: true, queued: true, label: "x" }, "2026-09-16T08:00:00.000Z");
  noteInbound(h, "2026-09-16T08:03:00.000Z", { from: "01a0231b" });
  const v = syncHealthView(h);
  assert.equal(v.lastInboundAt, "2026-09-16T08:03:00.000Z");
  assert.equal(v.lastInboundFrom, "01a0231b");
  assert.equal(v.degraded, false, "a frame that ARRIVED is the strongest evidence the room is readable");
});

test("the view is a copy: callers cannot rewrite the record by holding the object", () => {
  const h = createSyncHealth();
  noteInbound(h, "2026-09-16T08:03:00.000Z", { from: "a" });
  const v = syncHealthView(h);
  v.lastInboundFrom = "tampered";
  assert.equal(syncHealthView(h).lastInboundFrom, "a");
});

test("an unknown delivery outcome does not silently become a success", () => {
  const h = createSyncHealth();
  noteOutbound(h, { ok: true, queued: false, unknown: true, label: "snapshot:4" }, "2026-09-16T08:04:00.000Z");
  const v = syncHealthView(h);
  assert.equal(v.lastOutboundOkAt, null, "an unverified write is not proof of delivery");
  assert.equal(v.unverifiedAt, "2026-09-16T08:04:00.000Z", "unverified must be visible in its own field");
});
