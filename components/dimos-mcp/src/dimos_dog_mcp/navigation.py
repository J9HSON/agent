"""Stable navigation skill surface for dry-run and the official Go2 stack."""

from __future__ import annotations

import json
from threading import RLock

from dimos.agents.annotation import skill
from dimos.core.core import rpc
from dimos.core.module import Module
from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from dimos.navigation.base import NavigationState


class DryRunNavigationSkill(Module):
    """Expose the navigation contract without pretending to navigate in dry-run."""

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._state = NavigationState.IDLE
        self._goal: PoseStamped | None = None
        self._lock = RLock()

    @rpc
    def set_goal(self, goal: PoseStamped) -> bool:
        """Record a replay goal without publishing to hardware."""

        with self._lock:
            self._goal = goal
            self._state = NavigationState.FOLLOWING_PATH
        return True

    @rpc
    def get_state(self) -> NavigationState:
        """Return the deterministic replay navigation state."""

        with self._lock:
            return self._state

    @rpc
    def is_goal_reached(self) -> bool:
        """Keep replay missions active until explicitly cancelled."""

        return False

    @rpc
    def cancel_goal(self) -> bool:
        """Cancel the replay goal and return to idle without hardware I/O."""

        with self._lock:
            self._goal = None
            self._state = NavigationState.IDLE
        return True

    @skill
    def relative_move(
        self,
        forward: float = 0.0,
        left: float = 0.0,
        degrees: float = 0.0,
    ) -> str:
        """Report that relative navigation requires the live Go2 stack."""

        return self._unavailable(
            "relative_move",
            {"forward": forward, "left": left, "degrees": degrees},
        )

    @skill
    def wait(self, seconds: float) -> str:
        """Report that the official robot wait tool requires Go2 mode."""

        return self._unavailable("wait", {"seconds": seconds})

    @skill
    def current_time(self) -> str:
        """Report that the official Go2 tool container is not active."""

        return self._unavailable("current_time")

    @skill
    def execute_sport_command(self, command_name: str) -> str:
        """Report that Unitree sport commands require a live Go2 connection."""

        return self._unavailable("execute_sport_command", {"command_name": command_name})

    @skill
    def get_battery_soc(self) -> str:
        """Report that battery telemetry requires a live Go2 connection."""

        return self._unavailable("get_battery_soc")

    @skill
    def observe(self) -> str:
        """Report that camera observation requires a live Go2 connection."""

        return self._unavailable("observe")

    @skill
    def tag_location(self, location_name: str) -> str:
        """Report that location tagging requires the live Go2 navigation stack."""

        return self._unavailable("tag_location", {"location_name": location_name})

    @skill
    def navigate_with_text(self, query: str) -> str:
        """Report that semantic navigation requires the live Go2 navigation stack."""

        return self._unavailable("navigate_with_text", {"query": query})

    @skill
    def return_to_start(self) -> str:
        """Report that session-start navigation requires the live Go2 stack."""

        return self._unavailable("return_to_start")

    @skill
    def return_to_user_and_greet(self) -> str:
        """Report that user-location navigation and greeting require Go2 mode."""

        return self._unavailable("return_to_user_and_greet")

    @skill
    def stop_navigation(self) -> str:
        """Cancel any replay goal without touching hardware."""

        self.cancel_goal()
        return json.dumps(
            {
                "status": "stopped",
                "mode": "dry-run",
                "hardware_io": False,
            }
        )

    @skill
    def begin_exploration(self) -> str:
        """Report that autonomous exploration requires the live Go2 stack."""

        return self._unavailable("begin_exploration")

    @rpc
    def end_exploration(self) -> str:
        """Report that no live exploration process is active in dry-run."""

        return self._unavailable("end_exploration")

    @skill
    def start_patrol(self) -> str:
        """Report that autonomous patrol requires the live Go2 stack."""

        return self._unavailable("start_patrol")

    @rpc
    def stop_patrol(self) -> str:
        """Report that no live patrol process is active in dry-run."""

        return self._unavailable("stop_patrol")

    @skill
    def start_stroll(self) -> str:
        """Report that human-like strolling requires the live Go2 stack."""

        return self._unavailable("start_stroll")

    @rpc
    def stop_stroll(self) -> str:
        """Report that no live stroll is active in dry-run."""

        return self._unavailable("stop_stroll")

    @skill
    def look_out_for(
        self,
        description_of_things: list[str],
        then: dict[str, object] | None = None,
    ) -> str:
        """Report that continuous visual perception requires the live Go2 stack."""

        return self._unavailable(
            "look_out_for",
            {"description_of_things": description_of_things, "then": then},
        )

    @rpc
    def stop_looking_out(self) -> str:
        """Report that no live visual lookout is active in dry-run."""

        return self._unavailable("stop_looking_out")

    @staticmethod
    def _unavailable(tool_name: str, arguments: dict[str, object] | None = None) -> str:
        return json.dumps(
            {
                "status": "error",
                "error": f"{tool_name} requires DIMOS_DOG_MCP_MODE=go2",
                "required_mode": "go2",
                "arguments": arguments or {},
            },
            ensure_ascii=False,
        )
