#!/usr/bin/env node
/**
 * dsh-agent-room -- MACHINE FACTS (the measured layer the canary gate judges on)
 *
 * WHY THIS FILE EXISTS (defect D-45, 2026-09-15)
 *   The canary gate could never pass. `D:\dsh\release-gate.config.json` pointed its canary at
 *   `release-machines/<id>/version` -- a directory that was never created -- and left
 *   upgrade/postUpgradeVerify/rollback null, so `gateCanary()` refused at machineRecord() (:505)
 *   and again at the verify hook (:511). The only ways past it were to TYPE the answer into the
 *   version file by hand, or to write a bypass. A rule that always refuses and a rule that can be
 *   skipped are the same thing: neither constrains anything.
 *
 *   So the gate stops reading hand-typed facts and starts reading MEASURED ones. This tool is the
 *   only supported producer of those facts. It never installs, restarts or stops anything: it
 *   reads one line per machine and writes what it read.
 *
 * WHAT IS MEASURED, AND WHY EACH FIELD IS IN THE FILE
 *   pluginVersion     the version in the INSTALLED package.json -- what the machine would load
 *   insteadOf        installPath/installKind: it is a pnpm SYMLINK on both platforms. A `find -type
 *                     d` cannot see it (that mistake cost this tool its first empty probe).
 *   libHash           md5 over the CONCATENATED bytes of every file in lib/**, path-sorted. The
 *                     pnpm layout has NO lib/index.js (the entry is lib/host/*), so hashing one
 *                     file would miss the code that runs.
 *   libNewestMtime    the newest mtime under lib/ -- when the bytes on disk were last written.
 *   hostStart         when the running host process started (now - etime, read from ps/Get-Process).
 *   loadedAfterDisk   hostStart >= libNewestMtime. THIS IS D-42's DISCRIMINATOR: the upgrade script
 *                     reported success and the disk was new while the process still ran the old
 *                     plugin (the watchdog started the host ~1 s before `pnpm install` finished).
 *                     A version string cannot tell those apart; the two timestamps can.
 *   shape.ack /       the two LIVE markers a 0.1.46+/0.1.47+ plugin prints in its own /state
 *   shape.activation  (`receiptsPosted` / `residentExecutable`). Control frames like `[ack]` and
 *                     `[org:exec:result]` fooled two machines into looking alive today, so the check
 *                     is for markers inside the block the plugin itself renders -- never a substring
 *                     like "ack", which also matches "ackedSeqs".
 *
 * PROVENANCE, NOT JUST NUMBERS
 *   Every row carries `raw` (the verbatim reply), `rawMd5` and one `probedAt`. A machine that cannot
 *   be read is written as `unreachable:<reason>` and the tool exits 1 -- it NEVER writes a guessed
 *   row, because a guessed row is exactly what the gate was built to stop trusting.
 *
 * THE COMMANDS ARE NOT GUESSES
 *   TEMPLATE_POSIX below was executed against a live macOS node on 2026-09-15 and its verbatim
 *   output is kept at D:\dsh\_facts-proof\raw-huang-verified.txt (688 B, md5
 *   BC96A7815EFFD6D70F66C99B61302654). The Windows template is verified on this machine with
 *   `--local`; see --help. Payloads must stay short: the exec plane hard-kills at 30 s, and a
 *   whole-disk `find $HOME` looks identical to "the machine did not answer".
 *
 * usage: node tools/machine-facts.mjs [--config <file>] [--out <file>] [--machine <id>]...
 *                                     [--api <url>] [--timeout-ms <n>] [--from-raw <file>]
 *                                     [--raw-machine <id>] [--local] [--json] [--quiet]
 * exit: 0 every requested machine was probed | 1 at least one unreachable/malformed | 2 error
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const SCHEMA = "room-machine-facts/1";
export const DEFAULT_CONFIG = "D:\\dsh\\release-gate.config.json";
export const DEFAULT_OUT = "D:\\dsh\\machine-facts.json";
export const DEFAULT_API = "http://127.0.0.1:3080/agent-org-api/exec";
export const DEFAULT_TIMEOUT_MS = 30000;
/** The exec plane kills at 30 s. A facts file older than this may not carry a release. */
export const DEFAULT_MAX_AGE_SEC = 600;
export const HEADER = "ROOMFACTS v1";

