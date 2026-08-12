/**
 * Agency cross-category constellation view model (first iteration).
 *
 * Parcel biographies group property + land + tax for one BBL. This module does
 * the same shape for one agency across contracts, meetings, rules, and staffing
 * exams — using existing entity-intelligence edges plus publisher exam
 * certification rows. Match methods stay labeled so later graph work can refine
 * coverage without inventing a second ontology.
 */

import { reconcileAgencyIdentity, resolveAgencyIdentity } from "./agency_identity.mjs";
import {
  AGENCY_OBLIGATIONS_CERTIFICATION,
  AGENCY_OBLIGATIONS_ER_BASIS,
  AGENCY_OBLIGATIONS_METHOD,
  agencyObligationsFollowHref,
  buildAgencyObligationsView,
} from "./agency_obligations.mjs";
import {
  CONFORMANCE_COPY,
  OBSERVATION_LABELS,
  PROCESS_CONFORMANCE_METHOD,
  agencyMandatesConformancePath,
  buildAgencyConformanceView,
} from "./process_conformance.mjs";
import {
  MANDATE_RULES_BRIDGE_METHOD,
  agencyMandateRulesPath,
  agencyRulesFollowHref,
  buildMandateRulesBridgeView,
} from "./mandate_rules_bridge.mjs";
import {
  MANDATE_MEETINGS_METHOD,
  agencyMandateMeetingsPath,
  buildMandateMeetingsView,
} from "./mandate_meetings_bridge.mjs";
import {
  MANDATE_CONTRACTS_METHOD,
  agencyMandateContractsPath,
  buildMandateContractsBridgeView,
} from "./mandate_contracts_bridge.mjs";
import {
  MANDATE_LAND_USE_METHOD,
  agencyMandateLandUsePath,
  buildMandateLandUseView,
} from "./mandate_land_use_bridge.mjs";
import {
  MANDATE_REPORTS_RECEIPT_METHOD,
  agencyMandateReportsPath,
  buildMandateReportsReceiptView,
} from "./mandate_reports_receipt.mjs";
import {
  MANDATE_PREDICTION_METHOD,
  agencyMandatePredictionsPath,
  buildAgencyMandatePredictionsView,
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
  buildEdgeProvenanceClaim,
  isStandablePublicClaim,
  summarizeCategoryWarrants,
} from "./graph_edge_provenance.mjs";
import { entityHref, entityRouteRef } from "./entity_pivot.mjs";
import { noticeDocumentPath } from "./notice_permalink.mjs";
import {
  AGENCY_BROWSE_PREVIEW_LIMIT,
  agencyBrowseRowObject,
  buildAgencyBrowseContract,
} from "./agency_browse_contract.mjs";
import {
  edgeRelationLabel,
  normalizeEdgeSummaryRecords,
} from "./edge_summary.mjs";

export const AGENCY_CONSTELLATION_SCHEMA = "cityscroll.agency_constellation.v1";
export const AGENCY_CONSTELLATION_METHOD = "agency_constellation_v1";
export const AGENCY_CONSTELLATION_ER_BASIS = "agency_canonical_v1+publisher_certification_record_v1+statute_actor_alias_v1";

/** v1 slice categories — contracts / vendors / meetings / rules / obligations / staffing. */
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
    id: "vendors",
    domain: "money",
    label: "Top vendors by award $ (last 12 mo)",
    browse_facet: "contracts",
    surface: "money",
    relation: "top_vendor_by_award_12mo",
    empty_note: "No named vendors with positive awards are in the current 12-month materialization.",
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

