import {
  examFacetHref,
  examFacetOptionValues,
  examFacetValue,
} from "../exam_detail_facets.mjs";
import {
  examNumbersForAgency,
  filterExamsByAgencyScope,
} from "../staffing_agency_scope.mjs";
import {
  filterChip,
  installFilterChipNavigation,
  objectCardInteractionProjection,
  officialSourceLink,
  renderObjectCardActionRail,
  renderObjectCardCopy,
  renderObjectCardTitle,
  staticFact,
} from "../affordance_grammar.mjs";
import { createIncrementalList } from "../incremental_list.mjs";

/* ===================== EXAMS ===================== */
let careerData = null, careerLoadPromise = null, careerSelected = null;
let careerIncrementalList = null, careerRenderItems = [];
// interest: sorted known area ids (OR semantics). Empty = All interests.
let careerFacetState = {interest:[],window:"actionable",format:"all",salary_band:"all",fee_level:"all",no_experience:"all"};
/** Counts next to Interest Area options are under-current-filter (other active filters applied; interest itself excluded). */
const CAREER_INTEREST_COUNTS_BASIS = "under_current_filter";
const CAREER_DATA_URL = "data/staffing_exams.json";
const CAREER_DATA_SCHEMA_VERSION = 4;
const CAREER_LOAD_ATTEMPTS = 2;
const CAREER_RETRY_DELAY_MS = 250;
let careerRouteFilters = null;
let careerHowPrepared = false;
const CAREER_HOW_SEEN_KEY = "crol_exam_how_seen_v1";
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
const EXAM_CERTIFICATION_URL = "data/exam_certification_constellation.json";
let examsAgencyScope = "";
let examsAgencyExamNumbers = null;
let examsAgencyScopePromise = null;

