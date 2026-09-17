#!/usr/bin/env python3
"""Typography browser case for resident_document_presentation."""

from __future__ import annotations

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

HOME_ROUTE = "/"
NOTICE_ROUTE = "/notices/20240829105/"
CONTRACT_ID = "procurement:contract:CT107120258801626"
CONTRACT_ROUTE = f"/procurements/{CONTRACT_ID.replace(':', '%3A')}"
PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
MANIFEST_PATH = ROOT / "docs" / "evidence" / "reader-typography" / "capture-manifest.json"
READING_FAMILY_RE = re.compile(
    r"(noto sans|helvetica neue|arial|system-ui|ui-sans-serif|blinkmacsystemfont|segoe ui|-apple-system)",
    re.I,
)
SERIF_FAMILY_RE = re.compile(r"(times|georgia|serif)", re.I)
BRAND_FAMILY_RE = re.compile(r"(space grotesk|segoe ui|system-ui|-apple-system)", re.I)
MONO_FAMILY_RE = re.compile(r"(mono|menlo|consolas|courier)", re.I)


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def is_production_base(base: str) -> bool:
    host = (urllib.parse.urlparse(normalize_base(base)).hostname or "").lower()
    return host in PRODUCTION_HOSTS


def local_checkout_revision() -> str:
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()


def production_opener(url, timeout=20):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; CityScrollCapture/1.0)",
            "Accept": "application/json",
        },
    )
    return urllib.request.urlopen(request, timeout=timeout)


def deployed_build_revision(base: str, *, opener=production_opener) -> str:
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
    return sha


def resolve_capture_revision(base: str | None, *, opener=production_opener) -> str:
    if base and is_production_base(base):
        return deployed_build_revision(base, opener=opener)
    return local_checkout_revision()


def resolve_data_vintage(base: str | None, *, opener=production_opener) -> str:
    if base and is_production_base(base):
        origin = normalize_base(base).rstrip("/")
        url = f"{origin}{ARTIFACT_MANIFEST_PATH}"
        try:
            with opener(url, timeout=20) as response:
                payload = json.load(response)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
            raise RuntimeError(f"deployed data vintage unavailable at {url}: {error}") from error
        generated_at = payload.get("generated_at") if isinstance(payload, dict) else None
        if isinstance(generated_at, str) and generated_at.strip():
            return generated_at.strip()
        raise RuntimeError(f"deployed artifact-manifest at {url} lacks generated_at")
    return "fixture-or-served-materialization"


def stage_typography_fixtures() -> pathlib.Path:
    staging = pathlib.Path(
        tempfile.mkdtemp(
            prefix="cityscroll-typography-",
            dir=os.environ.get("CITYSCROLL_FUNCTIONAL_TMPDIR") or os.environ.get("FM_TASK_SCRATCH"),
        )
    )
    site = ROOT / "site"
    for name in (
        "brand.css",
        "civic-documents.css",
        "index.html",
        "report_issue.mjs",
        "i18n.js",
        "affordance_grammar.mjs",
        "ai_discovery.mjs",
        "place_context.mjs",
        "traversal_path.mjs",
    ):
        src = site / name
        if src.exists():
            if src.is_dir():
                shutil.copytree(src, staging / name, dirs_exist_ok=True)
            else:
                shutil.copy2(src, staging / name)

    assets = site / "assets"
    if assets.exists():
        shutil.copytree(assets, staging / "assets", dirs_exist_ok=True)

    notice_path = staging / "notice.html"
    subprocess.run(
        ["node", str(ROOT / "test/functional/render_typography_notice_fixture.mjs"), str(notice_path)],
        cwd=ROOT,
        check=True,
    )
    contract_path = staging / "contract.html"
    subprocess.run(
        ["node", str(ROOT / "test/functional/render_typography_contract_fixture.mjs"), str(contract_path)],
        cwd=ROOT,
        check=True,
    )
    return staging


