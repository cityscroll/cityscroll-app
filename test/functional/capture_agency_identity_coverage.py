#!/usr/bin/env python3
"""Capture the agency identity-and-coverage disclosure at review viewports.

The current checkout is the "after" state. The parent revision is archived and
built as "before":

    python3 test/functional/capture_agency_identity_coverage.py

Specimens follow the registered card: DSNY as the six-category stable-route
profile, NYCEDC as the route-present profile, and the EEP comparison-key
collision as the uncertainty specimen. Collision and unresolved routes are
served by the edge worker, so their document is rendered into the served tree
at the same route a reader would open.
"""

from __future__ import annotations

import argparse
import functools
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import Browser, Page, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs" / "screenshots" / "agency-identity-and-coverage"
VIEWPORTS = ((390, 844), (1440, 900))
DISCLOSURE = "#agency-identity-and-coverage"
UNCERTAINTY_ROUTE = "equal-employ-practices-comm"
SPECIMENS = (
    ("dsny", "/agencies/sanitation/", "DSNY — six-category stable route"),
    ("nycedc", "/agencies/economic-development-corporation/", "NYCEDC — route-present profile"),
    ("eep-collision", f"/agencies/{UNCERTAINTY_ROUTE}/", "EEP — publisher comparison-key collision"),
)


class StaticServer:
    def __init__(self, root: Path) -> None:
        self.root = root

    def __enter__(self) -> str:
        handler = functools.partial(SimpleHTTPRequestHandler, directory=str(self.root))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def revision_snapshot(revision: str, destination: Path) -> None:
    result = subprocess.run(
        ["git", "archive", "--format=tar", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
        archive.extractall(destination)


def restore_working_tree() -> None:
    """Leave no build residue behind: the capture must not dirty the checkout."""
    stray = ROOT / "site" / "agencies" / UNCERTAINTY_ROUTE
    if stray.exists():
        shutil.rmtree(stray)
    subprocess.run(["git", "checkout", "--", "site/agencies"], cwd=ROOT, check=True)


def build_tree(tree: Path) -> None:
    """Agency profile HTML is a build artifact; generate it before serving."""
    subprocess.run(
        ["node", "tools/build_agency_constellation_documents.mjs"],
        cwd=tree,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    document = subprocess.run(
        ["node", "test/functional/render_agency_uncertainty_document.mjs", UNCERTAINTY_ROUTE],
        cwd=tree,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout
    target = tree / "site" / "agencies" / UNCERTAINTY_ROUTE
    target.mkdir(parents=True, exist_ok=True)
    (target / "index.html").write_text(document, encoding="utf-8")


def block_remote(page: Page) -> None:
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())


def annotate(page: Page, label: str) -> None:
    page.evaluate(
        """(labelText) => {
            const banner = document.createElement('div');
            banner.textContent = labelText;
            banner.style.cssText = [
                'position:fixed', 'inset:0 0 auto 0', 'z-index:2147483647',
                'background:#111', 'color:#fff', 'font:600 13px/1.5 system-ui,sans-serif',
                'padding:6px 10px',
            ].join(';');
            document.body.appendChild(banner);
        }""",
        label,
    )


def capture(browser: Browser, tree: Path, state: str, width: int, height: int) -> dict:
    results = []
    with StaticServer(tree / "site") as base_url:
        for slug, route, description in SPECIMENS:
            page = browser.new_page(viewport={"width": width, "height": height})
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            block_remote(page)
            page.goto(base_url + route, wait_until="networkidle")

            disclosure = page.locator(DISCLOSURE)
            present = disclosure.count() > 0
            headline = ""
            if present:
                disclosure.first.scroll_into_view_if_needed()
                headline = page.locator(f"{DISCLOSURE} [data-coverage-headline]").first.inner_text()
                # Prove the disclosure is inspectable, not only present.
                page.locator(f"{DISCLOSURE} details").first.evaluate("node => node.open = true")
                disclosure.first.screenshot(
                    path=str(OUTPUT / f"{state}-{slug}-{width}-focus.png"),
                    animations="disabled",
                )

            annotate(page, f"{state.upper()} — {description} — {DISCLOSURE} "
                           f"{'present' if present else 'absent'}")
            page.screenshot(path=str(OUTPUT / f"{state}-{slug}-{width}.png"), animations="disabled")
            assert not errors, errors
            results.append({
                "specimen": slug,
                "route": route,
                "viewport": f"{width}x{height}",
                "disclosure_present": present,
                "headline": headline,
            })
            page.close()
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", default="HEAD", help="Git revision for the before state.")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)

    revision = subprocess.run(
        ["git", "rev-parse", args.before],
        cwd=ROOT, check=True, stdout=subprocess.PIPE, text=True,
    ).stdout.strip()

    observations = []
    with tempfile.TemporaryDirectory(prefix="crol-agency-coverage-") as temp:
        before_tree = Path(temp) / "before"
        before_tree.mkdir()
        revision_snapshot(args.before, before_tree)
        # The helper is new in this change; the before tree still needs it to
        # render the same uncertainty route.
        (before_tree / "test" / "functional").mkdir(parents=True, exist_ok=True)
        (before_tree / "test" / "functional" / "render_agency_uncertainty_document.mjs").write_text(
            (ROOT / "test" / "functional" / "render_agency_uncertainty_document.mjs").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        build_tree(before_tree)
        build_tree(ROOT)

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    for width, height in VIEWPORTS:
                        for state, tree in (("before", before_tree), ("after", ROOT)):
                            for row in capture(browser, tree, state, width, height):
                                observations.append({"state": state, **row})
                finally:
                    browser.close()
        finally:
            restore_working_tree()

    before_rows = [row for row in observations if row["state"] == "before"]
    after_rows = [row for row in observations if row["state"] == "after"]
    assert before_rows and not any(row["disclosure_present"] for row in before_rows), \
        "before state must not already disclose identity and coverage"
    assert after_rows and all(row["disclosure_present"] for row in after_rows), \
        "after state must disclose identity and coverage on every specimen"
    assert all(row["headline"] for row in after_rows), "every disclosure needs a capability summary"

    receipt = {
        "schema": "cityscroll.agency_identity_coverage_capture.v1",
        "card": "cityscroll-civic-institutions/ci-k1-reader-profile-disclosure",
        "before_revision": revision,
        "viewports": [f"{width}x{height}" for width, height in VIEWPORTS],
        "demonstrates": (
            "Before, the ordinary agency route shows no identity-and-coverage disclosure. "
            "After, DSNY and NYCEDC expose a concise capability summary with an inspectable "
            "disclosure, and the EEP comparison-key collision names its evidence state instead "
            "of claiming zero activity."
        ),
        "observations": observations,
    }
    (OUTPUT / "capture-receipt.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    print("Agency identity-and-coverage capture passed.")
    for row in observations:
        print(f"  {row['state']:6} {row['specimen']:14} {row['viewport']:9} "
              f"disclosure={'yes' if row['disclosure_present'] else 'no':3} {row['headline']}")
    for asset in sorted(OUTPUT.glob("*.png")):
        print(f"  {asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
