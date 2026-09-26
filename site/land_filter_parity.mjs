/**
 * One Land query, two renderings.
 *
 * Land browse is a single canonical population that List and Map each paint. LM-03 made the
 * population a filtered result set, LM-06 made Map a projection of that set, and LM-07 gave the
 * projection a selection. This module is what keeps the premise underneath all three honest:
 * it names every filter dimension the Land query actually has, turns a route into exactly one
 * normalized query, and derives a parity receipt whose invariants fail loudly when a renderer
 * starts answering a different question.
 *
 * The equality it exists to defend is a set equality, not a headline count:
 *
 *     set(List ids) === set(Map marker ids) ∪ set(Map unmapped ids)
 *
 * A map that looks right is not parity. A project with no published point has to stay in the
 * total, stay in the List, and be named as unmapped, or the map has quietly deleted it.
 *
 * This module is pure. It parses, normalizes, and compares; it owns no renderer, no DOM, no
 * request, no clock, and no data source. Everything it reports is derived from its inputs, so a
 * receipt taken from a browser and a receipt taken from a fixture are the same kind of evidence.
 */

import {
  DEFAULT_LAND_FAMILY,
  LAND_FAMILY_OPTIONS,
  LAND_FUTURE_ACTION_OPTIONS,
  LAND_STAGE_OPTIONS,
} from "./land_status_facets.mjs";
import { DEFAULT_LAND_PROCEDURE, LAND_PROCEDURE_OPTIONS } from "./land_procedure_facet.mjs";
import { LAND_REGULATORY_EFFECT_OPTIONS } from "./land_regulatory_effect.mjs";
import { LAND_FILING_EVIDENCE_OPTIONS } from "./land_filing_evidence_facet.mjs";
import { LAND_PRESENTATION_STATE_KEYS, normalizeLandView } from "./land_view_state.mjs";

export const LAND_FILTER_PARITY_SCHEMA = "cityscroll.land_filter_parity.v1";

/** The project-limit the canonical Land search applies, once, before either renderer sees a row. */
export const LAND_DEFAULT_RESULT_LIMIT = 40;

/**
 * Address/block narrowing still has its own presentation ceiling. Geography membership and the
 * other facets must run before this cut, or a matching lot past the thirtieth unfiltered
 * candidate disappears from an area-scoped query.
 */
export const LAND_ADDRESS_RESULT_LIMIT = 30;

/** Schema id for the L02 place-membership index; compared by value to avoid a browser import cycle. */
export const LAND_PLACE_MEMBERSHIP_SCHEMA_ID = "cityscroll.land_place_membership.v1";

const LAND_NTA_GEOGRAPHY_RE = /^geography:nta2020:((?:BK|BX|MN|QN|SI)\d{4})$/;

