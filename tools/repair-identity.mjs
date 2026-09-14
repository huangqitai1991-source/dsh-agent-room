#!/usr/bin/env node
/**
 * repair-identity.mjs — reconnect a node to the agentId it already had.
 *
 * WHY THIS EXISTS (card-00, P0)
 *   A present-but-unparseable identity.json used to make the plugin mint a fresh
 *   agentId and overwrite the file. Identity does NOT converge across machines
 *   (it is the one config that is locally authoritative), so the old id survives
 *   only on OTHER machines: in a room's member list, in the org tree, in the
 *   append-only message log. This tool finds those records.
 *
 *   It never guesses. Without `--apply` it only reports. With `--apply` it still
 *   requires an explicit `--agent-id`, taken from the list it just printed, and it
 *   backs up the current file BEFORE writing.
 *
 * SELF-CONTAINED ON PURPOSE: only Node built-ins are imported, because this must
 *   run on a machine whose plugin currently refuses to start.
 *
 * USAGE (all steps are runnable by that machine alone, no interactive prompt)
 *   # 1. report only — nothing is written
 *   node tools/repair-identity.mjs --home "%USERPROFILE%\.dsh"
 *
 *   # 2. restore the id the report showed, and say which record you trust
 *   node tools/repair-identity.mjs --home "%USERPROFILE%\.dsh" ^
 *     --apply --agent-id <uuid> --from rooms --nickname <name>
 *
 *   # 3. add another machine's config directory as an independent witness
 *   node tools/repair-identity.mjs --home "%USERPROFILE%\.dsh" --extra-root D:\copied\.dsh
 *
 *   # 4. re-seed an org tree that was emptied (only when nothing else can restore it)
 *   node tools/repair-identity.mjs --home "%USERPROFILE%\.dsh" ^
 *     --reseed-org --apply --company-leader <uuid> --company-name "My Company"
 *
 *   # 5. repair a DAMAGED DISPLAY NAME (card-01, 0.1.40): report first, then apply
 *   node tools/repair-identity.mjs --home "%USERPROFILE%\.dsh" --repair-names
 *   node tools/repair-identity.mjs --home "%USERPROFILE%\.dsh" --repair-names ^
 *     --apply --set-name <agentId>=<the name you want>
 *
 * EXIT CODES
 *   0  report printed (and, with --apply, the repair was performed)
 *   1  the request could not be carried out (message says why; nothing written)
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_LABELS = ["identity", "rooms", "org", "messages", "backups"];

/* ------------------------------- arguments ------------------------------- */

