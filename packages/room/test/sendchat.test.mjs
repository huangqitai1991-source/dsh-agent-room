/**
 * dsh-agent-room 0.1.34 — joined-room send status, staleness classification and
 * self-join address matching.
 *
 * `gateway.sendChat` for a JOINED room used to be:
 *   client.sendChat(input); return null;
 * — no delivery confirmation whatsoever, so a frame dropped on a non-OPEN socket
 * was indistinguishable from success. It now returns a status object, and these
 * tests pin that shape plus the two predicates the cleanup paths depend on.
 *
 * 0.1.35 split the status into `acceptedByLocalHub` (a socket write towards the
 * owner — what the single `delivered` flag always meant) and `confirmedByOwner`
 * (the owner echoed the message back with its own seq, which is the only real
 * proof). See docs/RELEASE-0.1.35.md.
 */

import assert from "node:assert";
import { test } from "node:test";
import { OutboundHub, toDeliveryStatus } from "../lib/host/outbound.js";
import { classifyJoinFailure, normaliseAddress } from "../lib/host/service.js";

/** Minimal stand-in for a RoomClient (structural OutboundTarget). */
function target(connected, ok = true) {
  return {
    connected,
    sent: [],
    locals: [],
    sendChat(input) {
      if (!this.connected || ok === false) return false;
      this.sent.push(input);
      return true;
    },
    appendLocal(input) {
      const message = { seq: -1, from: "me", fromNickname: "me", ts: "now", text: input.text, pending: true };
      this.locals.push(message);
      return message;
    },
  };
}

test("joined-room send returns a delivery status object, never null", () => {
  const hub = new OutboundHub();

  // OPEN channel: accepted by the LOCAL hub. 0.1.35 split this into two honest
  // facts — `acceptedByLocalHub` (a socket write towards the owner) and
  // `confirmedByOwner` (the owner echoed it back with its own seq). `delivered` is
  // a deprecated alias of the former, kept for dsh-agent-org 0.2.10.
  const open = target(true);
  const delivered = toDeliveryStatus(hub.send("room-1", { text: "hi" }, open));
  assert.deepStrictEqual(delivered, {
    acceptedByLocalHub: true,
    delivered: true,
    confirmedByOwner: false,
    confirmNote: "not-attempted",
    queued: false,
    reason: undefined,
    queueLength: 0,
  });
  assert.notStrictEqual(delivered, null);

  // CONNECTING/CLOSED control frame: queued, reported.
  const closed = target(false);
  const queued = toDeliveryStatus(hub.send("room-2", { text: "[org:exec:result]{\"id\":\"1\"}", human: false }, closed));
  assert.deepStrictEqual(queued, {
    acceptedByLocalHub: false,
    delivered: false,
    confirmedByOwner: false,
    confirmNote: "not-attempted",
    queued: true,
    reason: "channel-not-open",
    queueLength: 1,
  });

  // CONNECTING/CLOSED plain chat: dropped, but still reported (caller decides).
  const dropped = toDeliveryStatus(hub.send("room-2", { text: "chat" }, closed));
  assert.deepStrictEqual(dropped, {
    acceptedByLocalHub: false,
    delivered: false,
    confirmedByOwner: false,
    confirmNote: "not-attempted",
    queued: false,
    reason: "channel-not-open",
    queueLength: 1,
  });

  // Full queue: the NEW control frame is rejected with an explicit reason.
  const small = new OutboundHub(1, 512 * 1024);
  small.send("room-3", { text: "[org:exec]{\"id\":\"a\"}", human: false }, closed);
  const rejected = toDeliveryStatus(small.send("room-3", { text: "[org:exec]{\"id\":\"b\"}", human: false }, closed));
  assert.strictEqual(rejected.acceptedByLocalHub, false);
  assert.strictEqual(rejected.queued, false);
  assert.match(rejected.reason, /queue-full\(frames=1\)/);
  assert.strictEqual(rejected.queueLength, 1, "the oldest frame stays queued");
});

test("a throw from the channel is a failed delivery, not a crash", () => {
  const hub = new OutboundHub();
  const throwing = {
    connected: true,
    sendChat() { throw new Error("socket torn down mid-send"); },
    appendLocal(input) { return { seq: -1, text: input.text, pending: true }; },
  };
  const status = toDeliveryStatus(hub.send("room-1", { text: "[org:snapshot]{}", human: false }, throwing));
  assert.strictEqual(status.delivered, false);
  assert.strictEqual(status.queued, true);
});

test("classifyJoinFailure splits gone / refused / transient", () => {
  // Gone: drop the local record immediately (this is the relay-hosted dead room
  // whose record the old `address !== relay` predicate could never prune).
  assert.strictEqual(classifyJoinFailure("join rejected: room-not-found"), "stale");
  assert.strictEqual(classifyJoinFailure("join rejected: room-closed"), "stale");
  assert.strictEqual(classifyJoinFailure("房间不存在: abc"), "stale");
  assert.strictEqual(classifyJoinFailure("房间已关闭"), "stale");
  // Refused: retried with bounded backoff, then dropped.
  assert.strictEqual(classifyJoinFailure("join rejected: wrong-password"), "rejected");
  assert.strictEqual(classifyJoinFailure("join rejected: room-full"), "rejected");
  assert.strictEqual(classifyJoinFailure("relay auth rejected: unauthorized"), "rejected");
  // Transient: the record must be KEPT (the owner may simply be offline).
  assert.strictEqual(classifyJoinFailure("连接超时: 192.168.1.5:9317"), "transient");
  assert.strictEqual(classifyJoinFailure("中继连接中断"), "transient");
  assert.strictEqual(classifyJoinFailure("connect ECONNREFUSED 127.0.0.1:9317"), "transient");
});

test("normaliseAddress matches a record address against our own", () => {
  assert.strictEqual(normaliseAddress("ws://192.168.1.5:9317/"), "192.168.1.5:9317");
  assert.strictEqual(normaliseAddress("  HTTP://192.168.1.5:9317  "), "192.168.1.5:9317");
  assert.strictEqual(normaliseAddress("192.168.1.5:9317"), "192.168.1.5:9317");
  assert.strictEqual(normaliseAddress("ws://relay.example.com:9320/relay"), "relay.example.com:9320");
  assert.strictEqual(normaliseAddress(""), "");
  assert.strictEqual(normaliseAddress(undefined), "");
  assert.notStrictEqual(normaliseAddress("192.168.1.5:9317"), normaliseAddress("192.168.1.6:9317"));
});
