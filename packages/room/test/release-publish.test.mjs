/**
 * dsh-agent-room -- THE RELEASE COMMAND (tools/release.mjs), and the proof that a refusal ships nothing.
 *
 * WHY THESE TESTS EXIST
 *   The four gates could refuse, but for a long time the only path that called them was the
 *   `upgrade-studio` launcher. Packaging and uploading was still manual, so an artifact could be
 *   produced and published WITHOUT any gate ever running. `tools/release.mjs` closes that: the gates
 *   decide first, and only an allowed run reaches `npm pack`. These tests are the acceptance for
 *   that ordering -- a refused publish must leave NO .tgz, NO upload and NO publish row behind, and a
 *   compliant publish must leave exactly one .tgz and exactly one {gate:"publish"} row naming it.
 *
 * THE ONE RULE THIS SUITE ENFORCES ON ITSELF
 *   "It exited non-zero" is not proof that nothing shipped. Every refusal case here is checked by
 *   BYTES and by LISTING: the pack directory must be empty (or the pre-existing file byte-identical),
 *   the served directory must be empty, and the ledger must differ by exactly the one row the gate
 *   says it writes.
 *
 *   The upload half is exercised without touching the real file server: --transport local:<dir>
 *   copies the artifact and --http-base points at a loopback HTTP server, so the md5 read-back is the
 *   real code path -- including the case where the server serves DIFFERENT bytes (the test server can
 *   append a byte on purpose), which must end with no publish row and no artifact.
 *
 * Everything runs against hermetic fixtures under the repo's temp root.
 *
 * Run directly:  node test/release-publish.test.mjs     (never `node --test`)
 */

import assert from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RELEASE_FILE = join(ROOT, "tools", "release.mjs");
const GATE_FILE = join(ROOT, "tools", "release-gate.mjs");
const README = join(ROOT, "README.md");
const FIXTURE_ROOT = join(ROOT, "test", ".release-publish-fixtures", String(process.pid));

/** A version that was never released and never will be: this suite must not look like a release. */
const TARGET = "0.9.99";

let failures = 0;
const guarded = (name, fn) =>
  test(name, async (t) => {
    try {
      await fn(t);
    } catch (error) {
      failures += 1;
      throw error;
    }
  });

if (!existsSync(RELEASE_FILE)) {
  throw new Error(`the release command does not exist at ${RELEASE_FILE}: there is no gated publish path to test`);
}

/* --------------------------------------------------------------- fixtures */

function makeFixture(name) {
  const dir = join(FIXTURE_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const pkgRoot = join(dir, "pkg");
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({
    name: "dsh-agent-room", version: TARGET, type: "module", files: ["index.js"],
  }, null, 2));
  writeFileSync(join(pkgRoot, "index.js"), "export const room = 'fixture build';\n");

  const packDir = join(dir, "pack");
  const servedDir = join(dir, "served");
  const ledger = join(dir, "release-ledger.jsonl");
  const evidence = join(dir, "evidence.json");
  const config = join(dir, "config.json");
  const artifact = join(packDir, `dsh-agent-room-${TARGET}.tgz`);

  writeFileSync(evidence, JSON.stringify({
    tool: "fixture-gate",
    command: "node test/release-gate.test.mjs",
    new_version: TARGET,
    old_version: "0.9.98",
    assertion: "new assertions on the NEW build: 0 failure(s) | on the OLD build: 5 failure(s)",
  }, null, 2));
  writeFileSync(config, JSON.stringify({
    machinesRoot: join(dir, "machines"),
    machines: [{ id: "mai", address: "127.0.0.1", canary: true }],
  }, null, 2));

  const row = (extra) => appendFileSync(ledger, JSON.stringify({
    ts: `${new Date().toISOString().slice(0, 10)}T01:00:00.000Z`,
    version: TARGET, gate: "release", verdict: "released", actor: "author", evidence, reason: "seeded by the suite",
    ...extra,
  }) + "\n");

  return {
    dir, pkgRoot, packDir, servedDir, ledger, evidence, config, artifact,
    /** The gate is not the subject here: its own suite proves these entries. These are its INPUTS. */
    seedReleased: (version) => row({ version, gate: "release", verdict: "released" }),
    seedAcceptance: () => appendFileSync(ledger, JSON.stringify({
      ts: `${new Date().toISOString().slice(0, 10)}T02:00:00.000Z`, version: TARGET,
      gate: "acceptance", verdict: "accepted", actor: "reviewer-x", evidence, reason: "seeded by the suite (not the author)",
    }) + "\n"),
    seedCanary: () => appendFileSync(ledger, JSON.stringify({
      ts: `${new Date().toISOString().slice(0, 10)}T03:00:00.000Z`, version: TARGET,
      gate: "canary", verdict: "canary_passed", actor: "mai", evidence: "mai", reason: "seeded by the suite",
    }) + "\n"),
  };
}

