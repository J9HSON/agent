"""Entry point that composes the motion skills with DIMOS's native MCP server."""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache
from importlib import import_module

from dimos.core.coordination.blueprints import autoconnect
from dimos.core.coordination.module_coordinator import ModuleCoordinator
from dimos.core.global_config import global_config

from .agent_bridge import StandaloneAgentBridge
from .config import McpServerConfig, RuntimeMode, read_mcp_server_config, read_runtime_mode
from .dry_run import DryRunTwistSink
from .go2_locomotion import enable_go2_locomotion
from .home import HomeNavigationSkill
from .module import DogMotionSkill
from .navigation import DryRunNavigationSkill
from .server import DogMcpServer
from .stop import StopAllSkill
from .stroll import StrollSkill


@dataclass(frozen=True)
class _Go2Dependencies:
    navigation_skill_container: type[object]
    unitree_go2_spatial: object
    go2_connection: type[object]
    unitree_skill_container: type[object]
    go2_stop_all_skill: type[object]


class Go2DependenciesUnavailableError(RuntimeError):
    """Raised when Go2 mode is selected without its optional dependency stack."""


@cache
def _load_go2_dependencies() -> _Go2Dependencies:
    """Load the optional Unitree stack only in processes that build or use it."""

    try:
        navigation_module = import_module("dimos.agents.skills.navigation")
        spatial_module = import_module(
            "dimos.robot.unitree.go2.blueprints.smart.unitree_go2_spatial"
        )
        connection_module = import_module("dimos.robot.unitree.go2.connection")
        unitree_skills_module = import_module(
            "dimos.robot.unitree.unitree_skill_container"
        )
        go2_stop_module = import_module(".go2_stop", package=__package__)
    except ModuleNotFoundError as error:
        missing_module = error.name or "unknown"
        raise Go2DependenciesUnavailableError(
            "Go2 navigation mode requires the optional dependency; "
            f"install dimos-dog-mcp[go2] (missing module: {missing_module})"
        ) from error

    return _Go2Dependencies(
        navigation_skill_container=navigation_module.NavigationSkillContainer,
        unitree_go2_spatial=spatial_module.unitree_go2_spatial,
        go2_connection=connection_module.GO2Connection,
        unitree_skill_container=unitree_skills_module.UnitreeSkillContainer,
        go2_stop_all_skill=go2_stop_module.Go2StopAllSkill,
    )


def build_blueprint():
    """Build an MCP blueprint using dry-run unless Go2 mode is explicitly selected."""

    if read_runtime_mode() is RuntimeMode.GO2:
        return _build_go2_blueprint()
    return autoconnect(
        DryRunTwistSink.blueprint(),
        DogMotionSkill.blueprint(),
        DryRunNavigationSkill.blueprint(),
        StopAllSkill.blueprint(),
        DogMcpServer.blueprint(),
    )


def _build_go2_blueprint():
    """Compose the official DIMOS mapping, planning, exploration, and patrol stack."""

    dependencies = _load_go2_dependencies()
    return autoconnect(
        dependencies.unitree_go2_spatial,
        dependencies.navigation_skill_container.blueprint(),
        dependencies.unitree_skill_container.blueprint(),
        HomeNavigationSkill.blueprint(),
        StrollSkill.blueprint(),
        DogMotionSkill.blueprint(),
        dependencies.go2_stop_all_skill.blueprint(),
        StandaloneAgentBridge.blueprint(),
        DogMcpServer.blueprint(),
    )


def configure_mcp_listener(config: McpServerConfig) -> None:
    """Apply the standalone listener configuration to DIMOS."""

    global_config.update(listen_host=config.host, mcp_port=config.port)


def initialize_go2_runtime(coordinator: ModuleCoordinator) -> None:
    """Enable Go2 joystick input after all official modules have started."""

    dependencies = _load_go2_dependencies()
    connection = coordinator.get_instance(dependencies.go2_connection)
    if connection is None:
        raise RuntimeError("Go2 runtime did not deploy GO2Connection")
    enable_go2_locomotion(connection)


def main() -> None:
    """Run the DIMOS module coordinator until the process is stopped."""

    server_config = read_mcp_server_config()
    runtime_mode = read_runtime_mode()
    configure_mcp_listener(server_config)
    coordinator = ModuleCoordinator.build(build_blueprint())
    if runtime_mode is RuntimeMode.GO2:
        try:
            initialize_go2_runtime(coordinator)
        except Exception:
            coordinator.stop()
            raise
    print(f"DIMOS dog MCP listening on {server_config.host}:{server_config.port}/mcp")
    coordinator.loop()


if __name__ == "__main__":
    main()
