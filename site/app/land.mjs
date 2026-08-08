import { landProjectDisplayTitle } from "../display_title.mjs";
import { boroughScopeLinksHTML, normalizeBoroughScope } from "../borough_scope_links.mjs";
import { attendanceScopeLinksHTML, normalizeAttendanceScope } from "../attendance_scope_links.mjs";

/* ===================== LAND ===================== */
const ZAP = "https://data.cityofnewyork.us/resource/hgx4-8ukb.json";
const GEO = "https://geosearch.planninglabs.nyc/v2/search";
const BORO_CENTER = {Manhattan:[40.776,-73.971],Brooklyn:[40.650,-73.950],Bronx:[40.844,-73.865],Queens:[40.718,-73.806],"Staten Island":[40.580,-74.150]};
// ZAP action labels live in i18n.js (zapact_* keys) — see ZAPACT_KEY in landSelect().
let lRows=[], landLoaded=false, landMap=null, landMarker=null, landSelectionSeq=0;
let landResolvedArea=null;
let landBorough="";
let landAttendance="";
let landCommunityDistrict="";
let landCouncilDistrict="";
const mihOn = v => v===true || v==="true";

const ZAPBBL="https://data.cityofnewyork.us/resource/2iga-a6mk.json";
const ZAP_SELECT="project_id,project_name,project_brief,primary_applicant,public_status,project_status,borough,community_district,cc_district,actions,mih_flag,current_milestone,current_milestone_date,ulurp_numbers";
let landBanner="";
let landStatusFacetToolsPromise=null;
let landStatusFacetToolsModule=null;
function landStatusFacetTools(){
  return landStatusFacetToolsPromise ||= import("../land_status_facets.mjs")
    .then(tools=>{ landStatusFacetToolsModule=tools; return tools; })
    .catch(()=>null);
}
function zapWhere(status){
  const facetWhere=landStatusFacetToolsModule?.landStatusFacetWhere?.(status);
  return "ulurp_non='ULURP'"+(status==="active"?" AND project_status='Active'":facetWhere?` AND ${facetWhere}`:"");
}
function zapDistrictWhere(communityDistrict){
  return /^(?:M|X|K|Q|R)\d{2}$/.test(communityDistrict||"")
    ? ` AND community_district like '%${communityDistrict}%'`
    : "";
}
// ZAP multi-district cells concatenate zero-padded pairs (e.g. 213025 = 21,30,25).
function zapCouncilWhere(councilDistrict){
  const id=String(councilDistrict||"").trim();
  if(!/^(?:[1-9]|[1-4]\d|5[01])$/.test(id)) return "";
  const padded=id.padStart(2,"0");
  // LIKE must be uppercase so the stray-English lint classifies this as SoQL, not UI copy.
  return ` AND (cc_district='${id}' OR cc_district LIKE '%${padded}%')`;
}

