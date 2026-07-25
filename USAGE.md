# DIMOS 机器狗 MCP 框架使用与开发指南

本文件面向框架使用者和集成开发者，说明如何把上层 Agent/MCP Host 接入本框架、如何把本框架接入下层机器狗，以及如何在既有边界内扩展。

开始使用前，先阅读根目录的 [CONTEXT.md](CONTEXT.md)。它定义了安全边界和不可违反的架构约束；本文件定义安装、接入和开发流程。

输入端系统通过 [Agent 输入 Webhook 与 TTS MCP 对接指南](docs/agent-input-webhook-integration.md) 向固定 Agent 提交完整用户文本；本框架不处理麦克风或语音识别。`components/agent-framework/agent-webhook-gateway` 持久化输入并串行运行固定 Pi Agent 会话，不再提供出站回复 Webhook。硬件需要语音时，配置独立 TTS MCP，模型会主动调用 `speak(text)`；最终 assistant 文本只用于结束内部回合，不会自动发送。系统提示词要求模型对参数不明确的运动请求追问，并支持“速度加时长”“距离加时长”或仅说距离，方向可选且默认向前。固定 Agent 还拒绝 `Bound` 和所有空翻请求。Agent 可调用锁定版 DiMOS 的 14 个非停止官方 MCP 工具、7 个自研工具，以及可选的独立 TTS `speak`；后者不属于机器狗 MCP 的 21 工具契约。规范化后精确等于“停”或 `stop` 的口令绕过 Agent 并直接触发 `stop_all`，不会自动播报。`stop_all` 仍不等同于物理急停。

智能项圈 Health MCP v0.2 使用同一 Gateway 进程中的独立无鉴权入口和 durable health queue，详见 [Health MCP v0.2 消费端对接指南](docs/health-mcp-consumer-integration.md)。健康通知不会进入 Agent，也不会触发机器狗动作；项圈采集、事件生成和 Health MCP Server 仍由上游 `smart-neckband` 仓库负责，并运行在项圈上位机。地瓜派 Gateway 只通过内网 Streamable HTTP URL 连接，不会本地启动 Health MCP。

## 架构与职责

~~~mermaid
flowchart LR
    I["输入端"] -->|HTTP Webhook :8080| A["固定 Pi Agent"]
    A -->|HTTP MCP :9991/mcp| W["dimos-mcp-wrapper"]
    W -->|"受信任网络上的一次 tools/call"| D["独立 dimos-mcp :9990/mcp"]
    D -->|DIMOS cmd_vel: Twist| C{"下层连接"}
    C -->|默认| R["dry-run"]
    C -->|显式启用| G["Unitree Go2"]
    W -. 生命周期事件 .-> K["可选 hook"]
    A -->|"speak(text)"| O["独立 TTS MCP 与扬声器"]
    H["智能项圈"] -->|"POST /v1/health-events"| A
    A -->|"HTTP :8765/mcp"| M["项圈上位机 Health MCP"]
~~~

| 层级 | 组件 | 使用者应负责的事项 |
| --- | --- | --- |
| 上层 | MCP Host / Agent | 需要 hook 或 Agent Gateway 时连接包装器；独立 MCP Host 也可直接连接底层。 |
| Agent Webhook 层 | `components/agent-framework/agent-webhook-gateway` | 持久化用户文本、串行运行固定 Agent 会话并按模型决策调用独立 TTS MCP；在独立队列中校验和消费 Health 通知。 |
| 转发层 | `components/agent-framework/dimos-mcp-wrapper` | 原样、单次转发工具调用；可发出非阻塞 hook 事件。 |
| 下层 | `components/dimos-mcp` | 部署在机器狗侧主机，公开 14 个受支持的 DiMOS `0.0.14b1` 官方工具与 7 个自研工具；Go2 模式组合官方空间、导航和机器人技能及自研导航扩展，但不运行模型、Agent 循环、云端 TTS 或人员跟随。 |
| 硬件层 | DIMOS 连接与导航模块 | dry-run 只模拟定时运动；显式 Go2 模式消费传感器与 `cmd_vel` 并执行官方导航。 |

Agent Webhook Gateway 不应直接连接底层机器狗 MCP，否则会绕过包装器的统一转发点和 hook 扩展点。明确不需要 hook 的独立 MCP Host 可以直接连接 `components/dimos-mcp` 暴露的网络 endpoint。

## 前置条件与安全要求

