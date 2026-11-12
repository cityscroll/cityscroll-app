// Generic per-agency procurement evidence projection.
//
// Pure reducers over retained, accepted engine source records: capability
// support per agency, factual published signals (community-board budget
// requests, capital project movements, published contract term ends), and a
// bounded content-addressed manifest/page reader. No collectors, no network
// access at build or render time, no inferred probabilities, and no supplier
// state: every signal cites its exact source field, and a missing or failed
// source family stays explicitly unavailable rather than reading as zero.
import { createHash } from 'node:crypto';

export const DAY = 86400000;
export const isoDay = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString().slice(0,10) === x;
const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

// Resolve a publisher agency label through the canonical agency crosswalk.
// Exact or single-alias matches only; ambiguous or absent labels stay null.
export function exactAgency(label, crosswalk) {
  if (Object.hasOwn(crosswalk,label)) return label;
  const matches=Object.entries(crosswalk).filter(([,v]) => [v.canonical_name,v.acronym,...(v.variants||[])].some(x => norm(x)===norm(label)));
  return matches.length===1 ? matches[0][0] : null;
}

// Capability support derives from admitted source families only. A missing
// agency is unknown, never a zero-count population.
export function capabilities(families, agency) {
  const results=families.filter(f=>f.agency_ids.includes(agency)).map(f=>({family:f.id,source_id:f.source_id,status:f.status,unit:f.unit,geography:f.geography||null,source_as_of:f.source_as_of||null,version:f.version,index:f.index??null}));
  return {agency, state:results.length?'supported':'unknown', families:results};
}

function plusMonths(date, months) { const d=new Date(date+'T00:00:00Z'); const day=d.getUTCDate();d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth()+months);d.setUTCDate(Math.min(day,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate())); return d.toISOString().slice(0,10); }

// Factual contract-term signals: only the publisher's own end_date field on
// Agreement records, inside an inclusive calendar window. Registration date
// plus reported or assumed duration never manufactures an expiry.
export function contractEndSignals(rows,{asOf,months=12}={}) {
  if (!isoDay(asOf) || ![12,24].includes(months)) throw Error('invalid window');
  const upper=plusMonths(asOf,months), byId=new Map(),excluded=[];
  for(const r of rows) {
    const reason=r.record_type!=='Agreement'?'not_agreement':!isoDay(r.end)?'no_published_end':r.source_values?.end_date!==r.end?'unproven_end_field':!r.official_url?.startsWith('https://www.checkbooknyc.com/')?'missing_source':r.end<asOf||r.end>upper?'outside_window':null;
    if(reason) {excluded.push({id:r.contract_id,reason});continue;}
    const key=`${r.agency_id}/${r.contract_id}`;
    if(byId.has(key)&&byId.get(key).end!==r.end) {byId.set(key,{conflict:true});excluded.push({id:r.contract_id,reason:'conflicting_end'});continue;}
    if(!byId.has(key)) byId.set(key,r);
  }
  const signals=[...byId].filter(([,r])=>!r.conflict).map(([id,r])=>({id:`contract-end/${id}`,kind:'published_contract_end',agency_id:r.agency_id.replace(/^agency:id:/,''),contract_id:r.contract_id,headline:`Published term ends ${r.end}`,event_date:r.end,observed_at:r.retrieval_timestamp,evidence_state:(Date.parse(asOf)-Date.parse(r.retrieval_timestamp))/DAY>45?'dated_retained':'current_observation',source_url:r.official_url,source_field:'end_date',vendor:r.vendor,claim:'Published contract term; no rebid or renewal commitment.',basis:'publisher_field',denominator:null}));
  return {window:{from:asOf,to:upper,inclusive:true},unit:'distinct agency and contract agreement',signals,excluded};
}

// Community-board budget request signals: the latest servable publication at
// or before asOf, exactly bound to board, fiscal cycle and tracking code.
// Diagnostic-only future publications never become current.
export function budgetRequestSignals(document,{asOf,agency}={}) {
  if(!isoDay(asOf)) throw Error('invalid asOf');
  return document.requests.flatMap(r=>{
    const versions=r.versions.filter(v=>v.servable===true && isoDay(v.publication_date) && v.publication_date<=asOf && v.responsible_agency.binding==='bound').sort((a,b)=>b.publication.localeCompare(a.publication));
    const v=versions[0]; if(!v || v.responsible_agency.agency_id!==agency || r.board_binding!=='bound')return [];
    return [{id:`cb-request/${r.board_id}/${r.fiscal_year}/${r.tracking_code}`,kind:'community_board_request',agency_id:agency,board_id:r.board_id,fiscal_year:r.fiscal_year,tracking_code:r.tracking_code,event_date:v.publication_date,headline:v.request,explanation:v.explanation,response:v.response,rank:v.rank,source_url:'https://data.cityofnewyork.us/d/vn4m-mk4t',source_id:'vn4m-mk4t',source_publication:v.publication,claim:'Published request and agency response; not an appropriation or solicitation.',denominator:null}];
  });
}

