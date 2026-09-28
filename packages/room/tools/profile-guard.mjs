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
 *   10  the profile did NOT resolve, was repaired, and now resolves (verified)
 *   11  the profile still does not resolve  -> the caller must NOT start the host
 *   3   INDETERMINATE: no verdict could be reached even though nothing provably
 *       was missing (the judgement child never ran, a write probe failed, or the
 *       failure was not fully explained by a missing bundle)  -> refuse, and
 *       CHANGE NOTHING: measured (C2'), acting on an inconclusive premise let
 *       `dsh plugin install` rewrite the profile's own bundles declaration and
 *       drop `dsh-dream-skin` from it while still reporting "missing: []".
 *   12  repaired but not verifiable: the repair was legitimate (a declared
 *       bundle was provably absent AND the failure was fully explained by it),
 *       yet the post-repair judgement could not run -> refuse without a human,
 *       but the operator can see that a repair did happen.
 *   2   usage/environment error (no dsh, unusable profile dir)
 *
 * The rule that separates 3 from 12 is about EVIDENCE, not about how bad the
 * failure looks: `missing` alone never authorises a change. A failure whose
 * reason is only partly explained by a missing bundle is inconclusive, because
 * the unexplained part is exactly where the harmful rewrite came from.
 *
 * usage: node profile-guard.mjs --profile web [--repair] [--ledger <file>] [--json]
 *                               [--dsh-home <dir>] [--timeout-ms <n>] [--quiet]
 */

import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, appendFileSync, lstatSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_INDETERMINATE = 3;
export const EXIT_REPAIRED = 10;
export const EXIT_STILL_BROKEN = 11;
export const EXIT_REPAIRED_UNVERIFIED = 12;
export const DEFAULT_TIMEOUT_MS = 180000;
// The judgement and the repair are different operations and must not share one
// deadline: measured (C3), passing `--timeout-ms 1` to kill the judgement also
// killed `dsh plugin install` before it ever started (`status:null`, empty tail),
// which made a damage case look harmless.
export const DEFAULT_REPAIR_TIMEOUT_MS = 600000;

const MISSING_BUNDLE = /cannot resolve profile bundle\s+"([^"]+)"/;

/**
 * Error signatures that are NOT the missing-bundle marker: they are evidence of a SECOND cause.
 *
 * This distinction is the whole basis for allowing a repair, so it has to be about error
 * signatures and not about "the child printed something else": measured (C5), treating ANY other
 * output text as an unexplained failure made `missing-explained` unreachable -- a resolver that
 * reports the missing bundle plus any progress line never qualified, so the repair step (and with
 * it `declaration-lost`) became dead code and the gate silently stopped repairing anything.
 *
 * The list is deliberately limited to FILESYSTEM-level failures. Generic markers such as
 * `Error:`, `throw new Error(...)` or `SyntaxError` also occur in ordinary resolver output --
 * including source excerpts printed beside a perfectly explained missing-bundle failure -- and
 * matching those kept the same branch unreachable through a different door.
 *
 * Loosening this does not reopen the silent-damage case: a repair that drops a declared bundle is
 * caught by the declaration snapshot and reported as `declaration-lost`.
 */
const OTHER_ERROR = /(EPERM|EACCES|ENOENT|ELOOP|ENOTDIR|EBUSY|EIO|ENOSPC|access is denied|operation not permitted|not a symlink|syscall:)/;

