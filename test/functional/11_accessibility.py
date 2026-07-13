"""Wave 6 (w6-02) + wave 7 (w7-02) + wave 9 (w9-01/w9-09): axe-core accessibility gate.

Runs the vendored axe-core (test/functional/assets/axe.min.js — no network dependency)
against each page and FAILS on any violation of impact 'critical' or 'serious', PLUS any
violation of a rule in RATCHET_RULES regardless of impact (see below). 'moderate'/'minor'
findings are otherwise printed as evidence but don't fail (ratchet later). Automated checks
catch the structural subset only (~30-60% of WCAG) — the manual keyboard walkthrough
remains a per-wave practice (see internal reviews, Kalbag ch.6).

w7-02 (dynamic-state coverage): axe only sees markup that's actually in the accessibility
tree — display:none content (every inactive .tabpane) is invisible to it. So for index.html
we don't stop at the load state: we ACTIVATE each of the seven .tabbtn tabs in turn and
re-run axe after each, catching violations (like unlabeled fields) that only exist once a
panel is shown.

w9-09: the full audit (data/crol-a11y-full-q9) found its only two real failures — the
critical #invname label and the serious .pin contrast — in states this file didn't drive
at all: digest preview, notice detail, entity profiles, and the investigation workspace,
in both languages. This gate now runs hermetically against the fixture dataset
(test/functional/assets/i18n_fixtures.py, shared with the stray-English guard) so those
states are reachable deterministically, and drives all of them, once in English and once
in Spanish (the two axe failures this audit found were language-independent, but a future
one might not be).

w9-01: RATCHET_RULES guards the landmark-one-main/region fix — every page now has exactly
one <main> and skip links/footers exist where footer content does; these rule ids fail
the gate at ANY impact level (they're axe 'moderate' by default) so a regression is caught.
"""
import json
import os
import pathlib
import sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
AXE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "axe.min.js")

PAGES = ["about.html", "data.html", "stats.html", "changelog.html", "api.html"]
FAIL_IMPACTS = {"critical", "serious"}
# w9-01: landmark-one-main/region were standing moderate findings (no <main>, no <footer>
# landmark) on every page. Now that every page has both, ratchet these specific rule ids
# into the failing set regardless of impact, so the fix stays guarded even though the rule
# itself is only ever "moderate" impact in axe-core.
RATCHET_RULES = {"landmark-one-main", "region"}
TABS = ["people", "land", "property", "rules", "meetings", "alerts"]  # money is active on load
LANGS = ["en", "es"]


def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def workspace_seed():
    """A pinned investigation item, exactly as the app stores it — same recipe as the
    stray-English guard's workspace_seed(), so the investigation/share-error states render."""
    return {"current": "inv1", "invs": {"inv1": {
        "name": "My investigation", "created": "2026-07-10",
        "items": [{"t": "agency", "id": "Housing Preservation and Development",
                   "title": "Housing Preservation and Development (HPD)",
                   "meta": "agency profile", "note": "", "added": "2026-07-12"}]}}}


def run_axe(page, state_name, failures):
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    gate = [v for v in result["violations"] if v.get("impact") in FAIL_IMPACTS or v["id"] in RATCHET_RULES]
    info = [v for v in result["violations"] if v not in gate]
    for v in gate:
        nodes = "; ".join(n["target"][0] for n in v["nodes"][:3])
        step("FAIL", f"{state_name}: {v['id']} ({v['impact']})", f"{v['help']} @ {nodes}")
        failures.append((state_name, v["id"]))
    for v in info:
        step("info", f"{state_name}: {v['id']} ({v.get('impact')})", f"{len(v['nodes'])} node(s)")
    if not gate:
        step("OK", f"{state_name}: no critical/serious axe violations",
             f"{len(info)} lesser finding(s) noted")


def run_index_states(pw, lang, failures):
    browser = pw.chromium.launch()
    ctx = browser.new_context()
    ctx.add_init_script(
        f"localStorage.setItem('crd_invs_v1', JSON.stringify({json.dumps(workspace_seed())}))")
    page = ctx.new_page()
    install_routes(page)
    page.goto(BASE, timeout=30000)
    page.wait_for_load_state("load", timeout=20000)
    page.wait_for_timeout(1200)
    page.add_script_tag(path=AXE)

    if lang != "en":
        page.click(f'#langSwitcher .lang-btn[data-lang="{lang}"]')
        page.wait_for_timeout(800)

    run_axe(page, f"index.html [{lang}] [load:money]", failures)

    for tab in TABS:
        page.click(f'.tabbtn[data-tab="{tab}"]')
        page.wait_for_timeout(900 if tab == "land" else 400)
        run_axe(page, f"index.html [{lang}] [tab:{tab}]", failures)

    # digest preview (alerts tab is already active from the loop above)
    page.click("#apreview")
    page.wait_for_timeout(1200)
    run_axe(page, f"index.html [{lang}] [alerts:digest-preview]", failures)

    # notice detail: money tab, click the first fixture row (renderList also auto-clicks
    # it on load, but an explicit click keeps this state independent of that behavior)
    page.click('.tabbtn[data-tab="money"]')
    page.wait_for_timeout(400)
    page.click("#list .row")
    page.wait_for_timeout(600)
    run_axe(page, f"index.html [{lang}] [money:notice-detail]", failures)

    # entity profile via permalink hash
    page.evaluate("location.hash = '#agency/Housing Preservation and Development'")
    page.wait_for_timeout(1000)
    run_axe(page, f"index.html [{lang}] [entity:agency]", failures)

    # investigation workspace (seeded above) + its share-error path (worker is stubbed dead)
    page.evaluate("location.hash = '#investigation'")
    page.wait_for_timeout(800)
    run_axe(page, f"index.html [{lang}] [investigation]", failures)
    page.click("#invshare")
    page.wait_for_timeout(1200)
    run_axe(page, f"index.html [{lang}] [investigation:share-error]", failures)

    browser.close()


def run_subpage(pw, path, failures):
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
    install_routes(page)
    page.goto(BASE + path, timeout=30000)
    page.wait_for_load_state("load", timeout=20000)
    page.wait_for_timeout(1000)
    page.add_script_tag(path=AXE)
    run_axe(page, f"{path} [load]", failures)
    browser.close()


failures = []
with sync_playwright() as pw:
    for lang in LANGS:
        run_index_states(pw, lang, failures)
    for path in PAGES:
        run_subpage(pw, path, failures)

assert not failures, f"axe gate: {len(failures)} critical/serious violation(s): {failures}"
print("✅ axe gate green on all pages + activated tab states + dynamic states (en+es)")
