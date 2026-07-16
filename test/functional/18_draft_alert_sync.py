"""Repro (w12-20): the 60-second quiz and "Build an alert" held SEPARATE form state, so the
quiz's chips never reached the builder's own #awatch/#aparam/#athresh fields until the quiz's
OWN Preview button ran -- and even then only in one direction. Switching the builder's watch
type directly (a normal "Advanced options" interaction), then picking a DIFFERENT topic from
the quiz, used to leave the quiz chip lit for a topic the builder was NOT actually going to
preview or save -- the site owner's words: "unaligned - shouldn't they change as each other
changes?"

Owner's field scenario: set a quiz topic, then edit the builder's amount -- preview (from
EITHER button) must reflect both.

Before this card: step 2 below (clicking the quiz's "Big contract awards" chip after the
builder had been switched to "Rule changes") left #awatch on "rules" -- the quiz chip showed
"on" for a watch type the builder's own Preview button would never actually compile. Confirmed
failing against the pre-fix index.html (git stash) before confirming it passes below.

After this card: #awatch/#athresh update live the instant the quiz chip is clicked (no Preview
click needed to observe it), so the builder's own "Preview today's digest" button and the
quiz's "Preview my digest" button always compile and describe the exact same draft.
"""
import sys
from playwright.sync_api import sync_playwright
import os
BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
_ARGS = ["--host-resolver-rules=MAP api.crol-list.org " + os.environ["CROL_DNS_IP"]] if os.environ.get("CROL_DNS_IP") else []

fails = []
def step(ok, name, detail=""):
    print(("OK " if ok else "FAIL"), name, "->", detail, flush=True)
    if not ok:
        fails.append(name)

with sync_playwright() as pw:
    b = pw.chromium.launch(args=_ARGS)
    page = b.new_context().new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "#alerts", timeout=30000)
    page.wait_for_selector("#quizpanel", timeout=15000)

    # 1) Move the builder's own select away from its default ("bigaward") -- a real
    #    "Advanced options" interaction with nothing to do with the quiz above it.
    page.select_option("#awatch", "rules")

    # 2) Now pick "Big contract awards" from the quiz -- the drift scenario: does the chip
    #    click actually reach the builder's #awatch live, or does the builder silently stay
    #    on "rules" while the chip shows "on" for a completely different watch type?
    page.click('#quizwhat .chip[data-w="bigaward"]')
    st = page.evaluate("""({
        chipOn: document.querySelector('#quizwhat .chip.on')?.dataset.w,
        watch: document.getElementById('awatch').value,
        threshVisible: getComputedStyle(document.getElementById('athresh')).display !== 'none',
    })""")
    ok = st["chipOn"] == "bigaward" and st["watch"] == "bigaward" and st["threshVisible"]
    step(ok, "quiz topic pick reaches the builder's own #awatch live, no Preview click needed", str(st))

    # 3) Edit the builder's amount directly -- an "Advanced options" edit, not through the quiz.
    page.select_option("#athresh", "10000000")

    # 4) Preview from the BUILDER's own button -- must reflect BOTH the quiz's topic pick
    #    (bigaward) AND the builder's own amount edit ($10M+), not a stale mix of the two.
    page.click("#apreview")
    page.wait_for_selector("#apreviewbox .emailmock", timeout=30000)
    subj = page.locator("#apreviewbox .esubj").inner_text()
    step("$10.00M" in subj and "award" in subj.lower(),
         "builder's own Preview button reflects the quiz pick + the amount edit together", subj)

    # 5) The quiz's own Preview button must produce the IDENTICAL description -- no path may
    #    preview one thing while the other previews (or a saved alert builds from) something else.
    page.click("#quizgo")
    page.wait_for_selector("#apreviewbox .emailmock", timeout=30000)
    subj2 = page.locator("#apreviewbox .esubj").inner_text()
    step(subj2 == subj, "quiz's own Preview button previews the SAME draft as the builder's button",
         f"{subj2!r} vs {subj!r}")

    # 6) Reverse direction: editing the builder's narrowing field live-updates the quiz's own
    #    narrow box, without any Preview click -- two-way, not quiz-writes-builder-only.
    page.select_option("#awatch", "rfpkw")
    page.fill("#aparam", "asbestos")
    mirrored = page.input_value("#quiznarrow")
    step(mirrored == "asbestos", "editing the builder's keyword field live-mirrors into the quiz's narrow box", mirrored)

    step(not errors, "zero page errors", "; ".join(errors[:3]))
    b.close()

print("\n=== SUMMARY:", "PASS" if not fails else f"FAIL ({len(fails)})", "===")
sys.exit(1 if fails else 0)