/** First line that shows a cause other than the missing bundles, or null when there is none. */
function otherErrorLine(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim());
  for (const line of lines) {
    // Loose marker test on purpose: the resolver also prints the SOURCE line of the throw, i.e.
    // `throw new Error(`${binName}: cannot resolve profile bundle ${JSON.stringify(pkg)}`)`, and
    // that line carries no quoted package name, so the strict MISSING_BUNDLE pattern does not
    // recognise it (measured, C5: it was then classified as a second cause and every repair was
    // refused).
    if (line === "" || /cannot resolve profile bundle/.test(line)) continue;
    if (OTHER_ERROR.test(line)) return line;
  }
  return null;
}

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
  if (r.status === 0) return { resolves: true, state: "ok", missing: [], status: 0, errorLine: null, raw: text };
  const unique = [...new Set(missing)];
  const line = text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== ""
      && !/^at |^Node\.js v|^\+|^~+|CategoryInfo|FullyQualifiedErrorId|^node\.exe :|^\^/.test(l))
    .slice(-3).join(" | ");
  // The reason is kept EVEN WHEN a missing bundle was parsed. This branch used to
  // return `errorLine: null` whenever it found one, which both hid the evidence and
  // authorised a change: measured (C2'), the discarded reason was an EPERM on
  // cordis.yml, the caller read "missing" as a verdict it could act on, ran
  // `dsh plugin install`, and the installer rewrote dsh.profile.bundles (9 -> 8)
  // while the run still ended 11 with `missing: []`.
  //
  // `state` says whether the missing bundles account for the WHOLE failure, and only then may a
  // repair run. The test is "is there an error signature that is not the marker", NOT "is there
  // other text": a resolver printing the marker plus routine output is an EXPLAINED failure
  // (measured, C5: the stricter test made this branch unreachable and disabled every repair).
  const other = r.error ?? otherErrorLine(text);
  if (unique.length > 0) {
    return {
      resolves: false,
      state: other === null ? "missing-explained" : "missing-unexplained",
      missing: unique,
      status: r.status,
      errorLine: other,
      raw: text,
    };
  }
  return {
    resolves: false, state: "undecided", missing: [], status: r.status,
    errorLine: other ?? (line || `dsh --profile ${profile} --dump-config exited ${r.status} with no output`),
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

/**
 * Can this context write what the judgement actually rewrites?
 *
 * TWO probes, because one is not enough: the directory must be writable for the profile to be
 * composed at all, and `cordis.yml` specifically must be writable because composing REWRITES it.
 *
 * Measured (C2'): with the directory writable and only cordis.yml denied, the directory probe
 * passed, the failure was accepted as "a bundle is missing and that explains it", the repair ran,
 * and `dsh plugin install` rewrote dsh.profile.bundles (9 -> 8). The directory probe alone cannot
 * tell that context apart from a healthy one (C5) -- which is exactly why this file-level probe
 * exists, and why "零变更" was lost on a version that only probed the directory.
 */
export function probeWritable(profileDir) {
  const target = join(profileDir, `.profile-guard-write-probe-${process.pid}`);
  try {
    writeFileSync(target, "probe");
    rmSync(target, { force: true });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    return { ok: false, kind: "directory", reason: `the profile directory is not writable: ${message}` };
  }
  const cordis = join(profileDir, "cordis.yml");
  if (existsSync(cordis)) {
    let fd = null;
    try {
      // `r+` requires write access and changes nothing: a writability test, not a write.
      fd = openSync(cordis, "r+");
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      return { ok: false, kind: "cordis", reason: `cordis.yml is not writable, and the judgement rewrites it: ${message}` };
    } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    }
  }
  return { ok: true, kind: null, reason: null };
}

/**
 * Identity of the profile's own declaration -- the file a repair may rewrite
 * behind our back. Captured before any mutation so a change can be reported
 * instead of discovered later (measured: `dsh plugin install` rewrote
 * dsh.profile.bundles and dropped a bundle while the run recorded no action).
 */
export function declarationSnapshot(profileDir) {
  const file = join(profileDir, "package.json");
  try {
    const bytes = readFileSync(file);
    let bundles = [];
    try {
      bundles = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")).dsh?.profile?.bundles ?? [];
    } catch {
      bundles = [];
    }
    return { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bundles };
  } catch (error) {
    return { file, bytes: null, sha256: null, bundles: [], error: String(error && error.message ? error.message : error) };
  }
}

/** Bundles declared in the profile but absent from node_modules, read from disk only. */
function declaredMissing(profileDir) {
  return declaredTarballs(profileDir).filter((d) => !d.installed).map((d) => d.name);
}

/** Bundles that were declared before a mutation and are no longer declared. */
function declarationLoss(beforeSnap, afterSnap) {
  const kept = new Set(afterSnap.bundles ?? []);
  return (beforeSnap.bundles ?? []).filter((name) => !kept.has(name));
}

/**
 * A status number is only readable once its FAMILY is known, and a name is only attached when that
 * exact value has been measured. Measured samples: `3221225781` = `0xC0000135` = NTSTATUS
 * `STATUS_DLL_NOT_FOUND` ("the command could not start", one machine) and `4294963248` =
 * `0xFFFFF030` = signed `-4048` = libuv `EPERM` (another machine) -- the same decimal width, two
 * different families. Anything not measured stays `unrecognized`: an invented name is worse than
 * no name.
 */
const KNOWN_STATUS_NAMES = new Map([
  [0xc0000135, "STATUS_DLL_NOT_FOUND"],
  [-4048, "EPERM (libuv)"],
]);

export function describeStatus(status) {
  if (typeof status !== "number" || !Number.isFinite(status)) {
    return { hex: null, signed: null, name: null, family: null };
  }
  const unsigned = status < 0 ? status + 0x100000000 : status;
  const signed = status > 0x7fffffff ? status - 0x100000000 : status;
  let family = "unrecognized";
  if (signed < 0 && signed >= -4096) family = "libuv-errno";
  else if (unsigned >= 0xc0000000 && unsigned <= 0xc0000fff) family = "ntstatus";
  const name = KNOWN_STATUS_NAMES.get(signed) ?? KNOWN_STATUS_NAMES.get(unsigned) ?? null;
  return { hex: `0x${unsigned.toString(16).toUpperCase().padStart(8, "0")}`, signed, name, family };
}

