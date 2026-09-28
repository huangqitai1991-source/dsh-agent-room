/**
 * dsh-agent-room 0.1.34 — outbound control-frame queue.
 *
 * Regression target: a frame written while the channel is not OPEN used to
 * vanish with no else branch, so a member's message to the owner's room, and an
 * exec RESULT frame on the way back, were lost without a trace and without a
 * retry. These tests pin the three properties that make the fix real: the queue
 * only holds control frames, overflow rejects the NEW frame (never the oldest
 * in-flight one), and a flush that cannot deliver keeps the rest queued.
 *
 * 0.1.35 updated the `toDeliveryStatus` assertions only: the status gained the
 * honest `acceptedByLocalHub` / `confirmedByOwner` pair, and `delivered` is now a
 * deprecated alias of `acceptedByLocalHub` (kept for dsh-agent-org 0.2.10).
 */

import assert from "node:assert";
import { test } from "node:test";
import {
  MAX_QUEUED_FRAMES,
  OutboundHub,
  OutboundQueue,
  toDeliveryStatus,
} from "../lib/host/outbound.js";
import { RoomClient, buildAgent } from "../lib/host/room-client.js";
import { isControlFrame } from "../lib/host/protocol.js";

/** A fake joined-room channel: `open` decides whether writes succeed. */
function fakeTarget(open) {
  const sent = [];
  const locals = [];
  return {
    sent,
    locals,
    setOpen(value) { this.open = value; },
    open,
    get connected() { return this.open === true; },
    sendChat(input) {
      if (this.open !== true) return false;
      sent.push(input);
      return true;
    },
    appendLocal(input) {
      const message = { seq: -1, from: "me", fromNickname: "me", ts: "now", text: input.text, pending: true };
      locals.push(message);
      return message;
    },
  };
}

test("isControlFrame classifies org frames only", () => {
  assert.strictEqual(isControlFrame("[org:exec]{\"id\":\"1\"}"), true);
  assert.strictEqual(isControlFrame("[org:exec:result]{}"), true);
  assert.strictEqual(isControlFrame("[org:snapshot]{}"), true);
  assert.strictEqual(isControlFrame("hello"), false);
  assert.strictEqual(isControlFrame(undefined), false);
});

test("RoomClient reports a write on a socket that is not OPEN instead of dropping it", () => {
  // No socket at all: this is the state the old code returned `undefined` for
  // while the frame disappeared.
  const client = new RoomClient({ addresses: ["127.0.0.1:9317"], agent: buildAgent() });
  assert.strictEqual(client.connected, false);
  assert.strictEqual(client.sendChat({ text: "[org:exec]{}" }), false);
  assert.strictEqual(client.sendChat({ text: "plain chat" }), false);
});

test("hub queues control frames while the channel is not OPEN", () => {
  const hub = new OutboundHub();
  const target = fakeTarget(false);
  const outcome = hub.send("room-1", { text: "[org:exec]{\"id\":\"e1\"}", human: false }, target);

  assert.strictEqual(outcome.delivered, false);
  assert.strictEqual(outcome.queued, true);
  assert.strictEqual(outcome.reason, "channel-not-open");
  assert.strictEqual(outcome.queueLength, 1);
  assert.strictEqual(hub.peek("room-1").length, 1);
  // The sender still sees its own message (local optimistic append).
  assert.strictEqual(target.locals.length, 1);
  assert.strictEqual(target.sent.length, 0);
});

test("hub does not queue plain chat but still reports the drop", () => {
  const hub = new OutboundHub();
  const target = fakeTarget(false);
  const outcome = hub.send("room-1", { text: "just chatting" }, target);

  assert.strictEqual(outcome.delivered, false);
  assert.strictEqual(outcome.queued, false);
  assert.strictEqual(outcome.reason, "channel-not-open");
  assert.strictEqual(outcome.queueLength, 0, "chat is never queued");
  assert.strictEqual(hub.peek("room-1"), undefined, "no queue is created for droppable chat");
  assert.strictEqual(target.locals.length, 1, "the drop is still visible locally");
});

