from __future__ import annotations

import random
import unittest

from dimos_dog_mcp.stroll_policy import StrollCandidate, StrollPolicy
from dimos_dog_mcp.tool_contract import (
    MAINTENANCE_TOOL_NAMES,
    PRODUCT_TOOL_NAMES,
    PUBLIC_TOOL_NAMES,
)


class StrollPolicyTests(unittest.TestCase):
    def test_versioned_public_contract_matches_the_maintenance_profile(self) -> None:
        self.assertEqual(PUBLIC_TOOL_NAMES, MAINTENANCE_TOOL_NAMES)
        self.assertEqual(len(PUBLIC_TOOL_NAMES), 32)
        self.assertTrue(
            {
                "server_status",
                "observe",
                "start_patrol",
                "return_to_start",
                "get_robot_summary",
                "return_to_user_and_greet",
                "start_stroll",
                "start_task",
                "get_task_status",
                "cancel_task",
                "list_semantic_places",
                "confirm_semantic_place",
                "stop_all",
            }
            <= PUBLIC_TOOL_NAMES
        )
        self.assertTrue(
            {
                "speak",
                "stop_motion",
                "end_exploration",
                "stop_patrol",
                "stop_stroll",
                "stop_looking_out",
            }.isdisjoint(PUBLIC_TOOL_NAMES)
        )
        self.assertIn("follow_person", PRODUCT_TOOL_NAMES)
        self.assertIn("stop_navigation", PRODUCT_TOOL_NAMES)

    def test_randomly_chooses_one_branch_and_retires_its_siblings(self) -> None:
        policy = StrollPolicy(random.Random(7))
        candidates = [
            StrollCandidate("left", 2.0, 1.0),
            StrollCandidate("straight", 3.0, 0.0),
            StrollCandidate("right", 2.0, -1.0),
        ]

        selected = policy.choose(candidates, origin_x=0.0, origin_y=0.0)

        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(policy.retired_branch_ids, {"left", "straight", "right"} - {selected.branch_id})

    def test_never_returns_to_a_retired_branch(self) -> None:
        policy = StrollPolicy(random.Random(3))
        candidates = [
            StrollCandidate("chosen", 2.0, 0.0),
            StrollCandidate("skipped", 2.0, 1.0),
        ]
        selected = policy.choose(candidates, origin_x=0.0, origin_y=0.0)
        assert selected is not None

        later = policy.choose(
            [
                StrollCandidate("skipped", 2.0, 1.0),
                StrollCandidate("continuation", 4.0, 0.2),
            ],
            origin_x=selected.x,
            origin_y=selected.y,
        )

        self.assertIsNotNone(later)
        assert later is not None
        self.assertEqual(later.branch_id, "continuation")

    def test_stops_instead_of_backtracking_when_only_candidates_are_behind(self) -> None:
        policy = StrollPolicy(random.Random(1))
        first = policy.choose(
            [StrollCandidate("forward", 2.0, 0.0)],
            origin_x=0.0,
            origin_y=0.0,
        )
        assert first is not None

        selected = policy.choose(
            [StrollCandidate("behind", -1.0, 0.0)],
            origin_x=first.x,
            origin_y=first.y,
        )

        self.assertIsNone(selected)
