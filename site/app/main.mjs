await import("./core.mjs");
globalThis.CrolScope = await import("../scope_v0.mjs");
globalThis.CrolEntityPivots = await import("../entity_pivot.mjs");
globalThis.CrolAgencyConnections = await import("../agency_connections.mjs");
globalThis.CrolRouteMigration = await import("../route_migration.mjs");
await import("./money-list.mjs");
let moneyHistoryPromise;
globalThis.ensureMoneyHistory = () => moneyHistoryPromise ||= import("./money-history.mjs");
await import("./search-share.mjs");
await import("./people.mjs");
await import("./land.mjs");
await import("./feed-actions.mjs");
await import("./result-match.mjs");
// Entity profiles use this shared section vocabulary without needing the notice-only context island.
globalThis.SECTION_LENS={"Procurement":"money","Public Hearings and Meetings":"meetings","Agency Rules":"rules","Property Disposition":"property","Changes in Personnel":"people"};
let noticeContextPromise;
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
await ensureRouteModulesForHash(location.hash);
await import("./procurement-lifecycle.mjs");
await import("./procurement-phase.mjs");
await import("./subsidy.mjs");
if(location.hash.startsWith("#notice/") || location.pathname.startsWith("/notices/")){
  await globalThis.ensureNoticeContext();
  await import("./authority-award.mjs");
}
await import("./meetings.mjs");
await import("./entities.mjs");
await import("./workspace.mjs");
await import("./now.mjs");
await import("./routing.mjs");
await import("./boot.mjs");

// The original parser-blocking inline script created its dynamic controls before deferred
// privacy instrumentation ran. Module loading is deferred, so re-apply the same form mask after
// boot to preserve that ordering guarantee.
globalThis.CROLClarity?.applyInputMasking(document);
