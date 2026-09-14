/**
 * dsh-agent-room — tool registration (room_* / task_*).
 *
 * Uses the DSH tool API: ctx.tools.register(defineTool({ ... })).
 * All tools dispatch through the RoomGateway so owned-room operations are
 * authoritative on this node while joined-room operations proxy to the remote
 * room server.
 */

import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { RoleKey } from "../types.js";
import type { AgentRoomService } from "../host/service.js";

export const name = "agent-room-tools";
export const inject = ["tools", "agentRoom"] as const;

interface ToolContext {
  tools: {
    register(definition: ToolDefinition): () => void;
  };
  agentRoom: AgentRoomService;
}

const textRender = (_args: unknown, value: unknown) => [
  { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
];

const okSchema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", additionalProperties: false, properties, required }) as any;

export function apply(ctx: Context & ToolContext): void {
  const gateway = ctx.agentRoom.gateway;
  const register = (definition: ToolDefinition) => ctx.tools.register(definition);

  register(
    defineTool({
      name: "room_create",
      description: "Create a collaboration room on this node (this node becomes the room owner/server). Persistent rooms survive restarts; temporary rooms are destroyed when this node exits.",
      parameters: {
        title: { type: "string", required: true, description: "Room title." },
        type: { type: "string", description: "persistent (default) or temporary." },
        authMode: { type: "string", description: "open (default) or password." },
        password: { type: "string", description: "Password when authMode=password." },
        autoMode: { type: "boolean", description: "Autonomous completion mode (agents self-confirm tasks)." },
      },
      output: {
        schema: okSchema({ room: { type: "object" } }, ["room"]),
        render: textRender,
      },
      async execute(args) {
        const room = await gateway.createRoom({
          title: args.title,
          type: args.type === "temporary" ? "temporary" : "persistent",
          settings: {
            authMode: args.authMode === "password" ? "password" : "open",
            password: args.password,
            autoMode: args.autoMode,
          },
        });
        return {
          room: {
            roomId: room.roomId,
            title: room.title,
            type: room.type,
            status: room.status,
            serverAddress: room.serverAddress,
            authMode: room.settings.authMode,
            autoMode: room.settings.autoMode,
            controllerAgentId: room.controllerAgentId,
          },
        };
      },
    }),
  );

  register(
    defineTool({
      name: "room_list_mine",
      description: "List rooms this node owns (authoritative) and rooms it has joined or created recently (with server addresses).",
      parameters: {},
      output: {
        schema: okSchema({ owned: { type: "array" }, joined: { type: "array" } }, ["owned", "joined"]),
        render: textRender,
      },
      async execute() {
        const { owned, joined } = gateway.listRooms();
        return {
          owned: owned.map((r) => ({
            roomId: r.roomId,
            title: r.title,
            type: r.type,
            status: r.status,
            authMode: r.settings.authMode,
            memberCount: r.members.length,
            taskCount: r.tasks.length,
          })),
          joined,
        };
      },
    }),
  );

  register(
    defineTool({
      name: "room_join",
      description: "Join a room hosted by another node. Pass the owner-shared address (host:port) and roomId if known. For password rooms pass the password.",
      parameters: {
        address: { type: "string", required: true, description: "Room server address, e.g. 192.168.1.5:9317." },
        roomId: { type: "string", description: "Room id to join (optional when the server hosts one room)." },
        password: { type: "string", description: "Password for password-protected rooms." },
      },
      output: {
        schema: okSchema({ roomId: { type: "string" }, title: { type: "string" } }, ["roomId"]),
        render: textRender,
      },
      async execute(args) {
        const result = await gateway.joinRoom([args.address], {
          roomId: args.roomId,
          password: args.password,
        });
        return { roomId: result.roomId, title: result.title };
      },
    }),
  );

  register(
    defineTool({
      name: "room_leave",
      description: "Leave a room (owned or joined).",
      parameters: { roomId: { type: "string", required: true } },
      output: { schema: okSchema({ ok: { type: "boolean" } }, ["ok"]), render: textRender },
      async execute(args) {
        await gateway.leaveRoom(args.roomId);
        return { ok: true };
      },
    }),
  );

  register(
    defineTool({
      name: "room_send",
      description: "Send a chat message in a room. Agents use this to discuss and coordinate; mention other agents with their agentId or nickname to draw their attention.",
      parameters: {
        roomId: { type: "string", required: true },
        text: { type: "string", required: true, description: "Message text." },
        mentions: { type: "array", description: "agentIds or nicknames to mention." },
      },
      output: { schema: okSchema({ seq: { type: "number" }, sent: { type: "boolean" }, acceptedByLocalHub: { type: "boolean" }, confirmedByOwner: { type: "boolean" }, confirmedSeq: { type: "number" }, confirmNote: { type: "string" }, delivered: { type: "boolean" }, queued: { type: "boolean" }, reason: { type: "string" } }), render: textRender },
      async execute(args) {
        const result = await gateway.sendChat(args.roomId, { text: args.text, mentions: args.mentions as string[] | undefined });
        // Owned room -> authoritative message with a real seq. Joined room ->
        // delivery status: the agent must be able to see that its frame was queued
        // or dropped instead of assuming the send worked (0.1.34), and as of
        // 0.1.35 it can also see whether the OWNER confirmed the message.
        // `delivered` is a deprecated alias of `acceptedByLocalHub`; read the two
        // explicit fields instead — "accepted" is not "arrived".
        if (result && "delivered" in result) {
          return {
            seq: result.confirmedSeq ?? null,
            sent: result.acceptedByLocalHub,
            acceptedByLocalHub: result.acceptedByLocalHub,
            confirmedByOwner: result.confirmedByOwner,
            confirmedSeq: result.confirmedSeq ?? null,
            confirmNote: result.confirmNote,
            delivered: result.delivered,
            queued: result.queued,
            reason: result.reason,
          };
        }
        return { seq: result?.seq ?? null, sent: true, acceptedByLocalHub: true, confirmedByOwner: true, confirmedSeq: result?.seq ?? null, confirmNote: "owner-confirmed", delivered: true, queued: false };
      },
    }),
  );

  register(
    defineTool({
      name: "room_info",
      description: "Get a room's current state: members, tasks, settings, and the recent message stream.",
      parameters: { roomId: { type: "string", required: true } },
      output: {
        schema: okSchema({ roomId: { type: "string" }, title: { type: "string" }, members: { type: "array" }, tasks: { type: "array" }, messages: { type: "array" }, settings: { type: "object" }, revoked: { type: "array" } }),
        render: textRender,
      },
      async execute(args) {
        const info = await gateway.roomInfo(args.roomId);
        return {
          roomId: info.room.roomId,
          title: info.room.title,
          status: info.room.status,
          owned: info.owned,
          settings: {
            authMode: info.room.settings.authMode,
            autoMode: info.room.settings.autoMode,
            maxMembers: info.room.settings.maxMembers,
            allowHumanTakeover: info.room.settings.allowHumanTakeover,
          },
          controllerAgentId: info.room.controllerAgentId,
          members: info.room.members.map((m) => ({
            agentId: m.agentId,
            nickname: m.nickname,
            role: m.role,
            capabilities: m.capabilities ?? [],
            // D-20: liveness travels with the member row, so "is this colleague
            // reachable" is answerable from this tool result alone. `undefined`
            // means unknown (an older peer / a member not heard from yet).
            lastSeenAt: m.lastSeenAt,
            lastSeenAddress: m.lastSeenAddress,
            lastExecAt: m.lastExecAt,
            lastExecOk: m.lastExecOk,
          })),
          revoked: (info.room.revoked ?? []).map((r) => ({ agentId: r.agentId, nickname: r.nickname, revokedAt: r.revokedAt, by: r.by, reason: r.reason })),
          tasks: info.room.tasks.map((t) => ({
            taskId: t.taskId,
            title: t.title,
            status: t.status,
            assignee: t.assignee,
            claimable: t.claimable,
            judgeMode: t.judge.mode,
            createdBy: t.createdBy,
          })),
          messages: info.recentMessages.slice(-50),
        };
      },
    }),
  );

  register(
    defineTool({
      name: "room_settings",
      description: "Update an owned room: change auth mode/password, toggle autonomous mode, or transfer controller rights to another member.",
      parameters: {
        roomId: { type: "string", required: true },
        authMode: { type: "string", description: "open or password." },
        password: { type: "string", description: "New password (authMode=password)." },
        autoMode: { type: "boolean", description: "Toggle autonomous completion mode." },
        transferControllerTo: { type: "string", description: "agentId to transfer judging rights to." },
      },
      output: { schema: okSchema({ roomId: { type: "string" } }, ["roomId"]), render: textRender },
      async execute(args) {
        if (args.transferControllerTo) {
          await gateway.transferController(args.roomId, args.transferControllerTo);
        }
        const room = await gateway.updateSettings(args.roomId, {
          authMode: args.authMode === "password" ? "password" : args.authMode ? "open" : undefined,
          password: args.password,
          autoMode: args.autoMode,
        });
        return {
          roomId: room.roomId,
          authMode: room.settings.authMode,
          autoMode: room.settings.autoMode,
          controllerAgentId: room.controllerAgentId,
        };
      },
    }),
  );

  register(
    defineTool({
      name: "room_revoke",
      description: "Revoke a member's admission rights. A revoked member can no longer enter the room and their live connection is closed. Only the room owner or controller may revoke.",
      parameters: {
        roomId: { type: "string", required: true },
        agentId: { type: "string", required: true, description: "agentId of the member to revoke." },
        reason: { type: "string", description: "Reason for revocation." },
      },
      output: {
        schema: okSchema({ revoked: { type: "object" } }, ["revoked"]),
        render: textRender,
      },
      async execute(args) {
        const revoked = await gateway.revokeMember(args.roomId, args.agentId, args.reason);
        return { revoked };
      },
    }),
  );

  register(
    defineTool({
      name: "room_unrevoke",
      description: "Restore a revoked member's admission rights so they can join again. Only the room owner or controller may unrevoke.",
      parameters: {
        roomId: { type: "string", required: true },
        agentId: { type: "string", required: true, description: "agentId of the member to restore." },
      },
      output: {
        schema: okSchema({ ok: { type: "boolean" } }, ["ok"]),
        render: textRender,
      },
      async execute(args) {
        await gateway.unrevokeMember(args.roomId, args.agentId);
        return { ok: true };
      },
    }),
  );

  register(
    defineTool({
      name: "task_create",
      description: "Create a task in a room. Optionally declare requiredCapabilities so suitable members are suggested, assign it, or leave it claimable. judgeMode: controller (default; needs the controller's approval to finish) or auto (executor self-confirms).",
      parameters: {
        roomId: { type: "string", required: true },
        title: { type: "string", required: true },
        description: { type: "string", description: "Task details." },
        assignee: { type: "string", description: "agentId or nickname to assign." },
        claimable: { type: "boolean", description: "Allow any member to claim." },
        requiredCapabilities: { type: "array", description: "Capabilities the executor should have; suitable members are suggested." },
        requiredRoles: { type: "array", description: "Workflow roles required: controller/researcher/executor/reviewer." },
        acceptance: { type: "string", description: "Acceptance criteria the controller judges completion against." },
        judgeMode: { type: "string", description: "controller or auto." },
      },
      output: {
        schema: okSchema({ task: { type: "object" }, suggestions: { type: "array" } }, ["task"]),
        render: textRender,
      },
      async execute(args) {
        const caps = args.requiredCapabilities as string[] | undefined;
        const roles = args.requiredRoles as RoleKey[] | undefined;
        const task = await gateway.taskCreate(args.roomId, {
          title: args.title,
          description: args.description,
          assignee: args.assignee,
          claimable: args.claimable,
          requiredCapabilities: caps,
          requiredRoles: roles,
          acceptance: args.acceptance,
          judgeMode: args.judgeMode === "auto" ? "auto" : "controller",
        });
        const suggestions = (caps?.length || roles?.length) ? await gateway.suggestCandidates(args.roomId, caps ?? [], roles ?? []) : [];
        return {
          task: {
            taskId: task.taskId,
            title: task.title,
            status: task.status,
            assignee: task.assignee,
            judgeMode: task.judge.mode,
          },
          suggestions,
        };
      },
    }),
  );

  register(
    defineTool({
      name: "task_handoff",
      description: "Attach a structured handoff card to a task: what's done, on what basis, what's next, and any risks. Use before handing a task to the next role.",
      parameters: {
        roomId: { type: "string", required: true },
        taskId: { type: "string", required: true },
        done: { type: "string", required: true, description: "What has been completed." },
        basis: { type: "string", description: "Evidence or reasoning behind the work." },
        next: { type: "string", required: true, description: "Next step for the successor." },
        risk: { type: "string", description: "Risks or unresolved questions." },
      },
      output: { schema: okSchema({ taskId: { type: "string" } }, ["taskId"]), render: textRender },
      async execute(args) {
        await gateway.taskHandoff(args.roomId, args.taskId, {
          done: args.done,
          basis: args.basis,
          next: args.next,
          risk: args.risk,
        });
        return { taskId: args.taskId };
      },
    }),
  );

  register(
    defineTool({
      name: "task_list",
      description: "List tasks in a room, optionally filtered by status (todo/doing/review/done/rejected).",
      parameters: {
        roomId: { type: "string", required: true },
        status: { type: "string", description: "Filter by todo/doing/review/done/rejected." },
      },
      output: { schema: okSchema({ tasks: { type: "array" } }, ["tasks"]), render: textRender },
      async execute(args) {
        const tasks = await gateway.taskList(args.roomId, args.status);
        return {
          tasks: tasks.map((t) => ({
            taskId: t.taskId,
            title: t.title,
            status: t.status,
            assignee: t.assignee,
            claimable: t.claimable,
            judgeMode: t.judge.mode,
            createdBy: t.createdBy,
            updatedAt: t.updatedAt,
          })),
        };
      },
    }),
  );

  register(
    defineTool({
      name: "task_assign",
      description: "Assign a task to a member (by agentId or nickname).",
      parameters: {
        roomId: { type: "string", required: true },
        taskId: { type: "string", required: true },
        assignee: { type: "string", required: true, description: "agentId or nickname of the member." },
      },
      output: { schema: okSchema({ task: { type: "object" } }, ["task"]), render: textRender },
      async execute(args) {
        const task = await gateway.taskAssign(args.roomId, args.taskId, args.assignee);
        return { task: { taskId: task.taskId, status: task.status, assignee: task.assignee } };
      },
    }),
  );

  register(
    defineTool({
      name: "task_claim",
      description: "Claim a claimable task (become its executor).",
      parameters: { roomId: { type: "string", required: true }, taskId: { type: "string", required: true } },
      output: { schema: okSchema({ task: { type: "object" } }, ["task"]), render: textRender },
      async execute(args) {
        const task = await gateway.taskClaim(args.roomId, args.taskId);
        return { task: { taskId: task.taskId, status: task.status, assignee: task.assignee } };
      },
    }),
  );

  register(
    defineTool({
      name: "task_comment",
      description: "Add a comment to a task (progress notes, questions, context).",
      parameters: {
        roomId: { type: "string", required: true },
        taskId: { type: "string", required: true },
        text: { type: "string", required: true },
      },
      output: { schema: okSchema({ task: { type: "object" } }, ["task"]), render: textRender },
      async execute(args) {
        const task = await gateway.taskComment(args.roomId, args.taskId, args.text);
        return { task: { taskId: task.taskId, comments: task.comments.length } };
      },
    }),
  );

  register(
    defineTool({
      name: "task_status",
      description: "Manually move a task between todo and doing.",
      parameters: {
        roomId: { type: "string", required: true },
        taskId: { type: "string", required: true },
        status: { type: "string", required: true, description: "todo or doing." },
      },
      output: { schema: okSchema({ task: { type: "object" } }, ["task"]), render: textRender },
      async execute(args) {
        const task = await gateway.taskStatus(args.roomId, args.taskId, args.status === "doing" ? "doing" : "todo");
        return { task: { taskId: task.taskId, status: task.status } };
      },
    }),
  );

  register(
    defineTool({
      name: "agent_rename_self",
      description:
        "Rename THIS node (the one supported rename entry point). One call converges all three stores: this machine's identity.json, the room members' nickname pushed to every joined room owner immediately (no wait for the 15s profile timer), and the agent-org org-tree node name. Applies to the running process — no restart. A name containing U+FFFD, consecutive '?', the unfilled placeholder \"NAME\", or only whitespace is rejected and NOTHING is changed. The org-tree half is reported explicitly: if agent-org is unavailable or refuses (a non-owner renaming another node), the result says so instead of silently leaving the tree behind.",
      parameters: {
        nickname: { type: "string", required: true, description: "The new display name for this node." },
      },
      output: {
        schema: okSchema(
          {
            rename: {
              type: "object",
              properties: {
                agentId: { type: "string" },
                previousNickname: { type: "string" },
                nickname: { type: "string" },
                changed: { type: "boolean" },
                identityFile: { type: "string" },
                profileFanout: { type: "number" },
                ownedRoomMembers: { type: "number" },
                nicknameConflicts: { type: "array" },
                org: { type: "object" },
              },
              required: ["agentId", "nickname", "changed", "identityFile", "profileFanout", "ownedRoomMembers", "org"],
              additionalProperties: false,
            },
          },
          ["rename"],
        ),
        render: textRender,
      },
      async execute(args) {
        const rename = await gateway.renameSelf(args.nickname);
        return { rename };
      },
    }),
  );

  register(
    defineTool({
      name: "task_complete",
      description: "Submit a task as complete. In controller mode the task moves to review and the controller must approve it (the executor may not self-review); in auto mode the executor confirms directly and it becomes done.",
      parameters: {
        roomId: { type: "string", required: true },
        taskId: { type: "string", required: true },
        note: { type: "string", description: "Completion note." },
      },
      output: { schema: okSchema({ task: { type: "object" } }, ["task"]), render: textRender },
      async execute(args) {
        const task = await gateway.taskComplete(args.roomId, args.taskId, args.note);
        return { task: { taskId: task.taskId, status: task.status, judgeMode: task.judge.mode } };
      },
    }),
  );

  register(
    defineTool({
      name: "task_approve",
      description: "Approve a review-state task (controller only).",
      parameters: {
        roomId: { type: "string", required: true },
        taskId: { type: "string", required: true },
        note: { type: "string", description: "Approval note." },
      },
      output: { schema: okSchema({ task: { type: "object" } }, ["task"]), render: textRender },
      async execute(args) {
        const task = await gateway.taskApprove(args.roomId, args.taskId, args.note);
        return { task: { taskId: task.taskId, status: task.status } };
      },
    }),
  );

  register(
    defineTool({
      name: "task_reject",
      description: "Reject a review-state task, sending it back for rework (controller only).",
      parameters: {
        roomId: { type: "string", required: true },
        taskId: { type: "string", required: true },
        note: { type: "string", description: "Reason for rejection." },
      },
      output: { schema: okSchema({ task: { type: "object" } }, ["task"]), render: textRender },
      async execute(args) {
        const task = await gateway.taskReject(args.roomId, args.taskId, args.note);
        return { task: { taskId: task.taskId, status: task.status } };
      },
    }),
  );

  register(
    defineTool({
      name: "task_reopen",
      description: "Reopen a done or rejected task back to todo.",
      parameters: { roomId: { type: "string", required: true }, taskId: { type: "string", required: true } },
      output: { schema: okSchema({ task: { type: "object" } }, ["task"]), render: textRender },
      async execute(args) {
        const task = await gateway.taskReopen(args.roomId, args.taskId);
        return { task: { taskId: task.taskId, status: task.status } };
      },
    }),
  );

  register(
    defineTool({
      name: "task_remove",
      description: "Delete a task. Creator/assignee can remove only todo tasks; the controller can remove any status.",
      parameters: { roomId: { type: "string", required: true }, taskId: { type: "string", required: true } },
      output: { schema: okSchema({ taskId: { type: "string" } }, ["taskId"]), render: textRender },
      async execute(args) {
        await gateway.taskDelete(args.roomId, args.taskId);
        return { taskId: args.taskId };
      },
    }),
  );
}
