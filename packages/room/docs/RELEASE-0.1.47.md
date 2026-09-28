# dsh-agent-room 0.1.47 — 唤醒之后「这一轮真的起没起来」：链上每一步都有计数，起不来就自己升级一次

发布目标：缺陷 **D-37（本版定名「唤醒不启动」/ wake activation）** —— 0.1.45 修好了**规则**（点名即唤醒），0.1.46 补上了**回执**（`[ack] <昵称> 已接手 seq=N`），**两者都工作**，而回执当场暴露出更底下的一层：**唤醒到了，回执也回了，这一轮却从来没起来**。
本版**只做一条**：把「规则 → 派发 → 常驻会话 → followup 被接受/被拒 → 真正开始 → 产出」这条链**每一步都变成计数**，并在**有界窗口**内没有任何「已经开始」的证据时，**由插件自己做一次 `activate-chat` 的等价动作**。**不改协议、不改写盘格式、不动唤醒规则/水位线/去重环/回执契约（除一处收紧，见 §5.5）。**

| 组 | 内容 | 落地版本 |
|---|---|---|
| 升级动作 | 派发后 `startWindowMs=20 s` 内无任何「已开始」证据 → 插件用**同一条** `activate-chat` 提示词与同一套常驻 agent 解析**自己做一次**（每次派发**最多一次**） | **0.1.47** |
| 链可观测 | 规则 / 派发 / 会话解析（含**解析路径**）/ followup 接受或拒绝 / 真正开始（含**证据种类**）/ 本机产出 —— 每步一个扁平计数 | **0.1.47** |
| 结构性不能干活 | `activation.noResidentAgent` + `resolvedViaNone`（其余 `resolvedVia*` 全 0）+ `lastResidentOk:0` ⇒ **只读 `/state` 就能判定这台机收不了活**（C现场） | **0.1.47** |
| 静默停止 | B式「`dispatching followup` 之后什么都没有」＝ `acceptedNoOutput`（窗口超时）+ 一行 `ACCEPTED BUT NO OUTPUT`；被拒＝`followupRefused` / `refusedNoOutput`（两个桶永不混） | **0.1.47** |
| 不回归 | 0.1.45 规则行为 + 0.1.46 回执契约 **逐条回归锁**（新旧双跑均绿）；`GET /state` 的 `wake`/`ack` 两块**一个键不动** | **0.1.47** |
| 卡 | `<workdir>\card-09-wake-activation.md`（方案卡 ⑨，含旧/新门禁原始输出与现场证明） | 本版同步 |

---

## 1. 缺陷（三句话）

**1. 唤醒是好的。** 点名即可唤醒，目标机自己日志有 `listening: woken seq=… rule=mention`，`wake.wokenByMention` 在涨 —— 这条 0.1.45 修对了。

**2. 回执也是好的，而它暴露了下面那一层。** 目标机回了 `[ack] … 已接手 seq=N`，发送侧看到「活到了人手上」——**然后什么都没有产生**。同一台机的 `pendingSkips` 一起在涨（每轮 sweep 都因为「上一轮的唤醒还在飞」跳过）——**这是设计，不是缺陷**（一轮 agent 可能跑几分钟，sweep 每 30 s 一轮），本版**没有**去「修」它，也**没有**把它当健康信号。

**3. 三台机、三种不同的失败（全部第一手）：**

| 机器 | 日志链（原文节选） | 结论 |
|---|---|---|
| D | `active-session: session-b7496a19…` → `activate-chat: registry dump — detected=… list=[…]` → `accepted … thinking=true` → `dispatching followup … to agent agent-room-duty-01a09483…` → **`followup accepted`** → 房间里真出现 `【D 自检 · 版本判定】…` | **通的**（对照组：这条代码路径本身没问题） |
| B | `activate-chat: accepted … thinking=true` → `dispatching followup … to agent agent-room-duty-01a09461…` → **日志就停在这里**，没有 `followup accepted`、没有报错、没有计数 | **静默失败** |
| C | `active-session: session-7f81275b… (global fallback, cwd=…, dir=false)` → `registry dump — detected=session-7f81275b… list=[] roots=[]` → **连 `accepted` 和 `dispatching` 都没有** | **结构性收不了活**（常驻 agent 没有绑到值守工作区），而 `/state` 上它和健康机一模一样 |

**为什么这是一个真缺陷，而不是「机器慢」**：`agent.followup` 的同步返回值**证明不了任何事**。读 harness 源码第一手（`dsh-agent-loop/lib/index.js:396`）：

```js
followup(input) { this.send(input, "next-turn", true); }
```