/**
 * POSIX template -- VERIFIED LIVE (macOS 14.8.7, 2026-09-15). One line, no whole-disk scan.
 * It prints the header first so a truncated reply is detectably header-less rather than silently
 * short.
 */
export const TEMPLATE_POSIX = [
  'Q=$HOME/.dsh/profiles/web/node_modules/dsh-agent-room',
  '[ -e "$Q" ] || Q=$HOME/.dsh/profiles/node_modules/dsh-agent-room',
  `echo "${HEADER}"`,
  'echo "installPath=$(cd $Q && pwd -P)"',
  'echo "installKind=$([ -L "$Q" ] && echo symlink || echo dir)"',
  'echo "plugin=$(grep -m1 version $Q/package.json | cut -d: -f2 | tr -d " ,\\"")"',
  'echo "libHash=$(cd $Q && find lib -type f | LC_ALL=C sort | xargs cat | md5 -q)"',
  'L=$(find $Q/lib -type f | while read f; do stat -f %m "$f" 2>/dev/null || stat -c %Y "$f"; done | sort -n | tail -1)',
  'D=$(stat -f %m "$Q" 2>/dev/null || stat -c %Y "$Q")',
  'echo "libMtime=$L"',
  'echo "pkgDirMtime=$D"',
  'echo "installMtime=$(printf "%s\\n%s\\n" "$D" "$L" | sort -n | tail -1)"',
  'P=$(ps -Ao pid,command | grep "dsh web" | grep -v grep | cut -d" " -f1 | head -1)',
  'echo "hostPid=$P"',
  'echo "now=$(date +%s)"',
  'echo "etime=$(ps -p $P -o etime= | tr -d " ")"',
  'S=$(curl -s http://127.0.0.1:3080/agent-room-api/state)',
  'echo "stateBytes=$(printf %s "$S" | wc -c | tr -d " ")"',
  'echo "ackBlock=$(printf %s "$S" | grep -c receiptsPosted)"',
  'echo "activationBlock=$(printf %s "$S" | grep -c residentExecutable)"',
  // agent-org is a SECOND plugin with its own version and its own bytes on disk. It is probed here
  // in the same block (one round trip, one header) so the canary gate can judge an org release the
  // same way it judges a room release. Absent org = empty fields, never a fabricated version: a
  // missing measurement must be able to REFUSE downstream, not pass as "no change needed".
  'O=$HOME/.dsh/profiles/web/node_modules/dsh-agent-org',
  '[ -e "$O" ] || O=$HOME/.dsh/profiles/node_modules/dsh-agent-org',
  'OI=$([ -d "$O/lib" ] && echo lib || ([ -d "$O/src" ] && echo src || echo none))',
  'echo "orgHashDir=$OI"',
  'echo "orgPlugin=$([ -f "$O/package.json" ] && grep -m1 version $O/package.json | cut -d: -f2 | tr -d " ,\\"")"',
  'echo "orgLibHash=$([ "$OI" != none ] && cd $O && find $OI -type f | LC_ALL=C sort | xargs cat | md5 -q)"',
  'OL=$([ "$OI" != none ] && find $O/$OI -type f | while read f; do stat -f %m "$f" 2>/dev/null || stat -c %Y "$f"; done | sort -n | tail -1)',
  'echo "orgLibMtime=$OL"',
  'OD=$([ -e "$O" ] && (stat -f %m "$O" 2>/dev/null || stat -c %Y "$O"))',
  'echo "orgPkgDirMtime=$OD"',
].join("; ");

/**
 * Windows template -- one PowerShell line, same field names (`etimeSec` instead of `etime`, and the
 * parser takes either). Verified on this machine with `--local`; NOT yet driven through the exec
 * plane against a remote Windows node (none was online while this was written), which is stated as
 * an open gap instead of being called verified.
 */