// Commit-time default Active ULURP list (wave-2 batch precompute). Filter/keyword/geo stay live SODA.
const LAND_DEFAULT_SNAPSHOT_URL="data/land_default_ulurp.json";
const LAND_UPCOMING_HEARINGS_URL="data/land_upcoming_hearings.json";
let landDefaultSnapshotPromise=null;
let landUpcomingHearingsPromise=null;
function loadLandDefaultSnapshot(){
  if(!landDefaultSnapshotPromise){
    landDefaultSnapshotPromise=fetch(LAND_DEFAULT_SNAPSHOT_URL)
      .then(r=>r.ok?r.json():null)
      .then(snapshot=>{
        seedLandOutcomeSnapshot(snapshot);
        return snapshot;
      })
      .catch(()=>null);
  }
  return landDefaultSnapshotPromise;
}
function seedLandOutcomeSnapshot(snapshot){
  const byProject=snapshot?.outcomes?.by_project||{};
  const generatedAt=snapshot?.generated_at||null;
  for(const [id,record] of Object.entries(byProject)){
    if(!record || record.snapshot_state==="unavailable") continue;
    ZAP_OUTCOMES_MEM.set(id,{
      data:{ok:true,cached:true,static_snapshot:true,generated_at:generatedAt,record},
      at:Date.now(),
      generatedAt,
      staticSnapshot:true
    });
  }
}
function loadLandUpcomingHearings(){
  if(!landUpcomingHearingsPromise){
    landUpcomingHearingsPromise=fetch(LAND_UPCOMING_HEARINGS_URL)
      .then(r=>r.ok?r.json():null)
      .catch(()=>null);
  }
  return landUpcomingHearingsPromise;
}
function isDefaultLandSearchState(status, boro, kw, located){
  return status==="active" && !boro && !kw && !landCommunityDistrict && !landCouncilDistrict && !located;
}
function landHearingModeFieldSync(){
  const field=$("#lhearingmode-field");
  const status=$("#lstatus")?$("#lstatus").value:"";
  if(field) field.hidden=status!=="hearings";
}
function renderLandAttendanceScopeLinks(){
  const host=$("#land-attendance-rail");
  if(!host) return;
  host.innerHTML=attendanceScopeLinksHTML({
    selected:landAttendance,
    currentHash:location.hash,
    t,
    escape:escUiHtml,
  });
}
function renderLandBoroughScopeLinks(){
  const host=$("#land-borough-rail");
  if(!host) return;
  host.innerHTML=boroughScopeLinksHTML({
    surface:"land",
    selected:landBorough,
    currentHash:location.hash,
    t,
    escape:escUiHtml,
  });
}
async function syncLandLensControls(){
  const tools=await landStatusFacetTools();
  const status=$("#lstatus")?.value||"all";
  const rail=$("#land-status-rail");
  const select=$("#lstatus");
  const options=tools?.landStatusFacetOptions?.(lRows)||[];
  if(rail && options.length){
    const buttons=[
      { id:"all", label:t("status_all") },
      ...options,
      { id:"hearings", label:t("land_status_upcoming_hearings") },
    ];
    if(select){
      const selectOptions=[buttons[0], { id:"active", label:t("status_active") }, ...buttons.slice(1)];
      select.innerHTML=selectOptions.map(option=>`<option value="${escUiHtml(option.id)}">${escUiHtml(option.label)}</option>`).join("");
    }
    const selectedId=status==="active"?["project","Active"].join(":"):status;
    rail.innerHTML=buttons.map(option=>`<button type="button" class="chip" data-land-status="${escUiHtml(option.id)}" aria-pressed="${option.id===selectedId?"true":"false"}">${escUiHtml(option.label)}${option.count?` <span class="ct">${fmtNumber(option.count)}</span>`:""}</button>`).join("");
    if(select) select.value=status;
  }
  const selectedId=status==="active"?["project","Active"].join(":"):status;
  rail?.querySelectorAll("[data-land-status]").forEach(button=>{
    button.setAttribute("aria-pressed",String(button.dataset.landStatus===selectedId));
  });
  landHearingModeFieldSync();
  renderLandAttendanceScopeLinks();
  renderLandBoroughScopeLinks();
  const active=[
    !!landBorough,
    status!=="all",
    status==="hearings"&&!!landAttendance,
    !!landResolvedArea,
  ].filter(Boolean).length;
  const badge=$("#land-filter-badge");
  if(badge){
    badge.hidden=active===0;
    badge.textContent=active?t("property_filters_active",{n:fmtNumber(active)}):"";
  }
}
function clearLandDetail(){
  const card=$("#land-item-card");
  if(card) card.hidden=true;
  const detail=$("#ldetail");
  if(detail) detail.innerHTML="";
}
function setLandStatus(message=""){
  const status=$("#land-status");
  if(status) status.textContent=message;
}
function setLandResultCount(count){
  const element=$("#lrescount");
  if(element) element.textContent=t("results_count",{n:fmtNumber(countWithScopeReceipt(count))});
}
function landHasAppliedFilters(){
  return !!($("#lkw")?.value.trim() || landBorough || landCommunityDistrict
    || landCouncilDistrict || landResolvedArea || $("#lstatus")?.value!=="all"
    || landAttendance);
}
function resetLandFilters(){
  landResolvedArea=null;
  landBorough="";
  landAttendance="";
  landCommunityDistrict="";
  landCouncilDistrict="";
  $("#lkw").value="";
  $("#lstatus").value="all";
  $("#nltrans-land").innerHTML="";
  landSearch();
}
function landEmptyStateHTML(kind="projects"){
  const filtered=landHasAppliedFilters();
  const heading=kind==="hearings"?t("land_empty_hearings_heading"):t("land_empty_projects_heading");
  const detail=filtered?t("land_empty_filtered_detail"):t("land_empty_unfiltered_detail");
  return `<section class="land-empty-state" role="status" aria-labelledby="land-empty-heading">
    <h3 id="land-empty-heading">${heading}</h3><p>${detail}</p>
    <button type="button" class="act" data-land-widen>${t("land_empty_widen")}</button>
  </section>`;
}
function wireLandEmptyState(){
  $("#llist")?.querySelector("[data-land-widen]")?.addEventListener("click",resetLandFilters);
}
function filterLandHearingRows(rows, {boro, mode, kw, today}={}){
  const day=String(today||(typeof todayISO==="function"?todayISO():new Date().toISOString().slice(0,10))).slice(0,10);
  const b=(boro||"").toLowerCase();
  const m=mode||"";
  const q=(kw||"").toLowerCase();
  return (rows||[]).filter(row=>{
    if(!row) return false;
    const when=String(row.hearing_date||row.hearing_at||"").slice(0,10);
    if(!when||when<day) return false;
    if(b && String(row.borough||"").toLowerCase()!==b) return false;
    const modes=Array.isArray(row.attendance_modes)?row.attendance_modes:[];
    if(m==="in_person" && !modes.includes("in_person") && !row.venue_address) return false;
    if(m==="livestream" && !modes.includes("livestream") && !row.livestream_url) return false;
    if(m==="hybrid" && !(modes.includes("in_person") && modes.includes("livestream"))
      && !(row.venue_address && row.livestream_url)) return false;
    if(q){
      const blob=`${row.project_name||""} ${row.project_id||""} ${row.venue_address||""} ${row.representing||""}`.toLowerCase();
      if(!blob.includes(q)) return false;
    }
    return true;
  });
}
function landHearingRowHTML(row, i){
  const title=landProjectDisplayTitle(row);
  const when=row.hearing_at||row.hearing_date||"";
  const whenLabel=fdt(when,{dateOnly:row.parse_status==="published_date_only"});
  const modes=(row.attendance_modes||[]).map(mode=>{
    if(mode==="in_person") return t("land_hearings_mode_list_in_person");
    if(mode==="livestream") return t("land_hearings_mode_list_livestream");
    return mode;
  }).filter(Boolean);
  const modeTxt=modes.length?t("land_hearings_card_modes",{modes:modes.join(" · ")}):"";
  const venue=row.venue_address?escUiHtml(row.venue_address):"";
  const live=row.livestream_url
    ? `<a class="act" href="${escUiHtml(row.livestream_url)}" ${EXT_ATTRS}>${t("land_action_watch_live")}${extSR()}</a>`
    : "";
  const maps=row.maps_url&&row.venue_address
    ? `<a class="act" href="${escUiHtml(row.maps_url)}" ${EXT_ATTRS}>${t("land_action_attend_in_person")}${extSR()}</a>`
    : "";
  const open=row.project_id
    ? `<a class="act" href="#land/${encodeURIComponent(row.project_id)}">${t("land_hearings_open_project")}</a>`
    : "";
  return `<div class="row land-hearing-row" data-i="${i}" data-project-id="${escUiHtml(row.project_id||"")}" tabindex="0" role="button">
    <p class="rtitle">${escUiHtml(title)}</p>
    <p class="rmeta"><span class="ragency">${escUiHtml(row.borough||"")}${row.representing?` · ${escUiHtml(row.representing)}`:""}</span>
      · ${t("land_hearings_card_when",{date:whenLabel})}${modeTxt?` · ${escUiHtml(modeTxt)}`:""}
      ${venue?`<br>${venue}`:""}
      ${row.hearing_location_raw&&!row.venue_address?`<br lang="en" dir="ltr">${escUiHtml(row.hearing_location_raw)}`:""}
    </p>
    <div class="fcard-compact-actions">${maps}${live}${open}</div>
  </div>`;
}
async function landSearchHearings(stale){
  landHearingModeFieldSync();
  const boro=landBorough;
  const kw=$("#lkw").value.trim();
  const mode=landAttendance;
  const modeLabel=mode==="in_person"?t("land_hearings_mode_in_person"):mode==="hybrid"?t("venue_hybrid"):t("land_hearings_mode_livestream");
  $("#lreshead").textContent=t("land_hearings_heading")+(boro?" · "+boro:"")+(mode?` · ${modeLabel}`:"");
  try{
    const snap=await loadLandUpcomingHearings();
    if(stale()) return;
    const all=snap&&Array.isArray(snap.hearings)?snap.hearings:[];
    const rows=filterLandHearingRows(all,{boro, mode, kw, today:todayISO()});
    lRows=rows.map(r=>({
      // Keep enough project shape so landSelect can open a detail route.
      project_id:r.project_id,
      project_name:r.project_name,
      borough:r.borough,
      public_status:r.public_status||null,
      project_status:"Active",
      _hearing:r,
    }));
    unbusy("#llist");
    setLandStatus();
    setLandResultCount(lRows.length);
    setExportBandVisibility(lRows.length, "land-export-band", "land-export-overflow");
    announce(t("land_hearings_heading")+`: ${lRows.length}`);
    if(!lRows.length){
      $("#llist").innerHTML=landEmptyStateHTML("hearings");
      wireLandEmptyState();
      clearLandDetail();
      return;
    }
    $("#llist").innerHTML=lRows.map((r,i)=>landHearingRowHTML(r._hearing||r,i)).join("");
    $("#llist").querySelectorAll(".row").forEach(el=>{
      el.addEventListener("click",()=>landSelect(+el.dataset.i, el));
      el.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); landSelect(+el.dataset.i, el); } });
    });
  }catch(e){
    if(!stale()){
      unbusy("#llist");
      $("#llist").innerHTML="";
      clearLandDetail();
      setLandStatus(t("could_not_reach"));
    }
  }
}
function paintLandRows(rows, banner, kw, block, boro, stale, autoSelect){
  if(stale()) return;
  // Preserve selection across hybrid refresh (snapshot → live) when the project is still present.
  const selectedId=(!autoSelect && Array.isArray(lRows))
    ? (document.querySelector("#llist .row.sel") && lRows[+document.querySelector("#llist .row.sel").dataset.i]?.project_id)
    : null;
  lRows=Array.isArray(rows)?rows:[]; landBanner=banner||"";
  // The facet module is lazy so non-Land routes keep their cold path small; now
  // that the inventory exists, repaint the status rail with its real options.
  syncLandLensControls();
  setExportBandVisibility(lRows.length, "land-export-band", "land-export-overflow");
  unbusy("#llist");
  setLandStatus();
  setLandResultCount(lRows.length);
  announce(t("rezonings_announce",{n:lRows.length}));
  // A resolved block/nearby lookup doesn't filter rows by kw as TEXT (it's a BBL join) --
  // match evidence would misrepresent that as a keyword hit, so only pass kw through when
  // it actually became the $q text filter below. boro is always a structured filter -- passed
  // separately as a contextTerm (see landRenderList).
  // Hybrid refresh after a snapshot paint must not re-autoSelect (would wipe a chosen row).
  landRenderList(kw, !block, boro, autoSelect);
  if(selectedId){
    const idx=lRows.findIndex(r=>r.project_id===selectedId);
    if(idx>=0){
      const el=document.querySelector(`#llist .row[data-i="${idx}"]`);
      if(el) el.classList.add("sel");
    }
  }
}
async function landSearch(){
  let boro=landBorough, kw=$("#lkw").value.trim();
  const status=$("#lstatus").value;
  if(kw){
    try{
      const neighborhoodTools=await import("../neighborhood_search.mjs");
      const place=await neighborhoodTools.resolveNeighborhoodQuery(kw);
      if(place){
        boro=place.borough||"";
        landBorough=normalizeBoroughScope(boro);
        landCommunityDistrict=place.community_districts?.[0]||"";
        $("#lkw").value="";
        kw="";
      }
    }catch(_e){}
  }
  await syncLandLensControls();
  clearLandDetail();
  setLandStatus();
  const located=!!(landResolvedArea && !kw && landResolvedArea.borough===boro);
  updateHash();
  globalThis.syncAlertsEntryHrefs?.();
  if(located){
    const areaBits=[landResolvedArea.borough];
    if(landResolvedArea.communityDistrict) areaBits.push(`CD ${Number(landResolvedArea.communityDistrict.slice(1))}`);
    if(landResolvedArea.councilDistrict) areaBits.push(t("council_district_short",{n:landResolvedArea.councilDistrict}));
    if(landResolvedArea.boundaryVintage) areaBits.push(t("districts_as_of",{vintage:landResolvedArea.boundaryVintage}));
    renderSearchComponents("land", {filter: {
      ...coarseLandFilter(landResolvedArea, status),
      locationArea: areaBits.filter(Boolean).join(" · "),
    }});
  } else {
    renderSearchComponents("land");
  }
  $("#lrescount").textContent=""; landBanner="";
  busyList("#llist", 3);
  const stale = staleGuard("land");
  // Upcoming-hearings view: precomputed ZAP disposition logistics (not live SODA).
  if(status==="hearings"){
    return landSearchHearings(stale);
  }
  $("#lreshead").textContent = t("rezonings_heading") + (boro?" · "+boro:"") + (kw?` · “${kw}”`:"");
  let geo=located?landResolvedArea:null, block=located?landResolvedArea.block:null;
  if(kw){ geo=await geocode(kw); if(geo&&geo.bbl&&/^\d{10}$/.test(geo.bbl)) block=geo.bbl.slice(0,6); }
  // Default Land tab: paint prebuilt Active ULURP snapshot first (no SODA wait), then hybrid-refresh.
  const useDefaultSnapshot=isDefaultLandSearchState(status, boro, kw, located) && !block;
  let paintedFromSnapshot=false;
  if(useDefaultSnapshot){
    try{
      const snap=await loadLandDefaultSnapshot();
      const projects=snap&&Array.isArray(snap.projects)?snap.projects:[];
      if(projects.length){
        paintLandRows(projects, "", kw, false, boro, stale, true);
        paintedFromSnapshot=true;
      }
    }catch(e){}
  }
  try{
    let rows, banner="";
    if(block){
      const lo=block+"0000", hi=block+"9999";
      const onLot=await api(ZAPBBL,{"$select":"project_id","$where":`bbl between ${lo} and ${hi}`,"$group":"project_id","$limit":"60"});
      const ids=[...new Set(onLot.map(b=>b.project_id))].filter(Boolean).slice(0,30);
      if(ids.length){
        const inList=ids.map(i=>`'${i.replace(/'/g,"''")}'`).join(",");
        rows=await api(ZAP,{"$select":ZAP_SELECT,"$where":`${zapWhere(status)} AND project_id in(${inList})`,"$order":"current_milestone_date DESC","$limit":"40"});
        banner=t("banner_on_block",{label:geo.label});
        if(!rows.length){ rows=await landNearby(geo,status); banner=t(status==="active"?"banner_none_active_nearest":"banner_none_nearest",{area:geo.neighbourhood||geo.borough}); }
      } else { rows=await landNearby(geo,status); banner=t("banner_none_lot",{label:geo.label, area:geo.neighbourhood||geo.borough}); }
    } else {
      let w=zapWhere(status); if(boro) w+=` AND borough='${boro.replace(/'/g,"''")}'`;
      w+=zapDistrictWhere(landCommunityDistrict);
      w+=zapCouncilWhere(landCouncilDistrict);
      const p={"$select":ZAP_SELECT,"$where":w,"$order":"current_milestone_date DESC","$limit":"40"}; if(kw) p["$q"]=kw;
      rows=await api(ZAP,p);
    }
    // If snapshot already painted the default list, refresh rows without re-clicking the first item.
    paintLandRows(rows, banner, kw, !!block, boro, stale, paintedFromSnapshot ? false : true);
  }catch(e){
    if(!stale() && !paintedFromSnapshot){
      unbusy("#llist");
      $("#llist").innerHTML="";
      setLandResultCount(0);
      setLandStatus(t("could_not_reach"));
    }
  }
}

async function landNearby(geo,status){
  let w=zapWhere(status); if(geo&&geo.borough) w+=` AND borough='${geo.borough.replace(/'/g,"''")}'`;
  w+=zapDistrictWhere(geo&&geo.communityDistrict);
  w+=zapCouncilWhere(geo&&geo.councilDistrict);
  return api(ZAP,{"$select":ZAP_SELECT,"$where":w,"$order":"current_milestone_date DESC","$limit":"40"});
}

// landRowHTML: one rezoning result row. project_name/project_brief are ZAP's own field names
// (not short_title/additional_description_1) -- digItemHTML's emailed-digest evidence
// deliberately skips ZAP rows for that reason, but matchEvidence()/digTitleHTML()/
// digEvidenceHTML() are generic text-in/HTML-out and work on any title+description pair.
function landRowHTML(r, i, terms, contextTerms){
  const title = landProjectDisplayTitle(r), ev = matchEvidence(title, cleanText(r.project_brief), terms, contextTerms);
  return `<div class="row" data-i="${i}" tabindex="0" role="button">
    <p class="rtitle">${digTitleHTML(title, ev)}</p>
    <p class="rmeta">${mihOn(r.mih_flag)?`<span class="tag soon">${t("affordable_housing_tag")}</span>`:''}<span class="ragency">${r.borough||""}${r.community_district?" · CD "+r.community_district:""}${r.cc_district?" · "+t("council_district_short",{n:r.cc_district}):""}</span> · ${r.public_status||r.project_status||""}<br>
      ${r.current_milestone?cleanText(r.current_milestone)+(r.current_milestone_date?" · "+fdate(r.current_milestone_date):""):""}</p>
    ${digEvidenceHTML(ev)}
  </div>`;
}
function landRenderList(kw, kwIsTextMatch, boro, autoSelect){
  const head=landBanner?`<div class="landbanner">${landBanner}</div>`:"";
  if(!lRows.length){
    $("#llist").innerHTML=landEmptyStateHTML();
    wireLandEmptyState();
    clearLandDetail();
    return;
  }
  // A resolved block/nearby lookup filters rows by a BBL join, not kw as text -- only pass kw
  // through as a match term when it actually became the $q text filter (see landSearch()).
  const terms = (kw && kwIsTextMatch) ? [kw] : [];
  // boro is a structured `borough=` filter, not a $q text search -- passed as a contextTerm so
  // matchEvidence() can still surface it when a project_brief happens to name the borough in its
  // own text (common in ZAP data), without ever guessing a fallback "unknown" match for it.
  const contextTerms = boro ? [boro] : [];
  $("#llist").innerHTML=head+lRows.map((r,i)=>landRowHTML(r,i,terms,contextTerms)).join("");
  document.querySelectorAll("#llist .row").forEach(el=>el.addEventListener("click",()=>landSelect(+el.dataset.i, el)));
  // Warm outcomes for the visible list (edge KV prewarm + session cache) so the first
  // select paints decision docs without the cold multi-second spinner.
  prefetchZapOutcomesForList(lRows);
  if(autoSelect !== false) document.querySelector("#llist .row")?.click();
}

