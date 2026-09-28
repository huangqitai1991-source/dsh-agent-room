# dsh-agent-room 0.1.49 — 最后十米：会话能跑了，但它的**工作区**让沙箱起不来

发布目标：缺陷 **D-41（本版定名「工作区杀死沙箱」/ unusable session workspace）**。0.1.48 让值守会话**真的能跑**（有模型、回合起转），真机验收停在「**起转了但不产出**」。本版给出**第一手根因**：那条会话的**工作区是家目录**，而 `%TEMP%` 在家目录**里面** ⇒ Windows ACL 沙箱**根本起不来** ⇒ 提示词里唯一的回复通路（`pwsh` + `Invoke-RestMethod`）**每次都在执行前失败** ⇒ 模型去申请 `danger-full-access` 审批 ⇒ **值守会话没有人能回答审批** ⇒ 回合结束、房间里一个字都没有。

> **版本说明**：本版是 0.1.48 的**唯一**后续主线（0.1.48 已提交 `2f1a0fd` 并公布 md5 `b2ba0e9f4ed9a45186094d589edac2e4`，本版**不动那个包**）。本版只改「交给宿主的 `cwd`」与「拿不到可用来回话的会话时怎么办」，不改协议、不动 `wake.ts`/`ack.ts`/`dedupe.ts`。

| 组 | 内容 | 落地版本 |
|---|---|---|
| 工作区守卫 | 建会话的工作区**必须**不包含 OS 临时根目录（`containsDirectory` 与 harness 的 `assertTempRootOutsideWorkspace` 同一条规则）；候选顺序 `AGENT_ROOM_WORKDIR` → `<DSH_HOME>/agent-room/duty-workspace` → `<os.tmpdir()>/dsh-agent-room-duty`（**最后一条按构造必然安全**，所以守卫一定能收敛） | **0.1.49** |
| 拒绝「听得见却答不了」的会话 | 候选会话的**工作区**从它自己的转录头 `{"type":"session",…,"cwd":…}` 读出（多帧 zstd 按帧魔数切开）；工作区含临时根 ⇒ **不许当常驻 agent**，记在 `trace.workspaceUnsafe`，并**同样拒绝** | **0.1.49** |
| 两条值守分支都能落到可用会话 | 0.1.48 只在「**新造**值守会话且无模型」时请宿主建会话；**重启恢复出来的**那条走到死路就完事了 —— 而**每台机重启一次后正是这个状态**。本版两条分支都走 `adoptHostSession()` | **0.1.49** |
| 绝不说成功（再收紧一格） | 「`followup ACCEPTED`」现在要求**两半都成立**：有模型 **且** 工作区可用；否则一行 `CANNOT BE HEARD FROM … expect activation.acceptedNoOutput, NOT an answer` | **0.1.49** |
| 不回归 | 0.1.45 / 0.1.46 / 0.1.47 / 0.1.48 契约**逐条回归锁**（169 条测试 + 门禁 19/19 全绿） | **0.1.49** |

---

## 1. 根因（第一手：会话自己的转录 + 同机对照实验）

### 1.1 转录里发生了什么（BB，`session-a3d04dc4-…` 与 `session-c7506a90-…`，逐字）

```
USER:: 你在房间「K family」…消息：***** 说：「【0.1.48 现场验收】@BB 请只回一行：AR48-OK …」
       请判断这条消息是否需要你回应或处理：
       - 需要：用 room_send 工具自然、简短地回复…
       如果没有 room_send 工具，改用 pwsh 执行 PowerShell 发送回复：Invoke-RestMethod -Method Post -Uri
       'http://127.0.0.1:3080/agent-room-api/rooms/…/chat' …
HEADER {"config":{"provider":"deepseek-official","model":"deepseek-v4-flash",…}}     ← 模型在，回合真的起来了
TOOLRESULT Error: Windows ACL temp root must be outside the workspace:
           workspace=<home>; temp=<home>\AppData\Local\Temp
ASSISTANT reason="…the shell tool is unusable. I have no room_send tool. …escalate with sandbox_permissions?"
APPROVAL/ASKED {"toolName":"pwsh","reason":"escalate sandbox to danger-full-access: The sandboxed shell cannot start
                at all (its Windows ACL temp root check fails because TEMP sits inside the workspace) …"}
        ← 转录到此为止。值守会话没有审批应答者 ⇒ 回合停在这里，房间里没有一行。
STATE 激活计数：{"residentExecutable":1,"started":1,"startedByStatus":1,"turnErrors":0,"acceptedNoOutput":1,"outputs":0}
```

