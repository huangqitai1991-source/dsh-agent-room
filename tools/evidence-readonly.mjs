#!/usr/bin/env node
/**
 * evidence-readonly.mjs — the discriminating assertion for a dsh-agent-org release.
 *
 * WHY THIS EXISTS
 *   The house rule is "evidence before release": a release needs a RAW run in which a NEW build
 *   passes and an OLD build FAILS on the same assertions. The new UI change (2026-09-16, "the page is
 *   read-only, only the company can be renamed") has an obvious discriminator: the OLD build still
 *   carries the create/set-leader/delete controls in its client bundle, the NEW one does not.
 *
 *   This tool is written in Node ON PURPOSE. On 2026-09-17 a PowerShell check of the same file
 *   reported "the old build has no 新增部门" — the file is UTF-8 and PS 5.1 decoded it as GBK, so every
 *   Chinese literal silently missed. A scan whose decoding is wrong is not a scan.
 *
 * The scans mirror `test/client-readonly.test.mjs`: comments are stripped first (both bundles explain
 * the removed blocks in their own headers, and a naive scan would trip over its own changelog).
 *
 * usage: node tools/evidence-readonly.mjs --new <client.js> --old <client.js> [--json]
 * exit : 0 the new build passes   | 1 the new build fails (not releasable)  | 2 usage error
 */

import { readFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const newPath = flag("--new");
const oldPath = flag("--old");
const asJson = argv.includes("--json");

if (!newPath || !oldPath) {
  console.error("usage: node tools/evidence-readonly.mjs --new <client.js> --old <client.js> [--json]");
  process.exit(2);
}
for (const [label, p] of [["--new", newPath], ["--old", oldPath]]) {
  if (!existsSync(p)) { console.error(`evidence-readonly: no file for ${label}: ${p}`); process.exit(2); }
}

/** Comments out, then scan: the same rule the repo's own test uses. */
function stripped(path) {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Each cell is a NAME, a predicate over the stripped source, and what a failure means. */
const CELLS = [
  ["no create controls (部门/团队/成员 are arranged by the agent, not typed by a human)",
    (s) => !/(新增|加)部门/.test(s) && !/(新增|加)团队/.test(s) && !/(新增|加)成员/.test(s), "the old page let a human create the org"],
  ["no 设置上级 / setLeader (the reporting line is not hand-edited)",
    (s) => !s.includes("设置上级") && !s.includes("setLeader"), "the old page let a human re-parent nodes"],
  ["no removeNode (no per-node delete)",
    (s) => !s.includes("removeNode"), "the old page let a human delete org nodes"],
  ["the read-only tree renderer is present (renderTree)",
    (s) => s.includes("renderTree"), "the new page must draw the tree it claims to draw"],
];

function run(path) {
  const s = stripped(path);
  const results = CELLS.map(([name, ok]) => ({ name, ok: Boolean(ok(s)) }));
  const failures = results.filter((r) => !r.ok);
  return { path, bytes: readFileSync(path).length, results, pass: results.length - failures.length, fail: failures.length };
}

const newer = run(newPath);
const older = run(oldPath);

const lines = [];
const say = (t) => { lines.push(t); console.log(t); };
say(`evidence-readonly: NEW build = ${newer.path}`);
say(`evidence-readonly: OLD build = ${older.path}`);
for (const side of [newer, older]) {
  say(`  ${side.path === newer.path ? "NEW" : "OLD"}: ${side.pass} pass / ${side.fail} fail`);
  for (const r of side.results) say(`    ${r.ok ? "ok  " : "FAIL"} ${r.name}`);
}
const assertion = `new assertions on the NEW build: ${newer.fail} failure(s) | on the OLD build: ${older.fail} failure(s)`;
say(assertion);

if (asJson) {
  console.log(JSON.stringify({ new: newer, old: older, assertion }, null, 2));
}
/* The new build must pass every cell; the old build must FAIL at least one, or the assertions do not
 * discriminate and cannot carry a release. */
if (newer.fail > 0) process.exit(1);
if (older.fail === 0) {
  console.error("evidence-readonly: the OLD build passes every cell too — these assertions do not discriminate, so they are not evidence for this release");
  process.exit(1);
}
process.exit(0);
