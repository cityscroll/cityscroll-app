#!/usr/bin/env python3
"""Real renderer + production headers: neighborhood, camera, results, history."""
import os
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
INSTRUMENT = """(() => {
  window.__journeyMaps = [];
  let lib;
  Object.defineProperty(window, 'maplibregl', {configurable:true,
    get:()=>lib, set:v=>{lib=v; v.Map=new Proxy(v.Map,{construct(T,args){
      const map=Reflect.construct(T,args); window.__journeyMaps.push(map); return map;
    }});}
  });
})();"""

def ready(page, selected=False, allow_unavailable=False):
    try:
        page.wait_for_function("""() => {
      const host=document.querySelector('#near-map-enhanced');
      return host && !host.hidden && Number(host.dataset.renderedNeighborhoodLabelCount)>0;
    }""", timeout=30000)
    except Exception:
        print(page.evaluate("""() => ({url:location.href,root:document.querySelector('[data-near-you-root]')?.dataset,host:document.querySelector('#near-map-enhanced')?.dataset,maps:window.__journeyMaps.map(m=>({connected:m.getContainer().isConnected,loaded:m.loaded(),zoom:m.getZoom()}))})"""),flush=True)
        raise
    page.wait_for_function("""allowed => {
      const state=document.querySelector('[data-near-you-root]')?.dataset.nearDeferredState;
      return state==='ready' || (allowed && state==='error');
    }""", arg=allow_unavailable, timeout=30000)
    if selected:
        page.wait_for_function("""() => {
          const map=window.__journeyMaps.filter(m=>m.getContainer().isConnected).at(-1);
          return map && map.getZoom()>11 && map.getSource('geography-selected')?._data?.features.length===1;
        }""", timeout=30000)
    assert page.locator('#nearMapSvg').is_hidden()

