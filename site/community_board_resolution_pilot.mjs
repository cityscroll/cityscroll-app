/**
 * Accepted community-board decisions, read from four published documents.
 *
 * A resident can already find that a board publishes minutes. What the minutes
 * do not give them is the decision: the board's own words, and the one tally
 * that belongs to it. A set of minutes records committee votes, amendments,
 * referral motions that failed, and omnibus votes taken on everything except a
 * named item. Attaching the tally that happens to sit nearest a passage is how
 * a public record becomes misinformation, so this module never does it.
 *
 * The rule here is motion ownership. A tally counts for a decision only when
 * the document says so: it names the item, or it is an omnibus vote whose own
 * wording covers the item rather than excluding it. Everything else recorded at
 * the same meeting is retained beside the decision and labelled as not being
 * it, so a reader can see what was excluded and why.
 *
 * Committee and full-board stages stay separate. A committee recommendation is
 * not the board's action, and a board that votes twice on one application has
 * two facts, not an average.
 *
 * The reviewed input is
 * `site/data/community_board_resolution_sources/board_resolution_pilot_review.v1.json`;
 * `tools/build_community_board_resolution_pilot.mjs` projects it. The bound is
 * deliberate: four documents that were read, not a corpus. A candidate that was
 * not reviewed to that standard is retained with the reason it was held, and
 * never rendered as though the board had decided it.
 */

import { renderNodeSection } from "./civic_document_chrome.mjs";

export const COMMUNITY_BOARD_RESOLUTION_REVIEW_SCHEMA = "cityscroll.community_board_resolution_pilot_review.v1";
export const COMMUNITY_BOARD_RESOLUTION_PILOT_SCHEMA = "cityscroll.community_board_resolution_pilot.v1";
export const COMMUNITY_BOARD_RESOLUTION_REVIEW_QUEUE_SCHEMA = "cityscroll.community_board_resolution_review_queue.v1";
export const COMMUNITY_BOARD_RESOLUTION_VIEW_SCHEMA = "cityscroll.community_board_resolution_pilot_view.v1";

export const COMMUNITY_BOARD_DECISIONS_ANCHOR = "board-decisions";

/**
 * A tally belongs to a decision when the document's own wording says it does.
 *
 * `names_this_item` is a vote whose recorded subject is the item itself.
 * `omnibus_that_covers_this_item` is a single vote taken on a block of items
 * whose wording does not except this one. An omnibus that excepts the item is
 * the classic wrong answer and is an exclusion, never an assignment.
 * `sole_motion_in_this_section` is a vote recorded straight after the only
 * motion in a section that heard one item. Its own wording is generic, so the
 * ownership is stated as what it is -- position in the document, not naming --
 * and it is admitted only where the section really does hold one motion.
 */
export const COMMUNITY_BOARD_MOTION_OWNERSHIP = Object.freeze([
  "names_this_item",
  "omnibus_that_covers_this_item",
  "sole_motion_in_this_section",
]);

export const COMMUNITY_BOARD_VOTE_STAGES = Object.freeze(["committee", "full_board"]);

export const COMMUNITY_BOARD_DECISION_POSITIONS = Object.freeze([
  "supports",
  "approves",
  "recommends_denial_unless_conditions",
  "opposes",
  "unclassified",
]);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const BODY_ID = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const RTL_LANGS = new Set(["ar", "ur"]);

