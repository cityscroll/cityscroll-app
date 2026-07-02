"""Round three (R·A/R·B): the public changelog + stats pages. Evidence printed as it happens."""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
_ARGS = ["--host-resolver-rules=MAP api.crol-list.org " + os.environ["CROL_DNS_IP"]] if os.environ.get("CROL_DNS_IP") else []
SHOT = os.environ.get("CROL_SHOTS", os.path.dirname(os.path.abspath(__file__)) + "/shots") + "/"
os.makedirs(SHOT, exist_ok=True)

results = []
def step(tag, name, detail=""):
    results.append((tag, name, detail))
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=_ARGS)
    page = browser.new_context().new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---------- changelog ----------
    page.goto(BASE + "changelog.html", timeout=30000)
    page.wait_for_selector(".rel", timeout=15000)
    n = page.locator(".rel").count()
    assert n >= 5, f"expected >=5 release sections, got {n}"
    step("OK", "changelog renders", f"{n} release sections")
    fy = page.locator(".foryou").count()
    assert fy == n, f"every release needs a 'For you' line ({fy}/{n})"
    step("OK", "plain-language 'For you' on every release", f"{fy}")
    inc = page.locator(".incident").count()
    assert inc >= 2, f"incidents belong in the changelog (got {inc})"
    step("OK", "incident entries present", f"{inc}")
    assert page.locator('a[href="stats.html"]').count() >= 1
    step("OK", "changelog links to stats")
    page.screenshot(path=SHOT + "changelog.png", full_page=False)

    # ---------- stats ----------
    page.goto(BASE + "stats.html", timeout=30000)
    page.wait_for_selector("#msg", timeout=15000)
    # Either the grid fills from the live worker, or the graceful-unreachable message shows.
    try:
        page.wait_for_selector("#grid:not([hidden])", timeout=12000)
        subs = page.locator("#s-subs").inner_text()
        assert subs != "–", "grid shown but counters empty"
        step("OK", "stats grid live", f"active subscriptions = {subs}")
    except Exception:
        msg = page.locator("#msg").inner_text()
        assert "unreachable" in msg, f"neither live grid nor honest fallback: {msg!r}"
        step("OK", "stats fallback honest (worker unreachable here)", msg)
    page.screenshot(path=SHOT + "stats.png", full_page=False)

    # ---------- footer wiring ----------
    page.goto(BASE, timeout=30000)
    page.wait_for_selector("footer", timeout=15000)
    for href in ("changelog.html", "stats.html"):
        assert page.locator(f'footer a[href="{href}"]').count() == 1, f"footer missing {href}"
    step("OK", "index footer links changelog + stats")

    assert not errors, f"page errors: {errors}"
    step("OK", "no page errors")
    browser.close()

print(f"\n{len(results)} checks passed")
