#!/usr/bin/env python3
"""Product screenshots for LDP-32 (authority evidence-state affordances).

Renders the real "Where this stands" authority panel — via the exact
site/land_authority_summary.mjs materializer and
site/land_authority_summary_view.mjs renderer the app itself uses — for the
real ELURP regression corpus (E1-E4) at mobile (390x844) and desktop
(1440x900). Each canary is built to exercise a distinct
published_next_opportunity evidence state (published/none/unknown/stale) so
the four states and the calendar/watch affordance gating are all visible.

A minimal static harness page (not the full app shell) is used deliberately:
the app's own list->select->attach pipeline mutates authority_summary onto
list rows asynchronously, which is unrelated plumbing this card does not
touch. Calling the same production render functions directly is a more
faithful and stable capture than fighting that unrelated bootstrap timing.

    python3 tools/capture_ldp32_authority_evidence_affordances.py
"""

from __future__ import annotations

import functools
import hashlib
import json
import subprocess
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "land-authority-evidence-state-affordances"
VIEWPORTS = [(390, 844), (1440, 900)]

CANARIES = [
    ("2024Q0356", "none", "E1 — active §197-e project: DCP certification stage, parallel CB/BP next, checked-and-empty published opportunity"),
    ("2024Q0419", "published", "E2 — completed §197-e route (C-prefixed id): CPC terminal, published next opportunity with a usable date, calendar affordance"),
    ("2025R0257", "stale", "E3 — completed §197-e route (different action family): CPC terminal, stale published-opportunity vintage"),
    ("2026X0362", "unresolved variant", "E4 — completed HPD §197-e(k) filing: observed Council path exposed without inferring the variant"),
]

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path) -> None:
        handler = functools.partial(QuietHandler, directory=str(directory))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


AUTHORITY_PAYLOAD_SCRIPT = """
import { buildLandAuthoritySummary } from '../site/land_authority_summary.mjs';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const geography = req('../site/data/community_board_geography_lookup.json');
function fixture(id) { return req('../test/fixtures/land_phase_spine/' + id + '.json'); }
const asOf = '2026-08-23T00:00:00.000Z';
const summaries = {};
summaries['2024Q0356'] = buildLandAuthoritySummary({
  ...fixture('2024Q0356'), geography, asOf, generatedAt: asOf,
  publishedOpportunities: { hearings: [], generated_at: asOf },
});
summaries['2024Q0419'] = buildLandAuthoritySummary({
  ...fixture('2024Q0419'), geography, asOf, generatedAt: asOf,
  publishedOpportunities: {
    hearings: [{ project_id: '2024Q0419', hearing_date: '2026-09-20', representing: 'City Planning Commission', milestone_title: 'CPC Public Hearing' }],
    generated_at: asOf,
  },
});
summaries['2025R0257'] = buildLandAuthoritySummary({
  ...fixture('2025R0257'), geography, asOf, generatedAt: asOf,
  publishedOpportunities: { hearings: [], generated_at: '2026-01-01T00:00:00.000Z' },
});
summaries['2026X0362'] = buildLandAuthoritySummary({ ...fixture('2026X0362'), geography, asOf, generatedAt: asOf });
process.stdout.write(JSON.stringify(summaries));
"""


def build_authority_summaries() -> dict:
    """Compute fresh authority summaries for the corpus so each canary
    exercises a distinct published_next_opportunity evidence state — the
    real, 40-project data/land_authority_summary.json aggregate does not
    carry these synthetic-corpus project ids at all."""
    script_path = ROOT / "tools" / "_capture_ldp32_authority_payload.mjs"
    script_path.write_text(AUTHORITY_PAYLOAD_SCRIPT, encoding="utf-8")
    try:
        result = subprocess.run(
            ["node", str(script_path)],
            cwd=ROOT / "tools",
            capture_output=True,
            text=True,
            check=True,
        )
    finally:
        script_path.unlink(missing_ok=True)
    return json.loads(result.stdout)