async function geocode(q){
  try{
    const r=await fetch(`${GEO}?size=1&text=${encodeURIComponent(q)}`);
    const j=await r.json(); const f=j.features&&j.features[0];
    if(f&&f.geometry){const p=f.properties||{}; const pad=(p.addendum&&p.addendum.pad)||{}; return {lat:f.geometry.coordinates[1],lon:f.geometry.coordinates[0],label:p.label,borough:p.borough,neighbourhood:p.neighbourhood,bbl:pad.bbl};}
  }catch(e){}
  return null;
}

async function landSelect(i, el){
  const selection=++landSelectionSeq;
  const itemCard=$("#land-item-card");
  if(itemCard) itemCard.hidden=false;
  setLandStatus();
  document.querySelectorAll("#llist .row.sel").forEach(e=>e.classList.remove("sel"));
  el.classList.add("sel");
  const r=lRows[i];
  const displayTitle=landProjectDisplayTitle(r);
  if(landMap){ try{landMap.remove();}catch(e){} landMap=null; landMarker=null; }
  const ZAPACT_KEY={ZM:"zapact_zm",ZR:"zapact_zr",ZA:"zapact_za",ZC:"zapact_zc",ZS:"zapact_zs",HA:"zapact_ha",PC:"zapact_pc",PQ:"zapact_pc",HG:"zapact_hg"};
  const actList=(r.actions||"").split(/[;,]/).map(a=>ZAPACT_KEY[a.trim()]?t(ZAPACT_KEY[a.trim()]):(a.trim()||null)).filter(Boolean);
  let html=(location.hash.startsWith("#land/")
    ? `<p style="margin:4px 0 12px">${routeBackHTML("#land")}</p>`
    : "")+`<h2 class="rolename" lang="en" dir="ltr">${escUiHtml(displayTitle)}</h2>
    <div class="badges">
      <span class="tag ${r.project_status==='Active'?'open':'closed'}">${r.public_status||r.project_status||t("status_na")}</span>
      ${mihOn(r.mih_flag)?`<span class="tag soon">${t("mih_tag")}</span>`:''}
    </div>
    <div class="agencybar">
      <div><div class="big" style="font-size:17px">${r.primary_applicant||"—"}</div><div class="lbl">${t("applicant_lbl")}</div></div>
      <div><div class="big" style="font-size:17px">${r.borough||""}${r.community_district?" · CD "+r.community_district:""}${r.cc_district?" · "+t("council_district_short",{n:r.cc_district}):""}</div><div class="lbl">${t("where_lbl")}</div></div>
    </div>`;
  if(r.project_brief) html+=`<div class="scope" id="land-brief"><span class="lbl">${t("in_plain_english")}</span>${excerptHtml(r.project_brief,900)}</div>`;
  else html+=`<div class="scope" id="land-brief" hidden></div>`;
  if(actList.length) html+=`<div class="rmeta2" style="margin-top:10px"><b>${t("actions_lbl")}</b> ${actList.join(" · ")}</div>`;
  const area=(r.project_name||r.borough||"").replace(/(rezoning|demapping|rezone|special permit|special district|text amendment|mapping actions?|modification|disposition|non-?ulurp).*/i,"").trim().split(/\s+/).slice(0,3).join(" ")||r.borough||"";
  // Action rail first (what can I do now); utility controls stay secondary.
  html+=`<div id="land-actions" class="next-action-rail-host"></div>
  <div class="actions" style="margin-top:12px">
    ${landPermalinkActionHTML(r)}
    <a class="act" href="https://zap.planning.nyc.gov/projects/${r.project_id}" ${EXT_ATTRS}>${t("zap_full_project")}${extSR()}</a>
    <button class="act" type="button" id="landalert" data-q="${area.replace(/"/g,'')}">${t("alert_me_area")}</button>
    <a class="act" id="crfind" href="https://a856-cityrecord.nyc.gov/Search/Advanced" ${EXT_ATTRS}>${t("search_city_record")}${extSR()}</a>
  </div>
  <div id="project-connections"></div>
  <div id="land-outcomes" class="land-outcomes">${landOutcomeFirstPaintHTML(r)}</div>
  <div id="landmap" style="display:none"></div>
  <div id="landpan" class="map-pan-controls" role="group" aria-label="${t("map_pan_group_aria")}" hidden>
    <button type="button" data-map-pan="west" aria-controls="landmap" aria-label="${t("map_pan_west")}">←</button>
    <button type="button" data-map-pan="north" aria-controls="landmap" aria-label="${t("map_pan_north")}">↑</button>
    <button type="button" data-map-pan="south" aria-controls="landmap" aria-label="${t("map_pan_south")}">↓</button>
    <button type="button" data-map-pan="east" aria-controls="landmap" aria-label="${t("map_pan_east")}">→</button>
  </div>
  <div class="note" id="landmapnote"><span class="loading"></span> ${t("locating")}</div>`;
  $("#ldetail").innerHTML=html;
  // List snapshots omit project_brief; hydrate once from Open Data when detail opens.
  if(!r.project_brief && r.project_id){
    api(ZAP,{"$select":ZAP_SELECT,"$where":`project_id='${String(r.project_id).replace(/'/g,"''")}'`,"$limit":"1"})
      .then(rows=>{
        if(selection!==landSelectionSeq) return;
        const full=rows&&rows[0];
        if(!full||!full.project_brief) return;
        r.project_brief=full.project_brief;
        if(full.actions!=null) r.actions=full.actions;
        const brief=$("#land-brief");
        if(brief){
          brief.hidden=false;
          brief.innerHTML=`<span class="lbl">${t("in_plain_english")}</span>${excerptHtml(full.project_brief,900)}`;
        }
      })
      .catch(()=>{});
  }
  // Immediate rail from list row (ZAP status + portal); hydrates again when outcomes load.
  paintLandActionRail($("#land-actions"), r, null, null);
  loadZapOutcomes(r, $("#land-outcomes"), selection);
  const landURL=landLink(r.project_id);
  const lc=$("#landcopy"); if(lc) lc.addEventListener("click",()=>copyText(landURL, lc));
  bindQRShare($("#landqr"), landURL);
  const la=$("#landalert"); if(la) la.addEventListener("click",()=>landToAlert(la.dataset.q));
  const crterm=cleanText(r.project_name||"").replace(/\b(rezoning|demapping|rezone|special permit|special district|text amendment|mapping actions?|modification|disposition|non-?ulurp|public hearing|notice)\b/ig," ").replace(/\s+/g," ").trim();
  if(crterm.length>3){ soda({"$select":"request_id","$where":"section_name='Public Hearings and Meetings'","$q":crterm,"$order":"start_date DESC","$limit":"1"}).then(rows=>{ if(selection!==landSelectionSeq) return; const cr=$("#crfind"); if(cr&&rows&&rows[0]){ cr.href=REQ_URL(rows[0].request_id); cr.innerHTML=t("rezoning_notice_link")+extSR(); } }).catch(()=>{}); }
  let drew=false;
  try{
    const bblRows=await api(ZAPBBL,{"$select":"bbl","$where":`project_id='${(r.project_id||"").replace(/'/g,"''")}'`,"$limit":"40"});
    const bbls=[...new Set(bblRows.map(b=>b.bbl).filter(Boolean))].slice(0,25);
    if(bbls.length){
      const gj=await fetch(`https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query?where=BBL%20IN%20(${bbls.join(",")})&returnGeometry=true&outSR=4326&outFields=BBL&f=geojson`).then(x=>x.json()).catch(()=>null);
      if(selection!==landSelectionSeq) return;
      if(gj&&gj.features&&gj.features.length){ landShowLots(gj, gj.features.length, selection); drew=true; }
    }
  }catch(e){}
  if(selection!==landSelectionSeq) return;
  if(!drew){
    const q=(r.project_name||"").replace(/rezoning|special (mixed use )?district|text amendment|\bnos?\.?\b/ig," ").replace(/\s+/g," ").trim();
    const geo = q ? await geocode(q+" "+(r.borough||"")+" New York") : null;
    if(selection!==landSelectionSeq) return;
    if(geo) landShowMap(geo.lat,geo.lon,geo.label,selection);
    else { const c=BORO_CENTER[r.borough]; if(c) landShowMap(c[0],c[1],t("lot_not_geocoded",{boro:r.borough||""}),selection); else { $("#landmap").style.display="none"; $("#landmapnote").textContent=t("location_not_resolved"); } }
  }
}

function landPermalinkActionHTML(r){
  return r && r.project_id
    ? `<button class="act" type="button" id="landcopy">${t("copy_link")}</button>${qrButtonHTML("landqr","act")}`
    : "";
}

function renderLandEntryNotFound(id){
  unbusy("#llist");
  if(landMap){ try{landMap.remove();}catch(e){} landMap=null; landMarker=null; }
  $("#llist").innerHTML="";
  const card=$("#land-item-card");
  if(card) card.hidden=false;
  $("#ldetail").innerHTML=`<p>${routeBackHTML("#land")}</p>`;
  setLandResultCount(0);
}

async function showLandEntry(id){
  landSelectionSeq++; // invalidate any map/detail hydration still finishing for the prior entry
  landLoaded=true; // suppress the ordinary list fetch while the exact project loads
  showTab("land");
  landBorough="";
  landAttendance="";
  $("#lkw").value="";
  // A project deep link is still part of the default review view; retain the
  // lens default so the surrounding route state remains stable while detail loads.
  $("#lstatus").value="active";
  await syncLandLensControls();
  $("#lreshead").textContent=t("rezonings_heading");
  $("#lrescount").textContent="";
  setLandStatus();
  landBanner="";
  const stale=staleGuard("land");
  if(!id){ renderLandEntryNotFound(id); return; }
  busyList("#llist", 1);
  $("#ldetail").innerHTML=listSkeleton(1);
  let rows;
  try{
    rows=await api(ZAP,{"$select":ZAP_SELECT,"$where":`project_id='${String(id).replace(/'/g,"''")}'`,"$limit":"1"});
  }catch(e){
    if(!stale()){
      unbusy("#llist");
      $("#llist").innerHTML="";
      clearLandDetail();
      setLandStatus(t("could_not_reach"));
    }
    return;
  }
  if(stale()) return;
  unbusy("#llist");
  if(!rows.length){ renderLandEntryNotFound(id); return; }
  lRows=rows;
  setLandResultCount(1);
  landRenderList("", true, "", false);
  const row=$("#llist").querySelector(".row");
  if(row){
    const selection=landSelect(0,row);
    focusItemRouteTarget($("#land-item-card"));
    applyActiveHistoryRouteScroll();
    await selection;
  }
}

