# dsh-agent-room 0.1.45 — 静默漏唤（silent wake-drop）：派活必须有一个不依赖 `human` 的结构化信号

发布目标：缺陷 **D-？（本版定名「静默漏唤」）** —— 脚本/exec 投递（`human=false`）的派活消息**不唤醒任何目标机、且不留任何日志**。
本版**只修这一条**：唤醒规则层 + 拒绝留痕 + 发送侧 `woken` 计数 + 「sweep 没看过」的三条路径可见化。**不改协议、不改写盘格式、不动去重环/镜像收敛/self-join/BOM 身份/单调水位线。**

| 组 | 内容 | 落地版本 |
|---|---|---|
| 规则层 | 新增 `decideListenWake`：**点名本机** / `human` 兜底两条放行；拒绝理由：控制帧 / 机器自证帧 / 未点名 | **0.1.45** |
| 可见性 | 每条被拦消息留痕（聊天类逐条命名、总线帧按规则聚合）+ `/state.wake` 新增 9 个扁平计数 | **0.1.45** |
| 窗口 | 唤醒读取窗口 **20 → 200 行**，并把仍落在窗口外的消息**计数 + 命名** | **0.1.45**（评审驱动，见 §12） |
| 发送侧 | `POST /chat` 与 `room_send` 返回 `woken` + `wake{targets,reasons,note}`（0.1.35 字段一个不删） | **0.1.45** |
| 设计取舍 | **没有任何基于作者身份**的放行分支（第一稿有 `作者==controller`，被评审删除） | **0.1.45**（评审驱动，见 §12） |
| 卡 | `<workdir>\card-07-silent-wake-drop.md`（方案卡 ⑦，含全量回放与现场证明） | 本版同步 |

---

## 1. 缺陷（两句话）

**0.1.44 的唤醒规则层只放行 `kind === "human"`（`lib/host/service.js:954-964` ≙ 改动前 `src/host/service.ts:1039-1051`），`kind === "agent"`（远端 `human=false`）既不唤醒也不写日志。** 而**我们自己的派活路径本来就不带 `human`**（`sendFallbackLine` 里 `human = $false`；`room_send` 工具不传该字段）——于是「派活」这条主通道在脚本/exec 投递下**静默失效**：发送侧看到 `confirmedByOwner:true` 以为送达，接收侧一行日志都没有。

**当天代价**：问卷 seq 3267 与催办 seq 3606 唤醒 0 台，四台机器三台没答，控制节点把结论写成「他们收到了但不会动」（见 D-25 更正）。直到人在 GUI 里手动激活小捷，才知道有活。

---

## 2. 修复后的语义（本版契约）

```
wake = 非自身作者(self)                        ← 卡④ 0.1.41，不动
    && 非控制帧([org:*)                         ← protocol.ts:59，复用同一分类器
    && 非机器自证帧                              ← 风暴护栏（短≤160字符、单行、无「？?」、
                                                   无请求动词、带 x.y.z、含 自证|自检|verify）
    && ( 点名本机(mentions[] || @昵称 || @agentId || 裸 agentId || 全角＠)
         || human === true )                    ← 兜底，不再是唯一门槛
被拦的每一条：/state 计数器分类精确计数 + 日志（聊天类逐条命名，上限 20 条/轮；
             控制帧与机器自证帧按规则聚合成 1 行/轮，带条数与 seq）
读取窗口：200 行（0.1.44 是 20 行）；仍落在窗口外的消息 → windowGaps/windowGapMessages + 一行命名
```

**放行只有两条**：点名本机、或作者声明 `human:true`。
**没有任何基于作者身份/角色的放行**——第一稿有「作者 == 房间 controller」，评审（小捷，room seq 3728）用实测数据推翻，见 §12。

