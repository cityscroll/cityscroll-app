"""Follow/calendar discovery browser case.

Verifies Browse exposes Get email updates and feed-reader disclosure beside the
existing Subscribe to calendar control, without creating a subscription on open.
"""
import os
import re
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
_ARGS = ["--host-resolver-rules=MAP api.cityscroll.org " + os.environ["CROL_DNS_IP"]] if os.environ.get("CROL_DNS_IP") else []

results = []


def step(tag, name, detail=""):
    results.append((tag, name))
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


with sync_playwright() as pw:
    browser = pw.chromium.launch(args=_ARGS)
    page = browser.new_context(viewport={"width": 1440, "height": 1000}).new_page()
    page.goto(BASE + "browse/meetings/?agency=City%20Planning", timeout=30000)
    page.wait_for_selector("[data-follow-discovery='1'], .calendar-subscribe-btn, .browse-build-view", timeout=20000)
    html = page.content()
    has_group = 'data-follow-discovery="1"' in html
    has_follow = "Get email updates" in html
    has_calendar = "Subscribe to calendar" in html
    has_feeds = "Feed reader links" in html
    calendar_buttons = len(re.findall(r'class="calendar-subscribe-btn"', html))
    step("OK" if has_group and has_follow and has_calendar and has_feeds else "FAIL",
         "browse follow discovery group",
         f"group={has_group} follow={has_follow} calendar={has_calendar} feeds={has_feeds} calendar_btns={calendar_buttons}")
    step("OK" if calendar_buttons == 1 else "FAIL", "single calendar subscribe control", str(calendar_buttons))

    phone = browser.new_context(viewport={"width": 390, "height": 844}).new_page()
    phone.goto(BASE + "browse/meetings/?agency=City%20Planning", timeout=30000)
    phone.wait_for_selector("[data-follow-discovery='1'], .browse-build-view", timeout=20000)
    phone_html = phone.content()
    step("OK" if 'data-follow-discovery="1"' in phone_html and "Get email updates" in phone_html else "FAIL",
         "phone browse follow discovery")

    now = browser.new_context(viewport={"width": 1440, "height": 1000}).new_page()
    now.goto(BASE + "now/", timeout=30000)
    now.wait_for_selector("[data-follow-discovery-surface='now'], .now-surface", timeout=20000)
    now_html = now.content()
    step("OK" if 'data-follow-discovery-surface="now"' in now_html else "FAIL", "now follow discovery")

    browser.close()

failed = [name for tag, name in results if tag == "FAIL"]
sys.exit(1 if failed else 0)
