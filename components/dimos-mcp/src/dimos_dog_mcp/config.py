"""Runtime and network configuration for the standalone DIMOS dog MCP."""

from __future__ import annotations

from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass
from enum import Enum
import os
from pathlib import Path


DEFAULT_MCP_HOST = "127.0.0.1"
DEFAULT_MCP_PORT = 9990
DEFAULT_SEMANTIC_WORLD_PATH = Path("~/.dimos/go2-studio/semantic-world.json")

SEMANTIC_WORLD_PATH_ENV = "DIMOS_SEMANTIC_WORLD_PATH"
MAP_ID_ENV = "DIMOS_MAP_ID"
MAP_VERSION_ENV = "DIMOS_MAP_VERSION"
PREMAP_FILE_ENV = "DIMOS_PREMAP_FILE"
RELOCALIZATION_MIN_LOCAL_POINTS_ENV = "DIMOS_RELOCALIZATION_MIN_LOCAL_POINTS"
TOOL_PROFILE_ENV = "DIMOS_DOG_MCP_TOOL_PROFILE"
DEFAULT_RELOCALIZATION_MIN_LOCAL_POINTS = 50_000


class RuntimeMode(str, Enum):
    """The connection selected for the motion skills."""

    DRY_RUN = "dry-run"
    GO2 = "go2"


class ToolProfile(str, Enum):
    """MCP surface selected for autonomous product use or manual maintenance."""

    PRODUCT = "product"
    MAINTENANCE = "maintenance"


def read_runtime_mode(env: Mapping[str, str] | None = None) -> RuntimeMode:
    """Read the explicitly selected DIMOS dog connection mode.

    The default is deliberately dry-run so installing or starting the MCP
    process never connects to, stands up, or moves a physical robot.
    """

    source = os.environ if env is None else env
    raw_mode = source.get("DIMOS_DOG_MCP_MODE", RuntimeMode.DRY_RUN.value).strip().lower()
    try:
        return RuntimeMode(raw_mode)
    except ValueError as error:
        allowed = ", ".join(mode.value for mode in RuntimeMode)
        raise ValueError(f"DIMOS_DOG_MCP_MODE must be one of: {allowed}; got {raw_mode!r}") from error


@dataclass(frozen=True)
class McpServerConfig:
    """The HTTP interface exposed by the DIMOS MCP server."""

    host: str
    port: int


@dataclass(frozen=True)
class SemanticRuntimeConfig:
    """Persistent semantic-place store and the concrete map it belongs to."""

    storage_path: Path
    map_id: str
    map_version: str


@dataclass(frozen=True)
class RelocalizationRuntimeConfig:
    """Validated premap required for stable cross-session Go2 coordinates."""

    map_file: Path
    min_local_points: int


def read_mcp_server_config(env: Mapping[str, str] | None = None) -> McpServerConfig:
    """Read and validate the standalone MCP HTTP listener configuration."""

    source = os.environ if env is None else env
    host = source.get("DIMOS_DOG_MCP_HOST", DEFAULT_MCP_HOST).strip()
    if not host:
        raise ValueError("DIMOS_DOG_MCP_HOST must be a non-empty host or address")

    raw_port = source.get("DIMOS_DOG_MCP_PORT", str(DEFAULT_MCP_PORT)).strip()
    try:
        port = int(raw_port)
    except ValueError as error:
        raise ValueError("DIMOS_DOG_MCP_PORT must be an integer from 1 to 65535") from error
    if not 1 <= port <= 65535:
        raise ValueError("DIMOS_DOG_MCP_PORT must be an integer from 1 to 65535")

    return McpServerConfig(host=host, port=port)


def read_semantic_runtime_config(
    mode: RuntimeMode,
    env: Mapping[str, str] | None = None,
) -> SemanticRuntimeConfig:
    """Read semantic persistence config, requiring map identity on real Go2."""

    source = os.environ if env is None else env
    storage_raw = source.get(
        SEMANTIC_WORLD_PATH_ENV,
        str(DEFAULT_SEMANTIC_WORLD_PATH),
    ).strip()
    if not storage_raw:
        raise ValueError(f"{SEMANTIC_WORLD_PATH_ENV} must be a non-empty path")

    default_map_id = "replay-map" if mode is RuntimeMode.DRY_RUN else ""
    default_map_version = "replay-v1" if mode is RuntimeMode.DRY_RUN else ""
    map_id = source.get(MAP_ID_ENV, default_map_id).strip()
    map_version = source.get(MAP_VERSION_ENV, default_map_version).strip()
    if not map_id:
        raise ValueError(f"{MAP_ID_ENV} is required in {mode.value} mode")
    if not map_version:
        raise ValueError(f"{MAP_VERSION_ENV} is required in {mode.value} mode")

    return SemanticRuntimeConfig(
        storage_path=Path(storage_raw).expanduser(),
        map_id=map_id,
        map_version=map_version,
    )


def read_relocalization_runtime_config(
    env: Mapping[str, str] | None = None,
) -> RelocalizationRuntimeConfig:
    """Require an existing premap before constructing the Stage 2 Go2 stack."""

    source = os.environ if env is None else env
    raw_path = source.get(PREMAP_FILE_ENV, "").strip()
    if not raw_path:
        raise ValueError(
            f"{PREMAP_FILE_ENV} is required in go2 mode; "
            "record and export a .pc2.lcm premap first"
        )

    map_file = Path(raw_path).expanduser()
    if not map_file.is_file():
        raise ValueError(
            f"{PREMAP_FILE_ENV} does not exist or is not a file: {map_file}"
        )
    raw_min_points = source.get(
        RELOCALIZATION_MIN_LOCAL_POINTS_ENV,
        str(DEFAULT_RELOCALIZATION_MIN_LOCAL_POINTS),
    ).strip()
    try:
        min_local_points = int(raw_min_points)
    except ValueError as error:
        raise ValueError(
            f"{RELOCALIZATION_MIN_LOCAL_POINTS_ENV} must be a positive integer"
        ) from error
    if min_local_points <= 0:
        raise ValueError(
            f"{RELOCALIZATION_MIN_LOCAL_POINTS_ENV} must be a positive integer"
        )
    return RelocalizationRuntimeConfig(
        map_file=map_file,
        min_local_points=min_local_points,
    )


def configure_robot_no_proxy(
    robot_ip: str,
    env: MutableMapping[str, str] | None = None,
) -> None:
    """Keep direct LAN signaling away from macOS/system HTTP proxies."""

    value = robot_ip.strip()
    if not value:
        raise ValueError("robot_ip must be non-empty before configuring NO_PROXY")
    target = os.environ if env is None else env
    for key in ("NO_PROXY", "no_proxy"):
        entries = [
            item.strip()
            for item in target.get(key, "").split(",")
            if item.strip()
        ]
        if value not in entries:
            entries.append(value)
        target[key] = ",".join(entries)


def read_tool_profile(env: Mapping[str, str] | None = None) -> ToolProfile:
    """Read the explicit MCP tool profile; autonomous product is the default."""

    source = os.environ if env is None else env
    raw_profile = source.get(
        TOOL_PROFILE_ENV,
        ToolProfile.PRODUCT.value,
    ).strip().lower()
    try:
        return ToolProfile(raw_profile)
    except ValueError as error:
        allowed = ", ".join(profile.value for profile in ToolProfile)
        raise ValueError(
            f"{TOOL_PROFILE_ENV} must be one of: {allowed}; got {raw_profile!r}"
        ) from error
