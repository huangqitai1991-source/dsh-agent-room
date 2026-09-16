/**
 * dsh-agent-room — AgentRoomService (Cordis Service).
 *
 * Wires the pure domain logic into DSH: persistent identity, owned-room
 * authoritative state (RoomService), remote-room membership (RoomClients),
 * the RoomGateway facade used by tools and the browser API, and a lazily
 * started PeerServer for owned rooms.
 */

import { writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, hostname, tmpdir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { AgentIdentity, ChatMessage, JoinedRoomRecord, Room, RoomSettings, SystemEvent, Task } from "../types.js";
import { RoomService } from "./room-service.js";
import { PeerServer, isControlFrame } from "./peer-server.js";
import { LanDiscovery } from "./discovery.js";
import { RoomClient } from "./room-client.js";
import { OutboundHub, OWNER_CONFIRM_WAIT_MS, toDeliveryStatus } from "./outbound.js";
import { DeliveryDedupe, MAX_DEDUPE_ROOMS, MAX_DEDUPE_SEQS_PER_ROOM } from "./dedupe.js";
import { decideListenWake, listenAuthorKind, MAX_NAMED_DENIALS_PER_SWEEP, MAX_WAKE_ROOMS, WAKE_WINDOW_ROWS, WakeWatermark, wakeKindLabel } from "./wake.js";
import type { WakeDecision, WakePreview, WakeReason, WakeRuleSelf } from "./wake.js";
import { ACK_RATE_LIMIT_MS, ACK_WINDOW_MS, AckLedger, formatAckMiss, formatAckReceipt, isAckPlaneFrame, MAX_ACK_ROOMS } from "./ack.js";
import type { AckRefusal } from "./ack.js";
// 0.1.47: the ACTIVATION chain — "the wake arrived and the turn never started", plus the
// bounded self-escalation that fixes it. See src/host/activation.ts for the measurements.
import {
  ACTIVATION_OUTPUT_WINDOW_MS,
  ACTIVATION_START_WINDOW_MS,
  ACTIVATION_TICK_MS,
  MAX_ACTIVATION_PENDING,
  WakeActivation,
} from "./activation.js";
import type { ActivationEscalation, ActivationSettlement, ResidentPath } from "./activation.js";
import { DEFAULT_PORT } from "./protocol.js";
import type { RoomBeacon } from "./protocol.js";
import { nowIso } from "./util.js";
import { assertValidNickname, clearRefusedMarker, ensureBackupRoot, failLoud, IdentityNotReadyError, readJsonConfig } from "./safety.js";
import { capabilityForTool } from "./catalog.js";
import type { RoomGateway, SelfRenameResult, TaskInput } from "../tools/gateway.js";
import * as toolsPlugin from "../tools/index.js";

export interface AgentRoomConfig {
  /** LAN port for the room server. */
  port?: number;
  /** Data directory; defaults to <DSH_HOME>/agent-room. */
  dataDir?: string;
  /** Register the room and task tools. */
  tools?: boolean;
  /** Register the agent-room skill. */
  skills?: boolean;
  /** Cross-network relay address, e.g. "ws://1.2.3.4:9320". Owners bridge their
   *  rooms to it; members fall back to it when the owner is not reachable. */
  relay?: string;
  /** Explicit DSH session id that handles room replies (activate-chat /
   *  listening wake). When unset, the plugin auto-selects and remembers the
   *  choice so followups do not land on random sessions after restarts. */
  replyAgentId?: string;
}

/** Push event delivered to the browser UI (SSE); also used by the polling
 *  fallback to know when something changed. */
export type BrowserEvent =
  | { kind: "chat"; roomId: string; message: ChatMessage }
  | { kind: "task"; roomId: string; task: Task }
  | { kind: "system"; roomId: string; event: SystemEvent }
  | { kind: "connection"; roomId: string; state: string }
  | { kind: "members"; roomId: string }
  | { kind: "state" }
  | { kind: "activate-error"; roomId: string; message: string };

export function resolveConfig(config: AgentRoomConfig = {}): Required<Pick<AgentRoomConfig, "port" | "tools" | "skills">> & { dataDir: string; relay?: string; replyAgentId?: string } {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return {
    port: config.port ?? DEFAULT_PORT,
    dataDir: config.dataDir ?? join(dshHome, "agent-room"),
    tools: config.tools ?? true,
    skills: config.skills ?? true,
    relay: config.relay ?? process.env.AGENT_ROOM_RELAY,
    replyAgentId: config.replyAgentId ?? process.env.AGENT_ROOM_REPLY_AGENT,
  };
}

/* ---------------------- 0.1.49: the workspace we hand the resident session ---------------------- */

/**
 * Whether `root` is the same directory as `candidate` or contains it.
 *
 * The SAME rule the Windows sandbox uses before it will start at all
 * (`@deepseek-ai/dsh-sandbox-windows-acl/lib/types/path-boundary.js: containsDirectory`, whose
 * caller `assertTempRootOutsideWorkspace` is the one that throws). Kept local so the plugin can
 * ask the question BEFORE handing a session a workspace that cannot run a shell.
 */
export function containsDirectory(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

/**
 * Can a session with this workspace run the shell tool at all? (0.1.49)
 *
 * MEASURED ON 小麦, 2026-09-15, first hand — the reason 0.1.48 still produced no output:
 * every `pwsh` call in the session the plugin asked the host to create died BEFORE RUNNING with
 *   `Error: Windows ACL temp root must be outside the workspace:
 *    workspace=C:\Users\Administrator; temp=C:\Users\Administrator\AppData\Local\Temp`
 * because `dsh-host-apiproxy` was handed `cwd = homedir()` — and `%TEMP%` lives INSIDE the home
 * directory. The model then escalated to `danger-full-access` (`approval/asked`), nobody answers
 * an approval in a duty session, and the turn ended with the message never posted.
 *
 * The rule is a Windows ACL-sandbox constraint, so it is only enforced there.
 */
export function workspaceAcceptsShell(workspace: string, tempRoot: string = tmpdir()): boolean {
  if (process.platform !== "win32") return true;
  return !containsDirectory(workspace, tempRoot);
}

export interface DutyWorkspaceChoice {
  dir: string;
  /** Which rule produced it — printed once, so a machine's workspace is never a mystery. */
  source: string;
  /** Candidates refused by the guard above (a machine whose operator set AGENT_ROOM_WORKDIR to
   *  the home directory must say so out loud instead of going silent again). */
  rejected: string[];
}

/**
 * Choose the workspace for the session the host creates for us (0.1.49).
 *
 * Order: the operator's `AGENT_ROOM_WORKDIR` → `<DSH_HOME>/agent-room/duty-workspace` →
 * `<os.tmpdir()>/dsh-agent-room-duty`. The last one is safe BY CONSTRUCTION (it is a child of
 * the temp root, never its ancestor), which is why it can close the list: the guard always
 * terminates with a usable directory.
 */
export function resolveDutyWorkspace(
  env: NodeJS.ProcessEnv = process.env,
  dshHome: string = env.DSH_HOME ?? join(homedir(), ".dsh"),
  tempRoot: string = tmpdir(),
): DutyWorkspaceChoice {
  const rejected: string[] = [];
  const candidates: Array<{ dir: string; source: string }> = [];
  const configured = env.AGENT_ROOM_WORKDIR?.trim();
  if (configured) candidates.push({ dir: configured, source: "AGENT_ROOM_WORKDIR" });
  candidates.push({ dir: join(dshHome, "agent-room", "duty-workspace"), source: "default (DSH_HOME/agent-room/duty-workspace)" });
  candidates.push({ dir: join(tempRoot, "dsh-agent-room-duty"), source: "fallback (os.tmpdir()/dsh-agent-room-duty)" });
  for (const candidate of candidates) {
    if (!workspaceAcceptsShell(candidate.dir, tempRoot)) {
      rejected.push(candidate.dir);
      continue;
    }
    return { dir: candidate.dir, source: candidate.source, rejected };
  }
  // Unreachable in practice (the last candidate is a CHILD of the temp root, so it can never
  // contain it); written total so the guard can never return "no workspace at all".
  const last = candidates[candidates.length - 1];
  return last
    ? { dir: last.dir, source: last.source, rejected }
    : { dir: join(tempRoot, "dsh-agent-room-duty"), source: "fallback (os.tmpdir()/dsh-agent-room-duty)", rejected };
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    agentRoom: AgentRoomService;
  }
}

/** Minimal structural view of a live DSH agent (no hard dependency on
 *  @deepseek-ai/dsh-agent at build time). */
interface AgentLike {
  readonly id?: string;
  readonly sessionId?: string;
  readonly status?: string;
  followup?(message: unknown): unknown;
  ctx?: { agent?: AgentLike };
}

/** Minimal structural view of the DSH agent registry (ctx.agents). */
interface AgentRegistryLike {
  list?(): AgentLike[];
  roots?(): AgentLike[];
  get?(id: string): AgentLike | undefined;
  currentInitiator?(): AgentLike | undefined;
  /** Spawn a dedicated agent session (used by the duty-agent bootstrap). */
  create?(options: {
    sessionId: string;
    meta?: Record<string, unknown>;
    agentOptions?: Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setup?: (agentCtx: any) => Promise<void> | void;
  }): Promise<{ agent?: AgentLike } | undefined>;
}

/**
 * Which resolution path produced the resident agent (0.1.47).
 *
 * Before this existed, "why is this machine silent" had exactly one answer available:
 * read the diag lines by hand. 小黄's machine logged `active-session: … (global fallback,
 * … dir=false)` and `registry dump — detected=… list=[] roots=[]` and NOTHING else — the
 * machine was structurally unable to accept work, and that was visible only to somebody
 * grepping its log. The trace is what turns that into `/state.activation.resolvedViaNone`.
 */
interface ResolutionTrace {
  path?: ResidentPath;
  detail?: string;
  agentId?: string;
  /** Session id of the ACTIVE-session detection (even when it did not resolve). */
  detected?: string;
  /** How many agents the registry listed, i.e. the shape of the failure. */
  registryList?: number;
  registryRoots?: number;
  /** 0.1.48: can the resolved agent really RUN A TURN (provider+model present)? `false` means
   *  the harness will throw at request proposal and `kick()` will swallow it, so the wake is
   *  accepted and never runs. `undefined` = the resolution did not get that far. */
  executable?: boolean;
  /** The model route in force for the resolved agent (`provider/model`), when known. */
  model?: string;
  /** 0.1.49: the resolved agent's workspace, when the sandbox cannot start inside it (the
   *  Windows ACL temp-root rule) — "the turn runs but the shell it needs is dead". */
  workspaceUnsafe?: string;
}

/**
 * How long a joined-room record pointing somewhere other than the configured
 * relay survives before boot-time pruning. Anything older is a leftover from the
 * direct-LAN era: unroutable from another network, but still retried on boot.
 */
const STALE_JOINED_RECORD_MS = 24 * 60 * 60 * 1000;

/**
 * zstd frame magic — `session.jsonl.zstd` is a CONCATENATION of frames (one per flush) and
 * `zstdDecompressSync` refuses the whole buffer with "Unknown frame descriptor", so the first
 * frame has to be sliced out by hand to read a session header (0.1.49).
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Bounded backoff before an auto-rejoin gives up on a room.
 *
 * Attempt 1 happens at boot; attempts 2 and 3 follow after 15s and 30s. Online
 * but briefly unreachable owners recover inside this window, so the record is
 * kept. A join that was REJECTED (room closed/gone) does not wait at all — see
 * classifyJoinFailure.
 */
const REJOIN_BACKOFF_MS = 15_000;
const REJOIN_MAX_ATTEMPTS = 3;

/**
 * How a failed join should be treated by the auto-rejoin path.
 *
 *  - "stale":     the room is gone (room-not-found / closed) — drop the local
 *                 record at once. Retrying is what made a node hammer a closed
 *                 room forever.
 *  - "rejected":  the owner answered and refused (password/full/revoked). The
 *                 record cannot be restored without user input, so it is retried
 *                 with backoff and then dropped — leaving it would retry on every
 *                 boot for the life of the install.
 *  - "transient": network-level failure (timeout/refused/DNS). The room may be
 *                 perfectly alive, so the record is KEPT.
 */
export type JoinFailureKind = "stale" | "rejected" | "transient";

export function classifyJoinFailure(message: string): JoinFailureKind {
  if (isStaleRoomError(message)) return "stale";
  // RoomClient prefixes every HTTP/relay refusal with "join rejected: <code>";
  // relay auth refusals say "auth rejected". Timeouts and refused connections
  // ("连接超时", "中继连接中断", ECONNREFUSED) deliberately do NOT match.
  if (/join rejected|auth rejected/i.test(message)) return "rejected";
  return "transient";
}

export class AgentRoomService extends Service {
  /** Cordis service dependencies: the DSH agent registry (ctx.agents) used by
   *  activate-chat / resident-agent resolution. Without this declaration,
   *  accessing ctx.agents throws "cannot get property \"agents\" without inject". */
  static inject = ["agents"];

  readonly roomService: RoomService;
  readonly config: Required<Omit<AgentRoomConfig, "dataDir" | "relay" | "replyAgentId">> & { dataDir: string; relay?: string; replyAgentId?: string };

  private peerServer: PeerServer | null = null;
  private peerStarting: Promise<string> | null = null;
  private discovery: LanDiscovery | null = null;
  /** Joined (remote) rooms, keyed by roomId. */
  private readonly clients = new Map<string, RoomClient>();
  /**
   * Pending outbound control frames for joined rooms, keyed by roomId.
   *
   * OWNED BY THE SERVICE ON PURPOSE. Putting the queue on the socket (or on the
   * RoomClient instance, or behind a captured gateway reference) means a
   * reconnect that replaces the socket orphans every pending frame — exactly the
   * silent loss this queue exists to prevent.
   */
  private readonly outbound = new OutboundHub();
  /**
   * Delivery-level dedupe for inbound chat frames (0.1.39): one `(roomId, seq)`
   * is processed once at the single emission point below. Bounded by design
   * (4096 seqs/room, 128 rooms) — see src/host/dedupe.ts for the measurement
   * behind those two numbers and for why the counters are numeric-only.
   */
  private readonly dedupe = new DeliveryDedupe(
    MAX_DEDUPE_SEQS_PER_ROOM,
    MAX_DEDUPE_ROOMS,
    (message) => this.warnRateLimited("dedupe-rooms", message),
  );
  /** Rate-limited warning bookkeeping: key -> last time it was logged. */
  private readonly warnAt = new Map<string, number>();
  /** Pending bounded-backoff rejoin timers (D-18: tracked so disposal can cancel). */
  private readonly rejoinTimers = new Set<NodeJS.Timeout>();
  /** Rooms where the local agent is currently "thinking" (activate-chat one-shot
   *  in flight); one thinking per room, cleared when our own reply lands. */
  private readonly activateThinkingRooms = new Set<string>();
  /** Rooms where the local agent LISTENS to the conversation and wakes itself
   *  when something needs it (rule layer + prompt; see sweepListening). */
  private readonly listeningRooms = new Set<string>();
  /** Per-room highest processed message seq. MONOTONIC since 0.1.41: it used to
   *  be overwritten with the tail of this node's 20-message window, which
   *  regresses whenever the local mirror lags the owner (measured: 15 local rows
   *  vs 2200+ owner rows) and made already-woken seqs look fresh again. */
  private readonly listenSeen = new Map<string, number>();
  /**
   * Wake-plane dedupe (0.1.41): one `(roomId, seq)` wakes the resident agent at
   * most once, ever. The delivery plane has had this rule since 0.1.39
   * (`dedupe.seen(roomId, message.seq)` below); the wake plane had none, which is
   * what let ONE message (room 01a098a2…, seq 315) burn 18 turns.
   *
   * Monotonic and non-expiring ON PURPOSE: a TTL guard was rejected by two
   * independent reviewers because the backwards-regression span this defect is
   * made of has no upper bound, so no finite TTL can be proven long enough. Bounded
   * by `MAX_WAKE_ROOMS` numbers (one per room) — see src/host/wake.ts.
   */
  private readonly wakeWatermark = new WakeWatermark(
    MAX_WAKE_ROOMS,
    (message) => this.warnRateLimited("wake-rooms", message),
  );
  /**
   * ACK plane (0.1.46): the receipt that says "the dispatch ARRIVED at this machine and
   * a resident agent was handed it" — as opposed to 0.1.45's `woken`, which is a rule
   * PREDICTION computed on the sender's own room view and counts dispatches, not
   * deliveries. Both roles live in this one ledger, because every node is both a target
   * (`receipts*`) and a sender (`dispatches` / `ackedTargets` / `unackedTargets`).
   * See src/host/ack.ts for the measured failure this exists to end.
   */
  private readonly ackLedger = new AckLedger(
    MAX_ACK_ROOMS,
    ACK_RATE_LIMIT_MS,
    ACK_WINDOW_MS,
    (message) => this.warnRateLimited("ack-rooms", message),
  );
  /** Rooms with a listening wake currently in flight (skip until it settles). */
  private readonly listenPending = new Set<string>();
  private listenTimer: NodeJS.Timeout | null = null;
  /**
   * The ACTIVATION chain (0.1.47): one entry per dispatch a resident agent accepted, with
   * the evidence for whether a turn ever started. The wake plane (0.1.45) proves a message
   * was ADMITTED and the ack plane (0.1.46) proves it was HANDED OVER; this is the only
   * structure that says whether anything then HAPPENED — and the only one that can trigger
   * the bounded self-escalation that makes it happen. See src/host/activation.ts.
   */
  private readonly activation = new WakeActivation(
    MAX_ACTIVATION_PENDING,
    ACTIVATION_START_WINDOW_MS,
    ACTIVATION_OUTPUT_WINDOW_MS,
    ACTIVATION_TICK_MS,
  );
  /** The escalation/settlement tick. ARM ONLY WHILE SOMETHING IS PENDING is a property of
   *  `sweepActivation` (it returns before any I/O when nothing is in flight), not of the
   *  timer — the timer itself is a fixed, unref'd interval so a dispatch can never be
   *  missed because a timer was armed late. */
  private activationTimer: NodeJS.Timeout | null = null;
  /**
   * Resident-agent error taps already installed (0.1.48), keyed by agent id.
   *
   * `AgentLoop.throwError` emits `agent/error` and `kick()` then throws the error away, so this
   * subscription is the ONLY way a turn that dies before producing anything becomes visible.
   * Keyed + guarded so a re-resolution never double-subscribes.
   */
  private readonly agentErrorTaps = new Set<string>();
  /**
   * The workspace each live session was created with (0.1.49), keyed by session id.
   *
   * Read once per session from its persisted header and cached: the executability verdict now
   * has a second half ("can this session run the SHELL it needs to answer with?"), and that
   * question sits on the dispatch path.
   */
  private readonly sessionWorkspaceCache = new Map<string, string | undefined>();
  /**
   * Persisted model selection for the resident session (0.1.48, dataDir/resident-model.json).
   *
   * WHY IT EXISTS: the duty session is created with `agentOptions: {provider, model}` and the
   * host restores it at boot WITHOUT options, so the model must come from somewhere that
   * survives a restart. Order of evidence stays mirror → persisted → host default
   * (`ctx.agentDefaultModel`); this file is the middle tier, written every time a selection is
   * proven to work.
   */
  private residentModelFile = "";
  private persistedResidentModel: { provider: string; model: string } | undefined;
  /** The host-API session creation is attempted at most ONCE per process (0.1.48) — a fleet
   *  that cannot create sessions must not stampede its own host on every wake. */
  private hostSessionAttempted = false;
  /** `<DSH_HOME>/settings.yaml` — where the host's own default model selection lives on disk
   *  (see `settingsFileModel`). Overridable so tests can point it at a fixture. */
  private settingsFilePath = "";
  /**
   * Persisted stable choice of the reply agent (dataDir/reply-agent.json).
   */
  private replyAgentFile = "";
  /**
   * Persisted LISTENING INTENT (0.1.42, dataDir/listening.json).
   *
   * `listeningRooms` used to be memory only, so every restart (upgrade, crash,
   * manual) silently dropped the intent and the machine stopped waking for room
   * messages — invisible, because the compensation lived in the upgrade script
   * and was fail-soft (小麦 read `listening=false` after 0.1.40 while 主控 came
   * back listening; same script, two machines, different outcomes).
   *
   * The intent now lives on disk at the same granularity as joined.json (one
   * record per profile × roomId), is restored on boot with no external script,
   * and is written ONLY when the toggle actually succeeded. An explicit OFF is
   * persisted as an absence, so "off then restart" stays off.
   */
  private listeningFile = "";
  /** Tail of the in-process save chain for listening.json (rapid toggles). */
  private listeningSave: Promise<void> = Promise.resolve();
  private persistedReplyAgentId: string | undefined;
  /** Dedicated duty-agent session id (agent-room-duty-<nodeAgentId>); spawned on
   *  demand so room replies never depend on "whichever session is first". */
  private dutyAgentId: string | undefined;
  /** Per joined room: live channel info (state, relay path, address). */
  private readonly connInfo = new Map<string, { state: string; viaRelay: boolean; address: string }>();
  /**
   * Bridge-truth diagnostics (0.1.42).
   *
   * `connDrops` counts status reports from a RoomClient that is NO LONGER the
   * live client for that room — every one of them used to overwrite the record
   * and leave `rooms[].bridge` describing a dead connection (card ⑤ / D-19).
   * `connReplaced` counts the joins that replaced a live client, which is the
   * moment those stale reports start arriving. Both are counters, not log lines:
   * a per-hit log is what grew an audit file to 411 MB once already.
   */
  private connDrops = 0;
  private connReplaced = 0;
  /** Relay bridge status for owned rooms: roomId -> relayStatus(). */
  private readonly relayBridge = new Map<string, "none" | "connecting" | "open" | "disconnected">();
  /** Browser push subscribers (SSE). */
  private readonly browserListeners = new Set<(event: BrowserEvent) => void>();
  /** Persisted relay config file (dataDir/relay-config.json). */
  private relayConfigFile = "";
  /** Whether the relay was explicitly configured (config/env/file). */
  private relayConfigured = false;
  private profileTimer: NodeJS.Timeout | null = null;

  constructor(ctx: Context, config: AgentRoomConfig = {}) {
    super(ctx, "agentRoom");
    this.config = resolveConfig(config);
    this.roomService = new RoomService({
      dataDir: this.config.dataDir,
      onNeedServer: () => this.ensurePeerServer(),
    });

    // THE SINGLE browser emission point for chat frames (0.1.39).
    //
    // Before 0.1.39 an inbound joined-room frame reached the browser TWICE: the
    // RoomClient `chat` handler pushed it directly AND re-injected it on this bus,
    // where this listener pushed the same object again (measured live on 0.1.37/
    // 0.1.38 three times: one frame, two SSE events, same millisecond; seq
    // 2335/2359/2368 each n=2). The control-frame filter existed on the direct
    // path only, so `[org:*]` frames — work orders, filtered from the HTTP read
    // view since 0.1.31 — still leaked one push into the browser list, and
    // `noteOwnReply` ran twice per frame. The direct emit is gone; both the guard
    // and the dedupe now live here, on the one path every frame traverses.
    //
    // Owned rooms only ever came through this listener, so their behaviour is
    // unchanged except that they too stop leaking control frames (measured: the
    // owner side pushed them once).
    this.roomService.on("chat", (roomId, message) => {
      this.ctx.logger?.info?.("[agent-room] chat in %s from %s", roomId, message.from);
      // Delivery-level dedupe: the same (roomId, seq) is processed once — no
      // browser push AND no noteOwnReply for a repeat. Counters only; a per-hit
      // log line is what grew an audit file to 411 MB once already.
      if (this.dedupe.seen(roomId, message.seq)) return;
      // Control frames (`[org:`) are work orders, not chat, and are filtered from
      // the read view by design (0.1.31+). The browser push IS the read view — the
      // UI appends a pushed message straight into the visible list — so they must
      // not be pushed. Everything else below still runs: this bus is how
      // agent-org's exec plane sees inbound frames, and it needs every frame
      // including the control ones.
      if (!isControlFrame(message.text)) this.emitBrowser({ kind: "chat", roomId, message });
      this.noteOwnReply(roomId, message);
    });
    this.roomService.on("task", (roomId, task) => {
      this.ctx.logger?.info?.("[agent-room] task %s -> %s in %s", task.title, task.status, roomId);
      this.emitBrowser({ kind: "task", roomId, task });
    });
    this.roomService.on("system", (roomId, event) => this.emitBrowser({ kind: "system", roomId, event }));
    this.roomService.on("members", (roomId) => this.emitBrowser({ kind: "members", roomId }));
    this.roomService.on("roomState", () => {
      this.refreshRelayBridge();
      this.emitBrowser({ kind: "state" });
    });

    ctx.effect(() => {
      // boot is fire-and-forget, but a rejection here used to escape during the
      // load phase and DSH turned it into a fatal load failure (the "hang").
      //
      // 0.1.38: a console warning is NOT an acceptable outcome for a damaged
      // config. Swallowing the rejection left the process alive with the whole
      // room host dead (boot() throws before ensurePeerServer/LAN/profileTimer),
      // so the machine looked healthy on 3080 while serving no room at all.
      // Re-throwing hands the failure to the host's fatal path
      // (`installFailLoud`: "dsh: fatal load failure: <stack>" + exit 1), which
      // disposes the half-built fiber first — strictly better than process.exit.
      void this.boot().catch((error) => failLoud("[agent-room]", error, this.ctx.logger));
      return () => {
        // Disposal must stop the retry loop (D-18): the bounded-backoff rejoin
        // timers are NOT unref'd, so a disposed node kept dialling — and a test
        // process kept waiting ~45s for them to expire.
        this.stopRejoinRetries();
        for (const timer of [this.profileTimer, this.listenTimer, this.activationTimer]) {
          try { if (timer) clearInterval(timer); } catch { /* ignore */ }
        }
      };
    }, "agent-room: boot");
  }

  /** Recent messages for a room (owned via store, joined via client snapshot). */
  private async recentMessagesFor(roomId: string, limit: number): Promise<ChatMessage[]> {
    const owned = this.roomService.getOwnedRoom(roomId);
    if (owned) return this.roomService.recentMessages(roomId, limit);
    const client = this.clients.get(roomId);
    const all = client?.snapshot?.recentMessages ?? [];
    return all.slice(-limit);
  }

  /** True while the local agent is thinking for this room (activate-chat in flight). */
  isActivateThinking(roomId: string): boolean {
    return this.activateThinkingRooms.has(roomId);
  }

  /**
   * 激活聊天 (one-shot): mark the room as thinking and ask the resident agent
   * to reply once with room_send based on the room context. Resolves the
   * resident agent synchronously so the web layer can return an explicit
   * HTTP 500 when no agent is available (never silently clears thinking).
   * Throws when the room is already thinking (HTTP 409) or no resident agent
   * exists (HTTP 500).
   */
  async activateChat(roomId: string): Promise<{ agentId?: string }> {
    if (this.activateThinkingRooms.has(roomId)) {
      throw new Error("该房间正在思考中，请等待回复完成");
    }
    const identity = this.roomService.getIdentity();
    if (!identity) throw new Error("本机身份未就绪");
    const agent = await this.resolveResidentAgent(identity);
    if (!agent) {
      this.diag("activate-chat: rejecting " + roomId + " — no resident agent found");
      throw new Error("未找到本机 agent，无法激活聊天（请确认 DSH agent 会话已就绪后重试）");
    }
    this.activateThinkingRooms.add(roomId);
    this.emitBrowser({ kind: "state" });
    void this.runActivateChat(roomId, identity, agent);
    return { agentId: agent.id ?? agent.sessionId };
  }

  /** Diagnostic logger: always lands on stderr (console.error) so activate-chat
   *  issues are visible in dsh-web-new.err.log even when ctx.logger is quiet.
   *  Also mirrors to the cordis logger when available. */
  private diag(message: string, ...args: unknown[]): void {
    try {
      console.error("[agent-room] " + message, ...args);
    } catch {
      /* logging must never throw */
    }
    try {
      this.ctx.logger?.info?.("[agent-room] " + message, ...args);
    } catch {
      /* ignore */
    }
  }

  /** Structural view of the DSH agent registry (ctx.agents), if present. */
  private agentsRegistry(): AgentRegistryLike | undefined {
    return (this.ctx as unknown as { agents?: AgentRegistryLike }).agents;
  }

  /* ------------------------- outbound queue (joined) ------------------------- */

  /**
   * Deliver whatever is queued for a joined room, called whenever its channel
   * becomes usable again (open after join, open after reconnect).
   *
   * The queue itself is per-room service state, so it survives the socket swap
   * that a reconnect performs.
   */
  private flushOutQueue(roomId: string, reason: string): void {
    const client = this.clients.get(roomId);
    if (!client) return;
    const queue = this.outbound.peek(roomId);
    if (!queue || queue.length === 0) return;
    const outcome = this.outbound.flush(roomId, client);
    if (outcome.delivered > 0) {
      this.ctx.logger?.info?.(
        "[agent-room] flushed %d queued control frame(s) for %s (%s, %d still pending)",
        outcome.delivered, roomId, reason, outcome.remaining,
      );
    }
    if (outcome.stopped) {
      this.warnRateLimited(
        "flush:" + roomId,
        `[agent-room] queued flush for ${roomId} stopped after ${outcome.delivered} frame(s); ${outcome.remaining} still pending (channel closed again)`,
      );
    }
  }

  /** One warning per key per minute; a dead channel must not flood the log. */
  private warnRateLimited(key: string, message: string, windowMs = 60_000): void {
    const now = Date.now();
    if (now - (this.warnAt.get(key) ?? 0) < windowMs) return;
    this.warnAt.set(key, now);
    try {
      console.warn(message);
    } catch {
      /* logging must never throw */
    }
    try {
      this.ctx.logger?.warn?.(message);
    } catch {
      /* ignore */
    }
  }

  /**
   * Addresses of this node's own room server, normalised for comparison.
   *
   * Used to recognise a "joined" record that actually points back at ourselves —
   * the self-join that delivered every frame twice (and grew one machine's audit
   * log to 923 MB).
   *
   * 0.1.37 REGRESSION FIX: this used to call `lanCandidates()`, which is the
   * JOIN-CANDIDATE helper — it merges the manual address and, decisively, every
   * address seen in LAN beacons, i.e. OTHER NODES' addresses (`lanCandidates`
   * is documented as "addresses seen in LAN beacons -> this node's own interface
   * candidates"). Feeding it here made every remote owner whose beacon we had
   * ever discovered look like "this machine", so `joinRoom` refused a legitimate
   * join with 不能通过本机自己的地址加入房间（self-join）: the node 主控 (own
   * interfaces .204/Tailscale/MEmu only) was locked out of 小婷's room at
   * 192.168.31.82:9317 — the owner's address, taken straight from its beacon.
   *
   * The predicate must ONLY ever contain addresses that are unambiguously ours:
   * our own listening address, loopback on our port, and our own interfaces from
   * `networkInterfaces()` (`peerServer.candidates` = hostCandidates(port), which
   * cannot report a peer).
   */
  private ownAddresses(): Set<string> {
    const addresses = new Set<string>();
    const add = (value: unknown): void => {
      const normalised = normaliseAddress(value);
      if (normalised) addresses.add(normalised);
    };
    add(this.peerServer?.address);
    add(`127.0.0.1:${this.config.port}`);
    add(`localhost:${this.config.port}`);
    // OWN INTERFACES ONLY — never `lanCandidates()`, never beacon addresses.
    for (const candidate of this.peerServer?.candidates ?? []) add(candidate);
    return addresses;
  }

  /**
   * Drop one joined-room record and nothing else.
   *
   * Local cleanup is always possible, which is why leave is best-effort: a room
   * whose owner is gone can never be reached to say goodbye, and refusing to
   * forget it locally is what left the node retrying a closed room forever.
   */
  private async forgetJoinedRoom(roomId: string, reason: string): Promise<boolean> {
    let removed = false;
    try {
      removed = await this.roomService.removeJoinedRoom(roomId);
    } catch (error) {
      this.warnRateLimited(
        "forget:" + roomId,
        `[agent-room] failed to remove joined record ${roomId}: ${String(error)}`,
      );
      return false;
    }
    if (removed) this.ctx.logger?.info?.("[agent-room] dropped joined record %s (%s)", roomId, reason);
    return removed;
  }

  /**
   * Find the resident (local) agent that should reply to an activate-chat.
   * Tries several registry entry points in order, logging each attempt:
   * 1. ctx.agent — the scoped agent association when the service context is
   *    agent-derived;
   * 2. agents.currentInitiator() — the agent initiating the caller chain;
   * 3. agents.get(identity.agentId) — the room identity, when it matches a
   *    live session id;
   * 4. agents.list()[0] / agents.roots()[0] — first live / top-level agent.
   *
   * 0.1.47: every return ALSO fills in `trace`, because "which path resolved this machine's
   * resident agent" is the difference between 小婷 (duty agent, works) and 小黄 (nothing
   * resolved, structurally unable to accept work) — and before this version that difference
   * existed only inside this function's own diag lines.
   */
  private async resolveResidentAgent(identity: AgentIdentity, trace?: ResolutionTrace): Promise<AgentLike | undefined> {
    const agents = this.agentsRegistry();
    const usable = (a: AgentLike | undefined): AgentLike | undefined =>
      a && typeof a.followup === "function" ? a : undefined;
    /**
     * 0.1.48: A CANDIDATE MAY ONLY WIN IF IT CAN ACTUALLY RUN A TURN.
     *
     * Until this version the first candidate that merely had a `followup` method won, and on
     * a machine whose duty session was spawned without a model that candidate could NEVER run
     * (harness: `dsh-agent-loop/lib/index.js:714` throws, `kick()` swallows). The wake was
     * accepted and nothing happened — for hours, on two machines, invisibly.
     *
     * So the chain now collects candidates in priority order and returns the first one that is
     * EXECUTABLE (provider+model). A non-executable candidate is remembered as a last resort,
     * after an attempt to supply it a model (mirror → persisted → the host's own default), and
     * if it has to be used, the trace says so and the caller refuses to print success.
     */
    let fallback: { path: ResidentPath; agent: AgentLike; detail: string } | undefined;
    /**
     * 0.1.49: a candidate that CAN run a turn but whose workspace cannot run a SHELL.
     *
     * Measured on 小麦: `started:1` was true and the transcript proved the turn really ran
     * (`turn/start`, reasoning, token usage) — and still nothing came out, because the prompt's
     * reply route (there is no `room_send` tool in a host-created session) is `pwsh`, and every
     * `pwsh` call in that workspace failed before running with
     *   `Windows ACL temp root must be outside the workspace: workspace=C:\Users\Administrator;
     *    temp=C:\Users\Administrator\AppData\Local\Temp`
     * (`cwd` was `homedir()`, and `%TEMP%` lives inside the home directory). The turn then sat on
     * an `approval/asked` nobody can answer and ended with no output, for ever.
     *
     * So "executable" is NOT enough to win any more: a session we cannot talk out of must yield
     * to the session the host can create for us with a workspace we chose (createHostSession).
     */
    let workspaceFallback: { path: ResidentPath; agent: AgentLike; detail: string; workspace: string } | undefined;
    const accept = (path: ResidentPath, agent: AgentLike, detail: string): AgentLike | undefined => {
      this.tapAgentError(agent);
      const unsafeWorkspace = this.residentWorkspaceUnsafe(agent);
      if (unsafeWorkspace) {
        this.warnRateLimited(
          "resident-workspace-unsafe:" + (agent.id ?? agent.sessionId ?? "unknown"),
          `[agent-room] refusing to use ${agent.id ?? agent.sessionId ?? "unknown"} (via ${path}) as the resident agent: its workspace ` +
            `${unsafeWorkspace} contains the OS temp root (${tmpdir()}), so the sandboxed shell cannot start and the agent has no way to ` +
            "post its reply — the turn would run and produce NOTHING (0.1.49; measured on 小麦)",
        );
        if (trace) trace.workspaceUnsafe = unsafeWorkspace;
        if (!workspaceFallback) workspaceFallback = { path, agent, detail, workspace: unsafeWorkspace };
        return undefined;
      }
      if (this.agentExecutable(agent)) {
        const model = this.agentModelOf(agent);
        if (trace) {
          trace.path = path;
          trace.detail = detail;
          trace.agentId = agent.id ?? agent.sessionId;
          trace.executable = true;
          trace.model = model.provider + "/" + model.model;
        }
        return agent;
      }
      const repaired = this.repairResidentModel(agent, path);
      if (repaired) {
        if (trace) {
          trace.path = path;
          trace.detail = detail + ", model REPAIRED to " + repaired.provider + "/" + repaired.model + " (" + repaired.source + ")";
          trace.agentId = agent.id ?? agent.sessionId;
          trace.executable = true;
          trace.model = repaired.provider + "/" + repaired.model;
        }
        return agent;
      }
      if (!fallback) fallback = { path, agent, detail };
      return undefined;
    };

    // 1. explicit override (config / AGENT_ROOM_REPLY_AGENT)
    // Helper: agents.get() cannot find GUI sessions (session-*), so fall back
    // to searching list()/roots() by id/sessionId.
    const findById = (want: string): AgentLike | undefined => {
      try {
        const direct = agents?.get?.(want);
        if (direct) return direct;
      } catch { /* ignore */ }
      try {
        return agents?.list?.()?.find((x) => (x.id ?? x.sessionId) === want);
      } catch { /* ignore */ }
      try {
        return agents?.roots?.()?.find((x) => (x.id ?? x.sessionId) === want);
      } catch { /* ignore */ }
      return undefined;
    };
    if (this.config.replyAgentId) {
      const a = usable(findById(this.config.replyAgentId));
      if (a) {
        this.diag("activate-chat: resident agent via config override (id=" + (a.id ?? a.sessionId ?? "unknown") + ")");
        const won = accept("config", a, "config.replyAgentId=" + this.config.replyAgentId);
        if (won) return won;
      }
    }
    // 1a. auto-detect the boss's active session: the session whose transcript is
    // most recently written under <DSH_HOME>/sessions/<workspace-of-cwd>.
    // This follows the boss's conversation even when the session id rotates.
    {
      const activeId = this.detectActiveSessionId();
      if (activeId) {
        const a = usable(findById(activeId));
        if (a) {
          this.diag("activate-chat: resident agent via active-session detection (id=" + (a.id ?? a.sessionId ?? "unknown") + ")");
          const won = accept("active-session", a, "detected=" + activeId);
          if (won) return won;
        }
      }
      // Diagnostic: dump the registry + detection so we can see what's reachable.
      try {
        const listIds = agents?.list?.()?.map((x) => x.id ?? x.sessionId ?? "?") ?? [];
        const rootIds = agents?.roots?.()?.map((x) => x.id ?? x.sessionId ?? "?") ?? [];
        this.diag("activate-chat: registry dump — detected=" + (activeId ?? "none") + " list=[" + listIds.join(", ") + "] roots=[" + rootIds.join(", ") + "]");
        // 0.1.47: the dump used to be the ONLY place this fact lived. It is carried on the
        // trace as well, so the wake path can put it in /state instead of in a log file.
        if (trace) {
          trace.detected = activeId;
          trace.registryList = listIds.length;
          trace.registryRoots = rootIds.length;
        }
      } catch { /* ignore */ }
    }
    // 1b. dedicated duty-agent session (root-cause fix): stable, spawned on
    // demand, independent of the boss's chat sessions.
    const duty = await this.ensureDutyAgent();
    if (duty) {
      const won = accept("duty", duty, "duty=" + (duty.id ?? duty.sessionId ?? "unknown"));
      if (won) return won;
    }
    // 2. persisted stable choice (dataDir/reply-agent.json) — survives restarts
    if (this.persistedReplyAgentId) {
      const a = usable(findById(this.persistedReplyAgentId));
      if (a) {
        this.diag("activate-chat: resident agent via persisted choice (id=" + (a.id ?? a.sessionId ?? "unknown") + ")");
        const won = accept("persisted", a, "persisted=" + this.persistedReplyAgentId);
        if (won) return won;
      }
    }
    // 3. room identity matching a live session
    try {
      const a = usable(agents?.get?.(identity.agentId));
      if (a) {
        this.diag("activate-chat: resident agent via room identity (id=" + (a.id ?? a.sessionId ?? "unknown") + ")");
        const won = accept("identity", a, "identity=" + identity.agentId);
        if (won) {
          this.saveReplyAgentId(a);
          return won;
        }
      }
    } catch { /* ignore */ }
    // 4. heuristic: session-* ids first, kanban task agents excluded
    let all: AgentLike[] = [];
    try { all = agents?.list?.() ?? []; } catch { /* ignore */ }
    const candidates = all.filter((a) => typeof a.followup === "function" && !(a.id ?? a.sessionId ?? "").includes("herness-kanban-task-"));
    const preferred = candidates.filter((a) => (a.id ?? a.sessionId ?? "").startsWith("session-"));
    const ordered = [...(preferred.length > 0 ? preferred : candidates)];
    for (const pick of ordered) {
      this.diag("activate-chat: resident agent via heuristic " + (preferred.length > 0 ? "session-*" : "fallback") + " (id=" + (pick.id ?? pick.sessionId ?? "unknown") + ")");
      const won = accept("heuristic", pick, "heuristic candidates=" + candidates.length);
      if (won) {
        this.saveReplyAgentId(pick);
        return won;
      }
    }
    // NOTHING executable. If some candidate at least exists, hand it back — but the trace marks
    // it, so every caller must say "this machine cannot execute" instead of "accepted".
    // Nothing executable won. Prefer the honest failure we already know how to describe
    // (no model: every caller prints "CANNOT RUN"), and only then a session that can run but
    // cannot be heard from (an unusable workspace), which the trace marks explicitly.
    if (fallback) {
      if (trace) {
        trace.path = fallback.path;
        trace.detail = fallback.detail + " (NOT EXECUTABLE: no provider/model — the harness throws at request proposal, dsh-agent-loop/lib/index.js:714)";
        trace.agentId = fallback.agent.id ?? fallback.agent.sessionId;
        trace.executable = false;
        trace.model = undefined;
      }
      return fallback.agent;
    }
    if (workspaceFallback) {
      const model = this.agentModelOf(workspaceFallback.agent);
      if (trace) {
        trace.path = workspaceFallback.path;
        trace.detail = workspaceFallback.detail + " (EXECUTABLE but NOT USABLE: workspace " + workspaceFallback.workspace +
          " contains the OS temp root, so the sandboxed shell cannot start and the agent cannot post its reply — 0.1.49)";
        trace.agentId = workspaceFallback.agent.id ?? workspaceFallback.agent.sessionId;
        trace.executable = true;
        trace.model = model.provider && model.model ? model.provider + "/" + model.model : undefined;
        trace.workspaceUnsafe = workspaceFallback.workspace;
      }
      return workspaceFallback.agent;
    }
    this.diag("activate-chat: NO resident agent (registry=" + (agents ? "present" : "absent") + ", agents.list()=" + all.length + ")");
    if (trace) {
      trace.path = "none";
      trace.detail = "registry=" + (agents ? "present" : "absent") + " list=" + all.length + " detected=" + (trace.detected ?? "none");
      trace.agentId = undefined;
      trace.executable = false;
    }
    return undefined;
  }

  /* ------------------- 0.1.48: is the resident agent really able to run? ------------------- */

  /** The model route an agent handle carries (`agent.options` — what the harness reads at
   *  request-proposal time, `dsh-agent-loop/lib/index.js:696-699`). */
  private agentModelOf(agent: AgentLike | undefined): { provider?: string; model?: string } {
    const options = (agent as unknown as { options?: { provider?: string; model?: string } } | undefined)?.options;
    return { provider: options?.provider, model: options?.model };
  }

  /** Can this agent run a turn? The harness's own condition, checked before we claim anything. */
  private agentExecutable(agent: AgentLike | undefined): boolean {
    const { provider, model } = this.agentModelOf(agent);
    return Boolean(provider && model);
  }

  /**
   * The workspace a live session was created with, read from that session's OWN persisted header
   * (0.1.49). The agent handle does not carry `meta.cwd`, and the header is the only durable
   * record of the workspace: `<DSH_HOME>/sessions/<ws-slug>/<sessionId>/session.jsonl.zstd`
   * starts with `{"type":"session","id":…,"cwd":…}` in its first zstd frame.
   *
   * Bounded: one directory listing + one small read per session id, cached, and it silently
   * gives up (returns undefined ⇒ "assume usable") when zstd or the file is unavailable.
   */
  private sessionWorkspaceOf(sessionId: string): string | undefined {
    if (!sessionId || sessionId.includes("..")) return undefined;
    if (this.sessionWorkspaceCache.has(sessionId)) return this.sessionWorkspaceCache.get(sessionId);
    let found: string | undefined;
    try {
      if (typeof zstdDecompressSync === "function") {
        const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
        const root = join(dshHome, "sessions");
        for (const workspace of readdirSync(root, { withFileTypes: true })) {
          if (!workspace.isDirectory()) continue;
          const file = join(root, workspace.name, sessionId, "session.jsonl.zstd");
          if (!existsSync(file)) continue;
          const buffer = readFileSync(file);
          const firstFrameEnd = buffer.indexOf(ZSTD_MAGIC, 4);
          const frame = firstFrameEnd === -1 ? buffer : buffer.subarray(0, firstFrameEnd);
          const header = JSON.parse(zstdDecompressSync(frame).toString("utf8").split("\n")[0] ?? "") as { cwd?: unknown };
          if (typeof header.cwd === "string" && header.cwd) found = header.cwd;
          break;
        }
      }
    } catch { /* unreadable/undecodable ⇒ unknown workspace, never a reason to reject a session */ }
    if (this.sessionWorkspaceCache.size > 64) this.sessionWorkspaceCache.clear();
    this.sessionWorkspaceCache.set(sessionId, found);
    return found;
  }

  /**
   * The workspace of this agent IF the sandbox cannot start inside it (Windows only; the rule
   * does not exist on the landlock/seatbelt platforms) — undefined means "usable or unknown".
   */
  private residentWorkspaceUnsafe(agent: AgentLike | undefined): string | undefined {
    if (process.platform !== "win32") return undefined;
    const id = agent?.id ?? agent?.sessionId;
    if (!id) return undefined;
    const workspace = this.sessionWorkspaceOf(id);
    if (!workspace) return undefined;
    return workspaceAcceptsShell(workspace) ? undefined : workspace;
  }

  /**
   * The host's OWN default model selection — the same source every host create/resume path
   * uses (`dsh-host-apiproxy/lib/index.js:5532`:
   * `defaultModelSelection: () => ctx.agentDefaultModel.currentSelection()`).
   *
   * WHY THE PLUGIN MUST HAVE A SECOND SOURCE: `ensureDutyAgent` used to MIRROR provider/model
   * from a live session, and the mirror loop finds nothing on a machine with no live sessions
   * — which is exactly the state after every restart. The result was a duty session with empty
   * `agentOptions` (no model) that could never run a turn.
   */
  private hostDefaultModel(): { provider: string; model: string } | undefined {
    try {
      const ctxAny = this.ctx as unknown as {
        agentDefaultModel?: { currentSelection?: () => { provider?: string; model?: string } };
        get?: (name: string) => unknown;
      };
      const service = ctxAny.agentDefaultModel
        ?? (ctxAny.get?.("agentDefaultModel") as { currentSelection?: () => { provider?: string; model?: string } } | undefined);
      const selection = service?.currentSelection?.();
      if (selection && typeof selection.provider === "string" && selection.provider &&
          typeof selection.model === "string" && selection.model) {
        return { provider: selection.provider, model: selection.model };
      }
    } catch { /* service not mounted (headless run, unit test) — the persisted file still works */ }
    return undefined;
  }

  /** A selection mirrored from a live session, exactly as 0.1.46 did it. */
  private mirroredModel(): { provider: string; model: string } | undefined {
    try {
      for (const a of this.agentsRegistry()?.list?.() ?? []) {
        const { provider, model } = this.agentModelOf(a);
        if (provider && model) return { provider, model };
      }
    } catch { /* ignore */ }
    return undefined;
  }

  /**
   * The host's default model selection AS IT EXISTS ON DISK (0.1.48, measured need).
   *
   * WHY THIS TIER EXISTS: on a real machine (小麦, 2026-09-15) the plugin's `ctx` does NOT
   * resolve the `agentDefaultModel` service — the field log said so verbatim
   * ("ctx.agentDefaultModel is absent") — so the in-process access path returned nothing and
   * the duty session was still spawned model-less. The SAME data is persisted by the settings
   * provider into `<DSH_HOME>/settings.yaml`:
   *
   *     agent-default-model:
   *       provider: deepseek-official
   *       model: deepseek-v4-flash-vision-exp
   *
   * Reading that file needs no service, no dependency and no YAML library (a two-key section),
   * and it is exactly what `AgentDefaultModelConfig.currentSelection()` returns
   * (`dsh-agent-default-model/lib/index.js:56` → `selection(this.source())`, and the source is
   * the `agent-default-model` settings section).
   */
  private settingsFileModel(): { provider: string; model: string } | undefined {
    try {
      if (!this.settingsFilePath || !existsSync(this.settingsFilePath)) return undefined;
      const text = readFileSync(this.settingsFilePath, "utf8");
      // A deliberately tiny reader for exactly one section — never a YAML parser.
      const lines = text.split(/\r?\n/);
      let inSection = false;
      let provider: string | undefined;
      let model: string | undefined;
      for (const line of lines) {
        if (/^agent-default-model:\s*$/.test(line)) { inSection = true; continue; }
        if (inSection && /^[^\s#]/.test(line)) break; // the section ended
        if (!inSection) continue;
        const entry = /^\s+(provider|model):\s*(.+?)\s*$/.exec(line);
        if (!entry) continue;
        const value = entry[2]!.replace(/^["']|["']$/g, "");
        if (entry[1] === "provider") provider = value;
        else model = value;
      }
      if (provider && model) return { provider, model };
    } catch { /* unreadable settings — the other tiers still apply */ }
    return undefined;
  }

  /** Every model source, in order of evidence: mirror → persisted (survives restarts) → host default. */
  private resolveModelSelection(): { selection: { provider: string; model: string }; source: string } | undefined {
    const mirrored = this.mirroredModel();
    if (mirrored) return { selection: mirrored, source: "mirrored-from-live-session" };
    if (this.persistedResidentModel) return { selection: this.persistedResidentModel, source: "persisted (" + this.residentModelFile + ")" };
    const onDisk = this.settingsFileModel();
    if (onDisk) return { selection: onDisk, source: "host-default (" + this.settingsFilePath + ")" };
    const hostDefault = this.hostDefaultModel();
    if (hostDefault) return { selection: hostDefault, source: "host-default (ctx.agentDefaultModel)" };
    return undefined;
  }

  /**
   * Where does THIS machine's dsh web API live?
   *
   * 0.1.48 FIRST FIELD RUN got this wrong and the log said so verbatim:
   *   `could not create a session through the host (http://127.0.0.1:9317/api/session.create → HTTP 404)`
   * — 9317 is `config.port`, the AGENT-ROOM LAN port, not the web UI port. The two are different
   * servers in the same process. Resolution order: `AGENT_ROOM_WEB_PORT`, then whatever the
   * mounted `webServer` service advertises, then the fleet-wide default 3080 (the same port
   * `sendFallbackLine` has always hardcoded, because that is where the room API is served).
   */
  private webApiBase(): string {
    let port: number | undefined;
    const explicit = Number(process.env.AGENT_ROOM_WEB_PORT);
    if (Number.isSafeInteger(explicit) && explicit > 0) port = explicit;
    if (port === undefined) {
      try {
        const ctxAny = this.ctx as unknown as {
          webServer?: { port?: number; address?: { port?: number } };
          get?: (name: string) => unknown;
        };
        const webServer = (ctxAny.webServer
          ?? (ctxAny.get?.("webServer") as { port?: number; address?: { port?: number } } | undefined)) as
          | { port?: number; address?: { port?: number } }
          | undefined;
        const advertised = webServer?.port ?? webServer?.address?.port;
        if (typeof advertised === "number" && Number.isSafeInteger(advertised) && advertised > 0) port = advertised;
      } catch { /* service not mounted — the default below is the documented convention */ }
    }
    return "http://127.0.0.1:" + (port ?? 3080);
  }

  /**
   * Create a REAL session through the host's own session API (0.1.48, the last mile).
   *
   * WHY THIS EXISTS (measured on 小麦, 2026-09-15): all four model sources can be empty at once
   * — no live session to mirror, nothing persisted, `<DSH_HOME>/settings.yaml` carrying no
   * `agent-default-model` section (52 bytes of `ui-onboarding` only), and `ctx.agentDefaultModel`
   * unreachable from the plugin. The duty session is then created model-less and can never run.
   * The ONE path that carries a real selection is the host creating the session itself: its
   * create/resume paths pass `agentOptions()` = `defaults.defaultModelSelection()`
   * (`dsh-host-apiproxy/lib/index.js:1650-1653`), which is populated from the launch config
   * rather than from the settings file.
   *
   * Measured request/response on that machine (raw, first-hand):
   *   POST http://127.0.0.1:3080/api/session.create
   *   {"type":"client-request","rpcId":"ar48-…","method":"session.create",
   *    "payload":{"cwd":"C:/Users/Administrator","agentPreset":"standard"}}
   *   → 200 {"type":"server-response","result":{"ok":true,
   *          "value":{"sessionId":"session-e03107fc-efd5-480d-bf26-98df83d9941e","agentPreset":"standard"}}}
   *
   * The wake that then landed on that session reported `residentExecutable:1`,
   * `startedByStatus:1` and `escalationsAttempted:0` — i.e. the turn demonstrably started, which
   * is exactly what the duty session could never do. The created session is a REAL session: it
   * lives on disk, has a model, and the host restores it at boot — so the binding is durable.
   *
   * Bounded: attempted at most ONCE per process (a fleet that cannot create sessions must not
   * stampede its own host), counted in both outcomes, and never on the wake's critical path.
   */
  private async createHostSession(): Promise<string | undefined> {
    if (this.hostSessionAttempted) return undefined;
    this.hostSessionAttempted = true;
    const url = this.webApiBase() + "/api/session.create";
    // 0.1.49 — THE WORKSPACE IS NOT A DETAIL.
    //
    // 0.1.48 handed the host `cwd: homedir()`. On Windows that makes the ACL sandbox unable to
    // start at all (`%TEMP%` sits inside the home directory ⇒ `assertTempRootOutsideWorkspace`
    // throws), so EVERY shell call in the created session failed before running — and since a
    // host-created session carries no `room_send` tool, the shell IS the only way the agent can
    // post its reply. The turn started, consumed tokens, escalated for an approval nobody can
    // answer, and produced nothing: 小麦's `started:1` + `acceptedNoOutput:1`, measured.
    const workspace = resolveDutyWorkspace();
    if (workspace.rejected.length > 0) {
      this.warnRateLimited(
        "workspace-rejected",
        "[agent-room] refusing session workspace(s) " + workspace.rejected.join(", ") + " — the sandbox cannot start when the OS temp root (" +
          tmpdir() + ") sits inside the session workspace, and every shell call in that session would fail before running (0.1.49)",
      );
    }
    try {
      mkdirSync(workspace.dir, { recursive: true });
    } catch (error) {
      this.diag("resident: could not create the session workspace " + workspace.dir + " (" + String(error) + ") — the host may still accept it");
    }
    const body = {
      type: "client-request",
      rpcId: "agent-room-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      method: "session.create",
      payload: {
        cwd: workspace.dir,
        agentPreset: "standard",
      },
    };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await response.json().catch(() => undefined)) as
        | { result?: { ok?: boolean; value?: { sessionId?: string } } }
        | undefined;
      const sessionId = json?.result?.value?.sessionId;
      if (!response.ok || typeof sessionId !== "string" || !sessionId) {
        this.activation.noteHostSessionCreated(false);
        this.warnRateLimited(
          "host-session-failed",
          `[agent-room] could not create a session through the host (${url} → HTTP ${response.status}, sessionId=${String(sessionId)}) — ` +
            "this machine has no model source at all and stays unable to run a turn",
        );
        return undefined;
      }
      // Persist the binding FIRST: the session survives restarts (the host restores real
      // sessions), and this file is what re-attaches to it after a restart.
      this.persistedReplyAgentId = sessionId;
      if (this.replyAgentFile) {
        void writeFile(this.replyAgentFile, JSON.stringify({ replyAgentId: sessionId }, null, 2), "utf8").catch(() => { /* non-fatal */ });
      }
      this.activation.noteHostSessionCreated(true);
      this.diag(
        "resident: created a REAL session through the host API (" + url + ") → " + sessionId +
          " — this is the session that carries the host's own model selection; the model-less duty session " +
          "can never run a turn (activation.hostSessionsCreated counts this)",
      );
      this.diag(
        "resident: session workspace = " + workspace.dir + " [" + workspace.source + "] — chosen so the sandboxed shell can start " +
          "(the Windows ACL sandbox refuses any workspace that contains the OS temp root " + tmpdir() + "); the agent has no room_send tool " +
          "in a host-created session, so this is the only route its reply can take",
      );
      return sessionId;
    } catch (error) {
      this.activation.noteHostSessionCreated(false);
      this.warnRateLimited(
        "host-session-error",
        `[agent-room] could not create a session through the host (${url}): ${String(error)} — ` +
          "this machine has no model source at all and stays unable to run a turn",
      );
      return undefined;
    }
  }

  /** Remember the selection that WORKED, so a later restart does not have to guess again. */
  private saveResidentModel(selection: { provider: string; model: string }, source: string): void {
    this.persistedResidentModel = selection;
    if (!this.residentModelFile) return;
    void writeFile(
      this.residentModelFile,
      JSON.stringify({ ...selection, source, at: new Date().toISOString() }, null, 2),
      "utf8",
    ).catch(() => { /* non-fatal: the next resolution just has one fewer source */ });
  }

  /**
   * Supply a model selection to a session that has none, and RE-VERIFY.
   *
   * The harness reads `agent.options` at request-proposal time, so writing the two fields on
   * the handle is exactly the repair — no session recreation, no restart, no lifecycle risk.
   * If the object is frozen or no selection is available from any source, this returns
   * undefined and the caller must NOT print success.
   */
  private repairResidentModel(agent: AgentLike, path: ResidentPath): { provider: string; model: string; source: string } | undefined {
    const resolved = this.resolveModelSelection();
    const agentId = agent.id ?? agent.sessionId ?? "unknown";
    if (!resolved) {
      this.activation.noteExecutabilityRepair(false);
      this.warnRateLimited(
        "no-model-source:" + agentId,
        `[agent-room] resident agent ${agentId} (via ${path}) has NO provider/model and NO source to take one from ` +
          "(no live session to mirror, nothing persisted, ctx.agentDefaultModel absent) — it CANNOT run a turn",
      );
      return undefined;
    }
    try {
      const options = (agent as unknown as { options?: Record<string, unknown> }).options;
      if (!options) {
        this.activation.noteExecutabilityRepair(false);
        return undefined;
      }
      options.provider = resolved.selection.provider;
      options.model = resolved.selection.model;
    } catch (error) {
      this.activation.noteExecutabilityRepair(false);
      this.warnRateLimited(
        "model-repair-failed:" + agentId,
        `[agent-room] could not set provider/model on resident agent ${agentId} (${String(error)}) — it CANNOT run a turn`,
      );
      return undefined;
    }
    if (!this.agentExecutable(agent)) {
      this.activation.noteExecutabilityRepair(false);
      return undefined;
    }
    this.activation.noteExecutabilityRepair(true);
    this.saveResidentModel(resolved.selection, resolved.source);
    this.diag(
      "resident: model REPAIRED on " + agentId + " (via " + path + ") → provider=" + resolved.selection.provider +
        " model=" + resolved.selection.model + " [source=" + resolved.source + "] — before this it could not run a turn at all",
    );
    return { ...resolved.selection, source: resolved.source };
  }

  /**
   * Watch the resident agent's own error channel (0.1.48).
   *
   * `AgentLoop.throwError` (`dsh-agent-loop/lib/index.js:467`) emits `agent/error` and then
   * throws; `kick()` (`:481-490`) catches and DISCARDS that error. So without this tap, a turn
   * that dies before producing anything — the duty-session-without-a-model case — is
   * completely silent. Structural access, best-effort: an agent view that exposes no `dispatch`
   * simply leaves the executability verdict as the only signal.
   */
  private tapAgentError(agent: AgentLike): void {
    const id = agent.id ?? agent.sessionId ?? "";
    if (!id || this.agentErrorTaps.has(id)) return;
    const bus = (agent as unknown as { dispatch?: { on?: (event: string, handler: (payload: unknown) => void) => void } }).dispatch;
    if (!bus || typeof bus.on !== "function") return;
    this.agentErrorTaps.add(id);
    try {
      bus.on("agent/error", (payload: unknown) => {
        const error = (payload as { error?: unknown } | undefined)?.error;
        const message = error instanceof Error ? error.message : String(error);
        const noModel = /no provider\/model/i.test(message);
        this.activation.noteTurnError(noModel);
        this.warnRateLimited(
          "agent-error:" + id,
          `[agent-room] resident agent ${id} reported a TURN ERROR: ${message}` +
            (noModel
              ? " — THIS IS THE DUTY-SESSION-WITHOUT-A-MODEL DEFECT: the harness refuses the request and kick() swallows the error, so the wake is accepted and never runs"
              : " — the turn was abandoned; activation.turnErrors counts it"),
        );
      });
    } catch { /* bus shape differs — the executability verdict still covers the common case */ }
  }

  /** The agent handle for one id, or undefined (registry `get` first, then the live lists). */
  private agentById(id: string): AgentLike | undefined {
    if (!id) return undefined;
    const agents = this.agentsRegistry();
    try {
      const direct = agents?.get?.(id);
      if (direct) return direct;
    } catch { /* ignore */ }
    try {
      const hit = agents?.list?.()?.find((a) => (a.id ?? a.sessionId) === id);
      if (hit) return hit;
    } catch { /* ignore */ }
    try {
      return agents?.roots?.()?.find((a) => (a.id ?? a.sessionId) === id);
    } catch { /* ignore */ }
    return undefined;
  }

  /**
   * When was the transcript of this session last written (0.1.47)?
   *
   * The `transcript` evidence of "the agent demonstrably started": the harness appends every
   * frame of a turn to `<DSH_HOME>/sessions/<workspace>/<sessionId>/session.jsonl.zstd`
   * (the same file `detectActiveSessionId` stats to follow the boss's session), so an mtime
   * that moved after the dispatch means the turn really ran. Used as the FALLBACK for agent
   * handles that do not expose `status` — it is deliberately not the primary signal, because
   * a transcript write is coarser than the harness's own phase getter.
   *
   * Bounded: one stat per workspace directory, only while a dispatch is in flight, and only
   * for the session id that was actually resolved.
   */
  private sessionActivityMs(sessionId: string): number | undefined {
    if (!sessionId || sessionId.includes("..")) return undefined;
    try {
      const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
      const root = join(dshHome, "sessions");
      let best: number | undefined;
      for (const workspace of readdirSync(root, { withFileTypes: true })) {
        if (!workspace.isDirectory()) continue;
        try {
          const stat = statSync(join(root, workspace.name, sessionId, "session.jsonl.zstd"));
          if (best === undefined || stat.mtimeMs > best) best = stat.mtimeMs;
        } catch { /* this workspace has no such session — not an error */ }
      }
      return best;
    } catch {
      return undefined;
    }
  }

  /* ----------------------- reply-agent persistence ---------------------- */

  /**
   * Which reply agent was remembered (0.1.38).
   *
   * MISSING -> undefined (fall back to auto-selection, unchanged).
   * PRESENT but unparseable -> CorruptConfigError, quarantined first. Previously
   * a BOM'd file silently fell back to auto-selection and the next save wrote
   * over the original.
   */
  private async loadReplyAgentId(): Promise<string | undefined> {
    if (!this.replyAgentFile) return undefined;
    const parsed = await readJsonConfig<{ replyAgentId?: string }>(this.replyAgentFile);
    if (!parsed) return undefined;
    return typeof parsed.replyAgentId === "string" && parsed.replyAgentId ? parsed.replyAgentId : undefined;
  }

  private saveReplyAgentId(agent: AgentLike): void {
    const id = agent.id ?? agent.sessionId;
    if (!id || !this.replyAgentFile) return;
    this.persistedReplyAgentId = id;
    void writeFile(this.replyAgentFile, JSON.stringify({ replyAgentId: id }, null, 2), "utf8").catch(() => { /* non-fatal */ });
  }

  /**
   * Find the boss's active conversation: the session under
   * <DSH_HOME>/sessions/<workspace-of-cwd> whose transcript was most recently
   * written. The session id rotates when the boss starts new chats, so pinning
   * an id is fragile — following the freshest transcript is the robust signal.
   */
  private detectActiveSessionId(): string | undefined {
    try {
      const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
      const root = join(dshHome, "sessions");
      // Workspace session dirs encode the path (verified against the on-disk
      // layout): drive colon is DROPPED, backslash -> "-", and any char outside
      // [A-Za-z0-9_.-] becomes "~" + 4-hex UTF-16 code unit.
      //   "D:\dsh"            -> "--D-dsh--"
      //   "D:\dsh\ITPM\数创港项目" -> "--D-dsh-ITPM-~6570~521B~6E2F~9879~76EE--"
      const encode = (s: string) =>
        s
          .replace(/:/g, "")
          .replace(/[\\/]/g, "-")
          .replace(/[^\w.\-~]/g, (c) => "~" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"));
      const wsName = "--" + encode(process.cwd()) + "--";
      const dir = join(root, wsName);
      const pickFreshest = (base: string): string | undefined => {
        let best: string | undefined;
        let bestTime = 0;
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          try {
            const st = statSync(join(base, entry.name, "session.jsonl.zstd"));
            if (st.mtimeMs > bestTime) {
              bestTime = st.mtimeMs;
              best = entry.name;
            }
          } catch {
            /* session without a transcript yet — skip */
          }
        }
        return best;
      };
      const detail = "cwd=" + process.cwd() + " ws=" + wsName + " dir=" + existsSync(dir);
      // 1. primary: the workspace dir matching this process's cwd
      if (existsSync(dir)) {
        const best = pickFreshest(dir);
        if (best) {
          this.diag("active-session: " + best + " (" + detail + ")");
          return best;
        }
      }
      // 2. fallback: cwd can differ from the boss's workspace (e.g. the web was
      // started from another directory). Scan EVERY workspace dir under
      // <DSH_HOME>/sessions and pick the globally freshest session-* transcript.
      // Prefix filter keeps out spawned helpers (agent-room-duty-*, kanban tasks).
      let globalBest: string | undefined;
      let globalTime = 0;
      for (const ws of readdirSync(root, { withFileTypes: true })) {
        if (!ws.isDirectory()) continue;
        const base = join(root, ws.name);
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
          try {
            const st = statSync(join(base, entry.name, "session.jsonl.zstd"));
            if (st.mtimeMs > globalTime) {
              globalTime = st.mtimeMs;
              globalBest = entry.name;
            }
          } catch {
            /* skip */
          }
        }
      }
      if (globalBest) {
        this.diag("active-session: " + globalBest + " (global fallback, " + detail + ")");
        return globalBest;
      }
      this.diag("active-session: none (" + detail + ")");
      return undefined;
    } catch (err) {
      this.diag("active-session: error " + (err instanceof Error ? err.message : String(err)));
      return undefined;
    }
  }

  /* --------------------------- duty agent (治本) ------------------------ */

  /**
   * Ensure a dedicated "值守" agent session exists and is usable. Its id is
   * deterministic (agent-room-duty-<nodeAgentId>), so restarts re-attach to the
   * SAME session instead of guessing. This makes activate-chat / listening wake
   * independent of the boss's chat sessions — the true root-cause fix.
   */
  private async ensureDutyAgent(): Promise<AgentLike | undefined> {
    const identity = this.roomService.getIdentity();
    if (!identity) return undefined;
    const dutyId = "agent-room-duty-" + identity.agentId;
    const agents = this.agentsRegistry();

    // Re-attach to an existing (restored) duty session first.
    // 0.1.48: re-attaching is NOT success by itself — a duty session restored by the host
    // comes back WITHOUT agentOptions (no provider/model), and such a session can never run a
    // turn. Verified and repaired below, and said out loud if it cannot be repaired.
    try {
      const existing = agents?.get?.(dutyId);
      if (existing && typeof existing.followup === "function") {
        this.dutyAgentId = dutyId;
        this.tapAgentError(existing);
        if (this.agentExecutable(existing)) {
          const model = this.agentModelOf(existing);
          this.diag("duty agent: re-attached " + dutyId + " — EXECUTABLE (provider=" + model.provider + " model=" + model.model + ")");
          this.saveResidentModel({ provider: model.provider!, model: model.model! }, "duty-session-header");
          return existing;
        }
        const repaired = this.repairResidentModel(existing, "duty");
        if (repaired) {
          this.diag("duty agent: re-attached " + dutyId + " and REPAIRED its model (provider=" + repaired.provider + " model=" + repaired.model + ", source=" + repaired.source + ")");
          return existing;
        }
        this.warnRateLimited(
          "duty-not-executable:" + dutyId,
          `[agent-room] duty agent ${dutyId} was restored WITHOUT a provider/model and could not be repaired ` +
            "(no live session to mirror, nothing persisted, ctx.agentDefaultModel absent) — IT CANNOT RUN A TURN; " +
            "activation.residentNoModel counts it",
        );
        // 0.1.49: a RESTORED, unrepairable duty session used to be the end of the road here —
        // and that is the state every machine reaches after its first restart. Ask the host for a
        // session we can actually use before giving up on this resolution.
        const adopted = await this.adoptHostSession();
        if (adopted) return adopted;
        return existing;
      }
    } catch { /* ignore */ }

    // Spawn it on demand.
    if (typeof agents?.create !== "function") {
      this.diag("duty agent: ctx.agents.create unavailable — falling back to heuristic");
      return undefined;
    }
    try {
      // 0.1.48 — THE MODEL MUST COME FROM SOMEWHERE THAT SURVIVES A RESTART.
      //
      // 0.1.46 mirrored provider/model from a live session ONLY, and the mirror loop finds
      // nothing on a machine with no live sessions — the state after every restart. The duty
      // session was therefore created with EMPTY agentOptions, and the harness refuses to
      // propose a request without provider/model (`dsh-agent-loop/lib/index.js:714`), while
      // `kick()` swallows the resulting error (`:481-490`): the wake was accepted and never
      // ran. Sources now, in order of evidence: live session → persisted file → the host's own
      // default (`ctx.agentDefaultModel.currentSelection()`, the same source every host
      // create/resume path uses).
      const resolvedModel = this.resolveModelSelection();
      const provider = resolvedModel?.selection.provider;
      const model = resolvedModel?.selection.model;
      if (!resolvedModel) {
        this.warnRateLimited(
          "duty-no-model-source:" + dutyId,
          `[agent-room] spawning the duty agent ${dutyId} WITHOUT a provider/model — no live session to mirror, ` +
            "nothing persisted, and ctx.agentDefaultModel is absent. The session will be created but it CANNOT run " +
            "a turn (activation.residentNoModel will count every wake that lands on it)",
        );
      } else {
        this.diag("duty agent: model source = " + resolvedModel.source + " (provider=" + provider + " model=" + model + ")");
        this.saveResidentModel(resolvedModel.selection, resolvedModel.source);
      }
      const handle = await agents.create({
        sessionId: dutyId,
        meta: { cwd: process.cwd() },
        agentOptions: {
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        },
        setup(agentCtx) {
          try {
            agentCtx?.systemPrompt?.section?.({
              name: "agent-room:duty",
              order: 50,
              text:
                "你是 agent-room 的「值守」agent：保持空闲，只响应来自插件 followup 的指令。" +
                "收到激活聊天/监听唤醒的指令时，按指令用 room_send 工具回复对应房间；" +
                "指令说不需要回应时，不要调用任何工具。不要主动闲聊。",
            });
          } catch {
            /* systemPrompt section is best-effort */
          }
          // Make the room tools (room_* / task_*) available inside this spawned
          // session — spawned sessions do not inherit host-registered tools.
          try {
            agentCtx?.plugin?.(toolsPlugin);
          } catch {
            /* tool mounting is best-effort; room replies fall back to HTTP via pwsh */
          }
        },
      });
      const agent = handle?.agent;
      if (agent && typeof agent.followup === "function") {
        this.dutyAgentId = dutyId;
        this.saveReplyAgentId(agent);
        this.tapAgentError(agent);
        // 0.1.48: NEVER report a spawn as a success without checking that the session can run.
        if (!this.agentExecutable(agent)) {
          const repaired = this.repairResidentModel(agent, "duty");
          if (!repaired) {
            this.activation.noteResidentExecutability(false);
            this.warnRateLimited(
              "duty-spawned-no-model:" + dutyId,
              `[agent-room] duty agent ${dutyId} was SPAWNED WITHOUT a provider/model (and could not be repaired) — ` +
                "the harness refuses the request (dsh-agent-loop/lib/index.js:714) and kick() swallows the error, " +
                "so every wake handed to it is accepted and NEVER RUNS (activation.residentNoModel counts it)",
            );
            // 0.1.48 last mile: ask the HOST for a real session, which is the only path that
            // carries a model selection on a machine where every other source is empty.
            const adopted = await this.adoptHostSession();
            if (adopted) return adopted;
            return agent;
          }
          this.diag("duty agent: spawned " + dutyId + " and repaired its model → " + repaired.provider + "/" + repaired.model);
          return agent;
        }
        const spawnedModel = this.agentModelOf(agent);
        this.activation.noteResidentExecutability(true);
        this.diag("duty agent: spawned " + dutyId + " — EXECUTABLE (provider=" + spawnedModel.provider + " model=" + spawnedModel.model + ")");
        return agent;
      }
    } catch (error) {
      this.diag("duty agent: spawn failed — " + String(error));
    }
    return undefined;
  }

  /**
   * Ask the host for a real session and, if it is already registered, use it right away (0.1.49).
   *
   * Both duty-session branches need this: the restored one (the state every machine reaches after
   * a restart) and the freshly spawned one. Bounded by `createHostSession` itself — once per
   * process, never retried.
   */
  private async adoptHostSession(): Promise<AgentLike | undefined> {
    const hostSessionId = await this.createHostSession();
    if (!hostSessionId) return undefined;
    const hostAgent = this.agentById(hostSessionId);
    if (hostAgent && typeof hostAgent.followup === "function") {
      this.tapAgentError(hostAgent);
      this.diag("duty agent: using the host-created session " + hostSessionId + " as the resident agent instead");
      return hostAgent;
    }
    this.diag(
      "duty agent: the host-created session " + hostSessionId + " is not in the registry yet — it will be " +
        "picked up by the active-session detection on the next resolution",
    );
    return undefined;
  }

  /**
   * Build the activate-chat prompt for one room (0.1.47: extracted so the 0.1.47
   * self-escalation uses the SAME prompt this method has always built — "the equivalent of
   * activate-chat" must mean the same words, or the two paths could drift and the
   * escalation would be a different, weaker thing wearing the same name).
   */
  private async buildActivatePromptFor(roomId: string, identity: AgentIdentity): Promise<string> {
    const owned = this.roomService.getOwnedRoom(roomId);
    const client = this.clients.get(roomId);
    const room = owned ?? client?.snapshot?.room;
    if (!room) throw new Error(`房间不存在: ${roomId}`);
    const [recent, tasks] = await Promise.all([
      this.recentMessagesFor(roomId, 3),
      Promise.resolve(room.tasks),
    ]);
    const member = room.members.find((m) => m.agentId === identity.agentId);
    const role = member?.roles?.length ? member.roles.join("、") : member?.role ?? "member";
    return buildActivatePrompt({
      roomId,
      title: room.title,
      identity,
      role,
      recent,
      tasks,
    });
  }

  /**
   * Hand one prompt to a resident agent, and REPORT what actually happened (0.1.47).
   *
   * WHY THIS WRAPPER EXISTS: `agent.followup` cannot fail visibly. Its implementation is
   * `followup(input) { this.send(input, "next-turn", true); }`
   * (`dsh-agent-loop/lib/index.js:396`), it returns `undefined`, and `wakeDriver` returns
   * EARLY — doing nothing — whenever the agent is not idle (`:444`). So the only two facts
   * obtainable at this boundary are "it returned" and "it threw", and until 0.1.47 the
   * second one was indistinguishable from the first for an operator: 小麦's log ends at
   * `dispatching followup …` with no line after it, and there was no counter anywhere that
   * moved. This wrapper makes the boundary explicit: `accepted` (returned — which means the
   * message reached the agent's INBOX and nothing more) vs `refused` (threw — nothing was
   * handed over at all), each counted and each with its own log line.
   *
   * @returns true when the call returned without throwing.
   */
  private dispatchFollowup(
    roomId: string,
    seq: number,
    agent: AgentLike,
    prompt: string,
    kind: "wake" | "escalate" | "activate",
  ): boolean {
    const agentId = agent.id ?? agent.sessionId ?? "unknown";
    if (typeof agent.followup !== "function") {
      this.activation.noteFollowupRefused(roomId, seq);
      this.diag(kind + ": followup REFUSED for " + roomId + " seq=" + seq + " — agent " + agentId + " has no followup method (nothing was handed over)");
      return false;
    }
    try {
      agent.followup(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "plugin", plugin: "dsh-agent-room" } }));
    } catch (error) {
      this.activation.noteFollowupRefused(roomId, seq);
      // Rate-limited by key, not suppressed: this is exactly the silent stop of 小麦.
      this.warnRateLimited(
        "followup-refused:" + roomId,
        `[agent-room] ${kind}: followup REFUSED for ${roomId} seq=${seq} agent=${agentId} (${String(error)}) — ` +
          "NOTHING was handed to the agent; activation.followupRefused counts it",
      );
      return false;
    }
    return true;
  }

  /** Build the context prompt and drive the resident agent. Thinking is kept
   *  until our own reply lands (noteOwnReply) or the flow fails explicitly. */
  private async runActivateChat(roomId: string, identity: AgentIdentity, agent: AgentLike): Promise<void> {
    const agentId = agent.id ?? agent.sessionId ?? "unknown";
    try {
      const prompt = await this.buildActivatePromptFor(roomId, identity);
      this.diag("activate-chat: dispatching followup for " + roomId + " to agent " + agentId);
      agent.followup?.(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "plugin", plugin: "dsh-agent-room" } }));
      this.diag("activate-chat: followup accepted for " + roomId + " — thinking stays on until own reply lands");
      this.armActivateWatchdog(roomId);
    } catch (error) {
      this.failActivate(roomId, "激活聊天失败: " + String(error));
    }
  }

  /** Clear thinking + notify the UI (stderr log + browser events) because the
   *  activate-chat flow failed or timed out without a reply. */
  private failActivate(roomId: string, message: string): void {
    if (!this.activateThinkingRooms.has(roomId)) return;
    this.diag("activate-chat: FAIL for " + roomId + " — " + message);
    this.clearActivateTimer(roomId);
    this.activateThinkingRooms.delete(roomId);
    this.emitBrowser({ kind: "activate-error", roomId, message });
    this.emitBrowser({ kind: "state" });
  }

  /** Safety net: if the agent never replies, stop waiting so the button does
   *  not stay disabled forever. */
  private static readonly ACTIVATE_REPLY_TIMEOUT_MS = 5 * 60 * 1000;
  private readonly activateTimers = new Map<string, NodeJS.Timeout>();

  private armActivateWatchdog(roomId: string): void {
    this.clearActivateTimer(roomId);
    const timer = setTimeout(() => {
      this.activateTimers.delete(roomId);
      this.failActivate(roomId, "激活聊天超时（" + AgentRoomService.ACTIVATE_REPLY_TIMEOUT_MS / 1000 + "s 内未收到本机回复）");
    }, AgentRoomService.ACTIVATE_REPLY_TIMEOUT_MS);
    try { timer.unref(); } catch { /* not available in all envs */ }
    this.activateTimers.set(roomId, timer);
  }

  private clearActivateTimer(roomId: string): void {
    const timer = this.activateTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.activateTimers.delete(roomId);
    }
  }

  /**
   * Detect the end of an activate-chat thinking: once OUR OWN message (sent via
   * room_send) shows up in the room stream, the reply has landed — clear the
   * thinking state so the button becomes clickable again.
   */
  private noteOwnReply(roomId: string, message: ChatMessage): void {
    const identity = this.roomService.getIdentity();
    // ---------------------------------------------------------------------
    // 0.1.47/0.1.48: OUTPUT EVIDENCE, recorded BEFORE the thinking-state early return below (a
    // listening wake has no thinking state, so a check after it would never fire for the
    // case this whole release is about).
    //
    // TWO DELIBERATE EXCLUSIONS, both of which would otherwise manufacture a false
    // "the machine is working" signal:
    //   - `[ack]` / `[ack-miss]` frames are written by THIS PLUGIN, not by the model, and
    //     the receipt lands BEFORE the agent has done anything (0.1.46 `postAckReceipt`).
    //     Counting them would make every silent machine look productive — the exact class
    //     of "signal narrower than the claim" this release exists to end.
    //   - `[org:*]` control frames are bus traffic echoed into the room by our own node. THIS
    //     ONE IS NOT HYPOTHETICAL (D-37, measured): `own reply landed (seq=4436/4477/4420/4489)`
    //     on 小黄 and 小婷 were ALL `[org:exec:result]` frames, and they are the reason two
    //     machines with ZERO real messages were recorded as healthy. From 0.1.48 such frames
    //     are COUNTED (`activation.controlFramesIgnored`) and NAMED in one rate-limited line,
    //     so the misreading can never happen silently again.
    // Only a message this node authored that is neither of those is the agent speaking.
    // ---------------------------------------------------------------------
    const controlFrame = isControlFrame(message.text);
    const ackFrame = isAckPlaneFrame(message.text);
    const ownFrame = Boolean(identity && message.from === identity.agentId);
    if (ownFrame && (controlFrame || ackFrame)) {
      this.activation.noteControlFrameIgnored();
      this.warnRateLimited(
        "own-frame-ignored:" + roomId,
        `[agent-room] own frame in ${roomId} (seq=${message.seq}) is ${controlFrame ? "an [org:*] control frame" : "an [ack] receipt"} — ` +
          "NOT the agent speaking: it is not counted as output and does not end a thinking state " +
          "(activation.controlFramesIgnored counts it; D-37: this misreading marked two silent machines healthy)",
      );
    } else if (ownFrame && !isAckPlaneFrame(message.text) && !isControlFrame(message.text)) {
      // The literals above are kept inline ON PURPOSE: 0.1.47's own static guard matches them
      // (`test/wake-activation.test.mjs`, "the [ack] receipt must never count as model output"),
      // and weakening a shipped regression lock to save a variable would be the wrong trade.
      for (const done of this.activation.noteOutput(roomId, message.seq)) {
        if (done.reason !== "output") continue;
        this.diag(
          "listening: OWN OUTPUT landed in " + roomId + " (seq=" + message.seq + " after the wake at seq=" +
            done.seq + ", waited " + Math.round(done.waitedMs / 1000) + "s) — the chain reached its last step",
        );
      }
    }
    if (!this.activateThinkingRooms.has(roomId)) return;
    // The thinking state is cleared only by a REAL chat message from this node — never by a
    // machine echo (D-37), which is what made a broken machine look like it had replied.
    if (ownFrame && !controlFrame && !ackFrame) {
      this.diag("activate-chat: own reply landed in " + roomId + " (seq=" + message.seq + ") — thinking done");
      this.clearActivateTimer(roomId);
      this.activateThinkingRooms.delete(roomId);
      this.emitBrowser({ kind: "state" });
    }
  }

  /* --------------------------- listening (监听) -------------------------- */

  /** True while the local agent is listening to this room. */
  isListening(roomId: string): boolean {
    return this.listeningRooms.has(roomId);
  }

  /**
   * Turn listening on/off for a room. On: catch up immediately.
   *
   * 0.1.42: the intent is PERSISTED on the way out (see `persistListening`), so
   * a restart restores it instead of silently muting the machine. The write
   * happens only here — inside the toggle the HTTP route calls AFTER it decided
   * to answer `ok: true` (web.ts) — so a rejected request never records an
   * intent that did not take effect.
   */
  setListening(roomId: string, on: boolean): void {
    if (on) {
      this.listeningRooms.add(roomId);
      // Reset the cursor; the sweep initializes it from the current tail on its
      // first pass, so old history never re-triggers a wake.
      this.listenSeen.delete(roomId);
      void this.sweepListening();
    } else {
      this.listeningRooms.delete(roomId);
      this.listenPending.delete(roomId);
      this.listenSeen.delete(roomId);
    }
    this.persistListening();
    this.emitBrowser({ kind: "state" });
  }

  /**
   * Write the listening intent for THIS node (0.1.42).
   *
   * Serialized through one promise chain per node: two toggles in the same tick
   * would otherwise race inside the atomic writer and could leave the file
   * describing the OLDER set — i.e. resurrect a listening flag the operator had
   * just switched off at the next restart.
   */
  private persistListening(): void {
    if (!this.listeningFile) return;
    const snapshot = [...this.listeningRooms];
    const file = this.listeningFile;
    this.listeningSave = this.listeningSave
      .then(() => writeFile(file, JSON.stringify({ rooms: snapshot }, null, 2), "utf8"))
      .catch((error) => {
        // A failed save must not take the room loop down, but it must be visible:
        // a machine that believes it will come back listening and will not is
        // exactly the silent failure this release removes.
        this.warnRateLimited(
          "listening-save",
          `[agent-room] failed to persist the listening intent to ${file}: ${String(error)}`,
        );
      });
  }

  /**
   * Restore the listening intent recorded by a previous process (0.1.42, corrected
   * in 0.1.44).
   *
   * Deliberate and self-contained: no upgrade script and no外部 helper has to
   * POST anything for a machine to come back listening. A room whose joined record
   * is gone is skipped by `loadListeningIntent()` — the intent follows the
   * membership exactly like the wake plane's own per-room state does.
   *
   * 0.1.44 / D-28 — OWNED ROOMS ARE RESTORED TOO. Until 0.1.43 this loop actively
   * skipped them ("an owned room is served here, so listening has no meaning"), and
   * that reasoning is wrong on both counts:
   *   * the browser DOES offer the 监听 toggle for a room this node owns — the chat
   *     composer renders it for every room (client.js, `onToggleListening`) and
   *     `POST /agent-room-api/rooms/<id>/listening` accepts an owned room, so a
   *     human can and does switch it on;
   *   * listening is what makes THIS machine wake its own agent, which is exactly
   *     what the room owner needs: the owner is the single point the whole room's
   *     instructions land on (D-11).
   * The field consequence was measured the same night 0.1.43 shipped: 小婷, the room
   * OWNER, came back `listening=false` after every restart, because her
   * `listening.json` records the room she OWNS; only the upgrade script's helper step
   * re-opened her (`1 of 1 room(s) re-opened (listening=true); 0 were already on`),
   * i.e. the plugin itself restored nothing. The room owner goes mute on every
   * restart until someone re-opens it by hand.
   *
   * Nothing is ever auto-enabled: only what was explicitly turned on comes back, which
   * is what keeps an explicit OFF off after a restart (the OFF writes `{rooms: []}`,
   * so there is nothing here to restore), and a missing/invalid file still degrades
   * quietly to "nothing remembered" (persistence.loadListening never throws).
   */
  private async restoreListening(): Promise<void> {
    const recorded = await this.roomService.loadListeningIntent();
    if (recorded.length === 0) return;
    let restored = 0;
    let owned = 0;
    for (const roomId of recorded) {
      // Owned or joined: both are served by the same wake plane (`sweepListening`),
      // and both are toggled by the same route, so both are restored the same way.
      this.listeningRooms.add(roomId);
      restored += 1;
      if (this.roomService.getOwnedRoom(roomId)) owned += 1;
      this.ctx.logger?.info?.("[agent-room] listening restored for room %s (persisted intent)", roomId);
    }
    this.ctx.logger?.info?.(
      "[agent-room] listening intent restored: %d listening (%d of them owned here), %d on record",
      restored, owned, recorded.length,
    );
  }

  /**
   * 监听扫描（省钱三层里的第 1 层，0 token）:
   * 对每个监听房间拉最近消息, 用规则过滤出「值得叫醒 agent」的消息:
   *   - 人类发言 → 必醒（远程指挥通道）
   *   - @了我 / 疑似问题(？?吗呢谁能有没有怎么办帮) → 醒
   *   - 自己的消息、闲聊、系统通知 → 忽略
   * 同一 seq 只处理一次（listenSeen 去重）。
   */
  private async sweepListening(): Promise<void> {
    const identity = this.roomService.getIdentity();
    if (!identity) return;
    for (const roomId of [...this.listeningRooms]) {
      if (this.listenPending.has(roomId)) {
        // 0.1.45 (小捷's review, seq 3728 §4): this skip used to be invisible. A
        // message that arrives inside this window is not refused by the RULE — it is
        // never seen by the sweep — so it left no `denied` line and no counter.
        // Counting it (and saying so once per skip) is what makes "nothing woke me"
        // provable rather than inferred.
        this.wakeWatermark.notePendingSkip();
        this.diag("listening: sweep skipped in " + roomId + " (rule=pending, a wake from the previous sweep is still in flight)");
        continue;
      }
      try {
        const recent = await this.recentMessagesFor(roomId, WAKE_WINDOW_ROWS);
        if (recent.length === 0) continue;
        const lastSeq = recent[recent.length - 1]!.seq;
        const seen = this.listenSeen.get(roomId);
        if (seen === undefined) {
          // First sweep for this room: start from the current tail and process
          // nothing — history must never re-trigger a wake. 0.1.45: said out loud
          // once per room (design, not a defect) instead of silently skipped.
          this.listenSeen.set(roomId, lastSeq);
          this.wakeWatermark.noteSeedSkip();
          this.diag("listening: seeded cursor at seq=" + lastSeq + " in " + roomId + " (rule=seed, history is not an instruction; a message posted during this instant is not a candidate)");
          continue;
        }
        const fresh = recent.filter((m) => m.seq > seen);
        // 0.1.45 (小黄's review, seq 3729): the read window is FINITE, so messages
        // that fall outside it are never candidates at all — neither woken nor
        // denied. Measured on this fleet: 152 control frames arrived in ~3 minutes
        // while an exec storm was running, i.e. the old 20-row window covered < 30 s,
        // less than one sweep period. The window is therefore widened to
        // WAKE_WINDOW_ROWS, and any residue is COUNTED and NAMED here rather than
        // left to be discovered by a transcript expedition.
        const missed = lastSeq - seen - fresh.length;
        if (missed > 0) {
          this.wakeWatermark.noteWindowGap(missed);
          this.diag(
            "listening: window gap in " + roomId + ": " + missed + " message(s) between seq=" + (seen + 1) +
              " and seq=" + lastSeq + " were never candidates (read window=" + WAKE_WINDOW_ROWS + " rows)",
          );
        }
        // 0.1.41: the cursor only ever ADVANCES. `lastSeq` is the tail of THIS
        // node's window, so it regresses whenever the local mirror
        // falls behind the owner — the old unconditional write lowered the cursor
        // and made already-woken seqs "fresh" again (the root cause of card 04).
        if (lastSeq > seen) this.listenSeen.set(roomId, lastSeq);
        if (fresh.length === 0) continue;
        // 0.1.45: the rule needs this node's OWN identity. There is deliberately NO
        // "author is the controller" input: the shipped rule has no author-based
        // admission at all (see the header of src/host/wake.ts — 小捷's room seq 3728
        // measured 24 wasted wakes/day for that clause, and "is this a dispatch"
        // cannot be inferred from who wrote it).
        const self: WakeRuleSelf = { agentId: identity.agentId, nickname: identity.nickname };
        const denials: Array<{ message: ChatMessage; reason: WakeReason }> = [];
        const pick = this.pickListenTarget(fresh, self, (denied, decision) => {
          this.wakeWatermark.noteDenied(decision.reason); // exact, per message, per rule
          denials.push({ message: denied, reason: decision.reason });
        });
        this.logDenials(roomId, denials);
        if (!pick) continue;
        // 0.1.41: measure the channel that CANNOT be verified at this layer. Every
        // admitted wake is a remote author CLAIMING `human: true` (the wire carries
        // no provenance), so the claim count is what says how much of the remote-
        // command channel rests on an unverifiable flag.
        for (const m of fresh) {
          if (listenAuthorKind(m, identity.agentId) === "human") this.wakeWatermark.noteHumanClaim();
        }
        this.listenPending.add(roomId);
        void this.runListenWake(roomId, identity, pick);
      } catch (error) {
        this.diag("listening: sweep error for " + roomId + " — " + String(error));
      }
    }
  }

  /**
   * Report one sweep's denials. NOTHING is silent — but not everything is a line.
   *
   * POLICY, and why it is not "one line per message":
   *   - `not-addressed` and `self-authored` are the reasons a REAL chat message gets
   *     refused, i.e. exactly the traceability this version exists for. They get one
   *     line per message, capped at MAX_NAMED_DENIALS_PER_SWEEP per sweep (the rest
   *     are named by their count, and every one of them is still counted per rule in
   *     /state — the count is exact, only the naming is capped).
   *   - `control-frame` and `machine-frame` are bus traffic that is not a dispatch by
   *     construction, and their volume is NOT under any chat's control: measured 152
   *     `[org:*]` frames in ~3 minutes during one exec storm (and 2172-3400 per member
   *     over the room's whole history). Naming each of them individually is the
   *     411 MB incident in a new hat, so they are reported as ONE aggregate line per
   *     rule per sweep, carrying the count and either the exact seqs (≤5) or the range.
   *   Every rule therefore leaves a trace each sweep, and `/state.wake` counts exactly
   *   how many messages each rule refused.
   */
  private logDenials(roomId: string, denials: Array<{ message: ChatMessage; reason: WakeReason }>): void {
    let named = 0;
    let suppressed = 0;
    const aggregate = new Map<WakeReason, number[]>();
    for (const { message, reason } of denials) {
      if (reason === "control-frame" || reason === "machine-frame") {
        const list = aggregate.get(reason) ?? [];
        list.push(message.seq);
        aggregate.set(reason, list);
        continue;
      }
      if (named < MAX_NAMED_DENIALS_PER_SWEEP) {
        named += 1;
        this.diag(
          "listening: denied seq=" + message.seq + " (rule=" + reason + ", from=" +
            message.fromNickname + "/" + message.from + ") in " + roomId,
        );
      } else {
        suppressed += 1;
      }
    }
    for (const [reason, seqs] of aggregate) {
      const shown = seqs.length <= 5 ? "seq=" + seqs.join(",") : "seq=" + seqs[0] + ".." + seqs[seqs.length - 1];
      this.diag("listening: denied " + seqs.length + " message(s) (rule=" + reason + ", " + shown + ") in " + roomId);
    }
    if (suppressed > 0) {
      this.diag(
        "listening: denied " + suppressed + " more message(s) (rules=not-addressed/self-authored, newest " +
          MAX_NAMED_DENIALS_PER_SWEEP + " already named above) in " + roomId,
      );
    }
  }

  /** Rule layer: which of the fresh messages deserves a wake-up. */
  /**
   * Rule layer: who deserves a wake-up (0.1.45).
   *
   * HISTORY, because this function is where the defect lived:
   *
   *   ≤0.1.40 — `if (fresh[i].human) return fresh[i];` — `human` was the whole rule.
   *   0.1.41  — the authorship check was added on top (card ④: a node must not wake
   *             for its own message), but `human` remained the ONLY admission, and
   *             only the `self` branch reported anything:
   *
   *               if (kind === "human") return message;
   *               if (kind === "self") onSkip?.(message, "self-authored");
   *               // kind === "agent" → falls out of the loop, silently
   *
   *             That last line is the ~2-hour incident of 2026-09-15: our own
   *             dispatch path (`human = $false`, `sendFallbackLine`) classified as
   *             `agent`, woke nobody, and logged nothing. The target could not even
   *             prove it had not been woken.
   *
   *   0.1.45  — the decision moves to `decideListenWake` (src/host/wake.ts), which
   *             admits a message that NAMES this node (or comes from the room's
   *             controller), keeps `human` as a fallback, refuses control frames and
   *             machine self-test stamps, and RETURNS A REASON FOR EVERY OUTCOME.
   *             The caller cannot drop a message without naming the rule: `onSkip`
   *             fires for every denied candidate.
   */
  private pickListenTarget(
    fresh: ChatMessage[],
    self: WakeRuleSelf,
    onSkip?: (message: ChatMessage, decision: WakeDecision) => void,
  ): { message: ChatMessage; decision: WakeDecision } | undefined {
    for (let i = fresh.length - 1; i >= 0; i--) {
      const message = fresh[i]!;
      const decision = decideListenWake({ message, self });
      if (decision.wake) return { message, decision };
      onSkip?.(message, decision);
    }
    return undefined;
  }

  /**
   * SENDER-SIDE wake preview (0.1.45, requirement 4): "delivered" must never again
   * be readable as "acted on".
   *
   * Until this existed, a poster's only receipt was `acceptedByLocalHub` /
   * `confirmedByOwner` — both of which were TRUE for the questionnaire (seq 3267)
   * and the reminder (seq 3606) that woke nobody on three of four machines. The
   * sender's own store even confirmed them; the target's wake plane never saw them.
   *
   * The computation is the SAME rule the receivers run (`decideListenWake`), applied
   * per room member with that member as the decision's `self`. One rule, two callers
   * — they cannot drift, which is the only reason a prediction is worth reporting.
   *
   * HONEST BOUND (repeated in the returned `note`): this node has no channel that
   * observes a remote node's wake plane, so this is a prediction over THIS node's
   * room view (roster + `controllerAgentId` + each member's nickname). It is wrong
   * only for targets that are offline or have listening OFF. A delivered RECEIPT
   * needs the ack plane, which 0.1.45 does not ship (小捷's option C, seq 3704 §Q6).
   */
  private wakePreviewFor(
    roomId: string,
    input: { text: string; mentions?: string[]; human?: boolean },
  ): WakePreview {
    const note =
      "0.1.45 rule-predicted from THIS node's room view: a target that is offline, or that has " +
      "listening OFF, will not actually wake — read woken:0 as 'this post addresses nobody'. " +
      "0.1.46: the RECEIPT for this prediction is `ack.{ackedTargets,unackedTargets}` in /state " +
      "plus one `[ack] <target> 已接手 seq=N` line per machine that really took it";
    const hits = this.wakeTargetsFor(roomId, input);
    return { woken: hits.length, targets: hits.map((h) => h.agentId), reasons: hits.map((h) => h.reason), note };
  }

  /**
   * Who does this post address, per the SAME rule the receivers run? One implementation,
   * two callers (`wakePreviewFor` for the sender's `woken` count, `registerAckExpectation`
   * for the receipt tracking), so the prediction and the thing it is checked against can
   * never disagree about WHO was addressed.
   */
  private wakeTargetsFor(
    roomId: string,
    input: { text: string; mentions?: string[]; human?: boolean },
  ): Array<{ agentId: string; nickname: string; reason: WakeReason }> {
    const identity = this.roomService.getIdentity();
    const room = this.roomService.getOwnedRoom(roomId) ?? this.clients.get(roomId)?.snapshot?.room;
    if (!identity || !room) return [];
    // The message as the rule would see it once the owner stores it: the author is
    // THIS node, and `mentions` may still be nicknames (the owner resolves them).
    const message = {
      text: input.text,
      mentions: input.mentions,
      human: input.human,
      from: identity.agentId,
      fromNickname: identity.nickname,
    };
    const hits: Array<{ agentId: string; nickname: string; reason: WakeReason }> = [];
    for (const member of room.members ?? []) {
      // Card ④ by construction: the author is never one of its own targets. The
      // rule would deny it anyway (`self-authored`); skipping here keeps the
      // reported count about OTHER nodes only.
      if (member.agentId === identity.agentId) continue;
      const decision = decideListenWake({
        message,
        self: { agentId: member.agentId, nickname: member.nickname },
      });
      if (decision.wake) hits.push({ agentId: member.agentId, nickname: member.nickname, reason: decision.reason });
    }
    return hits;
  }

  /**
   * Open a sender expectation so this node can tell "arrived at a machine" from
   * "dispatched" (0.1.46 requirement 3/4).
   *
   * Called from the ONE place every send path funnels through (`gateway.sendChat`, used
   * by `POST /rooms/<id>/chat` and by the `room_send` tool), i.e. it cannot be forgotten
   * by a new caller. Registered only when the post has a real owner-assigned seq AND the
   * rule predicted at least one target — an unaddressed post has nobody to receipt, and a
   * still-queued frame carries a NEGATIVE local seq that no receipt could ever match.
   */
  private registerAckExpectation(
    roomId: string,
    input: { text: string; mentions?: string[]; human?: boolean },
    seq: number | undefined,
  ): void {
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) return;
    const targets = this.wakeTargetsFor(roomId, input);
    if (targets.length === 0) return;
    const opened = this.ackLedger.expect(roomId, seq, targets);
    if (!opened) {
      this.diag("ack: expectation for seq=" + seq + " in " + roomId + " NOT tracked (cap or no targets)");
      return;
    }
    this.diag(
      "ack: expecting receipts for seq=" + seq + " in " + roomId + " from " +
        targets.map((t) => t.nickname).join("/") + " (window=" + ACK_WINDOW_MS + "ms)",
    );
  }

  /** Wake the resident agent for a message that passed the rule layer. The
   *  prompt tells it to act ONLY when needed — otherwise stay silent (this is
   *  the cheap judge + executor in one call; a separate small-model judge is a
   *  v2 optimization). */
  private async runListenWake(
    roomId: string,
    identity: AgentIdentity,
    pick: { message: ChatMessage; decision: WakeDecision },
  ): Promise<void> {
    const message = pick.message;
    // 0.1.47: the resolution now reports WHICH path won (or that none did). Before this,
    // "why is this machine silent" was answerable only by grepping this machine's log.
    const trace: ResolutionTrace = {};
    const agent = await this.resolveResidentAgent(identity, trace);
    if (!agent) {
      // ---------------------------------------------------------------------
      // 0.1.47 — 小黄's failure, NAMED AND COUNTED.
      //
      // This branch already logged one line in 0.1.45, and that line was not enough: on
      // 小黄 the log said `active-session: session-7f81275b… (global fallback, … dir=false)`
      // and `registry dump — detected=session-7f81275b… list=[] roots=[]`, and NOTHING ELSE.
      // The machine was structurally unable to accept work, and the only way to know was to
      // read its log — while `/state` (the thing every sender actually polls) showed a
      // perfectly healthy node. Now: `activation.noResidentAgent` and
      // `activation.resolvedViaNone` move, `activation.lastResidentOk` goes to 0, and the
      // line names the resolution path that failed.
      //
      // NOT marked: nothing was handed to anyone, and marking here would swallow this seq
      // forever without ever having woken a single agent (0.1.45's own rule).
      // ---------------------------------------------------------------------
      this.activation.noteResident("none");
      this.activation.noteNoResident();
      this.diag(
        "listening: NO RESIDENT AGENT for " + roomId + " seq=" + message.seq +
          " — the rule ADMITTED this wake and this machine cannot accept it (resolution=" +
          (trace.detail ?? "unknown") + "); activation.noResidentAgent/resolvedViaNone count it",
      );
      this.warnRateLimited(
        "no-resident:" + roomId,
        `[agent-room] listening: this machine has NO resident agent to wake for ${roomId} ` +
          `(seq=${message.seq}, resolution=${trace.detail ?? "unknown"}) — a rule-admitted wake was ` +
          "therefore NOT delivered; activation.noResidentAgent counts it and activation.resolvedViaNone " +
          "says which resolution path failed",
      );
      this.listenPending.delete(roomId);
      return;
    }
    const agentId = agent.id ?? agent.sessionId ?? "unknown";
    this.activation.noteResident(trace.path ?? "none");
    // ---------------------------------------------------------------------
    // 0.1.48 — CAN THIS AGENT RUN A TURN AT ALL? Asked BEFORE anything is claimed.
    //
    // This is the question that was never asked, and its absence cost two machines a day:
    // a duty session spawned with empty `agentOptions` has no provider/model, the harness
    // refuses to propose a request for it (`dsh-agent-loop/lib/index.js:714`) and `kick()`
    // swallows the resulting error (`:481-490`). The wake was "accepted" and never ran.
    // ---------------------------------------------------------------------
    const executable = trace.executable ?? this.agentExecutable(agent);
    this.activation.noteResidentExecutability(executable);
    if (!executable) {
      this.diag(
        "listening: resident agent " + agentId + " has NO provider/model — the harness throws at request " +
          "proposal (dsh-agent-loop/lib/index.js:714) and kick() swallows it, so THIS TURN CANNOT RUN " +
          "(activation.residentNoModel counts it; resolution=" + (trace.detail ?? "unknown") + ")",
      );
      this.warnRateLimited(
        "no-model-wake:" + roomId,
        `[agent-room] listening: the resident agent ${agentId} for ${roomId} has no provider/model — ` +
          "a wake handed to it will be accepted and never run; activation.residentNoModel counts it",
      );
    }
    try {
      // ---------------------------------------------------------------------
      // 0.1.41 wake-plane dedupe — THE WIRING THE DEFECT WAS MISSING.
      //
      // The guard sits HERE, on the boundary that calls `agent.followup`, because
      // that call is what turns one room message into a brand-new inbox message id:
      // nothing downstream can ever collapse "the same room message woke me twice"
      // (card 04 §2.1 E3). One `(roomId, seq)` wakes this node at most once, EVER —
      // monotonic and non-expiring, because the regression span this defect is made
      // of has no upper bound, so no finite TTL is provably long enough.
      // ---------------------------------------------------------------------
      if (this.wakeWatermark.seen(roomId, message.seq)) {
        // Self-describing on purpose: reconstructing this defect once took 142
        // transcripts / 415,737 frames. The volume is structurally bounded (the
        // 30 s sweep plus the 60 s re-arm cap the boundary at ~1 entry/room/90 s,
        // ≤128 rooms), so this needs no rate limit — unlike the per-frame logging
        // that once grew an audit file to 411 MB.
        this.diag("listening: skipped seq=" + message.seq + " (dedupe) in " + roomId);
        return;
      }
      const owned = this.roomService.getOwnedRoom(roomId);
      const client = this.clients.get(roomId);
      const room = owned ?? client?.snapshot?.room;
      if (!room) throw new Error(`房间不存在: ${roomId}`);
      const recent = await this.recentMessagesFor(roomId, 6);
      const prompt = buildListenPrompt({
        roomId,
        title: room.title,
        identity,
        message,
        recent,
      });
      if (!agent.followup) {
        // Nothing was dispatched, so nothing may be marked: marking here would
        // swallow this seq forever without ever having woken anyone.
        // 0.1.47: and it is COUNTED, because "the resident agent cannot be handed anything"
        // used to be a log line that moved no number at all.
        this.activation.noteFollowupRefused(roomId, message.seq);
        this.diag(
          "listening: resident agent " + agentId + " has NO followup method — not waking seq=" +
            message.seq + " in " + roomId + " (activation.followupRefused counts it)",
        );
        return;
      }
      this.diag(
        "listening: woken seq=" + message.seq + " in " + roomId + " (from=" + message.fromNickname +
          (message.human ? ", human" : "") + ", rule=" + pick.decision.reason +
          (pick.decision.detail ? ", " + pick.decision.detail : "") + ", agent=" + agentId +
          ", via=" + (trace.path ?? "unknown") + ")",
      );
      // 0.1.47: open the activation window BEFORE the call, so a followup that throws is
      // still escalated (a refusal is not a start) and the two outcomes of the call can be
      // told apart from `/state`.
      if (!this.activation.noteDispatch(roomId, message.seq)) {
        this.diag(
          "listening: activation NOT tracked for seq=" + message.seq + " in " + roomId +
            " (duplicate or cap; activation.duplicateDispatches/pendingOverflow count it) — the wake still proceeds",
        );
      }
      // ---------------------------------------------------------------------
      // THE DISPATCH. This literal `agent.followup(` call is deliberately kept inline
      // rather than moved into `dispatchFollowup`: 0.1.46's own static guard
      // (`test/ack.test.mjs`, "the receipt sits AFTER the dispatch") locates this token in
      // this function and asserts it precedes the watermark mark. Weakening a shipped
      // regression lock to save six lines would be exactly the trade this family of
      // releases exists to refuse — so the recording is what is shared, not the call.
      // ---------------------------------------------------------------------
      let accepted = false;
      try {
        agent.followup(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "plugin", plugin: "dsh-agent-room" } }));
        accepted = true;
      } catch (error) {
        // 小麦's silent stop, as a first-class outcome: the call threw, so NOTHING was
        // handed over — and that must never be indistinguishable from success.
        this.activation.noteFollowupRefused(roomId, message.seq);
        this.warnRateLimited(
          "followup-refused:" + roomId,
          `[agent-room] listening: followup REFUSED for ${roomId} seq=${message.seq} agent=${agentId} (${String(error)}) — ` +
            "NOTHING was handed to the agent; activation.followupRefused counts it",
        );
      }
      if (accepted) {
        // Baseline captured HERE: the transcript mtime this dispatch starts from, so the
        // `transcript` evidence can tell "the session wrote something after the wake" from
        // "the session was already busy writing".
        this.activation.noteAccepted(roomId, message.seq, agentId, this.sessionActivityMs(agentId));
        if (executable && !trace.workspaceUnsafe) {
          this.diag(
            "listening: followup ACCEPTED seq=" + message.seq + " agent=" + agentId + " in " + roomId +
              " — the message is in the agent's INBOX (all `followup` guarantees: it returns undefined and cannot " +
              "throw for a busy agent, dsh-agent-loop/lib/index.js:396). Whether a TURN started is what " +
              "activation.started / escalationsAttempted answer.",
          );
        } else if (trace.workspaceUnsafe) {
          // 0.1.49: the turn WILL run here and still produce nothing — the session's workspace
          // cannot host the sandboxed shell, and a host-created session carries no `room_send`
          // tool, so the shell is the agent's only way to answer. Measured on 小麦: this exact
          // state reported `started:1` and `acceptedNoOutput:1` for ever.
          this.warnRateLimited(
            "wake-workspace-unsafe:" + roomId,
            `[agent-room] listening: followup accepted — BUT THIS SESSION CANNOT BE HEARD FROM: seq=${message.seq} agent=${agentId} ` +
              `in ${roomId} has workspace ${trace.workspaceUnsafe}, which contains the OS temp root, so the sandboxed shell cannot start ` +
              "(0.1.49; measured on 小麦). Expect activation.acceptedNoOutput, NOT an answer.",
          );
        } else {
          // 0.1.48: NEVER a success-shaped line for a session that cannot execute. Before this
          // version the log said "followup accepted" for a duty session with no model, and that
          // sentence is what made two silent machines read as healthy.
          this.diag(
            "listening: followup accepted — INBOX ONLY, NOT SUCCESS: seq=" + message.seq + " agent=" + agentId +
              " in " + roomId + " has NO provider/model, so the turn cannot run " +
              "(activation.residentNoModel counts it; the escalation tick will try to repair + re-resolve)",
          );
        }
      }
      // Marked only AFTER the dispatch actually happened. A seq at or below the
      // mark is refused (`regressed`) instead of lowering it — that counter must
      // stay 0, and a climbing value means some caller bypassed `seen()`.
      const advanced = this.wakeWatermark.mark(roomId, message.seq);
      // 0.1.45: the admission is counted by the rule that admitted it, next to the
      // mark — i.e. only for a wake that really reached `agent.followup`.
      this.wakeWatermark.noteWokenBy(pick.decision.reason);
      if (!advanced && Number.isSafeInteger(message.seq) && message.seq > 0) {
        this.warnRateLimited(
          "wake-regressed:" + roomId,
          `[agent-room] wake watermark refused seq=${message.seq} in ${roomId} (mark=${this.wakeWatermark.watermark(roomId)}); stats().regressed is the tripwire`,
        );
      }
      // ---------------------------------------------------------------------
      // 0.1.46 ACK plane — THE RECEIPT. This is the boundary the whole release is
      // about: the message reached THIS machine, passed THIS machine's wake rule, and
      // a resident agent was just handed it. Until this line existed, that fact was
      // indistinguishable from "the message never got here" for everyone else: on
      // 2026-09-15 three of four machines woke for seq 4405 and produced nothing
      // anywhere, and one of them could only be diagnosed by reading 142,000 lines.
      //
      // FIRE AND FORGET, ON PURPOSE (requirement 6): the turn is already running, so a
      // room write that fails must not — and cannot — take it back. Nothing is awaited
      // here, no lock is held, and the sweep's `listenPending` re-arm is unaffected.
      //
      // 0.1.47 TIGHTENING (the one behavioural change to 0.1.46, stated rather than
      // smuggled): the receipt is now posted only when the handoff really happened. A
      // receipt says `[ack] <me> 已接手 seq=N` — "I have taken this on" — and 0.1.46 posted
      // it after the `followup` call whether that call returned or threw. A receipt for a
      // REFUSED followup asserts a handoff that never occurred, which is the exact defect
      // class every release in this family exists to end. The sender sees the honest
      // consequence: an unacked target (`ack.unackedTargets`) plus
      // `activation.followupRefused` on the target machine.
      // ---------------------------------------------------------------------
      if (accepted) void this.postAckReceipt(roomId, identity, message.seq, pick.decision.reason);
      else this.diag("ack: NO receipt for seq=" + message.seq + " in " + roomId + " — the followup was refused, nothing was handed over (activation.followupRefused counts it)");
    } catch (error) {
      this.diag("listening: wake failed for " + roomId + " — " + String(error));
    } finally {
      // Re-arm after a generous window so later messages can wake again.
      const timer = setTimeout(() => this.listenPending.delete(roomId), 60_000);
      try { timer.unref(); } catch { /* ignore */ }
    }
  }

  /**
   * Post ONE receipt line for a dispatch this node was actually handed (0.1.46).
   *
   * ORDER OF OPERATIONS, and why it is this order:
   *   1. the wake already happened (`agent.followup` accepted) — the receipt describes
   *      something that is TRUE at this instant, not something we hope will happen;
   *   2. `allowReceipt` decides: at most once per `(roomId, seq)` ever, and at most one
   *      receipt per room per `ACK_RATE_LIMIT_MS`. Neither refusal is silent (both are
   *      counted, and a refusal shows up on the sender as an unacked target);
   *   3. the room write is attempted, and its failure is COUNTED (`receiptsFailed`) —
   *      the handling proceeds either way, because it is already running.
   *
   * Deliberately NOT `await`ed by the caller: this method can only make the wake path
   * slower, never safer, so it runs detached with its own error boundary.
   */
  private async postAckReceipt(
    roomId: string,
    identity: AgentIdentity,
    seq: number,
    rule: WakeReason,
  ): Promise<void> {
    try {
      const verdict: AckRefusal = this.ackLedger.allowReceipt(roomId, seq);
      if (verdict !== "ok") {
        // One self-describing line, rate-limited by the caller's own policy: a
        // "duplicate" here is the second half of the (room, seq) contract, and a
        // rate-limited receipt is visible to the sender as an unacked target.
        this.diag("ack: no receipt for seq=" + seq + " in " + roomId + " (reason=" + verdict + ")");
        return;
      }
      const text = formatAckReceipt({ nickname: identity.nickname, agentId: identity.agentId, seq });
      const result = await this.gateway.sendChat(roomId, { text, human: false });
      // A receipt exists only if the room took it. `sendChat` answers a delivery status
      // for a joined room and the stored message for an owned one; both are accepted
      // here, while an explicit refusal is counted as a failure rather than assumed OK.
      const status = result as { delivered?: boolean; acceptedByLocalHub?: boolean } | undefined;
      if (status && status.delivered === false && status.acceptedByLocalHub === false) {
        throw new Error("room refused the receipt frame");
      }
      this.ackLedger.noteReceiptPosted(roomId, seq);
      // The receipt names its own nickname and seq, and it is NOT addressed to anyone
      // (no `@`), so it wakes nobody: `wake.ts` refuses it as a `machine-frame`.
      this.diag("ack: receipt posted for seq=" + seq + " in " + roomId + " (rule=" + rule + ", line=\"" + text + "\")");
    } catch (error) {
      // Requirement 6: the receipt failing must never affect the handling that already
      // started, and must never be invisible either.
      this.ackLedger.noteReceiptFailed();
      this.warnRateLimited(
        "ack-failed:" + roomId,
        `[agent-room] ack receipt for seq=${seq} in ${roomId} could NOT be posted (${String(error)}) — the dispatch was still handed to the resident agent; ack.receiptsFailed counts this`,
      );
    }
  }

  /**
   * Sender side of the ack plane (0.1.46): observe receipts and name the absences.
   *
   * Runs on the same 30 s cadence as the wake sweep but over EXPECTATION rooms, not
   * `listeningRooms` — a sender need not be listening to deserve an answer about whether
   * its dispatch arrived. Two steps, both bounded:
   *   1. `observe`: match `[ack] <me> … seq=N` frames from a target against open
   *      expectations (matching on the owner-stored `from` = the target's agentId, which
   *      is authoritative);
   *   2. `expire`: whatever is past `ACK_WINDOW_MS` without a receipt becomes
   *      `unackedTargets` — and, when this node owns the room, ONE `[ack-miss]` line so
   *      a human reading the room sees the silence too.
   *
   * The absence line is written only for OWNED rooms (`roomService.addChatMessage` is the
   * authoritative write): a member cannot put words in the owner's store, and inventing a
   * second write path for this would be a new defect. Non-owner senders still get the
   * counters — the requirement is that the absence is OBSERVABLE, not that everyone can
   * shout.
   */
  private async sweepAckPlane(now: number = Date.now()): Promise<void> {
    const rooms = this.ackLedger.expectedRooms();
    if (rooms.length === 0) return;
    for (const roomId of rooms) {
      try {
        const recent = await this.recentMessagesFor(roomId, WAKE_WINDOW_ROWS);
        const acked = this.ackLedger.observe(roomId, recent);
        for (const agentId of acked) {
          this.diag("ack: receipt OBSERVED in " + roomId + " from " + agentId);
        }
      } catch (error) {
        this.diag("ack: observe failed for " + roomId + " — " + String(error));
      }
    }
    const overdue = this.ackLedger.expire(now);
    for (const miss of overdue) {
      this.warnRateLimited(
        "ack-miss:" + miss.roomId + ":" + miss.seq,
        `[agent-room] ack: dispatch seq=${miss.seq} in ${miss.roomId} was NOT acked within ` +
          `${Math.round(miss.waitedMs / 1000)}s by ${miss.nicknames.join("/")} — ` +
          "ack.unackedTargets counts this; the dispatch may never have arrived at those machines",
      );
      this.diag("ack: MISS seq=" + miss.seq + " in " + miss.roomId + " (no receipt from " + miss.nicknames.join("/") + ")");
      if (!this.ackLedger.needMissNotice(miss.roomId, miss.seq)) continue;
      if (!this.roomService.getOwnedRoom(miss.roomId)) continue;
      try {
        const identity = await this.roomService.ensureIdentity();
        const text = formatAckMiss({ seq: miss.seq, nicknames: miss.nicknames, waitedMs: miss.waitedMs });
        await this.gateway.sendChat(miss.roomId, { text, human: false });
        this.ackLedger.noteMissPosted(miss.roomId, miss.seq);
        this.diag("ack: miss notice posted for seq=" + miss.seq + " in " + miss.roomId + " (line=\"" + text + "\")");
      } catch (error) {
        this.warnRateLimited(
          "ack-miss-post:" + miss.roomId,
          `[agent-room] ack: could not post the absence notice for seq=${miss.seq} in ${miss.roomId} (${String(error)}) — the counters still expose it`,
        );
      }
    }
  }

  /* --------------------------- activation (0.1.47) --------------------------- */

  /**
   * The ACTIVATION sweep: does a dispatched wake actually start a turn, and if it does not,
   * do the equivalent of `activate-chat` yourself — ONCE.
   *
   * This is the fix for the deepest problem of 2026-09-15/16: the wake arrived, the receipt
   * went out, and nothing was produced. `agent.followup` cannot report that (it returns
   * `undefined` by implementation — see `dispatchFollowup`), so the only place it can be
   * detected is here, by looking for evidence afterwards.
   *
   * THREE STEPS, all bounded, all counted:
   *   1. EVIDENCE. For every dispatch in flight, look for one of three local proofs that the
   *      resident agent acted: the harness's own `agent.status === "running"`
   *      (`dsh-agent-loop/lib/index.js:380`), a transcript that moved after the dispatch, or
   *      our own message landing in the room (that last one arrives through `noteOwnReply`,
   *      not through this loop). Each is counted under its own name so a reader can see
   *      WHICH evidence fired.
   *   2. ESCALATION. A dispatch past the start window with no evidence gets ONE escalation
   *      (`activation.dueEscalation` marks it, so "once per dispatch" is a property of the
   *      structure and not of this method's discipline).
   *   3. SETTLEMENT. Past the output window: close the entry and count the timeout in
   *      `acceptedNoOutput` or `refusedNoOutput` — the two outcomes the log could not
   *      distinguish before this version.
   *
   * COST WHEN IDLE: zero. `pendingCount() === 0` returns before any registry lookup, any
   * stat, any log line. The tick exists so a dispatch is never missed; it does nothing at
   * all when no machine has a wake in flight.
   */
  private async sweepActivation(now: number = Date.now()): Promise<void> {
    if (this.activation.pendingCount() === 0) return;
    // 1. evidence
    try {
      for (const entry of this.activation.pendingEntries()) {
        if (entry.started || !entry.agentId) continue;
        const agent = this.agentById(entry.agentId);
        // 1a. the harness's own phase getter — the sharpest signal available in-process.
        if (agent && agent.status === "running") {
          if (this.activation.noteStart(entry.roomId, entry.seq, "status", now)) {
            this.diag(
              "activation: STARTED seq=" + entry.seq + " in " + entry.roomId + " agent=" + entry.agentId +
                " (evidence=status: agent.status=running) — " + Math.round((now - entry.dispatchedAt) / 1000) + "s after the wake",
            );
          }
          continue;
        }
        // 1b. fallback for handles that expose no status: did that session's transcript
        //     move after the dispatch? (baseline captured at dispatch time)
        const moved = this.sessionActivityMs(entry.agentId);
        if (typeof moved === "number" && typeof entry.baselineMs === "number" && moved > entry.baselineMs) {
          if (this.activation.noteStart(entry.roomId, entry.seq, "transcript", now)) {
            this.diag(
              "activation: STARTED seq=" + entry.seq + " in " + entry.roomId + " agent=" + entry.agentId +
                " (evidence=transcript: session.jsonl.zstd advanced) — " +
                Math.round((now - entry.dispatchedAt) / 1000) + "s after the wake",
            );
          }
        }
      }
    } catch (error) {
      // An evidence pass that throws must not stop the escalation pass — both halves are
      // independent, and a failure here would silently disable the fix.
      this.warnRateLimited("activation-evidence", `[agent-room] activation: evidence pass failed (${String(error)})`);
    }
    // 2. escalation
    for (const due of this.activation.dueEscalation(now)) {
      await this.escalateWake(due, now);
    }
    // 3. settlement (the timeout path, named)
    for (const done of this.activation.dueSettlement(now)) {
      this.reportSettlement(done);
    }
  }

  /**
   * Do the equivalent of `activate-chat` for a wake that did not start a turn.
   *
   * WHY THIS IS ALLOWED TO EXIST: the plugin already owns this code path — 小婷's own log
   * proves it works end to end (`active-session: session-b7496a19…` → `registry dump` →
   * `accepted … thinking=true` → `dispatching followup …` → `followup accepted` → a real
   * room message). A human clicking a button in the browser should not be the only way to
   * reach a working activation.
   *
   * WHAT IT DELIBERATELY DOES NOT DO: it does not set `activateThinkingRooms`, i.e. it does
   * not put the room into the UI's "thinking" state. That flag is the browser's one-shot
   * button state (it makes the next click answer HTTP 409), and claiming it from a background
   * escalation would both 409 a human's click and make an automatic activation
   * indistinguishable from a user action. The counter is what tells them apart
   * (`activation.escalationsAttempted`); the UI state stays the user's.
   *
   * BOUNDED FAILURE: no resident agent → `escalationFailedNoAgent` + `noResidentAgent` and a
   * rate-limited line; a refused followup → `escalationFailedRefused`. Never retried for the
   * same dispatch (the tracker marked it), never a storm.
   */
  private async escalateWake(due: ActivationEscalation, now: number = Date.now()): Promise<void> {
    const waited = Math.round(due.waitedMs / 1000);
    try {
      const identity = this.roomService.getIdentity();
      if (!identity) {
        this.activation.noteEscalationResult(false, "no-identity");
        this.warnRateLimited(
          "escalate-no-identity:" + due.roomId,
          `[agent-room] wake-escalate: FAILED for ${due.roomId} seq=${due.seq} — this node has no identity yet (activation.escalationsFailedNoAgent counts it)`,
        );
        return;
      }
      const trace: ResolutionTrace = {};
      const agent = await this.resolveResidentAgent(identity, trace);
      if (!agent) {
        // The machine is structurally unable to accept work — say so as such, and count it
        // in both places a reader might look.
        this.activation.noteResident("none");
        this.activation.noteEscalationResult(false, "no-resident-agent");
        this.warnRateLimited(
          "escalate-no-agent:" + due.roomId,
          `[agent-room] wake-escalate: FAILED for ${due.roomId} seq=${due.seq} (${waited}s without a start) — ` +
            `NO RESIDENT AGENT to escalate with (resolution=${trace.detail ?? "unknown"}); ` +
            "activation.escalationsFailedNoAgent + activation.noResidentAgent count it — this machine cannot accept work",
        );
        return;
      }
      const agentId = agent.id ?? agent.sessionId ?? "unknown";
      this.activation.noteResident(trace.path ?? "none");
      // 0.1.48: an escalation into a session that CANNOT EXECUTE is worthless — say so, and
      // count it, instead of reporting "escalated" for a session that cannot run a turn.
      const executable = trace.executable ?? this.agentExecutable(agent);
      this.activation.noteResidentExecutability(executable);
      if (!executable) {
        this.diag(
          "wake-escalate: WARNING — the resolved agent " + agentId + " still has NO provider/model after " +
            "re-resolution + repair attempt (resolution=" + (trace.detail ?? "unknown") + "); escalating anyway, but " +
            "this session cannot run a turn (activation.residentNoModel counts it)",
        );
      }
      this.diag(
        "wake-escalate: " + due.roomId + " seq=" + due.seq + " produced NO evidence of a turn " + waited +
          "s after the wake — escalating with the activate-chat prompt (same resolution + same prompt as the " +
          "manual button: agent=" + agentId + ", via=" + (trace.path ?? "unknown") + ")",
      );
      const prompt = await this.buildActivatePromptFor(due.roomId, identity);
      const ok = this.dispatchFollowup(due.roomId, due.seq, agent, prompt, "escalate");
      this.activation.noteEscalationResult(ok, ok ? undefined : "followup-refused");
      if (ok) {
        this.activation.noteAccepted(due.roomId, due.seq, agentId, this.sessionActivityMs(agentId));
        this.diag(
          "wake-escalate: SENT seq=" + due.seq + " in " + due.roomId + " agent=" + agentId +
            " — activation.escalationsSucceeded counts it; if this machine still produces no output the window " +
            "closes as activation.acceptedNoOutput",
        );
      } else {
        this.warnRateLimited(
          "escalate-refused:" + due.roomId,
          `[agent-room] wake-escalate: REFUSED by the resident agent for ${due.roomId} seq=${due.seq} — ` +
            "activation.escalationsFailedRefused counts it",
        );
      }
    } catch (error) {
      // A failed escalation is COUNTED, never silent — this branch is the whole point of the
      // release: 小麦's log ended after `dispatching followup …` with nothing at all.
      this.activation.noteEscalationResult(false, "room-gone");
      this.warnRateLimited(
        "escalate-error:" + due.roomId,
        `[agent-room] wake-escalate: FAILED for ${due.roomId} seq=${due.seq} — ${String(error)} ` +
          "(activation.escalationsFailed counts it)",
      );
    }
  }

  /** Say why a dispatch closed without output — one line per settlement, counted. */
  private reportSettlement(done: ActivationSettlement): void {
    if (done.reason === "output") return;
    const waited = Math.round(done.waitedMs / 1000);
    if (done.reason === "accepted-no-output") {
      this.diag(
        "activation: ACCEPTED BUT NO OUTPUT seq=" + done.seq + " in " + done.roomId + " agent=" +
          (done.agentId || "unknown") + " — the followup was accepted " + waited + "s ago and this node's own " +
          "message never appeared in the room (activation.acceptedNoOutput counts it; the wake prompt permits " +
          "silence when the agent judges no reply is needed, so this is a TIMEOUT, not proof of a bug)",
      );
      this.warnRateLimited(
        "activation-no-output:" + done.roomId,
        `[agent-room] activation: wake seq=${done.seq} in ${done.roomId} was accepted by the resident agent ` +
          `${waited}s ago and produced NO output (activation.acceptedNoOutput counts it)`,
      );
      return;
    }
    this.diag(
      "activation: REFUSED BUT NO OUTPUT seq=" + done.seq + " in " + done.roomId + " — no agent ever took this " +
        "wake (" + waited + "s; activation.refusedNoOutput + activation.followupRefused count it)",
    );
  }

  private async boot(): Promise<void> {
    // 0.1.38 (G2): resolve + prove the backup/quarantine root before anything is
    // read or written. A root this platform cannot resolve must stop the node
    // here, loudly, instead of failing every later identity write.
    await ensureBackupRoot();
    this.relayConfigFile = join(this.config.dataDir, "relay-config.json");
    await this.loadRelayConfig();
    this.replyAgentFile = join(this.config.dataDir, "reply-agent.json");
    this.persistedReplyAgentId = await this.loadReplyAgentId();
    this.listeningFile = join(this.config.dataDir, "listening.json");
    // 0.1.48: the persisted resident model selection — the tier that makes the duty session
    // executable again after a restart, when the registry is empty and there is nothing to
    // mirror from. (The duty session id itself is deterministic and is restored by the host;
    // what was LOST across restarts was the model.)
    this.residentModelFile = join(this.config.dataDir, "resident-model.json");
    // The host's own default model selection, on disk (0.1.48). `DSH_HOME` is what the host
    // itself uses to find it (`dsh-agent-default-model` persists through the settings
    // provider), so the same env var resolves the same file here.
    this.settingsFilePath = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "settings.yaml");
    try {
      const recorded = await readJsonConfig<{ provider?: string; model?: string; source?: string }>(this.residentModelFile);
      if (recorded && typeof recorded.provider === "string" && recorded.provider && typeof recorded.model === "string" && recorded.model) {
        this.persistedResidentModel = { provider: recorded.provider, model: recorded.model };
        this.ctx.logger?.info?.(
          "[agent-room] resident model selection restored from %s: %s/%s (recorded from %s)",
          this.residentModelFile, recorded.provider, recorded.model, recorded.source ?? "unknown",
        );
      }
    } catch (error) {
      // An unreadable selection is not fatal (mirror/host-default still work) but it is NOT
      // silent: without it a machine with no live session can end up spawning a model-less
      // duty session, which is the defect this tier exists to prevent.
      this.warnRateLimited(
        "resident-model-load",
        `[agent-room] could not read the persisted resident model selection from ${this.residentModelFile} (${String(error)})`,
      );
    }
    await this.roomService.boot();
    const identity = await this.roomService.ensureIdentity();
    // Auto-collect capabilities: map installed tools onto the 6-family taxonomy
    // and pass skill names through directly (both best-effort).
    const caps = new Set<string>();
    try {
      const tools = (this.ctx.get("tools") as { view?: () => { knownNames?: Set<string> } } | undefined)?.view;
      const known = tools?.()?.knownNames;
      if (known) {
        for (const toolName of known) {
          const cap = capabilityForTool(toolName);
          if (cap) caps.add(cap);
        }
      }
    } catch {
      /* non-fatal */
    }
    try {
      const skillNames = (this.ctx.get("skills") as { collect?: () => Promise<unknown[]> } | undefined)?.collect;
      if (typeof skillNames === "function") {
        const summaries = (await skillNames()) as Array<{ name?: string }>;
        for (const s of summaries) if (typeof s?.name === "string" && s.name) caps.add(s.name);
      }
    } catch {
      /* non-fatal */
    }
    if (caps.size > 0) {
      // 0.1.38: saveIdentity can now legitimately REFUSE (an unparseable
      // identity.json is never overwritten, and a write may not proceed without a
      // verified backup). Auto-collected capabilities are cosmetic enrichment, so a
      // refusal must not take the node down at boot — the refused write itself is
      // the correct outcome and is logged here.
      try {
        await this.roomService.mergeCapabilities([...caps]);
      } catch (error) {
        this.ctx.logger?.warn?.("[agent-room] capability merge not persisted: %s", String(error));
      }
    }
    this.ctx.logger?.info?.("[agent-room] node identity %s (%s)", identity.agentId, identity.nickname);
    // Eagerly start the room server so the port is always listening after
    // boot — a lazy start tied to room creation leaves persisted rooms
    // unreachable after a restart.
    try {
      const address = await this.ensurePeerServer();
      this.ctx.logger?.info?.("[agent-room] room server listening on %s", address);
      this.refreshRelayBridge();
    } catch (error) {
      this.ctx.logger?.warn?.("[agent-room] room server failed to start: %s", String(error));
    }
    // Same-LAN room discovery: broadcast beacons for our rooms and collect
    // beacons from nearby nodes so rooms show up by name without an address.
    try {
      const discovery = new LanDiscovery({
        serverPort: this.config.port,
        node: () => this.roomService.getIdentity() ?? {
          agentId: "unknown",
          nickname: "unknown",
          capabilities: [],
          createdAt: "",
        },
        rooms: () =>
          this.roomService.listOwnedRooms().map((room) => ({
            roomId: room.roomId,
            title: room.title,
            authMode: room.settings.authMode,
            memberCount: room.members.length,
            status: room.status,
          })),
      });
      await discovery.start();
      this.discovery = discovery;
    } catch (error) {
      this.ctx.logger?.warn?.("[agent-room] LAN discovery unavailable: %s", String(error));
    }
    // Push our live profile (nickname/capabilities) to joined rooms so member
    // lists reflect identity edits on the owner's side.
    this.profileTimer = setInterval(() => void this.syncProfile(), 15_000);
    // 0.1.42: restore the LISTENING INTENT before the sweep is armed and before the
    // membership is re-created, so a restart comes back listening with NO external
    // script involved. `restoreListening` reads a preference file that is treated
    // as "absent" when unreadable (persistence.ts), so it cannot fail a boot — and
    // it is deliberately not wrapped in a swallow-everything catch, because a
    // silent failure here is exactly the defect this release removes.
    await this.restoreListening();
    // Listening sweep: rule-layer scan of listening rooms, wake the agent only
    // when a message needs it (0-token unless something actually needs a reply).
    // 0.1.46: the SAME 30 s cadence drives the ack plane's sender side (observe the
    // receipts for dispatches this node posted, and expire the ones that never came).
    // Deliberately ONE interval, not two: a second timer would double the room reads for
    // no new information, and the window that decides "missing" is 120 s — four ticks.
    // The ack sweep is fire-and-forget so a slow room read can never delay the wake plane.
    this.listenTimer = setInterval(() => {
      void this.sweepListening();
      void this.sweepAckPlane();
    }, 30_000);
    // 0.1.47: the ACTIVATION tick, deliberately its own interval and deliberately faster
    // than the 30 s sweep. The question it answers — "did the wake we just handed over
    // actually start a turn?" — has a 20 s budget (see activation.ts for the derivation from
    // the measured 0.39 s wake→turn latency), which a 30 s tick cannot honour: the
    // escalation would be decided by a coin flip on where the dispatch landed relative to the
    // sweep. It is safe to run this faster than the sweep because it performs NO room read
    // and NO I/O at all while nothing is in flight (`sweepActivation` returns on the first
    // line), so the cost is four no-op function calls per minute on an idle machine.
    this.activationTimer = setInterval(() => {
      void this.sweepActivation();
    }, ACTIVATION_TICK_MS);
    // unref'd ON PURPOSE, and it is the only timer in this file that is: this tick only
    // OBSERVES other work, so it must never be the reason a process stays alive (a service
    // that is being torn down, a test harness, a headless run). The sweep timer above keeps
    // the service alive as before; this one fires for as long as something else does.
    try { this.activationTimer.unref?.(); } catch { /* not available in all envs */ }
    // Restore membership of rooms we joined before: recreate the client so
    // inbound sync/exec/task frames flow again without a manual re-join.
    void this.autoRejoinJoinedRooms();
    // 0.1.38 (G4): we reached the end of boot, so this node really is up. Only
    // the plugin can make that claim — the watchdog merely READS the marker, so a
    // repaired machine is started again by itself without anyone deleting a file.
    await clearRefusedMarker(this.config.dataDir);
  }

  /**
   * Persist a joined-room record — unless it is a SELF-JOIN.
   *
   * A node that records a join to its own room delivers every frame twice: the
   * room's own broadcast plus the looped-back member copy (field evidence: the
   * same exec id twice within 1ms, and one machine's audit log at 923 MB). The
   * room is served by this node, so the record carries no information worth
   * keeping — drop it, including any older copy already on disk.
   */
  private async recordJoinedRecord(record: JoinedRoomRecord): Promise<void> {
    if (!record?.roomId) return;
    if (this.roomService.getOwnedRoom(record.roomId)) {
      this.warnRateLimited(
        "selfjoin:" + record.roomId,
        `[agent-room] refusing to record a join to our own room ${record.roomId} (self-join would deliver every frame twice)`,
      );
      await this.forgetJoinedRoom(record.roomId, "room is owned by this node (self-join)");
      return;
    }
    if (this.ownAddresses().has(normaliseAddress(record.address))) {
      this.warnRateLimited(
        "selfaddr:" + record.roomId,
        `[agent-room] refusing to record a join to our own address ${record.address} for room ${record.roomId} (self-join)`,
      );
      await this.forgetJoinedRoom(record.roomId, "record points at this node's own address (self-join)");
      return;
    }
    await this.roomService.recordVisited(record.roomId, record.address, record.title);
  }

  /**
   * Cancel every pending bounded-backoff rejoin (D-18).
   *
   * Called on disposal and available to tests: a retry timer that outlives the
   * service keeps dialling a room nobody owns any more, and it keeps the event loop
   * alive so a process cannot exit.
   */
  stopRejoinRetries(): void {
    for (const timer of this.rejoinTimers) {
      try { clearTimeout(timer); } catch { /* ignore */ }
    }
    this.rejoinTimers.clear();
  }

  /**
   * Reconnect to every room recorded in joined.json (idempotent).
   *
   * Records are pruned only for reasons that are actually knowable:
   *  - the room is owned by this node (self-join — see recordJoinedRecord);
   *  - the address is one of this node's own (self-join);
   *  - a legacy record pointing somewhere other than the configured relay and
   *    untouched for a day (unroutable from another network anyway).
   *
   * Everything else is retried, and staleness is decided by the JOIN RESULT:
   * the old predicate (`relay && record.address !== relay`) could never hold for
   * a dead relay-hosted room — its address IS the relay — so such a room was
   * retried forever. rejoinWithRetry now drops the record when the owner answers
   * "room-not-found/closed" and after bounded backoff when it rejects.
   */
  private autoRejoinJoinedRooms(): void {
    const relay = this.config.relay?.replace(/\/+$/, "");
    const own = this.ownAddresses();
    const keep: JoinedRoomRecord[] = [];
    let dropped = 0;
    for (const record of this.roomService.listJoinedRooms()) {
      if (!record?.roomId || !record?.address) { dropped += 1; continue; }
      if (this.roomService.getOwnedRoom(record.roomId)) {
        dropped += 1;
        this.warnRateLimited(
          "boot-selfjoin:" + record.roomId,
          `[agent-room] pruning joined record ${record.roomId}: this node owns that room (self-join)`,
        );
        continue;
      }
      if (own.has(normaliseAddress(record.address))) {
        dropped += 1;
        this.warnRateLimited(
          "boot-selfaddr:" + record.roomId,
          `[agent-room] pruning joined record ${record.roomId}: ${record.address} is this node's own address (self-join)`,
        );
        continue;
      }
      if (relay && normaliseAddress(record.address) !== normaliseAddress(relay)) {
        const seen = Date.parse(record.lastVisitedAt ?? "") || 0;
        if (Date.now() - seen > STALE_JOINED_RECORD_MS) { dropped += 1; continue; }
      }
      keep.push(record);
    }
    if (dropped > 0) {
      void this.roomService.replaceJoinedRooms(keep).then(() => {
        this.ctx.logger?.info?.(
          "[agent-room] pruned %d stale joined room record(s), kept %d", dropped, keep.length,
        );
      });
    }
    for (const record of keep) {
      void this.rejoinWithRetry(record.roomId, record.address, 0);
    }
  }

  /**
   * Best-effort rejoin with bounded backoff; manual join is still the override.
   *
   * The record is dropped once the join RESULT proves the room is unusable:
   * immediately for room-not-found/closed, and after the attempts are exhausted
   * for a refusal (wrong password / full / revoked) that no amount of retrying
   * will clear. A transient failure (owner offline) keeps the record.
   */
  private async rejoinWithRetry(roomId: string, address: string, attempt: number): Promise<void> {
    if (this.clients.has(roomId)) return; // already connected (manual join won the race)
    const maxAttempts = REJOIN_MAX_ATTEMPTS;
    try {
      await this.gateway.joinRoom([address], { roomId });
      this.ctx.logger?.info?.("[agent-room] auto-rejoined room %s at %s", roomId, address);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kind = classifyJoinFailure(message);
      if (kind === "stale") {
        // Definitively gone: retrying is what pinned a node to a closed room.
        await this.forgetJoinedRoom(roomId, `join rejected: ${message}`);
        return;
      }
      // An offline peer is normal (someone simply switched a machine off), so warn
      // once per room and keep the rest at debug instead of flooding the log.
      if (attempt === 0) {
        this.ctx.logger?.warn?.("[agent-room] auto-rejoin failed for %s at %s: %s", roomId, address, message);
      } else {
        this.ctx.logger?.debug?.("[agent-room] auto-rejoin retry %d for %s: %s", attempt + 1, roomId, message);
      }
      if (attempt + 1 < maxAttempts) {
        const timer = setTimeout(() => {
          this.rejoinTimers.delete(timer);
          void this.rejoinWithRetry(roomId, address, attempt + 1);
        }, REJOIN_BACKOFF_MS * (attempt + 1));
        this.rejoinTimers.add(timer);
        return;
      }
      if (kind === "rejected") {
        await this.forgetJoinedRoom(roomId, `join refused after ${maxAttempts} attempts: ${message}`);
        return;
      }
      this.ctx.logger?.info?.(
        "[agent-room] gave up auto-rejoining %s after %d attempts (owner likely offline)", roomId, maxAttempts,
      );
    }
  }

  /** Broadcast our current identity to every joined room (nickname/capabilities). */
  private async syncProfile(): Promise<void> {
    await this.fanOutProfile();
  }

  /**
   * Push the cached profile to every joined room RIGHT NOW (0.1.40).
   *
   * The 15s `profileTimer` (armed in boot) is unchanged and still the periodic
   * path — this is the same body, callable on demand, so a rename does not have to
   * wait up to one tick to reach a room owner (card-01 §2.1: of the three
   * `sendProfile` call sites, only the timer is tick-driven; a rename must not
   * depend on it). Returns the number of clients whose channel ACCEPTED the frame
   * (a client that throws is skipped, not counted), which is what the rename
   * result reports as `profileFanout`.
   */
  async pushProfileNow(): Promise<number> {
    return await this.fanOutProfile();
  }

  /**
   * The single fan-out body, shared by the timer and `pushProfileNow`.
   *
   * It reads the identity CACHE (`getIdentity`), never `ensureIdentity`: a
   * fan-out must not mint an identity, and an empty cache means boot has not
   * finished, which is simply nothing to send.
   */
  private async fanOutProfile(): Promise<number> {
    if (this.clients.size === 0) return 0;
    const identity = this.roomService.getIdentity();
    if (!identity) return 0;
    let sent = 0;
    for (const client of this.clients.values()) {
      try {
        client.sendProfile({ nickname: identity.nickname, capabilities: identity.capabilities });
        sent += 1;
      } catch { /* non-fatal */ }
    }
    return sent;
  }

  /**
   * THE rename entry point (0.1.40) — one call, three stores.
   *
   * Card-01's defect: no supported entry point existed, so a nickname could only
   * be changed by editing `identity.json` by hand. That is invisible to the
   * running process (the identity object is cached and never re-read), and the
   * next save rewrites the file from the cache — the hand fix is silently
   * reverted. This method mutates the cached object in place (through
   * `updateProfile`) and then fans out, so a rename needs NO restart.
   *
   * Order, and why:
   *   1. validate (G1) BEFORE anything is touched -> a rejected name changes
   *      nothing anywhere;
   *   2. require the identity CACHE to exist. NOT `ensureIdentity()` /
   *      `gateway.identity()`: those mint (and write) a fresh identity when the
   *      cache is empty, which for a rename is the worst possible side effect;
   *   3. `updateProfile` -> writes store A (with the verified pre-write backup
   *      that `saveIdentity` already takes) and mutates the SAME object the
   *      RoomClients and the fan-out read;
   *   4. fan out immediately to joined rooms (store B, remote owners) and update
   *      this node's own member rows in the rooms it owns (store B, local);
   *   5. ask agent-org to rename this machine's node (store C) through
   *      `ctx.get("agentOrg")` — resolved AT CALL TIME, because agent-org loads
   *      after agent-room and would be undefined during our own start-up. A
   *      missing/refusing org is REPORTED, never silently skipped.
   */
  async renameSelf(nickname: string): Promise<SelfRenameResult> {
    const wanted = assertValidNickname(nickname);

    const cached = this.roomService.getIdentity();
    if (!cached) throw new IdentityNotReadyError();
    const previous = cached.nickname;

    // Store A, plus the in-place mutation of the object every reader shares.
    const identity = await this.roomService.updateProfile({ nickname: wanted });

    // Store B, immediately: joined rooms get the frame now, not on the next tick.
    const profileFanout = await this.pushProfileNow();
    // ...and the rooms THIS node owns, whose member list is served from here.
    let ownedRoomMembers = 0;
    for (const room of this.roomService.listOwnedRooms()) {
      if (!room.members.some((m) => m.agentId === identity.agentId)) continue;
      this.roomService.updateMemberProfile(room.roomId, identity.agentId, { nickname: identity.nickname });
      ownedRoomMembers += 1;
    }

    // @-mention hazard (card-01 §4.3). `room-service` resolves a mention by
    // nickname and THROWS `ambiguous-member` when two members share one, so a
    // rename onto a name another member already uses breaks mention parsing in
    // that room. Reported, not refused: refusing would make the one supported
    // rename entry point fail because of a room the caller may not even be
    // thinking about, and the damage class this release exists to fix is a name
    // that cannot be changed at all.
    const conflicts: Array<{ roomId: string; agentIds: string[] }> = [];
    const collect = (roomId: string, members: Array<{ agentId: string; nickname: string }>): void => {
      const wanted = identity.nickname.toLowerCase();
      const clashes = members
        .filter((m) => m.agentId !== identity.agentId && (m.nickname ?? "").toLowerCase() === wanted)
        .map((m) => m.agentId);
      if (clashes.length > 0) conflicts.push({ roomId, agentIds: clashes });
    };
    for (const room of this.roomService.listOwnedRooms()) collect(room.roomId, room.members);
    for (const [roomId, client] of this.clients) {
      const members = client.snapshot?.room?.members;
      if (members) collect(roomId, members);
    }

    // Store C: the organisation tree. Cross-plugin, in-process, no HTTP.
    const org = this.ctx.get("agentOrg") as
      | { renameSelfByAgentId?: (agentId: string, nickname: string) => Promise<{ nodeId?: string; rev?: number }> }
      | undefined;
    let orgResult: SelfRenameResult["org"];
    if (!org || typeof org.renameSelfByAgentId !== "function") {
      orgResult = {
        attempted: false,
        updated: false,
        reason:
          'agent-org 服务不可用（ctx.get("agentOrg") 未返回带 renameSelfByAgentId 的服务）：' +
          "A/B 已改，C 未改",
      };
    } else {
      try {
        const out = await org.renameSelfByAgentId(identity.agentId, identity.nickname);
        orgResult = { attempted: true, updated: true, nodeId: out?.nodeId, rev: out?.rev };
      } catch (error) {
        orgResult = {
          attempted: true,
          updated: false,
          reason:
            `${String((error as Error)?.message ?? error)}（A/B 已改，C 未改：` +
            "非 org owner 的机器需由 org owner 执行，见 docs/RELEASE-0.1.40.md）",
        };
      }
    }

    // The local UI reads /state and the members feed. The per-room member update
    // above already emitted `members` through the room-service bus (forwarded to
    // the browser by the listener in the constructor), so only the identity-wide
    // refresh has to be nudged here.
    this.emitBrowser({ kind: "state" });

    return {
      agentId: identity.agentId,
      previousNickname: previous,
      nickname: identity.nickname,
      changed: previous !== identity.nickname,
      identityFile: join(this.config.dataDir, "identity.json"),
      profileFanout,
      ownedRoomMembers,
      nicknameConflicts: conflicts,
      org: orgResult,
    };
  }

  /* --------------------------- peer server ----------------------------- */

  private async ensurePeerServer(): Promise<string> {
    if (this.peerServer) return this.peerServer.address;
    this.peerStarting ??= (async () => {
      const server = new PeerServer({ port: this.config.port, service: this.roomService, relay: this.config.relay });
      const address = await server.start();
      this.peerServer = server;
      this.ctx.logger?.info?.("[agent-room] room server listening on %s", address);
      return address;
    })();
    return this.peerStarting;
  }

  /* --------------------------- bridge truth ---------------------------- */

  /**
   * The ONE writer of the per-room bridge truth (0.1.42) — and it refuses to be
   * written by a client that is no longer the live one.
   *
   * THE DEFECT (card ⑤ / D-19, reproduced twice in BOTH directions). Switching
   * connection mode calls `gateway.joinRoom(...)` for every joined room, which
   * builds a NEW RoomClient, DESTROYS the previous one and registers the new one
   * (`clients.set`). The destroyed client's socket close is asynchronous: its
   * `connection` handler (`room-client.ts:416-425` → "reconnecting", or :452-455
   * where a rejected re-handshake sets "closed") still fires AFTER the new client
   * has already recorded `open`. Both handlers wrote the same Map entry, so the
   * last writer — the DEAD client — won:
   *
   *   小黄 relay → lan:  bridge={kind:"relay",state:"closed",address:"ws://42.193.189.15:9320"}
   *   小麦 lan → relay:  bridge=direct/closed
   *
   * while the channel was demonstrably alive on the other side of the same room
   * (`POST /chat` answered `confirmedByOwner:true, confirmedSeq:2518`). The record
   * was never stale on READ — the reader reads live (`browserState`) — it was
   * stale because a dead connection was allowed to write over a live one.
   *
   * The rule is therefore one line of identity: a RoomClient may only describe
   * itself while it IS the live client for that room. Note the ordering on the
   * fresh-join path — this runs before `clients.set` below, so the first record
   * is accepted because there is no live client for the room yet; every later
   * writer is the one that has to prove it is still current.
   */
  private recordConnInfo(roomId: string, client: RoomClient, state?: string): void {
    const live = this.clients.get(roomId);
    if (live !== undefined && live !== client) {
      this.connDrops += 1;
      return;
    }
    this.connInfo.set(roomId, {
      state: state ?? client.connState,
      viaRelay: client.viaRelay,
      address: client.address,
    });
  }

  /**
   * The bridge truth for a JOINED room: the live client first, then the record,
   * then the room's own advertised address.
   *
   * `connInfo` is authoritative only because `recordConnInfo` keeps the dead
   * clients out of it; reading the live client here as well makes the two agree
   * by construction, so `rooms[].bridge` can never contradict `confirmedByOwner`
   * through a record left over from a connection that no longer exists.
   */
  private joinedBridge(roomId: string, fallbackAddress?: string): {
    kind: "relay" | "direct";
    state: string;
    address: string | undefined;
  } {
    const client = this.clients.get(roomId);
    const info = client
      ? { state: client.connState, viaRelay: client.viaRelay, address: client.address }
      : this.connInfo.get(roomId);
    return {
      kind: info?.viaRelay ? "relay" : "direct",
      state: info?.state ?? "connecting",
      address: info?.address ?? fallbackAddress,
    };
  }

  /* --------------------------- gateway impl ---------------------------- */

  readonly gateway: RoomGateway = {
    // NOT a plain getter: this is the SECOND minting entry point, and agent-org
    // reaches it on every snapshot (dsh-agent-org/src/host/service.js
    // `this.agentRoom?.gateway?.identity?.()`). Since 0.1.38 a damaged
    // identity.json makes this THROW CorruptConfigError instead of minting, so
    // closing boot() alone is no longer sufficient to leave this path safe.
    identity: () => this.roomService.ensureIdentity(),
    // 0.1.40: the ONE supported rename entry point. Deliberately NOT built on
    // `identity()` above, which mints a fresh identity when the cache is empty.
    renameSelf: (nickname) => this.renameSelf(nickname),
    createRoom: (input) => this.roomService.createRoom(input),
    closeRoom: (roomId) => this.roomService.closeRoom(roomId),
    destroyRoom: (roomId) => this.roomService.destroyRoom(roomId),
    listRooms: () => ({
      owned: this.roomService.listOwnedRooms(),
      joined: this.roomService.listJoinedRooms(),
    }),
    roomInfo: async (roomId) => {
      const owned = this.roomService.getOwnedRoom(roomId);
      if (owned) return { room: owned, recentMessages: await this.roomService.recentMessages(roomId), owned: true };
      const client = this.clients.get(roomId);
      if (client?.snapshot) return { room: client.snapshot.room, recentMessages: client.snapshot.recentMessages, owned: false };
      throw new Error(`房间不存在: ${roomId}`);
    },
    joinRoom: async (addresses, options) => {
      const identity = await this.roomService.ensureIdentity();
      const client = new RoomClient({
        addresses,
        roomId: options.roomId,
        password: options.password,
        agent: identity,
        relay: options.relay ?? this.config.relay,
        onJoinedRecord: (record) => this.recordJoinedRecord(record),
      });
      try {
        await client.connect();
      } catch (error) {
        // Never leave an unregistered client behind: the service only tracks it
        // further down, so its close handler would otherwise keep reconnecting
        // in the background with nobody able to stop it.
        client.destroy();
        throw error;
      }
      const roomId = client.currentRoomId;
      if (!roomId) {
        client.destroy();
        throw new Error("加入失败：未获得房间 id");
      }
      /**
       * SELF-JOIN REFUSAL (0.1.36) — the live-client half of the 0.1.34 fix.
       *
       * 0.1.34 stopped a self-join from being RECORDED (`recordJoinedRecord`), but
       * that runs from the client's `onJoinedRecord` callback after the handshake
       * already succeeded, so the socket it refused to remember stayed open. A node
       * holding a live client on a room it serves re-receives every frame it
       * broadcasts, re-emits it on the local bus, and PeerServer broadcasts it
       * again — a store-free cycle that delivered one send 3638 times in 195 ms
       * (measured on 0.1.35, with the owner's store still holding a single row).
       *
       * The room id is the reliable predicate (address matching is only a
       * backstop: a room's published address may be any of this node's NICs). The
       * check happens BEFORE the client is wired into the service, so nothing else
       * needs undoing.
       */
      if (this.roomService.getOwnedRoom(roomId)) {
        client.destroy();
        this.warnRateLimited(
          "selfjoin-live:" + roomId,
          `[agent-room] refusing to join ${roomId}: this node serves that room (self-join would re-broadcast every frame back into the room)`,
        );
        throw new Error(`不能加入本机自己托管的房间（self-join）: ${roomId}`);
      }
      if (this.ownAddresses().has(normaliseAddress(client.address))) {
        client.destroy();
        this.warnRateLimited(
          "selfaddr-live:" + roomId,
          `[agent-room] refusing to join ${roomId} at ${client.address}: that is this node's own address (self-join)`,
        );
        throw new Error(`不能通过本机自己的地址加入房间（self-join）: ${client.address}`);
      }
      // Replacing a client must not LEAK the old one (0.1.36): `clients.set` used
      // to overwrite silently, and every leaked client keeps its socket, its
      // `chat` handler and its sync loop — one more delivery of every frame.
      const previous = this.clients.get(roomId);
      if (previous && previous !== client) {
        try {
          previous.destroy();
        } catch {
          /* best effort: the replacement must still go through */
        }
        this.connReplaced += 1;
        this.warnRateLimited(
          "rejoin-replace:" + roomId,
          `[agent-room] replacing the live client for ${roomId} (a second join leaked the previous one before 0.1.36)`,
        );
      }
      client.on("chat", (message) => {
        // 0.1.39: this handler no longer emits to the browser and no longer calls
        // noteOwnReply — the re-injection below reaches the single emission point
        // (the roomService bus listener), which owns the control-frame filter, the
        // `(roomId, seq)` dedupe and the thinking-state update. Emitting here too
        // is exactly what delivered every inbound frame twice, byte-identical and
        // in the same millisecond, while filtering control frames on this path
        // only.
        //
        // Re-broadcast remote-room messages to the local roomService bus so
        // subscribers (agent-org sync / remote exec) see inbound frames too. This
        // clause must stay: it is the exec plane's only inbound source, control
        // frames included.
        this.roomService.emit("chat", roomId, message);
      });
      client.on("task", (task) => {
        this.emitBrowser({ kind: "task", roomId, task });
        this.roomService.emit("task", roomId, task);
      });
      client.on("system", (event) => {
        this.emitBrowser({ kind: "system", roomId, event });
        this.roomService.emit("system", roomId, event);
      });
      client.on("connection", (state) => {
        this.recordConnInfo(roomId, client, state);
        this.emitBrowser({ kind: "connection", roomId, state });
        // Channel usable again: drain whatever the queue held while it was not.
        if (state === "open") this.flushOutQueue(roomId, "connection-open");
      });
      client.on("snapshot", () => {
        this.emitBrowser({ kind: "state" });
        // A fresh snapshot means the handshake finished — the socket is open even
        // when the "connection" event raced ahead of us.
        this.flushOutQueue(roomId, "snapshot");
      });
      // Line A (card ⑤ / D-19, 0.1.42) + line B (D-18) merged by hand. A's rule is
      // that the join path records the new client at the exact moment it becomes
      // live: `recordConnInfo` runs BEFORE `clients.set`, so this first record is
      // accepted by the "no live client yet" branch, while every later writer has
      // to prove it is still current. B's D-18 handler is therefore registered
      // BEFORE that pair rather than between the two lines — inserting it in the
      // middle would break the adjacency the ordering rule depends on (and A's
      // static guard asserts). Registration is synchronous and the handler body
      // only reads `this.clients` when the event fires, i.e. after `clients.set`,
      // so the handler behaves exactly as it did on line B.
      // D-18 (runtime half, 0.1.42): the owner ANSWERED and refused the re-join.
      // That is the join result the cleanup rule decides on, so the local record
      // goes now — previously the client gave up silently and joined.json kept a
      // dead room until the next boot or a connection-mode switch. Only a client
      // that HAD connected can emit this (a never-connected one is an orphan and
      // never schedules a reconnect), so the record being dropped is one this node
      // really was a member of, and the refusal means membership is gone or the
      // room is full/closed — nothing a retry can restore.
      client.on("joinRejected", (rejectedRoomId, message) => {
        const target = rejectedRoomId || roomId;
        const live = this.clients.get(target);
        if (live === client) {
          this.clients.delete(target);
          this.connInfo.delete(target);
        }
        // The client stopped its own retry loop (RoomClient.stopRetrying); destroy
        // it here too so nothing of a permanently unusable room stays attached.
        try {
          client.destroy();
        } catch {
          /* best effort */
        }
        this.outbound.drop(target);
        void this.forgetJoinedRoom(target, `re-join refused by the owner: ${message}`)
          .then(() => this.emitBrowser({ kind: "state" }));
      });
      // A's guarded writer must stay adjacent to `clients.set` (see the comment
      // above the D-18 handler): record first, then go live.
      this.recordConnInfo(roomId, client);
      this.clients.set(roomId, client);
      this.flushOutQueue(roomId, "joined");
      this.ctx.logger?.info?.("[agent-room] joined room %s at %s", roomId, client.address);
      return { roomId, title: client.snapshot?.room.title ?? "" };
    },
    leaveRoom: async (roomId) => {
      if (this.roomService.getOwnedRoom(roomId)) {
        await this.roomService.closeRoom(roomId);
        return;
      }
      const client = this.clients.get(roomId);
      let remoteError: string | undefined;
      if (client) {
        try {
          await client.leave();
        } catch (error) {
          // Best-effort: the owner may be gone, or the socket may never have
          // opened. That must not stop local cleanup (0.1.34).
          remoteError = error instanceof Error ? error.message : String(error);
        }
        this.clients.delete(roomId);
        this.connInfo.delete(roomId);
        // Ring state for a room we no longer belong to is dead weight (same
        // reasoning as the outbound queue drop below).
        this.dedupe.forget(roomId);
        // The WAKE watermark is deliberately NOT forgotten here (0.1.41), unlike
        // `listenSeen`, which setListening()/leave DO delete (above). Both of those
        // re-seed the cursor from THIS node's 20-message window — the regressed
        // tail that caused card 04 — so re-listening is exactly the moment the
        // monotonic watermark has to still be there. Forgetting it would rebuild
        // the defect on the first re-listen. The 128-room cap bounds it instead.
      }
      // Pending frames for a room we are leaving are moot; drop them instead of
      // replaying them into a room we no longer belong to.
      this.outbound.drop(roomId);
      // Leaving must ALWAYS forget the record locally. It used to throw
      // "房间不存在" (HTTP 500) when there was no live client — which is exactly
      // the dead-room case the user was trying to clean up.
      const removed = await this.forgetJoinedRoom(roomId, remoteError ? `leave failed: ${remoteError}` : "left");
      if (remoteError) {
        this.warnRateLimited(
          "leave:" + roomId,
          `[agent-room] remote leave of ${roomId} failed (${remoteError}); local record removed=${removed}`,
        );
      }
      if (!client && !removed) throw new Error(`房间不存在: ${roomId}`);
    },
    kickMember: (roomId, agentId) => this.roomService.removeMember(roomId, agentId),
    revokeMember: async (roomId, agentId, reason) => {
      const identity = await this.roomService.ensureIdentity();
      return this.roomService.revokeMember(roomId, identity, agentId, reason);
    },
    unrevokeMember: async (roomId, agentId) => {
      const identity = await this.roomService.ensureIdentity();
      return this.roomService.unrevokeMember(roomId, identity, agentId);
    },
    sendChat: async (roomId, input) => {
      const owned = this.roomService.getOwnedRoom(roomId);
      if (owned) {
        const identity = await this.roomService.ensureIdentity();
        const message = await this.roomService.addChatMessage(roomId, identity, input);
        // 0.1.46: every send path funnels through HERE, so this is where the receipt
        // expectation is opened — no caller can forget it (see registerAckExpectation).
        this.registerAckExpectation(roomId, input, message?.seq);
        return message;
      }
      const client = this.clients.get(roomId);
      if (!client) throw new Error(`房间不存在: ${roomId}`);
      // Joined room: NOT an authoritative write, so the honest answer is a
      // delivery status. This used to be `client.sendChat(input); return null;`
      // — no confirmation at all, so a frame dropped on a socket that was not
      // OPEN was indistinguishable from success and the sender never retried.
      const outcome = this.outbound.send(roomId, input, client);
      const status = toDeliveryStatus(outcome);
      // 0.1.35: accepted-by-local-hub is NOT delivery. Wait a bounded time for the
      // owner to echo the message back with its own seq; only that echo proves the
      // owner has it. Field data showed three frames reported "delivered" while
      // the owner never stored them, and three others that did arrive — the sender
      // had no way to tell which case it was in. Now it does.
      if (status.acceptedByLocalHub && typeof client.awaitOwnerEcho === "function") {
        const seq = await client.awaitOwnerEcho(input.text, OWNER_CONFIRM_WAIT_MS);
        if (typeof seq === "number" && seq > 0) {
          status.confirmedByOwner = true;
          status.confirmedSeq = seq;
          status.confirmNote = "owner-confirmed";
        } else {
          status.confirmedByOwner = false;
          status.confirmNote = "not-confirmed-in-time";
          this.warnRateLimited(
            "unconfirmed:" + roomId,
            `[agent-room] room ${roomId}: message accepted by the local hub but NOT confirmed by the owner ` +
              `within ${OWNER_CONFIRM_WAIT_MS}ms (channel=${client.connState}${client.viaRelay ? ", via relay" : ""}) — ` +
              "it may never have reached the room",
          );
        }
      }
      if (outcome.delivered) {
        // 0.1.46: a joined-room send is tracked too, but ONLY once the owner confirmed a
        // real seq — the receipt a target writes names that seq, so an expectation
        // opened on a guess could never be matched (it would report a phantom absence).
        this.registerAckExpectation(roomId, input, status.confirmedSeq);
        return status;
      }
      if (outcome.queued) {
        this.warnRateLimited(
          "queued:" + roomId,
          `[agent-room] channel for ${roomId} is not open: queued control frame (${outcome.queueLength} pending)`,
        );
      } else if (outcome.reason?.startsWith("queue-full")) {
        // The queue refused the NEW frame on purpose: the oldest in-flight
        // control frame is never dropped, so this one has to be reported and
        // retried by the caller instead.
        this.warnRateLimited(
          "queuefull:" + roomId,
          `[agent-room] control-frame queue for ${roomId} is full (${outcome.reason}): NEW frame REJECTED, retry later`,
        );
      } else {
        this.warnRateLimited(
          "dropped:" + roomId,
          `[agent-room] channel for ${roomId} is not open: chat frame dropped (not queueable) — reported to the sender`,
        );
      }
      return status;
    },
    wakePreview: (roomId, input) => this.wakePreviewFor(roomId, input),
    updateSettings: (roomId, patch) => this.roomService.updateSettings(roomId, patch),
    transferController: (roomId, toAgentId) => this.roomService.transferController(roomId, toAgentId),

    taskCreate: async (roomId, input: TaskInput) => {
      const owned = this.roomService.getOwnedRoom(roomId);
      if (owned) {
        const identity = await this.roomService.ensureIdentity();
        return this.roomService.createTask(roomId, identity, input);
      }
      const client = this.clients.get(roomId);
      if (!client) throw new Error(`房间不存在: ${roomId}`);
      client.taskCreate(input);
      return this.projectedTask(client, input.title);
    },
    taskList: async (roomId, status) => {
      const owned = this.roomService.getOwnedRoom(roomId);
      if (owned) return this.roomService.listTasks(roomId).filter((t) => !status || t.status === status);
      const client = this.clients.get(roomId);
      if (!client?.snapshot) throw new Error(`房间不存在: ${roomId}`);
      return client.snapshot.room.tasks.filter((t) => !status || t.status === status);
    },
    taskAssign: (roomId, taskId, assignee) => this.ownedOrProxy(roomId, (identity) => this.roomService.assignTask(roomId, identity, taskId, assignee), (client) => { client.taskAssign(taskId, assignee); return this.projectedTask(client, undefined, taskId); }),
    taskClaim: (roomId, taskId) => this.ownedOrProxy(roomId, (identity) => this.roomService.claimTask(roomId, identity, taskId), (client) => { client.taskClaim(taskId); return this.projectedTask(client, undefined, taskId); }),
    taskComment: (roomId, taskId, text) => this.ownedOrProxy(roomId, (identity) => this.roomService.commentTask(roomId, identity, taskId, text), (client) => { client.taskComment(taskId, text); return this.projectedTask(client, undefined, taskId); }),
    taskStatus: (roomId, taskId, status) => this.ownedOrProxy(roomId, (identity) => this.roomService.setTaskStatus(roomId, identity, taskId, status), (client) => { client.taskStatus(taskId, status); return this.projectedTask(client, undefined, taskId); }),
    taskComplete: (roomId, taskId, note) => this.ownedOrProxy(roomId, (identity) => this.roomService.completeTask(roomId, identity, taskId, note), (client) => { client.taskComplete(taskId, note); return this.projectedTask(client, undefined, taskId); }),
    taskApprove: (roomId, taskId, note) => this.ownedOrProxy(roomId, (identity) => this.roomService.approveTask(roomId, identity, taskId, note), (client) => { client.taskApprove(taskId, note); return this.projectedTask(client, undefined, taskId); }),
    taskReject: (roomId, taskId, note) => this.ownedOrProxy(roomId, (identity) => this.roomService.rejectTask(roomId, identity, taskId, note), (client) => { client.taskReject(taskId, note); return this.projectedTask(client, undefined, taskId); }),
    taskReopen: (roomId, taskId) => this.ownedOrProxy(roomId, (identity) => this.roomService.reopenTask(roomId, identity, taskId), (client) => { client.taskReopen(taskId); return this.projectedTask(client, undefined, taskId); }),
    taskDelete: async (roomId, taskId) => {
      const owned = this.roomService.getOwnedRoom(roomId);
      if (owned) {
        const identity = await this.roomService.ensureIdentity();
        this.roomService.deleteTask(roomId, identity, taskId);
        return;
      }
      const client = this.clients.get(roomId);
      if (!client) throw new Error(`房间不存在: ${roomId}`);
      client.taskRemove(taskId);
    },
    taskHandoff: (roomId, taskId, handoff) => this.ownedOrProxy(roomId, (identity) => this.roomService.setTaskHandoff(roomId, identity, taskId, handoff), (client) => { client.taskHandoff(taskId, handoff); return this.projectedTask(client, undefined, taskId); }),
    setMemberRoles: async (roomId, roles) => {
      const identity = await this.roomService.ensureIdentity();
      if (this.roomService.getOwnedRoom(roomId)) {
        this.roomService.setMemberRoles(roomId, identity, roles);
        return;
      }
      // Joined room: push the role change through the client to the owner.
      const client = this.clients.get(roomId);
      if (!client) throw new Error(`房间不存在: ${roomId}`);
      client.sendProfile({ nickname: identity.nickname, capabilities: identity.capabilities, roles });
    },
    assignMemberRoles: async (roomId, targetAgentId, roles) => {
      const identity = await this.roomService.ensureIdentity();
      this.roomService.assignMemberRoles(roomId, identity, targetAgentId, roles);
    },
    setMemberCapabilities: async (roomId, capabilities) => {
      const identity = await this.roomService.ensureIdentity();
      if (this.roomService.getOwnedRoom(roomId)) {
        this.roomService.setMemberCapabilities(roomId, identity, capabilities);
        return;
      }
      const client = this.clients.get(roomId);
      if (!client) throw new Error(`房间不存在: ${roomId}`);
      client.sendProfile({ nickname: identity.nickname, manualCapabilities: capabilities });
    },
    suggestCandidates: async (roomId, caps, roles) => {
      const owned = this.roomService.getOwnedRoom(roomId);
      if (owned) return this.roomService.suggestCandidates(roomId, caps, roles);
      const client = this.clients.get(roomId);
      if (!client?.snapshot) return [];
      return client.snapshot.room.members.map((m) => ({ agentId: m.agentId, nickname: m.nickname, score: 0, roleMatch: 0 }));
    },
  };

  private async ownedOrProxy(
    roomId: string,
    owned: (identity: AgentIdentity) => Promise<Task> | Task,
    proxy: (client: RoomClient) => Promise<Task> | Task,
  ): Promise<Task> {
    const isOwned = this.roomService.getOwnedRoom(roomId) !== undefined;
    if (isOwned) {
      const identity = await this.roomService.ensureIdentity();
      return owned(identity);
    }
    const client = this.clients.get(roomId);
    if (!client) throw new Error(`房间不存在: ${roomId}`);
    return proxy(client);
  }

  private projectedTask(client: RoomClient, title?: string, taskId?: string): Task {
    const tasks = client.snapshot?.room.tasks ?? [];
    if (taskId) {
      const found = tasks.find((t) => t.taskId === taskId);
      if (found) return found;
    } else if (title) {
      const found = tasks.find((t) => t.title === title);
      if (found) return found;
    }
    throw new Error(`任务操作已发送，等待房主节点同步（可用 task_list 查看最新状态）`);
  }

  /* --------------------------- relay config ---------------------------- */

  /**
   * Load the persisted relay address (0.1.38).
   *
   * MISSING -> first run, nothing persisted (unchanged). PRESENT but unparseable
   * -> CorruptConfigError. A BOM here used to mean the relay address silently
   * vanished and the node dropped off every relayed room with no diagnostic.
   */
  private async loadRelayConfig(): Promise<void> {
    const data = await readJsonConfig<{ relay?: string | null }>(this.relayConfigFile);
    if (data) {
      // A persisted file wins over config/env so the UI change survives restarts.
      this.config.relay = typeof data.relay === "string" && data.relay.trim() ? data.relay : undefined;
    }
    this.relayConfigured = Boolean(this.config.relay);
  }

  /** Set (or clear) the cross-network relay address; persists to disk and re-bridges owned rooms. */
  async setRelayConfig(relay?: string): Promise<string | undefined> {
    const next = relay?.trim() || undefined;
    this.config.relay = next;
    this.relayConfigured = Boolean(next);
    try {
      await writeFile(this.relayConfigFile, JSON.stringify({ relay: next ?? null }, null, 2), "utf8");
    } catch (error) {
      this.ctx.logger?.warn?.("[agent-room] failed to persist relay config: %s", String(error));
    }
    if (this.peerServer) this.peerServer.setRelay(next);
    this.refreshRelayBridge();
    this.emitBrowser({ kind: "state" });
    return next;
  }

  getRelayConfig(): { address?: string; configured: boolean } {
    return { address: this.config.relay, configured: this.relayConfigured };
  }

  /**
   * Direct-LAN addresses to offer the join path when switching to "lan", best-first.
   *
   * The join API accepts multiple candidates and tries them in order, so a
   * superset is safe: a candidate that does not answer costs one timeout, not a
   * failure. That is exactly what makes this switch survivable when the
   * advertised address belongs to a virtual adapter (192.168.137.1) that no
   * other machine can reach.
   *
   * Order: manual address -> addresses seen in LAN beacons -> this node's own
   * interface candidates.
   */
  private lanCandidates(manual?: string): string[] {
    const out: string[] = [];
    // A ws:// entry is the relay, never a direct candidate — handing one to a
    // "lan" join would silently land the room back on the relay.
    const push = (value: unknown): void => {
      if (typeof value !== "string") return;
      const trimmed = value.trim();
      if (trimmed && !/^wss?:\/\//i.test(trimmed)) out.push(trimmed);
    };
    push(manual);
    // Beacons are loosely typed on purpose: older nodes advertise `address`,
    // current ones `addresses[]`, and a v1 beacon must not break the switch.
    for (const beacon of (this.discovery?.discovered() ?? []) as unknown as Array<Record<string, unknown>>) {
      push(beacon["address"]);
      const list = beacon["addresses"];
      if (Array.isArray(list)) for (const item of list) push(item);
    }
    for (const candidate of this.peerServer?.candidates ?? []) push(candidate);
    return [...new Set(out)];
  }

  /**
   * One-click switch between the relay and direct-LAN connection mode.
   *
   * BOTH halves must happen in the same server-side call: writing relay-config
   * alone leaves a mixed state where some rooms are direct and others still
   * relay (observed in the field — the node dropped every ~14s), so every
   * joined room is re-joined with addresses matching the new mode. Owned rooms
   * are skipped: this node serves them, and their bridge follows relay-config.
   *
   * Note for future work: the relay config is currently a bare address because
   * the relay is our own and needs no credentials. Supporting third-party
   * relays would extend it to { address, account?, token? } — not implemented
   * here on purpose.
   */
  async setConnectionMode(mode: "lan" | "relay", manualAddress?: string): Promise<{
    mode: "lan" | "relay";
    relay: string | undefined;
    addresses: string[];
    rooms: Array<{ roomId: string; title: string; ok: boolean; cleaned?: boolean; error?: string }>;
  }> {
    const relayUrl = (this.config.relay ?? "").trim();
    if (mode === "relay" && !relayUrl) {
      throw new Error("未配置中继地址，无法切换到中继：请先填写中继地址");
    }
    const relay = await this.setRelayConfig(mode === "relay" ? relayUrl : "");
    const addresses = mode === "relay" ? [relayUrl] : this.lanCandidates(manualAddress);
    if (addresses.length === 0) {
      throw new Error("没有可用的局域网地址：请手动填写 host:port（例如 192.168.31.x:9317）后重试");
    }

    const rooms: Array<{ roomId: string; title: string; ok: boolean; cleaned?: boolean; error?: string }> = [];
    // Records we must keep in joined.json. A record whose room is gone is dropped
    // from the list instead of kept-and-retried: it would otherwise report a
    // frightening "join rejected: room-not-found" on every mode switch forever,
    // which reads as a broken switch even though every live room rejoined fine.
    const keepRecords: JoinedRoomRecord[] = [];
    let cleanedCount = 0;
    for (const record of this.roomService.listJoinedRooms()) {
      const title = record.title ?? this.clients.get(record.roomId)?.snapshot?.room.title ?? record.roomId;
      if (this.roomService.getOwnedRoom(record.roomId)) {
        keepRecords.push(record);
        continue;
      }
      try {
        await this.gateway.joinRoom(addresses, { roomId: record.roomId });
        keepRecords.push(record);
        rooms.push({ roomId: record.roomId, title, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isStaleRoomError(message)) {
          // Room closed or never existed: prune the record, count it as cleaned
          // rather than failed, and let the UI say so.
          cleanedCount += 1;
          rooms.push({ roomId: record.roomId, title, ok: true, cleaned: true });
        } else {
          keepRecords.push(record);
          rooms.push({ roomId: record.roomId, title, ok: false, error: message });
        }
      }
    }
    if (cleanedCount > 0) {
      try {
        await this.roomService.replaceJoinedRooms(keepRecords);
        this.ctx.logger?.info?.(
          "[agent-room] pruned %d closed/absent room record(s) while switching to %s", cleanedCount, mode,
        );
      } catch (error) {
        this.ctx.logger?.warn?.("[agent-room] failed to prune stale joined rooms: %s", String(error));
      }
    }

    this.emitBrowser({ kind: "state" });
    const live = rooms.filter((room) => !room.cleaned);
    const okCount = live.filter((room) => room.ok).length;
    this.ctx.logger?.info?.(
      "[agent-room] connection mode -> %s (relay=%s, addresses=%s, rejoined %d/%d, cleaned %d)",
      mode,
      relay ?? "(cleared)",
      addresses.join(", "),
      okCount,
      live.length,
      cleanedCount,
    );
    return { mode, relay, addresses, rooms };
  }

  private refreshRelayBridge(): void {
    if (!this.peerServer) return;
    for (const room of this.roomService.listOwnedRooms()) {
      this.relayBridge.set(room.roomId, this.peerServer.relayStatus(room.roomId));
    }
  }

  /* --------------------------- browser push ---------------------------- */

  /** Subscribe to browser push events (SSE); returns an unsubscribe function. */
  onBrowserEvent(listener: (event: BrowserEvent) => void): () => void {
    this.browserListeners.add(listener);
    return () => this.browserListeners.delete(listener);
  }

  private emitBrowser(event: BrowserEvent): void {
    for (const listener of this.browserListeners) {
      try {
        listener(event);
      } catch {
        /* listener errors must not break the room loop */
      }
    }
  }

  /* --------------------------- browser state --------------------------- */

  /** Full state snapshot for the browser UI. */
  async browserState(): Promise<unknown> {
    const identity = await this.roomService.ensureIdentity();
    const owned = this.roomService.listOwnedRooms();
    const joinedRooms = [...this.clients.entries()]
      .filter(([, client]) => client.snapshot !== null)
      .map(([, client]) => client.snapshot!.room);

    const joinedLatest = new Map<string, number>();
    for (const [roomId, client] of this.clients) {
      // 0.1.35: prefer the OWNER's reported latest visible seq. Deriving this from
      // our own mirror (as 0.1.34 did) is circular — a mirror that is missing
      // messages reports a smaller number and therefore never shows the lag, which
      // is precisely how the missing-message defect stayed invisible.
      const ownerLatest = client.syncState().ownerLatestChatSeq;
      joinedLatest.set(roomId, ownerLatest > 0 ? ownerLatest : client.localLatestSeq());
    }
    const rooms: Array<Record<string, unknown>> = [];
    const seenRooms = new Set<string>();
    for (const room of [...owned, ...joinedRooms]) {
      // A room can be both owned and joined (this node may have joined a room it
      // hosts, e.g. its own sync room through the relay). List it once — the
      // owner's view is the authoritative one.
      if (seenRooms.has(room.roomId)) continue;
      seenRooms.add(room.roomId);
      const isOwned = room.ownerAgentId === identity.agentId;
      // Read the bridge status LIVE. This used to read a cache populated by
      // refreshRelayBridge(), which only runs on boot and on relay-config
      // changes — so the field froze at whatever was true at that instant and
      // reported "connecting" forever on a perfectly healthy bridge. A
      // diagnostic that lies is worse than no diagnostic: it sent an entire
      // outage hunt down the wrong path.
      //
      // 0.1.42 (card ⑤ / D-19): the JOINED half of this used to read `connInfo`
      // alone, and `connInfo` accepted writes from RoomClients that had already
      // been replaced — so after a relay ⇄ lan switch it described the dead
      // connection while the live one was healthy (小黄 relay→lan reported
      // `relay/closed` at `ws://42.193.189.15:9320` while `/chat` answered
      // `confirmedByOwner:true`). `joinedBridge()` derives the field from the
      // live client, and `recordConnInfo()` no longer lets a dead client write.
      const bridgeState = isOwned
        ? (this.peerServer?.relayStatus(room.roomId) ?? this.relayBridge.get(room.roomId) ?? "none")
        : undefined;
      const bridge = isOwned
        ? { kind: (bridgeState === "none" ? "none" : "relay") as "none" | "relay", state: bridgeState ?? "none", address: this.config.relay }
        : this.joinedBridge(room.roomId, room.serverAddress);
      const latestSeq = isOwned
        ? ((await this.roomService.recentMessages(room.roomId, 1))[0]?.seq ?? 0)
        : (joinedLatest.get(room.roomId) ?? 0);
      const client = this.clients.get(room.roomId);
      rooms.push({
        roomId: room.roomId,
        title: room.title,
        type: room.type,
        status: room.status,
        owned: isOwned,
        authMode: room.settings.authMode,
        autoMode: room.settings.autoMode,
        allowHumanTakeover: room.settings.allowHumanTakeover,
        controllerAgentId: room.controllerAgentId,
        serverAddress: isOwned ? this.peerServer?.address ?? room.serverAddress : room.serverAddress,
        memberCount: room.members.length,
        members: room.members,
        tasks: room.tasks,
        revoked: room.revoked ?? [],
        activateThinking: this.activateThinkingRooms.has(room.roomId),
        listening: this.listeningRooms.has(room.roomId),
        latestSeq,
        // Convergence diagnostics (0.1.35). For a joined room, `latestSeq` is the
        // owner-reported target and `localLatestSeq` is what this node actually
        // holds: while they differ the room is still catching up, and the panel can
        // say so instead of pretending the mirror is complete.
        localLatestSeq: isOwned ? latestSeq : (client?.localLatestSeq() ?? 0),
        sync: isOwned ? undefined : client?.syncState(),
        // Owner availability + join diagnostics (D-49). Without this, an owner outage and a broken
        // link look the same from outside — and the cost of that blindness is on record: 68 join
        // attempts, 601 buffered joins and 1608 timeout closes against one member on 2026-09-16.
        join: isOwned ? undefined : client?.joinDiagnostics(),
        bridge,
      });
    }
    const discovered: RoomBeacon[] = this.discovery?.discovered() ?? [];
    return {
      identity,
      node: { hostname: hostname(), addresses: this.peerServer?.candidates ?? [] },
      relay: { address: this.config.relay, configured: this.relayConfigured },
      discovered,
      // Delivery-level dedupe diagnostics (0.1.39). `skipped` alone is not
      // enough: `evicted` growing alongside repeat deliveries is what says "the
      // ring is too small", and `roomResets` says the room cap was hit.
      dedupe: this.dedupe.stats(),
      // Wake-plane dedupe diagnostics (0.1.41) — same shape as the delivery
      // plane's block above. `skipped` is the fix working; `regressed` must stay 0
      // (a climbing value means the watermark was bypassed); `roomResets` says the
      // 128-room cap was reached, which costs at most one extra wake per room.
      wake: this.wakeWatermark.stats(),
      // ACK plane (0.1.46) — the receipt that 0.1.45's `wake` block could not give.
      // READ IT AS: `receiptsPosted` = "machines that took MY dispatch"; sender role
      // `ackedTargets` / `unackedTargets` / `maxAckedObservedSeq` = "did the machines I
      // addressed actually take it". `wake.wokenByMention` counts dispatches; this block
      // counts deliveries. Flat numbers only, same shape as `wake`.
      ack: this.ackLedger.stats(),
      // ACTIVATION chain (0.1.47) — the step 0.1.45's `wake` and 0.1.46's `ack` both stop
      // short of. READ IT AS: `dispatches` → `accepted` → `started`/`startedBy*` → `outputs`
      // is the chain; the rest is what went wrong at which step:
      //   `noResidentAgent` + `resolvedViaNone` (every other `resolvedVia*` at 0)  ⇒ this
      //        machine is STRUCTURALLY unable to accept work — 小黄's case, readable here.
      //   `followupRefused`                                                        ⇒ nothing was handed over.
      //   `escalationsAttempted/Succeeded/Failed`                                  ⇒ the self-activation.
      //   `acceptedNoOutput`                                                       ⇒ accepted, then silence
      //        inside the window (小麦's "dispatching followup … and then nothing").
      activation: this.activation.stats(),
      // Bridge-truth diagnostics (0.1.42, card ⑤ / D-19). `connDrops` counts
      // status reports REFUSED because the reporting client had already been
      // replaced — a non-zero value is the fix working, not a fault; it used to
      // be an unobservable overwrite of the field. `connReplaced` counts the
      // joins that replaced a live client (one per room per mode switch), which
      // is the moment those stale reports begin.
      bridgeTruth: { connDrops: this.connDrops, connReplaced: this.connReplaced, tracked: this.connInfo.size },
      rooms,
    };
  }

  /**
   * Recent messages for one room (owned via store, joined via local projection).
   *
   * The joined projection already MERGES the owner's confirmed stream with the
   * messages this node appended locally (RoomClient.appendLocal): the confirmed
   * ones carry real seqs, the local ones are `pending` with a negative seq. That
   * is what lets a sender see its own message — and, once the owner echoes it,
   * its seq — without rejoining, and lets a member read the owner's recent
   * messages without rejoining either.
   */
  async browserMessages(roomId: string, limit = 200, before?: number): Promise<ChatMessage[]> {
    const owned = this.roomService.getOwnedRoom(roomId);
    if (owned) return this.roomService.recentMessages(roomId, limit, before);
    const client = this.clients.get(roomId);
    const all = client?.snapshot?.recentMessages ?? [];
    // Paging into history must not resurface local messages: their negative seq
    // would sort below every real one and they are the tail, not the past.
    const filtered = before === undefined
      ? all
      : all.filter((m) => !m.pending && m.seq < before);
    return filtered.slice(-limit);
  }
}

/* ------------------------- activate-chat prompt ------------------------ */

/**
 * Build the context prompt for a one-shot activate-chat reply: identity, role,
 * open tasks, and the recent message stream so the agent can reply relevantly
 * (quoting prior chat / tasks / @mentions).
 */
function buildActivatePrompt(input: {
  roomId: string;
  title: string;
  identity: AgentIdentity;
  role: string;
  recent: ChatMessage[];
  tasks: Task[];
}): string {
  const lines: string[] = [];
  lines.push(`你在房间「${input.title}」（roomId: ${input.roomId}）中被手动激活聊天，请基于房间上下文自然回复一条相关内容。`);
  lines.push(`你的身份：${input.identity.nickname}（agentId: ${input.identity.agentId}，角色: ${input.role}，能力: ${input.identity.capabilities.join("、") || "无"}）。`);
  if (input.tasks.length > 0) {
    lines.push(`当前任务（${input.tasks.length} 个）：`);
    for (const t of input.tasks.slice(0, 10)) {
      const assignee = t.assignee ? `（负责人: ${t.assignee}）` : "";
      const acceptance = t.acceptance ? ` 验收: ${t.acceptance}` : "";
      lines.push(`- [${t.status}] ${t.title}${assignee}${acceptance}`);
    }
  } else {
    lines.push("当前房间没有任务。");
  }
  if (input.recent.length > 0) {
    lines.push(`最近消息（3 条）：`);
    for (const m of input.recent.slice(0, 3)) {
      const human = m.human ? " [人类]" : "";
      const mention = m.mentions && m.mentions.length > 0 ? ` @[${m.mentions.join(",")}]` : "";
      lines.push(`- ${m.fromNickname}${human}: ${m.text}${mention}`);
    }
  } else {
    lines.push("房间还没有消息。");
  }
  lines.push("请用 room_send 工具向该房间发送一条与上下文相关、自然简短的中文回复（可引用之前的聊天、任务或 @提及成员）。");
  lines.push(sendFallbackLine(input.roomId));
  return lines.join("\n");
}

/* --------------------------- listening prompt --------------------------- */

/**
 * Build the wake prompt for the listening flow. Unlike activate-chat this must
 * NOT force a reply: the agent is asked to judge whether the message needs it,
 * and stay completely silent (no tool calls) when it does not. This is the
 * cheap-judge + executor combined; a separate small-model judge is a v2 option
 * if the real token burn ever gets high.
 */
function buildListenPrompt(input: {
  roomId: string;
  title: string;
  identity: AgentIdentity;
  message: ChatMessage;
  recent: ChatMessage[];
}): string {
  const m = input.message;
  // 0.1.41: the label is DERIVED from the same rule the wake plane decides with
  // (`src/host/wake.ts`), never a constant. It used to be the literal
  // "人类发言（远程指挥，最高优先级）" for EVERY message, which is how this node's
  // own bot/browser message arrived at this node described as a remote human
  // order (card 04 seq 315). One rule, one label — they cannot drift again.
  const kind = wakeKindLabel(listenAuthorKind(m, input.identity.agentId));
  const lines: string[] = [];
  lines.push(`你在房间「${input.title}」（roomId: ${input.roomId}）的监听中收到一条需要关注的消息（${kind}）。`);
  lines.push(`消息：${m.fromNickname} 说：「${m.text.slice(0, 500)}」`);
  lines.push(`你的身份：${input.identity.nickname}（agentId: ${input.identity.agentId}）。`);
  const ctx = input.recent.slice(-6);
  if (ctx.length > 0) {
    lines.push("最近对话（上下文）：");
    for (const r of ctx) lines.push(`- ${r.fromNickname}${r.human ? " [人类]" : ""}: ${r.text.slice(0, 120)}`);
  }
  lines.push("请判断这条消息是否需要你回应或处理：");
  lines.push("- 需要：用 room_send 工具自然、简短地回复；如果是要办事（比如统计、查数据、建任务），先回复认领再动手。");
  lines.push(sendFallbackLine(input.roomId));
  lines.push("- 不需要（闲聊、已经解决、与你无关）：不要调用任何工具，保持沉默即可。");
  return lines.join("\n");
}

/** Fallback instruction when room_send is not available in the session:
 *  reply through the local web API via pwsh (always present). */
function sendFallbackLine(roomId: string): string {
  return (
    `如果没有 room_send 工具，改用 pwsh 执行 PowerShell 发送回复：` +
    `Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3080/agent-room-api/rooms/${roomId}/chat' ` +
    `-ContentType 'application/json; charset=utf-8' -Body (@{ text = '你的回复'; human = $false } | ConvertTo-Json)。`
  );
}

/* --------------------------- stale joined records --------------------------- */

/**
 * Does this join error mean the recorded room no longer exists (closed or
 * deleted) rather than a transient network problem?
 *
 * Only these are treated as stale. A timeout, a refused connection or a wrong
 * password must NOT prune the record — the room may be perfectly alive and we
 * would be silently forgetting it. Both the protocol codes and the Chinese
 * messages carry the signal, depending on whether the failure came from a remote
 * owner (protocol code) or the local server (thrown message).
 */
export function isStaleRoomError(message: string): boolean {
  return /room-not-found|room-closed|房间不存在|房间已关闭|room not found|room closed/i.test(message);
}

/**
 * Normalise an address for equality comparisons.
 *
 * Joined records store either a direct `host:port` or a relay URL
 * (`ws://host:port`), so "is this address me?" must ignore the scheme, any path
 * and trailing slashes — otherwise a self-join slips through and every frame is
 * delivered twice.
 */
export function normaliseAddress(value: unknown): string {
  if (typeof value !== "string") return "";
  let text = value.trim().toLowerCase();
  if (!text) return "";
  text = text.replace(/^[a-z]+:\/\//, "");
  text = text.replace(/\/+$/, "");
  const pathIndex = text.indexOf("/");
  if (pathIndex >= 0) text = text.slice(0, pathIndex);
  return text;
}

