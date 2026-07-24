from __future__ import annotations

import importlib.util
import json
import os
import socket
import sys
import time
import unittest
from urllib.request import Request, urlopen


HAS_SUPPORTED_DIMOS = importlib.util.find_spec("dimos") is not None and sys.version_info < (3, 13)


@unittest.skipUnless(HAS_SUPPORTED_DIMOS, "requires DIMOS on Python 3.10-3.12")
class DimosWrapperIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from dimos.core.coordination.module_coordinator import ModuleCoordinator
        from dimos.core.global_config import global_config
        from dimos_mcp_wrapper.blueprint import build_blueprint

        cls._global_config = global_config
        cls._previous_port = global_config.mcp_port
        cls._previous_env_port = os.environ.get("DIMOS_MCP_WRAPPER_PORT")
        cls._previous_mcp_port_env = os.environ.get("MCP_PORT")
        cls._port = _unused_local_port()
        os.environ["DIMOS_MCP_WRAPPER_PORT"] = str(cls._port)
        os.environ["MCP_PORT"] = str(cls._port)
        global_config.update(viewer="none", n_workers=1)
        cls._coordinator = ModuleCoordinator.build(build_blueprint())
        _wait_until_ready(cls._port)

    @classmethod
    def tearDownClass(cls) -> None:
        cls._coordinator.stop()

        cls._global_config.update(mcp_port=cls._previous_port)
        if cls._previous_env_port is None:
            os.environ.pop("DIMOS_MCP_WRAPPER_PORT", None)
        else:
            os.environ["DIMOS_MCP_WRAPPER_PORT"] = cls._previous_env_port
        if cls._previous_mcp_port_env is None:
            os.environ.pop("MCP_PORT", None)
        else:
            os.environ["MCP_PORT"] = cls._previous_mcp_port_env

    def test_native_mcp_discovers_supported_pinned_official_and_custom_tools(self) -> None:
        result = _mcp_request(self._port, "tools/list")
        names = {tool["name"] for tool in result["result"]["tools"]}

        self.assertEqual(
            names,
            {
                "move_forward",
                "move_backward",
                "stop_all",
                "motion_status",
                "server_status",
                "list_modules",
                "agent_send",
                "relative_move",
                "wait",
                "current_time",
                "execute_sport_command",
                "get_battery_soc",
                "observe",
                "tag_location",
                "navigate_with_text",
                "return_to_start",
                "return_to_user_and_greet",
                "begin_exploration",
                "start_patrol",
                "look_out_for",
                "start_stroll",
            },
        )


def _unused_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _wait_until_ready(port: int) -> None:
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        try:
            _mcp_request(port, "initialize")
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"DIMOS MCP wrapper did not become ready on port {port}")


def _mcp_request(port: int, method: str) -> dict[str, object]:
    request = Request(
        f"http://127.0.0.1:{port}/mcp",
        data=json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": {}}
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=1.0) as response:
        decoded: object = json.loads(response.read().decode("utf-8"))
    if not isinstance(decoded, dict):
        raise RuntimeError("MCP response must be a JSON object")
    return decoded
