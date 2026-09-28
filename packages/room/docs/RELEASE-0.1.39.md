# dsh-agent-room 0.1.39 — 入站帧的双投递（P0 读视图污染）

发布目标：`card-02-a2prime-delivery-dedupe-v2.md`（§4.1 / §4.2 / §4.4 落地；§4.3 的在飞锁**按卡决定不做**）+ `card-template.md` 的发布门禁。
发布说明：本版**只做**这一件事。**不动 agent-org**（0.2.11 不变），**不动协议**，**不动 0.1.36 的三道保护**（广播水位、拒绝 live self-join、销毁被替换的 client）。

---

## 1. 缺陷（一句话）

同一条入站 chat 帧被投递到浏览器通道**两次**（同 `roomId`、同 `seq`、同 `body`、**同一毫秒**），
而 `[org:*]` 控制帧被投递**一次**（本该零次）；成因是同一个 `message` 对象走了两条发射路径：

```
路径 A  client.on("chat")        -> emitBrowser（有 isControlFrame 守卫）
                                 -> roomService.emit("chat", …)   ← 0.1.22 加的再注入
路径 B  roomService.on("chat")   -> emitBrowser（无守卫）+ noteOwnReply
```

⇒ 普通帧 2 次、控制帧 1 次、`noteOwnReply` 每帧 2 次。
**不是**乐观本地回显（那会用负 seq），**不是**网络重传（那会换 seq、时间差一个 RTT）：实测两次到达**同一毫秒**。

## 2. 修复后的语义（本版契约）

| 帧 | 0.1.38（旧） | 0.1.39（新） |
|---|---|---|
| 普通 chat 帧（成员房） | 浏览器通道推 **2** 次（同毫秒） | 浏览器通道推 **1** 次 |
| 普通 chat 帧（房主房） | 浏览器通道推 1 次 | **不变**（房主本来只有总线一条路） |
| `[org:*]` 控制帧（成员房） | 浏览器通道推 **1** 次（漏推） | **0** 次 |
| `[org:*]` 控制帧（房主房） | 浏览器通道推 **1** 次（漏推，本卡 E-OWNER 实测） | **0** 次 |
| 本地 `roomService` 总线（org/执行面） | 收到全部帧 | **不变**：收到全部帧，控制帧照样收到 |
| `noteOwnReply` | 每条入站消息 **2** 次 | 每条入站消息 **1** 次 |
| 同一 `(roomId, seq)` 重复到达 | 每次到达都推 | **只处理一次**（有界环），重复者既不推也不更新 thinking 态 |

**控制帧从浏览器通道消失是修 bug，不是回归**：HTTP 读视图（`peer-server.ts` 的 `!isControlFrame(...)` 过滤）从 0.1.31 起就过滤它们，推送通道此前是唯一例外；卡实测一个 **900 秒窗口内浏览器通道收到的 4/4 条 chat 事件全是控制帧**（工单流量刷进用户消息列表）。

## 3. 改动清单（每个文件一行理由）

| 文件 | 改动 |
|---|---|
| `src/host/dedupe.ts` | **新增**。有界投递级去重环 `DeliveryDedupe`（4096 seq/房间、128 房间、只留数字计数），文件头写明上限的实测推导 |
| `src/host/service.ts` | ① 删掉 `client.on("chat")` 里的直推 `emitBrowser` 与 `noteOwnReply`（第 2、3 次调用点）；② 把 `isControlFrame` 守卫搬到**唯一发射点**（总线监听器）；③ 在唯一发射点做 `(roomId, seq)` 去重（重复即 return，不推也不 noteOwnReply）；④ 新增 `dedupe` 字段 + `leaveRoom` 时 `forget(roomId)`；⑤ `browserState()` 增加 `dedupe` 数字诊断块 |
| `src/client/api.ts` | `RoomState` 增加可选的 `dedupe` 诊断字段（浏览器类型侧） |
| `test/dedupe.test.mjs` | **新增**，2 条：环回真实生产装配的端到端（普通帧 1 次 / 控制帧 0 次 / 总线 1 次 / `noteOwnReply` 每帧 1 次 / 重复 seq 不推）+ 源码级守卫（唯一发射点、守卫在唯一发射点上、client handler 不再直推、无在飞锁） |
| `test/dedupe-ring.test.mjs` | **新增**，7 条：环本身（重复即命中、不同 seq 全保留、满环淘汰最旧、非正 seq 不记录、按房间隔离、房间上限触发重置、`forget`） |
| `docs/RELEASE-0.1.39.md` | 本文件 |
| `package.json` | 版本 0.1.38 → 0.1.39 |

