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
  filterMoneySnapshot,
  moneyLineageRows,
  moneyMethodFacet,
  moneySnapshotRows,
} from "../resident_snapshot_queries.mjs";

const MONEY_DEFAULT_SNAPSHOT_URL="data/money_default_open.json";
const MONEY_AGENCIES_SNAPSHOT_URL="data/money_procurement_agencies.json";
const MONEY_RESIDENT_SNAPSHOT_URL="data/money_resident_snapshot.json";
let moneyDefaultSnapshotPromise=null,moneyAgenciesSnapshotPromise=null,moneyResidentSnapshotPromise=null,moneyActionLocationToolsPromise=null;
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
async function residentMoneyRows(){
  return moneySnapshotRows(await loadMoneyResidentSnapshot());
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

let currentRows = [], mode = "open", selectedRFP = null, closingWeek = false, moneyLoaded = false, methodSel = "";
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
async function search(){
  const forceFullHistory = forceFullHistorySearch;
  forceFullHistorySearch = false;
  moneyLoaded = true;
  mode = $("#mode").value;
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
      t,agency:$("#agency").value,query:$("#kw").value,paintMoneyRows,
    });
    return;
  }

  const {category=null, maxAmount=null, months=null, excludeSpecial=false} = moneyNlResolved;
  updateHash();
  syncProcurementFacetRails();
  const heads = {
    open:t("head_open"), allrfp:t("head_allrfp"), award:t("head_award"), archive:t("head_archive"),
  };
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
    const snapshotRows=defaultSearch
      ? filterStillOpenMoneyNotices(snapshot?.notices,todayISO())
      : moneySnapshotRows(snapshot);
    const common={
      mode,agency,keyword:kw,closingWeek,minAmount:minamt||null,maxAmount,category,months,
      excludeSpecial,sort,today:todayISO(),weekEnd:weekOutISO(),
      monthEnd:months?addMonthsISO(todayISO(),months):null,
    };
    const facetRows=filterMoneySnapshot(snapshotRows,{...common,method:"",limit:snapshotRows.length});
    loadMethodFacet(facetRows);
    const rows=methodSel
      ? filterMoneySnapshot(snapshotRows,{...common,method:methodSel,limit:40})
      : facetRows.slice(0,40);
    if(stale()) return;
    paintMoneyRows(rows,{
      autoSelect:true,
      narrowed:false,
      lineageRows:snapshotRows,
    });
  }catch(e){
    if(stale()) return;
    unbusy("#list");
    $("#list").innerHTML = '<div class="empty">' + t("retry_open_data") + '</div>';
    $("#detail").innerHTML = "";
    return;
  }
}
function paintMoneyRows(rows, {autoSelect=true, narrowed=false, lineageRows=null}={}){
  currentRows = rows;
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
}

function loadMethodFacet(rows){
  const el = $("#methodfacet");
  const primary = $("#money-method-primary");
  try{
    const facets=moneyMethodFacet(rows);
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
  const presentation=moneyListPrimaryAction(r,today);
  const kineticActions=presentation ? [{
    label:t(presentation.label_key),
    href:presentation.href,
    kind:presentation.action.type,
    context_ready:true,
    primary:true,
  }] : [];
  return objectCardInteractionProjection({
    target:requestId ? {
      href:`/notices/${encodeURIComponent(requestId)}`,
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
  const isAward = r.type_of_notice_description === "Award";
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
        ${usablePin(r.pin)? `<span class="pin">PIN ${r.pin}</span>` : `<span class="pin muted">${t("no_linkable_pin")}</span>`}</p>
      ${mwbeChips}
      ${actionLocationChip}
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
    consolidateMoneyAwardRows(currentRows).then((entries)=>{
      if(!entries || !document.querySelector("#list")) return;
      if(!entries.some((entry)=>entry.kind==="same-except-group")) return;
      const parts=entries.map((entry)=>{
        if(entry.kind==="same-except-group") return moneyAwardGroupHTML(entry, terms);
        const row=entry.item||entry;
        const i=currentRows.indexOf(row);
        return moneyRowHTML(row, i>=0?i:0, terms);
      });
      $("#list").innerHTML=parts.join("");
    }).catch(()=>{});
  }else{
    $("#list").innerHTML = indexed.map(item=>moneyRowHTML(item.row,item.index,terms)).join("");
  }
  const keepId=autoSelect===false&&selectedRFP?selectedRFP.request_id:null;
  ensureMwbeListChipsReady().then((tools)=>{
    if(!tools || !document.querySelector("#list .row")) return;
    document.querySelectorAll("#list .row").forEach((el)=>{
      if(el.querySelector("[data-mwbe-list-chips]")) return;
      const r = currentRows[+el.dataset.i];
      if(!r || /award/i.test(r.type_of_notice_description||"")) return;
      const chips = solicitationListChipsHTML(r);
      if(!chips) return;
      const rmeta = el.querySelector(".rmeta");
      if(rmeta) rmeta.insertAdjacentHTML("afterend", chips);
    });
  }).catch(()=>{});
  document.querySelectorAll("#list .row").forEach(el=>el.addEventListener("click",event=>{
    if(event.target.closest?.("a,button")) return;
    select(+el.dataset.i, el, event.isTrusted, event.isTrusted?null:lineageRows);
  }));
  if(autoSelect===false&&keepId){
    const idx=currentRows.findIndex(r=>r&&r.request_id===keepId);
    if(idx>=0){
      const el=document.querySelector(`#list .row[data-i="${idx}"]`);
      if(el){ el.classList.add("sel"); selectedRFP=currentRows[idx]; }
      loadLineageBadges(lineageRows);
      return;
    }
  }
  if(autoSelect!==false) document.querySelector("#list .row")?.click();
  else if(!keepId){ selectedRFP=null; $("#detail").innerHTML=""; }
  loadLineageBadges(lineageRows);
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
