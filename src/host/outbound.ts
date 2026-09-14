/**
 * dsh-agent-room — outbound control-frame queue for JOINED rooms.
 *
 * Why this exists (measured 2026-10 field data):
 *
 * A member's room traffic leaves through a RoomClient socket. `RoomClient`
 * silently dropped every frame while its socket was CONNECTING / CLOSING /
 * CLOSED, so a member's message to the owner's room simply never arrived and an
 * exec *result* frame never came back — the sender then waited out its own
 * timeout even though the peer was alive. Nothing was retried and nothing was
 * reported: the loss was invisible.
 *
 * Two decisions keep this honest:
 *
 * 1. QUEUE OWNERSHIP — the pending queue lives in per-room state owned by the
 *    service (see OutboundHub), never on the socket or the RoomClient instance.
 *    A reconnect replaces the socket (and may replace the client) but the queue
 *    survives it instead of being orphaned with the dead object.
 * 2. WHAT QUEUES — only control frames (`[org:exec]` / `[org:exec:result]` /
 *    `[org:snapshot]`): they are work orders, and dropping one costs a whole
 *    round trip. Plain chat is reported but never queued — a stale chat line is
 *    not worth replaying minutes later.
 *
 * Overflow never drops the OLDEST in-flight control frame; the NEW frame is
 * rejected instead and the caller is told, so it can retry.
 */

import type { ChatMessage } from "../types.js";
import { isControlFrame } from "./protocol.js";

/** Frame/byte ceiling for one room's pending control frames. */
export const MAX_QUEUED_FRAMES = 200;
export const MAX_QUEUED_BYTES = 512 * 1024;

export interface ChatInput {
  text: string;
  replyTo?: number;
  mentions?: string[];
  human?: boolean;
}

/**
 * Delivery status of a message sent to a room this node only JOINED.
 *
 * Returned instead of the old `null`, which told the caller nothing: it could
 * not distinguish "handed to the owner's room" from "vanished on a dead socket".
 *
 * 0.1.35 — HONESTY FIX. In 0.1.34 `delivered: true` only meant "the local hub
 * wrote the frame to an OPEN socket", but the name read as "it arrived". Field
 * data proved the difference is real: three exec frames were reported delivered
 * while the owner never stored them, and in another round the same three did
 * arrive — with this shape the sender could not tell which case it was in. The
 * status now separates the two facts, and `delivered` is kept only as a
 * documented alias of `acceptedByLocalHub` so existing consumers
 * (dsh-agent-org 0.2.10's `isDeliveryReport`) keep working.
 */
export interface ChatDeliveryStatus {
  /**
   * The LOCAL hub accepted the frame: it was written to a socket towards the
   * owner, or parked in this room's control-frame queue. This is NOT evidence
   * that the owner stored the message.
   */
  acceptedByLocalHub: boolean;
  /**
   * The OWNER acknowledged the message by echoing it back with its own seq
   * (0.1.35). Only a `true` here means the message is in the owner's store.
   */
  confirmedByOwner: boolean;
  /** The owner's seq for the message, present only when it confirmed. */
  confirmedSeq?: number;
  /** Machine-readable confirmation outcome. */
  confirmNote?: "owner-confirmed" | "not-confirmed-in-time" | "not-attempted";
  /**
   * DEPRECATED alias of `acceptedByLocalHub`, kept so existing callers keep
   * compiling and behaving. Do not read it as a delivery guarantee: read
   * `acceptedByLocalHub` / `confirmedByOwner` instead.
   */
  delivered: boolean;
  /** Not accepted by the owner's channel, but parked in the control-frame queue. */
  queued: boolean;
  /** Why it was not accepted locally, e.g. "channel-not-open", "queue-full". */
  reason?: string;
  /** Per-room queue depth after this call (0 when nothing is pending). */
  queueLength: number;
}

/** How long a send waits for the owner's confirmed echo before reporting "unconfirmed". */
export const OWNER_CONFIRM_WAIT_MS = 1_500;

