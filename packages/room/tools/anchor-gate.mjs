#!/usr/bin/env node
/**
 * dsh-agent-room -- SYMBOL-LEVEL ANCHOR GATE
 *
 * WHAT THIS IS
 *   An anchor gate answers one question: "are the harness symbols our detection logic
 *   depends on still present in the dsh artefacts we actually run?" It does NOT compare
 *   version strings to decide trust. A version number only decides WHETHER to re-check;
 *   the symbols decide WHETHER WE MAY STILL BELIEVE OURSELVES.
 *
 * WHERE IT COMES FROM
 *   Specification by CC (agentId 01a094c1-7159-7555-9222-65241c607320), based on a full
 *   read of boyin111-1/dsh-doctor (`ANCHOR_BASELINE_VERSION` / `ANCHORS[]` /
 *   `checkAnchorBaseline()` / `--verify-anchors`). CC reproduced the algorithm read-only on
 *   macOS with @deepseek-ai/dsh 0.1.1-rc.2 and got 5 OK / 0 MISSING.
 *
 * THE FOUR HARD REQUIREMENTS (all four are covered by test/anchor-gate.test.mjs)
 *   1. Anchor by SOURCE TOKEN, not by version string.
 *   2. `--verify-anchors <dir>` checks THAT DIRECTORY. It never falls back to this machine's
 *      own install -- that fallback is the documented root cause of the "broken copy judged
 *      healthy / code 0" false green.
 *   3. Anchors carry TWO forms: `tokenCompiled` (what npm ships, `lib/*.js`) and
 *      `tokenSource` (what the TS declarations carry, `*.d.ts`). A3 (`readonly callId`)
 *      only ever matches through the source form, so a compiled-only check produces a
 *      FALSE RED. The gate must be right in both directions: no false green, no false red.
 *   4. Fail loud and NAME WHAT BECAME UNTRUSTWORTHY: exit non-zero and print, per missing
 *      anchor, the full `dependsOn` list of conclusions that can no longer be believed.
 *
 * READ-ONLY
 *   Only opendir/lstat/readFile plus PATH discovery. No network, no writes, no service
 *   start/stop, no `import` of the inspected code (text matching only). Safe against a copy,
 *   a worktree or a stopped install. `--readonly-proof` proves it: it snapshots (mtime,size)
 *   over the anchor root before and after the scan and the difference must be empty.
 *
 * EXIT CODES (same contract as the rest of the gate family)
 *   0  every anchor still hits (including "version drifted but all N anchors are still there")
 *   1  at least one anchor is missing  => conclusions are VOID (fail-closed for writers)
 *   2  bad arguments / the explicitly named directory holds no dsh install to check
 *
 * USAGE
 *   node tools/anchor-gate.mjs                              # baseline gate (rescan only on drift)
 *   node tools/anchor-gate.mjs --verify-anchors             # force a full scan of the real install
 *   node tools/anchor-gate.mjs --verify-anchors <dir>       # scan <dir>, NEVER this machine
 *   node tools/anchor-gate.mjs --verify-anchors <dir> --json
 *   node tools/anchor-gate.mjs --baseline 0.1.1-rc.1        # exercise the version-drift branch
 *   node tools/anchor-gate.mjs --verify-anchors <dir> --readonly-proof
 *
 * Never `import`ed by the host plugin: this file is a standalone read-only tool.
 */

