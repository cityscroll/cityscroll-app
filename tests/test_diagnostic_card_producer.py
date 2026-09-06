#!/usr/bin/env python3
"""Contract tests for the diagnostic repair card producer."""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from diagnostic_card_fitness import validate_card_text  # noqa: E402
from diagnostic_card_producer import (  # noqa: E402
    QUEUE_SCHEMA,
    repair_issue_key,
    run_producer,
)

IDENTITY = {
    "source_contract_id": "board-sources",
    "condition": "source-retrieval-failed",
    "adapter": "html_pdf_v1",
}
ISSUE_KEY = repair_issue_key(IDENTITY)


def observation_issue(**overrides):
    issue = {
        "issue_key": ISSUE_KEY,
        "identity": dict(IDENTITY),
        "state": "repair-candidate",
        "disposition": "repair",
        "detail": "The source was checked and the check did not complete.",
        "affected_scopes": 6,
        "last_observed_at": "2026-09-05T12:00:00.000Z",
        "first_observed_at": "2026-08-01T00:00:00.000Z",
        "owner": {
            "source_contract_id": "board-sources",
            "publishers": ["Fixture Community Board"],
            "code_paths": ["tools/repair_queue.mjs"],
        },
        "revision": {"source_vintage": "2026-09-05T12:00:00.000Z", "code_revision": "9eda45429"},
        "engineering_card": None,
        "resolution_receipt": None,
    }
    issue.update(overrides)
    if "identity" in overrides and "issue_key" not in overrides:
        issue["issue_key"] = repair_issue_key(issue["identity"])
    return issue


def queue_for(issues, *, status="available", counts=None, open_work=None):
    if counts is None and status == "available":
        counts = {
            "repair-candidate": sum(1 for issue in issues if issue["state"] == "repair-candidate"),
            "regressed": sum(1 for issue in issues if issue["state"] == "regressed"),
            "expected-absence": sum(1 for issue in issues if issue["state"] == "expected-absence"),
            "source-policy-limitation": sum(1 for issue in issues if issue["state"] == "source-policy-limitation"),
            "resolved": sum(1 for issue in issues if issue["state"] == "resolved"),
        }
    if open_work is None and status == "available":
        open_work = sum(1 for issue in issues if issue["state"] in {"repair-candidate", "regressed"})
    return {
        "schema": QUEUE_SCHEMA,
        "status": status,
        "visibility": "private",
        "consumer": "authenticated desk",
        "ingestion": {"available": status == "available", "reason": None if status == "available" else "missing", "missing_inputs": []},
        "counts": counts,
        "open_work_count": open_work,
        "issues": issues,
    }


class DiagnosticCardProducerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cityscroll-dcp-")
        self.state = Path(self.temp.name)
        self.site = self.state / "site"
        self.site.mkdir()
        (self.site / "index.html").write_text("resident\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def run_once(self, issues, **kwargs):
        queue = kwargs.pop("queue", None) or queue_for(issues)
        return run_producer(
            repo_root=ROOT,
            state_dir=self.state,
            queue_source=queue,
            register_source=kwargs.pop("register", {"schema": "cityscroll.repair_queue_register.v1", "issues": []}),
            evidence_dir=kwargs.pop("evidence_dir", ROOT / "architecture" / "evidence.d"),
            dry_run=kwargs.pop("dry_run", False),
            env=kwargs.pop("env", {}),
            now=kwargs.pop("now", "2026-09-06T00:00:00.000Z"),
            successful_check=kwargs.pop("successful_check", None),
            batch_size=kwargs.pop("batch_size", None),
        )

    def card_paths(self):
        proposed = self.state / "cards" / "proposed"
        if not proposed.is_dir():
            return []
        return sorted(proposed.glob("*.md"))

    def test_idempotency_two_identical_runs_create_one_card(self):
        first = self.run_once([observation_issue()])
        second = self.run_once([observation_issue()])
        self.assertEqual(len(first["created"]), 1)
        self.assertEqual(len(self.card_paths()), 1)
        self.assertEqual(second["outcome"], "unchanged")
        self.assertFalse(second["notify"])
        self.assertEqual(len(self.card_paths()), 1)
        text = self.card_paths()[0].read_text(encoding="utf-8")
        self.assertEqual([], validate_card_text(self.card_paths()[0], text, ROOT))

    def test_changed_last_seen_updates_same_lineage(self):
        self.run_once([observation_issue(last_observed_at="2026-09-05T12:00:00.000Z")])
        path = self.card_paths()[0]
        original = path.read_text(encoding="utf-8")
        result = self.run_once([observation_issue(last_observed_at="2026-09-06T08:00:00.000Z")])
        self.assertEqual(len(self.card_paths()), 1)
        self.assertIn(ISSUE_KEY, result["updated"])
        updated = path.read_text(encoding="utf-8")
        self.assertNotEqual(original, updated)
        self.assertIn("2026-09-06T08:00:00.000Z", updated)
        self.assertEqual(original.count("id: cityscroll-repair/"), updated.count("id: cityscroll-repair/"))

    def test_existing_repair_is_linked_before_a_new_card(self):
        register = {
            "schema": "cityscroll.repair_queue_register.v1",
            "issues": [
                {
                    "issue_key": ISSUE_KEY,
                    "identity": IDENTITY,
                    "engineering_card": {
                        "reference": "https://github.com/cityscroll/cityscroll-app/pull/1709",
                        "label": "Adapter coverage change",
                    },
                }
            ],
        }
        result = self.run_once([observation_issue()], register=register)
        self.assertEqual(result["created"], [])
        self.assertEqual(result["linked"], [ISSUE_KEY])
        self.assertEqual(self.card_paths(), [])

    def test_expected_absence_does_not_become_a_card(self):
        identity = {**IDENTITY, "condition": "checked-no-records"}
        issue = observation_issue(
            identity=identity,
            state="expected-absence",
            disposition="expected-absence",
            detail="The source was checked successfully and published no matching record.",
        )
        result = self.run_once([issue])
        self.assertEqual(self.card_paths(), [])
        self.assertTrue(any(row["reason"].startswith("state expected-absence") for row in result["skipped"]))
        self.assertIsNotNone(result["outstanding_count"])

    def test_source_policy_limitation_does_not_become_a_card(self):
        identity = {**IDENTITY, "condition": "source-not-published"}
        issue = observation_issue(
            identity=identity,
            state="source-policy-limitation",
            disposition="source-policy-limitation",
        )
        result = self.run_once([issue])
        self.assertEqual(self.card_paths(), [])
        self.assertTrue(any("source-policy-limitation" in row["reason"] for row in result["skipped"]))

    def test_unproven_causal_story_is_not_a_card(self):
        result = self.run_once([observation_issue(causal_story="the publisher failed on purpose")])
        self.assertEqual(self.card_paths(), [])
        self.assertTrue(any("causal" in row["reason"] for row in result["skipped"]))

    def test_failed_collection_never_resolves_or_reports_zero(self):
        result = run_producer(
            repo_root=ROOT,
            state_dir=self.state,
            queue_source=self.state / "missing-queue.json",
            env={},
            now="2026-09-06T00:00:00.000Z",
        )
        self.assertEqual(result["outcome"], "collection-failed")
        self.assertIsNone(result["outstanding_count"])
        self.assertEqual(result["resolved_count"], 0)
        self.assertFalse(result["all_clear"])
        self.assertTrue(result["notify"])
        unavailable = queue_for([], status="unavailable", counts=None, open_work=None)
        unavailable["ingestion"] = {"available": False, "reason": "observations unread", "missing_inputs": ["desk"]}
        failed = run_producer(
            repo_root=ROOT,
            state_dir=self.state,
            queue_source=unavailable,
            env={},
            now="2026-09-06T00:00:00.000Z",
        )
        self.assertEqual(failed["outcome"], "collection-failed")
        self.assertIsNone(failed["outstanding_count"])

    def test_recurrence_reopens_the_same_lineage(self):
        self.run_once([observation_issue()])
        resolved = observation_issue(state="resolved", disposition="repair")
        self.run_once([resolved], successful_check=True)
        lineage = json.loads((self.state / "lineage.v1.json").read_text(encoding="utf-8"))
        self.assertEqual(lineage["cards"][ISSUE_KEY]["status"], "resolved")
        path = self.card_paths()[0]
        result = self.run_once([observation_issue(state="regressed")])
        self.assertIn(ISSUE_KEY, result["reopened"])
        self.assertEqual(len(self.card_paths()), 1)
        self.assertIs(path.exists(), True)
        lineage = json.loads((self.state / "lineage.v1.json").read_text(encoding="utf-8"))
        self.assertEqual(lineage["cards"][ISSUE_KEY]["status"], "proposed")

    def test_resolved_without_fresh_check_stays_open(self):
        self.run_once([observation_issue()])
        result = self.run_once(
            [observation_issue(state="resolved")],
            successful_check=False,
        )
        self.assertEqual(result["closed"], [])
        lineage = json.loads((self.state / "lineage.v1.json").read_text(encoding="utf-8"))
        self.assertEqual(lineage["cards"][ISSUE_KEY]["status"], "proposed")

    def test_cursor_and_bounded_retry(self):
        other = observation_issue(
            identity={"source_contract_id": "other", "condition": "source-format-unsupported", "adapter": "airtable_v1"},
        )
        pair = [observation_issue(), other]
        first = self.run_once(pair, batch_size=1)
        self.assertEqual(len(first["created"]), 1)
        self.assertTrue(first["cursor"])
        second = self.run_once(pair, batch_size=1)
        self.assertEqual(len(second["created"]), 1)
        self.assertEqual(len(self.card_paths()), 2)
        self.assertEqual(second["cursor"], "")
        policy = json.loads((ROOT / "data" / "diagnostic-card-producer.v1.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(int(policy["retry_limit"]), 1)
        self.assertGreaterEqual(int(policy["batch_size"]), 1)
        bad = self.state / "broken.json"
        bad.write_text("{", encoding="utf-8")
        failed = run_producer(
            repo_root=ROOT,
            state_dir=self.state / "retry",
            queue_source=bad,
            env={},
            now="2026-09-06T00:00:00.000Z",
        )
        self.assertEqual(failed["outcome"], "collection-failed")

    def test_kill_switch_is_a_noop(self):
        result = self.run_once(
            [observation_issue()],
            env={"CITYSCROLL_DIAGNOSTIC_CARD_PRODUCER": "off"},
        )
        self.assertEqual(result["outcome"], "killed")
        self.assertEqual(self.card_paths(), [])
        self.assertFalse(result["notify"])
        flag = self.state / ".diagnostic-card-producer.off"
        flag.write_text("", encoding="utf-8")
        flagged = self.run_once([observation_issue()], env={})
        self.assertEqual(flagged["outcome"], "killed")

    def test_dry_run_writes_receipt_not_cards(self):
        result = self.run_once([observation_issue()], dry_run=True)
        self.assertEqual(result["outcome"], "dry-run")
        self.assertEqual(self.card_paths(), [])
        self.assertTrue((self.state / "receipts" / "latest.json").is_file())
        receipt = json.loads((self.state / "receipts" / "latest.json").read_text(encoding="utf-8"))
        self.assertTrue(receipt["dry_run"])
        self.assertEqual(receipt["interval_seconds"], 3600)
        self.assertFalse((self.state / "lineage.v1.json").exists())

    def test_receipt_and_silent_unchanged_and_no_public_copy(self):
        public = self.site / "index.html"
        before = public.read_text(encoding="utf-8")
        first = self.run_once([observation_issue()])
        self.assertTrue(first["notify"])
        second = self.run_once([observation_issue()])
        self.assertEqual(second["outcome"], "unchanged")
        self.assertFalse(second["notify"])
        self.assertEqual(public.read_text(encoding="utf-8"), before)
        self.assertFalse(second["public_copy_mutated"])

    def test_human_edits_are_preserved(self):
        self.run_once([observation_issue()])
        path = self.card_paths()[0]
        edited = path.read_text(encoding="utf-8").replace(
            "An operator watching the authenticated Desk repair queue",
            "A human-rewritten story about the authenticated Desk repair queue",
        )
        path.write_text(edited, encoding="utf-8")
        self.run_once([observation_issue(last_observed_at="2026-09-07T00:00:00.000Z")])
        text = path.read_text(encoding="utf-8")
        self.assertIn("A human-rewritten story about the authenticated Desk repair queue", text)
        self.assertIn("2026-09-07T00:00:00.000Z", text)

    def test_schedule_declares_the_documented_interval(self):
        policy = json.loads((ROOT / "data" / "diagnostic-card-producer.v1.json").read_text(encoding="utf-8"))
        plist = (ROOT / "ops/launchd/com.cityscroll.diagnostic-card-producer.plist.template").read_text(encoding="utf-8")
        self.assertEqual(policy["interval_seconds"], 3600)
        self.assertIn("<key>StartInterval</key>", plist)
        self.assertIn("<integer>3600</integer>", plist)
        runner = (ROOT / "tools/run_diagnostic_card_producer.sh").read_text(encoding="utf-8")
        self.assertIn("CITYSCROLL_DIAGNOSTIC_CARD_PRODUCER", runner)
        self.assertIn("data_source_graph.mjs", runner)

    def test_generated_card_passes_fitness_and_resident_ux(self):
        self.run_once([observation_issue()])
        path = self.card_paths()[0]
        violations = validate_card_text(path, path.read_text(encoding="utf-8"), ROOT)
        self.assertEqual([], [item.format() for item in violations])

    def test_issue_key_matches_queue_identity(self):
        self.assertEqual(len(ISSUE_KEY), 64)
        self.assertEqual(ISSUE_KEY, hashlib.sha256(
            "\u001f".join(["cityscroll.repair_queue.v1", "board-sources", "source-retrieval-failed", "html_pdf_v1"]).encode("utf-8")
        ).hexdigest())


if __name__ == "__main__":
    unittest.main()
