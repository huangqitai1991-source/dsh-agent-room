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
import { assertNotCorrupt, backupBeforeWrite, raiseCorrupt, readJsonConfig } from "./safety.js";

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
   * Load the org tree (0.2.11).
   *
   * MISSING file            -> an empty tree (a fresh install; unchanged).
   * PRESENT but unparseable -> throws CorruptConfigError, quarantined first.
   *
   * 0.2.10 and earlier returned an empty tree for BOTH cases. That is not a
   * harmless default: `save()` writes the read-back state, so one BOM — which
   * Windows PowerShell 5.1 `Set-Content -Encoding UTF8` writes unconditionally —
   * turned a damaged file into an irreversibly emptied org tree, and then
   * broadcast it to every other machine.
   *
   * @returns {Promise<{version: 1, nodes: Array, updatedAt: string}>}
   */
  async load() {
    const parsed = await readJsonConfig(this.file);
    if (parsed === null) {
      return {
        version: 1,
        nodes: [],
        updatedAt: "",
      };
    }
    if (parsed && Array.isArray(parsed.nodes)) {
      return {
        version: 1,
        nodes: parsed.nodes,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      };
    }
    // Parseable but not a tree: the same damage class as a parse failure, and
    // equally destructive if it were written back as an empty tree.
    await raiseCorrupt(this.file, 'present but has no "nodes" array');
  }

  /**
   * Persist the org tree (0.2.11): refuse to overwrite a damaged file, and take
   * a verified timestamped backup first. `save()` is the only writer, so this is
   * the only place G2 has to hold.
   * @param {{version: 1, nodes: Array, updatedAt: string}} state
   */
  async save(state) {
    await mkdir(this.root, { recursive: true });
    await assertNotCorrupt(this.file);
    await backupBeforeWrite(this.file);
    await writeJsonAtomic(this.file, state);
  }

  /**
   * Load the sync room config (0.2.11). MISSING -> `{}`; PRESENT but unparseable
   * -> CorruptConfigError. Returning `{}` for a BOM'd file used to make
   * `config.syncRoomId` empty, silently dropping this node out of cross-machine
   * sync with no diagnostic anywhere.
   */
  async loadSyncConfig() {
    const parsed = await readJsonConfig(join(this.root, "sync-config.json"));
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  }

  /** Persist the sync room config. */
  async saveSyncConfig(config) {
    await mkdir(this.root, { recursive: true });
    await writeJsonAtomic(join(this.root, "sync-config.json"), config);
  }
}
