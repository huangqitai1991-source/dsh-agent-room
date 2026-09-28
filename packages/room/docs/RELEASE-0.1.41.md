# dsh-agent-room 0.1.41 — 唤醒层重复唤醒（同一条旧消息把本机自己烧掉 18 轮，且被标成「人类最高优先级」）

发布目标：`card-04-duplicate-wake-notification-v2.md`（实施卡）+ `card-04-scores-and-final-design.md`（**定稿，覆盖卡内 TTL 方案**）+ `card-template.md` 的发布门禁。
发布说明：本版**只做**这一件事。**不动**投递面去重（0.1.39）、**不动** org/exec 对房间总线的订阅、**不动** BOM/身份安全（0.1.38）、**不动**镜像收敛（0.1.35）、**不动** self-join 守卫（0.1.37）。**不改协议**，**不改写盘格式**。

---

## 1. 缺陷（一句话）

房间 `01a098a2-2015-7a1d-b5f7-9eca45afa65d` 的**同一条**消息（`seq=315`、作者 = 本机自己的 agentId
`01a0231b-bbe5-720a-97a4-819744eeae76`、`human:true`、`ts=2026-09-13T09:28:50.994Z`）把**它自己的作者机**唤醒了 **18 次**
（首次再唤醒距该消息写入 **6415 s ≈ 1 h 47 min**，每次唤醒后 **0.39 s** 起一整轮 `step/start`），
而提示词把这条**机器自产**的发言称作「**人类发言（远程指挥，最高优先级）**」。

成因是两条各自独立、都必须修掉的规则缺口：

1. **唤醒面没有 `(roomId, seq)` 规则。** 唯一游标 `listenSeen` 的注释写着「each message wakes at most once」，
   实现却是**无条件**用「本机最近 20 条窗口的尾巴」覆盖它（`service.ts:857`，0.1.40）。本机镜像一旦落后于房主
   （实测：成员侧本地尾巴 **15 条** seq 2380…2482，房主权威库 **2200+** 条），尾巴就变小、**游标跟着后退**，
   已唤醒过的旧 seq 又落回 `fresh` 区间。新唤醒又 `createUserMessage(...)` 造**全新 id**，
   下游按 message id 去重（`inbox.js:176-182`）**不可能**合并两次唤醒（卡 §2.1 E3）。
2. **标签是常量，规则层只看 `human`。** `const kind = "人类发言（远程指挥，最高优先级）"` 与作者无关；
   而 web 客户端每次浏览器发送都带 `human:true` 且 `from = identity.agentId`（`client/index.tsx:441-458`）。
   ⇒「本机自己发的消息 → 被自己的监听唤醒 → 被描述成人类最高优先级指令」是**必然路径**，不是偶发。

**范围（用于判据）**：同一 `(roomId, seq)` = `(01a098a2-…, 315)`；生产实测 18 次；间隔 89.6 s。
`89.6 s ≈ 60 s（`listenPending` 复位）+ 30 s（sweep 周期）`——即「复位后下一个 tick 又判定这条旧 seq 需要醒」。

## 2. 修复后的语义（本版契约）

| 观测 | 0.1.40（旧） | 0.1.41（新） |
|---|---|---|
| 同一 `(roomId, seq)` 的唤醒次数 | 每 ~90 s 一次，**无上界**（实测 25.5 min 内 18 次） | **至多 1 次，永不过期** |
| 唤醒水位线 | `listenSeen` 被本机 20 条窗口尾巴**无条件覆盖**，会后退 | ① `listenSeen` 只进不退（`if (lastSeq > seen)`）；② **新增**独立单调水位线 `WakeWatermark`（只升不降、不过期、不后退） |
| 本机自己发的消息（`from === 本机 agentId`） | 规则层只看 `human:true` → **被接受**；标签恒为「人类发言（远程指挥，最高优先级）」 | 规则层按作者短路 → **不唤醒**（留 `skipped seq=X (self-authored)` 一行 + `wake.selfAuthored` 计数）；标签由同一条规则推导 |
| 唤醒日志 | `listening: waking agent in <room> (seq=X, from=…)` | `listening: woken seq=X in <room> (from=…)` / `listening: skipped seq=X (dedupe) in <room>` |
| `GET /agent-room-api/state` | `dedupe.{…}`（0.1.39） | `dedupe.{…}` **+** `wake.{ rooms, woken, skipped, selfAuthored, humanClaims, regressed, roomResets, maxRooms }` |
| 内存 | 每房间一个数字（但会后退） | 每房间**一个数字**，房间上限 **128**，超限整体重置（与投递面同一形状、同一预算） |
| 远端人类指令（另一端浏览器） | 唤醒 | **不变**：仍唤醒，仍标「人类发言（远程指挥，最高优先级）」 |
| 远端 agent 发言（`human` 非 true） | 不唤醒 | **不变**：不唤醒 |