- 使用 Python 3.10 至 3.12；推荐 Python 3.12。DIMOS 0.0.14b1 不支持 Python 3.13 及以上。
- 默认 MCP 安装精确版本的 `dimos[web]` 和 `langchain-core`。`web` extra 提供 FastAPI/Uvicorn；`langchain-core` 是 DIMOS 0.0.14b1 生成 `@skill` 参数 schema 时实际导入的运行依赖。该组合不会额外启用完整的 `dimos[base]` 聚合 extra。
- 真实 Go2 使用显式的 `dimos[cuda,unitree]` 可选依赖，并固定
  `onnxruntime==1.26.0` 与 `onnxruntime-gpu[cuda,cudnn]==1.26.0`。该版本使用
  CUDA 12，与 DIMOS `0.0.14b1` 固定的 `cupy-cuda12x` 一致；不要升级到默认使用
  CUDA 13 的 ONNX Runtime 1.27。
- 默认运行模式是 dry-run：不会连接、站立或移动真实机器狗。
- 启用真实 Go2 前，必须完成场地隔离、独立急停、低延迟网络和厂商/DIMOS 网络预检。
- Go2 模式会在官方连接、站立与平衡初始化完成后显式启用固件 joystick 输入。锁定版 DiMOS wheel 未公开 `switch_joystick` RPC，因此入口通过现有 `GO2Connection.publish_request` 向 Sport endpoint 发送 API `1027` / `data=true`。响应状态码不为 `0`、结构无效或调用抛出异常时，下层进程停止全部模块并启动失败；dry-run 不执行该调用。
- 当前机器狗 MCP、TTS MCP、instruction Webhook 和 Health Webhook 都没有内建访问控制。不要把这些端点暴露到不受信任网络；跨主机部署必须使用可信网络、主机防火墙和 TLS 终止保护。

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

下层公开固定的 21 个工具：DiMOS `0.0.14b1` 的 14 个非停止官方工具，加上本项目的 7 个自研工具。4 个基础控制工具在 dry-run 和 Go2 模式均可调用：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `move_forward` | `speed_mps`、`duration_s` | 按给定时长前进，结束时发布零速度。 |
| `move_backward` | `speed_mps`、`duration_s` | 按给定时长后退，结束时发布零速度。 |
| `stop_all` | 无 | 尝试停止定时速度、定点导航、探索、巡逻、散步和持续视觉查找；无论中间项是否失败，最后都尝试发布零速度。 |
| `motion_status` | 无 | 返回本地命令执行状态，不是机器狗遥测。 |

运动速度和持续时间接受用户提供的任意正有限数值，不设置硬编码范围上限或下限。默认值分别为 0.10 m/s 和 1.0 秒；重叠的运动请求仍会被拒绝。

14 个受支持的官方工具如下。`server_status`、`list_modules`、`agent_send` 来自官方 `McpServer`；其余硬件或机器人能力只在 Go2 模式真实执行：

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
| `tag_location` | `location_name` | 将当前地图位置保存为具名地点。 |
| `navigate_with_text` | `query` | 解析自然语言目的地，并通过 DIMOS `ReplanningAStarPlanner` 导航。 |
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

dry-run 的 `tools/list` 仍返回完整 21 个工具，以保持上下层契约稳定。官方硬件能力、`return_to_start`、`return_to_user_and_greet` 和 `start_stroll` 在 dry-run 调用时返回 `{"status":"error",...,"required_mode":"go2"}`，不会伪造遥测、感知、地图、路径或动作；三个官方 MCP 管理工具仍返回本地服务信息。`stop_all` 在 dry-run 中只停止本地定时速度执行器，其他活动在结构化结果中标记为 `not_configured`。专项停止能力仍作为底层内部 RPC 保留，供 `stop_all` 编排，但不会出现在 `tools/list`。`speak`、`follow_person`、`stop_following` 及各专项停止工具在任何模式下都不公开。

### 3. 启用真实 Unitree Go2（可选）

只有在完成安全检查后，才在启动下层服务前显式设置 Go2 模式：

~~~powershell
$env:ROBOT_IP = "机器狗 IP"
$env:DIMOS_DOG_MCP_MODE = "go2"
uv pip install -e "$repositoryPath/components/dimos-mcp[go2]"
uv pip install --reinstall --no-deps "onnxruntime-gpu==1.26.0"
dimos-dog-mcp
~~~

