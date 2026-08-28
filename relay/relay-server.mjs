/**
 * dsh-agent-room — 跨网中继服务器 (relay) v1。
 *
 * 无状态转发 + token 鉴权：
 *  - 房主连接需携带房间中继密钥 `secret`（首次登记，之后必须一致）。
 *  - 成员先用 `relay.join` 经房主换取 HMAC ticket，再在同一条 ws 上发
 *    `relay.auth {ticket}` 完成鉴权；鉴权前只允许 join/auth，不允许业务帧。
 *  - 房主可发 `relay.revoke {agentId}` 即时断开某成员的中继连接。
 *
 * 运行: node relay-server.mjs [port]   # 默认 9320 / RELAY_PORT
 */
import { WebSocketServer, WebSocket } from "ws";
import { createHmac, timingSafeEqual } from "node:crypto";

const port = Number(process.argv[2] ?? process.env.RELAY_PORT ?? 9320);

function hmacHex(secret, message) {
  return createHmac("sha256", secret).update(message).digest("hex");
}
function verifyTicket(secret, ticket) {
  if (typeof ticket !== "string") return null;
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0 || dot === ticket.length - 1) return null;
  const body = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  const a = Buffer.from(hmacHex(secret, body), "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object") return null;
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** roomId -> { owner: ws|null, secret: string|null, members: Map<agentId, {socket, authenticated}> } */
const rooms = new Map();

const wss = new WebSocketServer({ port });
console.log(`[relay] listening on :${port} (ws://host:${port}/relay?roomId=&role=&agentId=&secret=/&token=)`);

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
    room = { owner: null, secret: null, members: new Map() };
    rooms.set(roomId, room);
  }

  if (role === "owner") {
    const secret = url.searchParams.get("secret");
    if (!secret) {
      socket.close(4001, "missing relay secret");
      return;
    }
    if (room.secret && room.secret !== secret) {
      socket.close(4001, "relay secret mismatch");
      return;
    }
    room.secret = secret; // 首次登记 (TOFU)
    if (room.owner && room.owner !== socket) {
      try { room.owner.close(4001, "owner replaced"); } catch { /* ignore */ }
    }
    room.owner = socket;
  } else if (role === "member") {
    const prev = room.members.get(agentId);
    if (prev && prev.socket !== socket) {
      try { prev.socket.close(4001, "member replaced"); } catch { /* ignore */ }
    }
    let authenticated = false;
    const token = url.searchParams.get("token");
    if (token) {
      const payload = room.secret ? verifyTicket(room.secret, token) : null;
      if (payload && payload.roomId === roomId && payload.agentId === agentId && payload.role === "member") {
        authenticated = true;
      } else {
        socket.close(4001, "invalid relay token");
        return;
      }
    }
    room.members.set(agentId, { socket, authenticated });
  } else {
    socket.close(4000, "bad role");
    return;
  }

  socket.on("message", (data) => {
    const raw = String(data);
    if (role === "member") {
      const entry = room.members.get(agentId);
      if (!entry || entry.socket !== socket) return;
      let frame;
      try { frame = JSON.parse(raw); } catch { return; }

      if (!entry.authenticated) {
        if (frame.type === "relay.auth") {
          const payload = room.secret ? verifyTicket(room.secret, frame.payload?.ticket) : null;
          if (payload && payload.roomId === roomId && payload.agentId === agentId && payload.role === "member") {
            entry.authenticated = true;
            socket.send(JSON.stringify({ type: "relay.authed", payload: { ok: true } }));
          } else {
            socket.send(JSON.stringify({ type: "relay.authed", payload: { ok: false, error: "invalid relay token" } }));
            socket.close(4001, "invalid relay token");
          }
          return;
        }
        if (frame.type === "relay.join") {
          const owner = room.owner;
          if (owner && owner.readyState === WebSocket.OPEN) {
            owner.send(JSON.stringify({ type: "relay.frame", from: agentId, frame }));
          }
          return;
        }
        return; // 未认证成员只能 join/auth
      }

      // 已认证成员 → 转发给房主
      const owner = room.owner;
      if (owner && owner.readyState === WebSocket.OPEN) {
        owner.send(JSON.stringify({ type: "relay.frame", from: agentId, frame }));
      }
      return;
    }

    // owner -> members
    let msg = null;
    try { msg = JSON.parse(raw); } catch { /* fall through to broadcast raw */ }
    if (msg && msg.type === "relay.revoke" && typeof msg.agentId === "string") {
      const target = room.members.get(msg.agentId);
      if (target) {
        room.members.delete(msg.agentId);
        try { target.socket.close(4003, "revoked"); } catch { /* ignore */ }
      }
      return;
    }
    if (msg && msg.type === "relay.send" && typeof msg.to === "string" && msg.frame) {
      const target = room.members.get(msg.to);
      if (target && target.socket.readyState === WebSocket.OPEN) target.socket.send(JSON.stringify(msg.frame));
    } else {
      for (const m of room.members.values()) {
        if (m.socket.readyState === WebSocket.OPEN) m.socket.send(raw);
      }
    }
  });

  socket.on("close", () => {
    if (role === "owner") {
      if (room.owner === socket) room.owner = null;
    } else {
      const entry = room.members.get(agentId);
      if (entry && entry.socket === socket) room.members.delete(agentId);
    }
    if (!room.owner && room.members.size === 0) rooms.delete(roomId);
  });
  socket.on("error", () => { /* close follows */ });
});

// 心跳: 清理死连接
setInterval(() => {
  for (const [roomId, room] of rooms) {
    const sockets = [room.owner, ...[...room.members.values()].map((m) => m.socket)].filter(Boolean);
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

console.log(`[relay] 无状态中继(token 鉴权)已就绪 (${new Date().toISOString()})`);
