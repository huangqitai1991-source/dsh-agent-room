import assert from "node:assert";
import { test } from "node:test";
import { decodeSnapshot, encodeSnapshot, shouldApply } from "../src/host/sync.js";

const owner = "01a0231b-owner";
const member = "01a0281a-member";
const tree = (rev) => ({ version: 1, nodes: [{ id: "c", kind: "company", parentId: null, leaderAgentId: owner }], updatedAt: "", rev });

test("snapshot round-trips with by + ownerAgentId", () => {
  const encoded = encodeSnapshot(tree(3), { by: owner, ownerAgentId: owner });
  const decoded = decodeSnapshot(encoded);
  assert.strictEqual(decoded.rev, 3);
  assert.strictEqual(decoded.by, owner);
  assert.strictEqual(decoded.ownerAgentId, owner);
});

test("owner snapshot wins over non-owner local tree at equal rev", () => {
  // AA (member) has rev=0; owner broadcasts rev=0 -> member adopts owner's.
  const local = tree(0);
  const incoming = { ...tree(0), by: owner, ownerAgentId: owner };
  assert.strictEqual(shouldApply(local, incoming, member), true);
});

test("owner ignores non-owner snapshot at equal rev", () => {
  const local = tree(0);
  const incoming = { ...tree(0), by: member, ownerAgentId: owner };
  assert.strictEqual(shouldApply(local, incoming, owner), false);
});

test("higher rev wins between same-authority nodes", () => {
  const local = tree(1);
  const incoming = { ...tree(2), by: owner, ownerAgentId: owner };
  assert.strictEqual(shouldApply(local, incoming, owner), true);
  assert.strictEqual(shouldApply(local, { ...tree(0), by: owner, ownerAgentId: owner }, owner), false);
});
