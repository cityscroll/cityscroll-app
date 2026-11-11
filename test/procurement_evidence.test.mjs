import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as m from '../site/procurement_evidence.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const read=n=>JSON.parse(readFileSync(new URL('../warehouse/fixtures/procurement-evidence/'+n,import.meta.url)));
const nycha=read('nycha-contract-agreement.json'), cb=read('queens-cb12-budget-register.json'), capital=read('ddc-capital-project.json');
const crosswalk=JSON.parse(readFileSync(new URL('../worker/src/data/agency_crosswalk.json',import.meta.url))).entries;
const asOf='2026-11-10';
const families=[
 {id:'registered-contracts',source_id:'checkbook-contracts',agency_ids:['environmental-protection','health-and-mental-hygiene'],status:'available',unit:'distinct prime contract',version:'nov10',source_as_of:'2026-11-10'},
 {id:'program-sites',source_id:'ebkm-iyma',agency_ids:['youth-and-community-development'],status:'available',unit:'distinct program-site offering',geography:'service_site_community_district',version:'fy2026',source_as_of:null},
 {id:'capital-projects',source_id:'fb86-vt7u',agency_ids:['design-and-construction'],status:'available',unit:'financial project identity',version:'202605'},
 {id:'budget-requests',source_id:'vn4m-mk4t',agency_ids:['education','environmental-protection'],status:'available',unit:'tracking code and fiscal cycle',version:'20260630'},
 {id:'contract-terms',source_id:'checkbook-nycha-contracts',agency_ids:['housing-authority'],status:'dated_retained',unit:'contract agreement',version:'aug28'}
];
const dep=m.budgetRequestSignals(cb,{asOf,agency:'environmental-protection'}), doe=m.budgetRequestSignals(cb,{asOf,agency:'education'}),end=m.contractEndSignals(nycha,{asOf,months:24}),ddc=m.capitalSignal(capital,{agency:'design-and-construction',asOf,crosswalk});

test('published NYCHA term falls in 24mo, not 12mo; observed source remains dated',()=>{assert.equal(end.signals.length,1);assert.equal(end.signals[0].event_date,'2028-01-13');assert.equal(end.signals[0].evidence_state,'dated_retained');assert.equal(m.contractEndSignals(nycha,{asOf}).signals.length,0);assert.equal(end.signals[0].vendor,'VITAL PLUMBING INC');});
test('registration date cannot fill absent publisher end, even with duration',()=>{const r={...nycha[0],end:null,duration:'3 Years'};assert.equal(m.contractEndSignals([r],{asOf,months:24}).excluded[0].reason,'no_published_end');});
test('computed end with absent raw source field is refused',()=>{assert.equal(m.contractEndSignals([{...nycha[0],source_values:{}}],{asOf,months:24}).signals.length,0);});
test('release/line duplicate and exact duplicate never inflate agreements',()=>{assert.equal(m.contractEndSignals([...nycha,...nycha,{...nycha[0],record_type:'Release'}],{asOf,months:24}).signals.length,1);});
test('conflicting published ends quarantine identity',()=>{const r={...nycha[0],end:'2028-01-14',source_values:{end_date:'2028-01-14'}};assert.equal(m.contractEndSignals([...nycha,r],{asOf,months:24}).signals.length,0);});
test('bad calendar date and unsupported window refused',()=>{assert.equal(m.isoDay('2026-02-30'),false);assert.throws(()=>m.contractEndSignals(nycha,{asOf,months:36}));});
test('DOE latest servable response is preserved; future diagnostic excluded',()=>{const r=doe.find(r=>r.tracking_code==='412202701C');assert.equal(r.source_publication,'20260630');assert.match(r.response,/not eligible/);assert.equal(r.denominator,null);});
test('DEP request and unsupportive response survives without funding claim',()=>{const r=dep.find(r=>r.tracking_code==='412202702C');assert.ok(r);assert.match(r.response,/not support|cannot accommodate/i);assert.match(r.claim,/not an appropriation/);});
test('no cross-agency or cross-cycle fuzzy stitching',()=>{assert.deepEqual(m.budgetRequestSignals(cb,{asOf,agency:'unknown'}),[]);assert.ok(new Set([...dep,...doe].map(r=>r.id)).size===dep.length+doe.length);});
test('DDC project budget movement is not solicitation amount',()=>{assert.equal(ddc.budget_change.delta,'17000000.00');assert.equal(ddc.forecast_completion.delta_days,101);assert.match(ddc.claim,/Not solicitation/);assert.equal(ddc.denominator.count,932);});
test('project wrong agency or future period is not accepted',()=>{assert.equal(m.capitalSignal(capital,{agency:'education',asOf,crosswalk}),null);assert.equal(m.capitalSignal(capital,{agency:'design-and-construction',asOf:'2026-01-01',crosswalk}),null);});
test('crosswalk exact alias works without fuzzy similarity',()=>{assert.equal(m.exactAgency('DEP',crosswalk),'environmental-protection');assert.equal(m.exactAgency('Environmental Project',crosswalk),null);});
test('DYCD map capability does not leak into DEP, DOE, DDC, NYCHA',()=>{for(const agency of ['environmental-protection','education','design-and-construction','housing-authority'])assert.equal(m.capabilities(families,agency).families.some(f=>f.geography==='service_site_community_district'),false);assert.ok(m.capabilities(families,'youth-and-community-development').families.some(f=>f.geography));});
test('unknown source is unknown, not a citywide zero',()=>{assert.deepEqual(m.capabilities(families,'unknown'),{agency:'unknown',state:'unknown',families:[]});});
test('failed registered family does not disable healthy CB request family',()=>{const fs=structuredClone(families);fs[0].status='unavailable';const r=m.capabilities(fs,'environmental-protection');assert.equal(r.families.find(f=>f.family==='budget-requests').status,'available');assert.equal(r.families.find(f=>f.family==='registered-contracts').status,'unavailable');});
test('public intent admission fails without retained production plus authorization',()=>{assert.equal(m.admitIntent(null),false);assert.equal(m.admitIntent({product_promotion_allowed:true,resolved_production_observation_count:3}),false);assert.equal(m.admitIntent({product_promotion_allowed:true,retained_production_observations_present:true,resolved_production_observation_count:1}),true);});
test('legacy heuristic remains inspectable research with no fabricated uncertainty interval',()=>{const r=m.heuristicResearchControl({registered:'2025-01-01'});assert.equal(r.public_signal,false);assert.equal(r.method,'registration_plus_assumed_three_years');assert.equal('probability' in r,false);assert.match(r.uncertainty,/Uncalibrated/);});

