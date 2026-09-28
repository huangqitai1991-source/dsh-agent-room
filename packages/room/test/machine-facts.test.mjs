/**
 * dsh-agent-room -- THE MEASURED FACTS LAYER (D-45)
 *
 * WHY THIS SUITE EXISTS
 *   The canary gate used to read a hand-written version file, and in production the directory that
 *   file lived in did not even exist: the gate either refused forever or could be satisfied by
 *   TYPING the answer. `tools/machine-facts.mjs` replaces that with facts measured on the machine,
 *   and `gateCanary` now refuses unless those facts are fresh, complete and show the machine RUNNING
 *   the target version with the bytes on its disk loaded.
 *
 *   These tests are the acceptance for that mechanism, and the two rules they exist to protect are:
 *     - a hand-typed fact may only REFUSE, never allow;
 *     - a refusal names the FIRST missing thing, and moves nothing on the machine.
 *
 * THE 1985 TRAP (measured on a real node, not imagined)
 *   npm rewrites every file mtime when it packs a tarball (fixed 1985-10-26 date, so builds are
 *   reproducible). A package extracted minutes ago therefore reports libMtime=499162500, and a check
 *   of the form `hostStart >= newest file mtime` becomes ALWAYS TRUE -- the D-42 discriminator would
 *   silently stop discriminating. The install time is therefore max(package dir mtime, newest lib
 *   file mtime), and there is a test below that fails if that rule is ever dropped.
 *
 * Everything runs against hermetic fixtures; no real machine, service or ledger is touched.
 *
 * Run directly:  node test/machine-facts.test.mjs     (never `node --test`: it is EPERM here)
 */

import assert from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCHEMA, deriveFacts, loadFacts, parseEtime, parseRawBlock } from "../tools/machine-facts.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GATE_URL = pathToFileURL(join(ROOT, "tools", "release-gate.mjs")).href;
const gate = await import(GATE_URL);

let failures = 0;
const guarded = (name, fn) =>
  test(name, async (t) => {
    try { await fn(t); } catch (error) { failures += 1; throw error; }
  });

const TARGET = "0.1.51";
const OLD = "0.1.50";
const FIXTURE_ROOT = join(ROOT, "test", ".machine-facts-fixtures", String(process.pid));

function fixture(name) {
  const dir = join(FIXTURE_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The value npm stores on every packed file: 1985-10-26 (see the header). */
const NPM_PACKED_MTIME = 499162500;

function factsFile(dir, {
  schema = SCHEMA, probedAt = new Date().toISOString(), machines = null,
  version = TARGET, id = "bb", ack = true, activation = true, loadedAfterDisk = true,
  libMtime = NPM_PACKED_MTIME, installMtime = 1_800_000_000, hostStart = 1_800_000_100,
  unreachable = null, extra = {},
} = {}) {
  const row = unreachable
    ? { id, via: "fixture", unreachable, ...extra }
    : {
      id, via: "fixture", pluginVersion: version,
      installPath: "C:\\fixture\\dsh-agent-room", installKind: "dir",
      libHash: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      libMtime, pkgDirMtime: installMtime, installMtime,
      hostPid: 4242, now: Math.floor(Date.now() / 1000), etimeSec: 314,
      hostStart, loadedAfterDisk, shape: { ack, activation }, stateOk: true, stateBytes: 4242,
      raw: "ROOMFACTS v1\nfixture", rawMd5: "fixture", ...extra,
    };
  const path = join(dir, "facts.json");
  writeFileSync(path, JSON.stringify({
    schema, probedAt, probedBy: "fixture", source: "fixture", mode: "fixture",
    machines: machines ?? [row],
  }, null, 2));
  return path;
}

function config(dir, { versionFileText = `${OLD}\n` } = {}) {
  mkdirSync(join(dir, "machines", "bb"), { recursive: true });
  const versionFile = join(dir, "machines", "bb", "version");
  writeFileSync(versionFile, versionFileText);
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    machinesRoot: join(dir, "machines"),
    machines: [{ id: "bb", canary: true, address: "127.0.0.1", versionFile }],
  }, null, 2));
  return { configPath, versionFile };
}

function runGate(argv) {
  const lines = [];
  const io = { log: (s) => lines.push("OUT " + s), error: (s) => lines.push("ERR " + s) };
  const r = gate.runReleaseGate(argv, io);
  return { exit: r.exit, out: lines.join("\n"), result: r.result };
}

