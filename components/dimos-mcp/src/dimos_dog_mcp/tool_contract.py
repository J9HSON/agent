"""Public MCP tool contract for the pinned DiMOS release and local extensions."""

from __future__ import annotations

from .config import ToolProfile


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
        "follow_person",
        "stop_following",
        "tag_location",
        "navigate_with_text",
        "stop_navigation",
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
        "get_robot_summary",
        "return_to_start",
        "return_to_user_and_greet",
        "start_stroll",
        "stop_all",
    }
)

MISSION_TOOL_NAMES = frozenset(
    {
        "start_task",
        "pause_task",
        "resume_task",
        "cancel_task",
        "get_task_status",
        "list_semantic_places",
        "confirm_semantic_place",
    }
)

LEGACY_MOVEMENT_TOOL_NAMES = frozenset(
    {
        "move_forward",
        "move_backward",
        "relative_move",
        "execute_sport_command",
        "return_to_start",
        "return_to_user_and_greet",
        "begin_exploration",
        "start_patrol",
        "look_out_for",
        "start_stroll",
    }
)

PRODUCT_TOOL_NAMES = frozenset(
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
        *MISSION_TOOL_NAMES,
    }
)

MAINTENANCE_TOOL_NAMES = (
    OFFICIAL_MCP_SERVER_TOOL_NAMES
    | OFFICIAL_ROBOT_TOOL_NAMES
    | CUSTOM_TOOL_NAMES
    | MISSION_TOOL_NAMES
)

PUBLIC_TOOL_NAMES = MAINTENANCE_TOOL_NAMES


def public_tool_names_for_profile(profile: ToolProfile) -> frozenset[str]:
    """Return the exact MCP allowlist for one deployment profile."""

    if profile is ToolProfile.MAINTENANCE:
        return MAINTENANCE_TOOL_NAMES
    return PRODUCT_TOOL_NAMES
