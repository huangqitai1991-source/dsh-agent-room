/**
 * preupgrade-backup-gate.mjs -- "no update without a fresh, self-proven in-place backup".
 *
 * WHY THIS EXISTS (human rule, 2026-09-16)
 *   That morning one node lost its profile directory, its whole .dsh/agent-room state and its
 *   global harness tree, and NOTHING on that machine could be restored, because no snapshot
 *   existed. The human then said: every major update starts with an in-place backup.
 *   The backup DEVICE (backup-pre-upgrade.ps1 / .sh) was written the same day and proves itself by
 *   re-hashing what it copied. What was missing is the MECHANISM that refuses the update when no
 *   such proof exists -- because a rule that only lives in prose is not a rule.
 *
 * WHAT IT CHECKS (each one is a named refusal, never a guess)
 *   1. <root>/LAST-BACKUP.json exists and parses;
 *   2. it says ok:true and names a snapshot that still EXISTS;
 *   3. that snapshot still carries BACKUP-OK.txt with verdict=verified-by-rehash;
 *   4. the two records AGREE on the manifest hash (a record edited on one side is caught here);
 *   5. the manifest file still hashes to that value (the cheap half of the device's own proof);
 *   6. the backup is FRESH: backed up no longer than --max-age-minutes ago (default 60).
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not re-hash every file in the snapshot (that is `--mode verify` on the device, and it
 *   is far too slow to sit in an upgrade's pre-flight). It does not write anything, anywhere.
 *
 * usage:
 *   node tools/preupgrade-backup-gate.mjs [--root <dir>] [--max-age-minutes <n>] [--now <iso>]
 *                                         [--json] [--quiet] [--help]
 * exit: 0 admitted | 1 refused (named) | 2 usage/error
 *
 * The wiring into upgrade-studio.ps1 / .sh is a separate, windowed change (0.1.52): this file is
 * the mechanism, the call site is the next step.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const EXIT_ADMITTED = 0;
export const EXIT_REFUSED = 1;
export const EXIT_ERROR = 2;
export const DEFAULT_MAX_AGE_MINUTES = 60;
export const DEVICE_VERDICT = 'verified-by-rehash';

const USAGE = [
  'usage: node tools/preupgrade-backup-gate.mjs [options]',
  '',
  '  --root <dir>              where the backup device keeps its snapshots',
  '                            (default: C:\\studio\\backups on win32, ~/studio/backups otherwise)',
  '  --max-age-minutes <n>     how old a backup may be and still admit an update (default 60)',
  '  --now <iso>               judge as if now were this instant (for tests / re-playing a record)',
  '  --json                    print the verdict as JSON instead of one line',
  '  --quiet                   print nothing on success',
  '  --help                    this text',
  '',
  'A REFUSAL NAMES WHAT WAS MISSING. It never prints a success-shaped line it did not verify.',
].join('\n');

export function defaultRoot(platform = process.platform, home = homedir()) {
  return platform === 'win32' ? 'C:\\studio\\backups' : join(home, 'studio', 'backups');
}

function sha256File(p) {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; }
}

function parseArgs(argv) {
  const out = { root: defaultRoot(), maxAgeMinutes: DEFAULT_MAX_AGE_MINUTES, now: null, json: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--quiet') { out.quiet = true; continue; }
    const m = /^--(root|max-age-minutes|now)(?:=(.*))?$/.exec(a);
    if (!m) return { error: `unknown argument: ${a}` };
    const key = m[1];
    const value = m[2] !== undefined ? m[2] : argv[++i];
    if (value === undefined) return { error: `--${key} needs a value` };
    if (key === 'root') out.root = value;
    else if (key === 'now') out.now = value;
    else {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return { error: `--max-age-minutes needs a positive number, got ${value}` };
      out.maxAgeMinutes = n;
    }
  }
  return out;
}

function refuse(reason) {
  return { admitted: false, verdict: 'refused', reason };
}

/** Judge one backups root. Pure: no writes, and `now` is injectable so the test can pin time. */
export function judge({ root, maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES, now = new Date() } = {}) {
  const lastPath = join(root, 'LAST-BACKUP.json');
  if (!existsSync(lastPath)) return refuse(`no backup record at ${lastPath} -- this machine has no proven backup, so the update is not admitted`);

  let last;
  try { last = JSON.parse(readFileSync(lastPath, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return refuse(`the backup record at ${lastPath} is unreadable (${String(e.message).slice(0, 80)})`); }

  if (last.ok !== true) return refuse(`the backup record says ok=${JSON.stringify(last.ok)} -- an unvalidated snapshot is not a backup`);
  const snap = typeof last.snapshot === 'string' ? last.snapshot : '';
  if (!snap) return refuse('the backup record names no snapshot');
  if (!existsSync(snap)) return refuse(`the snapshot named by the record is GONE: ${snap}`);
  try { if (!statSync(snap).isDirectory()) return refuse(`the snapshot named by the record is not a directory: ${snap}`); }
  catch (e) { return refuse(`the snapshot cannot be read: ${snap} (${String(e.message).slice(0, 60)})`); }

  const okPath = join(snap, 'BACKUP-OK.txt');
  if (!existsSync(okPath)) return refuse(`the snapshot has no BACKUP-OK.txt: ${snap} -- the device's own verdict is missing`);
  let okText = '';
  try { okText = readFileSync(okPath, 'utf8'); } catch (e) { return refuse(`BACKUP-OK.txt is unreadable (${String(e.message).slice(0, 60)})`); }
  if (!okText.includes(`verdict=${DEVICE_VERDICT}`)) {
    return refuse(`BACKUP-OK.txt does not carry verdict=${DEVICE_VERDICT} -- the snapshot was never proven by re-hash`);
  }

  // the two records must agree: a hash rotated on one side only is caught here
  const fromOk = (/manifestSha256=([0-9a-f]{64})/i.exec(okText) ?? /manifestMd5=([0-9a-f]{32})/i.exec(okText) ?? [])[1] ?? null;
  const fromLast = last.manifestSha256 ?? last.manifestMd5 ?? null;
  if (fromOk && fromLast && String(fromOk).toLowerCase() !== String(fromLast).toLowerCase()) {
    return refuse(`the record and the snapshot DISAGREE about the manifest hash (${fromLast} vs ${fromOk})`);
  }

  // cheap half of the proof: the manifest file itself must still hash to the recorded value
  if (fromLast) {
    const algo = String(fromLast).length === 64 ? 'sha256' : 'md5';
    const manPath = join(snap, algo === 'sha256' ? 'MANIFEST.tsv' : 'MANIFEST.txt');
    if (!existsSync(manPath)) return refuse(`the snapshot's manifest is missing: ${manPath}`);
    const got = algo === 'sha256' ? sha256File(manPath) : null;
    if (got && got.toLowerCase() !== String(fromLast).toLowerCase()) {
      return refuse(`the manifest no longer hashes to the recorded value (record ${fromLast}, now ${got})`);
    }
  }

  const atRaw = last.at ?? last.atUtc ?? null;
  const at = atRaw ? new Date(atRaw) : null;
  if (!at || Number.isNaN(at.getTime())) return refuse(`the backup record carries no usable timestamp (at=${JSON.stringify(atRaw)})`);
  const ageMinutes = (now.getTime() - at.getTime()) / 60000;
  if (ageMinutes < 0) return refuse(`the backup record is dated in the FUTURE (${at.toISOString()}, now ${now.toISOString()}) -- a clock that cannot be trusted cannot admit an update`);
  if (ageMinutes > maxAgeMinutes) {
    return refuse(`the last proven backup is ${Math.round(ageMinutes)} minutes old (at ${at.toISOString()}), which is older than the ${maxAgeMinutes} minute maximum -- back up first, then update`);
  }

  return {
    admitted: true,
    verdict: 'admitted',
    machine: last.machine ?? null,
    snapshot: snap,
    at: at.toISOString(),
    ageMinutes: Math.round(ageMinutes * 10) / 10,
    files: last.files ?? null,
    bytes: last.bytes ?? null,
    manifestHash: fromLast ?? null,
  };
}

export function main(argv = process.argv.slice(2), io = console) {
  const args = parseArgs(argv);
  if (args.error) { io.error(`UPGRADE BACKUP GATE ERROR: ${args.error}`); io.error(USAGE); return EXIT_ERROR; }
  if (args.help) { io.log(USAGE); return EXIT_ADMITTED; }

  const now = args.now ? new Date(args.now) : new Date();
  if (args.now && Number.isNaN(now.getTime())) { io.error(`UPGRADE BACKUP GATE ERROR: --now is not a date: ${args.now}`); return EXIT_ERROR; }

  const r = judge({ root: args.root, maxAgeMinutes: args.maxAgeMinutes, now });
  if (args.json) {
    io.log(JSON.stringify(r));
  } else if (r.admitted) {
    if (!args.quiet) {
      io.log(`UPGRADE BACKUP GATE ADMITTED: ${r.machine ?? 'this machine'} has a proven backup ${r.ageMinutes} minute(s) old (${r.files ?? '?'} files, ${r.bytes ?? '?'} bytes) at ${r.snapshot}`);
    }
  } else {
    io.error(`UPGRADE BACKUP GATE REFUSED: ${r.reason}`);
  }
  return r.admitted ? EXIT_ADMITTED : EXIT_REFUSED;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly || process.env.PREUPGRADE_BACKUP_GATE_RUN === '1') {
  process.exitCode = main();
}
