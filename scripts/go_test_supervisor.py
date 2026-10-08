"""Own Go test descendants and temporary storage outside the test worker."""

import argparse
import ctypes
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def _subreaper(enabled=None):
    # Linux's subreaper adopts orphaned grandchildren, letting this surviving
    # owner wait for Plugin processes even when their Go test parent is killed.
    if sys.platform != "linux":
        raise RuntimeError("Plugin test supervision requires Linux")
    libc = ctypes.CDLL(None, use_errno=True)
    state = ctypes.c_int()
    operation, value = (37, ctypes.byref(state)) if enabled is None else (36, ctypes.c_ulong(enabled))
    if libc.prctl(ctypes.c_int(operation), value, ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return state.value


def _group_exists(group):
    try:
        os.killpg(group, 0)
    except ProcessLookupError:
        return False
    return True


def _signal_group(group, number):
    try:
        os.killpg(group, number)
    except ProcessLookupError:
        pass


def _reap_group(group):
    deadline = time.monotonic() + 3
    while True:
        while True:
            try:
                pid, _ = os.waitpid(-group, os.WNOHANG)
            except ChildProcessError:
                break
            if pid == 0:
                break
        if not _group_exists(group):
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Go fixture process group {group} did not exit and reap")
        time.sleep(0.01)


def _stop(process):
    _signal_group(process.pid, signal.SIGTERM)
    try:
        process.communicate(timeout=2)
    except subprocess.TimeoutExpired:
        _signal_group(process.pid, signal.SIGKILL)
        process.communicate(timeout=3)
    # The direct child is reaped by Popen, then adopted descendants by waitpid.
    # Never race waitpid against Popen's ownership of the direct child.
    _signal_group(process.pid, signal.SIGKILL)
    _reap_group(process.pid)


def supervised_run(arguments, env, *, cwd, capture=False, timeout=180, on_started=None):
    """Run one Go command with a surviving Linux process and storage owner.

    on_started is the bounded fault-schedule seam used by the executable
    cleanup checks. Ordinary verification does not supply it.
    """
    arguments = list(map(str, arguments))
    print("+ " + " ".join(arguments), flush=True)
    previous_subreaper = _subreaper()
    root = Path(tempfile.mkdtemp(prefix="atlas-go-tests-"))
    previous_signals = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    closing = False

    def interrupt(number, _frame):
        if not closing:
            raise InterruptedError(number, "Go verification interrupted")

    process = None
    cleanup_errors = []
    output = None
    try:
        _subreaper(1)
        for number in previous_signals:
            signal.signal(number, interrupt)
        started = time.monotonic()
        process = subprocess.Popen(
            arguments,
            cwd=cwd,
            env={**env, "TMPDIR": str(root)},
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
            start_new_session=True,
        )
        if on_started is not None:
            on_started(process, root)
        output, errors = process.communicate(timeout=max(0, timeout - (time.monotonic() - started)))
        if process.returncode != 0:
            if capture:
                print(output or "", end="")
                print(errors or "", end="")
            raise subprocess.CalledProcessError(process.returncode, arguments, output, errors)
        if _group_exists(process.pid):
            raise RuntimeError("Go test worker left running or unreaped fixture processes")
    finally:
        primary = sys.exception()
        closing = True
        stopped = process is None
        if process is not None:
            try:
                _stop(process)
                stopped = True
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                cleanup_errors.append(error)
        if stopped:
            try:
                shutil.rmtree(root)
            except OSError as error:
                cleanup_errors.append(error)
        else:
            cleanup_errors.append(RuntimeError(f"Go fixture shutdown incomplete; retained {root}"))
        for number, handler in previous_signals.items():
            try:
                signal.signal(number, handler)
            except (OSError, ValueError) as error:
                cleanup_errors.append(error)
        try:
            _subreaper(previous_subreaper)
        except OSError as error:
            cleanup_errors.append(error)
        if cleanup_errors:
            raise BaseExceptionGroup(
                "Go test failure and fixture cleanup errors", [primary, *cleanup_errors] if primary else cleanup_errors
            )
    return output.strip() if capture else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a Go test command is required")

    def record(process, root):
        args.manifest.write_text(json.dumps({"worker_pid": process.pid, "root": str(root)}) + "\n")

    try:
        supervised_run(command, os.environ, cwd=Path.cwd(), on_started=record)
    except InterruptedError as error:
        print(error, file=sys.stderr)
        return 128 + error.errno
    except (OSError, RuntimeError, subprocess.SubprocessError, BaseExceptionGroup) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
