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
  procurementStagesForRow,
  vendorStemsFromEntityRefs,
} from "../resident_snapshot_queries.mjs";
import { mergeCanonicalProcurementBrowseRows, mergeContractSearchRows } from "../contract_search_bridge.mjs";
import { renderProcurementRowCoverageHtml } from "../procurement_coverage_labels.mjs";
import {
  ANALYTICAL_PROJECTION_URL,
  analyticalDrillThroughHref,
  filterAnalyticalContracts,
  formatRegisteredValue,
  groupAnalyticalContracts,
  populationSummary,
} from "../analytical_projection.mjs";

const MONEY_DEFAULT_SNAPSHOT_URL="data/money_default_open.json";
const MONEY_AGENCIES_SNAPSHOT_URL="data/money_procurement_agencies.json";
const MONEY_RESIDENT_SNAPSHOT_URL="data/money_resident_snapshot.json";
const MONEY_PROCUREMENT_SNAPSHOT_URL="data/procurement_browse_rows.json";
const MONEY_PROCUREMENT_QUERY_URL="data/procurement_browse_query.json";
const PIN_FAMILY_REVIEW_URL="data/pin_family_mismatch_review.json";
let moneyDefaultSnapshotPromise=null,moneyAgenciesSnapshotPromise=null,moneyResidentSnapshotPromise=null,moneyActionLocationToolsPromise=null,moneyPinSiblingPromise=null,pinFamilyReviewPromise=null;
let analyticalProjectionPromise=null;
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
    analyticalProjectionPromise=fetch(ANALYTICAL_PROJECTION_URL)
      .then(r=>r.ok?r.json():null)
      .catch(()=>null);
  }
  return analyticalProjectionPromise;
}
async function residentMoneyRows(){
  return moneySnapshotRows(await loadMoneyResidentSnapshot());
}
async function loadContractSearchDocuments(query, identity=null){
  const lexical=String(query||"").replace(/\s+/g," ").trim().slice(0,240);
  const params=new URLSearchParams();
  if(identity){
    params.set("object_ref",identity.object_ref);
    params.set("source_ref",identity.source_observation_ref);
  }else if(lexical){
    params.set("q",lexical);
  }else return [];
  const key=params.toString();
  if(!contractSearchDocumentPromises.has(key)){
    contractSearchDocumentPromises.set(key,workerFetch(`/search?${key}`,null,SLOW_MS)
      .then(async response=>{
        if(!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload=await response.json();
        return Array.isArray(payload?.results)?payload.results:[];
      })
      .catch(()=>[]));
  }
  return contractSearchDocumentPromises.get(key);
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
function filterStillOpenMoneyNotices(rows, today){
  const floor=String(today||(typeof todayISO==="function"?todayISO():new Date().toISOString().slice(0,10))).slice(0,10);
  return (rows||[]).filter(r=>{
    const due=String(r&&r.due_date||"").slice(0,10);
    return due && due>floor;
  });
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
    agency: params.get("ap_agency") || null,
    prime_vendor: params.get("ap_vendor") || null,
    registration_fiscal_year: params.get("ap_fy") || null,
    contract_amount_band: params.get("ap_amount_band") || null,
    min_amount: params.get("ap_min") || null,
    max_amount: params.get("ap_max") || null,
  };
}

function analyticalControlsFilters(){
  return {
    registration_fiscal_year: $("#analytics-fy")?.value || null,
    min_amount: $("#analytics-min")?.value || null,
    max_amount: $("#analytics-max")?.value || null,
  };
}

function syncAnalyticalFiscalYears(rows){
  const select=$("#analytics-fy");
  if(!select) return;
  const current=select.value;
  const years=[...new Set((rows||[]).map(row=>row.registration_fiscal_year).filter(Number.isInteger))].sort((a,b)=>b-a);
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
    contract_amount: row.current_registered_amount,
    start_date: row.registration_date,
    type_of_notice_description: t("analytics_registered_contract_type"),
    procurement_stages: ["registered"],
    primary_stage: "registered",
    source_system: "analytics_registered_contracts",
    analytics_projection: true,
  };
}

function analyticalGroupLabel(groupBy){
  return groupBy === "vendor" ? t("analytics_group_vendor").toLowerCase() : t("analytics_group_agency").toLowerCase();
}

function analyticalMeasureLabel(measure){
  return measure === "original" ? t("analytics_measure_original") : measure === "count" ? t("analytics_measure_count") : t("analytics_measure_current");
}

