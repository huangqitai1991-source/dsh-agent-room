# dsh-agent-room 0.1.34 — joined-room delivery, self-join, stale records, read view

Release date: 2026 (field rollout after the 2026-09-12 reconnect-loop incident and
the 923 MB audit-log measurement).

## Why this release exists

Four defects were proven with code locations on live machines. Together they made
a member's traffic to the owner's room *look* delivered while it silently
vanished, made one node execute every frame twice, made another node retry a
closed room forever, and made a sender wait out its own timeout for an answer
that had already been produced.

---

## 1. Joined-room outbound was silently dropped

**Before**

`src/host/service.ts` (~924-935):

```ts
const client = this.clients.get(roomId);
if (!client) throw new Error(`房间不存在: ${roomId}`);
client.sendChat(input);
return null;                       // no delivery confirmation at all
```

`src/host/room-client.ts` (~480-484):

```ts
private sendFrame(frame: ClientFrame): void {
  if (this.socket?.readyState === WebSocket.OPEN) {
    this.socket.send(JSON.stringify(frame));
  }
  // <- no else branch: the frame simply vanished
}
```

An owned room got an authoritative write with a real `seq`; a joined room got
`null` and no evidence of delivery. While the socket was CONNECTING / CLOSING /
CLOSED every frame disappeared without a log line, so a member's message never
arrived and an exec *result* never came back.

**After**

- `src/host/outbound.ts` (new) — `OutboundQueue` / `OutboundHub` /
  `toDeliveryStatus()`. The queue is **per-room state owned by the service**
  (`private readonly outbound = new OutboundHub()`), never on the socket, never
  on `RoomClient`, and never behind a captured gateway reference — so a reconnect
  that replaces the socket or the client cannot orphan it. A test proves exactly
  that (`the queue survives a socket/client swap`).
- Only **control frames** queue (`[org:exec]` / `[org:exec:result]` /
  `[org:snapshot]`, via `isControlFrame()`, now living in `src/host/protocol.ts`
  and re-exported from `peer-server.ts`). Plain chat is reported but never
  queued: a chat line replayed minutes later is noise, not delivery.
- **Overflow never drops the oldest in-flight frame.** `MAX_QUEUED_FRAMES = 200`,
  `MAX_QUEUED_BYTES = 512 KB`; on overflow the NEW frame is rejected and the
  caller is told (`reason: "queue-full(frames=200)"`). Queueing and rejection
  both log a rate-limited warning (one per room per minute).
- `RoomClient.sendFrame` now returns `boolean`, warns (rate-limited) when the
  socket is not OPEN, and fails honestly when `send()` throws on an OPEN socket.
- Flush triggers: `connection === "open"`, a fresh `snapshot` (handshake
  finished), and right after a join. A flush stops at the first failed delivery
  and keeps the remainder queued, so exec order survives.

**Delivery status (replaces `null`)**

```ts
export interface ChatDeliveryStatus {
  delivered: boolean;   // written to an OPEN socket
  queued: boolean;      // parked in the room's control-frame queue
  reason?: string;      // "channel-not-open" | "queue-full(...)" | ...
  queueLength: number;  // pending frames in that room afterwards
}
```

`RoomGateway.sendChat` is now `Promise<ChatMessage | ChatDeliveryStatus>`;
`room_send`, `POST /agent-room-api/rooms/<id>/chat` and dsh-agent-org all consume
it (a status object instead of a bare `seq: null`).

## 2. Self-join double delivery

**Before** — a node could hold a `joined.json` record pointing at its OWN
address, so every frame was delivered twice (the same exec id twice inside 1 ms;
one machine's audit log reached 923 MB).

**After** (`service.ts`):

- `recordJoinedRecord()` refuses to persist a record when
  `roomService.getOwnedRoom(record.roomId)` exists or when the record's address
  matches one of this node's own addresses (`ownAddresses()` +
  `normaliseAddress()`, which ignores scheme/path so `ws://host:port/` still
  matches `host:port`). Any older copy on disk is removed.
