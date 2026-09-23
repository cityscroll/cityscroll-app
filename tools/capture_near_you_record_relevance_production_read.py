#!/usr/bin/env python3
"""Capture the live production record-relevance journey for a Near You place.

Renders the deployed Near You records surface for the Tribeca-Civic Center
neighborhood fixture in headless Chromium at desktop and mobile widths and
runs the acceptance journey end to end: every exact neighborhood record shows
its place basis and dated event-or-deadline status, broader district
suggestions stay labeled broader and outside the exact count, and select,
inspect, source/action handoff, and Back restore place, lens, filters, and
scroll. Live counts are observed, never pinned; only hashes and bounded
journey facts are retained. Screenshot binaries are not written.

Usage:
  python3 tools/capture_near_you_record_relevance_production_read.py
  python3 tools/capture_near_you_record_relevance_production_read.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/evidence/near-you-record-relevance/acceptance-manifest.json"
OUTPUT = ROOT / "docs/evidence/near-you-record-relevance/production-read.json"
SCHEMA = "cityscroll.near_you_record_relevance_production_read.v1"
ORIGIN = "https://cityscroll.org"
API_ORIGIN = "https://api.cityscroll.org"
USER_AGENT = "CityScrollEvidence/1.0 (+https://cityscroll.org)"
VIEWPORTS = (("desktop", 1440, 900), ("mobile", 390, 844))
ROUTE = "/near-you/?geo=nta2020%3AMN0102&lens=meetings&surface=records"

TIMING_STATES = ("past", "closed", "upcoming", "unknown")
UNDATED_LABELS = (
    "Date not published",
    "Deadline date not published",
    "Event date not published",
)
DATED_LABEL_RE = re.compile(r"\b[A-Z][a-z]{2} \d{1,2}, \d{4}\b")
BROADER_COPY_FRAGMENT = "not counted as exact neighborhood records"


def sha256(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def uncached_url(origin: str, route: str, token: str | None = None) -> str:
    separator = "&" if "?" in route else "?"
    cache_token = token or secrets.token_hex(12)
    return f"{origin}{route}{separator}_cityscroll_evidence={cache_token}"


def fetch(origin: str, route: str, accept: str = "application/json") -> tuple[int, bytes]:
    request = urllib.request.Request(
        uncached_url(origin, route),
        headers={
            "Accept": accept,
            "Cache-Control": "no-cache, no-store",
            "Pragma": "no-cache",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def fetch_json(origin: str, route: str) -> tuple[int, bytes, Any]:
    status, body = fetch(origin, route)
    return status, body, json.loads(body)


def audit_records(page: Any, viewport_name: str) -> dict[str, Any]:
    """Every exact neighborhood record carries a place basis and an honest dated status."""
    records = page.evaluate(
        """() => [...document.querySelectorAll('section.near-results .near-record')].map((row) => {
          const basis = row.querySelector('.near-record-basis');
          const timing = row.querySelector('.near-record-timing');
          return {
            id: row.getAttribute('data-record-id'),
            basis: basis ? basis.textContent.replace(/\\s+/g, ' ').trim() : null,
            timing: timing ? {
              label: timing.textContent.replace(/\\s+/g, ' ').trim(),
              state: timing.getAttribute('data-record-timing'),
              action_open: timing.getAttribute('data-action-open'),
            } : null,
          };
        })"""
    )
    if not records:
        raise AssertionError(f"{viewport_name}: no exact neighborhood records rendered")
    distribution: dict[str, int] = {}
    for record in records:
        rid = record["id"] or "unknown"
        if not record["basis"]:
            raise AssertionError(f"{viewport_name}: {rid} shows no place basis")
        timing = record["timing"]
        if not timing or timing["state"] not in TIMING_STATES:
            raise AssertionError(f"{viewport_name}: {rid} has no typed deadline status")
        if (timing["action_open"] == "true") != (timing["state"] == "upcoming"):
            raise AssertionError(f"{viewport_name}: {rid} action availability contradicts its status")
        if timing["state"] == "unknown":
            if timing["label"] not in UNDATED_LABELS:
                raise AssertionError(f"{viewport_name}: {rid} unknown time must not imply a date")
        elif not DATED_LABEL_RE.search(timing["label"]):
            raise AssertionError(f"{viewport_name}: {rid} status is not dated: {timing['label']!r}")
        distribution[timing["state"]] = distribution.get(timing["state"], 0) + 1
    return {
        "records_observed": len(records),
        "timing_state_distribution": distribution,
        "sample": [
            {
                "id": record["id"],
                "basis": record["basis"],
                "timing": record["timing"],
            }
            for record in records[:3]
        ],
    }


def audit_broader_suggestions(page: Any, viewport_name: str, exact_count: int) -> dict[str, Any]:
    section = page.query_selector("[data-geography-broader-suggestions]")
    if section is None:
        raise AssertionError(f"{viewport_name}: broader district suggestions are not rendered")
    copy_text = section.text_content() or ""
    if BROADER_COPY_FRAGMENT not in re.sub(r"\s+", " ", copy_text):
        raise AssertionError(f"{viewport_name}: broader suggestions do not disclose exclusion from exact counts")
    rows = page.evaluate(
        """() => [...document.querySelectorAll('[data-geography-related-district]')].map((row) => ({
          scope: row.getAttribute('data-geography-related-scope'),
          key: row.getAttribute('data-geography-key'),
          label: (row.querySelector('a')?.textContent || '').trim(),
          href: row.querySelector('a')?.getAttribute('href') || null,
          badge: (row.querySelector('.near-geo-broader-label')?.textContent || '').trim(),
        }))"""
    )
    if not rows:
        raise AssertionError(f"{viewport_name}: broader suggestions section has no districts")
    for row in rows:
        if row["scope"] != "broader" or row["badge"] != "broader":
            raise AssertionError(f"{viewport_name}: district {row['key']} is not labeled broader")
        if not row["href"]:
            raise AssertionError(f"{viewport_name}: district {row['key']} has no destination")
    return {
        "section_present": True,
        "districts": rows,
        "excluded_from_exact_count": exact_count,
        "disclosure": BROADER_COPY_FRAGMENT,
    }


def run_journey(page: Any, viewport_name: str, origin: str) -> dict[str, Any]:
    results = page.query_selector("section.near-results")
    count_text = results.get_attribute("data-results-count")
    if count_text is None:
        raise AssertionError(f"{viewport_name}: exact neighborhood count is not published")
    exact_count = int(count_text)

    records_audit = audit_records(page, viewport_name)
    if records_audit["records_observed"] != exact_count:
        raise AssertionError(
            f"{viewport_name}: rendered {records_audit['records_observed']} records but count says {exact_count}"
        )
    broader = audit_broader_suggestions(page, viewport_name, exact_count)

    scope_before = page.evaluate(
        """() => ({
          url: location.href,
          geo: new URLSearchParams(location.search).get('geo'),
          lens: new URLSearchParams(location.search).get('lens'),
          surface: new URLSearchParams(location.search).get('surface'),
        })"""
    )

    # select -> inspect
    page.evaluate(
        """() => {
          const button = document.querySelector('section.near-results .near-record .near-record-inspect');
          button.scrollIntoView({ block: 'center' });
          button.click();
        }"""
    )
    page.wait_for_selector("#near-you-record-inspection[open]", timeout=30_000)
    pre_navigation_scroll = page.evaluate("() => Math.round(window.scrollY)")
    dialog = page.evaluate(
        """() => {
          const dlg = document.querySelector('#near-you-record-inspection[open]');
          const text = dlg.textContent.replace(/\\s+/g, ' ').trim();
          const source = dlg.querySelector('[data-near-you-record-source]');
          const action = dlg.querySelector('[data-near-you-record-inspection-open]');
          const timing = dlg.querySelector('[data-record-timing]');
          return {
            text,
            basis_seen: /Place claim|Venue|Affected|Happening here/.test(text),
            status_seen: /Status/.test(text),
            timing: timing ? {
              label: timing.textContent.replace(/\\s+/g, ' ').trim(),
              state: timing.getAttribute('data-record-timing'),
              action_open: timing.getAttribute('data-action-open'),
            } : null,
            source_href: source ? source.getAttribute('href') : null,
            action_href: action ? action.getAttribute('href') : null,
            action_label: action ? action.textContent.replace(/\\s+/g, ' ').trim() : null,
            action_open: action ? action.getAttribute('data-action-open') : null,
          };
        }"""
    )
    if not dialog["basis_seen"] or dialog["timing"] is None:
        raise AssertionError(f"{viewport_name}: inspection does not show place basis and dated status")
    if not dialog["source_href"] or not dialog["source_href"].startswith("https://"):
        raise AssertionError(f"{viewport_name}: inspection has no source detail link")
    if not dialog["action_href"]:
        raise AssertionError(f"{viewport_name}: inspection has no full-record action")
    if (dialog["action_open"] == "true") != (dialog["timing"]["state"] == "upcoming"):
        raise AssertionError(f"{viewport_name}: inspection action contradicts its deadline status")

    # source/action handoff -> full record
    page.click("[data-near-you-record-inspection-open]")
    page.wait_for_load_state("networkidle", timeout=90_000)
    page.wait_for_timeout(300)
    destination = page.evaluate("() => ({ url: location.href, title: document.title })")
    if destination["url"].split("?")[0] != dialog["action_href"].split("?")[0]:
        raise AssertionError(f"{viewport_name}: action handoff landed somewhere else: {destination['url']}")

    # Back restores place, lens, filters, and scroll
    page.go_back(wait_until="networkidle", timeout=90_000)
    page.wait_for_selector("section.near-results .near-record", timeout=90_000)
    page.wait_for_selector("[data-geography-broader-suggestions]", timeout=90_000)
    # Deferred results and overlap chrome can reflow after the first paint; wait
    # until the restored offset is stable at the pre-navigation point.
    restored = None
    restore_checks = None
    for _ in range(40):
        page.wait_for_timeout(50)
        restored = page.evaluate(
            """() => ({
              url: location.href,
              scrollY: Math.round(window.scrollY),
              count: document.querySelector('section.near-results')?.getAttribute('data-results-count'),
              broader: !!document.querySelector('[data-geography-broader-suggestions]'),
              deferred: document.querySelector('[data-near-deferred-state]')?.getAttribute('data-near-deferred-state'),
            })"""
        )
        restore_checks = {
            "url": restored["url"] == scope_before["url"],
            "place_lens_filters": all(
                restored["url"].find(f"{name}={scope_before[name] if name != 'geo' else 'nta2020%3AMN0102'}") != -1
                for name in ("lens", "surface")
            ) and "nta2020%3AMN0102" in restored["url"],
            "exact_count": restored["count"] == str(exact_count),
            "broader_suggestions": restored["broader"] is True,
            "deferred_ready": restored["deferred"] == "ready",
            "scroll": abs(restored["scrollY"] - pre_navigation_scroll) <= 2,
        }
        if all(restore_checks.values()):
            break
    if not restore_checks or not all(restore_checks.values()):
        raise AssertionError(f"{viewport_name}: Back did not restore the journey state: {restore_checks}")

    layout = page.evaluate(
        """() => ({
          scroll_width: document.documentElement.scrollWidth,
          client_width: document.documentElement.clientWidth,
          inner_width: window.innerWidth,
        })"""
    )
    if layout["scroll_width"] != layout["client_width"]:
        raise AssertionError(f"{viewport_name}: records surface has horizontal overflow")

    markup = page.content()
    screenshot = page.screenshot(full_page=True)
    witness = {
        "viewport": viewport_name,
        "exact_count": exact_count,
        "timing_state_distribution": records_audit["timing_state_distribution"],
        "broader_districts": [row["key"] for row in broader["districts"]],
        "inspected": {
            "source_href": dialog["source_href"],
            "action_href": dialog["action_href"],
            "timing": dialog["timing"],
        },
        "restored": restored,
        "restore_checks": restore_checks,
        "layout": layout,
        "title": page.title(),
    }
    return {
        "exact_count": exact_count,
        "records": records_audit,
        "broader_suggestions": broader,
        "journey": {
            "sequence": ["select", "inspect", "open_source_or_action", "return_with_back", "continue"],
            "inspected_record": {
                "source_href": dialog["source_href"],
                "action_href": dialog["action_href"],
                "action_label": dialog["action_label"],
                "timing": dialog["timing"],
            },
            "destination": destination,
            "pre_navigation_scroll_y": pre_navigation_scroll,
            "restored": restored,
            "restore_checks": restore_checks,
        },
        "no_horizontal_overflow": True,
        "page_html_sha256": sha256(markup),
        "screenshot_sha256": sha256(screenshot),
        "witness_sha256": sha256(json.dumps(witness, sort_keys=True, separators=(",", ":"))),
        "result": "pass",
    }


def capture() -> dict[str, Any]:
    origin = ORIGIN
    manifest_status, manifest_bytes, manifest = fetch_json(origin, "/artifact-manifest.json")
    if manifest_status != 200:
        raise AssertionError("artifact manifest did not return HTTP 200")
    revision = manifest.get("source_commit_sha")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise AssertionError("served artifact manifest has no commit revision")
    health_status, _health_bytes, health = fetch_json(API_ORIGIN, "/health")
    if health_status != 200 or health.get("environment") != "production":
        raise AssertionError("worker health did not confirm production")

    viewport_reads: list[dict[str, Any]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        browser_version = browser.version
        for viewport_name, width, height in VIEWPORTS:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                extra_http_headers={
                    "Cache-Control": "no-cache, no-store",
                    "Pragma": "no-cache",
                },
            )
            page = context.new_page()
            response = page.goto(
                uncached_url(origin, ROUTE),
                wait_until="networkidle",
                timeout=90_000,
            )
            page.wait_for_selector("section.near-results .near-record", timeout=90_000)
            page.wait_for_timeout(150)
            status = response.status if response else None
            if status != 200:
                raise AssertionError(f"{ROUTE} returned HTTP {status} at {viewport_name}")
            read = run_journey(page, viewport_name, origin)
            read["http_status"] = status
            viewport_reads.append({
                "name": viewport_name,
                "width": width,
                "height": height,
                **read,
            })
            context.close()
        browser.close()

    final_status, final_manifest_bytes, _ = fetch_json(origin, "/artifact-manifest.json")
    if final_status != 200 or final_manifest_bytes != manifest_bytes:
        raise AssertionError("served deployment changed during production read-back capture")

    return {
        "schema": SCHEMA,
        "observed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "evidence_class": "deployed-production-read-back",
        "origin": origin,
        "api_origin": API_ORIGIN,
        "deployment": {
            "manifest_url": f"{origin}/artifact-manifest.json",
            "revision": revision,
            "generated_at": manifest.get("generated_at"),
            "deployment_at": manifest.get("deployment_at"),
            "artifact_hash": manifest.get("artifact_hash"),
            "manifest_sha256": sha256(manifest_bytes),
        },
        "worker": {
            "health_url": f"{API_ORIGIN}/health",
            "commit": health.get("commit"),
            "environment": health.get("environment"),
        },
        "capture": {
            "tool": "tools/capture_near_you_record_relevance_production_read.py",
            "browser": f"chromium {browser_version}",
            "route": ROUTE,
            "url": f"{origin}{ROUTE}",
            "viewports": [
                {"name": name, "width": width, "height": height}
                for name, width, height in VIEWPORTS
            ],
            "screenshot_binaries_committed": False,
            "fixed_event_count_required": False,
        },
        "viewports": viewport_reads,
        "summary": {
            "result": "pass",
            "viewport_observations": len(viewport_reads),
        },
    }


def validate(production_read: dict[str, Any], manifest: dict[str, Any]) -> None:
    if production_read.get("schema") != SCHEMA:
        raise AssertionError("production read-back schema mismatch")
    if production_read.get("origin") != ORIGIN or production_read.get("api_origin") != API_ORIGIN:
        raise AssertionError("production read-back is not from the canonical production origins")
    if production_read.get("capture", {}).get("route") != ROUTE:
        raise AssertionError("production read-back is not the canonical neighborhood route")
    revision = production_read.get("deployment", {}).get("revision", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise AssertionError("production read-back has no deployment revision")
    if not re.fullmatch(r"[0-9a-f]{40}", production_read.get("worker", {}).get("commit", "")):
        raise AssertionError("production read-back has no worker commit")
    if production_read.get("summary", {}).get("result") != "pass":
        raise AssertionError("production read-back did not pass")

    reads = production_read.get("viewports", [])
    if [(read.get("name"), read.get("width"), read.get("height")) for read in reads] != list(VIEWPORTS):
        raise AssertionError("production read-back viewport coverage mismatch")
    for read in reads:
        if read.get("result") != "pass" or read.get("http_status") != 200:
            raise AssertionError(f"{read.get('name')} journey did not pass")
        if not isinstance(read.get("exact_count"), int) or read["exact_count"] < 1:
            raise AssertionError(f"{read.get('name')} observed no exact neighborhood records")
        records = read.get("records", {})
        if records.get("records_observed") != read["exact_count"]:
            raise AssertionError(f"{read.get('name')} exact count was not the rendered record count")
        distribution = records.get("timing_state_distribution", {})
        if not distribution or any(state not in TIMING_STATES for state in distribution):
            raise AssertionError(f"{read.get('name')} has an untyped deadline status")
        broader = read.get("broader_suggestions", {})
        if broader.get("section_present") is not True or not broader.get("districts"):
            raise AssertionError(f"{read.get('name')} lost its broader district suggestions")
        for row in broader["districts"]:
            if row.get("scope") != "broader" or row.get("badge") != "broader":
                raise AssertionError(f"{read.get('name')} broader district lost its label")
        journey = read.get("journey", {})
        restore = journey.get("restore_checks", {})
        for key in ("url", "place_lens_filters", "exact_count", "broader_suggestions", "scroll"):
            if restore.get(key) is not True:
                raise AssertionError(f"{read.get('name')} Back did not restore {key}")
        inspected = journey.get("inspected_record", {})
        if not str(inspected.get("source_href", "")).startswith("https://"):
            raise AssertionError(f"{read.get('name')} inspected record has no source link")
        if not inspected.get("action_href"):
            raise AssertionError(f"{read.get('name')} inspected record has no action handoff")
        if read.get("no_horizontal_overflow") is not True:
            raise AssertionError(f"{read.get('name')} overflowed")
        for field in ("page_html_sha256", "screenshot_sha256", "witness_sha256"):
            if not re.fullmatch(r"[0-9a-f]{64}", read.get(field, "")):
                raise AssertionError(f"{read.get('name')} has no {field}")

    pointer = manifest.get("live_outcomes", {}).get("production_read")
    if pointer != {
        "path": "docs/evidence/near-you-record-relevance/production-read.json",
        "schema": SCHEMA,
        "result": "pass",
    }:
        raise AssertionError("acceptance manifest does not point at this production read-back")
    serialized = json.dumps(production_read) + json.dumps(manifest)
    if "/Users/" in serialized or "file://" in serialized:
        raise AssertionError("evidence artifact contains a local path reference")


def check() -> None:
    validate(read_json(OUTPUT), read_json(MANIFEST))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        print(f"near-you record-relevance production read-back passed: {OUTPUT.relative_to(ROOT)}")
        return 0
    receipt = capture()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(f"{json.dumps(receipt, indent=2, ensure_ascii=False)}\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)} summary={receipt['summary']['result']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
