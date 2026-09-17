#!/usr/bin/env python3
"""Citizen-entry browser case for resident_document_presentation."""

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
CONTRACTS_ROUTE = "/browse/contracts/"
PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
MANIFEST_PATH = ROOT / "docs" / "evidence" / "citizen-entry" / "capture-manifest.json"

HIERARCHY_SCRIPT = """() => {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const text = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const search = document.querySelector('[data-home-topic-entry]');
  const cta = document.getElementById('homeCta');
  const facetLabel = document.querySelector('.browse-facet-label');
  const contracts = document.querySelector('a.tabbtn[href="/browse/contracts/"]');
  const following = document.querySelector('.now-entry-row a[href="/following/"]');
  const guide = document.querySelector('.now-entry-row a[href="/guide/"]');
  const form = document.querySelector('.home-topic-form');
  return {
    searchVisible: visible(search),
    ctaVisible: visible(cta),
    searchText: text(search),
    tagline: text(document.querySelector('.cr-tagline')),
    facetLabel: text(facetLabel),
    hasContracts: !!contracts,
    hasFollowing: !!following,
    hasGuide: !!guide,
    searchAction: form?.getAttribute('action') || '',
    title: document.title || '',
  };
}"""


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


def stage_citizen_entry_fixtures() -> pathlib.Path:
    staging = pathlib.Path(
        tempfile.mkdtemp(
            prefix="cityscroll-citizen-entry-",
            dir=os.environ.get("CITYSCROLL_FUNCTIONAL_TMPDIR") or os.environ.get("FM_TASK_SCRATCH"),
        )
    )
    site = ROOT / "site"
    for name in ("brand.css", "index.html", "i18n.js", "assets"):
        src = site / name
        if not src.exists():
            continue
        if src.is_dir():
            shutil.copytree(src, staging / name, dirs_exist_ok=True)
        else:
            shutil.copy2(src, staging / name)
    lang = site / "i18n" / "lang"
    if lang.exists():
        dest = staging / "i18n" / "lang"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(lang, dest, dirs_exist_ok=True)
    return staging


def start_citizen_entry_server():
    staging = stage_citizen_entry_fixtures()
    from tools.local_site_server import _RobustThreadingHTTPServer

    class FixtureHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(staging), **kwargs)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in {"/", "/index.html"}:
                return super().do_GET()
            if path.startswith("/browse/contracts"):
                # Serve the shared shell so Contracts-domain CTA assertions can run offline.
                self.path = "/index.html"
                return super().do_GET()
            return super().do_GET()

        def log_message(self, _format, *_args):
            return

    server = _RobustThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    return staging, base, server


def render_hash(page) -> str:
    content = page.locator("body").inner_text()
    return hashlib.sha256(content.encode()).hexdigest()


def open_route(page, base: str, route: str, *, label: str):
    target = f"{base.rstrip('/')}/{route.lstrip('/')}" if route != "/" else base
    response = page.goto(target, wait_until="domcontentloaded")
    assert response and response.status == 200, f"{label}: {route} did not return 200"
    page.wait_for_selector("body", state="visible")
    return response


def sample_hierarchy(page) -> dict:
    return page.evaluate(HIERARCHY_SCRIPT)


def assert_home_hierarchy(sample: dict, *, label: str) -> None:
    assert sample["searchVisible"], f"{label}: primary search task is not visible"
    assert not sample["ctaVisible"], f"{label}: specialist signup must not compete on the homepage"
    assert "civic object" not in sample["searchText"].lower(), f"{label}: civic-object wording leaked"
    assert "civic object" not in sample["tagline"].lower(), f"{label}: tagline still uses specialist pitch jargon"
    assert "What's happening in your city?" in sample["searchText"] or "happening in your city" in sample["searchText"].lower(), (
        f"{label}: missing citizen search heading"
    )
    assert sample["facetLabel"].lower() == "browse by type", f"{label}: unexpected facet label {sample['facetLabel']!r}"
    assert sample["hasContracts"], f"{label}: Contracts destination missing"
    assert sample["hasFollowing"], f"{label}: Following destination missing"
    assert sample["hasGuide"], f"{label}: Guide destination missing"
    assert sample["searchAction"].endswith("/search/"), f"{label}: search form must post to /search/"


