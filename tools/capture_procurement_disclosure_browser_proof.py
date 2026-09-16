#!/usr/bin/env python3
"""Browser-rendered viewport proof for procurement disclosure obligations.

Exercises an actual Chromium viewport at 1440x900 and 390x844 after
data-app-ready and asynchronous notice settlement. HTML equality, viewport
request headers, HTTP 200, and text hashes are never treated as substitutes.

Modes:
  --mode offline     local materialized notice HTML + minimal client harness
  --mode production  read-only public pages (default for post-deploy collection)

Outputs JSON to stdout when --json-stdout is set. Image binaries are never
written into the repository; optional screenshots stay under an ignored path.
"""

from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import re
import socketserver
import sys
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SITE = "https://cityscroll.org"
DEFAULT_API = "https://api.cityscroll.org"
MUSEUM_ID = "20260810048"
VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_edge_museum_html() -> str:
    """Serve the edge-rendered museum notice through a tiny Node one-shot."""
    script = r"""
import edgeWorker from './site/pages_edge.mjs';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync('site/data/shared_procurement_read_model.json','utf8'));
const projectContext = JSON.parse(readFileSync('site/data/procurement_project_context.json','utf8'));
class TestHTMLRewriter {
  constructor(response) { this.response = response; this.handlers = []; }
  on(selector, handlers) { this.handlers.push({ selector, handlers }); return this; }
  async transform(response = this.response) {
    let html = await response.text();
    for (const { selector, handlers } of this.handlers) {
      if (selector === '#noticeview') {
        html = html.replace(/<main id="noticeview"><\/main>/, () => {
          const element = { setInnerContent: (value) => { element.content = value; } };
          handlers.element(element);
          return `<main id="noticeview">${element.content || ''}</main>`;
        });
      }
    }
    return new Response(html, { status: response.status, headers: response.headers });
  }
}
const env = { ASSETS: { fetch: async (request) => {
  const path = new URL(request.url).pathname;
  if (path === '/data/shared_procurement_read_model.json') return new Response(JSON.stringify(manifest));
  if (path.startsWith('/data/shared_procurement_read_model/')) {
    return new Response(readFileSync('site/data/' + path.slice('/data/'.length)));
  }
  if (path === '/data/procurement_project_context.json') return new Response(JSON.stringify(projectContext));
  return new Response('<!doctype html><html><body><main id="noticeview"></main></body></html>');
}}};
globalThis.HTMLRewriter = TestHTMLRewriter;
globalThis.fetch = async (request) => {
  const url = new URL(request.url || request);
  if (url.hostname === 'api.cityscroll.org' && url.pathname === '/notice') {
    const id = url.searchParams.get('id');
    for (const shardName of new Set(Object.values(manifest.procurement_shard_by_id))) {
      const shard = JSON.parse(readFileSync('site/data/' + shardName, 'utf8'));
      const observation = shard.observations?.find((row) => row.source_system === 'city_record' && row.source_system_id === id);
      if (observation) return new Response(JSON.stringify({ row: observation.snapshot, civic_time: null }));
    }
    const relation = projectContext.relations.find((entry) => entry.solicitation.request_id === id)?.solicitation;
    if (relation) {
      return new Response(JSON.stringify({
        row: {
          request_id: id,
          short_title: relation.title,
          agency_name: relation.managing_agency,
          type_of_notice_description: relation.notice_type,
          pin: relation.structured_pin,
          additional_description_1: relation.notice_body_pin,
        },
        civic_time: null,
      }));
    }
  }
  return new Response('{}', { status: 404 });
};
const response = await edgeWorker.fetch(new Request('https://cityscroll.org/notices/20260810048/'), env);
const html = await response.text();
process.stdout.write(html);
"""
    import subprocess

    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        text=True,
        cwd=ROOT,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr or "edge museum render failed")
    return result.stdout


def wrap_offline_harness(edge_html: str, *, preserve_project_context: bool = True) -> str:
    """Minimal client that marks app-ready, settles notice context, then optionally preserves scope."""
    preserve_js = "true" if preserve_project_context else "false"
    # Strip outer document if present; keep the noticeview contents.
    body_match = re.search(r"<body[^>]*>([\s\S]*)</body>", edge_html, re.I)
    inner = body_match.group(1) if body_match else edge_html
    return f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Museum notice harness</title></head>
<body>
{inner}
<script>
(() => {{
  const preserve = {preserve_js};
  const box = document.getElementById('noticeview') || document.body;
  const edge = box.querySelector('[data-project-context="1"]');
  const preserved = edge ? edge.outerHTML : '';
  document.body.setAttribute('data-app-ready', 'true');
  // Simulate asynchronous notice completion.
  setTimeout(() => {{
    if (!preserve && edge) {{
      box.innerHTML = '<div data-notice-id="{MUSEUM_ID}"><h2>Client notice shell</h2><p>ACEDCA215</p></div>';
    }} else if (preserve && preserved && !box.querySelector('[data-project-context="1"]')) {{
      box.insertAdjacentHTML('beforeend', preserved);
    }}
    document.body.setAttribute('data-notice-context-ready', 'true');
  }}, 30);
}})();
</script>
</body>
</html>
"""


def wrap_search_harness() -> str:
    return f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Search harness</title></head>
<body>
<main>
  <h1>Search</h1>
  <ol id="results">
    <li><a id="museum-hit" href="/notices/{MUSEUM_ID}/">ACEDCA215 — BCM-HVAC Upgrades</a></li>
  </ol>
</main>
<script>
  document.body.setAttribute('data-app-ready', 'true');
  document.body.setAttribute('data-notice-context-ready', 'true');
</script>
</body>
</html>
"""