- Boot-time pruning does the same for existing records.

## 3. Stale room records were never cleaned

**Before** (`service.ts` ~758 in the shipped build):

```ts
if (relay && record.address.replace(/\/+$/, "") !== relay) { /* only here can it drop */ }
```

A dead **relay-hosted** room has exactly the relay address as its record address,
so that predicate can never hold: the node retried a closed room forever. And
`POST /agent-room-api/rooms/<id>/leave` answered HTTP 500 for such a room because
`leaveRoom` threw `房间不存在` when no live client existed — the one action that
could have cleaned it up was blocked by the cleanup being impossible.

**After**

- Staleness is decided by the **join result**, not by address shape:
  `classifyJoinFailure()` → `stale` (room-not-found / closed → record dropped
  immediately), `rejected` (owner answered and refused → retried with bounded
  backoff `REJOIN_BACKOFF_MS` × attempt, max 3 attempts, then dropped),
  `transient` (timeout / refused connection / relay interruption → record KEPT,
  because the room may be perfectly alive).
- `leave` is best-effort: the client is closed and removed, queued frames are
  dropped, and the local record is removed **whatever the remote outcome**. The
  route returns 200 with a `warn` field instead of 500 when only the remote half
  failed.
- New `RoomService.removeJoinedRoom(roomId)` does the local write.

## 4. Read view — the sender sees its own message and its seq

- `RoomClient.appendLocal()` adds an optimistic row to the local projection with
  a NEGATIVE seq and `pending: true`; `browserMessages`/`roomInfo` therefore
  return the owner's confirmed stream merged with locally appended rows, without
  rejoining.
- When the owner's confirmed frame arrives, `adoptPending()` matches it (sender +
  text, oldest first) and stamps the real `seq` on the existing row instead of
  adding a duplicate — and still emits it, so `noteOwnReply`/activate-chat see
  our own message. `pending` rows survive a reconnect snapshot (re-attached) and
  are excluded from `before`-paging.
- `ChatMessage` gains `pending?: boolean` and `localId?: string`.

---

## Acceptance criteria

1. A control frame sent while the channel is not OPEN is queued (never silently
   dropped), unless the queue is full — in which case the NEW frame is rejected
   with a reason and the oldest stays queued.
2. `sendChat` on a joined room returns `{delivered, queued, reason?, queueLength}`
   in every case; it never returns `null`.
3. A queued control frame is flushed in order when the channel becomes OPEN, and
   a failed flush keeps the remainder queued.
4. The queue survives replacing the socket/client object for that room.
5. No joined record is created for a room this node owns, and boot pruning removes
   existing self-join records (owned room or own address).
6. A room that answers room-not-found/closed loses its local record immediately;
   a refused join loses it after bounded backoff; a transient failure keeps it.
7. `leave` on a dead room returns 200 and the local record is gone.
8. A sender's own message is visible (pending) before confirmation and carries its
   real `seq` after, without rejoining.

## Verification

```
npx tsc --noEmit                        # clean
node build.mjs                          # lib/host/*, lib/client.js, lib/skills/
node test/protocol.test.mjs             # 8 passing
node test/snapshot.test.mjs             # 4 passing
node test/outbound.test.mjs             # 10 passing (new: queue/overflow/flush)
node test/sendchat.test.mjs             # 4 passing (new: sendChat status object)
```

## Install / rollback

```
# install (tarball path from this release)
dsh plugin install ./dsh-agent-room-0.1.34.tgz
# or by hand
npm.cmd install ./dsh-agent-room-0.1.34.tgz

# rollback to the previous version
dsh plugin install ./dsh-agent-room-0.1.33.tgz
```

Rollback is safe: 0.1.34 only adds fields to `ChatMessage` and changes the
joined-room `sendChat` return value, which older callers ignored anyway.
dsh-agent-org 0.2.10 requires >= 0.1.34 for verified delivery; with an older
agent-room it degrades to "accepted, unverified" and logs a rate-limited warning
instead of retrying blindly.
