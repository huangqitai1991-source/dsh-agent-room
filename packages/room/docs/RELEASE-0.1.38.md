# dsh-agent-room 0.1.38 — BOM 引发的静默身份重铸（P0 数据安全）

发布目标：`card-00-bom-identity-v3.md`（v3 比 v2 更严，本版按 v3 落地）+ `card-template.md` 的发布门禁。
发布说明：本版**只做**这一件事；卡里明确划出范围的授权缺口（agent-org `updateNode` 绕过 `checkPermission`）**不在本版**。

---

## 1. 缺陷（一句话）

Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` **无条件写 BOM**（83 → 88 字节，首字节 `7B` → `EF BB BF`）；
读取端 `readJson` 的 `catch { return null }` 把「文件不存在」与「文件存在但解析失败」**合成同一个 `null`**；
`ensureIdentity()` 于是把 BOM 当成「本机还没有身份」，铸造新 uuidv7 并**覆盖写盘**。
agentId 是房间房主身份、成员资格、任务权限、组织树归属、审计归属的键，且身份**不经网络收敛**——所以这一步不可逆。

## 2. 新的读 / 铸造 / 失败语义（本版的契约）

| 磁盘状态 | 0.1.37（旧） | 0.1.38（新） |
|---|---|---|
| 文件**不存在** | 返回 `null` → 铸造新身份 | **不变**：返回 `null` → 首次运行仍可铸造 |
| 文件存在、带 BOM 的**合法** JSON | **解析失败 → `null` → 铸造 + 覆盖** | **剥掉 BOM 后正常解析**，身份与文件都不变 |
| 文件存在、**不可解析**（截断/乱码） | 同上：静默铸造 + 覆盖，**证据自毁** | 抛 **`CorruptConfigError`**；**绝不**铸造、**绝不**覆盖；抛错前先落一份**逐字节隔离副本**；并写 `REFUSED-TO-START` 标记 |
| 文件存在、可解析但**没有可用的 `agentId`** | 被当作合法身份返回（`ownerAgentId !== undefined` 恒真 → 静默不服务任何房间） | 同"不可解析"处理：抛错 + 隔离 + 标记 |
| 文件内容是字面量 `null` / 裸标量 | 被当成"缺失" | 抛错（`null` 只允许表示"文件不存在"这一种意思） |

**「不写盘」与「进程真的停」是两件独立的事，本版都做：**
1. **不写盘**：`saveIdentity()` 自己再加一道闸——目标文件存在且不可解析时**拒绝写入**。即使未来某个调用方把读错误吞掉，铸造路径仍然结构上不可达。
2. **进程真的停**：`boot()` 的拒绝不再终止于 logger。0.1.37 的 `.catch(logger.warn)` 让进程活着而**整个房间宿主已死**（`boot()` 在 `ensurePeerServer()`/LAN/`profileTimer` 之前就抛了），3080 界面健康、房间端口不监听 —— 比停机更难诊断。现在保留 `error` 级日志后**原样 rethrow 同一个错误对象**，交给宿主 `installFailLoud`（`dsh: fatal load failure: <stack>` + `exit(1)`，且它会先 `fiber.dispose()` 收拾半成品，优于 `process.exit`）。
3. **第二条铸造入口一起堵**：`gateway.identity()`（`src/host/service.ts`）不是只读 getter，它调用 `ensureIdentity()`，而 agent-org 每次下发快照都会走它。因为 (1)(2) 落在读/写边界上，这条路径现在同样「损坏则抛，不铸造」。

## 3. 改动清单（每个文件一行理由）

| 文件 | 改动 |
|---|---|
| `src/host/safety.ts` | **新增**。剥 BOM、区分缺失/损坏（`CorruptConfigError`）、隔离副本、写前备份（含大小校验与保留上限）、`REFUSED-TO-START` 标记、平台推导备份根、G1 内容校验、`failLoud` |
| `src/host/persistence.ts` | `readJson` 改为委托 `readJsonConfig`（BOM + 缺失/损坏分离）；`loadIdentity` 增加 agentId 形状校验；`saveIdentity` 增加「拒绝覆盖损坏文件」+「写前备份」两道闸；消息日志首个 BOM 行不再静默丢失 |
| `src/host/room-service.ts` | `ensureIdentity` 铸造分支补上契约注释（唯一可达条件=文件不存在）；`updateProfile` 挂 G1 昵称校验（挂在"故意设置"处，避免存量坏昵称把启动变成故障） |
| `src/host/service.ts` | boot 的 catch 改为 `failLoud`（error 日志 + rethrow）；`loadReplyAgentId`/`loadRelayConfig` 走 BOM 容错 + 损坏即抛；boot 开头校验备份根；boot 结尾清除标记；能力自动合并容忍"拒写"（不因目录权限把节点拖下线） |
| `tools/repair-identity.mjs` | **新增**，自助修复 CLI（只读报告 → 显式 `--apply --agent-id` → 先隔离原字节 → 再写回；含空组织树重播种）。已加入 `package.json` 的 `files` |
| `test/bom-identity.test.mjs` | **新增**，14 条：先复现旧行为，再验证新语义 |
| `test/_probe-fatal-real.mjs` | **新增**（不是 `*.test.mjs`，不进套件）：用**宿主真实 `installFailLoud` + 真实构建产物**跑端到端致命通道 |
| `docs/RELEASE-0.1.38.md` | 本文件 |
| `package.json` | 版本 0.1.37 → 0.1.38；`files` 加 `tools` |

## 4. 发布门禁：先复现旧行为，再证明新行为

**门禁第 1 步 — OLD 行为复现（真实 0.1.37 构建产物，修复前跑，原始输出）**

```
命令：node <workdir>\_probe-identity-real.mjs     （import 真实 lib/host/room-service.js，dataDir 指向 <workdir>\_identity-probe）
=== clean ===
  identity.json first3 bytes : 7b 0a 20
  bytes / sha256 / mtime     : 147 / 1a13966b7f17b38a / 1789367688497.0889
  ensureIdentity()           : returned agentId=01a0231b-bbe5-720a-97a4-819744eeae76
  identity.json after        : bytes=147 sha256=1a13966b7f17b38a mtime=1789367688497.0889
  agentId changed            : false
  original file destroyed    : false
