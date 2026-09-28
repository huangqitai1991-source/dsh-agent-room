# dsh-agent-room 0.1.43 — 三条修复合并发布（成员唯一记录 / 真活性 / 死房间运行时清理）+ item 4 如实结案

发布目标：`card-05-bridge-snapshot-stale.md`（⑤ / D-19）、`card-06-listening-not-persisted.md`（⑥ / D-22）、
`card-07-member-dedupe.md`（D-21）、`card-08-member-liveness.md`（D-20）、`card-09-dead-room-cleanup.md`（D-18）
以及「通知层重复唤醒」这一项（下称 **item 4**）。

本版是**一次合并发布**：把已经完成的两条工作线合成一版。

| 线 | 分支 | 落地版本 | 内容 |
|---|---|---|---|
| **A** | `main` @ `fdc7072` | **0.1.42**（已在 main） | ⑤ / D-19 桥接快照单一真相来源；⑥ / D-22 `listening` 意图落盘 + 重启恢复 |
| **B** | `feat/d-18-d20-d21` @ `7a2afd2` | **0.1.43**（本版合并进来） | D-21 一个 agentId 一条成员记录；D-20 真活性；D-18 死房间运行时清理；item 4 无法复现（如实记录） |

**不改协议**；**不改既有写盘格式**（只新增成员记录上的可选字段）；**不动**唤醒层单调水位线（0.1.41）、**不动**投递面去重（0.1.39）、
**不动**镜像收敛（0.1.35）、**不动** self-join 守卫（0.1.37）、**不动** BOM/身份安全（0.1.38）。
A 线的两条修复在本版中**逐条重跑门禁复核**（见 §5），确认合并**没有**把它们弄丢。

---

## 1. 缺陷（每条两句话）

**D-21（一个 agentId 出现两条成员记录）**：房间的 `members` 里同一个 `agentId` 可以存在两条记录
（现场就是小捷，`joinedAt` 分别是 `2026-09-14T00:46:52.281Z` / `00:58:31.635Z`，该机地址变了两次）。
**根因不是「重复入会会追加」**，而是**盘上早就存在的重复从来没被修**——`admit()` 的 `else` 分支只 `find()` 到**第一条**匹配并改它，
于是那份陈旧副本永久留在每个读视图里：`memberCount` 虚高、`members.find(agentId)` 命中旧行、`@mention` 因重复抛 `ambiguous-member`。

**D-20（`joinedAt` 被当成活性用）**：成员记录里只有 `joinedAt`（**入会**时间戳），没有任何「最近一次听到这位同事」的字段。
一次现场排查因此付了 3 次 exec 超时（45 s / 25 s / 25 s）+ 一次人工询问的代价——**「下班了」和「插件卡死了」在数据上完全无法区分**。

**D-18（死房间被无限重拨，`joined.json` 留过 boot 清理）**：房主对重连回答**终结性**的 `join rejected` 时，
客户端只 `setConnection("closed")` 就 `return`，**没有动 `left` 标志**；失败那次尝试的 socket 随后异步 `close`，
其 close 处理器又调用 `scheduleReconnect()` 排下一次尝试——1 秒后再次被拒，**如此循环直到进程结束**。
叠加半个清理规则（记录只在下次 boot 或切换连接模式时才被删），一个已死的房间会被**永久重拨**，并在 `joined.json` 里活过 boot 剪枝。

**item 4（通知层重复唤醒）**：**在 0.1.41+ 上无法复现**。这条缺陷属于 **0.1.40**。探针 `test/wake-duplicate.test.mjs` 保留，作为诚实的书面结论（见 §5.4）。

## 2. 修复后的语义（本版契约）

