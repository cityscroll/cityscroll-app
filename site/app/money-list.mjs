import { noticeDisplayTitle } from "../display_title.mjs";
import { resolveAgencyIdentity } from "../agency_identity.mjs";
import { scopedHistoryGap as hasScopedHistoryGap } from "../money_scope_consistency.mjs";
import { moneyClosingWeekHash, moneyLocationBasisHref } from "../money_scope_links.mjs";
import { listEntityMentionHTML } from "../list_entity_pivots.mjs";
import {
  installFilterChipNavigation,
  objectCardInteractionProjection,
  renderObjectCardActionRail,
  renderObjectCardPrimitives,
} from "../affordance_grammar.mjs";
import { solicitationResponseContextReady } from "../solicitation_response_context.mjs";
import {
  contractIdentityFromFacetValues,
  filterMoneySnapshot,
  moneyLineageRows,
  moneyMethodFacet,
  moneySnapshotRows,
  openContractSnapshotProjection,
  procurementStagesForRow,
  vendorStemsFromEntityRefs,
} from "../resident_snapshot_queries.mjs";
import { moneyEvaluationClockMs, moneyStaleSourceNoticeHTML } from "../money-freshness.mjs";
import {
  CONTRACTS_BROWSE_SCOPE,
  CONTRACT_SCOPED_RETRIEVAL_IDLE,
  contractScopedRetrievalOutcome,
  contractScopedRetrievalRequest,
  contractScopedRetrievalUnavailable,
  mergeCanonicalProcurementBrowseRows,
  mergeContractSearchRows,
} from "../contract_search_bridge.mjs";
import { renderProcurementRowCoverageHtml } from "../procurement_coverage_labels.mjs";
import {
  ANALYTICAL_PROJECTION_URL,
  CITY_RECORD_COVERAGE_DEFAULT_THRESHOLD,
  analyticalDrillThroughHref,
  cityRecordCoverage,
  filterAnalyticalContracts,
  formatRegisteredValue,
  groupCityRecordCoverage,
  groupAnalyticalContracts,
  populationSummary,
  vendorConcentration,
  registrationTimingSummary,
} from "../analytical_projection.mjs";
import { switchAnalyticalFact } from "../analytical_projection_contract.mjs";
import { analyzeContractsProjection } from "../contracts_analysis_projection.mjs";
import {
  PAYMENT_ANALYTICAL_PROJECTION_URL,
  filterAnalyticalPayments,
  groupAnalyticalPayments,
  paymentPopulationSummary,
  paymentRelatedContractDrillThroughHref,
  paymentTransactionDrillThroughHref,
} from "../analytical_payment_projection.mjs";
import {
  PERFORMANCE_EVIDENCE_ANALYTICAL_PROJECTION_URL,
  PERFORMANCE_EVIDENCE_STATES,
  filterPerformanceEvidenceCoverage,
  groupPerformanceEvidenceCoverage,
  performanceEvidenceCoverageSummary,
  performanceEvidenceDrillThroughHref,
} from "../analytical_performance_evidence.mjs";
import { buildContractReportTarget, renderReportIssueAffordance } from "../report_issue.mjs";
import { PROCUREMENT_PROCESS_STATE_LABELS } from "../procurement_process_state_vocabulary.mjs";

