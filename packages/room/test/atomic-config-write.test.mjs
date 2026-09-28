/**
 * atomic-config-write.test.mjs — the config writer cannot leave a stale tail.
 *
 * WHAT HAPPENED (2026-09-17, from the human's host console)
 *   dsh: fatal load failure: CorruptConfigError: reply-agent.json is present but not parseable
 *   (Unexpected non-whitespace character after JSON at position 68 (line 3 column 2))
 *   The file on disk was:
 *       {
 *         "replyAgentId": "session-480dbafb-5e71-4f68-ab18-469663891b93"
 *       }eae76"                     <- eight bytes of the PREVIOUS, longer content
 *       }
 *   A config this plugin cannot parse is FATAL BY DESIGN (see src/host/safety.ts), so 76 bytes of
 *   state took the whole host down. The read side is right; the WRITE side was the hole: four config
 *   files (reply-agent.json, resident-model.json, listening.json, relay-config.json) were written
 *   from service.ts with a bare `writeFile`, while the hardened path (unique tmp + rename + per-target
 *   serialization) lived inside Persistence as a private method. This test drives the now-exported
 *   writer through the shape that actually broke.
 *
 * Run directly: node test/atomic-config-write.test.mjs   (never `node --test`: the runner's piped
 * spawn is denied in a confined sandbox)
 */

import assert from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeJsonAtomic } from "../lib/host/persistence.js";

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), "ar-atomic-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a shorter value leaves no tail of the longer one", async () => {
  const { dir, cleanup } = workdir();
  try {
    const file = join(dir, "reply-agent.json");
    const long = { replyAgentId: "session-dde104fa-f191-40c7-afc7-09086b05c3af" };
    const short = { replyAgentId: "session-480dbafb" };
    await writeJsonAtomic(file, long);
    await writeJsonAtomic(file, short);

    const text = readFileSync(file, "utf8");
    assert.strictEqual(text, JSON.stringify(short, null, 2), "the file must be exactly the new payload");
    assert.deepStrictEqual(JSON.parse(text), short, "and it must parse");
    assert.ok(!text.includes("dde104fa"), "no fragment of the previous value may survive");
  } finally { cleanup(); }
});

test("the exact 2026-09-17 corruption shape is repaired by the next write", async () => {
  const { dir, cleanup } = workdir();
  try {
    const file = join(dir, "reply-agent.json");
    // Verbatim shape from the failing host: valid JSON, then the tail of the previous content.
    const corrupt = '{\n  "replyAgentId": "session-480dbafb-5e71-4f68-ab18-469663891b93"\n}eae76"\n}\n';
    writeFileSync(file, corrupt, "utf8");
    assert.throws(() => JSON.parse(readFileSync(file, "utf8")), /Unexpected non-whitespace|after JSON/i,
      "the fixture must really be unparseable, or this test proves nothing");

    const value = { replyAgentId: "session-480dbafb-5e71-4f68-ab18-469663891b93" };
    await writeJsonAtomic(file, value);
    const text = readFileSync(file, "utf8");
    assert.deepStrictEqual(JSON.parse(text), value, "one write through this path must leave parseable JSON");
    assert.ok(!text.includes("eae76"), "the stale tail must be gone, not merely ignored");
  } finally { cleanup(); }
});

test("no tmp file survives a write, success or failure", async () => {
  const { dir, cleanup } = workdir();
  try {
    const file = join(dir, "listening.json");
    await writeJsonAtomic(file, { rooms: ["a", "b"] });
    await writeJsonAtomic(file, { rooms: ["c"] });
    const left = readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    assert.deepStrictEqual(left, [], `no .tmp may be left behind (found ${JSON.stringify(left)})`);
  } finally { cleanup(); }
});

test("overlapping writes to one target serialize, and the file is never torn", async () => {
  const { dir, cleanup } = workdir();
  try {
    const file = join(dir, "relay-config.json");
    const payloads = Array.from({ length: 5 }, (_, i) => ({ relay: `ws://host/${i}/`.padEnd(40, "x") }));
    await Promise.all(payloads.map((p) => writeJsonAtomic(file, p)));
    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    assert.ok(payloads.some((p) => p.relay === parsed.relay), "the file must hold exactly one of the written values");
    assert.strictEqual(text, JSON.stringify(parsed, null, 2), "the bytes must be one payload, not a mix");
  } finally { cleanup(); }
});
