/**
 * rename-permission.test.mjs — card-01's security gap, organisation side.
 *
 * WHAT WAS WRONG (0.2.11, reproduced from the shipped source):
 *   `OrgService.updateNode` wrote `node.name` with NO permission check, and its
 *   route (`POST /agent-org-api/nodes/:id/update`) passed no caller identity, so
 *   anything able to reach port 3080 could rename ANY node in the tree. The
 *   permission machinery existed (`checkPermission`) but `classify()` had no
 *   rename action, so it would have answered "unknown" -> allowed:false — dead
 *   code, because `updateNode` never called it.
 *
 * WHAT THIS FILE PINS (0.2.12):
 *   1. the decision function `canRenameNode` — own member node = L1 (allowed),
 *      any other node = L2 (owner allowed, everyone else denied), observer denied
 *      even for their own node, and a MISSING actor denied rather than allowed;
 *   2. the wiring: `updateNode` reaches that decision before it writes a name, and
 *      both call paths (web route, tool) supply this machine's identity;
 *   3. that the actor resolution never mints an identity.
 *
 * `OrgService` itself cannot be constructed here: agent-org carries no
 * node_modules, so `import "@deepseek-ai/cordis"` inside src/host/service.js does
 * not resolve in this suite. That is the same constraint test/bom-org-state.test.mjs
 * documents, and it uses the same answer: run the REAL pure module against real
 * inputs, and assert the service wiring structurally.
 *
 *   node test/rename-permission.test.mjs
 */

import assert from "node:assert";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  L1_ACTIONS,
  L2_ACTIONS,
  canRenameNode,
  checkPermission,
  classify,
  renameActionFor,
  roleFor,
} from "../src/host/permission.js";

const OWNER = "01a0231b-bbe5-720a-97a4-819744eeae76";
const LEAD = "01a09461-0000-7000-8000-000000000001";
const MEMBER = "01a0281a-0000-7000-8000-000000000002";
const STRANGER = "01a094c1-0000-7000-8000-000000000003";

/** Company c1 (owner=OWNER) -> dept d1 (lead=LEAD) -> members m1/m2. */
const state = () => ({
  version: 1,
  rev: 1,
  updatedAt: "2026-09-14T00:00:00.000Z",
  nodes: [
    { id: "c1", kind: "company", name: "AI 工作室", parentId: null, leaderAgentId: OWNER, createdAt: "n", updatedAt: "n" },
    { id: "d1", kind: "department", name: "研发部", parentId: "c1", leaderAgentId: LEAD, createdAt: "n", updatedAt: "n" },
    { id: "m1", kind: "member", name: "甲", parentId: "d1", agentId: OWNER, createdAt: "n", updatedAt: "n" },
    { id: "m2", kind: "member", name: "乙", parentId: "d1", agentId: MEMBER, createdAt: "n", updatedAt: "n" },
  ],
});
/**
 * One node by id. Annotated `any` because this suite runs under the repo's
 * `checkJs` settings, whose 300+ pre-existing errors are all plain-JS inference
 * noise; a test helper must not add to them.
 * @param {any} s @param {string} id @returns {any}
 */
const nodeOf = (s, id) => s.nodes.find((/** @type {any} */ n) => n.id === id);

test("NEW: a rename is a classified action, not an unknown one", () => {
  // The old gap was partly that no rename action existed, so the fail-closed
  // "unknown" branch could never be reached. Both levels must now be classified.
  assert.ok(L1_ACTIONS.includes("rename_self"));
  assert.ok(L2_ACTIONS.includes("rename_node"));
  assert.strictEqual(classify("rename_self"), "L1");
  assert.strictEqual(classify("rename_node"), "L2");
});

