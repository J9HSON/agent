# 在现有 Gateway 内提供本地 Agent Console

状态：已接受。

## 背景

操作者需要一个不依赖 Codex 的常驻前台：同一页面看到机器狗地图、输入自然语言、
查看 canonical task 状态和最终回复。现有 Studio 功能过多；直接从浏览器调用 MCP
会绕过 `instruction_id -> task_id` 幂等绑定；另建控制服务又会产生第二个任务状态
Owner。

## 决策

在现有 `agent-webhook-gateway :8080` 同源托管极薄的 Agent Console。文字输入仍
提交现有 `POST /v1/instructions`；新增只读
`GET /v1/instructions/:instruction_id`，只读取 Gateway SQLite 已有
instruction/task/outbox 状态。默认回复 URL 指回同进程的 `/v1/ui-replies`，它只
核对已持久化回复，不保存第二份状态；外部回复 Webhook 仍可通过环境变量覆盖。

地图由 iframe 读取同一 Product Runtime 的官方 Rerun web viewer `:9878`。
Runtime 使用 `VIEWER=rerun`、`RERUN_OPEN=none`、`RERUN_WEB=true`，所以不会自动
打开第二个页面，也不会创建第二个 Go2 连接、Planner 或任务状态机。Console 的停止
按钮只提交精确文本“停”，继续复用 Gateway 的优先 `stop_all` 路径。

## 取舍

- 保留唯一链路：Console → Gateway → Wrapper → MCP → DimOS → Go2。
- UI 无法在 Product Runtime 未运行时显示地图，但会明确显示离线状态。
- 浏览器地图使用官方 Rerun web renderer；需要最低负担时应只保留这一个 Console
  页面，不同时打开 native Viewer 和多个 Studio/command-center 页面。
- 本地 HTTP 接口仍只适用于受信任网络，不是公网控制面。

## 否决方案

- 扩展旧 Studio：页面负担过大，且旧 Agent 输入走 `agent_send`，不是朋友 Gateway。
- 新建 robot-console 服务/SSE 数据库：重复回复与任务状态，不符合单 Owner。
- 浏览器直连 MCP：绕过 Agent 编译、幂等、任务生命周期和回复证据。
