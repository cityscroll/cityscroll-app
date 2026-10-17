import assert from "node:assert/strict";
import { test } from "node:test";
import { buildZapOutcomeRecord, prewarmOneZapOutcome, refreshZapOutcomes, handleZapOutcomes, kvKey, stampLandStageObservation } from "../worker/src/zap_outcomes.mjs";
import * as phaseTools from "../site/land_phase_spine.mjs";
import { createLandOutcomeRuntime } from "../site/land_outcome_runtime.mjs";
import { startMorningZapOutcomes, withWorkerAcquisitionReceipt } from "../worker/src/lib/worker_acquisition_runtime.mjs";
import { refreshZapProjectsLookup, ZAP_PROJECTS_LOOKUP_KV_KEY } from "../worker/src/zap_projects_lookup.mjs";
import { buildZapProjectsLookupDoc, committedZapProjectsLookupFloor } from "../worker/src/lib/zap_projects_lookup_kv.mjs";
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
const TEST_NOW="2026-10-16T20:00:00.000Z";
const TEST_NOW_MS=Date.parse(TEST_NOW);

function browser({now=()=>TEST_NOW_MS}={}){
  let response=async()=>new Response("blocked",{status:403});
  const runtime=createLandOutcomeRuntime({
    now,
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
  const record={project_id:"CLOCK1",generated_at:TEST_NOW,spine:{events:[]}};
  runtime.seed({generated_at:record.generated_at,outcomes:{by_project:{CLOCK1:record}}});
  assert.equal(runtime.get("CLOCK1").data.record,record);
});

test("notice refresh bypasses a warm static snapshot and retains it on failure",async()=>{
  const {runtime,setResponse}=browser();
  const id="STATIC1";
  const stale={project_id:id,generated_at:"2026-10-02T00:00:00Z",stage:"community_board",spine:{events:[]}};
  runtime.seed({generated_at:stale.generated_at,outcomes:{by_project:{[id]:stale}}});
  let requests=0;
  const fresh={...stale,generated_at:TEST_NOW,stage:"borough_president"};
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

test("browser retains newer stage evidence and accepts a genuinely newer observation",async()=>{
  const id="EVIDENCE1";
  const known="2026-10-15T20:00:00Z";
  for(const observed_at of ["2026-10-02T00:00:00Z",null]){
    const {runtime,setResponse}=browser();
    const retained={project_id:id,generated_at:known,stage:"community_board",spine:{events:[]},
      stage_observation:{source_system:"zap_projects_open_data",observed_at:known}};
    runtime.seed({generated_at:known,outcomes:{by_project:{[id]:retained}}});
    setResponse(async()=>new Response(JSON.stringify({ok:true,record:{...retained,generated_at:TEST_NOW,
      stage:"borough_president",stage_observation:{source_system:"zap_projects_open_data",observed_at}}})));
    const result=await runtime.refreshDisplay(id);
    assert.equal(result.record.stage,"community_board");
    assert.equal(runtime.cache.get(id).data.record.stage_observation.observed_at,known);
    assert.match(result.freshness,/land_outcome_stage_caution/);
  }

  const {runtime,setResponse}=browser();
  const older={project_id:id,generated_at:"2026-10-02T00:00:00Z",stage:"community_board",spine:{events:[]},
    stage_observation:{source_system:"zap_projects_open_data",observed_at:"2026-10-02T00:00:00Z"}};
  runtime.seed({generated_at:older.generated_at,outcomes:{by_project:{[id]:older}}});
  setResponse(async()=>new Response(JSON.stringify({ok:true,record:{...older,generated_at:TEST_NOW,
    stage:"borough_president",stage_observation:{source_system:"zap_project_api",observed_at:TEST_NOW}}})));
  const recovered=await runtime.refreshDisplay(id);
  assert.equal(recovered.record.stage,"borough_president");
  assert.equal(runtime.cache.get(id).data.record.stage_observation.observed_at,TEST_NOW);
});

test("static seed replacement follows the stage evidence clock",()=>{
  const {runtime}=browser();
  const id="SEED1",known="2026-10-15T20:00:00Z";
  const record={project_id:id,generated_at:known,stage:"community_board",spine:{events:[]},
    stage_observation:{source_system:"zap_projects_open_data",observed_at:known}};
  runtime.seed({generated_at:known,outcomes:{by_project:{[id]:record}}});
  runtime.seed({generated_at:TEST_NOW,outcomes:{by_project:{[id]:{...record,generated_at:TEST_NOW,
    stage:"borough_president",stage_observation:{source_system:"zap_projects_open_data",observed_at:null}}}}});
  assert.equal(runtime.get(id).data.record.stage,"community_board");

  const newer="2026-10-17T20:00:00Z";
  runtime.seed({generated_at:newer,outcomes:{by_project:{[id]:{...record,generated_at:newer,
    stage:"borough_president",stage_observation:{source_system:"zap_project_api",observed_at:newer}}}}});
  assert.equal(runtime.get(id).data.record.stage,"borough_president");
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
    const compact=compactZapOutcomeRecord(record);
    assert.equal(compact.snapshot_state,"present");
    assert.deepEqual(compact.spine,record.spine);
    assert.deepEqual(compact.source_observations,record.source_observations);
    assert.deepEqual(compact.stage_observation,record.stage_observation);
    assert.equal(phaseTools.buildLandPhaseView(compact.spine,compact).current.phase_id,view.current.phase_id);
    assert.equal(compact.generated_at,record.generated_at);
    assert.equal(record.stage_observation.source_system,"zap_project_api");
    assert.equal(runtime.evidenceState(payload).stale,false);
    const mixed=stampLandStageObservation({...record,source_observations:{...record.source_observations,
      open_data:{...record.source_observations.open_data,observed_at:"2026-10-02T00:00:00Z"}}});
    assert.equal(mixed.stage_observation.source_system,"zap_project_api");
    assert.equal(runtime.evidenceState({record:mixed}).stale,false);
  }finally{globalThis.fetch=original;}
});

test("compact outcomes preserve Open Data-only phase evidence",()=>{
  const record={
    project_id:"OPEN-DATA-PHASE",
    public_status:"In Public Review",
    spine:{events:[]},
    open_data:{
      project_id:"OPEN-DATA-PHASE",
      public_status:"In Public Review",
      current_milestone:"Community Board Referral",
      current_milestone_date:"2026-10-02T00:00:00Z",
      ulurp_non:"ULURP",
      source_observation:{source_system:"zap_projects_open_data",observed_at:"2026-10-02T00:00:00Z"},
      lookup_path:"warehouse",
      project_name:"not needed by the phase renderer",
    },
    source_observations:{open_data:{source_system:"zap_projects_open_data",observed_at:"2026-10-02T00:00:00Z"}},
    stage_observation:{source_system:"zap_projects_open_data",observed_at:"2026-10-02T00:00:00Z"},
    generated_at:TEST_NOW,
  };
  const compact=compactZapOutcomeRecord(record);
  assert.equal(phaseTools.buildLandPhaseView(record.spine,record).current.phase_id,"community_board");
  assert.equal(phaseTools.buildLandPhaseView(compact.spine,compact).current.phase_id,"community_board");
  assert.deepEqual(compact.open_data.source_observation,record.open_data.source_observation);
  assert.equal(compact.open_data.lookup_path,"warehouse");
  assert.equal(Object.hasOwn(compact.open_data,"project_name"),false);
});

test("display freshness follows the source that selects the current stage",()=>{
  const old="2026-10-02T00:00:00Z";
  const base={project_id:"CLOCK2",generated_at:TEST_NOW,join:{matched:true},source_observations:{
    zap_api:{source_system:"zap_project_api",observed_at:TEST_NOW},
    open_data:{source_system:"zap_projects_open_data",observed_at:old},
  }};
  const openDataOnly=stampLandStageObservation({...base,open_data:{project_id:"CLOCK2",current_milestone:"Community Board Referral"},spine:{events:[]}});
  const {runtime}=browser();
  assert.equal(openDataOnly.stage_observation.source_system,"zap_projects_open_data");
  assert.equal(openDataOnly.stage_observation.observed_at,old);
  assert.equal(runtime.evidenceState({record:openDataOnly}).stale,true);
  const unknown=stampLandStageObservation({...base,source_observations:{open_data:{source_system:"zap_projects_open_data",observed_at:null}},open_data:{project_id:"CLOCK2",current_milestone:"Community Board Referral"},spine:{events:[]}});
  assert.equal(runtime.evidenceState({record:unknown}).observedAt,null);
  assert.equal(runtime.evidenceState({record:unknown}).stale,true);
});

test("materialized stage clocks preserve lookup, SODA, ZAP, and Noticed provenance",async()=>{
  const original=globalThis.fetch;
  const id="CLOCK3";
  const thin={data:{id,type:"projects",attributes:{"dcp-name":id,"dcp-projectname":"Clock Project"}},included:[]};
  const row={project_id:id,project_name:"Clock Project",public_status:"In Public Review",current_milestone:"Community Board Referral"};
  let sodaRows=[];
  globalThis.fetch=async url=>{
    const value=String(url);
    if(value.includes("herokuapp.com"))return new Response(JSON.stringify(thin));
    if(value.includes("hgx4-8ukb"))return new Response(JSON.stringify(sodaRows));
    return new Response("[]");
  };
  try{
    const old="2026-09-01T00:00:00Z";
    const stale=await buildZapOutcomeRecord(id,{fetchBbl:false,lookupDoc:{materialized_at:old,rows:[row]}});
    assert.equal(stale.source_observations.open_data.observed_at,old);
    assert.equal(stale.stage_observation.observed_at,old);
    const snapshot=buildLandDefaultSnapshot([{project_id:id}],{outcomesByProject:{[id]:stale}});
    const {runtime}=browser();
    runtime.seed(snapshot);
    const cached=runtime.get(id).data;
    assert.equal(cached.record.stage_observation.observed_at,old);
    assert.equal(runtime.evidenceState(cached).stale,true);
    assert.match(runtime.freshnessHTML(cached),/2026-09-01/);

    const freshLookup=await buildZapOutcomeRecord(id,{fetchBbl:false,lookupDoc:{materialized_at:TEST_NOW,rows:[{
      ...row,environmental_projection:{as_of:old},authority_summary:{freshness:{as_of:old}},
    }]}});
    assert.equal(freshLookup.source_observations.open_data.observed_at,TEST_NOW);
    assert.equal(freshLookup.stage_observation.observed_at,TEST_NOW);

    const unknown=await buildZapOutcomeRecord(id,{fetchBbl:false,lookupDoc:{rows:[row]}});
    assert.equal(unknown.source_observations.open_data.observed_at,null);
    assert.equal(unknown.stage_observation.observed_at,null);

    const noticed=await buildZapOutcomeRecord(id,{fetchBbl:false,lookupDoc:{materialized_at:TEST_NOW,rows:[{
      ...row,public_status:"Noticed",current_milestone:null,
    }]}});
    assert.equal(phaseTools.buildLandPhaseView(noticed.spine,noticed).current.phase_id,"pre_certification");
    assert.equal(noticed.stage_observation.source_system,"zap_projects_open_data");
    assert.equal(noticed.stage_observation.observed_at,TEST_NOW);

    const detailed=structuredClone(fixture);
    detailed.data.id=id;
    detailed.data.attributes["dcp-name"]=id;
    globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes("herokuapp.com")?detailed:[]));
    const freshZap=await buildZapOutcomeRecord(id,{fetchBbl:false,lookupDoc:{materialized_at:old,rows:[row]}});
    assert.equal(phaseTools.buildLandPhaseView(freshZap.spine,freshZap).current.phase_id,"borough_president");
    assert.equal(freshZap.stage_observation.source_system,"zap_project_api");
    assert.notEqual(freshZap.stage_observation.observed_at,old);

    sodaRows=[row];
    globalThis.fetch=async url=>{
      const value=String(url);
      if(value.includes("herokuapp.com"))return new Response(JSON.stringify(thin));
      if(value.includes("hgx4-8ukb"))return new Response(JSON.stringify(sodaRows));
      return new Response("[]");
    };
    const direct=await buildZapOutcomeRecord(id,{fetchBbl:false,lookupDoc:{rows:[]},now:()=>TEST_NOW});
    assert.equal(direct.source_observations.open_data.observed_at,TEST_NOW);
    assert.equal(direct.stage_observation.observed_at,direct.source_observations.open_data.observed_at);
  }finally{globalThis.fetch=original;}
});

