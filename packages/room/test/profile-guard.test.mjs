/**
 * dsh-agent-room -- THE PROFILE GUARD (D-47)
 *
 * WHY THIS SUITE EXISTS
 *   A half-installed profile is an invisible machine: the install fails (pnpm cannot create its
 *   symlinks without Windows' symlink privilege), the host then dies at boot with
 *   `cannot resolve profile bundle`, and nothing reports it -- no port to poll, no room connection to
 *   notice. `tools/profile-guard.mjs` turns "does this profile actually resolve?" into a verdict a
 *   caller can REFUSE on (exit 11 = do not start the host) and, with --repair, into an automatic fix
 *   that needs no package manager and no privilege: extract the tarball the profile already declares.
 *
 * THE ONE THING EVERY TEST HERE PROTECTS
 *   The judgement must come from the REAL resolver (`dsh --profile <p> --dump-config`), not from a
 *   reimplementation of it: a guard that disagrees with the boot loader is worse than no guard,
 *   because it certifies machines that cannot start.
 *
 * Run directly:  node test/profile-guard.test.mjs     (never `node --test`: it is EPERM here)
 */

import assert from "node:assert";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const guard = await import(pathToFileURL(join(ROOT, "tools", "profile-guard.mjs")).href);
const { EXIT_OK, EXIT_REPAIRED, EXIT_STILL_BROKEN, EXIT_USAGE, checkProfile, declaredTarballs, freezeDeclaration, parseArgv, restoreDeclaration, runProfileGuard } = guard;

let failures = 0;
const guarded = (name, fn) =>
  test(name, async (t) => {
    try { await fn(t); } catch (error) { failures += 1; throw error; }
  });

const FIXTURE_ROOT = join(ROOT, "test", ".profile-guard-fixtures", String(process.pid));

/** A DSH home with one profile, so the guard's paths are real without touching the live install. */
function fakeHome(name, { deps = {}, bundles = [], cordis = "[]" } = {}) {
  const home = join(FIXTURE_ROOT, name);
  rmSync(home, { recursive: true, force: true });
  const dir = join(home, "profiles", "web");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p-web", private: true, dependencies: deps, dsh: { profile: { bundles } } }, null, 2));
  writeFileSync(join(dir, "cordis.yml"), cordis);
  return { home, dir };
}

/** The exact text the real resolver prints when a bundle cannot be found (captured 2026-09-16). */
const cannotResolve = (pkg, dir) =>
  `Error: dsh: cannot resolve profile bundle "${pkg}" from the dsh installation or ${dir}; ` +
  `run 'dsh plugin --profile web install' if its dependency is not installed\n` +
  "    at resolveBundleDir (file:///…/dsh-app-boot/lib/index.js:523:8)\n    at Array.map (<anonymous>)\n\nNode.js v24.14.1\n";

const cannedRun = (answers) => (command, opts = {}) => {
  for (const [needle, answer] of answers) {
    if (command.includes(needle)) return typeof answer === "function" ? answer(command, opts) : answer;
  }
  return { status: 0, text: "", error: null };
};

const silent = { log: () => {}, error: () => {} };

function makeTarball(dir, pkgName, version) {
  const stage = join(dir, "stage", "package");
  mkdirSync(join(stage, "lib"), { recursive: true });
  writeFileSync(join(stage, "package.json"), JSON.stringify({ name: pkgName, version, main: "lib/index.js" }));
  writeFileSync(join(stage, "lib", "index.js"), "export const ok = true;\n");
  const tgz = join(dir, `${pkgName}-${version}.tgz`);
  execFileSync("tar", ["-czf", tgz, "-C", join(dir, "stage"), "package"], { stdio: "ignore" });
  rmSync(join(dir, "stage"), { recursive: true, force: true });
  return tgz;
}

/* --------------------------------------------------------------- the parsers */

guarded("parseArgv insists on --profile and validates --timeout-ms", () => {
  assert.match(parseArgv(["--timeout-ms", "0"]).error, /must be a positive integer/);
  assert.match(parseArgv(["--nope"]).error, /unknown argument: --nope/);
  const ok = parseArgv(["--profile", "web", "--repair", "--ledger", "x.jsonl"]);
  assert.strictEqual(ok.profile, "web");
  assert.strictEqual(ok.repair, true);
  assert.strictEqual(ok.ledger, "x.jsonl");
  // --profile with no value must be refused rather than silently defaulting
  assert.match(parseArgv(["--profile", "--repair"]).error, /needs a value/);
});