const records=[...end.signals,...doe,...dep,ddc];
const generation=m.makeGeneration({families,records});
test('check-only clock changes preserve semantic version; records change invalidates',()=>{assert.equal(m.makeGeneration({families:families.map(f=>({...f,checked_at:'2026-11-11'})),records}).version,generation.version);assert.notEqual(m.makeGeneration({families,records:records.slice(1)}).version,generation.version);});
test('source family input order and record order do not change version',()=>{assert.equal(m.makeGeneration({families:[...families].reverse(),records:[...records].reverse()}).version,generation.version);});
test('pages stay 25 rows and 64KiB; oversized record fails closed',()=>{const pages=m.paginate(generation);assert.ok(pages.every(p=>p.body.rows.length<=25&&m.bytes(p.body).length<=65536));assert.throws(()=>m.paginate(m.makeGeneration({families,records:[{id:'long',text:'x'.repeat(66000)}]})),/oversized/);});

const initial={served_version:'v1',last_served_success_at:'2026-11-10T00:00:00Z',last_attempt_at:'2026-11-10T00:00:00Z'};
const candidate=m.acceptRefresh(initial,{type:'candidate',version:'v2',parent_version:'v1',at:'2026-11-11T00:00:00Z'});
test('successful build does not move served clock or active version',()=>{assert.equal(candidate.served_version,'v1');assert.equal(candidate.last_served_success_at,initial.last_served_success_at);});
test('actual verified served manifest and page advance last success',()=>{const r=m.acceptRefresh(candidate,{type:'served',version:'v2',manifest_verified:true,page_verified:true,at:'2026-11-11T00:01:00Z'});assert.equal(r.served_version,'v2');assert.equal(r.previous_version,'v1');assert.equal(r.last_served_success_at,'2026-11-11T00:01:00Z');});
test('wrong version or incomplete page verification cannot claim served',()=>{for(const e of [{version:'v9',page_verified:true},{version:'v2',page_verified:false}])assert.throws(()=>m.acceptRefresh(candidate,{type:'served',manifest_verified:true,at:'2026-11-11T00:01:00Z',...e}));});
test('candidate compare-and-swap rejects stale parent and clock regression',()=>{assert.throws(()=>m.acceptRefresh(initial,{type:'candidate',parent_version:'v0',version:'v2',at:'2026-11-11T00:00:00Z'}));assert.throws(()=>m.acceptRefresh(initial,{type:'failed',at:'2026-11-09T00:00:00Z'}));});
test('failed publication preserves dated generation; second failure alerts',()=>{let r=m.acceptRefresh(candidate,{type:'failed',stage:'publish',reason:'http503',at:'2026-11-11T00:01:00Z'});r=m.acceptRefresh(r,{type:'failed',stage:'publish',reason:'http503',at:'2026-11-11T01:01:00Z'});assert.equal(r.served_version,'v1');assert.equal(r.last_served_success_at,initial.last_served_success_at);assert.deepEqual([m.freshness(r,{now:'2026-11-11T02:00:00Z',sourceCheckAt:'2026-11-11T01:00:00Z'}).state,m.freshness(r,{now:'2026-11-11T02:00:00Z',sourceCheckAt:'2026-11-11T01:00:00Z'}).alert],['refresh_failed',true]);});
test('quiet annual publication can be healthy with fresh source check and served check',()=>{assert.equal(m.freshness(initial,{now:'2026-11-10T02:00:00Z',sourceCheckAt:'2026-11-10T01:00:00Z'}).state,'current');});
test('stale source, future receipt and missing generation are distinct',()=>{assert.equal(m.freshness(initial,{now:'2026-11-12T00:00:00Z',sourceCheckAt:'2026-11-10T00:00:00Z'}).state,'stale');assert.equal(m.freshness(initial,{now:'2026-11-10T02:00:00Z',sourceCheckAt:'2026-11-11T00:00:00Z'}).state,'invalid_clock');assert.equal(m.freshness({},{now:'2026-11-10T02:00:00Z',sourceCheckAt:'2026-11-10T01:00:00Z'}).state,'unavailable');});

