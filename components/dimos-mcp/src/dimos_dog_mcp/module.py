"""DIMOS skills that implement timed forward, backward, and stop commands."""

from __future__ import annotations

import json

from dimos.agents.annotation import skill
from dimos.agents.capabilities import CAP_MOVEMENT
from dimos.core.core import rpc
from dimos.core.module import Module
from dimos.core.stream import Out
from dimos.msgs.geometry_msgs.Twist import Twist
from dimos.msgs.geometry_msgs.Vector3 import Vector3

from .config import RuntimeMode, read_runtime_mode
from .motion_runtime import (
    DEFAULT_DURATION_S,
    DEFAULT_SPEED_MPS,
    MotionBusyError,
    MotionRuntime,
    VelocityCommand,
    validate_motion_request,
)


class DogMotionSkill(Module):
    """Expose timed ``cmd_vel`` motions through the native DIMOS MCP server."""

    cmd_vel: Out[Twist]

    _mode: RuntimeMode
    _runtime: MotionRuntime

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._mode = read_runtime_mode()
        self._runtime = MotionRuntime(self._publish_velocity)

    @rpc
    def start(self) -> None:
        super().start()

    @rpc
    def stop(self) -> None:
        self._runtime.stop()
        super().stop()

    @skill(uses=[CAP_MOVEMENT])
    def move_forward(
        self,
        speed_mps: float = DEFAULT_SPEED_MPS,
        duration_s: float = DEFAULT_DURATION_S,
    ) -> str:
        """Move forward at the requested speed and duration, then send a zero-velocity stop.

        Args:
            speed_mps: Positive finite forward speed in m/s.
            duration_s: Positive finite motion duration in seconds.
        """

        return self._move("forward", 1.0, speed_mps, duration_s)

    @skill(uses=[CAP_MOVEMENT])
    def move_backward(
        self,
        speed_mps: float = DEFAULT_SPEED_MPS,
        duration_s: float = DEFAULT_DURATION_S,
    ) -> str:
        """Move backward at the requested speed and duration, then send a zero-velocity stop.

        Args:
            speed_mps: Positive finite reverse speed magnitude in m/s.
            duration_s: Positive finite motion duration in seconds.
        """

        return self._move("backward", -1.0, speed_mps, duration_s)

    @rpc
    def stop_motion(self) -> str:
        """Immediately cancel local motion and publish a zero ``cmd_vel`` command.

        The movement executor runs outside the request handler, so this tool
        can preempt a forward or backward command even if DIMOS serializes RPC
        calls for the module.
        """

        was_active = self._runtime.stop()
        status = "stopped" if was_active else "already_idle"
        return json.dumps({"status": status, "zero_velocity_published": True})

    @skill
    def motion_status(self) -> str:
        """Return local motion-command state; this is not a robot telemetry query."""

        status = self._runtime.status()
        last_command = status.last_command
        return json.dumps(
            {
                "mode": self._mode.value,
                "real_motion_enabled": self._mode is RuntimeMode.GO2,
                "active": status.active,
                "command_state": "active" if status.active else "idle",
                "linear_x_mps": status.linear_x,
                "linear_y_mps": status.linear_y,
                "angular_z_radps": status.angular_z,
                "last_command": (
                    {
                        "linear_x_mps": last_command.linear_x,
                        "linear_y_mps": last_command.linear_y,
                        "angular_z_radps": last_command.angular_z,
                        "duration_s": last_command.duration_s,
                    }
                    if last_command is not None
                    else None
                ),
                "last_outcome": status.last_outcome,
            }
        )

    def _move(self, direction: str, sign: float, speed_mps: object, duration_s: object) -> str:
        try:
            speed, duration = validate_motion_request(speed_mps, duration_s)
            command = VelocityCommand(
                linear_x=sign * speed,
                linear_y=0.0,
                angular_z=0.0,
                duration_s=duration,
            )
            self._runtime.start(command)
        except (MotionBusyError, ValueError) as error:
            return json.dumps(
                {
                    "status": "error",
                    "error": str(error),
                }
            )

        if self._mode is RuntimeMode.DRY_RUN:
            status = "dry_run"
            message = "No hardware connection was started and no non-zero cmd_vel was published."
        else:
            status = "started"
            message = "Call stop_all to stop before the requested duration expires."
        return json.dumps(
            {
                "status": status,
                "direction": direction,
                "linear_x_mps": command.linear_x,
                "duration_s": command.duration_s,
                "message": message,
            }
        )

    def _publish_velocity(self, command: VelocityCommand) -> None:
        if self._mode is RuntimeMode.DRY_RUN and command != VelocityCommand.zero():
            return
        self.cmd_vel.publish(
            Twist(
                Vector3(command.linear_x, command.linear_y, 0.0),
                Vector3(0.0, 0.0, command.angular_z),
            )
        )
