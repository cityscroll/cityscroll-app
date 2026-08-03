#!/usr/bin/env python3
"""Deterministic before/after land-timeline evidence for zoning statistics."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

import capture_ulurp_statutory_clock as fixture


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "zoning-statistics"
MODEL = json.loads((ROOT / "site" / "data" / "zoning_statistics.json").read_text())


def base_rate() -> dict:
    cohort = next(
        row
        for row in MODEL["cohorts"]
        if row["level"] == "action_type_citywide"
        and row["action_type"] == "ZM"
        and row["borough"] is None
    )
    return {
        **cohort,
        "copy": (
            f"Predicted based on {cohort['n']} {cohort['action_label']} applications "
            f"since {cohort['train_from'][:4]}: "
            f"{round(cohort['outcome_rates']['approved'] * 100)}% approved, typically "
            f"{cohort['typical_months']['low']}–{cohort['typical_months']['high']} months "
            "from certification to final action."
        ),
        "display_mode": "cohort_statistic_and_timing",
        "formula_url": "about.html#zoning-base-rates",
    }


def record(*, with_base_rate: bool) -> dict:
    value = fixture.base_record(with_clock=True)
    if with_base_rate:
        value["zoning_statistics"] = base_rate()
    return value


def capture(page: Page, base_url: str, payload: dict, path: Path, *, expected: bool) -> dict:
    fixture.install_routes(page, payload)
    page.goto(f"{base_url}#land/{fixture.PROJECT_ID}", wait_until="domcontentloaded")
    page.locator("#land-outcomes .land-phase-stepper").first.wait_for(
        state="visible", timeout=15_000
    )
    page.evaluate("() => document.fonts && document.fonts.ready")
    base_rate_box = page.locator("#land-outcomes [data-zoning-base-rate]")
    if expected:
        base_rate_box.first.wait_for(state="visible", timeout=5_000)
        text = base_rate_box.first.inner_text()
        assert "Predicted based on" in text
        assert "Statutory deadlines remain" in text
    else:
        assert base_rate_box.count() == 0
    page.locator("#land-outcomes").screenshot(path=str(path), animations="disabled")
    data = path.read_bytes()
    return {"name": path.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    files: list[dict] = list()
    errors: list[str] = list()
    with fixture.StaticServer() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height, suffix in ((1440, 900, "1440"), (390, 844, "390")):
            for label, with_base_rate in (("before", False), ("after", True)):
                page = browser.new_page(viewport={"width": width, "height": height})
                page.on("pageerror", lambda error: errors.append(str(error)))
                path = OUT / f"land-timeline-{label}-{suffix}.png"
                files.append(capture(
                    page,
                    base_url,
                    record(with_base_rate=with_base_rate),
                    path,
                    expected=with_base_rate,
                ))
                page.close()
        browser.close()
    if errors:
        raise AssertionError(errors)
    (OUT / "manifest.json").write_text(json.dumps({
        "schema_version": 1,
        "feature": "zoning-duration-outcome-base-rates",
        "project_id": fixture.PROJECT_ID,
        "cohort_id": base_rate()["cohort_id"],
        "files": files,
    }, indent=2) + "\n")
    print(f"captured {len(files)} zoning-statistics screenshots -> {OUT}")


if __name__ == "__main__":
    main()
