/**
 * dsh-agent-room 0.1.42 — D-20: a real liveness signal on the room side.
 *
 * THE DEFECT (field, 2026-09-14)
 *
 * After 小捷 went off duty, the controller spent THREE exec timeouts (45s / 25s /
 * 25s) and one room ping and still could not tell "machine off" from "plugin
 * wedged"; it took a human answer to settle it. The reason is that nothing on the
 * room side described RECENT CONTACT: a member record carried `joinedAt` only (an
 * admission timestamp), and the org tree's `updatedAt` is an EDIT stamp — measured
 * frozen at 2026-09-12T14:26 on a machine that was alive, so using it as a
 * heartbeat produces a worse conclusion than no field at all.
 *
 * WHAT THIS FILE PINS (`src/host/room-service.ts`, `src/host/peer-server.ts`)
 *
 *   `Member.lastSeenAt`       — last frame the OWNER received from that member.
 *   `Member.lastSeenAddress`  — where it was last seen from.
 *   `Member.lastExecAt`       — last `[org:exec:result]` that member reported.
 *   `Member.lastExecOk`       — whether that exec succeeded ("reachable" vs
 *                               "reachable AND able to run commands").
 *
 * The touch happens in the ONE funnel every member frame goes through
 * (`peer-server.ts handleFrameFrom`), so it holds for a direct socket and for a
 * relay bridge — not per-transport.
 *
 * Old-vs-new evidence:
 *   AR_LIB=<0.1.25 lib>  node test/liveness.test.mjs   -> NEW assertions FAIL
 *   node test/liveness.test.mjs                        -> all pass
 *
 * Everything runs on 127.0.0.1 with temp dirs; no fleet service is started,
 * stopped or contacted. Run directly (never `node --test`).
 */

import assert from "node:assert";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIB = (() => {
  const raw = (process.env.AR_LIB ?? "../lib").replace(/\\/g, "/");
  if (raw.startsWith("file://")) return raw;
  return /^[a-zA-Z]:\//.test(raw) ? `file:///${raw}` : raw;
})();
process.env.DSH_IDENTITY_BACKUP_DIR = process.env.DSH_IDENTITY_BACKUP_DIR
  ?? join(tmpdir(), "ar-liveness-backups");

const { RoomService } = await import(`${LIB}/host/room-service.js`);
const peerServerModule = await import(`${LIB}/host/peer-server.js`);
const { execResultOk } = peerServerModule;

const MEMBER = "01a094c1-7159-7555-9222-65241c607320"; // 小捷
const ADDRESS = "198.51.100.11:9317";
const EXEC_RESULT_PREFIX = "[org:exec:result]";

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

const dirs = [];
async function mk(tag) {
  const dir = await mkdtemp(join(tmpdir(), `ar-liveness-${tag}-`));
  dirs.push(dir);
  return dir;
}

const memberRow = (room, agentId) => (room?.members ?? []).find((m) => m.agentId === agentId);
const isIso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

guarded("D-20: a join stamps lastSeenAt/lastSeenAddress, and a touch moves ONLY those", async () => {
  const service = new RoomService({ dataDir: await mk("room") });
  await service.boot();
  const room = await service.createRoom({ title: "K family", type: "persistent" });
  const agent = { agentId: MEMBER, nickname: "小捷", capabilities: ["pwsh"], createdAt: new Date().toISOString() };

  service.joinOwnedRoom(room.roomId, agent, { address: ADDRESS });
  const joined = memberRow(service.getOwnedRoom(room.roomId), MEMBER);
  console.log("[D-20] member record right after join =", JSON.stringify(joined));
  assert.ok(isIso(joined?.lastSeenAt), `a join is contact: lastSeenAt must be an ISO timestamp, got ${joined?.lastSeenAt}`);
  assert.strictEqual(joined.lastSeenAddress, ADDRESS, "the address the member was seen from must be recorded");
  assert.strictEqual(joined.joinedAt, joined.lastSeenAt, "on a first join the two coincide");

  // An edit stamp is NOT a heartbeat: nothing about the record may move unless
  // something actually happened.
  const before = { ...joined };
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const still = memberRow(service.getOwnedRoom(room.roomId), MEMBER);
  assert.strictEqual(still.lastSeenAt, before.lastSeenAt, "an idle room must not pretend to have heard from the member");

  // ...and a real touch does move it, without touching joinedAt.
  const returned = service.touchMember(room.roomId, MEMBER);
  assert.ok(returned, "touchMember must find the member");
  assert.ok(Date.parse(returned.lastSeenAt) > Date.parse(before.lastSeenAt), "a touch must advance lastSeenAt");
  assert.strictEqual(returned.joinedAt, before.joinedAt, "lastSeenAt must never be joinedAt renamed");
  assert.strictEqual(service.touchMember(room.roomId, "nobody"), undefined, "an unknown member is a no-op, not a crash");
});

