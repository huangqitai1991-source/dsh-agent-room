# dsh-agent-room 0.1.40 — 改名入口（三处名字收敛）

发布目标：`card-01-nickname-v4.md` §4.1 / §4.3 / §4.4 / 4.2 的房间侧一半 + `card-template.md` 的门禁。
配套版本：**dsh-agent-org 0.2.12**（本版会调用它；两版可分别安装，但 org 侧 0.2.12 才有关闭授权缺口的检查）。
本版**不动协议**、**不动 0.1.39 的投递去重**、**不动 0.1.38 的三道保护**（BOM 读、损坏拒写、写前已验证备份）。

---

## 1. 缺陷（一句话）

**昵称没有任何受支持的修改入口**：`updateProfile()`（`src/host/room-service.ts:132`）全仓零调用方，21 个 `room_*` / `task_*` 工具里没有改名工具，`web.ts` 里没有 profile 路由（末条业务路由是 `member-capabilities`，其后直接 404）。

于是唯一的路是手改 `identity.json`，而**运行中的进程看不到它**：

- `this.identity` 全仓只有两处赋值（`room-service.ts:113` 载入 / `:124` 铸造），boot 时赋一次后**永不重读磁盘**；
- 没有任何 watcher / reload 路径；
- 下一次 `saveIdentity`（capability 合并、任何 profile 更新）会用**缓存对象**重写文件 ⇒ **手改名被静默回滚**。

⇒ 「必须重启」是**入口缺失的后果**，不是架构必然：`updateProfile()` 改的就是那个被缓存的**同一个对象**（`RoomClient` 构造时按引用持有它，`syncProfile` 每次从缓存读），所以补上入口 + 主动扇出即可**无需重启**。

## 2. 新契约（OLD vs NEW）

| 观测 | 0.1.39（旧） | 0.1.40（新） |
|---|---|---|
| 受支持的改名入口 | **无**（`POST /agent-room-api/profile` 404；无工具；`updateProfile` 零调用方） | `POST /agent-room-api/profile {nickname}` + `agent_rename_self({nickname})`（同一实现） |
| 改本机 `identity.json`（A） | 只能手改磁盘 | 入口写盘（仍是 `saveIdentity`，带 **G1 校验 + 写前已验证备份**） |
| 运行中进程的显示名 | 手改磁盘**不可见**（重读需重启） | **立即变更**（原地改缓存对象，无重启） |
| 房主侧成员昵称（B） | 只有 15 s tick 会推；改名入口不存在 | **同一调用内立刻推**（`pushProfileNow()`），**且** 本机托管的房间直接更新成员行 |
| 组织树节点名（C） | **完全没有通道**（agent-org 全仓 0 处 `nickname`） | 同一次调用经 `ctx.get("agentOrg")` → `renameSelfByAgentId`（org 侧走 `save()`：rev+1 + 广播快照） |
| org 改名授权 | **无任何检查**（`updateNode` 不调 `checkPermission`，路由不传调用者身份） | 由 **0.2.12** 补齐：改自己 = L1，改他人 = L2（org owner 可直接，其他需审批），**空 actor 一律拒绝** |
| 坏名字（U+FFFD / 连续 `?` / `NAME` / 空白） | 房间侧写路径已有 G1；**入口不存在所以谈不上拒绝** | 入口 **改任何东西之前**拒绝；HTTP **400**；**三处都不动** |
| 「被写坏的旧名字」修复 | 手改磁盘 + 重启，且会被下次 save 回滚 | `tools/repair-identity.mjs --repair-names`：**先报告、再显式 `--set-name <agentId>=<name>` 落盘**（带备份，从不猜名字） |

**「无需重启」的机理（实测，见 §5 NEW-4）**：`renameSelf()` 先取**缓存对象**（`getIdentity()`，同步、不铸造），交给 `updateProfile()`（原地改该对象 + 落盘），再扇出。**绝不使用 `gateway.identity()` / `ensureIdentity()`** —— 它们在缓存为空时会**铸造并写入新身份**（对一个改名入口是最坏副作用）。

