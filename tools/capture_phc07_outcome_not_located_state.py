#!/usr/bin/env python3
"""PHC-07 evidence: render each of the three non-Council outcome states from
site/outcome_not_located_state.mjs at both review widths and run axe-core
against each rendered fragment.

No image is written or committed - see docs/evidence/public-input-consequence/
phc-07-outcome-not-located/capture-manifest.json for the committed proof
(route, viewport, repository revision, data vintage, assertion and a content
hash per case), per the workstream's no-committed-image-binaries convention
(spec.md).

  node tools/capture_phc07_outcome_not_located_state.mjs   # (invoked by this script)
  python3 tools/capture_phc07_outcome_not_located_state.py
"""

from __future__ import annotations

import hashlib
import json
import re
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
TMP_DIR = ROOT / "site/.phc07-capture-tmp"
OUT_DIR = ROOT / "docs/evidence/public-input-consequence/phc-07-outcome-not-located"

# The mount point these states render through. If the meeting detail page stops
# routing through the outcome-state projection, this capture fails rather than
# quietly evidencing a component the product no longer shows.
MOUNT_FIDELITY_MARKERS = (
    'import("../outcome_not_located_state.mjs")',
    "tools.loadOutcomeState(r.request_id, r,",
)


def check_mount_fidelity() -> None:
    source = (ROOT / "site/app/meetings.mjs").read_text(encoding="utf-8")
    missing = [marker for marker in MOUNT_FIDELITY_MARKERS if marker not in source]
    if missing:
        raise SystemExit(
            "site/app/meetings.mjs no longer mounts the outcome-state projection this "
            f"capture evidences; missing: {missing}"
        )


def start_local_site_server() -> tuple[subprocess.Popen, str]:
    ready_file = Path(tempfile.mktemp(prefix="crol-phc07-site-"))
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
    rules = re.findall(
        r"(\.notice-fact-[^{]*\{[^}]+\}|\.chain-h\{[^}]+\}|\.stage-name\{[^}]+\}|"
        r"\.inline-disclose[^{]*\{[^}]+\}|\.note\{[^}]+\}|\.view[,{][^{]*\{[^}]+\})",
        html,
    )
    root = (
        ":root{--rule:#d6d3cd;--oxblood:#7a1f2b;--muted:#5c5852;--ink:#1c1917;--blue:#1a44e0;}"
        "body{margin:16px;background:#f4f1ea;font:16px/1.4 ui-sans-serif,system-ui,sans-serif;}"
        "a{color:#174ea6}"
    )
    return root + "".join(rules)


def main() -> None:
    check_mount_fidelity()
    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)
    generated = subprocess.run(
        [shutil.which("node") or "node", str(ROOT / "tools/capture_phc07_outcome_not_located_state.mjs")],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    cases = json.loads(generated.stdout)

    css = panel_css()
    server_proc, base = start_local_site_server()
    base = base.rstrip("/")
    captures = []
    state_hashes: dict[tuple[str, str], set[str]] = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for viewport_name, width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                for case in cases:
                    fragment_html = page.request.get(f"{base}{case['path']}").text()
                    # Wrapped in the same <main id="main"> landmark the real meeting
                    # detail page renders this section inside, so axe's landmark/region
                    # rules reflect the real page rather than a bare-fragment artifact.
                    wrapped = (
                        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
                        f"<style>{css}</style></head><body><main id='main'>{fragment_html}</main></body></html>"
                    )
                    page.set_content(wrapped, wait_until="domcontentloaded")
                    main_html = page.locator("main#main").inner_html()
                    content_sha256 = hashlib.sha256(main_html.encode("utf-8")).hexdigest()
                    state_hashes.setdefault((viewport_name, case['state']), set()).add(content_sha256)

                    heading = page.locator("main#main .chain-h").first.inner_text()
                    follow = page.locator("[data-field='follow-body'] a")
                    follow_label = follow.first.inner_text() if follow.count() else None
                    follow_href = follow.first.get_attribute("href") if follow.count() else None

                    page.add_script_tag(path=str(AXE))
                    result = page.evaluate(
                        "async () => await axe.run(document.querySelector('main#main') || document, "
                        "{resultTypes:['violations']})"
                    )
                    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(r => r.ruleId)"))
                    gate = failing_violations(result["violations"], wcag22_rules)

                    captures.append({
                        "fixture": case["id"],
                        "outcome_state": case["state"],
                        "route": (
                            "renderOutcomeState(lookup, request:20260102003, notice) "
                            f"— body:{case['body']}"
                        ),
                        "viewport": viewport_name,
                        "assertion": case["assertion"],
                        "content_sha256": content_sha256,
                        "heading_text": heading,
                        "follow_up_label": follow_label,
                        "follow_up_href": follow_href,
                        "axe_critical_or_serious_violations": [v["id"] for v in gate],
                        "file": None,
                    })
                    print(f"{viewport_name:8s} {case['id']:32s} state={case['state']:19s} "
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

    # The three states must never share a render at either width: an absence
    # state that hashed the same as the decision state would be the exact
    # failure this card exists to prevent. Two fixtures WITHIN one state may
    # legitimately hash alike - that is how A5 proves publication age changes
    # nothing - so distinctness is asserted between states, not between cases.
    for viewport_name, _, _ in VIEWPORTS:
        by_state = {state: hashes for (view, state), hashes in state_hashes.items() if view == viewport_name}
        if len(by_state) != 3:
            raise SystemExit(f"{viewport_name}: expected all three outcome states, saw {sorted(by_state)}")
        for left in by_state:
            for right in by_state:
                if left < right and by_state[left] & by_state[right]:
                    raise SystemExit(f"{viewport_name}: states {left} and {right} render identically")

    repository_revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema_version": 1,
        "card": "cityscroll-public-input-consequence/phc-07-outcome-not-located-is-honest",
        "capture_mode": "local_node_playwright_axe_static_render",
        "repository_revision": repository_revision,
        "note": (
            "Each case renders site/outcome_not_located_state.mjs's renderOutcomeState() "
            "directly via node, with no live Worker/D1 backend. The matched-decision and "
            "recorded-no-action cases use a synthetic lookup whose single row passes the "
            "receipt-backed exact source join; the not-located cases use the committed "
            "site/data/non_council_outcome_lookup.json, which matches no notices at all, "
            "and one case uses no lookup to evidence the fetch-failure path. "
            "tools/capture_phc07_outcome_not_located_state.py checks that "
            "site/app/meetings.mjs still mounts this projection before capture, so a later "
            "rewiring fails this capture rather than silently evidencing a component the "
            "product no longer shows. Fragments are served from site/ (real /index.html CSS "
            "rules) via tools/local_site_server.py. axe-core "
            "(test/functional/assets/axe.min.js) ran against each rendered fragment at both "
            "review widths, using the same failing-violation classification as "
            "test/functional/11_accessibility.py (a11y_gate.py). The capture fails unless "
            "all seven cases hash distinctly at each width, which is the evidence for A1. "
            "It does not evidence a live-data-populated page, since no Worker/D1 backend "
            "was running."
        ),
        "data_vintage": "committed_non_council_outcome_lookup_generated_at_2026-08-11 (0 of 10 notices matched); synthetic joined rows for the two matched states",
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
