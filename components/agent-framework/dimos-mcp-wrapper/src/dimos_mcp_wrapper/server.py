"""Restricted DIMOS MCP server for the wrapper's public forwarding contract."""

from __future__ import annotations

from dimos.agents.mcp.mcp_server import McpServer, app
from dimos.core.core import rpc
from dimos.core.module import ModuleConfig, SkillInfo
from dimos.core.rpc_client import RpcCall, RPCClient

from .config import DEFAULT_MCP_PORT, ToolProfile, read_wrapper_config


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
        "start_task",
        "pause_task",
        "resume_task",
        "cancel_task",
        "get_task_status",
        "list_semantic_places",
        "confirm_semantic_place",
    }
)

VALIDATION_TOOL_NAMES = frozenset(
    {
        "relative_move",
        "return_to_start",
        "motion_status",
        "get_robot_summary",
        "stop_all",
    }
)


def public_tool_names_for_profile(profile: ToolProfile) -> frozenset[str]:
    """Return the exact allowlist for one explicit deployment profile."""

    if profile is ToolProfile.VALIDATION:
        return VALIDATION_TOOL_NAMES
    return PRODUCT_TOOL_NAMES


class WrapperMcpServerConfig(ModuleConfig):
    """Configuration that must survive serialization into the worker."""

    mcp_port: int = DEFAULT_MCP_PORT


class WrapperMcpServer(McpServer):
    """Expose only forwarding tools and hide DIMOS server-management skills."""

    config: WrapperMcpServerConfig

    def _start_server(self, port: int | None = None) -> None:
        """Bind the configured wrapper port inside the spawned worker process."""

        super()._start_server(self.config.mcp_port if port is None else port)

    @rpc
    def get_skills(self) -> list[SkillInfo]:
        return []

    @rpc
    def on_system_modules(self, modules: list[RPCClient]) -> None:
        """Restrict DIMOS's dynamic skill registry to the forwarding allowlist."""

        assert self.rpc is not None
        public_tool_names = public_tool_names_for_profile(
            read_wrapper_config().tool_profile
        )
        app.state.skills = [
            skill_info
            for module in modules
            for skill_info in (module.get_skills() or [])
            if skill_info.func_name in public_tool_names
        ]
        app.state.skills_by_name = {
            skill.func_name: skill for skill in app.state.skills
        }
        app.state.rpc_calls = {
            skill.func_name: RpcCall(
                None,
                self.rpc,
                skill.func_name,
                skill.class_name,
                [],
            )
            for skill in app.state.skills
        }