function parseArgs(argv) {
  const out = { extraRoots: [], setNames: [], flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const takesValue = ["home", "extra-root", "backup-dir", "agent-id", "nickname", "from", "company-leader", "company-name", "member-agent-id", "member-name", "set-name"];
    if (!takesValue.includes(key)) {
      out.flags.add(key);
      continue;
    }
    const value = inlineValue ?? argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
    if (inlineValue === undefined) i += 1;
    if (key === "extra-root") out.extraRoots.push(value);
    else if (key === "set-name") out.setNames.push(value);
    else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
}

function usage() {
  return [
    "usage: node tools/repair-identity.mjs --home <dshHome> [options]",
    "",
    "  --home <dir>            the DSH home whose node is being repaired (required)",
    "  --extra-root <dir>      another machine's DSH home, used as an extra witness (repeatable)",
    "  --backup-dir <dir>      where to look for .bak copies (default: resolved like the plugin does)",
    "  --json                  print the report as JSON",
    "",
    "  --apply                 actually write (without it nothing is written)",
    "  --agent-id <uuid>       the id to restore; must appear in the report",
    "  --from <label>          require the id to come from this record class:",
    `                          ${SOURCE_LABELS.join(" | ")}`,
    "  --nickname <name>       nickname to write (default: keep the current one)",
    "  --allow-unknown-id      permit an --agent-id that the scan did not find (loudly reported)",
    "",
    "  --reseed-org            write a minimal org tree skeleton (needs --apply)",
    "  --company-leader <uuid> the company leader (usually the restored agentId)",
    "  --company-name <name>   company node name (default: My Company)",
    "  --member-agent-id <uuid>  also add this member node",
    "  --member-name <name>    member node name (default: the agentId)",
    "  --force                 allow --reseed-org over a tree that already has a company",
    "",
    "  --repair-names          report every DAMAGED display name (identity.json nickname",
    "                          and org-state.json node names). Nothing is written.",
    "  --set-name <agentId>=<name>  with --repair-names --apply: the name to write for that",
    "                          agentId (repeatable). Explicit on purpose: the tool never",
    "                          guesses a name, and a name the plugin's own gate rejects is",
    "                          refused before anything is written.",
  ].join("\n");
}

/* ------------------------------ small helpers ---------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Read + parse tolerating a BOM. Returns {ok, value, bytes, error}. */
async function readJsonish(file) {
  try {
    const bytes = await readFile(file);
    try {
      return { ok: true, value: JSON.parse(stripBom(bytes.toString("utf8"))), bytes, error: null };
    } catch (error) {
      return { ok: false, value: null, bytes, error: String(error?.message ?? error) };
    }
  } catch (error) {
    return { ok: false, value: null, bytes: null, error: String(error?.code ?? error) };
  }
}

/** The plugin's own backup-root rule: never a hardcoded drive letter. */
function resolveBackupRoot(home, explicit) {
  if (explicit) return resolve(explicit);
  const envDir = process.env.DSH_IDENTITY_BACKUP_DIR?.trim();
  if (envDir) return resolve(envDir);
  return join(dirname(home), "identity-backups");
}

/* -------------------------------- scanning ------------------------------- */

function addCandidate(candidates, agentId, nickname, label, detail) {
  if (typeof agentId !== "string" || !UUID_SHAPED.test(agentId)) return;
  let entry = candidates.get(agentId);
  if (!entry) {
    entry = { agentId, nicknames: new Map(), labels: new Set(), evidence: [] };
    candidates.set(agentId, entry);
  }
  entry.labels.add(label);
  const key = typeof nickname === "string" && nickname.trim() ? nickname.trim() : "(unnamed)";
  entry.nicknames.set(key, (entry.nicknames.get(key) ?? 0) + 1);
  if (entry.evidence.length < 40) entry.evidence.push({ label, detail, nickname: key });
}

async function listFiles(dir, filter) {
  try {
    return (await readdir(dir)).filter(filter).sort();
  } catch {
    return [];
  }
}

async function scanRoot(root, candidates, notes) {
  // (1) this node's own identity file, parseable or not
  const identityFile = join(root, "agent-room", "identity.json");
  const identity = await readJsonish(identityFile);
  if (identity.bytes === null) {
    notes.push(`${identityFile}: not present`);
  } else if (identity.ok) {
    addCandidate(candidates, identity.value?.agentId, identity.value?.nickname, "identity", `${identityFile} (current identity on this machine)`);
  } else {
    notes.push(`${identityFile}: PRESENT BUT NOT PARSEABLE (${identity.error}) - this is the damaged file`);
  }

  // (2) room member lists - the room OWNER holds these, members only read them
  const roomsDir = join(root, "agent-room", "rooms");
  for (const name of await listFiles(roomsDir, (n) => n.endsWith(".json"))) {
    const room = await readJsonish(join(roomsDir, name));
    if (!room.ok) {
      notes.push(`${join(roomsDir, name)}: unreadable (${room.error})`);
      continue;
    }
    for (const member of room.value?.members ?? []) {
      addCandidate(candidates, member?.agentId, member?.nickname, "rooms", `rooms/${name} members[] (room "${room.value?.title ?? "?"}")`);
    }
  }

  // (3) the org tree - every machine holds a copy, so this is a second witness
  const orgFile = join(root, "agent-org", "org-state.json");
  const org = await readJsonish(orgFile);
  if (org.bytes !== null && !org.ok) notes.push(`${orgFile}: PRESENT BUT NOT PARSEABLE (${org.error})`);
  for (const node of org.value?.nodes ?? []) {
    if (node?.kind === "member") addCandidate(candidates, node.agentId, node.name, "org", `org-state.json kind=member "${node.name}"`);
    if (node?.leaderAgentId) addCandidate(candidates, node.leaderAgentId, node.name, "org", `org-state.json kind=${node.kind} leaderAgentId ("${node.name}")`);
  }

  // (4) the append-only message log: survives config damage, but see the warning below
  const messagesDir = join(root, "agent-room", "messages");
  for (const name of await listFiles(messagesDir, (n) => n.endsWith(".jsonl"))) {
    const file = join(messagesDir, name);
    const info = await stat(file).catch(() => null);
    if (!info || info.size === 0) continue;
    if (info.size > 32 * 1024 * 1024) notes.push(`${file}: skipped (${info.size} bytes, above the 32 MiB scan bound)`);
    if (info.size > 32 * 1024 * 1024) continue;
    const text = stripBom(await readFile(file, "utf8"));
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row?.from) addCandidate(candidates, row.from, row.fromNickname, "messages", `messages/${name} seq=${row.seq ?? "?"}`);
    }
  }

  // (5) backup and quarantine copies
  for (const backupRoot of [resolveBackupRoot(root, undefined)]) {
    for (const name of await listFiles(backupRoot, (n) => n.startsWith("identity.json") && n.includes(".bak"))) {
      const copy = await readJsonish(join(backupRoot, name));
      if (!copy.ok) continue;
      addCandidate(candidates, copy.value?.agentId, copy.value?.nickname, "backups", `${join(backupRoot, name)}`);
    }
  }
}

