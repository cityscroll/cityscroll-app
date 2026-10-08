#!/usr/bin/env python3
"""Real browser journey: visible homepage map, Chelsea search and retained scope.

Runs against the actual local route handler by default; --base checks a deployed
site. No civic publisher requests or repository evidence writes are performed.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
# Observe the real renderer without replacing its behavior or any civic data.
OBSERVE_MAP = """(() => {
  let library;
  Object.defineProperty(window, 'maplibregl', {
    configurable: true,
    get: () => library,
    set(value) {
      library = value;
      const NativeMap = value.Map;
      value.Map = new Proxy(NativeMap, {construct(target, args) {
        const map = Reflect.construct(target, args);
        window.__entryObservedMap = map;
        return map;
      }});
    }
  });
})()"""


def visible_map(page, minimum=150):
    canvas = page.locator('.maplibregl-canvas')
    canvas.wait_for(state='visible')
    box = canvas.bounding_box()
    height = page.viewport_size['height']
    visible = min(box['y'] + box['height'], height) - max(box['y'], 0)
    assert visible >= minimum, {'visible_height': visible, 'map': box}
    return box


def selected_map(page):
    page.wait_for_function("""() => {
      const m = window.__entryObservedMap;
      return m && !m.isMoving() && m.queryRenderedFeatures({layers:['geography-selected-fill']})
        .some(f => String(f.properties.key || f.id).includes('MN0401'));
    }""")
    assert page.locator('h1').inner_text() == 'Chelsea-Hudson Yards'
    assert parse_qs(urlsplit(page.url).query)['geo'] == ['nta2020:MN0401']
    box = visible_map(page, 250)
    geometry = page.evaluate("""() => {
      const map = window.__entryObservedMap;
      const features = map.queryRenderedFeatures({layers:['geography-selected-fill']});
      const points = features.flatMap(f => f.geometry.coordinates.flat(Infinity));
      const pixels = [];
      for(let i=0;i<points.length;i+=2) pixels.push(map.project([points[i],points[i+1]]));
      return {width:Math.max(...pixels.map(p=>p.x))-Math.min(...pixels.map(p=>p.x)),
        height:Math.max(...pixels.map(p=>p.y))-Math.min(...pixels.map(p=>p.y))};
    }""")
    assert geometry['height'] > box['height'] * .4, geometry
    return {'map': box, 'selected_boundary': geometry}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default=os.environ.get('CROL_BASE'))
    args = parser.parse_args()
    server = None
    try:
        base = args.base
        if not base:
            server = subprocess.Popen(['node','tools/serve_near_you_capture.mjs'], cwd=ROOT,
                                      stdout=subprocess.PIPE, text=True)
            base = server.stdout.readline().strip()
            assert base.startswith('http://'), base
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, channel=os.environ.get('PLAYWRIGHT_CHANNEL') or None)
            for width, height in ((1440,900),(390,844)):
                context = browser.new_context(viewport={'width':width,'height':height})
                context.add_init_script(OBSERVE_MAP)
                page = context.new_page()
                page.goto(base.rstrip('/') + '/')
                page.wait_for_selector('[data-near-geography-map-state="ready"]')
                initial = visible_map(page)
                # Negative control: the original below-the-fold map must fail.
                page.locator('.near-geo-workspace').evaluate("e => e.style.marginTop='2000px'")
                try:
                    visible_map(page)
                except AssertionError:
                    pass
                else:
                    raise AssertionError('visibility checker accepted a map below the viewport')
                page.locator('.near-geo-workspace').evaluate("e => e.style.marginTop=''")
                page.locator('#near-geo-search-input').fill('Chelsea')
                page.locator('#near-geo-search-input').press('Enter')
                page.wait_for_url('**/*MN0401*')
                selected = selected_map(page)
                # A failed records read cannot erase the selected map.
                page.route('**/near-you/deferred.json*', lambda route: route.abort())
                page.reload()
                page.locator('[data-near-you-root][data-near-deferred-state="error"]').wait_for()
                page.locator('[data-near-deferred="results"][data-near-deferred-state="error"]').wait_for(state='attached')
                selected_map(page)
                page.unroute('**/near-you/deferred.json*')
                page.reload()
                selected_map(page)
                page.goto(base.rstrip('/') + '/')
                page.evaluate("history.replaceState({}, '', '/?surface=records&q=rezoning&agency=Planning&when=month')")
                page.locator('#near-geo-search-input').fill('Chelsea')
                page.locator('#near-geo-search-input').press('Enter')
                page.wait_for_url('**/*MN0401*')
                retained = parse_qs(urlsplit(page.url).query)
                assert retained['surface'] == ['records']
                assert retained['q'] == ['rezoning']
                assert retained['agency'] == ['Planning']
                assert retained['when'] == ['month']
                print(json.dumps({'viewport':[width,height], 'homepage':initial,'chelsea':selected}), flush=True)
                context.close()
            browser.close()
    finally:
        if server:
            server.terminate()
            server.wait(timeout=10)


if __name__ == '__main__':
    main()
