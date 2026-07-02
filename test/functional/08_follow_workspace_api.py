"""Wave D: entity follows, investigation workspace, api page + batch. Port 8000 (CORS)."""
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

    # ---------- N7: follow from vendor page ----------
    page.goto(BASE + "#vendor/Sinergia%20Inc", timeout=30000)
    page.wait_for_function("document.querySelector('#entityview .ftype')?.textContent.includes('Vendor profile')", timeout=45000)
    page.click('[data-follow="vendor"]')
    page.wait_for_function("document.querySelector('#tab-alerts').classList.contains('active')", timeout=10000)
    st = page.evaluate("({w:document.getElementById('awatch').value, p:document.getElementById('aparam').value, lf:aLensFilter()})")
    ok = st["w"]=="entityvendor" and "Sinergia" in st["p"] and st["lf"]["lens"]=="entity" and st["lf"]["filter"]["kind"]=="vendor"
    step("OK" if ok else "FAIL", "N7 vendor follow → entity watch prefilled", json.dumps(st)[:160])
    page.wait_for_selector("#apreviewbox .emailmock", timeout=45000)
    subj = page.locator("#apreviewbox .esubj").inner_text()
    step("OK" if "Sinergia" in subj else "FAIL", "N7 entity preview renders", subj)
    feeds = page.evaluate("[...document.querySelectorAll('#afeeds a')].map(a=>a.href)")
    ok = feeds and all("lens=entity" in f and "kind=vendor" in f and "api.crol-list.org" in f for f in feeds)
    step("OK" if ok else "FAIL", "N7 entity feed links (branded)", feeds[0] if feeds else "none")

    # ---------- N9: pin → workspace → note → export → share → shared view ----------
    p2 = ctx.new_page()
    p2.goto(BASE + "#notice/20260625017", timeout=30000)
    p2.wait_for_selector("[data-pin]", timeout=30000)
    p2.locator("[data-pin]").first.click()
    p2.wait_for_function("!!document.querySelector('a[href=\"#investigation\"].act')", timeout=5000)
    step("OK", "N9 pin flips to '✓ Pinned' link", p2.locator('a[href="#investigation"].act').inner_text())
    p2.goto(BASE + "#investigation", timeout=30000)
    p2.wait_for_selector("#invitems .tl", timeout=15000)
    n_items = p2.locator("#invitems .tl").count()
    step("OK" if n_items == 1 else "FAIL", "N9 workspace shows pinned item", f"{n_items} item(s)")
    # note persists
    p2.fill(".invnote", "check the sub-vendors")
    p2.locator(".invnote").blur()
    p2.goto(BASE + "#investigation", timeout=30000)
    p2.wait_for_selector(".invnote", timeout=15000)
    note = p2.input_value(".invnote")
    step("OK" if note == "check the sub-vendors" else "FAIL", "N9 note persists across reload", repr(note))
    # csv export content
    csv = p2.evaluate("invCsv(invStore().invs[invStore().current])")
    ok = "Permalink" in csv and "#notice/20260625017" in csv and "check the sub-vendors" in csv
    step("OK" if ok else "FAIL", "N9 CSV export carries permalink + note", csv[:120].replace("\\n"," | "))
    # share roundtrip through the real worker
    p2.click("#invshare")
    p2.wait_for_function("document.querySelector('#invmsg a') !== null || document.querySelector('#invmsg').textContent.includes('try')", timeout=30000)
    share_url = p2.evaluate("document.querySelector('#invmsg a')?.getAttribute('href') || ''")
    if share_url:
        step("OK", "N9 share uploads snapshot", share_url[:80])
        sid = share_url.split("/shared/")[1]
        p3 = ctx.new_page()
        p3.goto(BASE + "#investigation/shared/" + sid, timeout=30000)
        p3.wait_for_function("document.querySelector('#entityview .ftype')?.textContent.includes('Shared investigation')", timeout=30000)
        t = p3.locator("#entityview").inner_text()
        step("OK" if "check the sub-vendors" in t else "FAIL", "N9 shared view renders read-only w/ note", "")
        p3.close()
    else:
        step("FAIL", "N9 share uploads snapshot", p2.locator("#invmsg").inner_text())
    p2.screenshot(path=SHOT + "workspace.png", full_page=True)
    p2.close()

    # ---------- N10: api.html + live batch tool ----------
    p4 = ctx.new_page()
    p4.goto(BASE + "api.html", timeout=30000)
    p4.fill("#bnames", "Sinergia Inc\nZZZXQJ Nonexistent")
    p4.click("#brun")
    p4.wait_for_selector("#bout table", timeout=45000)
    rows = p4.evaluate("[...document.querySelectorAll('#bout tr')].map(r=>r.textContent.replace(/\\s+/g,' ').trim())")
    ok = len(rows)==3 and any("Sinergia" in r and "vendor profile" in r for r in rows)
    step("OK" if ok else "FAIL", "N10 batch tool on api.html", " | ".join(rows)[:160])
    p4.screenshot(path=SHOT + "api.png", full_page=True)
    p4.close()

    # ---------- regressions ----------
    page.goto(BASE, timeout=30000)
    page.wait_for_selector("#list .row", timeout=30000)
    page.click("#tabbtn-people"); page.wait_for_selector("#pchips .chip", timeout=15000)
    step("OK" if page.locator("#pchips .chip").count()==16 else "FAIL", "regression: people chips", "")
    step("OK" if not errors else "FAIL", "zero page errors", "; ".join(errors[:5]))
    browser.close()

fails = [r for r in results if r[0]=="FAIL"]
print("\n=== SUMMARY:", "PASS" if not fails else f"FAIL ({len(fails)})", "===")
sys.exit(1 if fails else 0)
