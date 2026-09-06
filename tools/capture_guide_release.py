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

A later change that touches the guide re-runs the same checks for its own record
by naming its record identity and its own manifest path, so an existing manifest
is never rewritten to describe a different change:

    python3 tools/capture_guide_release.py --record <record-id> --manifest <path> --note "..."
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import re
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
DEFAULT_RECORD = "cityscroll-engineering/public-guide-release"
OUTPUT_DIR = ROOT / ".artifacts" / "guide-release"

GUIDE_HOME = "/guide/"
TUTORIAL = "/guide/start/explore-housing-across-city-records/"
SEARCH = "/search/?q=housing"
GLOSSARY = "/guide/reference/glossary/"

VIEWPORTS = (("mobile", 390, 844), ("desktop", 1440, 900))
MIN_TARGET_PX = 24  # WCAG 2.2 AA, 2.5.8 Target Size (Minimum)

# The section-and-type line a reader sees above an article title. It mirrors the
# kicker `site/guide_view.mjs` renders, which says "Reference" once rather than
# twice when the section and the type are the same word.
SECTION_AND_TYPE = {
    "tutorial": "Start here \u00b7 Tutorial",
    "how-to": "How to\u2026 \u00b7 How-to guide",
    "explanation": "Understand \u00b7 Explanation",
    "reference": "Reference",
}

# A guide article may send a reader to one civic record — a notice, an
# organization, an exam. Those documents are materialized at deploy time from
# rolling publisher data, so a local build serves the application shell for them
# rather than the record. A local run can prove the route serves and no more; the
# record itself is proved by loading it against the public deploy, and those
# loads are recorded in docs/evidence/public-user-guide/.
RECORD_ROUTE_PATTERNS = (
    re.compile(r"^/(?:notices|agencies|vendors|officials|committees)/[^/]+/?$"),
    re.compile(r"^/mandates/[^/]+/?$"),
    re.compile(r"^/exams/[^/]+/?$"),
    re.compile(r"^/parcels/[^/]+/?$"),
    re.compile(r"^/meetings/.+$"),
)


def is_record_document(path: str) -> bool:
    return any(pattern.match(path) for pattern in RECORD_ROUTE_PATTERNS)


