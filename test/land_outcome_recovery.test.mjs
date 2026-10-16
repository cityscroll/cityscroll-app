import assert from "node:assert/strict";
import { test } from "node:test";
import { buildZapOutcomeRecord, prewarmOneZapOutcome, refreshZapOutcomes, handleZapOutcomes, kvKey } from "../worker/src/zap_outcomes.mjs";
import * as phaseTools from "../site/land_phase_spine.mjs";
import { createLandOutcomeRuntime } from "../site/land_outcome_runtime.mjs";
import { startMorningZapOutcomes, withWorkerAcquisitionReceipt } from "../worker/src/lib/worker_acquisition_runtime.mjs";
import { compactZapOutcomeRecord, buildLandDefaultSnapshot } from "../tools/lib/batch_precompute_snapshots.mjs";

// Selected public milestone fields from the October 16, 2026 publisher capture.
// Source: https://zap-api-production.herokuapp.com/projects/2026K0233
// Deliberately omit people, documents, and unrelated payload fields.
const fixture = {
  "data": {
    "id": "2026K0233",
    "type": "projects",
    "attributes": {
      "dcp-name": "2026K0233",
      "dcp-projectname": "240 Nassau Street ",
      "dcp-publicstatus": "In Public Review",
      "dcp-ulurp-nonulurp": "ULURP",
      "dcp-lastmilestonedate": "2026-10-05T21:49:07.000Z"
    }
  },
  "included": [
    {
      "id": "b2bbc83a-46a9-f011-bbd3-001dd806295a",
      "type": "milestones",
      "attributes": {
        "dcp-milestone": "8e3beec4-dad0-e711-8116-1458d04e2fb8",
        "dcp-name": "ZM - Review Session - Certified / Referred  ",
        "milestonename": "Review Session - Certified / Referred",
        "dcp-plannedstartdate": "2026-07-26T01:13:41.000Z",
        "dcp-plannedcompletiondate": "2026-08-05T17:29:42.000Z",
        "dcp-actualstartdate": "2026-07-30T17:29:42.000Z",
        "dcp-actualenddate": "2026-08-04T04:00:00.000Z",
        "statuscode": "Completed",
        "dcp-milestonesequence": 46,
        "display-name": "Application Reviewed at City Planning Commission Review Session"
      }
    },
    {
      "id": "f5bbc83a-46a9-f011-bbd3-001dd806295a",
      "type": "milestones",
      "attributes": {
        "dcp-milestone": "923beec4-dad0-e711-8116-1458d04e2fb8",
        "dcp-name": "ZM - Community Board Referral  ",
        "milestonename": "Community Board Referral",
        "dcp-plannedstartdate": "2026-08-10T18:12:34.000Z",
        "dcp-plannedcompletiondate": "2026-10-05T04:00:00.000Z",
        "dcp-actualstartdate": "2026-08-05T04:00:00.000Z",
        "dcp-actualenddate": "2026-10-05T21:49:00.000Z",
        "statuscode": "Completed",
        "dcp-milestonesequence": 48,
        "display-name": "Community Board Review"
      }
    },
    {
      "id": "55bcc83a-46a9-f011-bbd3-001dd806295a",
      "type": "milestones",
      "attributes": {
        "dcp-milestone": "943beec4-dad0-e711-8116-1458d04e2fb8",
        "dcp-name": "ZM - Borough President Referral  ",
        "milestonename": "Borough President Referral",
        "dcp-plannedstartdate": "2026-10-06T04:00:00.000Z",
        "dcp-plannedcompletiondate": "2026-11-03T04:00:00.000Z",
        "dcp-actualstartdate": "2026-10-06T04:00:00.000Z",
        "dcp-actualenddate": null,
        "statuscode": "In Progress",
        "dcp-milestonesequence": 49,
        "display-name": "Borough President Review"
      }
    },
    {
      "id": "2abdc83a-46a9-f011-bbd3-001dd806295a",
      "type": "milestones",
      "attributes": {
        "dcp-milestone": "9e3beec4-dad0-e711-8116-1458d04e2fb8",
        "dcp-name": "ZM - CPC Public Meeting - Public Hearing  ",
        "milestonename": "CPC Public Meeting - Public Hearing",
        "dcp-plannedstartdate": "2026-11-11T04:00:00.000Z",
        "dcp-plannedcompletiondate": "2026-11-13T04:00:00.000Z",
        "dcp-actualstartdate": null,
        "dcp-actualenddate": null,
        "statuscode": "Not Started",
        "dcp-milestonesequence": 54,
        "display-name": "City Planning Commission Review"
      }
    },
    {
      "id": "61bdc83a-46a9-f011-bbd3-001dd806295a",
      "type": "milestones",
      "attributes": {
        "dcp-milestone": "a43beec4-dad0-e711-8116-1458d04e2fb8",
        "dcp-name": "ZM - CPC Public Meeting - Vote  ",
        "milestonename": "CPC Public Meeting - Vote",
        "dcp-plannedstartdate": "2026-11-22T04:00:00.000Z",
        "dcp-plannedcompletiondate": "2026-11-24T04:00:00.000Z",
        "dcp-actualstartdate": null,
        "dcp-actualenddate": null,
        "statuscode": "Not Started",
        "dcp-milestonesequence": 57,
        "display-name": "City Planning Commission Vote"
      }
    },
    {
      "id": "d0f9cc40-46a9-f011-bbd3-001dd806295a",
      "type": "milestones",
      "attributes": {
        "dcp-milestone": "a63beec4-dad0-e711-8116-1458d04e2fb8",
        "dcp-name": "ZM - City Council Review  ",
        "milestonename": "City Council Review",
        "dcp-plannedstartdate": "2026-11-25T04:00:00.000Z",
        "dcp-plannedcompletiondate": "2027-01-19T04:00:00.000Z",
        "dcp-actualstartdate": null,
        "dcp-actualenddate": null,
        "statuscode": "Not Started",
        "dcp-milestonesequence": 58,
        "display-name": "City Council Review"
      }
    },
    {
      "id": "d4597cbb-0b70-f111-ab0d-001dd802a900",
      "type": "milestones",
      "attributes": {
        "dcp-milestone": "d1cdc050-8cd7-f011-8544-001dd80698b8",
        "dcp-name": "Ad-hoc - Appeals Board Review",
        "milestonename": "Appeals Board Review",
        "dcp-plannedstartdate": "2027-01-26T04:00:00.000Z",
        "dcp-plannedcompletiondate": "2027-02-10T04:00:00.000Z",
        "dcp-actualstartdate": null,
        "dcp-actualenddate": null,
        "statuscode": "Not Started",
        "dcp-milestonesequence": 65,
        "display-name": "Appeals Board Review"
      }
    }
  ]
};
function browser(){
  let response=async()=>new Response("blocked",{status:403});
  const runtime=createLandOutcomeRuntime({
    now:()=>Date.now(),
    normalizeRecord:r=>r,
    translate:(key,args={})=>[key,...Object.values(args)].join(" "),
    formatDate:s=>s,
    escapeHTML:s=>String(s).replaceAll("<","&lt;"),
    connectionTools:async()=>({normalizeProjectConnectionsPayload:p=>p}),
    fetchResponse:(id,accepts)=>response(id,accepts),
  });
  return {runtime,setResponse:fn=>{response=fn;}};
}