export const TEMPLATE_WINDOWS = [
  "$Q=\"$env:USERPROFILE\\.dsh\\profiles\\web\\node_modules\\dsh-agent-room\"",
  "if(!(Test-Path $Q)){$Q=\"$env:USERPROFILE\\.dsh\\profiles\\node_modules\\dsh-agent-room\"}",
  "$it=Get-Item $Q",
  "$t=\"\"+$($it | Select-Object -ExpandProperty Target -ErrorAction SilentlyContinue)",
  `'${HEADER}'`,
  "'installPath='+$(if($t){\"\"+$t}else{(Resolve-Path $Q).Path})",
  "'installKind='+$(if($it.Attributes -band [IO.FileAttributes]::ReparsePoint){'symlink'}else{'dir'})",
  "'plugin='+((Get-Content \"$Q\\package.json\" -Raw | ConvertFrom-Json).version)",
  "$fs=Get-ChildItem \"$Q\\lib\" -Recurse -File | Sort-Object FullName",
  "$ms=New-Object IO.MemoryStream",
  "foreach($f in $fs){$b=[IO.File]::ReadAllBytes($f.FullName);$ms.Write($b,0,$b.Length)}",
  "$ms.Position=0",
  "'libHash='+(Get-FileHash -InputStream $ms -Algorithm MD5).Hash.ToLower()",
  "$lm=[int]([DateTimeOffset]::new(($fs|Sort-Object LastWriteTimeUtc|Select-Object -Last 1).LastWriteTimeUtc).ToUnixTimeSeconds())",
  "$dm=[int]([DateTimeOffset]::new($it.LastWriteTimeUtc).ToUnixTimeSeconds())",
  "'libMtime='+$lm",
  "'pkgDirMtime='+$dm",
  "'installMtime='+[Math]::Max($lm,$dm)",
  // The host process is identified BY ITS LISTENING PORT (judgement rule 3: never match on a
  // substring that can match the identifying process itself). Get-CimInstance is only a fallback --
  // on a confined host it is refused outright ("access denied"), which is how the first Windows run
  // lost hostPid and every field derived from it.
  "$l=(netstat -ano | Select-String ':3080' | Select-String 'LISTENING' | Select-Object -First 1)",
  "$p=0",
  "if($l){$p=[int](($l.ToString().Trim() -split '\\s+')[-1])}",
  "'hostPid='+$p",
  "'now='+[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()",
  "'etimeSec='+$(if($p){[int]((Get-Date)-(Get-Process -Id $p -ErrorAction SilentlyContinue).StartTime).TotalSeconds}else{''})",
  "$s=(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3080/agent-room-api/state).Content",
  "'stateBytes='+$s.Length",
  "'ackBlock='+([regex]::Matches($s,'receiptsPosted')).Count",
  "'activationBlock='+([regex]::Matches($s,'residentExecutable')).Count",
  // Same four fields as the POSIX template (see the note there): the org plugin's version, the hash
  // of its lib bytes, and when those bytes landed -- empty when org is not installed.
  "$O=\"$env:USERPROFILE\\.dsh\\profiles\\web\\node_modules\\dsh-agent-org\"",
  "if(!(Test-Path $O)){$O=\"$env:USERPROFILE\\.dsh\\profiles\\node_modules\\dsh-agent-org\"}",
  // agent-org ships src/ (lib/ is a gitignored build copy and is NOT in its files list), so the
  // hash covers lib when a build has one and src otherwise -- and WHICH one is printed, because a
  // hash whose subject is unnamed cannot be compared between machines.
  "$od='none'",
  "if(Test-Path \"$O\\lib\"){$od='lib'}elseif(Test-Path \"$O\\src\"){$od='src'}",
  "'orgHashDir='+$od",
  "'orgPlugin='+$(if(Test-Path \"$O\\package.json\"){(Get-Content \"$O\\package.json\" -Raw | ConvertFrom-Json).version}else{''})",
  "$ofs=@()",
  "if($od -ne 'none'){$ofs=@(Get-ChildItem \"$O\\$od\" -Recurse -File)}",
  "$oh=''",
  "if($ofs.Count -gt 0){$m=New-Object IO.MemoryStream;foreach($f in $ofs){$b=[IO.File]::ReadAllBytes($f.FullName);$m.Write($b,0,$b.Length)};$m.Position=0;$oh=(Get-FileHash -InputStream $m -Algorithm MD5).Hash.ToLower()}",
  "'orgLibHash='+$oh",
  "$ol=''",
  "if($ofs.Count -gt 0){$ol=[int]([DateTimeOffset]::new(($ofs|Sort-Object LastWriteTimeUtc|Select-Object -Last 1).LastWriteTimeUtc).ToUnixTimeSeconds())}",
  "'orgLibMtime='+$ol",
  "'orgPkgDirMtime='+$(if(Test-Path $O){[int]([DateTimeOffset]::new((Get-Item $O).LastWriteTimeUtc).ToUnixTimeSeconds())}else{''})",
].join("; ");

