"""Odometry-derived trajectory evidence for Stage 1 robot validation."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
import json
import math
from threading import RLock
import time

from dimos_lcm.std_msgs import String
from reactivex.disposable import Disposable

from dimos.agents.annotation import skill
from dimos.core.core import rpc
from dimos.core.module import Module, ModuleConfig
from dimos.core.stream import In, Out
from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from dimos.msgs.geometry_msgs.Transform import Transform
from dimos.msgs.nav_msgs.Path import Path

ODOMETRY_FRESHNESS_S = 2.0
PATH_SAMPLE_DISTANCE_M = 0.02
PATH_SAMPLE_INTERVAL_S = 0.5
MOVING_SPEED_MPS = 0.03
MAX_PATH_SAMPLES = 2_000


class RobotSummaryConfig(ModuleConfig):
    """Coordinate frame used to prove relocalization readiness."""

    stable_frame_id: str = ""
    transform_tolerance_s: float = 5.0


class RobotSummarySkill(Module):
    """Sample actual odometry and expose it without substituting a planned path."""

    config: RobotSummaryConfig
    odom: In[PoseStamped]
    path: In[Path]
    recovery_event: In[String]
    actual_path_sample: Out[String]

    def __init__(
        self,
        *,
        monotonic_clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        **kwargs: object,
    ) -> None:
        super().__init__(**kwargs)
        self._monotonic_clock = monotonic_clock
        self._wall_clock = wall_clock
        self._lock = RLock()
        self._start_pose: dict[str, object] | None = None
        self._latest_pose: dict[str, object] | None = None
        self._latest_pose_message: PoseStamped | None = None
        self._last_raw_xy: tuple[float, float] | None = None
        self._last_raw_received_at: float | None = None
        self._last_sample_xy: tuple[float, float] | None = None
        self._last_sample_received_at: float | None = None
        self._latest_received_at: float | None = None
        self._latest_received_wall: float | None = None
        self._distance_travelled_m = 0.0
        self._observed_speed_mps: float | None = None
        self._actual_path: list[dict[str, object]] = []
        self._planned_path_frame_id: str | None = None
        self._planned_path: list[dict[str, object]] = []
        self._recovery: dict[str, object] | None = None

    @rpc
    def start(self) -> None:
        super().start()
        self.register_disposable(Disposable(self.odom.subscribe(self._capture_odometry)))
        self.register_disposable(
            Disposable(self.path.subscribe(self._capture_planned_path))
        )
        self.register_disposable(
            Disposable(
                self.recovery_event.subscribe(self._capture_recovery_event)
            )
        )

    def _capture_odometry(self, pose: PoseStamped) -> None:
        if not _is_valid_pose(pose):
            return
        now = self._monotonic_clock()
        point = _pose_payload(pose)
        xy = (pose.position.x, pose.position.y)
        sampled_point: dict[str, object] | None = None
        with self._lock:
            if self._last_raw_xy is not None:
                segment = math.dist(self._last_raw_xy, xy)
                self._distance_travelled_m += segment
                elapsed = now - (self._last_raw_received_at or now)
                if elapsed > 0:
                    self._observed_speed_mps = segment / elapsed
            self._last_raw_xy = xy
            self._last_raw_received_at = now
            self._latest_received_at = now
            self._latest_received_wall = self._wall_clock()
            self._latest_pose = point
            self._latest_pose_message = pose
            if self._start_pose is None:
                self._start_pose = point

            if self._should_sample(xy, now):
                self._actual_path.append(point)
                if len(self._actual_path) > MAX_PATH_SAMPLES:
                    del self._actual_path[: len(self._actual_path) - MAX_PATH_SAMPLES]
                self._last_sample_xy = xy
                self._last_sample_received_at = now
                sampled_point = dict(point)
        if sampled_point is not None:
            self.actual_path_sample.publish(
                String(json.dumps(sampled_point, ensure_ascii=False))
            )

    @skill
    def get_robot_summary(self) -> str:
        """Return fresh actual odometry, trajectory, and observed motion state."""

        now = self._monotonic_clock()
        with self._lock:
            if self._latest_pose is None or self._latest_received_at is None:
                payload = _unavailable_payload()
                payload["relocalization"] = self._relocalization_payload(None)
                payload["stable_pose"] = None
                payload["planned_path_frame_id"] = self._planned_path_frame_id
                payload["planned_path"] = [
                    dict(point) for point in self._planned_path
                ]
                payload["recovery"] = (
                    dict(self._recovery) if self._recovery is not None else None
                )
                return json.dumps(payload, ensure_ascii=False)
            age_s = max(0.0, now - self._latest_received_at)
            fresh = age_s <= ODOMETRY_FRESHNESS_S
            start_pose = dict(self._start_pose or {})
            latest_pose = dict(self._latest_pose)
            stable_pose, relocalization = self._stable_pose_payload(
                self._latest_pose_message
            )
            displacement = math.dist(
                (
                    float(start_pose.get("x", 0.0)),
                    float(start_pose.get("y", 0.0)),
                ),
                (
                    float(latest_pose["x"]),
                    float(latest_pose["y"]),
                ),
            )
            observed_state = "unknown"
            if fresh and self._observed_speed_mps is not None:
                observed_state = (
                    "moving"
                    if self._observed_speed_mps >= MOVING_SPEED_MPS
                    else "stationary"
                )
            payload = {
                "status": "ready" if fresh else "stale",
                "odometry": {
                    "available": True,
                    "fresh": fresh,
                    "age_s": round(age_s, 3),
                    "frame_id": latest_pose["frame_id"],
                    "latest_sample_at": _iso_timestamp(
                        self._latest_received_wall or self._wall_clock()
                    ),
                },
                "start_pose": start_pose,
                "latest_pose": latest_pose,
                "stable_pose": stable_pose,
                "relocalization": relocalization,
                "displacement_from_start_m": self._distance(displacement),
                "distance_travelled_m": self._distance(
                    self._distance_travelled_m
                ),
                "sample_count": len(self._actual_path),
                "actual_path": [dict(point) for point in self._actual_path],
                "planned_path_frame_id": self._planned_path_frame_id,
                "planned_path": [dict(point) for point in self._planned_path],
                "recovery": (
                    dict(self._recovery) if self._recovery is not None else None
                ),
                "observed_motion_state": observed_state,
                "observed_speed_mps": (
                    round(self._observed_speed_mps, 4)
                    if fresh and self._observed_speed_mps is not None
                    else None
                ),
                "source": "odom",
            }
        return json.dumps(payload, ensure_ascii=False)

    def _stable_pose_payload(
        self,
        pose: PoseStamped | None,
    ) -> tuple[dict[str, object] | None, dict[str, object]]:
        target_frame = self.config.stable_frame_id
        if not target_frame:
            return None, self._relocalization_payload(
                None,
                ready=True,
                reason="not_required",
            )
        if pose is None:
            return None, self._relocalization_payload(
                None,
                ready=False,
                reason="odometry_unavailable",
            )
        if pose.frame_id == target_frame:
            return _pose_payload(pose), self._relocalization_payload(
                pose.frame_id,
                ready=True,
                reason="odometry_already_in_stable_frame",
            )

        transform = self.tf.get(
            target_frame,
            pose.frame_id,
            time_point=pose.ts,
            time_tolerance=self.config.transform_tolerance_s,
        )
        if transform is None:
            return None, self._relocalization_payload(
                pose.frame_id,
                ready=False,
                reason="transform_unavailable",
            )

        transformed = transform + Transform.from_pose("base_link", pose)
        stable_pose = PoseStamped(
            ts=pose.ts,
            frame_id=target_frame,
            position=transformed.translation,
            orientation=transformed.rotation,
        )
        return _pose_payload(stable_pose), self._relocalization_payload(
            pose.frame_id,
            ready=True,
            reason="transform_available",
        )

    def _relocalization_payload(
        self,
        source_frame_id: str | None,
        *,
        ready: bool = False,
        reason: str = "odometry_unavailable",
    ) -> dict[str, object]:
        return {
            "required": bool(self.config.stable_frame_id),
            "ready": ready,
            "stable_frame_id": self.config.stable_frame_id or None,
            "source_frame_id": source_frame_id,
            "reason": reason,
        }

    def _capture_planned_path(self, path: Path) -> None:
        planned_path = [_pose_payload(pose) for pose in path.poses]
        with self._lock:
            self._planned_path_frame_id = path.frame_id
            self._planned_path = planned_path

    def _capture_recovery_event(self, event: String) -> None:
        try:
            payload = json.loads(event.data)
        except (json.JSONDecodeError, TypeError):
            return
        if not _is_recovery_event(payload):
            return
        with self._lock:
            self._recovery = payload

    def _should_sample(self, xy: tuple[float, float], now: float) -> bool:
        if self._last_sample_xy is None or self._last_sample_received_at is None:
            return True
        return (
            math.dist(self._last_sample_xy, xy) >= PATH_SAMPLE_DISTANCE_M
            or now - self._last_sample_received_at >= PATH_SAMPLE_INTERVAL_S
        )

    @staticmethod
    def _distance(value: float) -> float:
        return round(value, 4)


class DryRunRobotSummarySkill(Module):
    """Keep the summary contract explicit when no odometry source exists."""

    @skill
    def get_robot_summary(self) -> str:
        """Report unavailable odometry in dry-run mode."""

        return json.dumps(_unavailable_payload(), ensure_ascii=False)


def _unavailable_payload() -> dict[str, object]:
    return {
        "status": "unavailable",
        "odometry": {
            "available": False,
            "fresh": False,
            "age_s": None,
            "frame_id": None,
            "latest_sample_at": None,
        },
        "start_pose": None,
        "latest_pose": None,
        "stable_pose": None,
        "relocalization": {
            "required": False,
            "ready": False,
            "stable_frame_id": None,
            "source_frame_id": None,
            "reason": "odometry_unavailable",
        },
        "displacement_from_start_m": None,
        "distance_travelled_m": None,
        "sample_count": 0,
        "actual_path": [],
        "planned_path_frame_id": None,
        "planned_path": [],
        "recovery": None,
        "observed_motion_state": "unknown",
        "observed_speed_mps": None,
        "source": "odom",
    }


def _is_valid_pose(pose: PoseStamped) -> bool:
    return all(
        math.isfinite(value)
        for value in (
            pose.ts,
            pose.position.x,
            pose.position.y,
            pose.position.z,
            pose.orientation.x,
            pose.orientation.y,
            pose.orientation.z,
            pose.orientation.w,
        )
    )


def _pose_payload(pose: PoseStamped) -> dict[str, object]:
    quaternion = pose.orientation
    yaw = math.atan2(
        2.0 * (quaternion.w * quaternion.z + quaternion.x * quaternion.y),
        1.0 - 2.0 * (quaternion.y**2 + quaternion.z**2),
    )
    return {
        "x": round(pose.position.x, 4),
        "y": round(pose.position.y, 4),
        "z": round(pose.position.z, 4),
        "qx": round(quaternion.x, 6),
        "qy": round(quaternion.y, 6),
        "qz": round(quaternion.z, 6),
        "qw": round(quaternion.w, 6),
        "yaw_rad": round(yaw, 4),
        "source_ts": pose.ts,
        "frame_id": pose.frame_id,
    }


def _iso_timestamp(value: float) -> str:
    return datetime.fromtimestamp(value, tz=UTC).isoformat().replace("+00:00", "Z")


def _is_recovery_event(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    return (
        isinstance(value.get("attempt"), int)
        and value["attempt"] >= 0
        and all(
            isinstance(value.get(field), str) and bool(value[field])
            for field in ("cause", "action", "outcome", "reason")
        )
        and isinstance(value.get("timestamp"), (int, float))
        and not isinstance(value["timestamp"], bool)
        and math.isfinite(float(value["timestamp"]))
    )
