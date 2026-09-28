/**
 * dsh-agent-room 0.1.42 — card ⑥ / D-22: `listening` survives a restart, and an
 * explicit OFF stays off.
 *
 * THE DEFECT (measured across two machines, same script, different outcomes)
 *
 *  `listeningRooms` was a bare in-memory `Set` (service.ts), so EVERY process
 *  restart dropped it — an upgrade, a crash and a manual restart are all the same
 *  event to it. The only compensation lived in the upgrade script: an auto-wake
 *  helper that POSTs `{"on":true}` and FAILS SOFT. 主控's upgrade log printed
 *  `AUTO-WAKE: 2 of 2 room(s) re-opened (listening=true); 0 were already on` ✓,
 *  while B read `listening=false` after upgrading to 0.1.40
 *  (`room=0.1.40 org=0.2.12 relay=off joined=YES listening=false bridge=direct/open`)
 *  and had to be rescued through an external exec ✗. A machine silenced this way
 *  never complains — it simply stops receiving room instructions.
 *
 * WHAT THIS FILE PROVES (real owner + real member services, real HTTP route,
 * temp dataDir, one owner room per scenario)
 *   1. the intent is persisted per profile × roomId (dataDir/listening.json) when
 *      the toggle succeeds — and the REAL route is what is driven, not the setter;
 *   2. a restart (a second service on the same dataDir, NO upgrade script) comes
 *      back listening;
 *   3. explicit OFF + restart stays OFF (the reverse assertion);
 *   4. an existing file that lacks the field, or is unreadable, reads as "not
 *      listening" and never errors (backward compatibility);
 *   5. an OWNED room that was listening IS restored (0.1.44 / D-28: the owner of a
 *      room may listen to its own room — 0.1.43 skipped exactly those, so the room
 *      owner came back muted after every restart);
 *   6. an owned room with NO recorded intent is still not listening (nothing is
 *      auto-enabled just because a node owns a room);
 *   7. static guard: the toggle persists, the boot restores, nothing else writes,
 *      and the restore no longer skips owned rooms.
 *
 * Every port is an ephemeral-or-test loopback port inside this process; every
 * dataDir is a temp dir; no service outside this process is touched.
 * Run directly: `node test/listening.test.mjs` (never `node --test`).
 */

import assert from "node:assert";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { AgentRoomService } from "../lib/host/service.js";
import { createRouter } from "../lib/host/web.js";

/**
 * `AR_LIB` points the suite at another build's lib directory (the 0.1.42 gate runs
 * the SAME assertions against the OLD 0.1.41 build, so "the new assertions fail on
 * the old build" is a measurement, not a claim). `AR_SRC` points the static guards
 * at the matching source tree.
 */
const AR_LIB = process.env.AR_LIB;
const libRoot = AR_LIB ? pathToFileURL(join(AR_LIB, "host") + "/").href : null;
const ServiceClass = libRoot ? (await import(libRoot + "service.js")).AgentRoomService : AgentRoomService;
const routerFactory = libRoot ? (await import(libRoot + "web.js")).createRouter : createRouter;

const ROOT = process.env.AR_SRC ? dirname(process.env.AR_SRC) : dirname(dirname(fileURLToPath(import.meta.url)));

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

/**
 * Every node this file starts, so the final sweep can stop it even when a failing
 * assertion skips the rest of a test body. That is not hypothetical: on the 0.1.41
 * comparison build the FIRST assertion of case 1 fails, the remaining statements
 * (including `stopNode(owner)`) never run, and the leaked service keeps the process
 * alive forever — measured as 25 ref'd handles (TCPServerWrap, UDPWrap, Timeout).
 * Per-test `finally` blocks stay where they are (they free ports promptly); this
 * registry is the safety net that makes teardown independent of test outcomes.
 */
const NODES = new Set();

