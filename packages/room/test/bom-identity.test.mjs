/**
 * bom-identity.test.mjs — card-00 P0.
 *
 * A config file that is PRESENT but unparseable must never be mistaken for a
 * MISSING one, because for `identity.json` that mistake mints a fresh agentId and
 * OVERWRITES the original. The agentId keys room ownership, membership, task
 * permissions, org membership and audit attribution, and identity does not
 * converge across machines — so that loss is irreversible.
 *
 * This file runs in two halves on purpose:
 *   1. it pins the OLD read+mint path as a replica and shows it minting and
 *      destroying the file (the defect, reproduced);
 *   2. it drives the REAL built plugin and shows the new semantics.
 *
 * Every case writes only under `<workdir>\_bom-tests\` and points both DSH_HOME and
 * DSH_IDENTITY_BACKUP_DIR at that temp tree, so no real configuration is read or
 * written. Run directly:  node test/bom-identity.test.mjs
 */

import assert from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { RoomService } from "../lib/host/room-service.js";
import { Persistence } from "../lib/host/persistence.js";
import { AgentRoomService } from "../lib/host/service.js";
import { Context } from "@deepseek-ai/cordis";
import {
  BACKUP_KEEP,
  CorruptConfigError,
  assertPlatformResolvableFor,
  clearRefusedMarker,
  ensureBackupRoot,
  failLoud,
  isUuidShaped,
  nicknameProblem,
  readJsonConfig,
  refusedMarkerPresent,
  resolveBackupRoot,
  stripBom,
} from "../lib/host/safety.js";

const ROOT = join(tmpdir(), "dsh-agent-room-bom-tests");
const AGENT_ID = "01a0231b-bbe5-720a-97a4-819744eeae76";
const OTHER_ID = "01a09dac-3793-77b1-b6e8-9e4ebdb4041e";
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const identityJson = (agentId = AGENT_ID, nickname = "*****") =>
  JSON.stringify({ agentId, nickname, capabilities: [], createdAt: "2026-08-21T06:56:55.269Z" }, null, 2);

await mkdir(ROOT, { recursive: true });

/**
 * A fresh temp case. Both environment variables are pointed at it, because both
 * defaults would otherwise resolve inside a real user profile.
 */
async function newCase(tag) {
  const base = await mkdtemp(join(ROOT, `${tag}-`));
  const dataDir = join(base, "agent-room");
  await mkdir(join(dataDir, "rooms"), { recursive: true });
  await mkdir(join(dataDir, "messages"), { recursive: true });
  await mkdir(join(base, "agent-org"), { recursive: true });
  const backups = join(base, "backups");
  process.env.DSH_HOME = join(base, "home");
  process.env.DSH_IDENTITY_BACKUP_DIR = backups;
  return { base, dataDir, backups, identityFile: join(dataDir, "identity.json") };
}

async function seed(file, text, withBom = false) {
  const body = Buffer.from(text, "utf8");
  await writeFile(file, withBom ? Buffer.concat([BOM, body]) : body);
}

async function snapshot(file) {
  const bytes = await readFile(file);
  const info = await stat(file);
  return { bytes, sha: sha256(bytes), mtimeMs: info.mtimeMs, size: bytes.length };
}

const corruptList = async (backups, prefix) => {
  try {
    return (await readdir(backups)).filter((n) => n.startsWith(prefix)).sort();
  } catch {
    return [];
  }
};

/* ------------------------------------------------------------------ *
 * HALF 1 — the OLD behaviour, pinned.
 *
 * This is a verbatim behavioural replica of the code that shipped in 0.1.37:
 *   persistence.ts:68-75        readJson: catch { return null }  (no ENOENT
 *                               discrimination, no BOM strip, no log)
 *   room-service.ts:97-113      ensureIdentity: if (existing) ... else mint +
 *                               saveIdentity(fresh)  -> overwrite
 *
 * It exists because the real 0.1.37 artifact cannot be rebuilt inside a test; its
 * genuine output is captured in docs/RELEASE-0.1.38.md from `_probe-identity-real.mjs`
 * run against the real compiled 0.1.37 lib/ before the fix was built.
 * ------------------------------------------------------------------ */