import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync } from "node:fs";
import { dirname, join, basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The version whose artefacts the anchor list below was last verified against. CC measured
 * 5/5 alive on 0.1.1-rc.2, and the same five tokens were re-measured alive on the control
 * machine's own 0.1.1-rc.2 install. Every dsh upgrade must re-run the export procedure and
 * update this constant AND the tokens together -- otherwise the gate goes quietly false-green.
 */
export const ANCHOR_BASELINE_VERSION = "0.1.1-rc.2";

/** Package directory names the anchors are allowed to look in (an enumerated whitelist). */
const SEARCH_DOMAINS = {
  session: "dsh-session",
  tools: "dsh-tools",
  boot: "dsh-app-boot",
};

/**
 * The anchor list. Field set is copied from the specification and must not be trimmed.
 *   tokenCompiled / tokenSource : the same semantic in both shipped shapes (both required)
 *   fileCompiled  / fileSource  : FULL-NAME anchored globs ("*.js" === /^.*\.js$/, so
 *                                 `index.d.ts` is matched by `*.ts` and not by `*.js`)
 *   searchDirs                  : domain names from SEARCH_DOMAINS (never a whole-disk scan)
 *   dependsOn                   : everything this anchor exists to support. When the anchor
 *                                 is missing, these are the conclusions that become VOID.
 */
export const ANCHORS = [
  {
    id: "A1",
    name: "tool/call event literal",
    tokenCompiled: "\"tool/call\"",
    tokenSource: "'tool/call'",
    fileCompiled: "*.js",
    fileSource: "*.ts",
    searchDirs: ["session"],
    dependsOn: ["orphan tool_call detection", "session seq integrity"],
  },
  {
    id: "A2",
    name: "tool/result event literal",
    tokenCompiled: "\"tool/result\"",
    tokenSource: "'tool/result'",
    fileCompiled: "*.js",
    fileSource: "*.ts",
    searchDirs: ["session"],
    dependsOn: ["orphan tool_call detection (pairing end point)", "session seq integrity"],
  },
  {
    id: "A3",
    name: "ToolResultMessage carries callId",
    tokenCompiled: "readonly callId",
    tokenSource: "readonly callId: CallId",
    fileCompiled: "*.js",
    fileSource: "*.ts",
    searchDirs: ["tools"],
    dependsOn: ["orphan tool_call detection (the pairing key)"],
  },
  {
    id: "A4",
    name: "bundle double-anchor order, install first",
    tokenCompiled: "[installAnchor, join(profileDir",
    tokenSource: "for (const anchor of [installAnchor",
    fileCompiled: "*.js",
    fileSource: "*.ts",
    searchDirs: ["boot"],
    dependsOn: ["bundles integrity", "bundle<->patch id collision"],
  },
  {
    id: "A5",
    name: "dsh.bundle.patch manifest contract",
    tokenCompiled: "dsh?.bundle?.patch",
    tokenSource: "dsh?.bundle?.patch",
    fileCompiled: "*.js",
    fileSource: "*.ts",
    searchDirs: ["boot"],
    dependsOn: ["bundles integrity (patch contract)"],
  },
];

/** Hits are capped for speed only; the count is never a strength argument. */
const HIT_CAP = 5;
const WALK_MAX_DEPTH = 8;
const WALK_MAX_FILES = 4000;

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const out = {
    verifyAnchors: false,
    verifyDir: null,
    baseline: ANCHOR_BASELINE_VERSION,
    strict: false,
    json: false,
    force: false,
    readonlyProof: false,
    checkUpdate: false,
    scanAlways: false,
    compiledOnly: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--verify-anchors") {
      out.verifyAnchors = true;
      out.scanAlways = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out.verifyDir = resolve(next); i += 1; }
    } else if (a === "--baseline") { out.baseline = String(argv[i + 1] ?? ""); i += 1; }
    else if (a === "--strict") out.strict = true;
    else if (a === "--json") out.json = true;
    else if (a === "--force") out.force = true;
    else if (a === "--readonly-proof") out.readonlyProof = true;
    else if (a === "--check-update") out.checkUpdate = true;
    else if (a === "--scan-always") out.scanAlways = true;
    else if (a === "--compiled-only") out.compiledOnly = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return out;
}

