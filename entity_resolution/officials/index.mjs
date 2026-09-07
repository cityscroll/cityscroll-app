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

// NYC Legistar publishes VoteValueName as Affirmative / Negative (not Aye/Nay),
// and the publisher's own `VoteTypes` table is the authority on what each label
// means. Every row of that table carries two machine-readable fields:
//
//   VoteTypeResult   1 = affirmative, 2 = negative, 0 = neither
//   VoteTypeUsedFor  1 = attendance roll, 2 = a cast vote, 3 = a recorded absence
//
// The table is reproduced below from the live publisher vocabulary rather than
// guessed, because the distinction it draws is the whole point: "Absent",
// "Bereavement", "Jury Duty" and "Medical" are recorded *absences*, not votes,
// and folding them into "abstain" turns a member who was not there into a
// member who was there and declined to take a position. Those are different
// claims about a person's participation, and only one of them is true.
//
// Source: https://webapi.legistar.com/v1/nyc/VoteTypes (client `nyc`),
// retained as site/data/legistar_sources/vote_types.json.
const PUBLISHER_VOTE_TYPES = Object.freeze([
  { name: "Present", result: 0, used_for: 1 },
  { name: "Affirmative", result: 1, used_for: 2 },
  { name: "Negative", result: 2, used_for: 2 },
  { name: "Abstain", result: 0, used_for: 2 },
  { name: "Recused", result: 0, used_for: 2 },
  { name: "Non-voting", result: 0, used_for: 2 },
  { name: "Absent", result: 0, used_for: 3 },
  { name: "Excused", result: 0, used_for: 3 },
  { name: "Bereavement", result: 0, used_for: 3 },
  { name: "Medical", result: 0, used_for: 3 },
  { name: "Maternity", result: 0, used_for: 3 },
  { name: "Paternity", result: 0, used_for: 3 },
  { name: "Parental", result: 0, used_for: 3 },
  { name: "Jury Duty", result: 0, used_for: 3 },
  { name: "Suspended", result: 0, used_for: 3 },
  { name: "Conflict", result: 0, used_for: 3 },
  { name: "Simultaneous", result: 0, used_for: 3 },
]);

/**
 * The classification a vote row is placed in. `vote_value` always keeps the
 * publisher's own label; this is only the machine-comparable class.
 *
 *   aye / nay        a substantive position on the question
 *   abstain          present and explicitly recorded as abstaining
 *   recused          present and withdrawn from the question
 *   non_voting       present and recorded as not voting
 *   present          an attendance roll entry, not a vote on a question
 *   absent           a recorded absence, whatever reason the publisher gave
 *   unknown          a label this classifier does not recognise
 */
export const VOTE_BUCKETS = Object.freeze([
  "aye",
  "nay",
  "abstain",
  "recused",
  "non_voting",
  "present",
  "absent",
  "unknown",
]);

/** Buckets that state a position on the question being decided. */
export const SUBSTANTIVE_VOTE_BUCKETS = Object.freeze(["aye", "nay"]);

/** Buckets in which the member took part in the roll without stating a position. */
export const PARTICIPATING_NON_POSITION_BUCKETS = Object.freeze([
  "abstain",
  "recused",
  "non_voting",
  "present",
]);

/**
 * Coarse participation class, for counting and for copy that must not describe
 * an absence as a vote.
 *
 *   voted     aye / nay
 *   declined  present for the roll, no position recorded
 *   absent    a recorded absence
 *   unknown   an unrecognised or missing label
 */
export const VOTE_PARTICIPATION = Object.freeze({
  aye: "voted",
  nay: "voted",
  abstain: "declined",
  recused: "declined",
  non_voting: "declined",
  present: "declined",
  absent: "absent",
  unknown: "unknown",
});

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeVoteLabel = (value) => clean(value).toLowerCase().replace(/[\s_-]+/g, " ");

const PUBLISHER_BUCKET_BY_LABEL = new Map(PUBLISHER_VOTE_TYPES.map((type) => {
  const bucket = type.result === 1
    ? "aye"
    : type.result === 2
      ? "nay"
      : type.used_for === 3
        ? "absent"
        : type.name === "Recused"
          ? "recused"
          : type.name === "Non-voting"
            ? "non_voting"
            : type.name === "Present"
              ? "present"
              : "abstain";
  return [normalizeVoteLabel(type.name), bucket];
}));

// Conservative synonyms for publishers and fixtures that do not use the NYC
// vocabulary. Anything not matched here stays `unknown` with its label intact —
// an unrecognised label is a gap in this table, never an assumed abstention.
const VOTE_AYE = /^(aye|yes|yea|y|in favor|approve|approved|affirmative)$/i;
const VOTE_NAY = /^(nay|no|n|against|reject|rejected|deny|denied|negative)$/i;
const VOTE_ABSTAIN = /^(abstain|abstains|abstained|abstention|abstaining)$/i;
const VOTE_RECUSED = /^(recuse|recused|recusal)$/i;
const VOTE_NON_VOTING = /^(non voting|not voting|no vote|did not vote)$/i;
const VOTE_PRESENT = /^(present)$/i;
const VOTE_ABSENT = /^(absent|excused|bereavement|medical|maternity|paternity|parental|jury duty|suspended|conflict|simultaneous|leave of absence)$/i;

