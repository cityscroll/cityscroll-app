import {
  inferFranchiseStageFromNotice,
  isFranchiseConcessionNoticeEligible,
} from "../franchise_notice.mjs";
import { noticeDisplayTitle } from "../display_title.mjs";
import { renderPropertyCommercialDetail } from "../property_commercial_ui.mjs";

/* ===== Franchise / concession review process spine (FCRC multi-notice chain).
   Reconstructs solicitation → public hearing → committee meeting → award for one
   franchise/concession agreement or annual plan, joined by counterparty stem,
   plan year, or FCRC rules subject. Empty stages stay class-(a). ===== */
function franchiseStageLabel(kind){
  if(kind==="solicitation") return t("franchise_stage_solicitation");
  if(kind==="public_hearing") return t("franchise_stage_public_hearing");
  if(kind==="committee_meeting") return t("franchise_stage_committee_meeting");
  if(kind==="award") return t("franchise_stage_award");
  return kind || "—";
}
function lifecycleJoinReference(join){
  const keys=Array.isArray(join&&join.keys)?join.keys:[];
  const key=keys.find(k=>/^(?:solicitation|concession):/i.test(k))
    ||keys.find(k=>/^bbl:/i.test(k))
    ||keys.find(k=>/^taxlot:/i.test(k))
    ||keys.find(k=>/^party:/i.test(k))
    ||keys.find(k=>/^plan:/i.test(k))
    ||keys.find(k=>/^rules:/i.test(k));
  if(!key) return null;
  const parts=String(key).split(":");
  const kind=parts.shift().toLowerCase();
  const value=parts.join(":");
  if(kind==="solicitation"||kind==="concession") return t("join_reference_solicitation",{value:escUiHtml(value.toUpperCase())});
  if(kind==="bbl") return t("join_reference_bbl",{value:escUiHtml(value)});
  if(kind==="taxlot") return t("join_reference_taxlot",{value:escUiHtml(value.replace(/:/g," / "))});
  if(kind==="party") return t("join_reference_party",{value:escUiHtml(value.replace(/[-_]+/g," "))});
  if(kind==="plan") return t("join_reference_plan",{value:escUiHtml(value.toUpperCase())});
  if(kind==="rules") return t("join_reference_rules");
  return null;
}
function lifecycleJoinMethod(method){
  const keys={
    exact_concession_id:"join_method_solicitation",
    exact_party:"join_method_party",
    exact_plan_year:"join_method_plan_year",
    exact_rules_subject:"join_method_rules_subject",
    exact_bbl:"join_method_bbl",
    exact_borough_block_lot:"join_method_taxlot"
  };
  return t(keys[method]||"join_method_shared_reference");
}
function lifecycleJoinDetailsHTML(join,provenance){
  const reference=lifecycleJoinReference(join);
  const evidence=reference
    ?t("join_evidence_html",{reference,method:escUiHtml(lifecycleJoinMethod(join&&join.method))})
    :t("join_evidence_singleton_html");
  return `<details class="inline-disclose lc-how join-evidence"><summary>${t("join_evidence_summary")}</summary><div class="inline-disclose-body">${evidence}<div class="note" style="margin-top:8px">${provenance}</div></div></details>`;
}
function lifecycleNoticeEventsHTML(events){
  return (Array.isArray(events)?events:[]).map(event=>{
    const id=String(event&&event.request_id||"");
    const title=cleanText(event&&event.title)||id||"—";
    const when=event&&(event.time?.value||event.when)?fdate(event.time?.value||event.when):"—";
    const titleHtml=id
      ?`<a href="#notice/${escUiHtml(id)}">${escUiHtml(title)}</a>`
      :escUiHtml(title);
    const sourceUrl=event&&(event.source?.url||event.source_url);
    return `<div class="lc-event">
      <div class="when">${escUiHtml(when)}</div>
      <div class="lc-pct" lang="en" dir="ltr">${titleHtml}</div>
      ${sourceUrl?`<div class="lc-pct"><a href="${escUiHtml(sourceUrl)}" ${EXT_ATTRS}>${t("view_in_city_record")}${extSR()}</a></div>`:""}
    </div>`;
  }).join("");
}
let franchisePhaseSpineToolsPromise=null;
function franchisePhaseSpineTools(){
  if(!franchisePhaseSpineToolsPromise){
    franchisePhaseSpineToolsPromise=import("../franchise_phase_spine.mjs").catch(()=>null);
  }
  return franchisePhaseSpineToolsPromise;
}
function franchiseConcessionSpineHTML(spine, notice, phaseView){
  if(!spine) return "";
  const join = spine.join || {};
  const how=lifecycleJoinDetailsHTML(join,t("franchise_provenance_html"));

  // Phase-grouped compact stepper (same pattern as property / land / rules) when the pure module loads.
  if(phaseView && Array.isArray(phaseView.phases) && phaseView.phases.length){
    const cur=phaseView.current;
    const actionLead=cur?`<p class="land-spine-status franchise-phase-lead">${t("franchise_phase_now_html",{
      phase:escUiHtml(franchiseStageLabel(cur.id)),
      action:escUiHtml(t(cur.action_key||"franchise_phase_action_solicitation"))
    })}${phaseView.next?` · ${t("franchise_phase_next_html",{phase:escUiHtml(franchiseStageLabel(phaseView.next.id))})}`:""}</p>`:"";
    const stepper=`<ol class="lc-stepper franchise-phase-stepper" aria-label="${escUiHtml(t("franchise_spine_heading"))}">${
      phaseView.phases.map((p,i)=>{
        const cls=p.matched?(cur&&p.id===cur.id?"current":"done"):"todo";
        const aria=cur&&p.id===cur.id?` aria-current="step"`:"";
        const arrow=i<phaseView.phases.length-1?`<span class="lc-step-arrow" aria-hidden="true">→</span>`:"";
        const label=franchiseStageLabel(p.id);
        return `<li><span class="lc-step lc-step-help ${cls}" tabindex="0" aria-label="${escUiHtml(label)}"${aria} title="${escUiHtml(label)}">${escUiHtml(p.short||label)}</span>${arrow}</li>`;
      }).join("")
    }</ol>`;
    // Detail only for matched phases + current (collapse pure-future empties to stepper chips).
    const cards=phaseView.phases.filter(p=>p.matched||(cur&&p.id===cur.id)).map(p=>{
      if(!p.matched){
        return `<div class="stage"><div class="box">
          <div class="stage-name">${franchiseStageLabel(p.id)}</div>
          <div class="lc-norecord">${t("franchise_stage_not_yet_ingested_html",{
            source:`<span lang="en" dir="ltr">${t("franchise_source_city_record")}</span>`
          })}</div>
        </div></div>`;
      }
      const notices=lifecycleNoticeEventsHTML(p.events);
      return `<div class="stage"><div class="box matched">
        <div class="stage-name">${franchiseStageLabel(p.id)}</div>
        ${notices}
      </div></div>`;
    }).join('<div class="connector" aria-hidden="true">→</div>');
    return `<section class="franchise-spine" data-franchise-spine="1" data-franchise-phase="1" aria-label="${escUiHtml(t("franchise_spine_heading"))}">
      <div class="chain-h">${t("franchise_spine_heading")}</div>
      ${actionLead}
      ${stepper}
      <div class="chain franchise-phase-cards">${cards}</div>
      ${how}
    </section>`;
  }

  // Flat fallback when the phase module is unavailable.
  const stages = Array.isArray(spine.stages) ? spine.stages : [];
  let chain = "";
  stages.forEach((stage, idx) => {
    const matched = stage && stage.matched;
    const stageEvents = Array.isArray(stage.events) ? stage.events : [];
    if(matched){
      chain += `<div class="stage"><div class="box matched">
        <div class="stage-name">${franchiseStageLabel(stage.kind)}</div>
        ${lifecycleNoticeEventsHTML(stageEvents)}
      </div></div>`;
    } else {
      chain += `<div class="stage"><div class="box">
        <div class="stage-name">${franchiseStageLabel(stage.kind)}</div>
        <div class="lc-norecord">${t("franchise_stage_not_yet_ingested_html",{
          source:`<span lang="en" dir="ltr">${t("franchise_source_city_record")}</span>`
        })}</div>
      </div></div>`;
    }
    if(idx < stages.length - 1) chain += '<div class="connector" aria-hidden="true">→</div>';
  });
  return `<section class="franchise-spine" data-franchise-spine="1" aria-label="${escUiHtml(t("franchise_spine_heading"))}">
    <div class="chain-h">${t("franchise_spine_heading")}</div>
    <div class="chain">${chain}</div>
    ${how}
  </section>`;
}
async function loadFranchiseConcessionSpine(r, el){
  if(!el || !r || !isFranchiseConcessionNoticeEligible(r)){
    if(el) el.innerHTML = "";
    return;
  }
  let spine = null;
  let francRow = null;
  try{
    const response = await workerFetch("/franchise-concessions", {}, 12000);
    if(response && response.ok){
      const payload = await response.json();
      const spines = Array.isArray(payload.franchise_spines) ? payload.franchise_spines : [];
      const id = String(r.request_id || "");
      spine = spines.find(s =>
        (Array.isArray(s.events) && s.events.some(e => e && e.request_id === id))
        || (Array.isArray(s.stages) && s.stages.some(st => Array.isArray(st.request_ids) && st.request_ids.includes(id)))
      ) || null;
      if(Array.isArray(payload.notices)){
        francRow = payload.notices.find(p => p && p.request_id === id) || null;
        if(francRow){
          r.franchise_stage = francRow.franchise_stage || r.franchise_stage || null;
          r.franchise_join_keys = francRow.franchise_join_keys || null;
          r.franchise_subject_ref = francRow.franchise_subject_ref || null;
        }
      }
      // Fallback: singleton from this notice if the cached view is stale/missing.
      if(!spine && francRow){
        const stageOrder = ["solicitation","public_hearing","committee_meeting","award"];
        const subject = francRow.franchise_subject_ref || id;
        spine = {
          schema_version: 1,
          subject_ref: subject,
          join: {
            matched: Array.isArray(francRow.franchise_join_keys) && francRow.franchise_join_keys.length > 0,
            method: (francRow.franchise_join_keys && francRow.franchise_join_keys.length) ? "exact_party" : "single_notice",
            keys: francRow.franchise_join_keys || [],
            notice_count: 1
          },
          stages: stageOrder.map(kind => {
            const matched = francRow.franchise_stage === kind;
            const whenRaw = francRow.event_date || francRow.start_date || "";
            return {
              kind,
              matched,
              notice_count: matched ? 1 : 0,
              request_ids: matched ? [id] : [],
              events: matched ? [{
                request_id: id,
                title: cleanText(francRow.short_title) || id,
                time: { value: String(whenRaw).slice(0,10) || null }
              }] : []
            };
          }),
          events: [],
          gaps: []
        };
      }
    }
  }catch(e){}
  // Client-side singleton when the endpoint is unreachable: still phase-group this notice.
  if(!spine){
    const stage = inferFranchiseStageFromNotice(r);
    if(stage){
      r.franchise_stage = r.franchise_stage || stage;
      const id = String(r.request_id || "");
      const stageOrder = ["solicitation","public_hearing","committee_meeting","award"];
      const whenRaw = r.event_date || r.start_date || "";
      spine = {
        schema_version: 1,
        subject_ref: r.franchise_subject_ref || id,
        join: {
          matched: false,
          method: "single_notice",
          keys: r.franchise_join_keys || [],
          notice_count: 1
        },
        stages: stageOrder.map(kind => {
          const matched = kind === stage;
          return {
            kind,
            matched,
            notice_count: matched ? 1 : 0,
            request_ids: matched ? [id] : [],
            events: matched ? [{
              request_id: id,
              title: cleanText(r.short_title) || id,
              time: { value: String(whenRaw).slice(0,10) || null }
            }] : []
          };
        }),
        events: [],
        gaps: []
      };
    }
  }
  if(!document.contains(el)) return;
  if(!spine){
    // Honest empty: City Record is the source; we simply have no chain for this notice yet.
    el.innerHTML = `<section class="franchise-spine" data-franchise-spine="1" aria-label="${escUiHtml(t("franchise_spine_heading"))}">
      <div class="chain-h">${t("franchise_spine_heading")}</div>
      <div class="note">${t("franchise_spine_unavailable_html",{
        source:`<span lang="en" dir="ltr">${t("franchise_source_city_record")}</span>`
      })}</div>
    </section>`;
    return;
  }
  // Stamp current stage for the action rail when the spine resolves a later matched stage.
  if(Array.isArray(spine.stages)){
    let lastMatched = null;
    for(const st of spine.stages){
      if(st && st.matched) lastMatched = st.kind;
    }
    if(lastMatched) r.franchise_stage = lastMatched;
  }
  const phaseTools = await franchisePhaseSpineTools();
  const phaseView = phaseTools && phaseTools.buildFranchisePhaseView
    ? phaseTools.buildFranchisePhaseView(spine)
    : null;
  el.innerHTML = franchiseConcessionSpineHTML(spine, r, phaseView);
  // Re-mount action rail once franchise stage is stamped (stage-tied next steps).
  try{
    if($("#nactions")) mountNoticeActionRail($("#nactions"), r);
  }catch(_e){}
}

