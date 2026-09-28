/**
 * dsh-agent-room 0.1.51 -- THE FOUR RELEASE GATES, and the proof that a refusal is inert.
 *
 * WHY THESE TESTS EXIST
 *   2026-09-15 shipped nine plugin versions in one day; every one of them carried a defect a
 *   human had to catch by hand. The rules written afterwards (<=2 versions/day, evidence before
 *   release, independent acceptance, canary first) were PROSE. Prose does not execute.
 *   `tools/release-gate.mjs` turns each rule into a gate that REFUSES. These tests are the
 *   acceptance: for EVERY gate, a deliberately violating run must be refused with the gate named
 *   and a non-zero exit, and a compliant run must be allowed.
 *
 * THE ONE RULE THIS SUITE ENFORCES ON ITSELF
 *   A refusal must have NO EXTERNAL EFFECT that it cannot account for: the evidence file, the
 *   config and every machine's version file must be byte-identical afterwards, and the ledger
 *   must differ by EXACTLY the one refusal line the gate says it writes. "It returned false" is
 *   not proof; a byte comparison is.
 *
 * Everything runs against hermetic fixtures under the repo's temp root, so the suite is portable
 * and never touches a real machine, a real service or a real ledger.
 *
 * AR_RELEASE_GATE_DIR points this suite at ANOTHER build's `tools/` directory, so the pre-change
 * tree can be used as the old-build half of the evidence.
 *
 * Run directly:  node test/release-gate.test.mjs     (never `node --test`)
 */

import assert from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, statSync, openSync, closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXIT = (n) => n;
const TOOLS = process.env.AR_RELEASE_GATE_DIR ? join(process.env.AR_RELEASE_GATE_DIR) : join(ROOT, "tools");
const GATE_FILE = join(TOOLS, "release-gate.mjs");
const GATE_FILE_URL = pathToFileURL(GATE_FILE).href;

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

let gate = null;
let gateImportError = null;
try {
  gate = await import(GATE_FILE_URL);
} catch (error) {
  gateImportError = error;
}

function needGate(what) {
  if (!gate) {
    failures += 1;
    throw new Error(
      `the four release gates do not exist in ${TOOLS} (AR_RELEASE_GATE_DIR=${process.env.AR_RELEASE_GATE_DIR ?? "(local tools)"}): ` +
        `${what}. import error: ${String(gateImportError)}`,
    );
  }
}

/* --------------------------------------------------------------- fixtures */

const FIXTURE_ROOT = join(ROOT, "test", ".release-gate-fixtures", String(process.pid));

const TARGET = "0.1.51";
const OLD = "0.1.50";

/**
 * The house assertion line, in the shape the studio actually prints. `--order old` produces the
 * reversed field order, which the parser must accept too (the two builds can be reported either
 * way round).
 */
function assertionLine({ newFailures = 0, oldFailures = 13, order = "new-first" } = {}) {
  return order === "new-first"
    ? `new assertions on the NEW build: ${newFailures} failure(s) | on the OLD build: ${oldFailures} failure(s)`
    : `on the OLD build: ${oldFailures} failure(s) | new assertions on the NEW build: ${newFailures} failure(s)`;
}

function evidenceObject(extra = {}) {
  return {
    tool: "fixture-gate",
    command: "node test/duty-model.test.mjs",
    new_version: TARGET,
    old_version: OLD,
    assertion: assertionLine(),
    ...extra,
  };
}

/**
 * Write a machine-facts file for the fixture's canary -- the measured facts D-45 judges on.
 *
 * `installMtime` and `libMtime` are BOTH written on purpose: installMtime is the package-directory
 * time (the one that means something) while libMtime carries the value npm puts on every file it
 * packs (1985-10-26, measured on a real node as 499162500). The gate must use installMtime, and the
 * dedicated test file asserts that a facts row whose libMtime is the 1985 constant still works.
 *
 * By default the machine's own hand-written version file is moved to the same version: a hand-typed
 * fact that AGREES is simply not needed, while one that disagrees must refuse (card-13 §B3 step 7).
 */
function writeFacts(dir, {
  version = TARGET, machine = "mai", ageSec = 0, ack = true, activation = true,
  loadedAfterDisk = true, unreachable = null, pluginVersion = null, agreeVersionFile = true,
  installMtime = 1_800_000_000, hostStart = 1_800_000_100,
} = {}) {
  const factsPath = join(dir, "machine-facts.json");
  const probedAt = new Date(Date.now() - ageSec * 1000).toISOString();
  const row = unreachable
    ? { id: machine, via: "fixture", unreachable }
    : {
      id: machine, via: "fixture", pluginVersion: pluginVersion ?? version,
      installPath: "C:\\fixture\\dsh-agent-room", installKind: "dir",
      libHash: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      libMtime: 499162500, pkgDirMtime: installMtime, installMtime,
      hostPid: 4242, now: Math.floor(Date.now() / 1000), etimeSec: Math.max(0, Math.floor(Date.now() / 1000) - hostStart),
      hostStart, loadedAfterDisk, shape: { ack, activation }, stateOk: true, stateBytes: 4242,
      raw: "ROOMFACTS v1\nfixture", rawMd5: "fixture",
    };
  writeFileSync(factsPath, JSON.stringify({
    schema: "room-machine-facts/1", probedAt, probedBy: "fixture", source: "fixture", mode: "fixture", machines: [row],
  }, null, 2));
  if (agreeVersionFile && !unreachable) writeFileSync(join(dir, "machines", machine, "version"), `${pluginVersion ?? version}\n`);
  return factsPath;
}