Go2 模式组合 DiMOS 官方 `unitree_go2_spatial` Blueprint、`NavigationSkillContainer` 和 `UnitreeSkillContainer`，其中包括 `GO2Connection`、感知、体素地图、代价地图、`ReplanningAStarPlanner`、`WavefrontFrontierExplorer`、`PatrollingModule` 与 `MovementManager`；本项目额外组合 `DogMotionSkill`、`HomeNavigationSkill`、`ReturnToUserAndGreetSkill`、`StrollSkill` 和无模型的 `StandaloneAgentBridge`。`ModuleCoordinator.build()` 返回并证明官方模块已经完成启动后，入口会同步通过 `GO2Connection.publish_request` 向 `rt/api/sport/request` 发送 `{\"api_id\":1027,\"parameter\":{\"data\":true}}`，从而启用默认 `WIRELESS_CONTROLLER` 路径实际消费导航和定时运动产生的 `cmd_vel`。响应状态码不为 `0`、结构无效或调用抛出异常时，入口停止 coordinator 并让进程失败退出；只有成功后才打印 MCP listening 消息并进入主循环。该成功响应不是独立的底盘运动证明，仍须用 `/cmd_vel` 与 `/odom` 联动完成真机验收。官方 `SpeakSkill` 被明确排除，因为它会在底层启动阶段初始化 OpenAI TTS；用户语音改由上层 Agent 显式调用独立 TTS MCP 的 `speak(text)`。官方 `PersonFollowSkillContainer` 同样被明确排除，因为它要求本项目不支持的 `ALIBABA_API_KEY`；因此上下层都不会发现或调用人员跟随工具。桥接器只满足官方 `PerceiveLoopSkill` 的回调依赖：视觉命中的可选 `then` 会向当前进程的 `127.0.0.1:<DIMOS_DOG_MCP_PORT>/mcp` 发送一次公开工具调用。它不会创建模型、会话或第二个 Agent 循环。不要将任何其他设备伪装为 Go2。

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
虚拟环境中的 `dimos-dog-mcp` 启动真实 Go2 服务。密钥不能写入仓库；无密钥字段模板为
`components/dimos-mcp/config/go2.env.example`。服务端终端需保持运行，GUI 在另一 WSL
终端通过 `dimos-dog-gui` 启动。

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

包装器只会对每个上层调用发送一次标准 JSON-RPC `tools/call` 请求。网络错误、HTTP 错误或下层 MCP 错误会返回给上层；它不会自动重试任何运动命令。

包装器 `tools/list` 返回上述全部 21 个工具，包括 14 个受支持的锁定版官方工具。每个工具都经同一个 `ForwardingService` 单次转发，因此均支持同时配置 `before_call`、`after_success`、`after_error` 和 `finally` hook。`stop_all` 在包装器中仍只是一个同名、无参数的单次转发；它不会在包装器内拆成多个上游调用。

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

其他支持 HTTP MCP 的 Host 也应使用同一端点。Host 发现到的工具名称和参数与下层一致：

| 上层调用 | 参数 | 转发结果 |
| --- | --- | --- |
| `move_forward` | `speed_mps`、`duration_s` | 原样传给下层 `move_forward`。 |
| `move_backward` | `speed_mps`、`duration_s` | 原样传给下层 `move_backward`。 |
| `stop_all` | 无 | 单次、立即传给下层；由下层统一停止所有活动，不等待或重试 hook。 |
| `motion_status` | 无 | 原样返回下层的本地运动状态。 |
| `return_to_start` | 无 | 返回本次下层进程捕获的启动位置。 |
| `return_to_user_and_greet` | 无 | 单次转发；底层负责精确标点、导航终态、到达后 1 秒静止和 `Hello`。 |
| 14 个受支持的官方工具 | 与 DiMOS `0.0.14b1` 官方签名相同 | 同名、同参数、单次转发到下层。 |
| `tag_location` | `location_name` | 原样传给下层 `tag_location`。 |
| `navigate_with_text` | `query` | 原样传给下层 `navigate_with_text`。 |
| `begin_exploration` | 无 | 启动 Frontier 探索。 |
| `start_patrol` | 无 | 启动已知地图巡逻。 |
| `start_stroll` | 无 | 启动随机选支、非覆盖式的人类式散步。 |

建议的上层使用顺序：