/**
 * Freeze the declaration files a repair is able to rewrite, so THIS run can undo a change (D-49c).
 *
 * Measured: `dsh plugin install` can drop an entry from `dsh.profile.bundles` while the repair
 * itself fails (the missing bundle stays missing). Reporting that afterwards is not the same as
 * being able to put it back, and the machine that lost the entry is the one that then boots wrong.
 */
export function freezeDeclaration(profileDir) {
  // Which FILES a repair can rewrite depends on the package manager the profile was installed with:
  // pnpm writes `pnpm-lock.yaml`, npm writes `package-lock.json`. Freezing only the pnpm one meant an
  // npm-type profile (measured: one machine's profile holds `package-lock.json`, 2,152 B) was restored
  // without its lockfile -- the declaration came back but the lock that describes it did not. A name
  // that is not there is simply frozen as `present:false` below, so listing both costs nothing.
  // (Reported by 小婷, D-49h window W-D49h-1; deliberately NOT guessable further: yarn/bun lockfiles
  // are not listed because no measured profile in this fleet uses them.)
  const names = ["package.json", "pnpm-lock.yaml", "package-lock.json"];
  const dir = mkdtempSync(join(tmpdir(), "profile-guard-frozen-"));
  const files = names.map((name) => {
    const from = join(profileDir, name);
    const to = join(dir, name);
    try {
      copyFileSync(from, to);
      return {
        name,
        from,
        to,
        present: true,
        sha256: createHash("sha256").update(readFileSync(to)).digest("hex"),
      };
    } catch {
      return { name, from, to, present: false, sha256: null };
    }
  });
  // The transaction lock is not declaration state, but a repair can CREATE it or MODIFY it in place.
  // It is frozen like a file -- `cpSync` handles both a plain file and a directory, so the pre-state
  // is captured either way and a rollback can restore it OR remove it (measured: a lock left behind
  // is one of the residue classes the acceptance device checks, and "restore the previous state"
  // includes deleting what was not there).
  const locks = ["lock", "lock.d"].map((name) => {
    const from = join(profileDir, name);
    const to = join(dir, name);
    if (!existsSync(from)) return { name, from, to, present: false, kind: null };
    try {
      cpSync(from, to, { recursive: true });
      return { name, from, to, present: true, kind: lstatSync(from).isDirectory() ? "dir" : "file" };
    } catch (error) {
      return { name, from, to, present: false, kind: null, error: String(error && error.message ? error.message : error) };
    }
  });
  return { dir, profileDir, files, locks };
}

/** Put the frozen copies back over the live ones, and remove lock residue the repair created. */
export function restoreDeclaration(frozen) {
  const files = [];
  for (const file of frozen.files) {
    if (!file.present) {
      // NOT a failure. The declaration list now names lockfiles that a given profile may legitimately
      // not have (an npm-type machine has `package-lock.json`; a pnpm one has `pnpm-lock.yaml`), and a
      // "there was no frozen copy" entry with ok:false would score the whole restore as incomplete --
      // turning a SUCCESSFUL rollback into `declaration-lost` for a file that never existed.
      //   - still absent  -> nothing to undo
      //   - now present   -> the repair created it, so restoring the pre-state means removing it
      if (!existsSync(file.from)) {
        files.push({ name: file.name, ok: true, action: "absent-before-and-after" });
        continue;
      }
      try {
        rmSync(file.from, { force: true });
        files.push({ name: file.name, ok: true, action: "removed (the repair created it)" });
      } catch (error) {
        files.push({ name: file.name, ok: false, reason: `the repair created it and it could not be removed: ${String(error && error.message ? error.message : error)}` });
      }
      continue;
    }
    try {
      copyFileSync(file.to, file.from);
      files.push({ name: file.name, ok: true, sha256: file.sha256 });
    } catch (error) {
      files.push({ name: file.name, ok: false, reason: String(error && error.message ? error.message : error) });
    }
  }
  const lockResidue = [];
  for (const lock of frozen.locks ?? []) {
    if (lock.present) {
      // A repair may have modified the lock in place, so put the frozen bytes/tree back.
      try {
        rmSync(lock.from, { recursive: true, force: true });
        cpSync(lock.to, lock.from, { recursive: true });
        lockResidue.push({ path: lock.from, action: "restored", kind: lock.kind });
      } catch (error) {
        lockResidue.push({ path: lock.from, action: "restore-failed", reason: String(error && error.message ? error.message : error) });
      }
      continue;
    }
    if (!existsSync(lock.from)) continue;
    try {
      rmSync(lock.from, { recursive: true, force: true });
      lockResidue.push({ path: lock.from, action: "removed", kind: null });
    } catch (error) {
      lockResidue.push({ path: lock.from, action: "remove-failed", reason: String(error && error.message ? error.message : error) });
    }
  }
  return { files, lockResidue };
}

