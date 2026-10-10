#!/usr/bin/env python3
"""Run the production S1 workflow with Core and SDK restricted to loopback."""

import argparse
import errno
import fcntl
import json
import os
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

OUTPUT_BOUND = 1048576


class InterruptedDemo(RuntimeError):
    def __init__(self, number: int):
        super().__init__(f"offline demonstration interrupted by {signal.Signals(number).name}")


@contextmanager
def defer_launch_interruptions():
    # A forked child can exist before Popen returns its ownership handle.
    previous = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    pending = None

    def defer(number, _frame):
        nonlocal pending
        if pending is None:
            pending = number

    try:
        for number in previous:
            signal.signal(number, defer)
        yield
    finally:
        primary = sys.exception()
        errors: list[BaseException] = []
        for number, handler in previous.items():
            try:
                signal.signal(number, handler)
            except (OSError, ValueError) as error:
                errors.append(error)
        if pending is not None:
            handler = previous[pending]
            if callable(handler):
                try:
                    handler(pending, None)
                except (RuntimeError, KeyboardInterrupt) as error:
                    errors.append(error)
            elif handler != signal.SIG_IGN:
                errors.append(InterruptedDemo(pending))
        if errors:
            raise BaseExceptionGroup(
                "launch interruption or signal restoration failed", [primary, *errors] if primary else errors
            )


def terminate(process: subprocess.Popen[bytes]) -> None:
    # The direct parent may already be dead while its ordinary command group
    # still contains writers or a child retaining the captured output pipe.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait(timeout=5)
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


def command(arguments: list[str], timeout: float = 60) -> str:
    """Keep finite command output bounded, including children retaining a pipe."""
    process = None
    try:
        with defer_launch_interruptions():
            process = subprocess.Popen(
                arguments,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        assert process.stdout is not None
        output = bytearray()
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"{Path(arguments[0]).name} exceeded its deadline")
                for key, _ in selector.select(timeout=0.25):
                    data = os.read(key.fd, 8192)
                    if not data:
                        selector.unregister(key.fileobj)
                    elif len(output) + len(data) > OUTPUT_BOUND:
                        raise RuntimeError("command output exceeded its bound")
                    else:
                        output.extend(data)
            result = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        if result != 0:
            raise RuntimeError(f"{Path(arguments[0]).name} failed with exit status {result}")
        return output.decode("utf-8")
    finally:
        primary = sys.exception()
        errors: list[BaseException] = []
        if process is not None:
            try:
                terminate(process)
            except (OSError, subprocess.SubprocessError) as error:
                errors.append(error)
            if process.stdout is not None:
                try:
                    process.stdout.close()
                except OSError as error:
                    errors.append(error)
        if errors:
            raise BaseExceptionGroup("command and descendant cleanup failed", [primary, *errors] if primary else errors)


def retain_ownership(path: Path, installation_id: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "ab") as journal:
        fcntl.flock(journal, fcntl.LOCK_EX | fcntl.LOCK_NB)
        facts = os.fstat(journal.fileno())
        if not stat.S_ISREG(facts.st_mode) or facts.st_mode & 0o077 or facts.st_uid != os.getuid():
            raise RuntimeError("ownership manifest must be an owner-only regular file")
        encoded = (json.dumps({"installation_id": installation_id}) + "\n").encode()
        if facts.st_size + len(encoded) > OUTPUT_BOUND:
            raise RuntimeError("ownership manifest exceeds its bound")
        journal.write(encoded)
        journal.flush()
        os.fsync(journal.fileno())
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def last_json(output: str) -> dict[str, object]:
    lines = output.strip().splitlines()
    if not lines:
        raise RuntimeError("command returned no structured result")
    value = json.loads(lines[-1])
    if not isinstance(value, dict):
        raise TypeError("command result must be an object")
    return value


