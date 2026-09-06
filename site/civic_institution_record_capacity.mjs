/**
 * Reader-facing institution capacity for one public record.
 *
 * A directory tells a reader what an institution *is*. A record has to tell
 * them what it *did there*: the same body can be the applicant on one project,
 * the contractor on one contract, and the contracting agency on another. This
 * module is the projection that says which, in plain language, wherever the
 * reader meets the record.
 *
 * It is a projection, not a second role system. Every capacity here is read
 * from an already-accepted typed role edge
 * (site/civic_institution_development_roles.mjs). Nothing is inferred from a
 * name, a publisher classification, a category count, or co-occurrence, and an
 * institution with no accepted edge for a capacity gets no capacity line.
 *
 * Two boundaries are load-bearing:
 *
 * - Contracts received are never counted as procurements issued. `contractor`
 *   and `issuer` are different capacities read from different source fields,
 *   and this module never rolls one into the other's count.
 * - Applicant status is never read as approval authority. Being the applicant
 *   says who asked; it says nothing about who decides. Procedure-specific
 *   decision authority stays with the land authority panel
 *   (site/land_authority_summary.mjs), which this module never restates.
 */

import { reviewedInstitutionName } from "./civic_institution_party_spellings.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";

export const INSTITUTION_RECORD_CAPACITY_SCHEMA = "cityscroll.civic_institution_record_capacity.v1";

const capacityText = (value, max = 300) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

/**
 * Reader-facing capacities, one per accepted role relation.
 *
 * `browse_relation` is the source-field relation the Browse surface already
 * understands, so a preview and its Browse-all destination scope on the same
 * predicate. `label` names the capacity; `sentence` states it about a named
 * institution without implying any power the source does not establish.
 *
 * `scopes_records` says whether the capacity may head a counted group on a
 * profile. `contracting_agency` deliberately does not: the reviewed party
 * mapping only sees the contracts whose contractor is itself a reviewed
 * institution, while the contracting agency's own Browse scope is every
 * contract it published. A group counted from the first and linked to the
 * second would show a reader two different numbers for one label, so this
 * capacity stays a per-record statement — which is where a reader needs it
 * anyway, to see who the counterparty on that record is.
 */
export const INSTITUTION_RECORD_CAPACITIES = Object.freeze({
  applicant_on: Object.freeze({
    capacity_id: "applicant",
    relation_id: "applicant_on",
    record_kind: "project",
    label: "Applicant",
    group_id: "projects",
    group_label: "Projects it applied for",
    browse_facet: "zoning",
    browse_relation: "applicant_agency",
    scopes_records: true,
    sentence: (name) => `${name} is the applicant named on this project.`,
    boundary: "Applying is not deciding. The body that approves this application is named in the project's own land-use authority panel.",
  }),
  contractor_on: Object.freeze({
    capacity_id: "contractor",
    relation_id: "contractor_on",
    record_kind: "procurement",
    label: "Contractor",
    group_id: "contracts_received",
    group_label: "Contracts it received",
    browse_facet: "contracts",
    browse_relation: "named_vendor",
    scopes_records: true,
    sentence: (name) => `${name} is the contractor on this contract.`,
    boundary: "These are contracts this institution received. They are not procurements it issued, and they are counted separately.",
  }),
  contracted_by: Object.freeze({
    capacity_id: "contracting_agency",
    relation_id: "contracted_by",
    record_kind: "procurement",
    label: "Contracting agency",
    group_id: "contracts_issued",
    group_label: "Contracts it awarded",
    browse_facet: "contracts",
    browse_relation: "published_by_agency",
    scopes_records: false,
    sentence: (name) => `${name} is the contracting agency on this contract.`,
    boundary: "This institution is the contracting agency here. The contractor is a separate institution named on the same record.",
  }),
});

/**
 * The inverse orientations a profile sees for the same underlying record.
 *
 * `contracts_with` is what `contracted_by` becomes on the contractor's own
 * profile. It still describes the same contract, so it keeps the contractor
 * capacity rather than silently reading as an issuing role.
 */
const INVERSE_CAPACITY_RELATIONS = Object.freeze({
  contracts_with: "contractor_on",
  has_applicant: "applicant_on",
  has_contractor: "contractor_on",
});

/** Capacities that must never be summed together into one figure. */
export const INSTITUTION_CAPACITY_SEPARATION = Object.freeze([
  Object.freeze({
    left: "contractor",
    right: "contracting_agency",
    reason: "A contract received is not a procurement issued.",
  }),
  Object.freeze({
    left: "applicant",
    right: "contracting_agency",
    reason: "Applying for a public action is not deciding or awarding one.",
  }),
]);

