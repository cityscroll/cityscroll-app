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
  landMapBoundaryEvidenceHTML,
  landMapBoundarySvg,
  loadLandMapBoundaryContext,
} from "../land_map_boundary_context.mjs";
import { landMapAuthorityHandoff } from "../land_map_authority_handoff.mjs";
import { landProjectPath } from "../land_project_route.mjs";
import {
  landMapSelectionFocusIntent,
  landSelectionFromHistoryState,
  landSelectionHistoryPatch,
  nextLandMapSelection,
} from "../land_map_selection.mjs";
import { LAND_VIEW_LIST, landViewHref } from "../land_view_switch.mjs";
import {
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
   and the committed point projection.

   Selecting a marker is exploration within that population, never a query against it: the
   selected project is one of the rows already on screen, described from that row, and the
   only thing an activation costs is a repaint. */

export const LAND_MAP_SHELL_SCHEMA = "cityscroll.land_map_shell.v1";
/* The only network dependency browse Map activation adds: a committed, versioned, bounded
   projection served from this origin. No publisher call, no live GIS, no tile provider. */
export const LAND_MAP_POINTS_URL = "data/land_project_map_points.json";
export const LAND_MAP_PANEL_ID = "land-map-panel";
export const LAND_MAP_SELECTION_ID = "land-map-selected";

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

let landMapBoundaryPromise = null;
function loadLandMapBoundaries(){
  if(!landMapBoundaryPromise){
    landMapBoundaryPromise = loadLandMapBoundaryContext().catch(()=>null);
  }
  return landMapBoundaryPromise;
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

/* ===================== SELECTION STATE =====================
   Selection belongs to the module that owns the map, and it lives here rather than in the route
   for two reasons. It is meaningless without a painted map: there is nothing to select when the
   Map is not the view, and this module only exists once Map has been activated. And it costs the
   route nothing, because the state itself is not held here -- it is held on the history entry,
   which survives the document reload that following a project detail causes. See
   land_map_selection.mjs for what a remembered id means and when it stops meaning it.

   The route's own seams are reused as published: `routeHistoryState` to write a history note
   without clobbering the entry's scroll and back context, `applyLandPresentation` to repaint,
   `setLandView` for the List handoff, and `landFocusListProject` to land on the row. Selection
   adds no seam of its own to the route. */

/** Where focus belongs after the next paint, and nothing after that. One-shot. */
let landMapFocusIntent = null;
/** True once this document has adopted whatever selection its history entry remembered. */
let landSelectionHydrated = false;

function currentLandSelection(){
  return landSelectionFromHistoryState(globalThis.history?.state);
}

function rememberLandSelection(projectId){
  const patch = landSelectionHistoryPatch(projectId);
  const build = globalThis.routeHistoryState;
  try{
    history.replaceState(typeof build === "function" ? build(patch) : patch, "", location.href);
  }catch(_e){ /* a history that will not take a note is not a reason to refuse a selection */ }
}

/* The Back half of the round trip. Following the canonical detail route leaves this document,
   so returning reloads it: the resident comes back to an entry that still remembers the project
   they left from, and the marker that sent them there takes focus again. A `view=map` link
   opened cold carries no such note, so nothing is selected and nothing takes focus. */
function hydrateLandSelectionFocus(){
  if(landSelectionHydrated) return;
  landSelectionHydrated = true;
  const remembered = currentLandSelection();
  if(remembered) landMapFocusIntent = landMapSelectionFocusIntent({projectId:remembered, kind:"marker"});
}

/**
 * Select one project on the Map, or clear the selection with a null id.
 *
 * This repaints and does nothing else. It runs no search, fetches no project, and touches no
 * filter: the id it is given already belongs to a row the current result set holds, and the
 * summary is written from that row.
 */
export function setLandMapSelection(projectId, {focus = "selection"} = {}){
  landSelectionHydrated = true;
  landMapFocusIntent = landMapSelectionFocusIntent({projectId, kind:focus});
  rememberLandSelection(projectId);
  return globalThis.applyLandPresentation?.();
}

/** Remember which marker sent the resident into a project detail, for the return trip. */
function noteLandMapDetailDeparture(projectId){
  const id = String(projectId ?? "").trim();
  if(!id || id !== currentLandSelection()) return;
  landMapFocusIntent = landMapSelectionFocusIntent({projectId:id, kind:"marker"});
}

/* The explicit Map -> List handoff: switch presentation, then point List at the project the
   resident was already looking at, using List's own row selection. No query is issued and no
   population is rebuilt -- the row is one of the rows already on screen. */
export function landMapListHandoff(projectId){
  const id = String(projectId ?? "").trim();
  landMapFocusIntent = null;
  globalThis.setLandView?.("list");
  if(!id) return false;
  return globalThis.landFocusListProject?.(id) === true;
}

/* What painted is the truth. A refusal is written straight back to the entry, so a project the
   filter no longer holds cannot return selected when the resident widens the filter again. */
function reconcileLandMapSelection(panel, population){
  const requested = currentLandSelection();
  if(!requested) return panel;
  const next = nextLandMapSelection({
    requested,
    painted: panel?.dataset?.landMapSelected || "",
    population,
  });
  if(next !== requested) rememberLandSelection(null);
  return panel;
}

/* Selection interaction, delegated once onto the panel.
 *
 * Delegated because every repaint replaces the panel's children, so a listener bound to a
 * marker would be thrown away with it; the panel element itself survives.
 *
 * Keyboard is wired explicitly and not inherited from the pointer. An SVG group with a button
 * role gets no free activation from the browser the way a real button element does, so Enter
 * and Space are handled here; without them the whole map would be pointer-only, which is
 * exactly the failure this card exists to prevent.
 *
 * The route owns the state. This module reports the resident's intent and paints what it is
 * told; it holds no selection of its own, so the map can never disagree with the route about
 * which project is selected. */
function installLandMapSelection(panel){
  // The panel is an ordinary element in the browser, and a minimal host in the pure contract
  // fixtures. A host that cannot take listeners still gets a painted map; it just gets no
  // interaction, which is the honest degradation rather than a thrown mount.
  if(typeof panel?.addEventListener !== "function") return;
  if(panel.dataset.landMapSelectionInstalled === "true") return;
  panel.dataset.landMapSelectionInstalled = "true";
  const activate = (target)=>{
    const marker = target?.closest?.("[data-land-map-project][role='button']");
    if(marker && panel.contains(marker)){
      // Idempotent by construction: the id is the whole message, so activating the marker
      // that is already selected re-states the same selection instead of adding one.
      setLandMapSelection(marker.dataset.landMapProject);
      return true;
    }
    return false;
  };
  panel.addEventListener("click",(event)=>{
    const clear = event.target?.closest?.("[data-land-map-clear]");
    if(clear && panel.contains(clear)){
      event.preventDefault();
      setLandMapSelection(null);
      return;
    }
    const handoff = event.target?.closest?.("[data-land-map-list-handoff]");
    if(handoff && panel.contains(handoff)){
      event.preventDefault();
      landMapListHandoff(handoff.dataset.landMapListHandoff);
      return;
    }
    // The detail action is an ordinary link and is left alone to navigate. The route is told
    // which marker sent the resident there so Back can put focus back on it.
    const detail = event.target?.closest?.("[data-land-map-detail]");
    if(detail && panel.contains(detail)){
      noteLandMapDetailDeparture(detail.dataset.landMapDetail);
      return;
    }
    if(activate(event.target)) event.preventDefault();
  });
  panel.addEventListener("keydown",(event)=>{
    if(event.key==="Escape"){
      if(!panel.querySelector(`#${LAND_MAP_SELECTION_ID}`)) return;
      event.preventDefault();
      setLandMapSelection(null);
      return;
    }
    if(event.key!=="Enter" && event.key!==" " && event.key!=="Spacebar") return;
    const marker = event.target?.closest?.("[data-land-map-project][role='button']");
    if(!marker || !panel.contains(marker)) return;
    event.preventDefault();
    activate(marker);
  });
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
    panel.tabIndex = -1;
    panel.setAttribute("aria-label", mapCopy("land_map_panel_label"));
    grid.insertBefore(panel, grid.firstChild);
  }
  installLandMapSelection(panel);
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

/* Resident-facing names for the placement methods and precisions the model accepts.
   A marker that cannot say how it was placed implies an exactness the projection never
   claimed, so a label always carries the method AND its precision -- an anchor for a
   25-lot rezoning and a single lot centre are both "on the map", and only the label
   keeps them from reading the same. */
const LAND_MAP_METHOD_COPY = Object.freeze({
  publisher_point: "land_map_method_publisher_point",
  single_bbl_centroid: "land_map_method_single_bbl_centroid",
  multi_bbl_anchor: "land_map_method_multi_bbl_anchor",
  property_coordinate: "land_map_method_property_coordinate",
  geometry_representative_point: "land_map_method_geometry_representative_point",
});
const LAND_MAP_PRECISION_COPY = Object.freeze({
  exact: "land_map_precision_exact",
  anchor: "land_map_precision_anchor",
  representative: "land_map_precision_representative",
});

/* The one route a marker may lead to: the canonical Land detail path a List card already
   links to. `landProjectPath` validates the id shape and returns null for anything that is
   not a real project id, so a malformed row can never mint a link to a route that is not
   there. A marker is a second way to reach one project, never a second identity for it. */
export function landMarkerDetailHref(projectId){
  const canonical = landProjectPath(projectId);
  if(!canonical) return null;
  // Prefer the app's own link builder when it is published: it carries the resident's
  // language exactly the way a List card's link does, so following a marker cannot quietly
  // drop a Spanish reader onto an English page. Same canonical path underneath; the
  // fallback keeps this function pure for the node contract tests.
  const link = globalThis.landLink;
  return (typeof link === "function" ? link(projectId) : "") || canonical;
}

/**
 * The marker layer for one model: one record per mapped filtered row, in the model's own
 * order, each carrying the identity, point, placement method, precision, and projection
 * vintage the evidence contract requires. Pure, so the join can be read without a browser.
 *
 * It renders `model.markers` and nothing else. There is no path here from a point-artifact
 * key to a marker: an entry the filtered rows did not produce never reaches this function.
 */
export function landMapMarkerLayer(model, {t: copy = mapCopy, sourceVintage = null} = {}){
  return Object.freeze((model?.markers || []).map(marker=>{
    const title = String(marker.title ?? "").trim() || marker.projectId;
    const methodKey = LAND_MAP_METHOD_COPY[marker.method];
    const precisionKey = LAND_MAP_PRECISION_COPY[marker.precision];
    const method = methodKey ? copy(methodKey,{n:marker.bblCount ?? 0}) : marker.method;
    const precision = precisionKey ? copy(precisionKey) : marker.precision;
    return Object.freeze({
      projectId: marker.projectId,
      title,
      lat: marker.lat,
      lon: marker.lon,
      method: marker.method,
      precision: marker.precision,
      bblCount: marker.bblCount,
      href: landMarkerDetailHref(marker.projectId),
      label: copy("land_map_marker_label",{title, method, precision}),
      selected: marker.selected,
      sourceVintage,
      // LM-17: an optional, already-gated parcel shape for the same project id. Never
      // computed here -- carried through from the model, which already validated it.
      geometry: marker.geometry ?? null,
    });
  }));
}

/**
 * Render the exact-key parcel outlines beside their markers. Geometry is
 * never interactive and never carries its own label: it reuses the same
 * accessible marker label already computed by `landMapMarkerLayer`, so
 * shipping this layer adds no new translated copy surface. A marker with
 * no shape (the ambiguous, missing, invalid, and stale cases — the large
 * majority of the corpus) renders nothing here and is unaffected.
 *
 * @param {ReadonlyArray<{projectId:string, geometry:object|null, label:string}>} markerLayer
 * @param {{ escape?: (value:unknown)=>string }} [opts]
 */
export function landMapParcelSvg(markerLayer, { escape = escapeMapHtml } = {}){
  const paths = (markerLayer || [])
    .filter((marker) => marker?.geometry?.rings)
    .map((marker) => {
      const shape = marker.geometry;
      const d = polygonsToSvgPath([{ rings: shape.rings }]);
      if(!d) return "";
      return `<path class="land-map-outline land-map-parcel-outline" d="${d}" fill="none"`
        + ` pointer-events="none" data-land-map-project="${escape(marker.projectId)}"`
        + ` data-land-map-parcel-method="${escape(shape.method)}"`
        + ` data-land-map-parcel-precision="${escape(shape.precision)}"`
        + ` data-land-map-parcel-relation="${escape(shape.relation)}"`
        + ` data-land-map-parcel-vintage="${escape(shape.vintage)}"`
        + `><title>${escape(marker.label)}</title></path>`;
    })
    .join("");
  return `<g class="land-map-parcels" aria-hidden="true">${paths}</g>`;
}

export function landMapCanvasSvg(model, {
  t: copy = mapCopy,
  escape = escapeMapHtml,
  sourceVintage = null,
  boundaryContext = null,
  currentHash = "#land",
} = {}){
  const viewBox = landMapViewBox(model.bounds);
  const width = Number(String(viewBox).split(/\s+/)[2]) || 1000;
  const radius = Math.max(1.2, width/90).toFixed(2);
  const boundaries = landMapBoundarySvg(boundaryContext, {escape, currentHash});
  const markerLayer = landMapMarkerLayer(model,{t:copy, sourceVintage});
  // Parcel outlines paint between boundary context and markers: under the markers that are
  // still the only quantitative layer, above the district geometry they orient against.
  const parcels = landMapParcelSvg(markerLayer, {escape});
  const markers = markerLayer.map(marker=>{
    const [x,y] = projectLonLat(marker.lon, marker.lat);
    const label = escape(marker.label);
    const circle = `<circle class="land-map-marker" data-land-map-precision="${escape(marker.precision)}"`
      + ` data-land-map-method="${escape(marker.method)}"`
      + ` data-land-map-project="${escape(marker.projectId)}"`
      + ` cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius}"><title>${label}</title></circle>`;
    // An id the canonical Land route will not accept gets a point but never a control: a
    // marker that cannot be traced back to a real project row must not offer a way into a
    // record that is not there.
    if(!marker.href) return circle;
    // A button, not a link, and the distinction is the whole selection contract. Activating
    // a marker does not leave the map: it selects one project and paints the summary below,
    // where the canonical detail route lives as a real link. An anchor whose activation did
    // not navigate would announce a destination it never goes to. The canonical href still
    // rides on the control, so the marker's identity stays checkable from the marker itself.
    return `<g class="land-map-marker-control" role="button" tabindex="0"`
      + ` data-land-map-project="${escape(marker.projectId)}"`
      + ` data-land-map-href="${escape(marker.href)}"`
      + (marker.selected ? ` aria-current="true" data-land-map-selected="true"` : "")
      + ` aria-label="${label}">${circle}</g>`;
  }).join("");
  // `role="group"`, not `role="img"`: the markers are the canonical way into each project
  // from here, and an image role would hide every one of those links from assistive tech.
  return `<svg class="land-map-canvas" viewBox="${viewBox}" role="group" preserveAspectRatio="xMidYMid meet"`
    + (sourceVintage ? ` data-land-map-source-vintage="${escape(sourceVintage)}"` : "")
    + ` aria-label="${escape(copy("land_map_canvas_alt",{n:model.counts.mapped}))}">`
    + `<g class="land-map-outlines">${boundaries}</g>`
    + parcels
    + `<g class="land-map-markers">${markers}</g></svg>`;
}

/**
 * The selected project summary: what one marker turned out to be, and the two ways on.
 *
 * It is written from `model.selectedRow` — the row the List already filtered — and from the
 * point the same model joined to it. Nothing here is fetched, and no project is reconstructed
 * from a point: an id the filtered rows do not hold has no `selectedMarker`, so this renders
 * nothing at all rather than inventing a record to describe.
 *
 * Compact on purpose. The full dossier lives one canonical link away, and repeating it here
 * would make the map a second, staler copy of the project record.
 */
export function landMapSelectionHTML(model, {t: copy = mapCopy, escape = escapeMapHtml, sourceVintage = null} = {}){
  const selectedId = model?.selectedProjectId;
  if(!selectedId || !model?.selectedMarker) return "";
  const marker = landMapMarkerLayer(model,{t:copy, sourceVintage}).find(item=>item.projectId===selectedId);
  if(!marker) return "";
  const row = model.selectedRow || null;
  const title = marker.title;
  // The row's own status, exactly as the List card states it. No inference and no default:
  // a project whose status the row does not carry gets no status line rather than a guess.
  const status = String(row?.public_status ?? row?.project_status ?? "").trim();
  const methodKey = LAND_MAP_METHOD_COPY[marker.method];
  const precisionKey = LAND_MAP_PRECISION_COPY[marker.precision];
  const method = methodKey ? copy(methodKey,{n:marker.bblCount ?? 0}) : marker.method;
  const precision = precisionKey ? copy(precisionKey) : marker.precision;
  // Each control is built as one whole element in one template literal. Splitting an opening
  // tag from its closing tag across concatenated strings hides the control's real label from
  // the control-label lint, which then reads everything between them as the label.
  const detailLabel = escape(copy("land_map_selected_detail"));
  const detail = marker.href
    ? `<a class="land-map-selected-detail" href="${escape(marker.href)}" data-land-map-detail="${escape(selectedId)}">${detailLabel}</a>`
    : "";
  const handoff = `<button class="act mini" type="button" data-land-map-list-handoff="${escape(selectedId)}">${escape(copy("land_map_selected_list"))}</button>`;
  const clear = `<button class="act mini" type="button" data-land-map-clear="1">${escape(copy("land_map_selected_clear"))}</button>`;
  const authority = landMapAuthorityHandoff({
    projectId: selectedId,
    row,
    panelHref: marker.href,
  });
  const authorityLabel = authority.state === "available"
    ? copy("land_map_authority_available")
    : authority.state === "partial"
      ? copy("land_map_authority_partial")
      : copy("land_map_authority_unavailable");
  // The procedure-state label is the typed read a resident actually needs: mixed, unknown, and
  // stale each say a different thing about why "who has the ball" is not a clean answer, so
  // none of them get flattened into the same "unavailable" wording the top-level state uses.
  const procedureStateKey = {
    known: "land_map_authority_procedure_known",
    mixed: "land_map_authority_procedure_mixed",
    unknown: "land_map_authority_procedure_unknown",
    stale: "land_map_authority_procedure_stale",
    missing: "land_map_authority_procedure_missing",
  }[authority.procedure_state] || "land_map_authority_procedure_missing";
  const showSupplied = authority.procedure_state !== "missing";
  const roleLabel = authority.normative?.current_role
    ? (() => {
        const key = `land_authority_role_${authority.normative.current_role}`;
        const label = copy(key);
        return label === key ? authority.normative.current_role : label;
      })()
    : null;
  const nextAction = authority.next_action || { status: "missing" };
  const nextActionHTML = nextAction.status === "published"
    ? escape(nextAction.date ? copy("land_map_authority_next_action_published", { date: nextAction.date }) : (nextAction.label || copy("land_map_authority_next_action_published", { date: "" })))
    : escape(copy("land_map_authority_next_action_not_published"));
  const authorityFields = !showSupplied ? ""
    : `<span data-land-map-authority-procedure="${escape(authority.procedure_id || "")}">${escape(authority.procedure_id || copy("land_authority_unknown"))}</span>`
      + ` · <span data-land-map-authority-stage="${escape(authority.stage?.stage_id || "")}">${escape(authority.stage?.stage_id || copy("land_authority_unknown"))}</span>`
      + (roleLabel ? ` · <span data-land-map-authority-role="${escape(authority.normative.current_role)}" data-land-map-authority-kind="role">${escape(roleLabel)}</span>` : "")
      + `<div data-land-map-authority-next-action="${escape(nextAction.status)}" data-land-map-authority-next-action-date="${escape(nextAction.date || "")}" data-land-map-authority-kind="next_action">${nextActionHTML}</div>`;
  const authorityHandoff = `<div class="land-map-authority-handoff" data-land-map-authority="1" data-land-map-authority-state="${escape(authority.state)}" data-land-map-authority-procedure-state="${escape(authority.procedure_state)}" data-land-map-authority-project="${escape(selectedId)}" data-land-map-authority-projection="${escape(authority.projection_version)}" data-land-map-authority-source-receipt="${escape(authority.source_receipt || "")}" data-land-map-authority-source-vintage="${escape(authority.source_vintage || "")}" data-land-map-location-state="mapped">`
    + `<strong>${escape(copy("land_map_authority_heading"))}</strong> <span data-land-map-authority-state-label="1">${escape(authorityLabel)}</span>`
    + ` <span data-land-map-authority-procedure-state-label="1">${escape(copy(procedureStateKey))}</span>`
    + (authorityFields ? `<div data-land-map-authority-supplied="1">${authorityFields}</div>` : "")
    + (authority.panel_href ? `<a class="land-map-authority-link" href="${escape(authority.panel_href)}" data-land-map-authority-detail="${escape(selectedId)}">${escape(copy("land_map_authority_detail"))}</a>` : "")
    + `</div>`;
  return `<section class="land-map-selected" id="${LAND_MAP_SELECTION_ID}" tabindex="-1"`
    + ` data-land-map-project="${escape(selectedId)}"`
    + ` data-land-map-method="${escape(marker.method)}"`
    + ` data-land-map-precision="${escape(marker.precision)}"`
    // The projection this placement came from travels with the selection, the same vintage the
    // canvas carries. A summary that outlived its source would otherwise read as current.
    + (sourceVintage ? ` data-land-map-source-vintage="${escape(sourceVintage)}"` : "")
    + ` aria-label="${escape(copy("land_map_selected_region",{title}))}">`
    + `<h3 class="land-map-selected-title">${escape(title)}</h3>`
    + (status ? `<p class="land-map-selected-status">${escape(status)}</p>` : "")
    // Method and precision together, never one without the other: this is the line that keeps
    // a 25-lot anchor from reading as a doorstep.
    + `<p class="land-map-selected-placement">${escape(copy("land_map_selected_placement",{method, precision}))}</p>`
    + `<p class="land-map-selected-source">${escape(copy("land_map_selected_source"))}</p>`
    + authorityHandoff
    + `<div class="land-map-selected-actions">${detail}${handoff}${clear}</div></section>`;
}

/**
 * The population orientation strip: what the map can show, what it cannot, and the way
 * back to the complete List. It reads first, before the canvas, on every viewport — a
 * resident who has not yet found a marker still needs the scope of the results and an
 * unconditional way out, and a narrow screen is exactly where scrolling past a tall
 * canvas to find either would cost the most. Pure, so a contract test can read the
 * counts and the List link without a browser.
 */
export function landMapOrientationHTML(model, {
  t: copy = mapCopy,
  escape = escapeMapHtml,
  currentHash = "#land",
} = {}){
  // "0 of 0 projects are on the map." beside a blank canvas reads as a map that failed. An
  // empty result is a fact about the filter, not about the map, and the List's own empty state
  // sits directly below with the way to widen it -- so this says which of the two happened and
  // leaves the recovery where it already is.
  const summary = model.counts.total === 0
    ? copy("land_map_empty")
    : copy("land_map_summary",{mapped:model.counts.mapped, total:model.counts.total});
  const unmapped = model.counts.unmapped
    ? `<p class="land-map-unmapped">${escape(copy("land_map_unmapped_note",{n:model.counts.unmapped}))}</p>`
    : "";
  // A real shareable List route, not a JS-only affordance: a resident who never gets a
  // repaint (no-JS, or a Map that never finishes loading) still has a plain link out.
  // Delegated click handling on the panel (installLandMapSelection) upgrades it in place.
  const listLink = `<a class="land-map-list-link act mini" href="${escape(landViewHref(LAND_VIEW_LIST, currentHash))}"`
    + ` data-land-map-list-handoff="">${escape(copy("land_map_back_to_list"))}</a>`;
  // All three counts, always, and on the same element: the mapped count is what the map can
  // show, the total is what the List holds, and the difference is the part of the answer the
  // map cannot draw. Publishing only the first would let the marker count read as the total.
  return `<div class="land-map-orientation">`
    + `<p class="land-map-summary" id="land-map-summary" role="status"`
    + ` data-land-map-total="${model.counts.total}"`
    + ` data-land-map-mapped="${model.counts.mapped}"`
    + ` data-land-map-unmapped="${model.counts.unmapped}">${escape(summary)}</p>`
    + unmapped
    + listLink
    + `</div>`;
}

/**
 * The complete Map panel for one model. Pure: the orientation strip, the marker geometry,
 * and the selected-project summary are all decided here so a contract test can read them
 * without a browser.
 */
export function landMapPanelHTML(model, {
  t: copy = mapCopy,
  escape = escapeMapHtml,
  sourceVintage = null,
  boundaryContext = null,
  currentHash = "#land",
} = {}){
  // Order is the reader journey. Orientation comes first — the counts and the way out — then
  // the canvas itself, then boundary context, then the selected project last, because it is
  // one resident's exploration of the population and not the orientation itself.
  return landMapOrientationHTML(model,{t:copy,escape,currentHash})
    + landMapCanvasSvg(model,{t:copy,escape,sourceVintage,boundaryContext,currentHash})
    + landMapBoundaryEvidenceHTML(boundaryContext, {t:copy, escape})
    + landMapSelectionHTML(model,{t:copy,escape,sourceVintage});
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

/* Focus survives a repaint.
 *
 * The Map repaints for reasons that have nothing to do with where the resident is: a Back that
 * re-runs the filtered search paints two or three times before it settles. `innerHTML` destroys
 * whatever was focused, and a destroyed focus target sends focus to the document root, which is
 * how a keyboard resident silently loses their place mid-journey. So the panel remembers which
 * of its own controls held focus, keyed by project id rather than by node, and puts focus back
 * on the equivalent control in the new paint.
 *
 * When the equivalent control is gone -- the filter no longer holds that project -- focus lands
 * on the panel itself. Never on <body>. */
function landMapFocusKey(panel){
  const active = panel?.ownerDocument?.activeElement;
  if(!active || typeof panel.contains !== "function" || !panel.contains(active)) return null;
  const marker = active.closest?.("[data-land-map-project][role='button']");
  if(marker) return {kind:"marker", projectId:marker.dataset.landMapProject};
  if(active.id===LAND_MAP_SELECTION_ID) return {kind:"selection"};
  return null;
}

export function landMapFocusTarget(panel, intent){
  if(!panel || !intent || typeof panel.querySelector !== "function") return null;
  const escapeId = (value) => (typeof CSS?.escape === "function" ? CSS.escape(value) : value);
  if(intent.kind==="marker" && intent.projectId){
    const marker = panel.querySelector(
      `[data-land-map-project="${escapeId(intent.projectId)}"][role="button"]`);
    if(marker) return marker;
  }
  if(intent.kind==="selection" || intent.kind==="marker"){
    const selection = panel.querySelector(`#${LAND_MAP_SELECTION_ID}`);
    if(selection) return selection;
  }
  return panel;
}

function restoreLandMapFocus(panel, intent){
  const target = landMapFocusTarget(panel, intent);
  if(!target || typeof target.focus !== "function") return null;
  try{ target.focus({preventScroll:true}); }catch(_e){ try{ target.focus(); }catch(_ignored){} }
  return target;
}

function renderLandMapModel(panel, model, sourceVintage, boundaryContext, currentHash){
  const carried = landMapFocusKey(panel);
  panel.dataset.landMapState = "ready";
  // What actually painted, which is not always what was asked for: the model refuses a
  // selection whose project the current filter does not hold, and the route reads this back
  // to forget the id instead of holding it against a later, wider filter.
  if(model.selectedProjectId) panel.dataset.landMapSelected = model.selectedProjectId;
  else delete panel.dataset.landMapSelected;
  // How many rows this paint actually had an opinion about. A paint over an empty population
  // -- the cold `view=map` load, before the search has returned -- is not evidence that a
  // remembered project has left the filter; it is evidence of nothing yet.
  panel.dataset.landMapPopulation = String(model.counts.total);
  panel.dataset.landMapBoundaryState = boundaryContext?.state || "unavailable";
  panel.innerHTML = landMapPanelHTML(model, {
    sourceVintage,
    boundaryContext,
    currentHash,
  });
  if(carried) restoreLandMapFocus(panel, carried);
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
  let boundaryContext;
  try{
    [payload, boundaryContext] = await Promise.all([loadLandMapPoints(), loadLandMapBoundaries()]);
  }catch(error){
    renderLandMapFailure(panel);
    throw error;
  }
  const population = Array.isArray(rows) ? rows : [];
  hydrateLandSelectionFocus();
  // The one-shot focus waits for a population. The Map paints more than once on the way back
  // from a project detail -- the reloaded document paints an empty map before its search
  // returns -- and spending the focus on that paint would put the resident on the panel instead
  // of the marker they left from. The caller may still name a selection explicitly; when it does
  // not, the history entry is the answer.
  const havePopulation = population.length > 0;
  const intent = havePopulation ? landMapFocusIntent : null;
  if(havePopulation) landMapFocusIntent = null;
  try{
    renderLandMapModel(panel, buildLandMapModel({
      rows: population,
      pointLookup: payload,
      selectedProjectId: selectedProjectId ?? currentLandSelection(),
      filters,
    }), payload.schema ?? null, boundaryContext,
      globalThis.serializeState?.() || globalThis.location?.hash
        || (globalThis.location?.search ? `#land${globalThis.location.search}` : "#land"));
  }catch(error){
    renderLandMapFailure(panel);
    throw error;
  }
  if(intent) restoreLandMapFocus(panel, intent);
  return reconcileLandMapSelection(panel, population.length);
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
