"""Entry point that composes the motion skills with DIMOS's native MCP server."""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache
from importlib import import_module

from dimos_go2_studio.mission_executor import MissionExecutor
from dimos_go2_studio.semantic_world import SemanticWorld

from dimos.core.coordination.blueprints import autoconnect
from dimos.core.coordination.module_coordinator import ModuleCoordinator
from dimos.core.global_config import global_config

from .config import (
    McpServerConfig,
    RelocalizationRuntimeConfig,
    RuntimeMode,
    configure_robot_no_proxy,
    read_mcp_server_config,
    read_relocalization_runtime_config,
    read_runtime_mode,
    read_semantic_runtime_config,
)
from .dry_run import DryRunTwistSink
from .go2_locomotion import enable_go2_locomotion
from .home import HomeNavigationSkill
from .module import DogMotionSkill
from .navigation import DryRunNavigationSkill
from .robot_summary import DryRunRobotSummarySkill, RobotSummarySkill
from .runtime_owner import claim_runtime
from .semantic_visualization import SemanticVisualizationAdapter
from .server import DogMcpServer
from .stop import StopAllSkill
from .stroll import StrollSkill


@dataclass(frozen=True)
class _Go2Dependencies:
    unitree_go2: object
    relocalization_module: type[object]
    spatial_memory: type[object]
    navigation_skill_container: type[object]
    person_follow_skill_container: type[object]
    go2_connection: type[object]
    unitree_skill_container: type[object]
    go2_stop_all_skill: type[object]


class Go2DependenciesUnavailableError(RuntimeError):
    """Raised when Go2 mode is selected without its optional dependency stack."""


@cache
def _load_go2_dependencies() -> _Go2Dependencies:
    """Load the optional Unitree stack only in processes that build or use it."""

    try:
        go2_module = import_module(
            "dimos.robot.unitree.go2.blueprints.smart.unitree_go2"
        )
        relocalization_module = import_module(
            "dimos.mapping.relocalization.module"
        )
        spatial_memory_module = import_module("dimos.perception.spatial_perception")
        navigation_skill_module = import_module("dimos.agents.skills.navigation")
        person_follow_module = import_module("dimos.agents.skills.person_follow")
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
        unitree_go2=go2_module.unitree_go2,
        relocalization_module=relocalization_module.RelocalizationModule,
        spatial_memory=spatial_memory_module.SpatialMemory,
        navigation_skill_container=navigation_skill_module.NavigationSkillContainer,
        person_follow_skill_container=person_follow_module.PersonFollowSkillContainer,
        go2_connection=connection_module.GO2Connection,
        unitree_skill_container=unitree_skills_module.UnitreeSkillContainer,
        go2_stop_all_skill=go2_stop_module.Go2StopAllSkill,
    )


def build_blueprint():
    """Build an MCP blueprint using dry-run unless Go2 mode is explicitly selected."""

    runtime_mode = read_runtime_mode()
    semantic_config = read_semantic_runtime_config(runtime_mode)
    semantic_kwargs = {
        "storage_path": semantic_config.storage_path,
        "map_id": semantic_config.map_id,
        "map_version": semantic_config.map_version,
    }
    if runtime_mode is RuntimeMode.GO2:
        semantic_kwargs.update(
            canonical_frame_id="map",
            navigation_frame_id="world",
        )
    semantic_world = SemanticWorld.blueprint(
        **semantic_kwargs,
    )
    if runtime_mode is RuntimeMode.GO2:
        return _build_go2_blueprint(
            semantic_world,
            read_relocalization_runtime_config(),
        )
    return autoconnect(
        DryRunTwistSink.blueprint(),
        DogMotionSkill.blueprint(),
        DryRunNavigationSkill.blueprint(),
        DryRunRobotSummarySkill.blueprint(),
        StopAllSkill.blueprint(),
        semantic_world,
        MissionExecutor.blueprint(),
        DogMcpServer.blueprint(),
    )


def _build_go2_blueprint(
    semantic_world,
    relocalization_config: RelocalizationRuntimeConfig,
):
    """Compose the official DIMOS mapping, planning, exploration, and patrol stack."""

    dependencies = _load_go2_dependencies()
    return autoconnect(
        dependencies.unitree_go2,
        dependencies.relocalization_module.blueprint(
            map_file=str(relocalization_config.map_file),
            min_local_points=relocalization_config.min_local_points,
        ),
        # Restore DimOS' official S2 location memory and text-navigation skills.
        # Keep the location collection across Runtime restarts.
        dependencies.spatial_memory.blueprint(new_memory=False),
        dependencies.navigation_skill_container.blueprint(),
        dependencies.person_follow_skill_container.blueprint(
            camera_info=dependencies.go2_connection.camera_info_static,
        ),
        dependencies.unitree_skill_container.blueprint(),
        HomeNavigationSkill.blueprint(),
        # Subscribe before the canonical state owners publish their first snapshot.
        SemanticVisualizationAdapter.blueprint(
            visualization_frame_id="world",
        ),
        RobotSummarySkill.blueprint(stable_frame_id="map"),
        StrollSkill.blueprint(),
        DogMotionSkill.blueprint(),
        dependencies.go2_stop_all_skill.blueprint(),
        semantic_world,
        MissionExecutor.blueprint(),
        DogMcpServer.blueprint(),
    ).global_config(n_workers=13)


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
    if runtime_mode is RuntimeMode.GO2 and global_config.robot_ip:
        configure_robot_no_proxy(global_config.robot_ip)
    with claim_runtime(server_config, runtime_mode) as owner:
        configure_mcp_listener(server_config)
        coordinator = ModuleCoordinator.build(build_blueprint())
        if runtime_mode is RuntimeMode.GO2:
            try:
                initialize_go2_runtime(coordinator)
            except Exception:
                coordinator.stop()
                raise
        print(
            "DIMOS dog MCP owner "
            f"pid={owner.pid} mode={owner.mode} robot_ip={owner.robot_ip or 'unset'} "
            f"listening on {server_config.host}:{server_config.port}/mcp"
        )
        coordinator.loop()


if __name__ == "__main__":
    main()
