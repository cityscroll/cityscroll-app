/** Materialized People + organizations read model.
 *
 * This is deliberately a read-only join. Display names never create person
 * identities: person rows carry an exact source person_id, and notice-only
 * hires keep their person relation unknown when the source has no such key.
 */

import { entityHref, entityRouteRef } from "./entity_pivot.mjs";
import {
  communityBoardPageHref,
  communityDistrictDisplayName,
} from "./community_board_links.mjs";
import { communityBoardPlaceHref } from "./community_board_constellation.mjs";
import {
  communityBoardCommitteeId,
  normalizeCommunityBoardCommitteeRegistry,
} from "./community_board_committees.mjs";
import {
  communityBoardPersonObject,
  promoteCommunityBoardPersonRoleEdge,
} from "./community_board_relations.mjs";
import {
  buildPersonConstellation,
} from "./person_constellation.mjs";
import {
  projectCommunityBoardPersonAlias,
  projectCouncilOfficialAlias,
} from "../ontology/person.mjs";

export const PEOPLE_ORGANIZATION_ROW_KINDS = Object.freeze([
  "community-board",
  "community-board-person",
  "community-board-committee",
  "official",
  "exact-person-appointment",
  "committee",
  "agency",
  "vendor",
  "notice-only-hire",
]);

