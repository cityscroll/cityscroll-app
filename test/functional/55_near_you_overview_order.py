#!/usr/bin/env python3
"""Near You keeps place choice and the overview ahead of long result surfaces."""

from __future__ import annotations

import os

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000").rstrip("/")


def observe(page, route: str, width: int) -> dict:
    page.set_viewport_size({"width": width, "height": 900})
    page.goto(f"{BASE}{route}", wait_until="domcontentloaded")
    page.locator("[data-near-you-root]").wait_for()
    return page.evaluate("""() => {
      const root = document.querySelector('[data-near-you-root]');
      const rect = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return {top: box.top, bottom: box.bottom, width: box.width, height: box.height};
      };
      const order = selector => getComputedStyle(document.querySelector(selector)).order;
      return {
        hero: rect('.near-hero'), place: rect('.near-place-guide'), overview: rect('.near-overview'),
        switch: rect('.near-surface-switch'), results: rect('.near-results'),
        order: {hero: order('.near-hero'), place: order('.near-place-guide'), overview: document.querySelector('.near-overview') ? order('.near-overview') : null, switch: order('.near-surface-switch')},
        rootHeight: root.getBoundingClientRect().height,
      };
    }""")


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        root = observe(page, "/near-you/", 1200)
        chosen = observe(page, "/near-you/?v=0&boro=Queens&cd=Q04", 1200)
        mobile = observe(page, "/near-you/?v=0&boro=Queens&cd=Q04", 390)
        no_script = browser.new_context(viewport={"width": 390, "height": 900}, java_script_enabled=False).new_page()
        no_script.goto(f"{BASE}/near-you/?v=0&boro=Queens&cd=Q04", wait_until="domcontentloaded")
        no_script.locator("[data-near-you-root]").wait_for()
        assert no_script.locator("h1").inner_text() == "Queens Community District 4"
        assert no_script.locator(".near-place-guide").is_visible()
        assert no_script.locator(".near-surface-switch").is_visible()
        browser.close()

    for name, observation in (("root", root), ("chosen", chosen), ("mobile", mobile)):
        assert observation["hero"], (name, observation)
        assert observation["place"], (name, observation)
        assert observation["order"]["hero"] == "1", (name, observation)
        assert observation["order"]["place"] == "2", (name, observation)
        assert observation["place"]["top"] < observation["switch"]["top"], (name, observation)
    assert root["overview"] is None, root
    assert chosen["overview"], chosen
    assert chosen["overview"]["top"] >= chosen["place"]["bottom"], chosen
    assert chosen["overview"]["height"] < 2400, chosen
    assert chosen["switch"]["top"] < chosen["overview"]["bottom"], chosen
    print("PASS: Near You place-first overview geometry")


if __name__ == "__main__":
    main()
