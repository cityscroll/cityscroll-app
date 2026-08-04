const MONEY_DEFAULT_SNAPSHOT_URL="data/money_default_open.json";
const MONEY_AGENCIES_SNAPSHOT_URL="data/money_procurement_agencies.json";
let moneyDefaultSnapshotPromise=null;
let moneyAgenciesSnapshotPromise=null;
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
  bindClearSearchState("money", box);
}
function updateMoneyMoreFiltersState(){
  const nl=moneyNlResolved&&typeof moneyNlResolved==="object"?moneyNlResolved:{};
  const active=[
    mode!=="open",
    !!$("#agency").value,
    mode==="award"&&!!$("#minamt").value,
    closingWeek,
    !!nl.category,
    nl.maxAmount!=null,
    nl.months!=null,
    !!nl.excludeSpecial,
  ].filter(Boolean).length;
  const badge=$("#money-filter-badge");
  if(!badge) return;
  badge.hidden=active===0;
  badge.textContent=active?t("property_filters_active",{n:active}):"";
}
async function search(){
  moneyLoaded = true;
  mode = $("#mode").value;
  const agency = $("#agency").value, kw = $("#kw").value.trim();
  const sort = $("#sort").value, minamt = $("#minamt").value;
  $("#minwrap").style.display = mode === "award" ? "" : "none";
  $("#minamt").disabled = mode !== "award";
  if(mode !== "open" && closingWeek){ closingWeek = false; $("#closingweek").classList.remove("on"); $("#closingweek").setAttribute("aria-pressed","false"); }
  $("#moneyquick").style.display = mode === "open" ? "" : "none";
  renderMoneyActiveFilters();
  updateMoneyMoreFiltersState();

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
      rows = await soda(p, SLOW_MS);
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
  setExportBandVisibility(currentRows.length, "money-export-band", "money-export-overflow");
  unbusy("#list");
  const countText=currentRows.length===1?t("one_result"):t(currentRows.length===40?"or_more_results":"results_count",{n:currentRows.length});
  $("#rescount").textContent = countText;
  announce(countText + ` — ${$("#reshead").textContent}`);
  renderList(autoSelect);
  if(narrowed) $("#list").insertAdjacentHTML("afterbegin",
    `<div class="note warn" style="margin:10px 12px 0">${t("narrowed_note",{date:recentCutLabel()})}</div>`);
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

function moneyRowHTML(r, i, terms){
  const isAward = r.type_of_notice_description === "Award";
  const lead = isAward
    ? (money(r.contract_amount) ? `<span class="tag amt">${money(r.contract_amount)}</span>` : "")
    : deadlineTag(r.due_date);
  const title = cleanText(r.short_title), ev = matchEvidence(title, matchText(r), terms);
  return `<div class="row" data-i="${i}" tabindex="0" role="button">
      <p class="rtitle">${title ? digTitleHTML(title, ev) : t("untitled_notice")}</p>
      <p class="rmeta">${lead}<span class="lineage-slot"></span><span class="ragency" lang="en" dir="ltr">${r.agency_name||""}</span> · ${fdate(r.start_date)}
        ${r.category_description? " · "+r.category_description : ""}<br>
        ${usablePin(r.pin)? `<span class="pin">PIN ${r.pin}</span>` : `<span class="pin muted">${t("no_linkable_pin")}</span>`}</p>
      ${digEvidenceHTML(ev)}
    </div>`;
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
    $("#list").innerHTML = '<div class="empty">' + t("nothing_found") + '</div>';
    $("#detail").innerHTML = "";
    selectedRFP=null;
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
  document.querySelectorAll("#list .row").forEach(el=>el.addEventListener("click",()=>select(+el.dataset.i, el)));
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

async function select(i, el){
  document.querySelectorAll("#list .row.sel").forEach(e=>e.classList.remove("sel"));
  el.classList.add("sel");
  const r = currentRows[i];
  selectedRFP = r;
  renderDetail(r, null, null);
  const [chain, stats] = await Promise.all([ loadChain(r), loadAgencyStats(r.agency_name) ]);
  if(selectedRFP !== r) return;
  renderDetail(r, chain, stats);
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
globalThis.isDefaultMoneySearchState = isDefaultMoneySearchState;
globalThis.filterStillOpenMoneyNotices = filterStillOpenMoneyNotices;
globalThis.moneyActiveFilterChip = moneyActiveFilterChip;
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
Object.defineProperty(globalThis, "selectedRFP", { configurable: true, get: () => selectedRFP, set: value => { selectedRFP = value; } });