/* --------------------------------- output -------------------------------- */

function buildReport(candidates, notes) {
  const list = [...candidates.values()].sort((a, b) => sum(b.nicknames) + b.labels.size - (sum(a.nicknames) + a.labels.size));
  return { candidates: list, notes };
  function sum(map) {
    let total = 0;
    for (const n of map.values()) total += n;
    return total;
  }
}

function printReport(report, home, sources) {
  console.log("=== repair-identity: NOTHING HAS BEEN WRITTEN YET ===");
  console.log(`  DSH home      : ${home}`);
  console.log(`  scanned roots : ${sources.join(", ")}`);
  console.log("");
  if (report.candidates.length === 0) {
    console.log("  no candidate agentId found in any record; do NOT invent one.");
    console.log("  add another machine's directory with --extra-root <dir> and re-run.");
  } else {
    console.log(`  ${report.candidates.length} candidate agentId(s), strongest first:`);
    for (const entry of report.candidates) {
      const names = [...entry.nicknames.entries()].map(([n, c]) => `${n} x${c}`).join(", ");
      console.log("");
      console.log(`  ${entry.agentId}`);
      console.log(`    nickname(s) : ${names}`);
      console.log(`    found in    : ${[...entry.labels].join(", ")}`);
      for (const e of entry.evidence.slice(0, 6)) console.log(`      - [${e.label}] ${e.detail}`);
      if (entry.evidence.length > 6) console.log(`      ... ${entry.evidence.length - 6} more`);
    }
  }
  if (report.notes.length > 0) {
    console.log("");
    console.log("  notes:");
    for (const note of report.notes) console.log(`    - ${note}`);
  }
  console.log("");
  console.log("  to apply one of them (nothing is guessed for you):");
  console.log("    node tools/repair-identity.mjs --home <home> --apply --agent-id <uuid> [--from rooms]");
}

/* --------------------------------- apply --------------------------------- */

async function backupCurrent(file, backupRoot, tag) {
  if (!existsSync(file)) return null;
  const source = await readFile(file);
  await mkdir(backupRoot, { recursive: true });
  const dest = join(backupRoot, `${basename(file)}.${stamp()}.${tag}.bak`);
  await copyFile(file, dest);
  const copied = await readFile(dest);
  if (copied.length !== source.length || !copied.equals(source)) {
    throw new Error(`backup verification failed: ${dest} differs from ${file}`);
  }
  return dest;
}

