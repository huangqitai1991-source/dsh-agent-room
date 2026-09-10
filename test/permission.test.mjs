import assert from "node:assert";
import { test } from "node:test";
import { checkPermission, classify, roleFor } from "../src/host/permission.js";

const state = {
  nodes: [
    { id: "c", kind: "company", name: "AI 工作室", parentId: null, leaderAgentId: "boss" },
    { id: "d1", kind: "department", name: "研发部", parentId: "c", leaderAgentId: "lead1" },
    { id: "m1", kind: "member", name: "甲", parentId: "d1", agentId: "member1" },
    { id: "d2", kind: "department", name: "运营部", parentId: "c", leaderAgentId: "lead2" },
    { id: "m2", kind: "member", name: "乙", parentId: "d2", agentId: "member2" },
  ],
};

test("roleFor maps hierarchy", () => {
  assert.strictEqual(roleFor(state, "boss"), "owner");
  assert.strictEqual(roleFor(state, "lead1"), "lead");
  assert.strictEqual(roleFor(state, "member1"), "member");
  assert.strictEqual(roleFor(state, "stranger"), "observer");
});

test("classify L1/L2", () => {
  assert.strictEqual(classify("chat"), "L1");
  assert.strictEqual(classify("delete_room"), "L2");
  assert.strictEqual(classify("whatever"), "unknown");
});

test("owner does everything without approval", () => {
  assert.deepStrictEqual(checkPermission(state, "boss", "delete_room"), {
    role: "owner", level: "L2", allowed: true, needsApproval: false, approver: null,
  });
});

test("member L1 allowed, L2 needs approval from their lead", () => {
  const l1 = checkPermission(state, "member1", "chat");
  assert.strictEqual(l1.allowed, true);
  assert.strictEqual(l1.needsApproval, false);

  const l2 = checkPermission(state, "member1", "delete_room");
  assert.strictEqual(l2.allowed, false);
  assert.strictEqual(l2.needsApproval, true);
  assert.strictEqual(l2.approver, "lead1");
});

test("observer denied even L1", () => {
  const d = checkPermission(state, "stranger", "chat");
  assert.strictEqual(d.allowed, false);
});
