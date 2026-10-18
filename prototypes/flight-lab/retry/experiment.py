#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import http.client
import json
import multiprocessing as mp
import os
from pathlib import Path
import select
import shutil
import socket
import socketserver
import sqlite3
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from enum import StrEnum
from http.server import BaseHTTPRequestHandler, HTTPServer
from uuid import UUID, uuid4, uuid5, NAMESPACE_URL

@dataclass(frozen=True)
class PreparedRequest:
    dataset: str
    identity: str
    original_facts: str
    kind: str = "task"

@dataclass(frozen=True)
class Task:
    identity: str
    asset: str
    sequence: int
    facts: str
    state: str = "pending"

@dataclass(frozen=True)
class RetryRecord:
    dataset: str
    kind: str
    identity: str
    facts: str
    resource: str

@dataclass(frozen=True)
class ChangeBatch:
    kind: str
    resource: str

class Exposure(StrEnum):
    NEVER = "never"
    POSSIBLE = "possible"

@dataclass(frozen=True)
class Operation:
    identity: str
    facts: str
    digest: str
    state: str = "pending"
    exposure: Exposure = Exposure.NEVER
    runtime: str | None = None

@dataclass(frozen=True)
class RuntimeReceipt:
    operation: str
    digest: str
    runtime: str
    revision: str
    outcome: str

LIMIT, DEADLINE, CAPACITY = 16384, 5, 2
DATASET = str(uuid5(NAMESPACE_URL, "retry-lab-dataset"))
VERSION = "lab-only-1"
TERMINAL = ("completed", "failed", "cancelled", "interrupted")

def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)

def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()

def uid(name):
    return str(uuid5(NAMESPACE_URL, "retry-lab/" + name))

def database(path):
    db = sqlite3.connect(path, timeout=DEADLINE)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    return db

def read_sql(path, sql, args=()):
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=DEADLINE)
    try:
        return db.execute(sql, args).fetchall()
    finally:
        db.close()

def rpc(path, value):
    with socket.socket(socket.AF_UNIX) as channel:
        channel.settimeout(DEADLINE)
        channel.connect(str(path))
        channel.sendall((encode(value) + "\n").encode())
        with channel.makefile("rb") as stream:
            raw = stream.readline(LIMIT + 1)
        if len(raw) > LIMIT or not raw.endswith(b"\n"):
            raise ValueError("bounded complete RPC response required")
        response = json.loads(raw)
        if not isinstance(response, dict):
            raise ValueError("RPC object required")
        return response