| 观测 | 0.1.41（旧） | 0.1.43（新） |
|---|---|---|
| 同一 `agentId` 的成员记录数 | 可为 2（重复**永不**被修） | **恒为 1**：boot 加载时收敛整房 + 每次 `admit()` 收敛该成员 |
| 旧重复是否被修 | 不修（`find()` 只改第一条） | boot 加载即**收敛并回写**盘（`collapsed N duplicate member record(s)`） |
| 幸存者 | — | `joinedAt` **最新**的那条；角色取**最强**值，`roles`/`capabilities`/`manualCapabilities`/活性字段**逐字段取新** |
| 「这位同事还活着吗」 | 只能看 `joinedAt`（入会时间） | `lastSeenAt` / `lastSeenAddress`（房主**实际**收到过该成员帧的时间/地址） |
| 「能跑命令吗」 | 无从判断 | `lastExecAt` / `lastExecOk`（该成员回报的 `[org:exec:result]` 结果） |
| 地址变更后的记录 | 追加第二条 | **原地更新**为**最新已知**地址（地址是房主**观测**到的传输地址，不是客户端自报） |
| 终结性拒绝后 | socket 关闭 → 1 秒后再拨 → 再被拒 → **无限** | `stopRetrying()` 置 `left` ⇒ **真正终结**：不再拨、停同步环、清心跳、关 socket |
| 拒绝后的本地记录 | 留到下次 boot / 切模式 | **当场**删除（`joinRejected` 事件 + `forgetJoinedRoom`），并 `outbound.drop()` 该房间队列 |
| 被拒客户端的销毁 | 无 | `joinRejected` 后 `client.destroy()`；且服务 `dispose()` 时 `stopRejoinRetries()` 取消所有待发重拨定时器 |

**一个刻意的取舍**：`lastSeenAt` 的**写盘**有 30 s 的最小间隔（`MEMBER_TOUCH_PERSIST_MS`）。
内存中的时间戳**每帧都更新**，只有「比上次落盘晚 30 s 以上」才写房间文件——活性是**诊断量**，不是权威状态，
而每来一帧就整房重写是无谓的写放大。30 s = 3 个 profile 帧（`service.ts` 的 15 s `profileTimer`），
足以把「下班」与「卡死」分开，又让写入速率有界。

## 3. 为什么这样修

1. **D-21 的正确位置是「加载时收敛」**：只修 `admit()` 只能保证**升级之后**新发生的入会不再重复，
   而现场那两条重复记录在盘上、在任何一次新入会之前就已经存在（而且那台机器可能根本不再入会）。
   所以 boot 加载每个自有房间时先 `collapseDuplicateMembers(room)`，有收敛就 `saveRoom()` 回写——
   让不变量对**已经在盘上的状态**成立，而不只是对未来的操作成立。
2. **D-20 的字段必须是「观测」而不是「自述」**：`lastSeenAt` 在 `peer-server.ts` 里由房主在
   **唯一的成员帧漏斗**（`handleFrameFrom`）打时间戳。它不是 `joinedAt`（入会），也不是 org 树的 `updatedAt`（编辑戳）。
   `lastSeenAddress` 同理：直连取 `req.socket.remoteAddress`，走中继则记中继地址——
   **「房主实际看到的传输」**，因此既不可伪造，也不会被一个只是「声称换了地址」的客户端留成陈旧值。
3. **`lastExecOk` 必须能表达「未知」**：exec 通道借房间聊天走（`[org:exec:result]` + JSON）。
   解析不出 `ok`（或 `pending:true` 的 202 中间态）时**只**打 `lastExecAt`、**不动** `lastExecOk`——
   **「未知」绝不能被报成 `false`**，否则一个还在跑的命令会被读成失败。
4. **D-18 的两个半边缺一不可**：服务侧删记录**不能**阻止客户端继续拨，客户端停止重拨**也**不会清理 `joined.json`。
   本版两半都做：客户端 `stopRetrying()` 让「终结」真的终结，服务侧 `joinRejected` 处理器当场删记录。
   另外 `rejoinTimers` **被跟踪**，所以 `dispose()` 能取消所有待发的退避重拨——
   一个已被销毁的服务**不该**继续拨号，而且那些定时器是 ref'd 的，会把进程留住。
5. **不做 UI 层补丁**：`members` 在 `service.ts` 里是**整体透传**（`members: room.members`），
   所以字段一旦在持久层被写上，`GET /agent-room-api/state` 与 `room_state` 工具**自动**带上，无需第二处映射。

## 4. 合并本身（一行一个冲突的处置）

`git merge feat/d-18-d20-d21`（base = `45e8984` = 0.1.41）：

- **`src/host/service.ts`——唯一一处真正的代码冲突（1 个 hunk）**，位置是 `joinRoom` 的尾段。
  A 把它原来的两行压成了一次 `this.recordConnInfo(roomId, client);`（单一写入器 + `live !== client` 身份守卫），
  B 在旁新增了 `client.on("joinRejected", …)` 处理器并**保留**了原来那行无守卫的
  `this.connInfo.set(roomId, { state, viaRelay, address })`。
  **处置**：保留 A 的 `recordConnInfo`，**丢掉** B 那行无守卫的 `connInfo.set`（它是 0.1.41 的写法，
  重新引入就等于撤销 ⑤ 的修复），并把 B 的 `joinRejected` 处理器注册在
  `recordConnInfo(...)` + `clients.set(...)` **这一对之前**。
