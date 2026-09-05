/**
 * PHC-04 — bridges testimony given at an exact Council hearing-to-matter join
 * to the legislative path that matter is actually on, without ever implying
 * that testimony decided anything.
 *
 * This module renders only on an exact join (site/council_hearing_matter_continuation.mjs's
 * `state === "single"`) and always sits above that existing continuation. Several
 * strict matches ("multiple") require the reader to select a matter through the
 * existing continuation instead of receiving one blended consequence, and an
 * unmatched, missing, or title-only relation ("unmatched" / "unavailable" /
 * "unknown") mints nothing here either — this module adds no join logic of its
 * own, it only projects the same strict join council_hearing_matter_continuation.mjs
 * already proved.
 *
 * Three facts render, each independently sourced:
 *  - the committee's own recorded action on the matter at this hearing (the
 *    exact join's own `outcome` field) — a process position, never framed as
 *    caused by testimony;
 *  - where public testimony given at a Council hearing is officially recorded
 *    — a general NYC Council operating fact (council.nyc.gov/testify/), the
 *    same class of citation OFFICIAL_SOURCES already carries for other
 *    proceeding families in site/consequence_projection.mjs — stated
 *    separately from any questions committee members asked witnesses, since
 *    those are a distinct activity;
 *  - the nearest published amendment or vote that follows this hearing on the
 *    same matter, drawn only from site/data/legislative_matter_lookup.json's
 *    own observed appearance history, named as the next official event rather
 *    than as any individual comment's effect. A matter with no later observed
 *    appearance, or one whose only later appearances are holds or referrals,
 *    states honestly that no amendment or vote has followed yet.
 */

import legislativeMatterLookup from "./data/legislative_matter_lookup.json" with { type: "json" };
import { OFFICIAL_SOURCES } from "./consequence_projection.mjs";
import { projectCouncilHearingMatterContinuation } from "./council_hearing_matter_continuation.mjs";

export const LEGISLATIVE_HEARING_CONSEQUENCE_SCHEMA = "cityscroll.legislative_hearing_consequence.v1";

export const TESTIMONY_RECORD_LABEL = "Public testimony given at this hearing becomes part of the official hearing record";

// An appearance only becomes the "next official event" when it carries a
// recorded vote or an action naming an amendment, approval, adoption, or
// defeat — never a bare hold, referral, or lay-over, so a routine procedural
// step can never be read as the matter's outcome.
const VOTE_OR_AMENDMENT_PATTERN = /\b(approved|adopted|amended|passed|enacted|defeated|rejected|disapproved)\b/i;

