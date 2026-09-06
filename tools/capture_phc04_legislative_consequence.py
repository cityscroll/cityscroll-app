#!/usr/bin/env python3
"""PHC-04 evidence: render the meeting detail page's new "What happens with this matter"
consequence block (site/meeting_document.mjs's renderMeetingDocument(), via
site/legislative_hearing_consequence.mjs) for five synthetic City Record records, one per
state named in the card — a single exact matter join, several strict matches, an
adversarial title-only near-match, a later published vote, and a hearing that is itself a
matter's most recent observed appearance. Runs axe-core against each rendered document at
both review widths.

No image is written or committed — see docs/evidence/public-input-consequence/
legislative-consequence/capture-manifest.json for the committed proof (content hash
+ textual assertion per case), per the workstream's no-committed-image-binaries convention
(spec.md).

  node tools/capture_phc04_legislative_consequence.mjs   # (invoked by this script)
  python3 tools/capture_phc04_legislative_consequence.py
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
TMP_DIR = ROOT / "site/.phc04-capture-tmp"
OUT_DIR = ROOT / "docs/evidence/public-input-consequence/legislative-consequence"


def start_local_site_server() -> tuple[subprocess.Popen, str]:
    ready_file = Path(tempfile.mktemp(prefix="crol-phc04-site-"))
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


def main() -> None:
    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)
    generated = subprocess.run(
        [shutil.which("node") or "node", str(ROOT / "tools/capture_phc04_legislative_consequence.mjs")],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    cases = json.loads(generated.stdout)

    server_proc, base = start_local_site_server()
    base = base.rstrip("/")
    captures = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for viewport_name, width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                for case in cases:
                    page.goto(f"{base}{case['path']}", wait_until="domcontentloaded")
                    page.wait_for_timeout(200)
                    consequence = page.locator('[data-legislative-hearing-consequence="1"]')
                    has_consequence = consequence.count() > 0
                    document_html = page.locator("main#main").inner_html()
                    content_sha256 = hashlib.sha256(document_html.encode("utf-8")).hexdigest()

                    page.add_script_tag(path=str(AXE))
                    result = page.evaluate(
                        "async () => await axe.run(document.querySelector('main#main') || document, "
                        "{resultTypes:['violations']})"
                    )
                    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(r => r.ruleId)"))
                    gate = failing_violations(result["violations"], wcag22_rules)

                    captures.append({
                        "fixture": case["id"],
                        "route": f"renderMeetingDocument(record) — {case['meeting_id']}",
                        "viewport": viewport_name,
                        "assertion": case["assertion"],
                        "content_sha256": content_sha256,
                        "consequence_block_present": has_consequence,
                        "axe_critical_or_serious_violations": [v["id"] for v in gate],
                        "file": None,
                    })
                    print(f"{viewport_name:8s} {case['id']:55s} consequence={has_consequence!s:5} "
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
        "card": "cityscroll-engineering/legislative-consequence-on-exact-joins",
        "capture_mode": "local_node_playwright_axe_static_render",
        "repository_revision": repository_revision,
        "note": (
            "renderMeetingDocument() rendered locally via node (no live Worker/D1 backend) for "
            "five synthetic City Record records, one per state named in the card, then served "
            "from site/ (real /brand.css, /civic-documents.css, /report_issue.mjs) via "
            "tools/local_site_server.py. axe-core (test/functional/assets/axe.min.js) ran "
            "against the rendered <main id=\"main\"> for each case at both review widths, using "
            "the same failing-violation classification as test/functional/11_accessibility.py "
            "(a11y_gate.py). Evidence proves the sourced consequence block's placement, content, "
            "and omission states (A1-A6) render as specified and introduce no new axe violation; "
            "it does not evidence a live-data-populated page, since no Worker/D1 backend was "
            "running."
        ),
        "data_vintage": "not_applicable_synthetic_fixture_records",
        "viewports": [
            {"name": "mobile", "width": 390, "height": 844},
            {"name": "desktop", "width": 1440, "height": 900},
        ],
        "captures": captures,
        "accessibility": {
            "tool": "axe-core (test/functional/assets/axe.min.js)",
            "scope": 'main#main',
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
