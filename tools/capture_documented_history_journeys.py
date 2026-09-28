#!/usr/bin/env python3
"""Measure the retained-history Search journeys in Chromium.

Fixture mode is hermetic and is used by the card verifier. Production mode is
read-only and fail-closed: it requires a landed default-branch commit, proves
the served Pages revision contains it, fetches every served materialization in
the same run, and refuses when a named journey is absent.
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import os
import re
import sys
import tempfile
import threading
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "test" / "browser"))
sys.path.insert(0, str(ROOT / "tools"))

from browser_support import launched_chromium  # noqa: E402
from deployed_capture_ancestor import (  # noqa: E402
    ServedDataMissingError,
    require_served_page_revision_contains_delivery,
    served_page_revision,
)
from local_site_server import QuietHandler, _RobustThreadingHTTPServer  # noqa: E402
from repository_revision import branch_head, resolve_repository_revision  # noqa: E402

DEFAULT_BASE = "https://cityscroll.org"
MANIFEST_PATH = ROOT / "docs" / "evidence" / "documented-history-journeys" / "capture-manifest.json"
PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
VIEWPORTS = (
    ("desktop-keyboard", 1440, 900, False),
    ("narrow-touch", 390, 844, True),
)
CASES = (
    ("coyle", "2025-54-A", "Coyle Street BSA cases"),
    ("franklin-avenue", "960 Franklin Avenue", "Franklin Avenue application history"),
    ("kingsbridge-armory", "Kingsbridge Armory", "Kingsbridge Armory proposal history"),
    ("sixth-avenue", "Sixth Avenue", "Sixth Avenue corridor history"),
    ("thirty-first-avenue", "31st Avenue", "31st Avenue corridor history"),
    ("lighthouse-point", "Lighthouse Point", "Lighthouse Point component history"),
)
DATA_PATHS = (
    "/data/connected_history_relations.json",
    "/data/connected_history_time.json",
    "/data/connected_history_roles.json",
)
LOCAL_RUNTIME_DATA_PATHS = DATA_PATHS + ("/beta-flags.json",)
LOCAL_ASSET_SUFFIXES = frozenset({".css", ".js", ".mjs"})
HTML_ASSET_PATTERN = re.compile(r"(?:src|href)=[\"']([^\"']+)[\"']", re.IGNORECASE)
MODULE_IMPORT_PATTERN = re.compile(
    r"(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)[\"']([^\"']+)[\"']"
)
CSS_IMPORT_PATTERN = re.compile(r"@import\s+(?:url\()?\s*[\"']([^\"']+)[\"']", re.IGNORECASE)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def route_for(query: str) -> str:
    encoded = urllib.parse.quote_plus(query)
    return f"/search/?q={encoded}&source_scope=all#connected-history"


class FixtureHandler(QuietHandler):
    def translate_path(self, path: str) -> str:
        route = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        if route == "/search/" or route == "/search":
            return str(ROOT / "site" / "search" / "index.html")
        if route.startswith("/search/") and route.endswith((".mjs", ".js")):
            return str(ROOT / "site" / Path(route).name)
        if route.startswith("/capabilities/"):
            return str(ROOT / route.lstrip("/"))
        return str(ROOT / "site" / route.lstrip("/"))


def serve_fixture() -> tuple[object, str]:
    server = _RobustThreadingHTTPServer(
        ("127.0.0.1", 0),
        functools.partial(FixtureHandler, directory=str(ROOT / "site")),
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


def local_dependency(source: Path, reference: str) -> Path | None:
    parsed = urllib.parse.urlsplit(reference)
    if parsed.scheme or parsed.netloc or reference.startswith(("#", "data:")):
        return None
    path = parsed.path
    if not path:
        return None
    if path.startswith("/"):
        candidate = ROOT / "site" / path.lstrip("/")
    elif source.name == "index.html":
        # Both measured documents declare <base href="/">.
        candidate = ROOT / "site" / path
    else:
        candidate = source.parent / path
    candidate = candidate.resolve()
    try:
        candidate.relative_to(ROOT)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def discover_measured_inputs() -> set[str]:
    # The measurement asserts the Search document and its interactions. The
    # continuation click proves its destination URL, not the destination page's
    # rendering, so that second document is deliberately outside this closure.
    documents = {ROOT / "site" / "search" / "index.html"}
    pending = list(documents)
    for path in LOCAL_RUNTIME_DATA_PATHS:
        pending.append(ROOT / "site" / path.lstrip("/"))
    discovered: set[Path] = set()
    while pending:
        source = pending.pop()
        if source in discovered:
            continue
        discovered.add(source)
        if source.suffix not in LOCAL_ASSET_SUFFIXES and source not in documents:
            continue
        text = source.read_text(encoding="utf-8")
        patterns = [HTML_ASSET_PATTERN] if source in documents else [MODULE_IMPORT_PATTERN, CSS_IMPORT_PATTERN]
        for pattern in patterns:
            for reference in pattern.findall(text):
                dependency = local_dependency(source, reference)
                if dependency and (dependency.suffix in LOCAL_ASSET_SUFFIXES or dependency.suffix == ".json"):
                    pending.append(dependency)
    return {path.relative_to(ROOT).as_posix() for path in discovered}


def measured_input_receipts(paths: set[str]) -> list[dict[str, str]]:
    return [
        {"path": path, "sha256": sha256_bytes((ROOT / path).read_bytes())}
        for path in sorted(paths)
    ]


def require_production_base(base: str) -> str:
    normalized = base.rstrip("/")
    host = (urllib.parse.urlsplit(normalized).hostname or "").lower()
    if host not in PRODUCTION_HOSTS:
        raise SystemExit(f"production capture requires cityscroll.org, got {base}")
    return normalized


def fetch_json_receipt(base: str, path: str, served_revision: str) -> tuple[dict, dict]:
    url = urllib.parse.urljoin(base.rstrip("/") + "/", path.lstrip("/"))
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "cityscroll-documented-history-capture/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
            status = int(response.status)
            headers = {key: response.headers.get(key) for key in ("Date", "ETag", "Last-Modified", "CF-Ray")}
    except Exception as error:
        raise ServedDataMissingError(f"served history materialization unavailable at {url}: {error}") from error
    try:
        payload = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as error:
        raise ServedDataMissingError(f"served history materialization is invalid JSON at {url}") from error
    if status != 200 or not isinstance(payload, dict):
        raise ServedDataMissingError(f"served history materialization missing at {url} (HTTP {status})")
    return payload, {
        "url": url,
        "http_status": status,
        "observed_at": utc_now(),
        "served_revision": served_revision,
        "sha256": sha256_bytes(raw),
        "headers": headers,
    }


def install_fixture_routes(
    page,
    failure: dict[str, bool],
    local_request_paths: set[str] | None = None,
) -> None:
    def route_request(route) -> None:
        parsed = urllib.parse.urlsplit(route.request.url)
        if local_request_paths is not None and parsed.hostname in {"127.0.0.1", "localhost"}:
            local_request_paths.add(parsed.path)
        if failure["enabled"] and parsed.path.endswith("/data/connected_history_relations.json"):
            route.fulfill(status=503, content_type="application/json", body="{}")
            return
        if parsed.hostname in {"api.cityscroll.org", "cityscroll-worker.crol-worker.workers.dev"}:
            route.fulfill(status=503, content_type="application/json", body="{}")
            return
        if parsed.hostname in {"static.cloudflareinsights.com", "cloudflareinsights.com"}:
            route.abort()
            return
        if parsed.scheme == "https" and parsed.hostname not in {"127.0.0.1", "localhost"}:
            title = Path(parsed.path).name or parsed.hostname or "Official source"
            route.fulfill(
                status=200,
                content_type="text/html",
                body=f"<!doctype html><html lang='en'><body><main><h1>Official source</h1><p>{title}</p></main></body></html>",
            )
            return
        route.continue_()

    page.route("**/*", route_request)


def screenshot_receipt(page, capture_id: str, screenshot_dir: Path | None) -> dict | None:
    if screenshot_dir is None:
        return None
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    path = screenshot_dir / f"{capture_id}.png"
    page.screenshot(path=str(path), full_page=True)
    return {"local_path": str(path), "sha256": sha256_bytes(path.read_bytes())}


def activate_link(
    page,
    link,
    *,
    initial_url: str,
    fixture: bool,
) -> tuple[str, bool]:
    """Activate a link and return its observed destination and departure state.

    Fixture routes intentionally render a small page headed "Official source".
    Production destinations are publisher-owned and must not be required to use
    that fixture copy. A publisher can serve an attachment instead of a browser
    document, so an in-run navigation request also proves activation when the
    original document remains loaded. Same-origin continuation links must still
    load their exact path; external links may follow publisher redirects.
    """

    href = link.get_attribute("href")
    assert href
    expected = urllib.parse.urljoin(initial_url, href)
    navigation_requests: list[str] = []

    def record_request(request) -> None:
        if request.is_navigation_request():
            navigation_requests.append(request.url)

    page.on("request", record_request)
    link.click()
    page.wait_for_load_state("domcontentloaded")
    actual = page.url
    departed = actual != initial_url
    actual_url = urllib.parse.urlsplit(actual)
    expected_url = urllib.parse.urlsplit(expected)
    initial_host = (urllib.parse.urlsplit(initial_url).hostname or "").lower()
    requested_expected = any(
        urllib.parse.urldefrag(request_url)[0] == urllib.parse.urldefrag(expected)[0]
        for request_url in navigation_requests
    )
    assert departed or requested_expected, (
        f"link did not activate expected destination {expected}; "
        f"page remained at {actual}; navigation requests={navigation_requests}"
    )
    same_origin = (expected_url.hostname or "").lower() == initial_host
    destination = actual if same_origin and departed else expected
    destination_url = urllib.parse.urlsplit(destination)
    assert destination_url.scheme in ({"http", "https"} if fixture else {"https"})
    if same_origin:
        assert departed, f"same-origin link did not load {expected}"
        assert (destination_url.hostname or "").lower() == initial_host
        assert destination_url.path == expected_url.path
    if fixture and expected_url.hostname not in {"127.0.0.1", "localhost"}:
        assert page.get_by_role("heading", name="Official source").is_visible()
    return destination, departed


def panel_measurement(
    page,
    family_id: str,
    query: str,
    expected_title: str,
    mode: str,
    *,
    fixture: bool,
) -> tuple[dict, str]:
    panel = page.locator("[data-connected-history]")
    panel.wait_for(state="visible", timeout=30_000)
    page.wait_for_function(
        "family => document.querySelector('[data-connected-history]')?.dataset.connectedHistoryState === 'ready' "
        "&& document.querySelector('[data-connected-history]')?.dataset.connectedHistoryFamily === family",
        arg=family_id,
        timeout=30_000,
    )
    assert page.locator("#search-query").input_value() == query
    assert panel.get_by_role("heading", name=expected_title).is_visible()
    assert panel.locator(".connected-history-event").count() > 0
    assert panel.locator(".connected-history-identities").inner_text().count("·") >= 1
    text = panel.inner_text().lower()
    for forbidden in ("candidate_id", "identities_merged", "method_version", "join diagnostic"):
        assert forbidden not in text, forbidden

    details = panel.locator(".connected-history-event details").first
    summary = details.locator("summary")
    if mode == "desktop-keyboard":
        summary.focus()
        summary.press("Enter")
    else:
        summary.click()
    assert details.get_attribute("open") is not None
    dismiss = details.locator("[data-connected-history-dismiss]")
    dismiss.click()
    assert details.get_attribute("open") is None
    assert summary.evaluate("node => document.activeElement === node") is True

    initial_url = page.url
    summary.click()
    assert details.get_attribute("open") is not None
    open_link = details.locator("[data-connected-history-open]")
    official_source_destination, official_source_departed = activate_link(
        page,
        open_link,
        initial_url=initial_url,
        fixture=fixture,
    )
    if official_source_departed:
        page.go_back(wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function(
        "family => document.querySelector('[data-connected-history]')?.dataset.connectedHistoryState === 'ready' "
        "&& document.querySelector('[data-connected-history]')?.dataset.connectedHistoryFamily === family",
        arg=family_id,
        timeout=30_000,
    )
    assert page.url == initial_url
    assert page.locator("#search-query").input_value() == query

    continue_link = page.locator("[data-connected-history] [data-connected-history-continue]")
    continue_destination, continue_departed = activate_link(
        page,
        continue_link,
        initial_url=initial_url,
        fixture=fixture,
    )
    if continue_departed:
        page.go_back(wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function(
        "family => document.querySelector('[data-connected-history]')?.dataset.connectedHistoryState === 'ready' "
        "&& document.querySelector('[data-connected-history]')?.dataset.connectedHistoryFamily === family",
        arg=family_id,
        timeout=30_000,
    )
    assert page.url == initial_url

    measured = page.evaluate(
        """() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          positive_tabindex_count: document.querySelectorAll('[tabindex="1"],[tabindex="2"],[tabindex="3"],[tabindex="4"],[tabindex="5"],[tabindex="6"],[tabindex="7"],[tabindex="8"],[tabindex="9"]').length,
          horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          query: new URLSearchParams(location.search).get('q'),
          source_scope: new URLSearchParams(location.search).get('source_scope'),
          route: `${location.pathname}${location.search}${location.hash}`,
        })"""
    )
    measured["official_source_destination"] = official_source_destination
    measured["official_source_document_departed"] = official_source_departed
    measured["continue_destination"] = continue_destination
    measured["continue_document_departed"] = continue_departed
    html = panel.evaluate("node => node.outerHTML")
    return measured, html


def run_ready_matrix(
    browser,
    base: str,
    *,
    fixture: bool,
    screenshot_dir: Path | None,
    local_request_paths: set[str] | None = None,
) -> list[dict]:
    observations: list[dict] = []
    for mode, width, height, has_touch in VIEWPORTS:
        context = browser.new_context(viewport={"width": width, "height": height}, has_touch=has_touch)
        for family_id, query, title in CASES:
            page = context.new_page()
            if fixture:
                install_fixture_routes(page, {"enabled": False}, local_request_paths)
            route = route_for(query)
            response = page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=60_000)
            assert response is not None and response.status == 200
            measured, html = panel_measurement(
                page,
                family_id,
                query,
                title,
                mode,
                fixture=fixture,
            )
            assert measured["width"] == width
            assert measured["height"] == height
            assert measured["query"] == query
            assert measured["source_scope"] == "all"
            assert measured["positive_tabindex_count"] == 0
            assert measured["horizontal_overflow"] is False
            capture_id = f"{family_id}-{mode}"
            screenshot = screenshot_receipt(page, capture_id, screenshot_dir)
            observations.append({
                "case": capture_id,
                "family_id": family_id,
                "route": route,
                "viewport": {"name": mode, "width": measured["width"], "height": measured["height"]},
                "interaction": "keyboard" if mode == "desktop-keyboard" else "touch",
                "assertion": "Measured scope, inspection, dismissal, official-source open, Back restoration, and continuation with the submitted query retained.",
                "render_sha256": sha256_text(html),
                "capture_sha256": screenshot["sha256"] if screenshot else None,
                "runtime": measured,
            })
            page.close()
        context.close()
    return observations


def run_no_javascript(
    browser,
    base: str,
    *,
    fixture: bool,
    local_request_paths: set[str] | None = None,
) -> list[dict]:
    observations: list[dict] = []
    context = browser.new_context(viewport={"width": 1440, "height": 900}, java_script_enabled=False)
    for family_id, query, title in CASES:
        page = context.new_page()
        if fixture:
            install_fixture_routes(page, {"enabled": False}, local_request_paths)
        route = route_for(query)
        response = page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=60_000)
        assert response is not None and response.status == 200
        fallback = page.locator("noscript .connected-history")
        fallback.wait_for(state="visible", timeout=30_000)
        link_name = {
            "coyle": "Coyle Street BSA cases",
            "franklin-avenue": "Franklin Avenue applications",
            "kingsbridge-armory": "Kingsbridge Armory proposals",
            "sixth-avenue": "Sixth Avenue corridor",
            "thirty-first-avenue": "31st Avenue corridor",
            "lighthouse-point": "Lighthouse Point components",
        }[family_id]
        link = fallback.get_by_role("link", name=link_name)
        assert link.get_attribute("href")
        measured = page.evaluate(
            """() => ({
              width: window.innerWidth,
              height: window.innerHeight,
              query: new URLSearchParams(location.search).get('q'),
              route: `${location.pathname}${location.search}${location.hash}`,
            })"""
        )
        html = fallback.evaluate("node => node.outerHTML")
        observations.append({
            "case": f"{family_id}-no-javascript",
            "family_id": family_id,
            "route": route,
            "viewport": {"name": "no-javascript", "width": measured["width"], "height": measured["height"]},
            "interaction": "ordinary anchor",
            "assertion": "With scripting disabled, the submitted query remains in the route and the fixed history keeps a real official-source destination.",
            "render_sha256": sha256_text(html),
            "capture_sha256": None,
            "runtime": measured,
        })
        page.close()
    context.close()
    return observations


def run_failure_control(
    browser,
    base: str,
    *,
    fixture: bool,
    local_request_paths: set[str] | None = None,
) -> dict | None:
    if not fixture:
        return None
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    failure = {"enabled": True}
    install_fixture_routes(page, failure, local_request_paths)
    query = "Kingsbridge Armory"
    route = route_for(query)
    page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=60_000)
    panel = page.locator("[data-connected-history]")
    page.wait_for_function(
        "() => document.querySelector('[data-connected-history]')?.dataset.connectedHistoryState === 'unavailable'",
        timeout=30_000,
    )
    assert page.locator("#search-query").input_value() == query
    assert panel.get_by_role("link", name="Try again").get_attribute("href") == (
        "/search/?q=Kingsbridge%20Armory#connected-history"
    )
    assert panel.locator("a[href^='https://']").count() == 1
    text = panel.inner_text().lower()
    assert "unavailable result" in text
    assert "successful empty result" in text
    assert "no history" not in text
    html = panel.evaluate("node => node.outerHTML")
    result = {
        "case": "history-materialization-failure-positive-control",
        "family_id": "kingsbridge-armory",
        "route": route,
        "viewport": {"name": "desktop-keyboard", "width": 1440, "height": 900},
        "interaction": "failure injection",
        "assertion": "A failed retained-history load preserves the query and exposes retry plus an official source without asserting an empty history.",
        "render_sha256": sha256_text(html),
        "capture_sha256": None,
    }
    page.close()
    context.close()
    return result


def write_hermetic_manifest(receipt: dict) -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    observed = {capture["case"]: capture for capture in receipt["captures"]}
    retained = {capture["case"]: capture for capture in manifest["captures"]}
    if observed.keys() != retained.keys():
        missing = sorted(observed.keys() ^ retained.keys())
        raise RuntimeError(f"manifest cases do not match measurement: {missing}")
    manifest["measurement_provenance"] = {
        "revision": receipt["repository_revision"],
        "inputs": receipt["measured_inputs"],
    }
    for capture in manifest["captures"]:
        measurement = observed[capture["case"]]
        capture["revision"] = receipt["repository_revision"]
        capture["sha256"] = measurement["render_sha256"]
        if measurement["capture_sha256"]:
            capture["local_capture_sha256"] = measurement["capture_sha256"]
        else:
            capture.pop("local_capture_sha256", None)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def write_production_manifest(receipt: dict) -> None:
    """Retain a public-safe production receipt without local screenshot paths."""

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    vintages = sorted({value for value in receipt["data_vintage"].values() if value})
    data_vintage = vintages[0] if len(vintages) == 1 else receipt["data_vintage"]
    captures = []
    for capture in receipt["captures"]:
        screenshot_hash = capture.get("capture_sha256")
        captures.append({
            "case": capture["case"],
            "route": capture["route"],
            "viewport": capture["viewport"],
            "revision": receipt["served_revision"],
            "data_vintage": data_vintage,
            "assertion": capture["assertion"],
            "sha256": screenshot_hash or capture["render_sha256"],
            "hash_kind": "screenshot" if screenshot_hash else "rendered_markup",
            "render_sha256": capture["render_sha256"],
            "runtime": capture["runtime"],
        })
    run_receipt = {
        "schema": "cityscroll.documented_history_production_read.v1",
        "evidence_class": "deployed-production-read-back",
        "observed_at": receipt["observed_at"],
        "origin": receipt["base_url"],
        "repository_revision": receipt["repository_revision"],
        "required_landed_commit": receipt["required_landed_commit"],
        "served_revision": receipt["served_revision"],
        "served_revision_after": receipt["served_revision_after"],
        "retained_measurement": {
            "revision": manifest["measurement_provenance"]["revision"],
            "inputs_ref": "#/measurement_provenance/inputs",
        },
        "data_vintage": receipt["data_vintage"],
        "request_receipts": receipt["request_receipts"],
        "capture_count": len(captures),
        "image_binaries_committed": False,
        "captures": captures,
    }
    run_receipt_sha256 = sha256_text(json.dumps(
        run_receipt,
        sort_keys=True,
        separators=(",", ":"),
    ))
    manifest["production_measurement"] = {
        "state": "measured",
        "runner": (
            "python3 tools/capture_documented_history_journeys.py --production "
            f"--landed-commit {receipt['required_landed_commit']} --write-manifest"
        ),
        "requirement": (
            "The runner refuses a non-main pin, a served revision that does not contain it, "
            "a revision change during capture, absent served materializations, or a missing "
            "rendered journey."
        ),
        "run_receipt_sha256": run_receipt_sha256,
        "run_receipt": run_receipt,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--production", action="store_true")
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    parser.add_argument("--landed-commit")
    parser.add_argument("--screenshot-dir")
    parser.add_argument("--write-manifest", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repository_revision = resolve_repository_revision(ROOT)
    capture_revision = branch_head(ROOT)
    server = None
    served_revision = None
    served_revision_after = None
    required_landed_commit = None
    request_receipts: list[dict] = []
    measured_inputs: list[dict[str, str]] = []
    local_request_paths: set[str] = set()
    data_vintage: dict[str, str | None] = {}
    if args.production:
        if not args.landed_commit:
            raise SystemExit("--production requires --landed-commit")
        base = require_production_base(args.base_url)
        required_landed_commit = args.landed_commit.lower()
        served_revision = require_served_page_revision_contains_delivery(
            base,
            required_landed_commit,
            cwd=ROOT,
        )
        for path in DATA_PATHS:
            payload, receipt = fetch_json_receipt(base, path, served_revision)
            if not payload.get("generated_at"):
                raise ServedDataMissingError(f"served materialization has no generated_at: {path}")
            data_vintage[path] = payload.get("generated_at")
            request_receipts.append(receipt)
    else:
        server, base = serve_fixture()
        for path in DATA_PATHS:
            payload = json.loads((ROOT / "site" / path.lstrip("/")).read_text(encoding="utf-8"))
            data_vintage[path] = payload.get("generated_at")

    screenshot_dir = None
    temporary_screenshot_dir = None
    if args.screenshot_dir:
        screenshot_dir = Path(args.screenshot_dir)
    elif os.environ.get("FM_TASK_SCRATCH"):
        screenshot_dir = Path(os.environ["FM_TASK_SCRATCH"]) / "documented-history-captures"
    elif not args.production:
        temporary_screenshot_dir = tempfile.TemporaryDirectory(prefix="documented-history-captures-")
        screenshot_dir = Path(temporary_screenshot_dir.name)

    try:
        with launched_chromium() as browser:
            captures = run_ready_matrix(
                browser,
                base,
                fixture=not args.production,
                screenshot_dir=screenshot_dir,
                local_request_paths=local_request_paths,
            )
            captures.extend(run_no_javascript(
                browser,
                base,
                fixture=not args.production,
                local_request_paths=local_request_paths,
            ))
            failure = run_failure_control(
                browser,
                base,
                fixture=not args.production,
                local_request_paths=local_request_paths,
            )
            if failure:
                captures.append(failure)
        if args.production:
            served_revision_after = served_page_revision(base)
            if served_revision_after != served_revision:
                raise SystemExit(
                    "served revision changed during capture: "
                    f"{served_revision} -> {served_revision_after}"
                )
    finally:
        if server is not None:
            measured_inputs = measured_input_receipts(discover_measured_inputs())
        if server is not None:
            server.shutdown()
            server.server_close()
        if temporary_screenshot_dir is not None:
            temporary_screenshot_dir.cleanup()

    receipt = {
        "schema": "cityscroll.documented_history_journey_measurement.v1",
        "evidence_class": "runtime_browser_measurement",
        "mode": "production" if args.production else "hermetic_fixture",
        "browser": "Chromium",
        "repository_revision": repository_revision,
        "capture_revision": capture_revision,
        "measured_inputs": measured_inputs,
        "observed_at": utc_now(),
        "base_url": base,
        "required_landed_commit": required_landed_commit,
        "served_revision": served_revision,
        "served_revision_after": served_revision_after,
        "data_vintage": data_vintage,
        "request_receipts": request_receipts,
        "local_request_paths": sorted(local_request_paths),
        "image_binaries_committed": False,
        "screenshot_directory": str(screenshot_dir) if screenshot_dir else None,
        "captures": captures,
    }
    if args.write_manifest:
        if args.production:
            write_production_manifest(receipt)
        else:
            write_hermetic_manifest(receipt)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