| 观测 | 0.1.44（旧） | 0.1.45（新） |
|---|---|---|
| 脚本路径 `human=false` + **点名本机** | **不唤醒、零日志** ✗ | **唤醒**，日志 `woken … rule=mention` ✓ |
| 脚本路径 `human=false` + 点名**别人** | 不唤醒、零日志 ✗ | 不唤醒，日志 `denied … rule=not-addressed` ✓ |
| 脚本路径 `human=false` + **不点名任何人** | 不唤醒、零日志 ✗ | 不唤醒，日志 + 计数 ✓；发送侧 `woken:0` ✓ |
| 房主（controller）发的**未点名**汇报 | 不唤醒（无痕迹） | 不唤醒，`woken:0`（**第一稿会 `woken:4`**，评审删除）✓ |
| 机器自证帧（`小捷升 0.1.43 自证`） | 不唤醒（但**无痕迹**） | 不唤醒，`denied N message(s) (rule=machine-frame, seq=…)` ✓ |
| `[org:*]` 控制帧 | 不唤醒（无痕迹） | 不唤醒，每轮 1 行聚合 + 精确计数 ✓ |
| 自身发言（卡④） | 不唤醒，`skipped (self-authored)` | 不唤醒，`denied … rule=self-authored` ✓（语义不变，措辞统一） |
| `human=true`（0.1.44 的工作通道） | 唤醒 | 唤醒，`rule=human-fallback` ✓（不回归） |
| 两次 sweep 之间落库 > 窗口 | **既不 woken 也不 denied**（完全无痕）✗ | 窗口放大 10 倍；仍超出则 `window gap …` 一行 + `windowGapMessages` 计数 ✓ |
| `listenPending` 窗口内的消息 | 静默跳过 ✗ | 计数 `pendingSkips` + 一行 `sweep skipped (rule=pending)` ✓ |
| 首轮/重进 listening 那一刻的消息 | 静默跳过 ✗ | 计数 `seedSkips` + 一行 `seeded cursor at seq=N` ✓ |
| 发送侧返回 | 只有 `confirmedByOwner`（**无法**区分「送达」与「有人被叫醒」）✗ | 追加 `woken` + `wake{targets,reasons,note}` ✓ |

**没有被保留的写法**：`if (kind === "human") return message;` 与「只有 self 记日志」这两行**从代码里删除**，并由静态断言锁住（`test/wake.test.mjs` 的 0.1.45 static guard，注释剥离后比对，避免误伤引用缺陷原文的注释）。

---

## 3. 为什么这样修（一条一条给理由）

1. **`human` 不可验证，而代码自己承认过。** `wake.ts:90-95` 原文：面向远端作者时「the wire carries only that claim」；`service.ts` 的 `noteHumanClaim()` 注释逐字写着「the wire carries no provenance」。**一个自己都声明不可验证的布尔，不能是唯一门槛。**
2. **点名是本层唯一可验证的信号。** `mentions[]` 由房主解析成 canonical agentId 后入库（`room-service.ts:625-639`），正文 `@` 由收件侧自比对（含全角＠与 `【… → @…】` 形态）；两者都不依赖作者自称。
3. **为什么放行只有「点名」与「human 兜底」两条，没有任何作者身份判据。** 第一稿曾按任务书的「建议」加了 `作者 == 房间 controller` 分支。小捷在评审里（room seq 3728）用实测推翻：**当天 controller（小婷机）发布的 6 条消息（seq 2942/3089/3148/3199/3225/3231）全是状态汇报、没有一条是派活**，该分支会把它们变成「4 台 × 6 = 24 次无效唤醒」，趋势就是唤醒风暴。它的论证与 0.1.41 和本卡同源：**「是不是派活」不能由作者是谁推断** —— 相信作者设的一个布尔，与相信作者的身份，是同一种错误的两层。因此该分支**被删除**，并把「未点名的派活叫不醒任何人」写成契约，由发送侧 `woken:0` 当场暴露（§12 记录了这次改动）。
4. **为什么不认「上级/总控」。** 房间协议里**没有**这个概念：`MemberRole` 只有 `"owner" | "member"`（`types.ts:38`），唯一权威字段是 `Room.controllerAgentId`（`types.ts:135`），房主侧的答案是**小婷**。本版向房主问过口径（只读探测她的 `/state` 与 `rooms/<id>.json`），确认它就是唯一权威——**然后没有把它用作放行条件**（理由同上一条）。组织树里的角色**一律不猜**。
5. **为什么必须有风暴护栏。** 五台机都开着 listening；控制帧在历史里 2172–3400 条/人，机器自证帧 12 条（实测）。若控制帧或自证帧能唤醒，就是唤醒风暴；而 per-frame 放大**已经**让一台机器掉过线（`protocol.ts:44-53`：25,346 帧 / ~90 ms 重连环）。**注意护栏的定位**：它只**拒绝**，从不放行任何东西——放行的理由只有点名与 `human`（这一条是小捷 3728 §2 的意见，已写进代码注释）。
6. **为什么护栏必须是「印记检测」而不是关键词检测。** 关键词（如含 `verify`）会吞掉真实派活。护栏因此要求**同时**满足：短（≤160）、单行、无问号、无请求动词、且带版本号才看 `自证/自检/verify`。实测真实派活正文 3000+ 字符（多行），与自证帧（最长 38 字符）相差两个数量级。
7. **为什么不认「不带 @ 的裸昵称」。** 实测反例：小黄 3703 讨论分工时正文写了「小婷/小麦/小捷」，裸昵称一旦算点名，**一条讨论就唤醒 3 台**。代价是「填写人：小婷、小黄、小麦、小捷」这类清单仍不算点名——由发送侧 `woken:0` 在**发送那一刻**暴露（记入 §10）。
8. **为什么拒绝必须留痕 + 计数，而且日志必须有界。** 411 MB 逐帧日志的教训说明「逐帧记录」不可取；静默则今天花了我们几个小时和一次错误结论。落地的口径是**分层**：`not-addressed` / `self-authored`（真实聊天的拒绝，正是本版要的追溯性）**逐条命名**、上限 20 条/轮；`control-frame` / `machine-frame`（按构造就不是派活，且量不受任何聊天控制：实测 **3 分钟 152 条** `[org:*]`）**按规则聚合成 1 行/轮**，带条数与 seq。**计数永远是精确的**（`/state.wake` 按规则各一项），只有「命名」被限幅。
9. **为什么读取窗口从 20 行放大到 200 行。** 小黄的评审（seq 3729）指出：窗口有限，落在窗口外的消息「既不 woken 也不 denied」——完全无痕。我实测复现了它的近邻条件：一次 exec 风暴期间房间 3 分钟流过 152 条控制帧 ⇒ **旧 20 行窗口 ≈ 24 秒 < 一个 sweep 周期（30 秒）**，即「窗口越过」是常规状态而非边界情况。200 行在实测突发速率（≈50 行/分）下覆盖 ≈4 分钟 ≈ 8 个 sweep 周期。**仍不做无上限回捞**：那会为一批陈旧派活同时唤醒目标机（另一种风暴）；剩余的洞由 `windowGaps` / `windowGapMessages` + 一行 `listening: window gap …` 命名。
10. **为什么发送侧只给「预测」而不是「回执」。** 发送方的节点**结构上**看不到远端唤醒面。做成回执需要 ack 平面（小捷建议 C），本版**明确不做**并把这句话写进返回体的 `wake.note`，避免下一个读这段代码的人把 `woken` 当保证。

