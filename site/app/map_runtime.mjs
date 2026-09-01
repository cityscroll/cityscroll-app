/* Land map runtime: every map dependency the Land route can need, behind activation.
 *
 * Nothing in this module is fetched when the Land tab opens. `main.mjs` registers it as
 * `globalThis.ensureLandMapRuntime()`, and only two events pull it in:
 *
 *   - browse Map activation — `view=map` in the route, or the resident pressing Map;
 *   - detail-map activation — the resident selecting one project row.
 *
 * So List first paint never waits on map assets, a point projection, or this module.
 *
 * Two substrates live here for two different jobs, and they stay apart on purpose:
 *
 *   - the browse Map shell paints the already filtered result set with the local SVG
 *     substrate (`map_exploration.mjs` projection + schematic borough outlines) over the
 *     committed, versioned point projection. No SDK, no tile provider, no live GIS.
 *   - the detail map keeps its existing Leaflet/Carto implementation unchanged. It is a
 *     detail of one selected project, not a browse dependency, and this card does not
 *     migrate it; it only moves it behind activation.
 *
 * Failure is a presentation failure and never a scope failure: the filtered List stays on
 * screen with its count, rows, filters, and controls, and the resident gets a retry and a
 * direct return to List.
 */

import { lookupBblCentroid } from "../bbl_mappluto_centroids.mjs";
import { buildLandMapModel } from "../land_map_model.mjs";
import {
  BOROUGH_HULLS,
  NYC_BOUNDS,
  bboxToViewBox,
  defaultViewBox,
  polygonsToSvgPath,
  projectLonLat,
} from "../map_exploration.mjs";

