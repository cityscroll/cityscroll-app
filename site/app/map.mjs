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
  // Boundaries change rarely — force-cache is fine. Activity is rebuilt on every
  // site deploy (district counts, citywide bags); use default revalidation so
  // returning browsers pick up the new payload (origin sends max-age=0, must-revalidate).
  // force-cache here previously left owners looking at a grid of stale zeros.
  const [bRes, aRes]=await Promise.all([
    fetch("data/district_boundaries.json",{cache:"force-cache"}),
    fetch("data/district_activity.json",{cache:"no-cache"}),
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
function mapCountChip(lens, n, href){
  const label=`${mapEsc(mapLensLabel(lens))} <b>${Number(n)||0}</b>`;
  if(href && Number(n)>0){
    return `<a class="tag place map-count-link" href="${mapEsc(href)}">${label}</a>`;
  }
  return `<span class="tag place">${label}</span>`;
}
function mapLinksFromDrill(links){
  const byLens=Object.create(null);
  for(const l of links||[]) byLens[l.lens]=l;
  return byLens;
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
  // Features for current level + first-class citywide / virtual bags
  const { features, max }=tools.mapFeatures(boundaries, activity, {
    level: mapState.level,
    parent: mapState.parent,
    lens: mapState.lens,
  });
  const buckets=typeof tools.nonPolygonBuckets==="function"?tools.nonPolygonBuckets(activity):[];
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
  // Sorted area list (a11y + no-map fallback) + first-class citywide / virtual / unlocated bags.
  const sorted=[...features].sort((a,b)=>b.total-a.total || String(a.label).localeCompare(String(b.label)));
  const bucketLabel=(kind)=>{
    if(kind==="citywide") return t("map_bucket_citywide");
    if(kind==="virtual") return t("map_bucket_virtual");
    if(kind==="unlocated") return t("map_bucket_unlocated");
    return kind;
  };
  const bucketHtml=buckets.map(b=>{
    const n=mapState.lens==="all"?b.total:(Number(b.counts?.[mapState.lens])||0);
    if(mapState.lens!=="all" && n<=0) return "";
    return `<li class="map-bucket map-bucket-${mapEsc(b.kind)}"><button type="button" data-map-bucket="${mapEsc(b.id)}" aria-current="${mapState.id===b.id?"true":"false"}"><span>${mapEsc(bucketLabel(b.kind))}</span><span class="map-count">${n}</span></button></li>`;
  }).filter(Boolean).join("");
  // Money framing: zeros on borough polygons often mean "no place signal", not
  // "no contracts". Surface coverage before the polygon list so the lens does not
  // read as broken when most awards are citywide / unlocated.
  let framingHtml="";
  if(mapState.lens==="money" && typeof tools.moneyCoverageFraming==="function"){
    const frame=tools.moneyCoverageFraming(activity);
    if(frame && frame.counted>0){
      framingHtml=`<li class="map-framing map-framing-money" role="note"><p>${mapEsc(t("map_money_framing",{
        counted:String(frame.counted),
        local:String(frame.local),
        citywide:String(frame.citywide),
        unlocated:String(frame.unlocated),
      }))}</p></li>`;
    }
  }
  const zeroClass=(total)=>Number(total)>0?"":" map-count-zero";
  list.innerHTML=(framingHtml||"")+(bucketHtml||"")+sorted.map(f=>
    `<li class="${Number(f.total)>0?"":"map-area-empty"}"><button type="button" data-map-id="${mapEsc(f.id)}" data-map-level="${mapEsc(f.level)}" ${mapState.id===f.id?'aria-current="true"':""}><span>${mapEsc(f.label)}</span><span class="map-count${zeroClass(f.total)}">${f.total}</span></button></li>`
  ).join("") || (bucketHtml||framingHtml?"":`<li class="empty" style="padding:12px">${t("map_no_areas")}</li>`);
  list.querySelectorAll("[data-map-id]").forEach(btn=>{
    btn.addEventListener("click",()=>selectMapFeature(btn.dataset.mapId, btn.dataset.mapLevel, tools, features));
  });
  list.querySelectorAll("[data-map-bucket]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const bag=buckets.find(b=>b.id===btn.dataset.mapBucket);
      if(!bag) return;
      mapState={ ...mapState, id: bag.id, parent: null };
      // Re-paint detail for the non-polygon bag without changing polygon selection geometry.
      paintMapExploration(); updateHash();
    });
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
  // Detail panel for selected district OR first-class citywide / virtual bag.
  if(detail){
    const bucketSel=mapState.id && buckets
      ? buckets.find(b=>b.id===mapState.id)
      : (mapState.id && typeof tools.nonPolygonBuckets==="function"
        ? tools.nonPolygonBuckets(activity).find(b=>b.id===mapState.id)
        : null);
    const sel=bucketSel?null:(mapState.id?features.find(f=>f.id===mapState.id):null);
    if(!sel && !bucketSel){ detail.hidden=true; detail.innerHTML=""; }
    else if(bucketSel){
      detail.hidden=false;
      const counts=bucketSel.counts||{};
      const total=mapState.lens==="all"?bucketSel.total:(Number(counts[mapState.lens])||0);
      const leadKey=bucketSel.kind==="citywide"
        ?"map_citywide_detail_lead"
        :bucketSel.kind==="unlocated"
          ?"map_unlocated_detail_lead"
          :"map_virtual_detail_lead";
      const title=bucketSel.kind==="citywide"
        ?t("map_bucket_citywide")
        :bucketSel.kind==="unlocated"
          ?t("map_bucket_unlocated")
          :t("map_bucket_virtual");
      const links=typeof tools.bucketFeedLinks==="function"
        ? tools.bucketFeedLinks(bucketSel.kind, { counts, onlyPositive:true })
        : [];
      const byLens=mapLinksFromDrill(links);
      detail.innerHTML=`<h3>${mapEsc(title)}</h3>
        <p class="map-fallback-note">${t(leadKey,{n:String(total), lens:mapEsc(mapLensLabel(mapState.lens))})}</p>
        <div class="map-detail-counts">
          ${mapCountChip("land", counts.land, byLens.land?.hash)}
          ${mapCountChip("property", counts.property, byLens.property?.hash)}
          ${mapCountChip("rules", counts.rules, byLens.rules?.hash)}
          ${mapCountChip("meetings", counts.meetings, byLens.meetings?.hash)}
          ${mapCountChip("money", counts.money, byLens.money?.hash)}
        </div>
        <div class="map-detail-links">
          ${links.map(l=>{
            const scope=l.scope||"bag";
            const count=l.count!=null?` (${l.count})`:"";
            return `<a class="act" href="${mapEsc(l.hash)}" data-map-feed-scope="${mapEsc(scope)}" data-map-feed-lens="${mapEsc(l.lens||"")}">${mapEsc(t(l.label_key))}${count}</a>`;
          }).join("")}
        </div>`;
    } else {
      detail.hidden=false;
      const counts=sel.counts||{};
      const links=tools.areaFeedLinks(sel.level, sel.id, { counts, onlyPositive:true });
      const byLens=mapLinksFromDrill(links);
      // When viewing a district, also surface citywide bag chips so city-scale
      // rules/meetings remain visible (labeled citywide — never fabricated into the polygon).
      const cw=typeof tools.citywideBucketCounts==="function"
        ? tools.citywideBucketCounts(activity)
        : (activity.citywide||null);
      const cwTotal=cw?tools.totalForLens(cw, mapState.lens==="all"?"all":mapState.lens):0;
      const cwLinks=cwTotal>0 && typeof tools.bucketFeedLinks==="function"
        ? tools.bucketFeedLinks("citywide", { counts:cw, onlyPositive:true })
        : [];
      detail.innerHTML=`<h3>${mapEsc(sel.label)}</h3>
        <p class="map-fallback-note">${t("map_detail_lead",{n:String(sel.total), lens:mapEsc(mapLensLabel(mapState.lens))})}</p>
        <div class="map-detail-counts">
          ${mapCountChip("land", counts.land, byLens.land?.hash)}
          ${mapCountChip("property", counts.property, byLens.property?.hash)}
          ${mapCountChip("rules", counts.rules, byLens.rules?.hash)}
          ${mapCountChip("meetings", counts.meetings, byLens.meetings?.hash)}
          ${mapCountChip("money", counts.money, byLens.money?.hash)}
        </div>
        ${cwTotal>0?`<p class="map-citywide-note"><span class="tag place">${mapEsc(t("map_bucket_citywide"))} <b>${cwTotal}</b></span> ${mapEsc(t("map_citywide_also_applies"))}${cwLinks.length?` · ${cwLinks.map(l=>`<a href="${mapEsc(l.hash)}">${mapEsc(t(l.label_key))}</a>`).join(" · ")}`:""}</p>`:""}
        <div class="map-detail-links">
          ${links.map(l=>{
            const label=t(l.label_key||("tab_"+l.lens));
            const scope=l.scope||"district";
            // Class tokens only — never a reader-facing English phrase.
            const cls=scope==="citywide"?("act"+" "+"map-feed-citywide"):"act";
            const count=l.count!=null?` (${l.count})`:"";
            return `<a class="${cls}" href="${mapEsc(l.hash)}" data-map-feed-scope="${mapEsc(scope)}" data-map-feed-lens="${mapEsc(l.lens||"")}">${mapEsc(label)}${count}</a>`;
          }).join("")}
          ${sel.level==="borough"?`<button type="button" class="act primary" data-map-drill="${mapEsc(sel.id)}">${t("map_drill_community")}</button>`:""}
          ${sel.level==="borough"?`<button type="button" class="act" data-map-council="1">${t("map_show_council")}</button>`:""}
        </div>
        <p class="map-fallback-note"><a href="about.html#tax-lien-sale-predictions">${t("tax_lien_formula_link")}</a></p>`;
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
