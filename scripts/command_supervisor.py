"""Own verification commands, their descendants and private temporary storage."""

import argparse
import ctypes
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
from contextlib import contextmanager
from pathlib import Path

TERM_GRACE_SECONDS = 5
KILL_GRACE_SECONDS = 3


class _Interruption(BaseException):
    # selectors retries InterruptedError while reading subprocess pipes. Keep
    # cancellation distinct until it has escaped that I/O boundary.
    def __init__(self, number):
        self.number = number
        super().__init__(number)


def _cleanup_failure(primary, pending_signal, errors, message):
    if pending_signal is not None and not isinstance(primary, InterruptedError):
        interruption = InterruptedError(pending_signal, "Verification interrupted")
        interruption.__cause__ = primary
        primary = interruption
    if errors:
        return BaseExceptionGroup(message, [primary, *errors] if primary is not None else errors)
    return primary if pending_signal is not None else None


def _restore_process_state(previous_signals, previous_subreaper, errors):
    # Restoring one handler must not expose its old cancellation behavior before
    # the remaining handlers and subreaper state are restored. Linux queues the
    # signals for this short step; leave already-blocked caller signals alone.
    numbers = set(previous_signals)
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, numbers)
    pending = None
    try:
        try:
            _subreaper(previous_subreaper)
        except OSError as error:
            errors.append(error)
        for number, handler in previous_signals.items():
            try:
                signal.signal(number, handler)
            except (OSError, ValueError) as error:
                errors.append(error)
        delivered = numbers - previous_mask
        while delivered:
            received = signal.sigtimedwait(delivered, 0)
            if received is None:
                break
            delivered.discard(received.si_signo)
            if pending is None:
                pending = received.si_signo
    except OSError as error:
        errors.append(error)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    return pending


@contextmanager
def _defer_interruptions():
    # A child can already exist before Popen returns its handle. Record signals
    # through that ownership handoff without blocking signals in the child.
    previous = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    pending = None

    def interrupt(number, _frame):
        nonlocal pending
        if pending is None:
            pending = number

    errors = []
    try:
        for number in previous:
            signal.signal(number, interrupt)
        yield
    finally:
        primary = sys.exception()
        for number, handler in previous.items():
            try:
                signal.signal(number, handler)
            except (OSError, ValueError) as error:
                errors.append(error)
        if errors:
            raise BaseExceptionGroup(
                "Launch and signal restoration failures", [primary, *errors] if primary is not None else errors
            )
    if pending is not None:
        raise InterruptedError(pending, "Verification interrupted")


