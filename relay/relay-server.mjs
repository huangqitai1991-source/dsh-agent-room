/**
 * dsh-agent-room — 跨网中继服务器 (relay)。
 *
 * 一个「哑管道」：只按 roomId + 角色转发 WebSocket 帧，不做鉴权、不存房间状态。
 * 房间的权威(成员名单/任务/判定/令牌校验)始终在房主节点，中继只是一个传话筒。
 *
 * 运行 (需 Node >=22 + ws 包):
 *   node relay-server.mjs [port]        # 默认 9320, 也可用环境变量 RELAY_PORT
 *
 * 连接方式:
 *   ws://<host>:<port>/relay?roomId=<id>&role=owner|member&agentId=<agentId>
 *
 * 路由规则:
 *   - member -> relay -> owner:  包装为 {"type":"relay.frame","from":agentId,"frame":<原始帧>}
 *   - owner -> relay -> members: 原始 ServerFrame 原样广播给该房间所有 member
 *   - owner 定向:  {"type":"relay.send","to":agentId,"frame":<帧>} 只发给指定 member
 *
 * 无状态: 进程重启不丢任何东西(房间状态在房主), 重连即可恢复。
 */

import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.argv[2] ?? process.env.RELAY_PORT ?? 9320);

/** roomId -> { owner: ws|null, members: Map<agentId, ws> } */
const rooms = new Map();

const wss = new WebSocketServer({ port });
console.log(`[relay] listening on :${port} (ws://host:${port}/relay?roomId=&role=&agentId=)`);

wss.on("connection", (socket, req) => {
  let url;
  try {
    url = new URL(req.url ?? "/", "http://relay.local");
  } catch {
    socket.close(4000, "bad url");
    return;
  }
  if (url.pathname !== "/relay") {
    socket.close(4000, "bad path");
    return;
  }
  const roomId = url.searchParams.get("roomId");
  const role = url.searchParams.get("role");
  const agentId = url.searchParams.get("agentId");
  if (!roomId || !role || !agentId) {
    socket.close(4000, "missing roomId/role/agentId");
    return;
  }

  let room = rooms.get(roomId);
  if (!room) {
    room = { owner: null, members: new Map() };
    rooms.set(roomId, room);
  }

  if (role === "owner") {
    if (room.owner && room.owner !== socket) {
      try { room.owner.close(4001, "owner replaced"); } catch { /* ignore */ }
    }
    room.owner = socket;
  } else if (role === "member") {
    const prev = room.members.get(agentId);
    if (prev && prev !== socket) {
      try { prev.close(4001, "member replaced"); } catch { /* ignore */ }
    }
    room.members.set(agentId, socket);
  } else {
    socket.close(4000, "bad role");
    return;
  }

  socket.on("message", (data) => {
    const raw = String(data);
    if (role === "member") {
      const owner = room.owner;
      if (owner && owner.readyState === WebSocket.OPEN) {
        let frame;
        try { frame = JSON.parse(raw); } catch { return; }
        owner.send(JSON.stringify({ type: "relay.frame", from: agentId, frame }));
      }
    } else {
      // owner -> members
      let msg = null;
      try { msg = JSON.parse(raw); } catch { /* fall through to broadcast raw */ }
      if (msg && msg.type === "relay.send" && typeof msg.to === "string" && msg.frame) {
        const target = room.members.get(msg.to);
        if (target && target.readyState === WebSocket.OPEN) target.send(JSON.stringify(msg.frame));
      } else {
        for (const m of room.members.values()) {
          if (m.readyState === WebSocket.OPEN) m.send(raw);
        }
      }
    }
  });

  socket.on("close", () => {
    if (role === "owner") {
      if (room.owner === socket) room.owner = null;
    } else if (room.members.get(agentId) === socket) {
      room.members.delete(agentId);
    }
    if (!room.owner && room.members.size === 0) rooms.delete(roomId);
  });

  socket.on("error", () => { /* close follows */ });
});

// 心跳: 清理死连接
setInterval(() => {
  for (const [roomId, room] of rooms) {
    const sockets = [room.owner, ...room.members.values()].filter(Boolean);
    for (const s of sockets) {
      if (s.readyState === WebSocket.OPEN) {
        try { s.ping(); } catch { s.terminate(); }
      } else if (s.readyState === WebSocket.CLOSED || s.readyState === WebSocket.CLOSING) {
        try { s.terminate(); } catch { /* ignore */ }
      }
    }
    if (!room.owner && room.members.size === 0) rooms.delete(roomId);
  }
}, 30_000);

console.log(`[relay] 无状态中继已就绪 (${new Date().toISOString()})`);
