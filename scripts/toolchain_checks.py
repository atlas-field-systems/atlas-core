"""Exercise locked bootstrap refusal before an archive can be extracted."""

import hashlib
import io
import tarfile
import tempfile
from pathlib import Path

from toolchain import extract_archive, prepare, tool_paths


def check_toolchain_refusals():
    with tempfile.TemporaryDirectory(prefix="atlas-toolchain-check-") as directory:
        root = Path(directory)
        archive = root / "tool.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            content = b"independent bootstrap fixture"
            member = tarfile.TarInfo("tool")
            member.size = len(content)
            bundle.addfile(member, io.BytesIO(content))
        wrong_destination = root / "rejected"
        try:
            extract_archive(archive, "0" * 64, wrong_destination)
        except ValueError as error:
            if "checksum mismatch" not in str(error):
                raise
        else:
            raise RuntimeError("bootstrap accepted deliberately wrong checksum")
        if wrong_destination.exists():
            raise RuntimeError("checksum rejection extracted content")
        destination = root / "accepted"
        extract_archive(archive, hashlib.sha256(archive.read_bytes()).hexdigest(), destination)
        if (destination / "tool").read_bytes() != b"independent bootstrap fixture":
            raise RuntimeError("verified archive extraction changed fixture bytes")
        cache = root / "wrong-version"
        paths = tool_paths(cache)
        for path in paths.values():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        paths["go"].write_text('#!/bin/sh\nprintf "go version go1.0.0 linux/amd64\\n"\n')
        paths["go"].chmod(0o700)
        try:
            prepare(bootstrap=False, cache=cache)
        except ValueError as error:
            if "unexpected Go version" not in str(error):
                raise
        else:
            raise RuntimeError("bootstrap accepted deliberately wrong tool version")
    print("PASS bootstrap rejects wrong checksum before extraction and wrong tool version", flush=True)
