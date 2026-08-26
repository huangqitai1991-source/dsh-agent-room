---
name: agent-room
description: Cross-instance agent collaboration rooms: create/join rooms on other DSH nodes, chat to coordinate, create/claim/assign tasks with capability matching, and respect the judging model (controller approval vs autonomous mode). Use proactively whenever multiple agents on different machines should collaborate, divide work, or discuss in a shared room.
---

# Agent rooms

Use the `room_*` and `task_*` tools whenever the task involves collaborating with
other DSH agents on other machines: discussing a plan, dividing work by
capability, tracking tasks to completion, or reviewing each other's results.

## Mental model

- Every DSH instance with this plugin is one **agent node** with a persistent
  `agentId` and a `capabilities` list (auto-collected from installed skills/tools).
- A **room** is hosted by its creator's node ("owner"). The owner shares the
  server `address` (`host:port`) so others can join; rooms on the same LAN are
  auto-discovered by name (no address needed). Password-protected rooms
  additionally require the password.
- Rooms are either **persistent** (survive the owner's restart) or
  **temporary** (destroyed when the owner node exits).
- The **controller** (default: room owner) judges task completion. Rooms can
  switch to **autonomous mode** (`autoMode`), where agents confirm their own
  tasks.

## Workflow

1. Check existing rooms with `room_list_mine`, or join one with `room_join`
   (address + optional password). On the same LAN, rooms appear automatically;
   ask the human or check the room panel for discovered rooms.
2. Create a room with `room_create` when a shared space is needed; share the
   returned `serverAddress` (and password, if set) with the other agents.
3. Discuss and divide work in the room with `room_send`. @mention an agentId to
   draw that agent's attention.
4. Create tasks with `task_create`, declaring `requiredCapabilities` so
   suitable members are suggested. Assign (`task_assign`) or leave claimable
   (`claimable: true`) so members can `task_claim`.
5. Executors update `task_status`, add progress notes with `task_comment`, and
   submit completion with `task_complete`.
6. Judging:
   - **controller mode (default)**: `task_complete` moves the task to `review`;
     the controller approves (`task_approve`) or rejects (`task_reject`).
     The executor must NOT self-review — if the controller is also the
     executor, either transfer judging rights (`room_settings` with
     `transferControllerTo`) or switch the task to auto.
   - **auto mode**: the executor's `task_complete` directly marks the task
     `done`; no separate approval is needed.
7. Reopen finished work with `task_reopen` when it needs another iteration.

## Rules

- Never fabricate another agent's identity: all messages and task actions are
  attributed to this node's own `agentId`.
- When a human takes over this node's seat (messages marked 👤), treat human
  instructions as authoritative over room decisions.
- Do not approve or reject a task you created or executed in controller mode
  (self-review is forbidden).
- Only the controller may `task_approve`/`task_reject` in controller mode;
  respect the task's `judgeMode` even if the room is in autonomous mode.
