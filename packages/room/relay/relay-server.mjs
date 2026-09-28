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
 * 房主不在时告诉成员"多久后再问一次"（D-49）。
 *
 * 取值来源：与本进程的心跳周期（30s）以及客户端 OWNER_WATCH_MS（30s）对齐。成员在房主离线期间
 * 保持同一条 socket 打开、按这个节奏重发 relay.join，而不是把 20s 预算跑完后关掉重连 ——
 * 2026-09-16 实测：一台成员这样空转了 68 次 join、601 次离线暂存、1608 次 join timeout 关闭，
 * 而中继明明知道"房主不在"，却什么都没说。
 */
const OWNER_OFFLINE_RETRY_MS = 30_000;

/**
 * D-50：房主权威的租约（lease）。
 *
 * 中继是唯一裁决者，所以"权威"必须有一个**到期时间**和**序号**：
 *   - 续租间隔 15s ＝ 本进程 30s ping 周期的一半（丢一次续租不影响判定）；
 *   - 租约 TTL 45s ＝ 3 次续租；它 > 客户端 20s 握手预算（room-client.ts:81，成员不该被一次续租
 *     丢失打断），并且 < 传输层判死窗口（ping 30s × 丢 2 ≈ 60s）⇒ **权威先失效、连接后判死**，
 *     这样"丢包"和"关机/重启"都能在成员侧得到一句人话；
 *   - 检查周期 5s：TTL 45s 的实际检测上限为 50s，且不随房间数变差。
 */
const LEASE_TTL_MS = Number(process.env.RELAY_LEASE_TTL_MS ?? 45_000);
const LEASE_RENEW_MS = Number(process.env.RELAY_LEASE_RENEW_MS ?? 15_000);
const LEASE_TICK_MS = Number(process.env.RELAY_LEASE_TICK_MS ?? 5_000);

