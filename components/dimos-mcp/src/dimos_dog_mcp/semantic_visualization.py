"""Read-only bridge from canonical Stage 2 state to the official DimOS viewer."""

from __future__ import annotations

import json
import math
from threading import RLock
from typing import Any
import unicodedata

from dimos_lcm.std_msgs import String
from reactivex.disposable import Disposable

from dimos.core.core import rpc
from dimos.core.module import Module, ModuleConfig
from dimos.core.stream import In, Out
from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from dimos.msgs.geometry_msgs.Transform import Transform
from dimos.msgs.nav_msgs.Path import Path
from dimos.msgs.visualization_msgs.EntityMarkers import EntityMarkers, Marker
from dimos.utils.logging_config import setup_logger

from .robot_summary import MAX_PATH_SAMPLES

logger = setup_logger()

_ACTIVE_TARGET_STATES = {
    "queued",
    "resolving",
    "navigating",
    "recovering",
    "paused",
}


class SemanticVisualizationConfig(ModuleConfig):
    """Coordinates used by the official Viewer world."""

    visualization_frame_id: str = "world"
    transform_tolerance_s: float = 5.0


class ActualPathVisualization(Path):
    """Actual odometry path with a distinct blue Viewer rendering."""

    msg_name = "nav_msgs.ActualPathVisualization"

    def to_rerun(self) -> Any:
        """Render actual travel separately from the official green plan."""

        return super().to_rerun(
            color=(40, 150, 255),
            z_offset=0.58,
            radii=0.04,
        )


class SemanticVisualizationAdapter(Module):
    """Convert canonical read-only snapshots into official Viewer messages."""

    config: SemanticVisualizationConfig
    semantic_places_snapshot: In[String]
    mission_status_snapshot: In[String]
    actual_path_sample: In[String]

    semantic_place_markers: Out[EntityMarkers]
    current_target_markers: Out[EntityMarkers]
    actual_path_visualization: Out[ActualPathVisualization]

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._lock = RLock()
        self._semantic_world: dict[str, Any] = {"places": []}
        self._mission_status: dict[str, Any] = {
            "active": False,
            "state": "idle",
        }
        self._actual_path: list[PoseStamped] = []
        self._actual_frame_id: str | None = None

    @rpc
    def start(self) -> None:
        """Subscribe to canonical state without creating a control surface."""

        super().start()
        self.register_disposable(
            Disposable(
                self.semantic_places_snapshot.subscribe(
                    self._capture_semantic_places
                )
            )
        )
        self.register_disposable(
            Disposable(
                self.mission_status_snapshot.subscribe(
                    self._capture_mission_status
                )
            )
        )
        self.register_disposable(
            Disposable(
                self.actual_path_sample.subscribe(self._capture_actual_path_sample)
            )
        )

    def _capture_semantic_places(self, message: String) -> None:
        payload = _json_object(message.data)
        if payload is None or not isinstance(payload.get("places"), list):
            logger.warning("Ignored invalid semantic place visualization snapshot")
            return
        with self._lock:
            self._semantic_world = payload
        self._publish_markers()

    def _capture_mission_status(self, message: String) -> None:
        payload = _json_object(message.data)
        if payload is None or not isinstance(payload.get("state"), str):
            logger.warning("Ignored invalid mission visualization snapshot")
            return
        with self._lock:
            self._mission_status = payload
        self._publish_current_target()

    def _capture_actual_path_sample(self, message: String) -> None:
        payload = _json_object(message.data)
        pose = _pose_from_payload(payload)
        if pose is None:
            logger.warning("Ignored invalid actual-path visualization sample")
            return

        with self._lock:
            if (
                self._actual_frame_id is not None
                and pose.frame_id != self._actual_frame_id
            ):
                self._actual_path.clear()
            self._actual_frame_id = pose.frame_id
            self._actual_path.append(pose)
            if len(self._actual_path) > MAX_PATH_SAMPLES:
                del self._actual_path[
                    : len(self._actual_path) - MAX_PATH_SAMPLES
                ]
            path = ActualPathVisualization(
                ts=pose.ts,
                frame_id=pose.frame_id,
                poses=list(self._actual_path),
            )

        self.actual_path_visualization.publish(path)
        # Relocalization TF may become ready after the initial semantic snapshot.
        self._publish_markers()

    def _publish_markers(self) -> None:
        with self._lock:
            places = list(self._semantic_world.get("places", []))
        markers = [
            marker
            for place in places
            if isinstance(place, dict)
            for marker in [self._place_marker(place)]
            if marker is not None
        ]
        self.semantic_place_markers.publish(EntityMarkers(markers=markers))
        self._publish_current_target()

    def _publish_current_target(self) -> None:
        with self._lock:
            state = self._mission_status.get("state")
            task = self._mission_status.get("task")
            places = list(self._semantic_world.get("places", []))

        if state not in _ACTIVE_TARGET_STATES or not isinstance(task, dict):
            self.current_target_markers.publish(EntityMarkers())
            return
        destination = task.get("destination")
        if not isinstance(destination, str):
            self.current_target_markers.publish(EntityMarkers())
            return
        destination_key = _label_key(destination)
        place = next(
            (
                candidate
                for candidate in places
                if isinstance(candidate, dict)
                and destination_key in _place_keys(candidate)
            ),
            None,
        )
        marker = self._place_marker(
            place,
            label_prefix="当前目标: ",
            entity_id_prefix="target-",
        )
        self.current_target_markers.publish(
            EntityMarkers(markers=[] if marker is None else [marker])
        )

    def _place_marker(
        self,
        place: dict[str, Any] | None,
        *,
        label_prefix: str = "",
        entity_id_prefix: str = "",
    ) -> Marker | None:
        if place is None:
            return None
        name = place.get("name")
        entity_id = place.get("entity_id")
        pose = _pose_from_payload(place.get("pose"))
        if (
            not isinstance(name, str)
            or not isinstance(entity_id, str)
            or pose is None
        ):
            return None
        transformed = self._pose_in_visualization_frame(pose)
        if transformed is None:
            return None
        return Marker(
            entity_id=f"{entity_id_prefix}{entity_id}",
            label=f"{label_prefix}{name}",
            entity_type="location",
            x=transformed.x,
            y=transformed.y,
            z=transformed.z + 0.08,
        )

    def _pose_in_visualization_frame(
        self,
        pose: PoseStamped,
    ) -> PoseStamped | None:
        target_frame = self.config.visualization_frame_id
        if not target_frame or pose.frame_id == target_frame:
            return pose
        transform = self.tf.get(
            target_frame,
            pose.frame_id,
            time_point=None,
            time_tolerance=self.config.transform_tolerance_s,
        )
        if transform is None:
            return None
        transformed = transform + Transform.from_pose("semantic_place", pose)
        return PoseStamped(
            ts=pose.ts,
            frame_id=target_frame,
            position=transformed.translation,
            orientation=transformed.rotation,
        )


