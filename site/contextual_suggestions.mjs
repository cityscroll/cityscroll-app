import {
  normalizeScope,
  subscriptionFromScope,
} from "./scope_v0.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";

export const CONTEXTUAL_SUGGESTION_LIMIT = 3;

const clean = (value, max = 240) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function escapeHTML(value) {
  return clean(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function uniqueRefs(refs) {
  return [...new Set((refs || []).map((ref) => clean(ref, 320)).filter(Boolean))];
}

function parseFacet(search) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search || "");
  const raw = params.get("facet");
  if (!raw || raw.length > 2_000) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

function browseScopeHref(route, search, refs) {
  const params = new URLSearchParams(search instanceof URLSearchParams ? search : new URLSearchParams(search || ""));
  const facet = parseFacet(params);
  facet.entity_refs_all = uniqueRefs(refs);
  params.delete("agency");
  params.set("facet", JSON.stringify(facet));
  return `${route}${params.toString() ? `?${params}` : ""}`;
}

function labelForRef(item) {
  const label = clean(item?.label);
  if (label) return label;
  const kind = clean(item?.kind, 40).toLowerCase();
  return ({
    agency: "this agency",
    vendor: "this vendor",
    official: "this official",
    project: "this project",
    parcel: "this parcel",
  })[kind] || "this connection";
}

function hasMeaningfulScope(scopeInput) {
  const scope = normalizeScope(scopeInput);
  const values = scope.facets.values || {};
  return Boolean(
    scope.place.boroughs.length
    || scope.place.community_districts.length
    || scope.place.council_districts.length
    || scope.place.neighborhood
    || scope.place.location_scope
    || scope.place.viewport
    || scope.time_window.preset
    || scope.time_window.start
    || scope.time_window.end
    || scope.time_window.rolling_months
    || scope.topic.query
    || scope.topic.keywords.length
    || scope.facets.agencies.length
    || scope.facets.actions.length
    || Object.keys(values).length
  );
}

function byCountThenRef(left, right) {
  return right.count - left.count || String(left.ref).localeCompare(String(right.ref));
}

function approved(suggestion, destinationCheck) {
  return typeof destinationCheck !== "function" || destinationCheck(suggestion) !== false;
}

/** Production guard for pivots whose URL is currently only a route claim. */
export function productionDestinationCheck(suggestion) {
  if (suggestion?.kind !== "pivot") return true;
  const href = String(suggestion.href || "");
  return !/^\/(?:agencies|vendors|officials)\/[^/?#]+\/?(?:\?.*)?$/.test(href);
}

/**
 * Build the small set of valid next moves for a rendered scope.
 *
 * `edgeInventory` is deliberately an input: callers provide the already
 * materialized edges and their destination counts. This keeps the component
 * on the read-model path and prevents suggestions from becoming hidden API
 * queries. A destination with count 0 is never advertised.
 */
export function buildContextualSuggestions({
  scope: scopeInput,
  surface,
  route,
  search = "",
  resultCount = 0,
  edgeInventory = [],
  edgePairs = [],
  max = CONTEXTUAL_SUGGESTION_LIMIT,
  destinationCheck,
} = {}) {
  const scope = normalizeScope(scopeInput);
  const currentRefs = uniqueRefs(scope.facets.values?.entity_refs_all);
  const safeSurface = clean(surface, 40) || scope.facets.domains[0] || "money";
  const safeRoute = clean(route, 160) || "/browse/";
  const checkDestination = typeof destinationCheck === "function" ? destinationCheck : productionDestinationCheck;
  const suggestions = [];
  const positiveCount = Number.isInteger(Number(resultCount)) && Number(resultCount) > 0
    ? Number(resultCount) : 0;
  const inventory = (Array.isArray(edgeInventory) ? edgeInventory : [])
    .map((edge) => ({
      ...edge,
      ref: clean(edge?.ref, 320),
      label: labelForRef(edge),
      count: Number(edge?.count) || 0,
    }))
    .filter((edge) => edge.ref && edge.count > 0 && !currentRefs.includes(edge.ref))
    .sort(byCountThenRef);

  if (hasMeaningfulScope(scope) && positiveCount) {
    const watch = subscriptionFromScope(scope, {}, { lens: safeSurface });
    const follow = {
      kind: "follow",
      label: "Follow this scope",
      href: followingUrlFromWatch(watch, { base: "/following/", matchCount: positiveCount }),
      count: positiveCount,
      refs: currentRefs,
    };
    if (approved(follow, checkDestination)) suggestions.push(follow);
  }

  const intersect = inventory[0];
  if (intersect) {
    const suggestion = {
      kind: "intersect",
      label: `See ${intersect.label} here`,
      href: browseScopeHref(safeRoute, search, [...currentRefs, intersect.ref]),
      count: intersect.count,
      refs: [...currentRefs, intersect.ref],
    };
    if (approved(suggestion, checkDestination)) suggestions.push(suggestion);
  }

  const pivot = inventory.find((edge) => clean(edge.pivotHref, 500));
  if (pivot) {
    const suggestion = {
      kind: "pivot",
      label: `Open ${pivot.label}`,
      href: clean(pivot.pivotHref, 500),
      count: pivot.count,
      refs: [...currentRefs, pivot.ref],
      pivot: true,
    };
    if (approved(suggestion, checkDestination)) suggestions.push(suggestion);
  }

  const pair = (Array.isArray(edgePairs) ? edgePairs : [])
    .map((item) => ({
      ...item,
      refs: uniqueRefs(item?.refs),
      count: Number(item?.count) || 0,
      labels: Array.isArray(item?.labels) ? item.labels.map((label) => clean(label)) : [],
    }))
    .filter((item) => item.refs.length >= 2 && item.count > 0 && item.refs.every((ref) => !currentRefs.includes(ref)))
    .sort((left, right) => right.count - left.count || left.refs.join("|").localeCompare(right.refs.join("|")))[0];
  if (pair) {
    const labels = pair.labels.length >= 2 ? pair.labels : ["this connection", "another connection"];
    const suggestion = {
      kind: "three-way",
      label: `Open with ${labels[0]} and ${labels[1]}`,
      href: browseScopeHref(safeRoute, search, [...currentRefs, ...pair.refs]),
      count: pair.count,
      refs: [...currentRefs, ...pair.refs],
    };
    if (approved(suggestion, checkDestination)) suggestions.push(suggestion);
  }

  return suggestions.slice(0, Math.max(0, Math.min(CONTEXTUAL_SUGGESTION_LIMIT, Number(max) || CONTEXTUAL_SUGGESTION_LIMIT)));
}

export function renderContextualSuggestions(suggestions = []) {
  const safe = Array.isArray(suggestions) ? suggestions.slice(0, CONTEXTUAL_SUGGESTION_LIMIT) : [];
  if (!safe.length) return "";
  const links = safe.map((suggestion) => `<li data-suggestion-kind="${escapeHTML(suggestion.kind)}" data-suggestion-count="${escapeHTML(suggestion.count)}"><a href="${escapeHTML(suggestion.href)}">${escapeHTML(suggestion.label)}</a></li>`).join("");
  return `<aside class="contextual-suggestions" data-contextual-suggestions aria-labelledby="contextual-suggestions-title"><p class="contextual-suggestions-kicker" id="contextual-suggestions-title">Next moves</p><ul>${links}</ul></aside>`;
}
