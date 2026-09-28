# dsh-agent-room 0.1.42 — 桥接快照说「已关闭的中继」而链路是活的 + 重启后 `listening` 静默变哑

发布目标：`card-05-bridge-snapshot-stale.md`（⑤ / D-19）+ `card-06-listening-not-persisted.md`（⑥ / D-22）+ `card-template.md` 的发布门禁。
发布说明：本版**只做**这两件事。**不改协议**，**不改既有写盘格式**（只新增一个偏好文件），**不动**唤醒层单调水位线（0.1.41）、**不动**投递面去重（0.1.39）、**不动**镜像收敛（0.1.35）、**不动** self-join 守卫（0.1.37）、**不动** BOM/身份安全（0.1.38）。

> 本版还包含一项**发布基础设施**改动：两个新套件此前**跑完全部断言却不退出**（进程被自己泄漏的句柄挂住），
> 于是整个发布流水线从未跑起来。§5 把它作为本版独立的一节写清楚（原因 + 修法 + 证据），因为**它就是本版真正的阻塞点**。

---

## 1. 缺陷（两句话）

**⑤ / D-19（快照自述与实际链路不一致）**：切换连接模式（中继 ⇄ 局域网）时 `setConnectionMode()` 会对每个已加入房间
重新 `gateway.joinRoom()`，而该路径会**销毁旧 `RoomClient`、替换成新的**；`connInfo` 是每房间**一条记录**，
旧客户端的 `connection` 回调（socket 的 `close`/`reconnecting` 事件是**异步**到达的）在替换之后仍然写入这条记录
⇒ 记录的**最后一个写入者可能是已经死掉的那条连接**。生产实测（CC）：切到局域网后 `ok:true`，
3 s 后复读仍是 `bridge={"kind":"relay","state":"closed",...}`，而同一时刻 `POST /chat` 返回 `confirmedByOwner:true, confirmedSeq:2518`
——**界面说掉线、链路是活的**。主控没复现，是因为在那台机器上新连接的写入恰好落在最后：这是一个**末位写入者竞赛**，不是机器差异。

**⑥ / D-22（`listening` 不落盘，重启即哑）**：`listeningRooms` 是纯内存 `Set`，**任何**进程重启（升级、崩溃、手动重启）都会丢掉它，
而唯一补偿是升级脚本里 **fail-soft** 的 Auto-wake 步骤。实测同一脚本两台机器不同结果：主控 `AUTO-WAKE: 2 of 2 room(s) re-opened` ✓，
BB升级到 0.1.40 后 `listening=false` ✗（`room=0.1.40 org=0.2.12 relay=off joined=YES listening=false bridge=direct/open`），
要靠总控兜底 exec 救回。**哑掉的机器不会报警，它只是不再收到房间指令。**

## 2. 修复后的语义（本版契约）

| 观测 | 0.1.41（旧） | 0.1.42（新） |
|---|---|---|
| 模式切换后 `rooms[].bridge` | 可能被**已替换**的客户端改写（`relay/closed` 而链路 `open`） | 只有**当前 live 客户端**能写这条记录；被替换者的写入被**拒绝并计数**（`connDrops`） |
| `bridge` 的真相来源 | 记录（`connInfo`）是唯一来源，可被死连接污染 | **一个来源**：快照先读 **live 客户端**，再退回记录（`joinedBridge()`）；两者由构造保持一致 |
| `bridge` 与 `confirmedByOwner` | 可互相矛盾（生产事故） | **不可能矛盾**：同一台机器上 `bridge.kind/state/address` 由 live 客户端推导 |
| `/state` 诊断 | 无 | 新增 `bridgeTruth: { connDrops, connReplaced, tracked }`（拒绝写入数 / 替换次数 / 记录条数），使这类覆盖**可观测**而不是靠推理 |
| `listening` 是否落盘 | **不落盘**，重启即空 | 落盘 `dataDir/listening.json`（`{"rooms":[…]}`，原子写），粒度 = **profile × roomId**（与 `joined.json` 同粒度） |
| 重启后 `listening` | 靠外部脚本（fail-soft，可能静默失败） | **无需任何外部脚本**即恢复为重启前的意图 |
| 显式关闭后重启 | 无此概念（本来就是空的） | **保持关闭**（`{"rooms":[]}`，绝不强开） |
| OWNED 房间 | — | 从不恢复（该节点自己就是房主，浏览器不给这个开关，恢复它没有意义） |
| 旧 `listening.json`（无 `rooms` / 不是 JSON / 读不了） | — | 视为**未监听**且**不抛错**（偏好文件不允许弄坏启动） |