async function applyIdentity(args, report, home) {
  const backupRoot = resolveBackupRoot(home, args.backupDir);
  const identityFile = join(home, "agent-room", "identity.json");
  const candidate = report.candidates.find((c) => c.agentId === args.agentId);

  if (!candidate && !args.flags.has("allow-unknown-id")) {
    throw new Error(
      `refusing to write agentId ${args.agentId}: it did not appear in the report. ` +
        `Re-run and copy an id from the list, or pass --allow-unknown-id if you have an independent source.`,
    );
  }
  if (candidate && args.from) {
    if (!SOURCE_LABELS.includes(args.from)) throw new Error(`--from must be one of: ${SOURCE_LABELS.join(", ")}`);
    if (!candidate.labels.has(args.from)) {
      throw new Error(`refusing to write: ${args.agentId} was not found in the "${args.from}" record class (found in: ${[...candidate.labels].join(", ")})`);
    }
  }

  const current = await readJsonish(identityFile);
  if (current.ok && current.value?.agentId === args.agentId) {
    console.log("");
    console.log(`[repair] identity.json already carries agentId ${args.agentId}; nothing to do.`);
    return 0;
  }

  console.log("");
  console.log("=== apply ===");
  console.log(`  current file  : ${identityFile}`);
  console.log(`  current state : ${current.bytes === null ? "missing" : current.ok ? `agentId=${current.value?.agentId ?? "(none)"}` : `NOT PARSEABLE (${current.error})`}`);

  // Evidence first: the damaged bytes are preserved exactly, before the write.
  const backup = await backupCurrent(identityFile, backupRoot, current.ok ? "pre-repair" : "corrupt");
  if (backup) {
    const kind = current.ok ? "backup" : "QUARANTINE";
    console.log(`  ${kind}${" ".repeat(Math.max(0, 10 - kind.length))}: ${backup} (byte-identical copy kept)`);
  }
  const before = current.ok ? current.value : null;

  const next = {
    agentId: args.agentId,
    nickname: args.nickname ?? before?.nickname ?? candidate?.nicknames.keys().next().value ?? "agent",
    capabilities: Array.isArray(before?.capabilities) ? before.capabilities : [],
    createdAt: before?.createdAt ?? nowIso(),
  };
  if (before?.bio !== undefined) next.bio = before.bio;
  await mkdir(join(home, "agent-room"), { recursive: true });
  await writeFile(identityFile, JSON.stringify(next, null, 2), "utf8");

  console.log(`  agentId before: ${before?.agentId ?? "(none)"}`);
  console.log(`  agentId after : ${next.agentId}`);
  console.log(`  nickname      : ${next.nickname}`);
  console.log("");
  console.log("  next steps for THIS machine:");
  console.log("    1. remove the stop marker so the watchdog may start it again:");
  console.log(`       del "${join(home, "agent-room", "REFUSED-TO-START")}"`);
  console.log("    2. restart the host (its watchdog will do it), then check the id with");
  console.log("       the drift detector: powershell -File ...\\detect-identity-drift.ps1");
  return 0;
}

async function applyReseed(args, home) {
  const orgFile = join(home, "agent-org", "org-state.json");
  const backupRoot = resolveBackupRoot(home, args.backupDir);
  if (!UUID_SHAPED.test(args.companyLeader ?? "")) throw new Error("--reseed-org needs --company-leader <uuid>");

  const current = await readJsonish(orgFile);
  if (current.ok && Array.isArray(current.value?.nodes)) {
    const hasCompany = current.value.nodes.some((n) => n?.kind === "company");
    if (hasCompany && !args.flags.has("force")) {
      throw new Error(`refusing --reseed-org: ${orgFile} already has a company node (${current.value.nodes.length} nodes). Use --force only if it is known-wrong.`);
    }
  }

  console.log("");
  console.log("=== reseed org tree ===");
  console.log(`  WARNING: an org snapshot is replaced WHOLESALE by the receiver`);
  console.log(`           (dsh-agent-org sync.js shouldApply): if this machine is NOT the`);
  console.log(`           org owner, the owner's next snapshot overwrites this file. Seed on`);
  console.log(`           the owner machine, or keep the owner stopped until members have the tree.`);
  const backup = await backupCurrent(orgFile, backupRoot, current.ok ? "pre-reseed" : "corrupt");
  if (backup) console.log(`  ${current.ok ? "backup" : "QUARANTINE"}: ${backup}`);

  const now = nowIso();
  const nodes = [
    { id: randomUUID(), kind: "company", name: args.companyName ?? "My Company", parentId: null, leaderAgentId: args.companyLeader, createdAt: now, updatedAt: now },
  ];
  if (args.memberAgentId) {
    if (!UUID_SHAPED.test(args.memberAgentId)) throw new Error("--member-agent-id must be a uuid");
    nodes.push({
      id: randomUUID(),
      kind: "member",
      name: args.memberName ?? args.memberAgentId,
      parentId: nodes[0].id,
      agentId: args.memberAgentId,
      createdAt: now,
      updatedAt: now,
    });
  }
  await mkdir(join(home, "agent-org"), { recursive: true });
  const state = { version: 1, nodes, updatedAt: now };
  await writeFile(orgFile, JSON.stringify(state, null, 2), "utf8");
  console.log(`  wrote ${nodes.length} node(s) to ${orgFile}`);
  console.log(`  members must be added with the normal org tools afterwards (this tool seeds a skeleton, not a roster)`);
  return 0;
}

