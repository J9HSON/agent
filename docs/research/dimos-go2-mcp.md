# DIMOS 机器狗 MCP 调研记录

日期：2026-07-23

## 结论

用户指出的 [dimensionalOS/dimos](https://github.com/dimensionalOS/dimos) 才是本项目应对接的 DIMOS。它已经内置 MCP Server、技能发现和 Unitree Go2 连接能力；本 MVP 应作为 DIMOS 扩展发布 `@skill`，而不是实现一个脱离 DIMOS 的 MCP 服务或直接拼接 ROS 2 CLI。

## 一手证据

- [项目 README](https://github.com/dimensionalOS/dimos/blob/main/README.md) 将 DIMOS 定位为物理空间的 Agent 操作系统，并给出 `dimos run unitree-go2-agentic`、`dimos mcp list-tools` 和 `dimos mcp call` 的使用方式。
- [MCP README](https://github.com/dimensionalOS/dimos/blob/main/dimos/agents/mcp/README.md) 明确说明：`McpServer` 在蓝图中启动 FastAPI，客户端以 Streamable HTTP 连接 `http://localhost:9990/mcp`。
- [McpServer 实现](https://github.com/dimensionalOS/dimos/blob/main/dimos/agents/mcp/mcp_server.py) 把所有 DIMOS 模块的 `@skill` 方法转换为 `tools/list` 和 `tools/call` 的 MCP 工具；服务端实现的是 HTTP `/mcp`，不是 stdio 子进程协议。
- [`@skill` 实现](https://github.com/dimensionalOS/dimos/blob/main/dimos/agents/annotation.py) 支持 `uses` capability。`movement` capability 用于排斥并发运动工具。
- [Go2 连接模块](https://github.com/dimensionalOS/dimos/blob/main/dimos/robot/unitree/go2/connection.py) 定义 `cmd_vel: In[Twist]`，并将输入转发给机器狗连接；该模块也是官方机器人蓝图使用的稳定接入点。
- [Go2 原生适配器](https://github.com/dimensionalOS/dimos/blob/main/dimos/hardware/drive_trains/unitree_go2/adapter.py) 的高层接口以 `write_velocities([vx, vy, wz])` 执行速度命令、以 `write_stop()` 执行立即停止。
- [速度任务](https://github.com/dimensionalOS/dimos/blob/main/dimos/control/tasks/velocity_task/velocity_task.py) 的默认超时为 0.2 秒并可在超时发送零速度，说明 DIMOS 提供了死手式速度控制选项；本项目当前不把该超时转化为用户参数范围。

## MVP 设计

实现最初位于 `integrations/dimos-dog-mcp`，现已抽离为组合仓库中的独立组件 `components/dimos-mcp`，不修改 DIMOS 或 Pi 核心：

1. `DogMotionSkill` 使用 `@skill` 暴露 `move_forward`、`move_backward` 和 `motion_status`；`StopAllSkill` 公开统一的 `stop_all`，底层专项停止方法只保留为内部 RPC。
2. 技能将速度转成标准 DIMOS `Twist`，并发布到 `cmd_vel`。
3. 默认 `dry-run` 接入内部 sink，不连接任何真实硬件；基础依赖安装 DIMOS `web` extra，并直接固定 DIMOS 生成 skill schema 时实际使用的 `langchain-core`。显式 `DIMOS_DOG_MCP_MODE=go2` 和 `go2` 可选依赖才会启用官方 `GO2Connection`。
4. 初版曾把运动命令限制为 `0.01–0.20 m/s` 和 `0.1–2.0 s`；当前项目决策已移除这些硬编码范围，只要求速度与时长为正的有限数值。运行期间仍按 10 Hz 发布，正常结束、显式停止和模块关闭均发送零速度。
5. 前进与后退立即启动后台定时运动；本地状态机拒绝重叠动作，停止工具可抢占当前动作，因此不依赖 DIMOS RPC 是否并行调度。

## 锁定版官方工具与散步扩展

项目锁定的 DiMOS `0.0.14b1` 官方 Go2 Agentic Blueprint 共提供 21 个 MCP 工具：

- MCP 管理：`server_status`、`list_modules`、`agent_send`。
- Unitree 与设备：`relative_move`、`wait`、`current_time`、`execute_sport_command`、`get_battery_soc`、`observe`。
- 导航行为：`tag_location`、`navigate_with_text`、`stop_navigation`、`begin_exploration`、`end_exploration`、`start_patrol`、`stop_patrol`。
- 感知与交互：`look_out_for`、`stop_looking_out`、`follow_person`、`stop_following`、`speak`。

官方清单仍保留上述 21 个工具这一事实，但本项目只将其中 14 个非停止工具纳入下层、包装器和固定 Agent 的版本化公开契约，并与 7 个自研工具共同形成 21 工具契约。官方 `stop_navigation`、`end_exploration`、`stop_patrol` 和 `stop_looking_out` 仍由底层 `stop_all` 在进程内调用，但不再作为独立 MCP 工具公开。`speak` 被明确排除，因为官方 `SpeakSkill` 在模块启动阶段初始化 OpenAI TTS；项目的最终用户语音由回复接收端处理，底层不应因此要求 OpenAI 凭据。`follow_person` 和 `stop_following` 也被明确排除，底层不再组合 `PersonFollowSkillContainer`，因为该链路要求本项目不支持的 `ALIBABA_API_KEY`；包装器和固定 Agent 也不得重新声明这两个工具。`return_to_user_and_greet` 使用预先标记且名称精确为“用户身边”的固定地图点，在导航成功后静止 1 秒再复用官方 `Hello` 动作；它不是人员跟随。`start_stroll` 是自研扩展，不是官方预制能力：它复用官方 Wavefront Frontier 检测和导航，但在局部未知分支中随机选择一条，退休其他分支，并拒绝回头补覆盖；它的内部停止方法同样由 `stop_all` 编排。官方 `start_patrol` 使用已建图区域的 coverage router；官方 `begin_exploration` 会持续寻找 Frontier 以扩展覆盖，两者都不等同于这种有意遗漏区域的人类式散步。

## 已知边界

- 当前实机实现只装配 DIMOS 官方文档中的 Unitree Go2 连接。其他机器狗必须提供一个消费 `cmd_vel: Twist` 的 DIMOS 模块后再接入。
- `motion_status` 仅是 MCP 扩展的本地命令状态，不能替代机器狗遥测、急停或碰撞检测。
- DIMOS 当前 MCP 服务对客户端断连不等同于运动取消。初版用 2 秒最大持续时间限制风险；该限制现已按“完全信任用户指令”的项目决策移除，需要提前停止时调用 `stop_all`。
