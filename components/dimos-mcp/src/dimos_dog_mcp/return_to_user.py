"""Navigate to the fixed user location, settle, and perform a greeting."""

from __future__ import annotations

import json
import time

from dimos.agents.annotation import skill
from dimos.agents.capabilities import CAP_MOVEMENT
from dimos.core.module import Module
from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from dimos.msgs.geometry_msgs.Quaternion import Quaternion
from dimos.msgs.geometry_msgs.Vector3 import Vector3
from dimos.navigation.base import NavigationState
from dimos.navigation.navigation_spec import NavigationInterfaceSpec
from dimos.perception.spatial_memory_spec import SpatialMemorySpec
from dimos.robot.unitree.unitree_skill_container import UnitreeSkillContainer


USER_LOCATION_NAME = "用户身边"
GREETING_COMMAND = "Hello"
POST_ARRIVAL_DELAY_S = 1.0
NAVIGATION_POLL_INTERVAL_S = 0.1
NAVIGATION_TIMEOUT_S = 100.0
GREETING_SUCCESS = f"'{GREETING_COMMAND}' command executed successfully."


class ReturnToUserAndGreetSkill(Module):
    """Return to the exact tagged user location before greeting."""

    _navigation: NavigationInterfaceSpec
    _spatial_memory: SpatialMemorySpec
    _unitree_skills: UnitreeSkillContainer

    @skill(uses=[CAP_MOVEMENT])
    def return_to_user_and_greet(self) -> str:
        """Navigate to ``用户身边``, wait one second after arrival, then greet."""

        try:
            return self._run_return_to_user_and_greet()
        except Exception as error:
            return self._result(
                {
                    "status": "error",
                    "error": f"Return-to-user workflow failed: {error}",
                }
            )

    def _run_return_to_user_and_greet(self) -> str:
        location = self._spatial_memory.query_tagged_location(USER_LOCATION_NAME)
        if location is None or location.name != USER_LOCATION_NAME:
            return self._result(
                {
                    "status": "error",
                    "error": f"Exact tagged location '{USER_LOCATION_NAME}' was not found.",
                }
            )

        goal = PoseStamped(
            position=Vector3(*location.position),
            orientation=Quaternion.from_euler(Vector3(*location.rotation)),
            frame_id="map",
        )
        if not self._navigation.set_goal(goal):
            return self._result(
                {
                    "status": "error",
                    "error": f"Navigation to '{USER_LOCATION_NAME}' was not accepted.",
                }
            )

        deadline = time.monotonic() + NAVIGATION_TIMEOUT_S
        navigation_started = False
        while time.monotonic() < deadline:
            state = self._navigation.get_state()
            if state is not NavigationState.IDLE:
                navigation_started = True
            elif self._navigation.is_goal_reached():
                break
            elif navigation_started:
                return self._result(
                    {
                        "status": "error",
                        "error": f"Navigation to '{USER_LOCATION_NAME}' failed or was cancelled.",
                    }
                )
            time.sleep(NAVIGATION_POLL_INTERVAL_S)
        else:
            self._navigation.cancel_goal()
            return self._result(
                {
                    "status": "error",
                    "error": f"Navigation to '{USER_LOCATION_NAME}' timed out.",
                }
            )

        time.sleep(POST_ARRIVAL_DELAY_S)
        greeting_result = self._unitree_skills.execute_sport_command(GREETING_COMMAND)
        if greeting_result != GREETING_SUCCESS:
            return self._result(
                {
                    "status": "error",
                    "error": "Greeting command failed.",
                    "greeting_result": greeting_result,
                }
            )

        return self._result(
            {
                "status": "completed",
                "location_name": USER_LOCATION_NAME,
                "greeting_command": GREETING_COMMAND,
                "post_arrival_delay_s": POST_ARRIVAL_DELAY_S,
                "message": "Arrived at the user location and completed the greeting.",
            }
        )

    @staticmethod
    def _result(payload: dict[str, object]) -> str:
        return json.dumps(payload, ensure_ascii=False)
