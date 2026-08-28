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
export class Persistence {
    root;
    roomsDir;
    messagesDir;
    constructor(root) {
        this.root = root;
        this.roomsDir = join(root, "rooms");
        this.messagesDir = join(root, "messages");
    }
    async ensureDirs() {
        await mkdir(this.roomsDir, { recursive: true });
        await mkdir(this.messagesDir, { recursive: true });
    }
    async readJson(file) {
        try {
            const raw = await readFile(file, "utf8");
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    async writeJsonAtomic(file, value) {
        await this.ensureDirs();
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
        await rename(tmp, file);
    }
    /* ------------------------------ identity ----------------------------- */
    async loadIdentity() {
        return this.readJson(join(this.root, "identity.json"));
    }
    async saveIdentity(identity) {
        await this.writeJsonAtomic(join(this.root, "identity.json"), identity);
    }
    /** Relay auth secrets, keyed by roomId. Kept in a sidecar file so room
     *  snapshots can never leak a relay secret to members. */
    async loadRelaySecrets() {
        return (await this.readJson(join(this.root, "relay-secrets.json"))) ?? {};
    }
    async saveRelaySecrets(secrets) {
        await this.writeJsonAtomic(join(this.root, "relay-secrets.json"), secrets);
    }
    /* ------------------------------ joined rooms ------------------------- */
    async loadJoined() {
        return (await this.readJson(join(this.root, "joined.json"))) ?? [];
    }
    async saveJoined(records) {
        await this.writeJsonAtomic(join(this.root, "joined.json"), records);
    }
    /* ------------------------------ rooms -------------------------------- */
    async loadPersistentRooms() {
        await this.ensureDirs();
        const out = [];
        let names;
        try {
            names = await readdir(this.roomsDir);
        }
        catch {
            return out;
        }
        for (const name of names) {
            if (!name.endsWith(".json"))
                continue;
            const room = await this.readJson(join(this.roomsDir, name));
            if (room)
                out.push(room);
        }
        return out;
    }
    async saveRoom(room) {
        await this.writeJsonAtomic(join(this.roomsDir, `${room.roomId}.json`), room);
    }
    async deleteRoom(roomId) {
        try {
            await rm(join(this.roomsDir, `${roomId}.json`), { force: true });
            await rm(join(this.messagesDir, `${roomId}.jsonl`), { force: true });
        }
        catch {
            /* ignore */
        }
    }
    /* ------------------------------ messages ----------------------------- */
    async appendMessage(roomId, message) {
        await this.ensureDirs();
        const file = join(this.messagesDir, `${roomId}.jsonl`);
        await writeFile(file, `${JSON.stringify(message)}\n`, { flag: "a", encoding: "utf8" });
    }
    /** Read the last `limit` messages before `before` (exclusive), oldest-first. */
    async loadRecentMessages(roomId, limit = 200, before) {
        const file = join(this.messagesDir, `${roomId}.jsonl`);
        let raw;
        try {
            raw = await readFile(file, "utf8");
        }
        catch {
            return [];
        }
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        const parsed = [];
        for (const line of lines) {
            try {
                parsed.push(JSON.parse(line));
            }
            catch {
                /* skip corrupt line */
            }
        }
        const filtered = before === undefined ? parsed : parsed.filter((m) => m.seq < before);
        return filtered.slice(-limit);
    }
    /** Largest message seq on record for a room (0 when empty/missing). */
    async loadMaxSeq(roomId) {
        const file = join(this.messagesDir, `${roomId}.jsonl`);
        let raw;
        try {
            raw = await readFile(file, "utf8");
        }
        catch {
            return 0;
        }
        let max = 0;
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const message = JSON.parse(trimmed);
                if (typeof message.seq === "number" && message.seq > max)
                    max = message.seq;
            }
            catch {
                /* skip corrupt line */
            }
        }
        return max;
    }
}