def main():
    server = None
    base = os.environ.get('CROL_BASE')
    if not base:
        server=subprocess.Popen(['node','tools/serve_near_you_capture.mjs'],cwd=ROOT,stdout=subprocess.PIPE,text=True)
        base=server.stdout.readline().strip()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch()
            for width,height in [(1440,900),(390,844)]:
                print(f'viewport {width}',flush=True)
                page=browser.new_page(viewport={'width':width,'height':height})
                page.add_init_script(INSTRUMENT)
                page.goto(base+'/near-you/',wait_until='domcontentloaded')
                ready(page)
                page.evaluate("history.replaceState({}, '', '?scope=citywide&lens=meetings')")
                page.evaluate('window.__sameDocument=true')
                search=page.locator('[data-geography-search] input[name="neighborhood"]')
                search.fill('Tribeca-Civic Center')
                search.press('Enter')
                page.wait_for_url('**geo=nta2020%3AMN0102**')
                ready(page,selected=True)
                assert page.url.find('scope=') == -1
                assert 'lens=meetings' in page.url
                assert page.evaluate('window.__sameDocument === true'), 'selection reloaded document'
                evidence=page.locator('.near-results [data-near-you-record-inspection]').evaluate_all("nodes=>nodes.map(n=>JSON.parse(n.dataset.nearYouRecordInspection).geography)")
                assert all(item and item.get('key')=='geography:nta2020:MN0102' for item in evidence), evidence[:2]
                if server:
                    assert evidence, 'retained local fixture must exercise actual records'
                page.evaluate('window.scrollTo(0,0)')
                top=page.locator('#near-map-enhanced').bounding_box()['y']
                if top >= height-160:
                    print(page.evaluate("() => [...document.querySelector('[data-near-you-root]').children].map(n=>({tag:n.tagName,cls:n.className,top:n.getBoundingClientRect().top,height:n.getBoundingClientRect().height}))"),flush=True)
                    if os.environ.get('CROL_SCREENSHOT_DIR'):
                        page.screenshot(path=os.environ['CROL_SCREENSHOT_DIR']+f'/layout-failure-{width}.png',full_page=True)
                assert top < height-160, f'map is below the useful viewport: {top}'
                if os.environ.get('CROL_SCREENSHOT_DIR'):
                    page.screenshot(path=os.environ['CROL_SCREENSHOT_DIR']+f'/selected-{width}.png',full_page=True)
                assert 'nta2020%3AMN0102' in page.locator('[data-near-you-root]').get_attribute('data-near-deferred-href')
                page.go_back(wait_until='domcontentloaded')
                page.wait_for_function("() => !new URL(location.href).searchParams.has('geo')")
                ready(page)
                page.go_forward(wait_until='domcontentloaded')
                ready(page,selected=True)
                page.reload(wait_until='domcontentloaded')
                print('reload',flush=True)
                ready(page,selected=True)
                canvas=page.locator('#near-map-enhanced canvas')
                point=page.evaluate("""() => {
                  const map=window.__journeyMaps.filter(m=>m.getContainer().isConnected).at(-1);
                  map.jumpTo({center:[-74.009,40.709],zoom:13});
                  return map.project([-74.009,40.709]);
                }""")
                canvas.click(position=point)
                page.wait_for_url('**geo=nta2020%3AMN0101**')
                ready(page,selected=True)
                page.evaluate('window.__sameDocument=true')
                area=page.locator('.near-area-list a').filter(has_text='Williamsburg').first
                area.click()
                page.wait_for_function("() => new URL(location.href).searchParams.get('geo') !== 'nta2020:MN0102'")
                ready(page,selected=True)
                assert page.evaluate('window.__sameDocument === true'), 'area list reloaded document'
                page.locator('.near-area-list a').filter(has_text='Greenpoint').first.click()
                page.wait_for_url('**geo=nta2020%3ABK0101**')
                ready(page,selected=True,allow_unavailable=True)
                assert page.locator('.near-hero h1').inner_text()=='Greenpoint'
                local_evidence=page.locator('.near-results [data-near-you-record-inspection]').evaluate_all("nodes=>nodes.map(n=>JSON.parse(n.dataset.nearYouRecordInspection).geography)")
                assert all(item and item.get('key')=='geography:nta2020:BK0101' for item in local_evidence), 'neighborhood broadened to citywide records'
                land_url = page.url.replace('lens=meetings', 'lens=land')
                page.goto(land_url, wait_until='domcontentloaded')
                ready(page,selected=True,allow_unavailable=True)
                district=page.locator('[data-geography-related-district]').filter(has_text='Brooklyn Community District 1').first
                district.wait_for()
                district.click()
                page.wait_for_url('**geo=community_district%3AK01**')
                assert 'lens=land' in page.url
                page.wait_for_function("() => document.querySelector('[data-near-you-root]')?.dataset.nearDeferredState==='ready'")
                assert page.locator('.near-results').is_visible()
                if server:
                    assert page.locator('.near-results [data-record-id]').count()>0
                district_evidence=page.locator('.near-results [data-near-you-record-inspection]').evaluate_all("nodes=>nodes.map(n=>JSON.parse(n.dataset.nearYouRecordInspection).geography)")
                assert all(item and item.get('key')=='geography:community_district:K01' for item in district_evidence)
                if district_evidence:
                    page.locator('.near-results [data-near-you-record-inspection]').first.click()
                    assert page.locator('dialog[open]').is_visible()
                    assert page.locator('dialog[open] a[data-near-you-record-inspection-open]').get_attribute('href')
                page.goto(base+'/near-you/#map?level=community_district&parent=Manhattan&id=M03&lens=meetings',wait_until='domcontentloaded')
                page.wait_for_function("() => new URL(location.href).searchParams.get('cd')==='M03' && !location.hash")
                page.wait_for_function("() => document.querySelector('[data-near-you-root]')?.dataset.nearDeferredState==='ready'")
                page.evaluate('window.__sameDocument=true; location.hash="map?level=community_district&parent=Manhattan&id=M04&lens=meetings"')
                page.wait_for_function("() => new URL(location.href).searchParams.get('cd')==='M04' && !location.hash")
                page.wait_for_function("() => document.querySelector('[data-near-you-root]')?.dataset.nearDeferredState==='ready'")
                assert page.evaluate('window.__sameDocument === true'), 'hash change reloaded document'
                assert 'cd=M04' in page.locator('[data-near-you-root]').get_attribute('data-near-deferred-href')
                page.close()
            browser.close()
        print('PASS: desktop/mobile labels, map click, search/list selection, exact records, camera, history, unavailable coverage, district continuation and record inspection')
    finally:
        if server:
            server.terminate()
            server.wait(timeout=10)

if __name__ == '__main__':
    main()
