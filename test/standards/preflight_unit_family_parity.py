#!/usr/bin/env python3
"""Fail when the preflight's declared unit families drift from CI's matrix.

The local preflight exists to run what CI requires. If CI adds, renames, or
drops a family in the `unit-family` matrix and the preflight's declared list is
not updated in the same change, a branch can pass preflight while a required
family goes unrun. This compares the two name lists and nothing else.
"""
from __future__ import annotations

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
PREFLIGHT = ROOT / "tools/preflight-required-checks.sh"

WORKFLOW_MATRIX = re.compile(r"^\s*family:\s*\[([^\]]*)\]\s*$", re.MULTILINE)
PREFLIGHT_DECLARATION = re.compile(r"^PREFLIGHT_UNIT_FAMILIES=\(([^)]*)\)\s*$", re.MULTILINE)


def _split(raw: str) -> list[str]:
    return [item.strip().strip("'\"") for item in raw.replace(",", " ").split() if item.strip()]


def ci_families() -> list[str]:
    matches = WORKFLOW_MATRIX.findall(WORKFLOW.read_text(encoding="utf-8"))
    if len(matches) != 1:
        raise SystemExit(
            f"preflight family parity FAILED: expected exactly one `family: [...]` matrix in "
            f"{WORKFLOW.relative_to(ROOT)}, found {len(matches)}"
        )
    return _split(matches[0])


def preflight_families() -> list[str]:
    matches = PREFLIGHT_DECLARATION.findall(PREFLIGHT.read_text(encoding="utf-8"))
    if len(matches) != 1:
        raise SystemExit(
            f"preflight family parity FAILED: expected exactly one PREFLIGHT_UNIT_FAMILIES "
            f"declaration in {PREFLIGHT.relative_to(ROOT)}, found {len(matches)}"
        )
    return _split(matches[0])


def main() -> None:
    ci = ci_families()
    local = preflight_families()
    if ci == local:
        print(f"preflight family parity OK — {', '.join(ci)}")
        return

    print("preflight family parity FAILED:", file=sys.stderr)
    print(f"  CI matrix (.github/workflows/ci.yml): {ci}", file=sys.stderr)
    print(f"  preflight declaration (tools/preflight-required-checks.sh): {local}", file=sys.stderr)
    for missing in [name for name in ci if name not in local]:
        print(f"  CI requires {missing!r}, which the preflight does not declare", file=sys.stderr)
    for extra in [name for name in local if name not in ci]:
        print(f"  the preflight declares {extra!r}, which CI does not run", file=sys.stderr)
    if sorted(ci) == sorted(local):
        print("  same names, different order — keep both lists in the same order", file=sys.stderr)
    raise SystemExit(1)


if __name__ == "__main__":
    main()