export const PEOPLE_ORGANIZATION_INSTITUTIONS = Object.freeze([
  "community-board",
  "city-council",
  "agency",
  "vendor",
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
      const projection = projectCouncilOfficialAlias({
        personId: id,
        displayName: person.person_name,
        observedAt: people.retrieved_at,
        sourceObservationRefs: [`person_hub:${id}`],
      });
      return {
        kind: "official",
        id: `official:${id}`,
        label: clean(person.person_name),
        href: personHref(id),
        entity_ref: personRef(id),
        person_id: id,
        person_ref: projection.person_ref,
        person_projection: projection,
        person_edges: [],
        person_constellation: buildPersonConstellation({
          person: projection,
          source: { kind: "official", id: `official:${id}`, name: clean(person.person_name), canonical_href: personHref(id) },
        }),
        relation_state: "published",
        detail: "Official profile",
        institution: "city-council",
        institution_label: "New York City Council",
        institution_context: "Elected legislative body",
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
    const projection = projectCouncilOfficialAlias({
      personId,
      displayName: personName,
      observedAt: people.retrieved_at,
      sourceObservationRefs: [`person_hub:${personId}`],
    });
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
        person_ref: projection.person_ref,
        relation_state: "published",
        detail: `City Council term${term.district ? ` · District ${term.district}` : ""}`,
        institution: "city-council",
        institution_label: "New York City Council",
        institution_context: "Elected legislative body",
        date: sourceDate(term.term_start, term.term_end),
        search_text: `${personName} City Council term official ${term.office_id} ${term.district || ""}`,
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
        detail: "Published staffing notice · person identity not joined",
        institution: "agency",
        institution_label: clean(notice.agency_name) || "Agency",
        institution_context: "City Record staffing record",
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
      institution: "agency",
      institution_label: "Agency",
      institution_context: "City agency organization",
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
        institution: "vendor",
        institution_label: "Vendor",
        institution_context: "Published supplier organization",
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
        institution: "vendor",
        institution_label: "Vendor",
        institution_context: "Published supplier organization",
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
    const committeeId = clean(node.id).replace(/^committee:/, "");
    byCommittee.set(node.id, {
      kind: "committee",
      id: node.id,
      label: clean(node.name),
      href: /^\d+$/.test(committeeId) ? `/committees/${encodeURIComponent(committeeId)}/` : null,
      entity_ref: node.id,
      relation_state: published ? "empty" : "unknown",
      detail: published ? "City Council committee identity published · no exact member edge in this snapshot" : "City Council committee relation coverage unknown",
      institution: "city-council",
      institution_label: "New York City Council",
      institution_context: "Elected legislative body",
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
      ? `${row.members.length} exact City Council member${row.members.length === 1 ? "" : "s"}`
      : row.detail,
  }));
}

const COMMUNITY_BOARD_ROLE_LABELS = Object.freeze({
  appointed_member: "Board member",
  board_chair: "Board chair",
  board_officer: "Board officer",
  committee_chair: "Committee chair",
  committee_member: "Committee member",
  public_committee_member: "Public committee member",
  district_manager: "District Manager",
  staff: "Community Board staff",
});

function boardSourceRows(communityBoardPeople = {}) {
  return Object.entries(communityBoardPeople?.boards || {}).flatMap(([boardId, value]) => (
    (Array.isArray(value?.relationships) ? value.relationships : [])
      .map((relationship) => ({ ...relationship, board_id: relationship.board_id || boardId }))
  ));
}

function boardDirectory(geography = {}) {
  return new Map(boardRows(geography).map((row) => [row.body_id, row]));
}

function communityBoardPersonRows(communityBoardPeople = {}, geography = {}, committeeRegistry = {}) {
  const boards = boardDirectory(geography);
  const registryRows = normalizeCommunityBoardCommitteeRegistry(committeeRegistry);
  const committeeNames = new Map(registryRows.map((row) => [
    communityBoardCommitteeId(row.board_id, row.committee_id),
    row.publisher_name,
  ]));
  const byId = new Map();
  for (const observation of boardSourceRows(communityBoardPeople)) {
    const edge = promoteCommunityBoardPersonRoleEdge(observation);
    if (!edge.promoted) continue;
    const object = communityBoardPersonObject(observation);
    const boardId = String(observation.board_id || "").trim().toLowerCase();
    const board = boards.get(boardId);
    if (!object || !board) continue;
    const row = byId.get(object.id) || {
      kind: "community-board-person",
      id: object.id,
      label: object.person_name,
      href: null,
      entity_ref: object.id,
      relation_state: "published",
      institution: "community-board",
      institution_label: board.label,
      institution_context: "Appointed local advisory body",
      institution_ref: board.entity_ref,
      institution_href: board.href,
      board_id: board.body_id,
      board_label: board.label,
      board_href: board.href,
      publisher_person_id: object.publisher_person_id,
      identity_basis: object.identity_basis,
      roles: new Set(),
      committee_refs: new Set(),
      committee_names: new Map(),
      person_edges: [],
    };
    const projection = projectCommunityBoardPersonAlias({
      boardId,
      personKey: object.publisher_person_id,
      displayName: object.person_name,
      observedAt: observation.observed_on || observation.relation_date,
      sourceObservationRefs: [edge.provenance?.source_record_id].filter(Boolean),
    });
    row.person_ref = projection.person_ref;
    row.person_projection = projection;
    const targetRef = edge.organization_ref || edge.target_id;
    const targetKind = edge.relation === "staffed_by" || edge.relation === "works_for"
      ? "community-board"
      : edge.target_kind || (String(targetRef || "").startsWith("community-board-committee:") ? "community-board-committee" : "community-board");
    const targetId = clean(targetRef, 320);
    if (targetId && !row.person_edges.some((candidate) => candidate.relation === (edge.relation === "staffed_by" ? "works_for" : edge.relation) && candidate.target_ref === targetId)) {
      const targetBoardId = targetKind === "community-board" ? targetId.replace(/^community-board:/, "") : null;
      row.person_edges.push({
        relation: edge.relation === "staffed_by" ? "works_for" : edge.relation,
        relation_label: edge.role ? `${edge.role.replaceAll("_", " ")} · ${targetKind.replaceAll("-", " ")}` : null,
        target_kind: targetKind,
        target_ref: targetId,
        target_id: targetId,
        target_name: targetBoardId && boards.get(targetBoardId)?.label
          ? boards.get(targetBoardId).label
          : committeeNames.get(targetId) || targetId,
        target_href: targetBoardId && boards.get(targetBoardId)?.href ? boards.get(targetBoardId).href : null,
        status: "matched",
        provenance: edge.provenance || null,
      });
    }
    row.roles.add(edge.role || "staff");
    const committeeRef = [edge.from, edge.to].find((value) => String(value || "").startsWith("community-board-committee:"));
    if (committeeRef) row.committee_refs.add(committeeRef);
    byId.set(object.id, row);
  }
  return [...byId.values()].map((row) => {
    const roles = [...row.roles].sort();
    const committeeNamesForRow = [...row.committee_refs]
      .map((ref) => committeeNames.get(ref))
      .filter(Boolean)
      .sort();
    const roleLabels = roles.map((role) => COMMUNITY_BOARD_ROLE_LABELS[role] || "Community Board person");
    const roleFamily = roles.some((role) => ["district_manager", "staff"].includes(role)) ? "staff" : "member";
    return {
      ...row,
      roles,
      role_labels: roleLabels,
      role_family: roleFamily,
      committee_refs: [...row.committee_refs].sort(),
      committee_names: committeeNamesForRow,
      detail: roleLabels.join(" · "),
      search_text: [row.label, row.board_label, "Community Board person", ...roleLabels, ...committeeNamesForRow].join(" "),
      person_constellation: buildPersonConstellation({
        person: row.person_projection,
        edges: row.person_edges,
        source: { kind: "community-board", id: row.board_id, name: row.board_label, canonical_href: row.board_href },
      }),
    };
  });
}

function communityBoardCommitteeRows(committeeRegistry = {}, geography = {}, personRows = []) {
  const boards = boardDirectory(geography);
  const peopleByCommittee = new Map();
  for (const person of personRows) {
    for (const ref of person.committee_refs || []) {
      const current = peopleByCommittee.get(ref) || [];
      current.push({
        person_id: person.id,
        person_ref: person.person_ref || null,
        person_name: person.label,
        role: person.role_labels?.join(" · ") || "Committee member",
      });
      peopleByCommittee.set(ref, current);
    }
  }
  return normalizeCommunityBoardCommitteeRegistry(committeeRegistry).map((committee) => {
    const id = communityBoardCommitteeId(committee.board_id, committee.committee_id);
    const board = boards.get(committee.board_id);
    const members = [...new Map((peopleByCommittee.get(id) || []).map((person) => [person.person_id, person])).values()];
    return {
      kind: "community-board-committee",
      id,
      label: committee.publisher_name,
      href: null,
      entity_ref: id,
      relation_state: "published",
      institution: "community-board",
      institution_label: board?.label || `Community Board ${committee.board_id}`,
      institution_context: "Appointed local advisory body",
      institution_ref: board?.entity_ref || `community-board:${committee.board_id}`,
      institution_href: board?.href || communityBoardPageHref(committee.board_id),
      board_id: committee.board_id,
      board_label: board?.label || `Community Board ${committee.board_id}`,
      board_href: board?.href || communityBoardPageHref(committee.board_id),
      committee_id: committee.committee_id,
      publisher_identifier: committee.publisher_identifier || null,
      source_url: committee.source_url,
      topic_facets: committee.topic_facets,
      members,
      detail: `${board?.label || `Community Board ${committee.board_id}`} · ${members.length} linked board member${members.length === 1 ? "" : "s"}`,
      search_text: [committee.publisher_name, ...(committee.aliases || []), board?.label, "Community Board committee", "appointed local advisory body"].filter(Boolean).join(" "),
    };
  });
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
      const districtName = communityDistrictDisplayName({
        borough: node.properties?.borough,
        district: node.properties?.district,
        id: district,
      });
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
        detail: districtName ? `Covers ${districtName}.` : "",
        body_id: bodyId,
        borough: clean(node.properties?.borough),
        district,
        place_href: communityBoardPlaceHref({
          borough: node.properties?.borough,
          community_district_id: node.properties?.community_district_id || district,
        }),
        organization_relations: organizationRelations,
        institution: "community-board",
        institution_label: clean(node.name),
        institution_context: "Appointed local advisory body",
        institution_ref: `community-board:${bodyId}`,
        institution_href: communityBoardPageHref(bodyId),
        search_text: `${node.name} community board ${node.properties?.borough || ""} ${district || ""} institution`,
      };
    });
}

