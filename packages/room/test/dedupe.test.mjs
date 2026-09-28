/**
 * dsh-agent-room 0.1.39 — delivery-level dedupe: ONE browser push per inbound
 * frame, ZERO for control frames, `noteOwnReply` once per message.
 *
 * THE DEFECT (measured live three times on 0.1.37/0.1.38, `_repro-dup-push.mjs`:
 * seq 2335/2359/2368 each n=2 at the SAME millisecond, control frames n=1):
 * an inbound joined-room frame walked TWO browser emission paths —
 *
 *   path A  client.on("chat")            -> emitBrowser (guarded by isControlFrame)
 *                                        -> roomService.emit("chat", …)   [re-inject]
 *   path B  roomService.on("chat")       -> emitBrowser (NO guard) + noteOwnReply
 *
 * so one ordinary frame reached the browser twice and one `[org:*]` control
 * frame once (the leak), and `noteOwnReply` ran twice per frame.
 *
 * WHAT THIS FILE PROVES
 *   1. end to end, through the PRODUCTION wiring (`gateway.joinRoom` + RoomClient
 *      + PeerServer on 127.0.0.1): an ordinary frame is pushed to the browser
 *      exactly once; a `[org:*]` control frame is pushed zero times, yet still
 *      reaches the local roomService bus (agent-org's exec plane subscribes
 *      there — see dsh-agent-org/src/host/service.js:109-114); `noteOwnReply`
 *      runs exactly once per inbound message.
 *   2. a duplicate delivery of the SAME (roomId, seq) is dropped at that single
 *      emission point (the bounded ring), and the counters move.
 *   3. static guard on src/host/service.ts: exactly ONE `emitBrowser({kind:"chat"}`
 *      site, on the guarded bus listener; the client handler emits nothing itself
 *      and only re-injects.
 *
 * Runs against lib/ (the built artifact), like every other suite: `node build.mjs`
 * first. Everything here is loopback + temp dirs; no DSH service is started,
 * stopped or contacted.
 */

import assert from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { AgentRoomService } from "../lib/host/service.js";
import { RoomService } from "../lib/host/room-service.js";
import { PeerServer } from "../lib/host/peer-server.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OWNER_PORT = 19495;
const MEMBER_PORT = 19496;
const SETTLE_MS = 1_200;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 8_000, step = 25) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(step);
  }
  return false;
};

/** See selfjoin.test.mjs: node:test only sets process.exitCode when the run
 *  completes, and AgentRoomService's rejoin timers can keep the loop alive. */
let failures = 0;
const guarded = (name, fn) =>
  test(name, async (t) => {
    try {
      await fn(t);
    } catch (error) {
      failures += 1;
      throw error;
    }
  });

async function settled(svc) {
  const ok = await waitFor(() => svc.profileTimer != null && svc.listenTimer != null, 8_000);
  assert.ok(ok, "the service's background boot must settle before the test touches it");
  return svc;
}

async function shutdown(svc, orphans = []) {
  if (!svc) return;
  for (const client of svc.clients?.values?.() ?? []) {
    try { client.destroy(); } catch { /* ignore */ }
  }
  for (const orphan of [...orphans, svc.discovery]) {
    try { orphan?.stop?.(); } catch { /* ignore */ }
  }
  try { await svc.peerServer?.stop(); } catch { /* ignore */ }
  for (const timer of [svc.profileTimer, svc.listenTimer]) {
    try { if (timer) clearInterval(timer); } catch { /* ignore */ }
  }
}