function toFiniteCoordinates(lat, lon){
  const y = Number(lat);
  const x = Number(lon);
  if(!Number.isFinite(y)||!Number.isFinite(x)) return null;
  return [y, x];
}
function toFinitePoint(record){
  const pairs = [
    [record?.latitude, record?.longitude],
    [record?.lat, record?.lon],
    [record?.latlng?.lat, record?.latlng?.lng],
    [record?.y, record?.x],
    [record?.geometry?.latitude, record?.geometry?.longitude],
    [record?.location?.latitude, record?.location?.longitude],
  ];
  for(const [lat, lon] of pairs){
    const point = toFiniteCoordinates(lat, lon);
    if(point) return point;
  }
  if(record?.geometry?.type==="Point" && Array.isArray(record.geometry.coordinates) && record.geometry.coordinates.length>=2){
    const point = toFiniteCoordinates(record.geometry.coordinates[1], record.geometry.coordinates[0]);
    if(point) return point;
  }
  return null;
}
function normalizeLandBbl(value){
  const bbl = String(value || "").trim();
  if(!bbl) return null;
  const normalized = bbl.replace(/\D/g, "");
  return normalized ? normalized : bbl;
}
function collectProjectBbls(record, outcomeRecord, bblRows){
  const out = new Set();
  const add=(value)=>{
    const b=normalizeLandBbl(value);
    if(b) out.add(b);
  };
  if(Array.isArray(record?.bbls)) for(const b of record.bbls) add(b);
  if(Array.isArray(record?.bbls_list)) for(const b of record.bbls_list) add(b);
  if(record?.bbl) add(record.bbl);
  if(Array.isArray(outcomeRecord?.bbls)) for(const b of outcomeRecord.bbls) add(b);
  const id=String(record?.project_id || "").trim();
  if(id && Array.isArray(bblRows)){
    const hit=bblRows.find((item)=>String(item?.project_id || "").trim()===id);
    if(Array.isArray(hit?.bbls)) for(const b of hit.bbls) add(b);
  }
  for(const filing of outcomeRecord?.dob?.filings || []){
    add(filing?.bbl);
  }
  const groups = Array.isArray(outcomeRecord?.project_connections?.groups) ? outcomeRecord.project_connections.groups : [];
  for(const group of groups){
    if(!group || group.id !== "parcels" || !Array.isArray(group.items)) continue;
    for(const item of group.items){
      if(typeof item?.ref === "string" && item.ref.startsWith("bbl:")) add(item.ref.slice(4));
    }
  }
  return [...out];
}
function collectAddressCandidates(record, outcomeRecord){
  const seen = new Set();
  const out = [];
  const add=(value)=>{
    const valueKey = cleanText(value || "").toLowerCase();
    if(!valueKey || seen.has(valueKey)) return;
    seen.add(valueKey);
    out.push(value);
  };
  const boro = cleanText(record?.borough || outcomeRecord?.open_data?.borough || outcomeRecord?.borough || "");
  const filings = Array.isArray(outcomeRecord?.dob?.filings) ? outcomeRecord.dob.filings : [];
  for(const filing of filings){
    const label = `${cleanText(filing?.house_no)} ${cleanText(filing?.street_name)}`.trim();
    if(!label) continue;
    add(`${label}${boro ? ` ${boro}` : ""}`);
    add(`${label}${boro ? `, ${boro}` : ""}`);
  }
  const base = cleanText(record?.project_name || outcomeRecord?.project_name || "");
  if(base){
    add(
      base.replace(/rezoning|demapping|rezone|special (mixed use )?district|text amendment|special permit|special district|mapping actions?|modification|disposition|non-?ulurp|public hearing|notice/ig, "")
        .replace(/\bnos?\.?\b/ig, "")
        .replace(/\s+/g, " ")
        .trim()
    );
  }
  return out.map((q)=>`${q}${boro?` ${boro}`:""} New York`).map((q)=>q.replace(/\s+,/g,",").replace(/\s+/g," ").trim());
}
async function resolveLandMapLocation(record, outcomeRecord, {propertyPayload, geocode, centroidLookup, bblSnapshot} = {}){
  const outcome = outcomeRecord || null;
  const geoPoint = toFinitePoint(record) || toFinitePoint(outcome);
  if(geoPoint){
    return {status:"exact", precision:"exact", lat:geoPoint[0], lon:geoPoint[1], label: cleanText(record?.project_name || record?.borough || outcome?.project_name || outcome?.borough || ""), method:"authoritative_point"};
  }
  const bbls = collectProjectBbls(record, outcome, bblSnapshot?.rows).slice(0,25);
  if(bbls.length && centroidLookup){
    const centroid = lookupBblCentroid(centroidLookup, bbls);
    if(centroid){
      return {
        status:"exact",
        precision:"exact",
        lat:centroid.lat,
        lon:centroid.lon,
        bbl:centroid.bbl,
        method:"bbl_mappluto_centroid",
        label:cleanText(record?.project_name || outcome?.project_name || record?.borough || outcome?.borough || ""),
      };
    }
  }
  const propertyRows = propertyPayload?.property_rows || [];
  if(bbls.length && propertyRows.length){
    const bblSet = new Set(bbls);
    const address = propertyRows.flatMap(item=>item?.property_location?.addresses||[])
      .find((item)=> bblSet.has(String(item?.bbl||"")) && Number.isFinite(Number(item?.latitude)) && Number.isFinite(Number(item?.longitude)));
    if(address){
      return {status:"exact", precision:"exact", lat:Number(address.latitude), lon:Number(address.longitude), label:address.label||record?.project_name||"", method:"property_address"};
    }
    const geometryPoint = propertyRows.find((row)=>{
      const bblMatch = bblSet.has(String(row?.property_location?.bbl||"")) ||
        (Array.isArray(row?.property_location?.bbls) && row.property_location.bbls.some((b)=>bblSet.has(String(b||""))));
      if(!bblMatch) return false;
      const toPoint = toFinitePoint(row?.property_location);
      return Boolean(toPoint);
    });
    if(geometryPoint){
      const toPoint = toFinitePoint(geometryPoint?.property_location);
      if(toPoint) return {status:"exact", precision:"exact", lat:toPoint[0], lon:toPoint[1], label:geometryPoint?.short_title||record?.project_name||"", method:"property_geometry"};
    }
  }
  if(!geocode) return {status:"unresolved", reason:"no-resolution"};
  const candidates = collectAddressCandidates(record, outcome);
  for(const query of candidates){
    const next = await Promise.resolve(geocode?.(query)).catch(()=>null);
    if(next?.status==="matched"&&Number.isFinite(next?.lat)&&Number.isFinite(next?.lon)){
      return {status:"approximate", precision:"approximate", lat:next.lat, lon:next.lon, label: next.label || record?.project_name || outcome?.borough || "", method:"address_geocode"};
    }
  }
  return {status:"unresolved", reason:"no-resolution"};
}

