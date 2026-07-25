#!/usr/bin/env bash
# Start the local real-Go2 MCP from a WSL-only private environment file.

set -Eeuo pipefail

readonly ENV_FILE="${DIMOS_DOG_MCP_ENV_FILE:-"$HOME/.config/dimos-dog-mcp/go2.env"}"
readonly MCP_LAUNCHER="${DIMOS_DOG_MCP_LAUNCHER:-"$HOME/dimensional-applications/.venv/bin/dimos-dog-mcp"}"
readonly MCP_BIN_DIR="$(dirname "$MCP_LAUNCHER")"
readonly MCP_VENV_DIR="$(cd "$MCP_BIN_DIR/.." && pwd)"
readonly MCP_PYTHON="$MCP_BIN_DIR/python"

fail() {
    printf '错误：%s\n' "$*" >&2
    exit 1
}

[[ -f "$ENV_FILE" ]] || fail "找不到私有配置文件：$ENV_FILE"
[[ -r "$ENV_FILE" ]] || fail "无法读取私有配置文件：$ENV_FILE"

if permissions="$(stat --format='%a' "$ENV_FILE" 2>/dev/null)"; then
    :
else
    permissions="$(stat -f '%Lp' "$ENV_FILE")"
fi
[[ "$permissions" == "600" ]] || fail "私有配置文件权限必须为 600，当前为 $permissions"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

[[ -n "${ROBOT_IP:-}" ]] || fail "go2.env 缺少 ROBOT_IP"
[[ -n "${DIMOS_QWEN_VL_API_KEY:-}" ]] || fail \
    "go2.env 缺少 DIMOS_QWEN_VL_API_KEY，官方人物跟随无法完成初次识别"
export DIMOS_QWEN_VL_BASE_URL="${DIMOS_QWEN_VL_BASE_URL:-https://api.siliconflow.cn/v1}"
export DIMOS_QWEN_VL_MODEL="${DIMOS_QWEN_VL_MODEL:-Qwen/Qwen3-VL-8B-Instruct}"

append_no_proxy() {
    local key="$1"
    local current="${!key:-}"
    case ",$current," in
        *",$ROBOT_IP,"*) ;;
        *) export "$key=${current:+$current,}$ROBOT_IP" ;;
    esac
}
append_no_proxy NO_PROXY
append_no_proxy no_proxy

export DIMOS_DOG_MCP_MODE="${DIMOS_DOG_MCP_MODE:-go2}"
[[ "$DIMOS_DOG_MCP_MODE" == "go2" ]] || fail "启动脚本仅允许 DIMOS_DOG_MCP_MODE=go2"

export DIMOS_DOG_MCP_HOST="${DIMOS_DOG_MCP_HOST:-127.0.0.1}"
export DIMOS_DOG_MCP_PORT="${DIMOS_DOG_MCP_PORT:-9990}"
export VIEWER="${VIEWER:-rerun}"
export RERUN_OPEN="${RERUN_OPEN:-native}"

[[ -x "$MCP_LAUNCHER" ]] || fail "找不到 WSL 虚拟环境中的 dimos-dog-mcp：$MCP_LAUNCHER"
[[ -x "$MCP_PYTHON" ]] || fail "找不到 WSL 虚拟环境中的 Python：$MCP_PYTHON"

nvidia_library_path=""
for component in cublas cuda_nvrtc cuda_runtime cudnn cufft curand nvjitlink; do
    for library_dir in "$MCP_VENV_DIR"/lib/python*/site-packages/nvidia/"$component"/lib; do
        [[ -d "$library_dir" ]] || continue
        nvidia_library_path="${nvidia_library_path:+$nvidia_library_path:}$library_dir"
    done
done
[[ -n "$nvidia_library_path" ]] || fail \
    "找不到 ONNX Runtime 所需的 NVIDIA runtime；请重新安装 dimos-dog-mcp[go2]"
export LD_LIBRARY_PATH="$nvidia_library_path${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

"$MCP_PYTHON" -c \
    'import onnxruntime as ort; providers = ort.get_available_providers(); assert "CUDAExecutionProvider" in providers, f"CUDAExecutionProvider unavailable: {providers}"' \
    || fail "ONNX Runtime CUDA 预检失败；请最后执行 uv pip install --reinstall --no-deps onnxruntime-gpu==1.26.0"

printf '启动真实 Go2 MCP：%s:%s/mcp\n' "$DIMOS_DOG_MCP_HOST" "$DIMOS_DOG_MCP_PORT"
exec "$MCP_LAUNCHER"
