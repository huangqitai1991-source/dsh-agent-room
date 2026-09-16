import assert from "node:assert";
import { test } from "node:test";
import { buildTree, treeLines } from "../src/host/org-tree.js";

const nodes = [
  { id: "c", kind: "company", name: "AI studio", leaderAgentId: "boss" },
  { id: "d", kind: "department", name: "HQ", parentId: "c" },
  { id: "m1", kind: "member", name: "lead", parentId: "d", agentId: "boss" },
  { id: "m2", kind: "member", name: "helper", parentId: "d", agentId: "01a0281a-52de-7c4d" },
  { id: "lost", kind: "member", name: "orphan", parentId: "gone", agentId: "zzz" },
];

test("the shape is company -> department -> members, and the leader is marked owner", () => {
  const t = buildTree(nodes);
  assert.equal(t.roots[0].name, "AI studio");
  assert.equal(t.roots[0].children[0].name, "HQ");
  const kids = t.roots[0].children[0].children.map((n) => n.name);
  assert.deepEqual(kids, ["lead", "helper"], "child order must follow the state");
  assert.equal(t.roots[0].children[0].children[0].role, "owner", "the company leader is the owner");
  assert.equal(t.roots[0].children[0].children[1].shortId, "01a0281a");
});

test("an orphan is SHOWN as a root, never dropped", () => {
  const t = buildTree(nodes);
  assert.equal(t.orphans, 1);
  assert.equal(t.displayed, 5, "every node must appear somewhere in the picture");
  assert.ok(t.roots.some((r) => r.name === "orphan"));
});

test("a cycle cannot hang the renderer", () => {
  const t = buildTree([
    { id: "c", kind: "company", name: "co" },
    { id: "a", kind: "department", name: "a", parentId: "b" },
    { id: "b", kind: "department", name: "b", parentId: "a" },
  ]);
  assert.ok(t.displayed >= 1);
  assert.ok(treeLines(t).length >= 1);
});

test("the text fallback is indented by depth", () => {
  const lines = treeLines(buildTree(nodes));
  assert.match(lines[0], /^AI studio \[company\]$/);
  assert.match(lines[1], /^  HQ \[department\]$/);
  assert.match(lines[2], /^    lead \[owner boss\]$/);
});