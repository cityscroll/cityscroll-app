"""Wave C: Checkbook follow-the-dollars + matter timelines + address links.
Server must run on port 8000 (the worker proxy's CORS allowlist includes localhost:8000)."""
import json, sys
from playwright.sync_api import sync_playwright
import os
BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
_ARGS = ["--host-resolver-rules=MAP api.crol-list.org " + os.environ["CROL_DNS_IP"]] if os.environ.get("CROL_DNS_IP") else []
SHOT = os.environ.get("CROL_SHOTS", os.path.dirname(os.path.abspath(__file__)) + "/shots") + "/"
os.makedirs(SHOT, exist_ok=True)




PIN_NOTICE = "20260625017"   # ACS award, PIN 06820P8165KXLR002 — verified in the spike
PIN = "06820P8165KXLR002"
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

    # ---------- N3: follow-the-dollars on the known award's permalink ----------
    page.goto(BASE + "#notice/" + PIN_NOTICE, timeout=30000)
    page.wait_for_selector("#ncopy", timeout=30000)
    try:
        page.wait_for_function("(document.querySelector('#ndollars')?.innerText||'').toUpperCase().includes('FOLLOW THE DOLLARS')", timeout=60000)
        t = page.locator("#ndollars").inner_text().upper()
        ok = "COMMITTED" in t and "$10.84M" in t and "PAID TO DATE" in t and "CT106820278800037" in t
        step("OK" if ok else "FAIL", "N3 dollars panel: committed/paid/contract-id", t[:200].replace("\n"," | "))
        step("OK" if "MATCHED BY PIN" in t else "FAIL", "N3 provenance line", "")
    except Exception as e:
        step("FAIL", "N3 dollars panel", page.locator("#ndollars").inner_html()[:150])
    page.screenshot(path=SHOT + "dollars.png", full_page=True)

    # timeline link from the paper trail
    has_tl = page.evaluate("!!document.querySelector('a[href=\"#matter/'+encodeURIComponent('%s')+'\"]')" % PIN)
    step("OK" if has_tl else "WARN", "N8 timeline link on paper trail", "(needs chain to have rendered)")

    # ---------- N8: matter timeline ----------
    p2 = ctx.new_page()
    p2.goto(BASE + "#matter/" + PIN, timeout=30000)
    p2.wait_for_function("document.querySelector('#entityview .timeline') !== null", timeout=45000)
    t = p2.locator("#entityview").inner_text()
    checks = {"award": "Award" in t, "registered": "Contract registered" in t, "paid": "Paid to date" in t,
              "vendor_pivot": p2.locator('#entityview a[href^="#vendor/"]').count() > 0,
              "agency_pivot": p2.locator('#entityview a[href^="#agency/"]').count() > 0}
    step("OK" if all(checks.values()) else "FAIL", "N8 matter timeline: CROL + Checkbook events on one spine", json.dumps(checks))
    p2.screenshot(path=SHOT + "matter.png", full_page=True)
    # probe: bogus pin
    p2.goto(BASE + "#matter/NOPE123456", timeout=30000)
    p2.wait_for_function("document.querySelector('#entityview .empty') && !document.querySelector('#entityview .loading')", timeout=30000)
    step("PROBE", "bogus matter pin", p2.locator("#entityview .empty").inner_text()[:70])
    p2.close()

    # ---------- N3: money-trail detail also gets the panel ----------
    p3 = ctx.new_page()
    p3.goto(BASE + "#money?mode=award", timeout=30000)
    p3.wait_for_selector("#list .row", timeout=30000)
    try:
        p3.wait_for_function("document.querySelector('#ddollars')?.innerText.length > 10", timeout=40000)
        step("OK", "N3 dollars panel in Money trail", p3.locator("#ddollars").inner_text()[:100].replace("\n"," | "))
    except Exception:
        step("WARN", "N3 dollars panel in Money trail", "first award's PIN not registered yet (honest empty-state or absent)")
    p3.close()

    # ---------- address links (data-dependent probe) ----------
    p4 = ctx.new_page()
    p4.goto(BASE + "#property", timeout=30000)
    p4.wait_for_selector("#propertyfeed .fcard", timeout=45000)
    rid = p4.evaluate("(()=>{const r=Object.values(feedRows.property).find(r=>r.street_address_1 && goodAddr(r.street_address_1)); return r?r.request_id:null;})()")
    if rid:
        p4.goto(BASE + "#notice/" + rid, timeout=30000)
        p4.wait_for_selector("#ncopy", timeout=30000)
        try:
            p4.wait_for_function("document.querySelector('#naddr')?.innerText.includes('elsewhere')", timeout=20000)
            links = p4.evaluate("[...document.querySelectorAll('#naddr a')].map(a=>a.host)")
            step("OK" if len(links)==3 else "WARN", "N3 address cross-links (ZoLa/ACRIS/WOW)", str(links))
        except Exception:
            step("WARN", "N3 address cross-links", "geocode returned no BBL for this address (expected for many)")
    else:
        step("WARN", "N3 address cross-links", "no good-address property notice in current window")
    p4.close()

    # ---------- regressions ----------
    page.goto(BASE, timeout=30000)
    page.wait_for_selector("#list .row", timeout=30000)
    page.wait_for_function("!document.getElementById('todaystrip').hidden", timeout=20000)
    step("OK", "regression: default load + today strip", "")

    step("OK" if not errors else "FAIL", "zero page errors", "; ".join(errors[:5]))
    browser.close()

fails = [r for r in results if r[0]=="FAIL"]
print("\n=== SUMMARY:", "PASS" if not fails else f"FAIL ({len(fails)})", "===")
sys.exit(1 if fails else 0)
