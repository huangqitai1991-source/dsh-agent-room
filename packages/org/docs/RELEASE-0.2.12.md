# dsh-agent-org 0.2.12 — 改名授权（补上 0.2.11 缺失的那道门）

发布目标：`card-01-nickname-v4.md` §2.6 / §4.3（授权缺口）+ 房间侧 0.1.40 的 org 一半。
配套版本：**dsh-agent-room 0.1.40**（它的改名入口会调用本版的 `renameSelfByAgentId`）。
本版**不动** `sync.js` 的收敛规则、**不动** `exec` 授权面、**不动** 0.2.11 的配置安全（BOM 读、损坏拒启、写前已验证备份、G1 内容门禁）。

---

## 1. 缺陷（一句话）

`OrgService.updateNode()`（`src/host/service.js:565`）写 `node.name` 时**不调用任何权限检查**，
路由 `POST /agent-org-api/nodes/:id/update`（`src/host/web.js:122`）也**不传调用者身份**：

⇒ **任何能打到本机 3080 的调用方，都能改组织树里任意节点的名字。**

权限机制本身**存在且被别处使用**（`permission.js:86 checkPermission`、`service.js:388 check`、`service.js:398 requestApproval`），
但 `classify()`（`permission.js:33`）的动作清单里**没有 rename 类动作**，对改名一律返回 `"unknown"` → `checkPermission` 返回 `allowed:false`。
这条兜底**从未生效**，因为 `updateNode` 从不调用它 —— 是**死代码**。

内容门禁（G1：拒 U+FFFD / 连续 `?` / `NAME` / 空白）在 0.2.11 已经补上（`service.js:573`），本版**只**补授权，一行内容规则都不动。

## 2. 新契约（OLD vs NEW）

| 调用 | 0.2.11（旧） | 0.2.12（新） |
|---|---|---|
| `updateNode(id, {name})`（无 actor） | **改成功**（无检查） | **拒绝**（`actorAgentId` 默认 `""` → observer → `rename_denied`，HTTP 400） |
| 改**自己**的 member 节点 | 改成功 | 改成功（`rename_self`，**L1**，不需审批） |
| org owner 改**任意**节点 | 改成功 | 改成功（`rename_node`，**L2**，owner 免审批） |
| org 成员 / 部门主管改**别人**的节点或组织单元 | 改成功 | **拒绝**：L2 需审批（审批人 = 其上级）；`needsApproval:true`、`allowed:false` |
| 非成员（observer）改任何节点 | 改成功 | **拒绝**（observer 连 L1 都没有） |
| 拒绝是否留痕 | — | **是**：`audit.jsonl` 记 `{action, target, result:"denied"}`；放行记 `"allowed"` |
| `renameSelfByAgentId(agentId, nickname)` | 不存在 | **新增**：按 agentId 找自己的 member 节点改名，走 `updateNode` ⇒ 授权 + `save()`（rev+1 + 广播快照） |
| `localAgentId()` | 不存在 | **新增**：本机 agentId，**绝不铸造**（缓存冷 → 返回 `""` → 拒绝） |

**HTTP 语义**：`rename_denied` 带 `code`，`web.js` 的既有 catch 因此返回 **400**（不是 500）。

## 3. 改动清单（每个文件一行理由）

| 文件 | 改动 |
|---|---|
| `src/host/permission.js` | `rename_self` 进 L1、`rename_node` 进 L2；新增 `renameActionFor(actor, node)`（自己的 member 节点才算「自己」；**自己领导的部门/团队不算**）与 `canRenameNode(state, actor, node)`（唯一的授权判定，纯函数，可脱离 cordis 测试） |
| `src/host/service.js` | ① `updateNode(id, patch, actorAgentId = "")`：写名字**之前**调 `assertMayRename`；② 新增 `assertMayRename()`（拒绝抛 `OrgError("rename_denied")` + 审计）；③ 新增 `renameSelfByAgentId()`（按 agentId → 自己的节点，**复用 `updateNode`**，因此仍然 `save()` 广播）；④ 新增 `localAgentId()`（优先房间插件同步非铸造的 `getIdentity()`） |
| `src/host/web.js` | `POST /agent-org-api/nodes/:id/update` 传 `await service.localAgentId()` 作为调用者，返回体加 `renamedBy`（可观测） |
| `src/tools/index.js` | `org_update_node` 同样传本机身份；描述写明授权规则 |
| `test/rename-permission.test.mjs` | **新增 9 条**：动作分类、own/other 判定、member 改自己（L1）、owner 改任意、**非 owner 改他人被拒**、空 actor/observer 被拒、旧行为对照、`updateNode` 装配（**先检查后写**）、两条调用路径都传身份且 `localAgentId` 不铸造 |
| `package.json` | 版本 0.2.11 → 0.2.12 |
| `docs/RELEASE-0.2.12.md` | 本文件 |

