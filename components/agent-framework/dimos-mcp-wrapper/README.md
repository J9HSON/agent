# DIMOS MCP 薄包装器

该组件本身是一个 DIMOS 原生 MCP 服务。它不控制机器狗，也不复制运动逻辑；它把机器狗 MCP 工具调用转发给已运行的独立 `components/dimos-mcp`，并在转发路径上发出不会阻塞调用的生命周期 hook。

```mermaid
flowchart LR
    H[MCP Host / Agent] -->|HTTP :9991/mcp| W[dimos-mcp-wrapper]
    W -->|tools/call| U[dimos-dog-mcp]
    U -->|cmd_vel: Twist| D[DIMOS Go2 connection or dry-run]
    W -. best-effort events .-> K[Optional hooks]
```

## 安装与启动

DIMOS `0.0.14b1` 要求 Python 3.10 至 3.12。包装器固定安装 `dimos[web]==0.0.14b1` 和 DIMOS 生成 `@skill` schema 所需的 `langchain-core==1.5.0`。底层机器应按 `components/dimos-mcp/README.md` 独立启动机器狗 MCP。若同机部署：

```bash
uv venv --python 3.12
source .venv/bin/activate
uv pip install -e /absolute/path/to/pi-hackason/components/dimos-mcp
dimos-dog-mcp
```

再启动包装器。默认上游为 `http://127.0.0.1:9990/mcp`，包装器自身监听 `http://127.0.0.1:9991/mcp`，因此两个服务不会抢占端口。

```bash
uv pip install -e /absolute/path/to/pi-hackason/components/agent-framework/dimos-mcp-wrapper
dimos-mcp-wrapper
```

若包装器运行在另一台上层机器：

```bash
export DIMOS_MCP_WRAPPER_UPSTREAM_URL=http://192.168.66.160:9990/mcp
dimos-mcp-wrapper
```

MCP Host 只连接包装器，例如：

```bash
claude mcp add --transport http --scope project dimos-dog-wrapper http://127.0.0.1:9991/mcp
```

## 工具与 profile

默认 `product` profile 精确暴露 canonical 任务生命周期、语义地点、统一停止和
只读状态工具，并恢复官方 `tag_location`、`navigate_with_text`、
`stop_navigation`、官方 `follow_person` 及受控相对位移 `relative_move`；不暴露
探索、巡逻、定时速度、`move_forward`/`move_backward` 或通用 sport action：

```text
start_task
pause_task
resume_task
cancel_task
get_task_status
list_semantic_places
confirm_semantic_place
tag_location
navigate_with_text
stop_navigation
stop_all
motion_status
get_robot_summary
server_status
list_modules
current_time
get_battery_soc
observe
follow_person
relative_move
```

Stage 1 真机验收使用显式 `validation` profile，它精确暴露以下五个工具：

```text
relative_move
return_to_start
motion_status
get_robot_summary
stop_all
```

两种 profile 都将参数不变地单次转发：

| 工具 | 上游工具 | 说明 |
| --- | --- | --- |
| `move_forward` | `move_forward` | 转发前进速度和持续时间。 |
| `move_backward` | `move_backward` | 转发后退速度和持续时间。 |
| `stop_all` | `stop_all` | 单次转发统一停止，不重试；逐项停止由底层编排。 |
| `motion_status` | `motion_status` | 转发上游本地运动状态。 |
| `get_robot_summary` | `get_robot_summary` | 转发真实 odometry、actual path、位移与数据新鲜度。 |
| `relative_move` | `relative_move` | 原样转发官方相对位移；product Gateway 只用固定 0.2 m / 15° 小步参数，Wrapper 本身不改写参数。 |
| `start_task` | `start_task` | 原样转发 Gateway 生成的 canonical `task_json`；不重试。 |
| `pause_task` / `resume_task` / `cancel_task` | 同名 | 原样转发稳定 `task_id`。 |
| `get_task_status` | `get_task_status` | 返回唯一 `MissionExecutor` 的任务快照。 |
| `list_semantic_places` | `list_semantic_places` | 返回当前地图版本下已确认地点。 |
| `confirm_semantic_place` | `confirm_semantic_place` | 原样转发操作者确认的 `place_json`；Wrapper 不生成坐标。 |
| `tag_location` / `navigate_with_text` / `stop_navigation` | 同名 | 单次转发官方地点标记、文本导航和导航取消。 |
| `follow_person` | `follow_person` | 单次启动官方人物跟随；Wrapper 不运行视觉模型或运动算法。 |
| 17 个 DiMOS 官方工具 | 同名官方工具 | 按 DiMOS `0.0.14b1` 官方签名转发管理、移动、状态、导航、感知和人员跟随；不暴露语音。 |
| `return_to_start` | `return_to_start` | 转发返回本次下层进程启动位置的请求。 |
| `return_to_user_and_greet` | `return_to_user_and_greet` | 单次转发原子化的返航、到达后 1 秒静止与 `Hello` 问候流程。 |
| `start_stroll` | `start_stroll` | 启动随机选支、非覆盖式的人类式散步。 |

