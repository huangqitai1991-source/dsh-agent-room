/**
 * dsh-agent-room — Members tab: member list with roles/capability tags,
 * connection status of this node's channel, revoked list, human takeover,
 * and leave-room.
 */
import * as React from "react";
import type { ApiMember, ApiRoom } from "../api";
import { THEME, ROLE_ZH, ROLE_COLOR, ALL_ROLES, bridgeLabel } from "../theme";
import { Btn, Pill, Row, SectionTitle, StatusDot } from "./common";

export interface MembersProps {
  room: ApiRoom;
  localAgentId: string;
  takeOver: boolean;
  capsInput: string;
  leaveConfirm: string | null;
  confirmKick: string | null;
  confirmRevoke: string | null;
  confirmUnrevoke: string | null;
  onCapsInput(v: string): void;
  onSaveCaps(): void;
  onToggleTakeover(): void;
  onAssignRole(member: ApiMember, role: string): void;
  onSetMyRole(role: string): void;
  onArmKick(agentId: string): void;
  onDoKick(member: ApiMember): void;
  onArmRevoke(agentId: string): void;
  onDoRevoke(member: ApiMember): void;
  onArmUnrevoke(agentId: string): void;
  onDoUnrevoke(agentId: string): void;
  onArmLeave(): void;
  onDoLeave(): void;
}

