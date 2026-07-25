from __future__ import annotations

import json
import unittest

from dimos_dog_mcp.stage2_audit import (
    MOTION_ACKNOWLEDGEMENT,
    Stage2Audit,
    Stage2AuditError,
)


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def monotonic(self) -> float:
        return self.now

    def sleep(self, duration: float) -> None:
        self.now += duration


class _FakeClient:
    def __init__(
        self,
        *,
        task_states: list[dict[str, object]] | None = None,
        relocalization_ready: bool = True,
    ) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        self._task_states = list(task_states or [{"active": False, "state": "idle"}])
        self._last_task_state = self._task_states[-1]
        self._relocalization_ready = relocalization_ready
        self._distance = 0.0

    def list_tools(self) -> list[dict[str, object]]:
        return [
            {"name": name}
            for name in (
                "server_status",
                "get_robot_summary",
                "get_task_status",
                "list_semantic_places",
                "start_task",
                "cancel_task",
                "stop_all",
            )
        ]

    def call_tool_text(
        self,
        name: str,
        arguments: dict[str, object] | None = None,
    ) -> str:
        args = dict(arguments or {})
        self.calls.append((name, args))
        if name == "server_status":
            payload: dict[str, object] = {
                "pid": 4321,
                "mode": "go2",
                "robot_ip": "192.168.12.1",
                "tool_profile": "product",
                "runtime_owner": {"pid": 4321, "mode": "go2"},
            }
        elif name == "get_robot_summary":
            payload = {
                "status": "ready",
                "odometry": {
                    "available": True,
                    "fresh": True,
                    "age_s": 0.1,
                    "frame_id": "world",
                },
                "stable_pose": {
                    "frame_id": "map",
                    "x": self._distance,
                    "y": 0.0,
                    "z": 0.0,
                    "qx": 0.0,
                    "qy": 0.0,
                    "qz": 0.0,
                    "qw": 1.0,
                    "ts": 10.0,
                },
                "relocalization": {
                    "required": True,
                    "ready": self._relocalization_ready,
                    "stable_frame_id": "map",
                    "source_frame_id": "world",
                    "reason": (
                        "transform_available"
                        if self._relocalization_ready
                        else "transform_unavailable"
                    ),
                },
                "observed_motion_state": "stationary",
                "observed_speed_mps": 0.0,
                "actual_path": [],
                "planned_path": [],
                "recovery": None,
            }
        elif name == "list_semantic_places":
            payload = {
                "map_id": "venue-s2",
                "map_version": "61d67bd5e844",
                "places": [
                    {
                        "entity_id": "place-door",
                        "name": "门口测试点",
                        "aliases": ["门口"],
                        "map_id": "venue-s2",
                        "map_version": "61d67bd5e844",
                        "pose": {
                            "frame_id": "map",
                            "x": 1.0,
                            "y": 0.0,
                            "z": 0.0,
                            "qx": 0.0,
                            "qy": 0.0,
                            "qz": 0.0,
                            "qw": 1.0,
                            "ts": 10.0,
                        },
                    }
                ],
            }
        elif name == "start_task":
            task = json.loads(str(args["task_json"]))
            payload = {
                "accepted": True,
                "task_id": task["task_id"],
                "state": "queued",
            }
        elif name == "get_task_status":
            if self._task_states:
                payload = self._task_states.pop(0)
                self._last_task_state = payload
            else:
                payload = self._last_task_state
            if payload.get("state") == "completed":
                self._distance = 0.9
        elif name == "cancel_task":
            payload = {
                "accepted": True,
                "active": False,
                "state": "cancelled",
                "navigation_idle": True,
                "task": {"task_id": args["task_id"]},
            }
        else:
            raise AssertionError(f"unexpected tool: {name}")
        return json.dumps(payload, ensure_ascii=False)