## 3. 为什么是「单调水位线」而不是 TTL（定稿采纳）

原卡提议 `(roomId, seq)` + **300 s TTL**。两位独立评委（D 84、A 88）先后否决，理由是同一条：

> **回退跨度没有上界** —— TTL 是有限的，回退是随机的。
> 实测：成员侧本地尾巴 **15 条**（seq 2380…2482）vs 房主权威库 **2200+ 条**。
> 把 TTL 调到覆盖 2200+ 条 ⇒ 等于没有 TTL，并且引入「长时间不唤醒」的另一类缺陷。

定稿因此改为：**键 = `(roomId, seq)`；水位线按 seq 单调、只能升不能降、永不过期；内存有界；计数器对外暴露。**
本版的形状：房主**单调**分配 seq ⇒「本机醒过的最高 seq」这条规则**构造上正确**：任何 `seq ≤ 水位线` 的消息都写在这条
本机已经为之后醒过的消息之前，**不可能是新指令**；且它不会过期，所以不会在安静期之后悄悄重新打开缺陷。

## 4. 发布门禁：先复现旧行为，再证明新行为（CASE A–F）

**门禁脚本**（同一场景、同一份假房间状态，两侧都用**真代码**，不是重写的近似版）：

```powershell
PS> cd <workdir>; node _repro-wake-plane-0.1.41.mjs
```

- **OLD 侧** = **已部署的 0.1.40 构建**（`<home>\.dsh\profiles\web\node_modules\dsh-agent-room\lib\host\service.js`，
  sha256[0:16]=`00f2aee5f3595e1c`，97589 B，**无** `lib/host/wake.js`）。规则层 / 游标写入 / 唤醒标签由正则从该构建产物
  **逐字抽取后直接执行**（`new Function`），构建一变就 FATAL 退出 ⇒ OLD 侧不可能与产出缺陷的那份代码漂移。
- **NEW 侧** = **本仓 0.1.41 构建产物**（`lib/host/wake.js` 直接 import，`lib/host/service.js` 同样逐字抽取后执行）。
- **假房间状态**：房主权威值恒为 315；本机 20 行窗口的尾巴**每 3 个 sweep 回退一次到 300**（= 实测的镜像回退形状）。
  三轮相位全部扫描，先量再选，**不挑对结论有利的相位**。

### CASE A — OLD 行为必须**先失败**（同一 seq 被反复唤醒）

