#!/usr/bin/env python3
"""Read every static guide document without JavaScript and retain only public receipts.

Screenshots remain ignored. Uses the guide's existing headless preview and capture setup.
"""
import argparse, hashlib, json, subprocess, sys
from pathlib import Path
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright
from capture_guide_release import serve
from capture_guide_illustrations import install_routes, SCRATCH

ROOT=Path(__file__).resolve().parents[1]

def journeys(browser, base, revision, scratch):
    results=[]
    for locale in ['es','zh-Hans','ar']:
        for task,product,help_key in [('board','/following/','following'),('calendar','/browse/meetings/','calendar'),('collection','/#investigation','collection')]:
            context=browser.new_context(viewport={'width':390,'height':844})
            page=context.new_page();install_routes(page,base,SCRATCH)
            path,_,fragment=product.partition('#')
            start=path+'?lang='+locale+('#'+fragment if fragment else '')
            page.goto(base.rstrip('/')+start,wait_until='domcontentloaded')
            page.wait_for_function('(language)=>window.LANG===language',arg=locale)
            page.wait_for_timeout(750)
            if task=='calendar':
                page.locator('#meetings-toolbar [data-calendar-subscription="scope"]').click()
                page.locator('[data-calendar-subscription-dialog][open]').wait_for()
            help_link=page.locator(f'a[data-i18n="guide_help_{help_key}"]').first
            help_link.wait_for(state='visible');help_link.click()
            page.wait_for_url('**/guide/'+locale+'/**')
            if task=='board':
                page.locator('main a[href*="/follow-a-community-board/"]').first.click()
            page.wait_for_function('(language)=>document.documentElement.lang===language',arg=locale)
            article=page.url
            back_steps=1
            if page.locator('main a[href*="/understand/"]').count()==0:
                page.locator(f'a[href="/guide/{locale}/"]').first.click()
                back_steps=2
            page.locator('main a[href*="/understand/"]').first.click()
            page.wait_for_url('**/guide/'+locale+'/understand/**')
            explanation=page.url
            assert page.locator('html').get_attribute('lang')==locale
            for _ in range(back_steps): page.go_back(wait_until='domcontentloaded')
            assert page.url==article
            destination=page.locator('.guide-return a').get_attribute('href')
            assert 'lang='+locale in destination
            page.locator('.guide-return a').click()
            page.wait_for_function('(language)=>window.LANG===language && document.documentElement.lang===language',arg=locale)
            assert page.locator('html').get_attribute('dir')==('rtl' if locale=='ar' else 'ltr')
            image=page.screenshot(full_page=True,animations='disabled')
            (scratch/f'journey-{locale}-{task}.png').write_bytes(image)
            relative=lambda url:url.removeprefix(base.rstrip('/'))
            results.append({'locale':locale,'journey':task,'route':start,'viewport':{'width':390,'height':844},
                'article':relative(article),'explanation':relative(explanation),'return':relative(page.url),
                'revision':revision,'data_vintage':'Retained product documents; disposable Following preview; all outgoing writes intercepted',
                'assertion':'Product contextual help, localized article, explanation, browser Back and product return preserve language and direction',
                'assertion_holds':True,'sha256':hashlib.sha256(image).hexdigest()})
            context.close();print(f'{locale}: {task} guide return journey checked',flush=True)
    return results

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--site-dir',type=Path,default=ROOT/'.artifacts/guide-preview')
    parser.add_argument('--locales',default='')
    parser.add_argument('--journeys-only',action='store_true')
    args=parser.parse_args()
    spec=json.loads(subprocess.check_output(['node','--input-type=module','-e',
        "import {loadGuide} from './tools/build_guide_documents.mjs'; import {loadGuideCatalog} from './tools/guide_translation_catalog.mjs'; const c=loadGuideCatalog(); console.log(JSON.stringify({locales:['en',...c.SHIPPING_LANGS],meta:c.LANG_META,routes:['/guide/',...loadGuide().articles.map(a=>a.url)]}))"],cwd=ROOT,text=True))
    locales=[] if args.journeys_only else (args.locales.split(',') if args.locales else spec['locales'])
    revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    scratch=ROOT/'.artifacts/guide-language/rendered';scratch.mkdir(parents=True,exist_ok=True)
    receipts=[]
    server,thread,base=serve(args.site_dir)
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            for locale in locales:
                for width,height in [(390,844),(1440,900)]:
                    context=browser.new_context(viewport={'width':width,'height':height},java_script_enabled=False)
                    page=context.new_page()
                    for canonical in spec['routes']:
                        route=canonical if locale=='en' else canonical.replace('/guide/',f'/guide/{locale}/',1)
                        response=page.goto(base.rstrip('/')+route,wait_until='networkidle')
                        page.locator('img').evaluate_all("images => images.forEach(image => image.loading='eager')")
                        page.wait_for_function('Array.from(document.images).every(image => image.complete)')
                        page.evaluate('document.fonts.ready')
                        state=page.evaluate('''() => ({lang:document.documentElement.lang,dir:document.documentElement.dir,
                            width:document.documentElement.scrollWidth,viewport:innerWidth,
                            title:document.querySelector('main h1')?.textContent.trim(),
                            words:document.querySelector('main')?.textContent.trim().length,
                            paragraphs:document.querySelectorAll('main p').length,
                            brokenImages:[...document.images].filter(i=>!i.complete || !i.naturalWidth).length,
                            placeholders:/\\{(?:control|name|link|preserved)_[a-z]+\\}/.test(document.body.textContent)})''')
                        assertions={ 'http_ok':response.status==200, 'language':state['lang']==locale,
                            'direction':state['dir']==spec['meta'][locale]['dir'],
                            'no_horizontal_overflow':state['width']<=state['viewport']+1,
                            'content_present':bool(state['title']) and state['words']>100 and state['paragraphs']>2,
                            'images_loaded':state['brokenImages']==0,'no_placeholders':not state['placeholders']}
                        image=page.screenshot(full_page=True,animations='disabled')
                        file=scratch/f"{locale}-{width}-{canonical.rstrip('/').split('/')[-1]}.png";file.write_bytes(image)
                        receipts.append({'route':route,'viewport':{'width':width,'height':height},'revision':revision,
                            'data_vintage':'Tracked guide sources and retained illustration receipts; no civic data acquired',
                            'javascript':False,'assertions':assertions,'assertion_holds':all(assertions.values()),
                            'sha256':hashlib.sha256(image).hexdigest(),'html_sha256':hashlib.sha256(page.content().encode()).hexdigest()})
                    context.close()
                print(f'{locale}: 40 static rendered reads checked',flush=True)
            journey_receipts=journeys(browser,base,revision,scratch)
            browser.close()
    finally:
        server.shutdown();server.server_close();thread.join(5)
    output=ROOT/'docs/evidence/guide-language/rendered.json';output.parent.mkdir(parents=True,exist_ok=True)
    if args.journeys_only: output=output.with_name('journeys.json')
    output.write_text(json.dumps({'schema':'cityscroll.guide-language-rendered.v1','captured_at':datetime.now(timezone.utc).isoformat(),
        'method':'Local static preview, Chromium, no JavaScript; screenshots retained outside published assets',
        'captures':receipts,'journeys':journey_receipts},indent=2)+'\n')
    failed=[r for r in receipts if not r['assertion_holds']]
    for r in failed:print(r['route'],r['viewport'],r['assertions'])
    return int(bool(failed))

if __name__=='__main__':sys.exit(main())
