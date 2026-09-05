"""Regression proof for the LM-13 receipt comparison the pre-push gate relies on.

51_land_map_visual_parity_fixtures.py must leave docs/evidence untouched when a
run measures the same behavior the committed receipt already describes, and it
must fail loudly when the committed receipt is genuinely stale. Both properties
come down to normalize_receipt/diff_receipts in
test/functional/assets/land_map_visual_parity_receipt.py; this exercises that
logic directly so the property is covered without a browser or a live site.
"""

import copy
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "functional" / "assets"))
from land_map_visual_parity_receipt import diff_receipts, normalize_receipt  # noqa: E402


def sample_receipt() -> dict:
    return {
        "schema": "cityscroll.land-map-visual-parity-fixtures-receipt.v1",
        "provenance": {"app_commit": "abc123", "point_projection_schema": "cityscroll.land_project_map_points.v1"},
        "baseline_default_total": 40,
        "fixtures": [
            {
                "id": "default",
                "files": [
                    {"path": ".artifacts/default-list-narrow.png", "bytes": 1234, "sha256": "aaaa"},
                ],
                "readings": {
                    "narrow": {
                        "state": {"counts": {"total": 40, "mapped": 33, "unmapped": 7}, "overflow": 206},
                        "files": [".artifacts/default-list-narrow.png"],
                    }
                },
            }
        ],
        "checks_failed": [],
    }


class LandMapVisualParityReceiptTest(unittest.TestCase):
    def test_normalize_strips_only_run_local_noise(self):
        normalized = normalize_receipt(sample_receipt())

        self.assertNotIn("app_commit", normalized["provenance"])
        self.assertEqual(
            normalized["provenance"]["point_projection_schema"],
            "cityscroll.land_project_map_points.v1",
        )
        file_entry = normalized["fixtures"][0]["files"][0]
        self.assertNotIn("bytes", file_entry)
        self.assertNotIn("sha256", file_entry)
        self.assertEqual(file_entry["path"], ".artifacts/default-list-narrow.png")
        self.assertNotIn("overflow", normalized["fixtures"][0]["readings"]["narrow"]["state"])
        self.assertEqual(
            normalized["fixtures"][0]["readings"]["narrow"]["state"]["counts"],
            {"total": 40, "mapped": 33, "unmapped": 7},
        )

    def test_a_rerun_that_only_changed_commit_and_capture_bytes_still_matches(self):
        committed = sample_receipt()
        fresh = copy.deepcopy(committed)
        fresh["provenance"]["app_commit"] = "def456"
        fresh["fixtures"][0]["files"][0]["bytes"] = 9999
        fresh["fixtures"][0]["files"][0]["sha256"] = "bbbb"
        fresh["fixtures"][0]["readings"]["narrow"]["state"]["overflow"] = 0

        self.assertEqual(normalize_receipt(committed), normalize_receipt(fresh))
        self.assertEqual(
            diff_receipts(committed, fresh, committed_label="committed", fresh_label="fresh"),
            "",
        )

    def test_a_genuinely_stale_manifest_measurement_is_caught(self):
        committed = sample_receipt()
        fresh = copy.deepcopy(committed)
        # Simulates the manifest dropping an assertion the app no longer needs to satisfy:
        # the measured mapped/unmapped split moved, which nothing run-local excuses.
        fresh["fixtures"][0]["readings"]["narrow"]["state"]["counts"] = {
            "total": 40,
            "mapped": 30,
            "unmapped": 10,
        }

        self.assertNotEqual(normalize_receipt(committed), normalize_receipt(fresh))
        diff = diff_receipts(committed, fresh, committed_label="committed", fresh_label="fresh")
        self.assertIn("mapped", diff)
        self.assertNotEqual(diff, "")


if __name__ == "__main__":
    unittest.main()
