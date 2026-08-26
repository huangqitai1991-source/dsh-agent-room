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
}

export interface SystemEvent {
  kind: "member-joined" | "member-left" | "room-state" | "settings" | "judge" | "info";
  text: string;
  ts: string;
  by?: string;
}

/** Snapshot sent to a joining member. */
export interface RoomSnapshot {
  room: Room;
  recentMessages: ChatMessage[];
}

/** A record of a room this node joined or created (for the "recent rooms" list). */
export interface JoinedRoomRecord {
  roomId: string;
  address: string;
  title?: string;
  lastVisitedAt: string;
}
