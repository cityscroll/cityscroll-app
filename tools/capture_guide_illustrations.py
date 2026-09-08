#!/usr/bin/env python3
"""Capture real guide UI crops and public per-article receipts.

Prepare with build_primary_documents.mjs, build_agency_constellation_documents.mjs,
build_community_board_constellation_documents.mjs and prepare_guide_preview.mjs.
Requires the same Python Playwright/Chromium setup as capture_guide_release.py.
Search can replay public responses retained with curl under --replay-dir; responses
are never committed. Following uses the production renderer with disposable state.
No email, account mutation or shared investigation reaches a public service.
Numbered annotation rails are added OUTSIDE the unmodified rendered UI crop.

For a full pass, retain the public housing reads before launching Chromium:
  mkdir -p .artifacts/guide-illustrations
  curl --fail --silent --show-error 'https://api.cityscroll.org/search/candidates?q=housing' -o .artifacts/guide-illustrations/candidates.json
  curl --fail --silent --show-error 'https://api.cityscroll.org/search?q=housing' -o .artifacts/guide-illustrations/keyword.json
  python3 tools/capture_award_trail.py --acquire
  python3 tools/capture_guide_illustrations.py
  node tools/build_guide_documents.mjs

The retained reads remain ignored. Run captures before document verification:
the article builder checks dimensions and digests against the completed receipts.
Use --only following,calendar,connection,asof to capture just those controls.
"""
from __future__ import annotations
import argparse, base64, hashlib, json, math, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
from capture_guide_release import serve

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'site/media/guide'
SCRATCH = ROOT / '.artifacts/guide-illustrations'
VIEWPORTS = [('mobile',390,844),('desktop',1440,900)]
REVISION = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
RECEIPTS = {}
LOCALE = "en"


def node(script, *args):
    return subprocess.check_output(['node','--input-type=module','-e',script,*args],cwd=ROOT,text=True)


def following_html(url, base):
    query=urlsplit(url).query
    script='''import {buildFollowingViewModel,renderFollowingDocument,watchFromFollowingParams} from './site/following_view.mjs';
const parsed=watchFromFollowingParams(new URLSearchParams(process.argv[1]));
const view=buildFollowingViewModel({...parsed,matchCount: parsed.requested ? 0 : null,previewItems:[]});
process.stdout.write(renderFollowingDocument(view,{siteBase:process.argv[2]}));'''
    return node(script,query,base.rstrip('/')).replace('https://cityscroll.org/following',base.rstrip('/')+'/following')


def install_routes(page, base, replay_dir):
    # Disposable browser context: no real subscriber identity or state is loaded.
    def traffic(route):
        req=route.request
        path=urlsplit(req.url).path
        if req.method not in ['GET','HEAD']:
            if path=='/subscribe':
                route.fulfill(status=200,content_type='application/json',body='{"ok":true}')
            else:
                route.fulfill(status=202,content_type='application/json',body='{"ok":true}')
            return
        if path.startswith('/following/personal'):
            route.fulfill(status=200,content_type='text/html',body='<div data-personal-state="unrecognized"></div>')
        elif path.rstrip('/')=='/following':
            route.fulfill(status=200,content_type='text/html',body=following_html(req.url,base))
        elif path in ['/search','/search/candidates'] and urlsplit(req.url).hostname in ['api.cityscroll.org','cityscroll-worker.crol-worker.workers.dev']:
            filename='candidates.json' if path.endswith('candidates') else 'keyword.json'
            data=(replay_dir/filename).read_text()
            route.fulfill(status=200,content_type='application/json',body=data,headers={'Access-Control-Allow-Origin':'*'})
        else:
            route.continue_()
    page.route('**/*',traffic)


def go(page,base,route,ready=None):
    if LOCALE != 'en': route += ('&' if '?' in route else '?') + 'lang=' + LOCALE
    page.goto(base.rstrip('/')+route,wait_until='domcontentloaded')
    if LOCALE != 'en': page.wait_for_function('(language) => document.documentElement.lang === language && window.LANG === language', arg=LOCALE)
    if ready: page.locator(ready).first.wait_for(state='visible',timeout=30000)
    page.wait_for_timeout(500)


