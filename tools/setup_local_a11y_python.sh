#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
a11y_data_home="${XDG_DATA_HOME:-${HOME}/.local/share}"
a11y_venv="${CROL_A11Y_VENV:-${a11y_data_home}/cityscroll/a11y-python}"
bootstrap_python="${CROL_A11Y_BOOTSTRAP_PYTHON:-python3}"
requirements="${project_root}/.github/actions/setup-playwright/requirements.txt"

if [[ ! -x "${a11y_venv}/bin/python3" ]]; then
  mkdir -p "$(dirname "${a11y_venv}")"
  "${bootstrap_python}" -m venv "${a11y_venv}"
fi

"${a11y_venv}/bin/python3" -m pip install --requirement "${requirements}"
"${a11y_venv}/bin/python3" -m playwright install chromium

echo "Local accessibility Python environment is ready: ${a11y_venv}"
echo "Run the full local gate with: make a11y"