export function capacityForRelation(relationId) {
  const id = capacityText(relationId, 80);
  return INSTITUTION_RECORD_CAPACITIES[id]
    || INSTITUTION_RECORD_CAPACITIES[INVERSE_CAPACITY_RELATIONS[id]]
    || null;
}

/** The Browse predicate a capacity scopes on, or "" when it has none. */
export function capacityBrowseRelation(capacityId) {
  const id = capacityText(capacityId, 80);
  return Object.values(INSTITUTION_RECORD_CAPACITIES)
    .find((entry) => entry.capacity_id === id)?.browse_relation || "";
}

/**
 * A reader-facing name for one institution. The reviewed name wins, then the
 * general alias table, and a route slug is only ever the last resort.
 */
export function institutionDisplayName(canonicalId) {
  const id = capacityText(canonicalId, 120);
  if (!id) return "";
  return reviewedInstitutionName(id) || resolveAgencyIdentity(id).canonical_name || id;
}

function capacityRecordOf(edge) {
  const record = edge?.record;
  if (record && capacityText(record.record_ref, 320)) return record;
  return null;
}

/**
 * Capacity rows for one institution, in the order a reader meets them.
 *
 * Only accepted, record-bearing edges produce a row: a held, unknown, or
 * unresolved edge is an evidence gap, and a gap must not read as a capacity.
 * `contracted_by` edges oriented away from this institution are dropped, so a
 * profile never claims the other party's capacity as its own.
 */
