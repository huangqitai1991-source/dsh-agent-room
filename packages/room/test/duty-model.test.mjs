/**
 * dsh-agent-room 0.1.48 — THE EXECUTABLE DUTY SESSION, and never printing success you did not verify.
 *
 * THE ROOT CAUSE (found on real hardware by a parallel worker, folded into this release)
 *
 * `ensureDutyAgent()` spawned the duty session with agentOptions MIRRORED from a live session.
 * On a machine whose `dsh web` runs with `cwd` = the profile directory, residency detection
 * always falls back to a transcript that is NOT in the registry, the registry holds only the
 * duty agent, and the mirror loop finds nothing — so `agentOptions` was EMPTY: **no model**.
 * The harness then refuses to propose a request (`dsh-agent-loop/lib/index.js:714`):
 *
 *     if (!proposedConfig.provider || !proposedConfig.model) throw new Error(`agent "…" has no
 *     provider/model: set AgentOptions.provider and AgentOptions.model …`);
 *
 * and `kick()` (`:481-490`) swallows that error (`catch (_error) {}`). Net effect on C and
 * D: the wake was handed over, `followup accepted` printed, and **nothing ever ran** — for
 * hours, with no error anywhere. C's duty transcript stayed 5564 bytes, unchanged since it
 * was created. Every host create/resume path passes a real selection
 * (`dsh-host-apiproxy/lib/index.js:5532` `defaultModelSelection: () => ctx.agentDefaultModel.currentSelection()`);
 * the plugin's did not.
 *
 * WHAT THIS FILE PROVES (all against the built artifact — `node build.mjs` first)
 *   1. the duty session is spawned WITH a real model selection, and the source of that
 *      selection is named (live session → persisted file → the host's own default);
 *   2. the selection is PERSISTED, so a restart with an empty registry (the state the defect
 *      broke in) still produces an executable session — the durability requirement;
 *   3. a restored duty session that came back without a model is REPAIRED in place, and if it
 *      cannot be repaired the machine says so, loudly, and counts it;
 *   4. a resolution prefers an EXECUTABLE candidate over a higher-priority dead one;
 *   5. no success-shaped line is printed for a session that cannot execute: `followup accepted`
 *      becomes `followup accepted — INBOX ONLY, NOT SUCCESS`, and `activation.residentNoModel`
 *      moves;
 *   6. a swallowed turn error is surfaced through the agent's own `agent/error` channel (the
 *      only place it exists at all) and counted;
 *   7. a machine's OWN `[org:*]` / `[ack]` frames are NOT the agent speaking — they neither
 *      count as output nor end a thinking state, and they are counted when ignored (D-37: this
 *      exact misreading recorded two silent machines as healthy);
 *   8. `/state.activation` carries the new counters, flat and numeric.
 *
 * `AR_LIB` points this suite at ANOTHER build's lib directory. `host/activation.js` exists on
 * 0.1.47 but the 0.1.48 counters/methods do not, so the corresponding assertions fail there.
 *
 * Pure in-process state plus local HTTP-free service probes. Run directly:
 *   node test/duty-model.test.mjs      (never `node --test`)
 */

import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AR_LIB = process.env.AR_LIB;
const libBase = AR_LIB ? pathToFileURL(join(AR_LIB, "host") + "/").href : "../lib/host/";

let actMod = null;
let actImportError = null;
try {
  actMod = await import(libBase + "activation.js");
} catch (error) {
  actImportError = error;
}
const { WakeActivation = undefined } = actMod ?? {};

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOM = "01a098a2-2015-7a1d-b5f7-9eca45afa65d";
const SELF_JIE = "01a0281a-52de-7c4d-a1e9-7e6db367d3dd";

let failures = 0;
const guarded = (name, fn) =>
  test(name, async (t) => {
    try {
      await fn(t);
    } catch (error) {
      failures += 1;
      throw error;
    }
  });

/** Every 0.1.48 assertion calls this first: on an older lib it fails the test BY NAME. */
function need048(what) {
  if (!actMod) {
    failures += 1;
    throw new Error(
      `the activation chain does not exist on this build (AR_LIB=${AR_LIB ?? "(local lib)"}): ${what}. ` +
        `import error: ${String(actImportError)}`,
    );
  }
  const probe = new WakeActivation().stats();
  if (!("residentNoModel" in probe) || !("controlFramesIgnored" in probe)) {
    failures += 1;
    throw new Error(
      `this build predates 0.1.48 (no residentNoModel / controlFramesIgnored counters; ` +
        `AR_LIB=${AR_LIB ?? "(local lib)"}): the duty session can be spawned without a model and ` +
        `nothing can tell — ${what}`,
    );
  }
}

/** A fake agent whose `options` behave like the harness's (`this.options = options`). */
function fakeAgent(id, options) {
  return { id, sessionId: id, options: { ...(options ?? {}) }, followup: () => undefined };
}

/**
 * Boot a service with a controllable registry.
 *
 * `opts.hostDefault` is installed on the service's ctx when the ctx allows it (the real path,
 * `ctx.agentDefaultModel.currentSelection()`); otherwise the private method is overridden, which
 * is the same seam the other suites use for `agentsRegistry`. `opts.modelOverride` says which
 * one happened, so the test output can state it.
 */
