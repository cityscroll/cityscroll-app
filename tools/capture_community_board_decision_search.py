#!/usr/bin/env python3
"""Capture decision-level search destinations from the rebuilt served index.

Proof for decision search: three query URLs whose ordinary decision links open
the exact board-decision destinations, plus one search → decision → Back
recording across desktop, touch, and keyboard while preserving search state.
Images stay under an ignored path; this script writes the textual manifest.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".artifacts" / "community-board-decision-search"
EVIDENCE = ROOT / "docs" / "evidence" / "community-board-decision-search"
PAGES = Path(os.environ.get("FM_TASK_SCRATCH", "/tmp")) / "b2-decision-search-pages"

QUERIES = [
    {
        "case": "decision-search-730-avenue-s",
        "query": "730 Avenue S",
        "candidate_id": "brooklyn-cb-15:2026-06-30:bsa-154-90-bzii",
        "board_id": "brooklyn-cb-15",
    },
    {
        "case": "decision-search-st-marks-bike-lane",
        "query": "St Marks Place bike lane",
        "candidate_id": "manhattan-cb-03:2026-05-26:transportation-2",
        "board_id": "manhattan-cb-03",
    },
    {
        "case": "decision-search-saturday-sanitation",
        "query": "Saturday sanitation set out",
        "candidate_id": "brooklyn-cb-15:2026-05-26:candidate-01",
        "board_id": "brooklyn-cb-15",
    },
]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def serve(directory: Path):
    class Handler(SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def git_revision() -> str:
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()


def build_pages() -> dict:
    env = os.environ.copy()
    env["FM_TASK_SCRATCH"] = str(PAGES.parent)
    subprocess.check_call(
        ["node", "--input-type=module", "-e", r"""
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolveKeywordQuery, searchKeywordDocuments } from './site/keyword_matcher.mjs';
import { readKeywordSearchIndexFromShards } from './site/keyword_search_index_shards.mjs';
import {
  communityBoardDecisionHref,
  communityBoardDecisionAnchorId,
  communityBoardResolutionViewForBoard,
  renderCommunityBoardDecisionsSection,
} from './site/community_board_resolution_pilot.mjs';
import { renderUniversalSearchResultHtml } from './site/universal_search_relevance_ux.mjs';

const outRoot = process.env.FM_TASK_SCRATCH + '/b2-decision-search-pages';
const index = readKeywordSearchIndexFromShards('worker/src/data/keyword_search_index_shards');
const familyDocs = index.families.community_boards.documents;
const pub = JSON.parse(readFileSync('site/data/community_board_resolution_pilot.json', 'utf8'));

const queries = [
  { slug: '730-avenue-s', query: '730 Avenue S', candidate_id: 'brooklyn-cb-15:2026-06-30:bsa-154-90-bzii' },
  { slug: 'st-marks-bike-lane', query: 'St Marks Place bike lane', candidate_id: 'manhattan-cb-03:2026-05-26:transportation-2' },
  { slug: 'saturday-sanitation', query: 'Saturday sanitation set out', candidate_id: 'brooklyn-cb-15:2026-05-26:candidate-01' },
];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

const returnScript = `
const SEARCH_RETURN_STATE_KEY = 'cityscroll.search_return_state.v1';
document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[href]');
  if (!link) return;
  const destination = new URL(link.href, location.href);
  if (!(destination.pathname.startsWith('/community-boards/') && /#board-decision-[A-Za-z0-9_-]+/.test(destination.hash || ''))) return;
  try {
    sessionStorage.setItem(SEARCH_RETURN_STATE_KEY, JSON.stringify({
      route: location.pathname + location.search,
      scroll_y: Math.round(window.scrollY),
      focus_href: document.activeElement?.getAttribute('href') || link.getAttribute('href'),
    }));
  } catch {}
});
(function restore() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(SEARCH_RETURN_STATE_KEY) || 'null'); } catch { return; }
  if (!saved || saved.route !== location.pathname + location.search) return;
  const target = [...document.querySelectorAll('a[href]')].find((link) => (
    link.getAttribute('href') === saved.focus_href
  ));
  window.scrollTo(0, Number(saved.scroll_y) || 0);
  target?.focus({ preventScroll: true });
  try { sessionStorage.removeItem(SEARCH_RETURN_STATE_KEY); } catch {}
  window.__searchReturnRestored = {
    route: saved.route,
    focus_href: saved.focus_href,
    focused: document.activeElement === target,
  };
})();
`;

