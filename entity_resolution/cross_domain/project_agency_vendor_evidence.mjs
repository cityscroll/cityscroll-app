/**
 * Reviewed production evidence for a strict project × agency × vendor scope.
 *
 * Candidate facts remain private to this materializer until all three typed
 * edges resolve against committed publisher records and the review state is
 * accepted. Public totals, reverse pivots, and Browse row refs are derived
 * only from the admitted bundle.
 */

import {
  resolveAgencySubject,
  resolveVendorSubject,
} from "./object_links.mjs";

export const PROJECT_AGENCY_VENDOR_EVIDENCE_VERSION = "project_agency_vendor_evidence_v1";
export const REVIEWED_PUBLISHER_ROLE_METHOD = "reviewed_publisher_role_v1";
export const REVIEWED_PUBLISHER_ROLE_METHOD_VERSION = "1.0.0";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function candidateFailureReasons(candidate, propertyRows, crossDomainLinks) {
  const reasons = [];
  const subjectRef = clean(candidate?.subject_ref);
  const requestId = subjectRef.match(/^notice:([A-Za-z0-9_-]+)$/)?.[1] || "";
  const sourceRecord = candidate?.source_record || {};
  const propertyRow = propertyRows.find((row) => clean(row?.request_id) === requestId);
  const agency = resolveAgencySubject(candidate?.agency?.name);
  const vendor = resolveVendorSubject(candidate?.vendor?.name);
  const projectRef = clean(candidate?.project?.ref);
  const projectBbl = clean(candidate?.project?.bbl);

  if (clean(candidate?.review_state) !== "accepted") reasons.push("review_state_not_accepted");
  if (!requestId || !propertyRow) reasons.push("property_source_record_missing");
  if (!sourceRecord.source_system || !sourceRecord.source_record_id || !sourceRecord.source_url) {
    reasons.push("source_receipt_incomplete");
  }
  if (propertyRow && clean(sourceRecord.source_record_id) !== `city_record:${requestId}`) {
    reasons.push("source_record_id_mismatch");
  }
  if (!agency || agency.ref !== clean(candidate?.agency?.ref)) reasons.push("agency_identity_unresolved");
  if (propertyRow && clean(propertyRow.agency_name) !== clean(candidate?.agency?.name)) {
    reasons.push("agency_source_value_mismatch");
  }
  if (!vendor || vendor.ref !== clean(candidate?.vendor?.ref)) reasons.push("vendor_identity_unresolved");
  if (!clean(candidate?.vendor?.role) || !(candidate?.vendor?.source_fields || []).length) {
    reasons.push("vendor_role_evidence_incomplete");
  }
  if (!/^project:[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(projectRef) || !/^\d{10}$/.test(projectBbl)) {
    reasons.push("project_identity_incomplete");
  }

  const agencyEdge = crossDomainLinks.find((edge) => (
    edge?.type === "published_by_agency"
      && edge?.from === subjectRef
      && edge?.to === agency?.ref
      && edge?.confidence === "strong"
  ));
  if (!agencyEdge) reasons.push("standable_agency_edge_missing");

  const projectEdge = crossDomainLinks.find((edge) => (
    edge?.type === "parcel_links_project"
      && edge?.from === subjectRef
      && edge?.to === projectRef
      && edge?.bbl === projectBbl
      && edge?.confidence === "strong"
      && edge?.method === "exact_bbl_v1"
  ));
  if (!projectEdge) reasons.push("standable_project_edge_missing");

  return {
    reasons: [...new Set(reasons)],
    requestId,
    propertyRow,
    agency,
    vendor,
    agencyEdge,
    projectEdge,
  };
}

function reviewedEdge(edge, candidate) {
  return {
    ...edge,
    provenance: {
      ...edge.provenance,
      source_url: edge.provenance?.source_url || candidate.source_record.source_url,
    },
    review_state: "accepted",
    reviewed_at: candidate.reviewed_at,
    relevant_time: candidate.relevant_time,
  };
}

function vendorEdge(candidate, vendor) {
  const source = candidate.source_record;
  return {
    type: "named_developer",
    from: candidate.subject_ref,
    to: vendor.ref,
    domain: "property",
    confidence: "strong",
    method: REVIEWED_PUBLISHER_ROLE_METHOD,
    method_version: REVIEWED_PUBLISHER_ROLE_METHOD_VERSION,
    review_state: "accepted",
    reviewed_at: candidate.reviewed_at,
    relevant_time: candidate.relevant_time,
    provenance: {
      source_system: source.source_system,
      source_record_id: source.source_record_id,
      source_fields: [...new Set(candidate.vendor.source_fields.map(clean).filter(Boolean))].sort(),
      basis: candidate.vendor.basis,
      observed_at: candidate.relevant_time,
      source_url: source.source_url,
      input_value: candidate.vendor.name,
      role: candidate.vendor.role,
      evidence_summary: candidate.vendor.evidence_summary,
    },
    layer: PROJECT_AGENCY_VENDOR_EVIDENCE_VERSION,
  };
}

function browseHref(refs) {
  const facet = encodeURIComponent(JSON.stringify({ entity_refs_all: refs }));
  return `/browse/property/?facet=${facet}`;
}

/**
 * Materialize reviewed candidates against the current production read models.
 */
export function buildProjectAgencyVendorEvidence({
  registry = {},
  propertyRows = [],
  propertyCrossDomain = {},
} = {}) {
  const bundles = [];
  const excluded = [];
  const crossDomainLinks = Array.isArray(propertyCrossDomain?.links)
    ? propertyCrossDomain.links
    : [];

  for (const candidate of registry?.candidates || []) {
    const resolved = candidateFailureReasons(candidate, propertyRows, crossDomainLinks);
    if (resolved.reasons.length) {
      excluded.push({
        evidence_id: clean(candidate?.evidence_id),
        subject_ref: clean(candidate?.subject_ref) || null,
        review_state: clean(candidate?.review_state) || "unknown",
        reasons: resolved.reasons,
      });
      continue;
    }

    const refs = [
      clean(candidate.project.ref),
      resolved.agency.ref,
      resolved.vendor.ref,
    ];
    const edges = [
      reviewedEdge(resolved.projectEdge, candidate),
      reviewedEdge(resolved.agencyEdge, candidate),
      vendorEdge(candidate, resolved.vendor),
    ];
    bundles.push({
      evidence_id: clean(candidate.evidence_id),
      subject_ref: clean(candidate.subject_ref),
      label: clean(resolved.propertyRow.short_title) || resolved.requestId,
      refs,
      edges,
      browse_scope: {
        lens: "property",
        entity_refs_all: refs,
        strict_all_ref: true,
        result_count: 1,
        result_subject_refs: [clean(candidate.subject_ref)],
        href: browseHref(refs),
      },
    });
  }

  const provisional = excluded.filter((row) => row.review_state !== "accepted").length;
  return {
    schema_version: 1,
    policy_version: PROJECT_AGENCY_VENDOR_EVIDENCE_VERSION,
    public_bundle_count: bundles.length,
    bundles,
    receipt: {
      candidate_count: (registry?.candidates || []).length,
      admitted_count: bundles.length,
      provisional_candidates_excluded: provisional,
      invalid_accepted_candidates_excluded: excluded.length - provisional,
      excluded,
      publication_rule: "accepted review state plus standable project, agency, and vendor edges",
    },
  };
}

/** Add accepted bundle refs to public reverse pivots without exposing candidates. */
export function mergeProjectAgencyVendorSubjectIndex(
  bySubjectRef = {},
  evidence = {},
  previousEvidence = {},
) {
  const merged = Object.fromEntries(Object.entries(bySubjectRef).map(([ref, links]) => [
    ref,
    Array.isArray(links) ? [...links] : [],
  ]));
  for (const bundle of previousEvidence?.bundles || []) {
    const managed = new Set(bundle.edges.map((edge) => (
      [edge.to, edge.type, edge.confidence].join("|")
    )));
    merged[bundle.subject_ref] = (merged[bundle.subject_ref] || []).filter((entry) => !managed.has(
      [entry.entity_ref, entry.relation, entry.confidence].join("|"),
    ));
    if (!merged[bundle.subject_ref].length) delete merged[bundle.subject_ref];
  }
  for (const bundle of evidence?.bundles || []) {
    const current = merged[bundle.subject_ref] || [];
    const additions = bundle.edges.map((edge) => ({
      entity_ref: edge.to,
      relation: edge.type,
      confidence: edge.confidence,
    }));
    const byKey = new Map([...current, ...additions].map((entry) => [
      [entry.entity_ref, entry.relation, entry.confidence].join("|"),
      entry,
    ]));
    merged[bundle.subject_ref] = [...byKey.values()].sort((a, b) => (
      `${a.entity_ref}|${a.relation}`.localeCompare(`${b.entity_ref}|${b.relation}`)
    ));
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

/** Stamp only accepted bundle refs on their real Browse source rows. */
export function attachProjectAgencyVendorBrowseRefs(
  propertyRows = [],
  evidence = {},
  previousEvidence = {},
) {
  const refsByRequestId = new Map((evidence?.bundles || []).map((bundle) => [
    bundle.subject_ref.replace(/^notice:/, ""),
    bundle.refs,
  ]));
  const previousRefsByRequestId = new Map((previousEvidence?.bundles || []).map((bundle) => [
    bundle.subject_ref.replace(/^notice:/, ""),
    new Set(bundle.refs),
  ]));
  return propertyRows.map((row) => {
    const refs = refsByRequestId.get(clean(row?.request_id));
    const previousRefs = previousRefsByRequestId.get(clean(row?.request_id)) || new Set();
    const retained = (row.entity_refs_all || []).filter((ref) => !previousRefs.has(ref));
    if (!refs && retained.length === (row.entity_refs_all || []).length) return row;
    if (!refs && !retained.length) {
      const { entity_refs_all: _managedRefs, ...withoutManagedRefs } = row;
      return withoutManagedRefs;
    }
    return {
      ...row,
      entity_refs_all: [...new Set([...retained, ...(refs || [])])],
    };
  });
}
