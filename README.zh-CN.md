# dsh-agent-org

DSH 公司/组织管理层插件，依赖 `dsh-agent-room`（>=0.1.4）。

## v1 能力

- **组织树**：公司 → 部门 → 团队 → 成员，固定层级，JSON 持久化，重启不丢。
- **成员归属**：员工/agent 挂到固定部门或团队下，具有稳定归属。
- **层级可见性**：上级可见本组织单元所有下级（含孙级）的任务统计；下级看不到上级；平级默认隔离。

## 使用

- 浏览器端在会话头部出现「组织」入口，可创建/编辑公司、部门、团队、成员，并设置上级。
- 提供 `org_tree`、`org_create_department`、`org_add_member`、`org_set_leader`、
  `org_visible_summary`、`org_visible_tasks` 等工具。

## 开发

```bash
node --test test/*.test.mjs
node build.mjs
```
