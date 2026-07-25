# DIMOS 机器狗 MCP 框架使用与开发指南

本文件面向框架使用者和集成开发者，说明如何把上层 Agent/MCP Host 接入本框架、如何把本框架接入下层机器狗，以及如何在既有边界内扩展。

开始使用前，先阅读根目录的 [CONTEXT.md](CONTEXT.md)。它定义了安全边界和不可违反的架构约束；本文件定义安装、接入和开发流程。

输入端系统向 Agent 输入用户文本、并由回复接收端接收最终回复时，遵循
[Agent 输入与最终回复 Webhook 对接指南](docs/agent-input-webhook-integration.md)。
输入端负责确认每个 Webhook 都是完整真实请求；本框架不处理麦克风或语音识别。
Stage 2 product 模式中，Pi session 没有 MCP 或 coding tools，只把文本编译为
`go_to_place`、`mark_place`、有限 `visit_route` 或严格 `follow_person` 参数。
地点任务由 Gateway 从 `instruction_id` 生成稳定 task ID，持久化
instruction/task binding 和路线进度，调用现有 `MissionExecutor` 并轮询
`get_task_status`；accepted 或 navigating 不会被当作完成。标点复用现有
`get_robot_summary + SemanticWorld`，路线复用多个有限 `go_to_place`，没有新增
导航框架。`follow_person` 是 DimOS 官方后台技能的快速入口，不创建 canonical
task binding。精确停止、任务控制、状态和小步方向输入绕过模型走同一持久化优先
路径。Stage 1 的五工具 validation profile 仍作为人工控制回归保留。不要把 MCP
端点当作文本输入端点。

## 架构与职责

~~~mermaid
flowchart LR
    I["输入端"] -->|HTTP Webhook :8080| A["Pi 参数编译器<br/>无工具"]
    A --> T["Gateway TaskSpec + SQLite binding"]
    T -->|HTTP MCP :9991/mcp| W["dimos-mcp-wrapper"]
    W -->|"受信任网络上的一次 tools/call"| D["独立 dimos-mcp :9990/mcp"]
    D -->|DIMOS cmd_vel: Twist| C{"下层连接"}
    C -->|默认| R["dry-run"]
    C -->|显式启用| G["Unitree Go2"]
    W -. 生命周期事件 .-> K["可选 hook"]
    A -->|最终回复 Webhook| O["回复接收端"]
~~~

| 层级 | 组件 | 使用者应负责的事项 |
| --- | --- | --- |
| 上层 | MCP Host / Agent | 需要 hook 或 Agent Gateway 时连接包装器；独立 MCP Host 也可直接连接底层。 |
| Agent Webhook 层 | `components/agent-framework/agent-webhook-gateway` | 持久化用户文本和 instruction/task binding；编译参数、提交一次任务、等待终态并投递回复。 |
| 转发层 | `components/agent-framework/dimos-mcp-wrapper` | 原样、单次转发工具调用；可发出非阻塞 hook 事件。 |
| 下层 | `components/dimos-mcp` | 唯一产品 Runtime；组合官方 Go2、一个 `SemanticWorld`、一个 `MissionExecutor`、一个 navigator 和一个 MCP Server。 |
| 硬件层 | DIMOS 连接与导航模块 | dry-run 只模拟定时运动；显式 Go2 模式消费传感器与 `cmd_vel` 并执行官方导航。 |

Agent Webhook Gateway 不应直接连接底层机器狗 MCP，否则会绕过包装器的统一转发点和 hook 扩展点。明确不需要 hook 的独立 MCP Host 可以直接连接 `components/dimos-mcp` 暴露的网络 endpoint。

## 前置条件与安全要求

- 使用 Python 3.10 至 3.12；推荐 Python 3.12。DIMOS 0.0.14b1 不支持 Python 3.13 及以上。
- 默认 MCP 安装精确版本的 `dimos[web]` 和 `langchain-core`。`web` extra 提供 FastAPI/Uvicorn；`langchain-core` 是 DIMOS 0.0.14b1 生成 `@skill` 参数 schema 时实际导入的运行依赖。该组合不会额外启用完整的 `dimos[base]` 聚合 extra。
- 真实 Go2 使用显式的 `dimos[cuda,misc,perception,unitree]` 可选依赖，并固定
  `onnxruntime==1.26.0` 与 `onnxruntime-gpu[cuda,cudnn]==1.26.0`。该版本使用
  CUDA 12，与 DIMOS `0.0.14b1` 固定的 `cupy-cuda12x` 一致；不要升级到默认使用
  CUDA 13 的 ONNX Runtime 1.27。
- 默认运行模式是 dry-run：不会连接、站立或移动真实机器狗。
- 启用真实 Go2 前，必须完成场地隔离、独立急停、低延迟网络和厂商/DIMOS 网络预检。
- Go2 模式会在官方连接、站立与平衡初始化完成后显式启用固件 joystick 输入。锁定版 DiMOS wheel 未公开 `switch_joystick` RPC，因此入口通过现有 `GO2Connection.publish_request` 向 Sport endpoint 发送 API `1027` / `data=true`。响应状态码不为 `0`、结构无效或调用抛出异常时，下层进程停止全部模块并启动失败；dry-run 不执行该调用。
- 当前机器狗 MCP 服务没有内建访问控制。不要把 `:9990/mcp` 或 `:9991/mcp` 暴露到不受信任网络；跨主机部署时应由可信网络和外部访问控制保护。普通 instruction/reply Webhook 同样没有认证。

## 接入下层机器狗

### 1. 在底层机器安装独立 MCP

以下示例假设仓库绝对路径保存在 `REPOSITORY_PATH`。

PowerShell：

