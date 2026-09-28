/**
 * dsh-agent-org — permission matrix (L1 auto / L2 approval) + role mapping.
 *
 * Roles derive from the org tree:
 *   owner     = company leader (主控)
 *   lead      = department/team leader (部门主管)
 *   member    = an org member
 *   observer  = not an org member
 */

/** L1 = low-risk, auto-approved. */
export const L1_ACTIONS = [
  "chat",
  "view_tasks",
  "claim_task",
  "update_own_task",
  "complete_task",
  // 0.2.12: renaming YOUR OWN member node. A display name is the identity other
  // machines read, so every member must be able to correct their own — that is
  // the whole point of card-01's entry point. It stays L1 because the target is
  // the actor's own node: no other member's data is touched.
  "rename_self",
];

/** L2 = cross-department / write ops, require approval. */
export const L2_ACTIONS = [
  "assign_cross_dept",
  "delete_room",
  "change_roles",
  "kick_member",
  "delete_task",
  // 0.2.12: renaming ANY OTHER node (another member's node, or an org unit).
  // Before 0.2.12 `updateNode` called no permission check at all and its route
  // had no caller identity, so anything that could reach port 3080 could rename
  // any node in the tree. `checkPermission` returns "unknown" -> allowed:false
  // for a rename action that is not listed here, so this entry is also what makes
  // the fallback reachable instead of dead code.
  "rename_node",
];

/**
 * @param {string} action
 * @returns {"L1"|"L2"|"unknown"}
 */
export function classify(action) {
  if (L1_ACTIONS.includes(action)) return "L1";
  if (L2_ACTIONS.includes(action)) return "L2";
  return "unknown";
}

/**
 * @param {{nodes: Array}} state
 * @param {string} agentId
 * @returns {"owner"|"lead"|"member"|"observer"}
 */
export function roleFor(state, agentId) {
  const company = state.nodes.find((n) => n.kind === "company");
  if (company?.leaderAgentId === agentId) return "owner";
  for (const node of state.nodes) {
    if (node.kind === "member") continue;
    if (node.leaderAgentId === agentId) return "lead";
  }
  const isMember = state.nodes.some((n) => n.kind === "member" && n.agentId === agentId);
  return isMember ? "member" : "observer";
}

/**
 * Find the org-unit leader (lead or owner) above the given member.
 * @param {{nodes: Array}} state
 * @param {string} agentId
 * @returns {{agentId: string, node: Object|null}|null}
 */
export function superiorOf(state, agentId) {
  const memberNode = state.nodes.find((n) => n.kind === "member" && n.agentId === agentId);
  if (!memberNode) return null;
  // Walk up from the member's parent until we find a unit with a leader.
  // 0.2.14: `seen` makes the walk cycle-safe. Before this, one malformed tree
  // (a parentId loop arriving through sync) hung this loop — and this function
  // sits on the authorization path (`checkPermission` -> L2 approver lookup).
  let parentId = memberNode.parentId;
  const seen = new Set();
  while (parentId) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const unit = state.nodes.find((n) => n.id === parentId);
    if (!unit) break;
    if (unit.leaderAgentId && unit.leaderAgentId !== agentId) return { agentId: unit.leaderAgentId, node: unit };
    parentId = unit.parentId;
  }
  const company = state.nodes.find((n) => n.kind === "company");
  if (company?.leaderAgentId && company.leaderAgentId !== agentId) {
    return { agentId: company.leaderAgentId, node: company };
  }
  return null;
}

/**
 * Decide the permission outcome for an actor performing an action.
 * @param {{nodes: Array}} state
 * @param {string} agentId
 * @param {string} action
 * @returns {{role: string, level: string, allowed: boolean, needsApproval: boolean, approver: string|null}}
 */
export function checkPermission(state, agentId, action) {
  const role = roleFor(state, agentId);
  const level = classify(action);
  if (level === "L1") {
    // Everyone who is at least a member can do L1; observer (non-member) is denied.
    return { role, level, allowed: role !== "observer", needsApproval: false, approver: null };
  }
  if (level === "L2") {
    // owner does everything without approval; lead/member need approval.
    if (role === "owner") return { role, level, allowed: true, needsApproval: false, approver: null };
    const superior = superiorOf(state, agentId);
    return {
      role,
      level,
      allowed: false, // blocked until approved
      needsApproval: true,
      approver: superior?.agentId ?? state.nodes.find((n) => n.kind === "company")?.leaderAgentId ?? null,
    };
  }
  return { role, level, allowed: false, needsApproval: false, approver: null };
}

/**
 * Which rename action a node mutation is (0.2.12).
 *
 * "own node" means a MEMBER node whose `agentId` is the actor's own agentId. An
 * org-unit node (company/department/team) is never "own" even when the actor
 * leads it: renaming a unit changes what every member sees, so it goes through
 * L2 like any other node.
 *
 * @param {string} actorAgentId
 * @param {{kind?: string, agentId?: string}|null|undefined} node
 * @returns {"rename_self"|"rename_node"}
 */
export function renameActionFor(actorAgentId, node) {
  if (!actorAgentId) return "rename_node";
  if (node && node.kind === "member" && node.agentId && node.agentId === actorAgentId) return "rename_self";
  return "rename_node";
}