HARNESS_HTML_TEMPLATE = """<!doctype html>
<meta charset="utf-8">
<title>LDP-32 authority panel harness</title>
<style>
  body {{ margin: 0; font: 14px/1.4 -apple-system, system-ui, sans-serif; background: #fff; color: #111; }}
  #panel {{ max-width: 720px; margin: 16px; }}
  .land-authority-summary {{ border: 1px solid #ccc; border-radius: 8px; padding: 14px 16px; }}
  .land-authority-kicker {{ margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #555; }}
  .land-authority-stand {{ font-size: 16px; font-weight: 600; margin: 0 0 10px; }}
  .land-authority-facts {{ margin: 0 0 10px; }}
  .land-authority-facts > div {{ display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px dashed #eee; }}
  .land-authority-facts dt {{ flex: 0 0 160px; color: #555; }}
  .land-authority-facts dd {{ margin: 0; }}
  .land-authority-provenance ul, .land-authority-affected ul, .land-authority-observed ul {{ margin: 4px 0; padding-left: 18px; }}
  .land-authority-subhead {{ font-weight: 600; margin-top: 10px; }}
  .land-authority-actions {{ margin-top: 10px; display: flex; gap: 8px; }}
  .land-authority-actions .act {{ display: inline-block; padding: 6px 10px; border: 1px solid #333; border-radius: 6px; text-decoration: none; color: #111; font-size: 13px; }}
  .land-authority-advisory {{ font-size: 11px; color: #a35; }}
  h1 {{ font-size: 15px; margin: 16px 16px 4px; }}
</style>
<h1 id="label"></h1>
<div id="panel"></div>
<script type="module">
  import {{ landAuthoritySummaryHTML }} from './site/land_authority_summary_view.mjs';
  const EN = {json_strings};
  function t(key, vars) {{
    let text = EN[key] || key;
    if (vars) text = text.replace(/\\{{(\\w+)\\}}/g, (m, name) => (name in vars ? String(vars[name] ?? '') : m));
    return text;
  }}
  const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}}[c]));
  const summary = {summary_json};
  document.getElementById('label').textContent = {label_json};
  document.getElementById('panel').innerHTML = landAuthoritySummaryHTML(summary, {{ t, escape }});
  window.__ldp32Ready = true;
</script>
"""


