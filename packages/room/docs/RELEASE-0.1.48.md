# dsh-agent-room 0.1.48 — 让「值守会话」真的能跑：没有模型的会话不再冒充成功

发布目标：缺陷 **D-40（本版定名「无模型值守会话」/ executable resident session）**，并把 0.1.47 的唤醒链/自升级**建立在一条真的能执行的会话上**。
0.1.47 把「唤醒 → 派发 → 常驻会话 → followup 接受/拒绝 → 真正开始 → 产出」**每一步都变成了计数**，并在 20 s 内没有「已开始」证据时自己做一次 activate-chat；但它当时**默认会话本身是能跑的**。并轨的现场定位（账本 D-37）证明这个默认是假的：**值守会话被以空 `agentOptions` 创建 ⇒ 没有模型 ⇒ 回合永远跑不起来**，而 `followup accepted` 照样打印 ✗。
本版**只做这一条主线**：保证常驻会话**可执行**（三层模型来源 + 落盘 + 就地修复 + 每次校验）、**绝不打印未经验证的成功行**、**自己的机器帧不再被当成 agent 产出**；0.1.47 的自升级保留，但它现在升级到一条**真的能跑的会话**。

> **版本说明（写在最前，避免下游客服）**：本改动原定并入 0.1.47。0.1.47 的包**当时已经打包、上传并在报告里公布过 md5**，把新字节塞回同一个版本号会**静默作废一个已公布的哈希**（0.1.44 一晚重打 4 次、作废 3 次已公布 md5 的教训）。因此它发布为 **0.1.48**：0.1.47 未被任何人宣布、只有一台机（B）拉过，0.1.48 = 0.1.47 + 本页全部改动。
>
> **0.1.48 自身在写出任何 md5 之前重打过一次**：首版把「宿主默认」做成**进程内**取 `ctx.agentDefaultModel`，拉到 B 上实测发现**该服务在插件上下文里取不到**（日志逐字："ctx.agentDefaultModel is absent"），值守会话仍然没有模型 —— **同一个根因换了个形式又出现一次**。补上「直接读 `<DSH_HOME>/settings.yaml`」（宿主自己持久化默认路由的地方）并实测可执行之后才重打包。**对外公布过的哈希：0 个**。

| 组 | 内容 | 落地版本 |
|---|---|---|
| 可执行会话 | 值守会话创建时**必须**带上真实 `provider/model`：来源按证据强度 **活会话镜像 → 落盘文件 → 宿主默认（磁盘 `settings.yaml` → 进程内 `ctx.agentDefaultModel`）**；**四档全空时直接请宿主自己建一条真会话**（`POST /api/session.create`，现场实测可用） | **0.1.48** |
| 落盘（重启后仍可执行） | 每次拿到可用选择就写 `dataDir/resident-model.json`；开机读回 ⇒ **重启后注册表为空时仍能造出可执行会话** | **0.1.48** |
| 就地修复 | 宿主重启恢复出来的值守会话**没有** options ⇒ 直接把 `provider/model` 写回 `agent.options`（harness 就是在请求提案时读这两个字段），**不重建会话、不重启** | **0.1.48** |
| 先校验再说话 | 派发前先问「这个 agent 能不能跑一圈」；不能 ⇒ 明确一行 + 计数，`followup accepted` 变成 **`followup accepted — INBOX ONLY, NOT SUCCESS`** | **0.1.48** |
| 吞掉的回合错误可见 | 订阅 `agent/error`（`kick()` 会把它丢弃，这是唯一残留的信号）⇒ `activation.turnErrors` / `turnErrorsNoModel` + 一行解释 | **0.1.48** |
| 自己的帧 ≠ 产出 | 本机 `[org:*]` / `[ack]` 帧**不算产出、不清 thinking**，被忽略时计数（D-37：正是这个误读把两台静默机器记成健康） | **0.1.48** |
| 不回归 | 0.1.45 规则 / 0.1.46 回执 / 0.1.47 唤醒链与自升级**逐条回归锁**（新旧双跑） | **0.1.48** |

