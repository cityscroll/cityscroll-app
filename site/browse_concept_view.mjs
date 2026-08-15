import { entityHref, entityRouteRef } from "./entity_pivot.mjs";
import { renderEntityPivotLink } from "./edge_summary.mjs";
import { renderCommitteeLocalConstellationHTML } from "./committee_memberships.mjs";
import { communityBoardPageHref } from "./community_board_links.mjs";
import {
  buildPeopleOrganizationsReadModel,
  relationStateLabel,
} from "./people_organizations_read_model.mjs";

export const BROWSE_CONCEPTS = Object.freeze({
  people: {
    route: "/browse/people/",
    tab: "people",
    label: "People + organizations",
    title: "People and organizations",
    description: "Officials, vendors, committees, and community boards with published records.",
  },
  places: {
    route: "/browse/places/",
    tab: "places",
    label: "Places",
    title: "Places",
    description: "Districts and public records tied to a place.",
  },
});

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

const ORGANIZATION_RELATION_LABELS = Object.freeze({
  has_member: "Members",
  member_of: "Board roles",
  hosts_meeting: "Hosted meetings",
  issues_recommendation: "Recommendations",
});
const DEFAULT_ORGANIZATION_RELATIONS = Object.freeze(Object.keys(ORGANIZATION_RELATION_LABELS).map((type) => ({
  type,
  label: ORGANIZATION_RELATION_LABELS[type],
  state: "unknown",
})));

function link(href, label, className = "browse-concept-link") {
  return `<a class="${className}" href="${esc(href)}">${esc(label)}</a>`;
}

function entityLink(kind, id, label) {
  const href = entityHref({ ref: entityRouteRef(kind, id), label });
  return href ? link(href, label) : esc(label);
}

function conceptSection(id, title, description, body, count = null) {
  const countLabel = count == null ? "" : `<p class="browse-concept-count">${esc(count.toLocaleString("en-US"))}</p>`;
  return `<section class="browse-concept-section" id="${esc(id)}" aria-labelledby="${esc(id)}-heading">
    ${countLabel}<h2 id="${esc(id)}-heading">${esc(title)}</h2><p class="browse-concept-description">${esc(description)}</p>${body}
  </section>`;
}

function officialItems(people = {}) {
  return Object.values(people.by_person_id || {})
    .filter((person) => person?.person_id && person?.person_name)
    .sort((left, right) => String(left.person_name).localeCompare(String(right.person_name)));
}

