#!/usr/bin/env python3
"""Capture the bounded public relationship graph at review widths.

The child server imports the production renderer and uses a deterministic,
public-shaped fixture. It does not require production D1 access.

    python3 tools/capture_public_relationship_graph.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "public-relationship-graph"
VIEWPORTS = ((390, 844), (1440, 900))

SOURCE = {
    "system": "city_record",
    "id": "20260730001",
    "url": "https://a856-cityrecord.nyc.gov/RequestDetail/20260730001",
}
OBSERVED = "2026-07-30T14:00:00.000Z"


def node(node_id: str, node_type: str, name: str) -> dict:
    return {
        "id": node_id,
        "type": node_type,
        "name": name,
        "classification": "source_assertion",
        "provenance": {
            "source": SOURCE,
            "source_fields": ["type_of_notice_description"],
            "observed_at": OBSERVED,
        },
        "confidence": {"status": "not_scored", "basis": "publisher_record"},
    }


def edge(edge_type: str, label: str, from_id: str, to_id: str, fields: list[str]) -> dict:
    return {
        "id": f"edge:{edge_type}:{from_id}:{to_id}",
        "type": edge_type,
        "label": label,
        "from": from_id,
        "to": to_id,
        "provenance": {
            "source": SOURCE,
            "source_fields": fields,
            "observed_at": OBSERVED,
        },
        "confidence": {"status": "not_scored", "basis": "publisher_record"},
    }


ROOT_ID = "vendor:stem:ACME CONSTRUCTION"
AWARD_ID = "award:city_record:20260730001"
AGENCY_ID = "agency:name:department%20of%20design%20and%20construction"
CONTRACT_ID = "contract:name:ct-850-1"

GRAPH = {
    "version": "public_relationship_graph_v2",
    "root": {"id": ROOT_ID, "type": "vendor", "name": "Acme Construction LLC"},
    "bounds": {
        "requested_depth": 2,
        "applied_depth": 2,
        "max_depth": 2,
        "requested_fan_out": 12,
        "applied_fan_out": 12,
        "max_fan_out": 25,
        "truncated": False,
        "boundary_reached": [],
        "note": (
            "This graph is limited to the displayed linked public records; "
            "absence is not proof that no relationship exists."
        ),
    },
    "scope": {
        "completeness": "linked_public_records_only",
        "observed_from": OBSERVED,
        "observed_through": OBSERVED,
    },
    "nodes": [
        {
            "id": ROOT_ID,
            "type": "vendor",
            "name": "Acme Construction LLC",
            "classification": "canonical_entity",
            "confidence": {"status": "not_published", "basis": "canonical_link"},
        },
        node(AWARD_ID, "award", "Bridge inspection services"),
        node(AGENCY_ID, "agency", "Department of Design and Construction"),
        node(CONTRACT_ID, "contract", "Contract CT-850-1"),
    ],
    "edges": [
        edge(
            "named_vendor_on_award",
            "Named vendor on award",
            ROOT_ID,
            AWARD_ID,
            ["type_of_notice_description", "vendor_name"],
        ),
        edge(
            "published_by_agency",
            "Published by agency",
            AWARD_ID,
            AGENCY_ID,
            ["agency_name", "type_of_notice_description"],
        ),
        edge(
            "references_contract",
            "References contract",
            AWARD_ID,
            CONTRACT_ID,
            ["contract_id", "type_of_notice_description"],
        ),
    ],
}

SERVER_SOURCE = r"""
import http from "node:http";
import { renderPublicRelationshipGraphPage } from "./worker/src/public_relationship_graph.mjs";
const graph = JSON.parse(process.env.RELATIONSHIP_GRAPH_CAPTURE_JSON);
const html = renderPublicRelationshipGraphPage(graph);
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
    environment["RELATIONSHIP_GRAPH_CAPTURE_JSON"] = json.dumps(GRAPH)
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
                page.get_by_text("Relationship evidence", exact=True).wait_for()
                assert page.locator("table").count() == 1
                assert page.locator("[data-edge-type]").count() == len(GRAPH["edges"])
                overflow = page.evaluate(
                    "document.documentElement.scrollWidth > document.documentElement.clientWidth"
                )
                assert overflow is False
                page.screenshot(
                    path=str(OUT / f"public-relationship-graph-{width}.png"),
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
