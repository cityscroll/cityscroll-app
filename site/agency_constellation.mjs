/**
 * Agency cross-category constellation (first iteration).
 *
 * Parcel biographies group property + land + tax for one BBL. This module does
 * the same shape for one agency across contracts, meetings, rules, and staffing
 * exams — using existing entity-intelligence edges plus publisher exam
 * certification rows. Match methods stay labeled so later graph work can refine
 * coverage without inventing a second ontology.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import {
  AGENCY_OBLIGATIONS_CERTIFICATION,
  AGENCY_OBLIGATIONS_ER_BASIS,
  AGENCY_OBLIGATIONS_METHOD,
  agencyObligationsFollowHref,
  buildAgencyObligationsView,
} from "./agency_obligations.mjs";
import {
  CONFORMANCE_COPY,
  MANDATE_CONFORMANCE_STYLE,
  OBSERVATION_LABELS,
  PROCESS_CONFORMANCE_METHOD,
  agencyMandatesConformancePath,
  buildAgencyConformanceView,
  renderMandatesConformanceSection,
} from "./process_conformance.mjs";
import {
  MANDATE_RULES_BRIDGE_METHOD,
  MANDATE_RULES_BRIDGE_STYLE,
  agencyMandateRulesPath,
  agencyRulesFollowHref,
  buildMandateRulesBridgeView,
  renderMandateRulesBridgeSection,
} from "./mandate_rules_bridge.mjs";
import {
  MANDATE_REPORTS_RECEIPT_METHOD,
  MANDATE_REPORTS_RECEIPT_STYLE,
  agencyMandateReportsPath,
  buildMandateReportsReceiptView,
  renderMandateReportsReceiptSection,
} from "./mandate_reports_receipt.mjs";
import {
  MANDATE_PREDICTION_METHOD,
  MANDATE_PREDICTION_STYLE,
  agencyMandatePredictionsPath,
  buildAgencyMandatePredictionsView,
  renderMandatePredictionsSection,
} from "./mandate_prediction_alerts.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import { canonicalizeBrowseUrl } from "./route_migration.mjs";
import {
  emptyScope,
  normalizeScope,
  routeHashFromScope,
  scopeWithEntity,
} from "./scope_v0.mjs";
import {
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeActions,
  renderNodeBack,
  renderNodeFooter,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import {
  buildEdgeProvenanceClaim,
  edgeProvenanceClientScript,
  isStandablePublicClaim,
  renderEdgeProvenancePanel,
  renderWhyBelieveControl,
  sourceSystemReaderLabel,
  summarizeCategoryWarrants,
} from "./graph_edge_provenance.mjs";
import {
  asOfFilterCanNarrow,
  asOfHref,
  buildLedgerSummary,
  normalizeAsOfDay,
  projectAgencyConstellationAsOf,
  renderCivicTimeLedgerPanel,
} from "./civic_time_ledger.mjs";

export const AGENCY_CONSTELLATION_SCHEMA = "cityscroll.agency_constellation.v1";
export const AGENCY_CONSTELLATION_METHOD = "agency_constellation_v1";
export const AGENCY_CONSTELLATION_ER_BASIS = "agency_canonical_v1+publisher_certification_record_v1+statute_actor_alias_v1";

/** v1 slice categories — contracts / meetings / rules / obligations / staffing. */
export const AGENCY_CONSTELLATION_CATEGORIES = Object.freeze([
  Object.freeze({
    id: "contracts",
    domain: "money",
    label: "Contracts",
    browse_facet: "contracts",
    surface: "money",
    relation: "published_by_agency",
    empty_note: "No contract or award notices are linked to this agency in the current materialization.",
  }),
  Object.freeze({
    id: "meetings",
    domain: "meetings",
    label: "Meetings and hearings",
    browse_facet: "meetings",
    surface: "meetings",
    relation: "hosts_meeting",
    empty_note: "No meeting or hearing notices are linked to this agency in the current materialization.",
  }),
  Object.freeze({
    id: "rules",
    domain: "rules",
    label: "Rules",
    browse_facet: "rules",
    surface: "rules",
    relation: "issued_rule",
    empty_note: "No Agency Rules notices are linked to this agency in the current materialization.",
  }),
  Object.freeze({
    id: "obligations",
    domain: "rules",
    label: "Mandates",
    browse_facet: "rules",
    surface: "rules",
    relation: "statute_duty",
    empty_note: "No statutory mandates are linked to this agency in the current materialization.",
  }),
  Object.freeze({
    id: "staffing",
    domain: "staffing",
    label: "Staffing exams",
    browse_facet: "staffing",
    surface: "people",
    relation: "certified_to_agency",
    empty_note: "No civil-service certification edges name this agency in the current materialization.",
  }),
]);

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

const publicConfidence = (value) => {
  const confidence = String(value || "").trim().toLowerCase();
  if (confidence === "strong" || confidence === "tentative") return confidence;
  if (confidence === "publisher_record") return "strong";
  return null;
};

export function agencyPath(id) {
  const identity = resolveAgencyIdentity(id);
  return identity?.canonical_id
    ? `/agencies/${encodeURIComponent(identity.canonical_id)}/`
    : "/agencies/";
}

export function agencySubjectRef(id) {
  const identity = resolveAgencyIdentity(id);
  return identity?.canonical_id ? `agency:id:${identity.canonical_id}` : null;
}