`send`（`:389`）只做 `this.inbox.splice(…)` 加一次 `wakeDriver`，而 `wakeDriver`（`:444`）在 agent 不是 idle 时**直接 return**：

```js
wakeDriver(wakeAfterAbort = false) {
  if (this.phase.kind !== "idle") { … this.phase.wakeRequested = true; return; }
  …
}
```

⇒ 它**永远返回 `undefined`**、对忙碌的 agent **永远不抛**，它唯一证明的是「消息进了这个 agent 的收件箱」。**「进了收件箱」和「这一轮起来了」之间，之前一个计数都没有。**

---

## 2. 修复后的语义（本版契约）

```
派发（rule=mention|human-fallback 且常驻 agent 解析成功）
  → activation.noteDispatch(roomId, seq)          （每次派发一个在飞条目；有界 maxPending=64）
  → resolveResidentAgent(trace)                    （记下**哪条路径**解析到的：config/active-session/duty/persisted/identity/heuristic/none）
       解析不到 → activation.noteNoResident() + resolvedViaNone 计数 + 一行 NO RESIDENT AGENT（并限速告警）
                  —— 不标记水位线（什么都没交出去，标记＝永久吞掉这条 seq）
  → agent.followup(prompt) 包在 try/catch 里
       抛异常 → activation.noteFollowupRefused() + 一行 followup REFUSED（**不**发回执：没交接就没有「已接手」）
       返回   → activation.noteAccepted(agentId, 会话 transcript mtime 基线) + 一行 followup ACCEPTED（并写明：这只证明进了收件箱）

每 10 s 一次 activation tick（`sweepActivation`，无在飞任务时**零 IO**）：
  ① 证据：agent.status === "running"（harness 自己的 getter，dsh-agent-loop/lib/index.js:380）
           或 该会话 transcript 在派发之后被写过（mtime 前进）
           或 本机**自己**的消息落进房间（noteOwnReply，最强证据）
       命中 → activation.started（并记下 startedByStatus/Transcript/Output 是哪一种）
  ② 升级：超过 startWindowMs=20 s 仍无证据，且**从未升级过** → 用**同一条 activate-chat 提示词**再做一次
       （同一次派发**最多一次**；升级失败 → escalationsFailed(+NoAgent/Refused) 计数 + 一行，绝不重试第二遍）
  ③ 结算：超过 outputWindowMs=120 s → 关闭条目
       接受过但从没产出 → acceptedNoOutput + 一行 ACCEPTED BUT NO OUTPUT
       从没被接受过     → refusedNoOutput（与上一桶**永不混**）
```

| 观测 | 0.1.46（旧） | 0.1.47（新） |
|---|---|---|
| 点名一台机，它**没有起来** | 日志停在 `woken … rule=mention`（或 `dispatching followup`），**没有任何计数能说这一步失败了** ✗ | `activation.started=0`、20 s 后 `escalationsAttempted+1`、120 s 后 `acceptedNoOutput+1` ✓ |
| 一台机**收不了活**（没有常驻 agent） | 只有一行 `listening: no resident agent for <room>`，`/state` **无任何字段** ✗ | `noResidentAgent`/`resolvedViaNone` 计数 + `lastResidentOk:0` + 两行日志（含解析路径）✓ |
| `followup` 抛异常 | 一行笼统的 `listening: wake failed for <room> — <error>`，与「sweep 崩了」长得一样 ✗ | `followupRefused+1` + 明确一行（并**不发**回执）✓ |
| **机器自己起不来时** | 只能等人去点「激活聊天」 | 插件**自己做一次等价动作**（同一提示词、同一解析），并且**只做一次** ✓ |
| `/state` 新增 | —— | `activation.{33 个扁平计数}`（`wake`/`ack` 两块一个键不动）✓ |

---

## 3. 为什么这样修（一条一条给理由）