def start_typography_server():
    staging = stage_typography_fixtures()
    from tools.local_site_server import _RobustThreadingHTTPServer

    notice_html = (staging / "notice.html").read_bytes()
    contract_html = (staging / "contract.html").read_bytes()

    class FixtureHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(staging), **kwargs)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in {"/", "/index.html"}:
                return super().do_GET()
            if path.startswith("/notices/"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(notice_html)))
                self.end_headers()
                self.wfile.write(notice_html)
                return
            if path.startswith("/procurements/"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(contract_html)))
                self.end_headers()
                self.wfile.write(contract_html)
                return
            return super().do_GET()

        def log_message(self, _format, *_args):
            return

    server = _RobustThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    return staging, base, server


SAMPLE_SCRIPT = """() => {
  const first = (selectors) => {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    return null;
  };
  const styleOf = (node) => {
    if (!node) return null;
    const style = getComputedStyle(node);
    return {
      family: style.fontFamily || "",
      size: style.fontSize || "",
      weight: style.fontWeight || "",
      tag: node.tagName.toLowerCase(),
    };
  };
  const brand = first([
    ".cr-title",
    ".document-brand",
    "[data-typography-role='brand']",
    ".brand-lockup",
  ]);
  const body = first([
    "[data-typography-role='body'] p",
    "main .guide-help",
    "main .node-section p",
    "main .lede",
    "main p:not(.node-back)",
    ".home-topic-entry p",
    "body",
  ]);
  const label = first([
    "[data-typography-role='label']",
    ".home-topic-form label",
    ".field label",
    "label",
  ]);
  const input = first([
    "[data-typography-role='input']",
    ".home-topic-form input",
    "input[type=text]",
    "input[type=search]",
    "input",
  ]);
  const button = first([
    "[data-typography-role='button']",
    ".home-topic-form button",
    "button[type=submit]",
    "button",
  ]);
  const identifier = first([
    "[data-typography-role='identifier']",
    "code.pin",
    "code",
  ]);
  return {
    brand: styleOf(brand),
    body: styleOf(body),
    label: styleOf(label),
    input: styleOf(input),
    button: styleOf(button),
    identifier: styleOf(identifier),
    title: document.title || "",
    lang: document.documentElement.lang || "",
  };
}"""


def assert_reading_family(family: str, *, label: str) -> None:
    assert family, f"{label}: missing font-family"
    assert READING_FAMILY_RE.search(family), f"{label}: expected reading/sans stack, got {family!r}"
    # Reject pure serif defaults for reading/control roles.
    if not READING_FAMILY_RE.search(family.split(",")[0]):
        assert not SERIF_FAMILY_RE.search(family.split(",")[0]), (
            f"{label}: serif default is not an intentional reading role: {family!r}"
        )


def assert_brand_family(family: str, *, label: str) -> None:
    assert family, f"{label}: missing brand font-family"
    assert BRAND_FAMILY_RE.search(family), f"{label}: expected brand stack, got {family!r}"


def normalize_family_key(family: str) -> str:
    parts = [part.strip().strip("\"'").lower() for part in family.split(",") if part.strip()]
    # Compare by role class, not exact loaded face (webfont vs fallback).
    if any("space grotesk" in part or part == "var(--font-brand)" for part in parts):
        return "brand"
    if any(MONO_FAMILY_RE.search(part) for part in parts):
        return "mono"
    if any(READING_FAMILY_RE.search(part) for part in parts):
        return "reading"
    if any(SERIF_FAMILY_RE.search(part) for part in parts):
        return "serif"
    return parts[0] if parts else ""


def sample_roles(page) -> dict[str, object]:
    return page.evaluate(SAMPLE_SCRIPT)


