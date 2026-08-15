/** Materialized People + organizations read model.
 *
 * This is deliberately a read-only join. Display names never create person
 * identities: person rows carry an exact source person_id, and notice-only
 * hires keep their person relation unknown when the source has no such key.
 */

import { entityHref, entityRouteRef } from "./entity_pivot.mjs";
import { communityBoardPageHref } from "./community_board_links.mjs";
import { communityBoardPlaceHref } from "./community_board_constellation.mjs";

export const PEOPLE_ORGANIZATION_ROW_KINDS = Object.freeze([
  "official",
  "exact-person-appointment",
  "notice-only-hire",
  "agency",
  "vendor",
  "committee",
  "community-board",
]);

export const RELATION_STATES = Object.freeze(["published", "empty", "unknown"]);

const DEFAULT_BOARD_RELATIONS = Object.freeze([
  { type: "has_member", label: "Members", state: "unknown" },
  { type: "member_of", label: "Board roles", state: "unknown" },
  { type: "hosts_meeting", label: "Hosted meetings", state: "unknown" },
  { type: "issues_recommendation", label: "Recommendations", state: "unknown" },
]);

const clean = (value, max = 320) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const state = (value, fallback = "unknown") => RELATION_STATES.includes(value) ? value : fallback;

export function relationStateLabel(value) {
  const normalized = state(value);
  return normalized[0].toUpperCase() + normalized.slice(1);
}

function personRef(personId) {
  const id = clean(personId, 80).replace(/^official:/, "");
  return id ? `entity:official:${id}` : null;
}

function personHref(personId) {
  const id = clean(personId, 80).replace(/^official:/, "");
  return id ? `/officials/${encodeURIComponent(id)}/` : null;
}

function sourceDate(...values) {
  return values.map((value) => clean(value, 40)).find(Boolean) || null;
}

function officialRows(people = {}) {
  return Object.values(people.by_person_id || {})
    .filter((person) => clean(person?.person_id, 80) && clean(person?.person_name))
    .map((person) => {
      const id = clean(person.person_id, 80);
      return {
        kind: "official",
        id: `official:${id}`,
        label: clean(person.person_name),
        href: personHref(id),
        entity_ref: personRef(id),
        person_id: id,
        relation_state: "published",
        detail: "Official profile",
        search_text: `${person.person_name} official council member ${person.district || ""}`,
      };
    });
}

function exactPersonAppointmentRows(people = {}) {
  const rows = [];
  for (const person of Object.values(people.by_person_id || {})) {
    const personId = clean(person?.person_id, 80);
    const personName = clean(person?.person_name);
    if (!personId || !personName) continue;
    for (const term of Array.isArray(person.terms) ? person.terms : []) {
      const officeId = clean(term?.office_id, 80);
      const start = clean(term?.term_start, 40);
      if (!officeId || !start) continue;
      rows.push({
        kind: "exact-person-appointment",
        id: `appointment:${personId}:${officeId}:${start}`,
        label: personName,
        href: personHref(personId),
        entity_ref: personRef(personId),
        person_id: personId,
        relation_state: "published",
        detail: `Official term${term.district ? ` · District ${term.district}` : ""}`,
        date: sourceDate(term.term_start, term.term_end),
        search_text: `${personName} appointment official term ${term.office_id} ${term.district || ""}`,
      });
    }
  }
  return rows;
}

function parseHireNotice(notice = {}) {
  const description = clean(notice.additional_description_1, 1_000);
  const field = (name) => description.match(new RegExp(`${name}:\\s*([^;]+)`, "i"))?.[1]?.trim() || null;
  const employee = field("Employee Name");
  const titleCode = field("Title Code");
  const effectiveDate = field("Effective Date");
  return { employee, titleCode, effectiveDate };
}

