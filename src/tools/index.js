/**
 * dsh-agent-org — tool registration (org_*).
 *
 * Uses the DSH tool API. All operations go through OrgService, which persists
 * the org tree and computes visibility from agent-room rooms/tasks.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "agent-org-tools";
export const inject = ["tools", "agentOrg"];

const textRender = (_args, value) => [
  { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
];

const okSchema = (properties, required = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const nodeRef = (label) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "Node id." },
    kind: { type: "string", description: "company | department | team | member." },
    name: { type: "string", description: "Display name." },
    parentId: { type: "string", description: "Parent node id." },
    leaderAgentId: { type: "string", description: "Leader agentId for org units." },
    agentId: { type: "string", description: "Member agentId for member nodes." },
  },
  required: ["id"],
});

export function apply(ctx) {
  const org = ctx.agentOrg;
  const register = (definition) => ctx.tools.register(definition);

  register(
    defineTool({
      name: "org_tree",
      description: "Get the full organization tree: company → department → team → members. The root company is always first.",
      parameters: {},
      output: { schema: okSchema({ nodes: { type: "array" } }, ["nodes"]), render: textRender },
      async execute() {
        return { nodes: org.listNodes() };
      },
    }),
  );

  register(
    defineTool({
      name: "org_create_company",
      description: "Create the root company node. Only one company can exist.",
      parameters: { name: { type: "string", required: true, description: "Company name." } },
      output: { schema: okSchema({ node: nodeRef() }, ["node"]), render: textRender },
      async execute(args) {
        const node = await org.createCompany(args.name);
        return { node };
      },
    }),
  );

  register(
    defineTool({
      name: "org_create_department",
      description: "Create a department under the root company.",
      parameters: {
        companyId: { type: "string", required: true, description: "Root company node id." },
        name: { type: "string", required: true, description: "Department name." },
      },
      output: { schema: okSchema({ node: nodeRef() }, ["node"]), render: textRender },
      async execute(args) {
        const node = await org.createDepartment(args.companyId, args.name);
        return { node };
      },
    }),
  );

  register(
    defineTool({
      name: "org_create_team",
      description: "Create a team under a department.",
      parameters: {
        departmentId: { type: "string", required: true, description: "Department node id." },
        name: { type: "string", required: true, description: "Team name." },
      },
      output: { schema: okSchema({ node: nodeRef() }, ["node"]), render: textRender },
      async execute(args) {
        const node = await org.createTeam(args.departmentId, args.name);
        return { node };
      },
    }),
  );

  register(
    defineTool({
      name: "org_add_member",
      description: "Add a member to a department or team. The member must have an agentId from agent-room; this gives them a stable org home.",
      parameters: {
        parentId: { type: "string", required: true, description: "Department or team node id." },
        agentId: { type: "string", required: true, description: "agent-room agentId." },
        name: { type: "string", description: "Display name; defaults to agentId." },
      },
      output: { schema: okSchema({ node: nodeRef() }, ["node"]), render: textRender },
      async execute(args) {
        const node = await org.addMember(args.parentId, { agentId: args.agentId, name: args.name });
        return { node };
      },
    }),
  );

  register(
    defineTool({
      name: "org_update_node",
      description: "Update an org node's name, member agentId, or clear/update leader agentId. Pass only fields to change.",
      parameters: {
        id: { type: "string", required: true, description: "Node id." },
        name: { type: "string", description: "New display name." },
        agentId: { type: "string", description: "New member agentId (member nodes only)." },
        leaderAgentId: { type: "string", description: "New leader agentId for org units; pass empty string to clear." },
      },
      output: { schema: okSchema({ node: nodeRef() }, ["node"]), render: textRender },
      async execute(args) {
        const node = await org.updateNode(args.id, {
          name: args.name,
          agentId: args.agentId,
          leaderAgentId: args.leaderAgentId === undefined ? undefined : args.leaderAgentId,
        });
        return { node };
      },
    }),
  );

  register(
    defineTool({
      name: "org_set_leader",
      description: "Set the leader (上级) of a company/department/team. The leader must be a member inside that unit's subtree; they can then see descendant task summaries.",
      parameters: {
        nodeId: { type: "string", required: true, description: "Org unit node id." },
        agentId: { type: "string", required: true, description: "Leader agentId." },
      },
      output: { schema: okSchema({ node: nodeRef() }, ["node"]), render: textRender },
      async execute(args) {
        const node = await org.setLeader(args.nodeId, args.agentId);
        return { node };
      },
    }),
  );

  register(
    defineTool({
      name: "org_remove_node",
      description: "Remove an org node and all descendants. The root company cannot be removed.",
      parameters: { id: { type: "string", required: true, description: "Node id." } },
      output: { schema: okSchema({ ok: { type: "boolean" } }, ["ok"]), render: textRender },
      async execute(args) {
        await org.removeNode(args.id);
        return { ok: true };
      },
    }),
  );

  register(
    defineTool({
      name: "org_visible_summary",
      description: "Get the task summary the current viewer is allowed to see: own tasks plus tasks of all members in any org unit they lead.",
      parameters: {},
      output: {
        schema: okSchema({
          total: { type: "number" },
          byStatus: { type: "object" },
          byOwner: { type: "object" },
          rooms: { type: "array" },
        }),
        render: textRender,
      },
      async execute() {
        const identity = await org.agentRoom.gateway.identity();
        const { summary } = await org.visibleTasks(identity.agentId);
        return summary;
      },
    }),
  );

  register(
    defineTool({
      name: "org_visible_tasks",
      description: "List the task details the current viewer is allowed to see. This enforces hierarchy visibility: superiors see descendants, subordinates/peers do not.",
      parameters: {},
      output: {
        schema: okSchema({
          tasks: { type: "array" },
          summary: { type: "object" },
        }),
        render: textRender,
      },
      async execute() {
        const identity = await org.agentRoom.gateway.identity();
        const result = await org.visibleTasks(identity.agentId);
        return {
          tasks: result.tasks.map((item) => ({
            roomId: item.roomId,
            roomTitle: item.roomTitle,
            ownerAgentId: item.ownerAgentId,
            taskId: item.task.taskId,
            title: item.task.title,
            status: item.task.status,
            assignee: item.task.assignee,
            createdBy: item.task.createdBy,
          })),
          summary: result.summary,
        };
      },
    }),
  );

  register(
    defineTool({
      name: "org_apply_studio",
      description: "Build the AI studio org: one company led by the controller, with the given assistants as members under a default 总部 department. Idempotent — missing nodes are added, existing ones are kept.",
      parameters: {
        company: { type: "string", description: "Company name; defaults to AI 工作室." },
        controllerAgentId: { type: "string", description: "Controller (主控) agentId; also set as the company leader." },
        members: {
          type: "array",
          description: "Assistant members.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              agentId: { type: "string" },
              name: { type: "string" },
            },
            required: ["agentId"],
          },
        },
      },
      output: { schema: okSchema({ nodes: { type: "array" } }, ["nodes"]), render: textRender },
      async execute(args) {
        const state = await org.applyStudioPreset({
          company: args.company,
          controllerAgentId: args.controllerAgentId,
          members: Array.isArray(args.members) ? args.members : [],
        });
        return { nodes: state.nodes };
      },
    }),
  );

  register(
    defineTool({
      name: "org_my_role",
      description: "Report the current agent's role in the org: controller (主控), member (助手), or none.",
      parameters: {},
      output: {
        schema: okSchema({
          role: { type: "string" },
          memberId: { type: "string" },
          company: { type: "object" },
        }),
        render: textRender,
      },
      async execute() {
        const identity = await org.agentRoom.gateway.identity();
        return org.myRole(identity.agentId);
      },
    }),
  );
}