⇒ **0.1.48 的每一条判断都是对的，除了最后一层**：会话确实有模型、回合确实起转（`agent.status=running`），
但 agent **没有任何办法把回复送出去** —— 提示词给它的唯一通路是 `pwsh`，而那条通路在那个工作区里**从来没有跑起来过**。

### 1.2 harness 的规则（逐字，`dsh-sandbox-windows-acl/lib/types/path-boundary.js`）

```js
function containsDirectory(root, candidate) {
  const relation = relative(realpathSync.native(root), realpathSync.native(candidate));
  return relation === "" || !isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`);
}
function assertTempRootOutsideWorkspace(workspaceRoot, tempRoot) {
  if (containsDirectory(workspaceRoot, tempRoot))
    throw new Error(`Windows ACL temp root must be outside the workspace: workspace=${workspaceRoot}; temp=${tempRoot}`);
}
```

而 0.1.48 交给宿主的就是家目录（`src/host/service.ts` 原文）：

```js
cwd: process.env.AGENT_ROOM_WORKDIR ?? homedir(),      // ← 0.1.49 的根因本体
```

BB：`workspace=<home>`，`temp=<home>\AppData\Local\Temp` ⇒ **包含** ⇒ 抛。

### 1.3 同机对照实验（唯一变量是工作区）

在**同一台机**（BB）用宿主自己的 `POST /api/session.create` 建一条**工作区不是家目录**的会话
（`C:/Users/Administrator/.dsh/agent-room/duty-workspace`），然后用 `session.prompt` 让它跑同一条 `pwsh`：

```
TOOLCALL    pwsh {"command": "Write-Output \"SBX-OK\""}
TOOLRESULT  [{"type":"tool-result","content":[{"type":"text","text":"SBX-OK\r\n"}],"isError":false}]   ← 跑起来了
ASSISTANT   "SBX-OK"
TURN/END    {"turn":1,"reason":{"kind":"completed"}}
```

再把**提示词里那条 fallback 命令原样**交给它（同一个会话）：

```
TOOLCALL    pwsh {"command": "Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3080/agent-room-api/rooms/…/chat' …"}
TOOLRESULT  ok=True @{seq=4925; acceptedByLocalHub=True; confirmedByOwner=True; confirmedSeq=4925; confirmNote=owner-confirmed}
ASSISTANT   "DONE"
TURN/END    {"turn":2,"reason":{"kind":"completed"}}
房间         seq=4925 fromNickname=BB human=false control=false   ← 真聊天行（不是 [ack]、不是 [org:*]）
```

⇒ **一个变量（工作区）就决定了「永远没有产出」还是「房间里出现一行真消息」。** 两层原因叠加，缺一层都不会坏：
① 工作区含临时根 ⇒ 沙箱起不来；② **宿主建出来的会话没有 `room_send` 工具**（工具是插件用 `agentCtx.plugin(toolsPlugin)`
挂给**自己创建的**会话的，`session.create` 那条路不经过它）⇒ 提示词只能让 agent 走 shell。

---

## 2. 修复后的语义（本版契约）

```
工作区选择（建会话前）：
  candidates = [AGENT_ROOM_WORKDIR, <DSH_HOME>/agent-room/duty-workspace, <os.tmpdir()>/dsh-agent-room-duty]
  逐个用 containsDirectory(workspace, os.tmpdir()) 检查（Windows only；其它平台该规则不存在）
  第一个通过者胜出；被拒的候选**逐个点名**写进一行 warn（"refusing session workspace(s) …"）
  最后一条是临时根的子目录 ⇒ 按构造不可能包含临时根 ⇒ 守卫**必然**返回一个可用目录
  选中的目录 **mkdir -p**，然后才 POST /api/session.create

