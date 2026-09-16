#!/usr/bin/env python3
"""Browser proof for composed resident documents (notice shell, notice subject, contract evidence)."""

from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

# Imported lazily inside main for optional cases.
NOTICE_ID = "20260810048"
NOTICE_ROUTE = f"/notices/{NOTICE_ID}/"
NOTICE_SOURCE = f"https://a856-cityrecord.nyc.gov/RequestDetail/{NOTICE_ID}"
LEGACY_HASH_ROUTE = f"#notice/{NOTICE_ID}"
MANIFEST_PATH = ROOT / "docs" / "evidence" / "notice-shell" / "capture-manifest.json"

SUBJECT_NOTICE_ID = "20240829105"
SUBJECT_NOTICE_ROUTE = f"/notices/{SUBJECT_NOTICE_ID}/"
SUBJECT_CONTRACT_HREF = "/procurements/procurement%3Acontract%3ACT107120258801626"
SUBJECT_SOURCE = f"https://a856-cityrecord.nyc.gov/RequestDetail/{SUBJECT_NOTICE_ID}"
SUBJECT_MANIFEST_PATH = ROOT / "docs" / "evidence" / "notice-subject" / "capture-manifest.json"
PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
LOCAL_CONDITION = (
    "Local Wrangler Worker with HTMLRewriter and the verified public site artifact; "
    "no image binary is committed."
)
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
# Production edge refuses the default Python-urllib User-Agent (HTTP 403).
ARTIFACT_MANIFEST_UA = "cityscroll-resident-document-presentation/1"


def stage_assets() -> pathlib.Path:
    staging = pathlib.Path(tempfile.mkdtemp(prefix="cityscroll-pages-", dir=os.environ.get("CITYSCROLL_FUNCTIONAL_TMPDIR")))
    built_site = ROOT / "_site"
    if not built_site.is_dir():
        raise RuntimeError("verified _site artifact is missing; build it before running notice-shell")
    shutil.copytree(built_site, staging, copy_function=os.link, symlinks=True, dirs_exist_ok=True)
    (staging / "data" / "procurement_spine_sources.json").unlink(missing_ok=True)
    return staging


def notice_payload(case: str = "notice-shell") -> bytes:
    if case == "notice-subject":
        body = {
            "ok": True,
            "row": {
                "request_id": SUBJECT_NOTICE_ID,
                "short_title": "City Sanctuary Facility for Families with Children",
                "type_of_notice_description": "Award",
                "agency_name": "Homeless Services",
                "start_date": "2024-08-29",
                "vendor_name": "BHRAGS Operating LLC",
            },
            "civic_time": None,
        }
    else:
        body = {
            "ok": True,
            "row": {
                "request_id": NOTICE_ID,
                "short_title": "ACEDCA215 Brooklyn Childrens Museum HVAC Upgrade",
                "type_of_notice_description": "Solicitation",
                "agency_name": "Design and Construction",
                "start_date": "2026-08-14",
                "pin": "85026B0110",
            },
            "civic_time": None,
        }
    return json.dumps(body).encode()