def _subreaper(enabled=None):
    # Linux's subreaper adopts orphaned grandchildren, letting this surviving
    # owner wait for descendants even when their immediate parent is killed.
    if sys.platform != "linux":
        raise RuntimeError("Verification command supervision requires Linux")
    libc = ctypes.CDLL(None, use_errno=True)
    state = ctypes.c_int()
    operation, value = (37, ctypes.byref(state)) if enabled is None else (36, ctypes.c_ulong(enabled))
    if libc.prctl(ctypes.c_int(operation), value, ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return state.value


def _processes():
    result = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
        except (FileNotFoundError, ProcessLookupError):
            continue
        # Birth time distinguishes known children from later PID reuse.
        result[int(entry.name)] = (int(fields[1]), int(fields[2]), fields[19])
    return result


def _owned_processes(process, owned, previous_children):
    snapshot = _processes()
    changed = True
    while changed:
        changed = False
        for pid, (parent, group, birth) in snapshot.items():
            if pid in owned:
                continue
            if (
                pid == process.pid
                or parent in owned
                or group == process.pid
                or (parent == os.getpid() and pid not in previous_children)
            ):
                owned[pid] = birth
                changed = True
    return {pid: facts for pid, facts in snapshot.items() if owned.get(pid) == facts[2]}


def _reap_adopted(process, remaining):
    errors = []
    for pid, (parent, _group, _birth) in remaining.items():
        if parent == os.getpid() and pid != process.pid:
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass
            except OSError as error:
                errors.append(error)
    return errors


def _stop(process, owned, previous_children):
    errors = []
    for number, grace in ((signal.SIGTERM, TERM_GRACE_SECONDS), (signal.SIGKILL, KILL_GRACE_SECONDS)):
        deadline = time.monotonic() + grace
        signalled = set()
        while True:
            # Popen retains ownership of its direct child; only reap descendants
            # adopted by this Linux subreaper, including detached process groups.
            process.poll()
            remaining = _owned_processes(process, owned, previous_children)
            errors.extend(_reap_adopted(process, remaining))
            remaining = _owned_processes(process, owned, previous_children)
            # Stop direct/adopted owners before their children, including during
            # forced shutdown. Their unreaped child ownership pins the PID; a
            # nested child's parent could instead reap it before our signal.
            targets = {pid: facts for pid, facts in remaining.items() if facts[0] == os.getpid()}
            for pid in targets:
                if pid not in signalled:
                    try:
                        # Prove ownership without reaping. An exited child no
                        # longer needs a signal, and a nonchild is never safe.
                        exited = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                        if exited is None:
                            os.kill(pid, number)
                    except ChildProcessError:
                        continue
                    except ProcessLookupError:
                        pass
                    except OSError as error:
                        errors.append(error)
                    signalled.add(pid)
            if not _owned_processes(process, owned, previous_children):
                process.communicate(timeout=KILL_GRACE_SECONDS)
                if errors:
                    raise ExceptionGroup("Command signalling failed during cleanup", errors)
                return
            if time.monotonic() >= deadline:
                break
            # Drain captured pipes while allowing graceful cleanup to progress;
            # otherwise an owner can block on its own shutdown diagnostics.
            try:
                process.communicate(timeout=min(0.02, max(0, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
            time.sleep(0.02)
    errors.append(RuntimeError(f"Command descendants did not exit and reap: {sorted(remaining)}"))
    raise ExceptionGroup("Command shutdown incomplete", errors)


def supervised_run(arguments, env, *, cwd, capture=False, timeout=180, on_started=None):
    """Run one command with a surviving Linux process and storage owner.

    on_started is the bounded fault-schedule seam used by the executable
    cleanup checks. Ordinary verification does not supply it.
    """
    arguments = list(map(str, arguments))
    print("+ " + " ".join(arguments), flush=True)
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("Command timeout must be positive and finite")
    previous_subreaper = _subreaper()
    previous_children = {pid for pid, facts in _processes().items() if facts[0] == os.getpid()}
    owned = {}
    root = None
    previous_signals = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    closing = False
    pending_signal = None

    def interrupt(number, _frame):
        nonlocal pending_signal
        if closing:
            if pending_signal is None:
                pending_signal = number
        else:
            raise _Interruption(number)

    process = None
    cleanup_errors = []
    output = None
    try:
        _subreaper(1)
        for number in previous_signals:
            signal.signal(number, interrupt)
        with _defer_interruptions():
            root = Path(tempfile.mkdtemp(prefix="atlas-verification-"))
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
            _owned_processes(process, owned, previous_children)
        if on_started is not None:
            on_started(process, root)
        output, errors = process.communicate(timeout=max(0, timeout - (time.monotonic() - started)))
        if process.returncode != 0:
            raise subprocess.CalledProcessError(process.returncode, arguments, output, errors)
        # Orphaned, already-exited helpers are this subreaper's responsibility.
        # Reap without signalling: a still-live descendant must remain a failure.
        reap_errors = _reap_adopted(process, _owned_processes(process, owned, previous_children))
        if reap_errors:
            raise ExceptionGroup("Completed command descendant reaping failed", reap_errors)
        if _owned_processes(process, owned, previous_children):
            raise RuntimeError("Verification command left running or unreaped descendants")
    except _Interruption as error:
        raise InterruptedError(error.number, "Verification interrupted") from None
    finally:
        primary = sys.exception()
        closing = True
        stopped = process is None
        if process is not None:
            try:
                _stop(process, owned, previous_children)
            except (OSError, RuntimeError, subprocess.SubprocessError, ExceptionGroup) as error:
                cleanup_errors.append(error)
            try:
                stopped = not _owned_processes(process, owned, previous_children)
            except OSError as error:
                cleanup_errors.append(error)
                stopped = False
            if stopped:
                try:
                    completed_output, diagnostic = process.communicate(timeout=KILL_GRACE_SECONDS)
                    if isinstance(primary, (subprocess.TimeoutExpired, subprocess.CalledProcessError)):
                        primary.output, primary.stderr = completed_output, diagnostic
                    if capture and (primary is not None or cleanup_errors):
                        print(completed_output or "", end="", flush=True)
                        print(diagnostic or "", end="", file=sys.stderr, flush=True)
                except (OSError, subprocess.SubprocessError) as error:
                    cleanup_errors.append(error)
        if root is not None:
            if stopped:
                try:
                    shutil.rmtree(root)
                except OSError as error:
                    cleanup_errors.append(error)
            else:
                cleanup_errors.append(RuntimeError(f"Command shutdown incomplete; retained {root}"))
        restoration_signal = _restore_process_state(previous_signals, previous_subreaper, cleanup_errors)
        if pending_signal is None:
            pending_signal = restoration_signal
        failure = _cleanup_failure(primary, pending_signal, cleanup_errors, "Verification failure and cleanup errors")
        if failure is not None:
            raise failure
    return output.strip() if capture else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a verification command is required")

    def record(process, root):
        args.manifest.write_text(json.dumps({"worker_pid": process.pid, "root": str(root)}) + "\n")

    try:
        supervised_run(command, os.environ, cwd=Path.cwd(), on_started=record)
    except InterruptedError as error:
        if error.__cause__ is not None:
            print(error.__cause__, file=sys.stderr)
        print(error, file=sys.stderr)
        return 128 + error.errno
    except (OSError, RuntimeError, subprocess.SubprocessError, BaseExceptionGroup) as error:
        if isinstance(error, BaseExceptionGroup):
            traceback.print_exception(error, file=sys.stderr)
        else:
            print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
