# Agent Webhook Gateway

该服务实现固定 Pi Agent 会话的持久化输入网关和输出投递器，并可选实现智能项圈 Health MCP v0.2 的独立消费端。输入端只提交用户文本；Agent 通过 `dimos-mcp-wrapper` 使用 DiMOS `0.0.14b1` 的 14 个非停止官方工具和 6 个自研工具；回复接收端只收到完整的最终用户可见文本，并可在上层进行 TTS。Health 通知使用独立验签、表、队列和 stdio MCP client，不进入 Agent，也不触发物理动作。

```mermaid
flowchart LR
    I["输入端"] -->|"POST /v1/instructions"| G["Agent Webhook Gateway"]
    G --> Q["SQLite inbox/outbox"]
    Q --> A["固定 Pi Agent 会话"]
    A --> W["dimos-mcp-wrapper :9991/mcp"]
    G -->|"agent.reply.completed"| R["回复接收端"]
    H["智能项圈"] -->|"signed /v1/health-events"| G
    G -->|"stdio Health MCP"| M["smart-neckband Health MCP"]
```

## 安装

需要 Node.js 22.19 或更高版本。先确保 `dimos-dog-mcp` 和 `dimos-mcp-wrapper` 已按仓库根目录 `USAGE.md` 启动。

```powershell
Set-Location "C:/absolute/path/to/pi-hackason/components/agent-framework/agent-webhook-gateway"
npm ci --ignore-scripts
npm run build
```

服务使用 Pi Coding Agent 的既有模型与认证配置，默认读取 `~/.pi/agent`。部署前应先用 Pi 完成模型和认证配置。

## 配置与启动

复制模板并填写部署值：

```powershell
Copy-Item ".env.example" ".env"
notepad ".env"
npm run build
npm run start
```

`.env` 会被 Git 忽略。至少设置 `AGENT_WEBHOOK_REPLY_URL`；远程联调时还应将 `AGENT_WEBHOOK_MCP_URL` 指向远程 `dimos-mcp-wrapper` 的 `:9991/mcp`，不要直接连接 `dimos-dog-mcp`。`npm run start:dev` 使用同一 `.env` 直接运行 TypeScript 入口，适合本地调试。

默认输入端点为：

```text
POST http://127.0.0.1:8080/v1/instructions
```

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENT_WEBHOOK_REPLY_URL` | 无 | 回复接收端的部署级 HTTP(S) 回调 URL，必填。 |
| `AGENT_WEBHOOK_HOST` | `127.0.0.1` | 输入网关监听地址。 |
| `AGENT_WEBHOOK_PORT` | `8080` | 输入网关监听端口。 |
| `AGENT_WEBHOOK_DATABASE_PATH` | `<cwd>/data/agent-webhook.sqlite` | 持久化 inbox/outbox 的 SQLite 文件。 |
| `AGENT_WEBHOOK_MCP_URL` | `http://127.0.0.1:9991/mcp` | `dimos-mcp-wrapper` 的 HTTP MCP URL。 |
| `AGENT_WEBHOOK_MCP_TIMEOUT_MS` | `10000` | 单次 MCP 请求超时。运动工具不会自动重试。 |
| `AGENT_WEBHOOK_REPLY_TIMEOUT_MS` | `10000` | 单次回复回调超时。 |
| `AGENT_WEBHOOK_RETRY_BASE_MS` | `1000` | 回复回调失败后的重投等待时间。 |
| `AGENT_WEBHOOK_RETRY_MAX_MS` | `60000` | 回复重投等待时间的上限。 |
| `AGENT_WEBHOOK_AGENT_CWD` | 当前目录 | 固定 Agent 会话的工作目录。 |
| `AGENT_WEBHOOK_AGENT_DIR` | `~/.pi/agent` | Pi 模型、认证和设置目录。 |
| `AGENT_WEBHOOK_SESSION_DIR` | `<cwd>/data/agent-session` | 固定 Agent 会话的持久化目录。 |
| `AGENT_WEBHOOK_DEFAULT_SPEED_MPS` | `0.1` | 用户只给距离时用于估算时长的部署标定速度。 |
| `AGENT_WEBHOOK_HEALTH_WEARER_ID` | 无 | 设置后启用 Health；单实例 wearer ID。 |
| `AGENT_WEBHOOK_HEALTH_KEY_ID` | 无 | Health 当前 HMAC key ID。 |
| `AGENT_WEBHOOK_HEALTH_SECRET_HEX` | 无 | Health 当前 32-byte secret 的 64 位小写十六进制编码。 |
| `AGENT_WEBHOOK_HEALTH_PREVIOUS_KEY_ID` / `AGENT_WEBHOOK_HEALTH_PREVIOUS_SECRET_HEX` | 无 | 可选的前一个轮换 key；必须成对配置。 |
| `AGENT_WEBHOOK_HEALTH_MCP_COMMAND` | `py` | 上游 stdio Health MCP 可执行文件。 |
| `AGENT_WEBHOOK_HEALTH_MCP_ARGS_JSON` | `["-3.12","-m","smart_neckband.health_mcp","--transport","stdio"]` | 不经过 shell 的参数数组。 |
| `AGENT_WEBHOOK_HEALTH_MCP_TIMEOUT_MS` | `10000` | Health MCP initialize/tools call 超时。 |