test("browser outcome runtime supplies its production clock by default",()=>{
  const runtime=createLandOutcomeRuntime();
  const record={project_id:"CLOCK1",generated_at:new Date().toISOString(),spine:{events:[]}};
  runtime.seed({generated_at:record.generated_at,outcomes:{by_project:{CLOCK1:record}}});
  assert.equal(runtime.get("CLOCK1").data.record,record);
});

test("notice refresh bypasses a warm static snapshot and retains it on failure",async()=>{
  const {runtime,setResponse}=browser();
  const id="STATIC1";
  const stale={project_id:id,generated_at:"2026-10-02T00:00:00Z",stage:"community_board",spine:{events:[]}};
  runtime.seed({generated_at:stale.generated_at,outcomes:{by_project:{[id]:stale}}});
  let requests=0;
  const fresh={...stale,generated_at:new Date().toISOString(),stage:"borough_president"};
  setResponse(async()=>{
    requests+=1;
    return new Response(JSON.stringify({ok:true,record:fresh}));
  });
  const recovered=await runtime.refreshDisplay(id);
  assert.equal(requests,1);
  assert.equal(recovered.record.stage,"borough_president");
  const failed=browser();
  failed.runtime.seed({generated_at:stale.generated_at,outcomes:{by_project:{[id]:stale}}});
  failed.setResponse(async()=>new Response("blocked",{status:403}));
  const retained=await failed.runtime.refreshDisplay(id);
  assert.equal(retained.record.stage,"community_board");
  assert.equal(retained.record.generated_at,stale.generated_at);
  assert.match(retained.freshness,/land_outcome_update_failed/);
});

