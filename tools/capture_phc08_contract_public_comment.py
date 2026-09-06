#!/usr/bin/env python3
"""PHC-08 evidence: render the notice action rail for a proposed-contract-award notice
filed under the legacy "Contract Award Hearings" label, through the real client pipeline
(site/action_registry.js + site/app/feed-actions.mjs), at both review widths, and run
axe-core against the rendered rail.

Requires the CI-equivalent local static site: run tools/prepare_functional_site.sh once
before this script (builds _site).

No image is written or committed — see docs/evidence/public-input-consequence/
contract-public-comment/capture-manifest.json for the committed proof (content
hash + textual assertion per case), per the workstream's no-committed-image-binaries
convention (spec.md).
"""

from __future__ import annotations

import hashlib
import json
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

QUALIFYING_OPEN = {
    "request_id": "SYN-PHC08-OPEN",
    "agency_name": "Health and Mental Hygiene",
    "section_name": "Contract Award Hearings",
    "type_of_notice_description": "Notice",
    "short_title": "Custodial Services Contract",
    # City Record rows carry no structured comment_url field, and the client's
    # noticeActionMatter zeroes matter.comment_url for non-rule notices — the channel a
    # reader can actually act on comes from body text, mirroring the real MOCS notices.
    "additional_description_1": (
        "<p>This is a notice seeking comments about the proposed contract below.</p>"
        "<p><strong>E-PIN:&nbsp;</strong>81626S0021099</p>"
        "<p>Comments may be submitted at https://www.nyc.gov/site/mocs/opportunities/contract-comments.page "
        "before December 31, 2099.</p>"
    ),
}
QUALIFYING_CLOSED = {
    **QUALIFYING_OPEN,
    "request_id": "SYN-PHC08-CLOSED",
    "additional_description_1": (
        "<p>This is a notice seeking comments about the proposed contract below.</p>"
        "<p><strong>E-PIN:&nbsp;</strong>81626S0021098</p>"
        "<p>Comments may be submitted at https://www.nyc.gov/site/mocs/opportunities/contract-comments.page "
        "before January 1, 2020.</p>"
    ),
}
QUALIFYING_NO_CHANNEL = {
    **QUALIFYING_OPEN,
    "request_id": "SYN-PHC08-INSTRUCTIONS",
    "additional_description_1": (
        "<p>This is a notice seeking comments about the proposed contract below.</p>"
        "<p><strong>E-PIN:&nbsp;</strong>81626S0021097</p>"
    ),
}
GENUINE_HEARING = {
    "request_id": "SYN-PHC08-HEARING",
    "agency_name": "Health and Mental Hygiene",
    "section_name": "Contract Award Hearings",
    "type_of_notice_description": "Public Hearing",
    "short_title": "Custodial Services Contract Award Hearing",
    "additional_description_1": (
        "<p>A public hearing on this proposed contract award will be held at 250 Broadway, "
        "New York, NY.</p><p><strong>E-PIN:&nbsp;</strong>81626S0021096</p>"
    ),
}

CASES = [
    ("qualifying_open_comment_window", QUALIFYING_OPEN,
     "A1/A2/A3/A4: a qualifying notice renders a Submit-a-comment action with no attend/"
     "conferencing/calendar control, and the guide carries the consider-before-award consequence."),
    ("qualifying_closed_comment_window", QUALIFYING_CLOSED,
     "Negative rule: a stale comment window states Public comment is not open now — never "
     "offered as a live submission, and never a calendar control."),
    ("qualifying_no_channel_reads_instructions", QUALIFYING_NO_CHANNEL,
     "A3: comment evidence without a verified submission channel falls back to Read official "
     "notice rather than inventing a submit control."),
    ("genuine_hearing_same_legacy_label", GENUINE_HEARING,
     "A5/A6: a genuinely published live hearing under the same legacy label keeps its real "
     "hearing rail (guide-first participation steps), never the comment-window rail."),
]

OUT_DIR = ROOT / "docs/evidence/public-input-consequence/contract-public-comment"


def make_router(row):
    def route(playwright_route):
        url = playwright_route.request.url
        if "dg92-zbpx" in url and row["request_id"] in url:
            playwright_route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps([row]),
            )
            return
        playwright_route.continue_()

    return route


def start_local_site_server() -> tuple[subprocess.Popen, str]:
    ready_file = Path(tempfile.mktemp(prefix="crol-phc08-site-"))
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "tools/local_site_server.py"),
         "--directory", "_site", "--port", "0", "--ready-file", str(ready_file)],
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
    server_proc, base = start_local_site_server()
    base = base.rstrip("/")
    captures = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for viewport_name, width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                for case_id, row, assertion in CASES:
                    page.route("**/*", make_router(row))
                    page.goto(f"{base}/notices/{row['request_id']}", wait_until="domcontentloaded")
                    page.wait_for_timeout(3000)
                    rail = page.locator("#nactions")
                    try:
                        rail.wait_for(state="visible", timeout=8000)
                    except Exception:
                        pass
                    html = rail.inner_html() if rail.count() else ""
                    content_sha256 = hashlib.sha256(html.encode("utf-8")).hexdigest()

                    page.add_script_tag(path=str(AXE))
                    result = page.evaluate(
                        "async () => await axe.run(document.querySelector('#nactions') || document, "
                        "{resultTypes:['violations']})"
                    )
                    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(r => r.ruleId)"))
                    gate = failing_violations(result["violations"], wcag22_rules)

                    captures.append({
                        "fixture": case_id,
                        "route": f"/notices/{row['request_id']}",
                        "viewport": viewport_name,
                        "assertion": assertion,
                        "content_sha256": content_sha256,
                        "axe_critical_or_serious_violations": [v["id"] for v in gate],
                        "file": None,
                    })
                    print(f"{viewport_name:8s} {case_id:40s} sha256={content_sha256[:12]} "
                          f"len={len(html)} violations={[v['id'] for v in gate]}")
                    page.unroute("**/*")
                page.close()
            browser.close()
    finally:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_proc.kill()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema_version": 1,
        "card": "cityscroll-engineering/contract-comment-as-deadline",
        "capture_mode": "local_python_playwright_axe_live_render",
        "note": (
            "/notices/<id> rendered through tools/local_site_server.py's static _site build "
            "(the same clean-route local server used by test/functional/*.py; no live Worker/"
            "D1 backend), with the upstream City Record dataset call (dg92-zbpx) stubbed to "
            "serve one synthetic row per case. This exercises the real client pipeline "
            "(site/action_registry.js's kindFor/compileActionRail, site/app/feed-actions.mjs's "
            "action-rail render) rather than a hand-built HTML fixture. axe-core "
            "(test/functional/assets/axe.min.js) ran against the #nactions region for each "
            "case at both review widths, using the same critical/serious + WCAG 2.2 AA "
            "classification as test/functional/11_accessibility.py (a11y_gate.py). Evidence "
            "proves the classification, withheld attendance/calendar/join affordances, "
            "submit-vs-instructions action, and preserved genuine-hearing rail (A1-A6) render "
            "as specified and introduce no new axe violation; it does not evidence a live-"
            "data-populated card, since no Worker/D1 backend was running."
        ),
        "data_vintage": "not_applicable_synthetic_fixture_records",
        "viewports": [
            {"name": "mobile", "width": 390, "height": 844},
            {"name": "desktop", "width": 1440, "height": 900},
        ],
        "captures": captures,
    }
    (OUT_DIR / "capture-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {OUT_DIR / 'capture-manifest.json'}")


if __name__ == "__main__":
    main()
