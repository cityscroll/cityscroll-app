import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";
import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeBack,
  renderNodeFooter,
  renderNodeProvenance,
  renderNodeSection,
} from "./civic_document_chrome.mjs";

export const LEGISLATIVE_MATTER_SCHEMA = "cityscroll.legislative_matter_document.v1";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

function numericMatterId(value) {
  const id = clean(value, 80).replace(/^matter:/, "");
  return /^\d+$/.test(id) ? id : "";
}

export function matterCanonicalHref(value) {
  const id = numericMatterId(value);
  return id ? `/matters/${encodeURIComponent(id)}/` : null;
}

export function officialVoteHref({ personId, eventId, requestId } = {}) {
  const person = numericMatterId(personId);
  if (!person) return null;
  const params = new URLSearchParams();
  if (clean(eventId, 80)) params.set("event", clean(eventId, 80));
  if (clean(requestId, 80)) params.set("notice", clean(requestId, 80));
  const query = params.toString();
  return `/officials/${encodeURIComponent(person)}/${query ? `?${query}` : ""}`;
}

function committeeProjection(appearance) {
  const label = clean(appearance?.committee?.label || appearance?.event?.name);
  const bodyId = numericMatterId(
    appearance?.committee?.body_id
      || appearance?.event?.body_id
      || appearance?.event?.committee_id,
  );
  return {
    label: label || "Committee not listed",
    body_id: bodyId || null,
    href: bodyId ? `/committees/${encodeURIComponent(bodyId)}/` : null,
    join_state: bodyId ? "matched_exact_body_id" : "unresolved_no_explicit_body_id",
  };
}

function voteProjection(vote, appearance) {
  const raw = vote && typeof vote === "object" ? vote : {};
  const people = Array.isArray(raw.by_person) ? raw.by_person : [];
  return {
    result: clean(raw.result, 120) || null,
    yes: Number.isFinite(Number(raw.yes)) ? Number(raw.yes) : null,
    no: Number.isFinite(Number(raw.no)) ? Number(raw.no) : null,
    abstain: Number.isFinite(Number(raw.abstain)) ? Number(raw.abstain) : null,
    vote_identity: clean(raw.vote_identity, 40) || (people.length ? "roll_call" : "tally_only"),
    person_count: Number.isFinite(Number(raw.person_count)) ? Number(raw.person_count) : people.length,
    people: people.map((person) => ({
      person_id: clean(person?.person_id, 80) || null,
      person_name: clean(person?.person_name, 180) || null,
      vote_bucket: clean(person?.vote_bucket, 40) || null,
      official_href: officialVoteHref({
        personId: person?.person_id,
        eventId: appearance?.event?.event_id,
        requestId: appearance?.request_id,
      }),
    })).filter((person) => person.person_id && person.person_name),
  };
}

