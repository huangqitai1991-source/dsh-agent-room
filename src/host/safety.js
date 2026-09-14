/**
 * dsh-agent-org — config-safety primitives (0.2.11).
 *
 * Same defect class as dsh-agent-room 0.1.38 (card-00, P0) and worse in one
 * respect: `OrgPersistence.load()` merged "missing" with "damaged" into an empty
 * tree, and the NEXT `save()` wrote that empty tree back — and broadcast it. When
 * the local node is the org owner, `sync.js` makes every non-owner ignore
 * incoming snapshots, which means an owner that read an empty tree would push the
 * empty tree onto the whole organisation with no self-heal.
 *
 * Rules implemented here:
 *   1. Tolerate a leading UTF-8 BOM on read (EF BB BF / U+FEFF).
 *   2. MISSING                -> empty tree / empty config (unchanged).
 *      PRESENT but unparseable -> CorruptConfigError. Never an empty tree.
 *   3. Before the throw, quarantine a byte-identical copy of the offending file.
 *   4. Before overwriting org-state.json, take a bounded, verified, timestamped
 *      backup; a failed backup REFUSES the write.
 *   5. Never overwrite a present-but-unparseable config file.
 *   6. Drop a REFUSED-TO-START marker so the host watchdog cannot convert the
 *      hard stop into a restart loop.
 */

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, win32 } from "node:path";

/** Marker file the host watchdog must respect. */
export const REFUSED_MARKER = "REFUSED-TO-START";
/** Operator bypass for the marker (one deliberately-retried start). */
export const REFUSED_OVERRIDE = "REFUSED-TO-START.override";
/** Backups kept per source file name (bounded, oldest pruned). */
export const BACKUP_KEEP = 10;

const UTF8_BOM = 0xfeff;

function report(message) {
  try {
    console.error(`[agent-org] ${message}`);
  } catch {
    /* ignore */
  }
}

/** The DSH home directory a config path is resolved against. */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** `YYYYMMDD-HHmmss` in local time, the documented backup name stamp. */
export function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * A config path is a CONFIG ERROR, not a per-write failure, when this platform
 * cannot resolve it: a Windows drive-absolute or UNC path is unrunnable on POSIX.
 * The team runs one macOS node, and because backup failure refuses the write, a
 * Windows-only backup root would have refused EVERY org-state write — a safety
 * gate turned into an availability outage. Fail fast and loudly instead.
 */
export function assertPlatformResolvableFor(path, platform) {
  if (platform === "win32") {
    if (!isAbsolute(path)) throw new Error(`config error: backup path is not absolute: ${path}`);
    return;
  }
  if (win32.isAbsolute(path) && !posix.isAbsolute(path)) {
    throw new Error(
      `config error: backup path "${path}" is a Windows-only path and cannot be resolved on ${platform}; ` +
        `set DSH_IDENTITY_BACKUP_DIR to a POSIX path`,
    );
  }
  if (!posix.isAbsolute(path)) throw new Error(`config error: backup path is not absolute: ${path}`);
}

export function assertPlatformResolvable(path) {
  assertPlatformResolvableFor(path, process.platform);
}

/**
 * Where org-state backups and quarantine copies live.
 *   1. `DSH_IDENTITY_BACKUP_DIR` (explicit override, highest priority);
 *   2. otherwise `join(dirname(dshHome), "identity-backups")` — a SIBLING of the
 *      DSH home, never inside the config directory.
 */
export function resolveBackupRoot() {
  const override = process.env.DSH_IDENTITY_BACKUP_DIR?.trim();
  const root = override && override.length > 0 ? override : join(dirname(dshHome()), "identity-backups");
  assertPlatformResolvable(root);
  return root;
}

/** Strip one leading UTF-8 BOM (U+FEFF) — what PowerShell 5.1 writes. */
export function stripBom(text) {
  return text.charCodeAt(0) === UTF8_BOM ? text.slice(1) : text;
}

/**
 * The org host's declared failure contract (0.2.11).
 *
 * Log at error level, then RE-THROW. Before 0.2.11 the bare `void this.boot()`
 * produced an unhandled rejection that the host's process-level `installFailLoud`
 * happened to catch — so "refuse to start" was an accident of the host, not a
 * contract this plugin stated, and it would silently revert to "keep running on an
 * empty tree" if the host ever changed. Re-throwing the SAME error object keeps the
 * host's error-identity checks and the fatal line's content intact.
 */