const MONEY_DEFAULT_SNAPSHOT_URL="data/money_default_open.json";
const MONEY_AGENCIES_SNAPSHOT_URL="data/money_procurement_agencies.json";
const MONEY_RESIDENT_SNAPSHOT_URL="data/money_resident_snapshot.json";
const MONEY_PROCUREMENT_SNAPSHOT_URL="data/procurement_browse_rows.json";
const MONEY_PROCUREMENT_QUERY_URL="data/procurement_browse_query.json";
const PIN_FAMILY_REVIEW_URL="data/pin_family_mismatch_review.json";
let moneyDefaultSnapshotPromise=null,moneyAgenciesSnapshotPromise=null,moneyResidentSnapshotPromise=null,moneyActionLocationToolsPromise=null,moneyPinSiblingPromise=null,pinFamilyReviewPromise=null;
let analyticalProjectionPromise=null;
let analyticalDroppedFilters=[];
const contractSearchDocumentPromises=new Map();
let moneyLocationFilter={layer:"",basis:"",borough:"",communityDistrict:"",councilDistrict:""};
function moneyActionLocationTools(){
  return moneyActionLocationToolsPromise||=import("../money_action_location_ui.mjs").then(module=>(globalThis.MoneyActionLocations=module)).catch(()=>null);
}
function currentMoneyRouteScope(){
  const hash = location.hash.startsWith("#money")
    ? location.hash
    : `/browse/contracts/`.startsWith(location.pathname)
      ? `#money${location.search}`
      : "#money";
  return CrolScope.scopeFromRouteHash(hash, { language: window.LANG || "en" });
}
function moneyModeHref(modeKey, scope){
  const next = CrolScope.normalizeScope(scope);
  next.facets.values = { ...next.facets.values, mode: modeKey };
  const rawHash = CrolScope.routeHashFromScope(next, { surface: "money" });
  const query = new URLSearchParams(rawHash.split("?", 2)[1] || "");
  const explicit = new URLSearchParams();
  explicit.set("mode", modeKey);
  for (const [key, value] of query) {
    if (key !== "mode") explicit.append(key, value);
  }
  return `/browse/contracts/?${explicit.toString()}`;
}
function setClosingWeekState(active){
  const link = document.getElementById("closingweek");
  if(!link) return;
  link.classList.toggle("on", !!active);
  link.setAttribute("aria-pressed", String(!!active));
}
function syncProcurementFacetRails(){
  const activeMode = String($("#mode")?.value || "open");
  const scope = currentMoneyRouteScope();
  const modeRail = document.getElementById(["money", "mode", "rail"].join("-"));
  modeRail?.querySelectorAll(".ui-filter-chip").forEach((link) => {
    const modeKey = link.dataset.moneyMode;
    if (!modeKey) return;
    link.dataset.filterHref = moneyModeHref(modeKey, scope);
    const active = modeKey === activeMode;
    link.classList.toggle("on", active);
    link.setAttribute("aria-pressed", String(active));
  });
  const activeBasis = ["", "contract_action_address"].includes(moneyLocationFilter.layer)
    ? (moneyLocationFilter.basis || "contract_action_address")
    : "";
  const locationRail = document.getElementById(["money", "location", "rail"].join("-"));
  locationRail?.querySelectorAll(".ui-filter-chip").forEach((link) => {
    const basis = link.dataset.moneyLocationBasis;
    if (!basis) return;
    link.dataset.filterHref = moneyLocationBasisHref(scope, basis);
    const active = basis === activeBasis;
    link.classList.toggle("on", active);
    link.setAttribute("aria-pressed", String(active));
  });
  const closing = document.getElementById("closingweek");
  if(closing){
    closing.dataset.filterHref = moneyClosingWeekHash(scope, !closingWeek);
    setClosingWeekState(closingWeek);
  }
  installFilterChipNavigation(document);
  syncMoneyDiscoveryCopy();
}
function moneyIntroKey(modeKey){
  if(modeKey==="award") return "money_intro_award";
  if(modeKey==="allrfp") return "money_intro_allrfp";
  if(modeKey==="archive") return "money_intro_archive";
  return "money_intro_open";
}
function syncMoneyDiscoveryCopy(){
  const modeKey=String($("#mode")?.value||"open");
  const deck=document.getElementById("money-intro-deck");
  if(deck) deck.textContent=t(moneyIntroKey(modeKey));
  const signpost=document.getElementById("money-awards-signpost");
  if(signpost) signpost.hidden=modeKey==="award";
}
async function initializeMoneyLocationFilters(){
  const tools=await moneyActionLocationTools();
  return tools?.initializeMoneyLocationFilters?.({t, scope: currentMoneyRouteScope()});
}
function loadMoneyDefaultSnapshot(){
  if(!moneyDefaultSnapshotPromise){
    moneyDefaultSnapshotPromise=fetch(MONEY_DEFAULT_SNAPSHOT_URL)
      .then(r=>r.ok?r.json():null)
      .catch(()=>null);
  }
  return moneyDefaultSnapshotPromise;
}
function loadMoneyAgenciesSnapshot(){
  if(!moneyAgenciesSnapshotPromise){
    moneyAgenciesSnapshotPromise=fetch(MONEY_AGENCIES_SNAPSHOT_URL)
      .then(r=>r.ok?r.json():null)
      .catch(()=>null);
  }
  return moneyAgenciesSnapshotPromise;
}
function loadMoneyResidentSnapshot(){
  if(!moneyResidentSnapshotPromise){
    moneyResidentSnapshotPromise=fetch(MONEY_RESIDENT_SNAPSHOT_URL)
      .then(r=>r.ok?r.json():Promise.reject(new Error("snapshot-unavailable")));
  }
  return moneyResidentSnapshotPromise;
}
function loadMoneyProcurementSnapshot(options={}, baseRows=[]){
  return import("../procurement_browse_query.mjs").then(({loadProcurementBrowseQuery}) => loadProcurementBrowseQuery({
    manifestUrl:MONEY_PROCUREMENT_QUERY_URL,
    legacyUrl:MONEY_PROCUREMENT_SNAPSHOT_URL,
    options:{...options,baseRows},
  }));
}
function loadAnalyticalProjection(){
  if(!analyticalProjectionPromise){
    analyticalProjectionPromise=Promise.all([
      fetch(ANALYTICAL_PROJECTION_URL).then(r=>r.ok?r.json():null),
      fetch(PAYMENT_ANALYTICAL_PROJECTION_URL).then(r=>r.ok?r.json():null),
      fetch(PERFORMANCE_EVIDENCE_ANALYTICAL_PROJECTION_URL).then(r=>r.ok?r.json():null),
    ]).then(([registered_contract, payment, performance_evidence])=>{
      if(registered_contract && performance_evidence) {
        const byContract=new Map((performance_evidence.rows||[]).map(row=>[row.prime_contract_id,row]));
        registered_contract={
          ...registered_contract,
          rows:(registered_contract.rows||[]).map(row=>{
            const evidence=byContract.get(row.prime_contract_id);
            return {
              ...row,
              performance_evidence_state:evidence?.evidence_state||PERFORMANCE_EVIDENCE_STATES.NONE,
              performance_evidence_items:evidence?.evidence_items||[],
            };
          }),
        };
      }
      return {registered_contract, payment, performance_evidence};
    }).catch(()=>null);
  }
  return analyticalProjectionPromise;
}
async function residentMoneyRows(){
  return moneySnapshotRows(await loadMoneyResidentSnapshot());
}
// Contracts Browse is a scoped form factor of the federated capability: keyword
// candidates come from the registered Contracts scope, and the retained local
// snapshot is the disclosed fallback rather than the primary keyword index.
// The retrieval receipt is returned whole so a provider failure can never be
// painted as "no contracts matched".
async function loadContractScopedRetrieval(query, identity=null){
  const request=contractScopedRetrievalRequest({query,identity});
  if(!request) return CONTRACT_SCOPED_RETRIEVAL_IDLE;
  if(!contractSearchDocumentPromises.has(request.path)){
    contractSearchDocumentPromises.set(request.path,workerFetch(request.path,null,SLOW_MS)
      .then(async response=>{
        if(!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload=await response.json();
        if(!payload||!Array.isArray(payload.results)) throw new Error("scoped-search-response-invalid");
        return contractScopedRetrievalOutcome(payload,request);
      })
      .catch(error=>contractScopedRetrievalUnavailable(request,error?.message)));
  }
  return contractSearchDocumentPromises.get(request.path);
}
function isDefaultMoneySearchState({mode, agency, kw, methodSel, closingWeek, minAmount, sort, nlResolved}={}){
  const nl=nlResolved&&typeof nlResolved==="object"?nlResolved:{};
  const hasNl=Boolean(nl.category)||nl.maxAmount!=null||nl.months!=null||Boolean(nl.excludeSpecial);
  return (mode||"open")==="open"
    && !agency
    && !String(kw||"").trim()
    && !methodSel
    && !closingWeek
    && !minAmount
    && !hasNl
    && (!sort || sort==="deadline");
}
function paintMoneyAgencyOptions(names){
  const cur=$("#agency")?$("#agency").value:"";
  const list=(names||[]).filter(Boolean);
  $("#agency").innerHTML=`<option value="">${t("all_agencies")}</option>`+list.map(name=>`<option>${name}</option>`).join("");
  if(cur) forceSelect("#agency", cur);
}
async function loadAgencies(){
  try{
    const snap=await loadMoneyAgenciesSnapshot();
    const names=snap&&Array.isArray(snap.agencies)?snap.agencies:[];
    paintMoneyAgencyOptions(names);
  }catch(e){
    $("#agency").innerHTML = `<option value="">${t("all_agencies")}</option>`;
  }
}

let currentRows = [], currentMoneyLineageRows = [], mode = "open", selectedRFP = null, closingWeek = false, moneyLoaded = false, methodSel = "";
let currentMoneyNarrowed = false;
let forceFullHistorySearch = false;
let moneyNlResolved = {};
// Set only for the default open-contracts search; every other mode/filter
// leaves this null so its "nothing found" reading is unaffected.
let currentMoneyFreshness = null;
// determinism-lint: allow clock the closing-this-week bound is relative to now by definition; it filters the list rather than being shown.
const weekOutISO = () => new Date(Date.now()+7*86400000).toISOString().slice(0,10) + "T23:59:59";
function moneyActiveFilterChip(item){
  const value = item.value;
  if(item.kind==="noticeType"){
    const label = value==="award" ? t("nl_filter_award") : value==="allrfp" ? t("head_allrfp") : value==="archive" ? t("head_archive") : t("nl_filter_open_rfp");
    return `<span class="qchip">${t("nl_filter_notice_label")} <b>${label}</b></span>`;
  }
  if(item.kind==="agency") return `<span class="qchip">${t("agency_label")} <b>${enTitle(value)}</b></span>`;
  if(item.kind==="keywords") return `<span class="qchip">${t("nl_filter_about_label")} <b>${enTitle(value.join(" / "))}</b></span>`;
  if(item.kind==="category") return `<span class="qchip">${t("nl_filter_category_label")} <b>${enTitle(value.replace(/\//g,"-"))}</b></span>`;
  if(item.kind==="minAmount") return `<span class="qchip">${t("nl_filter_min_label")} <b>${money(value)}</b></span>`;
  if(item.kind==="maxAmount") return `<span class="qchip">${t("nl_filter_max_label")} <b>${money(value)}</b></span>`;
  if(item.kind==="months") return `<span class="qchip">${t("nl_filter_months",{n:value})}</span>`;
  if(item.kind==="processState") return `<span class="qchip">${t("nl_filter_process_state_label")} <b>${escUiHtml(PROCUREMENT_PROCESS_STATE_LABELS[value] || value)}</b></span>`;
  return `<span class="qchip"><b>${t("nl_filter_standard_only")}</b></span>`;
}
function routeScopeFacetChip(){
  const values=globalThis.CROL_ACTIVE_SCOPE_FACET_VALUES||{};
  const refs=Array.isArray(values.entity_refs_all)?values.entity_refs_all.filter(Boolean):[];
  const relation=String(values.connection_relation||"");
  if(!refs.length && !relation) return "";
  const ref=String(refs[0]||"");
  const agencyId=ref.match(/^agency:(?:id:)?(.+)$/)?.[1]||"";
  const agency=agencyId?resolveAgencyIdentity(agencyId).canonical_name:"";
  const relationLabel=relation==="published_by_agency"?t("scope_relation_published_by"):t("scope_relation_connection");
  const label=agency?`${relationLabel} ${agency}`:relationLabel;
  const raw=escUiHtml(JSON.stringify(values));
  return `<span class="qchip active-scope-chip" data-active-scope-chip="true" data-scope-facet="${raw}">scope <b>${escUiHtml(label)}</b></span>`;
}
function renderMoneyActiveFilters(){
  const box=$("#moneyactivefilters"); if(!box) return;
  const filter={
    noticeType:mode==="award"?"award":mode==="allrfp"?"allrfp":mode==="archive"?"archive":"solicitation",
    agency:$("#agency").value,
    keywords:$("#kw").value.trim(),
    minAmount:$("#minamt").value,
    ...moneyNlResolved,
  };
  const items=moneyActiveFilterItems({
    noticeType:filter.noticeType, agency:filter.agency, keywords:filter.keywords,
    minAmount:filter.minAmount, ...moneyNlResolved,
  });
  box.innerHTML=interpretedSearchRowHTML("money", filter, items.map(moneyActiveFilterChip));
  const scopeChip=routeScopeFacetChip();
  if(scopeChip) box.insertAdjacentHTML("beforeend",`<div class="active-scope-state" role="status">${scopeChip}</div>`);
  const locationSummary=globalThis.MoneyActionLocations?.moneyLocationFilterSummaryHTML?.(moneyLocationFilter,{t,esc:escUiHtml});
  if(locationSummary) box.insertAdjacentHTML("beforeend",locationSummary);
  bindClearSearchState("money", box);
}
function updateMoneyMoreFiltersState(){
  const nl=moneyNlResolved&&typeof moneyNlResolved==="object"?moneyNlResolved:{};
  const active=[
    !!$("#agency").value,
    mode==="award"&&!!$("#minamt").value,
    closingWeek,
    !!nl.category,
    nl.maxAmount!=null,
    nl.months!=null,
    !!nl.excludeSpecial,
    !!nl.processState,
    !!moneyLocationFilter.borough,
    !!moneyLocationFilter.communityDistrict,
    !!moneyLocationFilter.councilDistrict,
  ].filter(Boolean).length;
  const badge=$("#money-filter-badge");
  if(!badge) return;
  badge.hidden=active===0;
  badge.textContent=active?t("property_filters_active",{n:active}):"";
}
function hasScopedMoneyReceipt(){
  const values = globalThis.CROL_ACTIVE_SCOPE_FACET_VALUES || {};
  const receipt = globalThis.CROL_SCOPE_RESULT_COUNT_RECEIPT;
  return (receipt != null && receipt !== ""
    && Number.isInteger(Number(receipt)) && Number(receipt) >= 0)
    || (Array.isArray(values.entity_refs_all) && values.entity_refs_all.length > 0);
}
function scopedHistoryGap(rows){
  return hasScopedHistoryGap({
    observed: (rows || []).length,
    receipt: globalThis.CROL_SCOPE_RESULT_COUNT_RECEIPT,
    scoped: hasScopedMoneyReceipt(),
  });
}
// Contracts Browse renders scoped coverage in the same vocabulary the search
// front door uses, so a resident reading "Vendors results temporarily
// unavailable" on either surface is reading the same claim about the same lens.
const MONEY_SCOPE_RECEIPT_CLASS = "contracts-scope-receipt";
const MONEY_STATUS_ROLE = "status";
const CONTRACT_SCOPE_LENS_NOTE_KEYS = Object.freeze({
  provider_unavailable: "topic_search_coverage_provider_unavailable",
  stale: "topic_search_coverage_stale",
  not_indexed: "topic_search_coverage_not_indexed",
});
function contractScopeLensLabel(lens){
  return t(`topic_search_coverage_lens_${lens}`);
}
function contractScopeReceiptHTML(retrieval){
  if(!retrieval || retrieval.outcome==="idle") return "";
  const lensCoverage=Array.isArray(retrieval.lens_coverage)?retrieval.lens_coverage:[];
  const requested=Array.isArray(retrieval.requested_lenses)?retrieval.requested_lenses:[];
  const parts=[];
  if(retrieval.outcome==="unavailable"){
    const failedLenses=lensCoverage.filter(row=>row.state==="provider_unavailable").map(row=>row.lens);
    const named=(failedLenses.length?failedLenses:requested).map(contractScopeLensLabel).filter(Boolean);
    // Say the source could not be reached and that what follows is the retained
    // snapshot. An unreachable provider is not a city that awarded no contracts.
    parts.push(`<p data-scope-note="provider_unavailable">${escUiHtml(t("now_source_unavailable",{
      sources:named.length?named.join(", "):CONTRACTS_BROWSE_SCOPE.source,
    }))}</p>`);
  }else{
    for(const row of lensCoverage){
      const key=CONTRACT_SCOPE_LENS_NOTE_KEYS[row.state];
      if(!key) continue;
      parts.push(`<p data-coverage-lens="${escUiHtml(row.lens)}" data-coverage-state="${escUiHtml(row.state)}">${escUiHtml(t(key,{source:contractScopeLensLabel(row.lens)}))}</p>`);
    }
  }
  if(retrieval.as_of) parts.push(`<p data-scope-as-of="${escUiHtml(retrieval.as_of)}">${escUiHtml(t("stats_public_asof",{date:retrieval.as_of}))}</p>`);
  // The receipt is always emitted so the scoped provenance of a rendered result
  // set is inspectable, and carries resident copy only when there is something a
  // resident needs told — the same rule the search front door's coverage uses.
  const receiptData=[
    ["data-contracts-scope-receipt","1"],
    ["data-scope-outcome",retrieval.outcome],
    ["data-scope-match-mode",retrieval.match_mode||""],
    ["data-scope-capability",retrieval.capability_reference||""],
    ["data-scope-lenses",requested.join(",")],
    ["data-scope-coverage-state",retrieval.coverage_state||""],
    ["data-scope-coverage-reported",retrieval.coverage_reported?"1":"0"],
    ["data-scope-query",retrieval.query||""],
    ["data-scope-candidates",String(retrieval.candidate_count??0)],
    ["data-scope-bound",String(retrieval.result_bound??"")],
    ["data-scope-fallback",retrieval.outcome==="unavailable"?"local_snapshot":""],
  ].map(([name,value])=>`${name}="${escUiHtml(value)}"`).join(" ");
  const receiptClass=`note ${retrieval.outcome==="unavailable"?"warn ":""}${MONEY_SCOPE_RECEIPT_CLASS}`;
  return `<div class="${receiptClass}" role="${MONEY_STATUS_ROLE}" ${receiptData}${parts.length?"":" hidden"}>${parts.join("")}</div>`;
}
function scopedHistoryNoteHTML(count, observed = 0, narrowed = false){
  const key = !narrowed
    ? "scoped_history_gap_note"
    : observed > 0 ? "narrowed_scope_partial_note" : "narrowed_scope_note";
  return `<div class="note warn scoped-history-note" role="status">${t(key, {
    n: Number(count).toLocaleString(), shown: Number(observed).toLocaleString(),
    older: Number(count - observed).toLocaleString(), date: recentCutLabel(),
  })}</div>`;
}
function bindFullHistorySearch(){
  document.querySelectorAll("[data-money-full-history]").forEach((button) => {
    button.addEventListener("click", () => {
      forceFullHistorySearch = true;
      search();
    }, { once: true });
  });
}

function analyticalUrlFilters(){
  const params=new URLSearchParams(location.search);
  return {
    fact: params.get("ap_fact") || null,
    payment_view: params.get("ap_payment_view") || null,
    agency: params.get("ap_agency") || null,
    prime_vendor: params.get("ap_vendor") || null,
    fiscal_year: params.get("ap_fy") || null,
    registration_fiscal_year: params.get("ap_fy") || null,
    contract_amount_band: params.get("ap_amount_band") || null,
    min_amount: params.get("ap_min") || null,
    max_amount: params.get("ap_max") || null,
    retroactive: params.get("retroactive") || null,
    city_record_match: params.get("ap_city_record_match") || null,
    performance_evidence_state: params.get("ap_evidence_state") || null,
    contract_id: params.get("ap_contract_id") || null,
  };
}

function analyticalControlsFilters(){
  return {
    registration_fiscal_year: $("#analytics-fy")?.value || null,
    min_amount: $("#analytics-min")?.value || null,
    max_amount: $("#analytics-max")?.value || null,
  };
}

function syncAnalyticalFiscalYears(rows, fact="registered_contract"){
  const select=$("#analytics-fy");
  if(!select) return;
  const current=select.value;
  const field=fact === "payment" ? "fiscal_year" : "registration_fiscal_year";
  const years=[...new Set((rows||[]).map(row=>row[field]).filter(Number.isInteger))].sort((a,b)=>b-a);
  select.innerHTML=`<option value="" data-i18n="analytics_all_years">${t("analytics_all_years")}</option>`+years.map(year=>`<option value="${year}">FY${year}</option>`).join("");
  if(years.includes(Number(current))) select.value=current;
}

function analyticalMoneyRow(row){
  return {
    id: row.prime_contract_id,
    short_title: t("analytics_contract_title",{id:row.prime_contract_id}),
    agency_name: row.agency,
    vendor_name: row.prime_vendor,
    contract_id: row.prime_contract_id,
    pin: row.pin || null,
    contract_amount: row.current_registered_amount,
    start_date: row.start_date,
    registration_date: row.registration_date,
    type_of_notice_description: t("analytics_registered_contract_type"),
    procurement_stages: ["registered"],
    primary_stage: "registered",
    source_system: "analytics_registered_contracts",
    analytics_projection: true,
    performance_evidence_state: row.performance_evidence_state || PERFORMANCE_EVIDENCE_STATES.NONE,
  };
}

function analyticalPaymentMoneyRow(row){
  const label = [row?.agency, row?.payee_name, row?.fiscal_year ? `FY${row.fiscal_year}` : ""].filter(Boolean).join(" · ");
  return {
    id: `payment:${label}`,
    short_title: `${t("analytics_payment_activity_title")}: ${label || t("analytics_unknown_scope")}`,
    agency_name: row?.agency,
    vendor_name: row?.payee_name,
    contract_id: row?.contract_id || (row?.contract_ids?.length === 1 ? row.contract_ids[0] : null),
    contract_ids: Array.isArray(row?.contract_ids) ? row.contract_ids : [],
    contract_amount: row?.actual_payment_amount,
    start_date: null,
    registration_date: null,
    type_of_notice_description: t("analytics_payment_type"),
    procurement_stages: ["payment"],
    primary_stage: "payment",
    source_system: "checkbook_payment_population",
    analytics_projection: true,
    payment_transaction_count: row?.transaction_count || 0,
    actual_payment_amount: row?.actual_payment_amount || 0,
  };
}

function analyticalCoverageControls() {
  return {
    threshold: Number($("#analytics-coverage-threshold")?.value || CITY_RECORD_COVERAGE_DEFAULT_THRESHOLD),
    contract_amount_band: $("#analytics-coverage-band")?.value || null,
  };
}

function coveragePercent(value) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function coverageBucketLabel(bucket) {
  return bucket === "exact" ? t("analytics_coverage_exact")
    : bucket === "none" ? t("analytics_coverage_none")
      : t("analytics_coverage_missing_pin");
}

function coverageCell(stat, valueKey) {
  const count = stat?.contract_count || 0;
  const value = stat?.registered_value || 0;
  return `${count.toLocaleString("en-US")} · ${formatRegisteredValue(value)}`;
}

function openCoverageDestination(panel) {
  if (!panel || panel.tagName !== "DETAILS") return;
  if (location.hash === "#contracts-analytics-coverage") panel.open = true;
}

function renderAnalyticalCoverage(projectionRows, filters) {
  const panel = $("#contracts-analytics-coverage");
  openCoverageDestination(panel);
  const controls = analyticalCoverageControls();
  const coverageFilters = {
    min_amount: controls.threshold,
    registration_fiscal_year: filters.registration_fiscal_year,
    contract_amount_band: controls.contract_amount_band,
    agency: filters.agency,
  };
  const coverage = cityRecordCoverage(projectionRows, coverageFilters);
  const grouped = groupCityRecordCoverage(projectionRows, { groupBy: "agency", ...coverageFilters });
  const summary = $("#contracts-analytics-coverage-summary");
  const statement = $("#contracts-analytics-coverage-statement");
  const table = $("#contracts-analytics-coverage-groups");
  const tableWrap = table?.closest(".table-scroll");
  const note = $("#contracts-analytics-coverage-note");
  if (!coverage.eligible_contract_count) {
    if (summary) summary.innerHTML = "";
    if (statement) statement.textContent = t("analytics_coverage_empty");
    if (table) table.innerHTML = "";
    if (tableWrap) tableWrap.hidden = true;
    if (note) note.textContent = "";
    return;
  }
  if (tableWrap) tableWrap.hidden = false;
  if (summary) {
    summary.innerHTML = [
      ["analytics_coverage_eligible", coverage.eligible_contract_count, coverage.eligible_registered_value],
      ["analytics_coverage_exact", coverage.matched_contract_count, coverage.matched_registered_value],
      ["analytics_coverage_none", coverage.unmatched_contract_count, coverage.unmatched_registered_value],
      ["analytics_coverage_missing_pin", coverage.missing_pin_contract_count, coverage.missing_pin_registered_value],
    ].map(([key, count, value]) => `<div class="contracts-analytics-coverage-stat"><dt>${escUiHtml(t(key))}</dt><dd>${Number(count).toLocaleString("en-US")}</dd><small>${escUiHtml(formatRegisteredValue(value))}</small></div>`).join("");
  }
  if (statement) {
    statement.textContent = `${t("analytics_coverage_statement", {
      matched: coverage.matched_contract_count.toLocaleString("en-US"),
      eligible: coverage.eligible_contract_count.toLocaleString("en-US"),
      rate: coveragePercent(coverage.match_rate),
      value: formatRegisteredValue(coverage.matched_registered_value),
      total: formatRegisteredValue(coverage.eligible_registered_value),
    })} ${t("analytics_coverage_missing_sentence", {
      count: coverage.missing_pin_contract_count.toLocaleString("en-US"),
      value: formatRegisteredValue(coverage.missing_pin_registered_value),
    })}`;
  }
  if (!table) return;
  table.innerHTML = grouped.groups.map((group) => {
    const link = (bucket) => analyticalDrillThroughHref({
      agency: group.label,
      registration_fiscal_year: filters.registration_fiscal_year,
      contract_amount_band: controls.contract_amount_band,
      min_amount: controls.threshold,
      city_record_match: bucket,
    });
    const exact = group.buckets.exact;
    const none = group.buckets.none;
    const missing = group.buckets.cannot_evaluate_missing_pin;
    return `<tr><th scope="row"><a href="${escUiHtml(analyticalDrillThroughHref({ agency: group.label, registration_fiscal_year: filters.registration_fiscal_year, contract_amount_band: controls.contract_amount_band, min_amount: controls.threshold }))}">${escUiHtml(group.label)}</a></th><td>${group.eligible_contract_count.toLocaleString("en-US")} · ${escUiHtml(formatRegisteredValue(group.eligible_registered_value))}</td><td><a href="${escUiHtml(link("exact"))}" aria-label="${escUiHtml(`${group.label}: ${coverageBucketLabel("exact")}`)}">${escUiHtml(coverageCell(exact))}</a></td><td><a href="${escUiHtml(link("none"))}" aria-label="${escUiHtml(`${group.label}: ${coverageBucketLabel("none")}`)}">${escUiHtml(coverageCell(none))}</a></td><td><a href="${escUiHtml(link("cannot_evaluate_missing_pin"))}" aria-label="${escUiHtml(`${group.label}: ${coverageBucketLabel("cannot_evaluate_missing_pin")}`)}">${escUiHtml(coverageCell(missing))}</a></td></tr>`;
  }).join("");
  if (note) note.textContent = t("analytics_coverage_note", {
    evaluable: coverage.evaluable_match_rate == null ? "—" : coveragePercent(coverage.evaluable_match_rate),
  });
}

function performanceEvidenceStateLabel(state) {
  return state === PERFORMANCE_EVIDENCE_STATES.TERMS ? t("analytics_evidence_terms")
    : state === PERFORMANCE_EVIDENCE_STATES.EVALUATION ? t("analytics_evidence_evaluation")
      : t("analytics_evidence_none");
}

function renderPerformanceEvidenceProjection(projectionRows, filters, performanceProjection) {
  const panel=$("#contracts-analytics-performance-evidence");
  if(!panel) return;
  panel.hidden=false;
  const filtered=filterPerformanceEvidenceCoverage(
    Array.isArray(performanceProjection?.rows) && performanceProjection.rows.length
      ? performanceProjection.rows
      : projectionRows,
    filters,
  );
  const summary=performanceEvidenceCoverageSummary(filtered);
  const summaryElement=$("#contracts-analytics-performance-evidence-summary");
  if(summaryElement){
    summaryElement.innerHTML=Object.values(PERFORMANCE_EVIDENCE_STATES).map((state)=>{
      const stat=summary.states[state];
      const href=performanceEvidenceDrillThroughHref({...filters,evidence_state:state});
      return `<div class="contracts-analytics-evidence-stat"><dt>${escUiHtml(performanceEvidenceStateLabel(state))}</dt><dd>${stat.contract_count.toLocaleString("en-US")}<small>${escUiHtml(formatRegisteredValue(stat.registered_value))} · <a href="${escUiHtml(href)}">${escUiHtml(t("analytics_evidence_view_contracts",{count:stat.contract_count.toLocaleString("en-US")}))}</a></small></dd></div>`;
    }).join("");
  }
  const statement=$("#contracts-analytics-performance-evidence-statement");
  if(statement){
    statement.textContent=t("analytics_evidence_statement",{
      total:summary.total_contract_count.toLocaleString("en-US"),
      located:summary.located_contract_count.toLocaleString("en-US"),
      unresolved:summary.unresolved_contract_count.toLocaleString("en-US"),
    });
  }
  const groupBy=$("#analytics-group")?.value||"agency";
  const grouped=groupPerformanceEvidenceCoverage(filtered,{groupBy});
  const table=$("#contracts-analytics-performance-evidence-groups");
  if(table){
    table.innerHTML=grouped.groups.map((group)=>{
      const groupFilters={...filters};
      if(groupBy==="agency") groupFilters.agency=group.label;
      if(groupBy==="vendor") groupFilters.prime_vendor=group.label;
      if(groupBy==="registration_fiscal_year") groupFilters.registration_fiscal_year=group.label;
      if(groupBy==="amount_band") groupFilters.contract_amount_band=group.label;
      const stateCells=Object.values(PERFORMANCE_EVIDENCE_STATES).map((state)=>{
        const stat=group.states[state]||{contract_count:0,registered_value:0};
        const href=performanceEvidenceDrillThroughHref({...groupFilters,evidence_state:state});
        return `<td><a href="${escUiHtml(href)}" aria-label="${escUiHtml(`${group.label}: ${performanceEvidenceStateLabel(state)}`)}">${stat.contract_count.toLocaleString("en-US")} · ${escUiHtml(formatRegisteredValue(stat.registered_value))}</a></td>`;
      }).join("");
      const allHref=performanceEvidenceDrillThroughHref(groupFilters);
      return `<tr><th scope="row"><a href="${escUiHtml(allHref)}">${escUiHtml(group.label)}</a></th><td>${group.contract_count.toLocaleString("en-US")} · ${escUiHtml(formatRegisteredValue(group.total_registered_value))}</td>${stateCells}</tr>`;
    }).join("");
  }
  const passages=$("#contracts-analytics-performance-evidence-passages");
  if(passages){
    const items=filtered.flatMap((row)=>(row.evidence_items||[]).map((item)=>({row,item})));
    passages.innerHTML=items.length
      ? items.slice(0,20).map(({row,item})=>`<li><a href="${escUiHtml(item.source_passage.url)}" target="_blank" rel="noopener">${escUiHtml(item.label)}</a><span> · ${escUiHtml(item.source_passage.locator)} · ${escUiHtml(row.prime_contract_id)}</span><blockquote>${escUiHtml(item.source_passage.excerpt)}</blockquote></li>`).join("")
      : `<li class="contracts-analytics-evidence-empty">${escUiHtml(t("analytics_evidence_no_passages"))}</li>`;
  }
}

function analyticalGroupLabel(groupBy){
  if(groupBy === "vendor") return t("analytics_group_vendor").toLowerCase();
  if(groupBy === "registration_fiscal_year" || groupBy === "fiscal_year") return t("analytics_group_fy").toLowerCase();
  if(groupBy === "amount_band") return t("analytics_group_amount_band").toLowerCase();
  return t("analytics_group_agency").toLowerCase();
}

function analyticalMeasureLabel(measure, fact="registered_contract"){
  if(fact === "payment") return measure === "transactions" ? t("analytics_payment_measure_transactions") : t("analytics_payment_measure_amount");
  return measure === "original" ? t("analytics_measure_original") : measure === "count" ? t("analytics_measure_count") : t("analytics_measure_current");
}

function formatAnalyticalShare(value){
  return `${(Number(value || 0) * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

function renderAnalyticalVendorConcentration(filtered, filters, measure, agency){
  const panel=$("#contracts-analytics-concentration");
  if(!panel) return;
  const scopedAgency=!!agency && !filters.prime_vendor;
  panel.hidden=!scopedAgency;
  if(!scopedAgency) return;
  const concentrationMeasure=measure === "original" ? "original" : "current";
  const concentration=vendorConcentration(filtered,{measure:concentrationMeasure,topN:10});
  const measureLabel=analyticalMeasureLabel(concentrationMeasure);
  const title=$("#contracts-analytics-concentration-heading");
  if(title) title.textContent=t("analytics_concentration_heading");
  const deck=$("#contracts-analytics-concentration-deck");
  if(deck) deck.textContent=t("analytics_concentration_deck",{agency,measure:measureLabel.toLowerCase()});
  const denominator=$("#contracts-analytics-concentration-denominator");
  if(denominator){
    const excluded=concentration.excluded_value_count
      ? ` ${t("analytics_concentration_excluded",{n:concentration.excluded_value_count.toLocaleString("en-US")})}`
      : "";
    denominator.textContent=t("analytics_concentration_denominator",{
      value:formatRegisteredValue(concentration.denominator),
      measure:measureLabel.toLowerCase(),
      count:concentration.denominator_value_count.toLocaleString("en-US"),
    })+excluded;
  }
  const summaries=$("#contracts-analytics-concentration-summaries");
  if(summaries) summaries.innerHTML=[
    ["analytics_top_5_share",concentration.top_5_share,concentration.top_5_value],
    ["analytics_top_10_share",concentration.top_10_share,concentration.top_10_value],
  ].map(([labelKey,share,value])=>`<div class="contracts-analytics-concentration-stat"><span>${escUiHtml(t(labelKey))}</span><strong>${formatAnalyticalShare(share)}</strong><small>${formatRegisteredValue(value)} ${escUiHtml(measureLabel.toLowerCase())}</small></div>`).join("");
  const list=$("#contracts-analytics-concentration-vendors");
  if(!list) return;
  list.innerHTML=concentration.vendors.map((vendor,index)=>{
    const vendorLabel=vendor.vendor_name
      ? listEntityMentionHTML({kind:"vendor",value:vendor.vendor_name,escape:escUiHtml,relation:"analytics_vendor"})
      : escUiHtml(vendor.label);
    const href=analyticalDrillThroughHref({
      agency,
      prime_vendor:vendor.vendor_name || vendor.label,
      registration_fiscal_year:filters.registration_fiscal_year,
      min_amount:filters.min_amount,
      max_amount:filters.max_amount,
    });
    const contractLabel=t("analytics_view_contracts",{count:vendor.contract_count.toLocaleString("en-US")});
    const rank=vendor.unclassified ? "—" : `${vendor.rank || index+1}.`;
    return `<li class="contracts-analytics-concentration-vendor" data-analytics-concentration-vendor="${escUiHtml(vendor.label)}"><div class="contracts-analytics-concentration-vendor-name"><span class="contracts-analytics-rank">${rank}</span>${vendorLabel}</div><div class="contracts-analytics-concentration-vendor-meta"><strong>${formatRegisteredValue(vendor.registered_value)}</strong> · ${formatAnalyticalShare(vendor.share)} · ${vendor.contract_count.toLocaleString("en-US")} ${escUiHtml(t("analytics_contracts_unit"))}</div><a class="contracts-analytics-concentration-contracts" href="${escUiHtml(href)}" data-analytics-concentration-contracts="${escUiHtml(vendor.label)}">${escUiHtml(contractLabel)}</a></li>`;
  }).join("");
  const note=$("#contracts-analytics-concentration-note");
  if(note) note.textContent=t("analytics_concentration_note",{
    measure:measureLabel.toLowerCase(),
    unclassified:formatRegisteredValue(concentration.unclassified_value),
    share:formatAnalyticalShare(concentration.unclassified_share),
  });
}

function analyticalGroupDimension(groupBy){
  return groupBy === "vendor" ? "prime_vendor"
    : groupBy === "registration_fiscal_year" ? "registration_fiscal_year"
      : groupBy === "amount_band" ? "contract_amount_band" : "agency";
}

function syncAnalyticalViewControls(view, fact="registered_contract"){
  const timing = view === "timing";
  const measureField = document.querySelector("#analytics-measure")?.closest(".field");
  if(measureField) measureField.hidden = timing;
  const group = $("#analytics-group");
  if(!group) return;
  const current = group.value;
  const options = fact === "payment"
    ? [["agency", t("analytics_group_agency")], ["vendor", t("analytics_group_vendor")], ["fiscal_year", t("analytics_payment_group_fy")]]
    : timing
      ? [["agency", t("analytics_group_agency")], ["registration_fiscal_year", t("analytics_group_fy")], ["amount_band", t("analytics_group_amount_band")]]
      : [["agency", t("analytics_group_agency")], ["vendor", t("analytics_group_vendor")], ["registration_fiscal_year", t("analytics_group_fy")], ["amount_band", t("analytics_group_amount_band")]];
  group.innerHTML = options.map(([value, label]) => `<option value="${value}">${escUiHtml(label)}</option>`).join("");
  group.value = options.some(([value]) => value === current) ? current : "agency";
  if(measureField && fact === "payment") measureField.hidden = false;
  const measure = $("#analytics-measure");
  if(measure && fact === "payment") {
    const selected = measure.value;
    measure.innerHTML = `<option value="amount">${escUiHtml(t("analytics_payment_measure_amount"))}</option><option value="transactions">${escUiHtml(t("analytics_payment_measure_transactions"))}</option>`;
    measure.value = ["amount", "transactions"].includes(selected) ? selected : "amount";
  } else if(measure && fact !== "payment") {
    const selected = measure.value;
    measure.innerHTML = `<option value="current">${escUiHtml(t("analytics_measure_current"))}</option><option value="original">${escUiHtml(t("analytics_measure_original"))}</option><option value="count">${escUiHtml(t("analytics_measure_count"))}</option>`;
    measure.value = ["current", "original", "count"].includes(selected) ? selected : "current";
  }
}

function formatLagDays(value){
  return value == null ? t("analytics_not_available") : `${Number(value).toLocaleString("en-US")} ${t("analytics_days")}`;
}

function timingMetricHTML(label, value, className=""){
  return `<div class="contracts-analytics-timing-metric ${className}"><strong>${escUiHtml(value)}</strong><span>${escUiHtml(label)}</span></div>`;
}

function renderRegistrationTimingSummary(summary, populationInfo){
  const eligible = summary.eligible_contract_count.toLocaleString("en-US");
  const retroactive = summary.retroactive_contract_count.toLocaleString("en-US");
  const rate = summary.retroactive_share == null ? t("analytics_not_available") : `${(summary.retroactive_share * 100).toFixed(1)}%`;
  const headline = summary.retroactive_share == null
    ? t("analytics_timing_no_rate", { eligible })
    : t("analytics_timing_headline", { rate, retroactive, eligible });
  const populationElement = $("#contracts-analytics-population");
  if(populationElement) populationElement.textContent = `${headline} · ${populationInfo.year_label}. ${t("analytics_population_suffix")} ${t("analytics_timing_missing", { missing: summary.missing_date_contract_count.toLocaleString("en-US"), total: summary.total_contract_count.toLocaleString("en-US"), share: summary.missing_date_share == null ? t("analytics_not_available") : `${(summary.missing_date_share * 100).toFixed(1)}%` })}`;
  const metrics = $("#contracts-analytics-timing");
  if(metrics) metrics.innerHTML = [
    timingMetricHTML(t("analytics_metric_eligible"), eligible),
    timingMetricHTML(t("analytics_metric_missing"), summary.missing_date_contract_count.toLocaleString("en-US")),
    timingMetricHTML(t("analytics_metric_retroactive"), retroactive),
    timingMetricHTML(t("analytics_metric_median"), formatLagDays(summary.median_lag_days)),
    timingMetricHTML(t("analytics_metric_p75"), formatLagDays(summary.p75_lag_days)),
    timingMetricHTML(t("analytics_metric_p90"), formatLagDays(summary.p90_lag_days)),
  ].join("");
  return headline;
}

function analyticalFilterLabel(key){
  return {
    contract_amount_band: t("analytics_group_amount_band"),
    min_amount: t("analytics_min_current"),
    max_amount: t("analytics_max_current"),
    retroactive: t("analytics_view_timing"),
    city_record_match: t("analytics_coverage_heading"),
    contract_id: t("analytics_related_contract"),
  }[key] || key;
}

function renderAnalyticalFactStatus(){
  const status=$("#contracts-analytics-fact-status");
  if(!status) return;
  status.textContent=analyticalDroppedFilters.length
    ? t("analytics_dropped_filters", { filters: analyticalDroppedFilters.map(analyticalFilterLabel).join(", ") })
    : "";
  status.hidden=!analyticalDroppedFilters.length;
}

function renderAnalyticalFactComparison(projection, filters){
  const panel=$("#contracts-analytics-fact-comparison");
  const cards=$("#contracts-analytics-fact-comparison-cards");
  if(!panel || !cards) return;
  const registered=projection?.registered_contract;
  const payments=projection?.payment;
  if(!registered || !payments) { panel.hidden=true; return; }
  const registeredRows=filterAnalyticalContracts(registered.rows || [], {
    agency:filters.agency, prime_vendor:filters.prime_vendor, fiscal_year:filters.fiscal_year,
  });
  const paymentRows=filterAnalyticalPayments(payments.rows || [], filters);
  const registeredSummary=populationSummary(registeredRows);
  const paymentSummary=paymentPopulationSummary(paymentRows, payments);
  const registeredHref=analyticalDrillThroughHref({ agency:filters.agency, prime_vendor:filters.prime_vendor, registration_fiscal_year:filters.fiscal_year });
  const paymentHref=paymentTransactionDrillThroughHref({ agency:filters.agency, prime_vendor:filters.prime_vendor, fiscal_year:filters.fiscal_year });
  const contractHref=paymentRelatedContractDrillThroughHref({ agency:filters.agency, prime_vendor:filters.prime_vendor, fiscal_year:filters.fiscal_year });
  cards.innerHTML=`<div class="contracts-analytics-fact-card"><span>${escUiHtml(t("analytics_fact_registered"))}</span><strong>${escUiHtml(formatRegisteredValue(registeredSummary.current_registered_value))}</strong><small>${escUiHtml(t("analytics_measure_current"))}</small><a href="${escUiHtml(registeredHref)}">${escUiHtml(t("analytics_view_contract_records"))}</a></div><div class="contracts-analytics-fact-card"><span>${escUiHtml(t("analytics_fact_payments"))}</span><strong>${escUiHtml(formatRegisteredValue(paymentSummary.actual_payment_amount))}</strong><small>${escUiHtml(t("analytics_payment_measure_amount"))}</small><a href="${escUiHtml(paymentHref)}">${escUiHtml(t("analytics_view_payment_transactions"))}</a><a href="${escUiHtml(contractHref)}">${escUiHtml(t("analytics_view_related_contracts"))}</a></div>`;
  panel.hidden=false;
}

function paymentGroupDimension(groupBy){
  return groupBy === "vendor" ? "payee_name" : groupBy === "fiscal_year" ? "fiscal_year" : "agency";
}

function renderAnalyticalPaymentProjection(projection, allProjection, urlFilters){
  const rows=Array.isArray(projection?.rows) ? projection.rows : [];
  const filters={ agency:urlFilters.agency, prime_vendor:urlFilters.prime_vendor, fiscal_year:urlFilters.fiscal_year, contract_id:urlFilters.contract_id };
  const view="overview";
  syncAnalyticalFiscalYears(rows, "payment");
  syncAnalyticalViewControls(view, "payment");
  if(urlFilters.fiscal_year && [...($("#analytics-fy")?.options || [])].some((option)=>option.value===urlFilters.fiscal_year)) $("#analytics-fy").value=urlFilters.fiscal_year;
  const filtered=filterAnalyticalPayments(rows, filters);
  const summary=paymentPopulationSummary(filtered, projection);
  const groupBy=$("#analytics-group")?.value||"agency";
  const measure=$("#analytics-measure")?.value||"amount";
  const grouped=groupAnalyticalPayments(filtered,{groupBy,measure,topN:10});
  const measureLabel=analyticalMeasureLabel(measure,"payment");
  $("#contracts-analytics-kicker")?.replaceChildren(document.createTextNode(t("analytics_fact_payments")));
  $("#contracts-analytics-heading")?.replaceChildren(document.createTextNode(t("analytics_payment_heading")));
  const deck=$("#contracts-analytics-deck");
  if(deck) deck.textContent=t("analytics_payment_deck");
  const coverage=$("#contracts-analytics-coverage");
  if(coverage) coverage.hidden=true;
  const concentration=$("#contracts-analytics-concentration");
  if(concentration) concentration.hidden=true;
  const performanceEvidence=$("#contracts-analytics-performance-evidence");
  if(performanceEvidence) performanceEvidence.hidden=true;
  const timing=$("#contracts-analytics-timing");
  if(timing) timing.hidden=true;
  const population=$("#contracts-analytics-population");
  if(population) population.textContent=`${t("analytics_fact_payments")} — ${measureLabel}: ${measure==="transactions" ? summary.payment_transaction_count.toLocaleString("en-US") : formatRegisteredValue(summary.actual_payment_amount)} · ${summary.payment_transaction_count.toLocaleString("en-US")} ${t("analytics_payment_transactions_unit")} · ${summary.year_label}. ${t("analytics_payment_population_suffix")}`;
  const list=$("#contracts-analytics-groups");
  if(!list) return;
  list.hidden=false;
  list.innerHTML=grouped.shown_groups.map((group,index)=>{
    const dimension=paymentGroupDimension(groupBy);
    const scope={ agency:filters.agency, prime_vendor:filters.prime_vendor, fiscal_year:filters.fiscal_year };
    if(dimension==="agency") scope.agency=group.label;
    if(dimension==="payee_name") scope.prime_vendor=group.label;
    if(dimension==="fiscal_year") scope.fiscal_year=group.label;
    const contractId=group.contract_ids.length === 1 ? group.contract_ids[0] : null;
    const transactionHref=paymentTransactionDrillThroughHref({...scope, contract_id:contractId});
    const contractHref=paymentRelatedContractDrillThroughHref({...scope, contract_id:contractId});
    const value=measure==="transactions" ? `${group.transaction_count.toLocaleString("en-US")} ${t("analytics_payment_transactions_unit")}` : `${formatRegisteredValue(group.actual_payment_amount)} ${measureLabel.toLowerCase()}`;
    return `<li class="contracts-analytics-group"><a href="${escUiHtml(transactionHref)}" data-analytics-drill-through="${escUiHtml(group.label)}">${index+1}. ${escUiHtml(group.label)}</a><span class="contracts-analytics-group-meta">${escUiHtml(value)} · ${group.contract_count.toLocaleString("en-US")} ${escUiHtml(t("analytics_related_contracts_unit"))}<br><a class="contracts-analytics-payment-contracts" href="${escUiHtml(contractHref)}">${escUiHtml(t("analytics_view_related_contracts"))}</a></span></li>`;
  }).join("");
  const note=$("#contracts-analytics-note");
  if(note){ const remaining=grouped.groups.length-grouped.shown_groups.length; note.hidden=false; note.textContent=remaining>0?t("analytics_rank_note",{n:grouped.shown_groups.length,group:analyticalGroupLabel(groupBy),measure:measureLabel.toLowerCase(),remaining:remaining.toLocaleString("en-US")}):t("analytics_payment_group_note"); }
  renderAnalyticalFactComparison(allProjection,filters);
  renderAnalyticalFactStatus();
}

async function renderAnalyticalProjection(rows){
  const panel=$("#contracts-analytics");
  if(!panel) return;
  panel.hidden=mode!=="award";
  if(mode!=="award") return;
  const projection=Array.isArray(rows) ? { registered_contract: { rows } } : (rows || {});
  const urlFilters=analyticalUrlFilters();
  const fact=urlFilters.fact === "payment" ? "payment" : "registered_contract";
  const selectedControl=$("#analytics-fact");
  if(selectedControl) selectedControl.value=fact;
  const compatible=switchAnalyticalFact(fact === "payment" ? "registered_contract" : "payment", fact, analyticalFactFilters());
  analyticalDroppedFilters=[...new Set([...analyticalDroppedFilters,...compatible.dropped])];
  if(fact === "payment") {
    renderAnalyticalPaymentProjection(projection.payment, projection, urlFilters);
    return;
  }
  const registeredProjection=projection.registered_contract || projection;
  const projectionRows=Array.isArray(registeredProjection.rows) ? registeredProjection.rows : [];
  syncAnalyticalFiscalYears(projectionRows);
  const view=$("#analytics-view")?.value||"overview";
  syncAnalyticalViewControls(view,"registered_contract");
  const performanceEvidencePanel=$("#contracts-analytics-performance-evidence");
  if(performanceEvidencePanel) performanceEvidencePanel.hidden=view!=="performance_evidence";
  if(view==="performance_evidence"){
    const filters={
      agency:urlFilters.agency,
      prime_vendor:urlFilters.prime_vendor,
      registration_fiscal_year:urlFilters.registration_fiscal_year,
      contract_amount_band:urlFilters.contract_amount_band,
      min_amount:urlFilters.min_amount,
      max_amount:urlFilters.max_amount,
    };
    $("#contracts-analytics-coverage")?.setAttribute("hidden","");
    $("#contracts-analytics-concentration")?.setAttribute("hidden","");
    $("#contracts-analytics-timing")?.setAttribute("hidden","");
    $("#contracts-analytics-kicker")?.replaceChildren(document.createTextNode(t("analytics_evidence_kicker")));
    $("#contracts-analytics-heading")?.replaceChildren(document.createTextNode(t("analytics_evidence_heading")));
    const deck=$("#contracts-analytics-deck");
    if(deck) deck.textContent=t("analytics_evidence_deck");
    const population=$("#contracts-analytics-population");
    if(population) population.textContent=t("analytics_evidence_population",{count:projectionRows.length.toLocaleString("en-US")});
    $("#contracts-analytics-groups")?.setAttribute("hidden","");
    $("#contracts-analytics-note")?.setAttribute("hidden","");
    renderPerformanceEvidenceProjection(projectionRows,filters,projection.performance_evidence);
    renderAnalyticalFactComparison(projection,filters);
    renderAnalyticalFactStatus();
    return;
  }
  const timingView=view === "timing";
  const kicker=$("#contracts-analytics-kicker");
  if(kicker) kicker.textContent=t(timingView ? "analytics_view_timing" : "analytics_compare_kicker");
  $("#contracts-analytics-heading")?.replaceChildren(document.createTextNode(t(timingView ? "analytics_timing_heading" : "analytics_overview_heading")));
  const deck=$("#contracts-analytics-deck");
  if(deck) deck.textContent=t(timingView ? "analytics_timing_deck" : "analytics_overview_deck");
  const timingMetrics=$("#contracts-analytics-timing");
  if(timingMetrics) timingMetrics.hidden=!timingView;
  const coveragePanel=$("#contracts-analytics-coverage");
  if(coveragePanel) coveragePanel.hidden=false;
  const controls=analyticalControlsFilters();
  if(urlFilters.registration_fiscal_year && [...($("#analytics-fy")?.options || [])].some((option)=>option.value===urlFilters.registration_fiscal_year)) $("#analytics-fy").value=urlFilters.registration_fiscal_year;
  const filters={...controls, agency:urlFilters.agency, prime_vendor:urlFilters.prime_vendor, contract_amount_band:urlFilters.contract_amount_band};
  // A drill-through scope is authoritative for the population shown in the
  // ordinary list, while the panel still lets the reader change its grouping.
  if(urlFilters.registration_fiscal_year) filters.registration_fiscal_year=urlFilters.registration_fiscal_year;
  if(urlFilters.min_amount) filters.min_amount=urlFilters.min_amount;
  if(urlFilters.max_amount) filters.max_amount=urlFilters.max_amount;
  if(urlFilters.retroactive) filters.retroactive=urlFilters.retroactive;
  const filtered=filterAnalyticalContracts(projectionRows,filters);
  const summary=populationSummary(filtered,{snapshot_date:registeredProjection.snapshot_date,population_definition:registeredProjection.population_definition});
  const timingSummary=registrationTimingSummary(filtered);
  const groupBy=$("#analytics-group")?.value||"agency";
  const measure=$("#analytics-measure")?.value||"current";
  const groupedLegacy=groupAnalyticalContracts(filtered,{groupBy,measure,topN:10});
  let grouped=groupedLegacy;
  if(!timingView){
    try{
      const capability=await analyzeContractsProjection(registeredProjection,{
        groupBy,
        measure,
        agency:filters.agency,
        vendor:filters.prime_vendor,
        fiscalYear:filters.registration_fiscal_year ? Number(filters.registration_fiscal_year) : null,
        amountBand:filters.contract_amount_band,
        minAmount:filters.min_amount ? Number(filters.min_amount) : null,
        maxAmount:filters.max_amount ? Number(filters.max_amount) : null,
        cityRecordMatch:urlFilters.city_record_match,
        limit:10,
      });
      const valueKey=valueKeyForMeasure(measure);
      grouped={
        ...groupedLegacy,
        // The capability owns the ranked groups and exact drill-through ids;
        // timing-only metadata stays on the existing timing presentation.
        shown_groups:capability.groups.map(group=>({...group,[valueKey]:group.value})),
      };
    }catch(_error){
      // A malformed or unavailable projection keeps the existing local empty
      // or degraded rendering instead of blanking the Contracts page.
    }
  }
  const measureLabel=analyticalMeasureLabel(measure);
  renderAnalyticalVendorConcentration(filtered,filters,measure,urlFilters.agency);
  const population=$("#contracts-analytics-population");
  if(population){
    const headline=timingView ? renderRegistrationTimingSummary(timingSummary, summary) : measure==="count"
      ? t("analytics_population_count",{count:summary.contract_count.toLocaleString("en-US")})
      : t("analytics_population_value",{value:formatRegisteredValue(measure==="original" ? filtered.reduce((sum,row)=>sum+(Number(row.original_registered_amount)||0),0) : summary.current_registered_value),measure:measureLabel.toLowerCase(),count:summary.contract_count.toLocaleString("en-US")});
    if(!timingView) population.textContent=`${headline} · ${summary.year_label}. ${t("analytics_population_suffix")}`;
  }
  const list=$("#contracts-analytics-groups");
  if(!list) return;
  list.hidden=!!urlFilters.agency && !urlFilters.prime_vendor;
  list.innerHTML=grouped.shown_groups.map((group,index)=>{
    const href=analyticalDrillThroughHref({
      [analyticalGroupDimension(groupBy)]: groupBy === "registration_fiscal_year" ? group.label.replace(/^FY/, "") : group.label,
      registration_fiscal_year: filters.registration_fiscal_year,
      contract_amount_band: groupBy === "amount_band" ? group.label : filters.contract_amount_band,
      min_amount: filters.min_amount,
      max_amount: filters.max_amount,
      retroactive: timingView || filters.retroactive === "true",
    });
    const timingValue=group.retroactive_share == null ? t("analytics_not_available") : `${(group.retroactive_share*100).toFixed(1)}% ${t("analytics_after_start")}`;
    const value=timingView ? timingValue : measure==="count" ? `${group.contract_count.toLocaleString("en-US")} ${t("analytics_contracts_unit")}` : `${formatRegisteredValue(group[valueKeyForMeasure(measure)])} ${measureLabel.toLowerCase()}`;
    const groupLabel=groupBy === "registration_fiscal_year" && Number.isInteger(Number(group.label)) ? `FY${group.label}` : group.label;
    const timingMeta=timingView ? `${group.retroactive_contract_count.toLocaleString("en-US")} ${t("analytics_metric_retroactive").toLowerCase()} · ${group.eligible_contract_count.toLocaleString("en-US")} ${t("analytics_metric_eligible").toLowerCase()}` : `${group.contract_count.toLocaleString("en-US")} ${t("analytics_contracts_unit")}`;
    return `<li class="contracts-analytics-group"><a href="${escUiHtml(href)}" data-analytics-drill-through="${escUiHtml(group.label)}">${index+1}. ${escUiHtml(groupLabel)}</a><span class="contracts-analytics-group-meta">${escUiHtml(value)} · <span>${escUiHtml(timingMeta)}</span></span></li>`;
  }).join("");
  const remaining=grouped.groups.length-grouped.shown_groups.length;
  const note=$("#contracts-analytics-note");
  if(note) note.hidden=!!urlFilters.agency && !urlFilters.prime_vendor && !timingView;
  if(note) note.textContent=timingView
    ? `${t("analytics_timing_note")} ${remaining>0 ? t("analytics_rank_note",{n:grouped.shown_groups.length,group:analyticalGroupLabel(groupBy),measure:t("analytics_measure_timing").toLowerCase(),remaining:remaining.toLocaleString("en-US")}) : ""}`.trim()
    : remaining>0
      ? t("analytics_rank_note",{n:grouped.shown_groups.length,group:analyticalGroupLabel(groupBy),measure:measureLabel.toLowerCase(),remaining:remaining.toLocaleString("en-US")})
      : t("analytics_group_exact_note");
  renderAnalyticalCoverage(projectionRows, filters);
  renderAnalyticalFactComparison(projection, { agency:filters.agency, prime_vendor:filters.prime_vendor, fiscal_year:filters.registration_fiscal_year });
  renderAnalyticalFactStatus();
}

function valueKeyForMeasure(measure){
  return measure==="original" ? "sum_original_registered_amount" : measure==="count" ? "contract_count" : "sum_current_registered_amount";
}

function analyticalFactFilters(){
  const filters=analyticalUrlFilters();
  return {
    agency:filters.agency,
    prime_vendor:filters.prime_vendor,
    fiscal_year:filters.fiscal_year,
    contract_amount_band:filters.contract_amount_band,
    min_amount:filters.min_amount,
    max_amount:filters.max_amount,
    retroactive:filters.retroactive,
    city_record_match:filters.city_record_match,
    performance_evidence_state:filters.performance_evidence_state,
    contract_id:filters.contract_id,
  };
}

function analyticalDropQueryKey(key){
  return {
    contract_amount_band:"ap_amount_band",
    min_amount:"ap_min",
    max_amount:"ap_max",
    retroactive:"retroactive",
    city_record_match:"ap_city_record_match",
    performance_evidence_state:"ap_evidence_state",
    contract_id:"ap_contract_id",
  }[key] || key;
}

function changeAnalyticalFact(nextFact){
  const currentFact=analyticalUrlFilters().fact || "registered_contract";
  const switched=switchAnalyticalFact(currentFact,nextFact,analyticalFactFilters());
  analyticalDroppedFilters=switched.dropped.filter((key)=>key!=="registration_fiscal_year");
  const params=new URLSearchParams(location.search);
  params.set("ap_fact",nextFact);
  for(const key of switched.dropped) params.delete(analyticalDropQueryKey(key));
  const query=params.toString();
  history.replaceState(null,"",`${location.pathname}${query?`?${query}`:""}${location.hash}`);
  analyticalProjectionPromise?.then(renderAnalyticalProjection).catch(()=>{});
}

function bindAnalyticalControls(){
  const factControl=$("#analytics-fact");
  if(factControl&&!factControl.dataset.analyticsBound){
    factControl.dataset.analyticsBound="1";
    factControl.addEventListener("change",()=>changeAnalyticalFact(factControl.value));
  }
  const coveragePanel=$("#contracts-analytics-coverage");
  if(coveragePanel&&!coveragePanel.dataset.coverageHashBound){
    coveragePanel.dataset.coverageHashBound="1";
    addEventListener("hashchange",()=>openCoverageDestination($("#contracts-analytics-coverage")));
  }
  ["#analytics-view","#analytics-group","#analytics-measure","#analytics-fy","#analytics-min","#analytics-max","#analytics-coverage-threshold","#analytics-coverage-band"].forEach((selector)=>{
    const element=$(selector);
    if(!element || element.dataset.analyticsBound) return;
    element.dataset.analyticsBound="1";
    element.addEventListener("change",()=>{
      if(!analyticalProjectionPromise) return;
      analyticalProjectionPromise.then(renderAnalyticalProjection).catch(()=>{});
    });
  });
}

async function search(){
  const rumInteraction=claimContractsRumInteraction();
  const forceFullHistory = forceFullHistorySearch;
  forceFullHistorySearch = false;
  moneyLoaded = true;
  mode = $("#mode").value;
  if(mode!=="award" && $("#contracts-analytics")) $("#contracts-analytics").hidden=true;
  const agency = $("#agency").value, kw = $("#kw").value.trim();
  const sort = $("#sort").value, minamt = $("#minamt").value;
  $("#minwrap").style.display = mode === "award" ? "" : "none";
  $("#minamt").disabled = mode !== "award";
  if(mode !== "open" && closingWeek){ closingWeek = false; setClosingWeekState(false); }
  $("#moneyquick").style.display = mode === "open" ? "" : "none";
  const hasLocationFilter=!!($("#moneylocationbasis")?.value||$("#moneyboro")?.value||$("#moneycd")?.value||$("#moneycouncil")?.value);
  const locationTools=hasLocationFilter?await moneyActionLocationTools():null;
  const locationFilter=locationTools?locationTools.moneyLocationFilterFromControls():moneyLocationFilter={layer:"",basis:"",borough:"",communityDistrict:"",councilDistrict:""};
  if(locationFilter.layer==="contract_action_address" && mode!=="allrfp"){
    mode="allrfp";
    $("#mode").value="allrfp";
    $("#moneyquick").style.display="none";
    $("#minwrap").style.display="none";
    $("#minamt").disabled=true;
  }
  syncProcurementFacetRails();
  renderMoneyActiveFilters();
  updateMoneyMoreFiltersState();
  if(locationTools){
    updateHash();
    syncProcurementFacetRails();
    await locationTools.paintMoneyActionLocationResults(locationFilter,{
      t,agency:$("#agency").value,query:$("#kw").value,
      paintMoneyRows:(rows,options)=>paintMoneyRows(rows,{...options,rumInteraction}),
    });
    return true;
  }

  const {category=null, maxAmount=null, months=null, excludeSpecial=false, processState=null} = moneyNlResolved;
  updateHash();
  syncProcurementFacetRails();
  const heads = {
    open:t("head_open"), allrfp:t("head_allrfp"), award:t("head_award"), archive:t("head_archive"),
  };
  syncMoneyDiscoveryCopy();
  $("#reshead").textContent = heads[mode] + (mode==="open" && closingWeek ? t("head_closing_this_week") : "") + (methodSel ? " · " + methodSel : "") + (agency ? " · " + agency : "");
  $("#rescount").textContent = "";
  busyList("#list");
  const stale = staleGuard("money");
  currentMoneyFreshness=null;
  try{
    const defaultSearch=isDefaultMoneySearchState({
      mode,agency,kw,methodSel,closingWeek,minAmount:minamt,sort,nlResolved:moneyNlResolved,
    });
    const awardArchive=mode==="award"||mode==="archive";
    const snapshotPromise=defaultSearch
      ? loadMoneyDefaultSnapshot()
      : loadMoneyResidentSnapshot();
    const activeFacetValues=globalThis.CROL_ACTIVE_SCOPE_FACET_VALUES||{};
    const entityRefs=Array.isArray(activeFacetValues.entity_refs_all)
      ? activeFacetValues.entity_refs_all
      : [];
    const contractIdentity=contractIdentityFromFacetValues(activeFacetValues);
    const scopedVendorStem=vendorStemsFromEntityRefs(entityRefs)[0]||"";
    const retrievalQuery=kw||scopedVendorStem;
    // Every keyword and exact-reference retrieval goes to the capability, in every
    // mode. The mode, facets and sort narrow the answer locally; they never make
    // Browse ask a different question than the search front door would ask.
    const needsSearch=Boolean(contractIdentity||retrievalQuery);
    const common={
      mode,agency,keyword:kw,closingWeek,minAmount:minamt||null,maxAmount,category,months,
      excludeSpecial,entityRefs,contractObjectRef:contractIdentity?.object_ref||"",sort,today:todayISO(),weekEnd:weekOutISO(),
      processStates:processState?[processState]:[],
      monthEnd:months?addMonthsISO(todayISO(),months):null,
    };
    const analyticalScope = mode === "award" ? analyticalUrlFilters() : {};
    const analyticalScopeActive = analyticalScope.fact === "payment"
      || Object.entries(analyticalScope).some(([key, value]) => !["fact", "payment_view"].includes(key) && value != null && value !== "");
    const compactFirstPage=awardArchive && !needsSearch && !analyticalScopeActive
      && !agency && !methodSel && !closingWeek && !minamt
      && !category && maxAmount==null && months==null && !excludeSpecial && !processState
      && !entityRefs.length && !contractIdentity
      && (!sort || sort==="newest");
    const firstPageProcurementPromise=compactFirstPage
      ? loadMoneyProcurementSnapshot({...common,method:methodSel},[])
      : null;
    const canonicalFirstPage=firstPageProcurementPromise?await firstPageProcurementPromise:null;
    if(canonicalFirstPage){
      const snapshotRows=canonicalFirstPage.rows || [];
      loadMethodFacet(snapshotRows,canonicalFirstPage.facets?.method);
      const rows=snapshotRows.slice(0,40);
      if(stale()) return;
      paintMoneyRows(rows,{
        autoSelect:true,
        narrowed:false,
        lineageRows:snapshotRows,
        rumInteraction,
      });
      if(mode==="award"){
        loadAnalyticalProjection().then((analyticsProjection)=>{
          if(stale()) return;
          bindAnalyticalControls();
          if(analyticsProjection) renderAnalyticalProjection(analyticsProjection);
        }).catch(()=>{});
      }
      Promise.all([
        snapshotPromise.catch(()=>null),
        Promise.resolve(typeof canonicalFirstPage.hydrate==="function"?canonicalFirstPage.hydrate():canonicalFirstPage.hydrate),
      ]).then(([snapshot,hydrated])=>{
        if(stale() || !Array.isArray(hydrated?.rows)) return;
        const retainedRows=moneySnapshotRows(snapshot);
        currentMoneyLineageRows=mergeCanonicalProcurementBrowseRows(retainedRows,hydrated.rows);
        loadLineageBadges(currentMoneyLineageRows);
      }).catch(()=>{});
      return true;
    }
    const snapshot=await snapshotPromise;
    // The default open-solicitation list is the one place a stale committed
    // snapshot could be mistaken for a genuinely empty population, so it is the
    // one place that reads the shared projection's freshness state as well as
    // its rows; every other search state keeps its prior unfiltered read.
    const defaultProjection=defaultSearch
      ? openContractSnapshotProjection(snapshot,{clock:moneyEvaluationClockMs()})
      : null;
    currentMoneyFreshness=defaultProjection;
    const retainedRows=defaultProjection
      ? defaultProjection.rows
      : moneySnapshotRows(snapshot);
    const scopedRetrievalPromise=needsSearch
      ? loadContractScopedRetrieval(retrievalQuery,contractIdentity)
      : Promise.resolve(CONTRACT_SCOPED_RETRIEVAL_IDLE);
    // The award and archive read models fold the scoped candidates into their own
    // canonical query, so those modes wait for the answer. Every other mode keeps
    // painting the retained snapshot first and folds the scoped candidates in when
    // the capability replies: static-first survives a slow or failing provider.
    const scopedRetrieval=awardArchive
      ? await scopedRetrievalPromise
      : CONTRACT_SCOPED_RETRIEVAL_IDLE;
    const searchedRows=mergeContractSearchRows(retainedRows,scopedRetrieval.documents);
    const canonicalSnapshot=awardArchive
      ? await loadMoneyProcurementSnapshot({...common,method:methodSel},searchedRows)
      : {rows:[],facets:{},hydrate:Promise.resolve({rows:[]})};
    const snapshotRows=awardArchive
      ? (canonicalSnapshot?.rows || [])
      : retainedRows;
    const analyticsProjection = mode === "award" ? await loadAnalyticalProjection() : null;
    bindAnalyticalControls();
    if (analyticsProjection) renderAnalyticalProjection(analyticsProjection);
    const analyticalScopeRows = analyticalScopeActive
      ? analyticalScope.fact === "payment"
        ? filterAnalyticalPayments(analyticsProjection?.payment?.rows || [], analyticalScope).map(analyticalPaymentMoneyRow)
        : filterAnalyticalContracts(analyticsProjection?.registered_contract?.rows || [], analyticalScope).map(analyticalMoneyRow)
      : null;
    if (analyticalScopeActive) {
      if (stale()) return;
      paintMoneyRows(analyticalScopeRows.slice(0, 40), {
        autoSelect: false,
        lineageRows: analyticalScopeRows,
        rumInteraction,
      });
      return true;
    }
    // Outside the award/archive read models the snapshot is still filtered exactly
    // as before. The capability's candidates are added alongside it under the same
    // mode and facets, minus the local keyword predicate — re-running that
    // predicate would let local text matching overrule what the capability matched,
    // which is the divergence this surface exists to remove.
    const composeBrowseRows=(documents)=>{
      const scopedCandidateRows=awardArchive?[]:mergeContractSearchRows([],documents);
      const scopedFacetRows=scopedCandidateRows.length
        ? filterMoneySnapshot(scopedCandidateRows,{...common,keyword:"",method:"",limit:scopedCandidateRows.length})
        : [];
      const facetRows=awardArchive
        ? snapshotRows
        : mergeCanonicalProcurementBrowseRows(
          filterMoneySnapshot(snapshotRows,{...common,method:"",limit:snapshotRows.length}),
          scopedFacetRows,
        );
      const rows=awardArchive
        ? snapshotRows.slice(0,40)
        : methodSel
          ? mergeCanonicalProcurementBrowseRows(
            filterMoneySnapshot(snapshotRows,{...common,method:methodSel,limit:40}),
            filterMoneySnapshot(scopedFacetRows,{...common,keyword:"",method:methodSel,limit:40}),
          ).slice(0,40)
          : facetRows.slice(0,40);
      return {facetRows,rows,scopedFacetRows};
    };
    const painted=composeBrowseRows(scopedRetrieval.documents);
    loadMethodFacet(painted.facetRows,awardArchive ? canonicalSnapshot?.facets?.method : null);
    if(stale()) return;
    paintMoneyRows(painted.rows,{
      autoSelect:true,
      narrowed:false,
      lineageRows:awardArchive
        ? snapshotRows
        : mergeCanonicalProcurementBrowseRows(snapshotRows,painted.scopedFacetRows),
      rumInteraction,
      scopedRetrieval,
    });
    if(!awardArchive && needsSearch){
      // Second paint, same composition: the scoped candidates and the coverage
      // the capability reported, added to rows the reader already has. Local rows
      // keep their positions, so an open row keeps pointing at the same record.
      scopedRetrievalPromise.then((retrieval)=>{
        if(stale()) return;
        const enriched=composeBrowseRows(retrieval.documents);
        loadMethodFacet(enriched.facetRows,null);
        paintMoneyRows(enriched.rows,{
          autoSelect:false,
          narrowed:false,
          lineageRows:mergeCanonicalProcurementBrowseRows(snapshotRows,enriched.scopedFacetRows),
          rumInteraction,
          scopedRetrieval:retrieval,
        });
      }).catch(()=>{});
    }
    const hydration=typeof canonicalSnapshot?.hydrate === "function" ? canonicalSnapshot.hydrate() : canonicalSnapshot?.hydrate;
    Promise.resolve(hydration)?.then((hydrated)=>{
      if(stale() || !Array.isArray(hydrated?.rows)) return;
      currentMoneyLineageRows=mergeCanonicalProcurementBrowseRows(searchedRows,hydrated.rows);
      loadLineageBadges(currentMoneyLineageRows);
    }).catch(()=>{});
    return true;
  }catch(e){
    if(stale()) return;
    unbusy("#list");
    $("#list").innerHTML = '<div class="empty">' + t("retry_open_data") + '</div>';
    $("#detail").innerHTML = "";
    reportContractsRumResults(rumInteraction,"unavailable");
    return false;
  }
}
function paintMoneyRows(rows, {autoSelect=true, narrowed=false, lineageRows=null,rumInteraction=null,scopedRetrieval=null}={}){
  currentRows = rows;
  globalThis.syncCalendarSubscription?.("money", rows);
  currentMoneyLineageRows = lineageRows || rows;
  currentMoneyNarrowed = narrowed;
  setExportBandVisibility(currentRows.length, "money-export-band", "money-export-overflow");
  unbusy("#list");
  const receiptCount=countWithScopeReceipt(currentRows.length);
  const hasReceipt=receiptCount!==currentRows.length;
  const countText=receiptCount===1?t("one_result"):t(!hasReceipt&&currentRows.length===40?"or_more_results":"results_count",{n:receiptCount});
  $("#rescount").textContent = countText;
  announce(countText + ` — ${$("#reshead").textContent}`);
  renderList(autoSelect,lineageRows);
  if(scopedHistoryGap(currentRows)){
    const note = scopedHistoryNoteHTML(receiptCount, currentRows.length, narrowed);
    if(currentRows.length) $("#list").insertAdjacentHTML("afterbegin", note);
    else $("#list").innerHTML = note;
    bindFullHistorySearch();
  }else if(narrowed){
    $("#list").insertAdjacentHTML("afterbegin",
      `<div class="note warn" style="margin:10px 12px 0">${t("narrowed_note",{date:recentCutLabel()})}</div>`);
  }
  if(currentRows.length && currentMoneyFreshness && !currentMoneyFreshness.emptyStateEligible){
    // The rows above are real, still-open, future-dated notices from a stale
    // snapshot — kept visible, but qualified rather than presented as the
    // complete currently-open set. The empty case is handled in renderList().
    $("#list").insertAdjacentHTML("afterbegin", moneyStaleSourceNoticeHTML(currentMoneyFreshness));
  }
  const scopeReceipt=contractScopeReceiptHTML(scopedRetrieval);
  if(scopeReceipt){
    // A failed capability with nothing else to show replaces the empty state
    // outright: "Nothing found" would be a claim about the city, not about us.
    if(!currentRows.length && scopedRetrieval?.outcome==="unavailable") $("#list").innerHTML=scopeReceipt;
    else $("#list").insertAdjacentHTML("afterbegin",scopeReceipt);
  }
  reportContractsRumResults(
    rumInteraction,
    currentRows.length ? "content" : scopedRetrieval?.outcome==="unavailable" ? "unavailable" : "empty",
  );
}

function loadMethodFacet(rows, precomputedFacets=null){
  const el = $("#methodfacet");
  const primary = $("#money-method-primary");
  try{
    const facets=Array.isArray(precomputedFacets) ? precomputedFacets : moneyMethodFacet(rows);
    if(facets.length < 2 && !methodSel){
      el.innerHTML="";
      primary.hidden=true;
      return;
    }
    primary.hidden=false;
    el.innerHTML = facets.map(r=>{
      const m = r.selection_method_description;
      return `<button type="button" class="chip ${methodSel===m?'on':''}" data-m="${m.replace(/"/g,"&quot;")}">${m}<span class="ct">${(+r.n).toLocaleString()}</span></button>`;
    }).join("");
    el.querySelectorAll(".chip").forEach(b=>b.addEventListener("click", ()=>{
      methodSel = methodSel === b.dataset.m ? "" : b.dataset.m;
      search();
    }));
  }catch(e){
    el.innerHTML="";
    primary.hidden=true;
  }
}