/* --------------------------- damaged display names ------------------------ */

/**
 * The plugin's OWN G1 name gate, loaded from the built module (0.1.40).
 *
 * Loaded lazily and never re-implemented: a repair tool that decides "damaged"
 * with a second, drifting copy of the rule would happily write names the plugin
 * refuses, which is exactly how a placeholder got written to two machines in the
 * first place. Built output only — the tarball ships lib/, and a checkout has to
 * run `node build.mjs` first, which the error below says.
 */
let nameGate;
async function loadNameGate() {
  if (!nameGate) {
    const url = new URL("../lib/host/safety.js", import.meta.url);
    try {
      const mod = await import(url.href);
      nameGate = { nicknameProblem: mod.nicknameProblem, assertValidNickname: mod.assertValidNickname };
    } catch (error) {
      throw new Error(
        `cannot load the plugin's name gate at ${fileURLToPath(url)} (${error?.code ?? error?.message ?? error}); ` +
          `run "node build.mjs" in the plugin directory first so the repair uses the SAME rule the plugin enforces`,
      );
    }
  }
  return nameGate;
}

/**
 * Every place a display name is stored on this machine.
 *
 *   A  <home>/agent-room/identity.json   nickname   (this node's self-declared name)
 *   C  <home>/agent-org/org-state.json   nodes[].name, per agentId
 *
 * B (a room owner's `members[].nickname`) is deliberately NOT repaired here: it is
 * owned by the member machine and re-pushed by that machine's profile frame, so a
 * local edit would be overwritten by the next push. See docs/RELEASE-0.1.40.md.
 */
async function scanNames(home) {
  const gate = await loadNameGate();
  const entries = [];
  const notes = [];

  const identityFile = join(home, "agent-room", "identity.json");
  const identity = await readJsonish(identityFile);
  if (identity.bytes === null) {
    notes.push(`${identityFile}: not present`);
  } else if (!identity.ok) {
    notes.push(`${identityFile}: PRESENT BUT NOT PARSEABLE (${identity.error}) - run the plain report above first`);
  } else {
    const nickname = identity.value?.nickname;
    entries.push({
      store: "identity",
      file: identityFile,
      agentId: identity.value?.agentId ?? "",
      nodeId: null,
      name: nickname,
      problem: gate.nicknameProblem(nickname),
    });
  }

  const orgFile = join(home, "agent-org", "org-state.json");
  const org = await readJsonish(orgFile);
  if (org.bytes !== null && !org.ok) {
    notes.push(`${orgFile}: PRESENT BUT NOT PARSEABLE (${org.error}) - run the plain report above first`);
  } else {
    for (const node of org.value?.nodes ?? []) {
      if (!node || typeof node !== "object") continue;
      if (node.kind !== "member" && typeof node.name !== "string") continue;
      entries.push({
        store: "org",
        file: orgFile,
        agentId: node.kind === "member" ? (node.agentId ?? "") : "",
        nodeId: node.id ?? null,
        kind: node.kind,
        name: node.name,
        problem: gate.nicknameProblem(node.name),
      });
    }
  }

  return { entries, notes };
}

function printNameReport(report, home) {
  const bad = report.entries.filter((e) => e.problem);
  console.log("=== repair-names: NOTHING HAS BEEN WRITTEN YET ===");
  console.log(`  DSH home : ${home}`);
  console.log("  stores   : identity.json nickname (A), org-state.json node names (C)");
  console.log("");
  if (report.entries.length === 0) {
    console.log("  no display name was found to check.");
  }
  for (const entry of report.entries) {
    const where = entry.store === "identity" ? "identity.json nickname" : `org node ${entry.kind ?? "?"} ${entry.nodeId ?? "?"}`;
    console.log(
      `  ${entry.problem ? "BAD " : "ok  "} ${where.padEnd(34)} ${JSON.stringify(entry.name)}` +
        `  agentId=${entry.agentId || "(none)"}${entry.problem ? `  <- ${entry.problem}` : ""}`,
    );
  }
  console.log("");
  if (bad.length === 0) {
    console.log("  every display name on this machine passes the plugin's own gate.");
  } else {
    console.log(`  ${bad.length} damaged name(s). Fix them EXPLICITLY, one agentId at a time:`);
    for (const entry of bad) {
      const target = entry.agentId || entry.nodeId || "<agentId>";
      console.log("");
      console.log(`    ${entry.file}`);
      console.log(`      agentId : ${target}`);
      console.log(`      current : ${JSON.stringify(entry.name)}  (${entry.problem})`);
      console.log(`      fix     : node tools/repair-identity.mjs --home <home> --repair-names --apply --set-name ${target}=<THE NAME YOU WANT>`);
    }
    console.log("");
    console.log("  The tool will NOT invent a name. If another machine's or another record's");
    console.log("  name for the same agentId is trustworthy, copy it from the report above");
    console.log("  (see the plain --home report) and pass it to --set-name yourself.");
  }
  if (report.notes.length > 0) {
    console.log("");
    console.log("  notes:");
    for (const note of report.notes) console.log(`    - ${note}`);
  }
}