function clean(value, max = 400) {
  return String(value ?? "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function isoDay(value) {
  const day = clean(value, 10);
  return ISO_DAY.test(day) ? day : null;
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function httpsUrl(value) {
  const url = clean(value, 2_000);
  return /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
}

function digest(value) {
  const hex = clean(value, 64);
  return SHA256.test(hex) ? hex : null;
}

function lineRange(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [start, end] = value.map((entry) => Number(entry));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  return [start, end];
}

/** A quoted passage keeps the publisher's own words, bounded and whitespace-normalised. */
function passage(row = {}) {
  const text = clean(row.text, 4_000);
  const lines = lineRange(row.source_lines);
  const role = clean(row.role, 60);
  if (!text || !lines || !role) return null;
  return Object.freeze({ role, text, source_lines: Object.freeze(lines) });
}

function tally(row = {}) {
  const yes = count(row.yes);
  const no = count(row.no);
  const abstain = count(row.abstain);
  const text = clean(row.text, 1_000);
  const lines = lineRange(row.source_lines);
  if (yes === null || no === null || abstain === null || !text || !lines) return null;
  return {
    yes,
    no,
    abstain,
    present_not_voting: count(row.present_not_voting),
    result: row.result === "did_not_pass" ? "did_not_pass" : row.result === "passed" ? "passed" : null,
    subject_wording: clean(row.subject_wording, 300) || null,
    text,
    source_lines: Object.freeze(lines),
  };
}

/**
 * The tallies a decision may carry, and the recorded tallies it may not.
 *
 * A vote is admitted only when it names a stage the board actually has, states
 * a subject, and claims ownership the contract recognises. Anything rejected
 * here is not discarded: it moves into the excluded list with its reason, so
 * the page can show a reader the vote that was not used and why.
 */
export function selectCommunityBoardDecisionVotes(candidate = {}) {
  const admitted = [];
  const excluded = [];
  for (const row of Array.isArray(candidate.votes) ? candidate.votes : []) {
    const value = tally(row);
    if (!value) continue;
    const stage = clean(row.stage, 40);
    const ownership = clean(row.motion_ownership, 60);
    if (value.result !== "passed") {
      excluded.push({ ...value, exclusion_reason: "motion_did_not_pass" });
      continue;
    }
    if (!COMMUNITY_BOARD_VOTE_STAGES.includes(stage)) {
      excluded.push({ ...value, exclusion_reason: "unrecognised_vote_stage" });
      continue;
    }
    if (!COMMUNITY_BOARD_MOTION_OWNERSHIP.includes(ownership)) {
      excluded.push({ ...value, exclusion_reason: "tally_does_not_name_this_item" });
      continue;
    }
    if (!value.subject_wording) {
      excluded.push({ ...value, exclusion_reason: "tally_states_no_subject" });
      continue;
    }
    admitted.push(Object.freeze({ ...value, stage, motion_ownership: ownership }));
  }
  for (const row of Array.isArray(candidate.excluded_votes) ? candidate.excluded_votes : []) {
    const value = tally(row);
    if (!value) continue;
    excluded.push({ ...value, exclusion_reason: clean(row.exclusion_reason, 80) || "not_this_item" });
  }
  const stages = admitted.map((vote) => vote.stage);
  return {
    votes: Object.freeze(admitted),
    excluded_votes: Object.freeze(excluded.map((row) => Object.freeze(row))),
    has_committee_vote: stages.includes("committee"),
    has_full_board_vote: stages.includes("full_board"),
  };
}

/**
 * Two source spellings of one address are two assertions, not a building.
 *
 * A board's agenda and its own resolution can name different addresses for the
 * same application. Both are retained exactly; neither is preferred, and no
 * property is linked, because choosing one would publish a building the source
 * never agreed on.
 */
export function communityBoardDecisionAddressConflict(candidate = {}) {
  const assertions = (Array.isArray(candidate.address_assertions) ? candidate.address_assertions : [])
    .map((row) => ({
      source_position: clean(row.source_position, 60) || null,
      text: clean(row.text, 300) || null,
    }))
    .filter((row) => row.text && row.source_position);
  const distinct = new Set(assertions.map((row) => row.text.toLocaleLowerCase("en-US")));
  return Object.freeze({
    assertions: Object.freeze(assertions.map((row) => Object.freeze(row))),
    conflicting: distinct.size > 1,
    property_match_withheld: distinct.size > 1,
  });
}

function documentOf(review, documentId) {
  return (Array.isArray(review?.documents) ? review.documents : [])
    .find((row) => clean(row?.document_id, 200) === documentId) || null;
}

function documentProjection(row = {}) {
  return Object.freeze({
    document_id: clean(row.document_id, 200),
    board_id: clean(row.board_id, 80),
    publisher: clean(row.publisher, 200),
    document_role: clean(row.document_role, 40),
    published_label: clean(row.published_label, 300),
    document_url: httpsUrl(row.document_url),
    document_sha256: digest(row.document_sha256),
    meeting_date: isoDay(row.meeting_date),
    meeting_date_state: clean(row.meeting_date_state, 40),
    extracted_text_sha256: digest(row.extracted_text_sha256),
    candidate_blocks_observed: count(row.candidate_blocks_observed) ?? 0,
    observed_on: isoDay(row.observed_on),
  });
}

function authorityProjection(row) {
  if (!row || typeof row !== "object") return null;
  const name = clean(row.authority_name, 300);
  if (!name) return null;
  return Object.freeze({
    authority_name: name,
    relation: clean(row.relation, 40) === "proposal_from" ? "proposal_from" : "application_before",
    review_regime: clean(row.review_regime, 80) || null,
    case_number: clean(row.case_number, 120) || null,
    is_ulurp: row.is_ulurp === true,
  });
}

/**
 * Project one reviewed candidate.
 *
 * A candidate becomes a published decision only when the review marked it so
 * and the evidence survives on its own: a document with a stated meeting date,
 * a quoted operative passage, and at least one tally that owns the motion. A
 * candidate failing any of those is held with the reason, never dropped.
 */
export function projectCommunityBoardResolutionCandidate(candidate = {}, review = {}) {
  const boardId = clean(candidate.board_id, 80).toLowerCase();
  const documentId = clean(candidate.document_id, 200);
  const candidateId = clean(candidate.candidate_id, 300);
  const source = documentOf(review, documentId);
  const base = {
    candidate_id: candidateId || null,
    board_id: BODY_ID.test(boardId) ? boardId : null,
    document_id: documentId || null,
    title: clean(candidate.title, 500) || null,
    position: COMMUNITY_BOARD_DECISION_POSITIONS.includes(clean(candidate.position, 60))
      ? clean(candidate.position, 60)
      : "unclassified",
  };
  if (!base.candidate_id || !base.board_id || !source) {
    return { ...base, admission: "held", held_reason: "candidate_source_identity_incomplete" };
  }

  const document = documentProjection(source);
  const votes = selectCommunityBoardDecisionVotes(candidate);
  const address = communityBoardDecisionAddressConflict(candidate);
  const passages = (Array.isArray(candidate.passages) ? candidate.passages : [])
    .map(passage)
    .filter(Boolean);
  const notes = (Array.isArray(candidate.non_adopted_notes) ? candidate.non_adopted_notes : [])
    .map((row) => {
      const value = passage({ ...row, role: row.classification });
      return value ? Object.freeze({ ...value, classification: value.role }) : null;
    })
    .filter(Boolean);

  const held = {
    ...base,
    admission: "held",
    document,
    votes: votes.votes,
    excluded_votes: votes.excluded_votes,
    address,
    held_reason: clean(candidate.held_reason, 120) || null,
  };

  if (clean(candidate.admission, 40) !== "published") {
    return { ...held, held_reason: held.held_reason || "not_reviewed_in_this_pilot" };
  }
  // A decision has to be attachable to the meeting that took it. A document
  // stating no meeting date is retained, but no event identity is guessed for
  // it, so nothing from it is published as a dated board decision.
  if (!document.meeting_date || document.meeting_date_state !== "stated_in_document") {
    return { ...held, held_reason: "document_states_no_meeting_date" };
  }
  if (!document.document_url) return { ...held, held_reason: "no_published_source_document" };
  if (!passages.some((row) => row.role !== "title")) {
    return { ...held, held_reason: "no_reviewed_source_passage" };
  }
  if (!votes.votes.length) return { ...held, held_reason: "no_tally_owns_this_motion" };
  if (address.conflicting) return { ...held, held_reason: "conflicting_address_assertions" };

  return Object.freeze({
    ...base,
    admission: "published",
    document,
    agenda_item_label: clean(candidate.agenda_item_label, 300) || null,
    agenda_item_text: clean(candidate.agenda_item_text, 1_000) || null,
    passages: Object.freeze(passages),
    passage_boundary: candidate.passage_boundary && typeof candidate.passage_boundary === "object"
      ? Object.freeze({
        ends_before_source_line: count(candidate.passage_boundary.ends_before_source_line),
        next_block_first_line: clean(candidate.passage_boundary.next_block_first_line, 500) || null,
      })
      : null,
    votes: votes.votes,
    excluded_votes: votes.excluded_votes,
    has_committee_vote: votes.has_committee_vote,
    has_full_board_vote: votes.has_full_board_vote,
    authority: authorityProjection(candidate.authority),
    address,
    non_adopted_notes: Object.freeze(notes),
    subject_topics: Object.freeze((Array.isArray(candidate.subject_topics) ? candidate.subject_topics : [])
      .map((row) => clean(row, 120))
      .filter(Boolean)),
  });
}

/**
 * Build the whole pilot from its reviewed input.
 *
 * Published decisions and held candidates come out of one pass so the counts
 * always agree: every reviewed candidate is accounted for as one or the other,
 * and the coverage block states the bound in the pilot's own terms.
 */
export function buildCommunityBoardResolutionPilot(review = {}) {
  if (review?.schema !== COMMUNITY_BOARD_RESOLUTION_REVIEW_SCHEMA) {
    throw new Error("unsupported community board resolution review input");
  }
  const documents = (Array.isArray(review.documents) ? review.documents : []).map(documentProjection);
  const projected = (Array.isArray(review.candidates) ? review.candidates : [])
    .map((candidate) => projectCommunityBoardResolutionCandidate(candidate, review));
  const decisions = projected.filter((row) => row.admission === "published");
  const held = projected.filter((row) => row.admission !== "published");
  const heldReasons = {};
  for (const row of held) {
    const reason = row.held_reason || "unstated";
    heldReasons[reason] = (heldReasons[reason] || 0) + 1;
  }
  return {
    schema: COMMUNITY_BOARD_RESOLUTION_PILOT_SCHEMA,
    version: 1,
    reviewed_on: isoDay(review.reviewed_on),
    scope: clean(review.scope, 1_000),
    documents,
    decisions,
    held_candidates: held,
    coverage: {
      documents: documents.length,
      boards: [...new Set(documents.map((row) => row.board_id))].length,
      candidate_blocks_observed: documents.reduce((sum, row) => sum + row.candidate_blocks_observed, 0),
      candidates_reviewed: projected.length,
      decisions_published: decisions.length,
      candidates_held: held.length,
      held_reasons: Object.fromEntries(
        Object.entries(heldReasons).sort(([left], [right]) => left.localeCompare(right, "en-US")),
      ),
    },
  };
}

/**
 * The resident read model: published decisions only.
 *
 * Held candidates are review material. They carry a board's unfinished
 * reasoning and, in one case, an address the source itself contradicts, so they
 * stay out of the public artifact entirely rather than being filtered at render
 * time where a later caller could reach past the filter.
 */
export function publicCommunityBoardResolutionPilot(pilot = {}) {
  if (pilot?.schema !== COMMUNITY_BOARD_RESOLUTION_PILOT_SCHEMA) {
    throw new Error("unsupported community board resolution pilot");
  }
  const decisions = pilot.decisions || [];
  const boardIds = [...new Set(decisions.map((row) => row.board_id))].sort();
  return {
    schema: COMMUNITY_BOARD_RESOLUTION_PILOT_SCHEMA,
    version: 1,
    reviewed_on: pilot.reviewed_on,
    scope: pilot.scope,
    documents: pilot.documents,
    by_board: Object.fromEntries(boardIds.map((boardId) => [
      boardId,
      decisions.filter((row) => row.board_id === boardId),
    ])),
    coverage: {
      documents: pilot.coverage.documents,
      boards: pilot.coverage.boards,
      candidate_blocks_observed: pilot.coverage.candidate_blocks_observed,
      decisions_published: pilot.coverage.decisions_published,
      candidates_held: pilot.coverage.candidates_held,
    },
  };
}

/** The review queue, held candidates and all: an authenticated operator read. */
export function communityBoardResolutionReviewQueue(pilot = {}) {
  if (pilot?.schema !== COMMUNITY_BOARD_RESOLUTION_PILOT_SCHEMA) {
    throw new Error("unsupported community board resolution pilot");
  }
  return {
    schema: COMMUNITY_BOARD_RESOLUTION_REVIEW_QUEUE_SCHEMA,
    version: 1,
    reviewed_on: pilot.reviewed_on,
    documents: pilot.documents,
    held_candidates: pilot.held_candidates,
    coverage: pilot.coverage,
  };
}

/** The per-board view a board document renders, or null when the board has none. */
export function communityBoardResolutionViewForBoard(publicPilot, boardIdValue) {
  const boardId = clean(boardIdValue, 80).toLowerCase();
  if (!BODY_ID.test(boardId)) return null;
  if (publicPilot?.schema !== COMMUNITY_BOARD_RESOLUTION_PILOT_SCHEMA) return null;
  const decisions = publicPilot.by_board?.[boardId] || [];
  if (!decisions.length) return null;
  return {
    schema: COMMUNITY_BOARD_RESOLUTION_VIEW_SCHEMA,
    board_id: boardId,
    reviewed_on: publicPilot.reviewed_on || null,
    decisions,
    documents_read: (publicPilot.documents || []).filter((row) => row.board_id === boardId).length,
  };
}

/**
 * The issue words a decision is actually about, for the board's search text.
 *
 * A resident looking for a bike lane decision searches for the street, not for
 * the board. These come only from published decisions, so a search never
 * surfaces a board on the strength of a candidate it did not decide.
 */
export function communityBoardResolutionSearchTopics(publicPilot, boardIdValue) {
  const view = communityBoardResolutionViewForBoard(publicPilot, boardIdValue);
  if (!view) return [];
  const topics = [];
  for (const decision of view.decisions) {
    topics.push(...(decision.subject_topics || []));
    if (decision.authority?.authority_name) topics.push(decision.authority.authority_name);
    if (decision.authority?.case_number) topics.push(decision.authority.case_number);
  }
  return [...new Set(topics.map((row) => clean(row, 120)).filter(Boolean))];
}

/**
 * The Intl locale each shipping language formats dates in, matching the site's
 * own language metadata: Haitian Creole has no CLDR locale and uses fr-HT, and
 * Arabic and Urdu pin Western digits with the `-u-nu-latn` extension.
 */
const DATE_LOCALES = Object.freeze({
  en: "en-US",
  es: "es",
  fr: "fr",
  ht: "fr-HT",
  ru: "ru",
  bn: "bn",
  "zh-Hans": "zh-Hans",
  ko: "ko",
  ar: "ar-u-nu-latn",
  ur: "ur-u-nu-latn",
  pl: "pl",
});

const EXCLUSION_KEYS = Object.freeze({
  referral_motion_on_another_item: "cbrp_excluded_referral",
  amendment_to_another_item: "cbrp_excluded_amendment",
  omnibus_that_excludes_this_item: "cbrp_excluded_omnibus",
  another_item: "cbrp_excluded_other_item",
  motion_did_not_pass: "cbrp_excluded_failed",
  tally_does_not_name_this_item: "cbrp_excluded_unnamed",
  tally_states_no_subject: "cbrp_excluded_unnamed",
  unrecognised_vote_stage: "cbrp_excluded_unnamed",
  not_this_item: "cbrp_excluded_unnamed",
});

const OWNERSHIP_KEYS = Object.freeze({
  names_this_item: "cbrp_vote_named",
  omnibus_that_covers_this_item: "cbrp_vote_omnibus",
  sole_motion_in_this_section: "cbrp_vote_sole_motion",
});

const POSITION_KEYS = Object.freeze({
  supports: "cbrp_position_supports",
  approves: "cbrp_position_approves",
  recommends_denial_unless_conditions: "cbrp_position_conditions",
  opposes: "cbrp_position_opposes",
  unclassified: "cbrp_position_unclassified",
});
const STRINGS = {
  en: {
    cbrp_heading: "Decisions recorded in this board's own documents",
    cbrp_lede_one: "One decision, read in full from a document this board published.",
    cbrp_lede: "{count} decisions, read in full from documents this board published.",
    cbrp_boundary: "These documents were read one at a time. This is not everything the board has decided, and a decision recorded here says nothing about what the city did afterwards.",
    cbrp_meeting: "Meeting of {date}",
    cbrp_position_supports: "The board voted to support this proposal.",
    cbrp_position_approves: "The board voted to approve this application.",
    cbrp_position_conditions: "The board voted to recommend denial unless the applicant agrees to conditions.",
    cbrp_position_opposes: "The board voted to oppose this proposal.",
    cbrp_position_unclassified: "The board recorded a vote on this item.",
    cbrp_vote_committee: "Committee vote: {yes} in favour, {no} against, {abstain} abstaining.",
    cbrp_vote_full_board: "Full board vote: {yes} in favour, {no} against, {abstain} abstaining.",
    cbrp_vote_pnv: "{count} present and not voting.",
    cbrp_vote_named: "The document records this tally against {subject}.",
    cbrp_vote_two_stage: "The committee vote and the full board vote are separate records. Neither one replaces the other.",
    cbrp_excluded_one: "The same document records one other tally. It is not this decision.",
    cbrp_excluded: "The same document records {count} other tallies. None of them is this decision.",
    cbrp_excluded_referral: "A motion to send a different item to another committee.",
    cbrp_excluded_amendment: "An amendment to a different item.",
    cbrp_excluded_omnibus: "One vote taken on the other items, expressly excluding this one.",
    cbrp_excluded_other_item: "A vote on a different item.",
    cbrp_excluded_failed: "A motion that did not pass.",
    cbrp_excluded_unnamed: "A tally the document does not record against this item.",
    cbrp_excluded_open: "Show the votes that are not this decision",
    cbrp_excluded_close: "Hide the votes that are not this decision",
    cbrp_vote_omnibus: "This tally is a single vote on a block of items, and its own wording does not except this one.",
    cbrp_vote_sole_motion: "The document records this tally directly after the only motion in this section.",
    cbrp_authority_proposal: "The proposal comes from {authority}.",
    cbrp_authority: "The application is before {authority}.",
    cbrp_case: "Case {case}.",
    cbrp_not_ulurp: "This is not a ULURP land use review, so no ULURP timetable applies to it.",
    cbrp_not_condition: "A suggestion raised in discussion is not a condition the board adopted.",
    cbrp_passage_open: "Show the words the board voted on",
    cbrp_passage_close: "Hide the words the board voted on",
    cbrp_passage_heading: "From the published document",
    cbrp_source: "{publisher}, {label}.",
    cbrp_source_link: "Open the published document",
    cbrp_read_note: "Quoted from the published document exactly as it appears there.",
  },
  es: {
    cbrp_heading: "Decisiones registradas en los documentos de esta junta",
    cbrp_lede_one: "Una decisión, leída íntegramente en un documento publicado por esta junta.",
    cbrp_lede: "{count} decisiones, leídas íntegramente en documentos publicados por esta junta.",
    cbrp_boundary: "Estos documentos se leyeron uno por uno. No es todo lo que la junta ha decidido, y una decisión registrada aquí no dice nada sobre lo que la ciudad hizo después.",
    cbrp_meeting: "Reunión del {date}",
    cbrp_position_supports: "La junta votó a favor de apoyar esta propuesta.",
    cbrp_position_approves: "La junta votó a favor de aprobar esta solicitud.",
    cbrp_position_conditions: "La junta votó recomendar la denegación salvo que el solicitante acepte condiciones.",
    cbrp_position_opposes: "La junta votó oponerse a esta propuesta.",
    cbrp_position_unclassified: "La junta registró una votación sobre este punto.",
    cbrp_vote_committee: "Votación del comité: {yes} a favor, {no} en contra, {abstain} abstenciones.",
    cbrp_vote_full_board: "Votación del pleno: {yes} a favor, {no} en contra, {abstain} abstenciones.",
    cbrp_vote_pnv: "{count} presentes sin votar.",
    cbrp_vote_named: "El documento registra este recuento para {subject}.",
    cbrp_vote_two_stage: "La votación del comité y la del pleno son registros distintos. Ninguna sustituye a la otra.",
    cbrp_excluded_one: "El mismo documento registra otro recuento. No es esta decisión.",
    cbrp_excluded: "El mismo documento registra otros {count} recuentos. Ninguno es esta decisión.",
    cbrp_excluded_referral: "Una moción para enviar otro punto a otro comité.",
    cbrp_excluded_amendment: "Una enmienda a otro punto.",
    cbrp_excluded_omnibus: "Una sola votación sobre los demás puntos, excluyendo expresamente este.",
    cbrp_excluded_other_item: "Una votación sobre otro punto.",
    cbrp_excluded_failed: "Una moción que no prosperó.",
    cbrp_excluded_unnamed: "Un recuento que el documento no registra para este punto.",
    cbrp_excluded_open: "Mostrar las votaciones que no son esta decisión",
    cbrp_excluded_close: "Ocultar las votaciones que no son esta decisión",
    cbrp_vote_omnibus: "Este recuento es una sola votación sobre un bloque de puntos, y su propia redacción no excluye este.",
    cbrp_vote_sole_motion: "El documento registra este recuento justo después de la única moción de esta sección.",
    cbrp_authority_proposal: "La propuesta procede de {authority}.",
    cbrp_authority: "La solicitud está ante {authority}.",
    cbrp_case: "Expediente {case}.",
    cbrp_not_ulurp: "Esto no es una revisión de uso del suelo ULURP, así que no le aplica ningún plazo de ULURP.",
    cbrp_not_condition: "Una sugerencia planteada en el debate no es una condición adoptada por la junta.",
    cbrp_passage_open: "Mostrar las palabras que la junta votó",
    cbrp_passage_close: "Ocultar las palabras que la junta votó",
    cbrp_passage_heading: "Del documento publicado",
    cbrp_source: "{publisher}, {label}.",
    cbrp_source_link: "Abrir el documento publicado",
    cbrp_read_note: "Citado del documento publicado exactamente como aparece allí.",
  },
  "zh-Hans": {
    cbrp_heading: "本委员会文件中记录的决定",
    cbrp_lede_one: "1 项决定，完整读自本委员会公布的一份文件。",
    cbrp_lede: "{count} 项决定，完整读自本委员会公布的文件。",
    cbrp_boundary: "这些文件是逐份阅读的。这并非本委员会作出的全部决定，此处记录的决定也不说明市政府之后做了什么。",
    cbrp_meeting: "{date} 的会议",
    cbrp_position_supports: "委员会投票支持该提案。",
    cbrp_position_approves: "委员会投票批准该申请。",
    cbrp_position_conditions: "委员会投票建议驳回，除非申请人同意附加条件。",
    cbrp_position_opposes: "委员会投票反对该提案。",
    cbrp_position_unclassified: "委员会就该事项记录了一次表决。",
    cbrp_vote_committee: "小组委员会表决：赞成 {yes} 票，反对 {no} 票，弃权 {abstain} 票。",
    cbrp_vote_full_board: "全体会议表决：赞成 {yes} 票，反对 {no} 票，弃权 {abstain} 票。",
    cbrp_vote_pnv: "{count} 人出席但未投票。",
    cbrp_vote_named: "文件将此计票记在 {subject} 名下。",
    cbrp_vote_two_stage: "小组委员会表决与全体会议表决是两项独立记录，彼此不能替代。",
    cbrp_excluded_one: "同一份文件还记录了另外 1 次计票。那不是本项决定。",
    cbrp_excluded: "同一份文件还记录了另外 {count} 次计票。其中没有一次是本项决定。",
    cbrp_excluded_referral: "一项将另一事项转交其他小组委员会的动议。",
    cbrp_excluded_amendment: "对另一事项的修正案。",
    cbrp_excluded_omnibus: "对其余事项一并表决，并明确排除本事项。",
    cbrp_excluded_other_item: "对另一事项的表决。",
    cbrp_excluded_failed: "一项未获通过的动议。",
    cbrp_excluded_unnamed: "文件未记在本事项名下的计票。",
    cbrp_excluded_open: "显示不属于本项决定的表决",
    cbrp_excluded_close: "隐藏不属于本项决定的表决",
    cbrp_vote_omnibus: "此计票是对一组事项的一次性表决，其措辞并未排除本事项。",
    cbrp_vote_sole_motion: "文件将此计票记录在本节唯一一项动议之后。",
    cbrp_authority_proposal: "该提案来自 {authority}。",
    cbrp_authority: "该申请由 {authority} 审理。",
    cbrp_case: "案卷 {case}。",
    cbrp_not_ulurp: "这不是 ULURP 土地使用审查，因此不适用 ULURP 的时限。",
    cbrp_not_condition: "讨论中提出的建议并不是委员会通过的条件。",
    cbrp_passage_open: "显示委员会所表决的原文",
    cbrp_passage_close: "隐藏委员会所表决的原文",
    cbrp_passage_heading: "摘自公布的文件",
    cbrp_source: "{publisher}，{label}。",
    cbrp_source_link: "打开公布的文件",
    cbrp_read_note: "按公布文件的原样引用。",
  },
  ru: {
    cbrp_heading: "Решения, зафиксированные в документах самого совета",
    cbrp_lede_one: "Одно решение, прочитанное целиком в документе, опубликованном этим советом.",
    cbrp_lede: "Решений, прочитанных целиком в опубликованных советом документах: {count}.",
    cbrp_boundary: "Эти документы читались по одному. Это не все решения совета, и записанное здесь решение ничего не говорит о том, что город сделал потом.",
    cbrp_meeting: "Заседание {date}",
    cbrp_position_supports: "Совет проголосовал за поддержку этого предложения.",
    cbrp_position_approves: "Совет проголосовал за одобрение этой заявки.",
    cbrp_position_conditions: "Совет проголосовал рекомендовать отказ, если заявитель не согласится на условия.",
    cbrp_position_opposes: "Совет проголосовал против этого предложения.",
    cbrp_position_unclassified: "Совет зафиксировал голосование по этому пункту.",
    cbrp_vote_committee: "Голосование комитета: за — {yes}, против — {no}, воздержались — {abstain}.",
    cbrp_vote_full_board: "Голосование полного состава: за — {yes}, против — {no}, воздержались — {abstain}.",
    cbrp_vote_pnv: "Присутствовали и не голосовали: {count}.",
    cbrp_vote_named: "Документ относит этот подсчёт к {subject}.",
    cbrp_vote_two_stage: "Голосование комитета и голосование полного состава — отдельные записи. Одна не заменяет другую.",
    cbrp_excluded_one: "В том же документе есть ещё один подсчёт. Это не данное решение.",
    cbrp_excluded: "В том же документе есть ещё подсчётов: {count}. Ни один из них не относится к данному решению.",
    cbrp_excluded_referral: "Предложение передать другой пункт в другой комитет.",
    cbrp_excluded_amendment: "Поправка к другому пункту.",
    cbrp_excluded_omnibus: "Одно голосование по остальным пунктам, прямо исключающее этот.",
    cbrp_excluded_other_item: "Голосование по другому пункту.",
    cbrp_excluded_failed: "Предложение, которое не прошло.",
    cbrp_excluded_unnamed: "Подсчёт, который документ не относит к этому пункту.",
    cbrp_excluded_open: "Показать голосования, не относящиеся к этому решению",
    cbrp_excluded_close: "Скрыть голосования, не относящиеся к этому решению",
    cbrp_vote_omnibus: "Этот подсчёт — одно голосование по блоку пунктов, и его собственная формулировка не исключает данный пункт.",
    cbrp_vote_sole_motion: "Документ фиксирует этот подсчёт сразу после единственного предложения в этом разделе.",
    cbrp_authority_proposal: "Предложение исходит от {authority}.",
    cbrp_authority: "Заявку рассматривает {authority}.",
    cbrp_case: "Дело {case}.",
    cbrp_not_ulurp: "Это не рассмотрение по процедуре ULURP, поэтому сроки ULURP к нему не применяются.",
    cbrp_not_condition: "Предложение, высказанное в обсуждении, не является условием, принятым советом.",
    cbrp_passage_open: "Показать текст, за который голосовал совет",
    cbrp_passage_close: "Скрыть текст, за который голосовал совет",
    cbrp_passage_heading: "Из опубликованного документа",
    cbrp_source: "{publisher}, {label}.",
    cbrp_source_link: "Открыть опубликованный документ",
    cbrp_read_note: "Цитируется из опубликованного документа в точности так, как там напечатано.",
  },
  bn: {
    cbrp_heading: "এই বোর্ডের নিজস্ব নথিতে নথিভুক্ত সিদ্ধান্ত",
    cbrp_lede_one: "একটি সিদ্ধান্ত, এই বোর্ডের প্রকাশিত একটি নথি থেকে সম্পূর্ণ পড়া।",
    cbrp_lede: "{count}টি সিদ্ধান্ত, এই বোর্ডের প্রকাশিত নথি থেকে সম্পূর্ণ পড়া।",
    cbrp_boundary: "এই নথিগুলি একটি একটি করে পড়া হয়েছে। বোর্ড যা যা সিদ্ধান্ত নিয়েছে এটি তার সবটা নয়, আর এখানে নথিভুক্ত সিদ্ধান্ত শহর পরে কী করেছে সে বিষয়ে কিছু বলে না।",
    cbrp_meeting: "{date} তারিখের সভা",
    cbrp_position_supports: "বোর্ড এই প্রস্তাব সমর্থনের পক্ষে ভোট দিয়েছে।",
    cbrp_position_approves: "বোর্ড এই আবেদন অনুমোদনের পক্ষে ভোট দিয়েছে।",
    cbrp_position_conditions: "আবেদনকারী শর্তে রাজি না হলে আবেদন নাকচের সুপারিশ করতে বোর্ড ভোট দিয়েছে।",
    cbrp_position_opposes: "বোর্ড এই প্রস্তাবের বিরোধিতায় ভোট দিয়েছে।",
    cbrp_position_unclassified: "বোর্ড এই বিষয়ে একটি ভোট নথিভুক্ত করেছে।",
    cbrp_vote_committee: "কমিটির ভোট: পক্ষে {yes}, বিপক্ষে {no}, ভোটদানে বিরত {abstain}।",
    cbrp_vote_full_board: "পূর্ণ বোর্ডের ভোট: পক্ষে {yes}, বিপক্ষে {no}, ভোটদানে বিরত {abstain}।",
    cbrp_vote_pnv: "{count} জন উপস্থিত থেকেও ভোট দেননি।",
    cbrp_vote_named: "নথিটি এই গণনা {subject}-এর নামে রেখেছে।",
    cbrp_vote_two_stage: "কমিটির ভোট ও পূর্ণ বোর্ডের ভোট আলাদা নথি। একটি অন্যটির বিকল্প নয়।",
    cbrp_excluded_one: "একই নথিতে আরও একটি গণনা আছে। সেটি এই সিদ্ধান্ত নয়।",
    cbrp_excluded: "একই নথিতে আরও {count}টি গণনা আছে। তার কোনোটিই এই সিদ্ধান্ত নয়।",
    cbrp_excluded_referral: "অন্য একটি বিষয় আরেক কমিটিতে পাঠানোর প্রস্তাব।",
    cbrp_excluded_amendment: "অন্য একটি বিষয়ের সংশোধনী।",
    cbrp_excluded_omnibus: "বাকি বিষয়গুলির উপর একটি ভোট, যেখানে এই বিষয়টি স্পষ্টভাবে বাদ দেওয়া হয়েছে।",
    cbrp_excluded_other_item: "অন্য একটি বিষয়ের উপর ভোট।",
    cbrp_excluded_failed: "যে প্রস্তাব পাস হয়নি।",
    cbrp_excluded_unnamed: "নথিটি এই বিষয়ের নামে রাখেনি এমন একটি গণনা।",
    cbrp_excluded_open: "এই সিদ্ধান্ত নয় এমন ভোটগুলি দেখুন",
    cbrp_excluded_close: "এই সিদ্ধান্ত নয় এমন ভোটগুলি লুকান",
    cbrp_vote_omnibus: "এই গণনা একগুচ্ছ বিষয়ের উপর একটিমাত্র ভোট, আর তার নিজস্ব ভাষায় এই বিষয়টি বাদ দেওয়া হয়নি।",
    cbrp_vote_sole_motion: "নথিটি এই গণনা এই অংশের একমাত্র প্রস্তাবের ঠিক পরেই নথিভুক্ত করেছে।",
    cbrp_authority_proposal: "প্রস্তাবটি এসেছে {authority} থেকে।",
    cbrp_authority: "আবেদনটি {authority}-এর সামনে রয়েছে।",
    cbrp_case: "মামলা {case}।",
    cbrp_not_ulurp: "এটি ULURP ভূমি ব্যবহার পর্যালোচনা নয়, তাই এতে কোনো ULURP সময়সূচি প্রযোজ্য নয়।",
    cbrp_not_condition: "আলোচনায় তোলা কোনো পরামর্শ বোর্ডের গৃহীত শর্ত নয়।",
    cbrp_passage_open: "বোর্ড যে শব্দগুলিতে ভোট দিয়েছে তা দেখুন",
    cbrp_passage_close: "বোর্ড যে শব্দগুলিতে ভোট দিয়েছে তা লুকান",
    cbrp_passage_heading: "প্রকাশিত নথি থেকে",
    cbrp_source: "{publisher}, {label}।",
    cbrp_source_link: "প্রকাশিত নথি খুলুন",
    cbrp_read_note: "প্রকাশিত নথিতে যেভাবে আছে ঠিক সেভাবেই উদ্ধৃত।",
  },
  ht: {
    cbrp_heading: "Desizyon ki anrejistre nan pwòp dokiman konsèy sa a",
    cbrp_lede_one: "Yon desizyon, li nèt nan yon dokiman konsèy sa a pibliye.",
    cbrp_lede: "{count} desizyon, li nèt nan dokiman konsèy sa a pibliye.",
    cbrp_boundary: "Nou te li dokiman sa yo youn apre lòt. Se pa tout sa konsèy la deside, e yon desizyon ki anrejistre isit la pa di anyen sou sa vil la fè apre.",
    cbrp_meeting: "Reyinyon {date}",
    cbrp_position_supports: "Konsèy la vote pou sipòte pwopozisyon sa a.",
    cbrp_position_approves: "Konsèy la vote pou apwouve demann sa a.",
    cbrp_position_conditions: "Konsèy la vote pou rekòmande refi a sof si moun k ap fè demann nan aksepte kondisyon yo.",
    cbrp_position_opposes: "Konsèy la vote kont pwopozisyon sa a.",
    cbrp_position_unclassified: "Konsèy la anrejistre yon vòt sou pwen sa a.",
    cbrp_vote_committee: "Vòt komite a: {yes} pou, {no} kont, {abstain} abstansyon.",
    cbrp_vote_full_board: "Vòt tout konsèy la: {yes} pou, {no} kont, {abstain} abstansyon.",
    cbrp_vote_pnv: "{count} prezan men yo pa vote.",
    cbrp_vote_named: "Dokiman an mete kontaj sa a sou {subject}.",
    cbrp_vote_two_stage: "Vòt komite a ak vòt tout konsèy la se de anrejistreman separe. Youn pa ranplase lòt.",
    cbrp_excluded_one: "Menm dokiman an gen yon lòt kontaj. Se pa desizyon sa a.",
    cbrp_excluded: "Menm dokiman an gen {count} lòt kontaj. Okenn ladan yo se pa desizyon sa a.",
    cbrp_excluded_referral: "Yon mosyon pou voye yon lòt pwen bay yon lòt komite.",
    cbrp_excluded_amendment: "Yon amandman sou yon lòt pwen.",
    cbrp_excluded_omnibus: "Yon sèl vòt sou lòt pwen yo, ki eksklizyon pwen sa a klèman.",
    cbrp_excluded_other_item: "Yon vòt sou yon lòt pwen.",
    cbrp_excluded_failed: "Yon mosyon ki pa t pase.",
    cbrp_excluded_unnamed: "Yon kontaj dokiman an pa mete sou pwen sa a.",
    cbrp_excluded_open: "Montre vòt ki pa desizyon sa a",
    cbrp_excluded_close: "Kache vòt ki pa desizyon sa a",
    cbrp_vote_omnibus: "Kontaj sa a se yon sèl vòt sou yon gwoup pwen, e pwòp mo li yo pa eksklizyon pwen sa a.",
    cbrp_vote_sole_motion: "Dokiman an anrejistre kontaj sa a jis apre sèl mosyon ki nan seksyon sa a.",
    cbrp_authority_proposal: "Pwopozisyon an soti nan {authority}.",
    cbrp_authority: "Demann nan devan {authority}.",
    cbrp_case: "Dosye {case}.",
    cbrp_not_ulurp: "Sa a se pa yon revizyon itilizasyon tè ULURP, kidonk okenn dele ULURP pa aplike.",
    cbrp_not_condition: "Yon sijesyon moun te leve nan diskisyon an se pa yon kondisyon konsèy la adopte.",
    cbrp_passage_open: "Montre mo konsèy la te vote yo",
    cbrp_passage_close: "Kache mo konsèy la te vote yo",
    cbrp_passage_heading: "Nan dokiman pibliye a",
    cbrp_source: "{publisher}, {label}.",
    cbrp_source_link: "Louvri dokiman pibliye a",
    cbrp_read_note: "Site nan dokiman pibliye a egzakteman jan li parèt la.",
  },
  ko: {
    cbrp_heading: "이 위원회 문서에 기록된 결정",
    cbrp_lede_one: "이 위원회가 공개한 문서에서 전문을 읽은 결정 1건입니다.",
    cbrp_lede: "이 위원회가 공개한 문서에서 전문을 읽은 결정 {count}건입니다.",
    cbrp_boundary: "이 문서들은 한 건씩 읽었습니다. 위원회가 내린 결정 전부는 아니며, 여기 기록된 결정이 시가 그 뒤에 무엇을 했는지 말해 주지는 않습니다.",
    cbrp_meeting: "{date} 회의",
    cbrp_position_supports: "위원회는 이 제안을 지지하기로 표결했습니다.",
    cbrp_position_approves: "위원회는 이 신청을 승인하기로 표결했습니다.",
    cbrp_position_conditions: "위원회는 신청인이 조건에 동의하지 않으면 거부를 권고하기로 표결했습니다.",
    cbrp_position_opposes: "위원회는 이 제안에 반대하기로 표결했습니다.",
    cbrp_position_unclassified: "위원회는 이 안건에 대한 표결을 기록했습니다.",
    cbrp_vote_committee: "소위원회 표결: 찬성 {yes}, 반대 {no}, 기권 {abstain}.",
    cbrp_vote_full_board: "전체 위원회 표결: 찬성 {yes}, 반대 {no}, 기권 {abstain}.",
    cbrp_vote_pnv: "출석했으나 표결하지 않은 인원 {count}명.",
    cbrp_vote_named: "문서는 이 집계를 {subject} 앞으로 기록합니다.",
    cbrp_vote_two_stage: "소위원회 표결과 전체 위원회 표결은 별개의 기록입니다. 어느 쪽도 다른 쪽을 대신하지 않습니다.",
    cbrp_excluded_one: "같은 문서에 다른 집계가 1건 더 있습니다. 그것은 이 결정이 아닙니다.",
    cbrp_excluded: "같은 문서에 다른 집계가 {count}건 더 있습니다. 그중 어느 것도 이 결정이 아닙니다.",
    cbrp_excluded_referral: "다른 안건을 별도 소위원회로 보내자는 동의입니다.",
    cbrp_excluded_amendment: "다른 안건에 대한 수정안입니다.",
    cbrp_excluded_omnibus: "이 안건을 명시적으로 제외하고 나머지 안건을 한꺼번에 표결한 것입니다.",
    cbrp_excluded_other_item: "다른 안건에 대한 표결입니다.",
    cbrp_excluded_failed: "부결된 동의입니다.",
    cbrp_excluded_unnamed: "문서가 이 안건 앞으로 기록하지 않은 집계입니다.",
    cbrp_excluded_open: "이 결정이 아닌 표결 보기",
    cbrp_excluded_close: "이 결정이 아닌 표결 숨기기",
    cbrp_vote_omnibus: "이 집계는 여러 안건을 묶어 한 번에 한 표결이며, 그 문구 자체가 이 안건을 제외하지 않습니다.",
    cbrp_vote_sole_motion: "문서는 이 집계를 이 절의 유일한 동의 바로 뒤에 기록합니다.",
    cbrp_authority_proposal: "이 제안은 {authority}에서 나왔습니다.",
    cbrp_authority: "이 신청은 {authority} 소관입니다.",
    cbrp_case: "사건 {case}.",
    cbrp_not_ulurp: "이것은 ULURP 토지이용 심사가 아니므로 ULURP 기한이 적용되지 않습니다.",
    cbrp_not_condition: "논의 중 나온 제안은 위원회가 채택한 조건이 아닙니다.",
    cbrp_passage_open: "위원회가 표결한 문구 보기",
    cbrp_passage_close: "위원회가 표결한 문구 숨기기",
    cbrp_passage_heading: "공개된 문서에서",
    cbrp_source: "{publisher}, {label}.",
    cbrp_source_link: "공개된 문서 열기",
    cbrp_read_note: "공개된 문서에 나온 그대로 인용했습니다.",
  },
  fr: {
    cbrp_heading: "Décisions consignées dans les documents de ce conseil",
    cbrp_lede_one: "Une décision, lue intégralement dans un document publié par ce conseil.",
    cbrp_lede: "{count} décisions, lues intégralement dans des documents publiés par ce conseil.",
    cbrp_boundary: "Ces documents ont été lus un par un. Ce n'est pas tout ce que le conseil a décidé, et une décision consignée ici ne dit rien de ce que la ville a fait ensuite.",
    cbrp_meeting: "Réunion du {date}",
    cbrp_position_supports: "Le conseil a voté en faveur de cette proposition.",
    cbrp_position_approves: "Le conseil a voté l'approbation de cette demande.",
    cbrp_position_conditions: "Le conseil a voté de recommander le refus à moins que le demandeur n'accepte des conditions.",
    cbrp_position_opposes: "Le conseil a voté contre cette proposition.",
    cbrp_position_unclassified: "Le conseil a consigné un vote sur ce point.",
    cbrp_vote_committee: "Vote du comité : {yes} pour, {no} contre, {abstain} abstentions.",
    cbrp_vote_full_board: "Vote du conseil plénier : {yes} pour, {no} contre, {abstain} abstentions.",
    cbrp_vote_pnv: "{count} présents sans voter.",
    cbrp_vote_named: "Le document rattache ce décompte à {subject}.",
    cbrp_vote_two_stage: "Le vote du comité et celui du conseil plénier sont deux enregistrements distincts. Aucun ne remplace l'autre.",
    cbrp_excluded_one: "Le même document consigne un autre décompte. Ce n'est pas cette décision.",
    cbrp_excluded: "Le même document consigne {count} autres décomptes. Aucun n'est cette décision.",
    cbrp_excluded_referral: "Une motion pour renvoyer un autre point à un autre comité.",
    cbrp_excluded_amendment: "Un amendement portant sur un autre point.",
    cbrp_excluded_omnibus: "Un vote unique sur les autres points, excluant expressément celui-ci.",
    cbrp_excluded_other_item: "Un vote sur un autre point.",
    cbrp_excluded_failed: "Une motion qui n'a pas été adoptée.",
    cbrp_excluded_unnamed: "Un décompte que le document ne rattache pas à ce point.",
    cbrp_excluded_open: "Afficher les votes qui ne sont pas cette décision",
    cbrp_excluded_close: "Masquer les votes qui ne sont pas cette décision",
    cbrp_vote_omnibus: "Ce décompte est un vote unique sur un bloc de points, et sa propre formulation n'excepte pas celui-ci.",
    cbrp_vote_sole_motion: "Le document consigne ce décompte juste après l'unique motion de cette section.",
    cbrp_authority_proposal: "La proposition émane de {authority}.",
    cbrp_authority: "La demande est devant {authority}.",
    cbrp_case: "Dossier {case}.",
    cbrp_not_ulurp: "Il ne s'agit pas d'un examen d'utilisation des sols ULURP ; aucun délai ULURP ne s'y applique.",
    cbrp_not_condition: "Une suggestion soulevée en discussion n'est pas une condition adoptée par le conseil.",
    cbrp_passage_open: "Afficher le texte sur lequel le conseil a voté",
    cbrp_passage_close: "Masquer le texte sur lequel le conseil a voté",
    cbrp_passage_heading: "Extrait du document publié",
    cbrp_source: "{publisher}, {label}.",
    cbrp_source_link: "Ouvrir le document publié",
    cbrp_read_note: "Cité du document publié exactement tel qu'il y figure.",
  },
  pl: {
    cbrp_heading: "Decyzje odnotowane we własnych dokumentach tej rady",
    cbrp_lede_one: "Jedna decyzja, odczytana w całości z dokumentu opublikowanego przez tę radę.",
    cbrp_lede: "Decyzje odczytane w całości z dokumentów opublikowanych przez tę radę: {count}.",
    cbrp_boundary: "Te dokumenty czytano po kolei. To nie wszystko, co rada postanowiła, a odnotowana tu decyzja nic nie mówi o tym, co miasto zrobiło później.",
    cbrp_meeting: "Posiedzenie z {date}",
    cbrp_position_supports: "Rada zagłosowała za poparciem tej propozycji.",
    cbrp_position_approves: "Rada zagłosowała za zatwierdzeniem tego wniosku.",
    cbrp_position_conditions: "Rada zagłosowała za rekomendacją odmowy, o ile wnioskodawca nie zgodzi się na warunki.",
    cbrp_position_opposes: "Rada zagłosowała przeciw tej propozycji.",
    cbrp_position_unclassified: "Rada odnotowała głosowanie w tej sprawie.",
    cbrp_vote_committee: "Głosowanie komisji: za {yes}, przeciw {no}, wstrzymało się {abstain}.",
    cbrp_vote_full_board: "Głosowanie pełnego składu: za {yes}, przeciw {no}, wstrzymało się {abstain}.",
    cbrp_vote_pnv: "Obecni, którzy nie głosowali: {count}.",
    cbrp_vote_named: "Dokument przypisuje ten wynik do {subject}.",
    cbrp_vote_two_stage: "Głosowanie komisji i głosowanie pełnego składu to osobne zapisy. Żadne nie zastępuje drugiego.",
    cbrp_excluded_one: "Ten sam dokument zawiera jeszcze jeden wynik. To nie jest ta decyzja.",
    cbrp_excluded: "Ten sam dokument zawiera jeszcze wyników: {count}. Żaden z nich nie jest tą decyzją.",
    cbrp_excluded_referral: "Wniosek o przekazanie innego punktu do innej komisji.",
    cbrp_excluded_amendment: "Poprawka do innego punktu.",
    cbrp_excluded_omnibus: "Jedno głosowanie nad pozostałymi punktami, wyraźnie wyłączające ten punkt.",
    cbrp_excluded_other_item: "Głosowanie nad innym punktem.",
    cbrp_excluded_failed: "Wniosek, który nie przeszedł.",
    cbrp_excluded_unnamed: "Wynik, którego dokument nie przypisuje do tego punktu.",
    cbrp_excluded_open: "Pokaż głosowania, które nie są tą decyzją",
    cbrp_excluded_close: "Ukryj głosowania, które nie są tą decyzją",
    cbrp_vote_omnibus: "Ten wynik to jedno głosowanie nad blokiem punktów, a jego własne brzmienie nie wyłącza tego punktu.",
    cbrp_vote_sole_motion: "Dokument zapisuje ten wynik zaraz po jedynym wniosku w tej części.",
    cbrp_authority_proposal: "Propozycja pochodzi od {authority}.",
    cbrp_authority: "Wniosek rozpatruje {authority}.",
    cbrp_case: "Sprawa {case}.",
    cbrp_not_ulurp: "To nie jest przegląd zagospodarowania terenu ULURP, więc nie stosuje się do niego żaden termin ULURP.",
    cbrp_not_condition: "Sugestia zgłoszona w dyskusji nie jest warunkiem przyjętym przez radę.",
    cbrp_passage_open: "Pokaż słowa, nad którymi głosowała rada",
    cbrp_passage_close: "Ukryj słowa, nad którymi głosowała rada",
    cbrp_passage_heading: "Z opublikowanego dokumentu",
    cbrp_source: "{publisher}, {label}.",
    cbrp_source_link: "Otwórz opublikowany dokument",
    cbrp_read_note: "Cytowane z opublikowanego dokumentu dokładnie tak, jak tam widnieje.",
  },
  ar: {
    cbrp_heading: "القرارات المسجَّلة في وثائق هذا المجلس نفسه",
    cbrp_lede_one: "قرار واحد، قُرئ بالكامل من وثيقة نشرها هذا المجلس.",
    cbrp_lede: "{count} قرارات، قُرئت بالكامل من وثائق نشرها هذا المجلس.",
    cbrp_boundary: "قُرئت هذه الوثائق واحدة تلو الأخرى. وهي ليست كل ما قرره المجلس، والقرار المسجَّل هنا لا يقول شيئًا عما فعلته المدينة بعد ذلك.",
    cbrp_meeting: "اجتماع {date}",
    cbrp_position_supports: "صوَّت المجلس لتأييد هذا المقترح.",
    cbrp_position_approves: "صوَّت المجلس للموافقة على هذا الطلب.",
    cbrp_position_conditions: "صوَّت المجلس بالتوصية بالرفض ما لم يوافق مقدّم الطلب على شروط.",
    cbrp_position_opposes: "صوَّت المجلس لمعارضة هذا المقترح.",
    cbrp_position_unclassified: "سجَّل المجلس تصويتًا على هذا البند.",
    cbrp_vote_committee: "تصويت اللجنة: {yes} مؤيدًا، {no} معارضًا، {abstain} ممتنعًا.",
    cbrp_vote_full_board: "تصويت المجلس بكامل هيئته: {yes} مؤيدًا، {no} معارضًا، {abstain} ممتنعًا.",
    cbrp_vote_pnv: "{count} حاضرون ولم يصوّتوا.",
    cbrp_vote_named: "تنسب الوثيقة هذا العدّ إلى {subject}.",
    cbrp_vote_two_stage: "تصويت اللجنة وتصويت المجلس بكامل هيئته سجلّان منفصلان، ولا يحل أحدهما محل الآخر.",
    cbrp_excluded_one: "تسجّل الوثيقة نفسها عدًّا آخر واحدًا. وهو ليس هذا القرار.",
    cbrp_excluded: "تسجّل الوثيقة نفسها {count} عمليات عدّ أخرى. ولا واحدة منها هي هذا القرار.",
    cbrp_excluded_referral: "اقتراح بإحالة بند آخر إلى لجنة أخرى.",
    cbrp_excluded_amendment: "تعديل على بند آخر.",
    cbrp_excluded_omnibus: "تصويت واحد على البنود الأخرى، مع استثناء هذا البند صراحةً.",
    cbrp_excluded_other_item: "تصويت على بند آخر.",
    cbrp_excluded_failed: "اقتراح لم يُقَر.",
    cbrp_excluded_unnamed: "عدٌّ لا تنسبه الوثيقة إلى هذا البند.",
    cbrp_excluded_open: "إظهار الأصوات التي ليست هذا القرار",
    cbrp_excluded_close: "إخفاء الأصوات التي ليست هذا القرار",
    cbrp_vote_omnibus: "هذا العدّ تصويت واحد على مجموعة بنود، وصياغته نفسها لا تستثني هذا البند.",
    cbrp_vote_sole_motion: "تسجّل الوثيقة هذا العدّ مباشرة بعد الاقتراح الوحيد في هذا القسم.",
    cbrp_authority_proposal: "المقترح صادر عن {authority}.",
    cbrp_authority: "الطلب معروض على {authority}.",
    cbrp_case: "القضية {case}.",
    cbrp_not_ulurp: "هذه ليست مراجعة استخدام أراضٍ من نوع ULURP، ولذلك لا ينطبق عليها أي جدول زمني خاص بـ ULURP.",
    cbrp_not_condition: "الاقتراح الذي يُطرح أثناء النقاش ليس شرطًا اعتمده المجلس.",
    cbrp_passage_open: "إظهار النص الذي صوَّت عليه المجلس",
    cbrp_passage_close: "إخفاء النص الذي صوَّت عليه المجلس",
    cbrp_passage_heading: "من الوثيقة المنشورة",
    cbrp_source: "{publisher}، {label}.",
    cbrp_source_link: "فتح الوثيقة المنشورة",
    cbrp_read_note: "مقتبس من الوثيقة المنشورة كما ورد فيها تمامًا.",
  },
  ur: {
    cbrp_heading: "اس بورڈ کی اپنی دستاویزات میں درج فیصلے",
    cbrp_lede_one: "ایک فیصلہ، جو اس بورڈ کی شائع کردہ ایک دستاویز سے مکمل پڑھا گیا۔",
    cbrp_lede: "{count} فیصلے، جو اس بورڈ کی شائع کردہ دستاویزات سے مکمل پڑھے گئے۔",
    cbrp_boundary: "یہ دستاویزات ایک ایک کر کے پڑھی گئیں۔ یہ بورڈ کے تمام فیصلے نہیں ہیں، اور یہاں درج فیصلہ اس بارے میں کچھ نہیں بتاتا کہ شہر نے بعد میں کیا کیا۔",
    cbrp_meeting: "{date} کا اجلاس",
    cbrp_position_supports: "بورڈ نے اس تجویز کی حمایت میں ووٹ دیا۔",
    cbrp_position_approves: "بورڈ نے اس درخواست کی منظوری کے حق میں ووٹ دیا۔",
    cbrp_position_conditions: "بورڈ نے ووٹ دیا کہ درخواست گزار شرائط سے اتفاق نہ کرے تو درخواست مسترد کرنے کی سفارش کی جائے۔",
    cbrp_position_opposes: "بورڈ نے اس تجویز کی مخالفت میں ووٹ دیا۔",
    cbrp_position_unclassified: "بورڈ نے اس مد پر ایک ووٹ درج کیا۔",
    cbrp_vote_committee: "کمیٹی کا ووٹ: {yes} حق میں، {no} مخالفت میں، {abstain} غیر حاضر رائے۔",
    cbrp_vote_full_board: "مکمل بورڈ کا ووٹ: {yes} حق میں، {no} مخالفت میں، {abstain} غیر حاضر رائے۔",
    cbrp_vote_pnv: "{count} موجود تھے مگر ووٹ نہیں دیا۔",
    cbrp_vote_named: "دستاویز اس گنتی کو {subject} کے نام درج کرتی ہے۔",
    cbrp_vote_two_stage: "کمیٹی کا ووٹ اور مکمل بورڈ کا ووٹ الگ الگ اندراج ہیں۔ کوئی ایک دوسرے کی جگہ نہیں لیتا۔",
    cbrp_excluded_one: "اسی دستاویز میں ایک اور گنتی درج ہے۔ وہ یہ فیصلہ نہیں ہے۔",
    cbrp_excluded: "اسی دستاویز میں {count} اور گنتیاں درج ہیں۔ ان میں سے کوئی بھی یہ فیصلہ نہیں ہے۔",
    cbrp_excluded_referral: "کسی دوسری مد کو ایک اور کمیٹی کو بھیجنے کی تحریک۔",
    cbrp_excluded_amendment: "کسی دوسری مد میں ترمیم۔",
    cbrp_excluded_omnibus: "باقی مدات پر ایک ہی ووٹ، جس میں یہ مد واضح طور پر خارج ہے۔",
    cbrp_excluded_other_item: "کسی دوسری مد پر ووٹ۔",
    cbrp_excluded_failed: "ایسی تحریک جو منظور نہ ہوئی۔",
    cbrp_excluded_unnamed: "ایسی گنتی جسے دستاویز اس مد کے نام درج نہیں کرتی۔",
    cbrp_excluded_open: "وہ ووٹ دکھائیں جو یہ فیصلہ نہیں ہیں",
    cbrp_excluded_close: "وہ ووٹ چھپائیں جو یہ فیصلہ نہیں ہیں",
    cbrp_vote_omnibus: "یہ گنتی کئی مدات پر ایک ہی ووٹ ہے، اور اس کے اپنے الفاظ اس مد کو خارج نہیں کرتے۔",
    cbrp_vote_sole_motion: "دستاویز اس گنتی کو اس حصے کی واحد تحریک کے فوراً بعد درج کرتی ہے۔",
    cbrp_authority_proposal: "یہ تجویز {authority} کی جانب سے ہے۔",
    cbrp_authority: "درخواست {authority} کے سامنے ہے۔",
    cbrp_case: "مقدمہ {case}۔",
    cbrp_not_ulurp: "یہ ULURP اراضی استعمال کا جائزہ نہیں ہے، اس لیے اس پر کوئی ULURP نظام الاوقات لاگو نہیں ہوتا۔",
    cbrp_not_condition: "بحث کے دوران پیش کی گئی تجویز وہ شرط نہیں جو بورڈ نے منظور کی ہو۔",
    cbrp_passage_open: "وہ الفاظ دکھائیں جن پر بورڈ نے ووٹ دیا",
    cbrp_passage_close: "وہ الفاظ چھپائیں جن پر بورڈ نے ووٹ دیا",
    cbrp_passage_heading: "شائع شدہ دستاویز سے",
    cbrp_source: "{publisher}، {label}۔",
    cbrp_source_link: "شائع شدہ دستاویز کھولیں",
    cbrp_read_note: "شائع شدہ دستاویز سے بعینہٖ اسی طرح نقل کیا گیا جیسے وہاں درج ہے۔",
  },
};

function localizedT(lang) {
  const values = STRINGS[lang] || STRINGS.en;
  return (key, vars = {}) => String(values[key] || STRINGS.en[key] || key)
    .replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? ""));
}

