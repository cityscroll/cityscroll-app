#!/usr/bin/env python3
"""Before/after evidence that Browse is the filter-first record-family entrance.

The claim is about hierarchy — which choice a resident meets first — so the capture
measures document order rather than describing it:

- before/: a worktree at origin/main, where the root Browse landing opens with the
  graph-walk module ("Graph entry") and the record families sit underneath it.
- after/:  this working tree, where the six canonical families and their collection
  entrances come first and graph traversal follows as "Explore connections".

The same specimen addresses are shot in both trees at both viewports, and each shot
carries the observed order, family routes, coverage states, and control contract, so
a screenshot cannot claim a state the document does not hold.

    python3 tools/capture_browse_filter_first_landing.py

Writes docs/screenshots/browse-filter-first-landing/ and the receipt at
docs/evidence/browse-filter-first-landing.json.
"""

from __future__ import annotations

import functools
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "browse-filter-first-landing"
RECEIPT = ROOT / "docs" / "evidence" / "browse-filter-first-landing.json"
BASE_REV = "origin/main"
VIEWPORTS = ((390, 844), (1440, 900))
TOPIC = "rats"

# The root landing under test, the two addresses US-25 canonicalized, the explicit
# traversal that must keep its own context, and the three queryless family journeys
# this card promises.
SPECIMEN = (
    ("browse-landing", "/browse/"),
    ("legacy-browse-search", "/browse/?walk_query=rats&walk_source=browse"),
    ("canonical-search", "/search/?q=rats"),
    ("explicit-walk", "/browse/?walk_query=rats&walk_source=search"),
    ("contracts-collection", "/browse/contracts/"),
    ("land-collection", "/browse/zoning/"),
    ("meetings-collection", "/browse/meetings/"),
)

# The filter controls each family advertises on the root page, read back out of the
# destination document so the capture proves the copy names real controls.
DESTINATION_CONTROLS = {
    "/browse/contracts/": ["kw", "agency", "minamt"],
    "/browse/zoning/": ["lkw", "lfamily", "lprocedure", "lstage"],
    "/browse/meetings/": ["meetingskw", "meetingswhen", "meetingsboro", "meetingsagency"],
}


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The established browser-evidence search fixture builders, reused rather than restated.
search_fixtures = load_module(ROOT / "test" / "functional" / "29_search_results.py", "search_results_fixtures")

CONTRACT_SOURCE = "site/data/procurement_browse_rows.json"
MEETING_SOURCE = "test/fixtures/calendar-contract/cases.json"


def specimen_records() -> tuple[list[dict], dict]:
    contract_row = next(
        row for row in json.loads((ROOT / CONTRACT_SOURCE).read_text("utf-8"))["rows"]
        if row["short_title"] == "Mayoral Rat Reduction Initiative"
    )
    meeting_row = json.loads((ROOT / MEETING_SOURCE).read_text("utf-8"))["keyword_agency_feed"]["rows"][0]
    results = [
        search_fixtures.typed_result(
            "Rat",
            title=contract_row["short_title"],
            object_type="procurement",
            domain="contracts",
            lens="notices",
            href=contract_row["canonical_href"],
        ),
        search_fixtures.typed_result(
            "Rat",
            title=meeting_row["short_title"],
            object_type="meeting",
            domain="meetings",
            lens="notices",
            href=f"/meetings/meeting%3Acity_record%3A{meeting_row['request_id']}",
        ),
    ]
    provenance = {
        "declared_as": "capture fixture served to the browser; not a live index read",
        "records": [
            {"title": contract_row["short_title"], "source": f"{CONTRACT_SOURCE}#rows"},
            {"title": meeting_row["short_title"], "source": f"{MEETING_SOURCE}#keyword_agency_feed.rows[0]"},
        ],
        "unchanged_by_this_change": [
            "worker search index", "ranking policy", "SearchDocument producer",
            "semantic-expansion rule", "universal-filter vocabulary",
            "typed collection filters", "Browse route inventory",
        ],
    }
    return results, provenance


SPECIMEN_RESULTS, FIXTURE_PROVENANCE = specimen_records()


def route_decisions(tree: Path) -> dict:
    """Ask this tree's own edge module what each specimen address does."""
    script = f"""
      import worker from {json.dumps(str(tree / "site" / "pages_edge.mjs"))};
      const env = {{ ASSETS: {{ async fetch() {{ return new Response("", {{ status: 200 }}); }} }} }};
      const out = {{}};
      for (const href of {json.dumps([href for _name, href in SPECIMEN])}) {{
        const response = await worker.fetch(new Request(`https://cityscroll.org${{href}}`), env);
        out[href] = {{ status: response.status, location: response.headers.get("location") }};
      }}
      process.stdout.write(JSON.stringify(out));
    """
    completed = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        cwd=tree, check=True, capture_output=True, text=True,
    )
    return json.loads(completed.stdout)


class EdgeHandler(SimpleHTTPRequestHandler):
    """Serve the static document tree, replaying the edge's decision for the specimen."""

    decisions: dict = {}

    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        decision = self.decisions.get(self.path)
        if decision and decision["status"] in (301, 302, 307, 308) and decision["location"]:
            target = urlparse(decision["location"])
            self.send_response(decision["status"])
            self.send_header("Location", f"{target.path}?{target.query}" if target.query else target.path)
            self.end_headers()
            return
        super().do_GET()