/** `--set-name <agentId>=<name>` -> `{agentId, name, problem}`. Never guesses. */
async function parseSetNames(setNames) {
  const gate = await loadNameGate();
  if (setNames.length === 0) {
    throw new Error("--repair-names --apply needs at least one --set-name <agentId>=<name>; nothing was written");
  }
  const parsed = [];
  for (const raw of setNames) {
    const eq = raw.indexOf("=");
    if (eq <= 0) throw new Error(`--set-name must be <agentId>=<name>, got ${JSON.stringify(raw)}`);
    const agentId = raw.slice(0, eq).trim();
    const name = raw.slice(eq + 1).trim();
    if (!UUID_SHAPED.test(agentId)) throw new Error(`--set-name target is not an agentId: ${JSON.stringify(agentId)}`);
    const problem = gate.nicknameProblem(name);
    if (problem) throw new Error(`refusing the name for ${agentId}: ${problem}`);
    parsed.push({ agentId, name, problem: null });
  }
  return parsed;
}

/**
 * Apply explicit name repairs.
 *
 * Two phases ON PURPOSE: the whole plan is resolved and printed first, and only
 * then is anything backed up and written. A partially applied roster repair is
 * worse than none — the operator cannot tell which half moved.
 */
async function applyNames(args, report, home) {
  const requested = await parseSetNames(args.setNames);
  const known = new Set(report.entries.map((e) => e.agentId).filter(Boolean));
  const orgFile = join(home, "agent-org", "org-state.json");
  const identityFile = join(home, "agent-room", "identity.json");
  const backupRoot = resolveBackupRoot(home, args.backupDir);

  const plan = [];
  for (const want of requested) {
    if (!known.has(want.agentId) && !args.flags.has("allow-unknown-id")) {
      throw new Error(
        `refusing to write a name for ${want.agentId}: it does not appear in the name report above. ` +
          `Re-run --repair-names and copy an agentId from it, or pass --allow-unknown-id if you have an independent source.`,
      );
    }
    const targets = report.entries.filter((e) => e.agentId === want.agentId);
    if (targets.length === 0) {
      throw new Error(`refusing to write: no identity nickname or org node on this machine carries agentId ${want.agentId}`);
    }
    for (const target of targets) {
      if (target.name === want.name) {
        plan.push({ ...target, next: want.name, skip: true });
        continue;
      }
      plan.push({ ...target, next: want.name, skip: false });
    }
  }

  console.log("");
  console.log("=== repair-names: plan (nothing written yet) ===");
  for (const item of plan) {
    console.log(
      `  ${item.skip ? "SKIP (already correct)" : "WRITE"} ${item.file}` +
        `${item.nodeId ? ` node ${item.nodeId}` : ""} agentId=${item.agentId}`,
    );
    if (!item.skip) console.log(`        ${JSON.stringify(item.name)} -> ${JSON.stringify(item.next)}`);
  }
  console.log("");
  console.log("  WARNING: if the plugin is RUNNING, a disk edit is INVISIBLE to it (the");
  console.log("           identity is cached at boot) and the next save reverts this file.");
  console.log("           Use the supported entry point instead while the node is up:");
  console.log("             POST /agent-room-api/profile {\"nickname\":\"...\"}   (or the agent_rename_self tool)");
  console.log("           Only an org snapshot from the org OWNER survives on other machines");
  console.log("           (dsh-agent-org sync.js shouldApply).");

  let written = 0;
  for (const item of plan) {
    if (item.skip) continue;
    const backup = await backupCurrent(item.file, backupRoot, "pre-name-repair");
    if (backup) console.log(`  ${item.store === "identity" ? "backup" : "backup"}: ${backup} (byte-identical copy kept)`);
    const raw = await readJsonish(item.file);
    if (!raw.ok) throw new Error(`refusing to write ${item.file}: it is not parseable (${raw.error})`);
    if (item.store === "identity") {
      if (!Object.hasOwn(raw.value ?? {}, "nickname")) throw new Error(`refusing: ${item.file} has no nickname field`);
      raw.value.nickname = item.next;
    } else {
      const node = (raw.value?.nodes ?? []).find((n) => n && n.id === item.nodeId);
      if (!node) throw new Error(`refusing: node ${item.nodeId} vanished from ${item.file}`);
      node.name = item.next;
      node.updatedAt = nowIso();
    }
    // Same encoding rule as the plugin: JSON.stringify(..., 2), UTF-8, no BOM.
    // The damage this repairs was written by a script that used JSON.stringify
    // with no indentation and an unexpanded placeholder; the padding is not
    // cosmetic, it is what keeps the file reviewable by a human.
    await writeFile(item.file, JSON.stringify(raw.value, null, 2), "utf8");
    const check = await readJsonish(item.file);
    const wrote = item.store === "identity"
      ? check.value?.nickname
      : (check.value?.nodes ?? []).find((n) => n && n.id === item.nodeId)?.name;
    if (wrote !== item.next) throw new Error(`verification failed: ${item.file} reads ${JSON.stringify(wrote)} after the write`);
    console.log(`  wrote ${item.file}${item.nodeId ? ` node ${item.nodeId}` : ""}: ${JSON.stringify(wrote)} (verified by re-reading)`);
    written += 1;
  }
  console.log("");
  console.log(`[repair] ${written} file(s) written. Nothing else was touched.`);
  return 0;
}

