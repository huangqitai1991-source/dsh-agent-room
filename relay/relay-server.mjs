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

/** 每房间离线暂存帧上限（内存 FIFO）：超限丢最旧，保证单房间内存有界。 */
const OFFLINE_BUFFER_LIMIT = 200;

/**
 * 单个连接允许积压的发送字节上限。
 *
 * readyState===OPEN 只说明握手完成：对端一旦停止读取（丢包链路、休眠的笔记本、
 * 半开 TCP），内核仍会接受写入而无人消费，这些字节全部堆在本进程内存里。
 * 实测该状态下中继涨到 536MB 并且不再能完成新的握手，整个工作室静默掉线，
 * 所以宁可直接断开这个慢对端。
 */
const MAX_SOCKET_BUFFER = 4 * 1024 * 1024;

/** 心跳无响应判定：一个 30s 周期内没有 pong 即视为死连接。 */
const STALE_SOCKET_LIMIT = 2;

/**
 * 带背压保护的发送。返回是否真的发出去了。
 * 积压超限时主动 terminate，触发正常的 close 清理流程。
 */
function safeSend(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (typeof socket.bufferedAmount === "number" && socket.bufferedAmount > MAX_SOCKET_BUFFER) {
    console.log(`[relay] drop slow peer buffered=${socket.bufferedAmount} limit=${MAX_SOCKET_BUFFER}`);
    try { socket.terminate(); } catch { /* ignore */ }
    return false;
  }
  try {
    socket.send(payload);
    return true;
  } catch {
    return false;
  }
}

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

/** roomId -> { owner: ws|null, secret: string|null, members: Map<agentId, {socket, authenticated}>, buffer: Array<{from: string, frame: object}> } */
const rooms = new Map();

const wss = new WebSocketServer({ port });
console.log(`[relay] listening on :${port} (ws://host:${port}/relay?roomId=&role=&agentId=&secret=/&token=)`);