export function failLoud(label, error, logger) {
  try {
    logger?.error?.(`${label} boot failed: %s`, String(error));
  } catch {
    /* diagnostics only */
  }
  throw error;
}

/**
 * Cached verdict on the backup root for this process.
 *
 * The card separates two failure modes and so does this module:
 *   the path cannot be RESOLVED on this platform -> fatal config error;
 *   the path resolves but cannot be WRITTEN      -> refuse writes, keep running.
 * Making the second case fatal would take a node offline because of a directory
 * permission, which is an availability outage caused by a safety gate.
 */
let rootState = null;

/**
 * Resolve and probe the backup root once at boot. Throws only for an unresolvable
 * path; an unwritable one is recorded and turns every later write into a refusal.
 */
export async function ensureBackupRoot() {
  const root = resolveBackupRoot();
  if (rootState && rootState.root === root && rootState.ok) return root;
  try {
    await mkdir(root, { recursive: true });
    const probe = join(root, `.write-probe-${process.pid}`);
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
    rootState = { root, ok: true };
  } catch (error) {
    rootState = { root, ok: false, reason: String(error) };
    report(
      `backup root ${root} is NOT writable (${String(error)}). ` +
        `Org-state writes will now REFUSE rather than overwrite without a backup. ` +
        `Fix the directory or set DSH_IDENTITY_BACKUP_DIR.`,
    );
  }
  return root;
}

/** The backup root, or a refusal when it has not been proven writable. */
async function usableRoot() {
  const root = resolveBackupRoot();
  if (!rootState || rootState.root !== root || !rootState.ok) await ensureBackupRoot();
  if (!rootState?.ok) {
    throw new Error(
      `refusing to write: the backup root ${root} is not usable (${rootState?.reason ?? "unknown"}); ` +
        `no write may proceed without a verified backup`,
    );
  }
  return root;
}