/** The parts of a RoomClient this module needs (structural, so tests can fake it). */
export interface OutboundTarget {
  readonly connected: boolean;
  /** Returns true only when the frame was written to an OPEN socket. */
  sendChat(input: ChatInput): boolean;
  /** Local optimistic projection append (read view must show it immediately). */
  appendLocal(input: ChatInput): ChatMessage;
  /** Wait for the owner's confirmed echo (0.1.35); optional for fakes. */
  awaitOwnerEcho?(text: string, timeoutMs: number): Promise<number | null>;
}

interface QueuedFrame {
  input: ChatInput;
  bytes: number;
  queuedAt: number;
}

export interface EnqueueOutcome {
  queued: boolean;
  reason?: string;
  length: number;
  bytes: number;
}

export interface FlushOutcome {
  delivered: number;
  remaining: number;
  /** True when delivery failed and the rest were left queued (order preserved). */
  stopped: boolean;
}

/** Pending control frames for ONE room. Pure state, no I/O, no timers. */
export class OutboundQueue {
  private readonly frames: QueuedFrame[] = [];
  private bytes = 0;
  private rejectedCount = 0;
  private deliveredCount = 0;

  constructor(
    private readonly maxFrames: number = MAX_QUEUED_FRAMES,
    private readonly maxBytes: number = MAX_QUEUED_BYTES,
  ) {}

  get length(): number {
    return this.frames.length;
  }

  get queuedBytes(): number {
    return this.bytes;
  }

  /** Frames rejected because the queue was full (never silently discarded). */
  get rejected(): number {
    return this.rejectedCount;
  }

  get delivered(): number {
    return this.deliveredCount;
  }

  /**
   * Queue one control frame.
   *
   * On overflow the NEW frame is rejected — the oldest pending work order may
   * already be in flight on the peer's side, and dropping it would lose work
   * that nothing else would replay.
   */
  enqueue(input: ChatInput): EnqueueOutcome {
    const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    if (this.frames.length >= this.maxFrames) {
      this.rejectedCount += 1;
      return { queued: false, reason: `queue-full(frames=${this.maxFrames})`, length: this.frames.length, bytes: this.bytes };
    }
    if (this.bytes + bytes > this.maxBytes) {
      this.rejectedCount += 1;
      return { queued: false, reason: `queue-full(bytes=${this.maxBytes})`, length: this.frames.length, bytes: this.bytes };
    }
    this.frames.push({ input, bytes, queuedAt: Date.now() });
    this.bytes += bytes;
    return { queued: true, length: this.frames.length, bytes: this.bytes };
  }

  /**
   * Deliver queued frames in FIFO order through `deliver`.
   *
   * Stops at the first failed delivery and keeps the rest queued: order matters
   * for exec frames, and a partial flush that dropped the tail would lose work.
   */
  flush(deliver: (input: ChatInput) => boolean): FlushOutcome {
    let delivered = 0;
    let stopped = false;
    while (this.frames.length > 0) {
      const head = this.frames[0]!;
      let ok = false;
      try {
        ok = deliver(head.input) === true;
      } catch {
        ok = false;
      }
      if (!ok) {
        stopped = true;
        break;
      }
      this.frames.shift();
      this.bytes -= head.bytes;
      delivered += 1;
    }
    this.deliveredCount += delivered;
    return { delivered, remaining: this.frames.length, stopped };
  }

  clear(): void {
    this.frames.length = 0;
    this.bytes = 0;
  }

  /** Queued frame texts, oldest first (diagnostics/tests). */
  snapshot(): string[] {
    return this.frames.map((frame) => frame.input.text);
  }

  /** Ages of the queued frames in ms, oldest first (diagnostics). */
  ages(now = Date.now()): number[] {
    return this.frames.map((frame) => now - frame.queuedAt);
  }
}

/** A joined-room send, plus the optimistic local message when nothing was delivered. */
export interface SendOutcome extends ChatDeliveryStatus {
  message?: ChatMessage;
}

