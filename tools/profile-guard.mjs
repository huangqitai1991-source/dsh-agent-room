#!/usr/bin/env node
/**
 * dsh-agent-room -- PROFILE GUARD: refuse to start a host whose profile cannot resolve.
 *
 * THE OUTAGE THIS EXISTS FOR (2026-09-15, D-46)
 *   An upgrade installs plugin bundles into a profile. On Windows, pnpm creates symlinks and needs
 *   SeCreateSymbolicLinkPrivilege: without it (no Developer Mode, not an elevated shell) it fails
 *   with `[ERR_PNPM_EPERM] [symlinkAllModules]` AFTER removing the old entries ("Packages: +2 -2").
 *   The profile is then half-installed, `dsh web` dies at boot with
 *   `cannot resolve profile bundle "dsh-agent-org"`, and the machine goes silent: no port, no room
 *   connection, nothing to alert on. Two nodes stayed invisible for five hours that way, and the
 *   machine was at home where nobody could go and repair it.
 *
 *   The upgrade script already PRINTED a warning when the version looked wrong, and restarted the
 *   host anyway. A warning is not a gate.
 *
 * WHAT "RESOLVES" MEANS HERE
 *   The judgement is not a reimplementation of the resolver -- it IS the resolver: this tool runs
 *   `dsh --profile <name> --dump-config`, which composes the profile and exits. Measured:
 *     - a profile declaring an unresolvable bundle -> exit 1 with the same
 *       `cannot resolve profile bundle "<pkg>" from the dsh installation or <dir>` the boot throws;
 *     - a resolvable profile -> exit 0.
 *   `--dump-config` never starts or stops a service. It DOES rewrite the profile's `cordis.yml`
 *   while composing, so this tool is not strictly read-only: run it where that file is writable.
 *
 * REPAIR (only with --repair)
 *   1. `dsh plugin --profile <name> install`   (what the error message itself prescribes);
 *   2. still missing -> extract each `file:` tarball the profile declares straight into
 *      node_modules with `tar` (no package manager, no symlink privilege) and copy any child
 *      dependency the pnpm store already holds (e.g. `ws`).
 *   Nothing is downloaded from the network by this step: it uses the tarballs the profile already
 *   points at. A tarball that is missing is reported, never invented.
 *
 * EXIT CODES (a caller must be able to refuse)
 *   0   the profile resolves (nothing was needed)
 *   10  the profile did NOT resolve, was repaired, and now resolves
 *   11  the profile still does not resolve  -> the caller must NOT start the host
 *   2   usage/environment error (no dsh, unusable profile dir)
 *
 * usage: node profile-guard.mjs --profile web [--repair] [--ledger <file>] [--json]
 *                               [--dsh-home <dir>] [--timeout-ms <n>] [--quiet]
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, lstatSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

export const EXIT_OK = 0;
export const EXIT_REPAIRED = 10;
export const EXIT_STILL_BROKEN = 11;
export const EXIT_USAGE = 2;
export const DEFAULT_TIMEOUT_MS = 180000;

const MISSING_BUNDLE = /cannot resolve profile bundle\s+"([^"]+)"/;

function shellOut(command, { timeoutMs = DEFAULT_TIMEOUT_MS, env = null } = {}) {
  // Output goes to a FILE, never a pipe: a confined process may not hand a child a pipe (that
  // boundary turned `spawnSync powershell` into EPERM and once made a probe report "no host").
  const log = join(tmpdir(), `profile-guard-${process.pid}-${Math.random().toString(16).slice(2)}.log`);
  let fd = null;
  try {
    fd = openSync(log, "w");
    const r = spawnSync(command, [], { shell: true, windowsHide: true, detached: false, timeout: timeoutMs, stdio: ["ignore", fd, fd], env: env ?? process.env });
    closeSync(fd);
    fd = null;
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    return { status: r.status, error: r.error ? String(r.error.message) : null, text };
  } catch (e) {
    return { status: null, error: String(e && e.message ? e.message : e), text: "" };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { rmSync(log, { force: true }); } catch { /* ignore */ }
  }
}

