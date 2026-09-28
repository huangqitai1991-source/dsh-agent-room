/**
 * 0.1.53 — the room-level RECORD and its one carrier (`room.state`).
 *
 * WHY THIS EXISTS
 *   Until 0.1.53 every room-level field except `members` was write-only on the
 *   host: `transferController` and `updateSettings` each emitted a text
 *   `system.event` ("判定权已转移" / "房间设置已更新") and nothing else. A joined
 *   member therefore kept the values it saw at join time FOREVER — measured
 *   2026-09-20 on this fleet: two independent member nodes still showed the OLD
 *   `controllerAgentId` hours after a transfer, while the same snapshot showed the
 *   new `roles` (the roster half of that push did travel). It cost a false
 *   conclusion ("the handover never ran") before the divergence was traced.
 *
 * TWO-SIDED CONTRACT (neither half is optional)
 *   HOST   — the frame is produced only from the host's own service events on the
 *            broadcast surface, and a member's inbound frame of this type is never
 *            forwarded. The host relays member frames ("Forward service events to
 *            member sockets"), so arriving over the host connection is NOT proof
 *            that the host wrote it.
 *   MEMBER — apply only on the socket it holds for that room, and only when
 *            `roomRev` strictly advances. Member-side frames carry no
 *            `senderAgentId`, so monotonicity plus the host half is what makes the
 *            frame trustworthy; everything else is rejected WITH evidence.
 *
 * Kept pure so both halves can be asserted without a socket, a store or a clock.
 */
/**
 * Host side: build the frame payload from the authoritative room record.
 * `passwordHash` is dropped on purpose — it must never leave the host.
 */
export function buildRoomStatePayload(roomId, room, rev = Date.now(), hostTs = Date.now()) {
    const s = room.settings ?? {};
    return {
        roomId,
        roomRev: rev,
        hostTs,
        controllerAgentId: room.controllerAgentId ?? "",
        settings: {
            authMode: (s.authMode ?? "open"),
            autoMode: s.autoMode,
            maxMembers: s.maxMembers,
            allowHumanTakeover: s.allowHumanTakeover,
        },
        members: room.members ?? [],
    };
}
/**
 * Member side: the ONE place that turns a frame's host stamp into a measurement,
 * so the log wording and the `/state` number can never drift apart.
 *
 * `null` means "no usable hostTs"; a NEGATIVE value is returned as-is (the fleet's
 * clocks are not synchronised, so a receiver behind the host really does measure a
 * negative latency) — clamping it to 0 would manufacture a healthy-looking number
 * out of a clock defect.
 */
export function applyLatencyMs(hostTs, now) {
    if (typeof hostTs !== "number" || !Number.isFinite(hostTs) || !Number.isFinite(now))
        return null;
    return now - hostTs;
}
/**
 * The loggable form of `applyLatencyMs`:
 *   · a finite, non-negative delta  → `applyLatency=<n>ms`
 *   · a NEGATIVE delta              → `negative(<n>ms …)`, explicitly NOT clamped
 *   · a missing/non-numeric hostTs  → `unknown`, NEVER `applyLatency=0ms`
 *     ("judged-unreadable" must not read as "perfectly fast").
 */
export function describeApplyLatency(hostTs, now) {
    const ms = applyLatencyMs(hostTs, now);
    if (ms === null)
        return "applyLatency=unknown (frame carries no usable hostTs)";
    if (ms < 0)
        return `applyLatency=negative(${ms}ms — receiver clock is behind the host's; NOT clamped)`;
    return `applyLatency=${ms}ms`;
}
/**
 * Member side: may this frame be applied over the record we already hold?
 *
 * Applies ONLY a strictly larger `roomRev`. Equal or smaller ⇒ rejected (a replayed
 * or reordered frame must not roll the record back); a missing/non-numeric rev ⇒
 * rejected, because "unreadable" is not "new" (fail-closed).
 */
export function decideRoomStateApply(heldRev, payload) {
    const held = Number.isFinite(heldRev) ? Number(heldRev) : 0;
    if (!payload || typeof payload !== "object")
        return { apply: false, rev: held, reason: "empty payload" };
    const rev = typeof payload.roomRev === "number" && Number.isFinite(payload.roomRev) ? payload.roomRev : NaN;
    if (!Number.isFinite(rev))
        return { apply: false, rev: held, reason: "roomRev missing or not a number (fail-closed)" };
    if (rev <= held)
        return { apply: false, rev: held, reason: `roomRev ${rev} does not advance held ${held} (stale/replay)` };
    return { apply: true, rev, reason: `applied roomRev ${rev}` };
}