test("hub delivers directly when the channel is OPEN", () => {
  const hub = new OutboundHub();
  const target = fakeTarget(true);
  const outcome = hub.send("room-1", { text: "[org:exec]{}", human: false }, target);

  // 0.1.35: the honest field is `acceptedByLocalHub`; `delivered` is kept as a
  // deprecated alias for dsh-agent-org 0.2.10. Neither means "the owner stored
  // it" — only `confirmedByOwner` (set by the service once the owner echoes the
  // message back) does, and it starts false/unattempted here.
  assert.deepStrictEqual(toDeliveryStatus(outcome), {
    acceptedByLocalHub: true,
    delivered: true,
    confirmedByOwner: false,
    confirmNote: "not-attempted",
    queued: false,
    reason: undefined,
    queueLength: 0,
  });
  assert.strictEqual(target.sent.length, 1);
  assert.strictEqual(target.locals.length, 0, "a delivered frame gets its authoritative copy from the owner");
});

test("overflow rejects the NEW frame and keeps the oldest in-flight one", () => {
  const queue = new OutboundQueue(3, 1024 * 1024);
  for (let i = 1; i <= 3; i += 1) {
    assert.strictEqual(queue.enqueue({ text: `[org:exec]{"id":"${i}"}` }).queued, true);
  }
  const overflow = queue.enqueue({ text: "[org:exec]{\"id\":\"4\"}" });

  assert.strictEqual(overflow.queued, false, "the new frame is refused, not silently dropped");
  assert.match(overflow.reason, /queue-full\(frames=3\)/);
  assert.strictEqual(queue.length, 3);
  assert.deepStrictEqual(queue.snapshot(), [
    "[org:exec]{\"id\":\"1\"}",
    "[org:exec]{\"id\":\"2\"}",
    "[org:exec]{\"id\":\"3\"}",
  ]);
  assert.strictEqual(queue.rejected, 1);
});

test("overflow also rejects on the byte ceiling", () => {
  const queue = new OutboundQueue(MAX_QUEUED_FRAMES, 120);
  const first = queue.enqueue({ text: "[org:snapshot]" + "x".repeat(60) });
  assert.strictEqual(first.queued, true);
  const second = queue.enqueue({ text: "[org:snapshot]" + "y".repeat(60) });

  assert.strictEqual(second.queued, false);
  assert.match(second.reason, /queue-full\(bytes=120\)/);
  assert.strictEqual(queue.length, 1);
});

test("flush on open delivers everything queued, in order", () => {
  const hub = new OutboundHub();
  const target = fakeTarget(false);
  hub.send("room-1", { text: "[org:exec]{\"id\":\"1\"}", human: false }, target);
  hub.send("room-1", { text: "[org:exec]{\"id\":\"2\"}", human: false }, target);
  hub.send("room-1", { text: "[org:snapshot]{}", human: false }, target);
  assert.strictEqual(hub.peek("room-1").length, 3);

  target.setOpen(true);
  const outcome = hub.flush("room-1", target);

  assert.strictEqual(outcome.delivered, 3);
  assert.strictEqual(outcome.remaining, 0);
  assert.strictEqual(outcome.stopped, false);
  assert.deepStrictEqual(target.sent.map((input) => input.text), [
    "[org:exec]{\"id\":\"1\"}",
    "[org:exec]{\"id\":\"2\"}",
    "[org:snapshot]{}",
  ]);
});

test("a flush that fails mid-way keeps the rest queued (oldest is never dropped)", () => {
  const queue = new OutboundQueue();
  queue.enqueue({ text: "[org:exec]{\"id\":\"1\"}" });
  queue.enqueue({ text: "[org:exec]{\"id\":\"2\"}" });
  queue.enqueue({ text: "[org:exec]{\"id\":\"3\"}" });

  let deliveries = 0;
  const outcome = queue.flush(() => {
    deliveries += 1;
    return deliveries === 1; // channel dies again after the first frame
  });

  assert.strictEqual(outcome.delivered, 1);
  assert.strictEqual(outcome.stopped, true);
  assert.deepStrictEqual(queue.snapshot(), ["[org:exec]{\"id\":\"2\"}", "[org:exec]{\"id\":\"3\"}"]);
});

test("the queue survives a socket/client swap (it is per-room service state)", () => {
  const hub = new OutboundHub();
  const first = fakeTarget(false);
  hub.send("room-1", { text: "[org:exec:result]{\"id\":\"r1\"}", human: false }, first);
  assert.strictEqual(hub.peek("room-1").length, 1);

  // A reconnect replaces the client object entirely; the queue is still there.
  const second = fakeTarget(true);
  const outcome = hub.flush("room-1", second);

  assert.strictEqual(outcome.delivered, 1);
  assert.strictEqual(second.sent[0].text, "[org:exec:result]{\"id\":\"r1\"}");
  assert.strictEqual(first.sent.length, 0, "the dead client was never used");
});
