from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


@unittest.skipUnless(os.name == "posix", "requires a POSIX shell")
class Go2LauncherTests(unittest.TestCase):
    def test_launcher_preflights_cuda_with_packaged_nvidia_libraries(self) -> None:
        script = Path(__file__).resolve().parents[1] / "scripts" / "run-go2-mcp.sh"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            bin_dir = root / "venv" / "bin"
            site_packages = root / "venv" / "lib" / "python3.12" / "site-packages"
            cuda_runtime_lib = site_packages / "nvidia" / "cuda_runtime" / "lib"
            cudnn_lib = site_packages / "nvidia" / "cudnn" / "lib"
            ignored_cuda_13_lib = site_packages / "nvidia" / "cu13" / "lib"
            bin_dir.mkdir(parents=True)
            cuda_runtime_lib.mkdir(parents=True)
            cudnn_lib.mkdir(parents=True)
            ignored_cuda_13_lib.mkdir(parents=True)

            preflight_marker = root / "preflight-ran"
            python = bin_dir / "python"
            python.write_text(
                "#!/usr/bin/env bash\n"
                "set -Eeuo pipefail\n"
                'printf "preflight" > "$PREFLIGHT_MARKER"\n',
                encoding="utf-8",
            )
            python.chmod(0o755)

            launcher = bin_dir / "dimos-dog-mcp"
            launcher.write_text(
                "#!/usr/bin/env bash\n"
                "set -Eeuo pipefail\n"
                'printf "launcher-ld=%s\\n" "$LD_LIBRARY_PATH"\n',
                encoding="utf-8",
            )
            launcher.chmod(0o755)

            env_file = root / "go2.env"
            env_file.write_text(
                "ROBOT_IP=192.0.2.1\nUNITREE_AES_128_KEY=test-only\n",
                encoding="utf-8",
            )
            env_file.chmod(0o600)

            environment = os.environ.copy()
            environment.update(
                {
                    "DIMOS_DOG_MCP_ENV_FILE": str(env_file),
                    "DIMOS_DOG_MCP_LAUNCHER": str(launcher),
                    "LD_LIBRARY_PATH": "/existing/lib",
                    "PREFLIGHT_MARKER": str(preflight_marker),
                }
            )
            result = subprocess.run(
                ["bash", str(script)],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(preflight_marker.read_text(encoding="utf-8"), "preflight")
            self.assertIn(str(cuda_runtime_lib), result.stdout)
            self.assertIn(str(cudnn_lib), result.stdout)
            self.assertNotIn(str(ignored_cuda_13_lib), result.stdout)
            self.assertIn("/existing/lib", result.stdout)