function renderAnalyticalProjection(rows){
  const panel=$("#contracts-analytics");
  if(!panel) return;
  panel.hidden=mode!=="award";
  if(mode!=="award") return;
  const projection=Array.isArray(rows) ? { rows } : (rows || {});
  const projectionRows=Array.isArray(projection.rows) ? projection.rows : [];
  syncAnalyticalFiscalYears(projectionRows);
  const urlFilters=analyticalUrlFilters();
  const controls=analyticalControlsFilters();
  if(urlFilters.registration_fiscal_year && [...($("#analytics-fy")?.options || [])].some((option)=>option.value===urlFilters.registration_fiscal_year)) $("#analytics-fy").value=urlFilters.registration_fiscal_year;
  const filters={...controls, agency:urlFilters.agency, prime_vendor:urlFilters.prime_vendor, contract_amount_band:urlFilters.contract_amount_band};
  // A drill-through scope is authoritative for the population shown in the
  // ordinary list, while the panel still lets the reader change its grouping.
  if(urlFilters.registration_fiscal_year) filters.registration_fiscal_year=urlFilters.registration_fiscal_year;
  if(urlFilters.min_amount) filters.min_amount=urlFilters.min_amount;
  if(urlFilters.max_amount) filters.max_amount=urlFilters.max_amount;
  const filtered=filterAnalyticalContracts(projectionRows,filters);
  const summary=populationSummary(filtered,{snapshot_date:projection.snapshot_date,population_definition:projection.population_definition});
  const groupBy=$("#analytics-group")?.value||"agency";
  const measure=$("#analytics-measure")?.value||"current";
  const grouped=groupAnalyticalContracts(filtered,{groupBy,measure,topN:10});
  const measureLabel=analyticalMeasureLabel(measure);
  const population=$("#contracts-analytics-population");
  if(population){
    const headline=measure==="count"
      ? t("analytics_population_count",{count:summary.contract_count.toLocaleString("en-US")})
      : t("analytics_population_value",{value:formatRegisteredValue(measure==="original" ? filtered.reduce((sum,row)=>sum+(Number(row.original_registered_amount)||0),0) : summary.current_registered_value),measure:measureLabel.toLowerCase(),count:summary.contract_count.toLocaleString("en-US")});
    population.textContent=`${headline} · ${summary.year_label}. ${t("analytics_population_suffix")}`;
  }
  const list=$("#contracts-analytics-groups");
  if(!list) return;
  list.innerHTML=grouped.shown_groups.map((group,index)=>{
    const href=analyticalDrillThroughHref({
      [groupBy==="vendor"?"prime_vendor":"agency"]: group.label,
      registration_fiscal_year: filters.registration_fiscal_year,
      min_amount: filters.min_amount,
      max_amount: filters.max_amount,
    });
    const value=measure==="count" ? `${group.contract_count.toLocaleString("en-US")} ${t("analytics_contracts_unit")}` : `${formatRegisteredValue(group[valueKeyForMeasure(measure)])} ${measureLabel.toLowerCase()}`;
    return `<li class="contracts-analytics-group"><a href="${escUiHtml(href)}" data-analytics-drill-through="${escUiHtml(group.label)}">${index+1}. ${escUiHtml(group.label)}</a><span class="contracts-analytics-group-meta">${escUiHtml(value)} · <span>${group.contract_count.toLocaleString("en-US")} ${t("analytics_contracts_unit")}</span></span></li>`;
  }).join("");
  const remaining=grouped.groups.length-grouped.shown_groups.length;
  const note=$("#contracts-analytics-note");
  if(note) note.textContent=remaining>0
    ? t("analytics_rank_note",{n:grouped.shown_groups.length,group:analyticalGroupLabel(groupBy),measure:measureLabel.toLowerCase(),remaining:remaining.toLocaleString("en-US")})
    : t("analytics_group_exact_note");
}

function valueKeyForMeasure(measure){
  return measure==="original" ? "sum_original_registered_amount" : measure==="count" ? "contract_count" : "sum_current_registered_amount";
}