任务执行、速度、持续时间、dry-run/Go2 模式、最终零速度停止、官方能力和散步算法
均由上游 `dimos-dog-mcp` 负责。包装器不生成 task ID、不连接硬件、不运行路径规划，
也不伪造遥测。dry-run 的硬件能力错误会按普通上游错误触发 `after_error`。

所有公开工具均通过同一个 `ForwardingService`，所以都支持同时配置四种 hook。
被 profile 排除的低层工具和专项停止工具不会由包装器重新声明或转发。product
公开 `follow_person`，但停止统一使用 `stop_all`，不单独公开 `stop_following`。

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DIMOS_MCP_WRAPPER_UPSTREAM_URL` | `http://127.0.0.1:9990/mcp` | 上游 MCP 的完整 HTTP URL。 |
| `DIMOS_MCP_WRAPPER_PORT` | `9991` | 包装器的 DIMOS MCP 监听端口。 |
| `DIMOS_MCP_WRAPPER_TIMEOUT_S` | `120.0` | 单次上游请求的超时秒数；默认覆盖最长 100 秒导航、1 秒静止窗口和调用开销。 |
| `DIMOS_MCP_WRAPPER_PROFILE` | `product` | `product` 或 `validation`；后者只用于 Stage 1 真机验收。 |

端口通过 `WrapperMcpServerConfig` 序列化到 DIMOS worker，不能只修改父进程的
`global_config`。因此 `DIMOS_MCP_WRAPPER_PORT=9991` 在多进程启动时仍会绑定 9991，
不会回退到上游使用的 9990。

上游请求采用一条标准 JSON-RPC `tools/call` HTTP POST。网络失败、HTTP 失败或 MCP 错误会返回给调用方；包装器不会自动重试运动类命令。

底层参数或互斥错误使用 `{"status":"error","error":"..."}` 文本 envelope。包装器还识别 DIMOS 原生 Server 将意外异常包装成的 `Error running tool '...'` 文本；两类结果都会抛出上游错误并触发 `after_error`，不会触发 `after_success`。结构化错误的完整文本保留在异常消息中，因此 `stop_all` 的失败组件和逐项结果仍可由上层或 hook 读取。

## Hook

`ForwardingService` 通过一个专用 daemon worker 以 FIFO 顺序投递下列事件：

- `before_call`
- `after_success`
- `after_error`
- `finally`

`before_call` 仅表示事件已入队，不是拦截器：上游调用不会等待 hook 执行。hook 无法改写转发参数；hook 抛出的异常只记录日志，不会改变上游请求、结果或错误。尤其是 `stop_all` 会直接、单次转发，hook 不得延迟、拆分或重试它。

要加入一个已确定传输方式的 hook，可由 Python 入口组合：

```python
from dimos_mcp_wrapper.blueprint import build_blueprint
from dimos_mcp_wrapper.hooks import McpCallEvent


class AuditHook:
    def handle(self, event: McpCallEvent) -> None:
        if event.phase == "after_success":
            print(event.call.tool_name)


from dimos.core.coordination.module_coordinator import ModuleCoordinator

ModuleCoordinator.build(build_blueprint(hooks=(AuditHook(),))).loop()
```

当前不提供猜测性的 `send_instruction` 工具。未来确定指令协议后，应实现一个具体 hook 或独立适配器，并继续保持“上游调用一次、hook 最佳努力、停止优先”的约束。

## 测试

```powershell
Set-Location /absolute/path/to/pi-hackason/components/agent-framework/dimos-mcp-wrapper
$env:PYTHONPATH = "$PWD/src"
python -m unittest discover -s tests -v
```

纯单元测试不需要 DIMOS。原生 `tools/list` 集成测试只会在安装 DIMOS 的 Python 3.10 至 3.12 环境运行。