## 3. 改动清单（每个文件一行理由）

| 文件 | 改动 |
|---|---|
| `src/host/safety.ts` | 新增 `assertValidNickname()`（复用 0.1.38 的 `nicknameProblem` 规则，**先 trim 再判**）、`InvalidNicknameError`（HTTP 400 用）、`IdentityNotReadyError`（缓存空时拒改，HTTP 409 用）。G1 规则**没有第二份实现** |
| `src/host/service.ts` | ① `syncProfile()` 的扇出体抽成 `fanOutProfile()`，`pushProfileNow()` 公开复用（**15 s 定时器原样保留**，仍指向同一函数体）；② 新增 `renameSelf()`（A→B→C 三步 + `nicknameConflicts` 报告）；③ `gateway.renameSelf` 暴露给工具/路由 |
| `src/host/web.ts` | 新增 `POST /agent-room-api/profile`：坏名 **400**、身份未就绪 **409**、其余走既有 500；成功 200 返回三处结果 |
| `src/tools/gateway.ts` | `SelfRenameResult` 类型（**每处名字一个字段**，`org.updated:false` 必带 `reason`）+ `RoomGateway.renameSelf` |
| `src/tools/index.ts` | 新增工具 `agent_rename_self`（第 22 个工具），走 `gateway.renameSelf` —— 与路由**同一实现**，不存在第二条路径 |
| `src/skills/agent-room/SKILL.md` | 新增「Renaming this node」一节：用 `agent_rename_self`，**不要手改 `identity.json`**（会被回滚） |
| `tools/repair-identity.mjs` | 新增 `--repair-names`（只报告：A 的 nickname + C 的节点名，逐个打 BAD/ok 与**修复命令**）+ `--apply --set-name <agentId>=<name>`（两阶段：先解析并打印计划，再逐个备份→写→**重读校验**）。名字门禁**动态载入插件自己的 `lib/host/safety.js`**，不复制规则 |
| `test/rename-profile.test.mjs` | **新增 16 条**：见 §6 |
| `package.json` | 版本 0.1.39 → 0.1.40 |
| `docs/RELEASE-0.1.40.md` | 本文件 |

**明确没做**（连同理由）：

- **不做客户端的改名输入框**：本版契约是「一个受支持的入口」，路由 + 工具已足；改 React 客户端要重建客户端包并回归整块房间面板，风险与本版的收益不成比例（登记为后续项）。
- **昵称唯一性：报告而不拒绝**。卡的 §4.3 要求「检查与房内现有昵称不冲突」，因为 `room-service.ts:348` 的 @提及解析在同名 >1 时抛 `ambiguous-member`。本版**照做检查、但不因此拒绝改名**：拒绝会让「唯一受支持的改名入口」因为一个调用方可能根本没想到的房间而失败，而本版要治的正是「名字改不了」。冲突以 `nicknameConflicts: [{roomId, agentIds}]` 出现在返回体里（大小写不敏感，与 @提及解析口径一致），调用方能立刻看到。
- **不动 `syncProfile` 的 15 s 定时器**，也不删 `sendProfile` 的另外两个调用点（`setMemberRoles` / `setMemberCapabilities`）：它们是「设置岗位/能力」动作捎带昵称的正常行为。

## 4. 发布门禁第 1 步 — OLD 行为（**改动前**跑的原始输出）

### 4.1 线上 3080：没有这个路由（`POST` 打一个不存在的路径，**不改任何状态**）

```
PS> curl.exe -s -o - -w "`nHTTP_STATUS=%{http_code}`n" -X POST -H "content-type: application/json" -d '{\"nickname\":\"probe-not-applied\"}' http://127.0.0.1:3080/agent-room-api/profile
{"ok":false,"error":"not-found"}
HTTP_STATUS=404
```

### 4.2 进程内：磁盘改名对运行中的进程不可见，**必须重启**才生效

