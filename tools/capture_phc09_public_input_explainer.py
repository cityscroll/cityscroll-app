#!/usr/bin/env python3
"""PHC-09 evidence: open and close the one public-input explainer component at
both review widths, in each language state its section-level fallback produces,
and run axe-core against every rendered state.

No image is written or committed - see docs/evidence/public-input-consequence/
phc-09-compact-explainer/capture-manifest.json for the committed proof (route,
viewport, repository revision, data vintage, assertion and a content hash per
case), per the workstream's no-committed-image-binaries convention (spec.md).

  node tools/capture_phc09_public_input_explainer.mjs   # (invoked by this script)
  python3 tools/capture_phc09_public_input_explainer.py
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
TMP_DIR = ROOT / "site/.phc09-capture-tmp"
OUT_DIR = ROOT / "docs/evidence/public-input-consequence/phc-09-compact-explainer"

# How the product reaches this component. If the Meetings context stops
# carrying it, this capture fails rather than quietly evidencing an explainer
# the product no longer shows.
MOUNT_FIDELITY = (
    ("site/index.html", 'data-public-input-explainer-host="meetings-heading"'),
    ("site/app/boot.mjs", 'import("../public_input_explainer.mjs")'),
    ("site/app/boot.mjs", "mountPublicInputExplainerPanel();"),
)


def check_mount_fidelity() -> None:
    missing = [
        f"{path}: {marker}"
        for path, marker in MOUNT_FIDELITY
        if marker not in (ROOT / path).read_text(encoding="utf-8")
    ]
    if missing:
        raise SystemExit(
            "the product no longer reaches the explainer this capture evidences; "
            f"missing: {missing}"
        )


def start_local_site_server() -> tuple[subprocess.Popen, str]:
    ready_file = Path(tempfile.mktemp(prefix="crol-phc09-site-"))
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


def explainer_css() -> str:
    """The component's own rules, lifted from the page that ships them, so both
    presentations are measured as the product renders them."""
    html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
    sheet = re.search(
        r"@media\(max-width:680px\)\{\s*((?:\s*\.public-input-explainer[^{]*\{[^}]+\})+)\s*\}",
        html,
    )
    if not sheet:
        raise SystemExit("site/index.html no longer carries the narrow full-width sheet rules")
    # The width-independent rules are read from the page with every media block
    # removed, so the sheet rules cannot leak into the wide presentation and
    # make both widths compute the same box.
    outside_media = re.sub(r"@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}", "", html)
    rules = re.findall(r"(\.public-input-explainer[^{]*\{[^}]+\})", outside_media)
    root = (
        ":root{--rule:#d6d3cd;--oxblood:#7a1f2b;--muted:#5c5852;--ink:#1c1917;"
        "--ink-soft:#413d38;--paper:#f4f1ea;--paper-2:#f6f7f9;--font-display:Georgia,serif;}"
        "body{margin:16px;background:#f4f1ea;font:16px/1.4 ui-sans-serif,system-ui,sans-serif;}"
        "a{color:#174ea6}"
    )
    # The media block is re-emitted verbatim so the narrow width gets the sheet
    # presentation and the wide width does not.
    return root + "".join(rules) + "@media(max-width:680px){" + sheet.group(1) + "}"


FOCUS_TARGETS_JS = """
() => Array.from(
  document.querySelectorAll('main#main summary, main#main a[href], main#main button')
).map((el) => el.tagName.toLowerCase() + ':' + (el.textContent || '').trim().slice(0, 40))
"""


def main() -> None:
    check_mount_fidelity()
    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)
    generated = subprocess.run(
        [shutil.which("node") or "node", str(ROOT / "tools/capture_phc09_public_input_explainer.mjs")],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    cases = json.loads(generated.stdout)

    css = explainer_css()
    server_proc, base = start_local_site_server()
    base = base.rstrip("/")
    captures = []
    hashes_by_case: dict[str, set[str]] = {}
    focus_targets_by_case: dict[str, set[str]] = {}
    presentation_by_viewport: dict[str, set[str]] = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for viewport_name, width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                for case in cases:
                    fragment_html = page.request.get(f"{base}{case['path']}").text()
                    # Wrapped in the same <main id="main"> landmark the
                    # Meetings lens renders this component inside, so axe's
                    # landmark rules reflect a real page, not a bare fragment.
                    wrapped = (
                        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
                        f"<style>{css}</style></head><body><main id='main'>{fragment_html}</main></body></html>"
                    )
                    page.set_content(wrapped, wait_until="domcontentloaded")

                    summary = page.locator("main#main > details.public-input-explainer > summary")
                    if summary.count() != 1:
                        raise SystemExit(f"{case['id']}: expected exactly one explainer control")

                    # One action opens it, and reading position stays on the
                    # control that did it - which is also what returns focus
                    # when the same control closes it again.
                    summary.focus()
                    summary.press("Enter")
                    opened = page.evaluate(
                        "() => document.querySelector('details.public-input-explainer').open")
                    focus_on_open = page.evaluate(
                        "() => document.activeElement === "
                        "document.querySelector('details.public-input-explainer > summary')")
                    summary.press("Enter")
                    closed = not page.evaluate(
                        "() => document.querySelector('details.public-input-explainer').open")
                    focus_after_close = page.evaluate(
                        "() => document.activeElement === "
                        "document.querySelector('details.public-input-explainer > summary')")
                    if not (opened and closed and focus_on_open and focus_after_close):
                        raise SystemExit(
                            f"{case['id']} at {viewport_name}: the explainer must open and close on "
                            "one action and leave focus on the control that did it")

                    # Measured with the panel open, which is the state a reader
                    # judges the presentation in.
                    summary.press("Enter")
                    presentation = page.evaluate(
                        "() => { const el = document.querySelector('details.public-input-explainer');"
                        " const s = getComputedStyle(el);"
                        " return s.marginInlineStart + '|' + s.maxWidth + '|' + s.borderLeftWidth; }")
                    presentation_by_viewport.setdefault(viewport_name, set()).add(presentation)

                    main_html = page.locator("main#main").inner_html()
                    content_sha256 = hashlib.sha256(main_html.encode("utf-8")).hexdigest()
                    hashes_by_case.setdefault(case["id"], set()).add(content_sha256)
                    focus_targets = page.evaluate(FOCUS_TARGETS_JS)
                    focus_targets_by_case.setdefault(case["id"], set()).add(json.dumps(focus_targets))

                    page.add_script_tag(path=str(AXE))
                    result = page.evaluate(
                        "async () => await axe.run(document.querySelector('main#main') || document, "
                        "{resultTypes:['violations']})"
                    )
                    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(r => r.ruleId)"))
                    gate = failing_violations(result["violations"], wcag22_rules)

                    captures.append({
                        "fixture": case["id"],
                        "language_requested": case["lang"],
                        "section_languages": case["section_languages"],
                        "route": (
                            "publicInputExplainerHTML() rendered into the Meetings intro host "
                            f"(#meetings) — language:{case['lang']}"
                        ),
                        "viewport": viewport_name,
                        "assertion": case["assertion"],
                        "content_sha256": content_sha256,
                        "presentation": presentation,
                        "opens_in_one_action": True,
                        "focus_returns_to_invoking_control": True,
                        "focus_targets": focus_targets,
                        "axe_critical_or_serious_violations": [v["id"] for v in gate],
                        "file": None,
                    })
                    print(f"{viewport_name:8s} {case['id']:30s} sha256={content_sha256[:12]} "
                          f"presentation={presentation} violations={[v['id'] for v in gate]}")
                page.close()
            browser.close()
    finally:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_proc.kill()
        shutil.rmtree(TMP_DIR, ignore_errors=True)

    # One content component: the same case must hash identically at both
    # widths, and offer the same focus targets, or the inline and sheet
    # presentations are two renderings rather than one.
    for case_id, digests in hashes_by_case.items():
        if len(digests) != 1:
            raise SystemExit(f"{case_id}: the two widths rendered different markup")
    for case_id, targets in focus_targets_by_case.items():
        if len(targets) != 1:
            raise SystemExit(f"{case_id}: the two widths offered different focus targets")

    # Two presentations: the narrow sheet and the wide inline disclosure must
    # not compute the same box, or only one presentation is actually shipping.
    mobile = presentation_by_viewport.get("mobile", set())
    desktop = presentation_by_viewport.get("desktop", set())
    if not mobile or not desktop or mobile & desktop:
        raise SystemExit(
            f"the inline and sheet presentations did not differ: mobile={mobile} desktop={desktop}")

    # Every language state must be distinguishable from English except the two
    # that are meant to be English, which is the evidence that the fallback
    # runs whole sections rather than individual keys.
    english = hashes_by_case["english"]
    if hashes_by_case["untranslated_locale"] != english:
        raise SystemExit("a locale with no dictionary did not render exactly the English component")
    if hashes_by_case["translated_locale"] & english:
        raise SystemExit("the translated locale rendered identically to English")
    if hashes_by_case["partially_translated_locale"] & english:
        raise SystemExit("the partially translated locale fell all the way back to English")

    repository_revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema_version": 1,
        "card": "cityscroll-public-input-consequence/phc-09-compact-explainer-without-overpromising",
        "capture_mode": "local_node_playwright_axe_static_render",
        "repository_revision": repository_revision,
        "note": (
            "Each case renders site/public_input_explainer.mjs's publicInputExplainerHTML() "
            "directly via node, with no live Worker/D1 backend, and serves the fragment from "
            "site/ with the component's own /index.html CSS rules via tools/local_site_server.py. "
            "tools/capture_phc09_public_input_explainer.py checks that the Meetings intro still "
            "carries the explainer host and that site/app/boot.mjs still mounts it, so a later "
            "rewiring fails this capture rather than evidencing a component the product no "
            "longer shows. At each width the capture "
            "opens the explainer with one keypress on its own control, checks the browser left "
            "focus on that control, closes it with the same control, and checks focus is still "
            "there. The capture fails unless each case hashes identically at both widths and "
            "offers the same focus targets, which is the evidence that one component serves both "
            "presentations, and unless the two widths compute different boxes, which is the "
            "evidence that both presentations ship. It also fails unless the untranslated locale "
            "renders exactly the English component while the translated and partially translated "
            "locales do not, which is the evidence that fallback runs whole sections. axe-core "
            "(test/functional/assets/axe.min.js) ran against each rendered state at both review "
            "widths, using the same failing-violation classification as "
            "test/functional/11_accessibility.py (a11y_gate.py). It does not evidence a "
            "live-data-populated page, since no Worker/D1 backend was running."
        ),
        "data_vintage": (
            "committed site/i18n.js dictionary and its ten shipping language files at this "
            "revision, plus the official-source table in site/consequence_projection.mjs "
            "(PHC-00). This component reads no publisher record, so no publisher vintage "
            "applies to it."
        ),
        "viewports": [
            {"name": "mobile", "width": 390, "height": 844},
            {"name": "desktop", "width": 1440, "height": 900},
        ],
        "captures": captures,
        "accessibility": {
            "tool": "axe-core (test/functional/assets/axe.min.js)",
            "scope": "main#main",
            "viewports_checked": ["390x844", "1440x900"],
            "new_violations_introduced": sum(
                len(c["axe_critical_or_serious_violations"]) for c in captures),
            "pre_existing_violations_observed": [],
        },
    }
    (OUT_DIR / "capture-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {OUT_DIR / 'capture-manifest.json'}")


if __name__ == "__main__":
    main()
