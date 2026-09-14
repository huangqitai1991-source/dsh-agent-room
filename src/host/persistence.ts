/**
 * dsh-agent-room — persistence under <DSH_HOME>/agent-room/.
 *
 * Layout:
 *   identity.json            node identity
 *   joined.json              rooms this node joined/created (recent list)
 *   rooms/<roomId>.json      persistent room state (metadata + members + tasks)
 *   messages/<roomId>.jsonl  persistent room chat stream (append-only)
 *
 * Hardening (0.1.26): the atomic JSON write used a FIXED tmp name
 * (`${file}.tmp`) with no serialization, so two overlapping saves of the same
 * target could consume each other's tmp file and the second `rename` failed
 * with ENOENT. Because the host boots with a fire-and-forget `void this.boot()`
 * that rejection escaped as an unhandled rejection during load, which DSH
 * reports as a fatal load failure — the process exits and the outside view is a
 * "hang". Fixes: unique tmp name per attempt, in-process serialization per
 * target file, rename retries for transient errors, and persistence failures
 * are reported but never thrown.
 *
 * Also (0.1.26): message reads stream the tail of the JSONL instead of loading
 * the whole file — a room with tens of thousands of messages made snapshot
 * generation slow enough to blow the 5s relay-join budget.
 */

import { mkdir, open, readFile, rename, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentIdentity, ChatMessage, JoinedRoomRecord, Room } from "../types.js";
import { assertNotCorrupt, backupBeforeWrite, isUuidShaped, raiseCorrupt, readJsonConfig, stripBom } from "./safety.js";

/** Tail window used when reading recent messages (bytes). */
const TAIL_WINDOW_BYTES = 4 * 1024 * 1024;

/** Retryable rename failures (transient AV / indexer / sharing violations). */
const RETRYABLE_RENAME = new Set(["ENOENT", "EPERM", "EACCES", "EBUSY"]);
const WRITE_ATTEMPTS = 4;

function errorCode(error: unknown): string {
  return (error as { code?: string } | null)?.code ?? "";
}

function report(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // Persistence must never take the host down; diagnostics go to stderr.
  try {
    console.error(`[agent-room] persistence ${what}: ${message}`);
  } catch {
    /* ignore */
  }
}

