# dsh-agent-org 0.2.11 — 损坏的组织树不再变成空树（P0，与 dsh-agent-room 0.1.38 同批）

发布目标：`card-00-bom-identity-v3.md`。本版与 `dsh-agent-room` 0.1.38 是**同一批改动**：卡 4.2(d) 要求
「三处必须同批落地」——身份一旦被重铸，`sync.js` 的 org owner 判定（`kind:"company"` 的 `leaderAgentId`）
会变成空串，本机就从 **owner 掉成非 owner**，于是「我是 owner，忽略所有非 owner 快照」这条保护**失效**，
成员的快照开始按 `incRev > localRev` 生效。**不要单独升级其中一个。**

---

## 1. 缺陷（一句话）

`OrgPersistence.load()` 把「文件缺失」和「文件存在但解析失败」**都**返回空树
（`{ version: 1, nodes: [], updatedAt: "" }`）。这不是一个无害的默认值：`save()` 会把**读回来的状态**写回去，
于是**一个 BOM**（Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 无条件写）就把「文件损坏」
升级成**不可逆的整树丢失**，并随后广播出去。本机若是 org owner，`sync.js:66` 让所有非 owner 采用它的快照，
**空树会覆盖整个组织且不会自愈**。

同一类错误还有两处：`loadSyncConfig()` 对损坏文件返回 `{}`，使 `config.syncRoomId` 变空，
该机**静默退出跨机同步**、日志里没有任何线索；`org-state.json` 可解析但没有 `nodes` 数组时也被静默当成空树。

## 2. 新的读 / 失败语义

| 磁盘状态 | 0.2.10（旧） | 0.2.11（新） |
|---|---|---|
| 文件**不存在** | 空树 | **不变**：空树（全新安装） |
| 存在、带 BOM 的**合法** JSON | **解析失败 → 空树 → 下次 save 覆盖** | **剥 BOM 后正常解析**，树完整 |
| 存在、**不可解析** | 空树（随后被写回，整树不可逆丢失） | 抛 **`CorruptConfigError`**；**绝不**返回空树、**绝不**覆盖；抛错前落**逐字节隔离副本** + 写 `REFUSED-TO-START` 标记 |
| 存在、可解析但**无 `nodes` 数组** | 空树 | 同上：抛错 + 隔离 + 标记 |
| 内容是字面量 `null` / 裸标量 | 空树 | 抛错（`null` 只表示"文件不存在"） |
| `sync-config.json` 损坏 | `{}`（静默断开同步） | 抛错（大声） |

**「拒绝启动」从"意外"变成"契约"**：0.2.10 的 `void this.boot()` 没有 catch，抛错只是让一个无人接管的
promise reject，而宿主进程级的 `installFailLoud` **碰巧**兜住了它（实测 `exit=1`）。这是**宿主的行为**，
不是本插件声明的行为：宿主一旦升级、或该 rejection 被 `observeLoaderRejectionCheckpoint` 豁免，
失败模式会悄悄退回「带着空树继续跑」。0.2.11 写成显式 `failLoud`（error 级日志 + **原样 rethrow 同一个错误对象**），
使 `dsh: fatal load failure:` 里的 `CorruptConfigError` 与绝对路径成为**被声明的**输出。

## 3. 改动清单（每个文件一行理由）

| 文件 | 改动 |
|---|---|
| `src/host/safety.js` | **新增**。剥 BOM、区分缺失/损坏（`CorruptConfigError`）、隔离副本、写前备份（含大小校验 + 保留上限）、`REFUSED-TO-START` 标记、平台推导备份根、G1 内容校验、`failLoud` |
| `src/host/persistence.js` | `load()` 拆成三条路径（缺失→空树 / 带 BOM 合法→真树 / 损坏→抛错+隔离）；`save()` 增加「拒绝覆盖损坏文件」+「写前备份」；`loadSyncConfig()` 损坏即抛；删掉那句与实现不符的 `// the service seeds a default company` 注释 |
| `src/host/service.js` | `void this.boot()` 改为 `failLoud` 显式契约；`boot()` 开头 `ensureBackupRoot()`；`boot()` 结尾清除标记；`updateNode` 的写路径挂 G1（名称 + 成员 agentId 必须是 UUID） |
| `test/bom-org-state.test.mjs` | **新增**，11 条：BOM 容错、损坏即抛、缺失仍是空树、写边界拒覆盖、备份、标记、G1、跨平台备份根 |
| `docs/RELEASE-0.2.11.md` | 本文件 |
| `package.json` | 版本 0.2.10 → 0.2.11 |

