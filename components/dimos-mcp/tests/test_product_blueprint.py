from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from dimos_dog_mcp import blueprint as blueprint_module
from dimos_dog_mcp.config import (
    RuntimeMode,
    ToolProfile,
    read_relocalization_runtime_config,
    read_semantic_runtime_config,
)
from dimos_dog_mcp.tool_contract import (
    LEGACY_MOVEMENT_TOOL_NAMES,
    public_tool_names_for_profile,
)
import tomllib

from dimos.core.module import SkillInfo
from dimos.navigation.navigation_spec import NavigationInterfaceSpec
from dimos.spec.utils import spec_structural_compliance

_SEMANTIC_ENV = {
    "DIMOS_SEMANTIC_WORLD_PATH": "/tmp/dimos-s2-product-blueprint.json",
    "DIMOS_MAP_ID": "venue-hall",
    "DIMOS_MAP_VERSION": "map-v1",
}


class ProductBlueprintTests(unittest.TestCase):
    def test_package_declares_the_shared_dimos_go2_studio_dependency(self) -> None:
        pyproject_path = Path(__file__).resolve().parents[1] / "pyproject.toml"
        project = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))

        self.assertIn(
            "dimos-go2-studio==0.1.0",
            project["project"]["dependencies"],
        )
        self.assertEqual(
            project["tool"]["uv"]["sources"]["dimos-go2-studio"]["path"],
            "../../../dimos/extensions/go2-studio-agent",
        )
        self.assertEqual(
            project["tool"]["uv"]["sources"]["dimos"]["path"],
            "../../../dimos",
        )
        self.assertIn(
            "dimos[cuda,misc,perception,unitree]==0.0.14b1",
            project["project"]["optional-dependencies"]["go2"],
        )

    def test_dry_run_composes_one_mission_world_navigator_and_server(self) -> None:
        environment = {
            "DIMOS_DOG_MCP_MODE": "dry-run",
            **_SEMANTIC_ENV,
        }
        with patch.dict(os.environ, environment, clear=False):
            blueprint = blueprint_module.build_blueprint()

        names = [atom.module.__name__ for atom in blueprint.blueprints]
        self.assertEqual(names.count("SemanticWorld"), 1)
        self.assertEqual(names.count("MissionExecutor"), 1)
        self.assertEqual(names.count("DryRunNavigationSkill"), 1)
        self.assertEqual(names.count("DogMcpServer"), 1)
        self.assertEqual(self._navigation_provider_count(blueprint), 1)

    def test_go2_composes_one_robot_task_world_navigator_and_server(self) -> None:
        from dimos.core.coordination.module_coordinator import _resolve_single_ref

        with tempfile.TemporaryDirectory() as temp_dir:
            premap = Path(temp_dir) / "venue.pc2.lcm"
            premap.write_bytes(b"blueprint-only fixture")
            environment = {
                "DIMOS_DOG_MCP_MODE": "go2",
                "DIMOS_PREMAP_FILE": str(premap),
                "DIMOS_RELOCALIZATION_MIN_LOCAL_POINTS": "35000",
                **_SEMANTIC_ENV,
            }
            with patch.dict(os.environ, environment, clear=False):
                blueprint = blueprint_module.build_blueprint()

        names = [atom.module.__name__ for atom in blueprint.blueprints]
        self.assertEqual(names.count("GO2Connection"), 1)
        self.assertEqual(names.count("RelocalizationModule"), 1)
        self.assertEqual(names.count("SemanticWorld"), 1)
        self.assertEqual(names.count("MissionExecutor"), 1)
        self.assertEqual(names.count("SemanticVisualizationAdapter"), 1)
        self.assertEqual(names.count("DogMcpServer"), 1)
        self.assertEqual(names.count("SpatialMemory"), 1)
        self.assertEqual(names.count("NavigationSkillContainer"), 1)
        self.assertEqual(names.count("PersonFollowSkillContainer"), 1)
        self.assertEqual(self._navigation_provider_count(blueprint), 1)
        self.assertNotIn("McpClient", names)
        self.assertNotIn("Agent", names)
        self.assertNotIn("VLMAgent", names)
        self.assertNotIn("PerceiveLoopSkill", names)
        self.assertNotIn("ReturnToUserAndGreetSkill", names)
        relocalization = next(
            atom
            for atom in blueprint.blueprints
            if atom.module.__name__ == "RelocalizationModule"
        )
        self.assertEqual(relocalization.kwargs["map_file"], str(premap))
        self.assertEqual(relocalization.kwargs["min_local_points"], 35_000)
        semantic_world = next(
            atom
            for atom in blueprint.blueprints
            if atom.module.__name__ == "SemanticWorld"
        )
        self.assertEqual(semantic_world.kwargs["canonical_frame_id"], "map")
        self.assertEqual(semantic_world.kwargs["navigation_frame_id"], "world")

        for atom in blueprint.active_blueprints:
            for module_ref in atom.module_refs:
                _resolve_single_ref(
                    atom,
                    module_ref,
                    module_ref.spec,
                    blueprint,
                    set(),
                )

    def test_product_profile_restores_official_s2_tools_with_only_relative_move(
        self,
    ) -> None:
        names = public_tool_names_for_profile(ToolProfile.PRODUCT)

        self.assertTrue(
            {
                "tag_location",
                "navigate_with_text",
                "stop_navigation",
                "follow_person",
                "start_task",
                "pause_task",
                "resume_task",
                "cancel_task",
                "get_task_status",
                "list_semantic_places",
                "confirm_semantic_place",
                "stop_all",
                "relative_move",
            }
            <= names
        )
        self.assertTrue(
            names.isdisjoint(LEGACY_MOVEMENT_TOOL_NAMES - {"relative_move"})
        )

    def test_maintenance_profile_retains_legacy_tools(self) -> None:
        names = public_tool_names_for_profile(ToolProfile.MAINTENANCE)

        self.assertTrue(LEGACY_MOVEMENT_TOOL_NAMES <= names)
        self.assertIn("start_task", names)
        self.assertIn("cancel_task", names)
        self.assertIn("follow_person", names)
        self.assertIn("stop_following", names)

    def test_server_applies_product_allowlist_before_registering_rpc_calls(
        self,
    ) -> None:
        from dimos_dog_mcp.server import DogMcpServer

        from dimos.agents.mcp.mcp_server import app

        class FakeModule:
            def get_skills(self) -> list[SkillInfo]:
                return [
                    SkillInfo(
                        class_name="FakeSkills",
                        func_name=name,
                        args_schema="{}",
                    )
                    for name in public_tool_names_for_profile(ToolProfile.MAINTENANCE)
                ]

        server = object.__new__(DogMcpServer)
        server.rpc = object()
        with patch.dict(
            os.environ,
            {"DIMOS_DOG_MCP_TOOL_PROFILE": "product"},
            clear=False,
        ):
            server.on_system_modules([FakeModule()])

        names = set(app.state.skills_by_name)
        self.assertEqual(
            names,
            public_tool_names_for_profile(ToolProfile.PRODUCT),
        )
        self.assertIn("relative_move", app.state.rpc_calls)
        self.assertTrue(
            set(app.state.rpc_calls).isdisjoint(
                LEGACY_MOVEMENT_TOOL_NAMES - {"relative_move"}
            )
        )

    def test_go2_semantic_identity_is_required_before_module_build(self) -> None:
        with self.assertRaisesRegex(ValueError, "DIMOS_MAP_ID"):
            read_semantic_runtime_config(RuntimeMode.GO2, {})

        with self.assertRaisesRegex(ValueError, "DIMOS_MAP_VERSION"):
            read_semantic_runtime_config(
                RuntimeMode.GO2,
                {"DIMOS_MAP_ID": "venue-hall"},
            )

    def test_go2_requires_an_existing_premap_before_module_build(self) -> None:
        with self.assertRaisesRegex(ValueError, "DIMOS_PREMAP_FILE"):
            read_relocalization_runtime_config({})

        with self.assertRaisesRegex(ValueError, "does not exist"):
            read_relocalization_runtime_config(
                {"DIMOS_PREMAP_FILE": "/tmp/definitely-missing.pc2.lcm"}
            )

        with tempfile.NamedTemporaryFile(suffix=".pc2.lcm") as premap:
            with self.assertRaisesRegex(ValueError, "positive integer"):
                read_relocalization_runtime_config(
                    {
                        "DIMOS_PREMAP_FILE": premap.name,
                        "DIMOS_RELOCALIZATION_MIN_LOCAL_POINTS": "0",
                    }
                )

    @staticmethod
    def _navigation_provider_count(blueprint: object) -> int:
        return sum(
            1
            for atom in blueprint.active_blueprints
            if spec_structural_compliance(atom.module, NavigationInterfaceSpec)
        )


if __name__ == "__main__":
    unittest.main()
