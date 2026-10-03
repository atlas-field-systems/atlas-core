#!/usr/bin/env python3
"""Reconstruct disposable bindings from Protocol and private SQL."""
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUTPUTS = [ROOT / "Atlas Core/generated", ROOT / "Atlas Core/tests/contractfixture/generated",
           ROOT / "Atlas SDK/generated", ROOT / "tests/contract/generated"]


def assemble_contract():
    contract = json.loads((ROOT / "Atlas Protocol/protocol.json").read_text())
    contract["info"] = {"title": "Slice 0 test-only contract", "version": "0.2.0"}
    for source in sorted((ROOT / "tests/contract").glob("*.contract.json")):
        fragment = json.loads(source.read_text())
        for path, value in fragment.get("paths", {}).items():
            if path in contract["paths"]:
                raise ValueError(f"duplicate fixture path {path} in {source}")
            contract["paths"][path] = value
        for kind, entries in fragment.get("components", {}).items():
            destination = contract["components"].setdefault(kind, {})
            for name, value in entries.items():
                if name in destination:
                    raise ValueError(f"duplicate component {name} in {source}")
                destination[name] = value
    (ROOT / "tests/contract/generated/protocol.json").write_text(json.dumps(contract, indent=2) + "\n")


def generate(env, go, sqlc):
    for directory in OUTPUTS:
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True)
    assemble_contract()
    # Package the identical canonical artifact for offline Catalog validation.
    shutil.copyfile(ROOT / "Atlas Protocol/protocol.json", ROOT / "Atlas SDK/generated/protocol.json")
    generator_module = ROOT / "Atlas Protocol/tools/go.mod"
    for directory, spec, output in [(ROOT / "Atlas Protocol", "protocol.json", ROOT / "Atlas Core/generated/protocol/protocol.gen.go"),
                                    (ROOT / "tests/contract", "generated/protocol.json", ROOT / "Atlas Core/tests/contractfixture/generated/contract/contract.gen.go")]:
        subprocess.run([str(go), "tool", f"-modfile={generator_module}", "oapi-codegen", "--config", str(directory / "oapi-codegen.yaml"), "-o", str(output), str(directory / spec)],
                       cwd=ROOT / "Atlas Core", env=env, check=True, timeout=120)
    subprocess.run([str(sqlc), "generate"], cwd=ROOT / "tests/contract", env=env, check=True, timeout=120)
    subprocess.run(["npm", "run", "generate"], cwd=ROOT / "Atlas SDK", env=env, check=True, timeout=120)
    subprocess.run([str(ROOT / "Atlas SDK/node_modules/.bin/openapi-typescript"), "generated/protocol.json", "--output", "generated/protocol.ts"],
                   cwd=ROOT / "tests/contract", env=env, check=True, timeout=120)
    subprocess.run([str(ROOT / "Atlas SDK/node_modules/.bin/openapi-typescript"), "older-client.json", "--output", "generated/older-client.ts"],
                   cwd=ROOT / "tests/contract", env=env, check=True, timeout=120)


if __name__ == "__main__":
    from toolchain import prepare
    environment, go_binary, sqlc_binary = prepare(bootstrap=False)
    generate(environment, go_binary, sqlc_binary)
