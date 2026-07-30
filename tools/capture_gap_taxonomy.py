#!/usr/bin/env python3
"""Capture two-register lifecycle gap copy at review viewports (390 + 1440).

Renders notice-detail lifecycle HTML offline with mocked unmatched/class-b cases
so captures do not depend on live Worker joins. Output lands under
docs/screenshots/gap-taxonomy/.
"""
from __future__ import annotations

import functools
import hashlib
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "gap-taxonomy"
VIEWPORTS = ((390, 844), (1440, 900))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


SHELL = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gap taxonomy capture</title>
<link rel="stylesheet" href="/site/brand.css">
<style>
  body{margin:0;padding:20px;background:#f4efe3;color:#1c1410;font:15px/1.45 ui-sans-serif,system-ui,sans-serif}
  h1{font:700 18px/1.3 ui-sans-serif,system-ui,sans-serif;margin:0 0 14px}
  .chain-h{font:600 14px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;margin:18px 0 10px;color:#4a3f35}
  .chain{display:flex;gap:0;flex-wrap:wrap;align-items:stretch}
  .stage{flex:1 1 200px;min-width:180px;display:flex;align-items:stretch}
  .box{flex:1;border:1px solid #d6cbb8;border-top:3px solid #8a7a66;border-radius:8px;background:#fff;padding:13px 14px;display:flex;flex-direction:column;gap:6px}
  .box .stage-name{font:700 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#6b5e52}
  .box.unmatched{border-top-style:dashed;border-top-color:#b8860b}
  .box.unmatched .stage-name{color:#b8860b}
  .box.unknown{border-top-color:#8a7a66}
  .box .when{font:12px/1.3 ui-sans-serif,system-ui,sans-serif;color:#6b5e52}
  .box .lc-norecord{font:12px/1.45 ui-sans-serif,system-ui,sans-serif;color:#6b5e52}
  .note{margin:12px 0 0;padding:10px 12px;background:#faf6ee;border:1px solid #d6cbb8;border-radius:7px;font:13px/1.45 ui-sans-serif,system-ui,sans-serif}
  .connector{display:flex;align-items:center;padding:0 6px;color:#8a7a66;font-weight:700}
  @media(max-width:560px){.connector{transform:rotate(90deg);height:24px}.stage{flex-basis:100%}}
  .panel{background:#fff;border:1px solid #d6cbb8;border-radius:10px;padding:16px 18px;max-width:980px}
</style>
</head><body>
<div class="panel" id="capture-root">
  <h1 id="case-title">Gap taxonomy</h1>
  <div id="body"></div>
</div>
<script src="/site/i18n.js"></script>
<script>
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function renderCase(kind){
  const t = window.t;
  document.getElementById('case-title').textContent =
    kind === 'class-a' ? 'Class A — not yet shown here (pending / registered / payments)'
                       : 'Class B — city does not publish (no PIN + subsidy outcome)';
  if(kind === 'class-a'){
    const src = '<span lang="en" dir="ltr">'+t('lifecycle_source_checkbook')+'</span>';
    document.getElementById('body').innerHTML = `
      <div class="chain-h">${t('lifecycle_heading')}</div>
      <div class="chain">
        <div class="stage"><div class="box unmatched">
          <div class="stage-name">${t('lifecycle_stage_pending')}</div>
          <div class="when">—</div>
          <div class="lc-norecord">${t('lifecycle_unmatched_pending_html',{source:src})}</div>
        </div></div>
        <div class="connector">→</div>
        <div class="stage"><div class="box unmatched">
          <div class="stage-name">${t('lifecycle_stage_registered')}</div>
          <div class="when">—</div>
          <div class="lc-norecord">${t('lifecycle_unmatched_registered_html',{source:src})}</div>
        </div></div>
        <div class="connector">→</div>
        <div class="stage"><div class="box unmatched">
          <div class="stage-name">${t('lifecycle_stage_payment')}</div>
          <div class="when">—</div>
          <div class="lc-norecord">${t('lifecycle_unmatched_payment_html',{source:src})}</div>
        </div></div>
      </div>
      <div class="note">${t('meeting_outcomes_no_votes_html',{matter:esc('Int 1234-2026')})}</div>
    `;
  } else {
    document.getElementById('body').innerHTML = `
      <div class="chain-h">${t('lifecycle_heading')}</div>
      <div class="note">${t('lifecycle_no_pin_note_html')}</div>
      <div class="chain-h">${t('subsidy_lifecycle_heading')}</div>
      <div class="note">${t('subsidy_unmatched_html',{
        title: esc('NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY - NOTICE OF PUBLIC HEARING'),
        reason: t('subsidy_unmatched_default_reason')
      })}</div>
      <div class="lc-norecord" style="margin-top:10px">${t('subsidy_outcome_unknown_html')}</div>
      <div class="lc-norecord" style="margin-top:8px">${t('agency_awards_none_open_data_html')}</div>
    `;
  }
}
window.__renderGapCase = renderCase;
</script>
</body></html>
"""


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    shell = OUTPUT / "_shell.html"
    shell.write_text(SHELL, encoding="utf-8")

    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    captures = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for kind in ("class-a", "class-b"):
                for width, height in VIEWPORTS:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        device_scale_factor=1,
                    )
                    page = context.new_page()
                    page.goto(base + "docs/screenshots/gap-taxonomy/_shell.html", wait_until="load")
                    page.wait_for_function("() => typeof window.t === 'function'")
                    page.evaluate(f"window.__renderGapCase({json.dumps(kind)})")
                    page.locator("#capture-root").wait_for(state="visible")
                    target = OUTPUT / f"{kind}-{width}.png"
                    page.locator("#capture-root").screenshot(path=str(target), animations="disabled")
                    captures.append(str(target.relative_to(ROOT)))
                    context.close()
            browser.close()
    finally:
        server.shutdown()
        shell.unlink(missing_ok=True)

    manifest = {
        "viewports": [w for w, _ in VIEWPORTS],
        "captures": captures,
        "sha256": {
            path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
            for path in captures
        },
    }
    (OUTPUT / "metrics.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