async function legacyReadJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function legacyEnsureIdentity(dataDir) {
  const file = join(dataDir, "identity.json");
  const existing = await legacyReadJson(file);
  if (existing) return existing;
  const fresh = { agentId: OTHER_ID, nickname: "MINTED", capabilities: [], createdAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(fresh, null, 2), "utf8");
  return fresh;
}

test("OLD (0.1.37, pinned replica): a BOM'd identity.json mints a new agentId and destroys the original", async () => {
  const { dataDir, identityFile } = await newCase("old-repro");
  await seed(identityFile, identityJson(), true);
  const before = await snapshot(identityFile);

  const minted = await legacyEnsureIdentity(dataDir);
  const after = await snapshot(identityFile);

  assert.equal(await legacyReadJson(identityFile).then((v) => v.agentId), OTHER_ID);
  assert.notEqual(minted.agentId, AGENT_ID, "the replica mints a different id");
  assert.notEqual(after.sha, before.sha, "the original bytes are gone");
  assert.equal(await legacyReadJson(identityFile).then((v) => v.nickname), "MINTED");
  // Same input, same code path, BOM removed: the identity survives. This is the
  // control that proves the BOM (not the content) is what triggers the loss.
  const { dataDir: cleanDir, identityFile: cleanFile } = await newCase("old-control");
  await seed(cleanFile, identityJson(), false);
  const kept = await legacyEnsureIdentity(cleanDir);
  assert.equal(kept.agentId, AGENT_ID, "without a BOM the replica keeps the id");
});

/* ------------------------------------------------------------------ *
 * HALF 2 — the NEW behaviour, against the real plugin.
 * ------------------------------------------------------------------ */

test("NEW: a BOM is tolerated — same agentId, and the file is byte-identical", async () => {
  const { dataDir, backups, identityFile } = await newCase("new-bom");
  await seed(identityFile, identityJson(), true);
  const before = await snapshot(identityFile);

  const identity = await new RoomService({ dataDir }).ensureIdentity();
  const after = await snapshot(identityFile);

  assert.equal(identity.agentId, AGENT_ID, "the BOM'd identity is read, not replaced");
  assert.equal(after.sha, before.sha, "sha256 unchanged");
  assert.equal(after.mtimeMs, before.mtimeMs, "mtime unchanged");
  assert.equal(after.size, before.size, "still the byte-identical body plus its 3-byte BOM");
  assert.deepEqual(await corruptList(backups, "identity.json"), [], "nothing was quarantined: a BOM is not damage");
});

test("NEW: an unparseable identity.json throws, mints nothing, and keeps the original byte-identical", async () => {
  const { dataDir, backups, identityFile } = await newCase("new-corrupt");
  // Truncated write, no BOM: unambiguously damaged, and not fixable by stripping.
  await seed(identityFile, '{\n  "agentId": "01a0231b-bbe5-720a-97a4-819744eeae76",\n  "nickname": "KEV');
  const before = await snapshot(identityFile);

  const service = new RoomService({ dataDir });
  await assert.rejects(
    () => service.ensureIdentity(),
    (error) => {
      assert.equal(error.name, "CorruptConfigError");
      assert.ok(error instanceof CorruptConfigError);
      assert.equal(error.file, identityFile, "the error names the file to fix");
      assert.match(error.message, /present but not parseable/);
      return true;
    },
  );

  const after = await snapshot(identityFile);
  assert.equal(after.sha, before.sha, "the damaged file is never rewritten");
  assert.equal(after.mtimeMs, before.mtimeMs, "and never even touched");

  const quarantined = await corruptList(backups, "identity.json");
  assert.equal(quarantined.length, 1, "a quarantine copy was taken before throwing");
  assert.match(quarantined[0], /^identity\.json\.\d{8}-\d{6}\.corrupt\.bak$/);
  const copy = await readFile(join(backups, quarantined[0]));
  assert.equal(sha256(copy), before.sha, "the quarantine copy is byte-identical");

  const marker = join(dataDir, "REFUSED-TO-START");
  assert.ok(existsSync(marker), "the watchdog marker was written");
  const markerText = await readFile(marker, "utf8");
  assert.ok(markerText.includes(identityFile), "the marker names the damaged file");
  assert.match(markerText, /corrupt config/);
});