/** Compose the shared agency entity constraint (scope grammar). */
export function agencyConstellationScope(id, { language = "en", domain = null } = {}) {
  const identity = resolveAgencyIdentity(id);
  const ref = agencySubjectRef(identity.canonical_id || id);
  let scope = emptyScope(language);
  if (identity.canonical_name) scope.facets.agencies = [identity.canonical_name];
  if (ref) scope = scopeWithEntity(scope, ref);
  if (domain) scope.facets.domains = [domain];
  return normalizeScope(scope, { language });
}

function browseHrefFromScope(scope, browseFacet, surface) {
  const hash = routeHashFromScope(scope, { surface });
  const query = String(hash).includes("?") ? String(hash).split("?", 2)[1] : "";
  return canonicalizeBrowseUrl(`/browse/${browseFacet}/${query ? `?${query}` : ""}`);
}

export function agencyCategoryBrowseHref(id, categoryId, { language = "en" } = {}) {
  const category = AGENCY_CONSTELLATION_CATEGORIES.find((entry) => entry.id === categoryId);
  if (!category) return "";
  const scope = agencyConstellationScope(id, { language, domain: category.surface });
  scope.facets.values.connection_relation = category.relation;
  return browseHrefFromScope(normalizeScope(scope, { language }), category.browse_facet, category.surface);
}

export function agencyCategoryFollowHref(id, categoryId, { frequency = "weekly" } = {}) {
  const category = AGENCY_CONSTELLATION_CATEGORIES.find((entry) => entry.id === categoryId);
  const identity = resolveAgencyIdentity(id);
  const ref = agencySubjectRef(identity.canonical_id || id);
  if (!category || !identity.canonical_name) return "/following/";
  if (category.id === "obligations") {
    // World-state free-watch on statutory mandates / deadlines — not a City Record document match.
    return agencyObligationsFollowHref(identity.canonical_id || id, { frequency });
  }
  if (category.id === "staffing") {
    // Exam certifications are publisher list edges; entity watches cover City
    // Record staffing notices (Changes in Personnel) for the same agency.
    return followingUrlFromWatch(
      { lens: "entity", filter: { kind: "agency", name: identity.canonical_name } },
      { frequency },
    );
  }
  const filter = { agency: identity.canonical_name };
  if (ref) filter.entity_refs_all = [ref];
  return followingUrlFromWatch({ lens: category.surface, filter }, { frequency });
}

export function agencyConstellationFollowHref(id, { frequency = "weekly" } = {}) {
  const identity = resolveAgencyIdentity(id);
  if (!identity.canonical_name) return "/following/";
  return followingUrlFromWatch(
    { lens: "entity", filter: { kind: "agency", name: identity.canonical_name } },
    { frequency },
  );
}

function attachClaim(item, { categoryId, relation, identity }) {
  if (!item) return null;
  const claim = buildEdgeProvenanceClaim(item, {
    category_id: categoryId,
    relation: relation || item.relation,
    root_ref: `agency:id:${identity.canonical_id}`,
    document_path: agencyPath(identity.canonical_id),
  });
  return claim ? { ...item, claim } : item;
}

