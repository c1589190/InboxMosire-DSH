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

目标 session 的 `tools/list` 至少应出现：

```text
mcp__iibot__inbox_list
mcp__iibot__inbox_view
mcp__iibot__inbox_claim
...
```

然后：

1. 绑定 inbox；
2. 调 `inbox_adapter_status`，它会主动重新探测当前 session 的 tool schema；
3. 确认 `programMcp=available`；
4. no-claim 程序 bind 时传 `wakeMode: "view-ack"`；
5. 推一条测试通知，确认 wake 文本不含 `inbox_claim`；
6. 确认 adapter 仍然不 claim/complete/push。

如果工具已经出现但状态仍是 `missing`，先检查 DSH 实际公开的工具名前缀是否以
`__inbox_list`、`__inbox_view` 或 `__inbox_claim` 结尾；再检查 session scope，
不要先改 Inbox core。
