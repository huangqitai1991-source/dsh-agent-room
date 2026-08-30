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

import * as React from "react";
import {
  activateChatApi, api, friendlyError, messagesApi, relayConfigApi, stateApi, subscribeEvents,
  type ApiMessage, type ApiRoom, type ApiTask, type RoomState,
} from "./api";
import { GLOBAL_CSS, THEME, bridgeLabel } from "./theme";
import { Btn, Pill, StatusDot, UnreadDot } from "./components/common";
import { RoomList, type RoomListProps } from "./components/RoomList";
import { Chat } from "./components/Chat";
import { TaskBoard, type TaskFilter, type TaskSort } from "./components/TaskBoard";
import { Members } from "./components/Members";
import { Settings } from "./components/Settings";

/* ----------------------------- dock component -------------------------- */

function RoomDock(): React.ReactElement {
  const [state, setState] = React.useState<RoomState | null>(null);
  const [activeRoomId, setActiveRoomId] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<"chat" | "tasks" | "members" | "settings">("chat");
  const [messages, setMessages] = React.useState<ApiMessage[]>([]);
  const [hasOlder, setHasOlder] = React.useState(false);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [takeover, setTakeover] = React.useState(false);
  /** Optimistic activate-thinking flags per room (server state is the source of truth). */
  const [thinkingRooms, setThinkingRooms] = React.useState<Record<string, boolean>>({});
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [joining, setJoining] = React.useState(false);
  const [createTitle, setCreateTitle] = React.useState("");
  const [createType, setCreateType] = React.useState<"persistent" | "temporary">("persistent");
  const [joinAddr, setJoinAddr] = React.useState("");
  const [joinPassword, setJoinPassword] = React.useState("");
  /** roomId hint carried from the LAN-discovered list into the join panel. */
  const [joinRoomId, setJoinRoomId] = React.useState<string | null>(null);
  const [unread, setUnread] = React.useState<Record<string, number>>({});
  const [chatSearch, setChatSearch] = React.useState("");
  const [taskSearch, setTaskSearch] = React.useState("");
  const [taskFilter, setTaskFilter] = React.useState<TaskFilter>("all");
  const [taskSort, setTaskSort] = React.useState<TaskSort>("updated");
  const [showCreate, setShowCreate] = React.useState(false);
  const [newTitle, setNewTitle] = React.useState("");
  const [newDesc, setNewDesc] = React.useState("");
  const [newAcceptance, setNewAcceptance] = React.useState("");
  const [newJudge, setNewJudge] = React.useState<"controller" | "auto">("controller");
  const [newClaimable, setNewClaimable] = React.useState(true);
  const [capsInput, setCapsInput] = React.useState("");
  const [relayInput, setRelayInput] = React.useState("");
  const [rejecting, setRejecting] = React.useState<string | null>(null);
  const [rejectNotes, setRejectNotes] = React.useState<Record<string, string>>({});
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
  const refreshTimer = React.useRef<number | null>(null);
  /** Highest message seq already counted for unread purposes, per room. */
  const countedSeqRef = React.useRef<Record<string, number>>({});
  /** Last known assignee per task (for task-assigned notifications). */
  const knownAssigneeRef = React.useRef<Record<string, string | undefined>>({});
  const activeRoomIdRef = React.useRef<string | null>(null);
  const tabRef = React.useRef(tab);
  const stateRef = React.useRef<RoomState | null>(null);
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
  const armConfirm = (kind: "delete" | "leave", roomId?: string) => {
    setConfirmDelete(kind === "delete");
    setConfirmKickAgent(null);
    setConfirmLeaveRoom(kind === "leave" ? roomId ?? null : null);
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
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
    if (openTimer.current === null) openTimer.current = window.setTimeout(() => { openTimer.current = null; setOpen(true); }, 100);
  };

  const scheduleClose = () => {
    if (pinned) return;
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current === null) closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setOpen(false); }, 260);
  };

  React.useEffect(
    () => () => {
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    },
    [],
  );

  // Global tech theme injected once.
  React.useEffect(() => {
    if (document.getElementById("ar-theme-css")) return;
    const style = document.createElement("style");
    style.id = "ar-theme-css";
    style.textContent = GLOBAL_CSS;
    document.head.appendChild(style);
  }, []);

  /* ----------------------------- data flow ------------------------------ */

  const refreshState = (thenSelectRoomId?: string) => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      stateApi()
        .then((s) => {
          setState(s);
          setError(null);
          if (thenSelectRoomId) {
            setActiveRoomId(thenSelectRoomId);
            setTab("chat");
          }
        })
        .catch((err: Error) => setError(err.message));
    }, 250);
  };

  // System notification (mention / task assignment).
  const notify = (title: string, body: string) => {
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(title, { body, tag: "agent-room" });
      }
    } catch {
      /* notifications are best-effort */
    }
  };

  const requestNotifPermission = () => {
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission();
      }
    } catch {
      /* ignore */
    }
  };

  const mentionsMe = (message: ApiMessage): boolean => {
    const me = stateRef.current?.identity;
    if (!me) return false;
    if (Array.isArray(message.mentions) && message.mentions.includes(me.agentId)) return true;
    return message.text.includes("@" + me.agentId) || message.text.includes("@" + me.nickname);
  };

  /** A pushed chat message arrived for some room. */
  const handlePushMessage = (roomId: string, message: ApiMessage) => {
    const me = stateRef.current?.identity;
    if (me && message.from === me.agentId) return;
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
      stateApi()
        .then((s) => {
          if (!alive) return;
          setState(s);
          setError(null);
          const me = s.identity.agentId;
          setRelayInput((prev) => prev || (s.relay?.address ?? ""));
          // Unread: count new messages since the last counted seq.
          setUnread((prev) => {
            const next: Record<string, number> = { ...prev };
            for (const room of s.rooms) {
              const latest = room.latestSeq ?? 0;
              const counted = countedSeqRef.current[room.roomId] ?? 0;
              if (latest <= counted) continue;
              if (!baselineRef.current) {
                // Baseline: existing history is not "unread".
                countedSeqRef.current[room.roomId] = latest;
                continue;
              }
              countedSeqRef.current[room.roomId] = latest;
              if (room.roomId === activeRoomIdRef.current && tabRef.current === "chat") continue;
              next[room.roomId] = (next[room.roomId] ?? 0) + Math.min(latest - counted, 50);
            }
            return next;
          });
          baselineRef.current = true;
          // Drop optimistic thinking flags once the server confirms the reply
          // landed (activateThinking back to false) — button becomes clickable.
          setThinkingRooms((prev) => {
            if (Object.keys(prev).length === 0) return prev;
            const next = { ...prev };
            for (const room of s.rooms) {
              if (!room.activateThinking && next[room.roomId]) delete next[room.roomId];
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
        .catch((err: Error) => alive && setError(err.message));
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
    if (!activeRoomId) return;
    let alive = true;
    const tick = () => {
      messagesApi(activeRoomId)
        .then((d) => {
          if (!alive) return;
          setMessages(d.messages);
          setHasOlder(d.messages.length >= 200);
          const maxSeq = d.messages.reduce((max, m) => Math.max(max, m.seq), 0);
          countedSeqRef.current[activeRoomId] = Math.max(countedSeqRef.current[activeRoomId] ?? 0, maxSeq);
          setUnread((prev) => ({ ...prev, [activeRoomId]: 0 }));
        })
        .catch(() => {});
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
    const unsub = subscribeEvents((event) => {
      if (event.kind === "chat" && typeof event.roomId === "string" && event.message) {
        handlePushMessage(event.roomId, event.message as ApiMessage);
      }
      debouncedRefresh();
    });
    return unsub;
  }, []);

  const debouncedRefresh = () => refreshState();

  // Auto-scroll the chat stream.
  React.useEffect(() => {
    const el = chatScrollRef.current;
    if (el && (atBottomRef.current || justSentRef.current)) el.scrollTop = el.scrollHeight;
    if (justSentRef.current) justSentRef.current = false;
  }, [messages, tab]);

  const onChatScroll = () => {
    const el = chatScrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
  };
  const loadOlder = () => {
    if (!activeRoomId || loadingOlder) return;
    const oldest = messages[0]?.seq;
    if (oldest === undefined) return;
    setLoadingOlder(true);
    void messagesApi(activeRoomId, oldest)
      .then((d) => {
        if (d.messages.length > 0) {
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.seq));
            const older = d.messages.filter((m) => !seen.has(m.seq));
            return [...older, ...prev];
          });
          setHasOlder(d.messages.length >= 200);
        } else {
          setHasOlder(false);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingOlder(false));
  };

  /* ----------------------------- derived -------------------------------- */

  const activeRoom = state?.rooms.find((r) => r.roomId === activeRoomId) ?? null;
  const localAgentId = state?.identity.agentId ?? "";
  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);

  /** Always sends POST (empty body when none given) — GET would 404 action routes. */
  const post = async (path: string, body?: unknown): Promise<void> => {
    try {
      await api(path, body ?? {});
      setError(null);
    } catch (err) {
      setError(friendlyError((err as Error).message));
      throw err;
    }
  };

  const copyText = (text: string) => {
    const done = () => setError(null);
    const fail = () => setError("复制失败，请手动复制");
    try {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).then(done, fail);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done();
      }
    } catch {
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
        window.setTimeout(() => stateApi().then(setState).catch(() => {}), 600);
      })
      .catch(() => {});
  };

  const joinRoom = () => {
    const address = joinAddr.trim();
    if (!address) {
      setError("请输入 host:port 或 relay:// 地址");
      return;
    }
    void api<{ roomId: string }>("/agent-room-api/join", {
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
      .catch((err: Error) => setError(friendlyError(err.message)));
  };

  const joinDiscovered = (room: { roomId: string; title: string; authMode: string; addresses: string[] }) => {
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
    void api<{ roomId: string }>("/agent-room-api/join", { addresses: room.addresses, roomId: room.roomId })
      .then((d) => refreshState(d.roomId))
      .catch((err: Error) => setError(friendlyError(err.message)));
  };

  const sendChat = (human: boolean) => {
    if (!activeRoom || !text.trim()) return;
    const roomId = activeRoom.roomId;
    const content = text.trim();
    const identity = state?.identity;
    const optimistic: ApiMessage = {
      seq: -Date.now(),
      from: identity?.agentId ?? "me",
      fromNickname: identity?.nickname ?? "我",
      ts: new Date().toISOString(),
      text: content,
      human,
    };
    setText("");
    setMessages((prev) => [...prev, optimistic]);
    justSentRef.current = true;
    void api(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/chat`, { text: content, human })
      .then(() => messagesApi(roomId).then((d) => setMessages(d.messages)).catch(() => {}))
      .catch((err: Error) => {
        setMessages((prev) => prev.filter((m) => m.seq !== optimistic.seq));
        setError(friendlyError(err.message));
        // 发送失败时把原文放回输入框，方便重试（仅当输入框还是空的）。
        setText((cur) => cur || content);
      });
  };

  /** Optimistic task mutation + POST; on failure the next state poll restores truth. */
  const taskAction = (action: string, taskId: string, body?: Record<string, unknown>) => {
    if (!activeRoom) return;
    const roomId = activeRoom.roomId;
    const patch = (t: ApiTask): ApiTask => {
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
      if (!prev) return prev;
      return {
        ...prev,
        rooms: prev.rooms.map((r) =>
          r.roomId === roomId ? { ...r, tasks: r.tasks.map((t) => (t.taskId === taskId ? patch(t) : t)) } : r,
        ),
      };
    });
    void post(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}/${action}`, body)
      .then(() => window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300))
      .catch(() => window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300));
  };
  const createTask = () => {
    if (!activeRoom || !newTitle.trim()) return;
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
        window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300);
      })
      .catch(() => {});
  };

  const doReject = (taskId: string) => {
    const note = (rejectNotes[taskId] ?? "").trim();
    if (!note) {
      setError("请填写驳回原因");
      return;
    }
    setRejecting(null);
    taskAction("reject", taskId, { note });
  };

  const setRelay = () => {
    void relayConfigApi
      .set(relayInput.trim() || undefined)
      .then(() => refreshState())
      .catch((err: Error) => setError(err.message));
  };

  const clearRelay = () => {
    void relayConfigApi
      .set(undefined)
      .then(() => {
        setRelayInput("");
        refreshState();
      })
      .catch((err: Error) => setError(err.message));
  };

  const doDeleteRoom = () => {
    if (!activeRoom) return;
    setConfirmDelete(false);
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/delete`)
      .then(() => {
        setActiveRoomId(null);
        window.setTimeout(() => stateApi().then(setState).catch(() => {}), 400);
      })
      .catch(() => {});
  };

  const doLeaveRoom = () => {
    const roomId = confirmLeaveRoom ?? activeRoom?.roomId;
    if (!roomId) return;
    setConfirmLeaveRoom(null);
    void post(`/agent-room-api/rooms/${encodeURIComponent(roomId)}/leave`)
      .then(() => {
        if (activeRoomId === roomId) setActiveRoomId(null);
        window.setTimeout(() => stateApi().then(setState).catch(() => {}), 400);
      })
      .catch(() => {});
  };

  const armKick = (agentId: string) => {
    setConfirmDelete(false);
    setConfirmLeaveRoom(null);
    setConfirmKickAgent(agentId);
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => { confirmTimer.current = null; resetConfirms(); }, 4000);
  };

  const doKickMember = (member: { agentId: string }) => {
    if (!activeRoom) return;
    setConfirmKickAgent(null);
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(member.agentId)}/kick`)
      .then(() => window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300))
      .catch(() => {});
  };
  const armRevoke = (agentId: string) => {
    setConfirmDelete(false);
    setConfirmLeaveRoom(null);
    setConfirmKickAgent(null);
    setConfirmDeleteTask(null);
    setConfirmUnrevokeAgent(null);
    setConfirmRevokeAgent(agentId);
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => { confirmTimer.current = null; resetConfirms(); }, 4000);
  };

  const doRevokeMember = (member: { agentId: string }) => {
    if (!activeRoom) return;
    setConfirmRevokeAgent(null);
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(member.agentId)}/revoke`)
      .then(() => window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300))
      .catch(() => {});
  };

  const armUnrevoke = (agentId: string) => {
    setConfirmDelete(false);
    setConfirmLeaveRoom(null);
    setConfirmKickAgent(null);
    setConfirmDeleteTask(null);
    setConfirmRevokeAgent(null);
    setConfirmUnrevokeAgent(agentId);
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => { confirmTimer.current = null; resetConfirms(); }, 4000);
  };

  const doUnrevokeMember = (agentId: string) => {
    if (!activeRoom) return;
    setConfirmUnrevokeAgent(null);
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(agentId)}/unrevoke`)
      .then(() => window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300))
      .catch(() => {});
  };

  const armDeleteTask = (taskId: string) => {
    setConfirmDeleteTask(taskId);
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => { confirmTimer.current = null; resetConfirms(); }, 4000);
  };

  const doDeleteTask = (taskId: string) => {
    if (!activeRoom) return;
    setConfirmDeleteTask(null);
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/tasks/${encodeURIComponent(taskId)}/remove`)
      .then(() => window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300))
      .catch(() => {});
  };

  const assignRole = (member: { agentId: string }, role: string) => {
    if (!activeRoom) return;
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/members/${encodeURIComponent(member.agentId)}/roles`, { roles: [role] })
      .then(() => window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300))
      .catch(() => {});
  };

  const setMyRole = (role: string) => {
    if (!activeRoom) return;
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/member-roles`, { roles: [role] })
      .then(() => window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300))
      .catch(() => {});
  };

  const saveMyCaps = () => {
    if (!activeRoom) return;
    const tags = capsInput.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/member-capabilities`, { capabilities: tags })
      .then(() => {
        setCapsInput("");
        window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300);
      })
      .catch(() => {});
  };
  /** 激活聊天: one-shot — button flips to 思考中 immediately, server state
   *  (poll + SSE) restores it once our own reply lands. */
  const activateChat = () => {
    if (!activeRoom) return;
    const roomId = activeRoom.roomId;
    setThinkingRooms((prev) => ({ ...prev, [roomId]: true }));
    void activateChatApi(roomId)
      .then(() => refreshState())
      .catch((err: Error) => {
        setThinkingRooms((prev) => {
          const next = { ...prev };
          delete next[roomId];
          return next;
        });
        setError(friendlyError(err.message));
      });
  };

  /** Effective thinking state: optimistic flag wins until the server confirms. */
  const roomThinking = (roomId: string): boolean =>
    thinkingRooms[roomId] ?? Boolean(state?.rooms.find((r) => r.roomId === roomId)?.activateThinking);

  const selectRoom = (roomId: string) => {
    setActiveRoomId(roomId);
    setTab("chat");
    setUnread((prev) => ({ ...prev, [roomId]: 0 }));
    const room = state?.rooms.find((r) => r.roomId === roomId);
    if (room?.latestSeq) countedSeqRef.current[roomId] = Math.max(countedSeqRef.current[roomId] ?? 0, room.latestSeq);
    const maxMsg = messages.reduce((max, m) => Math.max(max, m.seq), 0);
    if (maxMsg > 0) countedSeqRef.current[roomId] = Math.max(countedSeqRef.current[roomId] ?? 0, maxMsg);
    setChatSearch("");
  };
  /* ----------------------------- render --------------------------------- */

  const roomListProps: RoomListProps = {
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

  const bridge = activeRoom ? bridgeLabel(activeRoom.bridge) : null;

  return (
    <div
      className="ar-root"
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      <button
        className="ar-tab"
        onClick={() => {
          requestNotifPermission();
          setPinned((p) => !p);
          setOpen(true);
        }}
        style={{
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
        }}
        title={pinned ? "Agent 房间（已固定，点击取消固定）" : "Agent 房间（悬停展开；点击固定）"}
      >
        <span style={{ fontSize: 16 }}>🤖</span>
        <span>Agent 房间{state ? ` · ${state.rooms.length}` : ""}</span>
        {pinned && <span style={{ fontSize: 12, opacity: 0.8 }}>📌</span>}
        {totalUnread > 0 && <UnreadDot count={totalUnread} />}
      </button>
      <div
        className="ar-panel"
        style={{
          position: "absolute",
          top: "calc(100% + 10px)",
          right: 0,
          width: pinned ? 740 : 620,
          maxWidth: "min(96vw, 740px)",
          background: THEME.panel,
          border: "1px solid rgba(120,150,255,.4)",
          borderRadius: 16,
          boxShadow: "0 20px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(120,150,255,.14), 0 0 32px rgba(91,140,255,.22)",
          zIndex: 9999,
          overflow: "hidden",
          fontSize: 14,
          color: THEME.text,
          maxHeight: pinned ? "82vh" : "76vh",
          opacity: open ? 1 : 0,
          transform: open ? "translateY(0) scale(1)" : "translateY(-10px) scale(.985)",
          pointerEvents: open ? "auto" : "none",
          transition: "max-height .28s ease, opacity .2s ease, transform .26s ease, width .2s ease",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: `1px solid ${THEME.border}`, flexShrink: 0 }}>
          <span style={{ fontSize: 17 }}>🤖</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: 0.2 }}>Agent 房间</div>
            <div style={{ fontSize: 12, color: THEME.faint, fontWeight: 400 }}>
              {state ? `${state.identity.nickname} · ${state.rooms.length} 个房间` : "…"}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          {state?.node?.hostname && (
            <span style={{ fontSize: 11, color: THEME.faint, fontFamily: THEME.mono }}>{state.node.hostname}</span>
          )}
          <Btn variant={pinned ? "primary" : "ghost"} size="sm" onClick={() => setPinned((p) => !p)} title="固定面板">
            {pinned ? "已固定" : "固定"}
          </Btn>
        </div>
        {error && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", background: THEME.redSoft, color: THEME.red, fontSize: 12, borderBottom: "1px solid rgba(248,113,113,.35)", flexShrink: 0 }}>
            <span style={{ flex: 1 }}>⚠ {error}</span>
            <button onClick={() => setError(null)} style={{ background: "none", border: "none", color: THEME.red, cursor: "pointer", fontSize: 14 }}>✕</button>
          </div>
        )}
        {takeover && (
          <div style={{ padding: "5px 14px", background: THEME.amberSoft, color: "#ffd27d", fontSize: 12, borderBottom: "1px solid rgba(251,191,36,.35)", flexShrink: 0 }}>
            👤 人类接管模式：你的消息将以人类身份发送
          </div>
        )}

        <div style={{ overflowY: "auto", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <RoomList {...roomListProps} />
          {activeRoom && (
            <React.Fragment key={activeRoom.roomId}>
              {/* room header strip */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", borderTop: `1px solid ${THEME.border}`, borderBottom: `1px solid ${THEME.border}`, background: THEME.card }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: THEME.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
                  {activeRoom.type === "temporary" ? "⚡" : "📁"} {activeRoom.title}
                </span>
                <span style={{ fontSize: 11, color: THEME.faint }}>{activeRoom.memberCount}人</span>
                {bridge && (
                  <Pill color={bridge.color} bg={bridge.color + "18"}>
                    <StatusDot color={bridge.color} pulse={bridge.state === "open" || bridge.state === "reconnecting" || bridge.state === "disconnected"} size={6} />
                    {bridge.text}
                  </Pill>
                )}
                <span style={{ flex: 1 }} />
                {activeRoom.owned && activeRoom.serverAddress && (
                  <span
                    onClick={() => copyText(activeRoom.serverAddress ?? "")}
                    title="点击复制分享地址"
                    style={{ fontSize: 10, fontFamily: THEME.mono, color: THEME.faint, cursor: "pointer", border: `1px dashed ${THEME.border}`, borderRadius: 6, padding: "2px 5px" }}
                  >
                    {activeRoom.serverAddress}
                  </span>
                )}
                {roomThinking(activeRoom.roomId) && <Pill color={THEME.amber} bg={THEME.amberSoft}>⏳ 思考中</Pill>}
              </div>

              {/* tabs */}
              <div style={{ display: "flex", gap: 2, padding: "6px 12px 0", borderBottom: `1px solid ${THEME.border}`, flexShrink: 0 }}>
                {([
                  ["chat", "聊天", unread[activeRoom.roomId] ?? 0],
                  ["tasks", "任务", 0],
                  ["members", "成员", 0],
                  ["settings", "设置", 0],
                ] as const).map(([key, label, badge]) => (
                  <button
                    key={key}
                    className="ar-tabbtn"
                    onClick={() => setTab(key)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "7px 14px",
                      fontSize: 13,
                      fontWeight: tab === key ? 700 : 500,
                      color: tab === key ? "#fff" : THEME.dim,
                      background: tab === key ? "linear-gradient(180deg, rgba(91,140,255,.22), transparent)" : "transparent",
                      borderBottom: tab === key ? `2px solid ${THEME.accent}` : "2px solid transparent",
                    }}
                  >
                    {key === "chat" ? "💬" : key === "tasks" ? "📋" : key === "members" ? "👥" : "⚙️"} {label}
                    {badge > 0 && <UnreadDot count={badge} />}
                  </button>
                ))}
              </div>
              {/* tab body */}
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                {tab === "chat" && (
                  <Chat
                    room={activeRoom}
                    messages={messages}
                    text={text}
                    takeOver={takeover}
                    thinking={roomThinking(activeRoom.roomId)}
                    search={chatSearch}
                    loadingOlder={loadingOlder}
                    hasOlder={hasOlder}
                    scrollRef={chatScrollRef}
                    onScroll={onChatScroll}
                    onTextChange={setText}
                    onSend={() => sendChat(false)}
                    onSendHuman={() => sendChat(true)}
                    onToggleTakeover={() => setTakeover((v) => !v)}
                    onActivateChat={activateChat}
                    onLoadOlder={loadOlder}
                    onSearchChange={setChatSearch}
                  />
                )}
                {tab === "tasks" && (
                  <TaskBoard
                    room={activeRoom}
                    localAgentId={localAgentId}
                    search={taskSearch}
                    filter={taskFilter}
                    sort={taskSort}
                    showCreate={showCreate}
                    newTitle={newTitle}
                    newDesc={newDesc}
                    newAcceptance={newAcceptance}
                    newJudge={newJudge}
                    newClaimable={newClaimable}
                    confirmDeleteTask={confirmDeleteTask}
                    rejecting={rejecting}
                    rejectNotes={rejectNotes}
                    onSearchChange={setTaskSearch}
                    onFilterChange={setTaskFilter}
                    onSortChange={setTaskSort}
                    onToggleCreate={() => setShowCreate((v) => !v)}
                    onNewTitle={setNewTitle}
                    onNewDesc={setNewDesc}
                    onNewAcceptance={setNewAcceptance}
                    onNewJudge={setNewJudge}
                    onNewClaimable={setNewClaimable}
                    onCreateTask={createTask}
                    onTaskAction={taskAction}
                    onArmDeleteTask={armDeleteTask}
                    onDoDeleteTask={doDeleteTask}
                    onRejectToggle={(taskId) => setRejecting((cur) => (cur === taskId ? null : taskId))}
                    onRejectNote={(taskId, v) => setRejectNotes((prev) => ({ ...prev, [taskId]: v }))}
                    onDoReject={doReject}
                  />
                )}
                {tab === "members" && (
                  <Members
                    room={activeRoom}
                    localAgentId={localAgentId}
                    takeOver={takeover}
                    capsInput={capsInput}
                    leaveConfirm={confirmLeaveRoom}
                    confirmKick={confirmKickAgent}
                    confirmRevoke={confirmRevokeAgent}
                    confirmUnrevoke={confirmUnrevokeAgent}
                    onCapsInput={setCapsInput}
                    onSaveCaps={saveMyCaps}
                    onToggleTakeover={() => setTakeover((v) => !v)}
                    onAssignRole={assignRole}
                    onSetMyRole={setMyRole}
                    onArmKick={armKick}
                    onDoKick={doKickMember}
                    onArmRevoke={armRevoke}
                    onDoRevoke={doRevokeMember}
                    onArmUnrevoke={armUnrevoke}
                    onDoUnrevoke={doUnrevokeMember}
                    onArmLeave={() => armConfirm("leave", activeRoom.roomId)}
                    onDoLeave={doLeaveRoom}
                  />
                )}
                {tab === "settings" && (
                  <Settings
                    room={activeRoom}
                    owned={activeRoom.owned}
                    relayAddress={state?.relay?.address}
                    relayConfigured={Boolean(state?.relay?.configured)}
                    relayInput={relayInput}
                    nodeAddresses={state?.node?.addresses ?? []}
                    confirmDelete={confirmDelete}
                    onRelayInput={setRelayInput}
                    onSaveRelay={setRelay}
                    onClearRelay={clearRelay}
                    onAuthMode={(mode) => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/settings`, { authMode: mode }).then(() => window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300))}
                    onSetPassword={(pw) => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/settings`, { password: pw }).then(() => window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300))}
                    onToggleAutoMode={(v) => void post(`/agent-room-api/rooms/${encodeURIComponent(activeRoom.roomId)}/settings`, { autoMode: v }).then(() => window.setTimeout(() => stateApi().then(setState).catch(() => {}), 300))}
                    onCopy={copyText}
                    onArmDelete={() => armConfirm("delete")}
                    onDoDelete={doDeleteRoom}
                  />
                )}
              </div>
            </React.Fragment>
          )}

          {!activeRoom && (
            <div style={{ padding: "18px 14px", fontSize: 13, color: THEME.faint, textAlign: "center" }}>
              选择或创建一个房间开始协作
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- registration ---------------------------- */

const NS = "agent-room";

const zh = { title: "Agent 房间" };
const en = { title: "Agent Rooms" };

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

export { apply, inject };