/** 新房间的初始租约：没有房主，epoch=0。 */
function newLease() {
  return { ownerAgentId: null, epoch: 0, renewedAt: 0, expiresAt: 0 };
}

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
    room = { owner: null, secret: null, members: new Map(), buffer: [], lease: newLease(), ownerAbsentNotified: false };
    rooms.set(roomId, room);
  }
  console.log(`[relay] connect room=${roomId.slice(0, 8)} role=${role} agent=${String(agentId).slice(0, 12)} ownerOnline=${room.owner ? room.owner.readyState : "none"} epoch=${room.lease.epoch}`);

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
    /* ---------------------------------------------------------------------------
     * D-50: AUTHORITY HAS AN ORDER.
     *
     * Before this, the only rule was "whoever presents the right secret takes the owner slot"
     * (`room.owner.close(4001, "owner replaced")`), with no epoch and no notion of authority
     * expiring -- so a returning owner could always displace whoever took over, and two owners could
     * each believe they were the authority. The rules below make the order explicit:
     *
     *   epoch > current  -> accepted ONLY when the authority actually lapsed (lease expired or the
     *                       owner is absent); otherwise refused ("epoch ahead"): no early grabs.
     *   epoch == current -> a reconnect by the CURRENT owner. Any other agent presenting the same
     *                       epoch is refused ("owner present"): two owners cannot share an epoch.
     *   epoch <  current -> refused ("stale epoch"). The caller has lost its authority and must
     *                       demote itself to a member.
     *   no epoch         -> 0.1.49-and-earlier owners (measured: the live fleet sends none). Kept
     *                       working: accepted as a reconnect when the agentId matches the current
     *                       owner, or when nobody holds the slot; REFUSED otherwise, which is the
     *                       one behaviour change old clients see, and the one that stops a stale
     *                       owner from overwriting a legitimate takeover.
     * ------------------------------------------------------------------------- */
    const epochParam = url.searchParams.get("epoch");
    const claimedEpoch = epochParam === null ? null : Number(epochParam);
    if (epochParam !== null && (!Number.isInteger(claimedEpoch) || claimedEpoch < 0)) {
      socket.close(4001, "bad epoch");
      return;
    }
    const lease = room.lease;
    const lapsed = lease.expiresAt <= Date.now() || room.ownerAbsentNotified || !room.owner;
    const currentOwnerId = lease.ownerAgentId;
    const sameAgent = currentOwnerId !== null && currentOwnerId === agentId;
    if (claimedEpoch === null) {
      if (room.owner && room.owner.readyState === WebSocket.OPEN && !sameAgent && !room.ownerAbsentNotified) {
        console.log(`[relay] owner REFUSED (no epoch) agent=${String(agentId).slice(0, 12)}: the slot is held by ${String(currentOwnerId ?? "?").slice(0, 12)}`);
        socket.close(4001, "owner present");
        return;
      }
    } else if (claimedEpoch < lease.epoch) {
      console.log(`[relay] owner REFUSED (stale epoch ${claimedEpoch} < ${lease.epoch}) agent=${String(agentId).slice(0, 12)}`);
      socket.close(4001, "stale epoch");
      return;
    } else if (claimedEpoch === lease.epoch && !sameAgent && room.owner && room.owner.readyState === WebSocket.OPEN && !lapsed) {
      console.log(`[relay] owner REFUSED (epoch ${claimedEpoch} already held by another agent) agent=${String(agentId).slice(0, 12)}`);
      socket.close(4001, "owner present");
      return;
    } else if (claimedEpoch > lease.epoch && !lapsed) {
      console.log(`[relay] owner REFUSED (epoch ahead ${claimedEpoch} > ${lease.epoch}, authority has not lapsed) agent=${String(agentId).slice(0, 12)}`);
      socket.close(4001, "epoch ahead");
      return;
    }
    room.secret = secret; // 首次登记 (TOFU)
    const replaced = room.owner && room.owner !== socket;
    if (replaced) {
      try { room.owner.close(4001, "owner replaced"); } catch { /* ignore */ }
    }
    room.owner = socket;
    socket.__ownerEpoch = claimedEpoch === null ? lease.epoch : claimedEpoch;
    room.lease = { ownerAgentId: agentId, epoch: socket.__ownerEpoch, renewedAt: Date.now(), expiresAt: Date.now() + LEASE_TTL_MS };
    room.ownerAbsentNotified = false;
    // 房主重连成功：按 FIFO 补发离线期间暂存的业务帧，发完清空（尽力而为）。
    if (room.buffer.length > 0) {
      for (const item of room.buffer) {
        safeSend(socket, JSON.stringify({ type: "relay.frame", from: item.from, frame: item.frame }));
      }
      room.buffer = [];
    }
    // D-49：房主回来了，告诉还在等的成员。成员此刻保持同一条 socket，收到这帧立刻重发
    // relay.join —— 这才是"房主眨眼"不再变成"成员风暴"的关键一步。
    // D-50：这一帧同时带上 epoch 与 ownerAgentId，成员据此知道权威是否换了人。
    for (const m of room.members.values()) {
      if (m.socket.readyState === WebSocket.OPEN) {
        safeSend(m.socket, JSON.stringify({
          type: "relay.owner-online",
          payload: { roomId, epoch: room.lease.epoch, ownerAgentId: agentId, changed: replaced },
        }));
      }
    }
    if (room.members.size > 0) {
      console.log(
        `[relay] owner-online room=${roomId.slice(0, 8)} epoch=${room.lease.epoch} replaced=${replaced} ` +
          `told ${room.members.size} member(s)`,
      );
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
            // 每个成员只保留一条待处理 join：成员在房主离线期间会重发，若不去重，同一台机
            // 的同一请求会被暂存 N 份（实测 601 条离线暂存，全是同一台成员机的重复请求）。
            const already = room.buffer.some((b) => b.from === agentId && b.frame?.type === "relay.join");
            if (!already) {
              room.buffer.push({ from: agentId, frame });
              if (room.buffer.length > OFFLINE_BUFFER_LIMIT) room.buffer.shift();
            }
            // D-49：把"为什么握不上手"说清楚。没有这一帧，成员无法区分「房主不在」和「链路坏了」，
            // 只能把注定失败的握手重试到自己预算耗尽 —— 这正是 1608 次 join timeout 的来处。
            safeSend(socket, JSON.stringify({
              type: "relay.owner-offline",
              payload: { retryAfterMs: OWNER_OFFLINE_RETRY_MS, roomId },
            }));
            console.log(
              `[relay] relay.join owner-less: told ${String(agentId).slice(0, 12)} owner-offline ` +
                `(retryAfterMs=${OWNER_OFFLINE_RETRY_MS}, buffered=${room.buffer.length}, deduped=${already})`,
            );
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
    /* D-50: any frame from the owner is a sign of life -> renew the authority lease. Without this,
     * an owner that is busy (long install, heavy transcript) would lose its authority to a standby
     * that merely happened to be quieter. */
    if (msg && msg.type === "relay.lease-renew") {
      if (room.lease.ownerAgentId === agentId) {
        room.lease.renewedAt = Date.now();
        room.lease.expiresAt = Date.now() + LEASE_TTL_MS;
        if (room.ownerAbsentNotified) {
          room.ownerAbsentNotified = false;
          console.log(`[relay] owner-recovered room=${roomId.slice(0, 8)} epoch=${room.lease.epoch} (lease renewed before any takeover)`);
          for (const m of room.members.values()) {
            if (m.socket.readyState === WebSocket.OPEN) {
              safeSend(m.socket, JSON.stringify({ type: "relay.owner-online", payload: { roomId, epoch: room.lease.epoch, ownerAgentId: agentId, changed: false } }));
            }
          }
        }
      }
      return;
    }
    if (room.lease.ownerAgentId === agentId && room.owner === socket) {
      room.lease.renewedAt = Date.now();
      room.lease.expiresAt = Date.now() + LEASE_TTL_MS;
    }
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
      /* D-50: the lease is NOT cleared here on purpose. A socket close is one symptom; the authority
       * lapses on its own clock (LEASE_TTL_MS) and only then may anyone take over. Clearing it here
       * would let a standby grab the room during a 1-second blip -- exactly the split-brain window
       * this design exists to close. */
    } else {
      const entry = room.members.get(agentId);
      if (entry && entry.socket === socket) room.members.delete(agentId);
    }
    if (!room.owner && room.members.size === 0) rooms.delete(roomId);
  });
  socket.on("error", () => { /* close follows */ });
});

