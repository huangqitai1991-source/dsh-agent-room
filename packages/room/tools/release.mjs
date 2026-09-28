#!/usr/bin/env node
/**
 * dsh-agent-room -- THE RELEASE COMMAND (the only supported way to produce and publish a release)
 *
 * WHY THIS FILE EXISTS
 *   The four release gates (tools/release-gate.mjs) can refuse, but until 0.1.51 only the
 *   `upgrade-studio` launcher called them. Producing an artifact was still a manual act: `npm pack`
 *   by hand, `scp` it to the file server, install it by hand on a box. Not one of those steps ran a
 *   gate -- they did not even ask for one. A gate that guards only the launcher guards nothing about
 *   the ARTIFACT, and the artifact is the thing that ships. This file is the door the artifact now
 *   has to come through.
 *
 *   node tools/release.mjs --version <v> --evidence <raw-output-file> [--author <who>]
 *
 * ORDER IS THE MECHANISM -- there is no way to get a .tgz out of this command without the gates:
 *   1. the four gates run FIRST, through the `release` composition entry of tools/release-gate.mjs
 *      (version-count / evidence / acceptance / canary); a refusal is written to the ledger by the
 *      gate itself, and this command writes NOTHING and touches nothing;
 *   2. ONLY IF they allow: `npm pack` produces <name>-<version>.tgz;
 *   3. the artifact is uploaded (scp by default) and READ BACK OVER HTTP -- md5 and byte count --
 *      so "uploaded" means "the server really serves these bytes";
 *   4. the publish row {ts, version, gate:"publish", verdict, artifact, md5, actor} goes into the
 *      ledger, so a file sitting on the server can be traced to the gate run that allowed it.
 *
 *   A REFUSAL PACKS NOTHING AND UPLOADS NOTHING. That is not "it returned false": the pack step is
 *   textually AFTER the gate step, so a refused run never reaches it. A failed upload or a failed
 *   md5 read-back DELETES the artifact again and writes NO publish row -- an artifact that cannot
 *   be traced to a passing gate run does not stay on disk or on the server.
 *
 * WHAT IS NOT SUPPORTED (and cannot be made traceable after the fact)
 *   `npm pack` by hand, copying the .tgz to the file server by hand, or installing by hand
 *   (`dsh plugin --profile web add <file>.tgz`) bypass ALL FOUR GATES. Nothing here can stop that;
 *   it is why this command exists and why it is the documented path. Unsupported artifacts carry no
 *   evidence, no acceptance, no canary result and no ledger row.
 *
 * PROMOTION: --candidate <tgz> -- publishing the bytes a gate already saw
 *   A candidate is packed, uploaded to a shelf, installed on a canary and probed. The copy that ships
 *   must be THE SAME BYTES -- but "re-pack the same tree and hope npm is deterministic" is not that
 *   claim, it is a coincidence that holds until it does not, and both tarballs would carry the same
 *   version number while differing in content. With --candidate NO pack happens: the file you name
 *   must match the ledger's {gate:"candidate"} row for the version in md5 AND byte count, or the run
 *   refuses and nothing is uploaded. So "the published artifact is the canaried artifact" stops being
 *   a coincidence and becomes a precondition of publishing.
 *
 * WHAT THIS COMMAND NEVER DOES
 *   It never installs, stops or restarts anything -- publishing is not installing. Installing is the
 *   upgrade launcher's job, and its pre-flight runs the same four gates. The launcher's read-only
 *   modes (-Verify / -WatchdogOnly) stay ungated ON PURPOSE: they publish nothing.
 *
 * EXIT CODES
 *   0  PUBLISHED  (gates allowed; artifact packed, uploaded, md5-verified over HTTP, recorded)
 *   1  REFUSED    (the gates refused, or package.json and --version disagree: nothing was packed)
 *   2  ERROR      (cannot pack / upload / verify / record: nothing is left published)
 *
 * Run directly:  node tools/release.mjs --version 0.1.51 --evidence D:\dsh\evidence-0.1.51.json
 */

import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { DEFAULT_CONFIG, DEFAULT_LEDGER, appendEvent, readLedger, runReleaseGate } from "./release-gate.mjs";

export const EXIT_PUBLISHED = 0;
export const EXIT_REFUSED = 1;
export const EXIT_ERROR = 2;

export const DEFAULT_REMOTE = "ubuntu@42.193.189.15:/home/ubuntu/studio-files/";
export const DEFAULT_HTTP_BASE = "http://42.193.189.15:8090";
export const DEFAULT_ASKPASS = "D:\\dsh\\_askpass.cmd";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);

