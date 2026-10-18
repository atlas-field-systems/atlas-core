import copy
import json
from pathlib import Path
import unittest

from run import validate_observation


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


if __name__ == "__main__":
    unittest.main()
