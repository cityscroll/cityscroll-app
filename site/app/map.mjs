/* ===== Map exploration (cs-geo-04): SVG district choropleth from precomputed
   district_activity + district_boundaries. No proprietary map SDK; list remains
   the fallback. Coordinates never ride share links. ===== */
let mapToolsPromise=null, mapBoundaries=null, mapActivity=null, mapPainted=false;
let mapState={ level:"borough", id:null, parent:null, lens:"all" };
let mapViewBox=null;
function mapExplorationTools(){
  if(!mapToolsPromise){
    mapToolsPromise=import("../map_exploration.mjs").catch(()=>null);
  }
  return mapToolsPromise;
}
async function loadMapData(){
  if(mapBoundaries && mapActivity) return { boundaries:mapBoundaries, activity:mapActivity };
  const [bRes, aRes]=await Promise.all([
    fetch("data/district_boundaries.json",{cache:"force-cache"}),
    fetch("data/district_activity.json",{cache:"force-cache"}),
  ]);
  mapBoundaries=bRes.ok?await bRes.json():null;
  mapActivity=aRes.ok?await aRes.json():null;
  return { boundaries:mapBoundaries, activity:mapActivity };
}
function mapEsc(s){ return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function mapLensLabel(lens){
  return ({
    all:t("map_lens_all"),
    land:t("tab_land"),
    property:t("tab_property"),
    rules:t("tab_rules"),
    meetings:t("tab_meetings"),
    money:t("tab_money"),
  })[lens]||lens;
}
function mapCountChip(lens, n){
  return `<span class="tag place">${mapEsc(mapLensLabel(lens))} <b>${Number(n)||0}</b></span>`;
}
async function paintMapExploration(){
  const tools=await mapExplorationTools();
  const wrap=$("#mapSvgWrap"), list=$("#mapAreaList"), detail=$("#mapDetail"), crumb=$("#mapCrumb"), lensRow=$("#mapLensRow"), vintage=$("#mapVintage");
  if(!wrap || !list) return;
  if(!tools){
    list.innerHTML=`<li class="empty" style="padding:12px">${t("map_load_error")}</li>`;
    return;
  }
  const { boundaries, activity }=await loadMapData();
  if(!boundaries || !activity){
    list.innerHTML=`<li class="empty" style="padding:12px">${t("map_load_error")}</li>`;
    if(vintage) vintage.textContent="";
    return;
  }
  // Wire chrome once
  if(!mapPainted){
    mapPainted=true;
    document.querySelectorAll("[data-map-level]").forEach(btn=>{
      btn.addEventListener("click",()=>{
        const level=btn.dataset.mapLevel;
        if(level==="borough") mapState={ level:"borough", id:null, parent:null, lens:mapState.lens };
        else if(level==="community_district") mapState={ level:"community_district", id:null, parent:mapState.parent||null, lens:mapState.lens };
        else if(level==="council_district") mapState={ level:"council_district", id:null, parent:null, lens:mapState.lens };
        mapViewBox=null;
        paintMapExploration(); updateHash();
      });
    });
    document.querySelectorAll("[data-map-zoom],[data-map-pan]").forEach(btn=>{
      btn.addEventListener("click",()=>{
        if(!mapViewBox) mapViewBox=tools.defaultViewBox();
        if(btn.dataset.mapZoom==="in") mapViewBox=tools.zoomViewBox(mapViewBox, 0.7);
        else if(btn.dataset.mapZoom==="out") mapViewBox=tools.zoomViewBox(mapViewBox, 1.35);
        else if(btn.dataset.mapZoom==="reset") mapViewBox=null;
        else if(btn.dataset.mapPan==="west") mapViewBox=tools.panViewBox(mapViewBox, -0.18, 0);
        else if(btn.dataset.mapPan==="east") mapViewBox=tools.panViewBox(mapViewBox, 0.18, 0);
        else if(btn.dataset.mapPan==="north") mapViewBox=tools.panViewBox(mapViewBox, 0, -0.18);
        else if(btn.dataset.mapPan==="south") mapViewBox=tools.panViewBox(mapViewBox, 0, 0.18);
        const svg=$("#mapSvg"); if(svg && mapViewBox) svg.setAttribute("viewBox", mapViewBox);
        if(btn.dataset.mapZoom==="reset") paintMapExploration();
      });
    });
  }
  // Level button pressed state
  document.querySelectorAll("[data-map-level]").forEach(btn=>{
    btn.setAttribute("aria-pressed", String(btn.dataset.mapLevel===mapState.level));
  });
  // Lens chips
  if(lensRow){
    const lenses=["all","land","property","rules","meetings","money"];
    lensRow.innerHTML=lenses.map(lens=>
      `<button type="button" class="chip ${mapState.lens===lens?"on":""}" data-map-lens="${lens}" aria-pressed="${mapState.lens===lens}">${mapEsc(mapLensLabel(lens))}</button>`
    ).join("");
    lensRow.querySelectorAll("[data-map-lens]").forEach(btn=>{
      btn.addEventListener("click",()=>{
        mapState.lens=btn.dataset.mapLens;
        paintMapExploration(); updateHash();
      });
    });
  }
  // Features for current level
  const { features, max }=tools.mapFeatures(boundaries, activity, {
    level: mapState.level,
    parent: mapState.parent,
    lens: mapState.lens,
  });
  // ViewBox
  if(!mapViewBox){
    if(mapState.parent && mapState.level==="community_district" && tools.BOROUGH_HULLS[mapState.parent]){
      mapViewBox=tools.bboxToViewBox(tools.BOROUGH_HULLS[mapState.parent].bbox);
    } else if(mapState.id){
      const sel=features.find(f=>f.id===mapState.id);
      mapViewBox=sel?tools.bboxToViewBox(sel.bbox):tools.defaultViewBox();
    } else {
      mapViewBox=tools.defaultViewBox();
    }
  }
  const svg=$("#mapSvg"), g=$("#mapPolygons");
  if(svg) svg.setAttribute("viewBox", mapViewBox);
  if(g){
    g.innerHTML=features.map(f=>{
      if(!f.path) return "";
      const selected=mapState.id && f.id===mapState.id;
      return `<path class="map-district" tabindex="0" role="button" data-map-id="${mapEsc(f.id)}" data-map-level="${mapEsc(f.level)}" d="${f.path}" fill="${f.fill}" aria-label="${mapEsc(f.label)}: ${f.total}" ${selected?'aria-current="true"':""}></path>`;
    }).join("");
    g.querySelectorAll(".map-district").forEach(path=>{
      const activate=()=>selectMapFeature(path.dataset.mapId, path.dataset.mapLevel, tools, features);
      path.addEventListener("click", activate);
      path.addEventListener("keydown", e=>{
        if(e.key==="Enter" || e.key===" "){ e.preventDefault(); activate(); }
      });
    });
  }
  // Sorted area list (a11y + no-map fallback)
  const sorted=[...features].sort((a,b)=>b.total-a.total || String(a.label).localeCompare(String(b.label)));
  list.innerHTML=sorted.map(f=>
    `<li><button type="button" data-map-id="${mapEsc(f.id)}" data-map-level="${mapEsc(f.level)}" ${mapState.id===f.id?'aria-current="true"':""}><span>${mapEsc(f.label)}</span><span class="map-count">${f.total}</span></button></li>`
  ).join("") || `<li class="empty" style="padding:12px">${t("map_no_areas")}</li>`;
  list.querySelectorAll("[data-map-id]").forEach(btn=>{
    btn.addEventListener("click",()=>selectMapFeature(btn.dataset.mapId, btn.dataset.mapLevel, tools, features));
  });
  // Breadcrumb
  if(crumb){
    const crumbs=tools.mapBreadcrumb(mapState);
    crumb.innerHTML=crumbs.map((c,i)=>{
      const last=i===crumbs.length-1;
      const label=c.label_key?t(c.label_key):(c.label||"");
      if(last) return `<span aria-current="page">${mapEsc(label)}</span>`;
      return `<button type="button" data-map-crumb="${i}">${mapEsc(label)}</button><span aria-hidden="true">/</span>`;
    }).join(" ");
    crumb.querySelectorAll("[data-map-crumb]").forEach(btn=>{
      btn.addEventListener("click",()=>{
        const i=Number(btn.dataset.mapCrumb);
        const c=crumbs[i];
        if(!c) return;
        if(c.level==="borough" && !c.id) mapState={ level:"borough", id:null, parent:null, lens:mapState.lens };
        else mapState={ level:c.level, id:c.id, parent:c.parent, lens:mapState.lens };
        mapViewBox=null;
        paintMapExploration(); updateHash();
      });
    });
  }
  if(vintage){
    const v=activity.boundary_vintage || boundaries.boundary_vintage || "";
    vintage.textContent=v?t("map_boundary_vintage",{date:v}):"";
  }
  // Detail panel for selected district
  if(detail){
    const sel=mapState.id?features.find(f=>f.id===mapState.id):null;
    if(!sel){ detail.hidden=true; detail.innerHTML=""; }
    else{
      detail.hidden=false;
      const links=tools.areaFeedLinks(sel.level, sel.id);
      const counts=sel.counts||{};
      detail.innerHTML=`<h3>${mapEsc(sel.label)}</h3>
        <p class="map-fallback-note">${t("map_detail_lead",{n:String(sel.total), lens:mapEsc(mapLensLabel(mapState.lens))})}</p>
        <div class="map-detail-counts">
          ${mapCountChip("land", counts.land)}
          ${mapCountChip("property", counts.property)}
          ${mapCountChip("rules", counts.rules)}
          ${mapCountChip("meetings", counts.meetings)}
          ${mapCountChip("money", counts.money)}
        </div>
        <div class="map-detail-links">
          ${links.map(l=>`<a class="act" href="${mapEsc(l.hash)}">${mapEsc(t(l.label_key))}</a>`).join("")}
          ${sel.level==="borough"?`<button type="button" class="act primary" data-map-drill="${mapEsc(sel.id)}">${t("map_drill_community")}</button>`:""}
          ${sel.level==="borough"?`<button type="button" class="act" data-map-council="1">${t("map_show_council")}</button>`:""}
        </div>
        <p class="map-fallback-note"><a href="#property?view=tax-lien">${t("property_tax_lien_link")}</a></p>`;
      detail.querySelector("[data-map-drill]")?.addEventListener("click",()=>{
        mapState={ level:"community_district", id:null, parent:sel.id, lens:mapState.lens };
        mapViewBox=null;
        paintMapExploration(); updateHash();
      });
      detail.querySelector("[data-map-council]")?.addEventListener("click",()=>{
        mapState={ level:"council_district", id:null, parent:null, lens:mapState.lens };
        mapViewBox=null;
        paintMapExploration(); updateHash();
      });
    }
  }
  // Live region announce
  announce(t("map_areas_announce",{n:String(features.length), max:String(max)}));
}
function selectMapFeature(id, level, tools, features){
  const feature=features.find(f=>f.id===id);
  if(!feature) return;
  // Borough tap drills in; district tap selects for feed links
  if(level==="borough"){
    mapState=tools.drillInto(feature, mapState);
    mapViewBox=null;
  } else {
    mapState={ ...mapState, level: feature.level, id: feature.id, parent: feature.parent || mapState.parent };
    if(tools && feature.bbox) mapViewBox=tools.bboxToViewBox(feature.bbox);
  }
  paintMapExploration(); updateHash();
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.loadMapData = loadMapData;
globalThis.mapExplorationTools = mapExplorationTools;
globalThis.mapEsc = mapEsc;
globalThis.mapLensLabel = mapLensLabel;
globalThis.mapCountChip = mapCountChip;
globalThis.paintMapExploration = paintMapExploration;
globalThis.selectMapFeature = selectMapFeature;
Object.defineProperty(globalThis, "mapActivity", { configurable: true, get: () => mapActivity, set: value => { mapActivity = value; } });
Object.defineProperty(globalThis, "mapBoundaries", { configurable: true, get: () => mapBoundaries, set: value => { mapBoundaries = value; } });
Object.defineProperty(globalThis, "mapPainted", { configurable: true, get: () => mapPainted, set: value => { mapPainted = value; } });
Object.defineProperty(globalThis, "mapState", { configurable: true, get: () => mapState, set: value => { mapState = value; } });
Object.defineProperty(globalThis, "mapToolsPromise", { configurable: true, get: () => mapToolsPromise, set: value => { mapToolsPromise = value; } });
Object.defineProperty(globalThis, "mapViewBox", { configurable: true, get: () => mapViewBox, set: value => { mapViewBox = value; } });
