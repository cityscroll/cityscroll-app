"""Live browser canary: actual same-origin tile requests, no forged Referer.

Run after deployment with CROL_BASE=https://cityscroll.org. Never records URLs
containing credentials. An HTTP 200 alone is not evidence: CARTO's watermark
is also a successful PNG, so compare the same tile with and without its key.
"""
import json
import os
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

base = os.environ.get("CROL_BASE", "https://cityscroll.org").rstrip("/")
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    map_tiles = []
    def observe(request):
        url = urlparse(request.url)
        if url.hostname and url.hostname.endswith(".basemaps.cartocdn.com"):
            map_tiles.append(bool(parse_qs(url.query).get("key")))
    page.on("request", observe)
    page.goto(base + "/near-you/", wait_until="networkidle")
    assert map_tiles and all(map_tiles), "Map renderer made missing or unkeyed tile requests"
    result = page.evaluate("""async () => {
      const m = await import('/carto_basemap.mjs');
      if (!m.hasConfiguredCartoBasemapKey()) throw new Error('Missing deployed basemap key');
      const tile = m.cartoBasemapTileUrl().replace('{z}', '12').replace('{x}', '1206').replace('{y}', '1539');
      const unkeyed = new URL(tile); unkeyed.search = '';
      const fetchTile = async (url) => {
        const response = await fetch(url);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(x => x.toString(16).padStart(2,'0')).join('');
        return {status: response.status, png: bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71, bytes: bytes.length, digest};
      };
      const keyed = await fetchTile(tile), watermark = await fetchTile(unkeyed.href);
      return {keyed, watermark, different: keyed.digest !== watermark.digest};
    }""")
    assert result["keyed"]["status"] == 200 and result["keyed"]["png"], "Keyed tile unavailable"
    assert result["watermark"]["status"] == 200 and result["watermark"]["png"], "Comparison unavailable"
    assert result["different"], "Keyed tile still matches the unkeyed watermark"
    print(json.dumps({"carto_key_configured": True, "keyed_tile_png": True, "differs_from_unkeyed_watermark": True}))
    if os.environ.get("CARTO_SCREENSHOT"):
        page.screenshot(path=os.environ["CARTO_SCREENSHOT"], full_page=False)
    browser.close()
