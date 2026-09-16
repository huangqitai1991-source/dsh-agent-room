/**
 * dsh-agent-room -- THE OWNER LEASE AND ORDERED TAKEOVER (D-50)
 *
 * WHY THIS SUITE EXISTS
 *   The relay's only rule about authority used to be "whoever presents the right secret takes the
 *   owner slot" (`room.owner.close(4001, "owner replaced")`), with no epoch and no notion of
 *   authority expiring. So a returning owner could always displace whoever had taken over, and two
 *   owners could each believe they were the authority. Measured cost of that design on 2026-09-16:
 *   68 join attempts, 601 buffered joins, 1608 client-side join timeouts against ONE member, all of
 *   them radiating from a room whose owner (a roaming machine) dropped every 74 minutes.
 *
 * THE FOUR RULES THIS SUITE LOCKS DOWN
 *   1. authority expires on its own clock (lease), and expiry does NOT close the owner's socket;
 *   2. a takeover must claim the NEXT epoch, and is refused while the authority is still valid;
 *   3. a returning owner with a STALE epoch is refused and cannot displace the new owner;
 *   4. an old client (no epoch) may reconnect as the CURRENT owner but cannot steal the slot.
 *
 * The timings are overridden through RELAY_LEASE_* env vars so the acceptance runs in seconds instead
 * of the production 45 s TTL -- the production numbers and their sources are in card-14 §C.
 *
 * Run directly:  node test/relay-owner-lease.test.mjs     (never `node --test`: EPERM here)
 */

import assert from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RELAY = join(ROOT, "relay", "relay-server.mjs");
const PORT = 19322;
const RUN_DIR = join(ROOT, "test", ".relay-lease-fixtures", String(process.pid));
const ROOM = "01a0feed-0000-7000-8000-0000000000c3";
const SECRET = "lease-secret-d50";
const OWNER_A = "01a0feed-0000-7000-8000-0000000000d1";
const OWNER_B = "01a0feed-0000-7000-8000-0000000000d2";
const MEMBER = "01a0feed-0000-7000-8000-0000000000d3";

// production is 45s TTL / 5s tick (card-14 §C); the test only needs the ORDER, not the duration
const TTL_MS = 2000;
const TICK_MS = 200;

let failures = 0;
const guarded = (name, fn) =>
  test(name, async (t) => {
    try { await fn(t); } catch (error) { failures += 1; throw error; }
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startRelay() {
  mkdirSync(RUN_DIR, { recursive: true });
  const log = join(RUN_DIR, `relay-${PORT}.log`);
  const fd = openSync(log, "w");
  const child = spawn(process.execPath, [RELAY, String(PORT)], {
    cwd: ROOT, detached: false, stdio: ["ignore", fd, fd],
    env: { ...process.env, RELAY_LEASE_TTL_MS: String(TTL_MS), RELAY_LEASE_TICK_MS: String(TICK_MS) },
  });
  closeSync(fd);
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
  const closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: String(reason) })));
  return {
    ws, frames, opened, closed,
    send: (o) => { try { ws.send(JSON.stringify(o)); } catch { /* ignore */ } },
    of: (type) => frames.filter((f) => f.type === type),
    alive: () => ws.readyState === WebSocket.OPEN,
  };
}

guarded("authority EXPIRES on its own clock, and expiry does not kill the owner's socket", async () => {
  assert.ok(existsSync(RELAY), `relay source missing at ${RELAY}`);
  const { child, log } = await startRelay();
  try {
    const member = client({ roomId: ROOM, role: "member", agentId: MEMBER });
    await member.opened;
    const owner = client({ roomId: ROOM, role: "owner", agentId: OWNER_A, secret: SECRET, epoch: "0" });
    await owner.opened;

    await wait(TTL_MS + TICK_MS * 3);
    const absent = member.of("relay.owner-absent");
    assert.strictEqual(absent.length, 1, `the member must be told the authority lapsed (got ${absent.length})`);
    assert.strictEqual(absent[0].payload.epoch, 0);
    assert.strictEqual(absent[0].payload.ownerAgentId, OWNER_A);
    assert.ok(owner.alive(), "a lapsed lease must NOT close the owner socket: authority and transport are different failures");
    assert.match(readFileSync(log, "utf8"), /owner-absent room=/);
  } finally {
    child.kill();
  }
});