1. 首次接入时保持下层 dry-run，先调用 `motion_status`，再按预期参数发起前进或后退请求。
2. 需要提前结束任何动作或后台行为时，调用 `stop_all`；不要依赖断开 MCP 客户端连接来停止机器狗。
3. 实机环境中不要并发发起运动工具调用。收到“动作正在进行”的错误后，先调用 `stop_all` 或等待当前动作结束。
4. `motion_status` 只描述本地命令执行器，不可当作定位、电量、姿态或碰撞传感器数据。
5. `stop_all` 会依次尝试终止探索、巡逻、散步、持续视觉查找、定点导航和本地定时速度；某一项失败不会阻止后续停止动作。返回 `status=error` 时应检查 `failed_components` 和逐项 `results`，不得声称机器狗已完全静止。
6. `begin_exploration` 面向未知区域覆盖建图；`start_patrol` 面向已知地图覆盖巡视；`start_stroll` 面向未知道路随机选支且不补遗漏。三个移动生命周期不能同时运行。
7. 使用 `return_to_user_and_greet` 前先在目标位置调用 `tag_location(location_name="用户身边")`；不要把该工具理解为实时人员跟随。

不需要包装器 hook 的独立 MCP Host 也可以直接连接底层机器的 `http://<底层机器IP>:9990/mcp`。Agent Webhook Gateway 当前仍按既定架构连接包装器，不直接连接底层。

## 接入 Agent 输入 Webhook 与 TTS MCP

该服务需要 Node.js 22.19 或更高版本，并使用 Pi 已配置的模型和认证。先启动机器狗 MCP 与包装器，再安装并构建网关。

Windows PowerShell：

~~~powershell
Set-Location "C:/absolute/path/to/pi-hackason/components/agent-framework/agent-webhook-gateway"
npm ci --include=dev --ignore-scripts
npm run build
$env:AGENT_WEBHOOK_TTS_MCP_URL = "http://tts-device:9992/mcp"
node dist/cli.js
~~~

Ubuntu 22.04/24.04 arm64（地瓜派）使用 Node 官方 Linux ARM64 构建。systemd 单元只在 `/usr/local/bin`、`/usr/bin` 和 `/bin` 查找 Node，`command -v node` 必须返回其中之一；不要只把 Node 安装在交互 shell 才加载的 nvm 目录。不要复制 x64/Windows 的 `node_modules` 或构建产物；在板端从锁文件安装并构建：

~~~bash
cd "$HOME/pi-hackason/components/agent-framework/agent-webhook-gateway"
test "$(uname -m)" = "aarch64"
node -p '`${process.platform}/${process.arch}`'
command -v node
npm ci --include=dev --ignore-scripts
npm run build
cp .env.example .env
# 如需语音，在 .env 中配置 AGENT_WEBHOOK_TTS_MCP_URL。
~~~

Node 输出必须为 `linux/arm64`，版本必须不低于 22.19.0。构建必须保留开发依赖，以使用锁定的 TypeScript 5.9.3 及其完整标准库；不要依赖 Ubuntu 全局安装的 `tsc`。官方 user-level systemd 单元位于 `deploy/ubuntu-arm64/agent-webhook-gateway.service`，默认仓库路径为 `$HOME/pi-hackason`：

~~~bash
mkdir -p "$HOME/.config/systemd/user"
cp deploy/ubuntu-arm64/agent-webhook-gateway.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemd-run --user --wait --pipe --setenv=PATH=/usr/local/bin:/usr/bin:/bin /usr/bin/env node --version
systemctl --user enable --now agent-webhook-gateway.service
sudo loginctl enable-linger "$USER"
~~~

若仓库不在默认路径，安装单元前修改 `WorkingDirectory`。服务以部署用户运行并通过 `SIGTERM` 有序关闭；不要使用 root。用 `systemctl --user status agent-webhook-gateway.service` 和 `journalctl --user -u agent-webhook-gateway.service -f` 检查状态与日志。对外监听时仍需显式设置 `AGENT_WEBHOOK_HOST=0.0.0.0`，并由受信任网络、防火墙和 TLS 终止保护，不能把 instruction Webhook 或 TTS MCP 直接暴露到公网。

输入端向以下端点提交契约中的 `instruction_id` 和 `text`：

~~~text
POST http://网关主机:8080/v1/instructions
~~~

