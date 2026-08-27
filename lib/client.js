window.__ModuleLoader__.load({
  id: "dsh-agent-room",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
/**
 * dsh-agent-room — web client module.
 *
 * Registers a hover tab in the conversation session header (top of the page):
 * the room panel slides out below the tab while the mouse is over it and
 * retracts when the mouse leaves. Data flows through the host browser API
 * (/agent-room-api/*) with light polling; no direct LAN connections from the
 * browser in v0.1.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const React = __importStar(require("react"));
/* ----------------------------- api helpers ----------------------------- */
async function api(path, body) {
    const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json());
    if (!json.ok || !response.ok)
        throw new Error(json.error ?? `HTTP ${response.status}`);
    return json.data;
}
const stateApi = () => api("/agent-room-api/state");
const messagesApi = (roomId, before) => api(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/messages${before !== undefined ? `?before=${before}` : ""}`);
/* ----------------------------- styles ---------------------------------- */
const S = {
    topTabWrap: {
        position: "relative",
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
        whiteSpace: "nowrap",
        userSelect: "none",
        boxShadow: "0 2px 8px rgba(74,125,255,.25)",
    },
    dropdown: {
        position: "absolute",
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
    },
    dropdownClosed: {
        maxHeight: 0,
        opacity: 0,
        transform: "translateY(-6px)",
        pointerEvents: "none",
    },
    dropdownOpen: {
        maxHeight: "72vh",
        opacity: 1,
        transform: "translateY(0)",
    },
    panelScroll: {
        overflowY: "auto",
        maxHeight: "calc(72vh - 8px)",
        display: "flex",
        flexDirection: "column",
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
    list: { overflowY: "auto", flex: 1, minHeight: 60 },
    msg: { padding: "2px 0", lineHeight: 1.35 },
    meta: { opacity: 0.6, marginRight: 6, fontSize: 12 },
    human: { background: "#fff3bf", color: "#5c4a00", borderRadius: 4, padding: "0 4px", marginRight: 6, fontSize: 11 },
    task: { padding: "6px 10px", borderBottom: "1px solid var(--dsh-border-color, rgba(128,128,128,.15))" },
    badge: (text) => ({
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
function badgeColor(status) {
    switch (status) {
        case "todo": return "#888";
        case "doing": return "#4a7dff";
        case "review": return "#b26a00";
        case "done": return "#2e9e44";
        case "rejected": return "#e5484d";
        default: return "#888";
    }
}
function fmtTime(iso) {
    try {
        return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    catch {
        return iso;
    }
}
const ROLE_ZH = {
    observer: "观察者",
    controller: "总控",
    researcher: "资料",
    executor: "执行",
    reviewer: "复核",
};
const ALL_ROLES = ["observer", "controller", "researcher", "executor", "reviewer"];
/* ----------------------------- dock component -------------------------- */
function RoomDock() {
    const [state, setState] = React.useState(null);
    const [activeRoomId, setActiveRoomId] = React.useState(null);
    const [tab, setTab] = React.useState("chat");
    const [messages, setMessages] = React.useState([]);
    const [takeover, setTakeover] = React.useState(false);
    const [text, setText] = React.useState("");
    const [error, setError] = React.useState(null);
    const [creating, setCreating] = React.useState(false);
    const [joining, setJoining] = React.useState(false);
    const [open, setOpen] = React.useState(false);
    const [confirmDelete, setConfirmDelete] = React.useState(false);
    const [confirmKickAgent, setConfirmKickAgent] = React.useState(null);
    const [confirmLeaveRoom, setConfirmLeaveRoom] = React.useState(null);
    const [confirmDeleteTask, setConfirmDeleteTask] = React.useState(null);
    const [confirmRevokeAgent, setConfirmRevokeAgent] = React.useState(null);
    const [confirmUnrevokeAgent, setConfirmUnrevokeAgent] = React.useState(null);
    const chatScrollRef = React.useRef(null);
    const openTimer = React.useRef(null);
    const closeTimer = React.useRef(null);
    const confirmTimer = React.useRef(null);
    const resetConfirms = () => {
        setConfirmDelete(false);
        setConfirmKickAgent(null);
        setConfirmLeaveRoom(null);
        setConfirmDeleteTask(null);
        setConfirmRevokeAgent(null);
        setConfirmUnrevokeAgent(null);
    };
    /** Two-step inline confirm (browser dialogs can be blocked, so no window.confirm). */
    const armConfirm = (kind, roomId) => {
        setConfirmDelete(kind === "delete");
        setConfirmKickAgent(null);
        setConfirmLeaveRoom(kind === "leave" ? roomId ?? null : null);
        if (confirmTimer.current !== null)
            window.clearTimeout(confirmTimer.current);
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
        if (openTimer.current === null)
            openTimer.current = window.setTimeout(() => { openTimer.current = null; setOpen(true); }, 120);
    };
    const scheduleClose = () => {
        if (openTimer.current !== null) {
            window.clearTimeout(openTimer.current);
            openTimer.current = null;
        }
        if (closeTimer.current === null)
            closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setOpen(false); }, 220);
    };
    React.useEffect(() => () => {
        if (openTimer.current !== null)
            window.clearTimeout(openTimer.current);
        if (closeTimer.current !== null)
            window.clearTimeout(closeTimer.current);
        if (confirmTimer.current !== null)
            window.clearTimeout(confirmTimer.current);
    }, []);
    // Tech-feel styling: transitions, hover lift, glow — injected once.
    React.useEffect(() => {
        if (document.getElementById("ar-style"))
            return;
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
                if (!alive)
                    return;
                setState(s);
                setError(null);
            })
                .catch((err) => alive && setError(err.message));
        };
        tick();
        const timer = setInterval(tick, 2500);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, []);
    React.useEffect(() => {
        if (!activeRoomId)
            return;
        let alive = true;
        const tick = () => {
            messagesApi(activeRoomId)
                .then((d) => alive && setMessages(d.messages))
                .catch(() => { });
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
        if (el)
            el.scrollTop = el.scrollHeight;
    }, [messages, tab]);
    const loadOlder = () => {
        if (!activeRoomId)
            return;
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
            .catch(() => { });
    };
    const activeRoom = state?.rooms.find((r) => r.roomId === activeRoomId) ?? null;
    const localAgentId = state?.identity.agentId;
    /** Always sends POST (empty body when none given) — GET would 404 the action routes. */
    const post = async (path, body) => {
        try {
            await api(path, body ?? {});
            setError(null);
        }
        catch (err) {
            setError(err.message);
        }
    };
    const refreshState = (thenSelectRoomId) => {
        window.setTimeout(() => {
            stateApi()
                .then((s) => {
                setState(s);
                if (thenSelectRoomId)
                    setActiveRoomId(thenSelectRoomId);
            })
                .catch(() => { });
        }, 400);
    };
    const createRoom = () => {
        const title = window.prompt("房间标题:");
        if (!title)
            return;
        const type = window.confirm("临时房间？（确定=临时，取消=长期持久）") ? "temporary" : "persistent";
        void post("/agent-room-api/rooms", { title, type }).then(() => refreshState());
    };
    const joinRoom = () => {
        const address = window.prompt("房主分享的地址 (host:port):");
        if (!address)
            return;
        const password = window.prompt("密码（无则留空）:", "") ?? undefined;
        void api("/agent-room-api/join", { address, password: password || undefined })
            .then((d) => refreshState(d.roomId))
            .catch((err) => setError(err.message));
    };
    const joinDiscovered = (room) => {
        const password = room.authMode === "password" ? (window.prompt(`房间「${room.title}」需要密码:`) ?? undefined) : undefined;
        void api("/agent-room-api/join", { addresses: room.addresses, roomId: room.roomId, password })
            .then((d) => refreshState(d.roomId))
            .catch((err) => setError(err.message));
    };
    const sendChat = () => {
        if (!activeRoom || !text.trim())
            return;
        const roomId = activeRoom.roomId;
        void post(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/chat`, { text, human: takeover }).then(() => {
            setText("");
            // Immediate refresh so the sender sees their own message at once.
            messagesApi(roomId).then((d) => setMessages(d.messages)).catch(() => { });
        });
    };
    const sendHumanMessage = () => {
        if (!activeRoom || !text.trim())
            return;
        const roomId = activeRoom.roomId;
        void post(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/chat`, { text, human: true }).then(() => {
            setText("");
            messagesApi(roomId).then((d) => setMessages(d.messages)).catch(() => { });
        });
    };
    const createTask = () => {
        if (!activeRoom)
            return;
        const title = window.prompt("任务标题:");
        if (!title)
            return;
        const judgeMode = window.confirm("自治模式（agent 自决完成）？确定=auto，取消=controller") ? "auto" : "controller";
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks`, { title, judgeMode, claimable: true });
    };
    /** Two-step inline confirm (browser dialogs can be blocked, so no window.confirm). */
    const doDeleteRoom = () => {
        if (!activeRoom)
            return;
        setConfirmDelete(false);
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/delete`).then(() => {
            setActiveRoomId(null);
            window.setTimeout(() => stateApi().then(setState).catch(() => { }), 400);
        });
    };
    const doLeaveRoom = () => {
        const roomId = confirmLeaveRoom ?? activeRoom?.roomId;
        if (!roomId)
            return;
        setConfirmLeaveRoom(null);
        void post(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/leave`).then(() => {
            if (activeRoomId === roomId)
                setActiveRoomId(null);
            window.setTimeout(() => stateApi().then(setState).catch(() => { }), 400);
        });
    };
    const armKick = (agentId) => {
        setConfirmDelete(false);
        setConfirmLeaveRoom(null);
        setConfirmKickAgent(agentId);
        if (confirmTimer.current !== null)
            window.clearTimeout(confirmTimer.current);
        confirmTimer.current = window.setTimeout(() => {
            confirmTimer.current = null;
            resetConfirms();
        }, 3500);
    };
    const doKickMember = (member) => {
        if (!activeRoom)
            return;
        setConfirmKickAgent(null);
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(member.agentId)}/kick`).then(() => window.setTimeout(() => stateApi().then(setState).catch(() => { }), 400));
    };
    const armRevoke = (agentId) => {
        setConfirmDelete(false);
        setConfirmLeaveRoom(null);
        setConfirmKickAgent(null);
        setConfirmDeleteTask(null);
        setConfirmUnrevokeAgent(null);
        setConfirmRevokeAgent(agentId);
        if (confirmTimer.current !== null)
            window.clearTimeout(confirmTimer.current);
        confirmTimer.current = window.setTimeout(() => {
            confirmTimer.current = null;
            resetConfirms();
        }, 3500);
    };
    const doRevokeMember = (member) => {
        if (!activeRoom)
            return;
        setConfirmRevokeAgent(null);
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(member.agentId)}/revoke`).then(() => window.setTimeout(() => stateApi().then(setState).catch(() => { }), 400));
    };
    const armUnrevoke = (agentId) => {
        setConfirmDelete(false);
        setConfirmLeaveRoom(null);
        setConfirmKickAgent(null);
        setConfirmDeleteTask(null);
        setConfirmRevokeAgent(null);
        setConfirmUnrevokeAgent(agentId);
        if (confirmTimer.current !== null)
            window.clearTimeout(confirmTimer.current);
        confirmTimer.current = window.setTimeout(() => {
            confirmTimer.current = null;
            resetConfirms();
        }, 3500);
    };
    const doUnrevokeMember = (agentId) => {
        if (!activeRoom)
            return;
        setConfirmUnrevokeAgent(null);
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(agentId)}/unrevoke`).then(() => window.setTimeout(() => stateApi().then(setState).catch(() => { }), 400));
    };
    const armDeleteTask = (taskId) => {
        setConfirmDeleteTask(taskId);
        if (confirmTimer.current !== null)
            window.clearTimeout(confirmTimer.current);
        confirmTimer.current = window.setTimeout(() => {
            confirmTimer.current = null;
            resetConfirms();
        }, 3500);
    };
    const doDeleteTask = (taskId) => {
        if (!activeRoom)
            return;
        setConfirmDeleteTask(null);
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${encodeURIComponent(taskId)}/remove`).then(() => window.setTimeout(() => stateApi().then(setState).catch(() => { }), 300));
    };
    const assignRole = (member, role) => {
        if (!activeRoom)
            return;
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(member.agentId)}/roles`, { roles: [role] }).then(() => window.setTimeout(() => stateApi().then(setState).catch(() => { }), 300));
    };
    const setMyRole = (role) => {
        if (!activeRoom)
            return;
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/member-roles`, { roles: [role] }).then(() => window.setTimeout(() => stateApi().then(setState).catch(() => { }), 300));
    };
    const saveMyCaps = () => {
        if (!activeRoom)
            return;
        const el = document.getElementById("ar-caps");
        const tags = (el?.value ?? "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/member-capabilities`, { capabilities: tags }).then(() => {
            if (el)
                el.value = "";
            window.setTimeout(() => stateApi().then(setState).catch(() => { }), 300);
        });
    };
    return (React.createElement("div", { style: S.topTabWrap, onMouseEnter: scheduleOpen, onMouseLeave: scheduleClose },
        React.createElement("div", { className: "ar-tab", style: S.topTab, role: "button", title: "Agent \u623F\u95F4\uFF08\u60AC\u505C\u5C55\u5F00\uFF09" },
            React.createElement("span", null, "\uD83E\uDD16"),
            React.createElement("span", null,
                "Agent \u623F\u95F4",
                state ? ` · ${state.rooms.length}` : "")),
        React.createElement("div", { className: "ar-panel", style: open ? { ...S.dropdown, ...S.dropdownOpen } : { ...S.dropdown, ...S.dropdownClosed } },
            React.createElement("div", { style: S.panelScroll },
                React.createElement("div", { style: S.header },
                    React.createElement("span", null, "\uD83E\uDD16 Agent \u623F\u95F4"),
                    React.createElement("span", { style: { opacity: 0.6, fontSize: 12, fontWeight: 400 } }, state ? `${state.identity.nickname} · ${state.rooms.length} 个房间` : "…"),
                    React.createElement("span", { style: { flex: 1 } }),
                    React.createElement("button", { style: S.buttonGhost, onClick: () => setCreating((v) => !v) }, "\u65B0\u5EFA"),
                    React.createElement("button", { style: S.buttonGhost, onClick: () => setJoining((v) => !v) }, "\u52A0\u5165")),
                error && React.createElement("div", { style: S.err },
                    "\u26A0 ",
                    error),
                takeover && React.createElement("div", { style: S.banner }, "\uD83D\uDC64 \u4EBA\u7C7B\u63A5\u7BA1\u6A21\u5F0F\uFF1A\u4F60\u7684\u6D88\u606F\u5C06\u4EE5\u4EBA\u7C7B\u8EAB\u4EFD\u53D1\u9001"),
                React.createElement("div", { style: { maxHeight: 200, overflowY: "auto", borderBottom: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))" } },
                    state?.rooms.map((room) => (React.createElement("div", { key: room.roomId, style: { ...S.row, background: room.roomId === activeRoomId ? "rgba(74,125,255,.12)" : undefined, cursor: "pointer" }, onClick: () => setActiveRoomId(room.roomId) },
                        React.createElement("span", null, room.type === "temporary" ? "⚡" : "📁"),
                        React.createElement("span", { style: { flex: 1 } }, room.title),
                        React.createElement("span", { style: { opacity: 0.6, fontSize: 11 } },
                            room.owned ? "我创建" : "加入",
                            " \u00B7 ",
                            room.memberCount,
                            "\u4EBA \u00B7 ",
                            room.authMode),
                        React.createElement("span", { style: S.badge(room.status) }, room.status),
                        room.owned && room.serverAddress && (React.createElement("span", { style: { opacity: 0.55, fontSize: 11, fontFamily: "monospace" } }, room.serverAddress)),
                        !room.owned && (React.createElement("button", { style: confirmLeaveRoom === room.roomId ? { ...S.button, background: "#e5484d", padding: "1px 6px" } : { ...S.buttonGhost, padding: "1px 6px", fontSize: 11 }, title: "\u9000\u51FA\u8BE5\u623F\u95F4", onClick: (e) => {
                                e.stopPropagation();
                                if (confirmLeaveRoom === room.roomId)
                                    doLeaveRoom();
                                else
                                    armConfirm("leave", room.roomId);
                            } }, confirmLeaveRoom === room.roomId ? "确认退出?" : "退出"))))),
                    (state?.rooms.length ?? 0) === 0 && React.createElement("div", { style: { ...S.row, opacity: 0.55 } }, "\u8FD8\u6CA1\u6709\u623F\u95F4 \u2014\u2014 \u65B0\u5EFA\u4E00\u4E2A\u6216\u52A0\u5165\u5C40\u57DF\u7F51\u623F\u95F4")),
                (state?.discovered?.length ?? 0) > 0 && (React.createElement("div", { style: { borderBottom: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))" } },
                    React.createElement("div", { style: { ...S.row, opacity: 0.6, fontSize: 11, fontWeight: 600 } }, "\uD83D\uDCE1 \u5C40\u57DF\u7F51\u53D1\u73B0\uFF08\u70B9\u51FB\u76F4\u63A5\u52A0\u5165\uFF09"),
                    state.discovered.map((room) => {
                        const joined = (state?.rooms ?? []).some((r) => r.roomId === room.roomId);
                        return (React.createElement("div", { key: `${room.addresses[0]}/${room.roomId}`, style: { ...S.row, cursor: "pointer", opacity: joined ? 0.75 : 1 }, onClick: () => { if (joined)
                                setActiveRoomId(room.roomId);
                            else
                                joinDiscovered(room); } },
                            React.createElement("span", null, joined ? "✅" : "🏠"),
                            React.createElement("span", { style: { flex: 1 } }, room.title),
                            React.createElement("span", { style: { opacity: 0.6, fontSize: 11 } },
                                room.nickname,
                                " \u00B7 ",
                                room.memberCount,
                                "\u4EBA \u00B7 ",
                                room.authMode === "password" ? "🔒密码" : "公开"),
                            joined ? (React.createElement("button", { style: { ...S.buttonGhost, opacity: 0.6 }, onClick: (e) => { e.stopPropagation(); setActiveRoomId(room.roomId); }, title: "\u5DF2\u52A0\u5165\uFF0C\u70B9\u51FB\u6253\u5F00" }, "\u5DF2\u52A0\u5165")) : (React.createElement("button", { style: S.buttonGhost, onClick: (e) => { e.stopPropagation(); joinDiscovered(room); } }, "\u52A0\u5165"))));
                    }))),
                creating && (React.createElement("div", { style: S.row },
                    React.createElement("input", { style: S.input, placeholder: "\u6807\u9898", id: "ar-create-title" }),
                    React.createElement("button", { style: S.button, onClick: createRoom }, "\u521B\u5EFA"))),
                joining && (React.createElement("div", { style: S.row },
                    React.createElement("input", { style: S.input, placeholder: "host:port", id: "ar-join-addr" }),
                    React.createElement("button", { style: S.button, onClick: joinRoom }, "\u52A0\u5165"))),
                activeRoom && (React.createElement(React.Fragment, null,
                    React.createElement("div", { style: S.row }, ["chat", "tasks", "members", "settings"].map((t) => (React.createElement("button", { key: t, style: tab === t ? { ...S.tab, ...S.tabActive } : S.tab, onClick: () => setTab(t) }, t === "chat" ? "聊天" : t === "tasks" ? "任务" : t === "members" ? "成员" : "设置")))),
                    tab === "chat" && (React.createElement(React.Fragment, null,
                        React.createElement("div", { ref: chatScrollRef, style: { ...S.list, padding: "0 10px", maxHeight: "42vh", overflowY: "auto" } },
                            React.createElement("div", { style: { textAlign: "center", padding: "2px 0" } },
                                React.createElement("button", { style: { ...S.buttonGhost, fontSize: 11 }, onClick: loadOlder }, "\u2191 \u52A0\u8F7D\u66F4\u65E9\u6D88\u606F")),
                            messages.map((m) => (React.createElement("div", { key: m.seq, style: S.msg },
                                m.human && React.createElement("span", { style: S.human }, "\uD83D\uDC64 \u4EBA\u7C7B"),
                                React.createElement("span", { style: S.meta },
                                    m.fromNickname,
                                    " ",
                                    fmtTime(m.ts)),
                                React.createElement("span", null, m.text)))),
                            messages.length === 0 && React.createElement("div", { style: { opacity: 0.5, padding: 6 } }, "\u8FD8\u6CA1\u6709\u6D88\u606F")),
                        React.createElement("div", { style: { ...S.row, paddingBottom: 8 } },
                            React.createElement("input", { style: S.input, value: text, placeholder: takeover ? "以人类身份发言…" : "以本 agent 身份发言…", onChange: (e) => setText(e.target.value), onKeyDown: (e) => e.key === "Enter" && (takeover ? sendHumanMessage() : sendChat()) }),
                            React.createElement("button", { style: activeRoom.autoReply ? { ...S.button, background: "#e5484d" } : S.buttonGhost, title: activeRoom.autoReply ? "当前自动回复中，点击停止" : "开启后收到对方消息自动回复", onClick: () => {
                                    const next = !activeRoom.autoReply;
                                    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/auto-reply`, { on: next }).then(() => window.setTimeout(() => stateApi().then(setState).catch(() => { }), 300));
                                } }, activeRoom.autoReply ? "停止回复" : "自动回复"),
                            React.createElement("button", { style: S.buttonGhost, onClick: () => setTakeover((v) => !v), title: "\u63A5\u7BA1\u672C\u673A agent \u5E2D\u4F4D" }, takeover ? "释放接管" : "人类接管"),
                            React.createElement("button", { style: S.button, onClick: takeover ? sendHumanMessage : sendChat }, "\u53D1\u9001")))),
                    tab === "tasks" && (React.createElement(React.Fragment, null,
                        React.createElement("div", { style: { ...S.list, paddingBottom: 8 } },
                            activeRoom.tasks.map((task) => (React.createElement("div", { key: task.taskId, style: S.task },
                                React.createElement("div", null,
                                    React.createElement("span", { style: { fontWeight: 600 } }, task.title),
                                    React.createElement("span", { style: S.badge(task.status) }, task.status),
                                    React.createElement("span", { style: { opacity: 0.6, fontSize: 11, marginLeft: 6 } },
                                        task.judge?.mode === "auto" ? "自治" : "控制人判定",
                                        " \u00B7 ",
                                        task.assignee ? `执行: ${task.assignee}` : task.claimable ? "可认领" : "未指派")),
                                task.description && React.createElement("div", { style: { opacity: 0.75, marginTop: 2 } }, task.description),
                                (task.requiredRoles?.length ?? 0) > 0 && (React.createElement("div", { style: { marginTop: 2, fontSize: 11, opacity: 0.7 } },
                                    "\u6240\u9700\u89D2\u8272:",
                                    task.requiredRoles.map((r) => React.createElement("span", { key: r, style: { ...S.badge(r), marginRight: 4 } }, ROLE_ZH[r] ?? r)))),
                                task.acceptance && (React.createElement("div", { style: { marginTop: 2, fontSize: 11, opacity: 0.8 } },
                                    React.createElement("span", { style: { fontWeight: 600 } }, "\u9A8C\u6536\u6807\u51C6:"),
                                    " ",
                                    task.acceptance)),
                                task.handoff && (React.createElement("div", { style: { marginTop: 4, fontSize: 11, background: "rgba(74,125,255,.08)", borderRadius: 6, padding: "4px 8px" } },
                                    React.createElement("div", null,
                                        React.createElement("b", null, "\u5DF2\u5B8C\u6210:"),
                                        " ",
                                        task.handoff.done),
                                    task.handoff.basis && React.createElement("div", null,
                                        React.createElement("b", null, "\u4F9D\u636E:"),
                                        " ",
                                        task.handoff.basis),
                                    React.createElement("div", null,
                                        React.createElement("b", null, "\u4E0B\u4E00\u6B65:"),
                                        " ",
                                        task.handoff.next),
                                    task.handoff.risk && React.createElement("div", null,
                                        React.createElement("b", null, "\u98CE\u9669:"),
                                        " ",
                                        task.handoff.risk))),
                                React.createElement("div", { style: { marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" } },
                                    task.status === "todo" && task.claimable && (React.createElement("button", { style: S.buttonGhost, onClick: () => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${task.taskId}/claim`) }, "\u8BA4\u9886")),
                                    (task.status === "todo" || task.status === "doing") && (React.createElement("button", { style: S.buttonGhost, onClick: () => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${task.taskId}/complete`) }, "\u63D0\u4EA4\u5B8C\u6210")),
                                    task.status === "review" && localAgentId === activeRoom.controllerAgentId && (React.createElement(React.Fragment, null,
                                        React.createElement("button", { style: S.button, onClick: () => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${task.taskId}/approve`) }, "\u6279\u51C6"),
                                        React.createElement("button", { style: S.buttonGhost, onClick: () => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${task.taskId}/reject`, { note: window.prompt("驳回原因:") ?? "" }) }, "\u9A73\u56DE"))),
                                    (task.status === "done" || task.status === "rejected") && (React.createElement("button", { style: S.buttonGhost, onClick: () => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${task.taskId}/reopen`) }, "\u91CD\u5F00")),
                                    React.createElement("button", { style: confirmDeleteTask === task.taskId ? { ...S.button, background: "#e5484d" } : { ...S.buttonGhost, color: "#e5484d", borderColor: "rgba(229,72,77,.5)" }, onClick: () => (confirmDeleteTask === task.taskId ? doDeleteTask(task.taskId) : armDeleteTask(task.taskId)), title: "\u5220\u9664\u4EFB\u52A1" }, confirmDeleteTask === task.taskId ? "确认删除?" : "删除"))))),
                            activeRoom.tasks.length === 0 && React.createElement("div", { style: { opacity: 0.5, padding: 6 } }, "\u8FD8\u6CA1\u6709\u4EFB\u52A1")),
                        React.createElement("div", { style: { ...S.row, paddingBottom: 8 } },
                            React.createElement("button", { style: S.button, onClick: createTask }, "+ \u65B0\u5EFA\u4EFB\u52A1")))),
                    tab === "members" && (React.createElement("div", { style: { ...S.list, padding: "0 10px 8px" } },
                        activeRoom.members.map((m) => (React.createElement("div", { key: m.agentId, style: S.row },
                            React.createElement("span", null, m.role === "owner" ? "👑" : "🤖"),
                            React.createElement("span", { style: { flex: 1 } },
                                m.nickname,
                                " ",
                                m.agentId === activeRoom.controllerAgentId && React.createElement("span", { style: { opacity: 0.6, fontSize: 11 } }, "(\u5224\u5B9A\u4EBA)")),
                            (m.roles ?? []).map((r) => React.createElement("span", { key: r, style: { ...S.badge(r), marginRight: 2 } }, ROLE_ZH[r] ?? r)),
                            (m.manualCapabilities ?? []).map((c) => React.createElement("span", { key: c, style: { ...S.badge(c), background: "#2e9e44", marginRight: 2 } }, c)),
                            React.createElement("span", { style: { opacity: 0.55, fontSize: 11, fontFamily: "monospace" } }, m.agentId.slice(0, 8)),
                            activeRoom.owned && m.agentId !== localAgentId && (React.createElement("select", { style: { ...S.select, width: "auto", padding: "2px 4px", fontSize: 11 }, value: m.roles?.[0] ?? "observer", onChange: (e) => assignRole(m, e.target.value), title: "\u5B89\u6392\u5C97\u4F4D" }, ALL_ROLES.map((r) => React.createElement("option", { key: r, value: r }, ROLE_ZH[r] ?? r)))),
                            m.agentId === localAgentId && activeRoom.allowHumanTakeover && (React.createElement("button", { style: S.buttonGhost, onClick: () => setTakeover((v) => !v) }, takeover ? "释放接管" : "接管")),
                            activeRoom.owned && m.agentId !== localAgentId && m.role !== "owner" && (React.createElement(React.Fragment, null,
                                React.createElement("button", { style: confirmRevokeAgent === m.agentId ? { ...S.button, background: "#e5484d" } : { ...S.buttonGhost, color: "#e5484d", borderColor: "rgba(229,72,77,.5)" }, onClick: () => (confirmRevokeAgent === m.agentId ? doRevokeMember(m) : armRevoke(m.agentId)), title: "\u540A\u9500\u5165\u573A\u8D44\u683C\uFF1A\u8E22\u51FA\u4E14\u7981\u6B62\u518D\u52A0\u5165\uFF0C\u76F4\u5230\u89E3\u9664\u540A\u9500" }, confirmRevokeAgent === m.agentId ? "确认吊销?" : "吊销"),
                                React.createElement("button", { style: confirmKickAgent === m.agentId ? { ...S.button, background: "#e5484d" } : { ...S.buttonGhost, color: "#e5484d", borderColor: "rgba(229,72,77,.5)" }, onClick: () => (confirmKickAgent === m.agentId ? doKickMember(m) : armKick(m.agentId)), title: "\u8E22\u51FA\uFF08\u53EF\u91CD\u65B0\u52A0\u5165\uFF09" }, confirmKickAgent === m.agentId ? "确认踢出?" : "踢出")))))),
                        (activeRoom.revoked?.length ?? 0) > 0 && (React.createElement("div", { style: { borderTop: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))", marginTop: 6, paddingTop: 6 } },
                            React.createElement("div", { style: { ...S.row, opacity: 0.7, fontSize: 11, fontWeight: 600 } }, "\uD83D\uDEAB \u5DF2\u540A\u9500\u540D\u5355"),
                            activeRoom.revoked.map((r) => (React.createElement("div", { key: r.agentId, style: S.row },
                                React.createElement("span", null, "\uD83D\uDEAB"),
                                React.createElement("span", { style: { flex: 1 } },
                                    r.nickname ?? r.agentId.slice(0, 8),
                                    r.reason && React.createElement("span", { style: { opacity: 0.6, fontSize: 11 } },
                                        "\uFF08",
                                        r.reason,
                                        "\uFF09")),
                                React.createElement("span", { style: { opacity: 0.55, fontSize: 11, fontFamily: "monospace" } }, r.agentId.slice(0, 8)),
                                activeRoom.owned && (React.createElement("button", { style: confirmUnrevokeAgent === r.agentId ? { ...S.button, background: "#2e9e44" } : S.buttonGhost, onClick: () => (confirmUnrevokeAgent === r.agentId ? doUnrevokeMember(r.agentId) : armUnrevoke(r.agentId)), title: "\u89E3\u9664\u540A\u9500\uFF08\u6062\u590D\u5165\u573A\u8D44\u683C\uFF09" }, confirmUnrevokeAgent === r.agentId ? "确认解除?" : "解除吊销"))))))),
                        React.createElement("div", { style: { ...S.row, borderTop: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))", marginTop: 6, paddingTop: 6 } },
                            React.createElement("span", { style: { opacity: 0.7, fontSize: 11 } }, "\u6211\u7684\u5C97\u4F4D:"),
                            React.createElement("select", { style: { ...S.select, width: "auto", padding: "2px 4px", fontSize: 11 }, value: (activeRoom.members.find((m) => m.agentId === localAgentId)?.roles ?? ["observer"])[0] ?? "observer", onChange: (e) => setMyRole(e.target.value), title: activeRoom.owned ? "设置自己的岗位" : "申请岗位（由房主确认）" }, ALL_ROLES.map((r) => React.createElement("option", { key: r, value: r }, ROLE_ZH[r] ?? r)))),
                        React.createElement("div", { style: { ...S.row, borderTop: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))", marginTop: 4, paddingTop: 6 } },
                            React.createElement("span", { style: { opacity: 0.7, fontSize: 11 } }, "\u6211\u7684\u80FD\u529B\u6807\u7B7E:"),
                            React.createElement("input", { id: "ar-caps", style: S.input, placeholder: "\u5982: \u524D\u7AEF, \u540E\u7AEF, \u8D22\u52A1", defaultValue: (activeRoom.members.find((m) => m.agentId === localAgentId)?.manualCapabilities ?? []).join(", ") }),
                            React.createElement("button", { style: S.buttonGhost, onClick: saveMyCaps }, "\u4FDD\u5B58")),
                        !activeRoom.owned && (React.createElement("div", { style: { ...S.row, borderTop: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))", marginTop: 4, paddingTop: 6 } },
                            React.createElement("span", { style: { flex: 1, opacity: 0.8 } }, "\u9000\u51FA\u6B64\u623F\u95F4"),
                            React.createElement("button", { style: confirmLeaveRoom === activeRoom.roomId ? { ...S.button, background: "#e5484d" } : S.buttonGhost, onClick: confirmLeaveRoom === activeRoom.roomId ? doLeaveRoom : () => armConfirm("leave", activeRoom.roomId) }, confirmLeaveRoom === activeRoom.roomId ? "⚠ 再点一次确认退出" : "退出"))))),
                    tab === "settings" && activeRoom.owned && (React.createElement("div", { style: { ...S.list, padding: "0 10px 8px" } },
                        React.createElement("div", { style: S.row },
                            React.createElement("span", null, "\u51C6\u5165\u6A21\u5F0F"),
                            React.createElement("select", { style: S.select, value: activeRoom.authMode, onChange: (e) => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/settings`, { authMode: e.target.value }) },
                                React.createElement("option", { value: "open" }, "\u516C\u5F00"),
                                React.createElement("option", { value: "password" }, "\u5BC6\u7801"))),
                        activeRoom.authMode === "password" && (React.createElement("div", { style: S.row },
                            React.createElement("input", { style: S.input, placeholder: "\u65B0\u5BC6\u7801", id: "ar-password" }),
                            React.createElement("button", { style: S.buttonGhost, onClick: () => {
                                    const el = document.getElementById("ar-password");
                                    if (el?.value)
                                        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/settings`, { password: el.value });
                                } }, "\u8BBE\u7F6E\u5BC6\u7801"))),
                        React.createElement("div", { style: S.row },
                            React.createElement("span", null, "\u81EA\u6CBB\u6A21\u5F0F\uFF08agent \u81EA\u51B3\u5B8C\u6210\uFF09"),
                            React.createElement("input", { type: "checkbox", checked: activeRoom.autoMode, onChange: (e) => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/settings`, { autoMode: e.target.checked }) })),
                        React.createElement("div", { style: S.row },
                            React.createElement("span", null, "\u5206\u4EAB\u5730\u5740\uFF1A"),
                            React.createElement("code", { style: { opacity: 0.8 } }, activeRoom.serverAddress ?? "（尚未启动房间服务器）")),
                        activeRoom.owned && (state?.node?.addresses?.length ?? 0) > 0 && (React.createElement("div", { style: { ...S.row, flexWrap: "wrap", gap: 4 } },
                            React.createElement("span", null, "\u5176\u4ED6\u53EF\u7528\u5730\u5740\uFF1A"),
                            state.node.addresses.map((a) => (React.createElement("code", { key: a, style: { opacity: 0.8, marginRight: 6 } }, a))))),
                        React.createElement("div", { style: { ...S.row, borderTop: "1px solid var(--dsh-border-color, rgba(128,128,128,.2))", marginTop: 6, paddingTop: 6 } },
                            React.createElement("span", { style: { flex: 1, color: "#e5484d" } }, "\u5220\u9664\u623F\u95F4\uFF08\u8BB0\u5F55\u4E00\u5E76\u5220\u9664\uFF0C\u4E0D\u53EF\u6062\u590D\uFF09"),
                            React.createElement("button", { style: confirmDelete
                                    ? { ...S.button, background: "#e5484d" }
                                    : { ...S.buttonGhost, color: "#e5484d", borderColor: "rgba(229,72,77,.5)" }, onClick: confirmDelete ? doDeleteRoom : () => armConfirm("delete") }, confirmDelete ? "⚠ 再点一次确认删除" : "删除"))))))))));
}
/* ----------------------------- registration ---------------------------- */
const NS = "agent-room";
const zh = {
    title: "Agent 房间",
};
const en = {
    title: "Agent Rooms",
};
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "agent-room: dictionaries");
    ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "agent-room-dock-top",
        order: 450,
        locale: NS,
        inject: () => ({}),
    }, RoomDock)), "agent-room: dock");
}
const inject = ["slots", "locale"];
exports.inject = inject;

    return module.exports;
  }
});