```
=== [OLD] phase scan: where the regressed sweep sits in the 90 s cycle ===
    phase=0  wakes=18  gaps(s)=90, 90, 90, 90, 90, 90, ...
    phase=1  wakes=16  gaps(s)=90, 90, 90, 90, 90, 180, ...
    phase=2  wakes=17  gaps(s)=90, 90, 90, 90, 90, 90, ...
  the measured production cadence is 89.6 s (card §3); phase 0 lands on 90 s
  -> phase 0 is used for BOTH planes below (same scenario, same state)

=== [OLD] the measured production shape: one regressed sweep per 90 s cycle ===
  room=01a098a2  message seq=315 (author D, human:true) — the owner's store held it throughout
  fake room state: local 20-row window tail = 315, except every 3rd sweep where the mirror reports 300
  (first 14 of 21 events)
    t=+0s  seed listenSeen=300 (regressed=true)
    t=+30s  WOKE seq=315 msgId=msg-1  (label: 人类发言（远程指挥，最高优先级）)
    t=+120s  WOKE seq=315 msgId=msg-2  (label: 人类发言（远程指挥，最高优先级）)
    t=+210s  WOKE seq=315 msgId=msg-3  (label: 人类发言（远程指挥，最高优先级）)
    t=+300s  WOKE seq=315 msgId=msg-4  (label: 人类发言（远程指挥，最高优先级）)
    t=+390s  WOKE seq=315 msgId=msg-5  (label: 人类发言（远程指挥，最高优先级）)
    t=+480s  WOKE seq=315 msgId=msg-6  (label: 人类发言（远程指挥，最高优先级）)
    t=+570s  WOKE seq=315 msgId=msg-7  (label: 人类发言（远程指挥，最高优先级）)
    t=+630s  RE-LISTEN: listenSeen deleted, re-seeded from the REGRESSED tail 300
    t=+630s  seed listenSeen=300 (regressed=true)
    t=+660s  WOKE seq=315 msgId=msg-8  (label: 人类发言（远程指挥，最高优先级）)
    t=+750s  WOKE seq=315 msgId=msg-9  (label: 人类发言（远程指挥，最高优先级）)
    t=+840s  WOKE seq=315 msgId=msg-10  (label: 人类发言（远程指挥，最高优先级）)
    t=+930s  WOKE seq=315 msgId=msg-11  (label: 人类发言（远程指挥，最高优先级）)
    ...
  total wakes of seq=315 over 53 sweeps (26.5 min): 18
  distinct message ids created: 18  (one per wake: nothing downstream can collapse them — card 04 §2.1 E3)
  inter-wake gaps (s): 90, 90, 90, 90, 90, 90, 90, 90   (measured in production: 89.6 s)
  skips logged: 0   (the wake path had no (roomId, seq) rule to log one)
  listenSeen at the end: 315   <- it moved BACKWARDS to 300 during the run

  ok   OLD reproduces: one already-processed seq wakes repeatedly  -> wakes=18
  ok   OLD re-wake cadence is one re-wake per 60 s re-arm + 30 s sweep (the measured 89.6 s)
```

**OLD 侧复现出的 18 次 / 90 s 与生产实测的 18 次 / 89.6 s 逐项一致**（生产 25.5 min 内 18 次插入）。

### CASE B — NEW 行为：同一场景，唤醒至多一次

```
=== [NEW] same scenario, same fake room state, built 0.1.41 artifacts ===
  (all 5 events)
    t=+0s  seed listenSeen=300 (regressed=true)
    t=+30s  WOKE seq=315 msgId=msg-1  (label: 人类发言（远程指挥，最高优先级）)
    t=+630s  RE-LISTEN: listenSeen deleted, re-seeded from the REGRESSED tail 300
    t=+630s  seed listenSeen=300 (regressed=true)
    t=+660s  listening: skipped seq=315 (dedupe) in 01a098a2-2015-7a1d-b5f7-9eca45afa65d
  total wakes of seq=315: 1
  distinct message ids created: 1
  suppression lines logged: 1  ->  listening: skipped seq=315 (dedupe) in 01a098a2-2015-7a1d-b5f7-9eca45afa65d
  wake watermark (highest seq ever woken) after the run: 315
```

### CASE C — 游标被重置（重监听 / 重启）后**水位线接管**

CASE B 里 `t=+630s` 那一行是关键：`setListening(roomId, true)` 会 `listenSeen.delete(roomId)` 并**从回退的本机尾巴
重新播种**（`service.ts:841`）——这正是**单靠「游标只进不退」修不掉**的路径。0.1.40 在这条路上把 seq 315 又唤醒一次；
0.1.41 由水位线拒绝并逐条留证。⇒ 两个修复是**双保险**，缺一个都会留缺口。

### CASE D — 作者身份：本机自己的消息不再唤醒、也不再被标成人类

```
  ok   D3a [NEW 0.1.41] an own-authored message is NOT accepted by the rule layer  -> rule layer returned nothing
  ok   D3b [NEW 0.1.41] an own-authored message is NOT labelled 人类发言（远程指挥，最高优先级）
       -> label="本机自己发出的消息（不是远程指挥，不需要回应）"
  ok   R1  [NEW 0.1.41] a REMOTE human message still wakes  -> seq=316      <- 合法远程指挥通道没被关掉
  ok   R2  [NEW 0.1.41] a REMOTE agent message (human:false) never wakes
```