function judge(dir, name, factsOpts, { target = TARGET, versionFileText } = {}) {
  const { configPath, versionFile } = config(dir, versionFileText === undefined ? {} : { versionFileText });
  const facts = factsFile(dir, factsOpts);
  const r = runGate(["canary", "--version", target, "--machine", "bb", "--config", configPath,
    "--ledger", join(dir, "ledger.jsonl"), "--facts", facts]);
  return { ...r, versionFile, configPath, facts };
}

/* ------------------------------------------------------------ the parsers */

guarded("parseEtime understands every form ps/Windows can print, and refuses anything else", () => {
  assert.strictEqual(parseEtime("06:19:40"), 6 * 3600 + 19 * 60 + 40);
  assert.strictEqual(parseEtime("19:40"), 19 * 60 + 40);
  assert.strictEqual(parseEtime("2-06:19:40"), 2 * 86400 + 6 * 3600 + 19 * 60 + 40);
  assert.strictEqual(parseEtime("330"), 330);          // the Windows template prints whole seconds
  assert.strictEqual(parseEtime(""), null);
  assert.strictEqual(parseEtime(null), null);
  assert.strictEqual(parseEtime("six minutes"), null);
});

guarded("parseRawBlock requires the header and every required field, and says which one is missing", () => {
  const noHeader = parseRawBlock("installPath=x\nplugin=0.1.49\n");
  assert.strictEqual(noHeader.ok, false);
  assert.match(noHeader.reason, /no "ROOMFACTS v1" header/);

  const missing = parseRawBlock("ROOMFACTS v1\ninstallPath=x\nplugin=0.1.49\nlibHash=h\nlibMtime=1\nhostPid=2\nnow=3\n");
  assert.strictEqual(missing.ok, false);
  assert.match(missing.reason, /missing field\(s\): installKind/);

  const ok = parseRawBlock("ROOMFACTS v1\ninstallPath=x\ninstallKind=dir\nplugin=0.1.49\nlibHash=h\nlibMtime=1\nhostPid=2\nnow=3\netimeSec=4\n");
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.fields.plugin, "0.1.49");
});

guarded("the REAL probe reply captured from live hardware still parses (and yields 0.1.49)", () => {
  const live = process.env.DSH_FACTS_PROOF ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "_facts-proof", "raw-verified.txt");
  if (!existsSync(live)) return;                       // the suite stays portable; the check runs where the evidence is
  const parsed = parseRawBlock(readFileSync(live, "utf8"));
  assert.strictEqual(parsed.ok, true, parsed.reason);
  assert.strictEqual(parsed.fields.plugin, "0.1.49");
  assert.strictEqual(parsed.fields.installKind, "symlink");
  const row = deriveFacts(parsed.fields, { id: "CC", via: "from-raw" });
  assert.strictEqual(row.loadedAfterDisk, true);
  assert.deepStrictEqual(row.shape, { ack: true, activation: true });
});

/* ------------------------------------------------------- the derived facts */

guarded("install time is max(package dir, newest file) -- npm's 1985 file stamp may not defeat D-42", () => {
  // This is the trap a real node exposed: file mtimes are npm-normalised, so a package extracted
  // minutes ago still reports 1985. If install time were taken from files alone, "hostStart >=
  // install time" would be true for ANY process, including one that predates the install.
  const fields = {
    installPath: "/x/dsh-agent-room", installKind: "dir", plugin: TARGET, libHash: "h",
    libMtime: String(NPM_PACKED_MTIME), pkgDirMtime: "1800000000",
    hostPid: "4242", now: "1800000300", etimeSec: "299",
  };
  const row = deriveFacts(fields, { id: "bb", via: "fixture" });
  assert.strictEqual(row.installMtime, 1_800_000_000, "the package dir time is the real install time");
  assert.strictEqual(row.hostStart, 1_800_000_001);
  assert.strictEqual(row.loadedAfterDisk, true);

  // a process that started BEFORE the install must not pass
  const old = deriveFacts({ ...fields, etimeSec: "3600" }, { id: "bb", via: "fixture" });
  assert.strictEqual(old.loadedAfterDisk, false, "D-42: the running process predates the bytes on disk");

  // without a readable process start the answer is UNKNOWN, never "fine"
  const unknown = deriveFacts({ ...fields, etimeSec: "", etime: "" }, { id: "bb", via: "fixture" });
  assert.strictEqual(unknown.hostStart, null);
  assert.strictEqual(unknown.loadedAfterDisk, null);
});

