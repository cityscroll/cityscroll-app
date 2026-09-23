#!/usr/bin/env python3
"""Classify deferred Near You place-slice responses offline.

Reads a JSON file of served cases — each `{id, status, body}` where `body` is
the raw HTTP body a deferred route returned — runs each through the production
read-back classifier (`classify_deferred`), and prints one JSON array of
results. Classification is never silent: a case that matches no typed state is
reported as `rejected` with the classifier's own fail-closed message, so a test
can require an ambiguous or missing fixture to fail.

No network access, no browser, no production capture: this probe exists so
tests can prove the typed published-coverage classification for states the
live production read-back cannot stage on demand.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CAPTURE_TOOL = ROOT / "tools/capture_near_you_place_slices_production_read.py"


def load_classifier() -> Any:
    spec = importlib.util.spec_from_file_location("capture_place_slices", CAPTURE_TOOL)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def classify_case(module: Any, case: dict[str, Any]) -> dict[str, Any]:
    case_id = case.get("id")
    status = case.get("status")
    body = case.get("body")
    if not isinstance(status, int):
        return {"id": case_id, "outcome": "invalid_case", "error": "case has no integer status"}
    try:
        payload = json.loads(body) if isinstance(body, str) else body
    except (TypeError, json.JSONDecodeError) as error:
        return {"id": case_id, "outcome": "unparseable_body", "error": str(error)}
    try:
        classified = module.classify_deferred(status, payload)
    except AssertionError as error:
        return {"id": case_id, "outcome": "rejected", "error": str(error)}
    return {"id": case_id, "outcome": "classified", **classified}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cases", type=Path, help="JSON file of {id, status, body} served cases")
    args = parser.parse_args(argv)
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    if not isinstance(cases, list) or not cases:
        print("classify probe requires a non-empty JSON array of cases", file=sys.stderr)
        return 2
    module = load_classifier()
    results = [classify_case(module, case) for case in cases]
    print(json.dumps(results, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