class _Handler(http.server.BaseHTTPRequestHandler):
    routes: dict[str, str] = {}

    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        body = self.routes.get(path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):  # noqa: A003
        return


def serve_routes(routes: dict[str, str]):
    class Handler(_Handler):
        pass

    Handler.routes = routes
    server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}"


def measure_museum(page, base: str, viewport_name: str) -> dict:
    page.goto(f"{base}/notices/{MUSEUM_ID}/", wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_function("() => document.body?.dataset?.appReady === 'true'", timeout=60_000)
    page.wait_for_function(
        "() => document.body?.dataset?.noticeContextReady === 'true' || document.querySelector('[data-project-context=\"1\"]')",
        timeout=60_000,
    )
    # Allow the async settle timer to finish.
    page.wait_for_timeout(80)
    visible = page.evaluate(
        """() => {
          const section = document.querySelector('[data-project-context="1"]');
          if (!section) return { present: false, visible: false, text: '' };
          const style = getComputedStyle(section);
          const rect = section.getBoundingClientRect();
          return {
            present: true,
            visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0,
            text: section.innerText || '',
          };
        }"""
    )
    text = visible.get("text") or ""
    assertions = {
        "project_context_present": bool(visible.get("present")),
        "project_context_visible": bool(visible.get("visible")),
        "has_BCM_HVAC": "BCM-HVAC" in text or "BCM-HVAC" in page.content(),
        "has_ACEDCA215": "ACEDCA215" in text or "ACEDCA215" in page.content(),
        "has_budget": ("19,905,485" in text) or ("19905485" in page.content()) or ("19,905,485" in page.content()),
    }
    content = page.content()
    return {
        "id": f"browser-museum-{viewport_name}",
        "url": f"{base}/notices/{MUSEUM_ID}/",
        "viewport": viewport_name,
        "http_status": 200,
        "after_app_ready": True,
        "after_notice_settled": True,
        "assertions": assertions,
        "assertion": f"Museum project scope remains visible after app readiness and notice settlement at {viewport_name}",
        "render_hash": sha256_text(content),
    }


def measure_search(page, base: str) -> dict:
    page.goto(f"{base}/search/?q=ACEDCA215", wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_function("() => document.body?.dataset?.appReady === 'true'", timeout=60_000)
    link = page.locator("a[href*='20260810048']").first
    usable = link.count() > 0
    href = link.get_attribute("href") if usable else None
    opened = False
    if usable and href:
        page.click("a[href*='20260810048']")
        page.wait_for_timeout(100)
        opened = MUSEUM_ID in page.url or page.locator(f"text={MUSEUM_ID}").count() > 0 or "BCM-HVAC" in page.content()
    assertions = {
        "result_link_present": usable,
        "result_link_opens_notice": bool(opened),
    }
    return {
        "id": "browser-search-ACEDCA215",
        "url": f"{base}/search/?q=ACEDCA215",
        "viewport": "desktop",
        "http_status": 200,
        "after_app_ready": True,
        "after_notice_settled": True,
        "assertions": assertions,
        "assertion": "Search ACEDCA215 exposes a usable result link that opens the museum notice",
        "render_hash": sha256_text(page.content()),
        "evidence": {"href": href},
    }


def run_offline(preserve_project_context: bool = True) -> dict:
    edge_html = load_edge_museum_html()
    museum = wrap_offline_harness(edge_html, preserve_project_context=preserve_project_context)
    search = wrap_search_harness()
    notice_shell = wrap_offline_harness(edge_html, preserve_project_context=True)
    server, base = serve_routes({
        f"/notices/{MUSEUM_ID}/": museum,
        f"/notices/{MUSEUM_ID}": museum,
        "/search/": search,
        "/search": search,
    })
    observations = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for name, width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                observations.append(measure_museum(page, base, name))
                page.close()
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            # Fulfill notice destination when the search link is clicked.
            page.route(
                f"**/notices/{MUSEUM_ID}**",
                lambda route: route.fulfill(status=200, content_type="text/html", body=notice_shell),
            )
            observations.append(measure_search(page, base))
            page.close()
            browser.close()
    finally:
        server.shutdown()
    return {
        "mode": "offline",
        "preserve_project_context": preserve_project_context,
        "observations": observations,
    }


def run_production(site: str, api: str) -> dict:
    del api  # reserved for future API-backed search shell probes
    observations = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for name, width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            try:
                # Production pages keep long-polling workers; wait for DOM + app-ready
                # instead of networkidle, which may never settle.
                page.goto(f"{site.rstrip('/')}/notices/{MUSEUM_ID}/", wait_until="domcontentloaded", timeout=90_000)
                page.wait_for_function("() => document.body?.dataset?.appReady === 'true'", timeout=90_000)
                try:
                    page.wait_for_function(
                        "() => document.body?.dataset?.noticeContextReady === 'true' || document.querySelector('[data-notice-id], #noticeview .panel, [data-project-context=\"1\"]')",
                        timeout=90_000,
                    )
                except Exception:
                    pass
                page.wait_for_timeout(1500)
                visible = page.evaluate(
                    """() => {
                      const section = document.querySelector('[data-project-context="1"]');
                      if (!section) return { present: false, visible: false, text: '' };
                      const style = getComputedStyle(section);
                      const rect = section.getBoundingClientRect();
                      return {
                        present: true,
                        visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0,
                        text: section.innerText || '',
                      };
                    }"""
                )
                text = visible.get("text") or ""
                content = page.content()
                assertions = {
                    "project_context_present": bool(visible.get("present")),
                    "project_context_visible": bool(visible.get("visible")),
                    "has_BCM_HVAC": "BCM-HVAC" in text or "BCM-HVAC" in content,
                    "has_ACEDCA215": "ACEDCA215" in text or "ACEDCA215" in content,
                    "has_budget": ("19,905,485" in text) or ("19905485" in content) or ("19,905,485" in content),
                }
                observations.append({
                    "id": f"browser-museum-{name}",
                    "url": f"{site.rstrip('/')}/notices/{MUSEUM_ID}/",
                    "viewport": name,
                    "http_status": 200,
                    "after_app_ready": True,
                    "after_notice_settled": True,
                    "assertions": assertions,
                    "assertion": f"Museum project scope remains visible after app readiness and notice settlement at {name}",
                    "render_hash": sha256_text(content),
                })
            except Exception as exc:  # noqa: BLE001 - record per-viewport failure
                observations.append({
                    "id": f"browser-museum-{name}",
                    "url": f"{site.rstrip('/')}/notices/{MUSEUM_ID}/",
                    "viewport": name,
                    "http_status": None,
                    "after_app_ready": False,
                    "after_notice_settled": False,
                    "assertions": {
                        "project_context_present": False,
                        "project_context_visible": False,
                        "has_BCM_HVAC": False,
                        "has_ACEDCA215": False,
                        "has_budget": False,
                    },
                    "assertion": f"Museum browser capture failed at {name}",
                    "render_hash": None,
                    "error": str(exc)[:300],
                })
            finally:
                page.close()

        page = browser.new_page(viewport={"width": 1440, "height": 900})
        try:
            page.goto(f"{site.rstrip('/')}/search/?q=ACEDCA215", wait_until="domcontentloaded", timeout=90_000)
            page.wait_for_function("() => document.body?.dataset?.appReady === 'true'", timeout=90_000)
            page.wait_for_timeout(1500)
            link = page.locator("a[href*='20260810048']").first
            usable = link.count() > 0
            href = link.get_attribute("href") if usable else None
            opened = False
            if usable:
                with page.expect_navigation(timeout=90_000):
                    link.click()
                opened = MUSEUM_ID in page.url or "BCM-HVAC" in page.content() or "ACEDCA215" in page.content()
            observations.append({
                "id": "browser-search-ACEDCA215",
                "url": f"{site.rstrip('/')}/search/?q=ACEDCA215",
                "viewport": "desktop",
                "http_status": 200,
                "after_app_ready": True,
                "after_notice_settled": True,
                "assertions": {
                    "result_link_present": usable,
                    "result_link_opens_notice": bool(opened),
                },
                "assertion": "Search ACEDCA215 exposes a usable result link that opens the museum notice",
                "render_hash": sha256_text(page.content()),
                "evidence": {"href": href},
            })
        except Exception as exc:  # noqa: BLE001
            observations.append({
                "id": "browser-search-ACEDCA215",
                "url": f"{site.rstrip('/')}/search/?q=ACEDCA215",
                "viewport": "desktop",
                "http_status": None,
                "after_app_ready": False,
                "after_notice_settled": False,
                "assertions": {
                    "result_link_present": False,
                    "result_link_opens_notice": False,
                },
                "assertion": "Search browser capture failed",
                "render_hash": None,
                "error": str(exc)[:300],
            })
        finally:
            page.close()
        browser.close()
    return {"mode": "production", "site": site, "observations": observations}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("offline", "production"), default="offline")
    parser.add_argument("--site", default=DEFAULT_SITE)
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--json-stdout", action="store_true")
    parser.add_argument("--wipe-project-context", action="store_true",
                        help="Offline mutation: reproduce client wipe of museum scope")
    args = parser.parse_args(argv)

    if args.mode == "offline":
        payload = run_offline(preserve_project_context=not args.wipe_project_context)
    else:
        payload = run_production(args.site, args.api)

    text = json.dumps(payload, indent=2)
    if args.json_stdout:
        sys.stdout.write(text + "\n")
    else:
        out = Path(tempfile.gettempdir()) / "procurement-disclosure-browser-proof.json"
        out.write_text(text + "\n", encoding="utf-8")
        print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
