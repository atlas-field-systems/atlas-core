"""Exercise actual verifier deadlines and cancellation with serving fixtures."""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from command_supervisor import _owned_processes, _processes, _stop, _subreaper, supervised_run
from toolchain import ROOT, run


def _require_gone(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    raise RuntimeError(f"Verification fixture process {pid} remains running or unreaped")


def _wait_ready(owner, marker):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            state = json.loads(marker.read_text())
        except FileNotFoundError:
            if owner.poll() is not None:
                raise RuntimeError("Verifier exited before the real HTTP/SQLite fixture was serving") from None
            time.sleep(0.02)
            continue
        if state["journalMode"] != "wal" or not Path(state["dataDir"], "fixture.sqlite").is_file():
            raise RuntimeError("Verifier probe did not establish its real SQLite WAL boundary")
        return state
    raise RuntimeError("Verifier probe did not reach HTTP readiness within its bound")


def _verifier_probe(number):
    previous_subreaper = _subreaper()
    _subreaper(1)
    evidence = Path(tempfile.mkdtemp(prefix="atlas-verifier-observer-"))
    owner = None
    previous_children = {pid for pid, facts in _processes().items() if facts[0] == os.getpid()}
    owned = {}
    cleanup_errors = []
    try:
        marker = evidence / "ready.json"
        owner = subprocess.Popen(
            [
                sys.executable,
                ROOT / "scripts/verify.py",
                "--command-lifetime-probe",
                marker,
                "--probe-timeout",
                "5" if number is None else "30",
            ],
            cwd=ROOT,
            env={**os.environ, "TMPDIR": str(evidence)},
            start_new_session=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        _owned_processes(owner, owned, previous_children)
        state = _wait_ready(owner, marker)
        if number is not None:
            owner.send_signal(number)
        started = time.monotonic()
        output, diagnostic = owner.communicate(timeout=15)
        if owner.returncode == 0:
            raise RuntimeError("Verifier incorrectly passed after its deadline or interruption")
        expected = "TimeoutExpired" if number is None else "InterruptedError"
        if expected not in diagnostic:
            raise RuntimeError(f"Verifier lost its {expected} failure: {output}\n{diagnostic}")
        for pid in (state["pid"], state["workerPid"]):
            _require_gone(pid)
        private_root = Path(state["dataDir"]).parents[1]
        if private_root.exists():
            raise RuntimeError(f"Verifier retained stopped fixture storage: {private_root}")
        action = "deadline" if number is None else signal.Signals(number).name
        print(f"PASS actual verifier {action}: serving Go/SQLite fixture stopped/reaped, storage removed", flush=True)
        if time.monotonic() - started >= 15:
            raise RuntimeError("Verifier shutdown exceeded its qualification bound")
    finally:
        primary = sys.exception()
        stopped = owner is None
        if owner is not None:
            try:
                _stop(owner, owned, previous_children)
            except (OSError, RuntimeError, subprocess.SubprocessError, ExceptionGroup) as error:
                cleanup_errors.append(error)
            try:
                stopped = not _owned_processes(owner, owned, previous_children)
            except OSError as error:
                cleanup_errors.append(error)
                stopped = False
        if stopped:
            try:
                shutil.rmtree(evidence)
            except OSError as error:
                cleanup_errors.append(error)
        else:
            cleanup_errors.append(RuntimeError(f"Verifier observer shutdown incomplete; retained {evidence}"))
        try:
            _subreaper(previous_subreaper)
        except OSError as error:
            cleanup_errors.append(error)
        if cleanup_errors:
            raise BaseExceptionGroup(
                "Verifier probe and cleanup failures", [primary, *cleanup_errors] if primary else cleanup_errors
            )


def _stop_detached(pid):
    # Independent containment: this probe must not trust the descendant tracking
    # it is trying to break. The marker identifies its actual adopted child.
    errors = []
    for number, grace in ((signal.SIGTERM, 0.5), (signal.SIGKILL, 3)):
        try:
            os.kill(pid, number)
        except ProcessLookupError:
            pass
        except OSError as error:
            errors.append(error)
        deadline = time.monotonic() + grace
        while True:
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                if errors:
                    raise ExceptionGroup("Detached probe signalling failed", errors)
                return
            if time.monotonic() >= deadline:
                break
            time.sleep(0.02)
    raise ExceptionGroup("Detached probe shutdown incomplete", [*errors, RuntimeError(f"Retained writer {pid}")])


def _detached_probe(exited=False):
    # This process starts a new session and outlives its parent. Process-group
    # signalling alone cannot own it; the real subreaper must adopt and reap it.
    previous_subreaper = _subreaper()
    _subreaper(1)
    evidence = Path(tempfile.mkdtemp(prefix="atlas-detached-observer-"))
    marker = evidence / "ready.json"
    state = None
    cleanup_errors = []
    try:
        child = (
            "print('ready',flush=True)"
            if exited
            else "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(60)"
        )
        parent = """
import json,os,subprocess,sys,time
from pathlib import Path
child = subprocess.Popen([sys.executable,'-c',sys.argv[2]], start_new_session=True,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
if child.stdout.readline().strip() != 'ready':
    raise RuntimeError('Actual descendant did not become ready')
if sys.argv[3] == 'exited':
    deadline = time.monotonic() + 3
    while Path(f'/proc/{child.pid}/stat').read_text().rsplit(')',1)[1].split()[0] != 'Z':
        if time.monotonic() >= deadline:
            raise RuntimeError('Actual descendant did not exit within the bound')
        time.sleep(0.01)
Path(sys.argv[1]).write_text(json.dumps({'pid':child.pid,'root':os.environ['TMPDIR']}))
print('completed parent',flush=True)
os._exit(0)
"""
        try:
            output = run(
                [sys.executable, "-c", parent, marker, child, "exited" if exited else "live"],
                os.environ,
                timeout=10,
                capture=True,
            )
        except RuntimeError as error:
            if exited or "left running or unreaped descendants" not in str(error):
                raise
        else:
            if not exited:
                raise RuntimeError("Verification passed despite an escaped running descendant")
            if output != "completed parent":
                raise RuntimeError("Completed-child probe did not execute its actual parent")
        state = json.loads(marker.read_text())
        _require_gone(state["pid"])
        if Path(state["root"]).exists():
            raise RuntimeError("Detached writer's command storage was not removed")
    finally:
        primary = sys.exception()
        try:
            if state is None and marker.exists():
                state = json.loads(marker.read_text())
            if state is not None:
                _stop_detached(state["pid"])
                _require_gone(state["pid"])
                root = Path(state["root"])
                if root.exists():
                    shutil.rmtree(root)
            shutil.rmtree(evidence)
        except (OSError, RuntimeError, ValueError, ExceptionGroup) as error:
            cleanup_errors.append(error)
        try:
            _subreaper(previous_subreaper)
        except OSError as error:
            cleanup_errors.append(error)
        if cleanup_errors:
            raise BaseExceptionGroup(
                "Detached probe and cleanup failures", [primary, *cleanup_errors] if primary else cleanup_errors
            )
    if exited:
        print("PASS exited adopted descendant: successful command reaps it before storage cleanup", flush=True)
    else:
        print(
            "PASS detached descendant: failed command, hard termination/reaping and private storage cleanup", flush=True
        )


def _process_churn_probe():
    # Exiting real processes can disappear between /proc listing and stat reads.
    source = """
import subprocess,time
deadline = time.monotonic() + 3
while time.monotonic() < deadline:
    children = [subprocess.Popen(['/bin/true']) for _ in range(12)]
    for child in children:
        child.wait()
"""

    def observe(process, _root):
        deadline = time.monotonic() + 5
        while process.poll() is None:
            _processes()
            if time.monotonic() >= deadline:
                raise RuntimeError("Real process-churn prerequisite exceeded its bound")

    supervised_run([sys.executable, "-c", source], os.environ, cwd=ROOT, timeout=10, on_started=observe)
    print("PASS process snapshots tolerate concurrent real process exit", flush=True)


def _cleanup_failure_probe():
    primary = RuntimeError("independent original verification failure")
    observed = {}
    previous_signals = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    previous_subreaper = _subreaper()

    def fail(process, root):
        observed.update(pid=process.pid, root=root)
        (root / "retained.txt").write_text("actual nonempty-directory cleanup refusal")
        raise primary

    try:
        # Only the removal operation changes: rmdir really rejects the nonempty
        # owned directory, while command launch, shutdown and reaping stay real.
        with patch("command_supervisor.shutil.rmtree", os.rmdir):
            try:
                supervised_run(
                    [sys.executable, "-c", "import time; time.sleep(60)"], os.environ, cwd=ROOT, on_started=fail
                )
            except BaseExceptionGroup as error:
                if error.exceptions[0] is not primary or not any(
                    isinstance(item, OSError) for item in error.exceptions
                ):
                    raise RuntimeError("Verification cleanup hid the original or real removal failure") from error
            else:
                raise RuntimeError("Verification cleanup refusal incorrectly passed")
        _require_gone(observed["pid"])
        if not observed["root"].exists():
            raise RuntimeError("Failed storage removal was incorrectly reported complete")
        if _subreaper() != previous_subreaper or any(
            signal.getsignal(number) != handler for number, handler in previous_signals.items()
        ):
            raise RuntimeError("A removal error skipped independent signal/subreaper restoration")
    finally:
        if observed:
            _require_gone(observed["pid"])
            shutil.rmtree(observed["root"])
    print("PASS primary and real cleanup failures remain visible; independent owner restoration completes", flush=True)


def check_command_lifetime():
    for number in (None, signal.SIGINT, signal.SIGTERM):
        _verifier_probe(number)
    _detached_probe(exited=True)
    _detached_probe()
    _cleanup_failure_probe()
    _process_churn_probe()


if __name__ == "__main__":
    check_command_lifetime()