const USAGE = [
  "usage: node tools/release.mjs [--version <v>] --evidence <file> [options]",
  "",
  "the gates decide first; only then is anything packed, uploaded and recorded:",
  "  --version <v>       version to publish (default: package.json of --pack-root)",
  "  --evidence <file>   the RAW gate output for this version (required; prose is not evidence)",
  "  --author <who>      the author of this version (default: the current user)",
  "",
  "gate inputs (forwarded to tools/release-gate.mjs):",
  "  --ledger <file>     default D:\\dsh\\release-ledger.jsonl (also the publish row's home)",
  "  --config <file>     default D:\\dsh\\release-gate.config.json",
  "  --max <n> --override --reason <why>    version-count quota controls (reason is recorded)",
  "",
  "publishing:",
  "  --candidate <tgz>   PROMOTE these exact bytes instead of packing: they must match the ledger's",
  "                      {gate:\"candidate\"} row for --version (md5 AND bytes) or the run refuses.",
  "                      No `npm pack` happens, so published == canaried by construction.",
  "  --pack-root <dir>   the tree to pack (default: this repository; ignored with --candidate)",
  "  --pack-dir <dir>    where the .tgz is written (default: this repository)",
  "  --cache <dir>       npm's cache dir (only needed when npm's default cache is not writable,",
  "                      e.g. inside a confined sandbox); DSH_RELEASE_NPM_CACHE also works",
  "  --transport <spec>  scp (default) | local:<dir>",
  "  --remote <target>   default " + DEFAULT_REMOTE,
  "  --http-base <url>   default " + DEFAULT_HTTP_BASE + " (md5 read-back; 'none' is refused for scp)",
  "  --askpass <file>    default " + DEFAULT_ASKPASS,
  "exit: 0 published | 1 refused (nothing packed) | 2 error (nothing left published)",
].join("\n");

/* ------------------------------------------------------------------ helpers */

let runSeq = 0;

/**
 * Run one helper command with FILE stdio (never a pipe). A confined process cannot reliably hand a
 * child a pipe -- the same reason the gate uses file stdio (D-39) -- and `stdin: "ignore"` gives the
 * child an empty stdin (NUL) without a pipe, which is what the non-interactive ssh recipe needs.
 */
function runCommand(cmd, args, { cwd = null, env = process.env, timeoutMs = 600000 } = {}) {
  const runDir = process.env.DSH_RELEASE_RUN_DIR ?? "D:\\dsh\\_release-gate-run";
  let outFile;
  try {
    mkdirSync(runDir, { recursive: true });
    outFile = join(runDir, `publish-${process.pid}-${(runSeq += 1)}.log`);
  } catch (e) {
    return { ok: false, status: null, output: "", error: `cannot prepare the run directory ${runDir}: ${String(e.message)}` };
  }
  let fd = null;
  try { fd = openSync(outFile, "w"); } catch (e) {
    return { ok: false, status: null, output: "", error: `cannot open ${outFile}: ${String(e.message)}` };
  }
  let r;
  try {
    r = spawnSync(cmd, args, { cwd, env, timeout: timeoutMs, windowsHide: true, detached: false, stdio: ["ignore", fd, fd] });
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  let text = "";
  try { text = readFileSync(outFile, "utf8"); } catch { /* no output is a valid outcome */ }
  try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
  if (r.error) return { ok: false, status: null, output: text, error: String(r.error.message) };
  return { ok: r.status === 0, status: r.status, output: text, signal: r.signal ?? null };
}

function md5Of(file) {
  const buf = readFileSync(file);
  return { md5: createHash("md5").update(buf).digest("hex"), bytes: buf.length };
}

/**
 * THE PROMOTION DECISION, pure: may THESE bytes become the published artifact of THIS version?
 *
 * Inputs are only what a caller can observe -- the file's own md5/byte count, the ledger's staged
 * candidate row, and whether the artifact path is already occupied. Nothing here packs, uploads or
 * writes, so the four ways to get it wrong are decidable in a test rather than by a nervous human
 * comparing two md5s by eye at 03:00.
 *
 * The refusals are separate on purpose: "no candidate row" (a promotion with nothing staged) and
 * "these are not those bytes" (the bytes drifted) are different failures with different fixes, and a
 * single "refused" would hide which one happened.
 */
export function promoteDecision({ candPath, cand, staged, version, ledger, artifact, artifactExists }) {
  if (!staged) {
    return { ok: false, code: EXIT_REFUSED,
      line: `the ledger ${ledger} has no {gate:"candidate"} row for ${version}: a promotion must publish bytes a gate run already staged -- re-packing is exactly what --candidate exists to prevent` };
  }
  if (String(staged.md5 ?? "") !== cand.md5 || Number(staged.bytes) !== cand.bytes) {
    return { ok: false, code: EXIT_REFUSED,
      line: `${candPath} is md5 ${cand.md5} / ${cand.bytes} bytes, but the ledger's candidate row for ${version} is md5 ${staged.md5 ?? "(none)"} / ${staged.bytes ?? "(none)"} bytes: these are NOT the bytes any gate was run on` };
  }
  const samePath = candPath === artifact;
  if (artifactExists && !samePath) {
    return { ok: false, code: EXIT_REFUSED,
      line: `${artifact} already exists and is not the candidate: publishing over it would ship bytes no gate run saw (move it aside, or pass --candidate ${artifact})` };
  }
  return { ok: true, samePath, copy: !samePath,
    note: samePath ? "the candidate already sits at the published path" : `copied to ${artifact} without repacking` };
}

/**
 * WHICH staged row is authoritative: the LAST {gate:"candidate"} row for THIS version. A candidate
 * that was staged twice (say, re-packed after a fix) must promote the bytes of the newest staging --
 * an "any matching row" rule would let a stale row bless bytes nobody re-ran anything on.
 */
export function stagedCandidateRow(events, version) {
  return (events ?? []).filter((e) => e && e.gate === "candidate" && e.version === version).slice(-1)[0] ?? null;
}

function defaultActor() {
  try { return userInfo().username || "unknown"; } catch { return "unknown"; }
}

const BOOL_FLAGS = new Set(["override", "help"]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (BOOL_FLAGS.has(camel)) { out[camel] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `--${key} needs a value` };
    out[camel] = value;
    i += 1;
  }
  return out;
}