const USAGE = [
  "usage: node tools/anchor-gate.mjs [--verify-anchors [<dir>]] [--baseline <ver>] [--strict]",
  "                                   [--readonly-proof] [--check-update] [--json] [--force]",
  "",
  "  --verify-anchors [dir]  scan that directory and ONLY that directory (no fallback to this",
  "                          machine's install); without a directory, scan the discovered install",
  "  --baseline <ver>        pretend the verified baseline is <ver>, to exercise version drift",
  "  --strict                a version drift alone is also a non-zero exit",
  "  --readonly-proof        snapshot (mtime,size) over the anchor root before and after",
  "  --compiled-only         DIAGNOSTIC ONLY: skip the source fallback, which reproduces the",
  "                          false red on A3 (never use it for a verdict)",
  "  --check-update          T3 intel only; offline by default, never changes the verdict",
  "  --json                  machine-readable result on stdout",
  "exit: 0 anchors intact | 1 anchor missing (conclusions void) | 2 bad args / no install to check",
].join("\n");

/* ------------------------------------------------------- install discovery */

function looksLikeDshPackage(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return pkg && pkg.name === "@deepseek-ai/dsh";
  } catch { return false; }
}

/** The three places a `@deepseek-ai/dsh` package can sit, relative to a directory. */
function dshPackageCandidates(dir) {
  return [
    dir,
    join(dir, "node_modules", "@deepseek-ai", "dsh"),
    join(dir, "lib", "node_modules", "@deepseek-ai", "dsh"),
  ];
}

/**
 * Anchor root = the resolved `@deepseek-ai/dsh` package directory. Every searchDir is
 * resolved from there, so a copy of an install prefix, a copy of `lib/`, or `node_modules/`
 * itself all work.
 */
export function resolveAnchorRoot(dir) {
  for (const candidate of dshPackageCandidates(dir)) {
    if (looksLikeDshPackage(candidate)) return candidate;
  }
  return null;
}

/**
 * PATH-BASED discovery (`command -v dsh` / `where dsh`), never a hard-coded prefix: on macOS
 * CC found `dsh` in ~/.npm-global while `npm prefix -g` answered /usr/local, so any
 * npm-prefix-based lookup finds the wrong tree or nothing at all.
 */
function discoverFromPath(env = process.env) {
  const exts = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const dirs = String(env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const shim = join(d, "dsh" + ext.toLowerCase());
      if (!existsSync(shim)) continue;
      let real = shim;
      try { real = realpathSync(shim); } catch { /* keep the shim path */ }
      // npm shims live in <prefix>/dsh.cmd -> the install is <prefix>/node_modules/@deepseek-ai/dsh
      const fromShim = resolveAnchorRoot(dirname(real));
      if (fromShim) return { root: fromShim, via: "PATH: " + real };
      const fromDir = resolveAnchorRoot(d);
      if (fromDir) return { root: fromDir, via: "PATH: " + real };
    }
  }
  return null;
}

export function discoverInstall({ explicitDir = null, env = process.env } = {}) {
  if (explicitDir) {
    const root = resolveAnchorRoot(explicitDir);
    if (!root) {
      return {
        root: null,
        via: "explicitly given directory",
        explicit: true,
        error: `no @deepseek-ai/dsh package under ${explicitDir} (looked at the directory, ` +
          `<dir>/node_modules/@deepseek-ai/dsh and <dir>/lib/node_modules/@deepseek-ai/dsh)`,
      };
    }
    return { root, via: "explicitly given directory", explicit: true, error: null };
  }
  const found = discoverFromPath(env);
  if (found) return { root: found.root, via: found.via, explicit: false, error: null };
  return { root: null, via: "PATH", explicit: false, error: "no dsh found on PATH" };
}

/** Anchored full-name glob: "*.js" === /^.*\.js$/, so `index.d.ts` is not a `.js` file. */
function globToRegExp(glob) {
  if (glob === "*") return /^.*$/;
  return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
}

/**
 * Resolve one search domain to a real directory plus the base its reported path is relative
 * to. npm hoists (flat: <prefix>/node_modules/@deepseek-ai/<pkg>) and npm nests (inside the
 * dsh package's own node_modules) are both supported; whichever exists first wins.
 */