def crop(page,slug,name,region,marks,caption,alt,variant, *, height=None, provenance='Retained public site data', redactions=None):
    if LOCALE != 'en':
        page.wait_for_function('(language) => document.documentElement.lang === language && window.LANG === language',arg=LOCALE)
    regions=region if isinstance(region,list) else [region]
    page.locator(regions[0]).first.scroll_into_view_if_needed()
    page.evaluate('document.fonts.ready')
    page.wait_for_timeout(150)
    scroll=page.evaluate('({x:scrollX,y:scrollY})')
    boxes=[page.locator(sel).first.bounding_box() for sel in regions]
    assert all(boxes),(name,regions)
    x=max(0,math.floor(min(b['x'] for b in boxes)-8))
    y=max(0,math.floor(min(b['y']+scroll['y'] for b in boxes)-8))
    right=min(page.viewport_size['width'],math.ceil(max(b['x']+b['width'] for b in boxes)+8))
    bottom=math.ceil(max(b['y']+scroll['y']+b['height'] for b in boxes)+8)
    if height: bottom=min(bottom,y+height)
    clip={'x':x,'y':y,'width':right-x,'height':bottom-y}
    assert clip['height']<=1800,(name,clip)
    positions=[]
    for number,sel in enumerate(marks,1):
        target=page.locator(sel).first
        assert target.is_visible(),(name,sel)
        b=target.bounding_box()
        positions.append({'number':number,'selector':sel,'label':target.inner_text()[:180] or target.get_attribute('aria-label') or target.get_attribute('name'),
                          'y':round(b['y']+scroll['y']+b['height']/2-y)})
    for p in positions: assert 0<=p['y']<=clip['height'],(name,p,clip)
    clip['x'] += page.evaluate('document.dir === \"rtl\" ? Math.max(0, document.documentElement.scrollWidth - innerWidth) : 0')
    raw=page.screenshot(clip=clip,animations='disabled',full_page=True)
    # Canvas only adds a numbered margin. It never replaces, scales or draws over UI pixels.
    annotate=page.context.new_page()
    data=annotate.evaluate('''async ({png,positions})=>{
      const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.width+32;canvas.height=image.height;
      const c=canvas.getContext('2d');c.fillStyle='#f8f6f1';c.fillRect(0,0,canvas.width,canvas.height);
      c.drawImage(image,32,0);let last=-40;
      for(const p of [...positions].sort((a,b)=>a.y-b.y)){const y=Math.max(14,Math.min(image.height-14,Math.max(p.y,last+28)));last=y;
        c.fillStyle='#772f32';c.beginPath();c.arc(16,y,11,0,Math.PI*2);c.fill();
        c.fillStyle='#fff';c.font='bold 13px sans-serif';c.textAlign='center';c.textBaseline='middle';c.fillText(p.number,16,y);
      }
      return {data:canvas.toDataURL('image/png').split(',')[1],width:canvas.width,height:canvas.height};
    }''',{'png':base64.b64encode(raw).decode(),'positions':positions})
    annotate.close()
    folder=OUT/slug if LOCALE == 'en' else OUT/slug/LOCALE
    folder.mkdir(parents=True,exist_ok=True)
    file=folder/f'{name}-{variant}.png';file.write_bytes(base64.b64decode(data['data']))
    receipt=RECEIPTS.setdefault(slug,{'schema':'cityscroll.guide-captures.v1','figures':{}})
    figure=receipt['figures'].setdefault(name,{'locale':LOCALE,'caption':caption,'alt':alt})
    url=urlsplit(page.url)
    figure[variant]={'src':'/'+str(file.relative_to(ROOT/'site')),'width':data['width'],'height':data['height'],
        'captured_at':datetime.now(timezone.utc).isoformat(),'revision':REVISION,'viewport':page.viewport_size,
        'route':url.path+('?' + url.query if url.query else '')+('#'+url.fragment if url.fragment else ''),
        'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'redactions':redactions or [],
        'data_vintage':provenance,'callouts':positions,'crop':clip,
        'source_html_sha256':hashlib.sha256(page.content().encode()).hexdigest()}
    print(f'captured {slug}/{name}-{variant} ({data["width"]}x{data["height"]})',flush=True)


