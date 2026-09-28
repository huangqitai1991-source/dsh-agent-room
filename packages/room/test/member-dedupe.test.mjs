/**
 * dsh-agent-room 0.1.42 — D-21: ONE member record per agentId.
 *
 * THE DEFECT (field, 2026-09-14)
 *
 * 小捷 held TWO member records in 小婷's room, `joinedAt`
 * 2026-09-14T00:46:52.281Z and 2026-09-14T00:58:31.635Z — correlating with that
 * machine's own report that its address changed twice that day. The ledger's
 * hypothesis was "each re-join appends a record instead of updating the one keyed
 * by agentId". MEASURED HERE, that hypothesis is REFUTED for the live join path:
 * `RoomService.joinOwnedRoom` has been idempotent since at least 0.1.2
 * (`src/host/room-service.ts:279-284`, "Idempotent rejoin"), so two joins of one
 * agentId produce ONE record (asserted in the second test below — it passes on
 * the old 0.1.25 build too, which is why it is reported as a refutation rather
 * than a fix).
 *
 * WHAT IS ACTUALLY BROKEN, and what this file pins:
 *
 *   1. Nothing ever REPAIRED a room whose member list already held duplicates —
 *      and the join path cannot: `admit()` edited only the FIRST match
 *      (`find(agentId)`), so the stale record (old `joinedAt`, old address) stayed
 *      in every read view forever. `boot()` put the persisted room into `owned`
 *      verbatim. That is what inflates `memberCount` and makes "who is online"
 *      resolve to the stale row (the same blindness class as D-20).
 *   2. A re-join did not record the address it arrived from, so "the newest known
 *      address" did not exist anywhere on the owner side.
 *
 * Both are fixed in `src/host/room-service.ts` (collapseDuplicateMembers +
 * `joinOwnedRoom(..., { address })`). Old-vs-new evidence:
 *
 *   AR_LIB=<0.1.25 lib>  node test/member-dedupe.test.mjs   -> NEW assertions FAIL
 *   node test/member-dedupe.test.mjs                        -> all pass
 *
 * Run directly (never `node --test`).
 */

import assert from "node:assert";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The build under test. `AR_LIB` lets the same file run against an older build
 *  for the old-vs-new comparison; unset = the freshly built `lib/` next to src.
 *  An absolute Windows path is converted to a file URL (ESM cannot import `D:/…`). */
const LIB = (() => {
  const raw = (process.env.AR_LIB ?? "../lib").replace(/\\/g, "/");
  if (raw.startsWith("file://")) return raw;
  return /^[a-zA-Z]:\//.test(raw) ? `file:///${raw}` : raw;
})();
// Keep every write inside the temp dirs this file creates (the safety layer takes
// a verified backup before an identity write).
process.env.DSH_IDENTITY_BACKUP_DIR = process.env.DSH_IDENTITY_BACKUP_DIR
  ?? join(tmpdir(), "ar-dedupe-backups");

const { RoomService } = await import(`${LIB}/host/room-service.js`);

const MEMBER = "01a094c1-7159-7555-9222-65241c607320"; // 小捷
const FIELD_T1 = "2026-09-14T00:46:52.281Z"; // the two joinedAt values the field showed
const FIELD_T2 = "2026-09-14T00:58:31.635Z";
const ADDR_LAN = "198.51.100.11:9317"; // the machine's first address
const ADDR_NEW = "203.0.113.9:9317"; // ...and the one it changed to

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
  const dir = await mkdtemp(join(tmpdir(), `ar-dedupe-${tag}-`));
  dirs.push(dir);
  return dir;
}

const memberRows = (room, agentId) => (room?.members ?? []).filter((m) => m.agentId === agentId);

guarded("D-21: a room whose list holds two records for one agentId converges to ONE on load", async () => {
  const dir = await mk("repair");
  const first = new RoomService({ dataDir: dir });
  await first.boot();
  const room = await first.createRoom({ title: "K family", type: "persistent" });

  // Seed the EXACT field state: one agentId, two records, different joinedAt.
  // (Written to the room file the way the defect left it; this is the state a real
  // node had on disk, not a synthetic API abuse.)
  const file = join(dir, "rooms", `${room.roomId}.json`);
  const persisted = JSON.parse(await readFile(file, "utf8"));
  persisted.members = [
    ...persisted.members,
    {
      agentId: MEMBER,
      nickname: "小捷",
      role: "member",
      roles: ["executor"],
      joinedAt: FIELD_T1,
      capabilities: ["pwsh"],
    },
    {
      agentId: MEMBER,
      nickname: "小捷",
      role: "member",
      roles: ["observer"],
      joinedAt: FIELD_T2,
      lastSeenAt: FIELD_T2,
      lastSeenAddress: ADDR_LAN,
      capabilities: ["room_send"],
    },
  ];
  await writeFile(file, JSON.stringify(persisted, null, 2), "utf8");

  const seeded = JSON.parse(await readFile(file, "utf8"));
  console.log("[D-21] seeded member list (the field state) =", JSON.stringify(
    seeded.members.map((m) => ({ agentId: m.agentId, joinedAt: m.joinedAt, roles: m.roles })),
  ));
  assert.strictEqual(
    memberRows(seeded, MEMBER).length,
    2,
    "precondition: the room file carries two records for one agentId",
  );

  // A fresh boot of the same data dir — the upgrade path a real node takes.
  const repaired = new RoomService({ dataDir: dir });
  await repaired.boot();
  const loaded = repaired.getOwnedRoom(room.roomId);
  const rows = memberRows(loaded, MEMBER);
  console.log("[D-21] after boot, member list =", JSON.stringify(
    (loaded?.members ?? []).map((m) => ({ agentId: m.agentId, joinedAt: m.joinedAt, roles: m.roles })),
  ));

  assert.strictEqual(rows.length, 1, `one agentId must hold exactly ONE record, got ${rows.length}`);
  assert.strictEqual(
    loaded.members.length,
    2,
    "memberCount must not be inflated (owner + one member), the defect class this shares with D-20",
  );
  assert.strictEqual(rows[0].joinedAt, FIELD_T2, "the NEWEST known joinedAt must survive");
  // Nothing learned about the member may be lost by the collapse.
  assert.deepStrictEqual([...(rows[0].roles ?? [])].sort(), ["executor", "observer"], "roles must be unioned");
  assert.deepStrictEqual(
    [...(rows[0].capabilities ?? [])].sort(),
    ["pwsh", "room_send"],
    "capabilities must be unioned, not dropped",
  );
  assert.strictEqual(rows[0].lastSeenAddress, ADDR_LAN, "the duplicate's newest known address must survive");

  // The repair must be on DISK too, or the next boot starts from the same mess.
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.strictEqual(
    memberRows(onDisk, MEMBER).length,
    1,
    "the collapsed list must be persisted (a repair that only lives in memory is not a repair)",
  );
});

