/**
 * dsh-agent-room — unified deep-tech dark theme and shared visual vocabulary.
 * All components import THEME instead of scattering magic colors.
 */

export const THEME = {
  // surfaces
  bg: "rgba(10,13,20,.97)",
  panel: "rgba(15,19,30,.92)",
  card: "rgba(24,30,44,.78)",
  cardHover: "rgba(30,38,56,.9)",
  input: "rgba(8,11,18,.66)",
  inputFocus: "rgba(8,11,18,.9)",
  // lines
  border: "rgba(120,150,255,.22)",
  borderStrong: "rgba(120,150,255,.45)",
  // accents
  accent: "#5b8cff",
  accentSoft: "rgba(91,140,255,.16)",
  cyan: "#22d3ee",
  cyanSoft: "rgba(34,211,238,.14)",
  green: "#34d399",
  greenSoft: "rgba(52,211,153,.14)",
  amber: "#fbbf24",
  amberSoft: "rgba(251,191,36,.14)",
  red: "#f87171",
  redSoft: "rgba(248,113,113,.14)",
  purple: "#a78bfa",
  purpleSoft: "rgba(167,139,250,.14)",
  // text
  text: "#e9edf8",
  dim: "rgba(233,237,248,.64)",
  faint: "rgba(233,237,248,.42)",
  // type
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  mono: '"SF Mono", "Cascadia Code", Consolas, "Liberation Mono", monospace',
  // geometry
  radius: 14,
  radiusSm: 9,
  glow: "0 0 20px rgba(91,140,255,.4)",
  glowGreen: "0 0 16px rgba(52,211,153,.4)",
  glowRed: "0 0 16px rgba(248,113,113,.4)",
} as const;

/* ----------------------------- shared helpers ----------------------------- */

export function badgeColor(status: string): string {
  switch (status) {
    case "todo": return "#8b93a7";
    case "doing": return "#5b8cff";
    case "review": return "#fbbf24";
    case "done": return "#34d399";
    case "rejected": return "#f87171";
    case "open": return "#34d399";
    case "suspended": return "#fbbf24";
    case "closed": return "#8b93a7";
    default: return "#8b93a7";
  }
}

export function statusZh(status: string): string {
  switch (status) {
    case "todo": return "待办";
    case "doing": return "进行中";
    case "review": return "复核中";
    case "done": return "已完成";
    case "rejected": return "已驳回";
    case "open": return "开放";
    case "suspended": return "暂停";
    case "closed": return "已关闭";
    default: return status;
  }
}

/** Human label + color + raw state for the room bridge (connection) state. */
export function bridgeLabel(bridge?: { kind: string; state: string }): { text: string; color: string; state: string } {
  if (!bridge) return { text: "未知", color: THEME.dim, state: "unknown" };
  if (bridge.kind === "none") return { text: "未配置中继", color: THEME.dim, state: "none" };
  if (bridge.kind === "relay") {
    switch (bridge.state) {
      case "open": return { text: "中继 · 已桥接", color: THEME.cyan, state: bridge.state };
      case "connecting": return { text: "中继 · 连接中", color: THEME.amber, state: bridge.state };
      case "disconnected": return { text: "中继 · 重连中", color: THEME.amber, state: bridge.state };
      default: return { text: "中继", color: THEME.cyan, state: bridge.state };
    }
  }
  switch (bridge.state) {
    case "open": return { text: "直连 · 在线", color: THEME.green, state: bridge.state };
    case "reconnecting": return { text: "断线重连中", color: THEME.amber, state: bridge.state };
    case "connecting": return { text: "连接中", color: THEME.amber, state: bridge.state };
    case "closed": return { text: "已断开", color: THEME.red, state: bridge.state };
    default: return { text: "直连", color: THEME.green, state: bridge.state };
  }
}

