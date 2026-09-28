/**
 * dsh-agent-org — the remote-execution plane.
 *
 * Everything about ONE exec instruction lives here: the idempotency key, the
 * result cache, the "still executing" interim answer, and the controller-side
 * wait. It is deliberately free of cordis/Service dependencies so the delivery
 * guarantees can be tested directly (`node test/exec-cache.test.mjs`).
 *
 * The two guarantees it provides:
 *
 *   1. IDEMPOTENCY — one instruction id means at most one real execution, and
 *      every delivery of that id is answered with the SAME result content.
 *      A duplicate while the first run is in flight gets "still executing" (202):
 *      not executed, not an error.
 *   2. ANSWERED DELIVERIES — a re-delivered instruction is never silently
 *      swallowed. The old guard dropped duplicates without sending anything, so
 *      the sender waited out its own timeout even though the frame had arrived
 *      (measured: 667,621 `skipped(replay)` lines vs 1,367 executions).
 */

import { ExecResultCache, executeOnce } from "./exec-cache.js";
import {
  EXEC_TIMEOUT_MS,
  EXEC_WAIT_TIMEOUT_MS,
  encodeExec,
  encodeExecResult,
  runCommand,
  stillExecutingResult,
} from "./exec.js";
import { nowIso, uuid } from "./util.js";

/**
 * True for the interim "still executing" answer (202 semantics).
 * The controller must NOT treat it as the outcome of its instruction.
 */
export function isPendingResult(result) {
  return Boolean(result) && (result.pending === true || result.status === 202);
}

