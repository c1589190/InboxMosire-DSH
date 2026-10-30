# 挂载程序自有 MCP

DSH adapter 只负责 wake，不负责挂载业务 MCP。程序 MCP 是 Host connector，必须
按目标 workspace 配置；`BindingDescriptor` 仍然只有五个 wake 字段，不能把 URL、
Bearer token 或程序 MCP 配置塞进 descriptor。

## 必须区分的三个 token

| 用途 | 来源 |
|---|---|
| Inbox adapter wake token | `BindingDescriptor.adapterTokenRef` |
| Bot 内部调用 Inbox 的 program token | 程序自己的 `program-mcp.token` |
| Bot MCP 的 Bearer token | 本例为 `IIBOT_CONTROL_TOKEN` |

不要用 wake token 或 program token 去连接 Bot MCP。

## 典型 Bot-first 配置

Bot MCP：

```text
http://127.0.0.1:8765/mcp/bot
Authorization: Bearer <IIBOT_CONTROL_TOKEN>
```

DSH connector 需要：

```text
transport: streamable-http
serverName: iibot          # 或项目选定的稳定名字
url: http://127.0.0.1:8765/mcp/bot
scope: 目标 workspace       # 例如 simulation2，不能是旧的 simulation
auth: Bearer IIBOT_CONTROL_TOKEN
```

当前常见错误是三者同时存在：

- connector 仍指向已关闭的 `http://127.0.0.1:8766/mcp/control`；
- connector 的 project scope 是旧 `simulation`，目标 session 在 `simulation2`；
- connector `headers` 为空，Bot MCP 会返回 401。

先修 URL/scope/auth，再重启或重连 DSH Host connector。

## 验收

目标 session 的 `tools/list` 应出现程序自己的业务工具，例如 iiBot 的：

```text
mcp__iibot__qq_conversation_read
mcp__iibot__qq_conversation_ack
mcp__iibot__qq_conversation_send
...
```

然后：

1. 绑定 inbox；
2. no-claim 程序 bind 时传 `wakeMode: "view-ack"`；
3. 调 `inbox_adapter_status`；view-ack 下 `programMcp=unknown` 是预期值，
   通用适配器不再按业务工具名猜测 readiness；
4. 推一条测试通知，确认 wake 文本不含 `inbox_claim`/`qq_*` 等业务工具名；
5. 由顶层 Agent 根据程序 MCP 的工具 description 自行完成 read/send/ack；
6. 确认 adapter 仍然不 claim/complete/push，也不调用业务工具。

claim 模式仍会探测 `inbox_claim/inbox_list/inbox_view`；如果 claim 工具已出现但
状态仍是 `missing`，检查 DSH 实际公开的工具名前缀是否以
`__inbox_list`、`__inbox_view` 或 `__inbox_claim` 结尾，再检查 session scope，
不要先改 Inbox core。

## WebUI 不再控制 MCP

从 2026-10-27 起，Inbox dock 面板不再挂载或卸载 MCP：`setEnabled` / `reconnect`
调用与 `programMcp` 门槛都已从 client bundle 移除，`programMcpConnectorKey`
配置项也已删除。面板只显示绑定 inbox 的 `host:port` 和一颗挂起/恢复按钮。

需要挂载或修复 `custom-iibot` 时，直接使用 MCP connector 插件
（`mcp_connector_*` 工具或连接器页面）。view-ack 的 readiness 由程序 MCP
连接器与工具 description 自证；通用 adapter 不再在 wake 文本里注入业务工具名
或缺失警告。