guarded("declaredTarballs reads the profile's own file: dependencies and their presence", () => {
  const { dir } = fakeHome("declared", {
    deps: { "dsh-agent-org": "file:C:/nope/org.tgz", lodash: "^4.0.0" },
  });
  const declared = declaredTarballs(dir);
  assert.strictEqual(declared.length, 1, "only file: deps are tarballs");
  assert.strictEqual(declared[0].name, "dsh-agent-org");
  assert.strictEqual(declared[0].present, false);
  assert.strictEqual(declared[0].installed, false);
});

/* --------------------------------------------------- classification (injected) */

guarded("checkProfile: exit 0 means resolves, and the missing bundle NAMES are extracted from the refusal", () => {
  const ok = checkProfile({ profile: "web", run: cannedRun([["--dump-config", { status: 0, text: "[]\n" }]]) });
  assert.strictEqual(ok.resolves, true);

  const bad = checkProfile({
    profile: "web",
    run: cannedRun([["--dump-config", { status: 1, text: cannotResolve("dsh-agent-org", "C:\\p") }]]),
  });
  assert.strictEqual(bad.resolves, false);
  assert.deepStrictEqual(bad.missing, ["dsh-agent-org"]);
});

guarded("checkProfile: an unrelated failure is not reported as 'resolves', and keeps one readable line", () => {
  const other = checkProfile({
    profile: "web",
    run: cannedRun([["--dump-config", { status: 1, text: "Error: EPERM: operation not permitted, open 'x'\n    at writeFileSync\nNode.js v24.14.1\n" }]]),
  });
  assert.strictEqual(other.resolves, false);
  assert.deepStrictEqual(other.missing, []);
  assert.match(other.errorLine, /EPERM: operation not permitted/);
  assert.doesNotMatch(other.errorLine, /^\s*at writeFileSync/, "stack frames are not the reason");
});

/* ------------------------------------------------------------ verdicts (E1) */

guarded("a profile that cannot resolve is REFUSED with exit 11 and says the host must not start", () => {
  const { home, dir } = fakeHome("broken", { deps: { "dsh-agent-org": "file:C:/nope/org.tgz" }, bundles: ["dsh-agent-org"] });
  const ledger = join(home, "guard.jsonl");
  const r = runProfileGuard(["--profile", "web", "--dsh-home", home, "--ledger", ledger], silent, {
    run: cannedRun([
      ["--dump-config", { status: 1, text: cannotResolve("dsh-agent-org", dir) }],
    ]),
  });
  assert.strictEqual(r.exit, EXIT_STILL_BROKEN, JSON.stringify(r.result));
  assert.strictEqual(r.result.repairSkipped, true);
  const rows = readFileSync(ledger, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].verdict, "still-broken");
  assert.deepStrictEqual(rows[0].missingBefore, ["dsh-agent-org"]);
});