test("lookup refresh retains seeded clocks and observes reacquired rows",async()=>{
  const original=globalThis.fetch;
  const values=new Map();
  const env={ALERT_STATE:{
    get:async key=>values.get(key)||null,
    put:async(key,value)=>values.set(key,value),
  }};
  const seedId="2025Q0331";
  const freshId="2026K0123";
  const retainedFloorClock = committedZapProjectsLookupFloor().materialized_at;
  // Browser clock must sit more than 24h after the retained floor so seed evidence
  // is stale while a same-cycle reacquire stays fresh.
  const browserNowMs = Date.parse(retainedFloorClock) + 25 * 60 * 60 * 1000;
  const browserNowIso = new Date(browserNowMs).toISOString();
  const retainedDay = retainedFloorClock.slice(0, 10);
  const rows=[
    {project_id:freshId,project_name:"1550 Bedford Avenue Rezoning",public_status:"Filed",current_milestone:"Review Filed Land Use Application"},
    {project_id:"2022M0258",project_name:"Demo",public_status:"Active"},
    ...Array.from({length:108},(_,index)=>({
      project_id:`2026X${String(index+1).padStart(4,"0")}`,
      project_name:`Project ${index+1}`,
      public_status:"Filed",
    })),
  ];
  const thin=id=>({data:{id,type:"projects",attributes:{"dcp-name":id,"dcp-projectname":id}},included:[]});
  globalThis.fetch=async url=>{
    const value=String(url);
    if(value.includes("hgx4-8ukb.json"))return new Response(JSON.stringify(rows));
    if(value.includes("herokuapp.com"))return new Response(JSON.stringify(thin(value.split("/").pop())));
    return new Response("[]");
  };
  try{
    const refreshed=await refreshZapProjectsLookup(env,{fetchImpl:globalThis.fetch,now:new Date(browserNowIso)});
    assert.equal(refreshed.status,"success");
    const lookup=JSON.parse(values.get(ZAP_PROJECTS_LOOKUP_KV_KEY));
    const seeded=lookup.rows.find(row=>row.project_id===seedId);
    const reacquired=lookup.rows.find(row=>row.project_id===freshId);
    assert.equal(seeded.source_observation.observation_status,"retained");
    assert.equal(seeded.source_observation.observed_at, retainedFloorClock);
    assert.equal(reacquired.source_observation.observation_status,"observed");
    assert.equal(reacquired.source_observation.observed_at,browserNowIso);

    const stale=await buildZapOutcomeRecord(seedId,{fetchBbl:false,lookupDoc:lookup,now:()=>browserNowIso});
    const fresh=await buildZapOutcomeRecord(freshId,{fetchBbl:false,lookupDoc:lookup,now:()=>browserNowIso});
    assert.equal(stale.source_observations.open_data.observed_at, retainedFloorClock);
    assert.equal(stale.stage_observation.observed_at, retainedFloorClock);
    assert.equal(fresh.source_observations.open_data.observed_at,browserNowIso);
    assert.equal(fresh.stage_observation.observed_at,browserNowIso);

    const snapshot=buildLandDefaultSnapshot(
      [{project_id:seedId},{project_id:freshId}],
      {outcomesByProject:{[seedId]:stale,[freshId]:fresh}},
    );
    const {runtime}=browser({now:()=>browserNowMs});
    runtime.seed(snapshot);
    assert.equal(runtime.evidenceState(runtime.get(seedId).data).stale,true);
    assert.match(runtime.freshnessHTML(runtime.get(seedId).data), new RegExp(retainedDay));
    assert.equal(runtime.evidenceState(runtime.get(freshId).data).stale,false);
  }finally{globalThis.fetch=original;}
});

