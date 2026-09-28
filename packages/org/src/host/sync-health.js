/**
 * sync-health.js -- "can this node be reached right now?", as a readable fact instead of a silence.
 *
 * card-16 / 0.2.13. Measured 2026-09-16: a node left and rejoined its room, which tears the
 * agent-room channel that org control frames ride on. `syncReady` (set once at boot, never
 * re-evaluated) kept reporting itself fine, every control frame came back `queued`, and the only
 * symptom was a sender waiting 45 s for an answer that could never come.
 *
 * This module is deliberately PURE (no I/O, no clock of its own -- the caller passes the time) so
 * the judgement can be tested without a room, a socket or a plugin host.
 *
 * WHAT IT RECORDS
 *   lastOutboundOkAt   the last write that was PROVEN delivered (not "accepted", not "unknown")
 *   lastQueuedAt       the last write agent-room queued for replay => the channel was CLOSED
 *   lastQueuedLabel    what that frame was, so the failure is attributable
 *   unverifiedAt       the last write whose delivery could not be verified (agent-room too old)
 *   lastInboundAt/From the last frame RECEIVED here -- the strongest proof the room is readable
 *   lastErrorAt/Reason the last write that failed outright
 *
 * THE RULE: the newest BAD evidence (queued / unverified / error) versus the newest GOOD evidence
 * (a proven outbound write or any inbound frame). If bad is newer than good, the node is degraded.
 * A past failure stays readable -- it is history, not a verdict.
 */

export function createSyncHealth() {
  return {
    lastOutboundOkAt: null,
    lastQueuedAt: null,
    lastQueuedLabel: null,
    unverifiedAt: null,
    lastInboundAt: null,
    lastInboundFrom: null,
    // 0.2.14: the PEER view, kept apart from "whoever wrote last".
    // Measured 2026-09-20 on AA over 120 snapshots: `lastInboundFrom` read as
    // "self" in 43 of them (35.8%, longest run 32 samples ≈ 160 s), because it is
    // last-writer-wins across every writer including this node. A single read of
    // that field therefore cannot answer "did a peer just write" — these fields can.
    lastPeerInboundAt: null,
    lastPeerFrom: null,
    // 0.2.14 (spec input from AA, measured): a SINGLE scalar still gets
    // overwritten across peers — three writers touched its window (***** 29,
    // itself 43, DD 48), so "DD wrote a second ago" would make the scalar read
    // "fresh" for a peer that has been silent for hours. The map is the primary
    // record; `lastPeerInboundAt`/`lastPeerFrom` are derived from it.
    lastInboundByPeer: {},
    lastPeerSnapshotAt: null,
    lastPeerSnapshotRev: null,
    // WHO announced that snapshot. Staleness evidence only counts when it comes
    // from the AUTHORITY (the company node's leaderAgentId — the same identity
    // `shouldApply` already treats as authoritative in sync.js). A lead or a
    // stale peer announcing something older proves nothing about our copy.
    lastPeerSnapshotFrom: null,
    lastErrorAt: null,
    lastErrorReason: null,
  };
}

function newest(...stamps) {
  let best = null;
  for (const s of stamps) {
    if (!s) continue;
    if (best === null || String(s) > String(best)) best = s;
  }
  return best;
}

/**
 * Record the outcome of one control-frame write.
 * @param {ReturnType<typeof createSyncHealth>} h
 * @param {{ok?: boolean, queued?: boolean, unknown?: boolean, reason?: string, label?: string}} outcome
 * @param {string} at ISO timestamp supplied by the caller
 */
export function noteOutbound(h, outcome = {}, at) {
  if (outcome.ok === true && outcome.queued === true) {
    h.lastQueuedAt = at;
    h.lastQueuedLabel = outcome.label ?? null;
    return;
  }
  if (outcome.ok === true && outcome.unknown === true) {
    // "we could not verify it" is not "it worked" -- it gets its own field, never lastOutboundOkAt
    h.unverifiedAt = at;
    return;
  }
  if (outcome.ok === true) { h.lastOutboundOkAt = at; return; }
  h.lastErrorAt = at;
  h.lastErrorReason = outcome.reason ?? "unknown";
}

/** Record a frame that actually arrived here. @param {string} at @param {{from?: string}} message */
export function noteInbound(h, at, message = {}, opts = {}) {
  h.lastInboundAt = at;
  h.lastInboundFrom = message.from ?? h.lastInboundFrom ?? null;
  // 0.2.14: only a frame from SOMEONE ELSE is peer evidence. `opts.selfAgentId`
  // must be supplied for that judgement; without it we record the raw frame and
  // leave the peer fields alone (never guess).
  const self = opts.selfAgentId ?? null;
  const from = message.from ?? null;
  if (!from || !self || from === self) return;
  h.lastInboundByPeer = { ...(h.lastInboundByPeer ?? {}), [from]: at };
  const stamps = Object.values(h.lastInboundByPeer).filter(Boolean).map(String).sort();
  h.lastPeerInboundAt = stamps.length > 0 ? stamps[stamps.length - 1] : null;
  h.lastPeerFrom = Object.entries(h.lastInboundByPeer)
    .filter(([, ts]) => String(ts) === String(h.lastPeerInboundAt))
    .map(([agentId]) => agentId)[0] ?? from;
  const snap = opts.snapshot ?? null;
  if (snap) {
    if (snap.updatedAt) h.lastPeerSnapshotAt = snap.updatedAt;
    if (snap.rev !== undefined && snap.rev !== null) h.lastPeerSnapshotRev = snap.rev;
    h.lastPeerSnapshotFrom = from;
  }
}

