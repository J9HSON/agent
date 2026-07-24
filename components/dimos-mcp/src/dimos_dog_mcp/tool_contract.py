"""Public MCP tool contract for the pinned DiMOS release and local extensions."""

from __future__ import annotations


OFFICIAL_MCP_SERVER_TOOL_NAMES = frozenset(
    {
        "server_status",
        "list_modules",
        "agent_send",
    }
)

OFFICIAL_ROBOT_TOOL_NAMES = frozenset(
    {
        "relative_move",
        "wait",
        "current_time",
        "execute_sport_command",
        "get_battery_soc",
        "observe",
        "tag_location",
        "navigate_with_text",
        "begin_exploration",
        "start_patrol",
        "look_out_for",
    }
)

CUSTOM_TOOL_NAMES = frozenset(
    {
        "move_forward",
        "move_backward",
        "motion_status",
        "return_to_start",
        "return_to_user_and_greet",
        "start_stroll",
        "stop_all",
    }
)

PUBLIC_TOOL_NAMES = OFFICIAL_MCP_SERVER_TOOL_NAMES | OFFICIAL_ROBOT_TOOL_NAMES | CUSTOM_TOOL_NAMES
