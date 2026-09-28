/**
 * dsh-agent-room — config-safety primitives (0.1.38).
 *
 * The defect this module closes (card-00, P0): a config file that is PRESENT but
 * unparseable — classically one round-tripped through Windows PowerShell 5.1's
 * `Set-Content -Encoding UTF8`, which unconditionally writes a UTF-8 BOM — was
 * indistinguishable from a MISSING file, because `readJson` swallowed the parse
 * error and returned null. `ensureIdentity()` read that null as "this node has no
 * identity yet", minted a fresh uuidv7 and OVERWROTE the file. That is
 * irreversible: the agentId keys room ownership, membership, task permissions,
 * org membership and audit attribution, and identity has no cross-machine
 * convergence that could ever restore it.
 *
 * Rules implemented here:
 *   1. Tolerate a leading UTF-8 BOM on read (EF BB BF / U+FEFF).
 *   2. MISSING                -> null  (a first run may legitimately mint).
 *      PRESENT but unparseable -> CorruptConfigError. Never null. Never minted.
 *   3. Before the throw, quarantine a byte-identical copy of the offending file,
 *      so a repair never has to depend on another machine's records.
 *   4. Before overwriting a config file, take a bounded, timestamped backup and
 *      verify it byte-for-byte. Backup failure REFUSES the write.
 *   5. Never overwrite a present-but-unparseable config file.
 *   6. Drop a REFUSED-TO-START marker so the host watchdog cannot convert the
 *      hard stop into a restart loop.
 */
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, win32 } from "node:path";
/** Marker file the host watchdog must respect (see docs/RELEASE-0.1.38.md). */
export const REFUSED_MARKER = "REFUSED-TO-START";
/** Operator bypass for the marker (one deliberately-retried start). */
export const REFUSED_OVERRIDE = "REFUSED-TO-START.override";
/** Backups kept per source file name (bounded, oldest pruned). */
export const BACKUP_KEEP = 10;
const UTF8_BOM = 0xfeff;
function errorCode(error) {
    return error?.code ?? "";
}
function report(message) {
    try {
        console.error(`[agent-room] ${message}`);
    }
    catch {
        /* ignore */
    }
}
/** The DSH home directory a config path is resolved against. */
export function dshHome() {
    return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
/** `YYYYMMDD-HHmmss` in local time, the documented backup name stamp. */
export function stamp(now = new Date()) {
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return (`${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
        `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`);
}
/**
 * A config path is a CONFIG ERROR, not a per-write failure, when this platform
 * cannot resolve it: a Windows drive-absolute or UNC path is unrunnable on
 * POSIX. Version 0.2 of the card hardcoded `<workdir>\identity-backups`; on the
 * team's macOS node there is no `D:\` volume, and because backup failure refuses
 * the write, that would have refused EVERY identity write — a safety gate turned
 * into an availability outage. Fail fast and loudly instead.
 */
export function assertPlatformResolvableFor(path, platform) {
    if (platform === "win32") {
        if (!isAbsolute(path))
            throw new Error(`config error: backup path is not absolute: ${path}`);
        return;
    }
    // POSIX: anything a Windows parser calls absolute is a Windows-only path.
    if (win32.isAbsolute(path) && !posix.isAbsolute(path)) {
        throw new Error(`config error: backup path "${path}" is a Windows-only path and cannot be resolved on ${platform}; ` +
            `set DSH_IDENTITY_BACKUP_DIR to a POSIX path`);
    }
    if (!posix.isAbsolute(path))
        throw new Error(`config error: backup path is not absolute: ${path}`);
}
export function assertPlatformResolvable(path) {
    assertPlatformResolvableFor(path, process.platform);
}
/**
 * Where identity/org-state backups and quarantine copies live.
 *
 * Resolved per platform, never hardcoded to a drive letter:
 *   1. `DSH_IDENTITY_BACKUP_DIR` (explicit override, highest priority);
 *   2. otherwise `join(dirname(dshHome), "identity-backups")` — a SIBLING of the
 *      DSH home, never inside the config directory (which would pollute the BOM
 *      scan range).
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
 * The room host's declared failure contract (0.1.38).
 *
 * Log at error level, then RE-THROW. The re-throw is the point: it escapes
 * `boot()`'s fire-and-forget chain as a rejected promise nobody handles, which is
 * what reaches the host's fatal path (`installFailLoud`: "dsh: fatal load
 * failure: <stack>" then exit 1, after disposing the half-built fiber). A logger
 * call alone — today's behaviour — leaves the process alive with the entire room
 * host dead, which is strictly worse than stopping.
 *
 * Re-throwing the SAME object (never a wrapper) matters: the host inspects the
 * error identity, and the fatal line must name CorruptConfigError and the file.
 */
export function failLoud(label, error, logger) {
    try {
        logger?.error?.(`${label} boot failed: %s`, String(error));
    }
    catch {
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
    if (rootState && rootState.root === root && rootState.ok)
        return root;
    try {
        await mkdir(root, { recursive: true });
        const probe = join(root, `.write-probe-${process.pid}`);
        await writeFile(probe, "ok", "utf8");
        await rm(probe, { force: true });
        rootState = { root, ok: true };
    }
    catch (error) {
        rootState = { root, ok: false, reason: String(error) };
        report(`backup root ${root} is NOT writable (${String(error)}). ` +
            `Identity/state writes will now REFUSE rather than overwrite without a backup. ` +
            `Fix the directory or set DSH_IDENTITY_BACKUP_DIR.`);
    }
    return root;
}
/** The backup root, or a refusal when it has not been proven writable. */
async function usableRoot() {
    const root = resolveBackupRoot();
    if (!rootState || rootState.root !== root || !rootState.ok)
        await ensureBackupRoot();
    if (!rootState?.ok) {
        throw new Error(`refusing to write: the backup root ${root} is not usable (${rootState?.reason ?? "unknown"}); ` +
            `no write may proceed without a verified backup`);
    }
    return root;
}
/** Raw bytes of a file, or null when it does not exist. */
async function readBytesIfPresent(file) {
    try {
        return await readFile(file);
    }
    catch (error) {
        if (errorCode(error) === "ENOENT")
            return null;
        throw error;
    }
}
async function uniquePath(target) {
    for (let i = 0; i < 100; i += 1) {
        const candidate = i === 0 ? target : `${target}.${i}`;
        try {
            await stat(candidate);
        }
        catch {
            return candidate;
        }
    }
    return `${target}.${process.pid}`;
}
/**
 * Copy `file` next to the backup root under `<name>.<stamp>.<suffix>` and verify
 * the copy. Returns the copy path, or null when the source does not exist.
 * Throws when the copy is short/different — callers must then REFUSE to proceed.
 */
async function verifiedCopy(file, suffix) {
    const source = await readBytesIfPresent(file);
    if (source === null)
        return null;
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
/**
 * Prune to the newest BACKUP_KEEP ordinary backups for one source file name.
 *
 * Matches ONLY `<base>.<YYYYMMDD-HHmmss>.bak` (plus its collision suffix), so a
 * quarantine copy or a pre-repair copy is never pruned by routine backup churn:
 * those files are evidence, and they are small.
 */
async function pruneBackups(root, base) {
    let names;
    try {
        names = await readdir(root);
    }
    catch {
        return;
    }
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}\\.\\d{8}-\\d{6}\\.bak(\\.\\d+)?$`);
    const mine = names.filter((n) => pattern.test(n)).sort();
    for (const name of mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP))) {
        try {
            await rm(join(root, name), { force: true });
        }
        catch {
            /* ignore */
        }
    }
}
/**
 * Quarantine a byte-identical copy of a damaged config file. The original is
 * READ ONLY, never moved or rewritten, so its bytes and mtime are preserved.
 * Returns the copy path, or null if quarantine could not be completed (the
 * caller still throws: the corruption is the primary failure).
 */
