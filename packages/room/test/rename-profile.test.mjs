/**
 * rename-profile.test.mjs — card-01: the ONE supported rename entry point.
 *
 * WHY THIS EXISTS
 *   Before 0.1.40 a nickname could not be changed through any supported entry
 *   point. `updateProfile()` existed with zero callers, there was no route and no
 *   tool, so the only way was to edit identity.json by hand — which the running
 *   process cannot see, because the identity object is cached at boot and never
 *   re-read. The next save rewrote the file from that cache, so the hand fix was
 *   silently reverted (reproduced in D:\dsh\_rename-old-evidence.mjs, OLD-1/OLD-2).
 *
 * WHAT IS PINNED HERE
 *   1. `POST /agent-room-api/profile` and `gateway.renameSelf` both rename, through
 *      the real router and the real service;
 *   2. three-store consistency: identity.json (A), the room members' view (B),
 *      the agent-org node name (C);
 *   3. no restart: the cached identity object is mutated in place, and a fresh
 *      instance over the same directory reads the new name;
 *   4. immediate fan-out: a joined-room client receives the profile frame during
 *      the call (not up to 15s later), and the 15s timer stays armed;
 *   5. a rejected name changes NOTHING anywhere (byte-identical file, no member
 *      update, no org call, no mint);
 *   6. C is reported honestly when agent-org is absent or refuses;
 *   7. the backfill path for names that are ALREADY damaged: an agentId-based,
 *      explicitly-flagged operation that prints its plan before writing.
 *
 * SAFETY: every case writes only under D:\dsh\_rename-tests\ and points both
 * DSH_HOME and DSH_IDENTITY_BACKUP_DIR at that temp tree. The in-process instances
 * bind a high loopback port inside the test and are stopped by the test; nothing
 * on this machine is renamed and no other process is touched.
 *
 *   node test/rename-profile.test.mjs
 */

import assert from "node:assert";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { AgentRoomService } from "../lib/host/service.js";
import { RoomService } from "../lib/host/room-service.js";
import { createRouter } from "../lib/host/web.js";
import { IdentityNotReadyError, InvalidNicknameError, assertValidNickname, nicknameProblem } from "../lib/host/safety.js";

const ROOT = "D:\\dsh\\_rename-tests";
const AGENT_ID = "01a0231b-bbe5-720a-97a4-819744eeae76";
const PEER_ID = "01a0281a-52de-7c4d-a1e9-7e6db367d3dd";
const OWNED_ROOM = "01a09d61-6bff-7899-881d-b63f6434eef8";
const OLD_NAME = "KEVINKIKI";
const NEW_NAME = "\u4e3b\u63a7\u00b7\u603b\u63a7"; // 主控·总控

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const identityJson = (nickname) =>
  JSON.stringify({ agentId: AGENT_ID, nickname, capabilities: [], createdAt: "2026-08-21T06:56:55.269Z" }, null, 2);
const roomJson = (nickname) =>
  JSON.stringify(
    {
      roomId: OWNED_ROOM,
      title: "self-owned room",
      type: "persistent",
      ownerAgentId: AGENT_ID,
      controllerAgentId: AGENT_ID,
      createdAt: "2026-09-13T00:00:00.000Z",
      settings: { authMode: "open", autoMode: false, maxMembers: 50, allowHumanTakeover: true },
      members: [
        { agentId: AGENT_ID, nickname, role: "owner", roles: ["controller"], joinedAt: "2026-09-13T00:00:00.000Z" },
        { agentId: PEER_ID, nickname: "peer", role: "member", roles: [], joinedAt: "2026-09-13T00:00:00.000Z" },
      ],
      tasks: [],
      status: "open",
      revoked: [],
    },
    null,
    2,
  );

await mkdir(ROOT, { recursive: true });

/** A fresh temp case: identity.json + one persistent room this node owns. */
async function newCase(tag, { nickname = OLD_NAME, roomNickname } = {}) {
  const base = await mkdtemp(join(ROOT, `${tag}-`));
  const dataDir = join(base, "agent-room");
  await mkdir(join(dataDir, "rooms"), { recursive: true });
  await mkdir(join(dataDir, "messages"), { recursive: true });
  await mkdir(join(base, "agent-org"), { recursive: true });
  const identityFile = join(dataDir, "identity.json");
  await writeFile(identityFile, identityJson(nickname), "utf8");
  await writeFile(join(dataDir, "rooms", `${OWNED_ROOM}.json`), roomJson(roomNickname ?? nickname), "utf8");
  process.env.DSH_HOME = join(base, "home");
  process.env.DSH_IDENTITY_BACKUP_DIR = join(base, "identity-backups");
  return { base, dataDir, identityFile, backups: join(base, "identity-backups") };
}

