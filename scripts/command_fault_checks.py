"""Real-process regressions for launch cancellation and cooperative shutdown."""

import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

from command_supervisor import (
    _defer_interruptions,
    _Interruption,
    _owned_processes,
    _processes,
    _subreaper,
    supervised_run,
)
from toolchain import ROOT


@dataclass
class _Fixture:
    evidence: Path
    processes: list[subprocess.Popen[str]] = field(default_factory=list)
    roots: set[Path] = field(default_factory=set)
    pids: set[int] = field(default_factory=set)

    def record(self, process, root):
        self.processes.append(process)
        self.roots.add(Path(root))
        self.pids.add(process.pid)

    def ready(self, process):
        marker = self.evidence / "ready.json"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                state = json.loads(marker.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                if process.poll() is not None:
                    raise RuntimeError("Fault fixture exited before readiness") from None
                time.sleep(0.01)
                continue
            self.pids.update(state["pids"])
            self.roots.add(Path(state["root"]))
            return state
        raise RuntimeError("Fault fixture readiness exceeded its bound")

    def require_stopped(self):
        # These assertions run before the independent safety owner can stop a
        # leaked writer or remove storage on behalf of the supervisor under test.
        for pid in self.pids:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                continue
            raise RuntimeError(f"Fault fixture process {pid} remains running or unreaped")

    def require_clean(self):
        self.require_stopped()
        for root in self.roots:
            if root.exists():
                raise RuntimeError(f"Fault fixture retained private storage: {root}")


def _children():
    # /proc/.../children requires optional CONFIG_PROC_CHILDREN. The supported
    # stat interface already supplies each process's parent on Linux.
    return {pid: facts[2] for pid, facts in _processes().items() if facts[0] == os.getpid()}


@contextmanager
def _fault_fixture():
    previous_subreaper = _subreaper()
    previous_children = _children()
    previous_signals = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    fixture = None
    closing = False
    pending_signal = None

    def interrupt(number, _frame):
        nonlocal pending_signal
        if closing:
            if pending_signal is None:
                pending_signal = number
        else:
            raise _Interruption(number)

    errors = []
    try:
        for number in previous_signals:
            signal.signal(number, interrupt)
        _subreaper(1)
        with _defer_interruptions():
            fixture = _Fixture(Path(tempfile.mkdtemp(prefix="atlas-command-fault-")))
        yield fixture
    except _Interruption as error:
        raise InterruptedError(error.number, "Command fault observer interrupted") from None
    finally:
        primary = sys.exception()
        closing = True
        # Independent containment deliberately does not call the shutdown code
        # under test. Adopted children cover failures before readiness records.
        deadline = time.monotonic() + 3
        remaining = set()
        try:
            while fixture is not None:
                fixture.pids.update(pid for pid, birth in _children().items() if previous_children.get(pid) != birth)
                for pid in fixture.pids:
                    try:
                        # Independently prove that this is still our unreaped
                        # child. Historical fixture PIDs can already be reused.
                        exited = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                        if exited is None:
                            os.kill(pid, signal.SIGKILL)
                    except ChildProcessError:
                        continue
                    except ProcessLookupError:
                        pass
                for process in fixture.processes:
                    process.poll()
                direct = {process.pid for process in fixture.processes}
                for pid in fixture.pids - direct:
                    try:
                        os.waitpid(pid, os.WNOHANG)
                    except ChildProcessError:
                        pass
                remaining = set()
                for pid in fixture.pids:
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        continue
                    remaining.add(pid)
                if not remaining:
                    for root in fixture.roots:
                        if root.exists():
                            shutil.rmtree(root)
                    shutil.rmtree(fixture.evidence)
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"Independent containment retained writers {remaining}; {fixture.evidence}")
                time.sleep(0.01)
        except (OSError, RuntimeError) as error:
            errors.append(error)
        # Keep the safety owner's restoration independent too. A previous
        # handler must not interrupt restoration of the remaining process state.
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, set(previous_signals))
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
            delivered = set(previous_signals) - previous_mask
            while delivered:
                received = signal.sigtimedwait(delivered, 0)
                if received is None:
                    break
                delivered.discard(received.si_signo)
                if pending_signal is None:
                    pending_signal = received.si_signo
        except OSError as error:
            errors.append(error)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        # Reconcile safety-owner failures independently of the code under test.
        if pending_signal is not None and not isinstance(primary, InterruptedError):
            interruption = InterruptedError(pending_signal, "Command fault observer interrupted")
            interruption.__cause__ = primary
            primary = interruption
        if errors:
            raise BaseExceptionGroup(
                "Fault probe and safety cleanup failures", [primary, *errors] if primary else errors
            )
        if pending_signal is not None:
            raise primary