def assert_surface_roles(
    sample: dict[str, object],
    *,
    label: str,
    require_brand: bool = True,
    require_form_controls: bool = True,
) -> dict[str, str]:
    roles = {}
    required_roles = ("body", "label", "input", "button") if require_form_controls else ("body", "button")
    for role in required_roles:
        entry = sample.get(role)
        assert isinstance(entry, dict) and entry.get("family"), f"{label}: missing {role} sample"
        family = str(entry["family"])
        assert_reading_family(family, label=f"{label}:{role}")
        roles[role] = normalize_family_key(family)
    assert all(roles[role] == "reading" for role in required_roles), (
        f"{label}: equivalent roles diverged: {roles}"
    )
    if require_brand:
        brand = sample.get("brand")
        assert isinstance(brand, dict) and brand.get("family"), f"{label}: missing brand sample"
        assert_brand_family(str(brand["family"]), label=f"{label}:brand")
        roles["brand"] = normalize_family_key(str(brand["family"]))
        assert roles["brand"] == "brand", f"{label}: brand role lost deliberate display family"
    identifier = sample.get("identifier")
    if isinstance(identifier, dict) and identifier.get("family"):
        roles["identifier"] = normalize_family_key(str(identifier["family"]))
        assert roles["identifier"] == "mono", f"{label}: identifier should stay monospace"
    return roles


def render_hash(page) -> str:
    content = page.locator("main, body").first.inner_text()
    return hashlib.sha256(content.encode()).hexdigest()


def open_route(page, base: str, route: str, *, label: str):
    target = f"{base.rstrip('/')}/{route.lstrip('/')}" if route != "/" else base
    response = page.goto(target, wait_until="domcontentloaded")
    assert response and response.status == 200, f"{label}: {route} did not return 200"
    page.wait_for_selector("body", state="visible")
    return response


def wait_for_reading_tokens(page, *, label: str) -> None:
    """Wait until brand tokens apply to the document body before sampling.

    Production detail documents can finish DOMContentLoaded before brand.css
    cascades onto body; sampling too early falsely reports the UA Times default.
    """
    import time

    deadline = time.time() + 20
    last = ""
    while time.time() < deadline:
        last = page.evaluate(
            """() => {
              const reading = getComputedStyle(document.documentElement)
                .getPropertyValue('--font-reading').trim();
              const bodyFamily = (getComputedStyle(document.body).fontFamily || '').trim();
              return JSON.stringify({ reading: reading, bodyFamily: bodyFamily });
            }"""
        )
        try:
            payload = json.loads(last)
        except json.JSONDecodeError:
            payload = {}
        reading = str(payload.get("reading") or "")
        body_family = str(payload.get("bodyFamily") or "")
        if reading and body_family and not body_family.lower().startswith("times"):
            return
        page.wait_for_timeout(200)
    raise AssertionError(
        f"{label}: reading font tokens never became available on body ({last})"
    )

def assert_typography_surface(page, base: str, route: str, *, label: str) -> dict[str, object]:
    open_route(page, base, route, label=label)
    wait_for_reading_tokens(page, label=label)
    sample = sample_roles(page)
    # Procurement detail pages may omit label/input controls that home/notice expose.
    require_form_controls = route not in {CONTRACT_ROUTE}
    roles = assert_surface_roles(
        sample,
        label=label,
        require_brand=True,
        require_form_controls=require_form_controls,
    )
    page.keyboard.press("Tab")
    focused = page.evaluate(
        "() => !!(document.activeElement && getComputedStyle(document.activeElement).display !== 'none')"
    )
    assert focused, f"{label}: keyboard focus did not land on a visible control"
    return {
        "route": route,
        "viewport": page.viewport_size,
        "render_sha256": render_hash(page),
        "roles": roles,
        "sample": sample,
    }


def assert_font_blocked(page, base: str, *, label: str) -> dict[str, object]:
    page.route("**/fonts.googleapis.com/**", lambda route: route.abort())
    page.route("**/fonts.gstatic.com/**", lambda route: route.abort())
    open_route(page, base, HOME_ROUTE, label=label)
    wait_for_reading_tokens(page, label=label)
    sample = sample_roles(page)
    roles = assert_surface_roles(sample, label=label, require_brand=True)
    for role in ("body", "label", "input", "button"):
        family = str(sample[role]["family"])
        assert not family.lower().startswith("times"), f"{label}:{role} fell back to Times ({family!r})"
    return {
        "route": HOME_ROUTE,
        "viewport": page.viewport_size,
        "render_sha256": render_hash(page),
        "roles": roles,
        "assertion": "font-blocked-fallbacks",
    }


