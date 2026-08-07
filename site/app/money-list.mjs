import { noticeDisplayTitle } from "../display_title.mjs";
import { resolveAgencyIdentity } from "../agency_identity.mjs";
import { scopedHistoryGap as hasScopedHistoryGap } from "../money_scope_consistency.mjs";

const MONEY_DEFAULT_SNAPSHOT_URL="data/money_default_open.json";
const MONEY_AGENCIES_SNAPSHOT_URL="data/money_procurement_agencies.json";
let moneyDefaultSnapshotPromise=null,moneyAgenciesSnapshotPromise=null,moneyActionLocationToolsPromise=null;
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
  if (!["open", "allrfp", "award"].includes(modeKey)) return "";
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
function syncProcurementFacetRails(){
  const activeMode = ["open", "allrfp", "award"].includes(String($("#mode")?.value || ""))
    ? String($("#mode").value)
    : "open";
  const scope = currentMoneyRouteScope();
  const modeRail = document.getElementById(["money", "mode", "rail"].join("-"));
  modeRail?.querySelectorAll("a").forEach((link) => {
    const modeKey = link.dataset.moneyMode;
    if (!modeKey) return;
    link.href = moneyModeHref(modeKey, scope);
    const active = modeKey === activeMode;
    link.classList.toggle("on", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const activeBasis = moneyLocationFilter.layer === "contract_action_address"
    ? (moneyLocationFilter.basis || "contract_action_address")
    : "";
  const locationRail = document.getElementById(["money", "location", "rail"].join("-"));
  locationRail?.querySelectorAll("a").forEach((link) => {
    const basis = link.dataset.moneyLocationBasis;
    if (!basis) return;
    const active = basis === activeBasis;
    link.classList.toggle("on", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}
async function initializeMoneyLocationFilters(){
  const tools=await moneyActionLocationTools();
  return tools?.initializeMoneyLocationFilters?.({t});
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
  let paintedFromSnapshot=false;
  try{
    const snap=await loadMoneyAgenciesSnapshot();
    const names=snap&&Array.isArray(snap.agencies)?snap.agencies:[];
    if(names.length){
      paintMoneyAgencyOptions(names);
      paintedFromSnapshot=true;
    }
  }catch(e){}
  try{
    const rows = await soda({"$select":"agency_name","$where":"section_name='Procurement' AND agency_name IS NOT NULL",
      "$group":"agency_name","$order":"agency_name","$limit":"600"});
    paintMoneyAgencyOptions(rows.map(r=>r.agency_name));
  }catch(e){
    if(!paintedFromSnapshot) $("#agency").innerHTML = `<option value="">${t("all_agencies")}</option>`;
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
    const label = value==="award" ? t("nl_filter_award") : value==="allrfp" ? t("head_allrfp") : t("nl_filter_open_rfp");
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
    noticeType:mode==="award"?"award":mode==="allrfp"?"allrfp":"solicitation",
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
  if(mode !== "open" && closingWeek){ closingWeek = false; $("#closingweek").classList.remove("on"); $("#closingweek").setAttribute("aria-pressed","false"); }
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

  let where = mode === "award" ? "type_of_notice_description='Award'" : "type_of_notice_description='Solicitation'";
  if(mode === "open") where += ` AND due_date > '${todayISO()}'`;
  if(mode === "open" && closingWeek) where += ` AND due_date <= '${weekOutISO()}'`;
  if(agency) where += ` AND agency_name='${agency.replace(/'/g,"''")}'`;
  if(mode === "award" && minamt) where += ` AND contract_amount >= ${minamt} AND contract_amount < ${MONEY_HONESTY_CAP}`;
  const {category=null, maxAmount=null, months=null, excludeSpecial=false} = moneyNlResolved;
  if(category) where += ` AND category_description='${category.replace(/'/g,"''")}'`;
  if(mode === "award" && maxAmount) where += ` AND contract_amount <= ${maxAmount}`;
  if(mode === "open" && months) where += ` AND due_date <= '${addMonthsISO(todayISO(), months)}'`;
  if(excludeSpecial) where += ` AND selection_method_description NOT LIKE '%Special%'`;
  const facetWhere = where;
  if(methodSel) where += ` AND selection_method_description='${methodSel.replace(/'/g,"''")}'`;

  let order;
  if(sort === "amount") order = "contract_amount DESC";
  else if(sort === "newest") order = "start_date DESC";
  else order = mode === "award" ? "start_date DESC" : mode === "allrfp" ? "due_date DESC" : "due_date ASC";

  updateHash();
  syncProcurementFacetRails();
  loadMethodFacet(facetWhere, kw);
  const heads = {open:t("head_open"), allrfp:t("head_allrfp"), award:t("head_award")};
  $("#reshead").textContent = heads[mode] + (mode==="open" && closingWeek ? t("head_closing_this_week") : "") + (methodSel ? " · " + methodSel : "") + (agency ? " · " + agency : "");
  $("#rescount").textContent = "";
  busyList("#list");
  const stale = staleGuard("money");
  const useDefaultSnapshot=isDefaultMoneySearchState({
    mode, agency, kw, methodSel, closingWeek, minAmount:minamt, sort, nlResolved:moneyNlResolved,
  });
  let paintedFromSnapshot=false;
  if(useDefaultSnapshot){
    try{
      const snap=await loadMoneyDefaultSnapshot();
      if(stale()) return;
      const notices=filterStillOpenMoneyNotices(snap&&Array.isArray(snap.notices)?snap.notices:[], todayISO());
      if(notices.length){
        paintMoneyRows(notices, {autoSelect:true, narrowed:false});
        paintedFromSnapshot=true;
      }
    }catch(e){}
  }
  const p = {"$select":SELECT,"$where":where,"$order":order,"$limit":"40"};
  if(kw) p["$q"] = kw;
  let narrowed = false, rows;
  try{
    try{
      rows = await soda(p, forceFullHistory ? SLOW_MS * 3 : SLOW_MS);
    }catch(err){
      if(err.name !== "AbortError") throw err;
      narrowed = true;
      rows = await soda({...p, "$where": where + " AND start_date > '" + recentCut() + "'"}, SLOW_MS + 4000);
    }
  }catch(e){
    if(stale()) return;
    if(!paintedFromSnapshot){
      unbusy("#list");
      $("#list").innerHTML = '<div class="empty">' + t("retry_open_data") + '</div>';
      $("#detail").innerHTML = "";
    }
    return;
  }
  if(stale()) return;
  paintMoneyRows(rows, {autoSelect:!paintedFromSnapshot, narrowed});
}
function paintMoneyRows(rows, {autoSelect=true, narrowed=false}={}){
  currentRows = rows;
  currentMoneyNarrowed = narrowed;
  setExportBandVisibility(currentRows.length, "money-export-band", "money-export-overflow");
  unbusy("#list");
  const receiptCount=countWithScopeReceipt(currentRows.length);
  const hasReceipt=receiptCount!==currentRows.length;
  const countText=receiptCount===1?t("one_result"):t(!hasReceipt&&currentRows.length===40?"or_more_results":"results_count",{n:receiptCount});
  $("#rescount").textContent = countText;
  announce(countText + ` — ${$("#reshead").textContent}`);
  renderList(autoSelect);
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

async function loadMethodFacet(where, kw){
  const el = $("#methodfacet");
  const primary = $("#money-method-primary");
  try{
    const p = {"$select":"selection_method_description, count(1) as n",
      "$where": where + " AND selection_method_description IS NOT NULL",
      "$group":"selection_method_description","$order":"n DESC","$limit":"7"};
    if(kw) p["$q"] = kw;
    const rows = (await soda(p)).filter(r=>r.selection_method_description && r.selection_method_description.trim());
    if(rows.length < 2 && !methodSel){
      el.innerHTML="";
      primary.hidden=true;
      return;
    }
    primary.hidden=false;
    el.innerHTML = rows.map(r=>{
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

// moneyRowHTML: one Money/Contracts result row -- same title-highlight/evidence-line reuse of
// matchEvidence()/digTitleHTML()/digEvidenceHTML() as the Alerts-page ask preview's digItemHTML().
// terms is [] for plain browsing (no #kw typed), so matchEvidence returns null and the row
// renders exactly as it did before this existed.
//
// Solicitation M/WBE chips: pure extract from list fields (selection_method + body chunk).
// Default 20-day floors stay off the list; only distinctive method/goal markers show.
// Named distinctly from procurement-phase ensureMwbeGoalSurfaceTools so the
// reconstructed inline script (module-dom-equivalence) does not double-declare.
let moneyListMwbeSurfacePromise = null;
function moneyListMwbeSurfaceTools(){
  if(!moneyListMwbeSurfacePromise){
    moneyListMwbeSurfacePromise = import("../mwbe_goal_surface.mjs").catch(() => null);
  }
  return moneyListMwbeSurfacePromise;
}
function solicitationListChipsHTML(r){
  // Sync path uses cached module when already loaded; otherwise empty until async patch.
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
// List presentation adapter over the one existing procurement interpretation path.
// noticeActionMatter owns notice classification and compileActionRail owns deadline /
// destination rules; this function only chooses whether that primary rail action is
// eligible for the compact Money-row surface.
function moneyListPrimaryAction(r, today=todayISO()){
  if(!globalThis.CrolActions || typeof CrolActions.compileActionRail!=="function") return null;
  if(typeof globalThis.noticeActionMatter!=="function") return null;
  try{
    const matter=globalThis.noticeActionMatter(r);
    if(!matter || (matter.kind!=="solicitation"&&matter.kind!=="award")) return null;
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
function moneyListPrimaryActionHTML(r, today=todayISO()){
  const presentation=moneyListPrimaryAction(r,today);
  if(!presentation) return "";
  const label=t(presentation.label_key);
  const title=noticeDisplayTitle(r);
  const attrs=presentation.external?` ${EXT_ATTRS}`:"";
  return `<a class="act primary money-row-action" data-money-row-action="${presentation.kind}" data-action-delivery="${presentation.action.delivery}" href="${escUiHtml(presentation.href)}"${attrs}>${escUiHtml(label)}<span class="sr-only" lang="en" dir="ltr"> — ${escUiHtml(title)}</span>${presentation.external?extSR():""}</a>`;
}
function moneyRowHTML(r, i, terms){
  const isAward = r.type_of_notice_description === "Award";
  const lead = isAward
    ? (money(r.contract_amount) ? `<span class="tag amt">${money(r.contract_amount)}</span>` : "")
    : deadlineTag(r.due_date);
  const title = noticeDisplayTitle(r), ev = matchEvidence(title, matchText(r), terms);
  const mwbeChips = !isAward ? solicitationListChipsHTML(r) : "";
  const actionLocationChip=globalThis.MoneyActionLocations?.moneyActionLocationChipHTML?.(r,{t,esc:escUiHtml})||"";
  const primaryAction=moneyListPrimaryActionHTML(r);
  return `<article class="money-row-card">
      ${primaryAction}
      <div class="row" data-i="${i}" tabindex="0" role="button">
      <p class="rtitle">${digTitleHTML(title, ev)}</p>
      <p class="rmeta">${lead}<span class="lineage-slot"></span><span class="ragency" lang="en" dir="ltr">${r.agency_name||""}</span> · ${fdate(r.start_date)}
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
function renderList(autoSelect){
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
  }else{
    $("#list").innerHTML = indexed.map(item=>moneyRowHTML(item.row,item.index,terms)).join("");
  }
  const keepId=autoSelect===false&&selectedRFP?selectedRFP.request_id:null;
  // Prefetch M/WBE chip tools and inject chips in place — never replace the whole list
  // (that would race loadLineageBadges and wipe .lineage-slot markers).
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
  document.querySelectorAll("#list .row").forEach(el=>el.addEventListener("click",event=>select(+el.dataset.i, el, event.isTrusted)));
  if(autoSelect===false&&keepId){
    const idx=currentRows.findIndex(r=>r&&r.request_id===keepId);
    if(idx>=0){
      const el=document.querySelector(`#list .row[data-i="${idx}"]`);
      if(el){ el.classList.add("sel"); selectedRFP=currentRows[idx]; }
      loadLineageBadges();
      return;
    }
  }
  if(autoSelect!==false) document.querySelector("#list .row")?.click();
  loadLineageBadges();
}

// One post-paint batch marks confirmed histories; the ceiling rejects widened PIN collisions.
const LINEAGE_MIN_STAGES = 2;
const LINEAGE_MAX_STAGES = 15;

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

async function loadLineageBadges(){
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
  const where = `(${lineageBatchClauses(keys).join(" OR ")}) AND (type_of_notice_description='Award' OR type_of_notice_description='Intent to Award')`;
  let batchRows;
  try{
    batchRows = await soda({"$select":"pin,agency_name,type_of_notice_description","$where":where,"$limit":"2000"});
  }catch(e){ return; }
  if(currentRows !== rows) return;
  const counts = computeLineageBadgeCounts(rows, batchRows);
  document.querySelectorAll("#list .row").forEach(el=>{
    const n = counts[+el.dataset.i];
    if(!n) return;
    const slot = el.querySelector(".lineage-slot");
    if(slot) slot.outerHTML = `<span class="tag renewal">${tn("history_cycles_tag", n, {n})}</span>`;
  });
}

async function select(i, el, planningDetailRequested=false){
  document.querySelectorAll("#list .row.sel").forEach(e=>e.classList.remove("sel"));
  el.classList.add("sel");
  const r = currentRows[i];
  if(planningDetailRequested) r.planning_detail_requested = true;
  selectedRFP = r;
  renderDetail(r, null, null);
  const [hydrated, chain, stats] = await Promise.all([
    hydrateMoneyActionLocationRow(r),
    loadChain(r),
    loadAgencyStats(r.agency_name),
  ]);
  if(selectedRFP !== r) return;
  selectedRFP=hydrated;
  renderDetail(hydrated, chain, stats);
}

async function hydrateMoneyActionLocationRow(r){
  if(!r?._action_location_match) return r;
  return globalThis.MoneyActionLocations?.hydrateMoneyActionLocationRow?.(r,{soda,select:SELECT})||r;
}

const RENEWAL_SUFFIX_RE = /R0\d+$/;
function pinBase(pin){
  const s = String(pin||"").trim();
  const m = s.match(RENEWAL_SUFFIX_RE);
  return m ? s.slice(0, m.index) : null;
}
async function loadChain(r){
  if(!usablePin(r.pin)) return [r];
  try{
    const base = pinBase(r.pin);
    const where = base
      ? `pin LIKE '${base.replace(/'/g,"''")}%' AND agency_name='${r.agency_name.replace(/'/g,"''")}'`
      : `pin='${r.pin.replace(/'/g,"''")}' AND agency_name='${r.agency_name.replace(/'/g,"''")}'`;
    const rows = await soda({"$select":SELECT,
      "$where":where,
      "$order":"start_date ASC","$limit":"60"});
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
globalThis.initializeMoneyLocationFilters = initializeMoneyLocationFilters;
globalThis.isDefaultMoneySearchState = isDefaultMoneySearchState;
globalThis.filterStillOpenMoneyNotices = filterStillOpenMoneyNotices;
globalThis.moneyActiveFilterChip = moneyActiveFilterChip;
globalThis.moneyListPrimaryAction = moneyListPrimaryAction;
globalThis.moneyListPrimaryActionHTML = moneyListPrimaryActionHTML;
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
