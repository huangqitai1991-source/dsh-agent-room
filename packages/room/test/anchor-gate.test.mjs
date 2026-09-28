/**
 * dsh-agent-room 0.1.50 -- the SYMBOL-LEVEL ANCHOR GATE, and the one command that composes it.
 *
 * SPECIFICATION BY CC (agentId 01a094c1-..., macOS, @deepseek-ai/dsh 0.1.1-rc.2), derived from
 * boyin111-1/dsh-doctor's `ANCHOR_BASELINE_VERSION` / `ANCHORS[]` / `checkAnchorBaseline()` /
 * `--verify-anchors`. The four hard requirements below are acceptance, not suggestions:
 *
 *   1. ANCHOR BY SOURCE TOKEN, not by version string. A version decides WHETHER to re-check;
 *      the symbols decide WHETHER WE MAY STILL BELIEVE OURSELVES.
 *   2. `--verify-anchors <dir>` CHECKS THAT DIRECTORY. It must never quietly fall back to this
 *      machine's own install -- that fallback is the documented root cause of "bad copy judged
 *      healthy / code 0". This is a hard red line and it is a test below.
 *   3. COMPILED -> SOURCE FALLBACK IS MANDATORY. A3 (`readonly callId`) is a TS declaration that
 *      does not exist in the emitted `lib/*.js`, so a compiled-only gate produces a FALSE RED.
 *      The gate must be right in BOTH directions: no false green, no false red.
 *   4. FAIL LOUD AND NAME WHAT BECAME UNTRUSTWORTHY: non-zero exit plus, per missing anchor, the
 *      full `dependsOn` list of conclusions that can no longer be believed.
 *
 * Everything here runs against a HERMETIC fixture install built in the OS temp directory, so the
 * suite is portable; the one test that touches the real install is tolerant (it asserts the
 * drift-tolerated branch when the machine's version is not the measured baseline).
 *
 * AR_GATE_DIR points this suite at ANOTHER build's `tools/` directory (the old-vs-new evidence:
 * at the pre-change commit `tools/` holds only repair-identity.mjs, so every case here fails).
 *
 * Run directly:  node test/anchor-gate.test.mjs     (never `node --test`)
 */

import assert from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOLS = process.env.AR_GATE_DIR ? join(process.env.AR_GATE_DIR) : join(ROOT, "tools");
const GATE_FILE = join(TOOLS, "anchor-gate.mjs");
const GATE_FILE_URL = pathToFileURL(GATE_FILE).href;
const INSTALL_GATE_FILE_URL = pathToFileURL(join(TOOLS, "install-gate.mjs")).href;

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
let installGate = null;
try {
  installGate = await import(INSTALL_GATE_FILE_URL);
} catch { /* reported by needGate when the file is missing */ }

/** Every anchor-gate assertion calls this first: on an older tree it fails the test BY NAME. */
function needGate(what) {
  if (!gate) {
    failures += 1;
    throw new Error(
      `the symbol-level anchor gate does not exist in ${TOOLS} (AR_GATE_DIR=${process.env.AR_GATE_DIR ?? "(local tools)"}): ` +
        `${what}. import error: ${String(gateImportError)}`,
    );
  }
}

/* --------------------------------------------------------------- fixture */

const FIXTURE_ROOT = join(tmpdir(), "dsh-anchor-gate-" + process.pid);

const TOKENS = {
  session: "\"tool/call\" x \"tool/result\"\n",
  toolsJs: "// emitted JS: the TS declaration below is NOT in here\n",
  toolsDts: "export interface ToolResultMessage {\n  readonly callId: CallId;\n}\n",
  bootJs: "const [installAnchor, join(profileDir)] = []\nconst p = pkg?.dsh?.bundle?.patch;\n",
};

/**
 * A hermetic install: the same shape npm produces (flat `node_modules` is enough for the gate,
 * and the nested layout is covered by the real-install test).
 */