test("frozen publisher evidence refreshes older CB cache through materializer, endpoint and renderer",async()=>{
  const original=globalThis.fetch;
  const rows=new Map();
  const env={ALERT_STATE:{get:async k=>rows.get(k)||null,put:async(k,v)=>rows.set(k,v)}};
  rows.set(kvKey("2026K0233"),JSON.stringify({project_id:"2026K0233",generated_at:"2026-09-28T00:00:00Z",join:{matched:true},spine:{events:[]}}));
  globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes("herokuapp.com")?fixture:[]));
  try{
    const result=await refreshZapOutcomes(env,{projectIds:["2026K0233"],force:true,
      build:id=>buildZapOutcomeRecord(id,{fetchBbl:false})});
    assert.equal(result.status,"ok");
    const response=await handleZapOutcomes(new Request("https://example.test/zap-outcomes?id=2026K0233"),env);
    const payload=await response.json();
    const record=payload.record;
    const view=phaseTools.buildLandPhaseView(record.spine,record);
    assert.equal(view.current.phase_id,"borough_president");
    assert.ok(record.spine.events.some(e=>e.title==="Community Board Review"&&e.status==="Completed"&&e.time.value.startsWith("2026-10-05")));
    assert.ok(record.spine.events.some(e=>e.title==="Borough President Review"&&e.status==="In Progress"&&e.time.value.startsWith("2026-10-06")));
    const {runtime}=browser();
    assert.equal(runtime.recordForDisplay(payload).project_id,"2026K0233");
    assert.equal(phaseTools.landPhasePanelDataAttributes(view.phases.find(phase=>phase.id===view.current.phase_id)),
      'data-land-phase-panel="borough_president" data-land-phase-state="current"');
    const compact=compactZapOutcomeRecord(record);
    assert.equal(compact.snapshot_state,"present");
    assert.deepEqual(compact.spine,record.spine);
    assert.deepEqual(compact.source_observations,record.source_observations);
    assert.equal(compact.generated_at,record.generated_at);
  }finally{globalThis.fetch=original;}
});

test("stale evidence keeps its vintage through new bundles, session reuse, failed load and recovery",async()=>{
  const {runtime,setResponse}=browser();
  const record={project_id:"2026K0233",generated_at:"2026-09-28T00:00:00Z",filled:true,spine:{events:[]}};
  const payload={ok:true,stale:true,record};
  const snapshot=buildLandDefaultSnapshot([{project_id:record.project_id}],{outcomesByProject:{[record.project_id]:record}});
  runtime.seed(snapshot);
  const staleDisplay=runtime.display(payload);
  assert.equal(staleDisplay.record.evidence_stale,true);
  assert.match(staleDisplay.freshness,/2026-09-28/);
  runtime.cache.get(record.project_id).at=Date.now()-runtime.ttlMs-1;
  assert.equal(runtime.get(record.project_id).expired,true);
  assert.equal(await runtime.fetch(record.project_id,{allowStatic:false}),null);
  const failedDisplay=runtime.display(null,{fallback:runtime.get(record.project_id).data,failed:true});
  assert.match(failedDisplay.freshness,/land_outcome_update_failed/);
  assert.equal(failedDisplay.record.generated_at,record.generated_at);
  const fresh={...record,generated_at:new Date().toISOString()};
  setResponse(async()=>new Response(JSON.stringify({ok:true,stale:false,record:fresh})));
  await runtime.fetch(record.project_id,{allowStatic:false});
  runtime.seed(snapshot);
  const recovered=runtime.get(record.project_id).data;
  assert.equal(recovered.record.generated_at,fresh.generated_at);
  assert.equal(runtime.freshnessHTML(recovered),"");
});