---

## 1. 缺陷（根因，读代码 + 真机双重证据）

**1. 空 `agentOptions` ⇒ 没有模型。** `ensureDutyAgent()`（改动前 `service.ts:1086-1192`）用**镜像活会话**的方式取 `provider/model`；而 `dsh web` 的 `process.cwd()` 是 **profile 目录**，`detectActiveSessionId()` 的 workspace 主分支永远 `dir=false`、只能走全局兜底挑到一个**不在注册表里**的转录，注册表里**只有值守会话** ⇒ 镜像循环一个都挑不到 ⇒ `agentOptions` 为空。

**2. harness 拒绝这种 agent 的请求。** `dsh-agent-loop/lib/index.js:714`（逐字）：

```js
if (!proposedConfig.provider || !proposedConfig.model) throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`);
```

而 `kick()`（`:481-490`）把它**丢掉**：

```js
async kick() {
    try { while (await this.turn()); } catch (_error) {} finally { … }
}
```

⇒ **唤醒被接受、`followup accepted` 打印、回合抛错后被静默吞掉**：这就是一整天在追的那个静默失败。真机旁证：C的 `~/.dsh/sessions/…/agent-room-duty-01a094c1-…/session.jsonl.zstd` = **5564 B，自创建起 14 小时未变**。

**3. 它被两次误判成成功。** 日志里的 `own reply landed (seq=…)` 在 C/D 两台机上**全部**是 `[org:exec:result]` —— 那是**本机以自己身份发进房间的总线帧**，不是聊天。C全天**零条真实消息**；D那次「激活成功」的读法是同一个假象。（我在房间里的说法也已按此更正。）

**4. 现场修复证明了方向，但不持久。** 删掉冻结的值守会话 + `reply-agent.json`、重启一次、用宿主自己的 API `POST /api/session.create {cwd:…, agentPreset:"standard"}` 绑一个真实会话 ⇒ C seq=4520 真的发言了 ✓。但那个绑定**只活在运行中的宿主里**，再重启一次就退回原状 —— **永久化必须改代码，就是本版**。

---

## 2. 修复后的语义（本版契约）

```
解析常驻 agent（解析顺序不变），但**候选必须可执行才能胜出**：
  candidates 按优先级收集（config → active-session → duty → persisted → identity → heuristic）
  for each candidate:
      tapAgentError(agent)                      # 订阅 agent/error（吞掉的回合错误唯一残留）
      if agent.options.provider && agent.options.model  → 胜出（trace.executable = true, trace.model = …）
      else 尝试 repairResidentModel(agent):
           选择来源（按证据强度）：① 活会话镜像 ② dataDir/resident-model.json ③ ctx.agentDefaultModel.currentSelection()
           写回 agent.options.provider/model（harness 就在请求提案时读这两项）→ 复验
           成功 → 胜出（trace.detail 写明 "model REPAIRED to <p>/<m> (<source>)"）
      else 记为 fallback，继续找下一个
  没有可执行的候选 → 返回 fallback（若存在），trace.executable = false

值守会话（agent-room-duty-<agentId>，id 确定 ⇒ 重启自动重挂）：
  重挂成功 + 可执行 → 直接返回，并把它记进 resident-model.json
  重挂成功 + 无模型 → repairResidentModel → 成功即返回；失败则明确告警 + 计数
  需要新建 → resolveModelSelection() 取选择（镜像 → 落盘 → **宿主默认：先读磁盘 `<DSH_HOME>/settings.yaml`，
             读不到再问进程内 `ctx.agentDefaultModel`**），以 agentOptions 传入创建；
             没有来源 ⇒ 告警 "SPAWNED WITHOUT a provider/model"，仍然创建（唤醒路径不能崩），
             然后**请宿主自己建一条真会话**（每个进程最多一次）：
               POST http://127.0.0.1:<WEB port, not the room port>/api/session.create
               {"type":"client-request","rpcId":…,"method":"session.create",
                "payload":{"cwd":<AGENT_ROOM_WORKDIR 或 homedir>,"agentPreset":"standard"}}
               → {"result":{"ok":true,"value":{"sessionId":"session-…","agentPreset":"standard"}}}
             拿到 sessionId ⇒ 绑定并落盘（reply-agent.json）⇒ 它在注册表里就立刻当常驻 agent 用；
             宿主拒绝/不可达 ⇒ 计数 + 告警（**绝不重试**）