def start_server(case: str = "notice-shell"):
    staging = stage_assets()
    state_dir = pathlib.Path(tempfile.mkdtemp(prefix="cityscroll-wrangler-", dir=os.environ.get("CITYSCROLL_FUNCTIONAL_TMPDIR")))
    from tools.local_site_server import _RobustThreadingHTTPServer

    payload = notice_payload(case)

    class ReadModelHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format, *_args):
            return

    upstream = _RobustThreadingHTTPServer(("127.0.0.1", 0), ReadModelHandler)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    config = state_dir / "wrangler.toml"
    config.write_text(
        f'name = "cityscroll-notice-local"\nmain = "{ROOT / "site" / "_worker.js"}"\ncompatibility_date = "2026-07-27"\n'
        f'[assets]\nbinding = "ASSETS"\ndirectory = "{staging}"\n', encoding="utf-8"
    )
    process = subprocess.Popen(
        ["npx", "--yes", "wrangler@4.126.0", "dev",
         "--config", str(config), "--ip", "127.0.0.1", "--port", "0",
         "--compatibility-date", "2026-07-27", "--var", f"NOTICE_READ_MODEL=http://127.0.0.1:{upstream.server_port}/notice",
         "--persist-to", str(state_dir),
         "--show-interactive-dev-session", "false"],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    base = ""
    output_lines = []
    for _ in range(120):
        line = process.stdout.readline() if process.stdout else ""
        output_lines.append(line)
        match = re.search(r"Ready on (http://127\.0\.0\.1:\d+)", line)
        if match:
            base = f"{match.group(1)}/"
            break
        if process.poll() is not None:
            break
    if not base:
        output = "".join(output_lines) + (process.stdout.read() if process.stdout else "")
        process.terminate()
        upstream.shutdown()
        upstream.server_close()
        raise RuntimeError(f"wrangler dev did not become ready: {output[-2000:]}")
    return process, staging, state_dir, base, upstream


def render_hash(page) -> str:
    content = page.locator("#main").inner_text()
    return hashlib.sha256(content.encode()).hexdigest()


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def is_production_base(base: str) -> bool:
    host = (urllib.parse.urlparse(normalize_base(base)).hostname or "").lower()
    return host in PRODUCTION_HOSTS


def manifest_condition(base: str) -> str:
    """Condition distinguishes a local rehearsal from a production read-back."""
    if is_production_base(base):
        return (
            f"Production base {normalize_base(base)} after deployment; "
            "no image binary is committed."
        )
    return LOCAL_CONDITION


def local_checkout_revision() -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "--short=9", "HEAD"],
        cwd=ROOT,
        text=True,
    ).strip()


def open_artifact_manifest(url: str, timeout: int = 20):
    """Fetch the served artifact manifest with an allowlisted User-Agent."""
    request = urllib.request.Request(url, headers={"User-Agent": ARTIFACT_MANIFEST_UA})
    return urllib.request.urlopen(request, timeout=timeout)


def deployed_build_revision(base: str, *, opener=open_artifact_manifest) -> str:
    """Read the served Pages artifact revision, not the local checkout HEAD."""
    origin = normalize_base(base).rstrip("/")
    url = f"{origin}{ARTIFACT_MANIFEST_PATH}"
    try:
        with opener(url, timeout=20) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        raise RuntimeError(f"deployed build revision unavailable at {url}: {error}") from error
    sha = payload.get("source_commit_sha") if isinstance(payload, dict) else None
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError(f"deployed artifact-manifest at {url} lacks a 40-hex source_commit_sha")
    return sha[:9]


def resolve_manifest_revision(base: str, *, opener=open_artifact_manifest) -> str:
    if is_production_base(base):
        return deployed_build_revision(base, opener=opener)
    return local_checkout_revision()


def assert_viewport_render_hash_invariance(captures: list[dict[str, object]]) -> None:
    """Render hashes are over #main text; equal hashes across widths are expected and asserted."""
    by_case: dict[str, dict[str, str]] = {}
    for capture in captures:
        case = str(capture["case"])
        name = viewport_name(capture["viewport"])  # type: ignore[arg-type]
        digest = str(capture["render_sha256"])
        by_case.setdefault(case, {})[name] = digest
    for case, widths in sorted(by_case.items()):
        assert "desktop" in widths and "narrow" in widths, (
            f"A9 writer: case {case} must be captured at desktop and narrow"
        )
        assert widths["desktop"] == widths["narrow"], (
            f"A9 writer: case {case} render hash must be invariant across viewports "
            f"(desktop={widths['desktop']} narrow={widths['narrow']})"
        )


