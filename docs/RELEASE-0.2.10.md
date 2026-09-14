# dsh-agent-org 0.2.10 — idempotent exec results + verified delivery

Release date: 2026 (field rollout; pairs with dsh-agent-room 0.1.34).

Trigger: one machine logged **667,621** `result="skipped(replay)"` audit lines
against **1,367** real `executed` lines for the same small set of instructions — a
~488:1 ratio. 0.2.9 turned those lines into counters but kept the real defect: a
re-delivered instruction was answered with **nothing**, so the sender waited out
its own 45s controller timeout even though the frame had been received and the
answer had already been produced.

---

## 1. Replay answer: idempotency key + result cache (replaces "skip silently")

**Before** — `src/host/service.js` (~196-224):

```js
if (this.seenExecIds.has(instruction.id)) {
  const replays = (this.replayCounts.get(instruction.id) ?? 0) + 1;
  this.replayCounts.set(instruction.id, replays);
  if (replays === 1) { void this.audit.append({ ..., result: "skipped(replay)" }); }
  // ...
  return;                       // <- no result is sent; the sender waits and times out
}
```

An earlier proposal was to answer HTTP 409. That is still an empty answer for the
sender, so it was rejected.

**After**

- `src/host/exec-cache.js` (new) — `ExecResultCache` + `executeOnce()`:
  **bounded LRU + TTL** (`EXEC_RESULT_CACHE_LIMIT = 512`,
  `EXEC_RESULT_TTL_MS = 30 min`), keyed by instruction `id`, with the three
  required states: `executing` / `executed` / `failed`.
- `src/host/exec-plane.js` (new) — `ExecPlane`, the cordis-free execution plane
  (so the guarantee is directly testable). `OrgService.onChat` and
  `OrgService.sendExec` now delegate to it.
- Delivery rules per instruction id:
  - **first delivery** → execute once, cache the exact result body;
  - **duplicate while executing** → answer `stillExecutingResult()` — `pending:
    true`, `status: 202`, **not** executed and **not** an error;
  - **duplicate after settling** → re-send the **cached body** (byte-identical,
    `id` included).
- The claim in `ExecResultCache.begin()` is **synchronous**, so two concurrent
  deliveries of the same id cannot both see "new" — exactly one real execution.
- `failed` results (non-zero exit, timeout, or an unauthorized sender's 403) are
  cached as well: a replay must never turn a failure into a different answer.
- Audit: one line per id, and it now says what happened —
  `answered(still-executing)` or `answered(cached:executed|failed)`.
- Eviction never drops an **in-flight** entry (that would let a duplicate re-run
  the command); the 512 bound applies to settled entries.
- `src/host/exec.js` — added `stillExecutingResult(id, by)`.
- Controller side: the interim 202 is **ignored** by the waiter
  (`isPendingResult()`), because resolving the caller with "still executing" would
  report the interim body as the outcome while the real result is one frame away.

## 2. A failed result write is never swallowed

**Before** — `src/host/service.js` (~259-264):

```js
try {
  await this.agentRoom?.gateway?.sendChat?.(this.config.syncRoomId, { text: encodeExecResult(reply), human: false });
} catch { /* best-effort */ }
```

`gateway.sendChat` returned `null` for a joined room, so a dropped result frame
and a successful one were indistinguishable.

**After**

- `src/host/delivery.js` (new) — `deliveryAccepted()`, `isDeliveryReport()`,
  `sendWithRetry()`: checks the 0.1.34 status object, treats `queued: true` as
  accepted (agent-room owns the replay), retries otherwise with bounded
  exponential backoff (`DELIVERY_BACKOFF_MS = [250, 500, 1000, 2000, 4000]`, so 5
  attempts), and reports the final failure.
- `OrgService.sendControlFrame(text, {label})` wraps the gateway and logs a
  **rate-limited** warning (one per key per minute) when the write ultimately
  fails, when the status is missing, or when the frame had to be queued.
- Used for **exec results**, **org snapshots**, and **exec instructions**.
  `sendExec` also returns an explicit `exec instruction not delivered: <reason>`
  instead of letting the caller wait 45s for an answer that cannot come.
- A **throwing** gateway counts as a failed delivery; only a call that returns no
  status at all (agent-room < 0.1.34) is treated as "accepted, unverified" — with
  a rate-limited warning — because blind retries against a host without the
  idempotency cache could execute the same instruction twice.

## 3. `peerDependencies` bump

`dsh-agent-room` peer requirement: `>=0.1.4` → **`>=0.1.34`** (the release that
returns a delivery status object for joined rooms).

---

## Acceptance criteria

1. **Any number of deliveries of the same instruction id produces the same
   result content, with exactly one real execution.**
2. A duplicate arriving while the first delivery is still executing is answered
   "still executing" (202 semantics in the result payload) — not executed, not an
   error.
3. A re-delivered instruction is never answered with nothing (the old silent
   `return` is gone).
4. A failed/timed-out/refused execution is cached like a successful one, so every
   replay of that id returns the same body.
5. A result frame that cannot be written is retried with bounded exponential
   backoff and logged (rate-limited) when it finally fails.
6. The controller's wait is not resolved by an interim 202.

## Verification

```
node test/permission.test.mjs    # 5 passing
node test/sync.test.mjs          # 4 passing
node test/visibility.test.mjs    # 8 passing
node test/exec-cache.test.mjs    # 12 passing (new)
node build.mjs                   # built lib/host/*, lib/tools/*, lib/client.js
```

The new test drives the real `ExecPlane` (not a re-implementation) and covers:
same id three times → one execution + three identical bodies; the in-flight 202
case; cached failures and 403s; the controller ignoring the 202; the
undeliverable-instruction path; bounded LRU/TTL eviction that preserves in-flight
ids; and the retry/backoff contract.

## Install / rollback

```sh
# install
npm i -g ./dsh-agent-org-0.2.10.tgz

# rollback
npm i -g ./dsh-agent-org-0.2.9.tgz
```

Rollback is safe in the sense that 0.2.10 adds no persisted state: the cache is
in-memory only, and reverting restores the 0.2.9 behaviour (silent skip). Rolling
back agent-org while keeping agent-room 0.1.34 is harmless — agent-room only
gains a queue and a status object the old agent-org ignores.

## Related fix in dsh-agent-room 0.1.34: the "diagnostic trap" from 0.2.9

0.2.9's appendix described a misleading symptom: for a room this node had only
JOINED, `POST /agent-room-api/rooms/<id>/chat` answered `{"seq": null}` and the
message did not appear in the local read view, so three operators concluded "the
message was swallowed". Two of the three possible causes were real defects and
are fixed in dsh-agent-room 0.1.34:

- the joined-room `sendChat` now returns a real delivery status
  (`{delivered, queued, reason}`) instead of `null`, and the HTTP route reports it;
- the read view merges the owner's confirmed stream with locally appended
  messages, so a sender sees its own message immediately (marked `pending`, with
  the real `seq` once the owner echoes it) — no manual rejoin required.