1. **为什么必须由插件自己升级，而不是再发一条房间消息催。** 触发条件在**目标机本地**（「我派发出去 20 s 了，我自己的 agent 没有任何动静」），发送侧看不见；而唯一的等价动作（`activate-chat`：解析常驻 agent + 发一条**要求回复**的提示词）**插件已经拥有**（`buildActivatePromptFor`，`service.ts:932`）。不让它自己做，就等于「必须有人在浏览器上点一下」才算能干活 —— 现场正是这样：D是D（房主）手动点出来的。
2. **为什么「升级」用的是同一条提示词、同一套解析。** 「等价于 activate-chat」如果换一套词，就是另一个更弱的东西戴了同一个名字。所以提示词走 `buildActivatePromptFor`（**和手动按钮同一个函数**），常驻 agent 走 `resolveResidentAgent`（**和手动按钮同一个函数**）。
3. **为什么**不**设 `activateThinkingRooms`（**这是本版唯一一处刻意的「不做」**）。** 那个标志是浏览器**一次性按钮**的状态：它会 409 掉人类的下一次点击（`web.ts:160`）。后台升级去占它，既会让人的点击失败，又会让「自动升级」和「用户点的」在 UI 上**无法区分**。区分它们的责任交给计数（`escalationsAttempted`），UI 状态仍然属于用户。这一条写在 §10 第 4 条。
4. **为什么窗口是 20 s，而「没产出」的窗口是 120 s。** 20 s：本车队唯一实测的「唤醒 → 起转」延迟是 **0.39 s**（card 04 §2，从 142 份 transcript / 415,737 帧里量出来的），20 s 是它的 ≥50 倍，同时**故意小于** `listenPending` 重臂 60 s 与 0.1.46 的 `ACK_WINDOW_MS=120 s`，使升级发生在「这条派发仍是最近一件事」的时候。120 s：**与发送侧判定「没人回执」的窗口同一个数**（`ack.ts:88` 的推导：≤30 s sweep + 30 s pendingSkip + 25–45 s 实测中继往返），如果比它更早宣布「没产出」，两个关于同一件事的计数就会互相打架。
5. **为什么 tick 是 10 s（比 30 s sweep 更密）而不是复用 sweep。** 20 s 的窗口用 30 s 的 tick 去判，等于**掷硬币**（派发落在 sweep 的什么位置决定它是否被升级）。而 tick 更密的代价是 0：`sweepActivation` 第一行就是 `if (this.activation.pendingCount() === 0) return;` —— 没有在飞派发时**不做任何 registry 查询、不做任何 stat、不写任何日志**。它也是本文件**唯一 unref 的定时器**：它只观察别人，不该成为任何进程活着的理由。
6. **为什么「已经起来」有三种证据、而且分开计数。** 三种都不是「模型产出了 token」的普遍证明，所以**不能合并成一个英勇的 started 数字**——这正是本系列每一版都在对抗的缺陷类：**信号的覆盖面小于用它做出的结论**。
   - `status`：harness 自己的相位 getter（`agent.status === "running"`），最锐利；
   - `transcript`：该会话 transcript 在派发之后被写过（`<DSH_HOME>/sessions/<ws>/<sessionId>/session.jsonl.zstd` mtime，本仓 `detectActiveSessionId` 已经在读同一个约定），作为**没有暴露 status 的 handle 的兜底**；
   - `output`：本机自己发的消息落进房间（唤醒提示词要求用 `room_send` 回话），**最强**，因为它是人读房间就能看见的那一条。
7. **为什么回执**不算**产出（这条是本版最重要的一条防假阳性）。** `[ack]` 是**插件**用自己的身份、在模型做任何事**之前**写进房间的。把它算成「agent 产出了」，就会让每一台静默机器都看起来在干活 —— 与 A 自己复盘出来的失效模式（三次 harness 回滚里两次是**判定代码**的 bug；「服务端全绿 ⇒ 宣布成功」发布过 UI 完全坏掉的版本）是同一个家族。所以 `noteOwnReply` 里**显式排掉** `isAckPlaneFrame` 与 `isControlFrame`（`service.ts:1051`，静态守卫锁住）。
8. **为什么升级只做一次，而且「只做一次」写在**结构**里而不是写在注释里。** `dueEscalation()` 自己把条目标成「已升级」（`activation.ts:441`），所以后续 tick、十分钟后的 tick、任何调用方都不可能再发一次。失败也一样只记一次（`escalationsFailed`），**不重试**：一个失败的升级再试一遍，就是把「静默」换成「风暴」。
9. **为什么待结算的两个桶必须分开**（`acceptedNoOutput` / `refusedNoOutput`）。「接了活但没动」和「没人接活」是两种完全不同的故障，处置也不同（前者查模型/会话，后者查绑定/注册表）。合成一个数，等于把本版要消灭的那种含混重新造出来。
10. **为什么拒绝跟进（followup 抛异常）之后仍然允许升级，而且**不发**回执。** 拒绝**不是**「已开始」（第 6 条），所以窗口照样适用：这给了插件一次机会去**重新解析**一个活着的常驻 agent 并把活交出去。而回执的语义是 `已接手`——对一次没发生的交接发「已接手」，就是 0.1.46 自己要消灭的那类假信号（§5.5）。
11. **为什么不落盘。** 与 `ack.ts:236-242` 同一个理由：一条唤醒是关于**一次活着的交接**的声明；重启**无法**为它没有启动的一轮补做升级，把上电前的在飞条目恢复出来，等于**制造**假安心。后果写明：重启时在飞条目丢失，`pending`/`escalations*` 从 0 开始（§10 第 6 条）。

