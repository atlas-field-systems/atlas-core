#!/usr/bin/env python3
"""Build the local management CLI and load the Core container image."""

import shutil
import tempfile
from pathlib import Path

from toolchain import ROOT, prepare, run

ARTIFACTS = ROOT / ".artifacts"
MANAGE = ARTIFACTS / "atlas-manage"
IMAGE = "atlas-core:dev"
# The same Core under another writing release, for incompatible-release refusal.
RELEASE_PROBE_IMAGE = "atlas-core:release-probe"


def build_core(env, go):
    """Build atlas-manage and the static Core binary, then load the image locally."""
    core = ROOT / "Atlas Core"
    ARTIFACTS.mkdir(exist_ok=True)
    run([go, "build", "-trimpath", "-o", MANAGE, "./cmd/atlas-manage"], env, cwd=core)
    for image, flags in [(IMAGE, []), (RELEASE_PROBE_IMAGE, ["-ldflags", "-X main.release=0.0.0-release-probe"])]:
        with tempfile.TemporaryDirectory(prefix="atlas-core-image-") as context:
            static = {**env, "CGO_ENABLED": "0"}
            binary = Path(context) / "atlas-core"
            run([go, "build", "-trimpath", *flags, "-o", binary, "./cmd/atlas-core"], static, cwd=core)
            shutil.copyfile(core / "Dockerfile", Path(context) / "Dockerfile")
            # The image is built from the local binary only; nothing is pulled.
            run(["docker", "build", "--pull=false", "--tag", image, context], env, timeout=300)
    print(f"PASS built {MANAGE.relative_to(ROOT)} and loaded images {IMAGE} and {RELEASE_PROBE_IMAGE}", flush=True)


if __name__ == "__main__":
    tools = prepare(bootstrap=False)
    build_core(tools.env, tools.go)
