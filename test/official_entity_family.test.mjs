// Official entity family + person-level vote metrics.
//
//   node --test test/official_entity_family.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ENTITY_TYPE_FAMILIES,
  OFFICIAL_ENTITY_TYPE,
  OFFICIAL_PRIMARY_KEY_PATTERN,
  VOTES_ON_LINK_TYPE,
  buildVotesOnEdges,
  classifyVoteIdentity,
  measureOfficialVoteMetrics,
  normalizeVotePersonRow,
  officialEntityId,
  summarizePersonVotes,
  voteBucket,
} from "../entity_resolution/officials/index.mjs";
import {
  PUBLIC_GRAPH_EDGE_TYPES,
  PUBLIC_GRAPH_NODE_TYPES,
} from "../entity_resolution/publication/relationship_graph.mjs";
import { buildMeetingOutcomes } from "../worker/src/lib/meeting_outcomes.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(root, "contract/fixtures/meeting_outcomes.json"), "utf8"),
);

test("official is a registered ER type family", () => {
  assert.ok(ENTITY_TYPE_FAMILIES.includes("official"));
  assert.equal(OFFICIAL_ENTITY_TYPE, "official");
  assert.equal(OFFICIAL_PRIMARY_KEY_PATTERN, "official:{person_id}");
  assert.equal(VOTES_ON_LINK_TYPE, "votes_on");
});

test("officialEntityId prefers PersonId over name fallback", () => {
  assert.equal(officialEntityId({ personId: 22526, personName: "Ada" }), "official:22526");
  assert.equal(
    officialEntityId({ personName: "Ada Councilmember" }),
    "official:name:ada%20councilmember",
  );
  assert.equal(officialEntityId({}), null);
});

test("normalizeVotePersonRow maps Legistar person fields", () => {
  const row = normalizeVotePersonRow({
    PersonId: 42,
    PersonName: "Ada Councilmember",
    VoteValue: "Aye",
  });
  assert.equal(row.official.entity_type, "official");
  assert.equal(row.official.id, "official:42");
  assert.equal(row.vote_bucket, "aye");
  assert.equal(voteBucket("Against"), "nay");
});

test("normalizeVotePersonRow retains live Granicus VotePerson* fields", () => {
  // Live EventItems/{id}/Votes shape (event 22526 / item 440494 audit 2026-08-02).
  const row = normalizeVotePersonRow({
    VoteId: 1031408,
    VotePersonId: 7801,
    VotePersonName: "Christopher Marte",
    VoteValueId: 15,
    VoteValueName: "Affirmative",
    VoteResult: 1,
    VoteEventItemId: 440494,
  });
  assert.equal(row.person_id, "7801");
  assert.equal(row.person_name, "Christopher Marte");
  assert.equal(row.official.id, "official:7801");
  assert.equal(row.vote_value, "Affirmative");
  assert.equal(row.vote_bucket, "aye");
  assert.equal(voteBucket("Negative"), "nay");
  assert.equal(voteBucket("Affirmative"), "aye");
});

test("summarizePersonVotes: live VotePerson* retained; absent → tally_only", () => {
  const live = summarizePersonVotes(
    [
      {
        VotePersonId: 7801,
        VotePersonName: "Christopher Marte",
        VoteValueName: "Affirmative",
        VoteResult: 1,
      },
      {
        VotePersonId: 7802,
        VotePersonName: "Example Member",
        VoteValueName: "Negative",
        VoteResult: 0,
      },
    ],
    { matterId: "79193" },
  );
  assert.equal(live.person_count, 2);
  assert.equal(live.by_person.length, 2);
  assert.equal(live.person_vote_retention_rate, 1);
  assert.equal(live.vote_identity, "roll_call");
  assert.equal(live.counts.aye, 1);
  assert.equal(live.counts.nay, 1);
  assert.equal(live.by_person[0].official.id, "official:7801");
  assert.equal(live.votes_on.length, 2);

  // Rows with vote labels but no person identity: keep tallies, mark tally_only.
  const voice = summarizePersonVotes(
    [{ VoteValueName: "Affirmative" }, { VoteValueName: "Negative" }],
    { matterId: "x" },
  );
  assert.equal(voice.person_count, 2);
  assert.equal(voice.by_person.length, 0);
  assert.equal(voice.person_vote_retention_rate, 0);
  assert.equal(voice.vote_identity, "tally_only");
  assert.equal(classifyVoteIdentity(voice), "tally_only");
  assert.equal(classifyVoteIdentity(live), "roll_call");
  assert.equal(classifyVoteIdentity(null), "empty");
});

test("buildVotesOnEdges links officials to matters", () => {
  const person = normalizeVotePersonRow({
    PersonId: 7,
    PersonName: "Ben",
    VoteValue: "Nay",
  });
  const edges = buildVotesOnEdges([person], { matterId: "79193" });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, "votes_on");
  assert.equal(edges[0].from, "official:7");
  assert.equal(edges[0].to, "matter:79193");
  assert.equal(edges[0].vote_bucket, "nay");
});

