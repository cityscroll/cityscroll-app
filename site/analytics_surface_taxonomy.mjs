/**
 * The analytics surface vocabulary: one definition, read by the browser producer
 * and by the Worker that validates what the browser sends.
 *
 * Before this module the two halves disagreed. The browser resolved a surface by
 * taking the last path segment and, when it recognised nothing, answering "home".
 * The platform serves every `.html` document at its extensionless path, so the
 * Stats, About, API, Data, Changelog and Standards documents all reported
 * themselves as the homepage, and every record and entity route did the same. The
 * Worker then accepted "home" because "home" is a real surface. Nothing was
 * rejected and nothing looked wrong; the measurement was simply about a different
 * page than the reader was on.
 *
 * Three rules keep that from coming back.
 *
 *   One vocabulary. Every surface a first-party event may name is declared here
 *     once. The Worker's per-event allowlists are built from these constants, so
 *     a surface the producer can emit is a surface the validator has heard of,
 *     and the reverse.
 *
 *   The route map decides what a route is. `ANALYTICS_ROUTE_SURFACES` carries one
 *     row per registered surface in `site/data/performance-classification-manifest.v1.json`,
 *     with that surface's own matcher paths copied across and its route family
 *     recorded beside them. `test/analytics_surface_taxonomy.test.mjs` fails when a
 *     surface is added, retired or re-pathed there without being answered here, so
 *     a growing product cannot quietly outgrow its own measurement again.
 *
 *   An unknown route has no surface. `resolveAnalyticsSurface` answers
 *     `unclassified` for anything the map does not register — the same treatment
 *     `site/performance_route_classifier.mjs` already gives an unknown pathname —
 *     and the producer then sends nothing at all. A route nobody registered is an
 *     observability gap, which is a fact worth knowing; attributing it to the
 *     homepage is a false one.
 *
 * `served_aliases` records the second path the platform actually serves a document
 * at. `/stats.html` answers 308 to `/stats`, `/stats` answers 200, and the reader's
 * browser therefore sits on `/stats` — see `docs/evidence/stats-public-experience/README.md`
 * for the observed redirect table. The route map names the canonical document; this
 * column names the URL a page view is really recorded from.
 *
 * Nothing here is an identity. A surface is a page category with a fixed spelling,
 * carrying no record id, query, place, or reader.
 */

export const ANALYTICS_SURFACE_TAXONOMY_SCHEMA = "cityscroll.analytics_surface_taxonomy.v1";

/** The route map this vocabulary must stay answerable to. */
export const ANALYTICS_ROUTE_MANIFEST_PATH = "site/data/performance-classification-manifest.v1.json";

/**
 * One row per registered route-map surface. `surface` is the spelling events use;
 * where it differs from the route map's own id, the difference is a historical
 * analytics spelling that predates the map and is kept so a live series is not
 * broken by a rename. `route_surface_id` is always the map's id.
 */
