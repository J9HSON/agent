from __future__ import annotations

import importlib.util
import json
import sys
import unittest

from dimos_dog_mcp.stop_actions import run_stop_actions


HAS_SUPPORTED_DIMOS = importlib.util.find_spec("dimos") is not None and sys.version_info < (3, 13)


class RecordedStops:
    def __init__(self, *, fail: str | None = None) -> None:
        self.calls: list[str] = []
        self._fail = fail

    def _record(self, name: str) -> str:
        self.calls.append(name)
        if name == self._fail:
            raise RuntimeError(f"{name} failed")
        return f"{name} stopped"

    def end_exploration(self) -> str:
        return self._record("exploration")

    def cancel_active_task(self) -> str:
        return self._record("mission")

    def stop_patrol(self) -> str:
        return self._record("patrol")

    def stop_stroll(self) -> str:
        return self._record("stroll")

    def stop_following(self) -> str:
        return self._record("follow")

    def stop_looking_out(self) -> str:
        return self._record("lookout")

    def stop_navigation(self) -> str:
        return self._record("navigation")

    def cancel_goal(self) -> str:
        return self._record("navigation")

    def stop_motion(self) -> str:
        return self._record("motion")


class StopActionTests(unittest.TestCase):
    def test_attempts_every_activity_and_reports_partial_errors(self) -> None:
        recorded = RecordedStops(fail="patrol")

        payload = json.loads(
            run_stop_actions(
                (
                    ("exploration", recorded.end_exploration),
                    ("patrol", recorded.stop_patrol),
                    ("stroll", recorded.stop_stroll),
                    ("lookout", recorded.stop_looking_out),
                    ("navigation", recorded.stop_navigation),
                    ("motion", recorded.stop_motion),
                )
            )
        )

        self.assertEqual(
            recorded.calls,
            ["exploration", "patrol", "stroll", "lookout", "navigation", "motion"],
        )
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["failed_components"], ["patrol"])
        self.assertEqual(payload["results"]["patrol"], {"status": "error", "error": "patrol failed"})
        self.assertEqual(payload["results"]["motion"]["status"], "success")

    def test_treats_a_returned_error_envelope_as_failure_and_continues(self) -> None:
        calls: list[str] = []

        def navigation_error() -> str:
            calls.append("navigation")
            return '{"status":"error","error":"navigation refused to stop"}'

        def motion_stop() -> str:
            calls.append("motion")
            return '{"status":"already_idle","zero_velocity_published":true}'

        payload = json.loads(
            run_stop_actions(
                (
                    ("navigation", navigation_error),
                    ("motion", motion_stop),
                )
            )
        )

        self.assertEqual(calls, ["navigation", "motion"])
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["failed_components"], ["navigation"])
        self.assertEqual(
            payload["results"]["navigation"],
            {
                "status": "error",
                "error": "navigation refused to stop",
                "result": '{"status":"error","error":"navigation refused to stop"}',
            },
        )
        self.assertEqual(payload["results"]["motion"]["status"], "success")


@unittest.skipUnless(HAS_SUPPORTED_DIMOS, "requires DIMOS on Python 3.10-3.12")
class StopAllSkillTests(unittest.TestCase):
    def test_go2_stop_all_attempts_every_activity_and_reports_partial_errors(self) -> None:
        from dimos_dog_mcp.go2_stop import Go2StopAllSkill

        recorded = RecordedStops(fail="patrol")
        skill = Go2StopAllSkill()
        skill._mission_executor = recorded
        skill._exploration = recorded
        skill._patrol = recorded
        skill._stroll = recorded
        skill._person_follow = recorded
        skill._navigation = recorded
        skill._motion = recorded

        payload = json.loads(skill.stop_all())

        self.assertEqual(
            recorded.calls,
            [
                "mission",
                "exploration",
                "patrol",
                "stroll",
                "follow",
                "navigation",
                "motion",
            ],
        )
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["failed_components"], ["patrol"])
        self.assertEqual(payload["results"]["patrol"], {"status": "error", "error": "patrol failed"})
        self.assertEqual(payload["results"]["motion"]["status"], "success")


if __name__ == "__main__":
    unittest.main()
