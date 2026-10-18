import copy
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest

from run import run_one, validate_observation


class ObservationCoverage(unittest.TestCase):
    def setUp(self):
        self.observation = json.loads(
            (Path(__file__).parent / "evidence" / "wire.stdout.json").read_text()
        )

    def test_complete_evidence_passes(self):
        self.assertEqual(validate_observation(self.observation, "wire"), 41)

    def test_missing_scenario_is_rejected(self):
        self.observation["cases"].pop()
        with self.assertRaisesRegex(ValueError, "case manifest mismatch"):
            validate_observation(self.observation, "wire")

    def test_single_passing_scenario_is_incomplete(self):
        self.observation["cases"] = self.observation["cases"][:1]
        with self.assertRaisesRegex(ValueError, "case manifest mismatch"):
            validate_observation(self.observation, "wire")

    def test_same_count_with_wrong_scenario_is_rejected(self):
        self.observation["cases"][0]["name"] = "unexpected passing scenario"
        with self.assertRaisesRegex(ValueError, "case manifest mismatch"):
            validate_observation(self.observation, "wire")

    def test_duplicate_scenario_is_rejected(self):
        self.observation["cases"].append(copy.deepcopy(self.observation["cases"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate case name"):
            validate_observation(self.observation, "wire")

    def test_claimed_pass_with_wrong_value_is_rejected(self):
        self.observation["cases"][0]["observed"] = {"unexpected": "value"}
        with self.assertRaisesRegex(ValueError, "unexpected failed case"):
            validate_observation(self.observation, "wire")

    def test_boolean_number_confusion_is_rejected_at_every_depth(self):
        for expected, observed in (
            (True, 1), (False, 0), (1, True), (0, False),
            ({"value": True}, {"value": 1}),
            ([False], [0]),
            ({"items": [{"value": 1}]}, {"items": [{"value": True}]}),
        ):
            with self.subTest(expected=expected, observed=observed):
                self.observation["cases"][0].update(
                    expected=expected, observed=observed, passed=True
                )
                with self.assertRaisesRegex(ValueError, "unexpected failed case"):
                    validate_observation(self.observation, "wire")

    def test_json_number_values_and_object_member_order_match(self):
        self.observation["cases"][0].update(
            expected={"number": 1, "items": [None, "1", True, {"a": 0, "b": 2}]},
            observed={"items": [None, "1", True, {"b": 2.0, "a": 0.0}], "number": 1.0},
            passed=True,
        )
        self.assertEqual(validate_observation(self.observation, "wire"), 41)

    def test_array_order_null_strings_and_numeric_precision_are_preserved(self):
        for expected, observed in (
            ([1, 2], [2, 1]), (None, "null"), (1, "1"),
            (9007199254740993, 9007199254740992.0),
        ):
            with self.subTest(expected=expected, observed=observed):
                self.observation["cases"][0].update(
                    expected=expected, observed=observed, passed=True
                )
                with self.assertRaisesRegex(ValueError, "unexpected failed case"):
                    validate_observation(self.observation, "wire")

    def test_nonfinite_evidence_is_rejected_even_when_both_values_match(self):
        for number in (float("inf"), float("-inf"), float("nan")):
            for value in (number, {"items": [number]}):
                with self.subTest(value=value):
                    self.observation["cases"][0].update(
                        expected=value, observed=copy.deepcopy(value), passed=True
                    )
                    with self.assertRaisesRegex(ValueError, "unexpected failed case"):
                        validate_observation(self.observation, "wire")


class RunnerOutput(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="atlas-run-test-")
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name)
        self.evidence = (Path(__file__).parent / "evidence" / "wire.stdout.json").read_bytes()
        self.input = self.output / "input.json"
        self.input.write_bytes(self.evidence)
        self.pids = self.output / "pids.json"

    def run_fixture(self, body):
        script = "\n".join([
            "import json, os, sys, time",
            "from pathlib import Path",
            "child = os.fork()",
            "if child == 0:",
            "    time.sleep(30)",
            "    os._exit(0)",
            "Path(sys.argv[2]).write_text(json.dumps([os.getpid(), child]))",
            body,
        ])
        self.addCleanup(self.kill_fixture_group)
        return run_one("wire", [sys.executable, "-c", script, str(self.input), str(self.pids)], self.output)

    def kill_fixture_group(self):
        if self.pids.exists():
            leader, _ = json.loads(self.pids.read_text())
            try:
                os.killpg(leader, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def assert_group_stopped(self):
        leader, child = json.loads(self.pids.read_text())
        self.assertFalse(Path(f"/proc/{leader}").exists(), "runner leader was not reaped")
        deadline = time.monotonic() + 3
        while True:
            try:
                state = Path(f"/proc/{child}/stat").read_text().rsplit(")", 1)[1].split()[0]
            except FileNotFoundError:
                return
            if state == "Z":
                return
            if time.monotonic() >= deadline:
                self.fail("runner descendant remains alive")
            time.sleep(0.01)

    def test_noisy_stdout_is_bounded_during_production(self):
        self.check_noisy_stream(1)

    def test_noisy_stderr_is_bounded_during_production(self):
        self.check_noisy_stream(2)

    def test_log_close_failure_preserves_overflow_and_process_outcome(self):
        (self.output / "wire.stderr.txt").symlink_to("/dev/full")
        result = self.run_fixture("\n".join([
            "sys.stderr.buffer.write(b'diagnostic')",
            "sys.stderr.buffer.flush()",
            "for _ in range(129):",
            "    sys.stdout.buffer.write(b'x' * 65536)",
            "sys.stdout.buffer.flush()",
            "time.sleep(2)",
        ]))
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["error"], "stdout exceeds 8 MiB")
        self.assertTrue(any("No space left" in error for error in result["cleanup_errors"]))
        self.assertEqual(result["exit_code"], -signal.SIGKILL)
        self.assert_group_stopped()

    def check_noisy_stream(self, descriptor):
        result = self.run_fixture("\n".join([
            "sys.stdout.buffer.write(Path(sys.argv[1]).read_bytes())" if descriptor == 2 else "pass",
            "sys.stdout.buffer.flush()",
            "for _ in range(129):",
            f"    sys.{'stdout' if descriptor == 1 else 'stderr'}.buffer.write(b'x' * 65536)",
            f"sys.{'stdout' if descriptor == 1 else 'stderr'}.buffer.flush()",
            "time.sleep(2)",
        ]))
        for filename in ("wire.stdout.json", "wire.stderr.txt"):
            with self.subTest(log=filename):
                self.assertLessEqual((self.output / filename).stat().st_size, 8 * 1024 * 1024)
        with self.subTest(outcome="failure"):
            self.assertEqual(result["status"], "FAIL")
        with self.subTest(outcome="exit"):
            self.assertEqual(result["exit_code"], -signal.SIGKILL)
        with self.subTest(outcome="cleanup"):
            self.assert_group_stopped()

    def test_buffered_output_survives_leader_exit_and_descendant_held_pipes(self):
        observation = json.loads(self.evidence)
        observation["findings"].append("x" * 256 * 1024)
        expected = json.dumps(observation).encode()
        self.input.write_bytes(expected)
        started = time.monotonic()
        result = self.run_fixture("\n".join([
            "sys.stdout.buffer.write(Path(sys.argv[1]).read_bytes())",
            "sys.stderr.buffer.write(b'diagnostic' * 16384)",
        ]))
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["cases"], 41)
        self.assertEqual((self.output / "wire.stdout.json").read_bytes(), expected)
        self.assertEqual((self.output / "wire.stderr.txt").read_bytes(), b"diagnostic" * 16384)
        self.assert_group_stopped()

    def test_nonzero_exit_is_preserved_with_valid_buffered_evidence(self):
        result = self.run_fixture("\n".join([
            "sys.stdout.buffer.write(Path(sys.argv[1]).read_bytes())",
            "sys.stderr.buffer.write(b'failure detail')",
            "sys.exit(7)",
        ]))
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["exit_code"], 7)
        self.assertEqual((self.output / "wire.stdout.json").read_bytes(), self.evidence)
        self.assertEqual((self.output / "wire.stderr.txt").read_bytes(), b"failure detail")
        self.assert_group_stopped()


if __name__ == "__main__":
    unittest.main()