test("NEW: the write boundary also refuses to overwrite a damaged identity.json", async () => {
  const { dataDir, identityFile } = await newCase("new-write-guard");
  await seed(identityFile, "{ not json at all");
  const before = await snapshot(identityFile);
  const persistence = new Persistence(dataDir);

  await assert.rejects(
    () => persistence.saveIdentity({ agentId: OTHER_ID, nickname: "x", capabilities: [], createdAt: "n" }),
    (error) => error.name === "CorruptConfigError",
  );
  const after = await snapshot(identityFile);
  assert.equal(after.sha, before.sha, "still byte-identical after a save attempt");
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("NEW: a missing identity.json still mints (first-run semantics unchanged)", async () => {
  const { dataDir, backups, identityFile } = await newCase("new-missing");
  const identity = await new RoomService({ dataDir }).ensureIdentity();
  assert.ok(isUuidShaped(identity.agentId), `minted a UUID: ${identity.agentId}`);
  assert.ok(existsSync(identityFile), "the minted identity was persisted");
  assert.deepEqual(await corruptList(backups, "identity.json"), [], "nothing to back up on a first write");
  assert.ok(!existsSync(join(dataDir, "REFUSED-TO-START")), "no marker for a clean first run");
});

test("NEW: every config reader tolerates a BOM", async () => {
  const { dataDir, identityFile } = await newCase("new-bom-all");
  const persistence = new Persistence(dataDir);
  const room = { roomId: OTHER_ID, title: "room", ownerAgentId: AGENT_ID, members: [], tasks: [], settings: {}, status: "open", createdAt: "n" };

  await seed(identityFile, identityJson(), true);
  await seed(join(dataDir, "joined.json"), JSON.stringify([{ roomId: OTHER_ID, address: "127.0.0.1:1", title: "r" }]), true);
  await seed(join(dataDir, "relay-secrets.json"), JSON.stringify({ [OTHER_ID]: "tok" }), true);
  await seed(join(dataDir, "rooms", `${OTHER_ID}.json`), JSON.stringify(room), true);

  assert.equal((await persistence.loadIdentity()).agentId, AGENT_ID);
  assert.equal((await persistence.loadJoined()).length, 1, "joined.json with a BOM still parses");
  assert.equal((await persistence.loadRelaySecrets())[OTHER_ID], "tok", "relay secrets with a BOM still parse");
  assert.equal((await persistence.loadPersistentRooms()).length, 1, "rooms/<id>.json with a BOM still parses");

  // relay-config.json and reply-agent.json are read by the host, through the same entry point.
  const relayFile = join(dataDir, "relay-config.json");
  const replyFile = join(dataDir, "reply-agent.json");
  await seed(relayFile, JSON.stringify({ relay: "ws://127.0.0.1:9320" }), true);
  await seed(replyFile, JSON.stringify({ replyAgentId: "abc" }), true);
  assert.equal((await readJsonConfig(relayFile)).relay, "ws://127.0.0.1:9320");
  assert.equal((await readJsonConfig(replyFile)).replyAgentId, "abc");

  // A BOM'd message log must not silently drop its first (oldest) line.
  const log = join(dataDir, "messages", `${OTHER_ID}.jsonl`);
  await seed(log, `${JSON.stringify({ seq: 1, from: AGENT_ID, text: "first" })}\n${JSON.stringify({ seq: 2, from: AGENT_ID, text: "second" })}\n`, true);
  const recent = await persistence.loadRecentMessages(OTHER_ID);
  assert.deepEqual(recent.map((m) => m.seq), [1, 2], "the BOM'd first line survived");
});

test("NEW: every config reader is loud about damage instead of returning empty", async () => {
  const { dataDir, backups } = await newCase("new-corrupt-all");
  const persistence = new Persistence(dataDir);
  const broken = "{\"truncated\": tru";

  await seed(join(dataDir, "joined.json"), broken);
  await seed(join(dataDir, "relay-secrets.json"), broken);
  await seed(join(dataDir, "rooms", `${OTHER_ID}.json`), broken);
  await seed(join(dataDir, "relay-config.json"), broken);
  await seed(join(dataDir, "reply-agent.json"), broken);

  const cases = [
    ["joined.json", () => persistence.loadJoined()],
    ["relay-secrets.json", () => persistence.loadRelaySecrets()],
    ["rooms json", () => persistence.loadPersistentRooms()],
    ["relay-config.json", () => readJsonConfig(join(dataDir, "relay-config.json"))],
    ["reply-agent.json", () => readJsonConfig(join(dataDir, "reply-agent.json"))],
  ];
  for (const [label, run] of cases) {
    await assert.rejects(run, (error) => error.name === "CorruptConfigError", `${label} must be fatal, not empty`);
  }
  const quarantined = await readdir(backups);
  for (const name of ["joined.json", "relay-secrets.json", "relay-config.json", "reply-agent.json"]) {
    assert.ok(quarantined.some((n) => n.startsWith(`${name}.`) && n.endsWith(".corrupt.bak")), `${name} was quarantined`);
  }

  // Append-only history is the documented exception: a damaged LINE is skipped,
  // never fatal, because the file is never overwritten so no evidence is at risk.
  const log = join(dataDir, "messages", `${OTHER_ID}.jsonl`);
  await seed(log, `${JSON.stringify({ seq: 1, from: AGENT_ID, text: "ok" })}\n{oops\n${JSON.stringify({ seq: 3, from: AGENT_ID, text: "ok" })}\n`);
  assert.deepEqual((await persistence.loadRecentMessages(OTHER_ID)).map((m) => m.seq), [1, 3]);
});

test("NEW: the second minting entry point cannot mint over a damaged file either", async () => {
  const { dataDir, identityFile } = await newCase("new-gateway");
  await seed(identityFile, "{ damaged");
  const before = await snapshot(identityFile);
  const service = new RoomService({ dataDir });

  // gateway.identity() delegates to ensureIdentity(), so the snapshot path an
  // agent-org frame uses is the same minting path. It must throw every time, not
  // mint on the second attempt once boot's failure has been swallowed.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(() => service.ensureIdentity(), (e) => e.name === "CorruptConfigError");
  }
  // The real wiring is asserted too, because this delegation is what makes the
  // above equivalent to gateway.identity().
  const compiled = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "host", "service.js"), "utf8");
  assert.match(compiled, /identity:\s*\(\)\s*=>\s*this\.roomService\.ensureIdentity\(\)/);
  const after = await snapshot(identityFile);
  assert.equal(after.sha, before.sha, "three failed attempts left the file untouched");
});