/**
 * The Windows command that actually goes over the wire: `-EncodedCommand` takes ONE base64 token,
 * so nothing in it can be re-quoted or stripped by whatever shell wraps the exec plane. This is not
 * cosmetic -- driving `powershell -Command <script>` with the script as an argument destroyed every
 * embedded quote when the template was first run, and PowerShell answered with a parser error
 * instead of facts (a silent empty reply, which is exactly how a broken probe looks like a dead
 * machine).
 */
export function windowsEncodedCommand(script = TEMPLATE_WINDOWS) {
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
}

/** The command to run ON a machine of this platform. */
export function remoteCommand(platform) {
  const p = String(platform ?? "").toLowerCase();
  if (p === "darwin" || p === "linux" || p === "macos" || p === "sh" || p === "posix") return TEMPLATE_POSIX;
  if (p === "windows" || p === "win32" || p === "win") return windowsEncodedCommand();
  return null;
}

const md5 = (text) => createHash("md5").update(text, "utf8").digest("hex");

/**
 * `ps -o etime=` prints MM:SS, HH:MM:SS or D-HH:MM:SS. The Windows template prints whole seconds.
 * Both are accepted; anything else yields null and the row is refused rather than guessed at.
 */
export function parseEtime(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === "") return null;
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, mi, se] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(se);
}

/**
 * Parse one machine's verbatim reply. A reply without the header is refused BY NAME: a truncated
 * reply and a reply from an older tool both land here, and neither may become a fact.
 */
export function parseRawBlock(text, { header = HEADER } = {}) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const at = lines.indexOf(header);
  if (at < 0) {
    const seen = lines.slice(0, 3).join(" / ").slice(0, 200);
    return { ok: false, reason: `no "${header}" header in the reply${seen ? ` (first lines: ${seen})` : ""}` };
  }
  const fields = {};
  for (const line of lines.slice(at + 1)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const required = ["installPath", "installKind", "plugin", "libHash", "libMtime", "hostPid", "now"];
  const missing = required.filter((k) => !fields[k]);
  if (missing.length > 0) return { ok: false, reason: `reply is missing field(s): ${missing.join(", ")}`, fields };
  return { ok: true, fields };
}

/** Fields -> a fact row. Everything derivable is derived here, once, so the gate cannot disagree. */
export function deriveFacts(fields, { id, address = null, via }) {
  const libMtime = Number(fields.libMtime);
  const pkgDirMtime = fields.pkgDirMtime === undefined ? null : Number(fields.pkgDirMtime);
  // WHEN THE BYTES LANDED is the larger of the package-directory mtime and the newest lib file mtime.
  // File mtimes alone are NOT usable: npm rewrites every file mtime to a fixed 1985 date for
  // reproducible tarballs, so a package extracted minutes ago reports libMtime=499162500 (measured on
  // a real node). With that value the D-42 check `hostStart >= install time` is always true, i.e. the
  // discriminator silently stops discriminating -- which is worse than not having it.
  const installMtime = Number.isFinite(pkgDirMtime)
    ? Math.max(Number.isFinite(libMtime) ? libMtime : 0, pkgDirMtime)
    : libMtime;
  const now = Number(fields.now);
  const etimeSec = parseEtime(fields.etimeSec ?? fields.etime);
  const hostStart = Number.isFinite(etimeSec) && Number.isFinite(now) ? now - etimeSec : null;
  const loadedAfterDisk = hostStart !== null && Number.isFinite(installMtime) ? hostStart >= installMtime : null;
  // The org plugin's half of the row, derived by the same rules (D-42 included: file mtimes are
  // npm-normalised, so "when the bytes landed" is the max of package-dir mtime and newest lib mtime).
  // orgVersion is intentionally null -- not "" and not the room version -- when org is absent.
  const orgVersion = fields.orgPlugin && String(fields.orgPlugin).trim() !== "" ? String(fields.orgPlugin).trim() : null;
  const orgLibHash = fields.orgLibHash && String(fields.orgLibHash).trim() !== "" ? String(fields.orgLibHash).trim() : null;
  const orgLibMtimeRaw = fields.orgLibMtime === undefined || String(fields.orgLibMtime).trim() === "" ? null : Number(fields.orgLibMtime);
  const orgLibMtime = Number.isFinite(orgLibMtimeRaw) ? orgLibMtimeRaw : null;
  const orgPkgDirMtimeRaw = fields.orgPkgDirMtime === undefined || String(fields.orgPkgDirMtime).trim() === "" ? null : Number(fields.orgPkgDirMtime);
  const orgPkgDirMtime = Number.isFinite(orgPkgDirMtimeRaw) ? orgPkgDirMtimeRaw : null;
  const orgInstallMtime = orgVersion === null && orgLibMtime === null
    ? null
    : (orgPkgDirMtime !== null ? Math.max(orgLibMtime ?? 0, orgPkgDirMtime) : orgLibMtime);
  const orgLoadedAfterDisk = hostStart !== null && Number.isFinite(orgInstallMtime) ? hostStart >= orgInstallMtime : null;
  return {
    id,
    address,
    via,
    pluginVersion: fields.plugin,
    installPath: fields.installPath,
    installKind: fields.installKind,
    libHash: fields.libHash,
    libMtime,
    libNewestMtime: libMtime,
    pkgDirMtime,
    installMtime,
    hostPid: /^\d+$/.test(String(fields.hostPid)) ? Number(fields.hostPid) : fields.hostPid,
    now,
    etime: fields.etime ?? null,
    etimeSec,
    hostStart,
    loadedAfterDisk,
    shape: { ack: Number(fields.ackBlock ?? 0) >= 1, activation: Number(fields.activationBlock ?? 0) >= 1 },
    stateOk: fields.stateBytes === undefined ? null : Number(fields.stateBytes) > 0,
    stateBytes: fields.stateBytes === undefined ? null : Number(fields.stateBytes),
    orgVersion,
    orgLibHash,
    orgHashDir: fields.orgHashDir && String(fields.orgHashDir).trim() !== "" ? String(fields.orgHashDir).trim() : null,
    orgLibMtime,
    orgPkgDirMtime,
    orgInstallMtime,
    orgLoadedAfterDisk,
  };
}