## 3. 为什么是「单一真相来源」+「意图落盘」

1. **⑤ 的根因是「两个真相」**：房间对象里的 `bridge` 与 `connInfo` 记录各写各的，而记录可以被死连接污染。
   本版把读取端也收敛到 live 客户端（`joinedBridge()`），并把写入端加上**身份守卫**（`recordConnInfo()`：
   `live !== client` ⇒ 计数并丢弃），使「记录」不再是一个**可能说谎的**真相。
2. **不做 UI 补丁**：`client/theme.ts` 的 `bridgeLabel()` 只负责把 `kind/state` 渲染成文字，快照对了它就对了；
   再加一层 UI 校正只会再造一个真相。
3. **⑥ 的关键是「意图」而不是「状态」**：用户按下的开关是**意图**，重启后应当延续；落盘的是**意图**（房间 id 集合），
   恢复时再与实际房间表对照，因此 OWNED 房间自然被跳过。失败语义也必须是**明确的**：
   `persistence.ts` 把读不了的偏好文件当作「没有意图」（`[]`），而不是抛错——**boot 不允许被一个偏好文件弄挂**。

## 4. 发布门禁：先复现旧行为，再证明新行为

**门禁脚本**（同一支断言集、两侧都是**真代码**）：

```powershell
PS> powershell -File <workdir>\_probe\run-gate.ps1
```

- **OLD 侧** = **已部署的 0.1.41 安装**：`<home>\.dsh\profiles\web\node_modules\dsh-agent-room\lib`
  （`lib/host/service.js` = **106278 B**，sha256[0:16]=`E4CA4DC077BA1DD8`，**只读**，从不写入）。
  证据强度：仓库里那份用于对照的 `lib-old-0.1.41/` 与部署安装**逐字节相同**（`service.js`/`persistence.js`/`room-service.js`
  三份 sha256[0:16] 全部一致：`E4CA4DC077BA1DD8` / `267BE226EC314D5F` / `848F549DD69A7678`），
  即 OLD 侧就是**产出该缺陷的那份构建**,不是近似重写版。
- **NEW 侧** = 本仓 `node build.mjs` 的产出（`lib/`）+ 本仓 `src/`。
- 两侧都通过套件自身的 `AR_LIB` / `AR_SRC` 环境变量切换（`AR_SRC` 指向 0.1.41 的源码树，
  由 `git archive 45e8984` 取出，静态守卫因此也在量**旧源码**）。

### CASE A — ⑤ 旧行为**必须先失败**（被替换的客户端改写了记录）

同一套件在 OLD 侧的原始终端输出（断言失败原文）：

```
FAIL bridge follows the LIVE connection after a re-join, and cannot be rewritten by the dead one (0.1.42)
     | AssertionError [ERR_ASSERTION]: a REPLACED client overwrote the bridge record — this is card ⑤ / D-19
     | + actual - expected
     | {
     | +   address: '192.168.137.1:19611',      <- 已替换掉的旧地址
     | -   address: '127.0.0.1:19611',          <- 实际在用的地址
     |   kind: 'direct',
     | +   state: 'closed'                      <- 链路是 open，记录说 closed
     | -   state: 'open'
     | }
```

**这就是生产事故的机理本身**：`bridge.state=closed` 与 `confirmedByOwner=true` 同屏出现的那条判定式（卡⑤ §5）。

### CASE B — ⑤ 新行为：同一场景，桥接跟随 live 连接

