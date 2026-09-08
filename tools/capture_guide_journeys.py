#!/usr/bin/env python3
"""Follow guide instructions from ordinary entry points; retain failures as evidence.

Screenshots and public response bodies stay ignored. Account writes are intercepted.
This is a manual release observation, independent of rolling-data release gates.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright
from capture_guide_product_access import serve
from capture_guide_illustrations import following_html

ROOT = Path(__file__).resolve().parents[1]
REVISION = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
OUT = ROOT / '.artifacts/guide-journeys'
MANIFEST = ROOT / 'docs/evidence/public-user-guide/literal-journeys/capture-manifest.json'
ARTICLES = {
    'board': ('how-to', 'follow-a-community-board'),
    'calendar': ('how-to', 'put-dates-in-your-calendar'),
    'evidence': ('how-to', 'check-the-evidence-behind-a-connection'),
    'asof': ('how-to', 'look-at-records-as-of-a-day'),
    'collection': ('how-to', 'collect-records-and-export-them'),
    'housing': ('start', 'explore-housing-across-city-records'),
    'duty': ('start', 'trace-a-notice-to-the-duty-behind-it'),
    'award': ('start', 'trace-an-award-and-keep-the-trail'),
}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def route_path(url):
    p = urlsplit(url)
    return p.path + ('?' + p.query if p.query else '') + ('#' + p.fragment if p.fragment else '')


class Journey:
    def __init__(self, browser, base, name, locale, width):
        self.base, self.name, self.locale = base, name, locale
        self.context = browser.new_context(viewport={'width': width, 'height': 844 if width == 390 else 900}, locale=locale)
        self.context.set_default_timeout(30000)
        self.context.set_default_navigation_timeout(45000)
        self.context.grant_permissions(['clipboard-read', 'clipboard-write'])
        self.row = {'id': f'{name}-{locale}-{width}', 'locale': locale, 'viewport_width': width,
                    'viewport_height': 844 if width == 390 else 900, 'actions': [], 'captures': [],
                    'intercepted_mutations': [], 'public_reads': []}
        self.context.route('**/*', self.traffic)
        self.guide = self.context.new_page()
        self.page = None
        self.step = None
        self.shared = None
        self.awards = json.loads((ROOT / '.artifacts/award-trail/public-read-snapshot.json').read_text())

    def traffic(self, route):
        req = route.request
        url = urlsplit(req.url)
        if req.method not in ('GET', 'HEAD'):
            self.row['intercepted_mutations'].append({'method': req.method, 'route': url.path})
            if url.path == '/inv':
                self.shared = json.loads(req.post_data)
                route.fulfill(status=200, json={'ok': True, 'id': 'disposable-guide-example', 'ttlDays': 90})
            else:
                route.fulfill(status=200, json={'ok': True})
        elif url.path == '/inv/disposable-guide-example':
            route.fulfill(status=200, json=self.shared)
        elif url.netloc == urlsplit(self.base).netloc and (url.path.startswith('/meetings/') or url.path == '/meeting.ics'):
            # Exercise the production edge handler against its retained asset input.
            script = """import edge from './site/pages_edge.mjs';