- **`lib/host/service.js`——构建产物冲突，按约定忽略**：取任一侧后 `node build.mjs` 全量重生成。
- **其余文件全部自动合并成功**，无需人工介入：`room-service.ts`（A 的 listening 读写 + B 的 `collapseDuplicateMembers` 都在）、
  `peer-server.ts`、`room-client.ts`、`types.ts`、`tools/index.ts`；
  `persistence.ts` **B 一行未改**，A 的 `loadListening`/`saveListening` 原样保留。
- **一次自我纠正（如实记录）**：我第一版把 `joinRejected` 处理器插在了 `recordConnInfo` 与 `clients.set` **中间**，
  A 的静态守卫随即失败（`bridge-state` 1 条 FAIL：「the join path must record the new client at the moment it becomes live」）。
  这不是守卫太严，而是**它的意图是真的**：`recordConnInfo` 必须在客户端**尚未**成为 live 的那一刻运行，
  才能被「当前无 live 客户端」分支接受；把两行拆开就破坏了这个次序。改为「处理器在前、两行相邻」后通过。
  两行代码语义完全相同（注册是同步的，处理器体只在事件**触发**时才读 `this.clients`，那时 `clients.set` 早已执行）。

## 5. 发布门禁：先量新构建，再量**旧构建**（哪一侧、哪个版本，全部写明）

**门禁脚本**（本版新增/沿用，同一支断言集、两侧都是**真代码**）：

```powershell
PS> powershell -File <workdir>\_probe\run-gate-0143.ps1
```

**OLD 侧 = 已部署的那份安装**：`<home>\.dsh\profiles\web\node_modules\dsh-agent-room\lib`
（**只读**，本版从未写入该路径）。

> **必须纠正一处前提**：任务交办时说该 OLD 侧「现在是一个真的 0.1.42」。**实测不是**——
> 它的 `package.json` 写的是 **`"version": "0.1.41"`**，且 `lib` 里**没有**任何 A 线标记
> （`joinedBridge` / `recordConnInfo` / `joinRejected` / `collapseDuplicateMembers` / `lastSeenAt` 命中数均为 0）。
> 也就是说：**已部署的机器跑的还是 0.1.41，0.1.42 从未被部署过。**
> 本版的门禁因此以 **0.1.41** 为 OLD 基准，并对 A 线也取得了有效对照（A 的字段在 0.1.41 上不存在 ⇒ 旧侧应当失败，
> 事实也确实失败）。证据强度：`<home>\.dsh\profiles\web\node_modules\dsh-agent-room\lib` 与
> `<workdir>\_probe\old-0.1.41\lib` **逐字节相同**（22/22 个文件、大小 + md5 全等），
> 即 OLD 侧就是**产出这些缺陷的那份代码**，不是近似重写版。
> A 线的静态守卫（`AR_SRC`）另指向 `<workdir>\_probe\old-0.1.41\package.json`（真实 0.1.41 源码树，
> `src/host/service.ts` 里 A 线标记命中数 = 0），所以静态断言量的也是**旧源码**。

### 5.1 逐条修复：NEW 失败数 | OLD(0.1.41) 失败数

| 修复 | 套件 | NEW 失败数 | OLD **0.1.41** 失败数 |
|---|---|---|---|
| ⑤ / D-19（A 线，0.1.42 落地，本版复核） | `bridge-state.test.mjs` | **0**（4/4，exit 0） | **3**（1 pass / 3 fail，exit 1） |
| ⑥ / D-22（A 线，0.1.42 落地，本版复核） | `listening.test.mjs` | **0**（6/6，exit 0） | **5**（1 pass / 5 fail，exit 1） |
| D-21 成员唯一记录 | `member-dedupe.test.mjs` | **0**（3/3，exit 0） | **2**（1 pass / 2 fail，exit 1） |
| D-20 真活性 | `liveness.test.mjs` | **0**（4/4，exit 0） | **4**（0 pass / 4 fail，exit 1） |
| D-18 死房间运行时清理 | `stale-room.test.mjs` | **0**（3/3，exit 0） | **1**（2 pass / 1 fail，exit 1，见 5.2） |
| item 4 重复唤醒 | `wake-duplicate.test.mjs` | **0**（6/6，exit 0） | **0**（6/6，exit 0，见 5.4） |