/** Publisher text keeps its own language and direction inside a translated page. */
function sourceText(value) {
  return `<span lang="en" dir="ltr">${esc(value)}</span>`;
}

/**
 * A translated sentence with one publisher value inside it.
 *
 * The value is placed through a private-use sentinel rather than by trimming
 * the sentence, so a language that puts the value first, last or in the middle
 * all render correctly and the publisher's own words keep their bidi isolation.
 */
const VALUE_SENTINEL = "\ue000";
const SECOND_SENTINEL = "\ue001";

function sentenceWithSourceValue(t, key, name, value, vars = {}) {
  return esc(t(key, { ...vars, [name]: VALUE_SENTINEL })).replace(VALUE_SENTINEL, sourceText(value));
}

function formatDay(value, lang) {
  const day = isoDay(value);
  if (!day) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(DATE_LOCALES[lang] || DATE_LOCALES.en, {
      year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
    }).format(parsed);
  } catch {
    return day;
  }
}

function formatCount(value, lang) {
  try {
    return new Intl.NumberFormat(DATE_LOCALES[lang] || DATE_LOCALES.en).format(value);
  } catch {
    return String(value);
  }
}

function voteMarkup(vote, t, lang) {
  const key = vote.stage === "committee" ? "cbrp_vote_committee" : "cbrp_vote_full_board";
  const parts = [esc(t(key, {
    yes: formatCount(vote.yes, lang),
    no: formatCount(vote.no, lang),
    abstain: formatCount(vote.abstain, lang),
  }))];
  if (vote.present_not_voting) {
    parts.push(esc(t("cbrp_vote_pnv", { count: formatCount(vote.present_not_voting, lang) })));
  }
  const ownershipKey = OWNERSHIP_KEYS[vote.motion_ownership] || "cbrp_vote_named";
  parts.push(ownershipKey === "cbrp_vote_sole_motion"
    ? esc(t(ownershipKey))
    : sentenceWithSourceValue(t, ownershipKey, "subject", vote.subject_wording));
  return `<li class="board-decision-vote" data-vote-stage="${esc(vote.stage)}"`
    + ` data-vote-ownership="${esc(vote.motion_ownership)}">${parts.join(" ")}</li>`;
}

