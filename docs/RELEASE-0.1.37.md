# dsh-agent-room 0.1.37 — self-join address classification (regression fix)

Release date: 2026-09-13 (hotfix after the member-lockout measurement on the live machine
`主控`, room `01a098a2-2015-7a1d-b5f7-9eca45afa65d`).

## Why this release exists

0.1.36's self-join refusal was correct in intent and wrong in one predicate. On the live machine
`主控`, every attempt to join **another** node's room was refused as a self-join:

```json
POST /agent-room-api/join  {"roomId":"01a098a2-2015-7a1d-b5f7-9eca45afa65d",
                            "address":"192.168.31.82:9317"}
{"ok":false,"error":"不能通过本机自己的地址加入房间（self-join）: 192.168.31.82:9317"}
```

`192.168.31.82` is **not** an address of `主控` — its IPv4 interfaces are exactly `100.64.44.107`
(Tailscale), `172.19.208.1` (MEmu), `192.168.137.1`, `192.168.31.204` (WLAN), `127.0.0.1`. That
address is the **room OWNER** (小婷), as its own discovery beacon says:

```json
{"kind":"agent-room.beacon","nodeId":"01a09483-3668-7bdf-9cc2-0180f314c8cf",
 "roomId":"01a098a2-2015-7a1d-b5f7-9eca45afa65d","addresses":["192.168.31.82:9317"]}
```

Consequence: the node could not join the room at all — it could not read messages, and its sends
failed with `{"ok":false,"error":"房间不存在: …"}`. It was locked out of a room it is an ordinary
member of (4 members).

## The wrong condition (exact)

`src/host/service.ts`, `ownAddresses()` — the helper the refusal consults:

```ts
for (const candidate of this.lanCandidates()) add(candidate);   // 0.1.36 — WRONG
```

`lanCandidates()` is the **join-candidate** helper (`setConnectionMode` uses it), documented as
"manual address -> addresses seen in LAN beacons -> this node's own interface candidates". Feeding it
into a predicate named "addresses of this node's own room server" made **every remote owner whose
beacon this node had ever discovered** look like itself. The refusal then fired at
`service.ts` (the `ownAddresses().has(normaliseAddress(client.address))` branch, ~line 1155-1162) with
the requested address being the owner's address.

So the caller's hypothesis (a local joined record colliding with the requested address) is **not**
the cause: `ownAddresses()` never reads `joined.json` and never reads the room's `serverAddress`. The
beacon list reached through `lanCandidates()` is the cause, and it explains the two side effects
too — `recordJoinedRecord()` and `autoRejoinJoinedRooms()` share the same predicate, so a legitimate
joined record was ALSO refused at record time and pruned at every boot ("this node's own address"),
which is why the node never auto-rejoined either.

## What changed

One edit, no protocol change, no new frame types, no new store fields.

```ts
// src/host/service.ts — ownAddresses()
add(this.peerServer?.address);
add(`127.0.0.1:${this.config.port}`);
add(`localhost:${this.config.port}`);
// OWN INTERFACES ONLY — never `lanCandidates()`, never beacon addresses.
for (const candidate of this.peerServer?.candidates ?? []) add(candidate);
```

`peerServer.candidates` is `hostCandidates(port)`, i.e. `networkInterfaces()` mapped to `host:port` —
it can only ever report this machine. Loopback on our own port stays. Nothing else is touched, so
the roomId-based refusal (a live self-join on a room **this node serves**) is unchanged.

### The 0.1.36 protections all stay

1. `gateway.joinRoom` still refuses a live self-join on an **owned** room, after the handshake
   resolves the roomId and before the client is wired in.
2. `broadcast()`'s already-broadcast-seq watermark is untouched.
3. The previous per-room client is still `destroy()`ed before being replaced.

## Acceptance (all demonstrated)

1. **Joining a remote room by the owner's address succeeds, even with a local joined record for that
   room already present** (`test/selfjoin.test.mjs`). The owner is a real `PeerServer` on loopback;
   the member's fake discovery hands it the owner's beacon, which is the only difference from the
   field. The test also re-joins with the beacon removed, so the local record is the only possible
   source of a false collision — and asserts the owner's address is never in `ownAddresses()`.
2. **A live self-join on an owned room is still refused** by the room-ownership check, with the
   client left unregistered (`test/selfjoin.test.mjs`).
3. **The regression is really caught**: with 0.1.36's `lanCandidates()` line restored in the built
   `lib`, the new test fails with exactly the field error
   (`不能通过本机自己的地址加入房间（self-join）: <owner address>`) and exits 1; with the fix it
   passes and exits 0.
4. **No regression**: agent-room 43 passing / 0 failing — protocol 8, snapshot 4, outbound 10,
   sendchat 4, backfill 10, backfill.e2e 3, amplification 2, selfjoin 2 (new). The 0.1.36
   amplification acceptance (one send ⇒ one delivery, watermark choke point) is unchanged and still
   green.

## Deliberately left out

- **The deeper invariant** — "the address check should compare the *host*, not `host:port`, and
  should consult sockets we actually listen on" — was not added; `peerServer.candidates` +
  loopback already covers every address this node serves, and a wider predicate is exactly how the
  false positive happened.
- **Any change to `lanCandidates()` itself.** It is correct for its own job (offering join targets,
  best-first); it must simply never be used as an identity predicate. The comment in
  `ownAddresses()` now says so.

## Install / rollback

```
# install (tarball path from this release)
dsh plugin install ./dsh-agent-room-0.1.37.tgz
# or by hand
npm.cmd install ./dsh-agent-room-0.1.37.tgz

# rollback to the previous version
dsh plugin install ./dsh-agent-room-0.1.36.tgz
```

Rollback is safe: 0.1.37 changes no frame, no protocol and no store field. A node that was locked
out under 0.1.36 may have had its joined record for the remote room pruned at boot, so re-join once
after installing; nothing else is needed.
