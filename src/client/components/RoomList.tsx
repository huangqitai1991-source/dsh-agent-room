/**
 * dsh-agent-room — RoomList: create/join panel (input-driven, no window.prompt),
 * owned/joined room rows with status + bridge badges and unread counts, and the
 * LAN-discovered rooms shortcut list.
 */
import * as React from "react";
import type { ApiDiscoveredRoom, ApiRoom } from "../api";
import { THEME, bridgeLabel, statusZh } from "../theme";
import { Btn, Pill, Row, StatusBadge, StatusDot, UnreadDot } from "./common";

export interface RoomListProps {
  rooms: ApiRoom[];
  discovered: ApiDiscoveredRoom[];
  activeRoomId: string | null;
  unread: Record<string, number>;
  creating: boolean;
  joining: boolean;
  createTitle: string;
  createType: "persistent" | "temporary";
  joinAddr: string;
  relayHint: boolean;
  onCreateTitle(v: string): void;
  onCreateType(v: "persistent" | "temporary"): void;
  onJoinAddr(v: string): void;
  onToggleCreate(): void;
  onToggleJoin(): void;
  onCreate(): void;
  onJoin(): void;
  onJoinDiscovered(room: ApiDiscoveredRoom): void;
  onSelect(roomId: string): void;
  onCopy(text: string): void;
  leaveConfirm: string | null;
  onArmLeave(roomId: string): void;
}

