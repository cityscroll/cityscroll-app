#!/usr/bin/env python3
"""Check public guide figures with Chromium, using the release capture setup.

Run after build_guide_documents.mjs and prepare_guide_preview.mjs. Requires Python
Playwright and Chromium. Screenshots remain ignored; only the evidence manifest
is committed. The half-width pass models the CSS viewport at 200 percent zoom.
"""
import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright
from capture_guide_release import serve

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '.artifacts/guide-figures'
MANIFEST = ROOT / 'docs/evidence/illustrated-guide/figure-checks.json'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only', help='Comma-separated article slugs; refresh only these existing evidence rows')
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    articles = []
    for source in sorted((ROOT / 'site/guide/_articles').glob('*.md')):
        text = source.read_text()
        if '::: figure ' in text and (not args.only or source.stem in args.only.split(',')):
            articles.append(next(line[5:] for line in text.splitlines() if line.startswith('url: ')))
    assert articles, 'No illustrated articles selected'
    captures = []
    if args.only and MANIFEST.exists():
        captures = [row for row in json.loads(MANIFEST.read_text())['captures'] if row['route'] not in articles]
    server, thread, base = serve(ROOT / '.artifacts/guide-preview')
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for width, height in [(390, 844), (1440, 900)]:
                for zoom in [1, 2]:
                    context = browser.new_context(viewport={'width': width // zoom, 'height': height}, locale='en-US')
                    page = context.new_page()
                    for route in articles:
                        page.goto(base.rstrip('/') + route, wait_until='networkidle')
                        figures = page.locator('.guide-figure')
                        for figure in figures.all():
                            figure.scroll_into_view_if_needed()
                            figure.locator('img').evaluate('async e => { await e.decode(); }')
                        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), route
                        text = page.locator('.guide-body').inner_text()
                        variants = page.locator('.guide-figure img').evaluate_all('(images)=>images.map(e=>({src:new URL(e.currentSrc).pathname,width:e.naturalWidth,height:e.naturalHeight,alt:e.alt}))')
                        assert all(v['width'] and v['height'] and v['alt'] for v in variants)
                        expected = 'mobile' if width // zoom <= 600 else 'desktop'
                        assert all(v['src'].endswith(f'-{expected}.png') for v in variants)
                        # Every active enlargement link must work with native keyboard navigation.
                        for figure in figures.all():
                            link = figure.locator('a:visible')
                            link.scroll_into_view_if_needed()
                            page.evaluate('document.activeElement.blur()')
                            # Start just before the link, then use actual Tab and Enter.
                            figure.locator('figcaption').evaluate("e=>{e.tabIndex=-1;e.focus()}")
                            page.keyboard.press('Tab')
                            assert link.evaluate('e=>e===document.activeElement')
                            assert link.evaluate("e=>getComputedStyle(e).outlineStyle!=='none' || getComputedStyle(e).boxShadow!=='none'")
                            y = page.evaluate('scrollY')
                            href = link.get_attribute('href')
                            page.keyboard.press('Enter')
                            page.wait_for_url('**' + href)
                            assert page.locator('img').evaluate('e=>e.complete && e.naturalWidth>0')
                            assert len(context.pages) == 1
                            page.go_back(wait_until='networkidle')
                            assert abs(page.evaluate('scrollY') - y) <= 2, (route, 'Back scroll')
                        page.route('**/media/guide/**', lambda r: r.abort())
                        page.reload(wait_until='networkidle')
                        assert page.locator('.guide-body').inner_text() == text, (route, 'image fallback text')
                        assert page.locator('.guide-figure figcaption').count() == len(variants)
                        page.unroute('**/media/guide/**')
                        page.reload(wait_until='networkidle')
                        for figure in page.locator('.guide-figure').all():
                            figure.scroll_into_view_if_needed()
                            figure.locator('img').evaluate('async e=>{await e.decode()}')
                        file = OUTPUT / f'{route.strip("/").split("/")[-1]}-{width}-{zoom}x.png'
                        page.screenshot(path=str(file), full_page=True, animations='disabled')
                        captures.append({'route': route, 'viewport': {'width': width // zoom, 'height': height},
                            'review_width': width, 'zoom': zoom, 'zoom_method': 'CSS viewport divided by zoom',
                            'revision': revision, 'captured_at': datetime.now(timezone.utc).isoformat(),
                            'data_vintage': 'Tracked guide and public capture receipts', 'assets': variants,
                            'assertion': 'Images load at the selected width; all enlargement links open with Tab and Enter in the same tab; Back restores position; complete instructions and captions survive blocked images; no horizontal overflow.',
                            'assertion_holds': True, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
                        print(f'passed {route} {width}px {zoom}x', flush=True)
                    context.close()
            # Product navigation carries locale and safe authored scope; Back returns to the step.
            context = browser.new_context(viewport={'width': 390, 'height': 844})
            page = context.new_page()
            route = '/guide/how-to/look-at-records-as-of-a-day/?lang=es&token=discard'
            page.goto(base.rstrip('/') + route, wait_until='networkidle')
            link = page.locator('.guide-body a[href*="as_of=2024-06-01"]').first
            assert 'lang=es' in link.get_attribute('href') and 'token=' not in link.get_attribute('href')
            link.scroll_into_view_if_needed(); y = page.evaluate('scrollY')
            link.click(); page.wait_for_url('**/agencies/parks-and-recreation/**')
            assert len(context.pages) == 1
            page.go_back(wait_until='networkidle')
            assert abs(page.evaluate('scrollY') - y) <= 2
            context.close(); browser.close()
    finally:
        server.shutdown(); server.server_close(); thread.join(5)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps({'schema': 'cityscroll.guide-figure-checks.v1',
        'locale_navigation_and_back': True, 'captures': captures}, indent=2) + '\n')


if __name__ == '__main__':
    main()
