import hashlib
import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORPUS_PATH = ROOT / "data" / "incident-corpus.json"
RECEIPT_PATH = ROOT / "data" / "incident-corpus-receipt.json"


class IncidentCorpusFitness(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.corpus = json.loads(CORPUS_PATH.read_text())
        cls.receipt = json.loads(RECEIPT_PATH.read_text())

    def test_baseline_denominator_and_taxonomy(self):
        baseline = self.corpus["queue_baseline"]
        self.assertEqual(baseline["pull_requests_scanned"], 573)
        self.assertEqual(baseline["removal_events_observed"], 680)
        self.assertEqual(baseline["successful_dequeues_after_merge"] + baseline["ejections"], 680)
        self.assertEqual(
            {row["id"] for row in self.corpus["taxonomy"]},
            {
                "shared-gate-rot",
                "live-external-coupling",
                "flaky-shard-ejection",
                "long-pole-serial-check",
                "generated-file-conflict",
                "runner-pool-contention",
                "arm-time-thrash",
            },
        )

    def test_two_founding_incidents_have_the_contract(self):
        self.assertEqual(len(self.corpus["incidents"]), 2)
        required = {
            "id", "class", "signature", "affected_checks", "detection_story",
            "root_cause", "fix_pr", "time_to_detection", "time_to_fix",
        }
        for incident in self.corpus["incidents"]:
            self.assertTrue(required <= incident.keys())
            self.assertTrue(incident["root_cause"]["evidence_refs"])
            self.assertIn(incident["root_cause"]["evidence_kind"], {"documented fix behavior"})
            self.assertIn(incident["time_to_detection"]["measurement"], {"measured", "estimated"})
            self.assertIn(incident["time_to_fix"]["measurement"], {"measured", "estimated"})
            self.assertTrue(incident["fix_pr"]["commit"])
            for check in incident["affected_checks"]:
                refs = check.get("receipts", check.get("receipt"))
                self.assertTrue(refs)

    def test_receipt_matches_corpus_without_wall_clock(self):
        payload = json.dumps(self.corpus, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        digest = hashlib.sha256(payload).hexdigest()
        self.assertEqual(self.receipt["corpus_sha256"], digest)
        completed = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "validate_incident_corpus.py"), str(CORPUS_PATH)],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)


if __name__ == "__main__":
    unittest.main()
