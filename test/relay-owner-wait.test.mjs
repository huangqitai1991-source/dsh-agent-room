/**
 * dsh-agent-room -- THE MEMBER THAT WAITS FOR ITS OWNER (D-49)
 *
 * WHY THIS SUITE EXISTS
 *   Before this change a member facing an absent owner closed its own socket when its 20 s budget
 *   expired and retried from scratch, forever: 68 joins, 601 relay-side buffered joins and 1608
 *   `close code=1000 reason=join timeout` on 2026-09-16, none of which said "the owner is away".
 *   The relay now says so (`relay.owner-offline`), and the client is supposed to hold ONE socket
 *   open through the outage, keep a slow re-ask going, and complete the handshake the moment the
 *   owner returns.
 *
 * THIS TEST DRIVES THE REAL CLIENT against the REAL RELAY on a spare port, with a fake owner on the
 * other end, so what is asserted is wire behaviour: the connect() promise must still be PENDING while
 * the owner is away, and must RESOLVE once the owner comes back and answers.
 *
 * Run directly:  node test/relay-owner-wait.test.mjs     (never `node --test`: EPERM here)
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
const CLIENT = join(ROOT, "lib", "host", "room-client.js");
const PORT = 19321;
const RUN_DIR = join(ROOT, "test", ".relay-owner-wait-fixtures", String(process.pid));
const ROOM = "01a0feed-0000-7000-8000-0000000000aa";
const SECRET = "test-secret-d49-wait";
const OWNER_ID = "01a0feed-0000-7000-8000-0000000000b2";
const MEMBER_ID = "01a0feed-0000-7000-8000-0000000000a2";

let failures = 0;
const guarded = (name, fn) =>
  test(name, async (t) => {
    try { await fn(t); } catch (error) { failures += 1; throw error; }
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ticket(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function startRelay() {
  mkdirSync(RUN_DIR, { recursive: true });
  const log = join(RUN_DIR, `relay-${PORT}.log`);
  const fd = openSync(log, "w");
  const child = spawn(process.execPath, [RELAY, String(PORT)], { cwd: ROOT, detached: false, stdio: ["ignore", fd, fd] });
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

guarded("a member keeps ONE socket and stays connected while the owner is away -- then joins the instant it returns", async () => {
  assert.ok(existsSync(CLIENT), `the built client must exist at ${CLIENT} (run: node build.mjs)`);
  const { RoomClient } = await import(`file://${CLIENT.replace(/\\/g, "/")}`);
  const { child, log } = await startRelay();
  try {
    const client = new RoomClient({
      addresses: ["127.0.0.1:9"],                    // nothing there: force the relay path
      roomId: ROOM,
      relay: `ws://127.0.0.1:${PORT}`,
      agent: { agentId: MEMBER_ID, nickname: "member", capabilities: [], createdAt: new Date().toISOString() },
    });

    let outcome = "pending";
    const connected = client.connect().then(() => { outcome = "resolved"; }, (e) => { outcome = `rejected: ${e?.message ?? e}`; });

    // the relay must have told us the owner is away, and the client must NOT have given up
    await wait(1200);
    const d = client.joinDiagnostics();
    assert.strictEqual(outcome, "pending", `the member must keep waiting, not ${outcome}`);
    assert.strictEqual(d.ownerOnline, false, "the relay's owner-offline notice must be recorded");
    assert.ok(d.ownerOfflineNotices >= 1, `expected at least one owner-offline notice, got ${d.ownerOfflineNotices}`);
    assert.ok(d.waitingForOwnerMs !== null && d.waitingForOwnerMs >= 500, `expected to be visibly waiting, got ${d.waitingForOwnerMs}`);
    assert.match(d.lastFailure?.reason ?? "", /房主不在/, "the recorded reason must name the owner, not the link");

    // the owner arrives and answers with a correctly signed ticket
    const owner = new WebSocket(`ws://127.0.0.1:${PORT}/relay?${new URLSearchParams({ roomId: ROOM, role: "owner", agentId: OWNER_ID, secret: SECRET })}`);
    await new Promise((res, rej) => { owner.on("open", res); owner.on("error", rej); });
    owner.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      const inner = frame.frame ?? frame;
      if (inner?.type !== "relay.join") return;
      const t = ticket(SECRET, { roomId: ROOM, agentId: MEMBER_ID, role: "member", exp: Math.floor(Date.now() / 1000) + 120 });
      owner.send(JSON.stringify({
        type: "relay.send",
        to: MEMBER_ID,
        frame: {
          type: "relay.joined",
          payload: { ok: true, token: "tok", ticket: t, snapshot: { room: { roomId: ROOM, title: "wait-test", type: "persistent", status: "open" } } },
        },
      }));
    });

    await Promise.race([connected, wait(6000)]);
    assert.strictEqual(outcome, "resolved", `the member must join once the owner returns (got ${outcome})`);
    const after = client.joinDiagnostics();
    assert.strictEqual(after.ownerOnline, true, "the owner is online now");
    assert.strictEqual(after.lastFailure, null, "a successful join clears the failure");
    assert.strictEqual(client.connState, "open");

    // and crucially: it never closed and re-raced the handshake during the outage
    const relayLog = readFileSync(log, "utf8");
    assert.doesNotMatch(relayLog, /reason=join timeout/, "no join-timeout close may happen while the owner is merely away");
    client.leave?.();
  } finally {
    child.kill();
  }
});

guarded("summary", () => {
  try { rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  assert.strictEqual(failures, 0, `${failures} relay-owner-wait case(s) failed`);
});
