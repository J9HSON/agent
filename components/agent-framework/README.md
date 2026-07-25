# Agent Framework

`agent-framework` 是部署在上层机器的 Agent 侧组件集合。它使用仓库 `packages/` 中的 Pi Agent 能力，但不把机器狗控制逻辑复制到上层。

## 子组件

| 子组件 | 职责 |
| --- | --- |
| [`dimos-mcp-wrapper`](dimos-mcp-wrapper/README.md) | 向上层暴露机器狗工具，单次转发到底层 MCP，并发出非阻塞生命周期 hook。 |
| [`agent-webhook-gateway`](agent-webhook-gateway/README.md) | 持久化用户输入、运行固定 Agent 会话，并按模型决策调用独立 TTS MCP 的 `speak(text)`。 |

## 依赖方向

```text
Input Webhook
    -> Agent Webhook Gateway
        -> DIMOS MCP Wrapper -> components/dimos-mcp
        -> TTS MCP -> TTS / speaker hardware
```

- 本组件不知道机器狗 SDK、`cmd_vel` 发布细节或 DIMOS 硬件连接方式。
- `dimos-mcp-wrapper` 通过 `DIMOS_MCP_WRAPPER_UPSTREAM_URL` 指向底层 MCP。
- `agent-webhook-gateway` 通过 `AGENT_WEBHOOK_MCP_URL` 指向包装器。
- `agent-webhook-gateway` 可通过 `AGENT_WEBHOOK_TTS_MCP_URL` 为模型注册独立的 `speak` 工具；没有出站回复 Webhook。
- 详细安装、联调和扩展方式见仓库根目录 [`USAGE.md`](../../USAGE.md)。
