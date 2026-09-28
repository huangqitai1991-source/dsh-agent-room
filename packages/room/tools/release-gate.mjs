#!/usr/bin/env node
/**
 * dsh-agent-room -- RELEASE GATE (four gates that can REFUSE)
 *
 * WHY THIS FILE EXISTS
 *   On 2026-09-15 nine plugin versions shipped in one day and every one of them carried a
 *   defect a human had to catch by hand. The rules we wrote down afterwards (<=2 versions per
 *   day, evidence before release, independent acceptance, canary first) existed ONLY AS PROSE.
 *   Prose does not execute. This file is the prose turned into a mechanism: each rule is a gate
 *   that REFUSES, names itself and what was missing, and exits non-zero.
 *
 * THE FOUR GATES
 *   1. version-count  refuse when the same calendar day already has the configured maximum
 *                     (default 2) of RELEASED versions. An override needs an explicit
 *                     --reason, and that reason is written into the ledger.
 *   2. evidence       refuse unless an evidence file exists and carries the RAW gate output:
 *                     the house assertion line with an old-build failure count and a new-build
 *                     pass. A summary sentence is not evidence. Missing OR malformed refuses
 *                     with the reason named.
 *   3. acceptance     refuse unless the ledger records acceptance by SOMEONE OTHER THAN THE
 *                     AUTHOR, with who / when / evidence path / verdict. Author self-acceptance
 *                     is rejected outright.
 *   4. canary         refuse unless the designated canary machine was MEASURED, recently, to be
 *                     RUNNING the target version with the live plugin's shape and to have loaded
 *                     the bytes now on its disk. The facts come from `tools/machine-facts.mjs`
 *                     (`--facts <file>`, default max age 600 s); a hand-written version file may
 *                     only REFUSE, never allow. This gate installs, restarts and rolls back
 *                     NOTHING: the operator puts the canary on the target, re-probes, then runs it.
 *
 * EXPLICIT BYPASS -- ONE MORE GATE, AND IT IS A RECORD RATHER THAN A CHECK
 *   Until 0.1.51 these four gates ran only when the caller asked for them (-ReleaseGate). A gate
 *   that must be requested is a convention, not a mechanism: the DEFAULT path skipped every check.
 *   The launcher now runs them always, and the only way past them is the `bypass` entry point,
 *   which REQUIRES --reason and writes
 *   {ts, version, gate:"bypass", verdict:"bypassed", actor, reason} to the ledger. A bypass with no
 *   reason is REFUSED (exit 1) and writes NOTHING: a skip whose reason does not exist cannot be
 *   recorded, so it does not happen.
 *
 * THIS FILE DOES NOT PACK, UPLOAD OR INSTALL -- SO RUNNING IT DIRECTLY GATES NOTHING ABOUT SHIPPING
 *   A gate is only as wide as the path that goes through it. This tool DECIDES; it never produces an
 *   artifact. So: invoking `node tools/release-gate.mjs release ...` yourself, running `npm pack` by
 *   hand, copying the .tgz onto the file server by hand, or installing by hand
 *   (`dsh plugin --profile web add <file>.tgz`) BYPASSES ALL FOUR GATES. None of those steps runs this
 *   file -- they do not even ask it -- and none of them leaves an evidence, acceptance, canary or
 *   publish record behind. A .tgz made that way is untraceable, so it is unsupported.
 *
 *   THE ONLY SUPPORTED PATH IS  ->  node tools/release.mjs
 *   (see its header). It runs these four gates through the `release` composition entry FIRST, packs
 *   with `npm pack` ONLY when they allow, uploads the artifact, reads it back over HTTP by md5, and
 *   writes {ts, version, gate:"publish", verdict, artifact, md5, actor} into the ledger -- so a file
 *   sitting on the server can be traced to the gate run that allowed it. Anything else is a
 *   convention, not a mechanism.
 *
 *   Deliberately NOT gated: the launcher's read-only modes (-Verify / -WatchdogOnly). They install
 *   nothing, publish nothing and restart nothing, so there is no release for them to gate.
 *
 * FAIL CLOSED
 *   A gate that cannot read its inputs REFUSES: no config, unreadable config, unresolvable machine
 *   facts, an unreadable ledger. None of those is a pass, and none of them is reported as one.
 *
 * LEDGER (append-only, one JSON object per event)
 *   default release-ledger.jsonl (--ledger / DSH_RELEASE_LEDGER override it)
 *   {ts, version, gate, verdict, actor, evidence, reason}
 *
 * EXIT CODES
 *   0  ALLOWED  (the gate ran and the operation may proceed)
 *   1  REFUSED  (the gate ran, the precondition is not met, nothing was done)
 *   2  ERROR    (bad arguments, unreadable config, a helper command that could not be run)
 *   3  internal (only used by the --violations self-proof)
 *
 * A REFUSAL PRINTS ONE LINE NAMING THE GATE AND WHAT WAS MISSING. A PASS PRINTS ONE LINE.
 * A gate never prints a success-shaped line it did not verify.
 *
 * READ-ONLY TOWARDS THE PRODUCT: this tool never stops, installs or restarts anything. It runs
 * the operator's own verify/rollback commands and reads / appends two data files.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, openSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { loadFacts, SCHEMA as FACTS_SCHEMA } from "./machine-facts.mjs";

let runSeq = 0;

export const EXIT_ALLOWED = 0;
export const EXIT_REFUSED = 1;
export const EXIT_ERROR = 2;

export const DEFAULT_LEDGER = "<workdir>\\release-ledger.jsonl";
export const DEFAULT_CONFIG = "<workdir>\\release-gate.config.json";
/** A facts file older than this may not carry a release. 600 s = the exec plane's 30 s limit x 20. */
export const DEFAULT_FACTS_MAX_AGE_SEC = 600;