export const ANALYTICS_ROUTE_SURFACES = Object.freeze([
  Object.freeze({
    surface: "about",
    route_surface_id: "about",
    route_family: "information-about",
    patterns: Object.freeze(["/about.html"]),
    served_aliases: Object.freeze(["/about"]),
  }),
  Object.freeze({
    surface: "agency",
    route_surface_id: "agency",
    route_family: "entity-agency",
    patterns: Object.freeze(["/agencies", "/agencies/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "api",
    route_surface_id: "api-guide",
    route_family: "information-api",
    patterns: Object.freeze(["/api.html"]),
    served_aliases: Object.freeze(["/api"]),
  }),
  Object.freeze({
    surface: "assertion",
    route_surface_id: "assertion",
    route_family: "record-assertion",
    patterns: Object.freeze(["/assertions", "/assertions/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "browse",
    route_surface_id: "browse",
    route_family: "browse",
    patterns: Object.freeze(["/browse"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "browse-contracts",
    route_surface_id: "browse-contracts",
    route_family: "browse-contracts",
    patterns: Object.freeze(["/browse/contracts"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "browse-exams",
    route_surface_id: "browse-exams",
    route_family: "browse-exams",
    patterns: Object.freeze(["/browse/exams"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "browse-meetings",
    route_surface_id: "browse-meetings",
    route_family: "browse-meetings",
    patterns: Object.freeze(["/browse/meetings"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "browse-people",
    route_surface_id: "browse-people",
    route_family: "browse-people",
    patterns: Object.freeze(["/browse/people"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "browse-places",
    route_surface_id: "browse-places",
    route_family: "browse-places",
    patterns: Object.freeze(["/browse/places"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "browse-property",
    route_surface_id: "browse-property",
    route_family: "browse-property",
    patterns: Object.freeze(["/browse/property"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "browse-rules",
    route_surface_id: "browse-rules",
    route_family: "browse-rules",
    patterns: Object.freeze(["/browse/rules"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "browse-staffing",
    route_surface_id: "browse-staffing",
    route_family: "browse-staffing",
    patterns: Object.freeze(["/browse/staffing"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "browse-zoning",
    route_surface_id: "browse-zoning",
    route_family: "browse-zoning",
    patterns: Object.freeze(["/browse/zoning"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "changelog",
    route_surface_id: "changelog",
    route_family: "information-changelog",
    patterns: Object.freeze(["/changelog.html"]),
    served_aliases: Object.freeze(["/changelog"]),
  }),
  Object.freeze({
    surface: "committee",
    route_surface_id: "committee",
    route_family: "entity-committee",
    patterns: Object.freeze(["/committees/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "community-board",
    route_surface_id: "community-board",
    route_family: "entity-community-board",
    patterns: Object.freeze(["/community-boards", "/community-boards/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "data",
    route_surface_id: "data-guide",
    route_family: "information-data",
    patterns: Object.freeze(["/data.html"]),
    served_aliases: Object.freeze(["/data"]),
  }),
  Object.freeze({
    surface: "data-health",
    route_surface_id: "data-health",
    route_family: "information-data-health",
    patterns: Object.freeze(["/data-health"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "district-digest",
    route_surface_id: "district-digest",
    route_family: "district-digest",
    patterns: Object.freeze(["/districts/council/{district}/digest"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "exam",
    route_surface_id: "exam",
    route_family: "record-exam",
    patterns: Object.freeze(["/exams/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "following",
    route_surface_id: "following",
    route_family: "stateful-following",
    patterns: Object.freeze(["/following"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "following-pack",
    route_surface_id: "following-pack",
    route_family: "stateful-following-pack",
    patterns: Object.freeze(["/following/packs/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "guide",
    route_surface_id: "guide",
    route_family: "information-guide",
    patterns: Object.freeze(["/guide"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "guide-article",
    route_surface_id: "guide-article",
    route_family: "information-guide",
    patterns: Object.freeze(["/guide/{section}/{article}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "home",
    route_surface_id: "home",
    route_family: "home",
    patterns: Object.freeze(["/", "/index.html"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "mandate",
    route_surface_id: "mandate",
    route_family: "record-mandate",
    patterns: Object.freeze(["/mandates/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "meeting",
    route_surface_id: "meeting",
    route_family: "record-meeting",
    patterns: Object.freeze(["/meetings/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "near-you",
    route_surface_id: "near-you",
    route_family: "place-near-you",
    patterns: Object.freeze(["/near-you", "/near-you/lens/{lens}", "/near-you/borough/{borough}", "/near-you/borough/{borough}/{lens}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "notice",
    route_surface_id: "notice",
    route_family: "record-notice",
    patterns: Object.freeze(["/notices/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "now",
    route_surface_id: "now",
    route_family: "task-now",
    patterns: Object.freeze(["/now"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "official",
    route_surface_id: "official",
    route_family: "entity-official",
    patterns: Object.freeze(["/officials/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "parcel",
    route_surface_id: "parcel",
    route_family: "record-parcel",
    patterns: Object.freeze(["/parcels/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "procurement",
    route_surface_id: "procurement",
    route_family: "record-procurement",
    patterns: Object.freeze(["/procurements/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "rulemaking",
    route_surface_id: "rulemaking",
    route_family: "rulemaking",
    patterns: Object.freeze(["/rules/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "search",
    route_surface_id: "search",
    route_family: "search",
    patterns: Object.freeze(["/search"]),
    served_aliases: Object.freeze([]),
  }),
  Object.freeze({
    surface: "standards",
    route_surface_id: "standards",
    route_family: "information-standards",
    patterns: Object.freeze(["/standards.html"]),
    served_aliases: Object.freeze(["/standards"]),
  }),
  Object.freeze({
    surface: "stats",
    route_surface_id: "public-stats",
    route_family: "information-stats",
    patterns: Object.freeze(["/stats.html"]),
    served_aliases: Object.freeze(["/stats"]),
  }),
  Object.freeze({
    surface: "vendor",
    route_surface_id: "vendor",
    route_family: "entity-vendor",
    patterns: Object.freeze(["/vendors/{record}"]),
    served_aliases: Object.freeze([]),
  }),
  // Not a route-map surface. The experimental view ships the collector and already
  // carries a landed signal, so it keeps its own spelling and states why it has no
  // row in the map rather than being folded onto a neighbouring surface.
  Object.freeze({
    surface: "worth-a-look",
    route_surface_id: null,
    route_family: null,
    patterns: Object.freeze(["/experimental/worth-a-look"]),
    served_aliases: Object.freeze([]),
    unregistered_reason: "An experimental view the route map does not register.",
  }),
]);

/**
 * Surfaces that are real but are not routes on this site. They name where a
 * delivered message was read or followed from, can never be resolved from a
 * pathname, and are never produced by the page script.
 */
export const ANALYTICS_NON_ROUTE_SURFACES = Object.freeze([
  Object.freeze({
    surface: "digest",
    reason: "A delivered digest, not a route on this site.",
  }),
  Object.freeze({
    surface: "email",
    reason: "A delivered message, not a route on this site.",
  }),
]);

/** Every surface any first-party event may name, sorted and closed. */
export const ANALYTICS_SURFACES = Object.freeze([
  ...ANALYTICS_ROUTE_SURFACES.map((row) => row.surface),
  ...ANALYTICS_NON_ROUTE_SURFACES.map((row) => row.surface),
].sort());

/**
 * The documents that ship the first-party collector, as the surfaces they resolve
 * to. This is the whole set a browser-produced event can name, so it is also what
 * the Worker accepts for those events: a surface no page can produce is not an
 * allowed dimension, and a page that can produce one is never refused.
 *
 * `test/analytics_surface_taxonomy.test.mjs` derives the same set from the site's
 * own documents — tracked and generated — and fails when the two differ, so
 * shipping the collector on a new document is a change that has to be answered
 * here.
 */
export const ANALYTICS_COLLECTOR_SURFACES = Object.freeze([
  "about",
  "api",
  "browse",
  "browse-contracts",
  "browse-exams",
  "browse-meetings",
  "browse-people",
  "browse-places",
  "browse-property",
  "browse-rules",
  "browse-staffing",
  "browse-zoning",
  "changelog",
  "data",
  "data-health",
  "following",
  "home",
  "near-you",
  "now",
  "search",
  "standards",
  "stats",
  "worth-a-look",
]);

/** The answer for a route the map does not register. Never a surface. */
export const ANALYTICS_UNCLASSIFIED_SURFACE = Object.freeze({
  classification_state: "unclassified",
  surface: null,
  route_surface_id: null,
  route_family: null,
});

/**
 * The same normalization `site/performance_route_classifier.mjs` applies: a
 * pathname only, with no query, fragment or empty segment, and with trailing
 * slashes removed so `/browse/` and `/browse` are one route rather than two.
 */
function normalizedSurfacePathname(value) {
  const raw = String(value || "");
  if (!raw.startsWith("/") || raw.includes("?") || raw.includes("#") || raw.includes("//")) return null;
  return raw === "/" ? raw : raw.replace(/\/+$/, "");
}

/** The route map's own segment-template semantics: one segment, any non-empty value. */
function surfaceTemplateMatches(template, pathname) {
  const expected = template.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => (
    /^\{[a-z][a-z0-9-]*\}$/.test(segment)
      ? actual[index].length > 0
      : segment === actual[index]
  ));
}

/**
 * Resolve a browser pathname to the surface that owns it.
 *
 * Deliberately total and deliberately narrow: it takes a pathname and nothing
 * else, so no query value, fragment, record id or reader state can reach a
 * measurement dimension through it. An unregistered route resolves to
 * `unclassified`, never to a neighbouring surface and never to `home`.
 */
export function resolveAnalyticsSurface(pathname) {
  const normalized = normalizedSurfacePathname(pathname);
  if (!normalized) return ANALYTICS_UNCLASSIFIED_SURFACE;
  for (const row of ANALYTICS_ROUTE_SURFACES) {
    const matched = [...row.patterns, ...row.served_aliases].some((pattern) => (
      pattern.includes("{")
        ? surfaceTemplateMatches(pattern, normalized)
        : pattern === normalized
    ));
    if (matched) {
      return {
        classification_state: "registered",
        surface: row.surface,
        route_surface_id: row.route_surface_id,
        route_family: row.route_family,
      };
    }
  }
  return ANALYTICS_UNCLASSIFIED_SURFACE;
}

/** Whether a spelling is one this vocabulary knows at all. */
export function isAnalyticsSurface(value) {
  return ANALYTICS_SURFACES.includes(String(value || ""));
}