### 5.2 D-18 在 OLD 侧的特殊证据：失败**并且**跑不出汇总

OLD 侧 `stale-room` 的 `D-18.C` 断言失败（「记录必须当场消失」），**而且进程没有打印 runner 汇总、
由套件自己的 30 s 看门狗 `process.exit(1)` 收场**。原因正是本缺陷本身：
0.1.41 上被拒的客户端**每秒重新排一次拨号**，那些定时器是 **ref'd** 的，事件循环因此**永不安静**，
`node:test` 打印不出汇总。所以「没有汇总」在这里**不是**测试基础设施故障，**是缺陷的可观测形态**。
OLD 侧 `tests/pass/fail` 三个数字取不到，失败数按控制台输出行计（`D-18.A` ✓、`D-18.B` ✓、`D-18.C` ✗）。
NEW 侧该套件 **3/3、exit 0、5.9 s 内自然退出**（关键区别：`D-18.C` 的第二次断言——「2.5 s 后房主侧入会次数不再增长」——在旧构建上**无法通过**）。

### 5.3 其余各条在 OLD 侧失败的理由（一句话）

- ⑤：旧构建让**已被替换**的客户端改写桥接记录（`bridge.state=closed` 而链路 `open`）——这正是生产事故的机理；
  加上两条源码守卫（唯一写入器不存在 / join 路径未在成为 live 的那一刻记录）。
- ⑥：旧构建**根本不写** `listening.json`，`POST /listening {on:true}` 对磁盘零影响，重启无从恢复。
- D-21：旧构建不收敛盘上的重复记录，入会也只改第一条。
- D-20：旧构建的成员记录里没有 `lastSeenAt` / `lastExecAt` / `lastExecOk` 字段（`/state` 自然也读不到）。

### 5.4 item 4：OLD(0.1.41) = 0 失败，这是**结论**而不是空白

`wake-duplicate.test.mjs` 在 0.1.41 上 **6/6 通过、exit 0**，在本版新构建上同样 **6/6、exit 0**。
把它指向**真正的 0.1.40**（`<workdir>\_probe\lib-0.1.40\lib`）则 **3 pass / 3 fail、exit 1**，
其中 P1 的实测值是 `followup dispatches = 21 for ONE message (seq 1) over 20 regressed sweeps`
（一条消息被唤醒 21 次）。**结论**：重复唤醒的缺陷存在于 **0.1.40**，
0.1.41 的唤醒层单调水位线**已经**把它关掉了；本版**无法**在 0.1.41/0.1.43 上复现，
因此不存在对应的 0.1.43 代码修复。探针按原样保留备查。

## 6. 改动清单（每个文件一行理由）