旧版对应两行（同一支断言集跑在 0.1.40 上）：

```
  FAIL D3a [OLD 0.1.40] an own-authored message is NOT accepted by the rule layer  -> rule layer returned seq=315
  FAIL D3b [OLD 0.1.40] an own-authored message is NOT labelled 人类发言（远程指挥，最高优先级）
       -> label="人类发言（远程指挥，最高优先级）"
```

### CASE E — 真正更新的 seq **仍然唤醒**（本修复最大的风险面）

```
  ok   D4a [NEW 0.1.41] a genuinely newer seq (316) still wakes  -> seen(316)=false
  ok   D4b [NEW 0.1.41] the already-woken seq (315) does NOT wake  -> seen(315)=true
```

单点拒绝（不是「整房间静音」）、单房间独立（`seen("other-room", 1)=false`），并有单元测试覆盖。

### CASE F — 内存有界

```
  ok   D5 [NEW 0.1.41] memory is bounded (500 rooms -> <= 128 kept)  -> rooms=116 roomResets=3
```

每房间**一个数字**（不是 4096 条 seq 的环：单调规则已经蕴含水位线以下的全部 seq，环在这里买不到东西），
房间上限 128，超限**整体重置**并计数（沿 0.1.39 投递面的既定取舍：重置至多多花一次唤醒，但永不无界增长）。

### CASE G — 新增断言必须在旧版本上**失败**（否则不算断言）

同一支断言集（D1–D5）跑在两个构建上，原始输出：

```
=== the same assertion set, run against BOTH builds ===
-- NEW 0.1.41 --
  ok   D1  an already-woken seq wakes AT MOST ONCE (re-listen included)  -> wakes=1, skips=1
  ok   D2  the watermark does not regress when the local tail jumps backwards  -> mark=315 first=true backwards=false regressed_counter=1
  ok   D3a an own-authored message is NOT accepted by the rule layer
  ok   D3b an own-authored message is NOT labelled 人类发言（远程指挥，最高优先级）
  ok   D4a a genuinely newer seq (316) still wakes
  ok   D4b the already-woken seq (315) does NOT wake
  ok   D5  memory is bounded (500 rooms -> <= 128 kept)  -> rooms=116 roomResets=3

-- OLD 0.1.40 --
  FAIL D1  -> wakes=18, skips=0
  FAIL D2  -> mark=undefined first=false backwards=false (0.1.40 holds no such state)
  FAIL D3a -> rule layer returned seq=315
  FAIL D3b -> label="人类发言（远程指挥，最高优先级）"
  ok   D4a a genuinely newer seq (316) still wakes        <- 两版都过，故**不算**本修复的证据（回归守卫）
  FAIL D4b -> seen(315)=false                              <- 旧版本会再次唤醒已醒过的 seq
  FAIL D5  -> no wake counters on this build

  new assertions on the NEW build : 0 failure(s)
  new assertions on the OLD build : 6 failure(s)
```

### CASE H — 静态接线：规则**确实挂在唤醒判定点**上

半成品实现里 `wake.ts` 写得完整、`service.ts` 也 import 了四个符号，但**一次都没调用**（`seen()`/`mark()`/
`wakeKindLabel()`/`stats()` 全无调用点）。所以本版把「规则在不在判定点上」做成机器判据：

```
=== static wiring: is the new rule actually ON the wake decision point? ===
  ok   W1 seen() sits BEFORE agent.followup() and mark() AFTER it  -> seen=1111 followup=2751 mark=3177
  ok   W2 the prompt label is derived, not a constant
  ok   W3 the cursor guard is monotonic in the shipped artifact
  ok   W4 the wake counters are exposed like the delivery plane's
  ok   W5 the old constant-label wake path is gone

RESULT: GATE SATISFIED (old behaviour reproduced on the shipped 0.1.40 build, removed on 0.1.41,
        and every new assertion shown to fail on the old build)
[exit code: 0]
```

