/**
 * Person-level Legistar roll-call votes (precompute-first).
 *
 * Indexes people_domain_observations rows by official person_id so the
 * #official/{id} surface can list recent votes across matters without a live
 * multi-event fetch. Never invents officials or tallies.
 *
 * Build: node tools/build_person_votes_lookup.mjs
 * Source: site/data/people_domain_observations.json (from meeting-outcomes by_person)
 */

export const PERSON_VOTES_LOOKUP_SCHEMA_VERSION = 1;
export const PERSON_VOTES_DEMO_IDS = Object.freeze(["7801"]); // Christopher Marte field case

function clean(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return s || "";
}

/**
 * Normalize official id (strip official: prefix).
 * @param {string|number|null|undefined} raw
 * @returns {string}
 */
export function normalizePersonId(raw) {
  const s = clean(raw);
  if (!s) return "";
  return s.startsWith("official:") ? s.slice("official:".length) : s;
}

/**
 * Compact one people-domain row into a vote record for the lookup.
 * @param {object} row
 * @returns {object|null}
 */
export function compactPersonVoteRow(row) {
  if (!row || typeof row !== "object") return null;
  const personId = normalizePersonId(row.person_id || row.PersonId || row.VotePersonId);
  const personName =
    clean(row.person_name)
    || clean(row.PersonName)
    || clean(row.VotePersonName)
    || clean(row.official?.display_name);
  if (!personId || !personName) return null;
  // Never invent from tally-only / missing vote identity on a named row.
  const vote = clean(row.vote) || clean(row.vote_value) || clean(row.VoteValueName) || clean(row.VoteValue);
  const voteBucket = clean(row.vote_bucket) || null;
  return {
    person_id: personId,
    person_name: personName,
    vote: vote || null,
    vote_bucket: voteBucket,
    matter_id: clean(row.matter_id) || null,
    matter_file: clean(row.matter_file) || null,
    matter_title: clean(row.matter_title) || null,
    event_id: clean(row.event_id) || null,
    request_id: clean(row.request_id) || null,
    event_date: clean(row.event_date).slice(0, 10) || null,
    agency_name: clean(row.agency_name) || null,
    source_system: clean(row.source_system) || "legistar",
  };
}

/**
 * Sort votes newest event first, then matter file for stability.
 * @param {object[]} votes
 * @returns {object[]}
 */
export function sortPersonVotes(votes) {
  return [...(votes || [])].sort((a, b) => {
    const da = clean(a?.event_date);
    const db = clean(b?.event_date);
    if (da !== db) return db.localeCompare(da);
    const fa = clean(a?.matter_file) || clean(a?.matter_id);
    const fb = clean(b?.matter_file) || clean(b?.matter_id);
    if (fa !== fb) return fa.localeCompare(fb);
    return clean(a?.request_id).localeCompare(clean(b?.request_id));
  });
}

/**
 * Group people-domain rows into a by_person_id lookup document.
 * @param {object|object[]} peopleDocOrRows - { rows, source, retrieved_at } or row array
 * @param {{ limitPerPerson?: number, totalLimit?: number }} [opts]
 * @returns {object}
 */
