#!/bin/zsh
set -euo pipefail

console_repo_root="${0:A:h}"
console_gateway_dir="${console_repo_root}/components/agent-framework/agent-webhook-gateway"
console_wrapper_src="${console_repo_root}/components/agent-framework/dimos-mcp-wrapper/src"
console_python="/Users/johnsonmac/ai_completion/dimos/.venv/bin/python"
console_state_dir="/Users/johnsonmac/.dimos/go2-stage2"
console_wrapper_log="${console_state_dir}/agent-console-wrapper.log"
console_gateway_log="${console_state_dir}/agent-console-gateway.log"

show_error() {
	osascript -e "display alert \"Go2 Agent 控制台\" message \"$1\" as critical"
}

listener_pid() {
	lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1
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
	command="$(ps -p "${pid}" -o command=)"
	if [[ "${command}" != *"${expected}"* ]]; then
		show_error "${label} 端口 ${port} 被其他进程占用。为避免第二个控制 Owner，本次没有接管或结束该进程。"
		exit 1
	fi
	return 0
}

wait_for_port() {
	local port="$1"
	local attempts=50
	while (( attempts > 0 )); do
		if [[ -n "$(listener_pid "${port}" || true)" ]]; then
			return 0
		fi
		sleep 0.2
		attempts=$((attempts - 1))
	done
	return 1
}

mkdir -p "${console_state_dir}"

if ! require_expected_listener 9990 "dimos_dog_mcp.blueprint" "DimOS Runtime"; then
	show_error "唯一 DimOS Product Runtime 尚未启动。请先启动机器狗 Runtime；本脚本不会自行连接、站立或移动机器狗。"
	exit 1
fi

if ! require_expected_listener 9991 "dimos_mcp_wrapper.blueprint" "MCP Wrapper"; then
	(
		cd "${console_repo_root}/components/agent-framework/dimos-mcp-wrapper"
		nohup env \
			PYTHONPATH="${console_wrapper_src}" \
			DIMOS_MCP_WRAPPER_PROFILE=product \
			DIMOS_MCP_WRAPPER_UPSTREAM_URL=http://127.0.0.1:9990/mcp \
			NO_PROXY=127.0.0.1,localhost \
			no_proxy=127.0.0.1,localhost \
			"${console_python}" -m dimos_mcp_wrapper.blueprint \
			>>"${console_wrapper_log}" 2>&1 &
	)
	if ! wait_for_port 9991; then
		show_error "MCP Wrapper 启动失败。请检查 ${console_wrapper_log}"
		exit 1
	fi
fi

if ! require_expected_listener 8080 "dist/cli.js" "Agent Gateway"; then
	(
		cd "${console_gateway_dir}"
		if [[ ! -f dist/cli.js ]] || [[ -n "$(find src -type f -name '*.ts' -newer dist/cli.js -print -quit)" ]]; then
			npm run build
		fi
		nohup env \
			AGENT_WEBHOOK_TOOL_PROFILE=product \
			AGENT_WEBHOOK_RUNTIME=pi \
			AGENT_WEBHOOK_MCP_URL=http://127.0.0.1:9991/mcp \
			AGENT_WEBHOOK_MAP_URL=http://127.0.0.1:9878/ \
			NO_PROXY=127.0.0.1,localhost \
			no_proxy=127.0.0.1,localhost \
			node --env-file-if-exists=.env dist/cli.js \
			>>"${console_gateway_log}" 2>&1 &
	)
	if ! wait_for_port 8080; then
		show_error "Agent Gateway 启动失败。请检查 ${console_gateway_log}"
		exit 1
	fi
fi

open "http://127.0.0.1:8080/"