/* ---------------------------------- main --------------------------------- */

async function main() {
  const argv = process.argv.slice(2);  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`repair-identity: ${String(error?.message ?? error)}`);
    console.error(usage());
    return 1;
  }
  const home = resolve(args.home ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh"));
  const roots = [home, ...args.extraRoots.map((r) => resolve(r))];

  const candidates = new Map();
  const notes = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      notes.push(`${root}: does not exist`);
      continue;
    }
    await scanRoot(root, candidates, notes);
  }
  const report = buildReport(candidates, notes);
  const repairNames = args.flags.has("repair-names");
  // The name report is a separate surface on purpose: the agentId report above
  // answers "which id did this machine have", this one answers "which DISPLAY
  // NAME is damaged where". Both are report-only until --apply.
  const nameReport = repairNames ? await scanNames(home) : null;

  const apply = args.flags.has("apply");
  if (args.flags.has("json")) {
    const json = {
      home,
      roots,
      apply,
      candidates: report.candidates.map((c) => ({
        agentId: c.agentId,
        nicknames: Object.fromEntries(c.nicknames),
        labels: [...c.labels],
        evidence: c.evidence,
      })),
      notes,
    };
    if (nameReport) json.names = nameReport;
    console.log(JSON.stringify(json, null, 2));
  } else {
    printReport(report, home, roots);
    if (nameReport) printNameReport(nameReport, home);
  }

  if (!apply) {
    if (args.flags.has("reseed-org")) {
      console.log("");
      console.log("[repair] --reseed-org requires --apply as well; nothing was written.");
    }
    if (repairNames && args.setNames.length > 0) {
      console.log("");
      console.log("[repair] --set-name requires --apply as well; nothing was written.");
    }
    return 0;
  }

  if (repairNames) return await applyNames(args, nameReport, home);
  if (args.flags.has("reseed-org")) return await applyReseed(args, home);
  if (!args.agentId) {
    console.error("[repair] --apply requires --agent-id <uuid> taken from the report above. Nothing was written.");
    return 1;
  }
  return await applyIdentity(args, report, home);
}

/**
 * Exported so the repo's test suite can exercise the scan and apply logic
 * directly. `main()` only runs when this file IS the entry module, so importing it
 * from a test never parses the test runner's argv or calls process.exit.
 */
export { main, parseArgs, scanRoot, buildReport, applyIdentity, applyReseed, readJsonish };
export { scanNames, printNameReport, parseSetNames, applyNames };

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((error) => {
      console.error(`repair-identity: ${String(error?.message ?? error)}`);
      process.exit(1);
    });
}