export function institutionRecordCapacities(canonicalId, roleBag = {}, { displayName = "" } = {}) {
  const id = capacityText(canonicalId, 120);
  const name = capacityText(displayName, 240) || institutionDisplayName(id);
  const edges = Array.isArray(roleBag?.accepted) ? roleBag.accepted : [];
  const rows = [];
  const seen = new Set();
  for (const edge of edges) {
    if (edge?.status !== "accepted") continue;
    if (capacityText(edge.subject_canonical_id, 120) !== id) continue;
    const capacity = capacityForRelation(edge.relation_id);
    const record = capacityRecordOf(edge);
    if (!capacity || !record) continue;
    const key = `${capacity.capacity_id}|${record.record_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const counterpartyId = capacity.capacity_id === "contractor"
      ? capacityText(record.contracting_agency_id, 120) || null
      : capacity.capacity_id === "contracting_agency"
        ? capacityText(record.contractor_id, 120) || null
        : null;
    rows.push(Object.freeze({
      schema: INSTITUTION_RECORD_CAPACITY_SCHEMA,
      capacity_id: capacity.capacity_id,
      relation_id: capacityText(edge.relation_id, 80),
      group_id: capacity.group_id,
      group_label: capacity.group_label,
      label: capacity.label,
      sentence: capacity.sentence(name),
      boundary: capacity.boundary,
      record_kind: capacity.record_kind,
      record_ref: capacityText(record.record_ref, 320),
      record_id: capacityText(record.record_id, 160),
      record_label: capacityText(record.label, 240) || capacityText(record.record_id, 160),
      when: capacityText(record.when, 40) || null,
      // What the source states about timing, in the source's own terms. A
      // record with neither a date nor a stage says so by carrying neither.
      when_label: capacityText(record.when, 40) || capacityText(record.milestone, 120) || null,
      amount: Number.isFinite(Number(record.amount)) ? Number(record.amount) : null,
      href: capacityText(record.href, 500) || null,
      // The other institution named on the same record, in its own capacity.
      // Naming it is what stops a reader reading "contractor" as "the body that
      // decided this", and gives them the route to the one that did.
      counterparty_id: counterpartyId,
      counterparty_name: counterpartyId ? institutionDisplayName(counterpartyId) : null,
      counterparty_label: counterpartyId
        ? (capacity.capacity_id === "contractor" ? "contracting agency" : "contractor")
        : null,
      browse_facet: capacity.browse_facet,
      browse_relation: capacity.browse_relation,
      scopes_records: capacity.scopes_records === true,
      source_system: capacityText(edge.provenance?.source_system, 120) || null,
      source_field: capacityText(edge.provenance?.source_field, 120) || null,
      source_value: capacityText(edge.provenance?.source_value, 500) || null,
      source_receipt: capacityText(edge.provenance?.source_receipt || edge.source_receipt, 320) || null,
      as_of: capacityText(edge.as_of, 40) || null,
    }));
  }
  return Object.freeze(rows);
}

/**
 * Group capacity rows for display, newest record first inside each group.
 *
 * Groups are per capacity and never merged, so a count a reader sees is a
 * count of one capacity. An empty group is omitted rather than rendered as a
 * zero: an absent capacity is unasserted, not a measured nil.
 */
export function institutionCapacityGroups(rows = []) {
  const order = Object.values(INSTITUTION_RECORD_CAPACITIES)
    .filter((entry) => entry.scopes_records)
    .map((entry) => entry.group_id);
  const byGroup = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!byGroup.has(row.group_id)) byGroup.set(row.group_id, []);
    byGroup.get(row.group_id).push(row);
  }
  const groups = [];
  for (const groupId of order) {
    const items = byGroup.get(groupId);
    if (!items?.length) continue;
    const first = items[0];
    groups.push(Object.freeze({
      group_id: groupId,
      label: first.group_label,
      capacity_id: first.capacity_id,
      capacity_label: first.label,
      boundary: first.boundary,
      browse_facet: first.browse_facet,
      browse_relation: first.browse_relation,
      count: items.length,
      // Largest committed public money first where the source states an
      // amount, then most recent. A reader scanning what an institution
      // received is served by magnitude before chronology, and the order never
      // depends on a record identifier.
      items: Object.freeze([...items].sort((left, right) => (
        (right.amount ?? -1) - (left.amount ?? -1)
        || String(right.when || "").localeCompare(String(left.when || ""))
        || String(left.record_label).localeCompare(String(right.record_label))
      ))),
    }));
  }
  return Object.freeze(groups);
}

/**
 * Capacity lookup for a record row a reader is scanning.
 *
 * A row may address its record by more than one key — a City Record notice ref
 * on one surface, the procurement id on another — so every candidate is tried
 * and the first exact match wins. A row with no accepted edge gets no capacity
 * label: it still renders, it simply makes no claim about what the institution
 * did there.
 */
export function capacityForRecordRef(rows = [], ...recordRefs) {
  const candidates = recordRefs.flat().map((ref) => capacityText(ref, 320)).filter(Boolean);
  if (!candidates.length) return null;
  const list = Array.isArray(rows) ? rows : [];
  for (const ref of candidates) {
    const match = list.find((row) => row.record_ref === ref);
    if (match) return match;
  }
  return null;
}

/**
 * The compact per-record capacity index a record list needs.
 *
 * Only what a row renders, so a committed profile artifact does not carry a
 * second copy of every role edge's provenance.
 */
export function institutionRecordCapacityIndex(rows = []) {
  return Object.freeze((Array.isArray(rows) ? rows : []).map((row) => Object.freeze({
    record_ref: row.record_ref,
    capacity_id: row.capacity_id,
    relation_id: row.relation_id,
    label: row.label,
    sentence: row.sentence,
  })));
}

/**
 * The reader-facing capacity view for one institution profile.
 *
 * Each group's preview rows, count, and Browse-all destination come from one
 * capacity query run against the payload that destination itself reads
 * (`browseContractFor`), so the three can never disagree. When that query
 * reports which records it matched, the preview is narrowed to them: a record
 * this profile resolved from a source the destination does not carry is a
 * record the reader could not find by following the link, and listing it under
 * that link would be the inconsistency this section exists to remove.
 *
 * A capacity with no payload available is reported as unavailable rather than
 * as zero: a source that has not been materialized is not a finding that the
 * institution did nothing.
 */
export function buildInstitutionRecordCapacityView({
  canonicalId,
  displayName = "",
  roleBag = {},
  browseContractFor = null,
  previewLimit = 8,
} = {}) {
  const rows = institutionRecordCapacities(canonicalId, roleBag, { displayName });
  const groups = institutionCapacityGroups(rows);
  if (!groups.length) return null;
  const projected = [];
  for (const group of groups) {
    const contract = typeof browseContractFor === "function"
      ? browseContractFor(group, { limit: previewLimit })
      : null;
    const scopedRefs = contract?.record_refs instanceof Set ? contract.record_refs : null;
    const inScope = scopedRefs
      ? group.items.filter((item) => scopedRefs.has(item.record_ref))
      : group.items;
    const items = inScope.slice(0, previewLimit);
    projected.push(Object.freeze({
      ...group,
      items,
      shown_count: items.length,
      // The Browse total is the authority whenever the same query has been run
      // against the destination's own payload. Without it the group reports
      // only what this profile itself resolved, and says so.
      count: inScope.length,
      total_count: Number.isFinite(contract?.total) ? contract.total : inScope.length,
      count_basis: Number.isFinite(contract?.total) ? "browse_scope_total" : "profile_resolved_roles",
      view_all_href: contract?.href || null,
      universe: contract?.universe || null,
      as_of: contract?.asOf || null,
      availability: contract ? "matched" : "scope_payload_unavailable",
    }));
  }
  return Object.freeze({
    schema: INSTITUTION_RECORD_CAPACITY_SCHEMA,
    canonical_id: canonicalId,
    display_name: displayName || canonicalId,
    groups: Object.freeze(projected),
    separation: INSTITUTION_CAPACITY_SEPARATION,
  });
}
