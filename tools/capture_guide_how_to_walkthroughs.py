#!/usr/bin/env python3
"""Walk the five everyday how-to guides the way a reader would, and record the proof.

Each how-to sends a reader to a real product route and promises an observable end
state. This drives that journey for every one of them against a locally served
static site, checks the properties a reader depends on at both review widths, and
writes the result as a manifest. No image enters the repository: rendered
screenshots stay under the ignored .artifacts/ path and only their sha256 is
retained, per docs/capture-manifest-guard.md.

Everything here is read-only by construction, and says so with evidence rather
than assertion. The walkthroughs only ever follow anchors to routes named in this
file; the run records every form submission the pages attempted (expected: none)
and every network request that reached a route capable of changing state — the
signup endpoint, the calendar feed, the preference centre. A guide that told a
reader to enrol an address, submit testimony or create a subscription could not be
verified this way, which is the point: the guides describe those steps, and the
check proves the walkthrough did not take them.

What is checked, per article, at 390px and 1440px:

* the reader-facing text the article promises, and the product entry link it names;
* axe-core critical and serious findings;
* horizontal overflow at the review width and at 200 percent zoom (WCAG 1.4.10);
* target size, keyboard reach, and a visible focus indicator;
* the HTTP status of every internal link on the page;
* guide home to article to product route and back again, including browser Back;
* the same reading path with JavaScript switched off.

    python3 tools/capture_guide_how_to_walkthroughs.py
    python3 tools/capture_guide_how_to_walkthroughs.py --keep-going
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
MANIFEST = ROOT / "docs" / "evidence" / "public-user-guide" / "guide-how-to-release" / "capture-manifest.json"
OUTPUT_DIR = ROOT / ".artifacts" / "guide-how-to-release"

GUIDE_HOME = "/guide/"
VIEWPORTS = (("mobile", 390, 844), ("desktop", 1440, 900))
MIN_TARGET_PX = 24  # WCAG 2.2 AA, 2.5.8 Target Size (Minimum)

# Routes that would change something if they were requested. The walkthroughs
# never navigate to one, and the run fails if a page reaches for one on its own.
STATE_CHANGING_PREFIXES = ("/subscribe", "/prefs", "/confirm", "/unsubscribe", "/feed.")

ARTICLES = (
    {
        "id": "H1",
        "route": "/guide/how-to/find-and-narrow-records/",
        "entry": "/search/",
        "product": "/exams/7016/",
        "assertion": "Find and narrow records opens with the task, its prerequisites and a search "
        "entry link, teaches People + organizations, Staffing and Exams as three destinations, and "
        "ends on a view the reader can reopen.",
        "expect_text": [
            "Your task",
            "Before you start",
            "People + organizations",
            "Staffing",
            "Exams",
            "When nothing comes back",
            "You are done when",
            "Last reviewed",
        ],
        "expect_links": ["/search/", "/browse/people/", "/browse/staffing/", "/browse/exams/", "/exams/7016/"],
        "walkthrough": "A reader reaches the article from the guide home, follows it to an exam "
        "record whose application window is published as closed, and Back returns them to the "
        "article and then to the guide home.",
    },
    {
        "id": "H2",
        "route": "/guide/how-to/follow-a-search/",
        "entry": "/following/",
        "product": "/following/",
        "assertion": "Follow a search opens with the task, its prerequisites and the Following "
        "entry link, keeps a preview separate from a created watch, describes one-step enrolment, "
        "and ends with a watch the reader can manage.",
        "expect_text": [
            "Your task",
            "Before you start",
            "It is not a subscription",
            "no confirmation email to click",
            "When the page does not recognize you",
            "You are done when",
        ],
        "expect_links": ["/following/"],
        "walkthrough": "A reader reaches the article from the guide home, follows it to Following, "
        "and Back returns them to the article and then to the guide home. Nothing is submitted.",
    },
    {
        "id": "H3",
        "route": "/guide/how-to/follow-a-community-board/",
        "entry": "/following/",
        "product": "/following/",
        "assertion": "Follow a Community Board opens with the task, its prerequisites and the "
        "Following entry link, names Manhattan Community Board 7 in full, separates it from City "
        "Council District 7, and says the matches are district-scoped.",
        "expect_text": [
            "Manhattan Community Board 7",
            "City Council District 7",
            "A board number is not a district number",
            "the community district the board covers",
            "not a claim that the board convened it",
            "You are done when",
        ],
        "expect_links": ["/following/", "/community-boards/"],
        "walkthrough": "A reader reaches the article from the guide home, follows it to Following, "
        "and Back returns them to the article and then to the guide home. No watch is created.",
    },
    {
        "id": "H4",
        "route": "/guide/how-to/put-dates-in-your-calendar/",
        "entry": "/now/",
        "product": "/now/",
        "assertion": "Put dates in your calendar opens with the task, its prerequisites and the Now "
        "entry link, separates a single event from a continuing subscription, refuses to invent a "
        "time for a date-only deadline, and claims nothing about the reader's calendar.",
        "expect_text": [
            "Act by",
            "Happening soon",
            "Add to calendar",
            "Subscribe to calendar",
            "will not invent nine o'clock",
            "no way to know what your calendar did with it",
            "When there is nothing to subscribe to",
            "You are done when",
        ],
        "expect_links": ["/now/", "/browse/meetings/", "/following/"],
        "walkthrough": "A reader reaches the article from the guide home, follows it to Now, and "
        "Back returns them to the article and then to the guide home. No subscription is created.",
    },
    {
        "id": "H5",
        "route": "/guide/how-to/read-a-land-use-projects-next-step/",
        "entry": "/browse/zoning/",
        "product": "/browse/zoning/",
        "assertion": "Read a land-use project opens with the task, its prerequisites and the "
        "land-use entry link, reads Where this stands, separates a calculated window from a "
        "published date, reaches real documents, and covers the unknown cases.",
        "expect_text": [
            "Where this stands",
            "Current stage",
            "Published next opportunity",
            "Racial Equity Report",
            "Zoning Application Portal",
            "When the page does not know",
            "You are done when",
        ],
        "expect_links": ["/browse/zoning/"],
        "walkthrough": "A reader reaches the article from the guide home, follows it to the "
        "land-use collection, and Back returns them to the article and then to the guide home. "
        "Nothing is filed.",
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
    """Say whether the captured documents were the committed ones."""
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
    result = page.evaluate("async () => await axe.run(document, {resultTypes: ['violations']})")
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
    what a link inside a paragraph of guide prose is.
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
    """Tab through the document and record what a keyboard actually reaches."""
    expected = page.evaluate(
        """() => [...new Set([...document.querySelectorAll('main a[href]')]
            .map((node) => node.getAttribute('href')))]"""
    )
    page.evaluate("() => document.body.focus()")
    page.keyboard.press("Home")
    reached: list[str] = []
    without_indicator: list[str] = []
    for _ in range(len(expected) * 3 + 30):
        page.keyboard.press("Tab")
        state = page.evaluate(
            """() => {
                const node = document.activeElement;
                if (!node || node === document.body) return null;
                const style = getComputedStyle(node);
                return {
                    href: node.getAttribute && node.getAttribute('href'),
                    text: (node.innerText || '').trim().slice(0, 40),
                    inMain: !!node.closest('main'),
                    visibleFocus: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
                };
            }"""
        )
        if not state or not state["inMain"] or not state["href"]:
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
    focus = keyboard_reach(page)
    violations = run_axe(page)

    link_statuses = []
    for href in internal_links(page):
        response = page.request.get(urljoin(base, href.lstrip("/")))
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


class ReadOnlyWatch:
    """Record what a page did that a read-only inspection must not do."""

    def __init__(self, page: Page):
        self.submits: list[str] = []
        self.state_changing_requests: list[str] = []
        page.add_init_script(
            """window.__guideSubmits = [];
            addEventListener('submit', (event) => {
                window.__guideSubmits.push((event.target && event.target.action) || 'form');
                event.preventDefault();
            }, true);"""
        )
        page.on("request", self._on_request)

    def _on_request(self, request) -> None:
        path = urlsplit(request.url).path
        if any(path.startswith(prefix) for prefix in STATE_CHANGING_PREFIXES):
            self.state_changing_requests.append(f"{request.method} {path}")

    def absorb(self, page: Page) -> None:
        """Take the current document's submit record before it is navigated away."""
        try:
            self.submits += page.evaluate("() => window.__guideSubmits || []")
        except Exception:  # a document that has already gone has no state left to read
            pass

    def collect(self, page: Page) -> dict:
        self.absorb(page)
        return {
            "form_submissions": sorted(set(self.submits)),
            "state_changing_requests": sorted(set(self.state_changing_requests)),
        }


