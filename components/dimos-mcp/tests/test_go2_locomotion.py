from __future__ import annotations

from contextlib import nullcontext
import importlib.util
from types import SimpleNamespace
import subprocess
import sys
import unittest
from unittest.mock import patch


HAS_SUPPORTED_DIMOS = importlib.util.find_spec("dimos") is not None and sys.version_info < (3, 13)


class RecordedCoordinator:
    def __init__(self) -> None:
        self.stop_count = 0
        self.loop_count = 0

    def stop(self) -> None:
        self.stop_count += 1

    def loop(self) -> None:
        self.loop_count += 1


class Go2LocomotionBootstrapTests(unittest.TestCase):
    @unittest.skipUnless(HAS_SUPPORTED_DIMOS, "requires DIMOS on Python 3.10-3.12")
    def test_importing_blueprint_does_not_initialize_optional_audio(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import sys; "
                    "import dimos_dog_mcp.blueprint; "
                    "raise SystemExit('sounddevice' in sys.modules)"
                ),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_enable_explicitly_enables_firmware_joystick_input(self) -> None:
        from dimos_dog_mcp.go2_locomotion import (
            SPORT_REQUEST_TOPIC,
            SWITCH_JOYSTICK_API_ID,
            enable_go2_locomotion,
        )

        class RecordedConnection:
            def __init__(self) -> None:
                self.requests: list[tuple[str, dict[str, object]]] = []

            def publish_request(self, topic: str, data: dict[str, object]) -> object:
                self.requests.append((topic, data))
                return {"data": {"header": {"status": {"code": 0}}}}

        connection = RecordedConnection()
        enable_go2_locomotion(connection)

        self.assertEqual(
            connection.requests,
            [
                (
                    SPORT_REQUEST_TOPIC,
                    {
                        "api_id": SWITCH_JOYSTICK_API_ID,
                        "parameter": {"data": True},
                    },
                )
            ],
        )

    def test_enable_rejects_a_failed_joystick_request(self) -> None:
        from dimos_dog_mcp.go2_locomotion import enable_go2_locomotion

        class FailedConnection:
            def __init__(self, response: object) -> None:
                self.response = response

            def publish_request(self, topic: str, data: dict[str, object]) -> object:
                return self.response

        failed_responses = (
            {"data": {"header": {"status": {"code": 3103}}}},
            {"data": {"header": {"status": {}}}},
            {},
            None,
        )
        for response in failed_responses:
            with self.subTest(response=response):
                with self.assertRaisesRegex(RuntimeError, "joystick"):
                    enable_go2_locomotion(FailedConnection(response))

    @unittest.skipUnless(HAS_SUPPORTED_DIMOS, "requires DIMOS on Python 3.10-3.12")
    def test_go2_runtime_initializes_the_deployed_connection_after_build(self) -> None:
        from dimos_dog_mcp.blueprint import initialize_go2_runtime

        class RecordedConnection:
            def __init__(self) -> None:
                self.requests: list[tuple[str, dict[str, object]]] = []

            def publish_request(self, topic: str, data: dict[str, object]) -> object:
                self.requests.append((topic, data))
                return {"data": {"header": {"status": {"code": 0}}}}

        class RecordedCoordinator:
            def __init__(self, connection: RecordedConnection) -> None:
                self.connection = connection
                self.requested_module_names: list[str] = []

            def get_instance(self, module: type[object]) -> RecordedConnection:
                self.requested_module_names.append(module.__name__)
                return self.connection

        connection = RecordedConnection()
        coordinator = RecordedCoordinator(connection)

        initialize_go2_runtime(coordinator)

        self.assertEqual(coordinator.requested_module_names, ["GO2Connection"])
        self.assertEqual(len(connection.requests), 1)

    @unittest.skipUnless(HAS_SUPPORTED_DIMOS, "requires DIMOS on Python 3.10-3.12")
    def test_go2_startup_failure_stops_modules_without_entering_the_loop(self) -> None:
        from dimos_dog_mcp import blueprint
        from dimos_dog_mcp.config import McpServerConfig, RuntimeMode

        coordinator = RecordedCoordinator()
        server_config = McpServerConfig(host="127.0.0.1", port=9990)
        with (
            patch.object(blueprint, "read_mcp_server_config", return_value=server_config),
            patch.object(blueprint, "read_runtime_mode", return_value=RuntimeMode.GO2),
            patch.object(
                blueprint,
                "claim_runtime",
                return_value=nullcontext(
                    SimpleNamespace(
                        pid=123,
                        mode="go2",
                        robot_ip="192.0.2.1",
                    )
                ),
            ),
            patch.object(blueprint, "configure_mcp_listener"),
            patch.object(blueprint, "build_blueprint", return_value=object()),
            patch.object(blueprint.ModuleCoordinator, "build", return_value=coordinator),
            patch.object(
                blueprint,
                "initialize_go2_runtime",
                side_effect=RuntimeError("joystick failed"),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "joystick failed"):
                blueprint.main()

        self.assertEqual(coordinator.stop_count, 1)
        self.assertEqual(coordinator.loop_count, 0)

    @unittest.skipUnless(HAS_SUPPORTED_DIMOS, "requires DIMOS on Python 3.10-3.12")
    def test_dry_run_startup_skips_go2_initialization(self) -> None:
        from dimos_dog_mcp import blueprint
        from dimos_dog_mcp.config import McpServerConfig, RuntimeMode

        coordinator = RecordedCoordinator()
        server_config = McpServerConfig(host="127.0.0.1", port=9990)
        with (
            patch.object(blueprint, "read_mcp_server_config", return_value=server_config),
            patch.object(blueprint, "read_runtime_mode", return_value=RuntimeMode.DRY_RUN),
            patch.object(
                blueprint,
                "claim_runtime",
                return_value=nullcontext(
                    SimpleNamespace(
                        pid=123,
                        mode="dry-run",
                        robot_ip=None,
                    )
                ),
            ),
            patch.object(blueprint, "configure_mcp_listener"),
            patch.object(blueprint, "build_blueprint", return_value=object()),
            patch.object(blueprint.ModuleCoordinator, "build", return_value=coordinator),
            patch.object(blueprint, "initialize_go2_runtime") as initialize,
        ):
            blueprint.main()

        initialize.assert_not_called()
        self.assertEqual(coordinator.stop_count, 0)
        self.assertEqual(coordinator.loop_count, 1)


if __name__ == "__main__":
    unittest.main()