// Named apart from the several other module-private `BOROUGHS` constants of the same values:
// the pre-split inline fixture in test/functional/21_module_dom_equivalence.py flattens these
// modules into one classic script, where two module-private `const`s of one name collide.
const LAND_FILTER_BOROUGHS = Object.freeze(["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]);
const COMMUNITY_DISTRICT_RE = /^(?:M|X|K|Q|R)\d{2}$/;
const COUNCIL_DISTRICT_RE = /^(?:[1-9]|[1-4]\d|5[01])$/;
const LEGACY_EXACT_STATUS_RE = /^(?:project|public):.{1,80}$/;
const LEGACY_PUBLIC_REVIEW = "public:In Public Review";
const LEGACY_PROJECT_ACTIVE = "project:Active";

const optionIds = (options) => Object.freeze(options.map((option) => option.id));

/**
 * Every filter dimension the canonical Land query supports, as one explicit inventory.
 *
 * `queryKey` is the argument `filterLandSnapshot` takes and is the only name product code should
 * use. `routeKey` is the shareable URL key, which is not always the same word: the commissioned
 * name `future` is the route key for `futureAction`, `boro`/`cd`/`council`/`q` are the route keys
 * for the geography and keyword dimensions, and `regulatoryEffect` has no dedicated route key at
 * all — it rides in the typed `facet` blob, because scope v0's Land key table never grew an alias
 * for it. That asymmetry is recorded here rather than smoothed over, because a dimension whose
 * URL path differs from its neighbours' is exactly the one a future change forgets.
 *
 * `limit` and `projectIds` have no route key by design. The limit is the canonical query's own,
 * applied once; `projectIds` is the block/BBL narrowing a resolved address produces.
 */
export const LAND_FILTER_DIMENSIONS = Object.freeze([
  Object.freeze({
    id: "status", queryKey: "status", routeKey: "status", defaultValue: "active",
    values: null, reachesWatchScope: true,
    note: "Project/public status, including the legacy `project:`/`public:` exact forms.",
  }),
  Object.freeze({
    id: "stage", queryKey: "stage", routeKey: "stage", defaultValue: "active",
    values: optionIds(LAND_STAGE_OPTIONS), reachesWatchScope: true,
    note: "Review stage. Absent, it is derived from status for legacy links.",
  }),
  Object.freeze({
    id: "future", queryKey: "futureAction", routeKey: "future", defaultValue: "any",
    values: optionIds(LAND_FUTURE_ACTION_OPTIONS), reachesWatchScope: true,
    note: "Commissioned as `future`; the canonical query key is `futureAction`.",
  }),
  Object.freeze({
    id: "procedure", queryKey: "procedure", routeKey: "procedure",
    defaultValue: DEFAULT_LAND_PROCEDURE,
    values: optionIds(LAND_PROCEDURE_OPTIONS), reachesWatchScope: true,
    note: "ULURP/ELURP procedure class.",
  }),
  Object.freeze({
    id: "family", queryKey: "family", routeKey: "family", defaultValue: DEFAULT_LAND_FAMILY,
    values: optionIds(LAND_FAMILY_OPTIONS), reachesWatchScope: true,
    note: "Closed action-family facet.",
  }),
  Object.freeze({
    id: "regulatoryEffect", queryKey: "regulatoryEffect", routeKey: null,
    facetKey: "regulatoryEffect", defaultValue: "any",
    values: optionIds(LAND_REGULATORY_EFFECT_OPTIONS), reachesWatchScope: true,
    note: "No dedicated route key: carried in the typed `facet` blob, and in watch scope by name.",
  }),
  Object.freeze({
    id: "filingEvidence", queryKey: "filingEvidence", routeKey: null,
    facetKey: "filingEvidence", defaultValue: "any",
    values: optionIds(LAND_FILING_EVIDENCE_OPTIONS), reachesWatchScope: true,
    note: "LDP-27's three factual filing-evidence states. No dedicated route key: carried in the typed `facet` blob, like `regulatoryEffect`.",
  }),
  Object.freeze({
    id: "borough", queryKey: "borough", routeKey: "boro", defaultValue: "",
    values: LAND_FILTER_BOROUGHS, reachesWatchScope: true,
    note: "Exact borough name.",
  }),
  Object.freeze({
    id: "communityDistrict", queryKey: "communityDistrict", routeKey: "cd", defaultValue: "",
    values: null, reachesWatchScope: true,
    note: "Borough-lettered community district, e.g. K02.",
  }),
  Object.freeze({
    id: "councilDistrict", queryKey: "councilDistrict", routeKey: "council", defaultValue: "",
    values: null, reachesWatchScope: true,
    note: "Council district 1-51.",
  }),
  Object.freeze({
    id: "keyword", queryKey: "keyword", routeKey: "q", defaultValue: "",
    values: null, reachesWatchScope: true,
    note: "Free text over the row, lowercased and whitespace-collapsed by the query.",
  }),
  Object.freeze({
    id: "geographies", queryKey: "geographies", routeKey: "geo", defaultValue: null,
    values: null, reachesWatchScope: true,
    note: "Canonical NTA geography keys (`geography:nta2020:…`). OR across selected NTAs; absent is null, not all-city when the resident supplied only invalid keys.",
  }),
  Object.freeze({
    id: "limit", queryKey: "limit", routeKey: null,
    defaultValue: LAND_DEFAULT_RESULT_LIMIT, values: null, reachesWatchScope: false,
    note: "The canonical query's own project limit, applied once after ordering.",
  }),
  Object.freeze({
    id: "projectIds", queryKey: "projectIds", routeKey: null, defaultValue: null,
    values: null, reachesWatchScope: false,
    note: "Block/BBL narrowing produced by a resolved address, not a resident-typed key.",
  }),
]);

/**
 * Hearing-row selectors, which are deliberately NOT Land query dimensions.
 *
 * `attendance` and `closing` narrow the upcoming-hearing rows a `future=hearing` search reads;
 * they are not arguments to the project query and never change which projects exist. They are
 * inventoried here so the parity suite can carry them through a route without mistaking them for
 * a dimension of the population — and so nobody later "fixes" their absence from the query.
 */
export const LAND_HEARING_ROW_SELECTORS = Object.freeze([
  Object.freeze({
    id: "attendance", routeKey: "attendance", defaultValue: "",
    values: Object.freeze(["in_person", "livestream", "hybrid"]), reachesWatchScope: true,
    note: "Hearing attendance mode. Only meaningful while future=hearing.",
  }),
  Object.freeze({
    id: "closingWeek", routeKey: "closing", defaultValue: false,
    values: Object.freeze([true, false]), reachesWatchScope: true,
    note: "Hearings closing this week. Carried by the route but dropped by the scope v0 Land serializer.",
  }),
]);

/** The dimension inventory keyed by its canonical query argument. */
export const LAND_FILTER_DIMENSIONS_BY_QUERY_KEY = Object.freeze(Object.fromEntries(
  LAND_FILTER_DIMENSIONS.map((dimension) => [dimension.queryKey, dimension]),
));

const STAGE_IDS = new Set(optionIds(LAND_STAGE_OPTIONS));
const FUTURE_IDS = new Set(optionIds(LAND_FUTURE_ACTION_OPTIONS));
const PROCEDURE_IDS = new Set(optionIds(LAND_PROCEDURE_OPTIONS));
const FAMILY_IDS = new Set(optionIds(LAND_FAMILY_OPTIONS));
const EFFECT_IDS = new Set(optionIds(LAND_REGULATORY_EFFECT_OPTIONS));
const PARITY_FILING_EVIDENCE_IDS = new Set(optionIds(LAND_FILING_EVIDENCE_OPTIONS));
const ATTENDANCE_IDS = new Set(["in_person", "livestream", "hybrid"]);

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function paramBag(input) {
  if (input instanceof URLSearchParams) return input;
  if (typeof input === "string") {
    const raw = input.replace(/^#/, "");
    const queryAt = raw.indexOf("?");
    return new URLSearchParams(queryAt < 0 ? raw.replace(/^[?&]/, "") : raw.slice(queryAt + 1));
  }
  const params = new URLSearchParams();
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (value == null) continue;
      if (key === "geo" && Array.isArray(value)) {
        for (const entry of value) {
          if (entry != null) params.append("geo", String(entry));
        }
        continue;
      }
      params.append(key, String(value));
    }
  }
  return params;
}

function sortedUniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value ?? "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Parse resident geography inputs into canonical NTA keys.
 *
 * Bare NTA ids and full `geography:nta2020:…` keys are accepted. Anything else is retained as
 * invalid so a hand-edited URL cannot silently widen to the whole city.
 */
export function normalizeLandNtaGeographyKeys(rawKeys) {
  const inputs = Array.isArray(rawKeys)
    ? rawKeys
    : (rawKeys == null || rawKeys === "" ? [] : [rawKeys]);
  const keys = [];
  const invalidKeys = [];
  const ntaIds = [];
  for (const raw of inputs) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const bare = /^(?:BK|BX|MN|QN|SI)\d{4}$/.test(value) ? `geography:nta2020:${value}` : value;
    const match = bare.match(LAND_NTA_GEOGRAPHY_RE);
    if (!match) {
      invalidKeys.push(value);
      continue;
    }
    if (!keys.includes(bare)) {
      keys.push(bare);
      ntaIds.push(match[1]);
    }
  }
  return Object.freeze({
    keys: Object.freeze(sortedUniqueStrings(keys)),
    invalidKeys: Object.freeze(sortedUniqueStrings(invalidKeys)),
    ntaIds: Object.freeze(sortedUniqueStrings(ntaIds)),
  });
}