function text(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeHttps(value) {
  try {
    const url = new URL(text(value, 2_000));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function outcomeFor(record, override) {
  return override || record?.meeting_outcome || record?.council_outcome || null;
}

function isVoteOrAmendment(appearance) {
  const vote = appearance?.vote || appearance?.votes;
  if (vote && (vote.result || vote.yes != null || vote.no != null || vote.abstain != null)) return true;
  if (VOTE_OR_AMENDMENT_PATTERN.test(text(appearance?.outcome, 240))) return true;
  return (Array.isArray(appearance?.actions) ? appearance.actions : [])
    .some((action) => VOTE_OR_AMENDMENT_PATTERN.test(text(action, 240)));
}

/**
 * The nearest published amendment or vote on `matterId` after the exact
 * hearing named by `afterRequestId`, drawn only from the matter's own
 * observed appearance history in site/data/legislative_matter_lookup.json.
 * Returns null when that matter has no recorded lookup entry, no later
 * appearance, or no later appearance that is itself a vote or amendment.
 */
function nextPublishedAmendmentOrVote(matterId, afterRequestId) {
  const source = legislativeMatterLookup?.matters?.[text(matterId, 80)];
  const appearances = Array.isArray(source?.appearances) ? source.appearances : [];
  const ordered = appearances
    .filter((appearance) => text(appearance?.request_id, 80) && text(appearance?.event?.date, 20))
    .slice()
    .sort((left, right) => text(left.event.date, 20).localeCompare(text(right.event.date, 20))
      || text(left.request_id, 80).localeCompare(text(right.request_id, 80)));
  const afterIndex = ordered.findIndex((appearance) => appearance.request_id === text(afterRequestId, 80));
  if (afterIndex === -1) return null;
  const next = ordered.slice(afterIndex + 1).find(isVoteOrAmendment);
  if (!next) return null;
  return Object.freeze({
    label: text(next.outcome, 240) || text(next.actions?.at(-1), 240) || "Council action",
    date: text(next.event?.date, 20) || null,
    source_url: safeHttps(next.event?.url) || null,
  });
}

/**
 * Project one exact Council hearing-to-matter join into the PHC-04
 * consequence facts. Non-`single` states carry no matter and no facts, by
 * design (see module doc): the caller renders nothing for them.
 */
export function projectLegislativeHearingConsequence(record = {}, override = null) {
  const continuation = projectCouncilHearingMatterContinuation(record, override);
  if (continuation.state !== "single") {
    return Object.freeze({
      schema: LEGISLATIVE_HEARING_CONSEQUENCE_SCHEMA,
      meeting_id: continuation.meeting_id,
      state: continuation.state,
      matter: null,
      process_position: null,
      testimony_record: null,
      next_event: null,
    });
  }
  const matter = continuation.matters[0];
  const outcome = outcomeFor(record, override);
  const committeeName = text(outcome?.event?.name, 240) || null;
  const processPosition = matter.outcome
    ? Object.freeze({
      label: matter.outcome,
      committee_name: committeeName,
      source_url: matter.matter_url,
    })
    : null;
  const testimonyRecord = Object.freeze({
    label: TESTIMONY_RECORD_LABEL,
    source_url: OFFICIAL_SOURCES.councilTestimony,
  });
  const nextEvent = nextPublishedAmendmentOrVote(matter.matter_id, continuation.request_id);
  return Object.freeze({
    schema: LEGISLATIVE_HEARING_CONSEQUENCE_SCHEMA,
    meeting_id: continuation.meeting_id,
    state: "single",
    matter,
    process_position: processPosition,
    testimony_record: testimonyRecord,
    next_event: nextEvent,
  });
}

/** Render the PHC-04 consequence block. Sits above the existing matter continuation. */
export function renderLegislativeHearingConsequence(record = {}, override = null, { sectionClass = "node-section civic-object-section meeting-section" } = {}) {
  const projection = projectLegislativeHearingConsequence(record, override);
  if (projection.state !== "single") return "";
  const rows = [];
  if (projection.process_position) {
    const href = safeHttps(projection.process_position.source_url);
    const committee = projection.process_position.committee_name;
    rows.push(`<p class="legislative-consequence-position"><b>Where this matter stands:</b> ${committee ? `${esc(committee)} recorded` : "The committee recorded"} this action at this hearing: ${esc(projection.process_position.label)}${href ? ` — <a href="${esc(href)}" rel="noopener noreferrer">official source</a>` : ""}.</p>`);
  }
  const testimonyHref = safeHttps(projection.testimony_record.source_url);
  rows.push(`<p class="legislative-consequence-testimony">${esc(projection.testimony_record.label)}${testimonyHref ? ` — <a href="${esc(testimonyHref)}" rel="noopener noreferrer">official source</a>` : ""}. Any questions committee members asked witnesses are a separate activity from public testimony, and neither one by itself decides the matter.</p>`);
  rows.push(projection.next_event
    ? `<p class="legislative-consequence-next-event">Next official event on this matter: ${esc(projection.next_event.label)}${projection.next_event.date ? ` <time datetime="${esc(projection.next_event.date)}">(${esc(projection.next_event.date)})</time>` : ""}${projection.next_event.source_url ? ` — <a href="${esc(projection.next_event.source_url)}" rel="noopener noreferrer">official source</a>` : ""}.</p>`
    : `<p class="legislative-consequence-next-event legislative-consequence-unknown">No published amendment or vote on this matter has followed this hearing yet.</p>`);
  return `<section class="${sectionClass} legislative-hearing-consequence" data-legislative-hearing-consequence="1" data-matter-id="${esc(projection.matter.matter_id)}"><h2>What happens with this matter</h2>${rows.join("")}</section>`;
}