---

## 4. 改动清单（每个文件一行理由）

| 文件 | 改动 |
|---|---|
| `src/host/wake.ts` | **新增规则本体**：`WakeReason`/`WakeDecision`/`WakeRuleMessage`/`WakeRuleSelf`、`MIN_MENTION_CHARS=2`、`MACHINE_FRAME_MAX_CHARS=160`、`WAKE_WINDOW_ROWS=200`、`MAX_NAMED_DENIALS_PER_SWEEP=20`、`isMachineSelfTestFrame`、`mentionsThisNode`、`decideListenWake`、`WakePreview`；`WakeWatermark` 新增 `noteDenied`/`noteWokenBy`/`notePendingSkip`/`noteSeedSkip`/`noteWindowGap` 与 **9 个扁平计数键**（`deniedSelfAuthored` 与 `selfAuthored` 是同一计数器的别名，同 `outbound.ts:73-77` 先例） |
| `src/host/service.ts` | `sweepListening`：待命窗口/首轮 seed/窗口缺口三条路径**计数 + 各一行日志**；读取窗口 `20 → WAKE_WINDOW_ROWS`；把拒绝交给新的 `logDenials`（逐条命名有上限、总线帧聚合）；`pickListenTarget` 改为调用 `decideListenWake` 并**对每条被拒候选回调**；`runListenWake` 的 `woken` 行追加 `rule=`；新增 `wakePreviewFor` 并暴露进 gateway |
| `src/tools/gateway.ts` | `RoomGateway` 新增 `wakePreview`（含「这是预测不是回执」的注释） |
| `src/host/web.ts` | `POST /rooms/<id>/chat` 两个返回分支都追加 `woken` + `wake`；0.1.35 字段**一个不删** |
| `src/tools/index.ts` | `room_send` 输出 schema 加 `woken`/`wake`，返回体带上（工具路径也能看见「有没有人会被叫醒」） |
| `test/wake.test.mjs` | `AR_LIB` 感知改造（动态 import，旧构建上断言失败而不是链接报错）+ **新增 9 条断言**：点名唤醒（7 种书写形态）、未点名拒绝且带理由、风暴护栏（5 个真实自证帧 + 5 个反例）、卡④/兜底/**无作者身份放行**、计数器形状、静态守卫、**运行时扫描路径**（唤醒 + 拒绝留痕 + **窗口缺口**）、**运行时 `POST /chat` 的 `woken`**（含 controller 未点名必须 `woken:0`）、**拒绝日志有界性**（60 条控制帧 = 1 行聚合） |
| `package.json` | 版本 0.1.44 → 0.1.45 |
| `lib/**` | `node build.mjs` 重新生成 |
| `docs/RELEASE-0.1.45.md` | 本文件 |
| （工作区，不在包内）`<workdir>\_fix-45\gate-wake-drop.mjs` | 双向门禁脚本：同一套 21 条期望，分别打 0.1.44 装机产物与本版，逐条打印 PASS/FAIL |
| （工作区，不在包内）`<workdir>\card-07-silent-wake-drop.md` | 方案卡 ⑦（机理依据 / 阈值来源 / 判据 / 原始输出 / 回滚 / 跨机 / 自评） |

**明确没做**：不改协议与写盘格式；不动 `dedupe.ts`、镜像收敛、self-join 守卫、BOM/身份安全、单调唤醒水位线；**不做** ack 回执平面（小捷建议 C）；**不修**「房间未监听 / `listenPending` 窗口」这两条同族静默路径（它们是规则层之前的分支，见 §10）。

---

## 5. 发布门禁：先量新构建，再量**旧构建**

### 5.1 同一门禁脚本，两侧对照（`<workdir>\_fix-45\gate-wake-drop.mjs`）

```
PS> node <workdir>\_fix-45\gate-wake-drop.mjs "<home>\.dsh\profiles\web\node_modules\dsh-agent-room\lib"   # OLD = 部署中的 0.1.44
=== summary: 8/21 expectations hold on this build ===      （exit=1）
PS> node <workdir>\_fix-45\gate-wake-drop.mjs "C:\work\项目\dsh-agent-room\lib"                          # NEW = 本版
=== summary: 21/21 expectations hold on this build ===     （exit=0）
```

旧侧最关键的一条原始输出（**这就是缺陷本体**）：

```
[A script-path dispatch that NAMES me (human=false + mention)] seq=1 human=false -> wakes=0
   LOG: (no line at all — this is the silent drop)
FAIL  A … :: wakes  expected=1 actual=0
FAIL  A … :: leaves a listening: line  expected=yes actual=no
```

新侧同一例：

```
[A script-path dispatch that NAMES me (human=false + mention)] seq=1 human=false -> wakes=1
   LOG: listening: woken seq=1 in 01a0a2fd-… (from=小捷, rule=mention, mentions[]=01a0a2fd-7519-7106-bc27-d6bd27c2f93e)
```

### 5.2 套件级旧构建对照（`AR_LIB` 指向 0.1.44 装机产物）

```
PS> $env:AR_LIB="<home>\.dsh\profiles\web\node_modules\dsh-agent-room\lib"; node test/wake.test.mjs
ℹ tests 17   ℹ pass 8   ℹ fail 9      （exit=1）
   —— 8 条 0.1.45 新断言 + 1 条 0.1.41 计数器形状断言（旧构建没有那 9 个键）全红
   —— 注：`0.1.45 static guard` 在旧构建上**通过**，因为它读的是本仓 `src/**`（AR_LIB 只改 lib）
```

### 5.2b 新判据的运行时原始输出（本版）

```
[rule] window gap: messages=207 windowRows=200 windowGaps=1 missed=9
[preview] addressed: {"seq":1,…,"woken":1,"wake":{"woken":1,"targets":["01a0281a-…"],"reasons":["mention"],"note":"0.1.45 rule-predicted …"}}
[preview] unaddressed: woken=0 reasons=[]
[preview] un-addressed CONTROLLER post: woken=0 reasons=[]        ← 第一稿会 woken:1（评审 3728 的回归锁）
[logpolicy] lines=23 named=20 agg60=1 agg2=1 suppressed=1         ← 60 条控制帧只占 1 行（411 MB 教训的落地）
```

### 5.3 现场复现 OLD（真机、真投递路径）

```
PS> node <workdir>\_fix-45\chat-post-file.mjs baseline-a.txt script 小捷     # human=false + mentions=["小捷"]
HTTP 200
{"ok":true,"data":{"seq":3727,"acceptedByLocalHub":true,"confirmedByOwner":true,"confirmedSeq":3727,"confirmNote":"owner-confirmed","delivered":true,"queued":false}}
```

- 房主库（权威）：`seq=3727 human=false mentions=["01a0281a-52de-7c4d-a1e9-7e6db367d3dd"]`
- 小捷机 `C:\studio\studio.log`：`listening:` 共 16 行，`woken={2407,2482,3698,3699,3715,3718,3726}`、`skipped={3122,3140,3500,3661,3690,3693,3704,3716,3728}` —— **3727 一行都没有**，而**紧邻的 3726/3728 都有行**。
- 点击对比：`seq=3267/3606`（问卷/催办）同样零行，且它们与有行的 3122/3140/3500 处在同一份日志跨度内。

### 5.4 新规则在真实流量上的量化（房主机，全量 3915 条回放**本版编译产物**）

```
   小婷        OLD(human-only)= 48  NEW= 77  {mention=44, controller=0, human-fallback=33}
   小麦        OLD(human-only)= 47  NEW= 66  {mention=26, controller=0, human-fallback=40}
   KEVINKIKI   OLD(human-only)=  1  NEW= 45  {mention=44, controller=0, human-fallback= 1}
   小捷        OLD(human-only)= 48  NEW= 50  {mention=13, controller=0, human-fallback=37}
   小黄        OLD(human-only)= 48  NEW= 69  {mention=40, controller=0, human-fallback=29}
   被拦分类（小捷）：not-addressed=184, control-frame=3497, machine-frame=9, self=175
```

**这张表是本版最重要的取舍证据**（`controller=0` 即「无作者身份放行」）：

| 版本 | 小捷全量历史被唤醒次数 | 说明 |
|---|---|---|
| 0.1.44（旧规则） | 48 | 只有 `human=true` |
| **第一稿（含 controller 分支）** | **106** | 其中 `controller=57` —— 房主每条汇报都会叫醒其余四台 |
| **本版（删掉该分支）** | **50** | `mention=13`（点名，真正的派活信号）+ `human-fallback=37` |

⇒ 删掉作者身份分支后，**增量从 +58 次降到 +2 次**，而点名信号（13 次）完整保留。小捷 3728 的风险判断被复现，代价可量化。

**风暴护栏的实测人口**：全库 12 条机器自证帧（`【主控 · 升 0.1.41 后自证】…`、`小婷 升 0.1.43 自证`、`小麦 未升 0.1.43 自证`、`小捷升 0.1.43 自证` …），全部判为 `machine-frame`（拒绝）。**控制帧 2277–3497 条/人**同样全部拒绝——这是本版最重要的非功能收益。

---

## 6. 测试计数（`node test/<name>.mjs` 逐个直跑，**从不用** `node --test`）

```
Suite                   Tests Pass Fail
amplification.test.mjs  2     2    0
backfill.e2e.mjs        3     3    0
backfill.test.mjs       10    10   0
bom-identity.test.mjs   14    14   0
bridge-state.test.mjs   4     4    0
dedupe.test.mjs         2     2    0
dedupe-ring.test.mjs    7     7    0
listening.test.mjs      7     7    0
liveness.test.mjs       4     4    0
member-dedupe.test.mjs  3     3    0
outbound.test.mjs       10    10   0
protocol.test.mjs       8     8    0
rename-profile.test.mjs 16    16   0
selfjoin.test.mjs       2     2    0
sendchat.test.mjs       4     4    0
snapshot.test.mjs       4     4    0
stale-room.test.mjs     3     3    0
wake.test.mjs           17    17   0
wake-duplicate.test.mjs 6     6    0

SUITES=19  TESTS=126  PASS=126  FAIL=0
（0.1.44 基线：19 套件 / 117 通过 ⇒ 本版 +9 条，全部在 wake.test.mjs）
```

`npx tsc --noEmit` 无输出（0 error）；`node build.mjs` → `built lib/host/*, lib/client.js, lib/skills/`。

---

## 7. 真机现场验证

### 7.1 OLD 侧（0.1.44，小捷机）— 已拿到原始输出

见 §5.3。**这是「派活没人知道」的现场复现**：同一台机器、同一天、同一脚本投递方式，`human=true` 的两条（3698/3699/3715/3726）都有 `woken` 行，点名小捷的 `human=false` 一条（3727）**零行**。

### 7.2 NEW 侧（0.1.45，小捷机）— 在**本次打包之后**执行，原始输出不在本包内（有意）

现场证明需要**先有这个包**（升级要走 `http://your-host:8090/dsh-agent-room-0.1.45.tgz`）。为了让「先打包 → 再现场」不变成「打包 → 改文档 → 再打包」（0.1.44 今晚为补文档重打包 4 次，把已公布的 md5 作废 3 次），本版把现场证明的原始输出**写在卡里**，而不是回头重打包：

- `<workdir>\card-07-silent-wake-drop.md` §6 [9]「现场证明（决定性）— NEW 侧」
- 判据（一句话）：把小捷升到 0.1.45，用**与 §5.3 完全相同**的投递方式（脚本路径、`human=false`、点名 `@小捷`）发一条，期望：她机日志出现 `woken seq=<n> … rule=mention`，且她本人回话。
- 本包的 md5 因此**只发布一次**，之后不再变（除非出现必须重新发布的缺陷）。

### 7.3 没有做的事（现场纪律）

- **没有**重启/停止/拉起本会话所在的控制机上的任何服务（硬约束）。
- **没有**动房主 小婷 那台机器的服务（只跑了 3 次只读探测：`/state`、房主库、`rooms/<id>.json`）。
- **没有**升级除小捷以外的任何机器（本版只做「一台可回滚的成员机」的现场证明；车队推广见 §9）。
- 每次 exec 都会在房间里留一条 `[org:exec:result]` 回显——这条已知噪音本版**不修**（§10）。

---

## 8. 交付物与复现入口

```powershell
$REPO = "C:\work\项目\dsh-agent-room"
$OLD  = "<home>\.dsh\profiles\web\node_modules\dsh-agent-room\lib"   # 只读：部署中的 0.1.44
$GATE = "<workdir>\_fix-45\gate-wake-drop.mjs"

# 类型 + 构建
cd $REPO; npx tsc --noEmit; node build.mjs

# 双向门禁（OLD 应 8/19 且 exit 1；NEW 应 19/19 且 exit 0）
node $GATE $OLD
node $GATE "$REPO\lib"

# 套件（逐个直跑）
cd $REPO; Get-ChildItem test\*.test.mjs, test\*.e2e.mjs | ForEach-Object { node (Join-Path test $_.Name) }

# 旧构建套件对照
$env:AR_LIB = $OLD; node ($REPO + "\test\wake.test.mjs")     # 期望 8 pass / 9 fail

# 原始输出留档
#   <workdir>\_fix-45\gate-old.txt   gate-new.txt   ev-jie-before.txt   ev-impact2.txt   suite-out2\*.txt
```

---

## 9. 上线与回滚

```powershell
# 1) 成员机（小捷，非房主）：具名参数，别依赖脚本默认（默认是 0.1.40！）
#    WMI 拉起（本机已验证的路径）：
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\studio\upgrade-studio.ps1" -RoomVer 0.1.45 -OrgVer 0.2.12
#    升级后自证：
node C:/studio/ar45-probe-wake.mjs      # 期望 roomPlugin=0.1.45

# 2) 现场判据（在控制机上投递；投递方式与 §5.3 逐字一致）
node <workdir>\_fix-45\chat-post-file.mjs <workdir>\_fix-45\proof-45.txt script 小捷
#    然后在小捷机上：
#    Select-String -Path C:\studio\studio.log -Pattern 'listening: woken' | Select-Object -Last 3
#    期望出现 `rule=mention`

# 3) 回滚（一台机器）
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\studio\upgrade-studio.ps1" -RoomVer 0.1.44 -OrgVer 0.2.12
#    仓库侧：git revert <本版 commit>；旧包仍在 8090 上，不清档
```

**逐机生效提醒（重要）**：规则在**各机本地**（`service.ts:983` 的 `sweepListening` 只读本机 `listeningRooms`），**没有中央规则、没有同步**。因此「控制节点升级了」不等于「全场生效」：**没升级的机器仍然漏唤**。收敛终止条件是逐机的——该机 `/state` 的 `wake` 块里出现旧版没有的 `deniedNotAddressed` / `wokenByMention` 等键。

---

## 10. 本版**没有**验证 / 主动排除的部分（如实列出）

1. **NEW 侧现场证明写在卡里，不在本包文档内**（见 §7.2）：它在本包打包并上传之后执行。原因是**本包只发布一次**——现场（升级→投递→小捷机日志）必须先有包才能做，若回头把输出补进包内再打一次，就又是 0.1.44 那种「md5 被改、下游说明作废」。**没有**在打包前伪造这段输出。
2. **`woken` 是预测，不是回执。** 发送侧无通道观察远端唤醒面；对「离线 / 关了 listening」的目标会偏乐观。ack 回执平面（小捷建议 C）**本版不做**。
3. **不带 `@` 的点名清单不算点名。** 「填写人：小婷、小黄、小麦、小捷」这类正文**仍会被拒**（`not-addressed`），由 `woken:0` 在发送时暴露。要修得引入结构化 `assignees[]` 字段（协议变更），本版不做。
4. **角色别名不可解析**：`@总控` 不会命中昵称为 `KEVINKIKI` 的节点（别名不在任何协议字段里）。可用的替代：`agent_rename_self` 把昵称改成角色名。
5. **两条同族静默路径只做到「可见」，没有做到「处理」**（小捷清单 #2 #3）：①房间不在 `listeningRooms`（**这条本版给不出计数**——根本不进 sweep，没有任何调用点；只留下 0.1.44 就有的 `/state.rooms[].listening`，要靠人看）②`listenPending` 窗口内的消息现在**计数**（`pendingSkips`）并各留一行，但**仍然不会被处理**（本轮跳过，下一轮靠游标是否覆盖决定，不保证）。
6. **窗口缺口仍然是「可见」而非「处理」**：超过 200 行的突发会把消息留在窗口外，本版只保证它被计数并命名（`windowGaps` / `windowGapMessages`），不保证它会被唤醒。
6. **`[org:exec:result]` 回显仍然混在 chat 流里**（控制帧与聊天共用通道）：本版只是**拒绝唤醒**它们，并没有把它们从浏览器视图/流量里剥离。
7. **只有一台真机验证**（小捷）。房主与小黄（macOS）**未升级**，因此他们的漏唤侧**此刻仍未修**。
8. **没有**做长稳/压测：新 deny 日志的体积上界是**推导值**（≤20 行/房/30 s，线性于流量），未在真实高流量房间实测。
9. **没有**验证 0.1.45 与 org 0.2.12/0.2.10 的交互（org 只会读 `confirmedByOwner`/`delivered`，本版未动这两个字段，理论无影响，但**未实测**）。

---

## 12. 评审驱动的两次改动（本版真实的开发过程，如实留档）

本版**打包过两次**：第一稿（`dsh-agent-room-0.1.45.tgz`，269132 B，md5 `8c95f55485d1f12d3e9754a2d05a34b4`）在**发出公告后**被两名成员的评审推翻了两处设计，改完重新打包一次。旧包的哈希在这里留档，**不再作为任何下游引用**（避免 0.1.44 那种「md5 被改了三次、下游说明全部作废」的混乱）。**最终包只发布一次**，见 §13。

### 12.1 小捷（room seq 3728）：删掉 `作者 == controller` 分支

- **它的实测**：当天房间里有 **6 条由小婷机（controller）发布的消息**（seq 2942 / 3089 / 3148 / 3199 / 3225 / 3231），**全是多行状态汇报，没有一条是派活**；第一稿的分支会让每条唤醒其余 4 台 ⇒ **24 次无效唤醒**。
- **它的论证**：「是不是派活」**不能由作者是谁推断** —— 与 0.1.41 的教训同源（那次是「相信作者设的一个布尔」）。
- **本版处置**：删除该分支（`WakeReason` 里不再有 `controller`；判定式里没有任何作者身份判据），并把「未点名的派活叫不醒任何人」写进契约，由发送侧 `woken:0` 当场暴露。
- **可复现的回归锁**：`test/wake.test.mjs` 的「NO author identity buys a wake」用例 + 运行时 `POST /chat` 用例（把 controller 席位放回本机后，未点名消息仍必须 `woken:0`）+ 门禁脚本 `G un-addressed CONTROLLER post wakes nobody`。
- **量化**：小捷全量历史唤醒次数 第一稿 106 → 本版 **50**（§5.4）。

### 12.2 小黄（room seq 3729）：窗口有限 ⇒ 落在窗口外的消息完全无痕

- **它的实测/推理**：`recent = recentMessagesFor(roomId, 20)` 只取最新 20 条、游标推到当前尾巴 ⇒「两次 sweep 之间落库超过 20 条」时，点名消息**从头到尾没进过 `fresh`** ⇒ 既不 `woken` 也不 `denied`。它同时撤回了自己上一条「被尾巴越过」的过强推断（这点值得记：**它撤回的是自己的话，不是别人的**）。
- **我的实测复核（比它预想的更近）**：一次 exec 风暴期间房间 **3 分钟流过 152 条 `[org:*]` 控制帧** ⇒ **旧 20 行窗口 ≈ 24 秒 < 一个 sweep 周期 30 秒** ⇒ 「窗口越过」是常规状态。
- **本版处置**：① 窗口 **20 → 200 行**；② 剩余缺口 **计数 + 命名**（`windowGaps` / `windowGapMessages` + 一行 `listening: window gap … seq=a..b`）；③ 不做无上限回捞（那会为一批陈旧派活同时唤醒目标机）。
- **可复现的回归锁**：运行时用例连发 207 条后断言 `windowGaps≥1, windowGapMessages≥1` 且日志出现 `listening: window gap`。

### 12.3 我（本卡作者）对这两条的责任划分

0.1.44 的旧规则是我发布的版本，**第一稿的 controller 分支也是我写的**（依据是任务书里的「建议」）。两条评审都不是「挑刺」：它们各自消灭了一个**同一版本内会立刻生产事故**的设计，并且都给了可复现判据。**采纳记录与原始 seq 写在这里，评审者的名字与 seq 一并留档。**

---

## 13. 最终交付物（**只发布一次**，所有下游以本节的哈希为准）

```
file    : dsh-agent-room-0.1.45.tgz
bytes   : <<< 见 §13.1（打包后回填，本文件在包内，因此本行只能写「打包即定」的说明）>>>
md5     : <<< 同上 >>>
built by: npm.cmd pack --ignore-scripts --cache <workdir>\.npm-cache
upload  : scp → user@your-host:/path/to/studio-files/（SSH_ASKPASS=<workdir>\_askpass.cmd）
verify  : ssh … "ls -l …; md5sum …"  —— 远端字节数与 md5 必须与本地逐位一致
```

⚠️ **本文件位于包内**，所以「包的 md5」无法写在本文件里而不改变它（写入即改变哈希）。**权威记录在包外**，只有两处：

1. `<workdir>\card-07-silent-wake-drop.md` §6 [10]「发布物记录」（含名称/字节数/md5/远端校验输出）；
2. 房间消息（seq 见卡内引用）里的同一组数字。

## 14. 卡⑦ §5 判据 15 的行号/口径更正（发布后未改动代码，仅更正文档口径）

- 卡⑦ 早期草稿里写的「改后**必有** `denied` 或 `woken` 之一」**范围过大**（小黄 3729 的指正）：正确口径是
  **「落在本轮读取窗口内的候选，必有其一」**；窗口外/待命窗口/首轮 seed 三种情况由
  `windowGaps` / `pendingSkips` / `seedSkips` 三个计数器与各自的一行日志覆盖（§10 第 5、6 条）。
- 卡⑦ §5 判据 15（现场证明）的原始输出在卡内 §6 [9]/[10]，不在本包内（理由见 §7.2 与 §10 第 1 条）。

## 15. 给下一台要升级的机器的人（一段就够）

```
# —— 任何成员机（不是房主）：0.1.45 ——
# 0) 先看现在什么版本（已经 0.1.45 就不必跑）
node -p "require(require('os').homedir()+'/.dsh/profiles/web/node_modules/dsh-agent-room/package.json').version"
# 1) 跑升级（**具名参数**：脚本默认值是 0.1.40，照抄不带参数 = 空操作，这条踩过）
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\upgrade-studio.ps1" -RoomVer 0.1.45 -OrgVer 0.2.12
# 2) 升级后三看
#    看版本：node -p "...package.json').version"          期望 0.1.45
#    看监听：GET http://127.0.0.1:3080/agent-room-api/state 里该房 listening=true
#    看计数：同一条 /state 的 wake 块里出现 deniedNotAddressed / wokenByMention（旧版没有这些键）
# 3) 现场判据（控制机发、本机看）
#    控制机：node <workdir>\_fix-45\chat-post-file.mjs <含 @你昵称 的文本文件> script <你的昵称>
#    本机  ：Select-String -Path C:\studio\studio.log -Pattern 'listening: (woken|denied)' | Select-Object -Last 5
#    期望：出现 `woken seq=<n> … rule=mention` —— 这就是「派活真的叫醒了人」的唯一判据
```