test("person_vote_retention_rate moves from 0 (anonymous) to 1 (identified)", () => {
  const anonymous = summarizePersonVotes(
    [{ VoteValue: "Aye" }, { VoteValue: "Nay" }],
    { matterId: "m1" },
  );
  const identified = summarizePersonVotes(
    [
      { PersonId: 1, PersonName: "A", VoteValue: "Aye" },
      { PersonId: 2, PersonName: "B", VoteValue: "Nay" },
    ],
    { matterId: "m1" },
  );
  const before = measureOfficialVoteMetrics(anonymous);
  const after = measureOfficialVoteMetrics(identified);
  assert.equal(before.person_vote_retention_rate, 0);
  assert.equal(before.official_votes_on_edge_rate, 0);
  assert.equal(after.person_vote_retention_rate, 1);
  assert.equal(after.official_votes_on_edge_rate, 1);
  assert.equal(after.distinct_officials, 2);
});

test("meeting outcomes contract fixture retains officials and votes_on edges", () => {
  const model = buildMeetingOutcomes(
    fixture.notices,
    fixture.events,
    fixture.event_items,
    fixture.votes,
    fixture.attachments,
  );
  const vote = model.records[0].agenda_items[0].matters[0].votes[0];
  assert.equal(vote.by_person.length, 3);
  assert.equal(vote.officials.every((o) => o.entity_type === "official"), true);
  assert.equal(vote.votes_on.every((e) => e.type === "votes_on"), true);
  assert.equal(vote.person_vote_retention_rate, 1);
  assert.equal(vote.official_votes_on_edge_rate, 1);
});

test("public graph allowlist includes official nodes and votes_on edges", () => {
  assert.ok(PUBLIC_GRAPH_NODE_TYPES.includes("official"));
  assert.ok(PUBLIC_GRAPH_EDGE_TYPES.includes("votes_on"));
});

test("source_coverage documents legistar-votes person retention and dual-write", () => {
  const coverage = JSON.parse(
    readFileSync(join(root, "../entity_resolution/source_coverage.json"), "utf8"),
  );
  const votes = coverage.sources.find((s) => s.id === "legistar-votes");
  assert.ok(votes);
  assert.ok(votes.identity_entities.includes("official"));
  assert.ok(votes.stable_source_key.includes("PersonId"));
  // Dual-write is live: complete requires measured row_count > 0 (never false-complete).
  assert.equal(votes.dual_write?.after, "complete");
  assert.equal(votes.dual_write?.adapter, "ready");
  assert.ok(Number(votes.live_observation?.row_count) > 0);
  assert.equal(votes.dual_write?.flag, "LEGISTAR_SOURCE_RECORD_DUAL_WRITE");
  assert.equal(votes.known_gap, null);
  assert.ok(
    /source_records|retain/i.test(votes.person_retention?.status || ""),
    "person_retention should note retention on meeting outcomes and/or source_records",
  );
});

test("people domain observations snapshot retains Marte field case", () => {
  const peoplePath = join(root, "../site/data/people_domain_observations.json");
  const people = JSON.parse(readFileSync(peoplePath, "utf8"));
  assert.equal(people.domain, "people");
  assert.ok(Array.isArray(people.rows) && people.rows.length >= 1);
  const marte = people.rows.find((r) => String(r.person_id) === "7801");
  assert.ok(marte, "expected Christopher Marte person_id 7801");
  assert.match(String(marte.person_name || ""), /Marte/i);
  assert.equal(String(marte.event_id), "22526");
  assert.equal(String(marte.request_id), "20260706036");
  assert.ok(marte.agency_name);
});

test("people domain densifies beyond a single seed notice from roll_call only", () => {
  const peoplePath = join(root, "../site/data/people_domain_observations.json");
  const people = JSON.parse(readFileSync(peoplePath, "utf8"));
  assert.equal(people.domain, "people");
  assert.ok(people.schema_version >= 2, "schema_version bumped for densify materialization");
  const seeds = people.source?.seed_notices || [];
  assert.ok(
    seeds.length >= 2,
    `expected densified seed_notices (≥2 notices with by_person), got ${seeds.length}: ${seeds.join(",")}`,
  );
  assert.ok(
    seeds.includes("20260706036"),
    "demo field-case notice remains in seed_notices",
  );
  assert.ok(
    Number(people.person_count) > 7,
    `expected person_count > 7 after multi-notice densify, got ${people.person_count}`,
  );
  assert.ok(
    Number(people.notice_count || seeds.length) >= 2,
    "notice_count reflects multi-notice densify",
  );
  const noticeIds = new Set(
    (people.rows || []).map((r) => String(r.request_id || "")).filter(Boolean),
  );
  const eventIds = new Set(
    (people.rows || []).map((r) => String(r.event_id || "")).filter(Boolean),
  );
  assert.ok(noticeIds.size >= 2, `expected rows from ≥2 notices, got ${noticeIds.size}`);
  assert.ok(eventIds.size >= 2, `expected rows from ≥2 events, got ${eventIds.size}`);
  // Honest limits: every row is a real named official (never tally-only invent).
  for (const row of people.rows || []) {
    assert.ok(row.person_id && row.person_name, "person_id + person_name required");
    assert.ok(row.request_id, "request_id ties the vote to a meeting-outcomes notice");
  }
});