test("legacy carried lookup rows remain unknown while the committed floor keeps its clock",async()=>{
  const original=globalThis.fetch;
  const id="2022M0258";
  const thin={data:{id,type:"projects",attributes:{"dcp-name":id,"dcp-projectname":"Legacy Project"}},included:[]};
  globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes("herokuapp.com")?thin:[]));
  try{
    const legacy=buildZapProjectsLookupDoc([],{now:TEST_NOW,floor:{
      materialized_at:"2026-09-01T00:00:00Z",
      rows:[{project_id:id,project_name:"Legacy Project",public_status:"In Public Review",current_milestone:"Community Board Referral"}],
    }});
    for(const row of legacy.rows)delete row.source_observation;
    const ambiguous=await buildZapOutcomeRecord(id,{fetchBbl:false,lookupDoc:legacy,now:()=>TEST_NOW});
    assert.equal(ambiguous.join.matched,true);
    assert.equal(ambiguous.source_observations.open_data.observed_at,null);
    assert.equal(ambiguous.stage_observation.observed_at,null);
    assert.equal(browser().runtime.evidenceState({record:ambiguous}).stale,true);

    const floor=committedZapProjectsLookupFloor();
    const committed=await buildZapOutcomeRecord(id,{fetchBbl:false,lookupDoc:floor,now:()=>TEST_NOW});
    assert.equal(committed.source_observations.open_data.observed_at,floor.materialized_at);
  }finally{globalThis.fetch=original;}
});