function makeFixture(name) {
  const dir = join(FIXTURE_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "machines", "mai"), { recursive: true });
  mkdirSync(join(dir, "machines", "jie"), { recursive: true });

  const ledger = join(dir, "release-ledger.jsonl");
  const evidence = join(dir, "evidence.json");
  const config = join(dir, "config.json");
  const versionFile = join(dir, "machines", "mai", "version");
  const versionFile2 = join(dir, "machines", "jie", "version");

  writeFileSync(evidence, JSON.stringify(evidenceObject(), null, 2));
  writeFileSync(versionFile, `${OLD}\n`);
  writeFileSync(versionFile2, `${OLD}\n`);

  const scripts = {
    upgrade: join(dir, "fixture-upgrade.mjs"),
    verifyOk: join(dir, "fixture-verify-ok.mjs"),
    verifyBad: join(dir, "fixture-verify-bad.mjs"),
    rollback: join(dir, "fixture-rollback.mjs"),
  };
  writeFileSync(scripts.upgrade,
    "import { writeFileSync } from 'node:fs';\n" +
    "writeFileSync(process.env.RELGATE_VF, process.env.RELGATE_TARGET + '\\n');\n" +
    "console.log('fixture upgrade applied ' + process.env.RELGATE_TARGET);\n");
  writeFileSync(scripts.verifyOk,
    "import { readFileSync } from 'node:fs';\n" +
    "const v = readFileSync(process.env.RELGATE_VF, 'utf8').trim();\n" +
    "console.log('fixture post-upgrade verify: machine on ' + v + ', target ' + process.env.RELGATE_TARGET);\n" +
    "process.exit(v === process.env.RELGATE_TARGET ? 0 : 1);\n");
  writeFileSync(scripts.verifyBad,
    "import { readFileSync } from 'node:fs';\n" +
    "console.log('fixture post-upgrade verify FAILED on ' + readFileSync(process.env.RELGATE_VF, 'utf8').trim());\n" +
    "process.exit(1);\n");
  writeFileSync(scripts.rollback,
    "import { writeFileSync } from 'node:fs';\n" +
    "writeFileSync(process.env.RELGATE_VF, process.env.RELGATE_PREV + '\\n');\n" +
    "console.log('fixture rollback to ' + process.env.RELGATE_PREV);\n");

  const machine = (id, verifyScript) => ({
    id,
    address: "127.0.0.1",
    canary: id === "mai",
    upgrade: { cmd: process.execPath, args: [scripts.upgrade] },
    postUpgradeVerify: { cmd: process.execPath, args: [verifyScript] },
    rollback: { cmd: process.execPath, args: [scripts.rollback] },
  });
  const writeConfig = (verifyScript) => {
    writeFileSync(config, JSON.stringify({
      ledger, machinesRoot: join(dir, "machines"),
      machines: [machine("mai", verifyScript), machine("jie", verifyScript)],
    }, null, 2));
    return config;
  };
  writeConfig(scripts.verifyOk);

  const env = {
    ...process.env,
    DSH_RELEASE_RUN_DIR: join(dir, "run"),
    RELGATE_VF: versionFile,
    RELGATE_TARGET: TARGET,
    RELGATE_PREV: "0.1.49",
  };

  return {
    dir, ledger, evidence, config, versionFile, versionFile2, scripts, env,
    writeConfig,
    seedRelease(version, ts) {
      appendFileSync(ledger, JSON.stringify({
        ts: ts ?? `${new Date().toISOString().slice(0, 10)}T01:00:00.000Z`,
        version, gate: "release", verdict: "released", actor: "author",
        evidence: join(dir, "evidence.json"), reason: "seeded by the suite",
      }) + "\n");
    },
  };
}

/* ------------------------------------------------------------------ helpers */

/** Capture the gate's output in-process (no pipes, no sandbox surprises). */
function runInProcess(argv, env = process.env) {
  const lines = [];
  const io = { log: (s) => lines.push("OUT " + s), error: (s) => lines.push("ERR " + s) };
  const saved = {};
  for (const k of Object.keys(env)) if (process.env[k] !== env[k]) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  let run;
  try {
    run = gate.runReleaseGate(argv, io);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    for (const k of Object.keys(env)) if (saved[k] === undefined && !(k in saved)) process.env[k] = env[k];
  }
  return { exit: run.exit, result: run.result, out: lines.join("\n") };
}

/**
 * A real child process, so the EXIT CODE is the operating system's, not a return value.
 * Uses FILE stdio on purpose: a confined process cannot reliably hand a child a pipe, and a
 * helper that cannot be run is not a helper -- the same reason the gate itself uses file stdio.
 */