/* Leaflet loads on demand: the map is a detail of one lens, not a cost every visitor pays.
   showTab("land") warms it in the background, so it's usually ready before a row is picked. */
let leafletP=null;
function loadLeaflet(){
  if(window.L) return Promise.resolve();
  if(!leafletP) leafletP = new Promise((res,rej)=>{
    const l=document.createElement("link"); l.rel="stylesheet"; l.href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(l);
    const s=document.createElement("script"); s.src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.onload=res; s.onerror=()=>{ leafletP=null; rej(new Error("leaflet")); };
    document.head.appendChild(s);
  });
  return leafletP;
}
// WCAG 2.2 SC 2.5.7: Leaflet supports drag-to-pan, so expose the same map movement as
// four ordinary single-pointer buttons. Keyboard panning remains Leaflet's responsibility.
function wireLandPanControls(map){
  const controls=$("#landpan"); if(!controls) return;
  const offsets={west:[-80,0],north:[0,-80],south:[0,80],east:[80,0]};
  controls.hidden=false;
  controls.querySelectorAll("[data-map-pan]").forEach(button=>{
    button.addEventListener("click",()=>map.panBy(offsets[button.dataset.mapPan],{animate:false}));
  });
}
async function landShowMap(lat, lon, label, selection){
  const el=$("#landmap"); if(!el) return; el.style.display="none";
  $("#landmapnote").innerHTML=t("map_approx_note_html",{label});
  try{ await loadLeaflet(); }catch(e){}
  if(selection!==undefined && selection!==landSelectionSeq) return;
  if(typeof L==="undefined"){
    const controls=$("#landpan"); if(controls) controls.hidden=true;
    return;
  }
  el.style.display="block";
  landMap=L.map(el).setView([lat,lon],15);
  wireLandPanControls(landMap);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{attribution:'© OpenStreetMap © CARTO',subdomains:'abcd',maxZoom:19}).addTo(landMap);
  // w9-10: Leaflet's marker icon renders as an <img> -- `alt` is its accessible name
  // (the list view, #llist, remains the real keyboard/SR-equivalent; this is a small assist).
  landMarker=L.marker([lat,lon],{alt:label||t("map_marker_alt")}).addTo(landMap);
  if(label) landMarker.bindPopup(label).openPopup();
  setTimeout(()=>{ if(landMap) landMap.invalidateSize(); },150);
}

async function landShowLots(gj, n, selection){
  const el=$("#landmap"); if(!el) return; el.style.display="none";
  $("#landmapnote").innerHTML=t("showing_lots_note_html",{n, s:n===1?"":"s"});
  try{ await loadLeaflet(); }catch(e){}
  if(selection!==undefined && selection!==landSelectionSeq) return;
  if(typeof L==="undefined"){
    const controls=$("#landpan"); if(controls) controls.hidden=true;
    return;
  }
  el.style.display="block";
  landMap=L.map(el);
  wireLandPanControls(landMap);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{attribution:'© OpenStreetMap © CARTO · lots © NYC MapPLUTO',subdomains:'abcd',maxZoom:19}).addTo(landMap);
  const layer=L.geoJSON(gj,{style:{color:'#1a44e0',weight:2,fillColor:'#1b3a8f',fillOpacity:.35}}).addTo(landMap);
  try{ landMap.fitBounds(layer.getBounds(),{padding:[20,20],maxZoom:17}); }catch(e){ landMap.setView([40.71,-73.96],12); }
  setTimeout(()=>{ if(landMap) landMap.invalidateSize(); },160);
}

function landToAlert(term){
  const keywords = term ? [String(term).toLowerCase().trim()].filter(Boolean) : [];
  import("../alerts_context_carry.mjs")
    .then(carry=>location.assign(carry.alertsHref({lens:"land",filter:{keywords,status:"all"}})))
    .catch(()=>location.assign("/following/"));
}


/* ===================== ZAP LAND OUTCOMES (decision docs + DOB side-car) =====================
   Precompute-first: GET /zap-outcomes?id= — no live ZAP API or DOB Socrata from the browser.
   Project timeline is phase-grouped (ULURP) via site/land_phase_spine.mjs — compact stepper
   by default; aggregates + disclosure keep every date reachable; one project portal link. */
