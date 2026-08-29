#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  echo "usage: $0 COMMAND [ARG ...]" >&2
  exit 2
fi

a11y_data_home="${XDG_DATA_HOME:-${HOME}/.local/share}"
a11y_venv="${CROL_A11Y_VENV:-${a11y_data_home}/cityscroll/a11y-python}"

if [[ ! -x "${a11y_venv}/bin/python3" ]]; then
  echo "The shared accessibility Python environment is not installed." >&2
  echo "Run 'make setup-a11y' once on this host, then retry." >&2
  exit 2
fi

export PATH="${a11y_venv}/bin:${PATH}"
exec "$@"
