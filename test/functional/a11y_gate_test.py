"""Regression proof that real axe findings remain required failures."""

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402


class A11yGateTest(unittest.TestCase):
    def test_serious_axe_violation_still_fails(self):
        violations = [
            {"id": "color-contrast", "impact": "serious"},
            {"id": "aria-allowed-attr", "impact": "moderate"},
        ]

        self.assertEqual(failing_violations(violations, set()), [violations[0]])

    def test_ratchets_and_wcag22_rules_fail_at_any_impact(self):
        violations = [
            {"id": "heading-order", "impact": "moderate"},
            {"id": "target-size", "impact": "minor"},
            {"id": "label-content-name-mismatch", "impact": "minor"},
        ]

        self.assertEqual(
            failing_violations(violations, {"target-size"}),
            violations[:2],
        )


if __name__ == "__main__":
    unittest.main()