/* ===== Property disposition process spine (multi-notice chain by BBL / block-lot).
   Distinct from the explorer "lifecycle rail" below (propStage/PROP_STAGES = temporal list
   filters: proposed/soon/upcoming/past). This spine reconstructs hearing → auction/RFP →
   award/conveyance for one asset from City Record Property Disposition notices. ===== */
function isPropertyDispositionEligible(r){
  return (r && r.section_name === "Property Disposition");
}
function dispositionStageLabel(kind){
  if(kind==="hearing") return t("disposition_stage_hearing");
  if(kind==="auction_or_rfp") return t("disposition_stage_auction_or_rfp");
  if(kind==="award_or_conveyance") return t("disposition_stage_award_or_conveyance");
  return kind || "—";
}
let propertyPhaseSpineToolsPromise=null;
function propertyPhaseSpineTools(){
  if(!propertyPhaseSpineToolsPromise){
    propertyPhaseSpineToolsPromise=import("../property_phase_spine.mjs").catch(()=>null);
  }
  return propertyPhaseSpineToolsPromise;
}
function propertyDispositionTimingHTML(estimate){
  if(!estimate || !estimate.pattern_line) return "";
  const line=escUiHtml(estimate.pattern_line);
  const tag=escUiHtml(t("cadence_estimate_tag"));
  const cohortNote=estimate.public_projection==="cohort_statistic_only"
    ?`<div class="note disposition-timing-cohort-note">${t("disposition_timing_cohort_note_html")}</div>`
    :"";
  const formula=`<div class="lc-pct"><a href="about.html#property-disposition-timing-formula">${t("disposition_timing_formula_link")}</a></div>`;
  const value=`${estimate.weeks_low??"unknown"}-${estimate.weeks_high??"unknown"}-weeks`;
  return `<div class="note disposition-timing-estimate" data-property-disposition-timing="1" data-prediction-subject="property-sale-timing" data-prediction-value="${escUiHtml(value)}" data-disposition-timing-projection="${escUiHtml(estimate.public_projection||"cohort_statistic_only")}">${t("disposition_timing_estimate_html",{line,tag})}${cohortNote}${formula}</div>`;
}
function propertyDispositionSpineHTML(spine, notice, phaseView){
  if(!spine) return "";
  const join = spine.join || {};
  const how=lifecycleJoinDetailsHTML(join,t("disposition_provenance_html"));
  const timingEstimate=phaseView && phaseView.disposition_timing_estimate
    ? propertyDispositionTimingHTML(phaseView.disposition_timing_estimate)
    : "";
  // Generalized cycle-context marker (same shape as tax-lien): position is the
  // phase stepper; historical context is the attributed timing line when present.
  const cycleContextMark=phaseView
    ?`<div class="disposition-cycle-context-chip" data-property-cycle-context="property_disposition" data-cycle-current="${escUiHtml(phaseView.current&&phaseView.current.id||"")}" hidden></div>`
    :"";

  // Phase-grouped compact stepper (same pattern as land / money) when the pure module loads.
  if(phaseView && Array.isArray(phaseView.phases) && phaseView.phases.length){
    const cur=phaseView.current;
    const actionLead=cur && cur.matched?`<p class="land-spine-status disposition-phase-lead">${t("disposition_phase_now_html",{
      phase:escUiHtml(dispositionStageLabel(cur.id)),
      action:escUiHtml(t(cur.action_key||"disposition_phase_action_attend"))
    })}${phaseView.next?` · ${t("disposition_phase_next_html",{phase:escUiHtml(dispositionStageLabel(phaseView.next.id))})}`:""}</p>`:"";
    const stepper=`<ol class="lc-stepper disposition-phase-stepper" aria-label="${escUiHtml(t("disposition_spine_heading"))}">${
      phaseView.phases.map((p,i)=>{
        const cls=p.matched?(cur&&p.id===cur.id?"current":"done"):"todo";
        const aria=cur&&p.id===cur.id?` aria-current="step"`:"";
        const arrow=i<phaseView.phases.length-1?`<span class="lc-step-arrow" aria-hidden="true">→</span>`:"";
        const label=dispositionStageLabel(p.id);
        return `<li><span class="lc-step lc-step-help ${cls}" tabindex="0" aria-label="${escUiHtml(label)}"${aria} title="${escUiHtml(label)}">${escUiHtml(p.short||label)}</span>${arrow}</li>`;
      }).join("")
    }</ol>`;
    // Detail cards only for matched phases — empty stages stay stepper chips only
    // (absent means absent; no per-stage "not yet shown" explainer).
    const matchedPhases=phaseView.phases.filter(p=>p.matched);
    const cards=matchedPhases.map(p=>{
      return `<div class="stage"><div class="box matched">
        <div class="stage-name">${dispositionStageLabel(p.id)}</div>
        ${lifecycleNoticeEventsHTML(p.events)}
      </div></div>`;
    }).join('<div class="connector" aria-hidden="true">→</div>');
    return `<div class="chain-h">${t("disposition_spine_heading")}</div>
      ${cycleContextMark}
      ${actionLead}
      ${stepper}
      ${timingEstimate}
      ${cards?`<div class="chain disposition-phase-cards">${cards}</div>`:""}
      ${how}`;
  }

  // Flat fallback when the phase module is unavailable — matched stages only.
  const stages = Array.isArray(spine.stages) ? spine.stages.filter(s=>s && s.matched) : [];
  let chain = "";
  stages.forEach((stage, idx) => {
    const stageEvents = Array.isArray(stage.events) ? stage.events : [];
    chain += `<div class="stage"><div class="box matched">
      <div class="stage-name">${dispositionStageLabel(stage.kind)}</div>
      ${lifecycleNoticeEventsHTML(stageEvents)}
    </div></div>`;
    if(idx < stages.length - 1) chain += '<div class="connector">→</div>';
  });
  return `<div class="chain-h">${t("disposition_spine_heading")}</div>
    ${chain?`<div class="chain">${chain}</div>`:""}
    ${how}`;
}
function propertyCommercialDetailHTML(commercial){
  return renderPropertyCommercialDetail(commercial,{
    t,
    escape:escUiHtml,
    priceBadge:priceKindBadge,
    timedEventsHTML:propertyTimedEventChipsHTML,
    fallbackSaleSignals:commercialSaleSignalsFallback,
    extAttrs:EXT_ATTRS,
    extSr:extSR,
  });
}
/** Sync fallback when pure-module hasCommercialSaleSignals is not loaded yet. */
function commercialSaleSignalsFallback(commercial){
  if(!commercial) return false;
  if(commercial.sale_method && commercial.sale_method.method) return true;
  if(Array.isArray(commercial.price_facts) && commercial.price_facts.length) return true;
  const steps=commercial.participation && Array.isArray(commercial.participation.steps)
    ? commercial.participation.steps : [];
  if(steps.some(s=>s && (s.kind==="registration"||s.kind==="bid_deadline"||s.kind==="show_or_inspection"||s.kind==="deposit_or_fee"))) return true;
  const url=commercial.participation && commercial.participation.package_url;
  if(url && /govdeals\.com|iaai\.com|publicsurplus|nyc\.gov\/auctions/i.test(url)) return true;
  const cat=commercial.item && commercial.item.category;
  const conf=commercial.item && commercial.item.confidence;
  if(["vehicle","timber","equipment","real_property","scrap_materials"].includes(cat) && (conf==="high"||conf==="medium")){
    const dc=commercial.disposition_class;
    if(dc==="destruction"||dc==="transfer"||dc==="abandonment") return false;
    return true;
  }
  return false;
}
async function loadPropertyPlainSummary(r, el){
  if(!el || !r || !isPropertyDispositionEligible(r)) return;
  try{
    const tools=await import("../property_plain_summary.mjs");
    const summary=tools.buildPropertyPlainSummary(r,{
      today:todayISO(),
      events:r.commercial?.timed_events||undefined,
      readerActions:r.property_reader_actions||undefined,
    });
    r.property_plain_summary=summary;
    if(summary?.reader_actions) r.property_reader_actions=summary.reader_actions;
    if(document.contains(el)) el.innerHTML=tools.propertyPlainSummaryHTML(summary,{escape:escUiHtml});
  }catch(_e){
    if(document.contains(el)) el.innerHTML="";
  }
}
let propertyDecisionDataPromise=null;
function propertyDecisionData(){
  if(!propertyDecisionDataPromise) propertyDecisionDataPromise=import("../property_decision_data.mjs").then(module=>module.loadPropertyDecisionData()).catch(()=>({attachmentLookup:{},lifecycleHistory:{}}));
  return propertyDecisionDataPromise;
}
async function loadPropertyCommercialDetail(r, el){
  if(!el || !r || !isPropertyDispositionEligible(r)) return;
  try{
    const tools=await propertyCommercialTools();
    const readerTools=await import("../property_reader_actions.mjs").catch(()=>null);
    // Prefer full-body extraction on detail; merge attachment titles when materialization stamped them.
    const {attachmentLookup}=await propertyDecisionData();
    let attachments=Array.isArray(attachmentLookup?.[r.request_id])?attachmentLookup[r.request_id]:[];
    if(attachments.length) r.attachments=attachments;
    if(r.commercial && r.commercial.item && r.commercial.item.source==="attachment_metadata"){
      // Keep label signal from stamped commercial when body is thin.
    }
    const commercial=tools && tools.extractPropertyCommercial
      ? tools.extractPropertyCommercial(r, { attachments })
      : (r.commercial || null);
    // If list stamped a richer item label from attachment metadata, preserve it on thin bodies.
    if(commercial && r.commercial && r.commercial.item && r.commercial.item.source==="attachment_metadata"){
      if(!commercial.item.label || commercial.item.source!=="attachment_metadata"){
        commercial.item={ ...commercial.item, ...r.commercial.item };
      }
    }
    // Recompute sale gate after merge (attachment boost may change eligibility).
    if(commercial && tools && typeof tools.hasCommercialSaleSignals==="function"){
      commercial.sale_eligible=tools.hasCommercialSaleSignals(commercial);
    } else if(commercial && commercial.sale_eligible==null){
      commercial.sale_eligible=commercialSaleSignalsFallback(commercial);
    }
    if(commercial && tools && typeof tools.propertyTimedEventViews==="function"){
      commercial.event_views=tools.propertyTimedEventViews(commercial.timed_events||[]);
    }
    if(commercial) r.commercial=commercial;
    if(readerTools?.extractPropertyReaderActions){
      r.property_reader_actions=readerTools.extractPropertyReaderActions(r,{today:todayISO(),events:commercial?.timed_events||[]});
      // The commercial extractor owns these source-backed actions. Paint them as
      // soon as they exist instead of waiting for unrelated parcel joins to settle.
      const actionRail=document.querySelector("#nactions");
      if(actionRail && typeof globalThis.mountNoticeActionRail==="function"){
        globalThis.mountNoticeActionRail(actionRail,r);
      }
    }
    if(!document.contains(el)) return;
    el.innerHTML=commercial ? propertyCommercialDetailHTML(commercial) : "";
  }catch(_e){
    if(document.contains(el) && r.commercial) el.innerHTML=propertyCommercialDetailHTML(r.commercial);
  }
}
async function loadPropertyDispositionSpine(r, el){
  if(!el || !r || !isPropertyDispositionEligible(r)) return;
  let spine = null;
  let propRow = null;
  try{
    const response = await workerFetch("/property-locations", {}, 12000);
    if(response && response.ok){
      const payload = await response.json();
      const spines = Array.isArray(payload.disposition_spines) ? payload.disposition_spines : [];
      const id = String(r.request_id || "");
      spine = spines.find(s =>
        (Array.isArray(s.events) && s.events.some(e => e && e.request_id === id))
        || (Array.isArray(s.stages) && s.stages.some(st => Array.isArray(st.request_ids) && st.request_ids.includes(id)))
      ) || null;
      if(Array.isArray(payload.properties)){
        propRow = payload.properties.find(p => p && p.request_id === id) || null;
        if(propRow){
          r.disposition_stage = propRow.disposition_stage || r.disposition_stage || null;
          r.disposition_join_keys = propRow.disposition_join_keys || null;
          r.disposition_subject_ref = propRow.disposition_subject_ref || null;
          if(propRow.commercial) r.commercial = propRow.commercial;
        }
      }
      // Fallback: build a singleton from this notice if the cached view is stale/missing.
      if(!spine && propRow){
        const stageOrder = ["hearing","auction_or_rfp","award_or_conveyance"];
        const subject = propRow.disposition_subject_ref || id;
        spine = {
          schema_version: 1,
          subject_ref: subject,
          join: {
            matched: Array.isArray(propRow.disposition_join_keys) && propRow.disposition_join_keys.length > 0,
            method: (propRow.disposition_join_keys && propRow.disposition_join_keys.length) ? "exact_bbl" : "single_notice",
            keys: propRow.disposition_join_keys || [],
            notice_count: 1
          },
          stages: stageOrder.map(kind => {
            const matched = propRow.disposition_stage === kind;
            const whenRaw = propRow.event_date || propRow.start_date || "";
            return {
              kind,
              matched,
              notice_count: matched ? 1 : 0,
              request_ids: matched ? [id] : [],
              events: matched ? [{
                request_id: id,
                title: cleanText(propRow.short_title) || id,
                time: { value: String(whenRaw).slice(0,10) || null }
              }] : []
            };
          }),
          events: [],
          gaps: []
        };
      }
    }
  }catch(e){}
  if(!document.contains(el)) return;
  if(!spine){
    // Honest empty: City Record is the source; we simply have no chain for this notice yet.
    el.innerHTML = `<div class="chain-h">${t("disposition_spine_heading")}</div>
      <div class="note">${t("disposition_spine_unavailable_html",{
        source:`<span lang="en" dir="ltr">${t("disposition_source_city_record")}</span>`
      })}</div>`;
    return;
  }
  const phaseTools = await propertyPhaseSpineTools();
  let phaseView = phaseTools && phaseTools.buildPropertyPhaseView
    ? phaseTools.buildPropertyPhaseView(spine)
    : null;
  // Cohort timing estimate (precomputed model) — only when hearing matched & auction not yet published.
  // Also stamp the shared property cycle-context envelope (survey class: property_disposition).
  if(phaseView){
    try{
      const timingMod = await import("../property_disposition_timing.mjs");
      const modelRes = await fetch("data/property_disposition_timing_model.json", { credentials: "omit" });
      if(modelRes && modelRes.ok){
        const model = await modelRes.json();
        phaseView = timingMod.attachDispositionTimingEstimate(phaseView, model) || phaseView;
      }
    }catch(_e){}
    try{
      const cycleMod = await taxLienCycleContextTools();
      if(cycleMod && cycleMod.buildDispositionCycleContext){
        r._disposition_cycle_context = cycleMod.buildDispositionCycleContext(phaseView, {
          subject_ref: spine.subject_ref || null,
        });
      }
    }catch(_e){}
  }
  el.innerHTML = propertyDispositionSpineHTML(spine, r, phaseView);
  // Stamp BBL for action rail re-render when location tools resolve it.
  try{
    const tools = await propertyLocationTools();
    const location = (propRow && propRow.property_location) || tools.propertyLocationFromRow(r);
    const bbl = tools.primaryPropertyBbl(location);
    if(bbl) r._property_bbl = bbl;
  }catch(_e){}
}

