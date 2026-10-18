from __future__ import annotations

import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass


SCRIPT = Path(__file__).resolve()
TIMEOUT = 10
BODY = b"abc"
DIGEST = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


@dataclass(frozen=True)
class Descriptor:
    id: str
    length: int
    digest: str


@dataclass(frozen=True)
class Attempt:
    token: str
    pid: int
    private_file: Path
    installed_file: Path


DESCRIPTOR = Descriptor("object-1", 3, DIGEST)
SCHEMA = """
CREATE TABLE authority(dataset TEXT NOT NULL, authorized INTEGER NOT NULL);
INSERT INTO authority VALUES('dataset-1',1);
CREATE TABLE attempts(token TEXT PRIMARY KEY,pid INTEGER NOT NULL,file TEXT NOT NULL,
                      state TEXT NOT NULL CHECK(state IN ('active','complete','abandoned')));
CREATE TABLE objects(id TEXT PRIMARY KEY,length INTEGER NOT NULL,digest TEXT NOT NULL,
                     file TEXT NOT NULL UNIQUE,state TEXT NOT NULL,charged INTEGER NOT NULL);
CREATE TABLE retries(request TEXT PRIMARY KEY,object TEXT NOT NULL,facts TEXT NOT NULL,
                     result TEXT NOT NULL);
CREATE TABLE changes(seq INTEGER PRIMARY KEY,object TEXT NOT NULL,kind TEXT NOT NULL,
                     image TEXT NOT NULL);
CREATE TABLE holds(object TEXT PRIMARY KEY,task TEXT NOT NULL);
"""


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def connect(root, timeout=5):
    db = sqlite3.connect(root / "state.sqlite", timeout=timeout, isolation_level=None)
    if db.execute("PRAGMA journal_mode=WAL").fetchone()[0] != "wal":
        raise RuntimeError("WAL unavailable")
    db.execute("PRAGMA synchronous=FULL")
    if db.execute("PRAGMA synchronous").fetchone()[0] != 2:
        raise RuntimeError("FULL unavailable")
    return db


def initialize(root):
    root.mkdir()
    (root / "private").mkdir()
    (root / "installed").mkdir()
    db = connect(root)
    try:
        db.executescript(SCHEMA)
    finally:
        db.close()


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Refusal(Exception):
    pass


def checkpoint(channel, configured, name, token):
    if configured == name:
        channel.sendall((encode({"barrier": name, "pid": os.getpid(), "token": token}) + "\n").encode())
        if channel.recv(1) != b"+":
            raise RuntimeError("barrier closed without release")


def verified_bytes(path, descriptor):
    try:
        with path.open("rb") as stream:
            content = stream.read(descriptor.length + 1)
    except FileNotFoundError:
        raise Refusal("integrity_error")
    if len(content) != descriptor.length or hashlib.sha256(content).hexdigest() != descriptor.digest:
        raise Refusal("integrity_error")
    return content


