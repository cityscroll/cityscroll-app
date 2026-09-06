// The root URL is a static-first topic entry. Keep the complete application graph
// behind an explicit route so no source lookup or lens module can delay home paint.
const rootPath = (location.pathname || "/").replace(/\/+$/, "") || "/";
const isNeutralHome = rootPath === "/" && !location.hash;
if (!isNeutralHome) document.body?.setAttribute("data-app-route", "true");

const NOTICE_ROUTE = location.hash.startsWith("#notice/") || location.pathname.startsWith("/notices/");
const NOTICE_CONTEXT_MODULE_PATH = "./notice-context.mjs";
const APP_IMPORT_PHASES = new Set(["start", "core-end", "notice-context-start", "notice-context-end", "route-modules-start", "route-modules-end", "end"]);
function appImportTimingMark(phase){
  if(!APP_IMPORT_PHASES.has(phase)) return;
  try{ globalThis.performance?.mark?.(`cityscroll.app-import.${phase}`); }catch(_e){}
}

// Every lens the tab strip can open is a route module. Property and rules were gated
// first; Contracts, Land, Exams, Staffing and Meetings follow the same contract, so a
// route only pays for the lenses it shows. Routing itself stays eager: the loader is a
// narrow activation gate, not a second route-state owner.
const routeModuleLoaders = Object.freeze({
  property: () => import("./property.mjs"),
  rules: () => import("./rules.mjs"),
  money: () => import("./money-list.mjs"),
  land: () => import("./land.mjs"),
  exams: () => import("./exams.mjs"),
  staffing: () => import("./staffing.mjs"),
  meetings: () => import("./meetings.mjs"),
});
// Shell chrome a lens fills once it activates. The Contracts agency facet lives in the
// shell on every route but only the Contracts module knows how to populate it.
const routeModuleActivations = Object.freeze({
  money: () => { globalThis.loadAgencies?.(); },
});
const routeModulePromises = new Map();
const loadedRouteModules = new Set();

function ensureRouteStylesheet(path){
  if(document.querySelector(`link[data-route-style="${path}"]`)) return;
  const link=document.createElement("link");
  link.rel="stylesheet"; link.href=path; link.dataset.routeStyle=path;
  document.head.appendChild(link);
}

