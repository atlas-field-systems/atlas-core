#!/usr/bin/env python3
"""One clean verification entry point for the Slice 0 foundation."""
import argparse
import hashlib
import json
import shutil

from generate import OUTPUTS, generate
from toolchain import LOCK, ROOT, prepare, run
from toolchain_checks import check_toolchain_refusals


def snapshot():
    return {str(path.relative_to(ROOT)): path.read_bytes()
            for directory in OUTPUTS for path in sorted(directory.rglob("*")) if path.is_file()}


def verify(bootstrap):
    artifacts = ROOT / ".artifacts"
    artifacts.mkdir(exist_ok=True)
    # Never leave a previous passing report after a failed verification.
    report = artifacts / "verification.json"
    report.unlink(missing_ok=True)
    check_toolchain_refusals()
    env, go, sqlc = prepare(bootstrap)
    run(["npm", "ci", "--ignore-scripts"], env, cwd=ROOT / "Atlas SDK")
    for module in [ROOT / "Atlas Core", ROOT / "Atlas Protocol/tools"]:
        run([go, "mod", "verify"], env, cwd=module)
    generate(env, go, sqlc)
    first = snapshot()
    if not first:
        raise RuntimeError("generation produced no artifacts")
    generate(env, go, sqlc)
    if snapshot() != first:
        raise RuntimeError("two clean generations changed output")
    print(f"PASS clean deterministic generation: {len(first)} files match byte for byte", flush=True)
    go_sources = sorted((ROOT / "Atlas Core").rglob("*.go"))
    formatted = run([go.parent / "gofmt", "-l", *go_sources], env, capture=True)
    if formatted:
        raise RuntimeError(f"Go formatting mismatch: {formatted}")
    for arguments in [[go, "build", "./..."], [go, "test", "./..."], [go, "vet", "./..."]]:
        run(arguments, env, cwd=ROOT / "Atlas Core")
    run([go, "build", "-o", artifacts / "contract-fixture", "./tests/contractfixture"], env, cwd=ROOT / "Atlas Core")
    run(["npm", "run", "lint"], env, cwd=ROOT / "Atlas SDK")
    run(["npm", "run", "check"], env, cwd=ROOT / "Atlas SDK")
    if (ROOT / "Atlas SDK/dist").exists():
        shutil.rmtree(ROOT / "Atlas SDK/dist")
    run(["npm", "run", "build"], env, cwd=ROOT / "Atlas SDK")
    # Consumer exports resolve only built JS/declarations, absent before this build.
    run(["npm", "run", "check:consumer"], env, cwd=ROOT / "Atlas SDK")
    package = json.loads(run(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], env, cwd=ROOT / "Atlas SDK", capture=True))
    allowed = ("dist/",)
    for file in package[0]["files"]:
        name = file["path"]
        if name not in {"README.md", "package.json"} and not name.startswith(allowed):
            raise RuntimeError(f"unexpected SDK consumer package artifact: {name}")
    print("PASS SDK consumer package excludes fixture tooling", flush=True)
    run(["npm", "test"], env, cwd=ROOT / "Atlas SDK")
    revision = run(["git", "rev-parse", "HEAD"], env, capture=True)
    dirty = bool(run(["git", "status", "--porcelain"], env, capture=True))
    report.write_text(json.dumps({"source_revision": revision, "working_tree_changed": dirty,
        "toolchain": LOCK, "generated_sha256": {name: hashlib.sha256(value).hexdigest() for name, value in first.items()},
        "checks": ["bootstrap checksum/version refusal", "locked dependencies and tool versions", "two clean generations",
                   "Go format/build/test/vet", "TypeScript structural lint and independent rule probes", "strict TypeScript and SDK build",
                   "ordinary Node package exports and consumer declarations", "SDK consumer artifact isolation", "generated transport/direct Protocol workflows", "fixture cleanup"]}, indent=2) + "\n")
    print(f"PASS Slice 0 foundation at {revision}; evidence: {report.relative_to(ROOT)}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap", action="store_true", help="download checksum-locked Go/sqlc when absent")
    parser.add_argument("--toolchain-self-test", action="store_true", help="only execute checksum and version refusal checks")
    options = parser.parse_args()
    if options.toolchain_self_test:
        check_toolchain_refusals()
    else:
        verify(options.bootstrap)
