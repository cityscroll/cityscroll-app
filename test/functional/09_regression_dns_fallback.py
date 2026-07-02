"""Regression for the 2026-07-02 share failure (James, agency 'City Planning Commission'):
api.crol-list.org unreachable (stale NXDOMAIN) must NOT kill worker features — workerFetch
fails over to the workers.dev alias. Runs the pin→share flow twice: healthy DNS and NXDOMAIN."""
import os, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
results = []
def step(tag, name, detail=""):
    results.append((tag, name))
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)

def run_share(pw, rules_suffix, label):
    args = [f"--host-resolver-rules=MAP api.crol-list.org {rules_suffix}"] if rules_suffix else []
    b = pw.chromium.launch(args=args)
    page = b.new_context().new_page()
    page.goto(BASE + "#agency/City%20Planning%20Commission", timeout=30000)
    page.wait_for_function("document.querySelector('#entityview .agencybar') || (document.querySelector('#entityview .empty') && !document.querySelector('#entityview .loading'))", timeout=45000)
    if page.locator("[data-pin]").count():
        page.locator("[data-pin]").first.click()
        page.wait_for_timeout(300)
    page.goto(BASE + "#investigation", timeout=30000)
    page.wait_for_selector("#invshare", timeout=15000)
    page.click("#invshare")
    page.wait_for_function("document.querySelector('#invmsg').textContent.length > 5 && !document.querySelector('#invmsg .loading')", timeout=45000)
    msg = page.locator("#invmsg").inner_text()
    ok = "Read-only link" in msg
    step("OK" if ok else "FAIL", f"share under {label}", msg[:90])
    b.close()

with sync_playwright() as pw:
    healthy = os.environ.get("CROL_DNS_IP", "")  # pin if the local resolver is stale; else use real DNS
    run_share(pw, healthy, "healthy DNS")
    run_share(pw, "~NOTFOUND", "NXDOMAIN (stale-resolver simulation)")

fails = [r for r in results if r[0] == "FAIL"]
print("\n=== SUMMARY:", "PASS" if not fails else f"FAIL ({len(fails)})", "===")
sys.exit(1 if fails else 0)