网关使用 SQLite 持久化 instruction inbox，默认文件为当前目录下的 `data/agent-webhook.sqlite`；固定 Agent 会话默认持久化到 `data/agent-session`。相同 ID、相同文本的重投返回 `202` 且不会重复运行 Agent；同一 ID 对应不同文本返回 `409`。模型需要向用户播报时，必须显式调用独立 TTS MCP 的 `speak(text)`；最终 assistant 文本不会自动发送。进程恢复时，已进入处理的事件直接标记完成，不会重新运行 Agent、机器狗或 TTS。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENT_WEBHOOK_HOST` / `AGENT_WEBHOOK_PORT` | `127.0.0.1` / `8080` | 输入网关监听地址。 |
| `AGENT_WEBHOOK_DATABASE_PATH` | `<cwd>/data/agent-webhook.sqlite` | instruction inbox SQLite 文件。 |
| `AGENT_WEBHOOK_MCP_URL` | `http://127.0.0.1:9991/mcp` | 包装器 MCP URL。 |
| `AGENT_WEBHOOK_MCP_TIMEOUT_MS` | `120000` | 单次 MCP 请求超时；默认覆盖同步等待返回用户标点并问候的完整工具调用。 |
| `AGENT_WEBHOOK_TTS_MCP_URL` | 未设置 | 独立 TTS tool-call endpoint；必须不同于机器人 MCP URL，设置后为 Agent 注册 `speak`。 |
| `AGENT_WEBHOOK_TTS_MCP_TIMEOUT_MS` | `10000` | 单次 TTS MCP 调用超时；不会自动重试。 |
| `AGENT_WEBHOOK_AGENT_DIR` | `~/.pi/agent` | Pi 模型、认证和设置目录。 |
| `AGENT_WEBHOOK_SESSION_DIR` | `<cwd>/data/agent-session` | 固定 Agent 会话目录。 |
| `AGENT_WEBHOOK_DEFAULT_SPEED_MPS` | `0.1` | 仅距离请求的部署标定速度。 |

网关标准输出会以 `[agent-webhook] <ISO 时间> <事件名> <JSON 字段>` 的单行格式记录 instruction 生命周期。普通 Agent 指令依次记录 `instruction.accepted`、`instruction.processing`，以及 `agent.run_started`、每一轮的 `agent.turn_started` / `agent.turn_completed`、assistant 的 `agent.response_started` / `agent.response_completed`、每次工具调用的 `agent.tool_started` / `agent.tool_completed`、自动重试的 `agent.retry_started` / `agent.retry_completed`、上下文压缩的 `agent.compaction_started` / `agent.compaction_completed`、`agent.run_completed`、带最终内部文本的 `instruction.agent_completed`，最后记录 `instruction.completed`。每条 Agent 日志都带同一 `instruction_id`；工具日志还带 `tool_call_id`、工具名、参数、是否失败和文本结果。逐 token 更新和模型私有推理不会记录，也没有任何 `reply.*` 事件；最终文本日志不等于出站回复。文本字段会做常见凭据脱敏并限制为 2000 字符，错误不打印堆栈，畸形请求不回显原始 body，但日志仍包含用户、模型和工具内容，因此属于敏感运行数据，只应保留在受控环境。

当前 TTS 传输直接发送无状态 HTTP JSON-RPC `tools/call`，不执行标准 MCP `initialize` 或 session 协商。完整 HTTP schema、`speak(text)` profile、停止口令规则和验收清单见 [Agent 输入 Webhook 与 TTS MCP 对接指南](docs/agent-input-webhook-integration.md)。

### 智能项圈 Health MCP v0.2（可选）

Health 消费端默认关闭。它不要求模型、DIMOS 或真实机器狗；启用时必须配置 wearer 和项圈上位机 MCP URL，不需要 key、secret、token 或签名：

~~~powershell
$env:AGENT_WEBHOOK_HEALTH_WEARER_ID = "xwen"
$env:AGENT_WEBHOOK_HEALTH_MCP_URL = "http://项圈上位机IP:8765/mcp"
node dist/cli.js
~~~

`AGENT_WEBHOOK_HEALTH_MCP_URL` 必须是项圈上位机提供的、不含用户名或密码的 MCP 2025-11-25 Streamable HTTP endpoint。Gateway 会完成 initialize、可选 session 协商和两个只读 tool call；session 返回 `404` 时会立即重新 initialize，并只重试一次当前只读调用。Gateway 不会 spawn Python 或读取上位机文件。启用后接收：

~~~text
POST http://网关主机:8080/v1/health-events
~~~

Webhook 入口不做任何鉴权，只校验 HTTP、Schema、notification ID 和原子幂等，持久化后返回 `202`。Gateway 发往 Health MCP 的 HTTP 请求同样不携带 `Authorization`。独立 worker 随后查询 event details 和 current state；只有 live、非 test、fresh 且 revision/source/wearer 一致的结果会记录 `verified_no_action`。该状态明确不调用 Agent、DimOS 或机器狗工具。完整 header、ACK、错误映射和测试说明见 [Health MCP v0.2 消费端对接指南](docs/health-mcp-consumer-integration.md)。

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
| 版本化的 21 工具公开契约 | `components/dimos-mcp/src/dimos_dog_mcp/tool_contract.py` |
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

