"""CPU-disciplined ingest guards — single job, headroom gate, taskpolicy wrap.

Bakes the OpenL3/torment lesson into tooling: never full-blast parallel hoover
on the MacBook. Heavy work is one batch at a time, nice'd, background I/O
policy, and refused when headroom is CONSTRAINED.
"""

from __future__ import annotations

import atexit
import fcntl
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from paths import DEFAULT_HEADROOM_CANDIDATES, LOCK_PATH

_lock_fh = None
_DEFAULT_HEADROOM_CANDIDATES = DEFAULT_HEADROOM_CANDIDATES


class IngestLock:
    """Exclusive non-blocking lock so only one ingest job runs at a time."""

    def __init__(self, path: Path = LOCK_PATH):
        self.path = path
        self._fh = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, "a+", encoding="utf-8")
        try:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._fh.seek(0)
            holder = self._fh.read().strip() or "(unknown holder)"
            self._fh.close()
            self._fh = None
            raise SystemExit(
                f"Another warehouse ingest holds the lock at {self.path}:\n"
                f"  {holder}\n"
                "One job at a time (CPU discipline). Wait or release the lock."
            )
        payload = {
            "pid": os.getpid(),
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "argv": sys.argv,
        }
        self._fh.seek(0)
        self._fh.truncate()
        self._fh.write(json.dumps(payload))
        self._fh.flush()
        atexit.register(self._release)
        return self

    def _release(self):
        if self._fh is None:
            return
        try:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            self._fh.close()
        except Exception:
            pass
        self._fh = None

    def __exit__(self, *exc):
        self._release()
        return False


def headroom_script() -> Path | None:
    env = os.environ.get("HEADROOM_BIN", "").strip()
    if env and Path(env).is_file():
        return Path(env)
    for cand in _DEFAULT_HEADROOM_CANDIDATES:
        if cand.is_file():
            return cand
    return None


def check_headroom(*, force: bool = False) -> dict:
    """Gate heavy work. Exit non-zero when CONSTRAINED unless force."""
    script = headroom_script()
    if script is None:
        return {"status": "unknown", "note": "headroom.py not found; proceeding uncapped is discouraged"}
    try:
        proc = subprocess.run(
            [sys.executable, str(script), "--json"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"status": "unknown", "note": f"headroom probe failed: {e}"}

    payload: dict = {}
    if proc.stdout.strip():
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError:
            payload = {"raw": proc.stdout.strip()}

    # headroom.py --json: {ok: bool, problems: [], ...}; exit 0 ok / 1 constrained
    ok = payload.get("ok")
    constrained = proc.returncode != 0 or ok is False
    status = "ok" if (ok is True and proc.returncode == 0) else "constrained" if constrained else "unknown"
    result = {
        "status": status,
        "returncode": proc.returncode,
        "constrained": constrained,
        "payload": payload,
    }
    if constrained and not force:
        raise SystemExit(
            "Headroom CONSTRAINED — refusing warehouse ingest (CPU discipline).\n"
            f"  status={status} returncode={proc.returncode}\n"
            "  Re-check: python3 \"$HEADROOM_BIN\" (estate headroom.py)\n"
            "  Defer, run on Mini, or re-try with --force-headroom only for tiny proof.\n"
            f"  detail={json.dumps(payload)[:400]}"
        )
    return result


def wrap_argv(cmd: list[str]) -> list[str]:
    """Prefer headroom.py wrap (taskpolicy -b / nice); fall back to taskpolicy/nice."""
    script = headroom_script()
    if script is not None:
        return [sys.executable, str(script), "wrap", "--", *cmd]
    if shutil.which("taskpolicy"):
        return ["taskpolicy", "-b", *cmd]
    if shutil.which("nice"):
        return ["nice", "-n", "20", *cmd]
    return cmd


def run_capped(cmd: list[str], *, cwd: Path | None = None, env: dict | None = None) -> subprocess.CompletedProcess:
    wrapped = wrap_argv(cmd)
    return subprocess.run(wrapped, cwd=cwd, env=env, check=False)


def enforce_row_cap(limit: int, defaults: dict, *, ack_large: bool) -> int:
    hard = int(defaults.get("max_rows_hard_cap", 10000))
    require_ack = int(defaults.get("require_ack_above", 1000))
    if limit < 1:
        raise SystemExit("--limit must be >= 1")
    if limit > hard and not ack_large:
        raise SystemExit(
            f"--limit {limit} exceeds hard cap {hard}. "
            "WH-01 is scaffold-only; full bulk is WH-02 with CPU caps. "
            "Pass --ack-large only when deliberately running a larger (still single) batch."
        )
    if limit > require_ack and not ack_large:
        raise SystemExit(
            f"--limit {limit} > {require_ack}: pass --ack-large to confirm this is intentional "
            "(still one job, still taskpolicy-wrapped)."
        )
    return limit
