#!/usr/bin/env python3
"""Before/after evidence for agency-name false-split resolution.

Renders a self-contained review page that shows the three gold residual pairs
(DoITT→OTI, DA county↔borough, Business→SBS) collapsing to one canonical id
each, plus the eval metrics movement (false_split 3→0). No production D1.

    python3 tools/capture_agency_false_splits.py
"""

from __future__ import annotations

import http.server
import json
import socketserver
import subprocess
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "agency-false-splits"
VIEWPORTS = ((390, 844), (1440, 900))

# Pre-fix residual (measured on gold_v0 + token_v0 before the alias extension).
BEFORE = {
    "precision": 1,
    "recall": 0.896551724137931,
    "candidate_recall": 0.9655172413793104,
    "unresolved_rate": 0.19444444444444445,
    "false_merge": 0,
    "false_split": 3,
}

PAIRS = [
    {
        "id": "gv0-026",
        "left": "Dept of Info Tech & Telecomm",
        "right": "Office of Technology and Innovation",
        "note": "Successor rename: DoITT folded into OTI",
    },
    {
        "id": "gv0-030",
        "left": "District Attorney - New York County",
        "right": "Manhattan District Attorney's Office",
        "note": "County vs borough naming for the same DA office",
    },
    {
        "id": "gv0-032",
        "left": "Department of Business Services",
        "right": "Department of Small Business Services",
        "note": "Former City Record name vs current SBS",
    },
    {
        "id": "gv0-031",
        "left": "Manhattan District Attorney's Office",
        "right": "Brooklyn District Attorney's Office",
        "note": "Control: distinct borough DAs must stay distinct",
        "expect_same": False,
    },
]