def walkthrough(page: Page, base: str, spec: dict, watch: ReadOnlyWatch) -> dict:
    """Guide home to the article to the product route it names, then Back twice."""
    steps = []
    page.goto(urljoin(base, GUIDE_HOME.lstrip("/")), wait_until="domcontentloaded")
    settle(page)
    page.locator(f'main a[href="{spec["route"]}"]').first.click()
    settle(page)
    steps.append({"step": "guide home to article", "path": urlsplit(page.url).path})
    page.locator(f'main a[href^="{spec["product"]}"]').first.click()
    settle(page)
    steps.append({"step": "article to the product route it names", "path": urlsplit(page.url).path})
    served = page.evaluate("() => document.title || ''")
    # Read the product page's own submit record before navigating away from it.
    watch.absorb(page)
    page.go_back()
    settle(page)
    steps.append({"step": "back to the article", "path": urlsplit(page.url).path})
    page.go_back()
    settle(page)
    steps.append({"step": "back to the guide home", "path": urlsplit(page.url).path})

    expected = [spec["route"], spec["product"], spec["route"], GUIDE_HOME]
    read_only = watch.collect(page)
    holds = (
        [step["path"] for step in steps] == expected
        and bool(served.strip())
        and not read_only["form_submissions"]
        and not read_only["state_changing_requests"]
    )
    return {
        "assertion_holds": holds,
        "steps": steps,
        "expected_paths": expected,
        "product_document_title": served,
        **read_only,
    }