guarded("loadFacts reports a missing file and unreadable JSON instead of throwing", () => {
  const dir = fixture("load");
  assert.match(loadFacts(join(dir, "nope.json")).error, /there is no facts file/);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  assert.match(loadFacts(bad).error, /not readable JSON/);
});

/* -------------------------------------------------- the gate on facts (E1) */

guarded("gate 4: no --facts is REFUSED, and a hand-written version file alone can NEVER allow", () => {
  const dir = fixture("no-facts");
  const { configPath, versionFile } = config(dir, { versionFileText: `${TARGET}\n` });  // typed to the target!
  const r = runGate(["canary", "--version", TARGET, "--machine", "bb", "--config", configPath,
    "--ledger", join(dir, "ledger.jsonl")]);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /no --facts file was given/);
  assert.match(r.out, /never on a hand-written version file/);
  assert.strictEqual(readFileSync(versionFile, "utf8").trim(), TARGET, "a refusal changes nothing");
});

guarded("gate 4: facts with the wrong schema, or that are stale, are REFUSED by name", () => {
  const dir = fixture("schema");
  const badSchema = judge(dir, "schema", { schema: "something-else/9" });
  assert.strictEqual(badSchema.exit, 1, badSchema.out);
  assert.match(badSchema.out, /declares schema "something-else\/9" instead of room-machine-facts\/1/);

  const stale = judge(fixture("stale"), "stale", { probedAt: new Date(Date.now() - 3600_000).toISOString() });
  assert.strictEqual(stale.exit, 1, stale.out);
  assert.match(stale.out, /are \d+s old .*older than the 600s maximum/);
});

guarded("gate 4: a canary missing from the facts, or marked unreachable, is REFUSED naming the reason", () => {
  const absent = judge(fixture("absent"), "absent", { machines: [{ id: "aa", via: "fixture", pluginVersion: TARGET }] });
  assert.strictEqual(absent.exit, 1, absent.out);
  assert.match(absent.out, /no row for the designated canary bb \(rows: aa\)/);

  const unreachable = judge(fixture("unreachable"), "unreachable", { unreachable: "the probe command was killed at the 30s limit" });
  assert.strictEqual(unreachable.exit, 1, unreachable.out);
  assert.match(unreachable.out, /could NOT be probed: the probe command was killed at the 30s limit/);
});

guarded("gate 4: an incomplete live shape and a process older than the install are both REFUSED", () => {
  const noAck = judge(fixture("shape-ack"), "shape-ack", { ack: false });
  assert.strictEqual(noAck.exit, 1, noAck.out);
  assert.match(noAck.out, /\(ack=false, activation=true\)/);

  const staleProcess = judge(fixture("d42"), "d42", { installMtime: 1_800_000_000, hostStart: 1_700_000_000, loadedAfterDisk: false });
  assert.strictEqual(staleProcess.exit, 1, staleProcess.out);
  assert.match(staleProcess.out, /did not load the agent-room bytes on its disk/);
  assert.match(staleProcess.out, /This is D-42/);
});

guarded("gate 4: a hand-typed version file that DISAGREES with the measurement is REFUSED", () => {
  const dir = fixture("disagree");
  const r = judge(dir, "disagree", { version: TARGET }, { versionFileText: `${OLD}\n` });
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /hand-written version file for bb says "0\.1\.50" while the machine was measured RUNNING 0\.1\.51/);
});

guarded("gate 4: a hand-typed version file that AGREES is not needed, and fresh facts on target allow", () => {
  const dir = fixture("allow");
  const r = judge(dir, "allow", { version: TARGET }, { versionFileText: `${TARGET}\n` });
  assert.strictEqual(r.exit, 0, r.out);
  assert.match(r.out, /RELEASE GATE canary ALLOWED: canary bb is RUNNING 0\.1\.51/);
  assert.match(r.out, /hand-written file agrees .* and was not needed/);
});

/* ------------------------------------------------------------------ summary */

guarded("summary", () => {
  assert.strictEqual(failures, 0, `${failures} machine-facts case(s) failed`);
});