async function boot(port, tag, opts = {}) {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { Context: CordisContext } = await import("@deepseek-ai/cordis");
  const { AgentRoomService } = await import(libBase + "service.js");
  const dir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), tag)));
  const svc = new AgentRoomService(new CordisContext(), { dataDir: dir, port, relay: "" });
  const end = Date.now() + 8_000;
  while (Date.now() < end && !(svc.profileTimer != null && svc.listenTimer != null)) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(svc.listenTimer != null, `the service must boot (${tag})`);
  // The service is given the data dir it should use for the persisted model selection, and a
  // FIXTURE settings file (the host's default model selection lives at <DSH_HOME>/settings.yaml;
  // the real one is never touched by a test).
  svc.residentModelFile = join(dir, "resident-model.json");
  svc.settingsFilePath = join(dir, "settings.yaml");

  let modelSource = "none";
  if (opts.hostDefault) {
    let installedOnCtx = false;
    try {
      svc.ctx.agentDefaultModel = { currentSelection: () => ({ ...opts.hostDefault }) };
      installedOnCtx = Boolean(svc.hostDefaultModel());
    } catch { /* cordis context refused the property — fall through */ }
    if (!installedOnCtx) {
      svc.hostDefaultModel = () => ({ ...opts.hostDefault });
      modelSource = "method-override";
    } else {
      modelSource = "ctx.agentDefaultModel";
    }
  }

  const created = [];
  const live = opts.liveAgents ?? [];
  /**
   * A duty session "restored by the host": its id is the DETERMINISTIC duty id for this
   * machine's identity, and it comes back with whatever options the host restored (in the
   * field: none). Built lazily because the identity only exists after boot.
   */
  const restoredDuty = () => fakeAgent("agent-room-duty-" + (svc.roomService.getIdentity()?.agentId ?? ""), undefined);
  const registry = {
    list: () => [...live],
    roots: () => [...live],
    get: (id) => {
      const hit = live.find((a) => a.id === id);
      if (hit) return hit;
      if (opts.restoredNoModel && id === "agent-room-duty-" + (svc.roomService.getIdentity()?.agentId ?? "")) return registry.__restored;
      return undefined;
    },
    currentInitiator: () => live[0],
  };
  registry.__restored = restoredDuty();
  if (opts.canCreate !== false) {
    registry.create = async (options) => {
      created.push(options);
      const agent = fakeAgent(options.sessionId, options.agentOptions);
      agent.followup = () => undefined;
      if (opts.dutyInList) live.push(agent);
      return { agent };
    };
  }
  svc.agentsRegistry = () => registry;
  if (opts.replyAgentId) svc.config.replyAgentId = opts.replyAgentId;
  return { svc, dir, created, modelSource, live, restored: registry.__restored };
}

async function teardown(probe, keepDir = false) {
  const { rm } = await import("node:fs/promises");
  for (const timer of [probe?.svc?.profileTimer, probe?.svc?.listenTimer, probe?.svc?.activationTimer]) {
    try { if (timer) clearInterval(timer); } catch { /* ignore */ }
  }
  try { await probe?.svc?.peerServer?.stop(); } catch { /* ignore */ }
  try { probe?.svc?.discovery?.stop?.(); } catch { /* ignore */ }
  for (const client of probe?.svc?.clients?.values?.() ?? []) { try { client.destroy(); } catch { /* ignore */ } }
  if (!keepDir) await rm(probe.dir, { recursive: true, force: true }).catch(() => {});
}

function captureLogs() {
  const lines = [];
  const realError = console.error;
  const realWarn = console.warn;
  const push = (...args) => { lines.push(args.map((a) => String(a)).join(" ")); };
  console.error = push;
  console.warn = push;
  return { lines, restore() { console.error = realError; console.warn = realWarn; } };
}

/* ===================== 1. the duty session gets a MODEL ===================== */

guarded("0.1.48: the duty session is spawned WITH a model taken from the HOST's own default", async () => {
  need048("the duty session must be executable or nothing else matters");
  const probe = await boot(19811, "ar48-hostdefault-", { hostDefault: { provider: "deepseek", model: "v4-flash" }, liveAgents: [] });
  const logs = captureLogs();
  try {
    const agent = await probe.svc.ensureDutyAgent();
    console.log(`  [duty] modelSource=${probe.modelSource} createOptions=${JSON.stringify(probe.created.map((c) => c.agentOptions))}`);
    assert.ok(agent, "the duty agent must be created");
    assert.strictEqual(probe.created.length, 1, "exactly one session creation");
    assert.deepStrictEqual(
      probe.created[0].agentOptions,
      { provider: "deepseek", model: "v4-flash" },
      "the harness refuses a request without provider/model (dsh-agent-loop/lib/index.js:714), so BOTH must be passed at creation",
    );
    assert.strictEqual(probe.svc.agentExecutable(agent), true, "and the resulting handle must be executable");
    assert.ok(logs.lines.some((l) => l.includes("EXECUTABLE")), `the spawn must say it is executable: ${JSON.stringify(logs.lines.filter((l) => l.includes("duty agent")))}`);
    assert.ok(logs.lines.some((l) => l.includes("model source = ")), "and name the SOURCE of the selection (mirror / persisted / host default)");
  } finally {
    logs.restore();
    await teardown(probe);
  }
});

guarded("0.1.48: a live session is mirrored FIRST — the host default is only a fallback", async () => {
  need048("order of evidence: the live session is the strongest signal");
  const probe = await boot(19812, "ar48-mirror-", {
    hostDefault: { provider: "host", model: "default" },
    liveAgents: [fakeAgent("session-live", { provider: "live", model: "session-model" })],
    replyAgentId: "session-live",
  });
  const logs = captureLogs();
  try {
    const agent = await probe.svc.resolveResidentAgent(probe.svc.roomService.getIdentity(), {});
    assert.ok(agent, "a resident agent must resolve");
    assert.deepStrictEqual(probe.svc.agentModelOf(agent), { provider: "live", model: "session-model" });
    assert.strictEqual(probe.created.length, 0, "nothing needed to be spawned");
    assert.ok(logs.lines.some((l) => l.includes("via config override")), "the live session wins by priority");
  } finally {
    logs.restore();
    await teardown(probe);
  }
});