// Whole-project capital movement: before/after budget and forecast
// completion deltas on one financial identity, with the compared-identity
// denominator of its own source. Never a solicitation value or bid deadline.
export function capitalSignal(fixture,{agency,asOf,crosswalk}={}) {
  const r=fixture.record,a=r.after,b=r.before;
  if(exactAgency(r.managing_agency,crosswalk)!==agency||!a||!b||a.fms_id!==b.fms_id||a.managing_agency!==b.managing_agency||!isoDay(a.agency_data_date)||a.agency_data_date>asOf) return null;
  return {id:`capital-financial/${r.managing_agency}/${r.fms_id}/${a.reporting_period}`,kind:'capital_project_update',agency_id:agency,fms_id:r.fms_id,pid:a.pid,event_date:a.agency_data_date,reporting_period:a.reporting_period,financial_data_date:a.financial_data_date,headline:`${r.fms_id}: ${a.current_phase}`,budget_change:r.changes.total_budget,forecast_completion:r.changes.forecast_completion,source_url:fixture.source_url,claim:fixture.scope,denominator:{unit:'financial project identities compared for the selected managing agency',agency:r.managing_agency,count:fixture.counts.financial.compared},not_eligible_as:'solicitation timing or bid amount'};
}

// Intent admission stays behind the existing per-signal gates: promotion is
// possible only with explicit authorization plus retained production
// observations. Consumers must still evaluate each signal on its own.
export function admitIntent(authorization) {
  return authorization?.product_promotion_allowed===true && (authorization?.retained_production_observations_present===true || authorization?.retained_data_present===true) && Number(authorization?.resolved_production_observation_count)>=1;
}

// The legacy registration-plus-duration heuristic remains inspectable
// research input only: uncalibrated, no probability, no manufactured
// interval, never a public factual expiry.
export function heuristicResearchControl(row) {
  return {kind:'unvalidated_term_heuristic',research_only:true,public_signal:false,method:row.duration?'registration_plus_reported_duration':'registration_plus_assumed_three_years',inputs:{registration_date:row.registered||null,duration:row.duration||null},uncertainty:'Uncalibrated; no date range or probability claimed.',reason:'No observed publisher end date or validated timing-error distribution.'};
}

function canonical(x) { if(Array.isArray(x))return x.map(canonical);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x; }
export const bytes = x=>Buffer.from(JSON.stringify(canonical(x))+'\n');
export const digest = x=>createHash('sha256').update(bytes(x)).digest('hex');

// One immutable generation: attempt/check clocks are excluded from the
// version so observation-only refresh preserves published hashes.
export function makeGeneration({families,records,transformVersion='v3.1'}) {
  const stable={schema:'cityscroll.procurement_evidence.v1',transform_version:transformVersion,families:families.map(({checked_at,last_attempt_at,...stable})=>stable).sort((a,b)=>a.id.localeCompare(b.id)),records:[...records].sort((a,b)=>a.id.localeCompare(b.id))};
  return {...stable,version:digest(stable)};
}

// Bounded immutable pages: at most 25 rows and 64 KiB each; an oversized
// record fails the whole build closed rather than truncating.
export function paginate(generation,{pageSize=25,maxBytes=65536}={}) {
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>25)throw Error('page size');
  const pages=[];let rows=[];
  const emit=()=>{const page={schema:'cityscroll.procurement_evidence_page.v1',version:generation.version,rows};if(bytes(page).length>maxBytes)throw Error('oversized record');pages.push({body:page,sha256:digest(page)});rows=[];};
  for(const row of generation.records) { const trial={schema:'cityscroll.procurement_evidence_page.v1',version:generation.version,rows:[...rows,row]}; if(rows.length && (rows.length>=pageSize||bytes(trial).length>maxBytes))emit();rows.push(row); }
  if(rows.length)emit();return pages;
}

