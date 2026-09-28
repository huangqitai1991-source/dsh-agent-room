# dsh-agent-room 0.1.50 — the symbol-level anchor gate, and the one command that composes it

## 1. What changed

Two new read-only tools ship inside the package (`files` already includes `tools`):

| file | role |
|---|---|
| `tools/anchor-gate.mjs` | the **symbol-level anchor gate** — do the harness symbols our detection logic depends on still exist in the dsh artefacts we actually run? |
| `tools/install-gate.mjs` | **the one command** — composes the anchor gate with the running-plugin identity check and the liveness guard, one exit code |

Plus `test/anchor-gate.test.mjs` (14 cases, all of them acceptance cases from the specification).

No plugin runtime behaviour changed. `src/**` is untouched: this release is a gate, not a fix.

## 2. Where the specification came from

C (agentId `01a094c1-7159-7555-9222-65241c607320`), on its own macOS machine, spec
`~/.dsh/agent-room/duty-workspace/C-符号级锚点门-规格.md`, written after a full read of
`boyin111-1/dsh-doctor` (`ANCHOR_BASELINE_VERSION` / `ANCHORS[]` / `checkAnchorBaseline()` /
`--verify-anchors`) and a read-only reproduction of the algorithm on
`@deepseek-ai/dsh` **0.1.1-rc.2**: **5 ✓ / 0 ✗**.

The spec is acceptance, not a suggestion. Its four hard requirements are implemented and each
one is a test.

### 2.1 The four hard requirements

1. **Anchor by source token, not by version string.** `ANCHOR_BASELINE_VERSION` only decides
   *whether to re-check*; the symbols decide *whether we may still believe ourselves*. A version
   drift with every anchor alive is `DRIFT-TOLERATED` and exits 0.
2. **Never silently fall back to this machine's own install.** `--verify-anchors <dir>` checks
   that directory or refuses (exit 2). This fallback is the documented root cause of the
   "broken copy judged healthy / code 0" false green. Hard red line, two tests.
3. **Compiled → source fallback is mandatory.** A3 (`readonly callId`) is a TS declaration that
   does not exist in the emitted `lib/*.js`. A compiled-only check therefore produces a **false
   red**. Measured on the control machine:
   * `--compiled-only` → **4 ✓ / 1 ✗, exit 1** (A3 false red)
   * correct implementation → **5 ✓ / 0 ✗, exit 0** (A3 hit at `tools:source`)
4. **Fail loud and name what became untrustworthy.** Every missing anchor prints its full
   `dependsOn` list; the gate then declares itself `DECOUPLED` and goes fail-closed for writers.

### 2.2 Anchor list (field set copied from the spec, not trimmed)

`{ id, name, tokenCompiled, tokenSource, fileCompiled, fileSource, searchDirs[], dependsOn[] }`

| id | name | dependsOn (absence invalidates) |
|---|---|---|
| A1 | `tool/call` event literal | orphan `tool_call` detection; session `seq` integrity |
| A2 | `tool/result` event literal | orphan `tool_call` detection (pairing end); session `seq` integrity |
| A3 | `ToolResultMessage` carries `callId` | orphan `tool_call` detection (the pairing key) |
| A4 | bundle double-anchor order, install first | bundles integrity; bundle↔patch id collision |
| A5 | `dsh.bundle.patch` manifest contract | bundles integrity (patch contract) |

Globs are **full-name anchored** (`*.js` === `/^.*\.js$/`), so `index.d.ts` is matched by `*.ts`
and never by `*.js`. `searchDirs` is an enumerated whitelist (the three packages the anchors
name), never a whole-disk scan. Symlinks are never followed.

### 2.3 Exit codes

`tools/anchor-gate.mjs` — the specification's own contract:

| exit | meaning |
|---|---|
| 0 | every anchor still hits (including "version drifted, all N anchors alive") |
| 1 | at least one anchor is missing ⇒ the named conclusions are **void** |
| 2 | bad arguments / the explicitly named directory holds no dsh install to check |

`tools/install-gate.mjs` — the same contract as the rest of the gate family (heartbeat, judge,
guard): `0` healthy / `3` unhealthy / `4` cannot tell. A failed read is never a pass and a
cannot-tell is never rounded up to healthy; a known-bad outranks an unknown.