/** Ask the real resolver. Returns {resolves, missing[], errorLine, status}. */
export function checkProfile({ profile, dshHome = null, timeoutMs = DEFAULT_TIMEOUT_MS, run = shellOut } = {}) {
  // DSH_HOME MUST reach the child: without it `dsh` reads the default home, cannot find the profile
  // under test, and a perfectly good profile is reported as broken (measured: the "empty but valid"
  // fixture was reported `still-broken`, exit 11, because the child looked in the wrong home).
  const env = dshHome ? { ...process.env, DSH_HOME: dshHome } : process.env;
  const r = run(`dsh --profile ${profile} --dump-config`, { timeoutMs, env });
  const text = r.text ?? "";
  const missing = [...text.matchAll(new RegExp(MISSING_BUNDLE.source, "g"))].map((m) => m[1]);
  if (r.status === 0) return { resolves: true, missing: [], status: 0, errorLine: null, raw: text };
  if (missing.length > 0) {
    return { resolves: false, missing: [...new Set(missing)], status: r.status, errorLine: null, raw: text };
  }
  const line = text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== ""
      && !/^at |^Node\.js v|^\+|^~+|CategoryInfo|FullyQualifiedErrorId|^node\.exe :|^\^/.test(l))
    .slice(-3).join(" | ");
  return {
    resolves: false, missing: [], status: r.status,
    errorLine: r.error ?? (line || `dsh --profile ${profile} --dump-config exited ${r.status} with no output`),
    raw: text,
  };
}

/** The tarballs the profile declares, and whether each is present. */
export function declaredTarballs(profileDir) {
  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) return [];
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")); } catch { return []; }
  const deps = manifest.dependencies ?? {};
  const out = [];
  for (const name of Object.keys(deps)) {
    const spec = String(deps[name] ?? "");
    if (!spec.startsWith("file:")) continue;
    const tarball = spec.slice(5).replace(/\//g, process.platform === "win32" ? "\\" : "/");
    out.push({
      name, tarball, present: existsSync(tarball),
      installed: existsSync(join(profileDir, "node_modules", name, "package.json")),
    });
  }
  return out;
}

/** Extract a declared tarball straight into node_modules/<name> (no package manager, no symlinks). */
function extractTarball(profileDir, dep, run = shellOut) {
  const dest = join(profileDir, "node_modules", dep.name);
  try { rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(dest, { recursive: true });
  const r = run(`tar -xzf "${dep.tarball}" --strip-components=1 -C "${dest}"`, { timeoutMs: 120000 });
  const ok = r.status === 0 && existsSync(join(dest, "package.json"));
  return { ok, status: r.status, dest, text: (r.text ?? "").slice(-400) };
}

/** Copy a dependency the pnpm store already holds (dsh-agent-room needs `ws`). */
function copyFromStore(profileDir, childName) {
  const target = join(profileDir, "node_modules", childName);
  if (existsSync(target)) return { ok: true, copied: false };
  const store = join(profileDir, "node_modules", ".pnpm");
  if (!existsSync(store)) return { ok: false, copied: false, reason: "no .pnpm store" };
  const cand = readdirSync(store).filter((d) => d.startsWith(`${childName}@`)).sort().pop();
  if (!cand) return { ok: false, copied: false, reason: `nothing matching ${childName}@* in .pnpm` };
  const src = join(store, cand, "node_modules", childName);
  if (!existsSync(src)) return { ok: false, copied: false, reason: `${src} does not exist` };
  try {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(src)) {
      // a shallow copy is enough for a leaf dependency; links inside would need the privilege we lack
      const from = join(src, entry);
      const to = join(target, entry);
      if (lstatSync(from).isDirectory()) continue;
      writeFileSync(to, readFileSync(from));
    }
    for (const sub of readdirSync(src).filter((e) => lstatSync(join(src, e)).isDirectory())) {
      const from = join(src, sub);
      const to = join(target, sub);
      mkdirSync(to, { recursive: true });
      for (const f of readdirSync(from)) {
        const p = join(from, f);
        if (statSync(p).isFile()) writeFileSync(join(to, f), readFileSync(p));
      }
    }
    return { ok: existsSync(join(target, "package.json")), copied: true };
  } catch (e) {
    return { ok: false, copied: false, reason: String(e && e.message ? e.message : e) };
  }
}

