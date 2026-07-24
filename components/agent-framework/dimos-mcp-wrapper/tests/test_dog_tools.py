from __future__ import annotations

import unittest

from dimos_mcp_wrapper.dog_tools import DogMcpTools


class RecordingForwarder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    def forward(self, tool_name: str, arguments: dict[str, object]) -> str:
        self.calls.append((tool_name, dict(arguments)))
        return tool_name


class DogMcpToolsTests(unittest.TestCase):
    def test_dog_commands_forward_to_the_matching_upstream_tool(self) -> None:
        forwarder = RecordingForwarder()
        tools = DogMcpTools(forwarder)

        self.assertEqual(tools.move_forward(0.12, 0.4), "move_forward")
        self.assertEqual(tools.move_backward(0.08, 0.3), "move_backward")
        self.assertEqual(tools.stop_all(), "stop_all")
        self.assertEqual(tools.motion_status(), "motion_status")
        self.assertEqual(tools.server_status(), "server_status")
        self.assertEqual(tools.list_modules(), "list_modules")
        self.assertEqual(tools.agent_send("继续"), "agent_send")
        self.assertEqual(tools.relative_move(1.0, -0.5, 90.0), "relative_move")
        self.assertEqual(tools.wait(2.0), "wait")
        self.assertEqual(tools.current_time(), "current_time")
        self.assertEqual(tools.execute_sport_command("Hello"), "execute_sport_command")
        self.assertEqual(tools.get_battery_soc(), "get_battery_soc")
        self.assertEqual(tools.observe(), "observe")
        self.assertEqual(tools.tag_location("门口"), "tag_location")
        self.assertEqual(tools.navigate_with_text("去门口"), "navigate_with_text")
        self.assertEqual(tools.return_to_start(), "return_to_start")
        self.assertEqual(
            tools.return_to_user_and_greet(),
            "return_to_user_and_greet",
        )
        self.assertEqual(tools.begin_exploration(), "begin_exploration")
        self.assertEqual(tools.start_patrol(), "start_patrol")
        self.assertEqual(tools.look_out_for(["人"], None), "look_out_for")
        self.assertEqual(tools.start_stroll(), "start_stroll")

        self.assertEqual(
            forwarder.calls,
            [
                ("move_forward", {"speed_mps": 0.12, "duration_s": 0.4}),
                ("move_backward", {"speed_mps": 0.08, "duration_s": 0.3}),
                ("stop_all", {}),
                ("motion_status", {}),
                ("server_status", {}),
                ("list_modules", {}),
                ("agent_send", {"message": "继续"}),
                ("relative_move", {"forward": 1.0, "left": -0.5, "degrees": 90.0}),
                ("wait", {"seconds": 2.0}),
                ("current_time", {}),
                ("execute_sport_command", {"command_name": "Hello"}),
                ("get_battery_soc", {}),
                ("observe", {}),
                ("tag_location", {"location_name": "门口"}),
                ("navigate_with_text", {"query": "去门口"}),
                ("return_to_start", {}),
                ("return_to_user_and_greet", {}),
                ("begin_exploration", {}),
                ("start_patrol", {}),
                ("look_out_for", {"description_of_things": ["人"], "then": None}),
                ("start_stroll", {}),
            ],
        )
