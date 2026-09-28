/**
 * 0.1.53 — `room.state`: the room-level record's carrier, and its two-sided contract.
 *
 * Run: node test/room-state-sync.test.mjs   (no dependencies)
 *
 * The defect this closes (measured 2026-09-20): `controllerAgentId` and `settings`
 * had NO carrier — their mutators emitted only a text `system.event` — so a member's
 * copy stayed frozen at join time. Two member nodes still showed the old controller
 * hours after a transfer, which produced a false "the handover never ran" reading.
 *
 * These cases are the acceptance counterexamples in unit form:
 *   ① a newer rev applies; ② an equal rev is REJECTED; ③ a smaller rev (replay) is
 *   REJECTED; ④ a missing/non-numeric rev is rejected (fail-closed); ⑤ settings
 *   travel and `passwordHash` NEVER does; ⑥ `members` travel with the record.
 */
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildRoomStatePayload, decideRoomStateApply, describeApplyLatency, applyLatencyMs } from "../lib/host/room-state.js";

const ROOM = "01a00000-0000-7000-8000-0000000000aa";
const ME = "01a0231b-bbe5-720a-97a4-819744eeae76";
const TING = "01a09483-3668-7bdf-9cc2-0180f314c8cf";

const room = () => ({
  controllerAgentId: ME,
  settings: { authMode: "open", autoMode: false, maxMembers: 12, allowHumanTakeover: true, passwordHash: "SECRET-SHOULD-NOT-LEAVE" },
  members: [{ agentId: ME, nickname: "*****" }, { agentId: TING, nickname: "DD" }],
});

test("host payload carries the record and NEVER the password hash", () => {
  const p = buildRoomStatePayload(ROOM, room(), 1700);
  assert.strictEqual(p.controllerAgentId, ME);
  assert.strictEqual(p.roomRev, 1700);
  assert.strictEqual(p.settings.authMode, "open");
  assert.strictEqual(p.settings.allowHumanTakeover, true);
  assert.strictEqual("passwordHash" in p.settings, false, "passwordHash must never leave the host");
  assert.strictEqual(JSON.stringify(p).includes("SECRET-SHOULD-NOT-LEAVE"), false);
  assert.strictEqual(p.members.length, 2);
});

test("① a strictly newer rev applies", () => {
  const d = decideRoomStateApply(1000, buildRoomStatePayload(ROOM, room(), 1001));
  assert.strictEqual(d.apply, true);
  assert.strictEqual(d.rev, 1001);
});

test("② an equal rev is rejected (no-op, not a re-apply)", () => {
  const d = decideRoomStateApply(1001, buildRoomStatePayload(ROOM, room(), 1001));
  assert.strictEqual(d.apply, false);
  assert.match(d.reason, /does not advance/);
  assert.strictEqual(d.rev, 1001, "the held rev must not move");
});

test("③ a smaller rev (replayed old frame) is rejected — the record cannot roll back", () => {
  const d = decideRoomStateApply(2000, buildRoomStatePayload(ROOM, room(), 1500));
  assert.strictEqual(d.apply, false);
  assert.strictEqual(d.rev, 2000);
});

test("④ a missing or non-numeric rev is rejected (fail-closed: unreadable is not new)", () => {
  for (const bad of [{}, { roomRev: "abc" }, { roomRev: null }, null, undefined]) {
    const d = decideRoomStateApply(500, bad);
    assert.strictEqual(d.apply, false, JSON.stringify(bad));
    assert.strictEqual(d.rev, 500);
  }
});

test("⑤ the settings half of the record travels (authMode change is visible)", () => {
  const changed = { ...room(), settings: { authMode: "password", autoMode: true, maxMembers: 12, allowHumanTakeover: false } };
  const before = buildRoomStatePayload(ROOM, room(), 100);
  const after = buildRoomStatePayload(ROOM, changed, 200);
  assert.notStrictEqual(before.settings.authMode, after.settings.authMode);
  assert.strictEqual(decideRoomStateApply(100, after).apply, true);
  assert.strictEqual(after.settings.autoMode, true);
});