function vendorItems(awards = {}) {
  const byName = new Map();
  for (const row of Array.isArray(awards.rows) ? awards.rows : []) {
    const name = String(row?.vendor_name || "").trim();
    if (!name) continue;
    const current = byName.get(name) || { name, count: 0 };
    current.count += 1;
    byName.set(name, current);
  }
  return [...byName.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function committeeItems(graph = {}, people = {}) {
  const names = new Map((graph.nodes || [])
    .filter((node) => node?.type === "committee" && node?.id && node?.name)
    .map((node) => [node.id, { id: node.id, name: node.name, members: [] }]));
  const forwardEdges = graph.publication === "published" && Array.isArray(graph.public_edges)
    ? graph.public_edges
    : [];
  const reverseEdges = graph.publication === "published" && Array.isArray(graph.public_reverse_edges)
    ? graph.public_reverse_edges
    : forwardEdges
      .filter((edge) => edge?.type === "member_of")
      .map((edge) => ({
        ...edge,
        type: "has_member",
        from: edge.to,
        to: edge.from,
        relation_label: "has member",
        direction: "inverse",
        inverse_of: edge.id || null,
      }));
  for (const edge of reverseEdges) {
    if (edge?.type !== "has_member") continue;
    const committee = names.get(edge.from);
    if (!committee) continue;
    const officialId = String(edge.to || "").replace(/^official:/, "");
    const person = people.by_person_id?.[officialId];
    if (person?.person_name && officialId) committee.members.push({ id: officialId, name: person.person_name, edge });
  }
  return [...names.values()]
    .map((committee) => ({ ...committee, members: [...new Map(committee.members.map((member) => [member.id, member])).values()] }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function renderOfficials(people) {
  const items = officialItems(people);
  if (!items.length) return `<p class="empty">No officials are in the current published index.</p>`;
  const shown = items.slice(0, 10);
  return `<ul class="browse-concept-list">${shown.map((person) => `<li>${entityLink("official", person.person_id, person.person_name)} <span class="browse-concept-meta">Official profile.</span></li>`).join("")}</ul><p class="browse-concept-meta">Showing ${shown.length} official${shown.length === 1 ? "" : "s"}.</p>`;
}

function renderVendors(awards) {
  const items = vendorItems(awards);
  if (!items.length) return `<p class="empty">No vendors are in the current published index.</p>`;
  const shown = items.slice(0, 10);
  return `<ul class="browse-concept-list">${shown.map((vendor) => `<li>${entityLink("vendor", vendor.name, vendor.name)} <span class="browse-concept-meta">${vendor.count.toLocaleString("en-US")} award${vendor.count === 1 ? "" : "s"}.</span></li>`).join("")}</ul><p class="browse-concept-meta">Showing ${shown.length} vendor${shown.length === 1 ? "" : "s"}.</p>`;
}

function renderCommittees(graph, people) {
  const items = committeeItems(graph, people);
  if (!items.length) return `<p class="empty">No published committee records are in the current index.</p>`;
  return `<ul class="browse-concept-list browse-committee-list">${items.slice(0, 5).map((committee) => {
    const members = committee.members.length
      ? `Members: ${committee.members.map((member) => renderEntityPivotLink({
        relation_label: "has member",
        target_kind: "official",
        target_id: member.id,
        target_name: member.name,
        target_href: `/officials/${encodeURIComponent(member.id)}/`,
        source: { kind: "committee", id: committee.id, name: committee.name, canonical_href: null },
        provenance: member.edge?.provenance ?? null,
        inverse_of: member.edge?.inverse_of ?? null,
      }, { escape: esc })).join(", ")}.`
      : "Reverse coverage unavailable.";
    return `<li><strong>${esc(committee.name)}.</strong> <span class="browse-concept-meta">${members}</span>${renderCommitteeLocalConstellationHTML(graph, committee.id, people)}</li>`;
  }).join("")}</ul>`;
}

function renderBoardOrganizations(geography) {
  const boards = boardItems(geography);
  if (!boards.length) return `<p class="empty">No community boards are in the current organization index.</p>`;
  return `<ul class="browse-concept-list browse-board-organization-list">${boards.map((board) => {
    const relationStatus = board.organizationRelations
      .map((relation) => `<span>${esc(ORGANIZATION_RELATION_LABELS[relation.type] || relation.label || "Board records")} · Unknown</span>`)
      .join("");
    const coverage = board.communityDistrict
      ? `Covers ${board.borough} Community District ${board.communityDistrict}.`
      : "District coverage · Unknown.";
    return `<li class="browse-board-organization" data-board-projection="organization" data-body-id="${esc(board.bodyId)}">
      <h3>${link(board.institutionHref, board.name)}</h3>
      <p class="browse-concept-meta">${esc(coverage)}</p>
      <div class="browse-concept-status-rail" aria-label="Board record status">
        <span>Board identity · Published</span>
        <span>District coverage · ${board.communityDistrict ? "Published" : "Unknown"}</span>
        ${relationStatus}
      </div>
    </li>`;
  }).join("")}</ul>`;
}

function boardItems(geography = {}) {
  const districtByBoard = new Map((geography.public_edges || [])
    .filter((edge) => edge?.type === "covers" && String(edge.to || "").startsWith("community-district:"))
    .map((edge) => [edge.from, String(edge.to).replace("community-district:", "")]));
  return (geography.nodes || [])
    .filter((node) => node?.type === "community-board" && node?.name)
    .map((node) => ({
      bodyId: node.properties?.body_id || String(node.id || "").replace(/^community-board:/, ""),
      name: node.name,
      borough: node.properties?.borough || "",
      district: node.properties?.district,
      communityDistrict: districtByBoard.get(node.id) || null,
      institutionHref: communityBoardPageHref(node.properties?.body_id || String(node.id || "").replace(/^community-board:/, "")),
      organizationRelations: node.properties?.identity?.projections?.organization?.relation_families || DEFAULT_ORGANIZATION_RELATIONS,
    }))
    .sort((left, right) => left.borough.localeCompare(right.borough) || Number(left.district) - Number(right.district));
}

function renderPlaceDiscovery() {
  return `<div class="browse-concept-place-handoff">
    <p>Near you is the place view for community boards and the districts they cover.</p>
    <p class="browse-concept-actions">${link("/near-you/", "Open Near you for place discovery")}</p>
  </div>`;
}

const ROW_KIND_LABELS = Object.freeze({
  official: "Official",
  "exact-person-appointment": "Exact-person appointment",
  "notice-only-hire": "Notice-only hire",
  agency: "Agency",
  vendor: "Vendor",
  committee: "Committee",
  "community-board": "Community board institution",
});

function rowKindLabel(kind) {
  return ROW_KIND_LABELS[kind] || kind;
}

function rowKindCountLabel(kind, count) {
  const labels = {
    agency: "agencies",
    vendor: "vendors",
    committee: "committees",
    "community-board": "community board institutions",
  };
  return `${Number(count).toLocaleString("en-US")} ${labels[kind] || `${rowKindLabel(kind).toLowerCase()}${count === 1 ? "" : "s"}`}`;
}

function renderPersonRowLink(row) {
  if (!row.href) return esc(row.label);
  return link(row.href, row.label, "people-org-row-link");
}

function peopleOrganizationRowHeading(row) {
  return `${row.label} · ${rowKindLabel(row.kind)} · ${row.id}`;
}

function renderCommitteeMembers(row) {
  if (!row.members?.length) return "";
  return `<p class="people-org-row-related"><span>Exact-person members:</span> ${row.members.map((member) => {
    const label = member.href
      ? link(member.href, member.person_name, "people-org-person-link")
      : esc(member.person_name);
    return `<span data-person-id="${esc(member.person_id)}">${label}</span>`;
  }).join(", ")}</p>`;
}

function renderBoardRelations(row) {
  if (!row.organization_relations?.length) return "";
  return `<div class="people-org-row-relations" aria-label="Community board relation status">${row.organization_relations.map((relation) =>
    `<span>${esc(relation.label)} · ${esc(relationStateLabel(relation.state))}</span>`).join("")}</div>`;
}

function renderPeopleOrganizationRow(row) {
  const place = row.kind === "community-board" && row.place_href
    ? `<a class="people-org-place-link" href="${esc(row.place_href)}">Discover this place in Near you</a>`
    : "";
  const notice = row.kind === "notice-only-hire" && row.source_record_id
    ? `<span class="people-org-row-source">Notice ${esc(row.source_record_id)}</span>`
    : "";
  const boardStatus = row.kind === "community-board"
    ? `<div class="people-org-row-status-rail" aria-label="Board record status"><span>Board identity · Published</span><span>District coverage · ${esc(row.district ? "Published" : "Unknown")}</span></div>`
    : "";
  const boardAttributes = row.kind === "community-board"
    ? ` data-board-projection="organization" data-body-id="${esc(row.body_id)}"`
    : "";
  return `<li class="people-org-row" id="people-row-${esc(row.id.replace(/[^A-Za-z0-9_-]/g, "-"))}"${boardAttributes} data-people-organization-row data-row-kind="${esc(row.kind)}" data-relation-state="${esc(row.relation_state)}" data-search-text="${esc(row.search_text)}">
    <div class="people-org-row-top"><span class="people-org-kind">${esc(rowKindLabel(row.kind))}</span><span class="people-org-state people-org-state-${esc(row.relation_state)}">${esc(relationStateLabel(row.relation_state))}</span></div>
    <h3>${renderPersonRowLink({ ...row, label: peopleOrganizationRowHeading(row) })}</h3>
    <p class="people-org-row-detail">${esc(row.detail)}${row.agency ? ` · ${esc(row.agency)}` : ""}${row.date ? ` · ${esc(row.date)}` : ""}</p>
    ${notice}${boardStatus}${row.kind === "committee" ? renderCommitteeMembers(row) : ""}${row.kind === "community-board" ? renderBoardRelations(row) : ""}${place}
  </li>`;
}

function renderPeopleOrganizationsList(model) {
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const countSummary = Object.entries(model?.counts || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([kind, count]) => rowKindCountLabel(kind, count))
    .join(" · ");
  return `<section class="browse-concept-section people-organizations-unified" id="people-organizations-list" aria-labelledby="people-organizations-list-heading" data-people-organizations>
    <p class="browse-concept-count">${esc(rows.length.toLocaleString("en-US"))} typed rows</p>
    <h2 id="people-organizations-list-heading">People and organizations</h2>
    <p class="browse-concept-description">Search one materialized list. Every row names its record type; person links use exact identifiers, while notice-only hires remain visibly unjoined.</p>
    <form class="people-org-search" role="search" data-people-organizations-search-form>
      <label for="people-organizations-search">Search people and organizations</label>
      <input id="people-organizations-search" type="search" autocomplete="off" placeholder="Search a name, agency, board, committee, or notice" data-people-organizations-search>
      <p class="people-org-search-summary" data-people-organizations-search-summary>${esc(countSummary)}</p>
    </form>
    <ul class="people-org-row-list" data-people-organizations-list>${rows.map(renderPeopleOrganizationRow).join("")}</ul>
    <p class="empty people-org-no-results" data-people-organizations-no-results hidden>No matching people or organizations in this published snapshot.</p>
  </section>`;
}

export function buildBrowseConceptLanding(kind, sources = {}) {
  const config = BROWSE_CONCEPTS[kind];
  if (!config) return null;
  const people = sources.people || {};
  const committees = sources.committees || {};
  const awards = sources.awards || {};
  const geography = sources.places || {};
  const hires = sources.hires || {};
  const officials = officialItems(people);
  const vendors = vendorItems(awards);
  const committeeRows = committeeItems(committees, people);
  const boards = boardItems(geography);
  const peopleOrganizations = kind === "people"
    ? buildPeopleOrganizationsReadModel({ people, committees, agencies: sources.agencies || {}, awards, places: geography, hires })
    : null;
  const sections = kind === "people"
    ? [
      // Keep the bounded concept sections as the established navigation and
      // evidence surfaces. The typed list is an additive search layer above
      // them, not a replacement for their existing renderers and pivots.
      renderPeopleOrganizationsList(peopleOrganizations),
      conceptSection("officials", "Officials", "Published official profiles.", renderOfficials(people), officials.length),
      conceptSection("vendors", "Vendors", "Vendor profiles from award records.", renderVendors(awards), vendors.length),
      conceptSection("committees", "Committees", "Published committee records.", renderCommittees(committees, people), committeeRows.length),
      conceptSection("community-boards", "Community boards", "Public bodies serving New York City districts.", renderBoardOrganizations(geography), boards.length),
    ]
    : [
      conceptSection("community-boards", "Community boards", "Find a community board as a place in Near you.", renderPlaceDiscovery()),
      conceptSection("place-links", "Community board records", "Open the separate source directory for published board calendars and minutes.", `<p class="browse-concept-actions">${link("/community-boards/", "Open community board records")}</p>`),
    ];
  return { ...config, sections, peopleOrganizations };
}

export function renderBrowseConceptLanding(landing) {
  if (!landing) return "";
  return `<div class="browse-concept-landing" data-build-rendered="browse-concept" data-browse-concept="${esc(landing.tab)}">
    <p class="now-kicker"><a href="/browse/">Browse</a> · ${esc(landing.label)}</p>
    <header class="browse-landing-head"><h1>${esc(landing.title)}</h1><p>${esc(landing.description)}</p></header>
    <div class="browse-concept-grid">${landing.sections.join("")}</div>
  </div>`;
}