/** Read a facts file written by this tool. Returns {facts} or {error}; never throws. */
export function loadFacts(file) {
  if (!file) return { error: "no facts file was given" };
  if (!existsSync(file)) return { error: `there is no facts file at ${file}` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return { error: `${file} is not readable JSON: ${String(e && e.message ? e.message : e)}` };
  }
  if (!parsed || typeof parsed !== "object") return { error: `${file} is not a facts object` };
  return { facts: parsed, path: resolve(file) };
}

/** Wrap parsed fields in the schema, with provenance. */
export function factsFile({ probedAt, probedBy, source, mode, machines }) {
  return { schema: SCHEMA, probedAt, probedBy, source, mode, machines };
}

/**
 * A THIRD way to probe, for nodes where the exec plane cannot spawn PowerShell at all.
 *
 * Evidence (2026-09-15): `powershell -NoProfile -Command "Get-Date"` through the exec plane on one
 * Windows node returned rc=1 with stderr "access denied" while the same command worked on another
 * Windows node -- and `node -v` / `node -e` worked on BOTH. Node is present wherever dsh runs, so the
 * facts that decide "did the upgrade take?" must not require PowerShell.
 *
 * `probe-machine.mjs` (published next to this tool, also served from the studio file server) prints
 * the same ROOMFACTS block. Usage: `--via node` sends
 * `cd <dir> && curl.exe -s -o probe-machine.mjs <url> && node probe-machine.mjs`.
 */
export function nodeProbeCommand({ dir = "C:\\studio", url = "http://42.193.189.15:8090/probe-machine.mjs" } = {}) {
  return `cd ${dir} && curl.exe -s -o probe-machine.mjs ${url} && node probe-machine.mjs`;
}

async function probeOne(machine, { api, timeoutMs, via }) {
  const command = via === "node"
    ? nodeProbeCommand({ dir: machine.probeDir ?? "C:\\studio", url: machine.probeUrl })
    : remoteCommand(machine.platform);
  if (!command) {
    return { row: { id: machine.id, address: machine.address ?? null, via, unreachable: `no probe template for platform "${machine.platform}"` } };
  }
  if (!machine.agentId) {
    return { row: { id: machine.id, address: machine.address ?? null, via, unreachable: "the config entry has no agentId, so the exec plane cannot address it" } };
  }
  const body = JSON.stringify({ targetAgentId: machine.agentId, command });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let payload;
  try {
    const res = await fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctl.signal,
    });
    payload = await res.json();
  } catch (e) {
    clearTimeout(timer);
    const msg = String(e && e.message ? e.message : e);
    return { row: { id: machine.id, address: machine.address ?? null, via, unreachable:
      `the exec plane at ${api} did not answer (${msg})` } };
  }
  clearTimeout(timer);
  const data = payload && payload.data ? payload.data : null;
  if (!payload || payload.ok !== true || !data) {
    return { row: { id: machine.id, address: machine.address ?? null, via,
      unreachable: `the exec plane refused: ${JSON.stringify(payload).slice(0, 200)}` } };
  }
  if (data.timedOut === true) {
    return { row: { id: machine.id, address: machine.address ?? null, via,
      unreachable: `the probe command was killed at the ${Math.round(timeoutMs / 1000)}s limit (timedOut=true)` } };
  }
  const raw = String(data.stdout ?? "");
  return { row: null, raw, code: data.code, stderr: String(data.stderr ?? "") };
}