test("empty SODA lookup retains cached evidence with a failed attempt receipt",async()=>{
  const original=globalThis.fetch;
  const id="EMPTY1";
  const cached={project_id:id,project_name:"Cached Project",generated_at:"2026-09-28T00:00:00Z",
    join:{matched:true},open_data:{project_id:id,current_milestone:"Community Board Referral"},
    source_observations:{open_data:{source_system:"zap_projects_open_data",acquisition_status:"ok",
      observation_status:"observed",observed_at:"2026-09-28T00:00:00Z"}}};
  const values=new Map([[kvKey(id),JSON.stringify(cached)]]);
  const env={ALERT_STATE:{get:async key=>values.get(key)||null,put:async(key,value)=>values.set(key,value)}};
  const thin={data:{id,type:"projects",attributes:{"dcp-name":id,"dcp-projectname":"Thin Project"}},included:[]};
  globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes("herokuapp.com")?thin:[]));
  try{
    const candidate=await buildZapOutcomeRecord(id,{fetchBbl:false,lookupDoc:{rows:[]},now:()=>TEST_NOW});
    assert.equal(candidate.join.matched,true);
    assert.equal(candidate.source_observations.open_data.acquisition_status,"unavailable");
    assert.equal(candidate.source_observations.open_data.observed_at,null);
    const result=await prewarmOneZapOutcome(env,id,{force:true,nowMs:TEST_NOW_MS,build:async()=>candidate});
    assert.equal(result.status,"failed");
    assert.equal(result.reason,"source-unavailable:open_data");
    assert.deepEqual(JSON.parse(values.get(kvKey(id))),cached);
    const attempt=JSON.parse(values.get(`${kvKey(id)}:attempt`));
    assert.equal(attempt.status,"failed");
    assert.equal(attempt.retained_generated_at,cached.generated_at);
  }finally{globalThis.fetch=original;}
});

test("prewarm retains newer stage evidence and accepts fresh authoritative ZAP progress",async()=>{
  const id="2026K0233";
  const cached={project_id:id,generated_at:"2026-10-15T20:00:00Z",join:{matched:true},stage:"community_board",
    stage_observation:{source_system:"zap_projects_open_data",observed_at:"2026-10-15T20:00:00Z"}};
  for(const observed_at of [null,"2026-10-02T00:00:00Z"]){
    const values=new Map([[kvKey(id),JSON.stringify(cached)]]);
    const env={ALERT_STATE:{get:async key=>values.get(key)||null,put:async(key,value)=>values.set(key,value)}};
    const candidate={project_id:id,generated_at:TEST_NOW,join:{matched:true},stage:"community_board",
      stage_observation:{source_system:"zap_projects_open_data",observed_at}};
    const result=await prewarmOneZapOutcome(env,id,{force:true,nowMs:TEST_NOW_MS,build:async()=>candidate});
    assert.equal(result.status,"failed");
    assert.equal(result.reason,"stage-evidence-regressed");
    assert.deepEqual(JSON.parse(values.get(kvKey(id))),cached);
    assert.equal(JSON.parse(values.get(`${kvKey(id)}:attempt`)).status,"failed");
  }

  const original=globalThis.fetch;
  const values=new Map([[kvKey(id),JSON.stringify({...cached,generated_at:"2026-10-02T00:00:00Z",
    stage_observation:{...cached.stage_observation,observed_at:"2026-10-02T00:00:00Z"}})]]);
  const env={ALERT_STATE:{get:async key=>values.get(key)||null,put:async(key,value)=>values.set(key,value)}};
  globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes("herokuapp.com")?fixture:[]));
  try{
    const row={project_id:id,project_name:"240 Nassau Street",public_status:"In Public Review",current_milestone:"Community Board Referral"};
    const result=await prewarmOneZapOutcome(env,id,{force:true,nowMs:TEST_NOW_MS,
      build:projectId=>buildZapOutcomeRecord(projectId,{fetchBbl:false,lookupDoc:{materialized_at:"2026-09-01T00:00:00Z",rows:[row]},now:()=>TEST_NOW})});
    assert.equal(result.status,"computed");
    const stored=JSON.parse(values.get(kvKey(id)));
    assert.equal(stored.stage_observation.source_system,"zap_project_api");
    assert.equal(stored.stage_observation.observed_at,TEST_NOW);
  }finally{globalThis.fetch=original;}
});