/**
 * Resolve NTA geography scope against the L02 place-membership index.
 *
 * status:
 * - `none` — no geography input; the query stays citywide for this axis
 * - `ready` — one or more valid NTA keys; `projectIds` is the OR-union (may be empty)
 * - `invalid` — input was present but no valid NTA key survived; not an all-city query
 * - `unavailable` — valid keys need the membership index and it is missing or incoherent
 */
export function resolveLandNtaGeographyConstraint(rawKeys, membershipIndex = null) {
  const inputs = Array.isArray(rawKeys)
    ? rawKeys
    : (rawKeys == null || rawKeys === "" ? [] : [rawKeys]);
  if (!inputs.length) {
    return Object.freeze({
      status: "none",
      keys: Object.freeze([]),
      invalidKeys: Object.freeze([]),
      ntaIds: Object.freeze([]),
      projectIds: null,
    });
  }

  const normalized = normalizeLandNtaGeographyKeys(inputs);
  if (!normalized.keys.length) {
    return Object.freeze({
      status: "invalid",
      keys: Object.freeze([]),
      invalidKeys: normalized.invalidKeys,
      ntaIds: Object.freeze([]),
      projectIds: Object.freeze([]),
    });
  }

  if (
    !membershipIndex
    || membershipIndex.schema !== LAND_PLACE_MEMBERSHIP_SCHEMA_ID
    || !membershipIndex.by_geography
    || typeof membershipIndex.by_geography !== "object"
  ) {
    return Object.freeze({
      status: "unavailable",
      keys: normalized.keys,
      invalidKeys: normalized.invalidKeys,
      ntaIds: normalized.ntaIds,
      projectIds: null,
    });
  }

  const places = membershipIndex.by_geography.nta2020;
  if (!places || typeof places !== "object") {
    return Object.freeze({
      status: "unavailable",
      keys: normalized.keys,
      invalidKeys: normalized.invalidKeys,
      ntaIds: normalized.ntaIds,
      projectIds: null,
    });
  }

  const seen = new Set();
  const projectIds = [];
  for (const ntaId of normalized.ntaIds) {
    const list = places[ntaId];
    if (!Array.isArray(list)) continue;
    for (const projectId of list) {
      const id = String(projectId ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      projectIds.push(id);
    }
  }

  return Object.freeze({
    status: "ready",
    keys: normalized.keys,
    invalidKeys: normalized.invalidKeys,
    ntaIds: normalized.ntaIds,
    projectIds: Object.freeze(projectIds),
  });
}

/**
 * Checker for geography-constraint receipts. Empty findings mean the constraint is coherent;
 * positive-control fixtures must be able to produce a non-empty list.
 */
export function landNtaGeographyConstraintFindings(constraint) {
  const findings = [];
  if (!constraint || typeof constraint !== "object") {
    return ["constraint missing"];
  }
  const status = constraint.status;
  if (!["none", "ready", "invalid", "unavailable"].includes(status)) {
    findings.push(`unknown status ${status}`);
  }
  if (!Array.isArray(constraint.keys)) findings.push("keys missing");
  if (!Array.isArray(constraint.invalidKeys)) findings.push("invalidKeys missing");
  if (!Array.isArray(constraint.ntaIds)) findings.push("ntaIds missing");

  if (status === "none") {
    if (constraint.projectIds != null) findings.push("none constraint should leave projectIds null");
    if ((constraint.keys || []).length) findings.push("none constraint still lists keys");
  }
  if (status === "invalid") {
    if (!Array.isArray(constraint.projectIds)) findings.push("invalid constraint missing projectIds");
    else if (constraint.projectIds.length) findings.push("invalid constraint still lists projectIds");
    if ((constraint.keys || []).length) findings.push("invalid constraint still lists valid keys");
    if (!(constraint.invalidKeys || []).length) findings.push("invalid constraint missing invalidKeys");
  }
  if (status === "ready") {
    if (!Array.isArray(constraint.projectIds)) findings.push("ready constraint missing projectIds");
    if (!(constraint.keys || []).length) findings.push("ready constraint missing keys");
    if (!(constraint.ntaIds || []).length) findings.push("ready constraint missing ntaIds");
  }
  if (status === "unavailable") {
    if (constraint.projectIds != null) findings.push("unavailable constraint should leave projectIds null");
    if (!(constraint.keys || []).length) findings.push("unavailable constraint missing keys");
  }
  return findings;
}

function facetBag(params, provided) {
  if (provided && typeof provided === "object" && !Array.isArray(provided)) return provided;
  const raw = params.get("facet");
  if (!raw || raw.length > 2000) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

/**
 * Turn a Land route's parameters into exactly one canonical Land query.
 *
 * This is the single implementation of Land's URL semantics: which values are accepted, which
 * legacy `status` spellings still adopt a stage, and what an unrecognized value falls back to.
 * The route reads it to set its controls and the parity suite reads it to build fixtures, so a
 * URL cannot mean one thing to the page and another thing to the evidence.
 *
 * An unrecognized value is never an error and never narrows to nothing: it resolves to the
 * dimension's default, which is what a resident hand-editing a URL should get.
 *
 * @param {URLSearchParams|Record<string, unknown>|string} input a query string, a route hash, or a bag
 * @param {{facetValues?: Record<string, unknown>}} [options]
 */
export function landFilterStateFromRouteParams(input, { facetValues } = {}) {
  const params = paramBag(input);
  const facet = facetBag(params, facetValues);

  const rawStatus = params.get("status");
  const rawStage = params.get("stage");
  const rawFuture = params.get("future");
  const rawProcedure = params.get("procedure");
  const rawFamily = params.get("family");
  const rawEffect = facet.regulatoryEffect;
  const rawFilingEvidence = facet.filingEvidence;

  const validStage = STAGE_IDS.has(rawStage || "");
  const validFuture = FUTURE_IDS.has(rawFuture || "");

  let stage = validStage ? rawStage : "active";
  if (!validStage) {
    if (rawStatus === "all") stage = "any";
    else if (rawStatus === "active" || !rawStatus) stage = "active";
    else if (rawStatus === LEGACY_PUBLIC_REVIEW) stage = "public_review";
    else if (rawStatus === LEGACY_PROJECT_ACTIVE) stage = "active";
    else stage = "any";
  }

  let futureAction = validFuture ? rawFuture : "any";
  if (!validFuture && rawStatus === "hearings") futureAction = "hearing";

  const legacyExact = LEGACY_EXACT_STATUS_RE.test(rawStatus || "");
  const status = legacyExact && ![LEGACY_PUBLIC_REVIEW, LEGACY_PROJECT_ACTIVE].includes(rawStatus)
    ? rawStatus
    : "all";

  const borough = LAND_FILTER_BOROUGHS.includes(params.get("boro")) ? params.get("boro") : "";
  const communityDistrict = COMMUNITY_DISTRICT_RE.test(params.get("cd") || "") ? params.get("cd") : "";
  const councilDistrict = COUNCIL_DISTRICT_RE.test(params.get("council") || "") ? params.get("council") : "";
  const attendanceRaw = params.get("attendance") || "";
  const attendance = futureAction === "hearing" && ATTENDANCE_IDS.has(attendanceRaw) ? attendanceRaw : "";
  const rawGeographies = params.getAll("geo");
  // null = axis absent. An array (even empty) means the resident supplied geography input, so an
  // all-invalid `geo` list stays a bounded empty query instead of falling through to citywide.
  const geographies = rawGeographies.length
    ? normalizeLandNtaGeographyKeys(rawGeographies).keys
    : null;

  return Object.freeze({
    status,
    stage,
    futureAction,
    procedure: PROCEDURE_IDS.has(rawProcedure || "") ? rawProcedure : DEFAULT_LAND_PROCEDURE,
    family: FAMILY_IDS.has(rawFamily || "") ? rawFamily : DEFAULT_LAND_FAMILY,
    regulatoryEffect: EFFECT_IDS.has(String(rawEffect ?? "")) ? String(rawEffect) : "any",
    filingEvidence: PARITY_FILING_EVIDENCE_IDS.has(String(rawFilingEvidence ?? "")) ? String(rawFilingEvidence) : "any",
    borough,
    communityDistrict,
    councilDistrict,
    keyword: text(params.get("q")),
    geographies,
    attendance,
    closingWeek: futureAction === "hearing" && params.get("closing") === "week",
    limit: LAND_DEFAULT_RESULT_LIMIT,
    view: normalizeLandView(params.get("view")),
  });
}

/**
 * The options bag `filterLandSnapshot` takes, derived from one route state.
 *
 * `view` never appears here, and neither does `attendance` or `closingWeek`: they select
 * hearing rows, not projects. Everything the population depends on comes from this one call, so
 * there is no second place a renderer could add a predicate of its own.
 *
 * @param {ReturnType<typeof landFilterStateFromRouteParams>} state
 * @param {{actionRows?: unknown[], today?: string, projectIds?: string[]|null, limit?: number}} [context]
 */
export function landSnapshotQueryFromState(state, {
  actionRows = [],
  today,
  projectIds = null,
  placeMembership = null,
  limit,
} = {}) {
  return Object.freeze({
    status: state.status,
    stage: state.stage,
    futureAction: state.futureAction,
    procedure: state.procedure,
    family: state.family,
    regulatoryEffect: state.regulatoryEffect,
    filingEvidence: state.filingEvidence,
    borough: state.borough,
    communityDistrict: state.communityDistrict,
    councilDistrict: state.councilDistrict,
    keyword: state.keyword,
    geographies: state.geographies ?? null,
    projectIds,
    placeMembership,
    actionRows,
    today,
    limit: Number.isFinite(limit) ? limit : state.limit,
  });
}

/**
 * The semantic scope of a Land route: everything a watch may carry, and nothing a renderer owns.
 *
 * Two routes with the same semantic scope must produce the same population, in the same order,
 * whichever renderer is painting. That is the property `view` is deliberately excluded from.
 *
 * @param {ReturnType<typeof landFilterStateFromRouteParams>} state
 */
export function landSemanticScopeFromState(state) {
  const scope = {};
  for (const dimension of LAND_FILTER_DIMENSIONS) {
    if (!dimension.reachesWatchScope) continue;
    const value = state[dimension.queryKey];
    if (dimension.queryKey === "geographies") {
      if (!Array.isArray(value) || value.length === 0) continue;
      scope.geographies = [...value];
      continue;
    }
    if (value == null || value === "" || value === dimension.defaultValue) continue;
    scope[dimension.queryKey] = value;
  }
  // The hearing-row selectors are watch fields even though they are not query dimensions.
  if (state.attendance) scope.attendance = state.attendance;
  if (state.closingWeek) scope.closingWeek = true;
  return Object.freeze(scope);
}

/** Ordered, de-duplicated canonical ids for a filtered Land population. */
export function landCanonicalIds(rows) {
  const seen = new Set();
  const list = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.project_id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push(id);
  }
  return list;
}

/**
 * A deep copy with object keys in sorted order.
 *
 * A receipt is written to disk and compared byte for byte, and a watch bag's key order is an
 * artifact of which branch of the scope serializer ran, not a fact about the scope. Sorting
 * makes "the same watch" and "the same bytes" the same statement.
 */
function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableClone(value[key])]));
  }
  return value;
}