NEW 侧同一套件的原始输出：

```
  live client address=127.0.0.1:19611 state=open viaRelay=false | replaced client address=192.168.137.1:19611
  bridge after the re-join settled: {"kind":"direct","state":"open","address":"127.0.0.1:19611"}
  after the replaced client reported "closed": {"kind":"direct","state":"open","address":"127.0.0.1:19611"}
  connDrops=3 (the replaced client's own close already contributed 2) connReplaced=1
  record forced stale, live client open/127.0.0.1:19611 -> {"kind":"direct","state":"open","address":"127.0.0.1:19611"}
```

读法：重连后地址**换成实际连上的那条**；然后把**被替换的**客户端手工 `emit("connection","closed")`
（0.1.41 就是被这一下写花的），快照**一字不变**；被拒绝的写入被**计数**（`connDrops`），替换被计数（`connReplaced`）。
最后一条是「一个真相」的反证：把陈旧记录**手工强行塞回去**（`connInfo.set(..., relay/closed)`），
快照仍然跟随 live 客户端，旧记录**根本读不出来**。

### CASE C — ⑤ 与投递自证一致（不得互相矛盾）

```
  chat: confirmedByOwner=true confirmedSeq=1 | bridge={"kind":"direct","state":"open","address":"127.0.0.1:19611"}
```

卡⑤ §5 的判定式（`bridge.kind/state` 与 `confirmedByOwner` 矛盾）在 NEW 上不成立。
**如实说明**：这一条在 OLD 侧**也是 ok 的**（旧构建在这一具体路径上没让记录被改写），
所以它是**回归守卫**，不构成本修复的证据——与 0.1.41 文档里 D4a 的处理口径一致（两版都过的断言不算证据）。
真正判 OLD 有罪的是 CASE A 那两条。

### CASE D — ⑥ 旧行为：根本没有这个文件

OLD 侧原始终端输出（节选）：

```
  listening.json after POST {on:true}: {"missing":"ENOENT"}
FAIL the listening route writes the intent to disk, and a restart restores it with NO upgrade script (0.1.42)
     | AssertionError: the toggle must persist the intent (only on success)
     | + { missing: 'ENOENT' }
     | - { rooms: [ '01a0a047-e26f-74b7-a2b5-ef313750e2e8' ] }
FAIL two rooms: each keeps its own intent across the restart (per profile × roomId) (0.1.42)
FAIL static guard: the toggle persists, the boot restores, and nothing else writes the intent (0.1.42)
     | AssertionError: setListening must persist the intent
```

即：`POST /listening {on:true}` 在 0.1.41 上**对磁盘没有任何影响**，重启后无从恢复。

### CASE E — ⑥ 新行为：重启恢复 true；显式 OFF + 重启**仍是 false**

NEW 侧原始输出（**两个方向都量**）：

```
  listening.json after POST {on:true}: {"rooms":["01a0a047-a7d9-76fb-bc89-150b40970350"]}
  after restart: svc.isListening=true state.listening=true (0.1.41: false)
  listening.json after POST {on:false}: {"rooms":[]}
  after restart following the explicit OFF: svc.isListening=false state.listening=false
  after restart: 01a0a047=true 01a0a047=false
```

第 2 行是卡的验收判据（无需任何外部脚本，重启即恢复）；第 4 行是**反向断言**（尊重用户意图，不强开）；
第 5 行证明粒度是**每房间**：同一 dataDir 下 A 房恢复 true、B 房保持 false。
**如实说明**：反向断言在 OLD 侧**也**是 FAIL 的，但失败理由平凡（那份文件根本不存在，所以谈不上"强开"）；
它的判别力在 NEW 侧——只有在**会恢复**的实现里，"显式关闭后不恢复"才是一个有内容的断言。

### CASE F — ⑥ 向后兼容：四种坏文件都不许抛错

```
  legacy object without `rooms`: restored=false (expected false, must not throw)
  an explicitly empty record:    restored=false (expected false, must not throw)
  not JSON at all:               restored=false (expected false, must not throw)
  mixed types (only strings count): restored=true (expected true, must not throw)
  owned room 01a0a047: restored=false
```