/**
 * 0.2.14 — is the LOCAL org tree older than what the AUTHORITY has announced?
 *
 * POSITIVE EVIDENCE ONLY, and only from the authority. Quiet is normal, not
 * broken: measured on this fleet 2026-09-20, the gap between org frames reached
 * 2.5 days and AA's own tree sat frozen for 2 days with nothing wrong — so
 * "no peer frame for N minutes" must NOT be read as staleness. This returns:
 *   stale   — the AUTHORITY announced a snapshot NEWER than the local tree;
 *   fresh   — the authority announced one the local tree already covers;
 *   unknown — no announcement from the authority yet (the honest answer), which
 *             includes the case where only a NON-authority peer announced.
 *
 * The authority is the company node's `leaderAgentId` — the same identity
 * `shouldApply` (sync.js) uses, so freshness and convergence cannot disagree
 * about who is allowed to overwrite whom.
 *
 * @param {ReturnType<typeof createSyncHealth>} h
 * @param {string|null} localUpdatedAt the local tree's `updatedAt`
 * @param {{authorityAgentId?: string|null}} [opts]
 */
export function freshnessOf(h, localUpdatedAt, opts = {}) {
  const peerSnapshotAt = h?.lastPeerSnapshotAt ?? null;
  const peerFrom = h?.lastPeerSnapshotFrom ?? null;
  const authority = (opts.authorityAgentId ?? "").trim();
  const local = localUpdatedAt ?? null;
  const evidence = {
    peerSnapshotAt,
    peerFrom,
    localUpdatedAt: local,
    authorityAgentId: authority || null,
    peerIsAuthority: Boolean(authority) && peerFrom === authority,
    peerInboundAt: h?.lastPeerInboundAt ?? null,
  };
  if (!peerSnapshotAt || !local) return { verdict: "unknown", reason: "no peer snapshot seen yet", evidence };
  if (!authority) return { verdict: "unknown", reason: "no authority in the local tree (company leader empty)", evidence };
  if (peerFrom !== authority) return { verdict: "unknown", reason: "the announcement came from a non-authority peer", evidence };
  if (String(peerSnapshotAt) > String(local)) return { verdict: "stale", reason: "authority announced a newer tree", evidence };
  return { verdict: "fresh", reason: "authority snapshot is not newer than the local tree", evidence };
}

/** @returns {boolean} true when the newest bad evidence is newer than the newest good evidence */
export function isSyncDegraded(h) {
  const bad = newest(h.lastQueuedAt, h.unverifiedAt, h.lastErrorAt);
  if (bad === null) return false;
  const good = newest(h.lastOutboundOkAt, h.lastInboundAt);
  if (good === null) return true;
  return String(bad) > String(good);
}

/** A copy (holding the view must not let a caller rewrite the record), plus the computed verdict. */
export function syncHealthView(h) {
  return {
    lastOutboundOkAt: h.lastOutboundOkAt,
    lastQueuedAt: h.lastQueuedAt,
    lastQueuedLabel: h.lastQueuedLabel,
    unverifiedAt: h.unverifiedAt,
    lastInboundAt: h.lastInboundAt,
    lastInboundFrom: h.lastInboundFrom,
    // 0.2.14: the peer-only view (see createSyncHealth for why lastInboundFrom alone is not enough)
    lastPeerInboundAt: h.lastPeerInboundAt,
    lastPeerFrom: h.lastPeerFrom,
    // per-peer view: lets a monitor judge "is THIS colleague reachable" without
    // continuous sampling (0.2.14 spec input from AA)
    lastInboundByPeer: { ...(h.lastInboundByPeer ?? {}) },
    lastPeerSnapshotAt: h.lastPeerSnapshotAt,
    lastPeerSnapshotRev: h.lastPeerSnapshotRev,
    lastPeerSnapshotFrom: h.lastPeerSnapshotFrom,
    lastErrorAt: h.lastErrorAt,
    lastErrorReason: h.lastErrorReason,
    degraded: isSyncDegraded(h),
  };
}

/**
 * Should this failed control-frame write trigger ONE re-assert of the sync subscription?
 *
 * card-16. A `queued` outcome means agent-room queued the frame because the channel to the room is
 * closed -- the established repair is to re-assert listening for that room, then retry ONCE.
 * The rule is deliberately narrow, because the failure mode this replaces was "wait 45 s in
 * silence", and the failure mode a careless fix introduces is a retry storm:
 *   * only a QUEUED frame qualifies (a refused/unknown write is not a closed channel);
 *   * never more than `maxAttempts` (default 1) re-asserts per call;
 *   * an already-degraded record still gets its one attempt -- that is what repairs it.
 * @returns {boolean}
 */
export function shouldReassert(outcome = {}, attemptsSoFar = 0, maxAttempts = 1) {
  if (attemptsSoFar >= maxAttempts) return false;
  return outcome.ok === true && outcome.queued === true;
}
/**
 * The request that repairs a torn sync subscription (card-16), as pure data so it can be asserted
 * without a host, a room or the plugin SDK. The service just performs it.
 * @returns {{url: string, init: {method: string, headers: object, body: string}}}
 */
export function reassertRequest({ roomId, base = "http://127.0.0.1:3080" } = {}) {
  const root = String(base).replace(/\/+$/, "");
  return {
    url: `${root}/agent-room-api/rooms/${roomId}/listening`,
    init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }) },
  };
}