/* ===================== DETAIL MAP (one selected project) =====================
   Leaflet loads on demand, and this module itself loads on demand, so opening the Land tab
   no longer warms either. The first row selection pays for the detail map; a resident who
   only scans the List never does. The asset URLs are unchanged from the pre-activation
   implementation: this card moved the detail map behind activation and did not migrate it. */
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
async function landShowMap(lat, lon, label, selection, precision="approximate"){
  const el=$("#landmap"); if(!el) return; el.style.display="none";
  const note = precision==="exact" ? "" : t("map_approx_note_html",{label});
  if($("#landmapnote")) $("#landmapnote").innerHTML=note;
  try{ await loadLeaflet(); }catch(e){}
  if(selection!==undefined && selection!==landSelectionSeq) return;
  if(typeof L==="undefined"){
    const controls=$("#landpan"); if(controls) controls.hidden=true;
    return;
  }
  el.style.display="block";
  globalThis.landMap=L.map(el).setView([lat,lon],15);
  wireLandPanControls(globalThis.landMap);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{attribution:'© OpenStreetMap © CARTO',subdomains:'abcd',maxZoom:19}).addTo(globalThis.landMap);
  // w9-10: Leaflet's marker icon renders as an <img> -- `alt` is its accessible name
  // (the list view, #llist, remains the real keyboard/SR-equivalent; this is a small assist).
  globalThis.landMarker=L.marker([lat,lon],{alt:label||t("map_marker_alt")}).addTo(globalThis.landMap);
  if(label) globalThis.landMarker.bindPopup(label).openPopup();
  setTimeout(()=>{ if(globalThis.landMap) globalThis.landMap.invalidateSize(); },150);
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
  globalThis.landMap=L.map(el);
  wireLandPanControls(globalThis.landMap);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{attribution:'© OpenStreetMap © CARTO · lots © NYC MapPLUTO',subdomains:'abcd',maxZoom:19}).addTo(globalThis.landMap);
  const layer=L.geoJSON(gj,{style:{color:'#1a44e0',weight:2,fillColor:'#1b3a8f',fillOpacity:.35}}).addTo(globalThis.landMap);
  try{ globalThis.landMap.fitBounds(layer.getBounds(),{padding:[20,20],maxZoom:17}); }catch(e){ globalThis.landMap.setView([40.71,-73.96],12); }
  setTimeout(()=>{ if(globalThis.landMap) globalThis.landMap.invalidateSize(); },160);
}

/* ===================== BROWSE MAP SHELL (route-lazy) =====================
   The spatial sibling of the Land List. It paints the population List already built —
   it never filters, searches, reorders, or re-queries — using the local SVG substrate
   and the committed point projection. Marker interaction is deliberately not here yet;
   this card owns the activation boundary, not the marker behaviour on top of it. */

export const LAND_MAP_SHELL_SCHEMA = "cityscroll.land_map_shell.v1";
/* The only network dependency browse Map activation adds: a committed, versioned, bounded
   projection served from this origin. No publisher call, no live GIS, no tile provider. */
export const LAND_MAP_POINTS_URL = "data/land_project_map_points.json";
export const LAND_MAP_PANEL_ID = "land-map-panel";

let landMapPointsPromise = null;
function loadLandMapPoints(){
  if(!landMapPointsPromise){
    landMapPointsPromise = fetch(LAND_MAP_POINTS_URL,{cache:"force-cache",credentials:"omit"})
      .then(response=>{
        if(!response.ok) throw new Error(`land-map-points-http-${response.status}`);
        return response.json();
      })
      .then(payload=>{
        // Fail closed. A missing or malformed projection is an honest map failure; it is
        // never an empty map, which would read as "no project here" to a resident.
        if(!payload || typeof payload!=="object" || !payload.points) throw new Error("land-map-points-malformed");
        return payload;
      })
      .catch(error=>{ landMapPointsPromise=null; throw error; });
  }
  return landMapPointsPromise;
}

