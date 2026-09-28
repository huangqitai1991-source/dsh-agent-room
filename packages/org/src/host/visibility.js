/**
 * Pure org visibility logic.
 *
 * Rules implemented:
 * - A member always sees their own assigned/created tasks.
 * - A leader of an org unit (company/department/team) sees tasks of every
 *   member in that unit's subtree, including grandchild teams.
 * - Subordinates do not see superiors' tasks.
 * - Peers in different branches are isolated by default.
 */

/**
 * @param {{nodes: Array}} state
 * @param {string | null} parentId
 * @returns {Array}
 */
export function childrenOf(state, parentId) {
  return state.nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

/**
 * @param {{nodes: Array}} state
 * @param {string} nodeId
 * @returns {Array}
 */
export function descendantNodes(state, nodeId) {
  const out = [];
  const stack = [nodeId];
  // 0.2.14: `seen` prevents an infinite loop when a malformed tree (parentId
  // cycle, reachable through org sync) is walked. Measured 2026-09-20: without
  // it this function hangs on a cycle.
  const seen = new Set([nodeId]);
  while (stack.length > 0) {
    const current = stack.pop();
    for (const node of state.nodes) {
      if (node.parentId === current) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        out.push(node);
        stack.push(node.id);
      }
    }
  }
  return out;
}

/**
 * Return member nodes whose agentId matches.
 * @param {{nodes: Array}} state
 * @param {string} agentId
 * @returns {Array}
 */
export function memberNodesByAgent(state, agentId) {
  return state.nodes.filter((node) => node.kind === "member" && node.agentId === agentId);
}

/**
 * Return all member nodes under an org unit (including grandchildren).
 * @param {{nodes: Array}} state
 * @param {string} nodeId
 * @returns {Array}
 */
export function memberNodesInSubtree(state, nodeId) {
  const ids = new Set([nodeId, ...descendantNodes(state, nodeId).map((n) => n.id)]);
  return state.nodes.filter((node) => node.kind === "member" && ids.has(node.id));
}

/**
 * Compute the set of agentIds a viewer can see task data for.
 *
 * @param {{nodes: Array}} state
 * @param {string} viewerAgentId
 * @returns {Set<string>}
 */
export function visibleMemberIds(state, viewerAgentId) {
  const visible = new Set();

  // Self visibility: only if this agent is actually an org member.
  for (const node of memberNodesByAgent(state, viewerAgentId)) {
    visible.add(node.agentId);
  }

  // Leadership visibility: each org unit this agent leads exposes its subtree.
  for (const node of state.nodes) {
    if (node.kind === "member") continue;
    if (node.leaderAgentId && node.leaderAgentId === viewerAgentId) {
      for (const member of memberNodesInSubtree(state, node.id)) {
        if (member.agentId) visible.add(member.agentId);
      }
    }
  }

  return visible;
}

/**
 * Return the member nodes whose agentIds are visible to the viewer.
 * @param {{nodes: Array}} state
 * @param {string} viewerAgentId
 * @returns {Array}
 */
export function visibleMemberNodes(state, viewerAgentId) {
  const ids = visibleMemberIds(state, viewerAgentId);
  return state.nodes.filter((node) => node.kind === "member" && node.agentId && ids.has(node.agentId));
}

/**
 * Return the leader node for an org unit.
 * @param {{nodes: Array}} state
 * @param {string} nodeId
 * @returns {Object|undefined}
 */
export function findNode(state, nodeId) {
  return state.nodes.find((node) => node.id === nodeId);
}

/**
 * Build a hierarchical tree projection for display.
 * @param {{nodes: Array}} state
 * @returns {Array}
 */
export function buildTree(state) {
  const roots = childrenOf(state, null);
  const byParent = new Map();
  for (const node of state.nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  const decorate = (node) => {
    const kids = (byParent.get(node.id) ?? [])
      .slice()
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    return {
      ...node,
      children: kids.map(decorate),
    };
  };
  return roots.map(decorate);
}

/**
 * Scan rooms and return tasks whose owner is visible.
 *
 * @param {Array} rooms
 * @param {Set<string>} visibleAgentIds
 * @returns {Array<{roomId: string, roomTitle: string, task: Object, ownerAgentId: string}>}
 */
export function visibleTasksFor(rooms, visibleAgentIds) {
  const out = [];
  for (const room of rooms) {
    const tasks = Array.isArray(room.tasks) ? room.tasks : [];
    for (const task of tasks) {
      const ownerAgentId = task.assignee || task.createdBy;
      if (!ownerAgentId || !visibleAgentIds.has(ownerAgentId)) continue;
      out.push({
        roomId: room.roomId,
        roomTitle: room.title ?? room.roomId,
        task,
        ownerAgentId,
      });
    }
  }
  return out;
}

/**
 * Summarize visible tasks by status and owner.
 *
 * @param {Array} rooms
 * @param {Set<string>} visibleAgentIds
 * @returns {{tasks: Array, summary: Object}}
 */
export function summarizeVisibleTasks(rooms, visibleAgentIds) {
  const tasks = visibleTasksFor(rooms, visibleAgentIds);
  const byStatus = {};
  const byOwner = {};
  const roomMap = new Map();

  for (const item of tasks) {
    const status = item.task.status || "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    byOwner[item.ownerAgentId] = (byOwner[item.ownerAgentId] ?? 0) + 1;
    const roomEntry = roomMap.get(item.roomId) ?? { roomId: item.roomId, title: item.roomTitle, taskCount: 0 };
    roomEntry.taskCount += 1;
    roomMap.set(item.roomId, roomEntry);
  }

  return {
    tasks,
    summary: {
      total: tasks.length,
      byStatus,
      byOwner,
      rooms: [...roomMap.values()].sort((a, b) => b.taskCount - a.taskCount),
    },
  };
}