function runProcess(argv, env) {
  const wrapper = join(FIXTURE_ROOT, "cli-wrapper.mjs");
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  writeFileSync(wrapper,
    `const m = await import(${JSON.stringify(GATE_FILE_URL)});\n` +
    "const io = { log: (s) => process.stdout.write(s + '\\n'), error: (s) => process.stderr.write(s + '\\n') };\n" +
    "const r = m.runReleaseGate(process.argv.slice(2), io);\n" +
    "process.exit(r.exit);\n");
  const outFile = join(FIXTURE_ROOT, `cli-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const fd = openSync(outFile, "w");
  let status = -1;
  try {
    const r = spawnSync(process.execPath, [wrapper, ...argv], {
      env: { ...process.env, ...env }, detached: false, stdio: ["ignore", fd, fd],
    });
    status = r.status ?? -1;
  } finally {
    closeSync(fd);
  }
  const out = readFileSync(outFile, "utf8");
  rmSync(outFile, { force: true });
  return { exit: status, out };
}

const hash = (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "(absent)");
const bytes = (file) => (existsSync(file) ? statSync(file).size : -1);

/** Every line of the ledger, parsed. */
function ledgerLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

/* ================================================================= test 1 */
/* gate 1: version-count */

guarded("gate 1: a third version on the same day is REFUSED and the gate is named", () => {
  needGate("the version-count gate must be able to refuse");
  const f = makeFixture("count-violating");
  f.seedRelease("0.1.49");
  f.seedRelease(OLD);

  const r = runInProcess(["version-count", "--version", TARGET, "--ledger", f.ledger]);
  assert.strictEqual(r.exit, EXIT(1), `a third release must exit non-zero, got ${r.exit}: ${r.out}`);
  assert.match(r.out, /RELEASE GATE version-count REFUSED/);
  assert.match(r.out, new RegExp(`already has 2 released version\\(s\\) \\[0\\.1\\.49, ${OLD.replace(/\./g, "\\.")}\\]`));
  assert.match(r.out, /configured maximum is 2/);
});

guarded("gate 1: with room left, the same check is ALLOWED (no false red)", () => {
  needGate("the version-count gate must allow a compliant release");
  const f = makeFixture("count-compliant");
  f.seedRelease("0.1.49");
  const r = runInProcess(["version-count", "--version", TARGET, "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.match(r.out, /RELEASE GATE version-count ALLOWED: 1\/2 released version\(s\)/);
});

guarded("gate 1: an override without a --reason is still REFUSED, and one with a reason is written down", () => {
  needGate("the override branch must exist");
  const f = makeFixture("count-override");
  f.seedRelease("0.1.49");
  f.seedRelease(OLD);

  const noReason = runInProcess(["version-count", "--version", TARGET, "--ledger", f.ledger, "--override"]);
  assert.strictEqual(noReason.exit, 1, noReason.out);
  assert.match(noReason.out, /--override was given without --reason/);

  const withReason = runInProcess(["version-count", "--version", TARGET, "--ledger", f.ledger, "--override", "--reason", "hotfix for the room outage"]);
  assert.strictEqual(withReason.exit, 0, withReason.out);
  assert.match(withReason.out, /ALLOWED: overridden at 2\/2/);
  const last = ledgerLines(f.ledger).pop();
  assert.strictEqual(last.verdict, "override");
  assert.strictEqual(last.reason, "hotfix for the room outage", "the override reason must land in the ledger");
});

guarded("gate 1: as a real process the refusal exits non-zero (the exit code is the OS's, not a return value)", () => {
  needGate("the CLI entry point must exist");
  const f = makeFixture("count-process");
  f.seedRelease("0.1.49");
  f.seedRelease(OLD);
  const r = runProcess(["version-count", "--version", TARGET, "--ledger", f.ledger], f.env);
  assert.strictEqual(r.exit, 1, `child process exit was ${r.exit}: ${r.out}`);
  assert.match(r.out, /RELEASE GATE version-count REFUSED/);
});

/* ================================================================= test 2 */
/* gate 2: evidence */

guarded("gate 2: a missing evidence file is REFUSED, and the reason names the path", () => {
  needGate("the evidence gate must be able to refuse");
  const f = makeFixture("evidence-missing");
  const missing = join(f.dir, "does-not-exist.json");
  const r = runInProcess(["evidence", "--version", TARGET, "--evidence", missing, "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /RELEASE GATE evidence REFUSED/);
  assert.match(r.out, /no evidence file at/);
});

guarded("gate 2: a summary sentence is NOT evidence -- it is REFUSED for having no raw gate output", () => {
  needGate("the evidence gate must reject prose");
  const f = makeFixture("evidence-prose");
  const prose = join(f.dir, "summary.json");
  writeFileSync(prose, JSON.stringify({
    command: "node test/duty-model.test.mjs",
    conclusion: "the new build passes and the old build fails",
    result: "PASS",
  }, null, 2));
  const r = runInProcess(["evidence", "--version", TARGET, "--evidence", prose, "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /RELEASE GATE evidence REFUSED/);
  assert.match(r.out, /no raw gate output/);
  assert.match(r.out, /a summary sentence is not evidence/);
});

guarded("gate 2: a run that fails on BOTH builds is REFUSED (it distinguishes nothing)", () => {
  needGate("the evidence gate must reject an undiscriminating run");
  const f = makeFixture("evidence-both-fail");
  const bad = join(f.dir, "both-fail.json");
  writeFileSync(bad, JSON.stringify(evidenceObject({ assertion: assertionLine({ newFailures: 4, oldFailures: 13 }) }), null, 2));
  const r = runInProcess(["evidence", "--version", TARGET, "--evidence", bad, "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /RELEASE GATE evidence REFUSED/);
  assert.match(r.out, /new-build side is not clean/);
});

guarded("gate 2: an assertion line reading 0 on BOTH builds is REFUSED even when another line discriminates", () => {
  needGate("the evidence gate must catch a vacuous assertion line");
  const f = makeFixture("evidence-both-zero");
  const bad = join(f.dir, "both-zero.json");
  writeFileSync(bad, JSON.stringify(evidenceObject({
    assertion: assertionLine({ newFailures: 0, oldFailures: 0 }),
    secondAssertion: assertionLine({ newFailures: 0, oldFailures: 13 }),
  }), null, 2));
  const r = runInProcess(["evidence", "--version", TARGET, "--evidence", bad, "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /0 failures on BOTH builds/);
});

guarded("gate 2: evidence for a DIFFERENT version is REFUSED", () => {
  needGate("the evidence gate must bind the evidence to the version");
  const f = makeFixture("evidence-other-version");
  const other = join(f.dir, "other.json");
  writeFileSync(other, JSON.stringify(evidenceObject({ new_version: "0.1.44" }), null, 2));
  const r = runInProcess(["evidence", "--version", TARGET, "--evidence", other, "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /is for new-version 0\.1\.44, not 0\.1\.51/);
});

guarded("gate 2: the raw house evidence passes, in EITHER field order", () => {
  needGate("the evidence gate must accept the house pattern");
  const f = makeFixture("evidence-compliant");
  const a = runInProcess(["evidence", "--version", TARGET, "--evidence", f.evidence, "--ledger", f.ledger]);
  assert.strictEqual(a.exit, 0, a.out);
  assert.match(a.out, /RELEASE GATE evidence ALLOWED: old build 13 failure\(s\) \/ new build 0 failure\(s\)/);

  const reversed = join(f.dir, "reversed.json");
  writeFileSync(reversed, JSON.stringify(evidenceObject({ assertion: assertionLine({ order: "old-first" }) }), null, 2));
  const b = runInProcess(["evidence", "--version", TARGET, "--evidence", reversed, "--ledger", f.ledger]);
  assert.strictEqual(b.exit, 0, `the old-first field order is legitimate and must not be a false red: ${b.out}`);
});

/* ================================================================= test 3 */
/* gate 3: independent acceptance */

guarded("gate 3: no acceptance record at all is REFUSED", () => {
  needGate("the acceptance gate must be able to refuse");
  const f = makeFixture("accept-missing");
  const r = runInProcess(["acceptance", "--version", TARGET, "--author", "author", "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /RELEASE GATE acceptance REFUSED/);
  assert.match(r.out, /no acceptance record for 0\.1\.51/);
  assert.match(r.out, /someone other than the author is still outstanding/);
});

guarded("gate 3: author self-acceptance is REFUSED outright", () => {
  needGate("self-acceptance must be rejected");
  const f = makeFixture("accept-self");
  const write = runInProcess(["accept", "--version", TARGET, "--author", "author", "--accepted-by", "author", "--evidence", f.evidence, "--ledger", f.ledger]);
  assert.strictEqual(write.exit, 1, write.out);
  assert.match(write.out, /RELEASE GATE acceptance REFUSED/);
  assert.match(write.out, /IS the author/);
  assert.match(write.out, /self-acceptance is rejected outright/);
  const afterSelf = ledgerLines(f.ledger).filter((r) => r.verdict === "accepted");
  assert.strictEqual(afterSelf.length, 0,
    "a rejected self-acceptance may be recorded as a REFUSAL, never as an acceptance");
  const attempt = ledgerLines(f.ledger).find((r) => r.gate === "acceptance_rejected");
  assert.ok(attempt, "the attempt is worth recording: the ledger should show that someone tried and was refused");
  assert.match(attempt.reason, /is the author/, "the rejected attempt names WHY it was refused");

  // and even if a self-acceptance line were forced into the ledger, the gate must still refuse
  appendFileSync(f.ledger, JSON.stringify({
    ts: new Date().toISOString(), version: TARGET, gate: "acceptance", verdict: "accepted",
    actor: "author", evidence: f.evidence, reason: null,
  }) + "\n");
  const gateRun = runInProcess(["acceptance", "--version", TARGET, "--author", "author", "--ledger", f.ledger]);
  assert.strictEqual(gateRun.exit, 1, gateRun.out);
  assert.match(gateRun.out, /every acceptance record for 0\.1\.51 was written by the author/);
});

guarded("gate 3: an acceptance that names evidence which does not exist is REFUSED", () => {
  needGate("the acceptance gate must check the evidence path it is given");
  const f = makeFixture("accept-no-evidence");
  appendFileSync(f.ledger, JSON.stringify({
    ts: new Date().toISOString(), version: TARGET, gate: "acceptance", verdict: "accepted",
    actor: "reviewer-x", evidence: join(f.dir, "gone.json"), reason: null,
  }) + "\n");
  const r = runInProcess(["acceptance", "--version", TARGET, "--author", "author", "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /names evidence .* which does not exist/);
});

guarded("gate 3: acceptance by someone else, with existing evidence, is ALLOWED", () => {
  needGate("the acceptance gate must allow independent acceptance");
  const f = makeFixture("accept-compliant");
  const write = runInProcess(["accept", "--version", TARGET, "--author", "author", "--accepted-by", "reviewer-x", "--evidence", f.evidence, "--ledger", f.ledger]);
  assert.strictEqual(write.exit, 0, write.out);
  const r = runInProcess(["acceptance", "--version", TARGET, "--author", "author", "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.match(r.out, /RELEASE GATE acceptance ALLOWED: accepted by reviewer-x \(not the author author\)/);
});

guarded("gate 3: acceptance of a DIFFERENT version does not count for this one", () => {
  needGate("acceptance must be per version");
  const f = makeFixture("accept-other-version");
  runInProcess(["accept", "--version", "0.1.44", "--author", "author", "--accepted-by", "reviewer-x", "--evidence", f.evidence, "--ledger", f.ledger]);
  const r = runInProcess(["acceptance", "--version", TARGET, "--author", "author", "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /no acceptance record for 0\.1\.51/);
});

/* ================================================================= test 4 */
/* gate 4: the canary is judged on MEASURED facts (D-45), and the gate is READ-ONLY */

guarded("gate 4: a canary measured to be RUNNING an older version is REFUSED, and nothing on the machine moves", () => {
  needGate("the canary gate must be able to refuse");
  const f = makeFixture("canary-stale");
  const facts = writeFacts(f.dir, { version: OLD });   // measured: this machine runs 0.1.50, target is 0.1.51
  const r = runInProcess(["canary", "--version", TARGET, "--machine", "mai", "--config", f.config, "--ledger", f.ledger, "--facts", facts], f.env);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /RELEASE GATE canary REFUSED/);
  assert.match(r.out, /is RUNNING 0\.1\.50, not the target 0\.1\.51/);
  assert.match(r.out, /this gate never installs anything/);
  assert.strictEqual(readFileSync(f.versionFile, "utf8").trim(), OLD, "a refusal may not move the machine's own version file");
  assert.strictEqual(ledgerLines(f.ledger).filter((r2) => r2.verdict === "canary_passed").length, 0);
});

guarded("gate 4: fresh facts on the target version with the live shape allow the canary, and the fleet follows", () => {
  needGate("the canary gate must be able to allow");
  const f = makeFixture("canary-compliant");
  f.writeConfig(f.scripts.verifyOk);
  const facts = writeFacts(f.dir, { version: TARGET });
  const r = runInProcess(["canary", "--version", TARGET, "--machine", "mai", "--config", f.config, "--ledger", f.ledger, "--facts", facts], f.env);
  assert.strictEqual(r.exit, 0, r.out);
  assert.match(r.out, /RELEASE GATE canary ALLOWED: canary mai is RUNNING 0\.1\.51/);
  assert.match(r.out, /hostStarted \d+ >= install time \d+/);
  assert.match(r.out, /live shape ack\+activation both present/);
  const passed = ledgerLines(f.ledger).filter((r2) => r2.verdict === "canary_passed");
  assert.strictEqual(passed.length, 1, "exactly one canary_passed row");

  const fleet = runInProcess(["fleet", "--version", TARGET, "--ledger", f.ledger], f.env);
  assert.strictEqual(fleet.exit, 0, fleet.out);
  assert.match(fleet.out, /RELEASE GATE fleet ALLOWED: canary passed for 0\.1\.51 on mai/);
});

guarded("gate 4: the fleet is REFUSED before any canary result exists", () => {
  needGate("the fleet must be blocked without a canary");
  const f = makeFixture("fleet-no-canary");
  const r = runInProcess(["fleet", "--version", TARGET, "--ledger", f.ledger], f.env);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /RELEASE GATE fleet REFUSED/);
  assert.match(r.out, /no canary result for 0\.1\.51/);
});

guarded("gate 4: a config that designates TWO canaries is REFUSED (a canary is exactly one machine)", () => {
  needGate("the canary count must be enforced");
  const f = makeFixture("canary-two");
  const cfg = JSON.parse(readFileSync(f.config, "utf8"));
  cfg.machines[1].canary = true;
  writeFileSync(f.config, JSON.stringify(cfg, null, 2));
  const r = runInProcess(["canary", "--version", TARGET, "--machine", "mai", "--config", f.config, "--ledger", f.ledger], f.env);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /designates 2 canary machines/);
});

guarded("gate 4: a --machine that is not the designated canary is REFUSED", () => {
  needGate("the designated canary must be the only one that goes first");
  const f = makeFixture("canary-wrong-machine");
  writeFileSync(f.versionFile2, `${TARGET}\n`);
  const r = runInProcess(["canary", "--version", TARGET, "--machine", "jie", "--config", f.config, "--ledger", f.ledger], f.env);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /--machine jie is not the designated canary \(mai\)/);
});

/* ================================================================= test 5 */
/* the gate is READ-ONLY, and the facts decide */

guarded("gate 4 is READ-ONLY: a configured upgrade/rollback command is NEVER executed, even when the facts allow", () => {
  needGate("the canary gate must not install, restart or roll anything back");
  const f = makeFixture("canary-readonly");
  const sentinel = join(f.dir, "UPGRADE-OR-ROLLBACK-RAN.txt");
  const cfg = JSON.parse(readFileSync(f.config, "utf8"));
  const touched = { cmd: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`] };
  cfg.machines[0].upgrade = touched;
  cfg.machines[0].rollback = touched;
  writeFileSync(f.config, JSON.stringify(cfg, null, 2));
  const facts = writeFacts(f.dir, { version: TARGET });

  const r = runInProcess(["canary", "--version", TARGET, "--machine", "mai", "--config", f.config, "--ledger", f.ledger, "--facts", facts], f.env);
  assert.strictEqual(r.exit, 0, r.out);
  assert.strictEqual(existsSync(sentinel), false,
    "the gate judged on facts and must have run no install/rollback command at all");
});