export function Members(props: MembersProps): React.ReactElement {
  const { room, localAgentId, takeOver, capsInput } = props;
  const bridge = bridgeLabel(room.bridge);
  const me = room.members.find((m) => m.agentId === localAgentId);

  return (
    <div style={{ padding: "0 12px 10px", overflowY: "auto", maxHeight: "52vh" }}>
      {/* connection status of this node */}
      <div style={{ marginTop: 8, border: `1px solid ${THEME.border}`, borderRadius: 10, padding: "8px 10px", background: THEME.card }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: THEME.text }}>本机连接</span>
          <span style={{ flex: 1 }} />
          <Pill color={bridge.color} bg={bridge.color + "18"}>
            <StatusDot color={bridge.color} pulse={bridge.state === "open" || bridge.state === "reconnecting" || bridge.state === "disconnected"} size={6} />
            {bridge.text}
          </Pill>
        </div>
        {room.bridge?.address && (
          <div style={{ fontSize: 11, color: THEME.faint, marginTop: 4, fontFamily: THEME.mono }}>{room.bridge.address}</div>
        )}
        {room.bridge?.kind === "relay" && (
          <div style={{ fontSize: 11, color: THEME.cyan, marginTop: 4 }}>🌐 经中继桥接：直连不可达时自动切换跨网通道</div>
        )}
        {(bridge.state === "reconnecting" || bridge.state === "disconnected") && (
          <div style={{ fontSize: 11, color: THEME.amber, marginTop: 4 }}>⚠ 通道中断，正在自动重连…（无需手动操作）</div>
        )}
      </div>

      {/* members */}
      {room.members.map((m) => {
        const isMe = m.agentId === localAgentId;
        return (
          <div key={m.agentId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 2px", borderBottom: `1px solid rgba(120,150,255,.08)` }}>
            <span style={{ fontSize: 15 }}>{m.role === "owner" ? "👑" : "🤖"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: THEME.text }}>
                  {m.nickname} {isMe && <span style={{ color: THEME.cyan, fontSize: 11 }}>(我)</span>}
                </span>
                {m.agentId === room.controllerAgentId && <Pill color={THEME.purple} bg={THEME.purpleSoft}>判定人</Pill>}
              </div>
              <div style={{ display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap", alignItems: "center" }}>
                {(m.roles ?? []).map((r) => (
                  <Pill key={r} color={ROLE_COLOR[r] ?? THEME.accent}>{ROLE_ZH[r] ?? r}</Pill>
                ))}
                {(m.manualCapabilities ?? []).map((c) => (
                  <Pill key={"c-" + c} color={THEME.green} bg={THEME.greenSoft}>{c}</Pill>
                ))}
                <span style={{ fontSize: 10, color: THEME.faint, fontFamily: THEME.mono }}>{m.agentId.slice(0, 8)}</span>
              </div>
            </div>
            {room.owned && !isMe && m.role !== "owner" && (
              <>
                <select
                  className="ar-input"
                  style={{ width: "auto", padding: "3px 6px", fontSize: 11 }}
                  value={m.roles?.[0] ?? "observer"}
                  onChange={(e) => props.onAssignRole(m, e.target.value)}
                  title="安排岗位"
                >
                  {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_ZH[r] ?? r}</option>)}
                </select>
                <Btn
                  variant={props.confirmRevoke === m.agentId ? "danger" : "ghost"}
                  onClick={() => (props.confirmRevoke === m.agentId ? props.onDoRevoke(m) : props.onArmRevoke(m.agentId))}
                  title="吊销入场资格：踢出且禁止再加入"
                >
                  {props.confirmRevoke === m.agentId ? "确认吊销?" : "吊销"}
                </Btn>
                <Btn
                  variant={props.confirmKick === m.agentId ? "danger" : "ghost"}
                  onClick={() => (props.confirmKick === m.agentId ? props.onDoKick(m) : props.onArmKick(m.agentId))}
                  title="踢出（可重新加入）"
                >
                  {props.confirmKick === m.agentId ? "确认踢出?" : "踢出"}
                </Btn>
              </>
            )}
            {isMe && room.allowHumanTakeover && (
              <Btn variant={takeOver ? "primary" : "ghost"} onClick={props.onToggleTakeover}>{takeOver ? "释放接管" : "接管"}</Btn>
            )}
          </div>
        );
      })}

      {/* my role + capabilities */}
      <div style={{ marginTop: 8, border: `1px solid ${THEME.border}`, borderRadius: 10, padding: 8 }}>
        <Row style={{ padding: "2px 0" }}>
          <span style={{ fontSize: 12, color: THEME.dim }}>我的岗位:</span>
          <select
            className="ar-input"
            style={{ width: "auto", padding: "4px 8px", fontSize: 12 }}
            value={(me?.roles ?? ["observer"])[0] ?? "observer"}
            onChange={(e) => props.onSetMyRole(e.target.value)}
            title={room.owned ? "设置自己的岗位" : "申请岗位（由房主确认）"}
          >
            {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_ZH[r] ?? r}</option>)}
          </select>
        </Row>
        <Row style={{ padding: "2px 0" }}>
          <span style={{ fontSize: 12, color: THEME.dim }}>能力标签:</span>
          <input
            className="ar-input"
            style={{ flex: 1, padding: "5px 8px", fontSize: 12 }}
            placeholder="如: 前端, 后端, 财务"
            value={capsInput}
            onChange={(e) => props.onCapsInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && props.onSaveCaps()}
          />
          <Btn onClick={props.onSaveCaps}>保存</Btn>
        </Row>
      </div>

      {/* revoked */}
      {(room.revoked?.length ?? 0) > 0 && (
        <div style={{ marginTop: 8 }}>
          <SectionTitle icon="🚫">已吊销名单</SectionTitle>
          {room.revoked!.map((r) => (
            <Row key={r.agentId}>
              <span>🚫</span>
              <span style={{ flex: 1, fontSize: 12, color: THEME.text }}>
                {r.nickname ?? r.agentId.slice(0, 8)}
                {r.reason && <span style={{ color: THEME.faint, fontSize: 11 }}>（{r.reason}）</span>}
              </span>
              <span style={{ fontSize: 10, color: THEME.faint, fontFamily: THEME.mono }}>{r.agentId.slice(0, 8)}</span>
              {room.owned && (
                <Btn
                  variant={props.confirmUnrevoke === r.agentId ? "success" : "ghost"}
                  onClick={() => (props.confirmUnrevoke === r.agentId ? props.onDoUnrevoke(r.agentId) : props.onArmUnrevoke(r.agentId))}
                >
                  {props.confirmUnrevoke === r.agentId ? "确认解除?" : "解除吊销"}
                </Btn>
              )}
            </Row>
          ))}
        </div>
      )}

      {/* leave */}
      {!room.owned && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1, fontSize: 12, color: THEME.dim }}>退出此房间（保留房主侧记录）</span>
          <Btn variant={props.leaveConfirm === room.roomId ? "danger" : "ghost"} onClick={props.leaveConfirm === room.roomId ? props.onDoLeave : props.onArmLeave}>
            {props.leaveConfirm === room.roomId ? "⚠ 再点一次确认退出" : "退出"}
          </Btn>
        </div>
      )}
    </div>
  );
}