def _writer(fixture):
    actor = fixture.evidence / "writer.py"
    actor.write_text("""
import json,os,signal,sys,time
from pathlib import Path
if len(sys.argv) > 2 and sys.argv[2] == 'detached':
    os.setsid()
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
root = Path(os.environ['TMPDIR'])
with (root / 'writer').open('w') as writer:
    writer.write('actual open writer')
    writer.flush()
    Path(sys.argv[1]).write_text(json.dumps({'pids':[os.getpid()],'root':str(root)}))
    while True: time.sleep(.02)
""")
    return actor


def _launch_cancellation_probe(number):
    with _fault_fixture() as fixture:
        actor = _writer(fixture)
        actual_popen = subprocess.Popen

        def launch(*arguments, **options):
            process = actual_popen(*arguments, **options)
            fixture.record(process, options["env"]["TMPDIR"])
            fixture.ready(process)
            # Schedule cancellation after real launch, before the caller can
            # receive the handle. Popen, the live writer and storage stay real.
            os.kill(os.getpid(), number)
            return process

        previous_signals = {value: signal.getsignal(value) for value in (signal.SIGINT, signal.SIGTERM)}
        previous_subreaper = _subreaper()
        with patch("command_supervisor.subprocess.Popen", launch):
            try:
                supervised_run([sys.executable, actor, fixture.evidence / "ready.json"], os.environ, cwd=ROOT)
            except InterruptedError as error:
                if error.errno != number:
                    raise RuntimeError("Launch cancellation lost its signal") from error
            else:
                raise RuntimeError("Launch cancellation incorrectly succeeded")
        fixture.require_clean()
        if _subreaper() != previous_subreaper or any(
            signal.getsignal(value) != handler for value, handler in previous_signals.items()
        ):
            raise RuntimeError("Launch cancellation did not restore observer process state")
    print(f"PASS launch handoff {signal.Signals(number).name}: real writer stopped/reaped before storage removal")


def _pipe_cancellation_probe(number):
    with _fault_fixture() as fixture:
        actor = _writer(fixture)
        actual_selector = subprocess._PopenSelector
        pending = True

        class SignalPoll:
            def __init__(self, poller):
                self.poller = poller

            def __getattr__(self, name):
                return getattr(self.poller, name)

            def poll(self, timeout):
                nonlocal pending
                if pending:
                    pending = False
                    # Schedule a real signal inside selectors' InterruptedError
                    # retry boundary. All subsequent polling remains real.
                    os.kill(os.getpid(), number)
                return self.poller.poll(timeout)

        def selector():
            instance = actual_selector()
            instance._selector = SignalPoll(instance._selector)
            return instance

        def ready(process, root):
            fixture.record(process, root)
            fixture.ready(process)

        with patch("command_supervisor.subprocess._PopenSelector", selector):
            try:
                supervised_run(
                    [sys.executable, actor, fixture.evidence / "ready.json"],
                    os.environ,
                    cwd=ROOT,
                    timeout=1,
                    capture=True,
                    on_started=ready,
                )
            except InterruptedError as error:
                if error.errno != number:
                    raise RuntimeError("Pipe cancellation lost its signal") from error
            else:
                raise RuntimeError("Pipe cancellation incorrectly succeeded")
        fixture.require_clean()
    print(f"PASS pipe wait {signal.Signals(number).name}: cancellation survives selector retries and cleans storage")