function identityCandidates(rows = []) {
  const candidates = rows
    .filter((row) => ["official", "agency", "vendor"].includes(row?.kind)
      && clean(row?.entity_ref, 320) && clean(row?.label) && clean(row?.href))
    .map((row) => ({
      entity_id: clean(row.entity_ref, 320),
      label: clean(row.label, 500),
      href: clean(row.href, 600),
      kind: row.kind,
    }));
  return [...new Map(candidates.map((candidate) => [candidate.entity_id, candidate])).values()]
    .sort((left, right) => left.label.localeCompare(right.label) || left.entity_id.localeCompare(right.entity_id));
}

export function buildPeopleOrganizationsReadModel(sources = {}) {
  const people = sources.people || {};
  const committees = sources.committees || {};
  const agencies = sources.agencies || {};
  const places = sources.places || {};
  const hires = sources.hires || {};
  const communityBoardPeople = sources.communityBoardPeople || sources.community_board_people || {};
  const communityBoardCommittees = sources.communityBoardCommittees || sources.community_board_committees || {};
  const communityBoardPersonRowsList = communityBoardPersonRows(communityBoardPeople, places, communityBoardCommittees);
  const rows = [
    ...boardRows(places),
    ...communityBoardPersonRowsList,
    ...communityBoardCommitteeRows(communityBoardCommittees, places, communityBoardPersonRowsList),
    ...officialRows(people),
    ...exactPersonAppointmentRows(people),
    ...committeeRows(committees, people),
    ...agencyRows(agencies),
    ...vendorRows(agencies, sources.awards || {}),
    ...noticeOnlyHireRows(hires),
  ];
  const order = new Map(PEOPLE_ORGANIZATION_ROW_KINDS.map((kind, index) => [kind, index]));
  rows.sort((left, right) => (order.get(left.kind) - order.get(right.kind))
    || left.label.localeCompare(right.label)
    || left.id.localeCompare(right.id));
  return {
    schema: "cityscroll.people_organizations_read_model.v2",
    row_kinds: [...PEOPLE_ORGANIZATION_ROW_KINDS],
    rows,
    // Existing profiles are lookup choices only. They are not inferred
    // matches, and selecting one creates no change to either profile.
    identity_candidates: identityCandidates(rows),
    counts: Object.fromEntries(PEOPLE_ORGANIZATION_ROW_KINDS.map((kind) => [kind, rows.filter((row) => row.kind === kind).length])),
    relation_states: [...RELATION_STATES],
    institutions: [...PEOPLE_ORGANIZATION_INSTITUTIONS],
    generated_at: sourceDate(people.retrieved_at, committees.generated_at, agencies.generated_at, places.generated_at, hires.generated_at, communityBoardPeople.observed_on, communityBoardCommittees.observed_on),
  };
}