def following(page,base,variant):
    board='follow-a-community-board';watch='follow-a-search'
    go(page,base,'/following/','[data-following-primary-start]')
    crop(page,watch,'choose-scope','[data-following-primary-start]',
         ['[data-following-primary-choice="topic"]','[data-following-primary-choice="place"]'],
         '1. Choose a topic. 2. Choose a borough or Any place. These choices have not saved a watch.',
         'Following topic buttons above the borough choices.',variant)
    page.locator('[data-following-primary-choice="topic"] [data-i18n="quiz_meetings"]').click()
    if page.locator('.following-refinements').get_attribute('open') is None:
        page.locator('.following-refinements > summary').click()
    crop(page,board,'board-topic',['[data-following-primary-choice="topic"]','.following-refinements > summary'],
         ['[data-following-primary-choice="topic"]','.following-refinements > summary'],
         '1. Hearings and meetings is selected. 2. Open Narrow it down below the place choices.',
         'The selected Hearings and meetings topic and the Narrow it down disclosure in Following.',variant)
    page.locator('select[name="boardBorough"]').select_option(label='Manhattan')
    page.locator('select[name="boardNumber"]').select_option(label='7')
    crop(page,board,'board-picker','[data-following-community-board-field]',
         ['.following-community-board-picker'],
         '1. In Community Board, choose Manhattan in Borough and 7 in Board number.',
         'Community Board picker with Borough set to Manhattan and Board number set to 7.',variant)
    page.locator('[data-following-primary-choice="preview"]').click()
    page.locator('[data-i18n="following_watch_summary"]').wait_for()
    crop(page,board,'board-preview','[data-following-watch-identity]',
         ['[data-following-identity-rule]'],
         '1. Watch summary must identify Manhattan Community Board 7 before saving.',
         'The watch summary identifies Manhattan Community Board 7 in a disposable preview.',variant,
         provenance='Disposable empty-preview fixture rendered by following_view.mjs; no watch created')
    crop(page,board,'board-criteria','[data-following-scope-panel]',
         ['.following-scope-chips'],
         '1. Watch criteria also names Manhattan Community Board 7. Zero matches means this loaded preview is empty.',
         'Watch criteria names the topic and Manhattan Community Board 7.',variant,
         provenance='Disposable empty-preview fixture rendered by following_view.mjs; no watch created')
    crop(page,watch,'create-watch','[data-following-subscribe-form]',
         ['[data-following-subscribe-form] input[type="email"]','[data-following-subscribe-submit]'],
         '1. Enter Email address only when ready. 2. Create watch starts email updates when the request succeeds.',
         'Create this watch form with an empty Email address and Create watch button.',variant,
         provenance='Disposable signed-out Following preview')
    page.locator('[data-following-subscribe-form] input[type="email"]').fill('reader@example.invalid')
    page.locator('[data-following-subscribe-submit]').click()
    page.wait_for_function('document.querySelector("[data-following-submit-status]").textContent === window.t("following_subscribed")')
    crop(page,board,'watch-confirmation','[data-following-subscribe-form]',
         ['[data-following-submit-status]'],
         '1. This confirmation means the save succeeded. Keep the welcome email to manage or stop the watch.',
         'A disposable successful-save example showing the subscribed confirmation and an empty email field.',variant,
         provenance='Disposable successful subscription response; all outgoing writes intercepted; no email sent',
         redactions=['Disposable email cleared by the production success handler before capture'])


