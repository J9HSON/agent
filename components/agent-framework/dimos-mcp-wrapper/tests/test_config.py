from __future__ import annotations

import unittest

from dimos_mcp_wrapper.config import read_wrapper_config


class WrapperConfigTests(unittest.TestCase):
    def test_default_timeout_covers_the_atomic_return_and_greeting_workflow(
        self,
    ) -> None:
        config = read_wrapper_config({})

        self.assertEqual(config.timeout_s, 120.0)

    def test_reads_explicit_upstream_endpoint_port_and_timeout(self) -> None:
        config = read_wrapper_config(
            {
                "DIMOS_MCP_WRAPPER_UPSTREAM_URL": "http://robot.local:9990/mcp",
                "DIMOS_MCP_WRAPPER_PORT": "10001",
                "DIMOS_MCP_WRAPPER_TIMEOUT_S": "3.5",
            }
        )

        self.assertEqual(config.upstream_url, "http://robot.local:9990/mcp")
        self.assertEqual(config.mcp_port, 10001)
        self.assertEqual(config.timeout_s, 3.5)