=== bom ===
  identity.json first3 bytes : ef bb bf
  bytes / sha256 / mtime     : 150 / 0e85b9c29eb40a24 / 1789367688506.0847
  ensureIdentity()           : returned agentId=01a09ea0-1d3c-791e-bbc8-485bd0b197b0
  identity.json after        : bytes=147 sha256=6dad99a5d7c8f8fb mtime=1789367688510.4404
  agentId changed            : true
  original file destroyed    : true
=== VERDICT (today's behaviour) ===
  clean identity.json : minted=false  destroyed=false
  BOM'd identity.json : minted=true  destroyed=true
  OLD BEHAVIOUR REPRODUCED: a present-but-unparseable identity.json silently mints a new agentId
```

**门禁第 2 步 — NEW 行为（同一条真实代码路径，修复并重建后跑，原始输出）**

```
命令：node <workdir>\_probe-identity-real.mjs
=== clean ===
  identity.json first3 bytes : 7b 0a 20
  bytes / sha256 / mtime     : 147 / 1a13966b7f17b38a / 1789367892852.2932
  ensureIdentity()           : returned agentId=01a0231b-bbe5-720a-97a4-819744eeae76
  identity.json after        : bytes=147 sha256=1a13966b7f17b38a mtime=1789367892852.2932
  agentId changed            : false
  original file destroyed    : false
=== bom ===
  identity.json first3 bytes : ef bb bf
  bytes / sha256 / mtime     : 150 / 0e85b9c29eb40a24 / 1789367892862.059
  ensureIdentity()           : returned agentId=01a0231b-bbe5-720a-97a4-819744eeae76
  identity.json after        : bytes=150 sha256=0e85b9c29eb40a24 mtime=1789367892862.059
  agentId changed            : false
  original file destroyed    : false
=== VERDICT (today's behaviour) ===
  clean identity.json : minted=false  destroyed=false
  BOM'd identity.json : minted=false  destroyed=false
```

**带 BOM → 身份保持 `01a0231b-…`，文件 150 字节 / sha256 / mtime 全部不动。**

**门禁第 3 步 — 损坏（不可修复）→ 大声失败且不写盘（可跑的判据）**

```
命令：node test/bom-identity.test.mjs
✔ OLD (0.1.37, pinned replica): a BOM'd identity.json mints a new agentId and destroys the original (12.8323ms)
✔ NEW: a BOM is tolerated — same agentId, and the file is byte-identical (6.7212ms)
✔ NEW: an unparseable identity.json throws, mints nothing, and keeps the original byte-identical (12.4897ms)
✔ NEW: the write boundary also refuses to overwrite a damaged identity.json (9.7638ms)
✔ NEW: a missing identity.json still mints (first-run semantics unchanged) (4.2042ms)
✔ NEW: every config reader tolerates a BOM (13.5896ms)
✔ NEW: every config reader is loud about damage instead of returning empty (29.5163ms)
✔ NEW: the second minting entry point cannot mint over a damaged file either (20.0031ms)
✔ NEW: an identity write takes a verified timestamped backup first, and retention is bounded (98.5036ms)
✔ NEW: the backup root is derived per platform, never a hardcoded drive letter (3.1232ms)
✔ NEW: the boot rejection is loud, and it is the same error the host fatal path receives (7.6775ms)
✔ NEW: a boot that reaches the end clears the watchdog marker (95.787ms)
✔ NEW: G1 content guards reject the damage classes the card names (13.3405ms)
✔ NEW: stripBom only removes a leading BOM (0.0927ms)
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

**门禁第 4 步 — 端到端致命通道（宿主真实 `installFailLoud` + 真实构建产物）**

```
命令：node test/_probe-fatal-real.mjs corrupt   → EXIT=1
stdout:
  === MODE corrupt ===
    damaged file : <workdir>\_fatal-probe\agent-room\identity.json
    bytes/sha    : 73 / 8bc58011b2cc92d0
stderr:
  dsh: fatal load failure: CorruptConfigError: identity.json is present but not parseable
    (Unterminated string in JSON at position 73 (line 3 column 19)) at <workdir>\_fatal-probe\agent-room\identity.json
      at raiseCorrupt (.../lib/host/safety.js:343:11)
      at async Persistence.loadIdentity (.../lib/host/persistence.js:135:21)
      at async RoomService.ensureIdentity (.../lib/host/room-service.js:66:26)
      at async AgentRoomService.boot (.../lib/host/service.js:811:9)
  [probe] host release hook ran (fiber.dispose would run here)
事后校验：
  identity.json bytes=73 sha256=8bc58011b2cc92d0 mtime=1789368405667.6028   ← 与抛错前逐字节相同
  marker present=true
  backups: identity.json.20260914-144645.corrupt.bak

对照组（干净配置，证明致命通道只由损坏触发）：
命令：node test/_probe-fatal-real.mjs clean    → EXIT=0
  RESULT: process STILL RUNNING after the attempted boot
  file unchanged : true
  （stderr 无 fatal load failure 行）
```

## 5. G4：拒绝启动不得变成崩溃循环

看门狗无条件重启（`while true; do dsh web; sleep 5; done`）会把一次可诊断的停机变成风暴；实测（卡 E12）在**无控制台**时 `timeout /t 5` 立即失败，因此实际速率约 **19 次/秒**，足以淹没唯一有用的那行日志。
本版实现的契约是**停止**而不是**限速**：

- 插件在抛错前写 `<dataDir>\REFUSED-TO-START`（内容：时间戳 + 损坏文件绝对路径 + 原因），**只在配置损坏这一种原因下写**；
- 标记的清除者**只能是插件自己**，且只在 `boot()` 跑到最后一行时清除（看门狗伪造不了这个声明）——所以修好配置的机器**自己**就会恢复；
- 看门狗只**读**标记：命中即打印 `STOPPED: refusing to restart - fix the corrupt config (see card-00 4.7)` 并 `exit 78`；
- 旁路：`<DSH_HOME>\REFUSED-TO-START.override` 或 `DSH_FORCE_START=1` 时忽略标记并重启一次（消费后自动删除）。

落点（**三个**产物都改了，缺一个都不成立）：

| 产物 | 状态 |
|---|---|
| `<workdir>\upgrade-studio.sh`（生成器，macOS/Linux 看门狗） | 已改 |
| `<workdir>\upgrade-studio.ps1`（生成器，Windows 看门狗模板） | 已改 |
| `<workdir>\studio\start-studio.cmd` / `.sh`（本版新增的**可直接部署**产物） | 已改，由各机自行安装（见第 7 节） |
| `C:\studio\start-studio.cmd`（本机**正在运行**的那一份，比模板旧） | **本会话无法写入**，见第 8 节 |

**G4 判据输出（用真实看门狗文件、把 `dsh web` 换成立即退出的桩；未启动任何服务）**

```
CASE A 无标记（对照组，期望继续重启）：
  [stub] pretending to be "dsh web" and exiting 1
  [studio] dsh web exited, restarting in 5s...
  ... CAP-REACHED-3-ITERATIONS   EXIT=0

CASE B 有标记（期望停止，且只尝试一次）：
  [stub] pretending to be "dsh web" and exiting 1
  [studio] corrupt config reported by the plugin:
  2026-09-14T10:00:00.000Z
  corrupt config: Unexpected token
  STOPPED: refusing to restart - fix the corrupt config (see card-00 4.7)
  [studio] repair: run tools\repair-identity.mjs from the dsh-agent-room repo
  EXIT=78                        ← 停住，不再重启

CASE C 有旁路（期望重启一次并消费掉旁路）：
  [studio] bypass present (REFUSED-TO-START.override / DSH_FORCE_START=1): restarting once
  ... CAP-REACHED-3-ITERATIONS   EXIT=0
  override consumed: True
```

> 这次实测顺带抓到一个真 bug：`echo ... <repo>\tools\...` 里的 `<` 在 cmd 里是**重定向**，会打印
> `The system cannot find the file specified`。三个看门狗产物的提示行已改为不含尖括号。

## 6. 备份与隔离（G2）

- 备份根**按平台推导，绝不硬编码盘符**：`DSH_IDENTITY_BACKUP_DIR` > `join(dirname(dshHome), "identity-backups")`（配置目录的**同级**，不在其内部）。卡 v3 的必改项：v2 硬编码 `<workdir>\identity-backups`，实测该目录不存在，且团队有一台 macOS 机器（C），若硬编码则「备份失败即拒写」会**拒绝每一次身份写入**。
- 路径在本平台**无法解析**（例如 darwin 上的 `D:\…`）⇒ **致命配置错误**（要求显式配置）；路径可解析但**不可写** ⇒ **拒写**但仍运行（把一次目录权限问题升级成节点下线是安全门禁变成故障）。
- 写前备份 `<备份根>\<文件名>.<YYYYMMDD-HHmmss>.bak`，**校验副本字节数与源一致**，不一致则放弃写入并抛错（底层写入本身会吞错，不能假设成功）。
- 保留份数 `BACKUP_KEEP = 10`（卡第 3 节把该数字登记为"待测：实现时由 4.5 定义并写入代码常量"）。**只裁剪普通备份**：`.corrupt.bak`（隔离副本）与 `.pre-repair.bak` 是证据，不被日常备份churn裁掉。
- 损坏时先落 `<文件名>.<stamp>.corrupt.bak`（逐字节），**原文件只读不搬**，sha256 与 mtime 不变。

## 7. 已受损机器的自助修复（每台机器自己完成，非交互）

`tools/repair-identity.mjs`（只依赖 Node 内置模块，因为它必须能在插件拒绝启动的机器上跑）。
**恢复来源按可信度**：① `rooms/<roomId>.json` 的 `members[]`（房主权威）② `org-state.json` 的 `kind:"member"` 节点 ③ 房主 append-only 消息库的 `from` ④ 备份/隔离目录 ⑤ `--extra-root` 指向的**他机目录副本**。
**它不猜**：不带 `--apply` 只报告；带 `--apply` 仍必须显式给 `--agent-id`，且该 id 必须出现在报告里（除非再加 `--allow-unknown-id`）。

```
# 1) 只看，不写（exit 0）
node tools/repair-identity.mjs --home "%USERPROFILE%\.dsh"

# 2) 按报告里的 id 恢复，并声明信任哪一类记录
node tools/repair-identity.mjs --home "%USERPROFILE%\.dsh" --apply --agent-id <uuid> --from rooms

# 3) 空组织树重播种（先看清警告：非 owner 机的写入会被 owner 的下一次快照整棵覆盖）
node tools/repair-identity.mjs --home "%USERPROFILE%\.dsh" --apply --reseed-org ^
  --company-leader <uuid> --company-name "Studio" --member-agent-id <uuid> --member-name "MainControl"
```

**实测（`<workdir>\_repair-demo` 临时目录，未触碰任何真实配置）**

```
$ node tools/repair-identity.mjs --home <tmp> --backup-dir <tmp-backups>
=== repair-identity: NOTHING HAS BEEN WRITTEN YET ===
  2 candidate agentId(s), strongest first:
  01a0231b-bbe5-720a-97a4-819744eeae76
    nickname(s) : ***** x2, My Company x1, MainControl x1
    found in    : rooms, org, messages
      - [rooms] rooms/01a098a2-….json members[] (room "studio")
      - [org] org-state.json kind=member "MainControl"
      - [messages] messages/01a098a2-….jsonl seq=1
  notes:
    - …\identity.json: PRESENT BUT NOT PARSEABLE (Unterminated string in JSON) - this is the damaged file
$ echo $LASTEXITCODE
0
（identity.json 的 sha256 未变）

$ … --apply                                  → EXIT=1  refusing: --apply requires --agent-id
$ … --apply --agent-id <不在报告里的 id>      → EXIT=1  it did not appear in the report
$ … --apply --agent-id <报告里的 id> --from backups → EXIT=1  该 id 不在 "backups" 记录类里（found in: rooms, org, messages）
$ … --apply --agent-id <报告里的 id> --from org --nickname *****
  === apply ===
    current state : NOT PARSEABLE (Unterminated string in JSON …)
    QUARANTINE: …\identity.json.20260914-144618.corrupt.bak (byte-identical copy kept)
    agentId before: (none)
    agentId after : 01a0231b-bbe5-720a-97a4-819744eeae76
  EXIT=0

$ … --apply --reseed-org --company-leader <uuid> --company-name "Studio" --member-agent-id <uuid>
  === reseed org tree ===
    WARNING: an org snapshot is replaced WHOLESALE by the receiver (sync.js shouldApply)…
    backup: …\org-state.json.20260914-144624.pre-reseed.bak
    wrote 2 node(s) to …\org-state.json
  再次执行（已有 company）→ EXIT=1  refusing --reseed-org: already has a company node
```

## 8. 测试计数（改动前后，`node test/<name>.mjs`，从不用 `node --test`）

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
| `bom-identity.test.mjs`（新增） | — | **pass 14 / fail 0** |

`npx tsc --noEmit` 干净；`node build.mjs` 成功。
> 说明：`backfill.e2e.mjs` 若把 stderr 并进 PowerShell 管道会被报 `NativeCommandError`（`exit=1`），单独重定向 stdout/stderr 时为 `exit=0`；这是 PowerShell 的产物，不是测试失败。
> **开发中被自己的测试抓到的两个真问题**（都已修）：① 文件内容为字面量 `null` 时解析结果与"文件不存在"同为 `null`，等于重新打开本缺陷的口子——现在 `null` 只表示"文件不存在"；② 备份根不可写原本被我做成致命，导致 `selfjoin` 失败——按卡改为"拒写但仍运行"。

## 9. 上线与回滚

**上线**（每台机器自己执行；本版不改协议，可与 agent-org 0.2.11 同批）：

```powershell
# 1) 升级前先归档日志（团队铁律）
node <workdir>\archive-log.cjs --file <该机>\studio.log
# 2) 升级插件（各机自己的看门狗会拉起）
#    并把本版新增的看门狗产物装到该机：
copy /Y "<repo>\studio\start-studio.cmd" "%USERPROFILE%\studio\start-studio.cmd"
#    macOS: cp "<repo>/studio/start-studio.sh" "$HOME/studio/start-studio.sh" && chmod +x "$HOME/studio/start-studio.sh"
# 3) 校验：编码探测应报 8 行 clean + exit=0
powershell -NoProfile -ExecutionPolicy Bypass -File <workdir>\utf8-probe-c00\detect-bom.ps1
```

**回滚触发条件**（任一即回滚）：① 报出与真实损坏无关的 `CorruptConfigError`（误报）导致正常机器起不来；② 本机 agentId 发生变化；③ 组织树节点数下降；④ 看门狗进入崩溃循环且未命中停止条件；⑤ 备份根在该平台不可解析/不可写导致写入被全面阻断。

**备份路径**：`<备份根>\<原文件名>.<YYYYMMDD-HHmmss>.bak`，`<备份根>` = `DSH_IDENTITY_BACKUP_DIR` 或 `join(dirname(dshHome),"identity-backups")`。

```powershell
# 列出可用备份
Get-ChildItem $env:DSH_IDENTITY_BACKUP_DIR -Filter *.bak | Sort-Object LastWriteTime -Descending | Select-Object Name,Length
# 回滚身份（先把当前状态也备份一份，避免回滚本身不可逆）
$now = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item "$env:USERPROFILE\.dsh\agent-room\identity.json" "$env:DSH_IDENTITY_BACKUP_DIR\prerollback-identity.$now.bak"
Copy-Item "$env:DSH_IDENTITY_BACKUP_DIR\identity.json.<TIMESTAMP>.bak" "$env:USERPROFILE\.dsh\agent-room\identity.json" -Force
# 清除可能残留的停止标记（否则看门狗不会重启宿主）
Remove-Item "$env:USERPROFILE\.dsh\agent-room\REFUSED-TO-START" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.dsh\agent-org\REFUSED-TO-START" -Force -ErrorAction SilentlyContinue
# 代码回滚（按版本控制）
git -C <repo> revert <commit>
# 看门狗回滚：恢复 upgrade-studio.sh/.ps1 的上一版；若已把新 start-studio.cmd 部署到机器上，需一并回滚部署
```

**回滚不了的部分**：① 已被旧版本覆盖的 agentId（只能用 4.7 的他机记录恢复，这正是 G2 列为 P0 的原因）；② 已广播出去的快照；③ `audit.jsonl` 的 append-only 历史；④ 已写进 `messages/*.jsonl` 的坏昵称历史行（卡 E11 实测 22 行）。

## 10. 本版**没有**验证 / 主动排除的部分（如实列出）

1. **真实 `dsh web` 端到端**未跑：本会话硬约束禁止启停任何服务（3080 上的 `dsh web` 承载调用方会话）。致命通道是**进程内用宿主真实 `installFailLoud` + 真实构建产物**验证的，宿主侧 `assertEntriesActivated` 那条设计通道未实测。
2. **`C:\studio\start-studio.cmd` 未更新**：它在本机实际在跑，且在工作区之外，本会话文件沙箱不允许写入（不请求提权）。已提供可直接部署的 `studio\start-studio.cmd`；**该机必须自己把它装到位**，否则 G4 在本机不生效。G4 的停止逻辑是用**真实看门狗文件 + 立即退出的桩**验证的，未用真实 `dsh web` 验证。
3. **`studio\start-studio.sh` 的语法未在本机执行**：本沙箱内 bash 无法启动（`couldn't create signal pipe, Win32 error 5`），只做了人工审查 + 字节检查（2471 字节、0 个非 ASCII 字节）。`upgrade-studio.ps1` 通过了 PowerShell 解析器校验。
4. **macOS 路径规则只用纯函数验证**（`assertPlatformResolvableFor(path,'darwin')`），未在C那台 darwin 机器上真跑。
5. **G1 昵称校验只挂"故意设置"处**（`updateProfile`），不在每次 `saveIdentity` 上：否则存量坏昵称（`NAME`）会让启动时的能力合并变成启动故障——卡的回滚条件①正是这种误报停机。
6. **未做存量清洗**：既不修已损坏的历史行，也不改任何现存 agentId；本版只阻止**新**的破坏。
7. **`gateway.identity()` 的结构性保证**由"读/写边界闸门"提供，测试用"三次连续调用都抛错 + 源码委托断言"覆盖，未构造完整 DSH 宿主。
8. **组织树重播种不做自动补种**：卡 4.3 的注释与实现必须一致，我选择**改注释**而不是在 `boot()` 里自动 seed——因为自动 seed 会让每台新机自己造一个 company 节点并广播，而 owner 判定就是 `kind:"company"` 的 `leaderAgentId`，那会造成新的 owner 争夺。重播种改为**显式 CLI**。
9. `test/_probe-fatal-real.mjs` 里 DSH 安装路径是**绝对路径硬编码**（本机事实），它不在 `npm test` 范围内，跨机重跑需改路径。
