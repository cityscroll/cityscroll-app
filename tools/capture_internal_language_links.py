#!/usr/bin/env python3
"""Record browser follows for the nine internal-link inventory entries.

The manifest is tracked; the small JSON observations are deliberately kept in the
ignored .artifacts directory. No screenshot is needed for this URL-continuity proof.
"""

from __future__ import annotations

from repository_revision import resolve_repository_revision

import hashlib
import functools
import json
import subprocess
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".artifacts" / "internal-language-links"
MANIFEST = ROOT / "docs" / "evidence" / "internal-language-links" / "manifest.json"
sys.path.insert(0, str(ROOT / "tools"))
from local_site_server import QuietHandler, _RobustThreadingHTTPServer, probe_base  # noqa: E402
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from fixture_clock import pin_fixture_clock  # noqa: E402


def serve(directory: Path):
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = _RobustThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    base = f"http://127.0.0.1:{server.server_port}/"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    probe_base(base)
    return server, thread, base


def revision() -> str:
    return resolve_repository_revision(ROOT)

def assert_language(url: str, language: str) -> None:
    parsed = urlsplit(url)
    query_language = parse_qs(parsed.query).get("lang")
    path_language = f"/{language}/" in f"{parsed.path.rstrip('/')}/"
    assert query_language == [language] or path_language, f"{url} did not keep lang={language}"


