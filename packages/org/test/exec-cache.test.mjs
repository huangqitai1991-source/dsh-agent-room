/**
 * dsh-agent-org 0.2.10 — idempotent exec results and verified delivery.
 *
 * Acceptance target (domain defect 4, measured 667,621 `skipped(replay)` lines
 * against 1,367 executions): ANY number of deliveries of the same instruction id
 * must produce the SAME result content, with exactly ONE real execution — and a
 * delivery must never be swallowed without an answer, which is what left the
 * sender waiting out its own controller timeout.
 *
 * These tests drive the real ExecPlane (the module OrgService delegates to), not
 * a re-implementation, so the guarantee under test is the shipped one.
 */

import assert from "node:assert";
import { test } from "node:test";
import { ExecResultCache, executeOnce } from "../src/host/exec-cache.js";
import { ExecPlane, isPendingResult } from "../src/host/exec-plane.js";
import { decodeExecResult, encodeExec, encodeExecResult, stillExecutingResult } from "../src/host/exec.js";
import { deliveryAccepted, isDeliveryReport, sendWithRetry } from "../src/host/delivery.js";

const TARGET = "node-target";
const OWNER = "node-owner";

/** Build a plane whose "command" is a counter, so executions are countable. */
function makePlane({ command = async () => ({ ok: true, code: 0, stdout: "done", stderr: "", timedOut: false }) } = {}) {
  const state = { executions: 0, sent: [] };
  const plane = new ExecPlane({
    identityAgentId: async () => TARGET,
    roleOf: (agentId) => (agentId === OWNER ? "owner" : "member"),
    canExec: (actor) => ({ allowed: actor === OWNER, role: actor === OWNER ? "owner" : "member", reason: "test stub (target-aware authz covered by exec-authz.test.mjs)" }),
    send: async (text, meta) => {
      state.sent.push({ text, label: meta?.label });
      return { ok: true, attempts: 1, queued: false, unknown: false };
    },
    run: async (...args) => {
      state.executions += 1;
      return command(...args);
    },
    audit: () => {},
  });
  return { plane, state };
}

const instruction = (id, command = "echo hi") => ({ id, targetAgentId: TARGET, command, ts: "2026-01-01T00:00:00.000Z" });
const from = { from: OWNER };
const resultsOf = (state) => state.sent.filter((entry) => entry.label.startsWith("exec-result:"));

test("the same instruction id three times runs ONCE and answers three identical results", async () => {
  const { plane, state } = makePlane();

  const first = await plane.handleInstruction(instruction("id-1"), from);
  const second = await plane.handleInstruction(instruction("id-1"), from);
  const third = await plane.handleInstruction(instruction("id-1"), from);

  assert.strictEqual(state.executions, 1, "exactly one real execution, however many deliveries");
  assert.strictEqual(first.executed, true);
  assert.strictEqual(second.executed, false);
  assert.strictEqual(third.executed, false);
  assert.strictEqual(first.state, "executed");
  assert.strictEqual(second.state, "executed");
  assert.strictEqual(third.state, "executed");

  // Identical content: same object graph on every delivery.
  assert.deepStrictEqual(second.result, first.result);
  assert.deepStrictEqual(third.result, first.result);
  assert.strictEqual(second.result, first.result, "the cached body is returned as-is, not rebuilt");

  // And every delivery was ANSWERED, not silently dropped.
  const answers = resultsOf(state).map((entry) => decodeExecResult(entry.text));
  assert.strictEqual(answers.length, 3);
  assert.ok(answers.every((answer) => answer && answer.id === "id-1"));

  const bodies = answers.map((answer) => JSON.stringify(answer));
  assert.strictEqual(new Set(bodies).size, 1, "every answer body is byte-identical");
  assert.strictEqual(JSON.parse(bodies[0]).stdout, "done");
});

