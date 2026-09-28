/**
 * _probe-fatal-real.mjs — release-gate evidence, NOT part of the test suite.
 *
 * The card's criterion 5 asks whether a room-side boot failure really reaches the
 * host's fatal path. Unit tests cannot answer that inside the test runner (a rethrow
 * from a fire-and-forget boot IS an unhandled rejection, which node:test reports as
 * a failure), so this probe does it the way the host does: it installs the REAL
 * `installFailLoud` from the installed DSH, constructs the REAL built
 * `AgentRoomService` against a corrupt temp config, and lets the process die.
 *
 * Expected: stderr contains "dsh: fatal load failure:" naming CorruptConfigError and
 * the absolute path, the exit code is 1, and the damaged file is byte-identical
 * afterwards with a quarantine copy present.
 *
 *   node test/_probe-fatal-real.mjs
 *
 * It never touches a real DSH home (everything is under <workdir>\_fatal-probe) and it
 * starts no service: boot() throws before ensurePeerServer() is reached.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { AgentRoomService } from "../lib/host/service.js";

const DSH_APP_BOOT =
  process.env.DSH_APP_BOOT ??
  path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js");

const ROOT = path.join(os.tmpdir(), "dsh-agent-room-fatal-probe");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

fs.rmSync(ROOT, { recursive: true, force: true });
const dataDir = path.join(ROOT, "agent-room");
fs.mkdirSync(path.join(dataDir, "rooms"), { recursive: true });
fs.mkdirSync(path.join(dataDir, "messages"), { recursive: true });
const identityFile = path.join(dataDir, "identity.json");
// A truncated write: present, unparseable, and NOT fixable by stripping a BOM.
fs.writeFileSync(identityFile, '{\n  "agentId": "01a0231b-bbe5-720a-97a4-819744eeae76",\n  "nickname": "KEV');

process.env.DSH_HOME = path.join(ROOT, "home");
process.env.DSH_IDENTITY_BACKUP_DIR = path.join(ROOT, "backups");

const before = fs.readFileSync(identityFile);
const beforeStat = fs.statSync(identityFile);
const mode = process.argv[2] ?? "corrupt";

const { installFailLoud } = await import(pathToFileURL(DSH_APP_BOOT).href);
installFailLoud("dsh", process, async () => {
  process.stderr.write("[probe] host release hook ran (fiber.dispose would run here)\n");
});

console.log(`=== MODE ${mode} ===`);
console.log(`  damaged file : ${identityFile}`);

if (mode === "clean") {
  // Control: a healthy identity boots, so the probe proves the fatal channel is
  // driven by corruption and not by the probe itself starting something broken.
  fs.writeFileSync(identityFile, JSON.stringify({ agentId: "01a0231b-bbe5-720a-97a4-819744eeae76", nickname: "*****", capabilities: [], createdAt: "n" }, null, 2));
}
const seeded = fs.readFileSync(identityFile);
console.log(`  bytes/sha    : ${seeded.length} / ${sha256(seeded).slice(0, 16)}`);

const service = new AgentRoomService(new Context(), { dataDir, port: 46_311, relay: "" });

await new Promise((resolve) => setTimeout(resolve, 3_000));

// Only reachable when the fatal channel did NOT fire (the clean control lands here).
const after = fs.readFileSync(identityFile);
const afterStat = fs.statSync(identityFile);
console.log("  RESULT: process STILL RUNNING after the attempted boot");
console.log(`  file unchanged : ${sha256(after) === sha256(before) || mode === "clean"}`);
if (mode !== "clean") {
  console.log("  PROBE FAILED: a corrupt config did not reach the fatal path");
}
try {
  for (const timer of [service.profileTimer, service.listenTimer]) if (timer) clearInterval(timer);
  service.discovery?.stop?.();
  await service.peerServer?.stop();
} catch {
  /* ignore */
}
process.exit(0);

// Unused in the corrupt path, kept for the record.
void beforeStat;
void afterStat;
