#!/usr/bin/env python3
"""Apply the pinned formatters that verify.py checks: Prettier and Ruff."""

from toolchain import ROOT, prepare, run

if __name__ == "__main__":
    tools = prepare(bootstrap=False)
    run(["npm", "run", "format"], tools.env, cwd=ROOT / "Atlas SDK")
    # Import order is a lint rule; fix it before formatting.
    run([tools.ruff, "check", "--select", "I", "--fix"], tools.env, cwd=ROOT)
    run([tools.ruff, "format"], tools.env, cwd=ROOT)