function refuse(code, line) {
  process.stderr.write(`RELEASE REFUSED (exit ${code}): ${line}\n`);
  process.stderr.write("NOTHING PACKED, NOTHING UPLOADED: the pack step was never reached, no .tgz exists and no file on the server was touched.\n");
  return code;
}

/** npm buries the decisive line (code / path) in a wall of text: surface those, not the tail. */
function npmErrorBrief(output) {
  const lines = String(output ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const interesting = lines.filter((l) => /^npm (error|ERR!)/i.test(l)).slice(0, 3);
  return (interesting.length > 0 ? interesting : lines.slice(-3)).join(" | ") || "no output";
}

/** npm's own entry point, run as `node npm-cli.js` so no .cmd shim (and no shell) is involved. */
function npmCli() {
  const explicit = process.env.DSH_RELEASE_NPM;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** The version inside the tarball must be the version we gated. null = could not be read. */
function innerVersion(artifact) {
  const r = runCommand("tar", ["-xOf", artifact, "package/package.json"], { timeoutMs: 60000 });
  if (!r.ok) return { version: null, why: r.error ?? (r.output.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? `tar exited ${r.status}`) };
  try { return { version: String(JSON.parse(r.output).version ?? ""), why: null }; }
  catch (e) { return { version: null, why: `the tarball's package.json is not JSON: ${String(e.message)}` }; }
}

function sshEnv(askpass) {
  return { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY ?? "localhost:0" };
}

/* --------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { process.stderr.write(USAGE + "\n"); return refuse(EXIT_ERROR, args.error); }
  if (args.help) { process.stdout.write(USAGE + "\n"); return EXIT_PUBLISHED; }
  if (!args.evidence) {
    process.stderr.write(USAGE + "\n");
    return refuse(EXIT_ERROR, "missing required argument: --evidence <file> (the raw gate output for this version; a summary sentence is not evidence)");
  }

  /* ---- what exactly is being published ---- */
  const packRoot = resolve(args.packRoot ?? REPO);
  const packDir = resolve(args.packDir ?? REPO);
  const pkgFile = join(packRoot, "package.json");
  if (!existsSync(pkgFile)) return refuse(EXIT_ERROR, `no package.json at ${pkgFile}: there is nothing to publish from ${packRoot}`);
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgFile, "utf8")); }
  catch (e) { return refuse(EXIT_ERROR, `${pkgFile} is not readable JSON: ${String(e.message)}`); }
  const pkgName = String(pkg.name ?? "").replace(/^@[^/]+\//, "");
  if (!pkgName) return refuse(EXIT_ERROR, `${pkgFile} has no name, so the artifact has no name`);

  const version = String(args.version ?? pkg.version ?? "");
  if (!/^[0-9][0-9A-Za-z.\-]*$/.test(version)) return refuse(EXIT_ERROR, `no usable version: --version ${args.version ?? "(none)"} and package.json says ${pkg.version ?? "(none)"}`);
  if (args.version && args.version !== pkg.version) {
    // Publishing a version the tree does not claim is publishing a DIFFERENT build than the gates
    // read. That is the whole defect this command exists to prevent, so it is a refusal, not a flag.
    return refuse(EXIT_REFUSED,
      `--version ${args.version} but ${pkgFile} says ${pkg.version}: bump package.json first, or the artifact would not be the tree the gates looked at`);
  }

  const artifactName = `${pkgName}-${version}.tgz`;
  const artifact = join(packDir, artifactName);
  const evidence = resolve(args.evidence);
  const ledger = resolve(args.ledger ?? process.env.DSH_RELEASE_LEDGER ?? DEFAULT_LEDGER);
  const config = resolve(args.config ?? process.env.DSH_RELEASE_GATE_CONFIG ?? DEFAULT_CONFIG);
  const author = args.author ?? defaultActor();
  const actor = args.actor ?? defaultActor();

  /* ---- 1. THE FOUR GATES, ALWAYS, BEFORE ANYTHING ELSE ---- */
  const gateArgv = [
    "release", "--version", version, "--evidence", evidence, "--author", author,
    "--ledger", ledger, "--config", config, "--actor", actor,
  ];
  if (args.max !== undefined) gateArgv.push("--max", String(args.max));
  if (args.override) gateArgv.push("--override");
  if (args.reason) gateArgv.push("--reason", args.reason);

  const io = {
    log: (s) => process.stdout.write(String(s) + "\n"),
    error: (s) => process.stderr.write(String(s) + "\n"),
  };
  const gateRun = runReleaseGate(gateArgv, io);
  if (gateRun.exit !== EXIT_PUBLISHED) {
    process.stderr.write(`RELEASE REFUSED (exit ${gateRun.exit}): the four gates refused ${version}; see the ledger row they wrote in ${ledger}\n`);
    process.stderr.write("NOTHING PACKED, NOTHING UPLOADED: the pack step is never reached on a refusal, so no .tgz was produced and no file on the server was touched.\n");
    return gateRun.exit;
  }

  /* ---- guards that only make sense once the gates allow: never ship over a shipped file ---- */
  const candidateArg = args.candidate ? resolve(args.candidate) : null;
  if (existsSync(artifact) && candidateArg !== artifact) {
    return refuse(EXIT_REFUSED,
      `${artifact} already exists: republishing over it would ship bytes no gate run saw (move it aside, pass --candidate ${artifact} to promote exactly those bytes, or publish a new version)`);
  }
  const known = readLedger(ledger);
  if (known.events.some((e) => e.gate === "publish" && e.version === version)) {
    return refuse(EXIT_REFUSED,
      `the ledger ${ledger} already has a publish row for ${version}: a second publish is not a release, it is an overwrite`);
  }

  /* ---- 2. how it will be published must be decidable BEFORE anything is packed ---- */
  const transportSpec = String(args.transport ?? "scp");
  const httpBase = String(args.httpBase ?? DEFAULT_HTTP_BASE);
  const kind = transportSpec.startsWith("local:") ? "local" : transportSpec === "scp" ? "scp" : null;
  if (!kind) return refuse(EXIT_ERROR, `unknown --transport ${transportSpec} (use scp or local:<dir>): nothing was packed`);
  if (httpBase === "none" && kind === "scp") {
    // An upload nobody can read back is an unverified upload. Decided here, before the pack, so a
    // misconfigured publish does not even leave a .tgz behind to be mistaken for a shippable file.
    return refuse(EXIT_ERROR, "--http-base none with --transport scp: an upload that is never read back is not verified, so it is refused before anything is sent");
  }
  const remoteDir = kind === "scp" ? String(args.remote ?? DEFAULT_REMOTE) : transportSpec.slice("local:".length);

  /* ---- 3. PACK -- or PROMOTE the staged bytes, never both (only now) ---- */
  let local;
  let promoted = null;
  if (candidateArg) {
    // A promotion never packs: the crate is skipped entirely, so the published bytes and the canaried
    // bytes cannot drift apart. The only thing checked here is that a gate run really saw these bytes.
    if (!existsSync(candidateArg)) return refuse(EXIT_ERROR, `--candidate ${candidateArg} does not exist: there are no bytes to promote`);
    const cand = md5Of(candidateArg);
    const staged = stagedCandidateRow(known.events, version);
    const verdict = promoteDecision({ candPath: candidateArg, cand, staged, version, ledger, artifact, artifactExists: existsSync(artifact) });
    if (!verdict.ok) return refuse(verdict.code, verdict.line);
    if (verdict.copy) copyFileSync(candidateArg, artifact);
    local = md5Of(artifact);
    if (local.md5 !== cand.md5 || local.bytes !== cand.bytes) {
      if (verdict.copy) rmSync(artifact, { force: true });
      return finishedError(`the artifact at ${artifact} reads ${local.md5} / ${local.bytes} bytes but the candidate is ${cand.md5} / ${cand.bytes}: the published file is not the candidate, so nothing was uploaded`);
    }
    promoted = { md5: cand.md5, bytes: cand.bytes, path: candidateArg, commit: staged.commit ?? null };
    process.stdout.write(`PROMOTED ${artifactName}  ${local.bytes} bytes  md5 ${local.md5}  (no repack; ${verdict.note})\n`);
  } else {
  const npm = npmCli();
  if (!npm) return refuse(EXIT_ERROR, "cannot find npm's own entry point (node_modules/npm/bin/npm-cli.js); set DSH_RELEASE_NPM to point at it");
  const npmCache = args.cache ?? process.env.DSH_RELEASE_NPM_CACHE ?? null;
  mkdirSync(packDir, { recursive: true });
  const packArgs = ["pack", "--pack-destination", packDir];
  if (npmCache) packArgs.push("--cache", resolve(npmCache));
  packArgs.push(packRoot);
  const pack = runCommand(process.execPath, [npm, ...packArgs], { cwd: packRoot, timeoutMs: 900000 });
  if (!pack.ok || !existsSync(artifact)) {
    return refuse(EXIT_ERROR,
      `npm pack did not produce ${artifactName} (exit ${pack.status}${pack.error ? `, ${pack.error}` : ""}): ${npmErrorBrief(pack.output)}`);
  }
  local = md5Of(artifact);
  process.stdout.write(`PACKED   ${artifactName}  ${local.bytes} bytes  md5 ${local.md5}\n`);
  }

  const inner = innerVersion(artifact);
  if (inner.version && inner.version !== version) {
    rmSync(artifact, { force: true });
    process.stderr.write(`RELEASE ERROR (exit ${EXIT_ERROR}): the packed artifact contains package.json version ${inner.version}, not ${version}: it was deleted again, nothing was uploaded, no publish row was written.\n`);
    return EXIT_ERROR;
  }
  if (!inner.version) process.stdout.write(`NOTE     could not read the tarball's inner version (${inner.why}); the artifact name and package.json agree\n`);

  /* ---- 4. UPLOAD, THEN READ IT BACK ---- */
  let uploaded = null;
  if (kind === "scp") {
    const askpass = String(args.askpass ?? process.env.DSH_RELEASE_ASKPASS ?? DEFAULT_ASKPASS);
    if (!existsSync(askpass)) {
      rmSync(artifact, { force: true });
      return finishedError(`no SSH askpass helper at ${askpass}: this command never prompts on a terminal, so it cannot upload without one (--askpass <file>)`);
    }
    const r = runCommand("scp", ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL", "-o", "LogLevel=ERROR", artifact, remoteDir], { env: sshEnv(askpass), timeoutMs: 600000 });
    if (!r.ok) {
      rmSync(artifact, { force: true });
      return finishedError(`scp to ${remoteDir} failed (exit ${r.status}${r.error ? `, ${r.error}` : ""}): ${r.output.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" | ") || "no output"}`);
    }
    uploaded = { where: remoteDir, kind };
  } else {
    mkdirSync(remoteDir, { recursive: true });
    const target = join(remoteDir, artifactName);
    copyFileSync(artifact, target);
    const back = md5Of(target);
    if (back.md5 !== local.md5 || back.bytes !== local.bytes) {
      rmSync(artifact, { force: true });
      rmSync(target, { force: true });
      return finishedError(`the copy at ${target} does not match the artifact (${back.md5}/${back.bytes} vs ${local.md5}/${local.bytes})`);
    }
    uploaded = { where: target, kind };
  }
  process.stdout.write(`UPLOADED ${artifactName} -> ${uploaded.where}\n`);

  const url = `${httpBase.replace(/\/+$/, "")}/${artifactName}`;
  let served = null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    served = { md5: createHash("md5").update(buf).digest("hex"), bytes: buf.length };
  } catch (e) {
    await unpublish(artifact, artifactName, remoteDir, kind, args);
    return finishedError(`the uploaded artifact could not be read back from ${url}: ${String(e.message ?? e)}`);
  }
  if (served.md5 !== local.md5 || served.bytes !== local.bytes) {
    await unpublish(artifact, artifactName, remoteDir, kind, args);
    return finishedError(`the file served at ${url} is NOT the artifact: server md5 ${served.md5} / ${served.bytes} bytes vs local ${local.md5} / ${local.bytes}`);
  }
  process.stdout.write(`VERIFIED ${url} serves md5 ${served.md5} (${served.bytes} bytes), byte-identical to the packed artifact\n`);

  /* ---- 4. RECORD IT: a shipped file must be traceable to the gate run that allowed it ---- */
  const row = {
    ts: new Date().toISOString(),
    version,
    gate: "publish",
    verdict: "allowed",
    actor,
    evidence,
    artifact: artifactName,
    md5: local.md5,
    bytes: local.bytes,
    url,
    upload: uploaded.where,
    candidate: promoted,
    reason: promoted
      ? `the four gates (version-count / evidence / acceptance / canary) allowed ${version}; PROMOTED the candidate ${promoted.md5} the ledger staged (no repack: published bytes are the canaried bytes${promoted.commit ? `, candidate commit ${promoted.commit}` : ""}), uploaded and md5-verified over HTTP by node tools/release.mjs`
      : `the four gates (version-count / evidence / acceptance / canary) allowed ${version}; packed, uploaded and md5-verified over HTTP by node tools/release.mjs`,
  };
  let sizeBefore = 0;
  try { sizeBefore = existsSync(ledger) ? statSync(ledger).size : 0; } catch { sizeBefore = 0; }
  try {
    const w = appendEvent(ledger, row);
    if (w.sizeAfter <= sizeBefore) throw new Error(`the ledger did not grow (${sizeBefore} -> ${w.sizeAfter})`);
  } catch (e) {
    await unpublish(artifact, artifactName, remoteDir, kind, args);
    return finishedError(`the artifact was uploaded but the publish row could not be written to ${ledger}: ${String(e.message ?? e)}`);
  }

  process.stdout.write(`RECORDED {gate:"publish"} row in ${ledger} (artifact ${artifactName}, md5 ${local.md5}${promoted ? `, candidate ${promoted.md5}` : ""})\n`);
  if (promoted) process.stdout.write(`PROMOTION PROVEN: ${artifactName} served at ${url} is byte-identical to the staged candidate ${promoted.md5} -- no pack step ran at all\n`);
  process.stdout.write(`RELEASE PUBLISHED: ${artifactName} md5 ${local.md5} - ${url}\n`);
  return EXIT_PUBLISHED;
}