def calendar(page,base,variant):
    go(page,base,'/browse/meetings/','#meetings-toolbar')
    crop(page,'put-dates-in-your-calendar','calendar-toolbar','#meetings-toolbar',
         ['#meetings-toolbar [data-calendar-subscription="scope"]'],
         '1. Subscribe to calendar sits in the list toolbar above the meeting records.',
         'Meetings list toolbar, including the Subscribe to calendar control.',variant)
    page.locator('#meetings-toolbar [data-calendar-subscription="scope"]').first.click()
    dialog='[data-calendar-subscription-dialog][open]'
    page.locator(dialog).wait_for()
    crop(page,'put-dates-in-your-calendar','calendar-options',dialog,
         [dialog+' a[href^="webcal:"]',dialog+' [data-calendar-subscription-copy]'],
         '1. Open calendar subscription opens your calendar app. 2. Copy subscription URL is for apps that ask for a web address.',
         'Calendar subscription panel naming Meetings and showing the open and copy options.',variant)
    page.locator('[data-calendar-subscription-close]').click()
    page.locator('#meetings-more-filters > summary').click()
    bounds=page.locator('#meetings-more-filters .utility-overflow-content').bounding_box()
    assert bounds['x']>=0 and bounds['x']+bounds['width']<=page.viewport_size['width'], 'Meeting filters must stay inside the viewport'
    crop(page,'find-and-narrow-records','meeting-filters',['#meetings-toolbar','#meetings-more-filters .utility-overflow-content'],
         ['#meetingskw','#meetings-toolbar details'],
         '1. Search filters the meeting list. 2. More filters reveals Date window, Affected area and Agency.',
         'Meeting list filters expanded above the results.',variant)


def connection(page,base,variant):
    go(page,base,'/agencies/parks-and-recreation/','[data-civic-time-ledger]')
    selector='a[data-edge-claim="rules:notice:20260521021"]'
    page.locator(selector).wait_for(timeout=30000)
    region=page.locator(selector).evaluate("e=>{const p=e.closest('li');p.dataset.guideCrop='connection';return '[data-guide-crop=connection]'}")
    crop(page,'check-the-evidence-behind-a-connection','connection-trigger',region,[selector],
         '1. Choose Details beside this record title under Connected records.',
         'Parks rule record with its Details link beside the title.',variant)
    page.locator(selector).click()
    panel='.edge-prov-inspector[open]'
    crop(page,'check-the-evidence-behind-a-connection','connection-panel',panel,
         [panel+' summary','[data-edge-claim-share="rules:notice:20260521021"]'],
         '1. Read the selected record’s Connection evidence. 2. Copy link to this connection reopens this panel.',
         'Expanded Connection evidence with match basis, source and copy-link control.',variant)


def asof(page,base,variant):
    go(page,base,'/agencies/parks-and-recreation/','[data-civic-time-ledger]')
    page.locator('#ctl-as-of').fill('2024-06-01')
    crop(page,'look-at-records-as-of-a-day','date-field','[data-civic-time-ledger]',
         ['#ctl-as-of','[data-ctl-form] button'],
         '1. Set As of to 1 June 2024. 2. Apply filters the linked records by that day.',
         'As of day panel with date field filled and Apply beside it.',variant)
    page.locator('[data-ctl-form] button').click()
    page.wait_for_url('**as_of=2024-06-01*')
    page.wait_for_timeout(500)
    page.locator('[data-ctl-clear]').wait_for(state='visible')
    crop(page,'look-at-records-as-of-a-day','date-result','[data-civic-time-ledger]',
         ['[data-ctl-comparison]','[data-ctl-clear]'],
         '1. The summary describes the applied cutoff. 2. Clear removes it. Later records remain separate.',
         'Applied As of day summary and the Clear control.',variant)
    page.locator('[data-ctl-clear]').click()
    page.wait_for_timeout(600)
    assert page.locator('#ctl-as-of').input_value()==''


