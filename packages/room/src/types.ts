/**
 * dsh-agent-room — shared domain types.
 * These types are plain data; both host and client (and the wire protocol) use them.
 */

/** A persistent identity for one DSH instance (one agent node). */
export interface AgentIdentity {
  /** Immutable unique id (UUIDv7), generated on first activation. */
  agentId: string;
  /** Display name; defaults to hostname. */
  nickname: string;
  /** Capability tags: auto-collected (skills/tools) plus manual additions. */
  capabilities: string[];
  /** Optional one-line bio. */
  bio?: string;
  createdAt: string;
}

/** Join authorization modes. */
export type AuthMode = "open" | "password";

/** Room persistence kinds. */
export type RoomType = "persistent" | "temporary";

/** Lifecycle states. */
export type RoomStatus = "open" | "suspended" | "closed";

export interface RoomSettings {
  authMode: AuthMode;
  /** scrypt salted hash; non-null only when authMode === "password". */
  passwordHash?: string;
  /** Autonomous mode: agents confirm task completion themselves. */
  autoMode: boolean;
  maxMembers: number;
  allowHumanTakeover: boolean;
}

export type MemberRole = "owner" | "member";

/** Workflow role a member declares (lightweight role card). */
export type RoleKey = "observer" | "controller" | "researcher" | "executor" | "reviewer";

export interface Member {
  agentId: string;
  nickname: string;
  role: MemberRole;
  joinedAt: string;
  /** Auto-collected capability tags (skills/tools), used for candidate suggestions. */
  capabilities?: string[];
  /** Manually declared capability tags (business skills like 前端/后端). */
  manualCapabilities?: string[];
  /** Workflow roles the member declares (e.g. executor, reviewer). */
  roles?: RoleKey[];
  /**
   * LIVENESS (D-20, 0.1.42) — the last time the room owner received a frame from
   * this member (`touchMember`, called from the single member-frame funnel in
   * peer-server.ts). Deliberately NOT `joinedAt`: an admission timestamp cannot
   * distinguish "off duty" from "plugin wedged", which is what cost one
   * investigation three exec timeouts (45s/25s/25s) and a human answer.
   *
   * ISO-8601 UTC, same shape as every other timestamp here. Absent for records
   * written by an older node (and for members that have not spoken since the
   * upgrade): a reader MUST treat "missing" as "unknown", never as "offline".
   */
  lastSeenAt?: string;
  /** Address this member was last seen from (direct host:port or relay URL).
   *  Also the field a re-join updates in place — see D-21. */
  lastSeenAddress?: string;
  /** Last exec result this member reported through the room (`[org:exec:result]`). */
  lastExecAt?: string;
  /** Whether that last exec succeeded (`ok`), so "reachable" is distinguishable
   *  from "reachable and able to run commands". */
  lastExecOk?: boolean;
}

export type TaskStatus = "todo" | "doing" | "review" | "done" | "rejected";

export interface TaskComment {
  agentId: string;
  ts: string;
  text: string;
}

export interface TaskJudge {
  /** controller: judged by the task/room controller; auto: executor confirms. */
  mode: "controller" | "auto";
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

/** Structured handoff card: what's done, on what basis, what's next, risks. */
export interface TaskHandoff {
  done: string;
  basis?: string;
  next: string;
  risk?: string;
}

export interface Task {
  taskId: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee?: string;
  claimable: boolean;
  requiredCapabilities: string[];
  /** Roles required to work this task. */
  requiredRoles?: RoleKey[];
  /** Acceptance criteria the controller judges completion against. */
  acceptance?: string;
  /** Latest structured handoff, filled by the executor. */
  handoff?: TaskHandoff;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  comments: TaskComment[];
  judge: TaskJudge;
}

/** A member whose admission rights were revoked by the owner/controller. */
export interface RevokedMember {
  agentId: string;
  nickname?: string;
  revokedAt: string;
  by: string;
  reason?: string;
}

export interface Room {
  roomId: string;
  title: string;
  type: RoomType;
  ownerAgentId: string;
  controllerAgentId: string;
  createdAt: string;
  settings: RoomSettings;
  members: Member[];
  tasks: Task[];
  status: RoomStatus;
  /** Address of this room's server, e.g. "192.168.1.5:9317" (owner side). */
  serverAddress?: string;
  /** Members whose admission rights were revoked; absent in rooms persisted before this field existed. */
  revoked?: RevokedMember[];
}

/** A chat message in the room stream. */
export interface ChatMessage {
  seq: number;
  from: string;
  fromNickname: string;
  ts: string;
  text: string;
  replyTo?: number;
  mentions?: string[];
  /** True when a human took over the sender's seat. */
  human?: boolean;
  /**
   * True for a locally appended message that the owner has not confirmed yet
   * (0.1.34). Such a message carries a NEGATIVE seq and only exists in the local
   * projection, so a sender sees its own message immediately even when the frame
   * had to be queued.
   */
  pending?: boolean;
  /** Local tracking id for a pending message, cleared once the real seq lands. */
  localId?: string;
}

export interface SystemEvent {
  kind: "member-joined" | "member-left" | "member-revoked" | "member-unrevoked" | "room-state" | "settings" | "judge" | "info";
  text: string;
  ts: string;
  by?: string;
}

/** Snapshot sent to a joining member. */
export interface RoomSnapshot {
  room: Room;
  recentMessages: ChatMessage[];
  /**
   * Owner's highest assigned seq at snapshot time, control frames INCLUDED
   * (0.1.35). This is the raw "maxSeq" of the owner's store.
   */
  latestSeq?: number;
  /**
   * Owner's highest seq that the READ VIEW can actually reach, i.e. the newest
   * message that is not a control frame (0.1.35).
   *
   * This is the convergence target: a member's visible max seq can only ever
   * equal `latestChatSeq`, never `latestSeq`, because control frames (`[org:`)
   * are filtered out of the read view by design.
   */
  latestChatSeq?: number;
  /** Owner sync capability marker; 1 = supports chat.fetch / chat.stat (0.1.35). */
  syncVersion?: number;
}

/** A record of a room this node joined or created (for the "recent rooms" list). */
export interface JoinedRoomRecord {
  roomId: string;
  address: string;
  title?: string;
  lastVisitedAt: string;
}