/** Copy seam. The app publishes `t`; a node contract test injects its own. */
function mapCopy(key, values){
  const translate = globalThis.t;
  return typeof translate === "function" ? translate(key, values) : key;
}

function escapeMapHtml(value){
  return String(value ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#39;");
}

/** The panel is a sibling of the list and detail panels, never a replacement for them. */
function landMapPanel(host){
  const grid = host || document.getElementById("land-results-grid");
  if(!grid) return null;
  let panel = document.getElementById(LAND_MAP_PANEL_ID);
  if(!panel){
    panel = document.createElement("section");
    panel.className = "land-map-panel";
    panel.id = LAND_MAP_PANEL_ID;
    panel.setAttribute("aria-label", mapCopy("land_map_panel_label"));
    grid.insertBefore(panel, grid.firstChild);
  }
  return panel;
}

/* The borough outlines are schematic, so a viewport zoomed to a tight cluster of markers
   shows unrecognizable fragments of them. Hold a minimum extent: close enough to separate
   the points, wide enough that the shape underneath is still a place. */
const MIN_MAP_SPAN_LON = (NYC_BOUNDS.maxLon - NYC_BOUNDS.minLon) * 0.3;
const MIN_MAP_SPAN_LAT = (NYC_BOUNDS.maxLat - NYC_BOUNDS.minLat) * 0.3;

function landMapViewBox(bounds){
  if(!bounds) return defaultViewBox();
  const widen = (min, max, minimum) => {
    const short = minimum - (max - min);
    if(short <= 0) return [min, max];
    const centre = (min + max) / 2;
    return [centre - minimum / 2, centre + minimum / 2];
  };
  const [minLon, maxLon] = widen(bounds.minLon, bounds.maxLon, MIN_MAP_SPAN_LON);
  const [minLat, maxLat] = widen(bounds.minLat, bounds.maxLat, MIN_MAP_SPAN_LAT);
  return bboxToViewBox([minLon, minLat, maxLon, maxLat], 0.06);
}

export function landMapCanvasSvg(model, {t: copy = mapCopy, escape = escapeMapHtml} = {}){
  const viewBox = landMapViewBox(model.bounds);
  const width = Number(String(viewBox).split(/\s+/)[2]) || 1000;
  const radius = Math.max(1.2, width/90).toFixed(2);
  const outlines = Object.values(BOROUGH_HULLS)
    .map(hull=>polygonsToSvgPath([{rings:hull.rings}]))
    .filter(Boolean)
    .map(d=>`<path class="land-map-outline" d="${d}"/>`)
    .join("");
  const markers = model.markers.map(marker=>{
    const [x,y] = projectLonLat(marker.lon, marker.lat);
    const title = escape(marker.title || marker.projectId);
    return `<circle class="land-map-marker" data-land-map-precision="${escape(marker.precision)}"`
      + ` data-land-map-project="${escape(marker.projectId)}"`
      + ` cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius}"><title>${title}</title></circle>`;
  }).join("");
  return `<svg class="land-map-canvas" viewBox="${viewBox}" role="img" preserveAspectRatio="xMidYMid meet"`
    + ` aria-label="${escape(copy("land_map_canvas_alt",{n:model.counts.mapped}))}">`
    + `<g class="land-map-outlines" aria-hidden="true">${outlines}</g>`
    + `<g class="land-map-markers">${markers}</g></svg>`;
}

/**
 * The complete Map panel for one model. Pure: the mapped count, the explicit unmapped
 * count, and the marker geometry are all decided here so a contract test can read them
 * without a browser.
 */
export function landMapPanelHTML(model, {t: copy = mapCopy, escape = escapeMapHtml} = {}){
  const summary = copy("land_map_summary",{mapped:model.counts.mapped, total:model.counts.total});
  const unmapped = model.counts.unmapped
    ? `<p class="land-map-unmapped">${escape(copy("land_map_unmapped_note",{n:model.counts.unmapped}))}</p>`
    : "";
  return landMapCanvasSvg(model,{t:copy,escape})
    + `<p class="land-map-summary" id="land-map-summary" role="status">${escape(summary)}</p>`
    + unmapped;
}

/* The resident keeps the list they already have. This adds the two ways forward the
   fallback needs: try the map again, or say plainly "keep the list". */
export function landMapFailureHTML({t: copy = mapCopy, escape = escapeMapHtml} = {}){
  return `<p class="land-map-status land-map-failed" role="status">`
    + `${escape(copy("land_map_failed_heading"))}</p>`
    + `<div class="land-map-recovery">`
    + `<button class="act mini" type="button" data-land-map-retry="1">${escape(copy("land_map_retry"))}</button>`
    + `<button class="act mini" type="button" data-land-map-dismiss="1">${escape(copy("land_map_show_list"))}</button>`
    + `</div>`;
}

function renderLandMapModel(panel, model){
  panel.dataset.landMapState = "ready";
  panel.innerHTML = landMapPanelHTML(model);
}

function renderLandMapLoading(panel){
  panel.dataset.landMapState = "loading";
  panel.innerHTML = `<p class="land-map-status" role="status"><span class="loading"></span> `
    + `${escapeMapHtml(mapCopy("land_map_loading"))}</p>`;
}

function renderLandMapFailure(panel){
  panel.dataset.landMapState = "failed";
  panel.innerHTML = landMapFailureHTML();
  panel.querySelector("[data-land-map-retry]")?.addEventListener("click",()=>{
    globalThis.retryLandMapPresentation?.();
  });
  panel.querySelector("[data-land-map-dismiss]")?.addEventListener("click",()=>{
    globalThis.setLandView?.("list");
  });
}

/**
 * Paint the Map presentation for rows List has already filtered.
 *
 * Rejecting is how this reports a presentation failure to the route, which then paints the
 * same filtered List and says why. The panel keeps its own retry so the resident is never
 * left with a dead map and no way back to one.
 */
export async function mountLandBrowseMap(host, {rows, selectedProjectId, filters} = {}){
  const panel = landMapPanel(host);
  if(!panel) throw new Error("land-map-host-absent");
  renderLandMapLoading(panel);
  let payload;
  try{
    payload = await loadLandMapPoints();
  }catch(error){
    renderLandMapFailure(panel);
    throw error;
  }
  try{
    renderLandMapModel(panel, buildLandMapModel({
      rows: Array.isArray(rows) ? rows : [],
      pointLookup: payload,
      selectedProjectId,
      filters,
    }));
  }catch(error){
    renderLandMapFailure(panel);
    throw error;
  }
  return panel;
}

/** Leave the Land results exactly as List owns them. */
export function unmountLandBrowseMap(){
  document.getElementById(LAND_MAP_PANEL_ID)?.remove();
}

const landBrowseMapRenderer = Object.freeze({
  schema: LAND_MAP_SHELL_SCHEMA,
  pointsUrl: LAND_MAP_POINTS_URL,
  mount: mountLandBrowseMap,
  unmount: unmountLandBrowseMap,
});
// The seam land_view_switch.mjs reads. Registering it is what makes Map "ready", and it can
// only happen after activation has already fetched this module.
globalThis.CROL_LAND_MAP_RENDERER = landBrowseMapRenderer;

export {
  landShowLots,
  landShowMap,
  loadLeaflet,
  resolveLandMapLocation,
  wireLandPanControls,
};

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.landShowLots = landShowLots;
globalThis.landShowMap = landShowMap;
globalThis.loadLeaflet = loadLeaflet;
globalThis.resolveLandMapLocation = resolveLandMapLocation;
globalThis.wireLandPanControls = wireLandPanControls;
Object.defineProperty(globalThis, "leafletP", { configurable: true, get: () => leafletP, set: value => { leafletP = value; } });
