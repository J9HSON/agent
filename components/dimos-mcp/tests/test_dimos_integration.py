from __future__ import annotations

from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest


HAS_SUPPORTED_DIMOS = importlib.util.find_spec("dimos") is not None and sys.version_info < (3, 13)


@unittest.skipUnless(HAS_SUPPORTED_DIMOS, "requires DIMOS on Python 3.10-3.12")
class DimosIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._previous_mode = os.environ.get("DIMOS_DOG_MCP_MODE")
        cls._previous_mcp_port_env = os.environ.get("MCP_PORT")
        cls._previous_listen_host_env = os.environ.get("LISTEN_HOST")
        cls._semantic_env_names = (
            "DIMOS_DOG_MCP_TOOL_PROFILE",
            "DIMOS_SEMANTIC_WORLD_PATH",
            "DIMOS_MAP_ID",
            "DIMOS_MAP_VERSION",
            "DIMOS_PREMAP_FILE",
        )
        cls._previous_semantic_env = {
            name: os.environ.get(name) for name in cls._semantic_env_names
        }
        cls._temp_dir = tempfile.TemporaryDirectory()
        cls._semantic_store = Path(cls._temp_dir.name) / "semantic-world.json"
        cls._premap_file = Path(cls._temp_dir.name) / "test.pc2.lcm"
        cls._premap_file.write_bytes(b"blueprint-only fixture")
        os.environ["DIMOS_DOG_MCP_MODE"] = "dry-run"
        os.environ["DIMOS_DOG_MCP_TOOL_PROFILE"] = "maintenance"
        os.environ["DIMOS_SEMANTIC_WORLD_PATH"] = str(cls._semantic_store)
        os.environ["DIMOS_MAP_ID"] = "replay-map"
        os.environ["DIMOS_MAP_VERSION"] = "replay-v1"
        os.environ["DIMOS_PREMAP_FILE"] = str(cls._premap_file)
        cls._write_replay_semantic_store()

        from dimos.agents.mcp.mcp_adapter import McpAdapter
        from dimos.core.coordination.module_coordinator import ModuleCoordinator
        from dimos.core.global_config import global_config
        from dimos_dog_mcp.blueprint import build_blueprint, configure_mcp_listener
        from dimos_dog_mcp.config import McpServerConfig

        cls._global_config = global_config
        cls._previous_host = global_config.listen_host
        cls._previous_port = global_config.mcp_port
        global_config.update(viewer="none", n_workers=1)
        with socket.socket() as listener:
            listener.bind(("0.0.0.0", 0))
            cls._test_port = listener.getsockname()[1]
        os.environ["MCP_PORT"] = str(cls._test_port)
        os.environ["LISTEN_HOST"] = "0.0.0.0"
        configure_mcp_listener(McpServerConfig(host="0.0.0.0", port=cls._test_port))
        cls._coordinator = ModuleCoordinator.build(build_blueprint())
        cls._adapter = McpAdapter()
        if not cls._adapter.wait_for_ready(timeout=10):
            cls._coordinator.stop()
            raise RuntimeError("DIMOS MCP server did not become ready")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._coordinator.stop()

        cls._global_config.update(
            listen_host=cls._previous_host,
            mcp_port=cls._previous_port,
        )
        if cls._previous_mode is None:
            os.environ.pop("DIMOS_DOG_MCP_MODE", None)
        else:
            os.environ["DIMOS_DOG_MCP_MODE"] = cls._previous_mode
        if cls._previous_mcp_port_env is None:
            os.environ.pop("MCP_PORT", None)
        else:
            os.environ["MCP_PORT"] = cls._previous_mcp_port_env
        if cls._previous_listen_host_env is None:
            os.environ.pop("LISTEN_HOST", None)
        else:
            os.environ["LISTEN_HOST"] = cls._previous_listen_host_env
        for name, previous_value in cls._previous_semantic_env.items():
            if previous_value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous_value
        cls._temp_dir.cleanup()

    @classmethod
    def _write_replay_semantic_store(cls) -> None:
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        cls._semantic_store.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "places": [
                        {
                            "entity_id": "place-replay-test-point",
                            "name": "测试点",
                            "aliases": ["演示点"],
                            "map_id": "replay-map",
                            "map_version": "replay-v1",
                            "pose": {
                                "frame_id": "map",
                                "ts": 1234.5,
                                "x": 1.0,
                                "y": 2.0,
                                "z": 0.0,
                                "qx": 0.0,
                                "qy": 0.0,
                                "qz": 0.0,
                                "qw": 1.0,
                            },
                            "confirmation": "confirmed",
                            "confirmed_at": now,
                            "updated_at": now,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self._adapter.call(
            "tools/call",
            {
                "name": "stop_all",
                "arguments": {},
            },
        )

    def test_native_mcp_discovers_supported_pinned_official_and_custom_tools(self) -> None:
        result = self._adapter.call("tools/list")
        names = {tool["name"] for tool in result["result"]["tools"]}
        self.assertEqual(
            names,
            {
                "move_forward",
                "move_backward",
                "stop_all",
                "motion_status",
                "get_robot_summary",
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
                "stop_navigation",
                "begin_exploration",
                "start_patrol",
                "look_out_for",
                "return_to_start",
                "return_to_user_and_greet",
                "start_stroll",
                "start_task",
                "pause_task",
                "resume_task",
                "cancel_task",
                "get_task_status",
                "list_semantic_places",
                "confirm_semantic_place",
            },
        )

    def test_server_status_identifies_the_runtime_owner_and_module_count(self) -> None:
        result = self._adapter.call(
            "tools/call",
            {
                "name": "server_status",
                "arguments": {},
            },
        )
        payload = json.loads(result["result"]["content"][0]["text"])

        self.assertIsInstance(payload["pid"], int)
        self.assertEqual(payload["mode"], "dry-run")
        self.assertIsNone(payload["robot_ip"])
        self.assertEqual(payload["module_count"], len(payload["modules"]))
        self.assertRegex(payload["started_at"], r"Z$")
        self.assertEqual(payload["runtime_owner"]["pid"], payload["pid"])
        self.assertEqual(payload["runtime_owner"]["mode"], "dry-run")
        self.assertEqual(payload["tool_profile"], "maintenance")

    def test_go2_blueprint_contains_exactly_one_connection_and_mcp_server(self) -> None:
        from dimos_dog_mcp import blueprint as blueprint_module
        from dimos_dog_mcp.blueprint import Go2DependenciesUnavailableError

        previous_mode = os.environ.get("DIMOS_DOG_MCP_MODE")
        os.environ["DIMOS_DOG_MCP_MODE"] = "go2"
        try:
            try:
                blueprint = blueprint_module.build_blueprint()
            except Go2DependenciesUnavailableError:
                self.skipTest("requires dimos-dog-mcp[go2]")
        finally:
            if previous_mode is None:
                os.environ.pop("DIMOS_DOG_MCP_MODE", None)
            else:
                os.environ["DIMOS_DOG_MCP_MODE"] = previous_mode
        module_names = [atom.module.__name__ for atom in blueprint.blueprints]
        self.assertEqual(module_names.count("GO2Connection"), 1)
        self.assertEqual(module_names.count("SemanticWorld"), 1)
        self.assertEqual(module_names.count("MissionExecutor"), 1)
        self.assertEqual(module_names.count("DogMcpServer"), 1)

    def test_dry_run_stop_all_stops_motion_and_reports_other_activities_as_not_configured(
        self,
    ) -> None:
        result = self._adapter.call(
            "tools/call",
            {
                "name": "stop_all",
                "arguments": {},
            },
        )
        payload = json.loads(result["result"]["content"][0]["text"])
        self.assertEqual(payload["status"], "stopped")
        self.assertEqual(payload["results"]["mission"]["status"], "success")
        self.assertEqual(payload["results"]["motion"]["status"], "success")
        self.assertEqual(
            {
                name: item["status"]
                for name, item in payload["results"].items()
                if name not in {"mission", "motion"}
            },
            {
                "exploration": "not_configured",
                "patrol": "not_configured",
                "stroll": "not_configured",
                "follow": "not_configured",
                "lookout": "not_configured",
                "navigation": "not_configured",
            },
        )

    def test_mcp_replay_runs_one_task_through_start_status_and_cancel(self) -> None:
        task_id = "task-replay-semantic-001"
        start = self._adapter.call(
            "tools/call",
            {
                "name": "start_task",
                "arguments": {
                    "task_json": json.dumps(
                        {
                            "task_id": task_id,
                            "kind": "go_to_place",
                            "destination": "演示点",
                        },
                        ensure_ascii=False,
                    )
                },
            },
        )
        started = json.loads(start["result"]["content"][0]["text"])
        self.assertTrue(started["accepted"])
        self.assertEqual(started["task_id"], task_id)

        status: dict[str, object] = {}
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            result = self._adapter.call(
                "tools/call",
                {"name": "get_task_status", "arguments": {}},
            )
            status = json.loads(result["result"]["content"][0]["text"])
            if status.get("state") == "navigating":
                break
            time.sleep(0.01)
        self.assertEqual(status["task"]["task_id"], task_id)
        self.assertEqual(status["state"], "navigating")

        cancelled_result = self._adapter.call(
            "tools/call",
            {
                "name": "cancel_task",
                "arguments": {"task_id": task_id},
            },
        )
        cancelled = json.loads(
            cancelled_result["result"]["content"][0]["text"]
        )
        self.assertEqual(cancelled["task"]["task_id"], task_id)
        self.assertEqual(cancelled["state"], "cancelled")
        self.assertFalse(cancelled["active"])
        self.assertTrue(cancelled["navigation_idle"])

        final_result = self._adapter.call(
            "tools/call",
            {"name": "get_task_status", "arguments": {}},
        )
        final_status = json.loads(final_result["result"]["content"][0]["text"])
        self.assertEqual(final_status["task"]["task_id"], task_id)
        self.assertEqual(final_status["state"], "cancelled")

    def test_dry_run_navigation_tool_reports_that_go2_mode_is_required(self) -> None:
        result = self._adapter.call(
            "tools/call",
            {
                "name": "navigate_with_text",
                "arguments": {"query": "去门口"},
            },
        )
        payload = json.loads(result["result"]["content"][0]["text"])
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["required_mode"], "go2")

    def test_dry_run_return_to_start_reports_that_go2_mode_is_required(self) -> None:
        result = self._adapter.call(
            "tools/call",
            {
                "name": "return_to_start",
                "arguments": {},
            },
        )
        payload = json.loads(result["result"]["content"][0]["text"])
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["required_mode"], "go2")

    def test_dry_run_return_to_user_and_greet_reports_that_go2_mode_is_required(
        self,
    ) -> None:
        result = self._adapter.call(
            "tools/call",
            {
                "name": "return_to_user_and_greet",
                "arguments": {},
            },
        )
        payload = json.loads(result["result"]["content"][0]["text"])
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["required_mode"], "go2")

    def test_server_is_running_on_the_configured_remote_listener(self) -> None:
        self.assertEqual(self._global_config.listen_host, "0.0.0.0")
        self.assertEqual(self._global_config.mcp_port, self._test_port)
        result = self._adapter.call("tools/list")
        self.assertIn("tools", result["result"])

    def test_go2_blueprint_composes_the_stage2_navigation_stack_without_starting_it(
        self,
    ) -> None:
        from dimos.core.coordination.module_coordinator import _resolve_single_ref
        from dimos_dog_mcp import blueprint as blueprint_module
        from dimos_dog_mcp.blueprint import Go2DependenciesUnavailableError

        previous_mode = os.environ.get("DIMOS_DOG_MCP_MODE")
        os.environ["DIMOS_DOG_MCP_MODE"] = "go2"
        try:
            try:
                blueprint = blueprint_module.build_blueprint()
            except Go2DependenciesUnavailableError:
                self.skipTest("requires dimos-dog-mcp[go2]")
        finally:
            if previous_mode is None:
                os.environ.pop("DIMOS_DOG_MCP_MODE", None)
            else:
                os.environ["DIMOS_DOG_MCP_MODE"] = previous_mode

        module_names = {atom.module.__name__ for atom in blueprint.blueprints}
        self.assertTrue(
            {
                "GO2Connection",
                "VoxelGridMapper",
                "CostMapper",
                "ReplanningAStarPlanner",
                "WavefrontFrontierExplorer",
                "PatrollingModule",
                "MovementManager",
                "UnitreeSkillContainer",
                "HomeNavigationSkill",
                "RobotSummarySkill",
                "StrollSkill",
                "DogMotionSkill",
                "Go2StopAllSkill",
                "SpatialMemory",
                "NavigationSkillContainer",
                "SemanticWorld",
                "MissionExecutor",
                "DogMcpServer",
            }
            <= module_names
        )
        self.assertNotIn("SpeakSkill", module_names)
        self.assertNotIn("PerceiveLoopSkill", module_names)
        self.assertNotIn("ReturnToUserAndGreetSkill", module_names)
        self.assertNotIn("StandaloneAgentBridge", module_names)

        for atom in blueprint.active_blueprints:
            for module_ref in atom.module_refs:
                _resolve_single_ref(
                    atom,
                    module_ref,
                    module_ref.spec,
                    blueprint,
                    set(),
                )

    def test_dry_run_does_not_start_motion(self) -> None:
        result = self._adapter.call(
            "tools/call",
            {
                "name": "move_forward",
                "arguments": {"speed_mps": 0.1, "duration_s": 0.5},
            },
        )
        payload = json.loads(result["result"]["content"][0]["text"])
        self.assertEqual(payload["status"], "dry_run")
        self.assertEqual(payload["linear_x_mps"], 0.1)

    def test_dry_run_rejects_overlapping_motion_with_structured_error(self) -> None:
        first = self._adapter.call(
            "tools/call",
            {
                "name": "move_forward",
                "arguments": {"speed_mps": 0.1, "duration_s": 1.0},
            },
        )
        first_payload = json.loads(first["result"]["content"][0]["text"])
        self.assertEqual(first_payload["status"], "dry_run")

        second = self._adapter.call(
            "tools/call",
            {
                "name": "move_backward",
                "arguments": {"speed_mps": 0.1, "duration_s": 1.0},
            },
        )
        second_payload = json.loads(second["result"]["content"][0]["text"])
        self.assertEqual(second_payload["status"], "error")

        self._adapter.call("tools/call", {"name": "stop_all", "arguments": {}})

    def test_invalid_motion_uses_structured_error_result(self) -> None:
        result = self._adapter.call(
            "tools/call",
            {
                "name": "move_forward",
                "arguments": {"speed_mps": -0.1, "duration_s": 1.0},
            },
        )
        payload = json.loads(result["result"]["content"][0]["text"])
        self.assertEqual(payload["status"], "error")

    def test_live_mode_maps_backward_motion_to_negative_x_and_stop_to_zero(self) -> None:
        from dimos_dog_mcp.module import DogMotionSkill

        class RecordedOutput:
            def __init__(self) -> None:
                self.messages: list[object] = []
                self.first_nonzero = threading.Event()

            def publish(self, message: object) -> None:
                self.messages.append(message)
                if getattr(getattr(message, "linear"), "x") != 0.0:
                    self.first_nonzero.set()

        previous_mode = os.environ.get("DIMOS_DOG_MCP_MODE")
        os.environ["DIMOS_DOG_MCP_MODE"] = "go2"
        try:
            skill = DogMotionSkill()
            output = RecordedOutput()
            skill.cmd_vel = output

            response = json.loads(skill.move_backward(speed_mps=0.1, duration_s=1.0))
            self.assertEqual(response["status"], "started")
            self.assertTrue(output.first_nonzero.wait(timeout=1.0))
            self.assertLess(getattr(getattr(output.messages[0], "linear"), "x"), 0.0)

            json.loads(skill.stop_motion())
            self.assertEqual(getattr(getattr(output.messages[-1], "linear"), "x"), 0.0)
        finally:
            if previous_mode is None:
                os.environ.pop("DIMOS_DOG_MCP_MODE", None)
            else:
                os.environ["DIMOS_DOG_MCP_MODE"] = previous_mode
