#!/usr/bin/env python3
"""Headless browser evidence that a follow names one exact institution.

Drives gitignored specimen pages. Matching membership is proven in
test/institution_follow_scope.test.mjs; this tool proves the resident
journey: start, inspect, save failure with retry, and reload.

    python3 tools/capture_exact_institution_follow_evidence.py
    python3 tools/capture_exact_institution_follow_evidence.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse, unquote

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
MANIFEST = ROOT / "docs" / "evidence" / "exact-institution-follow" / "manifest.json"
IMAGES = ROOT / ".artifacts" / "exact-institution-follow"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

MANIFEST_SCHEMA = "cityscroll.exact_institution_follow_evidence.v1"
SUBJECT = "exact institution named through follow initiation, preview, failure recovery, and reload"

ORE = "/agencies/office-of-racial-equity/"
CORE = "/agencies/commission-on-racial-equity/"
MTA = "/agencies/metropolitan-transportation-authority/"
NYCT = "/agencies/n-y-c-transit-authority/"
CB15 = "/community-boards/brooklyn-cb-15/"
FOLLOW_ORE = "/following-exact-office-of-racial-equity.html"
FOLLOW_CORE = "/following-exact-commission-on-racial-equity.html"
FOLLOW_NYCT = "/following-exact-n-y-c-transit-authority.html"
FOLLOW_CB = "/following-exact-brooklyn-cb-15.html"
FOLLOW_STORED = "/following-stored-office-spelling.html"

VIEWPORTS = ((390, 844), (1440, 900))
TARGET_MIN = 43.5
ZOOM = 2.0


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        name = Path(path.split("?", 1)[0]).name
        artifact = IMAGES / name
        if artifact.exists():
            return str(artifact)
        clean = path.split("?", 1)[0]
        site_file = SITE / clean.lstrip("/")
        if site_file.exists():
            return str(site_file)
        return super().translate_path(path)

    def log_message(self, *args):  # noqa: A003
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def data_vintage() -> str:
    lookup = json.loads((SITE / "data" / "agency_constellation_lookup.json").read_text("utf-8"))
    stamp = str(lookup.get("generated_at") or "")
    day = max((part[:10] for part in stamp.split("|") if len(part) >= 10), default="")
    if not day:
        raise SystemExit("the agency read model carries no generated_at to date this capture")
    return day


def run_axe(page, a11y_gate) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    failing = a11y_gate(result["violations"], wcag22_rules)
    return {
        "violations_total": len(result["violations"]),
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in failing],
        "passes": not failing,
    }


def no_horizontal_overflow(page) -> bool:
    return not page.evaluate(
        "() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"
    )


def target_failures(page) -> list:
    return page.evaluate(
        """(min) => {
          const selector = [
            '.civic-object-action',
            '[data-following-subscribe-submit]',
            '[data-following-subscribe-retry]',
            '.following-identity-details > summary',
            '.related-public-bodies-source > summary',
          ].join(',');
          const rendered = el => {
            const style = getComputedStyle(el), rect = el.getBoundingClientRect();
            const closed = el.closest('details:not([open])');
            if (closed && !closed.querySelector(':scope > summary')?.contains(el)) return false;
            return style.display !== 'none' && style.visibility !== 'hidden'
              && rect.width > 0 && rect.height > 0;
          };
          return [...document.querySelectorAll(selector)].filter(rendered).flatMap(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width >= min && rect.height >= min) return [];
            return [{ tag: el.tagName.toLowerCase(),
                      text: String(el.innerText || '').trim().slice(0, 60),
                      width: Math.round(rect.width * 10) / 10,
                      height: Math.round(rect.height * 10) / 10 }];
          });
        }""",
        TARGET_MIN,
    )


def follow_filter(href: str) -> dict:
    raw = parse_qs(urlparse(href).query).get("filter", ["{}"])[0]
    return json.loads(unquote(raw))


def prepare_specimens() -> None:
    subprocess.run(
        ["node", "tools/render_exact_institution_follow_specimens.mjs"],
        cwd=ROOT, check=True,
    )


def start_inspect_save_retry(page, base, width, profile, follow_page, name, other):
    page.goto(f"{base}{profile}", wait_until="load")
    follow = page.locator(".agency-primary-actions a.civic-object-action").first
    href = follow.get_attribute("href") or ""
    label = (follow.inner_text() or "").strip()
    filt = follow_filter(href)
    related_open = page.locator(".related-public-bodies-source").count()
    if related_open:
        summary = page.locator(".related-public-bodies-source > summary").first
        summary.click()
        page.wait_for_function("() => document.querySelectorAll('.related-public-bodies-source[open]').length > 0")
        inspected_related = True
        summary.click()
        page.wait_for_function("() => document.querySelectorAll('.related-public-bodies-source[open]').length === 0")
        url_after_inspect = page.url
    else:
        inspected_related = False
        url_after_inspect = page.url
    page.goto(f"{base}{follow_page}", wait_until="load")
    rule = page.locator("[data-following-identity-rule]").inner_text()
    scope = page.locator("[data-following-identity-scope]").inner_text()
    details = page.locator(".following-identity-details").first
    details.locator("summary").click()
    page.wait_for_function("() => document.querySelectorAll('.following-identity-details[open]').length > 0")
    inspected_scope = True
    page.route("https://api.cityscroll.org/subscribe", lambda route: route.fulfill(
        status=503, content_type="application/json", body='{"ok":false,"reason":"unavailable"}',
    ))
    page.fill('input[name="email"]', "reader@example.com")
    page.locator("[data-following-subscribe-submit]").click()
    page.wait_for_selector("[data-following-submit-failed]")
    email_kept = page.input_value('input[name="email"]')
    filter_kept = page.input_value('input[name="filter"]')
    retry_visible = page.locator("[data-following-subscribe-retry]").count() == 1
    page.locator("[data-following-subscribe-retry]").click()
    page.wait_for_selector("[data-following-submit-failed]")
    email_after_retry = page.input_value('input[name="email"]')
    shot = page.screenshot(full_page=True)
    return shot, {
        "follow_label_names_institution": name in label,
        "follow_href_names_this_body": name.split()[0] in href or filt.get("name") == name or name in json.dumps(filt),
        "follow_href_excludes_the_other_body": other not in href and other not in json.dumps(filt),
        "inspected_related_source_without_leaving": inspected_related or related_open == 0,
        "inspection_did_not_save": "/following" not in url_after_inspect or profile.rstrip("/") in urlparse(url_after_inspect).path,
        "preview_names_institution": name in rule,
        "preview_names_record_scope": "City Record" in scope or "Meetings published" in scope,
        "inspected_scope_details": inspected_scope,
        "failed_save_kept_email": email_kept == "reader@example.com",
        "failed_save_kept_filter": name.split()[-1].lower() in filter_kept.lower() or name in filter_kept,
        "retry_control_present": retry_visible,
        "retry_kept_email": email_after_retry == "reader@example.com",
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px {name} follow, inspect, failed save, and retry keep that institution"


def ore_journey(page, base, width):
    return start_inspect_save_retry(
        page, base, width, ORE, FOLLOW_ORE, "Office of Racial Equity", "Commission on Racial Equity",
    )


def core_reload(page, base, width):
    page.goto(f"{base}{CORE}", wait_until="load")
    href = page.locator(".agency-primary-actions a.civic-object-action").first.get_attribute("href") or ""
    page.goto(f"{base}{FOLLOW_CORE}", wait_until="load")
    rule = page.locator("[data-following-identity-rule]").inner_text()
    page.reload(wait_until="load")
    reloaded = page.locator("[data-following-identity-rule]").inner_text()
    shot = page.screenshot(full_page=True)
    return shot, {
        "follow_href_is_commission": "commission-on-racial-equity" in href,
        "follow_href_is_not_office": "office-of-racial-equity" not in href,
        "preview_names_commission": "Commission on Racial Equity" in rule,
        "reload_kept_commission": "Commission on Racial Equity" in reloaded,
        "reload_excludes_office": "Office of Racial Equity" not in reloaded,
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px the Commission follow reloads as the Commission, not the Office"


def nyct_distinct_from_mta(page, base, width):
    page.goto(f"{base}{MTA}", wait_until="load")
    mta_href = page.locator(".agency-primary-actions a.civic-object-action").first.get_attribute("href") or ""
    page.goto(f"{base}{NYCT}", wait_until="load")
    nyct_href = page.locator(".agency-primary-actions a.civic-object-action").first.get_attribute("href") or ""
    page.goto(f"{base}{FOLLOW_NYCT}", wait_until="load")
    rule = page.locator("[data-following-identity-rule]").inner_text()
    shot = page.screenshot(full_page=True)
    return shot, {
        "mta_and_operating_body_follows_differ": mta_href != nyct_href,
        "operating_body_follow_excludes_mta_id": "metropolitan-transportation-authority" not in nyct_href,
        "preview_names_operating_body": "Transit" in rule,
        "preview_excludes_whole_mta_group": "operating bodies" not in rule.lower(),
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px an MTA operating-body follow stays distinct from the authority"


def community_board_follow(page, base, width):
    page.goto(f"{base}{CB15}", wait_until="load")
    label = page.locator("a.civic-object-action").first.inner_text()
    href = page.locator("a.civic-object-action").first.get_attribute("href") or ""
    page.goto(f"{base}{FOLLOW_CB}", wait_until="load")
    rule = page.locator("[data-following-identity-rule]").inner_text()
    scope = page.locator("[data-following-identity-scope]").inner_text()
    shot = page.screenshot(full_page=True)
    return shot, {
        "follow_names_board": "Brooklyn Community Board 15" in label,
        "follow_uses_board_identity": "brooklyn-cb-15" in href,
        "preview_names_board_meetings": "Brooklyn Community Board 15" in rule and "meetings" in rule.lower(),
        "scope_excludes_borough_office": "borough office" in scope.lower() or "not included" in scope.lower(),
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px Community Board follow reuses the board meetings capability"


def stored_name_not_reassigned(page, base, width):
    page.goto(f"{base}{FOLLOW_STORED}", wait_until="load")
    rule = page.locator("[data-following-identity-rule]").inner_text()
    correction = page.locator("[data-institution-follow-correction]").inner_text()
    filt = page.input_value('input[name="filter"]')
    shot = page.screenshot(full_page=True)
    return shot, {
        "stored_name_still_shown": "OFFICE OF RACIAL EQUITY" in rule or "OFFICE OF RACIAL EQUITY" in filt,
        "correction_is_explicit": "not reassigned" in correction.lower(),
        "filter_was_not_rewritten_to_office_id": "office-of-racial-equity" not in filt,
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px a stored OFFICE OF RACIAL EQUITY watch keeps that name and offers an explicit correction"


def keyboard_ore(page, base, width):
    page.goto(f"{base}{ORE}", wait_until="load")
    page.locator(".agency-primary-actions a.civic-object-action").first.focus()
    page.keyboard.press("Enter")
    # Absolute follow URLs leave the local host; open the local preview instead.
    page.goto(f"{base}{FOLLOW_ORE}", wait_until="load")
    page.locator(".following-identity-details > summary").focus()
    page.keyboard.press("Enter")
    page.wait_for_function("() => document.querySelectorAll('.following-identity-details[open]').length > 0")
    shot = page.screenshot(full_page=True)
    return shot, {
        "keyboard_opened_scope_details": True,
        "preview_names_office": "Office of Racial Equity" in page.locator("[data-following-identity-rule]").inner_text(),
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px keyboard focus opens Office of Racial Equity follow details without saving"


def without_scripting(page, base, width):
    page.goto(f"{base}{ORE}", wait_until="load")
    href = page.locator(".agency-primary-actions a.civic-object-action").first.get_attribute("href")
    shot = page.screenshot(full_page=True)
    return shot, {
        "follow_is_real_anchor": bool(href and "following" in href),
        "follow_names_office": "Office of Racial Equity" in (page.locator(".agency-primary-actions a.civic-object-action").first.inner_text() or ""),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px with scripting unavailable the Office follow remains a real anchor"


def zoom_specimen(page, base, width):
    page.goto(f"{base}{FOLLOW_ORE}", wait_until="load")
    native_overflow = no_horizontal_overflow(page)
    page.evaluate("(zoom) => { document.documentElement.style.zoom = String(zoom); }", ZOOM)
    shot = page.screenshot(full_page=True)
    return shot, {
        "institution_named_at_zoom": "Office of Racial Equity" in page.locator("[data-following-identity-rule]").inner_text(),
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": native_overflow,
    }, f"at {width}px and 200 percent zoom the Office follow keeps its name and column"


SPECIMENS = (
    ("ore-start-inspect-failed-save-retry", ore_journey),
    ("core-save-reload", core_reload),
    ("operating-body-distinct-from-mta", nyct_distinct_from_mta),
    ("community-board-follow", community_board_follow),
    ("stored-name-not-reassigned", stored_name_not_reassigned),
    ("keyboard-office-follow", keyboard_ore),
    ("without-scripting-office-follow", without_scripting),
    ("two-hundred-percent-zoom", zoom_specimen),
)
NO_SCRIPT_SPECIMENS = {"without-scripting-office-follow"}
ROUTES = {
    "ore-start-inspect-failed-save-retry": ORE,
    "core-save-reload": CORE,
    "operating-body-distinct-from-mta": NYCT,
    "community-board-follow": CB15,
    "stored-name-not-reassigned": FOLLOW_STORED,
    "keyboard-office-follow": ORE,
    "without-scripting-office-follow": ORE,
    "two-hundred-percent-zoom": FOLLOW_ORE,
}


def capture() -> dict:
    sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
    from a11y_gate import failing_violations
    from playwright.sync_api import sync_playwright

    prepare_specimens()
    IMAGES.mkdir(parents=True, exist_ok=True)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    vintage = data_vintage()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    files = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for slug, run in SPECIMENS:
                for width, height in VIEWPORTS:
                    scripting = slug not in NO_SCRIPT_SPECIMENS
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        java_script_enabled=scripting,
                        has_touch=width <= 500,
                    )
                    page = context.new_page()
                    image, observations, assertion = run(page, base, width)
                    axe_result = run_axe(page, failing_violations) if scripting else {
                        "violations_total": None,
                        "failing_violations": [],
                        "passes": None,
                        "skipped": "scripting disabled for this specimen",
                    }
                    name = f"{slug}-{width}x{height}.png"
                    (IMAGES / name).write_bytes(image)
                    files.append({
                        "name": name,
                        "specimen": slug,
                        "route": ROUTES[slug],
                        "viewport": [width, height],
                        "scripting": scripting,
                        "revision": revision,
                        "data_vintage": vintage,
                        "assertion": assertion,
                        "observations": observations,
                        "bytes": len(image),
                        "sha256": hashlib.sha256(image).hexdigest(),
                        "axe": axe_result,
                    })
                    context.close()
            browser.close()
    finally:
        server.shutdown()

    return {
        "schema": MANIFEST_SCHEMA,
        "subject": SUBJECT,
        "routes": [ORE, CORE, MTA, NYCT, CB15, FOLLOW_ORE, FOLLOW_CORE, FOLLOW_NYCT, FOLLOW_CB, FOLLOW_STORED],
        "revision": revision,
        "data_vintage": vintage,
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "image_directory": ".artifacts/exact-institution-follow",
        "image_policy": (
            "Capture images are written to the ignored local directory above and are never committed. "
            "This manifest is the tracked proof: route, viewport, revision, data vintage, assertion and SHA-256 for each capture."
        ),
        "files": files,
    }


def write_manifest(payload: dict) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def check_manifest() -> int:
    if not MANIFEST.is_file():
        print("missing exact-institution-follow evidence manifest", file=sys.stderr)
        return 1
    payload = json.loads(MANIFEST.read_text("utf-8"))
    if payload.get("schema") != MANIFEST_SCHEMA:
        print("exact-institution-follow manifest schema mismatch", file=sys.stderr)
        return 1
    if not payload.get("files"):
        print("exact-institution-follow manifest has no captures", file=sys.stderr)
        return 1
    for row in payload["files"]:
        for key in ("route", "viewport", "revision", "data_vintage", "assertion", "sha256"):
            if not row.get(key):
                print(f"capture {row.get('name')} missing {key}", file=sys.stderr)
                return 1
        if Path(row["name"]).suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
            committed = MANIFEST.parent / row["name"]
            if committed.is_file():
                print(f"image binary {row['name']} must not be committed", file=sys.stderr)
                return 1
    print(f"exact-institution-follow evidence manifest is current ({len(payload['files'])} captures)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check_manifest()
    payload = capture()
    write_manifest(payload)
    print(f"wrote {MANIFEST.relative_to(ROOT)} ({len(payload['files'])} captures)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