// A Property permalink must not paint a generic action and replace it after the parcel lookup
// resolves. Hydrate the local, source-derived BBL before routing renders the first detail frame.
async function hydratePropertyActionMatter(r){
  if(!r || !isPropertyDispositionEligible(r) || r._property_bbl) return r;
  try{
    const tools=await propertyLocationTools();
    const location=r.property_location||tools.propertyLocationFromRow(r);
    const bbl=tools.primaryPropertyBbl(location);
    if(bbl) r._property_bbl=bbl;
  }catch(_e){}
  return r;
}

let propertyParcelScopeBbl=null, parcelScopeToolsPromise=null;
function parcelScopeTools(){
  if(!parcelScopeToolsPromise) parcelScopeToolsPromise=import("../parcel_scope.mjs").catch(()=>null);
  return parcelScopeToolsPromise;
}
function propertyCurrentScope(){
  try{return CrolScope.scopeFromRouteHash(location.hash,{language:window.LANG||"en"});}
  catch(_e){return CrolScope.emptyScope(window.LANG||"en");}
}
function parcelPivotHTML(bbl,label){
  const id=String(bbl||"");
  const text=label||t("property_list_bbl_chip",{bbl:id});
  if(!/^\d{10}$/.test(id)||!globalThis.CrolEntityPivots?.entityChipHTML) return escUiHtml(text);
  return CrolEntityPivots.entityChipHTML({
    ref:`bbl:${id}`,
    label:text,
    link_confidence:"strong",
    relation:"sits_on_parcel",
  },{scope:propertyCurrentScope(),surface:"property",className:"parcel-pivot"});
}
async function observedParcelBiographyHTML(bbl,crossDomain,taxLien){
  const tools=await parcelScopeTools();
  const view=tools?.buildObservedParcelBiography?.({bbl,crossDomain,taxLien});
  if(!view?.ok) return `<div class="chain-h">${t("property_xd_heading")}</div>
    <div class="note">${t("property_xd_not_in_corpus_html",{bbl:escUiHtml(bbl)})}</div>
    <div class="note">${t("property_xd_provenance_html")}</div>`;
  const ui=await import("../parcel_biography_ui.mjs").catch(()=>null);
  if(!ui?.observedParcelBiographyHTML) return "";
  return ui.observedParcelBiographyHTML(view,{
    href:tools.parcelBiographyHref(bbl,{scope:propertyCurrentScope()}),
    t,
    escape:escUiHtml,
    pivot:pivotA,
    parcelPivot:parcelPivotHTML,
    formatDate:fdate,
    stageLabel:taxLienStageLabel,
    outcomeLabel:taxLienOutcomeLabel,
  });
}

/**
 * Observed parcel biography from committed exact-BBL materializations only.
 * No live multi-source fan-out and no zero-coverage owner/counterparty block.
 */
async function loadPropertyCrossDomain(r, el){
  if(!el || !r || !isPropertyDispositionEligible(r)) return;
  let bbl = r._property_bbl || null;
  if(!bbl){
    try{
      const tools = await propertyLocationTools();
      bbl = tools.primaryPropertyBbl(tools.propertyLocationFromRow(r));
      if(bbl) r._property_bbl = bbl;
    }catch(_e){}
  }
  if(!bbl || !/^\d{10}$/.test(String(bbl))){
    el.innerHTML = `<div class="chain-h">${t("property_xd_heading")}</div>
      <div class="note">${t("property_xd_no_bbl_html")}</div>`;
    return;
  }
  let crossDomain = null, taxLien = null;
  try{
    const [crossRes,lienRes]=await Promise.all([
      fetch(`data/property_cross_domain_lookup.json`,{cache:"force-cache"}),
      fetch(`data/tax_lien_sale_bbl.json`,{cache:"force-cache"}),
    ]);
    if(crossRes?.ok) crossDomain=await crossRes.json();
    if(lienRes?.ok) taxLien=await lienRes.json();
  }catch(_e){}
  if(!document.contains(el)) return;
  el.innerHTML=await observedParcelBiographyHTML(bbl,crossDomain,taxLien);
}
async function paintParcelBiographyPanel(bbl){
  const panel=$("#parcel-biography-panel"); if(!panel) return;
  if(!/^\d{10}$/.test(String(bbl||""))){panel.hidden=true;panel.innerHTML="";return;}
  panel.hidden=false;
  panel.innerHTML=`<div class="empty skel" aria-hidden="true"><span class="loading"></span><span class="skl"><i></i><i></i></span></div>`;
  try{
    const [crossRes,lienRes]=await Promise.all([
      fetch("data/property_cross_domain_lookup.json",{cache:"force-cache"}),
      fetch("data/tax_lien_sale_bbl.json",{cache:"force-cache"}),
    ]);
    const crossDomain=crossRes?.ok?await crossRes.json():null;
    const taxLien=lienRes?.ok?await lienRes.json():null;
    if(propertyParcelScopeBbl!==bbl||!document.contains(panel)) return;
    panel.innerHTML=await observedParcelBiographyHTML(bbl,crossDomain,taxLien);
  }catch(_e){
    if(document.contains(panel)) panel.innerHTML=`<div class="empty">${t("could_not_reach")}</div>`;
  }
}

/* ===== Property explorer: surplus-buyer commercial glance + process-stage rail.
   Primary persona: glancing surplus-goods buyer — WHAT / HOW MUCH / DEAL? / when-bid.
   Process stages (hearing → auction_or_rfp → award_or_conveyance) remain the ops ontology;
   multi-notice disposition subjects collapse to one list entry (site/property_explorer.mjs).
   PROP_STAGES remain temporal list filters (proposed/soon/upcoming/past), not process stages.
   Category vocabulary is persona-grounded (vehicle/timber/equipment/real_property/…);
   legacy URL keys (vehequip/forest/realty) normalize via normalizeAssetFilter. ===== */