---

## 4. 改动清单（每个文件一行理由）

| 文件 | 改动 |
|---|---|
| `src/host/activation.ts` | **新增（543 行）**：`ACTIVATION_START_WINDOW_MS=20_000`（`:123`）、`ACTIVATION_OUTPUT_WINDOW_MS=120_000`（`:126`）、`ACTIVATION_TICK_MS=10_000`（`:129`）、`MAX_ACTIVATION_PENDING=64`（`:132`）、`WakeActivation`（`:254`：`noteDispatch` `:306` / `noteAccepted` `:331` / `noteFollowupRefused` `:349` / `noteResident` `:356` / `noteNoResident` `:374` / `noteStart` `:380` / `noteOutput` `:406` / `dueEscalation` `:441` / `noteEscalationResult` `:455` / `dueSettlement` `:476` / `stats` `:508`，共 **33 个扁平计数**） |
| `src/host/service.ts` | `activation` 字段（`:269`）；`ResolutionTrace`（`:128`）+ `resolveResidentAgent(identity, trace)` 逐条返回**解析路径**（`:581`）；`agentById`（`:686`）；`sessionActivityMs`（`:716`，transcript 证据）；`buildActivatePromptFor`（`:932`，与手动按钮**同一个**提示词构造）；`dispatchFollowup`（`:969`）；`noteOwnReply` 里**产出证据 + 排除 ack/控制帧**（`:1051`）；`runListenWake` 记派发/接受/拒绝并打印 `agent=`/`via=`（`:1472`）；**回执改为只在真交接后发**（`:1644`）；`sweepActivation`（`:1797`）；`escalateWake`（`:1862`）；`reportSettlement`（`:1926`）；10 s unref tick（`:2062`）；`/state` 新增 `activation` 块（`:3152`） |
| `src/host/wake.ts` | **未改**（0.1.45 的规则一行不动；本版只是把它的下游补齐） |
| `src/host/ack.ts` | **未改**（0.1.46 的回执契约一行不动） |
| `test/wake-activation.test.mjs` | **新增 14 条测试**（见 §6）：链上每一步的计数与证据、升级**每次派发最多一次**、已起转不升级、超时桶与拒绝桶不许混、内存上界、**运行时**六例（没有常驻 agent / 升级后真产出 / 升级失败计数且不重试 / 超时计时 / status 证据 / `/state` 形状）、静态守卫、0.1.45+0.1.46 回归锁、回执收紧 |
| `docs/RELEASE-0.1.47.md` | 本文件 |
| `package.json` | 版本 0.1.46 → 0.1.47 |
| `lib/**` | `node build.mjs` 重新生成（含 `lib/host/activation.js`） |
| （工作区，不在包内）`<workdir>\_fix-47\gate-wake-activation.mjs` | 双向门禁脚本：**同一套 15 条期望**，分别打 0.1.46 装机产物与本版 |
| （工作区，不在包内）`<workdir>\card-09-wake-activation.md` | 方案卡 ⑨（含现场证明原始输出与发布物记录） |

**明确没做**：不改协议与写盘格式；不动 `wake.ts`（规则/水位线/拒绝政策/窗口）/`ack.ts`（回执去重/限速/机器帧）/`dedupe.ts`/镜像收敛/self-join/BOM 身份；**不修** `pendingSkips`（跳过是设计）；**不做**激活条的落盘与重启续做；**不做** `transcript` 证据之外的会话级解析（例如「模型是否已产出第一个 token」）。

---

## 5. 发布门禁：同一脚本，先量旧构建，再量本版

### 5.1 双向门禁（`<workdir>\_fix-47\gate-wake-activation.mjs`，15 条期望）

```
PS> node <workdir>\_fix-47\gate-wake-activation.mjs "C:\work\项目\dsh-agent-room\_old046\lib" "...\_old046\src"
=== summary: 2/15 expectations hold on this build ===      （exit=1）   ← OLD = git archive HEAD 的真实 0.1.46
PS> node <workdir>\_fix-47\gate-wake-activation.mjs "C:\work\项目\dsh-agent-room\lib"
=== summary: 15/15 expectations hold on this build ===     （exit=0）   ← NEW = 本版
```

**旧侧最关键的四段原始输出（这就是缺陷本体）：**

