"""Protocol-owned tool locks, checked before generation."""

import hashlib
import json
import os
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from typing import NamedTuple

from command_supervisor import supervised_run

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "Atlas Protocol/toolchain.json").read_text())


def require_version(actual, expected, tool):
    if actual != expected:
        raise ValueError(f"unexpected {tool} version: {actual}; expected {expected}")


def extract_archive(source, expected_checksum, destination):
    with source.open("rb") as content:
        digest = hashlib.file_digest(content, "sha256").hexdigest()
    if digest != expected_checksum:
        raise ValueError(f"checksum mismatch for {source.name}: {digest}")
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(source) as archive:
        archive.extractall(destination, filter="data")


def install_archive(tool, destination, cache):
    with tempfile.NamedTemporaryFile(dir=cache, suffix=".tar.gz") as download:
        with urllib.request.urlopen(tool["linux_amd64_url"], timeout=60) as source:
            shutil.copyfileobj(source, download)
        download.flush()
        extract_archive(Path(download.name), tool["sha256"], destination)


def run(arguments, env, *, cwd=ROOT, capture=False, timeout=180):
    return supervised_run(arguments, env, cwd=cwd, capture=capture, timeout=timeout)


def default_cache():
    cache_home = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return Path(os.environ.get("ATLAS_TOOLS", cache_home / "atlas-protocol-tools"))


class Tools(NamedTuple):
    env: dict
    go: Path
    sqlc: Path
    ruff: Path


def tool_paths(cache):
    """Where each checksum-locked archive places its executable inside the cache."""
    return {
        "go": cache / "go/bin/go",
        "sqlc": cache / "bin/sqlc",
        "ruff": cache / "ruff/ruff-x86_64-unknown-linux-gnu/ruff",
    }


def prepare(bootstrap, cache=None):
    cache = default_cache() if cache is None else cache
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    paths = tool_paths(cache)
    if bootstrap:
        for tool, destination in [("go", cache), ("sqlc", cache / "bin"), ("ruff", cache / "ruff")]:
            if not paths[tool].exists():
                install_archive(LOCK[tool], destination, cache)
    absent = [tool for tool, path in paths.items() if not path.exists()]
    if absent:
        raise ValueError(f"{', '.join(absent)} absent; run python3 scripts/verify.py --bootstrap or set ATLAS_TOOLS")
    go, sqlc, ruff = paths["go"], paths["sqlc"], paths["ruff"]
    env = {
        **os.environ,
        "PATH": str(go.parent) + os.pathsep + os.environ["PATH"],
        "GOFLAGS": "-mod=readonly",
        "GOTOOLCHAIN": "local",
    }
    actual_go = run([go, "version"], env, capture=True)
    require_version(actual_go.split()[2], LOCK["go"]["version"], "Go")
    require_version(run([ruff, "--version"], env, capture=True).split()[-1], LOCK["ruff"]["version"], "ruff")
    for command, expected in [
        ([sqlc, "version"], LOCK["sqlc"]["version"]),
        (["node", "--version"], LOCK["node"]),
        (["npm", "--version"], LOCK["npm"]),
    ]:
        require_version(run(command, env, capture=True), expected, str(command[0]))
    generator = run(
        [go, "tool", f"-modfile={ROOT / 'Atlas Protocol/tools/go.mod'}", "oapi-codegen", "--version"],
        env,
        cwd=ROOT / "Atlas Protocol/tools",
        capture=True,
    )
    require_version(generator.splitlines()[-1], LOCK["oapi_codegen"], "oapi-codegen")
    return Tools(env, go, sqlc, ruff)