// Values are i18n keys — render with t() so the explorer chrome follows the active language.
const ASSET_BUCKETS=[
  ["vehicle","asset_vehicle"],
  ["timber","asset_timber"],
  ["equipment","asset_equipment"],
  ["real_property","asset_real_property"],
  ["scrap_materials","asset_scrap_materials"],
  ["seized_property","asset_seized_property"],
  ["rights_and_interests","asset_rights_and_interests"],
  ["other","asset_other"],
];
const ASSET_LABEL=Object.fromEntries(ASSET_BUCKETS);
const ASSET_FILTER_ALIASES={vehequip:"vehicle",forest:"timber",realty:"real_property",medallion:"rights_and_interests",seized:"seized_property"};
function normalizePropAsset(raw){
  if(raw==null||raw===""||raw==="all") return "all";
  const key=String(raw).trim().toLowerCase().replace(/-/g,"_");
  if(ASSET_FILTER_ALIASES[key]) return ASSET_FILTER_ALIASES[key];
  if(ASSET_LABEL[key]) return key;
  return "other";
}
// Sync fallback when commercial module / stamped payload is unavailable (tests + cold paint).
function classifyAsset(rec){
  if(rec && rec.commercial && rec.commercial.item && rec.commercial.item.category){
    return normalizePropAsset(rec.commercial.item.category);
  }
  const t=(cleanText(rec.short_title)+" "+cleanText(rec.additional_description_1)).toLowerCase();
  const has=(...k)=>k.some(w=>t.includes(w));
  if(has("forest management","board feet","sawtimber","cordwood","timber","firewood","roundwood")) return "timber";
  // Keyword matchers must stay English (City Record body language). Prefer stamped
  // commercial.item.category when present; this fallback only uses phrases already
  // on the stray-english allowlist or single-token dataset tokens.
  // Check medallion/seized before vehicle: "minifleet" contains the substring "fleet".
  if(has("medallion")) return "rights_and_interests";
  if(has("unauthorized","tobacco","forfeiture","pending destruction","property clerk","owners are wanted","in the custody")) return "seized_property";
  if(has("auto auction","govdeals","iaai","fleet auction","municipal auto")) return "vehicle";
  if(has("heavy machinery","machine tools","publicsurplus","surplus assets","furniture")) return "equipment";
  if(has("scrap","recyclable metal")) return "scrap_materials";
  if(t.includes("easement")) return "rights_and_interests";
  if(has("mortgage and note","outstanding debt") && t.includes("mortgage")) return "rights_and_interests";
  if(has("disposition area","city-owned property","block/lot","residential property","public auction","premises","reversionary")) return "real_property";
  if(has("rfp","request for proposal","redevelopment","lease auction","lease","license")) return "real_property";
  return "other";
}
function propStage(r){
  const dl=daysLeft(r.event_date);
  if(dl!==null && dl>=0) return dl<=30 ? "soon" : "upcoming";
  if(/hearing/i.test(r.type_of_notice_description||"")) return "proposed";
  return "past";
}
const PROP_STAGES=[["all","stage_all"],["proposed","stage_proposed"],["soon","stage_soon"],["upcoming","stage_upcoming"],["past","stage_past"]];
function priceKindBadge(kind, amt){
  if(kind==="upset_price") return t("badge_upset_price",{amt});
  if(kind==="minimum_bid") return t("badge_min_bid",{amt});
  if(kind==="appraised") return t("badge_appraised",{amt});
  if(kind==="assessed") return t("badge_assessed",{amt});
  if(kind==="nominal") return t("badge_nominal");
  if(kind==="minimum_monthly_bid") return t("badge_min_monthly_bid",{amt});
  if(kind==="minimum_annual_bid") return t("badge_min_annual_bid",{amt});
  return amt?`$${amt}`:null;
}
function dollarBadge(r){
  if(r && r.commercial && r.commercial.primary_price){
    const p=r.commercial.primary_price;
    const amt=p.display?String(p.display).replace(/^\$/,""):String(p.amount);
    return priceKindBadge(p.kind, amt);
  }
  const txt=cleanText(r.short_title)+" "+cleanText(r.additional_description_1);
  let m=txt.match(/upset price[^$]{0,80}\$\s?([\d][\d,.]*)/i); if(m) return t("badge_upset_price",{amt:m[1]});
  m=txt.match(/minimum bid[^$]{0,80}\$\s?([\d][\d,.]*)/i); if(m) return t("badge_min_bid",{amt:m[1]});
  m=txt.match(/appraised[^$]{0,120}\$\s?([\d][\d,.]*)/i); if(m) return t("badge_appraised",{amt:m[1]});
  if(/(?:sold for|consideration of)\s+(?:one dollar|\$\s?1(?:\.00)?\b)/i.test(txt)) return t("badge_nominal");
  return null;
}
function ensurePropertyCommercial(r, tools){
  if(!r) return null;
  if(r.commercial && r.commercial.glance){
    if(tools && typeof tools.propertyTimedEventViews==="function"){
      r.commercial.event_views=tools.propertyTimedEventViews(r.commercial.timed_events||[]);
    }
    return r.commercial;
  }
  if(tools && tools.extractPropertyCommercial){
    r.commercial=tools.extractPropertyCommercial(r);
    if(typeof tools.propertyTimedEventViews==="function"){
      r.commercial.event_views=tools.propertyTimedEventViews(r.commercial.timed_events||[]);
    }
    return r.commercial;
  }
  return null;
}
function propertyTimedEventChipsHTML(commercial,omitSourceKinds=[]){
  const omitted=new Set(omitSourceKinds);
  const chips=(commercial?.event_views||[]).filter(v=>v.date&&v.label_key&&!omitted.has(v.source_kind)).map(v=>`<time class="tag ${v.chip_class}" datetime="${escUiHtml(v.date)}" data-date-chip="1" data-card-fact="event:${escUiHtml(v.kind)}:${escUiHtml(v.date)}"${v.band?` data-open-window-band="${v.band}"`:""}>${escUiHtml(t(v.label_key))} · ${escUiHtml(fdt(v.fmt))}${v.band?` · <span lang="en" dir="ltr">${v.band}</span>`:""}</time>`);
  return chips.length?`<div>${chips.join("")}</div>`:"";
}
let propAll=[], propSpines=[], propAsset="all", propStageSel="all", propProcessSel="all";
let propertyView="default";
let propertyCommunityDistrict="", propertyCouncilDistrict="", propertyResolvedNeighborhood=null;
let propertyAuctionExportVisible=[];
let propSaleMethod="all", propPriceBand="all", propSort="closing_soon";
let dcasFleetInventoryPromise=null, dcasFleetToolsPromise=null;
function dcasFleetTools(){
  if(!dcasFleetToolsPromise){
    dcasFleetToolsPromise=import("../dcas_vehicle_auctions.mjs").catch(()=>null);
  }
  return dcasFleetToolsPromise;
}
function loadDcasFleetInventory(){
  if(!dcasFleetInventoryPromise){
    dcasFleetInventoryPromise=fetch("data/dcas_vehicle_auctions.json",{cache:"no-cache"})
      .then(response=>response.ok?response.json():null)
      .catch(()=>null);
  }
  return dcasFleetInventoryPromise;
}
function dcasFleetVehicleLabel(vehicle){
  return [vehicle?.year,vehicle?.make,vehicle?.model].filter(Boolean).join(" ")||"—";
}
function dcasFleetInventoryHTML(snapshot,tools){
  const surface=tools.selectDcasVehicleAuctionSurface(snapshot,{today:todayISO()});
  let status=t("dcas_fleet_empty");
  if(surface.status==="open") status=t("dcas_fleet_open",{n:surface.count});
  else if(surface.status==="closed") status=t("dcas_fleet_closed",{date:fdt(surface.latest_close_date,{dateOnly:true})});
  const batches=(surface.batches||[]).slice(0,5).map(batch=>{
    const vehicles=(batch.vehicles||[]).slice(0,50).map(vehicle=>`<li lang="en" dir="ltr"><strong>${escUiHtml(dcasFleetVehicleLabel(vehicle))}</strong>${vehicle.vin?` <span class="muted">· ${escUiHtml(t("dcas_fleet_vin",{vin:vehicle.vin}))}</span>`:""}</li>`).join("");
    return `<details class="inline-disclose dcas-fleet-batch"><summary>${escUiHtml(t("dcas_fleet_batch_summary",{n:batch.count,date:fdt(batch.close_date,{dateOnly:true})}))}</summary><div class="inline-disclose-body"><ul class="ei-list">${vehicles}</ul></div></details>`;
  }).join("");
  const sourceUpdated=snapshot?.vintage?.source_updated_at
    ? `<br><span class="muted">${escUiHtml(t("dcas_fleet_source_updated",{date:fdt(snapshot.vintage.source_updated_at)}))}</span>`
    : "";
  return `<div class="fcard property-fleet-source-card" data-source-basis="goods_surplus" data-real-property="0">
    <div class="ftype">${escUiHtml(t("dcas_fleet_heading"))}</div>
    <h3>${escUiHtml(status)}</h3>
    <p>${escUiHtml(t("dcas_fleet_basis"))}</p>
    ${batches}
    <p class="note">${escUiHtml(t("dcas_fleet_source_note"))}${sourceUpdated}</p>
    <div class="factions">${compactCardActions(
      `<a class="act primary" href="${escUiHtml(snapshot.source.official_guide)}" ${EXT_ATTRS}>${escUiHtml(t("dcas_fleet_open_guide"))}${extSR()}</a>`,
      [`<a class="act" href="${escUiHtml(snapshot.source.marketplace)}" ${EXT_ATTRS}>${escUiHtml(t("dcas_fleet_open_marketplace"))}${extSR()}</a>`]
    )}</div>
  </div>`;
}
async function renderDcasFleetInventory(){
  const el=$("#dcas-fleet-inventory");
  if(!el) return;
  if(propAsset!=="vehicle"){
    el.hidden=true;
    el.innerHTML="";
    return;
  }
  const [snapshot,tools]=await Promise.all([loadDcasFleetInventory(),dcasFleetTools()]);
  if(!snapshot||!tools||!tools.selectDcasVehicleAuctionSurface){
    el.hidden=true;
    el.innerHTML="";
    return;
  }
  el.innerHTML=dcasFleetInventoryHTML(snapshot,tools);
  el.hidden=false;
}
let propertyExplorerToolsPromise=null;
function propertyExplorerTools(){
  if(!propertyExplorerToolsPromise){
    propertyExplorerToolsPromise=import("../property_explorer.mjs").catch(()=>null);
  }
  return propertyExplorerToolsPromise;
}
let propertyCommercialToolsPromise=null;
function propertyCommercialTools(){
  if(!propertyCommercialToolsPromise){
    propertyCommercialToolsPromise=import("../property_commercial.mjs").catch(()=>null);
  }
  return propertyCommercialToolsPromise;
}
let propertyPlainSummaryToolsPromise=null;
function propertyPlainSummaryTools(){
  if(!propertyPlainSummaryToolsPromise){
    propertyPlainSummaryToolsPromise=import("../property_plain_summary.mjs").catch(()=>null);
  }
  return propertyPlainSummaryToolsPromise;
}
let propertyReaderActionsToolsPromise=null;
function propertyReaderActionsTools(){
  if(!propertyReaderActionsToolsPromise){
    propertyReaderActionsToolsPromise=import("../property_reader_actions.mjs").catch(()=>null);
  }
  return propertyReaderActionsToolsPromise;
}
function propertyExplorerCardHTML(entry, terms, parcelLinks, plainTools, readerTools){
  const r=entry.primary;
  if(!r) return "";
  const commercial=r.commercial||null;
  const cardCopy=plainTools?.ensurePropertyCardPlainSummary?.(r,{today:todayISO(),events:r.commercial?.timed_events||undefined,readerActions:r.property_reader_actions||undefined})||null;
  const glance=commercial && commercial.glance ? commercial.glance : null;
  const ev=r.event_date || (glance && glance.close_date) || null;
  const closeDate=entry.close_date
    || (glance && glance.close_date)
    || (commercial && commercial.close_date)
    || r.event_date
    || null;
  const closed=entry.temporal_status==="closed"
    || (closeDate && daysLeft(closeDate)!==null && daysLeft(closeDate)<0);
  const propertyAddress=r._location?.addresses?.[0]?.label;
  const addr=propertyAddress||(goodAddr(r.street_address_1)?cleanText(r.street_address_1):"");
  const title=noticeDisplayTitle(r, t("tab_property")+" "+t("rule_sibling_role_notice")), displayTitle=cardCopy?plainTools.deShoutPropertyTitle(title):title;
  const mev=matchEvidence(title, matchText(r), terms);
  const noticeHref=`#notice/${encodeURIComponent(r.request_id)}`;
  const processStage=entry.process_stage;
  const processLabel=processStage?dispositionStageLabel(processStage):t("disposition_stage_unstaged");
  // Honesty: no live bid/attend CTA on a past-dated closed sale.
  const actionKey=closed ? "property_action_open_notice" : (entry.action_key||"property_action_open_notice");
  // Surplus-buyer prime position: ITEM + $ + method + close-date (lens organize fields).
  const itemLabel=glance && glance.item
    ? glance.item
    : (ASSET_LABEL[r._asset]?t(ASSET_LABEL[r._asset]):"");
  const priceLabel=r._badge || (glance && glance.price ? priceKindBadge(glance.price.kind, String(glance.price.display||"").replace(/^\$/,"")) : null);
  const methodKey=glance && glance.sale_method
    ? glance.sale_method
    : (commercial && commercial.sale_method && commercial.sale_method.method) || null;
  const methodLabel=methodKey
    ? t(({
        online_auction:"sale_method_online_auction",
        public_auction:"sale_method_public_auction",
        sealed_bid:"sale_method_sealed_bid",
        rfp:"sale_method_rfp",
        lease_auction:"sale_method_lease_auction",
      })[methodKey]||"sale_method_unknown")
    : "";
  const closeLabel=closeDate ? fdt(closeDate,{dateOnly:true}) : "";
  // Date chips use {date} only — never the price-fact `$` prefix template.
  const closeChipKey=closed ? "property_commercial_closed" : "property_commercial_close";
  // Build tag classes without multi-word English string literals (stray-english gate).
  // Reuse existing .tag.closed / .tag.open tokens (contrast-checked); do not invent dim past chips.
  const closeChipClass=["tag", closed?"closed":"open"].join(" ");
  const processChipClass=["tag", closed?"closed":"open"].join(" ");
  const commercialLead=`<div class="property-commercial-lead" data-commercial-glance="1">
    ${itemLabel?`<span class="tag asset">${escUiHtml(itemLabel)}</span>`:""}
    ${priceLabel?`<span class="tag amt">${priceLabel}</span>`:""}
    ${methodLabel?`<span class="tag method">${escUiHtml(methodLabel)}</span>`:""}
    ${Array.isArray(commercial?.event_views)&&commercial.event_views.length?propertyTimedEventChipsHTML(commercial,cardCopy?.event_kind?[cardCopy.event_kind]:[]):(closeLabel&&!cardCopy?.event_kind?`<span class="${closeChipClass}" data-close-chip="1">${escUiHtml(t(closeChipKey,{date:closeLabel}))}${closed?"":eventTag(closeDate)}</span>`:"")}
  </div>`;
  const dealLine=(!closed && glance && glance.deal)
    ? `<p class="property-deal-signal" data-deal-status="derived">${escUiHtml(glance.deal)}</p>`
    : "";
  const processLine=`<div class="property-process-line">
    <span class="${processChipClass}">${escUiHtml(closed?t("stage_past"):processLabel)}</span>
    ${entry.notice_count>1?`<span class="tag asset">${escUiHtml(t("property_chain_notice_count",{n:String(entry.notice_count)}))}</span>`:""}
    ${entry.bbl?`<span class="tag place">${parcelPivotHTML(entry.bbl)}</span>`:``}
  </div>`;
  const primaryActionKey=!closed&&cardCopy?.action_kind?"property_action_open_notice":actionKey;
  const primaryAction=`<a class="act${closed?"":" primary"}" aria-label="${escUiHtml(`${t(primaryActionKey)}: ${title}`)}" href="${noticeHref}">${t(primaryActionKey)}</a>`;
  const secondaryActions=[`<a class="act" href="${REQ_URL(r.request_id)}" ${EXT_ATTRS}>${t("city_record_link")}${extSR()}</a>`];
  if(entry.bbl && parcelLinks){
    const links=parcelLinks(entry.bbl);
    if(links?.zola_url) secondaryActions.push(`<a class="act" href="${escUiHtml(links.zola_url)}" ${EXT_ATTRS}>${t("property_action_lookup_zola")}${extSR()}</a>`);
  }
  // Live marketplace / RFP package is only honest while the sale is still open.
  if(!closed && commercial && commercial.participation && commercial.participation.package_url){
    secondaryActions.push(`<a class="act" href="${escUiHtml(commercial.participation.package_url)}" ${EXT_ATTRS}>${t("property_action_open_rfp")}${extSR()}</a>`);
  }
  secondaryActions.push(`<button class="act" type="button" data-link="${r.request_id}">${t("copy_link_btn")}</button>`);
  if(ev && !closed) secondaryActions.push(`<button class="act" type="button" data-ev="property:${r.request_id}">${t("add_date_btn",{date:fdt(ev)})}</button>`);
  const geometry=r._location?.geometry;
  const taxLot=r._location?.tax_lots?.[0];
  const blockLotQuery=geometry?"":(taxLot&&r._location?.boroughs?.length?`${taxLot.label}, ${r._location.boroughs[0]}, New York NY`:"");
  const mapQuery=geometry?`${geometry.latitude},${geometry.longitude}`:addr?`${addr} New York NY`:blockLotQuery;
  if(mapQuery) secondaryActions.push(`<a class="act" href="https://www.google.com/maps/search/${encodeURIComponent(mapQuery)}" ${EXT_ATTRS}>${t("map_link")}${extSR()}</a>`);
  if(addr) secondaryActions.push(`<button class="act" type="button" data-demo="${r.request_id}">${t("still_standing_btn")}</button>`);
  if(closed) secondaryActions.push(`<a class="act" href="/browse/property/">${t("property_related_current_sales")}</a>`);
  const titleBlock=cardCopy
    ? `<div class="ftitle property-card-summary" data-card-fact="${escUiHtml(cardCopy.fact_key||"")}" lang="en" dir="ltr"><a href="${noticeHref}">${escUiHtml(cardCopy.text)}</a></div>
      ${plainTools.propertyCardTitleDisclosureHTML({display_title_html:digTitleHTML(displayTitle,mev),original_title:title,open:mev?.field==="title"},{escape:escUiHtml})}`
    : `<div class="ftitle"><a href="${noticeHref}">${digTitleHTML(title,mev)}</a></div>`;
  const enablingInfo=readerTools?.propertyActionEnablingInfoHTML
    ?readerTools.propertyActionEnablingInfoHTML(r.property_reader_actions,{row:r,today:todayISO(),escape:escUiHtml,extAttrs:EXT_ATTRS,extSr:extSR})
    :"";
  return `<div class="fcard property-fcard${closed?" is-closed":""}" data-request-id="${escUiHtml(r.request_id||"")}" data-disposition-kind="${escUiHtml(entry.kind||"notice")}" data-process-stage="${escUiHtml(processStage||"unstaged")}" data-commercial-category="${escUiHtml(r._asset||"other")}" data-sale-method="${escUiHtml(methodKey||"")}" data-sale-eligible="${commercial&&commercial.sale_eligible===false?"0":"1"}" data-temporal-status="${closed?"closed":(entry.temporal_status||"open")}" data-closed="${closed?"1":"0"}">
      ${commercialLead}
      ${dealLine}
      <div class="ftype">${r.type_of_notice_description||""}${r.agency_name?" · "+pivotA(agencyHref(r.agency_name), r.agency_name):""}</div>
      ${processLine}
      ${entry.bbl?`<div class="tax-lien-card-slot" data-tax-lien-bbl="${escUiHtml(entry.bbl)}"></div>`:""}
      ${titleBlock}
      ${enablingInfo}
      ${propertyPlaceChips(r._location)}
      ${digEvidenceHTML(mev)}
      <div class="factions">${compactCardActions(primaryAction, secondaryActions)}</div>
    </div>`;
}
/** Format a cluster date range for the small-multiples card ("start – end", or one date). */
function propClusterRange(range){
  if(!range) return "";
  const a=range.start?fdt(range.start):"", b=range.end?fdt(range.end):"";
  if(a && b) return a===b ? a : `${a} – ${b}`;
  return a||b||"";
}
/**
 * Small-multiples collapse card (Tufte): a run of near-identical notices rendered as one
 * frame carrying the count and date range, expandable to each notice. Built from a
 * `kind:"cluster"` entry produced by clusterRepeatedEntries in property_explorer.mjs.
 */
