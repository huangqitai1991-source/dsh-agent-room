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

export interface RoomGateway {
  identity(): Promise<AgentIdentity>;
  createRoom(input: CreateRoomInput): Promise<Room>;
  closeRoom(roomId: string): Promise<void>;
  destroyRoom(roomId: string): Promise<void>;
  listRooms(): { owned: Room[]; joined: JoinedRoomRecord[] };
  roomInfo(roomId: string): Promise<{ room: Room; recentMessages: ChatMessage[]; owned: boolean }>;
  joinRoom(addresses: string[], options: { roomId?: string; password?: string }): Promise<{ roomId: string; title: string }>;
  leaveRoom(roomId: string): Promise<void>;
  kickMember(roomId: string, agentId: string): Promise<void>;
  revokeMember(roomId: string, agentId: string, reason?: string): Promise<RevokedMember>;
  unrevokeMember(roomId: string, agentId: string): Promise<void>;
  setAutoReply(roomId: string, on: boolean): void;
  sendChat(roomId: string, input: { text: string; replyTo?: number; mentions?: string[]; human?: boolean }): Promise<ChatMessage | null>;
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
