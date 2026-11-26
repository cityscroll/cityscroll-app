import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from functools import partial
from pathlib import Path
from unittest.mock import patch

import review

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

    def check(self, body="", expected=0):
        return self.check_event({"pull_request": {"body": body}}, expected)

    def check_event(self, payload, expected=0):
        event = self.root / ".git" / "event.json"
        event.write_text(json.dumps(payload))
        result = subprocess.run([sys.executable, SCRIPT], cwd=self.root, capture_output=True,
                                text=True, env={**os.environ, "GITHUB_EVENT_PATH": str(event),
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
        pr = {"merged_at": "today", "merge_commit_sha": head, "base": {"ref": "main"},
              "body": "Folio review: Route names and ownership stay the same."}
        env = {"GH_TOKEN": "test-token", "GITHUB_API_URL": "https://github.example/api/v3"}
        with patch.dict(os.environ, env), \
                patch("subprocess.run", wraps=partial(subprocess.run, cwd=self.root)) as run, \
                patch.object(review, "urlopen") as urlopen:
            for revision, expected in ((before, 1), (head, 0)):
                pr["merge_commit_sha"] = revision
                urlopen.return_value = io.BytesIO(json.dumps([pr]).encode())
                with patch("sys.stdout", new_callable=io.StringIO) as output:
                    self.assertEqual(review.review({"before": before}, "example/project"), expected)
                    self.assertNotIn("test-token", output.getvalue())
                request = urlopen.call_args.args[0]
                self.assertEqual(request.full_url,
                                 f"https://github.example/api/v3/repos/example/project/commits/{head}/pulls")
                self.assertEqual(request.get_header("Authorization"), "Bearer test-token")
            for call in run.call_args_list:
                self.assertEqual(call.args[0][0], "git")
                self.assertNotIn("test-token", str(call.args))

    def test_main_push_reviews_current_head_when_previous_commit_is_unreachable(self):
        self.git("remote", "add", "origin", str(self.root))
        before = "a" * 40
        (self.root / "routes.js").write_text("v2")
        self.commit()
        self.assertIn(f"Unreachable folio comparison commit {before}",
                      self.check_event({"before": before}))

        (self.root / "storage.json").unlink()
        self.commit()
        self.assertIn("Missing folio evidence: 'storage.json'",
                      self.check_event({"before": before}, expected=1))

    def test_git_disables_terminal_prompts(self):
        with patch.dict(os.environ, {"GIT_TERMINAL_PROMPT": "1"}), \
                patch("subprocess.check_output", return_value=b"") as check_output:
            review.git("status")
        self.assertEqual(check_output.call_args.kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")

    def test_git_supplies_workflow_credentials_to_git_without_persisting_them(self):
        self.git("config", "credential.helper", "store --file=.git/test-credentials")
        credential = b"protocol=https\nhost=github.com\n\n"

        def use_credential(command, **kwargs):
            self.assertNotIn("test-token", str(command))
            result = subprocess.run(command, input=credential, cwd=self.root,
                                    capture_output=True, check=True, **kwargs)
            self.assertEqual(result.stderr, b"")
            return result.stdout

        env = {"GH_TOKEN": "test-token", "GITHUB_SERVER_URL": "https://github.com",
               "GIT_TRACE": "0"}
        with patch.dict(os.environ, env), patch("subprocess.check_output", side_effect=use_credential):
            filled = review.git("credential", "fill")
            self.assertIn("username=x-access-token", filled.splitlines())
            self.assertIn("password=test-token", filled.splitlines())
            credential = filled.encode() + b"\n"
            self.assertEqual(review.git("credential", "approve"), "")
        self.assertFalse((self.root / ".git" / "test-credentials").exists())

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