最后一行是 OWNED 房间：把一份**手工伪造的** `listening.json`（写着该节点自己拥有的房间）放到房主的 dataDir 里再重启，
`isListening` 仍为 false ⇒ 房主不会被一份陈旧意图文件影响。
（OLD 侧第 4 行 `mixed types` 是 FAIL：旧构建不认这个文件，所以任何恢复语义都不成立。）

### CASE G — 同一支断言集跑两侧（FAIL 数即证据本身）

```
=== bridge-state.test.mjs [NEW] ===   exit=0  tests=4 pass=4 fail=0
=== bridge-state.test.mjs [OLD] ===   exit=1  tests=4 pass=1 fail=3
=== listening.test.mjs    [NEW] ===   exit=0  tests=6 pass=6 fail=0
=== listening.test.mjs    [OLD] ===   exit=1  tests=6 pass=1 fail=5

  new assertions on the NEW build : 0 failure(s)
  new assertions on the OLD build : 3 failure(s)   (card ⑤ / D-19)
                                    5 failure(s)   (card ⑥ / D-22)
```

两侧 OLD 运行都拿到了**完整**的 runner 汇总（`tests/pass/fail` 齐全），不是靠人读日志数的。

### CASE H — 静态接线：规则真的挂在写入/恢复点上

两套件各含一条**源码级**守卫（跑在 `src/` 上，OLD 侧跑在 `git archive 45e8984` 取出的旧源码上）：

- ⑤：`recordConnInfo` 这个**唯一**写入器存在；旧的无条件写入语句 `this.connInfo.set(roomId, { state, viaRelay: client.viaRelay, address: client.address });` 已消失；
  守卫必须**比较身份**（`live !== client`）而不只是比存在性；join 路径必须在成为 live 的**那一刻**记录；
  快照必须由 `joinedBridge()` 推导。
- ⑥：`setListening` 必须 persist；boot 必须**显式** `await this.restoreListening()`；
  `service.ts` 中**只有一个** listening 写点，且是**串行链**（`this.listeningSave = this.listeningSave.then(...)`）——
  同一 tick 内两次切换不许互相覆盖（否则文件会描述更旧的那份集合，在下一次重启时幽灵般地打开一个刚被关掉的开关）；
  restore 必须 `continue` 跳过 OWNED 房间；`persistence.ts` 必须只保留 string 项。

## 5. 本版**真正的阻塞点**：两个新套件不退出（已修，附原因与证据）

现象：`node test/bridge-state.test.mjs` / `node test/listening.test.mjs` 的**全部断言都通过**，然后进程**不退出**；
上一次执行到这里就没能跑完发布流水线。诊断与修法（**没有改任何产品语义**）：

1. **真正的泄漏源（listening）**：`boot()` 里的 `void this.autoRejoinJoinedRooms()` 是**发射后不管**的，
   而 `startNode()` 只等两个 interval 定时器出现就返回 ⇒ 重启节点的 `stopNode()` 在**客户端注册之前**就扫过了 `clients`，
   客户端随后才出现并**每 8 s 重连一次、永不停止**（探针实测：`left=false destroyed=false reconnectTimer=true attempt=7` 且还在涨）。
   修法：`startNode()` 增加 `settleBootRejoin()`——按该 dataDir 的 `joined.json` 记录，**等到每个已记录房间都有客户端注册**才返回；
   `stopNode()` 改为**有界多轮**销毁（销毁 → 让出事件循环 → 再扫，直到没有**新**客户端出现；happy path 只多 120 ms）。
2. **第二个泄漏源（失败路径，两侧都会中）**：断言在测试体前半段失败时，后面的语句**整体不执行**，
   于是 `stopNode(owner)` 之类的清理**根本没被调用**（OLD 侧实测残留 **25 个 ref'd 句柄**：`TCPServerWrap`、`UDPWrap`、`Timeout`）。
   修法：两个套件都加了模块级 **`NODES` 注册表** + `after()` 钩子里的**兜底清扫**——每个 `startNode()` 都登记，
   无论测试怎么失败，收尾时把所有还活着的节点真的停掉。