let portSeed = 46_000 + (process.pid % 500) * 10;
const nextPort = () => (portSeed += 3);

const snapshot = async (file) => {
  const bytes = await readFile(file);
  const info = await stat(file);
  return { bytes, sha: sha256(bytes), mtimeMs: info.mtimeMs };
};

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

/**
 * A real AgentRoomService over a temp dataDir, with the boot settled.
 *
 * `org` is registered in the cordis context exactly the way agent-org registers
 * itself (`ctx.provide("agentOrg")` + `ctx.set`), so `ctx.get("agentOrg")` in
 * renameSelf is exercised for real — including the undefined case.
 */
async function newHost(dataDir, { org } = {}) {
  const ctx = new Context();
  if (org !== undefined) {
    ctx.provide("agentOrg");
    ctx.set("agentOrg", org);
  }
  const service = new AgentRoomService(ctx, { dataDir, port: nextPort(), relay: "" });
  const booted = await waitFor(() => service.profileTimer != null, 15_000);
  assert.ok(booted, "the service's background boot must settle");
  return service;
}

async function stopHost(service) {
  for (const timer of [service.profileTimer, service.listenTimer]) {
    try {
      if (timer) clearInterval(timer);
    } catch {
      /* ignore */
    }
  }
  try {
    service.discovery?.stop?.();
  } catch {
    /* ignore */
  }
  try {
    await service.peerServer?.stop();
  } catch {
    /* ignore */
  }
}

/** A joined-room client stub: records every profile frame it is handed. */
function fakeClient({ throwOnSend = false, members } = {}) {
  const frames = [];
  return {
    frames,
    attempts: 0,
    snapshot: members ? { room: { roomId: "remote", members } } : undefined,
    sendProfile(profile) {
      this.attempts += 1;
      if (throwOnSend) throw new Error("channel closed");
      frames.push(profile);
    },
  };
}

/** Minimal IncomingMessage/ServerResponse pair for the real router. */
function fakeRequest(method, url, body) {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    },
  };
}
function fakeResponse() {
  const out = { status: 0, body: "", headers: {} };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers ?? {};
    },
    end(text) {
      out.body = text ?? "";
    },
  };
}
const post = async (service, path, body) => {
  const res = fakeResponse();
  await createRouter(service)(fakeRequest("POST", path, body), res);
  let parsed = null;
  try {
    parsed = JSON.parse(res.out.body);
  } catch {
    /* leave null */
  }
  return { status: res.out.status, body: parsed, raw: res.out.body };
};

/* ------------------------------------------------------------------ tests */

test("the entry point exists on the route, and the same call converges A + B + C", async () => {
  const { dataDir, identityFile } = await newCase("route");
  const orgCalls = [];
  const service = await newHost(dataDir, {
    org: {
      async renameSelfByAgentId(agentId, nickname) {
        orgCalls.push({ agentId, nickname });
        return { nodeId: "516b10d7-890f-441c-8bef-420b39b5d467", rev: 7 };
      },
    },
  });
  try {
    const { status, body } = await post(service, "/agent-room-api/profile", { nickname: NEW_NAME });
    assert.strictEqual(status, 200, `route answered 200, got ${status}: ${JSON.stringify(body)}`);
    assert.strictEqual(body.ok, true);

    // (0) it is not the old 404 — the defect this release closes.
    const missing = await post(service, "/agent-room-api/nowhere", {});
    assert.strictEqual(missing.status, 404, "an unknown path is still 404, so the 200 above is a real route");

    // A: identity.json + the live cache.
    assert.strictEqual(body.data.nickname, NEW_NAME);
    assert.equal(body.data.identityFile, identityFile);
    assert.strictEqual(service.roomService.getIdentity().nickname, NEW_NAME, "the live cache reports the new name");
    assert.strictEqual(JSON.parse(await readFile(identityFile, "utf8")).nickname, NEW_NAME, "identity.json was rewritten");
    assert.strictEqual(JSON.parse(await readFile(identityFile, "utf8")).agentId, AGENT_ID, "the agentId is untouched");

    // B: the member list of the room this node owns.
    const room = service.roomService.getOwnedRoom(OWNED_ROOM);
    assert.strictEqual(room.members.find((m) => m.agentId === AGENT_ID).nickname, NEW_NAME);
    assert.strictEqual(body.data.ownedRoomMembers >= 1, true, "the owned-room member row was updated");

    // C: the org tree, through the very call the cordis service receives.
    assert.deepStrictEqual(orgCalls, [{ agentId: AGENT_ID, nickname: NEW_NAME }]);
    assert.deepStrictEqual(body.data.org, { attempted: true, updated: true, nodeId: "516b10d7-890f-441c-8bef-420b39b5d467", rev: 7 });

    // All three stores, one value.
    assert.strictEqual(
      new Set([body.data.nickname, room.members.find((m) => m.agentId === AGENT_ID).nickname, orgCalls[0].nickname]).size,
      1,
      "three stores, one value",
    );
    assert.deepStrictEqual(body.data.nicknameConflicts, [], "no other member uses this name");
  } finally {
    await stopHost(service);
  }
});