def publish(root, config, channel):
    descriptor = Descriptor(**config.get("descriptor", asdict(DESCRIPTOR)))
    body = bytes.fromhex(config.get("body", "616263"))
    if descriptor.length < 0 or descriptor.length > 1024 or len(body) > 1024:
        raise Refusal("fixture_budget")
    if len(body) != descriptor.length or hashlib.sha256(body).hexdigest() != descriptor.digest:
        raise Refusal("descriptor_mismatch")
    token = config["token"]
    attempt = Attempt(token, os.getpid(), root / "private" / token, root / "installed" / token)
    db = connect(root)
    stop = config.get("stop")
    broken = config.get("broken")
    try:
        if db.execute("SELECT * FROM authority").fetchone() != ("dataset-1", 1):
            raise Refusal("admission_refused")
        db.execute("INSERT INTO attempts VALUES(?,?,?,'active')", (token, attempt.pid, token))
        if broken != "metadata_first":
            with attempt.private_file.open("xb") as stream:
                stream.write(body)
                stream.flush()
                os.fsync(stream.fileno())
            checkpoint(channel, stop, "upload_wait", token)
            checkpoint(channel, stop, "before_install", token)
            if config.get("simulated_enospc"):
                raise OSError(errno.ENOSPC, "simulated ENOSPC, host disk was not filled")
            if broken == "overwrite":
                os.replace(attempt.private_file, attempt.installed_file)
            else:
                try:
                    os.link(attempt.private_file, attempt.installed_file)
                except FileExistsError:
                    raise Refusal("install_collision")
            checkpoint(channel, stop, "after_install", token)
            fsync_directory(root / "installed")
            attempt.private_file.unlink(missing_ok=True)
            fsync_directory(root / "private")
        db.execute("BEGIN IMMEDIATE")
        dataset, authorized = db.execute("SELECT * FROM authority").fetchone()
        if broken != "skip_authority":
            if not authorized:
                raise Refusal("unauthorized")
            if dataset != "dataset-1":
                raise Refusal("stale_dataset")
        previous = db.execute("SELECT object,facts,result FROM retries WHERE request='upload-1'").fetchone()
        facts = encode(asdict(descriptor))
        if previous:
            if json.loads(previous[1]) != asdict(descriptor):
                raise Refusal("conflict")
            row = db.execute("SELECT length,digest,file,state FROM objects WHERE id=?", (previous[0],)).fetchone()
            if row[3] == "tombstone":
                raise Refusal("ended")
            verified_bytes(root / "installed" / row[2], Descriptor(previous[0], row[0], row[1]))
            outcome = "replayed"
        else:
            if db.execute("SELECT 1 FROM objects WHERE id=?", (descriptor.id,)).fetchone():
                raise Refusal("ended_or_existing")
            if broken != "metadata_first":
                verified_bytes(attempt.installed_file, descriptor)
            db.execute("INSERT INTO objects VALUES(?,?,?,?,'ready',?)",
                       (descriptor.id, descriptor.length, descriptor.digest, token, descriptor.length))
            db.execute("INSERT INTO retries VALUES('upload-1',?,?,?)", (descriptor.id, facts, facts))
            db.execute("INSERT INTO changes VALUES(1,?,'ready',?)", (descriptor.id, facts))
            outcome = "published"
        db.execute("UPDATE attempts SET state='complete' WHERE token=?", (token,))
        checkpoint(channel, stop, "before_sql_commit", token)
        db.commit()
        checkpoint(channel, stop, "after_sql_commit", token)
        checkpoint(channel, stop, "metadata_before_file", token)
        return {"outcome": outcome, "descriptor": asdict(descriptor), "journal": "wal", "synchronous": 2}
    finally:
        db.close()


def read_fresh(root):
    db = sqlite3.connect(f"file:{root / 'state.sqlite'}?mode=ro", uri=True, isolation_level=None)
    try:
        db.execute("BEGIN")
        rows = db.execute("SELECT id,length,digest,file,state,charged FROM objects ORDER BY id").fetchall()
        objects, reads = [], []
        for oid, length, digest, filename, state, charged in rows:
            objects.append([oid, length, digest, state, charged])
            if state == "tombstone":
                reads.append([oid, "deleted", None])
                continue
            try:
                with (root / "installed" / filename).open("rb") as stream:
                    actual = stream.read(1025)
                valid = len(actual) == length and hashlib.sha256(actual).hexdigest() == digest
                reads.append([oid, "ok" if valid else "integrity_error", actual.hex() if valid else None])
            except FileNotFoundError:
                reads.append([oid, "integrity_error", None])
        retries = [[request, oid, json.loads(facts), json.loads(result)] for request, oid, facts, result
                   in db.execute("SELECT * FROM retries ORDER BY request")]
        changes = [[seq, oid, kind, json.loads(image)] for seq, oid, kind, image
                   in db.execute("SELECT * FROM changes ORDER BY seq")]
        return {"objects": objects, "retries": retries, "changes": changes, "reads": reads,
                "holds": db.execute("SELECT * FROM holds ORDER BY object").fetchall(),
                "charged": sum(row[5] for row in rows)}
    finally:
        db.close()


