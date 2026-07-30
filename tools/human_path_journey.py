#!/usr/bin/env python3
"""Headless human-path journey for post-flip verification.

Incident class: owner-manually-found-the-site-down
Field case (2026-07-30): deploy pipelines stayed green while a human browse of
cityscroll.org hit ERR_TOO_MANY_REDIRECTS. This script exercises the visitor
path that a person actually walks: home → search list → notice detail → deep
link → subscribe surface, asserting real content at each step.

Usage:
  CROL_BASE=https://cityscroll.org/ python3 tools/human_path_journey.py --json
  python3 tools/human_path_journey.py --base https://cityscroll.org/ --json

Exit 0 when all steps pass; non-zero otherwise. With --json, the last stdout
line is a machine-readable report for tools/post_flip_checks.mjs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright


def step(steps: list, ok: bool, name: str, detail: str = "") -> None:
    steps.append({"ok": ok, "name": name, "detail": detail})
    tag = "OK" if ok else "FAIL"
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def run_journey(base: str, timeout_ms: int = 45_000) -> dict:
    steps: list[dict] = []
    base = base if base.endswith("/") else base + "/"
    t0 = time.time()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        # --- home ---
        try:
            page.goto(base, wait_until="domcontentloaded", timeout=timeout_ms)
            # CityScroll marker in title or body
            title = page.title() or ""
            body_text = page.inner_text("body")[:2000]
            has_brand = "CityScroll" in title or "CityScroll" in body_text
            # Money list rows (default tab)
            page.wait_for_selector("#list .row", timeout=timeout_ms)
            n_rows = page.locator("#list .row").count()
            step(
                steps,
                has_brand and n_rows > 0,
                "home-browse",
                f"title={title!r} rows={n_rows}",
            )
        except Exception as exc:  # noqa: BLE001 — journey must never raise to caller
            step(steps, False, "home-browse", str(exc)[:300])
            browser.close()
            return {"ok": False, "steps": steps, "elapsed_s": time.time() - t0}

        # --- search / list content ---
        try:
            # Prefer a keyword filter if present; otherwise assert list already has rows.
            if page.locator("#kw").count():
                page.fill("#kw", "housing")
                page.wait_for_timeout(800)
            page.wait_for_selector("#list .row", timeout=timeout_ms)
            n_rows = page.locator("#list .row").count()
            head = ""
            if page.locator("#reshead").count():
                head = page.inner_text("#reshead")[:120]
            step(steps, n_rows > 0, "search-list", f"rows={n_rows} head={head!r}")
        except Exception as exc:  # noqa: BLE001
            step(steps, False, "search-list", str(exc)[:300])

        # --- notice detail ---
        notice_id = None
        try:
            page.locator("#list .row").first.click()
            page.wait_for_selector("#dcopy, #detail, .detail", timeout=timeout_ms)
            detail_text = page.inner_text("body")[:4000]
            # Prefer request id from page state when available
            notice_id = page.evaluate(
                """() => {
                  try {
                    if (typeof currentRows !== 'undefined' && currentRows && currentRows[0])
                      return currentRows[0].request_id || currentRows[0].id || null;
                  } catch (e) {}
                  const h = location.hash || '';
                  const m = h.match(/notice\\/([^/?#]+)/);
                  return m ? decodeURIComponent(m[1]) : null;
                }"""
            )
            has_detail = (
                "CityScroll" in detail_text
                and (bool(notice_id) or "notice" in (page.evaluate("location.hash") or "").lower()
                     or page.locator("#dcopy").count() > 0)
            )
            step(
                steps,
                has_detail,
                "notice-detail",
                f"id={notice_id!r} hash={page.evaluate('location.hash')!r}",
            )
        except Exception as exc:  # noqa: BLE001
            step(steps, False, "notice-detail", str(exc)[:300])

        # --- deep link ---
        try:
            if not notice_id:
                notice_id = page.evaluate(
                    """() => {
                      try {
                        if (typeof currentRows !== 'undefined' && currentRows && currentRows[0])
                          return currentRows[0].request_id || null;
                      } catch (e) {}
                      return null;
                    }"""
                )
            if notice_id:
                deep = f"{base}#notice/{notice_id}"
                page.goto(deep, wait_until="domcontentloaded", timeout=timeout_ms)
                page.wait_for_timeout(1200)
                hash_now = page.evaluate("location.hash") or ""
                body = page.inner_text("body")[:3000]
                ok = "CityScroll" in body and (
                    notice_id in hash_now or notice_id in body or page.locator("#dcopy").count() > 0
                )
                step(steps, ok, "deeplink-notice", f"url={deep} hash={hash_now!r}")
            else:
                step(steps, False, "deeplink-notice", "no request_id available for deep link")
        except Exception as exc:  # noqa: BLE001
            step(steps, False, "deeplink-notice", str(exc)[:300])

        # --- subscribe surface ---
        try:
            # Alerts tab hosts the subscribe form (#asubscribe)
            if page.locator('.tabbtn[data-tab="alerts"]').count():
                page.click('.tabbtn[data-tab="alerts"]')
                page.wait_for_timeout(500)
            page.wait_for_selector("#asubscribe", timeout=timeout_ms)
            visible = page.is_visible("#asubscribe")
            label = page.inner_text("#asubscribe")[:80] if visible else ""
            step(
                steps,
                visible and len(label) > 0,
                "subscribe-surface",
                f"visible={visible} label={label!r}",
            )
        except Exception as exc:  # noqa: BLE001
            step(steps, False, "subscribe-surface", str(exc)[:300])

        browser.close()

    ok = all(s["ok"] for s in steps) and len(steps) >= 5
    return {
        "ok": ok,
        "steps": steps,
        "elapsed_s": round(time.time() - t0, 2),
        "base": base,
        "incident_class": "owner-manually-found-the-site-down",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="CityScroll human-path journey")
    parser.add_argument(
        "--base",
        default=os.environ.get("CROL_BASE", "https://cityscroll.org/"),
        help="Site base URL (default CROL_BASE or https://cityscroll.org/)",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine JSON report on stdout")
    parser.add_argument("--timeout-ms", type=int, default=45_000)
    args = parser.parse_args()

    report = run_journey(args.base, timeout_ms=args.timeout_ms)
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        print(
            f"human-path journey {'PASS' if report['ok'] else 'FAIL'} "
            f"in {report['elapsed_s']}s ({len(report['steps'])} steps)",
            flush=True,
        )
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