def live_metrics() -> dict:
    r = subprocess.run(
        [
            "node",
            "entity_resolution/eval/run_metrics.mjs",
            "--gold",
            "entity_resolution/eval/gold_v0.jsonl",
            "--blocker",
            "token_v0",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    out = {}
    for line in r.stdout.splitlines():
        if "=" in line and not line.startswith("---") and not line.startswith("block"):
            k, _, v = line.partition("=")
            if k in BEFORE:
                out[k] = float(v) if "." in v else int(v)
    return out


def resolve_pairs() -> list[dict]:
    script = r"""
import { canonicalAgency } from "./worker/src/lib/agencies.mjs";
import { sameAgency } from "./entity_resolution/normalizers/agency.mjs";
import { enrichAgency } from "./worker/src/lib/agency_identity.mjs";
import cw from "./worker/src/data/agency_crosswalk.json" with { type: "json" };
const pairs = %s;
const out = [];
for (const p of pairs) {
  const ca = canonicalAgency(p.left);
  const cb = canonicalAgency(p.right);
  const same = sameAgency(p.left, p.right);
  const card = enrichAgency(cw.entries, p.left);
  out.push({
    ...p,
    same,
    left_id: ca.canonical_id,
    right_id: cb.canonical_id,
    left_name: ca.canonical_name,
    right_name: cb.canonical_name,
    identity: card ? card.canonical_name : null,
    acronym: card?.acronym || null,
  });
}
console.log(JSON.stringify(out));
""" % json.dumps(PAIRS)
    r = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(r.stdout.strip().splitlines()[-1])


def render_html(phase: str, metrics: dict, pairs: list[dict]) -> str:
    rows = []
    for p in pairs:
        expect_same = p.get("expect_same", True)
        if phase == "before" and expect_same:
            # Historical residual: these three were split.
            same_label = "split" if p["id"] != "gv0-031" else "distinct"
            same_cls = "bad" if p["id"] != "gv0-031" else "ok"
            lid = p["left"][:28] + "…" if len(p["left"]) > 28 else p["left"]
            rid = p["right"][:28] + "…" if len(p["right"]) > 28 else p["right"]
            detail = "separate entities"
        else:
            ok = p["same"] == expect_same
            same_label = "same" if p["same"] else "distinct"
            same_cls = "ok" if ok else "bad"
            lid = p.get("left_id") or ""
            rid = p.get("right_id") or ""
            detail = p.get("identity") or p.get("left_name") or ""
            if p.get("acronym"):
                detail = f"{detail} ({p['acronym']})"
        rows.append(
            f"""<tr class="{same_cls}">
              <td><code>{p['id']}</code></td>
              <td>{p['left']}</td>
              <td>{p['right']}</td>
              <td class="verdict">{same_label}</td>
              <td class="detail">{detail if phase == 'after' else '—'}</td>
            </tr>"""
        )

    metric_cells = []
    for key in ("false_split", "false_merge", "recall", "candidate_recall", "precision"):
        val = metrics[key]
        disp = f"{val:.3f}" if isinstance(val, float) and val not in (0, 1) else str(val)
        if val == 1.0:
            disp = "1"
        highlight = "hi" if key == "false_split" else ""
        metric_cells.append(f'<div class="m {highlight}"><span class="k">{key}</span><span class="v">{disp}</span></div>')

    title = "Before — agency rename residual" if phase == "before" else "After — agency aliases closed"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
  :root {{ --ink:#1b140f; --muted:#6b5e52; --ok:#1f6b3a; --bad:#9b2c2c; --paper:#fbf7ed; --rule:#e6dcc8; --amber:#c45c26; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; font:15px/1.45 ui-sans-serif,system-ui,sans-serif; color:var(--ink); background:var(--paper); }}
  header {{ padding:18px 20px 12px; border-bottom:1px solid var(--rule); }}
  header h1 {{ margin:0 0 4px; font:800 22px/1.15 Georgia,serif; }}
  header p {{ margin:0; color:var(--muted); font-size:13px; max-width:52rem; }}
  .metrics {{ display:flex; flex-wrap:wrap; gap:10px; padding:14px 20px; }}
  .m {{ background:#fff; border:1px solid var(--rule); border-radius:8px; padding:10px 14px; min-width:7.5rem; }}
  .m.hi {{ border-color:var(--amber); box-shadow:0 0 0 1px var(--amber); }}
  .m .k {{ display:block; font:600 10px/1.2 ui-sans-serif,system-ui,sans-serif; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }}
  .m .v {{ display:block; font:800 22px/1.1 Georgia,serif; margin-top:4px; }}
  table {{ width:100%; border-collapse:collapse; margin:0 0 24px; font-size:13px; }}
  th, td {{ text-align:left; padding:10px 12px; border-bottom:1px solid var(--rule); vertical-align:top; }}
  th {{ font:600 11px/1.2 ui-sans-serif,system-ui,sans-serif; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); background:#f3ecdc; }}
  .verdict {{ font-weight:700; text-transform:uppercase; font-size:11px; letter-spacing:.04em; }}
  tr.ok .verdict {{ color:var(--ok); }}
  tr.bad .verdict {{ color:var(--bad); }}
  .detail {{ color:var(--muted); font-size:12px; }}
  .wrap {{ padding:0 12px 24px; overflow-x:auto; }}
  code {{ font:12px/1.3 ui-monospace,Menlo,monospace; }}
</style></head><body>
<header>
  <h1>{title}</h1>
  <p>Entity-resolution gold set residual: agency renames and dual names that used to split one real-world agency into two entities across notices and contracts. Metric gate: <code>false_split</code> on <code>gold_v0</code> + <code>token_v0</code>.</p>
</header>
<section class="metrics">{''.join(metric_cells)}</section>
<div class="wrap"><table>
  <thead><tr><th>Case</th><th>Left name</th><th>Right name</th><th>Decision</th><th>Shared identity</th></tr></thead>
  <tbody>{''.join(rows)}</tbody>
</table></div>
</body></html>"""


def serve(directory: Path):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def log_message(self, *_args):
            pass

    httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    port = httpd.server_address[1]
    return httpd, f"http://127.0.0.1:{port}"


def main() -> None:
    after_metrics = live_metrics()
    assert after_metrics.get("false_split") == 0, after_metrics
    assert after_metrics.get("false_merge") == 0, after_metrics
    pairs = resolve_pairs()
    OUT.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "before.html").write_text(render_html("before", BEFORE, pairs), encoding="utf-8")
        (tmp_path / "after.html").write_text(render_html("after", after_metrics, pairs), encoding="utf-8")
        httpd, base = serve(tmp_path)
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch()
                for phase in ("before", "after"):
                    for w, h in VIEWPORTS:
                        page = browser.new_page(viewport={"width": w, "height": h})
                        page.goto(f"{base}/{phase}.html", wait_until="networkidle")
                        page.screenshot(path=str(OUT / f"{phase}-{w}.png"), full_page=True)
                        page.close()
                browser.close()
        finally:
            httpd.shutdown()

    summary = {
        "metric": "false_split (agency subset on gold_v0 + token_v0)",
        "before": BEFORE,
        "after": after_metrics,
        "pairs": pairs,
        "screenshots": sorted(p.name for p in OUT.glob("*.png")),
    }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT} false_split {BEFORE['false_split']} → {after_metrics['false_split']}")


if __name__ == "__main__":
    main()