guarded("a takeover claims the NEXT epoch; a claim while authority is valid is refused", async () => {
  const { child } = await startRelay();
  try {
    const member = client({ roomId: ROOM, role: "member", agentId: MEMBER });
    await member.opened;
    const ownerA = client({ roomId: ROOM, role: "owner", agentId: OWNER_A, secret: SECRET, epoch: "0" });
    await ownerA.opened;

    // (1) too early: the lease is still valid, so epoch 1 may not be taken
    const early = client({ roomId: ROOM, role: "owner", agentId: OWNER_B, secret: SECRET, epoch: "1" });
    const earlyOutcome = await Promise.race([early.closed, wait(1500).then(() => null)]);
    assert.ok(earlyOutcome, "an early claim must be refused, not left hanging");
    assert.strictEqual(earlyOutcome.code, 4001);
    assert.match(earlyOutcome.reason, /epoch ahead/);
    assert.ok(ownerA.alive(), "a refused claim must not disturb the current owner");

    // (2) after the lapse, the same claim succeeds
    await wait(TTL_MS + TICK_MS * 3);
    const takeover = client({ roomId: ROOM, role: "owner", agentId: OWNER_B, secret: SECRET, epoch: "1" });
    await takeover.opened;
    const ownerAOutcome = await Promise.race([ownerA.closed, wait(1500).then(() => null)]);
    assert.ok(ownerAOutcome, "the displaced owner must be closed");
    assert.strictEqual(ownerAOutcome.code, 4001);
    assert.match(ownerAOutcome.reason, /owner replaced/);

    const online = member.of("relay.owner-online");
    assert.ok(online.length >= 1, "members must be told the owner came back");
    const changed = online.filter((f) => f.payload.changed === true);
    assert.strictEqual(changed.length, 1, "exactly one owner-online must be marked as a CHANGE of owner");
    assert.strictEqual(changed[0].payload.epoch, 1);
    assert.strictEqual(changed[0].payload.ownerAgentId, OWNER_B);
  } finally {
    child.kill();
  }
});

guarded("SPLIT-BRAIN: the old owner returning with a stale epoch is refused and cannot displace the new one", async () => {
  const { child, log } = await startRelay();
  try {
    const member = client({ roomId: ROOM, role: "member", agentId: MEMBER });
    await member.opened;
    const ownerA = client({ roomId: ROOM, role: "owner", agentId: OWNER_A, secret: SECRET, epoch: "0" });
    await ownerA.opened;
    await wait(TTL_MS + TICK_MS * 3);
    const ownerB = client({ roomId: ROOM, role: "owner", agentId: OWNER_B, secret: SECRET, epoch: "1" });
    await ownerB.opened;

    // the old owner comes back believing it is still epoch 0
    const returning = client({ roomId: ROOM, role: "owner", agentId: OWNER_A, secret: SECRET, epoch: "0" });
    const outcome = await Promise.race([returning.closed, wait(1500).then(() => null)]);
    assert.ok(outcome, "a stale-epoch owner must be refused");
    assert.strictEqual(outcome.code, 4001);
    assert.match(outcome.reason, /stale epoch/);
    assert.ok(ownerB.alive(), "THE POINT OF THE CARD: the new authority must survive the old owner's return");

    // and an old client with NO epoch may not steal the slot either
    const legacy = client({ roomId: ROOM, role: "owner", agentId: OWNER_A, secret: SECRET });
    const legacyOutcome = await Promise.race([legacy.closed, wait(1500).then(() => null)]);
    assert.ok(legacyOutcome, "an epoch-less owner must not silently replace a legitimate owner");
    assert.strictEqual(legacyOutcome.code, 4001);
    assert.match(legacyOutcome.reason, /owner present/);

    // ...but the SAME agent as the current owner may reconnect without an epoch (0.1.49 fleet)
    const sameAgentNoEpoch = client({ roomId: ROOM, role: "owner", agentId: OWNER_B, secret: SECRET });
    await sameAgentNoEpoch.opened;
    await wait(300);
    assert.ok(sameAgentNoEpoch.alive(), "the current owner must be able to reconnect without an epoch");

    const text = readFileSync(log, "utf8");
    assert.match(text, /owner REFUSED \(stale epoch 0 < 1\)/);
    assert.doesNotMatch(text, /owner REFUSED \(stale epoch[^)]*agent=01a0feed-0000-7000-8000-0000000000d2/);
  } finally {
    child.kill();
  }
});

guarded("a wrong secret still cannot take over (the takeover right is the secret, nothing else)", async () => {
  const { child } = await startRelay();
  try {
    const ownerA = client({ roomId: ROOM, role: "owner", agentId: OWNER_A, secret: SECRET, epoch: "0" });
    await ownerA.opened;
    await wait(TTL_MS + TICK_MS * 3);
    const forger = client({ roomId: ROOM, role: "owner", agentId: OWNER_B, secret: "not-the-secret", epoch: "1" });
    const outcome = await Promise.race([forger.closed, wait(1500).then(() => null)]);
    assert.ok(outcome, "a forged secret must be refused");
    assert.strictEqual(outcome.code, 4001);
    assert.match(outcome.reason, /relay secret mismatch/);
    assert.ok(ownerA.alive());
  } finally {
    child.kill();
  }
});

guarded("summary", () => {
  try { rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  assert.strictEqual(failures, 0, `${failures} relay-owner-lease case(s) failed`);
});
