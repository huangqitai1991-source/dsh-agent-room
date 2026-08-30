/**
 * dsh-agent-room — shared UI atoms: pills, badges, status dots, buttons, cards.
 */
import * as React from "react";
import { THEME, badgeColor } from "../theme";

/* ----------------------------- primitives ----------------------------- */

export function Pill({ children, color, bg, style, title }: { children: React.ReactNode; color?: string; bg?: string; style?: React.CSSProperties; title?: string }): React.ReactElement {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1,
        padding: "3px 7px",
        borderRadius: 999,
        color: color ?? "#dfe6ff",
        background: bg ?? "rgba(91,140,255,.16)",
        border: `1px solid ${color ? color + "55" : "rgba(120,150,255,.3)"}`,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** Colored status pill (task status / room status). */
export function StatusBadge({ text, status }: { text: string; status: string }): React.ReactElement {
  const color = badgeColor(status);
  return <Pill color={color} bg={color + "1f"}>{text}</Pill>;
}

/** Breathing status dot. */
export function StatusDot({ color, pulse, size = 8, title }: { color: string; pulse?: boolean; size?: number; title?: string }): React.ReactElement {
  return (
    <span
      title={title}
      className={pulse ? (color === THEME.red ? "ar-dot ar-dot-pulse-red" : "ar-dot ar-dot-pulse") : "ar-dot"}
      style={{ width: size, height: size, background: color, boxShadow: `0 0 6px ${color}` }}
    />
  );
}

/** Unread count bubble. */
export function UnreadDot({ count }: { count: number }): React.ReactElement | null {
  if (!count) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 18,
        height: 18,
        padding: "0 5px",
        borderRadius: 999,
        background: "linear-gradient(135deg, #f87171, #ef4444)",
        color: "#fff",
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1,
        boxShadow: "0 0 10px rgba(248,113,113,.6)",
      }}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/* ----------------------------- buttons ----------------------------- */

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "success";
  size?: "sm" | "md";
};

export function Btn({ variant = "ghost", size = "sm", style, children, ...rest }: BtnProps): React.ReactElement {
  const base: React.CSSProperties = { fontSize: size === "sm" ? 12 : 13, padding: size === "sm" ? "5px 10px" : "7px 14px" };
  switch (variant) {
    case "primary":
      base.background = "linear-gradient(135deg, #5b8cff, #4a6fe0)";
      base.color = "#fff";
      base.border = "1px solid rgba(140,170,255,.5)";
      base.boxShadow = "0 2px 10px rgba(91,140,255,.35)";
      break;
    case "danger":
      base.background = "linear-gradient(135deg, #f87171, #dc2626)";
      base.color = "#fff";
      base.border = "1px solid rgba(248,113,113,.5)";
      base.boxShadow = "0 2px 10px rgba(248,113,113,.3)";
      break;
    case "success":
      base.background = "linear-gradient(135deg, #34d399, #10b981)";
      base.color = "#06251c";
      base.border = "1px solid rgba(52,211,153,.5)";
      break;
    default:
      base.background = "rgba(120,150,255,.08)";
      base.color = THEME.text;
      base.border = `1px solid ${THEME.border}`;
  }
  return (
    <button className="ar-btn" style={{ ...base, ...style }} {...rest}>
      {children}
    </button>
  );
}

/* ----------------------------- layout ----------------------------- */

/** Card with a gradient border (glassmorphism + tech feel). */
export function GradCard({ children, style, innerStyle, hover }: { children: React.ReactNode; style?: React.CSSProperties; innerStyle?: React.CSSProperties; hover?: boolean }): React.ReactElement {
  return (
    <div className="ar-grad-border" style={{ margin: "6px 10px", ...style }}>
      <div className={"ar-grad-inner" + (hover ? " ar-card" : "")} style={{ padding: 10, ...innerStyle }}>
        {children}
      </div>
    </div>
  );
}

export function SectionTitle({ children, icon }: { children: React.ReactNode; icon?: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: THEME.text, padding: "8px 12px 4px" }}>
      {icon && <span style={{ fontSize: 14 }}>{icon}</span>}
      {children}
    </div>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", ...style }}>
      {children}
    </div>
  );
}
