"""The fixed machine-dog tool surface exposed by the wrapper MCP."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol


DEFAULT_SPEED_MPS = 0.1
DEFAULT_DURATION_S = 1.0


class ToolForwarder(Protocol):
    """The forwarding service contract consumed by the public dog tools."""

    def forward(self, tool_name: str, arguments: Mapping[str, object]) -> str:
        """Forward one named tool call."""


class DogMcpTools:
    """Map the stable dog-tool API to same-named upstream MCP tools."""

    def __init__(self, forwarder: ToolForwarder) -> None:
        self._forwarder = forwarder

    def move_forward(self, speed_mps: float, duration_s: float) -> str:
        """Forward a forward-motion request without changing its arguments."""

        return self._forwarder.forward(
            "move_forward",
            {"speed_mps": speed_mps, "duration_s": duration_s},
        )

    def move_backward(self, speed_mps: float, duration_s: float) -> str:
        """Forward a reverse-motion request without changing its arguments."""

        return self._forwarder.forward(
            "move_backward",
            {"speed_mps": speed_mps, "duration_s": duration_s},
        )

    def stop_all(self) -> str:
        """Forward one unified stop request without inserting a retry or delay."""

        return self._forwarder.forward("stop_all", {})

    def motion_status(self) -> str:
        """Forward the upstream local motion-status request."""

        return self._forwarder.forward("motion_status", {})

    def get_robot_summary(self) -> str:
        """Forward the upstream odometry-based robot summary."""

        return self._forwarder.forward("get_robot_summary", {})

    def server_status(self) -> str:
        return self._forwarder.forward("server_status", {})

    def list_modules(self) -> str:
        return self._forwarder.forward("list_modules", {})

    def agent_send(self, message: str) -> str:
        return self._forwarder.forward("agent_send", {"message": message})

    def relative_move(self, forward: float, left: float, degrees: float) -> str:
        return self._forwarder.forward(
            "relative_move",
            {"forward": forward, "left": left, "degrees": degrees},
        )

    def wait(self, seconds: float) -> str:
        return self._forwarder.forward("wait", {"seconds": seconds})

    def current_time(self) -> str:
        return self._forwarder.forward("current_time", {})

    def execute_sport_command(self, command_name: str) -> str:
        return self._forwarder.forward(
            "execute_sport_command",
            {"command_name": command_name},
        )

    def get_battery_soc(self) -> str:
        return self._forwarder.forward("get_battery_soc", {})

    def observe(self) -> str:
        return self._forwarder.forward("observe", {})

    def follow_person(self, query: str) -> str:
        """Start the upstream official visual person-follow skill."""

        return self._forwarder.forward("follow_person", {"query": query})

    def tag_location(self, location_name: str) -> str:
        """Forward a request to tag the robot's current mapped location."""

        return self._forwarder.forward("tag_location", {"location_name": location_name})

    def navigate_with_text(self, query: str) -> str:
        """Forward a semantic navigation request to the official DIMOS stack."""

        return self._forwarder.forward("navigate_with_text", {"query": query})

    def stop_navigation(self) -> str:
        """Forward one official navigation-cancel request."""

        return self._forwarder.forward("stop_navigation", {})

    def return_to_start(self) -> str:
        """Forward navigation to the upstream process's captured start pose."""

        return self._forwarder.forward("return_to_start", {})

    def return_to_user_and_greet(self) -> str:
        """Forward the atomic return-to-user and greeting sequence."""

        return self._forwarder.forward("return_to_user_and_greet", {})

    def begin_exploration(self) -> str:
        """Forward startup of DIMOS wavefront frontier exploration."""

        return self._forwarder.forward("begin_exploration", {})

    def start_patrol(self) -> str:
        """Forward startup of DIMOS autonomous patrol."""

        return self._forwarder.forward("start_patrol", {})

    def look_out_for(
        self,
        description_of_things: list[str],
        then: dict[str, object] | None,
    ) -> str:
        return self._forwarder.forward(
            "look_out_for",
            {"description_of_things": description_of_things, "then": then},
        )

    def start_stroll(self) -> str:
        return self._forwarder.forward("start_stroll", {})

    def start_task(self, task_json: str) -> str:
        """Forward one canonical TaskSpec JSON payload."""

        return self._forwarder.forward("start_task", {"task_json": task_json})

    def pause_task(self, task_id: str) -> str:
        return self._forwarder.forward("pause_task", {"task_id": task_id})

    def resume_task(self, task_id: str) -> str:
        return self._forwarder.forward("resume_task", {"task_id": task_id})

    def cancel_task(self, task_id: str) -> str:
        return self._forwarder.forward("cancel_task", {"task_id": task_id})

    def get_task_status(self) -> str:
        return self._forwarder.forward("get_task_status", {})

    def list_semantic_places(self) -> str:
        return self._forwarder.forward("list_semantic_places", {})

    def confirm_semantic_place(self, place_json: str) -> str:
        """Forward one operator-confirmed semantic-place record."""

        return self._forwarder.forward(
            "confirm_semantic_place",
            {"place_json": place_json},
        )
