"""Exclusive ownership and diagnostics for the standalone dog runtime."""

from __future__ import annotations

from collections.abc import Iterator, Mapping, MutableMapping
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
import fcntl
import json
import os
from pathlib import Path
import socket
from typing import TextIO

from .config import McpServerConfig, RuntimeMode


RUNTIME_LOCK_FILE_ENV = "DIMOS_DOG_MCP_RUNTIME_LOCK_FILE"
RUNTIME_OWNER_PID_ENV = "DIMOS_DOG_MCP_OWNER_PID"
RUNTIME_STARTED_AT_ENV = "DIMOS_DOG_MCP_STARTED_AT"
DEFAULT_RUNTIME_LOCK_FILE = Path.home() / ".cache" / "dimos-dog-mcp" / "runtime.lock"


class RuntimeOwnershipError(RuntimeError):
    """Raised before module construction when another runtime owns the robot."""


@dataclass(frozen=True)
class RuntimeOwnerMetadata:
    """Identity written to the process lock and exposed by ``server_status``."""

    pid: int
    mode: str
    robot_ip: str | None
    host: str
    port: int
    started_at: str


def utc_now_iso() -> str:
    """Return a stable UTC timestamp for runtime evidence."""

    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@contextmanager
def claim_runtime(
    config: McpServerConfig,
    mode: RuntimeMode,
    *,
    lock_file: Path | None = None,
    env: MutableMapping[str, str] | None = None,
) -> Iterator[RuntimeOwnerMetadata]:
    """Claim the single dog runtime before any module can connect to hardware."""

    environment = os.environ if env is None else env
    resolved_lock_file = lock_file or Path(
        environment.get(RUNTIME_LOCK_FILE_ENV, str(DEFAULT_RUNTIME_LOCK_FILE))
    ).expanduser()
    resolved_lock_file.parent.mkdir(parents=True, exist_ok=True)
    handle = resolved_lock_file.open("a+", encoding="utf-8")
    previous_owner_env = {
        key: environment.get(key)
        for key in (RUNTIME_OWNER_PID_ENV, RUNTIME_STARTED_AT_ENV)
    }
    try:
        _acquire_lock(handle, resolved_lock_file)
        _assert_mcp_port_available(config)
        metadata = RuntimeOwnerMetadata(
            pid=os.getpid(),
            mode=mode.value,
            robot_ip=_read_robot_ip(environment),
            host=config.host,
            port=config.port,
            started_at=utc_now_iso(),
        )
        handle.seek(0)
        handle.truncate()
        json.dump(asdict(metadata), handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
        environment[RUNTIME_OWNER_PID_ENV] = str(metadata.pid)
        environment[RUNTIME_STARTED_AT_ENV] = metadata.started_at
        yield metadata
    finally:
        for key, previous_value in previous_owner_env.items():
            if previous_value is None:
                environment.pop(key, None)
            else:
                environment[key] = previous_value
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def read_runtime_owner_metadata(
    env: Mapping[str, str] | None = None,
    *,
    fallback_started_at: str,
) -> RuntimeOwnerMetadata:
    """Read the owner identity inherited by the MCP worker process."""

    environment = os.environ if env is None else env
    raw_pid = environment.get(RUNTIME_OWNER_PID_ENV)
    try:
        pid = int(raw_pid) if raw_pid is not None else os.getpid()
    except ValueError:
        pid = os.getpid()
    mode = environment.get("DIMOS_DOG_MCP_MODE", RuntimeMode.DRY_RUN.value)
    raw_port = environment.get("DIMOS_DOG_MCP_PORT", "9990")
    try:
        port = int(raw_port)
    except ValueError:
        port = 9990
    return RuntimeOwnerMetadata(
        pid=pid,
        mode=mode,
        robot_ip=_read_robot_ip(environment),
        host=environment.get("DIMOS_DOG_MCP_HOST", "127.0.0.1"),
        port=port,
        started_at=environment.get(RUNTIME_STARTED_AT_ENV, fallback_started_at),
    )


def _acquire_lock(handle: TextIO, lock_file: Path) -> None:
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        handle.seek(0)
        existing_owner = handle.read().strip() or "unknown owner"
        raise RuntimeOwnershipError(
            f"Go2 runtime is already owned via {lock_file}: {existing_owner}"
        ) from error


def _assert_mcp_port_available(config: McpServerConfig) -> None:
    family = socket.AF_INET6 if ":" in config.host else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            probe.bind((config.host, config.port))
    except OSError as error:
        raise RuntimeOwnershipError(
            f"MCP port {config.host}:{config.port} is already occupied; "
            "refusing to connect or start another Go2 runtime"
        ) from error


def _read_robot_ip(env: Mapping[str, str]) -> str | None:
    robot_ip = env.get("ROBOT_IP", "").strip()
    return robot_ip or None
