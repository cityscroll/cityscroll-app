"""Wave 6 (w6-04): the language switcher, end to end — PR #9's manual checklist as a spec.

Verifies: switcher present with native labels; switching to Español translates UI chrome,
shows the "notices remain in English" banner, flips document lang, persists via localStorage
across reload; notice-content containers keep translate="no"; switching back restores English.
"""
import os
import re
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
_ARGS = ["--host-resolver-rules=MAP api.cityscroll.org " + os.environ["CROL_DNS_IP"]] if os.environ.get("CROL_DNS_IP") else []

def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=_ARGS)
    page = browser.new_context().new_page()
    page.goto(BASE, timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1000)

    # Compact language dropdown: native labels, English selected by default.
    sel = page.locator("#langSelect")
    assert sel.count(), "language dropdown #langSelect must exist"
    assert sel.input_value() == "en", "English should be selected by default"
    opts = page.evaluate("""() => [...document.querySelectorAll('#langSelect option')].map(o => ({v:o.value, t:o.textContent.trim()}))""")
    es_opt = next((o for o in opts if o["v"] == "es"), None)
    assert es_opt and "Español" in es_opt["t"], "native-language label required (USWDS pattern)"
    step("OK", "switcher renders", f"English active, {len(opts)} locales")

    money_tab_en = page.locator('[data-i18n="tab_money"]').first.inner_text()
    assert money_tab_en.strip().lower() == "contracts", f"expected English chrome, got {money_tab_en!r}"  # CSS uppercases tabs

    # Switch to Spanish.
    page.select_option("#langSelect", "es")
    page.wait_for_timeout(400)
    assert sel.input_value() == "es", "Español should now be selected"
    money_tab_es = page.locator('[data-i18n="tab_money"]').first.inner_text()
    assert money_tab_es.strip().lower() != "money", "chrome must translate on switch"
    step("OK", "chrome translates", f"tab_money: {money_tab_en!r} -> {money_tab_es!r}")

    assert page.evaluate("document.documentElement.lang") == "es", "document lang must follow"
    banner = page.locator("#langNotice")
    assert banner.is_visible(), "the 'notices remain in English' banner must show for es"
    step("OK", "lang attribute + honesty banner", banner.inner_text()[:60])

    # Notice content stays untranslatable by the browser.
    n = page.locator('[translate="no"]').count()
    assert n >= 5, f"notice-content containers must carry translate=no (found {n})"
    step("OK", "notice content protected", f"{n} translate=no containers")

    # Persistence across reload.
    assert page.evaluate("localStorage.getItem('crol_lang')") in ("es", '"es"'), "preference must persist"
    page.reload()
    page.wait_for_load_state("load")
    page.wait_for_timeout(800)
    assert page.locator('[data-i18n="tab_money"]').first.inner_text().strip() == money_tab_es.strip(), "es must survive reload"
    step("OK", "persists across reload")

    # Generalized raw-key gate (2026-07-11 incident): no visible chrome text may be a
    # bare snake_case key — catches missing keys AND dynamically-constructed t() names
    # the static i18n_refs gate can't see. Notice content (translate="no") is excluded
    # because real City Record PINs are key-shaped.
    raw_key_re = re.compile(r"\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b")
    def assert_no_raw_i18n_keys(page_obj, label):
        rendered = page_obj.evaluate("""() => {
          const out = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const parent = node.parentElement;
            if (!parent || parent.closest('[translate="no"],script,style')) continue;
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const text = node.textContent.trim();
            if (text) out.push(text);
          }
          return out;
        }""")
        raw = sorted({match.group(0) for text in rendered for match in raw_key_re.finditer(text)})
        assert not raw, f"raw i18n keys visible in {label}: {raw}"

    for tag in ("es", "en"):
        page.select_option("#langSelect", tag)
        page.wait_for_timeout(400)
        chrome_text = page.evaluate("""() => {
          const out = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const n = walker.currentNode;
            if (n.parentElement && n.parentElement.closest('[translate="no"],script,style')) continue;
            const t = n.textContent.trim();
            if (t) out.push(t);
          }
          return out;
        }""")
        raw = sorted({match.group(0) for text in chrome_text for match in raw_key_re.finditer(text)})
        assert not raw, f"raw i18n keys visible in {tag} mode: {raw}"
        assert_no_raw_i18n_keys(page, f"{tag} mode")
        step("OK", f"no raw keys visible ({tag})")

    # And back to English.
    page.select_option("#langSelect", "en")
    page.wait_for_timeout(400)
    assert page.locator('[data-i18n="tab_money"]').first.inner_text().strip().lower() == "contracts"
    assert page.evaluate("document.documentElement.lang") == "en"
    step("OK", "switches back to English")

    # ===== COVERAGE GATE: residual-English sentinel check =====
    # Switch back to Spanish for the coverage check.
    page.select_option("#langSelect", "es")
    page.wait_for_timeout(500)

    # Collect visible text OUTSIDE translate="no" containers.
    # We query all text nodes that are visible and NOT inside a translate="no" element.
    page_text = page.evaluate("""() => {
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    const el = node.parentElement;
                    if (!el) return NodeFilter.FILTER_REJECT;
                    // Skip hidden elements
                    const s = window.getComputedStyle(el);
                    if (s.display === 'none' || s.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
                    // Skip translate=no subtrees
                    let p = el;
                    while (p && p !== document.body) {
                        if (p.getAttribute && p.getAttribute('translate') === 'no') return NodeFilter.FILTER_REJECT;
                        p = p.parentElement;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );
        const parts = [];
        let node;
        while ((node = walker.nextNode())) {
            const txt = node.textContent.trim();
            if (txt) parts.push(txt);
        }
        return parts.join(' ');
    }""")

    # Sentinel strings that must NOT appear in the translated UI chrome.
    # These are high-visibility English strings that should be translated in es mode.
    SENTINELS = [
    "Look up someone named", "My investigation", "All agencies", "searches the City Record Open Data",
        "Pick a role",
        "Try a title like",
        "describe what you",
        "No account",
        "Build an alert",
        "More ways to watch",
        "Watch for",
        "Email address",
        "Frequency",
        "Preview today",
        "Subscribe",
        "Get your digest",
        "Follow CityScroll",
        "Pick what to follow",
        "Manage existing alerts",
        "What should we watch",
        "Narrow it",
        "How often",
        "Quick suggestions",
    ]
    failed_sentinels = [s for s in SENTINELS if s.lower() in page_text.lower()]
    if failed_sentinels:
        step("FAIL", "residual English sentinels found", str(failed_sentinels))
        raise AssertionError(f"English sentinels still visible in es mode: {failed_sentinels}")
    step("OK", "residual-English sentinel check passed", f"{len(SENTINELS)} sentinels absent")

    # Coverage stat: count data-i18n elements vs total visible text-bearing elements.
    coverage = page.evaluate("""() => {
        const i18n = document.querySelectorAll('[data-i18n]').length;
        const placeholder = document.querySelectorAll('[data-i18n-placeholder]').length;
        return {i18n, placeholder, total: i18n + placeholder};
    }""")
    step("STAT", "i18n coverage",
         f"data-i18n: {coverage['i18n']}, data-i18n-placeholder: {coverage['placeholder']}, total: {coverage['total']}")

    # Shared-link fidelity: an explicit URL language wins for this visit without replacing the
    # device preference. The reported field-case notice is fulfilled locally so this remains a
    # deterministic PR gate with no production-origin dependency.
    shared = browser.new_context()
    shared.add_init_script("""
      localStorage.setItem('crol_lang', 'ru');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText(value) { window.__copiedLanguageUrl = value; return Promise.resolve(); }
      }});
    """)
    linked = shared.new_page()
    fixture = [{
        "request_id": "20260716022",
        "short_title": "Public Hearing",
        "type_of_notice_description": "Public Hearings and Meetings",
        "section_name": "Public Hearings and Meetings",
        "agency_name": "City Council",
        "start_date": "2026-07-16T00:00:00.000",
        "additional_description_1": "A public hearing notice used for shared-link testing.",
    }]
    linked.route("https://data.cityofnewyork.us/resource/dg92-zbpx.json*",
                 lambda route: route.fulfill(status=200, content_type="application/json", body=__import__("json").dumps(fixture)))
    linked.route("**/attachment-metadata*",
                 lambda route: route.fulfill(status=200, content_type="application/json", body='{"attachments":[]}'))
    linked.goto(BASE.rstrip("/") + "/?lang=es#notice/20260716022", timeout=30000)
    linked.wait_for_selector("#ncopy", state="visible", timeout=10000)
    assert linked.locator("#langSelect").input_value() == "es"
    assert linked.evaluate("document.documentElement.lang") == "es"
    assert linked.locator('[data-i18n="tab_money"]').first.inner_text().strip().lower() != "contracts"
    assert linked.evaluate("localStorage.getItem('crol_lang')") == "ru", "URL override must not replace the saved preference"

    linked.locator("#ncopy").click()
    copied = linked.evaluate("window.__copiedLanguageUrl")
    assert "/notices/20260716022?lang=es" in copied, f"notice copy link lost language: {copied}"

    linked.select_option("#langSelect", "fr")
    linked.wait_for_timeout(300)
    assert linked.evaluate("new URL(location.href).searchParams.get('lang')") == "fr"
    assert linked.evaluate("localStorage.getItem('crol_lang')") == "fr", "picker interaction must persist"
    linked.select_option("#langSelect", "en")
    assert linked.evaluate("new URL(location.href).searchParams.has('lang')") is False
    shared.close()
    step("OK", "shared notice language fidelity", "URL override, copy link, preference, replaceState")

    browser.close()

print("✅ language switcher spec green")