let moneyListMwbeSurfacePromise = null;
function moneyListMwbeSurfaceTools(){
  if(!moneyListMwbeSurfacePromise){
    moneyListMwbeSurfacePromise = import("../mwbe_goal_surface.mjs").catch(() => null);
  }
  return moneyListMwbeSurfacePromise;
}
function solicitationListChipsHTML(r){
  const tools = moneyListMwbeSurfacePromise && moneyListMwbeSurfacePromise._value
    ? moneyListMwbeSurfacePromise._value
    : null;
  if(!tools || typeof tools.buildSolicitationListChips !== "function") return "";
  const chips = tools.buildSolicitationListChips(r) || [];
  if(!chips.length) return "";
  return `<div class="mwbe-chiprow" data-mwbe-list-chips="1">${chips.map(c => {
    const label = c.i18n_params ? t(c.i18n_key, c.i18n_params) : t(c.i18n_key);
    const tone = c.tone || "method";
    return `<span class="tag ${escUiHtml(tone)}">${escUiHtml(label)}</span>`;
  }).join("")}</div>`;
}
function moneyListPrimaryAction(r, today=todayISO()){
  if(!globalThis.CrolActions || typeof CrolActions.compileActionRail!=="function") return null;
  if(typeof globalThis.noticeActionMatter!=="function") return null;
  try{
    const matter=globalThis.noticeActionMatter(r);
    if(!matter || (matter.kind!=="solicitation"&&matter.kind!=="award")) return null;
    if(matter.kind==="solicitation" && !solicitationResponseContextReady(r)) return null;
    const action=(CrolActions.compileActionRail(matter,{today})||[])[0]||null;
    if(!action || action.delivery==="unavailable") return null;
    if(matter.kind==="solicitation" && action.type!=="official_application" && action.type!=="bid_checklist") return null;
    if(matter.kind==="award" && (!action.guide||action.guide.system!=="award_lifecycle")) return null;
    const external=action.delivery==="official_handoff"&&!!action.destination;
    return {
      kind:matter.kind,
      action,
      external,
      href:external?action.destination:`#notice/${encodeURIComponent(r.request_id)}`,
      label_key:matter.kind==="solicitation"?"respond_lbl":"award_guide_heading",
    };
  }catch(_e){ return null; }
}
function moneyListInteractionProjection(r, today=todayISO()){
  const requestId=String(r?.request_id||"").trim();
  const canonicalHref=String(r?.canonical_href||"").trim();
  const presentation=moneyListPrimaryAction(r,today);
  const kineticActions=presentation ? [{
    label:t(presentation.label_key),
    href:presentation.href,
    kind:presentation.action.type,
    context_ready:true,
    primary:true,
  }] : [];
  return objectCardInteractionProjection({
    target:(canonicalHref||requestId) ? {
      href:canonicalHref||`/notices/${encodeURIComponent(requestId)}`,
      label:noticeDisplayTitle(r),
    } : null,
    kinetic_actions:kineticActions,
  });
}
function moneyListPrimaryActionHTML(r, today=todayISO()){
  return renderObjectCardActionRail(moneyListInteractionProjection(r,today),{
    heading:t("next_action_heading"),
    escape:escUiHtml,
    newTabLabel:t("ext_link_new_tab_sr"),
  });
}
function moneyListCardInteractionsHTML(r, titleMarkup, today=todayISO()){
  const projection=moneyListInteractionProjection(r,today);
  return renderObjectCardPrimitives(projection,{
    escape:escUiHtml,
    titleMarkup,
    titleClassName:"ui-object-card-title rtitle",
    copyLabel:t("copy_link"),
    actionHeading:t("next_action_heading"),
    newTabLabel:t("ext_link_new_tab_sr"),
  });
}
function moneyRowHTML(r, i, terms){
  const typedStages=(Array.isArray(r.procurement_stages)?r.procurement_stages:(r.primary_stage?[r.primary_stage]:[]))
    .map(stage=>String(stage||"").trim().toLowerCase());
  const isAward = r.type_of_notice_description === "Award"
    || typedStages.some(stage=>["award","pending","registered","payment","contract"].includes(stage));
  const lead = isAward
    ? (money(r.contract_amount) ? `<span class="tag amt">${money(r.contract_amount)}</span>` : "")
    : deadlineTag(r.due_date);
  const title = noticeDisplayTitle(r), ev = resultMatchEvidence(title, matchText(r), terms);
  const mwbeChips = !isAward ? solicitationListChipsHTML(r) : "";
  const actionLocationChip=globalThis.MoneyActionLocations?.moneyActionLocationChipHTML?.(r,{t,esc:escUiHtml})||"";
  const interactions=moneyListCardInteractionsHTML(r,digTitleHTML(title,ev));
  const reportMarkup = r.procurement_id || r.canonical_href
    ? renderReportIssueAffordance(buildContractReportTarget(r))
    : "";
  const agencyMention=listEntityMentionHTML({kind:"agency",value:r.agency_name,escape:escUiHtml,relation:"publishes_record"});
  const vendorMention=r.vendor_name?listEntityMentionHTML({kind:"vendor",value:r.vendor_name,escape:escUiHtml,relation:"named_vendor"}):"";
  const projectMention=r.project_id?listEntityMentionHTML({kind:"project",value:r.project_id,label:r.project_name||r.project_id,escape:escUiHtml,relation:"names_project"}):"";
  return `<article class="money-row-card">
      <div class="row" data-i="${i}" tabindex="0" role="group">
      ${interactions||`<p class="rtitle">${digTitleHTML(title,ev)}</p>`}
      ${reportMarkup}
      <p class="rmeta">${lead}<span class="lineage-slot"></span><span class="ragency" lang="en" dir="ltr">${agencyMention}</span>${vendorMention?` · ${vendorMention}`:""}${projectMention?` · ${projectMention}`:""} · ${fdate(r.start_date)}
        ${r.category_description? " · "+r.category_description : ""}<br>
        ${usablePin(r.pin)? `<span class="pin">PIN ${r.pin}</span>` : `<span class="pin muted">${t("no_linkable_pin")}</span>`}${typeof moneyPinCandidateChipHTML==="function"?moneyPinCandidateChipHTML(r):""}</p>
      ${mwbeChips}
      ${actionLocationChip}
      ${typeof renderProcurementRowCoverageHtml === "function" ? renderProcurementRowCoverageHtml(r, { translate: t }) : ""}
      ${digEvidenceHTML(ev)}
      </div>
    </article>`;
}
async function ensureMwbeListChipsReady(){
  const tools = await moneyListMwbeSurfaceTools();
  if(tools) moneyListMwbeSurfacePromise._value = tools;
  return tools;
}
function moneyRowIsClosed(row, today=todayISO()){
  const due=String(row&&row.due_date||"").slice(0,10);
  return !!due&&due<String(today).slice(0,10);
}
function partitionMoneyRows(rows, today=todayISO()){
  const indexed=(rows||[]).map((row,index)=>({row,index}));
  return {
    current:indexed.filter(item=>!moneyRowIsClosed(item.row,today)).sort((a,b)=>String(a.row.due_date||"9999").localeCompare(String(b.row.due_date||"9999"))),
    closed:indexed.filter(item=>moneyRowIsClosed(item.row,today)),
  };
}
let moneySameConsolidationPromise=null;
function moneySameConsolidation(){
  return moneySameConsolidationPromise||=import("../same_consolidation.mjs").catch(()=>null);
}
function moneyPinSiblingGrouping(){
  return moneyPinSiblingPromise||=import("../pin_sibling_grouping.mjs").catch(()=>null);
}
function loadPinFamilyReview(){
  if(!pinFamilyReviewPromise){
    pinFamilyReviewPromise=fetch(PIN_FAMILY_REVIEW_URL)
      .then(r=>r.ok?r.json():null)
      .catch(()=>null);
  }
  return pinFamilyReviewPromise;
}
const moneyPinCandidateByRow=new WeakMap();
function moneyPinCandidateChipHTML(row){
  const candidate=moneyPinCandidateByRow.get(row);
  if(!candidate) return "";
  return `<br><span class="money-pin-candidate">${escUiHtml(t("pin_sibling_candidate"))}</span>`;
}
function moneyPinSiblingGroupHTML(entry, terms){
  const members=Array.isArray(entry.members)?entry.members:[];
  if(!members.length) return "";
  const memberRows=members.map((row,idx)=>{
    const i=currentRows.indexOf(row);
    return moneyRowHTML(row, i>=0?i:idx, terms);
  }).join("");
  return `<article class="money-row-card money-pin-sibling" data-pin-sibling="related_instrument">
    <p class="money-pin-sibling-kicker">${escUiHtml(t("pin_sibling_related_summary",{pin:entry.pin||"",n:fmtNumber(entry.count||members.length)}))}</p>
    <p class="money-pin-sibling-note">${escUiHtml(t("pin_sibling_related_note"))}</p>
    <div class="money-pin-sibling-members">${memberRows}</div>
  </article>`;
}
function moneyAwardTitleStem(row){
  return String(noticeDisplayTitle(row)||"")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g," ")
    .replace(/\s+/g," ")
    .trim()
    .slice(0,80);
}
function moneyAwardGroupHTML(entry, terms){
  const members=Array.isArray(entry.members)?entry.members:[];
  if(!members.length) return "";
  const lead=members[0];
  const dates=members.map((row)=>String(row.start_date||"").slice(0,10)).filter(Boolean).sort();
  const range=dates.length
    ? (dates[0]===dates[dates.length-1]?fdate(dates[0]):`${fdate(dates[0])} – ${fdate(dates[dates.length-1])}`)
    : "";
  const title=noticeDisplayTitle(lead);
  const agencyMention=listEntityMentionHTML({kind:"agency",value:lead.agency_name,escape:escUiHtml,relation:"publishes_record"});
  const vendorMention=lead.vendor_name?listEntityMentionHTML({kind:"vendor",value:lead.vendor_name,escape:escUiHtml,relation:"named_vendor"}):"";
  const amount=money(lead.contract_amount);
  const memberRows=members.map((row,idx)=>{
    const i=currentRows.indexOf(row);
    return moneyRowHTML(row, i>=0?i:idx, terms);
  }).join("");
  return `<article class="money-row-card money-award-cluster" data-money-cluster="1">
    <div class="row money-cluster-summary" tabindex="0" role="group">
      <p class="rtitle">${escUiHtml(title)}</p>
      <p class="rmeta">${amount?`<span class="tag amt">${amount}</span>`:""}<span class="ragency" lang="en" dir="ltr">${agencyMention}</span>${vendorMention?` · ${vendorMention}`:""}${range?` · ${escUiHtml(range)}`:""}</p>
      <p class="money-cluster-count">${t("property_cluster_summary",{description:t("property_cluster_fallback"),n:fmtNumber(entry.count)})}</p>
      <details class="money-cluster-details">
        <summary>${t("property_cluster_show")}</summary>
        <div class="money-cluster-members">${memberRows}</div>
      </details>
    </div>
  </article>`;
}
async function consolidateMoneyAwardRows(rows){
  if(mode!=="award" || !rows.length) return null;
  const tools=await moneySameConsolidation();
  if(!tools || typeof tools.groupSameExcept!=="function") return null;
  return tools.groupSameExcept(rows,{
    fields:["agency_name","title_stem","vendor_name","contract_amount","pin","start_date"],
    except:["start_date"],
    threshold:3,
    normalize:(value,field,row)=>{
      if(field==="title_stem") return moneyAwardTitleStem(row);
      if(field==="contract_amount") return value==null||value===""?"":String(Number(value));
      if(field==="start_date") return String(value||"").slice(0,10);
      return value==null?"":String(value).trim().toLowerCase();
    },
  });
}
function bindMoneyListRowClicks(lineageRows=null){
  document.querySelectorAll("#list .row").forEach(el=>{
    el.addEventListener("click",event=>{
      if(event.target.closest?.("a,button")) return;
      const row=currentRows[+el.dataset.i];
      if(event.isTrusted&&!row?.request_id&&row?.canonical_href){ location.assign(row.canonical_href); return; }
      select(+el.dataset.i, el, event.isTrusted, event.isTrusted?null:(currentMoneyLineageRows || lineageRows));
    });
  });
}
async function enhanceMoneyAwardList(rows, terms){
  if(mode!=="award" || !rows.length) return;
  const grouping=await moneyPinSiblingGrouping();
  const review=await loadPinFamilyReview();
  const siblingEntries=grouping?.groupPinSiblingRows?.(rows,{review})
    || rows.map(item=>({kind:"item",item}));
  for(const entry of siblingEntries){
    if(entry.kind==="item" && entry.candidate) moneyPinCandidateByRow.set(entry.item, entry.candidate);
  }
  const leftover=siblingEntries.filter(entry=>entry.kind==="item").map(entry=>entry.item);
  const sameExcept=await consolidateMoneyAwardRows(leftover);
  const leftoverEntries=sameExcept || leftover.map(item=>({kind:"same-except-item",item}));
  const sameExceptByRow=new Map();
  for(const entry of leftoverEntries){
    if(entry.kind==="same-except-group"){
      for(const member of entry.members||[]) sameExceptByRow.set(member, entry);
    }else if(entry.item){
      sameExceptByRow.set(entry.item, entry);
    }
  }
  const emitted=new Set();
  const parts=[];
  for(const entry of siblingEntries){
    if(entry.kind==="related_instrument"){
      parts.push(moneyPinSiblingGroupHTML(entry, terms));
      continue;
    }
    const same=sameExceptByRow.get(entry.item);
    if(same?.kind==="same-except-group"){
      if(emitted.has(same)) continue;
      emitted.add(same);
      parts.push(moneyAwardGroupHTML(same, terms));
      continue;
    }
    const i=currentRows.indexOf(entry.item);
    parts.push(moneyRowHTML(entry.item, i>=0?i:0, terms));
  }
  const changed=siblingEntries.some(entry=>entry.kind==="related_instrument"||entry.candidate)
    || leftoverEntries.some(entry=>entry.kind==="same-except-group");
  if(!changed || !document.querySelector("#list")) return;
  $("#list").innerHTML=parts.join("");
  bindMoneyListRowClicks();
}
function renderList(autoSelect,lineageRows=null){
  if(!currentRows.length){
    // A stale or unavailable snapshot never resolves to "nothing found": that
    // claim belongs only to a successfully refreshed, sufficiently current
    // source that genuinely has no matching records.
    $("#list").innerHTML = scopedHistoryGap(currentRows)
      ? scopedHistoryNoteHTML(countWithScopeReceipt(0), 0, currentMoneyNarrowed)
      : currentMoneyFreshness && !currentMoneyFreshness.emptyStateEligible
        ? moneyStaleSourceNoticeHTML(currentMoneyFreshness)
        : '<div class="empty">' + t("nothing_found") + '</div>';
    $("#detail").innerHTML = "";
    selectedRFP=null;
    if(scopedHistoryGap(currentRows)) bindFullHistorySearch();
    return;
  }
  const kw = ($("#kw").value||"").trim(), terms = kw ? [kw] : [];
  const indexed=currentRows.map((row,index)=>({row,index}));
  if(mode==="allrfp"){
    const {current,closed}=partitionMoneyRows(currentRows);
    const parts=current.map(item=>moneyRowHTML(item.row,item.index,terms));
    if(closed.length){
      parts.push(`<div class="property-closed-section" role="separator"><h3 class="property-closed-section-title">${t("property_closed_section")}</h3></div>`);
      closed.forEach(item=>parts.push(moneyRowHTML(item.row,item.index,terms)));
    }
    $("#list").innerHTML=parts.join("");
  }else if(mode==="award"){
    $("#list").innerHTML = indexed.map(item=>moneyRowHTML(item.row,item.index,terms)).join("");
    enhanceMoneyAwardList(currentRows, terms).catch(()=>{});
  }else{
    $("#list").innerHTML = indexed.map(item=>moneyRowHTML(item.row,item.index,terms)).join("");
  }
  const keepId=autoSelect===false&&selectedRFP?(selectedRFP.procurement_id||selectedRFP.request_id):null;
  ensureMwbeListChipsReady().then((tools)=>{
    if(!tools || !document.querySelector("#list .row")) return;
    document.querySelectorAll("#list .row").forEach((el)=>{
      if(el.querySelector("[data-mwbe-list-chips]")) return;
      const r = currentRows[+el.dataset.i];
      if(!r || /award/i.test(r.type_of_notice_description||"") || procurementStagesForRow(r).length) return;
      const chips = solicitationListChipsHTML(r);
      if(!chips) return;
      const rmeta = el.querySelector(".rmeta");
      if(rmeta) rmeta.insertAdjacentHTML("afterend", chips);
    });
  }).catch(()=>{});
  document.querySelectorAll("#list .row").forEach(el=>el.addEventListener("click",event=>{
    if(event.target.closest?.("a,button")) return;
    const row=currentRows[+el.dataset.i];
    if(event.isTrusted&&!row?.request_id&&row?.canonical_href){ location.assign(row.canonical_href); return; }
      select(+el.dataset.i, el, event.isTrusted, event.isTrusted?null:(currentMoneyLineageRows || lineageRows));
  }));
  if(autoSelect===false&&keepId){
    const idx=currentRows.findIndex(r=>r&&(r.procurement_id||r.request_id)===keepId);
    if(idx>=0){
      const el=document.querySelector(`#list .row[data-i="${idx}"]`);
      if(el){ el.classList.add("sel"); selectedRFP=currentRows[idx]; }
      loadLineageBadges(currentMoneyLineageRows || lineageRows);
      return;
    }
  }
  if(autoSelect!==false) document.querySelector("#list .row")?.click();
  else if(!keepId){ selectedRFP=null; $("#detail").innerHTML=""; }
  loadLineageBadges(currentMoneyLineageRows || lineageRows);
}