test("NEW: an identity write takes a verified timestamped backup first, and retention is bounded", async () => {
  const { dataDir, backups, identityFile } = await newCase("new-backup");
  await seed(identityFile, identityJson());
  const persistence = new Persistence(dataDir);
  const before = await snapshot(identityFile);

  await persistence.saveIdentity({ agentId: AGENT_ID, nickname: "RENAMED", capabilities: [], createdAt: "2026-08-21T06:56:55.269Z" });
  const made = await corruptList(backups, "identity.json");
  assert.equal(made.length, 1, "exactly one backup for the one overwrite");
  assert.match(made[0], /^identity\.json\.\d{8}-\d{6}\.bak$/);
  assert.equal(sha256(await readFile(join(backups, made[0]))), before.sha, "the backup holds the pre-write bytes");

  for (let i = 0; i < 14; i += 1) {
    await persistence.saveIdentity({ agentId: AGENT_ID, nickname: `R${i}`, capabilities: [], createdAt: "2026-08-21T06:56:55.269Z" });
  }
  const ordinary = (await corruptList(backups, "identity.json")).filter((n) => /\.bak(\.\d+)?$/.test(n) && !n.includes(".corrupt."));
  assert.ok(ordinary.length <= BACKUP_KEEP, `retention bounded to ${BACKUP_KEEP}, saw ${ordinary.length}`);

  // A quarantine copy is evidence: routine backup churn must not prune it away.
  await seed(identityFile, "{ damaged again");
  await assert.rejects(() => persistence.saveIdentity({ agentId: OTHER_ID, nickname: "x", capabilities: [], createdAt: "n" }), (e) => e.name === "CorruptConfigError");
  const quarantines = (await readdir(backups)).filter((n) => n.endsWith(".corrupt.bak"));
  assert.ok(quarantines.length > 0, "a quarantine copy was taken");
  // Repair the file (as the repair tool would), then write again: the ordinary
  // backup churn this triggers must leave the quarantine copies alone.
  await seed(identityFile, identityJson(AGENT_ID, "REPAIRED"));
  await persistence.saveIdentity({ agentId: AGENT_ID, nickname: "after", capabilities: [], createdAt: "n" });
  for (const name of quarantines) {
    assert.ok(existsSync(join(backups, name)), `the quarantine copy ${name} survived pruning`);
  }
});

