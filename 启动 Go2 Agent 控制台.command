#!/bin/zsh
set -euo pipefail

console_repo_root="${0:A:h}"
console_dimos_root="/Users/johnsonmac/ai_completion/dimos"
console_runtime_dir="${console_repo_root}/components/dimos-mcp"
console_runtime_src="${console_runtime_dir}/src"
console_studio_src="${console_dimos_root}/extensions/go2-studio-agent/src"
console_gateway_dir="${console_repo_root}/components/agent-framework/agent-webhook-gateway"
console_wrapper_dir="${console_repo_root}/components/agent-framework/dimos-mcp-wrapper"
console_wrapper_src="${console_wrapper_dir}/src"
console_python="${console_dimos_root}/.venv/bin/python"
console_state_dir="/Users/johnsonmac/.dimos/go2-stage2"
console_env_file="${console_state_dir}/product.env"
console_runtime_log="${console_state_dir}/agent-console-runtime.log"
console_wrapper_log="${console_state_dir}/agent-console-wrapper.log"
console_gateway_log="${console_state_dir}/agent-console-gateway.log"
console_runtime_pid_file="${console_state_dir}/agent-console-runtime.pid"
console_wrapper_pid_file="${console_state_dir}/agent-console-wrapper.pid"
console_gateway_pid_file="${console_state_dir}/agent-console-gateway.pid"

started_runtime_pid=""
started_wrapper_pid=""
started_gateway_pid=""
gateway_was_running=false

show_error() {
	osascript - "$1" <<'APPLESCRIPT'
on run argv
	display alert "Go2 Agent 控制台" message (item 1 of argv) as critical
end run
APPLESCRIPT
}

show_ready_notification() {
	osascript -e 'display notification "Runtime、MCP、地图与 Agent 已就绪" with title "Go2 Agent 控制台"' >/dev/null
}

listener_pid() {
	lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1
}

listener_command() {
	local pid="$1"
	ps -p "${pid}" -o command=
}

require_expected_listener() {
	local port="$1"
	local expected="$2"
	local label="$3"
	local pid
	local command
	pid="$(listener_pid "${port}" || true)"
	if [[ -z "${pid}" ]]; then
		return 1
	fi
	command="$(listener_command "${pid}")"
	if [[ "${command}" != *"${expected}"* ]]; then
		show_error "${label} 端口 ${port} 被其他进程占用。为避免第二个控制 Owner，本次没有接管或结束该进程。"
		exit 1
	fi
	return 0
}

wait_for_expected_listener() {
	local port="$1"
	local expected="$2"
	local timeout_seconds="$3"
	local attempts=$((timeout_seconds * 2))
	local pid
	local command
	while (( attempts > 0 )); do
		pid="$(listener_pid "${port}" || true)"
		if [[ -n "${pid}" ]]; then
			command="$(listener_command "${pid}")"
			[[ "${command}" == *"${expected}"* ]] && return 0
			return 2
		fi
		sleep 0.5
		attempts=$((attempts - 1))
	done
	return 1
}

wait_for_port() {
	local port="$1"
	local timeout_seconds="$2"
	local attempts=$((timeout_seconds * 2))
	while (( attempts > 0 )); do
		[[ -n "$(listener_pid "${port}" || true)" ]] && return 0
		sleep 0.5
		attempts=$((attempts - 1))
	done
	return 1
}

mcp_request() {
	local endpoint="$1"
	local payload="$2"
	curl --noproxy '*' --silent --show-error --fail --max-time 15 \
		-H 'accept: application/json' \
		-H 'content-type: application/json' \
		--data "${payload}" \
		"${endpoint}"
}

best_effort_stop() {
	[[ -n "$(listener_pid 9990 || true)" ]] || return 0
	mcp_request \
		http://127.0.0.1:9990/mcp \
		'{"jsonrpc":"2.0","id":"launcher-stop","method":"tools/call","params":{"name":"stop_all","arguments":{}}}' \
		>/dev/null 2>&1 || true
}

terminate_started_process() {
	local pid="$1"
	[[ -n "${pid}" ]] || return 0
	kill -0 "${pid}" 2>/dev/null || return 0
	kill -TERM "${pid}" 2>/dev/null || true
}

fail_with_cleanup() {
	local message="$1"
	best_effort_stop
	terminate_started_process "${started_gateway_pid}"
	terminate_started_process "${started_wrapper_pid}"
	terminate_started_process "${started_runtime_pid}"
	show_error "${message}"
	exit 1
}

count_mcp_tools() {
	local endpoint="$1"
	local response
	response="$(mcp_request \
		"${endpoint}" \
		'{"jsonrpc":"2.0","id":"launcher-tools","method":"tools/list","params":{}}')" || return 1
	printf '%s' "${response}" | "${console_python}" -c '
import json
import sys

payload = json.load(sys.stdin)
tools = payload.get("result", {}).get("tools", [])
if not isinstance(tools, list):
    raise SystemExit(1)
print(len(tools))
'
}

