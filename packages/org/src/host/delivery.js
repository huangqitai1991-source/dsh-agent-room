/**
 * dsh-agent-org — verified delivery of control frames.
 *
 * `gateway.sendChat` used to return `null` for a room this node had only JOINED,
 * so agent-org could not tell "the owner's room accepted my frame" from "the
 * frame vanished on a socket that was not OPEN". The result of an exec was
 * written into that void: the controller waited out its own timeout while the
 * target's answer was never sent anywhere.
 *
 * Since dsh-agent-room 0.1.34 the call returns a delivery status
 * (`{ delivered, queued, reason }`), and this module is what agent-org does with
 * it: treat `queued` as accepted (agent-room owns the replay), retry with
 * bounded exponential backoff otherwise, and REPORT the final failure instead of
 * swallowing it.
 */

/** Exponential backoff between delivery attempts (ms); one entry per retry. */
export const DELIVERY_BACKOFF_MS = [250, 500, 1000, 2000, 4000];

/**
 * Does this status mean the frame is on its way?
 *
 * @param {unknown} status value returned by gateway.sendChat
 * @returns {boolean}
 */
export function deliveryAccepted(status) {
  if (!status || typeof status !== "object") return false;
  if (typeof status.delivered === "boolean") return status.delivered === true || status.queued === true;
  // Owned room: the authoritative write returns the ChatMessage itself (real seq).
  if (typeof status.seq === "number") return true;
  return false;
}

/** True for the 0.1.34+ `{delivered, queued, reason}` shape (as opposed to a message). */
export function isDeliveryReport(status) {
  return Boolean(status) && typeof status === "object" && typeof status.delivered === "boolean";
}

/**
 * Send a control frame, verifying delivery and retrying with bounded backoff.
 *
 * @param {(text: string) => Promise<unknown>} send
 * @param {string} text
 * @param {{backoff?: number[], sleep?: (ms: number) => Promise<void>}} [options]
 * @returns {Promise<{ok: boolean, attempts: number, queued: boolean, unknown: boolean, status: unknown, reason?: string}>}
 */
export async function sendWithRetry(send, text, options = {}) {
  const backoff = Array.isArray(options.backoff) ? options.backoff : DELIVERY_BACKOFF_MS;
  const sleep = typeof options.sleep === "function"
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** @type {{ok: boolean, attempts: number, queued: boolean, unknown: boolean, status: unknown, reason?: string}} */
  const outcome = { ok: false, attempts: 0, queued: false, unknown: false, status: undefined };

  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    outcome.attempts = attempt + 1;
    let status;
    let threw = false;
    try {
      status = await send(text);
    } catch (error) {
      // A throwing gateway is a FAILED delivery, not an answer.
      threw = true;
      status = undefined;
      outcome.reason = error instanceof Error ? error.message : String(error);
    }
    outcome.status = status;

    if (deliveryAccepted(status)) {
      outcome.ok = true;
      outcome.queued = isDeliveryReport(status) && status.queued === true;
      return outcome;
    }

    if (!threw && (status === null || status === undefined)) {
      // The call returned, but with no status at all: an agent-room older than
      // 0.1.34 returns null for a joined room, which carries no information
      // either way. Treat it as "accepted, unverified" rather than retrying —
      // retrying against a host without the idempotency cache would execute the
      // same instruction again, and a duplicate execution is worse than an
      // undetected drop.
      outcome.ok = true;
      outcome.unknown = true;
      return outcome;
    }

    if (isDeliveryReport(status)) outcome.reason = status.reason ?? "not-delivered";
    if (attempt < backoff.length) await sleep(backoff[attempt]);
  }

  outcome.ok = false;
  outcome.reason = outcome.reason ?? "delivery failed after all attempts";
  return outcome;
}
