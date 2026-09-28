/**
 * 0.2.14 — peer-only inbound tracking + freshness verdict.
 *
 * Run: node test/sync-freshness.test.mjs   (pure module: no room, no host, no clock)
 *
 * Why these cases exist (all measured on this fleet 2026-09-20):
 *   * `lastInboundFrom` is last-writer-wins INCLUDING this node: on AA it read
 *     "self" in 43 of 120 samples (35.8%) => a single read must not be used to
 *     decide "a peer just wrote".
 *   * the fleet can be silent for 2.5 days with nothing wrong => absence of peer
 *     frames is NOT staleness; it is "unknown".
 *   * staleness needs POSITIVE evidence: a peer announcing a snapshot newer than
 *     the local tree.
 */
import assert from "node:assert";
import { test } from "node:test";
import { createSyncHealth, noteInbound, freshnessOf, syncHealthView } from "../src/host/sync-health.js";

const SELF = "01a00000-0000-7000-8000-000000000001";
const PEER = "01a00000-0000-7000-8000-000000000002";

test("our own frame never counts as peer evidence", () => {
  const h = createSyncHealth();
  noteInbound(h, "2026-09-20T02:00:00.000Z", { from: SELF }, { selfAgentId: SELF });
  assert.strictEqual(h.lastInboundFrom, SELF, "raw field still records the frame");
  assert.strictEqual(h.lastPeerInboundAt, null, "peer field must stay empty");
  assert.strictEqual(h.lastPeerFrom, null);
});

test("a peer frame stamps the peer view (and the raw view)", () => {
  const h = createSyncHealth();
  noteInbound(h, "2026-09-20T02:00:01.000Z", { from: PEER }, { selfAgentId: SELF, snapshot: { updatedAt: "2026-09-20T01:00:00.000Z", rev: 7 } });
  assert.strictEqual(h.lastInboundFrom, PEER);
  assert.strictEqual(h.lastPeerInboundAt, "2026-09-20T02:00:01.000Z");
  assert.strictEqual(h.lastPeerFrom, PEER);
  assert.strictEqual(h.lastPeerSnapshotAt, "2026-09-20T01:00:00.000Z");
  assert.strictEqual(h.lastPeerSnapshotRev, 7);
});

test("without a known self id the peer fields are left alone (never guess)", () => {
  const h = createSyncHealth();
  noteInbound(h, "2026-09-20T02:00:02.000Z", { from: PEER }, {});
  assert.strictEqual(h.lastInboundFrom, PEER);
  assert.strictEqual(h.lastPeerInboundAt, null);
});

test("no peer snapshot yet => verdict is unknown, not stale", () => {
  const h = createSyncHealth();
  noteInbound(h, "2026-09-20T02:00:03.000Z", { from: PEER }, { selfAgentId: SELF });
  const f = freshnessOf(h, "2026-09-18T10:57:18.431Z", { authorityAgentId: PEER });
  assert.strictEqual(f.verdict, "unknown", JSON.stringify(f));
  assert.strictEqual(f.evidence.localUpdatedAt, "2026-09-18T10:57:18.431Z");
});

test("the AUTHORITY announcing a NEWER snapshot is positive evidence of staleness", () => {
  const h = createSyncHealth();
  noteInbound(h, "2026-09-20T02:03:23.000Z", { from: PEER }, { selfAgentId: SELF, snapshot: { updatedAt: "2026-09-20T02:03:23.045Z", rev: 1 } });
  const f = freshnessOf(h, "2026-09-18T10:57:18.431Z", { authorityAgentId: PEER });
  assert.strictEqual(f.verdict, "stale", JSON.stringify(f));
  assert.strictEqual(f.evidence.peerFrom, PEER);
  assert.strictEqual(f.evidence.peerIsAuthority, true);
});

test("an authority snapshot the local tree already covers is fresh", () => {
  const h = createSyncHealth();
  noteInbound(h, "2026-09-20T02:06:50.000Z", { from: PEER }, { selfAgentId: SELF, snapshot: { updatedAt: "2026-09-20T02:03:23.045Z", rev: 1 } });
  assert.strictEqual(freshnessOf(h, "2026-09-20T02:03:23.045Z", { authorityAgentId: PEER }).verdict, "fresh");
  assert.strictEqual(freshnessOf(h, "2026-09-20T02:06:48.447Z", { authorityAgentId: PEER }).verdict, "fresh", "local newer than the announced snapshot");
});

