/**
 * exec-channel-not-open.test.mjs -- card-16, the half that can be proven without a network:
 * a frame that agent-room QUEUED has not been sent, so the sender must NOT wait for an answer.
 *
 * The defect (measured 2026-09-16): a node left and rejoined its room, which tears the agent-org
 * subscription to the sync room. agent-org then handed exec instructions to agent-room, which
 * queued them for replay ({ok:true, queued:true}) -- and because the exec plane only failed fast on
 * `ok:false`, every exec cost the sender a full wait timeout (45 s) of silence. The signature the
 * operator saw was "the target is slow", never "the channel is closed".
 *
 * Run directly:  node test/exec-channel-not-open.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { ExecPlane } from "../src/host/exec-plane.js";

const TARGET = "node-target";
const OWNER = "node-owner";

function makePlane({ send, waitTimeoutMs = 5000 }) {
  return new ExecPlane({
    identityAgentId: async () => OWNER,
    roleOf: (agentId) => (agentId === OWNER ? "owner" : "member"),
    canExec: (actor) => ({ allowed: actor === OWNER, role: actor === OWNER ? "owner" : "member", reason: "test stub (target-aware authz covered by exec-authz.test.mjs)" }),
    send,
    run: async () => ({ ok: true, code: 0, stdout: "", stderr: "", timedOut: false }),
    audit: () => {},
    waitTimeoutMs,
  });
}

test("a queued frame fails fast and says the channel was closed", async () => {
  const seen = [];
  const plane = makePlane({
    send: async (text, meta) => { seen.push({ text, meta }); return { ok: true, attempts: 1, queued: true, unknown: false }; },
  });
  const started = Date.now();
  const result = await plane.sendExec(TARGET, "echo hi");
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false, "a queued instruction is not a delivered one");
  assert.equal(result.queued, true, "the outcome must carry the queued flag, not hide it");
  assert.equal(result.reason, "channel-not-open", "the reason must be nameable by a caller");
  assert.match(result.error, /channel to the sync room is closed/);
  assert.match(result.error, /agent-org-api\/sync/, "the error must say how to repair it");
  assert.equal(result.timedOut, false, "this is a refusal, not a timeout");
  assert.ok(elapsed < 1000, `must fail fast, took ${elapsed} ms of a ${5000} ms wait budget`);
  assert.equal(seen.length, 1, "exactly one send attempt");
});

test("an undelivered frame still fails fast with its own reason (0.2.10 behaviour kept)", async () => {
  const plane = makePlane({ send: async () => ({ ok: false, attempts: 3, queued: false, reason: "socket closed" }) });
  const result = await plane.sendExec(TARGET, "echo hi");
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.reason, "socket closed");
  assert.match(result.error, /not delivered: socket closed/);
});

test("a frame that WAS sent still waits for its answer, and times out if none comes", async () => {
  let answered = null;
  const plane = makePlane({
    send: async (text) => {
      answered = text;
      return { ok: true, attempts: 1, queued: false, unknown: false };
    },
    waitTimeoutMs: 120,
  });
  const started = Date.now();
  const result = await plane.sendExec(TARGET, "echo hi");
  const elapsed = Date.now() - started;

  assert.ok(answered, "the frame must reach the wire");
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true, "a genuinely sent instruction keeps the normal timeout path");
  assert.match(result.error, /timed out waiting for result/);
  assert.ok(elapsed >= 100, `the wait must really have been waited (${elapsed} ms)`);
});

test("queued is only fatal when the write also claimed ok -- ok:false wins on its own reason", async () => {
  const plane = makePlane({ send: async () => ({ ok: false, attempts: 2, queued: true, reason: "no_sync_room" }) });
  const result = await plane.sendExec(TARGET, "echo hi");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_sync_room", "a named delivery reason must not be overwritten by the queued branch");
  assert.match(result.error, /not delivered: no_sync_room/);
});
