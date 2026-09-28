# dsh-agent-room 0.1.35 — member-side room convergence (backfill) + honest delivery

Release date: 2026-09-13 (field release after the missing-message measurement on the
live room `01a098a2-2015-7a1d-b5f7-9eca45afa65d`).

## Why this release exists

A member's mirror of a room it only JOINED was built from a single handshake
snapshot plus whatever live frames happened to arrive. Nothing ever pulled a
missed message back.

Measured on live machines that day:

| where | what the room looked like |
| --- | --- |
| owner's store (D's node) | `total=200`, `orgFrames=144`, `maxSeq=270` |
| member's read view (主控) | **9–11 messages**, with holes: held `265, 266, 268, 269, 270, 271, 274`, missing `267` and `272` |

The human using the member machine could not see messages that demonstrably
existed on the owner (they reported 266/267/270/272 as invisible) and concluded
that an agent had gone silent while it had in fact spoken. Even worse, the
member's own `latestSeq` was derived **from that very mirror**
(`service.ts` joined-room branch: `msgs[msgs.length - 1].seq`), so an incomplete
mirror reported a smaller number and the lag was structurally invisible.

Causes, all in the member's projection path: the join snapshot is deliberately
tiny (`HANDSHAKE_SNAPSHOT_MESSAGES = 50`, `HANDSHAKE_SNAPSHOT_BYTES = 12 KB`,
`SNAPSHOT_SCAN_MESSAGES = 400`, control frames filtered by `isControlFrame`), a
bridge flap / reconnect / budget trim silently dropped frames, and **nothing ever
converged**: the local max seq could sit below the owner's forever until the user
rejoined by hand.

---

## 1. Convergence: lag detection, gap fill, bounded backfill

### New wires (owner ⇄ member)

`src/host/protocol.ts`:

```ts
| { type: "chat.stat";    payload: {} }                                   // client → owner
| { type: "chat.fetch";   payload: { fromSeq: number; toSeq: number } }   // client → owner
| { type: "chat.stat";    payload: { latestSeq: number; latestChatSeq: number } }
| { type: "chat.backfill"; payload: { fromSeq; toSeq; messages; latestSeq; latestChatSeq; truncated } }
```

Ceilings are protocol constants so owner and member cannot drift:

```ts
export const SYNC_VERSION = 1;
export const SYNC_FETCH_MAX_SPAN = 200;      // seqs the owner examines per request
export const SYNC_FETCH_MAX_MESSAGES = 50;   // messages returned per request
export const SYNC_FETCH_MAX_BYTES = 32 * 1024;
```

`RoomSnapshot` gained the owner's authoritative numbers (0.1.35):

```ts
latestSeq?: number;      // raw max seq, control frames INCLUDED ("maxSeq 270")
latestChatSeq?: number;  // newest seq the READ VIEW can reach (non-control)
syncVersion?: number;    // 1 = owner answers chat.fetch / chat.stat
```

`latestChatSeq` — not the raw max — is the convergence target, because control
frames never enter the read view, so a visible max can only ever equal the newest
*visible* seq.

### Owner side

- `src/host/persistence.ts` — new `loadMessagesInRange(roomId, from, to, limit)`:
  fast path answers from the tail window, and only reaches below it (full read)
  when the requested range genuinely starts before the window — the same policy as
  the existing `before` cursor.
- `src/host/room-service.ts` — new `latestSeq(roomId)` (O(1), the in-memory seq
  counter) and `messagesInRange(roomId, from, to, limit)`.
- `src/host/peer-server.ts` — `seqInfo()` (kept warm by a `chatSeqHint` updated by
  the chat event, so a probe never re-reads the store), `handleChatFetch()`
  (filters control frames, caps span/count/bytes, and reports `toSeq` = the highest
  seq actually **examined**), plus the two new `handleFrameFrom` cases, and
  `takeWithinBytes()` (keeps the oldest rows of a batch, so a truncated reply is
  always a strict step forward).

### Member side — `src/host/backfill.ts` (new, pure + testable)