**为什么水位线是「非过期」的**：门禁的 `seen()` 只在 `seq > 水位线` 时放行，且**没有任何时间参数**
（`wake.ts` 里不存在 TTL 字段；`stats()` 里不存在过期计数）。这是定稿的硬要求——回退跨度没有上界，
任何有限 TTL 都能被穿透。

## 5. 标签规则改了**哪一侧**：改「规则判定侧」，**不改**客户端发送侧

**决定**：`pickListenTarget` 增加作者短路（`from === 本机 agentId` ⇒ 不唤醒），**并且**提示词标签改为由同一条规则推导
（`wakeKindLabel(listenAuthorKind(m, identity.agentId))`，常量字面量从提示词模板里删除）。客户端的
`human: true` **保持不动**。

**理由（逐条）**：

1. **客户端的 `human:true` 在语义上是对的**：浏览器里确实坐着一个人，那次点击确实是人发起的。
   把本机浏览器的发送降级为 `human:false`，就会**同时关掉合法通道**（另一端浏览器发来的指令靠的正是同一个标志）。
2. **客户端改动只保护「升级过的机器」**，规则侧改动对**所有对端**生效。当前 5 台机器版本并不同步，
   只要有一台没升级，客户端方案就等于没修。
3. **只有唤醒层同时看得见两个东西**：消息作者与 `identity.agentId`。客户端没有对端视角，
   无法判断「这条是不是我自己产的」。
4. **标签与规则同源**才能真正防复发：本缺陷的一部分正是「规则是 `human`、标签是常量」，两者各走各的。
   现在 `wake.ts` 是唯一事实来源，`test/wake.test.mjs` 有一条静态守卫盯着它。
5. **不做静默丢弃**：自作者消息走 `skipped seq=X (self-authored)` 一行 + `wake.selfAuthored` 计数
   （「记录但不唤醒」），而不是无声消失——否则操作者在浏览器里敲的指令会变成黑箱。

**残余（明写，不隐藏）**：远端**进程**手工构造 `human:true` 直接打 HTTP，在本层与「远端浏览器里的人」
**不可区分**（§2.1 E6）。关掉它需要跨 4 台机的端到端 provenance 字段（协议改动），本版**不做**；
`wake.humanClaims` 把这类主张**计量**出来，使残余可被观测而不是靠争论。

## 6. 改动清单（每个文件一行理由）

| 文件 | 改动 |
|---|---|
| `src/host/wake.ts` | **新增**（半成品已存在，经复核**保留**）。唤醒面收敛规则 + 作者分类 + 标签单一事实来源；文件头写明「为什么不是 TTL」与两个实测数字（15 本地行 vs 2200+ 房主行、89.6 s） |
| `src/host/service.ts` | ① 唤醒判定点（`runListenWake`）加 `wakeWatermark.seen()` 前置守卫：命中即 `skipped seq=X (dedupe)` 一行并 return；② `agent.followup(...)` **确实派发之后**才 `mark()`（此顺序令「没派发就不标记」，避免无唤醒地吞掉一个 seq）；③ `mark()` 拒绝后退时按房间 `warnRateLimited` 告警（`regressed` 是绊线）；④ 游标改为只进不退（`if (lastSeq > seen)`）；⑤ `pickListenTarget(fresh, selfAgentId, onSkip)` 作者短路 + 非静默日志；⑥ 提示词标签由规则推导，删掉常量；⑦ `browserState()` 增加 `wake` 数字诊断块；⑧ 一个数字 `MAX_WAKE_ROOMS` 上限 + 重置告警 |
| `test/wake.test.mjs` | **新增**，8 条：单调不后退 + `regressed` 绊线、已醒 seq 不再唤醒（含游标被重置）、更新的 seq 仍唤醒、内存有界、自作者不唤醒且不被标人类、远端人类/远端 agent 的分类、源码接线守卫、**运行时** `/state` 里 `wake` 块真的存在 |
| `docs/RELEASE-0.1.41.md` | 本文件 |
| `package.json` | 版本 0.1.40 → 0.1.41 |

**明确没做**（并说明为什么）：

- **`wakeWatermark.forget()` 不挂到 leave/离开房间**（与投递面 `dedupe.forget` 不同）：离开或重监听时
  `listenSeen` 会被删除并**从本机（可能已回退的）尾巴重新播种**，那正是水位线必须还活着的时刻。
  把它一起忘掉 = 一重监听就重建缺陷。改由 128 房间上限兜底，代码里写明了这条取反的理由。