普通 instruction/reply MVP 没有身份校验、签名或重放防护，只能部署在受信任网络。可选 Health endpoint 使用 raw-body HMAC、`±300` 秒时间戳和当前/前一 key rotation，但非 loopback 部署仍需 TLS 和网络访问控制。

## 行为

- 输入 JSON 只能包含非空的 `instruction_id` 和 `text`。
- 新事件和相同文本的幂等重投返回 `202`；同一 ID 对应不同文本返回 `409`。
- 普通事件按 SQLite 受理顺序串行进入一个固定 Agent 会话。
- “停”或 `stop` 的精确规范化匹配绕过 Agent，单次调用 `stop_all`。
- 固定 Agent 明确拒绝 `Bound` 以及任何前空翻、后空翻、侧空翻、连续空翻或其他 `flip` / `somersault` 动作；它不会为这些请求调用 `execute_sport_command` 或其他运动工具，也不会改写成替代动作。
- 具名目的地使用 `navigate_with_text`；未知区域覆盖探索、已建图覆盖巡逻和非覆盖式人类散步分别使用 `begin_exploration`、`start_patrol`、`start_stroll`。
- `stop_all` 由底层统一尝试停止定时速度、定点导航、探索、巡逻、散步和持续视觉查找；Agent 和快速路径都不再调用专项停止工具。
- Agent 或停止调用失败时仍产生普通回复事件，文本固定为“暂时无法完成此请求，请稍后重试。”。
- outbox 先持久化再回调。回调失败只重投同一 `reply_id`，不会重跑 Agent 或 MCP 工具。
- 进程启动时若发现上次运行中断在 `processing` 状态，会生成固定失败回复而不重跑该事件，避免重复机器狗副作用。
- Health 通知在独立 SQLite 表和 queue 中按 raw-body digest 原子去重，ACK 后查询权威 Health MCP。
- Health worker 固定检查 contract、revision、wearer/source、live/test/freshness；通过时只记录 `verified_no_action`，不会调用 Agent 或机器狗 MCP。

`Bound` 与所有空翻的禁用当前属于固定 Agent 的系统提示词约束，不是程序级工具调用门。直接连接 MCP 的其他 Host 仍可调用通用的 `execute_sport_command`；需要确定性禁止时，必须在下层增加可测试的命令策略。

普通 HTTP schema 见 `docs/agent-input-webhook-integration.md`；Health 配置、header、ACK 和错误映射见 `docs/health-mcp-consumer-integration.md`。

## 开发

```powershell
npm test
npm run check
```

### 本地 dry-run 端到端演示

不安装 DIMOS、不配置模型认证且不连接真实机器狗时，可运行：

```powershell
npm run demo:dry-run
```

该命令使用临时端口和临时 SQLite 数据库启动真实网关核心，并在进程内替身化固定 Agent、`dimos-mcp-wrapper`、`dimos-dog-mcp` 和回复接收端。演示提交一条定时前进指令，在 Agent 仍被阻塞时再提交 `STOP`，并自动断言：

- 两条指令都收到完整的 `agent.reply.completed` 回调，且停止回调先返回；
- `move_forward` 和 `stop_all` 在包装器及底层替身中各调用一次，参数原样转发；
- 停止口令绕过忙碌的 Agent，固定 Agent 只运行一次。

成功时进程输出 `dry-run e2e passed` 和调用摘要，随后删除临时数据库。`npm test` 会自动执行同一场景。

### Health MCP 跨仓库联调

准备好 `smart-neckband` Health 功能分支的 Python 3.12 虚拟环境后，可在不启动模型、DIMOS、真实机器狗、采集设备或人体连接的情况下运行：

```powershell
$env:SMART_NECKBAND_HEALTH_ROOT = "C:/absolute/path/to/smart-neckband-health-worktree"
$env:SMART_NECKBAND_HEALTH_PYTHON = "$env:SMART_NECKBAND_HEALTH_ROOT/pc_app/.venv/Scripts/python.exe"
npm run demo:health-cross-repo
```

该命令使用临时端口、临时上游 Health SQLite、临时 Gateway SQLite 和公开测试密钥，运行真实的上游 Health store、Webhook sender、Pi Health receiver、durable queue 与上游 stdio MCP。它覆盖 `INT-001..010`、`INT-016`、`INT-017` 和 `INT-020` 的当前可自动化子集，并断言：

- 首次投递为 `202 accepted`，权威 event/state 查询终态为 `verified_no_action`；
- duplicate、raw-body conflict、错误签名、过期时间戳、Header/body ID、Schema、replay 和 event mismatch 均按契约处理；
- 五路并发恰好一个 `accepted`、四个 `duplicate`；
- current/previous key 可接受，未知 key 被拒绝；
- Agent、DIMOS 和 robot 调用计数均为 0。

该演示不替代 `INT-011..015`、`INT-018/019` 的故障/重启注入，也不等同于完整双方验收。成功时输出 `health cross-repo integration passed` 和不含 secret、签名或健康原始数据的摘要，并删除全部临时数据库。

主要扩展边界：

- 新的用户文本运行时实现 `UserTextAgent`；
- 新的 MCP 传输实现 `McpToolCaller`；
- 新的回复传输实现 `ReplyEventDelivery`；
- Webhook schema、稳定 ID、固定会话串行语义和 outbox 不得由适配器改变。
