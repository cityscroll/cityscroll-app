/**
 * Pure ZAP-project connection evidence and scope composition.
 *
 * Exact ZAP project_id is the identity boundary. Titles and addresses are
 * display evidence only and never join projects or tax lots.
 */

export const PROJECT_CONNECTION_GROUPS = Object.freeze([
  { id: "applicant", relation: "applicant_agency", surface: "land" },
  { id: "parcels", relation: "sited_on_parcel", surface: "land" },
  { id: "meetings", relation: "decides_land_project", surface: "land" },
  { id: "decisions", relation: "project_disposition", surface: "land" },
  { id: "notices", relation: "references_project", surface: "land" },
]);

export const PROJECT_CONNECTIONS_SCHEMA_VERSION = 1;

/** Classify the semantic section contract, not merely the HTTP status. */
export function projectConnectionsPayloadState(payload, expectedProjectId = "") {
  const expectedRef = expectedProjectId ? `project:${String(expectedProjectId).trim()}` : "";
  const evidence = payload?.record?.project_connections;
  const groupIds = new Set((evidence?.groups || []).map((group) => group?.id));
  const available = payload?.ok !== false
    && evidence?.schema_version === PROJECT_CONNECTIONS_SCHEMA_VERSION
    && evidence?.status === "bounded"
    && (!expectedRef || evidence?.project_ref === expectedRef)
    && PROJECT_CONNECTION_GROUPS.every(({ id }) => groupIds.has(id));
  if (available) return "available";

  const section = payload?.sections?.project_connections;
  if (section?.schema_version === PROJECT_CONNECTIONS_SCHEMA_VERSION
      && section?.status === "unavailable"
      && section?.reason) {
    return "unavailable";
  }
  return "incomplete";
}

/** Turn an incomplete success into an explicit reader-visible unavailable section. */
export function normalizeProjectConnectionsPayload(payload, expectedProjectId = "") {
  if (!payload?.record || projectConnectionsPayloadState(payload, expectedProjectId) === "available") {
    return payload;
  }
  const declared = payload?.sections?.project_connections;
  const reason = declared?.status === "unavailable" && declared?.reason
    ? declared.reason
    : "incomplete_response";
  const id = String(expectedProjectId || payload.record.project_id || "").trim();
  const section = {
    schema_version: PROJECT_CONNECTIONS_SCHEMA_VERSION,
    status: "unavailable",
    reason,
  };
  return {
    ...payload,
    sections: { ...(payload.sections || {}), project_connections: section },
    record: {
      ...payload.record,
      project_connections: {
        ...section,
        project_id: id || null,
        project_ref: id ? `project:${id}` : null,
        groups: [],
      },
    },
  };
}

const clean = (value, max = 320) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const projectId = (value) => {
  const id = clean(value, 25);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(id) ? id : "";
};

const publicConfidence = (value) => {
  const confidence = clean(value, 24).toLowerCase();
  return confidence === "strong" || confidence === "tentative" ? confidence : null;
};

const exactBbl = (value) => {
  const bbl = clean(value, 16).replace(/\.0$/, "").padStart(10, "0");
  return /^\d{10}$/.test(bbl) ? bbl : "";
};

const finiteOrNull = (value) => Number.isFinite(value) ? value : null;

function coverageBlock(value = {}) {
  const eligible = finiteOrNull(value?.eligible);
  const linked = finiteOrNull(value?.linked);
  const rate = finiteOrNull(value?.rate);
  return {
    eligible,
    linked,
    rate,
    scope: clean(value?.scope, 80) || null,
    vintage: clean(value?.vintage, 80) || null,
    gap: clean(value?.gap, 120) || (eligible == null ? "eligible_denominator_not_measured" : null),
  };
}

