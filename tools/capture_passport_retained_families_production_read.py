#!/usr/bin/env python3
"""Capture the retained procurement families from the deployed Pages routes.

The expected figures come from the retained-family fixture read-back. Each
capture verifies them first in the deployed shared-model shard and then in the
rendered contract page at desktop and mobile widths. Only hashes and the small
set of asserted facts are retained; screenshot binaries are not written.

Usage:
  python3 tools/capture_passport_retained_families_production_read.py
  python3 tools/capture_passport_retained_families_production_read.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "docs/evidence/passport-retained-families/fixture-readback.json"
OUTPUT = ROOT / "docs/evidence/passport-retained-families/production-read.json"
SCHEMA = "cityscroll.passport_retained_families_production_read.v1"
ORIGIN = "https://cityscroll.org"
USER_AGENT = "CityScrollEvidence/1.0 (+https://cityscroll.org)"
VIEWPORTS = (("desktop", 1440, 900), ("mobile", 390, 844))


def sha256(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def fetch(origin: str, route: str) -> tuple[int, bytes, dict[str, Any]]:
    request = urllib.request.Request(
        f"{origin}{route}",
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        body = response.read()
        status = response.status
    if status != 200:
        raise AssertionError(f"{route} returned HTTP {status}")
    return status, body, json.loads(body)


def money(value: float) -> str:
    return f"${value:,.2f}"


def assertion(fixture: dict[str, Any], assertion_id: str) -> dict[str, Any]:
    return next(item for item in fixture["assertions"] if item["id"] == assertion_id)


def contract_specs(fixture: dict[str, Any]) -> list[dict[str, Any]]:
    a1 = assertion(fixture, "A1")
    a3 = assertion(fixture, "A3")
    firematic = a1["claim"]["firematic"]
    tameer = a1["claim"]["tameer"]
    aha = a3["claim"]["aha"]
    bhrags = a3["claim"]["bhrags"]
    emitted = [*a1["artifact"]["emitted_shards"], *a3["artifact"]["emitted_shards"]]

    def procurement_id_for(ctr_id: str) -> str:
        for item in emitted:
            refs = item.get("source_observation_refs", [item.get("source_observation_ref")])
            if any(ref and ref.endswith(f":{ctr_id}") for ref in refs):
                return item["served_object"]
        raise AssertionError(f"fixture has no served object for retained ctr_id {ctr_id}")

    return [
        {
            "family": "firematic",
            "procurement_id": procurement_id_for(firematic["ctr_ids"][0]),
            "values": [
                ("original_amount", firematic["ctr_ids"][0], "award_amount", "Original contract amount", firematic["original_amount"]),
                ("current_amount", firematic["ctr_ids"][0], "current_amount", "Current contract total", firematic["current_amount"]),
                ("action_amount", firematic["ctr_ids"][1], "current_amount", "Action amount", firematic["action_amount"]),
            ],
        },
        {
            "family": "tameer",
            "procurement_id": procurement_id_for(tameer["base_ctr_id"]),
            "values": [
                ("original_amount", tameer["base_ctr_id"], "award_amount", "Original contract amount", tameer["original_amount"]),
                ("current_amount", tameer["base_ctr_id"], "current_amount", "Current contract total", tameer["current_amount"]),
                ("action_amount", tameer["action_ctr_id"], "current_amount", "Action amount", tameer["action_amount"]),
            ],
        },
        {
            "family": "aha",
            "procurement_id": procurement_id_for(aha["ctr_id"]),
            "values": [
                ("current_amount", aha["ctr_id"], "current_amount", "Current contract total", aha["current_amount"]),
            ],
        },
        {
            "family": "bhrags",
            "procurement_id": procurement_id_for(bhrags["ctr_id"]),
            "values": [
                ("paid_amount", bhrags["ctr_id"], "paid_amount", "Paid amount", bhrags["paid_amount"]),
                ("encumbered_amount", bhrags["ctr_id"], "encumbered_amount", "Encumbered amount", bhrags["encumbered_amount"]),
            ],
        },
    ]


def passport_observation(shard: dict[str, Any], procurement_id: str, ctr_id: str) -> dict[str, Any]:
    row = next(item for item in shard["rows"] if item["procurement_id"] == procurement_id)
    refs = set(row["source_observation_refs"])
    matches = [
        item for item in shard["observations"]
        if item["source_observation_ref"] in refs
        and item.get("source_system") == "passport_public_contracts"
        and str(item.get("snapshot", {}).get("ctr_id")) == ctr_id
    ]
    if len(matches) != 1:
        raise AssertionError(f"expected one deployed PASSPort observation for ctr_id {ctr_id}")
    return matches[0]


def capture() -> dict[str, Any]:
    origin = ORIGIN
    fixture = read_json(FIXTURE)
    specs = contract_specs(fixture)
    _, deployment_bytes, deployment = fetch(origin, "/artifact-manifest.json")
    _, model_bytes, model = fetch(origin, "/data/shared_procurement_read_model.json")
    revision = deployment.get("source_commit_sha")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise AssertionError("served artifact manifest has no commit revision")

    reads: list[dict[str, Any]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        browser_version = browser.version
        for spec in specs:
            procurement_id = spec["procurement_id"]
            route = f"/procurements/{urllib.parse.quote(procurement_id, safe='')}"
            shard_path = model["procurement_shard_by_id"].get(procurement_id)
            if not shard_path:
                raise AssertionError(f"deployed model has no shard for {procurement_id}")
            _, shard_bytes, shard = fetch(origin, f"/data/{shard_path}")

            served_values: dict[str, Any] = {}
            for key, ctr_id, source_field, page_label, expected in spec["values"]:
                observation = passport_observation(shard, procurement_id, ctr_id)
                actual = observation["snapshot"].get(source_field)
                if actual != expected:
                    raise AssertionError(
                        f"{spec['family']} {source_field}: deployed shard {actual!r} != fixture {expected!r}"
                    )
                served_values[key] = {
                    "source_observation_ref": observation["source_observation_ref"],
                    "ctr_id": ctr_id,
                    "shard_field": source_field,
                    "shard_value": actual,
                    "page_label": page_label,
                    "rendered_value": money(expected),
                }

            viewport_reads: list[dict[str, Any]] = []
            page_hashes: set[str] = set()
            for viewport_name, width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                response = page.goto(f"{origin}{route}", wait_until="networkidle", timeout=90_000)
                page.wait_for_function(
                    "() => document.readyState === 'complete' && document.querySelectorAll('dt').length > 0",
                    timeout=90_000,
                )
                page.wait_for_timeout(100)
                status = response.status if response else None
                if status != 200:
                    raise AssertionError(f"{route} returned HTTP {status} at {viewport_name}")
                page_facts = page.evaluate(
                    """() => Object.fromEntries([...document.querySelectorAll('dt')].map((node) => [
                      (node.textContent || '').trim(),
                      (node.nextElementSibling?.textContent || '').trim(),
                    ]))"""
                )
                rendered_values = {
                    key: page_facts.get(value["page_label"])
                    for key, value in served_values.items()
                }
                expected_values = {
                    key: value["rendered_value"]
                    for key, value in served_values.items()
                }
                if rendered_values != expected_values:
                    raise AssertionError(
                        f"{spec['family']} {viewport_name}: rendered {rendered_values!r} != {expected_values!r}"
                    )
                layout = page.evaluate(
                    """() => ({
                      scroll_width: document.documentElement.scrollWidth,
                      client_width: document.documentElement.clientWidth,
                      inner_width: window.innerWidth,
                      inner_height: window.innerHeight,
                    })"""
                )
                if layout["scroll_width"] != layout["client_width"]:
                    raise AssertionError(f"{route} has horizontal overflow at {viewport_name}")
                markup = page.content()
                screenshot = page.screenshot(full_page=True)
                page_hash = sha256(markup)
                page_hashes.add(page_hash)
                witness = {
                    "rendered_values": rendered_values,
                    "layout": layout,
                    "title": page.title(),
                }
                viewport_reads.append({
                    "name": viewport_name,
                    "width": width,
                    "height": height,
                    "http_status": status,
                    "rendered_values": rendered_values,
                    "no_horizontal_overflow": True,
                    "screenshot_sha256": sha256(screenshot),
                    "witness_sha256": sha256(json.dumps(witness, sort_keys=True, separators=(",", ":"))),
                    "result": "pass",
                })
                context.close()
            if len(page_hashes) != 1:
                raise AssertionError(f"{route} produced viewport-dependent server HTML")

            reads.append({
                "family": spec["family"],
                "procurement_id": procurement_id,
                "route": route,
                "url": f"{origin}{route}",
                "shard": {
                    "path": f"data/{shard_path}",
                    "url": f"{origin}/data/{shard_path}",
                    "sha256": sha256(shard_bytes),
                },
                "served_values": served_values,
                "page_html_sha256": next(iter(page_hashes)),
                "viewports": viewport_reads,
                "result": "pass",
            })
        browser.close()

    _, final_deployment_bytes, _ = fetch(origin, "/artifact-manifest.json")
    if final_deployment_bytes != deployment_bytes:
        raise AssertionError("served deployment changed during production read-back capture")

    return {
        "schema": SCHEMA,
        "observed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "evidence_class": "deployed-production-read-back",
        "origin": origin,
        "deployment": {
            "manifest_url": f"{origin}/artifact-manifest.json",
            "revision": revision,
            "generated_at": deployment.get("generated_at"),
            "deployment_at": deployment.get("deployment_at"),
            "manifest_sha256": sha256(deployment_bytes),
        },
        "shared_model": {
            "manifest_url": f"{origin}/data/shared_procurement_read_model.json",
            "generated_at": model.get("generated_at"),
            "object_count": model.get("row_count", len(model.get("procurement_shard_by_id", {}))),
            "manifest_sha256": sha256(model_bytes),
        },
        "capture": {
            "tool": "tools/capture_passport_retained_families_production_read.py",
            "browser": f"chromium {browser_version}",
            "viewports": [
                {"name": name, "width": width, "height": height}
                for name, width, height in VIEWPORTS
            ],
            "screenshot_binaries_committed": False,
        },
        "reads": reads,
        "freshness_policy": {
            "kind": "frozen-evidence-corpus",
            "required_gate": False,
            "reason": "Validity is content closure plus a dated deployment read-back, not elapsed age over a rolling publisher window.",
        },
        "summary": {
            "result": "pass",
            "routes_observed": len(reads),
            "viewport_observations": sum(len(read["viewports"]) for read in reads),
        },
    }


def check() -> None:
    receipt = read_json(OUTPUT)
    fixture = read_json(FIXTURE)
    specs = {item["family"]: item for item in contract_specs(fixture)}
    if receipt.get("schema") != SCHEMA:
        raise AssertionError("production read-back schema mismatch")
    if receipt.get("summary") != {
        "result": "pass",
        "routes_observed": 4,
        "viewport_observations": 8,
    }:
        raise AssertionError("production read-back summary is incomplete")
    if receipt.get("origin") != ORIGIN:
        raise AssertionError("production read-back is not from the canonical production origin")
    if receipt.get("deployment", {}).get("manifest_url") != f"{ORIGIN}/artifact-manifest.json":
        raise AssertionError("production read-back deployment manifest is not canonical")
    if receipt.get("shared_model", {}).get("manifest_url") != f"{ORIGIN}/data/shared_procurement_read_model.json":
        raise AssertionError("production read-back shared model is not canonical")
    revision = receipt.get("deployment", {}).get("revision", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise AssertionError("production read-back has no deployment revision")
    if {item.get("family") for item in receipt.get("reads", [])} != set(specs):
        raise AssertionError("production read-back does not cover the four retained families")
    for read in receipt["reads"]:
        spec = specs[read["family"]]
        if read.get("procurement_id") != spec["procurement_id"] or read.get("result") != "pass":
            raise AssertionError(f"{read.get('family')} route identity/result mismatch")
        if read.get("url") != f"{ORIGIN}{read.get('route', '')}":
            raise AssertionError(f"{read['family']} is not a canonical production route")
        shard_path = read.get("shard", {}).get("path", "")
        if read.get("shard", {}).get("url") != f"{ORIGIN}/{shard_path}":
            raise AssertionError(f"{read['family']} shard is not from canonical production")
        for digest in (read.get("page_html_sha256"), read.get("shard", {}).get("sha256")):
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise AssertionError(f"{read['family']} has an invalid artifact hash")
        expected_values = {
            key: (ctr_id, source_field, page_label, expected)
            for key, ctr_id, source_field, page_label, expected in spec["values"]
        }
        if set(read.get("served_values", {})) != set(expected_values):
            raise AssertionError(f"{read['family']} value set mismatch")
        for key, (ctr_id, source_field, page_label, expected) in expected_values.items():
            value = read["served_values"][key]
            if (value.get("ctr_id"), value.get("shard_field"), value.get("page_label"), value.get("shard_value"), value.get("rendered_value")) != (
                ctr_id, source_field, page_label, expected, money(expected)
            ):
                raise AssertionError(f"{read['family']} {key} no longer matches the retained fixture")
        if [(item.get("name"), item.get("width"), item.get("height")) for item in read.get("viewports", [])] != list(VIEWPORTS):
            raise AssertionError(f"{read['family']} viewport coverage mismatch")
        expected_rendered = {
            key: value["rendered_value"] for key, value in read["served_values"].items()
        }
        for viewport in read["viewports"]:
            if viewport.get("http_status") != 200 or viewport.get("result") != "pass":
                raise AssertionError(f"{read['family']} {viewport.get('name')} did not pass")
            if viewport.get("rendered_values") != expected_rendered:
                raise AssertionError(f"{read['family']} {viewport.get('name')} values mismatch")
            if viewport.get("no_horizontal_overflow") is not True:
                raise AssertionError(f"{read['family']} {viewport.get('name')} overflowed")
            for field in ("screenshot_sha256", "witness_sha256"):
                if not re.fullmatch(r"[0-9a-f]{64}", viewport.get(field, "")):
                    raise AssertionError(f"{read['family']} {viewport.get('name')} has no {field}")
    pointer = assertion(fixture, "A4")["claim"].get("pages_readback")
    expected_pointer = {
        "path": "docs/evidence/passport-retained-families/production-read.json",
        "schema": SCHEMA,
        "result": "pass",
        "deployment_revision": revision,
        "observed_at": receipt["observed_at"],
        "route_count": 4,
    }
    if pointer != expected_pointer:
        raise AssertionError("A4 producer pointer does not match the production read-back")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        print(f"retained-family production read-back passed: {OUTPUT.relative_to(ROOT)}")
        return 0
    receipt = capture()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(f"{json.dumps(receipt, indent=2)}\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)} summary={receipt['summary']['result']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