function prepareCareerHow(){
  if(careerHowPrepared) return;
  const details=$("#career-how-details");
  if(!details) return;
  let seen=false;
  try{ seen=localStorage.getItem(CAREER_HOW_SEEN_KEY)==="1"; }catch(e){}
  details.open=!seen;
  if(!seen){ try{ localStorage.setItem(CAREER_HOW_SEEN_KEY,"1"); }catch(e){} }
  careerHowPrepared=true;
}
function examsAgencyScopeKey(){
  return String(examsAgencyScope || "").trim();
}
async function loadExamsAgencyScope(agency){
  const key=String(agency||"").trim();
  if(!key){
    examsAgencyExamNumbers=null;
    examsAgencyScopePromise=null;
    return null;
  }
  if(examsAgencyScopePromise && examsAgencyScopePromise.key===key){
    return examsAgencyScopePromise.promise;
  }
  const promise=(async()=>{
    try{
      const payload=await fetch(EXAM_CERTIFICATION_URL).then(response=>response.ok?response.json():null);
      return examNumbersForAgency(payload,key);
    }catch(_error){
      return new Set();
    }
  })();
  examsAgencyScopePromise={key,promise};
  examsAgencyExamNumbers=await promise;
  return examsAgencyExamNumbers;
}
function setExamsAgencyScope(agency){
  const next=String(agency||"").trim();
  if(next===examsAgencyScope) return;
  examsAgencyScope=next;
  examsAgencyExamNumbers=null;
  examsAgencyScopePromise=null;
  if(next) loadExamsAgencyScope(next).then(()=>{ if(careerData) renderCareerGuide(); });
}
function syncExamsModeUI(){
  const guide=$("#career-guide");
  if(!guide) return;
  guide.hidden=false;
  if(careerSelected || careerData) prepareCareerHow();
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
function careerSelectedInterests(){
  return CrolStaffing.normalizeInterestSelection(careerFacetState.interest);
}
function careerFacetFilters(){
  const interests=careerSelectedInterests();
  return {
    ...careerFacetState,
    interest: interests.length ? CrolStaffing.serializeInterestSelection(interests) : "all",
    interests,
    eligibility:$("#career-eligibility")?.value || "open_competitive",
  };
}
function careerFacetLabel(facet,value){
  if(value==="all") return t({eligibility:"career_all_eligibility_option",interest:"career_all_interests",window:"career_all_windows_option",format:"career_format_all",salary:"career_salary_band_all",fee:"career_fee_level_all",experience:"career_experience_all"}[facet]);
  if(facet==="eligibility"){
    if(value==="promotion") return t("career_city_employee_option");
    if(value==="open_competitive") return t("career_anyone_option");
    return t("career_all_eligibility_option");
  }
  if(facet==="interest") return t(CAREER_AREA_KEYS[value]||"career_area_other");
  if(facet==="window") return value==="actionable" ? t("career_actionable_option") : careerStatusLabel(value);
  if(facet==="format") return careerFormatLabel(value);
  if(facet==="salary") return t({
    under_45k:"career_salary_under_45k", "45k_60k":"career_salary_45k_60k",
    "60k_80k":"career_salary_60k_80k", "80k_plus":"career_salary_80k_plus",
  }[value] || "career_salary_band_all");
  if(facet==="fee") return value==="fee-bearing" ? `${t("career_fee_mid")}+` : t({
    none:"career_fee_none", low:"career_fee_low",
  }[value] || "career_fee_level_all");
  if(facet==="experience") return t(value==="yes" ? "career_no_experience_yes" : "career_experience_required");
  return value;
}
function setCareerInterests(next){
  careerFacetState.interest=CrolStaffing.normalizeInterestSelection(next);
}
function toggleCareerInterest(area){
  if(area==="all"){
    setCareerInterests([]);
    return;
  }
  if(!CrolStaffing.isInterestArea(area)) return;
  const current=new Set(careerSelectedInterests());
  if(current.has(area)) current.delete(area);
  else current.add(area);
  setCareerInterests([...current]);
}
function careerInterestCountMap(filters){
  // under-current-filter: apply eligibility/window/format/etc, not the interest selection.
  if(!careerData) return new Map();
  const today=careerToday();
  const baseFilters={
    ...filters,
    interest:"all",
    interests:[],
  };
  const pool=CrolStaffing.filterExams(careerExamsForActiveScope(careerData.exams),baseFilters,today);
  const counts=new Map();
  for(const exam of pool){
    for(const area of CrolStaffing.examInterestAreas(exam)){
      counts.set(area,(counts.get(area)||0)+1);
    }
  }
  return counts;
}
function careerFacetLinkHTML(facet,value,filters,sourceValue="",{count=null}={}){
  const label=careerFacetLabel(facet,value);
  if(facet==="eligibility"){
    return filterChip({
      label,
      pressed:filters.eligibility===value,
      className:"career-facet-chip",
      attributes:{"data-career-eligibility":value},
      escape:escUiHtml,
    });
  }
  if(facet==="interest"){
    const selected=CrolStaffing.normalizeInterestSelection(filters.interests ?? filters.interest);
    const pressed=value==="all" ? selected.length===0 : selected.includes(value);
    let nextSelection;
    if(value==="all") nextSelection=[];
    else {
      const set=new Set(selected);
      if(set.has(value)) set.delete(value);
      else set.add(value);
      nextSelection=[...set];
    }
    const href=examFacetHref({...filters,interests:nextSelection,interest:CrolStaffing.serializeInterestSelection(nextSelection)||"all"},"interest",nextSelection,{language:window.LANG||"en"});
    if(!href) return "";
    const edge=["people","interest",value].join(":");
    // Multi-select toggles: aria-pressed (shared filterChip grammar) announces
    // selected/unselected; each chip is independently removable via selected strip.
    return filterChip({
      label,
      count,
      pressed,
      className: ["career-facet-chip","career-interest-chip",pressed?"current":""].filter(Boolean).join(" "),
      attributes: {
        "data-career-facet": edge,
        "data-career-interest": value,
        "data-scope-edge": edge,
        "data-filter-href": href,
        ...(sourceValue ? { "data-source-value": sourceValue } : {}),
      },
      escape: escUiHtml,
    });
  }
  const href=examFacetHref(filters,facet,value,{language:window.LANG||"en"});
  if(!href) return "";
  const edge=["people",facet,value].join(":");
  const stateKey={eligibility:"eligibility",interest:"interest",window:"window",format:"format",salary:"salary_band",fee:"fee_level",experience:"no_experience"}[facet];
  const current=filters[stateKey]===value;
  return filterChip({
    label,
    pressed: current,
    className: `career-facet-chip${current ? " current" : ""}`,
    attributes: {
      "data-career-facet": edge,
      "data-scope-edge": edge,
      "data-filter-href": href,
      ...(sourceValue ? { "data-source-value": sourceValue } : {}),
    },
    escape: escUiHtml,
  });
}
function careerFacetControlsHTML(){
  if(!careerData) return;
  const today=careerToday();
  const filters=careerFacetFilters();
  const interestCounts=careerInterestCountMap(filters);
  const specs=[
    ["eligibility","career-eligibility-facets"],
    ["interest","career-interest-facets"],
    ["window","career-window-facets"], ["format","career-format-facets"],
    ["salary","career-salary-band-facets"], ["fee","career-fee-level-facets"],
    ["experience","career-no-experience-facets"],
  ];
  for(const [facet,id] of specs){
    const box=$("#"+id);
    if(!box) continue;
    const values=facet==="interest"
      ? careerData.interest_areas.filter(area=>careerData.exams.some(exam=>CrolStaffing.examInterestAreas(exam).includes(area)))
      : examFacetOptionValues(careerData.exams,facet,{today,statusFor:CrolStaffing.statusFor});
    const fieldHost=box.closest(".career-facet-field") || box.closest(".career-primary-facet");
    if(fieldHost) fieldHost.hidden=values.length===0;
    if(!values.length){ box.innerHTML=""; continue; }
    const links=[careerFacetLinkHTML(facet,"all",filters,"",{
      count: facet==="interest" ? null : null,
    })];
    if(facet==="window") links.push(careerFacetLinkHTML(facet,"actionable",filters));
    for(const value of values){
      const count=facet==="interest" ? (interestCounts.get(value)||0) : null;
      links.push(careerFacetLinkHTML(facet,value,filters,"",{count: facet==="interest" ? count : null}));
    }
    box.innerHTML=links.filter(Boolean).join("");
    if(facet==="eligibility"){
      box.querySelectorAll("[data-career-eligibility]").forEach(button=>button.addEventListener("click",()=>{
        $("#career-eligibility").value=button.dataset.careerEligibility;
        careerSelected=null; careerIncrementalList?.reset(); syncExamsModeUI(); renderCareerGuide(); updateHash();
      }));
    }
    if(facet==="interest"){
      // Multi-select toggles via href navigation (installFilterChipNavigation) —
      // also handle in-page when SPA owns the route without a full reload.
      box.querySelectorAll("[data-career-interest]").forEach(button=>{
        button.addEventListener("click",(event)=>{
          // Prefer in-page toggle so multi-select survives without depending on
          // soft-nav; still keep data-filter-href for Copy link / share parity.
          event.preventDefault();
          event.stopImmediatePropagation();
          toggleCareerInterest(button.dataset.careerInterest);
          careerSelected=null; careerIncrementalList?.reset();
          syncExamsModeUI(); renderCareerGuide(); updateHash();
        },{capture:true});
      });
    }
  }
  installFilterChipNavigation(document);
}
function careerDiffLeadsHTML(exam, feeSalary){
  const view=CrolStaffing.examDifferentiatorView
    ? CrolStaffing.examDifferentiatorView(exam)
    : { exam_format:exam.exam_format, card_leads:exam.card_leads||[], no_experience_required:exam.no_experience_required };
  const chips=[];
  const seen=new Set();
  const push=(key,label,value=key)=>{
    if(!label || seen.has(key)) return;
    seen.add(key);
    const facet={exam_format:"format",fee:"fee",salary:"salary",no_experience_required:"experience",experience_required:"experience"}[key];
    const href=facet ? examFacetHref(careerFacetFilters(),facet,value,{language:window.LANG||"en"}) : "";
    const edge=facet ? ["people",facet,value].join(":") : "";
    chips.push(href
      ? filterChip({
        label,
        className: "career-diff-chip",
        attributes: { "data-diff": key, "data-scope-edge": edge, "data-filter-href": href, ...(key === "fee" && exam.fee != null ? { "data-source-value": exam.fee } : {}) },
        escape: escUiHtml,
      })
      : staticFact({ label, className: "career-diff-fact", escape: escUiHtml }));
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
    if(lead.key==="exam_format") push("exam_format", careerFormatLabel(lead.value || view.exam_format), view.exam_format);
    else if(lead.key==="fee" && (lead.value===0 || exam.fee===0)) push("fee", t("career_diff_no_fee"), "none");
    else if(lead.key==="fee_level" && lead.value==="none") push("fee", t("career_diff_no_fee"), "none");
    else if(lead.key==="salary_min" || lead.key==="salary_max"){
      // handled after loop as one salary chip
    } else if(lead.key==="no_experience_required") push("no_experience_required", t("career_diff_no_experience"), "yes");
    else if(lead.key==="experience_required") push("experience_required", t("career_diff_experience"), "no");
    else if(lead.key==="residency_required") push("residency_required", t("career_diff_residency"));
    else if(lead.key==="residency_not_required") push("residency_not_required", t("career_diff_no_residency"));
  }
  const min=feeSalary.salary_min ?? exam.salary_min;
  const max=feeSalary.salary_max ?? exam.salary_max;
  if(min != null){
    const amount=max != null && Number(max) > Number(min)
      ? t("career_diff_salary_range",{min:careerMoney(min),max:careerMoney(max)})
      : t("career_diff_salary",{amount:careerMoney(min)});
    push("salary", amount, exam.salary_band);
  }
  if(view.exam_format && !seen.has("exam_format")) push("exam_format", careerFormatLabel(view.exam_format), view.exam_format);

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
  box.innerHTML=`<span>${lead}</span>`;
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
function careerUtilizationHTML(exam){
  const summary=exam?.eligible_list_utilization;
  const slice=careerData?.eligible_list_utilization;
  if(!summary || summary.status !== "linked" || !slice) return "";
  const rows=(slice.records||[]).filter(row=>row.exam_number===String(exam.exam_number));
  if(!rows.length) return "";
  const count=(field)=>rows.reduce((total,row)=>total+Number(row.source_row?.[field]||0),0);
  const removalFields=["aac_cnt","aol_cnt","dce_cnt","dea_cnt","dlx_cnt","fra_cnt","frh_cnt","fri_cnt","frm_cnt","frp_cnt","ftr_cnt","nfp_cnt","nle_cnt","ova_cnt","rli_cnt","tin_cnt","unf_cnt"];
  const removed=rows.reduce((total,row)=>total+removalFields.reduce((sum,field)=>sum+Number(row.source_row?.[field]||0),0),0);
  const agencies=new Set(rows.map(row=>row.source_row?.agency_desc).filter(Boolean));
  const sourceName=t("career_utilization_source_name");
  return `<section class="career-utilization" data-evidence-group="eligible-list-utilization" aria-label="${escUiHtml(t("career_utilization_heading"))}">
    <h3 class="career-outcomes-heading">${t("career_utilization_heading")}</h3>
    <div class="career-outcomes-metrics">
      <div class="career-metric"><b>${fmtNumber(count("appt_cnt"))}</b><span>${t("career_utilization_appointed")}</span></div>
      <div class="career-metric"><b>${fmtNumber(removed)}</b><span>${t("career_utilization_removed")}</span></div>
      <div class="career-metric"><b>${fmtNumber(count("cns_cnt"))}</b><span>${t("career_utilization_not_selected")}</span></div>
      <div class="career-metric"><b>${fmtNumber(rows.length)}</b><span>${t("career_utilization_rows")}</span></div>
    </div>
    <p class="career-outcomes-note">${t("career_utilization_note",{
      agencies:fmtNumber(agencies.size),
      date:careerDate(summary.vintage),
      source:sourceName,
    })}</p>
  </section>`;
}
function careerCardHTML(exam){
  const status=CrolStaffing.statusFor(exam,careerToday());
  const openBand=CrolStaffing.openWindowBand(exam,careerToday());
  const titleFamily=CrolStaffing.titleCodeFamilyView
    ? CrolStaffing.titleCodeFamilyView(exam)
    : null;
  const selected=careerSelected===exam.exam_number;
  const countdown=careerCountdownText(exam,status);
  const feeSalary=CrolStaffing.examFeeSalaryView(exam);
  // Prefer a build-time OASys NOE deep link; otherwise label the browse landing honestly.
  const applyUrl=(window.CrolActions && CrolActions.examApplyUrl)
    ? CrolActions.examApplyUrl(exam)
    : (exam.official_application_url || CrolStaffing.OASY_APPLY_URL);
  const applyDeep=(window.CrolActions && typeof CrolActions.examApplyIsDeep==="function")
    ? CrolActions.examApplyIsDeep(applyUrl)
    : (exam.application_handoff_mode==="deep" || /\/noe\?examId=\d+/i.test(String(applyUrl||"")));
  const applyLabel=applyDeep?t("career_apply_oasys"):t("career_apply_oasys_browse");
  const noticeUrl=exam.notice_url || CrolStaffing.DCAS_OPEN_COMPETITIVE_URL;
  const noticeLabel=exam.notice_url?t("career_read_noe"):t("career_official_schedule");
  const examHref=new URL(CrolStaffing.examUrl(exam.exam_number)).pathname;
  const interaction=objectCardInteractionProjection({
    target:{href:examHref,label:exam.title},
    external_handoffs:[{href:noticeUrl,label:noticeLabel,kind:"official_source"}],
    kinetic_actions:status==="open"
      ? [{
        href:applyUrl,
        label:applyLabel,
        kind:"apply",
        context_ready:true,
        primary:true,
        attributes:{"data-oasys-handoff":applyDeep?"deep":"landing"},
      }]
      : [],
    canonicalOrigin:location.origin,
  });
  const notice=interaction.external_handoffs[0]
    ? officialSourceLink({...interaction.external_handoffs[0],className:["act","career-official-handoff"].join(" "),escape:escUiHtml,newTabLabel:t("ext_link_new_tab_sr")})
    : "";
  const titleLink=renderObjectCardTitle(interaction,{className:["ui-object-card-title","career-object-title"].join(" "),escape:escUiHtml});
  const copyLink=renderObjectCardCopy(interaction,{
    className:["ui-object-card-copy","act"].join(" "),
    label:t("copy_link_btn"),
    attributes:{"data-career-copy":exam.exam_number},
    escape:escUiHtml,
  });
  const actionRail=renderObjectCardActionRail(interaction,{
    heading:t("next_action_heading"),
    escape:escUiHtml,
    newTabLabel:t("ext_link_new_tab_sr"),
  });
  const gapClass=feeSalary.class || (feeSalary.kind==="not_published"?"not_published":"not_yet_ingested");
  const diffLeads=careerDiffLeadsHTML(exam, feeSalary);
  const feeText=careerMoney(feeSalary.fee ?? exam.fee, gapClass);
  const salaryText=careerSalaryHTML(feeSalary, exam, gapClass);
  const statusHref=examFacetHref(careerFacetFilters(),"window",status,{language:window.LANG||"en"});
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
      ${statusHref
        ? filterChip({
          label: careerStatusLabel(status),
          className: `career-status-chip ${careerStatusClass(status)}`,
          attributes: { "data-scope-edge": ["people", "window", status].join(":"), "data-filter-href": statusHref },
          escape: escUiHtml,
        })
        : staticFact({ label: careerStatusLabel(status), className: `career-status-fact ${careerStatusClass(status)}`, escape: escUiHtml })}
      ${openBand?`<span class="tag" data-open-window-band="${openBand}" lang="en" dir="ltr">${openBand}</span>`:""}
      ${exam.notice_url?`<span class="tag" data-noe-state="posted" lang="en" dir="ltr">NOE posted</span>`:""}
      ${exam.eligibility==="promotion"?`<span class="tag soon">${t("career_promotion_badge")}</span>`:""}
      <p class="career-deadline-primary">${careerWindowText(exam,status)}</p>
      ${countdown?`<span class="career-deadline-countdown">${countdown}</span>`:""}
    </div>
    <div class="career-card-head">
      <p class="career-card-title" lang="en" dir="ltr">${titleLink}</p>
      <span class="career-exam-number">${t("career_exam_number",{number:escUiHtml(exam.exam_number)})}</span>
    </div>
    ${titleFamily?`<p class="career-title-code-family" data-title-code-confidence="${escUiHtml(titleFamily.confidence)}" lang="en" dir="ltr"><span>${escUiHtml(titleFamily.label)}</span>${titleFamily.marker?` <span class="career-confidence-marker" data-confidence-marker="${escUiHtml(titleFamily.marker)}">inferred</span>`:""}: <code>${escUiHtml(titleFamily.code)}</code></p>`:""}
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
      return examProcessSpineHTML(spine, exam, phaseView)+careerOutcomeHTML(exam,{spineMounted:!!spine})+careerUtilizationHTML(exam);
    })():""}
    ${actionRail}
    <div class="actions">${copyLink}${notice}
      ${careerSelected===exam.exam_number?routeBackHTML("/browse/exams/",t("career_back_all"),"act"):""}
    </div>
  </article>`;
}
function careerInterestContextHTML(){
  const index=careerData?.interest_taxonomy;
  const selected=careerSelectedInterests();
  // Subscribe context only when exactly one interest is selected (single-area watch).
  if(!index || !Array.isArray(index.areas) || selected.length!==1) return "";
  const area=index.areas.find(item=>item.id===selected[0] && item.subscribable);
  if(!area) return "";
  const today=careerToday();
  const rows=careerData.exams.filter(exam=>CrolStaffing.examInterestAreas(exam).includes(area.id));
  const bands={far:0,approaching:0,imminent:0};
  rows.forEach(exam=>{ const band=CrolStaffing.openWindowBand(exam,today); if(band) bands[band]+=1; });
  const noe=rows.filter(exam=>exam.notice_url).length;
  const label=t(CAREER_AREA_KEYS[area.id]||"career_area_other");
  const chips=["far","approaching","imminent"].filter(band=>bands[band]>0)
    .map(band=>`<span class="tag" data-open-window-band="${band}" lang="en" dir="ltr">${band} ${bands[band]}</span>`);
  if(noe>0) chips.push(`<span class="tag" data-noe-state="posted" lang="en" dir="ltr">NOE posted ${noe}</span>`);
  return `<div class="career-interest-context" data-interest-context="${escUiHtml(area.id)}">
    <b>${escUiHtml(label)}</b>
    <div class="career-interest-context-meta">${chips.join("")}</div>
    <button class="act" type="button" data-follow-exam-area="${escUiHtml(area.id)}" data-follow-exam-label="${escUiHtml(label)}">${t("mini_subscribe_btn")}</button>
  </div>`;
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
  const interests=careerSelectedInterests();
  return {
    query:$("#career-query")?.value || "",
    eligibility:$("#career-eligibility").value,
    ...careerFacetState,
    interest: interests.length ? CrolStaffing.serializeInterestSelection(interests) : "all",
    interests,
  };
}
function careerRemovableChip(label, removeKey, removeValue){
  const safeLabel=escUiHtml(label);
  return `<button type="button" class="qchip qchip-remove" data-remove-filter="${escUiHtml(removeKey)}" data-remove-value="${escUiHtml(removeValue)}" aria-label="${escUiHtml(t("clear_filters_btn"))}: ${safeLabel}">${safeLabel} <span aria-hidden="true">×</span></button>`;
}
function updateStaffingMoreFiltersState(){
  const filters=careerFilters();
  const interests=careerSelectedInterests();
  // Badge counts only More-filters selections (interest + eligibility are primary rails).
  const active=[
    filters.window && filters.window!=="actionable",
    filters.salary_band && filters.salary_band!=="all",
    filters.fee_level && filters.fee_level!=="all",
    filters.no_experience && filters.no_experience!=="all",
    filters.format && filters.format!=="all",
  ].filter(Boolean).length;
  const badge=$("#staffing-filter-badge");
  if(badge){
    badge.hidden=active===0;
    badge.textContent=active?t("property_filters_active",{n:active}):"";
  }
  const strip=$("#staffing-active-filters");
  if(!strip) return;
  const chips=[];
  if(filters.query) chips.push(`<span class="qchip">${escUiHtml(filters.query)}</span>`);
  if(filters.format && filters.format!=="all") chips.push(careerRemovableChip(careerFacetLabel("format",filters.format),"format",filters.format));
  for(const area of interests){
    chips.push(careerRemovableChip(careerFacetLabel("interest",area),"interest",area));
  }
  if(filters.eligibility){
    chips.push(careerRemovableChip(careerFacetLabel("eligibility",filters.eligibility),"eligibility",filters.eligibility));
  }
  if(filters.window && filters.window!=="actionable") chips.push(careerRemovableChip(careerFacetLabel("window",filters.window),"window",filters.window));
  if(filters.salary_band && filters.salary_band!=="all") chips.push(careerRemovableChip(careerFacetLabel("salary",filters.salary_band),"salary_band",filters.salary_band));
  if(filters.fee_level && filters.fee_level!=="all") chips.push(careerRemovableChip(careerFacetLabel("fee",filters.fee_level),"fee_level",filters.fee_level));
  if(filters.no_experience && filters.no_experience!=="all") chips.push(careerRemovableChip(careerFacetLabel("experience",filters.no_experience),"no_experience",filters.no_experience));
  strip.innerHTML=chips.length
    ? `<div class="nlunderstood searchactive"><span role="status">${t("nl_understood_label")} ${chips.join(" ")}</span><button type="button" class="mini" data-staffing-clear-filters>${t("clear_filters_btn")}</button></div>`
    : "";
  strip.querySelectorAll("[data-remove-filter]").forEach((button)=>{
    button.addEventListener("click",()=>{
      const key=button.dataset.removeFilter;
      const value=button.dataset.removeValue;
      if(key==="interest"){
        setCareerInterests(careerSelectedInterests().filter((area)=>area!==value));
      }else if(key==="eligibility"){
        const eligibility=$("#career-eligibility");
        if(eligibility) eligibility.value="all";
      }else if(key==="window"){
        careerFacetState.window="actionable";
      }else if(key==="format"){
        careerFacetState.format="all";
      }else if(key==="salary_band"){
        careerFacetState.salary_band="all";
      }else if(key==="fee_level"){
        careerFacetState.fee_level="all";
      }else if(key==="no_experience"){
        careerFacetState.no_experience="all";
      }
      careerSelected=null;
      careerIncrementalList?.reset();
      renderCareerGuide();
      updateHash();
    });
  });
  strip.querySelector("[data-staffing-clear-filters]")?.addEventListener("click",()=>{
    const query=$("#career-query");
    if(query) query.value="";
    const eligibility=$("#career-eligibility");
    if(eligibility) eligibility.value="open_competitive";
    careerFacetState={
      interest:[],
      window:"actionable",
      format:"all",
      salary_band:"all",
      fee_level:"all",
      no_experience:"all",
    };
    careerSelected=null;
    careerIncrementalList?.reset();
    renderCareerGuide();
    updateHash();
  });
}
function ensureCareerIncrementalList(){
  if(careerIncrementalList) return careerIncrementalList;
  careerIncrementalList=createIncrementalList({
    container: $("#career-results"),
    initialPageSize: 16,
    pageSize: 24,
    getItems:()=>careerRenderItems,
    renderItems:shown=>careerSelected?shown.map(careerCardHTML).join(""):careerResultsHTML(shown),
    renderEmpty:()=>`<div class="career-empty">${careerSelected?t("career_exam_not_found"):t("career_no_results")}</div>`,
    renderMore:remaining=>t("career_show_more",{n:fmtNumber(remaining)}),
    moreId:"career-more",
    moreClass:"career-more",
  });
  return careerIncrementalList;
}
function careerExamsForActiveScope(baseExams){
  const exams=Array.isArray(baseExams)?baseExams:[];
  if(!examsAgencyScopeKey()) return exams;
  if(examsAgencyExamNumbers instanceof Set){
    return filterExamsByAgencyScope(exams, examsAgencyExamNumbers);
  }
  // Certification edges still loading — do not paint citywide exams under a scope.
  loadExamsAgencyScope(examsAgencyScopeKey()).then(()=>{
    if(careerData) renderCareerGuide();
    syncExamsModeUI();
  });
  return [];
}
function renderCareerGuide(){
  if(!careerData) return;
  const today=careerToday();
  const scopedPool=careerExamsForActiveScope(careerData.exams);
  const open=scopedPool.filter(exam=>exam.eligibility==="open_competitive"&&CrolStaffing.statusFor(exam,today)==="open").length;
  const upcoming=scopedPool.filter(exam=>exam.eligibility==="open_competitive"&&CrolStaffing.statusFor(exam,today)==="upcoming").length;
  $("#career-open-count").textContent=fmtNumber(open);
  $("#career-upcoming-count").textContent=fmtNumber(upcoming);
  careerSourceHTML();
  careerFacetControlsHTML();
  const interestContext=$("#career-interest-context");
  if(interestContext){
    interestContext.innerHTML=careerInterestContextHTML();
    interestContext.querySelectorAll("[data-follow-exam-area]").forEach(button=>button.addEventListener("click",async()=>{
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
    // Agency scope: only exams the publisher certified to that agency — never
    // the full citywide guide under a claimed agency facet.
    exams=CrolStaffing.filterExams(scopedPool,careerFilters(),today);
  }
  syncExamsModeUI();
  updateStaffingMoreFiltersState();
  const countEl=$("#career-result-count");
  if(countEl) countEl.textContent=exams.length?t("results_count",{n:fmtNumber(exams.length)}):"";
  careerRenderItems=exams;
  ensureCareerIncrementalList().render({items:exams});
}
function applyCareerRouteFilters(){
  if(!careerRouteFilters) return;
  const {
    interest, eligibility, window: windowFilter,
    format, salary_band: salaryBand, fee_level: feeLevel, no_experience: noExperience,
  } = careerRouteFilters;
  const eligibilityEl=$("#career-eligibility");
  if(eligibilityEl){
    if(eligibility && ["open_competitive","promotion","all"].includes(eligibility)) eligibilityEl.value=eligibility;
    else if(eligibility===null) eligibilityEl.value="open_competitive";
  }
  careerFacetState={
    interest:CrolStaffing.normalizeInterestSelection(interest),
    window:windowFilter && ["actionable","open","upcoming","closed","all"].includes(windowFilter) ? windowFilter : "actionable",
    format:format && ["education_experience","multiple_choice","physical","mixed","written","oral","practical","other","all"].includes(format) ? format : "all",
    salary_band:salaryBand && ["under_45k","45k_60k","60k_80k","80k_plus","all"].includes(salaryBand) ? salaryBand : "all",
    fee_level:feeLevel && ["none","low","fee-bearing","mid","high","all"].includes(feeLevel) ? feeLevel : "all",
    no_experience:noExperience && ["yes","no","all"].includes(noExperience) ? noExperience : "all",
  };
  careerRouteFilters=null;
}
function populateCareerInterests(){
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
  syncExamsModeUI();
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
  careerSelected=id; careerIncrementalList?.reset();
  setExamsAgencyScope("");
  showTab("exams");
  // Mount detail before fetching so a cold deep link never looks list-only.
  paintExamDetailShell(id);
  requestAnimationFrame(()=>{
    const shell=$("#career-exam-"+CSS.escape(id))||$("#career-guide");
    if(shell) shell.scrollIntoView({block:"start"});
  });
  loadCareerGuide().then(()=>{
    if(careerSelected!==id) return; // user navigated away
    renderCareerGuide();
    syncExamsModeUI();
    focusItemRouteTarget($("#career-exam-"+CSS.escape(id)));
    applyActiveHistoryRouteScroll();
  });
}
// Publish live bindings for routing, boot, and retained inline handlers.
globalThis.CAREER_AREA_KEYS = CAREER_AREA_KEYS;
globalThis.CAREER_HOW_SEEN_KEY = CAREER_HOW_SEEN_KEY;
globalThis.CAREER_INTEREST_COUNTS_BASIS = CAREER_INTEREST_COUNTS_BASIS;
globalThis.applyCareerRouteFilters = applyCareerRouteFilters;
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
globalThis.paintExamDetailShell = paintExamDetailShell;
globalThis.populateCareerInterests = populateCareerInterests;
globalThis.prepareCareerHow = prepareCareerHow;
globalThis.renderCareerGuide = renderCareerGuide;
globalThis.setExamsAgencyScope = setExamsAgencyScope;
globalThis.showExam = showExam;
globalThis.syncExamsModeUI = syncExamsModeUI;
Object.defineProperty(globalThis, "careerData", { configurable: true, get: () => careerData, set: value => { careerData = value; } });
Object.defineProperty(globalThis, "careerFacetState", { configurable: true, get: () => careerFacetState, set: value => { careerFacetState = value; } });
Object.defineProperty(globalThis, "careerHowPrepared", { configurable: true, get: () => careerHowPrepared, set: value => { careerHowPrepared = value; } });
Object.defineProperty(globalThis, "careerLimit", { configurable: true, get: () => careerIncrementalList?.limit ?? 16, set: value => { if(Number(value) === 16) careerIncrementalList?.reset(); } });
Object.defineProperty(globalThis, "careerLoadPromise", { configurable: true, get: () => careerLoadPromise, set: value => { careerLoadPromise = value; } });
Object.defineProperty(globalThis, "careerRouteFilters", { configurable: true, get: () => careerRouteFilters, set: value => { careerRouteFilters = value; } });
Object.defineProperty(globalThis, "careerSelected", { configurable: true, get: () => careerSelected, set: value => { careerSelected = value; } });
Object.defineProperty(globalThis, "examsAgencyScope", { configurable: true, get: () => examsAgencyScope, set: value => { setExamsAgencyScope(value); } });
Object.defineProperty(globalThis, "examPhaseSpineToolsPromise", { configurable: true, get: () => examPhaseSpineToolsPromise, set: value => { examPhaseSpineToolsPromise = value; } });
Object.defineProperty(globalThis, "examProcessSpineToolsPromise", { configurable: true, get: () => examProcessSpineToolsPromise, set: value => { examProcessSpineToolsPromise = value; } });