// Refresh state machine: distinct attempt, validated candidate and observed
// served clocks. A failed attempt never moves the served generation or its
// success clock; candidate activation compares and swaps on the served
// parent so a stale parallel activation is rejected.
export function acceptRefresh(state,event) {
  const next=structuredClone(state),now=Date.parse(event.at);
  if(!Number.isFinite(now)||now<Date.parse(state.last_attempt_at||0))throw Error('clock regression');
  next.last_attempt_at=event.at;
  if(event.type==='failed') {next.last_error={stage:event.stage,reason:event.reason,at:event.at};next.consecutive_failures=(state.consecutive_failures||0)+1;return next;}
  if(event.type==='candidate') {if(event.parent_version!==state.served_version)throw Error('concurrent parent mismatch');next.candidate_version=event.version;next.candidate_parent=event.parent_version;next.last_build_success_at=event.at;return next;}
  if(event.type==='served') {
    if(!event.manifest_verified||!event.page_verified||event.version!==state.candidate_version||state.candidate_parent!==state.served_version)throw Error('unverified served generation');
    next.previous_version=event.version===state.served_version?state.previous_version:state.served_version;
    next.served_version=event.version;next.last_served_success_at=event.at;next.last_error=null;next.consecutive_failures=0;return next;
  }
  throw Error('unknown refresh event');
}

// Served freshness: source checks follow the source contract's own cadence
// (never reset by build time); two consecutive failures or an overdue served
// check alert. Missing generation, stale and invalid clocks stay distinct.
export function freshness(state,{now,sourceCheckAt,maxCheckHours=36}={}) {
  const t=Date.parse(now),check=Date.parse(sourceCheckAt),served=Date.parse(state.last_served_success_at);
  if(!Number.isFinite(t)||check>t+300000||served>t+300000)return {state:'invalid_clock',current_claim_allowed:false};
  if(!state.served_version)return {state:'unavailable',current_claim_allowed:false};
  const due=!Number.isFinite(check)||t-check>maxCheckHours*3600000;
  const publishOverdue=!Number.isFinite(served)||t-served>36*3600000;
  return {state:state.last_error?'refresh_failed':due||publishOverdue?'stale':'current',current_claim_allowed:!state.last_error&&!due&&!publishOverdue,alert:(state.consecutive_failures||0)>=2||publishOverdue,last_served_success_at:state.last_served_success_at||null};
}

// Bounded reader for published evidence pages: fixed origin, no-store,
// redirect:error, one 12s request window, at most two reads (manifest plus
// one page), stream limits enforced before JSON parse, and schema, agency,
// version, path and hash all verified before a row is returned. A source
// error is an unavailable outcome, never a zero population.
export async function readEvidencePage(fetchImpl,{origin='https://cityscroll.pages.dev',agency,family,page=0,version=null,timeoutMs=12000}={}) {
  if(origin!=='https://cityscroll.pages.dev'||!/^[a-z][a-z0-9-]{1,80}$/.test(agency||'')||!/^[a-z][a-z0-9-]{1,50}$/.test(family||'')||!Number.isInteger(page)||page<0||page>100000)throw Error('invalid query');
  const abort=new AbortController(), timer=setTimeout(()=>abort.abort(),timeoutMs);
  let requests=0;
  async function get(path,limit) {
    requests++;if(requests>2)throw Error('request budget');
    const response=await fetchImpl(origin+path,{cache:'no-store',redirect:'error',signal:abort.signal,headers:{Accept:'application/json'}});
    if(!response.ok)throw Error(`source HTTP ${response.status}`);
    if(response.headers.get('content-type')?.includes('text/html'))throw Error('login response');
    const reader=response.body.getReader();let size=0,chunks=[];
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('body budget');}chunks.push(Buffer.from(value));}
    const body=Buffer.concat(chunks);return {body,data:JSON.parse(body)};
  }
  try {
    const prefix=`/data/procurement_evidence/${agency}`;
    const {data:manifest}=await get(prefix+'/manifest.json',262144);
    if(manifest.schema!=='cityscroll.procurement_evidence_manifest.v1'||manifest.agency_id!==agency||!/^[0-9a-f]{64}$/.test(manifest.version))throw Error('invalid manifest');
    if(version&&version!==manifest.version)throw Error('409 version changed');
    const entry=manifest.families?.[family];
    if(!entry||entry.state==='unavailable')return {state:'unavailable',rows:null,requests};
    const pointer=entry.pages?.[page];if(!pointer)return {state:'out_of_range',rows:[],total:entry.total,requests};
    const expectedPath=`${prefix}/${manifest.version}/${family}-${page}.json`;
    if(pointer.path!==expectedPath||!/^[0-9a-f]{64}$/.test(pointer.sha256))throw Error('untrusted page pointer');
    const {body,data}=await get(expectedPath,65536);
    if(createHash('sha256').update(body).digest('hex')!==pointer.sha256||data.version!==manifest.version||data.schema!=='cityscroll.procurement_evidence_page.v1'||!Array.isArray(data.rows)||data.rows.length>25||data.rows.some(row=>row.agency_id!==agency))throw Error('page integrity');
    return {state:entry.state,rows:data.rows,total:entry.total,version:manifest.version,source_as_of:entry.source_as_of,requests};
  } finally {clearTimeout(timer);}
}