test("⑥ members travel with the record in the same frame", () => {
  const p = buildRoomStatePayload(ROOM, room(), 300);
  assert.deepStrictEqual(p.members.map((m) => m.agentId), [ME, TING]);
});

test("⑦ the host stamps the frame with its own clock (applyLatency needs it)", () => {
  const p = buildRoomStatePayload(ROOM, room(), 400, 1_700_000_000_000);
  assert.strictEqual(p.hostTs, 1_700_000_000_000);
  assert.strictEqual(typeof p.hostTs, "number");
  // Default path (peer-server calls it with two arguments) must still stamp.
  const live = buildRoomStatePayload(ROOM, room());
  assert.strictEqual(Number.isFinite(live.hostTs), true);
});

test("⑧ a normal apply reports the measured latency", () => {
  assert.strictEqual(describeApplyLatency(1_700_000_000_000, 1_700_000_001_500), "applyLatency=1500ms");
  assert.strictEqual(describeApplyLatency(1000, 1000), "applyLatency=0ms");
});

test("⑨ an unreadable hostTs is `unknown`, NEVER 0ms (judged-unreadable ≠ perfectly fast)", () => {
  for (const bad of [undefined, null, "1700", NaN, Infinity]) {
    const out = describeApplyLatency(bad, 5_000);
    assert.match(out, /applyLatency=unknown/, String(bad));
    assert.strictEqual(/applyLatency=0ms/.test(out), false, String(bad));
  }
  assert.match(describeApplyLatency(1000, NaN), /applyLatency=unknown/);
});

test("⑩ a negative delta is reported as clock skew, NOT clamped to 0", () => {
  // The fleet's nodes are not clock-synchronised: a receiver behind the host
  // measures a negative latency, and clamping it would hide the clock defect.
  const out = describeApplyLatency(2_000, 1_500);
  assert.match(out, /applyLatency=negative\(-500ms/);
  assert.match(out, /NOT clamped/);
});

test("⑪ `/state` and the log read the SAME number (one helper, no drift)", async () => {
  // The reviewer's number (`sync.roomState.lastApply.latencyMs`) and the operator's
  // log line must come from one function; two implementations would eventually
  // disagree, and then neither would be evidence.
  assert.strictEqual(applyLatencyMs(1_000, 3_500), 2_500);
  assert.match(describeApplyLatency(1_000, 3_500), /applyLatency=2500ms/);
  assert.strictEqual(applyLatencyMs(undefined, 3_500), null);
  assert.strictEqual(applyLatencyMs(2_000, 1_500), -500, "clock skew is preserved, not clamped");

  // And the surface that a NON-AUTHOR can read from another machine must actually
  // carry it: pin the wiring in the built client, so removing it fails loudly here
  // instead of silently making latency unverifiable again.
  const src = await readFile(new URL("../src/host/room-client.ts", import.meta.url), "utf8");
  assert.match(src, /roomState: \{ roomRev: this\.roomRev, lastApply: this\.lastRoomStateApply \}/);
  assert.match(src, /this\.logSync\("roomstate"/, "apply lines must not share the 5s `sync` window");
});

test("a member-supplied frame of this type is NOT part of the client→host union", () => {
  // The host half of the contract is enforced structurally: `ClientFrame` has no
  // `room.state` member, and peer-server additionally drops the wire string before
  // any forwarding. This test pins the intent so a future edit cannot add it back
  // without noticing.
  const clientFrameTypes = [
    "chat.send",
    "chat.fetch",
    "chat.stat",
    "task.create",
    "task.claim",
    "task.update",
    "task.comment",
    "room.join",
    "room.leave",
    "relay.join",
  ];
  assert.strictEqual(clientFrameTypes.includes("room.state"), false);
});