guarded("gate 4: facts without the live shape, and facts that are too old, are REFUSED by name", () => {
  needGate("the shape and the freshness of the facts must both be enforced");
  const f = makeFixture("canary-shape");
  const noActivation = writeFacts(f.dir, { version: TARGET, activation: false });
  const r1 = runInProcess(["canary", "--version", TARGET, "--machine", "mai", "--config", f.config, "--ledger", f.ledger, "--facts", noActivation], f.env);
  assert.strictEqual(r1.exit, 1, r1.out);
  assert.match(r1.out, /not showing the live plugin's shape \(ack=true, activation=false\)/);

  const stale = writeFacts(f.dir, { version: TARGET, ageSec: 3600 });
  const r2 = runInProcess(["canary", "--version", TARGET, "--machine", "mai", "--config", f.config, "--ledger", f.ledger, "--facts", stale], f.env);
  assert.strictEqual(r2.exit, 1, r2.out);
  assert.match(r2.out, /are \d+s old .*older than the 600s maximum/);
});

/* ================================================================= test 6 */
/* a refusal must be INERT */

guarded("no external effect: every violating gate run leaves the evidence, the config and every machine byte-identical", () => {
  needGate("the gates must exist to prove they are inert");
  const f = makeFixture("no-external-effect");
  f.seedRelease("0.1.49");
  f.seedRelease(OLD);
  f.writeConfig(f.scripts.verifyOk);

  const watch = [f.evidence, f.config, f.versionFile, f.versionFile2];
  const before = new Map(watch.map((p) => [p, hash(p)]));
  const beforeBytes = new Map(watch.map((p) => [p, bytes(p)]));
  const ledgerBefore = ledgerLines(f.ledger).length;

  // deliberately violating run through EVERY gate, in one process each
  const runs = [
    ["version-count", ["version-count", "--version", TARGET, "--ledger", f.ledger]],
    ["evidence", ["evidence", "--version", TARGET, "--evidence", join(f.dir, "missing.json"), "--ledger", f.ledger]],
    ["acceptance", ["acceptance", "--version", TARGET, "--author", "author", "--ledger", f.ledger]],
    ["fleet", ["fleet", "--version", TARGET, "--ledger", f.ledger]],
  ];
  const refused = [];
  for (const [name, argv] of runs) {
    const r = runInProcess(argv, f.env);
    assert.strictEqual(r.exit, 1, `${name} should have refused: ${r.out}`);
    assert.match(r.out, new RegExp(`RELEASE GATE ${name} REFUSED`), `${name} must name itself: ${r.out}`);
    refused.push(name);
  }

  // THE PROOF: byte-identical inputs, and the ledger grew by EXACTLY one refusal line per gate
  for (const p of watch) {
    assert.strictEqual(hash(p), before.get(p), `${p} was modified by a refused run`);
    assert.strictEqual(bytes(p), beforeBytes.get(p), `${p} changed size during a refused run`);
  }
  const after = ledgerLines(f.ledger);
  const added = after.slice(ledgerBefore);
  assert.strictEqual(added.length, refused.length,
    `a refused run must append exactly its own refusal line: added ${added.length} for ${refused.length} refusals`);
  for (const row of added) {
    assert.strictEqual(row.verdict, "refused", `only refusals may be appended by a refused run: ${JSON.stringify(row)}`);
  }
  assert.deepStrictEqual(added.map((r) => r.gate).sort(), refused.slice().sort(), "each refusal names its own gate in the ledger");
});

guarded("no external effect: a refused version-count leaves the release count itself unchanged (max seq did not move)", () => {
  needGate("the version-count gate must not consume its own budget");
  const f = makeFixture("count-inert");
  f.seedRelease("0.1.49");
  f.seedRelease(OLD);
  const before = ledgerLines(f.ledger).filter((r) => r.verdict === "released").length;

  for (let i = 0; i < 3; i += 1) {
    const r = runInProcess(["version-count", "--version", TARGET, "--ledger", f.ledger]);
    assert.strictEqual(r.exit, 1, r.out);
  }
  const after = ledgerLines(f.ledger).filter((r) => r.verdict === "released").length;
  assert.strictEqual(after, before, "a refused attempt must never count as a release");
  const refused = ledgerLines(f.ledger).filter((r) => r.verdict === "refused").length;
  assert.strictEqual(refused, 3, "each refusal is recorded once, and only as a refusal");
});

guarded("a malformed ledger line is REFUSED, not skipped: an unreadable ledger proves nothing", () => {
  needGate("ledger integrity must be enforced");
  const f = makeFixture("ledger-malformed");
  f.seedRelease("0.1.49");
  appendFileSync(f.ledger, "{ this is not json\n");
  const r = runInProcess(["version-count", "--version", TARGET, "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 1, r.out);
  assert.match(r.out, /unreadable line\(s\)/);
  assert.match(r.out, /a ledger that cannot be read proves nothing/);
});

/* ================================================================= test 7 */
/* the release command: all four at once */

guarded("release: all four gates must pass, and the ledger records the release only then", () => {
  needGate("the composed release gate must exist");
  const f = makeFixture("release-composed");

  // 1. everything missing -> refused by the first gate that can decide
  const bad = runInProcess(["release", "--version", TARGET, "--evidence", f.evidence, "--author", "author", "--ledger", f.ledger]);
  assert.strictEqual(bad.exit, 1, bad.out);
  assert.match(bad.out, /RELEASE GATE (acceptance|canary) REFUSED/);
  assert.strictEqual(ledgerLines(f.ledger).filter((r) => r.verdict === "released").length, 0,
    "a refused release must not be recorded as a release");

  // 2. canary first, then acceptance by someone else, then the release goes through
  const facts = writeFacts(f.dir, { version: TARGET });
  const canary = runInProcess(["canary", "--version", TARGET, "--machine", "mai", "--config", f.config, "--ledger", f.ledger, "--facts", facts], f.env);
  assert.strictEqual(canary.exit, 0, canary.out);
  const accept = runInProcess(["accept", "--version", TARGET, "--author", "author", "--accepted-by", "reviewer-x", "--evidence", f.evidence, "--ledger", f.ledger]);
  assert.strictEqual(accept.exit, 0, accept.out);
  const good = runInProcess(["release", "--version", TARGET, "--evidence", f.evidence, "--author", "author", "--ledger", f.ledger]);
  assert.strictEqual(good.exit, 0, good.out);
  assert.match(good.out, /RELEASE GATE all-four ALLOWED/);
  const released = ledgerLines(f.ledger).filter((r) => r.verdict === "released");
  assert.strictEqual(released.length, 1);
  assert.strictEqual(released[0].version, TARGET);
});

guarded("the ledger event shape is exactly {ts, version, gate, verdict, actor, evidence, reason}", () => {
  needGate("the ledger is the mechanism's memory");
  const f = makeFixture("ledger-shape");
  const allowed = runInProcess(["version-count", "--version", TARGET, "--ledger", f.ledger]);
  assert.strictEqual(allowed.exit, 0, allowed.out);
  assert.strictEqual(ledgerLines(f.ledger).length, 0,
    "a clean gate run proves itself by reading the ledger and writes nothing");

  const refused = runInProcess(["evidence", "--version", TARGET, "--evidence", join(f.dir, "nope.json"), "--ledger", f.ledger]);
  assert.strictEqual(refused.exit, 1, refused.out);
  const rows = ledgerLines(f.ledger).filter((r) => r.gate !== "version-count" || r.verdict === "refused");
  assert.strictEqual(rows.length, 1, `the clean run must add nothing and the refusal exactly one line: ${JSON.stringify(rows)}`);
  assert.deepStrictEqual(Object.keys(rows[0]).sort(), ["actor", "evidence", "gate", "reason", "ts", "verdict", "version"]);
  assert.match(rows[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(rows[0].gate, "evidence");
  assert.strictEqual(rows[0].verdict, "refused");
  assert.strictEqual(rows[0].version, TARGET);
  assert.ok(rows[0].reason, "the refusal line must carry the reason it refused on");
  assert.ok(rows[0].actor, "an event with no actor records nothing about who did it");
});

guarded("usage errors exit 2 (error), never 1 (refused) -- the two are different outcomes", () => {
  needGate("the exit-code contract must hold");
  const f = makeFixture("usage");
  const unknown = runInProcess(["not-a-gate", "--ledger", f.ledger]);
  assert.strictEqual(unknown.exit, 2, unknown.out);
  const noVersion = runInProcess(["version-count", "--ledger", f.ledger]);
  assert.strictEqual(noVersion.exit, 2, noVersion.out);
  const badMax = runInProcess(["version-count", "--version", TARGET, "--max", "two", "--ledger", f.ledger]);
  assert.strictEqual(badMax.exit, 2, badMax.out);
});

/* ================================================================= test 8 */
/* the bypass: the ONE way past the gates, and it is RECORDED rather than silent */

guarded("bypass: without a --reason it is REFUSED, names what is missing, and writes NOTHING", () => {
  needGate("the bypass entry point must exist");
  const f = makeFixture("bypass-noreason");
  f.seedRelease("0.1.49");
  f.seedRelease(OLD);
  const before = ledgerLines(f.ledger).length;

  const r = runInProcess(["bypass", "--version", TARGET, "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 1, `a bypass with no reason must be refused: ${r.out}`);
  assert.match(r.out, /RELEASE GATE bypass REFUSED/);
  assert.match(r.out, /--reason is required and was not given/);
  assert.match(r.out, /a bypass without a written reason is not a bypass/);
  assert.strictEqual(ledgerLines(f.ledger).length, before,
    'a refused bypass must leave NO trace: a {"gate":"bypass"} row would read as a bypass that happened');

  // and as a real process, so the refusal's exit code is the operating system's
  const p = runProcess(["bypass", "--version", TARGET, "--ledger", f.ledger], f.env);
  assert.strictEqual(p.exit, 1, `the child process exit was ${p.exit}: ${p.out}`);
  assert.match(p.out, /RELEASE GATE bypass REFUSED/);
});

guarded("bypass: with a --reason it is ALLOWED and lands EXACTLY one {\"gate\":\"bypass\"} row", () => {
  needGate("the skip must be recorded, not silent");
  const f = makeFixture("bypass-recorded");
  f.seedRelease("0.1.49");
  f.seedRelease(OLD);
  const before = ledgerLines(f.ledger).length;
  const why = "incident: the canary hooks are unconfigured and the fleet must move now";

  const r = runInProcess(["bypass", "--version", TARGET, "--reason", why, "--ledger", f.ledger, "--actor", "operator"]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.match(r.out, /RELEASE GATE bypass ALLOWED/);

  const rows = ledgerLines(f.ledger);
  assert.strictEqual(rows.length, before + 1, "a bypass writes exactly ONE row");
  const row = rows.pop();
  assert.deepStrictEqual(Object.keys(row).sort(), ["actor", "evidence", "gate", "reason", "ts", "verdict", "version"]);
  assert.strictEqual(row.gate, "bypass");
  assert.strictEqual(row.verdict, "bypassed");
  assert.strictEqual(row.version, TARGET);
  assert.strictEqual(row.actor, "operator");
  assert.strictEqual(row.reason, why, "the written reason must be the reason in the ledger");
  assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T/);
});

guarded("bypass: a bypass releases NOTHING -- the day's budget and the release count are untouched", () => {
  needGate("a bypass must not be able to launder a release");
  const f = makeFixture("bypass-inert");
  f.seedRelease("0.1.49");
  f.seedRelease(OLD);

  const r = runInProcess(["bypass", "--version", TARGET, "--reason", "hotfix window", "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.strictEqual(ledgerLines(f.ledger).filter((x) => x.verdict === "released").length, 2,
    "a bypass is a skip, never a release");

  // the day is still full, so the very next version-count still refuses
  const count = runInProcess(["version-count", "--version", TARGET, "--ledger", f.ledger]);
  assert.strictEqual(count.exit, 1, count.out);
  assert.match(count.out, /RELEASE GATE version-count REFUSED/);
});

guarded("fail closed: an unreadable config REFUSES the release even when the ledger says the canary passed", () => {
  needGate("the config must be an INPUT, not an assumption");
  const f = makeFixture("config-unreadable");
  const facts = writeFacts(f.dir, { version: TARGET });
  const canary = runInProcess(["canary", "--version", TARGET, "--machine", "mai", "--config", f.config, "--ledger", f.ledger, "--facts", facts], f.env);
  assert.strictEqual(canary.exit, 0, canary.out);
  const accept = runInProcess(["accept", "--version", TARGET, "--author", "author", "--accepted-by", "reviewer-x", "--evidence", f.evidence, "--ledger", f.ledger]);
  assert.strictEqual(accept.exit, 0, accept.out);

  // the ledger holds a canary_passed row for this version, which is all the fleet gate reads.
  const gone = join(f.dir, "no-such-config.json");
  const r = runInProcess(["release", "--version", TARGET, "--evidence", f.evidence, "--author", "author", "--config", gone, "--ledger", f.ledger]);
  assert.strictEqual(r.exit, 1, `an unreadable config must refuse, never pass: ${r.out}`);
  assert.match(r.out, /RELEASE GATE canary REFUSED/);
  assert.match(r.out, /no canary configuration/);
  assert.match(r.out, /cannot be read/);
  assert.strictEqual(ledgerLines(f.ledger).filter((x) => x.verdict === "released").length, 0,
    "nothing may be recorded as released while the machine facts cannot be read");
});

/* ------------------------------------------------------------------ footer */

test("summary", () => {
  assert.strictEqual(failures, 0, `${failures} release-gate case(s) failed`);
});
