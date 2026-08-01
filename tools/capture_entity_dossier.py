#!/usr/bin/env python3
"""Capture the public entity dossier at review widths.

The child server imports the production renderer. Its data is a deterministic,
public-shaped fixture so the capture never needs production D1 access.

    python3 tools/capture_entity_dossier.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "entity-dossier"
VIEWPORTS = ((390, 844), (1440, 900))

SOURCE_ASSERTIONS = [
    {
        "id": "assertion:city_record:20260730001:contract_amount:2026-07-30",
        "classification": "source_assertion",
        "value": "$100.00",
        "provenance": {
            "source": {
                "system": "city_record",
                "id": "20260730001",
                "url": "https://a856-cityrecord.nyc.gov/RequestDetail/20260730001",
            },
            "source_field": "contract_amount",
            "observed_at": "2026-07-30T14:00:00.000Z",
        },
        "derivation": {"status": "observed", "evidence_assertion_ids": []},
        "confidence": {"status": "not_scored"},
        "review": {"status": "not_public"},
    },
    {
        "id": "assertion:checkbook:CT-850-1:contract_amount:2026-08-01",
        "classification": "source_assertion",
        "value": "125.00",
        "provenance": {
            "source": {
                "system": "checkbook",
                "id": "CT-850-1",
                "url": "https://www.checkbooknyc.com/contract/CT-850-1",
            },
            "source_field": "prime_contract_current_amount",
            "observed_at": "2026-08-01T09:30:00.000Z",
        },
        "derivation": {"status": "observed", "evidence_assertion_ids": []},
        "confidence": {"status": "not_scored"},
        "review": {"status": "not_public"},
    },
]

DOSSIER = {
    "version": "public_entity_dossier_v1",
    "entity": {
        "id": "vendor:stem:ACME CONSTRUCTION",
        "type": "vendor",
        "name": "Acme Construction LLC",
    },
    "scope": {
        "sources": ["checkbook", "city_record"],
        "observed_from": "2026-07-30T14:00:00.000Z",
        "observed_through": "2026-08-01T09:30:00.000Z",
        "completeness": "linked_records_only",
        "note": (
            "This dossier is limited to the listed linked sources and observation "
            "period. Absence is not proof that no record exists."
        ),
    },
    "linked_records": [
        {
            "entity_id": "vendor:stem:ACME CONSTRUCTION",
            "source": SOURCE_ASSERTIONS[0]["provenance"]["source"],
            "observed_at": "2026-07-30T14:00:00.000Z",
        },
        {
            "entity_id": "vendor:stem:ACME CONSTRUCTION",
            "source": SOURCE_ASSERTIONS[1]["provenance"]["source"],
            "observed_at": "2026-08-01T09:30:00.000Z",
        },
    ],
    "assertions": [
        {
            "fact": "contract_amount",
            "label": "Contract amount",
            "status": "disagreement",
            "assertions": SOURCE_ASSERTIONS,
            "disagreement": (
                "Linked sources report different values; this dossier does not select a winner."
            ),
        },
        {
            "fact": "due_date",
            "label": "Due date",
            "status": "not_observed",
            "assertions": [],
            "missingness": "Not observed in the source records linked to this dossier.",
        },
    ],
    "derived_assertions": [
        {
            "id": "vendor:acme:assertion:canonical_name",
            "fact": "canonical_name",
            "label": "Dossier name",
            "classification": "derived_conclusion",
            "value": "Acme Construction LLC",
            "provenance": {
                "source": {"system": "cityscroll", "id": "vendor:stem:ACME CONSTRUCTION"},
                "observed_at": "2026-08-01T09:30:00.000Z",
            },
            "derivation": {
                "status": "derived",
                "evidence_assertion_ids": ["assertion:name:a", "assertion:name:b"],
            },
            "confidence": {"status": "not_published"},
            "review": {"status": "not_public"},
        },
    ],
}

SERVER_SOURCE = r"""
import http from "node:http";
import { renderEntityDossierPage } from "./worker/src/entity_dossier.mjs";
const dossier = JSON.parse(process.env.DOSSIER_CAPTURE_JSON);
const html = renderEntityDossierPage(dossier);
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port) + "\n");
});
"""


def capture() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    environment["DOSSIER_CAPTURE_JSON"] = json.dumps(DOSSIER)
    server = subprocess.Popen(
        ["node", "--input-type=module", "--eval", SERVER_SOURCE],
        cwd=ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert server.stdout is not None
        port = int(server.stdout.readline().strip())
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.goto(f"http://127.0.0.1:{port}", wait_until="domcontentloaded")
                page.get_by_text("Linked sources report different values").wait_for()
                assert page.get_by_text("Not observed", exact=True).count() == 1
                overflow = page.evaluate(
                    "document.documentElement.scrollWidth > document.documentElement.clientWidth"
                )
                assert overflow is False
                page.screenshot(
                    path=str(OUT / f"entity-dossier-{width}.png"),
                    full_page=True,
                )
                page.close()
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)


if __name__ == "__main__":
    capture()
    for image in sorted(OUT.glob("*.png")):
        print(f"{image.relative_to(ROOT)} ({image.stat().st_size} bytes)")