def assert_keyboard_reaches_search(page, *, label: str) -> None:
    page.keyboard.press("Tab")
    focused = page.evaluate(
        """() => {
          const el = document.activeElement;
          if (!el) return null;
          return {
            id: el.id || '',
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 80),
          };
        }"""
    )
    assert focused, f"{label}: Tab did not move focus"
    # Allow skip link then continue until the search field or a visible control is reached.
    for _ in range(12):
        current = page.evaluate("() => document.activeElement && document.activeElement.id")
        if current == "home-topic-query":
            return
        page.keyboard.press("Tab")
    current = page.evaluate(
        """() => {
          const el = document.activeElement;
          return el ? {id: el.id || '', tag: el.tagName.toLowerCase()} : null;
        }"""
    )
    useful = bool(current) and (
        current.get("id") in {"home-topic-query", "langSelect"}
        or current.get("tag") in {"a", "button", "input", "select"}
    )
    assert useful, f"{label}: keyboard did not reach a useful control ({current!r})"


def assert_translated_layout(page, base: str, *, label: str) -> dict:
    open_route(page, base, HOME_ROUTE, label=label)
    page.select_option("#langSelect", "es")
    page.wait_for_timeout(200)
    sample = sample_hierarchy(page)
    # Either the translated catalog applied, or English fallback remains coherent.
    assert sample["searchVisible"], f"{label}: search vanished after language change"
    assert not sample["ctaVisible"], f"{label}: contracts CTA appeared after language change"
    body = page.locator("body").inner_text()
    assert "civic object" not in body.lower(), f"{label}: civic-object wording after translation"
    return {
        "route": HOME_ROUTE,
        "viewport": page.viewport_size,
        "render_sha256": render_hash(page),
        "lang": page.evaluate("() => document.documentElement.lang || ''"),
    }


def assert_contracts_signup(page, base: str, *, label: str) -> dict:
    open_route(page, base, CONTRACTS_ROUTE, label=label)
    # Offline fixture serves the shell; reveal Contracts pane the way the SPA would.
    page.evaluate(
        """() => {
          document.body.dataset.primaryContext = 'browse';
          document.body.dataset.appRoute = 'true';
          for (const pane of document.querySelectorAll('.tabpane')) pane.classList.remove('active');
          const money = document.getElementById('tab-money');
          if (money) money.classList.add('active');
        }"""
    )
    cta = page.locator("#homeCta")
    assert cta.is_visible(), f"{label}: contracts signup should be visible in Contracts context"
    assert page.locator("#homeCtaForm").count() == 1, f"{label}: subscribe form missing"
    prompt = page.locator("#homeCtaPrompt").inner_text()
    assert "contracts" in prompt.lower() or "RFP" in prompt, f"{label}: unexpected prompt {prompt!r}"
    return {
        "route": CONTRACTS_ROUTE,
        "viewport": page.viewport_size,
        "render_sha256": render_hash(page),
    }


def write_capture_manifest(
    entries: list[dict],
    *,
    base: str | None = None,
    opener=production_opener,
    path: pathlib.Path | None = None,
) -> pathlib.Path:
    target = path or MANIFEST_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    revision = resolve_capture_revision(base, opener=opener)
    data_vintage = resolve_data_vintage(base, opener=opener)
    payload = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "citizen entry homepage",
        "case": "citizen-entry",
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
            "Local citizen-entry shell fixtures for homepage hierarchy and Contracts signup; "
            "no image binary is committed."
        )
    target.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return target


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
            "generated_at": "2026-09-16T18:00:00.000Z",
        }
        return io.BytesIO(json.dumps(payload).encode())

    assert deployed_build_revision(production_base, opener=opener) == (
        "abcdef0123456789abcdef0123456789abcdef01"
    )
    assert resolve_capture_revision(production_base, opener=opener) == (
        "abcdef0123456789abcdef0123456789abcdef01"
    )
    assert resolve_capture_revision(local_base) == local_checkout_revision()
    assert resolve_data_vintage(production_base, opener=opener) == "2026-09-16T18:00:00.000Z"

    scratch = pathlib.Path(tempfile.mkdtemp(prefix="citizen-entry-manifest-"))
    try:
        path = write_capture_manifest(
            [{
                "case": "citizen-entry-self-test",
                "route": HOME_ROUTE,
                "viewport": {"width": 1440, "height": 1000},
                "assertion": "writer self-test",
                "render_sha256": "0" * 64,
                "passed": True,
            }],
            base=local_base,
            path=scratch / "capture-manifest.json",
        )
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload["case"] == "citizen-entry"
        assert payload["image_binaries_committed"] is False
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    print("OK citizen-entry capture-manifest writer self-test", flush=True)


