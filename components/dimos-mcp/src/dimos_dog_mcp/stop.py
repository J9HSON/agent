"""Unified stopping skill for the standalone dog MCP."""

from __future__ import annotations

from dimos.agents.annotation import skill
from dimos.core.module import Module
from dimos_go2_studio.mission_executor import MissionExecutorControlSpec

from .module import DogMotionSkill
from .stop_actions import run_stop_actions


class StopAllSkill(Module):
    """Stop all activities configured in dry-run mode."""

    _mission_executor: MissionExecutorControlSpec
    _motion: DogMotionSkill

    @skill
    def stop_all(self) -> str:
        """Stop every configured activity and return the outcome of each stop."""

        return run_stop_actions(
            (
                ("mission", self._mission_executor.cancel_active_task),
                ("motion", self._motion.stop_motion),
            )
        )
