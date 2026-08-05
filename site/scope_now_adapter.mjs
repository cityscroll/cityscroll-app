import { normalizeScope } from "./scope_v0.mjs";

// Geographic scope socket for the lazily loaded Now surface.
export function nowItemMatchesScope(item, value) {
  const scope = normalizeScope(value);
  if (scope.facets.domains.length && !scope.facets.domains.includes(item?.domain)) return false;
  if (scope.facets.agencies.length && !scope.facets.agencies.includes(item?.agency)) return false;
  if (scope.facets.actions.length && !scope.facets.actions.includes(item?.kind)) return false;
  const place = item?.place || {};
  if (scope.place.boroughs.length && !scope.place.boroughs.some((borough) => (place.boroughs || []).includes(borough))) return false;
  if (scope.place.community_districts.length && !scope.place.community_districts.some((district) => (place.community_districts || []).includes(district))) return false;
  if (scope.place.council_districts.length && !scope.place.council_districts.some((district) => (place.council_districts || []).map(String).includes(String(district)))) return false;
  if (scope.place.location_scope && place.scope !== scope.place.location_scope) return false;
  const terms = scope.topic.keywords.length ? scope.topic.keywords : scope.topic.query ? [scope.topic.query] : [];
  if (terms.length) {
    const haystack = `${item?.title || ""} ${item?.agency || ""}`.toLowerCase();
    if (!terms.every((term) => haystack.includes(String(term).toLowerCase()))) return false;
  }
  return true;
}