def assert_composed(page, base: str, *, label: str) -> dict[str, object]:
    page.set_default_timeout(20000)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("requestfailed", lambda request: errors.append(f"request {request.url}: {request.failure}")
            if "app/main.mjs" not in request.url else None)
    response = page.goto(f"{base}{NOTICE_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, f"{label}: notice route did not return 200"
    page.wait_for_selector("#notice-route-chrome .document-mast", state="visible")
    page.wait_for_selector("#noticeview .route-item", state="visible")
    assert not errors, f"{label}: client errors: {errors}"
    assert page.locator("#noticeview .rolename").count() == 1
    assert page.locator("#noticeview .glance dt").count() >= 1
    assert page.locator(".notice-route .home-topic-entry:visible").count() == 0
    assert page.locator(".notice-route .home-cta:visible").count() == 0
    assert page.locator(".notice-route .document-mast").count() == 1
    assert page.locator("#langSelect").count() == 1
    hidden_focus = page.locator("#notice-route-chrome [hidden] :is(a,button,input,select,textarea,summary):not([disabled])")
    assert hidden_focus.count() == 0, f"{label}: hidden focusable control remains"
    page.keyboard.press("Tab")
    assert page.evaluate("document.activeElement && getComputedStyle(document.activeElement).display !== 'none'")
    return {"route": NOTICE_ROUTE, "viewport": page.viewport_size, "render_sha256": render_hash(page)}


def assert_a4_source_access_without_javascript(page, base: str) -> dict[str, object]:
    """A4: main content and source access work without JavaScript."""
    response = page.goto(f"{base}{NOTICE_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, (
        f"A4 edge response status={response.status if response else 'none'} "
        f"body={page.locator('body').inner_text()[:300]}"
    )
    assert page.locator("#notice-route-chrome .document-mast").count() == 1
    assert page.locator("#noticeview .rolename").count() == 1
    assert page.locator("#noticeview .glance dt").count() >= 1
    assert page.locator(".home-topic-entry:visible").count() == 0
    source = page.locator(f'#noticeview a.ui-official-source-link[href="{NOTICE_SOURCE}"]')
    assert source.count() >= 1, "A4: official source link is absent without JavaScript"
    assert source.first.get_attribute("href") == NOTICE_SOURCE
    assert source.first.is_visible(), "A4: official source link is not visible without JavaScript"
    return {
        "case": "notice-shell-no-javascript-source-access",
        "route": NOTICE_ROUTE,
        "viewport": page.viewport_size,
        "assertion": (
            "Without JavaScript the edge document keeps the compact mast, one notice heading, "
            "essential facts, and a visible official source link."
        ),
        "render_sha256": render_hash(page),
    }


def assert_a5_skip_navigation(page, base: str) -> dict[str, object]:
    """A5: skip navigation still works on the composed notice route."""
    response = page.goto(f"{base}{NOTICE_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, "A5: notice route did not return 200"
    page.wait_for_selector("#notice-route-chrome .document-mast", state="visible")
    skip = page.locator("a.skip")
    assert skip.count() == 1, "A5: expected exactly one skip link"
    assert skip.first.get_attribute("href") == "#main"
    page.keyboard.press("Tab")
    focused = page.evaluate(
        """() => {
            const el = document.activeElement;
            return {
              tag: el && el.tagName,
              cls: el && (typeof el.className === 'string' ? el.className : ''),
              href: el && el.getAttribute && el.getAttribute('href'),
            };
        }"""
    )
    assert focused and "skip" in (focused.get("cls") or ""), f"A5: first focusable is not skip link: {focused}"
    page.keyboard.press("Enter")
    # Require both the fragment navigation and the focus move that skip links exist for.
    page.wait_for_function(
        "() => location.hash === '#main' && document.activeElement === document.getElementById('main')"
    )
    assert page.evaluate("document.activeElement === document.getElementById('main')")
    assert page.locator("#main").count() == 1
    return {
        "case": "notice-shell-skip-navigation",
        "route": NOTICE_ROUTE,
        "viewport": page.viewport_size,
        "assertion": (
            "Skip navigation remains first-focusable on the notice route and moves focus "
            "into #main."
        ),
        "render_sha256": render_hash(page),
    }


def assert_a3_legacy_hash_and_notice_to_home(page, base: str) -> dict[str, object]:
    """A3: legacy hash navigation and notice → home produce the correct chrome."""
    page.set_default_timeout(20000)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    # Start from the root hash ingress so the compatibility shim can replace once.
    response = page.goto(f"{base.rstrip('/')}/{LEGACY_HASH_ROUTE}", wait_until="domcontentloaded")
    assert response is None or response.status == 200, (
        f"A3: legacy hash entry status={response.status if response else 'none'}"
    )
    page.wait_for_url(re.compile(rf".*{re.escape(NOTICE_ROUTE.rstrip('/'))}/?$"))
    page.wait_for_selector("#notice-route-chrome .document-mast", state="visible")
    page.wait_for_selector("#noticeview .route-item, #noticeview .rolename", state="visible")
    assert page.locator("body.notice-route").count() == 1
    assert page.locator("#noticeview .rolename").count() == 1
    assert page.locator(".notice-route .document-mast").count() == 1
    assert page.locator(".notice-route .home-topic-entry:visible").count() == 0
    fatal = [error for error in errors if "CORS" not in error and "Failed to load resource" not in error]
    assert not fatal, f"A3 legacy hash: client errors: {fatal}"

    page.locator("#notice-route-chrome a.document-brand.home").click()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_function("() => !document.body.classList.contains('notice-route')")
    page.wait_for_selector(".home-topic-entry", state="visible")
    assert "notice-route" not in (page.locator("body").get_attribute("class") or "")
    assert page.locator("#notice-route-chrome:visible").count() == 0
    assert page.locator(".home-topic-entry:visible").count() >= 1
    return {
        "case": "notice-shell-legacy-hash-and-notice-to-home",
        "route": f"/{LEGACY_HASH_ROUTE} -> {NOTICE_ROUTE} -> /",
        "viewport": page.viewport_size,
        "assertion": (
            "Legacy #notice/<id> forwards into the composed notice chrome, and leaving the "
            "notice for home restores homepage chrome without the notice-route shell."
        ),
        "render_sha256": render_hash(page),
    }


def assert_subject_canonical_metadata(page, *, label: str) -> None:
    expected = f"https://cityscroll.org{SUBJECT_NOTICE_ROUTE.rstrip('/')}/"
    # Some served documents omit the trailing slash in the rewritten canonical.
    expected_alt = f"https://cityscroll.org/notices/{SUBJECT_NOTICE_ID}"
    canonical = page.locator('link[rel="canonical"]').first.get_attribute("href")
    og_url = page.locator('meta[property="og:url"]').first.get_attribute("content")
    assert canonical in {expected, expected_alt, expected.rstrip("/")}, (
        f"{label}: canonical metadata href={canonical!r}"
    )
    assert og_url in {expected, expected_alt, expected.rstrip("/")}, (
        f"{label}: og:url content={og_url!r}"
    )


def assert_subject_modified_click(page, *, label: str) -> dict[str, object]:
    start = page.url
    contracts = page.locator(f'#noticeview a.notice-subject-link[href="{SUBJECT_CONTRACT_HREF}"]')
    assert contracts.count() >= 1, f"{label}: View contract link missing before modified click"
    contract = contracts.first
    assert contract.get_attribute("target") in (None, ""), (
        f"{label}: subject link must leave modified-click to the browser"
    )
    with page.context.expect_page() as popup_info:
        contract.click(modifiers=["ControlOrMeta"])
    separate = popup_info.value
    still_here = page.url == start
    separate.close()
    assert still_here, f"{label}: modified click navigated the original notice away"
    return {
        "case": "notice-subject-modified-click",
        "route": SUBJECT_NOTICE_ROUTE,
        "viewport": page.viewport_size,
        "assertion": (
            "A modified click on View contract opens a separate browsing context and leaves "
            "the notice document in place."
        ),
        "render_sha256": render_hash(page),
    }


def assert_subject(page, base: str, *, label: str) -> dict[str, object]:
    page.set_default_timeout(20000)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("requestfailed", lambda request: errors.append(f"request {request.url}: {request.failure}")
            if "app/main.mjs" not in request.url else None)
    response = page.goto(f"{base}{SUBJECT_NOTICE_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, f"{label}: notice route did not return 200"
    page.wait_for_selector("#notice-route-chrome .document-mast", state="visible")
    page.wait_for_selector("#noticeview .route-item", state="visible")
    page.wait_for_selector(
        f'#noticeview a.notice-subject-link[href="{SUBJECT_CONTRACT_HREF}"]',
        state="visible",
    )
    assert not errors, f"{label}: client errors: {errors}"
    assert page.locator("#noticeview .rolename").count() == 1
    contract = page.locator(f'#noticeview a.notice-subject-link[href="{SUBJECT_CONTRACT_HREF}"]')
    assert contract.count() >= 1, f"{label}: View contract link missing"
    assert contract.first.inner_text().strip() == "View contract"
    assert contract.first.get_attribute("data-notice-subject-continuation") == "canonical"
    source = page.locator(f'#noticeview a.ui-official-source-link[href="{SUBJECT_SOURCE}"]')
    assert source.count() >= 1, f"{label}: official source link missing"
    assert_subject_canonical_metadata(page, label=label)
    assert page.locator(".notice-route .home-topic-entry:visible").count() == 0
    hidden_focus = page.locator("#notice-route-chrome [hidden] :is(a,button,input,select,textarea,summary):not([disabled])")
    assert hidden_focus.count() == 0, f"{label}: hidden focusable control remains"
    page.keyboard.press("Tab")
    assert page.evaluate("document.activeElement && getComputedStyle(document.activeElement).display !== 'none'")
    return {"route": SUBJECT_NOTICE_ROUTE, "viewport": page.viewport_size, "render_sha256": render_hash(page)}


def assert_subject_no_javascript(page, base: str) -> dict[str, object]:
    response = page.goto(f"{base}{SUBJECT_NOTICE_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, (
        f"edge response status={response.status if response else 'none'} "
        f"body={page.locator('body').inner_text()[:300]}"
    )
    assert page.locator("#notice-route-chrome .document-mast").count() == 1
    assert page.locator("#noticeview .rolename").count() == 1
    contract = page.locator(f'#noticeview a.notice-subject-link[href="{SUBJECT_CONTRACT_HREF}"]')
    assert contract.count() >= 1, "no-JS View contract link missing"
    assert contract.first.inner_text().strip() == "View contract"
    source = page.locator(f'#noticeview a.ui-official-source-link[href="{SUBJECT_SOURCE}"]')
    assert source.count() >= 1, "no-JS official source link missing"
    assert_subject_canonical_metadata(page, label="no-javascript")
    return {
        "case": "notice-subject-no-javascript",
        "route": SUBJECT_NOTICE_ROUTE,
        "viewport": page.viewport_size,
        "assertion": (
            "No-JavaScript delivery keeps View contract and the official source on the "
            "composed notice document."
        ),
        "render_sha256": render_hash(page),
    }



def write_subject_manifest(captures: list[dict[str, object]], *, base: str, revision: str) -> None:
    assert_viewport_render_hash_invariance(captures)
    payload = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "notice subject contract link",
        "base": manifest_base_label(base),
        "condition": manifest_condition(base),
        "image_binaries_committed": False,
        "revision": revision,
        "data_vintage": (
            "shared procurement read model; pilot notice 20240829105 -> "
            "procurement:contract:CT107120258801626"
        ),
        "route": SUBJECT_NOTICE_ROUTE,
        "render_hash_viewport_invariant": True,
        "captures": [
            {
                "case": capture["case"],
                "viewport": {
                    "name": viewport_name(capture["viewport"]),
                    "width": capture["viewport"]["width"],
                    "height": capture["viewport"]["height"],
                },
                "assertion": capture["assertion"],
                "render_sha256": capture["render_sha256"],
            }
            for capture in captures
        ],
    }
    SUBJECT_MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    SUBJECT_MANIFEST_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def run_notice_subject(base: str, *, write_manifest: bool, revision: str) -> None:
    from playwright.sync_api import sync_playwright

    captures: list[dict[str, object]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for viewport in ({"width": 1440, "height": 1000}, {"width": 390, "height": 844}):
            no_js = browser.new_context(viewport=viewport, java_script_enabled=False)
            captures.append(assert_subject_no_javascript(no_js.new_page(), base))
            no_js.close()

            failed = browser.new_context(viewport=viewport)
            failed_page = failed.new_page()
            failed_page.route("**/app/main.mjs", lambda route: route.abort())
            failed_result = assert_subject(failed_page, base, label="failed enhancement")
            captures.append({
                "case": "notice-subject-failed-enhancement",
                "route": SUBJECT_NOTICE_ROUTE,
                "viewport": viewport,
                "assertion": (
                    "Blocking the app entry preserves the readable edge document, View contract "
                    "link, and official source."
                ),
                "render_sha256": failed_result["render_sha256"],
            })
            failed.close()

            context = browser.new_context(viewport=viewport)
            page = context.new_page()
            result = assert_subject(page, base, label="successful hydration")
            captures.append({
                "case": "notice-subject-successful-hydration",
                "route": SUBJECT_NOTICE_ROUTE,
                "viewport": viewport,
                "assertion": (
                    "The edge response and successful client path keep compact chrome, expose a "
                    "canonical View contract link to CT107120258801626, retain the official "
                    "City Record source, and publish notice canonical metadata."
                ),
                "render_sha256": result["render_sha256"],
            })
            captures.append(assert_subject_modified_click(page, label="modified click"))
            page.goto(base, wait_until="domcontentloaded")
            page.go_back(wait_until="domcontentloaded")
            page.wait_for_selector("#notice-route-chrome .document-mast", state="visible")
            assert page.locator("#noticeview .route-item").count() == 1
            assert page.locator(f'#noticeview a.notice-subject-link[href="{SUBJECT_CONTRACT_HREF}"]').count() >= 1
            captures.append({
                "case": "notice-subject-home-back",
                "route": SUBJECT_NOTICE_ROUTE,
                "viewport": viewport,
                "assertion": (
                    "Home then Back returns to the composed notice with the subject link intact."
                ),
                "render_sha256": render_hash(page),
            })
            print(
                f"OK notice-subject {viewport['width']}x{viewport['height']}: "
                f"{result['render_sha256']} failed={failed_result['render_sha256']}",
                flush=True,
            )
            context.close()
        browser.close()
    assert_viewport_render_hash_invariance(captures)
    if write_manifest:
        write_subject_manifest(captures, base=base, revision=revision)
        print(f"wrote {SUBJECT_MANIFEST_PATH.relative_to(ROOT)}", flush=True)


def viewport_name(viewport: dict[str, int]) -> str:
    return "desktop" if viewport["width"] >= 1000 else "narrow"


def manifest_base_label(base: str) -> str:
    """Record the served origin without retaining an ephemeral local port."""
    if is_production_base(base):
        return normalize_base(base)
    return "local-wrangler"


def write_manifest(captures: list[dict[str, object]], *, base: str, revision: str) -> None:
    assert_viewport_render_hash_invariance(captures)
    payload = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "notice document shell",
        "base": manifest_base_label(base),
        "condition": manifest_condition(base),
        "image_binaries_committed": False,
        "revision": revision,
        "data_vintage": "materialized notice fixture 2026-08-14",
        "route": NOTICE_ROUTE,
        "render_hash_viewport_invariant": True,
        "captures": [
            {
                "case": capture["case"],
                "viewport": {
                    "name": viewport_name(capture["viewport"]),
                    "width": capture["viewport"]["width"],
                    "height": capture["viewport"]["height"],
                },
                "assertion": capture["assertion"],
                "render_sha256": capture["render_sha256"],
            }
            for capture in captures
        ],
    }
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def run_writer_self_tests() -> None:
    """Fixture-closable checks for the capture-manifest writer (no browser)."""
    import io

    local_base = "http://127.0.0.1:8787/"
    production_base = "https://cityscroll.org/"
    assert is_production_base(production_base)
    assert not is_production_base(local_base)
    assert manifest_condition(local_base) == LOCAL_CONDITION
    assert "Production base https://cityscroll.org/" in manifest_condition(production_base)
    assert "Local Wrangler" not in manifest_condition(production_base)
    assert manifest_base_label(local_base) == "local-wrangler"
    assert manifest_base_label(production_base) == "https://cityscroll.org/"

    def opener(url, timeout=20):  # noqa: ARG001
        assert url.endswith(ARTIFACT_MANIFEST_PATH)
        payload = {
            "schema": "cityscroll.served-artifact-manifest.v1",
            "source_commit_sha": "abcdef0123456789abcdef0123456789abcdef01",
        }
        return io.BytesIO(json.dumps(payload).encode())

    assert deployed_build_revision(production_base, opener=opener) == "abcdef012"
    assert resolve_manifest_revision(production_base, opener=opener) == "abcdef012"
    assert resolve_manifest_revision(local_base) == local_checkout_revision()
    assert ARTIFACT_MANIFEST_UA.startswith("cityscroll-")

    recorded: dict[str, object] = {}

    def recording_urlopen(request, timeout=20):  # noqa: ARG001
        recorded["url"] = request.full_url
        recorded["ua"] = request.get_header("User-agent")
        payload = {
            "schema": "cityscroll.served-artifact-manifest.v1",
            "source_commit_sha": "fedcba9876543210fedcba9876543210fedcba98",
        }
        return io.BytesIO(json.dumps(payload).encode())

    original_urlopen = urllib.request.urlopen
    urllib.request.urlopen = recording_urlopen  # type: ignore[assignment]
    try:
        assert deployed_build_revision(production_base) == "fedcba987"
        assert recorded["url"].endswith(ARTIFACT_MANIFEST_PATH)
        assert recorded["ua"] == ARTIFACT_MANIFEST_UA
    finally:
        urllib.request.urlopen = original_urlopen  # type: ignore[assignment]

    matching = [
        {"case": "example", "viewport": {"width": 1440, "height": 1000}, "render_sha256": "a" * 64},
        {"case": "example", "viewport": {"width": 390, "height": 844}, "render_sha256": "a" * 64},
    ]
    assert_viewport_render_hash_invariance(matching)
    mismatched = [
        {"case": "example", "viewport": {"width": 1440, "height": 1000}, "render_sha256": "a" * 64},
        {"case": "example", "viewport": {"width": 390, "height": 844}, "render_sha256": "b" * 64},
    ]
    try:
        assert_viewport_render_hash_invariance(mismatched)
    except AssertionError:
        pass
    else:
        raise AssertionError("expected mismatched viewport hashes to fail")
    print("OK notice-shell capture-manifest writer self-test", flush=True)


def assert_research_tools(page, base: str, *, label: str) -> dict[str, object]:
    """Hydrated notice exposes More tools and scoped research entrances."""
    page.set_default_timeout(20000)
    response = page.goto(f"{base}{NOTICE_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, f"{label}: notice route did not return 200"
    page.wait_for_selector("#noticeview .route-item", state="visible")
    page.wait_for_selector("[data-more-tools-region], [data-research-navigation]", state="attached")
    more = page.locator("[data-more-tools-region]")
    if more.count():
        assert more.count() == 1, f"{label}: expected one More tools region"
        assert more.get_attribute("open") in (None, ""), f"{label}: More tools must start closed"
        summary = more.locator("summary")
        assert summary.count() == 1
        summary.focus()
        page.keyboard.press("Enter")
        assert more.evaluate("el => el.open") is True, f"{label}: keyboard must open More tools"
        for control_id in ("ncopy", "nqr", "nxlsx", "nprint"):
            assert page.locator(f"#{control_id}").count() == 1, f"{label}: missing #{control_id}"
        assert page.locator("[data-pin]").count() >= 1, f"{label}: pin control missing"
    research = page.locator("[data-research-navigation] [data-research-tool]")
    assert research.count() >= 1, f"{label}: expected at least one research entrance"
    hrefs = research.evaluate_all("nodes => nodes.map(node => node.getAttribute('href') || '')")
    assert all(href.startswith("/") for href in hrefs), f"{label}: research hrefs must stay on-site"
    content = page.locator("#main").inner_text()
    return {
        "route": NOTICE_ROUTE,
        "viewport": page.viewport_size,
        "render_sha256": hashlib.sha256(content.encode()).hexdigest(),
        "assertion": "research-tools",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--case",
        choices=["notice-shell", "notice-subject", "contract-evidence", "research-tools"],
        required=True,
    )
    parser.add_argument("--write-manifest", action="store_true")
    parser.add_argument("--self-test", action="store_true", help="Run capture-manifest writer unit checks")
    args = parser.parse_args()

    if args.self_test:
        run_writer_self_tests()
        return

    if args.case == "contract-evidence":
        from contract_evidence_case import run_contract_evidence_case
        run_contract_evidence_case(os.environ.get("CROL_BASE"))
        return

    process = staging = state_dir = upstream = None
    base = os.environ.get("CROL_BASE")
    if not base:
        process, staging, state_dir, base, upstream = start_server(args.case)
    base = normalize_base(base)
    revision = resolve_manifest_revision(base)
    try:
        if args.case == "notice-subject":
            run_notice_subject(base, write_manifest=args.write_manifest, revision=revision)
            return

        from playwright.sync_api import sync_playwright

        captures: list[dict[str, object]] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for viewport in ({"width": 1440, "height": 1000}, {"width": 390, "height": 844}):
                if args.case == "research-tools":
                    context = browser.new_context(viewport=viewport)
                    page = context.new_page()
                    result = assert_research_tools(page, base, label="research-tools hydration")
                    captures.append({
                        "case": "research-tools-hydration",
                        "route": NOTICE_ROUTE,
                        "viewport": viewport,
                        "assertion": (
                            "Hydrated notice keeps More tools closed by default, preserves share and "
                            "export control ids, and offers scoped on-site research entrances."
                        ),
                        "render_sha256": result["render_sha256"],
                    })
                    print(
                        f"OK research-tools {viewport['width']}x{viewport['height']}: {result['render_sha256']}",
                        flush=True,
                    )
                    context.close()
                    continue

                no_js = browser.new_context(viewport=viewport, java_script_enabled=False)
                captures.append(assert_a4_source_access_without_javascript(no_js.new_page(), base))
                no_js.close()

                failed = browser.new_context(viewport=viewport)
                failed_page = failed.new_page()
                failed_page.route("**/app/main.mjs", lambda route: route.abort())
                failed_result = assert_composed(failed_page, base, label="failed enhancement")
                captures.append({
                    "case": "notice-shell-failed-enhancement",
                    "route": NOTICE_ROUTE,
                    "viewport": viewport,
                    "assertion": "Blocking the app entry preserves the readable edge document and its route chrome.",
                    "render_sha256": failed_result["render_sha256"],
                })
                failed.close()

                context = browser.new_context(viewport=viewport)
                page = context.new_page()
                result = assert_composed(page, base, label="successful hydration")
                captures.append({
                    "case": "notice-shell-successful-hydration",
                    "route": NOTICE_ROUTE,
                    "viewport": viewport,
                    "assertion": (
                        "The real edge response and successful client path keep the compact mast, "
                        "one notice heading, essential facts, language control, and no visible homepage promotion."
                    ),
                    "render_sha256": result["render_sha256"],
                })
                captures.append(assert_a5_skip_navigation(page, base))

                page.goto(f"{base}{NOTICE_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
                page.wait_for_selector("#notice-route-chrome .document-mast", state="visible")
                page.goto(base, wait_until="domcontentloaded")
                page.go_back(wait_until="domcontentloaded")
                page.wait_for_selector("#notice-route-chrome .document-mast", state="visible")
                assert page.locator("#noticeview .route-item").count() == 1
                captures.append({
                    "case": "notice-shell-home-back",
                    "route": NOTICE_ROUTE,
                    "viewport": viewport,
                    "assertion": (
                        "Home then Back returns to the composed notice with its route chrome intact."
                    ),
                    "render_sha256": render_hash(page),
                })
                context.close()

                navigation = browser.new_context(viewport=viewport)
                captures.append(assert_a3_legacy_hash_and_notice_to_home(navigation.new_page(), base))
                navigation.close()

                print(
                    f"OK notice-shell {viewport['width']}x{viewport['height']}: "
                    f"{result['render_sha256']} failed={failed_result['render_sha256']}",
                    flush=True,
                )
            browser.close()
        assert_viewport_render_hash_invariance(captures)
        if args.write_manifest:
            write_manifest(captures, base=base, revision=revision)
            print(f"wrote {MANIFEST_PATH.relative_to(ROOT)}", flush=True)
    finally:
        if process:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if upstream:
            upstream.shutdown()
            upstream.server_close()
        if staging:
            shutil.rmtree(staging, ignore_errors=True)
        if state_dir:
            shutil.rmtree(state_dir, ignore_errors=True)



if __name__ == "__main__":
    main()
