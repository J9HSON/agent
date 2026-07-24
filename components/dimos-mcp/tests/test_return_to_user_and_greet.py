from __future__ import annotations

import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from dimos.navigation.base import NavigationState

from dimos_dog_mcp.return_to_user import (
    POST_ARRIVAL_DELAY_S,
    USER_LOCATION_NAME,
    ReturnToUserAndGreetSkill,
)


class RecordedNavigation:
    def __init__(
        self,
        events: list[tuple[str, object]],
        goal_reached: bool = True,
    ) -> None:
        self._events = events
        self._goal_reached = goal_reached
        self._states = iter(
            [
                NavigationState.FOLLOWING_PATH,
                NavigationState.IDLE,
            ]
        )

    def set_goal(self, goal: object) -> bool:
        self._events.append(("set_goal", goal))
        return True

    def get_state(self) -> NavigationState:
        return next(self._states)

    def is_goal_reached(self) -> bool:
        self._events.append(("goal_reached", self._goal_reached))
        return self._goal_reached

    def cancel_goal(self) -> bool:
        self._events.append(("cancel_goal", None))
        return True


class RecordedSpatialMemory:
    def __init__(
        self,
        events: list[tuple[str, object]],
        location_name: str = USER_LOCATION_NAME,
    ) -> None:
        self._events = events
        self._location_name = location_name

    def query_tagged_location(self, query: str) -> object:
        self._events.append(("query_tagged_location", query))
        return SimpleNamespace(
            name=self._location_name,
            position=(1.0, 2.0, 0.0),
            rotation=(0.0, 0.0, 0.5),
        )


class RecordedUnitreeSkills:
    def __init__(self, events: list[tuple[str, object]]) -> None:
        self._events = events

    def execute_sport_command(self, command_name: str) -> str:
        self._events.append(("execute_sport_command", command_name))
        return f"'{command_name}' command executed successfully."


class FailingSpatialMemory:
    def query_tagged_location(self, query: str) -> object:
        raise RuntimeError(f"spatial lookup failed for {query}")


class ReturnToUserAndGreetSkillTests(unittest.TestCase):
    def test_waits_one_second_after_arrival_before_greeting(self) -> None:
        events: list[tuple[str, object]] = []
        skill = ReturnToUserAndGreetSkill()
        skill._navigation = RecordedNavigation(events)
        skill._spatial_memory = RecordedSpatialMemory(events)
        skill._unitree_skills = RecordedUnitreeSkills(events)

        def record_sleep(seconds: float) -> None:
            events.append(("sleep", seconds))

        with patch("dimos_dog_mcp.return_to_user.time.sleep", side_effect=record_sleep):
            result = json.loads(skill.return_to_user_and_greet())

        self.assertEqual(
            result,
            {
                "status": "completed",
                "location_name": USER_LOCATION_NAME,
                "greeting_command": "Hello",
                "post_arrival_delay_s": POST_ARRIVAL_DELAY_S,
                "message": "Arrived at the user location and completed the greeting.",
            },
        )
        self.assertEqual(events[0], ("query_tagged_location", USER_LOCATION_NAME))
        self.assertEqual(events[1][0], "set_goal")
        self.assertEqual(events[2], ("sleep", 0.1))
        self.assertEqual(events[3], ("goal_reached", True))
        self.assertEqual(events[4], ("sleep", 1.0))
        self.assertEqual(events[5], ("execute_sport_command", "Hello"))

    def test_rejects_a_semantic_match_with_a_different_location_name(self) -> None:
        events: list[tuple[str, object]] = []
        skill = ReturnToUserAndGreetSkill()
        skill._navigation = RecordedNavigation(events)
        skill._spatial_memory = RecordedSpatialMemory(events, f"{USER_LOCATION_NAME} ")
        skill._unitree_skills = RecordedUnitreeSkills(events)

        result = json.loads(skill.return_to_user_and_greet())

        self.assertEqual(result["status"], "error")
        self.assertIn("Exact tagged location", result["error"])
        self.assertEqual(events, [("query_tagged_location", USER_LOCATION_NAME)])

    def test_returns_a_structured_error_when_a_dependency_raises(self) -> None:
        events: list[tuple[str, object]] = []
        skill = ReturnToUserAndGreetSkill()
        skill._navigation = RecordedNavigation(events)
        skill._spatial_memory = FailingSpatialMemory()
        skill._unitree_skills = RecordedUnitreeSkills(events)

        result = json.loads(skill.return_to_user_and_greet())

        self.assertEqual(result["status"], "error")
        self.assertIn("spatial lookup failed", result["error"])
        self.assertNotIn(("execute_sport_command", "Hello"), events)

    def test_does_not_greet_when_navigation_fails(self) -> None:
        events: list[tuple[str, object]] = []
        skill = ReturnToUserAndGreetSkill()
        skill._navigation = RecordedNavigation(events, goal_reached=False)
        skill._spatial_memory = RecordedSpatialMemory(events)
        skill._unitree_skills = RecordedUnitreeSkills(events)

        with patch("dimos_dog_mcp.return_to_user.time.sleep"):
            result = json.loads(skill.return_to_user_and_greet())

        self.assertEqual(result["status"], "error")
        self.assertNotIn(
            ("execute_sport_command", "Hello"),
            events,
        )


if __name__ == "__main__":
    unittest.main()