function propertyClusterCardHTML(cluster,plainTools){
  const rep=cluster.primary||{};
  const assetKey=rep._asset||null;
  const itemLabel=assetKey && ASSET_LABEL[assetKey] ? t(ASSET_LABEL[assetKey]) : "";
  const stageLabel=cluster.process_stage?dispositionStageLabel(cluster.process_stage):"";
  const closed=cluster.temporal_status==="closed";
  const rangeLabel=propClusterRange(cluster.date_range);
  const description=cleanText(cluster.description)||cleanText(rep.agency_name)||cleanText(rep.type_of_notice_description)||t("property_cluster_fallback");
  const items=(cluster.members||[]).map(m=>{
    const r=m.primary; if(!r) return "";
    const title=noticeDisplayTitle(r, t("tab_property")+" "+t("rule_sibling_role_notice"));
    const cardCopy=plainTools?.ensurePropertyCardPlainSummary?.(r,{today:todayISO(),events:r.commercial?.timed_events||undefined,readerActions:r.property_reader_actions||undefined})||null;
    const displayTitle=cardCopy?plainTools.deShoutPropertyTitle(title):title;
    const href=`#notice/${encodeURIComponent(r.request_id)}`;
    const d=m.close_date||r.event_date||r.start_date||null;
    const source=cardCopy?plainTools.propertyCardTitleDisclosureHTML({display_title_html:escUiHtml(displayTitle),original_title:title,summary_suffix_html:d?`<span class="cl-date">${escUiHtml(fdt(d))}</span>`:"",body_suffix_html:` · <a href="${href}">${t("open_notice_btn")}</a>`},{escape:escUiHtml}):`<a href="${href}">${escUiHtml(title)}</a>${d?`<span class="cl-date">${escUiHtml(fdt(d))}</span>`:""}`;
    return `<li>${source}</li>`;
  }).join("");
  return `<div class="property-cluster${closed?" is-closed":""}" data-cluster="1" data-count="${cluster.count}">
    <div class="property-cluster-head">
      <span class="property-cluster-count">${escUiHtml(t("property_cluster_summary",{description,n:cluster.count}))}</span>
      ${itemLabel?`<span class="tag asset">${escUiHtml(itemLabel)}</span>`:""}
      ${stageLabel?`<span class="tag">${escUiHtml(stageLabel)}</span>`:""}
      ${rangeLabel?`<span class="property-cluster-range">${escUiHtml(rangeLabel)}</span>`:""}
    </div>
    <details>
      <summary>${escUiHtml(t("property_cluster_show"))}</summary>
      <ul class="property-cluster-list">${items}</ul>
    </details>
  </div>`;
}
/**
 * Badge the "More filters" summary with the count of active secondary facets so hidden
 * state stays visible even when the disclosure is collapsed (Norman: knowledge in the
 * world). The selected-filters summary row (data-search-state) carries the detail.
 */