const page=m.paginate({...generation,records:dep})[0],agency='environmental-protection',family='signals';
const manifest={schema:'cityscroll.procurement_evidence_manifest.v1',agency_id:agency,version:generation.version,families:{signals:{state:'dated_retained',total:generation.records.length,pages:[{path:`/data/procurement_evidence/${agency}/${generation.version}/signals-0.json`,sha256:page.sha256}]}}};
function fetchFixture(man=manifest,body=m.bytes(page.body),status=200){const calls=[];const f=async(url,options)=>{calls.push({url,options});return new Response(calls.length===1?JSON.stringify(man):body,{status,headers:{'content-type':'application/json'}});};return {calls,f};}
test('bounded production reader uses manifest plus one integrity checked page',async()=>{const {f,calls}=fetchFixture();const r=await m.readEvidencePage(f,{agency,family});assert.equal(calls.length,2);assert.equal(r.state,'dated_retained');assert.equal(r.rows.length,page.body.rows.length);assert.ok(calls.every(c=>c.options.cache==='no-store'&&c.options.redirect==='error'));});
test('off-host page pointer, wrong version, changed bytes and oversized response fail',async()=>{const off=structuredClone(manifest);off.families.signals.pages[0].path='https://evil.example/page';await assert.rejects(()=>m.readEvidencePage(fetchFixture(off).f,{agency,family}),/untrusted/);await assert.rejects(()=>m.readEvidencePage(fetchFixture().f,{agency,family,version:'old'}),/409/);await assert.rejects(()=>m.readEvidencePage(fetchFixture(manifest,'{}').f,{agency,family}),/integrity/);await assert.rejects(()=>m.readEvidencePage(fetchFixture(manifest,'x'.repeat(65537)).f,{agency,family}),/budget/);});
test('source error is unavailable outcome not zero population',async()=>{await assert.rejects(()=>m.readEvidencePage(fetchFixture(manifest,null,503).f,{agency,family}),/503/);const man=structuredClone(manifest);man.families.signals={state:'unavailable'};const r=await m.readEvidencePage(fetchFixture(man).f,{agency,family});assert.equal(r.rows,null);assert.equal('total' in r,false);});
test('CB monthly acquisition follows source cadence not daily publication check budget',()=>{assert.equal(m.freshness(initial,{now:'2026-11-10T02:00:00Z',sourceCheckAt:'2026-10-17T01:53:34Z',maxCheckHours:5040}).state,'current');});
test('wrong agency row is refused even with a valid body hash',async()=>{const bad={...page.body,rows:[{id:'wrong',agency_id:'education'}]};const man=structuredClone(manifest);man.families.signals.pages[0].sha256=m.digest(bad);await assert.rejects(()=>m.readEvidencePage(fetchFixture(man,m.bytes(bad)).f,{agency,family}),/integrity/);});

test('committed evidence pages survive the builder and match --check', () => {
  const capabilities = JSON.parse(readFileSync(join(ROOT, 'site/data/procurement_evidence_capabilities.json'), 'utf8'));
  assert.equal(capabilities.schema, 'cityscroll.procurement_evidence_capabilities.v1');
  assert.ok(capabilities.agencies['environmental-protection']);
  assert.ok(capabilities.agencies['youth-and-community-development']);
  for (const [agencyId, entry] of Object.entries(capabilities.agencies)) {
    const manifestPath = join(ROOT, 'site', entry.manifest.replace(/^\//, ''));
    assert.ok(existsSync(manifestPath), `missing manifest for ${agencyId}`);
    const agencyManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(agencyManifest.schema, 'cityscroll.procurement_evidence_manifest.v1');
    assert.equal(agencyManifest.agency_id, agencyId);
    assert.match(agencyManifest.version, /^[0-9a-f]{64}$/);
    for (const [family, familyEntry] of Object.entries(agencyManifest.families)) {
      for (const pointer of familyEntry.pages || []) {
        const pagePath = join(ROOT, 'site', pointer.path.replace(/^\//, ''));
        assert.ok(existsSync(pagePath), `missing page ${pointer.path}`);
        const body = readFileSync(pagePath);
        assert.equal(m.digest(JSON.parse(body.toString('utf8'))), pointer.sha256);
        const parsed = JSON.parse(body.toString('utf8'));
        assert.ok(parsed.rows.every(row => row.agency_id === agencyId), `agency binding failed for ${family}`);
      }
    }
  }
  const out = execFileSync('node', ['tools/build_procurement_evidence.mjs', '--check'], { encoding: 'utf8', cwd: ROOT });
  assert.match(out, /"status":"ok"/);
});
