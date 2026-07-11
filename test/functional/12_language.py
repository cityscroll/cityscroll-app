"""Wave 6 (w6-04): the language switcher, end to end — PR #9's manual checklist as a spec.

Verifies: switcher present with native labels; switching to Español translates UI chrome,
shows the "notices remain in English" banner, flips document lang, persists via localStorage
across reload; notice-content containers keep translate="no"; switching back restores English.
"""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
_ARGS = ["--host-resolver-rules=MAP api.crol-list.org " + os.environ["CROL_DNS_IP"]] if os.environ.get("CROL_DNS_IP") else []

def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=_ARGS)
    page = browser.new_context().new_page()
    page.goto(BASE, timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(1000)

    # Switcher exists, native labels, English pressed by default.
    en_btn = page.locator('#langSwitcher .lang-btn[data-lang="en"]')
    es_btn = page.locator('#langSwitcher .lang-btn[data-lang="es"]')
    assert en_btn.get_attribute("aria-pressed") == "true", "English should be active by default"
    assert "Español" in es_btn.inner_text(), "native-language label required (USWDS pattern)"
    step("OK", "switcher renders", "English active, native labels")

    money_tab_en = page.locator('[data-i18n="tab_money"]').first.inner_text()
    assert money_tab_en.strip().lower() == "money", f"expected English chrome, got {money_tab_en!r}"  # CSS uppercases tabs

    # Switch to Spanish.
    es_btn.click()
    page.wait_for_timeout(400)
    assert es_btn.get_attribute("aria-pressed") == "true", "Español should now be pressed"
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

    # And back to English.
    page.locator('#langSwitcher .lang-btn[data-lang="en"]').click()
    page.wait_for_timeout(400)
    assert page.locator('[data-i18n="tab_money"]').first.inner_text().strip().lower() == "money"
    assert page.evaluate("document.documentElement.lang") == "en"
    step("OK", "switches back to English")

    # ===== COVERAGE GATE: residual-English sentinel check =====
    # Switch back to Spanish for the coverage check.
    es_btn = page.locator('#langSwitcher .lang-btn[data-lang="es"]')
    es_btn.click()
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
        "Pick a role",
        "Try a title like",
        "describe what you",
        "No account",
        "Build an alert",
        "Watch for",
        "Email address",
        "Frequency",
        "Preview today",
        "Subscribe",
        "Get your digest",
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

    browser.close()

print("✅ language switcher spec green")
