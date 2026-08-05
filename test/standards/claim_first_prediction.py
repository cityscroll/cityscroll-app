#!/usr/bin/env python3
"""Reject methodology-first prediction copy on public surfaces.

A prediction or estimate must lead with a named subject and concrete value. Its
sample size and methodology link are supporting evidence, not the headline.
Renderers with methodology links also carry machine-checkable subject/value
attributes so future copy changes cannot leave an orphaned basis caption.
"""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

BASIS_LED = re.compile(
    r'''["'`]\s*(?:
        (?:predicted|estimated)\s+based\s+on\b
        |based\s+on\s+(?:\{|\$\{|\d)
    )''',
    re.IGNORECASE | re.VERBOSE,
)

PUBLIC_COPY_ROOTS = (
    ROOT / "site",
    ROOT / "worker" / "src" / "lib",
    ROOT / "docs" / "formulas",
)
PUBLIC_SUFFIXES = {".js", ".mjs", ".html", ".md"}

RENDERER_CONTRACTS = {
    "site/app/people.mjs": (
        'data-staffing-list-prediction="1"',
        'data-prediction-subject="eligible-list-establishment"',
        "data-prediction-value=",
        "exam_list_prediction_method",
    ),
    "site/app/property.mjs": (
        'data-property-disposition-timing="1"',
        'data-prediction-subject="property-sale-timing"',
        "data-prediction-value=",
        "disposition_timing_formula_link",
    ),
    "site/app/rules.mjs": (
        'data-rule-adoption-estimate="1"',
        'data-prediction-subject="rule-adoption-timing"',
        "data-prediction-value=",
    ),
    "site/app/land.mjs": (
        'data-applicant-conditioned="1"',
        'data-prediction-subject="land-use-approval"',
        "data-prediction-value=",
        "land_applicant_conditioned_formula_link",
    ),
}


def public_copy_files() -> list[Path]:
    files: list[Path] = []
    for root in PUBLIC_COPY_ROOTS:
        files.extend(
            path for path in root.rglob("*")
            if path.is_file() and path.suffix in PUBLIC_SUFFIXES
        )
    return sorted(files)


def main() -> int:
    # Detector fitness: the captured failure fails; claim-first copy passes.
    assert BASIS_LED.search('"Predicted based on {n} past exams — median {months} months."')
    assert not BASIS_LED.search('"Expect the eligible list in {months} months (based on {n} exams)."')

    failures: list[str] = []
    for path in public_copy_files():
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if BASIS_LED.search(line):
                failures.append(
                    f"{path.relative_to(ROOT)}:{line_number}: basis leads the claim: {line.strip()}"
                )

    for relative, needles in RENDERER_CONTRACTS.items():
        text = (ROOT / relative).read_text(encoding="utf-8")
        for needle in needles:
            if needle not in text:
                failures.append(f"{relative}: prediction renderer contract missing {needle!r}")

    if failures:
        print("claim-first prediction lint failed:")
        for failure in failures:
            print(f"  {failure}")
        print("Lead with the predicted subject and value; put sample/method evidence after it.")
        return 1

    print("claim-first prediction lint passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
