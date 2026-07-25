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
        *,
        accepts_goal: bool = True,
        goal_reached: bool = True,
        states: tuple[NavigationState, ...] = (
            NavigationState.FOLLOWING_PATH,
            NavigationState.IDLE,
        ),
    ) -> None:
        self._events = events
        self._accepts_goal = accepts_goal
        self._goal_reached = goal_reached
        self._states = iter(states)

    def set_goal(self, goal: object) -> bool:
        self._events.append(("set_goal", goal))
        return self._accepts_goal

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
        location_name: str | None = USER_LOCATION_NAME,
    ) -> None:
        self._events = events
        self._location_name = location_name

    def query_tagged_location(self, query: str) -> object | None:
        self._events.append(("query_tagged_location", query))
        if self._location_name is None:
            return None
        return SimpleNamespace(
            name=self._location_name,
            position=(1.0, 2.0, 0.0),
            rotation=(0.0, 0.0, 0.5),
        )


class RecordedUnitreeSkills:
    def __init__(
        self,
        events: list[tuple[str, object]],
        result: str | None = None,
    ) -> None:
        self._events = events
        self._result = result

    def execute_sport_command(self, command_name: str) -> str:
        self._events.append(("execute_sport_command", command_name))
        if self._result is not None:
            return self._result
        return f"'{command_name}' command executed successfully."


class FailingSpatialMemory:
    def query_tagged_location(self, query: str) -> object:
        raise RuntimeError(f"spatial lookup failed for {query}")


class ReturnToUserAndGreetSkillTests(unittest.TestCase):
    def test_uses_the_exact_utf8_user_location_name(self) -> None:
        self.assertEqual(USER_LOCATION_NAME, "用户身边")
        self.assertEqual(
            USER_LOCATION_NAME.encode("utf-8"),
            b"\xe7\x94\xa8\xe6\x88\xb7\xe8\xba\xab\xe8\xbe\xb9",
        )

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

    def test_does_not_navigate_or_greet_when_the_location_is_not_found(self) -> None:
        events: list[tuple[str, object]] = []
        skill = ReturnToUserAndGreetSkill()
        skill._navigation = RecordedNavigation(events)
        skill._spatial_memory = RecordedSpatialMemory(events, None)
        skill._unitree_skills = RecordedUnitreeSkills(events)

        result = json.loads(skill.return_to_user_and_greet())

        self.assertEqual(result["status"], "error")
        self.assertIn("Exact tagged location", result["error"])
        self.assertEqual(events, [("query_tagged_location", USER_LOCATION_NAME)])

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

    def test_does_not_greet_when_navigation_rejects_the_goal(self) -> None:
        events: list[tuple[str, object]] = []
        skill = ReturnToUserAndGreetSkill()
        skill._navigation = RecordedNavigation(events, accepts_goal=False)
        skill._spatial_memory = RecordedSpatialMemory(events)
        skill._unitree_skills = RecordedUnitreeSkills(events)

        result = json.loads(skill.return_to_user_and_greet())

        self.assertEqual(result["status"], "error")
        self.assertIn("was not accepted", result["error"])
        self.assertEqual([event[0] for event in events], ["query_tagged_location", "set_goal"])

    def test_does_not_greet_when_navigation_fails_or_is_cancelled(self) -> None:
        events: list[tuple[str, object]] = []
        skill = ReturnToUserAndGreetSkill()
        skill._navigation = RecordedNavigation(events, goal_reached=False)
        skill._spatial_memory = RecordedSpatialMemory(events)
        skill._unitree_skills = RecordedUnitreeSkills(events)

        with patch("dimos_dog_mcp.return_to_user.time.sleep"):
            result = json.loads(skill.return_to_user_and_greet())

        self.assertEqual(result["status"], "error")
        self.assertIn("failed or was cancelled", result["error"])
        self.assertNotIn(
            ("execute_sport_command", "Hello"),
            events,
        )

    def test_cancels_navigation_and_does_not_greet_after_timeout(self) -> None:
        events: list[tuple[str, object]] = []
        skill = ReturnToUserAndGreetSkill()
        skill._navigation = RecordedNavigation(
            events,
            states=(NavigationState.FOLLOWING_PATH,),
        )
        skill._spatial_memory = RecordedSpatialMemory(events)
        skill._unitree_skills = RecordedUnitreeSkills(events)

        with (
            patch(
                "dimos_dog_mcp.return_to_user.time.monotonic",
                side_effect=(10.0, 10.0, 111.0),
            ),
            patch("dimos_dog_mcp.return_to_user.time.sleep"),
        ):
            result = json.loads(skill.return_to_user_and_greet())

        self.assertEqual(result["status"], "error")
        self.assertIn("timed out", result["error"])
        self.assertIn(("cancel_goal", None), events)
        self.assertNotIn(("execute_sport_command", "Hello"), events)

    def test_returns_an_error_when_the_greeting_command_fails(self) -> None:
        events: list[tuple[str, object]] = []
        skill = ReturnToUserAndGreetSkill()
        skill._navigation = RecordedNavigation(events)
        skill._spatial_memory = RecordedSpatialMemory(events)
        skill._unitree_skills = RecordedUnitreeSkills(
            events,
            result="'Hello' command failed.",
        )

        with patch("dimos_dog_mcp.return_to_user.time.sleep"):
            result = json.loads(skill.return_to_user_and_greet())

        self.assertEqual(
            result,
            {
                "status": "error",
                "error": "Greeting command failed.",
                "greeting_result": "'Hello' command failed.",
            },
        )
        self.assertEqual(
            [event for event in events if event[0] == "execute_sport_command"],
            [("execute_sport_command", "Hello")],
        )


if __name__ == "__main__":
    unittest.main()