/** One repair action, always carrying WHY it failed -- never a bare status. */
function actionRecord(step, result, timeoutMs, extra = {}) {
  const described = describeStatus(result?.status ?? null);
  return {
    step,
    status: result?.status ?? null,
    statusHex: described.hex,
    statusSigned: described.signed,
    statusName: described.name,
    statusFamily: described.family,
    error: result?.error ?? null,
    timeoutMs,
    tail: (result?.text ?? "").split(/\r?\n/).filter(Boolean).slice(-3).join(" | ").slice(0, 300),
    ...extra,
  };
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
  "  --read-only          judge and report to stdout WITHOUT writing anything",
  "                       (no probe file, no ledger, and never a repair) -- for",
  "                       verification entry points whose contract forbids writes",
  "  --ledger <file>      append one JSON line per run (default: <dsh-home>/profile-guard.jsonl)",
  "  --timeout-ms <n>     the judgement only (default 180000)",
  "  --repair-timeout-ms <n>  the repair steps only (default 600000)",
  "  --json --quiet --help",
  "exit: 0 resolves | 10 repaired and verified | 11 still broken (do NOT start the host)",
  "    | 3 indeterminate (refuse, change nothing) | 12 repaired but unverifiable | 2 usage",
].join("\n");

/**
 * The CLI's own flags, in ONE place: `parseArgv` accepts exactly these, and the entry-point guard uses
 * the same set to tell "someone tried to RUN me" from "a module imported me and has arguments of its
 * own". Two hand-kept lists would drift, and a drifted list is how a real invocation stops being
 * recognised (the failure mode this file already had once, by NAME).
 */
const VALUE_FLAGS = new Map([
  ["--profile", "profile"], ["--dsh-home", "dshHome"], ["--ledger", "ledger"],
  ["--timeout-ms", "timeoutMs"], ["--repair-timeout-ms", "repairTimeoutMs"],
]);
const BOOL_FLAGS = ["--repair", "--read-only", "--json", "--quiet", "--help", "-h"];
const GUARD_FLAGS = new Set([...VALUE_FLAGS.keys(), ...BOOL_FLAGS]);

export function parseArgv(argv) {
  const out = { profile: null, dshHome: null, repair: false, readOnly: false, ledger: null, timeoutMs: DEFAULT_TIMEOUT_MS, repairTimeoutMs: DEFAULT_REPAIR_TIMEOUT_MS, json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--repair") { out.repair = true; continue; }
    if (a === "--read-only") { out.readOnly = true; continue; }
    if (a === "--json") { out.json = true; continue; }
    if (a === "--quiet") { out.quiet = true; continue; }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      i += 1;
      out[VALUE_FLAGS.get(a)] = v;
      continue;
    }
    return { error: `unknown argument: ${a}` };
  }
  if (out.timeoutMs !== null) {
    const n = Number(out.timeoutMs);
    if (!Number.isInteger(n) || n <= 0) return { error: `--timeout-ms must be a positive integer, got ${out.timeoutMs}` };
    out.timeoutMs = n;
  }
  if (out.repairTimeoutMs !== null) {
    const n = Number(out.repairTimeoutMs);
    if (!Number.isInteger(n) || n <= 0) return { error: `--repair-timeout-ms must be a positive integer, got ${out.repairTimeoutMs}` };
    out.repairTimeoutMs = n;
  }
  return out;
}