class EdgeServer:
    def __init__(self, directory: Path, decisions: dict) -> None:
        handler = functools.partial(EdgeHandler, directory=str(directory))
        handler.decisions = decisions
        EdgeHandler.decisions = decisions
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def json_response(route: Route, body: dict) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_routes(page: Page, base_url: str) -> None:
    """Keep the capture offline: the search API answers from the declared specimen fixture."""
    def capability_module(route: Route) -> None:
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    def keyword_api(route: Route) -> None:
        query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
        results = SPECIMEN_RESULTS if TOPIC in query else []
        json_response(route, search_fixtures.fallback_payload(results, query))

    def candidate_api(route: Route) -> None:
        query = parse_qs(urlparse(route.request.url).query).get("q", [""])[0].lower()
        json_response(route, search_fixtures.candidate_response(query))

    page.route("https://**", lambda route: route.abort())
    page.route("https://data.cityofnewyork.us/**", lambda route: route.fulfill(
        status=200, content_type="application/json", body="[]"))
    for origin in ("https://api.cityscroll.org", "https://cityscroll-worker.crol-worker.workers.dev"):
        page.route(f"{origin}/**", lambda route: route.fulfill(
            status=200, content_type="application/json", body="{}"))
        page.route(f"{origin}/search/candidates?*", candidate_api)
        page.route(f"{origin}/search?*", keyword_api)
    page.route(f"{base_url}/capabilities/*", capability_module)


def observe(page: Page, controls: list[str]) -> dict:
    """Read the order and state the document actually holds, not the one we expect."""
    return page.evaluate(
        """(controls) => {
          const params = new URLSearchParams(location.search);
          const body = document.body.innerHTML;
          const at = (needle) => body.indexOf(needle);
          const form = document.querySelector('[data-walk-search-form], [data-search-form]');
          const field = form ? form.querySelector('input:not([type=hidden])') : null;
          const disclosure = document.querySelector('[data-browse-explore-disclosure]');
          const grid = at('browse-source-grid');
          const traversalMarks = ['data-browse-explore-connections', 'Explore connections',
            'Start a walk', 'Graph entry', 'data-walk-entry'];
          return {
            url: `${location.pathname}${location.search}`,
            canonical_query: params.get('q'),
            walk_source: params.get('walk_source'),
            walk_query: params.get('walk_query'),
            document: document.querySelector('[data-search-document]') ? 'search'
              : document.querySelector('[data-build-rendered="browse-landing"]') ? 'browse-landing'
              : document.querySelector('[data-build-rendered="browse"]') ? 'browse-collection' : 'other',
            heading: (document.querySelector('.browse-landing-head h2') || {}).textContent || '',
            intro: (document.querySelector('.browse-landing-head h2 + p') || {}).textContent || '',
            order: {
              family_grid: grid,
              traversal: Object.fromEntries(traversalMarks.map((mark) => [mark, at(mark)])),
              families_first: grid >= 0 && traversalMarks.every((mark) => at(mark) === -1 || at(mark) > grid),
            },
            family_cards: [...document.querySelectorAll('.browse-source-card')].map((card) => ({
              id: card.id,
              label: (card.querySelector('h3') || {}).textContent || '',
              count: (card.querySelector('.browse-source-count') || {}).textContent || '',
              filters: (card.querySelector('.browse-source-filters') || {}).textContent || '',
              updated: (card.querySelector('.browse-source-asof') || {}).textContent || '',
              sources: (card.querySelector('.browse-source-disclosure p') || {}).textContent || '',
              routes: [...card.querySelectorAll('.browse-source-actions a')]
                .map((link) => link.getAttribute('href')),
            })),
            explore_connections: {
              present: !!document.querySelector('[data-browse-explore-connections]'),
              heading: (document.querySelector('#browse-explore-connections-heading') || {}).textContent || '',
              summary: (document.querySelector('[data-browse-explore-disclosure] > summary') || {}).textContent || '',
              open: disclosure ? disclosure.open : null,
              graph_mark: !!document.querySelector('.walk-entry-mark'),
            },
            walk_families: [...document.querySelectorAll('[data-walk-family]')].map((link) => ({
              id: link.dataset.walkFamily,
              href: link.getAttribute('href'),
              state: (link.closest('[data-walk-family-state]') || { dataset: {} }).dataset.walkFamilyState || null,
              coverage: (link.closest('[data-walk-family-state]')?.querySelector('[data-walk-coverage]') || {}).textContent || '',
            })),
            control: form ? {
              action: new URL(form.getAttribute('action'), location.origin).pathname,
              field: field ? field.getAttribute('name') : null,
              submit: (form.querySelector('button') || {}).textContent || '',
              posts_walk_fields: !!form.querySelector('[name^="walk_"]'),
            } : null,
            destination_controls: Object.fromEntries(
              controls.map((id) => [id, !!document.getElementById(id)])),
            records: [...document.querySelectorAll('[data-search-lane] a, [data-semantic-family] a')]
              .map((link) => link.textContent.trim()).filter(Boolean).slice(0, 12),
          };
        }""",
        controls,
    )


