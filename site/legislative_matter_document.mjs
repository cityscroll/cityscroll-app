import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";
import {
  gateNodePageRender,
  renderCalendarEventPreviewScript,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeBack,
  renderNodeFooter,
  renderNodeProvenance,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import { renderLegalChangeSummary } from "./legal_change_edges.mjs";
import { publishedMatterHref } from "./legislative_matter_availability.mjs";
import { councilMatterFollowMarkup } from "./council_matter_watch.mjs";
import {
  buildMatterAppearanceCalendarView,
  MATTER_APPEARANCES_ANCHOR,
  renderMatterAppearanceCalendar,
} from "./legislative_matter_calendar.mjs";

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

/**
 * The local route for this matter, resolved by the one shared availability rule
 * against the generation this document was built from -- so a document never
 * links itself to a route the generation does not publish.
 */
export function matterCanonicalHref(value, published) {
  return publishedMatterHref(value, published === undefined ? {} : { published });
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

/**
 * Every City Record notice that referenced this matter at this event.
 *
 * One meeting is often announced by more than one notice. Those are repeated
 * references to a single appearance, not repeated hearings, so they are kept
 * together on one appearance as provenance. A generation that predates the
 * coalesced shape carries only `request_id`, which reads as a single reference.
 */
function noticeReferences(raw = {}) {
  const supplied = Array.isArray(raw.notice_references) ? raw.notice_references : [];
  const ids = [...new Set(
    [...supplied.map((notice) => clean(notice?.request_id, 80)), clean(raw.request_id, 80)].filter(Boolean),
  )].sort();
  return ids.map((requestId) => ({
    request_id: requestId,
    href: `/notices/${encodeURIComponent(requestId)}/`,
  }));
}

function normalizeAppearance(raw = {}) {
  const event = raw.event && typeof raw.event === "object" ? raw.event : {};
  const matter = raw.matter && typeof raw.matter === "object" ? raw.matter : raw;
  const committee = committeeProjection({ ...raw, event });
  return {
    request_id: clean(raw.request_id, 80),
    notice_references: noticeReferences(raw),
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
    matter_ref: clean(source.matter_ref, 120) || null,
    publisher_tenant: clean(source.publisher_tenant, 80) || null,
    // Identity is the publisher id; the label is whatever the publisher most
    // recently called it. Earlier observed labels stay visible as provenance so
    // a renamed matter reads as one history rather than a broken one.
    label_revisions: (Array.isArray(source.label_revisions) ? source.label_revisions : [])
      .map((revision) => ({
        matter_file: clean(revision?.matter_file, 120),
        title: clean(revision?.title, 500),
        observed_event_date: clean(revision?.observed_event_date, 20),
      }))
      .filter((revision) => revision.matter_file || revision.title),
    canonical_href: matterCanonicalHref(id, payload),
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

/**
 * The notice references for one appearance. Each carries its own identifier in
 * its link text, so a reader can tell two announcements of one meeting apart
 * and open either, and the count is stated plainly rather than left to be
 * inferred from two links that look the same.
 */
function noticeReferenceMarkup(appearance) {
  return appearance.notice_references
    .map((notice) => `<a href="${esc(notice.href)}" data-notice-reference="${esc(notice.request_id)}">CityScroll meeting notice ${esc(notice.request_id)}</a>`)
    .join(" · ");
}

const SMALL_NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** Plain-language counts: small numbers read as words in resident copy. */
function spelled(count) {
  return SMALL_NUMBERS[count] || String(count);
}

function repeatedNoticeNote(appearance) {
  const count = appearance.notice_references.length;
  if (count < 2) return "";
  const written = spelled(count);
  return `<p class="node-muted matter-notice-note">${esc(written.charAt(0).toUpperCase() + written.slice(1))} meeting notices referenced this same meeting. They are ${esc(written)} announcements of one appearance, not separate hearings.</p>`;
}

function appearanceMarkup(appearance) {
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
    noticeReferenceMarkup(appearance),
    documents,
  ].filter(Boolean).join(" · ");
  const action = actionMarkup(appearance.actions);
  const vote = voteMarkup(appearance.vote);
  const sections = [
    action ? renderNodeSection({ heading: "Actions", body: action, headingId: `matter-actions-${appearance.event.event_id}`, exportClass: "matter_actions" }) : "",
    `<div class="matter-appearance-vote">${vote}</div>`,
  ].filter(Boolean).join("");
  return `<article class="matter-appearance" data-matter-appearance="${esc(appearance.event.event_id)}" data-request-id="${esc(appearance.request_id)}" data-notice-reference-count="${esc(String(appearance.notice_references.length))}">
    <header class="matter-appearance-head"><p class="node-kicker">${esc(event.date || "Dated meeting")}</p><h3>${eventSource}</h3><p class="matter-appearance-links">${sourceList}</p>${repeatedNoticeNote(appearance)}</header>
    <p class="matter-committee"><strong>Committee:</strong> ${committeeMarkup(appearance.committee)}</p>
    ${sections}
  </article>`;
}

/**
 * What this history covers, said before the records themselves.
 *
 * A matter with one retained appearance and a matter whose last retained
 * appearance is months old are the same situation: CityScroll has located
 * nothing later. That is a statement about what has been retained, and the copy
 * has to keep it one — a page that reads as "nothing more happened" would be
 * asserting an outcome the materialization cannot support.
 */
function historyScopeMarkup(view) {
  const count = view.appearances.length;
  const single = count === 1;
  const latest = view.appearances[count - 1];
  const vintage = view.generated_at ? clean(view.generated_at, 80).slice(0, 10) : "";
  const held = `CityScroll holds ${spelled(count)} observed appearance${single ? "" : "s"} for this matter`;
  const dated = latest.event.date
    ? `, ${single ? "dated" : "the most recent dated"} ${latest.event.date}`
    : "";
  const source = vintage
    ? ` ${single ? "It comes" : "They come"} from the Council meeting records materialized on ${vintage}.`
    : "";
  return `<p class="node-muted matter-history-scope" data-matter-appearance-count="${esc(String(count))}" data-matter-latest-observed="${esc(latest.event.date || "")}">${esc(`${held}${dated}.${source} No later official step has been located for it. That is the limit of what has been retained here, not a finding that the matter is settled.`)}</p>`;
}

/**
 * The labels this matter was previously observed under. A publisher can rename
 * a matter; the identity that addresses this page does not change with it, so
 * an earlier name is provenance for the same history rather than evidence of a
 * different matter.
 */
function labelRevisionItems(view) {
  return (Array.isArray(view.label_revisions) ? view.label_revisions : []).map((revision) => {
    const label = [revision.matter_file, revision.title].filter(Boolean).join(" — ");
    const when = revision.observed_event_date ? ` when observed on ${revision.observed_event_date}` : "";
    return `Previously listed as ${label}${when}.`;
  });
}

export function renderLegislativeMatterDocument(view, { currentHref = "", legalChangeGraph = null, today = null } = {}) {
  if (!view?.id || !view?.title || view.schema !== LEGISLATIVE_MATTER_SCHEMA) return "";
  const matterSource = view.matter_href
    ? officialSourceLink({ href: view.matter_href, label: "Legistar matter record", className: "node-source-link", escape: esc })
    : "";
  const identity = `<p class="node-meta"><span>${esc(view.matter_file || `Matter ${view.id}`)}</span> · <span>Matter ${esc(view.id)}</span>${view.matter_type ? ` · <span>${esc(view.matter_type)}</span>` : ""}${view.matter_status ? ` · <span>${esc(view.matter_status)}</span>` : ""}</p>`;
  const follow = `<p class="matter-document-follow">${councilMatterFollowMarkup({ lens: "meetings", matter_id: view.id }, { label: `Follow matter ${view.matter_file || view.id}` })}</p>`;
  // The compact month is a hypothesis about temporal concentration, never a
  // claimed decision: it only renders when the appearances cluster densely
  // enough (CBICS-01 density rule), and it links back to the same evidence
  // as the detailed appearances below rather than restating identity.
  const appearanceCalendar = renderMatterAppearanceCalendar(buildMatterAppearanceCalendarView(view, { today }));
  const appearanceSection = renderNodeSection({
    heading: "Observed appearances",
    headingId: MATTER_APPEARANCES_ANCHOR,
    body: `${historyScopeMarkup(view)}${view.appearances.map(appearanceMarkup).join("")}`,
    exportClass: "matter_appearances",
  });
  const provenance = renderNodeProvenance({
    heading: "Sources and receipts",
    headingId: "matter-sources",
    note: `This matter view is a static projection of the committed Council meeting-outcome materialization. It preserves the publisher event, meeting notice, documents, and Legistar matter record for each observed appearance.`,
    sourceItems: [
      matterSource ? { html: matterSource } : null,
      view.matter_ref ? `Publisher identity ${view.matter_ref}.` : null,
      ...labelRevisionItems(view),
      `Materialized at ${view.generated_at || "an unspecified source vintage"}.`,
    ].filter(Boolean),
    exportClass: "matter_provenance",
  });
  const back = renderNodeBack({ href: "/browse/meetings/", label: "Browse meetings", currentHref });
  const legalChanges = renderLegalChangeSummary(legalChangeGraph);
  return gateNodePageRender(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(view.matter_file || view.title)} · CityScroll</title><meta name="description" content="A source-backed City Council matter history with observed meetings, actions, votes, and official records."><link rel="canonical" href="https://cityscroll.org${esc(view.canonical_href)}"><meta property="og:url" content="https://cityscroll.org${esc(view.canonical_href)}">${renderCivicDocumentAssets("/")}<link rel="stylesheet" href="/compact_calendar.css">${renderCalendarEventPreviewScript("/")}</head><body><a class="skip" href="#main">Skip to content</a>${renderCivicDocumentMast({ current: "browse", surfaceClass: "matter-document-mast" })}<main id="main" class="node-document civic-object-document legislative-matter-document" data-node-document="1" data-civic-object-kind="legislative-matter" data-matter-id="${esc(view.id)}" data-subject-ref="${esc(view.ref)}"><div class="civic-object-hero">${back}<p class="node-kicker civic-object-kicker">New York City Council legislative matter</p><h1>${esc(view.title)}</h1>${identity}${follow}<p class="civic-object-pivot">${matterSource}</p></div>${legalChanges}${appearanceCalendar}${appearanceSection}${provenance}</main>${renderNodeFooter()}</body></html>`);
}
