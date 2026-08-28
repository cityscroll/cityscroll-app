#!/usr/bin/env python3
"""Capture the rendered rulemaking case file at the review widths.

The fixture is shaped like the existing /rules materialization and is rendered
by the production JavaScript projection before Playwright captures it. This
keeps the evidence deterministic and adds no acquisition.
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "rulemaking-case-file"

NODE_RENDER = r'''
import { buildRulemakingObjects } from "./worker/src/lib/rulemaking.mjs";
import { renderRulemakingDocument } from "./site/rulemaking_document.mjs";
const subject = "rulemaking:dot:bicycle-racks";
const url = "https://rules.cityofnewyork.us/rule/city-owned-bicycle-racks/";
const rows = [
  { request_id: "20260317026", agency: "DOT", title: "DOT Proposed Rules Relating to City-Owned Bicycle Racks", notice_date: "2026-03-25", stage: "hearing", rulemaking_subject_ref: subject, rulemaking_join: { matched: true, confidence: "high", notice_count: 2 }, nyc_rules: { url, title: "City-Owned Bicycle Racks", summary: "The proposed rule would amend the City-Owned Bicycle Racks rules.", hearing_date: "2026-04-24" }, events: [{ event_type: "public_hearing", valid_at: "2026-04-24", status: "occurred", source_url: url }, { event_type: "effective", valid_at: "2026-08-13", status: "occurred", source_url: url }] },
  { request_id: "20260706041", agency: "DOT", title: "Notice of Adoption: City-Owned Bicycle Racks", notice_date: "2026-07-14", stage: "effective", rulemaking_subject_ref: subject, rulemaking_join: { matched: true, confidence: "high", notice_count: 2 }, events: [] },
];
const object = buildRulemakingObjects(rows, { now: "2026-08-27" })[0];
process.stdout.write(renderRulemakingDocument(object));
'''


def render_html() -> str:
    result = subprocess.run(
        ["node", "--input-type=module", "-"],
        input=NODE_RENDER,
        text=True,
        capture_output=True,
        cwd=ROOT,
        check=True,
    )
    return result.stdout


def annotate(page, selector: str, label: str) -> None:
    page.evaluate(
        """({selector,label}) => {
          const target = document.querySelector(selector);
          if (!target) return;
          const rect = target.getBoundingClientRect();
          const mark = document.createElement('div');
          Object.assign(mark.style, {position:'absolute', left:`${rect.left - 5}px`, top:`${rect.top - 5}px`, width:`${rect.width + 10}px`, height:`${rect.height + 10}px`, border:'4px solid #d60000', borderRadius:'8px', zIndex:'99998', pointerEvents:'none'});
          const note = document.createElement('div');
          note.textContent = label;
          Object.assign(note.style, {position:'absolute', left:`${Math.max(5, rect.left)}px`, top:`${Math.max(5, rect.top - 38)}px`, background:'#d60000', color:'#fff', padding:'7px 10px', borderRadius:'5px', font:'800 12px/1.25 system-ui,sans-serif', zIndex:'99999', pointerEvents:'none'});
          document.body.append(mark, note);
        }""",
        {"selector": selector, "label": label},
    )


def capture(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    html = render_html()
    brand = (ROOT / "site" / "brand.css").read_text(encoding="utf-8")
    documents = (ROOT / "site" / "civic-documents.css").read_text(encoding="utf-8")
    html = html.replace("</head>", f"<style>{brand}\n{documents}</style></head>")
    with sync_playwright() as playwright:
        for width, height in ((390, 844), (1440, 900)):
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": width, "height": height})
            page.set_content(html, wait_until="domcontentloaded")
            page.locator("main[data-civic-object-kind='rulemaking']").wait_for()
            page.add_script_tag(path=str(ROOT / "test" / "functional" / "assets" / "axe.min.js"))
            violations = page.evaluate("async () => (await axe.run(document)).violations")
            serious = [item for item in violations if item["impact"] in ("serious", "critical")]
            if serious:
                raise AssertionError(f"axe violations at {width}px: {serious}")
            annotate(page, ".rulemaking-process", f"After: canonical rulemaking case file ({width}px)")
            page.screenshot(path=str(out / f"after-{width}-annotated.png"), full_page=True, animations="disabled")
            browser.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    capture(args.out.resolve())
    print(f"Captured rulemaking case file evidence in {args.out}")


if __name__ == "__main__":
    main()