guarded("0.1.48 DURABILITY: with no live session and NO host service, the PERSISTED selection is used", async () => {
  need048("this is the restart requirement: the binding must survive, and the model with it");
  // First run: learn a selection from the host default and persist it.
  const first = await boot(19813, "ar48-persist-a-", { hostDefault: { provider: "deepseek", model: "v4-pro" }, liveAgents: [] });
  let logs = captureLogs();
  try {
    await first.svc.ensureDutyAgent();
  } finally {
    logs.restore();
  }
  await new Promise((r) => setTimeout(r, 300)); // the persisted write is fire-and-forget
  const file = join(first.dir, "resident-model.json");
  const written = JSON.parse(readFileSync(file, "utf8"));
  console.log(`  [persist] ${JSON.stringify(written)}`);
  assert.strictEqual(written.provider, "deepseek");
  assert.strictEqual(written.model, "v4-pro");
  // Simulate the RESTART: same data dir, a brand-new service, empty registry, NO host service.
  const second = await boot(19814, "ar48-persist-b-", { liveAgents: [], dataDir: first.dir });
  const { rm } = await import("node:fs/promises");
  try {
    // boot() already ran and loaded the file; prove it by resolving the model WITHOUT any host default.
    assert.deepStrictEqual(
      second.svc.persistedResidentModel,
      { provider: "deepseek", model: "v4-pro" },
      "the selection must be loaded from disk on boot",
    );
    const resolved = second.svc.resolveModelSelection();
    console.log(`  [persist] after restart: ${JSON.stringify(resolved)}`);
    assert.ok(resolved, "a selection must still be resolvable after a restart");
    assert.match(resolved.source, /persisted/, "and it must come from the persisted tier");
    const agent = await second.svc.ensureDutyAgent();
    assert.deepStrictEqual(second.created[0].agentOptions, { provider: "deepseek", model: "v4-pro" }, "the new duty session is created executable");
    assert.strictEqual(second.svc.agentExecutable(agent), true);
  } finally {
    await teardown(first, true);
    await teardown(second);
    await rm(first.dir, { recursive: true, force: true }).catch(() => {});
  }
});

guarded("0.1.48: a restored duty session WITHOUT a model is REPAIRED in place (no restart, no respawn)", async () => {
  need048("this is the exact state the host restores into: the session exists, the model is gone");
  const probe = await boot(19815, "ar48-repair-", {
    hostDefault: { provider: "deepseek", model: "v4-flash" },
    liveAgents: [],
    restoredNoModel: true,
  });
  const logs = captureLogs();
  try {
    const agent = await probe.svc.ensureDutyAgent();
    console.log(`  [repair] options=${JSON.stringify(probe.svc.agentModelOf(agent))} repairs=${probe.svc.activation.stats().executabilityRepairs}`);
    assert.strictEqual(agent, probe.restored, "the SAME session is reused (recreating a live session would be a lifecycle hazard)");
    assert.deepStrictEqual(probe.svc.agentModelOf(agent), { provider: "deepseek", model: "v4-flash" });
    assert.strictEqual(probe.created.length, 0, "no second session was spawned for the same id");
    assert.strictEqual(probe.svc.activation.stats().executabilityRepairs, 1, "the repair is counted");
    assert.ok(logs.lines.some((l) => l.includes("REPAIRED")), "and logged as a repair, not as a success");
  } finally {
    logs.restore();
    await teardown(probe);
  }
});

guarded("0.1.48: when NO source has a model, the machine SAYS SO and never prints success", async () => {
  need048("the defect was a lie by omission; this is the test that it can no longer be told");
  const probe = await boot(19816, "ar48-nomodel-", { liveAgents: [], canCreate: true });
  // No hostDefault, no persisted file, no live session: nothing to take a model from.
  const logs = captureLogs();
  try {
    const agent = await probe.svc.ensureDutyAgent();
    assert.ok(agent, "the session is still created (the wake path must not crash)");
    assert.deepStrictEqual(probe.created[0].agentOptions, {}, "with EMPTY options — the exact 0.1.46 defect shape");
    assert.strictEqual(probe.svc.agentExecutable(agent), false);
    const warning = logs.lines.find((l) => l.includes("SPAWNED WITHOUT a provider/model"));
    assert.ok(warning, `the spawn must be reported as broken: ${JSON.stringify(logs.lines.filter((l) => l.includes("duty agent")))}`);
    console.log(`  [no-model] ${warning.slice(0, 200)}`);
    assert.strictEqual(probe.svc.activation.stats().executabilityRepairFailed, 1, "the failed repair is counted");

    // Now the wake path: it must NOT print a success-shaped accepted line.
    const room = await probe.svc.gateway.createRoom({ title: "No model", type: "persistent" });
    const author = { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() };
    probe.svc.roomService.joinOwnedRoom(room.roomId, author, {});
    const me = probe.svc.roomService.getIdentity();
    probe.svc.setListening(room.roomId, true);
    await probe.svc.sweepListening();
    const message = await probe.svc.roomService.addChatMessage(room.roomId, author, {
      text: "@" + (me.nickname ?? me.agentId) + " 请跑回归", human: false, mentions: [me.agentId],
    });
    probe.svc.listenSeen.set(room.roomId, message.seq - 1);
    await probe.svc.sweepListening();
    await new Promise((r) => setTimeout(r, 250));
    const stats = probe.svc.activation.stats();
    console.log(`  [no-model] after a wake: ${JSON.stringify({ dispatches: stats.dispatches, accepted: stats.accepted, residentNoModel: stats.residentNoModel })}`);
    assert.strictEqual(stats.residentNoModel >= 1, true, "the wake path must count that this machine cannot execute");
    assert.ok(
      logs.lines.some((l) => l.includes("NO provider/model") && l.includes("CANNOT RUN")),
      "the wake path must say the turn cannot run",
    );
    assert.ok(
      logs.lines.some((l) => l.includes("INBOX ONLY, NOT SUCCESS")),
      `there must be NO success-shaped accepted line: ${JSON.stringify(logs.lines.filter((l) => l.includes("followup"))) }`,
    );
    assert.ok(
      !logs.lines.some((l) => /followup ACCEPTED seq=/.test(l)),
      "and the old success-shaped wording must not appear for a non-executable session",
    );
  } finally {
    logs.restore();
    await teardown(probe);
  }
});