/**
 * D-50：租约到期检查（5s 一跳）。到期只广播 `owner-absent`，**不关房主的 socket**：
 * 丢包、笔记本休眠、进程重启在这条路上要能被成员读成"房主的问题"，而不是"房间坏了"。
 * （关不关 socket 由既有 30s ping × 丢 2 次的传输层判定负责，两件事分开。）
 */
setInterval(() => {
  for (const [roomId, room] of rooms) {
    const lease = room.lease;
    if (!lease.ownerAgentId) continue;
    if (lease.expiresAt > Date.now()) continue;
    if (room.ownerAbsentNotified) continue;
    room.ownerAbsentNotified = true;
    console.log(
      `[relay] owner-absent room=${roomId.slice(0, 8)} owner=${String(lease.ownerAgentId).slice(0, 12)} ` +
        `epoch=${lease.epoch} lease expired ${Math.round((Date.now() - lease.expiresAt) / 1000)}s ago ` +
        `(a takeover may now claim epoch ${lease.epoch + 1})`,
    );
    for (const m of room.members.values()) {
      if (m.socket.readyState === WebSocket.OPEN) {
        safeSend(m.socket, JSON.stringify({
          type: "relay.owner-absent",
          payload: { roomId, epoch: lease.epoch, ownerAgentId: lease.ownerAgentId, retryAfterMs: OWNER_OFFLINE_RETRY_MS },
        }));
      }
    }
  }
}, LEASE_TICK_MS);

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