```
    host/activation.js present: NO  <-- this is the OLD-build condition

FAIL  E / 'no resident agent' is reported AS SUCH and moves a counter (C's machine)
   dispatch seq=1
   LOG (this machine) : ["[agent-room] activate-chat: NO resident agent (registry=present, agents.list()=0)",
                         "[agent-room] listening: no resident agent for 01a0a3b9-…"]
   ROOM               : ["【派活】@***** 请跑回归"]
   /state.activation  : null  <-- absent
   ← 只有一行日志；没有任何计数、没有升级、没有回执，/state 里什么都没有

FAIL  F / a wake that starts NOTHING is escalated, and the machine then ANSWERS (B)
   dispatch seq=1  handoffs=1
   ROOM (before window) : ["【派活】@***** 请跑回归","[ack] ***** 已接手 seq=1"]
   LOG (before window)  : ["… listening: woken seq=1 in 01a0a3b9-… (from=A, rule=mention, mentions[]=01a0a3b9-…)"]
   (this build has no sweepActivation — the tick that would escalate does not exist)
   handoffs             : 1
   ROOM (after window)  : ["【派活】@***** 请跑回归","[ack] ***** 已接手 seq=1"]     ← 房间一字未增
   LOG (after window)   : []                                                              ← 日志一行未增
   activation           : null  <-- absent on this build
   → THE MACHINE DID NOT ANSWER (OLD BUILD 0.1.46: nothing escalates, so the silent machine stays silent)

FAIL  H / accepted-then-silent is counted as the TIMEOUT path (acceptedNoOutput)
   ROOM : ["【派活】@***** 请跑回归","[ack] ***** 已接手 seq=1"]
   /state.activation : null  <-- absent
```

**新侧同一批用例（节选）：**

```
PASS  E … LOG: "listening: NO RESIDENT AGENT for … seq=1 — the rule ADMITTED this wake and this machine cannot
                     accept it (resolution=registry=present list=0 detected=session-480dbafb-…); activation.noResidentAgent/resolvedViaNone count it"
        /state.activation = {"noResidentAgent":1,"resolvedViaNone":1,"lastResidentOk":0,…}
PASS  F … LOG (after window): "wake-escalate: … seq=1 produced NO evidence of a turn 21s after the wake — escalating with the
                                activate-chat prompt (same resolution + same prompt as the manual button: agent=session-gate-probe, via=config)"
                             "wake-escalate: SENT seq=1 … — activation.escalationsSucceeded counts it"
                             "listening: OWN OUTPUT landed in … (seq=3 after the wake at seq=1, waited 0s) — the chain reached its last step"
        ROOM (after window) : ["【派活】@***** 请跑回归","[ack] ***** 已接手 seq=1","【B 自检】收到，已开工"]
        activation          : {"dispatches":1,"accepted":2,"started":1,"startedByOutput":1,"outputs":1,
                               "escalationsAttempted":1,"escalationsSucceeded":1,"acceptedNoOutput":0,"pending":0,…}
PASS  G … 3 轮更晚的 sweep 之后 escalationsAttempted 仍是 1；LOG 里「escalate: REFUSED」只有一行
PASS  H … LOG: "activation: ACCEPTED BUT NO OUTPUT seq=1 … (activation.acceptedNoOutput counts it; the wake prompt permits silence …)"
```

### 5.2 套件级旧构建对照（`AR_LIB` 指向 0.1.46 装机产物）

```
PS> $env:AR_LIB="…\_old046\lib"; node test/wake-activation.test.mjs
ℹ tests 14   ℹ pass 1   ℹ fail 13      （exit=1）
   —— 13 条新断言全红（旧构建连 host/activation.js 都没有：没有升级、没有计数、没有区分手段）
   —— 唯一通过的是「0.1.45 规则 + 0.1.46 回执契约不变」那条回归锁：它在**新旧两个构建上都绿**，
      这正是"本版没有回归前两版"的机器可读证据
```

### 5.5 对 0.1.46 的**一处**收紧（写在这里，不藏在代码里）

回执现在**只在真交接之后**才发：`if (accepted) void this.postAckReceipt(…)`（`service.ts:1644`）。0.1.46 是「`followup` 调用之后」无条件发 —— 而 `followup` 可能抛异常。一行 `[ack] <我> 已接手 seq=N` 是对**已经发生的交接**的声明；对一次没发生的交接发它，正是本系列每一版都在消灭的那类假信号。发送侧看到的后果是诚实的：那台机变成 `ack.unackedTargets`，目标机上是 `activation.followupRefused`。0.1.46 自己的 12 条回执断言**全绿**（§6），静态守卫「回执在派发之后」也仍然成立。

---

## 6. 测试计数（`node test/<name>.mjs` 逐个直跑，**从不用** `node --test`）

