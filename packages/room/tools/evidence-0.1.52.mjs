#!/usr/bin/env node
/**
 * evidence-0.1.52.mjs — the discriminating assertion for the 0.1.52 release.
 *
 * WHY THIS EXISTS
 *   The house rule is "evidence before release": a RAW run in which the NEW build passes and the OLD
 *   build FAILS the same assertions. 0.1.52 carries two fixes with a mechanical discriminator each:
 *     A. the room dock can no longer be registered twice (idempotent install + a render error boundary);
 *     B. every config write goes through the one atomic writer (five bare `writeFile` call sites removed).
 *   So both cells scan the BUILT files (lib/**), which are what actually ships, not the sources.
 *
 *   Written in Node, and scanning bytes as UTF-8: on 2026-09-17 a PowerShell check of a UTF-8 file
 *   reported "the old build has no 新增部门" because PS 5.1 decoded it as GBK. A scan whose decoding is
 *   wrong is not a scan.
 *
 * usage: node tools/evidence-0.1.52.mjs --new <repo dir> --old <extracted package dir> [--json]
 * exit : 0 the new build passes | 1 it fails (not releasable) | 2 usage error
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const newRoot = flag("--new");
const oldRoot = flag("--old");
const asJson = argv.includes("--json");
if (!newRoot || !oldRoot) {
  console.error("usage: node tools/evidence-0.1.52.mjs --new <repo dir> --old <extracted package dir> [--json]");
  process.exit(2);
}

function read(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return { path: p, text: null };
  return { path: p, text: readFileSync(p, "utf8") };
}

/** cell: [name, relPath, predicate(text) -> boolean, what failing means] */
const CELLS = [
  ["A1 an idempotent dock install (a refused registration is logged, not swallowed)", "lib/client.js",
    (t) => t.includes("dock registration failed"), "the dock could be registered once and taken out for good"],
  ["A2 the dock entry is an error boundary (a render error shows itself)", "lib/client.js",
    (t) => t.includes("getDerivedStateFromError"), "a render error would unmount the dock entry silently"],
  ["B1 the atomic writer is EXPORTED (class and service share one implementation)", "lib/host/persistence.js",
    (t) => /export function writeJsonAtomic\b/.test(t), "the hardened writer stays private, so service.ts cannot use it"],
  ["B2 no config write bypasses it (bare writeFile on the five config targets)", "lib/host/service.js",
    (t) => !t.includes("writeFile(this.replyAgentFile") && !t.includes("writeFile(this.residentModelFile")
        && !t.includes("writeFile(this.relayConfigFile") && !t.includes("writeFile(file, JSON.stringify({ rooms"),
    "a config write that does not truncate/rename can leave a stale tail (the 2026-09-17 reply-agent.json)"],
];

function run(root) {
  const results = CELLS.map(([name, rel, ok, why]) => {
    const { path, text } = read(root, rel);
    if (text === null) return { name, ok: false, why: `missing ${rel}` };
    return { name, ok: Boolean(ok(text)), why };
  });
  const failures = results.filter((r) => !r.ok);
  return { root, results, pass: results.length - failures.length, fail: failures.length };
}

const newer = run(newRoot);
const older = run(oldRoot);
const say = (t) => console.log(t);
say(`evidence-0.1.52: NEW build root = ${newer.root}`);
say(`evidence-0.1.52: OLD build root = ${older.root}`);
for (const side of [newer, older]) {
  say(`  ${side.root === newer.root ? "NEW" : "OLD"}: ${side.pass} pass / ${side.fail} fail`);
  for (const r of side.results) say(`    ${r.ok ? "ok  " : "FAIL"} ${r.name}`);
}
const assertion = `new assertions on the NEW build: ${newer.fail} failure(s) | on the OLD build: ${older.fail} failure(s)`;
say(assertion);
if (asJson) say(JSON.stringify({ new: newer, old: older, assertion }, null, 2));

if (newer.fail > 0) process.exit(1);
if (older.fail === 0) {
  console.error("evidence-0.1.52: the OLD build passes every cell too — these assertions do not discriminate, so they are not evidence for this release");
  process.exit(1);
}
process.exit(0);
