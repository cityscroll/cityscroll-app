/**
 * Canonical identity contracts for the three independently owned Browse
 * surfaces. Source provenance and visual navigation are deliberately separate
 * from the route/builder/controller identity.
 */

function surfaceContract(descriptor) {
  return Object.freeze({ ...descriptor });
}

export const PEOPLE_ORGANIZATIONS_SURFACE = surfaceContract({
  surfaceId: "people-organizations",
  canonicalRoute: "/browse/people/",
  sourceDomain: "people",
  navigationFamily: "people",
  builder: "people-organizations-document",
  controller: "people-organizations-browser",
  label: "People + organizations",
  title: "People + organizations",
  description: "Community Boards, City Council, agencies, and vendors—each row names its institution.",
});

export const STAFFING_SURFACE = surfaceContract({
  surfaceId: "staffing",
  canonicalRoute: "/browse/staffing/",
  sourceDomain: "staffing",
  navigationFamily: "people",
  builder: "staffing-document",
  controller: "staffing-browser",
  label: "Staffing",
  title: "Staffing",
  description: "Recent appointments, payroll, eligible lists, and hiring outcomes.",
});

export const EXAMS_SURFACE = surfaceContract({
  surfaceId: "exams",
  canonicalRoute: "/browse/exams/",
  sourceDomain: "staffing",
  navigationFamily: "exams",
  builder: "exams-document",
  controller: "exams-browser",
  label: "Exams",
  title: "Exams",
  description: "Civil-service exam schedules, applications, eligible lists, and published outcomes.",
});

export const BROWSE_SURFACE_CONTRACTS = Object.freeze({
  [PEOPLE_ORGANIZATIONS_SURFACE.surfaceId]: PEOPLE_ORGANIZATIONS_SURFACE,
  [STAFFING_SURFACE.surfaceId]: STAFFING_SURFACE,
  [EXAMS_SURFACE.surfaceId]: EXAMS_SURFACE,
});

export const BROWSE_SURFACES = Object.freeze(Object.values(BROWSE_SURFACE_CONTRACTS));

const SURFACE_BY_ROUTE = new Map(BROWSE_SURFACES.map((surface) => [
  surface.canonicalRoute.replace(/\/+$/, "") || "/",
  surface,
]));

export function browseSurfaceContract(surfaceId) {
  return BROWSE_SURFACE_CONTRACTS[String(surfaceId || "")] || null;
}

export function browseSurfaceContractForRoute(pathname) {
  const route = String(pathname || "").replace(/\/+$/, "") || "/";
  return SURFACE_BY_ROUTE.get(route) || null;
}