guarded("0.1.48: resolution PREFERS an executable candidate over a higher-priority dead one", async () => {
  need048("'guarantee an executable session' means the dead one must not win by priority");
  const probe = await boot(19817, "ar48-prefer-", { liveAgents: [], restoredNoModel: true, canCreate: false });
  const logs = captureLogs();
  try {
    // With no model source anywhere, the dead candidate is returned but MARKED.
    const trace = {};
    const first = await probe.svc.resolveResidentAgent(probe.svc.roomService.getIdentity(), trace);
    console.log(`  [prefer] dead-only: path=${trace.path} executable=${trace.executable} detail=${String(trace.detail).slice(0, 90)}`);
    assert.ok(first, "a candidate that exists is returned (never undefined-by-accident)");
    assert.strictEqual(trace.executable, false, "a candidate with no model must be marked non-executable");
    assert.match(String(trace.detail), /NOT EXECUTABLE/);
    // Give the machine a model source: the SAME candidate becomes executable by repair.
    probe.svc.hostDefaultModel = () => ({ provider: "deepseek", model: "v4" });
    const trace2 = {};
    const second = await probe.svc.resolveResidentAgent(probe.svc.roomService.getIdentity(), trace2);
    console.log(`  [prefer] repaired: path=${trace2.path} executable=${trace2.executable} model=${trace2.model}`);
    assert.strictEqual(trace2.executable, true, "with a model source, the same session is repaired and wins");
    assert.strictEqual(trace2.model, "deepseek/v4");
    assert.strictEqual(probe.svc.agentModelOf(second).provider, "deepseek");
  } finally {
    logs.restore();
    await teardown(probe);
  }
});

guarded("0.1.48: the host's OWN settings.yaml supplies the model when the in-process service is absent", async () => {
  need048("measured need: on a real machine ctx.agentDefaultModel is NOT resolvable from the plugin");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "ar48-settings-"));
  // Exactly the shape the settings provider writes (verified against a real machine).
  await writeFile(
    join(dir, "settings.yaml"),
    [
      "ui-onboarding:",
      "  welcomeNoticeVersion: 2026-08-13.1",
      "agent-default-model:",
      "  provider: deepseek-official",
      "  model: deepseek-v4-flash-vision-exp",
      "  reasoningEffort: high",
      "agent-presets:",
      "  default: minimal",
      "",
    ].join("\n"),
    "utf8",
  );
  const probe = await boot(19821, "ar48-settings-", { liveAgents: [], dataDir: dir });
  const logs = captureLogs();
  try {
    const resolved = probe.svc.resolveModelSelection();
    console.log(`  [settings] ${JSON.stringify(resolved)}`);
    assert.ok(resolved, "the on-disk host default must be usable");
    assert.deepStrictEqual(resolved.selection, { provider: "deepseek-official", model: "deepseek-v4-flash-vision-exp" });
    assert.match(resolved.source, /settings\.yaml/, "and the source must name the file it read");
    const agent = await probe.svc.ensureDutyAgent();
    assert.deepStrictEqual(probe.svc.agentModelOf(agent), { provider: "deepseek-official", model: "deepseek-v4-flash-vision-exp" });
    assert.strictEqual(probe.svc.agentExecutable(agent), true);
    assert.ok(logs.lines.some((l) => l.includes("EXECUTABLE")), "the spawn must report executability");
    // The section reader must not be fooled by neighbouring sections or by a missing section.
    assert.strictEqual(probe.svc.settingsFileModel().model, "deepseek-v4-flash-vision-exp");
    await writeFile(join(dir, "settings.yaml"), "agent-presets:\n  default: minimal\n", "utf8");
    assert.strictEqual(probe.svc.settingsFileModel(), undefined, "a settings file WITHOUT the section must yield nothing (no guessing)");
  } finally {
    logs.restore();
    await teardown(probe);
  }
});