const LINEAGE_MIN_STAGES = 2;
const LINEAGE_MAX_STAGES = 15;
function isBlanketChain(chain){
  return chain.length > 5 && chain.every((item) => item.type_of_notice_description === "Award");
}

function lineageChainKey(r){
  if(!usablePin(r.pin) || !r.agency_name) return null;
  return { pin: r.pin, base: pinBase(r.pin), agency_name: r.agency_name };
}
function lineageDedupeKey(k){ return (k.base||k.pin) + "|" + k.agency_name; }

function lineageBatchClauses(keys){
  return keys.map(k=>{
    const agency = `agency_name='${k.agency_name.replace(/'/g,"''")}'`;
    const pinClause = k.base
      ? `pin LIKE '${k.base.replace(/'/g,"''")}%'`
      : `pin='${k.pin.replace(/'/g,"''")}'`;
    return `(${pinClause} AND ${agency})`;
  });
}

function computeLineageBadgeCounts(rows, batchRows){
  const memo = new Map();
  return rows.map(r=>{
    const k = lineageChainKey(r);
    if(!k) return null;
    const dedupeKey = lineageDedupeKey(k);
    if(memo.has(dedupeKey)) return memo.get(dedupeKey);
    const stages = batchRows.filter(row => row.agency_name === k.agency_name &&
      (k.base ? String(row.pin||"").startsWith(k.base) : row.pin === k.pin));
    const n = (!isBlanketChain(stages) && stages.length >= LINEAGE_MIN_STAGES && stages.length <= LINEAGE_MAX_STAGES)
      ? stages.length : null;
    memo.set(dedupeKey, n);
    return n;
  });
}