**明确没做**（按卡）：
- **不动 `roomService.emit("chat", …)`**（原 `service.ts:1201`）——agent-org 的同步/执行面订阅的正是这条总线（`dsh-agent-org/src/host/service.js:115 roomService.on("chat", …)`），删了会静默杀掉远端执行。
- **不加 `joinRoom` 在飞锁**：卡实测未复现（`HTTP 200 joins: 1 (of 3)`、探针帧仍是基线 2），且 `previous` 读取到 `clients.set` 之间**无 `await`**，结构上不可能留下第二个 client。
- **不动 `emitBrowser` 本身**：`state`/`members`/`task`/`system`/`connection` 事件没有 seq、且重复推送是正常语义，去重只挂在 chat 这一处。

## 4. 发布门禁：先复现旧行为，再证明新行为

### 4.1 门禁第 1 步 — OLD 行为（线上 3080，**改动前**跑的原始输出）

```
PS> cd <workdir>; node _repro-dup-push.mjs --room 01a098a2-2015-7a1d-b5f7-9eca45afa65d
POST chat -> 200 {"ok":true,"data":{"seq":2374,"acceptedByLocalHub":true,"confirmedByOwner":true,"confirmedSeq":2374,"confirmNote":"owner-confirmed","delivered":true,"queued":false}}
POST control -> 200 {"ok":true,"data":{"seq":2375,"acceptedByLocalHub":true,"confirmedByOwner":true,"confirmedSeq":2375,"confirmNote":"owner-confirmed","delivered":true,"queued":false}}

SSE window: 3255 ms, chat events in room 01a098a2-2015-7a1d-b5f7-9eca45afa65d: 3
ordinaryChat.seqCounts:
  seq=2374 n=2 atMs=136/136 text="dup-push probe probe-1789369290797"
controlFrame.seqCounts:
  seq=2375 n=1 atMs=1743

RESULT: OLD BEHAVIOUR (double push) -- reproduce this FIRST, before the fix
[exit=0]
```

与卡 E-LIVE 三轮（`2335/2359/2368` 均 `n=2` 同毫秒、控制帧 `n=1`）逐项一致；本机本次是 **0.1.38** 构建，行号相对卡有位移（卡的 `src:207/209/210/1197/1198/1201` 在 0.1.38 上是 `208/210/211/1232/1233/1236`），**结论不受影响**。

### 4.2 门禁第 2 步 — NEW 行为（同一生产装配的进程内探针，原始输出）

**为什么不是 3080 的同一命令**：3080 上那个 `dsh web` 进程在启动时就把插件模块读进内存了，重建 `lib/` **不会**进入运行中的进程；让它加载新代码需要重启，而硬约束禁止启停任何服务（该进程承载调用方会话）。重建后**再跑同一条线上命令**，输出仍是 `n=2 / n=1`（即"新代码未被加载"），已如实记录于 §7.2。

因此 NEW 半边用 `<workdir>\_repro-dup-push-inproc.mjs`（**同一个判定器、同一套计数、同一条生产装配**：owner `RoomService`+`PeerServer` → 成员 `AgentRoomService.gateway.joinRoom` → `RoomClient` → `service.onBrowserEvent`，也就是 `web.ts` 写 SSE 时订阅的同一个回调）测量，并**用同一支探针跑 OLD/NEW 两次**：

