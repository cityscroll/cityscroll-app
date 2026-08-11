// Official entity family (person-level identity for Council votes/meetings).
//
// Type family for elected/appointed officials who cast recorded votes. Pure
// helpers only: normalize Legistar person rows, mint stable official ids, and
// emit typed votes_on edges. No LLM matching; no silent person invent.
//
// Person hub (uvw5-9znb) + lobby/CFB name binding live in:
//   person_name.mjs, lobby_targets.mjs, org_resolve.mjs
//   site/person_hub.mjs, site/official_influence.mjs

export const OFFICIAL_ENTITY_TYPE = "official";
export const OFFICIAL_TYPE_FAMILY = "official";
export const VOTES_ON_LINK_TYPE = "votes_on";
export const OFFICIAL_PRIMARY_KEY_PATTERN = "official:{person_id}";

export {
  foldPersonText,
  personNameKeys,
  buildPersonNameIndex,
  resolvePersonName,
} from "./person_name.mjs";
export {
  parseLobbyTargets,
  isPersonShapedLobbyTarget,
} from "./lobby_targets.mjs";
export {
  orgKey,
  orgKeyPreferringVendorStem,
  consolidateOrgKeys,
  ORG_ALIAS_SEED,
} from "./org_resolve.mjs";

/** Closed ER type-family set including official and agency-head person families. */
export const ENTITY_TYPE_FAMILIES = Object.freeze([
  "vendor",
  "agency",
  "procurement",
  "location",
  "official",
  "person-leader",
]);

// NYC Legistar publishes VoteValueName as Affirmative / Negative (not Aye/Nay).
const VOTE_AYE = /^(aye|yes|yea|y\b|in favor|approve|affirmative)/i;
const VOTE_NAY = /^(nay|no\b|n\b|against|reject|deny|negative)/i;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Bucket a publisher vote value into aye | nay | abstain.
 * Accepts Aye/Nay-style labels and Legistar VoteValueName (Affirmative/Negative).
 * @param {string} value
 * @returns {"aye"|"nay"|"abstain"}
 */
export function voteBucket(value) {
  const text = clean(value);
  if (!text) return "abstain";
  if (VOTE_AYE.test(text)) return "aye";
  if (VOTE_NAY.test(text)) return "nay";
  return "abstain";
}

/**
 * Stable public id for one official. Prefer Legistar PersonId; fall back to a
 * name-keyed id only when the publisher row has a display name and no id.
 * @param {{ personId?: string|number|null, personName?: string|null }} opts
 * @returns {string|null}
 */
export function officialEntityId({ personId = null, personName = null } = {}) {
  const id = clean(personId);
  if (id) return `official:${id}`;
  const name = clean(personName);
  if (!name) return null;
  return `official:name:${encodeURIComponent(name.toLowerCase())}`;
}

/**
 * Read person identity from a raw Legistar (or compatible) vote row.
 * Live Granicus Votes use VotePersonId / VotePersonName — not PersonId / PersonName.
 *
 * @param {object} raw
 * @returns {{ personId: string|null, personName: string|null }}
 */
export function readVotePersonIdentity(raw = {}) {
  const personId = clean(
    raw.VotePersonId
      ?? raw.vote_person_id
      ?? raw.PersonId
      ?? raw.person_id
      ?? raw.PersonID
      ?? raw.personId
      ?? "",
  ) || null;
  const personName = clean(
    raw.VotePersonName
      ?? raw.vote_person_name
      ?? raw.PersonName
      ?? raw.person_name
      ?? raw.PersonFullName
      ?? raw.name
      ?? "",
  ) || null;
  return { personId, personName };
}

/**
 * Read the publisher vote label from a raw vote row.
 * Prefer VoteValueName (live Legistar) over the integer VoteResult field.
 *
 * @param {object} raw
 * @returns {string}
 */
export function readVoteValueLabel(raw = {}) {
  // Prefer human labels. VoteResult is often an integer flag on live Legistar
  // and must not win over VoteValueName.
  const label = clean(
    raw.VoteValueName
      ?? raw.VoteValue
      ?? raw.VoteTypeName
      ?? raw.PersonVote
      ?? raw.vote_value
      ?? "",
  );
  if (label) return label;
  // Only fall back to VoteResult when it looks like a text label, not "1"/"0".
  const result = clean(raw.VoteResult ?? "");
  if (result && !/^\d+$/.test(result)) return result;
  return "";
}

/**
 * Normalize one Legistar (or compatible) vote row into an official + vote.
 * Returns null when neither person id nor name is present — those rows still
 * contribute to aggregate counts, but cannot form an official object.
 *
 * Live Legistar EventItems/{id}/Votes rows carry VotePersonId / VotePersonName
 * and VoteValueName (e.g. Affirmative). Older fixtures may use PersonId /
 * PersonName / VoteValue — both shapes are retained.
 *
 * @param {object} raw
 * @returns {null|{
 *   person_id: string|null,
 *   person_name: string|null,
 *   vote_value: string,
 *   vote_bucket: "aye"|"nay"|"abstain",
 *   official: { id: string, entity_type: string, display_name: string },
 * }}
 */
