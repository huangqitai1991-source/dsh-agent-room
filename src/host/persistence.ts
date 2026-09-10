/**
 * dsh-agent-room — persistence under <DSH_HOME>/agent-room/.
 *
 * Layout:
 *   identity.json            node identity
 *   joined.json              rooms this node joined/created (recent list)
 *   rooms/<roomId>.json      persistent room state (metadata + members + tasks)
 *   messages/<roomId>.jsonl  persistent room chat stream (append-only)
 */

import { mkdir, readFile, rename, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentIdentity, ChatMessage, JoinedRoomRecord, Room } from "../types.js";

export class Persistence {
  readonly root: string;
  private readonly roomsDir: string;
  private readonly messagesDir: string;

  constructor(root: string) {
    this.root = root;
    this.roomsDir = join(root, "rooms");
    this.messagesDir = join(root, "messages");
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.roomsDir, { recursive: true });
    await mkdir(this.messagesDir, { recursive: true });
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async writeJsonAtomic(file: string, value: unknown): Promise<void> {
    await this.ensureDirs();
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, file);
  }

  /* ------------------------------ identity ----------------------------- */

  async loadIdentity(): Promise<AgentIdentity | null> {
    return this.readJson<AgentIdentity>(join(this.root, "identity.json"));
  }

  async saveIdentity(identity: AgentIdentity): Promise<void> {
    await this.writeJsonAtomic(join(this.root, "identity.json"), identity);
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

  /** Read the last `limit` messages before `before` (exclusive), oldest-first. */
  async loadRecentMessages(roomId: string, limit = 200, before?: number): Promise<ChatMessage[]> {
    const file = join(this.messagesDir, `${roomId}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const parsed: ChatMessage[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as ChatMessage);
      } catch {
        /* skip corrupt line */
      }
    }
    const filtered = before === undefined ? parsed : parsed.filter((m) => m.seq < before);
    return filtered.slice(-limit);
  }

  /** Largest message seq on record for a room (0 when empty/missing). */
  async loadMaxSeq(roomId: string): Promise<number> {
    const file = join(this.messagesDir, `${roomId}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return 0;
    }
    let max = 0;
    for (const line of raw.split("\n")) {
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
}