async function readBytesIfPresent(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function uniquePath(target) {
  for (let i = 0; i < 100; i += 1) {
    const candidate = i === 0 ? target : `${target}.${i}`;
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  return `${target}.${process.pid}`;
}

/** Copy `file` under the backup root and verify it byte-for-byte. */
async function verifiedCopy(file, suffix) {
  const source = await readBytesIfPresent(file);
  if (source === null) return null;
  const root = await usableRoot();
  await mkdir(root, { recursive: true });
  const dest = await uniquePath(join(root, `${basename(file)}.${stamp()}.${suffix}`));
  await copyFile(file, dest);
  const copied = await readFile(dest);
  if (copied.length !== source.length || !copied.equals(source)) {
    await rm(dest, { force: true });
    throw new Error(`backup verification failed for ${file}: copy differs from source`);
  }
  return dest;
}

/** Prune to the newest BACKUP_KEEP ordinary backups for one source file name. */
async function pruneBackups(root, base) {
  let names;
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}\\.\\d{8}-\\d{6}\\.bak(\\.\\d+)?$`);
  const mine = names.filter((n) => pattern.test(n)).sort();
  for (const name of mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP))) {
    try {
      await rm(join(root, name), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Quarantine a byte-identical copy; the original is read only, never moved. */
export async function quarantineFile(file) {
  try {
    const dest = await verifiedCopy(file, "corrupt.bak");
    if (dest) await pruneBackups(dirname(dest), basename(file));
    return dest;
  } catch (error) {
    report(`QUARANTINE FAILED for ${file}: ${String(error)}`);
    return null;
  }
}

/**
 * Bounded, verified, timestamped backup taken BEFORE a write. A failure here
 * throws: the card requires "refuse to write", never "write anyway".
 */
export async function backupBeforeWrite(file) {
  const dest = await verifiedCopy(file, "bak");
  if (dest) await pruneBackups(dirname(dest), basename(file));
  return dest;
}

/** Write the watchdog marker. Best effort: diagnostics only, never throws. */
export async function writeRefusedMarker(configFile, reason) {
  const marker = join(dirname(configFile), REFUSED_MARKER);
  const body = `${new Date().toISOString()}\n${configFile}\n${reason}\n`;
  try {
    await writeFile(marker, body, "utf8");
  } catch (error) {
    report(`could not write ${REFUSED_MARKER} at ${marker}: ${String(error)}`);
  }
}

/** Clear the marker: only a plugin that really finished booting may do this. */
export async function clearRefusedMarker(dataDir) {
  try {
    await rm(join(dataDir, REFUSED_MARKER), { force: true });
  } catch {
    /* ignore */
  }
}

/** True when the watchdog marker exists for a data directory. */
export async function refusedMarkerPresent(dataDir) {
  try {
    await stat(join(dataDir, REFUSED_MARKER));
    return true;
  } catch {
    return false;
  }
}

/**
 * A config file that exists but cannot be parsed. Carries the absolute path so
 * the fatal host line names the file that has to be fixed.
 */
export class CorruptConfigError extends Error {
  constructor(file, reason, cause, quarantine) {
    super(`${basename(file)} is present but not parseable (${reason}) at ${file}`);
    this.name = "CorruptConfigError";
    this.file = file;
    this.reason = reason;
    this.quarantine = quarantine;
    if (cause !== undefined) this.cause = cause;
  }
}

function describeParseFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim();
}

/** Parse JSON text from `file`; quarantines then throws on failure. */
export async function parseConfigText(text, file) {
  const stripped = stripBom(text);
  try {
    return JSON.parse(stripped);
  } catch (error) {
    await raiseCorrupt(file, describeParseFailure(error), error);
  }
}

/**
 * Quarantine, mark and throw: one path for every kind of "present but unusable
 * config" (unparseable bytes, or parseable JSON of the wrong shape).
 */
export async function raiseCorrupt(file, reason, cause) {
  const quarantine = await quarantineFile(file);
  await writeRefusedMarker(file, `corrupt config: ${reason}`);
  throw new CorruptConfigError(file, reason, cause, quarantine);
}

/**
 * The single read entry point for every config file.
 *
 *   file does not exist            -> null            (missing, not corrupt)
 *   file exists, parses (with BOM) -> the parsed value
 *   file exists, does not parse    -> CorruptConfigError (quarantined first)
 *   file exists, parses to null or to a bare primitive -> also CorruptConfigError
 *
 * That last rule matters: `readJsonConfig` promises that null means MISSING, so a
 * file whose entire content is `null` would otherwise be reported as missing and
 * re-open the very confusion this module exists to close.
 */
export async function readJsonConfig(file) {
  const bytes = await readBytesIfPresent(file);
  if (bytes === null) return null;
  const value = await parseConfigText(bytes.toString("utf8"), file);
  if (value === null || typeof value !== "object") {
    await raiseCorrupt(file, `present but the JSON value is ${value === null ? "null" : typeof value}`);
  }
  return value;
}

/**
 * Refuse to touch a config file that is present but unparseable, so a damaged
 * org-state.json can never be replaced by an empty tree.
 */
export async function assertNotCorrupt(file) {
  const bytes = await readBytesIfPresent(file);
  if (bytes === null) return;
  await parseConfigText(bytes.toString("utf8"), file);
}

/* ------------------------- G1: content validation ------------------------ */

/**
 * Any RFC-4122 UUID shape (8-4-4-4-12 hex).
 *
 * Deliberately NOT pinned to version 7. Every agentId observed on the four team
 * machines is v7, but a legacy v4 id must not become a startup outage: the guard
 * exists to reject empty/garbage identities, not to police a version nibble.
 */
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a value can serve as an agentId. */
export function isUuidShaped(value) {
  return typeof value === "string" && UUID_SHAPED.test(value);
}

/**
 * Reject the nickname damage classes the card names: blank/whitespace only,
 * replacement characters (U+FFFD), runs of "?", and the literal placeholder
 * "NAME" that an unfilled template once wrote onto two machines — where it then
 * kept being broadcast for 70 minutes and landed in 22 append-only message rows.
 * @returns {string|null} the reason it is unacceptable, or null when it is fine
 */
export function nicknameProblem(nickname) {
  if (typeof nickname !== "string") return "nickname is not a string";
  const trimmed = nickname.trim();
  if (!trimmed) return "nickname is blank";
  if (trimmed === "NAME") return 'nickname is the unfilled placeholder "NAME"';
  if (trimmed.includes("\uFFFD")) return "nickname contains U+FFFD (replacement character)";
  if (/\?{2,}/.test(trimmed)) return 'nickname contains consecutive "?" (decode damage)';
  return null;
}

/** Throw unless `identity` is safe to persist. */
export function assertValidIdentity(identity) {
  if (!identity || typeof identity !== "object") throw new Error("org: refusing to write a non-object identity");
  if (!isUuidShaped(identity.agentId)) {
    throw new Error(`org: refusing to write an identity whose agentId is not a UUID: ${JSON.stringify(identity.agentId)}`);
  }
  const problem = nicknameProblem(identity.nickname);
  if (problem) throw new Error(`org: refusing to write this identity: ${problem}`);
}