test("NEW: the backup root is derived per platform, never a hardcoded drive letter", async () => {
  const home = "C:\\work\\.dsh";
  process.env.DSH_HOME = home;
  delete process.env.DSH_IDENTITY_BACKUP_DIR;
  assert.equal(resolveBackupRoot(), join(dirname(home), "identity-backups"), "a sibling of the DSH home, not inside it");
  assert.ok(!resolveBackupRoot().startsWith(home), "never inside the config directory (that would pollute the BOM scan range)");

  process.env.DSH_IDENTITY_BACKUP_DIR = "D:\\explicit\\dir";
  assert.equal(resolveBackupRoot(), "D:\\explicit\\dir", "the environment override wins");

  // The card's must-fix: a Windows-only root on the team's macOS node must be a
  // fatal config error, not "every identity write is refused".
  assert.throws(() => assertPlatformResolvableFor("C:\\work\\identity-backups", "darwin"), /Windows-only path/);
  assert.throws(() => assertPlatformResolvableFor("\\\\server\\share\\backups", "darwin"), /Windows-only path/);
  assert.doesNotThrow(() => assertPlatformResolvableFor("/Users/example/.dsh-backups", "darwin"));
  assert.doesNotThrow(() => assertPlatformResolvableFor("C:\\work\\identity-backups", "win32"));
  assert.throws(() => assertPlatformResolvableFor("relative\\path", "win32"), /not absolute/);

  // And the root is proven writable at boot, so an unusable one stops the node
  // rather than failing later, per write.
  const { base } = await newCase("new-root");
  const root = await ensureBackupRoot();
  assert.ok(existsSync(root));
  assert.ok(root.startsWith(base), "the temp override was honoured");
});