/**
 * Narrow a SendOutcome to the delivery status a caller gets back.
 *
 * `confirmedByOwner` is NOT decided here: this module has no channel to the owner
 * beyond the write itself. It starts `false` with `confirmNote: "not-attempted"`
 * and is upgraded by whoever can observe the owner's echo (see
 * AgentRoomService.gateway.sendChat, which waits a bounded time for it).
 */
export function toDeliveryStatus(outcome: SendOutcome): ChatDeliveryStatus {
  return {
    acceptedByLocalHub: outcome.delivered,
    delivered: outcome.delivered,
    confirmedByOwner: false,
    confirmNote: "not-attempted",
    queued: outcome.queued,
    reason: outcome.reason,
    queueLength: outcome.queueLength,
  };
}

/**
 * Service-owned per-room outbound state.
 *
 * The hub is created once by AgentRoomService and keyed by roomId, so the queue
 * belongs to the ROOM (not to a socket, not to a RoomClient instance, and not to
 * a captured gateway reference). A reconnect that swaps either one finds the
 * queue exactly where it left it.
 */
export class OutboundHub {
  private readonly queues = new Map<string, OutboundQueue>();

  constructor(
    private readonly maxFrames: number = MAX_QUEUED_FRAMES,
    private readonly maxBytes: number = MAX_QUEUED_BYTES,
  ) {}

  /** The queue for a room, created on first use. */
  queueFor(roomId: string): OutboundQueue {
    let queue = this.queues.get(roomId);
    if (!queue) {
      queue = new OutboundQueue(this.maxFrames, this.maxBytes);
      this.queues.set(roomId, queue);
    }
    return queue;
  }

  /** The queue for a room when one exists (no creation). */
  peek(roomId: string): OutboundQueue | undefined {
    return this.queues.get(roomId);
  }

  /** Forget a room's queue (room left / destroyed). */
  drop(roomId: string): void {
    this.queues.delete(roomId);
  }

  /** Total pending frames across every room (diagnostics). */
  totalQueued(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  /**
   * Send to a joined room and REPORT what happened.
   *
   * An accepted write returns `acceptedByLocalHub: true` — which means exactly
   * "the local hub wrote it towards the owner", never "the owner stored it"
   * (0.1.35; the owner's echo is the only proof, and it is checked by the
   * service, not here). A frame that could not be written is either queued
   * (control frames) or reported as dropped (plain chat) — never silently
   * discarded. Whatever the outcome, the message is also appended to the local
   * read view so the sender sees it immediately.
   */
  send(roomId: string, input: ChatInput, target: OutboundTarget): SendOutcome {
    const control = isControlFrame(input.text);
    let delivered = false;
    if (target.connected) {
      try {
        delivered = target.sendChat(input) === true;
      } catch {
        delivered = false;
      }
    }

    let queued = false;
    let reason: string | undefined;
    if (!delivered) {
      if (control) {
        const outcome = this.queueFor(roomId).enqueue(input);
        queued = outcome.queued;
        reason = outcome.reason ?? "channel-not-open";
      } else {
        // Plain chat is never queued: a chat line replayed minutes later is
        // noise, not delivery. It is still reported so the caller can retry.
        reason = "channel-not-open";
      }
    }

    // Optimistic local append. On the delivered path the owner's echo is the
    // authoritative copy and lands within milliseconds; on the queued/dropped
    // path this is the only way the sender sees its own message at all.
    const message = delivered ? undefined : target.appendLocal(input);
    return {
      acceptedByLocalHub: delivered,
      delivered,
      confirmedByOwner: false,
      confirmNote: "not-attempted",
      queued,
      reason,
      message,
      queueLength: this.queues.get(roomId)?.length ?? 0,
    };
  }

  /** Flush a room's pending control frames once its channel is usable again. */
  flush(roomId: string, target: OutboundTarget): FlushOutcome {
    const queue = this.queues.get(roomId);
    if (!queue || queue.length === 0) return { delivered: 0, remaining: 0, stopped: false };
    return queue.flush((input) => {
      try {
        return target.sendChat(input) === true;
      } catch {
        return false;
      }
    });
  }
}
