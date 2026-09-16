#!/usr/bin/env node
/**
 * dsh-agent-room -- publish the studio's own scripts, WITH a manifest they can trust.
 *
 * WHY THIS EXISTS (D-48)
 *   `upgrade-studio.ps1` is not self-updating: its own header tells the operator to fetch it by hand
 *   (`iwr http://…/upgrade-studio.ps1 -OutFile …`). So every fix to the script had to be re-copied
 *   onto every machine, and a machine kept running an upgrade script that predated the gate meant to
 *   protect it. D-47's profile gate only reached two machines because it was pushed by hand; the
 *   third never got it.
 *
 *   The manifest is what makes self-update safe: the running script compares its OWN md5 against the
 *   manifest's, and only hands over to a download whose md5 matches the manifest exactly. A manifest
 *   with hand-typed hashes would drift within a day, so it is generated here, from the bytes, every
 *   time.
 *
 * usage: node tools/publish-studio-files.mjs <file>... [--out <manifest>] [--scp-to <user@host:/dir>]
 *        node tools/publish-studio-files.mjs D:\\dsh\\upgrade-studio.ps1 D:\\dsh\\upgrade-studio.sh ^
 *             D:\\dsh\\ITPM\\数创港项目\\dsh-agent-room\\tools\\profile-guard.mjs
 *
 * It writes the manifest and prints the exact scp line (it never uploads anything itself: uploading
 * is the release tool's job, and a tool that both decides and ships is how silent failures happen).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const SCHEMA = "studio-scripts/1";

export function md5Of(file) {
  return createHash("md5").update(readFileSync(file)).digest("hex");
}

/** Build the manifest from the bytes on disk: no hash in it was ever typed by a human. */
export function buildManifest(files, { updatedAt = new Date().toISOString() } = {}) {
  const out = {};
  for (const f of files) {
    const bytes = readFileSync(f);
    out[basename(f)] = { md5: md5Of(f), bytes: bytes.length };
  }
  return { schema: SCHEMA, updatedAt, files: out };
}

const USAGE = [
  "usage: node tools/publish-studio-files.mjs <file>... [--out <manifest>] [--scp-to <user@host:/dir>]",
  "",
  "  writes a manifest whose md5s are computed from the files themselves; the running upgrade",
  "  script compares its own md5 against it and hands over only to bytes that match.",
].join("\n");

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith("publish-studio-files.mjs");
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(USAGE);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  const files = [];
  let out = null;
  let scpTo = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") { out = argv[i + 1]; i += 1; continue; }
    if (argv[i] === "--scp-to") { scpTo = argv[i + 1]; i += 1; continue; }
    files.push(argv[i]);
  }
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    console.error(`publish-studio-files: no such file: ${missing.join(", ")}`);
    process.exit(2);
  }
  const manifest = buildManifest(files);
  const manifestPath = out ?? join(dirname(files[0]), "upgrade-studio.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`manifest: ${manifestPath}  (schema ${manifest.schema})`);
  for (const [name, info] of Object.entries(manifest.files)) {
    console.log(`  ${name.padEnd(24)} md5=${info.md5}  bytes=${info.bytes}`);
  }
  const targets = files.map((f) => `"${f}"`).join(" ");
  const dest = scpTo ?? "ubuntu@42.193.189.15:/home/ubuntu/studio-files/";
  console.log("");
  console.log(`scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL ${targets} "${manifestPath}" ${dest}`);
  process.exit(0);
}
