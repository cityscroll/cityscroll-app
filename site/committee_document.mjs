import { constellationLink } from "./affordance_grammar.mjs";
import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeBack,
  renderNodeFooter,
  renderNodeSection,
} from "./civic_document_chrome.mjs";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

function numericCommitteeId(value) {
  const id = clean(value, 80).replace(/^committee:/, "");
  return /^\d+$/.test(id) ? id : "";
}

function membershipPeriods(edges) {
  const seen = new Set();
  return edges.map((edge) => {
    const role = clean(edge?.title, 160) || "Committee member";
    const start = clean(edge?.valid_from, 20);
    const end = clean(edge?.valid_to, 20);
    const key = `${role}\0${start}\0${end}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { role, start: start || null, end: end || null };
  }).filter(Boolean).sort((left, right) =>
    String(right.start || "").localeCompare(String(left.start || ""))
  );
}

export function buildCommitteeDocumentView(graph = {}, people = {}, value) {
  const id = numericCommitteeId(value);
  if (!id || graph?.publication !== "published") return null;
  const node = (Array.isArray(graph.nodes) ? graph.nodes : []).find((candidate) =>
    candidate?.id === `committee:${id}`
    && candidate?.type === "committee"
    && numericCommitteeId(candidate?.properties?.body_id) === id
  );
  const title = clean(node?.name);
  if (!node || !title || clean(node?.properties?.body_name) !== title) return null;
  const byOfficial = new Map();
  for (const edge of Array.isArray(graph.public_edges) ? graph.public_edges : []) {
    if (edge?.type !== "member_of" || edge.to !== `committee:${id}`) continue;
    const officialId = clean(edge.from, 80).replace(/^official:/, "");
    const person = people?.by_person_id?.[officialId];
    if (!/^\d+$/.test(officialId) || !clean(person?.person_name)) continue;
    const current = byOfficial.get(officialId) || {
      official_id: officialId,
      name: clean(person.person_name),
      edges: [],
    };
    current.edges.push(edge);
    byOfficial.set(officialId, current);
  }
  const members = [...byOfficial.values()].map((member) => ({
    official_id: member.official_id,
    name: member.name,
    href: `/officials/${encodeURIComponent(member.official_id)}/`,
    periods: membershipPeriods(member.edges),
  })).sort((left, right) => left.name.localeCompare(right.name, "en-US"));
  return {
    schema: "cityscroll.committee_document.v1",
    id,
    ref: `committee:${id}`,
    title,
    canonical_href: `/committees/${encodeURIComponent(id)}/`,
    generated_at: clean(graph.generated_at, 80) || null,
    members,
  };
}

function periodMarkup(period) {
  const dates = period.start
    ? ` · ${esc(period.start)}${period.end ? `–${esc(period.end)}` : ""}`
    : "";
  return `${esc(period.role)}${dates}`;
}

export function renderCommitteeDocument(view, { currentHref = "" } = {}) {
  if (!view?.id || !view?.title || view?.schema !== "cityscroll.committee_document.v1") return "";
  const members = view.members.map((member) => {
    const link = constellationLink({
      href: member.href,
      label: member.name,
      attributes: {
        "data-pivot-target-kind": "official",
        "data-pivot-target-id": member.official_id,
        "data-pivot-relation-label": "has member",
      },
      escape: esc,
    });
    const periods = member.periods.length
      ? `<span class="node-muted">${member.periods.map(periodMarkup).join("; ")}</span>`
      : "";
    return `<li>${link}${periods}</li>`;
  }).join("");
  const memberSection = renderNodeSection({
    heading: "Members",
    headingId: "committee-members",
    body: members ? `<ul class="node-record-list">${members}</ul>` : "",
    exportClass: "committee_members",
  });
  const back = renderNodeBack({
    href: "/browse/people/",
    label: "Browse people and organizations",
    currentHref,
  });
  return gateNodePageRender(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(view.title)} · CityScroll</title><meta name="description" content="New York City Council committee record and linked members."><link rel="canonical" href="https://cityscroll.org${esc(view.canonical_href)}"><meta property="og:url" content="https://cityscroll.org${esc(view.canonical_href)}">${renderCivicDocumentAssets("/")}</head><body><a class="skip" href="#main">Skip to content</a>${renderCivicDocumentMast({ current: "browse", surfaceClass: "committee-document-mast" })}<main id="main" class="node-document committee-document" data-node-document="1" data-civic-object-kind="committee" data-committee-id="${esc(view.id)}" data-subject-ref="${esc(view.ref)}">${back}<header class="node-hero civic-object-hero"><p class="node-kicker civic-object-kicker">New York City Council committee</p><h1>${esc(view.title)}</h1></header>${memberSection}</main>${renderNodeFooter()}</body></html>`);
}
