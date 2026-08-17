/**
 * Canonical identity contracts for the three Browse surfaces that currently
 * share People/Staffing/Exams plumbing.
 *
 * `builder` and `controller` are logical owner ids, not module specifiers.
 * Slice 1 makes those owners and routes unique while the temporary
 * compatibility projection preserves the existing builders, panes, hashes,
 * and output byte-for-byte. Later slices replace that projection with the
 * dedicated implementations named by the contracts.
 */

function surfaceContract(descriptor) {
  return Object.freeze({
    ...descriptor,
    compatibility: Object.freeze({ ...descriptor.compatibility }),
  });
}

export const PEOPLE_ORGANIZATIONS_SURFACE = surfaceContract({
  surfaceId: "people-organizations",
  route: "/browse/people/",
  builder: "people-organizations-document",
  controller: "people-organizations-browser",
  label: "People + organizations",
  title: "People + organizations",
  description: "Officials, vendors, committees, and community boards with published records.",
  compatibility: {
    routeKey: "people",
    concept: "people",
    runtimeTab: "people",
    currentBuilder: "browse-concept:people",
    currentController: "people-organizations",
  },
});

export const STAFFING_SURFACE = surfaceContract({
  surfaceId: "staffing",
  route: "/browse/staffing/",
  builder: "staffing-document",
  controller: "staffing-browser",
  label: "Staffing",
  title: "Staffing",
  description: "Recent appointments, payroll, civil-service exams, eligible lists, and hiring outcomes.",
  compatibility: {
    routeKey: "staffing",
    facet: "staffing",
    concept: "people",
    runtimeHash: "people",
    runtimeTab: "people",
    currentBuilder: "browse-concept:people",
    currentController: "people-organizations",
  },
});

export const EXAMS_SURFACE = surfaceContract({
  surfaceId: "exams",
  route: "/browse/exams/",
  builder: "exams-document",
  controller: "exams-browser",
  label: "Exams",
  title: "Exams",
  description: "Civil-service exam schedules, applications, eligible lists, and published outcomes.",
  compatibility: {
    routeKey: "exams",
    runtimeTab: "people",
    navigationTab: "exams",
    defaultView: "guide",
    corpus: "exams",
    currentBuilder: "browse-alias:exams",
    currentController: "people",
  },
});

export const BROWSE_SURFACE_CONTRACTS = Object.freeze({
  [PEOPLE_ORGANIZATIONS_SURFACE.surfaceId]: PEOPLE_ORGANIZATIONS_SURFACE,
  [STAFFING_SURFACE.surfaceId]: STAFFING_SURFACE,
  [EXAMS_SURFACE.surfaceId]: EXAMS_SURFACE,
});

export const BROWSE_SURFACES = Object.freeze(Object.values(BROWSE_SURFACE_CONTRACTS));

const SURFACE_BY_ROUTE = new Map(BROWSE_SURFACES.map((surface) => [
  surface.route.replace(/\/+$/, "") || "/",
  surface,
]));

export function browseSurfaceContract(surfaceId) {
  return BROWSE_SURFACE_CONTRACTS[String(surfaceId || "")] || null;
}

export function browseSurfaceContractForRoute(pathname) {
  const route = String(pathname || "").replace(/\/+$/, "") || "/";
  return SURFACE_BY_ROUTE.get(route) || null;
}

// Temporary anti-corruption layer: old route/runtime identities are derived
// from the contracts here rather than being re-declared by each consumer.
export const BROWSE_ROUTE_ALIASES_COMPAT = Object.freeze({
  exams: Object.freeze({
    route: EXAMS_SURFACE.route,
    targetRoute: STAFFING_SURFACE.route,
    targetFacet: STAFFING_SURFACE.compatibility.facet,
    targetTab: EXAMS_SURFACE.compatibility.runtimeTab,
    navigationTab: EXAMS_SURFACE.compatibility.navigationTab,
    defaultView: EXAMS_SURFACE.compatibility.defaultView,
    corpus: EXAMS_SURFACE.compatibility.corpus,
    label: EXAMS_SURFACE.label,
    title: EXAMS_SURFACE.title,
    description: EXAMS_SURFACE.description,
  }),
});

export const BROWSE_DOCUMENT_FACET_HASHES_COMPAT = Object.freeze({
  [STAFFING_SURFACE.compatibility.routeKey]: STAFFING_SURFACE.compatibility.runtimeHash,
});

export const BROWSE_DOCUMENT_CONCEPT_ROUTE_ENTRIES_COMPAT = Object.freeze([
  Object.freeze([
    PEOPLE_ORGANIZATIONS_SURFACE.compatibility.routeKey,
    PEOPLE_ORGANIZATIONS_SURFACE.compatibility.concept,
  ]),
  Object.freeze([
    STAFFING_SURFACE.compatibility.routeKey,
    STAFFING_SURFACE.compatibility.concept,
  ]),
]);

export const BROWSE_CONCEPT_DOCUMENT_PATHS_COMPAT = Object.freeze([
  PEOPLE_ORGANIZATIONS_SURFACE.route.replace(/\/+$/, ""),
  STAFFING_SURFACE.route.replace(/\/+$/, ""),
]);

export const BROWSE_LEGACY_LENS_FACETS_COMPAT = Object.freeze({
  people: STAFFING_SURFACE.compatibility.facet,
  staffing: STAFFING_SURFACE.compatibility.facet,
});