3. **上一版留下的一颗定时炸弹**：文件末尾那个 120 s 看门狗是**ref'd** 的，它保证进程至少活 120 s 再 `exit 1`
   ——「不退出」的观感有它一半功劳。修法：看门狗改为 **unref'd**（结构上不可能成为存活原因）+ 由 `after()` 清理。
4. **诚实的残余**：`after()` 里还留了一个 **300 ms 有界硬退出**，它**不属于**正常路径，而是给「被测量的另一个构建」用的逃生门：
   OLD（0.1.41）构建的客户端会自己重连、且没有服务级 stop()，套件跑完仍可能把进程挂住；
   硬退出是**确定的**（由失败计数器决定退出码）且**大声的**——若触发时仍有 ref'd 句柄，会打印
   `TEARDOWN: bounded exit with N handle(s) still ref'd (...)` 把它们**点名**，不做无声遮掩。
   **NEW 构建上不触发**（实测两个套件都无该行、自然退出、退出码 0），所以它没有在掩盖本构建的泄漏。

验证（有界、可复现）：`bridge-state` **2.1 s / 退出码 0**，`listening` **7.0 s / 退出码 0**，两者**都远低于 30 s**，
且 node 自己的 `tests/pass/fail` 汇总完整打印。

## 6. 改动清单（每个文件一行理由）

| 文件 | 改动 |
|---|---|
| `src/host/service.ts` | ⑤：新增 `recordConnInfo()`（唯一写入器 + `live !== client` 身份守卫 + `connDrops` 计数）、`joinedBridge()`（live 客户端优先）、`connReplaced` 计数、`/state` 增加 `bridgeTruth`；⑥：`listeningFile`、`setListening()` 成功后 `persistListening()`（**串行链**，单写点）、boot 中 `await restoreListening()`（跳过 OWNED 房间）、`sweepListening()` 同源 |
| `src/host/persistence.ts` | ⑥：新增 `listening intent` 段：`loadListening()`（坏文件 ⇒ `[]`，**不抛错**）/ `saveListening()`（原子写 `listening.json`，只留 string 项） |
| `src/host/room-service.ts` | ⑥：把 listening 意图的读写接到既有持久层（与 joined 记录同一 dataDir/同一形状） |
| `test/bridge-state.test.mjs` | **新增**，4 条：重连后桥接跟随 live 连接且**不可被被替换者改写**、与 `confirmedByOwner` 一致、**一个真相**（强制塞回陈旧记录也读不出）、源码静态守卫 |
| `test/listening.test.mjs` | **新增**，6 条：真实路由落盘 + 重启恢复、**显式 OFF 后重启仍 OFF**、两房间各自独立、四种坏文件向后兼容、OWNED 房间不恢复、源码静态守卫 |
| `docs/RELEASE-0.1.42.md` | 本文件 |
| `package.json` | 版本 0.1.41 → 0.1.42 |

两个测试文件**同时**承担 §5 的发布基础设施修复（`settleBootRejoin`、有界多轮销毁、`NODES` 注册表 + `after()` 清扫、
unref'd 看门狗 + 有界硬退出），这是本版能跑完流水线的前提。

**明确没做**：

- **不动协议**、**不动客户端**（`bridgeLabel()` 一行未改）、**不动唤醒层/投递面/镜像/self-join/BOM 身份**。
- **不做 UI 层的第二真相**（理由见 §3.2）。
- **不动 `listeningRooms` 的监听语义本身**（只把意图落盘），**不动唤醒判定**。
- **升级脚本的 fail-loud 自检步（卡⑥ §4.3）不在本仓**：本仓内不存在升级脚本，本版**未改**它（见 §10.6）。

## 7. 测试计数（`node test/<name>.mjs` 逐个直跑，**从不用** `node --test`）

