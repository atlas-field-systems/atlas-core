"""Qualify the production S1 boundary with real Docker, CLI, SDK and files."""

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import NamedTuple

from command_supervisor import supervised_run
from toolchain import ROOT, run

MAXIMUM_MANIFEST_BYTES = 1048576


class FixtureOwner(NamedTuple):
    root: Path
    manifest: Path
    fixtures: Path


def _installations(manifest):
    with manifest.open("rb") as file:
        data = file.read(MAXIMUM_MANIFEST_BYTES + 1)
    if len(data) > MAXIMUM_MANIFEST_BYTES:
        raise RuntimeError("S1 ownership manifest exceeds its bound")
    result = set()
    for line in data.splitlines():
        value = json.loads(line)
        if not isinstance(value, dict) or set(value) != {"installation_id"}:
            raise RuntimeError("S1 ownership manifest is invalid")
        identity = value["installation_id"]
        if not isinstance(identity, str) or str(uuid.UUID(identity)) != identity:
            raise RuntimeError("S1 ownership manifest has an invalid installation identity")
        result.add(identity)
    return result


def _remove_installation(identity, env, docker):
    errors = []
    for kind, listing in [("container", ["ps", "--all", "--quiet"]), ("network", ["network", "ls", "--quiet"])]:
        try:
            owned = run(
                [*docker, *listing, "--filter", f"label=atlas.installation_id={identity}"], env, capture=True
            ).split()
            for identifier in owned:
                try:
                    remove = ["rm", "--force", identifier] if kind == "container" else ["network", "rm", identifier]
                    run([*docker, *remove], env, timeout=60)
                except (OSError, RuntimeError, subprocess.SubprocessError, BaseExceptionGroup) as error:
                    errors.append(error)
            remaining = run(
                [*docker, *listing, "--filter", f"label=atlas.installation_id={identity}"], env, capture=True
            )
            if remaining:
                errors.append(RuntimeError(f"S1 owned {kind} cleanup remains incomplete for {identity}"))
        except (OSError, RuntimeError, subprocess.SubprocessError, BaseExceptionGroup) as error:
            errors.append(error)
    if errors:
        raise BaseExceptionGroup("S1 Docker cleanup failed", errors)


@contextmanager
def fixture_owner(env, docker):
    # Unix socket paths are bounded. This short root is independent of both
    # the checkout path and the supervised worker's disposable TMPDIR.
    root = Path(tempfile.mkdtemp(prefix="atlas-s1-", dir="/tmp"))
    owner = FixtureOwner(root, root / "ownership.jsonl", root / "fixtures")
    owner.fixtures.mkdir(mode=0o700)
    owner.manifest.touch(mode=0o600)
    try:
        yield owner
    finally:
        primary = sys.exception()
        errors = []
        try:
            identities = _installations(owner.manifest)
            for identity in sorted(identities):
                try:
                    _remove_installation(identity, env, docker)
                except (OSError, RuntimeError, subprocess.SubprocessError, BaseExceptionGroup) as error:
                    errors.append(error)
        except (OSError, ValueError, RuntimeError) as error:
            errors.append(error)
        if not errors:
            try:
                shutil.rmtree(root)
            except OSError as error:
                errors.append(error)
        if errors:
            errors.append(RuntimeError(f"S1 cleanup incomplete; retained owner files at {root}"))
            raise BaseExceptionGroup("S1 workflow and cleanup failures", [primary, *errors] if primary else errors)


def build_s1(go, env, artifacts):
    core = ROOT / "Atlas Core"
    context = artifacts / "s1-image"
    context.mkdir(exist_ok=True)
    for command in ("atlas", "atlas-manager"):
        run([go, "build", "-o", artifacts / command, f"./cmd/{command}"], env, cwd=core)
    run(
        [go, "build", "-o", context / "atlas-core", "./cmd/atlas-core"],
        {**env, "CGO_ENABLED": "0"},
        cwd=core,
    )
    docker = ["docker"] if os.access("/var/run/docker.sock", os.R_OK | os.W_OK) else ["sudo", "-n", "docker"]
    image = "atlas-core:s1"
    run([*docker, "build", "--network=none", "-f", ROOT / "deployment/Dockerfile", "-t", image, context], env)
    evidence = {
        "docker_version": run([*docker, "version", "--format", "{{.Server.Version}}"], env, capture=True),
        "image_id": run([*docker, "image", "inspect", "--format", "{{.Id}}", image], env, capture=True),
        "binary_sha256": {
            name: hashlib.sha256(path.read_bytes()).hexdigest()
            for name, path in {
                "atlas": artifacts / "atlas",
                "atlas-manager": artifacts / "atlas-manager",
                "atlas-core": context / "atlas-core",
            }.items()
        },
    }
    return image, docker, evidence


