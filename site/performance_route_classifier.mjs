/**
 * Public-safe RUM classification over the generated manifest.
 *
 * The caller supplies location.pathname only. Query, hash, record values, and
 * user input never enter the returned classification. Unknown routes are an
 * explicit observability gap; there is deliberately no home/browse fallback.
 */

function normalizedPathname(value) {
  const raw = String(value || "");
  if (!raw.startsWith("/") || raw.includes("?") || raw.includes("#") || raw.includes("//")) return null;
  return raw === "/" ? raw : raw.replace(/\/+$/, "");
}

function templateMatches(template, pathname) {
  const expected = template.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => (
    /^\{[a-z][a-z0-9-]*\}$/.test(segment)
      ? actual[index].length > 0
      : segment === actual[index]
  ));
}

function routeMatches(matcher, pathname) {
  if (matcher.kind === "exact") return matcher.pathname === pathname;
  if (matcher.kind === "segment_template") return templateMatches(matcher.pathname, pathname);
  return false;
}

function unclassified(manifest) {
  return {
    ...(manifest?.unclassified || {}),
    classification_state: "unclassified",
    surface_id: null,
    route_family: null,
    delivery_class: null,
  };
}

export function classifyPerformancePathname(manifest, pathname) {
  const normalized = normalizedPathname(pathname);
  if (!normalized) return unclassified(manifest);
  const surface = (manifest?.surfaces || []).find((candidate) => (
    candidate.public_safe_matcher.some((matcher) => routeMatches(matcher, normalized))
  ));
  if (!surface) return unclassified(manifest);
  return {
    classification_state: surface.lifecycle_state === "retired" ? "retired" : "registered_no_data",
    surface_id: surface.surface_id,
    route_family: surface.route_family,
    delivery_class: surface.delivery_class,
  };
}

export function classifyPerformanceComponent(manifest, marker) {
  const safeMarker = String(marker || "");
  const component = (manifest?.components || []).find((candidate) => (
    candidate.public_safe_matcher?.kind === "semantic_marker"
      && candidate.public_safe_matcher.marker === safeMarker
  ));
  if (!component) {
    return {
      classification_state: "unclassified",
      component_id: null,
      kind: null,
    };
  }
  return {
    classification_state: component.lifecycle_state === "retired" ? "retired" : "registered_no_data",
    component_id: component.component_id,
    kind: component.kind,
  };
}
