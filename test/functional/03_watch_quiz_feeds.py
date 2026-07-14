"""Wave-3 frontend verification + regressions."""
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

    # ---------- watch-this-search from Rules ----------
    page.goto(BASE + "#rules?q=scaffold&agency=Buildings", timeout=30000)
    page.wait_for_function("document.querySelector('#tab-rules').classList.contains('active')", timeout=15000)
    page.wait_for_selector("#rulesfeed .fcard, #rulesfeed .empty:not(:has(.loading))", timeout=30000)
    page.click('.watchbtn[data-lens="rules"]')
    page.wait_for_function("document.querySelector('#tab-alerts').classList.contains('active')", timeout=10000)
    st = page.evaluate("""({watch: document.getElementById('awatch').value,
        param: document.getElementById('aparam').value,
        agency: document.getElementById('aagency').value,
        agencyVisible: document.getElementById('aagency').style.display !== 'none'})""")
    ok = st["watch"]=="rules" and st["param"]=="scaffold" and st["agency"]=="Buildings" and st["agencyVisible"]
    step("OK" if ok else "FAIL", "#1 watch-this-search prefills from Rules", json.dumps(st))
    # preview renders as an email mock with items or the honest empty state
    page.wait_for_selector("#apreviewbox .emailmock", timeout=30000)
    subj = page.locator("#apreviewbox .esubj").inner_text()
    has_note = page.evaluate("document.querySelector('#apreviewbox .note') !== null")
    step("OK" if "rule changes" in subj and "scaffold" in subj else "FAIL", "#1 preview subject matches watch", subj)
    step("OK" if not has_note else "FAIL", "preview has NO 'Mock preview' caption (James's ask)", f"note present={has_note}")
    # feed links present and well-formed
    feeds = page.evaluate("[...document.querySelectorAll('#afeeds a')].map(a=>a.href)")
    ok = len(feeds)==3 and all("lens=rules" in f and "q=scaffold" in f for f in feeds)
    step("OK" if ok else "FAIL", "#3 feed links for the watch", feeds[0] if feeds else "none")
    page.screenshot(path=SHOT + "watch-rules.png", full_page=True)

    # subscribe payload shape: aLensFilter for rules
    lf = page.evaluate("aLensFilter()")
    ok = lf["lens"]=="rules" and lf["filter"]["keywords"]==["scaffold"] and lf["filter"]["agency"]=="Buildings"
    step("OK" if ok else "FAIL", "#1 subscribe payload {lens,filter}", json.dumps(lf))

    # ---------- watch-this-search from Contracts (keyword → rfpkw) ----------
    page.click("#tabbtn-money")
    page.wait_for_selector("#list .row", timeout=30000)
    page.fill("#kw", "asbestos")
    page.click('.watchbtn[data-lens="money"]')
    page.wait_for_function("document.querySelector('#tab-alerts').classList.contains('active')")
    st = page.evaluate("({w:document.getElementById('awatch').value, p:document.getElementById('aparam').value})")
    step("OK" if st["w"]=="rfpkw" and st["p"]=="asbestos" else "FAIL", "#1 money keyword → RFP watch", json.dumps(st))

    # ---------- #2 quiz flow ----------
    p2 = ctx.new_page()
    p2.goto(BASE + "#alerts", timeout=30000)
    p2.wait_for_selector("#quizpanel", timeout=15000)
    p2.click('#quizwhat .chip[data-w="meetings"]')
    on = p2.evaluate("document.querySelector('#quizwhat .chip.on')?.dataset.w")
    p2.fill("#quiznarrow", "community board")
    p2.click('#quizfreq .chip[data-f="Weekly"]')
    p2.click("#quizgo")
    p2.wait_for_selector("#apreviewbox .emailmock", timeout=30000)
    st = p2.evaluate("""({watch:document.getElementById('awatch').value, param:document.getElementById('aparam').value,
        freq:document.getElementById('afreq').value, subj:document.querySelector('#apreviewbox .esubj').textContent})""")
    ok = on=="meetings" and st["watch"]=="meetings" and st["param"]=="community board" and st["freq"]=="Weekly" and "weekly" in st["subj"]
    step("OK" if ok else "FAIL", "#2 quiz → prefilled builder + preview", json.dumps(st))
    # preview items link to permalinks
    links = p2.evaluate("[...document.querySelectorAll('#apreviewbox .dc a')].map(a=>a.getAttribute('href'))")
    step("OK" if links and all(l.startswith('#notice/') for l in links) else "WARN", "#2 preview items → permalinks", f"{len(links)} links")
    p2.screenshot(path=SHOT + "quiz.png", full_page=True)
    p2.close()

    # ---------- probe: bigaward quiz path disables narrowing ----------
    p3 = ctx.new_page()
    p3.goto(BASE + "#alerts", timeout=30000)
    p3.wait_for_selector("#quizpanel", timeout=15000)
    p3.click('#quizwhat .chip[data-w="bigaward"]')
    dis = p3.evaluate("document.getElementById('quiznarrow').disabled")
    p3.click("#quizgo")
    p3.wait_for_selector("#apreviewbox .emailmock", timeout=30000)
    subj = p3.locator("#apreviewbox .esubj").inner_text()
    step("PROBE" if dis and "awards over" in subj else "FAIL", "quiz bigaward path", f"narrow disabled={dis}, subj={subj!r}")
    # probe: quizgo with nothing selected → nudge, no crash
    p4 = ctx.new_page()
    p4.goto(BASE + "#alerts", timeout=30000)
    p4.wait_for_selector("#quizgo", timeout=15000)
    p4.click("#quizgo")
    ph = p4.evaluate("document.getElementById('quiznarrow').placeholder")
    step("PROBE" if "pick a topic" in ph else "FAIL", "quiz CTA without topic → nudge", ph)
    p4.close(); p3.close()

    # ---------- regressions ----------
    page.click("#tabbtn-property")
    page.wait_for_selector("#assettabs .chip", timeout=45000)
    step("OK", "regression: property explorer loads", "")
    page.click("#tabbtn-people")
    page.wait_for_selector("#pchips .chip", timeout=15000)
    step("OK" if page.locator("#pchips .chip").count()==16 else "FAIL", "regression: people chips", "")
    strip = page.evaluate("!document.getElementById('todaystrip').hidden")
    step("OK" if strip else "FAIL", "regression: today strip", "")

    step("OK" if not errors else "FAIL", "zero page errors", "; ".join(errors[:5]))
    browser.close()

fails = [r for r in results if r[0]=="FAIL"]
print("\n=== SUMMARY:", "PASS" if not fails else f"FAIL ({len(fails)})", "===")
sys.exit(1 if fails else 0)