guarded("--repair fixes a pruned profile by extracting its own tarball (no package manager, no symlinks) -> exit 10", () => {
  const tgz = makeTarball(join(FIXTURE_ROOT, "repairable-src"), "dsh-agent-org", "0.2.12");
  const { home, dir } = fakeHome("repairable", {
    deps: { "dsh-agent-org": `file:${tgz.replace(/\\/g, "/")}` }, bundles: ["dsh-agent-org"],
  });
  const ledger = join(home, "guard.jsonl");
  let dumpCalls = 0;
  const run = (command, opts = {}) => {
    if (command.includes("--dump-config")) {
      dumpCalls += 1;
      // before the repair the resolver refuses; after the extraction the bundle is really there
      const installed = existsSync(join(dir, "node_modules", "dsh-agent-org", "package.json"));
      return installed ? { status: 0, text: "[]\n" } : { status: 1, text: cannotResolve("dsh-agent-org", dir) };
    }
    if (command.includes("plugin --profile web install")) {
      return { status: 1, text: "dsh: pnpm failed in profile directory\nERR_PNPM_EPERM symlinkAllModules\n" };
    }
    // the tar step must be the REAL tar, on the REAL fixture tarball
    return execFileSync2(command);
  };
  const r = runProfileGuard(["--profile", "web", "--dsh-home", home, "--ledger", ledger, "--repair"], silent, { run });
  assert.strictEqual(r.exit, EXIT_REPAIRED, JSON.stringify(r.result));
  // The resolver is asked THREE times: before any repair, after the installer step, and after the
  // extraction. Each repair step has to prove itself -- "the command ran" is not "the profile resolves".
  assert.strictEqual(dumpCalls, 3, "the guard re-asks the resolver after each repair step");
  assert.strictEqual(existsSync(join(dir, "node_modules", "dsh-agent-org", "package.json")), true);
  assert.strictEqual(existsSync(join(dir, "node_modules", "dsh-agent-org", "lib", "index.js")), true);
  const rows = readFileSync(ledger, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.strictEqual(rows.at(-1).verdict, "repaired");
  assert.strictEqual(rows.at(-1).actions.some((a) => a.step === "tar extract" && a.ok === true), true);
  // The successful extraction is `status: 0`. Window W-D49h-1: that row used to be pushed raw, so it
  // was the ONE row in the ledger with a bare number and no family beside it -- a bare status is
  // exactly what this file exists to stop handing out (reported by D from a real run).
  const tarRow = rows.at(-1).actions.find((a) => a.step === "tar extract");
  assert.strictEqual(tarRow.status, 0);
  assert.strictEqual(tarRow.statusHex, "0x00000000", "a status of 0 must still carry its hex");
  assert.strictEqual(tarRow.statusSigned, 0);
  assert.strictEqual(tarRow.statusFamily, "unrecognized", "0 belongs to no failure family, and no name may be invented for it");
  assert.strictEqual(tarRow.statusName, null);
});

guarded("freezeDeclaration covers the lockfile the package manager in use actually writes", () => {
  // An npm-type profile has `package-lock.json`; a pnpm-type one has `pnpm-lock.yaml`. Freezing only the
  // pnpm name restored the declaration without its lock on an npm machine (D, window W-D49h-1).
  const { dir } = fakeHome("npmlock", { deps: {}, bundles: [] });
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, name: "p-web" }));
  const frozen = freezeDeclaration(dir);
  const lock = frozen.files.find((f) => f.name === "package-lock.json");
  assert.ok(lock, "package-lock.json must be in the freeze list");
  assert.strictEqual(lock.present, true);
  assert.match(lock.sha256, /^[0-9a-f]{64}$/);
  // damage it the way an installer would, then put it back
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, name: "p-web", changed: true }));
  const restored = restoreDeclaration(frozen);
  const lockBack = restored.files.find((f) => f.name === "package-lock.json");
  assert.strictEqual(lockBack.ok, true);
  assert.strictEqual(readFileSync(join(dir, "package-lock.json"), "utf8"), JSON.stringify({ lockfileVersion: 3, name: "p-web" }));
  // a lockfile this profile never had must NOT be scored as a failed restore
  const pnpm = restored.files.find((f) => f.name === "pnpm-lock.yaml");
  assert.strictEqual(pnpm.ok, true);
  assert.strictEqual(pnpm.action, "absent-before-and-after");
});

guarded("a tarball that is itself missing is REPORTED, never invented -> still exit 11", () => {
  const { home, dir } = fakeHome("notarball", {
    deps: { "dsh-agent-org": "file:C:/nope/org-0.2.12.tgz" }, bundles: ["dsh-agent-org"],
  });
  const r = runProfileGuard(["--profile", "web", "--dsh-home", home, "--repair"], silent, {
    run: cannedRun([
      ["--dump-config", { status: 1, text: cannotResolve("dsh-agent-org", dir) }],
      ["plugin --profile web install", { status: 1, text: "ERR_PNPM_EPERM\n" }],
    ]),
  });
  assert.strictEqual(r.exit, EXIT_STILL_BROKEN);
  const extract = r.result.actions.find((a) => a.step === "tar extract");
  assert.match(extract.reason, /tarball .* is missing/);
});

guarded("a missing profile directory is a usage error (exit 2), not a silent pass", () => {
  const r = runProfileGuard(["--profile", "web", "--dsh-home", join(FIXTURE_ROOT, "emptyhome")], silent, { run: cannedRun([]) });
  assert.strictEqual(r.exit, EXIT_USAGE);
  assert.match(r.result.error, /no profile directory/);
});

/* -------------------------------------------------- the real resolver, once */

guarded("END TO END: the real `dsh --dump-config` is the judge (a valid profile resolves)", () => {
  let hasDsh = true;
  try { execFileSync("dsh", ["--version"], { stdio: "ignore", shell: true }); } catch { hasDsh = false; }
  if (!hasDsh) {
    console.log("  (skipped: no `dsh` on PATH on this machine)");
    return;
  }
  const { home } = fakeHome("realdsh", { bundles: [] });
  const r = runProfileGuard(["--profile", "web", "--dsh-home", home], silent);
  assert.strictEqual(r.exit, EXIT_OK, JSON.stringify(r.result));
  assert.strictEqual(r.result.verdict, "ok");
});

/**
 * Run node with stdio to FILES, not pipes: a confined process may not hand a child a pipe (measured
 * here: `spawnSync … EPERM` and `node --test` itself failing with `spawn EPERM`). Same boundary the
 * file's own execFileSync2 exists for.
 */