test("prewarm retains richer ZAP evidence without renewing carried clocks",async()=>{
  const id="RICH1",old="2026-10-02T00:00:00Z";
  const cached={project_id:id,generated_at:old,join:{matched:true},useful:true,filled:true,
    actions:[{id:"action-old",action:"ZM",approved:true}],approved_actions:[{id:"action-old",action:"ZM",approved:true}],
    milestones:[{id:"milestone-old",title:"Community Board Review",status:"Completed",time:{value:"2026-10-01",precision:"day",basis:"actual_end",certainty:"actual"}}],
    dispositions:[],documents:[{id:"document-old",name:"Decision"}],n_documents:1,n_dispositions:0,n_approved_actions:1,
    spine:{events:[{id:"zap-milestone:milestone-old",title:"Community Board Review"}]},
    source_observations:{zap_api:{source_system:"zap_project_api",observation_status:"observed",observed_at:old}},
    stage_observation:{source_system:"zap_project_api",observed_at:old}};
  const values=new Map([[kvKey(id),JSON.stringify(cached)]]);
  const env={ALERT_STATE:{get:async key=>values.get(key)||null,put:async(key,value)=>values.set(key,value)}};
  const thin={project_id:id,generated_at:TEST_NOW,join:{matched:true},useful:false,filled:false,
    actions:[],approved_actions:[],milestones:[],dispositions:[],documents:[],n_documents:0,
    open_data:{project_id:id,public_status:"In Public Review",current_milestone:"Community Board Referral"},
    source_observations:{
      zap_api:{source_system:"zap_project_api",observation_status:"observed",observed_at:TEST_NOW},
      open_data:{source_system:"zap_projects_open_data",observation_status:"observed",observed_at:TEST_NOW},
    },
    stage_observation:{source_system:"zap_projects_open_data",observed_at:TEST_NOW}};
  const result=await prewarmOneZapOutcome(env,id,{force:true,nowMs:TEST_NOW_MS,build:async()=>thin});
  assert.equal(result.status,"computed");
  assert.deepEqual(result.partial_sources,["zap_api"]);
  const stored=JSON.parse(values.get(kvKey(id)));
  assert.equal(stored.documents[0].id,"document-old");
  assert.equal(stored.documents[0].source_observation.observed_at,old);
  assert.equal(stored.actions[0].source_observation.observed_at,old);
  assert.equal(stored.stage_observation.observed_at,TEST_NOW);
  assert.equal(stored.stage_observation.source_system,"zap_projects_open_data");
  assert.equal(stored.source_observations.zap_api.observed_at,TEST_NOW);
  assert.equal(stored.source_observations.zap_api.retained_observed_at,old);

  const advancing={...thin,generated_at:"2026-10-17T00:00:00Z",
    milestones:[{id:"milestone-new",title:"Borough President Review",status:"In Progress",time:{value:"2026-10-17",precision:"day",basis:"actual_start",certainty:"actual"}}],
    source_observations:{zap_api:{source_system:"zap_project_api",observation_status:"observed",observed_at:"2026-10-17T00:00:00Z"}},
    stage_observation:{source_system:"zap_project_api",observed_at:"2026-10-17T00:00:00Z"}};
  await prewarmOneZapOutcome(env,id,{force:true,nowMs:Date.parse("2026-10-17T00:00:00Z"),build:async()=>advancing});
  const advanced=JSON.parse(values.get(kvKey(id)));
  assert.equal(advanced.documents[0].source_observation.observed_at,old);
  assert.equal(advanced.stage_observation.observed_at,"2026-10-17T00:00:00Z");
});

test("retained ZAP phases keep their selecting evidence clock",async()=>{
  const old="2026-10-02T00:00:00Z";
  const milestone=(id,title,status,date)=>({id,title,status,time:{value:date,precision:"day",basis:"actual_start",certainty:"actual"}});
  const run=async({id,cachedMilestone,candidateMilestone,legacy=false})=>{
    const cached={project_id:id,generated_at:old,join:{matched:true},useful:false,filled:false,
      actions:[],approved_actions:[],milestones:[cachedMilestone],dispositions:[],documents:[],n_documents:0,
      source_observations:legacy?{}:{zap_api:{source_system:"zap_project_api",observation_status:"observed",observed_at:old}},
      ...(legacy?{}:{stage_observation:{source_system:"zap_project_api",observed_at:old}})};
    const values=new Map([[kvKey(id),JSON.stringify(cached)]]);
    const env={ALERT_STATE:{get:async key=>values.get(key)||null,put:async(key,value)=>values.set(key,value)}};
    const candidate={project_id:id,generated_at:TEST_NOW,join:{matched:true},useful:false,filled:false,
      actions:[],approved_actions:[],milestones:[candidateMilestone],dispositions:[],documents:[],n_documents:0,
      source_observations:{zap_api:{source_system:"zap_project_api",observation_status:"observed",observed_at:TEST_NOW}},
      stage_observation:{source_system:"zap_project_api",observed_at:TEST_NOW}};
    const result=await prewarmOneZapOutcome(env,id,{force:true,nowMs:TEST_NOW_MS,build:async()=>candidate});
    assert.equal(result.status,"computed");
    const response=await handleZapOutcomes(new Request(`https://example.test/zap-outcomes?id=${id}`),env);
    const payload=await response.json();
    assert.equal(payload.record.stage_observation.source_system,"zap_project_api");
    assert.equal(payload.record.stage_observation.observed_at,legacy?null:old);
    assert.equal(payload.stale,true);
    assert.equal(browser().runtime.evidenceState(payload).stale,true);
    return payload.record;
  };
  const later=await run({id:"RETAINED-LATER",
    cachedMilestone:milestone("cpc-old","City Planning Commission Review","In Progress","2026-10-02"),
    candidateMilestone:milestone("cb-new","Community Board Review","In Progress","2026-10-16")});
  assert.equal(phaseTools.buildLandPhaseView(later.spine,later).current.phase_id,"cpc");
  const same=await run({id:"RETAINED-SAME",
    cachedMilestone:milestone("bp-old","Borough President Review","In Progress","2026-10-02"),
    candidateMilestone:milestone("bp-new","Borough President Review","Completed","2026-10-16")});
  assert.equal(phaseTools.buildLandPhaseView(same.spine,same).current.phase_id,"borough_president");
  await run({id:"RETAINED-LEGACY",legacy:true,
    cachedMilestone:milestone("cpc-legacy","City Planning Commission Review","In Progress","2026-10-02"),
    candidateMilestone:milestone("cb-current","Community Board Review","In Progress","2026-10-16")});
});