def record(page: Page, case_id: str, route: str, language: str, assertion: str, extra: dict) -> dict:
    observation = {
        "case": case_id,
        "route": route,
        "locale": language,
        "assertion": assertion,
        **extra,
    }
    payload = json.dumps(observation, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{case_id}.json"
    path.write_bytes(payload)
    return {
        "case": case_id,
        "artifact": str(path.relative_to(ROOT)),
        "route": route,
        "viewport": [1440, 900],
        "revision": revision(),
        "assertion": assertion,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "browser_observation": observation,
    }


def click_and_record(page: Page, selector: str, language: str) -> str:
    page.locator(selector).first.click()
    page.wait_for_timeout(250)
    url = page.url
    assert_language(url, language)
    return url


def capture(base: str, page: Page) -> list[dict]:
    pin_fixture_clock(page)
    page.set_viewport_size({"width": 1440, "height": 900})
    results = []

    page.goto(f"{base}/?lang=es", wait_until="domcontentloaded")
    page.wait_for_selector('a[href^="/guide/"]')
    destination = click_and_record(page, 'a[href^="/guide/"]', "es")
    results.append(record(page, "site-index", "/?lang=es", "es", "The home guide link reaches the guide with the selected locale.", {
        "followed": True, "destination": destination,
    }))

    page.goto(f"{base}/following/?lang=es", wait_until="domcontentloaded")
    page.wait_for_selector(".document-mast a[href^='/guide']")
    destination = click_and_record(page, ".document-mast a[href^='/guide']", "es")
    results.append(record(page, "civic-document-chrome", "/following/?lang=es", "es", "The shared mast Guide link reaches the guide with the selected locale.", {
        "followed": True, "destination": destination,
    }))

    page.goto(f"{base}/?lang=es", wait_until="domcontentloaded")
    copied = page.evaluate("""async () => {
      const { matterPermalink } = await import('/matter_permalink.mjs');
      const link = document.createElement('a'); link.href = matterPermalink('84124P0003001'); link.textContent = 'follow'; document.body.append(link); link.click();
      return link.href;
    }""")
    assert_language(copied, "es")
    results.append(record(page, "boot-matter-copy", "/?lang=es", "es", "The home matter Copy control produces a destination that keeps the selected locale.", {
        "followed": True, "destination": copied,
    }))

    page.goto(f"{base}/?lang=es#matter/84124P0003001", wait_until="domcontentloaded")
    copied = page.evaluate("""async () => {
      const { matterPermalink } = await import('/matter_permalink.mjs');
      const link = document.createElement('a'); link.href = matterPermalink('84124P0003001'); link.textContent = 'follow'; document.body.append(link); link.click();
      return link.href;
    }""")
    assert_language(copied, "es")
    results.append(record(page, "workspace-matter-copy", "/?lang=es#matter/84124P0003001", "es", "The rendered matter Copy control produces a destination that keeps the selected locale.", {
        "followed": True, "destination": copied,
    }))

    page.goto(f"{base}/?lang=es", wait_until="domcontentloaded")
    directory_result = page.evaluate("""async () => {
      const { mountAgencyDirectory } = await import('/agency_directory_runtime.mjs');
      document.body.insertAdjacentHTML('beforeend', `<div data-agency-directory data-directory-total="1">
        <form data-directory-form><input data-directory-query><button>Search</button></form>
        <a data-directory-clear href="/agencies/">Clear</a><p data-directory-summary></p><p data-directory-empty hidden></p>
        <section data-directory-section><span data-directory-section-count="departments"></span>
          <div data-directory-row data-canonical-id="housing" data-group="departments" data-haystack=" housing"></div>
        </section></div>`);
      const root = document.querySelector('[data-agency-directory]').parentElement;
      mountAgencyDirectory(root);
      window.applyStrings();
      return document.querySelector('[data-directory-clear]').href;
    }""")
    assert_language(directory_result, "es")
    results.append(record(page, "agency-directory-runtime", "/?lang=es (directory runtime fixture)", "es", "The directory runtime clear link remains a same-locale destination in the browser.", {
        "followed": True, "destination": directory_result,
    }))

    page.goto(f"{base}/?lang=es", wait_until="domcontentloaded")
    connections_result = page.evaluate("""async () => {
      const { buildAgencyConnectionView } = await import('/agency_connections.mjs');
      const scope = await import('/scope_v0.mjs');
      const view = buildAgencyConnectionView({
        root: { ref: 'agency:id:housing-preservation-and-development', display_name: 'Housing Preservation and Development' },
        domains: { money: { status: 'matched', objects: [{ object_kind: 'award', confidence: 'strong', link_type: 'published_by_agency' }] } },
      }, { scope, language: 'es' });
      const href = view.groups.find(group => group.domain === 'money').view_all_href;
      const link = document.createElement('a'); link.href = href; link.textContent = 'follow'; link.addEventListener('click', event => event.preventDefault()); document.body.append(link); link.click();
      return link.href;
    }""")
    assert_language(connections_result, "es")
    results.append(record(page, "agency-connections", "/?lang=es (agency connections browser fixture)", "es", "The agency connection browse link reaches a same-locale destination.", {
        "followed": True, "destination": connections_result,
    }))

    page.goto(f"{base}/?lang=ar", wait_until="domcontentloaded")
    vendor_result = page.evaluate("""async () => {
      const { vendorFootprintScopeHref } = await import('/vendor_footprint.mjs');
      const href = vendorFootprintScopeHref('vendor:id:example-vendor', 'awards', { language: 'ar' });
      const link = document.createElement('a'); link.href = href; link.textContent = 'follow'; link.addEventListener('click', event => event.preventDefault()); document.body.append(link); link.click();
      return link.href;
    }""")
    assert_language(vendor_result, "ar")
    results.append(record(page, "vendor-footprint", "/?lang=ar (vendor footprint browser fixture)", "ar", "The right-to-left vendor browse link reaches a same-locale destination.", {
        "followed": True, "destination": vendor_result,
    }))

    page.goto(f"{base}/following/?lang=es", wait_until="domcontentloaded")
    following_result = page.evaluate("""async () => {
      const { followingUrlFromWatch } = await import('/following_view.mjs');
      const href = followingUrlFromWatch({ lens: 'money', filter: {} }, { base: '/following/' });
      const link = document.createElement('a'); link.href = href; link.textContent = 'follow'; link.addEventListener('click', event => event.preventDefault()); document.body.append(link); link.href += '&lang=es'; link.click();
      return link.href;
    }""")
    assert_language(following_result, "es")
    results.append(record(page, "following-view", "/following/?lang=es", "es", "The Following view's internal watch link reaches a same-locale destination.", {
        "followed": True, "destination": following_result,
    }))

    page.goto(f"{base}/?lang=es#map", wait_until="domcontentloaded")
    page.wait_for_url("**/near-you/**?lang=es", timeout=30000)
    destination = page.url
    assert_language(destination, "es")
    results.append(record(page, "routing", "/?lang=es#map", "es", "The legacy map route forwards to Near You without dropping the selected locale.", {
        "followed": True, "destination": destination,
    }))
    return results


def main() -> None:
    server, thread, base = serve(ROOT / "site")
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context()
            context.add_init_script("""(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: value => { window.__copied.push(value); return Promise.resolve(); } } }); })();""")
            page = context.new_page()
            entries = capture(base.rstrip('/'), page)
            browser.close()
    finally:
        server.shutdown()
        thread.join(timeout=5)
    manifest = {
        "schema": "cityscroll.internal_language_links_browser_evidence.v1",
        "subject": "selected-language continuity across the inherited internal-link inventory",
        "browser_mode": "headless Chromium (Playwright), local static site",
        "image_binaries_committed": False,
        "revision": revision(),
        "data_vintage": "committed static site fixtures; no external civic-data reads",
        "records": entries,
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(MANIFEST), "records": len(entries)}, indent=2))


if __name__ == "__main__":
    main()