function domainItems(block, limit = 8) {
  const objects = Array.isArray(block?.objects) ? block.objects : [];
  return objects
    .map((object) => {
      const confidence = publicConfidence(object?.confidence);
      if (!confidence) return null;
      const requestId = clean(object.request_id, 80);
      const subjectRef = clean(object.subject_ref, 120)
        || (requestId ? `notice:${requestId}` : "");
      if (!subjectRef) return null;
      const provenance = object.provenance && typeof object.provenance === "object"
        ? {
          source_system: clean(object.provenance.source_system, 120) || null,
          source_record_id: clean(object.provenance.source_record_id, 200) || null,
          source_fields: Array.isArray(object.provenance.source_fields)
            ? object.provenance.source_fields.map((field) => clean(field, 80)).filter(Boolean)
            : [],
          basis: clean(object.provenance.basis, 120) || null,
          observed_at: clean(object.provenance.observed_at, 40) || null,
          input_value: clean(object.provenance.input_value, 240) || null,
        }
        : null;
      return {
        id: requestId || subjectRef,
        subject_ref: subjectRef,
        label: clean(object.label || subjectRef, 240),
        date: clean(object.when, 40) || null,
        source: clean(provenance?.source_system || object.provenance?.source_system || "City Record", 80),
        relation: clean(object.link_type, 80) || null,
        confidence,
        method: clean(object.method || object.provenance?.basis || "agency_canonical_v1", 80),
        href: clean(object.href, 200) || (requestId ? `#notice/${encodeURIComponent(requestId)}` : null),
        provenance,
        // Shadow ER ids are not on this public materialization — leave unset
        // so the inspector labels them as next enrichment rather than inventing them.
        entity_link_id: clean(object.entity_link_id, 120) || null,
        resolution_run_id: clean(object.resolution_run_id, 120) || null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")))
    .slice(0, limit);
}

function staffingItems(certification, agencyRef, limit = 8) {
  const edges = (Array.isArray(certification?.edges) ? certification.edges : [])
    .filter((edge) => edge?.to === agencyRef && edge?.type === "certified_to_agency");
  const titles = new Map(
    (Array.isArray(certification?.by_exam) ? certification.by_exam : [])
      .map((exam) => [String(exam.exam_no || "").trim(), clean(exam.title, 200) || null]),
  );
  return edges
    .map((edge) => {
      const examRef = clean(edge.from, 40);
      const examNo = examRef.replace(/^exam:/, "");
      if (!examNo) return null;
      const through = clean(edge.observed?.through || edge.observed?.from, 40) || null;
      const evidence = edge.evidence && typeof edge.evidence === "object" ? edge.evidence : null;
      const provenance = evidence
        ? {
          source_system: clean(evidence.source_system, 120) || "socrata",
          source_record_id: clean(evidence.source_record_id, 200) || null,
          source_fields: Array.isArray(evidence.source_fields)
            ? evidence.source_fields.map((field) => clean(field, 80)).filter(Boolean)
            : [],
          basis: clean(evidence.basis, 120) || "publisher_certification_record",
          observed_at: clean(evidence.observed_at || through, 40) || null,
          input_value: clean(
            evidence.input_value
              || (Array.isArray(edge.source_agency_labels) ? edge.source_agency_labels[0] : null),
            240,
          ) || null,
        }
        : {
          source_system: "socrata",
          source_record_id: null,
          source_fields: [],
          basis: "publisher_certification_record",
          observed_at: through,
          input_value: clean(
            Array.isArray(edge.source_agency_labels) ? edge.source_agency_labels[0] : null,
            240,
          ) || null,
        };
      return {
        id: examNo,
        subject_ref: examRef,
        label: titles.get(examNo) || `Exam ${examNo}`,
        date: through,
        source: "Civil Service List certification (Open Data)",
        relation: "certified_to_agency",
        // publisher_record is a publisher stamp; publicConfidence maps it to strong.
        confidence: clean(edge.confidence, 40) || "publisher_record",
        method: clean(edge.method || "publisher_certification_record_v1", 80),
        href: `/exams/${encodeURIComponent(examNo)}/`,
        counts: edge.counts || null,
        provenance,
        evidence,
        entity_link_id: null,
        resolution_run_id: null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")))
    .slice(0, limit);
}

function obligationItems(obligationsLookup, identity, limit = 8, conformanceView = null) {
  // Pull a wide window so standable filtering still leaves a full category total.
  const view = buildAgencyObligationsView(identity.canonical_id, obligationsLookup, { limit: 500 });
  if (!view || view.status !== "matched") {
    return { total: 0, items: [], view, conformance: conformanceView, all_items: [] };
  }
  const confById = new Map(
    (conformanceView?.items || []).map((row) => [row.mandate_id || row.obligation_id, row]),
  );
  const mapped = view.items.map((item) => {
    const conf = confById.get(item.obligation_id)?.observation || null;
    return {
      id: item.obligation_id,
      subject_ref: `obligation:${item.obligation_id}`,
      label: item.duty_text,
      date: item.deadline_date || null,
      source: item.citation || "Enacted local law",
      relation: "statute_duty",
      confidence: item.quote_verified || item.certification_status === "auto_certified"
        ? "strong"
        : "tentative",
      method: conf ? PROCESS_CONFORMANCE_METHOD : AGENCY_OBLIGATIONS_METHOD,
      href: item.href,
      deliverable_type: item.deliverable_type,
      recurrence: item.recurrence,
      deadline_text: item.deadline_text,
      certification_status: item.certification_status,
      observation_status: conf?.status || item.observation_status || null,
      observation_label: conf?.label || (conf?.status ? OBSERVATION_LABELS[conf.status] : null) || null,
      expected_event_label: conf?.expected_event?.label || null,
      observed_record: conf?.observed_record || null,
      kind: "obligation",
      provenance: {
        source_system: "enacted_local_law",
        source_record_id: item.obligation_id || null,
        source_fields: ["duty_text", "deadline", "citation"],
        basis: AGENCY_OBLIGATIONS_CERTIFICATION || "auto_certified_quote_verify_v1",
        observed_at: item.deadline_date || null,
        input_value: item.citation || null,
      },
    };
  });
  if (conformanceView?.items?.length) {
    const rank = {
      observed: 0,
      on_track: 1,
      expected_not_yet_observed: 2,
      enrichment_pending: 3,
    };
    mapped.sort((left, right) => {
      const leftRank = rank[left.observation_status] ?? 9;
      const rightRank = rank[right.observation_status] ?? 9;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return String(left.date || "9999").localeCompare(String(right.date || "9999"));
    });
  }
  return {
    total: Number(conformanceView?.counts?.total) || Number(view.count) || mapped.length,
    view,
    conformance: conformanceView,
    items: mapped.slice(0, limit),
    all_items: mapped,
  };
}

function categoryStatusLabel(category) {
  if (category.status !== "matched") return "";
  if (category.id === "obligations") {
    return `${category.count} mandates`;
  }
  const total = Number(category.count) || category.items?.length || 0;
  return `${total} linked`;
}

/** Keep only standable public edges (drop tentative rather than hedge them). */
function standableItems(items = []) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (!item?.claim) return true;
    return isStandablePublicClaim(item.claim);
  });
}

function categoryFromDomain(spec, intelligence, identity, certification, obligationsLookup, conformanceView = null) {
  if (spec.id === "obligations") {
    const { total, items: preview, all_items, view, conformance } = obligationItems(obligationsLookup, identity, 12, conformanceView);
    const claimAll = (all_items || preview).map((item) => attachClaim(item, {
      categoryId: spec.id,
      relation: spec.relation,
      identity,
    }));
    // Keep auto-certified duties; drop quote-miss candidates rather than hedge them.
    const standable = standableItems(claimAll);
    const items = standable.slice(0, 8);
    const warrant_summary = summarizeCategoryWarrants(standable);
    const shown = standable.length || 0;
    // Reader count is the materialization total (obligations / conformance corpus);
    // the list preview is standable-only so candidates are not hedged in public HTML.
    const readerCount = total || shown;
    return {
      id: spec.id,
      label: spec.label,
      relation: spec.relation,
      status: readerCount ? "matched" : "empty",
      gap_class: readerCount ? null : "empty_in_corpus",
      note: readerCount ? null : (view?.note || spec.empty_note),
      count: readerCount,
      items,
      warrant_summary,
      method: conformance ? PROCESS_CONFORMANCE_METHOD : AGENCY_OBLIGATIONS_METHOD,
      certification_basis: AGENCY_OBLIGATIONS_CERTIFICATION,
      er_match_basis: AGENCY_OBLIGATIONS_ER_BASIS,
      view_all_href: agencyMandatesConformancePath(identity.canonical_id),
      follow_href: agencyCategoryFollowHref(identity.canonical_id, spec.id),
      honesty: CONFORMANCE_COPY.lead,
      conformance,
      conformance_counts: conformance?.counts || null,
      // Free mandate watch (deliverable-type scoped links are optional refinements).
      mandate_follow_hrefs: {
        all: agencyObligationsFollowHref(identity.canonical_id),
        report: agencyObligationsFollowHref(identity.canonical_id, { deliverableType: "report" }),
        rulemaking: agencyObligationsFollowHref(identity.canonical_id, { deliverableType: "rulemaking" }),
        window_90: agencyObligationsFollowHref(identity.canonical_id, { windowDays: 90 }),
      },
    };
  }

  if (spec.id === "staffing") {
    const agencyRef = `agency:id:${identity.canonical_id}`;
    const claimed = staffingItems(certification, agencyRef).map((item) => attachClaim(item, {
      categoryId: spec.id,
      relation: spec.relation,
      identity,
    }));
    const items = standableItems(claimed);
    const agencyRow = (Array.isArray(certification?.by_agency) ? certification.by_agency : [])
      .find((row) => row.agency_id === identity.canonical_id || row.ref === agencyRef);
    const total = Number(agencyRow?.edge_count) || items.length;
    const warrant_summary = summarizeCategoryWarrants(items);
    return {
      id: spec.id,
      label: spec.label,
      relation: spec.relation,
      status: items.length || total ? "matched" : "empty",
      gap_class: items.length || total ? null : "empty_in_corpus",
      note: items.length || total ? null : spec.empty_note,
      count: total,
      items,
      warrant_summary,
      method: "publisher_certification_record_v1",
      view_all_href: agencyCategoryBrowseHref(identity.canonical_id, spec.id),
      follow_href: agencyCategoryFollowHref(identity.canonical_id, spec.id),
    };
  }

  const block = intelligence?.domains?.[spec.domain] || {};
  const claimed = domainItems(block).map((item) => attachClaim(item, {
    categoryId: spec.id,
    relation: spec.relation,
    identity,
  }));
  const items = standableItems(claimed);
  const matched = block.status === "matched" && (Number(block.count) > 0 || items.length > 0);
  const warrant_summary = summarizeCategoryWarrants(items);
  return {
    id: spec.id,
    label: spec.label,
    relation: spec.relation,
    status: matched ? "matched" : (block.status === "not_yet_ingested" ? "not_yet_ingested" : "empty"),
    gap_class: matched ? null : (block.gap_class || "empty_in_corpus"),
    note: matched ? null : (block.note || spec.empty_note),
    count: items.length || Number(block.count) || 0,
    items,
    warrant_summary,
    method: items[0]?.method || "agency_canonical_v1",
    view_all_href: matched ? agencyCategoryBrowseHref(identity.canonical_id, spec.id) : "",
    follow_href: agencyCategoryFollowHref(identity.canonical_id, spec.id),
  };
}

/**
 * Build one agency constellation view from committed materializations.
 * @param {string} idOrName
 * @param {{ intelligence?: object, certification?: object, obligations?: object, generated_at?: string }} sources
 */
export function buildAgencyConstellationView(idOrName, sources = {}) {
  const identity = resolveAgencyIdentity(idOrName);
  if (!identity?.canonical_id) return null;

  const ref = `agency:id:${identity.canonical_id}`;
  const intelligence = sources.intelligence?.by_ref?.[ref]
    || sources.intelligence?.by_subject_ref?.[ref]
    || (sources.intelligence?.root?.ref === ref ? sources.intelligence : null)
    || null;
  const certification = sources.certification || null;
  const obligations = sources.obligations || null;

  let conformanceView = null;
  const committed = sources.process_conformance?.by_agency?.[identity.canonical_id] || null;
  if (committed && obligations) {
    const live = buildAgencyConformanceView(identity.canonical_id, {
      obligationsLookup: obligations,
      rulesDomain: sources.rules_domain || null,
      meetingsDomain: sources.meetings_domain || null,
      entityIntelligence: sources.intelligence || null,
    });
    const obsMap = committed.observations || null;
    if (live && obsMap) {
      const items = (live.items || []).map((item) => {
        const mid = item.mandate_id || item.obligation_id;
        const obs = obsMap[mid];
        if (!obs) return item;
        return {
          ...item,
          observation: {
            ...item.observation,
            ...obs,
            is_compliance_verdict: false,
            adjudication: "not_adjudicated",
          },
        };
      });
      const rank = {
        observed: 0,
        on_track: 1,
        expected_not_yet_observed: 2,
        enrichment_pending: 3,
      };
      items.sort((left, right) => {
        const leftRank = rank[left.observation?.status] ?? 9;
        const rightRank = rank[right.observation?.status] ?? 9;
        if (leftRank !== rightRank) return leftRank - rightRank;
        return String(left.deadline_date || "9999").localeCompare(String(right.deadline_date || "9999"));
      });
      conformanceView = {
        ...live,
        method: sources.process_conformance.method || PROCESS_CONFORMANCE_METHOD,
        as_of: committed.as_of || live.as_of,
        counts: committed.counts || live.counts,
        candidate_corpus: {
          size: committed.candidate_corpus_size || live.candidate_corpus?.size || 0,
          sources: live.candidate_corpus?.sources || [],
          sample: live.candidate_corpus?.sample || [],
        },
        items,
        items_total: committed.counts?.total || items.length,
        copy: sources.process_conformance.copy || sources.process_conformance.honesty || CONFORMANCE_COPY,
        honesty: sources.process_conformance.copy || sources.process_conformance.honesty || CONFORMANCE_COPY,
        share_path: committed.share_path || agencyMandatesConformancePath(identity.canonical_id),
      };
    } else {
      conformanceView = live;
    }
  } else if (obligations) {
    conformanceView = buildAgencyConformanceView(identity.canonical_id, {
      obligationsLookup: obligations,
      rulesDomain: sources.rules_domain || null,
      meetingsDomain: sources.meetings_domain || null,
      entityIntelligence: sources.intelligence || null,
    });
  }

  const categories = AGENCY_CONSTELLATION_CATEGORIES.map((spec) =>
    categoryFromDomain(spec, intelligence, identity, certification, obligations, conformanceView));

  const matched = categories.filter((category) => category.status === "matched").length;
  const claims = categories.flatMap((category) =>
    (category.items || []).map((item) => item.claim).filter(Boolean));

  // Mandates → Rules bridge: rulemaking duties joined to Rules-lens filings
  // via agency identity; per-mandate observed filings when topic join hits.
  const rulesCategory = categories.find((category) => category.id === "rules") || null;
  const mandatesRules = buildMandateRulesBridgeView(identity.canonical_id, {
    obligationsLookup: obligations,
    rulesItems: rulesCategory?.items || [],
    rulesCount: rulesCategory?.count || 0,
    rulesBrowseHref: rulesCategory?.view_all_href
      || agencyCategoryBrowseHref(identity.canonical_id, "rules"),
    rulesFollowHref: agencyRulesFollowHref(identity.canonical_id),
    conformanceItems: conformanceView?.items || [],
    limit: 12,
  });

  // Mandates → Required Reports receipt: report duties with City Record
  // filing receipt when process-conformance observes a matching publication.
  const mandatesReports = buildMandateReportsReceiptView(identity.canonical_id, {
    obligationsLookup: obligations,
    conformanceItems: conformanceView?.items || [],
    limit: 12,
  });

  // Mandates prediction-alerts: expected public-record events timed from
  // deadline + recurrence (earlier-stage watch path for free-watch digests).
  const mandatesPredictions = buildAgencyMandatePredictionsView(identity.canonical_id, {
    obligationsLookup: obligations,
    conformanceItems: conformanceView?.items || [],
    limit: 16,
    includeCadenceOnly: true,
  });

  return {
    schema: AGENCY_CONSTELLATION_SCHEMA,
    kind: "agency-constellation",
    id: identity.canonical_id,
    path: agencyPath(identity.canonical_id),
    subject_ref: ref,
    display_name: identity.canonical_name,
    canonical_id: identity.canonical_id,
    categories,
    claims,
    mandates_conformance: conformanceView,
    mandates_rules: mandatesRules,
    mandates_reports: mandatesReports,
    mandates_predictions: mandatesPredictions,
    summary: {
      matched_categories: matched,
      category_count: categories.length,
      claim_count: claims.length,
      generated_at: sources.generated_at
        || intelligence?.materialization_meta?.generated_at
        || sources.intelligence?.generated_at
        || certification?.generated_at
        || obligations?.generated_at
        || sources.process_conformance?.generated_at
        || null,
      er_match_basis: AGENCY_CONSTELLATION_ER_BASIS,
      method: AGENCY_CONSTELLATION_METHOD,
      iteration: "v1",
    },
    follow_href: agencyConstellationFollowHref(identity.canonical_id),
    scope_href: agencyCategoryBrowseHref(identity.canonical_id, "contracts"),
    mandates_href: agencyMandatesConformancePath(identity.canonical_id),
    mandates_rules_href: agencyMandateRulesPath(identity.canonical_id),
    mandates_reports_href: agencyMandateReportsPath(identity.canonical_id),
    mandates_predictions_href: agencyMandatePredictionsPath(identity.canonical_id),
    interactive_profile_href: `/#agency/${encodeURIComponent(identity.canonical_name)}`,
    provenance: {
      intelligence_generated_at: sources.intelligence?.generated_at || null,
      certification_generated_at: certification?.generated_at || null,
      obligations_generated_at: obligations?.generated_at || null,
      process_conformance_generated_at: sources.process_conformance?.generated_at || null,
      methods: [
        "agency_canonical_v1",
        "publisher_certification_record_v1",
        AGENCY_OBLIGATIONS_METHOD,
        PROCESS_CONFORMANCE_METHOD,
        MANDATE_RULES_BRIDGE_METHOD,
        MANDATE_REPORTS_RECEIPT_METHOD,
        MANDATE_PREDICTION_METHOD,
        AGENCY_CONSTELLATION_METHOD,
        "graph_edge_provenance_v1",
      ],
      note: null,
    },
  };
}

function itemLink(item) {
  const label = esc(item.label || item.subject_ref || item.id);
  if (!item.href) return label;
  return `<a data-subject-ref="${esc(item.subject_ref || "")}" href="${esc(item.href)}">${label}</a>`;
}

function obligationMeta(item) {
  // Reader-facing meta only: drop internal method keys, warrants (chip owns that), absence fillers.
  return [
    item.observation_label || null,
    item.expected_event_label || null,
    item.deliverable_type,
    item.date ? `deadline ${item.date}` : (item.deadline_text ? `deadline: ${item.deadline_text}` : null),
    item.recurrence,
    item.source,
  ].filter(Boolean).join(" · ");
}

function categorySection(category) {
  // Omit empty / not-yet-ingested categories entirely — no absence disclaimers.
  if (
    category.status === "empty"
    || category.status === "not_yet_ingested"
    || (!(category?.items?.length) && !(category?.conformance?.items?.length))
  ) {
    return "";
  }
  // Full process-conformance surface for mandates when materialization is present.
  if (category.id === "obligations" && category.conformance?.items?.length) {
    const refine = category.mandate_follow_hrefs
      ? [
        category.mandate_follow_hrefs.report
          ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.report)}">Watch report mandates</a>`
          : "",
        category.mandate_follow_hrefs.rulemaking
          ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.rulemaking)}">Watch rulemaking mandates</a>`
          : "",
        category.mandate_follow_hrefs.window_90
          ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.window_90)}">Watch deadlines in 90 days</a>`
          : "",
        category.follow_href
          ? `<a class="node-action civic-object-action" href="${esc(category.follow_href)}">Watch mandates and deadlines</a>`
          : "",
      ].filter(Boolean).join("")
      : "";
    const body = renderMandatesConformanceSection(category.conformance, { limit: 12 });
    if (refine && body.includes("</section>")) {
      return body.replace(
        "</section>",
        `<p class="node-inline-actions civic-object-inline-actions">${refine}</p></section>`,
      );
    }
    return body;
  }
  const status = category.id === "obligations"
    ? `${category.count} mandates`
    : (categoryStatusLabel(category) || `${category.count} linked`);
  const list = `<ul class="node-record-list">${category.items.map((item) => {
    const warrant = item.claim?.how?.warrant_class || "";
    const why = item.claim ? renderWhyBelieveControl(item.claim) : "";
    if (category.id === "obligations" || item.kind === "obligation") {
      const sourceLink = item.href
        ? ` · <a href="${esc(item.href)}" rel="noopener">Source law</a>`
        : "";
      return `<li class="node-record" data-obligation-id="${esc(item.id)}" data-edge-claim-row="${esc(item.claim?.claim_id || item.subject_ref || item.id)}" data-warrant-class="${esc(warrant)}">
        <div class="node-record-main">${esc(item.label)}${why ? ` ${why}` : ""}</div>
        <span class="muted node-muted">${esc(obligationMeta(item))}${sourceLink}</span>
      </li>`;
    }
    const meta = [
      sourceSystemReaderLabel(item.source) || item.source,
      item.date,
    ].filter(Boolean).join(" · ");
    return `<li class="node-record" data-edge-claim-row="${esc(item.claim?.claim_id || item.subject_ref || item.id)}" data-warrant-class="${esc(warrant)}">
      <div class="node-record-main">${itemLink(item)}${why ? ` ${why}` : ""}</div>
      ${meta ? `<span class="muted node-muted">${esc(meta)}</span>` : ""}
    </li>`;
  }).join("")}</ul>`;
  const honesty = category.id === "obligations" && category.honesty
    ? `<p class="node-muted muted">${esc(category.honesty)}</p>`
    : "";
  const followLabel = category.id === "obligations"
    ? "Watch mandates and deadlines"
    : `Follow ${category.label.toLowerCase()}`;
  const refine = category.id === "obligations" && category.mandate_follow_hrefs
    ? [
      category.mandate_follow_hrefs.report
        ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.report)}">Watch report mandates</a>`
        : "",
      category.mandate_follow_hrefs.rulemaking
        ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.rulemaking)}">Watch rulemaking mandates</a>`
        : "",
      category.mandate_follow_hrefs.window_90
        ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.window_90)}">Watch deadlines in 90 days</a>`
        : "",
    ].filter(Boolean).join("")
    : "";
  const actions = [
    category.view_all_href
      ? `<a class="node-action civic-object-action" href="${esc(category.view_all_href)}">Open in ${esc(category.label)}</a>`
      : "",
    category.follow_href
      ? `<a class="node-action civic-object-action" href="${esc(category.follow_href)}">${esc(followLabel)}</a>`
      : "",
    refine,
  ].filter(Boolean).join("");
  const body = [
    honesty,
    list,
    actions ? `<p class="node-inline-actions civic-object-inline-actions">${actions}</p>` : "",
  ].join("");
  return renderNodeSection({
    heading: `${category.label} (${status})`,
    exportClass: "object_members",
    extraClass: "node-card civic-object-section",
    attrs: {
      "data-agency-constellation-category": category.id,
      "data-status": category.status,
      ...(category.certification_basis
        ? { "data-certification-basis": category.certification_basis }
        : {}),
    },
    body,
  });
}