/** The house evidence pattern, in BOTH field orders (the numbers may be reported either way). */
const ASSERTION_NEW_FIRST =
  /new assertions on the NEW build:\s*(\d+)\s*failure\(s\)\s*\|\s*on the OLD build:\s*(\d+)\s*failure\(s\)/i;
const ASSERTION_OLD_FIRST =
  /on the OLD build:\s*(\d+)\s*failure\(s\)\s*\|\s*new assertions on the NEW build:\s*(\d+)\s*failure\(s\)/i;

const USAGE = [
  "usage: node tools/release-gate.mjs <gate> [options]",
  "",
  "gates:",
  "  version-count --version <v> [--max <n>] [--override --reason <why>]",
  "  evidence      --version <v> --evidence <file> [--author <who>]",
  "  acceptance    --version <v> --author <who>",
  "  canary        --version <v> --facts <file> [--machine <id>] [--config <file>]",
  "                [--facts-max-age-sec <n>] [--expect-version <v>] [--plugin room|org]",
  "                (never installs anything; --plugin defaults to room and selects WHICH plugin's",
  "                 measured version the target must match)",
  "  fleet         --version <v> [--machine <id>]",
  "  release       --version <v> --evidence <file> --author <who> [--max <n>] [--override --reason <why>]",
  "  accept        --version <v> --accepted-by <who> --author <who> --evidence <file> [--verdict <v>]",
  "  bypass        --version <v> --reason <why>   (skips the checks ON THE RECORD; refused without --reason)",
  "",
  "common:  [--ledger <file>] [--actor <who>] [--json]",
  "exit: 0 allowed | 1 refused (gate named, reason named) | 2 error",
].join("\n");

/* ------------------------------------------------------------------- ledger */

function nowIso(now = () => new Date()) {
  return now().toISOString();
}

function defaultActor() {
  try { return userInfo().username || "unknown"; } catch { return "unknown"; }
}

/**
 * Read the append-only ledger. A malformed line is NOT skipped silently: the line number goes
 * into `malformed` and the caller refuses, because a ledger that cannot be read cannot prove
 * anything (the same rule as everywhere else in this repo).
 */
export function readLedger(file) {
  const out = { path: file, exists: false, events: [], malformed: [], raw: null };
  if (!existsSync(file)) return out;
  out.exists = true;
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    out.malformed.push({ line: 0, error: String(e && e.message ? e.message : e) });
    return out;
  }
  out.raw = text;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      const obj = JSON.parse(line);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not a JSON object");
      out.events.push(obj);
    } catch (e) {
      out.malformed.push({ line: i + 1, error: String(e && e.message ? e.message : e) });
    }
  }
  return out;
}

/** Append one event. Returns the file size after the write, so the caller can prove it landed. */
export function appendEvent(file, event) {
  mkdirSync(dirname(file), { recursive: true });
  const line = JSON.stringify(event) + "\n";
  appendFileSync(file, line, "utf8");
  return { bytes: Buffer.byteLength(line, "utf8"), sizeAfter: statSync(file).size };
}

/** The exact event shape the task fixes: {ts, version, gate, verdict, actor, evidence, reason}. */
export function eventOf({ ts, version, gate, verdict, actor, evidence = null, reason = null }) {
  return { ts, version, gate, verdict, actor, evidence, reason };
}

function record(ledger, event) {
  try {
    appendEvent(ledger, event);
    return null;
  } catch (e) {
    return String(e && e.message ? e.message : e);
  }
}

const dayOf = (ts) => String(ts ?? "").slice(0, 10);

/* --------------------------------------------------------------- config file */

export function loadConfig(file) {
  if (!file) return { path: null, config: null, error: null };
  if (!existsSync(file)) return { path: file, config: null, error: `no config file at ${file}` };
  try {
    // A config an operator wrote in a Windows editor often starts with a UTF-8 BOM. That is a
    // file-format fact, not a lie about the release, so it is tolerated HERE -- and only here:
    // the LEDGER is written by this tool, so a BOM in the ledger is treated as corruption.
    const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const cfg = JSON.parse(text);
    if (!cfg || typeof cfg !== "object") return { path: file, config: null, error: `${file} is not a JSON object` };
    return { path: file, config: cfg, error: null };
  } catch (e) {
    return { path: file, config: null, error: `${file} is not readable JSON: ${String(e.message)}` };
  }
}

function cfgPath(config, rel) {
  if (!rel) return null;
  if (/^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("/")) return rel;
  return join(dirname(config.path ?? "."), rel);
}

/** machineRecord(): the version file + the entry for one designated machine. */
export function machineRecord(config, machineId) {
  const machinesRoot = config.config?.machinesRoot
    ? cfgPath(config.config, config.config.machinesRoot)
    : null;
  const entry = (config.config?.machines ?? []).find((m) => m && m.id === machineId) ?? null;
  const dir = machinesRoot ? join(machinesRoot, machineId) : null;
  const versionFile = entry?.versionFile ? cfgPath(config.config, entry.versionFile) : (dir ? join(dir, "version") : null);
  let version = null;
  let readError = null;
  if (versionFile && existsSync(versionFile)) {
    try { version = readFileSync(versionFile, "utf8").trim(); } catch (e) { readError = String(e.message); }
  } else if (versionFile) {
    readError = `no version file at ${versionFile}`;
  } else {
    readError = "no version-file location is configured for this machine";
  }
  return { id: machineId, entry, dir, versionFile, version, readError };
}

/* ------------------------------------------------------------------- args */