guarded("an inbound frame is pushed to the browser ONCE; a control frame NEVER (0.1.39)", async () => {
  const dirs = [];
  const mk = async (tag) => {
    const d = await mkdtemp(join(tmpdir(), `ar-dedupe-${tag}-`));
    dirs.push(d);
    return d;
  };
  const servers = [];
  const orphans = [];
  let svc = null;
  try {
    // ---- owner node: an ordinary RoomService serving the room on loopback ----
    const ownerService = new RoomService({ dataDir: await mk("owner"), onNeedServer: undefined });
    await ownerService.boot();
    const ownerIdentity = await ownerService.ensureIdentity();
    const ownerServer = new PeerServer({ port: OWNER_PORT, service: ownerService, relay: "" });
    servers.push(ownerServer);
    await ownerServer.start();
    const room = await ownerService.createRoom({ title: "dedupe-e2e", type: "persistent" });
    const ownerAddress = `127.0.0.1:${OWNER_PORT}`;

    // ---- member node: a real AgentRoomService that JOINS that room ----
    svc = await settled(
      new AgentRoomService(new Context(), { dataDir: await mk("member"), port: MEMBER_PORT, relay: "" }),
    );
    orphans.push(svc.discovery);
    svc.discovery = { discovered: () => [] };
    await svc.gateway.joinRoom([ownerAddress], { roomId: room.roomId });
    assert.ok(
      await waitFor(() => svc.clients.get(room.roomId)?.connected === true),
      "the member must hold a LIVE client on the owner's room (that is the path that double-pushed)",
    );

    // The browser channel, exactly as web.ts:371 subscribes to it for SSE.
    const pushed = [];
    svc.onBrowserEvent((event) => {
      if (event.kind === "chat") pushed.push(event);
    });
    // What agent-org's exec plane sees (service.js:109-114 subscribes to this bus).
    const busFrames = [];
    svc.roomService.on("chat", (roomId, message) => busFrames.push({ roomId, message }));

    // Count noteOwnReply invocations without touching its body.
    let ownReplyCalls = 0;
    const realNoteOwnReply = svc.noteOwnReply.bind(svc);
    svc.noteOwnReply = (roomId, message) => {
      ownReplyCalls += 1;
      return realNoteOwnReply(roomId, message);
    };

    // ---- 1) an ordinary chat frame ----
    const ordinaryText = "dedupe probe ordinary " + Date.now();
    await ownerService.addChatMessage(room.roomId, ownerIdentity, { text: ordinaryText });
    assert.ok(
      await waitFor(() => pushed.some((e) => e.message.text === ordinaryText), 5_000),
      "the ordinary frame must reach the browser channel at all",
    );
    await wait(SETTLE_MS);

    const ordinary = pushed.filter((e) => e.message.text === ordinaryText);
    assert.strictEqual(
      ordinary.length,
      1,
      `an ordinary inbound frame must be pushed to the browser EXACTLY ONCE, got ${ordinary.length} ` +
        `(2+ = the 0.1.37/0.1.38 double push: direct emit + bus re-emit)`,
    );

    // ---- 2) a `[org:*]` control frame ----
    const controlText = '[org:probe]{"marker":"' + Date.now() + '"}';
    await ownerService.addChatMessage(room.roomId, ownerIdentity, { text: controlText });
    assert.ok(
      await waitFor(() => busFrames.some((f) => f.message.text === controlText), 5_000),
      "the control frame must still reach the local roomService bus (org/exec plane depends on it)",
    );
    await wait(SETTLE_MS);

    const controlPushes = pushed.filter((e) => e.message.text === controlText);
    assert.strictEqual(
      controlPushes.length,
      0,
      `a [org:*] control frame must NEVER be pushed to the browser channel, got ${controlPushes.length} ` +
        `(1 = the leak the card measured: the bus listener had no isControlFrame guard)`,
    );
    assert.strictEqual(
      busFrames.filter((f) => f.message.text === controlText).length,
      1,
      "the bus re-emit (service.ts client chat handler) must survive: it is the exec plane's only inbound source",
    );

    // ---- 3) noteOwnReply exactly once per inbound message (2 frames => 2 calls) ----
    assert.strictEqual(
      ownReplyCalls,
      2,
      `noteOwnReply must run EXACTLY ONCE per inbound message, got ${ownReplyCalls} for 2 frames ` +
        `(4 = the double call sites the card counted: hub listener + client handler)`,
    );

    // ---- 4) delivery-level dedupe: the SAME (roomId, seq) must be processed once ----
    const inbound = busFrames.find((f) => f.message.text === ordinaryText).message;
    const before = pushed.length;
    svc.roomService.emit("chat", room.roomId, inbound); // a retransmit / replay of the same frame
    await wait(SETTLE_MS);
    assert.strictEqual(
      pushed.length,
      before,
      `a repeated (roomId, seq=${inbound.seq}) must NOT be pushed again (dedupe ring at the emission point)`,
    );
    const stats = svc.dedupe.stats();
    assert.ok(stats.skipped >= 1, `the dedupe ring must count the dropped duplicate, got skipped=${stats.skipped}`);
  } finally {
    await shutdown(svc, orphans);
    for (const s of servers) { try { await s.stop(); } catch { /* ignore */ } }
    for (const d of dirs) { try { await rm(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
});

guarded("source guard: one chat emission point, guarded, on the bus listener; the client handler only re-injects", () => {
  const srcFile = join(ROOT, "src", "host", "service.ts");
  const src = readFileSync(srcFile, "utf8");

  const emits = [...src.matchAll(/emitBrowser\(\{ kind: "chat"/g)];
  assert.strictEqual(
    emits.length,
    1,
    `service.ts must have EXACTLY ONE emitBrowser({kind:"chat"}) site (the unique outlet), found ${emits.length}`,
  );

  const hubStart = src.indexOf('this.roomService.on("chat"');
  const hubEnd = src.indexOf('this.roomService.on("task"');
  const emitAt = emits[0].index;
  assert.ok(hubStart >= 0 && hubEnd > hubStart, "the bus listener for chat must exist");
  assert.ok(
    emitAt > hubStart && emitAt < hubEnd,
    "the single chat emission point must sit ON the bus listener (the surviving path)",
  );

  const emitLine = src.slice(src.lastIndexOf("\n", emitAt) + 1, src.indexOf("\n", emitAt));
  assert.match(
    emitLine,
    /isControlFrame/,
    `the surviving emission must carry the [org:*] control-frame filter, got: ${emitLine.trim()}`,
  );

  // The client handler: no direct emit, no second noteOwnReply, bus re-emit kept.
  const handlerStart = src.indexOf('client.on("chat"');
  const handlerEnd = src.indexOf('client.on("task"');
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, "the client chat handler must exist");
  const handler = src.slice(handlerStart, handlerEnd);
  assert.ok(
    !handler.includes("this.emitBrowser("),
    "the client chat handler must NOT emit to the browser itself (that was path A of the double push)",
  );
  assert.ok(
    !handler.includes("this.noteOwnReply("),
    "the client chat handler must NOT call noteOwnReply (that was the second call site)",
  );
  assert.strictEqual(
    [...handler.matchAll(/roomService\.emit\("chat"/g)].length,
    1,
    "the client chat handler must still re-inject the frame into the local bus exactly once (:1201/0.1.39 equivalent)",
  );

  assert.strictEqual(
    [...src.matchAll(/this\.noteOwnReply\(/g)].length,
    1,
    "noteOwnReply must have exactly one call site (the bus listener)",
  );

  // 4.3 of the card: the join race was tested and did NOT reproduce — no in-flight lock.
  assert.ok(
    !/\bjoining\b/.test(src) && !/joinInFlight/.test(src),
    "no join in-flight lock may be added (the card measured the race as not reproducible)",
  );
});

const watchdog = setTimeout(() => process.exit(failures > 0 ? 1 : 0), 20_000);
watchdog.unref();