**为什么 `canRenameNode` 是独立纯函数**：agent-org **没有 `node_modules`**，其 `OrgService` 依赖 `@deepseek-ai/cordis`，测试**无法构造服务**（`test/bom-org-state.test.mjs` 开头已登记这一点）。
把判定抽成纯函数后，**真规则**可以用真实树输入直接跑（8 条测试），服务的装配用**源级断言**覆盖（与 0.2.11 的既有做法一致），而不是把规则再抄一份到测试里。

## 4. 发布门禁 — OLD 复现（**改动前**，源级只读）与 NEW 证据

### 4.1 OLD：`updateNode` 里没有任何授权调用

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
```

（同一份输出见 `docs/RELEASE-0.1.40.md` §4.3；**为什么不 POST 一版活的 OLD 证据**：那会真的改掉组织树节点名并广播快照，硬约束禁止改本机/他机的真实状态。）

### 4.2 NEW：真 `permission.js` 的判定（原始输出，取自 `_rename-new-evidence.mjs` NEW-7）

```
=== NEW-7: the org-side authorization this call goes through (real permission.js) ===
  owner renaming its OWN node      : {"action":"rename_self","role":"owner","level":"L1","allowed":true,"needsApproval":false,"approver":null}
  non-owner renaming someone else  : {"action":"rename_node","role":"member","level":"L2","allowed":false,"needsApproval":true,"approver":"01a0231b-…"} <- REFUSED (0.2.11 allowed it: no check at all)
  non-owner renaming the company   : {"action":"rename_node","role":"member","level":"L2","allowed":false,"needsApproval":true,"approver":"01a0231b-…"} <- REFUSED
  a caller that passes NO actor    : {"action":"rename_node","role":"observer","level":"L2","allowed":false,"needsApproval":true,"approver":"01a0231b-…"} <- fail closed
