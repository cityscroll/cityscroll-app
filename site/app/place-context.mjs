import {
  appendPlaceContextToHref,
  appendPlaceContextToHash,
  clearPlaceContext,
  mergePlaceContextIntoLensFilter,
  placeContextFromScope,
  placeContextLabel,
  scopeWithPlaceContext,
} from "../place_context.mjs";
import { DEEPLINK_BOROUGHS } from "../place_context.mjs";
import {
  normalizeScope,
  routeHashFromScope,
  scopeFromRouteHash,
} from "../scope_v0.mjs";

const LENS_PATHS = new Map([
  ["contracts", "money"],
  ["staffing", "people"],
  ["zoning", "land"],
  ["property", "property"],
  ["rules", "rules"],
  ["meetings", "meetings"],
]);
const PLACE_QUERY_KEYS = new Set(["boro", "cd", "council", "neighborhood", "scope"]);

function currentSurface() {
  const hash = String(location.hash || "").replace(/^#/, "");
  const hashSurface = hash.split("?", 1)[0];
  if (["money", "people", "land", "property", "rules", "meetings", "now"].includes(hashSurface)) {
    return hashSurface;
  }
  const match = String(location.pathname || "").match(/^\/browse\/([^/]+)\/?$/);
  return match ? LENS_PATHS.get(match[1]) || null : location.pathname === "/now/" ? "now" : null;
}

function scopeFromLocation() {
  const surface = currentSurface();
  if (location.hash && surface) return scopeFromRouteHash(location.hash, { language: window.LANG || "en" });
  const query = new URLSearchParams(location.search);
  if (!surface && ![...query.keys()].some((key) => PLACE_QUERY_KEYS.has(key))) return null;
  const route = surface || "meetings";
  return scopeFromRouteHash(`#${route}${query.size ? `?${query}` : ""}`, { language: window.LANG || "en" });
}

function contextFromLocation() {
  const scope = scopeFromLocation();
  return scope ? placeContextFromScope(scope, { source: null }) : null;
}

function safeContextFromLocation() {
  try { return contextFromLocation(); } catch { return null; }
}

function safeMergePlaceContext(filter, context) {
  try { return mergePlaceContextIntoLensFilter(filter, context); } catch { return { ...filter }; }
}

function lensSearchState(filter, lens, builder) {
  const context = safeContextFromLocation();
  const next = safeMergePlaceContext(filter, context);
  const built = typeof builder === "function" ? builder(lens, next) : null;
  return { filter: next, hash: appendPlaceContextToHash(built, context) };
}

function currentRouteQuery(scope) {
  const hash = routeHashFromScope(scope, { surface: currentSurface() || "meetings" });
  const queryAt = hash.indexOf("?");
  return queryAt < 0 ? "" : hash.slice(queryAt + 1);
}

function routeForScope(scope) {
  const hash = routeHashFromScope(scope, { surface: currentSurface() || "meetings" });
  const path = String(location.pathname || "/");
  const browse = path.match(/^\/browse\/([^/]+)\/?$/);
  if (browse) {
    const url = new URL(path, location.origin);
    url.search = currentRouteQuery(scope);
    url.hash = "";
    return `${url.pathname}${url.search}`;
  }
  const url = new URL(location.href);
  url.search = "";
  url.hash = hash;
  return `${url.pathname}${url.hash}`;
}

function renderBanner(context) {
  const banner = ensureBanner();
  const label = placeContextLabel(context);
  banner.dataset.open = label ? "true" : "false";
  if (!label) return;
  const text = banner.querySelector("[data-place-context-label]");
  if (text) text.textContent = `${globalThis.t("context_strip_lbl")}: ${label}`;
  const select = banner.querySelector("[data-place-context-borough]");
  if (select) {
    select.value = context.borough || "";
    select.hidden = true;
  }
}

function ensureBanner() {
  let banner = document.querySelector("#place-context");
  if (banner) return banner;
  banner = document.createElement("div");
  banner.id = "place-context";
  banner.className = "session-banner";
  banner.setAttribute("role", "status");
  banner.innerHTML = `<span data-place-context-label></span><button class="mini" data-place-context-change data-i18n="borough_label"></button><select data-place-context-borough data-i18n-aria="borough_label" hidden><option value="" data-i18n="all_boroughs"></option></select><button class="mini" data-place-context-clear data-i18n="all_boroughs"></button>`;
  const select = banner.querySelector("[data-place-context-borough]");
  DEEPLINK_BOROUGHS.forEach((borough) => {
    const option = document.createElement("option");
    option.value = borough;
    option.textContent = borough;
    select.append(option);
  });
  globalThis.applyStrings?.();
  document.querySelector("#langNotice")?.after(banner);
  return banner;
}

function decorateLinks(context) {
  if (!context) return;
  document.querySelectorAll(".now-entry-row a, .browse-child-tabs a")
    .forEach((link) => {
      link.href = appendPlaceContextToHref(link.href, context);
    });
}

function navigateWithPlace(context) {
  const scope = scopeFromLocation() || normalizeScope({ facets: { domains: [currentSurface() || "meetings"] } });
  const next = scopeWithPlaceContext(scope, context);
  location.assign(routeForScope(next));
}

function clearPlace() {
  const scope = scopeFromLocation();
  if (!scope) return;
  location.assign(routeForScope(clearPlaceContext(scope)));
}

function wireBanner() {
  const banner = ensureBanner();
  if (banner.dataset.wired === "true") return;
  banner.dataset.wired = "true";
  const change = banner.querySelector("[data-place-context-change]");
  const select = banner.querySelector("[data-place-context-borough]");
  change?.addEventListener("click", () => {
    if (select) {
      select.hidden = !select.hidden;
      if (!select.hidden) select.focus();
    }
  });
  select?.addEventListener("change", () => {
    const borough = select.value || null;
    navigateWithPlace(borough ? { borough, source: "user" } : null);
  });
  banner.querySelector("[data-place-context-clear]")?.addEventListener("click", clearPlace);
}

function sync() {
  const context = contextFromLocation();
  renderBanner(context);
  decorateLinks(context);
  wireBanner();
}

globalThis.CrolPlaceContext = Object.freeze({
  appendPlaceContextToHref,
  appendPlaceContextToHash,
  clearPlaceContext,
  contextFromLocation: safeContextFromLocation,
  lensSearchState,
  mergePlaceContextIntoLensFilter: safeMergePlaceContext,
  placeContextFromScope,
  placeContextLabel,
  scopeWithPlaceContext,
  sync,
});

if (document.body) {
  sync();
  addEventListener("hashchange", sync);
  addEventListener("popstate", sync);
}

export { contextFromLocation, sync };
