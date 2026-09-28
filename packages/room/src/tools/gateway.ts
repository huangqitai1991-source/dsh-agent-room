/**
 * RoomGateway — the facade tools and client UI use. The host wiring implements
 * it by dispatching to RoomService (rooms this node owns, authoritative) or
 * RoomClient (rooms this node joined as a member).
 */

import type {
  AgentIdentity,
  ChatMessage,
  JoinedRoomRecord,
  RevokedMember,
  RoleKey,
  Room,
  RoomSettings,
  Task,
  TaskHandoff,
} from "../types.js";
import type { CreateRoomInput } from "../host/room-service.js";
import type { ChatDeliveryStatus } from "../host/outbound.js";
import type { WakePreview } from "../host/wake.js";

/** Delivery status of a message sent to a JOINED room (see host/outbound.ts). */
export type { ChatDeliveryStatus };
export type { WakePreview };

export interface TaskInput {
  title: string;
  description?: string;
  assignee?: string;
  claimable?: boolean;
  requiredCapabilities?: string[];
  requiredRoles?: RoleKey[];
  acceptance?: string;
  judgeMode?: "controller" | "auto";
}

/**
 * The outcome of the ONE supported rename entry point (0.1.40).
 *
 * Reported per store, because card-01's whole point is that three copies of a
 * display name exist and used to diverge silently:
 *   A  this machine's `identity.json`        -> written by the same call
 *   B  the room members' view                -> `profileFanout` (joined rooms,
 *      pushed immediately) + `ownedRoomMembers` (rooms this node owns, updated
 *      in its own member list)
 *   C  the agent-org org-tree node name      -> `org`, which says explicitly when
 *      it did NOT change instead of leaving the caller to assume
 */
export interface SelfRenameResult {
  agentId: string;
  /** The nickname that was live before the call. */
  previousNickname: string;
  /** The nickname now live, and persisted. */
  nickname: string;
  /** Changed: true only when the stored value actually moved. */
  changed: boolean;
  /** The identity file this call wrote (store A). */
  identityFile: string;
  /** Joined-room clients the profile frame was pushed to right away (store B). */
  profileFanout: number;
  /** Rooms this node owns whose member row was updated in place (store B). */
  ownedRoomMembers: number;
  /**
   * Rooms where another member ALREADY uses the new nickname. Reported, never a
   * refusal: `room-service` resolves an @mention by nickname and throws
   * `ambiguous-member` when two members share one, so the caller has to know —
   * but blocking the rename would leave the node on a name it cannot change,
   * which is the defect this release closes.
   */
  nicknameConflicts: Array<{ roomId: string; agentIds: string[] }>;
  /** Store C, reported honestly: `updated: false` always carries a `reason`. */
  org: {
    attempted: boolean;
    updated: boolean;
    nodeId?: string;
    rev?: number;
    reason?: string;
  };
}

export interface RoomGateway {
  identity(): Promise<AgentIdentity>;
  /** Rename this node, consistently across identity.json, the room members' view
   *  and the org tree; applies to the live process (no restart) and fans out at
   *  once instead of waiting for the 15s profile timer. Throws
   *  InvalidNicknameError / IdentityNotReadyError, and nothing is changed then. */
  renameSelf(nickname: string): Promise<SelfRenameResult>;
  createRoom(input: CreateRoomInput): Promise<Room>;
  closeRoom(roomId: string): Promise<void>;
  destroyRoom(roomId: string): Promise<void>;
  listRooms(): { owned: Room[]; joined: JoinedRoomRecord[] };
  roomInfo(roomId: string): Promise<{ room: Room; recentMessages: ChatMessage[]; owned: boolean }>;
  joinRoom(addresses: string[], options: { roomId?: string; password?: string; relay?: string }): Promise<{ roomId: string; title: string }>;
  leaveRoom(roomId: string): Promise<void>;
  kickMember(roomId: string, agentId: string): Promise<void>;
  revokeMember(roomId: string, agentId: string, reason?: string): Promise<RevokedMember>;
  unrevokeMember(roomId: string, agentId: string): Promise<void>;
  /**
   * Send a chat message.
   *
   * Owned room: the authoritative ChatMessage (with a real seq).
   * Joined room: a delivery status object — never `null` (0.1.34). The frame may
   * be queued (control frames) or dropped (plain chat) when the channel is not
   * OPEN, and the caller has to be able to tell the difference and retry.
   */
  sendChat(
    roomId: string,
    input: { text: string; replyTo?: number; mentions?: string[]; human?: boolean },
  ): Promise<ChatMessage | ChatDeliveryStatus>;
  /**
   * How many room members the wake rule would be woken by this message (0.1.45).
   *
   * `woken: 0` means "handed to the room, but this post addresses nobody" — the
   * distinction that did not exist when seq 3267 reported `confirmedByOwner: true`
   * while waking no one. It is a rule PREDICTION over this node's room view (see
   * `WakePreview.note`), not a receipt from the targets.
   */
  wakePreview(
    roomId: string,
    input: { text: string; mentions?: string[]; human?: boolean },
  ): WakePreview;
  updateSettings(roomId: string, patch: Partial<RoomSettings> & { password?: string }): Promise<Room>;
  transferController(roomId: string, toAgentId: string): Promise<Room>;

  taskCreate(roomId: string, input: TaskInput): Promise<Task>;
  taskList(roomId: string, status?: string): Promise<Task[]>;
  taskAssign(roomId: string, taskId: string, assignee: string): Promise<Task>;
  taskClaim(roomId: string, taskId: string): Promise<Task>;
  taskComment(roomId: string, taskId: string, text: string): Promise<Task>;
  taskStatus(roomId: string, taskId: string, status: "todo" | "doing"): Promise<Task>;
  taskComplete(roomId: string, taskId: string, note?: string): Promise<Task>;
  taskApprove(roomId: string, taskId: string, note?: string): Promise<Task>;
  taskReject(roomId: string, taskId: string, note?: string): Promise<Task>;
  taskReopen(roomId: string, taskId: string): Promise<Task>;
  taskDelete(roomId: string, taskId: string): Promise<void>;
  taskHandoff(roomId: string, taskId: string, handoff: TaskHandoff): Promise<Task>;
  setMemberRoles(roomId: string, roles: RoleKey[]): Promise<void>;
  assignMemberRoles(roomId: string, targetAgentId: string, roles: RoleKey[]): Promise<void>;
  setMemberCapabilities(roomId: string, capabilities: string[]): Promise<void>;
  suggestCandidates(roomId: string, requiredCapabilities: string[], requiredRoles?: RoleKey[]): Promise<Array<{ agentId: string; nickname: string; score: number; roleMatch: number }>>;
}