read_robot_health() {
	local response
	response="$(mcp_request \
		http://127.0.0.1:9991/mcp \
		'{"jsonrpc":"2.0","id":"launcher-health","method":"tools/call","params":{"name":"get_robot_summary","arguments":{}}}')" || return 1
	printf '%s' "${response}" | "${console_python}" -c '
import json
import sys

payload = json.load(sys.stdin)
content = payload.get("result", {}).get("content", [])
text = next(
    (item.get("text") for item in content if isinstance(item, dict) and item.get("type") == "text"),
    None,
)
if not isinstance(text, str):
    raise SystemExit(1)
summary = json.loads(text)
odometry = summary.get("odometry", {})
if odometry.get("fresh") is not True:
    raise SystemExit(2)
print(summary.get("status", "ready"))
'
}

mkdir -p "${console_state_dir}"

[[ -x "${console_python}" ]] || {
	show_error "找不到 DimOS Python：${console_python}"
	exit 1
}
[[ -f "${console_env_file}" ]] || {
	show_error "找不到 Product 配置：${console_env_file}"
	exit 1
}
[[ "$(stat -f '%Lp' "${console_env_file}")" == "600" ]] || {
	show_error "Product 配置权限必须是 600：${console_env_file}"
	exit 1
}

set -a
source "${console_env_file}"
set +a

[[ -n "${ROBOT_IP:-}" ]] || {
	show_error "Product 配置缺少 ROBOT_IP"
	exit 1
}
[[ "${DIMOS_DOG_MCP_MODE:-}" == "go2" ]] || {
	show_error "Product 配置必须使用 DIMOS_DOG_MCP_MODE=go2"
	exit 1
}
[[ "${DIMOS_DOG_MCP_TOOL_PROFILE:-}" == "product" ]] || {
	show_error "Product 配置必须使用 DIMOS_DOG_MCP_TOOL_PROFILE=product"
	exit 1
}
[[ -f "${DIMOS_PREMAP_FILE:-}" ]] || {
	show_error "找不到预建图文件：${DIMOS_PREMAP_FILE:-未配置}"
	exit 1
}

if [[ -z "${AGENT_WEBHOOK_MODEL_API_KEY:-}" ]] &&
	! security find-generic-password -s agent-webhook-gateway-siliconflow >/dev/null 2>&1; then
	show_error "找不到 Agent 文本模型密钥。请先配置 Keychain service：agent-webhook-gateway-siliconflow"
	exit 1
fi

export AGENT_WEBHOOK_MODEL_PROVIDER="${AGENT_WEBHOOK_MODEL_PROVIDER:-siliconflow}"
export AGENT_WEBHOOK_MODEL_ID="${AGENT_WEBHOOK_MODEL_ID:-zai-org/GLM-5.2}"
export AGENT_WEBHOOK_MODEL_BASE_URL="${AGENT_WEBHOOK_MODEL_BASE_URL:-https://api.siliconflow.cn/v1}"
export NO_PROXY="${NO_PROXY:+${NO_PROXY},}127.0.0.1,localhost,${ROBOT_IP}"
export no_proxy="${NO_PROXY}"

echo "1/6 检查机器狗网络与本机环境…"
if ! nc -z -G 2 -w 2 "${ROBOT_IP}" 9991 >/dev/null 2>&1; then
	show_error "机器狗 ${ROBOT_IP}:9991 不可达。请确认机器狗已开机，并且电脑连接到机器狗局域网。"
	exit 1
fi

if ! PYTHONPATH="${console_runtime_src}:${console_studio_src}:${console_dimos_root}" \
	"${console_python}" -c 'import dimos, dimos_dog_mcp, dimos_go2_studio' >/dev/null 2>&1; then
	show_error "DimOS、朋友 MCP 或 go2-studio-agent 无法导入。请检查本机 Python 环境。"
	exit 1
fi

if require_expected_listener 9991 "dimos_mcp_wrapper.blueprint" "MCP Wrapper"; then
	:
fi
if require_expected_listener 8080 "dist/cli.js" "Agent Gateway"; then
	:
fi

echo "2/6 启动或接入唯一 DimOS Product Runtime…"
if ! require_expected_listener 9990 "dimos_dog_mcp.blueprint" "DimOS Runtime"; then
	for viewer_port in 9877 9878; do
		if [[ -n "$(listener_pid "${viewer_port}" || true)" ]]; then
			show_error "Runtime 尚未运行，但 Viewer 端口 ${viewer_port} 已被占用。请先关闭冲突进程。"
			exit 1
		fi
	done

	(
		cd "${console_runtime_dir}"
		nohup env \
			PYTHONPATH="${console_runtime_src}:${console_studio_src}:${console_dimos_root}${PYTHONPATH:+:${PYTHONPATH}}" \
			NO_PROXY="${NO_PROXY}" \
			no_proxy="${no_proxy}" \
			"${console_python}" -m dimos_dog_mcp.blueprint \
			>>"${console_runtime_log}" 2>&1 &
		echo $! >"${console_runtime_pid_file}"
	)
	started_runtime_pid="$(tr -cd '0-9' <"${console_runtime_pid_file}")"
	if ! wait_for_expected_listener 9990 "dimos_dog_mcp.blueprint" 180; then
		fail_with_cleanup "DimOS Product Runtime 启动失败。请检查 ${console_runtime_log}"
	fi