function sourceDocuments(appearance) {
  return (Array.isArray(appearance?.event?.documents) ? appearance.event.documents : [])
    .map((document) => ({
      name: clean(document?.name || "Official meeting record", 120),
      href: clean(document?.url, 1000),
    }))
    .filter((document) => /^https:\/\//.test(document.href));
}

function normalizeAppearance(raw = {}) {
  const event = raw.event && typeof raw.event === "object" ? raw.event : {};
  const matter = raw.matter && typeof raw.matter === "object" ? raw.matter : raw;
  const committee = committeeProjection({ ...raw, event });
  return {
    request_id: clean(raw.request_id, 80),
    event: {
      event_id: clean(event.event_id, 80),
      name: clean(event.name || "Council meeting", 240),
      date: clean(event.date, 20),
      href: clean(event.url, 1000),
      documents: sourceDocuments({ event }),
    },
    actions: [...new Set((Array.isArray(matter.actions) ? matter.actions : [])
      .map((action) => clean(action, 240)).filter(Boolean))],
    outcome: clean(matter.outcome, 240) || null,
    committee,
    vote: voteProjection(matter.votes, { ...raw, event }),
    source_receipt: raw.source_receipt || null,
  };
}

export function buildLegislativeMatterDocument(payload = {}, value = "78605") {
  const id = numericMatterId(value);
  if (!id || payload?.schema !== "cityscroll.legislative_matter_lookup.v1") return null;
  const source = payload.matters?.[id];
  if (!source || source.matter_id !== id) return null;
  const appearances = (Array.isArray(source.appearances) ? source.appearances : [])
    .map(normalizeAppearance)
    .filter((appearance) => appearance.request_id && appearance.event.event_id)
    .sort((left, right) => left.event.date.localeCompare(right.event.date)
      || left.event.event_id.localeCompare(right.event.event_id));
  if (!appearances.length) return null;
  return {
    schema: LEGISLATIVE_MATTER_SCHEMA,
    id,
    ref: `matter:${id}`,
    title: clean(source.title, 500),
    matter_file: clean(source.matter_file, 120),
    matter_type: clean(source.matter_type, 120) || null,
    matter_status: clean(source.matter_status, 160) || null,
    matter_href: clean(source.matter_href, 1000) || null,
    canonical_href: matterCanonicalHref(id),
    generated_at: clean(payload.generated_at, 80) || null,
    appearances,
  };
}

function actionMarkup(actions) {
  return actions.length
    ? `<ol class="node-record-list matter-action-list">${actions.map((action) => `<li>${esc(action)}</li>`).join("")}</ol>`
    : "";
}

function committeeMarkup(committee) {
  if (!committee?.label) return "";
  if (committee.href) {
    return constellationLink({
      href: committee.href,
      label: committee.label,
      attributes: {
        "data-pivot-target-kind": "committee",
        "data-pivot-target-id": committee.body_id,
        "data-pivot-relation-label": "heard matter",
        "data-committee-join-state": committee.join_state,
      },
      escape: esc,
    });
  }
  return `<span class="matter-committee-label" data-committee-join-state="${esc(committee.join_state)}">${esc(committee.label)}</span><span class="node-muted matter-committee-note">Committee link withheld because this materialization has no explicit BodyId join.</span>`;
}

function voteMarkup(vote) {
  if (!vote || (vote.yes == null && vote.no == null && vote.abstain == null && !vote.people.length)) return "";
  const tally = vote.yes != null || vote.no != null || vote.abstain != null
    ? `<p class="matter-vote-tally"><strong>${esc(vote.result || "Recorded vote")}</strong> · ${vote.yes ?? "—"} yes · ${vote.no ?? "—"} no · ${vote.abstain ?? "—"} abstain</p>`
    : "";
  const people = vote.people.length
    ? `<ul class="node-record-list matter-vote-list" data-vote-identity="${esc(vote.vote_identity)}">${vote.people.map((person) => {
      const label = `${person.person_name} · ${person.vote_bucket || "recorded"}`;
      return `<li>${person.official_href
        ? constellationLink({
          href: person.official_href,
          label,
          attributes: {
            "data-pivot-target-kind": "official",
            "data-pivot-target-id": person.person_id,
            "data-pivot-relation-label": "votes_on",
          },
          escape: esc,
        })
        : esc(label)}</li>`;
    }).join("")}</ul>`
    : `<p class="node-muted">No named roll-call rows are retained for this appearance.</p>`;
  return `${tally}<p class="matter-vote-count">${esc(String(vote.person_count))} named vote${vote.person_count === 1 ? "" : "s"} · ${esc(vote.vote_identity)}</p>${people}`;
}

function appearanceMarkup(appearance) {
  const noticeHref = `/notices/${encodeURIComponent(appearance.request_id)}/`;
  const event = appearance.event;
  const eventSource = event.href
    ? officialSourceLink({ href: event.href, label: event.name, className: "node-source-link", escape: esc })
    : esc(event.name);
  const documents = event.documents.map((document) => officialSourceLink({
    href: document.href,
    label: document.name,
    className: "node-source-link",
    escape: esc,
  })).join(" · ");
  const sourceList = [
    `<a href="${esc(noticeHref)}">CityScroll meeting notice</a>`,
    documents,
  ].filter(Boolean).join(" · ");
  const action = actionMarkup(appearance.actions);
  const vote = voteMarkup(appearance.vote);
  const sections = [
    action ? renderNodeSection({ heading: "Actions", body: action, headingId: `matter-actions-${appearance.event.event_id}`, exportClass: "matter_actions" }) : "",
    `<div class="matter-appearance-vote">${vote}</div>`,
  ].filter(Boolean).join("");
  return `<article class="matter-appearance" data-matter-appearance="${esc(appearance.event.event_id)}" data-request-id="${esc(appearance.request_id)}">
    <header class="matter-appearance-head"><p class="node-kicker">${esc(event.date || "Dated meeting")}</p><h3>${eventSource}</h3><p class="matter-appearance-links">${sourceList}</p></header>
    <p class="matter-committee"><strong>Committee:</strong> ${committeeMarkup(appearance.committee)}</p>
    ${sections}
  </article>`;
}

export function renderLegislativeMatterDocument(view, { currentHref = "" } = {}) {
  if (!view?.id || !view?.title || view.schema !== LEGISLATIVE_MATTER_SCHEMA) return "";
  const matterSource = view.matter_href
    ? officialSourceLink({ href: view.matter_href, label: "Legistar matter record", className: "node-source-link", escape: esc })
    : "";
  const identity = `<p class="node-meta"><span>${esc(view.matter_file || `Matter ${view.id}`)}</span> · <span>Matter ${esc(view.id)}</span>${view.matter_type ? ` · <span>${esc(view.matter_type)}</span>` : ""}${view.matter_status ? ` · <span>${esc(view.matter_status)}</span>` : ""}</p>`;
  const appearanceSection = renderNodeSection({
    heading: "Observed appearances",
    headingId: "matter-appearances",
    body: view.appearances.map(appearanceMarkup).join(""),
    exportClass: "matter_appearances",
  });
  const provenance = renderNodeProvenance({
    heading: "Sources and receipts",
    headingId: "matter-sources",
    note: `This matter view is a static projection of the committed Council meeting-outcome materialization. It preserves the publisher event, meeting notice, documents, and Legistar matter record for each observed appearance.`,
    sourceItems: [
      matterSource ? { html: matterSource } : null,
      `Materialized at ${view.generated_at || "an unspecified source vintage"}.`,
    ].filter(Boolean),
    exportClass: "matter_provenance",
  });
  const back = renderNodeBack({ href: "/browse/meetings/", label: "Browse meetings", currentHref });
  return gateNodePageRender(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(view.matter_file || view.title)} · CityScroll</title><meta name="description" content="A source-backed City Council matter history with observed meetings, actions, votes, and official records."><link rel="canonical" href="https://cityscroll.org${esc(view.canonical_href)}"><meta property="og:url" content="https://cityscroll.org${esc(view.canonical_href)}">${renderCivicDocumentAssets("/")}</head><body><a class="skip" href="#main">Skip to content</a>${renderCivicDocumentMast({ current: "browse", surfaceClass: "matter-document-mast" })}<main id="main" class="node-document civic-object-document legislative-matter-document" data-node-document="1" data-civic-object-kind="legislative-matter" data-matter-id="${esc(view.id)}" data-subject-ref="${esc(view.ref)}"><div class="civic-object-hero">${back}<p class="node-kicker civic-object-kicker">New York City Council legislative matter</p><h1>${esc(view.title)}</h1>${identity}<p class="civic-object-pivot">${matterSource}</p></div>${appearanceSection}${provenance}</main>${renderNodeFooter()}</body></html>`);
}