let landPhaseSpineToolsPromise=null;
function ensureLandPhaseSpineTools(){
  if(!landPhaseSpineToolsPromise){
    landPhaseSpineToolsPromise=Promise.all([
      import("../land_phase_spine.mjs").catch(()=>null),
      import("../ulurp_statutory_clock.mjs").catch(()=>null),
    ]).then(([phase, clock])=>{
      if(clock&&typeof clock.buildUlurpPipelinePosition==="function"){
        globalThis.buildUlurpPipelinePosition=clock.buildUlurpPipelinePosition;
      }
      if(clock&&typeof clock.normalizeLandOutcomeRecord==="function"){
        globalThis.normalizeLandOutcomeRecord=clock.normalizeLandOutcomeRecord;
      }
      if(clock&&typeof clock.buildUlurpStatutoryClockView==="function"){
        globalThis.buildUlurpStatutoryClockView=clock.buildUlurpStatutoryClockView;
      }
      return phase;
    });
  }
  return landPhaseSpineToolsPromise;
}
/** Rebuild stale-open statutory clocks so Completed projects never show overdue public-review steps. */
function normalizeLandRecord(record){
  if(!record||typeof record!=="object") return record;
  const norm=typeof normalizeLandOutcomeRecord==="function"
    ? normalizeLandOutcomeRecord
    : (globalThis.normalizeLandOutcomeRecord||null);
  if(norm){
    try{ return norm(record); }catch(_e){ return record; }
  }
  return record;
}
function landPhaseLabel(phase){
  if(!phase) return "—";
  const key=phase.label_key || (typeof phase==="string"?null:null);
  if(phase.label_key) return t(phase.label_key);
  if(typeof phase==="string"){
    const meta={
      pre_application:"land_phase_pre_application",
      environmental:"land_phase_environmental",
      pre_certification:"land_phase_pre_certification",
      certification:"land_phase_certification",
      community_board:"land_phase_community_board",
      borough_president:"land_phase_borough_president",
      cpc:"land_phase_cpc",
      city_council:"land_phase_city_council",
      mayoral_appeals:"land_phase_mayoral_appeals"
    };
    return meta[phase]?t(meta[phase]):phase;
  }
  return phase.short || "—";
}
function landSpineLagHTML(lag){
  lag=lag||{};
  if(lag.status==="behind"){
    return `<div class="note warn">${t("land_spine_lag_behind_html",{
      days:String(lag.days), open_date:fdate(lag.open_data_date), portal_date:fdate(lag.portal_date)
    })}</div>`;
  }
  if(lag.status==="aligned"){
    return `<div class="note">${t("land_spine_lag_aligned_html",{
      open_date:fdate(lag.open_data_date), portal_date:fdate(lag.portal_date)
    })}</div>`;
  }
  return `<div class="note">${t("land_spine_lag_unknown")}</div>`;
}
function landSpineGapsHTML(_gaps){
  // Source gaps are metadata, not reader-facing content. Unpublished phases stay absent.
  return "";
}
/** Per-event row for chronological disclosure — never repeats the project portal URL. */
function landSpineEventRowHTML(event, portalUrl, isPortalUrl){
  const planned=event.time?.certainty==="planned" || /not started/i.test(String(event.detail||event.status||""));
  const sourceURL=event.source?.url;
  const sourceLabel=event.source?.label || "—";
  const dup=typeof isPortalUrl==="function"
    ? isPortalUrl(sourceURL, portalUrl)
    : (portalUrl && sourceURL && String(sourceURL).replace(/\/+$/,"")===String(portalUrl).replace(/\/+$/,""));
  let sourceHTML="";
  if(sourceURL && !dup){
    sourceHTML=`<a class="land-spine-source" href="${escUiHtml(sourceURL)}" ${EXT_ATTRS}>${escUiHtml(sourceLabel)}${extSR()}</a>`;
  }
  return `<div class="land-spine-event${planned?" planned":""}">
    <div class="land-spine-date">${event.time?.value?fdate(event.time.value):"—"}${planned?` · ${t("land_spine_planned")}`:""}</div>
    <div class="land-spine-title" lang="en" dir="ltr">${escUiHtml(event.title || "—")}</div>
    ${event.detail?`<div class="land-spine-detail" lang="en" dir="ltr">${escUiHtml(event.detail)}</div>`:""}
    ${sourceHTML}
  </div>`;
}
function landPhaseAggregateHTML(agg, phaseId, idx){
  if(!agg) return "";
  if(agg.count===1){
    const e=agg.members[0]||{};
    const planned=e.time?.certainty==="planned" || /not started/i.test(String(e.detail||e.status||""));
    return `<div class="land-phase-row">
      <div class="land-phase-row-title" lang="en" dir="ltr">${escUiHtml(agg.title)}</div>
      <div class="land-phase-row-meta">${agg.first?fdate(agg.first):"—"}${planned?` · ${t("land_spine_planned")}`:""}${e.detail?` · ${escUiHtml(e.detail)}`:""}</div>
    </div>`;
  }
  const listId=`land-agg-${phaseId}-${idx}`;
  const statusTxt=(agg.statuses||[]).filter(Boolean).join(", ");
  return `<div class="land-phase-agg">
    <div class="land-phase-agg-title" lang="en" dir="ltr">${escUiHtml(agg.title)}<span class="land-phase-count">×${agg.count}</span></div>
    <div class="land-phase-agg-meta">${agg.first&&agg.last?t("land_spine_aggregate_range",{first:fdate(agg.first),last:fdate(agg.last)}):(agg.first?fdate(agg.first):"—")}${statusTxt?` · ${escUiHtml(statusTxt)}`:""}</div>
    <button type="button" class="land-phase-toggle" data-land-dates="${listId}" aria-expanded="false">${t("land_spine_show_dates",{n:String(agg.count)})}</button>
    <ul class="land-phase-dates" id="${listId}">
      ${(agg.members||[]).map(m=>`<li>${m.time?.value?fdate(m.time.value):"—"}${m.detail?` · ${escUiHtml(m.detail)}`:""}</li>`).join("")}
    </ul>
  </div>`;
}
/** Statutory deadline note for one ULURP phase (precomputed on the outcome record). */
function landStatutoryDeadlineHTML(phaseId, clock, phaseState){
  if(!clock || clock.status==="ineligible") return "";
  // Terminal clocks: historical due dates only — no "testify before deadline" action frame.
  if(clock.status==="completed" || clock.status==="withdrawn") return "";
  const row=(clock.phases||[]).find(p=>p.phase_id===phaseId);
  if(!row || !row.due_date) return "";
  if(row.status && row.status!=="open") return "";
  const stageName=landPhaseLabel({label_key:row.label_key, id:phaseId});
  const deadline=t("land_spine_statutory_deadline_html",{
    stage:escUiHtml(stageName),
    n:String(row.days),
    date:fdate(row.due_date)
  });
  // Action frame: before a board/commission concludes, the hearing is the last chance to testify.
  const actionHint=(phaseId==="community_board"||phaseId==="city_council"||phaseId==="cpc")
    && phaseState!=="passed"
    && clock.status!=="withdrawn"
    ? ` ${t("land_spine_statutory_testify_hint")}`
    : "";
  const withdrawn=clock.status==="withdrawn"
    ? ` ${t("land_spine_statutory_withdrawn_note")}`
    : "";
  return `<div class="note land-statutory-deadline" data-land-statutory-phase="${escUiHtml(phaseId)}" data-land-statutory-due="${escUiHtml(row.due_date)}" data-land-statutory-status="${escUiHtml(clock.status||"open")}">${deadline}${actionHint}${withdrawn} <span class="tag renewal">${t("cadence_estimate_tag")}</span></div>`;
}
function landApplicantConditionedHTML(stats){
  const ac=stats?.applicant_conditioned;
  if(!ac || !ac.n || ac.n < 20 || ac.outcome_rates?.approved==null) return "";
  const baseApproved=ac.base_rate?.approved!=null
    ? Math.round(Number(ac.base_rate.approved)*100)
    : (stats.outcome_rates?.approved!=null ? Math.round(Number(stats.outcome_rates.approved)*100) : null);
  if(baseApproved==null) return ""; // never show conditioned without the base rate
  const year=String(ac.train_from||"").slice(0,4)||"—";
  const approved=Math.round(Number(ac.outcome_rates.approved||0)*100);
  const mode=ac.render_mode||"descriptive_history";
  const conf=ac.link_confidence?.status;
  const confLabel=conf==="strong"
    ? t("land_applicant_link_strong")
    : conf==="tentative"
      ? t("land_applicant_link_tentative")
      : "";
  const confChip=confLabel
    ? `<span class="applicant-conf" data-link-confidence="${escUiHtml(conf)}">${escUiHtml(confLabel)}</span>`
    : "";
  const lineKey=mode==="per_matter"
    ? "land_applicant_conditioned_predict_html"
    : "land_applicant_conditioned_history_html";
  return `<div class="applicant-conditioned" data-applicant-conditioned="1" data-prediction-subject="land-use-approval" data-prediction-value="${escUiHtml(String(approved))}-percent" data-applicant-n="${escUiHtml(String(ac.n))}" data-applicant-render-mode="${escUiHtml(mode)}">
    <p>${t(lineKey,{
      n:String(ac.n),
      year,
      p:String(approved),
      p0:String(baseApproved)
    })}${confChip}</p>
    <p class="base-rate-authority">${t("land_applicant_conditioned_authority_html",{
      link:`<a href="${escUiHtml(ac.formula_url||t("land_applicant_conditioned_formula_url"))}">${t("land_applicant_conditioned_formula_link")}</a>`
    })}</p>
  </div>`;
}
function landZoningStatisticsHTML(record){
  const stats=record?.zoning_statistics;
  if(!stats || !stats.n || stats.outcome_rates?.approved==null) return "";
  const code=String(stats.action_type||"").toLowerCase();
  const actionKey=code?`zapact_${code}`:"";
  const translated=actionKey?t(actionKey):"";
  const actionLabel=translated&&translated!==actionKey?translated:t("land_zoning_base_rate_generic_type");
  const year=String(stats.train_from||"").slice(0,4)||"—";
  const approved=Math.round(Number(stats.outcome_rates.approved||0)*100);
  const modified=Math.round(Number(stats.outcome_rates.modified||0)*100);
  const disapproved=Math.round(Number(stats.outcome_rates.disapproved||0)*100);
  const applicantBlock=landApplicantConditionedHTML(stats);
  const applicantMode=stats.applicant_conditioned?.render_mode||"";
  return `<aside class="land-base-rate-register" data-zoning-base-rate="1" data-applicant-render-mode="${escUiHtml(applicantMode)}" aria-label="${escUiHtml(t("land_zoning_base_rate_heading"))}">
    <div class="base-rate-kicker">${t("land_zoning_base_rate_heading")}</div>
    <p>${t("land_zoning_base_rate_html",{
      n:String(stats.n),type:escUiHtml(actionLabel),year,approved:String(approved),
      low:String(stats.typical_months?.low??"—"),high:String(stats.typical_months?.high??"—")
    })}</p>
    <p class="base-rate-outcomes">${t("land_zoning_base_rate_outcomes",{
      approved:String(approved),modified:String(modified),disapproved:String(disapproved)
    })}</p>
    ${applicantBlock}
    <p class="base-rate-authority">${t("land_zoning_base_rate_authority_html",{
      link:`<a href="${escUiHtml(stats.formula_url||t("land_zoning_base_rate_formula_url"))}">${t("land_zoning_base_rate_formula_link")}</a>`
    })}</p>
  </aside>`;
}
/** One-sentence ULURP public-review pipeline position (overall status + current step). */
function landPipelinePositionHTML(view, record){
  const build=typeof buildUlurpPipelinePosition==="function"
    ? buildUlurpPipelinePosition
    : (globalThis.buildUlurpPipelinePosition||null);
  if(!build) return null;
  let pos=null;
  try{
    pos=build({
      phaseView:view,
      clock:record?.statutory_clock||null,
      publicStatus:record?.public_status||view?.current?.public_status||null,
      today:typeof todayISO==="function"?todayISO():new Date().toISOString().slice(0,10),
    });
  }catch(_e){ return null; }
  if(!pos||!pos.step_n) return null;
  const stageName=landPhaseLabel({label_key:pos.step_label_key, id:pos.step_phase_id});
  const windowDays=pos.window_days!=null?String(pos.window_days):"—";
  let clockBit="";
  if(pos.days_left!=null&&Number.isFinite(pos.days_left)){
    if(pos.days_left>0){
      clockBit=t("land_pipeline_clock_days_left",{n:String(pos.window_days||""),left:String(pos.days_left)});
    }else if(pos.days_left===0){
      clockBit=t("land_pipeline_clock_due_today",{n:windowDays});
    }else{
      clockBit=t("land_pipeline_clock_overdue",{n:windowDays,over:String(Math.abs(pos.days_left))});
    }
  }else if(pos.window_days!=null){
    clockBit=t("land_pipeline_clock_window_only",{n:windowDays});
  }
  const sentence=t("land_pipeline_position_html",{
    step:String(pos.step_n),
    total:String(pos.step_m),
    stage:escUiHtml(stageName),
    clock:clockBit,
  });
  return `<p class="land-pipeline-position" data-land-pipeline-step="${escUiHtml(String(pos.step_n))}" data-land-pipeline-total="${escUiHtml(String(pos.step_m))}" data-land-pipeline-phase="${escUiHtml(pos.step_phase_id||"")}">${sentence}</p>`;
}
function landPhaseSpineHTML(view, tools, record){
  if(!view || !view.event_count) return "";
  const isPortalUrl=tools?.isProjectPortalUrl;
  record=normalizeLandRecord(record);
  const clock=record?.statutory_clock || null;
  const portal=view.portal_url
    ? `<a class="view land-spine-portal" href="${escUiHtml(view.portal_url)}" ${EXT_ATTRS}>${t("land_spine_portal_link")}${extSR()}</a>`
    : "";
  const cur=view.current||{};
  const phaseName=landPhaseLabel({label_key:cur.label_key});
  const pipelineHTML=landPipelinePositionHTML(view, record);
  let statusExtra="";
  // When the pipeline sentence already joins overall public review + current step,
  // skip the competing "Public status: In Public Review" line.
  if(pipelineHTML){
    statusExtra="";
  }else if(cur.noticed && !cur.in_public_review){
    statusExtra=t("land_spine_status_noticed_html");
  }else if(cur.public_status){
    statusExtra=t("land_spine_status_public_html",{status:escUiHtml(cur.public_status)});
  }
  const lead=`<div class="land-spine-lead">
    <div class="land-spine-now-label">${t("land_spine_now_label")}</div>
    ${pipelineHTML||`<p class="land-spine-now-phase">${escUiHtml(phaseName)}</p>`}
    <p class="land-spine-now-detail" lang="en" dir="ltr">${escUiHtml(cur.milestone_label || "—")}${cur.since?` · ${t("land_spine_since",{date:fdate(cur.since)})}`:""}${statusExtra?`<br>${statusExtra}`:""}</p>
    ${view.next?`<p class="land-spine-next">${t("land_spine_next_html",{phase:escUiHtml(landPhaseLabel(view.next))})}</p>`:""}
  </div>`;
  const stepper=`<ol class="land-phase-stepper lc-stepper" aria-label="${escUiHtml(t("land_spine_heading"))}">${
    (view.phases||[]).map((p,i)=>{
      const cls=p.state==="current"?"current":p.state==="passed"?"passed":"future";
      const aria=p.state==="current"?` aria-current="step"`:"";
      const arrow=i<(view.phases.length-1)?`<span class="land-phase-arrow lc-step-arrow" aria-hidden="true">→</span>`:"";
      return `<li><button type="button" class="land-phase-step lc-step ${cls}" data-land-phase="${escUiHtml(p.id)}"${aria} title="${escUiHtml(landPhaseLabel(p))}">${escUiHtml(p.short||landPhaseLabel(p))}</button>${arrow}</li>`;
    }).join("")
  }</ol>`;
  const panels=(view.phases||[]).map(p=>{
    const open=p.state==="current"?" open":"";
    const stateWord=p.state==="current"?t("land_spine_phase_current"):p.state==="passed"?t("land_spine_phase_done"):t("land_spine_phase_future");
    const statutoryRow=(clock&&clock.status!=="ineligible")
      ? (clock.phases||[]).find(s=>s.phase_id===p.id)
      : null;
    let summary="";
    if(p.state==="future"){
      if(p.first){
        summary=p.last&&p.last!==p.first
          ? t("land_spine_planned_window",{first:fdate(p.first),last:fdate(p.last)})
          : t("land_spine_planned_window_one",{date:fdate(p.first)});
      }else if(statutoryRow?.due_date){
        summary=t("land_spine_statutory_due_summary",{date:fdate(statutoryRow.due_date)});
      }else summary=t("land_spine_phase_empty");
    }else{
      const notes=(p.aggregates||[]).filter(a=>a.count>=2).map(a=>`${a.title} ×${a.count}`).join(" · ");
      const parts=[
        p.event_count?t("land_spine_milestones_count",{n:String(p.event_count)}):"",
        p.first&&p.last?t("land_spine_aggregate_range",{first:fdate(p.first),last:fdate(p.last)}):(p.first?fdate(p.first):""),
        notes
      ].filter(Boolean);
      if(statutoryRow?.due_date && p.state==="current"){
        parts.push(t("land_spine_statutory_due_summary",{date:fdate(statutoryRow.due_date)}));
      }
      summary=parts.join(" · ") || t("land_spine_phase_empty");
    }
    const statutory=landStatutoryDeadlineHTML(p.id, clock, p.state);
    const body=(p.aggregates||[]).map((a,idx)=>landPhaseAggregateHTML(a,p.id,idx)).join("")
      || `<div class="land-phase-row"><div class="land-phase-row-meta">${t("land_spine_phase_empty")}</div></div>`;
    return `<details class="land-phase${p.state==="current"?" current-phase":""}"${open} id="land-phase-${escUiHtml(p.id)}" data-land-phase-panel="${escUiHtml(p.id)}">
      <summary>
        <span class="land-phase-name">${escUiHtml(landPhaseLabel(p))}</span>
        <span class="land-phase-state">${escUiHtml(stateWord)}</span>
        <span class="land-phase-summary" lang="en" dir="ltr">${escUiHtml(summary)}</span>
      </summary>
      <div class="land-phase-body">${statutory}${body}</div>
    </details>`;
  }).join("");
  const chrono=(view.chronological||[]).map(e=>landSpineEventRowHTML(e, view.portal_url, isPortalUrl)).join("");
  const how=`<details class="land-spine-how lc-how">
    <summary>${t("land_spine_show_all")}</summary>
    <div class="land-spine land-spine-chrono">${chrono}</div>
  </details>
  <details class="land-spine-how lc-how">
    <summary>${t("land_spine_how_summary")}</summary>
    <div class="land-spine-how-body">${t("land_spine_how_html")}</div>
  </details>`;
  const lagHTML=landSpineLagHTML(view.lag?.open_data_vs_portal || {});
  const gaps=landSpineGapsHTML(view.gaps);
  const baseRate=landZoningStatisticsHTML(record);
  return `<div class="chain-h">${t("land_spine_heading")}</div>${portal}${lead}${stepper}${panels}${baseRate}${how}${lagHTML}${gaps}`;
}
/** Flat fallback if phase module fails to load — still dedupes project portal links. */
function landSpineHTMLFlat(spine, record){
  if(!spine) return "";
  const portalUrl=record?.portal_url || null;
  const events=Array.isArray(spine.events)?spine.events:[];
  if(!events.length) return "";
  const portal=portalUrl
    ? `<a class="view land-spine-portal" href="${escUiHtml(portalUrl)}" ${EXT_ATTRS}>${t("land_spine_portal_link")}${extSR()}</a>`
    : "";
  const rail=events.map(e=>landSpineEventRowHTML(e, portalUrl, null)).join("");
  return `<div class="chain-h">${t("land_spine_heading")}</div>${portal}${landSpineLagHTML(spine.lag?.open_data_vs_portal||{})}${rail?`<div class="land-spine">${rail}</div>`:""}${landSpineGapsHTML(spine.gaps)}`;
}
function landSpineHTML(spine, record, phaseTools){
  if(!spine) return "";
  if(phaseTools && typeof phaseTools.buildLandPhaseView==="function"){
    const view=phaseTools.buildLandPhaseView(spine, {
      open_data: record?.open_data || null,
      portal_url: record?.portal_url || null,
      public_status: record?.public_status || record?.open_data?.public_status || null,
      project_id: record?.project_id || spine.project_id || null
    });
    return landPhaseSpineHTML(view, phaseTools, record);
  }
  return landSpineHTMLFlat(spine, record);
}
function bindLandSpineUI(root){
  if(!root || root.dataset.landSpineBound==="1") return;
  root.dataset.landSpineBound="1";
  root.addEventListener("click", (ev)=>{
    const step=ev.target.closest?.("[data-land-phase]");
    if(step && root.contains(step)){
      const id=step.getAttribute("data-land-phase");
      const panel=root.querySelector(`[data-land-phase-panel="${CSS.escape(id)}"]`);
      if(panel){
        panel.open=true;
        try{ panel.scrollIntoView({behavior:"smooth", block:"nearest"}); }catch(_e){}
      }
      return;
    }
    const btn=ev.target.closest?.("[data-land-dates]");
    if(btn && root.contains(btn)){
      const listId=btn.getAttribute("data-land-dates");
      const list=listId?root.querySelector("#"+CSS.escape(listId)):null;
      if(!list) return;
      const show=!list.classList.contains("show");
      list.classList.toggle("show", show);
      btn.setAttribute("aria-expanded", show?"true":"false");
      const n=list.children.length;
      btn.textContent=show?t("land_spine_hide_dates"):t("land_spine_show_dates",{n:String(n)});
    }
  });
}