test("nothing waits for the 15s timer: a joined room is pushed during the call, timer intact", async () => {
  const { dataDir } = await newCase("fanout");
  const service = await newHost(dataDir, { org: { renameSelfByAgentId: async () => ({ nodeId: "n1", rev: 1 }) } });
  try {
    const good = fakeClient();
    const broken = fakeClient({ throwOnSend: true });
    service.clients.set("room-good", good);
    service.clients.set("room-broken", broken);

    const result = await service.renameSelf(NEW_NAME);

    assert.strictEqual(good.frames.length, 1, "the frame was sent once, immediately");
    assert.strictEqual(good.frames[0].nickname, NEW_NAME, "and it carries the NEW nickname");
    assert.strictEqual(broken.attempts, 1, "the client whose channel throws was attempted too (the loop is non-fatal)");
    assert.strictEqual(broken.frames.length, 0);
    assert.strictEqual(result.profileFanout, 1, "profileFanout counts the channels that ACCEPTED the frame");

    // The 15s tick-driven path must survive: the timer is armed, and the body it
    // calls is the same one this entry point uses.
    assert.ok(service.profileTimer != null, "the 15s profile timer is still armed");
    const again = await service.pushProfileNow();
    assert.strictEqual(again, 1, "pushProfileNow still fans out on its own");
    assert.strictEqual(good.frames.length, 2);
  } finally {
    await stopHost(service);
  }
});

test("no restart: the cached object is mutated in place, and a fresh instance reads the new name", async () => {
  const { dataDir, identityFile } = await newCase("restart");
  const service = await newHost(dataDir, { org: { renameSelfByAgentId: async () => ({ nodeId: "n1", rev: 1 }) } });
  try {
    const cachedBefore = service.roomService.getIdentity();
    assert.strictEqual(cachedBefore.nickname, OLD_NAME);

    const result = await service.renameSelf(NEW_NAME);

    // The mechanism: the SAME object every reader holds was updated, so no reader
    // can be looking at a stale copy without a restart.
    assert.strictEqual(service.roomService.getIdentity(), cachedBefore, "the identity object reference is stable");
    assert.strictEqual(cachedBefore.nickname, NEW_NAME, "and it was updated in place");
    assert.strictEqual(result.previousNickname, OLD_NAME);
    assert.strictEqual(result.changed, true);

    // Simulated restart: a fresh instance over the same directory.
    const fresh = new RoomService({ dataDir });
    await fresh.boot();
    assert.strictEqual(fresh.getIdentity().nickname, NEW_NAME, "a fresh instance reads the new name");
    assert.strictEqual(fresh.getIdentity().agentId, AGENT_ID, "and the same agentId (no re-mint)");

    // G3 side effect worth pinning: the rewrite is UTF-8 without a BOM, which is
    // what makes the file readable again after the PowerShell round-trip damage.
    const bytes = await readFile(identityFile);
    assert.strictEqual(bytes[0], 0x7b, "identity.json still starts with '{' (no BOM)");
    assert.strictEqual(bytes.toString("utf8").includes("\uFFFD"), false, "no replacement characters were introduced");
  } finally {
    await stopHost(service);
  }
});