/**
 * The single authorization decision for a rename (0.2.12).
 *
 * Exists as a pure function so the gate can be tested without constructing the
 * cordis service (agent-org carries no node_modules; see the note in
 * test/bom-org-state.test.mjs). `OrgService.updateNode` calls exactly this, with
 * the caller's own agentId, before it writes a name.
 *
 * Fail-closed by construction: an empty/unknown actor resolves to "observer",
 * which is denied L1 as well — so a call path that forgets to pass an actor
 * cannot rename anything.
 *
 * @param {{nodes: Array<object>}} state
 * @param {string} actorAgentId
 * @param {{id?: string, kind?: string, agentId?: string}} node
 * @returns {{action: string, role: string, level: string, allowed: boolean, needsApproval: boolean, approver: string|null}}
 */
export function canRenameNode(state, actorAgentId, node) {
  const action = renameActionFor(actorAgentId, node);
  return { action, ...checkPermission(state, actorAgentId ?? "", action) };
}

/* ------------------------------------------------------------------ *
 * 0.2.14 — HORIZONTAL ISOLATION for the exec plane.
 *
 * Before 0.2.14 `exec-plane.js` allowed a sender when `roleFor()` said
 * "owner" OR "lead" — and `roleFor` only asks "do you lead SOME unit",
 * never "does the target live under a unit you lead". So the lead of an
 * empty department could push commands to every machine in the company.
 * The two functions below are the missing half of that rule.
 * ------------------------------------------------------------------ */

/**
 * Cycle-safe descendant unit ids of `rootId` (the root itself is not included).
 *
 * Every traversal here must survive a malformed tree: `parentId` loops can
 * arrive through org sync (`OrgService` replaces the whole node array, and the
 * loader only checks that `nodes` is an array). A loop that reaches an auth
 * path is worse than a wrong answer — it hangs instead of answering 403.
 *
 * @param {{nodes: Array}} state
 * @param {string} rootId
 * @returns {string[]}
 */
export function subtreeUnitIds(state, rootId) {
  const seen = new Set([rootId]);
  const queue = [rootId];
  const out = [];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const node of state.nodes) {
      if (node.parentId !== current) continue;
      if (seen.has(node.id)) continue; // cycle / diamond guard
      seen.add(node.id);
      out.push(node.id);
      queue.push(node.id);
    }
  }
  return out;
}

/**
 * Is `targetAgentId` inside a subtree led by `actorAgentId`?
 *
 * @param {{nodes: Array}} state
 * @param {string} actorAgentId
 * @param {string} targetAgentId
 * @returns {{inSubtree: boolean, viaNodeId: string|null}}
 */
export function leadsTarget(state, actorAgentId, targetAgentId) {
  const target = state.nodes.find((n) => n.kind === "member" && n.agentId === targetAgentId);
  if (!target) return { inSubtree: false, viaNodeId: null };
  for (const unit of state.nodes) {
    if (unit.kind === "member") continue;
    if (unit.leaderAgentId !== actorAgentId) continue;
    const ids = new Set([unit.id, ...subtreeUnitIds(state, unit.id)]);
    if (target.parentId && ids.has(target.parentId)) return { inSubtree: true, viaNodeId: unit.id };
  }
  return { inSubtree: false, viaNodeId: null };
}

/**
 * The single authorization decision for `exec` (0.2.14).
 *
 * owner    -> company-wide; crossing departments is that role's whole point.
 * lead     -> ONLY targets inside a subtree it leads (this is the new part).
 * member   -> may RECEIVE exec, may never push it.
 * observer -> denied.
 *
 * Fail-closed by construction: a missing actor, a missing target, or a target
 * that is absent from the local tree all deny. `classify("exec")` stays
 * "unknown" on purpose so the L1/L2 shortcut can never be reached for exec.
 *
 * @param {{nodes: Array}} state
 * @param {string} actorAgentId
 * @param {string} targetAgentId
 * @returns {{allowed: boolean, action: string, role: string, level: string, reason: string, needsApproval: boolean, approver: string|null}}
 */
export function canExecTarget(state, actorAgentId, targetAgentId) {
  const actor = `${actorAgentId ?? ""}`.trim();
  const target = `${targetAgentId ?? ""}`.trim();
  const role = roleFor(state, actor);
  const level = classify("exec");
  const base = { action: "exec", role, level, needsApproval: false, approver: null };
  const deny = (reason) => ({ ...base, allowed: false, reason });
  if (!actor) return deny("no actor identity (fail-closed)");
  if (!target) return deny("no target");
  if (role === "observer") return deny("actor is not an org member");
  const targetKnown = state.nodes.some((n) => n.kind === "member" && n.agentId === target);
  if (role === "owner") {
    // owner is company-wide BY RULE, so an unregistered target is not an
    // undecidable case — it is an explicit allowance, and it is recorded.
    // (Onboarding needs exactly this: exec a new box before it has a node.)
    return {
      ...base,
      allowed: true,
      targetKnown,
      reason: targetKnown ? "owner: company-wide" : "owner: company-wide (target absent from local tree — recorded)",
    };
  }
  if (role === "member") return deny("role=member: only owner/lead may push exec");
  if (!targetKnown) return deny("target is absent from the local tree (fail-closed)");
  const { inSubtree, viaNodeId } = leadsTarget(state, actor, target);
  if (!inSubtree) return deny("target is outside every subtree this lead leads");
  return { ...base, allowed: true, targetKnown, reason: "lead: target inside own subtree", viaNodeId };
}
