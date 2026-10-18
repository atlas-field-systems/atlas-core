#!/usr/bin/env python3
"""Run disposable Atlas experiments and retain their original output."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import selectors
import signal
import subprocess
import sys
import tempfile
import time


CASE_MANIFEST = json.loads(Path(__file__).with_name("case-manifest.json").read_text())


def json_equal(expected, observed):
    if type(expected) in (int, float) and type(observed) in (int, float):
        return (
            (type(expected) is int or math.isfinite(expected))
            and (type(observed) is int or math.isfinite(observed))
            and expected == observed
        )
    if type(expected) is not type(observed):
        return False
    if isinstance(expected, dict):
        return expected.keys() == observed.keys() and all(
            json_equal(value, observed[key]) for key, value in expected.items()
        )
    if isinstance(expected, list):
        return len(expected) == len(observed) and all(
            json_equal(left, right) for left, right in zip(expected, observed)
        )
    return type(expected) in (type(None), str, bool) and expected == observed


def validate_observation(value, experiment):
    if not isinstance(value, dict) or value.get("experiment") != experiment:
        raise ValueError("missing or mismatched experiment name")
    cases = value.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("no observed cases")
    names = set()
    for case in cases:
        if not isinstance(case, dict) or not isinstance(case.get("name"), str):
            raise ValueError("invalid case")
        if case["name"] in names:
            raise ValueError("duplicate case name")
        names.add(case["name"])
        if "expected" not in case or "observed" not in case:
            raise ValueError("case lacks evidence")
        if case.get("passed") is not True or not json_equal(case["expected"], case["observed"]):
            raise ValueError("unexpected failed case: " + case["name"])
    expected_names = set(CASE_MANIFEST[experiment])
    if names != expected_names:
        raise ValueError(
            f"case manifest mismatch: missing {sorted(expected_names - names)}, "
            f"unexpected {sorted(names - expected_names)}"
        )
    for key in ("findings", "limitations"):
        if not isinstance(value.get(key), list):
            raise ValueError("missing " + key)
    return len(cases)


def run_one(name, command, output):
    stdout = output / (name + ".stdout.json")
    stderr = output / (name + ".stderr.txt")
    result = {"experiment": name, "command": command, "status": "FAIL"}
    with stdout.open("wb") as out, stderr.open("wb") as err, selectors.DefaultSelector() as selector:
        deadline = time.monotonic() + 120
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, bufsize=0,
        )
        with process.stdout, process.stderr:
            try:
                selector.register(process.stdout, selectors.EVENT_READ, ("stdout", out))
                selector.register(process.stderr, selectors.EVENT_READ, ("stderr", err))
                while selector.get_map() or process.poll() is None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ValueError("experiment exceeded 120 seconds")
                    if "exit_code" not in result and process.poll() is not None:
                        result["exit_code"] = process.returncode
                        # Descendants may hold pipes open after the leader exits.
                        # Stop them now, then retain bytes already in the pipes.
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    for key, _ in selector.select(timeout=min(0.1, remaining)):
                        label, log = key.data
                        available = 8 * 1024 * 1024 - log.tell()
                        chunk = os.read(key.fd, min(64 * 1024, available + 1))
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        log.write(chunk[:available])
                        if len(chunk) > available:
                            raise ValueError(label + " exceeds 8 MiB")
            except (ValueError, OSError) as error:
                result["error"] = str(error)
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except OSError as error:
                    result.setdefault("cleanup_errors", []).append(str(error))
                    result.setdefault("error", "failed to stop experiment process group")
                result["exit_code"] = process.wait()
                for label, log in (("stdout", out), ("stderr", err)):
                    try:
                        log.close()
                    except OSError as error:
                        result.setdefault("cleanup_errors", []).append(label + ": " + str(error))
                        result.setdefault("error", "failed to close experiment logs")
    if "error" not in result:
        try:
            observation = json.loads(stdout.read_text(encoding="utf-8"))
            result["cases"] = validate_observation(observation, name)
            if result["exit_code"] == 0:
                result["status"] = "PASS"
            else:
                result["error"] = "experiment exited unsuccessfully"
        except (ValueError, OSError) as error:
            result["error"] = str(error)
    print(name + " " + result["status"] + " " + str(result.get("cases", 0)) + " cases", flush=True)
    return result


def main():
    base = Path(__file__).resolve().parent
    commands = {
        "retry": [sys.executable, str(base / "retry" / "experiment.py")],
        "sync": ["node", str(base / "sync" / "experiment.mjs")],
        "storage": [sys.executable, str(base / "storage" / "experiment.py")],
        "wire": [sys.executable, str(base / "wire" / "experiment.py")],
    }
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("experiments", nargs="*", help="retry, sync, storage, wire; default all")
    parser.add_argument("--out", type=Path, help="new directory for raw evidence")
    args = parser.parse_args()
    selected = args.experiments or list(commands)
    if any(name not in commands for name in selected) or len(set(selected)) != len(selected):
        parser.error("choose distinct experiment names from " + ", ".join(commands))
    if args.out:
        output = args.out.resolve()
        output.mkdir(parents=True, exist_ok=False)
    else:
        output = Path(tempfile.mkdtemp(prefix="atlas-flight-results-"))
    files = sorted([*base.rglob("*.py"), *base.rglob("*.mjs"), base / "case-manifest.json"])
    metadata = {
        "python": sys.version,
        "node": subprocess.check_output(["node", "--version"], text=True).strip(),
        "platform": platform.platform(),
        "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=base, text=True).strip(),
        "source_sha256": {str(path.relative_to(base)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files},
        "qualification": "Disposable mechanism prototypes, not an Atlas implementation.",
    }
    (output / "environment.json").write_text(json.dumps(metadata, indent=2) + "\n")
    results = []
    for name in selected:
        try:
            result = run_one(name, commands[name], output)
        except OSError as error:
            result = {"experiment": name, "status": "FAIL", "error": str(error)}
        results.append(result)
        (output / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
    print("Evidence " + str(output), flush=True)
    return 0 if all(result["status"] == "PASS" for result in results) else 1


if __name__ == "__main__":
    sys.exit(main())
