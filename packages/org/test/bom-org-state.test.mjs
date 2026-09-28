/**
 * bom-org-state.test.mjs — card-00 P0, organisation side.
 *
 * `OrgPersistence.load()` used to return an empty tree for BOTH "the file is
 * missing" and "the file is present but unparseable" (a UTF-8 BOM from Windows
 * PowerShell 5.1 `Set-Content -Encoding UTF8` is the classic cause). That is not a
 * harmless default here: `save()` writes the state it read, so one BOM turned a
 * damaged file into an irreversibly emptied org tree — and then broadcast it. When
 * the local node is the org owner, `sync.js shouldApply` makes every non-owner
 * ignore incoming snapshots, so an owner that read an empty tree would push the
 * empty tree onto the entire organisation with no self-heal.
 *
 * Every case writes only under `<workdir>\_bom-tests\`. Run directly:
 *   node test/bom-org-state.test.mjs
 */

import assert from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { OrgPersistence } from "../src/host/persistence.js";
import { ensureBackupRoot } from "../src/host/safety.js";
// NOTE: ../src/host/service.js is deliberately NOT imported. It imports
// @deepseek-ai/cordis, which agent-org does not carry in node_modules, and adding
// that dependency to a test would break `npm test` where it does not resolve. The
// service-level contract is asserted structurally (see the wiring test below).
import {
  CorruptConfigError,
  assertPlatformResolvableFor,
  clearRefusedMarker,
  failLoud,
  isUuidShaped,
  nicknameProblem,
  readJsonConfig,
  refusedMarkerPresent,
  resolveBackupRoot,
} from "../src/host/safety.js";

const ROOT = join(tmpdir(), "dsh-agent-org-bom-tests");
const OWNER = "01a0231b-bbe5-720a-97a4-819744eeae76";
const OTHER = "01a0281a-52de-7c4d-a1e9-7e6db367d3dd";
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const tree = () => ({
  version: 1,
  nodes: [
    { id: "c1", kind: "company", name: "My Company", parentId: null, leaderAgentId: OWNER, createdAt: "n", updatedAt: "n" },
    { id: "m1", kind: "member", name: "主控·总控", parentId: "c1", agentId: OWNER, createdAt: "n", updatedAt: "n" },
  ],
  updatedAt: "2026-09-14T00:00:00.000Z",
});

await mkdir(ROOT, { recursive: true });