| 文件 | 改动 |
|---|---|
| `src/host/room-service.ts` | **B**：新增 `collapseDuplicateMembers()`（boot 加载整房收敛 + `admit()` 收敛该成员，幸存者取 `joinedAt` 最新，逐字段合并）；`joinOwnedRoom`/`admit` 接受并记录**观测到的** `address`（原地更新 `lastSeenAddress`）；新增 `MEMBER_TOUCH_PERSIST_MS = 30_000` 的写盘节流；新成员记 `lastSeenAt`。**A**：listening 意图读写接到持久层（原有） |
| `src/host/peer-server.ts` | **B**：`handleFrameFrom` 里 `touchMember()` 单一漏斗打活性戳；`/api/join` 传 `req.socket.remoteAddress`，中继入会传 `relayAddress`；`chat.send` 用新的 `execResultOk()` 识别 `[org:exec:result]` 并记 `lastExecOk`（解析不出则只记时间） |
| `src/host/room-client.ts` | **B**：新增 `stopRetrying()`（置 `left`、清重拨定时器、停同步环/心跳、关 socket，**不**发 `room.leave`）；`join rejected` 分支改为「发 `joinRejected` 事件 + `stopRetrying()`」（此前该分支不动 `left`，故被无限重拨）；`RoomClientEvents` 增加 `joinRejected` |
| `src/host/service.ts` | **B**：`rejoinTimers` 跟踪 + `stopRejoinRetries()`（`dispose()` 时取消待发重拨；这些定时器**不是** unref 的）；`joinRejected` 处理器（`clients`/`connInfo` 删除、`client.destroy()`、`outbound.drop()`、`forgetJoinedRoom()` 并刷新浏览器状态）。**A**：`recordConnInfo()`/`joinedBridge()`/`bridgeTruth`/`listening` 持久化（原有）。**合并点见 §4** |
| `src/types.ts` | **B**：`Member` 增加可选 `lastSeenAt` / `lastSeenAddress` / `lastExecAt` / `lastExecOk`，并写明「缺失 = 未知，**绝不**等于离线」 |
| `src/tools/index.ts` | **B**：`room_state` 的成员行透出四个活性字段（`undefined` = 未知） |
| `test/member-dedupe.test.mjs` | **新增**，3 条：盘上重复在一次加载后收敛为 1 / 三次改址重入会仍是 1 条且带**最新**地址 / 健康列表不被动（无假阳性） |
| `test/liveness.test.mjs` | **新增**，4 条：入会打 `lastSeenAt`+`lastSeenAddress` 且后续 touch **只**动这两项 / `lastExecAt`+`lastExecOk` 区分「可达」与「能跑命令」 / `[org:exec:result]` 帧的识别边界 / 字段真的到达 `GET /agent-room-api/state` |
| `test/stale-room.test.mjs` | **新增**，3 条：boot 剪枝按**入会结果**判定 / 对已死房间 `leave` 返回 200 且删本地记录 / **运行中**被拒的 re-join 当删记录且**不再重拨** |
| `test/wake-duplicate.test.mjs` | **新增**，6 条：item 4 的探针（见 §5.4） |
| `docs/RELEASE-0.1.43.md` | 本文件 |
| `package.json` | 版本 0.1.42 → 0.1.43 |
| `lib/**` | 由 `node build.mjs` 重生成（合并时按约定忽略其冲突） |

**明确没做**：

- 不碰协议、不碰客户端渲染、不碰唤醒/投递/镜像/self-join/BOM 身份等既有面。
- **不重做 org 侧那一半**：`touchNodeLiveness()`（节点侧 `lastSeenAt`）属于**另一个仓库**
  `C:\work\项目\dsh-agent-org`，已在那里提交为 **`048bcf8`**；本版只**不破坏**其房间侧契约
  （即：成员帧仍从同一入口进入、`lastSeenAt` 仍由房主观测打戳）。
- **不部署**：本版只产出 tarball 并上传，不升级任何机器（见 §9、§10.1）。

## 7. 测试计数（`node test/<name>.mjs` 逐个直跑，**从不用** `node --test`）

| 套件 | 0.1.42 | 0.1.43 |
|---|---|---|
| `protocol.test.mjs` | pass 8 / fail 0 | pass 8 / fail 0 |
| `snapshot.test.mjs` | pass 4 / fail 0 | pass 4 / fail 0 |
| `outbound.test.mjs` | pass 10 / fail 0 | pass 10 / fail 0 |
| `sendchat.test.mjs` | pass 4 / fail 0 | pass 4 / fail 0 |
| `backfill.test.mjs` | pass 10 / fail 0 | pass 10 / fail 0 |
| `backfill.e2e.mjs`（注意：**无** `.test`） | pass 3 / fail 0 | pass 3 / fail 0 |
| `amplification.test.mjs` | pass 2 / fail 0 | pass 2 / fail 0 |
| `selfjoin.test.mjs` | pass 2 / fail 0 | pass 2 / fail 0 |
| `bom-identity.test.mjs` | pass 14 / fail 0 | pass 14 / fail 0 |
| `dedupe.test.mjs` | pass 2 / fail 0 | pass 2 / fail 0 |
| `dedupe-ring.test.mjs` | pass 7 / fail 0 | pass 7 / fail 0 |
| `rename-profile.test.mjs` | pass 16 / fail 0 | pass 16 / fail 0 |
| `wake.test.mjs` | pass 8 / fail 0 | pass 8 / fail 0 |
| `bridge-state.test.mjs`（A 线） | pass 4 / fail 0 | **pass 4 / fail 0**（合并后复核） |
| `listening.test.mjs`（A 线） | pass 6 / fail 0 | **pass 6 / fail 0**（合并后复核） |
| `member-dedupe.test.mjs`（**新增**） | — | **pass 3 / fail 0** |
| `liveness.test.mjs`（**新增**） | — | **pass 4 / fail 0** |
| `stale-room.test.mjs`（**新增**） | — | **pass 3 / fail 0** |
| `wake-duplicate.test.mjs`（**新增**） | — | **pass 6 / fail 0** |

