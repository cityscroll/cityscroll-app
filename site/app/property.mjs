/* ===== Franchise / concession review process spine (FCRC multi-notice chain).
   Reconstructs solicitation → public hearing → committee meeting → award for one
   franchise/concession agreement or annual plan, joined by counterparty stem,
   plan year, or FCRC rules subject. Empty stages stay class-(a). ===== */
function isFranchiseConcessionNoticeEligible(r){
  if(!r) return false;
  const agency=String(r.agency_name||"");
  const title=cleanText(r.short_title||"");
  const body=cleanText(r.additional_description_1||"");
  const hay=`${title} ${body}`;
  if(/city council/i.test(agency) && /zoning and franchises/i.test(hay)) return false;
  if(/^franchise and concession review committee$/i.test(agency)) return true;
  if(/^mayor'?s office of contract services$/i.test(agency) && /\bFCRC\b|franchise and concession/i.test(hay)) return true;
  if(/\bFCRC\b/i.test(hay)) return true;
  if(/franchise and concession review committee/i.test(hay)) return true;
  if(/proposed (?:information services )?franchise agreement/i.test(hay)) return true;
  return false;
}
function franchiseStageLabel(kind){
  if(kind==="solicitation") return t("franchise_stage_solicitation");
  if(kind==="public_hearing") return t("franchise_stage_public_hearing");
  if(kind==="committee_meeting") return t("franchise_stage_committee_meeting");
  if(kind==="award") return t("franchise_stage_award");
  return kind || "—";
}
/** Infer process stage from the notice type/title when the spine has not stamped yet. */
function inferFranchiseStageFromNotice(r){
  if(!r) return null;
  if(r.franchise_stage) return r.franchise_stage;
  const type=String(r.type_of_notice_description||"");
  const title=cleanText(r.short_title||"");
  const body=cleanText(r.additional_description_1||"");
  const hay=`${title} ${body}`;
  // Publisher type labels matched via regex (not string literals) so stray-english stays green.
  if(/^Award$/i.test(type) || /\b(?:has been awarded|award of (?:the )?(?:franchise|concession)|franchise has been granted)\b/i.test(hay)) return "award";
  if(/^Solicitation$/i.test(type) || (/\b(?:request for proposals?|\brfp\b|solicitation)\b/i.test(hay) && !/\bpublic hearing\b/i.test(hay))) return "solicitation";
  if(/^Meeting$/i.test(type) || /\bpublic meeting\b/i.test(title) || /\bFCRC\b.*\bmeeting\b/i.test(title)) return "committee_meeting";
  if(/^Public Hearings$/i.test(type) || /\bpublic hearing\b/i.test(hay) || /\bFCRC\b.*\bhearing\b/i.test(hay)) return "public_hearing";
  return null;
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
  const keyNote = (join.keys && join.keys.length)
    ? t("franchise_join_matched_html",{
        method: escUiHtml(join.method || "—"),
        n: String(join.notice_count || 0),
        subject: escUiHtml(spine.subject_ref || "—")
      })
    : t("franchise_join_singleton_html",{
        title: escUiHtml(cleanText(notice && notice.short_title) || (notice && notice.request_id) || "—")
      });

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
        return `<li><span class="lc-step ${cls}"${aria} title="${escUiHtml(franchiseStageLabel(p.id))}">${escUiHtml(p.short||franchiseStageLabel(p.id))}</span>${arrow}</li>`;
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
      const when=p.primary?.when?fdate(p.primary.when):"—";
      const title=p.primary?.title?cleanText(p.primary.title):"";
      const more=p.notice_count>1
        ?` · ${t("franchise_stage_notice_count",{n:String(p.notice_count)})}`
        :"";
      // Aggregate verbatim-repeated titles under one line when multiple notices share wording.
      const aggNote=(Array.isArray(p.aggregates) && p.aggregates.length===1 && p.aggregates[0].count>1)
        ?` · ${t("franchise_stage_notice_count",{n:String(p.aggregates[0].count)})}`
        :"";
      const noticeLink=p.primary?.request_id
        ?`<div class="lc-pct"><a href="#notice/${escUiHtml(p.primary.request_id)}">${escUiHtml(p.primary.request_id)}</a>${more||aggNote}</div>`
        :((more||aggNote)?`<div class="lc-pct">${more||aggNote}</div>`:"");
      // One outbound source family per phase (deduped).
      const sourceLink=p.source_url
        ?`<div class="lc-pct"><a href="${escUiHtml(p.source_url)}" ${EXT_ATTRS}>${t("view_in_city_record")}${extSR()}</a></div>`
        :"";
      return `<div class="stage"><div class="box matched">
        <div class="stage-name">${franchiseStageLabel(p.id)}</div>
        <div class="when">${escUiHtml(when)}</div>
        ${title?`<div class="lc-pct" lang="en" dir="ltr">${escUiHtml(title)}</div>`:""}
        ${noticeLink}
        ${sourceLink}
      </div></div>`;
    }).join('<div class="connector" aria-hidden="true">→</div>');
    return `<section class="franchise-spine" data-franchise-spine="1" data-franchise-phase="1" aria-label="${escUiHtml(t("franchise_spine_heading"))}">
      <div class="chain-h">${t("franchise_spine_heading")}</div>
      <div class="note">${keyNote}</div>
      ${actionLead}
      ${stepper}
      <div class="chain franchise-phase-cards">${cards}</div>
      <div class="note">${t("franchise_provenance_html")}</div>
    </section>`;
  }

  // Flat fallback when the phase module is unavailable.
  const stages = Array.isArray(spine.stages) ? spine.stages : [];
  let chain = "";
  stages.forEach((stage, idx) => {
    const matched = stage && stage.matched;
    const stageEvents = Array.isArray(stage.events) ? stage.events : [];
    const primary = stageEvents[0] || null;
    const when = primary?.time?.value ? fdate(primary.time.value) : "—";
    const title = primary ? (cleanText(primary.title) || "—") : "";
    const more = stage.notice_count > 1
      ? ` · ${t("franchise_stage_notice_count",{n:String(stage.notice_count)})}`
      : "";
    const noticeLink = primary?.request_id
      ? `<div class="lc-pct"><a href="#notice/${escUiHtml(primary.request_id)}">${escUiHtml(primary.request_id)}</a>${more}</div>`
      : (more ? `<div class="lc-pct">${more}</div>` : "");
    if(matched){
      chain += `<div class="stage"><div class="box matched">
        <div class="stage-name">${franchiseStageLabel(stage.kind)}</div>
        <div class="when">${escUiHtml(when)}</div>
        ${title?`<div class="lc-pct" lang="en" dir="ltr">${escUiHtml(title)}</div>`:""}
        ${noticeLink}
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
    <div class="note">${keyNote}</div>
    <div class="chain">${chain}</div>
    <div class="note">${t("franchise_provenance_html")}</div>
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
  return `<div class="note disposition-timing-estimate" data-property-disposition-timing="1" data-disposition-timing-projection="${escUiHtml(estimate.public_projection||"cohort_statistic_only")}">${t("disposition_timing_estimate_html",{line,tag})}${cohortNote}${formula}</div>`;
}
function propertyDispositionSpineHTML(spine, notice, phaseView){
  if(!spine) return "";
  const join = spine.join || {};
  const keyNote = (join.keys && join.keys.length)
    ? t("disposition_join_matched_html",{
        method: escUiHtml(join.method || "—"),
        n: String(join.notice_count || 0),
        subject: escUiHtml(spine.subject_ref || "—")
      })
    : t("disposition_join_singleton_html",{
        title: escUiHtml(cleanText(notice && notice.short_title) || (notice && notice.request_id) || "—")
      });
  const timingEstimate=phaseView && phaseView.disposition_timing_estimate
    ? propertyDispositionTimingHTML(phaseView.disposition_timing_estimate)
    : "";

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
        return `<li><span class="lc-step ${cls}"${aria} title="${escUiHtml(dispositionStageLabel(p.id))}">${escUiHtml(p.short||dispositionStageLabel(p.id))}</span>${arrow}</li>`;
      }).join("")
    }</ol>`;
    // Detail cards only for matched phases — empty stages stay stepper chips only
    // (absent means absent; no per-stage "not yet shown" explainer).
    const matchedPhases=phaseView.phases.filter(p=>p.matched);
    const cards=matchedPhases.map(p=>{
      const when=p.primary?.when?fdate(p.primary.when):"—";
      const title=p.primary?.title?cleanText(p.primary.title):"";
      const more=p.notice_count>1
        ?` · ${t("disposition_stage_notice_count",{n:String(p.notice_count)})}`
        :"";
      // Aggregate verbatim-repeated titles under one line when multiple notices share wording.
      const aggNote=(Array.isArray(p.aggregates) && p.aggregates.length===1 && p.aggregates[0].count>1)
        ?` · ${t("disposition_stage_notice_count",{n:String(p.aggregates[0].count)})}`
        :"";
      const noticeLink=p.primary?.request_id
        ?`<div class="lc-pct"><a href="#notice/${escUiHtml(p.primary.request_id)}">${escUiHtml(p.primary.request_id)}</a>${more||aggNote}</div>`
        :((more||aggNote)?`<div class="lc-pct">${more||aggNote}</div>`:"");
      // One outbound source family per phase (deduped).
      const sourceLink=p.source_url
        ?`<div class="lc-pct"><a href="${escUiHtml(p.source_url)}" ${EXT_ATTRS}>${t("view_in_city_record")}${extSR()}</a></div>`
        :"";
      return `<div class="stage"><div class="box matched">
        <div class="stage-name">${dispositionStageLabel(p.id)}</div>
        <div class="when">${escUiHtml(when)}</div>
        ${title?`<div class="lc-pct" lang="en" dir="ltr">${escUiHtml(title)}</div>`:""}
        ${noticeLink}
        ${sourceLink}
      </div></div>`;
    }).join('<div class="connector" aria-hidden="true">→</div>');
    const how=`<details class="inline-disclose lc-how"><summary>${t("lifecycle_how_summary")}</summary><div class="inline-disclose-body">${keyNote}<div class="note" style="margin-top:8px">${t("disposition_provenance_html")}</div></div></details>`;
    return `<div class="chain-h">${t("disposition_spine_heading")}</div>
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
    const primary = stageEvents[0] || null;
    const when = primary?.time?.value ? fdate(primary.time.value) : "—";
    const title = primary ? (cleanText(primary.title) || "—") : "";
    const more = stage.notice_count > 1
      ? ` · ${t("disposition_stage_notice_count",{n:String(stage.notice_count)})}`
      : "";
    const noticeLink = primary?.request_id
      ? `<div class="lc-pct"><a href="#notice/${escUiHtml(primary.request_id)}">${escUiHtml(primary.request_id)}</a>${more}</div>`
      : (more ? `<div class="lc-pct">${more}</div>` : "");
    chain += `<div class="stage"><div class="box matched">
      <div class="stage-name">${dispositionStageLabel(stage.kind)}</div>
      <div class="when">${escUiHtml(when)}</div>
      ${title?`<div class="lc-pct" lang="en" dir="ltr">${escUiHtml(title)}</div>`:""}
      ${noticeLink}
    </div></div>`;
    if(idx < stages.length - 1) chain += '<div class="connector">→</div>';
  });
  const howFlat=`<details class="inline-disclose lc-how"><summary>${t("lifecycle_how_summary")}</summary><div class="inline-disclose-body">${keyNote}<div class="note" style="margin-top:8px">${t("disposition_provenance_html")}</div></div></details>`;
  return `<div class="chain-h">${t("disposition_spine_heading")}</div>
    ${chain?`<div class="chain">${chain}</div>`:""}
    ${howFlat}`;
}
/**
 * Detail commercial panel: full extraction with provenance for the surplus-goods buyer.
 * Mounts only when extraction finds real sale signals (method, price, bid steps, or
 * confidently sale-shaped item). Destruction / transfer / abandonment notices stay quiet.
 * Absent subsection data renders nothing — never per-slot apology boxes.
 */
function propertyCommercialDetailHTML(commercial){
  if(!commercial || !commercial.item) return "";
  // Gate: no sale signals → no panel (not an empty "what is for sale" apology stack).
  const eligible = commercial.sale_eligible === true
    || (commercial.sale_eligible == null && commercialSaleSignalsFallback(commercial));
  if(!eligible) return "";
  const item=commercial.item;
  const catKey=ASSET_LABEL[item.category]||"asset_other";
  const hasWhat=Boolean(item.label || item.category && item.category!=="other" || (commercial.quantities||[]).length);
  const qty=(commercial.quantities||[]).map(q=>`<li><span lang="en" dir="ltr">${escUiHtml(q.display||"")}</span>
    ${q.evidence?`<div class="note muted" lang="en" dir="ltr">${escUiHtml(q.evidence)}</div>`:""}</li>`).join("");
  const prices=(commercial.price_facts||[]).map(p=>{
    const label=priceKindBadge(p.kind, String(p.display||"").replace(/^\$/,"") ) || p.display;
    return `<li><span class="tag amt">${label}</span>
      ${p.evidence?`<div class="note muted" lang="en" dir="ltr">${escUiHtml(p.evidence)}</div>`:""}</li>`;
  }).join("");
  const dealDerived=commercial.deal_signal && commercial.deal_signal.status==="derived"
    ? `<p class="property-deal-signal" data-deal-status="derived"><strong>${escUiHtml(commercial.deal_signal.summary)}</strong></p>`
    : "";
  const method=commercial.sale_method
    ? `<div class="lc-pct">${t("property_commercial_method_lbl")}: <span lang="en" dir="ltr">${escUiHtml(commercial.sale_method.method.replace(/_/g," "))}</span>
        ${commercial.sale_method.evidence?`<div class="note muted" lang="en" dir="ltr">${escUiHtml(commercial.sale_method.evidence)}</div>`:""}</div>`
    : "";
  const steps=(commercial.participation && commercial.participation.steps||[]).map(s=>
    `<li><span lang="en" dir="ltr">${escUiHtml(s.text||s.kind||"")}</span></li>`).join("");
  const packageUrl=commercial.participation && commercial.participation.package_url
    ? `<div class="lc-pct"><a href="${escUiHtml(commercial.participation.package_url)}" ${EXT_ATTRS}>${t("property_action_open_rfp")}${extSR()}</a></div>`
    : "";
  const contacts=[];
  for(const e of (commercial.participation && commercial.participation.emails)||[]){
    contacts.push(`<a href="mailto:${escUiHtml(e.value)}">${escUiHtml(e.value)}</a>`);
  }
  for(const p of (commercial.participation && commercial.participation.phones)||[]){
    contacts.push(`<span lang="en" dir="ltr">${escUiHtml(p.value)}</span>`);
  }
  const hasBid=Boolean(method || packageUrl || steps || contacts.length);
  const whatBlock=hasWhat?`<div class="property-commercial-what">
      <div class="stage-name">${t("property_commercial_what_lbl")}</div>
      <div><span class="tag asset">${escUiHtml(t(catKey))}</span>
        ${item.label?`<span lang="en" dir="ltr"> · ${escUiHtml(item.label)}</span>`:""}</div>
      ${item.evidence?`<div class="note muted" lang="en" dir="ltr">${escUiHtml(item.evidence)}</div>`:""}
      ${qty?`<ul class="ei-list property-commercial-qty">${qty}</ul>`:""}
    </div>`:"";
  const priceBlock=prices?`<div class="property-commercial-price">
      <div class="stage-name">${t("property_commercial_price_lbl")}</div>
      <ul class="ei-list">${prices}</ul>
    </div>`:"";
  const dealBlock=dealDerived?`<div class="property-commercial-deal">
      <div class="stage-name">${t("property_commercial_deal_lbl")}</div>
      ${dealDerived}
    </div>`:"";
  const bidBlock=hasBid?`<div class="property-commercial-bid">
      <div class="stage-name">${t("property_commercial_bid_lbl")}</div>
      ${method}
      ${packageUrl}
      ${steps?`<ul class="ei-list">${steps}</ul>`:""}
      ${contacts.length?`<div class="lc-pct">${contacts.join(" · ")}</div>`:""}
    </div>`:"";
  // Methodology / provenance: one collapsed affordance, never inline apology prose.
  const how=`<details class="inline-disclose lc-how"><summary>${t("lifecycle_how_summary")}</summary><div class="inline-disclose-body">${t("property_commercial_provenance_html")}</div></details>`;
  return `<section class="property-commercial-detail" data-commercial-detail="1" data-sale-eligible="1" aria-label="${escUiHtml(t("property_commercial_heading"))}">
    <div class="chain-h">${t("property_commercial_heading")}</div>
    ${whatBlock}
    ${priceBlock}
    ${dealBlock}
    ${bidBlock}
    ${how}
  </section>`;
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
async function loadPropertyCommercialDetail(r, el){
  if(!el || !r || !isPropertyDispositionEligible(r)) return;
  try{
    const tools=await propertyCommercialTools();
    // Prefer full-body extraction on detail; merge attachment titles when materialization stamped them.
    let attachments=[];
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
    if(commercial) r.commercial=commercial;
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
  if(phaseView){
    try{
      const timingMod = await import("../property_disposition_timing.mjs");
      const modelRes = await fetch("data/property_disposition_timing_model.json", { credentials: "omit" });
      if(modelRes && modelRes.ok){
        const model = await modelRes.json();
        phaseView = timingMod.attachDispositionTimingEstimate(phaseView, model) || phaseView;
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

/**
 * Cross-domain property panel: BBL → ZAP land projects, labeled owner → money awards.
 * Materialized lookup only (no live multi-source fan-out). Honest empty when no join.
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
  let demo = null;
  try{
    const res = await fetch(`data/property_cross_domain_lookup.json`, {cache:"force-cache"});
    if(res && res.ok){
      const doc = await res.json();
      demo = (doc.demos && doc.demos[bbl]) || null;
      if(!demo && doc.by_bbl && doc.by_bbl[bbl]){
        const bucket = doc.by_bbl[bbl];
        demo = {
          ok: true,
          bbl,
          land: {
            status: (bucket.land_projects||[]).length ? "matched" : "empty",
            projects: bucket.land_projects || [],
            count: (bucket.land_projects||[]).length,
            note: (bucket.land_projects||[]).length ? null : t("property_xd_land_empty"),
          },
          owners: { status: "empty", items: [], count: 0 },
          property: { status: "matched", notices: bucket.property_notices||[], count: (bucket.property_notices||[]).length },
        };
      }
    }
  }catch(_e){}
  if(!document.contains(el)) return;
  if(!demo || !demo.ok){
    el.innerHTML = `<div class="chain-h">${t("property_xd_heading")}</div>
      <div class="note">${t("property_xd_not_in_corpus_html",{bbl:escUiHtml(bbl)})}</div>
      <div class="note">${t("property_xd_provenance_html")}</div>`;
    return;
  }
  const land = demo.land || {};
  const owners = demo.owners || {};
  let landHtml = "";
  if(land.status === "matched" && (land.projects||[]).length){
    landHtml = `<ul class="ei-list">${(land.projects||[]).map(p=>{
      const href = (p.href && String(p.href).startsWith("#"))
        ? p.href
        : (p.project_id ? "#land?project="+encodeURIComponent(p.project_id) : null);
      const label = escUiHtml(p.label||p.project_id||"—");
      const link = href ? pivotA(href, label) : label;
      return `<li><span class="ei-obj-main">${link}</span>
        <span class="muted">${escUiHtml(p.public_status||"")}</span>
        <span class="muted"> · ${t("property_xd_via_bbl",{bbl:escUiHtml(bbl)})}</span></li>`;
    }).join("")}</ul>`;
  } else {
    landHtml = `<div class="note">${escUiHtml(land.note||t("property_xd_land_empty"))}</div>`;
  }
  let ownerHtml = "";
  if(owners.status === "matched" && (owners.items||[]).length){
    ownerHtml = (owners.items||[]).map(o=>{
      const contracts = (o.contracts||[]).length
        ? `<ul class="ei-list">${o.contracts.map(c=>{
            const label = escUiHtml(c.label||c.request_id||"—");
            const link = (c.href && String(c.href).startsWith("#")) ? pivotA(c.href, label) : label;
            return `<li><span class="ei-obj-main">${link}</span>
              ${c.pin?`<span class="muted"> · PIN ${escUiHtml(c.pin)}</span>`:""}</li>`;
          }).join("")}</ul>`
        : `<div class="note">${t("property_xd_owner_no_contracts")}</div>`;
      r._property_owner = r._property_owner || o.name;
      return `<div class="property-xd-owner"><div class="lc-pct" lang="en" dir="ltr"><strong>${escUiHtml(o.name)}</strong>
        <span class="muted"> · ${escUiHtml(o.basis||"owner")}</span></div>${contracts}</div>`;
    }).join("");
  } else {
    ownerHtml = `<div class="note">${t("property_xd_owner_empty")}</div>`;
  }
  el.innerHTML = `<div class="chain-h">${t("property_xd_heading")}</div>
    <div class="note">${t("property_xd_bbl_label",{bbl:escUiHtml(bbl)})}</div>
    <section class="property-xd-land" data-status="${escUiHtml(land.status||"")}">
      <h3 class="ei-domain-h">${t("property_xd_land_heading")}</h3>
      ${landHtml}
    </section>
    <section class="property-xd-owners" data-status="${escUiHtml(owners.status||"")}">
      <h3 class="ei-domain-h">${t("property_xd_owner_heading")}</h3>
      ${ownerHtml}
    </section>
    <div class="note">${t("property_xd_provenance_html")}</div>`;
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
  ["other","asset_other"],
];
const ASSET_LABEL=Object.fromEntries(ASSET_BUCKETS);
const ASSET_FILTER_ALIASES={vehequip:"vehicle",forest:"timber",realty:"real_property",medallion:"other",seized:"other"};
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
  if(has("medallion")) return "other";
  if(has("unauthorized","tobacco","forfeiture","pending destruction","property clerk","owners are wanted","in the custody")) return "other";
  if(has("auto auction","govdeals","iaai","fleet auction","municipal auto")) return "vehicle";
  if(has("heavy machinery","machine tools","publicsurplus","surplus assets","furniture")) return "equipment";
  if(has("scrap","recyclable metal")) return "scrap_materials";
  if(t.includes("easement")) return "other";
  if(has("mortgage and note","outstanding debt") && t.includes("mortgage")) return "other";
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
  if(r.commercial && r.commercial.glance) return r.commercial;
  if(tools && tools.extractPropertyCommercial){
    r.commercial=tools.extractPropertyCommercial(r);
    return r.commercial;
  }
  return null;
}
let propAll=[], propSpines=[], propAsset="all", propStageSel="all", propProcessSel="all";
let propSaleMethod="all", propPriceBand="all", propSort="closing_soon";
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
function propertyExplorerCardHTML(entry, terms, parcelLinks){
  const r=entry.primary;
  if(!r) return "";
  const commercial=r.commercial||null;
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
  const title=cleanText(r.short_title), mev=matchEvidence(title, matchText(r), terms);
  const noticeHref=`#notice/${encodeURIComponent(r.request_id)}`;
  const processStage=entry.process_stage;
  const processLabel=processStage?dispositionStageLabel(processStage):t("disposition_stage_unstaged");
  // Honesty: no live bid/attend CTA on a past-dated closed sale.
  const actionKey=closed ? "property_action_closed" : (entry.action_key||"property_action_open_notice");
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
  const closeLabel=closeDate ? fdt(closeDate) : "";
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
    ${closeLabel?`<span class="${closeChipClass}" data-close-chip="1">${escUiHtml(t(closeChipKey,{date:closeLabel}))}${closed?"":eventTag(closeDate)}</span>`:""}
  </div>`;
  const dealLine=(!closed && glance && glance.deal)
    ? `<p class="property-deal-signal" data-deal-status="derived">${escUiHtml(glance.deal)}</p>`
    : "";
  const processLine=`<div class="property-process-line">
    <span class="${processChipClass}">${escUiHtml(closed?t("stage_past"):processLabel)}</span>
    ${entry.notice_count>1?`<span class="tag asset">${escUiHtml(t("property_chain_notice_count",{n:String(entry.notice_count)}))}</span>`:""}
    ${entry.bbl?`<span class="tag place">${escUiHtml(t("property_list_bbl_chip",{bbl:entry.bbl}))}</span>`:``}
  </div>`;
  const primaryAction=`<a class="act${closed?"":" primary"}" href="${noticeHref}">${t(actionKey)}</a>`;
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
  return `<div class="fcard property-fcard${closed?" is-closed":""}" data-disposition-kind="${escUiHtml(entry.kind||"notice")}" data-process-stage="${escUiHtml(processStage||"unstaged")}" data-commercial-category="${escUiHtml(r._asset||"other")}" data-sale-method="${escUiHtml(methodKey||"")}" data-sale-eligible="${commercial&&commercial.sale_eligible===false?"0":"1"}" data-temporal-status="${closed?"closed":(entry.temporal_status||"open")}" data-closed="${closed?"1":"0"}">
      ${commercialLead}
      ${dealLine}
      <div class="ftype">${r.type_of_notice_description||""}${r.agency_name?" · "+pivotA(agencyHref(r.agency_name), r.agency_name):""}</div>
      ${processLine}
      ${entry.bbl?`<div class="tax-lien-card-slot" data-tax-lien-bbl="${escUiHtml(entry.bbl)}"></div>`:""}
      <div class="ftitle"><a href="${noticeHref}">${title ? digTitleHTML(title, mev) : t("untitled")}</a></div>
      ${propertyPlaceChips(r._location)}
      ${digEvidenceHTML(mev)}
      <div class="factions">${compactCardActions(primaryAction, secondaryActions)}</div>
    </div>`;
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
  const commercialTools=await propertyCommercialTools();
  propAll.forEach(r=>{
    ensurePropertyCommercial(r, commercialTools);
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
  const ac={all:propAll.length}, sc={all:propAll.length};
  const mc={all:propAll.length};
  const pcBands={all:propAll.length, priced:0, under_10k:0, "10k_100k":0, "100k_plus":0};
  propAll.forEach(r=>{
    ac[r._asset]=(ac[r._asset]||0)+1;
    sc[r._stage]=(sc[r._stage]||0)+1;
    const method=propSaleMethodOf(r);
    if(method) mc[method]=(mc[method]||0)+1;
    const band=propPriceBandOf(r);
    if(band){
      pcBands.priced=(pcBands.priced||0)+1;
      pcBands[band]=(pcBands[band]||0)+1;
    }
  });
  const assetEl=$("#assettabs");
  if(assetEl){
    assetEl.innerHTML=[["all","all_types"],...ASSET_BUCKETS].map(([k,l])=>
      `<button type="button" class="chip ${propAsset===k?'on':''}" data-a="${k}">${t(l)}<span class="ct">${ac[k]||0}</span></button>`).join("");
    assetEl.querySelectorAll(".chip").forEach(b=>b.addEventListener("click",()=>{ propAsset=normalizePropAsset(b.dataset.a); renderPropExplorer(); updateHash(); renderSearchComponents("property"); }));
  }
  const saleEl=$("#salerail");
  if(saleEl){
    saleEl.innerHTML=[["all","sale_method_all"],...SALE_METHOD_BUCKETS].map(([k,l])=>
      `<button type="button" class="chip ${propSaleMethod===k?'on':''}" data-m="${k}">${t(l)}<span class="ct">${mc[k]||0}</span></button>`).join("");
    saleEl.querySelectorAll(".chip").forEach(b=>b.addEventListener("click",()=>{ propSaleMethod=normalizePropSaleMethod(b.dataset.m); renderPropExplorer(); updateHash(); renderSearchComponents("property"); }));
  }
  const priceEl=$("#pricerail");
  if(priceEl){
    priceEl.innerHTML=PRICE_BAND_BUCKETS.map(([k,l])=>
      `<button type="button" class="chip ${propPriceBand===k?'on':''}" data-p="${k}">${t(l)}<span class="ct">${pcBands[k]||0}</span></button>`).join("");
    priceEl.querySelectorAll(".chip").forEach(b=>b.addEventListener("click",()=>{ propPriceBand=normalizePropPriceBand(b.dataset.p); renderPropExplorer(); updateHash(); renderSearchComponents("property"); }));
  }
  const lifeEl=$("#liferail");
  if(lifeEl){
    lifeEl.innerHTML=PROP_STAGES.map(([k,l])=>
      `<button type="button" class="chip ${propStageSel===k?'on':''}" data-s="${k}">${t(l)}<span class="ct">${sc[k]||0}</span></button>`).join("");
    lifeEl.querySelectorAll(".chip").forEach(b=>b.addEventListener("click",()=>{ propStageSel=b.dataset.s; renderPropExplorer(); updateHash(); renderSearchComponents("property"); }));
  }

  const tools=await propertyExplorerTools();
  const processRail=$("#processrail");
  const borough=$("#propertyboro")?.value||"", neighborhood=($("#propertyneighborhood")?.value||"").trim();
  let entries=[];
  if(tools && tools.buildPropertyExplorerEntries){
    entries=tools.buildPropertyExplorerEntries(propAll, propSpines);
    entries=tools.filterPropertyExplorerEntries(entries,{
      process: propProcessSel,
      asset: propAsset,
      saleMethod: propSaleMethod,
      priceBand: propPriceBand,
      temporal: propStageSel,
      temporalOf: propStage,
      assetOf: (r)=>r._asset||classifyAsset(r),
      commercialOf: (r)=>r.commercial||null,
      borough: borough||null,
      neighborhood: neighborhood||null,
    });
    if(tools.stampPropertyExplorerTemporal){
      entries=tools.stampPropertyExplorerTemporal(entries,{
        commercialOf:(r)=>r.commercial||null,
      });
    }
    if(tools.sortPropertyExplorerEntries){
      entries=tools.sortPropertyExplorerEntries(entries, propSort, (r)=>r.commercial||null);
    }
    const pc=tools.countPropertyProcessStages(tools.buildPropertyExplorerEntries(propAll, propSpines));
    if(processRail){
      const stages=tools.PROP_PROCESS_STAGES||[["all","stage_all"]];
      processRail.innerHTML=stages.map(([k,l])=>
        `<button type="button" class="chip ${propProcessSel===k?'on':''}" data-p="${k}">${t(l)}<span class="ct">${pc[k]||0}</span></button>`
      ).join("");
      processRail.querySelectorAll(".chip").forEach(b=>b.addEventListener("click",()=>{ propProcessSel=b.dataset.p; renderPropExplorer(); updateHash(); renderSearchComponents("property"); }));
    }
  } else {
    // Fallback: flat notice list if the explorer module fails to load.
    if(processRail) processRail.innerHTML="";
    entries=propAll
      .filter(r=>{
        if(propAsset!=="all" && r._asset!==propAsset) return false;
        if(propStageSel!=="all" && r._stage!==propStageSel) return false;
        if(propSaleMethod!=="all" && propSaleMethodOf(r)!==propSaleMethod) return false;
        if(propPriceBand!=="all"){
          const band=propPriceBandOf(r);
          if(propPriceBand==="priced"){ if(!band) return false; }
          else if(band!==propPriceBand) return false;
        }
        // Commercial filters drop non-sales when any commercial organize filter is on.
        if((propAsset!=="all"||propSaleMethod!=="all"||propPriceBand!=="all")
          && r.commercial && r.commercial.sale_eligible===false) return false;
        if(borough && !(r._location?.boroughs||[]).includes(borough)) return false;
        if(neighborhood && ![
          ...(r._location?.neighborhoods||[]),
          ...(r._location?.addresses||[]).map(address=>address.label),
        ].join(" ").toLowerCase().includes(neighborhood.toLowerCase())) return false;
        return true;
      })
      .map(r=>({
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
  }

  announce(t("property_entries_announce",{n:entries.length}));
  setExportBandVisibility(entries.length, "property-export-band", "property-export-overflow");
  const feedEl=$("#propertyfeed");
  if(!feedEl) return;
  const kwEl=$("#propertykw"), kw=kwEl?kwEl.value.trim():"", terms=kw?[kw]:[];
  // Export/print still want notice rows (primaries of visible entries).
  const visibleRows=entries.map(e=>e.primary).filter(Boolean);
  feedVisible.property=visibleRows;
  if(!entries.length){
    feedEl.innerHTML='<div class="empty">' + t("nothing_found_feed") + '</div>';
    return;
  }
  let parcelLinks=null;
  try{
    const locTools=await propertyLocationTools();
    parcelLinks=locTools.parcelLinksFromBbl;
  }catch(_e){}
  // Default view: open/upcoming cards first, then a labeled closed/archive block.
  // Past sales never look like live actions at the top of #property.
  const parts=[];
  let closedHeaderEmitted=false;
  for(const e of entries){
    const closed=e.temporal_status==="closed"
      || (e.close_date && daysLeft(e.close_date)!==null && daysLeft(e.close_date)<0);
    if(closed && !closedHeaderEmitted && propStageSel==="all"){
      parts.push(`<div class="property-closed-section" data-closed-section="1" role="separator" aria-label="${escUiHtml(t("property_closed_section"))}"><h3 class="property-closed-section-title">${escUiHtml(t("property_closed_section"))}</h3></div>`);
      closedHeaderEmitted=true;
    }
    parts.push(propertyExplorerCardHTML(e, terms, parcelLinks));
  }
  feedEl.innerHTML=parts.join("");
  feedEl.querySelectorAll("[data-link]").forEach(b=>b.addEventListener("click",()=>copyText(noticeLink(b.dataset.link), b)));
  feedEl.querySelectorAll("[data-ev]").forEach(b=>b.addEventListener("click",()=>{ const i=b.dataset.ev.indexOf(":"); downloadEventICS(feedRows[b.dataset.ev.slice(0,i)][b.dataset.ev.slice(i+1)]); }));
  feedEl.querySelectorAll("[data-demo]").forEach(b=>b.addEventListener("click",()=>checkDemolition(feedRows.property[b.dataset.demo], b)));
  const hydrate=()=>hydrateTaxLienBblSlots(feedEl).catch(()=>{});
  if("requestIdleCallback" in window) requestIdleCallback(hydrate,{timeout:2500}); else setTimeout(hydrate,250);
}

/* ===== Tax-lien sale progression: historical BBL status + cohort statistics.
   The generic calibration gate currently selects cohort_statistic_only, so no
   property-specific probability is rendered. The final-sale stage means the
   lien was sold; it never claims the property itself was sold or foreclosed. ===== */
let taxLienSummaryPromise=null, taxLienLookupPromise=null, taxLienSelectedCycle=null;
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
function taxLienDate(value){ const day=String(value||"").slice(0,10); return /^\d{4}-\d{2}-\d{2}$/.test(day)?fdt(`${day}T12:00:00`):fdt(value); }
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
function taxLienPanelHTML(summary){
  const rate=summary.training.citywide.notice_90.probability_leave_before_sale;
  const cycle=summary.cycles.find(row=>row.cycle_id===(taxLienSelectedCycle||summary.latest_cycle.cycle_id))||summary.cycles.at(-1);
  taxLienSelectedCycle=cycle.cycle_id;
  const options=summary.cycles.map(row=>`<option value="${escUiHtml(row.cycle_id)}"${row.cycle_id===cycle.cycle_id?" selected":""}>${taxLienDate(row.cycle_id)}</option>`).join("");
  const steps=["notice_90","notice_60","notice_30","notice_10","sold"];
  return `<h2>${t("tax_lien_heading")}</h2>
    <p class="tax-lien-deck">${t("tax_lien_deck_html")}</p>
    <p class="tax-lien-lead">${t("tax_lien_action_lead_html",{p:taxLienPct(rate)})}</p>
    <p class="tax-lien-meta">${t("tax_lien_attribution",{n:String(summary.training.cycle_count)})} · ${t("tax_lien_vintage",{date:taxLienDate(summary.latest_cycle.data_vintage)})} · ${t("tax_lien_expired",{date:taxLienDate(summary.schedule.sale_date)})}</p>
    <p class="tax-lien-meta">${t("tax_lien_action_deadline",{date:taxLienDate(summary.schedule.action_deadline)})}</p>
    <ol class="tax-lien-stepper">${steps.map((stage,index)=>`<li><span class="lc-step ${index<4?"done":"current"}">${escUiHtml(taxLienStageLabel(stage))}</span>${index<4?'<span class="lc-step-arrow" aria-hidden="true">→</span>':""}</li>`).join("")}</ol>
    <div class="tax-lien-actions">
      <a class="act primary" href="${escUiHtml(summary.action_channels.exemption_url)}" ${EXT_ATTRS}>${t("tax_lien_exemptions")}${extSR()}</a>
      <a class="act" href="${escUiHtml(summary.action_channels.payment_plan_url)}" ${EXT_ATTRS}>${t("tax_lien_payment_plans")}${extSR()}</a>
      <a class="act" href="${escUiHtml(summary.action_channels.lien_sale_help_url)}" ${EXT_ATTRS}>${t("tax_lien_help")}${extSR()}</a>
      <a class="act" href="tel:311">${t("tax_lien_call_311")}</a>
    </div>
    <p class="tax-lien-meta">${t("tax_lien_cohort_only")}</p>
    <div class="tax-lien-lookup"><label for="tax-lien-bbl">${t("tax_lien_lookup_label")}</label><input id="tax-lien-bbl" type="text" inputmode="numeric" maxlength="10" placeholder="${escUiHtml(t("tax_lien_lookup_placeholder"))}"><button type="button" id="tax-lien-bbl-go">${t("tax_lien_lookup_button")}</button><div class="tax-lien-result" id="tax-lien-bbl-result"></div></div>
    <div class="field" style="max-width:260px"><label for="tax-lien-cycle">${t("tax_lien_cycle_label")}</label><select id="tax-lien-cycle">${options}</select></div>
    <div class="tax-lien-areas"><div class="tax-lien-area" tabindex="0"><h3>${t("tax_lien_borough_heading")}</h3>${taxLienAreaTable(cycle.boroughs,t("borough_label"))}</div><div class="tax-lien-area" tabindex="0"><h3>${t("tax_lien_nta_heading")}</h3><div class="tax-lien-nta-scroll" role="region" tabindex="0" aria-label="${escUiHtml(t("tax_lien_nta_heading"))}">${taxLienAreaTable(cycle.ntas,"NTA")}</div></div></div>`;
}
async function paintTaxLienSalePanel(){
  const el=$("#tax-lien-sale-panel"); if(!el) return;
  const summary=await loadTaxLienSummary();
  if(!summary){ el.innerHTML=`<div class="empty">${t("could_not_reach")}</div>`; return; }
  el.innerHTML=taxLienPanelHTML(summary);
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
  const [summary,lookup]=await Promise.all([loadTaxLienSummary(),loadTaxLienLookup()]); if(!summary||!lookup) return;
  slots.forEach(slot=>{
    const row=taxLienDecode(lookup,slot.dataset.taxLienBbl); if(!row) return;
    slot.innerHTML=`<div class="tax-lien-card-note">${t("tax_lien_card_html",{stage:escUiHtml(taxLienStageLabel(row.stage)),outcome:escUiHtml(taxLienOutcomeLabel(row.outcome)),date:taxLienDate(summary.latest_cycle.data_vintage)})}</div>`;
  });
}
async function loadTaxLienForNotice(r,el){
  if(!el) return;
  let bbl=r?._property_bbl||null;
  if(!bbl){ try{const tools=await propertyLocationTools();bbl=tools.primaryPropertyBbl(tools.propertyLocationFromRow(r));}catch(_e){} }
  if(!bbl){el.innerHTML="";return;}
  const [summary,lookup]=await Promise.all([loadTaxLienSummary(),loadTaxLienLookup()]);
  const row=taxLienDecode(lookup,bbl); if(!summary||!row){el.innerHTML="";return;}
  el.innerHTML=`<section class="tax-lien-panel"><h2>${t("tax_lien_heading")}</h2>${taxLienBblResultHTML(summary,lookup,bbl)}<p class="tax-lien-meta">${t("tax_lien_action_deadline",{date:taxLienDate(summary.schedule.action_deadline)})}</p><div class="tax-lien-actions"><a class="act primary" href="${escUiHtml(summary.action_channels.exemption_url)}" ${EXT_ATTRS}>${t("tax_lien_exemptions")}${extSR()}</a><a class="act" href="${escUiHtml(summary.action_channels.payment_plan_url)}" ${EXT_ATTRS}>${t("tax_lien_payment_plans")}${extSR()}</a></div><p class="tax-lien-meta">${t("tax_lien_deck_html")}</p></section>`;
}

function propertyPlaceChips(location){
  if(!location) return `<div class="faddr"><span class="tag place">${t("property_location_not_stated")}</span></div>`;
  if(location.scope==="citywide") return `<div class="faddr"><span class="tag place">${t("citywide")}</span></div>`;
  if(location.scope==="unlocated") return `<div class="faddr"><span class="tag place">${t("property_location_not_stated")}</span></div>`;
  const values=[
    ...(location.addresses||[]).slice(0,3).map(address=>address.label),
    ...(location.boroughs||[]),
    ...(location.tax_lots||[]).slice(0,2).map(lot=>lot.label),
    ...(location.bbls||[]).slice(0,2).map(bbl=>`BBL ${bbl}`),
  ];
  return `<div class="faddr">${[...new Set(values)].map(value=>`<span class="tag place">${escUiHtml(value)}</span>`).join(" ")}</div>`;
}

function rulePlaceChips(location){
  if(!location||location.scope==="citywide") return `<div class="faddr"><span class="tag place">${t("citywide")}</span></div>`;
  if(location.scope==="unlocated") return `<div class="faddr"><span class="tag place">${t("rule_stage_unstaged")}</span></div>`;
  const values=[
    ...(location.districts||[]),
    ...(location.neighborhoods||[]),
    ...(location.boroughs||[]),
    ...(location.addresses||[]).map(address=>address.label),
  ].filter(Boolean);
  return `<div class="faddr">${[...new Set(values)].map(value=>`<span class="tag place">${escUiHtml(value)}</span>`).join(" ")}</div>`;
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
globalThis.propertyCommercialDetailHTML = propertyCommercialDetailHTML;
globalThis.franchiseConcessionSpineHTML = franchiseConcessionSpineHTML;
globalThis.franchisePhaseSpineTools = franchisePhaseSpineTools;
globalThis.franchiseStageLabel = franchiseStageLabel;
globalThis.hydrateTaxLienBblSlots = hydrateTaxLienBblSlots;
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
globalThis.propStage = propStage;
globalThis.propertyDispositionSpineHTML = propertyDispositionSpineHTML;
globalThis.propertyDispositionTimingHTML = propertyDispositionTimingHTML;
globalThis.propertyExplorerCardHTML = propertyExplorerCardHTML;
globalThis.propertyExplorerTools = propertyExplorerTools;
globalThis.propertyPhaseSpineTools = propertyPhaseSpineTools;
globalThis.propertyPlaceChips = propertyPlaceChips;
globalThis.renderPropExplorer = renderPropExplorer;
globalThis.rulePlaceChips = rulePlaceChips;
globalThis.taxLienAreaTable = taxLienAreaTable;
globalThis.taxLienBblResultHTML = taxLienBblResultHTML;
globalThis.taxLienDate = taxLienDate;
globalThis.taxLienDecode = taxLienDecode;
globalThis.taxLienOutcomeLabel = taxLienOutcomeLabel;
globalThis.taxLienPanelHTML = taxLienPanelHTML;
globalThis.taxLienPct = taxLienPct;
globalThis.taxLienStageLabel = taxLienStageLabel;
Object.defineProperty(globalThis, "franchisePhaseSpineToolsPromise", { configurable: true, get: () => franchisePhaseSpineToolsPromise, set: value => { franchisePhaseSpineToolsPromise = value; } });
Object.defineProperty(globalThis, "propAll", { configurable: true, get: () => propAll, set: value => { propAll = value; } });
Object.defineProperty(globalThis, "propAsset", { configurable: true, get: () => propAsset, set: value => { propAsset = value; } });
Object.defineProperty(globalThis, "propProcessSel", { configurable: true, get: () => propProcessSel, set: value => { propProcessSel = value; } });
Object.defineProperty(globalThis, "propSaleMethod", { configurable: true, get: () => propSaleMethod, set: value => { propSaleMethod = value; } });
Object.defineProperty(globalThis, "propPriceBand", { configurable: true, get: () => propPriceBand, set: value => { propPriceBand = value; } });
Object.defineProperty(globalThis, "propSort", { configurable: true, get: () => propSort, set: value => { propSort = value; } });
Object.defineProperty(globalThis, "propSpines", { configurable: true, get: () => propSpines, set: value => { propSpines = value; } });
Object.defineProperty(globalThis, "propStageSel", { configurable: true, get: () => propStageSel, set: value => { propStageSel = value; } });
globalThis.normalizePropSaleMethod = normalizePropSaleMethod;
globalThis.normalizePropPriceBand = normalizePropPriceBand;
globalThis.normalizePropSort = normalizePropSort;
Object.defineProperty(globalThis, "propertyExplorerToolsPromise", { configurable: true, get: () => propertyExplorerToolsPromise, set: value => { propertyExplorerToolsPromise = value; } });
Object.defineProperty(globalThis, "propertyPhaseSpineToolsPromise", { configurable: true, get: () => propertyPhaseSpineToolsPromise, set: value => { propertyPhaseSpineToolsPromise = value; } });
Object.defineProperty(globalThis, "taxLienLookupPromise", { configurable: true, get: () => taxLienLookupPromise, set: value => { taxLienLookupPromise = value; } });
Object.defineProperty(globalThis, "taxLienSelectedCycle", { configurable: true, get: () => taxLienSelectedCycle, set: value => { taxLienSelectedCycle = value; } });
Object.defineProperty(globalThis, "taxLienSummaryPromise", { configurable: true, get: () => taxLienSummaryPromise, set: value => { taxLienSummaryPromise = value; } });
