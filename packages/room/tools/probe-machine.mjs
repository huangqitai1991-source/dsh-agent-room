#!/usr/bin/env node
/**
 * probe-machine.mjs -- print the ROOMFACTS block for THIS machine, using Node only.
 *
 * WHY NOT POWERSHELL: on 2026-09-15 the exec plane on one Windows node could not spawn PowerShell at
 * all (`powershell -NoProfile -Command "Get-Date"` -> rc=1, stderr "access denied") while the same
 * command worked on another Windows node. Node, however, is present wherever dsh runs -- so the
 * facts that decide "did the upgrade actually take?" must not depend on spawning PowerShell.
 *
 * WHAT IT MEASURES (no guessing; anything unreadable is printed as empty)
 *   installPath/installKind  where the plugin really is, and whether it is a symlink
 *   plugin                   the version in the INSTALLED package.json
 *   libHash                  md5 over path-sorted concatenated bytes of lib/** (the pnpm layout has
 *                            no lib/index.js, the entry is lib/host/*)
 *   libMtime                 newest mtime under lib/ -- when the bytes on disk were written
 *   hostPid/now/etimeSec     the process LISTENING on 3080 and how long it has been running, which
 *                            is what proves loadedAfterDisk (D-42: disk new, process still old)
 *   stateBytes/ackBlock/     the live plugin's own /state and its two shape markers
 *   activationBlock
 *
 * It is READ-ONLY: no install, no restart, no service change.
 * usage: node probe-machine.mjs
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, relative, sep } from "node:path";

/**
 * Run a helper and return its stdout.
 *
 * stdio goes to a FILE, never a pipe: a confined process may not hand a child a pipe (the same
 * boundary that made `spawnSync powershell` fail with EPERM and that D-39 needed the file-stdio fix
 * for). With a pipe, netstat/ps silently returned nothing and hostPid came out empty -- a missing
 * fact that looks exactly like "this machine has no host".
 */