常驻会话的「可用性」= 两半：
  可执行  = agent.options.provider && agent.options.model            （0.1.48）
  可回话  = 该会话的工作区不包含临时根                                  （0.1.49）
  工作区读法：<DSH_HOME>/sessions/<ws-slug>/<sessionId>/session.jsonl.zstd 的**第一个 zstd 帧**
             （多帧拼接 ⇒ zstdDecompressSync 会以 "Unknown frame descriptor" 拒绝整体，
              所以按帧魔数 28 B5 2F FD 切出第一帧）→ 头行的 "cwd"
  读不到（无 zstd / 文件不在 / 解析失败）⇒ **不判死**（当作可用），绝不因未知而拒绝

候选择优：
  可执行 **且** 可回话 → 胜出
  可执行但工作区不可用 → **不许胜出**，记为 workspaceFallback，trace.workspaceUnsafe=<dir>
  没有可执行候选   → 先返回「无模型」的 fallback（既有语义不变），否则返回 workspaceFallback

值守会话两条分支：
  重挂成功 + 无模型 + 修不好 → adoptHostSession()（**本版新增**；重启后每台机都在这一支）
  新造成功 + 无模型 + 修不好 → adoptHostSession()
  adoptHostSession() = createHostSession()（每进程一次）→ 在注册表里就直接用它，否则等下一次解析

派发措辞：
  executable && 工作区可用 → "followup ACCEPTED …"
  trace.workspaceUnsafe    → "followup accepted — BUT THIS SESSION CANNOT BE HEARD FROM: … expect
                              activation.acceptedNoOutput, NOT an answer"（限速 warn）
  不可执行                 → "followup accepted — INBOX ONLY, NOT SUCCESS: …"（0.1.48 原文不变）