def without_script(page: Page, base: str, spec: dict) -> dict:
    """The same reading path with JavaScript switched off."""
    page.goto(urljoin(base, GUIDE_HOME.lstrip("/")), wait_until="domcontentloaded")
    page.locator(f'main a[href="{spec["route"]}"]').first.click()
    page.wait_for_load_state("domcontentloaded")
    article_path = urlsplit(page.url).path
    article = page.evaluate(
        """() => ({
            headings: [...document.querySelectorAll('main h1, main h2')].map((n) => n.innerText.trim()),
            paragraphs: document.querySelectorAll('main p').length,
            sourceLinks: [...document.querySelectorAll('main a[href^="http"]')].map((n) => n.getAttribute('href')),
            backToGuide: !!document.querySelector('main a[href="/guide/"]'),
            returnToTask: !!document.querySelector('main .guide-return a'),
        })"""
    )
    page.go_back()
    page.wait_for_load_state("domcontentloaded")
    back_path = urlsplit(page.url).path
    holds = (
        article_path == spec["route"]
        and len(article["headings"]) >= 6
        and article["paragraphs"] >= 10
        and bool(article["sourceLinks"])
        and article["backToGuide"]
        and article["returnToTask"]
        and back_path == GUIDE_HOME
    )
    return {"assertion_holds": holds, "article_path": article_path, "article": article, "back_path": back_path}