唤醒路径：
  派发前 const executable = trace.executable ?? agentExecutable(agent) —— 先问，再说
  不可执行 → 一行 "has NO provider/model … THIS TURN CANNOT RUN" + 限速告警 + activation.residentNoModel
  followup 返回后：
     executable → "followup ACCEPTED … (inbox only …)"
     不可执行   → "followup accepted — INBOX ONLY, NOT SUCCESS: … has NO provider/model, so the turn cannot run"

自己的帧：
  from = 本机 且（[org:*] 控制帧 或 [ack]/[ack-miss] 回执）→ 不产出、不清 thinking、计 controlFramesIgnored + 一行
  只有真正的聊天行才算产出，才结束 thinking
```

| 观测 | 0.1.47（旧） | 0.1.48（新） |
|---|---|---|
| 值守会话有没有模型 | 只镜像活会话；镜像不到就是**空的**，而日志照打印 `followup accepted` ✗ | 四档来源 + 落盘；创建即带模型，且日志写明 `EXECUTABLE (provider=… model=…)` ✓ |
| 四档全空（真机实测就是这样） | —— | **请宿主自己建一条真会话**（`POST /api/session.create`，每个进程一次），拿到就用它 ✓ |
| 重启后还可用吗 | **不可用**：宿主恢复的会话没有 options，镜像仍无来源 ⇒ 又变回不能跑 ✗ | `resident-model.json` + 就地修复 + 真会话（宿主会恢复它）⇒ 重启后仍可执行 ✓ |
| 会话不能执行时说什么 | `followup accepted`（**成功语气**）✗ | `followup accepted — INBOX ONLY, NOT SUCCESS: … has NO provider/model` + `residentNoModel` 计数 ✓ |
| 回合抛错被 harness 吞掉 | 完全不可见 ✗ | `agent/error` 订阅 ⇒ `turnErrors` / `turnErrorsNoModel` + 一行解释 ✓ |
| 自己的 `[org:exec:result]` 帧 | 被当成「本机回复了」，还会清掉 thinking ✗（两台机因此被记成健康） | 不算产出、不清 thinking、计 `controlFramesIgnored` + 一行 ✓ |
| `/state` | `activation.{33}` | `activation.{42}`（+9：可执行/无模型/修复成功/修复失败/turnErrors/turnErrorsNoModel/controlFramesIgnored/hostSessionsCreated/hostSessionCreateFailed）✓ |

---

## 3. 为什么这样修（一条一条给理由）

1. **为什么必须有「落盘」这一层，而不是只补一个默认值。** 缺陷的触发条件是**重启**（注册表清空）。只在创建时补默认值，下一个重启又会重演——这正是 C 现场修复的教训（绑定只活在进程里）。所以：每次拿到可用选择就写盘，开机读回，`repairResidentModel` 拿它当第二来源。
2. **为什么宿主默认要**先读磁盘**，而不是只问进程内的 `ctx.agentDefaultModel`。** 首版就是只问进程内，拉到 B 上实测**取不到**（日志逐字："ctx.agentDefaultModel is absent"）⇒ 三档全空、值守会话仍然没有模型 —— **同一个根因换了形式又出现一次**。宿主把这份默认路由**持久化在 `<DSH_HOME>/settings.yaml`**（`agent-default-model: {provider, model, reasoningEffort}`；`dsh-agent-default-model/lib/index.js:56` 的 `currentSelection()` 读的就是这个 section），所以本版**直接读该文件**（两行子集解析，不引入 YAML 依赖、不依赖任何服务）。教训与 D-32/D-38 同族：**探针里能拿到的东西，不等于真机上拿得到**——所以要落到「真机上量过」为止。
3. **为什么修复是「写回 `agent.options`」而不是重建会话。** harness 在请求提案时读 `this.options.provider/model`（`dsh-agent-loop/lib/index.js:696-699`），所以写回就是修复本身；而**重建**一个已经发布、已挂在会话上的 agent 是生命周期风险（两个 agent 挂同一个 session），万一宿主把它按 `already exists` 拒掉，反而把机器推到更坏的状态。
4. **为什么仍然创建（而不是拒绝创建）没有模型的值守会话。** 因为 harness 允许**别的东西**经 `agent/request` waterfall 提供 provider/model（错误信息自己写着）。猜「它一定跑不了」并跳过创建，就是把一个可救的状态判死。正确做法是：**照常交出去，但绝不说成功**，并把结果交给窗口证据（`started` / `acceptedNoOutput`）。
5. **为什么必须订阅 `agent/error`。** 这是 `kick()` 吞掉之后**唯一残留**的信号（`throwError` 先 `emit` 再抛）。没有它，同样的故障下次还是只能靠「转录音节数 14 小时没变」这种间接证据。
6. **为什么「自己的帧不算产出」要单独计数。** D-37 里两台机被误判成健康，靠的就是这条误读。**修好判定还不够**——必须让下一次误读**不可能静默发生**：`controlFramesIgnored` 会涨，日志会点名（「NOT the agent speaking」）。
7. **为什么保留 0.1.47 的自升级。** 升级到一条能跑的会话才有意义，而「唤醒没起来」这件事**仍然**需要一个自动动作（人不能永远在浏览器上点一下）。本版只是把升级的**落点**修好：解析现在优先可执行候选，并会顺手修复模型。
8. **为什么阈值/窗口一个都没改。** 20 s / 120 s / 10 s 的推导见 0.1.47；本版改的是「会话能不能跑」，不是「多快判定」。

---

## 4. 改动清单（每个文件一行理由）

| 文件 | 改动 |
|---|---|
| `src/host/activation.ts` | 新增 7 个扁平计数与写入点：`residentExecutable`（`:227`）/ `residentNoModel`（`:229`）/ `executabilityRepairs`（`:232`）/ `executabilityRepairFailed` / `turnErrors`（`:238`）/ `turnErrorsNoModel` / `controlFramesIgnored`（`:244`），方法 `noteResidentExecutability`（`:416`）/ `noteExecutabilityRepair`（`:422`）/ `noteTurnError`（`:434`）/ `noteControlFrameIgnored`（`:440`），`stats()` 暴露（`:590-596`）⇒ `/state.activation` 40 个数字 |
| `src/host/service.ts` | `agentModelOf`；`agentExecutable`；`hostDefaultModel`（问进程内 `ctx.agentDefaultModel`）；`mirroredModel`；**`settingsFileModel`（读 `<DSH_HOME>/settings.yaml` 的 `agent-default-model` 段）**；`resolveModelSelection`（四档：镜像 → 落盘 → settings.yaml → 进程内服务）；`saveResidentModel`；`repairResidentModel`（写回 + 复验 + 计数 + 落盘）；`tapAgentError`；`resolveResidentAgent` 改为**候选必须可执行才胜出**（含 fallback 标记）；`ensureDutyAgent` 重挂即校验/修复、创建即带模型、无来源时告警；`noteOwnReply` 区分控制帧；唤醒路径派发前校验与非成功语气的接受行；升级路径同样校验；`resident-model.json` 与 `settings.yaml` 路径 |
| `src/host/wake.ts` / `ack.ts` | **未改** |
| `test/duty-model.test.mjs` | **新增 10 条测试**（见 §6） |
| `docs/RELEASE-0.1.48.md` | 本文件 |
| `package.json` | 版本 0.1.47 → 0.1.48（⚠️ 写盘用 `[IO.File]::ReadAllText/WriteAllText` + `UTF8Encoding($false)`：本版第一次改版本号时被 `Set-Content -Encoding UTF8` **写进了 BOM**，`git diff` 当场抓到并已按 G3 改正 —— 记录在此，因为它正是卡模板附录 B 那个坑） |
| `lib/**` | `node build.mjs` 重新生成 |
| （工作区，不在包内）`<workdir>\_fix-47\gate-wake-activation.mjs` | 双向门禁扩到 **19 条期望**（新增 M/N/O/P：模型来源、无来源时的不成功语气、就地修复、落盘后仍可执行） |
| （工作区，不在包内）`<workdir>\card-09-wake-activation.md` | 方案卡 ⑨（已补 §0.48 一节与现场原始行） |

**明确没做**：不改协议/写盘格式；不动 `wake.ts`/`ack.ts`/`dedupe.ts`；**不重建**已有会话（只写回 options）；**不**给「不能执行的会话」造一个假成功；**不**改 0.1.47 的窗口与升级边界；**不做**「跨重启续做在飞唤醒」。

---

## 5. 发布门禁：同一个脚本，三种构建

`<workdir>\_fix-47\gate-wake-activation.mjs`（**19 条期望**）：

```
PS> node … "<workdir>\_fix-47\old046\lib" "…\old046\src"     # 真实 0.1.46（git archive 73a92a9）
=== summary: 2/19 expectations hold on this build ===   （exit=1）
    —— 只有两条 0.1.45/0.1.46 回归锁通过（设计如此）

PS> node … "<workdir>\_fix-47\old047\lib" "…\old047\src"     # 真实 0.1.47（git archive 0cd5682）
=== summary: 15/19 expectations hold on this build ===  （exit=1）
    FAIL M / the duty session is created with a REAL model selection
        create.agentOptions = [{}]        ← 空的：这就是根因本体
    FAIL N / … no residentNoModel counter — a model-less session is invisible
    FAIL O / a restored duty session WITHOUT a model is REPAIRED in place — still has no provider/model
    FAIL P / DURABILITY — the selection was NOT persisted (resident-model.json missing)

PS> node … "C:\work\项目\dsh-agent-room\lib"      # 本版
=== summary: 19/19 expectations hold on this build ===  （exit=0）
    PASS M   create.agentOptions = [{"provider":"deepseek","model":"v4-flash"}]
             LOG: "duty agent: model source = host-default (ctx.agentDefaultModel) …" / "spawned … — EXECUTABLE"
    PASS N   LOG: "… SPAWNED WITHOUT a provider/model (and could not be repaired …)"；control-frame: outputs=0 ignored=1
    PASS O   after ensure: options={"provider":"deepseek","model":"v4"} created=0 （就地修复，没有重建）
    PASS P   persisted: {"provider":"deepseek","model":"v4-pro","source":"host-default (ctx.agentDefaultModel)",…}
             after a simulated restart (no host service, empty registry): {"provider":"deepseek","model":"v4-pro"}
```

**套件级旧构建对照**（`AR_LIB`）：

```
PS> $env:AR_LIB="…\old047\lib"; node test/duty-model.test.mjs    →  ℹ tests 13  pass 0  fail 13   （exit=1）
PS> $env:AR_LIB="…\old046\lib"; node test/duty-model.test.mjs    →  同样全红（旧构建连 activation.js 都没有）
```

---

## 6. 测试计数（`node test/<name>.mjs` 逐个直跑，**从不用** `node --test`）

```
Suite                      Tests Pass Fail
ack.test.mjs               12    12   0
amplification.test.mjs     2     2    0
backfill.e2e.mjs           3     3    0
backfill.test.mjs          10    10   0
bom-identity.test.mjs      14    14   0
bridge-state.test.mjs      4     4    0
dedupe.test.mjs            2     2    0
dedupe-ring.test.mjs       7     7    0
duty-model.test.mjs        13    13   0      ← 本版新增
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
wake-activation.test.mjs   14    14   0      ← 0.1.47 的链/升级回归锁（本版未回归）
wake-duplicate.test.mjs    6     6    0
wake.test.mjs              17    17   0

SUITES=22  TESTS=165  PASS=165  FAIL=0
（0.1.47 基线：21 套件 / 152 通过 ⇒ 本版 +1 套件 / +13 条）
```

`npx tsc --noEmit` 无输出（0 error）；`node build.mjs` → `built lib/host/*, lib/client.js, lib/skills/`。

新增的 13 条（`test/duty-model.test.mjs`）：宿主默认模型被用于创建（断言 `agents.create` 收到 `{provider, model}` 且日志写 EXECUTABLE）、活会话优先镜像、**DURABILITY**（先学一个选择→落盘→用同一个 dataDir 起第二个服务、注册表为空且**没有**宿主默认 → 仍造出可执行会话）、**就地修复**（同一个会话对象被复用、`executabilityRepairs=1`、没有第二个会话）、**无来源时绝不说成功**（空 options + `SPAWNED WITHOUT…` + 唤醒路径出现 `INBOX ONLY, NOT SUCCESS` 且**不出现**旧的 `followup ACCEPTED seq=`）、**候选必须可执行才胜出**（先标 `NOT EXECUTABLE`，补上来源后被修复并胜出）、**`agent/error` 订阅**（`turnErrors=2 / turnErrorsNoModel=1`，不重复订阅）、**控制帧不算产出也不清 thinking**（`[org:*]` 与 `[ack]` 各验一次，真实聊天行才算）、**`/state.activation` 40 个键同形状**、**磁盘 `settings.yaml` 一档**（真机实测需要：进程内服务取不到；同时验证「没有该 section 就不猜」）、**宿主 API 建会话**（每个进程最多一次、请求体形状逐字断言、失败计数且不重试）、以及静态守卫（来源顺序 / 创建即带模型 / 校验在 followup 之前 / 非成功语气 / 落盘文件存在且开机读回）。

---

## 7. 真机现场验证

现场原始输出**写在卡里**（`<workdir>\card-09-wake-activation.md` §6.3），本节只写纪律与判据：

- **机器**：B `01a09461-351d-793d-bf49-b8e08641f082`（允许触碰的两台之一；**未碰**D、**未碰**C、**未碰**控制机）。
- **安装**：该机**自己的** `upgrade-studio.ps1`（先停服务再装，绝不手抄 `node_modules`）。
  ⚠️ **启动器的坑（D-39）**：`node → detached powershell` 在这台 Windows 机上**静默退出 0 且什么都不执行**；本版用**非 detached + stdio 落文件 + 启动器活到子进程结束**，实测升级跑完（`=== [6] Install === + dsh-agent-room 0.1.48`）。
- **判据（本版真正的验收）**：控制机 `POST /rooms/<roomId>/chat {"human":false}` 点名B →
  ① 目标机 `/state.activation` 出现 `residentExecutable ≥ 1`、`residentNoModel = 0`（**这台机会执行**）；
  ② 日志出现 `duty agent: … EXECUTABLE` 或 `model REPAIRED`（会话真的带上了模型）；
  ③ 房间出现一条**来自B的、非 `[ack]`、非 `[org:` 的聊天行**（这才是「昨天一整天零产出」的解药）；
  ④ **再重启一次**（同一台机）后重复 ①②③ —— 这是**持久化**要求。
- **诚实边界**：若 ③ 仍不成立，`activation.{residentNoModel,acceptedNoOutput,turnErrors,turnErrorsNoModel}` 会精确指出卡在哪一步（本版把它们全部做成了数字）。

---

## 8. 交付物与复现入口

```powershell
$REPO = "C:\work\项目\dsh-agent-room"
$OLD46 = "<workdir>\_fix-47\old046\lib"    # git archive 73a92a9（0.1.46）+ node_modules junction
$OLD47 = "<workdir>\_fix-47\old047\lib"    # git archive 0cd5682（0.1.47）+ node_modules junction
$GATE  = "<workdir>\_fix-47\gate-wake-activation.mjs"

cd $REPO; npx tsc --noEmit; node build.mjs

node $GATE "$OLD46" "$REPO\_fix-47\old046\src"   # 期望 2/19  exit 1
node $GATE "$OLD47" "$REPO\_fix-47\old047\src"   # 期望 15/19 exit 1（M/N/O/P 红）
node $GATE "$REPO\lib"                           # 期望 19/19 exit 0

Get-ChildItem test\*.test.mjs, test\*.e2e.mjs | ForEach-Object { node $_.FullName }
$env:AR_LIB = $OLD47; node ($REPO + "\test\duty-model.test.mjs")     # 期望 0 pass / 10 fail

# 原始输出留档：<workdir>\_fix-47\{gate-old.txt,gate-old047.txt,gate-new.txt,duty-old047.txt,duty.out.txt}
```

> 旧构建树必须在**能找到 `node_modules`** 的位置（`lib/host/service.js` 会 `import "@deepseek-ai/cordis"`，裸包名按文件所在目录向上解析），所以它们放在 `<workdir>\_fix-47\old0XX\` 并把 `old0XX\node_modules` 做成指向本仓 `node_modules` 的 **junction**。

---

## 9. 上线与回滚

```powershell
# 1) 成员机（B / A）：先停服务再装；启动方式见 §7 的 D-39 提醒（不要用 detached）
powershell -NoProfile -ExecutionPolicy Bypass -File "<studio>\upgrade-studio.ps1" -RoomVer 0.1.48 -OrgVer 0.2.12
# 2) 升级后四看（这台机到底能不能跑）
#    GET http://127.0.0.1:3080/agent-room-api/state
#      .activation.residentExecutable ≥ 1     ← 常驻会话可执行
#      .activation.residentNoModel = 0        ← 没有「无模型会话」被用过
#      .activation.turnErrors = 0             ← 没有回合错误被吞掉
#      .activation.controlFramesIgnored ≥ 0   ← 自己的帧没有被误当成产出（涨了是好事，说明判定在工作）
#    日志里应有：duty agent: … EXECUTABLE / model REPAIRED / model source = …
# 3) 现场判据：控制机发一条 human=false 点名 → 房间出现该机**非 [ack]、非 [org:** 的聊天行
# 4) 回滚（一台机器）
powershell -NoProfile -ExecutionPolicy Bypass -File "<studio>\upgrade-studio.ps1" -RoomVer 0.1.47 -OrgVer 0.2.12
#    仓库侧：git revert <本版 commit>
```

**逐机生效提醒**：本版修的是**每台机自己的常驻会话**，没有中枢。「控制机升级了」不等于「目标机会跑起来」——现在这件事是**可读的**（`/state.activation.residentNoModel` / `residentExecutable`）。收敛终止条件：该机 `/state.activation` 出现 `residentExecutable ≥ 1` 且一次点名后 `outputs` 或 `acceptedNoOutput` 二者之一会动。

---

## 10. 本版**没有**验证 / 主动排除的部分（如实列出）

1. **`residentExecutable` 只证明「有 provider/model」，不证明「这一轮跑完」。** 模型名存在而适配器不可用、额度耗尽、上游 502 等，仍会失败——这些由 `turnErrors` / `acceptedNoOutput` 暴露，**不是**本版能预防的。
2. **写回 `agent.options` 依赖该对象可变。** 冻结/代理实现下写回会失败：那时**明确告警 + `executabilityRepairFailed` 计数**，并退回「照常派发但绝不说成功」。**没有**在真机上验证过「写回失败」这条分支（只在探针里造过）。
3. **`ctx.agentDefaultModel` 的可达性只在探针里验证过**（探针优先用真实 `ctx.agentDefaultModel`，被 cordis 上下文拒绝时才退到方法覆写；输出里会打印用的是哪一种）。真机上是否 `ctx.get("agentDefaultModel")` 直接可达，**未在真机上单测**。
4. **`agent/error` 订阅靠结构化访问**（`agent.dispatch.on`）。没有 `dispatch` 的 agent 视图 ⇒ 订阅不上，只剩「有/没有模型」这一个判据。**未穷举**所有 agent 句柄形态。
5. **不做**跨重启续做在飞唤醒；`activation` 状态仍**不落盘**（落盘的只有模型选择）。重启后 `pending/escalations*` 从 0 开始。
6. **`controlFramesIgnored` 会持续增长**（每次本机总线帧都算），**它不是故障信号**——它是「判定在工作」的证据；本版没有给它做速率上限之外的任何归一化。
7. **`resident-model.json` 里存的是上一次成功的模型选择**：如果管理员之后换了默认模型，而该机长期没有活会话可镜像，落盘值会**优先于**新的宿主默认被使用（顺序是「活会话 → 落盘 → 宿主默认」）。这是一个**有意的取舍**（稳定性优先），但**没有**做「落盘值是否过期」的判定。
8. **没有**做长稳/压测：新增的都是每次解析/每次派发上的常数级检查 + 一个可选的落盘写。
9. **只在B一台真机上做现场验收**（A当时在跑自己的活，未打断；未碰D/C/控制机）。
10. **C/D 的现场修复（删会话 + 重启 + `session.create` 绑定）不是本版实现的**：本版是让**插件自己**在未来不再需要那次手工修复。两台机的**持久修复**需要它们各自升级到 0.1.48（**未做**，不属本次可触碰范围）。

---

## 11. 与 0.1.45 / 0.1.46 / 0.1.47 的关系（回归锁）

| 前版契约 | 本版状态 | 锁在哪 |
|---|---|---|
| 0.1.45：点名唤醒/兜底/拒绝留痕/单调水位线 | **不变** | `wake.test.mjs` 17 全绿 + 门禁 J |
| 0.1.46：回执每 `(room,seq)` 一次、限速、机器帧、只在真交接后发 | **不变** | `ack.test.mjs` 12 全绿 + 门禁 K |
| 0.1.47：链上每步计数、升级每次派发最多一次、超时桶分家、`/state.activation` 形状 | **不变**（新增 7 个键；旧 33 个键一个不动） | `wake-activation.test.mjs` 14 全绿 + 门禁 A–L |
| 0.1.47：`followup accepted` 的措辞 | **收紧**：会话不能执行时改为 `INBOX ONLY, NOT SUCCESS` | `duty-model.test.mjs`「绝不说成功」用例 + 门禁 N |
| 0.1.47：自己的 ack 帧不算产出 | **加强**：`[org:*]` 同样不算产出、且不清 thinking | `duty-model.test.mjs` 控制帧用例 + 门禁 N |

---

## 12. 卡与发布物

- 方案卡：`<workdir>\card-09-wake-activation.md`（机理依据 / 阈值来源 / 判据原始输出 / 回滚 / 跨机 / 自评；§0.48 一节记本版）。
- 缺陷账本：`<workdir>\studio-defect-list.md` 新增 **D-40**（本版），并交叉引用 **D-37**（另一路 worker 的根因定位）与 **D-38/D-39**（0.1.47）。
- ⚠️ **本文件位于包内**，包的 md5 无法写在本文件里（写入即改变哈希）。权威记录在**包外**：卡⑨ §11「发布物记录」。
