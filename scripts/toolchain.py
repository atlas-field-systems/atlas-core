"""Protocol-owned tool locks, checked before generation."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

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
    print("+ " + " ".join(map(str, arguments)), flush=True)
    try:
        result = subprocess.run(list(map(str, arguments)), cwd=cwd, env=env, check=True,
                                text=True, capture_output=capture, timeout=timeout)
    except subprocess.CalledProcessError as error:
        if capture:
            print(error.stdout or "", end="")
            print(error.stderr or "", end="")
        raise
    return result.stdout.strip() if capture else None


def prepare(bootstrap):
    cache = Path(os.environ.get("ATLAS_TOOLS", Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "atlas-protocol-tools"))
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    go, sqlc = cache / "go/bin/go", cache / "bin/sqlc"
    if bootstrap:
        if not go.exists():
            install_archive(LOCK["go"], cache, cache)
        if not sqlc.exists():
            install_archive(LOCK["sqlc"], cache / "bin", cache)
    if not go.exists() or not sqlc.exists():
        raise ValueError("Go/sqlc are absent; run python3 scripts/verify.py --bootstrap or set ATLAS_TOOLS")
    env = {**os.environ, "PATH": str(go.parent) + os.pathsep + os.environ["PATH"], "GOFLAGS": "-mod=readonly", "GOTOOLCHAIN": "local"}
    actual_go = run([go, "version"], env, capture=True)
    require_version(actual_go.split()[2], LOCK["go"]["version"], "Go")
    for command, expected in [([sqlc, "version"], LOCK["sqlc"]["version"]),
                              (["node", "--version"], LOCK["node"]), (["npm", "--version"], LOCK["npm"])]:
        require_version(run(command, env, capture=True), expected, str(command[0]))
    generator = run([go, "tool", f"-modfile={ROOT / 'Atlas Protocol/tools/go.mod'}", "oapi-codegen", "--version"], env, cwd=ROOT / "Atlas Protocol/tools", capture=True)
    require_version(generator.splitlines()[-1], LOCK["oapi_codegen"], "oapi-codegen")
    return env, go, sqlc
