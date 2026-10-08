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

from command_supervisor import _defer_interruptions, _Interruption, _processes, _subreaper, supervised_run
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

    def require_clean(self):
        # These assertions run before the independent safety owner can stop a
        # leaked writer or remove storage on behalf of the supervisor under test.
        for pid in self.pids:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                continue
            raise RuntimeError(f"Fault fixture process {pid} remains running or unreaped")
        for root in self.roots:
            if root.exists():
                raise RuntimeError(f"Fault fixture retained private storage: {root}")


def _children():
    # /proc/.../children requires optional CONFIG_PROC_CHILDREN. The supported
    # stat interface already supplies each process's parent on Linux.
    return {pid for pid, facts in _processes().items() if facts[0] == os.getpid()}


@contextmanager
def _fault_fixture():
    previous_subreaper = _subreaper()
    previous_children = _children()
    previous_signals = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    fixture = None
    closing = False

    def interrupt(number, _frame):
        if not closing:
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
                fixture.pids.update(_children() - previous_children)
                for pid in fixture.pids:
                    try:
                        os.kill(pid, signal.SIGKILL)
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
        for number, handler in previous_signals.items():
            try:
                signal.signal(number, handler)
            except (OSError, ValueError) as error:
                errors.append(error)
        try:
            _subreaper(previous_subreaper)
        except OSError as error:
            errors.append(error)
        if errors:
            raise BaseExceptionGroup(
                "Fault probe and safety cleanup failures", [primary, *errors] if primary else errors
            )


def _writer(fixture):
    actor = fixture.evidence / "writer.py"
    actor.write_text("""
import json,os,sys,time
from pathlib import Path
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


def _graceful_shutdown_probe():
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
        with redirect_stdout(output), redirect_stderr(diagnostic):
            try:
                supervised_run(
                    [sys.executable, owner, fixture.evidence],
                    os.environ,
                    cwd=ROOT,
                    capture=True,
                    timeout=1,
                    on_started=ready,
                )
            except subprocess.TimeoutExpired as error:
                if "INDEPENDENT_CLEANUP_DIAGNOSTIC" not in (error.stderr or ""):
                    raise RuntimeError("Deadline failure lost its post-TERM diagnostic") from error
                if "x" * 131072 not in (error.output or ""):
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
        "PASS graceful owner drain and captured diagnostics: deadline preserved, children stopped/reaped, storage removed"
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
        _graceful_shutdown_probe()
    print("PASS real fault controls without the optional /proc children interface")


if __name__ == "__main__":
    check_command_faults()