探针 `<workdir>\_rename-old-evidence.mjs`（真构建产物 `lib/host/room-service.js`，`dataDir` 指向 `<workdir>\_rename-old-evidence\` 临时目录；**不启停任何服务、不改本机身份、不触网**）：

```
PS> cd <workdir>; node _rename-old-evidence.mjs
=== OLD-1: the running process caches the identity; a disk edit is invisible ===
  identity.json on disk before edit : OLD-NAME
  booted instance getIdentity()     : OLD-NAME
  identity.json on disk after edit  : HAND-FIXED-ON-DISK
  same running instance             : OLD-NAME
  ensureIdentity() (same object)    : OLD-NAME
  VERDICT 1: disk edit visible to the running process? NO <- the old name is what every reader still reports
  and the next save rewrites the file from that cached object, so the hand fix is reverted

=== OLD-2: only a restart (a fresh instance) sees the edited bytes ===
  live instance before restart      : OLD-NAME
  fresh instance (simulated restart): HAND-FIXED-ON-DISK
  VERDICT 2: a restart is required, exactly as the card documents

=== OLD-3: is there a supported entry point? (source-level, read only) ===
  updateProfile occurrences in src/host/room-service.ts : 1 (definition only, 0 callers)
  updateProfile occurrences in src/host/web.ts           : 0
  updateProfile occurrences in src/tools/index.ts        : 0
  gateway rename entry point in src/tools/gateway.ts     : 0
  POST routes declared in src/host/web.ts                : 20
  /agent-room-api/profile route in src/host/web.ts       : 0
  registered tool names in src/tools/index.ts            : 21
  routes that exist: /agent-room-api/state | /agent-room-api/events | /agent-room-api/relay-config | /agent-room-api/mode |
      ^/agent-room-api/rooms/([^/]+)/messages$ | /agent-room-api/rooms | /agent-room-api/join | … | ^/agent-room-api/rooms/([^/]+)/member-capabilities$ | /agent-room-api
  VERDICT 3: no profile/nickname route, no rename tool, updateProfile has no caller
