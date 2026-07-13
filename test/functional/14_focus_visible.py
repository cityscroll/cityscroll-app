"""Wave 7 (w7-03): focus-visibility keyboard-walk guard.

The audit's worst finding — a focus ring coded in CSS but suppressed at render — is invisible
to axe (axe checks markup, not computed :focus-visible styles). Only a keyboard probe catches
it. Tabs through the first ~15 focusable elements on index.html and asserts each has a
computed, visible focus indicator per WCAG 2.2 SC 2.4.7 / 2.4.13. Static companion:
test/standards/outline_guard.py.
"""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
N_STOPS = 15
MIN_OUTLINE_WIDTH = 2.0


def step(tag, name, detail=""):
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def has_visible_focus_indicator(info):
    if info["outlineStyle"] not in ("none", ""):
        try:
            width = float(info["outlineWidth"].replace("px", ""))
        except ValueError:
            width = 0
        if width >= MIN_OUTLINE_WIDTH:
            return True
    # Fallback: a non-outline visible indicator (e.g. box-shadow ring) also satisfies 2.4.7.
    return info["boxShadow"] not in ("none", "")


failures = []
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_context().new_page()
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

    # Activate every tab so tab-scoped controls enter the walk too — otherwise the first ~15
    # stops never reach past the always-visible money-tab chrome.
    for i in range(1, N_STOPS):
        page.keyboard.press("Tab")
        info = page.evaluate("""() => {
            const el = document.activeElement;
            const cs = getComputedStyle(el);
            return {tag: el.tagName, id: el.id, cls: el.className,
                     outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth,
                     boxShadow: cs.boxShadow};
        }""")
        if info["tag"] == "BODY":
            break
        if not has_visible_focus_indicator(info):
            desc = f"{info['tag']}#{info['id']}.{info['cls']}".replace(" ", ".")
            failures.append(f"stop {i}: {desc} has no visible focus indicator "
                             f"(outline-style={info['outlineStyle']!r} width={info['outlineWidth']!r} "
                             f"box-shadow={info['boxShadow']!r})")
    if not any("stop" in f for f in failures):
        step("OK", f"focus-visible walk", f"{N_STOPS - 1} stop(s), all have a visible indicator")
    browser.close()

assert not failures, f"focus-visibility gate: {len(failures)} failure(s): {failures}"
print("✅ focus-visibility gate green")