def report(step: str, result: dict[str, object]) -> None:
    print(json.dumps({"step": step, **result}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--artifacts", type=Path)
    parser.add_argument("--image", default="atlas-core:s1")
    parser.add_argument("--docker", default="docker")
    parser.add_argument("--node", default="node")
    parser.add_argument("--ownership-manifest", type=Path)
    parser.add_argument("--fixture-root", type=Path)
    arguments = parser.parse_args()
    if bool(arguments.ownership_manifest) != bool(arguments.fixture_root):
        parser.error("ownership-manifest and fixture-root must be supplied together")
    if arguments.fixture_root and (
        not arguments.fixture_root.is_absolute() or not arguments.ownership_manifest.is_absolute()
    ):
        parser.error("the surviving owner's fixture root and manifest must be absolute paths")
    repository = arguments.repo.resolve()
    artifacts = (arguments.artifacts or repository / ".artifacts").resolve()
    atlas = artifacts / "atlas"
    manager = artifacts / "atlas-manager"
    loader = repository / "Atlas SDK/node_modules/tsx/dist/loader.mjs"
    driver = repository / "examples/s1/demo.ts"
    for path in (atlas, manager, loader, driver):
        if not path.is_file():
            raise RuntimeError(f"required local artifact is missing: {path}")
    node = shutil.which(arguments.node)
    if node is None:
        raise RuntimeError("the configured Node executable is unavailable")
    uid, gid = os.getuid(), os.getgid()
    isolated = [
        "sudo",
        "-n",
        "unshare",
        "--net",
        "--setgid",
        str(gid),
        "--setuid",
        str(uid),
    ]
    docker = ["sudo", "-n", arguments.docker]
    installation_id = str(uuid.uuid4())
    base = Path(tempfile.mkdtemp(prefix="atlas-offline-", dir=arguments.fixture_root))
    manager_process = None
    failures: list[BaseException] = []
    previous_signals = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    closing = False
    received_signal = None

    def interrupt(number, _frame):
        nonlocal received_signal
        if received_signal is None:
            received_signal = number
            if not closing:
                raise InterruptedDemo(number)

    try:
        for number in previous_signals:
            signal.signal(number, interrupt)
        retain_ownership(arguments.ownership_manifest or base / "ownership.jsonl", installation_id)
        # This is a capability check, not a skipped qualification when unavailable.
        command([*isolated, "true"], timeout=10)
        command([*docker, "image", "inspect", arguments.image], timeout=10)
        operator = base / "operator"
        runtime = base / "runtime"
        socket = runtime / "manager.sock"
        command(
            [
                *isolated,
                str(atlas),
                "prepare",
                "--output-dir",
                str(operator),
                "--server-names",
                "127.0.0.1",
            ]
        )
        config = base / "manager.json"
        command(
            [
                *isolated,
                str(atlas),
                "manager-config",
                "--installation-id",
                installation_id,
                "--image",
                arguments.image,
                "--root",
                str(base / "installation"),
                "--recovery-root",
                str(base / "recovery"),
                "--runtime-root",
                str(runtime),
                "--sudo-docker",
                "--docker",
                arguments.docker,
                "--output",
                str(config),
            ]
        )
        with defer_launch_interruptions():
            manager_process = subprocess.Popen(
                [*isolated, str(manager), "--config", str(config)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        deadline = time.monotonic() + 10
        while not socket.exists():
            if manager_process.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("the installation manager did not become available")
            time.sleep(0.05)

        def cli(action: str, *options: str) -> dict[str, object]:
            result = last_json(
                command(
                    [*isolated, str(atlas), action, "--socket", str(socket), *options],
                    timeout=90,
                )
            )
            if action in ("setup", "start", "stop") and result.get("status") != "completed":
                raise RuntimeError(f"local {action} did not complete")
            return result

        setup = cli("setup", "--input", str(operator / "setup.json"))
        report("setup", {"status": setup["status"], "installation_id": installation_id})
        ca = operator / "ca.crt"
        cli("export-ca", "--output", str(ca))
        started = cli("start")
        if started.get("ready") is not True:
            raise RuntimeError("Core did not establish real public readiness")
        report("start", {"ready": True, "dataset_id": started["dataset_id"]})
        containers = command(
            [
                *docker,
                "ps",
                "--quiet",
                "--filter",
                f"label=atlas.installation_id={installation_id}",
                "--filter",
                "label=com.docker.compose.service=core",
            ]
        ).split()
        if len(containers) != 1:
            raise RuntimeError("the installation must own exactly one serving Core")
        container = containers[0]
        inspected = json.loads(command([*docker, "inspect", container]))[0]
        pid = inspected["State"]["Pid"]
        if not isinstance(pid, int) or pid <= 0:
            raise RuntimeError("Core has no independently observed running process")
        for network in inspected["NetworkSettings"]["Networks"]:
            command([*docker, "network", "disconnect", network, container])
        inside_core = [
            "sudo",
            "-n",
            "nsenter",
            "--target",
            str(pid),
            "--net",
            "--setgid",
            str(gid),
            "--setuid",
            str(uid),
        ]
        # Both programs share Core's actual namespace. No DNS, proxy, firewall
        # assumptions or mocked network transport can manufacture this proof.
        probe = (
            "import errno,json,socket; "
            "interfaces=sorted(name for _,name in socket.if_nameindex()); "
            "s=socket.socket(); s.settimeout(3); "
            "result=s.connect_ex(('1.1.1.1',443)); s.close(); "
            "assert interfaces==['lo'], interfaces; "
            "assert result==errno.ENETUNREACH, result; "
            "print(json.dumps({'interfaces':interfaces,'external_errno':result}))"
        )
        proof = last_json(command([*inside_core, "python3", "-c", probe], timeout=10))
        if proof.get("external_errno") != errno.ENETUNREACH:
            raise RuntimeError("external connectivity was not disabled")
        report("offline_namespace", proof)
        state = base / "asset-retention"
        state.mkdir(mode=0o700)
        driver_config = base / "driver.json"
        driver_config.write_text(
            json.dumps(
                {
                    "baseUrl": "https://127.0.0.1:8443",
                    "caPath": str(ca),
                    "adminKeyPath": str(operator / "admin.key"),
                    "installationId": installation_id,
                    "managerSocket": str(socket),
                    "atlasCli": str(atlas),
                    "stateDirectory": str(state),
                }
            )
        )
        driver_config.chmod(0o600)
        result = last_json(
            command(
                [
                    *inside_core,
                    node,
                    "--import",
                    str(loader),
                    str(driver),
                    "--config",
                    str(driver_config),
                ],
                timeout=300,
            )
        )
        if result.get("outcome") != "completed" or result.get("executionCount") != 1:
            raise RuntimeError("the actual SDK demonstration did not complete")
        report("sdk_workflow", result)
        if manager_process.poll() is not None:
            raise RuntimeError("the manager did not survive the independent CLI processes")
        stopped = cli("stop")
        report("stop", {"status": stopped["status"], "ready": stopped["ready"]})
    except (
        OSError,
        RuntimeError,
        ValueError,
        TypeError,
        KeyError,
        subprocess.SubprocessError,
        BaseExceptionGroup,
    ) as error:
        failures.append(error)
    finally:
        primary = sys.exception()
        closing = True
        if primary is not None:
            failures.append(primary)
        stopped = True
        if manager_process is not None:
            try:
                terminate(manager_process)
            except (OSError, subprocess.SubprocessError) as error:
                failures.append(error)
                stopped = False
        # The daemon outlives the namespace and this runner. Remove only the
        # exact installation's labeled resources even if the SDK process dies.
        for kind in ("container", "network"):
            try:
                listing = ["ps", "--all", "--quiet"] if kind == "container" else ["network", "ls", "--quiet"]
                owned = command(
                    [
                        *docker,
                        *listing,
                        "--filter",
                        f"label=atlas.installation_id={installation_id}",
                    ]
                ).split()
                for identifier in owned:
                    remove = ["rm", "--force", identifier] if kind == "container" else ["network", "rm", identifier]
                    command([*docker, *remove], timeout=30)
            except (OSError, RuntimeError, subprocess.SubprocessError, BaseExceptionGroup) as error:
                failures.append(error)
                stopped = False
        if stopped and arguments.fixture_root is None:
            try:
                shutil.rmtree(base)
            except OSError as error:
                failures.append(error)
        if not stopped:
            failures.append(RuntimeError(f"owned shutdown is incomplete; retained mounted files at {base}"))
        for number, handler in previous_signals.items():
            try:
                signal.signal(number, handler)
            except (OSError, ValueError) as error:
                failures.append(error)
        if received_signal is not None and not any(isinstance(error, InterruptedDemo) for error in failures):
            failures.append(InterruptedDemo(received_signal))
        if failures:
            raise BaseExceptionGroup("offline demonstration or owned cleanup failed", failures)


if __name__ == "__main__":
    main()
