from __future__ import annotations

import unittest
from unittest.mock import patch

from dimos.agents.mcp.mcp_server import McpServer
from dimos_mcp_wrapper.config import ToolProfile
from dimos_mcp_wrapper.server import WrapperMcpServer, public_tool_names_for_profile


class WrapperServerProfileTests(unittest.TestCase):
    def test_validation_profile_exposes_exactly_the_stage_one_tools(self) -> None:
        self.assertEqual(
            public_tool_names_for_profile(ToolProfile.VALIDATION),
            frozenset(
                {
                    "relative_move",
                    "return_to_start",
                    "motion_status",
                    "get_robot_summary",
                    "stop_all",
                }
            ),
        )

    def test_product_profile_restores_official_s2_tools_with_only_relative_move(
        self,
    ) -> None:
        tools = public_tool_names_for_profile(ToolProfile.PRODUCT)

        self.assertEqual(
            tools,
            frozenset(
                {
                    "stop_all",
                    "motion_status",
                    "get_robot_summary",
                    "server_status",
                    "list_modules",
                    "current_time",
                    "get_battery_soc",
                    "observe",
                    "follow_person",
                    "relative_move",
                    "tag_location",
                    "navigate_with_text",
                    "stop_navigation",
                    "start_task",
                    "pause_task",
                    "resume_task",
                    "cancel_task",
                    "get_task_status",
                    "list_semantic_places",
                    "confirm_semantic_place",
                }
            ),
        )
        self.assertNotIn("begin_exploration", tools)
        self.assertNotIn("execute_sport_command", tools)
        self.assertNotIn("move_forward", tools)

    def test_wrapper_server_uses_serialized_configured_port(self) -> None:
        with patch.object(McpServer, "_start_server") as start_server:
            server = WrapperMcpServer(mcp_port=12491)
            server._start_server()

        start_server.assert_called_once_with(12491)


if __name__ == "__main__":
    unittest.main()