~~~powershell
$repositoryPath = "C:/absolute/path/to/pi-hackason"
uv venv --python 3.12
.\.venv\Scripts\Activate.ps1
uv pip install -e "$repositoryPath/components/dimos-mcp"
~~~

POSIX shell：

~~~bash
repository_path="/absolute/path/to/pi-hackason"
uv venv --python 3.12
source .venv/bin/activate
uv pip install -e "$repository_path/components/dimos-mcp"
~~~

### 2. 启动下层机器狗 MCP

先启动下层服务。未设置模式时，它以 dry-run 运行并监听默认地址 `http://127.0.0.1:9990/mcp`。

~~~bash
dimos-dog-mcp
~~~

要让另一台上层机器访问，底层机器必须显式监听网络 interface：

~~~powershell
$env:DIMOS_DOG_MCP_HOST = "0.0.0.0"
$env:DIMOS_DOG_MCP_PORT = "9990"
dimos-dog-mcp
~~~

假设底层机器 IP 为 `192.168.66.160`，上层调用 URL 是 `http://192.168.66.160:9990/mcp`。`0.0.0.0` 只用于监听，不能作为客户端 URL。底层主机防火墙应只允许上层机器或受信任网段访问 TCP 9990。

下层工具由 `DIMOS_DOG_MCP_TOOL_PROFILE` 决定。默认 `product` 精确公开 20 个
高层任务、官方地点导航、停止和只读工具：

```text
start_task pause_task resume_task cancel_task get_task_status
list_semantic_places confirm_semantic_place tag_location navigate_with_text
stop_navigation stop_all motion_status get_robot_summary
server_status list_modules current_time get_battery_soc observe follow_person
relative_move
```

显式 `maintenance` profile 才公开原有人工底层控制、导航、探索、巡逻和 sport
工具；它的版本化 allowlist 包含上述七个任务工具，共 32 个。product 中唯一保留
的运动原语是官方 `relative_move`，供 Gateway 的精确小步输入使用；模型没有该工具
权限。实际 `tools/list`
仍以当前 Blueprint 已组合的模块为准。以下基础控制表只适用于 maintenance：

Go2 product 启动至少设置：

```bash
export DIMOS_DOG_MCP_MODE=go2
export DIMOS_DOG_MCP_TOOL_PROFILE=product
export DIMOS_SEMANTIC_WORLD_PATH="$HOME/.dimos/go2-studio/semantic-world.json"
export DIMOS_MAP_ID=<CURRENT_MAP_ID>
export DIMOS_MAP_VERSION=<CURRENT_MAP_VERSION>
export DIMOS_QWEN_VL_BASE_URL=https://api.siliconflow.cn/v1
export DIMOS_QWEN_VL_MODEL=Qwen/Qwen3-VL-8B-Instruct
export DIMOS_QWEN_VL_API_KEY=<PRIVATE_KEY>
```

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `move_forward` | `speed_mps`、`duration_s` | 按给定时长前进，结束时发布零速度。 |
| `move_backward` | `speed_mps`、`duration_s` | 按给定时长后退，结束时发布零速度。 |
| `stop_all` | 无 | 尝试停止 canonical mission、定时速度、定点导航、探索、巡逻、散步和官方人员跟随；无论中间项是否失败，最后都尝试发布零速度。 |
| `motion_status` | 无 | 返回本地命令执行状态，不是机器狗遥测。 |

运动速度和持续时间接受用户提供的任意正有限数值，不设置硬编码范围上限或下限。默认值分别为 0.10 m/s 和 1.0 秒；重叠的运动请求仍会被拒绝。

maintenance 中 17 个受支持的官方工具如下。`server_status`、`list_modules`、
`agent_send` 来自官方 `McpServer`；其余硬件或机器人能力只在 Go2 模式真实执行：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `server_status` | 无 | 返回下层进程、模块和工具状态。 |
| `list_modules` | 无 | 列出部署模块和各模块工具。 |
| `agent_send` | `message` | 官方 `McpServer` 将消息发布到下层 `/human_input` 传输；本独立底层不运行 DiMOS LLM Agent，因此默认没有对话消费者。 |
| `relative_move` | `forward=0`、`left=0`、`degrees=0` | 按机器人当前坐标系执行官方相对位移与旋转。 |
| `wait` | `seconds` | 在下层官方工具容器中等待指定秒数。 |
| `current_time` | 无 | 返回下层当前时间。 |
| `execute_sport_command` | `command_name` | 执行官方 Unitree 命名运动指令。 |
| `get_battery_soc` | 无 | 读取 Go2 电池剩余百分比。 |
| `observe` | 无 | 获取 Go2 当前相机观察。 |
| `follow_person` | `query` | 用 Qwen VL 在当前画面初次定位人物，再由官方 EdgeTAM + `VisualServoing2D` 本地持续跟随。 |
| `stop_following` | 无 | 停止官方人员跟随；product 用户统一调用 `stop_all`，不直接公开此专项停止。 |
| `tag_location` | `location_name` | 将当前地图位置保存为具名地点。 |
| `navigate_with_text` | `query` | 解析自然语言目的地，并通过 DIMOS `ReplanningAStarPlanner` 导航。 |
| `stop_navigation` | 无 | 取消当前官方导航目标；不停止其他活动。 |
| `begin_exploration` | 无 | 启动 DIMOS Wavefront Frontier 未知区域探索。 |
| `start_patrol` | 无 | 在已经建图的区域按官方覆盖路由启动自主巡逻。 |
| `look_out_for` | `description_of_things`、可选 `then` | 持续视觉查找目标；无 `then` 时通过 MCP 工具流通知上层，带 `then` 时经本机 MCP 调用指定的公开工具。 |
另一个自研工具用于人类式散步：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `start_stroll` | 无 | 使用官方 Frontier 检测和导航，在每个局部未知分支中随机选择一条并放弃其他分支；保持方向惯性，不回头补覆盖。 |
| `return_to_user_and_greet` | 无 | 导航到实际名称精确为“用户身边”的预先标点，确认到达后静止 1 秒，再执行官方 Unitree `Hello` 问候动作。 |

