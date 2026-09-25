/**
 * One SearchDocument per admitted community-board decision.
 *
 * Board discovery stays a separate community_board object. These documents name
 * the decision itself and open its stable destination, so a reader who remembers
 * an address, docket, or topic can land on the vote without scanning a board page.
 */

import {
  communityBoardDecisionHref,
} from "./community_board_resolution_pilot.mjs";
import { SEARCH_TEXT_MAX_LENGTH } from "./search_document_contract.mjs";
import {
  admitProjectedSearchDocument,
  cleanSearchText,
  failedSearchProjection,
  freezeSearchValue,
  searchProducerCorpus,
  unavailableSearchProducerCorpus,
  uniqueSearchText,
} from "./search_producer_support.mjs";

export const COMMUNITY_BOARD_DECISION_SEARCH_PRODUCER_SCHEMA =
  "cityscroll.community_board_decision_search_producer.v1";
export const COMMUNITY_BOARD_DECISION_SEARCH_PRODUCER =
  "community_board_decision_search_document.v1";
export const COMMUNITY_BOARD_DECISION_SEARCH_OBJECT_TYPE = "community_board_decision";
export const COMMUNITY_BOARD_DECISION_SEARCH_DOMAIN = "places";

const PILOT_SCHEMA = "cityscroll.community_board_resolution_pilot.v1";
const BOARD_LOOKUP_SCHEMA = "cityscroll.community_board_constellation.v1";
const BOARD_LOOKUP_METHOD = "community_board_constellation_v1";
const BODY_ID = /^(bronx|brooklyn|manhattan|queens|staten-island)-cb-\d{2}$/;
const BOROUGHS = Object.freeze({
  bronx: "Bronx",
  brooklyn: "Brooklyn",
  manhattan: "Manhattan",
  queens: "Queens",
  "staten-island": "Staten Island",
});

function boardContext(boardIdValue, boardLookup = {}) {
  const boardId = cleanSearchText(boardIdValue, 100).toLowerCase();
  if (!BODY_ID.test(boardId)) return null;
  const match = boardId.match(/^(bronx|brooklyn|manhattan|queens|staten-island)-cb-(\d{2})$/);
  const borough = BOROUGHS[match[1]];
  const district = String(Number(match[2]));
  const row = boardLookup?.by_id?.[boardId] || {};
  const name = cleanSearchText(row.display_name || row.name, 500)
    || `${borough} Community Board ${district}`;
  return {
    id: boardId,
    name,
    borough,
    district,
    short_name: `Community Board ${district}`,
  };
}

function publishedDecisions(pilot = {}) {
  if (pilot?.schema !== PILOT_SCHEMA || !pilot.by_board || typeof pilot.by_board !== "object") {
    return null;
  }
  const rows = [];
  for (const [boardId, decisions] of Object.entries(pilot.by_board)) {
    if (!Array.isArray(decisions)) continue;
    for (const decision of decisions) {
      if (!decision || typeof decision !== "object") continue;
      if (cleanSearchText(decision.admission, 40) !== "published") continue;
      rows.push({ ...decision, board_id: decision.board_id || boardId });
    }
  }
  return rows.sort((left, right) => String(left.candidate_id || "")
    .localeCompare(String(right.candidate_id || ""), "en-US"));
}

function addressPhrases(decision = {}) {
  const address = decision.address;
  const phrases = [];
  if (Array.isArray(address?.assertions)) {
    for (const assertion of address.assertions) {
      phrases.push(
        assertion?.normalized_address,
        assertion?.raw_address,
        assertion?.address,
        assertion?.label,
      );
    }
  }
  return uniqueSearchText(phrases, 240);
}

function decisionPassageText(decision = {}) {
  return uniqueSearchText(
    (Array.isArray(decision.passages) ? decision.passages : [])
      .map((passage) => passage?.text)
      .filter(Boolean),
    1_200,
  );
}

const DAY_WORD = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i;
const PLACE_WORD = /\b(Place|Avenue|Street|Road|Boulevard|Blvd)\b/i;

/**
 * Contiguous topic lines the adjacent-token matcher can hit.
 *
 * Board minutes name a place or day in one clause and the action in another.
 * Readers often type those clauses in either order, so the indexed text keeps
 * a place/day-first line built only from source topics, title wording, and the
 * authority's own short name — never from named acceptance queries.
 */