/** Demo as-of day for Parks: linked sample includes later 2025–2026 publisher dates. */
// source: site/data/entity_intelligence_lookup.json agency:id:parks-and-recreation item dates
const DEMO_AS_OF_DAY = "2024-06-01";

/**
 * Build a shareable constellation path with optional claim + as_of query params.
 * Claim inspects one edge; as_of filters the valid/publication axis.
 */
export function agencyConstellationSharePath(viewPath, { claim = null, asOf = null } = {}) {
  const base = String(viewPath || "/");
  const params = new URLSearchParams();
  const day = normalizeAsOfDay(asOf);
  const claimId = clean(claim, 200);
  if (day) params.set("as_of", day);
  if (claimId) params.set("claim", claimId);
  const query = params.toString();
  if (!query) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${query}`;
}

/**
 * Static-first civic document for one agency constellation (shared node layout).
 * Optional `options.asOf` (YYYY-MM-DD) pre-filters the valid/publication axis.
 * Optional `options.claim` deep-links the graph edge provenance inspector.
 */
export function renderAgencyConstellationDocument(view, options = {}) {
  if (!view || view.kind !== "agency-constellation") {
    throw new Error("Unknown agency constellation view");
  }
  const asOf = normalizeAsOfDay(options.asOf);
  const showAsOf = asOfFilterCanNarrow(view);
  const displayView = asOf && showAsOf
    ? projectAgencyConstellationAsOf(view, asOf, { axis: "valid" })
    : view;
  const title = view.display_name;
  const activeClaimId = clean(options.activeClaimId || options.claim, 200) || null;
  const effectiveAsOf = showAsOf ? asOf : null;
  const sharePath = agencyConstellationSharePath(view.path, { claim: activeClaimId, asOf: effectiveAsOf });
  const canonical = `https://cityscroll.org${sharePath}`;
  // Payload is always the full "now" materialisation; runtime re-filters as-of.
  const payload = JSON.stringify(view).replace(/<\/script/gi, "<\\/script");
  const matched = displayView.summary.matched_categories;
  const lead = effectiveAsOf
    ? (matched
      ? `Records dated on or before ${effectiveAsOf} · ${matched} of ${displayView.summary.category_count} categories.`
      : `No linked records dated on or before ${effectiveAsOf}.`)
    : (matched
      ? `Public records connected with this agency across ${matched} of ${view.summary.category_count} categories.`
      : "Public records for this agency appear here when contracts, meetings, rules, mandates, or staffing exams join to its published identity.");
  const kicker = effectiveAsOf
    ? `Agency constellation · as of ${effectiveAsOf}`
    : "Agency constellation";
  const categorySections = displayView.categories.map(categorySection).filter(Boolean).join("");
  // Mandates bridges sit with the mandates facet (shareable anchors).
  const bridgeSource = displayView.mandates_rules || view.mandates_rules || null;
  const reportsSource = displayView.mandates_reports || view.mandates_reports || null;
  const predictionsSource = displayView.mandates_predictions || view.mandates_predictions || null;
  const mandatesRulesSection = renderMandateRulesBridgeSection(bridgeSource);
  const mandatesReportsSection = renderMandateReportsReceiptSection(reportsSource);
  const mandatesPredictionsSection = renderMandatePredictionsSection(predictionsSource);
  const sections = `${mandatesPredictionsSection}${mandatesReportsSection}${mandatesRulesSection}${categorySections}`;
  // Provenance inspector uses the full claim set; as-of only filters listed members.
  const provenancePanel = renderEdgeProvenancePanel(view.claims || [], { activeClaimId });
  const obligationsFollow = view.categories.find((category) => category.id === "obligations" && (category.items?.length || category.conformance))?.follow_href || "";
  const mandatesHref = view.mandates_href || agencyMandatesConformancePath(view.canonical_id);
  const mandatesRulesHref = view.mandates_rules_href || agencyMandateRulesPath(view.canonical_id);
  const mandatesReportsHref = view.mandates_reports_href || agencyMandateReportsPath(view.canonical_id);
  const mandatesPredictionsHref = view.mandates_predictions_href
    || agencyMandatePredictionsPath(view.canonical_id);
  const ledgerSummary = effectiveAsOf ? buildLedgerSummary(view, displayView) : null;
  const ledgerPanel = showAsOf
    ? renderCivicTimeLedgerPanel({
      path: view.path,
      asOfDay: effectiveAsOf,
      summary: ledgerSummary,
    })
    : "";
  const showMandatesRulesNav = bridgeSource?.status === "matched";
  const showMandatesReportsNav = reportsSource?.status === "matched";
  const showMandatesPredictionsNav = predictionsSource?.status === "matched";
  const actions = renderNodeActions([
    { kind: "link", label: "Watch this agency across City Record", href: view.follow_href, primary: true, className: "civic-object-action" },
    mandatesHref
      ? { kind: "link", label: "Mandates expected vs observed", href: mandatesHref, className: "civic-object-action" }
      : null,
    showMandatesPredictionsNav
      ? { kind: "link", label: "Expected mandate events", href: mandatesPredictionsHref, className: "civic-object-action" }
      : null,
    showMandatesReportsNav
      ? { kind: "link", label: "Report mandates · Filing receipts", href: mandatesReportsHref, className: "civic-object-action" }
      : null,
    showMandatesRulesNav
      ? { kind: "link", label: "Rulemaking mandates · Rules activity", href: mandatesRulesHref, className: "civic-object-action" }
      : null,
    obligationsFollow
      ? { kind: "link", label: "Watch mandates and deadlines", href: obligationsFollow, className: "civic-object-action" }
      : null,
    { kind: "link", label: "Connection evidence", href: "#edge-provenance", className: "civic-object-action" },
    { kind: "button", label: "Copy link", attrs: { "data-object-copy": true }, className: "civic-object-action" },
    { kind: "button", label: "Print / save PDF", attrs: { "data-object-print": true }, className: "civic-object-action" },
    { kind: "button", label: "Download JSON", attrs: { "data-object-export": "json" }, className: "civic-object-action" },
  ].filter(Boolean), {
    ariaLabel: "Document actions",
    exportClass: "object_actions",
    extraClass: "civic-object-actions",
  });
  const assetPrefix = options.assetPrefix || "/";
  const runtimeSrc = `${assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`}civic_time_ledger_runtime.mjs`;
  const demoAsOfLink = showAsOf
    ? ` · <a href="${esc(asOfHref(view.path, DEMO_AS_OF_DAY))}" data-ctl-demo-as-of>As of ${esc(DEMO_AS_OF_DAY)}</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}${effectiveAsOf ? ` · as of ${esc(effectiveAsOf)}` : ""} · Agency constellation · CityScroll</title>
  <meta name="description" content="${esc(`Cross-category public records for ${title}: contracts, meetings, rules, mandates, and staffing exams.`)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:url" content="${esc(canonical)}">
  ${renderCivicDocumentAssets(assetPrefix)}
  <style>${MANDATE_CONFORMANCE_STYLE}${MANDATE_RULES_BRIDGE_STYLE}${MANDATE_REPORTS_RECEIPT_STYLE}${MANDATE_PREDICTION_STYLE}</style>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  ${renderCivicDocumentMast({ current: "browse", surfaceClass: "civic-object-mast" })}
  <main id="main" class="node-document civic-object-document" data-civic-object-kind="agency-constellation" data-subject-ref="${esc(view.subject_ref)}" data-er-match-basis="${esc(view.summary.er_match_basis)}" data-edge-provenance="1" data-node-document="1" data-as-of="${esc(effectiveAsOf || "")}" data-ctl-useful="${showAsOf ? "1" : "0"}">
    ${renderNodeBack({ href: "/agencies/", label: "Back to agencies", extraClass: "civic-object-back" })}
    <header class="node-hero civic-object-hero" data-export-class="object_identity">
      <p class="node-kicker civic-object-kicker">${esc(kicker)}</p>
      <h1>${esc(title)}</h1>
      <p class="node-lede">${esc(lead)}</p>
      <p class="node-pivot civic-object-pivot">
        <a data-subject-ref="${esc(view.subject_ref)}" href="${esc(view.scope_href)}">Open this agency in Contracts</a>
        · <a href="${esc(mandatesHref)}">Mandates expected vs observed</a>
        ${showMandatesPredictionsNav ? `· <a href="${esc(mandatesPredictionsHref)}">Expected mandate events</a>` : ""}
        ${showMandatesReportsNav ? `· <a href="${esc(mandatesReportsHref)}">Report mandates · Filing receipts</a>` : ""}
        ${showMandatesRulesNav ? `· <a href="${esc(mandatesRulesHref)}">Rulemaking mandates · Rules activity</a>` : ""}
        · <a href="${esc(view.interactive_profile_href)}">Interactive profile</a>
        · <a href="#edge-provenance">Connection evidence</a>${demoAsOfLink}
      </p>
    </header>
    ${actions}
    ${ledgerPanel}
    ${sections}
    ${provenancePanel}
  </main>
  ${renderNodeFooter({ extraClass: "civic-object-footer" })}
  <script id="civic-object-payload" type="application/json">${payload}</script>
  <script defer src="${esc((assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`) + "export_workflows.js")}"></script>
  <script type="module" src="${esc(runtimeSrc)}"></script>
  <script>${edgeProvenanceClientScript()}</script>
</body>
</html>`;
}