def hold_or_delete(root, config, channel):
    db = connect(root, timeout=0)
    action, token = config["action"], config["token"]
    try:
        if config.get("contend"):
            try:
                db.execute("BEGIN IMMEDIATE")
            except sqlite3.OperationalError as error:
                if error.sqlite_errorcode != sqlite3.SQLITE_BUSY:
                    raise
            else:
                raise RuntimeError("expected real SQLite write-lock contention")
            checkpoint(channel, "contended", "contended", token)
        db.execute("BEGIN IMMEDIATE")
        state = db.execute("SELECT state FROM objects WHERE id='object-1'").fetchone()[0]
        held = db.execute("SELECT 1 FROM holds WHERE object='object-1'").fetchone()
        if state == "tombstone":
            outcome = "ended"
        elif action == "hold":
            db.execute("INSERT INTO holds VALUES('object-1','task-1')")
            outcome = "held"
        elif held:
            outcome = "hold_blocks_delete"
        else:
            db.execute("UPDATE objects SET state='tombstone' WHERE id='object-1'")
            db.execute("INSERT INTO changes VALUES(2,'object-1','deleted','null')")
            outcome = "deleted"
        checkpoint(channel, config.get("stop"), "locked", token)
        db.commit()
        return {"outcome": outcome}
    finally:
        db.close()


def sweep_owned(root, confirmed_dead):
    db = connect(root)
    removed = []
    try:
        referenced = {row[0] for row in db.execute("SELECT file FROM objects")}
        for token, pid, filename in db.execute("SELECT token,pid,file FROM attempts"):
            if confirmed_dead.get(token) != pid or filename in referenced:
                continue
            for folder in ("private", "installed"):
                path = root / folder / filename
                if path.exists():
                    path.unlink()
                    removed.append(f"{folder}/{filename}")
                    fsync_directory(root / folder)
            db.execute("UPDATE attempts SET state='abandoned' WHERE token=?", (token,))
        return sorted(removed)
    finally:
        db.close()


def worker(mode, root, config, channel):
    if mode == "read":
        return read_fresh(root)
    try:
        if mode == "publish":
            return publish(root, config, channel)
        if mode == "action":
            return hold_or_delete(root, config, channel)
        raise RuntimeError("unknown worker mode")
    except Refusal as error:
        return {"outcome": str(error)}
    except OSError as error:
        if config.get("simulated_enospc") and error.errno == errno.ENOSPC:
            return {"outcome": "simulated_enospc"}
        raise


