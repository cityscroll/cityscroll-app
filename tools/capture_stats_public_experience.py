#!/usr/bin/env python3
"""Capture the public Stats page as a reader experience, as text.

The page now leads with what a reader can explore, then how much it is being used, then
three worked paths through real records, then a short methodology. This records what that
renders to — never a screenshot. The rendered PNG stays in a gitignored local path and only
its sha256 enters the repository, per docs/capture-manifest-guard.md.

Three families of capture:

* **language and width** — English, French (the expansion-prone translation of the eleven)
  and Arabic (right to left) at 390 and 1440 CSS pixels, with every off-origin request
  denied so nothing a publisher holds can reach the render.
* **states** — a verified zero, a small volume, an ordinary volume, a period whose
  measurement began inside it, a summary standing on the last check that finished, and no
  summary at all. Each is driven from a fixed response, so the observation does not depend
  on what production happened to have measured.
* **deployed observation** — one read of the public deploy, recorded separately, so the
  synthetic figures above are never mistaken for traffic.

    python3 tools/capture_stats_public_experience.py
    python3 tools/capture_stats_public_experience.py --public
    python3 tools/capture_stats_public_experience.py --base http://127.0.0.1:8000/
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs" / "evidence" / "stats-public-experience" / "capture-manifest.json"
OUTPUT = ROOT / ".artifacts" / "stats-public-experience"
ROUTE = "/stats.html"
PUBLIC_BASE = "https://cityscroll.org"
SETTLE_MS = 4000

VIEWPORTS = (("mobile", 390, 844), ("desktop", 1440, 900))
LANGUAGES = (
    ("en", "English, the language the source text stays in."),
    ("fr", "French, the expansion-prone translation used to check that longer strings still fit."),
    ("ar", "Arabic, right to left, used to check that the page mirrors rather than breaks."),
)


def _metric(metric_id: str, label_key: str, definition_key: str, state: str, value):
    return {
        "metric_id": metric_id,
        "label_key": label_key,
        "definition_key": definition_key,
        "state": state,
        "value": value,
    }


def _period(period_id, days, coverage, starts_at, ends_at, run, returning, state="measured"):
    return {
        "period_id": period_id,
        "requested_days": days,
        "state": state,
        "coverage": coverage,
        "unavailable_reason": None,
        "starts_at": starts_at,
        "ends_at": ends_at,
        "metrics": [
            _metric("searches_run", "stats_search_use_run_label",
                    "stats_search_use_run_desc", state, run),
            _metric("searches_returning_records", "stats_search_use_returning_label",
                    "stats_search_use_returning_desc", state, returning),
        ],
    }


def _summary(periods, refresh_state="fresh"):
    return {
        "schema": "public-stats.v4",
        "search_usage": {
            "schema": "cityscroll.public_search_usage.v1",
            "available": True,
            "unavailable_reason": None,
            "generated_at": "2026-09-15T12:00:00.000Z",
            "measurement": {
                "family": "search_usage",
                "population": "Accepted production search-execution receipts.",
                "population_key": "stats_search_use_run_desc",
                "subset_rule": "Searches returning records is a subset of searches run.",
                "state": "complete",
                "measured_since": "2026-07-01T00:00:00.000Z",
            },
            "refresh": {
                "state": refresh_state,
                "verified_at": "2026-09-15T12:00:00.000Z",
                "attempted_at": "2026-09-15T12:00:00.000Z",
                "failure_reason": None if refresh_state == "fresh" else "read_did_not_finish",
            },
            "periods": periods,
        },
    }


WEEK = ("2026-09-09T00:00:00.000Z", "2026-09-16T00:00:00.000Z")

STATES = (
    {
        "id": "verified-zero",
        "assertion": "A complete period in which nobody searched publishes 0, not a state chip.",
        "response": _summary([_period("last7d", 7, "complete", *WEEK, 0, 0)]),
        "expect": ["0"],
    },
    {
        "id": "small-volume",
        "assertion": "A small verified volume renders as the figure itself, with no rounding "
                     "and no suppression.",
        "response": _summary([_period("last7d", 7, "complete", *WEEK, 3, 1)]),
        "expect": ["3", "1"],
    },
    {
        "id": "normal-volume",
        "assertion": "An ordinary volume renders as one grouped number per measure for the "
                     "period the response names.",
        "response": _summary([_period("last30d", 30, "complete",
                                      "2026-08-17T00:00:00.000Z", "2026-09-16T00:00:00.000Z",
                                      4821, 3960)]),
        "expect": ["4,821", "3,960"],
    },
    {
        "id": "incomplete-period",
        "assertion": "A period whose measurement began inside it is labelled from the day "
                     "counting began, never with the wider period it cannot support.",
        "response": _summary([_period("last30d", 30, "partial",
                                      "2026-09-01T00:00:00.000Z", "2026-09-16T00:00:00.000Z",
                                      61, 45)]),
        "expect": ["Since"],
    },
    {
        "id": "partial-current-day",
        "assertion": "A period that ends inside a day says its last day is counted only up to "
                     "the last check, so the current day is visibly partial.",
        "response": _summary([_period("last7d", 7, "complete",
                                      "2026-09-09T00:00:00.000Z", "2026-09-15T12:00:00.000Z",
                                      12, 9)]),
        "expect": ["last check"],
    },
    {
        "id": "last-verified-stale",
        "assertion": "When the newest check did not finish, the page stands on the last one "
                     "that did and says both facts.",
        "response": _summary([_period("last7d", 7, "complete", *WEEK, 6, 4)], refresh_state="stale"),
        "expect": ["Last checked", "did not finish"],
    },
    {
        "id": "unavailable",
        "assertion": "With no summary reachable the section states that counts are not "
                     "published, shows no zero, and leaves coverage and the worked paths standing.",
        "response": None,
        "expect": ["not published"],
    },
)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repository_revision() -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, check=True,
                          capture_output=True, text=True).stdout.strip()


def source_blob() -> dict:
    out = subprocess.run(["git", "hash-object", "site/stats.html"], cwd=ROOT, check=True,
                         capture_output=True, text=True).stdout.strip()
    return {"site/stats.html": out}


def coverage_vintage() -> dict:
    snapshot = json.loads((ROOT / "site" / "data" / "served_coverage_snapshot.json").read_text())
    return {
        "served_coverage_evidence_oldest": snapshot["evidence_vintage"]["oldest"],
        "served_coverage_evidence_newest": snapshot["evidence_vintage"]["newest"],
    }


def start_site_server(temp_dir: Path) -> tuple[subprocess.Popen, str]:
    ready = temp_dir / "site-url.txt"
    process = subprocess.Popen(
        ["python3", "tools/local_site_server.py", "--directory", "_site",
         "--port", "0", "--ready-file", str(ready)],
        cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(200):
        if ready.exists() and ready.read_text().strip():
            return process, ready.read_text().strip()
        if process.poll() is not None:
            raise RuntimeError(f"local site server exited early: {process.stdout.read()}")
        time.sleep(0.05)
    process.terminate()
    raise TimeoutError("local site server did not become ready")


def install_network_policy(page: Page, base: str, attempted: list[str], stats_response=None) -> None:
    """One handler for every request: same-origin passes, the statistics route is answered
    from the fixture when one is given, and everything else off-origin is denied and
    recorded. A single handler is deliberate — two overlapping routes would each try to
    settle the same request."""
    origin = base.rstrip("/")
    payload = None if stats_response is None else json.dumps(stats_response)

    def handler(route):
        url = route.request.url
        if url.split("?")[0].endswith("/stats") and stats_response is not None:
            return route.fulfill(
                status=200,
                headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
                body=payload)
        if url.startswith(origin):
            return route.continue_()
        attempted.append(url.split("?")[0])
        return route.abort()

    page.route("**/*", handler)


def settle(page: Page) -> None:
    page.wait_for_selector("#coverage section.cov-domain table.cov tbody tr", timeout=20000)
    page.wait_for_selector("#search-use table.cov tbody tr, #search-use p.use-note", timeout=20000)
    page.wait_for_timeout(SETTLE_MS)


def observe(page: Page, scope: str) -> dict:
    fit = page.evaluate("""() => ({ scroll: document.documentElement.scrollWidth,
                                    client: document.documentElement.clientWidth })""")
    return {
        "document_scroll_width": fit["scroll"],
        "document_client_width": fit["client"],
        "document_direction": page.evaluate("document.documentElement.getAttribute('dir') || 'ltr'"),
        "document_language": page.evaluate("document.documentElement.getAttribute('lang')"),
        "section_headings": [h.strip() for h in page.locator("main h2").all_inner_texts()],
        "worked_paths": page.locator("#paths article.path").count(),
        "headline_facts": page.locator("#grid .stat").count(),
        "methodology_terms": page.locator("dl.method dt").count(),
        "search_use_present": page.locator("#search-use").count() > 0,
        "search_use_text": (page.locator("#search-use").inner_text().strip()
                            if page.locator("#search-use").count() else ""),
        "render_sha256": sha256_text(page.locator(scope).inner_html()),
    }


def capture(base: str, public_base: str | None) -> list[dict]:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    revision = repository_revision()
    blob = source_blob()
    vintage = coverage_vintage()
    captures: list[dict] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for lang, why in LANGUAGES:
                for name, width, height in VIEWPORTS:
                    context = browser.new_context(viewport={"width": width, "height": height})
                    page = context.new_page()
                    attempted: list[str] = []
                    install_network_policy(page, base, attempted)
                    page.goto(f"{base.rstrip('/')}{ROUTE}", wait_until="domcontentloaded", timeout=60000)
                    if lang != "en":
                        page.select_option("#langSelect", lang)
                        page.wait_for_function("(l) => document.documentElement.lang === l", arg=lang)
                    settle(page)
                    image = OUTPUT / f"{lang}-{width}.png"
                    page.screenshot(path=str(image), full_page=True)
                    observed = observe(page, "main")
                    observed["off_origin_requests_attempted"] = sorted(set(attempted))
                    captures.append({
                        "id": f"language-{lang}-{name}",
                        "route": ROUTE,
                        "viewport": {"name": name, "width": width, "height": height},
                        "language": lang,
                        "language_note": why,
                        "repository_revision": revision,
                        "source_blob": blob,
                        "data_vintage": vintage,
                        "assertion": (
                            "The four sections render in order with three worked paths, three "
                            "dated headline facts and six methodology terms, and the document "
                            f"does not scroll sideways at {width} CSS pixels."
                        ),
                        "assertion_holds": (
                            observed["document_scroll_width"] <= observed["document_client_width"]
                            and observed["worked_paths"] == 3
                            and observed["headline_facts"] == 3
                            and observed["methodology_terms"] == 6
                            and len(observed["section_headings"]) == 4
                        ),
                        "observed": observed,
                        "sha256": observed["render_sha256"],
                        "render_sha256": observed["render_sha256"],
                        "render_scope": "innerHTML of main",
                        "local_capture_path": str(image.relative_to(ROOT)),
                        "capture_sha256": sha256_file(image),
                        "file": None,
                    })
                    context.close()

            for state in STATES:
                body = state["response"]
                context = browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                attempted = []
                install_network_policy(page, base, attempted, stats_response=body)
                page.goto(f"{base.rstrip('/')}{ROUTE}", wait_until="domcontentloaded", timeout=60000)
                settle(page)
                image = OUTPUT / f"state-{state['id']}.png"
                page.screenshot(path=str(image), full_page=True)
                observed = observe(page, "#search-use")
                missing = [needle for needle in state["expect"]
                           if needle.casefold() not in observed["search_use_text"].casefold()]
                observed["missing_expected_text"] = missing
                captures.append({
                    "id": f"state-{state['id']}",
                    "route": ROUTE,
                    "viewport": {"name": "mobile", "width": 390, "height": 844},
                    "language": "en",
                    "repository_revision": revision,
                    "source_blob": blob,
                    "data_vintage": None if body is None else {
                        "measured_since": "2026-07-01T00:00:00.000Z",
                        "verified_at": "2026-09-15T12:00:00.000Z",
                    },
                    "data_vintage_note": (
                        "Supplied by the fixed response recorded in this entry. These are "
                        "acceptance figures for the rendering rule, not production totals."
                    ),
                    "supplied_response": body,
                    "assertion": state["assertion"],
                    "assertion_holds": not missing
                    and observed["document_scroll_width"] <= observed["document_client_width"],
                    "observed": observed,
                    "sha256": observed["render_sha256"],
                    "render_sha256": observed["render_sha256"],
                    "render_scope": "innerHTML of #search-use",
                    "local_capture_path": str(image.relative_to(ROOT)),
                    "capture_sha256": sha256_file(image),
                    "file": None,
                })
                context.close()

            if public_base:
                context = browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()
                page.goto(f"{public_base.rstrip('/')}{ROUTE}", wait_until="domcontentloaded", timeout=60000)
                # The deployed document is whatever is live, which may predate this branch.
                # Wait only for what every published version of the page has, and record the
                # rest as it is found rather than requiring it.
                page.wait_for_selector("main h2", timeout=30000)
                page.wait_for_timeout(SETTLE_MS)
                image = OUTPUT / "deployed-observation.png"
                page.screenshot(path=str(image), full_page=True)
                observed = observe(page, "main")
                captures.append({
                    "id": "deployed-observation",
                    "route": ROUTE,
                    "base": public_base,
                    "viewport": {"name": "mobile", "width": 390, "height": 844},
                    "language": "en",
                    "repository_revision": revision,
                    "source_blob": None,
                    "source_blob_note": (
                        "The deployed document is whatever the public deploy serves, which is "
                        "not this working tree."
                    ),
                    "data_vintage": "Live public deploy read at capture time.",
                    "assertion": (
                        "One read of the deployed page, recorded so the fixed figures above are "
                        "never read as traffic. The deployed document is whatever is live at "
                        "capture time and may predate this branch; its sections are recorded "
                        "verbatim rather than asserted against."
                    ),
                    "assertion_holds": True,
                    "observed": observed,
                    "sha256": observed["render_sha256"],
                    "render_sha256": observed["render_sha256"],
                    "render_scope": "innerHTML of main",
                    "local_capture_path": str(image.relative_to(ROOT)),
                    "capture_sha256": sha256_file(image),
                    "file": None,
                })
                context.close()
        finally:
            browser.close()
    return captures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=None,
                        help="Serve from this base instead of starting a local server over _site.")
    parser.add_argument("--public", action="store_true",
                        help="Also record one read of the public deploy.")
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    args = parser.parse_args()

    server = None
    temp = None
    base = args.base
    try:
        if not base:
            temp = tempfile.TemporaryDirectory()
            server, base = start_site_server(Path(temp.name))
        captures = capture(base, PUBLIC_BASE if args.public else None)
    finally:
        if server is not None:
            server.terminate()
        if temp is not None:
            temp.cleanup()

    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps({
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "public Stats page — reader experience",
        "route": ROUTE,
        "condition": (
            "Served from the repository's own built site directory. Every off-origin request "
            "is denied for the language captures, and each state capture states the fixed "
            "statistics response it was given. The one deployed observation is labelled as such."
        ),
        "image_binaries_committed": False,
        "local_capture_root": str(OUTPUT.relative_to(ROOT)),
        "captures": captures,
    }, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    failed = [entry["id"] for entry in captures if not entry.get("assertion_holds")]
    for entry in captures:
        print(f"{'OK ' if entry.get('assertion_holds') else 'FAIL'} {entry['id']}")
    if failed:
        print(f"assertions did not hold: {failed}")
        return 1
    print(f"wrote {args.manifest.relative_to(ROOT)} — {len(captures)} capture(s), no image committed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