def settle(page: Page) -> None:
    page.wait_for_load_state("domcontentloaded")
    try:
        page.wait_for_function(
            """() => {
              if (!document.querySelector('[data-search-document]')) return true;
              const coverage = document.querySelector('[data-search-coverage]');
              return !!coverage && coverage.dataset.coverageState !== 'loading';
            }""",
            timeout=20000,
        )
    except Exception:
        pass
    page.wait_for_timeout(600)


def shoot(page: Page, path: Path, viewport: tuple[int, int], state: dict, anchor: str | None = None) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Two framings, because they answer different questions. Unanchored is the
    # address as loaded. Anchored scrolls the surface under test to the top of the
    # viewport, because the shared masthead, home search, and section nav occupy the
    # first screen on every route — a pre-existing shell condition this card does not
    # change — and would otherwise hide the ordering the evidence is about.
    if anchor:
        page.evaluate(
            """(selector) => {
              const node = document.querySelector(selector);
              if (node) node.scrollIntoView({ block: 'start' });
            }""",
            anchor,
        )
    else:
        page.evaluate("() => window.scrollTo(0, 0)")
    page.wait_for_timeout(200)
    page.screenshot(path=str(path), animations="disabled", full_page=False)
    data = path.read_bytes()
    print("wrote", path)
    return {
        "name": str(path.relative_to(OUT)),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "viewport": list(viewport),
        "observed": state,
    }


def capture_tree(state: str, site: Path, decisions: dict) -> list[dict]:
    files: list[dict] = []  # accumulator (not a measured table)
    with EdgeServer(site, decisions) as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page, base_url)
            for name, href in SPECIMEN:
                page.goto(f"{base_url}{href}", wait_until="domcontentloaded")
                settle(page)
                observed = observe(page, DESTINATION_CONTROLS.get(href, []))
                print(f"{state} {name} {width}px:", json.dumps(observed, ensure_ascii=False)[:300])
                files.append(shoot(page, OUT / state / f"{name}-{width}.png", (width, height), observed))
                if observed["document"] == "browse-landing":
                    files.append(shoot(
                        page, OUT / state / f"{name}-landing-{width}.png", (width, height), observed,
                        anchor='[data-build-rendered="browse-landing"]',
                    ))
            page.close()
        browser.close()
    return files


def base_tree(destination: Path) -> Path:
    tree = destination / "base"
    subprocess.run(["git", "worktree", "add", "--detach", str(tree), BASE_REV], cwd=ROOT, check=True)
    # A card worktree may be provisioned sparsely; the build reads the whole data tree.
    subprocess.run(["git", "sparse-checkout", "disable"], cwd=tree, check=False)
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=tree, check=True)
    return tree


def release_base_tree(destination: Path) -> None:
    subprocess.run(["git", "worktree", "remove", "--force", str(destination / "base")], cwd=ROOT, check=False)
    subprocess.run(["git", "worktree", "prune"], cwd=ROOT, check=False)


def route_table(before: dict, after: dict) -> list[dict]:
    return [
        {"specimen": name, "requested": href, "before": before[href], "after": after[href]}
        for name, href in SPECIMEN
    ]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=ROOT, check=True)
    after_decisions = route_decisions(ROOT)

    with tempfile.TemporaryDirectory(prefix="browse-filter-first-") as staging:
        staging_path = Path(staging)
        try:
            tree = base_tree(staging_path)
            before_decisions = route_decisions(tree)
            files = capture_tree("before", tree / "site", before_decisions)
        finally:
            release_base_tree(staging_path)

    files += capture_tree("after", ROOT / "site", after_decisions)

    receipt = {
        "schema": "cityscroll.browse-filter-first-landing-receipt.v1",
        "topic": TOPIC,
        "browser_mode": "headless chromium (playwright), offline: every remote host aborted or fulfilled locally",
        "before_source": f"git worktree at {BASE_REV} + node tools/build_primary_documents.mjs",
        "after_source": "working tree site/ + node tools/build_primary_documents.mjs",
        "routing_source": "each tree's own site/pages_edge.mjs, replayed by the capture server",
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "routes": route_table(before_decisions, after_decisions),
        "advertised_destination_controls": DESTINATION_CONTROLS,
        "search_response_fixture": FIXTURE_PROVENANCE,
        "files": files,
    }
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print("wrote", RECEIPT)
    (OUT / "manifest.json").write_text(
        json.dumps(
            {
                "schema": "cityscroll.capture_receipt.v1",
                "capture": "browse-filter-first-landing",
                "topic": TOPIC,
                "routes": {name: href for name, href in SPECIMEN},
                "viewports": [list(viewport) for viewport in VIEWPORTS],
                "before_source": f"git worktree at {BASE_REV} + node tools/build_primary_documents.mjs",
                "after_source": "working tree site/ + node tools/build_primary_documents.mjs",
                "files": files,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print("wrote", OUT / "manifest.json")


if __name__ == "__main__":
    main()