async function loadLineageBadges(precomputedRows=null){
  const rows = currentRows;
  const keys = [], seenKeys = new Set();
  rows.forEach(r=>{
    const k = lineageChainKey(r);
    if(!k) return;
    const dedupeKey = lineageDedupeKey(k);
    if(seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);
    keys.push(k);
  });
  if(!keys.length) return;
  let batchRows=Array.isArray(precomputedRows)
    ? precomputedRows.filter(row=>row.type_of_notice_description==="Award"||row.type_of_notice_description==="Intent to Award")
    : null;
  if(!batchRows){
    try{
      const snapshotRows=await residentMoneyRows();
      batchRows=snapshotRows.filter(row=>row.type_of_notice_description==="Award"||row.type_of_notice_description==="Intent to Award");
    }catch(e){ return; }
  }
  if(currentRows !== rows) return;
  const counts = computeLineageBadgeCounts(rows, batchRows);
  document.querySelectorAll("#list .row").forEach(el=>{
    const n = counts[+el.dataset.i];
    if(!n) return;
    const slot = el.querySelector(".lineage-slot");
    if(slot) slot.outerHTML = `<span class="tag renewal">${tn("history_cycles_tag", n, {n})}</span>`;
  });
}

async function select(i, el, planningDetailRequested=false, precomputedRows=null){
  const historyReady = globalThis.ensureMoneyHistory?.();
  document.querySelectorAll("#list .row.sel").forEach(e=>e.classList.remove("sel"));
  el.classList.add("sel");
  const r = currentRows[i];
  if(planningDetailRequested) r.planning_detail_requested = true;
  selectedRFP = r;
  if(!r?.request_id&&r?.canonical_href){ $("#detail").innerHTML=""; return; }
  if(typeof globalThis.renderDetail === "function") renderDetail(r, null, null, planningDetailRequested);
  else {
    const detail = $("#detail");
    detail.innerHTML = `<div id="dforecast" data-export-class="agency_forecast"><div class="chain-h">${t("agency_forecast_heading")}</div><div class="note"><span class="loading"></span></div></div>`;
  }
  globalThis.agencyForecastTeaser?.(r, $("#dforecast"));
  await historyReady;
  if(selectedRFP !== r) return;
  if(planningDetailRequested) await globalThis.ensureRules?.();
  if(typeof globalThis.renderDetail === "function") renderDetail(r, null, null, planningDetailRequested);
  globalThis.agencyForecastTeaser?.(r, $("#dforecast"));
  const [hydrated, chain, stats] = await Promise.all([
    hydrateMoneyActionLocationRow(r),
    loadChain(r,precomputedRows),
    loadAgencyStats(r.agency_name,null,precomputedRows),
  ]);
  if(selectedRFP !== r) return;
  selectedRFP=hydrated;
  renderDetail(hydrated, chain, stats, planningDetailRequested);
}

