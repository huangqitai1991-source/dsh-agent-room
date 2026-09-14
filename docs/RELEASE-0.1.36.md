# dsh-agent-room 0.1.36 — one send, one delivery (delivery-amplification P0)

Release date: 2026-09-13 (field release after the amplified-delivery measurement on the
live room `01a098a2-2015-7a1d-b5f7-9eca45afa65d`).

## Why this release exists

A single `[org:exec]` frame posted from one node was delivered to a room member **862 times in
1.94 s** (`executed=1`, `skipped(replay)=861`), while the room owner's own store held only ~8
copies of that id. Execution-level exactly-once held; **delivery amplified ~100×**. The same
class of defect had already produced 25,346 frames and a 411 MB audit log on 2026-09-12.

Reproduced on the shipped 0.1.35 code with a bounded in-process probe: **one send → 3638
deliveries in 195 ms to every member, with the owner's store holding exactly ONE row.**

## The mechanism (proved)

A frame this node **received** could become a frame this node **broadcast**:

1. `service.ts:1142` re-emits every inbound joined-room frame on the local `roomService` bus, so
   agent-org's exec plane sees control frames.
2. `peer-server.ts:150-157` listens to that **same** bus and turns each chat event into
   `broadcast(roomId, {type:"chat.message", payload})`.
3. `broadcast()` had no "have I sent this seq already" guard, and `handleConnection`
   (`peer-server.ts:495`) registers a self-join client's socket exactly like a remote member's.
4. `gateway.joinRoom` had **no self-join check** (`service.ts:1107-1169`); the 0.1.34 self-join
   fix only refused to *record* the join (`recordJoinedRecord`, `service.ts:943-962`) — it runs
   after the handshake succeeded (`room-client.ts:216-221`) and never closed the live socket.

So a node holding a **live client on a room it serves** re-received its own broadcast, re-emitted
it on the bus, and fanned it out again — forever, and **without a single extra store write**. That
is exactly why the field numbers show huge delivery with a tiny store: 862 deliveries cannot come
from 8 stored rows.

## What changed

Three small edits, no protocol change, no new frame types.

### 1. `src/host/peer-server.ts` — one stored frame, one broadcast

```ts
private readonly broadcastSeq = new Map<string, number>();   // roomId -> newest broadcast seq

if (this.alreadyBroadcast(roomId, message.seq)) return;      // in the `service.on("chat")` handler
this.broadcast(roomId, { type: "chat.message", payload: message });
```

`alreadyBroadcast()` remembers the highest **positive finite** seq broadcast for the room and drops
anything at or below it: a replay of a seq that already went out cannot be new traffic. Locally
appended optimistic rows (negative seq) are never emitted on the bus, so they are unaffected. The
map is cleared in `stop()`.

This is the choke point of the defect: it stops the cycle at iteration 2 whatever wiring produced
it (self-join, snapshot replay, backfill echo, or a future re-emit path).

### 2. `src/host/service.ts` — refuse a live self-join in `gateway.joinRoom`

After the handshake resolves the real `roomId`, a join is refused (client destroyed, error thrown,
rate-limited warning) when this node **serves** that room, or when the address that answered is one
of this node's own addresses. The room id is the reliable predicate — a room's published address can
be any of a node's NICs. The check runs **before** the client is wired into the service, so there is
nothing to undo.

### 3. `src/host/service.ts` — never leak the client being replaced

`this.clients.set(roomId, client)` used to overwrite an existing client silently. Every leaked client
keeps its socket, its `chat` handler and its sync loop — that is one more delivery of **every** frame.
The previous client is now `destroy()`ed before the replacement is stored.

## Acceptance (all demonstrated)

1. **One send ⇒ exactly one delivery per recipient**, including the author's own echo, with a live
   self-join client present, and the owner's store holding exactly one row
   (`test/amplification.test.mjs`).
2. **The amplifier is dead at the choke point**: a frame re-emitted on the very bus `PeerServer`
   listens to is broadcast once, not again (`test/amplification.test.mjs`). Both assertions fail on
   0.1.35 and pass here.
3. **Any number of deliveries ⇒ identical result** on the receiver: dsh-agent-org 0.2.10's
   `ExecResultCache` / `ExecPlane` behaviour is untouched (`test/exec-cache.test.mjs`, 12 passing).
4. **No regression**: agent-room 41 passing / 0 failing — protocol 8, snapshot 4, outbound 10,
   sendchat 4, backfill 10, backfill.e2e 3, amplification 2 (new). dsh-agent-org 29 passing /
   0 failing — permission 5, sync 4, visibility 8, exec-cache 12.

## Deliberately left out

- **The double browser push per received frame** (`service.ts:1138` plus the bus listener at
  `service.ts:207-211`) is cosmetic — both pushes carry the same seq — and was not changed.
- **A persistent per-room broadcast watermark.** It is in-memory by design: a restart re-derives
  nothing, because a stored frame is only broadcast live, never replayed from the store.
- **Refusing `room_join`/`POST /join` earlier than the handshake.** The check needs the owner's
  answer to know which room it really is; refusing on the typed address alone would reject a
  legitimate room that happens to be served on a shared host.

## Install / rollback

```
# install (tarball path from this release)
dsh plugin install ./dsh-agent-room-0.1.36.tgz
# or by hand
npm.cmd install ./dsh-agent-room-0.1.36.tgz

# rollback to the previous version
dsh plugin install ./dsh-agent-room-0.1.35.tgz
```

Rollback is safe: 0.1.36 adds no fields to any frame or store, changes no protocol, and only
refuses joins that would have created a self-join (a room the node already serves) — no legitimate
member path is affected. Live rooms need no data migration.