`start_stroll` 不等于官方 `start_patrol`。巡逻只在已经建图的区域按覆盖路线来回巡视；散步面向未知道路，故意遗漏未选分支，并在没有顺向候选时结束。它也不等于 `begin_exploration`，因为它不追求完成地图覆盖。

`return_to_start` 无参数：它导航回本次下层进程捕获的第一帧有效里程计位置，20 厘米内直接报告已在起点。它不是官方工具，也不依赖手工 `tag_location`。

调用 `return_to_user_and_greet` 前，先让机器狗位于用户希望它返回的位置，并调用 `tag_location(location_name="用户身边")`。该工具不是实时人员跟随：它拒绝语义检索返回的其他近似标点，导航未被接受、取消、失败或在 100 秒内未完成时不会执行问候；只有导航报告成功后才开始硬性的 1 秒静止窗口。返回 `status=completed` 表示导航终态和 `Hello` 命令提交都成功，不等于独立遥测已经验证完整物理动作。

dry-run 与 Go2 使用相同 profile。dry-run product 可执行无硬件任务 replay；
replay navigator 不发布真实运动。maintenance 的硬件能力在 dry-run 返回明确
`required_mode=go2` 错误。`stop_all` 会先取消 canonical mission，再继续逐项停止
底层活动。product 公开 `follow_person`，但不公开 `speak`、`stop_following`
或除官方 `stop_navigation` 外的其他专项停止工具。

### 3. 启用真实 Unitree Go2（可选）

只有在完成安全检查后，才在启动下层服务前显式设置 Go2 模式：

~~~powershell
$env:ROBOT_IP = "机器狗 IP"
$env:DIMOS_DOG_MCP_MODE = "go2"
uv pip install -e "$repositoryPath/components/dimos-mcp[go2]"
uv pip install --reinstall --no-deps "onnxruntime-gpu==1.26.0"
dimos-dog-mcp
~~~

Stage 2 的 Go2 模式组合 DiMOS 官方轻量 `unitree_go2` Blueprint、
`SpatialMemory(new_memory=false)`、`NavigationSkillContainer` 和
`UnitreeSkillContainer`，并恢复一个官方 `PersonFollowSkillContainer`；再保留
一个持久化 `SemanticWorld`、一个 canonical
`MissionExecutor` 和自研任务/状态模块。它仍只有一个 `GO2Connection`、一个
navigator 和一个 MCP Server，不加载 `PerceiveLoopSkill` 或第二个 Agent。
官方 `tag_location`、`navigate_with_text`、`stop_navigation` 已直接进入 product
工具面；`navigate_with_text` 先查具名地点，再按官方实现使用当前图像/语义地图回退。
本项目没有为此另建视觉或 Planner 框架。

官方人员跟随只在启动时调用一次 Qwen VL，随后由 EdgeTAM 在本地以 20Hz 跟踪。
Agent 的“跟着我”固定描述为启动画面中央的人。该官方技能直接做视觉伺服并明确
假设路径清空：它不经过 A*、不做障碍物避让、不自动重识别丢失目标，也不产生
canonical task 终态。不要把它用于杂物或人流环境，真机首次验收只做清空路径上的
短距离跟随与停止。
当前地图必须显式配置 `DIMOS_MAP_ID`、`DIMOS_MAP_VERSION` 和
`DIMOS_SEMANTIC_WORLD_PATH`；还必须让 `DIMOS_PREMAP_FILE` 指向已存在的
`.pc2.lcm` 预建图。缺失时在模块启动前失败。确认地点时，Runtime 把当前
`world` 位姿转换并持久化到稳定 `map` 帧；导航时再转换回当前会话的 `world`
帧。重定位尚未产生有效变换时，地点确认和解析均失败，不会复用旧里程计坐标。
官方模块完成启动后，入口仍会调用锁定版 `GO2Connection.publish_request` 发送
`SwitchJoystick`（API `1027`，`data=true`）。响应失败会停止 coordinator；
响应成功也只证明固件接受输入模式，不是底盘移动或到达证据。

Stage 2 真机验收使用同包安装的 `dimos-stage2-audit`。`preflight` 是只读命令，
会检查唯一 product Runtime、新鲜里程计、重定位 readiness、空闲 canonical task
和两个语义地点；失败时不会提交任务。`trip` 每次只提交一个稳定 task ID，不重试
运动工具，并把终态、稳定 map 坐标和到达误差保存到
`~/.dimos/go2-stage2/evidence/`。`cancel-check` 独立证明同一 task ID 最终为
`cancelled` 且 `navigation_idle=true`。真实 trip/cancel-check 必须显式传入
本轮清场确认，完整命令见组件 README。验收器的 MCP 证据不能代替 Agent、Gateway
与 Studio 的跨界面 task ID 对照。

若要接入非 Go2 设备，应在下层扩展中组合该设备对应的 DIMOS 连接模块，并让它消费同名、同类型的 `cmd_vel: Twist` 输入。仍须保留下层的参数校验、动作串行化和零速度停止机制；不要将这些安全逻辑移动到包装器。

### 4. 使用本机 Python GUI（可选）