function excludedVoteMarkup(vote, t, lang) {
  const reason = t(EXCLUSION_KEYS[vote.exclusion_reason] || "cbrp_excluded_unnamed");
  const tallies = `${formatCount(vote.yes, lang)}-${formatCount(vote.no, lang)}-${formatCount(vote.abstain, lang)}`;
  const subject = vote.subject_wording ? ` ${sourceText(vote.subject_wording)}` : "";
  return `<li class="board-decision-excluded-vote" data-exclusion-reason="${esc(vote.exclusion_reason)}">`
    + `<span lang="en" dir="ltr">${esc(tallies)}</span>${subject} <span class="muted node-muted">${esc(reason)}</span></li>`;
}

/**
 * One decision.
 *
 * The passage and the excluded tallies are addressed by their own fragments
 * rather than held in `<details>` elements. A browser restores a history
 * entry's URL and scroll offset, not an element's open state, so putting the
 * expansion in the URL is what lets a reader open a passage, follow the link to
 * the published document, and come back to the list exactly as they left it.
 * Each control stays a plain same-page link: no script, no new tab. With no
 * stylesheet at all everything simply renders, which is the right failure.
 */
function decisionMarkup(decision, index, t, lang) {
  const anchor = `${COMMUNITY_BOARD_DECISIONS_ANCHOR}-${index + 1}`;
  const operative = decision.passages.filter((row) => row.role !== "title");
  const meeting = formatDay(decision.document.meeting_date, lang);
  const facts = [];
  if (meeting) facts.push(esc(t("cbrp_meeting", { date: meeting })));
  if (decision.authority?.authority_name) {
    facts.push(sentenceWithSourceValue(
      t,
      decision.authority.relation === "proposal_from" ? "cbrp_authority_proposal" : "cbrp_authority",
      "authority",
      decision.authority.authority_name,
    ));
  }
  if (decision.authority?.case_number) {
    facts.push(sentenceWithSourceValue(t, "cbrp_case", "case", decision.authority.case_number));
  }

  const boundary = [];
  if (decision.authority && decision.authority.is_ulurp === false) boundary.push(esc(t("cbrp_not_ulurp")));
  if (decision.non_adopted_notes.length) boundary.push(esc(t("cbrp_not_condition")));

  const passageBody = operative
    .map((row) => `<blockquote class="board-decision-quote" lang="en" dir="ltr"`
      + `${decision.document.document_url ? ` cite="${esc(decision.document.document_url)}"` : ""}`
      + ` data-source-lines="${esc(row.source_lines.join("-"))}"><p>${esc(row.text)}</p></blockquote>`)
    .join("");
  const notesBody = decision.non_adopted_notes
    .map((row) => `<blockquote class="board-decision-quote board-decision-note" lang="en" dir="ltr"`
      + ` data-note-classification="${esc(row.classification)}"><p>${esc(row.text)}</p></blockquote>`)
    .join("");
  const passage = `<div class="board-decision-passage" id="${esc(anchor)}-passage">`
    + `<a class="board-decision-more" href="#${esc(anchor)}-passage">${esc(t("cbrp_passage_open"))}</a>`
    + `<div class="board-decision-passage-body">`
    + `<p class="muted node-muted">${esc(t("cbrp_passage_heading"))}</p>${passageBody}${notesBody}`
    + `<p class="muted node-muted">${esc(t("cbrp_read_note"))}</p></div>`
    + `<a class="board-decision-less" href="#${esc(anchor)}">${esc(t("cbrp_passage_close"))}</a></div>`;

  const excludedCount = decision.excluded_votes.length;
  const excluded = excludedCount
    ? `<div class="board-decision-excluded" id="${esc(anchor)}-other" data-excluded-votes="${esc(String(excludedCount))}">`
      + `<a class="board-decision-more" href="#${esc(anchor)}-other">${esc(t("cbrp_excluded_open"))}</a>`
      + `<div class="board-decision-excluded-body"><p>${esc(excludedCount === 1
        ? t("cbrp_excluded_one")
        : t("cbrp_excluded", { count: formatCount(excludedCount, lang) }))}</p>`
      + `<ul class="board-decision-excluded-list">`
      + decision.excluded_votes.map((vote) => excludedVoteMarkup(vote, t, lang)).join("")
      + `</ul></div>`
      + `<a class="board-decision-less" href="#${esc(anchor)}">${esc(t("cbrp_excluded_close"))}</a></div>`
    : "";

  const source = decision.document.document_url
    ? `<p class="board-decision-source">`
      + `<a class="ui-constellation-link board-decision-source-link" href="${esc(decision.document.document_url)}">${esc(t("cbrp_source_link"))}</a> `
      + `<span class="muted node-muted">${esc(t("cbrp_source", { publisher: VALUE_SENTINEL, label: SECOND_SENTINEL }))
        .replace(VALUE_SENTINEL, sourceText(decision.document.publisher))
        .replace(SECOND_SENTINEL, sourceText(decision.document.published_label))}</span></p>`
    : "";

  return `<li class="node-record board-decision" id="${esc(anchor)}"`
    + ` data-board-decision="${esc(decision.candidate_id)}"`
    + ` data-decision-position="${esc(decision.position)}">`
    + `<div class="node-record-main"><strong lang="en" dir="ltr">${esc(decision.title)}</strong></div>`
    + `<p class="board-decision-plain">${esc(t(POSITION_KEYS[decision.position] || "cbrp_position_unclassified"))}</p>`
    + (facts.length ? `<p class="muted node-muted board-decision-facts">${facts.join(" &#183; ")}</p>` : "")
    + `<ul class="board-decision-votes">${decision.votes.map((vote) => voteMarkup(vote, t, lang)).join("")}</ul>`
    + (decision.has_committee_vote && decision.has_full_board_vote
      ? `<p class="muted node-muted board-decision-two-stage">${esc(t("cbrp_vote_two_stage"))}</p>`
      : "")
    + excluded
    + passage
    + (boundary.length ? `<p class="muted node-muted board-decision-boundary">${boundary.join(" ")}</p>` : "")
    + source
    + `</li>`;
}