const USAGE = [
  "usage: node profile-guard.mjs --profile <name> [options]",
  "  --profile <name>     the profile under $DSH_HOME/profiles (required)",
  "  --dsh-home <dir>     default: $DSH_HOME or ~/.dsh",
  "  --repair             try to repair when the profile does not resolve",
  "  --ledger <file>      append one JSON line per run (default: <dsh-home>/profile-guard.jsonl)",
  "  --timeout-ms <n>     per command (default 180000)",
  "  --json --quiet --help",
  "exit: 0 resolves | 10 repaired and resolves | 11 still broken (do NOT start the host) | 2 usage",
].join("\n");

export function parseArgv(argv) {
  const out = { profile: null, dshHome: null, repair: false, ledger: null, timeoutMs: DEFAULT_TIMEOUT_MS, json: false, quiet: false };
  const takes = new Set(["--profile", "--dsh-home", "--ledger", "--timeout-ms"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--repair") { out.repair = true; continue; }
    if (a === "--json") { out.json = true; continue; }
    if (a === "--quiet") { out.quiet = true; continue; }
    if (takes.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      i += 1;
      out[{ "--profile": "profile", "--dsh-home": "dshHome", "--ledger": "ledger", "--timeout-ms": "timeoutMs" }[a]] = v;
      continue;
    }
    return { error: `unknown argument: ${a}` };
  }
  if (out.timeoutMs !== null) {
    const n = Number(out.timeoutMs);
    if (!Number.isInteger(n) || n <= 0) return { error: `--timeout-ms must be a positive integer, got ${out.timeoutMs}` };
    out.timeoutMs = n;
  }
  return out;
}

export function runProfileGuard(argv = [], io = console, { run = shellOut, now = () => new Date() } = {}) {
  const args = parseArgv(argv);
  if (args.error) { io.error(`profile-guard: ${args.error}`); io.error(USAGE); return { exit: EXIT_USAGE, result: { error: args.error } }; }
  if (args.help) { io.log(USAGE); return { exit: EXIT_OK, result: { help: true } }; }
  if (!args.profile) { io.error("profile-guard: --profile is required"); io.error(USAGE); return { exit: EXIT_USAGE, result: { error: "no --profile" } }; }

  const dshHome = args.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profileDir = join(dshHome, "profiles", args.profile);
  const ledger = args.ledger ?? join(dshHome, "profile-guard.jsonl");
  const stamp = now().toISOString();

  if (!existsSync(profileDir)) {
    const error = `there is no profile directory at ${profileDir}`;
    io.error(`profile-guard: ${error}`);
    return { exit: EXIT_USAGE, result: { error } };
  }
  const childEnv = { ...process.env, DSH_HOME: dshHome };
  const before = checkProfile({ profile: args.profile, dshHome, timeoutMs: args.timeoutMs, run });
  if (before.resolves) {
    io.log(`profile-guard: ${args.profile} RESOLVES (dsh --profile ${args.profile} --dump-config exit 0) -- safe to start the host`);
    record(ledger, stamp, { profile: args.profile, profileDir, verdict: "ok", actions: [], missingBefore: [], missingAfter: [] });
    return { exit: EXIT_OK, result: { verdict: "ok", profileDir, missing: [] } };
  }

  const declared = declaredTarballs(profileDir);
  io.error(`profile-guard: ${args.profile} DOES NOT RESOLVE -- missing bundles: ${before.missing.length > 0 ? before.missing.join(", ") : "(see the error below)"}`);
  if (before.errorLine) io.error(`profile-guard:   resolver said: ${before.errorLine}`);
  for (const d of declared) {
    io.error(`profile-guard:   declared ${d.name} -> ${d.tarball} (tarball present=${d.present}, installed=${d.installed})`);
  }

  const actions = [];
  if (!args.repair) {
    record(ledger, stamp, { profile: args.profile, profileDir, verdict: "still-broken", actions: ["no --repair was given"], missingBefore: before.missing, missingAfter: before.missing });
    io.error(`profile-guard: refusing to guess -- re-run with --repair to install/extract, or fix ${profileDir} by hand. THE HOST MUST NOT BE STARTED`);
    return { exit: EXIT_STILL_BROKEN, result: { verdict: "still-broken", profileDir, missing: before.missing, repairSkipped: true } };
  }

  // repair 1: whatever the project's own installer can do
  io.log(`profile-guard: repair step 1 -> dsh plugin --profile ${args.profile} install`);
  const install = run(`dsh plugin --profile ${args.profile} install`, { timeoutMs: args.timeoutMs, env: childEnv });
  actions.push({ step: "dsh plugin install", status: install.status, tail: (install.text ?? "").split(/\r?\n/).filter(Boolean).slice(-3).join(" | ").slice(0, 300) });
  let after = checkProfile({ profile: args.profile, dshHome, timeoutMs: args.timeoutMs, run });

  // repair 2: no package manager, no symlink privilege -- extract the tarballs the profile declares
  if (!after.resolves && after.missing.length > 0) {
    for (const name of after.missing) {
      const dep = declared.find((d) => d.name === name);
      if (!dep) { actions.push({ step: "tar extract", name, ok: false, reason: "the profile declares no file: tarball for this bundle" }); continue; }
      if (!dep.present) { actions.push({ step: "tar extract", name, ok: false, reason: `tarball ${dep.tarball} is missing` }); continue; }
      const ex = extractTarball(profileDir, dep, (cmd, o) => run(cmd, { ...o, env: childEnv }));
      actions.push({ step: "tar extract", name, tarball: dep.tarball, ok: ex.ok, status: ex.status });
      io.log(`profile-guard: repair step 2 -> tar -xzf ${dep.tarball} --strip-components=1 -C node_modules/${name} => ${ex.ok ? "ok" : `FAILED (${ex.status})`}`);
    }
    const wsCopy = copyFromStore(profileDir, "ws");
    actions.push({ step: "copy child dep ws from .pnpm", ok: wsCopy.ok, copied: wsCopy.copied, reason: wsCopy.reason ?? null });
    after = checkProfile({ profile: args.profile, dshHome, timeoutMs: args.timeoutMs, run });
  }

  if (after.resolves) {
    io.log(`profile-guard: ${args.profile} REPAIRED and now resolves -- safe to start the host`);
    record(ledger, stamp, { profile: args.profile, profileDir, verdict: "repaired", actions, missingBefore: before.missing, missingAfter: [] });
    return { exit: EXIT_REPAIRED, result: { verdict: "repaired", profileDir, actions } };
  }
  io.error(`profile-guard: ${args.profile} STILL does not resolve after repair` +
    (after.missing.length > 0 ? ` -- still missing: ${after.missing.join(", ")}` : "") +
    (after.errorLine ? ` (${after.errorLine})` : "") + ". THE HOST MUST NOT BE STARTED: it would die at boot and the machine would go silent");
  record(ledger, stamp, { profile: args.profile, profileDir, verdict: "still-broken", actions, missingBefore: before.missing, missingAfter: after.missing, errorLine: after.errorLine ?? null });
  return { exit: EXIT_STILL_BROKEN, result: { verdict: "still-broken", profileDir, actions, missing: after.missing, errorLine: after.errorLine ?? null } };
}

function record(ledgerPath, ts, body) {
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, JSON.stringify({ ts, tool: "profile-guard", ...body }) + "\n", "utf8");
  } catch { /* a ledger that cannot be written must not change the verdict */ }
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return entry.endsWith("profile-guard.mjs"); } catch { return false; }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const io = {
    log: (s) => process.stdout.write(String(s) + "\n"),
    error: (s) => process.stderr.write(String(s) + "\n"),
  };
  const { exit, result } = runProfileGuard(argv, io);
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = exit;   // not process.exit(): an abrupt exit while handles close can crash (0xC0000409)
}