def investigation(page,base,variant):
    slug='collect-records-and-export-them'
    go(page,base,'/notices/20231222103','[data-pin]')
    page.locator('[data-pin]').first.evaluate("e=>e.closest('.actions').dataset.guideCrop='pin-actions'")
    region='[data-guide-crop="pin-actions"]'
    crop(page,slug,'pin-record',region,['[data-pin]'],
         '1. Pin is among the individual record’s actions, beside its print and export controls.',
         'The award notice action row, including Pin.',variant)
    page.locator('[data-pin]').first.click()
    crop(page,slug,'pin-confirmation',region,[region+' a[href="#investigation"]'],
         '1. The pinned confirmation gives the item count and opens your investigation.',
         'Pinned confirmation link in the same record action row.',variant,
         provenance='Disposable browser collection; no account or remote save')
    go(page,base,'/vendors/HOUSING%20OPTIONS%20GERIATRIC%20ASSOCIATION%20RESOURCES/','[data-pin]')
    page.locator('[data-pin]').first.click()
    page.locator('a[href="#investigation"]').first.click()
    page.locator('#invitems .invnote').first.wait_for()
    assert page.locator('#invitems .invnote').count()==2
    page.locator('#invitems .invnote').first.fill('Check the published source before using this award.')
    page.locator('#invcsv').click()
    crop(page,slug,'notes-and-exports',['#invitems','#invcsv','#invjson','#invshare'],
         ['#invcsv','#invitems .invnote'],
         '1. Export .csv or Export .json saves a fixed copy. 2. Add a note under a pinned record. Click outside it to save.',
         'Investigation workspace with file exports above a pinned award and a disposable example note.',variant,
         provenance='Disposable local collection and authored example note; no sharing request sent')
    page.reload(wait_until='domcontentloaded')
    page.locator('#invitems .invnote').first.wait_for()
    assert page.locator('#invitems .invnote').first.input_value()=='Check the published source before using this award.'


def housing(page,base,variant):
    slug='explore-housing-across-city-records'
    go(page,base,'/search/?q=housing','[data-semantic-family="people-organizations"] h4 a')
    target='a[href="/agencies/housing-preservation-and-development/"]'
    page.locator(target).first.evaluate("e=>e.closest('article').dataset.guideCrop='housing-result'")
    crop(page,slug,'agency-result',['#search-semantic-lane-people-organizations','[data-guide-crop="housing-result"]'],[target],
         '1. Select the agency title in People + organizations to open its connected records.',
         'Housing search results showing the Housing Preservation and Development agency entry.',variant,
         provenance='Retained public reads of /search and /search/candidates for housing; curl acquisition; source vintages in response')
    page.locator(target).first.click()
    page.locator('main h1').wait_for()
    crop(page,slug,'agency-arrival','.node-hero',['main h1'],
         '1. The destination heading confirms the agency. Its connected records are grouped below.',
         'Housing Preservation and Development agency heading after selecting the search result.',variant)
    page.go_back(wait_until='domcontentloaded')
    rule='[data-semantic-family="rules"] .topic-search-semantic-result'
    # The rendered result contract owns its markup; identify a passage by its source link.
    link=page.locator('[data-semantic-family="rules"] a').filter(has_text='Official source').first
    link.wait_for()
    link.evaluate("e=>e.closest('article').dataset.guideCrop='rule-passage'")
    crop(page,slug,'rule-source','[data-guide-crop="rule-passage"]',
         ['[data-guide-crop="rule-passage"] a[href^="https:"]'],
         '1. Official source beside a quoted passage opens the publisher’s copy. Check its title, agency and stage.',
         'A rule passage in the housing search with its Official source link.',variant,
         provenance='Retained public housing search response; passage text and source link unchanged')


def duty(page,base,variant):
    slug='trace-a-notice-to-the-duty-behind-it'
    go(page,base,'/notices/20260605008','[data-connected-mandate]')
    crop(page,slug,'connected-duty','[data-connected-mandate]',
         ['[data-connected-mandate] a[href^="/mandates/"]'],
         '1. Select the duty text under Connected mandate. The relation and Charter citation explain this link.',
         'Connected mandate in the Sanitation rule notice with its duty link, relation and Charter citation.',variant)
    page.locator('[data-connected-mandate] a[href^="/mandates/"]').first.click()
    page.locator('[data-civic-object-kind="mandate"]').wait_for()
    crop(page,slug,'duty-source','.mandate-facts',['.node-source-link'],
         '1. Source law opens the legislation behind the duty. Compare its citation and required action.',
         'Sanitation mandate heading, required action and Source law link.',variant)
    crop(page,slug,'publication-evidence','[data-mandate-inverse-links]',
         ['[data-mandate-inverse-links] a[href*="20260605008"]'],
         '1. Publication evidence links back to request 20260605008, the filing you started from.',
         'Publication evidence on the duty page includes the Sanitation notice request number.',variant)