```
Suite                      Tests Pass Fail
ack.test.mjs               12    12   0      ← 0.1.46 回执契约（本版未回归）
amplification.test.mjs     2     2    0
backfill.e2e.mjs           3     3    0
backfill.test.mjs          10    10   0
bom-identity.test.mjs      14    14   0
bridge-state.test.mjs      4     4    0
dedupe.test.mjs            2     2    0
dedupe-ring.test.mjs       7     7    0
listening.test.mjs         7     7    0
liveness.test.mjs          4     4    0
member-dedupe.test.mjs     3     3    0
outbound.test.mjs          10    10   0
protocol.test.mjs          8     8    0
rename-profile.test.mjs    16    16   0
selfjoin.test.mjs          2     2    0
sendchat.test.mjs          4     4    0
snapshot.test.mjs          4     4    0
stale-room.test.mjs        3     3    0
wake-activation.test.mjs   14    14   0      ← 本版新增
wake-duplicate.test.mjs    6     6    0
wake.test.mjs              17    17   0

SUITES=21  TESTS=152  PASS=152  FAIL=0
（0.1.46 基线：20 套件 / 138 通过 ⇒ 本版 +1 套件 / +14 条）
```

`npx tsc --noEmit` 无输出（0 error）；`node build.mjs` → `built lib/host/*, lib/client.js, lib/skills/`。

新增的 14 条（`test/wake-activation.test.mjs`）：
链上每一步的计数与**证据种类**（`startedByStatus/Transcript/Output` 分开）、**升级每次派发最多一次**（窗口内不升级、窗口外一次、十分钟后仍是一次）、**已起转的三条路径都绝不升级**、超时桶 `acceptedNoOutput` 与拒绝桶 `refusedNoOutput` **不许混**（且拒绝的派发照样进升级窗口）、内存上界（`maxPending` + `duplicateDispatches` + `pendingOverflow`）、**运行时六例**（① 没有常驻 agent：`noResidentAgent/resolvedViaNone/lastResidentOk` + 一行 `NO RESIDENT AGENT`；② **验收**：起不来的唤醒被升级一次 → 机器真产出 → `startedByOutput=1`/`outputs=1`/房间出现那条消息，且**回执不算产出**、回执仍恰好一条；③ 升级失败：计数 + 一行 + 三轮更晚的 sweep 仍是一次；④ 超时：`acceptedNoOutput` + 一行；⑤ `status=running` 被判为已起转且**不升级**；⑥ `/state.activation` 形状/数值/JSON 往返 + `wake`/`ack` 两块未被扰动）、静态守卫（tick 空转早退 / 升级列表**只有一个调用点** / 升级**不碰** UI 的 thinking 标志 / 产出证据排除 ack 与控制帧 / 定时器 unref / 释放时清理 / `/state` 挂载）、**0.1.45+0.1.46 回归锁**（10 条规则用例逐 reason + 水位线单调 + 回执去重/限速/机器帧）、以及**回执收紧**（拒绝跟进 → 房间零回执 + 计数 + 一行说明）。

---

## 7. 真机现场验证

现场原始输出**写在卡里**（`<workdir>\card-09-wake-activation.md` §6），本节只写纪律与判据：

- **旧侧现场复现（升级前，B仍在 0.1.46）**：控制机 `POST /rooms/01a098a2-…/chat {"human":false}` 点名 B → `seq=4538 woken=1`；B自己的日志：`listening: woken seq=4538 … (from=*****, rule=mention)` + `ack: receipt posted … line="[ack] B 已接手 seq=4538"`；B `/state`：`activation=null`，`wake.woken:1→2`，`ack.maxAckedSeq=4538`；房间：**除那条插件自己的 `[ack]` 外，B没有再产出一行**。⇒ 旧版「唤醒到了、回执回了、什么也没产生」在真机上逐字复现。
- **新侧现场验收**：B升级 0.1.47 后同一动作重做一次（新 seq），要求看到链上每一步的行、计数移动、以及**B真的产出**（或如果仍然不能，新计数**精确说出是哪一步失败**）。卡里贴原始行。
- **现场结果（不美化）**：链是通的、升级确实触发（`escalationsAttempted=2 / escalationsSucceeded=2`），但**B仍然没有回话**：`activation: ACCEPTED BUT NO OUTPUT seq=4655 … 120s` + `acceptedNoOutput=1`。⇒ 本版把问题从「插件看不见」推进到「**常驻 agent 收下了活却不跑**」，而这一步的根因由并轨的另一条现场定位给出（账本 **D-37**：`ensureDutyAgent()` 在没有活会话可镜像时 `provider/model` 留空 ⇒ 值守会话**没有模型**，回合永远不会开始 —— 而 `followup` 是同步入队，所以 0.1.46/0.1.47 的 `accepted` 行**都会照常打印**）。本版新增的 `started` / `startedBy*` / `acceptedNoOutput` 就是 D-37 建议的那个共同判据：**「接下了 ≠ 回合开始了」**。
- 控制机纪律：**没有**重启/升级控制机（本会话所在）；**没有**碰房主D；**没有**碰C（另一路在修它的绑定）；本版只安装到**允许触碰的**B与A。
- **不做**「安装覆盖活进程」：升级一律走各机自己的升级脚本（它会先停服务），不手抄 `node_modules`。