function runNodeToFile(args, { env = {} } = {}) {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const tag = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const outLog = join(FIXTURE_ROOT, `nc-out-${tag}.log`);
  const errLog = join(FIXTURE_ROOT, `nc-err-${tag}.log`);
  const outFd = openSync(outLog, "w");
  const errFd = openSync(errLog, "w");
  try {
    const r = spawnSync(process.execPath, args, {
      windowsHide: true,
      detached: false,
      env: { ...process.env, ...env },
      stdio: ["ignore", outFd, errFd],
    });
    return {
      status: r.status,
      out: existsSync(outLog) ? readFileSync(outLog, "utf8") : "",
      err: existsSync(errLog) ? readFileSync(errLog, "utf8") : "",
    };
  } finally {
    try { closeSync(outFd); } catch { /* ignore */ }
    try { closeSync(errFd); } catch { /* ignore */ }
    for (const f of [outLog, errLog]) { try { rmSync(f, { force: true }); } catch { /* ignore */ } }
  }
}

/* ------------------------------------------------ the file NAME is not a switch (D-49f) */

/**
 * MEASURED 2026-09-16 on the published bytes (376204ea…): the entry check was
 * `process.argv[1].endsWith("profile-guard.mjs")`, so the FILE NAME decided whether the gate ran at
 * all. A copy under any other name exited 0 with zero stdout, zero stderr and zero ledger rows --
 * a green verdict from a judgement that never happened, which is exactly the silent-pass class this
 * workstream exists to remove. Reported by D with a reproduction; reproduced here before fixing.
 */
guarded("a renamed copy of the guard is an invocation, never a silent 0", () => {
  const dir = join(FIXTURE_ROOT, "namecheck");
  mkdirSync(dir, { recursive: true });
  const renamed = join(dir, "pub-guard-now.mjs");
  writeFileSync(renamed, readFileSync(join(ROOT, "tools", "profile-guard.mjs")));
  const home = join(dir, "home");
  const ledger = join(dir, "ledger.jsonl");
  const r = runNodeToFile([renamed, "--profile", "web", "--dsh-home", home, "--zzz-not-a-flag", "--ledger", ledger]);
  assert.notStrictEqual(r.status, 0, "a renamed copy must not exit 0");
  assert.strictEqual(r.status, EXIT_USAGE, "an unusable invocation is a usage error");
  assert.match(r.err, /unknown argument|--profile is required/, "it must say what was wrong");
  assert.ok(existsSync(ledger), "the refusal must leave a ledger row");
  assert.match(readFileSync(ledger, "utf8"), /"verdict":"usage"/);
});

guarded("importing the guard as a library stays silent; importing it WITH arguments refuses", () => {
  const dir = join(FIXTURE_ROOT, "namecheck2");
  mkdirSync(dir, { recursive: true });
  const importer = join(dir, "importer.mjs");
  const guardUrl = pathToFileURL(join(ROOT, "tools", "profile-guard.mjs")).href;
  writeFileSync(importer, `import { freezeDeclaration } from ${JSON.stringify(guardUrl)};\nconsole.log("typed=" + typeof freezeDeclaration);\n`);
  // library use: no arguments of its own -> silent, and the import works
  const plain = runNodeToFile([importer]);
  assert.strictEqual(plain.status, 0, plain.err);
  assert.match(plain.out, /typed=function/);
  // the same import, but the caller passed CLI arguments: someone tried to RUN this file by a name
  // that is not its own, so exiting 0 would be the false PASS again
  const withArgs = runNodeToFile([importer, "--profile", "web"]);
  assert.strictEqual(withArgs.status, EXIT_USAGE, withArgs.out);
  assert.match(withArgs.err, /is not this file/);
});

guarded("summary", () => {
  assert.strictEqual(failures, 0, `${failures} profile-guard case(s) failed`);
});

/**
 * Run a shell command the way the guard does, so the tar step in the test is the real thing.
 *
 * stdio goes to a FILE: a confined process may not hand a child a pipe, and the piped version of
 * this helper failed with `spawnSync cmd.exe EPERM` -- the same boundary that once made a probe
 * report "no host" and that D-39 needed the file-stdio fix for.
 */
function execFileSync2(command) {
  const log = join(FIXTURE_ROOT, `shell-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  let fd = null;
  try {
    fd = openSync(log, "w");
    const r = spawnSync(command, [], { shell: true, windowsHide: true, detached: false, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    fd = null;
    return { status: r.status, text: existsSync(log) ? readFileSync(log, "utf8") : "", error: r.error ? String(r.error.message) : null };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { rmSync(log, { force: true }); } catch { /* ignore */ }
  }
}