**合计 18 套件 / 116 pass / 0 fail，全部退出码 0，全部快速自然退出**
（最慢 `backfill.e2e` 8.8 s，其次 `listening` 6.8 s、`stale-room` 5.9 s；没有任何套件挂住或触发看门狗）。

`npx tsc --noEmit` 干净（exit 0）；`node build.mjs` 成功（`built lib/host/*, lib/client.js, lib/skills/`）。

> 运行时 stderr 有一行 `[agent-room] backup root <home>\identity-backups is NOT writable (EPERM …)`：
> 本会话文件沙箱不允许写工作区之外，属 **0.1.38 既有行为**（拒写而不是覆盖），与本版改动无关。

## 8. 交付物与复现入口

```powershell
# 门禁（同一断言集跑两侧：NEW 全过、OLD(0.1.41) 失败；含 item 4 的 0.1.40 复现）
powershell -File <workdir>\_probe\run-gate-0143.ps1
# 本次门禁的原始日志与汇总
#   <workdir>\_probe\gate-logs-0143\            （逐套件 out/err/exit code）
#   <workdir>\_probe\gate-logs-0143\SUMMARY.txt （NEW vs OLD 数字一览）

# 逐个直跑（见 §7 表）
node C:\work\项目\dsh-agent-room\test\<name>.mjs
```

tarball：`dsh-agent-room-0.1.43.tgz`（`npm.cmd pack --ignore-scripts --cache <workdir>\.npm-cache`）。
name / size / md5 记录在 `<workdir>\_release-0.1.43-artifact.txt` 并随上传一并核对——**tarball 无法自述自身的 md5**，
故不写进本文件（避免「改了 md5 就得重打包、重打包又改 md5」的循环）。
打包前已用 `tar -tzf` 证明包里**没有**任何暂存路径（`lib-old`、`lib-old-0.1.4x`、`_probe`）。

> **关于 `dsh-agent-room-0.1.42.tgz`**：它仍然是一份**有效的「单线」审计工件**——
> 它是线 A（⑤ / D-19 + ⑥ / D-22）**独立成版**的凭证，可以单独查验「桥接单一真相来源 + listening 落盘」这两条修复，
> 与线 B 的改动无关。**但车队不会部署它**：本版 0.1.43 是这两条线的**合并版本**，
> 它同时包含 A 与 B 的全部修复。要部署就部署 0.1.43；0.1.42 仅作审计留档，**不要**选它上线。

## 9. 上线与回滚

**上线**（各机自己执行；本版不改协议、不改既有写盘格式，可与 agent-org 现行版本同批）：

```powershell
# 1) 升级前先归档日志（团队铁律）
node <workdir>\archive-log.cjs --file <该机>\studio.log
# 2) 升级插件（各机看门狗自行拉起）
#    用已上传的 tarball：/path/to/studio-files/dsh-agent-room-0.1.43.tgz
# 3) 升级后立刻读状态：成员活性与桥接字段都应出现
curl -s http://127.0.0.1:3080/agent-room-api/state
#    看 rooms[].members[].lastSeenAt / lastSeenAddress / lastExecAt / lastExecOk
#    与 rooms[].bridge.kind/state/address + bridgeTruth.{connDrops,connReplaced,tracked}
# 4) 成员去重：members[] 里同一 agentId 必须**只出现一次**（老重复应在 boot 时被收敛并回写，
#    日志里能看到 room <id>: collapsed N duplicate member record(s)）
# 5) 死房间：对已关闭的房间，state 里不应再有该房间的 joined 记录；
#    房主日志里对被拒的 re-join 不应出现每秒一次的重试
```

**回滚触发条件**（任一即回滚）：

1. 同一 `agentId` 在 `members[]` 里仍出现两次，或 `@mention` 仍抛 `ambiguous-member`（D-21 未生效）；
2. `lastSeenAt` 存在但**永不前进**（活性戳没打在真正的帧漏斗上），或一个仍在跑的命令被记成 `lastExecOk=false`（把「未知」报成「失败」）；
3. 对已死房间的入会次数在 2.5 s 内继续增长（说明「终结」仍不终结，重拨循环回来了）；
4. `members[].lastSeenAddress` 被**客户端自报**的值覆盖（本版契约是房主**观测**到的地址）；
5. 升级后 boot 崩溃或房间加载失败（D-21 的收敛写盘**不允许**弄挂启动）。