function noticeOnlyHireRows(hires = {}) {
  return (Array.isArray(hires.notices) ? hires.notices : [])
    .map((notice) => {
      const requestId = clean(notice?.request_id, 80);
      const parsed = parseHireNotice(notice);
      if (!requestId || !parsed.employee) return null;
      return {
        kind: "notice-only-hire",
        id: `hire:${requestId}`,
        label: parsed.employee,
        href: `/notices/${encodeURIComponent(requestId)}`,
        entity_ref: null,
        person_id: null,
        relation_state: "unknown",
        detail: "Published appointment notice · person identity not joined",
        agency: clean(notice.agency_name),
        date: sourceDate(parsed.effectiveDate, notice.start_date),
        source_record_id: requestId,
        title_code: parsed.titleCode,
        search_text: `${parsed.employee} notice-only hire appointment ${notice.agency_name || ""} ${parsed.titleCode || ""}`,
      };
    })
    .filter(Boolean);
}

function agencyRows(agencies = {}) {
  return Object.values(agencies.by_id || {})
    .filter((agency) => clean(agency?.subject_ref) && clean(agency?.display_name))
    .map((agency) => ({
      kind: "agency",
      id: clean(agency.subject_ref),
      label: clean(agency.display_name),
      href: entityHref({ ref: agency.subject_ref, label: agency.display_name }) || agency.path || null,
      entity_ref: clean(agency.subject_ref),
      relation_state: "published",
      detail: `${Number(agency.matched_categories) || 0} linked record categories`,
      search_text: `${agency.display_name} agency organization`,
      categories: agency.categories || {},
    }));
}

function vendorRows(agencies = {}, awards = {}) {
  const byRef = new Map();
  for (const agency of Object.values(agencies.by_id || {})) {
    // Keep the home read model bounded while retaining the agency-ranked top
    // ten for every agency. Agency profiles retain their fuller constellation.
    for (const vendor of (Array.isArray(agency?.top_vendors) ? agency.top_vendors : []).slice(0, 10)) {
      const ref = clean(vendor?.subject_ref);
      const label = clean(vendor?.label);
      if (!ref || !label || !ref.startsWith("vendor:stem:")) continue;
      const row = byRef.get(ref) || {
        kind: "vendor",
        id: ref,
        label,
        href: vendor.href || entityHref({ ref, label }) || null,
        entity_ref: ref,
        relation_state: "published",
        detail: "Vendor profile from agency award records",
        agency_ids: new Set(),
        award_count: 0,
        search_text: `${label} vendor organization`,
      };
      const agencyId = clean(agency.subject_ref);
      if (agencyId) row.agency_ids.add(agencyId);
      row.award_count += Number(vendor.award_count) || 0;
      byRef.set(ref, row);
    }
  }
  // Compatibility input for small concept-view fixtures. Production builds
  // populate vendors from the typed agency constellation above.
  if (!byRef.size) {
    for (const award of Array.isArray(awards?.rows) ? awards.rows : []) {
      const label = clean(award?.vendor_name);
      if (!label) continue;
      const ref = entityRouteRef("vendor", label);
      if (!ref || byRef.has(ref)) continue;
      byRef.set(ref, {
        kind: "vendor",
        id: ref,
        label,
        href: entityHref({ ref, label }) || null,
        entity_ref: ref,
        relation_state: "published",
        detail: "Vendor profile from published award records",
        agency_ids: new Set(),
        award_count: 1,
        search_text: `${label} vendor organization`,
      });
    }
  }
  return [...byRef.values()].map((row) => ({
    ...row,
    agency_count: row.agency_ids.size,
    agency_ids: [...row.agency_ids].sort(),
    detail: `${row.award_count.toLocaleString("en-US")} linked awards across ${row.agency_ids.size || 0} agenc${row.agency_ids.size === 1 ? "y" : "ies"}`,
  }));
}

