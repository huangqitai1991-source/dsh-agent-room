/**
 * dsh-agent-room -- the studio-script manifest (D-48)
 *
 * WHY THIS SUITE EXISTS
 *   The upgrade script now replaces ITSELF when the published bytes differ, and it refuses to hand
 *   over unless the download's md5 matches the manifest. That makes the manifest a trust anchor: if
 *   its hashes drift from the files, every machine either refuses to update (stuck on an old script)
 *   or -- far worse -- could be fed bytes the manifest did not describe. So the hashes must be
 *   GENERATED from the bytes and verified here, never typed by a human.
 *
 * Run directly:  node test/publish-studio-files.test.mjs
 */

import assert from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { SCHEMA, buildManifest, md5Of } = await import(pathToFileURL(join(ROOT, "tools", "publish-studio-files.mjs")).href);

let failures = 0;
const guarded = (name, fn) =>
  test(name, async (t) => {
    try { await fn(t); } catch (error) { failures += 1; throw error; }
  });

const DIR = join(ROOT, "test", ".publish-studio-fixtures", String(process.pid));

guarded("the manifest's md5 is computed from the bytes, and matches an independent hash", () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const a = join(DIR, "upgrade-studio.ps1");
  const b = join(DIR, "profile-guard.mjs");
  writeFileSync(a, "Write-Host 'v1'\n");
  writeFileSync(b, "export const v = 1;\n");

  const manifest = buildManifest([a, b], { updatedAt: "2026-09-16T00:00:00.000Z" });
  assert.strictEqual(manifest.schema, SCHEMA);
  assert.deepStrictEqual(Object.keys(manifest.files).sort(), ["profile-guard.mjs", "upgrade-studio.ps1"]);

  const independent = createHash("md5").update(readFileSync(a)).digest("hex");
  assert.strictEqual(manifest.files["upgrade-studio.ps1"].md5, independent);
  assert.strictEqual(manifest.files["upgrade-studio.ps1"].bytes, readFileSync(a).length);
  assert.strictEqual(manifest.files["profile-guard.mjs"].md5, md5Of(b));
});

guarded("a changed byte changes the manifest hash (which is what makes the handover safe)", () => {
  const a = join(DIR, "upgrade-studio.ps1");
  const before = buildManifest([a]).files["upgrade-studio.ps1"].md5;
  writeFileSync(a, "Write-Host 'v2'\n");
  const after = buildManifest([a]).files["upgrade-studio.ps1"].md5;
  assert.notStrictEqual(before, after, "a manifest that ignores byte changes would certify anything");
  rmSync(DIR, { recursive: true, force: true });
});

guarded("summary", () => {
  assert.strictEqual(failures, 0, `${failures} publish-studio-files case(s) failed`);
});