def i18n_english_strings() -> dict:
    """A hand-picked slice of the canonical `en` dictionary (site/i18n.js) —
    the keys this specific panel renders. i18n.js is a browser <script>, not
    a Node-requirable module, so this mirrors the same pattern
    test/land_authority_panel.test.mjs already uses rather than parsing it."""
    return {
        "land_authority_heading": "Where this stands",
        "land_authority_stage": "Stage",
        "land_authority_actor": "Who",
        "land_authority_role": "Role",
        "land_authority_effect": "Effect",
        "land_authority_why": "Why this body appears",
        "land_authority_expected_next": "Expected next stage",
        "land_authority_published_next": "Published next opportunity",
        "land_authority_unknown": "Unknown",
        "land_authority_no_observation": "No observed recommendation",
        "land_authority_draft_only": "Draft only — not an observed recommendation",
        "land_authority_no_expected": "No expected next stage in this profile",
        "land_authority_not_found": "Not found in checked materializations",
        "land_authority_observed": "Observed recommendation",
        "land_authority_affected": "Affected review bodies",
        "land_authority_actor_dcp": "Department of City Planning",
        "land_authority_actor_council": "City Council",
        "land_authority_actor_short_cpc": "CPC",
        "land_authority_actor_short_council": "Council",
        "land_authority_role_advisory_reviewer": "Advisory reviewer",
        "land_authority_role_decision_maker": "Decision maker",
        "land_authority_role_conditional_decision_maker": "Conditional decision maker",
        "land_authority_role_administrative_certifier": "Administrative certifier",
        "land_authority_role_here_advisory_reviewer": "advisory review",
        "land_authority_role_here_decision_maker": "decision role",
        "land_authority_role_here_conditional_decision_maker": "conditional statutory review",
        "land_authority_role_here_administrative_certifier": "administrative certification",
        "land_authority_stand": "At {stage} · {actor}'s role here: {role} · Why: {why}",
        "land_authority_stand_unknown": "Where this stands is unknown",
        "land_authority_why_profile": "This action and procedure profile require it",
        "land_authority_why_unknown": "Unknown — the current stage does not resolve from available evidence",
        "land_authority_reason_unresolved_current_stage": "The current milestone does not match a reviewed profile stage",
        "land_authority_provenance": "Sources",
        "land_authority_provenance_profile": "Profile",
        "land_authority_provenance_phase": "Stage evidence",
        "land_authority_provenance_geography": "Geography reason",
        "land_authority_provenance_publisher": "Published opportunity",
        "land_authority_advisory": "Advisory",
        "land_authority_follow_next": "Follow next decision",
        "next_action_watch_project": "Follow this project",
        "land_authority_add_calendar": "Add to calendar",
        "land_authority_opportunity_none": "No published next opportunity found as of {date}",
        "land_authority_opportunity_unknown": "Upcoming-opportunity source not checked",
        "land_authority_opportunity_stale": "Opportunity information is stale as of {date}",
        "land_authority_expected_next_parallel": "{members} (reviewed at the same time)",
        "land_authority_and": "and",
        "land_phase_pre_application": "Pre-application and filing",
        "land_phase_community_board": "Community Board review",
        "land_phase_borough_president": "Borough President review",
        "land_phase_cpc": "City Planning Commission",
        "land_phase_city_council": "City Council review",
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    summaries = build_authority_summaries()
    strings = i18n_english_strings()
    all_files: list[dict] = []

    with StaticServer(ROOT) as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for stem, state, label in CANARIES:
            harness_path = ROOT / f"_ldp32_harness_{stem}.html"
            harness_path.write_text(
                HARNESS_HTML_TEMPLATE.format(
                    json_strings=json.dumps(strings),
                    summary_json=json.dumps(summaries[stem]),
                    label_json=json.dumps(f"{stem} — {label} ({state})"),
                ),
                encoding="utf-8",
            )
            try:
                for width, height in VIEWPORTS:
                    page = browser.new_page(viewport={"width": width, "height": height})
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.goto(f"{base_url}{harness_path.name}", wait_until="domcontentloaded")
                    page.wait_for_function("window.__ldp32Ready === true", timeout=15000)
                    page.wait_for_timeout(150)
                    out = OUT / f"{stem}-{width}.png"
                    page.locator("body").screenshot(path=str(out), animations="disabled")
                    data = out.read_bytes()
                    all_files.append({
                        "name": out.name,
                        "stem": stem,
                        "evidence_state": state,
                        "label": label,
                        "bytes": len(data),
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "viewport": [width, height],
                    })
                    if errors:
                        print(f"page errors ({stem}, {width}):", errors[:5])
                    print("wrote", out)
                    page.close()
            finally:
                harness_path.unlink(missing_ok=True)
        browser.close()

    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    receipt = {
        "schema": "cityscroll.land-authority-evidence-state-affordances.capture.v1",
        "card": "cityscroll-land-decision-path/ldp-32-authority-evidence-state-affordances",
        "assertion": (
            "The authority panel materializes DCP/CPC/Council actors and roles only after "
            "the exact action/procedure join, distinguishes checked-and-empty from unknown "
            "and stale published-opportunity evidence, and gates the calendar and watch "
            "affordances on real dated events and materialized next-stage transitions "
            "(A1-A10) across the real ELURP regression corpus (E1-E4). Rendered via the "
            "production buildLandAuthoritySummary/landAuthoritySummaryHTML functions in a "
            "minimal static harness (not the full app shell). "
            "390x844 mobile viewport is captured first per canary."
        ),
        "revision": revision,
        "vintage": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "canaries": [{"stem": s, "evidence_state": st, "label": l} for s, st, l in CANARIES],
        "files": all_files,
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print("done", OUT, "files", len(all_files))


if __name__ == "__main__":
    main()
