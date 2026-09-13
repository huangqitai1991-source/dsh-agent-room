/**
 * dsh-agent-org persistence.
 *
 * Stores the whole org tree as one JSON file under the configured data dir.
 * Default: <DSH_HOME>/agent-org/org-state.json.
 *
 * Hardening (0.2.4): the atomic write used a FIXED tmp name (`${file}.tmp`) with
 * no serialization, so two overlapping saves of the same target could consume
 * each other's tmp file and the second `rename` failed with ENOENT — the same
 * defect class found in dsh-agent-room 0.1.25. Fixes: unique tmp name per
 * attempt, in-process serialization per target file, rename retries for
 * transient errors, and persistence failures are logged but never thrown.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Retryable rename failures (transient AV / indexer / sharing violations). */
const RETRYABLE_RENAME = new Set(["ENOENT", "EPERM", "EACCES", "EBUSY"]);
const WRITE_ATTEMPTS = 4;

/** target file -> tail of the in-process write chain (serializes saves). */
const writeChains = new Map();

function report(what, error) {
  const message = error instanceof Error ? error.message : String(error);
  // Persistence must never take the host down; diagnostics go to stderr.
  try {
    console.error(`[agent-org] persistence ${what}: ${message}`);
  } catch {
    /* ignore */
  }
}

async function writeJsonAtomicOnce(file, value) {
  const payload = JSON.stringify(value, null, 2);
  let lastError = null;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    // Unique per attempt: overlapping writers can never eat each other's tmp.
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      const code = error?.code ?? "";
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

/** Serialize writes per target file; failures are logged, never thrown. */
function writeJsonAtomic(file, value) {
  const previous = writeChains.get(file) ?? Promise.resolve();
  const next = previous
    .then(() => writeJsonAtomicOnce(file, value))
    .catch((error) => report(`write ${file}`, error));
  writeChains.set(file, next);
  void next.finally(() => {
    if (writeChains.get(file) === next) writeChains.delete(file);
  });
  return next;
}

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
    await writeJsonAtomic(this.file, state);
  }

  /** Load the sync room config ({ roomId?: string }). */
  async loadSyncConfig() {
    const file = join(this.root, "sync-config.json");
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // missing/corrupt -> empty
    }
    return {};
  }

  /** Persist the sync room config. */
  async saveSyncConfig(config) {
    await mkdir(this.root, { recursive: true });
    await writeJsonAtomic(join(this.root, "sync-config.json"), config);
  }
}
