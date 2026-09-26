#!/usr/bin/env python3
"""Measure community-board directory neighborhood entry layout at named widths.

Reads a self-contained HTML document path, opens it in headless Chromium at
390x844 and 1440x900, records measured chooser and board-choice widths, and
Tabs until the neighborhood select receives focus.

Prints JSON a focused Node test can assert. No screenshots are written.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

VIEWPORTS = (
    {"id": "narrow_touch", "width": 390, "height": 844},
    {"id": "desktop", "width": 1440, "height": 900},
)

PROBE_JS = """() => {
  const entry = document.querySelector('[data-board-neighborhood-entry]');
  const select = document.querySelector('#scorecard-neighborhood-select');
  const label = document.querySelector('label[for="scorecard-neighborhood-select"]');
  const heading = document.querySelector('[data-board-neighborhood-results-heading]');
  const choices = [...document.querySelectorAll('.scorecard-neighborhood-choice')];
  const address = document.querySelector('[data-board-address-action]');
  const noJsLink = document.querySelector('[data-board-neighborhood-link="BK1503"]');
  const box = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible: rect.width > 0 && rect.height > 0,
    };
  };
  return {
    inner_width: window.innerWidth,
    inner_height: window.innerHeight,
    entry: box(entry),
    chooser: box(select),
    chooser_id: select ? select.id : null,
    label_text: label ? String(label.textContent || '').trim() : null,
    heading_text: heading ? String(heading.textContent || '').trim() : null,
    choice_count: choices.length,
    choice_widths: choices.map((node) => Math.round(node.getBoundingClientRect().width)),
    address_action_present: Boolean(address),
    nojs_link_href: noJsLink ? noJsLink.getAttribute('href') : null,
  };
}"""


def tab_until_neighborhood_select(page, *, max_tabs: int = 80) -> dict:
    """Tab until the named neighborhood chooser receives focus."""
    page.wait_for_selector("#scorecard-neighborhood-select", timeout=30_000)
    focused = None
    for steps in range(1, max_tabs + 1):
        page.keyboard.press("Tab")
        focused = page.evaluate(
            """() => {
              const el = document.activeElement;
              if (!el) return null;
              return {
                tag: el.tagName,
                id: el.id || null,
                name: el.getAttribute && el.getAttribute('name'),
                is_neighborhood_select: el.matches
                  ? el.matches('#scorecard-neighborhood-select,[data-board-neighborhood-select]')
                  : false,
              };
            }"""
        )
        if focused and focused.get("is_neighborhood_select"):
            return {
                "keyboard_traversal_steps": steps,
                "focused_neighborhood_select": True,
                "focused_id": focused.get("id"),
                "focused_name": focused.get("name"),
                "method": "tab-until-neighborhood-select-focus",
            }
    raise SystemExit(
        f"keyboard traversal did not land on #scorecard-neighborhood-select within {max_tabs} tabs; "
        f"last focus={focused!r}"
    )


def observe_viewport(page, url: str, viewport: dict) -> dict:
    page.goto(url, wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_selector("[data-board-neighborhood-entry]", timeout=10_000)
    page.wait_for_selector(".scorecard-neighborhood-choice", timeout=10_000)
    measured = page.evaluate(PROBE_JS)
    if abs(int(measured["inner_width"]) - int(viewport["width"])) > 0:
        raise SystemExit(
            f"{viewport['id']}: inner_width {measured['inner_width']} does not match "
            f"requested viewport width {viewport['width']}"
        )
    if not measured.get("entry") or measured["entry"]["width"] <= 0:
        raise SystemExit(f"{viewport['id']}: neighborhood entry width was not measurable")
    if not measured.get("chooser") or measured["chooser"]["width"] <= 0:
        raise SystemExit(f"{viewport['id']}: neighborhood chooser width was not measurable")
    if int(measured.get("choice_count") or 0) < 1:
        raise SystemExit(f"{viewport['id']}: expected Kensington board choice cards")
    if any(width <= 0 for width in measured.get("choice_widths") or []):
        raise SystemExit(f"{viewport['id']}: a board choice card width was not measurable")
    keyboard = tab_until_neighborhood_select(page)
    return {
        "id": viewport["id"],
        "viewport": {"width": viewport["width"], "height": viewport["height"]},
        "observed": {
            **measured,
            **keyboard,
        },
    }


def observe(document_path: pathlib.Path) -> dict:
    url = document_path.resolve().as_uri()
    observations = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for viewport in VIEWPORTS:
                page = browser.new_page(
                    viewport={"width": viewport["width"], "height": viewport["height"]}
                )
                try:
                    observations.append(observe_viewport(page, url, viewport))
                finally:
                    page.close()
        finally:
            browser.close()
    return {
        "schema": "cityscroll.board_neighborhood_directory_widths.v1",
        "capture_mode": "headless-playwright-fixture-document",
        "document": str(document_path),
        "viewports": [[row["width"], row["height"]] for row in VIEWPORTS],
        "observations": observations,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "document",
        type=pathlib.Path,
        help="Absolute or relative path to the fixture HTML document",
    )
    args = parser.parse_args(argv)
    document = args.document.expanduser().resolve()
    if not document.is_file():
        print(f"document not found: {document}", file=sys.stderr)
        return 2
    payload = observe(document)
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