/**
 * Classify a publisher vote label. The raw label is never discarded by callers;
 * this only says which comparable class it belongs to.
 *
 * A missing or unrecognised label returns "unknown". It deliberately does not
 * return "abstain": an abstention is something a member did, and inferring one
 * from a blank field would publish a participation claim the source never made.
 *
 * @param {string} value
 * @returns {typeof VOTE_BUCKETS[number]}
 */
export function voteBucket(value) {
  const text = normalizeVoteLabel(value);
  if (!text) return "unknown";
  const published = PUBLISHER_BUCKET_BY_LABEL.get(text);
  if (published) return published;
  if (VOTE_AYE.test(text)) return "aye";
  if (VOTE_NAY.test(text)) return "nay";
  if (VOTE_ABSTAIN.test(text)) return "abstain";
  if (VOTE_RECUSED.test(text)) return "recused";
  if (VOTE_NON_VOTING.test(text)) return "non_voting";
  if (VOTE_PRESENT.test(text)) return "present";
  if (VOTE_ABSENT.test(text)) return "absent";
  return "unknown";
}

/**
 * Coarse participation class for one bucket (or one raw publisher label).
 * @param {string} bucketOrValue
 * @returns {"voted"|"declined"|"absent"|"unknown"}
 */
export function voteParticipation(bucketOrValue) {
  const key = clean(bucketOrValue).toLowerCase().replace(/[\s-]+/g, "_");
  return VOTE_PARTICIPATION[key] || VOTE_PARTICIPATION[voteBucket(bucketOrValue)] || "unknown";
}

/** Whether this bucket states a position on the question. */
export function isSubstantiveVote(bucket) {
  return SUBSTANTIVE_VOTE_BUCKETS.includes(clean(bucket).toLowerCase());
}

/** Whether this bucket records that the member was not there. */
export function isRecordedAbsence(bucket) {
  return voteParticipation(bucket) === "absent";
}

/** A zeroed count bag with every bucket present, so a bucket is never implied by omission. */
export function emptyVoteCounts() {
  const counts = {};
  for (const bucket of VOTE_BUCKETS) counts[bucket] = 0;
  return counts;
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
 *   vote_bucket: typeof VOTE_BUCKETS[number],
 *   vote_participation: "voted"|"declined"|"absent"|"unknown",
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

  const bucket = voteBucket(voteValue);
  return {
    person_id: personId,
    person_name: personName,
    // The publisher's own label, kept verbatim. A reader is shown this, not a
    // bucket name, wherever the source's own wording is the honest thing to say.
    vote_value: voteValue,
    vote_bucket: bucket,
    vote_participation: VOTE_PARTICIPATION[bucket] || "unknown",
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
 * @param {{ matterId?: string|null, agendaItemId?: string|null, eventItemId?: string|null, eventId?: string|null }} target
 * @returns {Array<object>}
 */
export function buildVotesOnEdges(persons = [], target = {}) {
  const matterId = clean(target.matterId);
  const eventItemId = clean(target.eventItemId ?? target.agendaItemId);
  const agendaItemId = clean(target.agendaItemId ?? target.eventItemId);
  const eventId = clean(target.eventId);
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
    // The same official can vote on the same matter at more than one meeting,
    // and on more than one action at one meeting. Event and event-item identity
    // are part of the edge key, so a later row never stands in for an earlier one.
    const key = `${from}\0${to}\0${eventId}\0${eventItemId}\0${person.vote_bucket}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      type: VOTES_ON_LINK_TYPE,
      from,
      to,
      to_type: toType,
      event_id: eventId || null,
      event_item_id: eventItemId || null,
      vote_bucket: person.vote_bucket,
      vote_participation: person.vote_participation
        || VOTE_PARTICIPATION[person.vote_bucket]
        || "unknown",
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
 * @param {{ matterId?: string|null, agendaItemId?: string|null, eventItemId?: string|null, eventId?: string|null }} target
 * @returns {null|{
 *   result: string|null,
 *   counts: Record<typeof VOTE_BUCKETS[number], number>,
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

  const counts = emptyVoteCounts();
  const participation = { voted: 0, declined: 0, absent: 0, unknown: 0 };
  const labels = new Map();
  const byPerson = [];
  for (const row of list) {
    const value = readVoteValueLabel(row || {});
    const bucket = voteBucket(value);
    counts[bucket] += 1;
    participation[VOTE_PARTICIPATION[bucket] || "unknown"] += 1;
    // Exact publisher wording and its own count, so "41 Absent" and
    // "5 Bereavement" stay two distinct facts rather than one rounded one.
    const label = clean(value) || "(no label published)";
    labels.set(label, (labels.get(label) || 0) + 1);
    const person = normalizeVotePersonRow(row || {});
    if (person) byPerson.push(person);
  }

  // The outcome is decided by the positions taken. A recorded absence is not a
  // position, so it can neither carry nor defeat a question.
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
    participation,
    published_vote_values: [...labels.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([vote_value, rows_count]) => ({ vote_value, rows: rows_count })),
    // Which publisher event and event item this roll call belongs to. Without
    // these a summary is unattributable and can be applied to the wrong meeting.
    event_id: clean(target.eventId) || null,
    event_item_id: clean(target.eventItemId ?? target.agendaItemId) || null,
    matter_id: clean(target.matterId) || null,
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