`dimos-dog-gui` 是一个独立 MCP Host，不绕过下层服务，也不直接使用 Go2 SDK。它默认连接 `http://127.0.0.1:9990/mcp`，界面可修改为另一个受信任 endpoint。输入速度（m/s）和持续时间（s）后，前进和后退按钮各发送一次同名 `tools/call`；“全部停止”按钮只发送一次 `stop_all`，不自动重试。

在 WSLg 或其他可显示 Tkinter 窗口的 Linux 图形会话中，使用已安装 `dimos-dog-mcp` 的 Python 环境运行：

~~~bash
dimos-dog-gui
~~~

若 Ubuntu 缺少 Tkinter，安装 `python3-tk` 后重试。界面的“估算距离”仅为速度乘以时间；它不读取里程计，也不证明机器狗精确移动或到达该距离。GUI 不存储机器人 IP、AES 密钥或运行模式，真机/干跑选择仍由下层 MCP 进程决定。

在 WSL 进行本机真机控制时，可使用
`components/dimos-mcp/scripts/run-go2-mcp.sh` 代替手工导出变量。该脚本只读取 WSL
家目录中的 `$HOME/.config/dimos-dog-mcp/go2.env`，要求该文件权限为 `600`；随后将
虚拟环境中 NVIDIA CUDA 12/cuDNN wheel 的动态库目录加入当前进程环境，并在连接 Go2
前验证 ONNX Runtime 的 `CUDAExecutionProvider` 可用。预检通过后才使用 WSL
虚拟环境中的 `dimos-dog-mcp` 启动真实 Go2 服务。脚本会把 `ROBOT_IP` 同时加入
`NO_PROXY` 和 `no_proxy`，避免系统 HTTP 代理截获局域网握手。`data2=2` 固件不需要
AES key；仅 `data2=3` 握手需要把 `UNITREE_AES_128_KEY` 放入私有配置。官方人员
跟随还要求私有配置包含 `DIMOS_QWEN_VL_API_KEY`；base URL 和 model ID 可使用模板
默认值。密钥不能写入仓库；模板为
`components/dimos-mcp/config/go2.env.example`。服务端终端需保持
运行，GUI 在另一 WSL 终端通过 `dimos-dog-gui` 启动。

模板现在默认 `VIEWER=rerun`、`RERUN_OPEN=native`。同一个 Go2 Runtime 会把
官方 planner 的 `path` 直接显示为规划路线，并通过只读
`SemanticVisualizationAdapter` 显示：

- `semantic_place_markers`：canonical `SemanticWorld` 中当前 map/version 的命名地点；
- `current_target_markers`：canonical `MissionExecutor` 当前非终态目的地；
- `actual_path_visualization`：由 `RobotSummary` 已采样 odometry 生成的蓝色实际路线。

Adapter 不公开 MCP 工具、不连接硬件、不下发导航，也不重新采样轨迹。Studio 只从
Wrapper/Gateway 读取状态，并负责地点命名、地点/有限路线选择和任务提交；其本地文件
只保存 instruction/reply 幂等证据，不保存或恢复机器人任务状态。Studio 不再自绘
第二份路线，也不挂载/轮询旧 `/api/mission/*`；控制台 E-STOP 直接调用
`POST /api/stage2/stop-all`，后端仅转发 Wrapper 的 canonical `stop_all`。若私有
`go2.env` 仍显式配置 `VIEWER=none`，必须改为 `VIEWER=rerun` 才会启动官方
`dimos-viewer`。

## 接入转发包装器

需要 hook 或 Agent Webhook Gateway 时，包装器是上层应用应连接的 MCP 服务。它默认监听 `http://127.0.0.1:9991/mcp`。同机部署时默认将请求发往 `http://127.0.0.1:9990/mcp`；跨机器部署时必须指向底层机器地址。

在上层机器安装并启动包装器：

~~~powershell
$repositoryPath = "C:/absolute/path/to/pi-hackason"
uv venv --python 3.12
.\.venv\Scripts\Activate.ps1
uv pip install -e "$repositoryPath/components/agent-framework/dimos-mcp-wrapper"
dimos-mcp-wrapper
~~~

POSIX：

~~~bash
repository_path="/absolute/path/to/pi-hackason"
uv venv --python 3.12
source .venv/bin/activate
uv pip install -e "$repository_path/components/agent-framework/dimos-mcp-wrapper"
dimos-mcp-wrapper
~~~

跨主机或使用非默认端口时，在启动包装器前配置：

~~~powershell
$env:DIMOS_MCP_WRAPPER_UPSTREAM_URL = "http://192.168.66.160:9990/mcp"
$env:DIMOS_MCP_WRAPPER_PORT = "9991"
$env:DIMOS_MCP_WRAPPER_TIMEOUT_S = "120"
dimos-mcp-wrapper
~~~

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DIMOS_MCP_WRAPPER_UPSTREAM_URL` | `http://127.0.0.1:9990/mcp` | 下层 MCP 的绝对 HTTP(S) URL，必须包含路径，不能带 query 或 fragment。 |
| `DIMOS_MCP_WRAPPER_PORT` | `9991` | 包装器监听端口。 |
| `DIMOS_MCP_WRAPPER_TIMEOUT_S` | `120.0` | 单次下层请求的超时秒数；默认值覆盖最长 100 秒导航、1 秒静止窗口和调用开销。 |
| `DIMOS_MCP_WRAPPER_PROFILE` | `product` | `product` 暴露任务生命周期、地点、状态、停止和受控 `relative_move`；`validation` 只暴露 `relative_move`、`return_to_start`、`motion_status`、`get_robot_summary`、`stop_all`。 |

包装器只会对每个上层调用发送一次标准 JSON-RPC `tools/call` 请求。网络错误、HTTP 错误或下层 MCP 错误会返回给上层；它不会自动重试任何运动命令。

