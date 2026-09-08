#!/usr/bin/env bash
# Build the project-scoped runtime the scheduled Notice synthetic probe runs on.
#
# The probe is started by launchd with the system default PATH and no login
# shell, so it can rely on nothing the operator's interactive session happens to
# have. This script installs everything it needs inside the checkout: a virtual
# environment at ops/notice-probe/.venv from the pinned requirements, and the
# browser build under ops/notice-probe/browsers. Nothing is written to a global
# site-packages directory or to the shared Playwright browser cache, so removing
# ops/notice-probe/.venv and ops/notice-probe/browsers undoes the whole install.
#
# It is idempotent: re-running it repairs a partial environment and is the
# supported way to move the pin in ops/notice-probe/requirements.txt.
#
#   tools/setup_notice_probe_runtime.sh
#   ops/notice-probe/.venv/bin/python3 tools/run_notice_synthetic_probe.py --check-runtime
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
runtime_dir="$root/ops/notice-probe"
venv_dir="$runtime_dir/.venv"
browsers_dir="$runtime_dir/browsers"
requirements="$runtime_dir/requirements.txt"
python_bin="$venv_dir/bin/python3"

# The interpreter that *builds* the environment is allowed to come from the
# operator's PATH, because a person runs this script. The interpreter the
# scheduler later runs is the one this script creates, and that one is named
# absolutely. Override for a host whose default python3 is too old.
bootstrap_python=${CROL_NOTICE_PROBE_BOOTSTRAP_PYTHON:-python3}
if ! command -v "$bootstrap_python" >/dev/null 2>&1; then
  echo "error: no executable $bootstrap_python found; set CROL_NOTICE_PROBE_BOOTSTRAP_PYTHON to an absolute path" >&2
  exit 1
fi

if [ ! -x "$python_bin" ]; then
  "$bootstrap_python" -m venv "$venv_dir"
fi

# --no-deps is the point of pinning the transitive distributions in the
# requirements file: the resolver is given nothing to choose.
"$python_bin" -m pip install --quiet --upgrade pip
"$python_bin" -m pip install --quiet --no-deps --requirement "$requirements"

# The browser lands in the checkout rather than in the shared Playwright cache
# under the home directory, so the probe cannot silently start measuring with
# a build some other tool installed or removed.
mkdir -p "$browsers_dir"
PLAYWRIGHT_BROWSERS_PATH="$browsers_dir" "$python_bin" -m playwright install chromium

# The receipt records what was actually installed, not what was requested: a
# pinned file states an intent, and only the resolved versions and the browser
# build directory state what the next slot will measure with. It is host state,
# not repository state, so it is written beside the environment and ignored.
"$python_bin" - "$runtime_dir" <<'RECEIPT'
import json, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

runtime_dir = Path(sys.argv[1])
frozen = subprocess.run(
    [sys.executable, "-m", "pip", "freeze"], capture_output=True, text=True, check=True
).stdout.split()
browsers = sorted(p.name for p in (runtime_dir / "browsers").iterdir() if p.is_dir())
receipt = {
    "schema": "cityscroll.notice_synthetic_probe_runtime.v1",
    "installed_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "python": sys.executable,
    "python_version": sys.version.split()[0],
    "distributions": frozen,
    "browsers_path": str(runtime_dir / "browsers"),
    "browser_builds": browsers,
}
path = runtime_dir / "runtime-receipt.json"
path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
print(f"wrote {path}")
RECEIPT

echo "probe runtime ready: $python_bin"
echo "verify it without measuring anything: $python_bin tools/run_notice_synthetic_probe.py --check-runtime"