def _cleanup_signal_probe(number, outcome):
    with _fault_fixture() as fixture:
        actor = fixture.evidence / "completed.py"
        actor.write_text("""
import json,os,sys
from pathlib import Path
root = Path(os.environ['TMPDIR'])
(root / 'writer').write_text('actual completed writer')
Path(sys.argv[1]).write_text(json.dumps({'pids':[os.getpid()],'root':str(root)}))
print('COMPLETED_COMMAND_DIAGNOSTIC',file=sys.stderr,flush=True)
sys.exit(int(sys.argv[2]))
""")
        actual_remove = shutil.rmtree
        actual_signal = signal.signal
        previous_signals = {value: signal.getsignal(value) for value in (signal.SIGINT, signal.SIGTERM)}
        previous_subreaper = _subreaper()
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, set())
        restoration_reached = False

        def ready(process, root):
            fixture.record(process, root)
            fixture.ready(process)

        def remove(root, *arguments, **options):
            if Path(root) in fixture.roots and outcome != "restore":
                os.kill(os.getpid(), number)
                # The first cancellation must survive a second signal too.
                other = signal.SIGTERM if number == signal.SIGINT else signal.SIGINT
                os.kill(os.getpid(), other)
                if outcome == "remove":
                    Path(root).rmdir()  # Real ENOTEMPTY, with storage retained.
            return actual_remove(root, *arguments, **options)

        def restore(value, handler):
            nonlocal restoration_reached
            result = actual_signal(value, handler)
            if outcome == "restore" and value == signal.SIGINT and handler is previous_signals[value]:
                restoration_reached = True
                os.kill(os.getpid(), number)
            return result

        with (
            patch("command_supervisor.shutil.rmtree", remove),
            patch("command_supervisor.signal.signal", restore),
            redirect_stderr(io.StringIO()),
        ):
            try:
                supervised_run(
                    [sys.executable, actor, fixture.evidence / "ready.json", 0 if outcome == "success" else 7],
                    os.environ,
                    cwd=ROOT,
                    capture=True,
                    on_started=ready,
                )
            except InterruptedError as error:
                if outcome == "remove":
                    raise RuntimeError("Cleanup cancellation hid the storage failure") from error
                interruption = error
            except ExceptionGroup as error:
                if outcome != "remove" or len(error.exceptions) != 2:
                    raise RuntimeError("Cleanup cancellation lost its independent failures") from error
                interruption, removal = error.exceptions
                if not isinstance(removal, OSError) or not any(root.exists() for root in fixture.roots):
                    raise RuntimeError("Cleanup cancellation did not retain failed storage") from error
            else:
                raise RuntimeError("Cleanup cancellation incorrectly succeeded")
        if not isinstance(interruption, InterruptedError) or interruption.errno != number:
            raise RuntimeError("Cleanup cancellation lost its first signal")
        cause = interruption.__cause__
        if outcome == "success":
            if cause is not None:
                raise RuntimeError("Successful command invented a primary failure")
        elif (
            not isinstance(cause, subprocess.CalledProcessError)
            or cause.returncode != 7
            or "COMPLETED_COMMAND_DIAGNOSTIC" not in (cause.stderr or "")
        ):
            raise RuntimeError("Cleanup cancellation lost the command failure or diagnostics")
        if outcome == "remove":
            fixture.require_stopped()
        else:
            fixture.require_clean()
        if outcome == "restore" and not restoration_reached:
            raise RuntimeError("Cleanup restoration schedule did not execute")
        if (
            _subreaper() != previous_subreaper
            or signal.pthread_sigmask(signal.SIG_BLOCK, set()) != previous_mask
            or any(signal.getsignal(value) != handler for value, handler in previous_signals.items())
        ):
            raise RuntimeError("Cleanup cancellation did not restore observer process state")
    print(f"PASS cleanup {signal.Signals(number).name} after {outcome}: cancellation and failures preserved")


