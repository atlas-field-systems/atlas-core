"""Exercise locked bootstrap refusal before an archive can be extracted."""
import hashlib
import io
import os
from pathlib import Path
import tarfile
import tempfile

from toolchain import extract_archive, prepare


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
        (cache / "go/bin").mkdir(parents=True)
        (cache / "bin").mkdir()
        go = cache / "go/bin/go"
        go.write_text('#!/bin/sh\nprintf "go version go1.0.0 linux/amd64\\n"\n')
        go.chmod(0o700)
        (cache / "bin/sqlc").touch()
        previous = os.environ.get("ATLAS_TOOLS")
        os.environ["ATLAS_TOOLS"] = str(cache)
        try:
            try:
                prepare(bootstrap=False)
            except ValueError as error:
                if "unexpected Go version" not in str(error):
                    raise
            else:
                raise RuntimeError("bootstrap accepted deliberately wrong tool version")
        finally:
            if previous is None:
                del os.environ["ATLAS_TOOLS"]
            else:
                os.environ["ATLAS_TOOLS"] = previous
    print("PASS bootstrap rejects wrong checksum before extraction and wrong tool version", flush=True)