def land(page,base,variant):
    slug='read-a-land-use-projects-next-step'
    go(page,base,'/browse/zoning/#land/2022M0258','#land-authority-summary')
    crop(page,slug,'project-stage','#land-authority-summary',
         ['#land-authority-summary'],
         '1. Read Current stage, Current actor and Role together, then Expected next stage and Published next opportunity.',
         'Where this stands for Timbale Terrace, including the current authority and next opportunity state.',variant)
    page.locator('.zap-docs-list').first.evaluate("e=>e.parentElement.dataset.guideCrop='project-documents'")
    crop(page,slug,'project-documents','[data-guide-crop="project-documents"]',
         ['[data-guide-crop="project-documents"] a'],
         '1. Decision documents lists published decisions. Use Open full ZAP project in this area for the full official record.',
         'Decision documents for Timbale Terrace with links to the published files.',variant)


def award(page,base,variant):
    from capture_award_trail import install_reads,state
    from urllib.parse import quote
    snapshot=json.loads((ROOT/'.artifacts/award-trail/public-read-snapshot.json').read_text())
    # This scenario is deliberately gated on the merged navigation repair.
    subprocess.run(['git','merge-base','--is-ancestor','6166a32a63545fd71af0cccbca5c2c6442d8892e','HEAD'],cwd=ROOT,check=True)
    page.unroute('**/*')
    install_reads(page.context,base,snapshot)
    slug='trace-an-award-and-keep-the-trail';stem='LANTERN COMMUNITY SERVICES'
    go(page,base,'/agencies/homeless-services/','[data-civic-object-kind="agency-constellation"]')
    selector=f'a[data-pivot-schema][href="/vendors/{quote(stem,safe="")}/"]'
    page.locator(selector).first.wait_for()
    page.locator(selector).first.evaluate("e=>e.closest('li').dataset.guideCrop='vendor-connection'")
    crop(page,slug,'vendor-connection','[data-guide-crop="vendor-connection"]',[selector],
         '1. Select Lantern Community Services under the agency’s Connected records to start a trail.',
         'Lantern Community Services vendor connection on the Homeless Services agency page.',variant)
    page.locator(selector).first.click()
    page.locator('.traversal-path[data-traversal-hop-count="1"]').wait_for()
    page.locator('#vendor-on-the-record').wait_for()
    crop(page,slug,'vendor-trail','.traversal-path',['.traversal-path'],
         '1. The first trail step names the agency and vendor. Check it before choosing an award.',
         'One-step trail from Homeless Services to Lantern Community Services.',variant,
         provenance='Retained public City Record vendor reads acquired by capture_award_trail.py')
    timeline=page.locator('#vendor-on-the-record')
    summary=timeline.locator('details > summary').filter(has_text='Show all dates')
    if summary.count(): summary.first.click()
    expected=next(row for row in snapshot['profiles'][stem]['recentNotices'] if row['agency_name']=='Homeless Services')
    selector=f'a[data-pivot-target-kind="notice"][href="#notice/{expected["request_id"]}"]:visible'
    link=timeline.locator(selector).first
    if not link.count():
        timeline.locator('details > summary').first.click()
        dates=timeline.locator('button[data-vendor-dates]:visible')
        if dates.count(): dates.first.click()
    link.wait_for()
    link.evaluate("e=>e.closest('li, .tl').dataset.guideCrop='award-connection'")
    crop(page,slug,'award-connection','[data-guide-crop="award-connection"]',[selector],
         '1. Under On the record, open Show all dates and select the award title to continue the trail.',
         'The Integrated Commercial Hotels Program award title in the vendor’s dated notice list.',variant,
         provenance='Retained public City Record award response; no prepared trail URL used')
    link.click();page.wait_for_url('**/notices/**')
    page.locator('.traversal-path[data-traversal-hop-count="2"]').wait_for()
    page.locator('[data-notice-id] .rolename').wait_for()
    assert len(state(page.url)['hops'])==2
    crop(page,slug,'award-trail',['.traversal-path','[data-notice-id] .rolename'],
         ['.traversal-path','[data-notice-id] .rolename'],
         '1. Both connections remain in the trail. 2. The award is the final record. Copy the full address to keep both steps.',
         'Two-step agency-to-vendor-to-award trail and the final award heading.',variant,
         provenance='Click-created trail after navigation repair; retained public City Record reads')
    copied=page.url
    page.reload(wait_until='domcontentloaded')
    page.locator('.traversal-path[data-traversal-hop-count="2"]').wait_for()
    assert len(state(page.url)['hops'])==2
    (SCRATCH/f'award-{variant}-url.txt').write_text(urlsplit(copied).path+'?'+urlsplit(copied).query)
    fresh=page.context.browser.new_context(viewport=page.viewport_size,locale=LOCALE)
    install_reads(fresh,base,snapshot)
    reopened=fresh.new_page()
    reopened.goto(copied,wait_until='domcontentloaded')
    reopened.locator('.traversal-path[data-traversal-hop-count="2"]').wait_for()
    reopened.locator('[data-notice-id] .rolename').wait_for()
    assert len(state(reopened.url)['hops'])==2
    fresh.close()
    for figure in RECEIPTS[slug]['figures'].values():
        figure[variant]['journey_checks']={'click_created_two_hops':True,'reload':True,'fresh_browser_context':True}
        figure[variant]['public_read_snapshot']={'captured_at':snapshot['captured_at'],
            'sha256':hashlib.sha256((ROOT/'.artifacts/award-trail/public-read-snapshot.json').read_bytes()).hexdigest()}