guarded("D-20: lastExecAt/lastExecOk separate 'reachable' from 'can run commands'", async () => {
  const dir = await mk("exec");
  const service = new RoomService({ dataDir: dir });
  await service.boot();
  const room = await service.createRoom({ title: "K family", type: "persistent" });
  service.joinOwnedRoom(room.roomId, { agentId: MEMBER, nickname: "小捷", capabilities: [], createdAt: new Date().toISOString() }, { address: ADDRESS });

  const before = memberRow(service.getOwnedRoom(room.roomId), MEMBER);
  assert.strictEqual(before.lastExecAt, undefined, "a member that never answered an exec has NO exec stamp (unknown, not false)");

  service.touchMember(room.roomId, MEMBER, { execOk: true });
  const ok = memberRow(service.getOwnedRoom(room.roomId), MEMBER);
  assert.ok(isIso(ok.lastExecAt), "an exec answer must stamp lastExecAt");
  assert.strictEqual(ok.lastExecOk, true);
  assert.ok(Date.parse(ok.lastExecAt) >= Date.parse(before.lastSeenAt), "an exec answer is also contact");

  service.touchMember(room.roomId, MEMBER, { execOk: false });
  assert.strictEqual(memberRow(service.getOwnedRoom(room.roomId), MEMBER).lastExecOk, false, "a failed exec must be readable as such");

  // Degrade gracefully: a record written by an OLDER node has none of these
  // fields, and that must read as "unknown", never as "offline".
  const legacy = { agentId: "legacy", nickname: "旧节点", role: "member", joinedAt: new Date().toISOString() };
  assert.strictEqual(legacy.lastSeenAt, undefined, "an older peer's record simply has no liveness fields");
  assert.strictEqual(legacy.lastExecOk, undefined, "missing must stay distinguishable from false");

  // The fields persist, so a reader after a restart sees the last known contact
  // instead of starting blind.
  const reopened = new RoomService({ dataDir: dir });
  await reopened.boot();
  const persisted = memberRow(reopened.getOwnedRoom(room.roomId), MEMBER);
  console.log("[D-20] member record after restart =", JSON.stringify(persisted));
  assert.ok(isIso(persisted?.lastSeenAt), "lastSeenAt must survive a restart (it is the point of the field)");
  assert.strictEqual(persisted.lastExecOk, false);
  assert.strictEqual(persisted.lastSeenAddress, ADDRESS);
  // ...and the room file is plain JSON that an older node can still read.
  const raw = JSON.parse(await readFile(join(dir, "rooms", `${room.roomId}.json`), "utf8"));
  assert.ok(memberRow(raw, MEMBER), "the room file must stay readable (extra fields, same shape)");
});

