#!/usr/bin/env python3
"""Prove the published guide is usable, and record the proof as a manifest.

UG-00's baseline recorded what a reader saw before the guide existed. This is the
companion for the change that ships it: it drives the journey a signed-out reader
takes — home, then Guide, then the first tutorial, then the product page the
tutorial returns them to — and checks the properties a reader depends on at both
review widths.

Per route it records the assertion, the checks that ran, and a sha256, and it
writes no image into the repository: rendered screenshots stay under the ignored
.artifacts/ path and only their hash is retained, per docs/capture-manifest-guard.md.

What it checks, and why each one is here rather than in an existing gate:

* accessibility (axe-core, critical and serious) on the guide documents only. The
  homepage and the search document have their own owners and their own findings;
  this change answers for the pages it adds.
* reflow at 200 percent, which WCAG 1.4.10 defines as the content at 320 CSS
  pixels wide. Halving each review width is that test.
* horizontal overflow and target size at both widths.
* keyboard reach and a visible focus indicator on every guide link.
* every internal link on a guide page returning 200.
* the whole journey with JavaScript switched off, including browser Back.

    python3 tools/capture_guide_release.py
    python3 tools/capture_guide_release.py --keep-going
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

AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
MANIFEST = ROOT / "docs" / "evidence" / "public-user-guide" / "guide-release" / "capture-manifest.json"
OUTPUT_DIR = ROOT / ".artifacts" / "guide-release"

GUIDE_HOME = "/guide/"
TUTORIAL = "/guide/start/explore-housing-across-city-records/"
SEARCH = "/search/?q=housing"

VIEWPORTS = (("mobile", 390, 844), ("desktop", 1440, 900))
MIN_TARGET_PX = 24  # WCAG 2.2 AA, 2.5.8 Target Size (Minimum)

ROUTES = (
    {
        "id": "home",
        "route": "/",
        "assertion": "The front page carries a visible Guide entry in its primary navigation that "
        "links to the guide home.",
        "expect_text": ["Guide", "Learn how to read city records"],
        "expect_links": [GUIDE_HOME],
        "axe": False,
    },
    {
        "id": "guide-home",
        "route": GUIDE_HOME,
        "assertion": "The guide home orients a signed-out reader with the four reader-facing "
        "sections and links the tutorial that is published.",
        "expect_text": [
            "Using CityScroll",
            "Start here",
            "How to…",
            "Understand",
            "Reference",
            "Explore housing across city records",
            "Last reviewed",
        ],
        "expect_links": [TUTORIAL],
        "axe": True,
    },
    {
        "id": "guide-tutorial",
        "route": TUTORIAL,
        "assertion": "The first tutorial loads directly with its type, review date, steps, "
        "checkpoints, sources and a link back to the task.",
        "expect_text": [
            "Explore housing across city records",
            "Start here · Tutorial",
            "Last reviewed",
            "Checkpoint",
            "Official source",
            "Try this search yourself",
        ],
        "expect_links": [GUIDE_HOME, SEARCH],
        "axe": True,
    },
    {
        "id": "product-search",
        "route": SEARCH,
        "assertion": "The product route the tutorial returns the reader to serves its document. "
        "Result content is assembled from live records and is not asserted here.",
        "expect_text": ["Search"],
        "expect_links": [],
        "axe": False,
    },
)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repository_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()


def working_tree_state() -> str:
    """Say whether the captured documents were the committed ones.

    A capture taken while the tree is dirty is still evidence, but a revision on
    its own would claim more than it can: the reader needs to know the run
    covered work that had not been committed at that revision yet.
    """
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
    page.wait_for_timeout(400)


def run_axe(page: Page) -> list[dict]:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate(
        "async () => await axe.run(document, {resultTypes: ['violations']})"
    )
    return [
        {"id": item["id"], "impact": item["impact"], "nodes": len(item["nodes"])}
        for item in result["violations"]
        if item["impact"] in ("critical", "serious")
    ]


def overflow(page: Page) -> dict:
    return page.evaluate(
        """() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        })"""
    )


def small_targets(page: Page, minimum: int) -> list[dict]:
    """Targets below the minimum, excluding links that sit inside a sentence.

    WCAG 2.5.8 exempts a target "in a sentence or its associated text", which is
    exactly what a link inside a paragraph of guide prose is. Forcing those to a
    fixed height would stop them wrapping mid-line and make the prose worse, so
    the check follows the exception rather than working around it.
    """
    return page.evaluate(
        """(minimum) => [...document.querySelectorAll('main a, main button')]
            .filter((node) => {
                const parent = node.parentElement;
                if (!parent) return true;
                const inProse = parent.tagName === 'P' || parent.tagName === 'LI';
                const otherText = (parent.innerText || '').trim().length
                    > (node.innerText || '').trim().length + 1;
                return !(inProse && otherText);
            })
            .map((node) => {
                const box = node.getBoundingClientRect();
                return {
                    text: (node.innerText || '').trim().slice(0, 40),
                    width: Math.round(box.width),
                    height: Math.round(box.height),
                };
            })
            .filter((item) => item.width > 0 && item.height > 0)
            .filter((item) => item.width < minimum || item.height < minimum)""",
        minimum,
    )


def keyboard_reach(page: Page) -> dict:
    """Tab through the document and record what a keyboard actually reaches.

    Real Tab presses rather than element.focus(), because :focus-visible — which
    is how this site draws focus — is only matched for keyboard interaction.
    """
    expected = page.evaluate(
        """() => [...new Set([...document.querySelectorAll('main a[href]')]
            .map((node) => node.getAttribute('href')))]"""
    )
    page.evaluate("() => document.body.focus()")
    page.keyboard.press("Home")
    reached = []
    without_indicator = []
    for _ in range(len(expected) * 3 + 30):
        page.keyboard.press("Tab")
        state = page.evaluate(
            """() => {
                const node = document.activeElement;
                if (!node || node === document.body) return null;
                const inMain = !!node.closest('main');
                const style = getComputedStyle(node);
                const visible = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
                return {
                    href: node.getAttribute && node.getAttribute('href'),
                    text: (node.innerText || '').trim().slice(0, 40),
                    inMain,
                    visibleFocus: visible,
                };
            }"""
        )
        if not state:
            continue
        if not state["inMain"] or not state["href"]:
            continue
        if state["href"] not in reached:
            reached.append(state["href"])
            if not state["visibleFocus"]:
                without_indicator.append(state["text"] or state["href"])
        if len(reached) >= len(expected):
            break
    return {
        "links": len(expected),
        "reached": len(reached),
        "unreachable": [href for href in expected if href not in reached],
        "withoutIndicator": without_indicator,
    }


def internal_links(page: Page) -> list[str]:
    return page.evaluate(
        """() => [...new Set([...document.querySelectorAll('a[href^="/"]')]
            .map((node) => node.getAttribute('href')))]"""
    )


def observe_route(page: Page, spec: dict, base: str, width: int) -> dict:
    # The front page assembles its main landmark in the browser; its static
    # navigation sits outside it, so read the whole document rather than main.
    text = page.evaluate("() => (document.body.innerText || '')")
    folded = text.casefold()
    missing_text = [needle for needle in spec["expect_text"] if needle.casefold() not in folded]
    hrefs = page.evaluate("() => [...document.querySelectorAll('a')].map((n) => n.getAttribute('href'))")
    missing_links = [href for href in spec["expect_links"] if href not in hrefs]

    metrics = overflow(page)
    overflowing = metrics["scrollWidth"] > metrics["clientWidth"] + 1

    # WCAG 1.4.10 reflow: the same content at half the review width.
    page.set_viewport_size({"width": max(width // 2, 320), "height": 844})
    settle(page)
    zoom_metrics = overflow(page)
    zoom_overflowing = zoom_metrics["scrollWidth"] > zoom_metrics["clientWidth"] + 1
    page.set_viewport_size({"width": width, "height": 844})
    settle(page)

    targets = small_targets(page, MIN_TARGET_PX)
    focus = keyboard_reach(page) if spec["axe"] else {"links": 0, "unreachable": [], "withoutIndicator": []}
    violations = run_axe(page) if spec["axe"] else []

    link_statuses = []
    if spec["axe"]:
        for href in internal_links(page):
            target = urljoin(base, href.lstrip("/"))
            response = page.request.get(target)
            link_statuses.append({"href": href, "status": response.status})

    broken_links = [item for item in link_statuses if item["status"] >= 400]
    holds = not (
        missing_text
        or missing_links
        or overflowing
        or zoom_overflowing
        or targets
        or focus["unreachable"]
        or focus["withoutIndicator"]
        or violations
        or broken_links
    )
    return {
        "assertion_holds": holds,
        "missing_expected_text": missing_text,
        "missing_expected_links": missing_links,
        "horizontal_overflow_px": max(metrics["scrollWidth"] - metrics["clientWidth"], 0),
        "horizontal_overflow_at_200_percent_px": max(
            zoom_metrics["scrollWidth"] - zoom_metrics["clientWidth"], 0
        ),
        "targets_below_%dpx" % MIN_TARGET_PX: targets,
        "keyboard": focus,
        "axe_critical_or_serious": violations,
        "internal_links_checked": len(link_statuses),
        "broken_internal_links": broken_links,
        "visible_text_characters": len(text),
        "content_sha256": sha256_text(
            page.evaluate("() => ((document.querySelector('main') || document.body).outerHTML)")
        ),
    }


def journey_with_script(page: Page, base: str) -> dict:
    """Home to Guide to the tutorial to the product, then Back to where we were."""
    steps = []
    page.goto(base, wait_until="domcontentloaded")
    settle(page)
    page.click(f'a[href="{GUIDE_HOME}"]')
    settle(page)
    steps.append({"step": "home to guide", "path": urlsplit(page.url).path})
    page.click(f'a[href="{TUTORIAL}"]')
    settle(page)
    steps.append({"step": "guide to tutorial", "path": urlsplit(page.url).path})
    page.click(f'a[href="{SEARCH}"]')
    settle(page)
    steps.append({"step": "tutorial to product", "path": urlsplit(page.url).path})
    page.go_back()
    settle(page)
    steps.append({"step": "back to tutorial", "path": urlsplit(page.url).path})
    page.go_back()
    settle(page)
    steps.append({"step": "back to guide", "path": urlsplit(page.url).path})
    expected = [GUIDE_HOME, TUTORIAL, "/search/", TUTORIAL, GUIDE_HOME]
    holds = [step["path"] for step in steps] == expected
    return {"assertion_holds": holds, "steps": steps, "expected_paths": expected}


def journey_without_script(page: Page, base: str) -> dict:
    """The same reading path with JavaScript switched off."""
    page.goto(urljoin(base, GUIDE_HOME.lstrip("/")), wait_until="domcontentloaded")
    home_text = page.evaluate("() => (document.querySelector('main').innerText || '')")
    home_headings = page.evaluate("() => [...document.querySelectorAll('main h1, main h2')].map((n) => n.innerText.trim())")
    page.click(f'a[href="{TUTORIAL}"]')
    page.wait_for_load_state("domcontentloaded")
    article_path = urlsplit(page.url).path
    article = page.evaluate(
        """() => ({
            headings: [...document.querySelectorAll('main h1, main h2, main h3')].map((n) => n.innerText.trim()),
            paragraphs: document.querySelectorAll('main p').length,
            sourceLinks: [...document.querySelectorAll('main a[href^="http"]')].map((n) => n.getAttribute('href')),
            backToGuide: !!document.querySelector(`main a[href="${'/guide/'}"]`),
            returnToTask: !!document.querySelector('main .guide-return a'),
        })"""
    )
    page.go_back()
    page.wait_for_load_state("domcontentloaded")
    back_path = urlsplit(page.url).path
    holds = (
        "Start here" in home_text
        and "Using CityScroll" in home_headings
        and article_path == TUTORIAL
        and len(article["headings"]) >= 8
        and article["paragraphs"] >= 15
        and bool(article["sourceLinks"])
        and article["backToGuide"]
        and article["returnToTask"]
        and back_path == GUIDE_HOME
    )
    return {
        "assertion_holds": holds,
        "guide_home_headings": home_headings,
        "article_path": article_path,
        "article": article,
        "back_path": back_path,
    }


def capture(base: str, output_dir: Path) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    captures: list[dict] = []
    journeys: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for name, width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                for spec in ROUTES:
                    page.goto(urljoin(base, spec["route"].lstrip("/")), wait_until="domcontentloaded")
                    settle(page)
                    image = output_dir / f"{spec['id']}-{width}.png"
                    page.screenshot(path=str(image), full_page=False)
                    captures.append(
                        {
                            "id": spec["id"],
                            "route": spec["route"],
                            "viewport": name,
                            "viewport_width": width,
                            "assertion": spec["assertion"],
                            **observe_route(page, spec, base, width),
                            "capture_sha256": sha256_file(image),
                            "local_capture_path": str(image.relative_to(ROOT)),
                            "file": None,
                        }
                    )
                journeys.append(
                    {
                        "id": "scripted-journey",
                        "viewport": name,
                        "assertion": "A reader reaches the tutorial from the front page through Guide, "
                        "leaves for the product, and the browser Back button returns them to where "
                        "they were.",
                        **journey_with_script(page, base),
                    }
                )
                context.close()

                no_script = browser.new_context(
                    viewport={"width": width, "height": height}, java_script_enabled=False
                )
                journeys.append(
                    {
                        "id": "journey-without-javascript",
                        "viewport": name,
                        "assertion": "With JavaScript switched off, the guide home and the tutorial "
                        "keep their text, headings, source links and navigation, and Back still works.",
                        **journey_without_script(no_script.new_page(), base),
                    }
                )
                no_script.close()
        finally:
            browser.close()
    return {"captures": captures, "journeys": journeys}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path, default=ROOT / "site")
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_DIR)
    parser.add_argument(
        "--keep-going",
        action="store_true",
        help="write the manifest and report failures without a non-zero exit",
    )
    args = parser.parse_args()

    server, thread, base = serve(args.site_dir)
    try:
        observed = capture(base, args.output_dir)
    finally:
        server.shutdown()
        thread.join()
        server.server_close()

    manifest = {
        "schema_version": 1,
        "card": "cityscroll-public-user-guide/ug-01-guide-home-and-first-tutorial",
        "capture_mode": "local_static_site_playwright_no_committed_image",
        "base": "local static site build (site/)",
        "repository_revision": repository_revision(),
        "repository_state": working_tree_state(),
        "note": (
            "Usability evidence for the first published slice of the public guide. Every check runs "
            "against the tracked static documents served locally, so it reproduces from a checkout "
            "with no network and no deploy. Accessibility, keyboard, reflow and link checks cover "
            "the guide documents this change adds; the front page and the search document keep "
            "their existing owners and are exercised here only as the journey's endpoints. "
            "Screenshots stay under the ignored .artifacts/ path and only their sha256 is recorded, "
            "per docs/capture-manifest-guard.md."
        ),
        "data_vintage": (
            "Not applicable to the guide documents: they are prose built from tracked sources and "
            "contain no civic records. Their review dates are editorial facts recorded in the "
            "article sources, not observations of live data. The search document is served from "
            "the local build and its results are not asserted."
        ),
        "viewports": [
            {"name": name, "width": width, "height": height} for name, width, height in VIEWPORTS
        ],
        "checks": [
            "expected reader-facing text and links",
            "axe-core critical and serious violations on guide documents",
            "horizontal overflow at the review width",
            "horizontal overflow at 200 percent zoom (WCAG 1.4.10 reflow)",
            f"target size below {MIN_TARGET_PX}px",
            "keyboard focus reach and a visible focus indicator",
            "HTTP status of every internal link on a guide page",
            "front page to guide to tutorial to product, and browser Back",
            "the same reading path with JavaScript switched off",
        ],
        **capture_sections(observed),
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n")

    failed = [item for item in observed["captures"] + observed["journeys"] if not item["assertion_holds"]]
    print(
        f"guide release: {len(observed['captures'])} captures and {len(observed['journeys'])} journeys "
        f"written to {args.manifest.relative_to(ROOT)}"
    )
    for item in failed:
        print(f"  assertion did not hold: {item['id']} @ {item.get('viewport')}")
        print(f"    {json.dumps({k: v for k, v in item.items() if k not in ('assertion',)})[:600]}")
    return 0 if not failed or args.keep_going else 1


def capture_sections(observed: dict) -> dict:
    return {"captures": observed["captures"], "journeys": observed["journeys"]}


if __name__ == "__main__":
    raise SystemExit(main())
