"""Leak-safe scratch directories for capture and check scripts.

`tempfile.TemporaryDirectory()` with no prefix leaves a bare `tmp????????`
name that nothing can attribute back to this repository, and its cleanup only
runs on a normal return or a caught Python exception - not when a pre-push
gate kills the process with SIGTERM after a timeout. `cityscroll_temp_dir`
fixes both: every directory it hands out carries a `cityscroll-<label>-`
prefix, and cleanup is registered with `atexit` plus SIGTERM/SIGINT handlers
so an interrupted run does not leave its scratch tree behind.
"""

from __future__ import annotations

import atexit
import shutil
import signal
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

_ACTIVE_DIRS: set[str] = set()
_HANDLERS_INSTALLED = False


def _cleanup_all() -> None:
    for path in list(_ACTIVE_DIRS):
        shutil.rmtree(path, ignore_errors=True)
        _ACTIVE_DIRS.discard(path)


def _handle_signal(signum: int, _frame: object) -> None:
    _cleanup_all()
    # Restore the default disposition and re-raise so the process still exits
    # the way the caller (or the gate timing it out) expects.
    signal.signal(signum, signal.SIG_DFL)
    signal.raise_signal(signum)


def _install_handlers() -> None:
    global _HANDLERS_INSTALLED
    if _HANDLERS_INSTALLED:
        return
    _HANDLERS_INSTALLED = True
    atexit.register(_cleanup_all)
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handle_signal)
        except (ValueError, OSError):
            # Not the main thread, or the platform does not support this signal.
            pass


def _normalize_prefix(label: str) -> str:
    prefix = label if label.startswith("cityscroll-") else f"cityscroll-{label}"
    return prefix if prefix.endswith("-") else f"{prefix}-"


@contextmanager
def cityscroll_temp_dir(label: str) -> Iterator[Path]:
    """A `TemporaryDirectory` that is named `cityscroll-<label>-XXXXXXXX` and is
    removed on normal exit, on a raised exception, and on SIGTERM/SIGINT."""
    _install_handlers()
    directory = tempfile.mkdtemp(prefix=_normalize_prefix(label))
    _ACTIVE_DIRS.add(directory)
    try:
        yield Path(directory)
    finally:
        shutil.rmtree(directory, ignore_errors=True)
        _ACTIVE_DIRS.discard(directory)


@contextmanager
def head_site_workspace(
    root: Path, label: str, *, disable_sparse_checkout: bool = False
) -> Iterator[Path]:
    """Build the pre-change ("before") site tree in a detached, offline git
    worktree inside a leak-safe temp directory, and remove the worktree again
    on the way out - success, exception, or signal."""
    with cityscroll_temp_dir(label) as destination:
        tree = destination / "head"
        subprocess.run(
            ["git", "worktree", "add", "--detach", str(tree), "HEAD"], cwd=root, check=True
        )
        try:
            if disable_sparse_checkout:
                # A detached worktree inherits a reduced checkout's sparse settings on
                # this host. The before capture needs the complete tracked static site
                # so it measures the old UI, not an artifact omitted by a card profile.
                subprocess.run(["git", "sparse-checkout", "disable"], cwd=tree, check=True)
            subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=tree, check=True)
            yield tree / "site"
        finally:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(tree)], cwd=root, check=False
            )
            subprocess.run(["git", "worktree", "prune"], cwd=root, check=False)
