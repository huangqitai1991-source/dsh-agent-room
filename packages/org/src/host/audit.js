/**
 * dsh-agent-org — audit log (append-only JSONL, exportable).
 */
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Rotate before the log can grow into hundreds of MB (a real node hit 411 MB). */
const MAX_BYTES = 16 * 1024 * 1024;
/** How many rotated files to keep. */
const KEEP_ROTATED = 3;

export class AuditLog {
  /** @param {string} root */
  constructor(root) {
    this.root = root;
    this.file = join(root, "audit.jsonl");
  }

  /** @param {{agentId: string, action: string, target?: string, result: string}} entry */
  async append(entry) {
    await mkdir(this.root, { recursive: true });
    await this.rotateIfNeeded();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      agentId: entry.agentId ?? "",
      action: entry.action ?? "",
      target: entry.target ?? "",
      result: entry.result ?? "",
    });
    await appendFile(this.file, line + "\n", "utf8");
  }

  /**
   * Keep the log bounded without losing history: rename the live file when it
   * crosses MAX_BYTES, then delete the oldest rotations. Best-effort — an audit
   * log must never break the caller.
   */
  async rotateIfNeeded() {
    try {
      const info = await stat(this.file);
      if (info.size < MAX_BYTES) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await rename(this.file, join(this.root, "audit-" + stamp + ".jsonl"));
      const entries = (await readdir(this.root))
        .filter((name) => /^audit-.*\.jsonl$/.test(name))
        .sort();
      for (const stale of entries.slice(0, Math.max(0, entries.length - KEEP_ROTATED))) {
        await unlink(join(this.root, stale));
      }
    } catch {
      // No file yet, or the rename lost a race with another writer: keep going.
    }
  }

  /** @returns {Promise<Array>} */
  async export() {
    try {
      const raw = await readFile(this.file, "utf8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