function committeeRows(graph = {}, people = {}) {
  const published = graph.publication === "published";
  const edges = published && Array.isArray(graph.public_edges) ? graph.public_edges : [];
  const byCommittee = new Map();
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    if (node?.type !== "committee" || !clean(node.id) || !clean(node.name)) continue;
    byCommittee.set(node.id, {
      kind: "committee",
      id: node.id,
      label: clean(node.name),
      href: "/browse/people/#people-row-committee-" + encodeURIComponent(clean(node.id).replace(/^committee:/, "")),
      entity_ref: node.id,
      relation_state: published ? "empty" : "unknown",
      detail: published ? "Committee identity published · no exact member edge in this snapshot" : "Committee relation coverage unknown",
      members: [],
      search_text: `${node.name} committee organization`,
    });
  }
  for (const edge of edges) {
    if (edge?.type !== "member_of") continue;
    const committee = byCommittee.get(edge.to);
    if (!committee) continue;
    const exactId = clean(edge.from, 80).replace(/^official:/, "");
    const person = people.by_person_id?.[exactId];
    if (!exactId || !person?.person_name) {
      committee.relation_state = "unknown";
      continue;
    }
    committee.relation_state = "published";
    committee.members.push({
      person_id: exactId,
      person_ref: personRef(exactId),
      person_name: clean(person.person_name),
      href: personHref(exactId),
      relation_state: "published",
      role: clean(edge.title) || "Committee member",
    });
  }
  return [...byCommittee.values()].map((row) => ({
    ...row,
    members: [...new Map(row.members.map((member) => [member.person_id, member])).values()],
    detail: row.relation_state === "published"
      ? `${row.members.length} exact-person member${row.members.length === 1 ? "" : "s"}`
      : row.detail,
  }));
}

function boardRows(geography = {}) {
  const districtByBoard = new Map((geography.public_edges || [])
    .filter((edge) => edge?.type === "covers" && String(edge.to || "").startsWith("community-district:"))
    .map((edge) => [edge.from, String(edge.to).replace("community-district:", "")]));
  return (geography.nodes || [])
    .filter((node) => node?.type === "community-board" && clean(node.id) && clean(node.name))
    .map((node) => {
      const bodyId = clean(node.properties?.body_id || String(node.id).replace(/^community-board:/, ""), 80);
      const district = districtByBoard.get(node.id) || null;
      const relations = node.properties?.identity?.projections?.organization?.relation_families;
      const organizationRelations = (Array.isArray(relations) && relations.length ? relations : DEFAULT_BOARD_RELATIONS).map((relation) => ({
        type: clean(relation?.type, 80),
        label: clean(relation?.label) || clean(relation?.type, 80),
        state: state(relation?.state),
      }));
      return {
        kind: "community-board",
        id: `community-board:${bodyId}`,
        label: clean(node.name),
        href: communityBoardPageHref(bodyId),
        entity_ref: `community-board:${bodyId}`,
        relation_state: "published",
        detail: district
          ? `Covers ${clean(node.properties?.borough)} Community District ${district}.`
          : "Institution published · district coverage unknown",
        body_id: bodyId,
        borough: clean(node.properties?.borough),
        district,
        place_href: communityBoardPlaceHref({
          borough: node.properties?.borough,
          community_district_id: node.properties?.community_district_id || district,
        }),
        organization_relations: organizationRelations,
        search_text: `${node.name} community board ${node.properties?.borough || ""} ${district || ""} institution`,
      };
    });
}

export function buildPeopleOrganizationsReadModel(sources = {}) {
  const people = sources.people || {};
  const committees = sources.committees || {};
  const agencies = sources.agencies || {};
  const places = sources.places || {};
  const hires = sources.hires || {};
  const rows = [
    ...officialRows(people),
    ...exactPersonAppointmentRows(people),
    ...noticeOnlyHireRows(hires),
    ...agencyRows(agencies),
    ...vendorRows(agencies, sources.awards || {}),
    ...committeeRows(committees, people),
    ...boardRows(places),
  ];
  const order = new Map(PEOPLE_ORGANIZATION_ROW_KINDS.map((kind, index) => [kind, index]));
  rows.sort((left, right) => (order.get(left.kind) - order.get(right.kind))
    || left.label.localeCompare(right.label)
    || left.id.localeCompare(right.id));
  return {
    schema: "cityscroll.people_organizations_read_model.v1",
    row_kinds: [...PEOPLE_ORGANIZATION_ROW_KINDS],
    rows,
    counts: Object.fromEntries(PEOPLE_ORGANIZATION_ROW_KINDS.map((kind) => [kind, rows.filter((row) => row.kind === kind).length])),
    relation_states: [...RELATION_STATES],
    generated_at: sourceDate(people.retrieved_at, committees.generated_at, agencies.generated_at, places.generated_at, hires.generated_at),
  };
}