export function normalizeVotePersonRow(raw = {}) {
  const { personId, personName } = readVotePersonIdentity(raw);
  const voteValue = readVoteValueLabel(raw);
  const officialId = officialEntityId({ personId, personName });
  if (!officialId) return null;

  const displayName = personName || (personId ? `Official ${personId}` : null);
  if (!displayName) return null;

  return {
    person_id: personId,
    person_name: personName,
    vote_value: voteValue,
    vote_bucket: voteBucket(voteValue),
    official: {
      id: officialId,
      entity_type: OFFICIAL_ENTITY_TYPE,
      display_name: displayName,
    },
  };
}

/**
 * Build typed votes_on edges from normalized person-vote rows.
 * Target prefers matter id, then agenda item / event item id.
 *
 * @param {Array<object>} persons — normalizeVotePersonRow results
 * @param {{ matterId?: string|null, agendaItemId?: string|null, eventItemId?: string|null }} target
 * @returns {Array<object>}
 */
export function buildVotesOnEdges(persons = [], target = {}) {
  const matterId = clean(target.matterId);
  const agendaItemId = clean(target.agendaItemId ?? target.eventItemId);
  let to = null;
  let toType = null;
  if (matterId) {
    to = `matter:${matterId}`;
    toType = "matter";
  } else if (agendaItemId) {
    to = `agenda_item:${agendaItemId}`;
    toType = "agenda_item";
  }
  if (!to) return [];

  const edges = [];
  const seen = new Set();
  for (const person of Array.isArray(persons) ? persons : []) {
    const from = clean(person?.official?.id);
    if (!from) continue;
    const key = `${from}\0${to}\0${person.vote_bucket}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      type: VOTES_ON_LINK_TYPE,
      from,
      to,
      to_type: toType,
      vote_bucket: person.vote_bucket,
      vote_value: person.vote_value || null,
      official: person.official,
      person_id: person.person_id,
      person_name: person.person_name,
    });
  }
  return edges;
}

/**
 * Classify whether a vote summary retained per-person identities.
 * - roll_call: at least one person id/name retained
 * - tally_only: rows present but no person identity (voice vote / publisher tallies only)
 * - empty: no rows
 *
 * @param {{ person_count?: number, by_person?: Array<object> }|null} summary
 * @returns {"roll_call"|"tally_only"|"empty"}
 */
export function classifyVoteIdentity(summary) {
  if (!summary || !(summary.person_count > 0)) return "empty";
  const retained = Array.isArray(summary.by_person) ? summary.by_person.length : 0;
  return retained > 0 ? "roll_call" : "tally_only";
}

/**
 * Summarize raw Legistar vote rows: aggregate counts + retained person rows +
 * official objects + votes_on edges.
 *
 * @param {Array<object>} rows
 * @param {{ matterId?: string|null, agendaItemId?: string|null, eventItemId?: string|null }} target
 * @returns {null|{
 *   result: string|null,
 *   counts: { aye: number, nay: number, abstain: number },
 *   person_count: number,
 *   by_person: Array<object>,
 *   officials: Array<object>,
 *   votes_on: Array<object>,
 *   person_vote_retention_rate: number,
 *   official_votes_on_edge_rate: number,
 *   vote_identity: "roll_call"|"tally_only",
 * }}
 */
export function summarizePersonVotes(rows = [], target = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;

  const counts = { aye: 0, nay: 0, abstain: 0 };
  const byPerson = [];
  for (const row of list) {
    const value = readVoteValueLabel(row || {});
    const bucket = voteBucket(value);
    counts[bucket] += 1;
    const person = normalizeVotePersonRow(row || {});
    if (person) byPerson.push(person);
  }

  const result = counts.aye > counts.nay
    ? "Passed"
    : counts.nay > counts.aye
      ? "Failed"
      : counts.aye
        ? "Tied"
        : null;

  const votesOn = buildVotesOnEdges(byPerson, target);
  const officialById = new Map();
  for (const person of byPerson) {
    if (person.official?.id && !officialById.has(person.official.id)) {
      officialById.set(person.official.id, person.official);
    }
  }

  const retained = byPerson.length;
  const total = list.length;
  const edges = votesOn.length;
  const summary = {
    result,
    counts,
    person_count: total,
    by_person: byPerson,
    officials: [...officialById.values()],
    votes_on: votesOn,
    person_vote_retention_rate: total ? retained / total : 0,
    official_votes_on_edge_rate: retained ? edges / retained : 0,
  };
  summary.vote_identity = classifyVoteIdentity(summary);
  return summary;
}

/**
 * Metric helper for characterization: retention + votes_on coverage.
 * @param {ReturnType<typeof summarizePersonVotes>|null} summary
 */
export function measureOfficialVoteMetrics(summary) {
  if (!summary) {
    return {
      person_vote_retention_rate: 0,
      official_votes_on_edge_rate: 0,
      person_rows: 0,
      retained_rows: 0,
      votes_on_edges: 0,
      distinct_officials: 0,
    };
  }
  return {
    person_vote_retention_rate: summary.person_vote_retention_rate,
    official_votes_on_edge_rate: summary.official_votes_on_edge_rate,
    person_rows: summary.person_count,
    retained_rows: summary.by_person.length,
    votes_on_edges: summary.votes_on.length,
    distinct_officials: summary.officials.length,
  };
}