wss.on("connection", (socket, req) => {
  // 半开连接（对端崩溃/断网但没发 FIN）不会自己 close，会一直占着房间槽位并
  // 让本进程继续为它排队数据。用 pong 计数判定死亡，连续丢失即 terminate。
  socket.__aliveMisses = 0;
  socket.__connectedAt = Date.now();
  // Whether this member ever completed relay.auth. A socket that dies young and
  // never authed is a client-side handshake bug; one that dies right AFTER
  // authed points at the transport or the peer's own reconnect logic. Without
  // this the close line alone cannot tell the two apart — which is exactly the
  // question an endlessly flapping Mac left open.
  socket.__authed = false;
  socket.on("pong", () => { socket.__aliveMisses = 0; });

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
    room = { owner: null, secret: null, members: new Map(), buffer: [] };
    rooms.set(roomId, room);
  }
  console.log(`[relay] connect room=${roomId.slice(0, 8)} role=${role} agent=${String(agentId).slice(0, 12)} ownerOnline=${room.owner ? room.owner.readyState : "none"}`);

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
    // 房主重连成功：按 FIFO 补发离线期间暂存的业务帧，发完清空（尽力而为）。
    if (room.buffer.length > 0) {
      for (const item of room.buffer) {
        safeSend(socket, JSON.stringify({ type: "relay.frame", from: item.from, frame: item.frame }));
      }
      room.buffer = [];
    }
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
          const okAuth = Boolean(payload && payload.roomId === roomId && payload.agentId === agentId && payload.role === "member");
          console.log(`[relay] relay.auth from=${String(agentId).slice(0, 12)} ok=${okAuth} hasSecret=${Boolean(room.secret)}`);
          if (okAuth) {
            entry.authenticated = true;
            socket.__authed = true;
            socket.send(JSON.stringify({ type: "relay.authed", payload: { ok: true } }));
            socket.__sentAuthedAt = Date.now();
          } else {
            socket.send(JSON.stringify({ type: "relay.authed", payload: { ok: false, error: "invalid relay token" } }));
            socket.close(4001, "invalid relay token");
          }
          return;
        }
        if (frame.type === "relay.join") {
          const owner = room.owner;
          console.log(`[relay] relay.join from=${String(agentId).slice(0, 12)} owner=${owner ? owner.readyState : "none"} (1=OPEN)`);
          if (owner && owner.readyState === WebSocket.OPEN) {
            safeSend(owner, JSON.stringify({ type: "relay.frame", from: agentId, frame }));
          } else {
            // 房主此刻不在（中继重启、房主网络抖动都会造成这种窗口）。
            // 以前这里直接丢弃，成员只能白等整个握手超时再重连 —— 实测小黄在
            // 这种窗口里要等满 89.999 秒。改成暂存，房主重连时按既有逻辑补发，
            // 成员的握手就能在超时之前完成。
            // 上限沿用 OFFLINE_BUFFER_LIMIT；成员若已放弃，补发的应答会被丢掉。
            room.buffer.push({ from: agentId, frame });
            if (room.buffer.length > OFFLINE_BUFFER_LIMIT) room.buffer.shift();
            console.log(`[relay] relay.join buffered for owner-less room (buffered=${room.buffer.length})`);
          }
          return;
        }
        if (frame.type === "relay.auth") {
          console.log(`[relay] relay.auth from=${String(agentId).slice(0, 12)}`);
        }
        return; // 未认证成员只能 join/auth
      }

      // 已认证成员 → 转发给房主；房主离线则暂存，待房主重连后按序补发。
      const owner = room.owner;
      if (owner && owner.readyState === WebSocket.OPEN) {
        safeSend(owner, JSON.stringify({ type: "relay.frame", from: agentId, frame }));
      } else {
        // 尽力而为内存 FIFO：超限丢最旧；relay.join/relay.auth 走未认证分支，不会进入此缓存。
        room.buffer.push({ from: agentId, frame });
        if (room.buffer.length > OFFLINE_BUFFER_LIMIT) room.buffer.shift();
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
      console.log(`[relay] owner.send to=${String(msg.to).slice(0, 12)} type=${msg.frame?.type ?? "?"} delivered=${Boolean(target && target.socket.readyState === WebSocket.OPEN)}`);
      if (target && target.socket.readyState === WebSocket.OPEN) safeSend(target.socket, JSON.stringify(msg.frame));
    } else {
      for (const m of room.members.values()) {
        if (m.socket.readyState === WebSocket.OPEN) safeSend(m.socket, raw);
      }
    }
  });

  socket.on("close", (code, reason) => {
    const ageMs = Date.now() - (socket.__connectedAt ?? Date.now());
    const afterAuthed = socket.__sentAuthedAt ? `${Date.now() - socket.__sentAuthedAt}ms after authed` : "never authed";
    console.log(
      `[relay] close  room=${roomId.slice(0, 8)} role=${role} agent=${String(agentId).slice(0, 12)} ` +
        `code=${code} reason=${String(reason ?? "")} lived=${ageMs}ms authed=${socket.__authed} (${afterAuthed})`,
    );
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
  let memberTotal = 0;
  let bufferedTotal = 0;
  let ownerTotal = 0;
  for (const [roomId, room] of rooms) {
    if (room.owner) ownerTotal += 1;
    memberTotal += room.members.size;
    bufferedTotal += room.buffer.length;
    const sockets = [room.owner, ...[...room.members.values()].map((m) => m.socket)].filter(Boolean);
    for (const s of sockets) {
      if (s.readyState === WebSocket.OPEN) {
        if (s.__aliveMisses >= STALE_SOCKET_LIMIT) {
          console.log(`[relay] terminate stale socket (no pong x${s.__aliveMisses})`);
          try { s.terminate(); } catch { /* ignore */ }
          continue;
        }
        s.__aliveMisses += 1;
        try { s.ping(); } catch { s.terminate(); }
      } else if (s.readyState === WebSocket.CLOSED || s.readyState === WebSocket.CLOSING) {
        try { s.terminate(); } catch { /* ignore */ }
      }
    }
    if (!room.owner && room.members.size === 0) rooms.delete(roomId);
  }
  // 观测：把内存与房间/成员数定期写进日志。
  // 2026-09-12 中继曾悄悄涨到 536MB 并停止完成握手，而当时没有任何可见指标 ——
  // 这一行让「涨到多少、是堆泄漏还是 RSS 碎片、房间表是否在漏」一眼可查。
  const mem = process.memoryUsage();
  console.log(
    `[relay] health rss=${(mem.rss / 1048576).toFixed(1)}MB heapUsed=${(mem.heapUsed / 1048576).toFixed(1)}MB ` +
      `rooms=${rooms.size} owners=${ownerTotal} members=${memberTotal} buffered=${bufferedTotal}`,
  );
}, 30_000);

console.log(`[relay] 无状态中继(token 鉴权)已就绪 (${new Date().toISOString()})`);