包装器 `tools/list` 由显式 profile 决定。默认 `product` profile 精确暴露
`start_task/pause_task/resume_task/cancel_task/get_task_status/`
`list_semantic_places/confirm_semantic_place`、官方
`tag_location/navigate_with_text/stop_navigation`、官方 `follow_person`、
`relative_move`、`stop_all` 和只读状态工具；
Stage 1 的 `validation` profile 精确暴露五个验收工具。每个公开工具都经同一个
`ForwardingService` 单次转发，因此均支持同时配置 `before_call`、
`after_success`、`after_error` 和 `finally` hook。`stop_all` 在包装器中仍只是
一个同名、无参数的单次转发；它不会在包装器内拆成多个上游调用。

底层可预期的参数或运动互斥错误使用 `{"status":"error","error":"..."}` 文本 envelope。包装器也识别 DIMOS 对意外异常生成的 `Error running tool '...'` 文本，并将两者都转为上层失败及 `after_error` hook，而不是 `after_success`；结构化错误的完整上游文本会保留在错误消息中，因此 `stop_all` 的 `failed_components` 和逐项 `results` 不会在包装层丢失。

## 接入上层 Agent 或 MCP Host

需要包装器 hook 时，将 MCP Host 指向包装器的 HTTP MCP endpoint：

~~~text
http://包装器主机:9991/mcp
~~~

以 Claude Code 为例：

~~~bash
claude mcp add --transport http --scope project dimos-dog-wrapper http://127.0.0.1:9991/mcp
~~~

其他支持 HTTP MCP 的 Host 也应使用同一端点。默认 product Host 发现到的任务工具
与下层一致：

| 上层调用 | 参数 | 转发结果 |
| --- | --- | --- |
| `start_task` | `task_json` | 单次原样提交 canonical TaskSpec；不自动重试。 |
| `pause_task` / `resume_task` / `cancel_task` | `task_id` | 原样转发稳定 task ID。 |
| `get_task_status` | 无 | 返回唯一 `MissionExecutor` 的任务快照。 |
| `list_semantic_places` | 无 | 返回当前 map ID/version 下的 confirmed places。 |
| `tag_location` | `location_name` | 单次转发官方当前位置标记。 |
| `navigate_with_text` | `query` | 单次转发官方文本导航。 |
| `stop_navigation` | 无 | 单次取消官方导航目标；完整停止仍使用 `stop_all`。 |
| `follow_person` | `query` | 单次启动官方后台人员跟随；不是 canonical task，停止使用 `stop_all`。 |
| `relative_move` | `forward`、`left`、`degrees` | 单次转发官方相对位移。product Gateway 只提交固定 0.2 m 平移或 15° 旋转，模型不能选择参数。 |
| `stop_all` | 无 | 单次、立即传给下层；由下层统一停止所有活动，不等待或重试 hook。 |
| `motion_status` | 无 | 原样返回下层的本地运动状态。 |
| `get_robot_summary` | 无 | 返回 actual odometry path 和新鲜度。 |
| `server_status` / `list_modules` / `current_time` / `get_battery_soc` / `observe` | 无 | 单次转发只读状态或观察。 |

product 建议顺序：

1. 先用 `list_semantic_places` 确认地点属于当前 map ID/version。
2. 提交一次 `start_task` 后只轮询 `get_task_status`；不得因网络不确定自动重提。
3. accepted、queued、navigating 或 recovering 都不等于完成。
4. 只有同一 task ID 进入 terminal 且 `active=false` 才形成最终结果。
5. 需要提前结束时优先 `cancel_task(task_id)`；无法确定活动 task ID 时调用
   `stop_all`。断开 MCP 客户端不等于停止。

不需要包装器 hook 的独立 MCP Host 也可以直接连接底层机器的 `http://<底层机器IP>:9990/mcp`。Agent Webhook Gateway 当前仍按既定架构连接包装器，不直接连接底层。

## 接入 Agent 输入与最终回复 Webhook

该服务需要 Node.js 22.19 或更高版本。`product` runtime 显式使用
OpenAI-compatible 模型配置，默认是 SiliconFlow `zai-org/GLM-5.2`；它不再继承
用户当前 Pi 模型。Pi session 没有 MCP/coding tools，只输出严格任务参数；
`validation` runtime 是 Stage 1 的确定性 Agent，不需要模型 API。先启动
机器狗 MCP 与包装器，再安装并构建网关：

~~~powershell
Set-Location "C:/absolute/path/to/pi-hackason/components/agent-framework/agent-webhook-gateway"
npm ci --ignore-scripts
npm run build
node dist/cli.js
~~~

本机默认不需要额外回复接收器：Gateway 会把已持久化的回复回调到自身
`/v1/ui-replies`，前台再只读查询同一份状态。需要推送到眼镜或其他外部系统时，
才显式设置 `AGENT_WEBHOOK_REPLY_URL`。

macOS 上，在唯一 Product Runtime 已经启动后，也可以双击：

~~~text
agent/启动 Go2 Agent 控制台.command
~~~

该脚本只 attach/start Wrapper 与 Gateway，不会自行连接、站立或移动机器狗。唯一
前台地址为：

~~~text
http://127.0.0.1:8080/
~~~

左侧地图来自同一 Runtime 的官方 Rerun web viewer `:9878`；右侧文本仍进入下面
相同的 instruction 契约。Product Runtime 使用 `VIEWER=rerun`、
`RERUN_OPEN=none`、`RERUN_WEB=true`，不会自动打开第二个 Viewer 页面。

输入端向以下端点提交契约中的 `instruction_id` 和 `text`：

~~~text
POST http://网关主机:8080/v1/instructions
~~~

前台只读轮询：