function resolveSearchDir(root, domain) {
  const pkg = SEARCH_DOMAINS[domain];
  const candidates = [
    join(root, "node_modules", "@deepseek-ai", pkg),
    join(dirname(root), pkg),
  ];
  for (const candidate of candidates) {
    let info;
    try { info = lstatSync(candidate); } catch { continue; }
    if (!info.isDirectory() && !info.isSymbolicLink()) continue;
    let real = candidate;
    if (info.isSymbolicLink()) {
      try { real = realpathSync(candidate); } catch { continue; }
      try { if (!lstatSync(real).isDirectory()) continue; } catch { continue; }
    }
    // Report paths the way CC's measurement did: relative to the directory that holds
    // `node_modules` (so the line reads `node_modules/@deepseek-ai/<pkg>/lib/index.js`).
    const scopeBase = dirname(dirname(dirname(real)));
    return { domain, pkg, dir: real, scopeBase, found: true };
  }
  return { domain, pkg, dir: null, scopeBase: root, found: false };
}

/** Recursive, symlink-skipping, bounded walk (the whitelist is the package, not the disk). */
function collectFiles(dir) {
  const out = [];
  const stack = [{ d: dir, depth: 0 }];
  while (stack.length > 0 && out.length < WALK_MAX_FILES) {
    const { d, depth } = stack.pop();
    if (depth > WALK_MAX_DEPTH) continue;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= WALK_MAX_FILES) break;
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = join(d, e.name);
      if (e.isSymbolicLink()) continue;                 // never follow links: no cycles, no aliases
      if (e.isDirectory()) { stack.push({ d: full, depth: depth + 1 }); continue; }
      if (e.isFile()) out.push(full);
    }
  }
  return out;
}

function firstHit(file, token) {
  try {
    // Bounded read: these are bundle files, not multi-gigabyte logs.
    const text = readFileSync(file, "utf8");
    return text.includes(token);
  } catch { return false; }
}

/** Scan one anchor: compiled form first, then the source form (the A3 requirement). */
export function scanAnchor(anchor, root, { compiledOnly = false } = {}) {
  const misses = [];
  const forms = [
    { mode: "compiled", glob: anchor.fileCompiled, token: anchor.tokenCompiled },
    { mode: "source", glob: anchor.fileSource, token: anchor.tokenSource },
  ];
  const activeForms = compiledOnly ? forms.slice(0, 1) : forms;
  for (const domain of anchor.searchDirs) {
    const where = resolveSearchDir(root, domain);
    if (!where.found) { misses.push(`${domain}: no ${where.pkg} package under the anchor root`); continue; }
    const re = new RegExp(activeForms.map((f) => globToRegExp(f.glob).source).join("|"));
    const files = collectFiles(where.dir).filter((f) => re.test(basename(f)));
    for (const form of activeForms) {
      const formRe = globToRegExp(form.glob);
      let hits = 0;
      for (const file of files) {
        if (!formRe.test(basename(file))) continue;
        if (!firstHit(file, form.token)) continue;
        hits += 1;
        if (hits >= HIT_CAP) break;
      }
      if (hits > 0) {
        return {
          ok: true,
          mode: form.mode,
          domain,
          // Re-derive the reported file: the first matching file in a stable order.
          path: reportPath(where, files.find((f) => formRe.test(basename(f)) && firstHit(f, form.token))),
          hits,
          scannedDomains: anchor.searchDirs,
        };
      }
      misses.push(`${domain}:${form.mode} (${where.pkg}, ${form.glob}, token ${JSON.stringify(form.token)})`);
    }
  }
  return { ok: false, mode: null, domain: null, path: null, hits: 0, misses, scannedDomains: anchor.searchDirs };
}

function reportPath(where, file) {
  if (!file) return null;
  try {
    const rel = relative(where.scopeBase, file).split(sep).join("/");
    return rel.startsWith("..") ? file : rel;
  } catch { return file; }
}

