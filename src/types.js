/**
 * dsh-agent-org — shared domain types (plain data).
 *
 * The plugin deliberately uses structural types for agent-room data so the
 * org package does not need to bundle agent-room itself at build time.
 */

/**
 * @typedef {"company" | "department" | "team" | "member"} OrgNodeKind
 */

/**
 * @typedef {Object} OrgNode
 * @property {string} id
 * @property {OrgNodeKind} kind
 * @property {string} name
 * @property {string | null} parentId
 * @property {string} [leaderAgentId]  Org-unit leader (company/department/team).
 * @property {string} [agentId]        Member agent identity (only kind=member).
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} OrgState
 * @property {1} version
 * @property {OrgNode[]} nodes
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} TaskLike
 * @property {string} taskId
 * @property {string} title
 * @property {string} status
 * @property {string} [assignee]
 * @property {string} [createdBy]
 */

/**
 * @typedef {Object} RoomLike
 * @property {string} roomId
 * @property {string} [title]
 * @property {TaskLike[]} [tasks]
 */

/**
 * @typedef {Object} VisibleTask
 * @property {string} roomId
 * @property {string} roomTitle
 * @property {TaskLike} task
 * @property {string} ownerAgentId
 */

/**
 * @typedef {Object} TaskSummary
 * @property {number} total
 * @property {Object<string, number>} byStatus
 * @property {Object<string, number>} byOwner
 * @property {Array<{roomId: string, title: string, taskCount: number}>} rooms
 */

export {};
