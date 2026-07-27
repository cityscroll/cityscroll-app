"""Wave 6 (w6-02) + wave 7 (w7-02) + wave 9 (w9-01/w9-09) + WCAG 2.2:
axe-core accessibility gate.

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

WCAG 2.2: axe-core 4.10.2 maps its automated 2.2 AA coverage to the `wcag22aa` tag
(currently `target-size`). Every rule carrying that tag fails at any impact, and the
complete state matrix runs at both the 390px and 1440px review widths. A DOM exposure
probe supplements axe for 2.4.11 by focusing each rendered control and verifying that at
least part of it remains topmost rather than entirely hidden by author-created content.
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

PAGES = ["about.html", "data.html", "stats.html", "changelog.html", "api.html", "standards.html"]
FAIL_IMPACTS = {"critical", "serious"}
# w9-01: landmark-one-main/region were standing moderate findings (no <main>, no <footer>
# landmark) on every page. Now that every page has both, ratchet these specific rule ids
# into the failing set regardless of impact, so the fix stays guarded even though the rule
# itself is only ever "moderate" impact in axe-core.
# w10-04: heading-order (NYC Web Content Style Guide — heading levels "should not be
# skipped") is also axe 'moderate', so without a ratchet entry it's invisible to the gate.
RATCHET_RULES = {"landmark-one-main", "region", "heading-order"}
TABS = ["people", "land", "property", "rules", "meetings", "alerts"]  # money is active on load
LANGS = ["en", "es"]
VIEWPORTS = [(390, 844), (1440, 900)]


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
    wcag22_rules = set(page.evaluate(
        "() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"
    ))
    if "target-size" not in wcag22_rules:
        failures.append((state_name, "wcag22aa-ruleset-missing"))
        step("FAIL", f"{state_name}: wcag22aa ruleset missing",
             "vendored axe no longer exposes target-size under the WCAG 2.2 AA tag")
    gate = [
        v for v in result["violations"]
        if v.get("impact") in FAIL_IMPACTS
        or v["id"] in RATCHET_RULES
        or v["id"] in wcag22_rules
    ]
    info = [v for v in result["violations"] if v not in gate]
    for v in gate:
        nodes = "; ".join(n["target"][0] for n in v["nodes"][:3])
        step("FAIL", f"{state_name}: {v['id']} ({v['impact']})", f"{v['help']} @ {nodes}")
        failures.append((state_name, v["id"]))
    for v in info:
        step("info", f"{state_name}: {v['id']} ({v.get('impact')})", f"{len(v['nodes'])} node(s)")
    if not gate:
        step("OK", f"{state_name}: no critical/serious axe violations",
             f"{len(info)} lesser finding(s) noted; wcag22aa={sorted(wcag22_rules)}")


def run_focus_exposure(page, state_name, failures):
    """Approximate the SC 2.4.11 keyboard check across every rendered focus target."""
    hidden = page.evaluate(
        """() => {
          const selector = [
            'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
            'select:not([disabled])', 'textarea:not([disabled])', 'summary',
            '[tabindex]:not([tabindex="-1"])'
          ].join(',');
          const rendered = el => {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const closed = el.closest('details:not([open])');
            if (closed && !closed.querySelector('summary')?.contains(el)) return false;
            return style.display !== 'none' && style.visibility !== 'hidden'
              && rect.width > 0 && rect.height > 0;
          };
          const exposedAt = (el, x, y) => {
            const top = document.elementFromPoint(x, y);
            return top === el || (top && el.contains(top));
          };
          const findings = [];
          for (const el of [...document.querySelectorAll(selector)].filter(rendered)) {
            el.focus({preventScroll:false});
            let exposed = false;
            for (const rect of el.getClientRects()) {
              const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
              const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
              if (right <= left || bottom <= top) continue;
              const xs = [left + 1, (left + right) / 2, right - 1];
              const ys = [top + 1, (top + bottom) / 2, bottom - 1];
              if (xs.some(x => ys.some(y => exposedAt(el, x, y)))) {
                exposed = true;
                break;
              }
            }
            if (!exposed) {
              findings.push({
                tag: el.tagName,
                id: el.id,
                cls: String(el.className || '').slice(0, 80),
                text: String(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 80)
              });
            }
          }
          return findings;
        }"""
    )
    for item in hidden:
        detail = f"{item['tag']}#{item['id']}.{item['cls']} {item['text']!r}"
        step("FAIL", f"{state_name}: focus entirely obscured", detail)
        failures.append((state_name, "focus-not-obscured", detail))
    if not hidden:
        step("OK", f"{state_name}: focus not obscured", "all rendered focus targets exposed")


def run_index_states(pw, lang, viewport, failures):
    browser = pw.chromium.launch()
    width, height = viewport
    viewport_name = f"{width}x{height}"
    ctx = browser.new_context(viewport={"width": width, "height": height})
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

    state = f"index.html [{lang}] [{viewport_name}] [load:money]"
    run_axe(page, state, failures)
    run_focus_exposure(page, state, failures)

    for tab in TABS:
        page.click(f'.tabbtn[data-tab="{tab}"]')
        page.wait_for_timeout(900 if tab == "land" else 400)
        # The fixture deliberately blocks the Leaflet CDN. Expose the app-owned directional
        # controls anyway so axe measures their 32px targets at both responsive widths.
        if tab == "land" and page.locator("#landpan").count():
            page.locator("#landpan").evaluate("el => el.hidden = false")
        state = f"index.html [{lang}] [{viewport_name}] [tab:{tab}]"
        run_axe(page, state, failures)
        run_focus_exposure(page, state, failures)

    # digest preview (alerts tab is already active from the loop above)
    page.click("#apreview")
    page.wait_for_timeout(1200)
    run_axe(page, f"index.html [{lang}] [{viewport_name}] [alerts:digest-preview]", failures)

    # notice detail: money tab, click the first fixture row (renderList also auto-clicks
    # it on load, but an explicit click keeps this state independent of that behavior)
    page.click('.tabbtn[data-tab="money"]')
    page.wait_for_timeout(400)
    page.click("#list .row")
    page.wait_for_timeout(600)
    run_axe(page, f"index.html [{lang}] [{viewport_name}] [money:notice-detail]", failures)

    # entity profile via permalink hash
    page.evaluate("location.hash = '#agency/Housing Preservation and Development'")
    page.wait_for_timeout(1000)
    run_axe(page, f"index.html [{lang}] [{viewport_name}] [entity:agency]", failures)

    # investigation workspace (seeded above) + its share-error path (worker is stubbed dead)
    page.evaluate("location.hash = '#investigation'")
    page.wait_for_timeout(800)
    run_axe(page, f"index.html [{lang}] [{viewport_name}] [investigation]", failures)
    page.click("#invshare")
    page.wait_for_timeout(1200)
    run_axe(page, f"index.html [{lang}] [{viewport_name}] [investigation:share-error]", failures)

    browser.close()


def run_subpage(pw, path, viewport, failures):
    browser = pw.chromium.launch()
    width, height = viewport
    viewport_name = f"{width}x{height}"
    page = browser.new_context(viewport={"width": width, "height": height}).new_page()
    install_routes(page)
    page.goto(BASE + path, timeout=30000)
    page.wait_for_load_state("load", timeout=20000)
    page.wait_for_timeout(1000)
    page.add_script_tag(path=AXE)
    state = f"{path} [{viewport_name}] [load]"
    run_axe(page, state, failures)
    run_focus_exposure(page, state, failures)
    browser.close()


failures = []
with sync_playwright() as pw:
    for viewport in VIEWPORTS:
        for lang in LANGS:
            run_index_states(pw, lang, viewport, failures)
        for path in PAGES:
            run_subpage(pw, path, viewport, failures)

assert not failures, f"axe gate: {len(failures)} critical/serious violation(s): {failures}"
print("✅ axe gate green on all pages + activated tab states + dynamic states (en+es)")