- **不动 TTL**：见 §3（定稿否决），`wake.ts` 中不存在任何时间参数。
- **不动协议、不动客户端 `human:true`、不动投递面去重、不动 org/exec 订阅**。
- **不写逐帧日志**：抑制日志只在唤醒边界产生，结构上被 30 s sweep + 60 s 复位限制在
  「每房间每 ~90 s 至多一行、≤128 房间」，比 411 MB 事故的每帧写行低四个数量级；
  两处「绊线告警」（`regressed`/`roomResets`）才走 `warnRateLimited`，且**按房间**做键，
  避免限流器自身的表随 seq 数增长。

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
| `dedupe.test.mjs` | pass 2 / fail 0 | pass 2 / fail 0（**未被本版扰动**） |
| `dedupe-ring.test.mjs` | pass 7 / fail 0 | pass 7 / fail 0 |
| `rename-profile.test.mjs` | pass 16 / fail 0 | pass 16 / fail 0 |
| `wake.test.mjs`（**新增**） | —（旧版本连 `lib/host/wake.js` 都没有，无法加载） | **pass 8 / fail 0** |

`npx tsc --noEmit` 干净（exit 0）；`node build.mjs` 成功（`built lib/host/*, lib/client.js, lib/skills/`）。
> 运行时 stderr 有一行 `[agent-room] backup root <home>\identity-backups is NOT writable (EPERM …)`：
> 本会话文件沙箱不允许写工作区之外，属 **0.1.38 既有行为**（拒写而不是覆盖），与本版改动无关。

## 8. 交付物与复现入口

```powershell
# 门禁（旧行为先复现，新行为后通过；exit 0 = 满足）
node <workdir>\_repro-wake-plane-0.1.41.mjs

# 新增套件（8 条）
node C:\work\项目\dsh-agent-room\test\wake.test.mjs

# 全量回归：逐个 node test/<name>.mjs（见 §7 表）
```

tarball：`dsh-agent-room-0.1.41.tgz`（`npm.cmd pack --ignore-scripts --cache <workdir>\.npm-cache`）。
size / md5 记录在 `<workdir>\_release-0.1.41-artifact.txt` 并随上传一并核对——**tarball 无法自述自身的 md5**，
故不写进本文件（避免「改了 md5 就得重打包、重打包又改 md5」的循环）。

## 9. 本版**没有**验证 / 主动排除的部分（如实列出）

1. **线上（3080）未验证**：本版构建产物没有进入运行中的 `dsh web` 进程（加载需要重启，硬约束禁止启停任何服务）。
   NEW 证据来自**真实构建产物 + 真实部署构建的对照执行**（§4）与**真实服务实例的 `/state` 运行期断言**
   （`test/wake.test.mjs` 第 8 条：启动一个真的 `AgentRoomService`，读它的 `browserState()`）。
2. **真机上的 18 次不会再发生，尚未在活体上观测到**：门禁是进程内模型（真实代码、假房间状态）。
   生产侧的等价比对只有「OLD 侧模型复现出 18 次 / 90 s」这一条。
3. **非房主（成员）侧的唤醒路径未单独实测**：`sweepListening`/`runListenWake` 对 owned/joined 房间是同一条路径
   （差异只在 `recentMessagesFor` 的取数来源），本版未按房间类型分别构造探针。
4. **`diag` 现场直读未取得**：2026-09-13 那 18 行 `seq=` 的原始 `diag` 已被日志轮转吃掉（现存 `studio.log` 仅 743 B）。
   本版用「同一提示词被插入 18 次」+「该提示词对应 seq=315」两条独立实测建立对应关系，**不声称**有直读。
   自证日志（`woken seq=X` / `skipped seq=X (dedupe)`）正是为了下一次不必再做 415,737 帧的转写远征。
5. **第二条注入路径未关闭**：是否存在 sweep 之外的再注入路径仍未判定（需要升级后连续观测 30 分钟的 `studio.log`）。
   本版把 `wake.woken` / `wake.skipped` 做成计数器，就是为了让这件事**可被观测**而不是靠推理。