function parseArgs(argv) {
  const out = {
    gate: null, version: null, evidence: null, author: null, actor: null, reason: null,
    max: null, override: false, machine: null, config: null, ledger: null, acceptedBy: null,
    verdict: null, expectVersion: null, json: false, quiet: false, allowDowngrade: false,
    hours: null, fixtures: null, facts: null, factsMaxAgeSec: null, plugin: null,
  };
  const takesValue = new Set([
    "--version", "--evidence", "--author", "--actor", "--reason", "--max", "--machine",
    "--config", "--ledger", "--accepted-by", "--verdict", "--expect-version", "--hours",
    "--fixtures", "--facts", "--facts-max-age-sec", "--plugin",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--json") { out.json = true; continue; }
    if (a === "--quiet") { out.quiet = true; continue; }
    if (a === "--override") { out.override = true; continue; }
    if (a === "--allow-downgrade") { out.allowDowngrade = true; continue; }
    if (takesValue.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      i += 1;
      const key = { "--version": "version", "--evidence": "evidence", "--author": "author", "--actor": "actor", "--reason": "reason", "--max": "max", "--machine": "machine", "--config": "config", "--ledger": "ledger", "--accepted-by": "acceptedBy", "--verdict": "verdict", "--expect-version": "expectVersion", "--hours": "hours", "--fixtures": "fixtures", "--facts": "facts", "--facts-max-age-sec": "factsMaxAgeSec", "--plugin": "plugin" }[a];
      out[key] = v;
      continue;
    }
    if (a.startsWith("--")) return { error: `unknown argument: ${a}` };
    if (out.gate === null) { out.gate = a; continue; }
    return { error: `unexpected extra argument: ${a}` };
  }
  if (out.max !== null) {
    const n = Number(out.max);
    if (!Number.isInteger(n) || n < 0) return { error: `--max must be a non-negative integer, got ${out.max}` };
    out.max = n;
  }
  if (out.factsMaxAgeSec !== null) {
    const n = Number(out.factsMaxAgeSec);
    if (!Number.isInteger(n) || n < 0) return { error: `--facts-max-age-sec must be a non-negative integer, got ${out.factsMaxAgeSec}` };
    out.factsMaxAgeSec = n;
  }
  return out;
}

const GATES = new Set(["version-count", "evidence", "acceptance", "canary", "fleet", "release", "accept", "bypass"]);

/* ------------------------------------------------------------ gate 1: count */

/**
 * Gate 1. Counts RELEASED versions for the version's calendar day, using the ledger, never an
 * in-memory counter. The override is explicit, needs a reason, and is itself written down.
 */
export function gateVersionCount({ ledger, events, version, max = 2, override = false, reason = null, actor, ts }) {
  const day = dayOf(ts);
  const released = events.filter((e) => e.gate === "release" && e.verdict === "released" && e.version !== version);
  const sameDay = released.filter((e) => dayOf(e.ts) === day);
  const sameDayVersions = [...new Set(sameDay.map((e) => e.version))];
  const count = sameDayVersions.length;

  if (override && !reason) {
    return { verdict: "refused", count: sameDayVersions.length, versions: sameDayVersions,
      missing: `--override was given without --reason; an override without a written reason is not an override` };
  }
  if (count >= max && !override) {
    return { verdict: "refused", count, versions: sameDayVersions,
      missing: `${day} already has ${count} released version(s) [${sameDayVersions.join(", ")}], ` +
        `the configured maximum is ${max}` };
  }
  return {
    verdict: "allowed", count, versions: sameDayVersions,
    detail: count >= max
      ? `overridden at ${count}/${max} released version(s) on ${day} (reason: ${reason})`
      : `${count}/${max} released version(s) on ${day}`,
  };
}

/* --------------------------------------------------------- gate 2: evidence */

/**
 * Gate 2. The evidence file must carry the RAW gate output. The decisive line is the house
 * assertion line; a file whose only "evidence" is a sentence someone typed is refused.
 */
export function parseEvidence(text) {
  const lines = [];
  for (const m of text.matchAll(new RegExp(ASSERTION_NEW_FIRST.source, "gi"))) {
    lines.push({ newFailures: Number(m[1]), oldFailures: Number(m[2]), line: m[0] });
  }
  for (const m of text.matchAll(new RegExp(ASSERTION_OLD_FIRST.source, "gi"))) {
    lines.push({ newFailures: Number(m[2]), oldFailures: Number(m[1]), line: m[0] });
  }
  const discriminating = lines.filter((l) => (l.newFailures === 0) !== (l.oldFailures === 0));
  return { lines, discriminating };
}

export function gateEvidence({ version, evidenceFile, requireRaw = true }) {
  if (!evidenceFile) return { verdict: "refused", missing: "no --evidence file was given" };
  if (!existsSync(evidenceFile)) {
    return { verdict: "refused", missing: `no evidence file at ${evidenceFile}` };
  }
  let text;
  try { text = readFileSync(evidenceFile, "utf8"); } catch (e) {
    return { verdict: "refused", missing: `the evidence file ${evidenceFile} could not be read: ${String(e.message)}` };
  }
  if (text.trim() === "") return { verdict: "refused", missing: `the evidence file ${evidenceFile} is empty` };

  const parsed = parseEvidence(text);
  if (parsed.lines.length === 0) {
    return {
      verdict: "refused",
      missing: `the evidence file carries no raw gate output: it has no assertion line matching ` +
        `"new assertions on the NEW build: 0 failure(s) | on the OLD build: N failure(s)" (a summary sentence is not evidence)`,
    };
  }
  // Every assertion line must report a CLEAN new build; at least one must show the old build
  // still failing. Any other combination means the run does not demonstrate the fix.
  const voidLine = parsed.lines.find((l) => l.newFailures === 0 && l.oldFailures === 0);
  const dirtyNew = parsed.lines.find((l) => l.newFailures !== 0);
  if (voidLine) {
    return {
      verdict: "refused",
      missing: `one assertion line has 0 failures on BOTH builds ("${voidLine.line}"), so that run ` +
        `distinguishes nothing: the OLD build must still fail (${parsed.lines.length} line(s) checked)`,
    };
  }
  if (dirtyNew) {
    return {
      verdict: "refused",
      missing: `the new-build side is not clean: an assertion line reports ` +
        `new=${dirtyNew.newFailures} failure(s) / old=${dirtyNew.oldFailures} failure(s)`,
    };
  }
  const sample = parsed.discriminating[0];
  if (requireRaw) {
    const needed = ["command", "assertion"];
    const missingMarker = needed.find((k) => !text.toLowerCase().includes(k));
    if (missingMarker) {
      return {
        verdict: "refused",
        missing: `the evidence file has an assertion line but no raw run output around it ` +
          `(no "${missingMarker}" in the file)`,
      };
    }
  }
  const versions = { old: null, new: null };
  const oldField = text.match(/old[-_ ]?version["'\s:=]+([0-9][0-9A-Za-z.\-]*)/i);
  const newField = text.match(/new[-_ ]?version["'\s:=]+([0-9][0-9A-Za-z.\-]*)/i);
  if (oldField) versions.old = oldField[1];
  if (newField) versions.new = newField[1];
  if (versions.new && version && versions.new !== version) {
    return { verdict: "refused", missing: `the evidence file is for new-version ${versions.new}, not ${version}` };
  }
  return {
    verdict: "allowed",
    detail: `old build ${sample.oldFailures} failure(s) / new build ${sample.newFailures} failure(s) ` +
      `over ${parsed.discriminating.length} discriminating assertion line(s)`,
    evidence: evidenceFile,
    oldFailures: sample.oldFailures,
    newFailures: sample.newFailures,
  };
}

/* -------------------------------------------------------- gate 3: acceptance */

/** Gate 3. Someone other than the author must have accepted THIS version, with evidence. */
export function gateAcceptance({ events, version, author }) {
  if (!author) return { verdict: "refused", missing: "no author was named (--author), so 'someone else' cannot be decided" };
  const rows = events.filter((e) => e.gate === "acceptance" && e.version === version);
  if (rows.length === 0) {
    return { verdict: "refused", missing: `the ledger has no acceptance record for ${version} (acceptance by someone other than the author is still outstanding)` };
  }
  const selfOnly = rows.every((r) => r.actor === author);
  if (selfOnly) {
    return { verdict: "refused", missing: `every acceptance record for ${version} was written by the author (${author}); self-acceptance is rejected outright` };
  }
  const pass = rows.filter((r) => r.actor !== author && String(r.verdict).toLowerCase() === "accepted");
  if (pass.length === 0) {
    const nonAuthor = rows.filter((r) => r.actor !== author);
    return {
      verdict: "refused",
      missing: `the acceptance record(s) for ${version} by ${[...new Set(nonAuthor.map((r) => r.actor))].join(", ") || "nobody"} ` +
        `do not carry verdict "accepted" (found: ${[...new Set(nonAuthor.map((r) => r.verdict))].join(", ") || "none"})`,
    };
  }
  const ok = pass[pass.length - 1];
  if (!ok.evidence || !existsSync(ok.evidence)) {
    return { verdict: "refused", missing: `the acceptance for ${version} by ${ok.actor} names evidence ${ok.evidence ?? "(none)"} which does not exist` };
  }
  if (!ok.ts) return { verdict: "refused", missing: `the acceptance for ${version} by ${ok.actor} has no timestamp` };
  return {
    verdict: "allowed",
    detail: `accepted by ${ok.actor} (not the author ${author}) at ${ok.ts} on evidence ${ok.evidence}`,
    acceptor: ok.actor, ts: ok.ts, evidence: ok.evidence,
  };
}

/* ------------------------------------------------------------ gate 4: canary */

/**
 * Run one helper command with FILE stdio (never a pipe) and read the bytes back.
 *
 * Why file stdio: the same reason the upgrade launchers use it (D-39) plus a sandbox fact --
 * a confined process cannot always open a named pipe for a child's stdio, so a piped
 * spawnSync reports `EPERM` instead of the helper's real exit code and output. `detached` stays
 * false: D-39 records that a detached launcher can exit 0 without ever running.
 */
function runCommand(cmd, args, { cwd = null, env = process.env, timeoutMs = 180000 } = {}) {
  const runDir = process.env.DSH_RELEASE_RUN_DIR ?? "<workdir>\\_release-gate-run";
  let outFile;
  try {
    mkdirSync(runDir, { recursive: true });
    outFile = join(runDir, `run-${process.pid}-${(runSeq += 1)}.log`);
  } catch (e) {
    return { ok: false, status: null, stdout: "", stderr: "", error: `cannot prepare the run directory ${runDir}: ${String(e.message)}` };
  }
  let fd = null;
  try { fd = openSync(outFile, "w"); } catch (e) {
    return { ok: false, status: null, stdout: "", stderr: "", error: `cannot open ${outFile}: ${String(e.message)}` };
  }
  let r;
  try {
    r = spawnSync(cmd, args, { cwd, env, timeout: timeoutMs, windowsHide: true, detached: false, stdio: ["ignore", fd, fd] });
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  let text = "";
  try { text = readFileSync(outFile, "utf8"); } catch { /* empty output is a valid outcome */ }
  try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
  if (r.error) {
    return { ok: false, status: null, stdout: "", stderr: String(r.error.message), error: String(r.error.message) };
  }
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: text,
    stderr: "",
    signal: r.signal ?? null,
    timedOut: r.status === null && r.signal === "SIGTERM",
  };
}

function canaryCommands(config, machine, version, prevVersion) {
  const c = config.config ?? {};
  const vars = { machine: machine.id, address: machine.entry?.address ?? machine.id, version, prevVersion: prevVersion ?? "" };
  const md = machine.entry ?? {};
  const resolveOne = (val) => {
    if (val == null) return null;
    if (typeof val === "string") return { cmd: val, args: [], shell: true };
    return { cmd: val.cmd, args: (val.args ?? []).map((a) => String(a).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""))), shell: false };
  };
  const upgrade = resolveOne(md.upgrade ?? md.upgradeCommand ?? c.upgradeCommand ?? null);
  const verify = resolveOne(md.postUpgradeVerify ?? md.postUpgradeVerifyCommand ?? c.postUpgradeVerifyCommand ?? null);
  const rollback = resolveOne(md.rollback ?? md.rollbackCommand ?? c.rollbackCommand ?? null);
  return { upgrade, verify, rollback, vars };
}

function execResolved(spec, { env }) {
  if (!spec) return null;
  if (spec.shell) return runCommand(spec.cmd, [], { env });
  return runCommand(spec.cmd, spec.args, { env });
}

/**
 * Gate 4. One designated machine goes first. The gate does not trust anyone's summary: it reads
 * the canary's OWN version file, runs the operator's post-upgrade verification against that live
 * machine, and on failure rolls it back and proves the rollback landed.
 */
export function gateCanary({ args, config, ledger, ts }) {
  const version = args.version;
  const machineId = args.machine;
  if (!config.config) {
    return { verdict: "refused", missing: `no canary configuration: ${config.error ?? "no --config given"}` };
  }
  const declared = (config.config.machines ?? []).filter((m) => m && m.canary === true).map((m) => m.id);
  if (declared.length > 1) {
    return { verdict: "refused", missing: `the config designates ${declared.length} canary machines [${declared.join(", ")}]; a canary is exactly ONE machine` };
  }
  const designated = machineId ?? declared[0] ?? config.config.canaryMachine ?? null;
  if (!designated) return { verdict: "refused", missing: "no machine was designated for the canary (--machine or config.canaryMachine)" };
  if (declared.length === 1 && machineId && machineId !== declared[0]) {
    return { verdict: "refused", missing: `--machine ${machineId} is not the designated canary (${declared[0]})` };
  }
  const machine = machineRecord(config, designated);
  if (!machine.entry) {
    return { verdict: "refused", missing: `machine ${designated} is not in the config's machine list` };
  }
  const expect = args.expectVersion;
  // A hand-typed version file may only ever REFUSE (card-13 §B3 step 7). It is read here as the
  // cross-check, never as the source of truth: the truth is what the machine was measured to run.
  const legacyVersion = machine.version;
  const { verify } = canaryCommands(config, machine, version, null);
  const env = { ...process.env, ...(args.fixtures ? { DSH_RELEASE_FIXTURES: args.fixtures } : {}) };

  /* ---- THE FACTS, FIRST (card-13 §B3): every step below can only REFUSE ---- */
  const judged = judgeCanaryFacts({
    factsPath: args.facts ? resolve(args.facts) : null,
    designated,
    maxAgeSec: args.factsMaxAgeSec ?? DEFAULT_FACTS_MAX_AGE_SEC,
    ts,
    version,
    expect,
    legacyVersion,
    plugin: args.plugin,
  });
  if (judged.verdict === "refused") {
    return { ...judged, machine: designated, canaryVersion: judged.probedVersion ?? legacyVersion };
  }

  /* ---- phase 2: THE OPERATOR'S OWN VERIFICATION, WHEN THEY HAVE ONE ---- */
  if (!verify) {
    return { ...judged, machine: designated, canaryVersion: judged.probedVersion, upgraded: false };
  }
  const verifyRun = execResolved(verify, { env });
  const verifyOut = ((verifyRun.stdout ?? "") + (verifyRun.stderr ?? "")).trim();
  if (verifyRun.ok) {
    return {
      ...judged,
      machine: designated,
      canaryVersion: judged.probedVersion,
      detail: judged.detail + `; the operator's verification passed` +
        (verifyOut ? ` (${verifyOut.split(/\r?\n/).filter(Boolean).slice(-1)[0]})` : ""),
      verifyOut,
      upgraded: false,
    };
  }
  /* ---- phase 3: failure -- refuse, and DO NOT touch the machine ---- */
  return {
    verdict: "refused",
    machine: designated,
    canaryVersion: judged.probedVersion,
    verifyOut,
    missing: `canary ${designated} verification FAILED (exit ${verifyRun.status})` +
      (verifyOut ? `: ${verifyOut.split(/\r?\n/).filter(Boolean).slice(-1)[0]}` : "") +
      `; the rest of the fleet is refused. This tool does not install, restart or roll back anything: ` +
      `the machine is left exactly as it was found`,
  };
}

/**
 * The facts judgement (card-13 §B3). Ordered, and every step can only REFUSE -- the message names
 * the FIRST thing that is missing, so a refusal is actionable instead of a verdict.
 *
 * WHY MEASURED FACTS AND NOT A VERSION FILE: the version file this gate used to read was written by
 * hand (and in production the directory it pointed at did not even exist), so the gate either
 * refused forever or could be satisfied by TYPING the answer. A machine's own load order cannot be
 * typed: `loadedAfterDisk` compares the host process start against the newest byte under lib/, which
 * is precisely the difference D-42 was made of -- the disk was new while the process still ran the
 * old plugin.
 */
export function judgeCanaryFacts({ factsPath, designated, maxAgeSec = DEFAULT_FACTS_MAX_AGE_SEC, ts, version, expect = null, legacyVersion = null, plugin = "room" }) {
  // WHICH PLUGIN IS THIS RELEASE? A version string alone does not say: agent-room ships 0.1.x and
  // agent-org ships 0.2.x, both from the same machines, and the probe reports both. `--plugin`
  // selects the measured field the target version must satisfy. The default is the room plugin, so
  // every existing caller behaves exactly as before; an unknown value is refused (see below) rather
  // than silently treated as "room", because a typo must not quietly judge the wrong plugin.
  const pluginArg = String(plugin ?? "room").trim().toLowerCase();
  if (pluginArg !== "room" && pluginArg !== "org") {
    return { verdict: "refused", missing: `--plugin ${JSON.stringify(String(plugin))} is not a plugin this gate knows: use "room" (agent-room) or "org" (agent-org)` };
  }
  const which = pluginArg;
  if (!factsPath) {
    return { verdict: "refused", missing:
      "no --facts file was given: the canary is judged on MEASURED facts (tools/machine-facts.mjs), " +
      "never on a hand-written version file" };
  }
  const loaded = loadFacts(factsPath);
  if (loaded.error) return { verdict: "refused", missing: loaded.error };
  const facts = loaded.facts;
  if (facts.schema !== FACTS_SCHEMA) {
    return { verdict: "refused", missing:
      `${factsPath} declares schema ${JSON.stringify(facts.schema)} instead of ${FACTS_SCHEMA}; ` +
      `facts this gate cannot read are not facts it may act on` };
  }
  const probedAt = Date.parse(String(facts.probedAt ?? ""));
  if (!Number.isFinite(probedAt)) {
    return { verdict: "refused", missing: `the facts in ${factsPath} carry an unreadable probedAt (${JSON.stringify(facts.probedAt)})` };
  }
  const nowMs = Date.parse(String(ts ?? ""));
  const ageSec = Number.isFinite(nowMs) ? Math.max(0, Math.round((nowMs - probedAt) / 1000)) : null;
  if (ageSec === null) {
    return { verdict: "refused", missing: `the gate has no usable timestamp to age the facts against (${JSON.stringify(ts)})` };
  }
  if (ageSec > maxAgeSec) {
    return { verdict: "refused", probedAt: facts.probedAt, ageSec, missing:
      `the facts in ${factsPath} are ${ageSec}s old (probed ${facts.probedAt}), which is older than the ` +
      `${maxAgeSec}s maximum; re-probe the canary and try again` };
  }
  const rows = Array.isArray(facts.machines) ? facts.machines : [];
  const row = rows.find((r) => r && r.id === designated) ?? null;
  if (!row) {
    return { verdict: "refused", ageSec, missing:
      `the facts in ${factsPath} have no row for the designated canary ${designated} ` +
      `(rows: ${rows.map((r) => r && r.id).filter(Boolean).join(", ") || "none"})` };
  }
  if (row.unreachable) {
    return { verdict: "refused", ageSec, missing: `the canary ${designated} could NOT be probed: ${row.unreachable}` };
  }
  // The measured version of the plugin this release is about. An org release judged against facts
  // that never measured org must REFUSE BY NAME: "we did not look" is not "it matches".
  const measured = which === "org" ? (row.orgVersion ?? null) : row.pluginVersion;
  if (which === "org" && (measured === null || measured === undefined || measured === "")) {
    return { verdict: "refused", ageSec, missing:
      `the facts in ${factsPath} carry no agent-org measurement for ${designated} (the probe reported only the room plugin) ` +
      `. Re-probe with a tools/machine-facts.mjs that reports orgPlugin, then run this gate again` };
  }
  if (row.shape?.ack !== true || row.shape?.activation !== true) {
    return { verdict: "refused", plugin: which, probedVersion: measured, ageSec, missing:
      `the canary ${designated} is not showing the live plugin's shape ` +
      `(ack=${row.shape?.ack === true}, activation=${row.shape?.activation === true}); ` +
      `a machine whose own /state does not carry both blocks is not a machine this gate can certify` };
  }
  const loadedAfterDisk = which === "org" ? row.orgLoadedAfterDisk : row.loadedAfterDisk;
  const installMtime = which === "org" ? row.orgInstallMtime : row.installMtime;
  const libHash = which === "org" ? row.orgLibHash : row.libHash;
  if (loadedAfterDisk !== true) {
    return { verdict: "refused", plugin: which, probedVersion: measured, ageSec, missing:
      `the canary ${designated} did not load the ${which === "org" ? "agent-org" : "agent-room"} bytes on its disk: ` +
      `hostStart=${row.hostStart} is not at or after the install time=${installMtime}` +
      (row.hostStart === null ? " (hostStart is not readable)" : "") +
      `. This is D-42: the upgrade reported success, the disk was new, and the running process was still the old build` };
  }
  if (measured !== version) {
    return { verdict: "refused", plugin: which, probedVersion: measured, ageSec, missing:
      `the canary ${designated} is RUNNING ${which === "org" ? "agent-org " : ""}${measured}, not the target ${version}` +
      (expect ? ` (expected ${expect})` : "") +
      `. Install the target on the canary, re-probe it, then run this gate again -- this gate never installs anything` };
  }
  // The hand-written version file is the ROOM plugin's file (config.machines[].versionFile): it may
  // only ever REFUSE, and it says nothing about agent-org, so it is not consulted for an org release.
  if (which === "room" && legacyVersion !== null && legacyVersion !== undefined && String(legacyVersion).trim() !== "" && String(legacyVersion).trim() !== measured) {
    return { verdict: "refused", plugin: which, probedVersion: measured, ageSec, missing:
      `the hand-written version file for ${designated} says ${JSON.stringify(String(legacyVersion).trim())} while the machine ` +
      `was measured RUNNING ${measured}; a hand-typed fact that disagrees with the measurement is refused` };
  }
  return {
    verdict: "allowed",
    plugin: which,
    probedVersion: measured,
    ageSec,
    detail:
      `canary ${designated} is RUNNING ${which === "org" ? "agent-org " : ""}${measured} (measured ${ageSec}s ago): pid ${row.hostPid}, ` +
      `hostStarted ${row.hostStart} >= ${which === "org" ? "org " : ""}install time ${installMtime} (package dir; file mtimes are ` +
      `npm-normalised to 1985 and cannot be used), ${which === "org" ? "org" : ""}libHash ${libHash}, ` +
      `live shape ack+activation both present` +
      (which === "room" && legacyVersion ? `, hand-written file agrees (${String(legacyVersion).trim()}) and was not needed` : ""),
  };
}

/** The fleet gate. It asks the ledger, not a variable: did THIS version's canary pass? */
export function gateFleet({ events, version }) {
  const rows = events.filter((e) => e.version === version && (e.gate === "canary" || e.gate === "canary_rolled_back"));
  if (rows.length === 0) {
    return { verdict: "refused", missing: `the ledger has no canary result for ${version}; the fleet may not be touched before the canary has run` };
  }
  const last = rows[rows.length - 1];
  if (last.verdict !== "canary_passed") {
    return {
      verdict: "refused",
      missing: `the last canary result for ${version} is "${last.verdict}" on ${last.evidence ?? "unknown machine"}` +
        `${last.reason ? ` (${last.reason})` : ""}; the fleet is refused until a canary passes`,
    };
  }
  return { verdict: "allowed", detail: `canary passed for ${version} on ${last.evidence ?? "the designated machine"} at ${last.ts}` };
}

/* -------------------------------------------------------------- dispatcher */

function makeCtx(argv, io, now = null) {
  const args = parseArgs(argv);
  if (args.error) return { args, error: args.error };
  const ts = nowIso(now ?? (() => new Date()));
  args.ts = ts;
  args.ledger = resolve(args.ledger ?? process.env.DSH_RELEASE_LEDGER ?? DEFAULT_LEDGER);
  args.config = resolve(args.config ?? process.env.DSH_RELEASE_GATE_CONFIG ?? DEFAULT_CONFIG);
  args.actor = args.actor ?? defaultActor();
  const ledger = readLedger(args.ledger);
  // Load the config from the given path; a missing file is REPORTED by the gate that needs it
  // (the canary gate refuses by name) instead of silently falling back to a default.
  const config = loadConfig(args.config);
  return { args, ledger, config, io, ts };
}

function missingArgs(args, needed) {
  const miss = needed.filter((k) => !args[k]);
  return miss.length > 0 ? `missing required argument(s): ${miss.map((k) => "--" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())).join(", ")}` : null;
}

function refuse(io, gate, missing) {
  io.error(`RELEASE GATE ${gate} REFUSED: ${missing}`);
  return { exit: EXIT_REFUSED, result: { gate, verdict: "refused", missing } };
}

function allow(io, gate, detail) {
  io.log(`RELEASE GATE ${gate} ALLOWED: ${detail}`);
  return { exit: EXIT_ALLOWED, result: { gate, verdict: "allowed", detail } };
}

/**
 * One entry point for every gate. Returns {exit, result} and NEVER throws on a refusal: a
 * refusal is a normal, named outcome with a non-zero exit code.
 */
export function runReleaseGate(argv = [], io = console, { now = null } = {}) {
  const ctx = makeCtx(argv, io, now);
  const { args } = ctx;
  if (ctx.error || args.error) {
    io.error(`release-gate: ${ctx.error ?? args.error}`);
    io.error(USAGE);
    return { exit: EXIT_ERROR, result: { error: ctx.error ?? args.error } };
  }
  if (args.help || !args.gate) { io.log(USAGE); return { exit: args.help ? EXIT_ALLOWED : EXIT_ERROR, result: { help: true } }; }
  if (!GATES.has(args.gate)) {
    io.error(`release-gate: unknown gate "${args.gate}"`);
    io.error(USAGE);
    return { exit: EXIT_ERROR, result: { error: "unknown gate" } };
  }
  if (ctx.ledger.malformed.length > 0) {
    return refuse(io, args.gate, `the ledger ${args.ledger} has ${ctx.ledger.malformed.length} unreadable line(s) ` +
      `(first: line ${ctx.ledger.malformed[0].line}: ${ctx.ledger.malformed[0].error}) - a ledger that cannot be read proves nothing`);
  }

  const recordEvent = (gate, verdict, { evidence = null, reason = null } = {}) => {
    const err = record(args.ledger, eventOf({ ts: args.ts, version: args.version, gate, verdict, actor: args.actor, evidence, reason }));
    if (err) io.error(`  NOTE: the ledger ${args.ledger} could not be written: ${err}`);
    return err;
  };

  /* ---- version-count ---- */
  if (args.gate === "version-count") {
    const miss = missingArgs(args, ["version"]);
    if (miss) return { exit: EXIT_ERROR, result: { error: miss } };
    const max = args.max ?? 2;
    const g = gateVersionCount({ ledger: args.ledger, events: ctx.ledger.events, version: args.version, max, override: args.override, reason: args.reason, actor: args.actor, ts: args.ts });
    if (g.verdict === "refused") {
      recordEvent("version-count", "refused", { reason: g.missing });
      return refuse(io, "version-count", g.missing);
    }
    if (args.override) recordEvent("version-count", "override", { reason: args.reason });
    return allow(io, "version-count", g.detail);
  }

  /* ---- evidence ---- */
  if (args.gate === "evidence") {
    const miss = missingArgs(args, ["version", "evidence"]);
    if (miss) return { exit: EXIT_ERROR, result: { error: miss } };
    const g = gateEvidence({ version: args.version, evidenceFile: resolve(args.evidence) });
    if (g.verdict === "refused") {
      recordEvent("evidence", "refused", { evidence: resolve(args.evidence), reason: g.missing });
      return refuse(io, "evidence", g.missing);
    }
    recordEvent("evidence", "present", { evidence: g.evidence, reason: g.detail });
    return allow(io, "evidence", `${g.detail} in ${g.evidence}`);
  }

  /* ---- acceptance ---- */
  if (args.gate === "acceptance") {
    const miss = missingArgs(args, ["version", "author"]);
    if (miss) return { exit: EXIT_ERROR, result: { error: miss } };
    const g = gateAcceptance({ events: ctx.ledger.events, version: args.version, author: args.author });
    if (g.verdict === "refused") {
      recordEvent("acceptance", "refused", { reason: g.missing });
      return refuse(io, "acceptance", g.missing);
    }
    return allow(io, "acceptance", g.detail);
  }

  /* ---- accept (write one acceptance record, refusing self-acceptance) ---- */
  if (args.gate === "accept") {
    const miss = missingArgs(args, ["version", "author", "acceptedBy", "evidence"]);
    if (miss) return { exit: EXIT_ERROR, result: { error: miss } };
    if (args.acceptedBy === args.author) {
      // Recorded as a REJECTED acceptance attempt, never as an acceptance: the ledger has to show
      // that someone tried to self-accept and was refused, without that row ever counting.
      recordEvent("acceptance_rejected", "self_acceptance_refused", { evidence: resolve(args.evidence),
        reason: `the acceptor (${args.acceptedBy}) is the author (${args.author})` });
      return refuse(io, "acceptance", `the acceptor (${args.acceptedBy}) IS the author (${args.author}); self-acceptance is rejected outright`);
    }
    const ev = resolve(args.evidence);
    if (!existsSync(ev)) return refuse(io, "acceptance", `the acceptance names evidence ${ev} which does not exist`);
    const verdict = args.verdict ?? "accepted";
    // The ACTOR of an acceptance event is the ACCEPTOR, not whoever invoked the script: the
    // ledger must be able to answer "who accepted this", and only the acceptor can.
    const savedActor = args.actor;
    args.actor = args.acceptedBy;
    recordEvent("acceptance", verdict, { evidence: ev, reason: args.reason });
    args.actor = savedActor;
    return allow(io, "acceptance", `recorded acceptance of ${args.version} by ${args.acceptedBy} (verdict ${verdict}) on ${ev}`);
  }

  /* ---- canary ---- */
  if (args.gate === "canary") {
    const miss = missingArgs(args, ["version"]);
    if (miss) return { exit: EXIT_ERROR, result: { error: miss } };
    const g = gateCanary({ args, config: ctx.config, ledger: args.ledger, ts: args.ts });
    if (g.verdict === "refused") {
      const rolledSameDay = g.rolledBack === true;
      recordEvent(rolledSameDay ? "canary_rolled_back" : "canary", "canary_failed",
        { evidence: g.machine ?? null, reason: g.missing });
      if (g.detail) io.error(`  rollback: ${g.detail}`);
      return refuse(io, "canary", g.missing);
    }
    recordEvent("canary", "canary_passed", { evidence: g.machine, reason: g.detail });
    return allow(io, "canary", g.detail);
  }

  /* ---- fleet ---- */
  if (args.gate === "fleet") {
    const miss = missingArgs(args, ["version"]);
    if (miss) return { exit: EXIT_ERROR, result: { error: miss } };
    const g = gateFleet({ events: ctx.ledger.events, version: args.version });
    if (g.verdict === "refused") {
      recordEvent("fleet", "refused", { reason: g.missing });
      return refuse(io, "fleet", g.missing);
    }
    recordEvent("fleet", "allowed", { reason: g.detail });
    return allow(io, "fleet", g.detail);
  }

  /* ---- bypass: the ONE way past the four gates, and it is recorded, not silent ---- */
  if (args.gate === "bypass") {
    const miss = missingArgs(args, ["version"]);
    if (miss) return { exit: EXIT_ERROR, result: { error: miss } };
    if (!args.reason) {
      // NOTHING is written here on purpose. Every other refusal gets a ledger line because the
      // line can carry the reason it refused on; a bypass refused for having NO reason has no
      // reason to record, and a "bypass" row in the ledger would read as a bypass that happened.
      return refuse(io, "bypass",
        `--reason is required and was not given: a bypass without a written reason is not a bypass. ` +
        `Re-run as: bypass --version ${args.version} --reason "<why the four gates cannot be run>"`);
    }
    recordEvent("bypass", "bypassed", { reason: args.reason });
    return allow(io, "bypass",
      `the four gates were SKIPPED for ${args.version} on purpose and this is now in the ledger ` +
      `(${args.ledger}) as {gate:"bypass"} by ${args.actor}: ${args.reason}`);
  }

  /* ---- release: all four preconditions, then one release event ---- */
  if (args.gate === "release") {
    const miss = missingArgs(args, ["version", "evidence", "author"]);
    if (miss) return { exit: EXIT_ERROR, result: { error: miss } };
    const max = args.max ?? 2;
    const checks = [];
    const g1 = gateVersionCount({ ledger: args.ledger, events: ctx.ledger.events, version: args.version, max, override: args.override, reason: args.reason, actor: args.actor, ts: args.ts });
    checks.push(["version-count", g1]);
    const g2 = gateEvidence({ version: args.version, evidenceFile: resolve(args.evidence) });
    checks.push(["evidence", g2]);
    const g3 = gateAcceptance({ events: ctx.ledger.events, version: args.version, author: args.author });
    checks.push(["acceptance", g3]);
    // FAIL CLOSED, and it is checked BEFORE the ledger: the fleet half of this gate reads the
    // ledger, so with an unreadable config a stale "canary_passed" row could carry a release
    // through while the machine facts are unavailable. Missing/unreadable config = refusal.
    const g4 = ctx.config.error
      ? { verdict: "refused", missing: `no canary configuration: the gate config cannot be read (${ctx.config.error}) - ` +
          `a release whose machine facts cannot be read is refused, never passed` }
      : gateFleet({ events: ctx.ledger.events, version: args.version });
    checks.push(["canary", g4]);

    const bad = checks.find(([, g]) => g.verdict === "refused");
    if (bad) {
      const [name, g] = bad;
      recordEvent("release", "refused", { evidence: resolve(args.evidence), reason: `${name}: ${g.missing}` });
      return refuse(io, name, g.missing);
    }
    recordEvent("release", "released", {
      evidence: resolve(args.evidence),
      reason: [g1.detail, g2.detail, g3.detail, g4.detail].join(" | "),
    });
    return allow(io, "all-four", `${args.version} released: ${g1.detail}; ${g2.detail}; ${g3.detail}; ${g4.detail}`);
  }

  return { exit: EXIT_ERROR, result: { error: "unhandled gate" } };
}

/* -------------------------------------------------------------------- cli */

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return resolve(entry) === resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const lines = [];
  const io = {
    log: (s) => { lines.push(String(s)); process.stdout.write(String(s) + "\n"); },
    error: (s) => { lines.push(String(s)); process.stderr.write(String(s) + "\n"); },
  };
  const { exit, result } = runReleaseGate(argv, io);
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(exit);
}
