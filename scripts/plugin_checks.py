"""Exercise surviving cleanup ownership with real Core and Plugin workers."""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from go_test_supervisor import _reap_group, _signal_group, _stop, _subreaper, supervised_run
from toolchain import ROOT, run


def _plugin_pid(worker, root):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            status = Path(f"/proc/{worker}/stat").read_text().rsplit(")", 1)[1].split()[0]
        except FileNotFoundError:
            raise RuntimeError("Go cleanup probe worker exited before Plugin launch") from None
        if status == "Z":
            raise RuntimeError("Go cleanup probe worker exited before Plugin launch")
        for entry in Path("/proc").iterdir():
            if not entry.name.isdecimal():
                continue
            try:
                executable = (entry / "exe").readlink()
                if (
                    executable.name == "plugin"
                    and executable.is_relative_to(root)
                    and os.getpgid(int(entry.name)) == worker
                ):
                    return int(entry.name)
            except (OSError, ValueError):
                continue
        time.sleep(0.01)
    raise RuntimeError("cleanup probe did not observe the real Plugin process")


def _assert_absent(pid, root):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        pass
    else:
        raise RuntimeError(f"fixture PID {pid} remains running or unreaped")
    if root.exists():
        raise RuntimeError(f"fixture root was not removed: {root}")


def _worker_probe(command, env, core, deadline):
    observed = {}

    def schedule(process, root):
        observed.update(root=root, plugin=_plugin_pid(process.pid, root))
        process.send_signal(signal.SIGSTOP if deadline else signal.SIGKILL)

    expected = subprocess.TimeoutExpired if deadline else subprocess.CalledProcessError
    try:
        supervised_run(command, env, cwd=core, timeout=2 if deadline else 60, on_started=schedule)
    except expected:
        pass
    else:
        raise RuntimeError("cleanup probe unexpectedly completed successfully")
    _assert_absent(observed["plugin"], observed["root"])
    print(f"PASS real Plugin cleanup after {'command deadline' if deadline else 'hard Go worker death'}", flush=True)


def _signal_probe(command, env, core, number):
    evidence = Path(tempfile.mkdtemp(prefix="atlas-plugin-owner-probe-"))
    manifest = evidence / "owner.json"
    previous_subreaper = _subreaper()
    _subreaper(1)
    previous_signals = {value: signal.getsignal(value) for value in (signal.SIGINT, signal.SIGTERM)}
    closing = False

    def interrupt(value, _frame):
        if not closing:
            raise InterruptedError(value, "Plugin cleanup observer interrupted")

    owner = None
    state = None
    primary = None
    errors = []
    try:
        for value in previous_signals:
            signal.signal(value, interrupt)
        owner = subprocess.Popen(
            [sys.executable, ROOT / "scripts/go_test_supervisor.py", "--manifest", manifest, "--", *command],
            cwd=core,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                state = json.loads(manifest.read_text())
                break
            except (OSError, ValueError):
                time.sleep(0.01)
        if state is None:
            raise RuntimeError("surviving Go owner did not record its worker")
        root = Path(state["root"])
        plugin = _plugin_pid(state["worker_pid"], root)
        owner.send_signal(number)
        _, diagnostic = owner.communicate(timeout=10)
        if owner.returncode != 128 + number:
            raise RuntimeError(f"owner interruption returned {owner.returncode}: {diagnostic}")
        _assert_absent(plugin, root)
        _assert_absent(state["worker_pid"], root)
    except BaseException as error:
        primary = error
    finally:
        closing = True
        if owner is not None:
            try:
                _stop(owner)
                if state is not None:
                    _signal_group(state["worker_pid"], signal.SIGKILL)
                    _reap_group(state["worker_pid"])
                    if Path(state["root"]).exists():
                        shutil.rmtree(state["root"])
            except BaseException as error:
                errors.append(error)
        if not errors:
            try:
                shutil.rmtree(evidence)
            except OSError as error:
                errors.append(error)
        for value, handler in previous_signals.items():
            signal.signal(value, handler)
        _subreaper(previous_subreaper)
    if errors:
        raise BaseExceptionGroup(
            "Plugin interruption and observer cleanup errors", [primary, *errors] if primary else errors
        )
    if primary is not None:
        raise primary
    print(f"PASS real Plugin cleanup after owner {signal.Signals(number).name}", flush=True)


def check_plugin_fixture_lifetime(go, env):
    core = ROOT / "Atlas Core"
    package = core / "plugins"
    binary = ROOT / ".artifacts/plugin-bookkeeping-tests"
    run([go, "test", "-c", "-o", binary, "./plugins"], env, cwd=core)
    command = [
        str(binary),
        "-test.run=^TestLargeAcknowledgedReceiptInventoryReconnectsInBoundedPages$",
        "-test.count=1",
    ]
    _worker_probe(command, env, package, False)
    _worker_probe(command, env, package, True)
    for number in (signal.SIGINT, signal.SIGTERM):
        _signal_probe(command, env, package, number)