test("a duplicate while the first run is still executing answers 202, not executed and not an error", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { plane, state } = makePlane({
    command: async () => {
      await gate;
      return { ok: true, code: 0, stdout: "late", stderr: "", timedOut: false };
    },
  });

  const first = plane.handleInstruction(instruction("id-2"), from);
  // Let the first claim the id (it awaits the identity before claiming).
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await plane.handleInstruction(instruction("id-2"), from);

  assert.strictEqual(state.executions, 1, "the duplicate must not start a second execution");
  assert.strictEqual(duplicate.executed, false);
  assert.strictEqual(duplicate.state, "executing");
  assert.strictEqual(duplicate.result.pending, true);
  assert.strictEqual(duplicate.result.status, 202);
  assert.strictEqual(duplicate.result.ok, false, "not reported as executed");
  assert.strictEqual(duplicate.result.code, null, "not reported as an error either");
  assert.strictEqual(isPendingResult(duplicate.result), true);
  assert.strictEqual(isPendingResult({ status: 200 }), false);

  // The interim answer was still WRITTEN to the room.
  const interim = decodeExecResult(resultsOf(state).at(-1).text);
  assert.strictEqual(interim.pending, true);
  assert.strictEqual(interim.status, 202);

  release();
  const settled = await first;
  assert.strictEqual(settled.executed, true);
  assert.strictEqual(settled.result.stdout, "late");

  // After it settles, later deliveries get the real (identical) result.
  const after = await plane.handleInstruction(instruction("id-2"), from);
  assert.deepStrictEqual(after.result, settled.result);
  assert.strictEqual(state.executions, 1);

  // Three deliveries of the same id, all answered, one execution.
  assert.strictEqual(resultsOf(state).length, 3);
});

test("a failed run is cached too: a replay never turns failure into a different answer", async () => {
  const { plane, state } = makePlane({
    command: async () => ({ ok: false, code: 1, stdout: "", stderr: "boom", timedOut: false, error: "exit 1" }),
  });

  const first = await plane.handleInstruction(instruction("id-3"), from);
  const replay = await plane.handleInstruction(instruction("id-3"), from);

  assert.strictEqual(first.state, "failed");
  assert.strictEqual(replay.state, "failed");
  assert.deepStrictEqual(replay.result, first.result);
  assert.strictEqual(state.executions, 1);
  assert.strictEqual(JSON.parse(resultsOf(state)[1].text.slice("[org:exec:result]".length)).stderr, "boom");
});

test("a rejected sender is cached as failed (403) and still answered on replay", async () => {
  const { plane, state } = makePlane();
  const untrusted = { from: "node-stranger" };

  const first = await plane.handleInstruction(instruction("id-4"), untrusted);
  const replay = await plane.handleInstruction(instruction("id-4"), untrusted);

  assert.strictEqual(state.executions, 0, "an unauthorized instruction never runs");
  assert.strictEqual(first.result.code, 403);
  assert.deepStrictEqual(replay.result, first.result);
  assert.strictEqual(resultsOf(state).length, 2, "both deliveries were answered");
});

test("an instruction addressed to another machine is neither executed nor answered", async () => {
  const { plane, state } = makePlane();
  const outcome = await plane.handleInstruction(
    { id: "id-5", targetAgentId: "node-someone-else", command: "echo hi", ts: "" },
    from,
  );
  assert.strictEqual(outcome.answered, false);
  assert.strictEqual(state.executions, 0);
  assert.strictEqual(state.sent.length, 0);
});

test("the controller ignores the interim 202 and resolves with the real result", async () => {
  const { plane } = makePlane({ command: async () => ({ ok: true, code: 0, stdout: "final", stderr: "", timedOut: false }) });

  const waiting = plane.sendExec(TARGET, "echo hi");
  await new Promise((resolve) => setImmediate(resolve));
  const id = [...plane.pending.keys()][0];
  assert.ok(id, "the controller registered a pending wait");

  // A duplicate of the same instruction was answered 202 by the target; that
  // interim frame must NOT resolve the controller's wait.
  plane.handleResult(stillExecutingResult(id, TARGET));
  assert.strictEqual(plane.pending.has(id), true, "still waiting after the 202");

  plane.handleResult({ id, by: TARGET, ok: true, code: 0, stdout: "final", stderr: "", timedOut: false });
  const result = await waiting;
  assert.strictEqual(result.stdout, "final");
  assert.strictEqual(plane.pending.has(id), false);
});

test("the controller reports an undeliverable instruction instead of waiting 45s", async () => {
  const state = { sent: 0 };
  const plane = new ExecPlane({
    identityAgentId: async () => TARGET,
    roleOf: () => "owner",
    canExec: () => ({ allowed: true, role: "owner", reason: "test stub" }),
    // Every attempt fails: the channel is not open and nothing can be queued.
    send: async () => {
      state.sent += 1;
      return { ok: false, attempts: 1, queued: false, unknown: false, reason: "channel-not-open" };
    },
    run: async () => ({ ok: true }),
    audit: () => {},
  });

  const result = await plane.sendExec(TARGET, "echo hi");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.timedOut, false, "not a timeout: the failure is reported explicitly");
  assert.match(result.error, /not delivered: channel-not-open/);
});

