#!/usr/bin/env python3
"""Capture a bounded baseline of About and the public guide entry points.

The guide's first release needs a record of what a signed-out reader sees on
the pages it will link from and back to. This writes a capture manifest, never
an image: the rendered PNG stays in a gitignored local path and only its
sha256 enters the repository.

Two hashes are recorded per capture because they answer different questions:

* ``render_structure_sha256`` hashes the element skeleton of the main landmark
  (tag names plus the bounded set of structural attributes the surfaces use).
  It is stable across an ordinary civic-data refresh, so a later run that
  differs means the page shell itself changed.
* ``content_sha256`` hashes the rendered markup of the main landmark. Live civic
  records roll, so this is a point-in-time observation tied to the recorded data
  vintage, not a regression baseline.

    python3 tools/capture_guide_baseline.py
    python3 tools/capture_guide_baseline.py --base https://cityscroll.org
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE = "https://cityscroll.org"
DEFAULT_MANIFEST = ROOT / "docs" / "evidence" / "public-user-guide" / "capture-manifest.json"
DEFAULT_OUTPUT = ROOT / ".artifacts" / "guide-baseline"
VIEWPORTS = (("mobile", 390, 844), ("desktop", 1440, 900))
SETTLE_MS = 9000

# One assertion per route, phrased as the observable a reader can check.
ROUTES = (
    {
        "id": "about",
        "route": "/about",
        "assertion": "About renders its own document with the What this is orientation and the "
        "preserved section anchors the guide will link into.",
        "expect_text": ["What this is", "Explore CityScroll"],
        "expect_anchors": [
            "context",
            "past-patterns",
            "staffing-list-establishment-formula",
            "property-disposition-timing-formula",
            "tax-lien-sale-predictions",
            "zoning-base-rates",
            "applicant-conditioned-ulurp",
            "accessibility",
            "maintainers",
        ],
    },
    {
        "id": "home",
        "route": "/",
        "assertion": "The homepage offers the topic-first search entry a reader starts from; it "
        "carries no guide link yet.",
        "expect_text": ["Search"],
        "expect_anchors": [],
    },
    {
        "id": "now",
        "route": "/now/",
        "assertion": "Now separates deadlines a reader can still act on from upcoming events, and "
        "its calendar subscription control is present but hidden until a supported scope is "
        "chosen, so a how-to must teach the condition rather than the button.",
        "expect_text": ["Now", "Act by"],
        "expect_anchors": [],
        "expect_present_but_hidden": ["a.calendar-subscribe-btn"],
    },
    {
        "id": "following",
        "route": "/following/",
        "assertion": "Following opens on watch creation with a Community Board picker and a "
        "separately named City Council District pack.",
        "expect_text": ["Create a watch", "Preview matches"],
        "expect_anchors": [],
    },
    {
        "id": "browse",
        "route": "/browse/",
        "assertion": "Browse lists the record types as separate destinations rather than one "
        "flattened inventory.",
        "expect_text": ["Browse NYC public records", "Record types"],
        "expect_anchors": [],
    },
    {
        "id": "search-housing",
        "route": "/search/?q=housing",
        "assertion": "A topic search keeps results grouped by civic object across typed lanes, "
        "which is the observable the first tutorial teaches.",
        "expect_text": ["Results for", "housing"],
        "expect_anchors": [],
    },
)

STRUCTURAL_ATTRIBUTES = (
    "id",
    "role",
    "data-semantic-family",
    "data-civic-object-kind",
    "aria-label",
)

SKELETON_SCRIPT = """() => {
  const root = document.querySelector('main') || document.body;
  const parts = [];
  const attrs = %s;
  const walk = (node, depth) => {
    if (depth > 12) return;
    for (const child of node.children) {
      const kept = attrs
        .map((name) => (child.hasAttribute(name) ? name + '=' + child.getAttribute(name) : null))
        .filter(Boolean)
        .join(',');
      parts.push(depth + ':' + child.tagName + (kept ? '[' + kept + ']' : ''));
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return parts.join('\\n');
}""" % json.dumps(list(STRUCTURAL_ATTRIBUTES))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repository_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()


def settle(page: Page) -> None:
    page.wait_for_timeout(SETTLE_MS)
    page.evaluate("document.fonts && document.fonts.ready")


def observe(page: Page, spec: dict) -> dict:
    text = page.evaluate("() => ((document.querySelector('main') || document.body).innerText || '')")
    anchors = page.evaluate("() => [...document.querySelectorAll('[id]')].map((e) => e.id)")
    folded = text.casefold()
    missing_text = [needle for needle in spec["expect_text"] if needle.casefold() not in folded]
    missing_anchors = [anchor for anchor in spec["expect_anchors"] if anchor not in anchors]
    hidden_controls = {
        selector: page.evaluate(
            """(selector) => {
                const node = document.querySelector(selector);
                if (!node) return 'absent';
                const box = node.getBoundingClientRect();
                return box.width > 0 && box.height > 0 ? 'visible' : 'present_but_hidden';
            }""",
            selector,
        )
        for selector in spec.get("expect_present_but_hidden", ())
    }
    unmet_controls = [
        selector for selector, state in hidden_controls.items() if state != "present_but_hidden"
    ]
    return {
        "assertion_holds": not missing_text and not missing_anchors and not unmet_controls,
        "missing_expected_text": missing_text,
        "missing_expected_anchors": missing_anchors,
        "control_states": hidden_controls,
        "visible_text_characters": len(text),
        "content_sha256": sha256_text(
            page.evaluate("() => ((document.querySelector('main') || document.body).outerHTML)")
        ),
        "render_structure_sha256": sha256_text(page.evaluate(SKELETON_SCRIPT)),
    }


def capture(base: str, output_dir: Path) -> list[dict]:
    output_dir.mkdir(parents=True, exist_ok=True)
    captures: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for name, width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                for spec in ROUTES:
                    page.goto(f"{base.rstrip('/')}{spec['route']}", wait_until="domcontentloaded", timeout=60000)
                    settle(page)
                    image = output_dir / f"{spec['id']}-{width}.png"
                    page.screenshot(path=str(image), full_page=False)
                    captures.append(
                        {
                            "id": spec["id"],
                            "route": spec["route"],
                            "viewport": name,
                            "assertion": spec["assertion"],
                            **observe(page, spec),
                            "capture_sha256": sha256_file(image),
                            "local_capture_path": str(image.relative_to(ROOT)),
                            "file": None,
                        }
                    )
                context.close()
        finally:
            browser.close()
    return captures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    source_contracts = json.loads((ROOT / "site" / "data" / "source_contracts.json").read_text())
    captures = capture(args.base, args.output_dir)
    manifest = {
        "schema_version": 1,
        "card": "cityscroll-public-user-guide/ug-00-documentation-map",
        "capture_mode": "public_base_playwright_no_committed_image",
        "base": args.base,
        "repository_revision": repository_revision(),
        "note": (
            "A bounded baseline of About and the entry points the public guide will link from and "
            "back to, taken against the public deploy so it records what a signed-out reader "
            "actually sees. Captured images stay under the gitignored .artifacts/ path; the sha256 "
            "of each is the retained proof. render_structure_sha256 hashes the main landmark's "
            "element skeleton and is stable across an ordinary data refresh; content_sha256 hashes "
            "its rendered markup and is a point-in-time observation of live civic records, not a "
            "regression baseline. No accessibility gate ran here: this is a "
            "content and entry-point baseline, and the accessibility proof belongs to the change "
            "that ships a guide surface."
        ),
        "data_vintage": (
            "Live public deploy read at capture time. Record inventories on these surfaces roll "
            f"with their publishers; the source-contract registry carried "
            f"{len(source_contracts['contracts'])} contracts at this revision."
        ),
        "viewports": [
            {"name": name, "width": width, "height": height} for name, width, height in VIEWPORTS
        ],
        "captures": captures,
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n")
    failed = [item for item in captures if not item["assertion_holds"]]
    print(f"guide baseline: {len(captures)} captures written to {args.manifest.relative_to(ROOT)}")
    for item in failed:
        print(
            f"  assertion did not hold: {item['id']} @ {item['viewport']} "
            f"missing_text={item['missing_expected_text']} "
            f"missing_anchors={item['missing_expected_anchors']} "
            f"control_states={item['control_states']}"
        )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
