/**
 * dsh-agent-org — audit log (append-only JSONL, exportable).
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export class AuditLog {
  /** @param {string} root */
  constructor(root) {
    this.root = root;
    this.file = join(root, "audit.jsonl");
  }

  /** @param {{agentId: string, action: string, target?: string, result: string}} entry */
  async append(entry) {
    await mkdir(this.root, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      agentId: entry.agentId ?? "",
      action: entry.action ?? "",
      target: entry.target ?? "",
      result: entry.result ?? "",
    });
    await appendFile(this.file, line + "\n", "utf8");
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