def _parent_reaping_probe():
    with _fault_fixture() as fixture:
        _writer(fixture)
        owner = fixture.evidence / "reaping_owner.py"
        owner.write_text("""
import json,os,signal,subprocess,sys,time
from pathlib import Path
evidence = Path(sys.argv[1])
signal.signal(signal.SIGTERM,signal.SIG_IGN)
child = subprocess.Popen([sys.executable,evidence / 'writer.py',evidence / 'nested.json'])
deadline = time.monotonic() + 3
while not (evidence / 'nested.json').exists():
    if child.poll() is not None or time.monotonic() >= deadline:
        raise RuntimeError('Nested writer did not become ready')
    time.sleep(.01)
(evidence / 'ready.json').write_text(json.dumps({'pids':[os.getpid(),child.pid],'root':os.environ['TMPDIR']}))
while not (evidence / 'reap-child').exists(): time.sleep(.01)
child.kill()
child.wait(timeout=2)
(evidence / 'child-reaped').write_text('reaped by parent')
while True: time.sleep(.02)
""")
        state = None
        actual_kill = os.kill
        actual_owned = _owned_processes

        def ready(process, root):
            nonlocal state
            fixture.record(process, root)
            state = fixture.ready(process)

        def snapshot(*arguments):
            facts = actual_owned(*arguments)
            # Select a valid snapshot order, retaining every real process fact.
            return dict(sorted(facts.items(), key=lambda item: item[0] != arguments[0].pid))

        def kill(pid, number):
            if state is not None and number == signal.SIGKILL:
                parent, child = state["pids"]
                if pid == parent:
                    (fixture.evidence / "reap-child").touch()
                    deadline = time.monotonic() + 2
                    while not (fixture.evidence / "child-reaped").exists():
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Parent did not reap its child at the forced-signal boundary")
                        time.sleep(0.01)
                    try:
                        actual_kill(child, 0)
                    except ProcessLookupError:
                        pass
                    else:
                        raise RuntimeError("Actual child was not reaped by its parent")
                elif pid == child and (fixture.evidence / "child-reaped").exists():
                    # Refuse the stale numeric signal before an unrelated PID
                    # could receive it; disappearance was proved by the kernel.
                    raise RuntimeError("Supervisor attempted to signal a child already reaped by its parent")
            return actual_kill(pid, number)

        with patch("command_supervisor._owned_processes", snapshot), patch("command_supervisor.os.kill", kill):
            try:
                supervised_run(
                    [sys.executable, owner, fixture.evidence], os.environ, cwd=ROOT, timeout=1, on_started=ready
                )
            except subprocess.TimeoutExpired:
                pass
            else:
                raise RuntimeError("Parent-reaping deadline incorrectly succeeded")
        if (fixture.evidence / "child-reaped").read_text() != "reaped by parent":
            raise RuntimeError("Parent-reaping schedule did not execute")
        fixture.require_clean()
    print("PASS forced shutdown across real parent reaping: no stale child PID signalled")


def _nested_writer(fixture):
    _writer(fixture)
    owner = fixture.evidence / "replacement_owner.py"
    owner.write_text("""
import json,os,subprocess,sys,time
from pathlib import Path
evidence = Path(sys.argv[1])
child = subprocess.Popen([sys.executable,evidence / 'writer.py',evidence / 'nested.json','detached'])
deadline = time.monotonic() + 3
while not (evidence / 'nested.json').exists():
    if child.poll() is not None or time.monotonic() >= deadline:
        raise RuntimeError('Replacement writer did not become ready')
    time.sleep(.01)
(evidence / 'ready.json').write_text(json.dumps({'pids':[os.getpid(),child.pid],'root':os.environ['TMPDIR']}))
while True: time.sleep(.02)
""")
    return owner


