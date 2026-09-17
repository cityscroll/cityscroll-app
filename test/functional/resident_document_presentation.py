#!/usr/bin/env python3
"""Browser proof for composed resident documents (notice shell, subject, tools, contract evidence)."""

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
# Agency spelling of the default notice fixture; the research-navigation census
# derives from the same shared module and identity resolver the hydrated
# client uses, so the browser case compares against the census itself.
RESEARCH_CENSUS_AGENCY = "Design and Construction"
MANIFEST_PATH = ROOT / "docs" / "evidence" / "notice-shell" / "capture-manifest.json"

SUBJECT_NOTICE_ID = "20240829105"
SUBJECT_NOTICE_ROUTE = f"/notices/{SUBJECT_NOTICE_ID}/"
SUBJECT_CONTRACT_HREF = "/procurements/procurement%3Acontract%3ACT107120258801626"
SUBJECT_SOURCE = f"https://a856-cityrecord.nyc.gov/RequestDetail/{SUBJECT_NOTICE_ID}"
SUBJECT_MANIFEST_PATH = ROOT / "docs" / "evidence" / "notice-subject" / "capture-manifest.json"
TOOLS_NOTICE_ID = SUBJECT_NOTICE_ID
TOOLS_NOTICE_ROUTE = SUBJECT_NOTICE_ROUTE
TOOLS_SOURCE = SUBJECT_SOURCE
TOOLS_AGENCY = "Homeless Services"
TOOLS_VENDOR = "BHRAGS Operating LLC"
TOOLS_MANIFEST_PATH = ROOT / "docs" / "evidence" / "notice-tools" / "capture-manifest.json"
RESEARCH_TOOLS_MANIFEST_PATH = ROOT / "docs" / "evidence" / "research-tools" / "capture-manifest.json"
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
    if case in {"notice-subject", "notice-tools"}:
        body = {
            "ok": True,
            "row": {
                "request_id": SUBJECT_NOTICE_ID,
                "short_title": "City Sanctuary Facility for Families with Children",
                "type_of_notice_description": "Award",
                "agency_name": TOOLS_AGENCY,
                "start_date": "2024-08-29",
                "vendor_name": TOOLS_VENDOR,
                "additional_description_1": (
                    "Award for City Sanctuary Facility for Families with Children "
                    "shelter operations."
                ),
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
    read_model = f"http://127.0.0.1:{upstream.server_port}/notice"
    config.write_text(
        f'name = "cityscroll-notice-local"\nmain = "{ROOT / "site" / "_worker.js"}"\ncompatibility_date = "2026-07-27"\n'
        f'[vars]\nNOTICE_READ_MODEL = "{read_model}"\n'
        f'[assets]\nbinding = "ASSETS"\ndirectory = "{staging}"\n', encoding="utf-8"
    )
    process = subprocess.Popen(
        ["npx", "--yes", "wrangler@4.126.0", "dev",
         "--config", str(config), "--ip", "127.0.0.1", "--port", "0",
         "--compatibility-date", "2026-07-27",
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



def _email_control_count(locator) -> int:
    """Count Email controls, including Cloudflare email-protection rewrites."""
    return locator.locator(
        "a[href^='mailto:'], a[href*='email-protection'], a[href*='/cdn-cgi/l/email-protection']"
    ).count()


def _primary_fact_label(page, kind: str) -> str:
    return page.evaluate(
        """({ kind }) => {
          const root = document.querySelector('#noticeview [data-notice-primary-facts]');
          if (!root) return '';
          const dts = Array.from(root.querySelectorAll('dt'));
          const dt = dts.find((node) => new RegExp(kind, 'i').test(node.textContent || ''));
          const dd = dt?.nextElementSibling;
          if (!dd) return '';
          const link = dd.querySelector('a');
          const raw = (link?.textContent || dd.childNodes[0]?.textContent || dd.textContent || '');
          return raw.replace(/◆/g, '').replace(/published by agency|named vendor/ig, '').trim();
        }""",
        {"kind": kind},
    )


def _visible_role_mentions(page, label: str) -> int:
    """Count visible primary-fact mentions of an agency/vendor role label."""
    return page.evaluate(
        """({ label }) => {
            const roots = Array.from(document.querySelectorAll(
              '#noticeview [data-notice-primary-facts], #noticeview .ftype'
            ));
            if (!roots.length) return 0;
            const skip = new Set(['SCRIPT', 'STYLE', 'TEMPLATE']);
            const nodes = [];
            const walk = (node) => {
              if (!node || skip.has(node.nodeName)) return;
              if (node.nodeType === Node.TEXT_NODE) {
                if ((node.textContent || '').includes(label)) nodes.push(node);
                return;
              }
              if (node.nodeType !== Node.ELEMENT_NODE) return;
              if (node.matches?.('details.notice-more-tools, [data-more-tools-region], #notice-more-tools')) return;
              if (node.closest?.('[hidden], [aria-hidden="true"]')) return;
              for (const child of node.childNodes) walk(child);
            };
            roots.forEach(walk);
            return nodes.filter((textNode) => {
              const el = textNode.parentElement;
              if (!el) return false;
              const style = getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              if (el.closest('.ui-report-issue, [data-report-issue], button')) return false;
              return true;
            }).length;
        }""",
        {"label": label},
    )


def assert_notice_tools(page, base: str, *, label: str) -> dict[str, object]:
    page.set_default_timeout(20000)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on(
        "requestfailed",
        lambda request: errors.append(f"request {request.url}: {request.failure}")
        if "app/main.mjs" not in request.url
        and "api.cityscroll.org" not in request.url
        and "cloudflareinsights.com" not in request.url
        and "workers.dev" not in request.url
        else None,
    )
    response = page.goto(f"{base}{TOOLS_NOTICE_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, f"{label}: notice route did not return 200"
    page.wait_for_selector("#notice-route-chrome .document-mast", state="visible")
    page.wait_for_selector("#noticeview .route-item", state="visible")
    hydrated = not (label.startswith("failed") or label.startswith("no-javascript"))
    tools_sel = (
        "#noticeview [data-more-tools-region], #noticeview #notice-more-tools"
        if hydrated
        else "#noticeview details.notice-more-tools"
    )
    page.wait_for_selector(tools_sel, state="attached")
    if hydrated:
        # Modest copy-link stays outside; optional utilities hydrate inside More tools.
        page.wait_for_selector("#noticeview #ncopy", state="attached")
        page.wait_for_selector(f"{tools_sel} [data-pin], {tools_sel} #nqr", state="attached")
    fatal = [error for error in errors if "CORS" not in error and "Failed to load resource" not in error]
    assert not fatal, f"{label}: client errors: {fatal}"

    tools = page.locator(tools_sel)
    assert tools.count() >= 1, f"{label}: expected a More tools disclosure"
    assert tools.first.get_attribute("open") is None, f"{label}: More tools should start closed"
    assert "More tools" in tools.first.locator("summary").inner_text().strip()

    assert _email_control_count(tools) >= 1, f"{label}: Email control missing inside More tools"
    if hydrated:
        assert page.locator("#noticeview #ncopy").count() == 1, f"{label}: missing modest #ncopy affordance"
        for control_id in ("nqr", "nxlsx", "nprint"):
            control = tools.locator(f"#{control_id}")
            assert control.count() == 1, f"{label}: missing #{control_id} inside More tools"
        assert tools.locator("[data-pin]").count() >= 1, (
            f"{label}: Pin control missing inside More tools"
        )

    source = page.locator(f'#noticeview a.ui-official-source-link[href="{TOOLS_SOURCE}"]')
    assert source.count() >= 1, f"{label}: official source link missing"
    assert page.locator("#noticeview .rolename").count() == 1
    assert "Award" in page.locator("#noticeview .ftype").first.inner_text()
    ftype_text = page.locator("#noticeview .ftype").first.inner_text()
    primary = page.locator("#noticeview [data-notice-primary-facts]").first
    assert primary.count() == 1, f"{label}: primary facts region missing"
    agency_label = _primary_fact_label(page, "agency")
    vendor_label = _primary_fact_label(page, "vendor")
    assert agency_label, f"{label}: agency missing from primary facts"
    assert vendor_label, f"{label}: vendor missing from primary facts"
    assert agency_label not in ftype_text, f"{label}: agency still repeated in the type line"
    agency_mentions = _visible_role_mentions(page, agency_label)
    vendor_mentions = _visible_role_mentions(page, vendor_label)
    assert agency_mentions == 1, f"{label}: agency role appears {agency_mentions} times ({agency_label!r})"
    assert vendor_mentions == 1, f"{label}: vendor role appears {vendor_mentions} times ({vendor_label!r})"
    assert page.locator("#notice-local-constellation-heading").count() == 0

    # Empty optional enrichment must not leave an empty heading shell.
    empty_heads = page.evaluate(
        """() => Array.from(document.querySelectorAll('#noticeview h2, #noticeview h3, #noticeview .chain-h'))
            .filter((el) => {
              const text = (el.textContent || '').trim();
              if (!text) return true;
              const section = el.closest('section, div, details');
              if (!section) return false;
              const body = section.cloneNode(true);
              body.querySelector(el.tagName)?.remove();
              return !(body.textContent || '').trim();
            }).map((el) => el.textContent || el.id || el.className)"""
    )
    assert empty_heads == [], f"{label}: empty enrichment headings present: {empty_heads}"

    # Expanding tools preserves keyboard access to the demoted controls.
    if hydrated:
        tools.first.locator("summary").focus()
        page.keyboard.press("Enter")
        page.wait_for_function(
            "() => document.querySelector('#noticeview [data-more-tools-region], #noticeview #notice-more-tools')?.open === true"
        )
        assert page.locator("#nqr").is_visible()
        page.locator("#nqr").focus()
        assert page.evaluate("document.activeElement && document.activeElement.id") == "nqr"
        # Return to the default closed state for later captures.
        tools.first.locator("summary").focus()
        page.keyboard.press("Enter")
        page.wait_for_function(
            "() => document.querySelector('#noticeview [data-more-tools-region], #noticeview #notice-more-tools')?.open !== true"
        )

    assert page.locator(f'#noticeview a.notice-subject-link[href="{SUBJECT_CONTRACT_HREF}"]').count() >= 1
    return {"route": TOOLS_NOTICE_ROUTE, "viewport": page.viewport_size, "render_sha256": render_hash(page)}


def assert_notice_tools_no_javascript(page, base: str) -> dict[str, object]:
    response = page.goto(f"{base}{TOOLS_NOTICE_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, (
        f"edge response status={response.status if response else 'none'} "
        f"body={page.locator('body').inner_text()[:300]}"
    )
    assert page.locator("#notice-route-chrome .document-mast").count() == 1
    assert page.locator("#noticeview .rolename").count() == 1
    tools = page.locator("#noticeview details.notice-more-tools")
    assert tools.count() == 1
    assert tools.first.get_attribute("open") is None
    assert _email_control_count(tools) >= 1
    source = page.locator(f'#noticeview a.ui-official-source-link[href="{TOOLS_SOURCE}"]')
    assert source.count() >= 1
    assert page.locator("#noticeview [data-notice-primary-facts]").count() == 1
    agency_label = _primary_fact_label(page, "agency")
    vendor_label = _primary_fact_label(page, "vendor")
    assert agency_label, "no-javascript: agency missing from primary facts"
    assert vendor_label, "no-javascript: vendor missing from primary facts"
    assert agency_label not in page.locator("#noticeview .ftype").first.inner_text()
    assert _visible_role_mentions(page, agency_label) == 1
    assert _visible_role_mentions(page, vendor_label) == 1
    return {
        "case": "notice-tools-no-javascript",
        "route": TOOLS_NOTICE_ROUTE,
        "viewport": page.viewport_size,
        "assertion": (
            "No-JavaScript delivery keeps one agency/vendor role each, a closed More tools "
            "disclosure, notice text access, and the official source."
        ),
        "render_sha256": render_hash(page),
    }


def write_tools_manifest(captures: list[dict[str, object]], *, base: str, revision: str) -> None:
    assert_viewport_render_hash_invariance(captures)
    payload = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "notice optional tools disclosure",
        "base": manifest_base_label(base),
        "condition": manifest_condition(base),
        "image_binaries_committed": False,
        "revision": revision,
        "data_vintage": (
            "shared procurement read model; pilot notice 20240829105 with agency and vendor roles"
        ),
        "route": TOOLS_NOTICE_ROUTE,
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
    TOOLS_MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOOLS_MANIFEST_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def run_notice_tools(base: str, *, write_manifest: bool, revision: str) -> None:
    from playwright.sync_api import sync_playwright

    captures: list[dict[str, object]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for viewport in ({"width": 1440, "height": 1000}, {"width": 390, "height": 844}):
            no_js = browser.new_context(viewport=viewport, java_script_enabled=False)
            captures.append(assert_notice_tools_no_javascript(no_js.new_page(), base))
            no_js.close()

            failed = browser.new_context(viewport=viewport)
            failed_page = failed.new_page()
            failed_page.route("**/app/main.mjs", lambda route: route.abort())
            failed_result = assert_notice_tools(failed_page, base, label="failed enhancement")
            captures.append({
                "case": "notice-tools-failed-enhancement",
                "route": TOOLS_NOTICE_ROUTE,
                "viewport": viewport,
                "assertion": (
                    "Blocking the app entry preserves the readable edge document, one role each "
                    "for agency and vendor, and a closed More tools disclosure."
                ),
                "render_sha256": failed_result["render_sha256"],
            })
            failed.close()

            context = browser.new_context(viewport=viewport)
            page = context.new_page()
            result = assert_notice_tools(page, base, label="successful hydration")
            captures.append({
                "case": "notice-tools-successful-hydration",
                "route": TOOLS_NOTICE_ROUTE,
                "viewport": viewport,
                "assertion": (
                    "Successful hydration keeps utilities inside one initially closed More tools "
                    "disclosure, preserves Copy/QR/Email/Excel/Print/Pin, and does not restate "
                    "agency or vendor roles."
                ),
                "render_sha256": result["render_sha256"],
            })
            page.goto(base, wait_until="domcontentloaded")
            page.go_back(wait_until="domcontentloaded")
            page.wait_for_selector("#notice-route-chrome .document-mast", state="visible")
            page.wait_for_selector("#noticeview .route-item", state="visible")
            page.wait_for_selector("#noticeview #ncopy", state="attached")
            page.wait_for_selector("#noticeview [data-more-tools-region], #noticeview #notice-more-tools", state="attached")
            assert page.locator("#noticeview .route-item").count() == 1
            tools = page.locator("#noticeview [data-more-tools-region], #noticeview #notice-more-tools")
            assert tools.count() >= 1
            assert tools.first.get_attribute("open") is None
            # Hash the stable primary document text rather than optional enrichment that
            # can still be settling after Back.
            home_back_hash = page.evaluate(
                """() => {
                  const root = document.querySelector('#noticeview');
                  const tools = root?.querySelector('[data-more-tools-region], #notice-more-tools');
                  const parts = [
                    root?.querySelector('.ftype')?.innerText || '',
                    root?.querySelector('.rolename')?.innerText || '',
                    root?.querySelector('[data-notice-primary-facts]')?.innerText || '',
                    tools?.querySelector('summary')?.innerText || '',
                    String(root?.querySelectorAll('[data-more-tools-region], #notice-more-tools').length || 0),
                  ];
                  return parts.join('\\n');
                }"""
            )
            captures.append({
                "case": "notice-tools-home-back",
                "route": TOOLS_NOTICE_ROUTE,
                "viewport": viewport,
                "assertion": (
                    "Home then Back returns to the composed notice with More tools still closed "
                    "and without duplicate toolbars."
                ),
                "render_sha256": hashlib.sha256(home_back_hash.encode()).hexdigest(),
            })
            print(
                f"OK notice-tools {viewport['width']}x{viewport['height']}: "
                f"{result['render_sha256']} failed={failed_result['render_sha256']}",
                flush=True,
            )
            context.close()
        browser.close()
    assert_viewport_render_hash_invariance(captures)
    if write_manifest:
        write_tools_manifest(captures, base=base, revision=revision)
        print(f"wrote {TOOLS_MANIFEST_PATH.relative_to(ROOT)}", flush=True)


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
    print("OK notice-tools capture-manifest writer self-test", flush=True)


RESEARCH_CENSUS_SCRIPT = """
Promise.all([
  import('./site/research_discovery.mjs'),
  import('./site/agency_identity.mjs'),
  import('./test/helpers/test_clock.mjs'),
]).then(([discovery, identity, clock]) => {
  const path = discovery.agencyEvidencePath(identity.resolveAgencyIdentity(%(agency)s));
  const projection = discovery.projectResearchTools({
    surface: 'notice',
    evidencePath: path,
    asOfSupported: Boolean(path),
    asOfPath: path,
    comparativeAgency: %(agency)s,
    hasShareHandler: true,
    hasCollectionHandler: true,
    hasExportHandler: true,
    hasPrintHandler: true,
  });
  process.stdout.write(JSON.stringify({
    nav: projection.eligible
      .filter((tool) => tool.href)
      .map((tool) => ({ id: tool.id, href: tool.href })),
    clock_today: clock.todayISO(),
  }));
});
"""


def research_navigation_census(agency: str = RESEARCH_CENSUS_AGENCY) -> dict[str, object]:
    """Complete href-entrance census for a notice surface, from the shared module.

    Mirrors the exact projection inputs the hydrated notice client passes, so
    the browser case checks the rendered research navigation against the
    capability census as a complete ordered set — never a floor of one. The
    only date this helper touches comes from the shared test clock helper, and
    no clock shift is applied.
    """
    script = RESEARCH_CENSUS_SCRIPT % {"agency": json.dumps(agency)}
    return json.loads(subprocess.check_output(["node", "-e", script], cwd=ROOT, text=True))


def research_navigation_defects(
    rendered: list[dict[str, object]],
    census_nav: list[dict[str, object]],
    *,
    clock_today: str,
) -> list[str]:
    """Named failure shapes of a rendered research navigation against its census.

    This is the single comparison behind the browser case, so the census
    contract is pinned by behavior and not only by source text: a navigation
    that rendered nothing, dropped a family, added an uncatalogued one, drifted
    an address or an order, or left the site is reported by name, and the
    on-site check runs over whatever rendered — never behind a rendered-count
    conditional. Entrance scope is checked against the census, which
    independently pins whether each entrance exists and what its address is.
    """
    defects: list[str] = []
    rows = [row for row in (rendered or []) if isinstance(row, dict)]
    census_rows = [row for row in (census_nav or []) if isinstance(row, dict)]
    if census_rows and not rows:
        defects.append("research-navigation-empty")
    census_ids = [str(row.get("id") or "") for row in census_rows]
    rendered_ids = [str(row.get("id") or "") for row in rows]
    dropped_ids = [row_id for row_id in census_ids if row_id not in rendered_ids]
    uncatalogued_ids = [row_id for row_id in rendered_ids if row_id not in census_ids]
    for row_id in dropped_ids:
        defects.append(f"research-navigation-dropped:{row_id}")
    for row_id in uncatalogued_ids:
        defects.append(f"research-navigation-uncatalogued:{row_id}")
    if not dropped_ids and not uncatalogued_ids and rows != census_rows:
        if len(rows) != len(census_rows):
            defects.append("research-navigation-duplicate:" + ",".join(rendered_ids))
        else:
            for rendered_row, census_row in zip(rows, census_rows):
                if rendered_row == census_row:
                    continue
                row_id = str(rendered_row.get("id") or "")
                if rendered_row.get("id") == census_row.get("id"):
                    defects.append(f"research-navigation-address:{row_id}")
                else:
                    defects.append("research-navigation-order:" + ",".join(rendered_ids))
    rendered_by_id = {str(row.get("id") or ""): str(row.get("href") or "") for row in rows}
    for row_id, href in rendered_by_id.items():
        if not href.startswith("/"):
            defects.append(f"research-navigation-off-site:{row_id} (hrefs must stay on-site)")
    if "comparative" in census_ids and "ap_agency=" not in rendered_by_id.get("comparative", ""):
        defects.append("comparative-lost-agency-population")
    if "evidence" in census_ids:
        evidence_href = rendered_by_id.get("evidence", "")
        if not evidence_href.startswith("/agencies/") or "#edge-provenance" not in evidence_href:
            defects.append("evidence-lost-identity-or-source")
    if "asOf" in census_ids:
        as_of_day = (
            urllib.parse.parse_qs(urllib.parse.urlparse(rendered_by_id.get("asOf", "")).query)
            .get("as_of", [None])[0]
        )
        if as_of_day is not None:
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", as_of_day) is None:
                defects.append("as-of-unsupported-day")
            elif as_of_day > str(clock_today):
                defects.append("as-of-after-clock-day")
    return defects


def assert_research_tools(page, base: str, *, label: str) -> dict[str, object]:
    """Hydrated notice exposes More tools and scoped research entrances."""
    page.set_default_timeout(20000)
    response = page.goto(f"{base}{NOTICE_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, f"{label}: notice route did not return 200"
    page.wait_for_selector("#noticeview .route-item", state="visible")
    # Edge first paint may emit research navigation without comparative. Wait for
    # the client More tools region (data-more-tools-region) before census compare.
    page.wait_for_selector("[data-more-tools-region]", state="attached")
    page.wait_for_selector("#ncopy", state="attached")
    more = page.locator("[data-more-tools-region]")
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
    census = research_navigation_census()
    rendered = research.evaluate_all(
        "nodes => nodes.map(node => ({"
        " id: node.getAttribute('data-research-tool') || '',"
        " href: node.getAttribute('href') || ''"
        " }))"
    )
    # The rendered navigation is compared against the census as a complete
    # ordered set of (id, href) pairs through the shared defects helper: a
    # navigation that rendered nothing, dropped a family, added an
    # uncatalogued one, drifted an address or an order, left the site, or lost
    # an entrance's scope fails here by name — the on-site address check runs
    # unconditionally over whatever rendered, never behind a count conditional.
    defects = research_navigation_defects(
        rendered,
        census["nav"],
        clock_today=str(census["clock_today"]),
    )
    assert defects == [], (
        f"{label}: research navigation must match the capability census exactly "
        f"(defects={defects} rendered={rendered} census={census['nav']})"
    )
    # Return More tools to its default closed state before hashing so the
    # capture reflects the quiet notice, not the opened disclosure.
    if more.evaluate("el => el.open"):
        summary.focus()
        page.keyboard.press("Enter")
        assert more.evaluate("el => el.open") is False, f"{label}: More tools must close again"
    content = page.locator("#main").inner_text()
    return {
        "route": NOTICE_ROUTE,
        "viewport": page.viewport_size,
        "render_sha256": hashlib.sha256(content.encode()).hexdigest(),
        "assertion": "research-tools",
    }


def _research_fixture_rows(nav: list[dict[str, object]], row_id: str, **overrides) -> list[dict[str, object]]:
    """Copy census rows, overriding one row's fields for a fixture."""
    return [
        {**row, **overrides} if row.get("id") == row_id else dict(row)
        for row in nav
    ]


def _with_query_value(href: str, key: str, value: str) -> str:
    """Replace one query parameter's value, preserving the rest of the address."""
    parts = str(href).split("?", 1)
    query = parts[1] if len(parts) > 1 else ""
    kept = [piece for piece in query.split("&") if piece and not piece.startswith(f"{key}=")]
    kept.append(f"{key}={urllib.parse.quote(value, safe='')}")
    return f"{parts[0]}?{'&'.join(kept)}"


def write_research_tools_manifest(
    captures: list[dict[str, object]],
    *,
    base: str,
    revision: str,
    path: pathlib.Path | None = None,
) -> pathlib.Path:
    """Retain the research-tools capture packet in the shared render-manifest shape.

    Desktop and narrow #main text can differ under responsive chrome, so this
    writer records both viewports without requiring hash equality (same posture
    as the citizen-entry retention path).
    """
    by_case: dict[str, set[str]] = {}
    for capture in captures:
        by_case.setdefault(str(capture["case"]), set()).add(
            viewport_name(capture["viewport"])  # type: ignore[arg-type]
        )
    for case, widths in sorted(by_case.items()):
        assert widths == {"desktop", "narrow"}, (
            f"research-tools writer: case {case} must be captured at desktop and narrow "
            f"(got {sorted(widths)})"
        )
    target = path or RESEARCH_TOOLS_MANIFEST_PATH
    payload = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "research tools discovery",
        "base": manifest_base_label(base),
        "condition": manifest_condition(base),
        "image_binaries_committed": False,
        "revision": revision,
        "data_vintage": "materialized notice fixture 2026-08-14",
        "route": NOTICE_ROUTE,
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
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return target


def run_research_tools_self_tests() -> None:
    """Fixture-closable checks for the research-navigation census comparison (no browser).

    The census comparison used to be pinned only by source-text tripwires,
    which a rewrite of the same hole in different syntax would defeat. These
    fixtures exercise the shared comparison itself: every named failure shape
    from the read-backs must fire, so the floor of one and the count-guarded
    address check cannot return in any syntax. Every date is derived from the
    shared test clock day the census itself reads.
    """
    import copy
    import datetime as datetime_module

    census = research_navigation_census()
    nav = [dict(row) for row in census["nav"]]
    clock_today = str(census["clock_today"])
    census_ids = [str(row.get("id")) for row in nav]

    # The fixture matrix only proves scope shapes when the census exposes the
    # scoped entrances; say so loudly instead of passing vacuously.
    assert "evidence" in census_ids, "census must expose the evidence entrance"
    assert "asOf" in census_ids, "census must expose the as-of entrance"
    assert "comparative" in census_ids, "census must expose the comparative entrance"
    assert "ap_agency=" in next(row["href"] for row in nav if row["id"] == "comparative")
    assert "#edge-provenance" in next(row["href"] for row in nav if row["id"] == "evidence")

    # A navigation that matches the census passes, in these words.
    assert research_navigation_defects(nav, nav, clock_today=clock_today) == []
    # A surface that promises nothing and renders nothing stays clean.
    assert research_navigation_defects([], [], clock_today=clock_today) == []

    # A navigation that rendered nothing fails by name — any count floor
    # (>= 1) would have let a partial or empty render through.
    defects = research_navigation_defects([], nav, clock_today=clock_today)
    assert "research-navigation-empty" in defects, defects

    # A dropped family fails by name.
    dropped = [row for row in nav if row.get("id") != "comparative"]
    defects = research_navigation_defects(dropped, nav, clock_today=clock_today)
    assert "research-navigation-dropped:comparative" in defects, defects

    # An uncatalogued family fails by name.
    uncatalogued = [*copy.deepcopy(nav), {"id": "misc", "href": "/misc/"}]
    defects = research_navigation_defects(uncatalogued, nav, clock_today=clock_today)
    assert "research-navigation-uncatalogued:misc" in defects, defects

    # A duplicated entrance fails by name even though every family is present.
    duplicated = [*copy.deepcopy(nav), dict(nav[-1])]
    defects = research_navigation_defects(duplicated, nav, clock_today=clock_today)
    assert any(str(d).startswith("research-navigation-duplicate:") for d in defects), defects

    # A reordered navigation fails by name even with every family present.
    assert len(nav) >= 2, "census must expose more than one entrance to pin order"
    reordered = list(nav)
    reordered[0], reordered[1] = reordered[1], reordered[0]
    defects = research_navigation_defects(reordered, nav, clock_today=clock_today)
    assert any(str(d).startswith("research-navigation-order:") for d in defects), defects

    # A drifted address fails by name with every family in order.
    drifted = _research_fixture_rows(nav, "evidence", href="/notices/elsewhere/")
    defects = research_navigation_defects(drifted, nav, clock_today=clock_today)
    assert "research-navigation-address:evidence" in defects, defects
    assert "evidence-lost-identity-or-source" in defects, defects

    # An off-site address fails by name over whatever rendered — this check
    # may not sit behind a rendered-count conditional.
    off_site = [dict(row, href=f"https://example.test/{row['id']}") for row in nav]
    defects = research_navigation_defects(off_site, nav, clock_today=clock_today)
    assert "research-navigation-off-site:evidence (hrefs must stay on-site)" in defects, defects
    defects = research_navigation_defects(off_site[:1], nav, clock_today=clock_today)
    assert "research-navigation-off-site:evidence (hrefs must stay on-site)" in defects, defects

    # A comparative entrance that lost its agency population fails by name.
    comparative_href = next(row["href"] for row in nav if row["id"] == "comparative")
    unscaled = _research_fixture_rows(
        nav, "comparative", href=re.sub(r"([?&])ap_agency=[^&]*&?", r"\1", comparative_href),
    )
    defects = research_navigation_defects(unscaled, nav, clock_today=clock_today)
    assert "comparative-lost-agency-population" in defects, defects

    # An evidence entrance without its provenance anchor loses the source.
    anchorless = _research_fixture_rows(
        nav, "evidence", href=str(next(row["href"] for row in nav if row["id"] == "evidence")).split("#")[0],
    )
    defects = research_navigation_defects(anchorless, nav, clock_today=clock_today)
    assert "evidence-lost-identity-or-source" in defects, defects

    # An as-of entrance carrying an unsupported spelling fails by name rather
    # than linking a bad day. The census entrance itself pins no day; the
    # fixture injects one the way a drifted render would.
    as_of_href = next(row["href"] for row in nav if row["id"] == "asOf")
    misspelled = _research_fixture_rows(nav, "asOf", href=_with_query_value(as_of_href, "as_of", "15 Jan 2026"))
    defects = research_navigation_defects(misspelled, nav, clock_today=clock_today)
    assert "research-navigation-address:asOf" in defects, defects
    assert "as-of-unsupported-day" in defects, defects

    # An as-of day after the shared test clock day fails by name; the day is
    # derived from the clock day itself, never hardcoded.
    after_clock_day = (
        datetime_module.date.fromisoformat(clock_today) + datetime_module.timedelta(days=1)
    ).isoformat()
    future = _research_fixture_rows(nav, "asOf", href=_with_query_value(as_of_href, "as_of", after_clock_day))
    defects = research_navigation_defects(future, nav, clock_today=clock_today)
    assert "as-of-after-clock-day" in defects, defects

    # A supported day at the shared test clock day is not a day defect: the
    # address drift already names the failure, and the day check stays quiet.
    supported = _research_fixture_rows(nav, "asOf", href=_with_query_value(as_of_href, "as_of", clock_today))
    defects = research_navigation_defects(supported, nav, clock_today=clock_today)
    assert defects == ["research-navigation-address:asOf"], defects

    # A comparison that named nothing would be a defect of this self-test, not
    # a pass: every shape above fired, so an always-empty helper cannot satisfy it.
    print("OK research-tools census-comparison self-test", flush=True)

    # Writer shape check: the production retention path uses the shared
    # render-capture manifest schema (no browser required).
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="research-tools-manifest-"))
    try:
        written = write_research_tools_manifest(
            [
                {
                    "case": "research-tools-hydration",
                    "route": NOTICE_ROUTE,
                    "viewport": {"width": 1440, "height": 1000},
                    "assertion": "writer self-test",
                    "render_sha256": "a" * 64,
                },
                {
                    "case": "research-tools-hydration",
                    "route": NOTICE_ROUTE,
                    "viewport": {"width": 390, "height": 844},
                    "assertion": "writer self-test",
                    "render_sha256": "b" * 64,
                },
            ],
            base="https://cityscroll.org/",
            revision="abcdef012",
            path=scratch / "capture-manifest.json",
        )
        payload = json.loads(written.read_text(encoding="utf-8"))
        assert payload["schema"] == "cityscroll.render_capture_manifest.v1"
        assert payload["base"] == "https://cityscroll.org/"
        assert "Production base https://cityscroll.org/" in payload["condition"]
        assert payload["image_binaries_committed"] is False
        assert payload["route"] == NOTICE_ROUTE
        assert payload["revision"] == "abcdef012"
        assert len(payload["captures"]) == 2
        assert payload["captures"][0]["render_sha256"] != payload["captures"][1]["render_sha256"]
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    print("OK research-tools capture-manifest writer self-test", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--case",
        choices=[
            "notice-shell",
            "notice-subject",
            "notice-tools",
            "contract-evidence",
            "research-tools",
            "typography",
            "citizen-entry",
        ],
        required=True,
    )
    parser.add_argument("--write-manifest", action="store_true")
    parser.add_argument("--self-test", action="store_true", help="Run fixture self-tests without a browser")
    args = parser.parse_args()

    if args.self_test:
        if args.case == "typography":
            from typography_case import run_writer_self_tests as run_typography_writer_self_tests
            run_typography_writer_self_tests()
        elif args.case == "citizen-entry":
            from citizen_entry_case import run_writer_self_tests as run_citizen_entry_writer_self_tests
            run_citizen_entry_writer_self_tests()
        elif args.case == "research-tools":
            run_research_tools_self_tests()
        else:
            run_writer_self_tests()
        return

    if args.case == "contract-evidence":
        from contract_evidence_case import run_contract_evidence_case
        run_contract_evidence_case(os.environ.get("CROL_BASE"))
        return

    if args.case == "typography":
        from typography_case import run_typography_case
        run_typography_case(os.environ.get("CROL_BASE"), write_manifest=args.write_manifest)
        return

    if args.case == "citizen-entry":
        from citizen_entry_case import run_citizen_entry_case
        run_citizen_entry_case(os.environ.get("CROL_BASE"), write_manifest=args.write_manifest)
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
        if args.case == "notice-tools":
            run_notice_tools(base, write_manifest=args.write_manifest, revision=revision)
            return

        from playwright.sync_api import sync_playwright

        captures: list[dict[str, object]] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            if args.case == "research-tools":
                # Prove the hydrated census and on-site addresses, and optionally
                # retain the production render-capture manifest after deployment.
                for viewport in ({"width": 1440, "height": 1000}, {"width": 390, "height": 844}):
                    context = browser.new_context(viewport=viewport)
                    page = context.new_page()
                    result = assert_research_tools(page, base, label="research-tools hydration")
                    captures.append({
                        "case": "research-tools-hydration",
                        "route": NOTICE_ROUTE,
                        "viewport": viewport,
                        "assertion": (
                            "Hydrated notice More tools keeps research navigation matching the "
                            "capability census exactly with on-site addresses and a closed disclosure."
                        ),
                        "render_sha256": result["render_sha256"],
                    })
                    print(
                        f"OK research-tools {viewport['width']}x{viewport['height']}: {result['render_sha256']}",
                        flush=True,
                    )
                    context.close()
                browser.close()
                if args.write_manifest:
                    write_research_tools_manifest(captures, base=base, revision=revision)
                    print(f"wrote {RESEARCH_TOOLS_MANIFEST_PATH.relative_to(ROOT)}", flush=True)
                return

            for viewport in ({"width": 1440, "height": 1000}, {"width": 390, "height": 844}):
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
