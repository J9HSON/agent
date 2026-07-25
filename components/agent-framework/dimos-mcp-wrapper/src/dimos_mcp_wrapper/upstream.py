"""Minimal, no-retry client for forwarding MCP tool calls upstream."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from itertools import count
import json
import math
from threading import Lock
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class McpToolClient(Protocol):
    """The only upstream boundary the forwarding layer needs."""

    def call_tool(self, name: str, arguments: Mapping[str, object]) -> str:
        """Call one upstream MCP tool and return its text result."""


class UpstreamMcpError(RuntimeError):
    """Raised when the upstream MCP endpoint cannot complete a tool call."""


JsonPoster = Callable[[str, dict[str, object], float], dict[str, object]]


class _NoRedirectHandler(HTTPRedirectHandler):
    """Treat every redirect as an upstream failure, never as another tool request."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


_NO_REDIRECT_OPENER = build_opener(ProxyHandler({}), _NoRedirectHandler())


class HttpMcpToolClient:
    """Forward a single MCP ``tools/call`` request over HTTP without retries."""

    def __init__(
        self,
        upstream_url: str,
        *,
        timeout_s: float,
        post_json: JsonPoster | None = None,
    ) -> None:
        if not upstream_url.strip():
            raise ValueError("upstream_url must not be empty")
        if not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError("timeout_s must be a positive finite number")
        self._upstream_url = upstream_url
        self._timeout_s = timeout_s
        self._post_json = _post_json if post_json is None else post_json
        self._request_ids = count(1)
        self._request_id_lock = Lock()

    def call_tool(self, name: str, arguments: Mapping[str, object]) -> str:
        """Forward one tool call and preserve the upstream textual response."""

        response = self._post_json(
            self._upstream_url,
            {
                "jsonrpc": "2.0",
                "id": self._next_request_id(),
                "method": "tools/call",
                "params": {"name": name, "arguments": dict(arguments)},
            },
            self._timeout_s,
        )
        error = response.get("error")
        if isinstance(error, Mapping):
            code = error.get("code", "unknown")
            message = error.get("message", "unknown upstream error")
            raise UpstreamMcpError(f"upstream MCP error {code}: {message}")

        result = response.get("result")
        if not isinstance(result, Mapping):
            raise UpstreamMcpError("upstream MCP response did not contain an object result")
        result_text = _result_text(result)
        _raise_for_tool_error(result_text)
        return result_text

    def _next_request_id(self) -> int:
        with self._request_id_lock:
            return next(self._request_ids)


def _post_json(url: str, body: dict[str, object], timeout_s: float) -> dict[str, object]:
    encoded_body = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = Request(
        url,
        data=encoded_body,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with _NO_REDIRECT_OPENER.open(request, timeout=timeout_s) as response:
            raw_response = response.read().decode("utf-8")
    except HTTPError as error:
        error.close()
        raise UpstreamMcpError(f"upstream MCP returned HTTP {error.code}") from error
    except (TimeoutError, URLError, OSError) as error:
        raise UpstreamMcpError(f"upstream MCP request failed: {error}") from error

    try:
        decoded: object = json.loads(raw_response)
    except json.JSONDecodeError as error:
        raise UpstreamMcpError("upstream MCP returned invalid JSON") from error
    if not isinstance(decoded, dict):
        raise UpstreamMcpError("upstream MCP response must be a JSON object")
    return decoded


def _result_text(result: Mapping[str, object]) -> str:
    content = result.get("content")
    if isinstance(content, list):
        text_parts = [
            item["text"]
            for item in content
            if isinstance(item, Mapping)
            and item.get("type") == "text"
            and isinstance(item.get("text"), str)
        ]
        if text_parts:
            return "\n".join(text_parts)
    return json.dumps(dict(result), ensure_ascii=False, separators=(",", ":"))


def _raise_for_tool_error(result_text: str) -> None:
    """Recognize DIMOS and dog-tool application errors hidden in text content."""

    if result_text.startswith("Error running tool '"):
        raise UpstreamMcpError(result_text)
    try:
        payload: object = json.loads(result_text)
    except json.JSONDecodeError:
        return
    if not isinstance(payload, dict) or payload.get("status") != "error":
        return
    raise UpstreamMcpError(result_text)