/**
 * `boot()` auto-rejoins every recorded room FIRE-AND-FORGET (`service.ts:1195`
 * `void this.autoRejoinJoinedRooms()`), and `startNode` returns as soon as the two
 * interval timers exist — i.e. before that join has even opened its socket. Waiting
 * for each recorded room to have a registered client is what makes `stopNode`
 * deterministic: without it the teardown scan ran first, the client appeared a few
 * hundred ms later, and its `scheduleReconnect` timer then re-armed every 8 s
 * FOREVER (measured: attempt=7 and climbing), which is exactly what kept this suite
 * alive past its last assertion.
 */
async function settleBootRejoin(svc, dir, budgetMs = 8_000) {
  let records = [];
  try {
    const parsed = JSON.parse(await readFile(join(dir, "joined.json"), "utf8"));
    records = Array.isArray(parsed) ? parsed : [];
  } catch {
    records = []; // nothing recorded: nothing to rejoin, nothing to wait for
  }
  const wanted = records.map((r) => r?.roomId).filter((roomId) => typeof roomId === "string");
  const end = Date.now() + budgetMs;
  while (Date.now() < end && wanted.some((roomId) => !svc.clients.has(roomId))) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return wanted.length;
}

/** Temp data dir + a real service, booted (see bridge-state.test.mjs for the wait). */
async function startNode(port, dir = null) {
  const dataDir = dir ?? (await mkdtemp(join(tmpdir(), "ar-listen-")));
  const svc = new ServiceClass(new Context(), { dataDir: dataDir, port, relay: "" });
  const end = Date.now() + 20_000;
  while (Date.now() < end && !(svc.profileTimer != null && svc.listenTimer != null)) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(svc.profileTimer != null && svc.listenTimer != null, `service on ${port} must boot`);
  await settleBootRejoin(svc, dataDir);
  const node = { svc, dir: dataDir };
  NODES.add(node);
  return node;
}

/**
 * Real teardown: timers off, server stopped, discovery stopped, then every client
 * destroyed — and re-scanned after a yield, because an in-flight join can register
 * a client between the first scan and the process going quiet. The loop is bounded
 * and exits as soon as no NEW client appeared (one 120 ms yield on the happy path).
 */
async function stopNode(node) {
  const svc = node?.svc;
  if (!svc || node.stopped) return;
  node.stopped = true;
  for (const timer of [svc.profileTimer, svc.listenTimer]) {
    try { if (timer) clearInterval(timer); } catch { /* ignore */ }
  }
  try { await svc.peerServer?.stop(); } catch { /* ignore */ }
  try { svc.discovery?.stop?.(); } catch { /* ignore */ }
  const seen = new Set();
  for (let pass = 0; pass < 8; pass += 1) {
    for (const client of svc.clients?.values?.() ?? []) {
      if (seen.has(client)) continue;
      seen.add(client);
      try { client.destroy(); } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 120));
    if (![...(svc.clients?.values?.() ?? [])].some((client) => !seen.has(client))) break;
  }
}

/** Discard a node's temp data dir (only for nodes that own one). */
async function dropDir(dir) {
  try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * The REAL route: the service's own router mounted on a loopback HTTP server, so
 * `POST /agent-room-api/rooms/<id>/listening` is what drives the toggle — the
 * same handler the browser hits (web.ts:182-187).
 */
async function startApi(svc) {
  const handler = routerFactory(svc);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    post: (roomId, on) =>
      fetch(`${base}/agent-room-api/rooms/${encodeURIComponent(roomId)}/listening`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      }),
    state: async () => (await (await fetch(`${base}/agent-room-api/state`)).json()).data,
    close: () => new Promise((r) => server.close(r)),
  };
}

const readIntent = async (dir) => {
  try {
    return JSON.parse(await readFile(join(dir, "listening.json"), "utf8"));
  } catch (error) {
    return { missing: String(error?.code ?? error?.message) };
  }
};

/**
 * `onJoinedRecord` fires after the HTTP handshake and persists joined.json on the
 * write chain. A restart that begins before that chain drained would start without
 * a joined record — so wait for the record on disk, exactly as a real restart
 * (seconds later) always does.
 */