fi

echo "3/6 等待官方 Rerun 地图 Viewer…"
if ! wait_for_port 9878 120; then
	fail_with_cleanup "DimOS Runtime 已启动，但官方地图 Viewer :9878 未就绪。请检查 ${console_runtime_log}"
fi

echo "4/6 启动或接入 product MCP Wrapper…"
if ! require_expected_listener 9991 "dimos_mcp_wrapper.blueprint" "MCP Wrapper"; then
	(
		cd "${console_wrapper_dir}"
		nohup env \
			PYTHONPATH="${console_wrapper_src}" \
			DIMOS_MCP_WRAPPER_PROFILE=product \
			DIMOS_MCP_WRAPPER_UPSTREAM_URL=http://127.0.0.1:9990/mcp \
			NO_PROXY="${NO_PROXY}" \
			no_proxy="${no_proxy}" \
			"${console_python}" -m dimos_mcp_wrapper.blueprint \
			>>"${console_wrapper_log}" 2>&1 &
		echo $! >"${console_wrapper_pid_file}"
	)
	started_wrapper_pid="$(tr -cd '0-9' <"${console_wrapper_pid_file}")"
	if ! wait_for_expected_listener 9991 "dimos_mcp_wrapper.blueprint" 30; then
		fail_with_cleanup "MCP Wrapper 启动失败。请检查 ${console_wrapper_log}"
	fi
fi

echo "5/6 校验 Runtime、Wrapper 工具面与 fresh odometry…"
runtime_tool_count="$(count_mcp_tools http://127.0.0.1:9990/mcp || true)"
wrapper_tool_count="$(count_mcp_tools http://127.0.0.1:9991/mcp || true)"
if [[ "${runtime_tool_count}" != "20" || "${wrapper_tool_count}" != "20" ]]; then
	fail_with_cleanup "Product 工具面不一致：Runtime=${runtime_tool_count:-不可用}，Wrapper=${wrapper_tool_count:-不可用}，预期均为 20。"
fi

robot_health="$(read_robot_health || true)"
if [[ -z "${robot_health}" ]]; then
	fail_with_cleanup "机器人已连接，但 fresh odometry 尚未就绪。请检查 ${console_runtime_log}"
fi

echo "6/6 启动或接入 Agent Gateway 与文本模型…"
if require_expected_listener 8080 "dist/cli.js" "Agent Gateway"; then
	gateway_was_running=true
else
	(
		cd "${console_gateway_dir}"
		if [[ ! -f dist/cli.js ]] ||
			[[ -n "$(find src -type f -name '*.ts' -newer dist/cli.js -print -quit)" ]]; then
			npm run build >>"${console_gateway_log}" 2>&1
		fi
		nohup env \
			AGENT_WEBHOOK_TOOL_PROFILE=product \
			AGENT_WEBHOOK_RUNTIME=pi \
			AGENT_WEBHOOK_MCP_URL=http://127.0.0.1:9991/mcp \
			AGENT_WEBHOOK_MAP_URL=http://127.0.0.1:9878/ \
			AGENT_WEBHOOK_MODEL_PROVIDER="${AGENT_WEBHOOK_MODEL_PROVIDER}" \
			AGENT_WEBHOOK_MODEL_ID="${AGENT_WEBHOOK_MODEL_ID}" \
			AGENT_WEBHOOK_MODEL_BASE_URL="${AGENT_WEBHOOK_MODEL_BASE_URL}" \
			NO_PROXY="${NO_PROXY}" \
			no_proxy="${no_proxy}" \
			node --env-file-if-exists=.env dist/cli.js \
			>>"${console_gateway_log}" 2>&1 &
		echo $! >"${console_gateway_pid_file}"
	)
	started_gateway_pid="$(tr -cd '0-9' <"${console_gateway_pid_file}")"
	if ! wait_for_expected_listener 8080 "dist/cli.js" 30; then
		fail_with_cleanup "Agent Gateway 启动失败。请检查 ${console_gateway_log}"
	fi
fi

if ! curl --noproxy '*' --silent --show-error --fail --max-time 5 \
	http://127.0.0.1:8080/v1/ui-config >/dev/null; then
	fail_with_cleanup "Agent 前台健康检查失败。请检查 ${console_gateway_log}"
fi

runtime_pid="$(listener_pid 9990)"
wrapper_pid="$(listener_pid 9991)"
gateway_pid="$(listener_pid 8080)"

echo
echo "Go2 Agent 控制链已就绪"
echo "Runtime :9990  PID ${runtime_pid}"
echo "Wrapper :9991  PID ${wrapper_pid}"
echo "Viewer  :9878"
echo "Gateway :8080  PID ${gateway_pid}"
echo "Model   ${AGENT_WEBHOOK_MODEL_PROVIDER}/${AGENT_WEBHOOK_MODEL_ID}"
echo "Robot   ${ROBOT_IP} / ${robot_health}"
echo
echo "前台：http://127.0.0.1:8080/"

if [[ "${gateway_was_running}" == false ]]; then
	open "http://127.0.0.1:8080/"
fi
show_ready_notification
