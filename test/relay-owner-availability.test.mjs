/**
 * dsh-agent-room -- THE RELAY'S OWNER-AVAILABILITY SIGNALS (D-49)
 *
 * WHY THIS SUITE EXISTS
 *   A member cannot tell "the room owner is not connected" from "my link is broken": both are a
 *   handshake that never finishes. Measured 2026-09-16 against the production relay:
 *     - one member made 68 relay.join attempts;
 *     - the relay buffered 601 joins for an owner-less room (all of them that same member);
 *     - 1608 handshakes ended as `close code=1000 reason=join timeout` -- and every one of those was
 *       the MEMBER's own 20 s budget expiring, not the relay kicking it.
 *   The relay holds the owner slot, so it knows the difference. It now says so
 *   (`relay.owner-offline` / `relay.owner-online`) and keeps ONE pending join per member.
 *
 * THIS TEST RUNS THE REAL RELAY on a spare port and speaks to it with two real WebSocket clients, so
 * the claim under test is the wire behaviour, not a mock: a buffered join must reach the owner when
 * it returns, and two joins from the same member must NOT be buffered twice.
 *
 * Run directly:  node test/relay-owner-availability.test.mjs     (never `node --test`: EPERM here)
 */

import assert from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RELAY = join(ROOT, "relay", "relay-server.mjs");
const PORT = 19320;
const RUN_DIR = join(ROOT, "test", ".relay-owner-fixtures", String(process.pid));

let failures = 0;
const guarded = (name, fn) =>
  test(name, async (t) => {
    try { await fn(t); } catch (error) { failures += 1; throw error; }
  });

/** A ticket in the format the relay verifies: base64url(payload) + "." + hmacSha256Hex(secret, body). */
function ticket(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${sig}`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startRelay() {
  mkdirSync(RUN_DIR, { recursive: true });
  const log = join(RUN_DIR, `relay-${PORT}.log`);
  const fd = openSync(log, "w");
  const child = spawn(process.execPath, [RELAY, String(PORT)], {
    cwd: ROOT, detached: false, stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  // wait until the port accepts a connection (the log line is not the contract; the socket is)
  for (let i = 0; i < 100; i += 1) {
    const ok = await new Promise((resolve) => {
      const probe = new WebSocket(`ws://127.0.0.1:${PORT}/relay?roomId=probe&role=member&agentId=probe`);
      probe.on("open", () => { probe.close(); resolve(true); });
      probe.on("error", () => resolve(false));
    });
    if (ok) return { child, log };
    await wait(100);
  }
  throw new Error("the relay never accepted a connection");
}

function client(params) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/relay?${new URLSearchParams(params)}`);
  const frames = [];
  ws.on("message", (d) => { try { frames.push(JSON.parse(String(d))); } catch { /* ignore */ } });
  const opened = new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  return {
    ws, frames, opened,
    send: (obj) => ws.send(JSON.stringify(obj)),
    of: (type) => frames.filter((f) => f.type === type),
    closed: new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: String(reason) }))),
  };
}

const ROOM = "01a0feed-0000-7000-8000-000000000049";
const SECRET = "test-secret-d49";
const MEMBER = "01a0feed-0000-7000-8000-0000000000m1".replace("m", "a");
const OWNER = "01a0feed-0000-7000-8000-0000000000w1".replace("w", "b");

guarded("a join into an owner-less room is TOLD why, and the same member is buffered ONCE", async () => {
  assert.ok(existsSync(RELAY), `the relay source must exist at ${RELAY}`);
  const { child, log } = await startRelay();
  try {
    const member = client({ roomId: ROOM, role: "member", agentId: MEMBER });
    await member.opened;

    // three joins while no owner is connected: the member re-asks, exactly as a real client does
    for (let i = 0; i < 3; i += 1) member.send({ type: "relay.join", payload: { agent: { agentId: MEMBER, nickname: "member" } } });
    await wait(400);

    const offline = member.of("relay.owner-offline");
    assert.strictEqual(offline.length, 3, "every join into an owner-less room must be answered with a reason");
    assert.strictEqual(typeof offline[0].payload.retryAfterMs, "number", "and it must say when to ask again");
    assert.ok(offline[0].payload.retryAfterMs > 0);

    // now the owner arrives: the ONE buffered join must be replayed, and the member told it is back
    const owner = client({ roomId: ROOM, role: "owner", agentId: OWNER, secret: SECRET });
    await owner.opened;
    await wait(400);

    const replayed = owner.of("relay.frame");
    assert.strictEqual(replayed.length, 1, `the owner must receive exactly ONE pending join, not ${replayed.length}`);
    assert.strictEqual(replayed[0].frame.type, "relay.join");
    assert.strictEqual(replayed[0].from, MEMBER);
    assert.strictEqual(member.of("relay.owner-online").length, 1, "the waiting member must be told the owner is back");

    const tail = readFileSync(log, "utf8");
    assert.match(tail, /deduped=true/, "the second/third join must be recorded as deduped");
  } finally {
    child.kill();
  }
});

guarded("the handshake completes after the owner returns, and a ticket signed with a WRONG secret is refused", async () => {
  const { child } = await startRelay();
  try {
    const member = client({ roomId: ROOM, role: "member", agentId: MEMBER });
    await member.opened;
    member.send({ type: "relay.join", payload: { agent: { agentId: MEMBER, nickname: "member" } } });
    await wait(200);

    const owner = client({ roomId: ROOM, role: "owner", agentId: OWNER, secret: SECRET });
    await owner.opened;
    await wait(200);

    // the owner answers with a ticket signed by the shared secret -> the member must authenticate
    const good = ticket(SECRET, { roomId: ROOM, agentId: MEMBER, role: "member", exp: Math.floor(Date.now() / 1000) + 60 });
    owner.send({ type: "relay.send", to: MEMBER, frame: { type: "relay.joined", payload: { ok: true, token: "t", ticket: good, snapshot: {} } } });
    await wait(200);
    member.send({ type: "relay.auth", payload: { ticket: good } });
    await wait(300);
    const authed = member.of("relay.authed");
    assert.strictEqual(authed.length, 1);
    assert.strictEqual(authed[0].payload.ok, true, "a correctly signed ticket must authenticate");

    // a second member with a ticket signed by the WRONG secret must be refused outright
    const badMember = client({ roomId: ROOM, role: "member", agentId: MEMBER + "9" });
    await badMember.opened;
    badMember.send({ type: "relay.join", payload: { agent: { agentId: MEMBER + "9" } } });
    await wait(150);
    const bad = ticket("not-the-secret", { roomId: ROOM, agentId: MEMBER + "9", role: "member", exp: Math.floor(Date.now() / 1000) + 60 });
    owner.send({ type: "relay.send", to: MEMBER + "9", frame: { type: "relay.joined", payload: { ok: true, token: "t", ticket: bad, snapshot: {} } } });
    await wait(150);
    badMember.send({ type: "relay.auth", payload: { ticket: bad } });
    const outcome = await Promise.race([badMember.closed, wait(1500).then(() => null)]);
    assert.ok(outcome, "a forged ticket must close the socket, not leave it hanging");
    assert.strictEqual(outcome.code, 4001, `expected 4001, got ${JSON.stringify(outcome)}`);
    assert.match(outcome.reason, /invalid relay token/);
  } finally {
    child.kill();
  }
});

guarded("summary", () => {
  try { rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  assert.strictEqual(failures, 0, `${failures} relay owner-availability case(s) failed`);
});