```

### 4.3 NEW：装配断言（`test/rename-permission.test.mjs` 的两条装配用例）

```
✔ NEW: updateNode reaches the gate, and only the name write is gated (wiring) (3.1135ms)
✔ NEW: every rename call path supplies an actor, and identity is never minted for it (1.2738ms)
```

断言内容：`updateNode(id, patch, actorAgentId = "")` 的**签名**、`this.assertMayRename(node, actorAgentId)` 出现在
`node.name = name` **之前**、G1 的两条旧断言仍在（`nicknameProblem(name)` / `isUuidShaped(agentId)` 未被授权改动挤掉）、
拒绝用 `OrgError("rename_denied")`、`renameSelfByAgentId` 委派给 `updateNode`（**没有**直接 `persistence.save`，否则不会广播）、
web 路由与工具都传 `await …localAgentId()`、`localAgentId` 里 `getIdentity` 出现在 `gateway.identity` **之前**（顺序即「不铸造」的证明）。

## 5. 测试计数（`node test/<name>.mjs` 逐个直跑，从不用 `node --test`）

| 套件 | 改动前 | 改动后 |
|---|---|---|
| `permission.test.mjs` | pass 5 / fail 0 | pass 5 / fail 0 |
| `sync.test.mjs` | pass 4 / fail 0 | pass 4 / fail 0 |
| `visibility.test.mjs` | pass 8 / fail 0 | pass 8 / fail 0 |
| `exec-cache.test.mjs` | pass 12 / fail 0 | pass 12 / fail 0 |
| `bom-org-state.test.mjs` | pass 11 / fail 0 | pass 11 / fail 0 |
| `rename-permission.test.mjs`（新增） | — | **pass 9 / fail 0** |

`node build.mjs` 成功（`built lib/host/*, lib/tools/*, lib/client.js`）；`npx tsc --noEmit` 干净。
> 注：本仓运行时**从 `src/` 加载**（`package.json` 的 `main` 是 `./src/host/index.js`），`lib/` 只是给偏好编译产物的打包器用的副本；测试也一律 import `../src/host/*`。

## 6. 每台机器自己就能跑

```powershell
$ao = 'D:\dsh\ITPM\数创港项目\dsh-agent-org'

# 只读：本机的角色与组织树（判断自己是不是 org owner）
curl.exe -s http://127.0.0.1:3080/agent-org-api/me
curl.exe -s http://127.0.0.1:3080/agent-org-api/state

# 回归套件（逐条直跑）
node $ao\test\rename-permission.test.mjs    # pass 9
node $ao\test\permission.test.mjs           # pass 5
node $ao\test\bom-org-state.test.mjs        # pass 11
```

**授权后的合法改名路径**：
1. **本机改自己的节点名**：走房间侧入口（`agent_rename_self` / `POST /agent-room-api/profile`）→ `ctx.get("agentOrg")` → `renameSelfByAgentId`（actor = 自己 → L1 通过）。
2. **org owner 改任意节点**：`org_update_node` 工具，或 `POST /agent-org-api/nodes/<nodeId>/update {"name":"…"}`（actor = 本机身份 = owner → L2 免审批通过）。
3. **非 owner 改别人的节点**：**会被拒**（400 `rename_denied`），需要 org owner 执行或走审批单（`POST /agent-org-api/approvals`）。

## 7. 本版**没有**验证 / 主动排除的部分（如实列出）

1. **真实 HTTP 拒绝未在活体上跑过**：会真的改组织树并广播快照，硬约束禁止。拒绝语义由**真 `permission.js`**（§4.2）+ 9 条测试断言 + 源级装配断言共同证明。
2. **`OrgService` 的 cordis 装配未在测试里实例化**（本仓无 `node_modules`）：`updateNode` / `renameSelfByAgentId` / `localAgentId` 的实际调用只能由**房间侧 0.1.40 的进程内探针**（用真模块 + 真 Context 桩）与源级断言覆盖，**不是**真服务的端到端。
3. **`leaderAgentId` / `agentId` 仍未授权**：本版**只为 `name` 加检查**（卡只点名改名）。因此能打到 3080 的调用方仍可改 `leaderAgentId`（可间接扩权）—— 登记为下一张卡的范围；本版不扩大改动面。
4. **`applyStudioPreset` 直接调 `setLeader`**（不经过 `updateNode`）：保持原行为，不在本版范围。
5. **多机快照收敛未实测**：需要两台机器 + 一个同步房间；本版不动 `sync.js`。

## 8. 上线与回滚

**上线**（每台机器自己执行；本版不改协议、不改写盘格式）：

```powershell
# 1) 归档日志
node D:\dsh\archive-log.cjs --file <该机>\studio.log
# 2) 安装 tarball（各机自己的看门狗拉起）
dsh-agent-org-0.2.12.tgz        # md5 见发布记录
# 3) 只读校验
curl.exe -s http://127.0.0.1:3080/agent-org-api/me
```

**回滚触发条件**（任一即回滚）：
1. 合法改名被误拒（本机是 org owner 却收到 `rename_denied`）；
2. 改名后 `rev` 不增（`save()` 未跑 ⇒ 其它机器收不到快照）；
3. `audit.jsonl` 出现 `result:"denied"` 暴涨（说明有调用路径拿不到身份，`localAgentId()` 返回了空）；
4. 组织树节点丢失或出现重复成员（改名被写歪）。

**备份路径**：`<dirname(DSH_HOME)>\identity-backups\org-state.json.<yyyyMMdd-HHmmss>.bak`（默认本机 `C:\Users\scorp\identity-backups\`；`DSH_IDENTITY_BACKUP_DIR` 可覆盖）。

**回滚命令**

```powershell
$org = 'D:\dsh\ITPM\数创港项目\dsh-agent-org'
$bk  = '<发布前备份目录>'      # 见发布记录
Copy-Item "$bk\permission.js"  "$org\src\host\permission.js"  -Force
Copy-Item "$bk\service.js"     "$org\src\host\service.js"     -Force
Copy-Item "$bk\web.js"         "$org\src\host\web.js"         -Force
Copy-Item "$bk\tools-index.js" "$org\src\tools\index.js"      -Force
Copy-Item "$bk\package.json"   "$org\package.json"            -Force
Remove-Item "$org\test\rename-permission.test.mjs" -Force
node $org\build.mjs
```

**回滚后校验**：`node $org\test\permission.test.mjs` pass 5；改名恢复为「无检查」（用 §4.1 的源级 grep 复核 `authorization call in updateNode: false`）。

**回滚不了的部分**：① 已经广播出去的快照撤不回（`sync.js` 整棵替换、rev 只增）——只能由 org owner 再改一次覆盖；② `audit.jsonl` 是 append-only，已写入的 `allowed`/`denied` 记录不会消失（这是取证价值，不是缺陷）。
