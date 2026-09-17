/**
 * release-candidate.test.mjs -- the PROMOTION rule's own proof. Run directly:
 *   node tools/release-candidate.test.mjs
 * (node --test is not used here: the harness sandbox turns its worker spawn into EPERM, and a test
 *  runner that cannot spawn reports nothing.)
 *
 * WHAT IS BEING PROVEN, and why it needs proof at all
 *   A candidate is packed, shelved, installed on a canary and probed. The copy that ships must be
 *   those bytes. "Re-pack the same tree and compare md5" achieves that only by coincidence, and a
 *   promotion that silently re-packs looks EXACTLY like success from the outside: same version, same
 *   file name, plausible md5. So the rule is asserted here where it is cheap, and every refusal is
 *   asserted WITH ITS REASON -- "it refused" and "it refused for the right reason" are different
 *   claims, and the wrong refusal here is the one that publishes something.
 *
 *   The four ways to get it wrong: nothing was staged / the bytes drifted / a stale staging was
 *   blessed / the artifact path was already occupied by something else. Each is a separate case
 *   because each has a different fix, and a single "refused" would hide which one happened.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promoteDecision, stagedCandidateRow, EXIT_REFUSED } from './release.mjs';

// fileURLToPath, never url.pathname: these paths carry CJK, and .pathname arrives percent-encoded,
// so a child process started from it cannot resolve -- a harness failure that reads as a code failure.
const SELF = fileURLToPath(new URL('./release.mjs', import.meta.url));
const SRC = readFileSync(SELF, 'utf8');
let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || !extra ? '' : '  << ' + extra));
  cond ? pass++ : fail++;
};

const MD5 = 'accb446629c10dd87c30aa299558f21c';
const BYTES = 63688;
const COMMIT = 'a796072bcb57fad11d66a01a9725f9a4b7582042';
const VERSION = '0.2.13';
const CAND = { md5: MD5, bytes: BYTES };
const CAND_PATH = 'D:\\shelf\\dsh-agent-org-0.2.13.tgz';
const ARTIFACT = 'D:\\repo\\dsh-agent-org-0.2.13.tgz';
const LEDGER = 'D:\\dsh\\release-ledger.jsonl';
const staged = {
  ts: '2026-09-17T03:09:35Z', version: VERSION, gate: 'candidate', verdict: 'staged',
  artifact: 'dsh-agent-org-0.2.13.tgz', md5: MD5, bytes: BYTES, commit: COMMIT, actor: 'KEVINKIKI',
};
const call = (over = {}) => promoteDecision({
  candPath: CAND_PATH, cand: CAND, staged, version: VERSION, ledger: LEDGER,
  artifact: ARTIFACT, artifactExists: false, ...over,
});

console.log('--- the happy paths (both shapes of "the candidate is where it should be") ---');
let r = call();
ck('a stray candidate copy is promoted by COPYING it to the artifact path', r.ok === true && r.copy === true, JSON.stringify(r));
ck('  ... and the copy is not silently a rename: the note says "copied"', String(r.note ?? '').includes('copied'), String(r.note));

r = call({ candPath: ARTIFACT, artifactExists: true });
ck('a candidate already sitting at the artifact path promotes in place (no copy, no delete)', r.ok === true && r.copy === false, JSON.stringify(r));
ck('  ... and says so, instead of claiming a copy happened', String(r.note ?? '').includes('already sits'), String(r.note));

console.log('--- failing closed #1: nothing was staged for this version ---');
r = call({ staged: null });
ck('no candidate row for the version is REFUSED', r.ok === false && r.code === EXIT_REFUSED, JSON.stringify(r));
ck('  ... the reason names the ledger and the version', (r.line ?? '').includes(LEDGER) && (r.line ?? '').includes(VERSION), String(r.line));
ck('  ... and names the failure as "no candidate row", not as a byte mismatch',
  (r.line ?? '').includes('no {gate:"candidate"} row') && !(r.line ?? '').includes('NOT the bytes'), String(r.line));

r = call({ staged: { ...staged, version: '0.2.12', md5: 'ffffffffffffffffffffffffffffffff' } });
ck('a candidate row for a DIFFERENT version cannot bless this version', r.ok === false && r.code === EXIT_REFUSED, JSON.stringify(r));

console.log('--- failing closed #2: the bytes drifted (the whole point) ---');
r = call({ cand: { md5: '00000000000000000000000000000000', bytes: BYTES } });
ck('same byte count but a different md5 is REFUSED', r.ok === false && r.code === EXIT_REFUSED, JSON.stringify(r));
ck('  ... and quotes BOTH md5s, so the drift is visible without re-running anything',
  (r.line ?? '').includes('00000000000000000000000000000000') && (r.line ?? '').includes(MD5), String(r.line));
ck('  ... and says the bytes are not the ones a gate saw', (r.line ?? '').includes('NOT the bytes any gate was run on'), String(r.line));

r = call({ cand: { md5: MD5, bytes: BYTES + 1 } });
ck('same md5 but a different byte count is REFUSED (a length difference is a different file)', r.ok === false && r.code === EXIT_REFUSED, JSON.stringify(r));
ck('  ... and quotes both byte counts', (r.line ?? '').includes(String(BYTES + 1)) && (r.line ?? '').includes(String(BYTES)), String(r.line));

console.log('--- failing closed #3: a stale staging must not bless newer bytes ---');
const older = { ...staged, ts: '2026-09-17T01:00:00Z', md5: '11111111111111111111111111111111', bytes: 111 };
const newer = { ...staged, ts: '2026-09-17T03:09:35Z' };
ck('the LAST staging for the version is the authoritative one',
  stagedCandidateRow([older, newer], VERSION)?.md5 === MD5, JSON.stringify(stagedCandidateRow([older, newer], VERSION)));
ck('a stale staging does not win by being listed first',
  stagedCandidateRow([newer, older], VERSION)?.md5 === '11111111111111111111111111111111', 'the last row must win, not the first');
r = call({ staged: stagedCandidateRow([older], VERSION), cand: CAND });
ck('promoting the newest bytes against an older staging row is REFUSED',
  r.ok === false && r.code === EXIT_REFUSED && (r.line ?? '').includes('11111111111111111111111111111111'), String(r.line));
ck('rows for other versions are not consulted at all',
  stagedCandidateRow([{ ...staged, version: '0.2.12' }], VERSION) === null, 'a 0.2.12 staging matched a 0.2.13 promotion');
ck('non-candidate rows are not consulted at all (a "publish" row is not a staging)',
  stagedCandidateRow([{ ...staged, gate: 'publish' }, { ...staged, gate: 'canary' }], VERSION) === null, 'a non-candidate gate row was treated as a staging');

console.log('--- failing closed #4: the artifact path is occupied by something else ---');
r = call({ artifactExists: true });
ck('an occupied artifact path that is NOT the candidate is REFUSED', r.ok === false && r.code === EXIT_REFUSED, JSON.stringify(r));
ck('  ... the reason says it already exists and is not the candidate, and points at --candidate',
  (r.line ?? '').includes('already exists and is not the candidate') && (r.line ?? '').includes('--candidate'), String(r.line));

console.log('--- order is the mechanism (read from the source, not claimed in prose) ---');
const iGate = SRC.indexOf('runReleaseGate(gateArgv');
const iCand = SRC.indexOf('const candidateArg = args.candidate');
const iElse = SRC.indexOf('} else {', iCand);
const iPack = SRC.indexOf('"pack", "--pack-destination"');
ck('the four gates are evaluated BEFORE the promotion decision', iGate > 0 && iCand > 0 && iGate < iCand, `gate@${iGate} cand@${iCand}`);
ck('npm pack appears only past the non-promotion branch', iElse > iCand && iPack > iElse, `else@${iElse} pack@${iPack}`);
const promoBranch = iElse > iCand ? SRC.slice(iCand, iElse) : '';
ck('the promotion branch contains no pack call at all', promoBranch.length > 0 && !promoBranch.includes('packArgs') && !promoBranch.includes('npm pack'), 'the promotion branch can still pack');
ck('the artifact is re-read after promotion and compared to the candidate file',
  SRC.includes('the published file is not the candidate'), 'the post-copy byte check is gone');
ck('importing this module does not run a release (CLI guard present)',
  SRC.includes('=== resolve(process.argv[1])'), 'without the guard, an import would fire the gates');

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
