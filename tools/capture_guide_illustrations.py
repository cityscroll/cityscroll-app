#!/usr/bin/env python3
"""Capture real guide UI crops and public per-article receipts.

Prepare with build_primary_documents.mjs, build_agency_constellation_documents.mjs,
build_community_board_constellation_documents.mjs and prepare_guide_preview.mjs.
Requires the same Python Playwright/Chromium setup as capture_guide_release.py.
Search can replay public responses retained with curl under --replay-dir; responses
are never committed. Following uses the production renderer with disposable state.
No email, account mutation or shared investigation reaches a public service.
Numbered annotation rails are added OUTSIDE the unmodified rendered UI crop.

python3 tools/capture_guide_illustrations.py --only following,calendar,connection,asof
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
    page.goto(base.rstrip('/')+route,wait_until='domcontentloaded')
    if ready: page.locator(ready).first.wait_for(state='visible',timeout=30000)
    page.wait_for_timeout(500)


def crop(page,slug,name,region,marks,caption,alt,variant, *, height=None, provenance='Retained public site data', redactions=None):
    regions=region if isinstance(region,list) else [region]
    page.locator(regions[0]).first.scroll_into_view_if_needed()
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
    raw=page.screenshot(clip=clip,animations='disabled',full_page=True)
    # Canvas only adds a numbered margin. It never replaces, scales or draws over UI pixels.
    annotate=page.context.new_page()
    data=annotate.evaluate('''async ({png,positions})=>{
      const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.width+32;canvas.height=image.height;
      const c=canvas.getContext('2d');c.fillStyle='#f8f6f1';c.fillRect(0,0,canvas.width,canvas.height);
      c.drawImage(image,32,0);let last=-40;
      for(const p of positions){const y=Math.max(14,Math.min(image.height-14,Math.max(p.y,last+28)));last=y;
        c.fillStyle='#772f32';c.beginPath();c.arc(16,y,11,0,Math.PI*2);c.fill();
        c.fillStyle='#fff';c.font='bold 13px sans-serif';c.textAlign='center';c.textBaseline='middle';c.fillText(p.number,16,y);
      }
      return {data:canvas.toDataURL('image/png').split(',')[1],width:canvas.width,height:canvas.height};
    }''',{'png':base64.b64encode(raw).decode(),'positions':positions})
    annotate.close()
    folder=OUT/slug;folder.mkdir(parents=True,exist_ok=True)
    file=folder/f'{name}-{variant}.png';file.write_bytes(base64.b64decode(data['data']))
    receipt=RECEIPTS.setdefault(slug,{'schema':'cityscroll.guide-captures.v1','figures':{}})
    figure=receipt['figures'].setdefault(name,{'locale':'en','caption':caption,'alt':alt})
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
         '1. Choose a topic. 2. Choose a borough or Any place; these choices have not saved a watch.',
         'Following topic buttons above the borough choices.',variant)
    page.get_by_text('Hearings and meetings',exact=True).click()
    if page.locator('.following-refinements').get_attribute('open') is None:
        page.get_by_text('Narrow it down',exact=True).click()
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
    page.get_by_text('Watch summary',exact=True).wait_for()
    crop(page,board,'board-preview',['[data-following-rule-line]','[data-following-scope-panel]'],
         ['[data-following-rule-line]','[data-following-scope-panel]'],
         '1. Read Watch summary. 2. Watch criteria must identify Manhattan Community Board 7 before saving.',
         'The watch summary and criteria identify Manhattan Community Board 7 in a disposable preview.',variant,
         provenance='Disposable empty-preview fixture rendered by following_view.mjs; no watch created')
    crop(page,watch,'create-watch','[data-following-subscribe-form]',
         ['[data-following-subscribe-form] input[type="email"]','[data-following-subscribe-submit]'],
         '1. Enter Email address only when ready. 2. Create watch starts email updates when the request succeeds.',
         'Create this watch form with an empty Email address and Create watch button.',variant,
         provenance='Disposable signed-out Following preview')
    page.locator('[data-following-subscribe-form] input[type="email"]').fill('reader@example.invalid')
    page.locator('[data-following-subscribe-submit]').click()
    page.get_by_text("You're subscribed — we'll email you. Manage or unsubscribe anytime.",exact=True).wait_for()
    crop(page,board,'watch-confirmation','[data-following-subscribe-form]',
         ['[data-following-submit-status]'],
         '1. This confirmation means the save succeeded. Keep the welcome email to manage or stop the watch.',
         'A disposable successful-save example showing the subscribed confirmation and an empty email field.',variant,
         provenance='Disposable successful subscription response; all outgoing writes intercepted; no email sent',
         redactions=['Disposable email cleared by the production success handler before capture'])


def calendar(page,base,variant):
    go(page,base,'/browse/meetings/','#meetings-toolbar')
    crop(page,'put-dates-in-your-calendar','calendar-toolbar','#meetings-toolbar',
         ['[data-calendar-subscription="scope"]'],
         '1. Subscribe to calendar sits in the list toolbar above the meeting records.',
         'Meetings list toolbar, including the Subscribe to calendar control.',variant)
    page.locator('[data-calendar-subscription="scope"]').first.click()
    dialog='[data-calendar-subscription-dialog][open]'
    page.locator(dialog).wait_for()
    crop(page,'put-dates-in-your-calendar','calendar-options',dialog,
         [dialog+' a[href^="webcal:"]',dialog+' [data-calendar-subscription-copy]'],
         '1. Open calendar subscription opens your calendar app. 2. Copy subscription URL is for apps that ask for a web address.',
         'Calendar subscription panel naming Meetings and showing the open and copy options.',variant)
    page.locator('[data-calendar-subscription-close]').click()
    page.get_by_text('More filters',exact=True).click()
    crop(page,'find-and-narrow-records','meeting-filters','#meetings-toolbar',
         ['#meetings-toolbar input[type="search"]','#meetings-toolbar details'],
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
    page.locator('[data-ctl-clear]').wait_for(state='visible')
    crop(page,'look-at-records-as-of-a-day','date-result','[data-civic-time-ledger]',
         ['[data-ctl-comparison]','[data-ctl-clear]'],
         '1. The summary describes the applied cutoff. 2. Clear removes it; later records remain separate.',
         'Applied As of day summary and the Clear control.',variant)
    page.locator('[data-ctl-clear]').click()
    assert page.locator('#ctl-as-of').input_value()==''


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--only',default='following,calendar,connection,asof')
    parser.add_argument('--site-dir',type=Path,default=ROOT/'.artifacts/guide-preview')
    parser.add_argument('--replay-dir',type=Path,default=SCRATCH)
    args=parser.parse_args()
    server,thread,base=serve(args.site_dir)
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            for variant,width,height in VIEWPORTS:
                for task in args.only.split(','):
                    context=browser.new_context(viewport={'width':width,'height':height},locale='en-US')
                    page=context.new_page();page.set_default_timeout(15000)
                    install_routes(page,base,args.replay_dir)
                    try: globals()[task](page,base,variant)
                    except Exception:
                        page.screenshot(path=str(SCRATCH/'capture-failure.png'))
                        (SCRATCH/'capture-failure.html').write_text(page.content())
                        raise
                    finally: context.close()
            browser.close()
    finally:
        for slug,receipt in RECEIPTS.items():
            folder=OUT/slug;path=folder/'receipt.json'
            old=json.loads(path.read_text()) if path.exists() else {'schema':'cityscroll.guide-captures.v1','figures':{}}
            for key,value in receipt['figures'].items():
                old['figures'][key]={**old['figures'].get(key,{}),**value}
            path.write_text(json.dumps(old,indent=2)+'\n')
        server.shutdown();server.server_close();thread.join(5)

if __name__=='__main__': main()