test("executeOnce refuses to re-run a settled or in-flight id", async () => {
  const cache = new ExecResultCache();
  let runs = 0;
  const body = { id: "x", ok: true, stdout: "once" };

  const first = await executeOnce(cache, "x", async () => { runs += 1; return body; });
  const second = await executeOnce(cache, "x", async () => { runs += 1; return { id: "x", ok: true, stdout: "again" }; });

  assert.strictEqual(runs, 1);
  assert.strictEqual(first.executed, true);
  assert.strictEqual(second.executed, false);
  assert.strictEqual(second.result.stdout, "once");
});

test("the cache is bounded by TTL and by LRU without losing in-flight ids", async () => {
  let clock = 0;
  const cache = new ExecResultCache({ limit: 2, ttlMs: 1000, now: () => clock });

  cache.begin("a");
  cache.settle("a", "executed", { id: "a", ok: true });
  cache.begin("b");
  cache.settle("b", "executed", { id: "b", ok: true });
  cache.begin("c");
  cache.settle("c", "executed", { id: "c", ok: true });
  assert.ok(cache.size <= 2, `settled entries stay bounded (size=${cache.size})`);

  // An in-flight entry must survive eviction pressure: dropping it would let a
  // duplicate re-run the command.
  cache.begin("in-flight");
  cache.begin("settle-me");
  cache.settle("settle-me", "executed", { id: "settle-me", ok: true });
  assert.strictEqual(cache.get("in-flight").state, "executing");

  clock = 5000;
  assert.strictEqual(cache.get("in-flight"), undefined, "the TTL eventually releases it");
  assert.strictEqual(cache.begin("a").state, "new", "an expired id may run again");
});

test("sendWithRetry retries with backoff, accepts queued, and reports final failure", async () => {
  const sleeps = [];
  const statuses = [
    { delivered: false, queued: false, reason: "channel-not-open" },
    { delivered: false, queued: false, reason: "channel-not-open" },
    { delivered: true, queued: false },
  ];
  let calls = 0;
  const ok = await sendWithRetry(async () => statuses[calls++], "frame", {
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.attempts, 3);
  assert.deepStrictEqual(sleeps, [250, 500], "bounded exponential backoff");

  // Queued counts as accepted: agent-room owns the replay from here.
  const queued = await sendWithRetry(async () => ({ delivered: false, queued: true, reason: "channel-not-open" }), "frame", {
    sleep: async () => { throw new Error("must not sleep"); },
  });
  assert.strictEqual(queued.ok, true);
  assert.strictEqual(queued.queued, true);

  // Exhausted attempts are reported, never swallowed.
  let attempts = 0;
  const failed = await sendWithRetry(async () => { attempts += 1; return { delivered: false, queued: false, reason: "channel-not-open" }; }, "frame", {
    backoff: [1, 1],
    sleep: async () => {},
  });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.attempts, 3);
  assert.strictEqual(failed.reason, "channel-not-open");

  // A throwing gateway is a failed delivery, not a crash.
  const thrown = await sendWithRetry(async () => { throw new Error("boom"); }, "frame", { backoff: [1], sleep: async () => {} });
  assert.strictEqual(thrown.ok, false);
  assert.match(thrown.reason, /boom/);

  // An old agent-room returns null (no status): accepted-but-unverified, because
  // retrying against a host without the idempotency cache would re-execute.
  const unknown = await sendWithRetry(async () => null, "frame", { sleep: async () => { throw new Error("must not sleep"); } });
  assert.strictEqual(unknown.ok, true);
  assert.strictEqual(unknown.unknown, true);
});

test("delivery status predicates match the 0.1.34 shapes", () => {
  assert.strictEqual(deliveryAccepted({ delivered: true, queued: false }), true);
  assert.strictEqual(deliveryAccepted({ delivered: false, queued: true }), true);
  assert.strictEqual(deliveryAccepted({ delivered: false, queued: false }), false);
  assert.strictEqual(deliveryAccepted({ seq: 12 }), true, "owned-room authoritative write");
  assert.strictEqual(deliveryAccepted(null), false);
  assert.strictEqual(isDeliveryReport({ delivered: false, queued: false }), true);
  assert.strictEqual(isDeliveryReport({ seq: 1 }), false);
  assert.strictEqual(isDeliveryReport(null), false);
});

test("exec frames round-trip through encode/decode with the id intact", () => {
  const instruction1 = { id: "abc", targetAgentId: TARGET, command: "echo 1", ts: "t" };
  const decoded = decodeExecResult(encodeExecResult({ id: "abc", ok: true, stdout: "1" }));
  assert.strictEqual(decoded.id, "abc");
  assert.ok(encodeExec(instruction1).startsWith("[org:exec]"));
  assert.strictEqual(decodeExecResult("[org:snapshot]{}"), null);
});