| 套件 | 改动前 | 改动后 |
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
| `bridge-state.test.mjs`（**新增**） | —（旧构建无 `recordConnInfo`/`bridgeTruth`） | **pass 4 / fail 0**，2.1 s，退出码 0 |
| `listening.test.mjs`（**新增**） | —（旧构建连 `listening.json` 都不写） | **pass 6 / fail 0**，7.0 s，退出码 0 |

**合计 15 套件 / 100 pass / 0 fail，全部退出码 0。**

`npx tsc --noEmit` 干净（exit 0）；`node build.mjs` 成功（`built lib/host/*, lib/client.js, lib/skills/`）。
> 运行时 stderr 有一行 `[agent-room] backup root <home>\identity-backups is NOT writable (EPERM …)`：
> 本会话文件沙箱不允许写工作区之外，属 **0.1.38 既有行为**（拒写而不是覆盖），与本版改动无关。

## 8. 交付物与复现入口

```powershell
# 门禁（同一断言集跑两侧；OLD 侧先失败、NEW 侧通过）
powershell -File <workdir>\_probe\run-gate.ps1

# 两个新套件（都必须在 30 s 内自行退出，退出码 0）
node C:\work\项目\dsh-agent-room\test\bridge-state.test.mjs
node C:\work\项目\dsh-agent-room\test\listening.test.mjs

# 全量回归：逐个 node test/<name>.mjs（见 §7 表）
```

tarball：`dsh-agent-room-0.1.42.tgz`（`npm.cmd pack --ignore-scripts --cache <workdir>\.npm-cache`）。
size / md5 记录在 `<workdir>\_release-0.1.42-artifact.txt` 并随上传一并核对——**tarball 无法自述自身的 md5**，
故不写进本文件（避免「改了 md5 就得重打包、重打包又改 md5」的循环）。打包前已把用于对照的临时目录
`lib-old-0.1.41/` **移出仓库**（→ `<workdir>\_probe\lib-old-0.1.41`），并用 `tar -tzf` 证明它不在包里。

## 9. 上线与回滚

**上线**（各机自己执行；本版不改协议、不改既有写盘格式，可与 agent-org 现行版本同批）：

```powershell
# 1) 升级前先归档日志（团队铁律）
node <workdir>\archive-log.cjs --file <该机>\studio.log
# 2) 升级插件（各机看门狗自行拉起）
npm.cmd pack --ignore-scripts --cache <workdir>\.npm-cache      # 产出 dsh-agent-room-0.1.42.tgz
#    （或用已上传的 tarball：/path/to/studio-files/dsh-agent-room-0.1.42.tgz）
# 3) 升级后立刻读状态：桥接字段必须与 confirmedByOwner 一致
curl -s http://127.0.0.1:3080/agent-room-api/state
#    看 rooms[].bridge.kind/state/address 与 bridgeTruth.{connDrops,connReplaced,tracked}
# 4) 切换一次连接模式（局域网 ⇄ 中继）后**再**读一次 state：
#    bridge.address 必须变成刚切到的那个地址，且 state=open（不得停在 relay/closed）
# 5) listening：升级后无需人工干预，state 里该房间必须 listening=true
#    （本版起它是**重启自动恢复**的；若为 false，先看 <dataDir>\listening.json 是否存在/是否被显式置空）
```

**回滚触发条件**（任一即回滚）：

1. 切模式后 `bridge.address` 仍指向旧地址，或 `bridge.state=closed` 而 `confirmedByOwner=true`（=本缺陷未被修掉）；
2. `bridgeTruth.connDrops` 长期不增长而现场仍见陈旧桥接（说明有写入者绕过了 `recordConnInfo`）；
3. 重启后 `listening` 该为 true 的房间变成 false（持久化未生效）；
4. **显式关闭** listening 后重启却恢复成 true（反向断言被破坏——比上一条更危险）；
5. `listening.json` 导致任何一台机器 boot 失败（本版契约是坏文件 ⇒ 视为未监听，**绝不**弄挂启动）。

