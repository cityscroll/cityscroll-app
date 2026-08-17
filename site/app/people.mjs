import { hireMatchesAgencyScope } from "../staffing_agency_scope.mjs";
import { listEntityMentionHTML } from "../list_entity_pivots.mjs";
import {
  staffingPeopleFromAppointments,
  staffingRolesFromExamples,
} from "../resident_snapshot_queries.mjs";

/* ===================== PEOPLE ===================== */
let SameConsolidation=null;
let sameConsolidationPromise=null;
function loadSameConsolidation(){
  return sameConsolidationPromise||(sameConsolidationPromise=import("../same_consolidation.mjs").then(module=>SameConsolidation=module.createStaffingConsolidationUI({t,escUiHtml,fmtNumber,money,fdt,fdate,REQ_URL,listEntityMentionHTML,canonicalOrigin:location.origin})));
}
let pRows = [], pMode = "role", competitiveSet = new Set();
let staffingNotices = [], staffingLoaded = false, staffingLoadPromise = null;
let staffingLoadedScopeKey = "";
const staffingFilters = {query:"", role:"", agency:""};
function staffingScopeKey(){
  return String(staffingFilters.agency || "").trim();
}
function staffingHireFilters(){
  const agency = staffingScopeKey();
  if(!agency) return {...staffingFilters};
  return {
    ...staffingFilters,
    // Exact City Record spellings on chip filters stay in staffingFilters.agency;
    // identity-aware matching covers canonical facet hydration (Parks vs DEPT OF…).
    agencyMatch: (agencyName) => hireMatchesAgencyScope(agencyName, agency),
  };
}
function staffingVisibleItems(){
  return CrolStaffing.filterHireNotices(staffingNotices,staffingHireFilters());
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
    const next=button.dataset.staffingAgency||"";
    if(staffingFilters.agency===next) return;
    staffingFilters.agency=next;
    reloadStaffingForAgencyScope();
    renderStaffingFeed(); updateHash();
  }));
}
function syncStaffingModeUI(){
  const feed=$("#staffing-feed");
  const ledger=$("#staffing-ledger");
  const heading=$("#staffing-feed-meta-heading");
  if(feed) feed.hidden=false;
  if(ledger) ledger.hidden=false;
  if(heading) heading.textContent=t("staffing_appointments_heading");
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
// Daily APPOINTED projection. Agency and keyword scopes filter this retained reader model.
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
function reloadStaffingForAgencyScope(){
  staffingLoaded=false;
  staffingLoadPromise=null;
  staffingNotices=[];
  staffingLoadedScopeKey="";
  loadStaffingFeed();
}
async function loadStaffingFeed(){
  const scopeKey=staffingScopeKey();
  if(staffingLoaded && staffingLoadedScopeKey===scopeKey){
    renderStaffingFeed();
    return staffingNotices;
  }
  if(staffingLoadPromise && staffingLoadPromise.scopeKey===scopeKey) return staffingLoadPromise.promise;
  const promise=(async()=>{
    await loadSameConsolidation();
    try{
      const [snap, crosswalk]=await Promise.all([
        loadStaffingHiresSnapshot(),
        fetch("data/title_crosswalk.json").then(response=>response.ok?response.json():[]),
      ]);
      if(staffingScopeKey()!==scopeKey) return staffingNotices;
      const notices=snap&&Array.isArray(snap.notices)?snap.notices:[];
      const scoped=scopeKey?notices.filter(row=>hireMatchesAgencyScope(row.agency_name,scopeKey)):notices;
      staffingNotices=CrolStaffing.hireNotices(scoped,crosswalk);
      staffingLoaded=true;
      staffingLoadedScopeKey=scopeKey;
      renderStaffingFeed();
      return staffingNotices;
    }catch(e){
      if(staffingScopeKey()!==scopeKey) return staffingNotices;
      $("#staffing-notice-list").innerHTML=`<div class="career-empty">${t("staffing_load_failed")}</div>`;
      staffingLoaded=true;
      staffingLoadedScopeKey=scopeKey;
      return [];
    }
  })();
  staffingLoadPromise={scopeKey, promise};
  return promise;
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

// Bare #people and keyword searches use the same committed title projection.
let peopleDefaulted = false;
let peopleDefaultExamplesPromise = null;
async function defaultRoleTitle(){
  try{
    if(!peopleDefaultExamplesPromise){
      peopleDefaultExamplesPromise=fetch("data/people_examples.json")
        .then(response=>response.ok?response.json():[])
        .catch(()=>[]);
    }
    const examples=await peopleDefaultExamplesPromise;
    const first=Array.isArray(examples)?examples.find(example=>example?.keyword||example?.official_title):null;
    return first?.keyword || first?.official_title || null;
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

// Committed examples are the role-search read model.
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
  const ev = resultMatchEvidence(r.title_description, "", terms);
  const status=exam?CrolStaffing.statusFor(exam,careerToday()):null;
  const examLink=exam?`<a class="staffing-exam-link" href="${CrolStaffing.examUrl(exam.exam_number, location.origin)}">
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
  if(!pExamples.length) await seedPeople();
  const pay=staffingRolesFromExamples(pExamples,kw);
  await loadCareerGuide();
  if(stale && stale()) return;
  competitiveSet = new Set(pay.filter(row=>row.competitive).map(row=>(row.title_description||"").toUpperCase().trim()));
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
      <a href="${CrolStaffing.examUrl(exam.exam_number, location.origin)}">${t("staffing_view_exam_detail")}</a></div>`:""}
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
  for(const a of p.actions){ const e = resultMatchEvidence(p.name, a.text, terms); if(!ev) ev = e; if(e) break; }
  return `<div class="row" data-i="${i}" tabindex="0" role="button">
      <p class="rtitle">${digTitleHTML(p.name, ev)}</p>
      <p class="rmeta"><span class="ragency" lang="en" dir="ltr">${p.agency}</span> · ${tn("n_notices_meta",p.actions.length)}</p>
      ${digEvidenceHTML(ev)}
    </div>`;
}
async function pSearchPeople(kw, stale){
  const snap=await loadStaffingHiresSnapshot();
  const rows=snap&&Array.isArray(snap.notices)?snap.notices:[];
  if(stale && stale()) return;
  pRows=staffingPeopleFromAppointments(rows,kw).map(group=>({
    name:group.name,
    agency:group.agency,
    actions:group.rows.map(r=>{
      const p=parsePersonnel(r.additional_description_1);
      return {date:r.start_date,reason:p.reason||cleanText(r.short_title),salary:p.salary,code:p.code,req:r.request_id,text:cleanText(r.short_title)+" "+matchText(r)};
    }),
  }));
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
  let html = `<h2 class="rolename" lang="en" dir="ltr">${p.name}</h2><div class="badges"><span class="tag">${p.agency}</span></div>`;
  html += `<div class="note">${t("no_payroll_match_note")}</div>`;
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
globalThis.applyPeopleDefault = applyPeopleDefault;
globalThis.bindStaffingFacets = bindStaffingFacets;
globalThis.defaultRoleTitle = defaultRoleTitle;
globalThis.loadStaffingFeed = loadStaffingFeed;
globalThis.loadStaffingHiresSnapshot = loadStaffingHiresSnapshot;
globalThis.reloadStaffingForAgencyScope = reloadStaffingForAgencyScope;
globalThis.staffingVisibleItems = staffingVisibleItems;
globalThis.pExample = pExample;
globalThis.pSearch = pSearch;
globalThis.pSearchPeople = pSearchPeople;
globalThis.pSearchRoles = pSearchRoles;
globalThis.pSelectPerson = pSelectPerson;
globalThis.pSelectRole = pSelectRole;
globalThis.parsePersonnel = parsePersonnel;
globalThis.personRowHTML = personRowHTML;
globalThis.renderStaffingFeed = renderStaffingFeed;
globalThis.roleRowHTML = roleRowHTML;
globalThis.seedPeople = seedPeople;
globalThis.staffingFacetHTML = staffingFacetHTML;
globalThis.staffingFilters = staffingFilters;
globalThis.syncStaffingModeUI = syncStaffingModeUI;
Object.defineProperty(globalThis, "competitiveSet", { configurable: true, get: () => competitiveSet, set: value => { competitiveSet = value; } });
Object.defineProperty(globalThis, "pExamples", { configurable: true, get: () => pExamples, set: value => { pExamples = value; } });
Object.defineProperty(globalThis, "pMode", { configurable: true, get: () => pMode, set: value => { pMode = value; } });
Object.defineProperty(globalThis, "pRows", { configurable: true, get: () => pRows, set: value => { pRows = value; } });
Object.defineProperty(globalThis, "peopleDefaulted", { configurable: true, get: () => peopleDefaulted, set: value => { peopleDefaulted = value; } });
Object.defineProperty(globalThis, "peopleSeeded", { configurable: true, get: () => peopleSeeded, set: value => { peopleSeeded = value; } });
Object.defineProperty(globalThis, "staffingLoadPromise", { configurable: true, get: () => staffingLoadPromise, set: value => { staffingLoadPromise = value; } });
Object.defineProperty(globalThis, "staffingLoaded", { configurable: true, get: () => staffingLoaded, set: value => { staffingLoaded = value; } });
Object.defineProperty(globalThis, "staffingNotices", { configurable: true, get: () => staffingNotices, set: value => { staffingNotices = value; } });
