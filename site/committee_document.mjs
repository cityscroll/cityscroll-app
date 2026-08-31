import { constellationLink } from "./affordance_grammar.mjs";
import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeBack,
  renderNodeFooter,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import {
  councilCommitteeRolesForCommittee,
  landMatterJoinState,
  ZONING_FRANCHISES_BODY_ID,
} from "./civic_institution_council_committees.mjs";

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

export function buildCommitteeDocumentView(graph = {}, people = {}, value, extras = {}) {
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
  const proceedingRoles = id === ZONING_FRANCHISES_BODY_ID
    ? councilCommitteeRolesForCommittee(id, {
      committeeGraph: graph,
      proceedings: extras.proceedings,
      meetingOutcomes: extras.meetingOutcomes,
      generatedAt: graph.generated_at,
    })
    : null;
  return {
    schema: "cityscroll.committee_document.v1",
    id,
    ref: `committee:${id}`,
    title,
    canonical_href: `/committees/${encodeURIComponent(id)}/`,
    generated_at: clean(graph.generated_at, 80) || null,
    members,
    proceeding_roles: proceedingRoles,
    land_matter_join: proceedingRoles ? landMatterJoinState(proceedingRoles) : null,
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
  const proceedingSection = renderCommitteeProceedingSection(view);
  const back = renderNodeBack({
    href: "/browse/people/",
    label: "Browse people and organizations",
    currentHref,
  });
  const councilBack = `<p class="node-kicker civic-object-kicker"><a class="ui-constellation-link" href="/agencies/city-council/" data-role-relation="part_of">New York City Council</a> committee</p>`;
  return gateNodePageRender(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(view.title)} · CityScroll</title><meta name="description" content="New York City Council committee record and linked members."><link rel="canonical" href="https://cityscroll.org${esc(view.canonical_href)}"><meta property="og:url" content="https://cityscroll.org${esc(view.canonical_href)}">${renderCivicDocumentAssets("/")}</head><body><a class="skip" href="#main">Skip to content</a>${renderCivicDocumentMast({ current: "browse", surfaceClass: "committee-document-mast" })}<main id="main" class="node-document committee-document" data-node-document="1" data-civic-object-kind="committee" data-committee-id="${esc(view.id)}" data-subject-ref="${esc(view.ref)}">${back}<header class="node-hero civic-object-hero">${councilBack}<h1>${esc(view.title)}</h1></header>${proceedingSection}${memberSection}</main>${renderNodeFooter()}</body></html>`);
}

function roleReceipt(edge) {
  const details = [
    edge.join_method ? `Join ${edge.join_method}` : "",
    edge.valid_from ? `Valid ${edge.valid_from}${edge.valid_to ? `–${edge.valid_to}` : ""}` : "",
    edge.provenance?.source_receipt || edge.source_receipt
      ? `Receipt ${edge.source_receipt || edge.provenance.source_receipt}`
      : "",
    edge.provenance?.source_field && edge.provenance?.source_value
      ? `${edge.provenance.source_field}: “${edge.provenance.source_value}”`
      : "",
  ].filter(Boolean).join(" · ");
  return details ? `<span class="muted node-muted">${details}</span>` : "";
}

function renderCommitteeProceedingSection(view) {
  const roles = view?.proceeding_roles;
  if (!roles) return "";
  const meetings = (roles.accepted || []).filter((edge) => edge.relation_id === "hosts_meeting" && edge.linking);
  const chairs = (roles.accepted || []).filter((edge) => edge.relation_id === "chairs" && edge.linking);
  const officialName = (officialId) => (
    (view.members || []).find((member) => member.official_id === officialId)?.name || officialId
  );
  const meetingItems = meetings.map((edge) => {
    const href = edge.notice_href || edge.href;
    return `<li class="node-record" data-role-relation="hosts_meeting" data-meeting-id="${esc(edge.to)}" data-join-method="${esc(edge.join_method || "")}" data-source-receipt="${esc(edge.source_receipt || edge.provenance?.source_receipt || "")}">
      <div class="node-record-main"><a class="ui-constellation-link" href="${esc(href)}">${esc(edge.object_display_name || edge.to)}</a></div>
      ${roleReceipt(edge)}
    </li>`;
  }).join("");
  const chairItems = chairs.map((edge) => `<li class="node-record" data-role-relation="chairs" data-official-id="${esc(edge.subject_canonical_id)}" data-valid-from="${esc(edge.valid_from || "")}">
      <div class="node-record-main"><a class="ui-constellation-link" href="${esc(edge.inverse_href)}">${esc(officialName(edge.subject_canonical_id))}</a></div>
      ${roleReceipt(edge)}
    </li>`).join("");
  const join = view.land_matter_join;
  const matterHtml = join?.status === "joined" && join.href
    ? `<p><a class="ui-constellation-link" data-role-relation="considers" href="${esc(join.href)}">${esc(join.matter_id)}</a></p>`
    : `<p class="muted node-muted" data-matter-join="unavailable" data-matter-id="${esc(join?.matter_id || "")}">Matter join unavailable${join?.label ? ` — ${esc(join.label)}` : ""}.</p>`;
  const augGap = (roles.gaps || []).find((gap) => gap.kind === "meeting");
  const augHtml = augGap
    ? `<p class="muted node-muted" data-proceeding-gap="2026-08-12">${esc(augGap.label || "August 12, 2026 proceeding is not in the current snapshot")}</p>`
    : "";
  const body = [
    meetingItems ? `<ul class="node-record-list">${meetingItems}</ul>` : "",
    augHtml,
    chairs.length ? `<h3 class="node-subhead">Chair</h3><ul class="node-record-list">${chairItems}</ul>` : "",
    `<h3 class="node-subhead">Land-use matter</h3>${matterHtml}`,
  ].filter(Boolean).join("");
  return renderNodeSection({
    heading: "Source-qualified proceeding",
    headingId: "committee-proceeding",
    extraClass: "committee-proceeding",
    attrs: {
      id: "committee-proceeding",
      "data-proceeding-schema": "cityscroll.council_committee_proceedings.v1",
    },
    body,
    exportClass: "committee_proceeding",
  });
}
