/**
 * preupgrade-backup-gate.test.mjs -- the gate's own proof. Run directly:
 *   node tools/preupgrade-backup-gate.test.mjs
 * (node --test is not used here: the harness sandbox turns its worker spawn into EPERM, and a test
 *  runner that cannot spawn is a test runner that reports nothing.)
 *
 * Every case builds a FIXTURE (never a real backups root) and asserts the verdict AND the reason,
 * because "it refused" and "it refused for the right reason" are different claims.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judge, EXIT_ADMITTED, EXIT_REFUSED, EXIT_ERROR } from './preupgrade-backup-gate.mjs';

// fileURLToPath, NOT url.pathname: these paths contain CJK, so `.pathname` arrives percent-encoded
// and the child process cannot start -- a harness failure that would otherwise read as a code failure.
const SELF = fileURLToPath(new URL('./preupgrade-backup-gate.mjs', import.meta.url));
const sha = (s) => createHash('sha256').update(s).digest('hex');
let pass = 0, fail = 0;
const ck = (name, cond) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name); cond ? pass++ : fail++; };

const NOW = new Date('2026-09-16T08:30:00Z');

function fixture({ ageMinutes = 5, ok = true, verdict = 'verified-by-rehash', manifestName = 'MANIFEST.tsv', breakManifest = false, breakSnapshot = false, breakOk = false, mutate = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bk-gate-'));
  const snap = join(root, 'pre-upgrade-20260916-080000');
  mkdirSync(snap, { recursive: true });
  const manifest = 'a.txt\t3\tabc\n';
  writeFileSync(join(snap, manifestName), breakManifest ? 'a.txt\t3\tTAMPERED\n' : manifest);
  const manHash = sha(manifest);
  writeFileSync(join(snap, 'BACKUP-OK.txt'), ['PRE-UPGRADE BACKUP OK', 'device=sh-v1', `manifestSha256=${breakOk ? sha('other') : manHash}`, `verdict=${verdict}`, ''].join('\n'));
  const at = new Date(NOW.getTime() - ageMinutes * 60000).toISOString();
  const rec = { at, machine: 'fixture-host', snapshot: snap, files: 1, bytes: 3, manifestSha256: manHash, ok };
  if (breakSnapshot) rec.snapshot = join(root, 'does-not-exist');
  if (mutate) rec.at = mutate(at);
  writeFileSync(join(root, 'LAST-BACKUP.json'), JSON.stringify(rec));
  return { root, snap };
}

console.log('--- pure judgements ---');
let f = fixture();
let r = judge({ root: f.root, now: NOW });
ck('fresh proven backup admitted', r.admitted === true && r.verdict === 'admitted');
ck('admitted line carries machine + age', r.machine === 'fixture-host' && r.ageMinutes === 5);

r = judge({ root: fixture({ ageMinutes: 90 }).root, now: NOW });
ck('stale backup refused', r.admitted === false);
ck('stale refusal names the age and the maximum', /90 minutes old/.test(r.reason) && /60 minute maximum/.test(r.reason));

r = judge({ root: fixture({ ageMinutes: 45 }).root, maxAgeMinutes: 30, now: NOW });
ck('custom max-age honoured', r.admitted === false && /45 minutes old/.test(r.reason));

r = judge({ root: mkdtempSync(join(tmpdir(), 'bk-empty-')), now: NOW });
ck('no backup record refused', r.admitted === false && /no backup record/.test(r.reason));

r = judge({ root: fixture({ ok: false }).root, now: NOW });
ck('ok:false refused', r.admitted === false && /unvalidated snapshot is not a backup/.test(r.reason));

r = judge({ root: fixture({ breakSnapshot: true }).root, now: NOW });
ck('vanished snapshot refused', r.admitted === false && /is GONE/.test(r.reason));

r = judge({ root: fixture({ verdict: 'copied-happily' }).root, now: NOW });
ck('unproven device verdict refused', r.admitted === false && /never proven by re-hash/.test(r.reason));

r = judge({ root: fixture({ breakOk: true }).root, now: NOW });
ck('record/snapshot hash disagreement refused', r.admitted === false && /DISAGREE about the manifest hash/.test(r.reason));

r = judge({ root: fixture({ breakManifest: true }).root, now: NOW });
ck('manifest tampering refused', r.admitted === false && /manifest no longer hashes/.test(r.reason));

r = judge({ root: fixture({ mutate: () => new Date(NOW.getTime() + 3600000).toISOString() }).root, now: NOW });
ck('future-dated record refused', r.admitted === false && /dated in the FUTURE/.test(r.reason));

r = judge({ root: fixture({ mutate: () => 'not-a-date' }).root, now: NOW });
ck('bad timestamp refused', r.admitted === false && /no usable timestamp/.test(r.reason));

// the Windows device writes MANIFEST.txt + manifestMd5; the POSIX device writes MANIFEST.tsv + manifestSha256.
// A gate that only understood one of them would refuse half the fleet.
{
  const root = mkdtempSync(join(tmpdir(), 'bk-alt-'));
  const snap = join(root, 'pre-upgrade-20260916-080000');
  mkdirSync(snap, { recursive: true });
  const manifest = 'a.txt\t3\tabc\n';
  writeFileSync(join(snap, 'MANIFEST.txt'), manifest);
  const md5 = createHash('md5').update(manifest).digest('hex');
  writeFileSync(join(snap, 'BACKUP-OK.txt'), ['PRE-UPGRADE BACKUP OK', `manifestMd5=${md5}`, 'verdict=verified-by-rehash', ''].join('\n'));
  writeFileSync(join(root, 'LAST-BACKUP.json'), JSON.stringify({ at: new Date(NOW.getTime() - 120000).toISOString(), snapshot: snap, manifestMd5: md5, ok: true, machine: 'win-fixture' }));
  r = judge({ root, now: NOW });
  ck('windows-style record (MANIFEST.txt + md5) admitted', r.admitted === true && r.manifestHash === md5);
}

console.log('--- command line (exit codes are the interface) ---');
// OUTPUT GOES TO FILES, NOT PIPES: under the harness sandbox a spawnSync with piped stdio fails
// with EPERM, and a test that cannot spawn reports failures that are the sandbox's, not the code's.
// Measured on this project: the same boundary turned `spawnSync powershell` into EPERM.
function runCli(args) {
  const d = mkdtempSync(join(tmpdir(), 'bk-cli-'));
  const outPath = join(d, 'out.txt');
  const fd = openSync(outPath, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [SELF, ...args], { stdio: ['ignore', fd, fd] });
  } finally { closeSync(fd); }
  const text = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  // a spawn that never started must never be read as "the CLI returned the wrong code"
  if (res.status === null) return { code: -999, out: text, spawnError: String(res.error && res.error.message || 'spawn failed') };
  return { code: res.status, out: text };
}
{
  const f2 = fixture();
  let c = runCli(['--root', f2.root, '--now', NOW.toISOString()]);
  ck('cli: admitted exits 0', c.code === EXIT_ADMITTED);
  ck('cli: admitted prints one named line', /UPGRADE BACKUP GATE ADMITTED:/.test(c.out));

  const f3 = fixture({ ageMinutes: 999 });
  c = runCli(['--root', f3.root, '--now', NOW.toISOString()]);
  ck('cli: refused exits 1', c.code === EXIT_REFUSED);
  ck('cli: refused names the gate', /UPGRADE BACKUP GATE REFUSED:/.test(c.out));

  c = runCli(['--root', f2.root, '--json', '--now', NOW.toISOString()]);
  const parsed = (() => { try { return JSON.parse(c.out.trim()); } catch { return null; } })();
  ck('cli: --json emits one parseable object', !!parsed && parsed.admitted === true);

  c = runCli(['--wat']);
  ck('cli: unknown flag exits 2' + (c.spawnError ? ' [' + c.spawnError + ']' : ''), c.code === EXIT_ERROR);
  c = runCli(['--max-age-minutes', '0']);
  ck('cli: non-positive age exits 2', c.code === EXIT_ERROR);
}

console.log(`\nTEST pass=${pass} fail=${fail}`);
if (fail === 0) console.log('GATE TEST PASS'); else console.log('GATE TEST FAIL');
process.exit(fail === 0 ? 0 : 1);