test("expired live evidence revalidates and repaints retained stage after failure",async()=>{
  const {runtime}=browser();
  const id="2026K0233";
  const record={project_id:id,generated_at:new Date().toISOString(),stage:"borough_president",filled:true,spine:{events:[]}};
  runtime.cache.set(id,{data:{ok:true,record},at:Date.now()-runtime.ttlMs-1});
  assert.equal(await runtime.fetch(id,{allowStatic:false}),null);
  const fallback=runtime.get(id).data;
  const display=runtime.display(null,{fallback,failed:true});
  const html=display.freshness+`stage:${display.record.stage}`;
  assert.match(html,/land_outcome_update_failed/);
  assert.match(html,/stage:borough_president/);
  assert.equal(runtime.get(id).data.record.generated_at,record.generated_at);
});

test("real acquisition rejects timeout, HTTP error and malformed JSON without replacing good evidence",async()=>{
  const original=globalThis.fetch;
  try{
    for(const failure of [() => {throw new DOMException("timed out","TimeoutError");},
      () => new Response("unavailable",{status:503}),
      () => new Response("not json"), () => new Response(JSON.stringify({unexpected:true}))]){
      const previous={project_id:"2026K0233",join:{matched:true},generated_at:"2026-09-28T00:00:00Z"};
      const rows=new Map([[kvKey(previous.project_id),JSON.stringify(previous)]]);
      const env={ALERT_STATE:{get:async k=>rows.get(k)||null,put:async(k,v)=>rows.set(k,v)}};
      globalThis.fetch=async url=>String(url).includes("herokuapp.com")?failure():new Response("[]");
      const result=await refreshZapOutcomes(env,{projectIds:[previous.project_id],force:true,
        build:id=>buildZapOutcomeRecord(id,{fetchBbl:false})});
      assert.equal(result.status,"failed");
      assert.deepEqual(JSON.parse(rows.get(kvKey(previous.project_id))),previous);
    }
  }finally{globalThis.fetch=original;}
});

