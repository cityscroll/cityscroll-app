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
we don't stop at the load state: we ACTIVATE each source .tabbtn tab in turn and
re-run axe after each, catching violations (like unlabeled fields) that only exist once a
panel is shown.

Handoff shells (data.html, changelog.html) client-side location.replace to About/API.
Axe on those races mid-navigation ("Execution context was destroyed"); destinations are
already covered as about.html. Keep them out of PAGES (see #423). run_axe still retries
once on context-destroyed so an activated index state that navigates does not red the gate.

Following is a separate static-first page. It is scanned as a public content page at both
review widths; exact context-carry semantics are covered by the scope contract tests.

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

# Public content pages only. data.html and changelog.html are handoff shells that
# client-side location.replace to About/API; axe on those races mid-navigation
# ("Execution context was destroyed") and the destinations are already covered.
PAGES = ["about.html", "stats.html", "api.html", "standards.html", "near-you/index.html", "following/index.html"]  # Source: public site/ pages.
FAIL_IMPACTS = {"critical", "serious"}
# w9-01: landmark-one-main/region were standing moderate findings (no <main>, no <footer>
# landmark) on every page. Now that every page has both, ratchet these specific rule ids
# into the failing set regardless of impact, so the fix stays guarded even though the rule
# itself is only ever "moderate" impact in axe-core.
# w10-04: heading-order (NYC Web Content Style Guide — heading levels "should not be
# skipped") is also axe 'moderate', so without a ratchet entry it's invisible to the gate.
RATCHET_RULES = {"landmark-one-main", "region", "heading-order"}
# Property is a child of the Land group; Places is a compatibility document, not a top-level tab.
TABS = ["people", "land", "rules", "meetings", "exams"]  # money is active on load
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


def _is_context_destroyed(err):
    """Playwright raises when a client-side navigation tears down the page mid-evaluate."""
    msg = str(err)
    return (
        "Execution context was destroyed" in msg
        or "most likely because of a navigation" in msg
        or "Target closed" in msg
    )


def _ensure_axe(page):
    """Inject axe-core when missing (e.g. after a full navigation destroyed the prior tag)."""
    try:
        has_axe = page.evaluate("() => typeof axe !== 'undefined'")
    except Exception as err:
        if _is_context_destroyed(err):
            raise
        has_axe = False
    if not has_axe:
        page.add_script_tag(path=AXE)


def run_axe(page, state_name, failures, *, restore_url=None, restore_hash=None, retry=True):
    """Run axe on the current page state.

    When an activated state triggers client-side navigation, the next evaluate can
    fail with 'Execution context was destroyed'. Catch that, re-navigate once, and
    retry so a harness race does not red the accessibility gate.
    """
    try:
        _ensure_axe(page)
        result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
        wcag22_rules = set(page.evaluate(
            "() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"
        ))
    except Exception as err:
        if retry and _is_context_destroyed(err):
            step("warn", f"{state_name}: context destroyed during axe — re-goto and retry once",
                 str(err).split("\n")[0][:160])
            try:
                if restore_url:
                    page.goto(restore_url, timeout=30000)
                    page.wait_for_load_state("load", timeout=20000)
                    page.wait_for_timeout(800)
                    if restore_hash is not None:
                        page.evaluate("(hash) => { location.hash = hash; }", restore_hash)
                        page.wait_for_timeout(600)
                elif restore_hash is not None:
                    page.evaluate("(hash) => { location.hash = hash; }", restore_hash)
                    page.wait_for_timeout(800)
                else:
                    # Best-effort: reload current URL.
                    page.reload(timeout=30000)
                    page.wait_for_load_state("load", timeout=20000)
                    page.wait_for_timeout(800)
                _ensure_axe(page)
            except Exception as restore_err:
                step("FAIL", f"{state_name}: axe retry restore failed", str(restore_err).split("\n")[0][:160])
                failures.append((state_name, "axe-context-destroyed"))
                return
            return run_axe(
                page, state_name, failures,
                restore_url=restore_url, restore_hash=restore_hash, retry=False,
            )
        raise
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


def run_focus_exposure(page, state_name, failures, *, retry=True):
    """Approximate the SC 2.4.11 keyboard check across every rendered focus target."""
    try:
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
                // Skip legacy #alerts hash links because routing forwards them to Following
                // and would tear down this evaluate mid-loop. Following is scanned separately.
                const href = el.getAttribute('href') || '';
                if (href.startsWith('#alerts')) continue;
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
    except Exception as err:
        if retry and _is_context_destroyed(err):
            step("warn", f"{state_name}: context destroyed during focus probe — reload and retry once",
                 str(err).split("\n")[0][:160])
            try:
                page.reload(timeout=30000)
                page.wait_for_load_state("load", timeout=20000)
                page.wait_for_timeout(800)
                _ensure_axe(page)
            except Exception as restore_err:
                step("FAIL", f"{state_name}: focus-probe restore failed", str(restore_err).split("\n")[0][:160])
                failures.append((state_name, "focus-context-destroyed"))
                return
            return run_focus_exposure(page, state_name, failures, retry=False)
        raise
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
        page.select_option("#langSelect", lang)
        page.wait_for_timeout(800)

    state = f"index.html [{lang}] [{viewport_name}] [load:money]"
    run_axe(page, state, failures, restore_url=BASE)
    run_focus_exposure(page, state, failures)

    for tab in TABS:
        page.click(f'.tabbtn[data-tab="{tab}"]')
        page.wait_for_timeout(900 if tab == "land" else 400)
        # The fixture deliberately blocks the Leaflet CDN. Expose the app-owned directional
        # controls anyway so axe measures their 32px targets at both responsive widths.
        if tab == "land" and page.locator("#landpan").count():
            page.locator("#landpan").evaluate("el => el.hidden = false")
        state = f"index.html [{lang}] [{viewport_name}] [tab:{tab}]"
        run_axe(page, state, failures, restore_url=BASE)
        run_focus_exposure(page, state, failures)

    # notice detail: money tab, click the first fixture row (renderList also auto-clicks
    # it on load, but an explicit click keeps this state independent of that behavior)
    page.click('.tabbtn[data-tab="money"]')
    page.wait_for_timeout(400)
    page.click("#list .row")
    page.wait_for_timeout(600)
    run_axe(
        page, f"index.html [{lang}] [{viewport_name}] [money:notice-detail]", failures,
        restore_url=BASE,
    )

    # An unavailable optional read model leaves no reader-visible placeholder.
    project_row = {
        "project_id": "2022M0258", "project_name": "Timbale Terrace",
        "primary_applicant": "Housing Preservation and Development",
        "public_status": "Completed", "project_status": "Completed",
        "borough": "Manhattan", "community_district": "M11",
        "actions": "HA; PQ", "current_milestone": "Project Completed",
        "current_milestone_date": "2024-03-13", "ulurp_numbers": "240046HAM; 240047PQM",
    }
    page.route(
        "https://data.cityofnewyork.us/resource/hgx4-8ukb.json*",
        lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps([project_row]),
        ),
    )
    unavailable_payload = {
        "ok": True,
        "sections": {"project_connections": {
            "schema_version": 1, "status": "unavailable", "reason": "read_model_unavailable",
        }},
        "record": {"project_id": "2022M0258"},
    }
    page.route(
        "**/zap-outcomes?id=2022M0258",
        lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(unavailable_payload),
        ),
    )
    project_hash = "#land/2022M0258"
    page.goto(BASE + project_hash, timeout=30000)
    page.wait_for_load_state("load", timeout=20000)
    page.wait_for_selector("#project-connections", state="attached", timeout=15000)
    page.wait_for_timeout(800)
    assert page.locator("#project-connections").inner_html().strip() == ""
    run_axe(
        page, f"index.html [{lang}] [{viewport_name}] [land:project-connections-omitted]", failures,
        restore_url=BASE, restore_hash=project_hash,
    )

    # Agency profile: legacy #agency/… hash forwards to the static constellation
    # document (/agencies/<id>/) when present — same as production edge. Prefer
    # the constellation markers; fall back to the interactive SPA entity shell
    # only when no static document is served (older local servers / missing page).
    agency_hash = "#agency/Housing Preservation and Development"
    page.evaluate("location.hash = '#agency/Housing Preservation and Development'")
    try:
        page.wait_for_selector(
            "[data-civic-object-kind='agency-constellation'] main, "
            "main[data-civic-object-kind='agency-constellation'], "
            "#entityview .agencybar",
            state="visible",
            timeout=15000,
        )
    except Exception:
        page.wait_for_selector("#entityview .agencybar", state="visible", timeout=5000)
    page.wait_for_selector("main", state="visible", timeout=15000)
    run_axe(
        page, f"index.html [{lang}] [{viewport_name}] [entity:agency]", failures,
        # Do not restore the #agency hash: it re-forwards into /agencies/<id>/ and
        # leaves the page off the SPA shell used by later investigation states.
        restore_url=BASE, restore_hash="#money",
    )
    # Ensure we are back on the SPA home document before investigation.
    page.goto(BASE, timeout=30000)
    page.wait_for_load_state("load", timeout=20000)

    # investigation workspace (seeded above) + its share-error path (worker is stubbed dead)
    page.evaluate("location.hash = '#investigation'")
    page.wait_for_selector("#invname", state="visible", timeout=15000)
    page.wait_for_selector("main", state="visible", timeout=15000)
    run_axe(
        page, f"index.html [{lang}] [{viewport_name}] [investigation]", failures,
        restore_url=BASE, restore_hash="#investigation",
    )
    page.click("#invshare")
    page.wait_for_timeout(1200)
    run_axe(
        page, f"index.html [{lang}] [{viewport_name}] [investigation:share-error]", failures,
        restore_url=BASE, restore_hash="#investigation",
    )

    # Task-first entry collections (precomputed local JSON; no live network).
    for task_hash, task_state in (
        ("#task/can-i-bid", "task:can-i-bid"),
        ("#task/what-will-change", "task:what-will-change"),
    ):
        page.evaluate("(hash) => { location.hash = hash; }", task_hash)
        page.wait_for_selector(".task-first .task-card", timeout=15000)
        page.wait_for_timeout(400)
        run_axe(
            page, f"index.html [{lang}] [{viewport_name}] [{task_state}]", failures,
            restore_url=BASE, restore_hash=task_hash,
        )
        run_focus_exposure(page, f"index.html [{lang}] [{viewport_name}] [{task_state}]", failures)

    # Additive time-and-action entry surface. Worker fixtures intentionally leave some
    # sources unavailable so this also covers its honest partial-coverage state.
    page.evaluate("location.hash = '#now'")
    page.wait_for_selector(".now-surface", timeout=15000)
    page.wait_for_timeout(400)
    run_axe(
        page, f"index.html [{lang}] [{viewport_name}] [now]", failures,
        restore_url=BASE, restore_hash="#now",
    )
    run_focus_exposure(page, f"index.html [{lang}] [{viewport_name}] [now]", failures)

    browser.close()


def run_subpage(pw, path, viewport, failures):
    browser = pw.chromium.launch()
    width, height = viewport
    viewport_name = f"{width}x{height}"
    page = browser.new_context(viewport={"width": width, "height": height}).new_page()
    install_routes(page)
    target = BASE + path
    page.goto(target, timeout=30000)
    page.wait_for_load_state("load", timeout=20000)
    # Retired handoff pages use location.replace after parse.
    # Give the redirect a beat, then axe the settled document.
    page.wait_for_timeout(1200)
    try:
        page.wait_for_load_state("domcontentloaded", timeout=10000)
    except Exception:
        pass
    page.add_script_tag(path=AXE)
    state = f"{path} [{viewport_name}] [load]"
    run_axe(page, state, failures, restore_url=target)
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