```ts
export const BACKFILL_LAG_THRESHOLD = 3;        // seqs behind before the tail is asked for
export const BACKFILL_BATCH_SEQS = 50;          // ≤ 50 seqs per request
export const BACKFILL_MAX_RANGES = 3;           // ranges per plan
export const BACKFILL_MIN_INTERVAL_MS = 2_000;  // pacing
export const BACKFILL_BACKOFF_BASE_MS = 2_000;  // 2s, 4s, 8s … capped at 60s
export const BACKFILL_REQUEST_TIMEOUT_MS = 8_000;
export const BACKFILL_QUIET_MS = 5_000;         // quiet stream ⇒ ask even for a small lag
export const BACKFILL_POLL_MS = 15_000;         // chat.stat probe cadence
export const MAX_READ_VIEW_CONFIRMED = 2_000;   // read-view memory floor
```

- `planBackfill()` — interior holes first (definitive losses: the owner's seq
  numbers skip them), then the tail if it lags by more than the threshold, or by
  anything at all once the stream has gone quiet. Every hole in the live case
  (`265, 266, [267], 268, …, 274` with owner at 274) becomes exactly
  `[{267,267},{271,274}]` — never a whole history (the empty-mirror case requests
  the last batch only).
- `BackfillState` — one request in flight, 2s pacing, exponential backoff after an
  unanswered request, and a **settled** set: a range the owner has answered is
  never asked for again. That is what makes the loop terminate, because control
  frames own seq numbers the member can never fill.