/**
 * The decisions section for one board's document, or "" when it has none.
 *
 * Every destination is a plain anchor to the publisher's own document, so a
 * modified click, a middle click and the browser's history all behave the way
 * they do anywhere else on the site.
 */
export function renderCommunityBoardDecisionsSection(view, options = {}) {
  if (!view || view.schema !== COMMUNITY_BOARD_RESOLUTION_VIEW_SCHEMA) return "";
  if (!Array.isArray(view.decisions) || !view.decisions.length) return "";
  const lang = STRINGS[options.lang] ? options.lang : "en";
  const t = localizedT(lang);
  const langAttrs = lang === "en" ? {} : { lang, dir: RTL_LANGS.has(lang) ? "rtl" : "ltr" };
  const lede = view.decisions.length === 1
    ? t("cbrp_lede_one")
    : t("cbrp_lede", { count: formatCount(view.decisions.length, lang) });
  return renderNodeSection({
    heading: t("cbrp_heading"),
    headingId: `${COMMUNITY_BOARD_DECISIONS_ANCHOR}-heading`,
    exportClass: "object_board_decisions",
    extraClass: "node-card civic-object-section board-decisions",
    attrs: {
      id: COMMUNITY_BOARD_DECISIONS_ANCHOR,
      "data-community-board-decisions": String(view.decisions.length),
      ...langAttrs,
    },
    body: `<p class="node-lede">${esc(lede)}</p>`
      + `<p class="muted node-muted board-decisions-boundary">${esc(t("cbrp_boundary"))}</p>`
      + `<ul class="node-record-list board-decisions-list">`
      + view.decisions.map((decision, index) => decisionMarkup(decision, index, t, lang)).join("")
      + `</ul>`,
  });
}
