#!/usr/bin/env python3
"""Check concise About, localized exact links and mock-only feedback; images stay ignored."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright
from capture_guide_product_access import serve

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = ROOT / '.artifacts/concise-about'
MANIFEST = ROOT / 'docs/evidence/concise-about/capture-manifest.json'
TARGETS = dict(zip(
    ['context', 'past-patterns', 'staffing-list-establishment-formula',
     'property-disposition-timing-formula', 'tax-lien-sale-predictions',
     'zoning-base-rates', 'applicant-conditioned-ulurp'],
    ['what-each-note-counts', 'patterns-from-past-records', 'eligible-list-timing',
     'property-sale-timing', 'tax-lien-progression', 'zoning-case-history', 'applicant-history']))
GUIDE = '/guide/understand/flags-and-historical-patterns/'


def snapshot(revision):
    dest = SCRATCH / 'before/site'
    files = ['index.html', 'about.html', 'i18n.js', 'brand.css', 'contextual_ux_feedback_prompt.mjs']
    files += [f'i18n/lang/{p.name}' for p in (ROOT / 'site/i18n/lang').glob('*.js')]
    for file in files:
        out = dest / file
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(subprocess.check_output(['git', 'show', f'{revision}:site/{file}'], cwd=ROOT))
    return dest


def routes(page, base, submissions):
    def handle(route):
        request = route.request
        if request.method not in ('GET', 'HEAD'):
            if urlsplit(request.url).path == '/feedback' and request.method == 'POST':
                submissions.append(request.post_data_json)
                route.fulfill(status=200, content_type='application/json', body='{"ok":true}',
                              headers={'Access-Control-Allow-Origin': '*'})
            elif request.method == 'OPTIONS':
                route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST'})
            else:
                route.abort()
        elif any(name in request.url for name in ['/analytics.js', '/clarity.js', '/beta_flags.js']):
            route.fulfill(status=200, content_type='application/javascript', body='')
        elif not request.url.startswith(base):
            route.abort()
        else:
            route.continue_()
    page.route('**/*', handle)


def capture(browser, directory, stage, revision, locales):
    receipts = []
    server, thread, base = serve(directory)
    try:
        for locale in locales:
            for width, height in [(390, 844), (1440, 900)]:
                context = browser.new_context(viewport={'width': width, 'height': height})
                page = context.new_page()
                submissions = []
                routes(page, base, submissions)
                response = page.goto(base + 'about.html?lang=' + locale, wait_until='networkidle')
                page.wait_for_function('(l) => window.LANG === l && document.documentElement.lang === l', arg=locale)
                page.evaluate('document.fonts.ready')
                assert response.status == 200
                assert page.locator('html').get_attribute('dir') == ('rtl' if locale in ['ar', 'ur'] else 'ltr')
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                assert not submissions
                image = page.screenshot(full_page=True, animations='disabled')
                (SCRATCH / f'{stage}-{locale}-{width}.png').write_bytes(image)
                receipt = {'stage': stage, 'locale': locale, 'route': '/about.html?lang=' + locale,
                    'viewport': {'width': width, 'height': height}, 'revision': revision,
                    'source_state': 'committed revision' if stage == 'before' else 'captured source identified by source_sha256',
                    'source_sha256': hashlib.sha256((directory / 'about.html').read_bytes()).hexdigest(),
                    'data_vintage': 'Authored page; no civic dataset or live writes used',
                    'sha256': hashlib.sha256(image).hexdigest(),
                    'assertion': 'About renders in the selected language and direction without horizontal overflow',
                    'assertion_holds': True}
                if stage == 'after':
                    assert page.locator('.explore-grid, .pattern-grid, .pattern-card').count() == 0
                    assert page.locator('.legacy-target:visible').count() == 0
                    assert page.locator('a[href="mailto:team@cityscroll.org"]').count() == 1
                    assert page.locator('a[href="mailto:feedback@cityscroll.org"]').count() == 1
                    assert page.locator('#accessibility').is_visible()
                    assert page.locator('#content-policy').is_visible()
                    if locale == 'en':
                        narrative = page.locator('[data-about-narrative]').all_text_contents()
                        receipt['authored_words'] = len(' '.join(narrative).split())
                        assert 200 <= receipt['authored_words'] <= 300
                    receipt['destinations'] = {}
                    for old, target in TARGETS.items():
                        page.goto(base + 'about.html?lang=' + locale + '#' + old, wait_until='networkidle')
                        link = page.locator(f'#{old} a')
                        assert link.is_visible()
                        assert link.get_attribute('href') == GUIDE + '?lang=' + locale + '#' + target
                        link.click()
                        expected = GUIDE if locale == 'en' else GUIDE.replace('/guide/', '/guide/' + locale + '/')
                        page.wait_for_url('**' + expected + '**')
                        page.wait_for_function('(l) => document.documentElement.lang === l', arg=locale)
                        assert page.locator('#' + target).is_visible()
                        assert urlsplit(page.url).fragment == target
                        receipt['destinations'][old] = expected + '#' + target
                        page.go_back(wait_until='networkidle')
                        assert urlsplit(page.url).fragment == old
                    page.goto(base + 'about.html?lang=' + locale, wait_until='networkidle')
                    # Exercise picker replacement of translated HTML and its new links.
                    alternate = 'es' if locale == 'en' else 'en'
                    page.select_option('#langSelect', alternate)
                    page.wait_for_function('(l) => document.documentElement.lang === l', arg=alternate)
                    assert '?lang=' + alternate in page.locator('#explore a').get_attribute('href')
                    assert page.locator('.explore-grid, .pattern-grid').count() == 0
                    page.select_option('#langSelect', locale)
                    page.wait_for_function('(l) => document.documentElement.lang === l', arg=locale)
                    page.locator('#fbpasttask summary').click()
                    assert not submissions
                    page.locator('#fbsend').click()
                    assert not submissions  # Invalid empty message never sends.
                    page.locator('[data-cat="general"]').click()
                    page.fill('#fbmessage', 'Test-only: the feedback form is being checked with a mocked response.')
                    page.fill('#fbemail', 'reader@example.com')
                    page.locator('#fbsend').click()
                    page.wait_for_function('document.querySelector("#fbmessage").value === ""')
                    assert len(submissions) == 1
                    assert submissions[0]['category'] == 'general'
                    assert submissions[0]['email'] == 'reader@example.com'
                    assert page.locator('#fbemail').input_value() == ''
                    assert page.locator('#fbmsg').inner_text()
                    assert page.locator('[data-i18n-html="about_note_feedback_html"]').is_visible()
                    receipt['mocked_feedback'] = 'One intercepted POST; empty input and disclosure sent none; success cleared fields; privacy visible'
                    # The existing standards document forwards to About accessibility.
                    page.goto(base + 'standards.html', wait_until='networkidle')
                    page.wait_for_url('**/about.html#accessibility')
                    assert page.locator('#accessibility').is_visible()
                receipts.append(receipt)
                context.close()
                print(f'{stage}: {locale} {width}px checked', flush=True)
    finally:
        server.shutdown(); thread.join(timeout=5); server.server_close()
    return receipts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', required=True)
    parser.add_argument('--locales', default='en,es,zh-Hans,ru,bn,ht,ko,fr,pl,ar,ur')
    args = parser.parse_args()
    SCRATCH.mkdir(parents=True, exist_ok=True)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    before = snapshot(args.before)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            receipts = capture(browser, before, 'before', args.before, ['en'])
            receipts += capture(browser, ROOT / 'site', 'after', revision, args.locales.split(','))
        finally:
            browser.close()
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps({'schema': 'cityscroll.about-capture.v1', 'captures': receipts}, indent=2) + '\n')


if __name__ == '__main__':
    main()