```
--- OLD：把 0.1.38 的 lib/host/service.js 换回（改动前的构建产物）---
PS> cd <workdir>; node _repro-dup-push-inproc.mjs
member holds a live client on 01a09ebc-… (joined, owned:false)
send ordinary -> delivered to the browser channel
send control  -> delivered to the local roomService bus (org plane)

window: 2464 ms, chat events on the browser channel in room 01a09ebc-…: 3
ordinaryChat.seqCounts:
  seq=1 n=2 atMs=4/4 text="dup-push probe probe-1789369516955"
controlFrame.seqCounts:
  seq=2 n=1 atMs=1233

local roomService bus (agent-org exec plane) deliveries:
  seq=1 n=1 text="dup-push probe probe-1789369516955"
  seq=2 n=1 text="[org:probe]{\"marker\":\"probe-1789369516955\"}"

browserState().dedupe = null

RESULT: OLD BEHAVIOUR (double push) -- reproduce this FIRST, before the fix

--- NEW：恢复 0.1.39 的 lib/host/service.js，重跑同一条命令 ---
PS> cd <workdir>; node _repro-dup-push-inproc.mjs
member holds a live client on 01a09ebc-… (joined, owned:false)
send ordinary -> delivered to the browser channel
send control  -> delivered to the local roomService bus (org plane)

window: 2482 ms, chat events on the browser channel in room 01a09ebc-…: 1
ordinaryChat.seqCounts:
  seq=1 n=1 atMs=3 text="dup-push probe probe-1789369528179"
controlFrame.seqCounts:

local roomService bus (agent-org exec plane) deliveries:
  seq=1 n=1 text="dup-push probe probe-1789369528179"
  seq=2 n=1 text="[org:probe]{\"marker\":\"probe-1789369528179\"}"

browserState().dedupe = {"rooms":1,"tracked":2,"skipped":0,"evicted":0,"roomResets":0,"maxSeqsPerRoom":4096,"maxRooms":128}

RESULT: FIX VERIFIED -- one push per ordinary frame, zero pushes for control frames
```

**新旧对照（同一条命令、同一支探针）**

| 观测 | OLD（0.1.38 lib） | NEW（0.1.39 lib） |
|---|---|---|
| 普通帧浏览器推送次数 | **n=2**（`atMs=4/4`，同毫秒） | **n=1** |
| 控制帧浏览器推送次数 | **1** | **0**（`controlFrame.seqCounts:` 为空） |
| 控制帧是否仍进本地总线（org 面） | 是（`seq=2 n=1`） | **是**（`seq=2 n=1`，未被削弱） |
| `dedupe` 诊断块 | 不存在 | `{"rooms":1,"tracked":2,…,"maxSeqsPerRoom":4096,"maxRooms":128}` |

> **org/执行面未被削弱的证据**：探针同时挂在 `svc.roomService` 上（agent-org 订阅的**同一个** Bus，`dsh-agent-org/src/host/service.js:115`）。NEW 输出里控制帧在两个房间流上的投递数都是 1：浏览器通道 **0**、总线 **1**。线上未做「真实控制帧驱动 org 状态变化」的对照（见 §8.1）。

### 4.3 门禁第 3 步 — 自动化回归（先复现，后通过）

新增的两条端到端断言**在修复前就是红的**（同一支测试、同一套装配）：

```
--- 修复前（0.1.38 lib）---
PS> node test/dedupe.test.mjs
✖ an inbound frame is pushed to the browser ONCE; a control frame NEVER (0.1.39)
  AssertionError: an ordinary inbound frame must be pushed to the browser EXACTLY ONCE, got 2
✖ source guard: one chat emission point, guarded, on the bus listener; …
  AssertionError: service.ts must have EXACTLY ONE emitBrowser({kind:"chat"}) site (the unique outlet), found 2
ℹ pass 0 / fail 2

--- 修复后（0.1.39 lib）---
PS> node test/dedupe.test.mjs
✔ an inbound frame is pushed to the browser ONCE; a control frame NEVER (0.1.39) (3869.1355ms)
✔ source guard: one chat emission point, guarded, on the bus listener; the client handler only re-injects (3.2901ms)
ℹ tests 2 / pass 2 / fail 0
```

第一条断言在修复前就抓到 `got 2` —— 这正是线上 `n=2` 的进程内等价物（两次推送来自路径 A 直推 + 路径 A 再注入 → 路径 B）。