export function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function fmtDateTime(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export const ROLE_ZH: Record<string, string> = {
  observer: "观察者",
  controller: "总控",
  researcher: "资料",
  executor: "执行",
  reviewer: "复核",
};

export const ALL_ROLES = ["observer", "controller", "researcher", "executor", "reviewer"];

export const ROLE_COLOR: Record<string, string> = {
  observer: "#8b93a7",
  controller: "#a78bfa",
  researcher: "#22d3ee",
  executor: "#5b8cff",
  reviewer: "#fbbf24",
};

/** Global CSS injected once: animations, scrollbars, focus rings. */
export const GLOBAL_CSS = `
  .ar-root * { box-sizing: border-box; }
  .ar-root { font-family: ${THEME.font}; }
  .ar-root ::-webkit-scrollbar { width: 8px; height: 8px; }
  .ar-root ::-webkit-scrollbar-thumb { background: rgba(120,150,255,.28); border-radius: 8px; }
  .ar-root ::-webkit-scrollbar-thumb:hover { background: rgba(120,150,255,.5); }
  .ar-root ::-webkit-scrollbar-track { background: transparent; }
  .ar-grad-border {
    position: relative;
    background: linear-gradient(135deg, rgba(91,140,255,.55), rgba(34,211,238,.28) 45%, rgba(167,139,250,.4));
    padding: 1px;
    border-radius: ${THEME.radius}px;
  }
  .ar-grad-border > .ar-grad-inner {
    background: ${THEME.panel};
    border-radius: calc(${THEME.radius}px - 1px);
    height: 100%;
  }
  .ar-card {
    background: ${THEME.card};
    border: 1px solid ${THEME.border};
    border-radius: ${THEME.radius}px;
    transition: border-color .2s ease, transform .2s ease, box-shadow .2s ease;
  }
  .ar-card:hover { border-color: ${THEME.borderStrong}; box-shadow: ${THEME.glow}; }
  .ar-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    border: 1px solid transparent; border-radius: ${THEME.radiusSm}px;
    font-family: inherit; cursor: pointer; user-select: none;
    transition: transform .12s ease, filter .12s ease, box-shadow .18s ease, background .15s ease, border-color .15s ease;
    white-space: nowrap;
  }
  .ar-btn:hover { filter: brightness(1.15); transform: translateY(-1px); }
  .ar-btn:active { transform: scale(.95); }
  .ar-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
  .ar-input {
    font-family: inherit; color: ${THEME.text};
    background: ${THEME.input}; border: 1px solid ${THEME.border};
    border-radius: ${THEME.radiusSm}px; outline: none;
    transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
  }
  .ar-input:focus { border-color: ${THEME.accent}; box-shadow: 0 0 0 3px rgba(91,140,255,.18); background: ${THEME.inputFocus}; }
  .ar-input::placeholder { color: ${THEME.faint}; }
  .ar-dot { border-radius: 50%; display: inline-block; }
  .ar-dot-pulse { animation: ar-breathe 1.6s ease-in-out infinite; }
  @keyframes ar-breathe {
    0%, 100% { box-shadow: 0 0 0 0 rgba(52,211,153,.55); }
    50% { box-shadow: 0 0 0 5px rgba(52,211,153,0); }
  }
  .ar-dot-pulse-red { animation: ar-breathe-red 1.6s ease-in-out infinite; }
  @keyframes ar-breathe-red {
    0%, 100% { box-shadow: 0 0 0 0 rgba(248,113,113,.55); }
    50% { box-shadow: 0 0 0 5px rgba(248,113,113,0); }
  }
  .ar-tabbtn { border: none; background: transparent; font-family: inherit; cursor: pointer; color: ${THEME.dim}; transition: color .15s ease, background .15s ease; border-radius: 8px 8px 0 0; }
  .ar-tabbtn:hover { color: ${THEME.text}; background: rgba(91,140,255,.08); }
  .ar-fade-in { animation: ar-fade .25s ease; }
  @keyframes ar-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  .ar-panel { backdrop-filter: blur(18px) saturate(1.25); -webkit-backdrop-filter: blur(18px) saturate(1.25); }
`;
