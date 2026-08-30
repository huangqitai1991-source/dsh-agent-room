# agent-room 更新/发布检查单 (Release Checklist)

> 目的：固化「打包 → 安装 → 重启 → 回归」全流程，避免三类反复踩坑：
> 1. **路径乱码** — 安装路径含中文/非 ASCII 目录名，导致 node_modules 内文件路径乱码、加载失败；
> 2. **补丁污染** — 重装后 cordis.patch.yml 出现重复 insert id，与其它 profile 层（brand-custom / adhd）冲突，web 起不来；
> 3. **漏配中继** — 未配 AGENT_ROOM_RELAY，跨网房间不可达，或 web 依赖中继桥接的功能失效。

## 前置条件

- 仓库路径：`D:\dsh\dsh-agent-room`（纯 ASCII，无中文目录名）。
- 目标 profile 路径同样必须是纯 ASCII。
- Node >= 22.19。

---

## 1. 打包前检查（源码侧）

1. 检查源码 `cordis.patch.yml`：
   - 每个 `insert` 有唯一 `id`，无重复 insert id。
   - 与其它 profile 层的 patch 对照（如 `brand-custom`、`adhd` 各自独立）：各层 insert id 互不冲突。
   - 当前本插件只有 1 个 insert：`id: agent-room`。
2. 构建通过：`node build.mjs`，无 TS 错误，产物 `lib/host/*`、`lib/client.js`、`lib/skills/*` 生成。
3. 生成 tgz：`npm pack --ignore-scripts`，产物形如 `dsh-agent-room-0.1.5.tgz`。
4. 确认 tgz 内容完整（`tar -tf dsh-agent-room-0.1.5.tgz` 或解压抽查）：
   - `package/lib/`（host 主入口 `lib/host/index.js`）
   - `package/relay/relay-server.mjs`
   - `package/cordis.patch.yml`
   - `package/docs/`

## 2. 安装到目标 profile

二选一：

- **方式 A（推荐）**：`dsh plugin --profile web add <tgz 绝对路径>`
- **方式 B**：在 profile 的 `package.json` dependencies 写
  `"dsh-agent-room": "file:<绝对路径>/dsh-agent-room-0.1.5.tgz"`，然后 `pnpm install --force`。

安装后校验：

1. profile `package.json` 中 `file:` 路径真实存在（`Test-Path` / `Get-Item`）。
2. 该路径**无乱码、无中文目录名**——若安装目标是中文目录，立即停止并改到 ASCII 路径。
3. `node_modules\dsh-agent-room` 目录存在。

## 3. 重装后校验（防补丁污染）

1. `node_modules\dsh-agent-room\cordis.patch.yml`：只含预期 insert（`id: agent-room`），无重复 id。
2. 全库查重：grep `node_modules` 下所有 patch 文件，确认 `insert:` 的 id 在**所有层之间唯一**（尤其 vs brand-custom / adhd）。
3. 中继文件齐全（对应 D7/D8）：
   - `node_modules\dsh-agent-room\relay\relay-server.mjs` 内含 `relay.auth`（D7 中继鉴权握手）与 `buffer`（D8 离线补发缓冲）。
   - 缺失 = 装到了旧包，必须重装新 tgz。
4. host 主入口存在：`node_modules\dsh-agent-room\lib\host\index.js`。

## 4. 重启与中继

1. 启动 dsh web，带中继环境变量：

   ```powershell
   $env:AGENT_ROOM_RELAY = "ws://<中继host>:9320"
   dsh web
   ```

   （或用插件配置 `relay: "ws://<host>:9320"`，见 `docs/protocol.md`。）
2. 确认 3080 监听：`Get-NetTCPConnection -LocalPort 3080 -State Listen`。
3. 确认 `http://127.0.0.1:3080/api/status` 返回 ok。
4. 日志出现 `relay bridge open`（每个经中继桥接的房间打该日志；中继进程 `node relay-server.mjs` 需在跑）。
5. 若日志无 `relay bridge open` 且远端房间不可达：检查
   - `AGENT_ROOM_RELAY` 是否漏配 / 写错（地址、端口）；
   - 中继进程是否存活；
   - profile 内是否残留旧版本插件（重复 insert 会先导致 web 起不来，见第 3 节）。

## 5. 功能回归

1. **经中继加入房间**：远端节点加入后，房间桥接状态显示「中继 · 已桥接」（usingRelay=true）。
2. **双向发消息**：A→B、B→A 均能收到，消息 seq 连续。
3. **任务闭环**：建任务 → 认领 → 完成 → 总控通过/驳回，状态流转正确。
4. **补发不重复**：成员离线期间的消息，重连后补发且**无重复**（seq 去重）。
5. （可选）跑 `node relay-e2e-test.mjs`：覆盖中继加入 + 任务闭环 + token 鉴权拒绝。

---

## 附：回滚

web 起不来的三连查（按概率排序）：

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 模块加载失败 / 乱码路径 | 安装目录含中文 | 移到纯 ASCII 路径重装 |
| 插件重复注册 / 配置冲突 | cordis.patch.yml 重复 insert id | 清掉重复层后 `pnpm install --force` |
| 远端房间不可达 | 中继未配置 / 中继未启动 | 配 `AGENT_ROOM_RELAY` 并启动 relay-server.mjs |

回滚操作：从 profile 移除 `file:` 依赖 → `pnpm install --force` → 安装上一版本 tgz → 重跑第 3、4 节校验。
