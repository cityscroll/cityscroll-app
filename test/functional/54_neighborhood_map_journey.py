#!/usr/bin/env python3
"""Real renderer + production headers: neighborhood, camera, results, history."""
import os
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlparse
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

# The results list nests a labelled "Meetings in districts that overlap this
# neighborhood" preview section (added in #2322). Those rows cover a whole
# overlapping community district, not the selected neighborhood, so they carry
# district- or borough-level geographic evidence rather than the exact NTA and
# are explicitly not counted as exact neighborhood records. Judge only the exact
# records here; the preview section is a separate contract exercised on its own.
EXACT_RECORDS = (
    '.near-results [data-near-you-record-inspection]'
    ':not(.near-broader-districts [data-near-you-record-inspection])'
)

def exact_geography_keys(page):
    """Geography-evidence keys of the exact neighborhood records only."""
    return page.locator(EXACT_RECORDS).evaluate_all(
        "nodes=>nodes.map(n=>JSON.parse(n.dataset.nearYouRecordInspection).geography?.key ?? null)"
    )

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
                evidence=exact_geography_keys(page)
                # Positive control: selecting a populated downtown neighborhood must
                # surface its own records, and every exact record must be keyed to the
                # selected neighborhood. This still fails if selection returns nothing,
                # broadens to other neighborhoods, or drops the geographic evidence.
                assert evidence, 'no exact neighborhood records rendered for the selection'
                assert all(key=='geography:nta2020:MN0102' for key in evidence), evidence[:2]
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
                # Residential directory keeps the long borough list behind a closed
                # disclosure so keyboard users skip past it; open it before clicking.
                def open_area_directory():
                    directory=page.locator('details.near-area-directory-list')
                    if directory.count() == 0:
                        return
                    if not directory.first.evaluate('node => node.open'):
                        directory.first.locator('summary').click()
                        page.wait_for_function(
                            "() => document.querySelector('details.near-area-directory-list')?.open === true"
                        )
                open_area_directory()
                area=page.locator('#near-area-list').get_by_role('link', name='Williamsburg', exact=True)
                area.scroll_into_view_if_needed()
                area.click()
                page.wait_for_url('**geo=nta2020%3ABK0102**')
                ready(page,selected=True)
                assert page.evaluate('window.__sameDocument === true'), 'area list reloaded document'
                open_area_directory()
                page.locator('#near-area-list').get_by_role('link', name='Greenpoint', exact=True).scroll_into_view_if_needed()
                page.locator('#near-area-list').get_by_role('link', name='Greenpoint', exact=True).click()
                page.wait_for_url('**geo=nta2020%3ABK0101**')
                ready(page,selected=True,allow_unavailable=True)
                assert page.locator('.near-hero h1').inner_text()=='Greenpoint'
                local_evidence=exact_geography_keys(page)
                assert all(key=='geography:nta2020:BK0101' for key in local_evidence), 'neighborhood broadened to citywide records'
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
                district_evidence=exact_geography_keys(page)
                assert all(key=='geography:community_district:K01' for key in district_evidence)
                if district_evidence:
                    page.locator(EXACT_RECORDS).first.click()
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
                # Native links must carry the same filters as intercepted clicks.
                page.goto(base+'/near-you/?geo=nta2020%3ABK0101&lens=land&agency=Transportation&q=curb',wait_until='domcontentloaded')
                ready(page,selected=True,allow_unavailable=True)
                for selector in ['.near-area-list a', '[data-geography-related-district]', '[data-geography-overlap-records]']:
                    href=page.locator(selector).first.get_attribute('href')
                    query=parse_qs(urlparse(href).query)
                    assert query.get('lens')==['land'], (selector,query)
                    assert query.get('agency')==['Transportation'], (selector,query)
                    assert query.get('q')==['curb'], (selector,query)
                href=page.locator('.near-area-list a').filter(has_text='Tribeca-Civic Center').first.get_attribute('href')
                native=browser.new_page(viewport={'width':width,'height':height})
                native.add_init_script(INSTRUMENT)
                native.goto(urljoin(base,href),wait_until='domcontentloaded')
                ready(native,selected=True,allow_unavailable=True)
                assert 'geo=nta2020%3AMN0102' in native.url
                native.close()
                # Prefer the resident Search control over HTMLFormElement.submit():
                # the static Pages origin resolves place labels in the submit
                # listener, and a raw form.submit() skips that path.
                page.locator('.near-place-guide > summary').click()
                page.locator('[data-geography-search] input[name="neighborhood"]').fill('Tribeca-Civic Center')
                page.locator('[data-geography-search] button[type="submit"]').click()
                page.wait_for_url('**geo=nta2020%3AMN0102**')
                ready(page,selected=True,allow_unavailable=True)
                query=parse_qs(urlparse(page.url).query)
                assert query.get('agency')==['Transportation'] and query.get('q')==['curb']
                assert query.get('lens')==['land'] and 'neighborhood' not in query
                page.close()
            browser.close()
        print('PASS: desktop/mobile labels, map click, search/list selection, exact records, camera, history, unavailable coverage, district continuation and record inspection')
    finally:
        if server:
            server.terminate()
            server.wait(timeout=10)

if __name__ == '__main__':
    main()
