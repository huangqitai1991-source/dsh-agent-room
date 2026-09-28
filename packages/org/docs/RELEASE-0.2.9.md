# dsh-agent-org 0.2.9 — 发布说明

发布日期：2026-09-13
触发问题来源：C（macOS, 192.168.31.118）本机 `~/.dsh/agent-org/audit.jsonl` 涨到 **411 MB / 126 万条** `result="skipped(replay)"`，全部是同一条 `target=C :: echo ALIVE`。

## 改了什么

### 1. replay 命中只累计计数，不再逐条写审计

`src/host/service.js`

去重守卫本身是对的（一条指令只能执行一次），但它在每次命中时都写一行审计 —— 而当一台机器重连、重新同步房间历史时，同一帧会被反复交给处理器。结果是"守卫挡住了执行，却用审计日志把磁盘写满"。

- 新增 `this.replayCounts = new Map()`（与 `seenExecIds` 同寿命，超 `SEEN_EXEC_ID_LIMIT` 时 FIFO 淘汰）
- 同一个 exec id 只在**第一次** replay 时写一行审计，其余静默计数

### 2. 审计日志自动轮转

`src/host/audit.js`

原本是纯 append，没有任何上限。

- 超过 `MAX_BYTES = 16 MB` 时把 `audit.jsonl` 改名为 `audit-<ISO 时间戳>.jsonl`
- 只保留最近 `KEEP_ROTATED = 3` 个轮转文件，更早的删除
- 整个轮转是 best-effort（try/catch）：审计日志永远不能拖垮调用方

## 验证

- `node test/permission.test.mjs` → 5 pass / 0 fail
- `node test/sync.test.mjs` → 4 pass / 0 fail
- `node test/visibility.test.mjs` → 8 pass / 0 fail
- `node build.mjs` → built lib/host/*, lib/tools/*, lib/client.js
- 产物：`dsh-agent-org-0.2.9.tgz` 24271 B，md5 `1E5A5284907D5E6B47E6937C9488995C`
- 已上传 `http://your-host:8090/dsh-agent-org-0.2.9.tgz`
- `upgrade-studio.sh` / `upgrade-studio.ps1` 的 `ORG_VER` 默认值已一并改为 `0.2.9` 并重新上传

## 升级方式

macOS / Linux：

```sh
gzip -c ~/.dsh/agent-org/audit.jsonl > ~/.dsh/agent-org/audit-<日期>.jsonl.gz && : > ~/.dsh/agent-org/audit.jsonl
curl -fsSL http://your-host:8090/upgrade-studio.sh -o ~/upgrade-studio.sh && bash ~/upgrade-studio.sh
```

Windows：

```powershell
iwr http://your-host:8090/upgrade-studio.ps1 -OutFile "$env:TEMP\upgrade-studio.ps1" -UseBasicParsing
& "$env:TEMP\upgrade-studio.ps1"
```

脚本默认同时装 agent-room 0.1.31 与 agent-org 0.2.9。

## 回滚

```sh
npm i -g /path/to/dsh-agent-org-0.2.8.tgz     # 旧包仍在文件服务器上
```

## 附：这次排查暴露的一个"诊断陷阱"（不是代码缺陷，但会骗人）

在**非房主**机器上向房间发消息时，`POST /agent-room-api/rooms/<id>/chat` 返回

```json
{"ok":true,"data":{"seq":null}}
```

且该消息**不会出现在本机** `GET /rooms/<id>/messages` 里 —— 因为本地视图只记房主回传的消息，本机自己的发言要等下一次握手/重新 join 的历史同步才会出现。

- 2026-09-13 主控和我、C三方都据此误判过"消息被静默吞掉"；实际都已送达。
- `seq:null` 对非房主成员是**正常**的：房间序号由房主统一分配。
- 想立刻看到自己的发言：`POST /agent-room-api/join {roomId, address}` 触发一次历史同步。
- 待办（未实现）：发送接口应回传房主确认后的真实 seq，或本地乐观追加自己的消息，避免再次误判。