def capture(base: str, output_dir: Path) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    captures: list[dict] = []
    walkthroughs: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for name, width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                watch = ReadOnlyWatch(page)
                for spec in ARTICLES:
                    page.goto(urljoin(base, spec["route"].lstrip("/")), wait_until="domcontentloaded")
                    settle(page)
                    image = output_dir / f"{spec['id'].lower()}-{width}.png"
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
                for spec in ARTICLES:
                    walkthroughs.append(
                        {
                            "id": f"walkthrough-{spec['id'].lower()}",
                            "article": spec["id"],
                            "viewport": name,
                            "entry_route": spec["entry"],
                            "assertion": spec["walkthrough"],
                            **walkthrough(page, base, spec, watch),
                        }
                    )
                context.close()

                no_script = browser.new_context(
                    viewport={"width": width, "height": height}, java_script_enabled=False
                )
                quiet_page = no_script.new_page()
                for spec in ARTICLES:
                    walkthroughs.append(
                        {
                            "id": f"without-javascript-{spec['id'].lower()}",
                            "article": spec["id"],
                            "viewport": name,
                            "entry_route": spec["entry"],
                            "assertion": "With JavaScript switched off, the article keeps its text, "
                            "headings, source links and navigation, and Back still works.",
                            **without_script(quiet_page, base, spec),
                        }
                    )
                no_script.close()
        finally:
            browser.close()
    return {"captures": captures, "walkthroughs": walkthroughs}


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
        "record": "cityscroll-engineering/guide-everyday-how-to-articles",
        "capture_mode": "local_static_site_playwright_no_committed_image",
        "base": "local static site build (site/)",
        "repository_revision": repository_revision(),
        "repository_state": working_tree_state(),
        "note": (
            "Usability and walkthrough evidence for the five everyday how-to guides. Every check "
            "runs against the tracked static documents served locally, so it reproduces from a "
            "checkout with no network and no deploy. Accessibility, keyboard, reflow and link "
            "checks cover the guide documents this change adds; the product routes each article "
            "names keep their existing owners and are exercised here only as walkthrough "
            "endpoints, where the assertion is that the document serves and Back returns. "
            "Screenshots stay under the ignored .artifacts/ path and only their sha256 is "
            "recorded, per docs/capture-manifest-guard.md."
        ),
        "read_only_contract": (
            "Public inspection only. The walkthroughs follow anchors to the routes named in "
            "tools/capture_guide_how_to_walkthroughs.py and nothing else. No email address is "
            "entered, no testimony is submitted and no calendar subscription is created; every "
            "form submission is blocked and recorded, and any request to a signup, preference, "
            "confirmation, unsubscribe or feed route would fail the run. Both counts are reported "
            "per walkthrough below."
        ),
        "data_vintage": (
            "Not applicable to the guide documents: they are prose built from tracked sources and "
            "contain no civic records. Their review dates are editorial facts recorded in the "
            "article sources, not observations of live data. The product routes are served from "
            "the local build and the records they list are not asserted, because a guide that "
            "depended on today's records would be wrong tomorrow."
        ),
        "viewports": [{"name": name, "width": width, "height": height} for name, width, height in VIEWPORTS],
        "checks": [
            "expected reader-facing text and the product entry link each article names",
            "axe-core critical and serious violations on every guide document",
            "horizontal overflow at the review width",
            "horizontal overflow at 200 percent zoom (WCAG 1.4.10 reflow)",
            f"target size below {MIN_TARGET_PX}px",
            "keyboard focus reach and a visible focus indicator",
            "HTTP status of every internal link on a guide page",
            "guide home to article to the product route it names, and browser Back twice",
            "the same reading path with JavaScript switched off",
            "no form submission and no request to a state-changing route",
        ],
        "captures": observed["captures"],
        "walkthroughs": observed["walkthroughs"],
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n")

    failed = [item for item in observed["captures"] + observed["walkthroughs"] if not item["assertion_holds"]]
    print(
        f"guide how-to release: {len(observed['captures'])} captures and "
        f"{len(observed['walkthroughs'])} walkthroughs written to {args.manifest.relative_to(ROOT)}"
    )
    for item in failed:
        print(f"  assertion did not hold: {item['id']} @ {item.get('viewport')}")
        print(f"    {json.dumps({k: v for k, v in item.items() if k != 'assertion'})[:600]}")
    if failed and not args.keep_going:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
