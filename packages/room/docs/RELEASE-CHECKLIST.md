# agent-room 更新/发布检查单 (Release Checklist)

> 目的：固化「打包 → 安装 → 重启 → 回归」全流程，避免三类反复踩坑：
> 1. **路径乱码** — 安装路径含中文/非 ASCII 目录名，导致 node_modules 内文件路径乱码、加载失败；
> 2. **补丁污染** — 重装后 cordis.patch.yml 出现重复 insert id，与其它 profile 层（brand-custom / adhd）冲突，web 起不来；
> 3. **漏配中继** — 未配 AGENT_ROOM_RELAY，跨网房间不可达，或 web 依赖中继桥接的功能失效。

## 前置条件

- 仓库路径：`<workdir>\dsh-agent-room`（纯 ASCII，无中文目录名）。
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

## 6. 中继健康检查（0.1.27 起，每次排查必做）

> 2026-09-12 的事故教训。**先记住第一条**：一个「会撒谎的诊断字段」把整轮排查带偏过 ——
> 当时 `state.bridge.state` 报 `connecting`，据此断定桥接卡死，实际桥接一直是好的
> （原因见第 3 条）。**永远用端到端探针验证，不要只信状态字段。**

按这个顺序查，30 秒能定位：

1. **对方到底连上没有**（中继日志；注意日志在 `relay.log`，不在 journalctl）
   ```
   grep -oE "agent=[0-9a-f]+" /home/ubuntu/relay/relay.log | sort | uniq -c | sort -rn
   ```
   没有对方的 agentId = **对方根本没上线**，别再往下查了。
   看最后一条事件：`relay.auth ok=true` = 在线；`close` 之后没有新的 `connect` = 掉线。
2. **端到端探针**（唯一可信的验证）：对目标机器跑一次 exec
   ```
   POST /agent-org-api/exec  {"targetAgentId":"<id>","command":"hostname"}
   ```
   能返回主机名 = 链路完全正常。这一条过了就不用再查 3、4 条。
3. **`bridge.state` 的坑（0.1.26 及以前）**：该字段读的是 `refreshRelayBridge()` 写下的缓存，
   而那只在启动 / 改 relay 配置时跑一次，所以它**冻结在启动瞬间**，健康桥接也会一直显示
   `connecting`。**0.1.27 起改为实时读取**。不要再拿这个字段当故障依据。
4. **中继内存 / 健康指标**
   ```
   grep '\[relay\] health' /home/ubuntu/relay/relay.log | tail -n 5
   ```
   中继每 30 秒打一行：`rss=… heapUsed=… rooms=… owners=… members=… buffered=…`

   **判读（2026-09-12 实测结论）**：
   - **看 `heapUsed`，不要只看 `rss`。** 正常时 `heapUsed ≈ 6~7MB` 而 `rss` 66MB ——
     RSS 高是 V8 堆预留 + 套接字缓冲，**不是泄漏**。
   - 实测 10 分钟稳态（每 30 秒一行，共 20 行）：
     `rss` 65.9 → 66.9MB（平台期）、`heapUsed` 6.3~7.5MB（有界振荡）、
     `rooms` 3~5（振荡 = 房间表清理正常）、`owners` 3（稳定）、`buffered` 0（始终）。
   - 刚启动几分钟内 `rss` 从 20MB 爬到 ~66MB **属正常**：那是 V8 把堆从初始尺寸涨到
     稳态预留，不是泄漏。**别在这个阶段拉趋势线做外推**（我犯过这个错）。
   - **`heapUsed` 持续单调上涨** = 真的 JS 泄漏，要查。
   - `rooms` / `members` 应保持个位数且**来回振荡**；只涨不落才是有问题。
   - `buffered` 长期非 0 = 有房主掉线在攒离线帧。
   - `rss` 冲到几百 MB = 有对端不读数据还在被 send（套接字写队列是**堆外**的，
     所以只体现在 `rss` 上）—— 这正是 2026-09-12 那次 536MB 的原因，`safeSend()` 已堵住。

   需要重启时（纯内存无状态，代价只有几秒重连）：
   ```
   sudo systemctl restart dsh-relay.service
   ```

   **系统级兜底（2026-09-12 已部署）**：`/etc/systemd/system/dsh-relay.service.d/memory.conf`
   设了 `MemoryHigh=256M` / `MemoryMax=384M`，配合原有的 `Restart=always` / `RestartSec=3`：
   中继一旦涨到上限就被 cgroup 杀掉并在 3 秒内自动重启。
   **中继是无状态的，被杀是廉价的** —— 所有成员会自己重连（已实测：重启中继后小黄自动恢复）。
   正常稳态约 60MB，离 384MB 上限很远，不应触发；若哪天看到
   `journalctl -u dsh-relay.service` 里有 `oom-kill`，说明又有新的内存增长源。
   日志轮转也已配好（`/etc/logrotate.d/dsh-relay`，每周、留 4 份；配置文件权限必须是 644，
   logrotate 会拒绝加载组/其他可写的配置）。

   > 注意：中继**不要**对「房主暂不在线」的房间直接回绝 join。虽然那样能立刻止住老客户端的
   > 僵尸重连，但客户端把 `join rejected` 当终止信号 —— 于是**每次重启主控，所有成员都会永久
   > 退出房间**。中继重启后成员本来能自愈（上面刚实测过），别为了日志噪音毁掉这个性质。
   > 僵尸重连只在客户端侧修（0.1.27 的 `hasConnected` 闸门）。

