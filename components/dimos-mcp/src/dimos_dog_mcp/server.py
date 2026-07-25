"""Restricted DIMOS MCP server exposing only the framework's public tools."""

from __future__ import annotations

from dataclasses import asdict
import json
import os

from dimos.agents.annotation import skill
from dimos.agents.mcp.mcp_server import McpServer, app
from dimos.core.core import rpc
from dimos.core.module import SkillInfo
from dimos.core.rpc_client import RpcCall, RPCClient

from .config import read_tool_profile
from .runtime_owner import read_runtime_owner_metadata, utc_now_iso
from .tool_contract import (
    OFFICIAL_MCP_SERVER_TOOL_NAMES,
    public_tool_names_for_profile,
)


class DogMcpServer(McpServer):
    """Publish only the explicit dog MCP contract on the network endpoint."""

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._server_started_at = utc_now_iso()

    @skill
    def server_status(self) -> str:
        """Identify the one runtime owner and its currently published modules."""

        skills: list[SkillInfo] = app.state.skills
        modules = list(dict.fromkeys(item.class_name for item in skills))
        owner = read_runtime_owner_metadata(
            fallback_started_at=self._server_started_at
        )
        tool_profile = read_tool_profile()
        return json.dumps(
            {
                "pid": owner.pid,
                "mode": owner.mode,
                "robot_ip": owner.robot_ip,
                "module_count": len(modules),
                "started_at": owner.started_at,
                "modules": modules,
                "skills": [item.func_name for item in skills],
                "tool_profile": tool_profile.value,
                "runtime_owner": asdict(owner),
                "server_worker_pid": os.getpid(),
            }
        )

    @rpc
    def get_skills(self) -> list[SkillInfo]:
        """Expose the pinned official MCP management tools."""

        return [
            skill_info
            for skill_info in super().get_skills()
            if skill_info.func_name in OFFICIAL_MCP_SERVER_TOOL_NAMES
        ]

    @rpc
    def on_system_modules(self, modules: list[RPCClient]) -> None:
        """Restrict DIMOS's dynamic skill registry to the public allowlist."""

        assert self.rpc is not None
        public_tool_names = public_tool_names_for_profile(read_tool_profile())
        app.state.skills = [
            skill_info
            for module in modules
            for skill_info in (module.get_skills() or [])
            if skill_info.func_name in public_tool_names
        ]
        app.state.skills_by_name = {skill.func_name: skill for skill in app.state.skills}
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
