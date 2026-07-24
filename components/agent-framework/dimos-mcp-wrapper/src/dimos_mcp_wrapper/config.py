"""Explicit runtime configuration for the DIMOS MCP wrapper."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import math
import os
from urllib.parse import urlparse


DEFAULT_UPSTREAM_URL = "http://127.0.0.1:9990/mcp"
DEFAULT_MCP_PORT = 9991
DEFAULT_TIMEOUT_S = 120.0

UPSTREAM_URL_ENV = "DIMOS_MCP_WRAPPER_UPSTREAM_URL"
MCP_PORT_ENV = "DIMOS_MCP_WRAPPER_PORT"
TIMEOUT_ENV = "DIMOS_MCP_WRAPPER_TIMEOUT_S"


@dataclass(frozen=True)
class WrapperConfig:
    """The wrapper endpoint and the single upstream MCP endpoint it forwards to."""

    upstream_url: str
    mcp_port: int
    timeout_s: float


def read_wrapper_config(env: Mapping[str, str] | None = None) -> WrapperConfig:
    """Read and validate wrapper configuration without connecting to hardware."""

    source = os.environ if env is None else env
    upstream_url = source.get(UPSTREAM_URL_ENV, DEFAULT_UPSTREAM_URL).strip()
    _validate_upstream_url(upstream_url)
    return WrapperConfig(
        upstream_url=upstream_url,
        mcp_port=_read_port(source.get(MCP_PORT_ENV, str(DEFAULT_MCP_PORT))),
        timeout_s=_read_timeout(source.get(TIMEOUT_ENV, str(DEFAULT_TIMEOUT_S))),
    )


def _validate_upstream_url(value: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{UPSTREAM_URL_ENV} must be an absolute HTTP(S) URL")
    if not parsed.path:
        raise ValueError(f"{UPSTREAM_URL_ENV} must include an MCP endpoint path")
    if parsed.params or parsed.query or parsed.fragment:
        raise ValueError(f"{UPSTREAM_URL_ENV} must not include params, query, or fragment")


def _read_port(raw_value: str) -> int:
    try:
        port = int(raw_value)
    except ValueError as error:
        raise ValueError(f"{MCP_PORT_ENV} must be an integer from 1 to 65535") from error
    if not 1 <= port <= 65535:
        raise ValueError(f"{MCP_PORT_ENV} must be an integer from 1 to 65535")
    return port


def _read_timeout(raw_value: str) -> float:
    try:
        timeout_s = float(raw_value)
    except ValueError as error:
        raise ValueError(f"{TIMEOUT_ENV} must be a positive finite number") from error
    if not math.isfinite(timeout_s) or timeout_s <= 0:
        raise ValueError(f"{TIMEOUT_ENV} must be a positive finite number")
    return timeout_s
