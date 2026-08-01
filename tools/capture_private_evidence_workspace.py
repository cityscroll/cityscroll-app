#!/usr/bin/env python3
"""Capture the authenticated private evidence workspace at review widths.

The local server imports the production renderer and uses a deterministic,
public-record-shaped fixture. It does not access production D1 data.

    python3 tools/capture_private_evidence_workspace.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "private-evidence-workspace"
VIEWPORTS = ((390, 844), (1440, 900))


def record(source: str, key: str, name: str, amount: str) -> dict:
    return {
        "id": f"{source}:{key}:fixture-hash",
        "name": name,
        "source": source,
        "source_record_key": key,
        "source_url": f"https://example.test/{source}/{key}",
        "observed_at": "2026-08-01T12:00:00.000Z",
        "observed_fields": {"vendor_name": name, "contract_amount": amount},
    }


RECORDS = [
    record("city_record", "notice-1", "Acme Construction LLC", "$100"),
    record("checkbook", "contract-1", "Acme Builders Inc", "$125"),
    record("passport", "vendor-1", "Builders Group LLC", "$150"),
]


def assertion(item: dict) -> dict:
    return {
        "classification": "source_assertion",
        "source_system": item["source"],
        "source_system_id": item["source_record_key"],
        "source_record_id": item["id"],
        "source_url": item["source_url"],
        "source_field": "contract_amount",
        "value": item["observed_fields"]["contract_amount"],
        "recorded_at": item["observed_at"],
    }


WORKSPACE = {
    "version": "private_evidence_workspace_v1",
    "id": "pair-a",
    "entity_type": "vendor",
    "status": "investigation",
    "scope": {
        "candidate_pairs": 2,
        "source_rails": 3,
        "source_records": 3,
        "note": (
            "This case contains connected review leads only. It does not establish "
            "identity or select a canonical assertion."
        ),
    },
    "sources": [
        {"source": item["source"], "records": [item]}
        for item in RECORDS
    ],
    "assertions": [{
        "fact": "contract_amount",
        "label": "Contract amount",
        "kind": "amount",
        "assertions": [assertion(item) for item in RECORDS],
        "interpretations": [{
            "pair_id": "pair-a",
            "classification": "cityscroll_interpretation",
            "status": "conflict",
            "resolution": "unresolved",
            "summary": "The publisher values differ; neither is selected.",
        }],
    }],
    "comparisons": [
        {
            "id": "pair-a",
            "method": "token_v0",
            "matcher_version": "token_v0_v0",
            "confidence": None,
            "record_ids": [RECORDS[0]["id"], RECORDS[1]["id"]],
            "shared_keys": ["tok:ACME"],
            "comparison_features": {},
        },
        {
            "id": "pair-b",
            "method": "token_v0",
            "matcher_version": "token_v0_v0",
            "confidence": None,
            "record_ids": [RECORDS[1]["id"], RECORDS[2]["id"]],
            "shared_keys": ["tok:BUILDERS"],
            "comparison_features": {},
        },
    ],
}

SERVER_SOURCE = r"""
import http from "node:http";
import { renderInvestigationWorkspacePage } from "./worker/src/admin.mjs";
const workspace = JSON.parse(process.env.WORKSPACE_CAPTURE_JSON);
const html = renderInvestigationWorkspacePage(
  workspace,
  { "pair-a": [], "pair-b": [] },
  "https://worker.test/admin/possibly-same?key=fixture&pair=pair-a",
);
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
    environment["WORKSPACE_CAPTURE_JSON"] = json.dumps(WORKSPACE)
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
                page.get_by_text("Publisher evidence rails").wait_for()
                assert page.get_by_text("Source assertion", exact=True).count() == 3
                assert page.get_by_text("CityScroll interpretation", exact=True).count() == 1
                overflow = page.evaluate(
                    "document.documentElement.scrollWidth > document.documentElement.clientWidth"
                )
                assert overflow is False
                page.screenshot(
                    path=str(OUT / f"private-evidence-workspace-{width}.png"),
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
