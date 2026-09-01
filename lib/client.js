window.__ModuleLoader__.load({
  id: "dsh-agent-room",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
var __arModules = {};
function __arResolve(from, spec) {
  var parts = from.split('/'); parts.pop();
  for (var i = 0; i < spec.split('/').length; i++) {
    var seg = spec.split('/')[i];
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  var key = parts.join('/');
  key = key.replace(/.(js|ts|tsx)$/, '');
  return key;
}
function __arRequire(from, spec) {
  if (spec.charAt(0) !== '.') return require(spec);
  var key = __arResolve(from, spec);
  var mod = __arModules[key];
  if (!mod) throw new Error('dsh-agent-room: cannot resolve ' + spec + ' from ' + from);
  if (!mod.loaded) {
    mod.loaded = true; mod.exports = {};
    mod.factory(function (s) { return __arRequire(key, s); }, mod.exports, mod);
  }
  return mod.exports;
}
__arModules["index"] = { loaded: false, exports: {}, factory: function (require, exports, module) {
"use strict";
/**
 * dsh-agent-room — web client (dock).
 *
 * A hover/pin-expandable panel in the conversation session header. Data flows
 * through the host browser API (/agent-room-api/*); an SSE stream pushes room
 * events for real-time updates, with polling as the always-on fallback.
 *
 * This file only owns the dock shell + state; the four tabs and the room list
 * are separate components under ./components.
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
const api_1 = require("./api");
const theme_1 = require("./theme");
const common_1 = require("./components/common");
const RoomList_1 = require("./components/RoomList");
const Chat_1 = require("./components/Chat");
const TaskBoard_1 = require("./components/TaskBoard");
const Members_1 = require("./components/Members");
const Settings_1 = require("./components/Settings");
/* ----------------------------- dock component -------------------------- */
function RoomDock() {
    const [state, setState] = React.useState(null);
    const [activeRoomId, setActiveRoomId] = React.useState(null);
    const [tab, setTab] = React.useState("chat");
    const [messages, setMessages] = React.useState([]);
    const [hasOlder, setHasOlder] = React.useState(false);
    const [loadingOlder, setLoadingOlder] = React.useState(false);
    /** Optimistic activate-thinking flags per room (server state is the source of truth). */
    const [thinkingRooms, setThinkingRooms] = React.useState({});
    /** Persistent activate-chat error (survives state polls; cleared on next activate or dismiss). */
    const [activateError, setActivateError] = React.useState(null);
    const [text, setText] = React.useState("");
    const [error, setError] = React.useState(null);
    const [open, setOpen] = React.useState(false);
    const [pinned, setPinned] = React.useState(false);
    const [creating, setCreating] = React.useState(false);
    const [joining, setJoining] = React.useState(false);
    const [createTitle, setCreateTitle] = React.useState("");
    const [createType, setCreateType] = React.useState("persistent");
    const [joinAddr, setJoinAddr] = React.useState("");
    const [joinPassword, setJoinPassword] = React.useState("");
    /** roomId hint carried from the LAN-discovered list into the join panel. */
    const [joinRoomId, setJoinRoomId] = React.useState(null);
    const [unread, setUnread] = React.useState({});
    const [chatSearch, setChatSearch] = React.useState("");
    const [taskSearch, setTaskSearch] = React.useState("");
    const [taskFilter, setTaskFilter] = React.useState("all");
    const [taskSort, setTaskSort] = React.useState("updated");
    const [showCreate, setShowCreate] = React.useState(false);
    const [newTitle, setNewTitle] = React.useState("");
    const [newDesc, setNewDesc] = React.useState("");
    const [newAcceptance, setNewAcceptance] = React.useState("");
    const [newJudge, setNewJudge] = React.useState("controller");
    const [newClaimable, setNewClaimable] = React.useState(true);
    const [capsInput, setCapsInput] = React.useState("");
    const [relayInput, setRelayInput] = React.useState("");
    const [rejecting, setRejecting] = React.useState(null);
    const [rejectNotes, setRejectNotes] = React.useState({});
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
    const refreshTimer = React.useRef(null);
    /** Highest message seq already counted for unread purposes, per room. */
    const countedSeqRef = React.useRef({});
    /** Last known assignee per task (for task-assigned notifications). */
    const knownAssigneeRef = React.useRef({});
    const activeRoomIdRef = React.useRef(null);
    const tabRef = React.useRef(tab);
    const stateRef = React.useRef(null);
    const atBottomRef = React.useRef(true);
    const justSentRef = React.useRef(false);
    /** First successful state poll establishes the baseline (no unread for history). */
    const baselineRef = React.useRef(false);
    React.useEffect(() => { activeRoomIdRef.current = activeRoomId; }, [activeRoomId]);
    React.useEffect(() => { tabRef.current = tab; }, [tab]);
    React.useEffect(() => { stateRef.current = state; }, [state]);
    const resetConfirms = () => {
        setConfirmDelete(false);
        setConfirmKickAgent(null);
        setConfirmLeaveRoom(null);
        setConfirmDeleteTask(null);
        setConfirmRevokeAgent(null);
        setConfirmUnrevokeAgent(null);
    };
    /** Two-step inline confirm (no window.confirm — dialogs can be blocked). */
    const armConfirm = (kind, roomId) => {
        setConfirmDelete(kind === "delete");
        setConfirmKickAgent(null);
        setConfirmLeaveRoom(kind === "leave" ? roomId ?? null : null);
        if (confirmTimer.current !== null)
            window.clearTimeout(confirmTimer.current);
        confirmTimer.current = window.setTimeout(() => {
            confirmTimer.current = null;
            resetConfirms();
        }, 4000);
    };
    const scheduleOpen = () => {
        if (closeTimer.current !== null) {
            window.clearTimeout(closeTimer.current);
            closeTimer.current = null;
        }
        if (openTimer.current === null)
            openTimer.current = window.setTimeout(() => { openTimer.current = null; setOpen(true); }, 100);
    };
    const scheduleClose = () => {
        if (pinned)
            return;
        if (openTimer.current !== null) {
            window.clearTimeout(openTimer.current);
            openTimer.current = null;
        }
        if (closeTimer.current === null)
            closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setOpen(false); }, 260);
    };
    React.useEffect(() => () => {
        if (openTimer.current !== null)
            window.clearTimeout(openTimer.current);
        if (closeTimer.current !== null)
            window.clearTimeout(closeTimer.current);
        if (confirmTimer.current !== null)
            window.clearTimeout(confirmTimer.current);
        if (refreshTimer.current !== null)
            window.clearTimeout(refreshTimer.current);
    }, []);
    // Global tech theme injected once.
    React.useEffect(() => {
        if (document.getElementById("ar-theme-css"))
            return;
        const style = document.createElement("style");
        style.id = "ar-theme-css";
        style.textContent = theme_1.GLOBAL_CSS;
        document.head.appendChild(style);
    }, []);
    /* ----------------------------- data flow ------------------------------ */
    const refreshState = (thenSelectRoomId) => {
        if (refreshTimer.current !== null)
            window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
            refreshTimer.current = null;
            (0, api_1.stateApi)()
                .then((s) => {
                setState(s);
                setError(null);
                if (thenSelectRoomId) {
                    setActiveRoomId(thenSelectRoomId);
                    setTab("chat");
                }
            })
                .catch((err) => setError(err.message));
        }, 250);
    };
    // System notification (mention / task assignment).
    const notify = (title, body) => {
        try {
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                new Notification(title, { body, tag: "agent-room" });
            }
        }
        catch {
            /* notifications are best-effort */
        }
    };
    const requestNotifPermission = () => {
        try {
            if (typeof Notification !== "undefined" && Notification.permission === "default") {
                void Notification.requestPermission();
            }
        }
        catch {
            /* ignore */
        }
    };
    const mentionsMe = (message) => {
        const me = stateRef.current?.identity;
        if (!me)
            return false;
        if (Array.isArray(message.mentions) && message.mentions.includes(me.agentId))
            return true;
        return message.text.includes("@" + me.agentId) || message.text.includes("@" + me.nickname);
    };
    /** A pushed chat message arrived for some room. */
    const handlePushMessage = (roomId, message) => {
        const me = stateRef.current?.identity;
        if (me && message.from === me.agentId)
            return;
        const focused = roomId === activeRoomIdRef.current && tabRef.current === "chat";
        if (focused) {
            setMessages((prev) => (prev.some((m) => m.seq === message.seq) ? prev : [...prev, message]));
            countedSeqRef.current[roomId] = Math.max(countedSeqRef.current[roomId] ?? 0, message.seq);
        }
        if (mentionsMe(message) && !focused) {
            const title = stateRef.current?.rooms.find((r) => r.roomId === roomId)?.title ?? roomId;
            notify("📣 有人 @你", `「${title}」 ${message.fromNickname}: ${message.text.slice(0, 80)}`);
        }
    };
    // State poll (source of truth for rooms/tasks/unread deltas).
    React.useEffect(() => {
        let alive = true;
        const tick = () => {
            (0, api_1.stateApi)()
                .then((s) => {
                if (!alive)
                    return;
                setState(s);
                setError(null);
                const me = s.identity.agentId;
                setRelayInput((prev) => prev || (s.relay?.address ?? ""));
                // Unread: count new messages since the last counted seq.
                setUnread((prev) => {
                    const next = { ...prev };
                    for (const room of s.rooms) {
                        const latest = room.latestSeq ?? 0;
                        const counted = countedSeqRef.current[room.roomId] ?? 0;
                        if (latest <= counted)
                            continue;
                        if (!baselineRef.current) {
                            // Baseline: existing history is not "unread".
                            countedSeqRef.current[room.roomId] = latest;
                            continue;
                        }
                        countedSeqRef.current[room.roomId] = latest;
                        if (room.roomId === activeRoomIdRef.current && tabRef.current === "chat")
                            continue;
                        next[room.roomId] = (next[room.roomId] ?? 0) + Math.min(latest - counted, 50);
                    }
                    return next;
                });
                baselineRef.current = true;
                // Drop optimistic thinking flags once the server confirms the reply
                // landed (activateThinking back to false) — button becomes clickable.
                setThinkingRooms((prev) => {
                    if (Object.keys(prev).length === 0)
                        return prev;
                    const next = { ...prev };
                    for (const room of s.rooms) {
                        if (!room.activateThinking && next[room.roomId])
                            delete next[room.roomId];
                    }
                    return next;
                });
                // Task assignment notifications.
                for (const room of s.rooms) {
                    for (const task of room.tasks) {
                        const prevAssignee = knownAssigneeRef.current[task.taskId];
                        if (task.assignee && task.assignee === me && prevAssignee !== undefined && prevAssignee !== me) {
                            notify("📌 任务指派给你", `「${room.title}」: ${task.title}`);
                        }
                        knownAssigneeRef.current[task.taskId] = task.assignee;
                    }
                }
            })
                .catch((err) => alive && setError(err.message));
        };
        tick();
        const timer = setInterval(tick, 3000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, []);
    // Messages poll for the active room.
    React.useEffect(() => {
        if (!activeRoomId)
            return;
        let alive = true;
        const tick = () => {
            (0, api_1.messagesApi)(activeRoomId)
                .then((d) => {
                if (!alive)
                    return;
                setMessages(d.messages);
                setHasOlder(d.messages.length >= 200);
                const maxSeq = d.messages.reduce((max, m) => Math.max(max, m.seq), 0);
                countedSeqRef.current[activeRoomId] = Math.max(countedSeqRef.current[activeRoomId] ?? 0, maxSeq);
                setUnread((prev) => ({ ...prev, [activeRoomId]: 0 }));
            })
                .catch(() => { });
        };
        tick();
        const timer = setInterval(tick, 3000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [activeRoomId]);
    // SSE push subscription (once; closures read refs).
    React.useEffect(() => {
        const unsub = (0, api_1.subscribeEvents)((event) => {
            if (event.kind === "chat" && typeof event.roomId === "string" && event.message) {
                handlePushMessage(event.roomId, event.message);
            }
            if (event.kind === "activate-error" && typeof event.roomId === "string" && typeof event.message === "string") {
                setActivateError(event.message);
                setThinkingRooms((prev) => {
                    const next = { ...prev };
                    delete next[event.roomId];
                    return next;
                });
            }
            debouncedRefresh();
        });
        return unsub;
    }, []);
    const debouncedRefresh = () => refreshState();
    // Auto-scroll the chat stream.
    React.useEffect(() => {
        const el = chatScrollRef.current;
        if (el && (atBottomRef.current || justSentRef.current))
            el.scrollTop = el.scrollHeight;
        if (justSentRef.current)
            justSentRef.current = false;
    }, [messages, tab]);
    const onChatScroll = () => {
        const el = chatScrollRef.current;
        if (!el)
            return;
        atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
    };
    const loadOlder = () => {
        if (!activeRoomId || loadingOlder)
            return;
        const oldest = messages[0]?.seq;
        if (oldest === undefined)
            return;
        setLoadingOlder(true);
        void (0, api_1.messagesApi)(activeRoomId, oldest)
            .then((d) => {
            if (d.messages.length > 0) {
                setMessages((prev) => {
                    const seen = new Set(prev.map((m) => m.seq));
                    const older = d.messages.filter((m) => !seen.has(m.seq));
                    return [...older, ...prev];
                });
                setHasOlder(d.messages.length >= 200);
            }
            else {
                setHasOlder(false);
            }
        })
            .catch(() => { })
            .finally(() => setLoadingOlder(false));
    };
    /* ----------------------------- derived -------------------------------- */
    const activeRoom = state?.rooms.find((r) => r.roomId === activeRoomId) ?? null;
    const localAgentId = state?.identity.agentId ?? "";
    const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);
    /** Always sends POST (empty body when none given) — GET would 404 action routes. */
    const post = async (path, body) => {
        try {
            await (0, api_1.api)(path, body ?? {});
            setError(null);
        }
        catch (err) {
            setError((0, api_1.friendlyError)(err.message));
            throw err;
        }
    };
    const copyText = (text) => {
        const done = () => setError(null);
        const fail = () => setError("复制失败，请手动复制");
        try {
            if (navigator.clipboard?.writeText) {
                void navigator.clipboard.writeText(text).then(done, fail);
            }
            else {
                const ta = document.createElement("textarea");
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
                done();
            }
        }
        catch {
            fail();
        }
    };
    /* ----------------------------- actions -------------------------------- */
    const createRoom = () => {
        const title = createTitle.trim();
        if (!title) {
            setError("请输入房间标题");
            return;
        }
        void post("/agent-room-api/rooms", { title, type: createType })
            .then(() => {
            setCreateTitle("");
            setCreating(false);
            window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 600);
        })
            .catch(() => { });
    };
    const joinRoom = () => {
        const address = joinAddr.trim();
        if (!address) {
            setError("请输入 host:port 或 relay:// 地址");
            return;
        }
        void (0, api_1.api)("/agent-room-api/join", {
            address,
            roomId: joinRoomId ?? undefined,
            password: joinPassword || undefined,
        })
            .then((d) => {
            setJoinAddr("");
            setJoinPassword("");
            setJoinRoomId(null);
            setJoining(false);
            refreshState(d.roomId);
        })
            .catch((err) => setError((0, api_1.friendlyError)(err.message)));
    };
    const joinDiscovered = (room) => {
        if (room.authMode === "password") {
            // 密码房间：打开加入面板并预填地址，由用户输入密码（不用 window.prompt）。
            setJoinAddr(room.addresses[0] ?? "");
            setJoinRoomId(room.roomId);
            setJoinPassword("");
            setJoining(true);
            setCreating(false);
            setError(null);
            return;
        }
        void (0, api_1.api)("/agent-room-api/join", { addresses: room.addresses, roomId: room.roomId })
            .then((d) => refreshState(d.roomId))
            .catch((err) => setError((0, api_1.friendlyError)(err.message)));
    };
    /** Web chat always speaks as the human at the browser — no takeover toggle. */
    const sendChat = () => {
        if (!activeRoom || !text.trim())
            return;
        const roomId = activeRoom.roomId;
        const content = text.trim();
        const identity = state?.identity;
        const optimistic = {
            seq: -Date.now(),
            from: identity?.agentId ?? "me",
            fromNickname: identity?.nickname ?? "我",
            ts: new Date().toISOString(),
            text: content,
            human: true,
        };
        setText("");
        setMessages((prev) => [...prev, optimistic]);
        justSentRef.current = true;
        void (0, api_1.api)(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/chat`, { text: content, human: true })
            .then(() => (0, api_1.messagesApi)(roomId).then((d) => setMessages(d.messages)).catch(() => { }))
            .catch((err) => {
            setMessages((prev) => prev.filter((m) => m.seq !== optimistic.seq));
            setError((0, api_1.friendlyError)(err.message));
            // 发送失败时把原文放回输入框，方便重试（仅当输入框还是空的）。
            setText((cur) => cur || content);
        });
    };
    /** Toggle the local agent's room listening (auto-wake on relevant messages). */
    const toggleListening = (roomId, on) => {
        void (0, api_1.listeningApi)(roomId, on)
            .then(() => refreshState())
            .catch((err) => setError((0, api_1.friendlyError)(err.message)));
    };
    /** Optimistic task mutation + POST; on failure the next state poll restores truth. */
    const taskAction = (action, taskId, body) => {
        if (!activeRoom)
            return;
        const roomId = activeRoom.roomId;
        const patch = (t) => {
            switch (action) {
                case "claim": return { ...t, assignee: localAgentId || undefined };
                case "status": return { ...t, status: body?.status === "doing" ? "doing" : "todo" };
                case "complete": return { ...t, status: t.judge?.mode === "auto" ? "done" : "review" };
                case "approve": return { ...t, status: "done" };
                case "reject": return { ...t, status: "rejected" };
                case "reopen": return { ...t, status: "todo" };
                default: return t;
            }
        };
        setState((prev) => {
            if (!prev)
                return prev;
            return {
                ...prev,
                rooms: prev.rooms.map((r) => r.roomId === roomId ? { ...r, tasks: r.tasks.map((t) => (t.taskId === taskId ? patch(t) : t)) } : r),
            };
        });
        void post(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}/${action}`, body)
            .then(() => window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300))
            .catch(() => window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300));
    };
    const createTask = () => {
        if (!activeRoom || !newTitle.trim())
            return;
        const roomId = activeRoom.roomId;
        void post(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/tasks`, {
            title: newTitle.trim(),
            description: newDesc.trim() || undefined,
            acceptance: newAcceptance.trim() || undefined,
            judgeMode: newJudge,
            claimable: newClaimable,
        })
            .then(() => {
            setNewTitle("");
            setNewDesc("");
            setNewAcceptance("");
            setShowCreate(false);
            window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300);
        })
            .catch(() => { });
    };
    const doReject = (taskId) => {
        const note = (rejectNotes[taskId] ?? "").trim();
        if (!note) {
            setError("请填写驳回原因");
            return;
        }
        setRejecting(null);
        taskAction("reject", taskId, { note });
    };
    const setRelay = () => {
        void api_1.relayConfigApi
            .set(relayInput.trim() || undefined)
            .then(() => refreshState())
            .catch((err) => setError(err.message));
    };
    const clearRelay = () => {
        void api_1.relayConfigApi
            .set(undefined)
            .then(() => {
            setRelayInput("");
            refreshState();
        })
            .catch((err) => setError(err.message));
    };
    const doDeleteRoom = () => {
        if (!activeRoom)
            return;
        setConfirmDelete(false);
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/delete`)
            .then(() => {
            setActiveRoomId(null);
            window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 400);
        })
            .catch(() => { });
    };
    const doLeaveRoom = () => {
        const roomId = confirmLeaveRoom ?? activeRoom?.roomId;
        if (!roomId)
            return;
        setConfirmLeaveRoom(null);
        void post(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/leave`)
            .then(() => {
            if (activeRoomId === roomId)
                setActiveRoomId(null);
            window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 400);
        })
            .catch(() => { });
    };
    const armKick = (agentId) => {
        setConfirmDelete(false);
        setConfirmLeaveRoom(null);
        setConfirmKickAgent(agentId);
        if (confirmTimer.current !== null)
            window.clearTimeout(confirmTimer.current);
        confirmTimer.current = window.setTimeout(() => { confirmTimer.current = null; resetConfirms(); }, 4000);
    };
    const doKickMember = (member) => {
        if (!activeRoom)
            return;
        setConfirmKickAgent(null);
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(member.agentId)}/kick`)
            .then(() => window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300))
            .catch(() => { });
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
        confirmTimer.current = window.setTimeout(() => { confirmTimer.current = null; resetConfirms(); }, 4000);
    };
    const doRevokeMember = (member) => {
        if (!activeRoom)
            return;
        setConfirmRevokeAgent(null);
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(member.agentId)}/revoke`)
            .then(() => window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300))
            .catch(() => { });
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
        confirmTimer.current = window.setTimeout(() => { confirmTimer.current = null; resetConfirms(); }, 4000);
    };
    const doUnrevokeMember = (agentId) => {
        if (!activeRoom)
            return;
        setConfirmUnrevokeAgent(null);
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(agentId)}/unrevoke`)
            .then(() => window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300))
            .catch(() => { });
    };
    const armDeleteTask = (taskId) => {
        setConfirmDeleteTask(taskId);
        if (confirmTimer.current !== null)
            window.clearTimeout(confirmTimer.current);
        confirmTimer.current = window.setTimeout(() => { confirmTimer.current = null; resetConfirms(); }, 4000);
    };
    const doDeleteTask = (taskId) => {
        if (!activeRoom)
            return;
        setConfirmDeleteTask(null);
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${encodeURIComponent(taskId)}/remove`)
            .then(() => window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300))
            .catch(() => { });
    };
    const assignRole = (member, role) => {
        if (!activeRoom)
            return;
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(member.agentId)}/roles`, { roles: [role] })
            .then(() => window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300))
            .catch(() => { });
    };
    const setMyRole = (role) => {
        if (!activeRoom)
            return;
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/member-roles`, { roles: [role] })
            .then(() => window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300))
            .catch(() => { });
    };
    const saveMyCaps = () => {
        if (!activeRoom)
            return;
        const tags = capsInput.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/member-capabilities`, { capabilities: tags })
            .then(() => {
            setCapsInput("");
            window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300);
        })
            .catch(() => { });
    };
    /** 激活聊天: one-shot — button flips to 思考中 immediately, server state
     *  (poll + SSE) restores it once our own reply lands. On a backend error the
     *  button is restored AND a persistent error message is shown (not a silent
     *  bounce-back). */
    const activateChat = () => {
        if (!activeRoom)
            return;
        const roomId = activeRoom.roomId;
        setActivateError(null);
        setThinkingRooms((prev) => ({ ...prev, [roomId]: true }));
        void (0, api_1.activateChatApi)(roomId)
            .then(() => refreshState())
            .catch((err) => {
            setThinkingRooms((prev) => {
                const next = { ...prev };
                delete next[roomId];
                return next;
            });
            setActivateError((0, api_1.friendlyError)(err.message));
        });
    };
    /** Effective thinking state: optimistic flag wins until the server confirms. */
    const roomThinking = (roomId) => thinkingRooms[roomId] ?? Boolean(state?.rooms.find((r) => r.roomId === roomId)?.activateThinking);
    const selectRoom = (roomId) => {
        setActiveRoomId(roomId);
        setTab("chat");
        setUnread((prev) => ({ ...prev, [roomId]: 0 }));
        const room = state?.rooms.find((r) => r.roomId === roomId);
        if (room?.latestSeq)
            countedSeqRef.current[roomId] = Math.max(countedSeqRef.current[roomId] ?? 0, room.latestSeq);
        const maxMsg = messages.reduce((max, m) => Math.max(max, m.seq), 0);
        if (maxMsg > 0)
            countedSeqRef.current[roomId] = Math.max(countedSeqRef.current[roomId] ?? 0, maxMsg);
        setChatSearch("");
    };
    /* ----------------------------- render --------------------------------- */
    const roomListProps = {
        rooms: state?.rooms ?? [],
        discovered: state?.discovered ?? [],
        activeRoomId,
        unread,
        creating,
        joining,
        createTitle,
        createType,
        joinAddr,
        joinPassword,
        relayHint: Boolean(state?.relay?.configured || state?.relay?.address),
        onCreateTitle: setCreateTitle,
        onCreateType: setCreateType,
        onJoinAddr: setJoinAddr,
        onJoinPassword: setJoinPassword,
        onToggleCreate: () => { setCreating((v) => !v); setJoining(false); },
        onToggleJoin: () => { setJoining((v) => !v); setCreating(false); },
        onCreate: createRoom,
        onJoin: joinRoom,
        onJoinDiscovered: joinDiscovered,
        onSelect: selectRoom,
        onCopy: copyText,
        leaveConfirm: confirmLeaveRoom,
        onArmLeave: (roomId) => armConfirm("leave", roomId),
    };
    const bridge = activeRoom ? (0, theme_1.bridgeLabel)(activeRoom.bridge) : null;
    return (React.createElement("div", { className: "ar-root", style: { position: "relative", display: "inline-flex", alignItems: "center" }, onMouseEnter: scheduleOpen, onMouseLeave: scheduleClose },
        React.createElement("button", { className: "ar-tab", onClick: () => {
                requestNotifPermission();
                setPinned((p) => !p);
                setOpen(true);
            }, style: {
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 16px",
                fontSize: 14,
                fontWeight: 700,
                color: "#eef2ff",
                background: "linear-gradient(135deg, rgba(91,140,255,.28), rgba(34,211,238,.16))",
                border: "1px solid rgba(120,150,255,.55)",
                borderRadius: 999,
                cursor: "pointer",
                whiteSpace: "nowrap",
                userSelect: "none",
                boxShadow: "0 2px 12px rgba(91,140,255,.35)",
                transition: "box-shadow .25s ease, transform .25s ease, border-color .25s ease",
            }, title: pinned ? "Agent 房间（已固定，点击取消固定）" : "Agent 房间（悬停展开；点击固定）" },
            React.createElement("span", { style: { fontSize: 16 } }, "\uD83E\uDD16"),
            React.createElement("span", null,
                "Agent \u623F\u95F4",
                state ? ` · ${state.rooms.length}` : ""),
            pinned && React.createElement("span", { style: { fontSize: 12, opacity: 0.8 } }, "\uD83D\uDCCC"),
            totalUnread > 0 && React.createElement(common_1.UnreadDot, { count: totalUnread })),
        React.createElement("div", { className: "ar-panel", style: {
                position: "absolute",
                top: "calc(100% + 10px)",
                right: 0,
                width: pinned ? 740 : 620,
                maxWidth: "min(96vw, 740px)",
                background: theme_1.THEME.panel,
                border: "1px solid rgba(120,150,255,.4)",
                borderRadius: 16,
                boxShadow: "0 20px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(120,150,255,.14), 0 0 32px rgba(91,140,255,.22)",
                zIndex: 9999,
                overflow: "hidden",
                fontSize: 14,
                color: theme_1.THEME.text,
                maxHeight: pinned ? "82vh" : "76vh",
                opacity: open ? 1 : 0,
                transform: open ? "translateY(0) scale(1)" : "translateY(-10px) scale(.985)",
                pointerEvents: open ? "auto" : "none",
                transition: "max-height .28s ease, opacity .2s ease, transform .26s ease, width .2s ease",
                display: "flex",
                flexDirection: "column",
            } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: `1px solid ${theme_1.THEME.border}`, flexShrink: 0 } },
                React.createElement("span", { style: { fontSize: 17 } }, "\uD83E\uDD16"),
                React.createElement("div", null,
                    React.createElement("div", { style: { fontWeight: 800, fontSize: 16, letterSpacing: 0.2 } }, "Agent \u623F\u95F4"),
                    React.createElement("div", { style: { fontSize: 12, color: theme_1.THEME.faint, fontWeight: 400 } }, state ? `${state.identity.nickname} · ${state.rooms.length} 个房间` : "…")),
                React.createElement("span", { style: { flex: 1 } }),
                state?.node?.hostname && (React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint, fontFamily: theme_1.THEME.mono } }, state.node.hostname)),
                React.createElement(common_1.Btn, { variant: pinned ? "primary" : "ghost", size: "sm", onClick: () => setPinned((p) => !p), title: "\u56FA\u5B9A\u9762\u677F" }, pinned ? "已固定" : "固定")),
            error && (React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", background: theme_1.THEME.redSoft, color: theme_1.THEME.red, fontSize: 12, borderBottom: "1px solid rgba(248,113,113,.35)", flexShrink: 0 } },
                React.createElement("span", { style: { flex: 1 } },
                    "\u26A0 ",
                    error),
                React.createElement("button", { onClick: () => setError(null), style: { background: "none", border: "none", color: theme_1.THEME.red, cursor: "pointer", fontSize: 14 } }, "\u2715"))),
            React.createElement("div", { style: { overflowY: "auto", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
                React.createElement(RoomList_1.RoomList, { ...roomListProps }),
                activeRoom && (React.createElement(React.Fragment, { key: activeRoom.roomId },
                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", borderTop: `1px solid ${theme_1.THEME.border}`, borderBottom: `1px solid ${theme_1.THEME.border}`, background: theme_1.THEME.card } },
                        React.createElement("span", { style: { fontSize: 13, fontWeight: 700, color: theme_1.THEME.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 } },
                            activeRoom.type === "temporary" ? "⚡" : "📁",
                            " ",
                            activeRoom.title),
                        React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint } },
                            activeRoom.memberCount,
                            "\u4EBA"),
                        bridge && (React.createElement(common_1.Pill, { color: bridge.color, bg: bridge.color + "18" },
                            React.createElement(common_1.StatusDot, { color: bridge.color, pulse: bridge.state === "open" || bridge.state === "reconnecting" || bridge.state === "disconnected", size: 6 }),
                            bridge.text)),
                        React.createElement("span", { style: { flex: 1 } }),
                        activeRoom.owned && activeRoom.serverAddress && (React.createElement("span", { onClick: () => copyText(activeRoom.serverAddress ?? ""), title: "\u70B9\u51FB\u590D\u5236\u5206\u4EAB\u5730\u5740", style: { fontSize: 10, fontFamily: theme_1.THEME.mono, color: theme_1.THEME.faint, cursor: "pointer", border: `1px dashed ${theme_1.THEME.border}`, borderRadius: 6, padding: "2px 5px" } }, activeRoom.serverAddress)),
                        roomThinking(activeRoom.roomId) && React.createElement(common_1.Pill, { color: theme_1.THEME.amber, bg: theme_1.THEME.amberSoft }, "\u23F3 \u601D\u8003\u4E2D")),
                    React.createElement("div", { style: { display: "flex", gap: 2, padding: "6px 12px 0", borderBottom: `1px solid ${theme_1.THEME.border}`, flexShrink: 0 } }, [
                        ["chat", "聊天", unread[activeRoom.roomId] ?? 0],
                        ["tasks", "任务", 0],
                        ["members", "成员", 0],
                        ["settings", "设置", 0],
                    ].map(([key, label, badge]) => (React.createElement("button", { key: key, className: "ar-tabbtn", onClick: () => setTab(key), style: {
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "7px 14px",
                            fontSize: 13,
                            fontWeight: tab === key ? 700 : 500,
                            color: tab === key ? "#fff" : theme_1.THEME.dim,
                            background: tab === key ? "linear-gradient(180deg, rgba(91,140,255,.22), transparent)" : "transparent",
                            borderBottom: tab === key ? `2px solid ${theme_1.THEME.accent}` : "2px solid transparent",
                        } },
                        key === "chat" ? "💬" : key === "tasks" ? "📋" : key === "members" ? "👥" : "⚙️",
                        " ",
                        label,
                        badge > 0 && React.createElement(common_1.UnreadDot, { count: badge }))))),
                    React.createElement("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
                        tab === "chat" && (React.createElement(Chat_1.Chat, { room: activeRoom, messages: messages, text: text, listening: Boolean(activeRoom.listening), thinking: roomThinking(activeRoom.roomId), search: chatSearch, loadingOlder: loadingOlder, hasOlder: hasOlder, scrollRef: chatScrollRef, onScroll: onChatScroll, onTextChange: setText, onSend: sendChat, onToggleListening: () => toggleListening(activeRoom.roomId, !activeRoom.listening), onActivateChat: activateChat, activateError: activateError, onClearActivateError: () => setActivateError(null), onLoadOlder: loadOlder, onSearchChange: setChatSearch })),
                        tab === "tasks" && (React.createElement(TaskBoard_1.TaskBoard, { room: activeRoom, localAgentId: localAgentId, search: taskSearch, filter: taskFilter, sort: taskSort, showCreate: showCreate, newTitle: newTitle, newDesc: newDesc, newAcceptance: newAcceptance, newJudge: newJudge, newClaimable: newClaimable, confirmDeleteTask: confirmDeleteTask, rejecting: rejecting, rejectNotes: rejectNotes, onSearchChange: setTaskSearch, onFilterChange: setTaskFilter, onSortChange: setTaskSort, onToggleCreate: () => setShowCreate((v) => !v), onNewTitle: setNewTitle, onNewDesc: setNewDesc, onNewAcceptance: setNewAcceptance, onNewJudge: setNewJudge, onNewClaimable: setNewClaimable, onCreateTask: createTask, onTaskAction: taskAction, onArmDeleteTask: armDeleteTask, onDoDeleteTask: doDeleteTask, onRejectToggle: (taskId) => setRejecting((cur) => (cur === taskId ? null : taskId)), onRejectNote: (taskId, v) => setRejectNotes((prev) => ({ ...prev, [taskId]: v })), onDoReject: doReject })),
                        tab === "members" && (React.createElement(Members_1.Members, { room: activeRoom, localAgentId: localAgentId, capsInput: capsInput, leaveConfirm: confirmLeaveRoom, confirmKick: confirmKickAgent, confirmRevoke: confirmRevokeAgent, confirmUnrevoke: confirmUnrevokeAgent, onCapsInput: setCapsInput, onSaveCaps: saveMyCaps, onAssignRole: assignRole, onSetMyRole: setMyRole, onArmKick: armKick, onDoKick: doKickMember, onArmRevoke: armRevoke, onDoRevoke: doRevokeMember, onArmUnrevoke: armUnrevoke, onDoUnrevoke: doUnrevokeMember, onArmLeave: () => armConfirm("leave", activeRoom.roomId), onDoLeave: doLeaveRoom })),
                        tab === "settings" && (React.createElement(Settings_1.Settings, { room: activeRoom, owned: activeRoom.owned, relayAddress: state?.relay?.address, relayConfigured: Boolean(state?.relay?.configured), relayInput: relayInput, nodeAddresses: state?.node?.addresses ?? [], confirmDelete: confirmDelete, onRelayInput: setRelayInput, onSaveRelay: setRelay, onClearRelay: clearRelay, onAuthMode: (mode) => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/settings`, { authMode: mode }).then(() => window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300)), onSetPassword: (pw) => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/settings`, { password: pw }).then(() => window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300)), onToggleAutoMode: (v) => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/settings`, { autoMode: v }).then(() => window.setTimeout(() => (0, api_1.stateApi)().then(setState).catch(() => { }), 300)), onCopy: copyText, onArmDelete: () => armConfirm("delete"), onDoDelete: doDeleteRoom }))))),
                !activeRoom && (React.createElement("div", { style: { padding: "18px 14px", fontSize: 13, color: theme_1.THEME.faint, textAlign: "center" } }, "\u9009\u62E9\u6216\u521B\u5EFA\u4E00\u4E2A\u623F\u95F4\u5F00\u59CB\u534F\u4F5C"))))));
}
/* ----------------------------- registration ---------------------------- */
const NS = "agent-room";
const zh = { title: "Agent 房间" };
const en = { title: "Agent Rooms" };
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

} };
__arModules["api"] = { loaded: false, exports: {}, factory: function (require, exports, module) {
"use strict";
/**
 * dsh-agent-room — browser API layer: client-side projections of the host
 * types plus the HTTP endpoints of /agent-room-api.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.relayConfigApi = exports.listeningApi = exports.activateStateApi = exports.activateChatApi = exports.messagesApi = exports.stateApi = void 0;
exports.friendlyError = friendlyError;
exports.api = api;
exports.subscribeEvents = subscribeEvents;
/* ----------------------------- api helpers ----------------------------- */
/**
 * Map raw server error strings to specific, user-facing messages (D9 UX):
 * join rejections carry protocol codes ("join rejected: wrong-password") or
 * the owner's Chinese message; relay path errors are Chinese already. Fall
 * back to the original text when nothing matches.
 */
const JOIN_ERROR_ZH = [
    [/wrong-password|密码错误/, "加入失败：密码错误（密码房间需要填写正确密码）"],
    [/revoked|吊销入场资格/, "加入失败：你已被吊销入场资格"],
    [/room-full|房间人数已满/, "加入失败：房间人数已满"],
    [/room-closed|房间未开放/, "加入失败：房间未开放"],
    [/room-not-found|房间不存在|not-found/, "加入失败：找不到该房间（检查地址或房间号）"],
    [/already-member/, "已在该房间中"],
    [/中继加入超时/, "加入失败：中继连接超时（检查中继地址是否可达，稍后重试）"],
    [/relay auth rejected/, "加入失败：中继认证未通过（可能已被吊销或凭证过期）"],
    [/中继连接中断/, "加入失败：中继连接中断"],
    [/连接超时/, "加入失败：直连超时（目标地址不可达，将自动尝试中继）"],
    [/没有可用的连接地址/, "加入失败：没有可用的连接地址"],
];
function friendlyError(message) {
    if (!message)
        return "操作失败";
    for (const [re, zh] of JOIN_ERROR_ZH) {
        if (re.test(message))
            return zh;
    }
    if (message.startsWith("join rejected")) {
        return "加入失败：" + message.replace(/^join rejected:\s*/, "");
    }
    return message;
}
async function api(path, body) {
    const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json());
    if (!json.ok || !response.ok)
        throw new Error(friendlyError(json.error ?? `HTTP ${response.status}`));
    return json.data;
}
const stateApi = () => api("/agent-room-api/state");
exports.stateApi = stateApi;
const messagesApi = (roomId, before) => api(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/messages${before !== undefined ? `?before=${before}` : ""}`);
exports.messagesApi = messagesApi;
/** 激活聊天: one-shot — the local agent replies once based on room context. */
const activateChatApi = (roomId) => api(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/activate-chat`, {});
exports.activateChatApi = activateChatApi;
/** Current activate-thinking state for a room. */
const activateStateApi = (roomId) => api(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/activate-state`);
exports.activateStateApi = activateStateApi;
/** 监听: turn the local agent's room listening (auto-wake) on/off. */
const listeningApi = (roomId, on) => api(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/listening`, { on });
exports.listeningApi = listeningApi;
exports.relayConfigApi = {
    get: () => api("/agent-room-api/relay-config"),
    set: (relay) => api("/agent-room-api/relay-config", { relay }),
};
/**
 * Open an SSE stream of browser events. Resolves an unsubscribe function.
 * The caller must treat failures as non-fatal (polling is the fallback).
 */
function subscribeEvents(onEvent) {
    let source = null;
    let closed = false;
    try {
        if (typeof EventSource === "undefined")
            return () => { };
        source = new EventSource("/agent-room-api/events");
        source.onmessage = () => { };
        const kinds = ["chat", "task", "system", "connection", "members", "state", "activate-error"];
        for (const kind of kinds) {
            source.addEventListener(kind, (e) => {
                try {
                    onEvent(JSON.parse(e.data));
                }
                catch {
                    /* malformed event — ignore */
                }
            });
        }
    }
    catch {
        /* EventSource unavailable (e.g. non-browser env) — fall back to polling */
    }
    return () => {
        closed = true;
        try {
            source?.close();
        }
        catch {
            /* ignore */
        }
        source = null;
    };
}

} };
__arModules["components/Chat"] = { loaded: false, exports: {}, factory: function (require, exports, module) {
"use strict";
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
exports.Chat = Chat;
/**
 * dsh-agent-room — Chat tab: message stream with seq pagination ("load older"),
 * client-side search, and the send bar (agent / human takeover / activate-chat).
 */
const React = __importStar(require("react"));
const theme_1 = require("../theme");
const common_1 = require("./common");
function highlight(text, query) {
    if (!query)
        return text;
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0)
        return text;
    return (React.createElement(React.Fragment, null,
        text.slice(0, idx),
        React.createElement("mark", { style: { background: "rgba(251,191,36,.35)", color: "#ffd27d", borderRadius: 3, padding: "0 1px" } }, text.slice(idx, idx + q.length)),
        text.slice(idx + q.length)));
}
function Chat(props) {
    const { room, messages, text, listening, thinking, search, loadingOlder, hasOlder, scrollRef, activateError } = props;
    const query = search.trim().toLowerCase();
    const filtered = query
        ? messages.filter((m) => m.text.toLowerCase().includes(query) || m.fromNickname.toLowerCase().includes(query))
        : messages;
    return (React.createElement("div", { style: { display: "flex", flexDirection: "column", minHeight: 0 } },
        React.createElement("div", { style: { padding: "6px 12px", borderBottom: `1px solid ${theme_1.THEME.border}`, display: "flex", gap: 8, alignItems: "center" } },
            React.createElement("span", { style: { fontSize: 13, opacity: 0.8 } }, "\uD83D\uDD0D"),
            React.createElement("input", { className: "ar-input", style: { flex: 1, padding: "5px 9px", fontSize: 12 }, placeholder: "\u641C\u7D22\u6D88\u606F\uFF08\u6309\u5185\u5BB9 / \u53D1\u9001\u8005\uFF09", value: search, onChange: (e) => props.onSearchChange(e.target.value) }),
            query && (React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint } },
                filtered.length,
                "/",
                messages.length,
                " \u6761"))),
        React.createElement("div", { ref: scrollRef, onScroll: props.onScroll, style: { flex: 1, overflowY: "auto", padding: "6px 12px", minHeight: 180, maxHeight: "44vh" } },
            !query && (React.createElement("div", { style: { textAlign: "center", padding: "4px 0 6px" } }, loadingOlder ? (React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint } }, "\u52A0\u8F7D\u4E2D\u2026")) : hasOlder ? (React.createElement(common_1.Btn, { size: "sm", onClick: props.onLoadOlder }, "\u2191 \u52A0\u8F7D\u66F4\u65E9\u6D88\u606F")) : (React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint } }, "\u5DF2\u5230\u6700\u65E9")))),
            filtered.map((m) => (React.createElement("div", { key: m.seq, style: { padding: "3px 0", lineHeight: 1.5, fontSize: 13, color: theme_1.THEME.text } },
                m.human && (React.createElement("span", { style: { background: "rgba(251,191,36,.2)", color: "#ffd27d", borderRadius: 4, padding: "1px 5px", marginRight: 6, fontSize: 11 } }, "\uD83D\uDC64 \u4EBA\u7C7B")),
                React.createElement("span", { style: { opacity: 0.55, marginRight: 6, fontSize: 12 } },
                    m.fromNickname,
                    " ",
                    (0, theme_1.fmtTime)(m.ts)),
                React.createElement("span", { style: { wordBreak: "break-word" } }, highlight(m.text, query))))),
            filtered.length === 0 && (React.createElement("div", { style: { opacity: 0.5, padding: 8, fontSize: 12, textAlign: "center" } }, query ? "没有匹配的消息" : "还没有消息"))),
        activateError && (React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 12px 0", fontSize: 12, color: theme_1.THEME.red } },
            React.createElement("span", { style: { flex: 1 } },
                "\u26A0 ",
                activateError),
            React.createElement("button", { onClick: props.onClearActivateError, style: { background: "none", border: "none", color: theme_1.THEME.red, cursor: "pointer", fontSize: 14 }, title: "\u5173\u95ED\u63D0\u793A" }, "\u2715"))),
        React.createElement("div", { style: { display: "flex", gap: 8, padding: "8px 12px 10px", borderTop: `1px solid ${theme_1.THEME.border}` } },
            React.createElement("input", { className: "ar-input", style: { flex: 1, padding: "8px 10px", fontSize: 14 }, value: text, placeholder: "\u4EE5\u4EBA\u7C7B\u8EAB\u4EFD\u53D1\u8A00\u2026\uFF08Enter \u53D1\u9001\uFF09", onChange: (e) => props.onTextChange(e.target.value), onKeyDown: (e) => e.key === "Enter" && props.onSend() }),
            React.createElement(common_1.Btn, { variant: "primary", disabled: thinking, title: thinking ? "本机 agent 正在思考中，回复完成后可再次激活" : "点击后本机 agent 基于房间上下文自动回复一条", onClick: props.onActivateChat }, thinking ? "⏳ 思考中…" : "💬 激活聊天"),
            React.createElement(common_1.Btn, { variant: listening ? "primary" : "ghost", onClick: props.onToggleListening, title: listening ? "监听中：收到需要我的消息会自动响应（点击关闭）" : "开启监听：收到需要我的消息自动响应" }, listening ? "👂 监听中" : "👂 监听"),
            React.createElement(common_1.Btn, { variant: "primary", onClick: props.onSend, disabled: !text.trim() }, "\u53D1\u9001"))));
}

} };
__arModules["components/Members"] = { loaded: false, exports: {}, factory: function (require, exports, module) {
"use strict";
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
exports.Members = Members;
/**
 * dsh-agent-room — Members tab: member list with roles/capability tags,
 * connection status of this node's channel, revoked list, human takeover,
 * and leave-room.
 */
const React = __importStar(require("react"));
const theme_1 = require("../theme");
const common_1 = require("./common");
function Members(props) {
    const { room, localAgentId, capsInput } = props;
    const bridge = (0, theme_1.bridgeLabel)(room.bridge);
    const me = room.members.find((m) => m.agentId === localAgentId);
    return (React.createElement("div", { style: { padding: "0 12px 10px", overflowY: "auto", maxHeight: "52vh" } },
        React.createElement("div", { style: { marginTop: 8, border: `1px solid ${theme_1.THEME.border}`, borderRadius: 10, padding: "8px 10px", background: theme_1.THEME.card } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                React.createElement("span", { style: { fontSize: 12, fontWeight: 700, color: theme_1.THEME.text } }, "\u672C\u673A\u8FDE\u63A5"),
                React.createElement("span", { style: { flex: 1 } }),
                React.createElement(common_1.Pill, { color: bridge.color, bg: bridge.color + "18" },
                    React.createElement(common_1.StatusDot, { color: bridge.color, pulse: bridge.state === "open" || bridge.state === "reconnecting" || bridge.state === "disconnected", size: 6 }),
                    bridge.text)),
            room.bridge?.address && (React.createElement("div", { style: { fontSize: 11, color: theme_1.THEME.faint, marginTop: 4, fontFamily: theme_1.THEME.mono } }, room.bridge.address)),
            room.bridge?.kind === "relay" && (React.createElement("div", { style: { fontSize: 11, color: theme_1.THEME.cyan, marginTop: 4 } }, "\uD83C\uDF10 \u7ECF\u4E2D\u7EE7\u6865\u63A5\uFF1A\u76F4\u8FDE\u4E0D\u53EF\u8FBE\u65F6\u81EA\u52A8\u5207\u6362\u8DE8\u7F51\u901A\u9053")),
            (bridge.state === "reconnecting" || bridge.state === "disconnected") && (React.createElement("div", { style: { fontSize: 11, color: theme_1.THEME.amber, marginTop: 4 } }, "\u26A0 \u901A\u9053\u4E2D\u65AD\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u8FDE\u2026\uFF08\u65E0\u9700\u624B\u52A8\u64CD\u4F5C\uFF09"))),
        room.members.map((m) => {
            const isMe = m.agentId === localAgentId;
            return (React.createElement("div", { key: m.agentId, style: { display: "flex", alignItems: "center", gap: 8, padding: "7px 2px", borderBottom: `1px solid rgba(120,150,255,.08)` } },
                React.createElement("span", { style: { fontSize: 15 } }, m.role === "owner" ? "👑" : "🤖"),
                React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                        React.createElement("span", { style: { fontSize: 13, fontWeight: 600, color: theme_1.THEME.text } },
                            m.nickname,
                            " ",
                            isMe && React.createElement("span", { style: { color: theme_1.THEME.cyan, fontSize: 11 } }, "(\u6211)")),
                        m.agentId === room.controllerAgentId && React.createElement(common_1.Pill, { color: theme_1.THEME.purple, bg: theme_1.THEME.purpleSoft }, "\u5224\u5B9A\u4EBA")),
                    React.createElement("div", { style: { display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap", alignItems: "center" } },
                        (m.roles ?? []).map((r) => (React.createElement(common_1.Pill, { key: r, color: theme_1.ROLE_COLOR[r] ?? theme_1.THEME.accent }, theme_1.ROLE_ZH[r] ?? r))),
                        (m.manualCapabilities ?? []).map((c) => (React.createElement(common_1.Pill, { key: "c-" + c, color: theme_1.THEME.green, bg: theme_1.THEME.greenSoft }, c))),
                        React.createElement("span", { style: { fontSize: 10, color: theme_1.THEME.faint, fontFamily: theme_1.THEME.mono } }, m.agentId.slice(0, 8)))),
                room.owned && !isMe && m.role !== "owner" && (React.createElement(React.Fragment, null,
                    React.createElement("select", { className: "ar-input", style: { width: "auto", padding: "3px 6px", fontSize: 11 }, value: m.roles?.[0] ?? "observer", onChange: (e) => props.onAssignRole(m, e.target.value), title: "\u5B89\u6392\u5C97\u4F4D" }, theme_1.ALL_ROLES.map((r) => React.createElement("option", { key: r, value: r }, theme_1.ROLE_ZH[r] ?? r))),
                    React.createElement(common_1.Btn, { variant: props.confirmRevoke === m.agentId ? "danger" : "ghost", onClick: () => (props.confirmRevoke === m.agentId ? props.onDoRevoke(m) : props.onArmRevoke(m.agentId)), title: "\u540A\u9500\u5165\u573A\u8D44\u683C\uFF1A\u8E22\u51FA\u4E14\u7981\u6B62\u518D\u52A0\u5165" }, props.confirmRevoke === m.agentId ? "确认吊销?" : "吊销"),
                    React.createElement(common_1.Btn, { variant: props.confirmKick === m.agentId ? "danger" : "ghost", onClick: () => (props.confirmKick === m.agentId ? props.onDoKick(m) : props.onArmKick(m.agentId)), title: "\u8E22\u51FA\uFF08\u53EF\u91CD\u65B0\u52A0\u5165\uFF09" }, props.confirmKick === m.agentId ? "确认踢出?" : "踢出"))),
                isMe && room.allowHumanTakeover && (React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint } }, "\uD83D\uDC64 \u7F51\u9875\u53D1\u8A00\u5373\u4EBA\u7C7B\u8EAB\u4EFD"))));
        }),
        React.createElement("div", { style: { marginTop: 8, border: `1px solid ${theme_1.THEME.border}`, borderRadius: 10, padding: 8 } },
            React.createElement(common_1.Row, { style: { padding: "2px 0" } },
                React.createElement("span", { style: { fontSize: 12, color: theme_1.THEME.dim } }, "\u6211\u7684\u5C97\u4F4D:"),
                React.createElement("select", { className: "ar-input", style: { width: "auto", padding: "4px 8px", fontSize: 12 }, value: (me?.roles ?? ["observer"])[0] ?? "observer", onChange: (e) => props.onSetMyRole(e.target.value), title: room.owned ? "设置自己的岗位" : "申请岗位（由房主确认）" }, theme_1.ALL_ROLES.map((r) => React.createElement("option", { key: r, value: r }, theme_1.ROLE_ZH[r] ?? r)))),
            React.createElement(common_1.Row, { style: { padding: "2px 0" } },
                React.createElement("span", { style: { fontSize: 12, color: theme_1.THEME.dim } }, "\u80FD\u529B\u6807\u7B7E:"),
                React.createElement("input", { className: "ar-input", style: { flex: 1, padding: "5px 8px", fontSize: 12 }, placeholder: "\u5982: \u524D\u7AEF, \u540E\u7AEF, \u8D22\u52A1", value: capsInput, onChange: (e) => props.onCapsInput(e.target.value), onKeyDown: (e) => e.key === "Enter" && props.onSaveCaps() }),
                React.createElement(common_1.Btn, { onClick: props.onSaveCaps }, "\u4FDD\u5B58"))),
        (room.revoked?.length ?? 0) > 0 && (React.createElement("div", { style: { marginTop: 8 } },
            React.createElement(common_1.SectionTitle, { icon: "\uD83D\uDEAB" }, "\u5DF2\u540A\u9500\u540D\u5355"),
            room.revoked.map((r) => (React.createElement(common_1.Row, { key: r.agentId },
                React.createElement("span", null, "\uD83D\uDEAB"),
                React.createElement("span", { style: { flex: 1, fontSize: 12, color: theme_1.THEME.text } },
                    r.nickname ?? r.agentId.slice(0, 8),
                    r.reason && React.createElement("span", { style: { color: theme_1.THEME.faint, fontSize: 11 } },
                        "\uFF08",
                        r.reason,
                        "\uFF09")),
                React.createElement("span", { style: { fontSize: 10, color: theme_1.THEME.faint, fontFamily: theme_1.THEME.mono } }, r.agentId.slice(0, 8)),
                room.owned && (React.createElement(common_1.Btn, { variant: props.confirmUnrevoke === r.agentId ? "success" : "ghost", onClick: () => (props.confirmUnrevoke === r.agentId ? props.onDoUnrevoke(r.agentId) : props.onArmUnrevoke(r.agentId)) }, props.confirmUnrevoke === r.agentId ? "确认解除?" : "解除吊销"))))))),
        !room.owned && (React.createElement("div", { style: { marginTop: 10, display: "flex", alignItems: "center", gap: 8 } },
            React.createElement("span", { style: { flex: 1, fontSize: 12, color: theme_1.THEME.dim } }, "\u9000\u51FA\u6B64\u623F\u95F4\uFF08\u4FDD\u7559\u623F\u4E3B\u4FA7\u8BB0\u5F55\uFF09"),
            React.createElement(common_1.Btn, { variant: props.leaveConfirm === room.roomId ? "danger" : "ghost", onClick: props.leaveConfirm === room.roomId ? props.onDoLeave : props.onArmLeave }, props.leaveConfirm === room.roomId ? "⚠ 再点一次确认退出" : "退出")))));
}

} };
__arModules["components/RoomList"] = { loaded: false, exports: {}, factory: function (require, exports, module) {
"use strict";
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
exports.RoomList = RoomList;
/**
 * dsh-agent-room — RoomList: create/join panel (input-driven, no window.prompt),
 * owned/joined room rows with status + bridge badges and unread counts, and the
 * LAN-discovered rooms shortcut list.
 */
const React = __importStar(require("react"));
const theme_1 = require("../theme");
const common_1 = require("./common");
function RoomList(props) {
    const { rooms, discovered, activeRoomId, unread, creating, joining, createTitle, createType, joinAddr, joinPassword, onCreateTitle, onCreateType, onJoinAddr, onJoinPassword, onToggleCreate, onToggleJoin, onCreate, onJoin, onJoinDiscovered, onSelect, onCopy, leaveConfirm, onArmLeave, relayHint, } = props;
    return (React.createElement("div", { style: { display: "flex", flexDirection: "column" } },
        React.createElement("div", { style: { display: "flex", gap: 8, padding: "8px 12px", borderBottom: `1px solid ${theme_1.THEME.border}` } },
            React.createElement(common_1.Btn, { variant: creating ? "primary" : "ghost", onClick: onToggleCreate }, creating ? "收起新建" : "＋ 新建房间"),
            React.createElement(common_1.Btn, { variant: joining ? "primary" : "ghost", onClick: onToggleJoin }, joining ? "收起加入" : "⇥ 加入房间")),
        creating && (React.createElement("div", { className: "ar-fade-in", style: { padding: "8px 12px", borderBottom: `1px solid ${theme_1.THEME.border}`, background: theme_1.THEME.accentSoft } },
            React.createElement("div", { style: { display: "flex", gap: 8 } },
                React.createElement("input", { className: "ar-input", style: { flex: 1, padding: "8px 10px", fontSize: 14 }, placeholder: "\u8F93\u5165\u623F\u95F4\u6807\u9898\uFF0C\u4F8B\u5982\uFF1AD7 \u8054\u8C03\u623F\u95F4", value: createTitle, autoFocus: true, onChange: (e) => onCreateTitle(e.target.value), onKeyDown: (e) => e.key === "Enter" && onCreate() }),
                React.createElement(common_1.Btn, { variant: "primary", onClick: onCreate, disabled: !createTitle.trim() }, "\u521B\u5EFA")),
            React.createElement("div", { style: { display: "flex", gap: 14, marginTop: 8, alignItems: "center" } },
                React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: theme_1.THEME.dim, cursor: "pointer" } },
                    React.createElement("input", { type: "radio", checked: createType === "persistent", onChange: () => onCreateType("persistent") }),
                    " \u957F\u671F\u6301\u4E45"),
                React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: theme_1.THEME.dim, cursor: "pointer" } },
                    React.createElement("input", { type: "radio", checked: createType === "temporary", onChange: () => onCreateType("temporary") }),
                    " \u4E34\u65F6\uFF08\u672C\u673A\u5173\u95ED\u5373\u9500\u6BC1\uFF09")))),
        joining && (React.createElement("div", { className: "ar-fade-in", style: { padding: "8px 12px", borderBottom: `1px solid ${theme_1.THEME.border}`, background: theme_1.THEME.cyanSoft } },
            React.createElement("div", { style: { display: "flex", gap: 8 } },
                React.createElement("input", { className: "ar-input", style: { flex: 1, padding: "8px 10px", fontSize: 14, fontFamily: theme_1.THEME.mono }, placeholder: "host:port \u6216 relay://\u2026", value: joinAddr, autoFocus: true, onChange: (e) => onJoinAddr(e.target.value), onKeyDown: (e) => e.key === "Enter" && onJoin() }),
                React.createElement(common_1.Btn, { variant: "primary", onClick: onJoin, disabled: !joinAddr.trim() }, "\u52A0\u5165")),
            React.createElement("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
                React.createElement("input", { className: "ar-input", type: "password", style: { flex: 1, padding: "7px 10px", fontSize: 13 }, placeholder: "\u5BC6\u7801\uFF08\u5BC6\u7801\u623F\u95F4\u5FC5\u586B\uFF0C\u516C\u5F00\u623F\u95F4\u53EF\u7559\u7A7A\uFF09", value: joinPassword, onChange: (e) => onJoinPassword(e.target.value), onKeyDown: (e) => e.key === "Enter" && onJoin() })),
            React.createElement("div", { style: { fontSize: 11, color: theme_1.THEME.faint, marginTop: 6, lineHeight: 1.5 } }, relayHint
                ? "直连不可达 → 自动走中继（已配置）· 密码房间需填写密码"
                : "host:port 直连（同网段）或 relay://…（跨网中继）· 密码房间需填写密码"))),
        React.createElement("div", { style: { maxHeight: 210, overflowY: "auto" } },
            rooms.map((room) => {
                const active = room.roomId === activeRoomId;
                const bridge = (0, theme_1.bridgeLabel)(room.bridge);
                const n = unread[room.roomId] ?? 0;
                return (React.createElement("div", { key: room.roomId, onClick: () => onSelect(room.roomId), style: {
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 12px",
                        cursor: "pointer",
                        background: active ? "linear-gradient(90deg, rgba(91,140,255,.2), rgba(34,211,238,.06))" : "transparent",
                        borderLeft: active ? `2px solid ${theme_1.THEME.accent}` : "2px solid transparent",
                        transition: "background .15s ease",
                    } },
                    React.createElement("span", { style: { fontSize: 16 } }, room.type === "temporary" ? "⚡" : "📁"),
                    React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                            React.createElement("span", { style: { fontWeight: 600, fontSize: 14, color: theme_1.THEME.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, room.title),
                            n > 0 && React.createElement(common_1.UnreadDot, { count: n })),
                        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 2 } },
                            React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint } },
                                room.owned ? "我创建" : "已加入",
                                " \u00B7 ",
                                room.memberCount,
                                "\u4EBA \u00B7 ",
                                room.authMode === "password" ? "🔒" : "公开"),
                            React.createElement(common_1.StatusBadge, { text: (0, theme_1.statusZh)(room.status), status: room.status }))),
                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                        React.createElement(common_1.Pill, { color: bridge.color, bg: bridge.color + "18" },
                            React.createElement(common_1.StatusDot, { color: bridge.color, pulse: bridge.state === "open" || bridge.state === "disconnected" || bridge.state === "reconnecting", size: 6 }),
                            bridge.text),
                        room.owned && room.serverAddress && (React.createElement("span", { title: "\u70B9\u51FB\u590D\u5236\u5206\u4EAB\u5730\u5740", onClick: (e) => { e.stopPropagation(); onCopy(room.serverAddress ?? ""); }, style: { fontSize: 10, fontFamily: theme_1.THEME.mono, color: theme_1.THEME.faint, cursor: "pointer", border: `1px dashed ${theme_1.THEME.border}`, borderRadius: 6, padding: "2px 5px" } }, room.serverAddress)),
                        !room.owned && (React.createElement(common_1.Btn, { variant: leaveConfirm === room.roomId ? "danger" : "ghost", size: "sm", onClick: (e) => { e.stopPropagation(); onArmLeave(room.roomId); }, title: "\u9000\u51FA\u8BE5\u623F\u95F4" }, leaveConfirm === room.roomId ? "确认退出?" : "退出")))));
            }),
            rooms.length === 0 && (React.createElement("div", { style: { padding: "14px 12px", fontSize: 13, color: theme_1.THEME.faint, textAlign: "center" } }, "\u8FD8\u6CA1\u6709\u623F\u95F4 \u2014\u2014 \u4E0A\u65B9\u65B0\u5EFA\uFF0C\u6216\u4ECE\u5C40\u57DF\u7F51\u53D1\u73B0\u5217\u8868\u4E2D\u76F4\u63A5\u52A0\u5165"))),
        discovered.length > 0 && (React.createElement("div", { style: { borderTop: `1px solid ${theme_1.THEME.border}`, maxHeight: 170, overflowY: "auto" } },
            React.createElement(common_1.Row, { style: { fontSize: 11, fontWeight: 700, color: theme_1.THEME.faint, letterSpacing: 1 } }, "\uD83D\uDCE1 \u5C40\u57DF\u7F51\u53D1\u73B0\uFF08\u540C\u7F51\u6BB5\u5FEB\u6377\u52A0\u5165\uFF09"),
            discovered.map((room) => {
                const joined = rooms.some((r) => r.roomId === room.roomId);
                return (React.createElement("div", { key: `${room.addresses[0]}/${room.roomId}`, onClick: () => onSelect(room.roomId), style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", cursor: "pointer", opacity: joined ? 0.7 : 1 } },
                    React.createElement("span", null, joined ? "✅" : "🏠"),
                    React.createElement("span", { style: { flex: 1, fontSize: 13, color: theme_1.THEME.text } }, room.title),
                    React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint } },
                        room.nickname,
                        " \u00B7 ",
                        room.memberCount,
                        "\u4EBA \u00B7 ",
                        room.authMode === "password" ? "🔒密码" : "公开"),
                    React.createElement(common_1.Btn, { size: "sm", variant: joined ? "success" : "primary", onClick: (e) => { e.stopPropagation(); if (!joined)
                            onJoinDiscovered(room); }, disabled: joined }, joined ? "已加入" : "加入")));
            })))));
}

} };
__arModules["components/Settings"] = { loaded: false, exports: {}, factory: function (require, exports, module) {
"use strict";
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
exports.Settings = Settings;
/**
 * dsh-agent-room — Settings tab: room access settings (owner), cross-network
 * relay configuration (persisted on the host), bridge status, and danger zone.
 */
const React = __importStar(require("react"));
const theme_1 = require("../theme");
const common_1 = require("./common");
function Settings(props) {
    const { room, owned } = props;
    const bridge = (0, theme_1.bridgeLabel)(room.bridge);
    return (React.createElement("div", { style: { padding: "0 12px 10px", overflowY: "auto", maxHeight: "52vh" } },
        React.createElement("div", { style: { marginTop: 8, border: `1px solid ${theme_1.THEME.borderStrong}`, borderRadius: 10, padding: 10, background: "linear-gradient(135deg, rgba(34,211,238,.1), rgba(91,140,255,.08))" } },
            React.createElement(common_1.SectionTitle, { icon: "\uD83C\uDF10" }, "\u8DE8\u7F51\u4E2D\u7EE7\uFF08D7\uFF09"),
            React.createElement(common_1.Row, { style: { padding: "2px 0" } },
                React.createElement("input", { className: "ar-input", style: { flex: 1, padding: "7px 10px", fontSize: 13, fontFamily: theme_1.THEME.mono }, placeholder: "ws://relay-host:9320", value: props.relayInput, onChange: (e) => props.onRelayInput(e.target.value), onKeyDown: (e) => e.key === "Enter" && props.onSaveRelay() }),
                React.createElement(common_1.Btn, { variant: "primary", onClick: props.onSaveRelay, disabled: !props.relayInput.trim() }, "\u4FDD\u5B58"),
                React.createElement(common_1.Btn, { variant: "ghost", onClick: props.onClearRelay, disabled: !props.relayConfigured }, "\u6E05\u9664")),
            React.createElement("div", { style: { fontSize: 11, color: theme_1.THEME.faint, marginTop: 4, lineHeight: 1.6 } }, props.relayConfigured && props.relayAddress
                ? React.createElement(React.Fragment, null,
                    "\u5F53\u524D\u4E2D\u7EE7: ",
                    React.createElement("code", { style: { fontFamily: theme_1.THEME.mono } }, props.relayAddress),
                    " \u2014 \u672C\u673A\u623F\u95F4\u4F1A\u81EA\u52A8\u6865\u63A5\uFF0C\u8DE8\u7F51\u6210\u5458\u7ECF\u6B64\u52A0\u5165\uFF1B\u76F4\u8FDE\u4E0D\u53EF\u8FBE\u65F6\u4E5F\u8D70\u8FD9\u91CC\u3002")
                : "未配置中继：仅支持同网段直连加入。配置后，本机房间自动桥接到中继，跨网可达。"),
            owned && (React.createElement(common_1.Row, { style: { padding: "4px 0" } },
                React.createElement("span", { style: { fontSize: 12, color: theme_1.THEME.dim } }, "\u6865\u63A5\u72B6\u6001:"),
                React.createElement(common_1.Pill, { color: bridge.color, bg: bridge.color + "18" },
                    React.createElement(common_1.StatusDot, { color: bridge.color, pulse: bridge.state === "open" || bridge.state === "disconnected" || bridge.state === "connecting", size: 6 }),
                    bridge.text)))),
        owned && (React.createElement(React.Fragment, null,
            React.createElement("div", { style: { marginTop: 10, border: `1px solid ${theme_1.THEME.border}`, borderRadius: 10, padding: 10 } },
                React.createElement(common_1.SectionTitle, { icon: "\uD83D\uDD10" }, "\u51C6\u5165\u4E0E\u5224\u5B9A"),
                React.createElement(common_1.Row, { style: { padding: "3px 0" } },
                    React.createElement("span", { style: { fontSize: 12, color: theme_1.THEME.dim } }, "\u51C6\u5165\u6A21\u5F0F"),
                    React.createElement("select", { className: "ar-input", style: { width: "auto", padding: "5px 8px", fontSize: 12 }, value: room.authMode, onChange: (e) => props.onAuthMode(e.target.value) },
                        React.createElement("option", { value: "open" }, "\u516C\u5F00"),
                        React.createElement("option", { value: "password" }, "\u5BC6\u7801")),
                    React.createElement("span", { style: { flex: 1 } }),
                    React.createElement("label", { style: { fontSize: 12, color: theme_1.THEME.dim, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" } },
                        React.createElement("input", { type: "checkbox", checked: room.autoMode, onChange: (e) => props.onToggleAutoMode(e.target.checked) }),
                        "\u81EA\u6CBB\u6A21\u5F0F\uFF08agent \u81EA\u51B3\u5B8C\u6210\uFF09")),
                room.authMode === "password" && (React.createElement(common_1.Row, { style: { padding: "3px 0" } },
                    React.createElement("span", { style: { fontSize: 12, color: theme_1.THEME.dim } }, "\u65B0\u5BC6\u7801"),
                    React.createElement("input", { className: "ar-input", style: { flex: 1, padding: "5px 8px", fontSize: 12 }, placeholder: "\u7559\u7A7A\u5219\u4E0D\u4FEE\u6539", id: "ar-password" }),
                    React.createElement(common_1.Btn, { onClick: () => {
                            const el = document.getElementById("ar-password");
                            if (el?.value) {
                                props.onSetPassword(el.value);
                                el.value = "";
                            }
                        } }, "\u8BBE\u7F6E\u5BC6\u7801")))),
            React.createElement("div", { style: { marginTop: 10, border: `1px solid ${theme_1.THEME.border}`, borderRadius: 10, padding: 10 } },
                React.createElement(common_1.SectionTitle, { icon: "\uD83D\uDCE1" }, "\u5206\u4EAB\u5730\u5740"),
                React.createElement(common_1.Row, { style: { padding: "3px 0", flexWrap: "wrap" } },
                    React.createElement("code", { style: { fontSize: 12, fontFamily: theme_1.THEME.mono, color: theme_1.THEME.cyan, background: theme_1.THEME.cyanSoft, padding: "4px 8px", borderRadius: 6 } }, room.serverAddress ?? "（尚未启动房间服务器）"),
                    room.serverAddress && React.createElement(common_1.Btn, { size: "sm", onClick: () => props.onCopy(room.serverAddress) }, "\u590D\u5236")),
                props.nodeAddresses.length > 0 && (React.createElement(common_1.Row, { style: { padding: "3px 0", flexWrap: "wrap" } },
                    React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint } }, "\u5176\u4ED6\u53EF\u7528\u5730\u5740:"),
                    props.nodeAddresses.map((a) => (React.createElement("code", { key: a, style: { fontSize: 11, fontFamily: theme_1.THEME.mono, color: theme_1.THEME.dim, marginRight: 6 } }, a)))))),
            React.createElement("div", { style: { marginTop: 10, border: `1px solid rgba(248,113,113,.35)`, borderRadius: 10, padding: 10, background: theme_1.THEME.redSoft } },
                React.createElement(common_1.Row, { style: { padding: "3px 0" } },
                    React.createElement("span", { style: { flex: 1, fontSize: 12, color: theme_1.THEME.red } }, "\u5220\u9664\u623F\u95F4\uFF08\u804A\u5929\u4E0E\u4EFB\u52A1\u8BB0\u5F55\u4E00\u5E76\u5220\u9664\uFF0C\u4E0D\u53EF\u6062\u590D\uFF09"),
                    React.createElement(common_1.Btn, { variant: props.confirmDelete ? "danger" : "ghost", onClick: props.confirmDelete ? props.onDoDelete : props.onArmDelete }, props.confirmDelete ? "⚠ 再点一次确认删除" : "删除")))))));
}

} };
__arModules["components/TaskBoard"] = { loaded: false, exports: {}, factory: function (require, exports, module) {
"use strict";
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
exports.TaskBoard = TaskBoard;
/**
 * dsh-agent-room — TaskBoard: status filter + sort, candidate recommendation
 * (capabilities/roles match), acceptance criteria + handoff cards, and a
 * prompt-free task creation form.
 */
const React = __importStar(require("react"));
const theme_1 = require("../theme");
const common_1 = require("./common");
const STATUS_ORDER = { todo: 0, doing: 1, review: 2, done: 3, rejected: 4 };
/** Local candidate scoring: capability tags + workflow roles. */
function candidatesFor(task, members, limit = 3) {
    const needCaps = task.requiredCapabilities ?? [];
    const needRoles = task.requiredRoles ?? [];
    if (needCaps.length === 0 && needRoles.length === 0)
        return [];
    const ranked = members
        .map((member) => {
        const have = new Set([...(member.capabilities ?? []), ...(member.manualCapabilities ?? [])]);
        let score = 0;
        for (const c of needCaps)
            if (have.has(c))
                score += 1;
        let roleMatch = 0;
        for (const r of needRoles)
            if ((member.roles ?? []).includes(r))
                roleMatch += 1;
        return { member, score, roleMatch, total: roleMatch * 2 + score };
    })
        .filter((c) => c.total > 0)
        .sort((a, b) => b.total - a.total || b.score - a.score)
        .slice(0, limit);
    return ranked.map(({ member, score, roleMatch }) => ({ member, score, roleMatch }));
}
function TaskBoard(props) {
    const { room, localAgentId, filter, sort, search } = props;
    const q = search.trim().toLowerCase();
    let tasks = room.tasks.filter((t) => (filter === "all" ? true : t.status === filter));
    if (q) {
        tasks = tasks.filter((t) => t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q));
    }
    const sorted = [...tasks].sort((a, b) => {
        if (sort === "created")
            return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
        if (sort === "status")
            return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
        return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    });
    const FILTERS = [
        { key: "all", label: "全部" },
        { key: "todo", label: "待办" },
        { key: "doing", label: "进行中" },
        { key: "review", label: "复核中" },
        { key: "done", label: "已完成" },
        { key: "rejected", label: "已驳回" },
    ];
    return (React.createElement("div", { style: { display: "flex", flexDirection: "column", minHeight: 0 } },
        React.createElement("div", { style: { padding: "6px 12px", borderBottom: `1px solid ${theme_1.THEME.border}`, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            React.createElement("input", { className: "ar-input", style: { flex: 1, minWidth: 120, padding: "5px 9px", fontSize: 12 }, placeholder: "\u641C\u7D22\u4EFB\u52A1\uFF08\u6807\u9898 / \u63CF\u8FF0\uFF09", value: search, onChange: (e) => props.onSearchChange(e.target.value) }),
            React.createElement("select", { className: "ar-input", style: { padding: "5px 8px", fontSize: 12 }, value: sort, onChange: (e) => props.onSortChange(e.target.value), title: "\u6392\u5E8F" },
                React.createElement("option", { value: "updated" }, "\u6700\u8FD1\u66F4\u65B0"),
                React.createElement("option", { value: "created" }, "\u6700\u65B0\u521B\u5EFA"),
                React.createElement("option", { value: "status" }, "\u6309\u72B6\u6001")),
            React.createElement(common_1.Btn, { variant: props.showCreate ? "primary" : "ghost", onClick: props.onToggleCreate }, props.showCreate ? "收起" : "＋ 新建任务")),
        React.createElement("div", { style: { display: "flex", gap: 6, padding: "6px 12px", flexWrap: "wrap" } },
            FILTERS.map((f) => (React.createElement("button", { key: f.key, onClick: () => props.onFilterChange(f.key), style: {
                    fontSize: 12,
                    padding: "4px 10px",
                    borderRadius: 999,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    border: filter === f.key ? "1px solid rgba(91,140,255,.6)" : `1px solid ${theme_1.THEME.border}`,
                    background: filter === f.key ? theme_1.THEME.accentSoft : "transparent",
                    color: filter === f.key ? "#fff" : theme_1.THEME.dim,
                    transition: "all .15s ease",
                } }, f.label))),
            React.createElement("span", { style: { flex: 1 } }),
            React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint, alignSelf: "center" } },
                sorted.length,
                " \u6761")),
        props.showCreate && (React.createElement("div", { className: "ar-fade-in", style: { margin: "0 12px 8px", border: `1px solid ${theme_1.THEME.borderStrong}`, borderRadius: 10, padding: 10, background: theme_1.THEME.accentSoft } },
            React.createElement("div", { style: { display: "flex", gap: 8 } },
                React.createElement("input", { className: "ar-input", style: { flex: 1, padding: "7px 10px", fontSize: 13 }, placeholder: "\u4EFB\u52A1\u6807\u9898 *", value: props.newTitle, autoFocus: true, onChange: (e) => props.onNewTitle(e.target.value) })),
            React.createElement("input", { className: "ar-input", style: { width: "100%", marginTop: 6, padding: "6px 9px", fontSize: 12 }, placeholder: "\u63CF\u8FF0\uFF08\u53EF\u9009\uFF09", value: props.newDesc, onChange: (e) => props.onNewDesc(e.target.value) }),
            React.createElement("input", { className: "ar-input", style: { width: "100%", marginTop: 6, padding: "6px 9px", fontSize: 12 }, placeholder: "\u9A8C\u6536\u6807\u51C6\uFF08\u53EF\u9009\uFF09", value: props.newAcceptance, onChange: (e) => props.onNewAcceptance(e.target.value) }),
            React.createElement("div", { style: { display: "flex", gap: 14, marginTop: 8, alignItems: "center", flexWrap: "wrap" } },
                React.createElement("label", { style: { fontSize: 12, color: theme_1.THEME.dim, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" } },
                    "\u5224\u5B9A\uFF1A",
                    React.createElement("select", { className: "ar-input", style: { padding: "4px 6px", fontSize: 12 }, value: props.newJudge, onChange: (e) => props.onNewJudge(e.target.value) },
                        React.createElement("option", { value: "controller" }, "\u63A7\u5236\u4EBA\u5224\u5B9A"),
                        React.createElement("option", { value: "auto" }, "\u81EA\u6CBB\uFF08\u81EA\u51B3\u5B8C\u6210\uFF09"))),
                React.createElement("label", { style: { fontSize: 12, color: theme_1.THEME.dim, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" } },
                    React.createElement("input", { type: "checkbox", checked: props.newClaimable, onChange: (e) => props.onNewClaimable(e.target.checked) }),
                    " \u53EF\u8BA4\u9886"),
                React.createElement("span", { style: { flex: 1 } }),
                React.createElement(common_1.Btn, { variant: "primary", onClick: props.onCreateTask, disabled: !props.newTitle.trim() }, "\u521B\u5EFA\u4EFB\u52A1")))),
        React.createElement("div", { style: { flex: 1, overflowY: "auto", padding: "0 12px 10px", maxHeight: "46vh" } },
            sorted.map((task) => (React.createElement(TaskCard, { key: task.taskId, task: task, ...props }))),
            sorted.length === 0 && (React.createElement("div", { style: { padding: "18px 0", fontSize: 12, color: theme_1.THEME.faint, textAlign: "center" } }, "\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u4EFB\u52A1")))));
}
function TaskCard(props) {
    const { task, room, localAgentId } = props;
    const candidates = candidatesFor(task, room.members);
    const isController = localAgentId === room.controllerAgentId;
    const rejecting = props.rejecting === task.taskId;
    return (React.createElement("div", { className: "ar-card", style: { marginTop: 8, padding: 10 } },
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
            React.createElement("span", { style: { fontWeight: 700, fontSize: 14, color: theme_1.THEME.text } }, task.title),
            React.createElement(common_1.StatusBadge, { text: (0, theme_1.statusZh)(task.status), status: task.status }),
            React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint } },
                task.judge?.mode === "auto" ? "自治" : "控制人判定",
                " \u00B7 ",
                task.assignee ? `执行: ${task.assignee}` : task.claimable ? "可认领" : "未指派",
                " \u00B7 \u7531 ",
                task.createdBy.slice(0, 8),
                " \u521B\u5EFA"),
            React.createElement("span", { style: { flex: 1 } }),
            task.updatedAt && React.createElement("span", { style: { fontSize: 10, color: theme_1.THEME.faint } }, (0, theme_1.fmtDateTime)(task.updatedAt))),
        task.description && React.createElement("div", { style: { fontSize: 12, color: theme_1.THEME.dim, marginTop: 4, wordBreak: "break-word" } }, task.description),
        (task.requiredRoles?.length ?? 0) > 0 && (React.createElement("div", { style: { marginTop: 6, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" } },
            React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint } }, "\u6240\u9700\u89D2\u8272:"),
            (task.requiredRoles ?? []).map((r) => (React.createElement(common_1.Pill, { key: r, color: theme_1.ROLE_COLOR[r] ?? theme_1.THEME.accent }, theme_1.ROLE_ZH[r] ?? r))))),
        candidates.length > 0 && (React.createElement("div", { style: { marginTop: 6, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
            React.createElement("span", { style: { fontSize: 11, color: theme_1.THEME.faint } }, "\u2B50 \u5019\u9009\u4EBA:"),
            candidates.map((c) => (React.createElement(common_1.Pill, { key: c.member.agentId, color: theme_1.THEME.green, bg: theme_1.THEME.greenSoft, title: `能力匹配 ${c.score} · 角色匹配 ${c.roleMatch}` },
                c.member.nickname,
                React.createElement("span", { style: { opacity: 0.75 } },
                    "(",
                    c.score + c.roleMatch * 2,
                    ")")))))),
        task.acceptance && (React.createElement("div", { style: { marginTop: 6, fontSize: 12, borderLeft: `3px solid ${theme_1.THEME.amber}`, padding: "4px 8px", background: theme_1.THEME.amberSoft, borderRadius: "0 8px 8px 0" } },
            React.createElement("b", { style: { color: "#ffd27d" } }, "\u2713 \u9A8C\u6536\u6807\u51C6:"),
            " ",
            React.createElement("span", { style: { color: theme_1.THEME.dim } }, task.acceptance))),
        task.handoff && (React.createElement("div", { style: { marginTop: 6, fontSize: 12, borderLeft: `3px solid ${theme_1.THEME.cyan}`, padding: "6px 8px", background: theme_1.THEME.cyanSoft, borderRadius: "0 8px 8px 0" } },
            React.createElement("b", { style: { color: "#7deefd" } }, "\u21A6 \u4EA4\u63A5\u5361"),
            React.createElement("div", { style: { color: theme_1.THEME.dim, marginTop: 2 } },
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
                task.handoff.risk && React.createElement("div", { style: { color: "#ffd27d" } },
                    React.createElement("b", null, "\u98CE\u9669:"),
                    " ",
                    task.handoff.risk)))),
        React.createElement("div", { style: { marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" } },
            task.status === "todo" && task.claimable && (React.createElement(common_1.Btn, { variant: "success", onClick: () => props.onTaskAction("claim", task.taskId) }, "\u8BA4\u9886")),
            task.status === "todo" && (React.createElement(common_1.Btn, { onClick: () => props.onTaskAction("status", task.taskId, { status: "doing" }) }, "\u5F00\u59CB")),
            (task.status === "todo" || task.status === "doing") && (React.createElement(common_1.Btn, { variant: "primary", onClick: () => props.onTaskAction("complete", task.taskId, { note: "" }) }, task.judge?.mode === "auto" ? "确认完成" : "提交复核")),
            task.status === "review" && isController && (React.createElement(React.Fragment, null,
                React.createElement(common_1.Btn, { variant: "success", onClick: () => props.onTaskAction("approve", task.taskId, { note: "" }) }, "\u6279\u51C6"),
                React.createElement(common_1.Btn, { variant: rejecting ? "danger" : "ghost", onClick: () => (rejecting ? props.onDoReject(task.taskId) : props.onRejectToggle(task.taskId)) }, rejecting ? "确认驳回" : "驳回"))),
            rejecting && (React.createElement("input", { className: "ar-input", style: { width: 160, padding: "4px 8px", fontSize: 12 }, placeholder: "\u9A73\u56DE\u539F\u56E0", autoFocus: true, value: props.rejectNotes[task.taskId] ?? "", onChange: (e) => props.onRejectNote(task.taskId, e.target.value), onKeyDown: (e) => e.key === "Enter" && props.onDoReject(task.taskId) })),
            (task.status === "done" || task.status === "rejected") && (React.createElement(common_1.Btn, { onClick: () => props.onTaskAction("reopen", task.taskId) }, "\u91CD\u5F00")),
            React.createElement("span", { style: { flex: 1 } }),
            React.createElement(common_1.Btn, { variant: props.confirmDeleteTask === task.taskId ? "danger" : "ghost", onClick: () => (props.confirmDeleteTask === task.taskId ? props.onDoDeleteTask(task.taskId) : props.onArmDeleteTask(task.taskId)), title: "\u5220\u9664\u4EFB\u52A1" }, props.confirmDeleteTask === task.taskId ? "确认删除?" : "删除"))));
}

} };
__arModules["components/common"] = { loaded: false, exports: {}, factory: function (require, exports, module) {
"use strict";
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
exports.Pill = Pill;
exports.StatusBadge = StatusBadge;
exports.StatusDot = StatusDot;
exports.UnreadDot = UnreadDot;
exports.Btn = Btn;
exports.GradCard = GradCard;
exports.SectionTitle = SectionTitle;
exports.Row = Row;
/**
 * dsh-agent-room — shared UI atoms: pills, badges, status dots, buttons, cards.
 */
const React = __importStar(require("react"));
const theme_1 = require("../theme");
/* ----------------------------- primitives ----------------------------- */
function Pill({ children, color, bg, style, title }) {
    return (React.createElement("span", { title: title, style: {
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
        } }, children));
}
/** Colored status pill (task status / room status). */
function StatusBadge({ text, status }) {
    const color = (0, theme_1.badgeColor)(status);
    return React.createElement(Pill, { color: color, bg: color + "1f" }, text);
}
/** Breathing status dot. */
function StatusDot({ color, pulse, size = 8, title }) {
    return (React.createElement("span", { title: title, className: pulse ? (color === theme_1.THEME.red ? "ar-dot ar-dot-pulse-red" : "ar-dot ar-dot-pulse") : "ar-dot", style: { width: size, height: size, background: color, boxShadow: `0 0 6px ${color}` } }));
}
/** Unread count bubble. */
function UnreadDot({ count }) {
    if (!count)
        return null;
    return (React.createElement("span", { style: {
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
        } }, count > 99 ? "99+" : count));
}
function Btn({ variant = "ghost", size = "sm", style, children, ...rest }) {
    const base = { fontSize: size === "sm" ? 12 : 13, padding: size === "sm" ? "5px 10px" : "7px 14px" };
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
            base.color = theme_1.THEME.text;
            base.border = `1px solid ${theme_1.THEME.border}`;
    }
    return (React.createElement("button", { className: "ar-btn", style: { ...base, ...style }, ...rest }, children));
}
/* ----------------------------- layout ----------------------------- */
/** Card with a gradient border (glassmorphism + tech feel). */
function GradCard({ children, style, innerStyle, hover }) {
    return (React.createElement("div", { className: "ar-grad-border", style: { margin: "6px 10px", ...style } },
        React.createElement("div", { className: "ar-grad-inner" + (hover ? " ar-card" : ""), style: { padding: 10, ...innerStyle } }, children)));
}
function SectionTitle({ children, icon }) {
    return (React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: theme_1.THEME.text, padding: "8px 12px 4px" } },
        icon && React.createElement("span", { style: { fontSize: 14 } }, icon),
        children));
}
function Row({ children, style }) {
    return (React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", ...style } }, children));
}

} };
__arModules["theme"] = { loaded: false, exports: {}, factory: function (require, exports, module) {
"use strict";
/**
 * dsh-agent-room — unified deep-tech dark theme and shared visual vocabulary.
 * All components import THEME instead of scattering magic colors.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GLOBAL_CSS = exports.ROLE_COLOR = exports.ALL_ROLES = exports.ROLE_ZH = exports.THEME = void 0;
exports.badgeColor = badgeColor;
exports.statusZh = statusZh;
exports.bridgeLabel = bridgeLabel;
exports.fmtTime = fmtTime;
exports.fmtDateTime = fmtDateTime;
exports.THEME = {
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
};
/* ----------------------------- shared helpers ----------------------------- */
function badgeColor(status) {
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
function statusZh(status) {
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
function bridgeLabel(bridge) {
    if (!bridge)
        return { text: "未知", color: exports.THEME.dim, state: "unknown" };
    if (bridge.kind === "none")
        return { text: "未配置中继", color: exports.THEME.dim, state: "none" };
    if (bridge.kind === "relay") {
        switch (bridge.state) {
            case "open": return { text: "中继 · 已桥接", color: exports.THEME.cyan, state: bridge.state };
            case "connecting": return { text: "中继 · 连接中", color: exports.THEME.amber, state: bridge.state };
            case "disconnected": return { text: "中继 · 重连中", color: exports.THEME.amber, state: bridge.state };
            default: return { text: "中继", color: exports.THEME.cyan, state: bridge.state };
        }
    }
    switch (bridge.state) {
        case "open": return { text: "直连 · 在线", color: exports.THEME.green, state: bridge.state };
        case "reconnecting": return { text: "断线重连中", color: exports.THEME.amber, state: bridge.state };
        case "connecting": return { text: "连接中", color: exports.THEME.amber, state: bridge.state };
        case "closed": return { text: "已断开", color: exports.THEME.red, state: bridge.state };
        default: return { text: "直连", color: exports.THEME.green, state: bridge.state };
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
function fmtDateTime(iso) {
    if (!iso)
        return "";
    try {
        const d = new Date(iso);
        return d.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    }
    catch {
        return iso;
    }
}
exports.ROLE_ZH = {
    observer: "观察者",
    controller: "总控",
    researcher: "资料",
    executor: "执行",
    reviewer: "复核",
};
exports.ALL_ROLES = ["observer", "controller", "researcher", "executor", "reviewer"];
exports.ROLE_COLOR = {
    observer: "#8b93a7",
    controller: "#a78bfa",
    researcher: "#22d3ee",
    executor: "#5b8cff",
    reviewer: "#fbbf24",
};
/** Global CSS injected once: animations, scrollbars, focus rings. */
exports.GLOBAL_CSS = `
  .ar-root * { box-sizing: border-box; }
  .ar-root { font-family: ${exports.THEME.font}; }
  .ar-root ::-webkit-scrollbar { width: 8px; height: 8px; }
  .ar-root ::-webkit-scrollbar-thumb { background: rgba(120,150,255,.28); border-radius: 8px; }
  .ar-root ::-webkit-scrollbar-thumb:hover { background: rgba(120,150,255,.5); }
  .ar-root ::-webkit-scrollbar-track { background: transparent; }
  .ar-grad-border {
    position: relative;
    background: linear-gradient(135deg, rgba(91,140,255,.55), rgba(34,211,238,.28) 45%, rgba(167,139,250,.4));
    padding: 1px;
    border-radius: ${exports.THEME.radius}px;
  }
  .ar-grad-border > .ar-grad-inner {
    background: ${exports.THEME.panel};
    border-radius: calc(${exports.THEME.radius}px - 1px);
    height: 100%;
  }
  .ar-card {
    background: ${exports.THEME.card};
    border: 1px solid ${exports.THEME.border};
    border-radius: ${exports.THEME.radius}px;
    transition: border-color .2s ease, transform .2s ease, box-shadow .2s ease;
  }
  .ar-card:hover { border-color: ${exports.THEME.borderStrong}; box-shadow: ${exports.THEME.glow}; }
  .ar-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    border: 1px solid transparent; border-radius: ${exports.THEME.radiusSm}px;
    font-family: inherit; cursor: pointer; user-select: none;
    transition: transform .12s ease, filter .12s ease, box-shadow .18s ease, background .15s ease, border-color .15s ease;
    white-space: nowrap;
  }
  .ar-btn:hover { filter: brightness(1.15); transform: translateY(-1px); }
  .ar-btn:active { transform: scale(.95); }
  .ar-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
  .ar-input {
    font-family: inherit; color: ${exports.THEME.text};
    background: ${exports.THEME.input}; border: 1px solid ${exports.THEME.border};
    border-radius: ${exports.THEME.radiusSm}px; outline: none;
    transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
  }
  .ar-input:focus { border-color: ${exports.THEME.accent}; box-shadow: 0 0 0 3px rgba(91,140,255,.18); background: ${exports.THEME.inputFocus}; }
  .ar-input::placeholder { color: ${exports.THEME.faint}; }
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
  .ar-tabbtn { border: none; background: transparent; font-family: inherit; cursor: pointer; color: ${exports.THEME.dim}; transition: color .15s ease, background .15s ease; border-radius: 8px 8px 0 0; }
  .ar-tabbtn:hover { color: ${exports.THEME.text}; background: rgba(91,140,255,.08); }
  .ar-fade-in { animation: ar-fade .25s ease; }
  @keyframes ar-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  .ar-panel { backdrop-filter: blur(18px) saturate(1.25); -webkit-backdrop-filter: blur(18px) saturate(1.25); }
`;

} };
module.exports = __arRequire('index', './index');
    return module.exports;
  }
});