## 5. 去重环：上限不是拍的，是实测推出来的（卡 §4.4）

| 项 | 值 | 来源 |
|---|---|---|
| 每房间容量 | **4096** | 卡 E-RATE：房主权威库 2361 行 / 27.494 h 实测 **峰值 30 帧/秒、113 帧/10 秒、918 帧/300 秒**、最忙一分钟 278、中位一分钟 2 |
| 房间数上限 | **128** | 本机实测房间数 = 2 → 64× 余量 |
| 每条内存 | **26.27 B/条** | 卡 E-MEM（本机 node 实测：64×512 条 → heapUsed +860,864 B） |
| 最坏内存 | 128 × 4096 × 26.27 B ≈ **13.8 MB** | 由上一行推导 |

- **为什么不是 512（卡 v1 的建议）**：512 在最忙一分钟速率下只覆盖 **110.5 秒**，且 **918 帧/5 分钟**的突发**直接超过 512** —— 环会驱逐仍然合法的旧 seq，把重复投递误判成"没见过"而再推一次。4096 对 918 帧突发有 **4.5×** 余量。
- **为什么不更大**：归档里的 **25,346 帧** replay 洪泛远超任何合理内存环，那一类必须继续由 `backfill.ts` 的既有 seq 去重兜（本模块文件头写明了这条边界）。
- **有界规则**：每房间 FIFO 环（插入序 `Set`），满则**淘汰最旧**并计数；房间数达上限则**整体重置**并（经 `warnRateLimited`）告警一次。**没有按需增长，也没有每条一行的日志**——`card-02` §4.4 的规则三直接来自本团队 411 MB 审计日志事故（每次命中写一行的纯 append 结构）。
- **诊断量是数字，进 `GET /agent-room-api/state`**：`dedupe = { rooms, tracked, skipped, evicted, roomResets, maxSeqsPerRoom, maxRooms }`。
  **必须同时看 `skipped` 与 `evicted`**：只看 `skipped` 会把"环太小所以没命中"误读成"没有重复"。
- **边界（已写进代码注释）**：① 只对 `seq > 0` 生效（本地乐观行是**负 seq**，去重会误杀本机刚发的那条）；② 不处理"自己那条显示两次"（乐观负 seq 与确认正 seq 是两个不同 seq）；③ `state`/`members`/`task`/`system` 不进环；④ 不用 `listenSeen` 高水位替代（回填会乱序补入旧 seq）；⑤ 离开房间即销毁该房间环（对齐 `outbound` 的 `drop`）。

## 6. 测试计数（`node test/<name>.mjs` 逐个直跑，从不用 `node --test`）

| 套件 | 改动前 | 改动后 |
|---|---|---|
| `protocol.test.mjs` | pass 8 / fail 0 | pass 8 / fail 0 |
| `snapshot.test.mjs` | pass 4 / fail 0 | pass 4 / fail 0 |
| `outbound.test.mjs` | pass 10 / fail 0 | pass 10 / fail 0 |
| `sendchat.test.mjs` | pass 4 / fail 0 | pass 4 / fail 0 |
| `backfill.test.mjs` | pass 10 / fail 0 | pass 10 / fail 0 |
| `backfill.e2e.mjs` | pass 3 / fail 0 | pass 3 / fail 0 |
| `amplification.test.mjs` | pass 2 / fail 0 | pass 2 / fail 0 |
| `selfjoin.test.mjs` | pass 2 / fail 0 | pass 2 / fail 0 |
| `bom-identity.test.mjs` | pass 14 / fail 0 | pass 14 / fail 0 |
| `dedupe.test.mjs`（新增） | —（修复前为 **pass 0 / fail 2**，见 §4.3） | **pass 2 / fail 0** |
| `dedupe-ring.test.mjs`（新增） | — | **pass 7 / fail 0** |