guarded("D-21: three re-joins of one agentId (address changing each time) keep ONE record with the newest address", async () => {
  const dir = await mk("rejoin");
  const service = new RoomService({ dataDir: dir });
  await service.boot();
  const room = await service.createRoom({ title: "K family", type: "persistent" });
  const agent = { agentId: MEMBER, nickname: "小捷", capabilities: ["pwsh"], createdAt: FIELD_T1 };

  // Join #1 — the machine's first address.
  service.joinOwnedRoom(room.roomId, agent, { address: ADDR_LAN });
  const afterFirst = memberRows(service.getOwnedRoom(room.roomId), MEMBER);
  const joinedAt = afterFirst[0]?.joinedAt;
  assert.strictEqual(afterFirst.length, 1, "the first join creates exactly one record");

  // Join #2 and #3 — the address changed twice, exactly as 小捷 reported.
  service.joinOwnedRoom(room.roomId, agent, { address: ADDR_NEW });
  service.joinOwnedRoom(room.roomId, agent, { address: ADDR_LAN });
  const rows = memberRows(service.getOwnedRoom(room.roomId), MEMBER);
  console.log("[D-21] after 3 re-joins =", JSON.stringify(
    rows.map((m) => ({ agentId: m.agentId, joinedAt: m.joinedAt, lastSeenAt: m.lastSeenAt, lastSeenAddress: m.lastSeenAddress })),
  ));

  assert.strictEqual(rows.length, 1, `re-join must UPDATE in place, got ${rows.length} records`);
  assert.strictEqual(
    service.getOwnedRoom(room.roomId).members.length,
    2,
    "owner + member: re-joins must not inflate the member list",
  );
  assert.strictEqual(rows[0].lastSeenAddress, ADDR_LAN, "the NEWEST known address must be stored");
  assert.strictEqual(rows[0].joinedAt, joinedAt, "joinedAt is the first join of this membership, unchanged by a re-join");
  assert.ok(rows[0].lastSeenAt, "a re-join is live contact: it must stamp lastSeenAt (D-20)");
  assert.ok(Date.parse(rows[0].lastSeenAt) >= Date.parse(joinedAt), "lastSeenAt must not precede the first join");
  assert.deepStrictEqual(rows[0].capabilities, ["pwsh"], "a re-join must not lose capabilities");

  // The tokens map must hold ONE entry per agentId (an old record's token is gone).
  const second = service.joinOwnedRoom(room.roomId, agent, { address: ADDR_NEW });
  assert.ok(second.token, "the idempotent re-join must still hand back a fresh token");
  assert.strictEqual(memberRows(service.getOwnedRoom(room.roomId), MEMBER).length, 1);
});

guarded("D-21: a boot-time repair does not disturb a healthy list (no false positives)", async () => {
  const dir = await mk("clean");
  const service = new RoomService({ dataDir: dir });
  await service.boot();
  const room = await service.createRoom({ title: "clean", type: "persistent" });
  service.joinOwnedRoom(room.roomId, { agentId: MEMBER, nickname: "小捷", capabilities: [], createdAt: FIELD_T1 }, { address: ADDR_LAN });
  service.joinOwnedRoom(room.roomId, { agentId: "01a09483-3668-7bdf-9cc2-0180f314c8cf", nickname: "小婷", capabilities: [], createdAt: FIELD_T1 }, { address: ADDR_NEW });

  const before = service.getOwnedRoom(room.roomId).members.map((m) => ({ ...m }));
  const reopened = new RoomService({ dataDir: dir });
  await reopened.boot();
  const after = reopened.getOwnedRoom(room.roomId).members;
  assert.strictEqual(after.length, before.length, "a healthy list must survive a re-load unchanged");
  assert.deepStrictEqual(after.map((m) => m.agentId), before.map((m) => m.agentId), "member order is preserved");
  assert.strictEqual(after.length, 3, "owner + 2 distinct members");
  // Let the fire-and-forget room saves land before the temp dirs are removed.
  await new Promise((resolve) => setTimeout(resolve, 250));
});

const watchdog = setTimeout(() => process.exit(failures > 0 ? 1 : 0), 20_000);
watchdog.unref();

after(async () => {
  // Bounded on purpose: on Windows a temp dir can still be held by a socket/timer
  // from a service that is shutting down, and an rm that never returns would hang
  // the run forever (no summary, watchdog exit only). Temp files are disposable.
  const cleanup = Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 }).catch(() => {})),
  );
  await Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, 2_000))]);
});