def main():
    global LOCALE
    parser=argparse.ArgumentParser()
    parser.add_argument('--only',default='following,calendar,connection,asof,investigation,housing,duty,land,award')
    parser.add_argument('--site-dir',type=Path,default=ROOT/'.artifacts/guide-preview')
    parser.add_argument('--replay-dir',type=Path,default=SCRATCH)
    parser.add_argument('--locale',default='en')
    args=parser.parse_args()
    locales=json.loads(node('import {loadGuideCatalog} from \'./tools/guide_translation_catalog.mjs\'; console.log(JSON.stringify([\'en\',...loadGuideCatalog().SHIPPING_LANGS]))'))
    if args.locale not in locales: parser.error('Unsupported shipping locale')
    LOCALE=args.locale
    SCRATCH.mkdir(parents=True,exist_ok=True)
    server,thread,base=serve(args.site_dir)
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            for task in args.only.split(','):
                for variant,width,height in VIEWPORTS:
                    context=browser.new_context(viewport={'width':width,'height':height},locale=LOCALE)
                    page=context.new_page();page.set_default_timeout(15000)
                    install_routes(page,base,args.replay_dir)
                    try: globals()[task](page,base,variant)
                    except Exception:
                        page.screenshot(path=str(SCRATCH/f'{task}-failure.png'))
                        (SCRATCH/f'{task}-failure.html').write_text(page.content())
                        raise
                    finally: context.close()
            browser.close()
    finally:
        for slug,receipt in RECEIPTS.items():
            folder=OUT/slug;path=folder/'receipt.json'
            old=json.loads(path.read_text()) if path.exists() else {'schema':'cityscroll.guide-captures.v1','figures':{}}
            for key,value in receipt['figures'].items():
                if LOCALE == 'en': old['figures'][key]={**old['figures'].get(key,{}),**value}
                else: old['figures'][key].setdefault('locales',{})[LOCALE]=value
            path.write_text(json.dumps(old,indent=2)+'\n')
        server.shutdown();server.server_close();thread.join(5)

if __name__=='__main__': main()