export function buildPersonVotesLookup(peopleDocOrRows, opts = {}) {
  const limitPerPerson = Number.isFinite(opts.limitPerPerson)
    ? Math.max(1, opts.limitPerPerson)
    : 40;
  const totalLimit = Number.isFinite(opts.totalLimit)
    ? Math.max(1, opts.totalLimit)
    : 800;

  const isDoc =
    peopleDocOrRows
    && typeof peopleDocOrRows === "object"
    && !Array.isArray(peopleDocOrRows)
    && Array.isArray(peopleDocOrRows.rows);
  const rows = isDoc
    ? peopleDocOrRows.rows
    : Array.isArray(peopleDocOrRows)
      ? peopleDocOrRows
      : [];
  const source = isDoc && peopleDocOrRows.source
    ? { ...peopleDocOrRows.source }
    : {
        system: "legistar",
        read_model: "meeting-outcomes:materialized:v2",
        via: "by_person",
        densify: "meeting_outcomes_list_roll_call",
      };
  const retrievedAt =
    (isDoc && peopleDocOrRows.retrieved_at)
    || new Date().toISOString();

  /** @type {Map<string, { person_id: string, person_name: string, votes: object[] }>} */
  const byId = new Map();
  let total = 0;
  for (const raw of rows) {
    if (total >= totalLimit) break;
    const v = compactPersonVoteRow(raw);
    if (!v) continue;
    let bag = byId.get(v.person_id);
    if (!bag) {
      bag = {
        person_id: v.person_id,
        person_name: v.person_name,
        votes: [],
      };
      byId.set(v.person_id, bag);
    }
    if (bag.votes.length >= limitPerPerson) continue;
    // Dedupe same matter + event + vote
    const key = `${v.event_id || ""}\0${v.matter_id || v.matter_file || ""}\0${v.vote_bucket || v.vote || ""}`;
    if (bag.votes.some((x) =>
      `${x.event_id || ""}\0${x.matter_id || x.matter_file || ""}\0${x.vote_bucket || x.vote || ""}` === key
    )) {
      continue;
    }
    bag.votes.push({
      vote: v.vote,
      vote_bucket: v.vote_bucket,
      matter_id: v.matter_id,
      matter_file: v.matter_file,
      matter_title: v.matter_title,
      event_id: v.event_id,
      request_id: v.request_id,
      event_date: v.event_date,
      agency_name: v.agency_name,
      source_system: v.source_system,
    });
    total += 1;
  }

  /** @type {Record<string, object>} */
  const by_person_id = {};
  for (const [id, bag] of byId) {
    const votes = sortPersonVotes(bag.votes);
    by_person_id[id] = {
      person_id: bag.person_id,
      person_name: bag.person_name,
      vote_count: votes.length,
      votes,
    };
  }

  return {
    schema_version: PERSON_VOTES_LOOKUP_SCHEMA_VERSION,
    title: "Person-level Legistar roll-call votes by official",
    description:
      "Precomputed index of retained by_person votes for the #official/{id} surface. Built from people_domain_observations (meeting-outcomes roll_call densify). Never invents tallies.",
    retrieved_at: retrievedAt,
    source,
    person_count: Object.keys(by_person_id).length,
    row_count: total,
    demo_person_ids: [...PERSON_VOTES_DEMO_IDS],
    by_person_id,
    provenance: {
      method: "people_domain_by_person_index",
      claim: "source_assertion",
      publisher: "NYC Council Legistar (via CityScroll meeting-outcomes)",
    },
  };
}

/**
 * Resolve one official's vote bag from a lookup document.
 * @param {object|null|undefined} lookup
 * @param {string|number} personId
 * @returns {{ person_id: string, person_name: string, vote_count: number, votes: object[] }|null}
 */
export function personVotesForId(lookup, personId) {
  const id = normalizePersonId(personId);
  if (!id || !lookup || typeof lookup !== "object") return null;
  const bag = lookup.by_person_id?.[id];
  if (!bag || !Array.isArray(bag.votes)) return null;
  return {
    person_id: clean(bag.person_id) || id,
    person_name: clean(bag.person_name) || id,
    vote_count: Number(bag.vote_count) || bag.votes.length,
    votes: sortPersonVotes(bag.votes),
  };
}

/**
 * Filter votes to one hearing notice (event-scoped skim).
 * @param {object[]} votes
 * @param {{ noticeId?: string, eventId?: string }} [ctx]
 * @returns {object[]}
 */
export function filterVotesForHearing(votes, ctx = {}) {
  const noticeId = clean(ctx.noticeId);
  const eventId = clean(ctx.eventId);
  if (!noticeId && !eventId) return sortPersonVotes(votes || []);
  return sortPersonVotes(
    (votes || []).filter((v) => {
      if (noticeId && clean(v.request_id) === noticeId) return true;
      if (eventId && clean(v.event_id) === eventId) return true;
      return false;
    }),
  );
}
