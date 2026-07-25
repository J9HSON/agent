from __future__ import annotations

import json
import unittest

from dimos_dog_mcp.semantic_visualization import (
    ActualPathVisualization,
    SemanticVisualizationAdapter,
)
from dimos_lcm.std_msgs import String

from dimos.msgs.geometry_msgs.Transform import Transform
from dimos.msgs.geometry_msgs.Vector3 import Vector3
from dimos.protocol.tf.tf import MultiTBuffer


def _pose(x: float, y: float, *, frame_id: str = "map") -> dict[str, object]:
    return {
        "frame_id": frame_id,
        "ts": 100.0 + x,
        "x": x,
        "y": y,
        "z": 0.0,
        "qx": 0.0,
        "qy": 0.0,
        "qz": 0.0,
        "qw": 1.0,
    }


def _message(payload: dict[str, object]) -> String:
    return String(json.dumps(payload, ensure_ascii=False))


class _TestTF(MultiTBuffer):
    def stop(self) -> None:
        return None


class SemanticVisualizationAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = SemanticVisualizationAdapter(
            visualization_frame_id="map",
        )
        self.place_updates = []
        self.target_updates = []
        self.path_updates: list[ActualPathVisualization] = []
        self.adapter.semantic_place_markers.subscribe(self.place_updates.append)
        self.adapter.current_target_markers.subscribe(self.target_updates.append)
        self.adapter.actual_path_visualization.subscribe(
            self.path_updates.append
        )

    def tearDown(self) -> None:
        self.adapter.stop()

    def test_places_and_alias_target_are_rendered_from_canonical_snapshots(
        self,
    ) -> None:
        self.adapter._capture_semantic_places(
            _message(
                {
                    "map_id": "venue-a",
                    "map_version": "v1",
                    "places": [
                        {
                            "entity_id": "place-door-001",
                            "name": "会场正门",
                            "aliases": ["入口"],
                            "pose": _pose(2.0, 3.0),
                        }
                    ],
                }
            )
        )

        self.assertEqual(len(self.place_updates[-1].markers), 1)
        place = self.place_updates[-1].markers[0]
        self.assertEqual(place.label, "会场正门")
        self.assertEqual((place.x, place.y), (2.0, 3.0))

        self.adapter._capture_mission_status(
            _message(
                {
                    "active": True,
                    "state": "navigating",
                    "task": {
                        "task_id": "task-viewer-0001",
                        "destination": "入口",
                    },
                }
            )
        )

        self.assertEqual(len(self.target_updates[-1].markers), 1)
        target = self.target_updates[-1].markers[0]
        self.assertEqual(target.entity_id, "target-place-door-001")
        self.assertEqual(target.label, "当前目标: 会场正门")

    def test_terminal_task_clears_current_target(self) -> None:
        self.test_places_and_alias_target_are_rendered_from_canonical_snapshots()

        self.adapter._capture_mission_status(
            _message(
                {
                    "active": False,
                    "state": "completed",
                    "task": {
                        "task_id": "task-viewer-0001",
                        "destination": "入口",
                    },
                }
            )
        )

        self.assertEqual(self.target_updates[-1].markers, [])

    def test_places_are_transformed_into_the_viewer_world_frame(self) -> None:
        self.adapter.stop()
        self.adapter = SemanticVisualizationAdapter(
            visualization_frame_id="world",
        )
        self.place_updates = []
        self.target_updates = []
        self.path_updates = []
        self.adapter.semantic_place_markers.subscribe(self.place_updates.append)
        self.adapter.current_target_markers.subscribe(self.target_updates.append)
        self.adapter.actual_path_visualization.subscribe(
            self.path_updates.append
        )
        transforms = _TestTF(buffer_size=10.0)
        transforms.receive_transform(
            Transform(
                frame_id="world",
                child_frame_id="map",
                ts=100.0,
                translation=Vector3(10.0, 0.0, 0.0),
            )
        )
        self.adapter._tf = transforms

        self.adapter._capture_semantic_places(
            _message(
                {
                    "map_id": "venue-a",
                    "map_version": "v1",
                    "places": [
                        {
                            "entity_id": "place-door-001",
                            "name": "会场正门",
                            "aliases": [],
                            "pose": _pose(2.0, 3.0),
                        }
                    ],
                }
            )
        )

        marker = self.place_updates[-1].markers[0]
        self.assertEqual((marker.x, marker.y), (12.0, 3.0))

    def test_actual_path_uses_only_robot_summary_samples(self) -> None:
        first = _pose(0.0, 0.0, frame_id="world")
        first["source_ts"] = first.pop("ts")
        second = _pose(0.4, 0.1, frame_id="world")
        second["source_ts"] = second.pop("ts")

        self.adapter._capture_actual_path_sample(_message(first))
        self.adapter._capture_actual_path_sample(_message(second))

        path = self.path_updates[-1]
        self.assertIsInstance(path, ActualPathVisualization)
        self.assertEqual(path.frame_id, "world")
        self.assertEqual(
            [(pose.x, pose.y) for pose in path.poses],
            [(0.0, 0.0), (0.4, 0.1)],
        )

    def test_invalid_snapshots_do_not_replace_last_valid_state(self) -> None:
        self.adapter._capture_semantic_places(String("not-json"))
        self.adapter._capture_actual_path_sample(String("{}"))

        self.assertEqual(self.place_updates, [])
        self.assertEqual(self.path_updates, [])


if __name__ == "__main__":
    unittest.main()
