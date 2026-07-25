"""Entry point that exposes the forwarding skills through DIMOS's MCP server."""

from __future__ import annotations

from collections.abc import Iterable

from dimos.core.coordination.blueprints import autoconnect
from dimos.core.coordination.module_coordinator import ModuleCoordinator
from dimos.core.global_config import global_config

from .config import read_wrapper_config
from .hooks import McpCallHook
from .module import McpForwardingSkill
from .server import WrapperMcpServer


def build_blueprint(*, hooks: Iterable[McpCallHook] = ()):
    """Build the wrapper MCP on its own port with optional best-effort hooks."""

    config = read_wrapper_config()
    global_config.update(mcp_port=config.mcp_port)
    return autoconnect(
        McpForwardingSkill.blueprint(
            hooks=tuple(hooks),
            upstream_url=config.upstream_url,
            timeout_s=config.timeout_s,
        ),
        WrapperMcpServer.blueprint(mcp_port=config.mcp_port),
    )


def main() -> None:
    """Run the DIMOS wrapper until the process is stopped."""

    ModuleCoordinator.build(build_blueprint()).loop()


if __name__ == "__main__":
    main()
