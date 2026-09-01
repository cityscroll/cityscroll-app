#!/usr/bin/env python3
"""Before/after evidence for the Browse record-search handoff, on the `rats` specimen.

The claim is about which state a topic becomes, so the capture follows one word through
the routes a resident actually reaches:

- before/: a worktree at origin/main, where the root Browse "Search records" control posts
  the topic back to /browse/ as walk_query and the resident lands on the Browse landing again.
- after/:  this working tree, where the same control submits canonical `q` to /search/ and the
  legacy browse-origin address canonicalizes onto the same Search route.

Routing is the product's own: each tree's site/pages_edge.mjs decides the specimen addresses,
and the capture server replays that decision, so the browser really follows the redirect the
edge issues rather than one this script invented.

    python3 tools/capture_search_to_browse_query_handoff.py

Writes docs/screenshots/search-to-browse-query-handoff/ and the receipt at
docs/evidence/search-to-browse-query-handoff.json.
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
OUT = ROOT / "docs" / "screenshots" / "search-to-browse-query-handoff"
RECEIPT = ROOT / "docs" / "evidence" / "search-to-browse-query-handoff.json"
BASE_REV = "origin/main"
VIEWPORTS = ((390, 844), (1440, 900))
TOPIC = "rats"

# The specimen addresses. The first is the address the old Browse control produced, the
# second is canonical Search, and the third is an explicitly chosen traversal that must keep
# its own address in both trees.
LEGACY_BROWSE = "/browse/?walk_query=rats&walk_source=browse"
CANONICAL_SEARCH = "/search/?q=rats"
EXPLICIT_WALK = "/browse/?walk_query=rats&walk_source=search"
SPECIMEN = (
    ("legacy-browse-search", LEGACY_BROWSE),
    ("canonical-search", CANONICAL_SEARCH),
    ("explicit-walk", EXPLICIT_WALK),
)

# The two public records a resident searching `rats` is looking for. Both titles and routes
# come from committed repository data, named in the receipt. The capture serves them through
# the search API as a declared capture fixture: the production federated response is the
# Worker's, and this card changes no index, ranking, or producer.
CONTRACT_SOURCE = "site/data/procurement_browse_rows.json"
MEETING_SOURCE = "test/fixtures/calendar-contract/cases.json"


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The established browser-evidence search fixture builders, reused rather than restated.
search_fixtures = load_module(ROOT / "test" / "functional" / "29_search_results.py", "search_results_fixtures")


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

    # Playwright matches the most recently registered handler first, so the broad
    # offline guards are installed before the specimen endpoints they must not shadow.
    page.route("https://**", lambda route: route.abort())
    page.route("https://data.cityofnewyork.us/**", lambda route: route.fulfill(
        status=200, content_type="application/json", body="[]"))
    for origin in ("https://api.cityscroll.org", "https://cityscroll-worker.crol-worker.workers.dev"):
        page.route(f"{origin}/**", lambda route: route.fulfill(
            status=200, content_type="application/json", body="{}"))
        page.route(f"{origin}/search/candidates?*", candidate_api)
        page.route(f"{origin}/search?*", keyword_api)
    # Capability modules are served from the repository root, beside site/.
    page.route(f"{base_url}/capabilities/*", capability_module)


def observe(page: Page) -> dict:
    """Read what the page actually shows, so a capture cannot claim the wrong state."""
    return page.evaluate(
        """() => {
          const params = new URLSearchParams(location.search);
          const form = document.querySelector('[data-walk-search-form], [data-search-form]');
          const field = form ? form.querySelector('input:not([type=hidden])') : null;
          const coverage = document.querySelector('[data-search-coverage]');
          const lanes = [...document.querySelectorAll('[data-semantic-family]')]
            .filter((lane) => !lane.closest('[hidden]'))
            .map((lane) => ({
              family: lane.dataset.semanticFamily,
              status: (lane.querySelector('.topic-search-lane-status') || {}).textContent || '',
            }));
          return {
            url: `${location.pathname}${location.search}`,
            canonical_query: params.get('q'),
            walk_source: params.get('walk_source'),
            walk_query: params.get('walk_query'),
            document: document.querySelector('[data-search-document]') ? 'search'
              : document.querySelector('[data-walk-entry]') ? 'browse-landing' : 'other',
            control: form ? {
              action: new URL(form.getAttribute('action'), location.origin).pathname,
              field: field ? field.getAttribute('name') : null,
              value: field ? field.value : null,
              submit: (form.querySelector('button') || {}).textContent || '',
              posts_walk_fields: !!form.querySelector('[name^="walk_"]'),
            } : null,
            walk_kicker: (document.querySelector('.walk-entry-kicker') || {}).textContent || '',
            family_links: [...document.querySelectorAll('[data-walk-family]')]
              .map((link) => link.getAttribute('href')),
            coverage_state: coverage && !coverage.hidden ? coverage.dataset.coverageState : null,
            coverage_text: coverage && !coverage.hidden ? coverage.textContent.trim().slice(0, 200) : '',
            lanes,
            records: [...document.querySelectorAll('[data-search-lane] a, [data-semantic-family] a')]
              .map((link) => link.textContent.trim()).filter(Boolean).slice(0, 12),
            typed_handoffs: [...document.querySelectorAll('[data-search-handoff]')].map((link) => ({
              surface: link.dataset.searchHandoff,
              route: new URL(link.getAttribute('href'), location.origin).pathname,
              canonical_query: new URL(link.getAttribute('href'), location.origin).searchParams.get('q'),
            })),
          };
        }"""
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


def shoot(page: Page, path: Path, viewport: tuple[int, int], state: dict) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Frame the control under test: on a Browse landing that is the entry section itself.
    page.evaluate(
        """() => {
          const entry = document.querySelector('[data-walk-entry]');
          if (entry) entry.scrollIntoView({ block: 'start' });
        }"""
    )
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
                observed = observe(page)
                print(f"{state} {name} {width}px:", json.dumps(observed, ensure_ascii=False)[:400])
                files.append(shoot(page, OUT / state / f"{name}-{width}.png", (width, height), observed))
            page.close()
        browser.close()
    return files


def base_tree(destination: Path) -> Path:
    tree = destination / "base"
    subprocess.run(["git", "worktree", "add", "--detach", str(tree), BASE_REV], cwd=ROOT, check=True)
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=tree, check=True)
    return tree


def release_base_tree(destination: Path) -> None:
    subprocess.run(["git", "worktree", "remove", "--force", str(destination / "base")], cwd=ROOT, check=False)
    subprocess.run(["git", "worktree", "prune"], cwd=ROOT, check=False)


def route_table(before: dict, after: dict) -> list[dict]:
    return [
        {
            "specimen": name,
            "requested": href,
            "before": before[href],
            "after": after[href],
        }
        for name, href in SPECIMEN
    ]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=ROOT, check=True)
    after_decisions = route_decisions(ROOT)

    with tempfile.TemporaryDirectory(prefix="search-to-browse-handoff-") as staging:
        staging_path = Path(staging)
        try:
            tree = base_tree(staging_path)
            before_decisions = route_decisions(tree)
            files = capture_tree("before", tree / "site", before_decisions)
        finally:
            release_base_tree(staging_path)

    files += capture_tree("after", ROOT / "site", after_decisions)

    receipt = {
        "schema": "cityscroll.search-to-browse-query-handoff-receipt.v1",
        "topic": TOPIC,
        "browser_mode": "headless chromium (playwright), offline: every remote host aborted or fulfilled locally",
        "before_source": f"git worktree at {BASE_REV} + node tools/build_primary_documents.mjs",
        "after_source": "working tree site/ + node tools/build_primary_documents.mjs",
        "routing_source": "each tree's own site/pages_edge.mjs, replayed by the capture server",
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "routes": route_table(before_decisions, after_decisions),
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
                "capture": "search-to-browse-query-handoff",
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
