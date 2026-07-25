"""Unified stopping skill for the live Go2 module graph."""

from __future__ import annotations

from typing import Protocol

from dimos.agents.annotation import skill
from dimos.navigation.frontier_exploration.wavefront_frontier_goal_selector import (
    WavefrontFrontierExplorer,
)
from dimos.navigation.navigation_spec import NavigationInterfaceSpec
from dimos.navigation.patrolling.module import PatrollingModule
from dimos.spec.utils import Spec

from .stop import StopAllSkill
from .stop_actions import run_stop_actions
from .stroll import StrollSkill


class PersonFollowStopSpec(Spec, Protocol):
    """Minimal structural contract required by the unified stop skill."""

    def stop_following(self) -> str: ...


class Go2StopAllSkill(StopAllSkill):
    """Stop every activity source in the live Go2 graph."""

    _exploration: WavefrontFrontierExplorer
    _patrol: PatrollingModule
    _stroll: StrollSkill
    _person_follow: PersonFollowStopSpec
    _navigation: NavigationInterfaceSpec

    @skill
    def stop_all(self) -> str:
        """Attempt every stop action, ending with a local zero-velocity stop."""

        return run_stop_actions(
            (
                ("mission", self._mission_executor.cancel_active_task),
                ("exploration", self._exploration.end_exploration),
                ("patrol", self._patrol.stop_patrol),
                ("stroll", self._stroll.stop_stroll),
                ("follow", self._person_follow.stop_following),
                ("navigation", self._navigation.cancel_goal),
                ("motion", self._motion.stop_motion),
            )
        )