---

## 8. 交付物与复现入口

```powershell
$REPO = "C:\work\项目\dsh-agent-room"
$OLD  = "$REPO\_old046\lib"          # git archive HEAD（0.1.46）解出来的真实旧构建
$GATE = "<workdir>\_fix-47\gate-wake-activation.mjs"

cd $REPO; npx tsc --noEmit; node build.mjs

# 双向门禁（OLD 应 2/15 且 exit 1；NEW 应 15/15 且 exit 0）
node $GATE "$OLD" "$REPO\_old046\src"
node $GATE "$REPO\lib"

# 套件（逐个直跑）
Get-ChildItem test\*.test.mjs, test\*.e2e.mjs | ForEach-Object { node $_.FullName }

# 旧构建套件对照
$env:AR_LIB = $OLD; node ($REPO + "\test\wake-activation.test.mjs")     # 期望 1 pass / 13 fail

# 原始输出留档
#   <workdir>\_fix-47\gate-old.txt  gate-new.txt  suite-oldlib.txt  wa.out.txt
```

---

## 9. 上线与回滚

```powershell
# 1) 成员机（B / A，Windows）：先停服务再装，绝不在活进程上覆盖
powershell -NoProfile -ExecutionPolicy Bypass -File "<studio>\upgrade-studio.ps1" -RoomVer 0.1.47 -OrgVer 0.2.12
# 2) 升级后三看
#    版本：node -p "require('<profile>/node_modules/dsh-agent-room/package.json').version"   期望 0.1.47
#    监听：GET http://127.0.0.1:3080/agent-room-api/state   该房 listening=true
#    新键：同一条 /state 出现 `activation` 块（旧版没有这个块）
# 3) 现场判据（控制机发、目标机看）
#    控制机：POST /agent-room-api/rooms/<roomId>/chat {"text":"【派活】@B …","human":false}
#    目标机：/state.activation 依次出现 dispatches=1 → accepted=1 → （20 s 后）escalationsAttempted=1 →
#            started=1（带 startedBy* ）→ outputs=1；若始终不产出 → acceptedNoOutput=1（120 s）
#    房间  ：机器真产出时出现它自己的那条回复（`[ack]` 不算）
# 4) 回滚（一台机器）
powershell -NoProfile -ExecutionPolicy Bypass -File "<studio>\upgrade-studio.ps1" -RoomVer 0.1.46 -OrgVer 0.2.12
#    仓库侧：git revert <本版 commit>；旧包仍在 8090 上，不清档
```

**逐机生效提醒**：升级与计数都在**各机本地**产生（`sweepActivation`/`escalateWake` 由本机 tick 驱动），**没有中央激活服务**。因此「控制机升级了」**不等于**「目标机会自己爬起来」：**没升级的机器照旧静默**——而现在这件事本身是**可读的**（发送侧 `ack.unackedTargets`，目标机 `/state.activation`）。收敛的终止条件同样是逐机的：该机 `/state` 里出现 `activation` 块且 `escalationsAttempted` 会动。

---

## 10. 本版**没有**验证 / 主动排除的部分（如实列出）