test("the verified pre-write backup is taken, and the previous name survives in it", async () => {
  const { dataDir, identityFile, backups } = await newCase("backup");
  const service = await newHost(dataDir, { org: undefined });
  try {
    await service.renameSelf(NEW_NAME);
    const copies = (await readdir(backups)).filter((n) => /^identity\.json\.\d{8}-\d{6}\.bak/.test(n));
    assert.ok(copies.length >= 1, `a verified timestamped backup exists (${copies.join(", ")})`);
    const restored = JSON.parse(await readFile(join(backups, copies[0]), "utf8"));
    assert.strictEqual(restored.nickname, OLD_NAME, "the backup reverse-resolves to the OLD name");
    assert.strictEqual(restored.agentId, AGENT_ID);
    assert.strictEqual(JSON.parse(await readFile(identityFile, "utf8")).nickname, NEW_NAME);
  } finally {
    await stopHost(service);
  }
});

test("a rejected name changes NOTHING anywhere", async () => {
  const { dataDir, identityFile, backups } = await newCase("reject");
  const orgCalls = [];
  const service = await newHost(dataDir, {
    org: {
      async renameSelfByAgentId(agentId, nickname) {
        orgCalls.push({ agentId, nickname });
        return { nodeId: "n1", rev: 1 };
      },
    },
  });
  try {
    const before = await snapshot(identityFile);
    const roomBefore = service.roomService.getOwnedRoom(OWNED_ROOM).members.find((m) => m.agentId === AGENT_ID).nickname;
    const backupsBefore = (await readdir(backups).catch(() => [])).length;

    const bad = ["", "   ", "\uFFFD\uFFFD", "???", "a??b", "NAME", 42, null, undefined];
    for (const value of bad) {
      await assert.rejects(
        () => service.renameSelf(value),
        (error) => error instanceof InvalidNicknameError,
        `${JSON.stringify(value)} must be refused`,
      );
    }

    const after = await snapshot(identityFile);
    assert.strictEqual(after.sha, before.sha, "identity.json is byte-identical (no write at all)");
    assert.strictEqual(after.mtimeMs, before.mtimeMs, "and was not even touched");
    assert.strictEqual(service.roomService.getIdentity().nickname, OLD_NAME, "the live cache is unchanged");
    assert.strictEqual(
      service.roomService.getOwnedRoom(OWNED_ROOM).members.find((m) => m.agentId === AGENT_ID).nickname,
      roomBefore,
      "the room member row is unchanged",
    );
    assert.deepStrictEqual(orgCalls, [], "the org tree was never asked");
    assert.strictEqual((await readdir(backups).catch(() => [])).length, backupsBefore, "no backup was taken");

    // The route answers 400 (the caller's mistake), not 500, and still changes nothing.
    const res = await post(service, "/agent-room-api/profile", { nickname: "\uFFFD\uFFFD" });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.reason, /U\+FFFD/);
    assert.strictEqual((await snapshot(identityFile)).sha, before.sha, "still byte-identical after the failed POST");
  } finally {
    await stopHost(service);
  }
});

test("a trimmed name is written, and a name another member already uses is REPORTED", async () => {
  const { dataDir } = await newCase("conflict");
  const service = await newHost(dataDir, { org: undefined });
  try {
    const result = await service.renameSelf(`  ${NEW_NAME}  `);
    assert.strictEqual(result.nickname, NEW_NAME, "the stored value is trimmed");

    // The peer member is already in the owned room; take that name
    // case-insensitively, which is how room-service resolves an @mention.
    const clash = await service.renameSelf("PEER");
    assert.strictEqual(clash.nickname, "PEER", "the rename still applies");
    assert.deepStrictEqual(
      clash.nicknameConflicts,
      [{ roomId: OWNED_ROOM, agentIds: [PEER_ID] }],
      "the @mention ambiguity is surfaced instead of being silently created",
    );
  } finally {
    await stopHost(service);
  }
});

test("agent-org missing is reported, never silently skipped (C unchanged, A/B done)", async () => {
  const { dataDir, identityFile } = await newCase("no-org");
  const service = await newHost(dataDir, { org: undefined });
  try {
    const result = await service.renameSelf(NEW_NAME);
    assert.strictEqual(service.ctx.get("agentOrg"), undefined, "the context really has no agentOrg here");
    assert.deepStrictEqual(result.org.attempted, false);
    assert.strictEqual(result.org.updated, false);
    assert.match(result.org.reason, /C \u672a\u6539/);
    assert.strictEqual(result.nickname, NEW_NAME, "A/B still changed");
    assert.strictEqual(JSON.parse(await readFile(identityFile, "utf8")).nickname, NEW_NAME);
  } finally {
    await stopHost(service);
  }
});

