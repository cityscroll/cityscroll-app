import { entityHref, entityRouteRef } from "./entity_pivot.mjs";
import { renderEntityPivotLink } from "./edge_summary.mjs";
import { renderCommitteeLocalConstellationHTML } from "./committee_memberships.mjs";

export const BROWSE_CONCEPTS = Object.freeze({
  people: {
    route: "/browse/people/",
    tab: "people",
    label: "People + organizations",
    title: "People and organizations",
    description: "Officials, vendors, and committees with published records.",
  },
  places: {
    route: "/browse/places/",
    tab: "places",
    label: "Places",
    title: "Places",
    description: "Community boards, districts, and public records tied to a place.",
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

function boardItems(geography = {}) {
  const districtByBoard = new Map((geography.public_edges || [])
    .filter((edge) => edge?.type === "covers" && String(edge.to || "").startsWith("community-district:"))
    .map((edge) => [edge.from, String(edge.to).replace("community-district:", "")]));
  return (geography.nodes || [])
    .filter((node) => node?.type === "community-board" && node?.name)
    .map((node) => ({
      name: node.name,
      borough: node.properties?.borough || "",
      district: node.properties?.district,
      communityDistrict: districtByBoard.get(node.id) || null,
    }))
    .sort((left, right) => left.borough.localeCompare(right.borough) || Number(left.district) - Number(right.district));
}

function renderBoards(geography) {
  const boards = boardItems(geography);
  if (!boards.length) return `<p class="empty">No community boards are in the current geography index.</p>`;
  return `<ul class="browse-concept-list">${boards.map((board) => {
    const href = board.communityDistrict
      ? `/near-you/#map?level=community_district&parent=${encodeURIComponent(board.borough)}&id=${encodeURIComponent(board.communityDistrict)}&lens=meetings`
      : "/near-you/";
    return `<li>${link(href, board.name)}. <span class="browse-concept-meta">${esc(board.borough)} · District ${esc(board.district)}.</span></li>`;
  }).join("")}</ul>`;
}

export function buildBrowseConceptLanding(kind, sources = {}) {
  const config = BROWSE_CONCEPTS[kind];
  if (!config) return null;
  const people = sources.people || {};
  const committees = sources.committees || {};
  const awards = sources.awards || {};
  const geography = sources.places || {};
  const officials = officialItems(people);
  const vendors = vendorItems(awards);
  const committeeRows = committeeItems(committees, people);
  const boards = boardItems(geography);
  const sections = kind === "people"
    ? [
      conceptSection("officials", "Officials", "Published official profiles.", renderOfficials(people), officials.length),
      conceptSection("vendors", "Vendors", "Vendor profiles from award records.", renderVendors(awards), vendors.length),
      conceptSection("committees", "Committees", "Published committee records.", renderCommittees(committees, people), committeeRows.length),
    ]
    : [
      conceptSection("community-boards", "Community boards", "The geography index lists each board and opens its mapped community district.", renderBoards(geography), boards.length),
      conceptSection("place-links", "Place pages", "Use these pages for board minutes and nearby public records.", `<p class="browse-concept-actions">${link("/community-boards/", "Open community board minutes")} ${link("/near-you/", "Open Near you")}</p>`),
    ];
  return { ...config, sections };
}

export function renderBrowseConceptLanding(landing) {
  if (!landing) return "";
  return `<div class="browse-concept-landing" data-build-rendered="browse-concept" data-browse-concept="${esc(landing.tab)}">
    <p class="now-kicker"><a href="/browse/">Browse</a> · ${esc(landing.label)}</p>
    <header class="browse-landing-head"><h1>${esc(landing.title)}</h1><p>${esc(landing.description)}</p></header>
    <div class="browse-concept-grid">${landing.sections.join("")}</div>
  </div>`;
}
