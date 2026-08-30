/**
 * dsh-agent-room — Settings tab: room access settings (owner), cross-network
 * relay configuration (persisted on the host), bridge status, and danger zone.
 */
import * as React from "react";
import type { ApiRoom } from "../api";
import { THEME, bridgeLabel } from "../theme";
import { Btn, Pill, Row, SectionTitle, StatusDot } from "./common";

export interface SettingsProps {
  room: ApiRoom;
  owned: boolean;
  relayAddress?: string;
  relayConfigured: boolean;
  relayInput: string;
  nodeAddresses: string[];
  confirmDelete: boolean;
  onRelayInput(v: string): void;
  onSaveRelay(): void;
  onClearRelay(): void;
  onAuthMode(mode: "open" | "password"): void;
  onSetPassword(pw: string): void;
  onToggleAutoMode(v: boolean): void;
  onCopy(text: string): void;
  onArmDelete(): void;
  onDoDelete(): void;
}

export function Settings(props: SettingsProps): React.ReactElement {
  const { room, owned } = props;
  const bridge = bridgeLabel(room.bridge);

  return (
    <div style={{ padding: "0 12px 10px", overflowY: "auto", maxHeight: "52vh" }}>
      {/* relay configuration (node-wide) */}
      <div style={{ marginTop: 8, border: `1px solid ${THEME.borderStrong}`, borderRadius: 10, padding: 10, background: "linear-gradient(135deg, rgba(34,211,238,.1), rgba(91,140,255,.08))" }}>
        <SectionTitle icon="🌐">跨网中继（D7）</SectionTitle>
        <Row style={{ padding: "2px 0" }}>
          <input
            className="ar-input"
            style={{ flex: 1, padding: "7px 10px", fontSize: 13, fontFamily: THEME.mono }}
            placeholder="ws://relay-host:9320"
            value={props.relayInput}
            onChange={(e) => props.onRelayInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && props.onSaveRelay()}
          />
          <Btn variant="primary" onClick={props.onSaveRelay} disabled={!props.relayInput.trim()}>保存</Btn>
          <Btn variant="ghost" onClick={props.onClearRelay} disabled={!props.relayConfigured}>清除</Btn>
        </Row>
        <div style={{ fontSize: 11, color: THEME.faint, marginTop: 4, lineHeight: 1.6 }}>
          {props.relayConfigured && props.relayAddress
            ? <>当前中继: <code style={{ fontFamily: THEME.mono }}>{props.relayAddress}</code> — 本机房间会自动桥接，跨网成员经此加入；直连不可达时也走这里。</>
            : "未配置中继：仅支持同网段直连加入。配置后，本机房间自动桥接到中继，跨网可达。"}
        </div>
        {owned && (
          <Row style={{ padding: "4px 0" }}>
            <span style={{ fontSize: 12, color: THEME.dim }}>桥接状态:</span>
            <Pill color={bridge.color} bg={bridge.color + "18"}>
              <StatusDot color={bridge.color} pulse={bridge.state === "open" || bridge.state === "disconnected" || bridge.state === "connecting"} size={6} />
              {bridge.text}
            </Pill>
          </Row>
        )}
      </div>

      {owned && (
        <>
          {/* access */}
          <div style={{ marginTop: 10, border: `1px solid ${THEME.border}`, borderRadius: 10, padding: 10 }}>
            <SectionTitle icon="🔐">准入与判定</SectionTitle>
            <Row style={{ padding: "3px 0" }}>
              <span style={{ fontSize: 12, color: THEME.dim }}>准入模式</span>
              <select
                className="ar-input"
                style={{ width: "auto", padding: "5px 8px", fontSize: 12 }}
                value={room.authMode}
                onChange={(e) => props.onAuthMode(e.target.value as "open" | "password")}
              >
                <option value="open">公开</option>
                <option value="password">密码</option>
              </select>
              <span style={{ flex: 1 }} />
              <label style={{ fontSize: 12, color: THEME.dim, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                <input type="checkbox" checked={room.autoMode} onChange={(e) => props.onToggleAutoMode(e.target.checked)} />
                自治模式（agent 自决完成）
              </label>
            </Row>
            {room.authMode === "password" && (
              <Row style={{ padding: "3px 0" }}>
                <span style={{ fontSize: 12, color: THEME.dim }}>新密码</span>
                <input
                  className="ar-input"
                  style={{ flex: 1, padding: "5px 8px", fontSize: 12 }}
                  placeholder="留空则不修改"
                  id="ar-password"
                />
                <Btn onClick={() => {
                  const el = document.getElementById("ar-password") as HTMLInputElement | null;
                  if (el?.value) { props.onSetPassword(el.value); el.value = ""; }
                }}>设置密码</Btn>
              </Row>
            )}
          </div>

          {/* share address */}
          <div style={{ marginTop: 10, border: `1px solid ${THEME.border}`, borderRadius: 10, padding: 10 }}>
            <SectionTitle icon="📡">分享地址</SectionTitle>
            <Row style={{ padding: "3px 0", flexWrap: "wrap" }}>
              <code style={{ fontSize: 12, fontFamily: THEME.mono, color: THEME.cyan, background: THEME.cyanSoft, padding: "4px 8px", borderRadius: 6 }}>
                {room.serverAddress ?? "（尚未启动房间服务器）"}
              </code>
              {room.serverAddress && <Btn size="sm" onClick={() => props.onCopy(room.serverAddress!)}>复制</Btn>}
            </Row>
            {props.nodeAddresses.length > 0 && (
              <Row style={{ padding: "3px 0", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: THEME.faint }}>其他可用地址:</span>
                {props.nodeAddresses.map((a) => (
                  <code key={a} style={{ fontSize: 11, fontFamily: THEME.mono, color: THEME.dim, marginRight: 6 }}>{a}</code>
                ))}
              </Row>
            )}
          </div>

          {/* danger zone */}
          <div style={{ marginTop: 10, border: `1px solid rgba(248,113,113,.35)`, borderRadius: 10, padding: 10, background: THEME.redSoft }}>
            <Row style={{ padding: "3px 0" }}>
              <span style={{ flex: 1, fontSize: 12, color: THEME.red }}>删除房间（聊天与任务记录一并删除，不可恢复）</span>
              <Btn variant={props.confirmDelete ? "danger" : "ghost"} onClick={props.confirmDelete ? props.onDoDelete : props.onArmDelete}>
                {props.confirmDelete ? "⚠ 再点一次确认删除" : "删除"}
              </Btn>
            </Row>
          </div>
        </>
      )}
    </div>
  );
}