def _json_object(value: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return None
    return payload if isinstance(payload, dict) else None


def _pose_from_payload(value: Any) -> PoseStamped | None:
    if not isinstance(value, dict):
        return None
    frame_id = value.get("frame_id")
    if not isinstance(frame_id, str) or not frame_id.strip():
        return None
    raw_values = {
        "ts": value.get("source_ts", value.get("ts")),
        "x": value.get("x"),
        "y": value.get("y"),
        "z": value.get("z"),
        "qx": value.get("qx"),
        "qy": value.get("qy"),
        "qz": value.get("qz"),
        "qw": value.get("qw"),
    }
    if any(
        isinstance(raw, bool)
        or not isinstance(raw, (int, float))
        or not math.isfinite(float(raw))
        for raw in raw_values.values()
    ):
        return None
    return PoseStamped(
        ts=float(raw_values["ts"]),
        frame_id=frame_id,
        position=[
            float(raw_values["x"]),
            float(raw_values["y"]),
            float(raw_values["z"]),
        ],
        orientation=[
            float(raw_values["qx"]),
            float(raw_values["qy"]),
            float(raw_values["qz"]),
            float(raw_values["qw"]),
        ],
    )


def _clean_label(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).strip().split())


def _label_key(value: str) -> str:
    return _clean_label(value).casefold()


def _place_keys(place: dict[str, Any]) -> set[str]:
    values = [place.get("name"), *(place.get("aliases") or [])]
    return {
        _label_key(value)
        for value in values
        if isinstance(value, str) and _clean_label(value)
    }
