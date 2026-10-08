#!/usr/bin/env python3
"""Verify the contract foundation and focused Plugin bookkeeping component."""

import argparse
import hashlib
import json
import os
import shutil
from contextlib import contextmanager

from command_checks import check_command_lifetime
from generate import OUTPUTS, generate
from plugin_checks import check_plugin_fixture_lifetime
from toolchain import LOCK, ROOT, prepare, run
from toolchain_checks import check_toolchain_refusals
from verification_checks import check_fresh_go_tests


def snapshot():
    return {
        str(path.relative_to(ROOT)): path.read_bytes()
        for directory in OUTPUTS
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    }


@contextmanager
def check(passed, name):
    """Record `name` in the evidence report only after its block succeeds."""
    yield
    passed.append(name)


def _test_go(go, env, *, cwd, capture=False):
    # Shared fixture inputs outside the Go module are not covered by its result cache.
    return run([go, "test", "-count=1", "./..."], env, cwd=cwd, capture=capture)


def verify(bootstrap):
    artifacts = ROOT / ".artifacts"
    artifacts.mkdir(exist_ok=True)
    # Never leave a previous passing report after a failed verification.
    report = artifacts / "verification.json"
    report.unlink(missing_ok=True)
    passed = []
    sdk, core = ROOT / "Atlas SDK", ROOT / "Atlas Core"
    with check(passed, "bootstrap checksum/version refusal"):
        check_toolchain_refusals()
    with check(passed, "locked dependencies and tool versions"):
        env, go, sqlc, ruff = prepare(bootstrap)
        run(["npm", "ci", "--ignore-scripts"], env, cwd=sdk)
        for module in [core, ROOT / "Atlas Protocol/tools"]:
            run([go, "mod", "verify"], env, cwd=module)
    with check(passed, "two clean generations"):
        generate(env, go, sqlc)
        first = snapshot()
        if not first:
            raise RuntimeError("generation produced no artifacts")
        generate(env, go, sqlc)
        if snapshot() != first:
            raise RuntimeError("two clean generations changed output")
        print(f"PASS clean deterministic generation: {len(first)} files match byte for byte", flush=True)
    with check(passed, "fresh Go execution after external corpus changes"):
        check_fresh_go_tests(go, env, _test_go)
    with check(passed, "Go format/build/test/vet"):
        formatted = run([go.parent / "gofmt", "-l", *sorted(core.rglob("*.go"))], env, capture=True)
        if formatted:
            raise RuntimeError(f"Go formatting mismatch: {formatted}")
        run([go, "build", "./..."], env, cwd=core)
        _test_go(go, env, cwd=core)
        run([go, "vet", "./..."], env, cwd=core)
        run([go, "build", "-o", artifacts / "contract-fixture", "./tests/contractfixture"], env, cwd=core)
    with check(passed, "verifier command deadline, interruption and detached-descendant cleanup"):
        check_command_lifetime()
    with check(passed, "Plugin bookkeeping race and real-process recovery workflows"):
        run(
            [go, "test", "-race", "-count=1", "./plugins/...", "./pluginruntime/...", "./plugindispatch/..."],
            env,
            cwd=core,
            timeout=300,
        )
    with check(passed, "Plugin fixture cleanup after worker death, deadline and interruption"):
        check_plugin_fixture_lifetime(go, env)
    with check(passed, "TypeScript structural lint and independent rule probes"):
        run(["npm", "run", "lint"], env, cwd=sdk)
    with check(passed, "TypeScript/JavaScript formatting"):
        run(["npm", "run", "format:check"], env, cwd=sdk)
    with check(passed, "Python formatting and lint"):
        run([ruff, "format", "--check"], env, cwd=ROOT)
        run([ruff, "check"], env, cwd=ROOT)
    with check(passed, "strict TypeScript and SDK build"):
        run(["npm", "run", "check"], env, cwd=sdk)
        if (sdk / "dist").exists():
            shutil.rmtree(sdk / "dist")
        run(["npm", "run", "build"], env, cwd=sdk)
    with check(passed, "ordinary Node package exports and consumer declarations"):
        # Consumer exports resolve only built JS/declarations, absent before this build.
        run(["npm", "run", "check:consumer"], env, cwd=sdk)
    with check(passed, "SDK consumer artifact isolation"):
        package = json.loads(
            run(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], env, cwd=sdk, capture=True)
        )
        for file in package[0]["files"]:
            name = file["path"]
            if name not in {"README.md", "package.json"} and not name.startswith("dist/"):
                raise RuntimeError(f"unexpected SDK consumer package artifact: {name}")
        print("PASS SDK consumer package excludes fixture tooling", flush=True)
    with check(passed, "generated transport/direct Protocol workflows and fixture cleanup"):
        run(["npm", "test"], env, cwd=sdk)
    revision = run(["git", "rev-parse", "HEAD"], env, capture=True)
    dirty = bool(run(["git", "status", "--porcelain"], env, capture=True))
    report.write_text(
        json.dumps(
            {
                "source_revision": revision,
                "working_tree_changed": dirty,
                "toolchain": LOCK,
                "generated_sha256": {name: hashlib.sha256(value).hexdigest() for name, value in first.items()},
                "checks": passed,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"PASS foundation and Plugin component at {revision}; evidence: {report.relative_to(ROOT)}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap", action="store_true", help="download checksum-locked Go/sqlc/Ruff when absent")
    parser.add_argument(
        "--toolchain-self-test", action="store_true", help="only execute checksum and version refusal checks"
    )
    parser.add_argument("--command-lifetime-probe", type=str, help=argparse.SUPPRESS)
    parser.add_argument("--probe-timeout", type=float, default=5, help=argparse.SUPPRESS)
    options = parser.parse_args()
    if options.command_lifetime_probe:
        run(
            ["npm", "test", "--", "timeout-probe.ts"],
            {
                **os.environ,
                "ATLAS_CONTRACT_PROBE_MODE": "async",
                "ATLAS_CONTRACT_PROBE_MARKER": options.command_lifetime_probe,
            },
            cwd=ROOT / "Atlas SDK",
            timeout=options.probe_timeout,
        )
    elif options.toolchain_self_test:
        check_toolchain_refusals()
    else:
        verify(options.bootstrap)
