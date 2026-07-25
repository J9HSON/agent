"""Thread-safe, timed velocity execution independent of DIMOS imports."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import math
import threading
import time
from typing import Literal


DEFAULT_SPEED_MPS = 0.1
DEFAULT_DURATION_S = 1.0


@dataclass(frozen=True)
class VelocityCommand:
    """A velocity command in the DIMOS ``Twist`` coordinate convention."""

    linear_x: float
    linear_y: float
    angular_z: float
    duration_s: float

    @classmethod
    def zero(cls) -> VelocityCommand:
        """Return a zero-velocity command suitable for an immediate stop."""

        return cls(linear_x=0.0, linear_y=0.0, angular_z=0.0, duration_s=0.0)


@dataclass(frozen=True)
class MotionOutcome:
    """The terminal state of a timed velocity command."""

    state: Literal["completed", "stopped"]
    elapsed_s: float


@dataclass(frozen=True)
class MotionStatus:
    """A snapshot of the local motion executor, not robot telemetry."""

    active: bool
    linear_x: float | None
    linear_y: float | None
    angular_z: float | None
    last_command: VelocityCommand | None
    last_outcome: Literal["completed", "stopped"] | None


@dataclass
class _ActiveMotion:
    command: VelocityCommand
    started_at: float
    stop_event: threading.Event


class MotionBusyError(RuntimeError):
    """Raised when a second motion command attempts to overlap an active one."""


def validate_motion_request(speed_mps: object, duration_s: object) -> tuple[float, float]:
    """Validate the only tunable parameters exposed by the MCP motion tools."""

    speed = _read_finite_number(speed_mps, "speed_mps")
    duration = _read_finite_number(duration_s, "duration_s")
    if speed <= 0:
        raise ValueError(f"speed_mps must be positive, got {speed}")
    if duration <= 0:
        raise ValueError(f"duration_s must be positive, got {duration}")
    return speed, duration


def _read_finite_number(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field_name} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{field_name} must be a finite number")
    return number


class MotionRuntime:
    """Serializes motion and guarantees a zero command on every terminal path."""

    def __init__(self, publish: Callable[[VelocityCommand], None], publish_hz: float = 10.0) -> None:
        if not math.isfinite(publish_hz) or publish_hz <= 0:
            raise ValueError("publish_hz must be a positive finite number")
        self._publish = publish
        self._publish_interval_s = 1.0 / publish_hz
        self._lock = threading.RLock()
        self._active: _ActiveMotion | None = None
        self._last_command: VelocityCommand | None = None
        self._last_outcome: Literal["completed", "stopped"] | None = None

    def execute(self, command: VelocityCommand) -> MotionOutcome:
        """Publish one timed command until completion or an explicit stop."""

        active = self._begin(command)
        return self._run(active)

    def start(self, command: VelocityCommand) -> None:
        """Start a timed command on a daemon thread and return immediately."""

        active = self._begin(command)
        thread = threading.Thread(
            target=self._run,
            args=(active,),
            name="dimos-dog-motion",
            daemon=True,
        )
        thread.start()

    def _begin(self, command: VelocityCommand) -> _ActiveMotion:
        if command.duration_s <= 0 or not math.isfinite(command.duration_s):
            raise ValueError("command duration_s must be a positive finite number")

        active = _ActiveMotion(
            command=command,
            started_at=time.monotonic(),
            stop_event=threading.Event(),
        )
        with self._lock:
            if self._active is not None:
                raise MotionBusyError("A movement command is already active; call stop_all first")
            self._active = active
            self._last_command = command
            self._last_outcome = None
        return active

    def _run(self, active: _ActiveMotion) -> MotionOutcome:
        command = active.command
        state: Literal["completed", "stopped"] = "completed"
        try:
            deadline = active.started_at + command.duration_s
            while True:
                remaining_s = deadline - time.monotonic()
                if remaining_s <= 0:
                    break

                with self._lock:
                    if self._active is not active or active.stop_event.is_set():
                        state = "stopped"
                        break
                    self._publish(command)

                active.stop_event.wait(min(self._publish_interval_s, remaining_s))
                if active.stop_event.is_set():
                    state = "stopped"
                    break
        finally:
            with self._lock:
                if self._active is active:
                    self._active = None
                    self._publish(VelocityCommand.zero())
                self._last_outcome = state

        return MotionOutcome(state=state, elapsed_s=time.monotonic() - active.started_at)

    def stop(self) -> bool:
        """Cancel an active command and synchronously publish zero velocity."""

        with self._lock:
            active = self._active
            if active is not None:
                active.stop_event.set()
                self._active = None
                self._last_outcome = "stopped"
            self._publish(VelocityCommand.zero())
        return active is not None

    def status(self) -> MotionStatus:
        """Return local command state without asserting hardware state."""

        with self._lock:
            active = self._active
            if active is None:
                return MotionStatus(
                    active=False,
                    linear_x=None,
                    linear_y=None,
                    angular_z=None,
                    last_command=self._last_command,
                    last_outcome=self._last_outcome,
                )
            return MotionStatus(
                active=True,
                linear_x=active.command.linear_x,
                linear_y=active.command.linear_y,
                angular_z=active.command.angular_z,
                last_command=self._last_command,
                last_outcome=self._last_outcome,
            )
