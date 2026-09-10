/**
 * dsh-agent-org persistence.
 *
 * Stores the whole org tree as one JSON file under the configured data dir.
 * Default: <DSH_HOME>/agent-org/org-state.json.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_STATE = Object.freeze({
  version: 1,
  nodes: [],
  updatedAt: "",
});

export class OrgPersistence {
  /** @param {string} root */
  constructor(root) {
    this.root = root;
    this.file = join(root, "org-state.json");
  }

  /**
   * @returns {Promise<{version: 1, nodes: Array, updatedAt: string}>}
   */
  async load() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.nodes)) {
        return {
          version: 1,
          nodes: parsed.nodes,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        };
      }
    } catch {
      // Missing/corrupt state starts empty; the service seeds a default company.
    }
    return {
      version: 1,
      nodes: [],
      updatedAt: "",
    };
  }

  /** @param {{version: 1, nodes: Array, updatedAt: string}} state */
  async save(state) {
    await mkdir(this.root, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, this.file);
  }
}