/**
 * Run the template on THIS machine.
 *
 * Two boundaries are respected here, both learned the hard way:
 *   - a confined process may not hand a child a PIPE (`spawnSync powershell` failed with EPERM
 *     until the child's stdio was pointed at a FILE, the same fix D-39 needed);
 *   - Windows goes through a temporary .ps1 plus `-File`, because passing a long script as an
 *     argument re-quotes it (driving the template with `-Command <script>` destroyed every embedded
 *     quote and PowerShell answered with a parser error -- an empty reply that looks exactly like a
 *     dead machine).
 */
function runLocal(machine) {
  const platform = machine.platform ?? process.platform;
  const isWin = String(platform).toLowerCase().startsWith("win");
  const stamp = `${process.pid}-${Date.now()}`;
  const scriptPath = join(tmpdir(), `room-machine-facts-${stamp}.ps1`);
  const logPath = join(tmpdir(), `room-machine-facts-${stamp}.log`);
  let fd = null;
  try {
    let cmd;
    let argv;
    if (isWin) {
      writeFileSync(scriptPath, TEMPLATE_WINDOWS + "\n", "utf8");
      cmd = "powershell";
      argv = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
    } else {
      cmd = "/bin/sh";
      argv = ["-c", TEMPLATE_POSIX];
    }
    fd = openSync(logPath, "w");
    const r = spawnSync(cmd, argv, { detached: false, windowsHide: true, timeout: 90000, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    fd = null;
    const raw = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    return { raw, code: r.status, stderr: r.error ? String(r.error.message) : "" };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { rmSync(scriptPath, { force: true }); } catch { /* ignore */ }
    try { rmSync(logPath, { force: true }); } catch { /* ignore */ }
  }
}

const USAGE = [
  "usage: node tools/machine-facts.mjs [options]",
  "",
  "  --config <file>        machine table (default " + DEFAULT_CONFIG + ")",
  "  --out <file>           where the facts are written (default " + DEFAULT_OUT + ")",
  "  --machine <id>         probe only this machine (repeatable; default: every machine in the config)",
  "  --api <url>            exec plane (default " + DEFAULT_API + ")",
  "  --timeout-ms <n>       how long to wait for one machine (default " + DEFAULT_TIMEOUT_MS + ")",
  "  --via <exec|node>      HOW to read a machine: the exec plane (default) or a Node probe",
  "                         sent to the machine and run there -- use node where the exec plane",
  "                         cannot spawn PowerShell (measured: rc=1 access denied on one node)",
  "  --from-raw <file>      OFFLINE: parse a raw reply from a file, execute NOTHING",
  "  --raw-machine <id>     which machine that raw reply belongs to (with --from-raw)",
  "  --raw-platform <p>     platform of that machine (with --from-raw; default windows)",
  "  --local                probe THIS machine by running its own template (no exec plane)",
  "  --json --quiet --help",
  "",
  "exit: 0 every requested machine was probed | 1 at least one unreachable (the facts file still",
  "      names the reason, and no guessed row is ever written) | 2 error",
].join("\n");

function parseArgv(argv) {
  const out = { machines: [], config: null, out: null, api: null, timeoutMs: null, fromRaw: null,
    rawMachine: null, rawPlatform: null, local: false, json: false, quiet: false, via: null };
  const takes = new Set(["--config", "--out", "--machine", "--api", "--timeout-ms", "--from-raw", "--raw-machine", "--raw-platform", "--via"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--json") { out.json = true; continue; }
    if (a === "--quiet") { out.quiet = true; continue; }
    if (a === "--local") { out.local = true; continue; }
    if (takes.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      i += 1;
      const key = { "--config": "config", "--out": "out", "--machine": "machines", "--api": "api",
        "--timeout-ms": "timeoutMs", "--from-raw": "fromRaw", "--raw-machine": "rawMachine", "--via": "via",
        "--raw-platform": "rawPlatform" }[a];
      if (key === "machines") out.machines.push(v); else out[key] = v;
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

export async function runMachineFacts(argv = [], io = console, { now = () => new Date() } = {}) {
  const args = parseArgv(argv);
  if (args.error) { io.error(`machine-facts: ${args.error}`); io.error(USAGE); return { exit: 2, result: { error: args.error } }; }
  if (args.help) { io.log(USAGE); return { exit: 0, result: { help: true } }; }

  const scannedConfig = args.config ?? process.env.DSH_RELEASE_GATE_CONFIG ?? DEFAULT_CONFIG;
  const configPath = args.rawMachine || args.local ? (args.config ? resolve(args.config) : null) : resolve(scannedConfig);
  const outPath = resolve(args.out ?? DEFAULT_OUT);
  const api = args.api ?? DEFAULT_API;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const via = args.via ?? "exec";
  if (via !== "exec" && via !== "node") {
    io.error(`machine-facts: --via must be exec or node, got ${via}`);
    return { exit: 2, result: { error: `unknown --via ${via}` } };
  }
  const stamp = now().toISOString();

  let machines = [];
  let configError = null;
  if (configPath) {
    if (!existsSync(configPath)) configError = `no config file at ${configPath}`;
    else {
      try {
        const cfg = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
        machines = Array.isArray(cfg.machines) ? cfg.machines : [];
      } catch (e) { configError = `${configPath} is not readable JSON: ${String(e && e.message ? e.message : e)}`; }
    }
  }
  if (args.machines.length > 0) machines = machines.filter((m) => args.machines.includes(m.id));
  // In --local / --from-raw the machine name is a LABEL for this run, not a lookup in the table:
  // a machine that is not in the config can still be probed locally, and demanding a config entry
  // for it would make the tool unusable exactly when the config is what is being fixed.
  if (args.machines.length > 0 && machines.length === 0 && !args.local && !args.fromRaw) {
    const err = `no machine in ${configPath ?? "(no config)"} matches ${args.machines.join(", ")}`;
    io.error(`machine-facts: ${err}`);
    return { exit: 2, result: { error: err } };
  }
  if (configError && !args.fromRaw && !args.local) {
    io.error(`machine-facts: ${configError}`);
    return { exit: 2, result: { error: configError } };
  }

  const rows = [];
  let unreachable = 0;

  if (args.fromRaw) {
    const id = args.rawMachine ?? args.machines[0] ?? (machines[0]?.id ?? "raw");
    const platform = args.rawPlatform ?? machines.find((m) => m.id === id)?.platform ?? "windows";
    const text = existsSync(args.fromRaw) ? readFileSync(args.fromRaw, "utf8") : null;
    if (text === null) {
      io.error(`machine-facts: there is no raw reply at ${args.fromRaw}`);
      return { exit: 2, result: { error: `no raw reply at ${args.fromRaw}` } };
    }
    const parsed = parseRawBlock(text);
    if (!parsed.ok) {
      rows.push({ id, address: null, via: "from-raw", unreachable: parsed.reason, raw: text, rawMd5: md5(text) });
      unreachable += 1;
    } else {
      rows.push({
        ...deriveFacts(parsed.fields, { id, via: "from-raw", address: null }),
        raw: text,
        rawMd5: md5(text),
      });
      if (!args.quiet) io.log(`probed ${id} (from raw, platform ${platform}): plugin=${rows[rows.length - 1].pluginVersion} loadedAfterDisk=${rows[rows.length - 1].loadedAfterDisk}`);
    }
  } else if (args.local) {
    const machine = machines.find((m) => m.id === (args.machines[0] ?? "")) ?? {
      id: args.machines[0] ?? "this-machine",
      platform: process.platform === "win32" ? "windows" : process.platform,
      address: null,
    };
    const res = runLocal(machine);
    if (res.error) {
      rows.push({ id: machine.id, address: null, via: "local", unreachable: res.error });
      unreachable += 1;
    } else {
      const parsed = parseRawBlock(res.raw);
      if (!parsed.ok) {
        rows.push({ id: machine.id, address: null, via: "local",
          unreachable: `${parsed.reason}${res.stderr ? ` (stderr: ${res.stderr.trim().slice(0, 200)})` : ""}`,
          raw: res.raw, rawMd5: md5(res.raw) });
        unreachable += 1;
      } else {
        rows.push({ ...deriveFacts(parsed.fields, { id: machine.id, via: "local", address: null }), raw: res.raw, rawMd5: md5(res.raw) });
        if (!args.quiet) io.log(`probed ${machine.id} (local): plugin=${rows[rows.length - 1].pluginVersion} loadedAfterDisk=${rows[rows.length - 1].loadedAfterDisk}`);
      }
    }
  } else {
    for (const machine of machines) {
      const res = await probeOne(machine, { api, timeoutMs, via: machine.probe ?? via });
      if (res.row) {
        rows.push(res.row);
        unreachable += 1;
        if (!args.quiet) io.error(`unreachable ${machine.id}: ${res.row.unreachable}`);
        continue;
      }
      const parsed = parseRawBlock(res.raw);
      if (!parsed.ok) {
        rows.push({ id: machine.id, address: machine.address ?? null, via,
          unreachable: `${parsed.reason}${res.stderr ? ` (stderr: ${res.stderr.trim().slice(0, 200)})` : ""}`,
          raw: res.raw, rawMd5: md5(res.raw) });
        unreachable += 1;
        if (!args.quiet) io.error(`unreachable ${machine.id}: ${parsed.reason}`);
        continue;
      }
      const row = { ...deriveFacts(parsed.fields, { id: machine.id, address: machine.address ?? null, via }), raw: res.raw, rawMd5: md5(res.raw) };
      rows.push(row);
      if (!args.quiet) {
        io.log(`probed ${machine.id}: plugin=${row.pluginVersion} pid=${row.hostPid} ` +
          `hostStart=${row.hostStart} libMtime=${row.libMtime} loadedAfterDisk=${row.loadedAfterDisk} ` +
          `shape(ack=${row.shape.ack},activation=${row.shape.activation})`);
      }
    }
  }

  let probedBy = "unknown";
  try {
    // A manual controller with a cleared timer, NOT AbortSignal.timeout(): a live timer here kept a
    // libuv handle open at exit and Node died with an assertion (!(handle->flags &
    // UV_HANDLE_CLOSING), src\win\async.c:76 / 0xC0000409) AFTER the facts file was written -- a
    // crash at exit is indistinguishable from a failed probe to anything that reads the exit code.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const res = await fetch("http://127.0.0.1:3080/agent-room-api/state", { signal: ctl.signal });
      const j = await res.json();
      if (j?.data?.identity?.nickname) probedBy = j.data.identity.nickname;
    } finally {
      clearTimeout(timer);
    }
  } catch { /* the prober's own name is not a fact the gate depends on */ }

  const file = factsFile({
    probedAt: stamp,
    probedBy,
    source: args.fromRaw ? `from-raw:${resolve(args.fromRaw)}` : (args.local ? "local" : api),
    mode: args.fromRaw ? "from-raw" : (args.local ? "local" : "execute"),
    machines: rows,
  });
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(file, null, 2) + "\n", "utf8");
  } catch (e) {
    const err = `the facts file ${outPath} could not be written: ${String(e && e.message ? e.message : e)}`;
    io.error(`machine-facts: ${err}`);
    return { exit: 2, result: { error: err } };
  }
  io.log(`probed=${rows.length - unreachable} unreachable=${unreachable} -> ${outPath} (schema ${SCHEMA}, probedAt ${stamp})`);
  if (unreachable > 0) {
    io.error(`machine-facts: ${unreachable} machine(s) could NOT be probed; the reasons are in ${outPath}. ` +
      `No guessed row was written -- a machine whose facts are unknown cannot carry a release.`);
  }
  return { exit: unreachable > 0 ? 1 : 0, result: { probed: rows.length - unreachable, unreachable, out: outPath, facts: file } };
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return resolve(entry) === resolve(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const io = {
    log: (s) => process.stdout.write(String(s) + "\n"),
    error: (s) => process.stderr.write(String(s) + "\n"),
  };
  const { exit, result } = await runMachineFacts(argv, io);
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  // process.exitCode, never process.exit(): an abrupt exit while handles are still closing tripped a
  // libuv assertion (status 0xC0000409) after a SUCCESSFUL probe, which would read as "the probe
  // failed" to every caller that checks the exit code.
  process.exitCode = exit;
}