test("NEW: renameActionFor separates my own member node from every other node", () => {
  const s = state();
  assert.strictEqual(renameActionFor(OWNER, nodeOf(s, "m1")), "rename_self", "own member node");
  assert.strictEqual(renameActionFor(MEMBER, nodeOf(s, "m2")), "rename_self", "own member node, non-owner");
  assert.strictEqual(renameActionFor(MEMBER, nodeOf(s, "m1")), "rename_node", "someone else's node");
  assert.strictEqual(renameActionFor(LEAD, nodeOf(s, "d1")), "rename_node", "a unit the actor LEADS is still not 'own'");
  assert.strictEqual(renameActionFor(OWNER, nodeOf(s, "c1")), "rename_node", "the company node");
  assert.strictEqual(renameActionFor("", nodeOf(s, "m1")), "rename_node", "no actor -> never 'own'");
});

test("NEW: a member may rename its own node (L1, no approval)", () => {
  const s = state();
  const d = canRenameNode(s, MEMBER, nodeOf(s, "m2"));
  assert.deepStrictEqual(d, { action: "rename_self", role: "member", level: "L1", allowed: true, needsApproval: false, approver: null });
  // The org owner renaming its own node takes the same path.
  const own = canRenameNode(s, OWNER, nodeOf(s, "m1"));
  assert.strictEqual(own.allowed, true);
  assert.strictEqual(own.action, "rename_self");
});

test("NEW: the org owner may rename any node", () => {
  const s = state();
  for (const id of ["c1", "d1", "m1", "m2"]) {
    const d = canRenameNode(s, OWNER, nodeOf(s, id));
    assert.strictEqual(d.allowed, true, `${id} allowed for the owner`);
    assert.strictEqual(d.needsApproval, false);
  }
});

test("NEW: a NON-OWNER caller is refused when it renames someone else's node", () => {
  const s = state();
  // The card's criterion: a member renaming another member's node.
  const other = canRenameNode(s, MEMBER, nodeOf(s, "m1"));
  assert.strictEqual(other.allowed, false, "denied");
  assert.strictEqual(other.needsApproval, true, "and it is an L2/approval case, not a silent write");
  assert.strictEqual(other.approver, LEAD, "escalates to the member's own lead, not straight to the owner");
  assert.strictEqual(other.role, "member");

  // A department lead renaming a node outside its own node — e.g. the company —
  // is also refused (L2, owner approval), which is what "authorization actually
  // applies" means for a non-owner.
  const lead = canRenameNode(s, LEAD, nodeOf(s, "c1"));
  assert.strictEqual(lead.allowed, false);
  assert.strictEqual(lead.needsApproval, true);
  assert.strictEqual(lead.approver, OWNER);
});

test("NEW: an unknown caller is refused, and an empty actor cannot rename at all", () => {
  const s = state();
  const stranger = canRenameNode(s, STRANGER, nodeOf(s, "m1"));
  assert.strictEqual(stranger.allowed, false);
  assert.strictEqual(stranger.role, "observer", "not an org member");
  // An observer is refused outright. `needsApproval` is true for any non-owner L2
  // action (the pre-existing matrix), and it only means a pending approval may be
  // FILED — `assertMayRename` still refuses the write, because it re-checks and
  // throws unless `allowed` is true.
  assert.strictEqual(stranger.needsApproval, true);

  // Fail-closed default: a call path that forgets to pass an actor (the 0.2.11
  // signature) renames nothing, on any node, including a plausible own node.
  for (const id of ["c1", "d1", "m1", "m2"]) {
    const d = canRenameNode(s, "", nodeOf(s, id));
    assert.strictEqual(d.allowed, false, `${id} must be refused without an actor`);
  }
  assert.strictEqual(canRenameNode(s, /** @type {any} */ (undefined), nodeOf(s, "m1")).allowed, false);
  assert.strictEqual(canRenameNode(s, "", /** @type {any} */ (undefined)).allowed, false, "no node, no actor: still refused");
});

test("NEW: the old behaviour — no check anywhere — is what this replaces", () => {
  // Reproduced against the shipped 0.2.11 source shape: the same actor that is
  // now refused was, before, simply not consulted. Kept as a regression witness:
  // if `updateNode` stops consulting the decision, this test's sibling (the
  // wiring test below) fails.
  const s = state();
  assert.strictEqual(roleFor(s, STRANGER), "observer");
  assert.strictEqual(checkPermission(s, STRANGER, "rename_node").allowed, false);
  assert.strictEqual(renameActionFor(STRANGER, nodeOf(s, "m1")), "rename_node");
});