export class Persistence {
  readonly root: string;
  private readonly roomsDir: string;
  private readonly messagesDir: string;
  /** target file -> tail of the in-process write chain (serializes saves). */
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = root;
    this.roomsDir = join(root, "rooms");
    this.messagesDir = join(root, "messages");
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.roomsDir, { recursive: true });
    await mkdir(this.messagesDir, { recursive: true });
  }

  /**
   * Read one config file (0.1.38).
   *
   * Delegates to `readJsonConfig`, which TOLERATES a leading UTF-8 BOM and keeps
   * "missing" and "damaged" strictly apart:
   *   missing file                 -> null (a first run may legitimately mint);
   *   present but unparseable      -> throws CorruptConfigError, after
   *                                   quarantining a byte-identical copy.
   *
   * Every caller previously received a bare null for both cases, which is how a
   * BOM'd identity.json turned into a freshly minted agentId.
   */
  private async readJson<T>(file: string): Promise<T | null> {
    return readJsonConfig<T>(file);
  }

  /**
   * Serialize writes per target file, then run one atomic write. Failures are
   * logged, never thrown — a failed save must not crash the host.
   */
  private writeJsonAtomic(file: string, value: unknown): Promise<void> {
    const previous = this.writeChains.get(file) ?? Promise.resolve();
    const next = previous
      .then(() => this.writeJsonAtomicOnce(file, value))
      .catch((error) => report(`write ${file}`, error));
    this.writeChains.set(file, next);
    void next.finally(() => {
      if (this.writeChains.get(file) === next) this.writeChains.delete(file);
    });
    return next;
  }

  private async writeJsonAtomicOnce(file: string, value: unknown): Promise<void> {
    await this.ensureDirs();
    const payload = JSON.stringify(value, null, 2);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      // Unique per attempt: overlapping writers (same process or another one)
      // can never consume each other's tmp file.
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      try {
        await writeFile(tmp, payload, "utf8");
        await rename(tmp, file);
        return;
      } catch (error) {
        lastError = error;
        const code = errorCode(error);
        try {
          await rm(tmp, { force: true });
        } catch {
          /* ignore */
        }
        if (!RETRYABLE_RENAME.has(code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
    throw lastError ?? new Error("atomic write failed");
  }

  /* ------------------------------ identity ----------------------------- */

  /**
   * The identity file (0.1.38): the one artifact that cannot be reconstructed,
   * so it gets the strictest treatment in this module.
   *
   *   MISSING                     -> null (a genuine first run may mint);
   *   parseable but no agentId    -> CorruptConfigError, quarantined first.
   *
   * The second case matters independently of parsing: `{}` or `{"agentId":null}`
   * parses fine and used to be handed back as a real identity, which made every
   * downstream `room.ownerAgentId !== identity.agentId` comparison false and
   * left the node silently serving nothing.
   */
  async loadIdentity(): Promise<AgentIdentity | null> {
    const file = join(this.root, "identity.json");
    const raw = await this.readJson<AgentIdentity>(file);
    if (raw === null) return null;
    if (!raw || typeof raw !== "object" || !isUuidShaped((raw as AgentIdentity).agentId)) {
      await raiseCorrupt(file, 'present but has no usable "agentId"');
    }
    return raw;
  }

  /**
   * The single identity write entry point (0.1.38).
   *
   * Two gates run BEFORE anything is written, because the identity file is the
   * one artifact in this plugin that cannot be reconstructed:
   *   1. refuse when identity.json is present but unparseable — a damaged file is
   *      never overwritten, so a bad read can never mint a replacement identity;
   *   2. take a verified, timestamped backup, and refuse the write if the backup
   *      cannot be produced or verified.
   */
  async saveIdentity(identity: AgentIdentity): Promise<void> {
    const file = join(this.root, "identity.json");
    await assertNotCorrupt(file);
    await backupBeforeWrite(file);
    await this.writeJsonAtomic(file, identity);
  }

  /** Relay auth secrets, keyed by roomId. Kept in a sidecar file so room
   *  snapshots can never leak a relay secret to members. */
  async loadRelaySecrets(): Promise<Record<string, string>> {
    return (await this.readJson(join(this.root, "relay-secrets.json"))) ?? {};
  }

  async saveRelaySecrets(secrets: Record<string, string>): Promise<void> {
    await this.writeJsonAtomic(join(this.root, "relay-secrets.json"), secrets);
  }

  /* ------------------------------ joined rooms ------------------------- */

  async loadJoined(): Promise<JoinedRoomRecord[]> {
    const data = await this.readJson<JoinedRoomRecord[]>(join(this.root, "joined.json"));
    return Array.isArray(data) ? data : [];
  }

  async saveJoined(records: JoinedRoomRecord[]): Promise<void> {
    await this.writeJsonAtomic(join(this.root, "joined.json"), records);
  }

  /* ------------------------------ rooms -------------------------------- */

  async loadPersistentRooms(): Promise<Room[]> {
    await this.ensureDirs();
    const out: Room[] = [];
    let names: string[];
    try {
      names = await readdir(this.roomsDir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const room = await this.readJson<Room>(join(this.roomsDir, name));
      if (room) out.push(room);
    }
    return out;
  }

  async saveRoom(room: Room): Promise<void> {
    await this.writeJsonAtomic(join(this.roomsDir, `${room.roomId}.json`), room);
  }

  async deleteRoom(roomId: string): Promise<void> {
    try {
      await rm(join(this.roomsDir, `${roomId}.json`), { force: true });
      await rm(join(this.messagesDir, `${roomId}.jsonl`), { force: true });
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------ messages ----------------------------- */

  async appendMessage(roomId: string, message: ChatMessage): Promise<void> {
    await this.ensureDirs();
    const file = join(this.messagesDir, `${roomId}.jsonl`);
    await writeFile(file, `${JSON.stringify(message)}\n`, { flag: "a", encoding: "utf8" });
  }

  /**
   * Split JSONL text into non-empty lines, tolerating a leading BOM (0.1.38).
   *
   * Message logs are append-only history: a damaged line is skipped rather than
   * made fatal (nothing ever overwrites the file, so no evidence is at risk).
   * A BOM, however, would silently poison the FIRST line — historically the
   * oldest message in the room — so it is stripped here.
   */
  private static jsonlLines(text: string): string[] {
    return stripBom(text)
      .split("\n")
      .filter((line) => line.trim().length > 0);
  }

  /**
   * Read JSONL lines from the tail of a file without loading all of it.
   * Returns raw lines (oldest-first within the window).
   */
  private async readTailLines(file: string, maxBytes = TAIL_WINDOW_BYTES): Promise<string[]> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(file, "r");
      const info = await handle.stat();
      const size = info.size;
      if (size <= 0) return [];
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let text = buffer.toString("utf8");
      if (start > 0) {
        // A partial first line is likely: drop everything before the first newline.
        const nl = text.indexOf("\n");
        text = nl >= 0 ? text.slice(nl + 1) : "";
      }
      return Persistence.jsonlLines(text);
    } finally {
      try {
        await handle?.close();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Read the last `limit` messages before `before` (exclusive), oldest-first.
   * Uses the tail window when possible; falls back to a full read when an
   * explicit `before` cursor may reach further back than the window.
   */
  async loadRecentMessages(roomId: string, limit = 200, before?: number): Promise<ChatMessage[]> {
    const file = join(this.messagesDir, `${roomId}.jsonl`);
    const parse = (lines: string[]): ChatMessage[] => {
      const parsed: ChatMessage[] = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line) as ChatMessage);
        } catch {
          /* skip corrupt line */
        }
      }
      return parsed;
    };

    let parsed: ChatMessage[];
    try {
      if (before === undefined) {
        parsed = parse(await this.readTailLines(file));
      } else {
        // A paging cursor can point outside the tail window: read everything.
        let raw: string;
        try {
          raw = await readFile(file, "utf8");
        } catch {
          return [];
        }
        parsed = parse(Persistence.jsonlLines(raw));
      }
    } catch {
      return [];
    }

    const filtered = before === undefined ? parsed : parsed.filter((m) => m.seq < before);
    return filtered.slice(-limit);
  }

  /** Largest message seq on record for a room (0 when empty/missing). */
  async loadMaxSeq(roomId: string): Promise<number> {
    const file = join(this.messagesDir, `${roomId}.jsonl`);
    let lines: string[];
    try {
      lines = await this.readTailLines(file);
    } catch {
      return 0;
    }
    let max = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed) as ChatMessage;
        if (typeof message.seq === "number" && message.seq > max) max = message.seq;
      } catch {
        /* skip corrupt line */
      }
    }
    return max;
  }

  /**
   * Messages with `fromSeq <= seq <= toSeq`, oldest first, capped at `limit`
   * (0.1.35 — the owner's answer to a member's sync request).
   *
   * Fast path reads the tail window only and answers from it when the window
   * covers the requested range start (`oldest.seq <= fromSeq`). A range that
   * reaches below the window falls back to a full read, exactly like the `before`
   * cursor in loadRecentMessages. Both paths are bounded by the caller: the
   * member requests at most SYNCFETCH-span seqs at a bounded rate, so this can
   * never turn into a per-reconnect bulk scan.
   */
  async loadMessagesInRange(roomId: string, fromSeq: number, toSeq: number, limit = 200): Promise<ChatMessage[]> {
    const file = join(this.messagesDir, `${roomId}.jsonl`);
    const parse = (lines: string[]): ChatMessage[] => {
      const parsed: ChatMessage[] = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line) as ChatMessage);
        } catch {
          /* skip corrupt line */
        }
      }
      return parsed;
    };
    const inRange = (messages: ChatMessage[]): ChatMessage[] =>
      messages
        .filter((m) => typeof m.seq === "number" && m.seq >= fromSeq && m.seq <= toSeq)
        .sort((a, b) => a.seq - b.seq);

    let windowed: ChatMessage[];
    try {
      windowed = parse(await this.readTailLines(file));
    } catch {
      return [];
    }
    const hits = inRange(windowed);
    const oldest = windowed.length > 0 ? windowed[0]!.seq : Number.POSITIVE_INFINITY;
    if (hits.length >= limit || oldest <= fromSeq) return hits.slice(0, limit);

    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return hits.slice(0, limit);
    }
    return inRange(parse(Persistence.jsonlLines(raw))).slice(0, limit);
  }
}