function sameOrder(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSet(left, right) {
  if (left.length !== right.length) return false;
  const set = new Set(right);
  return left.every((value) => set.has(value));
}

/**
 * The parity receipt: what the canonical query produced, what each renderer produced from it,
 * and whether the two are the same population.
 *
 * `listIds` is supplied by the caller rather than re-derived from rows, and that is the whole
 * point: in the browser it is read back out of the painted List, so a List that drops, reorders,
 * or duplicates a card is caught here instead of being assumed away.
 *
 * Nothing here reads a clock or a viewport, so the same inputs always produce the same receipt.
 *
 * @param {{
 *   route?: string,
 *   state?: object,
 *   query?: object,
 *   rows?: unknown[],
 *   listIds?: string[],
 *   model?: object,
 *   view?: unknown,
 *   watch?: object,
 *   revision?: string|null,
 * }} input
 */
export function buildLandParityReceipt({
  route = "",
  state = null,
  query = null,
  rows = [],
  listIds = null,
  model = null,
  view,
  watch = null,
  revision = null,
} = {}) {
  const resolvedState = state || landFilterStateFromRouteParams(route);
  const canonicalIds = landCanonicalIds(rows);
  const renderedListIds = Array.isArray(listIds)
    ? listIds.map((id) => String(id ?? "").trim())
    : canonicalIds;
  const markerIds = (model?.markers || []).map((marker) => String(marker?.projectId ?? "").trim());
  const unmappedIds = (model?.unmapped || []).map((item) => String(item?.projectId ?? "").trim());
  const counts = model?.counts || null;

  const receipt = {
    schema: LAND_FILTER_PARITY_SCHEMA,
    revision: revision == null ? null : String(revision),
    route: String(route || ""),
    view: normalizeLandView(view ?? resolvedState.view),
    state: { ...resolvedState },
    query: query ? { ...query } : landSnapshotQueryFromState(resolvedState),
    semantic_scope: landSemanticScopeFromState(resolvedState),
    watch_scope: watch ? stableClone(watch) : null,
    canonical_ids: canonicalIds,
    list_ids: renderedListIds,
    marker_ids: markerIds,
    unmapped_ids: unmappedIds,
    counts: {
      total: counts ? counts.total : canonicalIds.length,
      mapped: counts ? counts.mapped : 0,
      unmapped: counts ? counts.unmapped : 0,
    },
  };
  receipt.violations = landParityViolations(receipt);
  receipt.parity = receipt.violations.length === 0;
  return receipt;
}

/**
 * Every way the receipt says the two renderings are not the same population.
 *
 * Each check is stated separately and named, because "the counts matched" is precisely the kind
 * of agreement that hides a swapped row. An empty array is the only passing result.
 *
 * @param {ReturnType<typeof buildLandParityReceipt>} receipt
 * @returns {string[]}
 */
export function landParityViolations(receipt) {
  const violations = [];
  const canonical = receipt?.canonical_ids || [];
  const list = receipt?.list_ids || [];
  const markers = receipt?.marker_ids || [];
  const unmapped = receipt?.unmapped_ids || [];
  const counts = receipt?.counts || { total: 0, mapped: 0, unmapped: 0 };

  if (new Set(canonical).size !== canonical.length) violations.push("canonical_ids_not_unique");
  if (new Set(list).size !== list.length) violations.push("list_ids_not_unique");
  if (new Set(markers).size !== markers.length) violations.push("marker_ids_not_unique");
  if (new Set(unmapped).size !== unmapped.length) violations.push("unmapped_ids_not_unique");

  if (!sameOrder(list, canonical)) violations.push("list_order_differs_from_canonical");

  const markerSet = new Set(markers);
  if (unmapped.some((id) => markerSet.has(id))) violations.push("partition_not_disjoint");

  if (!sameSet([...markers, ...unmapped], canonical)) {
    violations.push("partition_union_differs_from_canonical");
  }

  // Map may drop a row from neither side, and may not re-order the rows it was given.
  if (!sameOrder(markers, canonical.filter((id) => markerSet.has(id)))) {
    violations.push("marker_order_differs_from_canonical");
  }
  const unmappedSet = new Set(unmapped);
  if (!sameOrder(unmapped, canonical.filter((id) => unmappedSet.has(id)))) {
    violations.push("unmapped_order_differs_from_canonical");
  }

  if (counts.total !== list.length) violations.push("total_count_differs_from_list_length");
  if (counts.mapped !== markers.length) violations.push("mapped_count_differs_from_marker_ids");
  if (counts.unmapped !== unmapped.length) violations.push("unmapped_count_differs_from_unmapped_ids");
  if (counts.mapped + counts.unmapped !== counts.total) violations.push("partition_counts_do_not_sum");

  // A limit is the canonical query's, applied once. A renderer that trimmed further would show
  // fewer ids than the population it was handed.
  const limit = receipt?.query?.limit;
  if (Number.isFinite(limit) && canonical.length > limit) violations.push("canonical_population_exceeds_limit");

  for (const key of LAND_PRESENTATION_STATE_KEYS) {
    if (receipt?.semantic_scope && key in receipt.semantic_scope) {
      violations.push(`presentation_key_in_semantic_scope:${key}`);
    }
    if (receipt?.watch_scope?.filter && key in receipt.watch_scope.filter) {
      violations.push(`presentation_key_in_watch_scope:${key}`);
    }
  }

  return violations;
}

/**
 * Compare two receipts taken from the same semantic scope under different presentations.
 *
 * Switching renderers is a presentation change, so everything except `view` has to be identical
 * — the population, its order, the partition, the semantic scope, and the watch a resident would
 * save from it.
 */
export function landParityDivergence(left, right) {
  const differences = [];
  const compare = (key, a, b) => {
    if (JSON.stringify(stableClone(a ?? null)) !== JSON.stringify(stableClone(b ?? null))) differences.push(key);
  };
  compare("canonical_ids", left?.canonical_ids, right?.canonical_ids);
  compare("list_ids", left?.list_ids, right?.list_ids);
  compare("marker_ids", left?.marker_ids, right?.marker_ids);
  compare("unmapped_ids", left?.unmapped_ids, right?.unmapped_ids);
  compare("counts", left?.counts, right?.counts);
  compare("semantic_scope", left?.semantic_scope, right?.semantic_scope);
  compare("watch_scope", left?.watch_scope, right?.watch_scope);
  compare("query", left?.query, right?.query);
  return differences;
}
