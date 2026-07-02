"""Wave B: red-flag badges + context benchmarks."""
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

    # ---------- awards: context strip on detail ----------
    page.goto(BASE + "#money?mode=award", timeout=30000)
    page.wait_for_selector("#list .row", timeout=30000)
    page.wait_for_selector("#detail #dcontext", timeout=30000)
    try:
        page.wait_for_function("document.querySelector('#dcontext')?.innerHTML.includes('larger than')", timeout=30000)
        ctx_txt = page.locator("#dcontext").inner_text()
        step("OK", "N6 context strip (percentile) on award detail", ctx_txt[:130].replace("\n"," | "))
        has_link = page.evaluate("!!document.querySelector('#dcontext a[href=\"about.html#context\"]')")
        step("OK" if has_link else "FAIL", "N6 'how computed' methodology link", "")
    except Exception:
        step("FAIL", "N6 context strip (percentile) on award detail", page.locator("#dcontext").inner_html()[:120])
    page.screenshot(path=SHOT + "context.png")

    # ---------- flags: pick a non-competitive award via the method facet if available ----------
    page.wait_for_function("document.getElementById('methodfacet').style.display !== 'none'", timeout=30000)
    noncomp = page.evaluate("""[...document.querySelectorAll('#methodfacet .chip')]
        .map(b=>b.dataset.m).find(m=>/negotiated|sole source|emergency|demonstration/i.test(m)) || null""")
    if noncomp:
        page.evaluate(f"""(()=>{{const b=[...document.querySelectorAll('#methodfacet .chip')].find(x=>x.dataset.m===
            {json.dumps(noncomp)}); b.click();}})()""")
        page.wait_for_function("methodSel !== '' && currentRows.length && currentRows.every(r=>r.selection_method_description===methodSel)", timeout=30000)
        page.wait_for_function("document.querySelector('#dcontext')?.innerHTML.includes('non-competitive method')", timeout=30000)
        step("OK", "N5 non-competitive method flag", page.locator("#dcontext .tag").first.inner_text())
        # every currentRow under this method should flag identically — spot-check second row
        if page.locator("#list .row").count() > 1:
            page.locator("#list .row").nth(1).click()
            page.wait_for_function("document.querySelector('#dcontext')?.innerHTML.includes('non-competitive method')", timeout=30000)
            step("PROBE", "N5 flag consistent across rows", "second row also flagged")
        page.screenshot(path=SHOT + "flags.png")
    else:
        step("WARN", "N5 non-competitive method flag", "no non-competitive method in current facet — data-dependent")

    # ---------- notice permalink carries context too ----------
    req_id = page.evaluate("currentRows[0].request_id")
    p2 = ctx.new_page()
    p2.goto(BASE + "#notice/" + req_id, timeout=30000)
    p2.wait_for_selector("#ncopy", timeout=30000)
    try:
        p2.wait_for_function("document.querySelector('#ncontext')?.innerHTML.length > 10", timeout=30000)
        step("OK", "N5/N6 context on permalink view", p2.locator("#ncontext").inner_text()[:110].replace("\n"," | "))
    except Exception:
        step("WARN", "N5/N6 context on permalink view", "empty (data-dependent for this notice)")
    p2.close()

    # ---------- solicitation path: flags don't crash, ad-window formula only fires when valid ----------
    page.goto(BASE + "#money", timeout=30000)
    page.wait_for_selector("#list .row", timeout=30000)
    page.wait_for_selector("#detail #dcontext", timeout=15000)
    page.wait_for_timeout(4000)  # let async fill settle
    sol = page.evaluate("""(()=>{const el=document.querySelector('#dcontext');
        const r=currentRows[0];
        const w=Math.round((new Date(r.due_date)-new Date(r.start_date))/86400000);
        return {window:w, html:(el?el.innerText:'').slice(0,100)};})()""")
    bad = "short ad window" in sol["html"] and sol["window"] > 10
    step("OK" if not bad else "FAIL", "N5 ad-window flag only when formula holds", json.dumps(sol))

    # ---------- methodology section on about ----------
    p3 = ctx.new_page()
    p3.goto(BASE + "about.html#context", timeout=30000)
    ok = p3.evaluate("!!document.getElementById('context') && document.body.textContent.includes('statistical context, not')")
    step("OK" if ok else "FAIL", "methodology section on about.html#context", "")
    p3.close()

    # ---------- regressions ----------
    page.click("#tabbtn-rules")
    page.wait_for_selector("#rulesfeed .fcard", timeout=30000)
    step("OK", "regression: rules feed", "")
    strip = page.evaluate("!document.getElementById('todaystrip').hidden")
    step("OK" if strip else "FAIL", "regression: today strip", "")

    step("OK" if not errors else "FAIL", "zero page errors", "; ".join(errors[:5]))
    browser.close()

fails = [r for r in results if r[0]=="FAIL"]
print("\n=== SUMMARY:", "PASS" if not fails else f"FAIL ({len(fails)})", "===")
sys.exit(1 if fails else 0)
