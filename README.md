# dsh-agent-org

Company/org management layer for DSH. It depends on
[dsh-agent-room](https://github.com/deepseek-ai/dsh-agent-room) (`>=0.1.4`) and
adds:

1. **Org tree** — company → department → team → member, persisted across restarts.
2. **Member assignment** — each employee/agent has a stable home in a department/team.
3. **Hierarchical visibility** — superiors see task summaries for all descendants
   (including grandchild teams); subordinates and peers see only their own tasks.

## Install / load

- The plugin is registered by `cordis.patch.yml` as `agent-org`.
- It injects `ctx.agentRoom`; make sure `dsh-agent-room` is loaded first.
- Default data directory: `${DSH_HOME}/agent-org/org-state.json`.

## Browser UI

The client registers an **组织** dock next to the agent-room dock in the
conversation header. It can:

- create/rename the company, departments, teams, and members;
- assign a leader (`上级`) to any company/department/team;
- remove subtrees;
- show the current user's visible task summary.

## Tools

| Tool | Purpose |
| --- | --- |
| `org_tree` | List the org tree. |
| `org_create_company` | Create the root company. |
| `org_create_department` | Add a department under the company. |
| `org_create_team` | Add a team under a department. |
| `org_add_member` | Add a member (agentId) to a department/team. |
| `org_update_node` | Rename a node or update a member agentId. |
| `org_set_leader` | Set the leader of an org unit. |
| `org_remove_node` | Remove a node and its subtree. |
| `org_visible_summary` | Task summary visible to the caller. |
| `org_visible_tasks` | Task details visible to the caller. |

## Development

```bash
node --test test/*.test.mjs   # run tests
node build.mjs                # optional: emit lib/ from src/
```