export function runProfileGuard(argv = [], io = console, { run = shellOut, now = () => new Date() } = {}) {
  const args = parseArgv(argv);
  const stamp = now().toISOString();
  const dshHome = args.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  // The ledger path is resolved BEFORE the argument checks so that EVERY exit path leaves a row.
  // Measured (D-49): an exit-2 run wrote no ledger line while the caller still printed a verdict,
  // i.e. a conclusion on one layer with no evidence on the other. `parseArgv` returns no fields at
  // all when it rejects an argument, so an explicitly passed --ledger is read straight from argv:
  // otherwise the usage row lands in the DEFAULT ledger and the caller's ledger stays empty
  // (measured: the first version of this fix did exactly that).
  // --read-only: reach a verdict and write NOTHING (no probe file, no ledger row, no repair).
  // Measured need (D-49b): the upgrade script's -Verify mode promises it "must not write anything
  // at all", so the gate could never be exercised from it -- which made the verification entry
  // point unable to verify the gate. Reading is allowed, changing is not.
  const readOnly = args.readOnly === true;
  const ledger = readOnly ? null : (args.ledger ?? ledgerFromArgv(argv) ?? join(dshHome, "profile-guard.jsonl"));
  if (readOnly) args.repair = false;
  const refuse = (code, verdict, reason) => {
    record(ledger, stamp, {
      profile: args.profile ?? null,
      profileDir: null,
      verdict,
      state: verdict,
      reason,
      status: null,
      errorLine: reason,
      actions: [],
      missingBefore: [],
      missingAfter: [],
    });
    return { exit: code, result: { verdict, error: reason } };
  };
  if (args.error) { io.error(`profile-guard: ${args.error}`); io.error(USAGE); return refuse(EXIT_USAGE, "usage", args.error); }
  if (args.help) { io.log(USAGE); return { exit: EXIT_OK, result: { help: true } }; }
  if (!args.profile) { io.error("profile-guard: --profile is required"); io.error(USAGE); return refuse(EXIT_USAGE, "usage", "no --profile"); }

  const profileDir = join(dshHome, "profiles", args.profile);

  if (!existsSync(profileDir)) {
    const error = `there is no profile directory at ${profileDir}`;
    io.error(`profile-guard: ${error}`);
    record(ledger, stamp, { profile: args.profile, profileDir, verdict: "environment", state: "environment", reason: error, status: null, errorLine: error, actions: [], missingBefore: [], missingAfter: [] });
    return { exit: EXIT_USAGE, result: { verdict: "environment", error } };
  }
  const childEnv = { ...process.env, DSH_HOME: dshHome };
  // `CI=1` turns pnpm's "the modules directory will be removed and reinstalled from scratch"
  // announcement into an ACTUAL purge: measured 1213 files -> 51 files (D-49c). A repair must never
  // run under it, so it is removed from the child's environment instead of merely being documented
  // somewhere a caller has to remember.
  delete childEnv.CI;

  // Gate 0 -- the write probe. A profile this process cannot write cannot be
  // judged (`--dump-config` composes by rewriting cordis.yml), so the probe IS the
  // answer and the judgement is not run at all. Keeping this separate from the
  // "child died" cell is deliberate: they are different evidence.
  // The probe writes a file and opens cordis.yml, so read-only mode skips it: an unwritable
  // profile then reports as undecided, which is still a refusal and still changes nothing.
  const probe = readOnly ? { ok: true, kind: null, reason: null } : probeWritable(profileDir);
  if (!probe.ok) {
    const reason = `this context cannot write ${profileDir}: ${probe.reason} -- the judgement was NOT run`;
    io.error(`profile-guard: ${args.profile} INDETERMINATE -- ${reason}. NOTHING WAS CHANGED`);
    const probeState = probe.kind === "cordis" ? "cordis-not-writable" : "write-probe";
    record(ledger, stamp, { profile: args.profile, profileDir, verdict: "indeterminate", state: probeState, reason: probeState, status: null, errorLine: probe.reason, actions: [], missingBefore: [], missingAfter: [] });
    return { exit: EXIT_INDETERMINATE, result: { verdict: "indeterminate", profileDir, reason: probeState, errorLine: probe.reason } };
  }

  const declarationBefore = declarationSnapshot(profileDir);
  const before = checkProfile({ profile: args.profile, dshHome, timeoutMs: args.timeoutMs, run });
  if (before.resolves) {
    io.log(`profile-guard: ${args.profile} RESOLVES (dsh --profile ${args.profile} --dump-config exit 0) -- safe to start the host`);
    record(ledger, stamp, { profile: args.profile, profileDir, verdict: "ok", state: "ok", status: before.status, errorLine: null, actions: [], missingBefore: [], missingAfter: [] });
    return { exit: EXIT_OK, result: { verdict: "ok", profileDir, missing: [] } };
  }

  const declared = declaredTarballs(profileDir);
  const provable = declaredMissing(profileDir);
  io.error(`profile-guard: ${args.profile} DOES NOT RESOLVE (${before.state}) -- missing bundles: ${before.missing.length > 0 ? before.missing.join(", ") : "(see the error below)"}`);
  if (before.errorLine) io.error(`profile-guard:   resolver said: ${before.errorLine}`);
  for (const d of declared) {
    io.error(`profile-guard:   declared ${d.name} -> ${d.tarball} (tarball present=${d.present}, installed=${d.installed})`);
  }

  // INDETERMINATE: the failure is not fully explained by a missing bundle, so no
  // premise exists that a change could rest on. Measured (C2'): acting here let
  // `dsh plugin install` rewrite the profile's bundles declaration (9 -> 8) and
  // still report `missing: []`. Nothing is touched, and the caller is told why.
  if (before.state !== "missing-explained") {
    // Two different refusals must not share one outcome (D-49b follow-up): a MACHINE-side
    // inconclusive result must block -- the real gate would refuse too -- while an inconclusive
    // result caused by THIS MODE's own limit (read-only skips the write probe, so a judgement that
    // needs to write cannot run) is "not certifiable here", not a defect of the machine.
    // The test is deliberately narrow: only a WRITE-PERMISSION failure counts as this mode's limit.
    // A wider test (any filesystem signature, e.g. `not a symlink`) re-labels genuine machine faults
    // as "the mode's fault", which is the same mislabelling in the opposite direction.
    const READ_ONLY_LIMIT = /(EPERM|EACCES|access is denied|operation not permitted)/;
    const readOnlyLimited = readOnly && typeof before.errorLine === "string" && READ_ONLY_LIMIT.test(before.errorLine);
    const reason = readOnlyLimited ? "read-only-mode-limitation" : "judgement-inconclusive";
    const why = before.state === "missing-unexplained"
      ? "a bundle is missing, but the failure is NOT fully explained by it"
      : (readOnlyLimited
        ? "this read-only mode cannot judge without writing, so the judgement could not run"
        : "the judgement could not be run");
    io.error(`profile-guard: ${args.profile} INDETERMINATE -- ${why}${before.errorLine ? ` (${before.errorLine})` : ""}. NOTHING WAS CHANGED. THE HOST MUST NOT BE STARTED`);
    // `state` is recorded because `verdict` + `reason` are IDENTICAL for the two inconclusive
    // cells (measured: C2 "the judgement could not be run" and C2' "a bundle is missing but it
    // does not explain the failure" were indistinguishable in the ledger, with the difference
    // living only in stderr text). The caller reads the ledger, so the ledger has to carry it.
    record(ledger, stamp, { profile: args.profile, profileDir, verdict: "indeterminate", state: before.state, reason, status: before.status, errorLine: before.errorLine ?? null, actions: [], missingBefore: before.missing, missingAfter: before.missing, provableMissing: provable });
    const result = { verdict: "indeterminate", profileDir, state: before.state, reason, modeLimited: readOnlyLimited, missing: before.missing, errorLine: before.errorLine ?? null, provableMissing: provable };
    // Read-only mode writes no ledger, so the machine-readable verdict has to reach the caller on
    // stdout: the exit code alone cannot say whether the limit was the machine or this mode.
    if (readOnly) {
      io.log(`profile-guard: RESULT ${JSON.stringify({ exit: EXIT_INDETERMINATE, verdict: result.verdict, state: result.state, reason: result.reason, modeLimited: result.modeLimited })}`);
    }
    return { exit: EXIT_INDETERMINATE, result };
  }

  const actions = [];
  // Freeze what a repair may rewrite BEFORE it runs. Read-only runs never freeze: that would write.
  const frozen = args.repair ? freezeDeclaration(profileDir) : null;
  if (frozen) {
    actions.push({
      step: "declaration-freeze",
      dir: frozen.dir,
      files: frozen.files.map((file) => ({ name: file.name, present: file.present, sha256: file.sha256 })),
    });
  }
  if (!args.repair) {
    record(ledger, stamp, { profile: args.profile, profileDir, verdict: "still-broken", state: before.state, status: before.status, errorLine: before.errorLine ?? null, actions: ["no --repair was given"], missingBefore: before.missing, missingAfter: before.missing });
    io.error(`profile-guard: refusing to guess -- re-run with --repair to install/extract, or fix ${profileDir} by hand. THE HOST MUST NOT BE STARTED`);
    return { exit: EXIT_STILL_BROKEN, result: { verdict: "still-broken", profileDir, missing: before.missing, repairSkipped: true } };
  }

  // repair 1: whatever the project's own installer can do -- on its OWN deadline.
  // Sharing the judgement's timeout let a tight judgement kill the repair before
  // it started, which made a harmful case look harmless (measured, C3).
  io.log(`profile-guard: repair step 1 -> dsh plugin --profile ${args.profile} install (timeout ${args.repairTimeoutMs}ms)`);
  const install = run(`dsh plugin --profile ${args.profile} install`, { timeoutMs: args.repairTimeoutMs, env: childEnv });
  actions.push(actionRecord("dsh plugin install", install, args.repairTimeoutMs));
  let after = checkProfile({ profile: args.profile, dshHome, timeoutMs: args.timeoutMs, run });

  // repair 2: no package manager, no symlink privilege -- extract the tarballs the
  // profile declares. Only while the post-repair failure is STILL fully explained
  // by missing bundles; anything else is an inconclusive premise again.
  if (!after.resolves && after.state === "missing-explained" && after.missing.length > 0) {
    for (const name of after.missing) {
      const dep = declared.find((d) => d.name === name);
      if (!dep) { actions.push({ step: "tar extract", name, ok: false, reason: "the profile declares no file: tarball for this bundle" }); continue; }
      if (!dep.present) { actions.push({ step: "tar extract", name, ok: false, reason: `tarball ${dep.tarball} is missing` }); continue; }
      const ex = extractTarball(profileDir, dep, (cmd, o) => run(cmd, { ...o, timeoutMs: args.repairTimeoutMs, env: childEnv }));
      // Through actionRecord, NOT pushed raw: a raw push carried `status` alone, so the successful
      // extraction (status 0) was the one row in the ledger with no `statusHex` / `statusSigned` /
      // `statusFamily` beside it -- and "0" without its family is exactly the kind of bare number this
      // file exists to stop handing out. Reported by 小婷 from a real run (D-49h window W-D49h-1).
      actions.push(actionRecord("tar extract", { status: ex.status, text: ex.text }, args.repairTimeoutMs, {
        name, tarball: dep.tarball, ok: ex.ok,
      }));
      io.log(`profile-guard: repair step 2 -> tar -xzf ${dep.tarball} --strip-components=1 -C node_modules/${name} => ${ex.ok ? "ok" : `FAILED (${ex.status})`}`);
    }
    const wsCopy = copyFromStore(profileDir, "ws");
    actions.push({ step: "copy child dep ws from .pnpm", ok: wsCopy.ok, copied: wsCopy.copied, reason: wsCopy.reason ?? null });
    after = checkProfile({ profile: args.profile, dshHome, timeoutMs: args.timeoutMs, run });
  }

  // The declaration is the file a repair rewrites behind our back. A repair that
  // drops a declared bundle is its own verdict, never a success: that is the shape
  // of the 2026-09-15 regression, and it must never be silent again.
  const declarationAfter = declarationSnapshot(profileDir);
  const lost = declarationLoss(declarationBefore, declarationAfter);
  actions.push({
    step: "declaration",
    changed: declarationBefore.sha256 !== declarationAfter.sha256,
    bytesBefore: declarationBefore.bytes,
    bytesAfter: declarationAfter.bytes,
    sha256Before: declarationBefore.sha256,
    sha256After: declarationAfter.sha256,
    bundlesBefore: declarationBefore.bundles.length,
    bundlesAfter: declarationAfter.bundles.length,
    lost,
  });

  if (lost.length > 0) {
    // Put the declaration back inside this run (D-49c): a repair that drops a bundle and still fails
    // must not leave the machine with a declaration that no longer mentions that bundle.
    const restoreResult = frozen ? restoreDeclaration(frozen) : { files: [], lockResidue: [] };
    const restoredAll = restoreResult.files.length > 0 && restoreResult.files.every((entry) => entry.ok);
    const afterRestore = declarationSnapshot(profileDir);
    actions.push({
      step: "declaration-restore",
      attempted: frozen !== null,
      restored: restoreResult.files,
      lockResidue: restoreResult.lockResidue,
      sha256AfterRestore: afterRestore.sha256,
      bundlesAfterRestore: afterRestore.bundles.length,
    });
    const verdict = restoredAll ? "declaration-restored" : "declaration-lost";
    io.error(`profile-guard: DECLARATION LOST -- ${lost.join(", ")} is no longer declared in ${declarationAfter.file}.` +
      (restoredAll
        ? ` RESTORED from the frozen copy (${afterRestore.bundles.length} bundles again). THE HOST MUST NOT BE STARTED.`
        : " AND the frozen copy could NOT be restored. THE HOST MUST NOT BE STARTED, and the declaration must be restored by hand."));
    // `state` carries the verdict, never `after.state`: the profile may well resolve again after the
    // installer pruned the declaration, and a row reading `state:"ok"` beside a lost declaration
    // tells a reader who trusts `state` that everything is fine.
    record(ledger, stamp, { profile: args.profile, profileDir, verdict, state: verdict, status: after.status, errorLine: after.errorLine ?? null, actions, missingBefore: before.missing, missingAfter: after.missing });
    return { exit: EXIT_STILL_BROKEN, result: { verdict, profileDir, actions, lost, restored: restoredAll } };
  }

  if (after.resolves) {
    io.log(`profile-guard: ${args.profile} REPAIRED and now resolves -- safe to start the host`);
    record(ledger, stamp, { profile: args.profile, profileDir, verdict: "repaired", state: "ok", status: after.status, errorLine: null, actions, missingBefore: before.missing, missingAfter: [] });
    return { exit: EXIT_REPAIRED, result: { verdict: "repaired", profileDir, actions } };
  }

  if (after.state !== "missing-explained") {
    io.error(`profile-guard: REPAIRED BUT UNVERIFIED (${after.state})${after.errorLine ? ` -- ${after.errorLine}` : ""}. A repair ran and the judgement cannot confirm it. THE HOST MUST NOT BE STARTED WITHOUT A HUMAN`);
    record(ledger, stamp, { profile: args.profile, profileDir, verdict: "repaired-unverified", state: after.state, status: after.status, errorLine: after.errorLine ?? null, actions, missingBefore: before.missing, missingAfter: after.missing });
    return { exit: EXIT_REPAIRED_UNVERIFIED, result: { verdict: "repaired-unverified", profileDir, actions, errorLine: after.errorLine ?? null } };
  }

  io.error(`profile-guard: ${args.profile} STILL does not resolve after repair` +
    (after.missing.length > 0 ? ` -- still missing: ${after.missing.join(", ")}` : "") +
    (after.errorLine ? ` (${after.errorLine})` : "") + ". THE HOST MUST NOT BE STARTED: it would die at boot and the machine would go silent");
  record(ledger, stamp, { profile: args.profile, profileDir, verdict: "still-broken", state: after.state, status: after.status, errorLine: after.errorLine ?? null, actions, missingBefore: before.missing, missingAfter: after.missing });
  return { exit: EXIT_STILL_BROKEN, result: { verdict: "still-broken", profileDir, actions, missing: after.missing, errorLine: after.errorLine ?? null } };
}

