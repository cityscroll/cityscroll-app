#!/usr/bin/env python3
"""Production read-back for the searchable residential directory (A1/A2).

Hits the live served origin with headless Chromium. Commits textual receipts
only; optional screenshots stay under the task scratch directory.

A1 records observed borough groupings and reachable special-use entries.
A2 strips scripts from the served document (same strip used by the rendered
schema journey), loads the markup without JavaScript, and records surviving
native links, keyboard targets, alias/no-match behavior, and whether a
location-permission prompt was observed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "residential-directory-production-read"
OUT_DIR = ROOT / "docs/evidence/residential-directory-readback"
READBACK = OUT_DIR / "read-back.json"
MANIFEST = OUT_DIR / "capture-manifest.json"

PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
ARTIFACT_UA = "cityscroll-residential-directory-capture/1"
DEFAULT_BASE = "https://cityscroll.org/"
PUBLIC_ALIAS = "cd5ed919f3be2"
SCHEMA = "cityscroll.residential_directory_production_read.v1"
DATA_VINTAGE = "nta2020 26B"

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)

# Named special-use specimens that must remain explicitly reachable.
SPECIAL_USE_SPECIMENS = (
    ("QN8381", "John F. Kennedy International Airport"),
    ("BK0771", "Green-Wood Cemetery"),
)

ALIAS_ROUTE = "/near-you/?area_q=Tribeca"
ALIAS_EXPECTED_ID = "MN0102"
NOMATCH_ROUTE = "/near-you/?area_q=zzz-no-such-neighborhood"
ENTRY_ROUTE = "/near-you/"

SCRIPT_RE = re.compile(r"<script\b[\s\S]*?</script\s*>", re.I)


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def resolve_base() -> str:
    raw = (os.environ.get("CROL_BASE") or DEFAULT_BASE).strip()
    base = normalize_base(raw)
    host = (urllib.parse.urlparse(base).hostname or "").lower()
    if host not in PRODUCTION_HOSTS:
        raise RuntimeError(f"production read-back requires a cityscroll.org base, got {base}")
    return base


def read_artifact_manifest(base: str) -> dict:
    url = f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": ARTIFACT_UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        raise RuntimeError(f"deployed build revision unavailable at {url}: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"artifact-manifest at {url} is not an object")
    return payload


def deployed_revision(manifest: dict) -> str:
    sha = manifest.get("source_commit_sha")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("artifact-manifest lacks a 40-hex source_commit_sha")
    return sha


def fetch_html(base: str, route: str) -> str:
    url = f"{normalize_base(base).rstrip('/')}{route}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": ARTIFACT_UA, "Accept": "text/html"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read().decode("utf-8", "replace")


def strip_scripts(html: str) -> str:
    """Remove script elements from a served document before no-JS observation."""
    return SCRIPT_RE.sub("", html)


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def section_for_borough(html: str, borough: str) -> str:
    match = re.search(
        rf'data-geography-borough-group="{re.escape(borough)}"[\s\S]*?</section>',
        html,
    )
    return match.group(0) if match else ""


def list_block(html: str, marker: str) -> str:
    match = re.search(rf'{marker}[\s\S]*?</details>', html)
    return match.group(0) if match else ""


def area_ids(markup: str) -> list[str]:
    return re.findall(r'data-map-area="([^"]+)"', markup)


def area_labels(markup: str) -> list[str]:
    labels = []
    for _area_id, inner in re.findall(
        r'<a[^>]*data-map-area="([^"]+)"[^>]*>([\s\S]*?)</a>',
        markup,
    ):
        text = re.sub(r"<[^>]+>", "", inner)
        labels.append(re.sub(r"\s+", " ", text).strip())
    return labels


def observe_a1_from_html(html: str) -> dict:
    boroughs = re.findall(r'data-geography-borough-group="([^"]+)"', html)
    groups = []
    for borough in boroughs:
        section = section_for_borough(html, borough)
        ids = area_ids(section)
        labels = area_labels(section)
        groups.append(
            {
                "borough": borough,
                "residential_count": len(ids),
                "sample_ids": ids[:5],
                "sample_labels": labels[:5],
            }
        )

    residential_block = list_block(html, 'data-geography-directory-list')
    special_block = list_block(html, 'data-geography-special-use-directory')
    residential_ids = area_ids(residential_block)
    special_ids = area_ids(special_block)

    summary_match = re.search(
        r'data-geography-directory-summary[^>]*>([^<]+)',
        html,
    )
    summary_text = summary_match.group(1).strip() if summary_match else None
    special_summary = None
    special_summary_match = re.search(
        r'data-geography-special-use-directory[\s\S]*?<summary>([^<]+)</summary>',
        html,
    )
    if special_summary_match:
        special_summary = special_summary_match.group(1).strip()
    special_note_match = re.search(
        r'class="near-area-special-use-note"[^>]*>([^<]+)',
        html,
    )
    special_note = special_note_match.group(1).strip() if special_note_match else None

    special_label_by_id = {}
    for specimen_id, label_text in zip(special_ids, area_labels(special_block)):
        special_label_by_id[specimen_id] = label_text
    named_special = []
    for specimen_id, label in SPECIAL_USE_SPECIMENS:
        named_special.append(
            {
                "id": specimen_id,
                "expected_label": label,
                "in_special_use_directory": specimen_id in special_ids,
                "in_residential_directory": specimen_id in residential_ids,
                "observed_label": special_label_by_id.get(specimen_id),
            }
        )

    # Classify a few special-use labels by keyword for the receipt.
    airport_ids = [i for i, lab in special_label_by_id.items() if re.search(r"airport", lab, re.I)]
    park_ids = [i for i, lab in special_label_by_id.items() if re.search(r"\bpark\b", lab, re.I)]
    cemetery_ids = [i for i, lab in special_label_by_id.items() if re.search(r"cemetery", lab, re.I)]

    return {
        "route": ENTRY_ROUTE,
        "directory_summary_text": summary_text,
        "borough_group_order": boroughs,
        "borough_groups": groups,
        "residential_link_count": len(residential_ids),
        "special_use": {
            "summary_label": special_summary,
            "note": special_note,
            "link_count": len(special_ids),
            "named_reachable": named_special,
            "airport_ids_sample": airport_ids[:8],
            "park_ids_sample": park_ids[:8],
            "cemetery_ids_sample": cemetery_ids[:8],
        },
        "filter_control": {
            "form_method_get": bool(re.search(r'<form[^>]*class="near-area-directory-filter"[^>]*method="get"', html)),
            "param_name": "area_q" if 'name="area_q"' in html else None,
            "label_present": "Filter neighborhoods" in html,
        },
        "dom_sha256": sha256_text(html),
    }


def urls_match_route(url: str, route: str) -> bool:
    parsed = urllib.parse.urlsplit(url)
    route_parsed = urllib.parse.urlsplit("https://cityscroll.invalid" + route)
    if parsed.path.rstrip("/") != route_parsed.path.rstrip("/"):
        return False
    if not route_parsed.query:
        return True
    return urllib.parse.parse_qs(parsed.query) == urllib.parse.parse_qs(route_parsed.query)


def observe_a2_no_js(browser, base: str, route: str, html: str, width: int, height: int) -> dict:
    stripped = strip_scripts(html)
    script_tags_before = len(re.findall(r"<script\b", html, re.I))
    script_tags_after = len(re.findall(r"<script\b", stripped, re.I))

    permission_events: list[str] = []
    context = browser.new_context(
        viewport={"width": width, "height": height},
        java_script_enabled=False,
        user_agent="Mozilla/5.0 (compatible; CityScrollCapture/1.0)",
    )
    try:
        context.grant_permissions([])
    except Exception:
        pass

    page = context.new_page()

    def fulfill(route_handle):
        request = route_handle.request
        if urls_match_route(request.url, route) and request.resource_type in {"document", "other"}:
            route_handle.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=stripped.encode("utf-8"),
            )
        else:
            # Block script/module fetches so a missed strip cannot reintroduce JS.
            if request.resource_type in {"script", "xhr", "fetch"}:
                route_handle.abort()
            else:
                route_handle.continue_()

    page.route("**/*", fulfill)
    page.goto(f"{normalize_base(base).rstrip('/')}{route}", wait_until="domcontentloaded", timeout=60000)

    root = page.locator("[data-near-you-root], body")
    root.first.wait_for(timeout=15000)

    def focus_info():
        return page.evaluate(
            """() => {
              const el = document.activeElement;
              if (!el) return null;
              return {
                tag: el.tagName,
                id: el.id || null,
                name: el.getAttribute('name'),
                href: el.getAttribute('href'),
                dataMapArea: el.getAttribute('data-map-area'),
                dataNearSurface: el.getAttribute('data-near-surface'),
                text: (el.textContent || '').trim().slice(0, 80),
              };
            }"""
        )

    def scan_keyboard(max_tabs: int = 60) -> tuple[dict, list]:
        reached = {
            "directory_filter": False,
            "browse_records": False,
            "special_use_summary": False,
            "directory_list_summary": False,
            "area_link": False,
        }
        focus_trace = []
        for _ in range(max_tabs):
            page.keyboard.press("Tab")
            info = focus_info()
            if not info:
                continue
            focus_trace.append(info)
            if info.get("id") == "near-area-directory-filter" or info.get("name") == "area_q":
                reached["directory_filter"] = True
            if info.get("dataNearSurface") == "records":
                reached["browse_records"] = True
            if info.get("tag") == "SUMMARY" and "Special-use" in (info.get("text") or ""):
                reached["special_use_summary"] = True
            if info.get("tag") == "SUMMARY" and "Neighborhood list" in (info.get("text") or ""):
                reached["directory_list_summary"] = True
            if info.get("dataMapArea"):
                reached["area_link"] = True
            if (
                reached["browse_records"]
                and reached["directory_filter"]
                and (reached["directory_list_summary"] or reached["special_use_summary"])
            ):
                break
        return reached, focus_trace

    # Keyboard first while directory disclosures stay closed so Browse records
    # is not buried behind hundreds of area links.
    closed_area_links_in_tab_order = page.locator(
        "a[data-map-area]"
    ).evaluate_all(
        """nodes => nodes.filter(n => {
          const details = n.closest('details');
          return !details || details.open;
        }).length"""
    )
    keyboard_reached, focus_trace = scan_keyboard()

    # Open disclosures via native summary activation, then record surviving hrefs.
    for summary_sel in (
        "details.near-entry-secondary > summary",
        "[data-geography-directory-list] > summary",
        "[data-geography-special-use-directory] > summary",
    ):
        loc = page.locator(summary_sel)
        if loc.count() > 0:
            try:
                loc.first.click(timeout=2000)
            except Exception:
                pass

    hrefs = page.locator("a[data-map-area]").evaluate_all(
        "nodes => nodes.map(n => ({id: n.getAttribute('data-map-area'), href: n.getAttribute('href'), label: (n.textContent||'').trim()}))"
    )
    native_http_links = []
    for row in hrefs:
        href = row.get("href") or ""
        absolute = urllib.parse.urljoin(normalize_base(base), href)
        parsed = urllib.parse.urlsplit(absolute)
        native_http_links.append(
            {
                "id": row.get("id"),
                "label": row.get("label"),
                "href": href,
                "scheme": parsed.scheme,
                "has_geo_param": "geo=" in (parsed.query or ""),
            }
        )

    # Location control / permission observations (no JS means no prompt).
    use_location = page.locator("[data-use-location]")
    use_location_state = {
        "present": use_location.count() > 0,
        "hidden_attr": use_location.first.get_attribute("hidden") is not None if use_location.count() else None,
        "class_name": use_location.first.get_attribute("class") if use_location.count() else None,
    }

    empty_status = page.locator("[data-geography-directory-empty]")
    empty_text = empty_status.inner_text().strip() if empty_status.count() else None

    alias_hit = None
    if "area_q=Tribeca" in route or "Tribeca" in route:
        alias_hit = {
            "query": "Tribeca",
            "expected_id": ALIAS_EXPECTED_ID,
            "matched_ids": [row["id"] for row in native_http_links if row["id"] == ALIAS_EXPECTED_ID],
            "residential_ids_observed": page.locator(
                "[data-geography-directory-list] a[data-map-area]"
            ).evaluate_all("nodes => nodes.map(n => n.getAttribute('data-map-area'))"),
        }

    nomatch = None
    if "zzz-no-such-neighborhood" in route:
        residential_open_ids = page.locator(
            "[data-geography-directory-list] a[data-map-area]"
        ).evaluate_all("nodes => nodes.map(n => n.getAttribute('data-map-area'))")
        special_open_ids = page.locator(
            "[data-geography-special-use-directory] a[data-map-area]"
        ).evaluate_all("nodes => nodes.map(n => n.getAttribute('data-map-area'))")
        special_body = page.locator("[data-geography-special-use-directory]").inner_text()
        nomatch = {
            "query": "zzz-no-such-neighborhood",
            "empty_status_text": empty_text,
            "residential_link_count": len(residential_open_ids),
            "special_use_directory_present": page.locator(
                "[data-geography-special-use-directory]"
            ).count()
            > 0,
            "special_use_summary_label": page.locator(
                "[data-geography-special-use-directory] > summary"
            ).inner_text().strip()
            if page.locator("[data-geography-special-use-directory] > summary").count()
            else None,
            "special_use_link_count_under_filter": len(special_open_ids),
            "special_use_filter_empty_message_present": "No special-use areas match this filter"
            in special_body,
        }

    # Probe whether the stripped document still asks for geolocation (it should not).
    geo_probe = page.evaluate(
        """() => {
          const nav = typeof navigator !== 'undefined' ? navigator : null;
          return {
            has_geolocation_api: !!(nav && nav.geolocation),
            has_permissions_api: !!(nav && nav.permissions),
          };
        }"""
    )

    digest_payload = {
        "route": route,
        "viewport": {"width": width, "height": height},
        "native_link_count": len(native_http_links),
        "keyboard_reached": keyboard_reached,
        "closed_area_links_in_tab_order": closed_area_links_in_tab_order,
        "permission_events": permission_events,
        "alias_hit": alias_hit,
        "nomatch": nomatch,
    }
    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"a2-{urllib.parse.quote(route, safe='')}-{width}x{height}.png"),
        full_page=True,
    )
    context.close()

    return {
        "route": route,
        "viewport": {"width": width, "height": height},
        "script_tags_in_served_document": script_tags_before,
        "script_tags_after_strip": script_tags_after,
        "java_script_enabled": False,
        "native_links_sample": native_http_links[:12],
        "native_link_count": len(native_http_links),
        "native_links_all_have_href": all(bool(row.get("href")) for row in native_http_links),
        "closed_area_links_in_tab_order": closed_area_links_in_tab_order,
        "keyboard_reached": keyboard_reached,
        "keyboard_focus_sample": focus_trace[:12],
        "use_location_control": use_location_state,
        "location_permission_events_observed": permission_events,
        "geolocation_api_probe": geo_probe,
        "alias": alias_hit,
        "no_match": nomatch,
        "empty_status_text": empty_text,
        "dom_sha256": sha256_text(json.dumps(digest_payload, sort_keys=True, separators=(",", ":"))),
    }


def assert_letter_observations(a1: dict, a2_reads: list[dict]) -> None:
    """Fail closed when observed values do not satisfy the letters."""
    if a1.get("borough_group_order") != [
        "Bronx",
        "Brooklyn",
        "Manhattan",
        "Queens",
        "Staten Island",
    ]:
        raise AssertionError(f"A1 borough order unexpected: {a1.get('borough_group_order')}")
    if a1.get("residential_link_count", 0) < 1:
        raise AssertionError("A1 residential directory empty")
    special = a1.get("special_use") or {}
    if special.get("summary_label") != "Special-use areas":
        raise AssertionError(f"A1 special-use summary missing: {special.get('summary_label')}")
    for row in special.get("named_reachable") or []:
        if not row.get("in_special_use_directory"):
            raise AssertionError(f"A1 special-use {row.get('id')} not reachable")
        if row.get("in_residential_directory"):
            raise AssertionError(f"A1 special-use {row.get('id')} leaked into residential list")
    if not (special.get("airport_ids_sample") or special.get("cemetery_ids_sample")):
        raise AssertionError("A1 no airport/cemetery special-use ids observed")

    for read in a2_reads:
        if read.get("script_tags_after_strip") != 0:
            raise AssertionError("A2 strip left script tags")
        if read.get("location_permission_events_observed"):
            raise AssertionError(f"A2 observed location permission: {read['location_permission_events_observed']}")
        if not read.get("native_links_all_have_href") and read["route"] == ENTRY_ROUTE:
            # Entry page has links behind disclosures; after open they should exist.
            if read.get("native_link_count", 0) < 1:
                raise AssertionError("A2 entry page has no native area links after disclosure open")
        reached = read.get("keyboard_reached") or {}
        if read["route"] == ENTRY_ROUTE:
            if read.get("closed_area_links_in_tab_order", 999) >= 262:
                raise AssertionError(
                    f"A2 default tab order still exposes {read.get('closed_area_links_in_tab_order')} area links"
                )
            if not (
                reached.get("browse_records")
                and (
                    reached.get("directory_filter")
                    or reached.get("directory_list_summary")
                    or reached.get("special_use_summary")
                )
            ):
                raise AssertionError(f"A2 keyboard path missed browse/directory controls: {reached}")
        if read.get("alias") is not None:
            alias = read["alias"]
            if ALIAS_EXPECTED_ID not in (alias.get("matched_ids") or []):
                raise AssertionError(f"A2 Tribeca alias did not resolve to {ALIAS_EXPECTED_ID}: {alias}")
        if read.get("no_match") is not None:
            nomatch = read["no_match"]
            if not nomatch.get("empty_status_text"):
                raise AssertionError("A2 no-match missing empty status")
            if nomatch.get("residential_link_count", 1) != 0:
                raise AssertionError("A2 no-match still shows residential links")
            if not nomatch.get("special_use_directory_present"):
                raise AssertionError("A2 no-match dropped the special-use disclosure")
            if not nomatch.get("special_use_filter_empty_message_present"):
                raise AssertionError("A2 no-match missing special-use empty-filter copy")


def capture() -> dict:
    base = resolve_base()
    artifact = read_artifact_manifest(base)
    rev = deployed_revision(artifact)
    generated_at = artifact.get("generated_at")
    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    print(f"production base={base} revision={rev} generated_at={generated_at}", flush=True)

    entry_html = fetch_html(base, ENTRY_ROUTE)
    alias_html = fetch_html(base, ALIAS_ROUTE)
    nomatch_html = fetch_html(base, NOMATCH_ROUTE)

    a1 = observe_a1_from_html(entry_html)
    a1["revision"] = rev
    a1["data_vintage"] = DATA_VINTAGE

    a2_reads: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for route, html, name in (
            (ENTRY_ROUTE, entry_html, "entry"),
            (ALIAS_ROUTE, alias_html, "alias-tribeca"),
            (NOMATCH_ROUTE, nomatch_html, "no-match"),
        ):
            # One desktop + one mobile observation per route is enough for the letter.
            for viewport_name, width, height in VIEWPORTS:
                print(f"A2 {name} {viewport_name}", flush=True)
                read = observe_a2_no_js(browser, base, route, html, width, height)
                read["name"] = f"a2-{name}-{viewport_name}"
                read["revision"] = rev
                read["data_vintage"] = DATA_VINTAGE
                a2_reads.append(read)
        browser.close()

    assert_letter_observations(a1, a2_reads)

    receipt = {
        "schema": SCHEMA,
        "public_alias": PUBLIC_ALIAS,
        "observed_at": observed_at,
        "evidence_class": "deployed-production-read-back",
        "origin": normalize_base(base).rstrip("/"),
        "deployment": {
            "manifest_url": f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}",
            "revision": rev,
            "generated_at": generated_at,
            "deployment_at": artifact.get("deployment_at") or generated_at,
            "manifest_sha256": sha256_text(json.dumps(artifact, sort_keys=True)),
        },
        "capture": {
            "tool": "tools/capture_residential_directory_production_read.py",
            "browser": "chromium",
            "viewports": [{"name": n, "width": w, "height": h} for n, w, h in VIEWPORTS],
            "screenshot_binaries_committed": False,
            "a2_method": (
                "Fetch the served HTML, strip <script> elements with the same "
                "regex used by the rendered-schema journey, fulfill the document "
                "route with java_script_enabled=False, and record surviving controls."
            ),
        },
        "producer": {
            "path": "docs/evidence/residential-directory-readback/read-back.json",
            "schema": SCHEMA,
            "letters": ["A1", "A2"],
            "offline_fixtures_letter": "A3",
            "offline_fixture_suites": [
                "test/geography_navigation_shell.test.mjs",
                "test/geography_navigation_entry.test.mjs",
            ],
        },
        "letters": {
            "A1": {
                "route": ENTRY_ROUTE,
                "observed": a1,
            },
            "A2": {
                "routes": [ENTRY_ROUTE, ALIAS_ROUTE, NOMATCH_ROUTE],
                "reads": a2_reads,
            },
        },
    }
    return receipt


def build_manifest(receipt: dict) -> dict:
    rev = receipt["deployment"]["revision"]
    captures = []
    a1 = receipt["letters"]["A1"]["observed"]
    captures.append(
        {
            "name": "a1-default-chooser",
            "route": ENTRY_ROUTE,
            "mode": "served-html-observation",
            "viewport": {"width": 1440, "height": 900},
            "revision": rev,
            "data_vintage": DATA_VINTAGE,
            "assertion": (
                "Observed borough group order and counts; special-use directory "
                "keeps named airport/cemetery entries reachable outside the residential list."
            ),
            "sha256": a1["dom_sha256"],
            "file": None,
            "observed": {
                "borough_group_order": a1["borough_group_order"],
                "residential_link_count": a1["residential_link_count"],
                "special_use_link_count": a1["special_use"]["link_count"],
                "named_special_use": a1["special_use"]["named_reachable"],
            },
        }
    )
    for read in receipt["letters"]["A2"]["reads"]:
        captures.append(
            {
                "name": read["name"],
                "route": read["route"],
                "mode": "served-html-script-stripped-no-js",
                "viewport": read["viewport"],
                "revision": rev,
                "data_vintage": DATA_VINTAGE,
                "assertion": (
                    "After stripping scripts, native area hrefs remain, keyboard reaches "
                    "directory/browse controls, alias/no-match behave as served, and no "
                    "location-permission event is observed."
                ),
                "sha256": read["dom_sha256"],
                "file": None,
                "observed": {
                    "script_tags_after_strip": read["script_tags_after_strip"],
                    "native_link_count": read["native_link_count"],
                    "keyboard_reached": read["keyboard_reached"],
                    "location_permission_events_observed": read["location_permission_events_observed"],
                    "alias": read.get("alias"),
                    "no_match": read.get("no_match"),
                },
            }
        )
    return {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "residential-directory-readback",
        "public_alias": PUBLIC_ALIAS,
        "surface": "Near You searchable residential directory",
        "base": normalize_base(receipt["origin"]),
        "condition": (
            f"Production base {normalize_base(receipt['origin'])} after deployment; "
            "no image binary is committed."
        ),
        "capture_mode": "headless-playwright-production-served-site",
        "revision_format": "served artifact-manifest source_commit_sha",
        "revision": rev,
        "repository_revision": rev,
        "grounded_at": rev,
        "data_vintage": DATA_VINTAGE,
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; "
            "only this manifest is committed."
        ),
        "producer": receipt["producer"],
        "captures": captures,
    }


def validate(receipt: dict) -> None:
    if receipt.get("schema") != SCHEMA:
        raise AssertionError(f"unexpected schema {receipt.get('schema')}")
    if receipt.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("public_alias mismatch")
    deployment = receipt.get("deployment") or {}
    if not re.fullmatch(r"[0-9a-f]{40}", deployment.get("revision") or ""):
        raise AssertionError("deployment.revision must be a 40-hex served SHA")
    a1 = ((receipt.get("letters") or {}).get("A1") or {}).get("observed") or {}
    a2_reads = ((receipt.get("letters") or {}).get("A2") or {}).get("reads") or []
    if not a1 or not a2_reads:
        raise AssertionError("missing A1/A2 observations")
    assert_letter_observations(a1, a2_reads)
    producer = receipt.get("producer") or {}
    if producer.get("path") != "docs/evidence/residential-directory-readback/read-back.json":
        raise AssertionError("producer path mismatch")
    if producer.get("letters") != ["A1", "A2"]:
        raise AssertionError("producer letters mismatch")


def check() -> None:
    receipt = json.loads(READBACK.read_text(encoding="utf-8"))
    validate(receipt)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("capture-manifest public_alias mismatch")
    if manifest.get("revision") != receipt["deployment"]["revision"]:
        raise AssertionError("capture-manifest revision drift")
    print(f"residential-directory production read-back check passed: {READBACK.relative_to(ROOT)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return 0
    receipt = capture()
    write_json(READBACK, receipt)
    write_json(MANIFEST, build_manifest(receipt))
    print(f"wrote {READBACK.relative_to(ROOT)}", flush=True)
    print(f"wrote {MANIFEST.relative_to(ROOT)}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(exc, file=sys.stderr)
        raise
