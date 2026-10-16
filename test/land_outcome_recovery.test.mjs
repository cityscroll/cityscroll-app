import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildZapOutcomeRecord, prewarmOneZapOutcome, refreshZapOutcomes, handleZapOutcomes, kvKey } from "../worker/src/zap_outcomes.mjs";
import * as phaseTools from "../site/land_phase_spine.mjs";
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
const source=readFileSync(new URL("../site/app/land.mjs",import.meta.url),"utf8");
function fn(name){
  const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start>=0,name);
  return source.slice(start,source.indexOf("\n}",start)+2);
}
function browser(){
  const c=vm.createContext({ Date, Map, Promise, console,
    escUiHtml:s=>String(s).replaceAll("<","&lt;"), normalizeLandRecord:r=>r,
    t:(key,args={})=>[key,...Object.values(args)].join(" "), fdate:s=>s,
    landPhaseLabel:p=>p.id||p.label_key, EXT_ATTRS:"",extSR:()=>"",
    landPipelinePositionHTML:()=>null, landStatutoryDeadlineHTML:()=>"",
    landPhaseAggregateHTML:a=>a.title,landSpineEventRowHTML:e=>e.title,
    landSpineLagHTML:()=>"",landSpineGapsHTML:()=>"",landZoningStatisticsHTML:()=>"",
    document:{contains:()=>true},ensureLandPhaseSpineTools:async()=>({}),
    paintProjectConnections:async()=>{},paintConnectedCalendar:()=>{},
    landOutcomesHTML:r=>`stage:${r.stage}`,landOutcomeSnapshotHTML:r=>`stage:${r.stage}`,
    bindLandSpineUI:()=>{},paintLandActionRail:()=>{},$:()=>null,
    ensureProjectConnectionsTools:async()=>({projectConnectionsPayloadState:()=>"available"}),
    landOutcomeRecordIsPresent:()=>true,reportLandOutcomesReady:()=>{},
    ZAP_OUTCOMES_MEM:new Map(),ZAP_OUTCOMES_MEM_TTL:300000,
  });
  vm.runInContext(["landOutcomeEvidenceState","landOutcomeFreshnessHTML","landOutcomeRecordForDisplay","landPhaseSpineHTML","seedLandOutcomeSnapshot","zapOutcomesMemGet","fetchZapOutcomesPayload","loadZapOutcomes"].map(fn).join("\n"),c);
  return c;
}

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
    const c=browser();
    const html=c.landPhaseSpineHTML(view,phaseTools,c.landOutcomeRecordForDisplay(payload));
    assert.match(html,/data-land-phase-panel="borough_president" data-land-phase-state="current"/);
    assert.match(html,/2026-10-06/);
    const compact=compactZapOutcomeRecord(record);
    assert.equal(compact.snapshot_state,"present");
    assert.deepEqual(compact.spine,record.spine);
    assert.equal(compact.generated_at,record.generated_at);
  }finally{globalThis.fetch=original;}
});

test("stale evidence keeps its vintage through new bundles, session reuse, failed load and recovery",async()=>{
  const c=browser();
  const record={project_id:"2026K0233",generated_at:"2026-09-28T00:00:00Z",filled:true,spine:{events:[]}};
  const payload={ok:true,stale:true,record};
  const snapshot=buildLandDefaultSnapshot([{project_id:record.project_id}],{outcomesByProject:{[record.project_id]:record}});
  c.seedLandOutcomeSnapshot(snapshot);
  assert.equal(c.landOutcomeRecordForDisplay(payload).evidence_stale,true);
  assert.match(c.landOutcomeFreshnessHTML(payload),/2026-09-28/);
  assert.match(c.landOutcomeFreshnessHTML(payload,{failed:true}),/land_outcome_update_failed/);
  c.ensureProjectConnectionsTools=async()=>({normalizeProjectConnectionsPayload:p=>p});
  c.workerFetch=async()=>new Response("blocked",{status:403});
  c.ZAP_OUTCOMES_MEM.get(record.project_id).at=Date.now()-c.ZAP_OUTCOMES_MEM_TTL-1;
  assert.equal(c.zapOutcomesMemGet(record.project_id).expired,true);
  assert.equal(await c.fetchZapOutcomesPayload(record.project_id,{allowStatic:false}),null);
  assert.equal(c.zapOutcomesMemGet(record.project_id).data.record.generated_at,record.generated_at);
  const fresh={...record,generated_at:new Date().toISOString()};
  c.workerFetch=async()=>new Response(JSON.stringify({ok:true,stale:false,record:fresh}));
  await c.fetchZapOutcomesPayload(record.project_id,{allowStatic:false});
  c.seedLandOutcomeSnapshot(snapshot);
  const recovered=c.zapOutcomesMemGet(record.project_id).data;
  assert.equal(recovered.record.generated_at,fresh.generated_at);
  assert.equal(c.landOutcomeFreshnessHTML(recovered),"");
});