import {readFileSync} from 'node:fs';
const env={ASSETS:{fetch:async request=>{const p=new URL(request.url).pathname;
try{return new Response(readFileSync('site'+p),{headers:{'Content-Type':'application/json'}})}catch{return new Response('',{status:404})}}}};
const response=await edge.fetch(new Request(process.argv[1]),env,{});
console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()}));"""
            response = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script, req.url], cwd=ROOT, text=True))
            route.fulfill(**response)
        elif url.path == '/vendor-profile' and parse_qs(url.query).get('name', [''])[0] in self.awards['profiles']:
            profile = self.awards['profiles'][parse_qs(url.query)['name'][0]]
            route.fulfill(status=200, json={'ok': True, 'profile': profile, 'generated': self.awards['captured_at']})
        elif url.path.startswith('/following/personal'):
            route.fulfill(status=200, content_type='text/html', body='<div data-personal-state="unrecognized"></div>')
        elif url.path.rstrip('/') == '/following':
            route.fulfill(status=200, content_type='text/html', body=following_html(req.url, self.base))
        elif url.hostname in ('api.cityscroll.org', 'cityscroll-worker.crol-worker.workers.dev') and url.path in ('/search', '/search/candidates'):
            query = parse_qs(url.query).get('q', [''])[0]
            if query not in ('housing', 'parks'):
                self.public_read(route)
                return
            filename = 'candidates.json' if url.path.endswith('candidates') else 'keyword.json'
            file = (ROOT / '.artifacts/guide-illustrations' / filename) if query == 'housing' else OUT / ('parks-' + filename)
            raw = file.read_bytes()
            self.row['public_reads'].append({'route': url.path + '?q=' + query, 'source': 'retained public search response', 'sha256': digest(raw)})
            route.fulfill(status=200, content_type='application/json', body=raw)
        else:
            route.continue_()

    def public_read(self, route):
        response = route.fetch()
        raw = response.body()
        self.row['public_reads'].append({'url': route.request.url, 'status': response.status, 'sha256': digest(raw), 'observed_at': datetime.now(timezone.utc).isoformat()})
        route.fulfill(response=response)

    def observe(self, action, fn):
        self.step = action
        before = route_path(self.page.url)
        result = fn()
        match = re.search(r'Step (\d+)', action)
        instruction = self.row.get('instructions', [])[int(match[1]) - 1] if match and self.row.get('instructions') else None
        self.row['actions'].append({'instruction_words': instruction, 'article_action': action, 'before': before, 'after': route_path(self.page.url), 'observed': result or 'Control action completed.'})
        print(self.row['id'], action, flush=True)
        return result

    def capture(self, assertion):
        name = f"{self.row['id']}-{len(self.row['captures']) + 1}"
        file = OUT / (name + '.png')
        self.page.screenshot(path=str(file), full_page=False)
        self.row['captures'].append({'id': name, 'route': route_path(self.page.url), 'viewport_width': self.row['viewport_width'],
            'viewport': {'width': self.row['viewport_width'], 'height': self.row['viewport_height']},
            'revision': REVISION, 'sha256': digest(file.read_bytes()), 'file': None, 'assertion': assertion,
            'data_vintage': 'Retained repository data at the recorded revision; Following uses a disposable empty preview.'})

    def open(self):
        section, slug = ARTICLES[self.name]
        path = f'/guide/{section}/{slug}/' if self.locale == 'en' else f'/guide/{self.locale}/{section}/{slug}/'
        self.row['article'] = path
        self.guide.goto(self.base + '?lang=' + self.locale, wait_until='domcontentloaded')
        self.guide.locator(f'html[lang="{self.locale}"]').wait_for(state='attached')
        self.guide.locator('nav a[href*="/guide/"]').first.click()
        home_path = '/guide/' if self.locale == 'en' else '/guide/' + self.locale + '/'
        self.guide.wait_for_url(lambda url: urlsplit(url).path == home_path, wait_until='domcontentloaded')
        self.guide.locator(f'main a[href*="/{section}/{slug}/"]').first.click()
        self.guide.wait_for_url('**' + path + '*', wait_until='domcontentloaded')
        soup = BeautifulSoup(self.guide.content(), 'html.parser')
        main = soup.select_one('main')
        self.row['article_text_sha256'] = digest(main.get_text(' ', strip=True).encode())
        self.row['instructions'] = []
        for heading in main.select('h2'):
            if not re.match(r'(Step|Paso|第[0-9]+步|الخطوة)', heading.get_text(strip=True)):
                continue
            text = []
            for el in heading.next_siblings:
                if getattr(el, 'name', None) == 'h2':
                    break
                if getattr(el, 'name', None) in ('p', 'ul', 'ol'):
                    text.append(el.get_text(' ', strip=True))
            self.row['instructions'].append({'heading': heading.get_text(' ', strip=True), 'words': text})
        # Native new-tab navigation keeps the instructions alongside the task.
        link = self.guide.locator('main h2').first.locator('xpath=following-sibling::p[1]').locator('a').first
        link.scroll_into_view_if_needed()
        self.guide_position = self.guide.evaluate('window.scrollY')
        with self.context.expect_page() as popup:
            link.click(button='middle')
        self.page = popup.value
        self.page.wait_for_load_state('domcontentloaded')
        self.row['entry'] = {'home': '/?lang=' + self.locale, 'guide': path, 'task': route_path(self.page.url), 'navigation': 'Open the first instruction link in a new tab using a native middle click.'}

    def click(self, selector, words):
        control = self.page.locator(selector).first
        control.wait_for(state='visible')
        label = control.inner_text().strip()
        translated_label = control.locator('[data-i18n]')
        if translated_label.count() == 1:
            label = translated_label.inner_text().strip()
        # Check the actual control against the article, including localized copy.
        article = self.guide.locator('main').inner_text()
        assert label and label.casefold() in article.casefold(), f'Control wording absent from article: {label}'
        self.observe(words, lambda: control.click())
        self.row['actions'][-1]['control_label'] = label
        return label

    def board(self):
        self.click('[data-following-primary-choice="topic"] [data-i18n="quiz_meetings"]', 'Step 1: choose Hearings and meetings')
        if self.page.locator('.following-refinements').get_attribute('open') is None:
            self.click('.following-refinements > summary', 'Step 1: open Narrow it down')
        else:
            self.observe('Step 1: open Narrow it down', lambda: 'Narrow it down is already expanded after selecting the topic.')
        self.observe('Step 2: set Borough to Manhattan and Board number to 7', lambda: (
            self.page.locator('select[name="boardBorough"]').select_option(label='Manhattan'),
            self.page.locator('select[name="boardNumber"]').select_option(label='7')))
        self.click('[data-following-primary-choice="preview"]', 'Step 3: press Preview matches')
        self.page.locator('[data-following-watch-identity]').wait_for()
        summary = self.page.locator('[data-following-watch-identity]').inner_text()
        criteria = self.page.locator('[data-following-scope-panel]').inner_text()
        assert 'Manhattan' in summary and '7' in summary and 'Manhattan' in criteria and '7' in criteria
        self.observe('Step 3: check Watch summary and Watch criteria', lambda: {'summary': summary, 'criteria': criteria})
        self.capture('The clicked preview identifies Manhattan Community Board 7; no subscription yet.')
        self.step = 'Step 4: choose Weekly under Email frequency'
        self.observe(self.step, lambda: self.page.locator('input[value="weekly"]').first.check())
        self.observe('Step 4: fill Email address', lambda: self.page.locator('[data-following-subscribe-form] input[type="email"]').fill('reader@example.invalid'))
        self.click('[data-following-subscribe-submit]', 'Step 4: press Create watch')
        status = self.page.locator('[data-following-submit-status]')
        status.filter(has_text=re.compile('.+')).wait_for()
        self.page.wait_for_timeout(500)
        confirmation = status.inner_text()
        assert confirmation in self.guide.locator('main').inner_text(), f'Saved confirmation disagrees with article: {confirmation}'
        self.row['task_state'] = {'confirmation': confirmation, 'saved': 'mocked successful response', 'welcome_email': 'not sent; management link not exercised'}

    def asof(self):
        self.observe('Step 1: enter 1 June 2024 in As of', lambda: self.page.locator('#ctl-as-of').fill('2024-06-01'))
        self.click('[data-ctl-form] button', 'Step 1: press Apply')
        self.page.wait_for_url('**as_of=2024-06-01*')
        self.page.locator('[data-ctl-clear]').wait_for(state='visible')
        self.step = 'Step 2: open Later records'
        self.click('.ctl-arrived summary', self.step)
        self.observe('Step 2: compare retained and later counts', lambda: self.page.locator('[data-civic-time-ledger]').inner_text())
        self.capture('The date was entered and applied through the visible form; later records are expanded.')
        self.replay('Step 3: copy the full browser address and paste it into a new tab', '#ctl-as-of')
        assert self.page.locator('#ctl-as-of').input_value() == '2024-06-01'
        self.click('[data-ctl-clear]', 'Step 4: choose Clear next to Apply')
        self.page.wait_for_timeout(400)
        assert self.page.locator('#ctl-as-of').input_value() == ''
        self.row['task_state'] = {'replayed_cutoff': '2024-06-01', 'final_date': '', 'cleared': True}

    def replay(self, words, ready):
        url = self.page.url
        replay = self.context.new_page()
        replay.goto(url, wait_until='domcontentloaded')
        replay.locator(ready).first.wait_for()
        self.row['actions'].append({'article_action': words, 'before': route_path(url), 'after': route_path(replay.url), 'observed': 'Copied the address created by preceding actions; the new tab rendered the result.'})
        self.page.close()
        self.page = replay

    def calendar(self):
        self.step = 'Step 1: read Act by and Happening soon on Now'
        self.page.locator('main').wait_for()
        self.observe(self.step, lambda: self.page.locator('main').inner_text()[:2000])
        self.step = 'Step 1: open an event title to check its published record'
        link = self.page.locator('[data-now-lane="happening_soon"][data-now-item^="meetings:"] h3 a').first
        link.wait_for(state='visible')
        self.observe(self.step, lambda: link.click())
        self.page.wait_for_timeout(500)
        self.page.locator('[data-notice-id] .rolename').wait_for()
        self.row['event_title'] = self.page.locator('[data-notice-id] .rolename').inner_text()
        self.step = 'Step 2: open Meetings and select a meeting title'
        self.open_guide_link('main a[href*="/browse/meetings/"]')
        self.page.locator('a[href^="/meetings/"]').first.wait_for()
        self.observe(self.step, lambda: self.page.locator('a[href^="/meetings/"]').first.click())
        self.page.get_by_role('heading', level=1).wait_for()
        self.step = 'Step 2: choose Add to calendar when the record has a clock time'
        add = self.page.locator('a[href^="/meeting.ics"]')
        if add.count() and add.is_visible():
            with self.page.expect_download() as download:
                self.click('a[href^="/meeting.ics"]', self.step)
            raw = Path(download.value.path()).read_bytes()
            assert b'BEGIN:VCALENDAR' in raw and b'DTSTART' in raw
            unfolded = raw.decode().replace('\r\n ', '')
            title = self.page.get_by_role('heading', level=1).inner_text()
            assert f'SUMMARY:{title}' in unfolded
            self.row['single_event'] = {'sha256': digest(raw), 'content': raw.decode(), 'calendar_app_import': 'not exercised'}
        else:
            self.row['single_event'] = {'observed': 'Add to calendar absent on this record; following the article, no time was invented.'}
        self.step = 'Step 3: open Meetings'
        self.open_guide_link('main a[href*="/browse/meetings/"]')
        self.observe('Step 3: use Search meetings to select housing', lambda: self.page.locator('#meetingskw').fill('housing'))
        self.click('#meetings-more-filters > summary', 'Step 3: open More filters')
        self.capture('Search and expanded date/area filters on Meetings.')
        self.click('#meetings-more-filters > summary', 'Step 3: if the filter panel covers the toolbar, close More filters')
        self.step = 'Step 3: choose Subscribe to calendar, widening the search if no dated items appear'
        control = self.page.locator('#meetings-toolbar [data-calendar-subscription="scope"]')
        if not control.is_visible():
            self.page.locator('#meetingskw').fill('')
        self.click('#meetings-toolbar [data-calendar-subscription="scope"]', self.step)
        self.page.locator('[data-calendar-subscription-dialog][open]').wait_for()
        self.capture('The subscription panel names the selected dated list.')
        self.step = 'Step 4: choose Copy subscription URL'
        button = self.page.locator('[data-calendar-subscription-copy]')
        expected = button.get_attribute('data-copy-url')
        self.click('[data-calendar-subscription-copy]', self.step)
        copied = self.page.evaluate('navigator.clipboard.readText()')
        assert copied == expected
        self.row['task_state'] = {'subscription_url': expected, 'panel': self.page.locator('[data-calendar-subscription-dialog][open]').inner_text(),
                                 'clipboard_matches': True, 'calendar_app_subscription': 'external handoff; CityScroll cannot confirm it was added or refreshed'}

    def open_guide_link(self, selector):
        link = self.guide.locator(selector).first
        link.scroll_into_view_if_needed()
        self.guide_position = self.guide.evaluate('window.scrollY')
        with self.context.expect_page() as popup:
            link.click(button='middle')
        self.page.close()
        self.page = popup.value
        self.page.wait_for_load_state('domcontentloaded')
        self.row['actions'].append({'article_action': self.step, 'guide_link_words': link.inner_text(), 'after': route_path(self.page.url), 'observed': 'Opened the article link in a new tab.'})

    def collection(self):
        self.click('[data-pin]', 'Step 1: choose Pin among the notice actions')
        self.step = 'Step 1: open the named organization'
        self.open_guide_link('main a[href*="/vendors/"]')
        self.click('[data-pin]', 'Step 1: open the named organization and choose Pin')
        self.step = 'Step 2: open My investigation in the footer'
        self.click('footer a[data-i18n="footer_investigation"]', 'Step 2: open My investigation in the footer')
        self.page.locator('#invitems .invnote').first.wait_for()
        assert self.page.locator('#invitems .invnote').count() == 2
        note = 'Check the published source before using this award.'
        self.observe('Step 2: type a note and click outside the field', lambda: self.page.locator('#invitems .invnote').first.fill(note))
        self.observe('Step 2: click outside the note field', lambda: self.page.locator('#invname').click())
        self.page.reload(wait_until='domcontentloaded')
        self.page.locator('#invitems .invnote').first.wait_for()
        assert self.page.locator('#invitems .invnote').first.input_value() == note
        exports = []
        for selector in ('#invcsv', '#invjson'):
            with self.page.expect_download() as downloaded:
                self.click(selector, 'Step 3: export a copy and check records, notes and links')
            raw = Path(downloaded.value.path()).read_bytes()
            assert note.encode() in raw and b'20231222103' in raw
            exports.append({'filename': downloaded.value.suggested_filename, 'sha256': digest(raw), 'contains_note_and_notice': True})
        self.capture('Two click-created pins, persisted note, and CSV/JSON exports.')
        self.click('#invshare', 'Step 4: read notes and choose Share read-only link')
        link = self.page.locator('#invmsg a')
        link.wait_for()
        with self.context.expect_page() as popup:
            link.click(button='middle')
        self.page.close()
        self.page = popup.value
        self.page.locator('.timeline').wait_for()
        assert note in self.page.locator('main').inner_text()
        assert self.page.locator('.invnote').count() == 0
        self.row['task_state'] = {'pins': 2, 'note_persisted': True, 'exports': exports, 'shared_copy': 'mocked upload and retrieval; read-only rendering checked'}

    def official(self, selector, words):
        self.step = words
        link = self.page.locator(selector).first
        href = link.get_attribute('href')
        with self.context.expect_page() as popup:
            link.click(button='middle')
        source = popup.value
        try:
            source.wait_for_load_state('domcontentloaded', timeout=30000)
            source.wait_for_timeout(1500)
            text = source.locator('body').inner_text(timeout=15000)
            result = {'url': source.url, 'title': source.title(), 'content_sha256': digest(text.encode()), 'excerpt': text[:600]}
            self.row.setdefault('official_observations', []).append(result)
            (OUT / (self.row['id'] + '-official.html')).write_text(source.content())
            assert len(text) > 100, 'Official source did not provide readable content'
        finally:
            source.close()
        self.row['actions'].append({'article_action': words, 'before': route_path(self.page.url), 'official_source': href, 'observed': result, 'after': route_path(self.page.url)})

    def evidence(self):
        self.click('a[data-edge-claim="rules:notice:20260521021"]', 'Step 1: choose details beside Update to Parks List of Qualifying Documents for Disability Membership Fee')
        panel = self.page.locator('.edge-prov-inspector[open]')
        panel.wait_for()
        text = panel.inner_text()
        assert 'issued rule' in text
        self.observe('Step 2: read the match label, date and How this connection was made', lambda: text)
        self.official('.edge-prov-inspector[open] a[href*="a856-cityrecord"]', 'Step 2: open City Record notice, compare the official source, then return')
        self.capture('Connection evidence selected through details beside the record.')
        self.click('[data-edge-claim-share]', 'Step 3: choose Copy link to this connection')
        self.page.wait_for_load_state('domcontentloaded')
        self.replay('Step 3: copy the full browser address and paste it into a new tab', '.edge-prov-inspector[open]')
        assert self.page.locator('.edge-prov-inspector[open]').inner_text() == text
        self.row['task_state'] = {'expanded_claim': 'rules:notice:20260521021', 'evidence_reopened': True}

    def housing(self):
        self.observe('Step 1: type housing in the front page search box', lambda: self.page.locator('#home-topic-query').fill('housing'))
        self.click('.home-topic-form button', 'Step 1: press Search')
        self.page.locator('[data-semantic-family="people-organizations"] h4 a').first.wait_for()
        self.observe('Step 2: select Housing Preservation and Development in People + organizations', lambda: self.page.locator('[data-semantic-family="people-organizations"] a[href="/agencies/housing-preservation-and-development/"]').first.click())
        self.page.locator('main h1').wait_for()
        assert 'Housing Preservation' in self.page.locator('main h1').inner_text()
        self.capture('Agency reached from the typed housing search.')
        self.observe('Step 3: use browser Back to return to the housing search', lambda: self.page.go_back(wait_until='domcontentloaded') and None)
        self.page.locator('[data-semantic-family="rules"] a').filter(has_text='Official source').first.wait_for()
        self.observe('Step 3: read a rule match explanation and stage', lambda: self.page.locator('[data-semantic-family="rules"]').inner_text()[:3000])
        self.official('[data-semantic-family="rules"] a[href^="https:"]', 'Step 4: open Official source beside a passage and compare the published copy, then return')
        self.replay('Step 5: copy the browser address and paste it into a new tab', '[data-semantic-family="people-organizations"]')
        assert parse_qs(urlsplit(self.page.url).query).get('q') == ['housing']
        self.row['task_state'] = {'query': 'housing', 'agency_opened': 'Housing Preservation and Development', 'groups_compared': ['People + organizations', 'Rules'], 'replayed': True}
        self.observe('Step 5: repeat with a street or agency; search for parks', lambda: self.page.locator('#search-query').fill('parks'))
        self.page.locator('[data-search-form] button').click()
        self.page.locator('[data-semantic-family="people-organizations"] h4 a').first.wait_for()
        self.page.locator('[data-semantic-family="rules"] a').filter(has_text='Official source').first.wait_for()
        self.observe('Step 5: compare two groups again', lambda: {'people': self.page.locator('[data-semantic-family="people-organizations"]').inner_text()[:1000], 'rules': self.page.locator('[data-semantic-family="rules"]').inner_text()[:1000]})
        self.official('[data-semantic-family="rules"] a[href^="https:"]', 'Step 5: check one official copy for the repeated search')
        self.row['task_state']['repeat_query'] = 'parks'

    def duty(self):
        self.page.locator('[data-connected-mandate]').wait_for()
        self.observe('Step 1: check the Sanitation final rule title', lambda: self.page.locator('[data-notice-id] .rolename').inner_text())
        self.official('[data-notice-id] a[href*="a856-cityrecord"]', 'Step 1: open Official record and compare the published copy, then return')
        self.observe('Step 2: read Rules filing for this duty and Charter 753(e)(2)', lambda: self.page.locator('[data-connected-mandate]').inner_text())
        self.observe('Step 2: select the duty text about regulating commercial waste businesses', lambda: self.page.locator('[data-connected-mandate] a[href^="/mandates/"]').first.click())
        self.page.locator('[data-civic-object-kind="mandate"]').wait_for()
        self.official('.node-source-link', 'Step 3: open Source law, compare citation and required action, then return')
        self.observe('Step 4: find request 20260605008 under Publication evidence', lambda: self.page.locator('[data-mandate-inverse-links]').inner_text())
        assert self.page.locator('[data-mandate-inverse-links] a[href*="20260605008"]').count() == 1
        self.row['task_state'] = {'notice': '20260605008', 'duty': '64116-001', 'publication_evidence_returns_to_notice': True}
        self.capture('The notice-to-duty journey returns to its original publication evidence.')
        self.open_guide_link('main a[href*="/browse/rules/"]')
        link = self.page.locator('a[href^="/notices/"], a[href^="#notice/"]').filter(visible=True).first
        link.wait_for()
        self.observe('Step 5: open another rule notice from Rules', lambda: link.click())
        self.page.locator('[data-notice-id] .rolename').wait_for()
        self.page.locator('[data-notice-context-settled="true"]').wait_for(state='attached')
        connection = self.page.locator('[data-connected-mandate] a[href^="/mandates/"]')
        if connection.count():
            self.observe('Step 5: follow Connected mandate and its duty text', lambda: connection.first.click())
            self.official('.node-source-link', 'Step 5: open Source law for the other notice')
            self.row['task_state']['repeat'] = 'Another rule notice linked to its duty and source law.'
        else:
            self.official('[data-notice-id] a[href*="a856-cityrecord"]', 'Step 5: if Connected mandate is absent, check the notice official copy')
            self.row['task_state']['repeat'] = 'No supported duty connection on the second notice; its official copy was checked as instructed.'

    def award(self):
        self.step = 'Step 1: find Lantern Community Services under Connected records'
        vendor = self.page.locator('a[data-pivot-schema][href="/vendors/LANTERN%20COMMUNITY%20SERVICES/"]').first
        vendor.wait_for()
        self.observe('Step 2: select the organization title', lambda: vendor.click())
        self.page.locator('.traversal-path[data-traversal-hop-count="1"]').wait_for()
        self.observe('Step 2: check the trail names Homeless Services and the vendor', lambda: self.page.locator('.traversal-path').inner_text())
        self.page.locator('#vendor-on-the-record').wait_for()
        disclosure = self.page.locator('#vendor-on-the-record details > summary').filter(has_text='Show all dates')
        if disclosure.count():
            self.observe('Step 3: open Show all dates under On the record', lambda: disclosure.first.click())
        self.observe('Step 3: select Integrated Commercial Hotels Program, request 20260729015', lambda: self.page.locator('#vendor-on-the-record a[data-pivot-target-kind="notice"][href="#notice/20260729015"]').filter(visible=True).first.click())
        self.page.locator('.traversal-path[data-traversal-hop-count="2"]').wait_for()
        self.page.locator('[data-notice-id] .rolename').wait_for()
        self.capture('Two-hop trail created by clicking the agency, vendor and award.')
        self.replay('Step 4: copy the full browser address and paste it into a new tab', '.traversal-path[data-traversal-hop-count="2"]')
        self.row['task_state'] = {'hops': 2, 'final_award': '20260729015', 'trail': self.page.locator('.traversal-path').inner_text(), 'replayed': True}
        self.capture('The copied award address restores both clicked hops.')
        self.row['task_state']['repeat_scope'] = 'The named tutorial chain is checked here; the independent Volunteers of America chain is recorded in the merged award-trail evidence.'

    def finish(self):
        self.row['product_language'] = self.page.locator('html').get_attribute('lang')
        assert self.row['product_language'] == self.locale, self.row['product_language']
        self.capture('Task result and selected language at the end of the documented actions.')
        self.page.close()
        self.guide.bring_to_front()
        position = self.guide.evaluate('window.scrollY')
        self.row['guide_return'] = {'route': route_path(self.guide.url), 'locale': self.guide.locator('html').get_attribute('lang'),
                                    'scroll_before': self.guide_position, 'scroll_after': position}
        assert abs(position - self.guide_position) < 3
        assert self.row['guide_return']['locale'] == self.locale
        self.row['outcome'] = 'passed'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only', default=','.join(ARTICLES))
    parser.add_argument('--locales', default='en,es,zh-Hans,ar')
    parser.add_argument('--widths', default='390,1440')
    parser.add_argument('--manifest', type=Path, default=MANIFEST)
    parser.add_argument('--resume', action='store_true', help='Retain completed scenarios only when candidate product source hashes match.')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    server, thread, base = serve(ROOT / '.artifacts/guide-preview')
    manifest = {'schema_version': 1, 'record': 'ccf422a8ff4de', 'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                'captured_at': datetime.now(timezone.utc).isoformat(), 'journeys': []}
    changed = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, text=True).splitlines()
    manifest['candidate_source_sha256'] = {name: digest((ROOT / name).read_bytes()) for name in changed if name.startswith(('site/', 'tools/', 'test/')) and (ROOT / name).is_file()}
    manifest['runner_sha256'] = digest(Path(__file__).read_bytes())
    manifest['capture_mode'] = 'Local candidate with retained civic records, public GET observations, disposable browser state and intercepted account writes.'
    manifest['retained_inputs'] = []
    snapshot_path = ROOT / '.artifacts/award-trail/public-read-snapshot.json'
    snapshot = json.loads(snapshot_path.read_text())
    manifest['retained_public_awards'] = {'sha256': digest(snapshot_path.read_bytes()), 'data_vintage': snapshot['captured_at'], 'observations': snapshot['observations']}
    for kind in ('keyword', 'candidates'):
        raw = (ROOT / '.artifacts/guide-illustrations' / (kind + '.json')).read_bytes()
        manifest['retained_inputs'].append({'source': 'https://api.cityscroll.org/search' + ('/candidates' if kind == 'candidates' else '') + '?q=housing', 'sha256': digest(raw), 'data_vintage': json.loads(raw).get('generated', 'not declared')})
    for kind in ('keyword', 'candidates'):
        raw = (OUT / ('parks-' + kind + '.json')).read_bytes()
        manifest['retained_inputs'].append({'source': 'https://api.cityscroll.org/search' + ('/candidates' if kind == 'candidates' else '') + '?q=parks', 'sha256': digest(raw), 'data_vintage': json.loads(raw).get('generated', 'not declared')})
    for name in ('entity_intelligence_lookup', 'shared_meeting_read_model', 'notice_context_lookup', 'notice_mandate_backlinks_lookup', 'agency_obligations_lookup'):
        path = ROOT / 'site/data' / (name + '.json')
        raw = path.read_bytes()
        data = json.loads(raw)
        manifest['retained_inputs'].append({'path': str(path.relative_to(ROOT)), 'sha256': digest(raw), 'data_vintage': data.get('generated_at') or data.get('source_generated_at') or data.get('generated') or 'not declared'})
    if args.resume and args.manifest.exists():
        previous = json.loads(args.manifest.read_text())
        product = lambda receipt: {key: value for key, value in receipt['candidate_source_sha256'].items() if key.startswith('site/')}
        assert previous['revision'] == manifest['revision'] and product(previous) == product(manifest), 'Candidate product changed; start a fresh capture.'
        manifest['journeys'] = [row for row in previous['journeys'] if row['outcome'] == 'passed']
        for row in manifest['journeys']:
            row.setdefault('runner_sha256', previous['runner_sha256'])
        manifest['continued_from'] = previous['captured_at']
    completed = {row['id'] for row in manifest['journeys']}
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for name in args.only.split(','):
                for locale in args.locales.split(','):
                    if locale != 'en' and name not in ('board', 'calendar', 'asof', 'collection'):
                        continue
                    for width in map(int, args.widths.split(',')):
                        if f'{name}-{locale}-{width}' in completed:
                            continue
                        run = Journey(browser, base, name, locale, width)
                        run.row['runner_sha256'] = manifest['runner_sha256']
                        try:
                            run.open()
                            getattr(run, name)()
                            run.finish()
                        except Exception as error:
                            run.row.update(outcome='failed', guide_route=route_path(run.guide.url), failing_action=run.step, error=str(error).replace(base.rstrip('/'), ''))
                            if run.page and not run.page.is_closed():
                                run.capture('Observed failure; does not establish task completion.')
                                (OUT / (run.row['id'] + '.html')).write_text(run.page.content())
                            print(run.row['id'], 'FAILED', run.row['error'], flush=True)
                        finally:
                            manifest['journeys'].append(run.row)
                            run.context.close()
                            args.manifest.parent.mkdir(parents=True, exist_ok=True)
                            args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
                        if run.row['outcome'] != 'passed':
                            return 1
            if 'asof' in args.only.split(','):
                manifest['regressions'] = []
                for width in map(int, args.widths.split(',')):
                    run = Journey(browser, base, 'asof', 'en', width)
                    run.row['id'] = f'asof-default-{width}'
                    run.page = run.context.new_page()
                    try:
                        run.page.goto(base + 'agencies/parks-and-recreation/', wait_until='domcontentloaded')
                        run.page.locator('#ctl-as-of').fill('2024-06-01')
                        run.page.locator('[data-ctl-form] button').click()
                        run.page.wait_for_url('**as_of=2024-06-01*')
                        assert 'lang' not in parse_qs(urlsplit(run.page.url).query)
                        run.replay('Copy and reopen the date URL without a language parameter', '[data-ctl-clear]')
                        assert run.page.locator('#ctl-as-of').input_value() == '2024-06-01'
                        run.page.locator('[data-ctl-clear]').click()
                        assert run.page.locator('#ctl-as-of').input_value() == ''
                        assert 'lang' not in parse_qs(urlsplit(run.page.url).query)
                        assert run.page.locator('html').get_attribute('lang') == 'en'
                        run.capture('Apply, replay and Clear preserve the no-language default.')
                        run.row['outcome'] = 'passed'
                    finally:
                        manifest['regressions'].append(run.row)
                        run.context.close()
            browser.close()
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest['captures'] = [capture for row in manifest['journeys'] + manifest.get('regressions', []) for capture in row['captures']]
        args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return int(any(row['outcome'] != 'passed' for row in manifest['journeys']))


if __name__ == '__main__':
    raise SystemExit(main())