~~~text
GET http://网关主机:8080/v1/instructions/<instruction_id>
~~~

它返回既有 inbox 状态、canonical task 摘要和最终 outbox reply；轮询不会重跑
Agent、重新提交任务或调用 MCP。

网关使用 SQLite 持久化 inbox、`instruction_task_bindings` 和 outbox。相同 ID、
相同文本的重投返回 `202`，但只编译一次；单地点只创建一个 task ID，有限路线为
每一段创建不同的确定性 task ID，且每段最多提交一次。同一 ID 对应不同文本返回
`409`。accepted 或 active task 不产生最终回复。进程恢复时，
submitted/monitoring binding 只恢复 `get_task_status`；
尚未提交的 compiled binding 以同一确定性 task ID 恢复提交。有限路线只继续当前段
及剩余段，不重跑已完成段。没有 binding 的旧 `processing` 指令 fail-closed。
回复回调失败只重投同一 outbox 事件。

当前 product 文本能力：

| 输入类型 | 现有链路 |
| --- | --- |
| “把这里标记为会场门口” | 模型只编译名称；Gateway 要求 fresh odometry 和 ready relocalization，再把稳定位姿写入现有 `SemanticWorld`。 |
| “去会场门口” | 生成一个现有 `go_to_place` 任务，经 `MissionExecutor` 导航并等待 terminal + inactive。 |
| “在客厅和门口之间往返两次” | 先校验当前 map/version 的地点与别名，再按有限路线逐段复用 `go_to_place`；不创建第二套路线执行器。 |
| “暂停” / “继续” / “取消任务” | 不经过模型，使用当前持久化 task ID 调用现有 lifecycle tool。 |
| “状态/查询状态/现在什么状态” | 不经过模型，聚合现有任务、里程计和地点状态。 |
| “前进/往前走/向前移动”等前后左右、转向口语 | 不经过模型；只做全句锚定匹配，先 `stop_all`，再调用固定 0.2 m / 15° 的 `relative_move`。这会取消当前自主任务，不自动恢复。 |
| “停/停下来/停止/马上停/别动” / `stop` | 不经过模型，单次调用 `stop_all`；否定句和复合句不会误命中。 |

方向口语不会让模型选择速度或距离；未指定参数时统一使用 0.2 m / 15°，带距离或
多个动作的复合句继续进入高层分析且不得直接触发小步动作。MCP 不可用、超时、
协议不一致和 Runtime 拒绝会显示不同的脱敏提示；超时不得自动重发。工具成功回复
仍不代表真实位移已经由 fresh odometry 证明。输入端可以是语音识别、戒指或其他
设备，但本阶段只定义并验证统一文本契约，不包含 ASR、戒指、眼镜 SDK 或设备连接。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENT_WEBHOOK_REPLY_URL` | `http://127.0.0.1:<Gateway端口>/v1/ui-replies` | 可选外部回复回调；省略时使用本地 Console。 |
| `AGENT_WEBHOOK_MAP_URL` | `http://127.0.0.1:9878/` | 同一 Product Runtime 的官方只读 Rerun web viewer。 |
| `AGENT_WEBHOOK_HOST` / `AGENT_WEBHOOK_PORT` | `127.0.0.1` / `8080` | 输入网关监听地址。 |
| `AGENT_WEBHOOK_DATABASE_PATH` | `<cwd>/data/agent-webhook.sqlite` | inbox/outbox SQLite 文件。 |
| `AGENT_WEBHOOK_MCP_URL` | `http://127.0.0.1:9991/mcp` | 包装器 MCP URL。 |
| `AGENT_WEBHOOK_MCP_TIMEOUT_MS` | `120000` | 单次 MCP 请求超时；`start_task` 不自动重试。 |
| `AGENT_WEBHOOK_TASK_POLL_INTERVAL_MS` | `500` | `get_task_status` 轮询间隔。 |
| `AGENT_WEBHOOK_TASK_TIMEOUT_MS` | `330000` | 等待 terminal + inactive 的总时限。 |
| `AGENT_WEBHOOK_AGENT_DIR` | `~/.pi/agent` | Pi 模型、认证和设置目录。 |
| `AGENT_WEBHOOK_SESSION_DIR` | `<cwd>/data/agent-session` | 固定 Agent 会话目录。 |
| `AGENT_WEBHOOK_DEFAULT_SPEED_MPS` | `0.1` | 仅 Stage 1 validation Pi 运行时使用；Stage 2 product 参数编译器忽略。 |
| `AGENT_WEBHOOK_TOOL_PROFILE` | `product` | `product` 或 `validation`；必须与 Wrapper profile 匹配。 |
| `AGENT_WEBHOOK_RUNTIME` | 按 profile | product 默认 `pi`；validation 默认无模型 `validation`。 |
| `AGENT_WEBHOOK_MODEL_PROVIDER` | `siliconflow` | product 文本模型 provider ID。 |
| `AGENT_WEBHOOK_MODEL_ID` | `zai-org/GLM-5.2` | 主 Agent 文本模型，不是视觉识别模型。 |
| `AGENT_WEBHOOK_MODEL_BASE_URL` | `https://api.siliconflow.cn/v1` | OpenAI-compatible API 根 URL。 |
| `AGENT_WEBHOOK_MODEL_API_KEY` | macOS Keychain | 可选环境变量覆盖；不得提交到 Git。 |

macOS 默认从 `agent-webhook-gateway-siliconflow` Keychain service 读取 API key。
首次配置：

```bash
read -r -s siliconflow_key
security add-generic-password -U \
  -a siliconflow \
  -s agent-webhook-gateway-siliconflow \
  -w "$siliconflow_key"
unset siliconflow_key
```