def assert_non_latin_overlay(page, base: str, *, label: str) -> dict[str, object]:
    open_route(page, base, HOME_ROUTE, label=label)
    wait_for_reading_tokens(page, label=label)
    page.evaluate(
        """() => {
          document.documentElement.lang = 'zh-Hans';
          document.documentElement.style.setProperty(
            '--lang-font-stack',
            "'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif"
          );
          const probe = document.createElement('p');
          probe.setAttribute('data-typography-role', 'body');
          probe.textContent = '市民可以查询合同与通知';
          document.body.prepend(probe);
        }"""
    )
    sample = sample_roles(page)
    body_family = str(sample["body"]["family"])
    assert re.search(r"pingfang|noto sans cjk|microsoft yahei|noto sans|helvetica|arial|system-ui", body_family, re.I), (
        f"{label}: non-Latin overlay missing intentional fallback, got {body_family!r}"
    )
    assert_surface_roles(sample, label=label, require_brand=False)
    return {
        "route": HOME_ROUTE,
        "viewport": page.viewport_size,
        "render_sha256": render_hash(page),
        "assertion": "non-latin-script-aware-fallback",
        "family": body_family,
    }


def write_capture_manifest(
    entries: list[dict],
    *,
    base: str | None = None,
    opener=production_opener,
) -> pathlib.Path:
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    revision = resolve_capture_revision(base, opener=opener)
    data_vintage = resolve_data_vintage(base, opener=opener)
    payload = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "reader typography roles",
        "case": "typography",
        "revision": revision,
        "data_vintage": data_vintage,
        "route": HOME_ROUTE,
        "image_binaries_committed": False,
        "captures": entries,
    }
    if base and is_production_base(base):
        payload["base"] = normalize_base(base)
        payload["condition"] = (
            f"Production base {normalize_base(base)} after deployment; "
            "no image binary is committed."
        )
    else:
        payload["condition"] = (
            "Local typography fixtures for home, notice, and contract using shared brand tokens; "
            "no image binary is committed."
        )
    MANIFEST_PATH.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return MANIFEST_PATH


def run_writer_self_tests() -> None:
    import io

    local_base = "http://127.0.0.1:8765/"
    production_base = "https://cityscroll.org/"
    assert is_production_base(production_base)
    assert not is_production_base(local_base)

    def opener(url, timeout=20):  # noqa: ARG001
        assert url.endswith(ARTIFACT_MANIFEST_PATH)
        payload = {
            "schema": "cityscroll.served-artifact-manifest.v1",
            "source_commit_sha": "abcdef0123456789abcdef0123456789abcdef01",
            "generated_at": "2026-09-16T12:04:00.000Z",
        }
        return io.BytesIO(json.dumps(payload).encode())

    assert deployed_build_revision(production_base, opener=opener) == (
        "abcdef0123456789abcdef0123456789abcdef01"
    )
    assert resolve_capture_revision(production_base, opener=opener) == (
        "abcdef0123456789abcdef0123456789abcdef01"
    )
    assert resolve_capture_revision(local_base) == local_checkout_revision()
    assert resolve_data_vintage(production_base, opener=opener) == "2026-09-16T12:04:00.000Z"
    print("OK typography capture-manifest writer self-test", flush=True)


