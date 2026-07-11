"""Wave 6 (w6-02): axe-core accessibility gate over the public pages.

Runs the vendored axe-core (test/functional/assets/axe.min.js — no network dependency)
against each page and FAILS on any violation of impact 'critical' or 'serious'.
'moderate'/'minor' findings are printed as evidence but don't fail (ratchet later).
Automated checks catch the structural subset only (~30-60% of WCAG) — the manual
keyboard walkthrough remains a per-wave practice (see internal reviews, Kalbag ch.6).
"""
import json
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
_ARGS = ["--host-resolver-rules=MAP api.crol-list.org " + os.environ["CROL_DNS_IP"]] if os.environ.get("CROL_DNS_IP") else []
AXE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "axe.min.js")

PAGES = ["", "about.html", "data.html", "stats.html", "changelog.html", "api.html"]
FAIL_IMPACTS = {"critical", "serious"}

def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)

failures = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(args=_ARGS)
    page = browser.new_context().new_page()
    for path in PAGES:
        page.goto(BASE + path, timeout=30000)
        page.wait_for_load_state("load", timeout=20000)
        page.wait_for_timeout(1500)  # settle: these pages keep live API traffic, networkidle never fires
        page.add_script_tag(path=AXE)
        result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
        name = path or "index.html"
        gate = [v for v in result["violations"] if v.get("impact") in FAIL_IMPACTS]
        info = [v for v in result["violations"] if v.get("impact") not in FAIL_IMPACTS]
        for v in gate:
            nodes = "; ".join(n["target"][0] for n in v["nodes"][:3])
            step("FAIL", f"{name}: {v['id']} ({v['impact']})", f"{v['help']} @ {nodes}")
            failures.append((name, v["id"]))
        for v in info:
            step("info", f"{name}: {v['id']} ({v.get('impact')})", f"{len(v['nodes'])} node(s)")
        if not gate:
            step("OK", f"{name}: no critical/serious axe violations",
                 f"{len(info)} lesser finding(s) noted")
    browser.close()

assert not failures, f"axe gate: {len(failures)} critical/serious violation(s): {failures}"
print("✅ axe gate green on all pages")
