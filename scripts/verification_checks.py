"""Qualify the verifier's Go-test policy against an external fixture corpus."""

import tempfile
from pathlib import Path
from subprocess import CalledProcessError

from toolchain import LOCK, run


def check_fresh_go_tests(go, env, test_go):
    with tempfile.TemporaryDirectory(prefix="atlas-go-verification-") as directory:
        root = Path(directory)
        module = root / "module"
        module.mkdir()
        (module / "go.mod").write_text(
            f"module atlasverificationfixture\n\ngo {LOCK['go']['version'].removeprefix('go')}\n"
        )
        (module / "corpus_test.go").write_text(
            """package verification

import (
	"os"
	"testing"
)

func TestExternalCorpus(t *testing.T) {
	content, err := os.ReadFile("../corpus.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "passing fixture" {
		t.Fatalf("external corpus changed: got %q", content)
	}
}
"""
        )
        corpus = root / "corpus.txt"
        corpus.write_text("passing fixture")
        run([go, "test", "./..."], env, cwd=module, capture=True)
        cached = run([go, "test", "./..."], env, cwd=module, capture=True)
        if "(cached)" not in cached:
            raise RuntimeError("Go result-cache regression did not warm a passing result")
        corpus.write_text("failing fixture")
        try:
            test_go(go, env, cwd=module, capture=True)
        except CalledProcessError as error:
            if "external corpus changed" not in error.stdout:
                raise
        else:
            raise RuntimeError("verifier reused a passing Go result after the external corpus changed")
    print("PASS verifier freshly executes Go tests after an external corpus changes", flush=True)
