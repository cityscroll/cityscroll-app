#!/usr/bin/env python3
"""Capture address-entry → parcel-geography selection on phone and desktop.

Exercises the production browser modules (PAD geocoder + geography address
adapter + retained shards) in headless Chromium with external network blocked.
Screenshot binaries stay under the local task scratch directory; only the
textual capture manifest is committed.
"""

from __future__ import annotations

import functools
import hashlib
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from repository_revision import resolve_repository_revision

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_DIR = ROOT / "docs" / "evidence" / "address-entry-parcel-geography"
MANIFEST_PATH = MANIFEST_DIR / "capture-manifest.json"
SCREENSHOT_DIR = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "address-entry-parcel-geography-screenshots"

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("phone", 390, 844),
)

QUERY = "810 East 16th Street Brooklyn"
PUBLIC_ALIAS = "c45f798fb2440"
DATA_VINTAGE = (
    "PAD 26b; parcel-geography pluto_25v4 "
    "(mappluto_published_latitude_longitude); "
    "nta2020 26B; community/council 2026-05-26; precincts 26B"
)

HARNESS_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Address entry parcel geography capture</title>
  <link rel="stylesheet" href="/civic-documents.css">
  <style>
    body { margin: 0; font-family: "Noto Sans", system-ui, sans-serif; background: #f6f3ee; color: #1b1b1b; }
    main { max-width: 42rem; margin: 0 auto; padding: 1.25rem 1rem 2rem; }
    .kicker { text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.75rem; color: #5c574f; }
    h1 { font-family: "Space Grotesk", system-ui, sans-serif; font-size: 1.75rem; margin: 0.25rem 0 0.75rem; }
    .status { min-height: 1.5rem; margin: 0.5rem 0 1rem; }
    .card { background: #fff; border: 1px solid #d9d2c5; border-radius: 12px; padding: 1rem 1.1rem; box-shadow: 0 1px 0 rgba(0,0,0,0.04); }
    .card h2 { margin: 0 0 0.35rem; font-size: 1.35rem; }
    .card dl { display: grid; grid-template-columns: 9rem 1fr; gap: 0.35rem 0.75rem; margin: 0.75rem 0 0; }
    .card dt { color: #5c574f; }
    .card dd { margin: 0; font-weight: 600; }
    .meta { margin-top: 1rem; font-size: 0.85rem; color: #5c574f; }
    .error { color: #8b1e1e; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main id="main" data-address-entry-capture>
    <p class="kicker">Near You address entry</p>
    <h1>Address to neighborhood</h1>
    <p class="status" data-capture-status aria-live="polite">Resolving address…</p>
    <section class="card" data-capture-result hidden>
      <h2 data-capture-selected-label></h2>
      <p data-capture-selection></p>
      <dl>
        <dt>Neighborhood</dt><dd data-capture-nta></dd>
        <dt>Community district</dt><dd data-capture-cd></dd>
        <dt>Council district</dt><dd data-capture-council></dd>
        <dt>Police precinct</dt><dd data-capture-precinct></dd>
        <dt>Method</dt><dd data-capture-method></dd>
      </dl>
    </section>
    <p class="meta" data-capture-meta></p>
    <pre class="error" data-capture-error hidden></pre>
  </main>
  <script type="module">
    const query = %QUERY_JSON%;
    const statusEl = document.querySelector("[data-capture-status]");
    const resultEl = document.querySelector("[data-capture-result]");
    const errorEl = document.querySelector("[data-capture-error]");
    const metaEl = document.querySelector("[data-capture-meta]");
    const fetches = [];
    const originalFetch = globalThis.fetch.bind(globalThis);
    // Patch before importing helpers so both PAD and parcel loaders share the spy.
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input?.url || String(input));
      fetches.push(url);
      return originalFetch(input, init);
    };

    const { GEOGRAPHY_NAVIGATION_LAYER_TYPES } = await import("/geography_navigation_capability.mjs");
    const { loadCivicGeographyLayer } = await import("/civic_geography.mjs");
    const { simplifiedLayerSiteUrl } = await import("/geography_navigation_map.mjs");
    const { createPrecomputedAddressGeocoder } = await import("/precomputed_address_geocoder.mjs");
    const { createGeographyAddressEntryResolver } = await import("/geography_address_entry.mjs");
    // Same production helper pair the map island uses: PAD BBL contract + geography adapter.
    const geocodeAddressText = createPrecomputedAddressGeocoder({ fetchImpl: globalThis.fetch });
    const resolveGeographyAddressEntry = createGeographyAddressEntryResolver({
      geocode: geocodeAddressText,
      fetchImpl: globalThis.fetch,
    });

    function text(selector, value) {
      const node = document.querySelector(selector);
      if (node) node.textContent = value == null ? "" : String(value);
    }

    try {
      const pad = await geocodeAddressText(query);
      if (pad?.status !== "matched" || !pad.bbl) {
        throw new Error(`PAD did not match: ${JSON.stringify(pad)}`);
      }
      const registry = await (await fetch("/data/geography/layer_registry.json")).json();
      const layerData = [];
      for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
        const url = simplifiedLayerSiteUrl(type, registry, { siteRoot: "/" });
        if (!url) continue;
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        if (!response.ok) continue;
        const doc = loadCivicGeographyLayer(await response.json());
        if (doc) layerData.push(doc);
      }
      if (!layerData.length) throw new Error("navigation layers unavailable");

      const resolved = await resolveGeographyAddressEntry(query, { layerData });
      const entry = resolved.entry;
      if (!entry?.ok) {
        throw new Error(`entry failed: ${JSON.stringify(entry?.recovery || entry)}`);
      }

      text("[data-capture-selected-label]", entry.selected.label);
      text("[data-capture-selection]", entry.selection.geo);
      text("[data-capture-nta]", `${entry.bundle.by_type.nta2020[0].id} · ${entry.bundle.by_type.nta2020[0].label}`);
      text("[data-capture-cd]", entry.bundle.by_type.community_district[0].id);
      text("[data-capture-council]", entry.bundle.by_type.council_district[0].id);
      text("[data-capture-precinct]", entry.bundle.by_type.police_precinct[0].id);
      text("[data-capture-method]", entry.bundle.by_type.nta2020[0].method);
      statusEl.textContent = `Location matched ${entry.selected.label}.`;
      resultEl.hidden = false;
      metaEl.textContent = `PAD BBL ${pad.bbl}; shard-scoped fetches only; coordinates kept ephemeral.`;
      document.documentElement.dataset.captureReady = "true";
      window.__ADDRESS_ENTRY_CAPTURE__ = {
        ok: true,
        query_present_in_dom: document.body.innerText.includes(query),
        pad_bbl: pad.bbl,
        selected_id: entry.selected.id,
        selected_label: entry.selected.label,
        selection_geo: entry.selection.geo,
        community_district: entry.bundle.by_type.community_district[0].id,
        council_district: entry.bundle.by_type.council_district[0].id,
        police_precinct: entry.bundle.by_type.police_precinct[0].id,
        method: entry.bundle.by_type.nta2020[0].method,
        ephemeral_point_present: Boolean(resolved.ephemeralPoint),
        fetch_urls: fetches.slice(),
        href: location.href,
        search: location.search,
      };
    } catch (error) {
      statusEl.textContent = "Address entry capture failed.";
      errorEl.hidden = false;
      errorEl.textContent = String(error && error.stack || error);
      document.documentElement.dataset.captureReady = "error";
      window.__ADDRESS_ENTRY_CAPTURE__ = {
        ok: false,
        error: String(error && error.message || error),
        fetch_urls: fetches.slice(),
      };
    }
  </script>
</body>
</html>
""".replace("%QUERY_JSON%", json.dumps(QUERY))


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, harness_html: str = "", **kwargs):
        self._harness_html = harness_html
        super().__init__(*args, **kwargs)

    def log_message(self, _format, *_args):
        return

    def do_GET(self):  # noqa: N802
        if self.path.split("?", 1)[0] in {"/__capture/address-entry.html", "/__capture/address-entry"}:
            body = self._harness_html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()


def serve(directory: Path, harness_html: str) -> tuple[ThreadingHTTPServer, str]:
    handler = functools.partial(
        QuietHandler,
        directory=str(directory),
        harness_html=harness_html,
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def assert_capture_payload(payload: dict) -> None:
    if not payload.get("ok"):
        raise AssertionError(f"capture failed: {payload}")
    if payload.get("selected_id") != "BK1403":
        raise AssertionError(f"expected BK1403, got {payload.get('selected_id')}")
    if payload.get("selected_label") != "Midwood":
        raise AssertionError(f"expected Midwood, got {payload.get('selected_label')}")
    if payload.get("selection_geo") != "nta2020:BK1403":
        raise AssertionError(f"unexpected selection geo {payload.get('selection_geo')}")
    if payload.get("community_district") != "K14":
        raise AssertionError("expected community district K14")
    if payload.get("council_district") != "45":
        raise AssertionError("expected council district 45")
    if payload.get("police_precinct") != "70":
        raise AssertionError("expected precinct 70")
    if payload.get("method") != "parcel_membership":
        raise AssertionError("expected parcel_membership method")
    if payload.get("query_present_in_dom"):
        raise AssertionError("entered address leaked into visible capture DOM")
    if payload.get("search"):
        raise AssertionError("address or coordinates leaked into URL search")
    urls = payload.get("fetch_urls") or []
    if not any("/data/address-index/manifest.json" in url for url in urls):
        raise AssertionError(f"PAD manifest was not fetched: {urls}")
    if not any("/data/parcel-geography/manifest.json" in url for url in urls):
        raise AssertionError(f"parcel-geography manifest was not fetched: {urls}")
    for url in urls:
        if url.startswith("http") and "127.0.0.1" not in url and "localhost" not in url:
            raise AssertionError(f"external fetch observed: {url}")
    if any("citywide" in url or "all-parcels" in url for url in urls):
        raise AssertionError(f"citywide corpus fetch observed: {urls}")
    parcel_shards = [
        url for url in urls
        if "/data/parcel-geography/" in url
        and url.rstrip("/").split("?", 1)[0].endswith(".json")
        and "manifest" not in url
    ]
    if len({url.split("?", 1)[0] for url in parcel_shards}) != 1:
        raise AssertionError(f"expected exactly one parcel shard fetch, got {parcel_shards}")


def map_wiring_ok() -> bool:
    source = (ROOT / "site/app/map.mjs").read_text(encoding="utf-8")
    return (
        "resolveGeographyAddressEntry" in source
        and "geography_address_entry.mjs" in source
        and "geocode: geocodeAddressText" not in source
    )


def main() -> int:
    if not map_wiring_ok():
        raise SystemExit("site/app/map.mjs is not wired to resolveGeographyAddressEntry")

    from playwright.sync_api import sync_playwright

    revision = resolve_repository_revision(ROOT)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)

    server, base = serve(ROOT / "site", HARNESS_HTML)
    captures: list[dict] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for name, width, height in VIEWPORTS:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        device_scale_factor=1,
                    )
                    page = context.new_page()
                    blocked: list[str] = []

                    def on_route(route, request, blocked=blocked):  # noqa: ANN001
                        url = request.url
                        if "127.0.0.1" in url or "localhost" in url:
                            return route.continue_()
                        blocked.append(url)
                        return route.abort()

                    page.route("**/*", on_route)
                    page.goto(f"{base}/__capture/address-entry.html", wait_until="domcontentloaded")
                    page.wait_for_function(
                        "() => document.documentElement.dataset.captureReady === 'true' || document.documentElement.dataset.captureReady === 'error'",
                        timeout=60_000,
                    )
                    payload = page.evaluate("() => window.__ADDRESS_ENTRY_CAPTURE__")
                    assert_capture_payload(payload)
                    if blocked:
                        # External aborts are expected; none may have succeeded.
                        pass

                    shot_path = SCREENSHOT_DIR / f"midwood-address-{name}.png"
                    page.screenshot(path=str(shot_path), full_page=True)
                    image_sha = sha256_bytes(shot_path.read_bytes())
                    served = {
                        "selected_id": payload["selected_id"],
                        "selected_label": payload["selected_label"],
                        "selection_geo": payload["selection_geo"],
                        "community_district": payload["community_district"],
                        "council_district": payload["council_district"],
                        "police_precinct": payload["police_precinct"],
                        "method": payload["method"],
                        "pad_bbl": payload["pad_bbl"],
                        "parcel_shard_fetches": sorted(
                            {
                                url.split("/data/parcel-geography/", 1)[-1].split("?", 1)[0]
                                for url in payload["fetch_urls"]
                                if "/data/parcel-geography/" in url and "manifest" not in url
                            }
                        ),
                        "address_present_in_url": bool(payload.get("search")),
                        "external_requests_blocked": len(blocked),
                    }
                    assertion = (
                        "Browser-wired PAD helper plus one retained parcel-geography shard "
                        "selects Midwood (BK1403) with K14, Council 45, and precinct 70; "
                        "entered address stays out of the URL; external network blocked."
                    )
                    captures.append(
                        {
                            "name": f"midwood-address-{name}",
                            "route": "/__capture/address-entry.html",
                            "viewport": {"width": width, "height": height},
                            "revision": revision,
                            "data_vintage": DATA_VINTAGE,
                            "assertion": assertion,
                            "sha256": image_sha,
                            "file": None,
                            "source": "headless-playwright-local-site-network-blocked",
                            "served_values": served,
                            "content_sha256": sha256_text(json.dumps(served, sort_keys=True)),
                        }
                    )
                    context.close()
            finally:
                browser.close()
    finally:
        server.shutdown()

    manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "address-entry-parcel-geography",
        "public_alias": PUBLIC_ALIAS,
        "capture_mode": "headless-playwright-local-site-network-blocked",
        "repository_revision": revision,
        "grounded_at": revision,
        "data_vintage": DATA_VINTAGE,
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; "
            "only this manifest is committed."
        ),
        "condition": (
            "Local site/ served; external network aborted; production "
            "geocodeAddressText + resolveGeographyAddressEntry against retained "
            "PAD and parcel-geography shards."
        ),
        "route": "/__capture/address-entry.html",
        "query": QUERY,
        "map_wiring": "site/app/map.mjs → resolveGeographyAddressEntry",
        "captures": captures,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {MANIFEST_PATH.relative_to(ROOT)} ({len(captures)} captures)")
    print(f"screenshots under {SCREENSHOT_DIR} (uncommitted)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
