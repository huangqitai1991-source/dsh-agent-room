/**
 * dsh-agent-org — idempotent exec results.
 *
 * The problem this solves (measured in the field):
 *
 * agent-org frames travel as ordinary room messages, so a reconnecting node
 * re-syncs the tail of the sync room and hands every already-seen frame to
 * onChat again. The old guard (`seenExecIds`) simply DROPPED the duplicate and
 * sent NOTHING back, so the sender — who had no idea the frame had even been
 * received — waited out its own 45s controller timeout even though the target
 * was alive and had already answered. One machine logged 667,621
 * `skipped(replay)` lines against 1,367 real executions: a 488:1 ratio of
 * silently unanswered deliveries.
 *
 * The fix is not a status code (replying 409 would still leave the sender
 * empty-handed). It is an IDEMPOTENCY KEY plus a RESULT CACHE: the instruction
 * `id` is the key, "any number of deliveries of the same id must produce the
 * same result content", and exactly one REAL execution happens.
 *
 * Three states per id:
 *   - executing: claimed, result not ready yet. A duplicate gets a "still
 *     executing" answer (202 semantics) — NOT executed, NOT an error.
 *   - executed:  the command ran successfully; the exact body is cached.
 *   - failed:    the command ran and failed (or was refused); that exact body is
 *     cached too, so a replay never turns a failure into a different answer.
 */

/** Bounded cache: entries kept (LRU over settled entries), and how long an id stays known. */
export const EXEC_RESULT_CACHE_LIMIT = 512;
export const EXEC_RESULT_TTL_MS = 30 * 60 * 1000;

/**
 * Exec result cache keyed by instruction id.
 *
 * Pure in-memory state with no timers: expiry is computed on access, so a
 * service that is idle for an hour does not burn CPU on sweep work.
 */
export class ExecResultCache {
  /**
   * @param {{limit?: number, ttlMs?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.limit = Number.isFinite(options.limit) ? Number(options.limit) : EXEC_RESULT_CACHE_LIMIT;
    this.ttlMs = Number.isFinite(options.ttlMs) ? Number(options.ttlMs) : EXEC_RESULT_TTL_MS;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    /** @type {Map<string, {id: string, state: "executing"|"executed"|"failed", result: object|undefined, startedAt: number, settledAt: number, replays: number, replayAudited: boolean}>} */
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  /** @param {string} id */
  get(id) {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }

  /**
   * Claim an instruction id.
   *
   * Claims and inserts SYNCHRONOUSLY, so two concurrent deliveries of the same id
   * can never both see "new" — the single-threaded event loop plus a synchronous
   * insert is what makes "exactly one execution" true, not luck.
   *
   * @param {string} id
   * @returns {{state: "new"} | {state: "executing", entry: object} | {state: "executed"|"failed", result: object, entry: object}}
   */
  begin(id) {
    const existing = this.entries.get(id);
    if (existing && !this.isExpired(existing)) {
      this.touch(id, existing);
      if (existing.state === "executing") return { state: "executing", entry: existing };
      return { state: existing.state, result: existing.result, entry: existing };
    }
    if (existing) this.entries.delete(id);
    const entry = {
      id,
      state: "executing",
      result: undefined,
      startedAt: this.now(),
      settledAt: 0,
      replays: 0,
      replayAudited: false,
    };
    this.entries.set(id, entry);
    this.evict();
    return { state: "new" };
  }

  /**
   * Record the final result. The stored object is handed back unchanged to every
   * later delivery, so replays are byte-identical to the first answer.
   *
   * @param {string} id
   * @param {"executed"|"failed"} state
   * @param {object} result
   */
  settle(id, state, result) {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.state = state === "executed" ? "executed" : "failed";
    entry.result = result;
    entry.settledAt = this.now();
    this.evict();
    return entry;
  }

  /**
   * Forget an id that never produced a result (the run threw unexpectedly).
   *
   * Without this a crash inside the runner would leave the id stuck in
   * "executing" for the whole TTL, and every retry would be told "still
   * executing" forever.
   */
  abandon(id) {
    this.entries.delete(id);
  }

  /**
   * Count a duplicate delivery.
   * @returns {number} how many duplicates of this id have been answered
   */
  noteReplay(id) {
    const entry = this.entries.get(id);
    if (!entry) return 0;
    entry.replays += 1;
    return entry.replays;
  }

  /** True the first time a duplicate of this id is answered (audit once, not 667k times). */
  shouldAuditReplay(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.replayAudited) return false;
    entry.replayAudited = true;
    return true;
  }

  /** @param {object} entry */
  isExpired(entry) {
    const since = entry.settledAt > 0 ? entry.settledAt : entry.startedAt;
    return this.now() - since > this.ttlMs;
  }

  /** Move an entry to the end of the insertion order (LRU recency). */
  touch(id, entry) {
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  /**
   * Keep the cache bounded WITHOUT ever evicting an in-flight entry.
   *
   * Evicting an `executing` entry would let a duplicate re-run the command — the
   * one guarantee this cache exists to provide. In-flight entries are bounded by
   * reality (a handful at most), so the limit applies to settled entries.
   */
  evict() {
    if (this.entries.size <= this.limit) return;
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.limit) return;
      if (entry.state === "executing") continue;
      this.entries.delete(id);
    }
  }
}

/**
 * Run `run` at most once for `id` and answer every delivery alike.
 *
 * @template T
 * @param {ExecResultCache} cache
 * @param {string} id instruction id (the idempotency key)
 * @param {() => Promise<object>} run performs the real execution (called once per id)
 * @param {() => object} [makePending] builds the "still executing" answer (202)
 * @returns {Promise<{result: object, executed: boolean, state: "executing"|"executed"|"failed"}>}
 */
export async function executeOnce(cache, id, run, makePending = () => ({ id, pending: true, status: 202 })) {
  const claim = cache.begin(id);
  if (claim.state === "executing") {
    // A duplicate arrived while the first delivery is still working. Answer "still
    // executing" — not executed, not an error — and keep waiting for the real one.
    return { result: makePending(), executed: false, state: "executing" };
  }
  if (claim.state !== "new") {
    // Already answered once: return the CACHED body, identical to the first answer.
    return { result: claim.result, executed: false, state: claim.state };
  }

  let result;
  try {
    result = await run();
  } catch (error) {
    cache.abandon(id);
    throw error;
  }
  const state = result && result.ok ? "executed" : "failed";
  cache.settle(id, state, result);
  return { result, executed: true, state };
}