function decisionTopicCoveragePhrases(decision = {}) {
  const topics = uniqueSearchText(decision.subject_topics || [], 120);
  const title = cleanSearchText(decision.title, 500);
  const authorityName = cleanSearchText(decision.authority?.authority_name, 240);
  const phrases = [];

  const onMatch = title.match(
    /\b((?:a|an)\s+)?((?:[A-Za-z][\w']*\s+){0,3}(?:Lane|Enclosure|Modification|Proposal|Application|Opt-?in|Collections?|Set\s+Out)s?)\s+on\s+((?:St\.?\s+)?[A-Za-z][\w'.]*(?:\s+[A-Za-z][\w'.]*){0,4}?)(?=\s+from\b|\s*$|\s+to\b)/i,
  );
  if (onMatch) {
    phrases.push(`${onMatch[3]} ${onMatch[2]}`);
    phrases.push(`${onMatch[2]} ${onMatch[3]}`);
  }

  const placeOrDayTopic = topics.find((topic) => DAY_WORD.test(topic) || PLACE_WORD.test(topic));
  if (placeOrDayTopic) {
    const dayMatch = placeOrDayTopic.match(DAY_WORD);
    const head = dayMatch ? dayMatch[1] : placeOrDayTopic;
    const authorityTokens = new Set(
      authorityName
        .toLocaleLowerCase("en-US")
        .split(/[^a-z0-9]+/i)
        .filter((token) => token.length > 3),
    );
    const singles = topics.filter((topic) => {
      const words = topic.split(/\s+/).filter(Boolean);
      if (words.length !== 1) return false;
      if (/^opt(?:-in)?$/i.test(topic)) return false;
      return authorityTokens.has(topic.toLocaleLowerCase("en-US"));
    });
    let action = topics.find((topic) => (
      topic !== placeOrDayTopic
      && /(?:\blane\b|\bset\s+out\b|\benclosure\b|\bopt(?:-?in)?\b)/i.test(topic)
    )) || null;
    if (action) action = action.replace(DAY_WORD, "").trim();
    // Title wording wins when the minutes already say "bike lane"; keep the
    // bicycle topic too so either resident phrasing stays source-backed.
    if (/\bbike\s+lane\b/i.test(title) || /\bbicycle\s+lane\b/i.test(action || "")) {
      phrases.push([head, ...singles, "bike lane"].filter(Boolean).join(" "));
    }
    if (action) phrases.push([head, ...singles, action].filter(Boolean).join(" "));
  }

  return uniqueSearchText(phrases, 300);
}

function decisionSearchFields(decision, board) {
  const meetingDate = cleanSearchText(decision.document?.meeting_date, 40);
  const caseNumber = cleanSearchText(decision.authority?.case_number, 120);
  const authorityName = cleanSearchText(decision.authority?.authority_name, 240);
  return uniqueSearchText([
    decision.title,
    decision.candidate_id,
    board.name,
    board.id,
    board.short_name,
    board.borough,
    `Community District ${board.district}`,
    meetingDate,
    caseNumber,
    authorityName,
    decision.position,
    decision.agenda_item_label,
    decision.agenda_item_text,
    ...(decision.subject_topics || []),
    ...decisionTopicCoveragePhrases(decision),
    ...addressPhrases(decision),
    ...decisionPassageText(decision),
    "community board decision",
    "board decision",
  ], SEARCH_TEXT_MAX_LENGTH);
}

/** Project one admitted decision into the shared SearchDocument contract. */
export function projectCommunityBoardDecisionSearchDocument(decision = {}, {
  boardLookup = {},
  pilot = null,
} = {}) {
  if (pilot && pilot.schema !== PILOT_SCHEMA) {
    return failedSearchProjection("not_indexed", "unsupported_community_board_resolution_pilot", ["read_model"]);
  }
  if (
    boardLookup
    && Object.keys(boardLookup).length
    && (boardLookup.schema !== BOARD_LOOKUP_SCHEMA || boardLookup.method !== BOARD_LOOKUP_METHOD)
  ) {
    return failedSearchProjection("not_indexed", "unsupported_community_board_read_model", ["read_model"]);
  }

  const candidateId = cleanSearchText(decision.candidate_id, 300);
  const title = cleanSearchText(decision.title, 500);
  const board = boardContext(decision.board_id, boardLookup);
  const href = communityBoardDecisionHref(board?.id, candidateId);
  if (!candidateId || !title || !board || !href) {
    return failedSearchProjection("unclassified", "unresolved_community_board_decision_identity", ["object_ref"]);
  }
  if (cleanSearchText(decision.admission, 40) !== "published") {
    return failedSearchProjection("not_indexed", "community_board_decision_not_published", ["admission"]);
  }

  const meetingDate = cleanSearchText(decision.document?.meeting_date, 40) || null;
  const caseNumber = cleanSearchText(decision.authority?.case_number, 120) || null;
  const fields = decisionSearchFields(decision, board);
  const summaryParts = [
    board.name,
    meetingDate,
    caseNumber,
    "Community board decision",
  ].filter(Boolean);

  return admitProjectedSearchDocument({
    object_ref: `community-board-decision:${candidateId}`,
    object_type: COMMUNITY_BOARD_DECISION_SEARCH_OBJECT_TYPE,
    domain: COMMUNITY_BOARD_DECISION_SEARCH_DOMAIN,
    canonical_href: href,
    title,
    summary: summaryParts.join(" · "),
    search_text: fields.join(" ").slice(0, SEARCH_TEXT_MAX_LENGTH),
    source_family: "community_board_resolution_pilot",
    source_observation_refs: [
      `community_board_decision:${candidateId}`,
      ...(decision.document_id ? [`community_board_document:${decision.document_id}`] : []),
    ],
    process_role: null,
    classification: {
      method: "admitted_community_board_decision",
      basis: "published resolution-pilot candidate identity with stable board-decision destination",
    },
    provenance: {
      producer: COMMUNITY_BOARD_DECISION_SEARCH_PRODUCER,
      source_system: "community_board_resolution_pilot",
      board_id: board.id,
      board_name: board.name,
      borough: board.borough,
      district: board.district,
      candidate_id: candidateId,
      meeting_date: meetingDate,
      case_number: caseNumber,
      authority_name: cleanSearchText(decision.authority?.authority_name, 240) || null,
      subject_topics: uniqueSearchText(decision.subject_topics || [], 120),
      address_phrases: addressPhrases(decision),
      kind_label: "Board decision",
      institution_label: `${board.name} · Board decision`,
      institution_context: "Accepted community board decision",
      source_freshness: {
        generated_at: decision.document?.observed_on || pilot?.reviewed_on || null,
      },
    },
  }, "admitted_community_board_decision_identity");
}

/** Build one document per admitted decision; held candidates stay out. */
export function buildCommunityBoardDecisionSearchDocuments(pilot = {}, {
  boardLookup = {},
} = {}) {
  const rows = publishedDecisions(pilot);
  if (rows == null) {
    return unavailableSearchProducerCorpus({
      schema: COMMUNITY_BOARD_DECISION_SEARCH_PRODUCER_SCHEMA,
      producer: COMMUNITY_BOARD_DECISION_SEARCH_PRODUCER,
      objectType: COMMUNITY_BOARD_DECISION_SEARCH_OBJECT_TYPE,
      domain: COMMUNITY_BOARD_DECISION_SEARCH_DOMAIN,
      reason: "unsupported_community_board_resolution_pilot",
    });
  }
  if (!rows.length) {
    return unavailableSearchProducerCorpus({
      schema: COMMUNITY_BOARD_DECISION_SEARCH_PRODUCER_SCHEMA,
      producer: COMMUNITY_BOARD_DECISION_SEARCH_PRODUCER,
      objectType: COMMUNITY_BOARD_DECISION_SEARCH_OBJECT_TYPE,
      domain: COMMUNITY_BOARD_DECISION_SEARCH_DOMAIN,
      reason: "community_board_resolution_pilot_has_no_published_decisions",
    });
  }

  const kept = new Map();
  const outcomes = [];
  for (const decision of rows) {
    const outcome = freezeSearchValue({
      candidate_id: decision.candidate_id,
      ...projectCommunityBoardDecisionSearchDocument(decision, { boardLookup, pilot }),
    });
    const objectRef = outcome.document?.object_ref;
    if (!objectRef) {
      outcomes.push(outcome);
      continue;
    }
    if (kept.has(objectRef)) continue;
    kept.set(objectRef, true);
    outcomes.push(outcome);
  }

  return searchProducerCorpus({
    schema: COMMUNITY_BOARD_DECISION_SEARCH_PRODUCER_SCHEMA,
    producer: COMMUNITY_BOARD_DECISION_SEARCH_PRODUCER,
    objectType: COMMUNITY_BOARD_DECISION_SEARCH_OBJECT_TYPE,
    domain: COMMUNITY_BOARD_DECISION_SEARCH_DOMAIN,
    outcomes,
    reasons: {
      matched: "admitted_community_board_decisions_indexed",
      empty: "community_board_resolution_pilot_has_no_published_decisions",
      partial: "some_community_board_decisions_failed_admission",
      not_indexed: "no_community_board_decision_passed_admission",
    },
  });
}
