"""Wave 7 (w7-03): focus-visibility keyboard-walk guard.

The audit's worst finding — a focus ring coded in CSS but suppressed at render — is invisible
to axe (axe checks markup, not computed :focus-visible styles). Only a keyboard probe catches
it. Tabs through the first ~15 first-party focusable elements on index.html and asserts each has a
computed, visible focus indicator per WCAG 2.2 SC 2.4.7 / 2.4.13. Static companion:
test/standards/outline_guard.py.

Cloudflare Turnstile injects its own focusable hosts (often bare DIVs) whose outline the product
does not own. Block that third-party script for a hermetic walk, and also skip any host still
matched as a captcha widget if one slips through.
"""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
N_STOPS = 15
MIN_OUTLINE_WIDTH = 2.0

# Third-party / captcha hosts we do not style and must not fail the product gate on.
THIRD_PARTY_SELECTOR = (
    ".cf-turnstile, .home-cta-turnstile, iframe, [data-turnstile], "
    "[name^='cf-'], [id^='cf-'], [id^='turnstile']"
)


def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def has_visible_focus_indicator(info):
    # Browser-native focus ring (no author CSS): outline-style auto still paints a ring.
    if info["outlineStyle"] == "auto":
        return True
    if info["outlineStyle"] not in ("none", ""):
        try:
            width = float(info["outlineWidth"].replace("px", ""))
        except ValueError:
            width = 0
        if width >= MIN_OUTLINE_WIDTH:
            return True
    # Fallback: a non-outline visible indicator (e.g. box-shadow ring) also satisfies 2.4.7.
    return info["boxShadow"] not in ("none", "")


def describe(info):
    return f"{info['tag']}#{info['id']}.{info['cls']}".replace(" ", ".")


def block_third_party(route):
    route.abort()


failures = []
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
    # Keep the walk first-party: Turnstile load is async and racy on CI runners.
    page.route("**/*challenges.cloudflare.com/**", block_third_party)
    page.route("**/*turnstile*", block_third_party)
    page.goto(BASE, timeout=30000)
    page.wait_for_load_state("load")
    page.wait_for_timeout(500)

    # Skip link must be first-focusable and its target must exist.
    page.keyboard.press("Tab")
    first = page.evaluate("""() => {
        const el = document.activeElement;
        return {tag: el.tagName, cls: el.className, href: el.getAttribute("href")};
    }""")
    if "skip" not in (first["cls"] or ""):
        failures.append(f"first focusable element is not the skip link: {first}")
    else:
        target = (first["href"] or "").lstrip("#")
        if not target or page.locator(f"#{target}").count() == 0:
            failures.append(f"skip link target {first['href']!r} does not exist in the DOM")
        else:
            step("OK", "skip link", f"first-focusable, targets existing #{target}")

    checked = 0
    skipped_third_party = 0
    for i in range(1, N_STOPS + 8):
        if checked >= N_STOPS - 1:
            break
        page.keyboard.press("Tab")
        info = page.evaluate(
            """(thirdSel) => {
            const el = document.activeElement;
            if (!el || el === document.body) {
                return {tag: "BODY", id: "", cls: "", outlineStyle: "none",
                        outlineWidth: "0px", boxShadow: "none", thirdParty: false};
            }
            const cs = getComputedStyle(el);
            const thirdParty = !!(el.closest && el.closest(thirdSel));
            return {
                tag: el.tagName,
                id: el.id || "",
                cls: typeof el.className === "string" ? el.className : "",
                outlineStyle: cs.outlineStyle,
                outlineWidth: cs.outlineWidth,
                boxShadow: cs.boxShadow,
                thirdParty,
            };
        }""",
            THIRD_PARTY_SELECTOR,
        )
        if info["tag"] == "BODY":
            break
        if info.get("thirdParty"):
            skipped_third_party += 1
            continue
        checked += 1
        if not has_visible_focus_indicator(info):
            failures.append(
                f"stop {checked}: {describe(info)} has no visible focus indicator "
                f"(outline-style={info['outlineStyle']!r} width={info['outlineWidth']!r} "
                f"box-shadow={info['boxShadow']!r})"
            )
    if skipped_third_party:
        step("OK", "skipped third-party focus hosts", f"{skipped_third_party} stop(s)")
    if not any("stop" in f for f in failures):
        step("OK", "focus-visible walk", f"{checked} first-party stop(s), all have a visible indicator")
    browser.close()

assert not failures, f"focus-visibility gate: {len(failures)} failure(s): {failures}"
print("✅ focus-visibility gate green")