function updatePropertyMoreFiltersState(){
  const active=[
    propSaleMethod!=="all",
    propPriceBand!=="all",
    propProcessSel!=="all",
    propStageSel!=="all",
    !!($("#propertyboro")?.value),
    !!propertyCommunityDistrict,
    !!propertyCouncilDistrict,
    !!(($("#propertyneighborhood")?.value||"").trim()),
    !!($("#propertyagency")?.value),
  ].filter(Boolean).length;
  const badge=$("#property-filter-badge");
  if(badge){
    if(active>0){ badge.textContent=t("property_filters_active",{n:active}); badge.hidden=false; }
    else { badge.textContent=""; badge.hidden=true; }
  }
}
const SALE_METHOD_BUCKETS=[
  ["online_auction","sale_method_online_auction"],
  ["public_auction","sale_method_public_auction"],
  ["sealed_bid","sale_method_sealed_bid"],
  ["rfp","sale_method_rfp"],
  ["lease_auction","sale_method_lease_auction"],
];
const PRICE_BAND_BUCKETS=[
  ["all","price_band_all"],
  ["priced","price_band_priced"],
  ["under_10k","price_band_under_10k"],
  ["10k_100k","price_band_10k_100k"],
  ["100k_plus","price_band_100k_plus"],
];
function normalizePropSaleMethod(raw){
  if(raw==null||raw===""||raw==="all") return "all";
  const key=String(raw).trim().toLowerCase().replace(/-/g,"_");
  return SALE_METHOD_BUCKETS.some(([k])=>k===key) ? key : "all";
}
function normalizePropPriceBand(raw){
  if(raw==null||raw===""||raw==="all") return "all";
  const key=String(raw).trim().toLowerCase().replace(/-/g,"_");
  return PRICE_BAND_BUCKETS.some(([k])=>k===key) ? key : "all";
}
function normalizePropSort(raw){
  const key=String(raw||"").trim().toLowerCase().replace(/-/g,"_");
  return ["closing_soon","newest","price_desc","price_asc"].includes(key) ? key : "closing_soon";
}
function propPriceBandOf(r){
  const commercial=r && r.commercial;
  const amount=commercial && commercial.primary_price && Number.isFinite(Number(commercial.primary_price.amount))
    ? Number(commercial.primary_price.amount)
    : (commercial && commercial.glance && commercial.glance.price && Number.isFinite(Number(commercial.glance.price.amount))
      ? Number(commercial.glance.price.amount) : null);
  if(amount==null) return null;
  // Product band thresholds (UX chips; not measured market data).
  if(amount<10000) return "under_10k"; // product threshold: under $10,000
  if(amount<100000) return "10k_100k"; // product threshold: $10,000–$99,999.99
  return "100k_plus"; // product threshold: $100,000+
}
function propSaleMethodOf(r){
  return (r && r.commercial && r.commercial.sale_method && r.commercial.sale_method.method) || null;
}
async function renderPropExplorer(){
  propAsset=normalizePropAsset(propAsset);
  propSaleMethod=normalizePropSaleMethod(propSaleMethod);
  propPriceBand=normalizePropPriceBand(propPriceBand);
  propSort=normalizePropSort(propSort);
  const sortEl=$("#propsort");
  if(sortEl && sortEl.value!==propSort) sortEl.value=propSort;
  if(sortEl && !sortEl.dataset.bound){
    sortEl.dataset.bound="1";
    sortEl.addEventListener("change",()=>{
      propSort=normalizePropSort(sortEl.value);
      renderPropExplorer();
      updateHash();
      renderSearchComponents("property");
    });
  }
  const [commercialTools,plainTools,readerTools,decisionData]=await Promise.all([
    propertyCommercialTools(),
    propertyPlainSummaryTools(),
    propertyReaderActionsTools(),
    propertyDecisionData(),
  ]);
  const {attachmentLookup,lifecycleHistory}=decisionData;
  propAll.forEach(r=>{
    // Bridge materializations produced before end_date joined the slim Worker
    // payload; refreshed payloads carry the same source field directly.
    if(!r.end_date&&lifecycleHistory?.[r.request_id]) r.end_date=lifecycleHistory[r.request_id];
    const attachments=Array.isArray(attachmentLookup?.[r.request_id])?attachmentLookup[r.request_id]:[];
    if(attachments.length&&commercialTools?.extractPropertyCommercial){
      r.attachments=attachments;
      r.commercial=commercialTools.extractPropertyCommercial(r,{attachments});
      if(typeof commercialTools.propertyTimedEventViews==="function") r.commercial.event_views=commercialTools.propertyTimedEventViews(r.commercial.timed_events||[]);
    }else ensurePropertyCommercial(r, commercialTools);
    if(readerTools?.extractPropertyReaderActions){
      r.property_reader_actions=readerTools.extractPropertyReaderActions(r,{
        today:todayISO(),
        events:r.commercial?.timed_events||[],
      });
    }
    plainTools?.ensurePropertyCardPlainSummary?.(r,{
      today:todayISO(),
      events:r.commercial?.timed_events||[],
      readerActions:r.property_reader_actions||undefined,
    });
    if(!r._asset){
      r._asset=classifyAsset(r);
      r._stage=propStage(r);
      r._badge=dollarBadge(r);
    } else {
      r._asset=normalizePropAsset(r._asset);
      if(!r._badge) r._badge=dollarBadge(r);
      if(!r._stage) r._stage=propStage(r);
    }
  });
  const neighborhoodInput=(($("#propertyneighborhood")?.value)||"").trim();
  const neighborhoodState=neighborhoodInput
    ?await import("../neighborhood_search.mjs")
      .then(tools=>tools.resolvePropertyNeighborhoodState(neighborhoodInput,propertyResolvedNeighborhood,propAll))
      .catch(()=>({place:null,communityDistrict:""}))
    :null;
  if(neighborhoodState){
    propertyResolvedNeighborhood=neighborhoodState.place;
    propertyCommunityDistrict=neighborhoodState.communityDistrict;
  }else if(propertyResolvedNeighborhood){
    propertyResolvedNeighborhood=null;
    propertyCommunityDistrict="";
  }
  if(propertyResolvedNeighborhood){
    $("#propertyboro").value=propertyResolvedNeighborhood.borough||"";
    $("#propertyneighborhood").value=propertyResolvedNeighborhood.name;
  }
  const tools=await propertyExplorerTools();
  const processRail=$("#processrail");
  const borough=$("#propertyboro")?.value||"", neighborhood=($("#propertyneighborhood")?.value||"").trim();
  const filterOptions={
    process: propProcessSel,
    asset: propAsset,
    saleMethod: propSaleMethod,
    priceBand: propPriceBand,
    temporal: propStageSel,
    temporalOf: propStage,
    assetOf: (r)=>r._asset||classifyAsset(r),
    commercialOf: (r)=>r.commercial||null,
    borough: borough||null,
    neighborhood: propertyCommunityDistrict?null:(neighborhood||null),
    communityDistricts: propertyResolvedNeighborhood&&propertyCommunityDistrict?[propertyCommunityDistrict]:[],
  };
  const allEntries=tools?.buildPropertyExplorerEntries
    ?tools.buildPropertyExplorerEntries(propAll, propSpines)
    :propAll.map(r=>({
      kind:"notice",
      primary:r,
      members:[r],
      notice_count:1,
      process_stage:r.disposition_stage||null,
      process_filter:r.disposition_stage||"unstaged",
      action_key:"property_action_open_notice",
      bbl:null,
      matched_phases:r.disposition_stage?[r.disposition_stage]:[],
    }));
  const fallbackEntriesFor=(overrides={})=>{
    const filters={...filterOptions,...overrides};
    return propAll
      .filter(r=>{
        if(filters.asset!=="all" && r._asset!==filters.asset) return false;
        if(filters.temporal!=="all" && r._stage!==filters.temporal) return false;
        if(filters.process!=="all" && (r.disposition_stage||"unstaged")!==filters.process) return false;
        if(filters.saleMethod!=="all" && propSaleMethodOf(r)!==filters.saleMethod) return false;
        if(filters.priceBand!=="all"){
          const band=propPriceBandOf(r);
          if(filters.priceBand==="priced"){ if(!band) return false; }
          else if(band!==filters.priceBand) return false;
        }
        // Only sale-method and price filters imply a commercial-sale scope. Item type
        // intentionally includes non-sale classes such as seized / unclaimed property.
        if((filters.saleMethod!=="all"||filters.priceBand!=="all")
          && r.commercial && r.commercial.sale_eligible===false) return false;
        if(borough && !(r._location?.boroughs||[]).includes(borough)) return false;
        if(propertyResolvedNeighborhood&&propertyCommunityDistrict && r._communityDistrict!==propertyCommunityDistrict) return false;
        if(neighborhood && !propertyCommunityDistrict && ![
          ...(r._location?.neighborhoods||[]),
          ...(r._location?.addresses||[]).map(address=>address.label),
        ].join(" ").toLowerCase().includes(neighborhood.toLowerCase())) return false;
        return true;
      })
      .map(r=>allEntries.find(entry=>entry.primary===r)||null)
      .filter(Boolean);
  };
  const parcelScopedEntries=(rows)=>propertyParcelScopeBbl
    ?rows.filter(entry=>String(entry?.bbl||"")===propertyParcelScopeBbl)
    :rows;
  const scopedEntries=(overrides={})=>parcelScopedEntries(tools?.filterPropertyExplorerEntries
    ?tools.filterPropertyExplorerEntries(allEntries,{...filterOptions,...overrides})
    :fallbackEntriesFor(overrides));
  const partitionEntries=(scoped)=>tools?.partitionPropertyExplorerEntries
    ?tools.partitionPropertyExplorerEntries(scoped,{today:todayISO()})
    :{
      default_entries:scoped,
      archive_entries:[],
      default_count:scoped.length,
      archive_count:0,
      census_total:scoped.length,
    };
  const partitionFor=(overrides={})=>partitionEntries(scopedEntries(overrides));
  const currentCountFor=(overrides={})=>partitionFor(overrides).default_count;
  const selectPropertyFacet=(apply)=>{
    apply();
    propertyView="default";
    const taxPanel=$("#tax-lien-sale-panel");
    if(taxPanel) taxPanel.hidden=true;
    renderPropExplorer();
    updateHash();
    renderSearchComponents("property");
  };
  const renderFacetRail=(el,values,selected,dataKey,overrideKey,normalize,apply)=>{
    if(!el) return;
    el.innerHTML=values.map(([key,label])=>`<button type="button" class="chip ${selected===key?'on':''}" data-${dataKey}="${key}" aria-pressed="${selected===key?'true':'false'}">${escUiHtml(t(label))}<span class="ct">${currentCountFor({[overrideKey]:key})}</span></button>`).join("");
    el.querySelectorAll(".chip").forEach(button=>button.addEventListener("click",()=>selectPropertyFacet(()=>apply(normalize?normalize(button.dataset[dataKey]):button.dataset[dataKey]))));
  };
  renderFacetRail($("#assettabs"),[["all","all_types"],...ASSET_BUCKETS],propAsset,"a","asset",normalizePropAsset,value=>{ propAsset=value; });
  renderFacetRail($("#salerail"),[["all","sale_method_all"],...SALE_METHOD_BUCKETS],propSaleMethod,"m","saleMethod",normalizePropSaleMethod,value=>{ propSaleMethod=value; });
  renderFacetRail($("#pricerail"),PRICE_BAND_BUCKETS,propPriceBand,"p","priceBand",normalizePropPriceBand,value=>{ propPriceBand=value; });
  renderFacetRail($("#liferail"),PROP_STAGES,propStageSel,"s","temporal",null,value=>{ propStageSel=value; });
  const processStages=tools?.PROP_PROCESS_STAGES||[["all","stage_all"]];
  renderFacetRail(processRail,processStages,propProcessSel,"p","process",null,value=>{ propProcessSel=value; });
  await renderDcasFleetInventory();

  const partition=partitionFor();
  let entries=propertyView==="archive"?partition.archive_entries:partition.default_entries;
  if(tools?.stampPropertyExplorerTemporal){
    entries=tools.stampPropertyExplorerTemporal(entries,{commercialOf:(r)=>r.commercial||null});
  }
  if(tools?.sortPropertyExplorerEntries){
    entries=tools.sortPropertyExplorerEntries(entries,propSort,(r)=>r.commercial||null);
  }
  const viewSwitch=$("#property-view-switch");
  if(viewSwitch){
    const viewOptions=[
      ["default","rule_phase_current",partition.default_count],
      ["archive","property_closed_section",partition.archive_count],
    ];
    viewSwitch.innerHTML=viewOptions.map(([key,label,count])=>`<button type="button" class="chip ${propertyView===key?'on':''}" data-property-view="${key}" aria-pressed="${propertyView===key?'true':'false'}">${escUiHtml(t(label))}<span class="ct">${count}</span></button>`).join("");
    viewSwitch.querySelectorAll("[data-property-view]").forEach(button=>button.addEventListener("click",()=>{
      propertyView=button.dataset.propertyView==="archive"?"archive":"default";
      const taxPanel=$("#tax-lien-sale-panel");
      if(taxPanel) taxPanel.hidden=true;
      renderPropExplorer();
      updateHash();
      renderSearchComponents("property");
    }));
  }

  // Small-multiples collapse (Tufte): runs of near-identical single notices → one card
  // carrying the count + date range. Applied within the selected current/archive view.
  if(tools && tools.clusterRepeatedEntries){
    entries=tools.clusterRepeatedEntries(entries);
  }
  try{
    const savedSearchTools=await import("../property_saved_search.mjs");
    propertyAuctionExportVisible=savedSearchTools.propertyAuctionExportRows(entries);
  }catch(_e){ propertyAuctionExportVisible=[]; }
  document.querySelectorAll("[data-export-property-auction]").forEach(button=>{
    button.hidden=propertyAuctionExportVisible.length===0;
    const count=button.querySelector("[data-property-auction-count]");
    if(count) count.textContent=`(${propertyAuctionExportVisible.length})`;
  });
  updatePropertyMoreFiltersState();
  const feedEl=$("#propertyfeed");
  if(!feedEl) return;
  const kwEl=$("#propertykw"), kw=kwEl?kwEl.value.trim():"", terms=kw?[kw]:[];
  // Export, print, and the result counter use request-id membership. Both
  // disposition cards and repeated-notice clusters expand back to every notice,
  // preserving the same cardinality as the stamped district bag.
  const visibleRows=[];
  entries.forEach(e=>{
    if(e.kind==="cluster"){
      (e.members||[]).forEach(member=>{
        (member?.members||[member?.primary]).forEach(row=>{ if(row) visibleRows.push(row); });
      });
    }else{
      (e.members||[e.primary]).forEach(row=>{ if(row) visibleRows.push(row); });
    }
  });
  const visibleRequestIds=new Set();
  feedVisible.property=visibleRows.filter(row=>{
    const requestId=String(row?.request_id||"");
    if(!requestId) return true;
    if(visibleRequestIds.has(requestId)) return false;
    visibleRequestIds.add(requestId);
    return true;
  });
  const totalCount=feedVisible.property.length;
  announce(t("property_entries_announce",{n:totalCount}));
  const countEl=$("#property-count");
  if(countEl) countEl.textContent=t("property_entries_announce",{n:totalCount});
  setExportBandVisibility(totalCount, "property-export-band", "property-export-overflow");
  if(!entries.length){
    const scopeLabels=[];
    if(propAsset!=="all") scopeLabels.push(t(ASSET_LABEL[propAsset]||"asset_other"));
    if(propSaleMethod!=="all") scopeLabels.push(t(SALE_METHOD_BUCKETS.find(([key])=>key===propSaleMethod)?.[1]||"sale_method_unknown"));
    if(propPriceBand!=="all") scopeLabels.push(t(PRICE_BAND_BUCKETS.find(([key])=>key===propPriceBand)?.[1]||"price_band_all"));
    if(propStageSel!=="all") scopeLabels.push(t(PROP_STAGES.find(([key])=>key===propStageSel)?.[1]||"stage_all"));
    if(propProcessSel!=="all") scopeLabels.push(t(processStages.find(([key])=>key===propProcessSel)?.[1]||"stage_all"));
    if(propertyResolvedNeighborhood?.name) scopeLabels.push(propertyResolvedNeighborhood.name);
    else if(neighborhood) scopeLabels.push(neighborhood);
    else if(borough) scopeLabels.push(borough);
    if(kw) scopeLabels.push(`“${kw}”`);
    const scopeLabel=scopeLabels.length?scopeLabels.join(" · "):t("tab_property");
    const alternateView=propertyView==="default"?"archive":"default";
    const alternateCount=alternateView==="archive"?partition.archive_count:partition.default_count;
    const alternateLabel=alternateView==="archive"?t("property_closed_section"):t("rule_phase_current");
    const alternateAction=alternateCount
      ?`<button type="button" class="act primary" data-property-empty-view="${alternateView}">${escUiHtml(alternateLabel)} <span class="ct">${alternateCount}</span></button>`
      :"";
    const hasFacetScope=propAsset!=="all"||propSaleMethod!=="all"||propPriceBand!=="all"||propStageSel!=="all"||propProcessSel!=="all"||!!borough||!!neighborhood||!!kw;
    const clearAction=hasFacetScope?`<button type="button" class="act" data-property-clear-scope>${escUiHtml(t("clear_filters_btn"))}</button>`:"";
    const followAction=propertyResolvedNeighborhood
      ?`<button type="button" class="act" data-follow-resolved-neighborhood>${escUiHtml(t("follow_this_area"))}</button>`
      :"";
    const defaultEmptyMessage=propertyView==="default"&&partition.default_count===0
      ?`<p>${escUiHtml(t("property_nothing_current"))}</p>`
      :"";
    const alertAction=propertyView==="default"&&partition.default_count===0
      ?`<button type="button" class="act" data-property-empty-watch>${escUiHtml(t("watch_this_search"))}</button>`
      :"";
    feedEl.innerHTML=`<div class="empty property-scope-empty" data-property-scope-empty="1">
      <p><strong>${escUiHtml(scopeLabel)}</strong></p>
      ${defaultEmptyMessage}
      <p><span>${escUiHtml(t("rule_phase_current"))} <b data-property-scope-current-count>${partition.default_count}</b></span> · <span>${escUiHtml(t("property_closed_section"))} <b data-property-scope-archive-count>${partition.archive_count}</b></span></p>
      <div class="factions">${alternateAction}${alertAction}${clearAction}${followAction}</div>
    </div>`;
    const alternate=feedEl.querySelector("[data-property-empty-view]");
    if(alternate) alternate.addEventListener("click",()=>{
      propertyView=alternate.dataset.propertyEmptyView==="archive"?"archive":"default";
      renderPropExplorer();
      updateHash();
      renderSearchComponents("property");
    });
    const clear=feedEl.querySelector("[data-property-clear-scope]");
    if(clear) clear.addEventListener("click",()=>{
      propAsset="all";
      propSaleMethod="all";
      propPriceBand="all";
      propStageSel="all";
      propProcessSel="all";
      propertyView="default";
      propertyCommunityDistrict="";
      propertyCouncilDistrict="";
      propertyResolvedNeighborhood=null;
      if($("#propertyboro")) $("#propertyboro").value="";
      if($("#propertyneighborhood")) $("#propertyneighborhood").value="";
      if($("#propertykw")) $("#propertykw").value="";
      renderPropExplorer();
      updateHash();
      renderSearchComponents("property");
    });
    const follow=feedEl.querySelector("[data-follow-resolved-neighborhood]");
    if(follow) follow.addEventListener("click",()=>watchFromFilters("property"));
    const alert=feedEl.querySelector("[data-property-empty-watch]");
    if(alert) alert.addEventListener("click",()=>watchFromFilters("property"));
    try{ renderSearchComponents("property"); }catch(_e){}
    return;
  }
  let parcelLinks=null;
  try{
    const locTools=await propertyLocationTools();
    parcelLinks=locTools.parcelLinksFromBbl;
  }catch(_e){}
  const cardFor=(e)=> e.kind==="cluster"
    ? propertyClusterCardHTML(e,plainTools)
    : propertyExplorerCardHTML(e,terms,parcelLinks,plainTools,readerTools);
  feedEl.innerHTML=entries.map(cardFor).join("");
  const followResolved=feedEl.querySelector("[data-follow-resolved-neighborhood]");
  if(followResolved) followResolved.addEventListener("click",()=>watchFromFilters("property"));
  feedEl.querySelectorAll("[data-link]").forEach(b=>b.addEventListener("click",()=>copyText(noticeLink(b.dataset.link), b)));
  feedEl.querySelectorAll("[data-ev]").forEach(b=>b.addEventListener("click",()=>{ const i=b.dataset.ev.indexOf(":"); downloadEventICS(feedRows[b.dataset.ev.slice(0,i)][b.dataset.ev.slice(i+1)]); }));
  feedEl.querySelectorAll("[data-demo]").forEach(b=>b.addEventListener("click",()=>checkDemolition(feedRows.property[b.dataset.demo], b)));
  const hydrate=()=>hydrateTaxLienBblSlots(feedEl).catch(()=>{});
  if("requestIdleCallback" in window) requestIdleCallback(hydrate,{timeout:2500}); else setTimeout(hydrate,250);
  // Keep the selected-filters summary + Clear in sync (covers deep-link / initial paint).
  try{ renderSearchComponents("property"); }catch(_e){}
}