async function newCase(tag) {
  const base = await mkdtemp(join(ROOT, `org-${tag}-`));
  const dataDir = join(base, "agent-org");
  await mkdir(dataDir, { recursive: true });
  process.env.DSH_HOME = join(base, "home");
  process.env.DSH_IDENTITY_BACKUP_DIR = join(base, "backups");
  return { base, dataDir, backups: join(base, "backups"), stateFile: join(dataDir, "org-state.json") };
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

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

test("NEW: a BOM'd org-state.json is read as the real tree, not an empty one", async () => {
  const { dataDir, stateFile } = await newCase("bom");
  await seed(stateFile, JSON.stringify(tree()), true);
  const before = await snapshot(stateFile);

  const state = await new OrgPersistence(dataDir).load();
  const after = await snapshot(stateFile);

  assert.equal(state.nodes.length, 2, "the tree survived the BOM");
  assert.equal(state.nodes[0].leaderAgentId, OWNER, "the org OWNER is still readable");
  assert.equal(state.nodes[1].agentId, OWNER);
  assert.equal(after.sha, before.sha, "reading never rewrites the file");
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("NEW: a damaged org-state.json throws instead of yielding an empty tree", async () => {
  const { dataDir, backups, stateFile } = await newCase("corrupt");
  await seed(stateFile, '{\n  "version": 1,\n  "nodes": [{ "id": "c1", "kind": "comp');
  const before = await snapshot(stateFile);

  await assert.rejects(
    () => new OrgPersistence(dataDir).load(),
    (error) => {
      assert.equal(error.name, "CorruptConfigError");
      assert.ok(error instanceof CorruptConfigError);
      assert.equal(error.file, stateFile);
      return true;
    },
  );

  const after = await snapshot(stateFile);
  assert.equal(after.sha, before.sha, "the damaged tree is preserved byte-for-byte");
  assert.equal(after.mtimeMs, before.mtimeMs);

  const quarantined = (await readdir(backups)).filter((n) => n.startsWith("org-state.json") && n.endsWith(".corrupt.bak"));
  assert.equal(quarantined.length, 1, "a quarantine copy was taken");
  assert.equal(sha256(await readFile(join(backups, quarantined[0]))), before.sha, "byte-identical");

  const marker = join(dataDir, "REFUSED-TO-START");
  assert.ok(existsSync(marker), "the watchdog marker was written");
  assert.ok((await readFile(marker, "utf8")).includes(stateFile), "and it names the damaged file");
});

test("NEW: a missing org-state.json is still an empty tree (a fresh install, unchanged)", async () => {
  const { dataDir, stateFile } = await newCase("missing");
  const state = await new OrgPersistence(dataDir).load();
  assert.deepEqual(state, { version: 1, nodes: [], updatedAt: "" });
  assert.ok(!existsSync(stateFile), "loading must not create the file");
  assert.ok(!existsSync(join(dataDir, "REFUSED-TO-START")), "no marker for a missing file");
});

test("NEW: parseable-but-wrong-shaped state is damage too, never a silent empty tree", async () => {
  for (const [label, text] of [["object without nodes", JSON.stringify({ version: 1 })], ["array", JSON.stringify([1, 2, 3])], ["null", "null"]]) {
    const { dataDir, stateFile } = await newCase(`shape-${label.replace(/\W+/g, "")}`);
    await seed(stateFile, text);
    await assert.rejects(() => new OrgPersistence(dataDir).load(), (error) => error.name === "CorruptConfigError", label);
  }
});

test("NEW: save() refuses to overwrite a damaged tree, and backs up before a good write", async () => {
  const { dataDir, backups, stateFile } = await newCase("save");
  const persistence = new OrgPersistence(dataDir);

  // (a) refuse: an empty tree must never be written over a damaged file.
  await seed(stateFile, "{ damaged");
  const before = await snapshot(stateFile);
  await assert.rejects(
    () => persistence.save({ version: 1, nodes: [], updatedAt: "n", rev: 1 }),
    (error) => error.name === "CorruptConfigError",
  );
  const after = await snapshot(stateFile);
  assert.equal(after.sha, before.sha, "the damaged tree is untouched");

  // (b) a healthy write takes a verified, timestamped backup first.
  await seed(stateFile, JSON.stringify(tree()));
  const healthy = await snapshot(stateFile);
  await persistence.save({ ...tree(), rev: 2 });
  const made = (await readdir(backups)).filter((n) => /^org-state\.json\.\d{8}-\d{6}\.bak(\.\d+)?$/.test(n));
  assert.equal(made.length, 1, "one backup for the one overwrite");
  assert.equal(sha256(await readFile(join(backups, made[0]))), healthy.sha, "holding the pre-write bytes");
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).rev, 2, "the new state landed");
});

test("NEW: sync-config.json tolerates a BOM, and is loud when damaged", async () => {
  const { dataDir } = await newCase("syncconfig");
  const file = join(dataDir, "sync-config.json");
  const persistence = new OrgPersistence(dataDir);

  await seed(file, JSON.stringify({ roomId: OTHER }), true);
  assert.equal((await persistence.loadSyncConfig()).roomId, OTHER, "a BOM'd sync config still syncs");
  assert.equal((await readJsonConfig(file)).roomId, OTHER);

  await seed(file, "{ damaged");
  await assert.rejects(() => persistence.loadSyncConfig(), (error) => error.name === "CorruptConfigError");
  const missing = join(dataDir, "nothing-here.json");
  assert.equal(await readJsonConfig(missing), null, "missing is still null, not an error");
});

/**
 * The org boot contract, replayed.
 *
 * `OrgService` itself is not constructed here: agent-org carries no
 * `node_modules` (its suite imports no cordis), and adding one import of
 * `@deepseek-ai/cordis` to a test would break `npm test` on machines where it does
 * not resolve. So this replay calls exactly what `OrgService.boot()` calls, in the
 * same order, against the real modules — the same failure surface the host sees —
 * and the service wrapper is covered by the wiring assertion in the next test.
 */
async function replayBoot(dataDir) {
  await ensureBackupRoot();
  const state = await new OrgPersistence(dataDir).load();
  if (typeof state.rev !== "number") state.rev = 0;
  const syncCfg = await new OrgPersistence(dataDir).loadSyncConfig();
  await clearRefusedMarker(dataDir);
  return { state, syncCfg };
}

test("NEW: the boot chain rejects on damage, and its handler re-throws for the host fatal path", async () => {
  // failLoud is the exact handler the org host installs. Before 0.2.11 the bare
  // `void this.boot()` relied on the host catching an unhandled rejection by
  // accident, so "refuse to start" was not a contract this plugin declared.
  const logged = [];
  const boom = new CorruptConfigError("C:\\x\\org-state.json", "Unexpected token", undefined, null);
  assert.throws(
    () => failLoud("[agent-org]", boom, { error: (...args) => logged.push(args) }),
    (error) => error === boom, // identity preserved: the host inspects the error object
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "[agent-org] boot failed: %s");
  assert.match(String(logged[0][1]), /CorruptConfigError/);

  // A good tree boots and reports the real node count.
  const good = await newCase("boot-good");
  await seed(good.stateFile, JSON.stringify(tree()));
  const booted = await replayBoot(good.dataDir);
  assert.equal(booted.state.nodes.length, 2, "the good tree is loaded, not emptied");

  // A damaged tree makes the same chain reject, so boot() rejects.
  const bad = await newCase("boot-bad");
  await seed(bad.stateFile, "{ damaged, so this boot must fail");
  await assert.rejects(
    () => replayBoot(bad.dataDir),
    (error) => error.name === "CorruptConfigError" && error.file === bad.stateFile,
  );
  assert.ok(existsSync(join(bad.dataDir, "REFUSED-TO-START")), "and the marker was left for the watchdog");
});

test("NEW: the service wrapper declares the failure contract (wiring)", async () => {
  // Structural, deliberately: see the note on replayBoot above. These are the
  // three properties that make the hard stop real rather than accidental.
  const source = await readFile(new URL("../src/host/service.js", import.meta.url), "utf8");
  assert.match(source, /void this\.boot\(\)\.catch\(\(error\)\s*=>\s*failLoud\("\[agent-org\]"/, "boot's rejection is routed to failLoud, which re-throws");
  assert.match(source, /await ensureBackupRoot\(\)/, "boot proves the backup root before reading or writing");
  assert.match(source, /await clearRefusedMarker\(this\.config\.dataDir\)/, "a completed boot clears the marker");
  assert.ok(!/catch\s*\{\s*\/\/\s*missing\/corrupt/.test(source), "the old 'missing/corrupt -> empty' comment is gone");
  // The persistence layer must not swallow the corruption either.
  const persistence = await readFile(new URL("../src/host/persistence.js", import.meta.url), "utf8");
  assert.match(persistence, /raiseCorrupt\(this\.file, 'present but has no "nodes" array'\)/);
  assert.ok(!/Missing\/corrupt state starts empty/.test(persistence), "the old comment claiming an auto-seed is gone");
});

test("NEW: a boot that reaches the end clears the watchdog marker", async () => {
  const { dataDir, stateFile } = await newCase("bootclear");
  await seed(stateFile, JSON.stringify(tree()));
  const marker = join(dataDir, "REFUSED-TO-START");
  await seed(marker, "2026-09-14T00:00:00.000Z\nleft over\n");
  assert.ok(await refusedMarkerPresent(dataDir));

  await replayBoot(dataDir);
  assert.ok(!existsSync(marker), "a completed boot removes the marker, so a repaired machine self-heals");

  await clearRefusedMarker(dataDir);
  assert.ok(!(await refusedMarkerPresent(dataDir)));
});

test("NEW: G1 guards on the org write path", async () => {
  assert.equal(nicknameProblem("主控·总控"), null);
  for (const bad of ["NAME", "", "  ", "a??b", "x\uFFFDy"]) assert.ok(nicknameProblem(bad), `${JSON.stringify(bad)} rejected`);
  assert.ok(isUuidShaped(OWNER));
  assert.ok(!isUuidShaped("NAME"));

  // The card's landing point is updateNode's write path. It lives on OrgService,
  // which this suite cannot construct (see replayBoot), so the guard is exercised
  // through the same pure predicates the method calls, plus a source assertion
  // that updateNode actually calls them.
  const source = await readFile(new URL("../src/host/service.js", import.meta.url), "utf8");
  const updateNodeBody = source.slice(source.indexOf("async updateNode("), source.indexOf("async updateNode(") + 1_600);
  assert.match(updateNodeBody, /nicknameProblem\(name\)/, "updateNode validates the node name");
  assert.match(updateNodeBody, /isUuidShaped\(agentId\)/, "updateNode validates a member agentId");
  assert.match(updateNodeBody, /name_invalid|agent_invalid/, "and rejects with a named OrgError code");
});

test("NEW: the org backup root is derived per platform, never a hardcoded drive letter", async () => {
  const home = "C:\\work\\.dsh";
  process.env.DSH_HOME = home;
  delete process.env.DSH_IDENTITY_BACKUP_DIR;
  assert.equal(resolveBackupRoot(), join(dirname(home), "identity-backups"), "a sibling of the DSH home, not inside it");
  assert.ok(!resolveBackupRoot().startsWith(home), "never inside the config directory");

  process.env.DSH_IDENTITY_BACKUP_DIR = join(ROOT, "explicit-backups");
  assert.equal(resolveBackupRoot(), join(ROOT, "explicit-backups"));

  assert.throws(() => assertPlatformResolvableFor("C:\\work\\identity-backups", "darwin"), /Windows-only path/);
  assert.throws(() => assertPlatformResolvableFor("\\\\server\\share\\b", "darwin"), /Windows-only path/);
  assert.doesNotThrow(() => assertPlatformResolvableFor("/Users/example/identity-backups", "darwin"));
  assert.doesNotThrow(() => assertPlatformResolvableFor("C:\\work\\identity-backups", "win32"));
  assert.throws(() => assertPlatformResolvableFor("relative", "win32"), /not absolute/);

  // The card's must-fix, checked on the source: the default root must never be a
  // drive-letter literal, because the team runs one macOS node with no D:\ volume.
  const safetySource = await readFile(new URL("../src/host/safety.js", import.meta.url), "utf8");
  assert.ok(!/["'`][A-Za-z]:[\\/]/.test(safetySource), "no drive-letter literal anywhere in the safety module");
  assert.match(safetySource, /join\(dirname\(dshHome\(\)\), "identity-backups"\)/);
});

test.after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});