def run_typography_case(base: str | None = None, *, write_manifest: bool = False) -> None:
    from playwright.sync_api import sync_playwright

    staging = server = None
    owns_server = False
    if not base:
        staging, base, server = start_typography_server()
        owns_server = True
    base = normalize_base(base)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            entries: list[dict] = []
            def measure(route: str, label: str, *, java_script_enabled: bool = True, abort=()):
                context = browser.new_context(
                    viewport=viewport,
                    java_script_enabled=java_script_enabled,
                )
                page = context.new_page()
                for pattern in abort:
                    page.route(pattern, lambda route, _pattern=pattern: route.abort())
                try:
                    return assert_typography_surface(page, base, route, label=label)
                finally:
                    context.close()

            for viewport in ({"width": 1440, "height": 1000}, {"width": 390, "height": 844}):
                # First paint / no JavaScript — fresh page per route avoids stale DOM.
                home = measure(HOME_ROUTE, "home no-js", java_script_enabled=False)
                notice = measure(NOTICE_ROUTE, "notice no-js", java_script_enabled=False)
                contract = measure(CONTRACT_ROUTE, "contract no-js", java_script_enabled=False)
                assert home["roles"]["body"] == notice["roles"]["body"] == contract["roles"]["body"]
                entries.append({
                    "case": "typography-no-javascript",
                    "route": HOME_ROUTE,
                    "viewport": viewport,
                    "assertion": (
                        "No-JavaScript home, notice, and contract keep equivalent body/label/input/"
                        "button reading roles with deliberate brand display."
                    ),
                    "render_sha256": home["render_sha256"],
                    "passed": True,
                })

                # Failed enhancement: abort a progressive script on home/notice/contract.
                abort_scripts = ("**/report_issue.mjs", "**/app/main.mjs")
                home_failed = measure(HOME_ROUTE, "home failed", abort=abort_scripts)
                notice_failed = measure(NOTICE_ROUTE, "notice failed", abort=abort_scripts)
                contract_failed = measure(CONTRACT_ROUTE, "contract failed", abort=abort_scripts)
                assert home_failed["roles"]["body"] == notice_failed["roles"]["body"] == contract_failed["roles"]["body"]
                entries.append({
                    "case": "typography-failed-enhancement",
                    "route": HOME_ROUTE,
                    "viewport": viewport,
                    "assertion": (
                        "Blocking enhancement scripts preserves the same typography roles across "
                        "home and both pilot details."
                    ),
                    "render_sha256": home_failed["render_sha256"],
                    "passed": True,
                })

                # Successful enhancement + keyboard + font-blocked + non-Latin.
                home_ok = measure(HOME_ROUTE, "home hydrated")
                notice_ok = measure(NOTICE_ROUTE, "notice hydrated")
                contract_ok = measure(CONTRACT_ROUTE, "contract hydrated")
                assert home_ok["roles"]["body"] == notice_ok["roles"]["body"] == contract_ok["roles"]["body"]
                entries.append({
                    "case": "typography-successful-enhancement",
                    "route": HOME_ROUTE,
                    "viewport": viewport,
                    "assertion": (
                        "Hydrated home and both pilot details agree on reading/control roles while "
                        "brand display and identifiers keep intentional exceptions."
                    ),
                    "render_sha256": home_ok["render_sha256"],
                    "passed": True,
                })

                blocked = browser.new_context(viewport=viewport)
                blocked_result = assert_font_blocked(blocked.new_page(), base, label="font-blocked")
                entries.append({
                    "case": "typography-font-blocked",
                    "route": HOME_ROUTE,
                    "viewport": viewport,
                    "assertion": (
                        "With webfonts blocked, reading and control roles stay on intentional sans "
                        "fallbacks instead of Times."
                    ),
                    "render_sha256": blocked_result["render_sha256"],
                    "passed": True,
                })
                blocked.close()

                non_latin = browser.new_context(viewport=viewport)
                non_latin_result = assert_non_latin_overlay(non_latin.new_page(), base, label="non-latin")
                entries.append({
                    "case": "typography-non-latin",
                    "route": HOME_ROUTE,
                    "viewport": viewport,
                    "assertion": (
                        "Script-aware language overlays keep non-Latin text legible on the reading role."
                    ),
                    "render_sha256": non_latin_result["render_sha256"],
                    "passed": True,
                })
                non_latin.close()

                print(
                    f"OK typography {viewport['width']}x{viewport['height']}: "
                    f"home={home_ok['render_sha256'][:12]} notice={notice_ok['render_sha256'][:12]} "
                    f"contract={contract_ok['render_sha256'][:12]}",
                    flush=True,
                )
            browser.close()
        if write_manifest:
            path = write_capture_manifest(entries, base=base)
            print(f"wrote {path.relative_to(ROOT)}", flush=True)
    finally:
        if owns_server and server:
            server.shutdown()
            server.server_close()
        if staging:
            shutil.rmtree(staging, ignore_errors=True)