// The authority rule (2026-09-20, src-backed): staleness evidence only counts from
// the company node's leaderAgentId — the same identity `shouldApply` (sync.js) treats
// as authoritative. Otherwise a stale peer could convince a correct node it is stale
// and lock its exec plane out.
test("a NON-authority announcement proves nothing => unknown", () => {
  const OTHER = "01a00000-0000-7000-8000-000000000003";
  const h = createSyncHealth();
  noteInbound(h, "2026-09-20T09:00:00.000Z", { from: OTHER }, { selfAgentId: SELF, snapshot: { updatedAt: "2026-09-20T08:00:00.000Z", rev: 99 } });
  const f = freshnessOf(h, "2026-09-18T10:57:18.431Z", { authorityAgentId: PEER });
  assert.strictEqual(f.verdict, "unknown", JSON.stringify(f));
  assert.strictEqual(f.evidence.peerIsAuthority, false);
});

test("an empty authority in the local tree => unknown (never stale)", () => {
  const h = createSyncHealth();
  noteInbound(h, "2026-09-20T09:00:00.000Z", { from: PEER }, { selfAgentId: SELF, snapshot: { updatedAt: "2026-09-20T08:00:00.000Z", rev: 2 } });
  const f = freshnessOf(h, "2026-09-18T10:57:18.431Z", { authorityAgentId: "" });
  assert.strictEqual(f.verdict, "unknown", JSON.stringify(f));
  assert.match(f.reason, /no authority/);
});

test("the health view exposes the peer fields (so /agent-org-api/sync can be read as data)", () => {
  const h = createSyncHealth();
  noteInbound(h, "2026-09-20T02:00:04.000Z", { from: PEER }, { selfAgentId: SELF, snapshot: { updatedAt: "2026-09-20T02:00:00.000Z", rev: 3 } });
  const view = syncHealthView(h);
  assert.strictEqual(view.lastPeerInboundAt, "2026-09-20T02:00:04.000Z");
  assert.strictEqual(view.lastPeerFrom, PEER);
  assert.strictEqual(view.lastPeerSnapshotAt, "2026-09-20T02:00:00.000Z");
  assert.strictEqual(view.lastPeerSnapshotRev, 3);
  assert.strictEqual(view.degraded, false);
});

// 0.2.14 spec input from AA: one scalar is NOT enough — three writers touched its
// window (***** x29 / itself x43 / DD x48). Per-peer stamps let a monitor ask
// "is THIS colleague reachable" without continuous sampling.
test("per-peer stamps: a fresh peer does not hide a silent one", () => {
  const OTHER = "01a00000-0000-7000-8000-000000000003";
  const h = createSyncHealth();
  noteInbound(h, "2026-09-20T02:00:00.000Z", { from: PEER }, { selfAgentId: SELF });
  noteInbound(h, "2026-09-20T05:00:00.000Z", { from: OTHER }, { selfAgentId: SELF });
  const view = syncHealthView(h);
  assert.deepStrictEqual(Object.keys(view.lastInboundByPeer).sort(), [PEER, OTHER].sort());
  assert.strictEqual(view.lastInboundByPeer[PEER], "2026-09-20T02:00:00.000Z", "the silent peer keeps its own stamp");
  assert.strictEqual(view.lastInboundByPeer[OTHER], "2026-09-20T05:00:00.000Z");
  assert.strictEqual(view.lastPeerInboundAt, "2026-09-20T05:00:00.000Z", "derived scalar tracks the newest");
  assert.strictEqual(view.lastPeerFrom, OTHER, "derived 'from' names the newest peer, not the silent one");
});

test("our own frames never enter the per-peer map", () => {
  const h = createSyncHealth();
  noteInbound(h, "2026-09-20T05:00:01.000Z", { from: SELF }, { selfAgentId: SELF });
  assert.deepStrictEqual(syncHealthView(h).lastInboundByPeer, {});
});
