/**
 * dsh-agent-room — Chat tab: message stream with seq pagination ("load older"),
 * client-side search, and the send bar (agent / human takeover / activate-chat).
 */
import * as React from "react";
import type { ApiMessage, ApiRoom } from "../api";
import { THEME, fmtTime } from "../theme";
import { Btn } from "./common";

export interface ChatProps {
  room: ApiRoom;
  messages: ApiMessage[];
  text: string;
  takeOver: boolean;
  /** True while the local agent is thinking for this room (activate-chat in flight). */
  thinking: boolean;
  search: string;
  loadingOlder: boolean;
  hasOlder: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
  onTextChange(v: string): void;
  onSend(): void;
  onSendHuman(): void;
  onToggleTakeover(): void;
  onActivateChat(): void;
  /** Persistent activate-chat error to show above the send bar (backend 500 /
   *  async followup failure / timeout). Null hides the banner. */
  activateError?: string | null;
  onClearActivateError(): void;
  onLoadOlder(): void;
  onSearchChange(v: string): void;
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: "rgba(251,191,36,.35)", color: "#ffd27d", borderRadius: 3, padding: "0 1px" }}>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export function Chat(props: ChatProps): React.ReactElement {
  const { room, messages, text, takeOver, thinking, search, loadingOlder, hasOlder, scrollRef, activateError } = props;
  const query = search.trim().toLowerCase();
  const filtered = query
    ? messages.filter((m) => m.text.toLowerCase().includes(query) || m.fromNickname.toLowerCase().includes(query))
    : messages;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* search bar */}
      <div style={{ padding: "6px 12px", borderBottom: `1px solid ${THEME.border}`, display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 13, opacity: 0.8 }}>🔍</span>
        <input
          className="ar-input"
          style={{ flex: 1, padding: "5px 9px", fontSize: 12 }}
          placeholder="搜索消息（按内容 / 发送者）"
          value={search}
          onChange={(e) => props.onSearchChange(e.target.value)}
        />
        {query && (
          <span style={{ fontSize: 11, color: THEME.faint }}>
            {filtered.length}/{messages.length} 条
          </span>
        )}
      </div>

      {/* message stream */}
      <div
        ref={scrollRef}
        onScroll={props.onScroll}
        style={{ flex: 1, overflowY: "auto", padding: "6px 12px", minHeight: 180, maxHeight: "44vh" }}
      >
        {!query && (
          <div style={{ textAlign: "center", padding: "4px 0 6px" }}>
            {loadingOlder ? (
              <span style={{ fontSize: 11, color: THEME.faint }}>加载中…</span>
            ) : hasOlder ? (
              <Btn size="sm" onClick={props.onLoadOlder}>↑ 加载更早消息</Btn>
            ) : (
              <span style={{ fontSize: 11, color: THEME.faint }}>已到最早</span>
            )}
          </div>
        )}
        {filtered.map((m) => (
          <div key={m.seq} style={{ padding: "3px 0", lineHeight: 1.5, fontSize: 13, color: THEME.text }}>
            {m.human && (
              <span style={{ background: "rgba(251,191,36,.2)", color: "#ffd27d", borderRadius: 4, padding: "1px 5px", marginRight: 6, fontSize: 11 }}>👤 人类</span>
            )}
            <span style={{ opacity: 0.55, marginRight: 6, fontSize: 12 }}>
              {m.fromNickname} {fmtTime(m.ts)}
            </span>
            <span style={{ wordBreak: "break-word" }}>{highlight(m.text, query)}</span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ opacity: 0.5, padding: 8, fontSize: 12, textAlign: "center" }}>
            {query ? "没有匹配的消息" : "还没有消息"}
          </div>
        )}
      </div>

      {/* activate-chat error (persistent until dismissed or next activate) */}
      {activateError && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px 0", fontSize: 12, color: THEME.red }}>
          <span style={{ flex: 1 }}>⚠ {activateError}</span>
          <button
            onClick={props.onClearActivateError}
            style={{ background: "none", border: "none", color: THEME.red, cursor: "pointer", fontSize: 14 }}
            title="关闭提示"
          >
            ✕
          </button>
        </div>
      )}

      {/* send bar */}
      <div style={{ display: "flex", gap: 8, padding: "8px 12px 10px", borderTop: `1px solid ${THEME.border}` }}>
        <input
          className="ar-input"
          style={{ flex: 1, padding: "8px 10px", fontSize: 14 }}
          value={text}
          placeholder={takeOver ? "以人类身份发言…（Enter 发送）" : "以本 agent 身份发言…（Enter 发送）"}
          onChange={(e) => props.onTextChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (takeOver ? props.onSendHuman() : props.onSend())}
        />
        <Btn
          variant="primary"
          disabled={thinking}
          title={thinking ? "本机 agent 正在思考中，回复完成后可再次激活" : "点击后本机 agent 基于房间上下文自动回复一条"}
          onClick={props.onActivateChat}
        >
          {thinking ? "⏳ 思考中…" : "💬 激活聊天"}
        </Btn>
        <Btn variant="ghost" onClick={props.onToggleTakeover} title="接管本机 agent 席位">
          {takeOver ? "释放接管" : "人类接管"}
        </Btn>
        <Btn variant="primary" onClick={takeOver ? props.onSendHuman : props.onSend} disabled={!text.trim()}>发送</Btn>
      </div>
    </div>
  );
}