class Core:
    def __init__(self, cfg):
        self.cfg, self.run, self.runtime, self.pidfd = cfg, str(uuid4()), None, None
        self.db = database(cfg["db"])
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS meta(dataset TEXT);
          CREATE TABLE IF NOT EXISTS keys(key TEXT PRIMARY KEY, valid INTEGER);
          CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, asset TEXT, sequence INTEGER, facts TEXT, state TEXT);
          CREATE TABLE IF NOT EXISTS sequences(asset TEXT PRIMARY KEY, value INTEGER);
          CREATE TABLE IF NOT EXISTS retries(dataset TEXT, kind TEXT, id TEXT, facts TEXT, resource TEXT, PRIMARY KEY(dataset,kind,id));
          CREATE TABLE IF NOT EXISTS batches(cursor INTEGER PRIMARY KEY, kind TEXT, resource TEXT);
          CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, facts TEXT, digest TEXT, state TEXT, exposure TEXT, runtime TEXT);
          CREATE TABLE IF NOT EXISTS reservations(runtime TEXT, operation TEXT, PRIMARY KEY(runtime,operation));
          CREATE TABLE IF NOT EXISTS evidence(operation TEXT, revision TEXT, outcome TEXT, recovered INTEGER, PRIMARY KEY(operation,revision));
          CREATE TABLE IF NOT EXISTS reports(source TEXT, stream TEXT, sequence INTEGER, facts TEXT, PRIMARY KEY(source,stream,sequence));
          CREATE TABLE IF NOT EXISTS watermarks(source TEXT, stream TEXT, sequence INTEGER, PRIMARY KEY(source,stream));
          CREATE TABLE IF NOT EXISTS movement(source TEXT, sequence INTEGER, position TEXT);
        """)
        with self.db:
            if not self.db.execute("SELECT 1 FROM meta").fetchone():
                self.db.execute("INSERT INTO meta VALUES(?)", (DATASET,))
                self.db.executemany("INSERT INTO keys VALUES(?,1)", [("key-a",), ("key-b",)])
            self.db.execute("UPDATE operations SET state='interrupted' WHERE state NOT IN (?,?,?,?)", TERMINAL)

    def states(self):
        return dict(self.db.execute("SELECT id,state FROM operations"))

    def live(self):
        return self.pidfd is not None and not select.select([self.pidfd], [], [], 0)[0]

    def batch(self, kind, resource):
        self.db.execute("INSERT INTO batches(kind,resource) VALUES(?,?)", tuple(asdict(ChangeBatch(kind, resource)).values()))

    def receipt(self, value):
        receipt = RuntimeReceipt(**value)
        row = self.db.execute("SELECT digest,state,runtime FROM operations WHERE id=?", (receipt.operation,)).fetchone()
        if row is None or (row[0], row[2]) != (receipt.digest, receipt.runtime) or receipt.revision != "1" or receipt.outcome != "completed":
            return 409, {"error": "invalid_evidence"}
        old = self.db.execute("SELECT outcome FROM evidence WHERE operation=? AND revision=?", (receipt.operation, receipt.revision)).fetchone()
        if old and old[0] != receipt.outcome:
            return 409, {"error": "evidence_conflict"}
        if not old:
            self.db.execute("INSERT INTO evidence VALUES(?,?,?,?)", (receipt.operation, receipt.revision, receipt.outcome, int(row[1] == "interrupted")))
            if row[1] != "interrupted":
                self.db.execute("UPDATE operations SET state='completed' WHERE id=?", (receipt.operation,))
            self.batch("operation_evidence", receipt.operation)
        return 200, {"revision": receipt.revision, "state": row[1] if row[1] == "interrupted" else "completed"}

    def dispatch(self, value):
        identity = value["identity"]
        row = self.db.execute("SELECT facts,digest,state,exposure,runtime FROM operations WHERE id=?", (identity,)).fetchone()
        broken = self.cfg.get("variant") == "redispatch_interrupted"
        if row[2] in TERMINAL and not broken:
            return 409, {"error": "terminal", "state": row[2]}
        if not self.live():
            return 503, {"error": "runtime_unavailable"}
        try:
            hello = rpc(self.runtime["socket"], {"action": "hello"})
            if hello != self.runtime["hello"]:
                return 409, {"error": "runtime_mismatch"}
            if row[3] == Exposure.POSSIBLE and row[4] != hello["runtime"] and not broken:
                return 409, {"error": "different_runtime"}
            with self.db:
                self.db.execute("INSERT OR IGNORE INTO reservations VALUES(?,?)", (hello["runtime"], identity))
                if self.db.execute("SELECT count(*) FROM reservations WHERE runtime=?", (hello["runtime"],)).fetchone()[0] > CAPACITY:
                    raise ValueError("replacement capacity exceeded")
                self.db.execute("UPDATE operations SET exposure=?,runtime=? WHERE id=?", (Exposure.POSSIBLE, hello["runtime"], identity))
            if value.get("checkpoint") == "after_exposure":
                return 200, {"checkpoint": "exposure_committed"}
            reply = rpc(self.runtime["socket"], {"action": "execute", "runtime": hello["runtime"], "operation": identity,
                        "facts": row[0], "digest": row[1], "hold": value.get("checkpoint") == "after_effect"})
            if "error" in reply:
                return 409, reply
            with self.db:
                return self.receipt(reply["receipt"])
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            return 503, {"error": "channel_lost", "detail": type(exc).__name__}

    def handle(self, path, value, headers):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            current = self.db.execute("SELECT dataset FROM meta").fetchone()[0]
            if not self.db.execute("SELECT 1 FROM keys WHERE key=? AND valid=1", (headers.get("Authorization"),)).fetchone():
                return 401, {"error": "revoked_key"}
            if headers.get("Atlas-Dataset-ID") != current:
                return 409, {"error": "dataset_mismatch"}
            if headers.get("Atlas-Protocol-Version") != VERSION:
                return 409, {"error": "protocol_mismatch"}
            if path == "/dispatch":
                self.db.commit()
                return self.dispatch(value)
            if path in ("/task", "/operation"):
                identity, facts = value["identity"], value["facts"]
                UUID(identity)
                if not isinstance(facts, dict) or set(value) != {"identity", "facts"}:
                    return 400, {"error": "invalid_input"}
                original, kind = encode(facts), path[1:]
                previous = self.db.execute("SELECT facts,resource FROM retries WHERE dataset=? AND kind=? AND id=?", (current, kind, identity)).fetchone()
                if previous:
                    if previous[0] != original:
                        return 409, {"error": "facts_conflict"}
                    if self.cfg.get("variant") != "allocate_on_retry" or kind != "task":
                        return 200, {"identity": previous[1], "replayed": True}
                if kind == "task":
                    if set(facts) != {"asset", "command", "inputs"} or facts["command"] != "move_to":
                        return 400, {"error": "invalid_task"}
                    self.db.execute("INSERT INTO sequences VALUES(?,1) ON CONFLICT(asset) DO UPDATE SET value=value+1", (facts["asset"],))
                    sequence = self.db.execute("SELECT value FROM sequences WHERE asset=?", (facts["asset"],)).fetchone()[0]
                    task = Task(str(uuid4()), facts["asset"], sequence, original)
                    self.db.execute("INSERT INTO tasks VALUES(?,?,?,?,?)", tuple(asdict(task).values()))
                    resource = task.identity
                else:
                    if set(facts) != {"capability", "release", "input"}:
                        return 400, {"error": "invalid_operation"}
                    if not self.live():
                        return 503, {"error": "runtime_unavailable"}
                    runtime = self.runtime["hello"]["runtime"]
                    if self.db.execute("SELECT count(*) FROM reservations WHERE runtime=?", (runtime,)).fetchone()[0] >= CAPACITY:
                        return 429, {"error": "receipt_capacity"}
                    operation = Operation(identity, original, digest(original))
                    self.db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?)", tuple(asdict(operation).values()))
                    self.db.execute("INSERT INTO reservations VALUES(?,?)", (runtime, identity))
                    resource = identity
                retry = RetryRecord(current, kind, identity, original, resource)
                self.db.execute("INSERT OR REPLACE INTO retries VALUES(?,?,?,?,?)", tuple(asdict(retry).values()))
                self.batch(kind, resource)
                return 200, {"identity": resource, "replayed": False}
            if path == "/bind":
                hello = rpc(value["socket"], {"action": "hello"})
                if hello != value["hello"] or hello["core_run"] != self.run or hello["dataset"] != current:
                    return 409, {"error": "runtime_mismatch"}
                pinned = os.pidfd_open(hello["pid"])
                if select.select([pinned], [], [], 0)[0]:
                    os.close(pinned)
                    return 409, {"error": "runtime_dead"}
                self.db.execute("""INSERT OR IGNORE INTO reservations
                                   SELECT ?,id FROM operations
                                   WHERE exposure=? AND state NOT IN (?,?,?,?)""", (hello["runtime"], Exposure.NEVER, *TERMINAL))
                if self.pidfd is not None:
                    os.close(self.pidfd)
                self.runtime, self.pidfd = value, pinned
                return 200, {"runtime": hello["runtime"]}
            if path == "/recover":
                if not self.live():
                    self.db.execute("UPDATE operations SET state='interrupted' WHERE exposure=? AND state NOT IN (?,?,?,?)", (Exposure.POSSIBLE, *TERMINAL))
                return 200, {"runtime": "live" if self.live() else "dead", "states": self.states()}
            if path == "/evidence":
                return self.receipt(value)
            if path == "/revoke":
                self.db.execute("UPDATE keys SET valid=0 WHERE key=?", (value["key"],))
                return 200, {"revoked": True}
            if path == "/reset_identity":
                for table in ("tasks", "sequences", "retries", "batches", "operations", "reservations", "evidence", "reports", "watermarks", "movement"):
                    self.db.execute(f"DELETE FROM {table}")
                self.db.execute("UPDATE meta SET dataset=?", (value["dataset"],))
                return 200, {"reset": True}
            if path == "/asset_report":
                facts = {k: v for k, v in value.items() if k not in ("gateway", "packet")}
                source = facts["asset"] + "/" + facts["process"]
                if self.cfg.get("variant") == "gateway_dedup":
                    source += "/" + value["gateway"]
                stream, sequence = facts["stream"], int(facts["sequence"])
                if str(sequence) != facts["sequence"] or not 0 < sequence < 2**63:
                    return 400, {"error": "invalid_sequence"}
                old = self.db.execute("SELECT facts FROM reports WHERE source=? AND stream=? AND sequence=?", (source, stream, sequence)).fetchone()
                if old:
                    return (200, {"classification": "duplicate"}) if old[0] == encode(facts) else (409, {"error": "facts_conflict"})
                order = "*" if self.cfg.get("variant") == "global_watermark" else stream
                last = self.db.execute("SELECT sequence FROM watermarks WHERE source=? AND stream=?", (source, order)).fetchone()
                if last and sequence <= last[0]:
                    return 409, {"error": "stale"}
                self.db.execute("INSERT INTO reports VALUES(?,?,?,?)", (source, stream, sequence, encode(facts)))
                self.db.execute("INSERT OR REPLACE INTO watermarks VALUES(?,?,?)", (source, order, sequence))
                if stream == "telemetry":
                    self.db.execute("INSERT INTO movement VALUES(?,?,?)", (source, sequence, encode(facts["position"])))
                else:
                    self.db.execute("UPDATE tasks SET state='completed' WHERE id=?", (facts["task"],))
                self.batch("report", source)
                return 200, {"classification": "accepted"}
            return 404, {"error": "unknown_route"}
        except BaseException:
            self.db.rollback()
            raise
        finally:
            if self.db.in_transaction:
                self.db.commit()

def serve(kind, cfg, control):
    core = Core(cfg) if kind == "core" else None
    receipts = database(cfg["receipts"]) if kind == "plugin" else None
    if receipts is not None:
        receipts.execute("CREATE TABLE receipts(operation TEXT PRIMARY KEY,digest TEXT,runtime TEXT,revision TEXT,outcome TEXT)")
        receipts.commit()
    hello = {"runtime": cfg.get("runtime"), "core_run": cfg.get("core_run"), "dataset": DATASET, "pid": os.getpid()}

    def local(value):
        if kind == "effects":
            with open(cfg["log"], "ab", buffering=0) as log:
                log.write((encode(value) + "\n").encode())
                os.fsync(log.fileno())
            return {"recorded": True}
        if value["action"] == "hello":
            return hello
        if value.get("runtime") != hello["runtime"]:
            return {"error": "runtime_mismatch"}
        identity = value["operation"]
        previous = receipts.execute("SELECT * FROM receipts WHERE operation=?", (identity,)).fetchone()
        if value["action"] == "ack":
            if previous is None or value.get("revision") != previous[3]:
                return {"error": "ack_revision_mismatch"}
            if cfg.get("variant") == "evict_ack":
                with receipts:
                    receipts.execute("DELETE FROM receipts WHERE operation=?", (identity,))
            return {"acknowledged": "1"}
        if digest(value["facts"]) != value["digest"] or previous and previous[1] != value["digest"]:
            return {"error": "input_conflict"}
        if previous:
            return {"receipt": asdict(RuntimeReceipt(*previous))}
        if receipts.execute("SELECT count(*) FROM receipts").fetchone()[0] >= CAPACITY:
            return {"error": "receipt_capacity"}
        receipt = RuntimeReceipt(identity, value["digest"], hello["runtime"], "1", "completed")
        with receipts:
            receipts.execute("INSERT INTO receipts VALUES(?,?,?,?,?)", (identity, value["digest"], hello["runtime"], "0", "reserved"))
        rpc(cfg["effects"], {"operation": identity, "runtime": hello["runtime"], "digest": value["digest"]})
        with receipts:
            receipts.execute("UPDATE receipts SET revision='1',outcome='completed' WHERE operation=?", (identity,))
        if value.get("hold"):
            control.send({"checkpoint": "effect_and_evidence_durable", "operation": identity})
            if not control.poll(DEADLINE) or control.recv() != "release":
                raise TimeoutError("effect checkpoint release required")
        return {"receipt": asdict(receipt)}

    class UnixHandler(socketserver.StreamRequestHandler):
        def handle(self):
            self.connection.settimeout(DEADLINE)
            raw = self.rfile.readline(LIMIT + 1)
            if len(raw) > LIMIT or not raw.endswith(b"\n"):
                raise ValueError("bounded RPC required")
            self.wfile.write((encode(local(json.loads(raw))) + "\n").encode())

    class HTTPHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            self.connection.settimeout(DEADLINE)
            size = int(self.headers.get("Content-Length", "-1"))
            if not 0 <= size <= LIMIT:
                self.send_error(413)
                return
            status, data = core.handle(self.path, json.loads(self.rfile.read(size)), self.headers)
            if self.headers.get("X-Lab-Fault") == "drop" and status == 200:
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            dataset = core.db.execute("SELECT dataset FROM meta").fetchone()[0]
            body = encode({"dataset_id": dataset, "data": data}).encode()
            if self.headers.get("X-Lab-Fault") == "corrupt" and status == 200:
                body = b"{"
            self.send_response(status)
            for key, val in (("Content-Type", "application/json"), ("Content-Length", str(len(body))),
                             ("Atlas-Dataset-ID", dataset), ("Atlas-Protocol-Version", VERSION)):
                self.send_header(key, val)
            self.end_headers()
            self.wfile.write(body)

    def listener():
        if kind == "core":
            return HTTPServer(("127.0.0.1", 0), HTTPHandler)
        Path(cfg["socket"]).unlink(missing_ok=True)
        return socketserver.UnixStreamServer(cfg["socket"], UnixHandler)

    server = listener()
    control.send({"port": server.server_address[1], "core_run": core.run,
                  "wal": core.db.execute("PRAGMA journal_mode").fetchone()[0],
                  "synchronous": core.db.execute("PRAGMA synchronous").fetchone()[0]} if core else {"hello": hello})
    try:
        while True:
            ready = select.select([control] + ([server] if server else []), [], [], DEADLINE)[0]
            if control in ready:
                command = control.recv()
                if command == "stop":
                    break
                if command == "pause":
                    server.server_close()
                    server = None
                if command == "resume":
                    server = listener()
                control.send({"channel": command})
            elif server and server in ready:
                server.handle_request()
    finally:
        if server:
            server.server_close()
        if core:
            if core.pidfd is not None:
                os.close(core.pidfd)
            core.db.close()
        if receipts is not None:
            receipts.close()

class Lab:
    def __init__(self):
        self.root, self.children = Path(tempfile.mkdtemp(prefix="atlas-retry-")), []

    def start(self, kind, cfg):
        parent, child = mp.get_context("spawn").Pipe()
        process = mp.get_context("spawn").Process(target=serve, args=(kind, cfg, child))
        process.start()
        child.close()
        handle = {"process": process, "control": parent, "cfg": cfg, "killed": False}
        self.children.append(handle)
        handle.update(self.message(handle))
        return handle

    def message(self, handle):
        if not handle["control"].poll(DEADLINE):
            raise TimeoutError("child barrier deadline")
        return handle["control"].recv()

    def stop(self, handle, kill=False):
        process = handle["process"]
        if process.is_alive():
            if kill:
                handle["killed"] = True
                process.kill()
            else:
                handle["control"].send("stop")
            process.join(DEADLINE)
        if process.is_alive():
            process.kill()
            process.join(DEADLINE)
            raise RuntimeError("child failed bounded shutdown")
        if process.exitcode != 0 and not handle["killed"]:
            raise RuntimeError(f"unexpected child exit {process.exitcode}")

    def core(self, name, variant="", db=None):
        directory = self.root / name
        directory.mkdir(exist_ok=True)
        return self.start("core", {"db": str(db or directory / "core.sqlite"), "variant": variant})

    def plugin(self, name, core, effects, variant=""):
        cfg = {"socket": str(self.root / (name + ".sock")), "receipts": str(self.root / (name + ".sqlite")),
               "effects": effects["cfg"]["socket"], "runtime": str(uuid4()), "core_run": core["core_run"], "variant": variant}
        plugin = self.start("plugin", cfg)
        status, _ = call(core, "/bind", {"socket": cfg["socket"], "hello": plugin["hello"]})
        if status != 200:
            raise RuntimeError("runtime bind failed")
        return plugin

    def close(self):
        errors = []
        for handle in reversed(self.children):
            try:
                self.stop(handle)
                handle["control"].close()
            except BaseException as exc:
                errors.append(str(exc))
        if errors:
            raise RuntimeError("; ".join(errors) + "; own state retained at " + str(self.root))
        shutil.rmtree(self.root)
        if self.root.exists():
            raise RuntimeError("temporary state survived cleanup")

def call(core, path, value, dataset=DATASET, key="key-a", fault=""):
    connection = http.client.HTTPConnection("127.0.0.1", core["port"], timeout=DEADLINE + 1)
    try:
        connection.request("POST", path, encode(value), {"Authorization": key, "Atlas-Dataset-ID": dataset,
                           "Atlas-Protocol-Version": VERSION, "Content-Type": "application/json", "X-Lab-Fault": fault})
        response = connection.getresponse()
        raw = response.read(LIMIT + 1)
        body = json.loads(raw)
        if len(raw) > LIMIT or response.getheader("Content-Type") != "application/json" or response.getheader("Atlas-Protocol-Version") != VERSION or response.getheader("Atlas-Dataset-ID") != body["dataset_id"]:
            raise ValueError("invalid response context")
        actual_expected = value["dataset"] if path == "/reset_identity" else dataset
        if body["dataset_id"] != actual_expected and body["data"].get("error") != "dataset_mismatch":
            raise ValueError("unexpected Dataset")
        return response.status, body["data"]
    finally:
        connection.close()

def submit(core, prepared, key="key-a", fault="", variant=""):
    try:
        status, result = call(core, "/" + prepared.kind, {"identity": prepared.identity, "facts": json.loads(prepared.original_facts)}, prepared.dataset, key, fault)
        if status == 200 and set(result) == {"identity", "replayed"} and isinstance(result["replayed"], bool):
            UUID(result["identity"])
            return "accepted", result
        if result.get("error") == "dataset_mismatch":
            return "dataset_invalidated", result
        return ("rejected" if status in (400, 401, 409, 429, 503) and "error" in result else "unknown_outcome"), result
    except (OSError, http.client.HTTPException, ValueError, KeyError):
        return ("rejected" if variant == "transport_rejected" else "unknown_outcome"), None

def task_signature(core):
    path = core["cfg"]["db"]
    return [read_sql(path, "SELECT count(*) FROM tasks")[0][0], read_sql(path, "SELECT coalesce(max(value),0) FROM sequences")[0][0], read_sql(path, "SELECT count(*) FROM batches WHERE kind='task'")[0][0]]

def run(lab, case, findings):
    prepared = PreparedRequest(DATASET, uid("task-request"), encode({"asset": uid("asset"), "command": "move_to", "inputs": {"lat": 12, "lon": 34}}))
    core = lab.core("retry")
    case("Core writer uses WAL and FULL", ["wal", 2], [core["wal"], core["synchronous"]])
    case("reply dropped after commit remains unknown", "unknown_outcome", submit(core, prepared, fault="drop")[0])
    retained = read_sql(core["cfg"]["db"], "SELECT id,sequence,facts FROM tasks")
    case("independent SQL sees one Task, sequence and batch", [1, 1, 1], task_signature(core))
    case("retry facts retained with resource and batch", [(DATASET, "task", prepared.identity, prepared.original_facts, retained[0][0])], read_sql(core["cfg"]["db"], "SELECT * FROM retries"))
    case("Task contains submitted facts", [(1, prepared.original_facts)], [(row[1], row[2]) for row in retained])
    lab.stop(core, kill=True)
    core = lab.core("retry-restarted", db=core["cfg"]["db"])
    outcome, response = submit(core, prepared)
    case("exact retry after Core death recovers original Task", ("accepted", retained[0][0], True), (outcome, response["identity"], response["replayed"]))
    case("retry after restart allocates nothing", [1, 1, 1], task_signature(core))
    case("malformed reply after committed replay stays unknown", "unknown_outcome", submit(core, prepared, fault="corrupt")[0])
    changed = PreparedRequest(DATASET, prepared.identity, prepared.original_facts.replace('"lat":12', '"lat":13'))
    case("changed original facts conflict", ("rejected", {"error": "facts_conflict"}), submit(core, changed))
    call(core, "/revoke", {"key": "key-a"}, key="key-b")
    case("revoked key cannot recover committed retry", ("rejected", {"error": "revoked_key"}), submit(core, prepared))
    case("current authorization can recover same identity", "accepted", submit(core, prepared, key="key-b")[0])
    call(core, "/reset_identity", {"dataset": uid("new-dataset")}, key="key-b")
    case("old prepared Dataset is refused", "dataset_invalidated", submit(core, prepared, key="key-b")[0])
    for variant in ("allocate_on_retry", "transport_rejected"):
        broken = lab.core(variant, variant)
        outcome, _ = submit(broken, prepared, fault="drop", variant=variant)
        submit(broken, prepared)
        observed = task_signature(broken) if variant == "allocate_on_retry" else outcome
        correct = [1, 1, 1] if variant == "allocate_on_retry" else "unknown_outcome"
        expected_bad = [2, 2, 2] if variant == "allocate_on_retry" else "rejected"
        case("BROKEN " + variant + " detected by same oracle", {"oracle_accepts": False, "result": expected_bad},
             {"oracle_accepts": observed == correct, "result": observed})
    effects = lab.start("effects", {"socket": str(lab.root / "effects.sock"), "log": str(lab.root / "effects.jsonl")})

    def count(identity):
        path = Path(effects["cfg"]["log"])
        return sum(json.loads(line)["operation"] == identity for line in path.read_text().splitlines()) if path.exists() else 0

    def admit(core, name):
        request = PreparedRequest(DATASET, uid(name), encode({"capability": "record", "release": "lab-1", "input": {"name": name}}), "operation")
        outcome, _ = submit(core, request)
        if outcome != "accepted":
            raise RuntimeError("fixture admission failed " + name)
        return request

    core = lab.core("receipts")
    plugin = lab.plugin("receipts-plugin", core, effects)
    request = admit(core, "once")
    call(core, "/dispatch", {"identity": request.identity})
    wire = {"action": "execute", "runtime": plugin["hello"]["runtime"], "operation": request.identity, "facts": request.original_facts, "digest": digest(request.original_facts)}
    receipt = rpc(plugin["cfg"]["socket"], wire)
    case("same live runtime redelivery returns retained receipt", "completed", receipt["receipt"]["outcome"])
    case("independent recorder sees one external effect", 1, count(request.identity))
    conflict = dict(wire, facts=encode({"changed": True}), digest=digest(encode({"changed": True})))
    case("same identity with changed input conflicts at Plugin", {"error": "input_conflict"}, rpc(plugin["cfg"]["socket"], conflict))
    channel_request = admit(core, "channel")
    call(core, "/dispatch", {"identity": channel_request.identity, "checkpoint": "after_exposure"})
    plugin["control"].send("pause")
    lab.message(plugin)
    case("actual channel loss while runtime lives", "channel_lost", call(core, "/dispatch", {"identity": channel_request.identity})[1]["error"])
    case("verified live runtime keeps possibly exposed work pending", "pending", call(core, "/recover", {})[1]["states"][uid("channel")])
    plugin["control"].send("resume")
    lab.message(plugin)
    call(core, "/dispatch", {"identity": uid("channel")})
    for identity in (request.identity, channel_request.identity):
        rpc(plugin["cfg"]["socket"], {"action": "ack", "runtime": plugin["hello"]["runtime"], "operation": identity, "revision": "1"})
    case("full runtime refuses fresh admission", ("rejected", {"error": "receipt_capacity"}), submit(core, PreparedRequest(DATASET, uid("overflow"), request.original_facts, "operation")))
    case("Plugin also refuses fresh receipt at capacity", {"error": "receipt_capacity"}, rpc(plugin["cfg"]["socket"], dict(wire, operation=uid("overflow"))))
    case("capacity preserves two acknowledged receipts", 2, read_sql(plugin["cfg"]["receipts"], "SELECT count(*) FROM receipts")[0][0])
    case("capacity refusal allocates no extra Operation or reservation", [2, 2], [read_sql(core["cfg"]["db"], "SELECT count(*) FROM " + table)[0][0] for table in ("operations", "reservations")])
    case("capacity leaves exact retry usable", "accepted", submit(core, request)[0])
    case("capacity leaves terminal evidence usable", 200, call(core, "/evidence", receipt["receipt"])[0])
    rpc(plugin["cfg"]["socket"], wire)
    case("capacity and acknowledgment preserve effect protection", 1, count(request.identity))
    lab.stop(plugin, kill=True)
    case("exact committed retry resolves before availability", "accepted", submit(core, request)[0])
    replacement = lab.plugin("capacity-replacement", core, effects)
    fresh = admit(core, "capacity-fresh")
    call(core, "/dispatch", {"identity": fresh.identity})
    case("manual runtime replacement restores capacity without replaying old effects", [2, 1, 1, 1], [read_sql(plugin["cfg"]["receipts"], "SELECT count(*) FROM receipts")[0][0], read_sql(replacement["cfg"]["receipts"], "SELECT count(*) FROM receipts")[0][0], count(request.identity), count(fresh.identity)])

    for variant in ("", "redispatch_interrupted"):
        core = lab.core("loss-" + variant, variant)
        plugin = lab.plugin("loss-plugin-" + variant, core, effects)
        never, possible = admit(core, "never-" + variant), admit(core, "possible-" + variant)
        call(core, "/dispatch", {"identity": possible.identity, "checkpoint": "after_exposure"})
        lab.stop(plugin, kill=True)
        states = call(core, "/recover", {})[1]["states"]
        case("runtime death preserves never exposure and interrupts possible " + variant,
             {never.identity: "pending", possible.identity: "interrupted"}, states)
        plugin = lab.plugin("replacement-" + variant, core, effects)
        if not variant:
            fresh = admit(core, "replacement-fresh")
            overflow = PreparedRequest(DATASET, uid("replacement-overflow"), fresh.original_facts, "operation")
            case("replacement capacity includes carried never-exposed work", ("rejected", {"error": "receipt_capacity"}), submit(core, overflow))
            case("replacement capacity leaves carried exact retry usable", ("accepted", {"identity": never.identity, "replayed": True}), submit(core, never))
            case("replacement executes reserved carried and fresh Operations", [(200, {"revision": "1", "state": "completed"})] * 2,
                 [call(core, "/dispatch", {"identity": request.identity}) for request in (never, fresh)])
            case("replacement fresh Operation records one external effect", 1, count(fresh.identity))
            case("replacement retains both completed receipts", 2, read_sql(plugin["cfg"]["receipts"], "SELECT count(*) FROM receipts WHERE outcome='completed'")[0][0])
            case("completed replacement receipts still consume admission capacity", ("rejected", {"error": "receipt_capacity"}),
                 submit(core, PreparedRequest(DATASET, uid("replacement-after-completion"), fresh.original_facts, "operation")))
        else:
            call(core, "/dispatch", {"identity": never.identity})
        call(core, "/dispatch", {"identity": possible.identity})
        if variant:
            effect_count = count(possible.identity)
            case("BROKEN uncertain redispatch caught by effect oracle", {"oracle_accepts": False, "effects": 1},
                 {"oracle_accepts": effect_count == 0, "effects": effect_count})
        else:
            case("only never-exposed work gets first dispatch after replacement", [1, 0], [count(never.identity), count(possible.identity)])

    core = lab.core("effect-loss")
    plugin = lab.plugin("effect-loss-plugin", core, effects)
    request = admit(core, "effect-before-death")
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(call, core, "/dispatch", {"identity": request.identity, "checkpoint": "after_effect"})
        case("barrier proves effect and terminal evidence preceded death", "effect_and_evidence_durable", lab.message(plugin)["checkpoint"])
        lab.stop(plugin, kill=True)
        case("runtime death before reporting leaves channel uncertainty", 503, pending.result(timeout=DEADLINE + 2)[0])
    call(core, "/recover", {})
    rows = read_sql(plugin["cfg"]["receipts"], "SELECT * FROM receipts WHERE operation=?", (request.identity,))
    call(core, "/evidence", asdict(RuntimeReceipt(*rows[0])))
    case("recovered known effect stays separate from interrupted state", [("interrupted", "completed", 1)], read_sql(core["cfg"]["db"], "SELECT o.state,e.outcome,e.recovered FROM operations o JOIN evidence e ON e.operation=o.id"))
    case("effect before process death remains in independent log", 1, count(request.identity))
    lab.plugin("effect-replacement", core, effects)
    case("interrupted known effect cannot execute on replacement", 409, call(core, "/dispatch", {"identity": request.identity})[0])
    case("replacement preserves the one recorded effect", 1, count(request.identity))

    core = lab.core("whole-restart")
    plugin = lab.plugin("whole-plugin", core, effects)
    never, possible = admit(core, "whole-never"), admit(core, "whole-possible")
    call(core, "/dispatch", {"identity": possible.identity, "checkpoint": "after_exposure"})
    lab.stop(core, kill=True)
    core = lab.core("whole-restarted", db=core["cfg"]["db"])
    case("old live runtime cannot bind to new Core run", 409, call(core, "/bind", {"socket": plugin["cfg"]["socket"], "hello": plugin["hello"]})[0])
    lab.stop(plugin, kill=True)
    plugin = lab.plugin("whole-new-plugin", core, effects)
    for request in (never, possible):
        case("whole Core restart interrupts " + request.identity, [("interrupted",)], read_sql(core["cfg"]["db"], "SELECT state FROM operations WHERE id=?", (request.identity,)))
        case("whole restart blocks new execution " + request.identity, 409, call(core, "/dispatch", {"identity": request.identity})[0])
        case("whole restart has no invented effects " + request.identity, 0, count(request.identity))

    core = lab.core("evict", "")
    plugin = lab.plugin("evict-plugin", core, effects, "evict_ack")
    request = admit(core, "evicted")
    call(core, "/dispatch", {"identity": request.identity})
    rpc(plugin["cfg"]["socket"], {"action": "ack", "runtime": plugin["hello"]["runtime"], "operation": request.identity, "revision": "1"})
    rpc(plugin["cfg"]["socket"], {"action": "execute", "runtime": plugin["hello"]["runtime"], "operation": request.identity, "facts": request.original_facts, "digest": digest(request.original_facts)})
    effect_count = count(request.identity)
    case("BROKEN receipt eviction caught by same external effect oracle", {"oracle_accepts": False, "effects": 2},
         {"oracle_accepts": effect_count == 1, "effects": effect_count})

    for variant in ("", "gateway_dedup", "global_watermark"):
        core = lab.core("reports-" + variant, variant)
        _, created = submit(core, prepared)
        telemetry = {"asset": uid("asset"), "process": uid("asset-process"), "stream": "telemetry", "sequence": "20", "position": [12, 34], "gateway": "one", "packet": "first"}
        earlier = {"asset": uid("asset"), "process": uid("asset-process"), "stream": "task/" + created["identity"], "sequence": "3", "task": created["identity"], "gateway": "one", "packet": "earlier"}
        call(core, "/asset_report", telemetry)
        task_report = call(core, "/asset_report", earlier)[1]
        relay = call(core, "/asset_report", dict(telemetry, gateway="two", packet="repacked"), key="key-b")[1]
        observed = [task_report.get("classification"), relay.get("classification"), read_sql(core["cfg"]["db"], "SELECT count(*) FROM movement")[0][0], read_sql(core["cfg"]["db"], "SELECT state FROM tasks")[0][0], read_sql(core["cfg"]["db"], "SELECT count(*) FROM batches")[0][0]]
        expected = ["accepted", "duplicate", 1, "completed", 3]
        if variant:
            expected_bad = {"gateway_dedup": ["accepted", "accepted", 2, "completed", 4],
                            "global_watermark": [None, "duplicate", 1, "pending", 2]}[variant]
            case("BROKEN " + variant + " caught by report SQL oracle", {"oracle_accepts": False, "result": expected_bad},
                 {"oracle_accepts": observed == expected, "result": observed})
        else:
            case("earlier unseen Task outcome and cross-gateway dedup survive", expected, observed)
    findings.extend([
        "Measured lost post-commit HTTP replies and malformed replies remain unknown; exact retained retries allocate one Task, sequence and batch.",
        "Measured pidfd-pinned live runtime survives channel loss; confirmed death interrupts only possibly exposed work; whole-Core death interrupts both exposure classes.",
        "Measured runtime receipts prevent repeat effects, survive acknowledgment and remain at capacity; interrupted known effects retain separate recovered evidence.",
        "Measured source-scoped dedup and per-stream ordering retain earlier unseen Task completion after newer telemetry.",
        "Six intentionally broken alternatives were detected by unchanged outcome, SQL and external-effect oracles. Expected detections pass.",
    ])

def main():
    cases, findings = [], []

    def case(name, expected, observed, **extra):
        cases.append({"name": name, "expected": expected, "observed": observed, "passed": expected == observed, **extra})

    lab = Lab()
    try:
        run(lab, case, findings)
    except BaseException as exc:
        cases.append({"name": "unexpected experiment failure", "expected": "all scenarios observed", "observed": f"{type(exc).__name__}: {exc}", "passed": False})
    finally:
        try:
            lab.close()
            case("all owned children exited before temporary state removal", {"live_children": 0, "storage_exists": False},
                 {"live_children": sum(handle["process"].is_alive() for handle in lab.children), "storage_exists": lab.root.exists()})
        except BaseException as exc:
            case("cleanup failure", "all owned children exited and own state removed", str(exc))
    result = {"experiment": "retry", "cases": cases, "findings": findings, "limitations": [
        "Throwaway Python stdlib HTTP/Unix/SQLite experiment, not Go, SDK, Docker or Protocol conformance. No TLS, full schema validation, radio, disk/power-loss or production-load qualification.",
        "Runtime continuity assumes a trusted test manager supplying a pidfd-pinned PID and random runtime token. Private dispatch is synchronous Unix RPC, not the specified Plugin-initiated long polling.",
        "Reset exercises only the Dataset identity boundary. Full Reset, runtime handshake, terminal-evidence transport and recovered-outcome wire representation are unimplemented assumptions.",
        "Operation cancellation and its races remain unimplemented and unresolved. Capacity checks cover retries, reporting and retained receipts, not cancellation.",
        "External effects and Plugin receipts cannot share a transaction. Exactly-once external effects are not promised. Report fixtures omit process replacement, contact proofs, full section replacement and deletion rules.",
        "Finite scheduled faults cover post-commit response loss, pre-delivery exposure and effect-before-report death. They do not enumerate every instruction-level crash or concurrent admission schedule.",
    ]}
    print(encode(result))
    return int(any(not item["passed"] for item in cases))

if __name__ == "__main__":
    sys.exit(main())
