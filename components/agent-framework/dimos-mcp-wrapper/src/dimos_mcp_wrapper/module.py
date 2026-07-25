"""DIMOS-native MCP skills that forward to the existing dog MCP."""

from __future__ import annotations

from collections.abc import Iterable

from dimos.agents.annotation import skill
from dimos.core.core import rpc
from dimos.core.module import Module, ModuleConfig

from .config import DEFAULT_TIMEOUT_S, DEFAULT_UPSTREAM_URL
from .dog_tools import DEFAULT_DURATION_S, DEFAULT_SPEED_MPS, DogMcpTools
from .forwarding import ForwardingService
from .hooks import McpCallHook
from .upstream import HttpMcpToolClient, McpToolClient


class McpForwardingSkillConfig(ModuleConfig):
    """DIMOS configuration for the one upstream MCP endpoint."""

    upstream_url: str = DEFAULT_UPSTREAM_URL
    timeout_s: float = DEFAULT_TIMEOUT_S


class McpForwardingSkill(Module):
    """Expose dog tools while delegating their work to the upstream MCP server."""

    config: McpForwardingSkillConfig

    _forwarding: ForwardingService
    _dog_tools: DogMcpTools

    def __init__(
        self,
        *,
        hooks: Iterable[McpCallHook] = (),
        upstream_client: McpToolClient | None = None,
        **kwargs: object,
    ) -> None:
        super().__init__(**kwargs)
        client = upstream_client
        if client is None:
            client = HttpMcpToolClient(
                self.config.upstream_url,
                timeout_s=self.config.timeout_s,
            )
        self._forwarding = ForwardingService(client, hooks=hooks)
        self._dog_tools = DogMcpTools(self._forwarding)

    @rpc
    def stop(self) -> None:
        self._forwarding.close()
        super().stop()

    @skill
    def move_forward(
        self,
        speed_mps: float = DEFAULT_SPEED_MPS,
        duration_s: float = DEFAULT_DURATION_S,
    ) -> str:
        """Forward a bounded forward-motion request to the upstream dog MCP.

        Args:
            speed_mps: Forward speed in m/s; validation remains upstream.
            duration_s: Requested motion duration in seconds; validation remains upstream.
        """

        return self._dog_tools.move_forward(speed_mps, duration_s)

    @skill
    def move_backward(
        self,
        speed_mps: float = DEFAULT_SPEED_MPS,
        duration_s: float = DEFAULT_DURATION_S,
    ) -> str:
        """Forward a bounded reverse-motion request to the upstream dog MCP.

        Args:
            speed_mps: Reverse speed magnitude in m/s; validation remains upstream.
            duration_s: Requested motion duration in seconds; validation remains upstream.
        """

        return self._dog_tools.move_backward(speed_mps, duration_s)

    @skill
    def stop_all(self) -> str:
        """Forward one unified stop request before any deferred hook work."""

        return self._dog_tools.stop_all()

    @skill
    def motion_status(self) -> str:
        """Forward the upstream motion-status request without synthesizing telemetry."""

        return self._dog_tools.motion_status()

    @skill
    def get_robot_summary(self) -> str:
        """Forward the upstream odometry path and freshness summary."""

        return self._dog_tools.get_robot_summary()

    @skill
    def server_status(self) -> str:
        """Forward the official DIMOS MCP server-status query."""

        return self._dog_tools.server_status()

    @skill
    def list_modules(self) -> str:
        """Forward the official DIMOS deployed-module query."""

        return self._dog_tools.list_modules()

    @skill
    def agent_send(self, message: str) -> str:
        """Forward a message to the lower DIMOS agent transport."""

        return self._dog_tools.agent_send(message)

    @skill
    def relative_move(
        self,
        forward: float = 0.0,
        left: float = 0.0,
        degrees: float = 0.0,
    ) -> str:
        """Forward official relative movement in the robot's current frame."""

        return self._dog_tools.relative_move(forward, left, degrees)

    @skill
    def wait(self, seconds: float) -> str:
        """Forward the official DIMOS wait tool."""

        return self._dog_tools.wait(seconds)

    @skill
    def current_time(self) -> str:
        """Forward the official DIMOS current-time tool."""

        return self._dog_tools.current_time()

    @skill
    def execute_sport_command(self, command_name: str) -> str:
        """Forward a named Unitree sport command."""

        return self._dog_tools.execute_sport_command(command_name)

    @skill
    def get_battery_soc(self) -> str:
        """Forward the official Go2 battery state-of-charge query."""

        return self._dog_tools.get_battery_soc()

    @skill
    def observe(self) -> str:
        """Forward the official Go2 camera observation tool."""

        return self._dog_tools.observe()

    @skill
    def follow_person(self, query: str) -> str:
        """Start the official DimOS visual person-follow mode.

        Args:
            query: Visual description of the person to lock initially.
        """

        return self._dog_tools.follow_person(query)

    @skill
    def tag_location(self, location_name: str) -> str:
        """Tag the robot's current mapped location with a reusable name.

        Args:
            location_name: Human-readable name for the current mapped position.
        """

        return self._dog_tools.tag_location(location_name)

    @skill
    def navigate_with_text(self, query: str) -> str:
        """Resolve a textual destination and start official DIMOS navigation.

        Args:
            query: Natural-language destination or tagged location name.
        """

        return self._dog_tools.navigate_with_text(query)

    @skill
    def stop_navigation(self) -> str:
        """Cancel the active official DIMOS navigation goal."""

        return self._dog_tools.stop_navigation()

    @skill
    def return_to_start(self) -> str:
        """Return to the first valid odometry pose captured by the upstream process."""

        return self._dog_tools.return_to_start()

    @skill
    def return_to_user_and_greet(self) -> str:
        """Return to the fixed user location, settle for one second, and greet."""

        return self._dog_tools.return_to_user_and_greet()

    @skill
    def begin_exploration(self) -> str:
        """Start official DIMOS wavefront frontier exploration."""

        return self._dog_tools.begin_exploration()

    @skill
    def start_patrol(self) -> str:
        """Start official DIMOS autonomous patrol over the known map."""

        return self._dog_tools.start_patrol()

    @skill
    def look_out_for(
        self,
        description_of_things: list[str],
        then: dict[str, object] | None = None,
    ) -> str:
        """Continuously look for one of the described things."""

        return self._dog_tools.look_out_for(description_of_things, then)

    @skill
    def start_stroll(self) -> str:
        """Start non-exhaustive, branch-committing human-like strolling."""

        return self._dog_tools.start_stroll()

    @skill
    def start_task(self, task_json: str) -> str:
        """Submit one canonical mission to the upstream MissionExecutor.

        Args:
            task_json: Canonical TaskSpec JSON owned by the Gateway.
        """

        return self._dog_tools.start_task(task_json)

    @skill
    def pause_task(self, task_id: str) -> str:
        """Pause one active canonical mission by stable task ID."""

        return self._dog_tools.pause_task(task_id)

    @skill
    def resume_task(self, task_id: str) -> str:
        """Resume one paused canonical mission by stable task ID."""

        return self._dog_tools.resume_task(task_id)

    @skill
    def cancel_task(self, task_id: str) -> str:
        """Cancel one canonical mission and wait for upstream navigation idle."""

        return self._dog_tools.cancel_task(task_id)

    @skill
    def get_task_status(self) -> str:
        """Read the upstream canonical mission snapshot."""

        return self._dog_tools.get_task_status()

    @skill
    def list_semantic_places(self) -> str:
        """List confirmed places for the upstream Runtime's current map."""

        return self._dog_tools.list_semantic_places()

    @skill
    def confirm_semantic_place(self, place_json: str) -> str:
        """Store one operator-confirmed place in the current semantic map.

        Args:
            place_json: Strict SemanticPlaceDraft JSON built from fresh odometry.
        """

        return self._dog_tools.confirm_semantic_place(place_json)