test("retained dispositions preserve hearing logistics and current IDs win",async()=>{
  const id="HEARING-RETAIN",old="2026-10-02T00:00:00Z";
  const disposition={id:"disp-1",name:"CPC Hearing",representing:"City Planning Commission",
    status:"Scheduled",hearing_date:"2026-10-20",hearing_at:"2026-10-20T13:30:00.000Z",
    hearing_location:"In person at 120 Broadway or livestreamed at https://youtube.com/watch?v=abc"};
  const cached={project_id:id,generated_at:old,join:{matched:true},useful:false,filled:false,
    actions:[],approved_actions:[],milestones:[],dispositions:[disposition],documents:[{id:"hearing-doc",name:"Hearing notice"}],n_documents:1,
    source_observations:{zap_api:{source_system:"zap_project_api",observation_status:"observed",observed_at:old}},
    stage_observation:{source_system:"zap_projects_open_data",observed_at:old}};
  const values=new Map([[kvKey(id),JSON.stringify(cached)]]);
  const env={ALERT_STATE:{get:async key=>values.get(key)||null,put:async(key,value)=>values.set(key,value)}};
  const candidate={project_id:id,generated_at:TEST_NOW,join:{matched:true},useful:false,filled:false,
    actions:[],approved_actions:[],milestones:[],dispositions:[],documents:[],n_documents:0,
    open_data:{project_id:id,public_status:"In Public Review",current_milestone:"Community Board Referral"},
    source_observations:{zap_api:{source_system:"zap_project_api",observation_status:"observed",observed_at:TEST_NOW},
      open_data:{source_system:"zap_projects_open_data",observation_status:"observed",observed_at:TEST_NOW}},
    stage_observation:{source_system:"zap_projects_open_data",observed_at:TEST_NOW}};
  await prewarmOneZapOutcome(env,id,{force:true,nowMs:TEST_NOW_MS,build:async()=>candidate});
  let response=await handleZapOutcomes(new Request(`https://example.test/zap-outcomes?id=${id}`),env);
  let payload=await response.json();
  let logistics=payload.record.hearing_logistics[0];
  assert.equal(logistics.venue_address,"120 Broadway");
  assert.equal(logistics.hearing_at,"2026-10-20T13:30:00.000Z");
  assert.match(logistics.livestream_url,/youtube\.com/);
  assert.equal(logistics.source_observation.observed_at,old);
  assert.equal(browser().runtime.recordForDisplay(payload).hearing_logistics[0].venue_address,"120 Broadway");

  const currentDisposition={...disposition,hearing_location:"In person at 22 Reade Street",hearing_at:"2026-10-21T14:00:00.000Z",hearing_date:"2026-10-21"};
  const current={...candidate,generated_at:"2026-10-17T00:00:00Z",dispositions:[currentDisposition],
    source_observations:{zap_api:{source_system:"zap_project_api",observation_status:"observed",observed_at:"2026-10-17T00:00:00Z"},
      open_data:{source_system:"zap_projects_open_data",observation_status:"observed",observed_at:"2026-10-17T00:00:00Z"}},
    stage_observation:{source_system:"zap_projects_open_data",observed_at:"2026-10-17T00:00:00Z"}};
  await prewarmOneZapOutcome(env,id,{force:true,nowMs:Date.parse("2026-10-17T00:00:00Z"),build:async()=>current});
  response=await handleZapOutcomes(new Request(`https://example.test/zap-outcomes?id=${id}`),env);
  payload=await response.json();
  logistics=payload.record.hearing_logistics[0];
  assert.equal(logistics.venue_address,"22 Reade Street");
  assert.equal(logistics.hearing_at,"2026-10-21T14:00:00.000Z");
  assert.equal(Object.hasOwn(logistics,"source_observation"),false);
});