1. **「已开始」不等于「模型产出了 token」。** 三种证据（`status`/`transcript`/`output`）证明的是**常驻 agent 动了**，不是模型开始推理。本版没有打通「第一个 token」这个信号，也没有打通「这一轮跑完了」。
2. **`acceptedNoOutput` 不等于「有 bug」。** 唤醒提示词**明确允许沉默**（"不需要：不要调用任何工具，保持沉默即可"，`buildListenPrompt`）——所以这个计数是「120 s 内本机没有产出**任何**消息」，其中包含「agent 判定不需要回应」这一正常情形。它值得看，但它不是故障证明；卡里与 `/state` 的注释都这么写。
3. **升级是「尽力而为」的语义**：升级用的是**要求回复**的 activate 提示词，但 0.1.47 只在**派发这一层**能观察，模型是否回话仍在本插件边界之外。若升级后仍无产出，结论是「`activation.acceptedNoOutput`」而不是「升级无效」。
4. **升级刻意不占** UI 的 `activateThinkingRooms`**（见 §3 第 3 条）。** 后果：在升级窗口内，人类仍能在浏览器上点「激活聊天」而拿到 200（不是 409），于是那一轮可能出现**两次**激活提示词。本版**没有**为此加锁；区分手段只有计数（`escalationsAttempted` 会跟着涨）。
5. **`transcript` 证据是**粗**的。** 该会话在派发后写过**任何**一帧（包括与我们这条无关的一轮）都会被算成「已开始」。它对「忙碌的会话」系统性**偏乐观**——这是有意的（宁可少升级，不可多升级），但会**低估**「唤醒没起来」这一类。
6. **激活状态不落盘**（见 §3 第 11 条）：重启后在飞条目丢失，`pending`/`escalations*` 从 0 开始；跨重启的对账本版不做。
7. **`pendingOverflow` 的上界没有实测**：`MAX_ACTIVATION_PENDING=64` 是按「一台机的监听房间 × 在飞唤醒」推的（唤醒面物理上界每房间每 ~90 s 一次，`wake.ts` 头注释），**未**在真实高并发派活下量过。
8. **`status` 证据依赖 handle 暴露 `status`**：探针里的假 agent 与真机上的真实 agent 都支持，但**没有**穷举所有 DSH agent 句柄形态；不支持时**静默**退到 `transcript`（不会报错，也**不会**单独计数「status 不可用」）。
9. **没有**做长稳/压测：tick 是 10 s 且空转零 IO（推导），日志上界是「每派发 ≤3 行」（派发/接受/升级）——均为**推导值**，未在真实流量下实测。
10. **没有**验证与 agent-org 0.2.12 的交互：新增的只是 `/state` 的一个块与若干日志行，org 不读它（理论无影响，**未实测**）。
11. **房主（D）与控制机未升级**（硬约束：不重启会话所在机，不动房主）。因此本版发布时**控制机自己的 `/state` 没有 `activation` 块**——发布当晚要看链，必须去**目标机**的 `/state` 与目标机的日志。
12. **`pendingSkips` 仍然会涨，且依旧不是健康信号**（本版未改、也未接进 activation 的判定，同 0.1.46 §10 第 7 条）。

---

## 11. 与 0.1.45 / 0.1.46 的关系（回归锁，逐条）

| 前版契约 | 本版状态 | 锁在哪 |
|---|---|---|
| 0.1.45：点名本机即唤醒（`@昵称`/`@agentId`/`mentions[]`/裸 agentId/全角＠） | **不变** | `test/wake-activation.test.mjs` 回归锁 + `wake.test.mjs`（17 tests 全绿） |
| 0.1.45：`human:true` 兜底、四类拒绝理由与日志政策 | **不变** | 同上 |
| 0.1.45：单调、不过期水位线；无作者广播 | **不变** | 回归锁（`wm.regressed=1` 仍被计数） |
| 0.1.46：回执每 `(roomId, seq)` 一次、每房间限速 2 s、`[ack]` 是机器帧唤不醒任何人 | **不变** | `ack.test.mjs` 12/12 全绿 + 回归锁 + 静态守卫 |
| 0.1.46：回执在 `agent.followup` **之后**、从不 await、不阻塞 sweep | **不变**（位置与不 await 都没动） | `test/ack.test.mjs` 的静态守卫（本版刻意保留 `agent.followup(` 在 `runListenWake` 内的字面量，就是为了不削弱这条锁） |
| 0.1.46：回执**无条件**发 | **收紧**：只在 `accepted` 时发（§5.5） | 新套件的「回执收紧」用例 + `ack.test.mjs` 全绿 |
| `/state.wake` 19 个键、`/state.ack` 19 个键 | **一个不动**（新计数放 `activation` 块） | 新套件运行时用例断言两块形状与数值 |

---

## 12. 卡与发布物

- 方案卡：`<workdir>\card-09-wake-activation.md`（机理依据 / 阈值来源 / 判据原始输出 / 回滚 / 跨机 / 自评）。
- 缺陷账本：`<workdir>\studio-defect-list.md` 新增 **D-38**（本版：唤醒不启动 / 链上可观测 + 有界自升级）与 **D-39**（现场新发现：`detached: true` 启动的 powershell 在这台 Windows 机上**静默退出 0 且什么都不跑**）。
  ⚠️ 编号说明：本版最初登记的编号是 D-37，但**同一时段另一路 worker 的现场定位（值守 agent 没有模型）先占用了 D-37**；本版对应条目因此为 D-38 / D-39。发布说明与卡里都已按实际编号更正。
- ⚠️ **本文件位于包内**，所以包的 md5 无法写在本文件里（写入即改变哈希）。权威记录在**包外**两处：卡⑨ §6「发布物记录」，以及房间消息。