async function waitForJoinedRecord(dir, roomId, budgetMs = 6_000) {
  const end = Date.now() + budgetMs;
  for (;;) {
    try {
      const records = JSON.parse(await readFile(join(dir, "joined.json"), "utf8"));
      if (Array.isArray(records) && records.some((r) => r?.roomId === roomId)) return true;
    } catch { /* not written yet */ }
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Wait until a joined room's `listening` field reports `want` (or time out). */
async function waitForListening(api, roomId, want, budgetMs = 6_000) {
  const end = Date.now() + budgetMs;
  let seen = null;
  for (;;) {
    const state = await api.state();
    seen = state.rooms.filter((r) => r.roomId === roomId)[0]?.listening;
    if (seen === want) return { value: seen, ok: true };
    if (Date.now() >= end) return { value: seen, ok: false };
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Journaling wrapper around the Promise the toggle kicks off. */
const settle = () => new Promise((r) => setTimeout(r, 250));

/**
 * An OWNER node + one persistent room, which is what gives a member a joined
 * record that survives (a dead address gets pruned by `autoRejoinJoinedRooms`
 * as soon as the join answer proves the room is gone — measured here).
 */
async function startOwner(port, titles = ["K family"]) {
  const owner = await startNode(port);
  const rooms = [];
  for (const title of titles) {
    rooms.push(await owner.svc.gateway.createRoom({ title, type: "persistent" }));
  }
  return { owner, rooms };
}

async function withApi(svc, run) {
  const api = await startApi(svc);
  try {
    return await run(api);
  } finally {
    await api.close();
  }
}

guarded("the listening route writes the intent to disk, and a restart restores it with NO upgrade script (0.1.42)", async () => {
  const memberDir = await mkdtemp(join(tmpdir(), "ar-listen-member-"));
  const { owner, rooms } = await startOwner(19631);
  const room = rooms[0];
  const member = await startNode(19632, memberDir);
  try {
    await member.svc.gateway.joinRoom([room.serverAddress], { roomId: room.roomId });

    await withApi(member.svc, async (api) => {
      assert.strictEqual(member.svc.isListening(room.roomId), false, "a fresh node must not listen to anything");
      const res = await api.post(room.roomId, true);
      assert.strictEqual(res.status, 200, `POST /listening must answer 200, got ${res.status}`);
      assert.strictEqual(member.svc.isListening(room.roomId), true);
      const seen = await waitForListening(api, room.roomId, true);
      assert.ok(seen.ok, `/state must report listening=true, got ${seen.value}`);
      await settle();
      const intent = await readIntent(memberDir);
      console.log(`  listening.json after POST {on:true}: ${JSON.stringify(intent)}`);
      assert.deepStrictEqual(intent, { rooms: [room.roomId] }, "the toggle must persist the intent (only on success)");
    });
  } finally {
    await stopNode(member); // the "process restart": same dataDir, new process
  }

  const restarted = await startNode(19633, memberDir);
  try {
    const restored = restarted.svc.isListening(room.roomId);
    await withApi(restarted.svc, async (api) => {
      const seen = await waitForListening(api, room.roomId, true);
      console.log(`  after restart: svc.isListening=${restored} state.listening=${seen.value} (0.1.41: false)`);
      assert.strictEqual(restored, true, "the restart must restore listening WITHOUT any external script");
      assert.ok(seen.ok, `/state must report the restored flag, got ${seen.value}`);
    });
  } finally {
    await stopNode(restarted);
    await stopNode(owner);
    await dropDir(restarted.dir);
    await dropDir(memberDir);
    await dropDir(owner.dir);
  }
});

guarded("explicit OFF then restart stays OFF — the restore never force-enables (0.1.42)", async () => {
  const memberDir = await mkdtemp(join(tmpdir(), "ar-listen-off-"));
  const { owner, rooms } = await startOwner(19634);
  const room = rooms[0];
  const member = await startNode(19635, memberDir);
  try {
    await member.svc.gateway.joinRoom([room.serverAddress], { roomId: room.roomId });
    await withApi(member.svc, async (api) => {
      await api.post(room.roomId, true);
      await settle();
      assert.strictEqual(member.svc.isListening(room.roomId), true);
      const off = await api.post(room.roomId, false);
      assert.strictEqual(off.status, 200);
      await settle();
      const intent = await readIntent(memberDir);
      console.log(`  listening.json after POST {on:false}: ${JSON.stringify(intent)}`);
      assert.deepStrictEqual(intent, { rooms: [] }, "an explicit OFF must be recorded as an absence");
    });
  } finally {
    await stopNode(member);
  }

  const restarted = await startNode(19636, memberDir);
  try {
    await withApi(restarted.svc, async (api) => {
      const seen = await waitForListening(api, room.roomId, false);
      console.log(`  after restart following the explicit OFF: svc.isListening=${restarted.svc.isListening(room.roomId)} state.listening=${seen.value}`);
      assert.strictEqual(restarted.svc.isListening(room.roomId), false, "OFF must survive a restart (do not force-enable)");
      assert.ok(seen.ok, `/state must report listening=false, got ${seen.value}`);
    });
  } finally {
    await stopNode(restarted);
    await stopNode(owner);
    await dropDir(restarted.dir);
    await dropDir(memberDir);
    await dropDir(owner.dir);
  }
});

guarded("two rooms: each keeps its own intent across the restart (per profile × roomId) (0.1.42)", async () => {
  const memberDir = await mkdtemp(join(tmpdir(), "ar-listen-two-"));
  const { owner, rooms } = await startOwner(19637, ["K family", "other"]);
  const [a, b] = rooms;
  const member = await startNode(19638, memberDir);
  try {
    await member.svc.gateway.joinRoom([a.serverAddress], { roomId: a.roomId });
    await member.svc.gateway.joinRoom([b.serverAddress], { roomId: b.roomId });
    await withApi(member.svc, async (api) => {
      await api.post(a.roomId, true);
      await api.post(b.roomId, false);
      await settle();
      assert.deepStrictEqual(await readIntent(memberDir), { rooms: [a.roomId] });
    });
  } finally {
    await stopNode(member);
  }

  const restarted = await startNode(19639, memberDir);
  try {
    console.log(`  after restart: ${a.roomId.slice(0, 8)}=${restarted.svc.isListening(a.roomId)} ${b.roomId.slice(0, 8)}=${restarted.svc.isListening(b.roomId)}`);
    assert.strictEqual(restarted.svc.isListening(a.roomId), true, "the room that was on comes back on");
    assert.strictEqual(restarted.svc.isListening(b.roomId), false, "the room that was off stays off");
  } finally {
    await stopNode(restarted);
    await stopNode(owner);
    await dropDir(restarted.dir);
    await dropDir(memberDir);
    await dropDir(owner.dir);
  }
});

guarded("backward compatibility: a file without the field, or unreadable, reads as NOT listening and never errors (0.1.42)", async () => {
  // The record names the room THIS node is joined to, so a restored flag is
  // observable; the junk beside it is what the compatibility rule is about.
  const cases = (roomId) => [
    { label: "legacy object without `rooms`", contents: "{}", expect: false },
    { label: "an explicitly empty record", contents: '{"rooms":[]}', expect: false },
    { label: "not JSON at all", contents: "{ this is not json", expect: false },
    // A string entry must be honoured even when junk sits beside it; the junk is
    // dropped rather than making the whole record throw.
    { label: "mixed types (only strings count)", contents: `{"rooms":["${roomId}",7,null,{"x":1}]}`, expect: true },
  ];
  for (const [index, makeCase] of [0, 1, 2, 3].entries()) {
    const { owner, rooms } = await startOwner(19640 + index * 2);
    const item = cases(rooms[0].roomId)[index];
    const memberDir = await mkdtemp(join(tmpdir(), "ar-listen-compat-"));
    const member = await startNode(19641 + index * 2, memberDir);
    try {
      await member.svc.gateway.joinRoom([rooms[0].serverAddress], { roomId: rooms[0].roomId });
      assert.ok(await waitForJoinedRecord(memberDir, rooms[0].roomId), "the join must be recorded before the restart");
      await stopNode(member);
      await writeFile(join(memberDir, "listening.json"), item.contents, "utf8");
      const restarted = await startNode(19641 + index * 2, memberDir);
      try {
        const got = restarted.svc.isListening(rooms[0].roomId);
        console.log(`  ${item.label}: restored=${got} (expected ${item.expect}, must not throw)`);
        assert.strictEqual(got, item.expect, `${item.label} must read as ${item.expect}`);
      } finally {
        await stopNode(restarted);
        await dropDir(restarted.dir);
      }
    } finally {
      await stopNode(owner);
      await dropDir(memberDir);
      await dropDir(owner.dir);
    }
  }
});

guarded("an OWNED room that was listening comes back listening with NO script (0.1.44 / D-28)", async () => {
  const { owner, rooms } = await startOwner(19670);
  const room = rooms[0];
  try {
    // The REAL route, driven on the OWNER's own room: nothing in the route or in the
    // browser refuses an owned room (measured: client.js renders the 监听 toggle for
    // every room), so this is the state D was in when she came back muted.
    await withApi(owner.svc, async (api) => {
      const res = await api.post(room.roomId, true);
      assert.strictEqual(res.status, 200, `POST /listening on an OWNED room must answer 200, got ${res.status}`);
      assert.strictEqual(owner.svc.isListening(room.roomId), true, "the owner must be able to listen to its own room");
      await settle();
      const intent = await readIntent(owner.dir);
      console.log(`  owner listening.json after POST {on:true}: ${JSON.stringify(intent)}`);
      assert.deepStrictEqual(intent, { rooms: [room.roomId] }, "the OWNER's toggle must persist too");
    });
  } finally {
    await stopNode(owner); // the restart: same dataDir, new process, no upgrade script
  }

  const restarted = await startNode(19671, owner.dir);
  try {
    const restored = restarted.svc.isListening(room.roomId);
    await withApi(restarted.svc, async (api) => {
      const seen = await waitForListening(api, room.roomId, true);
      console.log(`  owned room ${room.roomId.slice(0, 8)} after restart: svc.isListening=${restored} state.listening=${seen.value} (0.1.43: false)`);
      assert.strictEqual(restored, true, "an OWNED room must be restored from the intent (0.1.43 skipped it: D-28)");
      assert.ok(seen.ok, `/state must report the restored flag on an owned room, got ${seen.value}`);
    });
  } finally {
    await stopNode(restarted);
    await dropDir(restarted.dir);
    await dropDir(owner.dir);
  }
});

guarded("an owned room with NO recorded intent is NOT auto-enabled (0.1.44: restore never force-enables)", async () => {
  const { owner, rooms } = await startOwner(19672);
  const room = rooms[0];
  try {
    // No toggle was ever posted for this room, so there is nothing to restore —
    // "the owner may listen" must not become "the owner always listens".
    assert.strictEqual(
      await readIntent(owner.dir).then((intent) => intent.missing !== undefined),
      true,
      "a node that was never toggled must have no intent file at all",
    );
    await stopNode(owner);
    const restarted = await startNode(19673, owner.dir);
    try {
      console.log(`  owned room ${room.roomId.slice(0, 8)} with no intent file: restored=${restarted.svc.isListening(room.roomId)}`);
      assert.strictEqual(restarted.svc.isListening(room.roomId), false, "owning a room must not imply listening to it");
    } finally {
      await stopNode(restarted);
      await dropDir(restarted.dir);
      await dropDir(owner.dir);
    }
  } finally {
    await dropDir(owner.dir);
  }
});

guarded("static guard: the toggle persists, the boot restores, and nothing else writes the intent (0.1.42/0.1.44)", () => {
  const src = readFileSync(join(ROOT, "src", "host", "service.ts"), "utf8");
  const toggle = src.slice(src.indexOf("setListening(roomId: string, on: boolean): void {"), src.indexOf("private persistListening()"));
  assert.match(toggle, /this\.persistListening\(\);/, "setListening must persist the intent");
  assert.match(src, /this\.listeningFile = join\(this\.config\.dataDir, "listening\.json"\);/);
  assert.match(src, /await this\.restoreListening\(\);/, "boot must restore the intent deliberately");
  assert.match(src, /private async restoreListening\(\): Promise<void> \{/);
  assert.match(src, /listening: this\.listeningRooms\.has\(room\.roomId\),/, "/state must keep reporting the flag");

  // One WRITE site in service.ts, and it must be the chained one: two toggles in
  // the same tick must not race inside the atomic writer (that would let the file
  // describe the older set and resurrect a listening flag the operator just
  // switched OFF at the next restart).
  const writeSites = (src.match(/writeFile\(file, JSON\.stringify\(\{ rooms: snapshot \}/g) || []).length;
  assert.strictEqual(writeSites, 1, `service.ts must have exactly one listening write site, found ${writeSites}`);
  assert.match(src, /this\.listeningSave = this\.listeningSave\s*\n\s*\.then\(/, "the write must be chained, not raced");
  assert.match(src, /this\.persistListening\(\);\s*\n\s*this\.emitBrowser\(\{ kind: "state" \}\);/);

  const restore = src.slice(src.indexOf("private async restoreListening()"), src.indexOf("private async sweepListening()"));
  // 0.1.44 / D-28: every recorded room is restored, INCLUDING a room this node owns.
  // `loadListeningIntent()` is what follows the membership (joined records + owned
  // rooms) and it never returns ids this node does not know, so the restore loop has
  // no business filtering again — the old `continue` on an owned room is exactly the
  // defect that muted the room owner on every restart.
  assert.match(
    restore,
    /this\.listeningRooms\.add\(roomId\);\s*\n\s*restored \+= 1;/,
    "the restore must add every recorded room to the listening set",
  );
  assert.strictEqual(
    (restore.match(/\bcontinue;/g) || []).length,
    0,
    "the restore must not skip rooms with `continue` (0.1.43 skipped owned rooms: D-28)",
  );
  assert.doesNotMatch(
    restore,
    /getOwnedRoom\(roomId\)\)\s*\{\s*skipped/,
    "the restore must not special-case owned rooms",
  );
  assert.match(
    restore,
    /if \(this\.roomService\.getOwnedRoom\(roomId\)\) owned \+= 1;/,
    "owned rooms must be counted in the restore log, not skipped",
  );

  const persistence = readFileSync(join(ROOT, "src", "host", "persistence.ts"), "utf8");
  assert.match(persistence, /async loadListening\(\): Promise<string\[\]> \{/);
  assert.match(persistence, /async saveListening\(roomIds: string\[\]\): Promise<void> \{/);
  assert.match(persistence, /return rooms\.filter\(\(roomId\): roomId is string => typeof roomId === "string"/);
  assert.match(persistence, /join\(this\.root, "listening\.json"\)/, "the intent file must live beside joined.json");
});

guarded("the listening route refuses a body it cannot understand instead of executing the opposite (0.1.51)", async () => {
  // The field is `on`. Measured on the live host (2026-09-16): `POST {"listening":true}` -- the
  // obvious wrong guess -- was read as `body.on === true` -> false, i.e. the route SILENTLY TURNED
  // LISTENING OFF and answered `{ok:true}`. The room projection did not change, so it read as "the
  // route is broken" rather than "the field name is wrong". This case pins all four shapes.
  const memberDir = await mkdtemp(join(tmpdir(), "ar-listen-field-"));
  const { owner, rooms } = await startOwner(19640);
  const room = rooms[0];
  const member = await startNode(19641, memberDir);
  try {
    await member.svc.gateway.joinRoom([room.serverAddress], { roomId: room.roomId });
    await withApi(member.svc, async (api) => {
      const url = `${api.base}/agent-room-api/rooms/${encodeURIComponent(room.roomId)}/listening`;
      const rawPost = (body) => fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      // 1. a body with no usable field must be REFUSED, and must not change the state
      const before = member.svc.isListening(room.roomId);
      const empty = await rawPost({});
      const emptyBody = await empty.json().catch(() => ({}));
      console.log(`  POST {} -> ${empty.status} ${JSON.stringify(emptyBody)}`);
      assert.strictEqual(empty.status, 400, "a body without `on` must be refused, not guessed at");
      assert.match(String(emptyBody?.error ?? ""), /boolean `on`/, "the refusal must name the accepted field");
      assert.strictEqual(member.svc.isListening(room.roomId), before, "a refused request must not change the state");

      // 2. the alias everyone guesses first must WORK, not silently mean the opposite
      const alias = await rawPost({ listening: true });
      const aliasBody = await alias.json().catch(() => ({}));
      console.log(`  POST {listening:true} -> ${alias.status} ${JSON.stringify(aliasBody)}`);
      assert.strictEqual(alias.status, 200, "the `listening` alias must be accepted");
      assert.strictEqual(member.svc.isListening(room.roomId), true, "the alias must turn listening ON, not OFF");
      assert.strictEqual(aliasBody?.data?.listening, true, "the answer must ECHO the resulting state");

      // 3. the canonical field keeps working, and echoes too
      const off = await rawPost({ on: false });
      const offBody = await off.json().catch(() => ({}));
      console.log(`  POST {on:false} -> ${off.status} ${JSON.stringify(offBody)}`);
      assert.strictEqual(off.status, 200);
      assert.strictEqual(member.svc.isListening(room.roomId), false);
      assert.strictEqual(offBody?.data?.listening, false);

      // 4. GET reports this member's own flag (an owner's /state does not carry it)
      const got = await fetch(url);
      const gotBody = await got.json().catch(() => ({}));
      console.log(`  GET -> ${got.status} ${JSON.stringify(gotBody)}`);
      assert.strictEqual(got.status, 200);
      assert.strictEqual(gotBody?.data?.listening, false, "GET must report the local listening flag");
    });
  } finally {
    await stopNode(member);
    await stopNode(owner);
    await dropDir(memberDir);
    await dropDir(owner.dir);
  }
});

// Bounded, and deliberately UNREF'd: the suite tears its own services down, so
// nothing here should hold the event loop. The guard exists only to turn a future
// regression (a fresh leaked handle) into a DEFINITE exit code 1 after 120 s instead
// of a silent hang; it is cleared by the `after` hook below on every normal run, so
// it can never be the reason the process stays alive.
const watchdog = setTimeout(() => {
  console.log(`WATCHDOG: the suite did not finish in 120 s (failures so far: ${failures})`);
  process.exit(1);
}, 120_000);
watchdog.unref?.();

/**
 * End of run. On THIS build the teardown above is real and the event loop drains on
 * its own (measured: 7 s, exit 0, no leftover handle). The escape hatch below exists
 * for the OTHER build this file is pointed at through `AR_LIB` — the deployed 0.1.41
 * comparison build — where the same suite finishes its tests and then never exits
 * (measured: the process stayed alive indefinitely after this hook ran, because a
 * `RoomClient` of the pre-0.1.42 build re-arms its own reconnect timer and that build
 * offers no service-level stop()). The exit is therefore: bounded (300 ms after the
 * last assertion), deterministic (a function of the failure counter), and LOUD — if
 * any handle is still ref'd when it fires, it is named in the output instead of being
 * quietly papered over. An unref'd timer cannot itself keep the process alive, so a
 * clean run still exits through the normal path.
 */
after(async () => {
  clearTimeout(watchdog);
  // Safety-net sweep: stop any node that a failed assertion left running.
  for (const node of NODES) await stopNode(node);
  console.log(`SUITE listening: ${failures} failure(s) (every ✓/✗ above is one assertion of the 6 guarded cases)`);
  const code = failures === 0 ? 0 : 1;
  process.exitCode = code;
  const hardExit = setTimeout(() => {
    const leftovers = process.getActiveResourcesInfo().filter((kind) => kind !== "PipeWrap");
    if (leftovers.length > 0) {
      console.log(
        `TEARDOWN: bounded exit with ${leftovers.length} handle(s) still ref'd (${[...new Set(leftovers)].join(",")})` +
          ` — this build's teardown is incomplete; the exit code is still definite.`,
      );
    }
    process.exit(code);
  }, 300);
  hardExit.unref?.();
});