test("expired live evidence revalidates and repaints retained stage after failure",async()=>{
  const c=browser();
  const id="2026K0233";
  const record={project_id:id,generated_at:new Date().toISOString(),stage:"borough_president",filled:true,spine:{events:[]}};
  c.ZAP_OUTCOMES_MEM.set(id,{data:{ok:true,record},at:Date.now()-c.ZAP_OUTCOMES_MEM_TTL-1});
  c.workerFetch=async()=>new Response("blocked",{status:403});
  const el={innerHTML:""};
  await c.loadZapOutcomes({project_id:id},el);
  assert.match(el.innerHTML,/land_outcome_update_failed/);
  assert.match(el.innerHTML,/stage:borough_president/);
  assert.equal(c.zapOutcomesMemGet(id).data.record.generated_at,record.generated_at);
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

test("partial required-source acquisitions retain the prior complete observation",async()=>{
  const original=globalThis.fetch;
  const id="PARTIAL1";
  const previous={project_id:id,join:{matched:true},generated_at:"2026-09-28T00:00:00Z",
    open_data:{project_id:id,project_name:"Retained"},city_record_notices:[{request_id:"retained"}]};
  const projectFixture=structuredClone(fixture);
  projectFixture.data.id=id;
  projectFixture.data.attributes["dcp-name"]=id;
  try{
    for(const unavailable of ["open-data","city-record"]){
      const rows=new Map([[kvKey(id),JSON.stringify(previous)]]);
      const env={ALERT_STATE:{get:async k=>rows.get(k)||null,put:async(k,v)=>rows.set(k,v)}};
      globalThis.fetch=async url=>{
        const value=String(url);
        if(value.includes("herokuapp.com")) return new Response(JSON.stringify(projectFixture));
        if(unavailable==="open-data"&&value.includes("hgx4-8ukb")) return new Response("blocked",{status:503});
        if(unavailable==="city-record"&&value.includes("dg92-zbpx")) return new Response("blocked",{status:503});
        return new Response(JSON.stringify(unavailable==="city-record"?[{
          project_id:id,project_name:"Fresh",ulurp_numbers:"C240046HAM",actions:"ZM",
        }]:[]));
      };
      const result=await prewarmOneZapOutcome(env,id,{force:true,
        build:projectId=>buildZapOutcomeRecord(projectId,{fetchBbl:false,lookupDoc:{rows:[]}})});
      assert.equal(result.status,"failed",unavailable);
      assert.deepEqual(JSON.parse(rows.get(kvKey(id))),previous,unavailable);
      assert.match(JSON.parse(rows.get(`${kvKey(id)}:attempt`)).reason,/source-unavailable/);
    }
    const rows=new Map();
    const env={ALERT_STATE:{get:async k=>rows.get(k)||null,put:async(k,v)=>rows.set(k,v)}};
    globalThis.fetch=async url=>String(url).includes("herokuapp.com")
      ? new Response(JSON.stringify(projectFixture)) : new Response("[]");
    const emptyResult=await prewarmOneZapOutcome(env,id,{force:true,
      build:projectId=>buildZapOutcomeRecord(projectId,{fetchBbl:false,lookupDoc:{rows:[]}})});
    assert.equal(emptyResult.status,"computed");
    assert.equal(JSON.parse(rows.get(kvKey(id))).project_id,id);
  }finally{globalThis.fetch=original;}
});

test("scheduled acquisition receipts preserve partial and held results",async()=>{
  const worker=readFileSync(new URL("../worker/src/worker.mjs",import.meta.url),"utf8");
  const start=worker.indexOf("async function withWorkerAcquisitionReceipt(");
  const receipts=[];
  const c=vm.createContext({Date,Number,recordSourceAcquisitionReceipt:async(_,r)=>receipts.push(r)});
  vm.runInContext(worker.slice(start,worker.indexOf("\n}",start)+2),c);
  for(const [status,expected] of [["failed","failed"],["partial","partial"],["skipped","held"],["ok","succeeded"]]){
    await c.withWorkerAcquisitionReceipt({},"zap-api-outcomes","test",async()=>({status,reason:"fixture"}));
    assert.equal(receipts.at(-1).status,expected);
  }
});

test("morning outcomes start independently even while another acquisition is stalled",async()=>{
  const src=readFileSync(new URL("../worker/src/worker.mjs",import.meta.url),"utf8");
  const start=src.indexOf("  async runScheduled(");
  const end=src.indexOf("\n  },",start);
  assert.ok(end>start);
  const retained=[];
  let refreshed=false;
  const c=vm.createContext({Date,Promise,console:{log(){},error(){}},
    refreshPublicSearchUsageSnapshot:async()=>({}),reconcileStaleDigestShadowRebuilds:async()=>{},
    withWorkerAcquisitionReceipt:async(_e,_s,_r,work)=>work(),
    refreshZapOutcomes:async()=>{refreshed=true;return {status:"ok"};},
    refreshMeetingOutcomes:()=>new Promise(()=>{}),
  });
  vm.runInContext(`const worker={${src.slice(start,end)}\n}}; globalThis.run=worker.runScheduled;`,c);
  c.run({cron:"0 8 * * *"},{},{waitUntil:p=>retained.push(p)});
  await Promise.all(retained);
  assert.equal(refreshed,true);
});