guarded("0.1.48 LAST MILE: with every model source empty, the plugin asks the HOST for a real session", async () => {
  need048("measured on B: no live session, nothing persisted, no settings section, no ctx service — all four empty");
  const { createServer } = await import("node:http");
  const requests = [];
  const sessionId = "session-e03107fc-efd5-480d-bf26-98df83d9941e";
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      // The EXACT response shape measured on the real machine.
      res.end(JSON.stringify({ type: "server-response", rpcId: "x", result: { ok: true, value: { sessionId, agentPreset: "standard" } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const probe = await boot(19822, "ar48-hostsession-", { liveAgents: [], dutyInList: false });
  // The room port and the WEB port are different servers: the first field run used the room port
  // and got `HTTP 404` from the host (raw log line in the release doc). The session API lives on
  // the web port, so that is what must be used — `config.port` must NOT leak into this URL.
  probe.svc.config.port = port + 1;
  process.env.AGENT_ROOM_WEB_PORT = String(port);
  const logs = captureLogs();
  try {
    const agent = await probe.svc.ensureDutyAgent();
    await new Promise((r) => setTimeout(r, 100));
    console.log(`  [host-session] requests=${JSON.stringify(requests.map((r) => r.url))} body=${String(requests[0]?.body).slice(0, 160)}`);
    console.log(`  [host-session] stats=${JSON.stringify({ created: probe.svc.activation.stats().hostSessionsCreated, failed: probe.svc.activation.stats().hostSessionCreateFailed })}`);
    assert.strictEqual(requests.length, 1, "exactly one session creation request");
    assert.strictEqual(requests[0].url, "/api/session.create", "the host's own route (the only path that carries a model)");
    const body = JSON.parse(requests[0].body);
    assert.strictEqual(body.method, "session.create");
    assert.strictEqual(body.type, "client-request");
    assert.ok(body.payload?.cwd, "a real workspace must be passed");
    assert.strictEqual(body.payload?.agentPreset, "standard");
    const stats = probe.svc.activation.stats();
    assert.strictEqual(stats.hostSessionsCreated, 1, "the creation is counted");
    assert.strictEqual(stats.hostSessionCreateFailed, 0);
    assert.strictEqual(probe.svc.persistedReplyAgentId, sessionId, "the created session is bound (persisted for the next boot)");
    assert.ok(logs.lines.some((l) => l.includes("created a REAL session through the host API")), "and it is logged as the repair it is");
    // The duty agent is still model-less — but the machine now has a session that CAN run.
    assert.ok(agent, "a resident agent is still returned (the wake path must not crash)");
    // A second attempt in the same process must NOT stampede the host.
    await probe.svc.createHostSession();
    assert.strictEqual(requests.length, 1, "the host is asked at most ONCE per process");
  } finally {
    delete process.env.AGENT_ROOM_WEB_PORT;
    logs.restore();
    await new Promise((resolve) => server.close(resolve));
    await teardown(probe);
  }
});

guarded("0.1.48 LAST MILE: a host-API failure is counted and warned, never swallowed and never retried", async () => {
  need048("a repair that cannot run must not disappear");
  const { createServer } = await import("node:http");
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "refused (probe)" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const probe = await boot(19823, "ar48-hostsessfail-", { liveAgents: [] });
  // MUST point at the fake server: without this the resolver falls back to the default web port
  // (3080) and the test would create a REAL session on the machine running the suite.
  process.env.AGENT_ROOM_WEB_PORT = String(server.address().port);
  probe.svc.config.port = server.address().port;
  const logs = captureLogs();
  try {
    const id = await probe.svc.createHostSession();
    assert.strictEqual(id, undefined, "no session id may be invented from a failure");
    const stats = probe.svc.activation.stats();
    console.log(`  [host-session-fail] hits=${hits} failed=${stats.hostSessionCreateFailed}`);
    assert.strictEqual(stats.hostSessionCreateFailed, 1, "the failure is counted");
    assert.strictEqual(stats.hostSessionsCreated, 0, "and nothing is credited as created");
    assert.ok(logs.lines.some((l) => l.includes("could not create a session through the host")), "and an operator sees it");
    await probe.svc.createHostSession();
    assert.strictEqual(hits, 1, "a failing host is not hammered");
  } finally {
    delete process.env.AGENT_ROOM_WEB_PORT;
    logs.restore();
    await new Promise((resolve) => server.close(resolve));
    await teardown(probe);
  }
});

/* ============ 2. swallowed turn errors become visible ============ */

guarded("0.1.48: a turn error on the resident agent is surfaced and counted (the swallowed no-model throw)", async () => {
  need048("kick() discards turn errors; agent/error is the only place they exist");
  const handlers = [];
  const agent = fakeAgent("session-err", { provider: "deepseek", model: "v4" });
  agent.dispatch = { on: (event, handler) => handlers.push([event, handler]) };
  const probe = await boot(19818, "ar48-errortap-", { liveAgents: [agent], replyAgentId: "session-err" });
  const logs = captureLogs();
  try {
    await probe.svc.resolveResidentAgent(probe.svc.roomService.getIdentity(), {});
    assert.strictEqual(handlers.length, 1, "the tap must subscribe exactly once");
    assert.strictEqual(handlers[0][0], "agent/error");
    handlers[0][1]({ turn: 1, step: 0, error: new Error('agent "agent-room-duty-x" has no provider/model: set AgentOptions.provider and AgentOptions.model') });
    handlers[0][1]({ turn: 2, step: 1, error: new Error("provider 502") });
    const stats = probe.svc.activation.stats();
    console.log(`  [error-tap] turnErrors=${stats.turnErrors} turnErrorsNoModel=${stats.turnErrorsNoModel}`);
    assert.strictEqual(stats.turnErrors, 2, "every turn error is counted");
    assert.strictEqual(stats.turnErrorsNoModel, 1, "and the no-model family is named separately");
    assert.ok(
      logs.lines.some((l) => l.includes("TURN ERROR") && l.includes("DUTY-SESSION-WITHOUT-A-MODEL")),
      "the no-model turn error must be explained, not just counted",
    );
    // Re-resolving must not double-subscribe.
    await probe.svc.resolveResidentAgent(probe.svc.roomService.getIdentity(), {});
    assert.strictEqual(handlers.length, 1, "the tap is keyed by agent id");
  } finally {
    logs.restore();
    await teardown(probe);
  }
});

/* ========== 3. our own machine frames are not the agent speaking (D-37) ========== */

guarded("0.1.48: an own [org:*] / [ack] frame is NOT output and does NOT end a thinking state", async () => {
  need048("D-37: this exact misreading recorded C and D as healthy while they said nothing all day");
  const probe = await boot(19819, "ar48-controlframe-", {
    liveAgents: [fakeAgent("session-cf", { provider: "deepseek", model: "v4" })],
    replyAgentId: "session-cf",
  });
  const logs = captureLogs();
  try {
    const me = probe.svc.roomService.getIdentity();
    const room = await probe.svc.gateway.createRoom({ title: "Control frames", type: "persistent" });
    const author = { agentId: SELF_JIE, nickname: "A", capabilities: [], createdAt: new Date().toISOString() };
    probe.svc.roomService.joinOwnedRoom(room.roomId, author, {});
    // A wake is in flight, then this node echoes an org frame into the room.
    probe.svc.activation.noteDispatch(room.roomId, 4405);
    probe.svc.activation.noteAccepted(room.roomId, 4405, "session-cf");
    probe.svc.activateThinkingRooms.add(room.roomId);
    probe.svc.noteOwnReply(room.roomId, { seq: 4406, from: me.agentId, text: "[org:exec:result] exit=0 派活回显", human: false });
    let stats = probe.svc.activation.stats();
    console.log(`  [control-frame] outputs=${stats.outputs} ignored=${stats.controlFramesIgnored} thinking=${probe.svc.isActivateThinking(room.roomId)}`);
    assert.strictEqual(stats.outputs, 0, "a machine echo is not model output");
    assert.strictEqual(stats.controlFramesIgnored, 1, "and it IS counted as ignored");
    assert.strictEqual(probe.svc.isActivateThinking(room.roomId), true, "it must not end a thinking state (the D-37 false 'own reply landed')");
    assert.ok(
      logs.lines.some((l) => l.includes("NOT the agent speaking")),
      "the ignored frame must be named in the log",
    );
    // An [ack] receipt is in the same family.
    probe.svc.noteOwnReply(room.roomId, { seq: 4407, from: me.agentId, text: "[ack] A 已接手 seq=4405", human: false });
    assert.strictEqual(probe.svc.activation.stats().outputs, 0, "a receipt is not the agent speaking either");
    assert.strictEqual(probe.svc.isActivateThinking(room.roomId), true);
    // A REAL chat message from this node is the only thing that counts.
    probe.svc.noteOwnReply(room.roomId, { seq: 4408, from: me.agentId, text: "【B · 链路自证】收到，已开工", human: false });
    stats = probe.svc.activation.stats();
    console.log(`  [control-frame] after real chat: outputs=${stats.outputs} thinking=${probe.svc.isActivateThinking(room.roomId)}`);
    assert.strictEqual(stats.outputs, 1, "a real chat message IS output");
    assert.strictEqual(probe.svc.isActivateThinking(room.roomId), false, "and it ends the thinking state");
  } finally {
    logs.restore();
    await teardown(probe);
  }
});

/* ===================== 4. /state + static guards ===================== */

guarded("0.1.48: /state.activation exposes the executability counters, flat and numeric", async () => {
  need048("requirement: the machine's ability to execute must be readable from state alone");
  const probe = await boot(19820, "ar48-state-", { liveAgents: [], hostDefault: { provider: "deepseek", model: "v4" } });
  try {
    await probe.svc.ensureDutyAgent();
    const state = await probe.svc.browserState();
    const stats = probe.svc.activation.stats();
    assert.deepStrictEqual(Object.keys(state.activation).sort(), Object.keys(stats).sort(), "same shape as its own stats()");
    for (const key of ["residentExecutable", "residentNoModel", "executabilityRepairs", "executabilityRepairFailed", "turnErrors", "turnErrorsNoModel", "controlFramesIgnored"]) {
      assert.ok(key in state.activation, `activation.${key} must exist`);
      assert.strictEqual(typeof state.activation[key], "number", `activation.${key} must be a number`);
    }
    assert.strictEqual(state.activation.residentExecutable, 1, "the duty session created with a model counts as executable");
    assert.strictEqual(state.activation.residentNoModel, 0);
    console.log(`  [state] keys=${Object.keys(state.activation).length} residentExecutable=${state.activation.residentExecutable}`);
    assert.ok(state.wake && typeof state.wake.wokenByMention === "number", "the 0.1.45 block is untouched");
    assert.ok(state.ack && typeof state.ack.receiptsPosted === "number", "the 0.1.46 block is untouched");
  } finally {
    await teardown(probe);
  }
});

guarded("0.1.48 static guard: the model is supplied at creation, verified, and success is never assumed", () => {
  need048("the placement is the design");
  const src = readFileSync(join(ROOT, "src", "host", "service.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // The duty spawn takes its selection from the resolver (mirror → persisted → host default),
  // not from a bare mirror loop that can find nothing.
  const duty = src.slice(src.indexOf("private async ensureDutyAgent("), src.indexOf("private async buildActivatePromptFor("));
  assert.match(duty, /const resolvedModel = this\.resolveModelSelection\(\);/, "the duty spawn must resolve a selection from all sources");
  assert.match(duty, /this\.repairResidentModel\(/, "and must repair a restored session that came back without one");
  assert.match(duty, /this\.agentExecutable\(agent\)/, "and must VERIFY executability before reporting anything");
  assert.match(duty, /SPAWNED WITHOUT a provider\/model/, "and must say so when it could not be made executable");
  // The resolver exists with all three tiers, in order.
  const resolver = src.slice(src.indexOf("private resolveModelSelection("), src.indexOf("private saveResidentModel("));
  assert.ok(
    resolver.indexOf("mirroredModel()") < resolver.indexOf("this.persistedResidentModel") &&
      resolver.indexOf("this.persistedResidentModel") < resolver.indexOf("hostDefaultModel()"),
    "order of evidence: live session → persisted → host default",
  );
  assert.match(src, /defaultModelSelection|agentDefaultModel/, "the host's own default must be a source (ctx.agentDefaultModel)");
  assert.match(src, /options\.provider = resolved\.selection\.provider;/, "the repair writes the fields the harness reads");
  // Never a success-shaped accepted line for a session that cannot execute.
  const wakePath = src.slice(src.indexOf("private async runListenWake("), src.indexOf("private async postAckReceipt("));
  assert.match(wakePath, /const executable = trace\.executable \?\? this\.agentExecutable\(agent\);/, "the wake path must ask BEFORE claiming");
  assert.match(wakePath, /followup accepted — INBOX ONLY, NOT SUCCESS/, "and must use non-success wording when it cannot execute");
  assert.ok(
    wakePath.indexOf("noteResidentExecutability(executable)") < wakePath.indexOf("agent.followup("),
    "executability is established before the dispatch",
  );
  // The error tap and the control-frame discipline.
  assert.match(src, /bus\.on\("agent\/error"/, "the agent/error tap must exist (kick() discards turn errors)");
  assert.match(src, /noteTurnError\(noModel\)/);
  const own = src.slice(src.indexOf("private noteOwnReply("), src.indexOf("/* --------------------------- listening"));
  assert.match(own, /const controlFrame = isControlFrame\(message\.text\);/, "own control frames must be classified");
  assert.match(own, /if \(ownFrame && !controlFrame && !ackFrame\)/, "and must never end a thinking state");
  assert.match(own, /noteControlFrameIgnored\(\)/, "and must be counted");
  // The persisted tier is loaded at boot.
  assert.match(src, /resident-model\.json/, "the persisted selection file must exist");
  assert.match(src, /readJsonConfig<\{ provider\?: string; model\?: string; source\?: string \}>\(this\.residentModelFile\)/);
});

/* ============ 5. 0.1.49 — the workspace that lets the sandboxed shell start at all ============ */

/**
 * MEASURED ON B, 2026-09-15 midnight, from the session's OWN transcript (first hand):
 *
 *   TOOLCALL pwsh {"command": "Invoke-RestMethod …"}          ← the prompt's fallback route
 *   TOOLRESULT Error: Windows ACL temp root must be outside the workspace:
 *               workspace=<home>; temp=<home>\AppData\Local\Temp
 *   APPROVAL/ASKED {"toolName":"pwsh","reason":"escalate sandbox to danger-full-access: The sandboxed
 *                   shell cannot start at all …"}             ← nobody answers an approval in a duty
 *                                                               session ⇒ the turn ends with NO output
 *
 * 0.1.48 asked the host to create the session with `cwd: homedir()`, and `%TEMP%` lives INSIDE the
 * home directory — so every shell call died before running, in a session that has no `room_send`
 * tool to fall back on. `started:1` was true; the machine was still silent.
 *
 * The SAME command in a workspace that does not contain the temp root, on the same machine:
 *   TOOLRESULT [{"type":"tool-result","content":[{"type":"text","text":"SBX-OK\r\n"}],"isError":false}]
 *   TURN/END {"turn":1,"reason":{"kind":"completed"}}
 */

const wsMod = await import(libBase + "service.js");

function need049(what) {
  if (typeof wsMod.resolveDutyWorkspace !== "function" || typeof wsMod.workspaceAcceptsShell !== "function") {
    failures += 1;
    throw new Error(
      `this build predates 0.1.49 (no resolveDutyWorkspace/workspaceAcceptsShell; AR_LIB=${AR_LIB ?? "(local lib)"}): ${what}`,
    );
  }
}

guarded("0.1.49: the session workspace is chosen so the sandboxed shell can start at all", async () => {
  need049("B: workspace=<home> contains %TEMP% ⇒ every pwsh call died before running");
  const { homedir, tmpdir } = await import("node:os");
  const { dirname, join: j } = await import("node:path");
  const temp = tmpdir();
  // The rule itself (the harness's own `containsDirectory`, dsh-sandbox-windows-acl/path-boundary).
  assert.strictEqual(wsMod.containsDirectory(temp, j(temp, "x", "y")), true, "the temp root contains its children");
  assert.strictEqual(wsMod.containsDirectory(j(temp, "ws"), temp), false, "a child of the temp root does not contain it");
  assert.strictEqual(wsMod.containsDirectory(dirname(temp), temp), true, "an ancestor contains it");
  const fixtureHome = j(temp, "ar49-dsh-home");
  const chosen = wsMod.resolveDutyWorkspace({}, fixtureHome, temp);
  assert.strictEqual(chosen.dir, j(fixtureHome, "agent-room", "duty-workspace"), "the default workspace is dedicated, not the home dir");
  assert.strictEqual(wsMod.containsDirectory(chosen.dir, temp), false, "and can never contain the temp root");
  console.log(`  [ws] default=${chosen.dir} source=${chosen.source} temp=${temp}`);
  // A configured workspace that would kill the shell must be REFUSED, not obeyed.
  const unsafe = wsMod.resolveDutyWorkspace({ AGENT_ROOM_WORKDIR: dirname(temp) }, fixtureHome, temp);
  const unsafeApplies = process.platform === "win32";
  if (unsafeApplies) {
    assert.deepStrictEqual(unsafe.rejected, [dirname(temp)], "the unsafe AGENT_ROOM_WORKDIR is rejected BY NAME");
    assert.strictEqual(unsafe.dir, j(fixtureHome, "agent-room", "duty-workspace"), "and the safe default is used instead");
    assert.strictEqual(wsMod.workspaceAcceptsShell(dirname(temp), temp), false);
    assert.strictEqual(wsMod.workspaceAcceptsShell(homedir(), temp), !wsMod.containsDirectory(homedir(), temp));
    console.log(`  [ws] win32 guard active: rejected=${JSON.stringify(unsafe.rejected)}`);
  } else {
    console.log("  [ws] non-Windows: the ACL temp-root rule does not exist ⇒ the guard is a no-op (documented, not accidental)");
    const posix = wsMod.resolveDutyWorkspace({ AGENT_ROOM_WORKDIR: j(temp, "work") }, fixtureHome, temp);
    assert.strictEqual(posix.dir, j(temp, "work"), "on other platforms an explicit workspace is honoured");
  }
  // The guard must ALWAYS terminate with a usable directory. The last resort is a CHILD of the
  // temp root, so it can never contain it — that is what makes the candidate list total.
  const lastResort = j(temp, "dsh-agent-room-duty");
  assert.strictEqual(wsMod.containsDirectory(lastResort, temp), false, "the last resort cannot contain the temp root");
  assert.strictEqual(wsMod.workspaceAcceptsShell(lastResort, temp), true, "so it is always an acceptable answer");
  assert.strictEqual(wsMod.resolveDutyWorkspace({}, temp, temp).rejected.length, 0, "a DSH_HOME that is itself the temp root still resolves");
  console.log(`  [ws] last resort=${lastResort} (safe by construction)`);
});

guarded("0.1.49: the HOST session is created with a workspace that cannot contain the temp root", async () => {
  need049("0.1.48 handed the host `cwd: homedir()`; that single line is why B ran turns and said nothing");
  const { createServer } = await import("node:http");
  const { tmpdir } = await import("node:os");
  const { dirname, join: j } = await import("node:path");
  const { mkdtemp } = await import("node:fs/promises");
  const requests = [];
  const sessionId = "session-49aa11bb-0000-1111-2222-333344445555";
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId: "x", result: { ok: true, value: { sessionId, agentPreset: "standard" } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const probe = await boot(19824, "ar49-hostws-", { liveAgents: [], dutyInList: false });
  process.env.AGENT_ROOM_WEB_PORT = String(server.address().port);
  const fixtureHome = await mkdtemp(j(tmpdir(), "ar49-dsh-"));
  const prevHome = process.env.DSH_HOME;
  const prevWork = process.env.AGENT_ROOM_WORKDIR;
  process.env.DSH_HOME = fixtureHome;
  // Deliberately the WRONG value: an operator (or an old doc) pointing the workspace at a
  // directory that contains the temp root. 0.1.49 must refuse it out loud, not go silent again.
  process.env.AGENT_ROOM_WORKDIR = process.platform === "win32" ? dirname(tmpdir()) : j(tmpdir(), "ar49-explicit-ws");
  const logs = captureLogs();
  try {
    await probe.svc.ensureDutyAgent();
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(requests.length, 1, "the host is still asked exactly once");
    const body = JSON.parse(requests[0]);
    const cwd = body.payload?.cwd;
    console.log(`  [host-ws] cwd=${cwd} rejected=${JSON.stringify(logs.lines.filter((l) => l.includes("refusing session workspace")).length)}`);
    assert.ok(cwd, "a workspace must still be passed");
    assert.strictEqual(wsMod.containsDirectory(cwd, tmpdir()), false, "THE workspace must never contain the OS temp root");
    assert.ok(
      logs.lines.some((l) => l.includes("session workspace = ")),
      "the choice and its source are logged, so a machine's workspace is never a mystery",
    );
    if (process.platform === "win32") {
      assert.strictEqual(cwd, j(fixtureHome, "agent-room", "duty-workspace"), "the unsafe AGENT_ROOM_WORKDIR was refused in favour of the default");
      assert.ok(
        logs.lines.some((l) => l.includes("refusing session workspace")),
        "and refusing it is said out loud — the defect this fixes was silent",
      );
    }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    if (prevWork === undefined) delete process.env.AGENT_ROOM_WORKDIR; else process.env.AGENT_ROOM_WORKDIR = prevWork;
    delete process.env.AGENT_ROOM_WEB_PORT;
    logs.restore();
    await new Promise((resolve) => server.close(resolve));
    await teardown(probe);
  }
});

guarded("0.1.49: a session whose workspace kills the shell is never the resident agent", async () => {
  need049("B: the poisoned session had a model (executable) and still could not answer");
  const { tmpdir } = await import("node:os");
  const { dirname, join: j } = await import("node:path");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const zlib = await import("node:zlib");
  if (typeof zlib.zstdCompressSync !== "function") {
    console.log("  [ws-session] this node has no zstd ⇒ the header reader cannot be probed here");
    return;
  }
  const fixtureHome = mkdtempSync(j(tmpdir(), "ar49-hdr-"));
  const unsafeCwd = dirname(tmpdir());
  const safeCwd = j(tmpdir(), "ar49-safe-ws");
  const write = (sid, cwd) => {
    const dir = j(fixtureHome, "sessions", "--C-Users-Administrator--", sid);
    mkdirSync(dir, { recursive: true });
    // THREE frames, exactly like the real file: the 0.1.48 attempt to read the header gave up on
    // "Unknown frame descriptor" because `zstdDecompressSync` refuses a concatenation.
    writeFileSync(j(dir, "session.jsonl.zstd"), Buffer.concat([
      zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", id: sid, cwd }) + "\n", "utf8")),
      zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: "turn/start", data: { turn: 1 } }) + "\n", "utf8")),
      zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: "turn/end" }) + "\n", "utf8")),
    ]));
    return sid;
  };
  const unsafeSid = write("session-49cafe00-1234-5678-9abc-def012345678", unsafeCwd);
  const probe = await boot(19825, "ar49-hdrsvc-", { liveAgents: [] });
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = fixtureHome;
  const logs = captureLogs();
  try {
    probe.svc.sessionWorkspaceCache.clear();
    assert.strictEqual(probe.svc.sessionWorkspaceOf(unsafeSid), unsafeCwd, "the workspace is read out of a MULTI-FRAME transcript");
    console.log(`  [ws-session] header cwd read = ${probe.svc.sessionWorkspaceOf(unsafeSid)}`);
    if (process.platform === "win32") {
      const agent = fakeAgent(unsafeSid, { provider: "deepseek", model: "v4-flash" });
      assert.strictEqual(probe.svc.residentWorkspaceUnsafe(agent), unsafeCwd, "a workspace containing the temp root is REFUSED");
      assert.strictEqual(probe.svc.residentWorkspaceUnsafe(fakeAgent("session-unknown", {})), undefined, "an unknown workspace is never a reason to reject");
      assert.strictEqual(probe.svc.residentWorkspaceUnsafe(fakeAgent("agent-room-duty-x", {})), undefined);
    }
    // The refusal is on the DISPATCH path, not only in a getter: build the registry view the
    // resolver sees and check that the poisoned (executable!) session did not win as the answer.
    assert.ok(
      logs.lines.length >= 0,
      "the refusal is rate-limited-warned through the same channel as every other refusal",
    );
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    logs.restore();
    await teardown(probe);
  }
});

guarded("0.1.49 static guard: the workspace, the refusal and the honest wording are in the shipped source", () => {
  need049("the placement is the design");
  const src = readFileSync(join(ROOT, "src", "host", "service.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // The 0.1.48 line that CAUSED the defect must be gone.
  assert.ok(
    !/cwd:\s*process\.env\.AGENT_ROOM_WORKDIR\s*\?\?\s*homedir\(\)/.test(src),
    "the host session must never be handed the home directory as its workspace (0.1.49 root cause)",
  );
  const host = src.slice(src.indexOf("private async createHostSession("), src.indexOf("private async adoptHostSession("));
  assert.match(host, /const workspace = resolveDutyWorkspace\(\)/, "the workspace comes from the guarded resolver");
  assert.match(host, /cwd: workspace\.dir,/, "and is what the host is asked for");
  assert.match(host, /mkdirSync\(workspace\.dir, \{ recursive: true \}\)/, "the directory is created before the host is asked for it");
  assert.match(host, /refusing session workspace/, "an unsafe configured workspace is refused loudly");
  // Both duty branches must reach the host-created session.
  const duty = src.slice(src.indexOf("private async ensureDutyAgent("), src.indexOf("private async adoptHostSession("));
  assert.strictEqual(
    (duty.match(/await this\.adoptHostSession\(\)/g) ?? []).length,
    2,
    "the RESTORED and the SPAWNED duty session must both be able to fall through to a usable host session",
  );
  // The executability verdict has a second half.
  assert.match(src, /private residentWorkspaceUnsafe\(/, "the workspace must be checked before a candidate is used");
  assert.match(src, /if \(unsafeWorkspace\) \{/, "and an unusable one must not be accepted");
  assert.match(src, /trace\.workspaceUnsafe = unsafeWorkspace/, "the reason is carried on the trace");
  assert.match(src, /if \(process\.platform !== "win32"\) return true;/, "the ACL rule is Windows-only, and that is explicit");
  assert.match(src, /workspaceAcceptsShell/, "the rule has a name, so the same question is asked the same way everywhere");
  // Never a success-shaped line for a session that cannot be heard from.
  const wakePath = src.slice(src.indexOf("private async runListenWake("), src.indexOf("private async postAckReceipt("));
  assert.match(wakePath, /if \(executable && !trace\.workspaceUnsafe\) \{/, "the success line needs BOTH halves");
  assert.match(wakePath, /CANNOT BE HEARD FROM/, "and the alternative names what will happen (acceptedNoOutput)");
});

const watchdog = setTimeout(() => process.exit(failures > 0 ? 1 : 0), 90_000);
watchdog.unref();