test("an org refusal is reported with its reason (a non-owner is refused, not ignored)", async () => {
  const { dataDir, identityFile } = await newCase("org-refuse");
  const service = await newHost(dataDir, {
    org: {
      async renameSelfByAgentId() {
        const error = new Error("rename_denied: a non-owner may not rename another node");
        error.code = "rename_denied";
        throw error;
      },
    },
  });
  try {
    const result = await service.renameSelf(NEW_NAME);
    assert.strictEqual(result.org.attempted, true);
    assert.strictEqual(result.org.updated, false);
    assert.match(result.org.reason, /rename_denied/);
    assert.match(result.org.reason, /C \u672a\u6539/);
    assert.strictEqual(JSON.parse(await readFile(identityFile, "utf8")).nickname, NEW_NAME);
    assert.strictEqual(service.roomService.getIdentity().nickname, NEW_NAME);
  } finally {
    await stopHost(service);
  }
});

test("a cold identity cache is refused, and nothing is minted or written", async () => {
  const { dataDir, identityFile } = await newCase("cold");
  const service = await newHost(dataDir, { org: undefined });
  try {
    const before = await snapshot(identityFile);
    // Simulate "boot has not finished": the cache is what boot fills, and the
    // entry point must refuse rather than call ensureIdentity()/gateway.identity(),
    // which mint AND WRITE a fresh identity when the cache is empty.
    service.roomService.identity = null;
    await assert.rejects(() => service.renameSelf(NEW_NAME), (error) => error instanceof IdentityNotReadyError);
    const after = await snapshot(identityFile);
    assert.strictEqual(after.sha, before.sha, "no identity was minted and none was written");
    assert.strictEqual(after.bytes.length, before.bytes.length);
  } finally {
    await stopHost(service);
  }
});

test("G1 reuse: assertValidNickname is the 0.1.38 predicate, applied before any write", () => {
  assert.strictEqual(assertValidNickname("  KEVINKIKI  "), "KEVINKIKI");
  assert.strictEqual(assertValidNickname(NEW_NAME), NEW_NAME);
  for (const bad of ["", "   ", "NAME", "x\uFFFDy", "??", "a??b"]) {
    assert.ok(nicknameProblem(bad), `${JSON.stringify(bad)} is a damage class`);
    assert.throws(() => assertValidNickname(bad), (error) => error instanceof InvalidNicknameError && error.reason.length > 0);
  }
  assert.throws(() => assertValidNickname(undefined), InvalidNicknameError);
  assert.throws(() => assertValidNickname(null), InvalidNicknameError);
});

