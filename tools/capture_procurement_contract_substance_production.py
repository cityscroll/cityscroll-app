#!/usr/bin/env python3
"""Capture the named contract-substance route in real headless Chromium.

This records DOM facts and textual render hashes only. Screenshots and other
image binaries are intentionally not produced.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys

from playwright.sync_api import sync_playwright


CONTRACT_ID = "CT107120258801626"
ROUTE = f"/procurements/procurement%3Acontract%3A{CONTRACT_ID}/"
EXPECTED = {
    "contract_id": CONTRACT_ID,
    "vendor": "BHRAGS HOME CARE CORP",
    "authorized_total": 10869881,
    "paid_total": 7385672.19,
    "payment_count": 31,
    "notice_id": "20240829105",
    "address": "3218 Emmons Avenue, Brooklyn",
    "units": 60,
    "place_role": "facility_site",
    "neighborhood": "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
}


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def capture(site: str) -> dict:
    base = site.rstrip("/")
    observations = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for viewport, width, height in (("desktop", 1440, 900), ("mobile", 390, 844)):
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()
            url = f"{base}{ROUTE}"
            response = page.goto(url, wait_until="domcontentloaded", timeout=90_000)
            page.wait_for_function(
                """() => document.readyState === 'complete'
                    && !!document.querySelector('[data-substance-authorized-total]')
                    && !!document.querySelector('[data-substance-place-role]')""",
                timeout=90_000,
            )
            page.wait_for_timeout(100)
            markup = page.content()
            facts = page.evaluate(
                """() => {
                  const text = document.body?.innerText || '';
                  const paymentNote = text.match(/Showing\\s+\\d+\\s+of\\s+(\\d+)\\s+payments/i);
                  const authorized = document.querySelector('[data-substance-authorized-total]')?.textContent || '';
                  const paid = document.querySelector('[data-substance-paid-total]')?.textContent || '';
                  const place = document.querySelector('[data-substance-place-role="facility_site"]');
                  const placeText = place?.innerText || '';
                  const geography = [...document.querySelectorAll('[data-geography-key]')]
                    .map((node) => (node.textContent || '').trim().split(' · ')[0])
                    .find((value) => value === 'Sheepshead Bay-Manhattan Beach-Gerritsen Beach') || '';
                  return {
                    contract_id: text.includes('CT107120258801626') ? 'CT107120258801626' : null,
                    vendor: text.includes('BHRAGS HOME CARE CORP') ? 'BHRAGS HOME CARE CORP' : null,
                    authorized_total: authorized.includes('$10,869,881') ? 10869881 : null,
                    paid_total: paid.includes('$7,385,672.19') ? 7385672.19 : null,
                    payment_count: paymentNote ? Number(paymentNote[1]) : null,
                    notice_id: text.includes('20240829105') ? '20240829105' : null,
                    address: placeText.includes('3218 Emmons Avenue, Brooklyn') ? '3218 Emmons Avenue, Brooklyn' : null,
                    units: placeText.includes('60 units') ? 60 : null,
                    place_role: place?.getAttribute('data-substance-place-role') || null,
                    neighborhood: geography || null,
                  };
                }"""
            )
            observations.append({
                "viewport": viewport,
                "width": width,
                "height": height,
                "url": page.url,
                "http_status": response.status if response else None,
                "render_hash": sha256_text(markup),
                "rendered": True,
                "initialization": "settled",
                "facts": facts,
            })
            context.close()
        browser.close()
    return {"site": base, "route": ROUTE, "expected": EXPECTED, "observations": observations}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", default="https://cityscroll.org")
    parser.add_argument("--json-stdout", action="store_true")
    args = parser.parse_args()
    payload = capture(args.site)
    if args.json_stdout:
        json.dump(payload, sys.stdout, separators=(",", ":"))
        sys.stdout.write("\n")
    else:
        print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
