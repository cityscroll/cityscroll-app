#!/usr/bin/env python3
"""Observe Near You record-inspection default density at narrow and desktop widths.

Reads a self-contained HTML document path, opens it in headless Chromium at
390x844 and 1440x900, and prints JSON observations a focused test can assert.
No screenshots are written.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

PROBE_JS = """() => {
  const record = document.querySelector('.near-record');
  const inspect = document.querySelector('.near-record-inspect');
  const titleLink = document.querySelector('.near-record-title-link');
  const full = document.querySelector('.near-record-full-record');
  const role = document.querySelector('[data-place-role]');
  const basis = document.querySelector('.near-record-basis');
  const row = document.querySelector('.near-you-record-inspection-row');
  const dt = row && row.querySelector('dt');
  const dd = row && row.querySelector('dd');
  const evidence = [...document.querySelectorAll('.near-you-record-inspection-evidence')];
  const title = document.querySelector('.near-you-record-inspection-title');
  const box = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      width: rect.width,
      height: rect.height,
      display: style.display,
      visible: style.display !== 'none' && rect.width > 0 && rect.height > 0,
    };
  };
  const dtBox = dt && dt.getBoundingClientRect();
  const ddBox = dd && dd.getBoundingClientRect();
  return {
    viewport: { width: innerWidth, height: innerHeight },
    scroll_width: document.documentElement.scrollWidth,
    no_horizontal_overflow: document.documentElement.scrollWidth <= innerWidth + 1,
    record_padding_top_px: record ? parseFloat(getComputedStyle(record).paddingTop) : null,
    record_text: record ? String(record.innerText || '').replace(/\\s+/g, ' ').trim() : null,
    inspect: box(inspect),
    title_link: box(titleLink),
    full_record: box(full),
    place_role: role ? String(role.textContent || '').trim() : null,
    basis: basis ? String(basis.textContent || '').trim() : null,
    inspection_title: title ? String(title.textContent || '').trim() : null,
    grid_template_columns: row ? getComputedStyle(row).gridTemplateColumns : null,
    fact_rows_stacked: !!(dtBox && ddBox && ddBox.top >= dtBox.bottom - 1),
    fact_rows_side_by_side: !!(
      dtBox && ddBox && Math.abs(ddBox.top - dtBox.top) < 4 && ddBox.left >= dtBox.right - 2
    ),
    evidence_count: evidence.length,
    evidence_open: evidence.map((node) => Boolean(node.open)),
  };
}"""

VIEWPORTS = (
    {"width": 390, "height": 844, "id": "narrow_touch"},
    {"width": 1440, "height": 900, "id": "desktop"},
)


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
                    page.goto(url, wait_until="domcontentloaded", timeout=30_000)
                    page.wait_for_selector(".near-record", timeout=10_000)
                    page.wait_for_selector(".near-you-record-inspection-row", timeout=10_000)
                    measured = page.evaluate(PROBE_JS)
                    observations.append(
                        {
                            "id": viewport["id"],
                            "viewport": {
                                "width": viewport["width"],
                                "height": viewport["height"],
                            },
                            "observed": measured,
                        }
                    )
                finally:
                    page.close()
        finally:
            browser.close()
    return {
        "schema": "cityscroll.near_you_record_inspection_narrow_density.v1",
        "document": str(document_path),
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
