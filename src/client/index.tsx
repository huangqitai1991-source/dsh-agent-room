/**
 * dsh-agent-room — web client module.
 *
 * Registers a hover tab in the conversation session header (top of the page):
 * the room panel slides out below the tab while the mouse is over it and
 * retracts when the mouse leaves. Data flows through the host browser API
 * (/agent-room-api/*) with light polling; no direct LAN connections from the
 * browser in v0.1.
 */

import * as React from "react";

/* ----------------------------- types (client projection) ----------------------------- */

interface ApiMember {
  agentId: string;
  nickname: string;
  role: "owner" | "member";
  joinedAt: string;
  capabilities?: string[];
  manualCapabilities?: string[];
  roles?: string[];
}

interface ApiRevoked {
  agentId: string;
  nickname?: string;
  revokedAt: string;
  by: string;
  reason?: string;
}

interface ApiTask {
  taskId: string;
  title: string;
  description?: string;
  status: "todo" | "doing" | "review" | "done" | "rejected";
  assignee?: string;
  claimable?: boolean;
  requiredCapabilities?: string[];
  requiredRoles?: string[];
  acceptance?: string;
  handoff?: { done: string; basis?: string; next: string; risk?: string };
  createdBy: string;
  judge?: { mode: "controller" | "auto"; note?: string };
  comments?: Array<{ agentId: string; ts: string; text: string }>;
}

interface ApiDiscoveredRoom {
  roomId: string;
  title: string;
  authMode: "open" | "password";
  memberCount: number;
  addresses: string[];
  nickname: string;
}

interface ApiRoom {
  roomId: string;
  title: string;
  type: "persistent" | "temporary";
  status: "open" | "suspended" | "closed";
  owned: boolean;
  authMode: "open" | "password";
  autoMode: boolean;
  allowHumanTakeover: boolean;
  controllerAgentId: string;
  serverAddress?: string;
  memberCount: number;
  members: ApiMember[];
  tasks: ApiTask[];
  revoked?: ApiRevoked[];
  autoReply?: boolean;
}

interface ApiMessage {
  seq: number;
  from: string;
  fromNickname: string;
  ts: string;
  text: string;
  human?: boolean;
}

interface RoomState {
  identity: { agentId: string; nickname: string; capabilities: string[] };
  node?: { hostname: string; addresses?: string[] };
  discovered?: ApiDiscoveredRoom[];
  rooms: ApiRoom[];
}

/* ----------------------------- api helpers ----------------------------- */

async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as { ok: boolean; data?: T; error?: string };
  if (!json.ok || !response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
  return json.data as T;
}

