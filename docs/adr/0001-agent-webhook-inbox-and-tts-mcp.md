# ADR-0001：持久化输入 Webhook 与显式 TTS MCP

状态：已接受

外部系统通过 `POST /v1/instructions` 向固定 Agent 会话提交自然语言。网关先将稳定的 `instruction_id` 和文本持久化到 SQLite inbox，再返回 `202 Accepted`；除精确停止口令外，指令按接收顺序串行进入 Agent。

网关不提供出站回复 Webhook，也不把 Agent 最终 assistant 文本自动发送给硬件。需要让用户听到的内容时，模型必须主动调用独立 TTS MCP 的 `speak(text)` 工具。机器人 MCP 与 TTS MCP 使用不同配置和端点，避免把语音播放混入机器狗工具契约。当前传输沿用项目已有的无状态 HTTP JSON-RPC `tools/call` profile，不声称兼容需要 `initialize` 和 session 协商的任意 MCP Server。

该选择保留输入去重和固定 Agent 会话语义，同时让模型明确决定哪些内容需要播报。TTS MCP 调用失败不会由网关自动重试，进程恢复也不会重新运行已进入 `processing` 的指令，以免重复机器狗动作或重复播报。

规范化后精确等于“停”或 `stop` 的指令仍绕过 Agent，直接单次调用机器人 MCP 的 `stop_all`。该快速路径不会自动调用 TTS MCP，也不能替代物理急停。