export async function quarantineFile(file) {
    try {
        const dest = await verifiedCopy(file, "corrupt.bak");
        if (dest)
            await pruneBackups(dirname(dest), basename(file));
        return dest;
    }
    catch (error) {
        report(`QUARANTINE FAILED for ${file}: ${String(error)}`);
        return null;
    }
}
/**
 * Bounded, verified, timestamped backup taken BEFORE a write. Returns the copy
 * path, or null when there is nothing to back up (first write).
 *
 * A failure here throws: the card requires "refuse to write", never "write
 * anyway" — `writeJsonAtomicOnce` swallows its own failures, so a backup is the
 * only guarantee that the previous bytes survive.
 */
export async function backupBeforeWrite(file) {
    const dest = await verifiedCopy(file, "bak");
    if (dest)
        await pruneBackups(dirname(dest), basename(file));
    return dest;
}
/** Write the watchdog marker. Best effort: diagnostics only, never throws. */
export async function writeRefusedMarker(configFile, reason) {
    const marker = join(dirname(configFile), REFUSED_MARKER);
    const body = `${new Date().toISOString()}\n` +
        `${configFile}\n` +
        `${reason}\n`;
    try {
        await writeFile(marker, body, "utf8");
    }
    catch (error) {
        report(`could not write ${REFUSED_MARKER} at ${marker}: ${String(error)}`);
    }
}
/** Clear the marker: only a plugin that really finished booting may do this. */
export async function clearRefusedMarker(dataDir) {
    try {
        await rm(join(dataDir, REFUSED_MARKER), { force: true });
    }
    catch {
        /* ignore */
    }
}
/** True when the watchdog marker exists for a data directory. */
export async function refusedMarkerPresent(dataDir) {
    try {
        await stat(join(dataDir, REFUSED_MARKER));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * A config file that exists but cannot be parsed. Carries the absolute path so
 * the fatal host line names the file that has to be fixed.
 */
export class CorruptConfigError extends Error {
    file;
    reason;
    quarantine;
    constructor(file, reason, cause, quarantine) {
        super(`${basename(file)} is present but not parseable (${reason}) at ${file}`);
        this.name = "CorruptConfigError";
        this.file = file;
        this.reason = reason;
        this.quarantine = quarantine;
        if (cause !== undefined)
            this.cause = cause;
    }
}
function describeParseFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/\s+/g, " ").trim();
}
/**
 * Parse JSON text that came from `file`. Throws CorruptConfigError after
 * quarantining the original. BOM-tolerant by design.
 */
