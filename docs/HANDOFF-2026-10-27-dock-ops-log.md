# 交接：DSH InboxMosire 插件（dock 面板 + 操作日志）变更

> 日期：2026-10-27 21:20（Asia/Shanghai）
> 范围：`@mosire/dsh-inbox-mosire`（本仓）。面向"隔壁"Bot 专用 DSH 工作区。
> 状态：代码与单元测试完成（132 tests / 129 pass / 3 skipped / 0 fail）；
> **真实 Host 重载后的面板、真机 suspend/resume、真机 lastOp 均为 NOT_RUN。**

## 1. 破坏性变更（必须适配）

1. **dock 面板不再控制 MCP。**
   旧的"挂载 MCP / 卸载 MCP / 挂载全部 / 卸载全部"三态按钮已删除，`setEnabled`
   调用、`programMcp` 门槛、乐观更新全部移除。
   影响：任何"让 Agent 点面板把 `custom-iibot` 挂起来"的流程/文档/技能都失效。
   `custom-iibot` 的连接、凭据、启用状态现在**只能**通过 MCP connector 插件
   （`mcp_connector_*` 工具或连接器页面）管理。

2. **面板那颗按钮只剩一个语义：挂起 / 恢复本会话已记录的 binding。**
   - 卸载 = `suspend`：停 SSE、游标、occupancy、唤醒；**保留 descriptor**，
     `enabled=false` 持久化，Host 重启后仍是挂起态。
   - 挂载 = `resume`：重读 token、重启 status/SSE、重新 PUT occupancy。
   - 恢复的是**同一条已记录的 descriptor**；面板没有 URL/token 输入框，不能凭空新建。
     真要换 inbox 或删除记录，走 `inbox_adapter_bind` / `inbox_adapter_unbind`。

## 2. 新增能力

3. **`inbox_adapter_log`**（只读，`limit` 1–100，默认 20）：
   返回**调用者本会话**的绑定生命周期日志，最新在前。
   记录 `bind` / `unbind`（actor `agent`）、`suspend` / `resume`（actor `user`，面板）、
   `retry`、token 不可用时的 `start` 失败；字段只有
   `at/action/actor/session/inbox/endpoint/wakeMode/result/error`。
   严格按 session 过滤，**没有跨会话查询**；不含 token、tokenRef 路径、item 内容、
   summary、唤醒投递。
4. **`inbox_adapter_status` 新增 `lastOp:` 行**，不调日志工具也能看到最近一次谁动过。
5. **dock 面板显示绑定地址**：`host:port`（`apiBaseUrl` 投影，丢 scheme/path/userinfo），
   挂起后显示 `Inbox 已卸载（用户 13:02）`，失败标 `失败`。
6. **新配置** `opsFile` / `INBOX_OPS_FILE`，默认 `state.json` 同目录的 `ops.jsonl`
   （0600，append-only，每会话保留最近 200 条、256 KiB 上限）。

## 3. 适配清单（隔壁 Agent 应做的）

- 不要把"面板挂载"当成启动 `custom-iibot` 的手段：需要 Bot 工具时，自己确认
  connector 可用（`mcp_connector_health_check` / `mcp_connector_tools_list`），
  或请用户处理。
- 看到 `Inbox 已卸载（用户 …）` 或 `lastOp: … suspend by user` 时，**这是用户主动挂起**，
  不是连接故障：不要自动重新绑定，也不要把它当异常上报；需要恢复时请用户点"挂载"。
- 想确认"我为什么收不到通知/什么时候被挂起"时，用 `inbox_adapter_log`，不要猜。
- 绑定仍走 `inbox_adapter_bind`（descriptor：`inboxId` + `apiBaseUrl` + `adapterTokenRef`）；
  token 必须是**该 bot 实例当前**的 token（见 §4 第 1 条）。
- Bot 侧启动不要再 `openssl rand` 生成本地 token：`source ~/.config/iibot/control.env`，
  并写对 `run/iibot.pid`。

## 4. 已知遗留（与本次改动无关的老问题）

1. `custom-iibot` 里存的是 10-24 的旧 Bearer，运行中的 bot 用的是 10-27 新 token →
   initialize 401，Bot 的 37 个工具挂不上。面板已不再触碰 MCP，此问题仍在 connector 侧。
2. `bot/run/iibot.pid` = 27028，实际 java = 27540（启动命令写 pid 后进程被替换）。
3. token 两套真相源：`~/.config/iibot/control.env` 与 `bot/run/control.token`。
4. `state.json` 里 4 条 suspended binding（含已归档会话），没有 GC。
5. ~~`manager.flush()` 每次保存把所有 binding 的 `updatedAt` 刷成同一时刻~~ 已修：
   `updatedAt` 改由各 mutator 自己维护。

## 5. 本次改动自身的尾巴

- ~~`programMcpConnectorKey` 死配置~~ 已删除（config、`panelStatus`、文档同步清理）。
- 日志是"单文件 + API 级会话隔离"，不是物理隔离（可按需改 per-session 文件）。
- 日志仍不记唤醒投递；`session-disposed` / `session-archived` 引起的停止已补记为
  `stop`（actor `host`，带 `reason`）。
- 面板不再显示 `programMcp` 诊断（只保留在 `inbox_adapter_status` 文本）。

## 6. 生效方式

engine 行与 client bundle 都需要 **Host 重载**（重启 `dsh web`）。重载后：
挂起态 binding 保持挂起；已归档会话的旧 binding 仍在 state 里；日志从本次重载后开始累积。