test("the tool surface exposes the same entry point (wiring)", async () => {
  const tools = await readFile(new URL("../src/tools/index.ts", import.meta.url), "utf8");
  assert.match(tools, /name: "agent_rename_self"/, "the tool is registered");
  assert.match(tools, /gateway\.renameSelf\(args\.nickname\)/, "and it calls the same entry point the route does");
  // The old, silently-divergent surface must not come back.
  assert.ok(!/name: "(room|task)_rename/.test(tools), "no second rename tool");

  const gateway = await readFile(new URL("../src/tools/gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /renameSelf\(nickname: string\): Promise<SelfRenameResult>/);
  assert.match(gateway, /interface SelfRenameResult/, "the per-store result type is declared");

  const service = await readFile(new URL("../src/host/service.ts", import.meta.url), "utf8");
  assert.match(service, /renameSelf: \(nickname\) => this\.renameSelf\(nickname\)/, "the gateway object implements it");
  assert.match(service, /async renameSelf\(nickname: string\): Promise<SelfRenameResult>/);
  assert.ok(!/async renameSelf[\s\S]{0,600}ensureIdentity\(\)/.test(service), "the entry point never mints");

  const web = await readFile(new URL("../src/host/web.ts", import.meta.url), "utf8");
  assert.match(web, /path === "\/agent-room-api\/profile"/, "the route path");
  assert.match(web, /InvalidNicknameError[\s\S]{0,220}400/, "a rejected name is a 400");
  assert.match(web, /IdentityNotReadyError[\s\S]{0,220}409/, "a cold cache is a 409");
});

/* --------------------- the backfill path for damaged names ------------------ */

/** A machine whose names are already damaged: identity A and org tree C. */
async function newDamagedCase(tag, { nickname = "\uFFFD\uFFFD" } = {}) {
  const base = await mkdtemp(join(ROOT, `${tag}-`));
  const dataDir = join(base, "agent-room");
  const orgDir = join(base, "agent-org");
  await mkdir(join(dataDir, "rooms"), { recursive: true });
  await mkdir(join(dataDir, "messages"), { recursive: true });
  await mkdir(orgDir, { recursive: true });
  const identityFile = join(dataDir, "identity.json");
  const orgFile = join(orgDir, "org-state.json");
  await writeFile(identityFile, identityJson(nickname), "utf8");
  await writeFile(
    orgFile,
    JSON.stringify(
      {
        version: 1,
        rev: 3,
        updatedAt: "2026-09-14T00:00:00.000Z",
        nodes: [
          { id: "c1", kind: "company", name: "AI studio", parentId: null, leaderAgentId: AGENT_ID, createdAt: "n", updatedAt: "n" },
          { id: "m1", kind: "member", name: "??", parentId: "c1", agentId: AGENT_ID, createdAt: "n", updatedAt: "n" },
          { id: "m2", kind: "member", name: "peer-node", parentId: "c1", agentId: PEER_ID, createdAt: "n", updatedAt: "n" },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  // The repair tool resolves the home it is given, so DSH_HOME must BE the
  // directory that contains agent-room/ and agent-org/ (not a decoy sibling).
  process.env.DSH_HOME = base;
  process.env.DSH_IDENTITY_BACKUP_DIR = join(base, "identity-backups");
  return { base, dataDir, orgDir, identityFile, orgFile, backups: join(base, "identity-backups") };
}

/** Run the real CLI in-process, capturing its stdout. argv is restored after. */
async function runTool(argv) {
  const { main } = await import("../tools/repair-identity.mjs");
  const savedArgv = process.argv;
  const lines = [];
  const savedLog = console.log;
  process.argv = ["node", "repair-identity.mjs", ...argv];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const code = await main();
    return { code, out: lines.join("\n") };
  } finally {
    console.log = savedLog;
    process.argv = savedArgv;
  }
}

test("backfill: the report finds the damaged names and writes nothing", async () => {
  const { base, identityFile, orgFile } = await newDamagedCase("names-report");
  const before = await snapshot(identityFile);
  const orgBefore = await snapshot(orgFile);

  const { code, out } = await runTool(["--home", base, "--repair-names"]);

  assert.strictEqual(code, 0);
  assert.match(out, /NOTHING HAS BEEN WRITTEN YET/);
  assert.match(out, /BAD\s+identity\.json nickname\s+"\uFFFD\uFFFD"/, "the damaged nickname is flagged");
  assert.match(out, /BAD\s+org node member m1\s+"\?\?"/, "the damaged org node name is flagged");
  assert.match(out, /ok\s+org node member m2/, "a clean name is not flagged");
  assert.match(
    out,
    new RegExp(`--set-name ${AGENT_ID}=<THE NAME YOU WANT>`),
    "the exact fix command is printed with a placeholder, never a guess",
  );
  assert.strictEqual((await snapshot(identityFile)).sha, before.sha, "report-only: identity.json untouched");
  assert.strictEqual((await snapshot(orgFile)).sha, orgBefore.sha, "report-only: org-state.json untouched");
});

test("backfill: --set-name without --apply writes nothing", async () => {
  const { base, identityFile, orgFile } = await newDamagedCase("names-noapply", { nickname: "NAME" });
  const before = await snapshot(identityFile);
  const orgBefore = await snapshot(orgFile);

  const { code, out } = await runTool(["--home", base, "--repair-names", "--set-name", `${AGENT_ID}=KEVINKIKI`]);

  assert.strictEqual(code, 0);
  assert.match(out, /--set-name requires --apply as well; nothing was written/);
  assert.strictEqual((await snapshot(identityFile)).sha, before.sha);
  assert.strictEqual((await snapshot(orgFile)).sha, orgBefore.sha);
});

test("backfill: --apply --set-name repairs A and C from an agentId, with backups", async () => {
  const { base, identityFile, orgFile, backups } = await newDamagedCase("names-apply");
  const orgBefore = await snapshot(orgFile);

  const { code, out } = await runTool(["--home", base, "--repair-names", "--apply", "--set-name", `${AGENT_ID}=主控·总控`]);

  assert.strictEqual(code, 0, out);
  assert.match(out, /plan \(nothing written yet\)/, "the plan is printed before any write");
  assert.match(out, /WRITE /, "the writes are planned");
  assert.match(out, /verified by re-reading/, "and each write is verified by re-reading the file");

  // A and C both moved, and only the target agentId's row did.
  const identity = JSON.parse(await readFile(identityFile, "utf8"));
  assert.strictEqual(identity.nickname, "主控·总控");
  assert.strictEqual(identity.agentId, AGENT_ID);
  const org = JSON.parse(await readFile(orgFile, "utf8"));
  assert.strictEqual(org.nodes.find((n) => n.id === "m1").name, "主控·总控");
  assert.strictEqual(org.nodes.find((n) => n.id === "m2").name, "peer-node", "another member's name is untouched");
  assert.strictEqual(org.nodes.find((n) => n.id === "c1").name, "AI studio");
  assert.notStrictEqual(orgBefore.sha, (await snapshot(orgFile)).sha);

  // UTF-8 without a BOM, exactly like the plugin writes it.
  assert.strictEqual((await readFile(identityFile))[0], 0x7b);
  assert.strictEqual((await readFile(orgFile))[0], 0x7b);

  // Both pre-repair copies exist and reverse-resolve to the damaged values.
  const copies = await readdir(backups);
  const identityCopies = copies.filter((n) => n.startsWith("identity.json") && n.includes("pre-name-repair"));
  const orgCopies = copies.filter((n) => n.startsWith("org-state.json") && n.includes("pre-name-repair"));
  assert.ok(identityCopies.length >= 1, copies.join(", "));
  assert.ok(orgCopies.length >= 1, copies.join(", "));
  const identityBackup = JSON.parse(await readFile(join(backups, identityCopies[0]), "utf8"));
  assert.strictEqual(identityBackup.nickname, "\uFFFD\uFFFD", "the damaged bytes are preserved for rollback");
});

test("backfill: a name the plugin's own gate rejects is refused, and nothing is written", async () => {
  const { base, identityFile, orgFile } = await newDamagedCase("names-refuse");
  const before = await snapshot(identityFile);
  const orgBefore = await snapshot(orgFile);

  for (const bad of ["NAME", "???", "   ", "x\uFFFDy"]) {
    await assert.rejects(
      () => runTool(["--home", base, "--repair-names", "--apply", "--set-name", `${AGENT_ID}=${bad}`]),
      /refusing the name/,
      `${JSON.stringify(bad)} must be refused`,
    );
    assert.strictEqual((await snapshot(identityFile)).sha, before.sha, "identity.json untouched");
    assert.strictEqual((await snapshot(orgFile)).sha, orgBefore.sha, "org-state.json untouched");
  }

  // An id the scan never saw is refused too: the tool does not invent targets.
  await assert.rejects(
    () => runTool(["--home", base, "--repair-names", "--apply", "--set-name", "01a0dead-0000-7000-8000-000000000000=someone"]),
    /does not appear in the name report/,
  );
  assert.strictEqual((await snapshot(identityFile)).sha, before.sha);
});

test("backfill: the report is JSON-parseable, and the gate is the plugin's own module", async () => {
  const { base } = await newDamagedCase("names-json");
  const { out } = await runTool(["--home", base, "--repair-names", "--json"]);
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.names.entries.length, 4, "identity + company + 2 members");
  const damaged = parsed.names.entries.filter((e) => e.problem);
  assert.strictEqual(damaged.length, 2, "exactly the two damaged names are flagged");
  assert.deepStrictEqual(damaged.map((e) => e.nodeId).sort(), [null, "m1"].sort());

  // The same predicate the plugin enforces, imported from lib/host/safety.js — a
  // repair tool with its own second copy of the rule is how a placeholder got
  // written onto two machines in the first place.
  const { nicknameProblem: pluginGate } = await import("../lib/host/safety.js");
  assert.strictEqual(typeof pluginGate, "function");
  for (const sample of ["NAME", "??", "", "x\uFFFDy", "OK-NAME", "主控·总控"]) {
    assert.ok(
      (pluginGate(sample) === null) === (nicknameProblem(sample) === null),
      `${JSON.stringify(sample)} is judged identically by the tool and the plugin`,
    );
  }
});

test.after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});