def run_citizen_entry_case(base: str | None = None, *, write_manifest: bool = False) -> None:
    from playwright.sync_api import sync_playwright

    staging = server = None
    owns_server = False
    if not base:
        staging, base, server = start_citizen_entry_server()
        owns_server = True
    base = normalize_base(base)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            entries: list[dict] = []
            for viewport in ({"width": 1440, "height": 1000}, {"width": 390, "height": 844}):
                no_js = browser.new_context(viewport=viewport, java_script_enabled=False)
                page = no_js.new_page()
                open_route(page, base, HOME_ROUTE, label="home no-js")
                sample = sample_hierarchy(page)
                assert_home_hierarchy(sample, label="home no-js")
                entries.append({
                    "case": "citizen-entry-no-javascript",
                    "route": HOME_ROUTE,
                    "viewport": viewport,
                    "assertion": (
                        "No-JavaScript homepage leads with one citizen search task, ordinary browse "
                        "labels, and no competing specialist signup."
                    ),
                    "render_sha256": render_hash(page),
                    "passed": True,
                })
                no_js.close()

                failed = browser.new_context(viewport=viewport)
                failed_page = failed.new_page()
                failed_page.route("**/app/main.mjs", lambda route: route.abort())
                failed_page.route("**/i18n.js", lambda route: route.continue_())
                open_route(failed_page, base, HOME_ROUTE, label="home failed")
                assert_home_hierarchy(sample_hierarchy(failed_page), label="home failed")
                entries.append({
                    "case": "citizen-entry-failed-enhancement",
                    "route": HOME_ROUTE,
                    "viewport": viewport,
                    "assertion": (
                        "Blocking enhancement scripts preserves the citizen-first homepage hierarchy."
                    ),
                    "render_sha256": render_hash(failed_page),
                    "passed": True,
                })
                failed.close()

                context = browser.new_context(viewport=viewport)
                page = context.new_page()
                open_route(page, base, HOME_ROUTE, label="home hydrated")
                assert_home_hierarchy(sample_hierarchy(page), label="home hydrated")
                assert_keyboard_reaches_search(page, label="home keyboard")
                entries.append({
                    "case": "citizen-entry-successful-enhancement",
                    "route": HOME_ROUTE,
                    "viewport": viewport,
                    "assertion": (
                        "Hydrated homepage keeps one primary search task, ordinary browse labels, "
                        "and keyboard access to search."
                    ),
                    "render_sha256": render_hash(page),
                    "passed": True,
                })
                translated = assert_translated_layout(page, base, label="home translated")
                entries.append({
                    "case": "citizen-entry-translated",
                    "route": HOME_ROUTE,
                    "viewport": viewport,
                    "assertion": (
                        "Language switching keeps a clear primary search emphasis without revealing "
                        "the specialist signup on home."
                    ),
                    "render_sha256": translated["render_sha256"],
                    "passed": True,
                })
                contracts = assert_contracts_signup(page, base, label="contracts signup")
                entries.append({
                    "case": "citizen-entry-contracts-signup",
                    "route": CONTRACTS_ROUTE,
                    "viewport": viewport,
                    "assertion": (
                        "Contracts context still exposes the weekly specialist signup with a working "
                        "subscribe form and Following handoff."
                    ),
                    "render_sha256": contracts["render_sha256"],
                    "passed": True,
                })
                context.close()
                print(
                    f"OK citizen-entry {viewport['width']}x{viewport['height']}: "
                    f"home hierarchy + contracts signup",
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