/* --------------------------------------------------------- readonly proof */

/** (mtime,size) snapshot of a tree -- empty difference is the only acceptable result. */
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
      try {
        const st = lstatSync(full);
        map.set(full, `${st.mtimeMs}:${st.size}`);
      } catch { /* ignore */ }
    }
  }
  return map;
}

function diffSnapshots(before, after) {
  const out = [];
  for (const [k, v] of before) if (after.get(k) !== v) out.push(k);
  for (const k of after.keys()) if (!before.has(k)) out.push(k);
  return out;
}

/* ------------------------------------------------------------------- main */

export function runAnchorGate(argv = [], io = console) {
  const args = parseArgs(argv);
  if (args.error) return { exit: 2, error: args.error };
  if (args.help) { io.log(USAGE); return { exit: 0, help: true }; }

  const install = discoverInstall({ explicitDir: args.verifyDir });
  const result = {
    tool: "anchor-gate",
    baseline: args.baseline,
    verifyDir: args.verifyDir,
    version: null,
    versionReadError: null,
    drift: false,
    scanned: false,
    anchorsDecoupled: false,
    compiledOnly: false,
    forced: false,
    readonlyProof: null,
    anchors: [],
    missing: [],
    untrustworthy: [],
    installRoot: install.root,
    installVia: install.via,
    checkUpdate: args.checkUpdate ? "skipped (offline by default; T3 intel never changes the verdict)" : "not requested",
  };

  if (args.checkUpdate) result.checkUpdate = "skipped (offline by default; T3 intel never changes the verdict)";

  // No install at all.
  if (!install.root) {
    if (install.explicit) {
      // THE RED LINE: an explicitly named directory is checked or refused. Never a quiet
      // fallback to this machine's own install -- that is the false-green root cause.
      io.error(`ANCHOR GATE REFUSED: ${install.error}`);
      io.error("  An explicitly given directory is the artefact under test. Falling back to this");
      io.error("  machine's own install would report a broken copy as healthy, so it is refused.");
      return { exit: 2, result, error: install.error };
    }
    io.log(`ANCHOR GATE SKIP: ${install.error} -- with no install there is nothing to check, so`);
    io.log("  this is not a failure (an unknown install must not be reported as a broken one).");
    return { exit: 0, result };
  }

  // Read the installed version (only to decide WHETHER to re-check).
  try {
    const pkg = JSON.parse(readFileSync(join(install.root, "package.json"), "utf8"));
    result.version = pkg.version ?? null;
  } catch (e) {
    result.versionReadError = String(e && e.message ? e.message : e);
  }
  result.drift = result.version !== args.baseline;

  const before = args.readonlyProof ? snapshotTree(install.root) : null;

  // Decision: the version only triggers the re-check; it never by itself voids anything.
  const mustScan = args.scanAlways || result.drift || args.strict || args.verifyAnchors;
  if (!mustScan) {
    io.log(`ANCHOR GATE OK: installed dsh == anchor baseline ${args.baseline} -- anchors are`);
    io.log("  considered aligned and were not rescanned (use --verify-anchors or --strict to force).");
    return { exit: 0, result };
  }
  result.scanned = true;
  result.compiledOnly = args.compiledOnly;
  if (args.compiledOnly) {
    io.log("NOTE: --compiled-only is a DIAGNOSTIC. It reproduces the implementation mistake the");
    io.log("  specification forbids: A3 lives only in the TS declarations, so a compiled-only scan");
    io.log("  reports a FALSE RED. Never use this flag for a verdict.");
  }

  for (const anchor of ANCHORS) {
    const hit = scanAnchor(anchor, install.root, { compiledOnly: args.compiledOnly });
    result.anchors.push({ id: anchor.id, name: anchor.name, dependsOn: anchor.dependsOn, ...hit });
    if (hit.ok) {
      io.log(`\u2713 ANCHOR OK      [${anchor.id}] ${anchor.name}`);
      io.log(`      < ${hit.domain}:${hit.mode}:${hit.path}`);
    } else {
      result.missing.push({ id: anchor.id, name: anchor.name, dependsOn: anchor.dependsOn });
      for (const d of anchor.dependsOn) if (!result.untrustworthy.includes(d)) result.untrustworthy.push(d);
      io.log(`\u2717 ANCHOR MISSING [${anchor.id}] ${anchor.name}`);
      io.log(`      not found in any of ${hit.scannedDomains.join(", ")} (compiled or source form):`);
      for (const m of hit.misses) io.log(`        - ${m}`);
      io.log(`      CONCLUSIONS THAT ARE NO LONGER TRUSTWORTHY:`);
      for (const d of anchor.dependsOn) io.log(`        * ${d}`);
    }
  }

  const okCount = result.anchors.filter((a) => a.ok).length;
  const badCount = result.anchors.length - okCount;
  result.anchorsDecoupled = badCount > 0;
  result.forced = args.force;

  io.log(`========== ${okCount} \u2713 / ${badCount} \u2717 ========== ` +
    `(installed ${result.version ?? "unknown"}, baseline ${args.baseline}, root ${install.root})`);

  if (result.drift && badCount === 0) {
    io.log(`ANCHOR GATE DRIFT-TOLERATED: installed version ${result.version} != baseline ${args.baseline},`);
    io.log(`  but all ${ANCHORS.length} anchors still hit -- the detection logic is still aligned with reality.`);
    io.log("  Re-run the export procedure on the next dsh upgrade and move ANCHOR_BASELINE_VERSION forward.");
  }

  if (result.anchorsDecoupled) {
    io.log(`ANCHOR GATE DECOUPLED: ${badCount}/${ANCHORS.length} anchors are missing.`);
    io.log("  Every conclusion listed above is VOID until a human re-verifies the detection logic");
    io.log("  against the installed dsh. FAIL-CLOSED: the detection logic is decoupled from this");
    io.log("  dsh, so any automatic repair based on it may be entirely wrong and no write action is");
    io.log("  taken by default. Re-verify first; only then pass --force.");
    if (args.force) io.log("  FORCED RUN WHILE DECOUPLED: the operator overrode the fail-closed gate.");
  }

  if (before) {
    const after = snapshotTree(install.root);
    const diffs = diffSnapshots(before, after);
    result.readonlyProof = { entries: before.size, differences: diffs.length, sample: diffs.slice(0, 5) };
    io.log(`READONLY PROOF: ${before.size} entries snapshotted, ${diffs.length} differences`);
    for (const d of diffs.slice(0, 5)) io.log(`      changed: ${d}`);
  }

  const exit = result.anchorsDecoupled ? 1 : (args.strict && result.drift ? 1 : 0);
  return { exit, result };
}

/**
 * Fail-closed helper for WRITERS. The anchor gate is read-only, so the gate itself has
 * nothing to stop; this is the hook every writer must consult before touching a harness
 * whose symbols we can no longer vouch for. Read-only work is never blocked by it.
 */
export function assertWritesAllowed(gateResult, { force = false, action = "a write action", log = null } = {}) {
  if (!gateResult || !gateResult.anchorsDecoupled) return true;
  if (force) {
    if (log) log(`FORCED WHILE DECOUPLED: ${action} ran even though the anchor gate is decoupled.`);
    return true;
  }
  if (log) {
    log(`FAIL-CLOSED: refusing ${action} -- the detection logic is decoupled from the installed dsh ` +
      "(missing anchors: " + gateResult.missing.map((m) => m.id).join(",") + "). " +
      "Conclusions that can no longer be trusted: " + gateResult.untrustworthy.join("; ") + ".");
  }
  return false;
}

/* -------------------------------------------------------------------- cli */

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return resolve(entry) === resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (invokedDirectly) {
  const { exit, result } = runAnchorGate(process.argv.slice(2), console);
  if (process.argv.includes("--json") && result) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
  process.exit(exit);
}
