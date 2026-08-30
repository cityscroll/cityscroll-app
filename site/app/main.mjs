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

async function loadApplication() {
appImportTimingMark("start");
await import("./core.mjs");
appImportTimingMark("core-end");
let noticeContextPromise = NOTICE_ROUTE ? import(NOTICE_CONTEXT_MODULE_PATH) : null;
if(noticeContextPromise) appImportTimingMark("notice-context-start");
// Independent namespace modules have no load-order side effects with each other.
const [scopeModule, entityPivotsModule, reportIssueModule, agencyConnectionsModule, routeMigrationModule] = await Promise.all([
  import("../scope_v0.mjs"),
  import("../entity_pivot.mjs"),
  import("../report_issue.mjs"),
  import("../agency_connections.mjs"),
  import("../route_migration.mjs"),
]);
globalThis.CrolScope = scopeModule;
globalThis.CrolEntityPivots = entityPivotsModule;
globalThis.CrolReportIssue = reportIssueModule;
globalThis.CrolAgencyConnections = agencyConnectionsModule;
globalThis.CrolRouteMigration = routeMigrationModule;
await import("./traversal.mjs");
await import("./contracts-rum.mjs");
await import("./money-list.mjs");
let moneyHistoryPromise;
globalThis.ensureMoneyHistory = () => moneyHistoryPromise ||= import("./money-history.mjs");
await import("./search-share.mjs");
await import("./exams.mjs");
await import("./staffing.mjs");
await import("./land.mjs");
await import("./feed-actions.mjs");
await import("./result-match.mjs");
// Entity profiles use this shared section vocabulary without needing the notice-only context island.
globalThis.SECTION_LENS={"Procurement":"money","Public Hearings and Meetings":"meetings","Agency Rules":"rules","Property Disposition":"property","Changes in Personnel":"people"};
globalThis.ensureNoticeContext = () => noticeContextPromise ||= import("./notice-context.mjs");
// Property is the largest route-only lens on the default Money landing. Keep its registration
// in the ordered graph, but fetch it only for Property and notice routes. Routing itself remains
// eager: the loader is a narrow activation gate, not a second route-state owner.
const routeModuleLoaders = Object.freeze({
  property: () => import("./property.mjs"),
  rules: () => import("./rules.mjs"),
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
  const path=String(location.pathname||"").toLowerCase();
  if(raw.replace(/\?.*$/,"")==="rules" || path==="/browse/rules/") return "rules";
  return raw.replace(/\?.*$/,"")==="property" || raw.startsWith("notice/") ||
    path.startsWith("/notices/") || path==="/browse/property/"
    ? "property"
    : null;
}
function ensureRouteModule(name){
  const loader=routeModuleLoaders[name];
  if(!loader) return Promise.resolve();
  if(name === "property") ensureRouteStylesheet("property.css");
  if(!routeModulePromises.has(name)){
    routeModulePromises.set(name,(name === "property" ? ensureRouteModule("rules") : Promise.resolve()).then(()=>loader()).then(module=>{
      loadedRouteModules.add(name);
      return module;
    }));
  }
  return routeModulePromises.get(name);
}
function ensureRouteModulesForHash(hash){
  const name=routeModuleForHash(hash);
  return name ? ensureRouteModule(name) : Promise.resolve();
}
globalThis.CrolRouteModules=Object.freeze({
  ensure:ensureRouteModule,
  ensureForHash:ensureRouteModulesForHash,
  isReady:name=>!routeModuleLoaders[name] || loadedRouteModules.has(name),
});
globalThis.ensureRules = () => ensureRouteModule("rules");
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
await import("./meetings.mjs");
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

if (isNeutralHome) {
  await import("../home_entry.mjs");
  globalThis.CROLLoadApplication = loadApplication;
} else {
  await loadApplication();
}