export async function parseConfigText(text, file) {
    const stripped = stripBom(text);
    try {
        return JSON.parse(stripped);
    }
    catch (error) {
        return await raiseCorrupt(file, describeParseFailure(error), error);
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
 * That last rule matters: this function promises that null means MISSING, so a
 * file whose entire content is `null` would otherwise be reported as missing and
 * re-open the very confusion this module exists to close.
 */
export async function readJsonConfig(file) {
    const bytes = await readBytesIfPresent(file);
    if (bytes === null)
        return null;
    // utf8 decode, then BOM strip: `readFile(..., "utf8")` does NOT strip U+FEFF.
    const value = await parseConfigText(bytes.toString("utf8"), file);
    if (value === null || typeof value !== "object") {
        await raiseCorrupt(file, `present but the JSON value is ${value === null ? "null" : typeof value}`);
    }
    return value;
}
/**
 * Refuse to touch a config file that is present but unparseable. The minting
 * path calls this through `saveIdentity`, which makes "a damaged identity.json
 * can never be overwritten" a structural property of the write boundary rather
 * than a promise about every call site.
 */
export async function assertNotCorrupt(file) {
    const bytes = await readBytesIfPresent(file);
    if (bytes === null)
        return;
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
 * "NAME" — which an unfilled template once wrote onto two machines, where it kept
 * being broadcast for 70 minutes and landed in 22 append-only message rows.
 * @returns the reason it is unacceptable, or null when it is fine
 */
export function nicknameProblem(nickname) {
    if (typeof nickname !== "string")
        return "nickname is not a string";
    const trimmed = nickname.trim();
    if (!trimmed)
        return "nickname is blank";
    if (trimmed === "NAME")
        return 'nickname is the unfilled placeholder "NAME"';
    if (trimmed.includes("\uFFFD"))
        return "nickname contains U+FFFD (replacement character)";
    if (/\?{2,}/.test(trimmed))
        return 'nickname contains consecutive "?" (decode damage)';
    return null;
}
/* ---------------------- rename entry point refusals ---------------------- */
/**
 * A nickname that must not be written anywhere (0.1.40).
 *
 * A named class, not a bare Error, because the rename route has to answer 400
 * (the caller sent something unusable) rather than 500 (the node broke), and
 * because "a rejected name changes nothing anywhere" is only checkable if the
 * rollback boundary is a single throw that happens BEFORE any store is touched.
 */
export class InvalidNicknameError extends Error {
    reason;
    constructor(reason) {
        super(`拒绝写入该昵称：${reason}`);
        this.name = "InvalidNicknameError";
        this.reason = reason;
    }
}
/**
 * The rename entry point's identity guard (0.1.40).
 *
 * Raised when `roomService.getIdentity()` is null — i.e. the identity cache is
 * empty because boot has not finished. The entry point REFUSES instead of calling
 * `ensureIdentity()` / `gateway.identity()`, which MINT a fresh identity (and
 * write it) when the cache is empty: a rename must never be the reason a node's
 * agentId changes.
 */
export class IdentityNotReadyError extends Error {
    constructor(message = "本机身份未就绪（身份缓存为空），改名被拒绝：不使用会铸造新身份的 ensureIdentity()/gateway.identity()") {
        super(message);
        this.name = "IdentityNotReadyError";
    }
}
/**
 * G1 for the rename entry point: trim, then reject every damage class in
 * `nicknameProblem`, returning the value that may be written.
 *
 * The room, the org tree and the repair tool all call this (or the same
 * predicate) BEFORE their first write, so a rejected name cannot leave a store
 * half-updated.
 */
export function assertValidNickname(nickname) {
    if (typeof nickname !== "string")
        throw new InvalidNicknameError("昵称必须是字符串");
    const trimmed = nickname.trim();
    const problem = nicknameProblem(trimmed);
    if (problem)
        throw new InvalidNicknameError(problem);
    return trimmed;
}