- `mergeBackfill()` — merges by seq, drops duplicates, never overwrites an
  existing row, never touches locally appended pending rows (0.1.34's negative-seq
  optimistic rows), sorts confirmed rows by seq and keeps pending rows last. The
  read view is bounded by dropping the oldest confirmed rows (a hole below the
  floor is outside the planner's scan, so it is not re-requested).
- `RoomClient` (member) — adopts the snapshot's `syncVersion`/`latestSeq`/
  `latestChatSeq`, starts a 15s `chat.stat` probe (the only way to notice a lag
  when the frames that would have revealed it never arrived), and runs one bounded
  round per tick: plan → single request → merge → re-plan. A converged member asks
  for nothing. An owner that does not advertise sync support is never asked
  (pre-0.1.35 behaviour preserved, no pointless traffic).

### Control-frame rule preserved

`isControlFrame` filtering is unchanged and now enforced on every path that
feeds the read view:

- the handshake snapshot (as before),
- the member's live ingest (`chat.message` no longer enters `snapshot.recentMessages`),
- the SSE push in `service.ts` (the browser UI appends a pushed message straight
  into the visible list, so pushing a control frame was a read-view leak),
- the backfill merge (a backfilled range can contain control frames; they are dropped).

Control frames still reach every **consumer**: `RoomClient` still emits `chat` for
them, `service.ts` still re-broadcasts them on the local `roomService` bus (how
dsh-agent-org's exec plane receives them), and `noteOwnReply` still sees them.
The e2e test asserts exactly this split.

## 2. Honest delivery truth (`delivered` was a lie by degree)

For a JOINED room `sendChat` reported `delivered: true` when the local hub wrote
the frame to an OPEN socket — nothing more. Field data showed three frames
reported delivered that the owner never stored, and three others that did arrive:
the sender could not tell the two cases apart.

`src/host/outbound.ts`:

```ts
export interface ChatDeliveryStatus {
  acceptedByLocalHub: boolean;   // the LOCAL hub wrote it towards the owner (or queued it)
  confirmedByOwner: boolean;     // the OWNER echoed it back with its own seq — the only proof
  confirmedSeq?: number;         // the owner's seq, when confirmed
  confirmNote?: "owner-confirmed" | "not-confirmed-in-time" | "not-attempted";
  delivered: boolean;            // DEPRECATED alias of acceptedByLocalHub (agent-org 0.2.10 reads it)
  queued: boolean;
  reason?: string;
  queueLength: number;
}
export const OWNER_CONFIRM_WAIT_MS = 1_500;
```

- `RoomClient.awaitOwnerEcho(text, timeoutMs)` resolves with the owner's seq when
  the owner's confirmed echo of our own message arrives, and `null` otherwise
  (bounded wait, waiter list capped).
- `AgentRoomService.gateway.sendChat` (joined room) waits at most 1.5s for that
  echo and fills `confirmedByOwner`/`confirmedSeq`/`confirmNote`, warning once a
  minute per room when a message was accepted but never confirmed — the exact
  silence that used to be invisible.
- `POST /agent-room-api/rooms/<id>/chat` and the `room_send` tool return the same
  fields (`seq` is now the owner's confirmed seq when known). Both still return
  `delivered`, documented as the deprecated alias, so dsh-agent-org 0.2.10's
  `isDeliveryReport()` keeps working unchanged.

## 3. Browser state stops trusting the mirror

`service.ts` `browserState()`:

- joined rooms now report `latestSeq` = the **owner-reported** latest visible seq,
  and the local value separately as `localLatestSeq`, plus a `sync` block
  (`ownerLatestSeq`, `ownerLatestChatSeq`, `lag`, `settled`, `inflight`,
  `requestsSent`, `messagesAdded`, `duplicatesSkipped`, `failures`, `reason`,
  `converged`). While the two differ, the panel can say the room is still catching
  up instead of presenting an incomplete mirror as the truth.

---

## Acceptance (all demonstrated)

1. A member whose mirror lags converges to the owner's message set without a
   manual rejoin, **gaps included**, and its visible max seq ends up equal to the
   owner's latest visible seq (`test/backfill.e2e.mjs`, both the interior-hole
   phase and the tail-lag phase; `localLatestSeq() === ownerLatestChatSeq` asserted).
2. No duplicate rows, no clobbered pending rows, no storms: the same test asserts
   `new Set(seqs).size === seqs.length`, that the pending row is still present and
   still last, and that requests stayed within 6 requests / one owner query per
   request for a 5-message catch-up (log lines "requesting seqs a-b (gap, lag=…)"
   are the batch evidence).
3. Control-frame filtering from the read view is unchanged: no `[org:` row ever
   appears in the read view (snapshot, live, SSE, backfill), while the same frames
   still arrive on the `chat` event / roomService bus for agent-org.

## Verification

```
npx tsc --noEmit                        # clean
node build.mjs                          # lib/host/*, lib/client.js, lib/skills/
node test/protocol.test.mjs             # 8 passing
node test/snapshot.test.mjs             # 4 passing
node test/outbound.test.mjs             # 10 passing (assertions updated: honest status fields)
node test/sendchat.test.mjs             # 4 passing (assertions updated: honest status fields)
node test/backfill.test.mjs             # 10 passing (new: lag/gap planning, merge/pending, bounds)
node test/backfill.e2e.mjs              # 3 passing (new: real owner + member convergence, echo confirmation)
```

`test/backfill.test.mjs` and `test/backfill.e2e.mjs` are new. `outbound.test.mjs`
and `sendchat.test.mjs` keep their test count but their `toDeliveryStatus`
assertions were updated for the deliberate contract change above (the shape gained
the honest fields; `delivered` is retained).

The e2e file runs a real `RoomService` + `PeerServer` + `RoomClient` in its own
process on `127.0.0.1` (`test/backfill.e2e.mjs`); it starts, stops and contacts no
DSH service.

## Install / rollback

```
# install (tarball path from this release)
dsh plugin install ./dsh-agent-room-0.1.35.tgz
# or by hand
npm.cmd install ./dsh-agent-room-0.1.35.tgz

# rollback to the previous version
dsh plugin install ./dsh-agent-room-0.1.34.tgz
```

Rollback is safe: 0.1.35 adds optional fields to `RoomSnapshot` and
`ChatDeliveryStatus`, adds two client-initiated frames a 0.1.34 owner answers with
`error: unknown-frame-type` (the member only asks after the owner advertises
`syncVersion`), and filters control frames out of the read view. Local stores,
room files and `joined.json` are untouched.

## Deliberately left out

- **Persistent per-room mirrors on the member.** Convergence is in-memory; the
  member still rebuilds its mirror from the handshake snapshot after a restart.
  Filling that from the owner's store is a different change (it needs a durable
  local seq watermark).
- **Backfilling below the read-view floor** (`MAX_READ_VIEW_CONFIRMED = 2000`).
  Older history is out of scope; only the newest 2000 confirmed rows are tracked.
- **UI rendering of the new `sync` block.** The host exposes it
  (`ApiRoom.sync`); the panel does not draw a "catching up" badge yet.
- **Control frames in the read view on the OWNER's own machine.** The owner's
  read view was not changed in this release (out of scope; only the member path
  and the SSE push were touched).
