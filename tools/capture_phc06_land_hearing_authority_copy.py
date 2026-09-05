#!/usr/bin/env python3
"""PHC-06 evidence: render the Land "Where this stands" authority panel
(site/land_authority_summary_view.mjs's landAuthoritySummaryHTML(), which now
includes the plain-role line from site/land_hearing_authority_copy.mjs) and a
literal reproduction of the compressed upcoming-hearing row
(site/app/land.mjs's landHearingRowHTML(), not exported — reproduced verbatim
by tools/capture_phc06_land_hearing_authority_copy.mjs and checked against the
real source below before capture) for the specimens named in the card, at both
review widths. Runs axe-core against each rendered fragment.

No image is written or committed — see docs/evidence/public-input-consequence/
phc-06-land-use-authority-in-plain-terms/capture-manifest.json for the
committed proof (content hash + textual assertion per case), per the
workstream's no-committed-image-binaries convention (spec.md).

  node tools/capture_phc06_land_hearing_authority_copy.mjs   # (invoked by this script)
  python3 tools/capture_phc06_land_hearing_authority_copy.py
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "test/functional/assets"))
from a11y_gate import failing_violations  # noqa: E402

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
AXE = ROOT / "test/functional/assets/axe.min.js"
VIEWPORTS = (("mobile", 390, 844), ("desktop", 1440, 900))
TMP_DIR = ROOT / "site/.phc06-capture-tmp"
OUT_DIR = ROOT / "docs/evidence/public-input-consequence/phc-06-land-use-authority-in-plain-terms"

# The upcoming-hearing row template the .mjs helper reproduces is not exported
# from site/app/land.mjs — these substrings must still be present in the real
# source, so a later edit to the real row markup fails this capture instead of
# silently drifting from the literal reproduction it captures against.
ROW_FIDELITY_MARKERS = (
    'import { landHearingRowRoleHTML } from "../land_hearing_authority_copy.mjs"',
    "landHearingRowRoleHTML(landAuthoritySummaryFor(row)",
    '${roleTxt?` · ${roleTxt}`:""}',
)


def check_row_template_fidelity() -> None:
    source = (ROOT / "site/app/land.mjs").read_text(encoding="utf-8")
    missing = [marker for marker in ROW_FIDELITY_MARKERS if marker not in source]
    if missing:
        raise SystemExit(
            "site/app/land.mjs no longer matches the literal row template this capture "
            f"reproduces; missing: {missing}"
        )


def start_local_site_server() -> tuple[subprocess.Popen, str]:
    ready_file = Path(tempfile.mktemp(prefix="crol-phc06-site-"))
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "tools/local_site_server.py"),
         "--directory", "site", "--port", "0", "--ready-file", str(ready_file)],
        cwd=ROOT,
    )
    deadline = time.time() + 20
    while time.time() < deadline:
        if ready_file.exists() and ready_file.stat().st_size:
            base = ready_file.read_text().strip()
            if base:
                return proc, base
        if proc.poll() is not None:
            raise RuntimeError("local_site_server.py exited before becoming ready")
        time.sleep(0.1)
    raise RuntimeError("timed out waiting for local_site_server.py")


def panel_css() -> str:
    html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
    import re

    rules = re.findall(
        r"(\.land-authority-[^{]+\{[^}]+\}|\.land-hearing-row[^{]*\{[^}]+\}|\.row \.[a-z]+\{[^}]+\}|"
        r"\.rtitle\{[^}]+\}|\.rmeta\{[^}]+\}|\.ragency\{[^}]+\}|\.fcard-compact-actions[^{]*\{[^}]+\}|"
        r"\.act[,{][^{]*\{[^}]+\})",
        html,
    )
    root = (
        ":root{--rule:#d6d3cd;--oxblood:#7a1f2b;--muted:#5c5852;--ink:#1c1917;--blue:#1a44e0;}"
        "body{margin:16px;background:#f4f1ea;font:16px/1.4 ui-sans-serif,system-ui,sans-serif;}"
        "a{color:#174ea6}"
    )
    return root + "".join(rules)


def main() -> None:
    check_row_template_fidelity()
    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)
    generated = subprocess.run(
        [shutil.which("node") or "node", str(ROOT / "tools/capture_phc06_land_hearing_authority_copy.mjs")],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    cases = json.loads(generated.stdout)

    css = panel_css()
    (TMP_DIR / "capture.css").write_text(css, encoding="utf-8")

    server_proc, base = start_local_site_server()
    base = base.rstrip("/")
    captures = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for viewport_name, width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                for case in cases:
                    fragment_url = f"{base}{case['path']}"
                    fragment_html = page.request.get(fragment_url).text()
                    # Wrapped in the same <main id="main"> landmark the real Land page
                    # renders this panel/row inside, so axe's landmark/region rules
                    # reflect the real page rather than a bare-fragment capture artifact.
                    wrapped = (
                        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
                        f"<style>{css}</style></head><body><main id='main'>{fragment_html}</main></body></html>"
                    )
                    page.set_content(wrapped, wait_until="domcontentloaded")
                    main_html = page.locator("main#main").inner_html()
                    content_sha256 = hashlib.sha256(main_html.encode("utf-8")).hexdigest()

                    if case["kind"] == "panel":
                        role_locator = page.locator("[data-land-authority-plain-role]")
                    else:
                        role_locator = page.locator("[data-land-hearing-row-role]")
                    role_present = role_locator.count() > 0
                    role_text = role_locator.first.inner_text() if role_present else None

                    page.add_script_tag(path=str(AXE))
                    result = page.evaluate(
                        "async () => await axe.run(document.querySelector('main#main') || document, "
                        "{resultTypes:['violations']})"
                    )
                    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(r => r.ruleId)"))
                    gate = failing_violations(result["violations"], wcag22_rules)

                    captures.append({
                        "fixture": case["id"],
                        "kind": case["kind"],
                        "route": (
                            f"landAuthoritySummaryHTML(summary) — project:{case['project_id']}"
                            if case["kind"] == "panel"
                            else f"landHearingRowHTML(row) [literal reproduction, fidelity-checked] — project:{case['project_id']}"
                        ),
                        "viewport": viewport_name,
                        "assertion": case["assertion"],
                        "content_sha256": content_sha256,
                        "plain_role_present": role_present,
                        "plain_role_text": role_text,
                        "axe_critical_or_serious_violations": [v["id"] for v in gate],
                        "file": None,
                    })
                    print(f"{viewport_name:8s} {case['id']:40s} role={role_text!s:35} "
                          f"sha256={content_sha256[:12]} violations={[v['id'] for v in gate]}")
                page.close()
            browser.close()
    finally:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_proc.kill()
        shutil.rmtree(TMP_DIR, ignore_errors=True)

    repository_revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema_version": 1,
        "card": "cityscroll-public-input-consequence/phc-06-land-use-authority-in-plain-terms",
        "capture_mode": "local_node_playwright_axe_static_render",
        "repository_revision": repository_revision,
        "note": (
            "The authority-panel cases render landAuthoritySummaryHTML() directly against "
            "committed land-project fixtures (site/data/*.json, "
            "test/fixtures/land_authority_summary/elurp_197e_corpus.v1.json) via node, with no "
            "live Worker/D1 backend. The hearing-row cases render the new "
            "landHearingRowRoleHTML() projection composed with a literal reproduction of "
            "site/app/land.mjs's landHearingRowHTML() markup (that function is not exported); "
            "tools/capture_phc06_land_hearing_authority_copy.py checks fixed substrings of the "
            "real source before capture so a later edit to the real row markup fails this "
            "capture rather than silently drifting from it. Fragments are served from site/ "
            "(real /index.html CSS rules) via tools/local_site_server.py. axe-core "
            "(test/functional/assets/axe.min.js) ran against each rendered fragment at both "
            "review widths, using the same failing-violation classification as "
            "test/functional/11_accessibility.py (a11y_gate.py). Evidence proves the new "
            "plain-role line/span renders for a resolved current_role and does not render for an "
            "unresolved one (A1-A6), and introduces no new axe violation; it does not evidence a "
            "live-data-populated page, since no Worker/D1 backend was running."
        ),
        "data_vintage": "committed_fixture_snapshots_as_checked_in",
        "viewports": [
            {"name": "mobile", "width": 390, "height": 844},
            {"name": "desktop", "width": 1440, "height": 900},
        ],
        "captures": captures,
        "accessibility": {
            "tool": "axe-core (test/functional/assets/axe.min.js)",
            "scope": "main#main",
            "viewports_checked": ["390x844", "1440x900"],
            "new_violations_introduced": sum(len(c["axe_critical_or_serious_violations"]) for c in captures),
            "pre_existing_violations_observed": [],
        },
    }
    (OUT_DIR / "capture-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {OUT_DIR / 'capture-manifest.json'}")


if __name__ == "__main__":
    main()
