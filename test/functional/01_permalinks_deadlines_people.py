"""Drive the wave-1 changes in headless Chromium. Evidence printed as it happens."""
import json, sys, time
from playwright.sync_api import sync_playwright
import os
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
    ctx = browser.new_context(permissions=["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---------- load, default money view ----------
    page.goto(BASE, timeout=30000)
    page.wait_for_selector("#list .row", timeout=30000)
    n = page.locator("#list .row").count()
    step("OK", "money loads", f"{n} rows, hash='{page.evaluate('location.hash')}' (expect empty on default load)")

    # ---------- (3a) tab click updates hash, back returns ----------
    page.click('.tabbtn[data-tab="people"]')
    h = page.evaluate("location.hash")
    step("OK" if h == "#people" else "FAIL", "tab click -> hash", h)

    # ---------- (1) people seed chips ----------
    page.wait_for_selector("#pchips .chip", timeout=15000)
    chips = page.locator("#pchips .chip").count()
    first_label = page.locator("#pchips .chip").first.inner_text()
    step("OK" if chips == 16 else "FAIL", "16 example chips", f"{chips} chips, first: {first_label!r}")

    page.locator("#pchips .chip").first.click()
    # instant card must be there synchronously-ish, before live search returns
    instant = page.locator("#pdetail").inner_text()
    has_instant = "POLICE OFFICER" in instant and ("median base" in instant or "refreshing" in instant)
    step("OK" if has_instant else "FAIL", "instant seed card", instant[:140].replace("\n", " | "))
    page.wait_for_selector("#plist .row", timeout=30000)
    page.wait_for_function("!document.querySelector('#pdetail .rmeta2 .loading')", timeout=30000)
    live = page.locator("#pdetail").inner_text()
    step("OK" if "POLICE OFFICER" in live else "FAIL", "live payroll overwrites", live[:120].replace("\n", " | "))
    kw = page.input_value("#pkw")
    step("OK" if kw == "POLICE OFFICER" else "FAIL", "chip fills keyword box", kw)
    dl_opts = page.evaluate("document.querySelectorAll('#ptitles option').length")
    step("OK" if dl_opts > 100 else "WARN", "crosswalk typeahead datalist", f"{dl_opts} options")
    page.screenshot(path=SHOT + "people.png", full_page=False)

    # people hash after search
    h = page.evaluate("location.hash")
    step("OK" if "people" in h and "POLICE" in h.replace("+", " ").upper() else "WARN", "people search serialized to URL", h)

    # ---------- (2) money closing-week chip + hot tags ----------
    page.click('.tabbtn[data-tab="money"]')
    page.wait_for_selector("#list .row", timeout=30000)
    vis = page.evaluate("document.getElementById('moneyquick').style.display")
    step("OK" if vis != "none" else "FAIL", "closing-week chip visible on Open RFPs", f"display={vis!r}")
    page.click("#closingweek")
    page.wait_for_function("document.querySelector('#rescount').textContent !== ''", timeout=30000)
    page.wait_for_selector("#list .row, #list .empty", timeout=30000)
    data = page.evaluate("""() => {
        const now = Date.now();
        const dls = currentRows.map(r => Math.ceil((new Date(r.due_date) - now)/86400000));
        return {n: currentRows.length, maxDl: Math.max(...dls), minDl: Math.min(...dls),
                head: document.getElementById('reshead').textContent,
                hot: document.querySelectorAll('#list .tag.hot').length,
                hotExpected: dls.filter(d => d >= 0 && d <= 3).length,
                on: document.getElementById('closingweek').classList.contains('on'),
                hash: location.hash};
    }""")
    ok = data["on"] and data["n"] > 0 and data["maxDl"] <= 8 and "closing this week" in data["head"]
    step("OK" if ok else "FAIL", "closing-week filters", json.dumps(data))
    step("OK" if data["hot"] == data["hotExpected"] else "FAIL", "oxblood hot tags match ≤3-day rows",
         f"hot tags {data['hot']} vs rows ≤3d {data['hotExpected']}")
    page.screenshot(path=SHOT + "money-closing.png")
    # capture a real request_id for the permalink test
    req_id = page.evaluate("currentRows[0].request_id")
    # toggle off
    page.click("#closingweek")
    page.wait_for_function("!document.getElementById('closingweek').classList.contains('on')")
    step("OK", "chip toggles off", "")

    # money detail copy-link button exists
    page.locator("#list .row").first.click()
    page.wait_for_selector("#dcopy", timeout=30000)
    page.click("#dcopy")
    page.wait_for_function("document.getElementById('dcopy').textContent.includes('Copied')", timeout=5000)
    clip = page.evaluate("navigator.clipboard.readText()")
    step("OK" if "#notice/" in clip else "FAIL", "money detail copy-link", clip)

    # ---------- (3b) deep link #rules?q=... in a fresh page ----------
    p2 = ctx.new_page()
    p2.goto(BASE + "#rules?q=sidewalk", timeout=30000)
    p2.wait_for_function("document.querySelector('#tab-rules').classList.contains('active')", timeout=15000)
    kw2 = p2.input_value("#ruleskw")
    p2.wait_for_selector("#rulesfeed .fcard, #rulesfeed .empty:not(:has(.loading))", timeout=30000)
    cards = p2.locator("#rulesfeed .fcard").count()
    step("OK" if kw2 == "sidewalk" else "FAIL", "deep link lands on Rules w/ filter", f"kw={kw2!r}, {cards} cards")
    # feed card has Link button; click and check clipboard
    if cards:
        p2.locator("#rulesfeed [data-link]").first.click()
        p2.wait_for_function("[...document.querySelectorAll('#rulesfeed [data-link]')].some(b=>b.textContent.includes('Copied'))", timeout=5000)
        step("OK", "feed card 🔗 Link copies", "")
    p2.close()

    # ---------- (3c) notice permalink view, fresh page (external entry) ----------
    p3 = ctx.new_page()
    p3.goto(BASE + "#notice/" + req_id, timeout=30000)
    p3.wait_for_selector("#ncopy", timeout=30000)
    view = p3.locator("#noticeview").inner_text()
    acts = {b: p3.locator(f"#noticeview {b}").count() for b in ["#ncopy", "#nprint"]}
    cr = p3.locator('#noticeview a:has-text("View in City Record")').count()
    email = p3.locator('#noticeview a:has-text("Email")').count()
    ok = all(acts.values()) and cr and email and req_id in view
    step("OK" if ok else "FAIL", "permalink notice view", f"id={req_id}, buttons={acts}, CR-link={cr}, email={email}")
    step("OK" if p3.evaluate("document.querySelector('#tab-notice').classList.contains('active')") else "FAIL",
         "notice pane active, others hidden", "")
    p3.screenshot(path=SHOT + "notice.png", full_page=True)
    # probe: back-link to browsing
    p3.click('#noticeview a[href="#money"]')
    p3.wait_for_selector("#list .row", timeout=30000)
    step("OK" if p3.evaluate("document.querySelector('#tab-money').classList.contains('active')") else "FAIL",
         "back-link returns to Money", "")
    p3.close()

    # ---------- probe: bogus notice id ----------
    p4 = ctx.new_page()
    p4.goto(BASE + "#notice/00000000000", timeout=30000)
    p4.wait_for_function("document.querySelector('#noticeview').textContent.includes(\"wasn't found\")", timeout=30000)
    step("PROBE", "bogus notice id", "clean 'wasn't found' message with escape links")
    p4.close()

    # ---------- probe: browser back after tab pushes ----------
    page.click('.tabbtn[data-tab="meetings"]')
    page.wait_for_function("location.hash.startsWith('#meetings')")
    page.go_back()
    page.wait_for_timeout(500)
    active = page.evaluate("document.querySelector('.tabbtn.active')?.dataset.tab")
    step("PROBE" if active == "money" else "FAIL", "browser back returns to prior tab", f"active={active}")

    # ---------- console errors ----------
    step("OK" if not errors else "FAIL", "zero page errors across all flows", "; ".join(errors[:5]))

    browser.close()

fails = [r for r in results if r[0] == "FAIL"]
print("\n=== SUMMARY:", "PASS" if not fails else f"FAIL ({len(fails)})", "===")
sys.exit(1 if fails else 0)
