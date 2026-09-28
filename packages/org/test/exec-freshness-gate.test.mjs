/**
 * 0.2.14 — the freshness gate on the exec plane.
 *
 * Run: node test/exec-freshness-gate.test.mjs   (no dependencies)
 *
 * The rule (measured 2026-09-20): a target whose LOCAL org copy is provably older
 * than the authority's must not hand out rights that a correct copy would refuse
 * (A's copy still carried D as a lead for two days). Only POSITIVE evidence
 * blocks — an idle fleet reports `unknown`, which must NOT be read as a failure.
 */
import assert from "node:assert";
import { test } from "node:test";
import { ExecPlane } from "../src/host/exec-plane.js";

const TARGET = "node-target";
const ACTOR = "node-actor";

function makePlane({ freshness, executed }) {
  return new ExecPlane({
    identityAgentId: async () => TARGET,
    roleOf: () => "owner",
    canExec: () => ({ allowed: true, role: "owner", reason: "test stub: allow" }),
    freshness,
    send: async () => ({ ok: true, attempts: 1, queued: false, unknown: false }),
    run: async () => { executed.count += 1; return { ok: true, code: 0, stdout: "ran", stderr: "", timedOut: false }; },
    audit: () => {},
  });
}

const instruction = (id) => ({ id, targetAgentId: TARGET, command: "echo hi", ts: "2026-09-20T00:00:00.000Z" });
const from = { from: ACTOR };

test("verdict=stale => the instruction is REFUSED with the reason, and nothing runs", async () => {
  const executed = { count: 0 };
  const plane = makePlane({ freshness: () => ({ verdict: "stale", reason: "authority announced a newer tree" }), executed });
  const out = await plane.handleInstruction(instruction("fresh-1"), from);
  assert.strictEqual(executed.count, 0, "the command must not run");
  assert.strictEqual(out.result.ok, false);
  assert.strictEqual(out.result.code, 403);
  assert.match(out.result.error, /stale/);
});

test("verdict=unknown (a quiet fleet) => allowed, the command runs", async () => {
  const executed = { count: 0 };
  const plane = makePlane({ freshness: () => ({ verdict: "unknown", reason: "no peer snapshot seen yet" }), executed });
  const out = await plane.handleInstruction(instruction("fresh-2"), from);
  assert.strictEqual(executed.count, 1);
  assert.strictEqual(out.result.ok, true);
});

test("verdict=fresh => allowed", async () => {
  const executed = { count: 0 };
  const plane = makePlane({ freshness: () => ({ verdict: "fresh", reason: "authority snapshot is not newer" }), executed });
  const out = await plane.handleInstruction(instruction("fresh-3"), from);
  assert.strictEqual(executed.count, 1);
  assert.strictEqual(out.result.ok, true);
});

test("no freshness dep wired => the gate is simply absent (authorization still applies)", async () => {
  const executed = { count: 0 };
  const plane = makePlane({ freshness: undefined, executed });
  const out = await plane.handleInstruction(instruction("fresh-4"), from);
  assert.strictEqual(executed.count, 1);
  assert.strictEqual(out.result.ok, true);
});

test("a refusal is CACHED: replaying the id returns the same 403, not a fresh decision", async () => {
  const executed = { count: 0 };
  let verdict = "stale";
  const plane = makePlane({ freshness: () => ({ verdict, reason: "authority announced a newer tree" }), executed });
  const first = await plane.handleInstruction(instruction("fresh-5"), from);
  verdict = "fresh"; // the world changed between deliveries
  const replay = await plane.handleInstruction(instruction("fresh-5"), from);
  assert.strictEqual(executed.count, 0, "a refused id must never execute on replay");
  assert.strictEqual(replay.result.code, 403);
  assert.strictEqual(replay.result.error, first.result.error, "byte-identical replay");
});
