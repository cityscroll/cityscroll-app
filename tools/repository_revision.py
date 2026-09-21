"""Resolve capture provenance to a commit that readers can find on main."""

from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path


def _git(*args: str, cwd: Path | str | None = None) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _capture_head(cwd: Path | str | None = None, main_ref: str = "origin/main") -> str:
    """Resolve the branch tip behind GitHub's synthetic pull-request merge."""

    candidate = os.environ.get("GITHUB_HEAD_SHA")
    if candidate:
        try:
            return _git("rev-parse", "--verify", f"{candidate}^{{commit}}", cwd=cwd)
        except subprocess.CalledProcessError:
            pass
    if os.environ.get("GITHUB_EVENT_NAME") == "pull_request":
        try:
            parents = _git("rev-list", "--parents", "-n", "1", "HEAD", cwd=cwd).split()
            if len(parents) == 3 and _git("merge-base", parents[1], main_ref, cwd=cwd) == parents[1]:
                return parents[2]
        except subprocess.CalledProcessError:
            pass
    return "HEAD"


def resolve_repository_revision(
    cwd: Path | str | None = None,
    *,
    main_ref: str = "origin/main",
) -> str:
    """Return the grounded commit shared by the capture branch and main.

    Captures may be produced on a branch that is later squash-merged.  The
    branch tip is therefore not durable provenance; its merge-base with the
    fetched default branch is.  Missing ``origin/main`` is an error instead
    of silently recording an unresolvable fallback.
    """

    return _git("merge-base", _capture_head(cwd, main_ref), main_ref, cwd=cwd)


def branch_head(cwd: Path | str | None = None) -> str:
    """Return the branch tip for optional, explicitly non-authoritative detail."""

    return _git("rev-parse", "HEAD", cwd=cwd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--main-ref", default="origin/main")
    args = parser.parse_args()
    print(resolve_repository_revision(args.cwd, main_ref=args.main_ref))
