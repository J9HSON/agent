from __future__ import annotations

import threading
import unittest

from dimos_dog_mcp.config import (
    McpServerConfig,
    RuntimeMode,
    configure_robot_no_proxy,
    read_mcp_server_config,
    read_runtime_mode,
)
from dimos_dog_mcp.motion_runtime import (
    MotionBusyError,
    MotionRuntime,
    VelocityCommand,
    validate_motion_request,
)


class MotionRuntimeTests(unittest.TestCase):
    def test_completed_motion_repeatedly_publishes_then_stops(self) -> None:
        published: list[VelocityCommand] = []
        runtime = MotionRuntime(published.append, publish_hz=100.0)

        outcome = runtime.execute(VelocityCommand(0.1, 0.0, 0.0, 0.03))

        self.assertEqual(outcome.state, "completed")
        self.assertGreaterEqual(len(published), 2)
        self.assertEqual(published[0].linear_x, 0.1)
        self.assertEqual(published[-1], VelocityCommand.zero())
        self.assertFalse(runtime.status().active)
        self.assertEqual(runtime.status().last_outcome, "completed")
        self.assertEqual(runtime.status().last_command, VelocityCommand(0.1, 0.0, 0.0, 0.03))

    def test_stop_preempts_active_motion_and_publishes_zero(self) -> None:
        published: list[VelocityCommand] = []
        first_nonzero = threading.Event()

        def publish(command: VelocityCommand) -> None:
            published.append(command)
            if command.linear_x != 0.0:
                first_nonzero.set()

        runtime = MotionRuntime(publish, publish_hz=100.0)
        runtime.start(VelocityCommand(0.1, 0.0, 0.0, 1.0))
        self.assertTrue(first_nonzero.wait(timeout=1.0))
        self.assertTrue(runtime.stop())

        self.assertFalse(runtime.status().active)
        self.assertEqual(published[-1], VelocityCommand.zero())
        self.assertEqual(runtime.status().last_outcome, "stopped")

    def test_background_motion_expires_with_a_zero_command(self) -> None:
        published: list[VelocityCommand] = []
        completed = threading.Event()

        def publish(command: VelocityCommand) -> None:
            published.append(command)
            if command == VelocityCommand.zero():
                completed.set()

        runtime = MotionRuntime(publish, publish_hz=100.0)
        runtime.start(VelocityCommand(0.1, 0.0, 0.0, 0.03))

        self.assertTrue(completed.wait(timeout=1.0))
        self.assertFalse(runtime.status().active)
        self.assertEqual(published[-1], VelocityCommand.zero())

    def test_overlapping_motion_is_rejected(self) -> None:
        first_nonzero = threading.Event()
        runtime = MotionRuntime(
            lambda command: first_nonzero.set() if command.linear_x != 0.0 else None,
            publish_hz=100.0,
        )

        thread = threading.Thread(
            target=lambda: runtime.execute(VelocityCommand(0.1, 0.0, 0.0, 1.0))
        )
        thread.start()
        self.assertTrue(first_nonzero.wait(timeout=1.0))

        with self.assertRaises(MotionBusyError):
            runtime.execute(VelocityCommand(-0.1, 0.0, 0.0, 0.2))

        runtime.stop()
        thread.join(timeout=1.0)
        self.assertFalse(thread.is_alive())

    def test_motion_parameters_accept_trusted_positive_values_without_range_caps(self) -> None:
        self.assertEqual(validate_motion_request(0.1, 1.0), (0.1, 1.0))
        self.assertEqual(validate_motion_request(0.001, 0.01), (0.001, 0.01))
        self.assertEqual(validate_motion_request(0.21, 2.1), (0.21, 2.1))
        self.assertEqual(validate_motion_request(5.0, 60.0), (5.0, 60.0))

    def test_motion_parameters_reject_non_positive_or_non_finite_values(self) -> None:
        invalid_requests = (
            (0.0, 1.0),
            (-0.1, 1.0),
            (0.1, 0.0),
            (0.1, -1.0),
            (float("nan"), 1.0),
            (0.1, float("inf")),
            (True, 1.0),
        )

        for speed_mps, duration_s in invalid_requests:
            with self.subTest(speed_mps=speed_mps, duration_s=duration_s):
                with self.assertRaises(ValueError):
                    validate_motion_request(speed_mps, duration_s)

    def test_default_mode_is_dry_run_and_invalid_mode_fails(self) -> None:
        self.assertIs(read_runtime_mode({}), RuntimeMode.DRY_RUN)
        self.assertIs(read_runtime_mode({"DIMOS_DOG_MCP_MODE": "go2"}), RuntimeMode.GO2)
        with self.assertRaises(ValueError):
            read_runtime_mode({"DIMOS_DOG_MCP_MODE": "live"})

    def test_mcp_listener_defaults_to_loopback_and_supports_remote_binding(self) -> None:
        self.assertEqual(
            read_mcp_server_config({}),
            McpServerConfig(host="127.0.0.1", port=9990),
        )
        self.assertEqual(
            read_mcp_server_config(
                {
                    "DIMOS_DOG_MCP_HOST": "0.0.0.0",
                    "DIMOS_DOG_MCP_PORT": "10090",
                }
            ),
            McpServerConfig(host="0.0.0.0", port=10090),
        )

    def test_mcp_listener_rejects_invalid_host_or_port(self) -> None:
        invalid_environments = (
            {"DIMOS_DOG_MCP_HOST": " "},
            {"DIMOS_DOG_MCP_PORT": "0"},
            {"DIMOS_DOG_MCP_PORT": "65536"},
            {"DIMOS_DOG_MCP_PORT": "not-a-port"},
        )
        for environment in invalid_environments:
            with self.subTest(environment=environment):
                with self.assertRaises(ValueError):
                    read_mcp_server_config(environment)

    def test_robot_ip_is_added_to_both_no_proxy_spellings(self) -> None:
        environment = {
            "NO_PROXY": "localhost,127.0.0.1",
            "no_proxy": "localhost",
        }

        configure_robot_no_proxy("192.168.12.1", environment)
        configure_robot_no_proxy("192.168.12.1", environment)

        self.assertEqual(
            environment["NO_PROXY"],
            "localhost,127.0.0.1,192.168.12.1",
        )
        self.assertEqual(
            environment["no_proxy"],
            "localhost,192.168.12.1",
        )
