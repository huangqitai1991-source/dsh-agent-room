/**
 * dsh-agent-room — unified purple deep-tech dark theme and shared visual vocabulary.
 * All components import THEME instead of scattering magic colors.
 */

export const THEME = {
  // surfaces (purple-tinted near-black)
  bg: "rgba(10,8,20,.97)",
  panel: "rgba(16,12,32,.94)",
  panelGrad:
    "linear-gradient(160deg, rgba(22,16,44,.96), rgba(11,8,22,.98)), radial-gradient(1200px 600px at 18% -12%, rgba(139,92,246,.28), transparent 60%), radial-gradient(900px 520px at 112% 8%, rgba(34,211,238,.14), transparent 55%), radial-gradient(700px 500px at 50% 118%, rgba(192,132,252,.18), transparent 60%)",
  card: "rgba(26,20,46,.8)",
  cardHover: "rgba(36,28,64,.9)",
  input: "rgba(8,6,18,.7)",
  inputFocus: "rgba(8,6,18,.92)",
  // lines
  border: "rgba(168,139,250,.24)",
  borderStrong: "rgba(168,139,250,.5)",
  // accents
  accent: "#8b5cf6",
  accentSoft: "rgba(139,92,246,.16)",
  cyan: "#22d3ee",
  cyanSoft: "rgba(34,211,238,.14)",
  green: "#34d399",
  greenSoft: "rgba(52,211,153,.14)",
  amber: "#fbbf24",
  amberSoft: "rgba(251,191,36,.14)",
  red: "#f87171",
  redSoft: "rgba(248,113,113,.14)",
  purple: "#c084fc",
  purpleSoft: "rgba(192,132,252,.16)",
  // text
  text: "#ede9fe",
  dim: "rgba(237,233,254,.64)",
  faint: "rgba(237,233,254,.42)",
  // type
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  mono: '"SF Mono", "Cascadia Code", Consolas, "Liberation Mono", monospace',
  // geometry
  radius: 14,
  radiusSm: 9,
  glow: "0 0 22px rgba(139,92,246,.5)",
  glowGreen: "0 0 16px rgba(52,211,153,.4)",
  glowRed: "0 0 16px rgba(248,113,113,.4)",
} as const;

/* ----------------------------- shared helpers ----------------------------- */

export function badgeColor(status: string): string {
  switch (status) {
    case "todo": return "#9b93b4";
    case "doing": return "#8b5cf6";
    case "review": return "#fbbf24";
    case "done": return "#34d399";
    case "rejected": return "#f87171";
    case "open": return "#34d399";
    case "suspended": return "#fbbf24";
    case "closed": return "#9b93b4";
    default: return "#9b93b4";
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
  observer: "#9b93b4",
  controller: "#c084fc",
  researcher: "#22d3ee",
  executor: "#8b5cf6",
  reviewer: "#fbbf24",
};

/** Global CSS injected once: animations, scrollbars, focus rings, aurora. */
export const GLOBAL_CSS = `
  .ar-root * { box-sizing: border-box; }
  .ar-root { font-family: ${THEME.font}; }
  .ar-root ::-webkit-scrollbar { width: 8px; height: 8px; }
  .ar-root ::-webkit-scrollbar-thumb { background: rgba(168,139,250,.3); border-radius: 8px; }
  .ar-root ::-webkit-scrollbar-thumb:hover { background: rgba(168,139,250,.55); }
  .ar-root ::-webkit-scrollbar-track { background: transparent; }
  .ar-grad-border {
    position: relative;
    background: linear-gradient(135deg, rgba(139,92,246,.6), rgba(34,211,238,.3) 45%, rgba(192,132,252,.45));
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
  .ar-btn:hover { filter: brightness(1.18); transform: translateY(-1px); }
  .ar-btn:active { transform: scale(.95); }
  .ar-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
  .ar-input {
    font-family: inherit; color: ${THEME.text};
    background: ${THEME.input}; border: 1px solid ${THEME.border};
    border-radius: ${THEME.radiusSm}px; outline: none;
    transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
  }
  .ar-input:focus { border-color: ${THEME.accent}; box-shadow: 0 0 0 3px rgba(139,92,246,.22); background: ${THEME.inputFocus}; }
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
  .ar-tabbtn:hover { color: ${THEME.text}; background: rgba(139,92,246,.1); }
  .ar-fade-in { animation: ar-fade .25s ease; }
  @keyframes ar-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  .ar-panel {
    backdrop-filter: blur(20px) saturate(1.3);
    -webkit-backdrop-filter: blur(20px) saturate(1.3);
    position: relative;
  }
  /* subtle animated aurora sweep + grid overlay */
  .ar-panel::after {
    content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0;
    background-image: linear-gradient(rgba(168,139,250,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(168,139,250,.05) 1px, transparent 1px);
    background-size: 34px 34px;
    mask-image: radial-gradient(ellipse at 30% 0%, black 0%, transparent 70%);
    -webkit-mask-image: radial-gradient(ellipse at 30% 0%, black 0%, transparent 70%);
  }
  @keyframes ar-neon {
    0%, 100% { text-shadow: 0 0 8px rgba(192,132,252,.7), 0 0 22px rgba(139,92,246,.4); }
    50% { text-shadow: 0 0 14px rgba(139,92,246,.9), 0 0 30px rgba(192,132,252,.5); }
  }
  .ar-neon { animation: ar-neon 2.6s ease-in-out infinite; }
`;