function sh(cmd, args, timeout = 20000) {
  const tmp = join(tmpdir(), `roomprobe-${process.pid}-${Math.random().toString(16).slice(2)}.out`);
  let fd = null;
  try {
    fd = openSync(tmp, "w");
    spawnSync(cmd, args, { timeout, windowsHide: true, detached: false, stdio: ["ignore", fd, fd] });
    return readFileSync(tmp, "utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

function walk(dir, acc = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

function libHashAndMtime(pkgDir) {
  const libDir = join(pkgDir, "lib");
  if (!existsSync(libDir)) return { hash: "", mtime: "" };
  const files = walk(libDir)
    .map((abs) => ({ abs, rel: relative(pkgDir, abs).split(sep).join("/") }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const md5 = createHash("md5");
  let newest = 0;
  for (const f of files) {
    try { md5.update(readFileSync(f.abs)); } catch { /* an unreadable file cannot be hashed away */ }
    try { const m = statSync(f.abs).mtimeMs; if (m > newest) newest = m; } catch { /* ignore */ }
  }
  return { hash: md5.digest("hex"), mtime: newest ? Math.floor(newest / 1000) : "" };
}

function listenerPid() {
  const platform = process.platform;
  if (platform === "win32") {
    const out = sh("netstat", ["-ano"]);
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 4 && /:3080$/.test(cols[1])) return cols[cols.length - 1];
    }
    return "";
  }
  const lsof = sh("lsof", ["-nP", "-iTCP:3080", "-sTCP:LISTEN"]);
  for (const line of lsof.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 2 && /^\d+$/.test(cols[1])) return cols[1];
  }
  const ss = sh("ss", ["-ltnp"]);
  for (const line of ss.split(/\r?\n/)) {
    if (!/:3080\b/.test(line)) continue;
    const m = line.match(/pid=(\d+)/);
    if (m) return m[1];
  }
  return "";
}

/**
 * How long the process listening on 3080 has been running.
 *
 * Windows needs several attempts, and each one is a real measured outcome rather than a guess:
 *   wmic       -- absent on newer Windows builds;
 *   powershell -- on one studio node the exec plane cannot spawn PowerShell at all
 *                 (`powershell -NoProfile -Command "Get-Date"` -> rc=1 "access denied"), so it may
 *                 fail here too;
 *   tasklist   -- last resort: it prints a session/uptime column on some builds.
 * The source is printed, so a missing hostStart is visible as a fact about the machine rather than
 * silently becoming "the numbers are fine".
 */
function etimeSec(pid) {
  if (!pid) return { seconds: "", source: "no-pid" };
  if (process.platform === "win32") {
    const wmic = sh("wmic", ["process", "where", `processid=${pid}`, "get", "CreationDate", "/value"]);
    const m = wmic.match(/CreationDate=(\d{14})/);
    if (m) {
      const s = m[1];
      const start = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
      if (Number.isFinite(start)) return { seconds: Math.floor((Date.now() - start) / 1000), source: "wmic" };
    }
    const ps = sh("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){[int]((Get-Date)-$p.StartTime).TotalSeconds}else{''}`]);
    const psNum = ps.trim().match(/^\d+$/);
    if (psNum) return { seconds: Number(psNum[0]), source: "powershell" };
    const why = ps.trim().replace(/[\r\n]+/g, " ").slice(0, 80);
    return { seconds: "", source: `unknown (wmic absent; powershell: ${why || "no output"})` };
  }
  const out = sh("ps", ["-o", "etime=", "-p", pid]);
  const t = out.trim();
  if (!t) return { seconds: "", source: "ps gave nothing" };
  if (/^\d+$/.test(t)) return { seconds: Number(t), source: "ps-etimes" };
  const m = t.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return { seconds: "", source: "ps format not understood" };
  const [, d, h, mi, s2] = m;
  return { seconds: Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s2), source: "ps-etime" };
}

const HOME = homedir();
const candidates = [
  join(HOME, ".dsh", "profiles", "web", "node_modules", "dsh-agent-room"),
  join(HOME, ".dsh", "profiles", "node_modules", "dsh-agent-room"),
];
const pkgDir = candidates.find((c) => existsSync(c)) ?? "";

const lines = ["ROOMFACTS v1"];
lines.push(`probe=node/${process.platform}/${process.version}`);
if (!pkgDir) {
  lines.push("plugin=NOT-FOUND");
} else {
  let installKind = "dir";
  let realPath = pkgDir;
  try {
    if (lstatSync(pkgDir).isSymbolicLink()) installKind = "symlink";
  } catch { /* keep dir */ }
  try { realPath = realpathSync(pkgDir); } catch { /* keep the path as given */ }
  let version = "";
  try { version = String(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version ?? ""); } catch { /* ignore */ }
  const { hash, mtime } = libHashAndMtime(pkgDir);
  // WHEN THE BYTES LANDED cannot be read from file mtimes alone: npm rewrites every file mtime to a
  // fixed 1985-10-26 date so tarballs are reproducible (measured on a real node: libMtime=499162500,
  // i.e. 1985, on a package that was extracted minutes ago). The package DIRECTORY mtime is the real
  // extraction/install time, so the install time is the larger of the two. Without this, the D-42
  // check "hostStart >= install time" degenerates into always-true on any npm/tar-installed node.
  let pkgDirMtime = 0;
  try { pkgDirMtime = Math.floor(statSync(pkgDir).mtimeMs / 1000); } catch { /* ignore */ }
  const installMtime = Math.max(mtime || 0, pkgDirMtime);
  lines.push(`installPath=${pkgDir}`);
  lines.push(`installRealPath=${realPath}`);
  lines.push(`installKind=${installKind}`);
  lines.push(`plugin=${version}`);
  lines.push(`libHash=${hash}`);
  lines.push(`libMtime=${mtime}`);
  lines.push(`pkgDirMtime=${pkgDirMtime}`);
  lines.push(`installMtime=${installMtime}`);
}

const pid = listenerPid();
const started = etimeSec(pid);
lines.push(`hostPid=${pid}`);
lines.push(`now=${Math.floor(Date.now() / 1000)}`);
lines.push(`etimeSec=${started.seconds}`);
lines.push(`hostStartSource=${started.source}`);

try {
  const res = await fetch("http://127.0.0.1:3080/agent-room-api/state", { signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  lines.push(`stateBytes=${Buffer.byteLength(text, "utf8")}`);
  lines.push(`ackBlock=${/receiptsPosted/.test(text) ? 1 : 0}`);
  lines.push(`activationBlock=${/residentExecutable/.test(text) ? 1 : 0}`);
} catch (e) {
  lines.push(`stateError=${String(e && e.message ? e.message : e).slice(0, 120)}`);
}

process.stdout.write(lines.join("\n") + "\n");
process.exitCode = pkgDir && pid ? 0 : 1;
