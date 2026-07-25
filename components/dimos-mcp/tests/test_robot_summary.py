from __future__ import annotations

import json
import unittest

from dimos_dog_mcp.robot_summary import RobotSummarySkill
from dimos_lcm.std_msgs import String

from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from dimos.msgs.geometry_msgs.Quaternion import Quaternion
from dimos.msgs.geometry_msgs.Transform import Transform
from dimos.msgs.geometry_msgs.Vector3 import Vector3, make_vector3
from dimos.msgs.nav_msgs.Path import Path
from dimos.protocol.tf.tf import MultiTBuffer


def make_pose(x: float, y: float, *, ts: float) -> PoseStamped:
    return PoseStamped(
        ts=ts,
        frame_id="map",
        position=make_vector3(x, y, 0.0),
        orientation=Quaternion.from_euler(make_vector3(0.0, 0.0, 0.0)),
    )


class _TestTF(MultiTBuffer):
    def stop(self) -> None:
        return None


class RobotSummarySkillTests(unittest.TestCase):
    def test_reports_unavailable_instead_of_inventing_a_path_without_odometry(
        self,
    ) -> None:
        clock = [10.0]
        skill = RobotSummarySkill(
            monotonic_clock=lambda: clock[0],
            wall_clock=lambda: 1_700_000_000.0,
        )
        self.addCleanup(skill.stop)

        payload = json.loads(skill.get_robot_summary())

        self.assertEqual(payload["status"], "unavailable")
        self.assertFalse(payload["odometry"]["fresh"])
        self.assertEqual(payload["actual_path"], [])

    def test_actual_path_distance_and_displacement_come_from_odometry(self) -> None:
        clock = [10.0]
        skill = RobotSummarySkill(
            monotonic_clock=lambda: clock[0],
            wall_clock=lambda: 1_700_000_000.0,
        )
        self.addCleanup(skill.stop)
        samples: list[dict[str, object]] = []
        skill.actual_path_sample.subscribe(
            lambda message: samples.append(json.loads(message.data))
        )
        skill._capture_odometry(make_pose(0.0, 0.0, ts=100.0))
        clock[0] = 10.5
        skill._capture_odometry(make_pose(0.3, 0.0, ts=100.5))
        clock[0] = 11.0
        skill._capture_odometry(make_pose(0.3, 0.4, ts=101.0))

        payload = json.loads(skill.get_robot_summary())

        self.assertEqual(payload["status"], "ready")
        self.assertTrue(payload["odometry"]["fresh"])
        self.assertAlmostEqual(payload["displacement_from_start_m"], 0.5)
        self.assertAlmostEqual(payload["distance_travelled_m"], 0.7)
        self.assertEqual(payload["sample_count"], 3)
        self.assertEqual(
            {
                key: payload["latest_pose"][key]
                for key in ("qx", "qy", "qz", "qw")
            },
            {"qx": 0.0, "qy": 0.0, "qz": 0.0, "qw": 1.0},
        )
        self.assertEqual(
            [(point["x"], point["y"]) for point in payload["actual_path"]],
            [(0.0, 0.0), (0.3, 0.0), (0.3, 0.4)],
        )
        self.assertEqual(
            [(point["x"], point["y"]) for point in samples],
            [(0.0, 0.0), (0.3, 0.0), (0.3, 0.4)],
        )

    def test_stale_odometry_is_explicit_and_never_reported_as_stationary(self) -> None:
        clock = [10.0]
        skill = RobotSummarySkill(
            monotonic_clock=lambda: clock[0],
            wall_clock=lambda: 1_700_000_000.0,
        )
        self.addCleanup(skill.stop)
        skill._capture_odometry(make_pose(0.0, 0.0, ts=100.0))
        clock[0] = 13.0

        payload = json.loads(skill.get_robot_summary())

        self.assertEqual(payload["status"], "stale")
        self.assertFalse(payload["odometry"]["fresh"])
        self.assertEqual(payload["observed_motion_state"], "unknown")

    def test_planned_path_and_latest_recovery_stay_separate_from_actual_path(
        self,
    ) -> None:
        skill = RobotSummarySkill(
            monotonic_clock=lambda: 10.0,
            wall_clock=lambda: 1_700_000_000.0,
        )
        self.addCleanup(skill.stop)
        skill._capture_odometry(make_pose(0.0, 0.0, ts=100.0))
        skill._capture_planned_path(
            Path(
                ts=101.0,
                frame_id="map",
                poses=[
                    make_pose(0.0, 0.0, ts=101.0),
                    make_pose(1.0, 0.5, ts=101.1),
                ],
            )
        )
        skill._capture_recovery_event(
            String(
                json.dumps(
                    {
                        "attempt": 2,
                        "cause": "obstacle",
                        "action": "replan",
                        "outcome": "dispatched",
                        "reason": "temporary obstruction",
                        "timestamp": 102.0,
                    }
                )
            )
        )

        payload = json.loads(skill.get_robot_summary())

        self.assertEqual(payload["planned_path_frame_id"], "map")
        self.assertEqual(
            [(point["x"], point["y"]) for point in payload["planned_path"]],
            [(0.0, 0.0), (1.0, 0.5)],
        )
        self.assertEqual(
            [(point["x"], point["y"]) for point in payload["actual_path"]],
            [(0.0, 0.0)],
        )
        self.assertEqual(payload["recovery"]["attempt"], 2)
        self.assertEqual(payload["recovery"]["cause"], "obstacle")

    def test_invalid_recovery_event_does_not_replace_last_valid_event(self) -> None:
        skill = RobotSummarySkill(
            monotonic_clock=lambda: 10.0,
            wall_clock=lambda: 1_700_000_000.0,
        )
        self.addCleanup(skill.stop)
        skill._capture_recovery_event(
            String(
                '{"attempt":1,"cause":"progress_timeout","action":"rotate_rescan",'
                '"outcome":"dispatched","reason":"stalled","timestamp":101.0}'
            )
        )
        skill._capture_recovery_event(String("not-json"))

        payload = json.loads(skill.get_robot_summary())

        self.assertEqual(payload["recovery"]["attempt"], 1)
        self.assertEqual(payload["recovery"]["cause"], "progress_timeout")

    def test_reports_stable_map_pose_when_relocalization_tf_is_available(
        self,
    ) -> None:
        skill = RobotSummarySkill(
            monotonic_clock=lambda: 10.0,
            wall_clock=lambda: 1_700_000_000.0,
            stable_frame_id="map",
        )
        self.addCleanup(skill.stop)
        transforms = _TestTF(buffer_size=10.0)
        transforms.receive_transform(
            Transform(
                frame_id="world",
                child_frame_id="map",
                ts=100.0,
                translation=Vector3(10.0, 0.0, 0.0),
            )
        )
        skill._tf = transforms
        skill._capture_odometry(
            PoseStamped(
                ts=100.0,
                frame_id="world",
                position=[12.0, 3.0, 0.0],
                orientation=[0.0, 0.0, 0.0, 1.0],
            )
        )
        try:
            payload = json.loads(skill.get_robot_summary())

            self.assertTrue(payload["relocalization"]["required"])
            self.assertTrue(payload["relocalization"]["ready"])
            self.assertEqual(payload["stable_pose"]["frame_id"], "map")
            self.assertAlmostEqual(payload["stable_pose"]["x"], 2.0)
            self.assertAlmostEqual(payload["stable_pose"]["y"], 3.0)
        finally:
            skill.stop()

    def test_relocalization_readiness_fails_closed_without_map_tf(self) -> None:
        skill = RobotSummarySkill(
            monotonic_clock=lambda: 10.0,
            wall_clock=lambda: 1_700_000_000.0,
            stable_frame_id="map",
        )
        self.addCleanup(skill.stop)
        skill._tf = _TestTF(buffer_size=10.0)
        skill._capture_odometry(
            PoseStamped(
                ts=100.0,
                frame_id="world",
                position=[12.0, 3.0, 0.0],
                orientation=[0.0, 0.0, 0.0, 1.0],
            )
        )
        try:
            payload = json.loads(skill.get_robot_summary())

            self.assertTrue(payload["relocalization"]["required"])
            self.assertFalse(payload["relocalization"]["ready"])
            self.assertIsNone(payload["stable_pose"])
        finally:
            skill.stop()


if __name__ == "__main__":
    unittest.main()