test("DOB and BBL failures retain only affected prior side-car evidence",async()=>{
  const original=globalThis.fetch;
  const old="2026-10-02T00:00:00Z",bbl="3001230001";
  const failureResponse=kind=>{
    if(kind==="throw")throw new Error("network unavailable");
    if(kind==="malformed")return new Response("{");
    return new Response(JSON.stringify({error:"unavailable"}));
  };
  const run=async(source,kind,index)=>{
    const id=`2099K${String(index).padStart(4,"0")}`;
    const cached={project_id:id,generated_at:old,join:{matched:true},bbls:[bbl],
      dob:{matched:true,method:"exact_bbl",filings:[{job_filing_number:"OLD-1",bbl}],reason:null},
      source_observations:{
        bbl:{source_system:"zap_bbl_open_data",observation_status:"observed",observed_at:old},
        dob:{source_system:"dob_now",observation_status:"observed",observed_at:old},
      }};
    const values=new Map([[kvKey(id),JSON.stringify(cached)]]);
    const env={ALERT_STATE:{get:async key=>values.get(key)||null,put:async(key,value)=>values.set(key,value)}};
    const thin={data:{id,type:"projects",attributes:{"dcp-name":id,"dcp-projectname":id}},included:[]};
    globalThis.fetch=async url=>{
      const value=String(url);
      if(value.includes("herokuapp.com"))return new Response(JSON.stringify(thin));
      if(value.includes("2iga-a6mk"))return source==="bbl"?failureResponse(kind):new Response(JSON.stringify([{bbl}]));
      if(value.includes("w9ak-ipjd"))return source==="dob"?failureResponse(kind):new Response(JSON.stringify([]));
      return new Response(JSON.stringify([]));
    };
    const lookupDoc={source:"soda",materialized_at:TEST_NOW,rows:[{project_id:id,public_status:"In Public Review",current_milestone:"Community Board Referral",
      source_observation:{source_system:"zap_projects_open_data",observation_status:"observed",observed_at:TEST_NOW}}]};
    const result=await prewarmOneZapOutcome(env,id,{force:true,nowMs:TEST_NOW_MS,
      build:projectId=>buildZapOutcomeRecord(projectId,{lookupDoc,now:()=>TEST_NOW})});
    assert.equal(result.status,"computed");
    const stored=JSON.parse(values.get(kvKey(id)));
    assert.equal(stored.dob.filings[0].job_filing_number,"OLD-1");
    assert.equal(stored.source_observations[source].observation_status,"retained");
    assert.equal(stored.source_observations[source].observed_at,old);
    assert.ok(result.partial_sources.includes(source));
    if(source==="dob")assert.equal(stored.source_observations.bbl.observation_status,"observed");
  };
  try{
    let index=1;
    for(const source of ["bbl","dob"]){
      for(const kind of ["shape","throw","malformed"])await run(source,kind,index++);
    }
  }finally{globalThis.fetch=original;}
});

test("observed empty BBL and DOB responses clear prior side-car evidence",async()=>{
  const original=globalThis.fetch;
  const old="2026-10-02T00:00:00Z",bbl="3001230001";
  try{
    for(const emptySource of ["bbl","dob"]){
      const id=emptySource==="bbl"?"2099K0101":"2099K0102";
      const cached={project_id:id,generated_at:old,join:{matched:true},bbls:[bbl],
        dob:{matched:true,method:"exact_bbl",filings:[{job_filing_number:"OLD-1",bbl}],reason:null},
        source_observations:{dob:{source_system:"dob_now",observation_status:"observed",observed_at:old}}};
      const values=new Map([[kvKey(id),JSON.stringify(cached)]]);
      const env={ALERT_STATE:{get:async key=>values.get(key)||null,put:async(key,value)=>values.set(key,value)}};
      const thin={data:{id,type:"projects",attributes:{"dcp-name":id,"dcp-projectname":id}},included:[]};
      globalThis.fetch=async url=>{
        const value=String(url);
        if(value.includes("herokuapp.com"))return new Response(JSON.stringify(thin));
        if(value.includes("2iga-a6mk"))return new Response(JSON.stringify(emptySource==="bbl"?[]:[{bbl}]));
        if(value.includes("w9ak-ipjd"))return new Response(JSON.stringify([]));
        return new Response(JSON.stringify([]));
      };
      const lookupDoc={source:"soda",materialized_at:TEST_NOW,rows:[{project_id:id,public_status:"In Public Review",current_milestone:"Community Board Referral",
        source_observation:{source_system:"zap_projects_open_data",observation_status:"observed",observed_at:TEST_NOW}}]};
      const result=await prewarmOneZapOutcome(env,id,{force:true,nowMs:TEST_NOW_MS,
        build:projectId=>buildZapOutcomeRecord(projectId,{lookupDoc,now:()=>TEST_NOW})});
      assert.equal(result.status,"computed");
      const stored=JSON.parse(values.get(kvKey(id)));
      assert.equal(stored.dob.filings.length,0);
      assert.equal(stored.source_observations[emptySource].observation_status,"observed");
      assert.ok(!result.partial_sources.includes(emptySource));
    }
  }finally{globalThis.fetch=original;}
});

test("public outcome staleness follows the stage evidence clock",async()=>{
  const id="STALEAPI1";
  const record={project_id:id,generated_at:TEST_NOW,join:{matched:true},
    stage_observation:{source_system:"zap_projects_open_data",observed_at:"2026-09-30T00:00:00Z"}};
  const values=new Map([[kvKey(id),JSON.stringify(record)]]);
  const env={ALERT_STATE:{get:async key=>values.get(key)||null}};
  const response=await handleZapOutcomes(new Request(`https://example.test/zap-outcomes?id=${id}`),env);
  assert.equal(response.status,200);
  const payload=await response.json();
  assert.equal(payload.stale,true);
  assert.equal(payload.record.stage_observation.observed_at,"2026-09-30T00:00:00Z");
});