**回滚命令**

```powershell
$repo = (Resolve-Path '<workdir>\\*\dsh-agent-room').Path
git -C $repo checkout -- src/host/service.ts src/host/persistence.ts src/host/room-service.ts package.json
git -C $repo checkout -- lib/host/service.js lib/host/persistence.js lib/host/room-service.js
Remove-Item "$repo\test\bridge-state.test.mjs","$repo\test\listening.test.mjs" -Force
node "$repo\build.mjs"
```

**回滚后校验**：`node <workdir>\_probe\run-gate.ps1` 会在 OLD 侧复现 ⑤/⑥ 的旧行为（即回到「桥接被死连接改写」「没有
`listening.json`」），而 NEW 侧的 `bridgeTruth` 字段与 `listening.json` 都会消失。
**回滚不了的部分**：① 已经写在各机 dataDir 里的 `listening.json`（回滚后会变成一个**没人读**的偏好文件，无害，
但下一次升级回 0.1.42 时会**立刻生效**——若那时某房间的意图已过期，请手工删除该文件）；
② `bridgeTruth` 计数是**纯内存**的，重启即归零，回滚或升级都不会留下历史。

## 10. 本版**没有**验证 / 主动排除的部分（如实列出）

1. **全部证据都是进程内（in-process）的**：两个新套件在**本机 loopback + 临时 dataDir** 上起真实 `AgentRoomService`、
   真实 `RoomClient`、真实 HTTP 路由，但**没有**在 5 台机器中的任何一台上做活体验证；
   本会话的硬约束禁止启停任何服务，线上 `127.0.0.1:3080` 跑的是 0.1.41，**本次改动没有进入运行中的进程**。
2. **没有真机复现**：卡⑤ 的现场是「CC切局域网后 3 s 仍是 `relay/closed`」，卡⑥ 的现场是「BB升级后 `listening=false`」；
   本版**没有**在任何真机上重放这两条现场命令。OLD 侧的证据来自**部署中的真实 0.1.41 构建**（逐字节核对过），
   这是「同一份代码」的证明，但**不是**「同一台机器、同一次操作」的证明。
3. **没有第三台机器对照**：卡⑤ §2.2 的两台机器差异（主控正常 / CC异常）在本版给出的解释是
   **末位写入者竞赛**（谁的回调最后写进那条记录），该解释与「主控未复现」一致，但**未**在第三台机器上按现场操作复验。
4. **升级/重启路径只在进程级模拟**：套件里的「重启」= 同一 dataDir 上**新建一个 service 实例**（旧实例先真的停掉），
   与真机上的「进程被杀、看门狗拉起」不完全等价（未覆盖断电/半写文件的极端情形；偏好文件的原子写已按既有约定使用）。
5. **`listening.json` 的磁盘持久性未做故障注入**：没有模拟「写入过程中断电」「外部程序同时改这个文件」。
6. **升级脚本的 fail-loud 自检步（卡⑥ §4.3）未做**：本仓不含升级脚本（`upgrade-studio.ps1` / `auto-wake.cjs` 不在此仓库内），
   本版只交付插件包本身。**本版起升级后不再需要那个 Auto-wake 步骤**（重启自恢复），
   但「自检失败必须大声失败（非 0 退出码）」这条要求，仍需要脚本侧改动——**未做**，登记在此。
7. **两个新套件的 300 ms 有界硬退出**（§5.4）在 NEW 构建上不触发，但它是**代码里存在的一条退出路径**：
   若将来 NEW 构建也出现泄漏，它会把泄漏**打印出来**（`TEARDOWN: … still ref'd`）并仍然给出确定退出码，
   而不是静默吞掉——这一设计**未**在「人为注入泄漏」的条件下验证过。
8. **门禁脚本的仓库路径是本机解析的**（`Resolve-Path '<workdir>\\*\dsh-agent-room'`），跨机重跑需确认该通配只匹配一个仓库；
   OLD 侧可用 `AR_LIB` / `AR_SRC` 指向任意旧构建与旧源码。