**回滚命令**

```powershell
$repo = (Resolve-Path '<workdir>\\*\dsh-agent-room').Path
git -C $repo revert --no-edit <本版合并提交 hash>      # 合并提交，revert 一次即回到 0.1.42 状态
node "$repo\build.mjs"
```

**回滚后校验**：`node <workdir>\_probe\run-gate-0143.ps1` 会在 OLD 侧复现 D-18/D-20/D-21 的旧行为
（无限重拨、无活性字段、重复成员记录），而 NEW 侧（即回滚后的树）会退化为「只剩 A 线两条修复」——
`bridge-state` / `listening` 仍应全过，另外四个套件会随代码一起消失。
**回滚不了的部分**：① D-21 的 **boot 收敛回写**已经改写了各机 dataDir 里的房间文件（回滚不会把重复记录变回来，
但重复本来就是要消掉的，**无副作用**）；② 各机盘上新增的 `lastSeenAt` 等字段在回滚后变成**没人读**的字段（无害）；
③ `bridgeTruth` 计数与活性戳都是内存态，重启即归零。

## 10. 本版**没有**验证 / 主动排除的部分（如实列出）

1. **没有部署、没有启停任何服务**：本会话的硬约束禁止起停任何机器上的任何服务，也禁止 `dsh web`。
   五台机器**全部仍在运行 0.1.41**（部署目录实测 `version: 0.1.41`）。本版只产出并上传 tarball，
   **没有任何一行本版代码进入过运行中的进程**。
2. **全部证据都是进程内（in-process）的**：所有套件在本机 loopback + 临时 dataDir 上起真实 `AgentRoomService`、
   真实 `RoomClient`、真实 HTTP/WS 路由，但**没有**在任何真机上做活体验证。
3. **`item 4` 是「无法复现」，不是「已修复」**：本版**没有**为它写任何产品代码。
   证据只到「0.1.40 复现（一条消息 21 次唤醒）/ 0.1.41 与 0.1.43 均不复现」这一层；
   「0.1.41 的哪一行关掉了它」**未**逐行定位（该结论在 0.1.41 的发布说明中已给出，本版未重新论证）。
4. **D-18 的 OLD 侧缺 runner 汇总**：见 §5.2，OLD 侧失败数按控制台输出行计（2 pass / 1 fail），
   不是从 `tests/pass/fail` 读出的。这是缺陷本身造成的（ref'd 重拨定时器挂住进程），但**读数强度**弱于其他几条。
5. **活性字段的「新鲜度」未做真机标定**：30 s 的写盘节流、以及 `lastSeenAt` 是否足够灵敏地区分
   「下班」与「插件卡死」，都**没有**在真机上按现场节奏量过（真机量需要部署，见第 1 条）。
6. **`lastExecOk` 的契约只按字面匹配实现**：`[org:exec:result]` 前缀**不 import** agent-org，
   是字面量匹配。若上游改了前缀或载荷形状，本版的行为是**静默地只记时间、不记 `lastExecOk`**（= 未知），
   而不是报错。这个「静默降级」是刻意设计，但**未**用真实的 agent-org 版本做交叉验证。
7. **org 侧那半分未在本版验证**：`touchNodeLiveness()`（agent-org @ `048bcf8`）在本版中**只被保证不被破坏**
   （沿用同一帧入口），**没有**跑过跨仓的端到端联合套件。
8. **合并的机械正确性靠测试证明，不靠 diff 审阅**：两线重叠只有 1 个 hunk（§4），
   但「没有别的语义丢失」是由 **18 个套件 116 条断言全过 + tsc 干净**来支撑的，
   而不是由逐行对读两份 diff 支撑的——本版**没有**做完整的三方逐行审阅。
9. **门禁脚本的仓库路径是本机解析的**（`Resolve-Path '<workdir>\\*\dsh-agent-room'`），跨机重跑需确认该通配只匹配一个仓库；
   OLD 侧可用 `AR_LIB`（B 线套件）与 `AR_LIB`+`AR_SRC`（A 线套件）指向任意旧构建与旧源码。