export class ExecPlane {
  /**
   * @param {{
   *   identityAgentId: () => Promise<string>,
   *   roleOf: (agentId: string) => string,
   *   send: (text: string, meta: {label: string}) => Promise<{ok: boolean, reason?: string}>,
   *   run?: (command: string, timeoutMs: number) => Promise<object>,
   *   audit?: (entry: {agentId: string, action: string, target: string, result: string}) => void,
   *   warn?: (key: string, message: string) => void,
   *   cache?: ExecResultCache,
   *   waitTimeoutMs?: number,
   * }} deps
   */
  constructor(deps) {
    this.identityAgentId = deps.identityAgentId;
    this.roleOf = deps.roleOf;
    /**
     * 0.2.14: target-aware authorization. `(actorAgentId, targetAgentId) =>
     * {allowed, role, reason}`. REQUIRED: when it is absent this plane denies
     * every instruction (fail-closed) and says so in the log — the pre-0.2.14
     * rule (`owner || lead`, blind to the target) let the lead of an empty
     * department command every machine in the company.
     */
    this.canExec = deps.canExec ?? null;
    /**
     * 0.2.14: freshness probe for the LOCAL org tree — `() => {verdict, reason}`.
     * Only POSITIVE evidence (`stale`, from the authority) blocks a command; an
     * idle fleet reports `unknown` and must not be treated as a failure.
     */
    this.freshness = deps.freshness ?? null;
    this.send = deps.send;
    this.run = deps.run ?? runCommand;
    this.audit = deps.audit ?? (() => {});
    this.warn = deps.warn ?? (() => {});
    this.waitTimeoutMs = deps.waitTimeoutMs ?? EXEC_WAIT_TIMEOUT_MS;
    /** @type {ExecResultCache} */
    this.cache = deps.cache ?? new ExecResultCache();
    /** @type {Map<string, {resolve: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
  }

  /**
   * Handle an inbound `[org:exec:result]` frame (controller side).
   *
   * An interim 202 answer is ignored on purpose: resolving the caller with it
   * would report "still executing" as the outcome while the real result is a
   * frame away.
   *
   * @param {object} result decoded exec result
   */
  handleResult(result) {
    const pending = this.pending.get(result?.id);
    if (!pending) return;
    if (isPendingResult(result)) return;
    this.pending.delete(result.id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  /**
   * Handle an inbound `[org:exec]` frame (target side).
   *
   * @param {{id: string, targetAgentId: string, command: string}} instruction
   * @param {{from?: string}} message
   * @returns {Promise<{answered: boolean, state: string, executed: boolean, result: object}>}
   */
  async handleInstruction(instruction, message) {
    const by = await this.identityAgentId();
    if (!instruction || by !== instruction.targetAgentId) {
      // Not addressed to this machine: nothing to answer, nothing to cache.
      return { answered: false, state: "skipped", executed: false, result: undefined };
    }

    const sender = message?.from ?? "";
    // 0.2.14: authorization is decided against the TARGET, not just the sender's
    // role. A `lead` may only reach inside a subtree it leads; `owner` is the
    // single cross-department channel; anything undecidable denies.
    const decision = this.canExec ? this.canExec(sender, instruction.targetAgentId) : null;
    const senderRole = decision?.role ?? this.roleOf(sender);
    let allowed = decision?.allowed === true;
    let denyReason = decision?.reason ?? "authorization unavailable: canExec is not wired (fail-closed)";
    if (!this.canExec) this.warn("authz-unwired", "[agent-org] exec: canExec dependency missing — denying every instruction (fail-closed)");
    // 0.2.14: a stale LOCAL tree can hand out rights that a correct copy would not
    // (measured: A's copy still had D as a lead for 2 days). Only a positive
    // `stale` verdict blocks; `unknown` is what an idle fleet reports.
    if (allowed && this.freshness) {
      const fresh = this.freshness();
      if (fresh && fresh.verdict === "stale") {
        allowed = false;
        denyReason = `local org tree looks stale — ${fresh.reason}`;
      }
    }

    // IDEMPOTENCY. `executeOnce` claims the id SYNCHRONOUSLY before any await, so
    // two concurrent deliveries of the same id cannot both run the command.
    //   - first delivery      -> execute, cache the exact result body
    //   - duplicate (settled) -> re-send the CACHED body (identical content)
    //   - duplicate in flight -> answer "still executing" (202), not an error
    const outcome = await executeOnce(
      this.cache,
      instruction.id,
      () => this.runInstruction(instruction.id, by, instruction.command, sender, senderRole, allowed, denyReason),
      () => stillExecutingResult(instruction.id, by),
    );
    const reply = outcome.result;

    if (outcome.executed) {
      this.audit({
        agentId: sender,
        action: "exec",
        target: instruction.targetAgentId + " :: " + instruction.command,
        result: allowed ? "executed" : "rejected",
      });
    } else {
      this.cache.noteReplay(instruction.id);
      // One audit line per id: 0.2.9 cut the volume, 0.2.10 makes the line say
      // what actually happened (served from cache / still running).
      if (this.cache.shouldAuditReplay(instruction.id)) {
        this.audit({
          agentId: sender,
          action: "exec",
          target: instruction.targetAgentId + " :: " + instruction.command,
          result: outcome.state === "executing"
            ? "answered(still-executing)"
            : "answered(cached:" + outcome.state + ")",
        });
      }
    }

    // ALWAYS write the answer back — fresh, cached, or interim. Swallowing this
    // write is what made a received instruction look like a lost one.
    const delivery = await this.send(encodeExecResult(reply), { label: "exec-result:" + instruction.id });
    if (!delivery?.ok) {
      this.warn(
        "result:" + instruction.id,
        `[agent-org] exec result for ${instruction.id} could not be delivered (${delivery?.reason ?? "unknown"})`,
      );
    }
    return { answered: true, state: outcome.state, executed: outcome.executed, result: reply };
  }

  /**
   * Perform one instruction for real (called at most once per id).
   *
   * The body is cached verbatim — id included — so a replay is byte-identical to
   * the first answer.
   *
   * @param {string} id
   * @param {string} by
   * @param {string} command
   * @param {string} sender
   * @param {string} senderRole
   * @param {boolean} allowed
   */
  async runInstruction(id, by, command, sender, senderRole, allowed, denyReason = "") {
    if (!allowed) {
      // A refusal is cached like any other outcome: a replay must never turn
      // "rejected" into a different answer.
      return {
        id,
        by,
        ok: false,
        code: 403,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: `exec rejected: sender ${sender} role=${senderRole} — ${denyReason}`,
      };
    }
    const outcome = await this.run(command, EXEC_TIMEOUT_MS);
    return {
      id,
      by,
      ok: outcome.ok,
      code: outcome.code,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      timedOut: outcome.timedOut,
      error: outcome.error,
    };
  }

  /**
   * Controller side: send an instruction and await the target's answer.
   *
   * @param {string} targetAgentId
   * @param {string} command
   */
  async sendExec(targetAgentId, command) {
    const by = await this.identityAgentId();
    const id = uuid();
    const payload = { id, targetAgentId, command: String(command ?? ""), ts: nowIso() };
    const resultPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, code: null, stdout: "", stderr: "", timedOut: true, error: "exec timed out waiting for result" });
      }, this.waitTimeoutMs);
      this.pending.set(id, { resolve, timer });
    });

    // Verified write (0.2.10): an instruction that never reached the target used
    // to cost the caller the whole 45s wait for an answer that could not come.
    //
    // 0.2.13 / card-16: `ok:true` is NOT the same as "sent". When the agent-room channel to the
    // sync room is closed, agent-room QUEUES the frame for replay and reports
    // {ok:true, queued:true} -- the instruction never left this machine, so waiting for an answer
    // is waiting for nothing. Measured 2026-09-16: a node that left and rejoined its room tore its
    // org subscription, and every exec to it then cost the sender a full 45s of silence, which
    // reads as "the target is slow" instead of "the channel is closed". A refusal must name itself.
    const delivery = await this.send(encodeExec(payload), { label: "exec-instruction:" + id });
    const queued = delivery?.ok === true && delivery?.queued === true;
    if (!delivery?.ok || queued) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
      }
      return {
        id,
        ok: false,
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        queued,
        reason: queued ? "channel-not-open" : (delivery?.reason ?? "unknown"),
        error: queued
          ? "exec instruction NOT sent: the agent-room channel to the sync room is closed, so the frame was queued for replay instead of delivered. Re-assert the sync room (POST /agent-org-api/sync -- a leave/rejoin tears the org subscription), then retry."
          : `exec instruction not delivered: ${delivery?.reason ?? "unknown"}`,
      };
    }
    return resultPromise;
  }

  /** Drop the timers of every in-flight wait (service teardown). */
  dispose() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }
}
