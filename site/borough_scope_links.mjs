/**
 * Borough scope navigation shared by the list lenses.
 *
 * A borough is a place scope, so it is represented as a link that can be
 * copied, opened in a new tab, or carried into the map. The lens modules own
 * data loading; this module only composes URLs and markup.
 */

import { nearYouUrlFromScope } from "./near_you_scope.mjs";
import { scopeFromRouteHash } from "./scope_v0.mjs";
import { constellationLink, filterChip } from "./affordance_grammar.mjs";

export const BOROUGH_SCOPE_LINKS_SCHEMA = "cityscroll.borough_scope_links.v1";
export const BOROUGHS = Object.freeze([
  "Manhattan",
  "Brooklyn",
  "Queens",
  "Bronx",
  "Staten Island",
]);

const SURFACE_ALIASES = Object.freeze({ zoning: "land" });
const SURFACES = new Set(["land", "property", "rules"]);
const GEOGRAPHIC_MAP_SURFACES = new Set(["land", "property"]);

function clean(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function surfaceName(value) {
  const surface = SURFACE_ALIASES[clean(value)] || clean(value);
  return SURFACES.has(surface) ? surface : "property";
}

function escapeHtml(value) {
  return clean(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function currentRouteHash(surface, currentHash) {
  const raw = clean(currentHash);
  if (raw.startsWith("#")) {
    const route = raw.slice(1).split("?", 1)[0];
    if (route === surface) return raw;
  }
  return `#${surface}`;
}

/**
 * Replace only the borough axis in an existing lens hash.
 * Other search, facet, district, and archive parameters remain shareable.
 */
export function boroughScopeHref(surface, borough, currentHash = "") {
  const lens = surfaceName(surface);
  const raw = currentRouteHash(lens, currentHash);
  const [route, query = ""] = raw.slice(1).split("?");
  const params = new URLSearchParams(query);
  params.delete("boro");
  if (lens === "rules") params.delete("scope");
  const next = clean(borough);
  if (next === "citywide" && lens === "rules") params.set("scope", "citywide");
  else if (BOROUGHS.includes(next)) params.set("boro", next);
  const encoded = params.toString();
  return `#${route}${encoded ? `?${encoded}` : ""}`;
}

/** Carry the current lens scope into the place-first map document. */
export function boroughMapPivotHref(surface, borough, currentHash = "") {
  const href = boroughScopeHref(surface, borough, currentHash);
  const scope = scopeFromRouteHash(href);
  return nearYouUrlFromScope(scope, { base: "/near-you/" });
}

function labelFor(id, t) {
  if (id === "") return typeof t === "function" ? t("all_boroughs") : "All boroughs";
  if (id === "citywide") return typeof t === "function" ? t("map_bucket_citywide") : "Citywide";
  return id;
}

/**
 * Render a compact, keyboard-friendly borough link rail. Map pivots are only
 * offered for geographic lenses; this is separate from merely having a place facet.
 * @param {object} opts
 * @param {string} opts.surface — land/zoning, property, or rules
 * @param {string} [opts.selected]
 * @param {string} [opts.currentHash]
 * @param {boolean} [opts.includeCitywide]
 * @param {(key: string) => string} [opts.t]
 * @param {(value: string) => string} [opts.escape]
 */
export function boroughScopeLinksHTML(opts = {}) {
  const surface = surfaceName(opts.surface);
  const selected = clean(opts.selected);
  const currentHash = opts.currentHash || globalThis.location?.hash || `#${surface}`;
  const escape = typeof opts.escape === "function" ? opts.escape : escapeHtml;
  const t = typeof opts.t === "function" ? opts.t : (key) => key;
  const ids = ["", ...BOROUGHS, ...(opts.includeCitywide ? ["citywide"] : [])];
  const links = ids.map((id) => {
    const active = selected === id;
    const href = boroughScopeHref(surface, id, currentHash);
    const edge = `${surface}.borough.${id || "all"}`;
    return filterChip({
      label: labelFor(id, t),
      pressed: active,
      className: `borough-scope-link${active ? " on" : ""}`,
      attributes: {
        "data-borough-scope-link": id || "all",
        "data-scope-edge": edge,
        "data-filter-href": href,
      },
      escape,
    });
  }).join("");
  const mapHref = boroughMapPivotHref(surface, selected, currentHash);
  const mapEdge = `${surface}.map.borough.${selected || "all"}`;
  const map = GEOGRAPHIC_MAP_SURFACES.has(surface)
    ? constellationLink({
      href: mapHref,
      label: t("near_you_map_scope"),
      className: "borough-map-pivot",
      attributes: {
        "data-borough-map-pivot": surface,
        "data-scope-edge": mapEdge,
        "data-near-you-link": "",
        "data-lens": surface,
      },
      escape,
    })
    : "";
  return `<div class="borough-scope-links" data-borough-scope="${escape(surface)}" role="group" aria-label="${escape(t("borough_label"))}">${links}</div>${map}`;
}

export function normalizeBoroughScope(value) {
  const next = clean(value);
  return BOROUGHS.includes(next) || next === "citywide" ? next : "";
}
