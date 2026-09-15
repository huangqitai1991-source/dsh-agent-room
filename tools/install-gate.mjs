#!/usr/bin/env node
/**
 * dsh-agent-room -- INSTALL GATE (the one command)
 *
 * ONE COMMAND, THREE QUESTIONS, ONE EXIT CODE:
 *   1. do the harness symbols our detection logic depends on still exist?   (anchor gate)
 *   2. is the RUNNING plugin the build that is on disk?                     (running identity)
 *   3. is the service actually up and answering?                            (liveness guard)
 *
 * This is deliberately NOT a second system. It is the composition point for the checks the
 * team already runs, and it adopts their exit-code contract verbatim:
 *
 *   0  HEALTHY      every check passed
 *   3  UNHEALTHY    at least one check failed, and the failure is named
 *   4  CANNOT TELL  nothing failed, but at least one check could not be read at all
 *
 * A failed READ is never a pass (the same rule the upgrade script's runtime-identity helper
 * enforces) and a CANNOT TELL is never rounded up to HEALTHY. A known-bad outranks an unknown:
 * if one check fails and another cannot tell, the verdict is 3.
 *
 * The anchor gate is read-only, so when it reports the detection logic as DECOUPLED this tool
 * suppresses its own remediation advice through `assertWritesAllowed()` instead of telling a
 * human to run a repair that may be entirely wrong (fail-closed).
 *
 * USAGE
 *   node tools/install-gate.mjs
 *   node tools/install-gate.mjs --base http://127.0.0.1:3080 --json
 *   node tools/install-gate.mjs --dsh-dir <dir> --allow-stopped
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { homedir } from "node:os";
import { runAnchorGate, assertWritesAllowed } from "./anchor-gate.mjs";

export const EXIT_HEALTHY = 0;
export const EXIT_UNHEALTHY = 3;
export const EXIT_CANNOT_TELL = 4;

/**
 * Which `/state` key each plugin release ADDED. The running plugin is identified by the SHAPE
 * it exposes, not by a version string it does not report: this is exactly how D-42 was caught
 * (an install reported success while `/state` still had the previous release's keys, because
 * the watchdog had restarted the host one second before `pnpm install` finished).
 */
const STATE_SHAPE = [
  { since: "0.1.39", key: "dedupe" },
  { since: "0.1.41", key: "wake" },
  { since: "0.1.46", key: "ack" },
  { since: "0.1.47", key: "activation" },
];