def _reused_identity_probe(adopted=False):
    with _fault_fixture() as fixture:
        owner = _nested_writer(fixture)
        state = None
        scheduled = False
        actual_owned = _owned_processes

        def ready(process, root):
            nonlocal state
            fixture.record(process, root)
            state = fixture.ready(process)

        def snapshot(process, owned, previous_children):
            nonlocal scheduled
            if state is not None and not scheduled and (not adopted or process.returncode is not None):
                child = state["pids"][1]
                birth = _processes()[child][2]
                # Schedule only stale identity metadata. The current detached
                # writer, its parent/adoption, signalling and storage are real.
                owned[child] = str(int(birth) - 1)
                if adopted:
                    previous_children[child] = owned[child]
                scheduled = True
            return actual_owned(process, owned, previous_children)

        with patch("command_supervisor._owned_processes", snapshot):
            try:
                supervised_run(
                    [sys.executable, owner, fixture.evidence], os.environ, cwd=ROOT, timeout=1, on_started=ready
                )
            except subprocess.TimeoutExpired:
                pass
            else:
                raise RuntimeError("Replacement-writer deadline incorrectly succeeded")
        if not scheduled:
            raise RuntimeError("Stale identity schedule did not execute")
        fixture.require_clean()
    stage = "adopted with old baseline" if adopted else "nested"
    print(f"PASS {stage} writer with stale birth record: current child stopped/reaped before storage removal")


def _stale_parent_probe():
    with _fault_fixture() as fixture:
        actor = _nested_writer(fixture)
        foreign_root = fixture.evidence / "foreign-storage"
        foreign_root.mkdir()
        parent = subprocess.Popen(
            [sys.executable, actor, fixture.evidence],
            env={**os.environ, "TMPDIR": str(foreign_root)},
            text=True,
            start_new_session=True,
        )
        fixture.record(parent, foreign_root)
        state = fixture.ready(parent)
        birth = _processes()[parent.pid][2]
        command = None
        actual_owned = _owned_processes

        def ready(process, root):
            nonlocal command
            fixture.record(process, root)
            command = process, root

        def snapshot(process, owned, previous_children):
            # This real pre-existing parent belongs to the independent fixture,
            # not the command. Its stale identity must not claim its live child.
            owned[parent.pid] = str(int(birth) - 1)
            return actual_owned(process, owned, previous_children)

        with patch("command_supervisor._owned_processes", snapshot):
            supervised_run([sys.executable, "-c", "pass"], os.environ, cwd=ROOT, on_started=ready)
        process, root = command
        if process.poll() != 0 or root.exists():
            raise RuntimeError("Unrelated-parent control did not complete command cleanup")
        for pid in state["pids"]:
            os.kill(pid, 0)
        if (foreign_root / "writer").read_text() != "actual open writer":
            raise RuntimeError("Command cleanup changed unrelated writer storage")
        # Those unrelated writers intentionally survive this assertion. The
        # independent fixture owns their subsequent stop/reap and storage cleanup.
    print("PASS stale unrelated parent identity cannot claim or stop its real writer")