`npx tsc --noEmit` 干净（exit 0）；`node build.mjs` 成功（`built lib/host/*, lib/client.js, lib/skills/`）。
> 说明：`backfill.e2e.mjs` 与新增的 `dedupe.test.mjs` 若把 stderr 并进 PowerShell 管道会被报 `NativeCommandError`，单独重定向时 `exit=0`；这是 PowerShell 的产物，不是测试失败（与 0.1.38 release 记录同因）。
> 本版运行时的 stderr 有一行 `[agent-room] backup root <home>\identity-backups is NOT writable (EPERM …)`：本会话文件沙箱不允许写工作区之外，属**0.1.38 既有行为**（拒写而非覆盖），与本版改动无关。

## 7. 复现 OLD / 验证 NEW 的可跑判据

### 7.1 任意一台机器自己就能跑（今日规则）

```powershell
# 0) 只读静态拓扑：期望 2 个 chat 发射点（未修复）/ 1 个（修复后）
node <workdir>\_probe-doublepush-map.mjs

# 1) OLD 基线（线上 3080；members 房，owned:false）
node <workdir>\_repro-dup-push.mjs --room 01a098a2-2015-7a1d-b5f7-9eca45afa65d
#   0.1.38 期望：seq n=2 atMs=x/x（同毫秒）、控制帧 n=1、末行 RESULT: OLD BEHAVIOUR
#   0.1.39 期望：seq n=1、控制帧 0 条、末行 RESULT: FIX VERIFIED

# 2) 进程内同路径（不依赖任何服务的启停，重建 lib 后即可跑）
node <workdir>\_repro-dup-push-inproc.mjs
#   期望：普通 n=1、controlFrame.seqCounts 为空、总线两条 n=1、RESULT: FIX VERIFIED

# 3) 回归套件（逐条直跑）
node <repo>\test\dedupe.test.mjs        # pass 2
node <repo>\test\dedupe-ring.test.mjs   # pass 7
```

### 7.2 本机执行记录（如实）

- §4.1 的线上 OLD 输出：**改动前**跑（0.1.38 构建）。
- 重建后**再跑同一条线上命令**：仍是 `seq=2376 n=2 atMs=125/125`、控制帧 `n=1` —— 即 3080 进程仍持旧模块，**新代码未加载**（未重启，遵守硬约束）。⇒ 线上 NEW 归属"本会话未验证"，见 §8.1。

## 8. 本版**没有**验证 / 主动排除的部分（如实列出）

1. **线上（3080）NEW 行为未验证**：需要重启承载调用方会话的 `dsh web`，硬约束禁止。NEW 证据来自**同一生产装配的进程内探针 + 端到端测试**（`service.onBrowserEvent` 就是 SSE 的订阅点），**不是**线上 SSE 的现场输出。
2. **没有用「真实控制帧驱动 org 状态变化」做线上对照**（卡 T-A-3）：需要主动发一条真会被执行面消费的 `[org:exec]` 控制帧（会改状态）。静态侧证据：`dsh-agent-org/src/host/service.js:115 roomService.on("chat", …)` 订阅的是**总线**，本版**没有**改总线的再注入那一句；动态侧证据：进程内探针显示控制帧在总线上仍 `n=1`。
3. **房主侧（owned:true）NEW 行为未线上复测**：卡 E-OWNER 记录房主侧此前在漏控制帧（`seq=16 n=1`）。本版把守卫搬到**唯一发射点**，房主侧也走这条路径，故预期 `0`；进程内测试只覆盖成员房（owner 房与成员房共用同一发射点）。
4. **`(roomId, seq)` 去重的现场观测未做**：本机的 `dedupe.skipped` 在线上仍为 0（旧模块在跑）。进程内已覆盖：重复投递同一 `(roomId, seq)` 不再推送，且 `skipped` 计数增加。
5. **并发 join 加固（卡 T-B′）未做**：本版不涉及该路径（卡已把它降级为"不做"）。
6. **`ringEvicted` 的生产态标定（卡 T-C）未做**：只有进程内标定（128×4096×26.27 B ≈ 13.8 MB 的推导 + 单元测试里的上限断言），生产态需要一个达到上限的活房间才能观测。
7. **P0 之外的两处遗留**：`_probe-doublepush-map.mjs` 与 `_repro-dup-push-inproc.mjs` 在 `<workdir>`（卡工具目录），`_repro-dup-push-inproc.mjs` 里仓库路径是**本机绝对路径**，跨机重跑需改这一行（与 0.1.38 的 `_probe-fatal-real.mjs` 同类问题）。