function makeFixture(name, { break: breakWhat = null } = {}) {
  const dir = join(FIXTURE_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  const dshPkg = join(dir, "node_modules", "@deepseek-ai", "dsh");
  const scope = join(dshPkg, "node_modules", "@deepseek-ai");
  mkdirSync(join(scope, "dsh-session", "lib"), { recursive: true });
  mkdirSync(join(scope, "dsh-tools", "lib", "types"), { recursive: true });
  mkdirSync(join(scope, "dsh-app-boot", "lib"), { recursive: true });
  writeFileSync(join(dshPkg, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version: gate?.ANCHOR_BASELINE_VERSION ?? "0.1.1-rc.2" }));
  writeFileSync(join(scope, "dsh-session", "lib", "index.js"), TOKENS.session);
  writeFileSync(join(scope, "dsh-tools", "lib", "index.js"), TOKENS.toolsJs);
  writeFileSync(join(scope, "dsh-tools", "lib", "types", "index.d.ts"), TOKENS.toolsDts);
  if (breakWhat !== "boot") writeFileSync(join(scope, "dsh-app-boot", "lib", "index.js"), TOKENS.bootJs);
  return { dir, dshPkg, scope };
}

/** Capture the gate's own output in-process (no pipes, no sandbox surprises). */
function runGateInProcess(argv) {
  const lines = [];
  const io = { log: (s) => lines.push(String(s)), error: (s) => lines.push(String(s)) };
  const run = gate.runAnchorGate(argv, io);
  return { exit: run.exit, result: run.result, out: lines.join("\n") };
}

/** A real child process, so the EXIT CODE is the operating system's, not a return value. */
function runGateProcess(argv) {
  try {
    execFileSync(process.execPath, [GATE_FILE, ...argv], { stdio: "ignore" });
    return 0;
  } catch (e) {
    return typeof e.status === "number" ? e.status : -1;
  }
}

function snapshotTree(root) {
  const map = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(full); continue; }
      try { const st = lstatSync(full); map.set(full, st.mtimeMs + ":" + st.size); } catch { /* ignore */ }
    }
  }
  return map;
}

function diffSnapshots(a, b) {
  const out = [];
  for (const [k, v] of a) if (b.get(k) !== v) out.push(k);
  for (const k of b.keys()) if (!a.has(k)) out.push(k);
  return out;
}

/* ------------------------------------------------------- 1. the five anchors */

