import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("review.py").resolve()


class FolioReviewTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.org")
        self.folio = self.root / "ARCHITECTURE.md"
        self.folio.write_text("## Storage\nUse [the policy](storage.json).\n"
                              "## Routing\nFollow `routes.js`.\n")
        (self.root / "storage.json").write_text("{}")
        (self.root / "routes.js").write_text("v1")
        self.commit()

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "test")

    def check(self, body="", expected=0, payload=None, env=None):
        event = self.root / ".git" / "event.json"
        event.write_text(json.dumps(payload or {"pull_request": {"body": body}}))
        result = subprocess.run([sys.executable, SCRIPT], cwd=self.root, capture_output=True,
                                text=True, env={**os.environ, **(env or {}), "GITHUB_EVENT_PATH": str(event),
                                               "GITHUB_REPOSITORY": "example/project"})
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result.stdout

    def test_unrelated_change_and_no_declaration(self):
        (self.root / "copy.txt").write_text("Revised label")
        self.commit()
        self.check()

    def test_cited_change_needs_matching_passage_or_review(self):
        (self.root / "storage.json").write_text('{"limit": 4}')
        self.folio.write_text(self.folio.read_text() + "New routing example.\n")
        self.commit()
        self.assertIn("Storage", self.check("<!-- Folio review: placeholder -->", expected=1))
        self.check("Folio review: Only the example limit changed. The policy still applies.")
        self.folio.write_text(self.folio.read_text().replace("Use [", "Cache according to ["))
        self.git("add", ".")
        self.git("commit", "--amend", "--no-edit", "-q")
        self.check()

    def test_main_push_requires_disposition_from_exact_merged_pr(self):
        before = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, text=True).strip()
        (self.root / "routes.js").write_text("v2")
        self.commit()
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, text=True).strip()
        gh = self.root / ".git" / "gh"
        gh.write_text('#!/bin/sh\nprintf "%s" "$REVIEW_PRS"\n')
        gh.chmod(0o755)
        pr = {"merged_at": "today", "merge_commit_sha": head, "base": {"ref": "main"},
              "body": "Folio review: Route names and ownership stay the same."}
        env = {"PATH": str(gh.parent) + os.pathsep + os.environ["PATH"]}
        for revision, expected in ((before, 1), (head, 0)):
            pr["merge_commit_sha"] = revision
            self.check(payload={"before": before}, expected=expected,
                       env={**env, "REVIEW_PRS": json.dumps([pr])})

    def test_new_migration_can_precede_any_folio_reference(self):
        path = self.root / "worker" / "migrations" / "0001.sql"
        path.parent.mkdir(parents=True)
        path.write_text("create table example(id integer);")
        self.commit()
        self.assertIn("system boundary", self.check(expected=1))
        self.check("Folio review: This adds an index to the existing store.")

    def test_missing_markdown_or_inline_evidence_cannot_be_acknowledged_away(self):
        for name in ("storage.json", "routes.js"):
            (self.root / name).unlink()
        self.commit()
        output = self.check("Folio review: We checked.", expected=1)
        self.assertIn("storage.json", output)
        self.assertIn("routes.js", output)


if __name__ == "__main__":
    unittest.main()