def _graceful_shutdown_probe(cleanup_signal=None):
    with _fault_fixture() as fixture:
        child = fixture.evidence / "child.py"
        child.write_text("""
import sys
from pathlib import Path
print('ready',flush=True)
if sys.stdin.readline().strip() == 'drain':
    Path(sys.argv[1]).write_text('drained by owner')
""")
        owner = fixture.evidence / "owner.py"
        owner.write_text("""
import json,os,signal,subprocess,sys,time
from pathlib import Path
evidence = Path(sys.argv[1])
child = subprocess.Popen([sys.executable,evidence / 'child.py',evidence / 'drained'],
                         stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
if child.stdout.readline().strip() != 'ready':
    raise RuntimeError('Actual child did not become ready')
def drain(number,frame):
    time.sleep(.2)
    child.stdin.write('drain\\n')
    child.stdin.flush()
    status = child.wait(timeout=2)
    (evidence / 'outcome.json').write_text(json.dumps({'childStatus':status}))
    # More than a pipe buffer proves diagnostics cannot block graceful cleanup.
    print('x' * 131072,flush=True)
    print('INDEPENDENT_CLEANUP_DIAGNOSTIC',file=sys.stderr,flush=True)
    sys.exit(3)
signal.signal(signal.SIGTERM,drain)
(evidence / 'ready.json').write_text(json.dumps({'pids':[os.getpid(),child.pid],'root':os.environ['TMPDIR']}))
while True: time.sleep(.02)
""")

        def ready(process, root):
            fixture.record(process, root)
            fixture.ready(process)

        output, diagnostic = io.StringIO(), io.StringIO()
        actual_kill = os.kill

        def kill(pid, number):
            actual_kill(pid, number)
            if cleanup_signal is not None and pid == fixture.processes[0].pid and number == signal.SIGTERM:
                os.kill(os.getpid(), cleanup_signal)

        with patch("command_supervisor.os.kill", kill), redirect_stdout(output), redirect_stderr(diagnostic):
            try:
                supervised_run(
                    [sys.executable, owner, fixture.evidence],
                    os.environ,
                    cwd=ROOT,
                    capture=True,
                    timeout=1,
                    on_started=ready,
                )
            except (subprocess.TimeoutExpired, InterruptedError) as error:
                if cleanup_signal is not None:
                    if not isinstance(error, InterruptedError) or error.errno != cleanup_signal:
                        raise RuntimeError("Graceful cleanup lost its cancellation") from error
                    failure = error.__cause__
                else:
                    failure = error
                if not isinstance(failure, subprocess.TimeoutExpired):
                    raise TypeError("Graceful cleanup lost its deadline") from error
                if "INDEPENDENT_CLEANUP_DIAGNOSTIC" not in (failure.stderr or ""):
                    raise RuntimeError("Deadline failure lost its post-TERM diagnostic") from error
                if "x" * 131072 not in (failure.output or ""):
                    raise RuntimeError("Deadline failure lost its captured shutdown output") from error
            else:
                raise RuntimeError("Graceful deadline probe incorrectly succeeded")
        if json.loads((fixture.evidence / "outcome.json").read_text()) != {"childStatus": 0}:
            raise RuntimeError("Cleanup owner could not drain its cooperative child")
        if (fixture.evidence / "drained").read_text() != "drained by owner":
            raise RuntimeError("Cooperative child did not complete its drain")
        if "INDEPENDENT_CLEANUP_DIAGNOSTIC" not in diagnostic.getvalue() or "x" * 131072 not in output.getvalue():
            raise RuntimeError("Verifier log lost captured shutdown diagnostics")
        fixture.require_clean()
    print(
        f"PASS graceful owner drain, cancellation {cleanup_signal} and diagnostics: children stopped/reaped, storage removed"
    )


def check_command_faults():
    actual_read = Path.read_text

    def without_children(path, *arguments, **options):
        if path.name == "children" and path.is_relative_to("/proc"):
            raise FileNotFoundError("Controlled kernel without CONFIG_PROC_CHILDREN")
        return actual_read(path, *arguments, **options)

    # Remove only the optional interface. Processes, stat snapshots, readiness
    # files and the independent safety owner's termination/reaping remain real.
    with patch("pathlib.Path.read_text", without_children):
        for number in (signal.SIGINT, signal.SIGTERM):
            _launch_cancellation_probe(number)
            _pipe_cancellation_probe(number)
            for outcome in ("success", "failure", "remove", "restore"):
                _cleanup_signal_probe(number, outcome)
            _graceful_shutdown_probe(number)
        _graceful_shutdown_probe()
        _parent_reaping_probe()
        _reused_identity_probe()
        _reused_identity_probe(adopted=True)
        _stale_parent_probe()
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
        try:
            _cleanup_signal_probe(signal.SIGINT, "success")
            if signal.SIGTERM not in signal.sigpending():
                raise RuntimeError("Restoration consumed the caller's already-blocked signal")
            if signal.sigtimedwait({signal.SIGTERM}, 0) is None:
                raise RuntimeError("Caller could not consume its retained pending signal")
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        print("PASS caller's blocked signal and mask preserved through cleanup restoration")
    print("PASS real fault controls without the optional /proc children interface")


if __name__ == "__main__":
    check_command_faults()