非 macOS 部署可在进程环境中设置 `AGENT_WEBHOOK_MODEL_API_KEY`。模型 provider、
ID 和 URL 只控制 product 的语言到 `TaskSpec` 参数编译，不控制 Stage 3 图像识别。

Stage 1 启动时同时设置：

```bash
export DIMOS_MCP_WRAPPER_PROFILE=validation
export AGENT_WEBHOOK_TOOL_PROFILE=validation
export AGENT_WEBHOOK_RUNTIME=validation
```

验证 Agent 只支持不超过 1 米的前进、回到起点、状态/actual path 查询和停止。它的
用途是证明 Agent → MCP → DimOS → Go2 的闭环，不替代后续语义任务 Agent。

其余超时和回复重投配置见 `components/agent-framework/agent-webhook-gateway/README.md`。HTTP 请求与回复 schema、停止口令规范化规则及下层开发者验收清单见 [Webhook 对接指南](docs/agent-input-webhook-integration.md)。

## 使用生命周期 hook

包装器会为每次转发投递四种事件：

- `before_call`
- `after_success`
- `after_error`
- `finally`

一个 hook 可以处理全部四种事件；也可以同时注册多个 hook。事件按 FIFO 顺序入队，但由独立后台线程最佳努力处理，因此 hook 不会阻塞 MCP 调用路径。

`before_call` 仅代表事件已入队，不保证 hook 已执行完成，也不是同步授权、拦截或命令改写点。hook 收到的是调用参数的隔离副本；hook 异常仅记录日志，不能改变下层请求、下层结果或下层错误。

示例：通过自定义启动入口接入审计 hook。

~~~python
from dimos_mcp_wrapper.blueprint import build_blueprint
from dimos_mcp_wrapper.hooks import McpCallEvent


class AuditHook:
    def handle(self, event: McpCallEvent) -> None:
        if event.phase == "before_call":
            print(f"queued: {event.call.tool_name}")
        elif event.phase == "after_success":
            print(f"succeeded: {event.call.tool_name}")
        elif event.phase == "after_error":
            print(f"failed: {event.call.tool_name}: {event.error}")
        elif event.phase == "finally":
            print(f"finished: {event.call.tool_name}")


from dimos.core.coordination.module_coordinator import ModuleCoordinator

ModuleCoordinator.build(build_blueprint(hooks=(AuditHook(),))).loop()
~~~

多个 hook 可按以下方式注册：

~~~python
ModuleCoordinator.build(build_blueprint(hooks=(AuditHook(), MetricsHook()))).loop()
~~~

如果未来确定“发送其他指令”的传输协议，应实现明确的 hook 适配器或独立下层适配器。不要提前增加假设性的 `send_instruction` 工具、网络协议或硬件 SDK，更不能将该逻辑做成会阻塞或重试运动调用的 hook。

## 在框架上开发

### 扩展下层能力

新增机器狗能力时，先在 `components/dimos-mcp` 完成能力本身：

1. 定义清晰的 MCP 工具名、参数、返回值和安全边界。
2. 在下层实现参数验证、并发/抢占策略、超时与安全停止；不要依赖上层 Agent 的提示词保证安全。
3. 为纯业务逻辑增加单元测试；在 Python 3.10 至 3.12 且已安装 DIMOS 的环境中，为 MCP 发现或集成行为增加测试。
4. 确认下层能够独立安全运行后，再把它公开给包装器。

### 将新能力暴露到包装器

包装器的职责是透明转发，不是第二个控制器。新增已确认的下层 MCP 工具时：

1. 在 `DogMcpTools` 中添加与下层完全同名、参数完全一致的方法。
2. 在 `McpForwardingSkill` 中添加同名 DIMOS `@skill` 方法。
3. 通过 `ForwardingService` 单次转发；不得改写参数、合成运动结果或自动重试。
4. 如需旁路行为，使用 `McpCallHook`；不得把 hook 用作同步权限判断或停止命令延迟器。
5. 更新本文档中的工具表、配置、接入步骤和扩展说明。若架构边界或安全不变量变化，也要更新 `CONTEXT.md`。

当前关键代码位置：

| 目的 | 位置 |
| --- | --- |
| 下层 DIMOS MCP 组合 | `components/dimos-mcp/src/dimos_dog_mcp/blueprint.py` |
| Go2 固件运动输入握手 | `components/dimos-mcp/src/dimos_dog_mcp/go2_locomotion.py` |
| 下层网络与运行模式配置 | `components/dimos-mcp/src/dimos_dog_mcp/config.py` |
| 下层运动状态机与安全边界 | `components/dimos-mcp/src/dimos_dog_mcp/motion_runtime.py` |
| 下层公开导航契约与 dry-run 行为 | `components/dimos-mcp/src/dimos_dog_mcp/navigation.py` |
| product/maintenance 版本化工具契约 | `components/dimos-mcp/src/dimos_dog_mcp/tool_contract.py` |
| Gateway TaskSpec 与稳定 task ID | `components/agent-framework/agent-webhook-gateway/src/task-contract.ts` |
| Gateway 任务终态监控 | `components/agent-framework/agent-webhook-gateway/src/task-monitor.ts` |
| Gateway 标点、路线和优先输入协调 | `components/agent-framework/agent-webhook-gateway/src/service.ts` |
| 回到用户标点并问候 | `components/dimos-mcp/src/dimos_dog_mcp/return_to_user.py` |
| 统一停止编排 | `components/dimos-mcp/src/dimos_dog_mcp/stop.py`、`components/dimos-mcp/src/dimos_dog_mcp/go2_stop.py` |
| 官方视觉回调的无模型 AgentSpec 适配 | `components/dimos-mcp/src/dimos_dog_mcp/agent_bridge.py` |
| 人类式散步分支策略与 Go2 技能 | `components/dimos-mcp/src/dimos_dog_mcp/stroll_policy.py`、`components/dimos-mcp/src/dimos_dog_mcp/stroll.py` |
| 下层 MCP 工具公开白名单 | `components/dimos-mcp/src/dimos_dog_mcp/server.py` |
| 包装器 MCP 组合 | `components/agent-framework/dimos-mcp-wrapper/src/dimos_mcp_wrapper/blueprint.py` |
| 单次转发与 hook 事件 | `components/agent-framework/dimos-mcp-wrapper/src/dimos_mcp_wrapper/forwarding.py` |
| hook 契约与后台投递 | `components/agent-framework/dimos-mcp-wrapper/src/dimos_mcp_wrapper/hooks.py` |