**现场急救（不重启 web、不断自己的会话）：**
```
curl -X POST http://127.0.0.1:3080/agent-room-api/relay-config -H "Content-Type: application/json" -d "{\"relay\":\"\"}"
curl -X POST http://127.0.0.1:3080/agent-room-api/relay-config -H "Content-Type: application/json" -d "{\"relay\":\"ws://your-host:9320\"}"
```

**判断机器在不在线，不要用 ping 或端口扫描**：agent-room 的 web 只监听 `127.0.0.1`，
扫不到不代表没在跑。只看中继日志。

---

## 7. 0.1.27 变更摘要（2026-09-12）

| 类别 | 变更 | 原因 |
|---|---|---|
| 成员端 | 加入快照 200 条 → 50 条 + 12KB 字节预算 | 实测 75.0KB → 12.0KB（缩小 6.3 倍）；75KB ≈ 50 个 TCP 段，在丢包 10% 的链路上要 ~30 秒 |
| 成员端 | 中继握手超时 5s → 20s 起、失败倍增、上限 120s | 慢链路被误判为断线 |
| 成员端 | 握手没成功过的 client 不再自我复活 | 加入失败后 `service.joinRoom` 会抛错且不登记该 client，但它的 close 处理器会无限重连，每次拉一份快照 → 僵尸风暴 |
| 房主端 | 桥接加 15 秒连接超时，用 `terminate()` 断开 | `ws` 不超时；CONNECTING 套接字会阻塞自己的重建 → 桥接永久死亡且指令静默丢弃 |
| 房主端 | 桥接非 open 时丢帧要告警（每房间每分钟最多一次） | 静默丢帧让坏掉的桥接看起来是好的 |
| 房主端 | 启动时清理 24h 以上、且地址不是中继的 joined 记录 | 直连时代的残留永远重连不上，只贡献噪音 |
| 房主端 | 自动重连失败：首次 warn、后续 debug、上限 3 次 | 日志被刷屏 |
| 接口 | `state.rooms` 按 roomId 去重 | 自己拥有的房间又被自己加入时会重复显示两次 |
| 接口 | `bridge.state` 改为**实时读取**（不再读启动时的缓存） | 缓存冻结导致健康桥接永远显示 `connecting`，把一次故障排查带偏了整整一轮 |
| 中继 | `safeSend()` 背压保护，积压 >4MB 断开该对端 | 对不读数据的对端无限 send 导致 536MB 泄漏，之后无法完成新握手 |
| 中继 | pong 计数，60 秒无响应 terminate | 半开连接不发 FIN 也不断 |

新增测试：`test/snapshot.test.mjs`（4 条，覆盖快照裁剪的边界）。


---

## 附：回滚

web 起不来的三连查（按概率排序）：

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 模块加载失败 / 乱码路径 | 安装目录含中文 | 移到纯 ASCII 路径重装 |
| 插件重复注册 / 配置冲突 | cordis.patch.yml 重复 insert id | 清掉重复层后 `pnpm install --force` |
| 远端房间不可达 | 中继未配置 / 中继未启动 | 配 `AGENT_ROOM_RELAY` 并启动 relay-server.mjs |

回滚操作：从 profile 移除 `file:` 依赖 → `pnpm install --force` → 安装上一版本 tgz → 重跑第 3、4 节校验。