def load_guide_articles() -> list[dict]:
    """Ask the builder which articles exist, rather than keeping a second list."""
    script = (
        "import {loadGuide} from './tools/build_guide_documents.mjs';"
        "const {articles} = loadGuide();"
        "process.stdout.write(JSON.stringify(articles.map((a) => ({"
        "id: a.id, type: a.type, title: a.title, url: a.url,"
        "group: a.group.label, last_reviewed: a.last_reviewed,"
        "return_to_task: a.return_to_task}))));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


def derived_route_spec(article: dict) -> dict:
    """The floor every published article is held to, written from its own metadata.

    An article that someone wrote an assertion for below is checked against that
    assertion instead; this exists so an article nobody has written one for yet is
    still checked for the things every article owes a reader, rather than being
    silently uncovered until somebody notices.
    """
    expect_text = [
        article["title"],
        SECTION_AND_TYPE[article["type"]],
        f"Last reviewed {article['last_reviewed']}",
        article["return_to_task"]["label"],
    ]
    # A lesson carries checkpoints; an explanation or a reference page has no task
    # to check off, so requiring one of those to say "Checkpoint" would be wrong.
    if article["type"] in ("tutorial", "how-to"):
        expect_text.insert(3, "Checkpoint")
    return {
        "id": f"guide-article-{article['id'].lower()}",
        "route": article["url"],
        "assertion": (
            f"{article['title']} loads directly with its section and type, its review date, "
            "its own content, a link back to the guide home, and the link that returns the "
            "reader to the product."
        ),
        "expect_text": expect_text,
        "expect_links": [GUIDE_HOME, article["return_to_task"]["href"]],
        "axe": True,
    }


def build_routes(articles: list[dict]) -> tuple[dict, ...]:
    """The authored route table, with every uncovered article given a derived spec.

    Hand-written assertions say what a particular page must contain and are worth
    more than anything derivable, so they win. The derivation only fills gaps, and
    the guide home is widened to every published article so that check cannot go
    stale as the guide grows.
    """
    covered = {spec["route"] for spec in AUTHORED_ROUTES}
    derived = [derived_route_spec(a) for a in articles if a["url"] not in covered]

    routes: list[dict] = []
    for spec in AUTHORED_ROUTES:
        if spec["id"] == "guide-home":
            spec = {
                **spec,
                "assertion": "The guide home orients a signed-out reader with the four "
                "reader-facing sections and links every article that is published.",
                "expect_text": sorted(
                    {*spec["expect_text"], *(a["title"] for a in articles)},
                    key=lambda text: (text not in spec["expect_text"], text),
                ),
                "expect_links": [a["url"] for a in articles],
            }
        if spec["id"] == "product-search":
            routes.extend(derived)
        routes.append(spec)
    return tuple(routes)


AUTHORED_ROUTES = (
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
        "id": "guide-tutorial-notice-mandate",
        "route": "/guide/start/trace-a-notice-to-the-duty-behind-it/",
        "assertion": "The tutorial follows one notice to the duty behind it and its source law, and "
        "keeps a publication, a connection and a compliance finding apart.",
        "expect_text": [
            "Connected mandate",
            "Rules filing for this duty",
            "Source law",
            "Publication evidence",
            "compliance finding",
        ],
        "expect_links": [GUIDE_HOME, "/notices/20260605008"],
        "axe": True,
    },
    {
        "id": "guide-tutorial-award-trail",
        "route": "/guide/start/trace-an-award-and-keep-the-trail/",
        "assertion": "The tutorial builds a two-step trail, shows that it travels in the address, "
        "and says an awardee is not an opportunity.",
        "expect_text": [
            "awarded to",
            "received award",
            "Vendor profile",
            "not an announcement that subcontracts are available",
        ],
        "expect_links": [GUIDE_HOME, "/agencies/homeless-services/"],
        "axe": True,
    },
    {
        "id": "guide-how-to-connection-evidence",
        "route": "/guide/how-to/check-the-evidence-behind-a-connection/",
        "assertion": "The how-to opens one connection receipt, says what it supports, and covers a "
        "connection that carries no source document of its own.",
        "expect_text": [
            "Connection evidence",
            "How this connection was made",
            "Matched by a published record",
            "Copy link to this connection",
            "precomputed PASSPort contract graph",
        ],
        "expect_links": [GUIDE_HOME],
        "axe": True,
    },
    {
        "id": "guide-how-to-as-of-day",
        "route": "/guide/how-to/look-at-records-as-of-a-day/",
        "assertion": "The how-to filters an agency to a day and is explicit that an undated record "
        "is not kept and that this is not a reconstruction of what the site knew.",
        "expect_text": [
            "As of day",
            "Later records",
            "cannot be placed on a timeline",
            "not a reconstruction",
        ],
        "expect_links": [GUIDE_HOME, "/agencies/parks-and-recreation/?as_of=2024-06-01"],
        "axe": True,
    },
    {
        "id": "guide-how-to-collect-records",
        "route": "/guide/how-to/collect-records-and-export-them/",
        "assertion": "The how-to keeps device storage, a recognized session, a downloaded file and "
        "a shared snapshot apart, and says what a share exposes and for how long.",
        "expect_text": [
            "stored only in this browser",
            "Share read-only link",
            "Freeze research package",
            "90 days",
            "Clear all",
        ],
        "expect_links": [GUIDE_HOME, "/notices/20231222103"],
        "axe": True,
    },
    {
        "id": "guide-understand-public-record",
        "route": "/guide/understand/what-a-public-record-tells-you/",
        "assertion": "The explanation loads on its own, keeps the stages of a contract, a rule and "
        "a land-use review apart, and distinguishes the four ways to take part.",
        "expect_text": [
            "Understand · Explanation",
            "A record is a publication, not the action",
            "A rule comment period",
            "Community Board",
            "A blank is not a zero",
        ],
        "expect_links": [GUIDE_HOME],
        "axe": True,
    },
    {
        "id": "guide-understand-connections",
        "route": "/guide/understand/how-records-are-connected/",
        "assertion": "The explanation names the three bases a connection can rest on and says why "
        "a real relationship can still be missing.",
        "expect_text": [
            "Matched by a published record",
            "Record-linkage match",
            "Person-accepted",
            "A connection is not a finding",
        ],
        "expect_links": [GUIDE_HOME],
        "axe": True,
    },
    {
        "id": "guide-understand-dates",
        "route": "/guide/understand/dates-and-missing-information/",
        "assertion": "The explanation separates the kinds of date and the kinds of blank, and says "
        "an unknown is not a zero and a closed window is not an invitation.",
        "expect_text": [
            "Four kinds of date",
            "Four kinds of blank",
            "None of these is a zero",
            "What it is not is a current invitation",
        ],
        "expect_links": [GUIDE_HOME],
        "axe": True,
    },
    {
        "id": "guide-understand-flags",
        "route": "/guide/understand/flags-and-historical-patterns/",
        "assertion": "The explanation gives each computed note a plain meaning and links the page "
        "that owns its exact rule instead of restating a threshold.",
        "expect_text": [
            "statistical context, not a finding",
            "Short ad window",
            "Rules adoption lag",
            "An estimate never becomes a deadline",
        ],
        "expect_links": [GUIDE_HOME, "/about.html#context"],
        "axe": True,
    },
    {
        "id": "guide-reference-glossary",
        "route": GLOSSARY,
        "assertion": "The glossary loads on its own and lays its terms out in tables, including "
        "the identifiers a reader meets on a record.",
        "expect_text": ["Reference", "Identifiers", "PIN", "BBL", "Eligible list"],
        "expect_links": [GUIDE_HOME],
        "axe": True,
    },
    {
        "id": "guide-reference-controls",
        "route": "/guide/reference/controls-and-outputs/",
        "assertion": "The controls reference says what each control leaves the reader with, keeps "
        "a preview apart from a subscription, and sends machine parameters to the API page.",
        "expect_text": [
            "Preview matches",
            "A preview is not a subscription",
            "Subscribe to calendar",
            "Freeze research package",
        ],
        "expect_links": [GUIDE_HOME, "/api.html"],
        "axe": True,
    },
    {
        "id": "guide-reference-sources",
        "route": "/guide/reference/sources-and-coverage/",
        "assertion": "The sources reference shows the inventory generated from the source registry "
        "and links the pages that own coverage and endpoints.",
        "expect_text": [
            "public sources behind these records",
            "How it refreshes",
            "What is not covered",
        ],
        "expect_links": [GUIDE_HOME, "/stats.html", "/api.html"],
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
    deferred_records = []
    if spec["axe"]:
        for href in internal_links(page):
            target = urljoin(base, href.lstrip("/"))
            response = page.request.get(target)
            path = href.split("?", 1)[0].split("#", 1)[0]
            link_statuses.append({"href": href, "status": response.status})
            # The route serves, which is what a status can prove. Whether one
            # particular record is still published is a different question, and a
            # local build cannot answer it: those documents are materialized at
            # deploy time, so what is served here is the application shell.
            if is_record_document(path):
                deferred_records.append(path)

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
        "record_content_deferred_to_live_check": sorted(set(deferred_records)),
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


def reference_reached_without_script(page: Page, base: str) -> dict:
    """A reader meets an unfamiliar term in the tutorial and follows it, with no script.

    This is the property the reference section exists for: the first consequential
    term in a lesson has somewhere to go, the page it goes to stands on its own, and
    Back returns the reader to the step they left.
    """
    page.goto(urljoin(base, TUTORIAL.lstrip("/")), wait_until="domcontentloaded")
    page.click(f'main a[href="{GLOSSARY}"]')
    page.wait_for_load_state("domcontentloaded")
    reached = urlsplit(page.url).path
    glossary = page.evaluate(
        """() => ({
            tables: document.querySelectorAll('main table').length,
            headerCells: document.querySelectorAll('main th[scope="col"]').length,
            namedRegions: [...document.querySelectorAll('main .guide-table')]
                .every((node) => !!node.getAttribute('aria-label')),
            reviewed: /Last reviewed \\d{4}-\\d{2}-\\d{2}/.test(document.querySelector('main').innerText),
            backToGuide: !!document.querySelector('main a[href="/guide/"]'),
        })"""
    )
    page.go_back()
    page.wait_for_load_state("domcontentloaded")
    back_path = urlsplit(page.url).path
    holds = (
        reached == GLOSSARY
        and glossary["tables"] >= 2
        and glossary["headerCells"] >= 4
        and glossary["namedRegions"]
        and glossary["reviewed"]
        and glossary["backToGuide"]
        and back_path == TUTORIAL
    )
    return {
        "assertion_holds": holds,
        "reached_path": reached,
        "glossary": glossary,
        "back_path": back_path,
    }


def articles_without_script(page: Page, base: str, articles: list[dict]) -> dict:
    """Read every published article with JavaScript switched off.

    A guide article is prose. If any of it depends on script, the article has
    stopped being the thing the guide promised, so this reads all of them rather
    than trusting that the pattern held for the newest one.
    """
    observed = []
    for article in articles:
        page.goto(urljoin(base, article["url"].lstrip("/")), wait_until="domcontentloaded")
        state = page.evaluate(
            """(returnHref) => ({
                headings: [...document.querySelectorAll('main h1, main h2, main h3')].length,
                paragraphs: document.querySelectorAll('main p').length,
                backToGuide: !!document.querySelector('main a[href="/guide/"]'),
                returnToTask: !!document.querySelector(
                    `main .guide-return a[href="${returnHref.replace(/"/g, '\\"')}"]`),
                reviewed: (document.querySelector('.guide-reviewed') || {}).textContent || '',
            })""",
            article["return_to_task"]["href"],
        )
        state["id"] = article["id"]
        state["url"] = article["url"]
        state["holds"] = (
            state["headings"] >= 4
            and state["paragraphs"] >= 5
            and state["backToGuide"]
            and state["returnToTask"]
            and article["last_reviewed"] in state["reviewed"]
        )
        observed.append(state)
    return {
        "assertion_holds": all(item["holds"] for item in observed),
        "articles": observed,
    }


def capture(base: str, output_dir: Path, routes: tuple, articles: list[dict]) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    captures: list[dict] = []
    journeys: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for name, width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                for spec in routes:
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
                journeys.append(
                    {
                        "id": "reference-reached-without-javascript",
                        "viewport": name,
                        "assertion": "With JavaScript switched off, an unfamiliar term in the "
                        "tutorial leads to a reference page that stands on its own, with named "
                        "tables and its own review date, and Back returns to the step.",
                        **reference_reached_without_script(no_script.new_page(), base),
                    }
                )
                journeys.append(
                    {
                        "id": "every-article-without-javascript",
                        "viewport": name,
                        "assertion": "With JavaScript switched off, every published article keeps "
                        "its headings, prose, the link back to the guide home, the link that "
                        "returns the reader to the product, and its recorded review date.",
                        **articles_without_script(no_script.new_page(), base, articles),
                    }
                )
                no_script.close()
        finally:
            browser.close()
    return {"captures": captures, "journeys": journeys}


def relative_label(path: Path) -> str:
    """Name the manifest relative to the repository when it lives inside it."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path, default=ROOT / "site")
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_DIR)
    parser.add_argument(
        "--record",
        default=DEFAULT_RECORD,
        help="the public engineering-record identity this capture is evidence for",
    )
    parser.add_argument(
        "--note",
        default=None,
        help="replace the manifest note when a later change re-runs this capture for its own record",
    )
    parser.add_argument(
        "--keep-going",
        action="store_true",
        help="write the manifest and report failures without a non-zero exit",
    )
    args = parser.parse_args()
    # Both paths are reported and stored relative to the repository root, so a
    # relative argument has to be resolved against it before anything is written.
    args.manifest = Path(args.manifest) if Path(args.manifest).is_absolute() else ROOT / args.manifest
    args.output_dir = Path(args.output_dir) if Path(args.output_dir).is_absolute() else ROOT / args.output_dir

    articles = load_guide_articles()
    routes = build_routes(articles)

    server, thread, base = serve(args.site_dir)
    try:
        observed = capture(base, args.output_dir, routes, articles)
    finally:
        server.shutdown()
        thread.join()
        server.server_close()

    manifest = {
        "schema_version": 1,
        "record": args.record,
        "capture_mode": "local_static_site_playwright_no_committed_image",
        "base": "local static site build (site/)",
        "repository_revision": repository_revision(),
        "repository_state": working_tree_state(),
        "note": args.note or (
            "Usability evidence for the published guide. Every check runs against the tracked "
            "static documents served locally, so it reproduces from a checkout with no network and "
            "no deploy. Accessibility, keyboard, reflow and link checks cover the guide documents; "
            "the front page and the search document keep their existing owners and are exercised "
            "here only as the journey's endpoints. A guide link to one civic record is followed "
            "only far enough to prove the route serves: those documents are materialized at "
            "deploy time, so a local build answers with the application shell rather than the "
            "record. Each such route is named per capture under record content deferred to live "
            "check, and the records themselves are proved by the live loads recorded in "
            "docs/evidence/public-user-guide/. Screenshots stay under the ignored .artifacts/ "
            "path and only their sha256 is recorded, per docs/capture-manifest-guard.md."
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
            "an unfamiliar term in the tutorial reaching a reference page without script",
            "every published article read with JavaScript switched off",
        ],
        "articles": [
            {
                "id": article["id"],
                "type": article["type"],
                "url": article["url"],
                "last_reviewed": article["last_reviewed"],
                "returns_to": article["return_to_task"]["href"],
                "assertion_source": (
                    "authored"
                    if any(spec["route"] == article["url"] for spec in AUTHORED_ROUTES)
                    else "derived"
                ),
            }
            for article in articles
        ],
        **capture_sections(observed),
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n")

    failed = [item for item in observed["captures"] + observed["journeys"] if not item["assertion_holds"]]
    print(
        f"guide release: {len(observed['captures'])} captures and {len(observed['journeys'])} journeys "
        f"written to {relative_label(args.manifest)}"
    )
    for item in failed:
        print(f"  assertion did not hold: {item['id']} @ {item.get('viewport')}")
        print(f"    {json.dumps({k: v for k, v in item.items() if k not in ('assertion',)})[:600]}")
    return 0 if not failed or args.keep_going else 1


def capture_sections(observed: dict) -> dict:
    return {"captures": observed["captures"], "journeys": observed["journeys"]}


if __name__ == "__main__":
    raise SystemExit(main())