test("NEW: updateNode reaches the gate, and only the name write is gated (wiring)", async () => {
  const source = await readFile(new URL("../src/host/service.js", import.meta.url), "utf8");
  const start = source.indexOf("async updateNode(");
  assert.ok(start > 0, "updateNode exists");
  const body = source.slice(start, start + 2_600);

  assert.match(body, /async updateNode\(id, patch, actorAgentId = ""\)/, "updateNode takes the caller's own agentId");
  assert.match(body, /this\.assertMayRename\(node, actorAgentId\)/, "and consults the authorization gate");
  assert.ok(
    body.indexOf("this.assertMayRename(node, actorAgentId)") < body.indexOf("node.name = name"),
    "the gate runs BEFORE the name is written",
  );
  // The 0.2.11 content gate must survive: bom-org-state.test.mjs asserts it too,
  // and an authorization change must never remove a validation.
  assert.match(body, /nicknameProblem\(name\)/, "the G1 content gate is still there");
  assert.match(body, /isUuidShaped\(agentId\)/);

  // The gate itself: denial is a named error, audited, never a silent no-op.
  assert.match(source, /assertMayRename\(node, actorAgentId\) \{/, "assertMayRename is defined");
  assert.match(source, /canRenameNode\(this\.state, actorAgentId, node\)/, "and it uses the pure decision function");
  assert.match(source, /new OrgError\("rename_denied"/, "refusal is a named OrgError (HTTP 400, not 500)");
  assert.match(source, /result: "denied"/, "and it is audited");

  // The agentId-addressed rename goes through updateNode, so it inherits the gate
  // AND the save() that bumps rev and broadcasts the snapshot.
  const renameStart = source.indexOf("async renameSelfByAgentId(");
  assert.ok(renameStart > 0, "renameSelfByAgentId exists");
  const renameBody = source.slice(renameStart, renameStart + 900);
  assert.match(renameBody, /this\.updateNode\(node\.id, \{ name: nickname \}, target\)/, "it delegates to updateNode with the target as actor");
  assert.ok(!/persistence\.save/.test(renameBody), "it must not write the file directly (that would skip the broadcast)");
});

test("NEW: every rename call path supplies an actor, and identity is never minted for it", async () => {
  const web = await readFile(new URL("../src/host/web.js", import.meta.url), "utf8");
  const routeStart = web.indexOf("/^\\/agent-org-api\\/nodes\\/([^/]+)\\/update$/");
  assert.ok(routeStart > 0, "the update route exists");
  const route = web.slice(routeStart, routeStart + 900);
  assert.match(route, /const actor = await service\.localAgentId\(\)/, "the route resolves the caller identity");
  assert.match(route, /\}, actor\);/, "and passes it to updateNode");

  const tool = await readFile(new URL("../src/tools/index.js", import.meta.url), "utf8");
  const toolStart = tool.indexOf('name: "org_update_node"');
  const toolBody = tool.slice(toolStart, toolStart + 1_400);
  assert.match(toolBody, /const actor = await org\.localAgentId\(\)/, "the tool resolves the caller identity");
  assert.match(toolBody, /\}, actor\);/, "and passes it to updateNode");

  // The actor must come from the non-minting accessor: an authorization check may
  // never create the identity it is authorizing (gateway.identity() mints and
  // writes a fresh identity when the cache is empty).
  const service = await readFile(new URL("../src/host/service.js", import.meta.url), "utf8");
  const localStart = service.indexOf("async localAgentId()");
  assert.ok(localStart > 0, "localAgentId exists");
  const localBody = service.slice(localStart, localStart + 1_200);
  assert.match(localBody, /room\?\.roomService\?\.getIdentity/, "it prefers the synchronous, non-minting getIdentity()");
  assert.ok(
    localBody.indexOf("getIdentity") < localBody.indexOf("gateway?.identity"),
    "the minting gateway is only a fallback",
  );
  assert.match(localBody, /return cached\?\.agentId \?\? ""/, "a cold cache yields no actor (fail closed)");
});
