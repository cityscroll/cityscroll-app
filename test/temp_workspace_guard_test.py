#!/usr/bin/env python3
"""Cleanup guarantees for tools/lib/temp_workspace.py: the shared helper that
replaces bare `tempfile.TemporaryDirectory()` calls across the capture and
check scripts (see docs/evidence-adjacent PR discussion for the tmp???????? /
git-worktree leak this closes)."""

import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from lib.temp_workspace import cityscroll_temp_dir  # noqa: E402


class TempWorkspaceGuardTest(unittest.TestCase):
    def test_directory_is_namespaced_and_removed_on_success(self):
        with cityscroll_temp_dir("guard-test") as directory:
            self.assertTrue(directory.exists())
            self.assertTrue(directory.name.startswith("cityscroll-guard-test-"))
            captured = directory
        self.assertFalse(captured.exists())

    def test_a_prefix_that_already_carries_the_namespace_is_not_doubled(self):
        with cityscroll_temp_dir("cityscroll-already-namespaced") as directory:
            self.assertTrue(directory.name.startswith("cityscroll-already-namespaced-"))
            self.assertNotIn("cityscroll-cityscroll-", directory.name)

    def test_directory_is_removed_when_the_block_raises(self):
        captured = None

        def run():
            nonlocal captured
            with cityscroll_temp_dir("guard-test-raise") as directory:
                captured = directory
                raise RuntimeError("boom")

        with self.assertRaisesRegex(RuntimeError, "boom"):
            run()
        self.assertFalse(captured.exists())

    def test_sigterm_during_the_block_still_removes_the_directory(self):
        proc = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import sys, time; sys.path.insert(0, 'tools'); "
                    "from lib.temp_workspace import cityscroll_temp_dir\n"
                    "with cityscroll_temp_dir('sigterm-guard') as d:\n"
                    "    print(d, flush=True)\n"
                    "    time.sleep(30)\n"
                ),
            ],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            line = proc.stdout.readline().strip()
            self.assertTrue(line, "expected the child to report a temp dir path")
            directory = Path(line)
            time.sleep(0.3)
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=5)
            self.assertFalse(directory.exists(), "SIGTERM should have triggered cleanup")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            proc.stdout.close()


if __name__ == "__main__":
    unittest.main()