function bindAnalyticalControls(){
  ["#analytics-group","#analytics-measure","#analytics-fy","#analytics-min","#analytics-max"].forEach((selector)=>{
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
    return;
  }

  const {category=null, maxAmount=null, months=null, excludeSpecial=false} = moneyNlResolved;
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
  try{
    const defaultSearch=isDefaultMoneySearchState({
      mode,agency,kw,methodSel,closingWeek,minAmount:minamt,sort,nlResolved:moneyNlResolved,
    });
    const snapshot=defaultSearch
      ? await loadMoneyDefaultSnapshot()
      : await loadMoneyResidentSnapshot();
    const retainedRows=defaultSearch
      ? filterStillOpenMoneyNotices(snapshot?.notices,todayISO())
      : moneySnapshotRows(snapshot);
    const activeFacetValues=globalThis.CROL_ACTIVE_SCOPE_FACET_VALUES||{};
    const entityRefs=Array.isArray(activeFacetValues.entity_refs_all)
      ? activeFacetValues.entity_refs_all
      : [];
    const contractIdentity=contractIdentityFromFacetValues(activeFacetValues);
    const scopedVendorStem=vendorStemsFromEntityRefs(entityRefs)[0]||"";
    const retrievalQuery=kw||scopedVendorStem;
    const searchDocuments=((contractIdentity||retrievalQuery)&&(mode==="award"||mode==="archive"))
      ? await loadContractSearchDocuments(retrievalQuery,contractIdentity)
      : [];
    const searchedRows=mergeContractSearchRows(retainedRows,searchDocuments);
    const common={
      mode,agency,keyword:kw,closingWeek,minAmount:minamt||null,maxAmount,category,months,
      excludeSpecial,entityRefs,contractObjectRef:contractIdentity?.object_ref||"",sort,today:todayISO(),weekEnd:weekOutISO(),
      monthEnd:months?addMonthsISO(todayISO(),months):null,
    };
    const canonicalSnapshot=(mode==="award"||mode==="archive")
      ? await loadMoneyProcurementSnapshot({...common,method:methodSel},searchedRows)
      : {rows:[],facets:{},hydrate:Promise.resolve({rows:[]})};
    const snapshotRows=(mode==="award"||mode==="archive")
      ? (canonicalSnapshot?.rows || [])
      : retainedRows;
    const analyticsProjection = mode === "award" ? await loadAnalyticalProjection() : null;
    bindAnalyticalControls();
    if (analyticsProjection) renderAnalyticalProjection(analyticsProjection);
    const analyticalScope = mode === "award" ? analyticalUrlFilters() : {};
    const analyticalScopeActive = Object.values(analyticalScope).some((value) => value != null && value !== "");
    const analyticalScopeRows = analyticalScopeActive
      ? filterAnalyticalContracts(analyticsProjection?.rows || [], analyticalScope).map(analyticalMoneyRow)
      : null;
    if (analyticalScopeActive) {
      if (stale()) return;
      paintMoneyRows(analyticalScopeRows.slice(0, 40), {
        autoSelect: false,
        lineageRows: analyticalScopeRows,
        rumInteraction,
      });
      return;
    }
    const facetRows=(mode==="award"||mode==="archive")
      ? snapshotRows
      : filterMoneySnapshot(snapshotRows,{...common,method:"",limit:snapshotRows.length});
    loadMethodFacet(facetRows,(mode==="award"||mode==="archive") ? canonicalSnapshot?.facets?.method : null);
    const rows=(mode==="award"||mode==="archive")
      ? snapshotRows.slice(0,40)
      : methodSel
        ? filterMoneySnapshot(snapshotRows,{...common,method:methodSel,limit:40})
        : facetRows.slice(0,40);
    if(stale()) return;
    paintMoneyRows(rows,{
      autoSelect:true,
      narrowed:false,
      lineageRows:snapshotRows,
      rumInteraction,
    });
    const hydration=typeof canonicalSnapshot?.hydrate === "function" ? canonicalSnapshot.hydrate() : canonicalSnapshot?.hydrate;
    Promise.resolve(hydration)?.then((hydrated)=>{
      if(stale() || !Array.isArray(hydrated?.rows)) return;
      currentMoneyLineageRows=mergeCanonicalProcurementBrowseRows(searchedRows,hydrated.rows);
      loadLineageBadges(currentMoneyLineageRows);
    }).catch(()=>{});
  }catch(e){
    if(stale()) return;
    unbusy("#list");
    $("#list").innerHTML = '<div class="empty">' + t("retry_open_data") + '</div>';
    $("#detail").innerHTML = "";
    reportContractsRumResults(rumInteraction,"unavailable");
    return;
  }
}
function paintMoneyRows(rows, {autoSelect=true, narrowed=false, lineageRows=null,rumInteraction=null}={}){
  currentRows = rows;
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
  reportContractsRumResults(rumInteraction,currentRows.length?"content":"empty");
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
  const agencyMention=listEntityMentionHTML({kind:"agency",value:r.agency_name,escape:escUiHtml,relation:"publishes_record"});
  const vendorMention=r.vendor_name?listEntityMentionHTML({kind:"vendor",value:r.vendor_name,escape:escUiHtml,relation:"named_vendor"}):"";
  const projectMention=r.project_id?listEntityMentionHTML({kind:"project",value:r.project_id,label:r.project_name||r.project_id,escape:escUiHtml,relation:"names_project"}):"";
  return `<article class="money-row-card">
      <div class="row" data-i="${i}" tabindex="0" role="group">
      ${interactions||`<p class="rtitle">${digTitleHTML(title,ev)}</p>`}
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
    $("#list").innerHTML = scopedHistoryGap(currentRows)
      ? scopedHistoryNoteHTML(countWithScopeReceipt(0), 0, currentMoneyNarrowed)
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
globalThis.filterStillOpenMoneyNotices = filterStillOpenMoneyNotices;
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
