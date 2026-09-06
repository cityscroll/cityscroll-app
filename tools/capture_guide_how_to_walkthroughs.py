#!/usr/bin/env python3
"""Walk the five everyday how-to guides to the product, and record the proof.

Each how-to sends a reader to a real product route and promises an observable end
state. This drives that journey for every one of them against a locally served
static site and records the result as a manifest.

What every published guide article owes a reader — accessibility, keyboard reach
and focus, reflow at 200 percent, target size, overflow, the status of every
internal link, and the page read with JavaScript switched off — belongs to
tools/capture_guide_release.py, which derives its list from the builder and so
already covers these five. This runner does not repeat any of it. It answers the
question that one cannot: whether the journey each article describes actually
arrives somewhere, and whether describing it cost the reader anything.

So it records three things per article, at both review widths:

* the walkthrough — guide home, article, the product route the article names, then
  the browser Back button twice, back to where the reader started;
* a command or control click on that same link, which must open a second page and
  leave the article where it was. Nothing on a guide page listens for a click, so
  this is a property of the document rather than of a handler — which is why it is
  worth recording, since a page that started intercepting clicks would break the
  ordinary gesture for opening a link in a new tab with no other symptom;
* the read-only evidence. Public inspection is read-only here by construction and
  says so with evidence rather than assertion: the run follows only the routes
  named in this file, blocks and records every form submission, and fails on any
  request to a signup, preference, confirmation, unsubscribe or feed route. A
  guide that told a reader to enrol an address, submit testimony or create a
  subscription could not be verified this way, which is the point — the guides
  describe those steps, and this proves the walkthrough did not take them.

    python3 tools/capture_guide_how_to_walkthroughs.py
    python3 tools/capture_guide_how_to_walkthroughs.py --keep-going
"""

from __future__ import annotations

import argparse
import functools
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

MANIFEST = ROOT / "docs" / "evidence" / "public-user-guide" / "guide-how-to-release" / "capture-manifest.json"

GUIDE_HOME = "/guide/"
VIEWPORTS = (("mobile", 390, 844), ("desktop", 1440, 900))

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
        "Council District 7, and states how the watch resolves through that board's district.",
        "expect_text": [
            "Manhattan Community Board 7",
            "City Council District 7",
            "A board number is not a district number",
            "the community district that board covers",
            "Coverage depends on that district link",
            "not a preview of your email",
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


def modified_click(page: Page, base: str, spec: dict) -> dict:
    """A command/control click on a guide link must open a second page, not navigate.

    Nothing on a guide page listens for a click, so this is a property of the
    document rather than of a handler — which is exactly what makes it worth
    recording. A page that started intercepting clicks would break the ordinary
    browser gesture for opening a link in a new tab, silently.
    """
    page.goto(urljoin(base, spec["route"].lstrip("/")), wait_until="domcontentloaded")
    settle(page)
    before = urlsplit(page.url).path
    opened = None
    with page.context.expect_page() as popup:
        page.locator(f'main a[href^="{spec["product"]}"]').first.click(
            modifiers=["ControlOrMeta"]
        )
    opened_page = popup.value
    opened_page.wait_for_load_state("domcontentloaded")
    opened = urlsplit(opened_page.url).path
    opened_page.close()
    stayed = urlsplit(page.url).path
    return {
        "assertion_holds": opened == spec["product"] and stayed == before,
        "opened_in_new_page": opened,
        "original_page_stayed_on": stayed,
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


def capture(base: str) -> dict:
    walkthroughs: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for name, width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                watch = ReadOnlyWatch(page)
                for spec in ARTICLES:
                    walkthroughs.append(
                        {
                            "id": f"modified-click-{spec['id'].lower()}",
                            "article": spec["id"],
                            "route": spec["route"],
                            "viewport": name,
                            "viewport_width": width,
                            "entry_route": spec["entry"],
                            "assertion": "A command or control click on the product link opens a "
                            "second page and leaves the article where it was, because nothing on a "
                            "guide page intercepts a click.",
                            **modified_click(page, base, spec),
                        }
                    )
                for spec in ARTICLES:
                    walkthroughs.append(
                        {
                            "id": f"walkthrough-{spec['id'].lower()}",
                            "article": spec["id"],
                            "route": spec["route"],
                            "viewport": name,
                            "viewport_width": width,
                            "entry_route": spec["entry"],
                            "assertion": spec["walkthrough"],
                            **walkthrough(page, base, spec, watch),
                        }
                    )
                context.close()
        finally:
            browser.close()
    return {"walkthroughs": walkthroughs}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path, default=ROOT / "site")
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument(
        "--keep-going",
        action="store_true",
        help="write the manifest and report failures without a non-zero exit",
    )
    args = parser.parse_args()

    server, thread, base = serve(args.site_dir)
    try:
        observed = capture(base)
    finally:
        server.shutdown()
        thread.join()
        server.server_close()

    manifest = {
        "schema_version": 1,
        "record": "cityscroll-engineering/guide-everyday-how-to-articles",
        "capture_mode": "local_static_site_playwright_no_image_taken",
        "base": "local static site build (site/)",
        "repository_revision": repository_revision(),
        "repository_state": working_tree_state(),
        "note": (
            "Journey evidence for the five everyday how-to guides. Every check runs against the "
            "tracked static documents served locally, so it reproduces from a checkout with no "
            "network and no deploy. What every published article owes a reader — accessibility, "
            "keyboard reach and focus, reflow, target size, overflow, internal link status, and "
            "the page read without JavaScript — is not repeated here: tools/capture_guide_release.py "
            "derives its list from the builder and already covers these five. This runner records "
            "what that one cannot, which is whether the journey each article describes arrives, "
            "and what taking it cost. No image is taken at all, so none can be committed."
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
            "guide home to article to the product route it names, and browser Back twice",
            "a command or control click opens a second page instead of navigating",
            "no form submission and no request to a state-changing route",
        ],
        "covered_elsewhere": {
            "owner": "tools/capture_guide_release.py",
            "checks": [
                "axe-core critical and serious violations on every guide document",
                "horizontal overflow at the review width and at 200 percent zoom",
                "target size, keyboard focus reach and a visible focus indicator",
                "HTTP status of every internal link on a guide page",
                "every article read with JavaScript switched off",
            ],
        },
        "walkthroughs": observed["walkthroughs"],
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n")

    failed = [item for item in observed["walkthroughs"] if not item["assertion_holds"]]
    print(
        f"guide how-to walkthroughs: {len(observed['walkthroughs'])} recorded in "
        f"{args.manifest.relative_to(ROOT)}"
    )
    for item in failed:
        print(f"  assertion did not hold: {item['id']} @ {item.get('viewport')}")
        print(f"    {json.dumps({k: v for k, v in item.items() if k != 'assertion'})[:600]}")
    if failed and not args.keep_going:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