/** --ledger read straight from argv, usable even when parseArgv rejected another argument. */
function ledgerFromArgv(argv) {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === "--ledger") {
      const value = argv[i + 1];
      if (typeof value === "string" && value !== "" && !value.startsWith("--")) return value;
    }
  }
  return null;
}

function record(ledgerPath, ts, body) {
  // A null ledger means the caller asked for a read-only judgement: report to stdout only.
  if (!ledgerPath) return;
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, JSON.stringify({ ts, tool: "profile-guard", ...body }) + "\n", "utf8");
  } catch { /* a ledger that cannot be written must not change the verdict */ }
}

// Identity, not a name. This used to be `process.argv[1].endsWith("profile-guard.mjs")`, which made
// the FILE NAME the switch deciding whether the gate runs at all. MEASURED on the published bytes
// (D-49f, 2026-09-16): copy the file to `pub-guard-now.mjs` and run it with the very same CLI
// arguments -- `node a\pub-guard-now.mjs --profile web --zzz-not-a-flag` -- and it exits 0 with zero
// characters on stdout, zero on stderr and zero ledger rows, while the correctly named copy exits 2
// and writes a `usage` row. A gate that answers "all good" because of what the file is CALLED is the
// silent-pass class this whole workstream exists to remove; a reviewer who renames a copy to keep it
// out of the way was handing out a false PASS.
const selfPath = fileURLToPath(import.meta.url);
const isSameFile = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
};
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  // realpath, so a symlink to this file IS an invocation of this file.
  return isSameFile(resolve(entry), selfPath);
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
} else if (process.argv.slice(2).some((a) => GUARD_FLAGS.has(a.split("=")[0]))) {
  // Loaded as a module (the unit fixtures import freezeDeclaration/restoreDeclaration) -- but the
  // caller ALSO passed CLI arguments, so someone tried to RUN this file under a name that is not its
  // own. Doing nothing would exit 0: the false PASS above. Refuse loudly, and record it, so the
  // outcome is a usage error with a ledger row instead of a green gate that never ran.
  const argv = process.argv.slice(2);
  const dshHome = (() => {
    const i = argv.indexOf("--dsh-home");
    return i >= 0 && argv[i + 1] ? argv[i + 1] : (process.env.DSH_HOME ?? join(homedir(), ".dsh"));
  })();
  const reason = `${process.argv[1]} is not this file (${selfPath}), so no judgement was made: the gate runs only when it IS the entry point. Run it by its own path.`;
  process.stderr.write(`profile-guard: ${reason}\n`);
  record(ledgerFromArgv(argv) ?? join(dshHome, "profile-guard.jsonl"), new Date().toISOString(), {
    profile: null,
    profileDir: null,
    verdict: "usage",
    state: "usage",
    reason: "not-the-entry-point",
    status: null,
    errorLine: reason,
    actions: [],
    missingBefore: [],
    missingAfter: [],
  });
  process.exitCode = EXIT_USAGE;
}
