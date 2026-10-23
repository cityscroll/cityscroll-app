export function landStageEvidenceObservedAt(record){
  return record&&Object.hasOwn(record,"stage_observation")?record.stage_observation?.observed_at||null:record?.generated_at||null;
}
function regressesLandStageEvidence(current,candidate){
  const currentStamp=Date.parse(landStageEvidenceObservedAt(current)||"");
  const candidateStamp=Date.parse(landStageEvidenceObservedAt(candidate)||"");
  return Number.isFinite(currentStamp)&&(!Number.isFinite(candidateStamp)||candidateStamp<currentStamp);
}
// determinism-lint: allow clock evidence age is intentionally evaluated at the current browser instant; callers may inject a pinned instant.
export function landStageEvidenceIsStale(record,n=Date.now()){
  const stamp=Date.parse(landStageEvidenceObservedAt(record)||"");
  return !Number.isFinite(stamp)||n-stamp>86400000;
}
export function createLandOutcomeRuntime({cache=new Map(),ttlMs=300000,
// determinism-lint: allow clock for expiry and evidence age.
now=()=>Date.now(),normalizeRecord=record=>record,translate=key=>key,
formatDate=value=>value,escapeHTML=value=>String(value),fetchResponse,
connectionTools=async()=>null}={}){
  function get(id){
    const hit=cache.get(id);
    if(!hit||hit.p)return hit||null;
    return now()-hit.at<ttlMs?hit:{...hit,expired:true};
  }
  function evidenceState(p,n=now()){
    const record=p?.record,observedAt=landStageEvidenceObservedAt(record);
    return {observedAt,stale:p?.stale===true||landStageEvidenceIsStale(record,n)};
  }
  function freshnessHTML(p,{failed=false}={}){
    const s=evidenceState(p);
    if(!failed&&!s.stale)return "";
    const stamp=s.observedAt?translate("land_outcome_checked_at",{date:formatDate(s.observedAt)}):translate("land_outcome_check_unknown");
    return `<p class="land-outcome-freshness" role="status">${escapeHTML(translate(failed ? "land_outcome_update_failed" : "land_outcome_stale"))} ${escapeHTML(stamp)} ${escapeHTML(translate("land_outcome_stage_caution"))}</p>`;
  }
  function recordForDisplay(p,failed=false){
    return normalizeRecord({...p.record,evidence_stale:failed||evidenceState(p).stale});
  }
  function display(p,{fallback=null,failed=false}={}){
    const usable=v=>v?.ok!==false&&v?.record,s=usable(p)?p:usable(fallback)?fallback:null;
    if(!s)return {source:null,record:null,freshness:"",failed};
    const f=failed||s!==p;
    return {source:s,record:recordForDisplay(s,f),freshness:freshnessHTML(s,{failed:f}),failed:f};
  }
  async function refreshDisplay(id){
    const warm=get(id),payload=await fetch(id,{allowStatic:false});
    return {payload,...display(payload,{fallback:warm?.data,failed:!payload||payload.ok===false||!payload.record})};
  }
  function seed(s){
    const byProject=s?.outcomes?.by_project||{},g=s?.generated_at||null;
    for(const [id,record] of Object.entries(byProject)){
      if(!record||record.snapshot_state==="unavailable")continue;
      const previous=cache.get(id);
      if(previous?.p||previous?.data?.record&&(!previous.staticSnapshot||Date.parse(previous.data.record.generated_at)>=Date.parse(record.generated_at)||regressesLandStageEvidence(previous.data.record,record)))continue;
      cache.set(id,{data:{ok:true,cached:true,static_snapshot:true,generated_at:g,record},at:now(),generatedAt:g,staticSnapshot:true});
    }
  }
  /**
   * Overlay rich seed fields onto an already-cached static list snapshot.
   * Used when land_outcomes_seed.json is lazy-fetched on detail/first rich paint.
   */
  function enrichStatic(projectId, seedRecord, mergeRecord){
    const id=String(projectId||"").trim();
    if(!id||!seedRecord||typeof mergeRecord!=="function")return null;
    const previous=cache.get(id);
    if(!previous?.data?.record||previous.p||!previous.staticSnapshot)return previous||null;
    const record=mergeRecord(previous.data.record, seedRecord);
    const next={
      ...previous,
      data:{...previous.data,record},
      at:now(),
    };
    cache.set(id,next);
    return next;
  }
  function fetch(projectId,{allowStatic=true}={}){
    const id=String(projectId||"").trim();
    if(!id)return Promise.resolve(null);
    const e=get(id);
    if(e?.p)return e.p;
    if(e?.data&&!e.expired&&(allowStatic||!e.staticSnapshot))return Promise.resolve(e.data);
    const p=(async()=>{
      try{
        const tools=await connectionTools();
        const accepts=tools?async r=>{
          if(!r?.ok)return false;
          const p=await r.json();
          return p?.ok!==false&&p?.record?.project_id===id;
        }:null;
        const r=await fetchResponse(id,accepts);
        if(!r?.ok)return null;
        const data=await r.json();
        return tools?tools.normalizeProjectConnectionsPayload(data,id):data;
      }catch(_error){return null;}
    })();
    cache.set(id,{...e,p});
    return p.then(data=>{
      if(data&&data.ok!==false&&data.record){
        const old=e?.data?.record;
        if(old&&(Date.parse(old.generated_at)>Date.parse(data.record.generated_at)||!Number.isFinite(Date.parse(data.record.generated_at))||regressesLandStageEvidence(old,data.record)||old.spine?.events?.length&&!data.record.spine?.events?.length)){
          cache.set(id,e);
          return {...e.data,stale:true};
        }
        cache.set(id,{data,at:now()});
      }else if(e?.data)cache.set(id,e);
      else cache.delete(id);
      return data;
    }).catch(()=>{
      if(e?.data)cache.set(id,e);
      else cache.delete(id);
      return null;
    });
  }
  return {cache,ttlMs,get,seed,enrichStatic,fetch,evidenceState,freshnessHTML,recordForDisplay,display,refreshDisplay};
}
