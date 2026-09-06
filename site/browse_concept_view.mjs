import { entityHref, entityRouteRef } from "./entity_pivot.mjs";
import { renderEntityPivotLink } from "./edge_summary.mjs";
import {
  communityBoardPageHref,
} from "./community_board_links.mjs";
import {
  buildPeopleOrganizationsReadModel,
} from "./people_organizations_read_model.mjs";
import {
  browseListState,
  PEOPLE_ORGANIZATIONS_BROWSE_CONFIG,
} from "./browse_list_contract.mjs";
import { renderBrowseView } from "./browse_view.mjs";
import { buildPeopleListBrowseView } from "./people_organizations_surface.mjs";
import { PEOPLE_ORGANIZATIONS_SURFACE } from "./browse_surface_contracts.mjs";

export const BROWSE_CONCEPTS = Object.freeze({
  people: {
    route: PEOPLE_ORGANIZATIONS_SURFACE.canonicalRoute,
    tab: PEOPLE_ORGANIZATIONS_SURFACE.navigationFamily,
    label: PEOPLE_ORGANIZATIONS_SURFACE.label,
    title: PEOPLE_ORGANIZATIONS_SURFACE.title,
    description: PEOPLE_ORGANIZATIONS_SURFACE.description,
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

function link(href, label, className = "browse-concept-link") {
  return `<a class="${className}" href="${esc(href)}">${esc(label)}</a>`;
}

function entityLink(kind, id, label) {
  const href = entityHref({ ref: entityRouteRef(kind, id), label });
  return href ? link(href, label) : esc(label);
}

function conceptSection(id, title, description, body, count = null) {
  if (!body || count === 0) return "";
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
  if (!items.length) return "";
  const shown = items.slice(0, 10);
  return `<ul class="browse-concept-list">${shown.map((person) => `<li>${entityLink("official", person.person_id, person.person_name)} <span class="browse-concept-meta">Official profile.</span></li>`).join("")}</ul><p class="browse-concept-meta">Showing ${shown.length} official${shown.length === 1 ? "" : "s"}.</p>`;
}

function renderVendors(awards) {
  const items = vendorItems(awards);
  if (!items.length) return "";
  const shown = items.slice(0, 10);
  return `<ul class="browse-concept-list">${shown.map((vendor) => `<li>${entityLink("vendor", vendor.name, vendor.name)} <span class="browse-concept-meta">${vendor.count.toLocaleString("en-US")} award${vendor.count === 1 ? "" : "s"}.</span></li>`).join("")}</ul><p class="browse-concept-meta">Showing ${shown.length} vendor${shown.length === 1 ? "" : "s"}.</p>`;
}

function renderCommittees(graph, people) {
  const items = committeeItems(graph, people);
  if (!items.length) return "";
  return `<ul class="browse-concept-list browse-committee-list">${items.slice(0, 5).map((committee) => {
    const committeeId = String(committee.id || "").replace(/^committee:/, "");
    const committeeName = /^\d+$/.test(committeeId)
      ? link(`/committees/${encodeURIComponent(committeeId)}/`, committee.name)
      : esc(committee.name);
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
      }, { escape: esc, showRelation: false })).join(", ")}.`
      : "";
    return `<li><strong>${committeeName}.</strong>${members ? ` <span class="browse-concept-meta">${members}</span>` : ""}</li>`;
  }).join("")}</ul>`;
}

function renderBoardOrganizations(geography) {
  const boards = boardItems(geography);
  if (!boards.length) return "";
  const byBorough = new Map();
  for (const board of boards) {
    if (!byBorough.has(board.borough)) byBorough.set(board.borough, []);
    byBorough.get(board.borough).push(board);
  }
  return `<ul class="browse-concept-list browse-board-organization-list">${[...byBorough.entries()].map(([borough, boroughBoards]) => {
    const links = boroughBoards.map((board) => `<a class="browse-board-number-link" href="${esc(board.institutionHref)}" aria-label="${esc(board.name)}" data-board-projection="organization" data-body-id="${esc(board.bodyId)}">${esc(board.number)}</a>`).join(" ");
    return `<li class="browse-board-borough">
      <h3>${esc(borough)} community boards:</h3>
      <span class="browse-board-number-links">${links}</span>
    </li>`;
  }).join("")}</ul>`;
}

function boardItems(geography = {}) {
  return (geography.nodes || [])
    .filter((node) => node?.type === "community-board" && node?.name)
    .map((node) => ({
      bodyId: node.properties?.body_id || String(node.id || "").replace(/^community-board:/, ""),
      name: node.name,
      borough: node.properties?.borough || "",
      district: node.properties?.district,
      number: Number(node.properties?.district)
        || Number(String(node.properties?.body_id || node.id || "").match(/-cb-(\d{2})$/)?.[1])
        || Number(String(node.name).match(/Community Board\s+(\d{1,2})$/i)?.[1]),
      institutionHref: communityBoardPageHref(node.properties?.body_id || String(node.id || "").replace(/^community-board:/, "")),
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
  official: "City Council member/official",
  "exact-person-appointment": "City Council term",
  "notice-only-hire": "Published staffing notice",
  agency: "Agency",
  vendor: "Vendor",
  committee: "City Council committee",
  "community-board": "Community Board",
  "community-board-person": "Community Board person",
  "community-board-committee": "Community Board committee",
});

function rowKindLabel(kind) {
  return ROW_KIND_LABELS[kind] || kind;
}

function rowKindCountLabel(kind, count) {
  const labels = {
    agency: "agencies",
    vendor: "vendors",
    committee: "committees",
    "community-board": "boards",
    "community-board-person": "Community Board people",
    "community-board-committee": "Community Board committees",
  };
  return `${Number(count).toLocaleString("en-US")} ${labels[kind] || `${rowKindLabel(kind).toLowerCase()}${count === 1 ? "" : "s"}`}`;
}

export function renderPeopleOrganizationRow(row) {
  const shared = renderBrowseView(buildPeopleListBrowseView({ rows: [row] }, new URLSearchParams(), { limit: 1 }));
  return shared.match(/<article class="browse-static-record[^"]*"[\s\S]*?<\/article>/)?.[0] || "";
}

function renderPeopleOrganizationsList(model) {
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  if (!rows.length) return "";
  const config = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG;
  const state = browseListState(model, new URLSearchParams(), config);
  const countSummary = Object.entries(model?.counts || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([kind, count]) => rowKindCountLabel(kind, count))
    .join(" · ");
  const facetLabels = {
    official: "City Council members/officials",
    "exact-person-appointment": "City Council terms",
    "notice-only-hire": "Published staffing notices",
    agency: "Agencies",
    vendor: "Vendors",
    committee: "City Council committees",
    "community-board": "Community Boards",
    "community-board-person": "Community Board people",
    "community-board-committee": "Community Board committees",
  };
  const institutionLabels = {
    "community-board": "Community Board",
    "city-council": "City Council",
    agency: "Agency",
    vendor: "Vendor",
  };
  const modelJson = JSON.stringify(model).replaceAll("<", "\\u003c");
  return `<section class="browse-concept-section people-organizations-unified" id="people-organizations-list" aria-labelledby="people-organizations-list-heading" data-people-organizations>
    <p class="browse-concept-count">${esc(rows.length.toLocaleString("en-US"))} typed rows</p>
    <h2 id="people-organizations-list-heading">People and organizations</h2>
    <p class="browse-concept-description">Search the current list. Every row names its record type; person links use exact identifiers, while notice-only hires remain separate.</p>
    ${state.generatedAt ? `<p class="people-org-freshness" data-people-organizations-freshness>Updated ${esc(state.generatedAt)}</p>` : ""}
    <form class="people-org-search" role="search" data-people-organizations-search-form>
      <label for="people-organizations-search">Search people and organizations</label>
      <input id="people-organizations-search" type="search" autocomplete="off" placeholder="Search a name, agency, board, committee, or notice" data-people-organizations-search>
      <label for="people-organizations-type">Record type</label>
      <select id="people-organizations-type" data-people-organizations-type>
        <option value="">All record types</option>
        ${config.facetValues.map((kind) => `<option value="${esc(kind)}">${esc(facetLabels[kind] || kind)}</option>`).join("")}
      </select>
      <label for="people-organizations-institution">Institution</label>
      <select id="people-organizations-institution" data-people-organizations-institution>
        <option value="">All institutions</option>
        ${config.institutionValues.map((institution) => `<option value="${esc(institution)}">${esc(institutionLabels[institution] || institution)}</option>`).join("")}
      </select>
      <label for="people-organizations-role">People subtype</label>
      <select id="people-organizations-role" data-people-organizations-role>
        <option value="">All people subtypes</option>
        <option value="member">Board members &amp; officers</option>
        <option value="staff">Staff/District Managers</option>
      </select>
      <p class="people-org-search-summary" aria-live="polite" data-people-organizations-search-summary>${esc(countSummary)}</p>
    </form>
    <div class="people-org-row-list" aria-live="polite" data-people-organizations-list data-browse-list-status="${esc(state.status)}">${renderBrowseView(buildPeopleListBrowseView(model, new URLSearchParams(), { limit: config.initialPageSize }))}</div>
    <p class="empty people-org-no-results" data-people-organizations-no-results hidden>No matching people or organizations in this published snapshot.</p>
    <button type="button" class="people-org-more" id="people-organizations-more" data-people-organizations-more${rows.length > config.initialPageSize ? "" : " hidden"}>Show more</button>
    <script type="application/json" data-people-organizations-model>${modelJson}</script>
  </section>`;
}

function institutionFilterHref(institution, kind = "", role = "") {
  const params = new URLSearchParams({ institution });
  if (kind) params.set("type", kind);
  if (role) params.set("role", role);
  return `${PEOPLE_ORGANIZATIONS_SURFACE.canonicalRoute}?${params.toString()}`;
}

function institutionFilterLink(label, institution, kind, count, role = "") {
  const suffix = Number(count) > 0 ? ` · ${Number(count).toLocaleString("en-US")}` : "";
  return `<li><a class="browse-institution-filter" href="${esc(institutionFilterHref(institution, kind, role))}">${esc(label)}</a><span class="browse-concept-meta">${esc(suffix ? suffix.slice(3) : "No published rows")}</span></li>`;
}

function renderInstitutionSection({ id, title, description, institution, links, extra = "" }) {
  return `<section class="browse-concept-section browse-institution-section" id="${esc(id)}" aria-labelledby="${esc(id)}-heading">
    <h2 id="${esc(id)}-heading">${esc(title)}</h2>
    <p class="browse-concept-description">${esc(description)}</p>
    <ul class="browse-concept-list browse-institution-list">${links.join("")}</ul>
    ${extra}
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
  const communityBoardPeople = sources.communityBoardPeople || sources.community_board_people || {};
  const communityBoardCommittees = sources.communityBoardCommittees || sources.community_board_committees || {};
  const peopleOrganizations = kind === "people"
    ? buildPeopleOrganizationsReadModel({
      people,
      committees,
      agencies: sources.agencies || {},
      awards,
      places: geography,
      hires,
      communityBoardPeople,
      communityBoardCommittees,
      publisherCrosswalk: sources.publisherCrosswalk || sources.publisher_crosswalk || null,
    })
    : null;
  const sections = kind === "people"
    ? [
      renderInstitutionSection({
        id: "community-boards",
        title: "Community boards",
        description: "Appointed local advisory bodies. Public bodies serving New York City districts. Browse boards, Board members & officers, Staff/District Managers, and Community Board committees.",
        institution: "community-board",
        links: [
          institutionFilterLink("Boards", "community-board", "community-board", peopleOrganizations.counts["community-board"]),
          institutionFilterLink("Board members & officers", "community-board", "community-board-person", peopleOrganizations.counts["community-board-person"], "member"),
          institutionFilterLink("Staff/District Managers", "community-board", "community-board-person", peopleOrganizations.counts["community-board-person"], "staff"),
          institutionFilterLink("Community Board committees", "community-board", "community-board-committee", peopleOrganizations.counts["community-board-committee"]),
        ],
        extra: renderBoardOrganizations(geography),
      }),
      renderInstitutionSection({
        id: "city-council",
        title: "City Council",
        description: "Elected legislative body. Council members, City Council terms, and City Council committees stay distinct from staffing hires.",
        institution: "city-council",
        links: [
          institutionFilterLink("City Council members/officials", "city-council", "official", peopleOrganizations.counts.official),
          institutionFilterLink("City Council terms", "city-council", "exact-person-appointment", peopleOrganizations.counts["exact-person-appointment"]),
          institutionFilterLink("City Council committees", "city-council", "committee", peopleOrganizations.counts.committee),
        ],
        extra: conceptSection(
          "committees",
          "City Council committees",
          "New York City Council · elected legislative body.",
          renderCommittees(committees, people),
          peopleOrganizations.counts.committee,
        ),
      }),
      renderInstitutionSection({
        id: "other-organizations",
        title: "Other organizations",
        description: "Agencies, vendors, and published staffing notices with their source institution named.",
        institution: "agency",
        links: [
          institutionFilterLink("Agencies", "agency", "agency", peopleOrganizations.counts.agency),
          institutionFilterLink("Vendors", "vendor", "vendor", peopleOrganizations.counts.vendor),
          institutionFilterLink("Published staffing notices", "agency", "notice-only-hire", peopleOrganizations.counts["notice-only-hire"]),
        ],
      }),
      renderPeopleOrganizationsList(peopleOrganizations),
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
    <header class="browse-landing-head"><h2>${esc(landing.title)}</h2><p>${esc(landing.description)}</p></header>
    <div class="browse-concept-grid">${landing.sections.join("")}</div>
  </div>`;
}
