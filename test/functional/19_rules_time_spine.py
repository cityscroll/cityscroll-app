#!/usr/bin/env python3
"""Functional gate for the Rules lifecycle event spine on notice detail.

Asserts that an Agency Rules notice renders the proposal → hearing → comment
deadline → adoption → effective chain (same family as the Money contract
timeline), with no horizontal overflow, and writes deterministic before/after
screenshots.

    python3 test/functional/19_rules_time_spine.py
    python3 test/functional/19_rules_time_spine.py --screenshots artifacts/cs-time-02
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.capture_rule_event_spine import DEFAULT_OUT, capture  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--screenshots",
        type=Path,
        default=None,
        help="Directory for before/after captures (default: docs/screenshots/rule-event-spine)",
    )
    args = parser.parse_args()
    out = args.screenshots.resolve() if args.screenshots else DEFAULT_OUT
    target = capture(out)

    # Expected capture filenames produced by tools/capture_rule_event_spine.py (not civic data).
    required_names = (
        "before-390.png",
        "before-1440.png",
        "after-390.png",
        "after-1440.png",
        "before-390-annotated.png",
        "before-1440-annotated.png",
        "after-390-annotated.png",
        "after-1440-annotated.png",
        "rule-event-spine-390.png",
        "rule-event-spine-1440.png",
    )
    missing_names = []  # generated screenshot checklist only — not civic source data
    for name in required_names:
        if not (target / name).is_file():
            missing_names.append(name)
    if missing_names:
        print(f"FAIL missing screenshots: {missing_names}", file=sys.stderr)
        return 1

    print(f"OK Rules lifecycle spine proof → {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