test("partial City Record acquisition merges fresh strict matches with retained evidence",async()=>{
  const original=globalThis.fetch;
  const id="PARTIAL1";
  const previous={project_id:id,join:{matched:true},generated_at:"2026-09-28T00:00:00Z",
    open_data:{project_id:id,project_name:"Retained"},filled:true,
    city_record_notices:[
      {request_id:"retained",start_date:"2026-09-01",short_title:"C 240046 HAM retained hearing",
        join:{method:"exact_ulurp_token",keys:["C240046HAM"]}},
      {request_id:"replaced",start_date:"2026-09-02",short_title:"C 240046 HAM old title",
        join:{method:"exact_ulurp_token",keys:["C240046HAM"]}},
    ],
    source_observations:{city_record:{source_system:"city_record",acquisition_status:"ok",
      observation_status:"observed",observed_at:"2026-09-28T00:00:00Z"}},
    spine:{events:[{id:"old-cb",kind:"zap_milestone",title:"Community Board Review",status:"In Progress",
      time:{value:"2026-09-28",certainty:"actual"}}],gaps:[]}};
  const projectFixture=structuredClone(fixture);
  projectFixture.data.id=id;
  projectFixture.data.attributes["dcp-name"]=id;
  const openData=[{project_id:id,project_name:"Fresh",ulurp_numbers:"C240046HAM",actions:"ZM"}];
  const freshNotice={request_id:"replaced",start_date:"2026-10-10",
    short_title:"C 240046 HAM fresh title"};
  const fetchForCityRecord=(mode)=>async url=>{
    const value=String(url);
    if(value.includes("herokuapp.com")) return new Response(JSON.stringify(projectFixture));
    if(value.includes("dg92-zbpx")){
      const term=new URL(value).searchParams.get("$q");
      if(mode==="partial"&&term==="240 Nassau Street") return new Response(JSON.stringify([freshNotice]));
      if(mode==="empty") return new Response("[]");
      return new Response("blocked",{status:503});
    }
    return new Response(JSON.stringify(openData));
  };
  try{
    const failedRows=new Map([[kvKey(id),JSON.stringify(previous)]]);
    const failedEnv={ALERT_STATE:{get:async k=>failedRows.get(k)||null,put:async(k,v)=>failedRows.set(k,v)}};
    globalThis.fetch=async url=>String(url).includes("herokuapp.com")
      ? new Response(JSON.stringify(projectFixture)) : new Response("blocked",{status:503});
    const failed=await prewarmOneZapOutcome(failedEnv,id,{force:true,
      build:projectId=>buildZapOutcomeRecord(projectId,{fetchBbl:false,lookupDoc:{rows:[]}})});
    assert.equal(failed.status,"failed");
    assert.deepEqual(JSON.parse(failedRows.get(kvKey(id))),previous);

    const unavailableRows=new Map([[kvKey(id),JSON.stringify(previous)]]);
    const unavailableEnv={ALERT_STATE:{get:async k=>unavailableRows.get(k)||null,
      put:async(k,v)=>unavailableRows.set(k,v)}};
    globalThis.fetch=fetchForCityRecord("unavailable");
    const unavailable=await refreshZapOutcomes(unavailableEnv,{projectIds:[id],force:true,
      build:projectId=>buildZapOutcomeRecord(projectId,{fetchBbl:false,lookupDoc:{rows:[]}})});
    assert.equal(unavailable.status,"partial");
    const unavailableRecord=JSON.parse(unavailableRows.get(kvKey(id)));
    assert.deepEqual(unavailableRecord.city_record_notices.map(row=>row.request_id),["retained","replaced"]);
    assert.equal(unavailableRecord.source_observations.city_record.observation_status,"retained");
    assert.equal(unavailableRecord.source_observations.city_record.observed_at,"2026-09-28T00:00:00Z");

    const rows=new Map([[kvKey(id),JSON.stringify(previous)]]);
    const env={ALERT_STATE:{get:async k=>rows.get(k)||null,put:async(k,v)=>rows.set(k,v)}};
    globalThis.fetch=fetchForCityRecord("partial");
    const refreshed=await refreshZapOutcomes(env,{projectIds:[id],force:true,
      build:projectId=>buildZapOutcomeRecord(projectId,{fetchBbl:false,lookupDoc:{rows:[]}})});
    assert.equal(refreshed.status,"partial");
    assert.equal(refreshed.reason,"source-partial");
    assert.equal(refreshed.partial,1);
    const response=await handleZapOutcomes(new Request(`https://example.test/zap-outcomes?id=${id}`),env);
    const payload=await response.json();
    assert.deepEqual(payload.record.city_record_notices.map(row=>row.request_id),["retained","replaced"]);
    assert.equal(payload.record.city_record_notices[1].short_title,"C 240046 HAM fresh title");
    assert.equal(new Set(payload.record.city_record_notices.map(row=>row.request_id)).size,2);
    assert.equal(payload.record.city_record_notices[0].source_observation.observed_at,"2026-09-28T00:00:00Z");
    assert.equal(payload.record.city_record_notices[0].source_observation.observation_status,"retained");
    assert.notEqual(payload.record.city_record_notices[1].source_observation.observed_at,"2026-09-28T00:00:00Z");
    assert.equal(payload.record.city_record_notices[1].source_observation.observation_status,"observed");
    assert.equal(payload.record.source_observations.city_record.observation_status,"observed_and_retained");
    assert.equal(payload.record.source_observations.city_record.acquisition_status,"partial");
    assert.equal(payload.record.source_observations.city_record.retained_observed_at,"2026-09-28T00:00:00Z");
    assert.equal(payload.record.source_observations.city_record.observed_count,1);
    assert.equal(payload.record.source_observations.city_record.retained_count,1);
    assert.notEqual(payload.record.source_observations.city_record.attempted_at,"2026-09-28T00:00:00Z");
    assert.ok(payload.record.spine.events.some(event=>event.id==="city-record:retained:published"));
    assert.ok(payload.record.spine.events.some(event=>event.id==="city-record:replaced:published"));
    assert.ok(payload.record.spine.gaps.some(gap=>gap.slot==="city_record_notices"&&gap.retained===true));
    const view=phaseTools.buildLandPhaseView(payload.record.spine,payload.record);
    assert.equal(view.current.phase_id,"borough_president");
    const {runtime}=browser();
    assert.equal(runtime.recordForDisplay(payload).city_record_notices[1].request_id,"replaced");
    assert.equal(phaseTools.landPhasePanelDataAttributes(view.phases.find(phase=>phase.id===view.current.phase_id)),
      'data-land-phase-panel="borough_president" data-land-phase-state="current"');

    const freshOnlyRows=new Map();
    const freshOnlyEnv={ALERT_STATE:{get:async k=>freshOnlyRows.get(k)||null,
      put:async(k,v)=>freshOnlyRows.set(k,v)}};
    const freshOnly=await refreshZapOutcomes(freshOnlyEnv,{projectIds:[id],force:true,
      build:projectId=>buildZapOutcomeRecord(projectId,{fetchBbl:false,lookupDoc:{rows:[]}})});
    assert.equal(freshOnly.status,"partial");
    const freshOnlyRecord=JSON.parse(freshOnlyRows.get(kvKey(id)));
    assert.deepEqual(freshOnlyRecord.city_record_notices.map(row=>row.request_id),["replaced"]);
    assert.equal(freshOnlyRecord.source_observations.city_record.observation_status,"observed");
    assert.equal(freshOnlyRecord.source_observations.city_record.retained_count,0);

    const emptyRows=new Map();
    const emptyEnv={ALERT_STATE:{get:async k=>emptyRows.get(k)||null,put:async(k,v)=>emptyRows.set(k,v)}};
    globalThis.fetch=fetchForCityRecord("empty");
    const emptyResult=await prewarmOneZapOutcome(emptyEnv,id,{force:true,
      build:projectId=>buildZapOutcomeRecord(projectId,{fetchBbl:false,lookupDoc:{rows:[]}})});
    assert.equal(emptyResult.status,"computed");
    assert.equal(JSON.parse(emptyRows.get(kvKey(id))).source_observations.city_record.observation_status,"observed");
  }finally{globalThis.fetch=original;}
});

