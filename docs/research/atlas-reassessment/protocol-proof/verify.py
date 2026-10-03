#!/usr/bin/env python3
"""Run only the isolated fidelity experiment; generated files are disposable."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent
LOCK = json.loads((ROOT / "toolchain.json").read_text())
PREFIX = Path(os.environ.get("ATLAS_PROOF_TOOLS", "/tmp/atlas-protocol-tools"))


def install_archive(tool, destination):
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=PREFIX, suffix=".tar.gz") as download:
        with urllib.request.urlopen(tool["linux_amd64_url"]) as source:
            shutil.copyfileobj(source, download)
        download.flush()
        assert hashlib.sha256(Path(download.name).read_bytes()).hexdigest() == tool["sha256"]
        with tarfile.open(download.name) as archive:
            archive.extractall(destination, filter="data")


def run(arguments, env, capture=False):
    print("+ " + " ".join(map(str, arguments)), flush=True)
    result = subprocess.run(list(map(str, arguments)), cwd=ROOT, env=env,
                            check=True, text=True, capture_output=capture)
    return result.stdout.strip() if capture else None


def snapshot():
    return {str(path.relative_to(ROOT / "generated")): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((ROOT / "generated").rglob("*")) if path.is_file()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap", action="store_true", help="download checksum-pinned Go/sqlc when absent")
    args = parser.parse_args()
    PREFIX.mkdir(parents=True, exist_ok=True)
    go = PREFIX / "go/bin/go"
    sqlc = PREFIX / "bin/sqlc"
    if args.bootstrap:
        if not go.exists(): install_archive(LOCK["go"], PREFIX)
        if not sqlc.exists(): install_archive(LOCK["sqlc"], PREFIX / "bin")
    if not go.exists() or not sqlc.exists():
        parser.error("Go/sqlc are absent; use --bootstrap or ATLAS_PROOF_TOOLS")
    env = {**os.environ, "PATH": str(go.parent) + os.pathsep + os.environ["PATH"], "GOFLAGS": "-mod=readonly"}
    assert run([go, "version"], env, True).split()[2] == LOCK["go"]["version"]
    assert run([sqlc, "version"], env, True) == LOCK["sqlc"]["version"]
    assert run(["node", "--version"], env, True) == LOCK["node"]
    assert run(["npm", "--version"], env, True) == LOCK["npm"]
    run(["npm", "ci", "--ignore-scripts"], env)
    run([go, "mod", "verify"], env)

    def generate():
        # Remove the entire owned output directory, then regenerate from sources.
        output = ROOT / "generated"
        if output.exists(): shutil.rmtree(output)
        output.mkdir()
        run([go, "tool", "-modfile=tools/go.mod", "oapi-codegen", "--config", "oapi-codegen.yaml", "protocol.json"], env)
        run([sqlc, "generate"], env)
        run(["npm", "run", "generate"], env)

    generate()
    first = snapshot()
    assert first, "no generated outputs"
    generate()
    assert snapshot() == first, "clean regeneration changed output"
    print(f"PASS clean regeneration: {len(first)} files match byte-for-byte", flush=True)
    run(["npm", "run", "check"], env)
    formatted = run([go.parent / "gofmt", "-l", "server.go", "server_test.go"], env, True)
    assert not formatted, f"Go formatting mismatch: {formatted}"
    run([go, "test", "./..."], env)
    run([go, "vet", "./..."], env)
    run([go, "build", "-o", ".proof-server", "."], env)
    run(["npm", "test"], env)
    print("PASS complete isolated Protocol fidelity proof", flush=True)


if __name__ == "__main__":
    main()
