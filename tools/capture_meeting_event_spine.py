#!/usr/bin/env python3
"""Capture the Council meeting event spine at mobile and desktop widths.

The fixture mirrors test/contract/fixtures/meeting_outcomes.json and keeps the
capture deterministic. Output lands in docs/screenshots/meeting-event-spine/.

  python3 tools/capture_meeting_event_spine.py
"""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "meeting-event-spine"
VIEWPORTS = ((390, 844), (1440, 900))

HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Council meeting event spine</title><style>
:root{--paper:#f4efe5;--paper-2:#f7f1e4;--card:#fff;--ink:#161512;--ink-soft:#3f3930;
  --muted:#69635a;--rule:#c8bfb0;--rule-strong:#8b8172;--green:#285d49;--oxblood:#7b1f2b}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.45 Georgia,serif}
.page{max-width:1180px;margin:0 auto;padding:18px clamp(14px,4vw,48px) 32px}
.mast{display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px double var(--ink);padding-bottom:10px}
.brand{font:900 27px/1 Georgia,serif;letter-spacing:-.03em}.brand span{color:var(--oxblood)}
.kicker{font:700 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--oxblood)}
h1{font:900 clamp(25px,4vw,42px)/1.04 Georgia,serif;letter-spacing:-.035em;margin:24px 0 7px;max-width:850px}
.meta{font:13px/1.45 ui-sans-serif,system-ui,sans-serif;color:var(--muted);margin:0 0 18px}
.panel{background:var(--paper-2);border:1px solid var(--rule);border-radius:9px;padding:16px 18px;margin-bottom:18px}
.chain-h{font:700 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:2px 0 10px}
.note{font:13px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--muted);background:#f4eee2;border-inline-start:3px solid var(--rule);padding:10px 12px;border-radius:0 8px 8px 0;margin:12px 0}
.meeting-spines{display:flex;flex-direction:column;gap:12px}.chain{display:flex;flex-wrap:nowrap;align-items:stretch}
.stage{flex:1 1 0;min-width:0;display:flex}.box{flex:1;min-width:0;border:1px solid var(--rule);border-top:3px solid var(--green);border-radius:8px;background:#fff;padding:13px 14px;display:flex;flex-direction:column;gap:6px}
.stage-name{font:700 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--green)}
.when{font:12px/1.3 ui-sans-serif,system-ui,sans-serif;color:var(--muted);overflow-wrap:anywhere}.bt{font-weight:700;line-height:1.3;overflow-wrap:anywhere}
.lc-pct{font:12px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--muted);overflow-wrap:anywhere}.connector{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:24px;flex:0 0 30px}
.view{font:650 12px/1.35 ui-sans-serif,system-ui,sans-serif;color:var(--oxblood);padding:4px 0}.docs{display:flex;flex-direction:column;align-items:flex-start;gap:2px}
.gap .chain-h{margin-top:0}.gap .note{margin-bottom:0}
@media(max-width:780px){.chain{flex-wrap:wrap}.stage{flex-basis:100%;min-width:100%}.connector{transform:rotate(90deg);height:24px;flex-basis:100%}.page{padding-top:12px}.mast .kicker{display:none}}
</style></head><body><main class="page">
<header class="mast"><div class="brand">City<span>Scroll</span></div><div class="kicker">Public meeting record</div></header>
<h1>Transit Improvement Funding</h1>
<p class="meta">City Council · Subcommittee on Land Use · July 28, 2026</p>
<section class="panel" aria-labelledby="council-heading">
  <div class="chain-h" id="council-heading">Council meeting outcomes</div>
  <div class="note">Matched Council event: <b>Subcommittee on Land Use</b> (July 28, 2026).</div>
  <div class="meeting-spines"><div class="chain">
    <div class="stage"><div class="box"><div class="stage-name">Agenda item</div><div class="when">#1</div><div class="bt">Transit Improvement Funding</div></div></div>
    <div class="connector" aria-hidden="true">→</div>
    <div class="stage"><div class="box"><div class="stage-name">Council matter</div><div class="when">LU 0001-2026</div><div class="bt">Transit Improvement Funding</div></div></div>
    <div class="connector" aria-hidden="true">→</div>
    <div class="stage"><div class="box"><div class="stage-name">Outcome</div><div class="when">Approved by Subcommittee</div><div class="lc-pct">Vote: Passed (aye 6 · nay 3)</div></div></div>
    <div class="connector" aria-hidden="true">→</div>
    <div class="stage"><div class="box"><div class="stage-name">Attachments</div><div class="docs"><a class="view" href="#">Staff report</a><a class="view" href="#">Agenda</a><a class="view" href="#">Minutes</a></div></div></div>
  </div></div>
  <div class="note">Outcomes join City Record hearing notices to NYC Council Legistar events, agenda items, matters, and votes.</div>
</section>
<section class="panel gap" aria-labelledby="other-heading">
  <div class="chain-h" id="other-heading">Hearing outcomes</div>
  <div class="note">The city does not publish votes for this non-Council hearing. They would appear on borough president websites and community board minutes pages if released as open data.</div>
</section>
</main></body></html>"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="cityscroll-meeting-spine-") as temp_dir:
        page_path = Path(temp_dir) / "index.html"
        page_path.write_text(HTML, encoding="utf-8")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                page.goto(page_path.as_uri(), wait_until="load")
                page.screenshot(path=str(OUT / f"meeting-event-spine-{width}.png"), full_page=True)
                context.close()
            browser.close()
    for path in sorted(OUT.glob("*.png")):
        print(f"{path.relative_to(ROOT)} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