6. **`wake.regressed` 的生产态标定**：单元测试里为 1（人为触发），生产应为 0；未在活体上观测过长期值。
7. **远端 `human:true` 伪造**：见 §5 残余，本版不做协议层 provenance。
8. **门禁脚本的仓库路径是本机绝对路径**（`C:\work\项目\dsh-agent-room`），跨机重跑需改这一行；
   OLD 侧可用 `ROOM_OLD_BUILD` 环境变量指向任意旧构建。

## 10. 上线与回滚

**上线**（各机自己执行；本版不改协议、不改写盘格式，可与 agent-org 现行版本同批）：

```powershell
# 1) 升级前先归档日志（团队铁律）
node <workdir>\archive-log.cjs --file <该机>\studio.log
# 2) 升级插件（各机看门狗自行拉起）
npm.cmd pack --ignore-scripts --cache <workdir>\.npm-cache      # 产出 dsh-agent-room-0.1.41.tgz
#    （或用已上传的 tarball：/path/to/studio-files/dsh-agent-room-0.1.41.tgz）
# 3) 升级后观测自证日志：同一 seq 只应出现一次 woken，其余为 skipped
type <该机>\studio.log | findstr /C:"woken seq=" /C:"skipped seq="
# 4) 看计数器（wake.regressed 必须长期为 0）
curl -s http://127.0.0.1:3080/agent-room-api/state
```

**回滚触发条件**（任一即回滚）：

1. 本机**新**人类指令不再唤醒（`wake.skipped` 增长而房间并无重复投递）——最危险的一类；
2. 任何一台机器在「远端人类发言」出现后 **TTL 无关地**长期不唤醒（`wake.woken` 停止增长）；
3. `wake.regressed > 0` 且持续增长（说明有调用方绕过了 `seen()`）；
4. 内存随房间数单调上升（房间上限失效）；
5. `dedupe.*`（投递面）出现与 0.1.39 基线不一致的读数——本版不该碰它。

**备份路径（改动前已落盘，绝对路径）**

```
<workdir>\_old-service-0.1.40.ts          （git HEAD 0c92533 的 src/host/service.ts，OLD 侧证据来源）
C:\studio\dsh-agent-room-0.1.40.tgz    （上一版插件包；若本机无此文件，用 git HEAD 重新 build 即可）
```

**回滚命令**

```powershell
$repo = (Resolve-Path '<workdir>\\*\dsh-agent-room').Path
git -C $repo checkout -- src/host/service.ts package.json
Remove-Item "$repo\src\host\wake.ts","$repo\lib\host\wake.js" -Force
Remove-Item "$repo\test\wake.test.mjs" -Force
node "$repo\build.mjs"
```

**回滚后校验**：`node <workdir>\_repro-wake-plane-0.1.41.mjs` 会回到「NEW 侧没有 `lib/host/wake.js`」⇒ 脚本 FATAL 退出码 2
（这是**正确**的失败方式：规则不存在时不假装通过）；`node <workdir>\\*\dsh-agent-room\test\wake.test.mjs` 同样无法加载。

**回滚不了的部分**：① 已经写进各机 session 转写的 18 次历史唤醒记录（不可逆，也不需要逆）；
② 已经排进 agent 收件箱（`next-turn`，持久化）的旧唤醒在被 claim 之前仍在队列里，回滚不会撤回它们；
③ **水位线不落盘（重启即空）**，与 0.1.39 投递面同一取舍（纯内存，卡 §2.4 的收敛表也是这个口径）。
   准确的承诺边界：**同一进程生命周期内，同一条已处理过的 seq 不会被唤醒第二次**。
   跨重启的残余是**有界的一次**：重启后 `listenSeen` 与水位线同时为空，若**第一个** sweep 恰好读到回退的尾巴
   （本缺陷的成因），该 seq 会被唤醒**一次**（不是 18 次，之后水位线立即接管）。
   彻底关掉它需要把水位线落盘/落会话事件，本版**不做**，在此登记为已知残余（触发条件是「重启 + 首个 sweep 就读到回退尾巴」，
   与本次 18 次的机理不同：那是**无上界重复**，这是**至多一次**）。
