#!/usr/bin/env python3
"""Reconstruct disposable bindings from Protocol and private SQL."""

import json
import shutil

from toolchain import ROOT, prepare, run

OUTPUTS = [
    ROOT / "Atlas Core/generated",
    ROOT / "Atlas Core/plugins/generated",
    ROOT / "Atlas Core/tests/contractfixture/generated",
    ROOT / "Atlas SDK/generated",
    ROOT / "tests/contract/generated",
]


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
    for directory, spec, output in [
        (ROOT / "Atlas Protocol", "protocol.json", ROOT / "Atlas Core/generated/protocol/protocol.gen.go"),
        (
            ROOT / "tests/contract",
            "generated/protocol.json",
            ROOT / "Atlas Core/tests/contractfixture/generated/contract/contract.gen.go",
        ),
    ]:
        run(
            [
                go,
                "tool",
                f"-modfile={generator_module}",
                "oapi-codegen",
                "--config",
                directory / "oapi-codegen.yaml",
                "-o",
                output,
                directory / spec,
            ],
            env,
            cwd=ROOT / "Atlas Core",
            timeout=120,
        )
    run([sqlc, "generate"], env, cwd=ROOT / "tests/contract", timeout=120)
    run([sqlc, "generate"], env, cwd=ROOT / "Atlas Core/plugins", timeout=120)
    run(["npm", "run", "generate"], env, cwd=ROOT / "Atlas SDK", timeout=120)
    openapi_typescript = ROOT / "Atlas SDK/node_modules/.bin/openapi-typescript"
    for source, output in [
        ("generated/protocol.json", "generated/protocol.ts"),
        ("older-client.json", "generated/older-client.ts"),
    ]:
        run([openapi_typescript, source, "--output", output], env, cwd=ROOT / "tests/contract", timeout=120)


if __name__ == "__main__":
    tools = prepare(bootstrap=False)
    generate(tools.env, tools.go, tools.sqlc)