function landOutcomesHTML(record, phaseTools){
  if(!record) return "";
  record=normalizeLandRecord(record);
  const spineHTML=landSpineHTML(record.spine, record, phaseTools);
  const join = record.join || {};
  if(!join.matched || !record.filled) return `${spineHTML}${landOutcomeAbsentHTML(record)}`;
  const actions = Array.isArray(record.approved_actions) ? record.approved_actions : [];
  const dispositions = Array.isArray(record.dispositions) ? record.dispositions : [];
  const documents = Array.isArray(record.documents) ? record.documents : [];
  let actionHTML = "";
  if(actions.length){
    actionHTML = actions.slice(0, 8).map(a =>
      `<div class="stage"><div class="box matched">
        <div class="stage-name">${t("land_outcomes_action_lbl")}</div>
        <div class="when">${escUiHtml(a.status || "—")}</div>
        <div class="lc-pct" lang="en" dir="ltr">${escUiHtml([a.action, a.ulurp_number].filter(Boolean).join(" · ") || "—")}</div>
      </div></div>`
    ).join("");
  }
  let dispHTML = "";
  const withOutcome = dispositions.filter(d => d.vote_date || d.community_board || d.borough_president);
  if(withOutcome.length){
    dispHTML = withOutcome.slice(0, 6).map(d => {
      const rec = d.community_board || d.borough_president || d.borough_board || "—";
      const vote = d.vote_date ? fdate(d.vote_date) : "—";
      const tally = (d.votes_for != null || d.votes_against != null)
        ? t("land_outcomes_vote_tally_html", {
            favor: String(d.votes_for != null ? d.votes_for : "—"),
            against: String(d.votes_against != null ? d.votes_against : "—")
          })
        : "";
      return `<div class="stage"><div class="box matched">
        <div class="stage-name">${t("land_outcomes_disposition_lbl")}</div>
        <div class="when">${escUiHtml(vote)}</div>
        ${Array.isArray(d.action_codes) && d.action_codes.length ? `<div>${d.action_codes.map(code => `<span class="zap-action-chip">${escUiHtml(code)}</span>`).join("")}</div>` : ""}
        <div class="lc-pct" lang="en" dir="ltr">${escUiHtml(d.representing || d.name || "—")}</div>
        <div class="lc-pct">${t("land_outcomes_recommendation_html",{ rec: escUiHtml(rec) })}${tally?` · ${tally}`:""}</div>
      </div></div>`;
    }).join("");
  }
  let docsHTML = "";
  if(documents.length){
    const links = documents.slice(0, 10).map(d => {
      if(!d.url) return "";
      return `<a class="view" href="${escUiHtml(d.url)}" ${EXT_ATTRS}>${escUiHtml(d.name || t("land_outcomes_document_lbl"))}${extSR()}</a>`;
    }).filter(Boolean).join(" · ");
    if(links){
      const docLinks = documents.map(d => {
        if(!d.url) return "";
        return `<a class="view" href="${escUiHtml(d.url)}" ${EXT_ATTRS}>${escUiHtml(d.name || t("land_outcomes_document_lbl"))}${extSR()}</a>`;
      }).filter(Boolean);
      const visibleDocs = docLinks.slice(0, 4).join("");
      const extraDocs = docLinks.length > 4 ? `<details><summary>${t("land_outcomes_documents_lbl")}</summary><div class="zap-docs-list">${docLinks.slice(4).join("")}</div></details>` : "";
      docsHTML = `<div class="note"><b>${t("land_outcomes_documents_lbl")}</b><div class="zap-docs-list">${visibleDocs}</div>${extraDocs}</div>`;
    }
  }
  let dobHTML = "";
  const dob = record.dob || {};
  if(dob.matched && Array.isArray(dob.filings) && dob.filings.length){
    const rows = dob.filings.slice(0, 5).map(f =>
      `<div class="lc-pct" lang="en" dir="ltr">${escUiHtml(f.job_type || "—")} · ${escUiHtml(f.filing_status || "—")}${f.filing_date?` · ${fdate(f.filing_date)}`:""}${f.job_filing_number?` · ${escUiHtml(f.job_filing_number)}`:""}</div>`
    ).join("");
    dobHTML = `<details class="note"><summary><b>${t("land_outcomes_dob_lbl")}</b></summary>${rows}</details>`;
  }
  const portal = record.portal_url
    ? `<a class="view" href="${escUiHtml(record.portal_url)}" ${EXT_ATTRS}>${t("land_outcomes_portal_link")}${extSR()}</a>`
    : "";
  return `<div class="chain-h">${t("land_outcomes_heading")}</div>
    <div class="note">${t("land_outcomes_matched_html",{
      status: escUiHtml(record.public_status || record.open_data?.public_status || "—"),
      n_docs: String(record.n_documents || documents.length || 0)
    })} ${portal}</div>
    ${spineHTML}
    <div class="chain">${actionHTML}${dispHTML}</div>
    ${docsHTML}
    ${dobHTML}
    <div class="note">${t("land_outcomes_provenance_html")}</div>`;
}

function landOutcomeAbsentHTML(record){
  const portal=record?.portal_url
    ? ` <a class="view" href="${escUiHtml(record.portal_url)}" ${EXT_ATTRS}>${t("land_outcomes_portal_link")}${extSR()}</a>`
    : "";
  return `<div class="land-outcomes-absent" data-zap-outcomes-state="absent">
    <div class="chain-h">${t("land_outcomes_heading")}</div>
    <div class="note">${t("land_outcomes_unmatched_html",{reason:t("land_outcomes_unmatched_default")})}${portal}</div>
  </div>`;
}

function landOutcomeFirstPaintHTML(r){
  const hit=r?.project_id?zapOutcomesMemGet(r.project_id):null;
  const record=hit?.data?.record;
  if(!record) return "";
  return landOutcomeSnapshotHTML(record,null);
}
function landOutcomeSnapshotHTML(record,phaseTools){
  const state=record.snapshot_state==="absent"?"absent":"present";
  return `<section data-zap-outcomes-first-paint="1" data-zap-outcomes-state="${state}">${landOutcomesHTML(record,phaseTools)}</section>`;
}

/* Session cache + list prefetch for zap-outcomes. Daily edge prewarm keeps the Worker KV
   warm (~50–200ms), but a same-tab revisit or list→detail click should not re-pay even that
   when the payload is already in memory. Prefetch runs after the land list paints so the
   first selected row (and neighbors) can render without the multi-second cold spinner. */