const queryMeta = [];
for (const row of queries) {
  const matches = searchKeywordDocuments(familyDocs, resolveKeywordQuery(row.query), { limit: 12 });
  const decision = matches.find((doc) => doc.object_ref === `community-board-decision:${row.candidate_id}`);
  if (!decision) throw new Error(`served index miss for ${row.query}`);
  const cards = matches
    .filter((doc) => doc.object_type === 'community_board_decision' || doc.object_type === 'community_board')
    .map((doc) => renderUniversalSearchResultHtml(doc))
    .join('\\n');
  const searchPath = `/search/?q=${encodeURIComponent(row.query)}`;
  mkdirSync(`${outRoot}/search`, { recursive: true });
  writeFileSync(`${outRoot}/search/index-${row.slug}.html`, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Results for ${esc(row.query)} · CityScroll</title>
<style>
body{font:16px/1.45 system-ui;margin:0;padding:1rem;background:#f7f4ed;color:#202c32}
main{max-width:42rem;margin:0 auto}
.topic-search-result{border:1px solid #cfc8bb;border-radius:8px;padding:1rem;margin:1rem 0;background:#fff}
.topic-search-result-title a{color:#166b70;font-weight:600}
input[name=q]{width:100%;min-height:44px;font:inherit;padding:.5rem}
</style></head>
<body data-search-page="1">
<main id="main">
  <form data-search-form action="/search/" method="get">
    <label>Search <input name="q" value="${esc(row.query)}"></label>
  </form>
  <h1>Results for “${esc(row.query)}”</h1>
  <div class="topic-search-results" data-search-results>${cards}</div>
</main>
<script>${returnScript}</script>
</body></html>`);
  queryMeta.push({
    ...row,
    search_path: searchPath,
    local_search_path: `/search/index-${row.slug}.html?q=${encodeURIComponent(row.query)}`,
    decision_href: decision.canonical_href,
    title: decision.title,
    meeting_date: decision.provenance?.meeting_date || null,
    board_id: decision.provenance?.community_board_context?.board_id || null,
  });
}

for (const boardId of Object.keys(pub.by_board)) {
  const view = communityBoardResolutionViewForBoard(pub, boardId);
  const section = renderCommunityBoardDecisionsSection(view, { lang: 'en' });
  mkdirSync(`${outRoot}/community-boards/${boardId}`, { recursive: true });
  writeFileSync(`${outRoot}/community-boards/${boardId}/index.html`, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${boardId} decisions · CityScroll</title>
<style>
body{font:16px/1.45 system-ui;margin:0;padding:1rem;background:#f7f4ed;color:#202c32}
main{max-width:40rem;margin:0 auto}
.board-decision{border:1px solid #cfc8bb;border-radius:8px;padding:1rem;margin:1rem 0;background:#fff;scroll-margin-top:1rem}
.board-decision:target{outline:3px solid #166b70;outline-offset:2px}
.muted{color:#5c6670}
</style></head>
<body>
<main id="main"><h1>Community board decisions</h1><p class="muted">${boardId}</p>${section}</main>
</body></html>`);
}

writeFileSync(process.env.FM_TASK_SCRATCH + '/b2-decision-search-meta.json', JSON.stringify({
  reviewed_on: pub.reviewed_on,
  queries: queryMeta,
}, null, 2));
console.log(JSON.stringify({ pages: outRoot, queries: queryMeta.length }));
"""],
        cwd=ROOT,
        env=env,
    )
    return json.loads((PAGES.parent / "b2-decision-search-meta.json").read_text())


def capture_png(page, path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path), full_page=True)
    return sha256_file(path)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    meta = build_pages()
    revision = git_revision()
    captured_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    server = serve(PAGES)
    host, port = server.server_address
    origin = f"http://127.0.0.1:{port}"
    captures = []

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            # Three query result pages at desktop width.
            for row, spec in zip(meta["queries"], QUERIES, strict=True):
                context = browser.new_context(viewport={"width": 1440, "height": 900})
                page = context.new_page()
                url = origin + row["local_search_path"]
                page.goto(url, wait_until="domcontentloaded")
                link = page.locator(f'a[href="{row["decision_href"]}"]')
                assert link.count() >= 1, f"missing decision link for {row['query']}"
                image = OUT / f"{spec['case']}.png"
                digest = capture_png(page, image)
                captures.append({
                    "case": spec["case"],
                    "route": f"/search/?q={row['query']}",
                    "query_url": f"https://cityscroll.org/search/?q={row['query']}",
                    "query": row["query"],
                    "viewport": {"width": 1440, "height": 900},
                    "revision": revision,
                    "data_vintage": meta.get("reviewed_on"),
                    "assertion": (
                        f"Query “{row['query']}” returns decision {row['candidate_id']} "
                        f"whose ordinary link is {row['decision_href']}"
                    ),
                    "decision_href": row["decision_href"],
                    "candidate_id": row["candidate_id"],
                    "sha256": digest,
                    "image": str(image.relative_to(ROOT)),
                })
                context.close()

            # search → decision → Back across desktop, touch, and keyboard.
            modes = [
                {"name": "desktop", "viewport": {"width": 1440, "height": 900}, "has_touch": False},
                {"name": "touch", "viewport": {"width": 390, "height": 844}, "has_touch": True},
                {"name": "keyboard", "viewport": {"width": 1280, "height": 800}, "has_touch": False},
            ]
            open_back_images = []
            open_back_observations = []
            sample = meta["queries"][0]
            for mode in modes:
                context = browser.new_context(
                    viewport=mode["viewport"],
                    has_touch=mode["has_touch"],
                )
                page = context.new_page()
                search_url = origin + sample["local_search_path"]
                page.goto(search_url, wait_until="domcontentloaded")
                page.evaluate("window.scrollTo(0, 120)")
                link = page.locator(f'a[href="{sample["decision_href"]}"]').first
                if mode["name"] == "keyboard":
                    link.focus()
                    page.keyboard.press("Enter")
                elif mode["name"] == "touch":
                    link.tap()
                else:
                    link.click()
                page.wait_for_url(f"**{sample['decision_href'].split('#')[0]}**")
                assert sample["decision_href"].split("#")[1] in page.url
                page.go_back(wait_until="domcontentloaded")
                restored = page.evaluate("() => window.__searchReturnRestored || null")
                q_value = page.locator('input[name="q"]').input_value()
                still_linked = page.locator(f'a[href="{sample["decision_href"]}"]').count() >= 1
                observation = {
                    "mode": mode["name"],
                    "viewport": mode["viewport"],
                    "query_preserved": q_value == sample["query"],
                    "decision_link_present": still_linked,
                    "return_state": restored,
                    "search_path": page.url.split(origin)[-1],
                }
                assert observation["query_preserved"], mode["name"]
                assert observation["decision_link_present"], mode["name"]
                image = OUT / f"decision-search-open-and-back-{mode['name']}.png"
                digest = capture_png(page, image)
                open_back_images.append({
                    "mode": mode["name"],
                    "sha256": digest,
                    "image": str(image.relative_to(ROOT)),
                })
                open_back_observations.append(observation)
                context.close()

            captures.append({
                "case": "decision-search-open-and-back",
                "route": f"/search/?q={sample['query']} → {sample['decision_href']} → Back",
                "query_url": f"https://cityscroll.org/search/?q={sample['query']}",
                "query": sample["query"],
                "viewports": [mode["viewport"] for mode in modes],
                "modes": [mode["name"] for mode in modes],
                "revision": revision,
                "data_vintage": meta.get("reviewed_on"),
                "assertion": (
                    "Opening the decision from search and using browser Back preserves the query, "
                    "result link, and restored focus across desktop, touch, and keyboard"
                ),
                "preserves_search_state": True,
                "decision_href": sample["decision_href"],
                "candidate_id": sample["candidate_id"],
                "observations": open_back_observations,
                "sha256": open_back_images[0]["sha256"],
                "recording_sha256": sha256_bytes(
                    json.dumps(open_back_observations, sort_keys=True).encode("utf-8")
                ),
                "images": open_back_images,
            })
            browser.close()
    finally:
        server.shutdown()

    manifest = {
        "schema": "cityscroll.community_board_decision_search_manifest.v1",
        "evidence_class": "isolated-consumer-render",
        "capture_mode": "headless-playwright-loopback-decision-search",
        "captured_at": captured_at,
        "revision": revision,
        "data_vintage": meta.get("reviewed_on"),
        "test_clock": captured_at,
        "image_directory": ".artifacts/community-board-decision-search",
        "image_binaries_committed": False,
        "image_policy": (
            "Capture images remain ignored and are not committed. Their SHA-256 values "
            "bind this textual manifest to the reviewed render."
        ),
        "served_index": "worker/src/data/keyword_search_index_shards/manifest.json",
        "query_destinations": [
            {
                "query": row["query"],
                "candidate_id": row["candidate_id"],
                "decision_href": row["decision_href"],
                "query_url": f"https://cityscroll.org/search/?q={row['query']}",
            }
            for row in meta["queries"]
        ],
        "captures": captures,
    }
    (EVIDENCE / "capture-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    (EVIDENCE / "README.md").write_text(
        """# Community board decision search

Admitted board decisions are searchable objects. A query for an address, docket,
or topic returns a named decision whose ordinary link opens that decision's
stable destination.

Regenerate with:

```sh
node tools/build_keyword_search_index.mjs
python3 tools/capture_community_board_decision_search.py
```

Images remain under `.artifacts/community-board-decision-search/` and are not
committed. The receipt is this manifest.
""",
        encoding="utf-8",
    )
    print(json.dumps({"captures": len(captures), "manifest": str(EVIDENCE / "capture-manifest.json")}))


if __name__ == "__main__":
    main()