### 本地验证

两个集成都提供不依赖真实硬件的单元测试。分别在对应目录执行：

~~~powershell
Set-Location "C:/absolute/path/to/pi-hackason/components/dimos-mcp"
$env:PYTHONPATH = "$PWD/src"
python -m unittest discover -s tests -v
~~~

~~~powershell
Set-Location "C:/absolute/path/to/pi-hackason/components/agent-framework/dimos-mcp-wrapper"
$env:PYTHONPATH = "$PWD/src"
python -m unittest discover -s tests -v
~~~

包装器的 DIMOS 原生 `tools/list` 集成测试需要 Python 3.10 至 3.12 和已安装的 DIMOS；不兼容环境会跳过该测试。

要在不安装 DIMOS、不配置模型认证且不连接真实机器狗的环境中复现完整 Webhook → Agent → 包装器 → 底层 MCP → 回复回调链路，运行：

~~~powershell
Set-Location "C:/absolute/path/to/pi-hackason/components/agent-framework/agent-webhook-gateway"
npm ci --ignore-scripts
npm run demo:dry-run
~~~

该演示是 Stage 1 validation 回归：使用真实网关核心、临时 SQLite 和临时 HTTP
端口，替身化 validation Agent、Wrapper、底层 MCP 与回复接收端；它不会导入
DIMOS 或访问机器狗。命令会断言最终回调、`move_forward`/`stop_all` 各调用一次，
以及停止口令绕过忙碌 Agent。Stage 2 product task binding 由 Gateway focused
tests 单独覆盖。

## 常见问题

| 现象 | 排查方向 |
| --- | --- |
| 上层看不到工具 | 确认连接的是包装器 `:9991/mcp`，且包装器使用兼容 Python 正常启动。 |
| 包装器报告上游不可用 | 确认下层 `dimos-dog-mcp` 已启动，并检查 `DIMOS_MCP_WRAPPER_UPSTREAM_URL`。 |
| 调用成功但机器狗不动 | 先确认不是 dry-run，并确认当前进程启动日志位于显式 joystick 握手上线之后；再同时观察 `/nav_cmd_vel`、`/cmd_vel` 和 `/odom`，区分规划输出、速度转发与底盘反馈。 |
| 启动报错 `connection rejected joystick input enablement` | `SwitchJoystick` Sport 请求返回了非零状态码或无效响应；检查机器狗连接、当前运动模式和是否存在其他控制进程。进程已停止全部 DIMOS 模块，不能把该次启动视为可用。 |
| 启动报错 `ONNX Runtime CUDA 预检失败`、只列出 `CPUExecutionProvider` 或缺少 `libcudart.so` | 重新安装当前项目的 `[go2]` extra，然后执行 `uv pip install --reinstall --no-deps "onnxruntime-gpu==1.26.0"`，确保同名 Python 包最终来自 GPU wheel；不要升级到 1.27。预检失败发生在连接 Go2 之前。 |
| 官方硬件工具、返航问候或散步工具返回 `required_mode=go2` | 当前下层是 dry-run；完成实机预检并安装 `[go2]` extra 后显式启用 Go2 模式。 |
| `return_to_user_and_greet` 报告找不到精确标点 | 先在用户希望机器狗返回的位置调用 `tag_location(location_name="用户身边")`；近似名称或其他语义命中不会被接受。 |
| 首次启动加载视觉依赖 | 这是官方 `NavigationSkillContainer` 的图像/语义回退能力；具名地点仍优先走 `tag_location`/`navigate_with_text`，不要求自行训练模型。 |
| 启动时报 `SpatialMemorySpec` 缺失 | 当前环境没有正确安装或组合 DiMOS 官方 `SpatialMemory`；重新安装当前 `dimos-mcp[go2]`，不要另写一套地点存储替代它。 |
| 想用 hook 拦截危险动作 | 当前 hook 不是拦截器。应在下层实现明确、可测试的安全策略。 |
| 动作未按预期结束 | 立即调用 `stop_all`，检查返回的 `failed_components` 和逐项 `results`，再检查下层日志与独立急停状态。 |
| 导航、探索、巡逻或散步没有停止 | 不要调用已隐藏的专项停止方法；再次确认 `stop_all` 已到达底层，并按其逐项结果定位失败组件。 |

## 文档维护规则

`USAGE.md` 是面向框架使用者的公开使用契约。每次新增、删除或改变任何用户可见功能时，变更尚未完成，直到本文档同步更新。至少检查以下内容：

- 工具名称、参数、返回值和安全限制；
- 上下层端点、安装/启动步骤和环境变量；
- hook 生命周期与扩展方式；
- 下层硬件适配方式；
- 外部指令事件和 Agent 回复事件的 Webhook 契约；
- 测试或运行前置条件。

若变更同时影响术语、架构边界或安全不变量，还必须同步更新 `CONTEXT.md`。
