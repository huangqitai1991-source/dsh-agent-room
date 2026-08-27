import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTree,
  descendantNodes,
  memberNodesInSubtree,
  summarizeVisibleTasks,
  visibleMemberIds,
  visibleTasksFor,
} from "../src/host/visibility.js";
import { OrgPersistence } from "../src/host/persistence.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeState() {
  return {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [
      { id: "company", kind: "company", name: "Acme", parentId: null },
      { id: "dept-a", kind: "department", name: "研发部", parentId: "company" },
      { id: "dept-b", kind: "department", name: "市场部", parentId: "company" },
      { id: "team-a1", kind: "team", name: "前端组", parentId: "dept-a" },
      { id: "m-lead", kind: "member", name: "主管", parentId: "dept-a", agentId: "lead" },
      { id: "m-a1", kind: "member", name: "前端一", parentId: "team-a1", agentId: "dev1" },
      { id: "m-a2", kind: "member", name: "前端二", parentId: "team-a1", agentId: "dev2" },
      { id: "m-b1", kind: "member", name: "市场一", parentId: "dept-b", agentId: "mkt1" },
    ],
  };
}

test("buildTree returns company/department/team/member hierarchy", () => {
  const tree = buildTree(makeState());
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, "Acme");
  assert.equal(tree[0].children.length, 2);
  const deptA = tree[0].children.find((n) => n.id === "dept-a");
  assert.equal(deptA.children.find((n) => n.id === "team-a1").children.length, 2);
});

test("descendantNodes includes grandchildren", () => {
  const state = makeState();
  const ids = descendantNodes(state, "dept-a").map((n) => n.id);
  assert.ok(ids.includes("team-a1"));
  assert.ok(ids.includes("m-lead"));
  assert.ok(ids.includes("m-a1"));
  assert.ok(ids.includes("m-a2"));
  assert.ok(!ids.includes("m-b1"));
});

test("department leader sees all members in the department subtree", () => {
  const state = makeState();
  state.nodes.find((n) => n.id === "dept-a").leaderAgentId = "lead";
  const visible = visibleMemberIds(state, "lead");
  assert.deepEqual([...visible].sort(), ["dev1", "dev2", "lead"]);
});

test("company leader sees every member", () => {
  const state = makeState();
  state.nodes.find((n) => n.id === "company").leaderAgentId = "boss";
  const visible = visibleMemberIds(state, "boss");
  assert.deepEqual([...visible].sort(), ["dev1", "dev2", "lead", "mkt1"]);
});

test("subordinate cannot see superior or peers", () => {
  const state = makeState();
  state.nodes.find((n) => n.id === "dept-a").leaderAgentId = "lead";
  const visible = visibleMemberIds(state, "dev1");
  assert.deepEqual([...visible].sort(), ["dev1"]);
});

test("memberNodesInSubtree works for team", () => {
  const state = makeState();
  const ids = memberNodesInSubtree(state, "team-a1").map((n) => n.agentId);
  assert.deepEqual(ids.sort(), ["dev1", "dev2"]);
});

test("summarizeVisibleTasks filters by visible set and aggregates", () => {
  const state = makeState();
  const visible = new Set(["dev1", "dev2"]);
  const rooms = [
    {
      roomId: "r1",
      title: "项目A",
      tasks: [
        { taskId: "t1", title: "任务1", status: "todo", assignee: "dev1", createdBy: "lead" },
        { taskId: "t2", title: "任务2", status: "doing", assignee: "dev2", createdBy: "lead" },
        { taskId: "t3", title: "上级任务", status: "done", assignee: "lead", createdBy: "boss" },
      ],
    },
    {
      roomId: "r2",
      title: "项目B",
      tasks: [
        { taskId: "t4", title: "平级任务", status: "done", assignee: "mkt1", createdBy: "mkt1" },
      ],
    },
  ];
  const result = summarizeVisibleTasks(rooms, visible);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.byStatus.todo, 1);
  assert.equal(result.summary.byStatus.doing, 1);
  assert.equal(result.summary.byOwner.dev1, 1);
  assert.equal(result.summary.byOwner.dev2, 1);
  assert.equal(result.tasks.every((t) => visible.has(t.ownerAgentId)), true);
  assert.equal(visibleTasksFor(rooms, visible).length, 2);
});

test("OrgPersistence saves and reloads the org tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-org-test-"));
  try {
    const persistence = new OrgPersistence(dir);
    const state = makeState();
    await persistence.save(state);
    const loaded = await persistence.load();
    assert.equal(loaded.version, 1);
    assert.equal(loaded.nodes.length, state.nodes.length);
    assert.deepEqual(loaded.nodes.map((n) => n.id), state.nodes.map((n) => n.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