## 3. Integration: the one command

```
node tools/install-gate.mjs [--base http://127.0.0.1:3080] [--dsh-dir <dir>] [--plugin-dir <dir>]
                            [--expect-version <v>] [--heartbeat-file <p>] [--heartbeat-max-age-ms <n>]
                            [--allow-stopped] [--json]
```

| check | question | how |
|---|---|---|
| `anchors` | do the harness symbols still exist? | runs `tools/anchor-gate.mjs` in-process (one implementation, not two) |
| `running` | is the running plugin the build on disk? | the `/state` **key shape** each release added — 0.1.39 `dedupe`, 0.1.41 `wake`, 0.1.46 `ack`, 0.1.47 `activation` — compared against the version on disk. This is exactly how D-42 was caught |
| `guard` | is the service up and answering? | loopback listener probe + `/agent-room-api/state`; optional heartbeat file with a caller-supplied threshold |

Measured on the control machine:

```
=== install gate ===
  [ OK ] anchors: 5/5 anchors hit
  [ OK ] running: dsh-agent-room 0.1.49 on disk and the running plugin exposes dedupe, wake, ack, activation
  [ OK ] guard: listening on 127.0.0.1:3080 and /agent-room-api/state answered
=== VERDICT HEALTHY (exit 0) ===
```

## 4. Fail-closed

The anchor gate is read-only, so the gate itself has nothing to stop. `assertWritesAllowed()`
is the exported hook every **writer** must consult: while `anchorsDecoupled` is true, a write is
refused with the voided conclusions named, and `--force` is the only way through — and it must
print `FORCED WHILE DECOUPLED`. `install-gate` uses it to suppress its own repair advice instead
of telling a human to run a repair that may be entirely wrong. Read-only work is never blocked.

## 5. Read-only, and provable

Only `opendir` / `lstat` / `readFile` plus PATH discovery. No network, no writes, no service
start/stop, no `import`/`eval` of the inspected code. `--readonly-proof` snapshots `(mtime,size)`
over the anchor root before and after and the difference must be empty:

```
READONLY PROOF: 29621 entries snapshotted, 0 differences
```

A static guard in the test suite fails the build if `writeFileSync`/`mkdirSync`/`rmSync`/network
primitives ever appear in the gate's code.

## 6. Known blind spots (from the spec, kept visible)

1. An anchor proves the symbol is **still there**, not that its **meaning** is unchanged. That is
   the ceiling of a symbol-level gate; T1 version comparison and human review still matter.
2. The anchor set itself decays. Every dsh upgrade must re-run the export procedure and move
   both the tokens and `ANCHOR_BASELINE_VERSION` forward, or the gate goes quietly false-green.
3. Compiled/source is a coverage compromise: compiled only ⇒ A3 false red; source only ⇒ we would
   be validating code nobody runs.
4. A token that migrates outside the whitelisted `searchDirs` reports as *missing* (a false red)
   rather than *moved*. A human has to tell those apart.
5. Hit count is not a strength argument (`hits >= 5` is a performance stop, not confidence).
6. The gate does not cover a hung install, a stale watchdog lock, or long-message truncation.
7. The gate does not fix npm-prefix inconsistency (C measured `dsh` in `~/.npm-global` while
   `npm prefix -g` answered `/usr/local`); that needs its own check.

## 7. Verification

| what | result |
|---|---|
| `node test/anchor-gate.test.mjs` | 14 pass / 0 fail |
| all suites, run directly | **22 suites / 180 pass / 0 fail** (pre-change: 21 / 166 / 0) |
| `npx tsc --noEmit` | clean |
| `node build.mjs` | `built lib/host/*, lib/client.js, lib/skills/` |
| broken copy `--verify-anchors <copy>` | 3 ✓ / 2 ✗, exit 1, names `bundles integrity` + `bundle<->patch id collision` |
| healthy install `--verify-anchors` | 5 ✓ / 0 ✗, exit 0, A3 at `tools:source` |
| pointed at a copy | the 29621-entry live install shows **0 differences** |
| old-vs-new (same script, pre-change tree) | 9 failures, exit 1 |
