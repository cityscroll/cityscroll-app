"""Round-two wave A: entity pages, pivots, method facet + regressions."""
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

    # ---------- load money, grab a real agency + vendor from awards ----------
    page.goto(BASE, timeout=30000)
    page.wait_for_selector("#list .row", timeout=30000)
    page.select_option("#mode", "award")
    page.wait_for_function("currentRows.length && currentRows[0].type_of_notice_description==='Award'", timeout=30000)
    ent = page.evaluate("(()=>{const r=currentRows.find(r=>r.vendor_name&&r.agency_name)||currentRows[0]; return {agency:r.agency_name, vendor:r.vendor_name};})()")
    print("   sample entities:", ent, flush=True)

    # ---------- method facet ----------
    page.wait_for_function("document.getElementById('methodfacet').style.display !== 'none'", timeout=30000)
    chips = page.evaluate("[...document.querySelectorAll('#methodfacet .chip')].map(b=>b.dataset.m)")
    step("OK" if len(chips)>=2 else "FAIL", "N4 method facet renders", f"{len(chips)} methods: {chips[:3]}")
    page.locator("#methodfacet .chip").first.click()
    page.wait_for_function("document.querySelector('#methodfacet .chip.on') !== null", timeout=30000)
    page.wait_for_function("methodSel && currentRows.length && currentRows.every(r=>r.selection_method_description===methodSel)", timeout=30000)
    d = page.evaluate("""({m: methodSel, hash: location.hash,
        allMatch: currentRows.every(r=>r.selection_method_description===methodSel),
        head: document.getElementById('reshead').textContent})""")
    ok = d["m"] and d["allMatch"] and ("m="+d["m"].split(" ")[0]) in d["hash"].replace("+"," ").replace("%20"," ") or (d["m"] and d["allMatch"] and "m=" in d["hash"])
    step("OK" if d["m"] and d["allMatch"] and "m=" in d["hash"] else "FAIL", "N4 method chip filters server-side + URL", json.dumps(d)[:180])
    page.locator("#methodfacet .chip.on").click()  # clear
    page.wait_for_function("methodSel === ''", timeout=30000)
    step("OK", "N4 method chip toggles off", "")

    # ---------- glance pivots on an award ----------
    page.wait_for_selector("#detail .glance", timeout=30000)
    piv = page.evaluate("[...document.querySelectorAll('#detail .glance a.pivot')].map(a=>a.getAttribute('href'))")
    step("OK" if piv and any(h.startswith('#agency/') for h in piv) else "FAIL", "N4 glance agency pivot link", str(piv[:2]))

    # ---------- agency page ----------
    p2 = ctx.new_page()
    p2.goto(BASE + "#agency/" + ent["agency"].replace(" ", "%20"), timeout=30000)
    p2.wait_for_selector("#entityview .agencybar", timeout=45000)
    txt = p2.locator("#entityview").inner_text()
    has = {"total": "TOTAL AWARDED" in txt.upper(), "sections": p2.locator("#entityview .chiprow .chip").count() > 0,
           "vendors": p2.locator("#entityview .ladder .lrow").count()}
    step("OK" if has["total"] and has["sections"] else "FAIL", "N2 agency page renders", json.dumps(has))
    # watch button prefills agency
    p2.locator('#entityview [data-aw="rules"]').click()
    p2.wait_for_function("document.querySelector('#tab-alerts').classList.contains('active')", timeout=10000)
    ag = p2.evaluate("({w:document.getElementById('awatch').value, a:document.getElementById('aagency').value})")
    step("OK" if ag["w"]=="rules" and ag["a"]==ent["agency"] else "FAIL", "N2 agency watch prefill", json.dumps(ag))
    p2.screenshot(path=SHOT + "agency.png", full_page=True)

    # pivot chain: agency page -> top vendor -> vendor page
    p2.goto(BASE + "#agency/" + ent["agency"].replace(" ", "%20"), timeout=30000)
    p2.wait_for_selector("#entityview .agencybar", timeout=45000)
    if p2.locator("#entityview .ladder a.pivot").count():
        vname = p2.locator("#entityview .ladder a.pivot").first.inner_text()
        p2.locator("#entityview .ladder a.pivot").first.click()
        p2.wait_for_function("location.hash.startsWith('#vendor/')", timeout=10000)
        p2.wait_for_function("document.querySelector('#entityview .ftype')?.textContent.includes('Vendor profile') || (document.querySelector('#entityview .empty') && !document.querySelector('#entityview .loading'))", timeout=45000)
        vtxt = p2.locator("#entityview").inner_text()
        step("OK" if "VENDOR PROFILE" in vtxt.upper() else "FAIL",
             "N1 agency→vendor pivot chain", f"clicked {vname!r}")
    else:
        step("WARN", "N1 agency→vendor pivot chain", "no vendor bars for this agency")
    p2.close()

    # ---------- vendor page direct, with variant resolution ----------
    p3 = ctx.new_page()
    p3.goto(BASE + "#vendor/" + ent["vendor"].replace(" ", "%20"), timeout=30000)
    p3.wait_for_selector("#entityview .agencybar, #entityview .empty:not(:has(.loading))", timeout=45000)
    vt = p3.locator("#entityview").inner_text()
    ok = "TOTAL AWARDED" in vt.upper() and "VARIANT" in vt.upper()
    step("OK" if ok else "FAIL", "N1 vendor page resolves + renders", vt[:120].replace("\n"," | "))
    # agencies-they-win-from chips pivot back
    backs = p3.evaluate("[...document.querySelectorAll('#entityview a.chip')].map(a=>a.getAttribute('href'))")
    step("OK" if backs and all(h.startswith('#agency/') for h in backs) else "WARN", "N1 vendor→agency pivot chips", str(len(backs)))
    p3.screenshot(path=SHOT + "vendor.png", full_page=True)
    # probe: garbage vendor
    p3.goto(BASE + "#vendor/ZZZXQJ%20NONEXISTENT%20LLC", timeout=30000)
    p3.wait_for_function("document.querySelector('#entityview .empty') && !document.querySelector('#entityview .loading')", timeout=45000)
    step("PROBE", "vendor not-found path", p3.locator("#entityview .empty").inner_text()[:80])
    # probe: too-short vendor
    p3.goto(BASE + "#vendor/AB", timeout=30000)
    p3.wait_for_function("document.querySelector('#entityview .empty') && document.querySelector('#entityview .empty').textContent.includes('too short')", timeout=15000)
    step("PROBE", "too-short vendor stem", "clean message")
    p3.close()

    # ---------- feed card agency pivot ----------
    p4 = ctx.new_page()
    p4.goto(BASE + "#rules", timeout=30000)
    p4.wait_for_selector("#rulesfeed .fcard", timeout=30000)
    p4.locator("#rulesfeed .fcard .ftype a.pivot").first.click()
    p4.wait_for_function("location.hash.startsWith('#agency/')", timeout=10000)
    p4.wait_for_selector("#entityview .agencybar, #entityview .empty:not(:has(.loading))", timeout=45000)
    step("OK" if p4.locator("#entityview .agencybar").count() else "FAIL", "N4 feed-card agency pivot", p4.evaluate("location.hash")[:60])
    p4.close()

    # ---------- regressions ----------
    page.select_option("#mode", "open")
    page.wait_for_selector("#list .row", timeout=30000)
    page.click("#closingweek")
    page.wait_for_function("document.getElementById('reshead').textContent.includes('closing this week')", timeout=30000)
    page.click("#closingweek")
    step("OK", "regression: closing-week", "")
    strip = page.evaluate("!document.getElementById('todaystrip').hidden")
    step("OK" if strip else "FAIL", "regression: today strip", "")
    page.click("#tabbtn-people"); page.wait_for_selector("#pchips .chip", timeout=15000)
    step("OK" if page.locator("#pchips .chip").count()==16 else "FAIL", "regression: people chips", "")

    step("OK" if not errors else "FAIL", "zero page errors", "; ".join(errors[:5]))
    browser.close()

fails = [r for r in results if r[0]=="FAIL"]
print("\n=== SUMMARY:", "PASS" if not fails else f"FAIL ({len(fails)})", "===")
sys.exit(1 if fails else 0)