function cmpVersion(a, b) {
  const norm = (v) => String(v).split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [norm(a), norm(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** The keys a plugin at `version` MUST expose on /state. */
export function requiredStateKeys(version) {
  if (!version) return [];
  return STATE_SHAPE.filter((s) => cmpVersion(version, s.since) >= 0).map((s) => s.key);
}

/** Best-effort discovery of the installed plugin, so CI does not have to pass --plugin-dir. */
export function discoverPluginDir(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), ".dsh");
  const found = [];
  const profiles = join(home, "profiles");
  try {
    for (const p of readdirSync(profiles, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      const pkg = join(profiles, p.name, "node_modules", "dsh-agent-room", "package.json");
      if (existsSync(pkg)) found.push(pkg);
    }
  } catch { /* no profiles dir: fall through */ }
  if (found.length === 0) return null;
  let best = null;
  for (const pkg of found) {
    let v = null;
    try { v = JSON.parse(readFileSync(pkg, "utf8")).version ?? null; } catch { continue; }
    if (!best || cmpVersion(v ?? "0", best.version ?? "0") > 0) best = { pkg, version: v };
  }
  return best ? { dir: dirname(best.pkg), version: best.version, via: best.pkg } : null;
}

function isListening(host, port, timeoutMs = 1500) {
  return new Promise((done) => {
    const sock = connect({ host, port });
    const finish = (ok) => { try { sock.destroy(); } catch { /* ignore */ } done(ok); };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => finish(true));
    sock.on("timeout", () => finish(false));
    sock.on("error", () => finish(false));
  });
}

async function readState(base) {
  try {
    const r = await fetch(base + "/agent-room-api/state", { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
    const j = await r.json();
    const d = j && j.data !== undefined ? j.data : j;
    if (!d || typeof d !== "object") return { ok: false, why: "state is not an object" };
    return { ok: true, state: d };
  } catch (e) {
    return { ok: false, why: String(e && e.message ? e.message : e) };
  }
}

function parseArgs(argv) {
  const out = {
    base: "http://127.0.0.1:3080",
    dshDir: null,
    pluginDir: null,
    expectVersion: null,
    heartbeatFile: null,
    heartbeatMaxAgeMs: 0,
    allowStopped: false,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => argv[i + 1];
    if (a === "--base") { out.base = val(); i += 1; }
    else if (a === "--dsh-dir") { out.dshDir = resolve(val()); i += 1; }
    else if (a === "--plugin-dir") { out.pluginDir = resolve(val()); i += 1; }
    else if (a === "--expect-version") { out.expectVersion = val(); i += 1; }
    else if (a === "--heartbeat-file") { out.heartbeatFile = val(); i += 1; }
    else if (a === "--heartbeat-max-age-ms") { out.heartbeatMaxAgeMs = Number(val()) || 0; i += 1; }
    else if (a === "--allow-stopped") out.allowStopped = true;
    else if (a === "--json") out.json = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return out;
}

const USAGE = [
  "usage: node tools/install-gate.mjs [--base <url>] [--dsh-dir <dir>] [--plugin-dir <dir>]",
  "                                   [--expect-version <v>] [--heartbeat-file <p>]",
  "                                   [--heartbeat-max-age-ms <n>] [--allow-stopped] [--json]",
  "",
  "exit: 0 healthy | 3 unhealthy | 4 cannot tell",
].join("\n");

export async function runInstallGate(argv = [], io = console) {
  const args = parseArgs(argv);
  if (args.error) { io.error(args.error); io.error(USAGE); return { exit: EXIT_UNHEALTHY, error: args.error }; }
  if (args.help) { io.log(USAGE); return { exit: EXIT_HEALTHY, help: true }; }

  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  /* ---- check 1: the harness symbols (the anchor gate) ---- */
  // One gate, one implementation: this calls tools/anchor-gate.mjs in-process, it does not
  // re-implement the anchor scan.
  const gateArgv = args.dshDir ? ["--verify-anchors", args.dshDir, "--json"] : ["--verify-anchors", "--json"];
  const quietIo = { log: () => {}, error: () => {} };
  const gateRun = runAnchorGate(gateArgv, quietIo);
  const gate = gateRun.result ?? {};
  const gateAnchorLine = gate.anchors ?? [];
  const okCount = gateAnchorLine.filter((a) => a.ok).length;
  if (gateRun.exit === 0) {
    add("anchors", "pass", `${okCount}/${gateAnchorLine.length} anchors hit` +
      (gate.drift ? ` (version drifted from baseline ${gate.baseline}, anchors still aligned)` : ""));
  } else if (gateRun.exit === 1) {
    add("anchors", "fail", `${gateAnchorLine.length - okCount} anchor(s) missing: ` +
      `${(gate.missing ?? []).map((m) => m.id + " " + m.name).join("; ")}`);
  } else {
    add("anchors", "tell", `the anchor gate could not be run (exit ${gateRun.exit}): ` +
      `${gateRun.error ?? gate.versionReadError ?? "no install to check"}`);
  }

  /* ---- check 2: is the RUNNING plugin the build on disk ---- */
  const disk = args.pluginDir
    ? (() => {
      try { return { dir: args.pluginDir, version: JSON.parse(readFileSync(join(args.pluginDir, "package.json"), "utf8")).version ?? null, via: args.pluginDir }; }
      catch (e) { return { dir: args.pluginDir, version: null, via: args.pluginDir, error: String(e.message) }; }
    })()
    : discoverPluginDir();
  const targetVersion = args.expectVersion ?? disk?.version ?? null;

  const state = await readState(args.base);
  if (!state.ok) {
    add("running", "tell", `the running side is unreadable (${state.why}): "is the live plugin the intended build" cannot be answered`);
  } else {
    const have = Object.keys(state.state);
    const need = requiredStateKeys(targetVersion);
    const missing = need.filter((k) => !have.includes(k));
    if (!targetVersion) {
      add("running", "tell", `no plugin version on disk to compare against; /state exposes [${have.join(", ")}]`);
    } else if (missing.length > 0) {
      add("running", "fail",
        `disk has dsh-agent-room ${targetVersion}, which must expose /state {${need.join(", ")}}, ` +
        `but the RUNNING plugin only exposes [${have.join(", ")}] (missing ${missing.join(", ")}) -- ` +
        "memory holds an older build than the disk (stale generation)");
    } else {
      add("running", "pass", `dsh-agent-room ${targetVersion} on disk and the running plugin exposes ${need.join(", ")}`);
    }
  }

  /* ---- check 3: the liveness guard ---- */
  let host = "127.0.0.1";
  let port = 3080;
  try { const u = new URL(args.base); host = u.hostname; port = Number(u.port || (u.protocol === "https:" ? 443 : 80)); } catch { /* keep defaults */ }
  const listening = await isListening(host, port);
  if (!listening) {
    add("guard", args.allowStopped ? "tell" : "fail",
      `nothing is listening on ${host}:${port}` + (args.allowStopped ? " (--allow-stopped: reported as cannot-tell)" : ""));
  } else if (!state.ok) {
    add("guard", "fail", `port ${port} is listening but /agent-room-api/state did not answer (${state.why})`);
  } else {
    add("guard", "pass", `listening on ${host}:${port} and /agent-room-api/state answered`);
  }

  if (args.heartbeatFile) {
    if (args.heartbeatMaxAgeMs <= 0) {
      add("heartbeat", "tell", "a heartbeat file was given without --heartbeat-max-age-ms, so no freshness threshold exists to judge it against");
    } else if (!existsSync(args.heartbeatFile)) {
      add("heartbeat", "fail", `no heartbeat file at ${args.heartbeatFile}`);
    } else {
      try {
        const ageMs = Date.now() - statSync(args.heartbeatFile).mtimeMs;
        add("heartbeat", ageMs <= args.heartbeatMaxAgeMs ? "pass" : "fail",
          `heartbeat ${args.heartbeatFile} is ${Math.round(ageMs)} ms old (limit ${args.heartbeatMaxAgeMs} ms)`);
      } catch (e) {
        add("heartbeat", "tell", `the heartbeat file could not be read: ${String(e.message)}`);
      }
    }
  }

  /* ---- verdict ---- */
  const failed = checks.filter((c) => c.status === "fail");
  const unknown = checks.filter((c) => c.status === "tell");
  const exit = failed.length > 0 ? EXIT_UNHEALTHY : (unknown.length > 0 ? EXIT_CANNOT_TELL : EXIT_HEALTHY);
  const verdict = exit === EXIT_HEALTHY ? "HEALTHY" : (exit === EXIT_UNHEALTHY ? "UNHEALTHY" : "CANNOT TELL");

  if (!args.quiet && !args.json) {
    io.log("=== install gate ===");
    for (const c of checks) {
      io.log(`  [${c.status === "pass" ? " OK " : c.status === "fail" ? "FAIL" : " ?? "}] ${c.name}: ${c.detail}`);
    }
    io.log(`=== VERDICT ${verdict} (exit ${exit}) ===`);
    if (gate.untrustworthy && gate.untrustworthy.length > 0) {
      io.log("  conclusions that can no longer be trusted:");
      for (const u of gate.untrustworthy) io.log(`    * ${u}`);
    }
    // Fail-closed: while the detection logic is decoupled, no repair advice is handed out.
    if (gate.anchorsDecoupled) {
      assertWritesAllowed(gate, { force: false, action: "recommending a repair", log: (m) => io.log("  " + m) });
    }
  }

  const result = {
    tool: "install-gate",
    exit, verdict,
    checks,
    anchors: { hit: okCount, total: gateAnchorLine.length, decoupled: !!gate.anchorsDecoupled, missing: gate.missing ?? [], untrustworthy: gate.untrustworthy ?? [] },
    plugin: { diskVersion: targetVersion, via: disk?.via ?? null },
    base: args.base,
  };
  if (args.json) io.log(JSON.stringify(result, null, 2));
  return { exit, result };
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return resolve(entry) === resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (invokedDirectly) {
  const { exit } = await runInstallGate(process.argv.slice(2), console);
  process.exit(exit);
}
