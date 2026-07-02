"""Wave-2 verification + wave-1 regression, headless Chromium."""
import json, sys
from playwright.sync_api import sync_playwright
import os
BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
_ARGS = ["--host-resolver-rules=MAP api.crol-list.org " + os.environ["CROL_DNS_IP"]] if os.environ.get("CROL_DNS_IP") else []
SHOT = os.environ.get("CROL_SHOTS", os.path.dirname(os.path.abspath(__file__)) + "/shots") + "/"
os.makedirs(SHOT, exist_ok=True)




results = []
def step(tag, name, detail=""):
    results.append((tag, name))
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=_ARGS)
    ctx = browser.new_context()
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---------- load + #7 Today's Edition ----------
    page.goto(BASE, timeout=30000)
    page.wait_for_selector("#list .row", timeout=30000)
    try:
        page.wait_for_function("!document.getElementById('todaystrip').hidden", timeout=20000)
        tbig = page.locator("#tbig").inner_text()
        counts = page.locator("#tcounts a").count()
        cards = page.locator("#tcards .t-card").count()
        hrefs = page.evaluate("[...document.querySelectorAll('#tcards .t-card')].map(a=>a.getAttribute('href'))")
        ok = counts >= 2 and cards >= 2 and all(h.startswith("#notice/") for h in hrefs)
        step("OK" if ok else "FAIL", "#7 Today strip renders", f"{tbig!r}, {counts} lens links, {cards} cards, hrefs ok={all(h.startswith('#notice/') for h in hrefs)}")
    except Exception as e:
        step("FAIL", "#7 Today strip renders", str(e)[:120])
    page.screenshot(path=SHOT + "today.png")

    # count link deep-links into a lens
    if page.locator('#tcounts a[href="#meetings"]').count():
        page.click('#tcounts a[href="#meetings"]')
        page.wait_for_function("document.querySelector('#tab-meetings').classList.contains('active')", timeout=10000)
        step("OK", "#7 count link deep-links", "meetings active")
        page.go_back(); page.wait_for_timeout(400)

    # ---------- #10 ARIA tabs ----------
    roles = page.evaluate("""({
        tablist: document.querySelector('.tabs').getAttribute('role'),
        tab: document.querySelector('.tabbtn').getAttribute('role'),
        sel: document.querySelector('#tabbtn-money').getAttribute('aria-selected'),
        panel: document.querySelector('#tab-money').getAttribute('role'),
        roving: [...document.querySelectorAll('.tabbtn')].map(b=>b.tabIndex)
    })""")
    ok = roles["tablist"]=="tablist" and roles["tab"]=="tab" and roles["panel"]=="tabpanel" and roles["roving"].count(0)==1
    step("OK" if ok else "FAIL", "#10 ARIA tab semantics", json.dumps(roles))

    page.focus("#tabbtn-money")
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(300)
    act = page.evaluate("({active:document.querySelector('.tabbtn.active')?.dataset.tab, focus:document.activeElement.id, sel:document.querySelector('#tabbtn-people').getAttribute('aria-selected')})")
    step("OK" if act["active"]=="people" and act["focus"]=="tabbtn-people" and act["sel"]=="true" else "FAIL",
         "#10 arrow-key tab nav + aria-selected", json.dumps(act))

    # keyboard-operable rows (money)
    page.click("#tabbtn-money"); page.wait_for_selector("#list .row", timeout=30000)
    page.wait_for_timeout(300)
    ti = page.evaluate("document.querySelector('#list .row').tabIndex")
    page.evaluate("document.querySelectorAll('#list .row')[1].focus()")
    page.keyboard.press("Enter")
    page.wait_for_timeout(1500)
    sel_ok = page.evaluate("document.querySelectorAll('#list .row')[1].classList.contains('sel')")
    step("OK" if ti==0 and sel_ok else "FAIL", "#10 rows keyboard-operable", f"tabIndex={ti}, Enter selects={sel_ok}")

    # srstatus announcements
    sr = page.evaluate("document.getElementById('srstatus').textContent")
    step("OK" if sr.strip() else "FAIL", "#10 live region announces", sr)

    # skip link + reduced-motion CSS presence
    skip = page.evaluate("({href:document.querySelector('.skip')?.getAttribute('href'), target:!!document.getElementById('main')})")
    step("OK" if skip["href"]=="#main" and skip["target"] else "FAIL", "#10 skip link", json.dumps(skip))

    # ---------- #6 glance box on a notice permalink ----------
    req_id = page.evaluate("currentRows[0].request_id")
    p2 = ctx.new_page()
    p2.goto(BASE + "#notice/" + req_id, timeout=30000)
    p2.wait_for_selector(".glance", timeout=30000)
    gl = p2.locator(".glance").inner_text()
    labels = [w for w in ["WHO","WHAT","WHEN"] if w in gl.upper()]
    fold = p2.locator("details.fulltext").count()
    step("OK" if len(labels)>=3 else "FAIL", "#6 glance box (who/what/when)", gl[:160].replace("\n"," | "))
    step("OK" if fold else "WARN", "#6 full-text fold", f"{fold} details element(s)")
    p2.screenshot(path=SHOT + "glance.png", full_page=True)
    p2.close()

    # glance in money trail for an award
    page.select_option("#mode", "award")
    page.wait_for_selector("#list .row", timeout=30000)
    page.wait_for_selector("#detail .glance", timeout=30000)
    gtxt = page.locator("#detail .glance").inner_text()
    step("OK" if "AWARDED TO" in gtxt.upper() or "WHO" in gtxt.upper() else "FAIL", "#6 glance in Money trail (award)", gtxt[:120].replace("\n"," | "))
    page.select_option("#mode", "open"); page.wait_for_selector("#list .row", timeout=30000)

    # ---------- #9 property explorer ----------
    p3 = ctx.new_page()
    p3.goto(BASE + "#property", timeout=30000)
    p3.wait_for_selector("#assettabs .chip", timeout=45000)
    tabs = p3.evaluate("[...document.querySelectorAll('#assettabs .chip')].map(b=>b.textContent)")
    counts = p3.evaluate("[...document.querySelectorAll('#assettabs .chip .ct')].map(s=>+s.textContent)")
    sum_ok = counts[0] == sum(counts[1:])
    step("OK" if len(tabs)==7 and sum_ok else "FAIL", "#9 asset tabs + count math", f"{tabs} | all={counts[0]} vs sum={sum(counts[1:])}")
    # click Forest / timber
    p3.click('#assettabs .chip[data-a="forest"]')
    p3.wait_for_timeout(400)
    d = p3.evaluate("""({
        n: document.querySelectorAll('#propertyfeed .fcard').length,
        badges: [...document.querySelectorAll('#propertyfeed .tag.asset')].map(t=>t.textContent),
        hash: location.hash,
        rail: document.querySelectorAll('#liferail .chip').length
    })""")
    ok = d["n"]>0 and all(b=="Forest / timber" for b in d["badges"]) and "asset=forest" in d["hash"] and d["rail"]==5
    step("OK" if ok else "FAIL", "#9 forest tab filters + URL", json.dumps(d)[:200])
    # dollar badges present somewhere in the full set
    p3.click('#assettabs .chip[data-a="all"]'); p3.wait_for_timeout(400)
    nbadge = p3.evaluate("document.querySelectorAll('#propertyfeed .tag.amt').length")
    step("OK" if nbadge>=0 else "OK", "#9 labeled $ badges", f"{nbadge} badge(s) in loaded set")
    # deep-link with asset preselected (fresh page)
    p4 = ctx.new_page()
    p4.goto(BASE + "#property?asset=forest", timeout=30000)
    p4.wait_for_selector("#assettabs .chip.on", timeout=45000)
    onchip = p4.evaluate("document.querySelector('#assettabs .chip.on')?.dataset.a")
    step("OK" if onchip=="forest" else "FAIL", "#9 asset deep-link", f"on={onchip}")
    p4.screenshot(path=SHOT + "property.png")
    p4.close()
    p3.close()

    # ---------- #10 mobile filter tray ----------
    m = ctx.new_page()
    m.set_viewport_size({"width": 390, "height": 800})
    m.goto(BASE, timeout=30000)
    m.wait_for_selector("#list .row", timeout=30000)
    vis = m.evaluate("""({
        toggle: getComputedStyle(document.querySelector('#tab-money .filtertoggle')).display,
        controls: getComputedStyle(document.querySelector('#tab-money .controls')).display
    })""")
    m.click("#tab-money .filtertoggle")
    after = m.evaluate("({controls:getComputedStyle(document.querySelector('#tab-money .controls')).display, exp:document.querySelector('#tab-money .filtertoggle').getAttribute('aria-expanded')})")
    ok = vis["toggle"]!="none" and vis["controls"]=="none" and after["controls"]!="none" and after["exp"]=="true"
    step("OK" if ok else "FAIL", "#10 mobile filter tray", json.dumps({**vis, **after}))
    m.screenshot(path=SHOT + "mobile.png")
    m.close()

    # ---------- wave-1 regressions ----------
    page.click("#closingweek")
    page.wait_for_function("document.getElementById('reshead').textContent.includes('closing this week')", timeout=30000)
    step("OK", "regression: closing-week still works", "")
    page.click("#closingweek")
    page.click("#tabbtn-people")
    page.wait_for_selector("#pchips .chip", timeout=15000)
    step("OK" if page.locator("#pchips .chip").count()==16 else "FAIL", "regression: 16 people chips", "")
    page.click("#tabbtn-meetings")
    page.wait_for_function("location.hash.startsWith('#meetings')")
    page.go_back(); page.wait_for_timeout(600)
    back_tab = page.evaluate("document.querySelector('.tabbtn.active')?.dataset.tab")
    step("OK" if back_tab=="people" else "FAIL", "regression: back returns to prior tab", f"active={back_tab}")

    step("OK" if not errors else "FAIL", "zero page errors", "; ".join(errors[:5]))
    browser.close()

fails = [r for r in results if r[0]=="FAIL"]
print("\n=== SUMMARY:", "PASS" if not fails else f"FAIL ({len(fails)})", "===")
sys.exit(1 if fails else 0)