```

| 观测 | 0.1.48（旧） | 0.1.49（新） |
|---|---|---|
| 宿主建出来的会话工作区 | `homedir()` ⇒ 含 `%TEMP%` ⇒ 沙箱起不来，`pwsh` **每次**执行前失败 ✗ | 专用目录（或显式 `AGENT_ROOM_WORKDIR`，不安全则**拒绝**）✓ |
| 会话可执行但答不了话 | **被当成健康的常驻会话**，`started:1` 一路绿 ✗ | 摘出候选、`trace.workspaceUnsafe`、唤醒行明说「听不到」✓ |
| 重启后（值守会话被恢复、修不好模型） | **到此为止** ⇒ 每台机重启一次就回沉默 ✗ | `adoptHostSession()` ⇒ 请宿主建一条工作区可用的会话 ✓ |
| 不安全的工作区配置 | 静默照用 ⇒ 下一次又静默 ✗ | 逐条点名 + 一行 warn ✓ |
| 唯一变量对照（同机） | —— | 沙箱起不来 **vs** `TOOLRESULT SBX-OK` + 房间 seq=4925 ✓ |

---

## 3. 为什么这样修（一条一条给理由）

1. **为什么是「工作区」而不是「再给一条回复通路」。** 转录里 agent 只做了一件错事：它没有工具可用，于是按**我们自己的提示词**去用 shell，而 shell 死了。给它工具要改宿主 `session.create`（不归我们），改工作区是**我们自己那一行**，而且真机上**一个变量**就分开了「永远没产出」与「房间出现真消息」。先修自己写错的那一行。
2. **为什么最后一条候选是临时根的子目录。** 守卫必须在**任何**机器配置下都返回一个可用目录，否则就是拿一个「可能修不好」换掉「一定跑不了」。子目录按 `containsDirectory` 的定义**永远**不含父目录 ⇒ 候选列表是完备的。
3. **为什么工作区要从**转录头**读，而不是问 agent 句柄。** agent 句柄不暴露 `meta.cwd`（本插件从未读回过它），而会话头是**唯一持久**的工作区记录，并且**重启后依然在** —— 这条判据必须在重启后也成立，否则「重启一次就回沉默」会原样重现。
4. **为什么帧魔数切分而不是换个解码器。** `session.jsonl.zstd` 是**多帧拼接**，`zstdDecompressSync` 对整体抛 `Unknown frame descriptor`（0.1.48 就因为这条**放弃了**读转录头，见卡 §E-4）。切出第一帧不需要新依赖、不需要流式解码器，读的就是头行。
5. **为什么「读不到就不判死」。** 误判成「不可用」会把一台**本来能干活**的机器踢出常驻地位（0.1.48 的教训反面：误判成「健康」和误判成「不可用」都是把判据当结论）。已知不安全才拒绝，未知照用。
6. **为什么重启恢复那条分支也要改。** 0.1.48 只在「新造 + 无模型」时请宿主建会话，而**现场处在「重挂 + 无模型」**（值守会话是重启恢复出来的）—— 于是那一支**走到死路就返回了**。修好工作区却不走到那条路，等于没修。
7. **为什么 `followup ACCEPTED` 要再收紧一格。** D-37/D-40 的全部教训是「没验证的成功行会让人把静默机器记成健康」。本版因此把成功行做成**两半都要成立**；只有一半成立时打的是一句**预言失败**的话（`expect acceptedNoOutput, NOT an answer`），而不是成功。

---

## 4. 改动清单（每个文件一行理由）

| 文件 | 改动 |
|---|---|
| `src/host/service.ts` | 新增 `containsDirectory` / `workspaceAcceptsShell` / `resolveDutyWorkspace`（导出，可单测）；`createHostSession()` 用守卫选工作区 + `mkdirSync` + 逐条点名被拒候选 + 打印 `session workspace = … [source]`；新增 `sessionWorkspaceOf()`（多帧 zstd 切第一帧读头 `cwd`，带缓存）与 `residentWorkspaceUnsafe()`（Windows only）；`resolveResidentAgent()` 的 `accept()` 增加工作区判据 + `workspaceFallback`；`trace.workspaceUnsafe`；新增 `adoptHostSession()` 并在**两条**值守分支接线；唤醒路径 `if (executable && !trace.workspaceUnsafe)` + `CANNOT BE HEARD FROM` 一行 |
| `src/host/activation.ts` | **未改**（不新增计数：`/state.activation` 仍是 42 个键，形状回归锁不动） |
| `src/host/wake.ts` / `ack.ts` / `dedupe.ts` | **未改** |
| `test/duty-model.test.mjs` | **新增 4 条**（17 条总计）：工作区守卫与最后兜底、宿主会话的 `cwd` 与不安全配置的点名拒绝、多帧转录头读出工作区并据此拒绝候选、静态守卫（0.1.48 那行 `cwd: … ?? homedir()` 必须消失；两条分支都要 `adoptHostSession`；成功行需要两半） |
| `docs/RELEASE-0.1.49.md` | 本文件 |
| `package.json` | 版本 0.1.48 → 0.1.49 |
| `lib/**` | `node build.mjs` 重新生成 |

**明确没做**：不改协议/写盘格式；不动 `wake.ts`/`ack.ts`/`dedupe.ts`；**不新增** `/state.activation` 计数（保持 42 键的同形状回归锁）；**不**改值守会话自身的 `meta.cwd`（它是 profile 目录，本来就不含临时根；改它会换掉转录所在的工作区 slug，属于无收益的生命周期风险）；**不**重建任何已存在的会话（只拒绝它、另建一条可用的）。

---

## 5. 发布门禁：同一个脚本，同一套 19 条期望

```
PS> node …\_fix-47\gate-wake-activation.mjs <repo>\lib
=== summary: 19/19 expectations hold on this build (…\lib) ===
    PASS=19 FAIL=0  host/activation.js=present        （exit=0）

套件（逐个直跑，从不用 node --test）：
ack 12 · amplification 2 · backfill 10 · bom-identity 14 · bridge-state 4 · dedupe 2 ·
dedupe-ring 7 · duty-model 17 · listening 7 · liveness 4 · member-dedupe 3 · outbound 10 ·
protocol 8 · rename-profile 16 · selfjoin 2 · sendchat 4 · snapshot 4 · stale-room 3 ·
wake-activation 14 · wake-duplicate 6 · wake 17 · backfill.e2e 3
SUITES=22  TESTS=169  PASS=169  FAIL=0     （0.1.48 基线：22 套件 / 165 通过 ⇒ 本版 +4 条）
npx tsc --noEmit 无输出；node build.mjs → built lib/host/*, lib/client.js, lib/skills/
```

`duty-model.test.mjs` 新增 4 条的关键输出（原始行）：

```
  [ws] default=<DSH_HOME>\agent-room\duty-workspace source=default (DSH_HOME/agent-room/duty-workspace) temp=…
  [ws] win32 guard active: rejected=["<home>\\AppData\\Local\\Temp"]
  [ws] last resort=<os.tmpdir()>\dsh-agent-room-duty (safe by construction)
  [host-ws] cwd=…\ar49-dsh-efSTxa\agent-room\duty-workspace rejected=1
  [ws-session] header cwd read = C:\Users\…\AppData\Local\Temp
✔ 0.1.49: the session workspace is chosen so the sandboxed shell can start at all
✔ 0.1.49: the HOST session is created with a workspace that cannot contain the temp root
✔ 0.1.49: a session whose workspace kills the shell is never the resident agent
✔ 0.1.49 static guard: the workspace, the refusal and the honest wording are in the shipped source
ℹ tests 17   ℹ pass 17   ℹ fail 0
```

---

## 6. 真机现场验证（BB）

判据（本版真正的验收）：**一条脚本化的 `human=false` 点名 ⇒ BB在房间里出现一行真聊天**（`from` = BB、不是 `[ack]`、不是 `[org:*]`）。

现场原始行（安装 + 重启 + 点名）见卡⑨ §0.49 与账本 D-41；本版**必须在真机上跑到「房间里真的有一行」为止**，否则按 §10 的诚实边界记下来。

---

## 7. 交付物与复现入口

```powershell
$REPO = "C:\work\项目\dsh-agent-room"
$GATE = "<workdir>\_fix-47\gate-wake-activation.mjs"
cd $REPO; npx tsc --noEmit; node build.mjs
node $GATE "$REPO\lib"                                    # 期望 19/19 exit 0
Get-ChildItem test\*.test.mjs, test\*.e2e.mjs | ForEach-Object { node $_.FullName }
node test\duty-model.test.mjs                             # 期望 17 pass / 0 fail
# 现场对照实验（同一台机、唯一变量=工作区）：
#   node exp-sandbox.mjs / exp-reply.mjs  ← 见 <workdir>\_rollout-0148\（诊断脚本，不进包）
```

---

## 8. 上线与回滚

```powershell
# 成员机（先停服务再装；升级启动器必须 NON-detached + stdio 落文件，见 D-39）
powershell -NoProfile -ExecutionPolicy Bypass -File "<studio>\upgrade-studio.ps1" -RoomVer 0.1.49 -OrgVer 0.2.12
# macOS：/bin/sh "<studio>/upgrade-studio.sh" your-host 8090 0.1.49 0.2.12
# 升级后四看（GET http://127.0.0.1:3080/agent-room-api/state）：
#   .activation.residentExecutable ≥ 1 / .residentNoModel 视机器 / .turnErrors = 0 / .acceptedNoOutput 不再增长
# 日志应出现：resident: session workspace = … [source] / using the host-created session … / duty agent: …
# 现场判据：点名 → 房间出现该机**非 [ack]、非 [org:** 的聊天行
# 回滚：-RoomVer 0.1.48（仓库侧 git revert 本版 commit）
```

**逐机生效提醒**：本版修的是**每台机自己的常驻会话与工作区**，没有中枢。**旧会话（工作区=家目录）会被本版主动摘掉**，所以「升上来就够了」——机器会自己另建一条可用的。

---

## 9. 与 0.1.45 / 0.1.46 / 0.1.47 / 0.1.48 的关系（回归锁）

| 前版契约 | 本版状态 | 锁在哪 |
|---|---|---|
| 0.1.45 点名唤醒/兜底/拒绝留痕/水位线 | **不变** | `wake.test.mjs` 17 全绿 + 门禁 J |
| 0.1.46 回执/限速/机器帧/真交接后发 | **不变** | `ack.test.mjs` 12 全绿 + 门禁 K |
| 0.1.47 链上计数/有界自升级/超时桶分家 | **不变** | `wake-activation.test.mjs` 14 全绿 + 门禁 A–L |
| 0.1.48 五档模型来源/落盘/就地修复/控制帧 | **不变**（本版只是让「能跑的会话」**真的能把话送出去**） | `duty-model.test.mjs` 0.1.48 段 13 条 + 门禁 M/N/O/P |
| 0.1.48 `followup ACCEPTED` 的措辞 | **收紧**：可执行 **且** 工作区可用才允许 | `duty-model.test.mjs` 静态守卫 + 唤醒路径 |

---

## 10. 本版**没有**验证 / 主动排除的部分（如实列出）

1. **「工作区含临时根」是否**只**影响 shell 工具，未穷举。** 本版只据此拒绝会话；同一工作区对其它工具（fs 读写在 workspace-write 下）的影响未测。
2. **非 Windows 平台上这条规则不存在**（`workspaceAcceptsShell` 在非 win32 一律返回 true）—— macOS/Linux 上「工作区含临时根」**不再**是拒绝理由；本版**没有**在 macOS 上单独验证「不安全工作区」这一分支（只验证了正常的常驻路径不受影响）。
3. **`sessionWorkspaceOf` 依赖 `zlib.zstdDecompressSync`**（Node ≥22.15 左右）。没有该 API 的 Node 上，这条判据**整体退化为「未知 ⇒ 不拒绝」**（就是 0.1.48 的行为），不会崩，但也不会自愈。**未在缺少该 API 的 Node 上实测。**
4. **帧魔数切分假设第一帧之后紧跟第二帧魔数。** 若某个压缩帧的**载荷**里恰好出现 `28 B5 2F FD` 且早于第二帧头，第一帧会被切短 ⇒ 解码失败 ⇒ 退化为「未知 ⇒ 不拒绝」。**未构造该用例。**
5. **宿主建出来的会话仍然没有 `room_send` 工具**（工具只挂给插件自己创建的会话）——本版**没有**修这一条，只是让提示词里那条 `pwsh` fallback **真的能跑**。这条路依赖：localhost HTTP 未被沙箱拦、`Invoke-RestMethod` 可用、房间 API 端口是 3080（或 `AGENT_ROOM_WEB_PORT`）。**未在真机上验证「非默认 web 端口」时的 fallback 行。**
6. **`/state.activation` 没有新增计数**（刻意保持 42 键同形状）：因此「因为工作区不可用而拒绝了一个候选」这件事**只在日志里**（`refusing to use … its workspace … contains the OS temp root`）与 `trace.workspaceUnsafe` 上，**不在数字里**。这是一个有意的取舍（不动形状回归锁），但意味着**用 /state 单独判读会漏掉它**。
7. **被拒绝的旧会话不会被删除**（只拒绝、不清理）：会话目录会随着每次「每进程建一条」缓慢增长，本版**未做**回收。
8. **`workspaceFallback`（唯一可用候选但工作区不安全）仍会被派发**，此时日志打的是 `CANNOT BE HEARD FROM …` 而不是成功行，但**插件不会因此拒绝派发**（拒绝会连「模型也许换个办法答话」的可能一起封死）。
9. **没有**做长稳/压测：新增的是每次解析的一次目录列举 + 一次小文件读（带 64 条缓存）与每次建会话前一次 `mkdirSync`。
10. **只在BB一台真机上做本版的现场验收**；其它三台的现场结论是**同版本部署后的自证**，不是逐台根因复现。