export function RoomList(props: RoomListProps): React.ReactElement {
  const {
    rooms, discovered, activeRoomId, unread, creating, joining, createTitle, createType, joinAddr,
    onCreateTitle, onCreateType, onJoinAddr, onToggleCreate, onToggleJoin, onCreate, onJoin,
    onJoinDiscovered, onSelect, onCopy, leaveConfirm, onArmLeave, relayHint,
  } = props;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* create / join action bar */}
      <div style={{ display: "flex", gap: 8, padding: "8px 12px", borderBottom: `1px solid ${THEME.border}` }}>
        <Btn variant={creating ? "primary" : "ghost"} onClick={onToggleCreate}>{creating ? "收起新建" : "＋ 新建房间"}</Btn>
        <Btn variant={joining ? "primary" : "ghost"} onClick={onToggleJoin}>{joining ? "收起加入" : "⇥ 加入房间"}</Btn>
      </div>

      {creating && (
        <div className="ar-fade-in" style={{ padding: "8px 12px", borderBottom: `1px solid ${THEME.border}`, background: THEME.accentSoft }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="ar-input"
              style={{ flex: 1, padding: "8px 10px", fontSize: 14 }}
              placeholder="输入房间标题，例如：D7 联调房间"
              value={createTitle}
              autoFocus
              onChange={(e) => onCreateTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onCreate()}
            />
            <Btn variant="primary" onClick={onCreate} disabled={!createTitle.trim()}>创建</Btn>
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 8, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: THEME.dim, cursor: "pointer" }}>
              <input type="radio" checked={createType === "persistent"} onChange={() => onCreateType("persistent")} /> 长期持久
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: THEME.dim, cursor: "pointer" }}>
              <input type="radio" checked={createType === "temporary"} onChange={() => onCreateType("temporary")} /> 临时（本机关闭即销毁）
            </label>
          </div>
        </div>
      )}

      {joining && (
        <div className="ar-fade-in" style={{ padding: "8px 12px", borderBottom: `1px solid ${THEME.border}`, background: THEME.cyanSoft }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="ar-input"
              style={{ flex: 1, padding: "8px 10px", fontSize: 14, fontFamily: THEME.mono }}
              placeholder="host:port 或 relay://…"
              value={joinAddr}
              autoFocus
              onChange={(e) => onJoinAddr(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onJoin()}
            />
            <Btn variant="primary" onClick={onJoin} disabled={!joinAddr.trim()}>加入</Btn>
          </div>
          <div style={{ fontSize: 11, color: THEME.faint, marginTop: 6, lineHeight: 1.5 }}>
            {relayHint
              ? "支持 host:port 或 relay://…；直连不可达时自动走中继（跨网）"
              : "支持 host:port（同网段直连）或 relay://…（跨网中继）"}
          </div>
        </div>
      )}

      {/* room rows */}
      <div style={{ maxHeight: 210, overflowY: "auto" }}>
        {rooms.map((room) => {
          const active = room.roomId === activeRoomId;
          const bridge = bridgeLabel(room.bridge);
          const n = unread[room.roomId] ?? 0;
          return (
            <div
              key={room.roomId}
              onClick={() => onSelect(room.roomId)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                cursor: "pointer",
                background: active ? "linear-gradient(90deg, rgba(91,140,255,.2), rgba(34,211,238,.06))" : "transparent",
                borderLeft: active ? `2px solid ${THEME.accent}` : "2px solid transparent",
                transition: "background .15s ease",
              }}
            >
              <span style={{ fontSize: 16 }}>{room.type === "temporary" ? "⚡" : "📁"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 14, color: THEME.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{room.title}</span>
                  {n > 0 && <UnreadDot count={n} />}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                  <span style={{ fontSize: 11, color: THEME.faint }}>{room.owned ? "我创建" : "已加入"} · {room.memberCount}人 · {room.authMode === "password" ? "🔒" : "公开"}</span>
                  <StatusBadge text={statusZh(room.status)} status={room.status} />
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Pill color={bridge.color} bg={bridge.color + "18"}>
                  <StatusDot color={bridge.color} pulse={bridge.state === "open" || bridge.state === "disconnected" || bridge.state === "reconnecting"} size={6} />
                  {bridge.text}
                </Pill>
                {room.owned && room.serverAddress && (
                  <span
                    title="点击复制分享地址"
                    onClick={(e) => { e.stopPropagation(); onCopy(room.serverAddress ?? ""); }}
                    style={{ fontSize: 10, fontFamily: THEME.mono, color: THEME.faint, cursor: "pointer", border: `1px dashed ${THEME.border}`, borderRadius: 6, padding: "2px 5px" }}
                  >
                    {room.serverAddress}
                  </span>
                )}
                {!room.owned && (
                  <Btn
                    variant={leaveConfirm === room.roomId ? "danger" : "ghost"}
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); onArmLeave(room.roomId); }}
                    title="退出该房间"
                  >
                    {leaveConfirm === room.roomId ? "确认退出?" : "退出"}
                  </Btn>
                )}
              </div>
            </div>
          );
        })}
        {rooms.length === 0 && (
          <div style={{ padding: "14px 12px", fontSize: 13, color: THEME.faint, textAlign: "center" }}>
            还没有房间 —— 上方新建，或从局域网发现列表中直接加入
          </div>
        )}
      </div>

      {/* LAN discovered */}
      {discovered.length > 0 && (
        <div style={{ borderTop: `1px solid ${THEME.border}`, maxHeight: 170, overflowY: "auto" }}>
          <Row style={{ fontSize: 11, fontWeight: 700, color: THEME.faint, letterSpacing: 1 }}>
            📡 局域网发现（同网段快捷加入）
          </Row>
          {discovered.map((room) => {
            const joined = rooms.some((r) => r.roomId === room.roomId);
            return (
              <div
                key={`${room.addresses[0]}/${room.roomId}`}
                onClick={() => onSelect(room.roomId)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", cursor: "pointer", opacity: joined ? 0.7 : 1 }}
              >
                <span>{joined ? "✅" : "🏠"}</span>
                <span style={{ flex: 1, fontSize: 13, color: THEME.text }}>{room.title}</span>
                <span style={{ fontSize: 11, color: THEME.faint }}>
                  {room.nickname} · {room.memberCount}人 · {room.authMode === "password" ? "🔒密码" : "公开"}
                </span>
                <Btn
                  size="sm"
                  variant={joined ? "success" : "primary"}
                  onClick={(e) => { e.stopPropagation(); if (!joined) onJoinDiscovered(room); }}
                  disabled={joined}
                >
                  {joined ? "已加入" : "加入"}
                </Btn>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
