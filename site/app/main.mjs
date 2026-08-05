await import("./core.mjs");
globalThis.CrolScope = await import("../scope_v0.mjs");
await import("./money-list.mjs");
await import("./money-history.mjs");
await import("./search-share.mjs");
await import("./people.mjs");
await import("./land.mjs");
await import("./feed-actions.mjs");
await import("./result-match.mjs");
await import("./notice-context.mjs");

// Property is the largest route-only lens on the default Money landing. Keep its registration
// in the ordered graph, but fetch it only for Property and notice routes. Routing itself remains
// eager: the loader is a narrow activation gate, not a second route-state owner.
const routeModuleLoaders = Object.freeze({
  property: () => import("./property.mjs"),
});
const routeModulePromises = new Map();
const loadedRouteModules = new Set();

function routeModuleForHash(hash){
  const raw=String(hash||"").replace(/^#/,"").toLowerCase();
  return raw.replace(/\?.*$/,"")==="property" || raw.startsWith("notice/")
    ? "property"
    : null;
}
function ensureRouteModule(name){
  const loader=routeModuleLoaders[name];
  if(!loader) return Promise.resolve();
  if(!routeModulePromises.has(name)){
    routeModulePromises.set(name,loader().then(module=>{
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
await ensureRouteModulesForHash(location.hash);
await import("./rules.mjs");
await import("./procurement-lifecycle.mjs");
await import("./procurement-phase.mjs");
await import("./subsidy.mjs");
if(location.hash.startsWith("#notice/")) await import("./authority-award.mjs");
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