def _host_arguments(go, artifacts, image, docker, owner):
    arguments = [
        go,
        "test",
        "-race",
        "-count=1",
        "-tags",
        "atlas_host_integration",
        "./hostmanagement",
        "-v",
        "-atlas-host-image",
        image,
        "-atlas-s1-driver",
        ROOT / "tests/s1/workflow.ts",
        "-atlas-s1-cli",
        artifacts / "atlas",
        "-atlas-host-ownership-manifest",
        owner.manifest,
        "-atlas-host-fixture-root",
        owner.fixtures,
    ]
    if docker[0] == "sudo":
        arguments.append("-atlas-host-sudo-docker")
    return arguments


def check_host_workflows(go, env, artifacts, image, docker):
    with fixture_owner(env, docker) as owner:
        run(_host_arguments(go, artifacts, image, docker, owner), env, cwd=ROOT / "Atlas Core", timeout=600)


def _readiness_schedule(owner, schedule):
    marker = owner.root / "ready.json"

    def ready(process, _temporary_root):
        deadline = time.monotonic() + 60
        while not marker.exists():
            if process.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("S1 lifetime probe did not observe real Core readiness")
            time.sleep(0.05)
        value = json.loads(marker.read_text())
        if value["installation_id"] not in _installations(owner.manifest):
            raise RuntimeError("S1 readiness marker is outside the owner's installations")
        pid = value["worker_pid"]
        if not isinstance(pid, int) or pid <= 0:
            raise RuntimeError("S1 readiness marker has no worker identity")
        if schedule == "worker_death":
            # The test process publishes this private barrier and cannot
            # finish or release its identity before the owner acts.
            os.kill(pid, signal.SIGKILL)
        elif schedule == "interruption":
            os.kill(os.getpid(), signal.SIGINT)

    return ready


def check_host_fixture_lifetime(go, env, artifacts, image, docker):
    for schedule in ("worker_death", "deadline", "interruption"):
        with fixture_owner(env, docker) as owner:
            marker = owner.root / "ready.json"
            arguments = [
                *_host_arguments(go, artifacts, image, docker, owner),
                "-run",
                "^TestRealLifecyclePreservesSetupAndCompletedResetHasNoEffects$",
                "-atlas-host-readiness-barrier",
                marker,
            ]

            expected = {
                "worker_death": subprocess.CalledProcessError,
                "deadline": subprocess.TimeoutExpired,
                "interruption": InterruptedError,
            }[schedule]
            try:
                supervised_run(
                    arguments,
                    env,
                    cwd=ROOT / "Atlas Core",
                    timeout=20 if schedule == "deadline" else 90,
                    on_started=_readiness_schedule(owner, schedule),
                )
            except expected:
                pass
            else:
                raise RuntimeError(f"S1 lifetime schedule {schedule} did not fail as scheduled")
        if owner.root.exists():
            raise RuntimeError("S1 lifetime cleanup retained files after claiming success")
        print(f"PASS S1 {schedule}: real serving container stopped/removed before owned storage", flush=True)


def check_offline_workflow(env, artifacts, image, docker):
    # This non-test program creates its own installation, disables external
    # connectivity and uses the production CLI and SDK. Missing privileges fail.
    with fixture_owner(env, docker) as owner:
        run(
            [
                "python3",
                ROOT / "examples/s1/offline-demo.py",
                "--artifacts",
                artifacts,
                "--image",
                image,
                "--ownership-manifest",
                owner.manifest,
                "--fixture-root",
                owner.fixtures,
            ],
            env,
            timeout=600,
        )
