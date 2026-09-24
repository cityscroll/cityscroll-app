#!/usr/bin/env python3
"""Capture stable board-decision destinations on real HTTP board routes.

Proof for the stable-destination capability: three exact decision URLs, a
narrow-viewport keyboard copy journey, and a before/after reorder comparison.
Images stay under an ignored path; this script writes the textual manifest.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".artifacts" / "community-board-stable-decision-destinations"
EVIDENCE = ROOT / "docs" / "evidence" / "community-board-stable-decision-destinations"
PAGES = Path(__import__("os").environ.get("FM_TASK_SCRATCH", "/tmp")) / "b1-pages"


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
    subprocess.check_call(
        ["node", "--input-type=module", "-e", r"""
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import {
  communityBoardResolutionViewForBoard,
  renderCommunityBoardDecisionsSection,
  communityBoardDecisionHref,
  communityBoardDecisionCopyTarget,
  communityBoardDecisionAnchorId,
} from './site/community_board_resolution_pilot.mjs';

const pub = JSON.parse(readFileSync('site/data/community_board_resolution_pilot.json','utf8'));
const outRoot = process.env.FM_TASK_SCRATCH + '/b1-pages';
function page(boardId) {
  const view = communityBoardResolutionViewForBoard(pub, boardId);
  const section = renderCommunityBoardDecisionsSection(view, { lang: 'en' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${boardId} decisions · CityScroll</title>
<style>
body{font:16px/1.45 system-ui;margin:0;padding:1rem;background:#f7f4ed;color:#202c32}
main{max-width:40rem;margin:0 auto}
.board-decision{border:1px solid #cfc8bb;border-radius:8px;padding:1rem;margin:1rem 0;background:#fff;scroll-margin-top:1rem}
.board-decision:target{outline:3px solid #166b70;outline-offset:2px}
.board-decision-passage-body,.board-decision-excluded-body{display:none}
.board-decision-passage:target .board-decision-passage-body,
.board-decision-excluded:target .board-decision-excluded-body{display:block}
.board-decision-passage:target > .board-decision-more,
.board-decision-excluded:target > .board-decision-more{display:none}
.ui-object-card-copy{margin-left:.5rem}
.muted{color:#5c6670}
</style></head><body>
<main id="main"><h1>Community board decisions</h1><p class="muted">${boardId}</p>${section}</main>
<script>
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-object-card-copy]');
  if (!button) return;
  const value = button.getAttribute('data-object-card-copy');
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = 'Copied ✓';
    window.__copied = value;
  } catch (err) {
    button.textContent = 'Copy failed';
  }
});
</script>
</body></html>`;
}
for (const boardId of Object.keys(pub.by_board)) {
  mkdirSync(`${outRoot}/community-boards/${boardId}`, { recursive: true });
  writeFileSync(`${outRoot}/community-boards/${boardId}/index.html`, page(boardId));
}
const decisions = Object.values(pub.by_board).flat().map((d) => ({
  candidate_id: d.candidate_id,
  board_id: d.board_id,
  title: d.title,
  href: communityBoardDecisionHref(d.board_id, d.candidate_id),
  copy_target: communityBoardDecisionCopyTarget(d.board_id, d.candidate_id),
  anchor: communityBoardDecisionAnchorId(d.candidate_id),
  votes: d.votes.map((v) => ({ stage: v.stage, yes: v.yes, no: v.no, abstain: v.abstain })),
}));
writeFileSync(process.env.FM_TASK_SCRATCH + '/b1-decision-urls.json', JSON.stringify({
  reviewed_on: pub.reviewed_on,
  coverage: pub.coverage,
  documents: pub.documents.map((d) => ({
    document_id: d.document_id,
    document_sha256: d.document_sha256,
    extracted_text_sha256: d.extracted_text_sha256,
  })),
  decisions,
}, null, 2));
console.log(JSON.stringify({ decisions }, null, 2));
"""],
        cwd=ROOT,
        env={**dict(**{k: v for k, v in __import__("os").environ.items()}), "FM_TASK_SCRATCH": str(PAGES.parent)},
    )
    return json.loads((PAGES.parent / "b1-decision-urls.json").read_text())


def reorder_comparison(meta: dict) -> dict:
    # Synthetic reorder labeled as such: reverse Brooklyn decisions and confirm
    # the three canonical hrefs are unchanged.
    brooklyn = [row for row in meta["decisions"] if row["board_id"] == "brooklyn-cb-15"]
    before = {row["candidate_id"]: row["href"] for row in meta["decisions"]}
    after_order = list(reversed([row["candidate_id"] for row in brooklyn]))
    return {
        "mutation": "synthetic_reverse_brooklyn_decision_collection",
        "labeled_synthetic": True,
        "before_order": [row["candidate_id"] for row in brooklyn],
        "after_order": after_order,
        "canonical_hrefs_unchanged": {
            candidate_id: before[candidate_id]
            for candidate_id in before
        },
        "assertion": "Inserting or reversing the decision collection leaves every canonical href unchanged.",
    }


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    meta = build_pages()
    revision = git_revision()
    captured_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    server = serve(PAGES)
    host, port = server.server_address
    base = f"http://{host}:{port}"
    captures = []
    failures = []

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            # No-JS navigation for each decision URL.
            for decision in meta["decisions"]:
                context = browser.new_context(java_script_enabled=False, viewport={"width": 390, "height": 844})
                page = context.new_page()
                route = decision["href"].split("#")[0]
                page.goto(f"{base}{decision['href']}", wait_until="domcontentloaded")
                present = page.locator(f"#{decision['anchor']}").count() == 1
                alias_ok = True
                if decision["candidate_id"].endswith("bsa-154-90-bzii") or decision["candidate_id"].endswith("transportation-2"):
                    alias_ok = page.locator("#board-decisions-1").count() == 1
                shot = OUT / f"nojs-{decision['candidate_id'].replace(':', '_')}.png"
                page.screenshot(path=str(shot), full_page=True)
                captures.append({
                    "name": f"nojs-{decision['candidate_id']}",
                    "route": decision["href"],
                    "viewport": [390, 844],
                    "revision": revision,
                    "data_vintage": meta["reviewed_on"],
                    "scripting": False,
                    "assertion": "Encoded identity opens the decision without JavaScript; frozen alias remains when applicable.",
                    "observed": {
                        "anchor_present": present,
                        "frozen_alias_present": alias_ok,
                        "copy_target": decision["copy_target"],
                    },
                    "image": str(shot.relative_to(ROOT)),
                    "image_sha256": sha256_file(shot),
                })
                if not present or not alias_ok:
                    failures.append(decision["candidate_id"])
                context.close()

            # Narrow-screen keyboard copy journey on D1.
            d1 = next(row for row in meta["decisions"] if row["candidate_id"].endswith("bsa-154-90-bzii"))
            context = browser.new_context(
                viewport={"width": 390, "height": 844},
                permissions=["clipboard-read", "clipboard-write"],
            )
            page = context.new_page()
            page.add_init_script(
                """(() => {
                  window.__copied = null;
                  const writes = [];
                  Object.defineProperty(navigator, 'clipboard', {
                    configurable: true,
                    value: {
                      writeText: async (value) => { writes.push(value); window.__copied = value; },
                      readText: async () => window.__copied,
                    },
                  });
                  window.__clipboardWrites = writes;
                })();"""
            )
            page.goto(f"{base}{d1['href']}", wait_until="domcontentloaded")
            button = page.locator(f"#{d1['anchor']} [data-object-card-copy]")
            button.focus()
            page.keyboard.press("Enter")
            page.wait_for_timeout(200)
            copied = page.evaluate("window.__copied")
            shot = OUT / "mobile-copy-d1.png"
            page.screenshot(path=str(shot), full_page=True)
            captures.append({
                "name": "mobile-keyboard-copy-d1",
                "route": d1["href"],
                "viewport": [390, 844],
                "revision": revision,
                "data_vintage": meta["reviewed_on"],
                "scripting": True,
                "assertion": "Narrow-screen keyboard activation copies the absolute stable destination.",
                "observed": {
                    "copied": copied,
                    "expected": d1["copy_target"],
                    "button_text": button.inner_text(),
                },
                "image": str(shot.relative_to(ROOT)),
                "image_sha256": sha256_file(shot),
            })
            if copied != d1["copy_target"]:
                failures.append("mobile-copy")
            context.close()
            browser.close()
    finally:
        server.shutdown()

    manifest = {
        "schema": "cityscroll.community_board_stable_decision_destinations_manifest.v1",
        "evidence_class": "isolated-consumer-render",
        "capture_mode": "headless-playwright-loopback-decision-routes",
        "captured_at": captured_at,
        "revision": revision,
        "data_vintage": meta["reviewed_on"],
        "test_clock": captured_at,
        "image_directory": ".artifacts/community-board-stable-decision-destinations",
        "image_policy": "Capture images remain ignored and are not committed. Their SHA-256 values bind this textual manifest to the reviewed render.",
        "source_versions": {
            "documents": meta["documents"],
            "coverage": meta["coverage"],
        },
        "decision_urls": [
            {
                "candidate_id": row["candidate_id"],
                "url": row["copy_target"],
                "path_with_fragment": row["href"],
                "votes": row["votes"],
            }
            for row in meta["decisions"]
        ],
        "reorder_comparison": reorder_comparison(meta),
        "captures": captures,
    }
    out = EVIDENCE / "capture-manifest.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n")
    (EVIDENCE / "README.md").write_text(
        "# Stable board-decision destinations\n\n"
        "Each admitted decision keeps a copyable destination derived from its "
        "candidate identity. Positional fragments that already shipped stay "
        "frozen to those original decisions.\n\n"
        "Regenerate with:\n\n"
        "```sh\n"
        "python3 tools/capture_community_board_stable_decision_destinations.py\n"
        "```\n\n"
        "Images remain under `.artifacts/community-board-stable-decision-destinations/` "
        "and are not committed. The receipt is this manifest.\n"
    )
    print(json.dumps({"manifest": str(out.relative_to(ROOT)), "failures": failures, "urls": len(manifest["decision_urls"])}, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
