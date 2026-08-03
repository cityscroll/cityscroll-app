#!/usr/bin/env python3
"""Deterministic before/after land-timeline evidence for applicant-conditioned rates."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

import capture_ulurp_statutory_clock as fixture


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "applicant-conditioned-ulurp"
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
            f"Based on {cohort['n']} past {cohort['action_label']} cases "
            f"since {cohort['train_from'][:4]}. "
            f"{round(cohort['outcome_rates']['approved'] * 100)}% were approved. "
            f"Final action usually came {cohort['typical_months']['low']}–"
            f"{cohort['typical_months']['high']} months after certification."
        ),
        "display_mode": "cohort_statistic_and_timing",
        "formula_url": "about.html#zoning-base-rates",
    }


def applicant_conditioned(base: dict) -> dict:
    cohorts = MODEL.get("applicant_conditioning", {}).get("cohorts") or []
    # Prefer a private-applicant firm when present (entity page shape).
    preferred = next(
        (row for row in cohorts if str(row.get("applicant_entity_kind")) == "vendor"),
        None,
    ) or (cohorts[0] if cohorts else None)
    if not preferred:
        raise SystemExit("no applicant_conditioning cohorts in zoning_statistics.json")
    approved = preferred["outcome_rates"]["approved"]
    base_approved = base["outcome_rates"]["approved"]
    render_mode = MODEL["applicant_conditioning"].get("render_mode") or "descriptive_history"
    year = str(preferred.get("train_from") or "")[:4]
    p = round(approved * 100)
    p0 = round(base_approved * 100)
    lead = "Predicted based on" if render_mode == "per_matter" else "Based on"
    copy = (
        f"{lead} {preferred['n']} applications by this applicant since {year}: "
        f"{p}% approved, vs {p0}% overall."
    )
    return {
        **preferred,
        "base_rate": {
            "n": base["n"],
            "approved": base_approved,
            "outcome_rates": base["outcome_rates"],
            "train_from": base["train_from"],
            "cohort_id": base["cohort_id"],
            "level": base["level"],
        },
        "copy": copy,
        "render_mode": render_mode,
        "formula_url": "about.html#applicant-conditioned-ulurp",
        "display_mode": (
            "conditioned_with_base_rate"
            if render_mode == "per_matter"
            else "descriptive_history_with_base_rate"
        ),
    }


def record(*, with_applicant: bool) -> dict:
    value = fixture.base_record(with_clock=True)
    stats = base_rate()
    if with_applicant:
        stats = {**stats, "applicant_conditioned": applicant_conditioned(stats)}  # source: site/data/zoning_statistics.json
        # Applicant label on the open-data card for the entity framing.
        if value.get("open_data"):
            value["open_data"] = {
                **value["open_data"],
                "primary_applicant": stats["applicant_conditioned"]["applicant_display_name"],
            }
    value["zoning_statistics"] = stats
    return value


def capture(page: Page, base_url: str, payload: dict, path: Path, *, expected: bool) -> dict:
    fixture.install_routes(page, payload)
    page.goto(f"{base_url}#land/{fixture.PROJECT_ID}", wait_until="domcontentloaded")
    page.locator("#land-outcomes .land-phase-stepper").first.wait_for(
        state="visible", timeout=15_000
    )
    page.evaluate("() => document.fonts && document.fonts.ready")
    base_rate_box = page.locator("#land-outcomes [data-zoning-base-rate]")
    base_rate_box.first.wait_for(state="visible", timeout=5_000)
    text = base_rate_box.first.inner_text()
    assert "Based on" in text
    applicant = page.locator("#land-outcomes [data-applicant-conditioned]")
    if expected:
        applicant.first.wait_for(state="visible", timeout=5_000)
        applicant_text = applicant.first.inner_text()
        assert "applications by this applicant" in applicant_text
        assert "vs" in applicant_text and "overall" in applicant_text
    else:
        assert applicant.count() == 0
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
            for label, with_applicant in (("before", False), ("after", True)):
                page = browser.new_page(viewport={"width": width, "height": height})
                page.on("pageerror", lambda error: errors.append(str(error)))
                path = OUT / f"applicant-entity-{label}-{suffix}.png"
                files.append(capture(
                    page,
                    base_url,
                    record(with_applicant=with_applicant),
                    path,
                    expected=with_applicant,
                ))
                page.close()
        browser.close()
    if errors:
        raise AssertionError(errors)
    ac = applicant_conditioned(base_rate())
    (OUT / "manifest.json").write_text(json.dumps({
        "schema_version": 1,
        "feature": "applicant-conditioned-ulurp-outcome-rates",
        "project_id": fixture.PROJECT_ID,
        "applicant_entity_key": ac["applicant_entity_key"],
        "applicant_display_name": ac["applicant_display_name"],
        "render_mode": ac["render_mode"],
        "files": files,
    }, indent=2) + "\n")
    print(f"captured {len(files)} applicant-conditioned screenshots -> {OUT}")


if __name__ == "__main__":
    main()
