/**
 * dsh-agent-room — Settings tab: room access settings (owner), cross-network
 * relay configuration (persisted on the host), bridge status, and danger zone.
 */
import * as React from "react";
import type { ApiModeResult, ApiRoom } from "../api";
import { friendlyError, modeApi } from "../api";
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

  // One-click 中继 ⇄ 局域网. The current mode is relay whenever a relay address
  // is configured; the per-room bridge kind tells us whether THIS room actually
  // travels over it (mixed states are what the switch exists to repair).
  const relayOn = props.relayConfigured && Boolean(props.relayAddress);
  const bridgeKind = room.bridge?.kind ?? "none";
  const [modeBusy, setModeBusy] = React.useState(false);
  const [modeAddress, setModeAddress] = React.useState("");
  const [modeResult, setModeResult] = React.useState<ApiModeResult | null>(null);
  const [modeError, setModeError] = React.useState<string | null>(null);

  const switchMode = (mode: "lan" | "relay") => {
    setModeBusy(true);
    setModeError(null);
    setModeResult(null);
    void modeApi
      .set(mode, modeAddress.trim() || undefined)
      .then((data) => setModeResult(data))
      .catch((err: unknown) => setModeError(friendlyError(err instanceof Error ? err.message : String(err))))
      .finally(() => setModeBusy(false));
  };

  return (
    <div style={{ padding: "0 12px 10px", overflowY: "auto", maxHeight: "52vh" }}>
      {/* relay configuration (node-wide) */}
      <div style={{ marginTop: 8, border: `1px solid ${THEME.borderStrong}`, borderRadius: 10, padding: 10, background: "linear-gradient(135deg, rgba(192,132,252,.12), rgba(139,92,246,.1))" }}>
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
        {/* one-click mode switch: relay-config + re-join of every joined room */}
        <div style={{ marginTop: 8, borderTop: `1px solid ${THEME.border}`, paddingTop: 8 }}>
          <Row style={{ padding: "2px 0", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: THEME.dim }}>当前模式:</span>
            <Pill color={relayOn ? THEME.purple : THEME.cyan} bg={(relayOn ? THEME.purple : THEME.cyan) + "18"}>
              {relayOn ? "中继" : "局域网直连"}
            </Pill>
            <span style={{ fontSize: 11, color: THEME.faint }}>
              本房间: {bridgeKind === "relay" ? "经中继" : bridgeKind === "direct" ? "直连" : "未连接（none）"}
            </span>
          </Row>
          <Row style={{ padding: "4px 0", flexWrap: "wrap" }}>
            <Btn
              variant="primary"
              disabled={modeBusy || (!relayOn && !props.relayConfigured)}
              onClick={() => switchMode(relayOn ? "lan" : "relay")}
            >
              {modeBusy ? "切换中…" : relayOn ? "⇄ 切到局域网" : "⇄ 切到中继"}
            </Btn>
            {relayOn && (
              <input
                className="ar-input"
                style={{ flex: 1, minWidth: 180, padding: "6px 9px", fontSize: 12, fontFamily: THEME.mono }}
                placeholder="192.168.31.x:9317（自动探测为空时手填）"
                value={modeAddress}
                onChange={(e) => setModeAddress(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && switchMode("lan")}
              />
            )}
          </Row>
          <div style={{ fontSize: 11, color: THEME.faint, lineHeight: 1.6 }}>
            一键切换：改中继配置 + 用匹配模式的地址重新加入所有已加入房间（本机自己的房间自动跳过）。
            {relayOn && bridgeKind === "direct"
              ? " 注意：本房间当前走直连，可能与中继配置不一致——点上面的按钮可统一。"
              : ""}
          </div>
          {modeError && (
            <div style={{ fontSize: 11, color: THEME.red, marginTop: 4, lineHeight: 1.6 }}>切换失败：{modeError}</div>
          )}
          {modeResult && (
            <div style={{ fontSize: 11, marginTop: 4, lineHeight: 1.7 }}>
              <div style={{ color: THEME.dim }}>
                已切到{modeResult.mode === "relay" ? "中继" : "局域网"}；
                候选地址 {modeResult.addresses.length > 0 ? modeResult.addresses.join(", ") : "（无）"}；
                房间 {modeResult.rooms.filter((r) => r.ok && !r.cleaned).length}/
                {modeResult.rooms.filter((r) => !r.cleaned).length} 重连成功。
              </div>
              {modeResult.rooms.map((r) => (
                <div key={r.roomId} style={{ color: r.cleaned ? THEME.dim : r.ok ? THEME.cyan : THEME.red }}>
                  {r.cleaned ? "· " : r.ok ? "✓ " : "✗ "}
                  {r.title || r.roomId.slice(0, 8)}
                  {r.cleaned ? " 已关闭 · 已清理记录" : r.ok ? " 已重新加入" : ` 失败：${r.error ?? "未知原因"}`}
                </div>
              ))}
            </div>
          )}
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