const ZAP_OUTCOMES_MEM = new Map(), ZAP_OUTCOMES_MEM_TTL = 300000;
let projectConnectionsToolsPromise=null;
function ensureProjectConnectionsTools(){
  if(!projectConnectionsToolsPromise){
    projectConnectionsToolsPromise=import("../project_connections.mjs").catch(()=>null);
  }
  return projectConnectionsToolsPromise;
}
function projectConnectionsCoverageHTML(coverage){
  // Coverage receipts remain available in the evidence payload, not in the
  // reader-facing constellation. Counts such as “231 of 231” describe the
  // build rather than helping someone understand the project.
  return "";
}
function projectConnectionItemHTML(item, projectScope){
  if(item.ref&&/^(?:agency:|vendor:stem:|entity:official:|bbl:)/.test(item.ref)){
    return globalThis.CrolEntityPivots?.entityChipHTML({
      ref:item.ref,
      label:item.label,
      link_confidence:item.confidence,
      relation:item.relation,
      evidence:item.evidence,
    },{scope:projectScope,surface:item.ref.startsWith("bbl:")?"property":"land"})||escUiHtml(item.label||"");
  }
  if(item.href&&String(item.href).startsWith("#")) return pivotA(item.href,cleanText(item.label)||item.href);
  return escUiHtml(item.label||"");
}
function projectConnectionsHTML(evidence, tools){
  if(evidence?.status==="unavailable"){
    return `<div class="eicard project-connections project-connections-unavailable" data-project-connections-state="unavailable" data-project-ref="${escUiHtml(evidence.project_ref||"")}">
      <div class="chain-h">${t("project_connections_heading")}</div>
      <p class="pc-gap">${t("project_connections_gap_source")}</p>
    </div>`;
  }
  if(!evidence||evidence.status!=="bounded"||!tools) return "";
  const view=tools.buildProjectConnectionView(evidence,{currentHash:"#land",language:window.LANG||"en"});
  let projectScope=CrolScope.emptyScope(window.LANG||"en");
  projectScope=CrolScope.scopeWithEntity(projectScope,evidence.project_ref);
  projectScope.facets.domains=["land"];
  const gapLabels={
    applicant_not_published:"project_connections_gap_applicant",
    no_exact_bbl_edge:"project_connections_gap_parcels",
    no_exact_meeting_edge_in_bounded_corpus:"project_connections_gap_meetings",
    decision_documents_not_published:"project_connections_gap_decisions",
    not_published:"project_connections_gap_notices",
    source_unavailable:"project_connections_gap_source",
    no_exact_notice_edge_in_bounded_corpus:"project_connections_gap_notices",
    no_exact_mih_edge_in_bounded_corpus:"project_connections_gap_mih",
  };
  const groups=view.groups.filter(group=>group.status==="matched").map(group=>{
    const itemRows=(group.items||[]).slice(0,12).map(item=>{
      const label=projectConnectionItemHTML(item,projectScope);
      const outcome=item.outcome?` <span class="pc-outcome">${escUiHtml(item.outcome)}</span>`:"";
      const when=item.when?` <span class="pc-when">${fdate(item.when)}</span>`:"";
      const sources=item.source_summary?` <span class="pc-source">${escUiHtml(item.source_summary)}</span>`:"";
      return `<li>${label}${outcome}${when}${sources}</li>`;
    }).join("");
    const docs=(group.documents||[]).filter(doc=>doc.href).slice(0,6).map(doc=>
      `<a class="view" href="${escUiHtml(doc.href)}" ${EXT_ATTRS}>${escUiHtml(doc.label)}${extSR()}</a>`
    ).join("");
    const gapKey=gapLabels[group.gap];
    const empty=!itemRows&&!docs?`<p class="pc-gap">${t(gapKey||"project_connections_gap_bounded")}</p>`:"";
    const docGap=group.id==="decisions"&&group.gap==="decision_documents_not_published"&&itemRows
      ?`<p class="pc-gap">${t("project_connections_gap_decisions")}</p>`:"";
    const viewAll=group.view_all_href
      ?`<a class="ei-view-all" href="${escUiHtml(group.view_all_href)}">${t("entity_intel_view_all_scope")}</a>`:"";
    return `<section class="pc-group" data-project-group="${escUiHtml(group.id)}" data-status="${escUiHtml(group.status)}">
      <h3>${t("project_connections_group_"+group.id)} <span class="ei-status ${group.status==="matched"?"ei-status-matched":""}">${group.status==="matched"?t("entity_intel_status_matched"):t("entity_intel_status_empty")}</span></h3>
      ${itemRows?`<ul>${itemRows}</ul>`:""}${docs?`<div class="pc-docs">${docs}</div>`:""}${empty}${docGap}
      ${projectConnectionsCoverageHTML(group.coverage)}${viewAll}
    </section>`;
  }).join("");
  return `<div class="eicard project-connections" data-project-ref="${escUiHtml(evidence.project_ref)}">
    <div class="ei-heading-row"><div class="chain-h">${t("project_connections_heading")}</div>
      <a class="act ei-apply" href="${escUiHtml(view.apply_scope_href)}">${t("project_connections_apply_scope")}</a></div>
    <p class="ei-lead">${t("project_connections_lead")}</p><div class="pc-groups">${groups}</div>
  </div>`;
}
async function paintProjectConnections(record,selection){
  const host=$("#project-connections");
  if(!host) return;
  const tools=await ensureProjectConnectionsTools();
  if(selection!==undefined&&selection!==landSelectionSeq) return;
  if(!host.isConnected||host!==$("#project-connections")) return;
  host.innerHTML=projectConnectionsHTML(record?.project_connections,tools);
}
function zapOutcomesMemGet(projectId){
  const hit = ZAP_OUTCOMES_MEM.get(projectId);
  if(!hit) return null;
  if(hit.p) return hit;
  if(Date.now() - hit.at < ZAP_OUTCOMES_MEM_TTL) return hit;
  ZAP_OUTCOMES_MEM.delete(projectId);
  return null;
}
function fetchZapOutcomesPayload(projectId,{allowStatic=true}={}){
  const id = String(projectId || "").trim();
  if(!id) return Promise.resolve(null);
  const existing = zapOutcomesMemGet(id);
  if(existing?.p) return existing.p;
  if(existing?.data && (allowStatic || !existing.staticSnapshot)) return Promise.resolve(existing.data);
  const p = (async ()=>{
    try{
      const tools=await ensureProjectConnectionsTools();
      const accepts=tools?async response=>{
        if(!response?.ok) return false;
        const payload=await response.json();
        return tools.projectConnectionsPayloadState(payload,id)==="available";
      }:null;
      const resp = await workerFetch("/zap-outcomes?id=" + encodeURIComponent(id), null, 12000, accepts);
      if(!resp || !resp.ok) return null;
      const payload=await resp.json();
      return tools?tools.normalizeProjectConnectionsPayload(payload,id):payload;
    }catch(e){ return null; }
  })();
  ZAP_OUTCOMES_MEM.set(id, {p});
  return p.then(data=>{
    if(data && data.ok !== false && data.record){
      ZAP_OUTCOMES_MEM.set(id, {data, at: Date.now()});
    }else{
      ZAP_OUTCOMES_MEM.delete(id);
    }
    return data;
  }).catch(()=>{ ZAP_OUTCOMES_MEM.delete(id); return null; });
}
function prefetchZapOutcomesForList(rows){
  if(!Array.isArray(rows) || !rows.length) return;
  // Cap so a 40-row list does not fan out unbounded; demo + first screenful first.
  const ids = [];
  const seen = new Set();
  for(const r of rows){
    const id = r && r.project_id;
    if(!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if(ids.length >= 12) break;
  }
  for(const id of ids){
    if(zapOutcomesMemGet(id)) continue;
    fetchZapOutcomesPayload(id);
  }
}
async function loadZapOutcomes(r, el, selection){
  if(!el || !r || !r.project_id) return;
  const phaseToolsP = ensureLandPhaseSpineTools();
  const warm = zapOutcomesMemGet(r.project_id);
  if(warm?.data?.ok !== false && warm?.data?.record){
    if(selection !== undefined && selection !== landSelectionSeq) return;
    if(!document.contains(el)) return;
    const [phaseTools] = await Promise.all([phaseToolsP,paintProjectConnections(warm.data.record,selection)]);
    if(selection !== undefined && selection !== landSelectionSeq) return;
    if(!document.contains(el)) return;
    const record = normalizeLandRecord(warm.data.record);
    el.innerHTML = warm.staticSnapshot
      ? landOutcomeSnapshotHTML(record,phaseTools)
      : landOutcomesHTML(record,phaseTools);
    bindLandSpineUI(el);
    paintLandActionRail($("#land-actions"), r, record, phaseTools);
    const generated=Date.parse(warm.generatedAt||warm.data.generated_at||"");
    const connectionState=(await ensureProjectConnectionsTools())?.projectConnectionsPayloadState(
      warm.data,r.project_id
    );
    const staleStatic=warm.staticSnapshot && (
      !Number.isFinite(generated)
      || Date.now()-generated>6*60*60*1000
      || connectionState!=="available"
    );
    if(!staleStatic) return;
  }
  const [data, phaseTools] = await Promise.all([
    fetchZapOutcomesPayload(r.project_id,{allowStatic:false}),
    phaseToolsP
  ]);
  if(selection !== undefined && selection !== landSelectionSeq) return;
  if(!document.contains(el)) return;
  if(!data || data.ok === false || !data.record){
    // Preserve a static first paint on transient freshness failures. An empty
    // region is allowed only when this project was outside the bounded snapshot.
    return;
  }
  const record = normalizeLandRecord(data.record);
  await paintProjectConnections(record,selection);
  if(selection !== undefined && selection !== landSelectionSeq) return;
  if(!document.contains(el)) return;
  el.innerHTML = landOutcomesHTML(record, phaseTools);
  bindLandSpineUI(el);
  paintLandActionRail($("#land-actions"), r, record, phaseTools);
}

/* ===================== NOTICE-LEVEL ZAP PROJECT SPINE =====================
   Residual gap over #ldetail: land City Record notices mount the same phase-grouped
   ULURP timeline (land_phase_spine + /zap-outcomes) when a strict warehouse join hits.
   Precompute-first: ULURP→project from zap_projects_warehouse_lookup.json; spine from
   edge-materialized GET /zap-outcomes (never live ZAP API / SODA from the browser). */
let noticeLandSpineToolsPromise=null;
function ensureNoticeLandSpineTools(){
  if(!noticeLandSpineToolsPromise){
    noticeLandSpineToolsPromise=import("../notice_land_spine.mjs").catch(()=>null);
  }
  return noticeLandSpineToolsPromise;
}
let zapProjectJoinIndexPromise=null;
function loadZapProjectJoinIndex(){
  if(zapProjectJoinIndexPromise) return zapProjectJoinIndexPromise;
  zapProjectJoinIndexPromise=(async ()=>{
    const tools=await ensureNoticeLandSpineTools();
    if(!tools || typeof tools.buildZapProjectJoinIndex!=="function") return null;
    try{
      const res=await fetch("data/zap_projects_warehouse_lookup.json",{cache:"force-cache",credentials:"omit"});
      if(!res || !res.ok) return null;
      const doc=await res.json();
      return tools.buildZapProjectJoinIndex(doc);
    }catch(_e){ return null; }
  })();
  return zapProjectJoinIndexPromise;
}
function noticeLandMethodLabel(method){
  if(method==="exact_project_id") return t("notice_land_join_method_project_id");
  if(method==="exact_ulurp_token") return t("notice_land_join_method_ulurp");
  return method || "—";
}
function noticeLandSpineHTML(record, phaseTools, joinMeta){
  if(!record) return "";
  const projectId=record.project_id || joinMeta?.project_id || "";
  const projectName=cleanText(record.project_name || record.open_data?.project_name || projectId) || projectId;
  const methodLabel=noticeLandMethodLabel(joinMeta?.method);
  const keys=(joinMeta?.keys||[]).map(k=>escUiHtml(k)).join(", ") || "—";
  const joinNote=`<div class="note notice-land-join" data-notice-land-join="${escUiHtml(joinMeta?.method||"")}">${t("notice_land_join_matched_html",{
    project:escUiHtml(projectName+(projectId?` (${projectId})`:"")),
    method:escUiHtml(methodLabel),
    keys
  })} ${t("notice_land_this_notice_html")}</div>`;
  const landLink=projectId
    ?`<div class="lc-pct"><a class="view" href="#land/${escUiHtml(projectId)}">${t("notice_land_open_land_detail")}</a></div>`
    :"";
  // Reuse phase-grouped land spine (statutory clocks + zoning stats ride on the record).
  const spineHTML=landSpineHTML(record.spine, record, phaseTools);
  // Prefer the notice-context heading over the land-detail "Project timeline" alone.
  const headed=spineHTML
    ? spineHTML.replace(
        `<div class="chain-h">${t("land_spine_heading")}</div>`,
        `<div class="chain-h">${t("notice_land_spine_heading")}</div>${joinNote}${landLink}`
      )
    : `<div class="chain-h">${t("notice_land_spine_heading")}</div>${joinNote}${landLink}`;
  return `<section class="notice-land-spine" data-notice-land-spine="1" data-zap-project="${escUiHtml(projectId)}" aria-label="${escUiHtml(t("notice_land_spine_heading"))}">
    ${headed}
    <div class="note">${t("notice_land_provenance_html")}</div>
  </section>`;
}
async function loadNoticeLandSpine(r, el){
  if(!el) return;
  const tools=await ensureNoticeLandSpineTools();
  if(!tools || typeof tools.isNoticeLandSpineEligible!=="function"){
    el.innerHTML="";
    return;
  }
  if(!tools.isNoticeLandSpineEligible(r)){
    el.innerHTML="";
    return;
  }
  const index=await loadZapProjectJoinIndex();
  if(!document.contains(el)) return;
  const resolution=tools.resolveZapProjectForNotice(r, index);
  const keysLabel=(resolution?.refs?.ulurp_keys||resolution?.keys||[]).map(k=>escUiHtml(k)).join(", ") || "—";

  if(resolution && resolution.reason==="ambiguous_project" && Array.isArray(resolution.candidates) && resolution.candidates.length){
    const links=resolution.candidates.slice(0,6).map(c=>{
      const label=escUiHtml(cleanText(c.project_name)||c.project_id);
      return `<a class="view" href="#land/${escUiHtml(c.project_id)}">${label} <span lang="en" dir="ltr">(${escUiHtml(c.project_id)})</span></a>`;
    }).join(" · ");
    el.innerHTML=`<section class="notice-land-spine" data-notice-land-spine="1" data-notice-land-state="ambiguous" aria-label="${escUiHtml(t("notice_land_spine_heading"))}">
      <div class="chain-h">${t("notice_land_spine_heading")}</div>
      <div class="note">${t("notice_land_ambiguous_html",{keys:keysLabel})}</div>
      <div class="lc-pct">${links}</div>
    </section>`;
    return;
  }

  if(!resolution || !resolution.matched || !resolution.project_id){
    // Class-(a): plausible ULURP/ZAP refs but no unique portal project yet.
    // Invalid extractions never reach here (extractor + eligibility filter them out).
    const portalHint=`<a href="https://zap.planning.nyc.gov/" ${EXT_ATTRS}>Zoning Application Portal${extSR()}</a>`;
    const hasKeys=keysLabel && keysLabel!=="—";
    const note=hasKeys
      ? t("notice_land_no_match_with_keys_html",{keys:keysLabel, portal:portalHint})
      : t("notice_land_no_match_html",{portal:portalHint});
    el.innerHTML=`<section class="notice-land-spine" data-notice-land-spine="1" data-notice-land-state="unmatched" aria-label="${escUiHtml(t("notice_land_spine_heading"))}">
      <div class="chain-h">${t("notice_land_spine_heading")}</div>
      <div class="note">${note}</div>
    </section>`;
    return;
  }

  // Stamp for action-rail / entity deep links.
  r._zap_project_id=resolution.project_id;
  r._notice_land_join={
    method:resolution.method,
    keys:resolution.keys,
    project_id:resolution.project_id
  };

  const phaseToolsP=ensureLandPhaseSpineTools();
  const [data, phaseTools]=await Promise.all([
    fetchZapOutcomesPayload(resolution.project_id),
    phaseToolsP
  ]);
  if(!document.contains(el)) return;
  if(!data || data.ok===false || !data.record){
    el.innerHTML=`<section class="notice-land-spine" data-notice-land-spine="1" data-notice-land-state="unavailable" data-zap-project="${escUiHtml(resolution.project_id)}" aria-label="${escUiHtml(t("notice_land_spine_heading"))}">
      <div class="chain-h">${t("notice_land_spine_heading")}</div>
      <div class="note">${t("notice_land_unavailable_html")}</div>
      <div class="lc-pct"><a class="view" href="#land/${escUiHtml(resolution.project_id)}">${t("notice_land_open_land_detail")}</a></div>
    </section>`;
    return;
  }
  el.innerHTML=noticeLandSpineHTML(data.record, phaseTools, {
    method:resolution.method,
    keys:resolution.keys,
    project_id:resolution.project_id
  });
  bindLandSpineUI(el);
  // Re-mount action rail so land/testify affordances can see the joined project id.
  try{
    if($("#nactions")) mountNoticeActionRail($("#nactions"), r);
  }catch(_e){}
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.BORO_CENTER = BORO_CENTER;
globalThis.GEO = GEO;
globalThis.LAND_DEFAULT_SNAPSHOT_URL = LAND_DEFAULT_SNAPSHOT_URL;
globalThis.ZAP = ZAP;
globalThis.ZAPBBL = ZAPBBL;
globalThis.ZAP_OUTCOMES_MEM = ZAP_OUTCOMES_MEM;
globalThis.ZAP_OUTCOMES_MEM_TTL = ZAP_OUTCOMES_MEM_TTL;
globalThis.ZAP_SELECT = ZAP_SELECT;
globalThis.bindLandSpineUI = bindLandSpineUI;
globalThis.ensureLandPhaseSpineTools = ensureLandPhaseSpineTools;
globalThis.ensureProjectConnectionsTools = ensureProjectConnectionsTools;
globalThis.ensureNoticeLandSpineTools = ensureNoticeLandSpineTools;
globalThis.fetchZapOutcomesPayload = fetchZapOutcomesPayload;
globalThis.geocode = geocode;
globalThis.isDefaultLandSearchState = isDefaultLandSearchState;
globalThis.landApplicantConditionedHTML = landApplicantConditionedHTML;
globalThis.landNearby = landNearby;
globalThis.landOutcomesHTML = landOutcomesHTML;
globalThis.projectConnectionsHTML = projectConnectionsHTML;
globalThis.landPermalinkActionHTML = landPermalinkActionHTML;
globalThis.landPhaseAggregateHTML = landPhaseAggregateHTML;
globalThis.landPhaseLabel = landPhaseLabel;
globalThis.landPhaseSpineHTML = landPhaseSpineHTML;
globalThis.landRenderList = landRenderList;
globalThis.landRowHTML = landRowHTML;
globalThis.landSearch = landSearch;
globalThis.landSelect = landSelect;
globalThis.landShowLots = landShowLots;
globalThis.landShowMap = landShowMap;
globalThis.landSpineEventRowHTML = landSpineEventRowHTML;
globalThis.landSpineGapsHTML = landSpineGapsHTML;
globalThis.landSpineHTML = landSpineHTML;
globalThis.landSpineHTMLFlat = landSpineHTMLFlat;
globalThis.landSpineLagHTML = landSpineLagHTML;
globalThis.landStatutoryDeadlineHTML = landStatutoryDeadlineHTML;
globalThis.landToAlert = landToAlert;
globalThis.landZoningStatisticsHTML = landZoningStatisticsHTML;
globalThis.loadLandDefaultSnapshot = loadLandDefaultSnapshot;
globalThis.loadLeaflet = loadLeaflet;
globalThis.loadNoticeLandSpine = loadNoticeLandSpine;
globalThis.loadZapOutcomes = loadZapOutcomes;
globalThis.loadZapProjectJoinIndex = loadZapProjectJoinIndex;
globalThis.mihOn = mihOn;
globalThis.noticeLandMethodLabel = noticeLandMethodLabel;
globalThis.noticeLandSpineHTML = noticeLandSpineHTML;
globalThis.paintLandRows = paintLandRows;
globalThis.prefetchZapOutcomesForList = prefetchZapOutcomesForList;
globalThis.renderLandEntryNotFound = renderLandEntryNotFound;
globalThis.showLandEntry = showLandEntry;
globalThis.wireLandPanControls = wireLandPanControls;
globalThis.zapCouncilWhere = zapCouncilWhere;
globalThis.zapDistrictWhere = zapDistrictWhere;
globalThis.zapOutcomesMemGet = zapOutcomesMemGet;
globalThis.zapWhere = zapWhere;
Object.defineProperty(globalThis, "lRows", { configurable: true, get: () => lRows, set: value => { lRows = value; } });
Object.defineProperty(globalThis, "landAutoLocationChecked", { configurable: true, get: () => landAutoLocationChecked, set: value => { landAutoLocationChecked = value; } });
Object.defineProperty(globalThis, "landBanner", { configurable: true, get: () => landBanner, set: value => { landBanner = value; } });
Object.defineProperty(globalThis, "landBorough", { configurable: true, get: () => landBorough, set: value => { landBorough = normalizeBoroughScope(value); } });
Object.defineProperty(globalThis, "landAttendance", { configurable: true, get: () => landAttendance, set: value => { landAttendance = normalizeAttendanceScope(value); } });
Object.defineProperty(globalThis, "landCommunityDistrict", { configurable: true, get: () => landCommunityDistrict, set: value => { landCommunityDistrict = value; } });
Object.defineProperty(globalThis, "landCouncilDistrict", { configurable: true, get: () => landCouncilDistrict, set: value => { landCouncilDistrict = value; } });
Object.defineProperty(globalThis, "landDefaultSnapshotPromise", { configurable: true, get: () => landDefaultSnapshotPromise, set: value => { landDefaultSnapshotPromise = value; } });
Object.defineProperty(globalThis, "landLoaded", { configurable: true, get: () => landLoaded, set: value => { landLoaded = value; } });
Object.defineProperty(globalThis, "landMap", { configurable: true, get: () => landMap, set: value => { landMap = value; } });
Object.defineProperty(globalThis, "landMarker", { configurable: true, get: () => landMarker, set: value => { landMarker = value; } });
Object.defineProperty(globalThis, "landPhaseSpineToolsPromise", { configurable: true, get: () => landPhaseSpineToolsPromise, set: value => { landPhaseSpineToolsPromise = value; } });
Object.defineProperty(globalThis, "landResolvedArea", { configurable: true, get: () => landResolvedArea, set: value => { landResolvedArea = value; } });
Object.defineProperty(globalThis, "landSelectionSeq", { configurable: true, get: () => landSelectionSeq, set: value => { landSelectionSeq = value; } });
Object.defineProperty(globalThis, "leafletP", { configurable: true, get: () => leafletP, set: value => { leafletP = value; } });
Object.defineProperty(globalThis, "noticeLandSpineToolsPromise", { configurable: true, get: () => noticeLandSpineToolsPromise, set: value => { noticeLandSpineToolsPromise = value; } });
Object.defineProperty(globalThis, "zapProjectJoinIndexPromise", { configurable: true, get: () => zapProjectJoinIndexPromise, set: value => { zapProjectJoinIndexPromise = value; } });