class Child:
    def __init__(self, mode, root, config, children):
        self.channel, other = socket.socketpair()
        self.channel.settimeout(TIMEOUT)
        try:
            self.process = subprocess.Popen(
                [sys.executable, str(SCRIPT), "--worker", mode, str(root), str(other.fileno()), encode(config)],
                pass_fds=(other.fileno(),), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, cwd=SCRIPT.parent)
        except Exception:
            self.channel.close()
            raise
        finally:
            other.close()
        self.token = config.get("token")
        self.reaped = False
        children.append(self)

    def barrier(self, name):
        raw = bytearray()
        while not raw.endswith(b"\n"):
            part = self.channel.recv(4096)
            if not part or len(raw) + len(part) > 4096:
                raise RuntimeError("missing or oversized barrier")
            raw.extend(part)
        event = json.loads(raw)
        if event != {"barrier": name, "pid": self.process.pid, "token": self.token}:
            raise RuntimeError(f"unexpected barrier {event}")

    def release(self):
        self.channel.sendall(b"+")

    def finish(self, kill=False):
        if kill:
            self.process.kill()
        try:
            stdout, stderr = self.process.communicate(timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.communicate(timeout=TIMEOUT)
            raise RuntimeError("child exceeded deadline")
        finally:
            self.reaped = self.process.returncode is not None
            self.channel.close()
        if kill:
            if self.process.returncode != -9 or stdout or stderr:
                raise RuntimeError("kill did not stop a silent barrier child")
            return {"outcome": "killed", "returncode": -9}
        if self.process.returncode != 0 or stderr:
            raise RuntimeError(f"worker failed {self.process.returncode}: {(stdout + stderr).decode(errors='replace')}")
        record = json.loads(stdout)
        if record["cases"] or record["limitations"] or record["experiment"] != "object-files-worker":
            raise RuntimeError("invalid worker observation")
        return record["findings"][0]


def expected_view(state="absent", hold=False, integrity=False):
    descriptor = {"id": "object-1", "length": 3, "digest": DIGEST}
    if state == "absent":
        return {"objects": [], "retries": [], "changes": [], "reads": [], "holds": [], "charged": 0}
    deleted = state == "tombstone"
    return {"objects": [["object-1", 3, DIGEST, state, 3]],
            "retries": [["upload-1", "object-1", descriptor, descriptor]],
            "changes": [[1, "object-1", "ready", descriptor]] +
                       ([[2, "object-1", "deleted", None]] if deleted else []),
            "reads": [["object-1", "deleted" if deleted else "integrity_error" if integrity else "ok",
                       None if deleted or integrity else "616263"]],
            "holds": [["object-1", "task-1"]] if hold else [], "charged": 3}


def run_experiment(base, cases, children):
    def check(name, expected, observed):
        cases.append({"name": name, "expected": expected, "observed": observed, "passed": expected == observed})

    def fresh(root):
        return Child("read", root, {}, children).finish()

    def child(root, token, **config):
        return Child("publish", root, {"token": token, **config}, children)

    def new(name):
        root = base / name
        initialize(root)
        return root

    def sql(root, statement):
        db = connect(root)
        try:
            db.execute(statement)
        finally:
            db.close()

    committed = None
    for stop in ("before_install", "after_install", "before_sql_commit", "after_sql_commit"):
        root = new(stop)
        writer = child(root, "interrupted", stop=stop)
        writer.barrier(stop)
        expected = expected_view("ready" if stop == "after_sql_commit" else "absent")
        check(f"{stop}: fresh read while publisher paused", expected, fresh(root))
        check(f"{stop}: SIGKILL barrier", {"outcome": "killed", "returncode": -9}, writer.finish(kill=True))
        check(f"{stop}: fresh read after process death", expected, fresh(root))
        old_file = root / "installed" / "interrupted"
        old_bytes = old_file.read_bytes() if old_file.exists() else None
        result = child(root, "retry").finish()
        check(f"{stop}: exact retry outcome", "replayed" if stop == "after_sql_commit" else "published", result["outcome"])
        check(f"{stop}: one exact publication after retry", expected_view("ready"), fresh(root))
        if old_bytes is not None:
            check(f"{stop}: orphan or committed bytes unchanged", old_bytes.hex(), old_file.read_bytes().hex())
        if stop == "after_sql_commit":
            committed = root

    check("actual writer settings", ["wal", 2], [result["journal"], result["synchronous"]])
    check("changed retry facts conflict", "conflict", child(committed, "changed", body="616264", descriptor={
        "id": "object-1", "length": 3, "digest": hashlib.sha256(b"abd").hexdigest()}).finish()["outcome"])
    check("conflict leaves original public state exact", expected_view("ready"), fresh(committed))
    check("incorrect upload digest refused", "descriptor_mismatch", child(committed, "bad-digest", body="616264").finish()["outcome"])
    (committed / "installed" / "interrupted").write_bytes(b"abd")
    check("committed corruption is explicit with metadata retained", expected_view("ready", integrity=True), fresh(committed))
    check("exact retry cannot hide committed corruption", "integrity_error", child(committed, "corrupt-retry").finish()["outcome"])

    root = new("collision")
    occupied = root / "installed" / "occupied"
    occupied.write_bytes(b"DIFFERENT")
    check("no-overwrite refuses different existing bytes", "install_collision", child(root, "occupied").finish()["outcome"])
    check("collision does not publish", expected_view(), fresh(root))
    check("fresh attempt progresses after collision", "published", child(root, "new-attempt").finish()["outcome"])
    check("different orphan bytes survive retry unchanged", "444946464552454e54", occupied.read_bytes().hex())
    check("new attempt publishes exact content", expected_view("ready"), fresh(root))

    for name, mutation, outcome in (
        ("revoked", "UPDATE authority SET authorized=0", "unauthorized"),
        ("dataset", "UPDATE authority SET dataset='dataset-2'", "stale_dataset")):
        root = new(name)
        writer = child(root, "waiting", stop="upload_wait")
        writer.barrier("upload_wait")
        sql(root, mutation)
        writer.release()
        check(f"{name}: rechecked after upload wait", outcome, writer.finish()["outcome"])
        check(f"{name}: no public effects", expected_view(), fresh(root))
    root = new("simulated_enospc")
    check("SIMULATED ENOSPC refuses publication", "simulated_enospc", child(root, "full", simulated_enospc=True).finish()["outcome"])
    check("SIMULATED ENOSPC leaves no public effects", expected_view(), fresh(root))

    for first_action, first_outcome, second_outcome in (
        ("hold", "held", "hold_blocks_delete"), ("delete", "deleted", "ended")):
        root = new(f"{first_action}_first")
        child(root, "initial").finish()
        first = Child("action", root, {"token": "first", "action": first_action, "stop": "locked"}, children)
        first.barrier("locked")
        second = Child("action", root, {"token": "second", "action": "delete" if first_action == "hold" else "hold",
                                       "contend": True}, children)
        second.barrier("contended")
        check(f"{first_action}-first: actual competing writer hit SQLITE_BUSY", True, first.process.poll() is None and second.process.poll() is None)
        check(f"{first_action}-first: uncommitted effect remains invisible", expected_view("ready"), fresh(root))
        first.release()
        check(f"{first_action}-first: owner result", first_outcome, first.finish()["outcome"])
        second.release()
        check(f"{first_action}-first: contender result", second_outcome, second.finish()["outcome"])
        expected = expected_view("ready", hold=True) if first_action == "hold" else expected_view("tombstone")
        check(f"{first_action}-first: serialized public result", expected, fresh(root))
        if first_action == "delete":
            check("delete-first: retry cannot resurrect", "ended", child(root, "late-retry").finish()["outcome"])
            check("tombstone stays charged before reclamation", expected, fresh(root))

    root = new("ownership")
    writer = child(root, "live", stop="after_install")
    writer.barrier("after_install")
    ambiguous = root / "installed" / "ambiguous"
    ambiguous.write_bytes(b"unknown owner")
    check("safe cleanup preserves live and ambiguous unreferenced files", {"removed": [], "alive": True, "bytes": "616263", "ambiguous": True},
          {"removed": sweep_owned(root, {}), "alive": writer.process.poll() is None,
           "bytes": (root / "installed" / "live").read_bytes().hex(), "ambiguous": ambiguous.exists()})
    writer.release()
    check("preserved live writer publishes", "published", writer.finish()["outcome"])
    abandoned = child(root, "abandoned", stop="before_install")
    abandoned.barrier("before_install")
    abandoned.finish(kill=True)
    check("cleanup removes only proven-dead owned attempt", ["private/abandoned"],
          sweep_owned(root, {"abandoned": abandoned.process.pid, "live": writer.process.pid}))
    check("cleanup retains committed state and exact bytes", expected_view("ready"), fresh(root))
    check("cleanup retains ambiguous ownership", True, ambiguous.exists())

    root = new("broken_sweep")
    writer = child(root, "live", stop="after_install")
    writer.barrier("after_install")
    before = fresh(root)
    alive = writer.process.poll() is None
    db = connect(root)
    try:
        referenced = {row[0] for row in db.execute("SELECT file FROM objects")}
    finally:
        db.close()
    for path in (root / "installed").iterdir():
        if path.name not in referenced:
            path.unlink()
    writer.release()
    result = writer.finish()
    check("BROKEN CONTROL detected: sweep unreferenced deletes live prepublication file",
          {"alive_at_sweep": True, "public_before": expected_view(), "file_lost": True, "publisher": "integrity_error"},
          {"alive_at_sweep": alive, "public_before": before, "file_lost": not (root / "installed" / "live").exists(), "publisher": result["outcome"]})
    check("sweep damage does not become public success", expected_view(), fresh(root))

    root = new("broken_metadata_first")
    writer = child(root, "early", broken="metadata_first", stop="metadata_before_file")
    writer.barrier("metadata_before_file")
    observed = fresh(root)
    writer.finish(kill=True)
    check("BROKEN CONTROL detected: metadata-first exposes unavailable content", expected_view("ready", integrity=True), observed)

    root = new("broken_overwrite")
    target = root / "installed" / "occupied"
    target.write_bytes(b"DIFFERENT")
    result = child(root, "occupied", broken="overwrite").finish()
    check("BROKEN CONTROL detected: replace overwrites different bytes", {"outcome": "published", "different_bytes_destroyed": True},
          {"outcome": result["outcome"], "different_bytes_destroyed": target.read_bytes() == b"abc"})

    root = new("broken_authority")
    writer = child(root, "waiting", broken="skip_authority", stop="upload_wait")
    writer.barrier("upload_wait")
    sql(root, "UPDATE authority SET authorized=0")
    writer.release()
    check("BROKEN CONTROL detected: admission-only authorization publishes after revocation", "published", writer.finish()["outcome"])
    check("revocation control really committed content", expected_view("ready"), fresh(root))

    root = new("broken_resurrection")
    child(root, "initial").finish()
    Child("action", root, {"token": "delete", "action": "delete"}, children).finish()
    check("resurrection control starts with committed tombstone", expected_view("tombstone"), fresh(root))
    sql(root, "UPDATE objects SET state='ready' WHERE id='object-1'")
    resurrected = fresh(root)
    check("BROKEN CONTROL detected: blind state update resurrects tombstone", [["object-1", "ok", "616263"]], resurrected["reads"])


def main():
    if len(sys.argv) > 1:
        record = {"experiment": "object-files-worker", "cases": [], "findings": [], "limitations": []}
        try:
            _, flag, mode, directory, fd, raw = sys.argv
            if flag != "--worker":
                raise RuntimeError("unsupported arguments")
            with socket.socket(fileno=int(fd)) as channel:
                channel.settimeout(TIMEOUT)
                record["findings"].append(worker(mode, Path(directory), json.loads(raw), channel))
        except Exception as error:
            record["cases"].append({"name": "unexpected worker failure", "expected": "no exception",
                                    "observed": f"{type(error).__name__}: {error}", "passed": False})
        print(encode(record))
        return 1 if record["cases"] else 0
    cases, children = [], []
    root = None
    try:
        root = Path(tempfile.mkdtemp(prefix="atlas-object-files-"))
        run_experiment(root, cases, children)
    except Exception as error:
        cases.append({"name": "unexpected experiment failure", "expected": "no exception",
                      "observed": f"{type(error).__name__}: {error}", "passed": False})
    finally:
        failures = []
        for child in children:
            if not child.reaped:
                try:
                    if child.process.poll() is None:
                        child.process.kill()
                    child.process.communicate(timeout=TIMEOUT)
                    child.reaped = True
                    child.channel.close()
                except Exception as error:
                    failures.append(str(error))
        if not failures and root is not None:
            try:
                shutil.rmtree(root)
            except Exception as error:
                failures.append(str(error))
        exists = root is not None and root.exists()
        cases.append({"name": "all children exited before owned runtime cleanup", "expected": {"errors": [], "exists": False},
                      "observed": {"errors": failures, "exists": exists}, "passed": not failures and not exists})
    passed = all(case["passed"] for case in cases)
    findings = [
        {"classification": "documented-rule-pitfall", "claim": "File presence is not publication; three SQL effects commit together.",
         "evidence": [case["name"] for case in cases if "fresh read after process death" in case["name"]]},
        {"classification": "engineering-choice", "claim": "Attempt-specific install paths allow retry progress without changing orphan bytes.",
         "evidence": ["different orphan bytes survive retry unchanged", "new attempt publishes exact content"]},
        {"classification": "documented-rule-pitfall", "claim": "Unreferenced-file sweeping destroys a live writer's installed content.",
         "evidence": ["BROKEN CONTROL detected: sweep unreferenced deletes live prepublication file"]},
        {"classification": "experiment-result", "claim": "Observed cases passed." if passed else "Unexpected failures require investigation.",
         "cases": len(cases), "passed": sum(case["passed"] for case in cases),
         "child_processes": len(children),
         "broken_controls": sum(case["name"].startswith("BROKEN CONTROL") for case in cases)}]
    limitations = [
        "Disposable Python stdlib mechanism experiment, not production code or Protocol conformance.",
        "SIGKILL process recovery is not power-cut, controller-cache, filesystem, or hardware durability qualification.",
        "Object files only. Reset, host manager, Docker, Go, HTTP streaming, downloads, and Task execution are unrun.",
        "ENOSPC is explicitly simulated before installation. No host disk filling or real capacity isolation proof.",
        "Single bounded 3-byte fixture, SHA-256 known vector, local Linux same-filesystem hard links and SQLite WAL/FULL.",
        "Ownership proof uses this parent's waited child PID plus unique attempt token; takeover and PID-reuse fencing are unresolved.",
        "Hold/delete tests force both lock orders, not arbitrary schedule stress. Physical tombstone reclamation is unrun.",
        "Descriptor, Dataset, credential, retry, and batch encodings are prototype assumptions, not authoritative schemas.",
        "Attempt-path collision refuses that attempt; progress requires a fresh unique attempt path.",
        "Concurrent duplicate upload races and real fsync failure injection are unrun."]
    print(encode({"experiment": "storage", "cases": cases, "findings": findings, "limitations": limitations}))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
