#!/usr/bin/env python3
"""Prove the published guide is reachable from the product, and record the proof.

Home → Guide → a tutorial → a relevant explanation → the product, at the two
review widths, plus About's preserved anchors and Following's one help link.
Images stay under .artifacts/; only hashes are committed.

    python3 tools/capture_guide_product_access.py
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import subprocess
import sys
import threading
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from local_site_server import QuietHandler, _RobustThreadingHTTPServer, probe_base  # noqa: E402

MANIFEST = ROOT / "docs" / "evidence" / "public-user-guide" / "guide-product-access" / "capture-manifest.json"
OUTPUT_DIR = ROOT / ".artifacts" / "guide-product-access"

GUIDE_HOME = "/guide/"
TUTORIAL = "/guide/start/explore-housing-across-city-records/"
EXPLANATION = "/guide/understand/what-a-public-record-tells-you/"
PRODUCT = "/search/?q=housing"
FOLLOWING = "/following/"
ABOUT = "/about.html"
FOLLOWING_HELP = "/guide/how-to/follow-a-search/"
ABOUT_ANCHORS = (
    "context",
    "past-patterns",
    "staffing-list-establishment-formula",
    "property-disposition-timing-formula",
    "tax-lien-sale-predictions",
    "zoning-base-rates",
    "applicant-conditioned-ulurp",
)
VIEWPORTS = (("mobile", 390, 844), ("desktop", 1440, 900))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repository_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()


def working_tree_state() -> str:
    changed = subprocess.run(
        ["git", "status", "--porcelain"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()
    return "clean" if not changed else "uncommitted changes present at capture time"


def serve(directory: Path):
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = _RobustThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    base = f"http://127.0.0.1:{server.server_port}/"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    probe_base(base)
    return server, thread, base


def settle(page: Page) -> None:
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(250)


def overflow(page: Page) -> dict:
    return page.evaluate(
        """() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        })"""
    )


def screenshot(page: Page, output_dir: Path, name: str) -> dict:
    image = output_dir / f"{name}.png"
    page.screenshot(path=str(image), full_page=False)
    html = page.evaluate("() => ((document.querySelector('main') || document.body).outerHTML)")
    return {
        "capture_sha256": sha256_file(image),
        "content_sha256": sha256_text(html),
        "local_capture_path": str(image.relative_to(ROOT)),
        "file": None,
        "path": urlsplit(page.url).path,
        "overflow": overflow(page),
    }


def journey(page: Page, base: str) -> dict:
    steps = []
    page.goto(base, wait_until="domcontentloaded")
    settle(page)
    page.click(f'nav[aria-label="Primary"] a[href="{GUIDE_HOME}"]')
    settle(page)
    steps.append({"step": "home to guide", "path": urlsplit(page.url).path})
    page.locator(f'a[href="{TUTORIAL}"]').first.click()
    settle(page)
    steps.append({"step": "guide to example", "path": urlsplit(page.url).path})
    page.locator(f'main a[href="{EXPLANATION}"]').first.click()
    settle(page)
    steps.append({"step": "example to explanation", "path": urlsplit(page.url).path})
    page.locator("main .guide-return a").first.click()
    settle(page)
    steps.append({"step": "explanation to product", "path": urlsplit(page.url).path})
    page.go_back()
    settle(page)
    steps.append({"step": "back to explanation", "path": urlsplit(page.url).path})
    expected = [GUIDE_HOME, TUTORIAL, EXPLANATION, "/browse/", EXPLANATION]
    holds = [step["path"] for step in steps] == expected
    return {"assertion_holds": holds, "steps": steps, "expected_paths": expected}


def about_anchors(page: Page, base: str) -> dict:
    page.goto(urljoin(base, ABOUT.lstrip("/")), wait_until="domcontentloaded")
    settle(page)
    found = page.evaluate(
        """(ids) => Object.fromEntries(ids.map((id) => [id, !!document.getElementById(id)]))""",
        list(ABOUT_ANCHORS),
    )
    guide = page.evaluate("() => !!document.querySelector('a[href=\"/guide/\"]')")
    flags = page.evaluate(
        "() => !!document.querySelector('a[href=\"/guide/understand/flags-and-historical-patterns/\"]')"
    )
    holds = all(found.values()) and guide and flags
    return {"assertion_holds": holds, "anchors": found, "guide_link": guide, "flags_link": flags}


def following_help(page: Page, base: str) -> dict:
    page.goto(urljoin(base, FOLLOWING.lstrip("/")), wait_until="domcontentloaded")
    settle(page)
    hrefs = page.evaluate(
        """() => [...document.querySelectorAll('a[href="/guide/how-to/follow-a-search/"]')]
            .map((n) => n.getAttribute('href'))"""
    )
    mast = page.evaluate(
        """() => [...document.querySelectorAll('nav[aria-label="Primary"] a')]
            .map((n) => n.getAttribute('href'))"""
    )
    holds = hrefs == [FOLLOWING_HELP] and GUIDE_HOME in mast
    return {
        "assertion_holds": holds,
        "help_hrefs": hrefs,
        "primary_nav": mast,
    }


def capture(base: str, output_dir: Path) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    captures = []
    journeys = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for name, width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                page.goto(base, wait_until="domcontentloaded")
                settle(page)
                captures.append({
                    "id": f"home-{name}",
                    "route": "/",
                    "viewport": name,
                    "viewport_width": width,
                    "assertion": "Home primary navigation includes Guide.",
                    "assertion_holds": page.locator(f'nav[aria-label="Primary"] a[href="{GUIDE_HOME}"]').count() == 1,
                    **screenshot(page, output_dir, f"home-{width}"),
                })
                page.goto(urljoin(base, GUIDE_HOME.lstrip("/")), wait_until="domcontentloaded")
                settle(page)
                captures.append({
                    "id": f"guide-home-{name}",
                    "route": GUIDE_HOME,
                    "viewport": name,
                    "viewport_width": width,
                    "assertion": "Guide home lists Start here and marks Guide current in the mast.",
                    "assertion_holds": "Start here" in (page.locator("main").inner_text())
                    and page.locator('nav[aria-label="Primary"] a[aria-current="page"][href="/guide/"]').count() == 1,
                    **screenshot(page, output_dir, f"guide-home-{width}"),
                })
                page.goto(urljoin(base, ABOUT.lstrip("/")), wait_until="domcontentloaded")
                settle(page)
                captures.append({
                    "id": f"about-{name}",
                    "route": ABOUT,
                    "viewport": name,
                    "viewport_width": width,
                    "assertion": "About still names independence and links Guide.",
                    "assertion_holds": "independent" in page.locator("main").inner_text().lower()
                    and page.locator('a[href="/guide/"]').count() >= 1,
                    **screenshot(page, output_dir, f"about-{width}"),
                })
                journeys.append({
                    "id": f"scripted-journey-{name}",
                    "viewport": name,
                    "assertion": "Home → Guide → example → explanation → product, then Back.",
                    **journey(page, base),
                })
                journeys.append({
                    "id": f"about-anchors-{name}",
                    "viewport": name,
                    "assertion": "Every cited About fragment still has an in-page target.",
                    **about_anchors(page, base),
                })
                journeys.append({
                    "id": f"following-help-{name}",
                    "viewport": name,
                    "assertion": "Following shows one help link to the follow-a-search article.",
                    **following_help(page, base),
                })
                context.close()

                no_script = browser.new_context(
                    viewport={"width": width, "height": height}, java_script_enabled=False
                )
                ns_page = no_script.new_page()
                ns_page.goto(base, wait_until="domcontentloaded")
                ns_page.click(f'nav[aria-label="Primary"] a[href="{GUIDE_HOME}"]')
                ns_page.wait_for_load_state("domcontentloaded")
                ns_page.click(f'a[href="{TUTORIAL}"]')
                ns_page.wait_for_load_state("domcontentloaded")
                tutorial_path = urlsplit(ns_page.url).path
                ns_page.go_back()
                ns_page.wait_for_load_state("domcontentloaded")
                back_path = urlsplit(ns_page.url).path
                journeys.append({
                    "id": f"journey-without-javascript-{name}",
                    "viewport": name,
                    "assertion": "The same Guide path works with JavaScript switched off, including Back.",
                    "assertion_holds": tutorial_path == TUTORIAL and back_path == GUIDE_HOME,
                    "tutorial_path": tutorial_path,
                    "back_path": back_path,
                })
                no_script.close()
        finally:
            browser.close()
    return {"captures": captures, "journeys": journeys}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path, default=ROOT / "site")
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_DIR)
    parser.add_argument("--keep-going", action="store_true")
    args = parser.parse_args()

    server, thread, base = serve(args.site_dir)
    try:
        observed = capture(base, args.output_dir)
    finally:
        server.shutdown()
        thread.join()
        server.server_close()

    failed = [item for item in observed["captures"] + observed["journeys"] if not item["assertion_holds"]]
    manifest = {
        "schema_version": 1,
        "record": "cityscroll-engineering/guide-product-access",
        "capture_mode": "local_static_site_playwright_no_committed_image",
        "base": "local static site build (site/)",
        "repository_revision": repository_revision(),
        "repository_state": working_tree_state(),
        "note": (
            "Reachability evidence for connecting the published guide to the product. "
            "The run covers home → Guide → an example → a relevant explanation → the "
            "product, About's preserved anchors, and Following's one help link, at 390px "
            "and 1440px. Screenshots stay under .artifacts/; only sha256 values are committed."
        ),
        "data_vintage": "Not applicable: these documents are tracked prose and chrome, not civic records.",
        "viewports": [
            {"name": name, "width": width, "height": height} for name, width, height in VIEWPORTS
        ],
        **observed,
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        f"guide product access: {len(observed['captures'])} captures and "
        f"{len(observed['journeys'])} journeys written to {args.manifest.relative_to(ROOT)}"
    )
    if failed and not args.keep_going:
        for item in failed:
            print(f"FAIL {item['id']}: {item['assertion']}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
