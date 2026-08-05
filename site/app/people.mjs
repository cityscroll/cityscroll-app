/* ===================== PEOPLE ===================== */
let SameConsolidation=null;
let sameConsolidationPromise=null;
function loadSameConsolidation(){
  return sameConsolidationPromise||(sameConsolidationPromise=import("../same_consolidation.mjs").then(module=>SameConsolidation=module.createStaffingConsolidationUI({t,escUiHtml,fmtNumber,money,fdt,fdate,REQ_URL,EXT_ATTRS,extSR})));
}
let pRows = [], pMode = "role", competitiveSet = new Set();
let careerData = null, careerLoadPromise = null, careerSelected = null, careerLimit = 16;
const CAREER_DATA_URL = "data/staffing_exams.json";
// Built from site/data/staffing_exams.json.
const CAREER_DATA_SCHEMA_VERSION = 4;
// One bounded retry bridges transient module/edge races.
const CAREER_LOAD_ATTEMPTS = 2;
const CAREER_RETRY_DELAY_MS = 250;
// Route filters apply after artifact options load; no identity is stored.
let careerRouteFilters = null;
let careerHowPrepared = false;
const CAREER_HOW_SEEN_KEY = "crol_exam_how_seen_v1";
function prepareCareerHow(){
  if(careerHowPrepared) return;
  const details=$("#career-how-details");
  let seen=false;
  try{ seen=localStorage.getItem(CAREER_HOW_SEEN_KEY)==="1"; }catch(e){}
  details.open=!seen;
  if(!seen){ try{ localStorage.setItem(CAREER_HOW_SEEN_KEY,"1"); }catch(e){} }
  careerHowPrepared=true;
}
let staffingNotices = [], staffingLoaded = false, staffingLoadPromise = null;
const staffingFilters = {query:"", role:"", agency:""};
const CAREER_AREA_KEYS = {
  "public-safety": "career_area_public_safety",
  "health-care": "career_area_health_care",
  "engineering-construction": "career_area_engineering",
  "technology-science": "career_area_technology",
  "community-social-services": "career_area_community",
  "administration-finance": "career_area_administration",
  "trades-operations": "career_area_trades",
  "other": "career_area_other",
};
function staffingVisibleItems(){
  return CrolStaffing.filterHireNotices(staffingNotices,staffingFilters);
}
function staffingFacetHTML(kind, allKey, field){
  return SameConsolidation.facetHTML(kind,allKey,field,staffingNotices,staffingFilters,CrolStaffing.topValues);
}
function bindStaffingFacets(){
  $("#staffing-role-filters").querySelectorAll("[data-staffing-role]").forEach(button=>button.addEventListener("click",()=>{
    staffingFilters.role=button.dataset.staffingRole||"";
    renderStaffingFeed(); updateHash();
  }));
  $("#staffing-agency-filters").querySelectorAll("[data-staffing-agency]").forEach(button=>button.addEventListener("click",()=>{
    staffingFilters.agency=button.dataset.staffingAgency||"";
    renderStaffingFeed(); updateHash();
  }));
}
function syncStaffingModeUI(){
  const examDetail=!!careerSelected;
  const guide=$("#career-guide");
  const feed=$("#staffing-feed");
  const heading=$("#staffing-feed-meta-heading");
  if(feed) feed.hidden=examDetail;
  if(heading) heading.textContent=t("staffing_appointments_heading");
  if(guide){
    guide.hidden=false;
    if(examDetail) prepareCareerHow();
  }
}
function renderStaffingFeed(){
  if(!staffingLoaded) return;
  $("#staffing-role-filters").innerHTML=staffingFacetHTML("role","staffing_all_roles","role");
  $("#staffing-agency-filters").innerHTML=staffingFacetHTML("agency","staffing_all_agencies","agency");
  bindStaffingFacets();
  syncStaffingModeUI();
  const items=staffingVisibleItems();
  const entries=SameConsolidation
    ? SameConsolidation.group(items)
    : items.map(item=>({kind:"item",item}));
  $("#staffing-result-count").textContent=t("staffing_results_count",{n:fmtNumber(items.length)});
  $("#staffing-notice-list").innerHTML=items.length
     ? entries.map(entry=>entry.kind==="same-except-group"
       ? SameConsolidation.groupHTML(entry)
       : SameConsolidation.rowHTML(entry.item)).join("")
    : `<div class="career-empty">${t("staffing_no_results")}</div>`;
}
// Commit-time default APPOINTED strip (wave-2 batch precompute). Keyword search / payroll stay live.
const STAFFING_HIRES_SNAPSHOT_URL="data/staffing_default_hires.json";
let staffingHiresSnapshotPromise=null;
function loadStaffingHiresSnapshot(){
  if(!staffingHiresSnapshotPromise){
    staffingHiresSnapshotPromise=fetch(STAFFING_HIRES_SNAPSHOT_URL)
      .then(r=>r.ok?r.json():null)
      .catch(()=>null);
  }
  return staffingHiresSnapshotPromise;
}
async function loadStaffingFeed(){
  if(staffingLoaded){ renderStaffingFeed(); return staffingNotices; }
  if(staffingLoadPromise) return staffingLoadPromise;
  staffingLoadPromise=(async()=>{
    let paintedFromSnapshot=false;
    try{
      const [snap, crosswalk]=await Promise.all([
        loadStaffingHiresSnapshot(),
        fetch("data/title_crosswalk.json").then(response=>response.ok?response.json():[]),
        loadSameConsolidation(),
      ]);
      const notices=snap&&Array.isArray(snap.notices)?snap.notices:[];
      if(notices.length){
        staffingNotices=CrolStaffing.hireNotices(notices,crosswalk);
        staffingLoaded=true;
        renderStaffingFeed();
        paintedFromSnapshot=true;
      }
    }catch(e){}
    try{
      const [rows, crosswalk]=await Promise.all([
        soda({"$select":"request_id,start_date,agency_name,short_title,additional_description_1",
          "$where":"section_name='Changes in Personnel' AND short_title='APPOINTED'",
          "$order":"start_date DESC, request_id DESC","$limit":"80"}),
        fetch("data/title_crosswalk.json").then(response=>response.ok?response.json():[]),
      ]);
      staffingNotices=CrolStaffing.hireNotices(rows,crosswalk);
      staffingLoaded=true;
      renderStaffingFeed();
      return staffingNotices;
    }catch(e){
      if(!paintedFromSnapshot){
        $("#staffing-notice-list").innerHTML=`<div class="career-empty">${t("staffing_load_failed")}</div>`;
        return [];
      }
      return staffingNotices;
    }
  })();
  return staffingLoadPromise;
}
function careerToday(){ return new Date().toISOString().slice(0,10); }
function careerDate(value){ return value ? fdt(value+"T12:00:00Z") : t("career_date_unknown"); }
function careerMoney(value, gapClass){
  if(value === 0) return "$0";
  if(value != null) return "$"+Number(value).toLocaleString("en-US");
  return "";
}
/** Structured salary: min only, or min–max range when NOE densify captured an upper bound. */
function careerSalaryHTML(feeSalary, exam, gapClass){
  const min=feeSalary.salary_min ?? exam.salary_min;
  const max=feeSalary.salary_max ?? exam.salary_max;
  if(min != null && max != null && Number(max) > Number(min)){
    return `${careerMoney(min, gapClass)} – ${careerMoney(max, gapClass)}`;
  }
  return careerMoney(min, gapClass);
}
/** Short format label for differentiator chips. */
function careerFormatLabel(format){
  return t({
    education_experience:"career_diff_format_eee",
    multiple_choice:"career_diff_format_mc",
    physical:"career_diff_format_physical",
    mixed:"career_diff_format_mixed",
    other:"career_diff_format_other",
  }[format] || "career_diff_format_other");
}
// Lead with exam-specific format, fee, salary, and qualification facts.
function careerDiffLeadsHTML(exam, feeSalary){
  const view=CrolStaffing.examDifferentiatorView
    ? CrolStaffing.examDifferentiatorView(exam)
    : { exam_format:exam.exam_format, card_leads:exam.card_leads||[], no_experience_required:exam.no_experience_required };
  const chips=[];
  const seen=new Set();
  const push=(key,label)=>{
    if(!label || seen.has(key)) return;
    seen.add(key);
    chips.push(`<span class="career-diff-chip" data-diff="${escUiHtml(key)}">${escUiHtml(label)}</span>`);
  };
  const leads=Array.isArray(view.card_leads) && view.card_leads.length
    ? view.card_leads
    : [
      view.exam_format?{key:"exam_format",value:view.exam_format}:null,
      exam.fee===0?{key:"fee",value:0}:null,
      exam.salary_min!=null?{key:"salary_min",value:exam.salary_min}:null,
      view.no_experience_required===true?{key:"no_experience_required",value:true}:null,
      exam.qualifications?{key:"qualifications",value:exam.qualifications}:null,
    ].filter(Boolean);

  for(const lead of leads){
    if(!lead || !lead.key) continue;
    if(lead.key==="exam_format") push("exam_format", careerFormatLabel(lead.value || view.exam_format));
    else if(lead.key==="fee" && (lead.value===0 || exam.fee===0)) push("fee", t("career_diff_no_fee"));
    else if(lead.key==="fee_level" && lead.value==="none") push("fee", t("career_diff_no_fee"));
    else if(lead.key==="salary_min" || lead.key==="salary_max"){
      // handled after loop as one salary chip
    } else if(lead.key==="no_experience_required") push("no_experience_required", t("career_diff_no_experience"));
    else if(lead.key==="experience_required") push("experience_required", t("career_diff_experience"));
    else if(lead.key==="residency_required") push("residency_required", t("career_diff_residency"));
    else if(lead.key==="residency_not_required") push("residency_not_required", t("career_diff_no_residency"));
  }
  const min=feeSalary.salary_min ?? exam.salary_min;
  const max=feeSalary.salary_max ?? exam.salary_max;
  if(min != null){
    const amount=max != null && Number(max) > Number(min)
      ? t("career_diff_salary_range",{min:careerMoney(min),max:careerMoney(max)})
      : t("career_diff_salary",{amount:careerMoney(min)});
    push("salary", amount);
  }
  // Always surface format when present and not already chipped.
  if(view.exam_format && !seen.has("exam_format")) push("exam_format", careerFormatLabel(view.exam_format));

  const quals=exam.qualifications
    ? `<p class="career-diff-quals" lang="en" dir="ltr"><b>${t("career_diff_quals")}</b> ${escUiHtml(exam.qualifications)}</p>`
    : "";
  if(!chips.length && !quals) return "";
  return `${chips.length?`<div class="career-diff-leads" aria-label="${escUiHtml(t("career_diff_quals"))}">${chips.join("")}</div>`:""}${quals}`;
}
function careerStatusLabel(status){
  return t({
    open:"career_status_open", upcoming:"career_status_upcoming", closed:"career_status_closed",
    canceled:"career_status_canceled", postponed:"career_status_postponed", unscheduled:"career_status_unscheduled"
  }[status] || "career_status_unscheduled");
}
function careerStatusClass(status){
  return status==="open"?"open":status==="upcoming"?"soon":status==="closed"||status==="canceled"?"closed":"soon";
}
function careerWindowText(exam, status){
  if(status==="open") return t("career_open_through",{date:careerDate(exam.application_end)});
  if(status==="upcoming") return t("career_opens_on",{date:careerDate(exam.application_start)});
  if(status==="closed") return t("career_closed_on",{date:careerDate(exam.application_end)});
  if(status==="canceled") return t("career_canceled_copy");
  if(status==="postponed") return t("career_postponed_copy");
  return t("career_date_unknown");
}
function careerCountdownText(exam, status){
  if(status==="open"){
    const days=CrolStaffing.applicationDaysLeft(exam.application_end, careerToday());
    if(days==null) return "";
    if(days<0) return t("career_deadline_passed");
    if(days===0) return t("career_last_day");
    return tn("days_left", days);
  }
  if(status==="upcoming" && exam.application_start){
    const days=CrolStaffing.applicationDaysLeft(exam.application_start, careerToday());
    if(days==null || days<0) return "";
    return tn("event_in_n_days", days);
  }
  return "";
}
function careerSourceHTML(){
  const today=careerToday();
  const stale=careerData.sources.some(source=>CrolStaffing.sourceIsStale(source,today));
  const current=careerData.sources.find(source=>source.id==="dcas-open-competitive");
  const annual=careerData.sources.find(source=>source.id==="dcas-annual-schedule");
  const box=$("#career-source");
  box.classList.toggle("stale",stale);
  const lead=stale
    ? t("career_source_stale",{date:careerDate(current?.verified_at||careerData.generated_at)})
    : t("career_source_current",{date:careerDate(current?.verified_at||careerData.generated_at),annual:careerDate(annual?.data_current_as_of)});
  box.innerHTML=`<span>${lead}</span><details><summary>${t("career_source_details")}</summary>
    <ul>${careerData.sources.map(source=>`<li><span lang="en" dir="ltr">${escUiHtml(source.name)}</span> — ${escUiHtml(source.refresh_cadence||"")}</li>`).join("")}</ul>
    <p>${t("career_city_record_finding")}</p></details>`;
}
function careerCount(value){
  return Number.isFinite(Number(value)) ? fmtNumber(Number(value)) : t("career_not_published");
}
// One-exam process spine: application → list → certification → appointment.
let examProcessSpineToolsPromise=null;
function ensureExamProcessSpineTools(){
  if(!examProcessSpineToolsPromise){
    examProcessSpineToolsPromise=import("../exam_process_spine.mjs").catch(()=>null);
  }
  return examProcessSpineToolsPromise;
}
let examPhaseSpineToolsPromise=null;
let careerSpinesHydrated=false;
function ensureExamPhaseSpineTools(){
  if(!examPhaseSpineToolsPromise){
    examPhaseSpineToolsPromise=import("../exam_phase_spine.mjs").catch(()=>null);
  }
  return examPhaseSpineToolsPromise;
}
function examStageLabel(kind){
  if(kind==="application") return t("exam_stage_application");
  if(kind==="list_establishment") return t("exam_stage_list_establishment");
  if(kind==="certification") return t("exam_stage_certification");
  if(kind==="appointment") return t("exam_stage_appointment");
  return kind || "—";
}
function examStageSourceLabel(kind){
  if(kind==="application") return t("exam_source_schedule");
  if(kind==="list_establishment") return t("exam_source_list");
  return t("exam_source_outcomes");
}
function examStageCountHTML(stageOrPhase){
  if(!stageOrPhase) return "";
  const kind=stageOrPhase.kind||stageOrPhase.id;
  const count=stageOrPhase.count;
  if(count==null) return "";
  if(kind==="list_establishment") return t("exam_stage_on_list_count",{n:fmtNumber(count)});
  if(kind==="certification") return t("exam_stage_certified_count",{n:fmtNumber(count)});
  if(kind==="appointment") return t("exam_stage_hired_count",{n:fmtNumber(count)});
  return "";
}
function examListForecastHTML(exam){
  const forecast=exam?.list_establishment_forecast;
  if(!forecast) return "";
  const months=fmtNumber(forecast.median_months);
  const statistic=t("exam_list_prediction_cohort_html",{
    n:fmtNumber(forecast.n),
    year:escUiHtml(forecast.since_year||2018),
    months
  });
  const prediction=forecast.prediction;
  const window=prediction?.predicted_window
    ?`<div class="lc-pct">${t("exam_list_prediction_window",{
      first:fdate(prediction.predicted_window.p10),
      median:fdate(prediction.predicted_window.p50),
      last:fdate(prediction.predicted_window.p90)
    })}</div>`:"";
  return `<div class="note" data-staffing-list-prediction="1" data-prediction-subject="eligible-list-establishment" data-prediction-value="${escUiHtml(months)}-months">${statistic} ${window}
    <a href="about.html#staffing-list-establishment-formula">${t("exam_list_prediction_method")}</a></div>`;
}
function examListStatutoryContextHTML(exam){
  const extension=exam?.list_aggregate?.extension_date;
  if(!extension) return "";
  return `<div class="note" data-staffing-list-law-context="1">${t("exam_list_extension_observed",{
    date:fdate(extension)
  })} ${t("exam_list_duration_context")} <a href="https://www.nysenate.gov/legislation/laws/CVS/56" ${EXT_ATTRS}>${t("exam_list_law_source")}${extSR()}</a></div>`;
}
function examPhaseWhenHTML(phase, exam){
  if(phase?.primary?.when && phase.primary.when_to){
    return `${fdate(phase.primary.when)} – ${fdate(phase.primary.when_to)}`;
  }
  if(phase?.primary?.when) return fdate(phase.primary.when);
  if(phase?.id==="application" && exam){
    const a=exam.application_start?fdate(exam.application_start):"";
    const b=exam.application_end?fdate(exam.application_end):"";
    if(a && b) return `${a} – ${b}`;
    return a||b||"—";
  }
  return "—";
}
function examProcessSpineHTML(spine, exam, phaseView){
  if(!spine) return "";
  const joinNote=t("exam_spine_join_html",{
    number:escUiHtml(spine.exam_number||exam?.exam_number||"—"),
    title:escUiHtml(cleanText(spine.title||exam?.title)||"—")
  });

  // Phase-grouped compact stepper when the pure module loads.
  if(phaseView && Array.isArray(phaseView.phases) && phaseView.phases.length){
    const cur=phaseView.current;
    const actionLead=cur?`<p class="land-spine-status exam-phase-lead">${t("exam_phase_now_html",{
      phase:escUiHtml(examStageLabel(cur.id)),
      action:escUiHtml(t(cur.action_key||"exam_phase_action_application"))
    })}${phaseView.next?` · ${t("exam_phase_next_html",{phase:escUiHtml(examStageLabel(phaseView.next.id))})}`:""}</p>`:"";
    const stepper=`<ol class="lc-stepper exam-phase-stepper" aria-label="${escUiHtml(t("exam_spine_heading"))}">${
      phaseView.phases.map((p,i)=>{
        const cls=p.matched?(cur&&p.id===cur.id?"current":"done"):"todo";
        const aria=cur&&p.id===cur.id?` aria-current="step"`:"";
        const arrow=i<phaseView.phases.length-1?`<span class="lc-step-arrow" aria-hidden="true">→</span>`:"";
        const label=examStageLabel(p.id);
        return `<li><span class="lc-step lc-step-help ${cls}" tabindex="0" aria-label="${escUiHtml(label)}"${aria} title="${escUiHtml(label)}">${escUiHtml(p.short||label)}</span>${arrow}</li>`;
      }).join("")
    }</ol>`;
    // Detail only for matched phases + current (collapse pure-future empties to stepper chips).
    const cards=phaseView.phases.filter(p=>p.matched||(cur&&p.id===cur.id)
      ||(p.id==="list_establishment"&&exam?.list_establishment_forecast)).map(p=>{
      if(!p.matched){
        return `<div class="stage"><div class="box">
          <div class="stage-name">${examStageLabel(p.id)}</div>
          ${p.id==="list_establishment"&&exam?.list_establishment_forecast
            ?examListForecastHTML(exam)
            :`<div class="lc-norecord">${t("exam_stage_not_yet_ingested_html",{
            source:`<span lang="en" dir="ltr">${examStageSourceLabel(p.id)}</span>`
          })}</div>`}
        </div></div>`;
      }
      const when=examPhaseWhenHTML(p, exam);
      const countLine=examStageCountHTML(p);
      // One outbound source family per phase (deduped).
      const sourceLink=p.source_url
        ?`<div class="lc-pct"><a href="${escUiHtml(p.source_url)}" ${EXT_ATTRS}>${p.id==="application"?t("career_read_noe"):t("exam_phase_source_link")}${extSR()}</a></div>`
        :"";
      return `<div class="stage"><div class="box matched">
        <div class="stage-name">${examStageLabel(p.id)}</div>
        <div class="when">${escUiHtml(when)}</div>
        ${countLine?`<div class="lc-pct">${escUiHtml(countLine)}</div>`:""}
        ${sourceLink}
        ${p.id==="list_establishment"?examListStatutoryContextHTML(exam):""}
      </div></div>`;
    }).join('<div class="connector" aria-hidden="true">→</div>');
    return `<section class="career-exam-spine" data-exam-spine="1" data-exam-phase="1" aria-label="${escUiHtml(t("exam_spine_heading"))}">
      <div class="chain-h">${t("exam_spine_heading")}</div>
      <div class="note">${joinNote}</div>
      ${actionLead}
      ${stepper}
      <div class="chain exam-phase-cards">${cards}</div>
      <div class="note">${t("exam_spine_provenance_html")}</div>
    </section>`;
  }

  // Flat fallback when the phase module is unavailable.
  const stages=Array.isArray(spine.stages)?spine.stages:[];
  let chain="";
  stages.forEach((stage, idx)=>{
    const matched=stage && stage.matched;
    const primary=(Array.isArray(stage.events)&&stage.events[0])||null;
    let when="—";
    if(primary?.time?.value && primary.time.value_to){
      when=`${fdate(primary.time.value)} – ${fdate(primary.time.value_to)}`;
    } else if(primary?.time?.value){
      when=fdate(primary.time.value);
    } else if(stage.kind==="application" && exam){
      const a=exam.application_start?fdate(exam.application_start):"";
      const b=exam.application_end?fdate(exam.application_end):"";
      if(a && b) when=`${a} – ${b}`;
      else when=a||b||"—";
    }
    const countLine=examStageCountHTML(stage);
    if(matched){
      chain+=`<div class="stage"><div class="box matched">
        <div class="stage-name">${examStageLabel(stage.kind)}</div>
        <div class="when">${escUiHtml(when)}</div>
        ${countLine?`<div class="lc-pct">${escUiHtml(countLine)}</div>`:""}
        ${stage.kind==="list_establishment"?examListStatutoryContextHTML(exam):""}
      </div></div>`;
    } else {
      chain+=`<div class="stage"><div class="box">
        <div class="stage-name">${examStageLabel(stage.kind)}</div>
        ${stage.kind==="list_establishment"&&exam?.list_establishment_forecast
          ?examListForecastHTML(exam)
          :`<div class="lc-norecord">${t("exam_stage_not_yet_ingested_html",{
          source:`<span lang="en" dir="ltr">${examStageSourceLabel(stage.kind)}</span>`
        })}</div>`}
      </div></div>`;
    }
    if(idx < stages.length - 1) chain+='<div class="connector" aria-hidden="true">→</div>';
  });
  return `<section class="career-exam-spine" data-exam-spine="1" aria-label="${escUiHtml(t("exam_spine_heading"))}">
    <div class="chain-h">${t("exam_spine_heading")}</div>
    <div class="note">${joinNote}</div>
    <div class="chain">${chain}</div>
    <div class="note">${t("exam_spine_provenance_html")}</div>
  </section>`;
}
function careerOutcomeHTML(exam, options={}){
  const view=CrolStaffing.examOutcomeView(exam);
  if(view.kind==="joined"){
    return `<section class="career-outcomes" data-outcome="joined" aria-label="${escUiHtml(t("career_outcomes_heading"))}">
      <h3 class="career-outcomes-heading">${t("career_outcomes_heading")}</h3>
      <div class="career-outcomes-metrics">
        <div class="career-metric"><b>${careerCount(view.list_establishment)}</b><span>${t("career_outcome_list_established")}</span></div>
        <div class="career-metric"><b>${careerCount(view.certification_count)}</b><span>${t("career_outcome_hiring_pool")}</span></div>
        <div class="career-metric"><b>${careerCount(view.hire_count)}</b><span>${t("career_outcome_hired")}</span></div>
        <div class="career-metric"><b>${careerCount(view.applicant_count)}</b><span>${t("career_outcome_applicants")}</span></div>
      </div>
      <p class="career-outcomes-note">${t("career_outcomes_joined_note",{
        cycle:escUiHtml(view.application_cycle||t("career_date_unknown")),
        date:careerDate(view.published_on)
      })}</p>
    </section>`;
  }
  if(view.kind==="list_joined"){
    return `<section class="career-outcomes" data-outcome="list_joined" aria-label="${escUiHtml(t("career_outcomes_heading"))}">
      <h3 class="career-outcomes-heading">${t("career_outcomes_heading")}</h3>
      <div class="career-outcomes-metrics">
        <div class="career-metric"><b>${careerCount(view.list_count)}</b><span>${t("career_outcome_list_established")}</span></div>
      </div>
      <p class="career-outcomes-note">${t("career_outcomes_list_joined_note",{
        date:careerDate(view.established_date),
        source:t("career_outcomes_list_source_name")
      })}</p>
    </section>`;
  }
  // Published sources exist; an empty slot means incomplete join or pending cycle.
  if(options.spineMounted) return "";
  const stageKey={
    list_establishment:"career_outcome_stage_list",
    certification:"career_outcome_stage_certification",
    appointment:"career_outcome_stage_appointment"
  }[view.pending_stage]||"career_outcome_stage_list";
  return `<section class="career-outcomes" data-outcome="not_yet_ingested" aria-label="${escUiHtml(t("career_outcomes_heading"))}">
    <h3 class="career-outcomes-heading">${t("career_outcomes_heading")}</h3>
    <p class="career-outcomes-gap">${t("career_outcomes_not_yet_ingested_html",{
      stage:t(stageKey),
      source:t("career_outcomes_source_name")
    })}</p>
  </section>`;
}
function careerCardHTML(exam){
  const status=CrolStaffing.statusFor(exam,careerToday());
  const openBand=CrolStaffing.openWindowBand(exam,careerToday());
  const title=escUiHtml(exam.title);
  const selected=careerSelected===exam.exam_number;
  const countdown=careerCountdownText(exam,status);
  const feeSalary=CrolStaffing.examFeeSalaryView(exam);
  const notice=exam.notice_url
    ? `<a class="act" href="${escUiHtml(exam.notice_url)}" ${EXT_ATTRS}>${t("career_read_noe")}${extSR()}</a>`
    : `<a class="act" href="${escUiHtml(CrolStaffing.DCAS_OPEN_COMPETITIVE_URL)}" ${EXT_ATTRS}>${t("career_official_schedule")}${extSR()}</a>`;
  // Prefer a build-time OASys NOE deep link; otherwise label the browse landing honestly.
  const applyUrl=(window.CrolActions && CrolActions.examApplyUrl)
    ? CrolActions.examApplyUrl(exam)
    : (exam.official_application_url || CrolStaffing.OASY_APPLY_URL);
  const applyDeep=(window.CrolActions && typeof CrolActions.examApplyIsDeep==="function")
    ? CrolActions.examApplyIsDeep(applyUrl)
    : (exam.application_handoff_mode==="deep" || /\/noe\?examId=\d+/i.test(String(applyUrl||"")));
  const applyLabel=applyDeep?t("career_apply_oasys"):t("career_apply_oasys_browse");
  const apply=status==="open"
    ? `<a class="act primary" href="${escUiHtml(applyUrl)}" ${EXT_ATTRS} data-oasys-handoff="${applyDeep?"deep":"landing"}">${applyLabel}${extSR()}</a>`:"";
  const gapClass=feeSalary.class || (feeSalary.kind==="not_published"?"not_published":"not_yet_ingested");
  const diffLeads=careerDiffLeadsHTML(exam, feeSalary);
  const feeText=careerMoney(feeSalary.fee ?? exam.fee, gapClass);
  const salaryText=careerSalaryHTML(feeSalary, exam, gapClass);
  const factRows=[
    feeText?`<div class="career-action-fact"><b>${feeText}</b><span>${t("career_application_fee")}</span></div>`:"",
    salaryText?`<div class="career-action-fact"><b>${salaryText}</b><span>${t("career_starting_salary")}</span></div>`:"",
  ].filter(Boolean).join("");
  const actionFacts=`${factRows?`<div class="career-action-facts">${factRows}</div>`:""}${diffLeads}${examListForecastHTML(exam)}`;
  const expanded=selected;
  const hasNoeDetail=!!(exam.notice_url || feeSalary.kind==="joined" || exam.qualifications || exam.test_method || exam.exam_format);
  const feeWaiverLine=exam.fee_waiver_is_boilerplate
    ? t("career_fee_waiver_boilerplate")
    : (exam.fee_waiver || "");
  const details=hasNoeDetail ? `
    ${factRows?`<div class="career-metrics" data-fee-salary="${feeSalary.kind}">${factRows.replaceAll("career-action-fact","career-metric")}</div>`:""}
    ${exam.test_method||exam.exam_format?`<p class="career-detail-line"><b>${t("career_test_method")}</b> <span lang="en" dir="ltr">${escUiHtml(exam.test_method||careerFormatLabel(exam.exam_format))}</span></p>`:""}
    ${exam.qualifications?`<p class="career-detail-line"><b>${t("career_qualifications")}</b> <span lang="en" dir="ltr">${escUiHtml(exam.qualifications)}</span></p>`:""}
    ${exam.residency?`<p class="career-detail-line"><b>${t("career_diff_residency")}</b> <span lang="en" dir="ltr">${escUiHtml(exam.residency)}</span></p>`:""}
    ${feeWaiverLine?`<p class="career-detail-line"><b>${t("career_fee_waiver")}</b> <span lang="en" dir="ltr">${escUiHtml(feeWaiverLine)}</span></p>`:""}
    ${exam.amendment?`<p class="note warn" lang="en" dir="ltr">${escUiHtml(exam.amendment)}</p>`:""}
    <p class="career-english-note">${t("career_official_english_note")}</p>`
    : "";
  return `<article class="career-card${selected?" selected route-item":""}" data-status="${status}" data-exam-format="${escUiHtml(exam.exam_format||"")}" data-salary-band="${escUiHtml(exam.salary_band||"")}" data-fee-level="${escUiHtml(exam.fee_level||"")}" id="career-exam-${exam.exam_number}"${selected?' tabindex="-1"':""}>
    <div class="career-deadline-lead">
      <span class="tag ${careerStatusClass(status)}">${careerStatusLabel(status)}</span>
      ${openBand?`<span class="tag" data-open-window-band="${openBand}" lang="en" dir="ltr">${openBand}</span>`:""}
      ${exam.notice_url?`<span class="tag" data-noe-state="posted" lang="en" dir="ltr">NOE posted</span>`:""}
      ${exam.eligibility==="promotion"?`<span class="tag soon">${t("career_promotion_badge")}</span>`:""}
      <p class="career-deadline-primary">${careerWindowText(exam,status)}</p>
      ${countdown?`<span class="career-deadline-countdown">${countdown}</span>`:""}
    </div>
    <div class="career-card-head">
      <p class="career-card-title"><a href="#exam/${encodeURIComponent(exam.exam_number)}" lang="en" dir="ltr">${title}</a></p>
      <span class="career-exam-number">${t("career_exam_number",{number:escUiHtml(exam.exam_number)})}</span>
    </div>
    ${actionFacts}
    ${expanded&&exam.summary?`<p class="career-summary" lang="en" dir="ltr">${escUiHtml(exam.summary)}</p>`:""}
    ${expanded?details:""}
    ${expanded?(()=>{
      const tools=window.CrolExamProcessSpine;
      const spine=tools&&typeof tools.buildExamProcessSpine==="function"
        ? tools.buildExamProcessSpine(exam)
        : (exam.process_spine||null);
      const phaseTools=window.CrolExamPhaseSpine;
      const phaseView=phaseTools&&typeof phaseTools.buildExamPhaseView==="function"&&spine
        ? phaseTools.buildExamPhaseView(spine)
        : null;
      return examProcessSpineHTML(spine, exam, phaseView)+careerOutcomeHTML(exam,{spineMounted:!!spine});
    })():""}
    <div class="actions">${apply}${notice}
      ${expanded?`<button class="act" type="button" data-career-copy="${exam.exam_number}">${t("copy_link_btn")}</button>`:""}
      ${careerSelected===exam.exam_number?routeBackHTML("#people?view=guide",t("career_back_all"),"act"):""}
    </div>
  </article>`;
}
function careerAreaWatchesHTML(){
  const index=careerData?.interest_taxonomy;
  if(!index || !Array.isArray(index.areas)) return "";
  const today=careerToday();
  return index.areas.filter(area=>area.subscribable).map(area=>{
    const rows=careerData.exams.filter(exam=>exam.interest_area===area.id);
    const bands={far:0,approaching:0,imminent:0};
    rows.forEach(exam=>{ const band=CrolStaffing.openWindowBand(exam,today); if(band) bands[band]+=1; });
    const noe=rows.filter(exam=>exam.notice_url).length;
    const label=t(CAREER_AREA_KEYS[area.id]||"career_area_other");
    const chips=["far","approaching","imminent"].filter(band=>bands[band]>0)
      .map(band=>`<span class="tag" data-open-window-band="${band}" lang="en" dir="ltr">${band} ${bands[band]}</span>`);
    if(noe>0) chips.push(`<span class="tag" data-noe-state="posted" lang="en" dir="ltr">NOE posted ${noe}</span>`);
    return `<article class="career-area-watch" data-interest-area="${escUiHtml(area.id)}">
      <div class="career-area-watch-head"><a class="career-area-watch-title" href="#people?view=guide&interest=${encodeURIComponent(area.id)}">${escUiHtml(label)}</a></div>
      <div class="career-area-watch-meta">${chips.join("")}</div>
      <button class="act" type="button" data-follow-exam-area="${escUiHtml(area.id)}" data-follow-exam-label="${escUiHtml(label)}">${t("mini_subscribe_btn")}</button>
    </article>`;
  }).join("");
}
function careerActionGroup(exam, today){
  const status=CrolStaffing.statusFor(exam,today);
  if(status==="open" && !CrolStaffing.isContinuousExam(exam)) return "open";
  if(status==="upcoming" && !CrolStaffing.isContinuousExam(exam)) return "upcoming";
  if(CrolStaffing.isContinuousExam(exam)) return "continuous";
  return "other";
}
function careerResultsHTML(exams){
  const today=careerToday();
  const groups=[
    ["open","career_group_open"],
    ["upcoming","career_group_upcoming"],
    ["continuous","career_group_continuous"],
    ["other","career_group_other"],
  ];
  return groups.map(([id,labelKey])=>{
    const rows=exams.filter(exam=>careerActionGroup(exam,today)===id);
    if(!rows.length) return "";
    return `<section class="career-result-group" data-career-group="${id}" aria-labelledby="career-group-${id}">
      <h3 id="career-group-${id}">${t(labelKey)}</h3>
      <div class="career-result-grid">${rows.map(careerCardHTML).join("")}</div>
    </section>`;
  }).join("");
}
function careerFilters(){
  return {
    query:$("#career-query").value,
    interest:$("#career-interest").value,
    eligibility:$("#career-eligibility").value,
    window:$("#career-window").value,
    format:$("#career-format")?.value || "all",
    salary_band:$("#career-salary-band")?.value || "all",
    fee_level:$("#career-fee-level")?.value || "all",
    no_experience:$("#career-no-experience")?.value || "all",
  };
}
function renderCareerGuide(){
  if(!careerData) return;
  const today=careerToday();
  const open=careerData.exams.filter(exam=>exam.eligibility==="open_competitive"&&CrolStaffing.statusFor(exam,today)==="open").length;
  const upcoming=careerData.exams.filter(exam=>exam.eligibility==="open_competitive"&&CrolStaffing.statusFor(exam,today)==="upcoming").length;
  $("#career-open-count").textContent=fmtNumber(open);
  $("#career-upcoming-count").textContent=fmtNumber(upcoming);
  careerSourceHTML();
  const areaWatches=$("#career-area-watches");
  if(areaWatches){
    areaWatches.innerHTML=careerAreaWatchesHTML();
    areaWatches.querySelectorAll("[data-follow-exam-area]").forEach(button=>button.addEventListener("click",async()=>{
      const carry=await import("../alerts_context_carry.mjs");
      location.assign(carry.alertsHref({lens:"people",filter:{
        view:"guide",
        interestArea:button.dataset.followExamArea,
        interestLabel:button.dataset.followExamLabel,
      },freq:"daily"}));
    }));
  }
  let exams;
  if(careerSelected){
    const selected=careerData.exams.find(exam=>exam.exam_number===careerSelected);
    exams=selected?[selected]:[];
  }else{
    exams=CrolStaffing.filterExams(careerData.exams,careerFilters(),today);
  }
  const shown=exams.slice(0,careerLimit);
  $("#career-results").innerHTML=shown.length
    ? (careerSelected?shown.map(careerCardHTML).join(""):careerResultsHTML(shown))+(exams.length>shown.length?`<div class="career-more"><button type="button" id="career-more">${t("career_show_more",{n:fmtNumber(exams.length-shown.length)})}</button></div>`:"")
    : `<div class="career-empty">${careerSelected?t("career_exam_not_found"):t("career_no_results")}</div>`;
  $("#career-results").querySelectorAll("[data-career-copy]").forEach(button=>button.addEventListener("click",()=>{
    const link=CrolStaffing.examUrl(button.dataset.careerCopy,location.origin+location.pathname);
    copyText(link,button);
  }));
  $("#career-more")?.addEventListener("click",()=>{ careerLimit+=24; renderCareerGuide(); });
}
function applyCareerRouteFilters(){
  if(!careerRouteFilters) return;
  const {
    interest, eligibility, window: windowFilter,
    format, salary_band: salaryBand, fee_level: feeLevel, no_experience: noExperience,
  } = careerRouteFilters;
  const interestEl=$("#career-interest");
  if(interestEl){
    if(interest && CrolStaffing.isInterestArea(interest) && [...interestEl.options].some(option=>option.value===interest)){
      interestEl.value=interest;
    } else if(interest===null || interest==="all"){
      interestEl.value="all";
    }
  }
  const eligibilityEl=$("#career-eligibility");
  if(eligibilityEl){
    if(eligibility && ["open_competitive","promotion","all"].includes(eligibility)) eligibilityEl.value=eligibility;
    else if(eligibility===null) eligibilityEl.value="open_competitive";
  }
  const windowEl=$("#career-window");
  if(windowEl){
    if(windowFilter && ["actionable","open","upcoming","all"].includes(windowFilter)) windowEl.value=windowFilter;
    else if(windowFilter===null) windowEl.value="actionable";
  }
  const formatEl=$("#career-format");
  if(formatEl){
    if(format && [...formatEl.options].some(option=>option.value===format)) formatEl.value=format;
    else if(format===null || format==="all") formatEl.value="all";
  }
  const salaryEl=$("#career-salary-band");
  if(salaryEl){
    if(salaryBand && [...salaryEl.options].some(option=>option.value===salaryBand)) salaryEl.value=salaryBand;
    else if(salaryBand===null || salaryBand==="all") salaryEl.value="all";
  }
  const feeEl=$("#career-fee-level");
  if(feeEl){
    if(feeLevel && [...feeEl.options].some(option=>option.value===feeLevel)) feeEl.value=feeLevel;
    else if(feeLevel===null || feeLevel==="all") feeEl.value="all";
  }
  const expEl=$("#career-no-experience");
  if(expEl){
    if(noExperience && [...expEl.options].some(option=>option.value===noExperience)) expEl.value=noExperience;
    else if(noExperience===null || noExperience==="all") expEl.value="all";
  }
  careerRouteFilters=null;
}
function populateCareerInterests(){
  const select=$("#career-interest"), current=select.value||"all";
  select.innerHTML=`<option value="all">${t("career_all_interests")}</option>`+careerData.interest_areas
    .map(area=>`<option value="${area}">${t(CAREER_AREA_KEYS[area]||"career_area_other")}</option>`).join("");
  select.value=[...select.options].some(option=>option.value===current)?current:"all";
  applyCareerRouteFilters();
}
function validCareerData(data){
  return data && Number(data.schema_version)>=CAREER_DATA_SCHEMA_VERSION && Array.isArray(data.exams)
    && data.exams.length>0 && Array.isArray(data.interest_areas) && Array.isArray(data.sources);
}
async function fetchCareerData(){
  let lastError=null;
  for(let attempt=0; attempt<CAREER_LOAD_ATTEMPTS; attempt+=1){
    try{
      const response=await fetch(CAREER_DATA_URL,attempt?{cache:"reload"}:undefined);
      if(!response.ok) throw new Error(`staffing exams HTTP ${response.status}`);
      const data=await response.json();
      if(!validCareerData(data)) throw new Error("staffing exams schema mismatch");
      return data;
    }catch(error){
      lastError=error;
      if(attempt+1<CAREER_LOAD_ATTEMPTS){
        await new Promise(resolve=>setTimeout(resolve,CAREER_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}
async function hydrateCareerSpineTools(data){
  const [spineMod,phaseMod]=await Promise.all([
    ensureExamProcessSpineTools(),
    ensureExamPhaseSpineTools(),
  ]);
  const shouldRender=!careerSpinesHydrated;
  careerSpinesHydrated=true;
  if(spineMod) window.CrolExamProcessSpine=spineMod;
  if(phaseMod) window.CrolExamPhaseSpine=phaseMod;
  if(shouldRender && careerData===data && careerSelected){
    const targetId="career-exam-"+careerSelected;
    const restoreFocus=document.activeElement?.id===targetId;
    try{
      renderCareerGuide();
      if(restoreFocus){
        const target=document.getElementById(targetId);
        requestAnimationFrame(()=>{
          if(target?.isConnected && target.closest(".tabpane.active")) target.focus({preventScroll:true});
        });
      }
    }
    catch(error){ console.error(t("career_load_failed"),error); }
  }
}
async function paintCareerData(data){
  let lastError=null;
  for(let attempt=0; attempt<CAREER_LOAD_ATTEMPTS; attempt+=1){
    try{
      careerData=data;
      populateCareerInterests();
      renderCareerGuide();
      return;
    }catch(error){
      lastError=error;
      if(attempt+1<CAREER_LOAD_ATTEMPTS){
        await new Promise(resolve=>setTimeout(resolve,CAREER_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}
function showCareerLoadFailure(error){
  console.error(t("career_load_failed"),error);
  $("#career-source").classList.add("stale");
  $("#career-source").innerHTML=`<span>${t("career_load_failed")}</span>`;
  $("#career-results").innerHTML=`<div class="career-empty">${t("career_load_failed")}</div>`;
}
async function loadCareerGuide(){
  if(careerData){
    await paintCareerData(careerData);
    await hydrateCareerSpineTools(careerData);
    return careerData;
  }
  if(careerLoadPromise) return careerLoadPromise;
  careerLoadPromise=(async()=>{
    let data;
    try{
      data=await fetchCareerData();
    }catch(error){
      careerLoadPromise=null;
      showCareerLoadFailure(error);
      return null;
    }
    try{
      await paintCareerData(data);
    }catch(error){
      careerLoadPromise=null;
      console.error(t("career_load_failed"),error);
      throw error;
    }
    await hydrateCareerSpineTools(data);
    return data;
  })();
  return careerLoadPromise;
}
function paintExamDetailShell(examNumber){
  const guide=$("#career-guide");
  if(guide) guide.hidden=false;
  prepareCareerHow();
  syncStaffingModeUI();
  // Warm artifacts paint the full detail synchronously.
  if(careerData){
    renderCareerGuide();
    return;
  }
  const results=$("#career-results");
  if(!results) return;
  const safe=escUiHtml(examNumber);
  results.innerHTML=`<article class="career-card selected route-item" data-status="loading" id="career-exam-${safe}" tabindex="-1" data-exam-loading="1" aria-busy="true">
    <div class="career-card-head">
      <p class="career-card-title">${t("career_exam_number",{number:safe})}</p>
    </div>
    <p class="career-empty"><span class="loading" aria-hidden="true"></span> ${t("career_loading")}</p>
  </article>`;
  const openEl=$("#career-open-count");
  const upcomingEl=$("#career-upcoming-count");
  if(openEl && openEl.textContent==="—"){ /* keep placeholder until load */ }
  if(upcomingEl && upcomingEl.textContent==="—"){ /* keep placeholder until load */ }
}
function showExam(examNumber){
  const id=String(examNumber||"").trim();
  careerSelected=id; careerLimit=16;
  staffingFilters.query=""; staffingFilters.role=""; staffingFilters.agency="";
  showTab("people");
  // Mount detail before fetching so a cold deep link never looks list-only.
  paintExamDetailShell(id);
  requestAnimationFrame(()=>{
    const shell=$("#career-exam-"+CSS.escape(id))||$("#career-guide");
    if(shell) shell.scrollIntoView({block:"start"});
  });
  loadCareerGuide().then(()=>{
    if(careerSelected!==id) return; // user navigated away
    renderCareerGuide();
    syncStaffingModeUI();
    focusItemRouteTarget($("#career-exam-"+CSS.escape(id)));
    applyActiveHistoryRouteScroll();
  });
}
function scrollStaffingView(view){
  const guide=$("#career-guide");
  guide.hidden=false;
  const ledger=$("#staffing-ledger");
  if(view==="notices" && ledger) ledger.open=true;
  const target=view==="guide"?guide:view==="notices"?ledger:null;
  if(!target) return;
  requestAnimationFrame(()=>{
    target.scrollIntoView({block:"start"});
    if(view==="notices") $("#staffing-query")?.focus({preventScroll:true});
  });
}

function parsePersonnel(desc){
  const t = cleanText(desc);
  const g = re => { const m = t.match(re); return m ? m[1].trim() : ""; };
  return {
    eff:    g(/Effective Date:\s*([\d/]+)/i),
    prov:   g(/Provisional Status:\s*(\w+)/i),
    code:   g(/Title Code:\s*(\w+)/i),
    reason: g(/Reason For Change:\s*([A-Za-z ]+?)\s*;/i),
    salary: g(/Salary:\s*([\d.]+)/i),
    name:   g(/Employee Name:\s*([^.]+?)\s*\.?\s*$/i)
  };
}

// Bare #people teaches by example with the live highest-headcount title.
let peopleDefaulted = false;
async function defaultRoleTitle(){
  try{
    const rows = await api(PAY, {"$select":"title_description, count(1) as n",
      "$where":`fiscal_year=${PAYFY} AND base_salary > 0 AND title_description IS NOT NULL`,
      "$group":"title_description","$order":"n DESC","$limit":"5"});
    if(!rows || !rows.length) return null;
    rows.sort((a,b)=>(+b.n||0)-(+a.n||0));
    return rows[0].title_description || null;
  }catch(e){ return null; }
}
async function applyPeopleDefault(){
  if(peopleDefaulted) return; peopleDefaulted = true;
  if($("#pkw").value.trim() || $("#pmode").value !== "role") return; // deep link/explicit choice wins
  const title = await defaultRoleTitle();
  if(!title || $("#pkw").value.trim()) return; // no live data, or the user started typing while we waited
  $("#pkw").value = title;
  hashLock = true; // an auto-picked example shouldn't decorate a fresh #people load (mirrors updateHash's money case)
  try{ await pSearch(); } finally { hashLock = false; }
}

// Committed examples paint before the live search replaces them.
let peopleSeeded = false, pExamples = [];
async function seedPeople(){
  if(peopleSeeded) return; peopleSeeded = true;
  try{ pExamples = await fetch("data/people_examples.json").then(r=>r.ok?r.json():[]); }catch(e){ pExamples=[]; }
  const box = $("#pchips");
  if(box && pExamples.length){
    box.innerHTML = `<span style="font:600 11px/2.4 ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">${t("try_label")}</span>` +
      pExamples.map((x,i)=>`<button type="button" class="chip" data-i="${i}" title="${String(x.note||"").replace(/"/g,"&quot;")}">${x.label}<span class="ct">${money(x.base_median)||""}${x.competitive?t("exam_suffix"):""}</span></button>`).join("");
    box.querySelectorAll(".chip").forEach(b=>b.addEventListener("click",()=>pExample(+b.dataset.i)));
  }
  try{
    const cw = await fetch("data/title_crosswalk.json").then(r=>r.ok?r.json():null);
    const dl = $("#ptitles");
    if(dl && Array.isArray(cw)){
      const names = [...new Set(cw.map(t=>t.official_title||t.payroll_title).filter(Boolean))].sort();
      dl.innerHTML = names.map(n=>`<option value="${String(n).replace(/"/g,"&quot;")}">`).join("");
    }
  }catch(e){}
}
function pExample(i){
  const x = pExamples[i]; if(!x) return;
  $("#pmode").value = "role"; $("#pmode").dispatchEvent(new Event("change"));
  $("#pkw").value = x.keyword;
  const maxAvg = Math.max.apply(null,(x.ladder||[]).map(l=>+l.avg||0)) || 1;
  $("#pdetail").innerHTML = `<div class="rolename">${x.official_title}</div>
    <div class="badges"><span class="tag ${x.competitive?'open':'soon'}">${x.competitive?t("competitive_badge"):t("noncompetitive_badge")}</span></div>
    <div class="agencybar">
      <div><div class="big">${money(x.base_median)||"—"}</div><div class="lbl">${t("median_base_lbl",{fy:PAYFY})}</div></div>
      <div><div class="big">${money(x.base_min)||"—"}–${money(x.base_max)||"—"}</div><div class="lbl">${t("base_range_lbl")}</div></div>
      <div><div class="big">${fmtNumber(+x.headcount||0)}</div><div class="lbl">${t("people_lbl")}</div></div>
    </div>
    ${x.ladder&&x.ladder.length?`<div class="chain-h">${t("career_ladder_top")}</div><div class="ladder">${x.ladder.map(l=>`<div class="lrow ${l.title===x.official_title?'me':''}"><div class="lname">${l.title}</div><div class="lbar"><span style="width:${Math.round((+l.avg/maxAvg)*100)}%"></span></div><div class="lval">${money(l.avg)}</div></div>`).join("")}</div>`:""}
    ${x.note?`<div class="note">${x.note}</div>`:""}
    <div class="rmeta2" style="margin-top:10px"><span class="loading"></span> ${t("refreshing_payroll")}</div>`;
  pSearch(true);
}

async function pSearch(keepDetail){
  pMode = $("#pmode").value;
  const kw = $("#pkw").value.trim();
  updateHash();
  renderSearchComponents("people");
  $("#preshead").textContent = pMode === "role" ? t("roles_heading") : t("people_heading");
  $("#prescount").textContent = "";
  if(keepDetail !== true) $("#pdetail").innerHTML = '<div class="empty">' + t("pick_result_empty") + '</div>';
  if(!kw){ $("#plist").innerHTML = '<div class="empty">' + t("type_keyword_empty") + '</div>'; return; }
  busyList("#plist", 3);
  const stale = staleGuard("people");
  try{
    pMode === "role" ? await pSearchRoles(kw, stale) : await pSearchPeople(kw, stale);
    unbusy("#plist");
  }
  catch(e){ if(!stale()){ unbusy("#plist"); $("#plist").innerHTML = '<div class="empty">' + t("could_not_reach") + '</div>'; } }
}

// The LIKE query guarantees title evidence; the caller supplies competitive status.
function roleRowHTML(r, i, terms, comp2, exam){
  const ev = matchEvidence(r.title_description, "", terms);
  const status=exam?CrolStaffing.statusFor(exam,careerToday()):null;
  const examLink=exam?`<a class="staffing-exam-link" href="#exam/${encodeURIComponent(exam.exam_number)}">
      <span class="tag ${careerStatusClass(status)}">${status==="open"?t("staffing_exam_open_tag"):t("staffing_exam_upcoming_tag")}</span>
      <span class="staffing-exam-window">${careerWindowText(exam,status)}</span>
    </a>`:"";
  return `<article class="row staffing-role-row" data-i="${i}">
    <button type="button" class="staffing-role-select" data-rsel>
      <p class="rtitle">${digTitleHTML(r.title_description, ev)}</p>
      <p class="rmeta"><span class="tag ${comp2?'open':'soon'}">${comp2?t("exam_title_tag"):t("no_exam_title_tag")}</span>
        ${fmtNumber(+r.n)} ${t("people_lbl")} · ${money(r.mn)}–${money(r.mx)}</p>
    </button>
    ${examLink}
  </article>`;
}
async function pSearchRoles(kw, stale){
  const up = kw.toUpperCase().replace(/'/g,"''");
  const [pay, comp] = await Promise.all([
    api(PAY, {"$select":"title_description, count(1) as n, min(base_salary) as mn, max(base_salary) as mx, avg(base_salary) as avg",
      "$where":`fiscal_year=${PAYFY} AND upper(title_description) like '%${up}%' AND base_salary > 0`,
      "$group":"title_description","$order":"avg DESC","$limit":"40"}),
    api(CSL, {"$select":"list_title_desc","$where":`upper(list_title_desc) like '%${up}%'`,"$group":"list_title_desc","$limit":"300"})
  ]);
  await loadCareerGuide();
  if(stale && stale()) return;
  competitiveSet = new Set(comp.map(c=>(c.list_title_desc||"").toUpperCase().trim()));
  pRows = pay;
  $("#prescount").textContent = pay.length === 40 ? "40+" : pay.length;
  announce(t("matching_roles_announce",{n: pay.length===40 ? "40+" : pay.length}));
  if(!pay.length){ $("#plist").innerHTML = '<div class="empty">' + t("no_titles_match") + '</div>'; return; }
  const terms = kw ? [kw] : [];
  $("#plist").innerHTML = pay.map((r,i)=>roleRowHTML(
    r,
    i,
    terms,
    competitiveSet.has((r.title_description||"").toUpperCase().trim()),
    careerData?CrolStaffing.examForTitle(careerData.exams,r.title_description,careerToday()):null
  )).join("");
  document.querySelectorAll("#plist [data-rsel]").forEach(button=>{
    const row=button.closest(".row");
    button.addEventListener("click",()=>pSelectRole(+row.dataset.i,row));
  });
  document.querySelector("#plist [data-rsel]")?.click();
}

function pSelectRole(i, el){
  document.querySelectorAll("#plist .row.sel").forEach(e=>e.classList.remove("sel"));
  el.classList.add("sel");
  const r = pRows[i];
  const comp = competitiveSet.has((r.title_description||"").toUpperCase().trim());
  const exam=careerData?CrolStaffing.examForTitle(careerData.exams,r.title_description,careerToday()):null;
  const examStatus=exam?CrolStaffing.statusFor(exam,careerToday()):null;
  const ladder = [...pRows].sort((a,b)=>(+a.avg)-(+b.avg));
  const maxAvg = Math.max.apply(null, ladder.map(x=>+x.avg||0)) || 1;
  let html = `<h2 class="rolename" lang="en" dir="ltr">${r.title_description}</h2>
    <div class="badges"><span class="tag ${comp?'open':'soon'}">${comp?t("competitive_badge"):t("noncompetitive_badge")}</span></div>
    ${exam?`<div class="note"><b>${examStatus==="open"?t("staffing_exam_open_tag"):t("staffing_exam_upcoming_tag")}:</b> ${careerWindowText(exam,examStatus)}
      <a href="#exam/${encodeURIComponent(exam.exam_number)}">${t("staffing_view_exam_detail")}</a></div>`:""}
    <div class="agencybar">
      <div><div class="big">${money(r.mn)}–${money(r.mx)}</div><div class="lbl">${t("base_salary_band_lbl")}</div></div>
      <div><div class="big">${money(r.avg)}</div><div class="lbl">${t("average_base_lbl")}</div></div>
      <div><div class="big">${fmtNumber(+r.n)}</div><div class="lbl">${t("people_fy_lbl",{fy:PAYFY})}</div></div>
    </div>
    <div class="chain-h">${t("career_ladder_matching")}</div><div class="ladder">`;
  ladder.forEach(x=>{
    const w = Math.round((+x.avg/maxAvg)*100);
    const me = x.title_description === r.title_description;
    html += `<div class="lrow ${me?'me':''}">
      <div class="lname">${x.title_description}</div>
      <div class="lbar"><span style="width:${w}%"></span></div>
      <div class="lval">${money(x.avg)}</div></div>`;
  });
  html += `</div><div class="note">${t("salary_note_html",{fy:PAYFY})}</div>`;
  $("#pdetail").innerHTML = html;
}

// Aggregate person evidence uses the first underlying notice that explains the match.
function personRowHTML(p, i, terms){
  let ev = null;
  for(const a of p.actions){ const e = matchEvidence(p.name, a.text, terms); if(!ev) ev = e; if(e.field !== "unknown"){ ev = e; break; } }
  return `<div class="row" data-i="${i}" tabindex="0" role="button">
      <p class="rtitle">${digTitleHTML(p.name, ev)}</p>
      <p class="rmeta"><span class="ragency" lang="en" dir="ltr">${p.agency}</span> · ${tn("n_notices_meta",p.actions.length)}</p>
      ${digEvidenceHTML(ev)}
    </div>`;
}
async function pSearchPeople(kw, stale){
  const rows = await soda({"$select":"request_id,start_date,agency_name,short_title,additional_description_1,other_info_1",
    "$where":"section_name='Changes in Personnel'","$q":kw,"$order":"start_date DESC","$limit":"100"});
  if(stale && stale()) return;
  const people = new Map();
  rows.forEach(r=>{
    const p = parsePersonnel(r.additional_description_1);
    if(!p.name) return;
    const key = p.name.toUpperCase() + "|" + r.agency_name;
    if(!people.has(key)) people.set(key, {name:p.name, agency:r.agency_name, actions:[]});
    // Keep notice text per action so grouped-person evidence stays attributable.
    people.get(key).actions.push({date:r.start_date, reason:p.reason||cleanText(r.short_title), salary:p.salary, code:p.code, req:r.request_id, text:cleanText(r.short_title)+" "+matchText(r)});
  });
  pRows = [...people.values()].sort((a,b)=>b.actions.length-a.actions.length);
  $("#prescount").textContent = pRows.length;
  if(!pRows.length){ $("#plist").innerHTML = '<div class="empty">' + t("no_personnel") + '</div>'; return; }
  const terms = [kw];
  $("#plist").innerHTML = pRows.map((p,i)=>personRowHTML(p,i,terms)).join("");
  document.querySelectorAll("#plist .row").forEach(el=>el.addEventListener("click",()=>pSelectPerson(+el.dataset.i, el)));
  document.querySelector("#plist .row")?.click();
}

async function pSelectPerson(i, el){
  document.querySelectorAll("#plist .row.sel").forEach(e=>e.classList.remove("sel"));
  el.classList.add("sel");
  const p = pRows[i];
  $("#pdetail").innerHTML = '<div class="empty"><span class="loading"></span> ' + t("pulling_payroll") + '</div>';
  const parts = p.name.split(",");
  const last = (parts[0]||"").trim().toUpperCase();
  const first = (parts[1]||"").trim().split(/\s+/)[0].toUpperCase();
  let pay = [];
  try{
    if(last && first) pay = await api(PAY, {
      "$select":"fiscal_year,title_description,base_salary,regular_gross_paid,total_ot_paid,agency_name,leave_status_as_of_june_30",
      "$where":`upper(last_name)='${last.replace(/'/g,"''")}' AND upper(first_name) like '${first.replace(/'/g,"''")}%'`,
      "$order":"fiscal_year DESC","$limit":"4"});
  }catch(e){}
  const cur = pay[0];
  let html = `<h2 class="rolename" lang="en" dir="ltr">${p.name}</h2><div class="badges"><span class="tag">${p.agency}</span></div>`;
  if(cur){
    html += `<div class="agencybar">
      <div><div class="big">${money(cur.base_salary)||"—"}</div><div class="lbl">${t("base_salary_fy_lbl",{fy:cur.fiscal_year})}</div></div>
      <div><div class="big">${money(cur.regular_gross_paid)||"—"}</div><div class="lbl">${t("gross_paid_lbl")}</div></div>
      <div><div class="big">${money(cur.total_ot_paid)||"$0"}</div><div class="lbl">${t("overtime_lbl")}</div></div>
    </div><div class="rmeta2">${t("payroll_title_lbl")} <b>${cur.title_description}</b>${cur.leave_status_as_of_june_30? " · "+cur.leave_status_as_of_june_30 : ""}</div>`;
  } else {
    html += `<div class="note">${t("no_payroll_match_note")}</div>`;
  }
  const acts = p.actions.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  html += `<div class="chain-h">${t("city_record_history")}</div><div class="timeline">`;
  acts.forEach(a=>{
    html += `<div class="tl"><span class="tldate">${fdate(a.date)}</span>
      <span class="tlreason">${a.reason||""}</span>
      ${a.salary && a.salary!=="1.00" && a.salary!=="1"? `<span class="tlsal">${money(a.salary)}</span>`:""}
      ${a.code? `<span class="pin">${t("code_label",{code:a.code})}</span>`:""}
      <a class="view" href="${REQ_URL(a.req)}" style="margin-inline-start:auto" ${EXT_ATTRS}>${t("view_in_city_record")}${extSR()}</a></div>`;
  });
  html += `</div>`;
  $("#pdetail").innerHTML = html;
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.CAREER_AREA_KEYS = CAREER_AREA_KEYS;
globalThis.CAREER_HOW_SEEN_KEY = CAREER_HOW_SEEN_KEY;
globalThis.applyCareerRouteFilters = applyCareerRouteFilters;
globalThis.applyPeopleDefault = applyPeopleDefault;
globalThis.bindStaffingFacets = bindStaffingFacets;
globalThis.careerActionGroup = careerActionGroup;
globalThis.careerCardHTML = careerCardHTML;
globalThis.careerCount = careerCount;
globalThis.careerCountdownText = careerCountdownText;
globalThis.careerDate = careerDate;
globalThis.careerFilters = careerFilters;
globalThis.careerMoney = careerMoney;
globalThis.careerOutcomeHTML = careerOutcomeHTML;
globalThis.careerResultsHTML = careerResultsHTML;
globalThis.careerSalaryHTML = careerSalaryHTML;
globalThis.careerSourceHTML = careerSourceHTML;
globalThis.careerStatusClass = careerStatusClass;
globalThis.careerStatusLabel = careerStatusLabel;
globalThis.careerToday = careerToday;
globalThis.careerWindowText = careerWindowText;
globalThis.defaultRoleTitle = defaultRoleTitle;
globalThis.ensureExamPhaseSpineTools = ensureExamPhaseSpineTools;
globalThis.ensureExamProcessSpineTools = ensureExamProcessSpineTools;
globalThis.examListForecastHTML = examListForecastHTML;
globalThis.examListStatutoryContextHTML = examListStatutoryContextHTML;
globalThis.examPhaseWhenHTML = examPhaseWhenHTML;
globalThis.examProcessSpineHTML = examProcessSpineHTML;
globalThis.examStageCountHTML = examStageCountHTML;
globalThis.examStageLabel = examStageLabel;
globalThis.examStageSourceLabel = examStageSourceLabel;
globalThis.loadCareerGuide = loadCareerGuide;
globalThis.loadStaffingFeed = loadStaffingFeed;
globalThis.loadStaffingHiresSnapshot = loadStaffingHiresSnapshot;
globalThis.pExample = pExample;
globalThis.pSearch = pSearch;
globalThis.pSearchPeople = pSearchPeople;
globalThis.pSearchRoles = pSearchRoles;
globalThis.pSelectPerson = pSelectPerson;
globalThis.pSelectRole = pSelectRole;
globalThis.paintExamDetailShell = paintExamDetailShell;
globalThis.parsePersonnel = parsePersonnel;
globalThis.personRowHTML = personRowHTML;
globalThis.populateCareerInterests = populateCareerInterests;
globalThis.prepareCareerHow = prepareCareerHow;
globalThis.renderCareerGuide = renderCareerGuide;
globalThis.renderStaffingFeed = renderStaffingFeed;
globalThis.roleRowHTML = roleRowHTML;
globalThis.scrollStaffingView = scrollStaffingView;
globalThis.seedPeople = seedPeople;
globalThis.showExam = showExam;
globalThis.staffingFacetHTML = staffingFacetHTML;
globalThis.staffingFilters = staffingFilters;
globalThis.staffingVisibleItems = staffingVisibleItems;
globalThis.syncStaffingModeUI = syncStaffingModeUI;
Object.defineProperty(globalThis, "careerData", { configurable: true, get: () => careerData, set: value => { careerData = value; } });
Object.defineProperty(globalThis, "careerHowPrepared", { configurable: true, get: () => careerHowPrepared, set: value => { careerHowPrepared = value; } });
Object.defineProperty(globalThis, "careerLimit", { configurable: true, get: () => careerLimit, set: value => { careerLimit = value; } });
Object.defineProperty(globalThis, "careerLoadPromise", { configurable: true, get: () => careerLoadPromise, set: value => { careerLoadPromise = value; } });
Object.defineProperty(globalThis, "careerRouteFilters", { configurable: true, get: () => careerRouteFilters, set: value => { careerRouteFilters = value; } });
Object.defineProperty(globalThis, "careerSelected", { configurable: true, get: () => careerSelected, set: value => { careerSelected = value; } });
Object.defineProperty(globalThis, "competitiveSet", { configurable: true, get: () => competitiveSet, set: value => { competitiveSet = value; } });
Object.defineProperty(globalThis, "examPhaseSpineToolsPromise", { configurable: true, get: () => examPhaseSpineToolsPromise, set: value => { examPhaseSpineToolsPromise = value; } });
Object.defineProperty(globalThis, "examProcessSpineToolsPromise", { configurable: true, get: () => examProcessSpineToolsPromise, set: value => { examProcessSpineToolsPromise = value; } });
Object.defineProperty(globalThis, "pExamples", { configurable: true, get: () => pExamples, set: value => { pExamples = value; } });
Object.defineProperty(globalThis, "pMode", { configurable: true, get: () => pMode, set: value => { pMode = value; } });
Object.defineProperty(globalThis, "pRows", { configurable: true, get: () => pRows, set: value => { pRows = value; } });
Object.defineProperty(globalThis, "peopleDefaulted", { configurable: true, get: () => peopleDefaulted, set: value => { peopleDefaulted = value; } });
Object.defineProperty(globalThis, "peopleSeeded", { configurable: true, get: () => peopleSeeded, set: value => { peopleSeeded = value; } });
Object.defineProperty(globalThis, "staffingLoadPromise", { configurable: true, get: () => staffingLoadPromise, set: value => { staffingLoadPromise = value; } });
Object.defineProperty(globalThis, "staffingLoaded", { configurable: true, get: () => staffingLoaded, set: value => { staffingLoaded = value; } });
Object.defineProperty(globalThis, "staffingNotices", { configurable: true, get: () => staffingNotices, set: value => { staffingNotices = value; } });
