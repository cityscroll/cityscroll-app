#!/usr/bin/env python3
"""Capture the CC-7 pilot's deterministic before/after evidence cards.

The page is an offline rendering of the committed pilot.json artifact. No
production endpoint is contacted and no report is submitted by this script.
Both desktop and mobile captures are emitted for every confirmed case and the
explicit unresolved negative case.
"""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACT = ROOT / "docs" / "evidence" / "cc7-round-trip" / "pilot.json"
VIEWPORTS = ((1440, 900), (390, 844))


def esc(value: object) -> str:
    return html.escape(str(value if value is not None else ""))


def source_ids(item: dict) -> str:
    values = item.get("before", {}).get("provenance", {}).get("source_record_ids", [])
    return ", ".join(values) or "No source record attached"


def page_html(item: dict, phase: str) -> str:
    before = phase == "before"
    state = item["before"] if before else item["after"]
    if before:
        eyebrow = "Before · observed assertion"
        title = item["before"]["assertion"]
        result_label = "Visible civic result before review"
        result = state["visible_result"]
        status = "Awaiting challenge"
        status_class = "pending"
    elif item["after"]["changed"]:
        eyebrow = "After · corrected fixture result"
        title = item["after"]["visible_result"]
        result_label = "Changed civic result"
        result = state["visible_result"]
        status = "Confirmed in pilot"
        status_class = "confirmed"
    else:
        eyebrow = "After · unresolved fixture result"
        title = item["after"]["visible_result"]
        result_label = "Visible civic result after review"
        result = state["visible_result"]
        status = "Unresolved · no correction applied"
        status_class = "unresolved"

    target = item["report"]["payload"]["report_target"]
    change = item["source_of_truth_change"]
    provenance = item["before"].get("provenance") or {}
    systems = ", ".join(provenance.get("systems", [])) or "Not supplied"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CC-7 {esc(item['id'])} · {esc(phase)}</title>
<style>
:root {{ color-scheme: light; --ink:#19232d; --muted:#5e6b76; --line:#d8e0e6; --paper:#fff; --wash:#f4f7f9; --blue:#155b83; --green:#197044; --amber:#8a5b00; --red:#9b3030; }}
* {{ box-sizing:border-box; }} body {{ margin:0; background:var(--wash); color:var(--ink); font:16px/1.5 system-ui,-apple-system,sans-serif; }}
.page {{ width:min(100% - 32px, 920px); margin:32px auto; }}
.mast {{ display:flex; justify-content:space-between; gap:16px; align-items:center; margin-bottom:28px; }}
.brand {{ color:var(--blue); font:800 24px/1 Georgia,serif; letter-spacing:-.02em; }}
.brand span {{ color:var(--ink); }} .eyebrow {{ color:var(--blue); font-size:13px; font-weight:750; letter-spacing:.08em; text-transform:uppercase; margin:0 0 10px; }}
h1 {{ font:700 clamp(25px,4vw,39px)/1.1 Georgia,serif; letter-spacing:-.02em; margin:0 0 22px; max-width:800px; }}
.panel {{ background:var(--paper); border:1px solid var(--line); border-radius:14px; padding:24px; box-shadow:0 8px 24px #1225360d; }}
.status {{ border-left:5px solid var(--blue); background:#edf5fa; border-radius:6px; padding:12px 14px; margin-bottom:22px; font-weight:750; }}
.status.confirmed {{ border-color:var(--green); background:#edf8f1; color:#15562f; }} .status.unresolved {{ border-color:var(--red); background:#fff2f2; color:#7e2525; }}
.status.pending {{ color:#254f68; }} .grid {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }}
.section {{ min-width:0; }} .label {{ color:var(--muted); font-size:12px; font-weight:750; letter-spacing:.07em; text-transform:uppercase; margin:0 0 5px; }}
.value {{ margin:0; overflow-wrap:anywhere; }} .result {{ background:#f7fafb; border:1px solid var(--line); border-radius:8px; padding:14px; font-weight:650; }}
dl {{ margin:0; }} dt {{ color:var(--muted); font-size:13px; margin-top:10px; }} dt:first-child {{ margin-top:0; }} dd {{ margin:0; overflow-wrap:anywhere; }} code {{ font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }}
.change {{ margin-top:20px; border-top:1px solid var(--line); padding-top:18px; }} .changed {{ color:var(--green); font-weight:750; }} .unchanged {{ color:var(--red); font-weight:750; }}
@media (max-width:650px) {{ .page {{ width:min(100% - 20px, 920px); margin:16px auto; }} .panel {{ padding:17px; }} .grid {{ grid-template-columns:1fr; gap:16px; }} .mast {{ margin-bottom:20px; }} }}
</style></head><body><main class="page">
<div class="mast"><div class="brand">City<span>Scroll</span></div><div><code>{esc(item['id'])}</code></div></div>
<p class="eyebrow">{esc(eyebrow)} · {esc(item['class'].replace('_', ' '))}</p>
<h1>{esc(title)}</h1>
<div class="panel"><div class="status {status_class}">{esc(status)}</div>
<div class="grid">
<section class="section"><p class="label">{esc(result_label)}</p><p class="value result">{esc(result)}</p></section>
<section class="section"><p class="label">Failure origin</p><p class="value">{esc(item['failure_origin'].replace('_', ' '))}</p><dl><dt>Provenance</dt><dd>{esc(systems)} · {esc(source_ids(item))}</dd></dl></section>
</div>
<section class="change"><p class="label">Report seam</p><p class="value"><code>{esc(item['report']['path'])}</code> · claim <code>{esc(target['claim_anchor']['anchor'])}</code></p>
<p class="label" style="margin-top:14px">Source-of-truth change</p><p class="value {('changed' if change['changed'] else 'unchanged')}">{esc(change['path'])}: {esc(change['before'].get(change['path']) if change['before'].get(change['path']) is not None else '(missing)')} → {esc(change['after'].get(change['path']) if change['changed'] and change['after'].get(change['path']) is not None else ('unchanged' if not change['changed'] else '(missing)'))}</p></section>
</div></main></body></html>"""


def capture(artifact: Path, output: Path) -> None:
    data = json.loads(artifact.read_text())
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for item in data["cases"]:
            for phase in ("before", "after"):
                for width, height in VIEWPORTS:
                    page = browser.new_page(viewport={"width": width, "height": height})
                    page.set_content(page_html(item, phase), wait_until="load")
                    page.screenshot(
                        path=str(output / f"{item['id'].lower()}-{phase}-{width}.png"),
                        full_page=True,
                    )
                    page.close()
        browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    parser.add_argument("--output", type=Path, default=DEFAULT_ARTIFACT.parent)
    args = parser.parse_args()
    capture(args.artifact.resolve(), args.output.resolve())
    print(f"wrote captures to {args.output}")


if __name__ == "__main__":
    main()
