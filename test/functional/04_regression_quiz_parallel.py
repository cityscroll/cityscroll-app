"""Repro: quiz topic switch must not leak the previous topic's param (79 Rivington)."""
import sys
from playwright.sync_api import sync_playwright
import os
BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
_ARGS = ["--host-resolver-rules=MAP api.crol-list.org " + os.environ["CROL_DNS_IP"]] if os.environ.get("CROL_DNS_IP") else []
SHOT = os.environ.get("CROL_SHOTS", os.path.dirname(os.path.abspath(__file__)) + "/shots") + "/"
os.makedirs(SHOT, exist_ok=True)



fails = []
def step(ok, name, detail=""):
    print(("OK " if ok else "FAIL"), name, "->", detail, flush=True)
    if not ok: fails.append(name)

with sync_playwright() as pw:
    b = pw.chromium.launch(); page = b.new_context().new_page()
    errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "#alerts", timeout=30000)
    page.wait_for_selector("#quizpanel", timeout=15000)

    # 1) rezonings first (this used to plant "79 Rivington"), then rules, no narrowing
    page.click('#quizwhat .chip[data-w="rezone"]')
    page.click('#quizwhat .chip[data-w="rules"]')
    page.click("#quizgo")
    page.wait_for_selector("#apreviewbox .emailmock", timeout=30000)
    st = page.evaluate("({param:document.getElementById('aparam').value, subj:document.querySelector('#apreviewbox .esubj').textContent})")
    leak = "rivington" in (st["param"] + st["subj"]).lower()
    step(not leak and st["param"] == "", "rules after rezone: no 79-Rivington leak, param empty", str(st))

    # 2) same sweep across the other section topics
    for w in ["property", "meetings"]:
        page.click('#quizwhat .chip[data-w="rezone"]')
        page.click(f'#quizwhat .chip[data-w="{w}"]')
        page.click("#quizgo")
        page.wait_for_selector("#apreviewbox .emailmock", timeout=30000)
        st = page.evaluate("({param:document.getElementById('aparam').value, subj:document.querySelector('#apreviewbox .esubj').textContent})")
        step("rivington" not in (st["param"] + st["subj"]).lower(), f"{w} after rezone: no leak", str(st))

    # 3) parallel default: rezone itself with NO narrowing = citywide, not a hardcoded address
    page.click('#quizwhat .chip[data-w="rezone"]')
    page.click("#quizgo")
    page.wait_for_selector("#apreviewbox .emailmock", timeout=30000)
    st = page.evaluate("({param:document.getElementById('aparam').value, subj:document.querySelector('#apreviewbox .esubj').textContent})")
    step("rivington" not in (st["param"] + st["subj"]).lower(), "rezone with no narrowing: citywide default, no hardcoded address", str(st))

    # 4) manual builder: switching the dropdown also clears the stale param
    page.select_option("#awatch", "rezone"); page.fill("#aparam", "79 Rivington")
    page.select_option("#awatch", "rules")
    v = page.input_value("#aparam")
    step(v == "", "builder dropdown switch clears param", repr(v))

    # 5) typing a narrowing still works
    page.click('#quizwhat .chip[data-w="rules"]')
    page.fill("#quiznarrow", "sidewalk")
    page.click("#quizgo")
    page.wait_for_selector("#apreviewbox .emailmock", timeout=30000)
    subj = page.locator("#apreviewbox .esubj").inner_text()
    step("sidewalk" in subj, "explicit narrowing still applies", subj)

    step(not errors, "zero page errors", "; ".join(errors[:3]))
    b.close()

print("\n=== SUMMARY:", "PASS" if not fails else f"FAIL ({len(fails)})", "===")
sys.exit(1 if fails else 0)