test("raw completed hearing remains CPC progress until the publisher vote",async()=>{
  const original=globalThis.fetch;
  const completedHearing=structuredClone(fixture);
  const milestone=name=>completedHearing.included.find(item=>item.attributes?.milestonename===name).attributes;
  Object.assign(milestone("Borough President Referral"),{
    statuscode:"Completed",
    "dcp-actualenddate":"2026-11-03T04:00:00.000Z",
  });
  Object.assign(milestone("CPC Public Meeting - Public Hearing"),{
    statuscode:"Completed",
    "dcp-actualstartdate":"2026-11-11T04:00:00.000Z",
    "dcp-actualenddate":"2026-11-13T04:00:00.000Z",
  });
  globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes("herokuapp.com")?completedHearing:[]));
  try{
    const record=await buildZapOutcomeRecord("2026K0233",{fetchBbl:false});
    const hearing=record.spine.events.find(event=>event.id.startsWith("zap-milestone:2abdc83a"));
    assert.equal(hearing.title,"City Planning Commission Review");
    assert.equal(hearing.source_title,"CPC Public Meeting - Public Hearing");
    assert.equal(hearing.status,"Completed");
    const view=phaseTools.buildLandPhaseView(record.spine,record);
    assert.equal(view.current.phase_id,"cpc");
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
  runtime.cache.get(record.project_id).at=TEST_NOW_MS-runtime.ttlMs-1;
  assert.equal(runtime.get(record.project_id).expired,true);
  assert.equal(await runtime.fetch(record.project_id,{allowStatic:false}),null);
  const failedDisplay=runtime.display(null,{fallback:runtime.get(record.project_id).data,failed:true});
  assert.match(failedDisplay.freshness,/land_outcome_update_failed/);
  assert.equal(failedDisplay.record.generated_at,record.generated_at);
  const fresh={...record,generated_at:TEST_NOW};
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
  const record={project_id:id,generated_at:TEST_NOW,stage:"borough_president",filled:true,spine:{events:[]}};
  runtime.cache.set(id,{data:{ok:true,record},at:TEST_NOW_MS-runtime.ttlMs-1});
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

test("morning outcomes await one same-cycle lookup and survive its failure",async()=>{
  const retained=[];
  const order=[];
  const env={ALERT_STATE:{put:async()=>{}}};
  let releaseUnrelated,unrelatedDone=false;
  const unrelated=new Promise(resolve=>{releaseUnrelated=resolve;}).then(()=>{unrelatedDone=true;});
  let release;
  const lookup=new Promise(resolve=>{release=resolve;});
  startMorningZapOutcomes({waitUntil:p=>retained.push(p)},env,"test",
    async()=>{order.push("outcomes");return {status:"ok"};},{log(){},error(){}},
    async()=>{order.push("lookup");await lookup;});
  await Promise.resolve();
  assert.deepEqual(order,["lookup"]);
  release();
  await Promise.all(retained);
  assert.deepEqual(order,["lookup","outcomes"]);
  assert.equal(unrelatedDone,false);
  releaseUnrelated();
  await unrelated;

  const failed=[];
  startMorningZapOutcomes({waitUntil:p=>failed.push(p)},env,"test",
    async()=>{order.push("fallback-outcomes");return {status:"ok"};},{log(){},error(){}},
    async()=>{throw new Error("lookup unavailable");});
  await Promise.all(failed);
  assert.equal(order.at(-1),"fallback-outcomes");
});

test("morning orchestration forces fresh cached outcomes after lookup refresh",async()=>{
  const id="FORCE1",rows=new Map(),retained=[];
  rows.set(kvKey(id),JSON.stringify({project_id:id,join:{matched:true},generated_at:TEST_NOW,lookup_version:"old"}));
  const env={ALERT_STATE:{get:async key=>rows.get(key)||null,put:async(key,value)=>rows.set(key,value)}};
  let lookupVersion="old";
  startMorningZapOutcomes({waitUntil:p=>retained.push(p)},env,"test",refreshZapOutcomes,
    {log(){},error(){}},async()=>{lookupVersion="new";},{
      projectIds:[id],nowMs:TEST_NOW_MS,
      build:async()=>({project_id:id,join:{matched:true},generated_at:TEST_NOW,lookup_version:lookupVersion}),
    });
  await Promise.all(retained);
  assert.equal(JSON.parse(rows.get(kvKey(id))).lookup_version,"new");
});

test("morning outcomes consume the refreshed lookup before KV becomes consistent",async()=>{
  const original=globalThis.fetch;
  const id="2026K0233",retained=[],values=new Map();
  const floor=committedZapProjectsLookupFloor();
  const staleDoc={...floor,source:"soda",materialized_at:"2026-10-02T00:00:00Z",rows:floor.rows.map(row=>
    row.project_id===id?{...row,current_milestone:"Community Board Referral"}:row)};
  let writtenLookup=null;
  const env={ALERT_STATE:{
    get:async key=>key===ZAP_PROJECTS_LOOKUP_KV_KEY?JSON.stringify(staleDoc):values.get(key)||null,
    put:async(key,value)=>{if(key===ZAP_PROJECTS_LOOKUP_KV_KEY)writtenLookup=JSON.parse(value);else values.set(key,value);},
  }};
  const freshRows=floor.rows.map(row=>row.project_id===id
    ?{...row,current_milestone:"Borough President Referral",current_milestone_date:TEST_NOW}
    :row);
  const thin={data:{id,type:"projects",attributes:{"dcp-name":id,"dcp-projectname":"240 Nassau Street"}},included:[]};
  globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes("herokuapp.com")?thin:[]));
  try{
    startMorningZapOutcomes({waitUntil:p=>retained.push(p)},env,"test",refreshZapOutcomes,
      {log(){},error(){}},
      lookupOptions=>refreshZapProjectsLookup(env,{...lookupOptions,now:new Date(TEST_NOW),fetchImpl:async()=>new Response(JSON.stringify(freshRows))}),
      {projectIds:[id],nowMs:TEST_NOW_MS});
    await Promise.all(retained);
    assert.equal(writtenLookup.rows.find(row=>row.project_id===id).current_milestone,"Borough President Referral");
    assert.equal(JSON.parse(await env.ALERT_STATE.get(ZAP_PROJECTS_LOOKUP_KV_KEY)).rows.find(row=>row.project_id===id).current_milestone,"Community Board Referral");
    const stored=JSON.parse(values.get(kvKey(id)));
    assert.equal(stored.open_data.current_milestone,"Borough President Referral");
    assert.equal(stored.source_observations.open_data.observed_at,TEST_NOW);
  }finally{globalThis.fetch=original;}
});