class Stage2AuditTests(unittest.TestCase):
    def test_preflight_requires_fresh_relocalized_product_runtime(self) -> None:
        audit = Stage2Audit(_FakeClient())

        report = audit.preflight(required_places=("门口测试点",))

        self.assertTrue(report["passed"])
        self.assertEqual(report["runtime"]["pid"], 4321)
        self.assertEqual(report["map"]["map_id"], "venue-s2")
        self.assertEqual(report["places"][0]["name"], "门口测试点")

    def test_preflight_fails_closed_before_start_when_transform_is_unavailable(
        self,
    ) -> None:
        client = _FakeClient(relocalization_ready=False)
        audit = Stage2Audit(client)

        with self.assertRaisesRegex(Stage2AuditError, "relocalization is not ready"):
            audit.run_trip(
                destination="门口测试点",
                task_id="task-stage2-001",
                acknowledgement=MOTION_ACKNOWLEDGEMENT,
            )

        self.assertNotIn("start_task", [name for name, _args in client.calls])

    def test_trip_records_exact_task_id_terminal_state_and_arrival_error(
        self,
    ) -> None:
        states = [
            {"active": False, "state": "idle"},
            {
                "active": True,
                "state": "navigating",
                "task": {"task_id": "task-stage2-001"},
            },
            {
                "active": False,
                "state": "completed",
                "task": {"task_id": "task-stage2-001"},
                "result": {
                    "summary": "arrived at 门口测试点",
                    "evidence_ids": ["arrival:task-stage2-001"],
                },
            },
        ]
        clock = _Clock()
        audit = Stage2Audit(
            _FakeClient(task_states=states),
            monotonic_clock=clock.monotonic,
            sleeper=clock.sleep,
            poll_interval_s=0.1,
        )

        report = audit.run_trip(
            destination="门口",
            task_id="task-stage2-001",
            acknowledgement=MOTION_ACKNOWLEDGEMENT,
        )

        self.assertTrue(report["passed"])
        self.assertEqual(report["task_id"], "task-stage2-001")
        self.assertEqual(report["destination"], "门口测试点")
        self.assertEqual(report["terminal_state"], "completed")
        self.assertAlmostEqual(report["arrival_error_m"], 0.1)
        self.assertEqual(
            [event["state"] for event in report["task_timeline"]],
            ["navigating", "completed"],
        )

    def test_trip_timeout_cancels_and_requires_navigation_idle(self) -> None:
        states = [
            {"active": False, "state": "idle"},
            {
                "active": True,
                "state": "navigating",
                "task": {"task_id": "task-stage2-timeout"},
            },
        ]
        client = _FakeClient(task_states=states)
        clock = _Clock()
        audit = Stage2Audit(
            client,
            monotonic_clock=clock.monotonic,
            sleeper=clock.sleep,
            poll_interval_s=0.1,
        )

        report = audit.run_trip(
            destination="门口测试点",
            task_id="task-stage2-timeout",
            acknowledgement=MOTION_ACKNOWLEDGEMENT,
            timeout_s=0.25,
        )

        self.assertFalse(report["passed"])
        self.assertEqual(report["terminal_state"], "cancelled")
        self.assertTrue(report["navigation_idle"])
        self.assertIn("mission_timeout", report["failures"])
        self.assertIn("cancel_task", [name for name, _args in client.calls])

    def test_trip_command_requires_exact_motion_acknowledgement(self) -> None:
        audit = Stage2Audit(_FakeClient())

        with self.assertRaisesRegex(Stage2AuditError, "motion acknowledgement"):
            audit.run_trip(
                destination="门口测试点",
                task_id="task-stage2-002",
                acknowledgement="场地大概没问题",
            )

    def test_cancel_check_proves_same_task_terminal_and_navigation_idle(self) -> None:
        states = [
            {"active": False, "state": "idle"},
            {
                "active": True,
                "state": "navigating",
                "task": {"task_id": "task-stage2-cancel"},
            },
            {
                "active": False,
                "state": "cancelled",
                "task": {"task_id": "task-stage2-cancel"},
            },
        ]
        client = _FakeClient(task_states=states)
        clock = _Clock()
        audit = Stage2Audit(
            client,
            monotonic_clock=clock.monotonic,
            sleeper=clock.sleep,
            poll_interval_s=0.1,
        )

        report = audit.run_cancel_check(
            destination="门口测试点",
            task_id="task-stage2-cancel",
            acknowledgement=MOTION_ACKNOWLEDGEMENT,
            navigation_wait_s=1.0,
        )

        self.assertTrue(report["passed"])
        self.assertEqual(report["task_id"], "task-stage2-cancel")
        self.assertEqual(report["terminal_state"], "cancelled")
        self.assertTrue(report["navigation_idle"])
        self.assertEqual(report["final_task_status"]["state"], "cancelled")


if __name__ == "__main__":
    unittest.main()