guarded("a healthy install fixture hits all five anchors: 5 ok / 0 missing, exit 0", () => {
  needGate("the five anchors must be scannable");
  const fx = makeFixture("healthy");
  const r = runGateInProcess(["--verify-anchors", fx.dir]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.strictEqual(r.result.anchors.filter((a) => a.ok).length, 5, r.out);
  assert.strictEqual(r.result.missing.length, 0, r.out);
  assert.match(r.out, /5 \u2713 \/ 0 \u2717/, "the count line is part of the contract");
  // every hit must PRINT its path: an unprintable hit cannot be reviewed by a human
  for (const a of r.result.anchors) assert.ok(a.path, `${a.id} must report the file it hit in`);
});

guarded("A3 is reachable ONLY through the source form: a compiled-only gate is a FALSE RED", () => {
  needGate("the compiled->source fallback is the A3 requirement");
  const fx = makeFixture("a3");
  const good = gate.scanAnchor(gate.ANCHORS.find((a) => a.id === "A3"), fx.dshPkg);
  assert.strictEqual(good.ok, true, "the correct implementation must not false-red on A3");
  assert.strictEqual(good.mode, "source", "and it must be honest that only the source form hit");
  const naive = gate.scanAnchor(gate.ANCHORS.find((a) => a.id === "A3"), fx.dshPkg, { compiledOnly: true });
  assert.strictEqual(naive.ok, false,
    "a compiled-only scan MUST miss A3 -- this is the false red the specification forbids");
  // and the whole gate must be right in BOTH directions
  const r = runGateInProcess(["--verify-anchors", fx.dir, "--compiled-only"]);
  assert.strictEqual(r.exit, 1, "diagnostic mode reproduces the false red (exit 1), which is why it is not a verdict");
});

guarded("the file globs are FULL-NAME anchored: *.js must not match index.d.ts", () => {
  needGate("glob anchoring decides whether a declaration file counts as compiled output");
  const fx = makeFixture("glob");
  // The compiled token exists in the fixture, but ONLY inside a .d.ts file. A `*.js` glob that
  // was implemented as endsWith/contains would wrongly match it.
  writeFileSync(join(fx.scope, "dsh-tools", "lib", "types", "index.d.ts"),
    TOKENS.toolsDts + "readonly callId\n");
  const naive = gate.scanAnchor(gate.ANCHORS.find((a) => a.id === "A3"), fx.dshPkg, { compiledOnly: true });
  assert.strictEqual(naive.ok, false, "`readonly callId` inside index.d.ts must NOT satisfy the *.js form");
  const normal = gate.scanAnchor(gate.ANCHORS.find((a) => a.id === "A3"), fx.dshPkg);
  assert.strictEqual(normal.mode, "source", "the *.ts form is what legitimately matches it");
});

/* ------------------------------------------------- 2. the acceptance non-example */

guarded("THE BROKEN COPY is reported BAD with exit 1, and both voided conclusions are NAMED", () => {
  needGate("the broken-copy case is the acceptance non-example (D-41)");
  const fx = makeFixture("broken", { break: "boot" });
  const r = runGateInProcess(["--verify-anchors", fx.dir]);
  assert.strictEqual(r.exit, 1, "a broken copy must NEVER be reported as healthy/0\n" + r.out);
  assert.ok(r.result.missing.length >= 2, "A4 and A5 both live in the deleted boot file\n" + r.out);
  const text = r.out;
  assert.match(text, /\u2717 ANCHOR MISSING \[A4\]/, text);
  assert.match(text, /\u2717 ANCHOR MISSING \[A5\]/, text);
  assert.match(text, /bundles integrity/, "the conclusions that are now void must be named");
  assert.match(text, /bundle<->patch id collision/, text);
  assert.match(text, /DECOUPLED/, "the gate says out loud that it is decoupled");
  assert.doesNotMatch(text, /healthy/i, "no healthy-shaped wording anywhere in a decoupled report");
  assert.strictEqual(r.result.anchorsDecoupled, true);
  // the real process exit code agrees with the in-process one
  assert.strictEqual(runGateProcess(["--verify-anchors", fx.dir]), 1);
});

/* ------------------------------------------------------ 3. the red line (hard) */

guarded("RED LINE: --verify-anchors <dir> checks THAT directory and never this machine's install", () => {
  needGate("the no-fallback rule is the root cause fix for the bad copy judged healthy");
  // This machine DOES have a real, healthy install on PATH (discovery finds it), and the fixture
  // is broken. If the tool fell back, the broken copy would be reported healthy. It must not.
  const real = gate.discoverInstall({});
  const fx = makeFixture("redline", { break: "boot" });
  assert.strictEqual(gate.discoverInstall({ explicitDir: fx.dir }).root, fx.dshPkg,
    "an explicit directory must resolve to itself");
  const r = runGateInProcess(["--verify-anchors", fx.dir]);
  assert.strictEqual(r.exit, 1, "a broken copy is bad even when a healthy install exists\n" + r.out);
  assert.strictEqual(r.result.installRoot, fx.dshPkg, "the reported root must be the copy, not the local install");
  assert.notStrictEqual(r.result.installRoot, real.root,
    "the anchor root must never silently become this machine's own install");
});

guarded("RED LINE: an explicitly named directory with no dsh is REFUSED (exit 2), with no verdict", () => {
  needGate("refusing is the only safe answer when the artefact under test is not there");
  const empty = join(FIXTURE_ROOT, "empty-dir");
  mkdirSync(empty, { recursive: true });
  const found = gate.discoverInstall({ explicitDir: empty });
  assert.strictEqual(found.root, null,
    "an explicit directory with no @deepseek-ai/dsh must resolve to NOTHING, even though PATH has a real install");
  assert.strictEqual(found.explicit, true);
  assert.match(String(found.error), /no @deepseek-ai\/dsh package/);
  const r = runGateInProcess(["--verify-anchors", empty]);
  assert.strictEqual(r.exit, 2, r.out);
  assert.match(r.out, /would report a broken copy as healthy, so it is refused/);
  assert.doesNotMatch(r.out, /\u2713 ANCHOR OK/, "a refusal must not print any anchor verdict");
  assert.strictEqual(runGateProcess(["--verify-anchors", empty]), 2);
});

/* ------------------------------------------------------------- 4. fail-closed */

guarded("fail-closed: while decoupled, writers are refused; --force is the only way through", () => {
  needGate("fail-closed must cover FUTURE writers, not only today's repair items");
  const fx = makeFixture("failclosed", { break: "boot" });
  const r = runGateInProcess(["--verify-anchors", fx.dir]);
  assert.strictEqual(r.result.anchorsDecoupled, true);
  const trace = [];
  assert.strictEqual(gate.assertWritesAllowed(r.result, { action: "repairing bundles", log: (m) => trace.push(m) }), false,
    "no write may proceed on a decoupled harness");
  assert.match(trace.join("\n"), /FAIL-CLOSED: refusing repairing bundles/);
  assert.match(trace.join("\n"), /bundles integrity/, "the refusal names the voided conclusions");
  const forced = [];
  assert.strictEqual(gate.assertWritesAllowed(r.result, { force: true, action: "repairing bundles", log: (m) => forced.push(m) }), true);
  assert.match(forced.join("\n"), /FORCED WHILE DECOUPLED/, "--force must leave a trace, never be silent");
  // A read-only caller is never blocked, and a healthy gate never blocks anything.
  const healthy = runGateInProcess(["--verify-anchors", makeFixture("failclosed-ok").dir]);
  assert.strictEqual(gate.assertWritesAllowed(healthy.result, { action: "x" }), true);
});

/* -------------------------------------------------------------- 5. read-only */

guarded("read-only: a full scan, including the broken copy, changes nothing on disk", () => {
  needGate("the gate must be safe against a copy, a worktree or a stopped install");
  const fx = makeFixture("readonly");
  const before = snapshotTree(fx.dir);
  const r = runGateInProcess(["--verify-anchors", fx.dir, "--readonly-proof"]);
  const after = snapshotTree(fx.dir);
  assert.strictEqual(r.exit, 0, r.out);
  assert.deepStrictEqual(diffSnapshots(before, after), [], "the gate wrote to the tree it inspected");
  assert.match(r.out, /READONLY PROOF: \d+ entries snapshotted, 0 differences/);
  assert.strictEqual(r.result.readonlyProof.differences, 0);
});

/* ------------------------------------------------------- 6. the drift machine */

guarded("version drift alone is tolerated while all anchors still hit (T1, exit 0)", () => {
  needGate("the version number decides whether to re-check, never whether to believe");
  const fx = makeFixture("drift");
  const r = runGateInProcess(["--verify-anchors", fx.dir, "--baseline", "0.1.1-rc.1"]);
  assert.strictEqual(r.exit, 0, "a drifted version with every anchor alive is NOT a failure\n" + r.out);
  assert.strictEqual(r.result.drift, true, "but the drift must be reported");
  assert.match(r.out, /DRIFT-TOLERATED/);
  assert.match(r.out, /all 5 anchors still hit/);
  // --strict is the opt-in that turns drift alone into a non-zero exit
  assert.strictEqual(runGateProcess(["--verify-anchors", fx.dir, "--baseline", "0.1.1-rc.1", "--strict"]), 1);
  // ...but a missing anchor is non-zero either way
  const broken = runGateInProcess(["--verify-anchors", makeFixture("drift-broken", { break: "boot" }).dir, "--baseline", "0.1.1-rc.1"]);
  assert.strictEqual(broken.exit, 1);
});

/* --------------------------------------------- 7. the real install (tolerant) */

guarded("the real install on this machine: no false red, and no silent skip", () => {
  needGate("the acceptance case is measured against a real install");
  const real = gate.discoverInstall({});
  assert.ok(real.root, "no dsh install was discovered -- the gate would silently skip, which this test must expose");
  const r = runGateInProcess(["--verify-anchors"]);
  const okCount = r.result.anchors.filter((a) => a.ok).length;
  if (!r.result.drift) {
    assert.strictEqual(r.exit, 0, r.out);
    assert.strictEqual(r.result.missing.length, 0, `the measured baseline install must not false-red:\n${r.out}`);
    assert.strictEqual(okCount, 5);
    // A3, the anchor that only the source form can see, must be alive on the real install too.
    const a3 = r.result.anchors.find((a) => a.id === "A3");
    assert.strictEqual(a3.ok, true, "A3 must hit on a real install (source fallback)");
    assert.strictEqual(a3.mode, "source");
  } else {
    assert.match(r.out, /DRIFT-TOLERATED|DECOUPLED/);
  }
  assert.ok(r.result.version, "the installed dsh version must be readable");
});

/* --------------------------------------------------- 8. the composing command */

async function withStateServer(shape, fn) {
  const server = createServer((req, res) => {
    if (req.url && req.url.startsWith("/agent-room-api/state")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: shape }));
      return;
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  try { return await fn("http://127.0.0.1:" + port, port); }
  finally { await new Promise((done) => server.close(done)); }
}

function pluginFixture(version) {
  const dir = join(FIXTURE_ROOT, "plugin-" + version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dsh-agent-room", version }));
  return dir;
}

const FULL_SHAPE = { identity: {}, node: {}, relay: {}, discovered: [], dedupe: {}, wake: {}, ack: {}, activation: {}, bridgeTruth: {}, rooms: [] };

guarded("install-gate: ONE command answers all three questions -- healthy install, exit 0", async () => {
  needGate("the composition point carries the same exit-code contract");
  assert.ok(installGate, "tools/install-gate.mjs must exist");
  const fx = makeFixture("compose-ok");
  await withStateServer(FULL_SHAPE, async (base) => {
    const r = await installGate.runInstallGate([
      "--base", base, "--dsh-dir", fx.dir, "--plugin-dir", pluginFixture("0.1.49"), "--quiet",
    ], { log: () => {}, error: () => {} });
    assert.strictEqual(r.exit, 0, JSON.stringify(r.result.checks, null, 2));
    assert.strictEqual(r.result.verdict, "HEALTHY");
    assert.deepStrictEqual(r.result.checks.map((c) => c.name).slice(0, 3), ["anchors", "running", "guard"]);
    assert.ok(r.result.checks.every((c) => c.status === "pass"), JSON.stringify(r.result.checks));
  });
});

guarded("install-gate: D-42 (disk 0.1.49, running plugin without `activation`) is UNHEALTHY exit 3", async () => {
  needGate("D-42 is the incident this check exists for");
  assert.ok(installGate, "tools/install-gate.mjs must exist");
  const fx = makeFixture("compose-d42");
  // Exactly the observed D-42 shape: the install reported success while /state still carried the
  // previous release's keys, because the watchdog restarted the host one second too early.
  const old = { identity: {}, node: {}, relay: {}, discovered: [], dedupe: {}, wake: {}, ack: {}, bridgeTruth: {}, rooms: [] };
  await withStateServer(old, async (base) => {
    const r = await installGate.runInstallGate([
      "--base", base, "--dsh-dir", fx.dir, "--plugin-dir", pluginFixture("0.1.49"), "--quiet",
    ], { log: () => {}, error: () => {} });
    assert.strictEqual(r.exit, 3, JSON.stringify(r.result.checks, null, 2));
    assert.strictEqual(r.result.verdict, "UNHEALTHY");
    const running = r.result.checks.find((c) => c.name === "running");
    assert.strictEqual(running.status, "fail");
    assert.match(running.detail, /missing activation/);
    assert.match(running.detail, /memory holds an older build than the disk/);
    // requiredStateKeys is the table, and it must be monotone in the version
    assert.deepStrictEqual(installGate.requiredStateKeys("0.1.45"), ["dedupe", "wake"]);
    assert.deepStrictEqual(installGate.requiredStateKeys("0.1.46"), ["dedupe", "wake", "ack"]);
    assert.deepStrictEqual(installGate.requiredStateKeys("0.1.49"), ["dedupe", "wake", "ack", "activation"]);
  });
});

guarded("install-gate: an unreadable running side is CANNOT TELL (exit 4), never rounded up to 0", async () => {
  needGate("a failed READ is never a pass");
  assert.ok(installGate, "tools/install-gate.mjs must exist");
  const fx = makeFixture("compose-tell");
  // Port 1 on loopback: nothing is listening, so nothing can be read.
  const r = await installGate.runInstallGate([
    "--base", "http://127.0.0.1:1", "--dsh-dir", fx.dir, "--plugin-dir", pluginFixture("0.1.49"),
    "--allow-stopped", "--quiet",
  ], { log: () => {}, error: () => {} });
  assert.strictEqual(r.exit, 4, JSON.stringify(r.result.checks, null, 2));
  assert.strictEqual(r.result.verdict, "CANNOT TELL");
  assert.ok(r.result.checks.some((c) => c.status === "tell"));
  // Without --allow-stopped a dead service is a failure, not an unknown.
  const down = await installGate.runInstallGate([
    "--base", "http://127.0.0.1:1", "--dsh-dir", fx.dir, "--plugin-dir", pluginFixture("0.1.49"), "--quiet",
  ], { log: () => {}, error: () => {} });
  assert.strictEqual(down.exit, 3, "a service that should be up and is not is UNHEALTHY");
  // A known-bad outranks an unknown: anchor failure + unreadable running side is still 3.
  const broken = makeFixture("compose-both", { break: "boot" });
  const both = await installGate.runInstallGate([
    "--base", "http://127.0.0.1:1", "--dsh-dir", broken.dir, "--plugin-dir", pluginFixture("0.1.49"), "--quiet",
  ], { log: () => {}, error: () => {} });
  assert.strictEqual(both.exit, 3, "unhealthy outranks cannot-tell");
  assert.deepStrictEqual(both.result.anchors.untrustworthy.includes("bundles integrity"), true);
});

/* --------------------------------------------------------- 9. static guards */

guarded("0.1.50 static guard: the gate ships read-only, single-file, with the red line in code", () => {
  needGate("the source, not just the behaviour, must show the discipline");
  if (!gate) return;
  const src = readFileSync(GATE_FILE, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bwriteFileSync\b|\bmkdirSync\b|\brmSync\b|\bappendFileSync\b|\bcreateWriteStream\b/,
    "the gate must never write anything");
  assert.doesNotMatch(code, /\bimport\(|\brequire\(|eval\(/, "no import/eval of the inspected code: text matching only");
  assert.doesNotMatch(code, /https?:\/\//, "no network: the anchor check is purely local");
  assert.match(src, /would report a broken copy as healthy, so it is refused/,
    "the refusal is the red line and it is stated in the code");
  assert.match(src, /ANCHOR GATE REFUSED/);
  // The baseline version and the anchor list are one unit: both live in this file.
  assert.strictEqual(gate.ANCHOR_BASELINE_VERSION, "0.1.1-rc.2");
  assert.deepStrictEqual(gate.ANCHORS.map((a) => a.id), ["A1", "A2", "A3", "A4", "A5"]);
  for (const a of gate.ANCHORS) {
    for (const field of ["id", "name", "tokenCompiled", "tokenSource", "fileCompiled", "fileSource", "searchDirs", "dependsOn"]) {
      assert.ok(a[field] !== undefined, `${a.id} is missing the specification field ${field}`);
    }
    assert.ok(a.dependsOn.length > 0, `${a.id} must name what its absence invalidates`);
    assert.ok(a.tokenCompiled !== undefined && a.tokenSource !== undefined,
      `${a.id} needs BOTH forms (the A3 requirement)`);
  }
});

/* -------------------------------------------------------------- lifecycle */

const watchdog = setTimeout(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  process.exit(failures > 0 ? 1 : 0);
}, 120_000);
watchdog.unref();

process.on("exit", () => {
  try { rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});