/* ------------------------------------------------------------------ helpers */

/**
 * Run the release command and collect its output.
 *
 * ASYNC ON PURPOSE -- this is not style. The suite hosts the throwaway HTTP server in THIS process,
 * and a synchronous spawn (spawnSync) blocks the event loop for the child's entire lifetime, so the
 * server can never answer the child's own md5 read-back. The child then sits on undici's 300 s
 * header timeout: two of these tests "hung" for five minutes each and the compliant-publish case
 * failed on a timeout that the suite itself had caused. An async spawn leaves the loop free, so the
 * read-back this suite exists to prove actually happens.
 *
 * File stdio and `detached: false`, like every other child in this repo (D-39): a confined process
 * cannot reliably hand a child a pipe, and a detached launcher can exit 0 without ever running.
 */
async function runRelease(argv, env = {}) {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const outFile = join(FIXTURE_ROOT, `run-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const fd = openSync(outFile, "w");
  let status = -1;
  try {
    status = await new Promise((resolve) => {
      const child = spawn(process.execPath, [RELEASE_FILE, ...argv], {
        env: { ...process.env, DSH_RELEASE_RUN_DIR: join(FIXTURE_ROOT, "run"), ...env },
        detached: false, stdio: ["ignore", fd, fd],
      });
      child.on("error", () => resolve(-1));
      child.on("close", (code) => resolve(code ?? -1));
    });
  } finally {
    closeSync(fd);
  }
  const out = readFileSync(outFile, "utf8");
  rmSync(outFile, { force: true });
  return { exit: status, out };
}

function ledgerLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

const md5 = (file) => createHash("md5").update(readFileSync(file)).digest("hex");
const listing = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** The served bytes: the real file, or the real file with one byte appended (a tampering server). */
function startServer(dir, { tamper = false } = {}) {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(String(req.url).replace(/^\/+/, "").split("?")[0]);
    const file = join(dir, name);
    if (!existsSync(file)) { res.writeHead(404).end("not found"); return; }
    const body = tamper ? Buffer.concat([readFileSync(file), Buffer.from("tampered")]) : readFileSync(file);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

const common = (f, extra = []) => [
  "--version", TARGET, "--evidence", f.evidence, "--ledger", f.ledger, "--config", f.config,
  "--pack-root", f.pkgRoot, "--pack-dir", f.packDir, "--author", "author",
  // npm's default cache lives outside this workspace, where a confined process cannot write it
  // (EPERM), so the suite points npm's cache at its own fixture dir instead of relying on it
  "--cache", join(FIXTURE_ROOT, "npm-cache"), ...extra,
];

/* ============================================== 1. a refusal ships nothing */

guarded("refused: the gates say no, so nothing is packed, nothing is uploaded, and the ledger grows by one row", async () => {
  const f = makeFixture("refused");
  f.seedReleased("0.9.90");
  f.seedReleased("0.9.91"); // the day's quota is spent -> version-count refuses

  const r = await runRelease(common(f, ["--transport", `local:${f.servedDir}`, "--http-base", "http://127.0.0.1:1"]));

  assert.strictEqual(r.exit, 1, `a refused publish must exit non-zero, got ${r.exit}:\n${r.out}`);
  assert.match(r.out, /RELEASE GATE version-count REFUSED/);
  assert.match(r.out, /NOTHING PACKED, NOTHING UPLOADED/);

  // BYTES AND LISTINGS, not "it returned false"
  assert.deepStrictEqual(listing(f.packDir), [], "no .tgz may exist after a refusal");
  assert.deepStrictEqual(listing(f.servedDir), [], "nothing may be uploaded after a refusal");
  const rows = ledgerLines(f.ledger);
  assert.strictEqual(rows.length, 3, "the ledger may only gain the one refusal row the gate writes");
  assert.strictEqual(rows[rows.length - 1].gate, "release");
  assert.strictEqual(rows[rows.length - 1].verdict, "refused");
  assert.strictEqual(rows.filter((x) => x.gate === "publish").length, 0, "a refusal must never write a publish row");
});

/* ============================================== 2. a compliant publish */

guarded("published: one .tgz, uploaded, md5-verified over HTTP, and exactly one publish row naming it", async () => {
  const f = makeFixture("published");
  f.seedAcceptance();
  f.seedCanary();

  const server = await startServer(f.servedDir);
  try {
    const r = await runRelease(common(f, ["--transport", `local:${f.servedDir}`, "--http-base", server.base]));

    assert.strictEqual(r.exit, 0, `a compliant publish must exit 0, got ${r.exit}:\n${r.out}`);
    assert.match(r.out, /RELEASE GATE all-four ALLOWED/);
    assert.match(r.out, /VERIFIED .*byte-identical to the packed artifact/);
    assert.match(r.out, new RegExp(`RELEASE PUBLISHED: dsh-agent-room-${TARGET.replace(/\./g, "\\.")}\\.tgz`));

    assert.deepStrictEqual(listing(f.packDir), [`dsh-agent-room-${TARGET}.tgz`], "exactly one artifact");
    assert.deepStrictEqual(listing(f.servedDir), [`dsh-agent-room-${TARGET}.tgz`], "exactly one uploaded file");
    assert.strictEqual(md5(f.artifact), md5(join(f.servedDir, `dsh-agent-room-${TARGET}.tgz`)),
      "the uploaded file must be the packed file, byte for byte");

    const published = ledgerLines(f.ledger).filter((x) => x.gate === "publish");
    assert.strictEqual(published.length, 1, "exactly one publish row");
    const row = published[0];
    assert.strictEqual(row.verdict, "allowed");
    assert.strictEqual(row.version, TARGET);
    assert.strictEqual(row.artifact, `dsh-agent-room-${TARGET}.tgz`);
    assert.strictEqual(row.md5, md5(f.artifact), "the row must name the md5 of the artifact that shipped");
    assert.strictEqual(row.bytes, statSync(f.artifact).size);
    assert.ok(row.actor, "the publish row must name an actor");
    assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await server.close();
  }
});

/* ============================================== 3. the tree and --version must agree */

guarded("refused: publishing a version the tree does not claim is refused before the gates and before any pack", async () => {
  const f = makeFixture("version-drift");
  const r = await runRelease(common(f, []).map((a) => (a === TARGET ? "0.9.98" : a)));

  assert.strictEqual(r.exit, 1, `version drift must refuse, got ${r.exit}:\n${r.out}`);
  assert.match(r.out, /but .*package\.json says 0\.9\.99/);
  assert.match(r.out, /NOTHING PACKED, NOTHING UPLOADED/);
  assert.deepStrictEqual(listing(f.packDir), []);
  assert.deepStrictEqual(ledgerLines(f.ledger), [], "nothing may be written for a version the tree does not claim");
});

/* ============================================== 4. an unverifiable upload */

guarded("error: when the server serves DIFFERENT bytes the publish is undone -- no row, no artifact", async () => {
  const f = makeFixture("tampered-readback");
  f.seedAcceptance();
  f.seedCanary();

  const server = await startServer(f.servedDir, { tamper: true });
  try {
    const r = await runRelease(common(f, ["--transport", `local:${f.servedDir}`, "--http-base", server.base]));

    assert.strictEqual(r.exit, 2, `a bad md5 read-back must be an error, got ${r.exit}:\n${r.out}`);
    assert.match(r.out, /is NOT the artifact/);
    assert.match(r.out, /NOTHING IS LEFT PUBLISHED/);
    assert.deepStrictEqual(listing(f.packDir), [], "the local artifact must be deleted again");
    assert.deepStrictEqual(listing(f.servedDir), [], "the uploaded file must be removed again");
    assert.strictEqual(ledgerLines(f.ledger).filter((x) => x.gate === "publish").length, 0,
      "an unverifiable upload must never look published");
  } finally {
    await server.close();
  }
});

guarded("refused: an scp upload with no HTTP read-back is refused BEFORE anything is sent", async () => {
  const f = makeFixture("no-readback");
  f.seedAcceptance();
  f.seedCanary();

  const r = await runRelease(common(f, [
    "--transport", "scp",
    "--http-base", "none",
    "--remote", "nobody@203.0.113.1:/nonexistent/",
    "--askpass", join(f.dir, "no-such-askpass.cmd"),
  ]));

  assert.strictEqual(r.exit, 2, `an unverified upload must be refused, got ${r.exit}:\n${r.out}`);
  assert.match(r.out, /never read back is not verified/);
  // the askpass helper does not exist, so had the upload been attempted the error would be about IT
  assert.doesNotMatch(r.out, /askpass helper/, "the verification rule must be decided before any ssh/scp is attempted");
  assert.deepStrictEqual(listing(f.packDir), [], "the artifact is deleted again when the publish cannot be verified");
  assert.strictEqual(ledgerLines(f.ledger).filter((x) => x.gate === "publish").length, 0);
});

/* ============================================== 5. never ship over a shipped file */

guarded("refused: an existing artifact is not silently republished (its bytes are untouched)", async () => {
  const f = makeFixture("stale-artifact");
  f.seedAcceptance();
  f.seedCanary();
  mkdirSync(f.packDir, { recursive: true });
  writeFileSync(f.artifact, "not a real tarball\n");
  const before = md5(f.artifact);

  const r = await runRelease(common(f, ["--transport", `local:${f.servedDir}`, "--http-base", "http://127.0.0.1:1"]));

  assert.strictEqual(r.exit, 1, `an existing artifact must refuse, got ${r.exit}:\n${r.out}`);
  assert.match(r.out, /already exists/);
  assert.strictEqual(md5(f.artifact), before, "the file that was already there must not be touched");
  assert.deepStrictEqual(listing(f.servedDir), []);
  assert.strictEqual(ledgerLines(f.ledger).filter((x) => x.gate === "publish").length, 0);
});

/* ============================================== 6. the unsupported path stays unsupported */

guarded("documented: the gate names the supported command, and the README says the manual path bypasses every gate", () => {
  const gate = readFileSync(GATE_FILE, "utf8");
  assert.match(gate, /THE ONLY SUPPORTED PATH IS\s*->\s*node tools\/release\.mjs/);
  assert.match(gate, /BYPASSES ALL FOUR GATES/);
  assert.match(gate, /-Verify \/ -WatchdogOnly/, "the deliberately ungated read-only modes must stay named as such");

  const readme = readFileSync(README, "utf8");
  assert.match(readme, /node tools\/release\.mjs/);
  assert.match(readme, /only supported way to produce and publish/);
  assert.match(readme, /bypasses all four gates/i);
});

/* ------------------------------------------------------------------ footer */

test("summary", () => {
  assert.strictEqual(failures, 0, `${failures} release-publish case(s) failed`);
});