const stateApi = () => api<RoomState>("/agent-room-api/state");
const messagesApi = (roomId: string, before?: number) =>
  api<{ messages: ApiMessage[] }>(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/messages${before !== undefined ? `?before=${before}` : ""}`);

/* ----------------------------- styles ---------------------------------- */

const S = {
  topTabWrap: {
    position: "relative" as const,
    display: "inline-flex",
    alignItems: "center",
  },
  topTab: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 10px",
    fontSize: 12,
    fontWeight: 600,
    color: "#111",
    background: "linear-gradient(135deg, rgba(74,125,255,.18), rgba(46,158,68,.14))",
    border: "1px solid rgba(74,125,255,.45)",
    borderRadius: 999,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    userSelect: "none" as const,
    boxShadow: "0 2px 8px rgba(74,125,255,.25)",
  },
  dropdown: {
    position: "absolute" as const,
    top: "calc(100% + 8px)",
    right: 0,
    width: 460,
    maxWidth: "min(460px, calc(100vw - 24px))",
    background: "rgba(22,24,30,.92)",
    border: "1px solid rgba(74,125,255,.35)",
    borderRadius: 12,
    boxShadow: "0 16px 44px rgba(0,0,0,.5), 0 0 0 1px rgba(74,125,255,.12), 0 0 24px rgba(74,125,255,.18)",
    zIndex: 999,
    overflow: "hidden",
    fontSize: 13,
    color: "#fff",
    transition: "max-height .28s ease, opacity .22s ease, transform .28s ease",
  } as React.CSSProperties,
  dropdownClosed: {
    maxHeight: 0,
    opacity: 0,
    transform: "translateY(-6px)",
    pointerEvents: "none",
  } as React.CSSProperties,
  dropdownOpen: {
    maxHeight: "72vh",
    opacity: 1,
    transform: "translateY(0)",
  } as React.CSSProperties,
  panelScroll: {
    overflowY: "auto" as const,
    maxHeight: "calc(72vh - 8px)",
    display: "flex",
    flexDirection: "column" as const,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderBottom: "1px solid var(--dsh-border-color, rgba(128,128,128,.25))",
    fontWeight: 600,
    flexShrink: 0,
  },
  row: { display: "flex", alignItems: "center", gap: 8, padding: "4px 10px" },
  input: {
    flex: 1,
    background: "rgba(0,0,0,.28)",
    border: "1px solid var(--dsh-border-color, rgba(128,128,128,.4))",
    borderRadius: 6,
    padding: "4px 8px",
    color: "inherit",
    fontSize: 13,
  },
  select: {
    flex: 1,
    background: "rgba(255,255,255,.92)",
    border: "1px solid var(--dsh-border-color, rgba(128,128,128,.4))",
    borderRadius: 6,
    padding: "4px 8px",
    color: "#111",
    fontSize: 13,
  },
  button: {
    background: "var(--dsh-accent, #4a7dff)",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
  },
  buttonGhost: {
    background: "transparent",
    border: "1px solid var(--dsh-border-color, rgba(128,128,128,.5))",
    borderRadius: 6,
    padding: "3px 8px",
    fontSize: 12,
    cursor: "pointer",
    color: "inherit",
  },
  tab: {
    background: "transparent",
    border: "none",
    borderBottom: "2px solid transparent",
    padding: "6px 10px",
    fontSize: 12,
    cursor: "pointer",
    color: "inherit",
    opacity: 0.7,
  },
  tabActive: { opacity: 1, borderBottomColor: "var(--dsh-accent, #4a7dff)" },
  list: { overflowY: "auto" as const, flex: 1, minHeight: 60 },
  msg: { padding: "2px 0", lineHeight: 1.35 },
  meta: { opacity: 0.6, marginRight: 6, fontSize: 12 },
  human: { background: "#fff3bf", color: "#5c4a00", borderRadius: 4, padding: "0 4px", marginRight: 6, fontSize: 11 },
  task: { padding: "6px 10px", borderBottom: "1px solid var(--dsh-border-color, rgba(128,128,128,.15))" },
  badge: (text: string) => ({
    display: "inline-block",
    fontSize: 11,
    borderRadius: 4,
    padding: "0 5px",
    marginLeft: 6,
    background: badgeColor(text),
    color: "#fff",
  }),
  err: { color: "#e5484d", padding: "4px 10px", fontSize: 12 },
  banner: {
    background: "rgba(255,193,7,.18)",
    color: "#8a6d00",
    padding: "4px 10px",
    fontSize: 12,
    borderBottom: "1px solid rgba(255,193,7,.4)",
  },
};

function badgeColor(status: string): string {
  switch (status) {
    case "todo": return "#888";
    case "doing": return "#4a7dff";
    case "review": return "#b26a00";
    case "done": return "#2e9e44";
    case "rejected": return "#e5484d";
    default: return "#888";
  }
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

const ROLE_ZH: Record<string, string> = {
  observer: "观察者",
  controller: "总控",
  researcher: "资料",
  executor: "执行",
  reviewer: "复核",
};

const ALL_ROLES = ["observer", "controller", "researcher", "executor", "reviewer"];

/* ----------------------------- dock component -------------------------- */

function RoomDock(): React.ReactElement {
  const [state, setState] = React.useState<RoomState | null>(null);
  const [activeRoomId, setActiveRoomId] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<"chat" | "tasks" | "members" | "settings">("chat");
  const [messages, setMessages] = React.useState<ApiMessage[]>([]);
  const [takeover, setTakeover] = React.useState(false);
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [joining, setJoining] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [confirmKickAgent, setConfirmKickAgent] = React.useState<string | null>(null);
  const [confirmLeaveRoom, setConfirmLeaveRoom] = React.useState<string | null>(null);
  const [confirmDeleteTask, setConfirmDeleteTask] = React.useState<string | null>(null);
  const [confirmRevokeAgent, setConfirmRevokeAgent] = React.useState<string | null>(null);
  const [confirmUnrevokeAgent, setConfirmUnrevokeAgent] = React.useState<string | null>(null);
  const chatScrollRef = React.useRef<HTMLDivElement | null>(null);
  const openTimer = React.useRef<number | null>(null);
  const closeTimer = React.useRef<number | null>(null);
  const confirmTimer = React.useRef<number | null>(null);

  const resetConfirms = () => {
    setConfirmDelete(false);
    setConfirmKickAgent(null);
    setConfirmLeaveRoom(null);
    setConfirmDeleteTask(null);
    setConfirmRevokeAgent(null);
    setConfirmUnrevokeAgent(null);
  };

  /** Two-step inline confirm (browser dialogs can be blocked, so no window.confirm). */
  const armConfirm = (kind: "delete" | "leave", roomId?: string) => {
    setConfirmDelete(kind === "delete");
    setConfirmKickAgent(null);
    setConfirmLeaveRoom(kind === "leave" ? roomId ?? null : null);
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => {
      confirmTimer.current = null;
      resetConfirms();
    }, 3500);
  };

  const scheduleOpen = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (openTimer.current === null) openTimer.current = window.setTimeout(() => { openTimer.current = null; setOpen(true); }, 120);
  };

  const scheduleClose = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current === null) closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setOpen(false); }, 220);
  };

  React.useEffect(
    () => () => {
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    },
    [],
  );

  // Tech-feel styling: transitions, hover lift, glow — injected once.
  React.useEffect(() => {
    if (document.getElementById("ar-style")) return;
    const style = document.createElement("style");
    style.id = "ar-style";
    style.textContent = `
      .ar-tab { transition: box-shadow .25s ease, border-color .25s ease, transform .25s ease; }
      .ar-tab:hover { box-shadow: 0 0 16px rgba(74,125,255,.6); border-color: rgba(74,125,255,.75); transform: translateY(-1px); }
      .ar-panel { backdrop-filter: blur(14px) saturate(1.1); }
      .ar-panel button, .ar-panel select, .ar-panel input { transition: transform .15s ease, filter .15s ease, background .15s ease, box-shadow .15s ease; }
      .ar-panel button:hover { filter: brightness(1.18); transform: translateY(-1px); }
      .ar-panel button:active { transform: scale(.95); }
    `;
    document.head.appendChild(style);
  }, []);

  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      stateApi()
        .then((s) => {
          if (!alive) return;
          setState(s);
          setError(null);
        })
        .catch((err: Error) => alive && setError(err.message));
    };
    tick();
    const timer = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  React.useEffect(() => {
    if (!activeRoomId) return;
    let alive = true;
    const tick = () => {
      messagesApi(activeRoomId)
        .then((d) => alive && setMessages(d.messages))
        .catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [activeRoomId]);

  // Auto-scroll the chat to the bottom whenever messages change or the chat tab opens.
  React.useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, tab]);

  const loadOlder = () => {
    if (!activeRoomId) return;
    const oldest = messages[0]?.seq;
    void messagesApi(activeRoomId, oldest)
      .then((d) => {
        if (d.messages.length > 0) {
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.seq));
            const older = d.messages.filter((m) => !seen.has(m.seq));
            return [...older, ...prev];
          });
        }
      })
      .catch(() => {});
  };

  const activeRoom = state?.rooms.find((r) => r.roomId === activeRoomId) ?? null;
  const localAgentId = state?.identity.agentId;

  /** Always sends POST (empty body when none given) — GET would 404 the action routes. */
  const post = async (path: string, body?: unknown) => {
    try {
      await api(path, body ?? {});
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const refreshState = (thenSelectRoomId?: string) => {
    window.setTimeout(() => {
      stateApi()
        .then((s) => {
          setState(s);
          if (thenSelectRoomId) setActiveRoomId(thenSelectRoomId);
        })
        .catch(() => {});
    }, 400);
  };

  const createRoom = () => {
    const title = window.prompt("房间标题:");
    if (!title) return;
    const type = window.confirm("临时房间？（确定=临时，取消=长期持久）") ? "temporary" : "persistent";
    void post("/agent-room-api/rooms", { title, type }).then(() => refreshState());
  };

  const joinRoom = () => {
    const address = window.prompt("房主分享的地址 (host:port):");
    if (!address) return;
    const password = window.prompt("密码（无则留空）:", "") ?? undefined;
    void api<{ roomId: string }>("/agent-room-api/join", { address, password: password || undefined })
      .then((d) => refreshState(d.roomId))
      .catch((err: Error) => setError(err.message));
  };

  const joinDiscovered = (room: ApiDiscoveredRoom) => {
    const password = room.authMode === "password" ? (window.prompt(`房间「${room.title}」需要密码:`) ?? undefined) : undefined;
    void api<{ roomId: string }>("/agent-room-api/join", { addresses: room.addresses, roomId: room.roomId, password })
      .then((d) => refreshState(d.roomId))
      .catch((err: Error) => setError(err.message));
  };

  const sendChat = () => {
    if (!activeRoom || !text.trim()) return;
    const roomId = activeRoom.roomId;
    void post(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/chat`, { text, human: takeover }).then(() => {
      setText("");
      // Immediate refresh so the sender sees their own message at once.
      messagesApi(roomId).then((d) => setMessages(d.messages)).catch(() => {});
    });
  };

  const sendHumanMessage = () => {
    if (!activeRoom || !text.trim()) return;
    const roomId = activeRoom.roomId;
    void post(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/chat`, { text, human: true }).then(() => {
      setText("");
      messagesApi(roomId).then((d) => setMessages(d.messages)).catch(() => {});
    });
  };

  const createTask = () => {
    if (!activeRoom) return;
    const title = window.prompt("任务标题:");
    if (!title) return;
    const judgeMode = window.confirm("自治模式（agent 自决完成）？确定=auto，取消=controller") ? "auto" : "controller";
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks`, { title, judgeMode, claimable: true });
  };

  /** Two-step inline confirm (browser dialogs can be blocked, so no window.confirm). */
  const doDeleteRoom = () => {
    if (!activeRoom) return;
    setConfirmDelete(false);
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/delete`).then(() => {
      setActiveRoomId(null);
      window.setTimeout(() => stateApi().then(setState).catch(() => {}), 400);
    });
  };

  const doLeaveRoom = () => {
    const roomId = confirmLeaveRoom ?? activeRoom?.roomId;
    if (!roomId) return;
    setConfirmLeaveRoom(null);
    void post(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/leave`).then(() => {
      if (activeRoomId === roomId) setActiveRoomId(null);
      window.setTimeout(() => stateApi().then(setState).catch(() => {}), 400);
    });
  };

  const armKick = (agentId: string) => {
    setConfirmDelete(false);
    setConfirmLeaveRoom(null);
    setConfirmKickAgent(agentId);
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => {
      confirmTimer.current = null;
      resetConfirms();
    }, 3500);
  };

  const doKickMember = (member: ApiMember) => {
    if (!activeRoom) return;
    setConfirmKickAgent(null);
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(member.agentId)}/kick`).then(() =>
      window.setTimeout(() => stateApi().then(setState).catch(() => {}), 400),
    );
  };

  const armRevoke = (agentId: string) => {
    setConfirmDelete(false);
    setConfirmLeaveRoom(null);
    setConfirmKickAgent(null);
    setConfirmDeleteTask(null);
    setConfirmUnrevokeAgent(null);
    setConfirmRevokeAgent(agentId);
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => {
      confirmTimer.current = null;
      resetConfirms();
    }, 3500);
  };

  const doRevokeMember = (member: ApiMember) => {
    if (!activeRoom) return;
    setConfirmRevokeAgent(null);
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(member.agentId)}/revoke`).then(() =>
      window.setTimeout(() => stateApi().then(setState).catch(() => {}), 400),
    );
  };

  const armUnrevoke = (agentId: string) => {
    setConfirmDelete(false);
    setConfirmLeaveRoom(null);
    setConfirmKickAgent(null);
    setConfirmDeleteTask(null);
    setConfirmRevokeAgent(null);
    setConfirmUnrevokeAgent(agentId);
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => {
      confirmTimer.current = null;
      resetConfirms();
    }, 3500);
  };

  const doUnrevokeMember = (agentId: string) => {
    if (!activeRoom) return;
    setConfirmUnrevokeAgent(null);
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(agentId)}/unrevoke`).then(() =>
      window.setTimeout(() => stateApi().then(setState).catch(() => {}), 400),
    );
  };

  const armDeleteTask = (taskId: string) => {
    setConfirmDeleteTask(taskId);
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => {
      confirmTimer.current = null;
      resetConfirms();
    }, 3500);
  };

  const doDeleteTask = (taskId: string) => {
    if (!activeRoom) return;
    setConfirmDeleteTask(null);
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${encodeURIComponent(taskId)}/remove`).then(() =>
      window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300),
    );
  };

  const assignRole = (member: ApiMember, role: string) => {
    if (!activeRoom) return;
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(member.agentId)}/roles`, { roles: [role] }).then(() =>
      window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300),
    );
  };

  const setMyRole = (role: string) => {
    if (!activeRoom) return;
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/member-roles`, { roles: [role] }).then(() =>
      window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300),
    );
  };

  const saveMyCaps = () => {
    if (!activeRoom) return;
    const el = document.getElementById("ar-caps") as HTMLInputElement | null;
    const tags = (el?.value ?? "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/member-capabilities`, { capabilities: tags }).then(() => {
      if (el) el.value = "";
      window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300);
    });
  };

  return (
    <div style={S.topTabWrap} onMouseEnter={scheduleOpen} onMouseLeave={scheduleClose}>
      <div className="ar-tab" style={S.topTab} role="button" title="Agent 房间（悬停展开）">
        <span>🤖</span>
        <span>Agent 房间{state ? ` · ${state.rooms.length}` : ""}</span>
      </div>
      <div className="ar-panel" style={open ? { ...S.dropdown, ...S.dropdownOpen } : { ...S.dropdown, ...S.dropdownClosed }}>
        <div style={S.panelScroll}>
      <div style={S.header}>
        <span>🤖 Agent 房间</span>
        <span style={{ opacity: 0.6, fontSize: 12, fontWeight: 400 }}>
          {state ? `${state.identity.nickname} · ${state.rooms.length} 个房间` : "…"}
        </span>
        <span style={{ flex: 1 }} />
        <button style={S.buttonGhost} onClick={() => setCreating((v) => !v)}>新建</button>
        <button style={S.buttonGhost} onClick={() => setJoining((v) => !v)}>加入</button>
      </div>

      {error && <div style={S.err}>⚠ {error}</div>}
      {takeover && <div style={S.banner}>👤 人类接管模式：你的消息将以人类身份发送</div>}

      <div style={{ maxHeight: 200, overflowY: "auto", borderBottom: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))" }}>
        {state?.rooms.map((room) => (
          <div key={room.roomId} style={{ ...S.row, background: room.roomId === activeRoomId ? "rgba(74,125,255,.12)" : undefined, cursor: "pointer" }} onClick={() => setActiveRoomId(room.roomId)}>
            <span>{room.type === "temporary" ? "⚡" : "📁"}</span>
            <span style={{ flex: 1 }}>{room.title}</span>
            <span style={{ opacity: 0.6, fontSize: 11 }}>
              {room.owned ? "我创建" : "加入"} · {room.memberCount}人 · {room.authMode}
            </span>
            <span style={S.badge(room.status)}>{room.status}</span>
            {room.owned && room.serverAddress && (
              <span style={{ opacity: 0.55, fontSize: 11, fontFamily: "monospace" }}>{room.serverAddress}</span>
            )}
            {!room.owned && (
              <button
                style={confirmLeaveRoom === room.roomId ? { ...S.button, background: "#e5484d", padding: "1px 6px" } : { ...S.buttonGhost, padding: "1px 6px", fontSize: 11 }}
                title="退出该房间"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirmLeaveRoom === room.roomId) doLeaveRoom();
                  else armConfirm("leave", room.roomId);
                }}
              >{confirmLeaveRoom === room.roomId ? "确认退出?" : "退出"}</button>
            )}
          </div>
        ))}
        {(state?.rooms.length ?? 0) === 0 && <div style={{ ...S.row, opacity: 0.55 }}>还没有房间 —— 新建一个或加入局域网房间</div>}
      </div>

      {(state?.discovered?.length ?? 0) > 0 && (
        <div style={{ borderBottom: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))" }}>
          <div style={{ ...S.row, opacity: 0.6, fontSize: 11, fontWeight: 600 }}>📡 局域网发现（点击直接加入）</div>
          {state!.discovered!.map((room) => {
            const joined = (state?.rooms ?? []).some((r) => r.roomId === room.roomId);
            return (
              <div
                key={`${room.addresses[0]}/${room.roomId}`}
                style={{ ...S.row, cursor: "pointer", opacity: joined ? 0.75 : 1 }}
                onClick={() => { if (joined) setActiveRoomId(room.roomId); else joinDiscovered(room); }}
              >
                <span>{joined ? "✅" : "🏠"}</span>
                <span style={{ flex: 1 }}>{room.title}</span>
                <span style={{ opacity: 0.6, fontSize: 11 }}>
                  {room.nickname} · {room.memberCount}人 · {room.authMode === "password" ? "🔒密码" : "公开"}
                </span>
                {joined ? (
                  <button style={{ ...S.buttonGhost, opacity: 0.6 }} onClick={(e) => { e.stopPropagation(); setActiveRoomId(room.roomId); }} title="已加入，点击打开">已加入</button>
                ) : (
                  <button style={S.buttonGhost} onClick={(e) => { e.stopPropagation(); joinDiscovered(room); }}>加入</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {creating && (
        <div style={S.row}>
          <input style={S.input} placeholder="标题" id="ar-create-title" />
          <button style={S.button} onClick={createRoom}>创建</button>
        </div>
      )}
      {joining && (
        <div style={S.row}>
          <input style={S.input} placeholder="host:port" id="ar-join-addr" />
          <button style={S.button} onClick={joinRoom}>加入</button>
        </div>
      )}

      {activeRoom && (
        <>
          <div style={S.row}>
            {(["chat", "tasks", "members", "settings"] as const).map((t) => (
              <button key={t} style={tab === t ? { ...S.tab, ...S.tabActive } : S.tab} onClick={() => setTab(t)}>
                {t === "chat" ? "聊天" : t === "tasks" ? "任务" : t === "members" ? "成员" : "设置"}
              </button>
            ))}
          </div>

          {tab === "chat" && (
            <>
              <div ref={chatScrollRef} style={{ ...S.list, padding: "0 10px", maxHeight: "42vh", overflowY: "auto" }}>
                <div style={{ textAlign: "center", padding: "2px 0" }}>
                  <button style={{ ...S.buttonGhost, fontSize: 11 }} onClick={loadOlder}>↑ 加载更早消息</button>
                </div>
                {messages.map((m) => (
                  <div key={m.seq} style={S.msg}>
                    {m.human && <span style={S.human}>👤 人类</span>}
                    <span style={S.meta}>{m.fromNickname} {fmtTime(m.ts)}</span>
                    <span>{m.text}</span>
                  </div>
                ))}
                {messages.length === 0 && <div style={{ opacity: 0.5, padding: 6 }}>还没有消息</div>}
              </div>
              <div style={{ ...S.row, paddingBottom: 8 }}>
                <input
                  style={S.input}
                  value={text}
                  placeholder={takeover ? "以人类身份发言…" : "以本 agent 身份发言…"}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (takeover ? sendHumanMessage() : sendChat())}
                />
                <button
                  style={activeRoom.autoReply ? { ...S.button, background: "#e5484d" } : S.buttonGhost}
                  title={activeRoom.autoReply ? "当前自动回复中，点击停止" : "开启后收到对方消息自动回复"}
                  onClick={() => {
                    const next = !activeRoom.autoReply;
                    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/auto-reply`, { on: next }).then(() =>
                      window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300),
                    );
                  }}
                >{activeRoom.autoReply ? "停止回复" : "自动回复"}</button>
                <button style={S.buttonGhost} onClick={() => setTakeover((v) => !v)} title="接管本机 agent 席位">
                  {takeover ? "释放接管" : "人类接管"}
                </button>
                <button style={S.button} onClick={takeover ? sendHumanMessage : sendChat}>发送</button>
              </div>
            </>
          )}

          {tab === "tasks" && (
            <>
              <div style={{ ...S.list, paddingBottom: 8 }}>
                {activeRoom.tasks.map((task) => (
                  <div key={task.taskId} style={S.task}>
                    <div>
                      <span style={{ fontWeight: 600 }}>{task.title}</span>
                      <span style={S.badge(task.status)}>{task.status}</span>
                      <span style={{ opacity: 0.6, fontSize: 11, marginLeft: 6 }}>
                        {task.judge?.mode === "auto" ? "自治" : "控制人判定"} · {task.assignee ? `执行: ${task.assignee}` : task.claimable ? "可认领" : "未指派"}
                      </span>
                    </div>
                    {task.description && <div style={{ opacity: 0.75, marginTop: 2 }}>{task.description}</div>}
                    {(task.requiredRoles?.length ?? 0) > 0 && (
                      <div style={{ marginTop: 2, fontSize: 11, opacity: 0.7 }}>
                        所需角色:{task.requiredRoles!.map((r) => <span key={r} style={{ ...S.badge(r), marginRight: 4 }}>{ROLE_ZH[r] ?? r}</span>)}
                      </div>
                    )}
                    {task.acceptance && (
                      <div style={{ marginTop: 2, fontSize: 11, opacity: 0.8 }}>
                        <span style={{ fontWeight: 600 }}>验收标准:</span> {task.acceptance}
                      </div>
                    )}
                    {task.handoff && (
                      <div style={{ marginTop: 4, fontSize: 11, background: "rgba(74,125,255,.08)", borderRadius: 6, padding: "4px 8px" }}>
                        <div><b>已完成:</b> {task.handoff.done}</div>
                        {task.handoff.basis && <div><b>依据:</b> {task.handoff.basis}</div>}
                        <div><b>下一步:</b> {task.handoff.next}</div>
                        {task.handoff.risk && <div><b>风险:</b> {task.handoff.risk}</div>}
                      </div>
                    )}
                    <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {task.status === "todo" && task.claimable && (
                        <button style={S.buttonGhost} onClick={() => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${task.taskId}/claim`)}>认领</button>
                      )}
                      {(task.status === "todo" || task.status === "doing") && (
                        <button style={S.buttonGhost} onClick={() => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${task.taskId}/complete`)}>提交完成</button>
                      )}
                      {task.status === "review" && localAgentId === activeRoom.controllerAgentId && (
                        <>
                          <button style={S.button} onClick={() => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${task.taskId}/approve`)}>批准</button>
                          <button style={S.buttonGhost} onClick={() => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${task.taskId}/reject`, { note: window.prompt("驳回原因:") ?? "" })}>驳回</button>
                        </>
                      )}
                      {(task.status === "done" || task.status === "rejected") && (
                        <button style={S.buttonGhost} onClick={() => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${task.taskId}/reopen`)}>重开</button>
                      )}
                      <button
                        style={confirmDeleteTask === task.taskId ? { ...S.button, background: "#e5484d" } : { ...S.buttonGhost, color: "#e5484d", borderColor: "rgba(229,72,77,.5)" }}
                        onClick={() => (confirmDeleteTask === task.taskId ? doDeleteTask(task.taskId) : armDeleteTask(task.taskId))}
                        title="删除任务"
                      >{confirmDeleteTask === task.taskId ? "确认删除?" : "删除"}</button>
                    </div>
                  </div>
                ))}
                {activeRoom.tasks.length === 0 && <div style={{ opacity: 0.5, padding: 6 }}>还没有任务</div>}
              </div>
              <div style={{ ...S.row, paddingBottom: 8 }}>
                <button style={S.button} onClick={createTask}>+ 新建任务</button>
              </div>
            </>
          )}

          {tab === "members" && (
            <div style={{ ...S.list, padding: "0 10px 8px" }}>
              {activeRoom.members.map((m) => (
                <div key={m.agentId} style={S.row}>
                  <span>{m.role === "owner" ? "👑" : "🤖"}</span>
                  <span style={{ flex: 1 }}>{m.nickname} {m.agentId === activeRoom.controllerAgentId && <span style={{ opacity: 0.6, fontSize: 11 }}>(判定人)</span>}</span>
                  {(m.roles ?? []).map((r) => <span key={r} style={{ ...S.badge(r), marginRight: 2 }}>{ROLE_ZH[r] ?? r}</span>)}
                  {(m.manualCapabilities ?? []).map((c) => <span key={c} style={{ ...S.badge(c), background: "#2e9e44", marginRight: 2 }}>{c}</span>)}
                  <span style={{ opacity: 0.55, fontSize: 11, fontFamily: "monospace" }}>{m.agentId.slice(0, 8)}</span>
                  {activeRoom.owned && m.agentId !== localAgentId && (
                    <select
                      style={{ ...S.select, width: "auto", padding: "2px 4px", fontSize: 11 }}
                      value={m.roles?.[0] ?? "observer"}
                      onChange={(e) => assignRole(m, e.target.value)}
                      title="安排岗位"
                    >
                      {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_ZH[r] ?? r}</option>)}
                    </select>
                  )}
                  {m.agentId === localAgentId && activeRoom.allowHumanTakeover && (
                    <button style={S.buttonGhost} onClick={() => setTakeover((v) => !v)}>{takeover ? "释放接管" : "接管"}</button>
                  )}
                  {activeRoom.owned && m.agentId !== localAgentId && m.role !== "owner" && (
                    <>
                      <button
                        style={confirmRevokeAgent === m.agentId ? { ...S.button, background: "#e5484d" } : { ...S.buttonGhost, color: "#e5484d", borderColor: "rgba(229,72,77,.5)" }}
                        onClick={() => (confirmRevokeAgent === m.agentId ? doRevokeMember(m) : armRevoke(m.agentId))}
                        title="吊销入场资格：踢出且禁止再加入，直到解除吊销"
                      >{confirmRevokeAgent === m.agentId ? "确认吊销?" : "吊销"}</button>
                      <button
                        style={confirmKickAgent === m.agentId ? { ...S.button, background: "#e5484d" } : { ...S.buttonGhost, color: "#e5484d", borderColor: "rgba(229,72,77,.5)" }}
                        onClick={() => (confirmKickAgent === m.agentId ? doKickMember(m) : armKick(m.agentId))}
                        title="踢出（可重新加入）"
                      >{confirmKickAgent === m.agentId ? "确认踢出?" : "踢出"}</button>
                    </>
                  )}
                </div>
              ))}
              {(activeRoom.revoked?.length ?? 0) > 0 && (
                <div style={{ borderTop: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))", marginTop: 6, paddingTop: 6 }}>
                  <div style={{ ...S.row, opacity: 0.7, fontSize: 11, fontWeight: 600 }}>🚫 已吊销名单</div>
                  {activeRoom.revoked!.map((r) => (
                    <div key={r.agentId} style={S.row}>
                      <span>🚫</span>
                      <span style={{ flex: 1 }}>
                        {r.nickname ?? r.agentId.slice(0, 8)}
                        {r.reason && <span style={{ opacity: 0.6, fontSize: 11 }}>（{r.reason}）</span>}
                      </span>
                      <span style={{ opacity: 0.55, fontSize: 11, fontFamily: "monospace" }}>{r.agentId.slice(0, 8)}</span>
                      {activeRoom.owned && (
                        <button
                          style={confirmUnrevokeAgent === r.agentId ? { ...S.button, background: "#2e9e44" } : S.buttonGhost}
                          onClick={() => (confirmUnrevokeAgent === r.agentId ? doUnrevokeMember(r.agentId) : armUnrevoke(r.agentId))}
                          title="解除吊销（恢复入场资格）"
                        >{confirmUnrevokeAgent === r.agentId ? "确认解除?" : "解除吊销"}</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ ...S.row, borderTop: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))", marginTop: 6, paddingTop: 6 }}>
                <span style={{ opacity: 0.7, fontSize: 11 }}>我的岗位:</span>
                <select
                  style={{ ...S.select, width: "auto", padding: "2px 4px", fontSize: 11 }}
                  value={(activeRoom.members.find((m) => m.agentId === localAgentId)?.roles ?? ["observer"])[0] ?? "observer"}
                  onChange={(e) => setMyRole(e.target.value)}
                  title={activeRoom.owned ? "设置自己的岗位" : "申请岗位（由房主确认）"}
                >
                  {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_ZH[r] ?? r}</option>)}
                </select>
              </div>
              <div style={{ ...S.row, borderTop: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))", marginTop: 4, paddingTop: 6 }}>
                <span style={{ opacity: 0.7, fontSize: 11 }}>我的能力标签:</span>
                <input
                  id="ar-caps"
                  style={S.input}
                  placeholder="如: 前端, 后端, 财务"
                  defaultValue={(activeRoom.members.find((m) => m.agentId === localAgentId)?.manualCapabilities ?? []).join(", ")}
                />
                <button style={S.buttonGhost} onClick={saveMyCaps}>保存</button>
              </div>
              {!activeRoom.owned && (
                <div style={{ ...S.row, borderTop: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))", marginTop: 4, paddingTop: 6 }}>
                  <span style={{ flex: 1, opacity: 0.8 }}>退出此房间</span>
                  <button
                    style={confirmLeaveRoom === activeRoom.roomId ? { ...S.button, background: "#e5484d" } : S.buttonGhost}
                    onClick={confirmLeaveRoom === activeRoom.roomId ? doLeaveRoom : () => armConfirm("leave", activeRoom.roomId)}
                  >{confirmLeaveRoom === activeRoom.roomId ? "⚠ 再点一次确认退出" : "退出"}</button>
                </div>
              )}
            </div>
          )}

          {tab === "settings" && activeRoom.owned && (
            <div style={{ ...S.list, padding: "0 10px 8px" }}>
              <div style={S.row}>
                <span>准入模式</span>
                <select
                  style={S.select}
                  value={activeRoom.authMode}
                  onChange={(e) => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/settings`, { authMode: e.target.value })}
                >
                  <option value="open">公开</option>
                  <option value="password">密码</option>
                </select>
              </div>
              {activeRoom.authMode === "password" && (
                <div style={S.row}>
                  <input style={S.input} placeholder="新密码" id="ar-password" />
                  <button style={S.buttonGhost} onClick={() => {
                    const el = document.getElementById("ar-password") as HTMLInputElement | null;
                    if (el?.value) void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/settings`, { password: el.value });
                  }}>设置密码</button>
                </div>
              )}
              <div style={S.row}>
                <span>自治模式（agent 自决完成）</span>
                <input
                  type="checkbox"
                  checked={activeRoom.autoMode}
                  onChange={(e) => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/settings`, { autoMode: e.target.checked })}
                />
              </div>
              <div style={S.row}>
                <span>分享地址：</span>
                <code style={{ opacity: 0.8 }}>{activeRoom.serverAddress ?? "（尚未启动房间服务器）"}</code>
              </div>
              {activeRoom.owned && (state?.node?.addresses?.length ?? 0) > 0 && (
                <div style={{ ...S.row, flexWrap: "wrap", gap: 4 }}>
                  <span>其他可用地址：</span>
                  {state!.node!.addresses!.map((a) => (
                    <code key={a} style={{ opacity: 0.8, marginRight: 6 }}>{a}</code>
                  ))}
                </div>
              )}
              <div style={{ ...S.row, borderTop: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))", marginTop: 6, paddingTop: 6 }}>
                <span style={{ flex: 1, color: "#e5484d" }}>删除房间（记录一并删除，不可恢复）</span>
                <button
                  style={confirmDelete
                    ? { ...S.button, background: "#e5484d" }
                    : { ...S.buttonGhost, color: "#e5484d", borderColor: "rgba(229,72,77,.5)" }}
                  onClick={confirmDelete ? doDeleteRoom : () => armConfirm("delete")}
                >{confirmDelete ? "⚠ 再点一次确认删除" : "删除"}</button>
              </div>
            </div>
          )}
        </>
      )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- registration ---------------------------- */

const NS = "agent-room";

const zh = {
  title: "Agent 房间",
};

const en = {
  title: "Agent Rooms",
};

function apply(ctx: {
  locale: { register(namespace: string, dicts: Record<string, unknown>): unknown };
  slots: {
    inject(target: string, register: () => unknown): unknown;
    register(definition: { name: string; id: string; order: number; locale: string; inject: () => Record<string, unknown> }, component: typeof RoomDock): unknown;
  };
  effect(fn: () => unknown, label?: string): unknown;
}): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "agent-room: dictionaries");
  ctx.effect(
    () =>
      ctx.slots.inject("conversation.session.header.utilities", () =>
        ctx.slots.register(
          {
            name: "conversation.session.header.utilities",
            id: "agent-room-dock-top",
            order: 450,
            locale: NS,
            inject: () => ({}),
          },
          RoomDock,
        ),
      ),
    "agent-room: dock",
  );
}

const inject = ["slots", "locale"] as const;

// The build wraps this module in `window.__ModuleLoader__.load({ id, factory })`
// (see build.mjs); the loader calls the factory with its own `require`, and
// this module's CommonJS exports ({ apply, inject }) become the plugin object.

export { apply, inject };