/** Best-effort un-publish: the artifact must not stay where no publish row names it. */
async function unpublish(artifact, artifactName, remoteDir, kind, args) {
  rmSync(artifact, { force: true });
  if (kind === "local") rmSync(join(remoteDir, artifactName), { force: true });
  if (kind === "scp") {
    const askpass = String(args.askpass ?? process.env.DSH_RELEASE_ASKPASS ?? DEFAULT_ASKPASS);
    if (existsSync(askpass)) {
      const target = /:([^:]*)$/.exec(remoteDir);
      if (target) {
        const host = remoteDir.slice(0, remoteDir.indexOf(":"));
        runCommand("ssh", ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL", "-o", "LogLevel=ERROR", host, `rm -f ${target[1]}${artifactName}`], { env: sshEnv(askpass), timeoutMs: 120000 });
      }
    }
  }
}

function finishedError(line) {
  process.stderr.write(`RELEASE ERROR (exit ${EXIT_ERROR}): ${line}\n`);
  process.stderr.write("NOTHING IS LEFT PUBLISHED: the local artifact was deleted again and no publish row was written.\n");
  return EXIT_ERROR;
}

// RUN as a command, IMPORT as a library. Without this guard the module body would execute a release
// with whatever argv the importer happens to have -- so a test that merely reads the promotion rule
// would run the four gates and try to publish something. The rule must be testable without firing it.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  process.exit(await main());
}
export { main };