要在不安装 DIMOS、不配置模型认证且不连接真实机器狗的环境中复现输入 Webhook → Agent → 机器人 MCP / TTS MCP 链路，运行：

~~~powershell
Set-Location "C:/absolute/path/to/pi-hackason/components/agent-framework/agent-webhook-gateway"
npm ci --include=dev --ignore-scripts
npm run demo:dry-run
~~~

该演示使用真实网关核心、临时 SQLite 和临时 HTTP 端口，替身化固定 Agent、`dimos-mcp-wrapper`、`dimos-dog-mcp` 与独立 TTS MCP；它不会导入 DIMOS 或访问机器狗。命令会断言 `move_forward` / `stop_all` 在包装器及底层各调用一次，停止口令在 Agent 忙碌时仍走快速路径且不自动播报，Agent 恢复后只显式调用一次 `speak`。不存在回复回调。

Health 消费端的 focused tests 同样只使用临时端口、临时 SQLite、HTTP fake server 和 stdio 业务契约 fixture：

~~~powershell
node node_modules/vitest/dist/cli.js --run test/health-webhook.test.ts
node node_modules/vitest/dist/cli.js --run test/health-mcp-client.test.ts
~~~

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
| 启动报错 `PerceiveLoopSkill ... AgentSpec ... No module met that spec` | 当前部署缺少 `StandaloneAgentBridge`，通常是底层包未更新或仍在运行旧的 editable-install 源码；更新 `components/dimos-mcp` 后重新安装并启动。不要通过加入官方 `McpClient` 修复，否则会在底层额外运行 LLM Agent。 |
| 想用 hook 拦截危险动作 | 当前 hook 不是拦截器。应在下层实现明确、可测试的安全策略。 |
| 动作未按预期结束 | 立即调用 `stop_all`，检查返回的 `failed_components` 和逐项 `results`，再检查下层日志与独立急停状态。 |
| 导航、探索、巡逻或散步没有停止 | 不要调用已隐藏的专项停止方法；再次确认 `stop_all` 已到达底层，并按其逐项结果定位失败组件。 |
| 输入已 `202` 但硬件没有播报 | `202` 只表示输入已持久化。检查是否配置 `AGENT_WEBHOOK_TTS_MCP_URL`、模型是否调用 `speak` 以及 TTS MCP 工具结果；不要等待回复 Webhook。 |
| 日志只有 `instruction.completed`，看不到 Agent 输出 | 更新并重新构建 Gateway；新版会记录 `agent.*` 处理边界和 `instruction.agent_completed.output`。该 output 只是内部最终文本，真实播报仍以 `agent.tool_started` / `agent.tool_completed` 中的 `speak` 调用为准。 |
| `/v1/health-events` 返回 `404` | Health 配置未启用；检查 `AGENT_WEBHOOK_HEALTH_WEARER_ID` 是否在启动前设置。 |
| Health 联调端希望配置 key、secret 或签名 | 当前 Health 入口已完全移除鉴权；这些配置和 Header 均不需要，旧 Header 即使存在也会被忽略。 |
| Gateway 启动时报缺少 `AGENT_WEBHOOK_HEALTH_MCP_URL` | Health 跨机消费要求 wearer 与上位机 URL 同时配置；URL 应形如 `http://<项圈上位机IP>:8765/mcp`。 |
| Health 通知已 `202` 但没有后续结果 | `202` 只表示 durable ACK；检查项圈上位机 HTTP MCP 是否监听、内网端口是否可达、独立 health queue 和审计，不要转投普通 instruction FIFO。 |

## 文档维护规则

`USAGE.md` 是面向框架使用者的公开使用契约。每次新增、删除或改变任何用户可见功能时，变更尚未完成，直到本文档同步更新。至少检查以下内容：

- 工具名称、参数、返回值和安全限制；
- 上下层端点、安装/启动步骤和环境变量；
- hook 生命周期与扩展方式；
- 下层硬件适配方式；
- 外部指令事件的输入 Webhook 与独立 TTS MCP 契约；
- 测试或运行前置条件。

若变更同时影响术语、架构边界或安全不变量，还必须同步更新 `CONTEXT.md`。