test("NEW: the boot rejection is loud, and it is the same error the host fatal path receives", async () => {
  // failLoud is the exact handler the room host installs; a logger call alone
  // (0.1.37) left the process alive with the whole room host dead.
  const logged = [];
  const boom = new CorruptConfigError("C:\\x\\identity.json", "Unexpected token", undefined, null);
  assert.throws(
    () => failLoud("[agent-room]", boom, { error: (...args) => logged.push(args) }),
    (error) => error === boom, // identity preserved: the host inspects the error object
  );
  assert.equal(logged.length, 1, "logged exactly once, at error level");
  assert.equal(logged[0][0], "[agent-room] boot failed: %s");
  assert.match(String(logged[0][1]), /CorruptConfigError/);

  // The real boot() rejects with CorruptConfigError, which is what makes the
  // fatal path reachable at all.
  const { dataDir, identityFile } = await newCase("new-boot-reject");
  await seed(identityFile, "{ damaged on purpose");
  const service = new RoomService({ dataDir });
  await assert.rejects(() => service.boot(), (error) => error.name === "CorruptConfigError" && error.file === identityFile);
});

test("NEW: a boot that reaches the end clears the watchdog marker", async () => {
  const { dataDir } = await newCase("new-boot-clear");
  const marker = join(dataDir, "REFUSED-TO-START");
  await seed(marker, "2026-09-14T00:00:00.000Z\nleft over from an earlier failure\n");
  assert.ok(await refusedMarkerPresent(dataDir), "marker present before boot");

  const port = 45_000 + (process.pid % 2_000);
  const service = new AgentRoomService(new Context(), { dataDir, port, relay: "" });
  try {
    // The service boots itself fire-and-forget from its constructor; wait for the
    // background boot to settle before asserting on its effects. The marker is
    // cleared by the LAST statement of boot(), just after the timers are armed,
    // so poll for it rather than racing the timers.
    const ok = await waitFor(() => service.profileTimer != null && service.listenTimer != null, 10_000);
    assert.ok(ok, "the service's background boot must settle");
    await waitFor(() => !existsSync(marker), 10_000);
    assert.ok(!existsSync(marker), "a completed boot removes the marker, so a repaired machine self-heals");
    assert.ok(isUuidShaped((await service.roomService.ensureIdentity()).agentId));
  } finally {
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

  // clearRefusedMarker is idempotent and never throws on a missing marker.
  await clearRefusedMarker(dataDir);
  assert.ok(!(await refusedMarkerPresent(dataDir)));
});

test("NEW: G1 content guards reject the damage classes the card names", async () => {
  assert.equal(nicknameProblem("*****"), null);
  for (const bad of ["NAME", "  NAME  ", "", "   ", "a\uFFFDb", "??", "a??b"]) {
    assert.ok(nicknameProblem(bad), `${JSON.stringify(bad)} must be rejected`);
  }
  assert.ok(isUuidShaped(AGENT_ID));
  assert.ok(!isUuidShaped("NAME"));
  assert.ok(!isUuidShaped(""));
  assert.ok(!isUuidShaped(undefined));

  // A parseable identity file with no usable agentId is damage, not an identity:
  // adopting it would make every `ownerAgentId !== agentId` comparison false and
  // leave the node silently serving nothing.
  const { dataDir, identityFile, backups } = await newCase("new-shape");
  await seed(identityFile, JSON.stringify({ nickname: "no id here" }));
  await assert.rejects(() => new Persistence(dataDir).loadIdentity(), (error) => error.name === "CorruptConfigError");
  assert.ok((await readdir(backups)).some((n) => n.endsWith(".corrupt.bak")), "the wrong-shaped file was quarantined too");

  // The nickname guard on the deliberate write path.
  const clean = await newCase("new-nick");
  await seed(clean.identityFile, identityJson());
  await assert.rejects(
    () => new RoomService({ dataDir: clean.dataDir }).updateProfile({ nickname: "NAME" }),
    /NAME/,
  );
  assert.equal(JSON.parse(await readFile(clean.identityFile, "utf8")).nickname, "*****", "the bad nickname was not written");
});

test("NEW: stripBom only removes a leading BOM", () => {
  assert.equal(stripBom("\uFEFF{}"), "{}");
  assert.equal(stripBom("{}"), "{}");
  assert.equal(stripBom(""), "");
  assert.equal(stripBom("{}\uFEFF"), "{}\uFEFF", "an interior BOM is content, not an encoding artifact");
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test.after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});