## 4. 发布门禁：先复现旧行为，再证明新行为

**旧行为（0.2.10 的语义，钉在测试里作为对照）**：`load()` 对同一份内容，无 BOM 返回真树、带 BOM 返回空树，
且紧接着的 `save()` 会把空树写回并覆盖原文件。新行为把「带 BOM」这一格变成「真树」、把「损坏」这一格变成「抛错」。

```
命令（在 dsh-agent-org 目录）：node test/bom-org-state.test.mjs

✔ NEW: a BOM'd org-state.json is read as the real tree, not an empty one (9.2083ms)
✔ NEW: a damaged org-state.json throws instead of yielding an empty tree (15.534ms)
✔ NEW: a missing org-state.json is still an empty tree (a fresh install, unchanged) (1.332ms)
✔ NEW: parseable-but-wrong-shaped state is damage too, never a silent empty tree (35.6534ms)
✔ NEW: save() refuses to overwrite a damaged tree, and backs up before a good write (18.1649ms)
✔ NEW: sync-config.json tolerates a BOM, and is loud when damaged (8.5928ms)
✔ NEW: the boot chain rejects on damage, and its handler re-throws for the host fatal path (10.0789ms)
✔ NEW: the service wrapper declares the failure contract (wiring) (1.285ms)
✔ NEW: a boot that reaches the end clears the watchdog marker (4.4618ms)
✔ NEW: G1 guards on the org write path (0.9642ms)
✔ NEW: the org backup root is derived per platform, never a hardcoded drive letter (0.7121ms)
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

关键断言（都是可跑的，用的临时目录 `D:\dsh\_bom-tests\`）：

- 带 BOM 的 `org-state.json`：`nodes.length === 2`、`leaderAgentId` 仍可读、**sha256 与 mtime 不变**（读操作不写盘）；
- 损坏的 `org-state.json`：`load()` reject 且 `error.name === 'CorruptConfigError'`、`error.file` 指向该文件；
  原文件 **sha256 与 mtime 不变**；备份根出现 `org-state.json.<stamp>.corrupt.bak` 且**逐字节相同**；
  `<dataDir>\REFUSED-TO-START` 出现且内容含损坏文件绝对路径；
- `save()` 面对损坏文件**拒绝写入**（原文件仍逐字节相同）；健康写入前先生成 `org-state.json.<stamp>.bak`；
- 缺失文件仍是空树、不创建文件、不写标记；
- `boot()` 链路（`ensureBackupRoot` → `load` → `loadSyncConfig` → `clearRefusedMarker`）在损坏时 reject；
  在健康时走到最后并**清除标记**。

**与 room 侧同批的端到端致命通道**（宿主真实 `installFailLoud`，见 `dsh-agent-room/docs/RELEASE-0.1.38.md` 第 4 节）：
`dsh: fatal load failure: CorruptConfigError: … at <绝对路径>` + `exit=1`，损坏文件逐字节不变 + 隔离副本存在。

## 5. 测试计数（改动前后，`node test/<name>.mjs`）

| 套件 | 改动前 | 改动后 |
|---|---|---|
| `permission.test.mjs` | pass 5 / fail 0 | pass 5 / fail 0 |
| `sync.test.mjs` | pass 4 / fail 0 | pass 4 / fail 0 |
| `visibility.test.mjs` | pass 8 / fail 0 | pass 8 / fail 0 |
| `exec-cache.test.mjs` | pass 12 / fail 0 | pass 12 / fail 0 |
| `bom-org-state.test.mjs`（新增） | — | **pass 11 / fail 0** |

`node build.mjs` 成功；`tsc --noEmit` 在本仓无 TS 源，未跑（本仓宿主是纯 `.js`，`src` 与 `lib` 行号相同）。

## 6. 上线与回滚

**上线**（每台机器自己执行）：与 `dsh-agent-room` 0.1.38 **同批**；升级前先归档日志
（`node D:\dsh\archive-log.cjs --file <该机>\studio.log`）；升级后跑
`powershell -NoProfile -ExecutionPolicy Bypass -File D:\dsh\utf8-probe-c00\detect-identity-drift.ps1`
确认 `org kind=company count = 1`、`org kind=member count` 未下降。

**回滚触发条件**：① 报出与真实损坏无关的 `CorruptConfigError` 导致正常机器起不来；② 组织树节点数下降；
③ 看门狗崩溃循环未命中停止条件；④ 备份根不可解析/不可写导致写入被全面阻断。

```powershell
# 组织树回滚（先备份当前状态）
$now = Get-Date -Format "yyyyMMdd-HHmmss"
$bk = if ($env:DSH_IDENTITY_BACKUP_DIR) { $env:DSH_IDENTITY_BACKUP_DIR } else { Join-Path (Split-Path $env:USERPROFILE\.dsh -Parent) "identity-backups" }
Copy-Item "$env:USERPROFILE\.dsh\agent-org\org-state.json" "$bk\prerollback-orgstate.$now.bak"
Copy-Item "$bk\org-state.json.<TIMESTAMP>.bak" "$env:USERPROFILE\.dsh\agent-org\org-state.json" -Force
# 清除停止标记，否则看门狗不会重启宿主
Remove-Item "$env:USERPROFILE\.dsh\agent-org\REFUSED-TO-START" -Force -ErrorAction SilentlyContinue
git -C <repo> revert <commit>
```

**回滚必须在 org owner 机上做，或先让 owner 停机**：`sync.js:66` 让「来自 owner 的快照」被非 owner 采用；
非 owner 上的手改会被 owner 的下一次快照**整棵覆盖**（卡 E10 已在四台机器上现场实测）。
注意 owner 的 `rev` 可能**低于**成员（实测 1 vs 4）——**不要用 `rev` 判断谁的树更新**，用 `sha256(JSON.stringify(nodes))`。

**回滚不了的部分**：已被覆盖的整树（只能用备份或他机副本恢复）；已广播出去的快照；`audit.jsonl` 的 append-only 历史。

## 7. 本版**没有**验证 / 主动排除的部分（如实列出）

1. **没有构造完整的 `OrgService` 跑测试**：本仓 `node_modules` 里没有 `@deepseek-ai/cordis`（既有套件也不导入它），
   在测试里加这个 import 会让**其他机器上的 `npm test` 直接报 `ERR_MODULE_NOT_FOUND`**。因此：
   - `boot()` 的失败链路用**同样顺序的真实模块调用**（`ensureBackupRoot` → `load` → `loadSyncConfig` → `clearRefusedMarker`）复现，
     这是宿主看到的同一个失败面；
   - **服务包装层用结构化断言**（源码里 `failLoud("[agent-org]"`、`ensureBackupRoot()`、`clearRefusedMarker`、
     `updateNode` 调用 G1 两个判定函数）覆盖，并在测试里写明了为什么这样做。
2. **真实 `dsh web` 端到端未跑**：本会话硬约束禁止启停任何服务（3080 上的 `dsh web` 承载调用方会话）。
3. **未在小黄（macOS）机器上真跑**：跨平台备份根只用纯函数 `assertPlatformResolvableFor(path,'darwin')` 验证。
4. **不做自动补种**：卡 4.3 要求「注释与实现二选一」。我在 `boot()` 里**不**自动 seed，而把重播种交给
   `dsh-agent-room/tools/repair-identity.mjs --reseed-org --apply`（显式、可审计）。理由：自动 seed 会让每台
   新机各造一个 company 节点并广播，而 owner 判定正是 `kind:"company"` 的 `leaderAgentId`，那会制造新的 owner 争夺。
5. **未做存量清洗**：不修已写入的历史行，不改任何现存节点。
6. **`node --check` 通过、`build.mjs` 通过，但没有 TypeScript 类型检查**（本仓无 TS 源）。
