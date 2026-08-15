/**
 * Browse route aliases keep a public family URL on the runtime that already
 * owns its interaction contract. The alias is deliberately data-only: the
 * target view remains responsible for search, filters, rendering, and state.
 */
export const BROWSE_ROUTE_ALIASES = Object.freeze({
  exams: Object.freeze({
    route: "/browse/exams/",
    targetRoute: "/browse/staffing/",
    targetFacet: "staffing",
    targetTab: "people",
    navigationTab: "exams",
    defaultView: "guide",
    corpus: "exams",
    label: "Exams",
    title: "Exams",
    description: "Civil-service exam schedules, applications, eligible lists, and published outcomes.",
  }),
});

export function browseRouteAlias(pathname) {
  const normalized = String(pathname || "").replace(/\/+$/, "") || "/";
  return Object.values(BROWSE_ROUTE_ALIASES).find((alias) =>
    alias.route.replace(/\/+$/, "") === normalized) || null;
}

export function aliasSearchParams(alias, searchParams = new URLSearchParams()) {
  const params = new URLSearchParams(searchParams);
  params.set("view", alias.defaultView);
  return params;
}

export function aliasHash(alias, searchParams = new URLSearchParams()) {
  const params = aliasSearchParams(alias, searchParams);
  params.delete("lang");
  params.delete("legacy");
  return `${alias.targetTab}?${params}`;
}