async function hydrateMoneyActionLocationRow(r){
  if(!r?._action_location_match) return r;
  return globalThis.MoneyActionLocations?.hydrateMoneyActionLocationRow?.(r)||r;
}

const RENEWAL_SUFFIX_RE = /R0\d+$/;
function pinBase(pin){
  const s = String(pin||"").trim();
  const m = s.match(RENEWAL_SUFFIX_RE);
  return m ? s.slice(0, m.index) : null;
}
async function loadChain(r,precomputedRows=null){
  if(!usablePin(r.pin)) return [r];
  try{
    const sourceRows=Array.isArray(precomputedRows)?precomputedRows:await residentMoneyRows();
    const rows=moneyLineageRows(sourceRows,r);
    rows.sort((a,b)=> (a.start_date||"").localeCompare(b.start_date||"") ||
      (STAGE_RANK[a.type_of_notice_description]??9) - (STAGE_RANK[b.type_of_notice_description]??9));
    return rows.length ? rows : [r];
  }catch(e){ return [r]; }
}

globalThis.LINEAGE_MAX_STAGES = LINEAGE_MAX_STAGES;
globalThis.LINEAGE_MIN_STAGES = LINEAGE_MIN_STAGES;
globalThis.RENEWAL_SUFFIX_RE = RENEWAL_SUFFIX_RE;
globalThis.computeLineageBadgeCounts = computeLineageBadgeCounts;
globalThis.lineageBatchClauses = lineageBatchClauses;
globalThis.lineageChainKey = lineageChainKey;
globalThis.lineageDedupeKey = lineageDedupeKey;
globalThis.loadAgencies = loadAgencies;
globalThis.loadChain = loadChain;
globalThis.loadLineageBadges = loadLineageBadges;
globalThis.loadMethodFacet = loadMethodFacet;
globalThis.loadMoneyDefaultSnapshot = loadMoneyDefaultSnapshot;
globalThis.loadMoneyAgenciesSnapshot = loadMoneyAgenciesSnapshot;
globalThis.loadMoneyResidentSnapshot = loadMoneyResidentSnapshot;
globalThis.residentMoneyRows = residentMoneyRows;
globalThis.initializeMoneyLocationFilters = initializeMoneyLocationFilters;
globalThis.isDefaultMoneySearchState = isDefaultMoneySearchState;
globalThis.moneyActiveFilterChip = moneyActiveFilterChip;
globalThis.moneyListPrimaryAction = moneyListPrimaryAction;
globalThis.moneyListPrimaryActionHTML = moneyListPrimaryActionHTML;
globalThis.moneyListInteractionProjection = moneyListInteractionProjection;
globalThis.moneyListCardInteractionsHTML = moneyListCardInteractionsHTML;
globalThis.moneyRowIsClosed = moneyRowIsClosed;
globalThis.moneyRowHTML = moneyRowHTML;
globalThis.paintMoneyRows = paintMoneyRows;
globalThis.partitionMoneyRows = partitionMoneyRows;
globalThis.pinBase = pinBase;
globalThis.renderList = renderList;
globalThis.renderMoneyActiveFilters = renderMoneyActiveFilters;
globalThis.search = search;
globalThis.select = select;
globalThis.updateMoneyMoreFiltersState = updateMoneyMoreFiltersState;
globalThis.weekOutISO = weekOutISO;
Object.defineProperty(globalThis, "closingWeek", { configurable: true, get: () => closingWeek, set: value => { closingWeek = value; } });
Object.defineProperty(globalThis, "currentRows", { configurable: true, get: () => currentRows, set: value => { currentRows = value; } });
Object.defineProperty(globalThis, "methodSel", { configurable: true, get: () => methodSel, set: value => { methodSel = value; } });
Object.defineProperty(globalThis, "mode", { configurable: true, get: () => mode, set: value => { mode = value; } });
Object.defineProperty(globalThis, "moneyLoaded", { configurable: true, get: () => moneyLoaded, set: value => { moneyLoaded = value; } });
Object.defineProperty(globalThis, "moneyNlResolved", { configurable: true, get: () => moneyNlResolved, set: value => { moneyNlResolved = value; } });
Object.defineProperty(globalThis, "moneyLocationFilter", { configurable: true, get: () => moneyLocationFilter, set: value => { moneyLocationFilter = value; } });
Object.defineProperty(globalThis, "selectedRFP", { configurable: true, get: () => selectedRFP, set: value => { selectedRFP = value; } });