function emptyGroup(spec, coverage, gap = "project_not_found") {
  return {
    ...spec,
    status: "not_observed",
    gap,
    items: [],
    documents: [],
    coverage: coverageBlock(coverage),
  };
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function exactOutcome(input, id) {
  return projectId(input?.project_id) === id ? input : null;
}

function noticeGap(outcome) {
  const gap = (outcome?.spine?.gaps || []).find((item) => item?.slot === "city_record_notices");
  if (gap?.class === "source_unavailable") return "source_unavailable";
  if (gap?.class === "not_published") return "not_published";
  return "no_exact_notice_edge_in_bounded_corpus";
}

/** Build one bounded project constellation from exact-key source rows. */
export function buildProjectConnectionEvidence({
  projectId: rawProjectId,
  projectRows = [],
  bblRows = [],
  entityLinks = [],
  graphLinks = [],
  outcome = null,
  coverage = {},
} = {}) {
  const id = projectId(rawProjectId);
  const ref = id ? `project:${id}` : "";
  const project = (Array.isArray(projectRows) ? projectRows : [])
    .find((row) => projectId(row?.project_id) === id) || null;
  const groups = PROJECT_CONNECTION_GROUPS.map((spec) => emptyGroup(spec, coverage[spec.id]));
  const result = {
    schema_version: 1,
    status: project ? "bounded" : "project_not_found",
    project_id: id || null,
    project_ref: ref || null,
    project_name: clean(project?.project_name) || null,
    groups,
  };
  if (!project) return result;

  const applicantLabel = clean(project.primary_applicant);
  const applicantLinks = (Array.isArray(entityLinks) ? entityLinks : [])
    .map((link) => ({
      ref: clean(link?.entity_ref),
      label: clean(link?.label) || applicantLabel,
      relation: clean(link?.relation, 80),
      confidence: publicConfidence(link?.confidence),
      evidence: clean(link?.evidence, 240) || null,
    }))
    .filter((link) => link.ref && link.confidence && link.relation.startsWith("applicant_"));
  const applicant = groups.find((group) => group.id === "applicant");
  applicant.items = applicantLinks.length ? applicantLinks : (applicantLabel ? [{
    ref: null,
    label: applicantLabel,
    relation: null,
    confidence: null,
    evidence: "ZAP primary_applicant",
  }] : []);
  applicant.status = applicant.items.length ? "matched" : "not_observed";
  applicant.gap = applicant.items.length ? null : "applicant_not_published";

  const exactBblRows = (Array.isArray(bblRows) ? bblRows : [])
    .filter((row) => projectId(row?.project_id) === id);
  const bbls = [...new Set(exactBblRows.flatMap((row) => row?.bbls || []).map(exactBbl).filter(Boolean))]
    .sort();
  const parcels = groups.find((group) => group.id === "parcels");
  parcels.items = bbls.map((bbl) => ({
    ref: `bbl:${bbl}`,
    label: `BBL ${bbl}`,
    relation: "sited_on_parcel",
    confidence: "strong",
    evidence: "exact ZAP project_id → BBL",
  }));
  parcels.status = parcels.items.length ? "matched" : "not_observed";
  parcels.gap = parcels.items.length ? null : "no_exact_bbl_edge";

  const exactGraph = (Array.isArray(graphLinks) ? graphLinks : [])
    .filter((link) => clean(link?.type, 80) === "decides_land_project"
      && clean(link?.to) === ref
      && publicConfidence(link?.confidence));
  const joinedOutcome = exactOutcome(outcome, id);
  const exactNotices = (Array.isArray(joinedOutcome?.city_record_notices)
    ? joinedOutcome.city_record_notices : [])
    .filter((notice) => notice?.join?.matched !== false && clean(notice?.request_id, 40));
  const meetingItems = [
    ...exactGraph.map((link) => {
      const noticeId = clean(link.from).match(/^notice:(.+)$/)?.[1] || "";
      return {
        ref: noticeId ? `notice:${noticeId}` : null,
        href: noticeId ? `#notice/${encodeURIComponent(noticeId)}` : null,
        label: clean(link.label) || clean(link.agency_name) || noticeId,
        agency_name: clean(link.agency_name) || null,
        when: clean(link.when, 40) || null,
        relation: "decides_land_project",
        confidence: publicConfidence(link.confidence),
        evidence: clean(link.method, 120) || "exact project reference",
      };
    }),
    ...exactNotices.filter((notice) => notice.event_date).map((notice) => ({
      ref: `notice:${clean(notice.request_id, 40)}`,
      href: `#notice/${encodeURIComponent(clean(notice.request_id, 40))}`,
      label: clean(notice.short_title) || clean(notice.agency_name) || clean(notice.request_id, 40),
      agency_name: clean(notice.agency_name) || null,
      when: clean(notice.event_date, 40) || null,
      relation: "decides_land_project",
      confidence: "strong",
      evidence: clean(notice.join?.method, 120) || "exact ULURP token",
    })),
  ];
  const meetings = groups.find((group) => group.id === "meetings");
  meetings.items = uniqueBy(meetingItems, (item) => item.ref || item.href);
  meetings.status = meetings.items.length ? "matched" : "not_observed";
  meetings.gap = meetings.items.length ? null : "no_exact_meeting_edge_in_bounded_corpus";

  const dispositions = Array.isArray(joinedOutcome?.dispositions) ? joinedOutcome.dispositions : [];
  const documents = Array.isArray(joinedOutcome?.documents) ? joinedOutcome.documents : [];
  const decisions = groups.find((group) => group.id === "decisions");
  decisions.items = dispositions.map((item) => ({
    label: clean(item.representing || item.name) || "Published disposition",
    outcome: clean(item.community_board || item.borough_president || item.borough_board || item.status) || null,
    when: clean(item.vote_date || item.hearing_date, 40) || null,
    relation: "project_disposition",
    confidence: "strong",
    evidence: "ZAP disposition",
  }));
  decisions.documents = documents.map((document) => ({
    label: clean(document?.name) || "Decision document",
    href: /^https:\/\//.test(clean(document?.url, 1_000)) ? clean(document.url, 1_000) : null,
  }));
  decisions.status = decisions.items.length || decisions.documents.length ? "matched" : "not_observed";
  decisions.gap = decisions.documents.length ? null : "decision_documents_not_published";

  const notices = groups.find((group) => group.id === "notices");
  notices.items = uniqueBy(exactNotices.map((notice) => ({
    ref: `notice:${clean(notice.request_id, 40)}`,
    href: `#notice/${encodeURIComponent(clean(notice.request_id, 40))}`,
    label: clean(notice.short_title) || clean(notice.type_of_notice_description) || clean(notice.request_id, 40),
    agency_name: clean(notice.agency_name) || null,
    when: clean(notice.event_date || notice.start_date, 40) || null,
    relation: "references_project",
    confidence: "strong",
    evidence: clean(notice.join?.method, 120) || "exact ULURP token",
  })), (item) => item.ref);
  notices.status = notices.items.length ? "matched" : "not_observed";
  notices.gap = notices.items.length ? null : noticeGap(joinedOutcome);

  return result;
}

function scopeApi(provided) {
  const api = provided || globalThis.CrolScope;
  if (!api) throw new Error("Project connections require the scope-v0 adapter");
  return api;
}

/** Compose a reader-verb group into a canonical typed project scope. */
export function projectConnectionScopeHash(
  evidence,
  groupId,
  { language = "en", scope: providedScopeApi } = {},
) {
  const api = scopeApi(providedScopeApi);
  const spec = PROJECT_CONNECTION_GROUPS.find((entry) => entry.id === groupId);
  const group = evidence?.groups?.find((entry) => entry.id === groupId);
  if (!spec || !group || group.status !== "matched" || !evidence?.project_ref) return "";
  let scope = api.emptyScope(language);
  scope.facets.domains = [spec.surface];
  scope = api.scopeWithEntity(scope, evidence.project_ref);
  scope.facets.values.connection_relation = spec.relation;
  return api.routeHashFromScope(api.normalizeScope(scope, { language }), { surface: spec.surface });
}

/** Intersect this project with the view that opened it. */
export function projectApplyScopeHash(
  evidence,
  currentHash = "#land",
  { language = "en", scope: providedScopeApi } = {},
) {
  const api = scopeApi(providedScopeApi);
  const current = api.scopeFromRouteHash(currentHash, { language });
  const project = api.scopeWithEntity(api.emptyScope(language), evidence?.project_ref);
  project.facets.domains = ["land"];
  const composed = api.intersectScopes(current, project);
  return api.routeHashFromScope(composed, { surface: current.facets.domains?.[0] || "land" });
}

/** Add canonical scope URLs without changing evidence ownership. */
export function buildProjectConnectionView(
  evidence,
  { currentHash = "#land", language = "en", scope: providedScopeApi } = {},
) {
  scopeApi(providedScopeApi);
  return {
    ...evidence,
    groups: (evidence?.groups || []).map((group) => ({
      ...group,
      view_all_href: projectConnectionScopeHash(evidence, group.id, {
        language,
        scope: providedScopeApi,
      }),
    })),
    apply_scope_href: projectApplyScopeHash(evidence, currentHash, {
      language,
      scope: providedScopeApi,
    }),
  };
}
