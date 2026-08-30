/**
 * dsh-agent-room — TaskBoard: status filter + sort, candidate recommendation
 * (capabilities/roles match), acceptance criteria + handoff cards, and a
 * prompt-free task creation form.
 */
import * as React from "react";
import type { ApiMember, ApiRoom, ApiTask } from "../api";
import { THEME, ROLE_ZH, ROLE_COLOR, fmtDateTime, statusZh } from "../theme";
import { Btn, Pill, Row, SectionTitle, StatusBadge } from "./common";

export type TaskFilter = "all" | "todo" | "doing" | "review" | "done" | "rejected";
export type TaskSort = "updated" | "created" | "status";

export interface TaskBoardProps {
  room: ApiRoom;
  localAgentId: string;
  search: string;
  filter: TaskFilter;
  sort: TaskSort;
  showCreate: boolean;
  newTitle: string;
  newDesc: string;
  newAcceptance: string;
  newJudge: "controller" | "auto";
  newClaimable: boolean;
  confirmDeleteTask: string | null;
  rejecting: string | null;
  rejectNotes: Record<string, string>;
  onSearchChange(v: string): void;
  onFilterChange(v: TaskFilter): void;
  onSortChange(v: TaskSort): void;
  onToggleCreate(): void;
  onNewTitle(v: string): void;
  onNewDesc(v: string): void;
  onNewAcceptance(v: string): void;
  onNewJudge(v: "controller" | "auto"): void;
  onNewClaimable(v: boolean): void;
  onCreateTask(): void;
  onTaskAction(action: string, taskId: string, body?: Record<string, unknown>): void;
  onArmDeleteTask(taskId: string): void;
  onDoDeleteTask(taskId: string): void;
  onRejectToggle(taskId: string): void;
  onRejectNote(taskId: string, v: string): void;
  onDoReject(taskId: string): void;
}

const STATUS_ORDER: Record<string, number> = { todo: 0, doing: 1, review: 2, done: 3, rejected: 4 };

/** Local candidate scoring: capability tags + workflow roles. */
function candidatesFor(task: ApiTask, members: ApiMember[], limit = 3): Array<{ member: ApiMember; score: number; roleMatch: number }> {
  const needCaps = task.requiredCapabilities ?? [];
  const needRoles = task.requiredRoles ?? [];
  if (needCaps.length === 0 && needRoles.length === 0) return [];
  const ranked = members
    .map((member) => {
      const have = new Set<string>([...(member.capabilities ?? []), ...(member.manualCapabilities ?? [])]);
      let score = 0;
      for (const c of needCaps) if (have.has(c)) score += 1;
      let roleMatch = 0;
      for (const r of needRoles) if ((member.roles ?? []).includes(r)) roleMatch += 1;
      return { member, score, roleMatch, total: roleMatch * 2 + score };
    })
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total || b.score - a.score)
    .slice(0, limit);
  return ranked.map(({ member, score, roleMatch }) => ({ member, score, roleMatch }));
}

