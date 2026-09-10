import assert from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_PORT,
  DISCOVERY_PORT,
  HEARTBEAT_INTERVAL_MS,
  MAX_MESSAGE_LENGTH,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  frameAck,
  frameError,
  reconnectDelay,
  taskStatusTransition,
} from "../lib/host/protocol.js";

/* ---- protocol constants ---- */
test("protocol constants", () => {
  assert.strictEqual(DEFAULT_PORT, 9317);
  assert.strictEqual(DISCOVERY_PORT, 9318);
  assert.strictEqual(HEARTBEAT_INTERVAL_MS, 30_000);
  assert.strictEqual(MAX_MESSAGE_LENGTH, 16 * 1024);
});

/* ---- join/chat ack & error frames ---- */
test("frameAck", () => {
  assert.deepStrictEqual(frameAck(7, true), { type: "ack", payload: { seq: 7, ok: true, error: undefined } });
  assert.deepStrictEqual(frameAck(9, false, "nope"), { type: "ack", payload: { seq: 9, ok: false, error: "nope" } });
});

test("frameError", () => {
  assert.deepStrictEqual(frameError("boom"), { type: "error", payload: { message: "boom" } });
});

/* ---- reconnect backoff ---- */
test("reconnect backoff doubles and caps at 30s", () => {
  assert.strictEqual(reconnectDelay(0), RECONNECT_BASE_MS);
  assert.strictEqual(reconnectDelay(1), 2_000);
  assert.strictEqual(reconnectDelay(2), 4_000);
  assert.strictEqual(reconnectDelay(3), 8_000);
  assert.strictEqual(reconnectDelay(4), 16_000);
  assert.strictEqual(reconnectDelay(5), RECONNECT_MAX_MS);
  assert.strictEqual(reconnectDelay(20), RECONNECT_MAX_MS);
});

/* ---- task lifecycle ---- */
test("task lifecycle: create -> claim -> complete -> approve (controller)", () => {
  assert.strictEqual(taskStatusTransition("create", "", "controller"), "todo");
  assert.strictEqual(taskStatusTransition("claim", "todo", "controller"), "doing");
  assert.strictEqual(taskStatusTransition("complete", "doing", "controller"), "review");
  assert.strictEqual(taskStatusTransition("approve", "review", "controller"), "done");
});

test("task lifecycle: auto mode completes directly to done", () => {
  assert.strictEqual(taskStatusTransition("complete", "doing", "auto"), "done");
});

test("task lifecycle: reject then reopen", () => {
  assert.strictEqual(taskStatusTransition("reject", "review", "controller"), "rejected");
  assert.strictEqual(taskStatusTransition("reopen", "rejected", "controller"), "todo");
});

test("task lifecycle: invalid transitions return null", () => {
  assert.strictEqual(taskStatusTransition("approve", "todo", "controller"), null);
  assert.strictEqual(taskStatusTransition("claim", "done", "controller"), null);
  assert.strictEqual(taskStatusTransition("complete", "review", "controller"), null);
});