function routeModuleForHash(hash){
  const raw=String(hash||"").replace(/^#/,"").toLowerCase();
  const tab=raw.replace(/\?.*$/,"");
  const path=String(location.pathname||"").toLowerCase();
  if(tab==="rules" || path==="/browse/rules/") return "rules";
  // Notice detail (incl. rule case files) is a property-route surface; the property
  // gate chains rules behind it.
  if(tab==="property" || raw.startsWith("notice/") || path.startsWith("/notices/") || path==="/browse/property/") return "property";
  if(tab==="money" || path==="/browse/contracts/") return "money";
  if(tab==="land" || raw.startsWith("land/") || path==="/browse/zoning/") return "land";
  if(tab==="exams" || raw.startsWith("exam/") || path==="/browse/exams/") return "exams";
  if(tab==="staffing" || path==="/browse/staffing/") return "staffing";
  if(tab==="meetings" || path==="/browse/meetings/") return "meetings";
  return null;
}
// A few routes render one lens's records inside another surface. The matter page shows
// a procurement paper trail beside its Council record; entity profiles link the matters
// and officials the Meetings read model names.
const ROUTE_COMPANION_MODULES = Object.freeze({
  "matter/": ["money", "meetings"],
  "vendor/": ["meetings"],
  "agency/": ["meetings"],
  "official/": ["meetings"],
});
function companionRouteModules(hash){
  const raw=String(hash||"").replace(/^#/,"").toLowerCase();
  for(const [prefix, names] of Object.entries(ROUTE_COMPANION_MODULES)){
    if(raw.startsWith(prefix)) return names;
  }
  return [];
}
function ensureRouteModule(name){
  const loader=routeModuleLoaders[name];
  if(!loader) return Promise.resolve();
  if(name === "property"){
    ensureRouteStylesheet("property.css");
    // CBICS-03: notice detail (incl. rule case files) loads via "property"; the
    // shared compact month component's CSS rides along the same gate.
    ensureRouteStylesheet("compact_calendar.css");
  }
  if(!routeModulePromises.has(name)){
    routeModulePromises.set(name,(name === "property" ? ensureRouteModule("rules") : Promise.resolve()).then(()=>loader()).then(module=>{
      loadedRouteModules.add(name);
      routeModuleActivations[name]?.();
      return module;
    }));
  }
  return routeModulePromises.get(name);
}
function ensureRouteModulesForHash(hash){
  const names=[routeModuleForHash(hash), ...companionRouteModules(hash)].filter(Boolean);
  if(!names.length) return Promise.resolve();
  return Promise.all([...new Set(names)].map(ensureRouteModule));
}
globalThis.CrolRouteModules=Object.freeze({
  ensure:ensureRouteModule,
  ensureForHash:ensureRouteModulesForHash,
  isReady:name=>!routeModuleLoaders[name] || loadedRouteModules.has(name),
});
globalThis.ensureRules = () => ensureRouteModule("rules");

// A Notice route renders a public record, not a lens list. The five lens groups below
// stay behind the gate for it and activate only if the notice turns out to have that
// section; every other route keeps loading them in the order it always has.
const ensureLensModule = name => NOTICE_ROUTE ? Promise.resolve() : ensureRouteModule(name);

async function loadApplication() {
appImportTimingMark("start");
await import("./core.mjs");
appImportTimingMark("core-end");
let noticeContextPromise = NOTICE_ROUTE ? import(NOTICE_CONTEXT_MODULE_PATH) : null;
if(noticeContextPromise) appImportTimingMark("notice-context-start");
globalThis.CrolScope = await import("../scope_v0.mjs");
globalThis.CrolEntityPivots = await import("../entity_pivot.mjs");
globalThis.CrolReportIssue = await import("../report_issue.mjs");
globalThis.CrolAgencyConnections = await import("../agency_connections.mjs");
globalThis.CrolRouteMigration = await import("../route_migration.mjs");
await import("./traversal.mjs");
await import("./contracts-rum.mjs");
await ensureLensModule("money");
let moneyHistoryPromise;
globalThis.ensureMoneyHistory = () => moneyHistoryPromise ||= import("./money-history.mjs");
await import("./search-share.mjs");
await ensureLensModule("exams");
await ensureLensModule("staffing");
await ensureLensModule("land");
// Every Land map dependency -- browse Map shell, point projection, detail-map assets -- lives
// behind this gate. Opening the Land tab must not pull it: List first paint is the civic task,
// and the map is the sibling a resident asks for. Activation is `view=map`, the Map control, or
// selecting one project row.
let landMapRuntimePromise;
globalThis.ensureLandMapRuntime = () => landMapRuntimePromise ||= import("./map_runtime.mjs");
// The full structured filing-report detail (every RER section with page
// citations) stays out of first paint. It is fetched only once a reader
// presses "View full report" on the compact Application filings row.
let landFilingReportRuntimePromise;
globalThis.ensureLandFilingReportRuntime = () => landFilingReportRuntimePromise ||= import("./land_filing_report_runtime.mjs");
await import("./feed-actions.mjs");
await import("./result-match.mjs");
// Entity profiles use this shared section vocabulary without needing the notice-only context island.
globalThis.SECTION_LENS={"Procurement":"money","Public Hearings and Meetings":"meetings","Agency Rules":"rules","Property Disposition":"property","Changes in Personnel":"people"};
globalThis.ensureNoticeContext = () => noticeContextPromise ||= import("./notice-context.mjs");
if(NOTICE_ROUTE) appImportTimingMark("route-modules-start");
await ensureRouteModulesForHash(location.hash);
if(NOTICE_ROUTE) appImportTimingMark("route-modules-end");
await import("./procurement-lifecycle.mjs");
await import("./procurement-phase.mjs");
await import("./subsidy.mjs");
if(location.hash.startsWith("#notice/") || location.pathname.startsWith("/notices/")){
  await globalThis.ensureNoticeContext();
  appImportTimingMark("notice-context-end");
  await import("./authority-award.mjs");
}
await ensureLensModule("meetings");
await import("./entities.mjs");
await import("./entity_identity_report.mjs");
await import("./workspace.mjs");
await import("./now.mjs");
await import("./routing.mjs");
await import("./boot.mjs");

// The original parser-blocking inline script created its dynamic controls before deferred
// privacy instrumentation ran. Module loading is deferred, so re-apply the same form mask after
// boot to preserve that ordering guarantee.
globalThis.CROLClarity?.applyInputMasking(document);
// Browser checks and route consumers need a completion barrier, not merely the
// presence of functions imported near the start of the graph. Without this
// marker, a click can race the first applyHash() and be overwritten by boot.
document.body?.setAttribute("data-app-ready", "true");
appImportTimingMark("end");
}

// The disclosed default-watch form is in the shell on every route, so its enhancement
// attaches before the branch: a hash landing must not fall back to the raw form POST.
const { initHomeDefaultSubscription } = await import("../home_default_watch.mjs");
initHomeDefaultSubscription();

if (isNeutralHome) {
  await import("../home_entry.mjs");
  globalThis.CROLLoadApplication = loadApplication;
} else {
  await loadApplication();
}