[exit=0]
```

> **为什么不是线上进程**：3080 上那个 `dsh web` 承载调用方会话，硬约束禁止重启它；而**不重启就无法在它身上制造改名**。上表用的是**同一个真实现**（真构建产物 + 真数据目录布局）在临时目录上的等価复现，机理与线上逐字一致（`this.identity` 只在 boot 赋值，全仓无 watcher）。线上只做了只读路由探测（§4.1）。

### 4.3 OLD：org 改名绕过全部权限（0.2.11 工作树，源级只读）

```
PS> node -e "…读 src/host/service.js 第 565-575 行…"
 565:   async updateNode(id, patch) {
 566:     const node = this.requireNode(id);
 567:     if (patch.name !== undefined) {
 568:       const name = String(patch.name ?? "").trim();
 569:       if (!name) throw new OrgError("name_required", "名称不能为空");
 570:       // G1 (0.2.11): the same content gate as the room nickname. …
 573:       const problem = nicknameProblem(name);
 574:       if (problem) throw new OrgError("name_invalid", `名称不可用：${problem}`);
 575:       node.name = name;
 576:     }
authorization call in updateNode: false

=== OLD-6 (working tree): the web route passes no caller identity ===
 122:       const updateMatch = /^\/agent-org-api\/nodes\/([^/]+)\/update$/.exec(path);
 123:       if (method === "POST" && updateMatch) {
 124:         const body = await readJson(request);
 125:         const node = await service.updateNode(decodeURIComponent(updateMatch[1]), {
```

⇒ 内容门禁（G1）在 0.2.11 已有，**授权门禁完全不存在**，且路由不传调用者身份。

## 5. 发布门禁第 2 步 — NEW 行为（同一次改名，原始输出）

探针 `<workdir>\_rename-new-evidence.mjs`（**真构建产物**：`AgentRoomService` / `RoomService` / **真 `createRouter`（就是注册到 3080 的那个）**；org 侧用**真 `src/host/permission.js`** 授权判定 + 真 `org-state.json` 写盘）：

```
=== NEW-1: three stores BEFORE the rename ===
  A identity.json      : KEVINKIKI
  B owned-room member  : KEVINKIKI
  C org node 516b10d7-890f-441c-8bef-420b39b5d467: 主控·总控

=== NEW-2: the missing entry point now exists (the OLD capture got 404) ===
  POST /agent-room-api/profilex : 404 {"ok":false,"error":"not-found"}

=== NEW-3: one call through POST /agent-room-api/profile ===
  HTTP status                   : 200
  response data                 : {"agentId":"01a0231b-bbe5-720a-97a4-819744eeae76","previousNickname":"KEVINKIKI","nickname":"主控·总控","changed":true,
                                   "identityFile":"…\\agent-room\\identity.json","profileFanout":0,"ownedRoomMembers":1,"nicknameConflicts":[],
                                   "org":{"attempted":true,"updated":true,"nodeId":"516b10d7-890f-441c-8bef-420b39b5d467","rev":4}}
  identities matched            : yes

=== NEW-4: no restart required — the LIVE process reports the new name ===
  cached identity object is the same reference : true
  live getIdentity().nickname                  : 主控·总控
  identity.json on disk (A)                    : 主控·总控
  owned-room member nickname (B)               : 主控·总控
  org node name (C)                            : 主控·总控
  org save() invocations for this rename       : 1 (rev bumped + snapshot broadcast would happen here)
  DISTINCT VALUES ACROSS A/B/C                 : 1 -> 主控·总控
  end-to-end time for the call                 : 15 ms (not 0..15000 ms of timer wait)
  agentId unchanged (no re-mint)               : true

=== NEW-5: it survives a simulated restart (fresh instance, same directory) ===
  fresh RoomService getIdentity().nickname : 主控·总控
  fresh RoomService getIdentity().agentId  : 01a0231b-bbe5-720a-97a4-819744eeae76
  identity.json bytes/ BOM                 : 152 / false

=== NEW-6: a rejected name changes nothing (400, and no store moves) ===
  POST bad name                            : 400 {"ok":false,"error":"拒绝写入该昵称：nickname contains U+FFFD (replacement character)","reason":"…"}
  A/B before vs after                      : identical
  C untouched                              : 主控·总控

=== NEW-7: the org-side authorization this call goes through (real permission.js) ===
  owner renaming its OWN node      : {"action":"rename_self","role":"owner","level":"L1","allowed":true,"needsApproval":false,"approver":null}
  non-owner renaming someone else  : {"action":"rename_node","role":"member","level":"L2","allowed":false,"needsApproval":true,"approver":"01a0231b-…"} <- REFUSED
  non-owner renaming the company   : {"action":"rename_node","role":"member","level":"L2","allowed":false,"needsApproval":true,"approver":"01a0231b-…"} <- REFUSED
  a caller that passes NO actor    : {"action":"rename_node","role":"observer","level":"L2","allowed":false,"needsApproval":true,"approver":"01a0231b-…"} <- fail closed
[exit=0]
```

**OLD vs NEW 对照**

| 观测 | OLD（0.1.39） | NEW（0.1.40） |
|---|---|---|
| `POST /agent-room-api/profile` | **404**（线上 + 源码级均确认） | **200**（真路由，见 NEW-3） |
| 改名后运行中进程的显示名 | 仍为旧名（磁盘改动不可见） | **立即为新名**，且缓存对象**引用未变**（`same reference: true`） |
| 三处名字的不同取值个数 | 2（A/B vs C 不一致，卡 §2.1 实测） | **1** |
| 生效是否需要重启 | **需要**（OLD-2：只有新实例看到新字节） | **不需要**；且重启后仍是新名（NEW-5） |
| 坏名字 | 入口不存在 | **400 且三处都不动**（NEW-6） |
| org 改名授权 | **无检查** | 非 owner 改他人/公司节点 **REFUSED**；空 actor **fail closed** |

> **线上（3080）NEW 未验证**：该进程仍加载 0.1.39 模块，`/agent-room-api/profile` 在那台机器上**仍然是 404**。让它加载新代码必须重启，硬约束禁止。NEW 证据来自**真代码的进程内装配**（路由、服务、扇出、org 授权模块全部是真实现），**不是**线上进程的现场输出。

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
| `dedupe.test.mjs` | pass 2 / fail 0 | pass 2 / fail 0 |
| `dedupe-ring.test.mjs` | pass 7 / fail 0 | pass 7 / fail 0 |
| `rename-profile.test.mjs`（新增） | — | **pass 16 / fail 0** |

`rename-profile.test.mjs` 的 16 条覆盖：路由 200 + 三处收敛（1）／即时扇出且 15 s 定时器仍在（2）／原地改缓存对象 + 新实例读到新名＝模拟重启（3）／写前已验证备份且可反解旧名（4）／**坏名三处都不动**（含字节级 sha 与 mtime 比对、无备份产生、路由 400）（5）／trim 与 @提及冲突报告（6）／org 缺失如实上报（7）／org 拒绝如实上报（8）／缓存空时拒改且**不铸造不写盘**（9）／G1 复用（10）／工具与路由装配（11）／回填报告只读（12）／`--set-name` 缺 `--apply` 不写（13）／`--apply` 修 A+C 且带备份、重读校验、无 BOM（14）／坏名/未知 agentId 拒绝且不写（15）／报告 JSON 可解析且门禁就是插件自己的模块（16）。

`npx tsc --noEmit` 干净（exit 0）；`node build.mjs` 成功。

## 7. 授权缺口是怎么关掉的

1. **动作分类**（org 0.2.12 `permission.js`）：`rename_self` 进 **L1**（改自己那个 member 节点），`rename_node` 进 **L2**（改任何别的节点，含公司/部门/团队）。此前 `classify()` 对改名返回 `"unknown"` → `allowed:false`，而 `updateNode` **从不调用**它，所以那条兜底是死代码 —— 现在它是活的。
2. **唯一写入点挂检查**：`OrgService.updateNode(id, patch, actorAgentId)` 在写 `node.name` 之前调用 `assertMayRename(node, actor)`；拒绝抛 `OrgError("rename_denied")`（HTTP **400**）并写审计（`denied` / `allowed` 都记）。
3. **调用者身份**：
   - web 路由 `POST /agent-org-api/nodes/:id/update` → `await service.localAgentId()`；
   - 工具 `org_update_node` → 同一方法；
   - 房间入口的跨插件调用 → org 侧 `renameSelfByAgentId(agentId, …)` 以**被改名者自己的 agentId** 作为 actor（改自己 = L1，仍然过检查）。
4. **`localAgentId()` 绝不铸造身份**：优先用房间插件**同步、非铸造**的 `getIdentity()`；访问器存在但缓存为空（boot 未完成）时返回 `""` → **fail closed**；只在访问器缺失时才退回 `gateway.identity()`（它是 `ensureIdentity()` 别名，缓存空时会铸造并写盘）。**授权检查不得创造它正在授权的东西。**
5. **空 actor 一律拒绝**：`canRenameNode(state, "", node)` 恒为 `allowed:false` —— 因此任何**忘记传身份**的调用路径改名失败，而不是静默放行（0.2.11 的签名正是这种忘记）。

**仍然保留的行为**：本机是 org owner 时，一切改名照旧成功（web 路由 / `org_update_node` / 房间入口），返回体新增 `renamedBy` 字段；非 owner 改**自己**的节点仍是 L1 直接通过。

**未覆盖（如实登记）**：同名路由还接受 `agentId` / `leaderAgentId` 字段，本版**只为 `name` 加了授权**（卡只点名改名）。⇒ 一个能打到 3080 的调用方仍可改 `leaderAgentId`（这本身可间接扩权），属于**下一张卡**的范围，本版不扩大改动面。

## 8. 回填路径（把已经坏掉的名字改回来）

```powershell
# 只报告：A 的 nickname + C 的每个节点名，逐个 BAD/ok，并打印**带占位符的**修复命令（不猜名字）
node tools/repair-identity.mjs --home "%USERPROFILE%\.dsh" --repair-names

# 显式落地：agentId 维度、必须写清名字、先打印计划再逐个 备份→写→重读校验
node tools/repair-identity.mjs --home "%USERPROFILE%\.dsh" --repair-names --apply ^
  --set-name 01a0231b-bbe5-720a-97a4-819744eeae76=主控·总控
```

- 名字门禁**动态载入插件自己的 `lib/host/safety.js`**（`nicknameProblem` / `assertValidNickname`）：坏名字在**任何写之前**被拒（实测：`NAME` / `???` / 空白 / `x\uFFFDy` 全部拒绝且文件 sha 不变）。
- `--set-name` 只认报告里出现过的 agentId（除非显式 `--allow-unknown-id`）；报告打印的是 `<THE NAME YOU WANT>` 占位符，**工具从不替你猜名字**。
- 写盘用 `JSON.stringify(value, null, 2)` + UTF-8 无 BOM（正是当初被 `JSON.stringify` 无缩进 + 未展开占位符写坏的反面）。
- **B（房主侧成员昵称）不在本地修**：它由成员机自己推送覆盖，本地改会被下一次推送盖掉 ⇒ 用 §2 的入口改，或让该成员机改。
- 报告里额外打印**警告**：如果插件正在运行，磁盘改动对它是不可见的，会被下一次 save 回滚 —— 运行中请用入口，不要手改。

## 9. 每台机器自己就能跑（今日规则）

```powershell
$ar = 'C:\work\项目\dsh-agent-room'

# 0) 只读：本机是不是有改名路由了（旧构建 404 / 新构建 200）
curl.exe -s -o - -w "`nHTTP=%{http_code}`n" -X POST -H "content-type: application/json" -d "{\"nickname\":\"\"}" http://127.0.0.1:3080/agent-room-api/profile
#   期望（新构建）：HTTP=400 且 ok:false（空名被 G1 拒），**不是 404**

# 1) 只读：三处名字现状
curl.exe -s http://127.0.0.1:3080/agent-room-api/state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s).data;console.log('A/B self:',j.identity?.nickname)})"
curl.exe -s http://127.0.0.1:3080/agent-org-api/state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const n of JSON.parse(s).data.nodes.filter(x=>x.kind==='member'))console.log('C',n.agentId,n.name)})"

# 2) 坏名字回填（先报告）
node $ar\tools\repair-identity.mjs --home "%USERPROFILE%\.dsh" --repair-names

# 3) 回归套件（逐条直跑）
node $ar\test\rename-profile.test.mjs        # pass 16
node $ar\test\bom-identity.test.mjs          # pass 14
```

**改名（本机自己就能做，无需他人到场）**：`agent_rename_self`（或本机 `POST /agent-room-api/profile`）。
**A/B 由本机自己写**；**C 只有 org owner 的 `save()` 会赢**（`dsh-agent-org/src/host/sync.js:66`）——非 owner 的机器改自己的节点名仍是 L1 通过（因为改的是**自己**的节点，org 侧 `rename_node` 的 L2 不参与），但**改别人的节点**会被 0.2.12 拒绝，需由 org owner 执行或走审批。

## 10. 本版**没有**验证 / 主动排除的部分（如实列出）

1. **线上 3080 的 NEW 行为未验证**：需要重启承载调用方会话的 `dsh web`，硬约束禁止（§4.1 只做了只读 404 探测）。NEW 证据是**真代码的进程内装配**。
2. **跨插件真实装填未端到端跑过**：agent-org 没有 `node_modules`，其 `OrgService` 依赖 `@deepseek-ai/cordis`，**本会话无法构造**。因此 `ctx.get("agentOrg")` 非 undefined + `renameSelfByAgentId` 可调用，是用**真 cordis Context（`provide`+`set`）+ 真 org 授权模块 + 真 org-state.json** 验证的（NEW-3/NEW-7），org 服务自身的 cordis 装配由 0.2.12 的源级装配断言覆盖。卡 §5 判据 #10 因此只完成到「路由与上下文语义」这一步。
3. **端到端「改名 → 对方可见」延迟未实测**（卡 §6.4 的待测）：需要第二台机器同时观测。本版能证明的是**本机立刻可见 + 扇出在同一调用内发出**（NEW-3/NEW-4：15 ms，`profileFanout` 计数），跨机延迟仍属待测。
4. **org 快照在其它机器的收敛未实测**：需要多台机器 + 一个同步房间。
5. **非 owner 机器上的真实拒绝未在活体上跑过**（禁止改本机/他机身份与 org 名）：拒绝语义由**真 `permission.js`**（NEW-7）+ org 侧 9 条测试断言。
6. **`leaderAgentId` / `agentId` 字段仍未授权**（见 §7 末）：范围外的既存缺口。
7. **客户端没有改名 UI**（见 §3 末）。
8. **`tools/repair-identity.mjs` 的 `--repair-names` 需要仓库已 `node build.mjs`**（它动态载入插件自己的 `lib/host/safety.js`）；未构建时给出明确报错而不是退化成第二套规则。

## 11. 上线与回滚

**上线**（每台机器自己执行；不改协议、不改写盘格式，可与 org 0.2.12 同批）：

```powershell
# 1) 升级前归档日志（团队铁律）
node <workdir>\archive-log.cjs --file <该机>\studio.log
# 2) 安装 tarball（各机自己的看门狗拉起）
dsh-agent-room-0.1.40.tgz        # 见发布记录里的 md5
# 3) 校验（新构建）
curl.exe -s -X POST -H "content-type: application/json" -d "{\"nickname\":\"\"}" http://127.0.0.1:3080/agent-room-api/profile
#   期望：HTTP 400 ok:false（空名被拒）—— 出现 404 说明仍是旧构建
```

**回滚触发条件**（任一即回滚）：
1. 改名后 `GET /agent-room-api/state` 的 `identity.nickname` 与 `identity.json` 不一致（写盘与内存分叉）；
2. 改名后 `agentId` 变了（说明走了铸造路径 —— 绝不允许）；
3. 正常名字被 G1 误拒（合法名写不进去）；
4. org 树在改名后出现**重复**成员节点或节点丢失；
5. `profileFanout` 长期为 0 但确有已加入房间（扇出被削弱）；
6. 15 s tick 的 profile 推送消失（`members` 事件不再周期出现）。

**备份路径（写前自动落的，绝对路径 + 时间戳）**：`<dirname(DSH_HOME)>\identity-backups\identity.json.<yyyyMMdd-HHmmss>.bak`（本机默认即 `<home>\identity-backups\`，可用 `DSH_IDENTITY_BACKUP_DIR` 覆盖）；回填工具另落 `<...>.pre-name-repair.bak`。

**回滚命令**

```powershell
$repo = 'C:\work\项目\dsh-agent-room'
$bk   = '<发布前备份目录>'      # 见发布记录
Copy-Item "$bk\src\host\service.ts"     "$repo\src\host\service.ts"     -Force
Copy-Item "$bk\src\host\safety.ts"      "$repo\src\host\safety.ts"      -Force
Copy-Item "$bk\src\host\web.ts"         "$repo\src\host\web.ts"         -Force
Copy-Item "$bk\src\tools\gateway.ts"    "$repo\src\tools\gateway.ts"    -Force
Copy-Item "$bk\src\tools\index.ts"      "$repo\src\tools\index.ts"      -Force
Copy-Item "$bk\tools\repair-identity.mjs" "$repo\tools\repair-identity.mjs" -Force
Copy-Item "$bk\package.json"            "$repo\package.json"            -Force
Remove-Item "$repo\test\rename-profile.test.mjs" -Force
node $repo\build.mjs
```

**回滚后校验**：`POST /agent-room-api/profile` 回到 **404**；`node test/rename-profile.test.mjs` 不再存在；其余 11 个套件计数回到 §6 的「改动前」列。

**回滚不了的部分**：① 已经写进 `identity.json` 的新昵称只有靠备份或再改一次恢复（备份是自动落的，见上）；② 已经广播给其它机器的 org 快照撤不回（只能由 org owner 再改一次覆盖）；③ 已经推给房间的 `member.profile` 帧会被房主侧记为最新值（后到者赢，无版本号），回滚不改变它 —— 再改一次名字即可。