export function TaskBoard(props: TaskBoardProps): React.ReactElement {
  const { room, localAgentId, filter, sort, search } = props;
  const q = search.trim().toLowerCase();

  let tasks = room.tasks.filter((t) => (filter === "all" ? true : t.status === filter));
  if (q) {
    tasks = tasks.filter((t) => t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q));
  }
  const sorted = [...tasks].sort((a, b) => {
    if (sort === "created") return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    if (sort === "status") return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });

  const FILTERS: Array<{ key: TaskFilter; label: string }> = [
    { key: "all", label: "全部" },
    { key: "todo", label: "待办" },
    { key: "doing", label: "进行中" },
    { key: "review", label: "复核中" },
    { key: "done", label: "已完成" },
    { key: "rejected", label: "已驳回" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* toolbar */}
      <div style={{ padding: "6px 12px", borderBottom: `1px solid ${THEME.border}`, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="ar-input"
          style={{ flex: 1, minWidth: 120, padding: "5px 9px", fontSize: 12 }}
          placeholder="搜索任务（标题 / 描述）"
          value={search}
          onChange={(e) => props.onSearchChange(e.target.value)}
        />
        <select className="ar-input" style={{ padding: "5px 8px", fontSize: 12 }} value={sort} onChange={(e) => props.onSortChange(e.target.value as TaskSort)} title="排序">
          <option value="updated">最近更新</option>
          <option value="created">最新创建</option>
          <option value="status">按状态</option>
        </select>
        <Btn variant={props.showCreate ? "primary" : "ghost"} onClick={props.onToggleCreate}>{props.showCreate ? "收起" : "＋ 新建任务"}</Btn>
      </div>

      {/* filter chips */}
      <div style={{ display: "flex", gap: 6, padding: "6px 12px", flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => props.onFilterChange(f.key)}
            style={{
              fontSize: 12,
              padding: "4px 10px",
              borderRadius: 999,
              cursor: "pointer",
              fontFamily: "inherit",
              border: filter === f.key ? "1px solid rgba(91,140,255,.6)" : `1px solid ${THEME.border}`,
              background: filter === f.key ? THEME.accentSoft : "transparent",
              color: filter === f.key ? "#fff" : THEME.dim,
              transition: "all .15s ease",
            }}
          >
            {f.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: THEME.faint, alignSelf: "center" }}>{sorted.length} 条</span>
      </div>

      {/* create form */}
      {props.showCreate && (
        <div className="ar-fade-in" style={{ margin: "0 12px 8px", border: `1px solid ${THEME.borderStrong}`, borderRadius: 10, padding: 10, background: THEME.accentSoft }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="ar-input" style={{ flex: 1, padding: "7px 10px", fontSize: 13 }} placeholder="任务标题 *" value={props.newTitle} autoFocus onChange={(e) => props.onNewTitle(e.target.value)} />
          </div>
          <input className="ar-input" style={{ width: "100%", marginTop: 6, padding: "6px 9px", fontSize: 12 }} placeholder="描述（可选）" value={props.newDesc} onChange={(e) => props.onNewDesc(e.target.value)} />
          <input className="ar-input" style={{ width: "100%", marginTop: 6, padding: "6px 9px", fontSize: 12 }} placeholder="验收标准（可选）" value={props.newAcceptance} onChange={(e) => props.onNewAcceptance(e.target.value)} />
          <div style={{ display: "flex", gap: 14, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, color: THEME.dim, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              判定：
              <select className="ar-input" style={{ padding: "4px 6px", fontSize: 12 }} value={props.newJudge} onChange={(e) => props.onNewJudge(e.target.value as "controller" | "auto")}>
                <option value="controller">控制人判定</option>
                <option value="auto">自治（自决完成）</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: THEME.dim, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input type="checkbox" checked={props.newClaimable} onChange={(e) => props.onNewClaimable(e.target.checked)} /> 可认领
            </label>
            <span style={{ flex: 1 }} />
            <Btn variant="primary" onClick={props.onCreateTask} disabled={!props.newTitle.trim()}>创建任务</Btn>
          </div>
        </div>
      )}

      {/* task cards */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 10px", maxHeight: "46vh" }}>
        {sorted.map((task) => (
          <TaskCard key={task.taskId} task={task} {...props} />
        ))}
        {sorted.length === 0 && (
          <div style={{ padding: "18px 0", fontSize: 12, color: THEME.faint, textAlign: "center" }}>没有符合条件的任务</div>
        )}
      </div>
    </div>
  );
}

function TaskCard(props: TaskBoardProps & { task: ApiTask }): React.ReactElement {
  const { task, room, localAgentId } = props;
  const candidates = candidatesFor(task, room.members);
  const isController = localAgentId === room.controllerAgentId;
  const rejecting = props.rejecting === task.taskId;

  return (
    <div className="ar-card" style={{ marginTop: 8, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: THEME.text }}>{task.title}</span>
        <StatusBadge text={statusZh(task.status)} status={task.status} />
        <span style={{ fontSize: 11, color: THEME.faint }}>
          {task.judge?.mode === "auto" ? "自治" : "控制人判定"} · {task.assignee ? `执行: ${task.assignee}` : task.claimable ? "可认领" : "未指派"} · 由 {task.createdBy.slice(0, 8)} 创建
        </span>
        <span style={{ flex: 1 }} />
        {task.updatedAt && <span style={{ fontSize: 10, color: THEME.faint }}>{fmtDateTime(task.updatedAt)}</span>}
      </div>

      {task.description && <div style={{ fontSize: 12, color: THEME.dim, marginTop: 4, wordBreak: "break-word" }}>{task.description}</div>}

      {(task.requiredRoles?.length ?? 0) > 0 && (
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: THEME.faint }}>所需角色:</span>
          {(task.requiredRoles ?? []).map((r) => (
            <Pill key={r} color={ROLE_COLOR[r] ?? THEME.accent}>{ROLE_ZH[r] ?? r}</Pill>
          ))}
        </div>
      )}

      {candidates.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: THEME.faint }}>⭐ 候选人:</span>
          {candidates.map((c) => (
            <Pill key={c.member.agentId} color={THEME.green} bg={THEME.greenSoft} title={`能力匹配 ${c.score} · 角色匹配 ${c.roleMatch}`}>
              {c.member.nickname}
              <span style={{ opacity: 0.75 }}>({c.score + c.roleMatch * 2})</span>
            </Pill>
          ))}
        </div>
      )}

      {task.acceptance && (
        <div style={{ marginTop: 6, fontSize: 12, borderLeft: `3px solid ${THEME.amber}`, padding: "4px 8px", background: THEME.amberSoft, borderRadius: "0 8px 8px 0" }}>
          <b style={{ color: "#ffd27d" }}>✓ 验收标准:</b> <span style={{ color: THEME.dim }}>{task.acceptance}</span>
        </div>
      )}

      {task.handoff && (
        <div style={{ marginTop: 6, fontSize: 12, borderLeft: `3px solid ${THEME.cyan}`, padding: "6px 8px", background: THEME.cyanSoft, borderRadius: "0 8px 8px 0" }}>
          <b style={{ color: "#7deefd" }}>↦ 交接卡</b>
          <div style={{ color: THEME.dim, marginTop: 2 }}>
            <div><b>已完成:</b> {task.handoff.done}</div>
            {task.handoff.basis && <div><b>依据:</b> {task.handoff.basis}</div>}
            <div><b>下一步:</b> {task.handoff.next}</div>
            {task.handoff.risk && <div style={{ color: "#ffd27d" }}><b>风险:</b> {task.handoff.risk}</div>}
          </div>
        </div>
      )}

      <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
        {task.status === "todo" && task.claimable && (
          <Btn variant="success" onClick={() => props.onTaskAction("claim", task.taskId)}>认领</Btn>
        )}
        {task.status === "todo" && (
          <Btn onClick={() => props.onTaskAction("status", task.taskId, { status: "doing" })}>开始</Btn>
        )}
        {(task.status === "todo" || task.status === "doing") && (
          <Btn variant="primary" onClick={() => props.onTaskAction("complete", task.taskId, { note: "" })}>
            {task.judge?.mode === "auto" ? "确认完成" : "提交复核"}
          </Btn>
        )}
        {task.status === "review" && isController && (
          <>
            <Btn variant="success" onClick={() => props.onTaskAction("approve", task.taskId, { note: "" })}>批准</Btn>
            <Btn
              variant={rejecting ? "danger" : "ghost"}
              onClick={() => (rejecting ? props.onDoReject(task.taskId) : props.onRejectToggle(task.taskId))}
            >
              {rejecting ? "确认驳回" : "驳回"}
            </Btn>
          </>
        )}
        {rejecting && (
          <input
            className="ar-input"
            style={{ width: 160, padding: "4px 8px", fontSize: 12 }}
            placeholder="驳回原因"
            autoFocus
            value={props.rejectNotes[task.taskId] ?? ""}
            onChange={(e) => props.onRejectNote(task.taskId, e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && props.onDoReject(task.taskId)}
          />
        )}
        {(task.status === "done" || task.status === "rejected") && (
          <Btn onClick={() => props.onTaskAction("reopen", task.taskId)}>重开</Btn>
        )}
        <span style={{ flex: 1 }} />
        <Btn
          variant={props.confirmDeleteTask === task.taskId ? "danger" : "ghost"}
          onClick={() => (props.confirmDeleteTask === task.taskId ? props.onDoDeleteTask(task.taskId) : props.onArmDeleteTask(task.taskId))}
          title="删除任务"
        >
          {props.confirmDeleteTask === task.taskId ? "确认删除?" : "删除"}
        </Btn>
      </div>
    </div>
  );
}