test("attempt receipt failure does not relabel a persisted observation",async()=>{
  const id="ATTEMPT1";
  const rows=new Map();
  const env={ALERT_STATE:{
    get:async key=>rows.get(key)||null,
    put:async(key,value)=>{
      if(key.endsWith(":attempt")) throw new Error("attempt-store-down");
      rows.set(key,value);
    },
  }};
  const result=await refreshZapOutcomes(env,{projectIds:[id],force:true,build:async()=>({
    project_id:id,join:{matched:true},generated_at:"2026-10-16T19:00:00Z",filled:true,
  })});
  assert.equal(result.status,"ok");
  assert.equal(result.computed,1);
  assert.equal(JSON.parse(rows.get(kvKey(id))).project_id,id);
  assert.equal(result.attempt_receipt_failed,1);
});

test("scheduled acquisition receipts preserve partial and held results",async()=>{
  const receipts=[];
  const env={ALERT_STATE:{put:async(_key,value)=>receipts.push(JSON.parse(value))}};
  for(const [status,expected] of [["failed","failed"],["partial","partial"],["skipped","held"],["ok","succeeded"]]){
    await withWorkerAcquisitionReceipt(env,"zap-api-outcomes","test",async()=>({status,reason:"fixture"}));
    assert.equal(receipts.at(-1).status,expected);
  }
});

test("morning outcomes start independently even while another acquisition is stalled",async()=>{
  const retained=[];
  let refreshed=false;
  const env={ALERT_STATE:{put:async()=>{}}};
  startMorningZapOutcomes({waitUntil:p=>retained.push(p)},env,"test",
    async()=>{refreshed=true;return {status:"ok"};},{log(){},error(){}});
  await Promise.all(retained);
  assert.equal(refreshed,true);
});