function appendBrowseQuery(href, { asOf = "", mode = "" } = {}) {
  const url = new URL(href, "https://cityscroll.org");
  const day = String(asOf || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
  if (mode) url.searchParams.set("mode", mode);
  if (day) url.searchParams.set("as_of", day);
  return `${url.pathname}${url.search}`;
}

export function agencyCategoryBrowseHref(id, categoryId, { language = "en", asOf = "", mode = "" } = {}) {
  const category = AGENCY_CONSTELLATION_CATEGORIES.find((entry) => entry.id === categoryId);
  if (!category) return "";
  if (category.id === "vendors") return agencyCategoryBrowseHref(id, "contracts", { language });
  const scope = agencyConstellationScope(id, { language, domain: category.surface });
  scope.facets.values.connection_relation = category.relation;
  if (category.id === "contracts") scope.facets.values.mode = mode || "open";
  return appendBrowseQuery(
    browseHrefFromScope(normalizeScope(scope, { language }), category.browse_facet, category.surface),
    { asOf, mode: category.id === "contracts" ? (mode || "open") : "" },
  );
}

export function agencyCategoryArchiveHref(id, categoryId, { language = "en" } = {}) {
  if (categoryId !== "contracts") return "";
  return agencyCategoryBrowseHref(id, categoryId, { language, mode: "archive" });
}

export function agencyCategoryFollowHref(id, categoryId, { frequency = "weekly" } = {}) {
  const category = AGENCY_CONSTELLATION_CATEGORIES.find((entry) => entry.id === categoryId);
  const identity = resolveAgencyIdentity(id);
  const ref = agencySubjectRef(identity.canonical_id || id);
  if (!category || !identity.canonical_name) return "/following/";
  if (category.id === "vendors") return agencyCategoryFollowHref(id, "contracts", { frequency });
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

/**
 * Destination for one constellation edge on a standalone agency document.
 *
 * Agency pages are static document hosts, not the SPA shell. SPA hash routes
 * such as `#notice/<id>` therefore do not leave the agency page. Notice rows
 * must use the canonical `/notices/<id>` document path (same grammar as
 * exams → `/exams/<id>/`). Passport / Checkbook contract rows often have no
 * City Record notice; when a firm name is present, link the vendor profile.
 *
 * @param {object} object
 * @returns {string|null}
 */
export function constellationObjectHref(object = {}) {
  const requestId = clean(object.request_id, 80);
  const rawHref = clean(object.href, 200);
  const subjectRef = clean(object.subject_ref, 120);

  // Explicit notice id wins over a stale SPA hash carried from entity-intelligence.
  if (requestId) {
    const path = noticeDocumentPath(requestId);
    if (path) return path;
  }

  const hashNotice = rawHref.match(/^#notice\/([^?#]+)/);
  if (hashNotice) {
    let id = hashNotice[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      // Keep the raw fragment id; noticeDocumentPath still encodes safely.
    }
    const path = noticeDocumentPath(id);
    if (path) return path;
  }

  const noticeSubject = subjectRef.match(/^notice:([A-Za-z0-9_-]{1,80})$/);
  if (noticeSubject) {
    const path = noticeDocumentPath(noticeSubject[1]);
    if (path) return path;
  }

  // Keep non-hash paths already resolved (exams, absolute URLs, browse scopes).
  if (rawHref && !rawHref.startsWith("#")) return rawHref;

  // Contract subjects without a notice: vendor profile is the existing public
  // surface for the named firm (label is the firm name on PASSPort rows).
  const isContract = object.object_kind === "contract"
    || subjectRef.startsWith("contract:")
    || Boolean(clean(object.contract_id, 80));
  if (isContract) {
    const vendorName = clean(object.vendor_name || object.label, 240);
    if (vendorName && !/^contract:/i.test(vendorName)) {
      const ref = entityRouteRef("vendor", vendorName);
      const href = ref ? entityHref({ ref, label: vendorName }) : "";
      if (href) return href;
    }
  }

  return null;
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
      const label = clean(object.label || subjectRef, 240);
      return {
        id: requestId || subjectRef,
        subject_ref: subjectRef,
        label,
        date: clean(object.when, 40) || null,
        source: clean(provenance?.source_system || object.provenance?.source_system || "City Record", 80),
        relation: clean(object.link_type, 80) || null,
        confidence,
        method: clean(object.method || object.provenance?.basis || "agency_canonical_v1", 80),
        href: constellationObjectHref({
          ...object,
          request_id: requestId,
          subject_ref: subjectRef,
          label,
          href: object.href,
        }),
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

/**
 * Exam numbers that have staffing-guide documents (/exams/:id/).
 * Certification edges alone are not enough — historical list rows may name
 * exams outside the current guide, and linking them falls through to the SPA.
 * @param {{ staffing_exams?: object|Array, staffing_exam_numbers?: Set|Array }} sources
 * @returns {Set<string>|null} null when the caller did not supply a corpus
 */
export function documentableExamNumberSet(sources = {}) {
  if (sources?.staffing_exam_numbers instanceof Set) {
    return new Set([...sources.staffing_exam_numbers].map((value) => String(value).trim()).filter(Boolean));
  }
  if (Array.isArray(sources?.staffing_exam_numbers)) {
    return new Set(sources.staffing_exam_numbers.map((value) => String(value).trim()).filter(Boolean));
  }
  const rows = Array.isArray(sources?.staffing_exams?.exams)
    ? sources.staffing_exams.exams
    : Array.isArray(sources?.staffing_exams)
      ? sources.staffing_exams
      : null;
  if (!rows) return null;
  return new Set(
    rows.map((row) => String(row?.exam_number || row?.exam_no || "").trim()).filter(Boolean),
  );
}

/**
 * @param {object} certification
 * @param {string} agencyRef
 * @param {{ limit?: number, documentableExamNumbers?: Set<string>|null }} [options]
 */
function staffingItems(certification, agencyRef, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 8;
  const documentableExamNumbers = options.documentableExamNumbers ?? null;
  const edges = (Array.isArray(certification?.edges) ? certification.edges : [])
    .filter((edge) => edge?.to === agencyRef && edge?.type === "certified_to_agency");
  const titles = new Map(
    (Array.isArray(certification?.by_exam) ? certification.by_exam : [])
      .map((exam) => [String(exam.exam_no || "").trim(), clean(exam.title, 200) || null]),
  );
  const seen = new Set();
  return edges
    .map((edge) => {
      const examRef = clean(edge.from, 40);
      const examNo = examRef.replace(/^exam:/, "");
      if (!examNo) return null;
      // Exam documents and the edge route only accept four-digit exam numbers.
      if (!/^\d{4}$/.test(examNo)) return null;
      // When a staffing-guide corpus is supplied, only list exams that have pages.
      if (documentableExamNumbers && !documentableExamNumbers.has(examNo)) return null;
      if (seen.has(examNo)) return null;
      seen.add(examNo);
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
      // The category row is the certified source-law edge. Conformance is a
      // separate observation layer and must not downgrade the source-law edge
      // merely because the full mandate corpus is now present in the scroll view.
      method: AGENCY_OBLIGATIONS_METHOD,
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

/** Keep only standable public edges (drop tentative rather than hedge them). */
function standableItems(items = []) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (!item?.claim) return true;
    return isStandablePublicClaim(item.claim);
  });
}

function categoryFromDomain(
  spec,
  intelligence,
  identity,
  certification,
  obligationsLookup,
  conformanceView = null,
  documentableExamNumbers = null,
  vendorRollups = null,
  browseSources = {},
) {
  if (spec.id === "vendors") {
    const rollup = vendorRollups?.by_id?.[identity.canonical_id] || [];
    const items = rollup.map((vendor) => ({
      id: vendor.subject_ref,
      subject_ref: vendor.subject_ref,
      label: clean(vendor.label, 320),
      href: clean(vendor.href, 400),
      award_count: Number(vendor.award_count) || 0,
      award_total: Number.isFinite(Number(vendor.award_total)) ? Number(vendor.award_total) : null,
      confidence: "strong",
      relation: spec.relation,
      method: vendorRollups?.method || "agency_vendor_awards_12mo_v1",
    })).filter((item) => item.label && item.href && item.award_total != null);
    return {
      id: spec.id,
      label: spec.label,
      relation: spec.relation,
      status: items.length ? "matched" : "empty",
      gap_class: items.length ? null : "empty_in_corpus",
      note: items.length ? null : spec.empty_note,
      count: items.length,
      items,
      award_total: items.reduce((sum, item) => sum + item.award_total, 0),
      method: vendorRollups?.method || "agency_vendor_awards_12mo_v1",
      view_all_href: items.length ? agencyCategoryBrowseHref(identity.canonical_id, "contracts") : "",
      follow_href: items.length ? agencyCategoryFollowHref(identity.canonical_id, "contracts") : "",
      window_start: vendorRollups?.window_start || null,
      as_of: vendorRollups?.as_of || null,
    };
  }

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
    // Count every document-backed certification edge; only preview a short list.
    const claimed = staffingItems(certification, agencyRef, {
      limit: Number.MAX_SAFE_INTEGER,
      documentableExamNumbers,
    }).map((item) => attachClaim(item, {
      categoryId: spec.id,
      relation: spec.relation,
      identity,
    }));
    const standable = standableItems(claimed);
    // Count is the document-backed join size — never the raw certification edge
    // total (those include historical exams with no /exams/:id/ page).
    const total = standable.length;
    const items = standable.slice(0, 8);
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

  const browsePayload = spec.id === "contracts"
    ? browseSources.money_open
    : spec.id === "meetings"
      ? browseSources.meetings_domain
      : null;
  if (browsePayload) {
    const browse = buildAgencyBrowseContract({
      facet: spec.browse_facet,
      identity,
      payload: browsePayload,
      relation: spec.relation,
      mode: spec.id === "contracts" ? "open" : "",
      limit: AGENCY_BROWSE_PREVIEW_LIMIT,
    });
    const sourceSystem = browsePayload.source?.system
      || browsePayload.source?.name
      || (spec.id === "meetings" ? "city_record" : "city_record");
    const claimed = (browse?.rows || [])
      .map((row) => agencyBrowseRowObject(row, {
        facet: spec.browse_facet,
        relation: spec.relation,
        sourceSystem,
      }))
      .filter(Boolean)
      .map((item) => attachClaim(item, {
        categoryId: spec.id,
        relation: spec.relation,
        identity,
      }));
    const items = standableItems(claimed);
    const total = Number(browse?.total) || 0;
    const matched = total > 0;
    const asOf = browse?.asOf || null;
    return {
      id: spec.id,
      label: spec.label,
      relation: spec.relation,
      status: matched ? "matched" : "empty",
      gap_class: matched ? null : "empty_in_corpus",
      note: matched ? null : spec.empty_note,
      count: total,
      total_count: total,
      items,
      as_of: asOf,
      universe: spec.id === "contracts" ? "open" : "linked",
      warrant_summary: summarizeCategoryWarrants(items),
      method: "agency_browse_snapshot_v1",
      view_all_href: matched
        ? agencyCategoryBrowseHref(identity.canonical_id, spec.id, { asOf, mode: spec.id === "contracts" ? "open" : "" })
        : "",
      archive_href: spec.id === "contracts"
        ? agencyCategoryArchiveHref(identity.canonical_id, spec.id)
        : "",
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
 * Convert category read-model totals into the shared typed edge inventory.
 * An un-ingested category is unknown, not zero; hrefs still point to the
 * existing scoped destination so a reader can inspect the bounded surface.
 */
export function buildAgencyEdgeSummary(viewOrCategories, options = {}) {
  const categories = Array.isArray(viewOrCategories)
    ? viewOrCategories
    : (viewOrCategories?.categories || []);
  const sourceId = options.source_id
    ?? viewOrCategories?.canonical_id
    ?? viewOrCategories?.id
    ?? null;
  const sourceKind = options.source_kind || "agency";
  return normalizeEdgeSummaryRecords(categories.map((category) => {
    const state = category.status === "matched"
      ? "matched"
      : category.status === "empty"
        ? "empty"
        : "unknown";
    const count = state === "unknown"
      ? null
      : (Number.isInteger(Number(category.count)) && Number(category.count) >= 0 ? Number(category.count) : null);
    const href = category.view_all_href
      || (category.browse_facet && sourceId
        ? agencyCategoryBrowseHref(sourceId, category.id, {
          mode: category.universe === "open" ? "open" : "",
          asOf: category.as_of || "",
        })
        : null);
    const targetKind = category.id === "vendors"
      ? "vendor"
      : category.id === "obligations"
        ? "mandate"
        : category.id === "staffing"
          ? "exam"
          : category.id === "meetings"
            ? "meeting"
            : category.id === "rules" ? "rule" : "contract";
    return {
      source_kind: sourceKind,
      source_id: sourceId,
      edge_type: category.relation || null,
      label: `${category.label || targetKind}: ${edgeRelationLabel(category.relation || "related_records")}`,
      target_kind: targetKind,
      target_name: category.label || null,
      count,
      state,
      href,
      scope: {
        facet: category.browse_facet || null,
        universe: category.universe || null,
        mode: category.universe === "open" ? "open" : null,
        entity_ref: sourceId ? `agency:id:${sourceId}` : null,
      },
      as_of: category.as_of || null,
    };
  }), { source_kind: sourceKind, source_id: sourceId });
}

/**
 * Build one agency constellation view from committed materializations.
 * @param {string} idOrName
 * @param {{ intelligence?: object, certification?: object, obligations?: object, staffing_exams?: object|Array, staffing_exam_numbers?: Set|Array, cross_spine_gate?: object, generated_at?: string }} sources
 */
export function buildAgencyConstellationView(idOrName, sources = {}) {
  const identity = reconcileAgencyIdentity(idOrName, sources.publisher_agency_rows || []);
  if (!identity?.canonical_id) return null;

  const ref = `agency:id:${identity.canonical_id}`;
  const intelligence = sources.intelligence?.by_ref?.[ref]
    || sources.intelligence?.by_subject_ref?.[ref]
    || (sources.intelligence?.root?.ref === ref ? sources.intelligence : null)
    || null;
  const certification = sources.certification || null;
  const obligations = sources.obligations || null;
  const documentableExamNumbers = documentableExamNumberSet(sources);

  let conformanceView = null;
  const committed = sources.process_conformance?.by_agency?.[identity.canonical_id] || null;
  if (committed && obligations) {
    const live = buildAgencyConformanceView(identity.canonical_id, {
      obligationsLookup: obligations,
      rulesDomain: sources.rules_domain || null,
      meetingsDomain: sources.meetings_domain || null,
      entityIntelligence: sources.intelligence || null,
      limit: 500,
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
      limit: 500,
    });
  }

  const categories = AGENCY_CONSTELLATION_CATEGORIES.map((spec) =>
    categoryFromDomain(
      spec,
      intelligence,
      identity,
      certification,
      obligations,
      conformanceView,
      documentableExamNumbers,
      sources.vendor_rollups || null,
      {
        money_open: sources.money_open,
        meetings_domain: sources.meetings_domain,
      },
    ));
  const edgeSummary = buildAgencyEdgeSummary({ categories, canonical_id: identity.canonical_id });

  const matched = categories.filter((category) => category.status === "matched").length;
  const claims = categories.flatMap((category) =>
    (category.items || []).map((item) => item.claim).filter(Boolean));

  // Mandates → Rules bridge: rulemaking duties joined to Rules-lens filings
  // via agency identity; per-mandate observed filings when topic join hits.
  // Co-located graph neighbors (agency-scoped Rules/Meetings/Contracts) always
  // stamp onto mandate rows even when observed_links is 0 (mand-graph-01).
  const rulesCategory = categories.find((category) => category.id === "rules") || null;
  const meetingsCategory = categories.find((category) => category.id === "meetings") || null;
  const contractsCategory = categories.find((category) => category.id === "contracts") || null;
  const rulesBrowseHref = rulesCategory?.view_all_href
    || agencyCategoryBrowseHref(identity.canonical_id, "rules");
  const meetingsBrowseHref = meetingsCategory?.view_all_href
    || agencyCategoryBrowseHref(identity.canonical_id, "meetings");
  const contractsBrowseHref = contractsCategory?.view_all_href
    || agencyCategoryBrowseHref(identity.canonical_id, "contracts");
  const mandateGraphNeighbors = {
    rules_browse_href: rulesBrowseHref,
    meetings_browse_href: meetingsBrowseHref,
    contracts_browse_href: contractsBrowseHref,
  };
  if (conformanceView && !conformanceView.graph_neighbors) {
    conformanceView.graph_neighbors = mandateGraphNeighbors;
  }
  const mandatesRules = buildMandateRulesBridgeView(identity.canonical_id, {
    obligationsLookup: obligations,
    rulesItems: rulesCategory?.items || [],
    rulesCount: rulesCategory?.count || 0,
    rulesBrowseHref,
    meetingsBrowseHref,
    contractsBrowseHref,
    rulesFollowHref: agencyRulesFollowHref(identity.canonical_id),
    conformanceItems: conformanceView?.items || [],
    limit: 12,
  });

  const mandatesMeetings = buildMandateMeetingsView(identity.canonical_id, {
    obligationsLookup: obligations,
    meetingsDomain: sources.meetings_domain || null,
    generatedAt: sources.meetings_domain?.generated_at
      || sources.generated_at
      || sources.process_conformance?.generated_at,
    crossSpineGate: sources.cross_spine_gate || null,
    perMandateLimit: 3,
  });

  const mandatesLandUse = buildMandateLandUseView(identity.canonical_id, {
    obligationsLookup: obligations,
    entityIntelligence: sources.intelligence || null,
    landProjects: sources.land_projects || null,
    crossSpineGate: sources.cross_spine_gate || null,
    generatedAt: sources.land_projects?.materialized_at
      || sources.intelligence?.generated_at
      || sources.generated_at,
    perMandateLimit: 3,
  });

  // Mandates → Required Reports receipt: report duties with City Record
  // filing receipt when process-conformance observes a matching publication.
  const mandatesReports = buildMandateReportsReceiptView(identity.canonical_id, {
    obligationsLookup: obligations,
    conformanceItems: conformanceView?.items || [],
    rulesBrowseHref,
    meetingsBrowseHref,
    contractsBrowseHref,
    limit: 12,
  });

  // Mandates prediction-alerts: expected public-record events timed from
  // deadline + recurrence (earlier-stage watch path for free-watch digests).
  const mandatesPredictions = buildAgencyMandatePredictionsView(identity.canonical_id, {
    obligationsLookup: obligations,
    conformanceItems: conformanceView?.items || [],
    rulesBrowseHref,
    meetingsBrowseHref,
    contractsBrowseHref,
    limit: 16,
    includeCadenceOnly: true,
  });

  // Mandates → procurement records → contracts. The bridge accepts only an
  // agency block + procurement duty + subject overlap + exact PIN/EPIN path.
  const mandatesContracts = buildMandateContractsBridgeView(identity.canonical_id, {
    obligationsLookup: obligations,
    intelligenceDossier: intelligence,
    procurementAwards: sources.procurement_awards || sources.procurementAwards || null,
    crossSpineGate: sources.cross_spine_gate || null,
    contractsBrowseHref,
    contractsFollowHref: contractsCategory?.follow_href,
    limit: 16,
  });

  const allClaims = [
    ...claims,
    ...(mandatesMeetings?.edges || []).map((edge) => edge.claim).filter(Boolean),
    ...(mandatesContracts?.edges || []).map((edge) => edge.claim).filter(Boolean),
    ...(mandatesLandUse?.edges || []).map((edge) => edge.claim).filter(Boolean),
    ...(mandatesLandUse?.procedure_paths || []).map((path) => path.claim).filter(Boolean),
  ];

  return {
    schema: AGENCY_CONSTELLATION_SCHEMA,
    kind: "agency-constellation",
    id: identity.canonical_id,
    path: agencyPath(identity.canonical_id),
    subject_ref: ref,
    display_name: identity.canonical_name,
    canonical_id: identity.canonical_id,
    categories,
    edge_summary: edgeSummary,
    claims: allClaims,
    mandates_conformance: conformanceView,
    mandates_rules: mandatesRules,
    ...(mandatesMeetings?.status === "matched"
      ? { mandates_meetings: mandatesMeetings }
      : {}),
    ...(mandatesLandUse?.status === "matched" || mandatesLandUse?.shadow_edges?.length
      ? { mandates_land_use: mandatesLandUse }
      : {}),
    mandates_reports: mandatesReports,
    mandates_predictions: mandatesPredictions,
    ...(mandatesContracts?.status === "matched" ? { mandates_contracts: mandatesContracts } : {}),
    summary: {
      matched_categories: matched,
      category_count: categories.length,
      claim_count: allClaims.length,
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
    scope_href: contractsCategory?.view_all_href
      || agencyCategoryBrowseHref(identity.canonical_id, "contracts"),
    mandates_href: agencyMandatesConformancePath(identity.canonical_id),
    mandates_rules_href: agencyMandateRulesPath(identity.canonical_id),
    ...(mandatesMeetings?.status === "matched"
      ? { mandates_meetings_href: agencyMandateMeetingsPath(identity.canonical_id) }
      : {}),
    ...(mandatesLandUse?.status === "matched"
      ? { mandates_land_use_href: agencyMandateLandUsePath(identity.canonical_id) }
      : {}),
    mandates_reports_href: agencyMandateReportsPath(identity.canonical_id),
    mandates_predictions_href: agencyMandatePredictionsPath(identity.canonical_id),
    ...(mandatesContracts?.status === "matched"
      ? { mandates_contracts_href: agencyMandateContractsPath(identity.canonical_id) }
      : {}),
    interactive_profile_href: `/#agency/${encodeURIComponent(identity.canonical_name)}`,
    provenance: {
      intelligence_generated_at: sources.intelligence?.generated_at || null,
      certification_generated_at: certification?.generated_at || null,
      obligations_generated_at: obligations?.generated_at || null,
      process_conformance_generated_at: sources.process_conformance?.generated_at || null,
      vendor_rollup_as_of: sources.vendor_rollups?.as_of || null,
      methods: [
        "agency_canonical_v1",
        "publisher_certification_record_v1",
        AGENCY_OBLIGATIONS_METHOD,
        PROCESS_CONFORMANCE_METHOD,
        MANDATE_RULES_BRIDGE_METHOD,
        ...(mandatesMeetings?.status === "matched" ? [MANDATE_MEETINGS_METHOD] : []),
        ...(mandatesLandUse?.status === "matched" ? [MANDATE_LAND_USE_METHOD] : []),
        MANDATE_REPORTS_RECEIPT_METHOD,
        MANDATE_PREDICTION_METHOD,
        ...(mandatesContracts?.status === "matched" ? [MANDATE_CONTRACTS_METHOD] : []),
        AGENCY_CONSTELLATION_METHOD,
        "graph_edge_provenance_v1",
      ],
      note: null,
    },
  };
}