## 9. 上线与回滚

**上线**（每台机器自己执行；本版不改协议、不改写盘格式，可与 agent-org 0.2.11 同批）：

```powershell
# 1) 升级前先归档日志（团队铁律）
node <workdir>\archive-log.cjs --file <该机>\studio.log
# 2) 升级插件（各机自己的看门狗会拉起）
npm.cmd pack --ignore-scripts --cache <workdir>\.npm-cache      # 产出 dsh-agent-room-0.1.39.tgz
#    （或用已上传的 tarball：/path/to/studio-files/dsh-agent-room-0.1.39.tgz）
# 3) 校验：普通帧 n=1、控制帧 0、末行 RESULT: FIX VERIFIED
node <workdir>\_repro-dup-push.mjs --room 01a098a2-2015-7a1d-b5f7-9eca45afa65d
```

**回滚触发条件**（任一即回滚）：
1. 修复后 SSE 上同一 seq 计数 = **0**（帧被吞了，比推两次更糟）；
2. org 树停止收敛（`GET /agent-org-api/state` 的 `nodesSha256` 长时间不变）；
3. 执行面漏工单（`audit.jsonl` 里出现没有回答的 instruction id）；
4. 房间数增长时内存单调上升（有界环未生效）；
5. `dedupe.evicted` 持续增长且伴随重复投递（环容量不足的新证据）。

**备份路径（改动前已落盘，绝对路径 + 时间戳）**

```
<workdir>\.dsh-backups\dsh-20260914-150127\src\host\service.ts     （0.1.38 源）
<workdir>\.dsh-backups\dsh-20260914-150127\lib\host\service.js     （0.1.38 构建产物）
<workdir>\.dsh-backups\dsh-20260914-150127\package.json
<workdir>\.dsh-backups\dsh-20260914-150127\new-0.1.39-service.js   （0.1.39 构建产物副本，用于 OLD/NEW 对照后恢复）
```

**回滚命令**

```powershell
$repo = (Resolve-Path '<workdir>\\*\dsh-agent-room').Path
$bk   = '<workdir>\.dsh-backups\dsh-20260914-150127'
Copy-Item "$bk\src\host\service.ts" "$repo\src\host\service.ts" -Force
Copy-Item "$bk\lib\host\service.js" "$repo\lib\host\service.js" -Force
Copy-Item "$bk\package.json"        "$repo\package.json"        -Force
Remove-Item "$repo\src\host\dedupe.ts","$repo\lib\host\dedupe.js" -Force
Remove-Item "$repo\test\dedupe.test.mjs","$repo\test\dedupe-ring.test.mjs" -Force
```

**回滚后校验**：`node <workdir>\_repro-dup-push.mjs --room 01a098a2-…` 回到 `n=2`（同毫秒）+ 控制帧 `n=1` + `RESULT: OLD BEHAVIOUR`；`node <workdir>\_repro-dup-push-inproc.mjs` 同样回到 `n=2 / 控制帧 1`（本版 §4.2 已把这条 OLD 基线跑出来，可直接逐字比对）。

**回滚不了的部分**：① 已经落进房间 append-only 历史的消息撤不回（本版探针写了 `seq 2374/2375/2376/2377`，与卡 v2 的 `2335/2336/2358/2359/2360/2368/2369` 同属取证残留）；② **控制帧在两侧 UI 里不再可见**这件事只有回滚才能逆转（旧 UI 里两侧都能看到 `[org:*]` 行，卡实测两侧都在漏）；③ 若去重环已经吃过帧，被丢的帧**没有落盘副本**，无法事后补投 —— 故本版把 `skipped`/`evicted` 都做成可观测数字，先看计数再谈丢弃是否合理；④ 行号口径：本卡与卡⓪v3 都改 `src/host/service.ts`，**必须同批编译**，只回滚其中一张会让另一张的行号全部失准（重跑 `_probe-doublepush-map.mjs` 重新取号）。
