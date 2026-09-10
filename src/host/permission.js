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
];

/** L2 = cross-department / write ops, require approval. */
export const L2_ACTIONS = [
  "assign_cross_dept",
  "delete_room",
  "change_roles",
  "kick_member",
  "delete_task",
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
  let parentId = memberNode.parentId;
  while (parentId) {
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