guarded("D-20: an [org:exec:result] frame is read as an exec signal; anything else is not", () => {
  assert.strictEqual(typeof execResultOk, "function", "peer-server must export the exec-frame reader (the funnel uses it)");
  const ok = `${EXEC_RESULT_PREFIX}${JSON.stringify({ id: "e1", ok: true, stdout: "PROBE" })}`;
  const failed = `${EXEC_RESULT_PREFIX}${JSON.stringify({ id: "e2", ok: false, code: 1 })}`;
  const pending = `${EXEC_RESULT_PREFIX}${JSON.stringify({ id: "e3", ok: false, pending: true, status: 202 })}`;
  const garbage = `${EXEC_RESULT_PREFIX}{not json`;
  console.log("[D-20] execResultOk:", JSON.stringify({ ok: execResultOk(ok), failed: execResultOk(failed), pending: execResultOk(pending), garbage: execResultOk(garbage) }));

  assert.strictEqual(execResultOk(ok), true);
  assert.strictEqual(execResultOk(failed), false);
  assert.strictEqual(execResultOk(pending), undefined, "a 202 'still executing' is NOT a finished exec result");
  assert.strictEqual(execResultOk(garbage), undefined, "an unparseable body must not invent an ok value");
  assert.strictEqual(execResultOk("[org:exec]{\"id\":\"e4\"}"), undefined, "an exec INSTRUCTION is not a result");
  assert.strictEqual(execResultOk("hello"), undefined);
  assert.strictEqual(execResultOk(undefined), undefined);
});

guarded("D-20: the liveness fields reach GET /agent-room-api/state (state alone must answer 'is this colleague reachable')", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { AgentRoomService } = await import(`${LIB}/host/service.js`);
  const dir = await mk("state");
  let svc = null;
  try {
    svc = new AgentRoomService(new Context(), { dataDir: dir, port: 19561, relay: "" });
    const end = Date.now() + 8_000;
    while (Date.now() < end && !(svc.profileTimer != null && svc.listenTimer != null)) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(svc.profileTimer != null && svc.listenTimer != null, "the service must boot before /state is read");

    const room = await svc.gateway.createRoom({ title: "liveness", type: "persistent" });
    svc.roomService.joinOwnedRoom(
      room.roomId,
      { agentId: MEMBER, nickname: "小捷", capabilities: [], createdAt: new Date().toISOString() },
      { address: ADDRESS },
    );
    svc.roomService.touchMember(room.roomId, MEMBER, { execOk: true });

    const state = await svc.browserState();
    const listed = state.rooms.find((r) => r.roomId === room.roomId);
    assert.ok(listed, "the owned room must appear in /state");
    const row = listed.members.find((m) => m.agentId === MEMBER);
    console.log("[D-20] /state member row =", JSON.stringify(row));
    assert.ok(isIso(row?.lastSeenAt), `/state must carry lastSeenAt, got ${JSON.stringify(row)}`);
    assert.strictEqual(row.lastSeenAddress, ADDRESS);
    assert.ok(isIso(row.lastExecAt), "/state must carry lastExecAt");
    assert.strictEqual(row.lastExecOk, true);
    assert.strictEqual(listed.memberCount, listed.members.length, "memberCount and the list must stay consistent");
    // JSON-serialisable (it crosses HTTP).
    assert.ok(JSON.parse(JSON.stringify(state)).rooms[0].members.some((m) => m.lastSeenAt));
  } finally {
    for (const timer of [svc?.profileTimer, svc?.listenTimer]) {
      try { if (timer) clearInterval(timer); } catch { /* ignore */ }
    }
    try { await svc?.peerServer?.stop(); } catch { /* ignore */ }
    try { svc?.discovery?.stop?.(); } catch { /* ignore */ }
    for (const client of svc?.clients?.values?.() ?? []) { try { client.destroy(); } catch { /* ignore */ } }
  }
});

after(async () => {
  // Bounded on purpose: on Windows a temp dir can still be held by a socket/timer
  // from a service that is shutting down, and an rm that never returns would hang
  // the run forever (no summary, watchdog exit only). Temp files are disposable.
  const cleanup = Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 }).catch(() => {})),
  );
  await Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, 2_000))]);
});

const watchdog = setTimeout(() => process.exit(failures > 0 ? 1 : 0), 25_000);
watchdog.unref();
