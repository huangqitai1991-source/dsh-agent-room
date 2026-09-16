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
export function noteInbound(h, at, message = {}) {
  h.lastInboundAt = at;
  h.lastInboundFrom = message.from ?? h.lastInboundFrom ?? null;
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