/* ===== Tax-lien sale progression (cycle context on notices + archive panel).
   Primary product surface: inline on Property Disposition notices whose parcels
   appear on a DOF list (cycle position, deadline countdown, cohort leave rate,
   action rail). Standalone aggregate panel is archive-only via
   #property?view=tax-lien — not linked from the property lens header.
   Calibration stays cohort_statistic_only (no per-property probability).
   Final-sale stage = lien on the sale list, never foreclosure/title transfer. ===== */
let taxLienSummaryPromise=null, taxLienLookupPromise=null, taxLienSelectedCycle=null;
let taxLienCycleContextModPromise=null;
function taxLienCycleContextTools(){
  if(!taxLienCycleContextModPromise){
    taxLienCycleContextModPromise=import("../tax_lien_cycle_context.mjs").catch(()=>null);
  }
  return taxLienCycleContextModPromise;
}
function loadTaxLienSummary(){
  if(!taxLienSummaryPromise) taxLienSummaryPromise=fetch("data/tax_lien_sale_summary.json",{cache:"force-cache"}).then(r=>r.ok?r.json():null).catch(()=>null);
  return taxLienSummaryPromise;
}
function loadTaxLienLookup(){
  if(!taxLienLookupPromise) taxLienLookupPromise=fetch("data/tax_lien_sale_bbl.json",{cache:"force-cache"}).then(r=>r.ok?r.json():null).catch(()=>null);
  return taxLienLookupPromise;
}
function taxLienPct(rate){ return rate==null?"—":`${Math.round(Number(rate)*100)}%`; }
// Date-only source values are civic dates, not UTC instants. Anchor at local
// noon so US time zones never display the prior calendar day.
function taxLienDate(value){
  const day=String(value||"").slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fdt(value);
  const meta=(window.LANG_META||{})[window.LANG||"en"];
  return new Date(`${day}T12:00:00`).toLocaleDateString(meta?meta.intlDate:"en-US",{year:"numeric",month:"long",day:"numeric"});
}
function taxLienStageLabel(stage){
  return t({notice_90:"tax_lien_stage_90",notice_60:"tax_lien_stage_60",notice_30:"tax_lien_stage_30",notice_10:"tax_lien_stage_10",sold:"tax_lien_stage_sold"}[stage]||"tax_lien_stage_90");
}
function taxLienOutcomeLabel(outcome){ return t(outcome==="sold_lien"?"tax_lien_outcome_sold":"tax_lien_outcome_left"); }
function taxLienDecode(lookup,bbl){
  const raw=lookup?.rows?.[bbl]; if(!raw) return null;
  const keys=lookup.field_order||[]; return Object.fromEntries(keys.map((key,index)=>[key,raw[index]]));
}
function taxLienBblResultHTML(summary,lookup,bbl){
  const row=taxLienDecode(lookup,bbl);
  if(!row) return `<div class="tax-lien-result-card">${t("tax_lien_bbl_not_found",{bbl:escUiHtml(bbl),date:taxLienDate(summary.latest_cycle.data_vintage)})}</div>`;
  const cohort=summary.training.boroughs?.[row.borough_code]?.notice_90||summary.training.citywide.notice_90;
  return `<div class="tax-lien-result-card">
    <strong>BBL ${escUiHtml(bbl)}</strong> · ${escUiHtml(row.nta_name||row.nta_code||t("tax_lien_nta_unmapped"))}<br>
    ${t("tax_lien_bbl_observed_html",{stage:`<b>${escUiHtml(taxLienStageLabel(row.stage))}</b>`,outcome:`<b>${escUiHtml(taxLienOutcomeLabel(row.outcome))}</b>`})}
    <div class="tax-lien-meta">${t("tax_lien_attribution",{n:String(summary.training.cycle_count)})} · ${t("tax_lien_borough_pattern",{p:taxLienPct(cohort.probability_leave_before_sale)})}</div>
  </div>`;
}
function taxLienAreaTable(rows,areaLabel){
  return `<table class="tax-lien-table"><thead><tr><th>${escUiHtml(areaLabel)}</th><th>${t("tax_lien_table_listed")}</th><th>${t("tax_lien_table_sold")}</th><th>${t("tax_lien_table_left")}</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${escUiHtml(row.name)}</td><td>${Number(row.listed_90).toLocaleString()}</td><td>${Number(row.sold_lien).toLocaleString()}</td><td>${taxLienPct(row.left_before_sale_share)}</td></tr>`).join("")}</tbody></table>`;
}
/** Live or historical countdown line for exemption / payment-plan deadline. */
function taxLienDeadlineHTML(ctx){
  if(!ctx||!ctx.deadline) return "";
  const d=ctx.deadline;
  const date=taxLienDate(d.action_deadline);
  if(d.live && d.days_left!=null){
    if(d.state==="closing-soon"){
      return `<p class="tax-lien-deadline-live" data-deadline-state="closing-soon">${t("tax_lien_deadline_closing_soon",{date,n:String(d.days_left)})}</p>`;
    }
    return `<p class="tax-lien-deadline-live" data-deadline-state="open">${t("tax_lien_deadline_open",{date,n:String(d.days_left)})}</p>`;
  }
  if(d.state==="closed"||d.cycle_status==="expired"){
    return `<p class="tax-lien-deadline-live" data-deadline-state="closed">${t("tax_lien_deadline_closed",{date})}</p>`;
  }
  return date?`<p class="tax-lien-meta">${t("tax_lien_action_deadline",{date})}</p>`:"";
}
function taxLienStepperHTML(stepper){
  if(!Array.isArray(stepper)||!stepper.length) return "";
  return `<section class="tax-lien-stages"><h3>${t("tax_lien_stage_heading")}</h3><ol class="tax-lien-stepper lc-stepper" aria-label="${escUiHtml(t("tax_lien_cycle_stepper_aria"))}">${
    stepper.map(step=>{
      const aria=step.current?` aria-current="step"`:"";
      const meaningKey={notice_90:"tax_lien_stage_90_meaning",notice_60:"tax_lien_stage_60_meaning",notice_30:"tax_lien_stage_30_meaning",notice_10:"tax_lien_stage_10_meaning",sold:"tax_lien_stage_sold_meaning"}[step.id];
      return `<li><span class="lc-step ${escUiHtml(step.status)}"${aria}>${escUiHtml(taxLienStageLabel(step.id))}</span><span class="tax-lien-stage-meaning">${t(meaningKey)}</span></li>`;
    }).join("")
  }</ol></section>`;
}
function taxLienCycleStatusHTML(ctx){
  if(ctx?.deadline?.cycle_status!=="expired") return "";
  return `<p class="tax-lien-cycle-expired" data-tax-lien-cycle-status="expired">${t("tax_lien_cycle_expired_plain",{date:taxLienDate(ctx.deadline.sale_date)})}</p>`;
}
function taxLienActionsHTML(ctx){
  const checklist=Array.isArray(ctx?.resident_checklist)?ctx.resident_checklist:[];
  if(!checklist.length) return "";
  const keys={
    exemptions:["tax_lien_checklist_exemptions","tax_lien_checklist_exemptions_meaning"],
    payment_plans:["tax_lien_checklist_payment_plans","tax_lien_checklist_payment_plans_meaning"],
    official_guide:["tax_lien_checklist_official_guide","tax_lien_checklist_official_guide_meaning"],
  };
  return `<section class="tax-lien-actions" data-tax-lien-actions="1" data-tax-lien-resident-checklist="1">
    <h3>${t("tax_lien_checklist_heading")}</h3>
    <ol>${checklist.map(step=>{
      const pair=keys[step.id]; if(!pair||!step.url) return "";
      return `<li><a href="${escUiHtml(step.url)}" ${EXT_ATTRS}>${t(pair[0])}${extSR()}</a><p>${t(pair[1])}</p></li>`;
    }).join("")}</ol>
    <p class="tax-lien-no-tracking">${t("tax_lien_no_lot_tracking")}</p>
    ${ctx.action_channels?.phone?`<p class="tax-lien-support"><a href="tel:${escUiHtml(ctx.action_channels.phone)}">${t("tax_lien_call_311")}</a></p>`:""}
  </section>`;
}
/** Notice detail: cycle position + countdown + historical context + actions + scoped BBLs. */
function taxLienNoticeCycleHTML(ctx){
  if(!ctx) return "";
  const hist=ctx.historical_context;
  const lead=hist
    ?`<p class="tax-lien-lead" data-tax-lien-historical="1">${escUiHtml(hist.line)}</p>`
    :"";
  const parcels=(ctx.parcels||[]).map(p=>
    `<li><strong>BBL ${escUiHtml(p.bbl)}</strong> · ${escUiHtml(taxLienStageLabel(p.stage))} · ${escUiHtml(taxLienOutcomeLabel(p.outcome))}${p.nta_name?` · ${escUiHtml(p.nta_name)}`:""}</li>`
  ).join("");
  const parcelBlock=parcels
    ?`<ul class="tax-lien-parcel-list" data-tax-lien-parcels="1">${parcels}</ul>`
    :"";
  const vintage=ctx.data_vintage
    ?`<p class="tax-lien-meta">${t("tax_lien_vintage",{date:taxLienDate(ctx.data_vintage)})}</p>`
    :"";
  return `<section class="tax-lien-panel tax-lien-cycle-context" data-tax-lien-cycle-context="1" data-tax-lien-stage="${escUiHtml(ctx.stage||"")}" aria-label="${escUiHtml(t("tax_lien_heading"))}">
    <h2>${t("tax_lien_heading")}</h2>
    <p class="tax-lien-deck">${t("tax_lien_deck_html")}</p>
    ${lead}
    ${taxLienCycleStatusHTML(ctx)}
    ${taxLienDeadlineHTML(ctx)}
    ${taxLienActionsHTML(ctx)}
    ${taxLienStepperHTML(ctx.stepper)}
    ${parcelBlock}
    ${vintage}
    <p class="tax-lien-meta">${t("tax_lien_cohort_only")}</p>
    <div class="lc-pct"><a href="about.html#tax-lien-sale-predictions">${t("tax_lien_formula_link")}</a></div>
  </section>`;
}
/** Compact list-card note: stage + leave rate + deadline state. */
function taxLienCardNoteHTML(ctx){
  if(!ctx) return "";
  const stage=taxLienStageLabel(ctx.stage);
  const outcome=taxLienOutcomeLabel(ctx.outcome);
  const pct=ctx.historical_context&&ctx.historical_context.leave_pct!=null
    ?`${ctx.historical_context.leave_pct}%`
    :null;
  const hist=pct
    ?` · ${t("tax_lien_card_leave_rate",{p:pct})}`
    :"";
  let deadline="";
  if(ctx.deadline&&ctx.deadline.live&&ctx.deadline.days_left!=null){
    deadline=` <span class="tax-lien-card-deadline" data-deadline-state="${escUiHtml(ctx.deadline.state)}">${t("tax_lien_card_deadline_live",{n:String(ctx.deadline.days_left),date:taxLienDate(ctx.deadline.action_deadline)})}</span>`;
  } else if(ctx.deadline&&(ctx.deadline.state==="closed"||ctx.deadline.cycle_status==="expired")){
    deadline=` <span class="tax-lien-card-deadline" data-deadline-state="closed">${t("tax_lien_card_deadline_closed",{date:taxLienDate(ctx.deadline.action_deadline)})}</span>`;
  }
  return `<div class="tax-lien-card-note" data-tax-lien-card-context="1" data-tax-lien-stage="${escUiHtml(ctx.stage||"")}">${t("tax_lien_card_html",{stage:escUiHtml(stage),outcome:escUiHtml(outcome),date:taxLienDate(ctx.data_vintage)})}${hist}${deadline}</div>`;
}
function taxLienPanelHTML(summary,guide=null){
  const rate=summary.training.citywide.notice_90.probability_leave_before_sale;
  const cycle=summary.cycles.find(row=>row.cycle_id===(taxLienSelectedCycle||summary.latest_cycle.cycle_id))||summary.cycles.at(-1);
  taxLienSelectedCycle=cycle.cycle_id;
  const options=summary.cycles.map(row=>`<option value="${escUiHtml(row.cycle_id)}"${row.cycle_id===cycle.cycle_id?" selected":""}>${taxLienDate(row.cycle_id)}</option>`).join("");
  // Archive posture: full tables behind a disclosure so the deep link stays useful without being a lens destination.
  return `<h2>${t("tax_lien_heading")}</h2>
    <p class="tax-lien-archive-note" data-tax-lien-archive-note="1">${t("tax_lien_archive_note_html")}</p>
    <p class="tax-lien-deck">${t("tax_lien_deck_html")}</p>
    <p class="tax-lien-lead">${t("tax_lien_action_lead_html",{p:taxLienPct(rate)})}</p>
    <p class="tax-lien-meta">${t("tax_lien_attribution",{n:String(summary.training.cycle_count)})} · ${t("tax_lien_vintage",{date:taxLienDate(summary.latest_cycle.data_vintage)})}</p>
    ${taxLienCycleStatusHTML(guide)}
    ${taxLienDeadlineHTML(guide)}
    ${taxLienActionsHTML(guide)}
    ${taxLienStepperHTML(guide?.stepper)}
    <p class="tax-lien-meta">${t("tax_lien_cohort_only")}</p>
    <div class="tax-lien-lookup"><label for="tax-lien-bbl">${t("tax_lien_lookup_label")}</label><input id="tax-lien-bbl" type="text" inputmode="numeric" maxlength="10" placeholder="${escUiHtml(t("tax_lien_lookup_placeholder"))}"><button type="button" id="tax-lien-bbl-go">${t("tax_lien_lookup_button")}</button><div class="tax-lien-result" id="tax-lien-bbl-result"></div></div>
    <details class="inline-disclose tax-lien-archive-tables" data-tax-lien-archive-tables="1">
      <summary>${t("tax_lien_archive_tables_summary")}</summary>
      <div class="inline-disclose-body">
        <div class="field" style="max-width:260px;margin-top:10px"><label for="tax-lien-cycle">${t("tax_lien_cycle_label")}</label><select id="tax-lien-cycle">${options}</select></div>
        <div class="tax-lien-areas"><div class="tax-lien-area" tabindex="0"><h3>${t("tax_lien_borough_heading")}</h3>${taxLienAreaTable(cycle.boroughs,t("borough_label"))}</div><div class="tax-lien-area" tabindex="0"><h3>${t("tax_lien_nta_heading")}</h3><div class="tax-lien-nta-scroll" role="region" tabindex="0" aria-label="${escUiHtml(t("tax_lien_nta_heading"))}">${taxLienAreaTable(cycle.ntas,"NTA")}</div></div></div>
      </div>
    </details>
    <div class="lc-pct" style="margin-top:10px"><a href="about.html#tax-lien-sale-predictions">${t("tax_lien_formula_link")}</a></div>`;
}
async function paintTaxLienSalePanel(){
  const el=$("#tax-lien-sale-panel"); if(!el) return;
  const [summary,mod]=await Promise.all([loadTaxLienSummary(),taxLienCycleContextTools()]);
  if(!summary){ el.innerHTML=`<div class="empty">${t("could_not_reach")}</div>`; return; }
  const guide=mod?.buildTaxLienCycleGuide?mod.buildTaxLienCycleGuide(summary,"sold"):null;
  el.innerHTML=taxLienPanelHTML(summary,guide);
  $("#tax-lien-cycle")?.addEventListener("change",event=>{taxLienSelectedCycle=event.target.value;paintTaxLienSalePanel();});
  $("#tax-lien-bbl-go")?.addEventListener("click",async()=>{
    const input=$("#tax-lien-bbl"), result=$("#tax-lien-bbl-result");
    const bbl=String(input?.value||"").replace(/\D/g,"");
    if(!/^\d{10}$/.test(bbl)){ result.innerHTML=`<div class="tax-lien-result-card">${t("tax_lien_lookup_invalid")}</div>`; return; }
    result.innerHTML=`<span class="loading"></span>`;
    const lookup=await loadTaxLienLookup();
    result.innerHTML=lookup?taxLienBblResultHTML(summary,lookup,bbl):`<div class="empty">${t("could_not_reach")}</div>`;
  });
}
async function hydrateTaxLienBblSlots(root=document){
  const slots=[...root.querySelectorAll("[data-tax-lien-bbl]")]; if(!slots.length) return;
  const [summary,lookup,mod]=await Promise.all([loadTaxLienSummary(),loadTaxLienLookup(),taxLienCycleContextTools()]);
  if(!summary||!lookup) return;
  slots.forEach(slot=>{
    const bbl=slot.dataset.taxLienBbl;
    let ctx=null;
    if(mod&&mod.buildTaxLienCycleContext){
      ctx=mod.buildTaxLienCycleContext({ summary, lookup, bbl });
    }
    if(ctx){ slot.innerHTML=taxLienCardNoteHTML(ctx); return; }
    const row=taxLienDecode(lookup,bbl); if(!row) return;
    slot.innerHTML=`<div class="tax-lien-card-note">${t("tax_lien_card_html",{stage:escUiHtml(taxLienStageLabel(row.stage)),outcome:escUiHtml(taxLienOutcomeLabel(row.outcome)),date:taxLienDate(summary.latest_cycle.data_vintage)})}</div>`;
  });
}
async function loadTaxLienForNotice(r,el){
  if(!el) return;
  let location=r?.property_location||null;
  let bbl=r?._property_bbl||null;
  if(!bbl||!location){
    try{
      const tools=await propertyLocationTools();
      location=location||tools.propertyLocationFromRow(r);
      bbl=bbl||tools.primaryPropertyBbl(location);
      if(bbl) r._property_bbl=bbl;
    }catch(_e){}
  }
  const [summary,lookup,mod]=await Promise.all([loadTaxLienSummary(),loadTaxLienLookup(),taxLienCycleContextTools()]);
  if(!summary||!lookup){ el.innerHTML=""; return; }
  let ctx=null;
  if(mod&&mod.buildTaxLienCycleContext){
    ctx=mod.buildTaxLienCycleContext({ summary, lookup, notice:r, location, bbl });
  }
  if(ctx){
    el.innerHTML=taxLienNoticeCycleHTML(ctx);
    return;
  }
  // Fallback: single-BBL decode without pure module.
  if(!bbl){ el.innerHTML=""; return; }
  const row=taxLienDecode(lookup,bbl); if(!row){ el.innerHTML=""; return; }
  const guide=mod?.buildTaxLienCycleGuide?mod.buildTaxLienCycleGuide(summary,row.stage):null;
  el.innerHTML=`<section class="tax-lien-panel tax-lien-cycle-context" data-tax-lien-cycle-context="1"><h2>${t("tax_lien_heading")}</h2>${taxLienBblResultHTML(summary,lookup,bbl)}${taxLienCycleStatusHTML(guide)}${taxLienDeadlineHTML(guide)}${taxLienStepperHTML(guide?.stepper)}${taxLienActionsHTML(guide)}<p class="tax-lien-meta">${t("tax_lien_deck_html")}</p></section>`;
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.ASSET_BUCKETS = ASSET_BUCKETS;
globalThis.ASSET_LABEL = ASSET_LABEL;
globalThis.PROP_STAGES = PROP_STAGES;
globalThis.classifyAsset = classifyAsset;
globalThis.normalizePropAsset = normalizePropAsset;
globalThis.dispositionStageLabel = dispositionStageLabel;
globalThis.dollarBadge = dollarBadge;
globalThis.loadPropertyCommercialDetail = loadPropertyCommercialDetail;
globalThis.loadPropertyPlainSummary = loadPropertyPlainSummary;
globalThis.propertyCommercialDetailHTML = propertyCommercialDetailHTML;
globalThis.franchiseConcessionSpineHTML = franchiseConcessionSpineHTML;
globalThis.franchisePhaseSpineTools = franchisePhaseSpineTools;
globalThis.franchiseStageLabel = franchiseStageLabel;
globalThis.hydrateTaxLienBblSlots = hydrateTaxLienBblSlots;
globalThis.hydratePropertyActionMatter = hydratePropertyActionMatter;
globalThis.inferFranchiseStageFromNotice = inferFranchiseStageFromNotice;
globalThis.isFranchiseConcessionNoticeEligible = isFranchiseConcessionNoticeEligible;
globalThis.isPropertyDispositionEligible = isPropertyDispositionEligible;
globalThis.loadFranchiseConcessionSpine = loadFranchiseConcessionSpine;
globalThis.loadPropertyCrossDomain = loadPropertyCrossDomain;
globalThis.loadPropertyDispositionSpine = loadPropertyDispositionSpine;
globalThis.loadTaxLienForNotice = loadTaxLienForNotice;
globalThis.loadTaxLienLookup = loadTaxLienLookup;
globalThis.loadTaxLienSummary = loadTaxLienSummary;
globalThis.paintTaxLienSalePanel = paintTaxLienSalePanel;
globalThis.paintParcelBiographyPanel = paintParcelBiographyPanel;
globalThis.parcelPivotHTML = parcelPivotHTML;
globalThis.propStage = propStage;
globalThis.propertyDispositionSpineHTML = propertyDispositionSpineHTML;
globalThis.propertyDispositionTimingHTML = propertyDispositionTimingHTML;
globalThis.propertyExplorerCardHTML = propertyExplorerCardHTML;
globalThis.propertyExplorerTools = propertyExplorerTools;
globalThis.propertyPhaseSpineTools = propertyPhaseSpineTools;
globalThis.renderPropExplorer = renderPropExplorer;
globalThis.taxLienActionsHTML = taxLienActionsHTML;
globalThis.taxLienAreaTable = taxLienAreaTable;
globalThis.taxLienBblResultHTML = taxLienBblResultHTML;
globalThis.taxLienCardNoteHTML = taxLienCardNoteHTML;
globalThis.taxLienCycleContextTools = taxLienCycleContextTools;
globalThis.taxLienDate = taxLienDate;
globalThis.taxLienDeadlineHTML = taxLienDeadlineHTML;
globalThis.taxLienDecode = taxLienDecode;
globalThis.taxLienNoticeCycleHTML = taxLienNoticeCycleHTML;
globalThis.taxLienOutcomeLabel = taxLienOutcomeLabel;
globalThis.taxLienPanelHTML = taxLienPanelHTML;
globalThis.taxLienPct = taxLienPct;
globalThis.taxLienStageLabel = taxLienStageLabel;
globalThis.taxLienStepperHTML = taxLienStepperHTML;
Object.defineProperty(globalThis, "franchisePhaseSpineToolsPromise", { configurable: true, get: () => franchisePhaseSpineToolsPromise, set: value => { franchisePhaseSpineToolsPromise = value; } });
Object.defineProperty(globalThis, "propAll", { configurable: true, get: () => propAll, set: value => { propAll = value; } });
Object.defineProperty(globalThis, "propAsset", { configurable: true, get: () => propAsset, set: value => { propAsset = value; } });
Object.defineProperty(globalThis, "propProcessSel", { configurable: true, get: () => propProcessSel, set: value => { propProcessSel = value; } });
Object.defineProperty(globalThis, "propSaleMethod", { configurable: true, get: () => propSaleMethod, set: value => { propSaleMethod = value; } });
Object.defineProperty(globalThis, "propPriceBand", { configurable: true, get: () => propPriceBand, set: value => { propPriceBand = value; } });
Object.defineProperty(globalThis, "propSort", { configurable: true, get: () => propSort, set: value => { propSort = value; } });
Object.defineProperty(globalThis, "propSpines", { configurable: true, get: () => propSpines, set: value => { propSpines = value; } });
Object.defineProperty(globalThis, "propStageSel", { configurable: true, get: () => propStageSel, set: value => { propStageSel = value; } });
Object.defineProperty(globalThis, "propertyView", { configurable: true, get: () => propertyView, set: value => { propertyView = value === "archive" ? "archive" : "default"; } });
Object.defineProperty(globalThis, "propertyParcelScopeBbl", { configurable: true, get: () => propertyParcelScopeBbl, set: value => { propertyParcelScopeBbl = /^\d{10}$/.test(String(value||"")) ? String(value) : null; } });
globalThis.normalizePropSaleMethod = normalizePropSaleMethod;
globalThis.normalizePropPriceBand = normalizePropPriceBand;
globalThis.normalizePropSort = normalizePropSort;
Object.defineProperty(globalThis, "propertyExplorerToolsPromise", { configurable: true, get: () => propertyExplorerToolsPromise, set: value => { propertyExplorerToolsPromise = value; } });
Object.defineProperty(globalThis, "propertyCommunityDistrict", { configurable: true, get: () => propertyCommunityDistrict, set: value => { propertyCommunityDistrict = value || ""; } });
Object.defineProperty(globalThis, "propertyCouncilDistrict", { configurable: true, get: () => propertyCouncilDistrict, set: value => { propertyCouncilDistrict = value || ""; } });
Object.defineProperty(globalThis, "propertyResolvedNeighborhood", { configurable: true, get: () => propertyResolvedNeighborhood, set: value => { propertyResolvedNeighborhood = value || null; } });
Object.defineProperty(globalThis, "propertyAuctionExportVisible", { configurable: true, get: () => propertyAuctionExportVisible, set: value => { propertyAuctionExportVisible = value; } });
Object.defineProperty(globalThis, "propertyPhaseSpineToolsPromise", { configurable: true, get: () => propertyPhaseSpineToolsPromise, set: value => { propertyPhaseSpineToolsPromise = value; } });
Object.defineProperty(globalThis, "taxLienLookupPromise", { configurable: true, get: () => taxLienLookupPromise, set: value => { taxLienLookupPromise = value; } });
Object.defineProperty(globalThis, "taxLienSelectedCycle", { configurable: true, get: () => taxLienSelectedCycle, set: value => { taxLienSelectedCycle = value; } });
Object.defineProperty(globalThis, "taxLienSummaryPromise", { configurable: true, get: () => taxLienSummaryPromise, set: value => { taxLienSummaryPromise = value; } });
