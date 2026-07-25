# 复用 Agent Webhook Gateway 作为统一设备控制平面

状态：提议，待用户确认。

眼镜、戒指和未来设备不得直接调用 Wrapper MCP 或 DimOS。统一设备后台不新建第二套机器人控制服务，而是在现有 Agent Webhook Gateway 上增加设备身份、在线状态、控制租约、类型化设备命令、遥测快照和事件订阅能力。Gateway 仍是所有外部输入的唯一受理边界；Wrapper 与 robot MCP 保持受保护的兼容边界；DimOS 继续是唯一机器人 Runtime 和物理执行者。

眼镜的 `FWD / BACK / LEFT / RIGHT / STOP` 是离散设备命令，不是连续速度流。类型化命令进入 Gateway 后复用现有持久化优先通道：方向命令固定映射到 `stop_all -> relative_move`，停止命令只调用 `stop_all`，全部绕过 LLM。新命令必须携带稳定 `command_id`、`device_id`、`session_id`、客户端序号和过期时间；重复事件不得重复执行，过期运动命令不得在 Gateway 重启后恢复。

戒指继续由已签名的 `RingVoiceInput` 进程独占 BLE，眼镜继续由 Even Hub/Even Dash 独占显示桥接。设备后台只接收适配器发布的状态与事件，不建立第二条 BLE 或 Go2 连接。DimOS 地图和位姿由只读遥测适配器低频发布给 Gateway；大点云、地图历史和录音不进入 Gateway SQLite。

选择扩展现有 Gateway，而不是眼镜直连 MCP或新增独立 Device Hub 服务，是为了复用已经存在的幂等 inbox/outbox、优先停止通道、回复关联、SQLite 和单一产品入口，同时减少明日现场需要启动和诊断的服务数量。
