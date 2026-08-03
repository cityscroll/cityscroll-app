// Person-level roll-call lookup (precompute-first for #official/{id}).
//
//   node --test test/person_votes.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PERSON_VOTES_DEMO_IDS,
  PERSON_VOTES_LOOKUP_SCHEMA_VERSION,
  buildPersonVotesLookup,
  compactPersonVoteRow,
  filterVotesForHearing,
  normalizePersonId,
  personVotesForId,
  sortPersonVotes,
} from "../site/person_votes.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const peoplePath = join(root, "../site/data/people_domain_observations.json");
const lookupPath = join(root, "../site/data/person_votes_lookup.json");

test("normalizePersonId strips official: prefix", () => {
  assert.equal(normalizePersonId("official:7801"), "7801");
  assert.equal(normalizePersonId("7801"), "7801");
  assert.equal(normalizePersonId(""), "");
});

test("compactPersonVoteRow requires person_id + name", () => {
  assert.equal(compactPersonVoteRow({}), null);
  assert.equal(compactPersonVoteRow({ person_id: "1" }), null);
  const row = compactPersonVoteRow({
    person_id: "7801",
    person_name: "Christopher Marte",
    vote: "Affirmative",
    vote_bucket: "aye",
    matter_id: "79193",
    matter_file: "LU 0112-2026",
    request_id: "20260706036",
    event_id: "22526",
    event_date: "2026-07-14",
  });
  assert.equal(row.person_id, "7801");
  assert.equal(row.vote_bucket, "aye");
  assert.equal(row.request_id, "20260706036");
});

test("buildPersonVotesLookup groups and sorts by event_date desc", () => {
  const lookup = buildPersonVotesLookup({
    domain: "people",
    retrieved_at: "2026-08-02T00:00:00.000Z",
    source: { system: "legistar", via: "by_person" },
    rows: [
      {
        person_id: "1",
        person_name: "Ada",
        vote: "Aye",
        vote_bucket: "aye",
        matter_id: "a",
        matter_file: "Res 1",
        event_id: "10",
        request_id: "n1",
        event_date: "2026-01-01",
      },
      {
        person_id: "1",
        person_name: "Ada",
        vote: "Nay",
        vote_bucket: "nay",
        matter_id: "b",
        matter_file: "Res 2",
        event_id: "20",
        request_id: "n2",
        event_date: "2026-06-01",
      },
      {
        person_id: "2",
        person_name: "Ben",
        vote: "Aye",
        vote_bucket: "aye",
        matter_id: "a",
        event_id: "10",
        request_id: "n1",
        event_date: "2026-01-01",
      },
    ],
  });
  assert.equal(lookup.schema_version, PERSON_VOTES_LOOKUP_SCHEMA_VERSION);
  assert.equal(lookup.person_count, 2);
  assert.equal(lookup.row_count, 3);
  const ada = personVotesForId(lookup, "1");
  assert.equal(ada.votes[0].matter_id, "b");
  assert.equal(ada.votes[0].vote_bucket, "nay");
  assert.equal(ada.votes[1].matter_id, "a");
});

test("filterVotesForHearing scopes by notice or event", () => {
  const votes = [
    { request_id: "n1", event_id: "e1", matter_id: "1" },
    { request_id: "n2", event_id: "e2", matter_id: "2" },
  ];
  assert.equal(filterVotesForHearing(votes, { noticeId: "n1" }).length, 1);
  assert.equal(filterVotesForHearing(votes, { eventId: "e2" })[0].matter_id, "2");
  assert.equal(filterVotesForHearing(votes, {}).length, 2);
});

test("sortPersonVotes is stable newest-first", () => {
  const sorted = sortPersonVotes([
    { event_date: "2026-01-01", matter_file: "B" },
    { event_date: "2026-03-01", matter_file: "A" },
  ]);
  assert.equal(sorted[0].event_date, "2026-03-01");
});

test("committed person_votes_lookup matches people densify field case", () => {
  assert.ok(existsSync(peoplePath), "people_domain_observations required");
  assert.ok(existsSync(lookupPath), "person_votes_lookup required — run tools/build_person_votes_lookup.mjs");
  const people = JSON.parse(readFileSync(peoplePath, "utf8"));
  const lookup = JSON.parse(readFileSync(lookupPath, "utf8"));
  assert.ok(lookup.schema_version >= 1);
  assert.ok(lookup.person_count >= 1);
  assert.ok(lookup.by_person_id && typeof lookup.by_person_id === "object");

  for (const id of PERSON_VOTES_DEMO_IDS) {
    const bag = personVotesForId(lookup, id);
    assert.ok(bag, `demo person ${id} in lookup`);
    assert.ok(bag.votes.length >= 1, `demo person ${id} has votes`);
    assert.match(String(bag.person_name || ""), /Marte/i);
    assert.ok(
      bag.votes.some((v) => String(v.request_id) === "20260706036"),
      "demo notice 20260706036 on Marte votes",
    );
  }

  // Rebuild from people domain yields same person set (not necessarily byte-identical
  // if retrieval stamps differ — person ids must align).
  const rebuilt = buildPersonVotesLookup(people);
  assert.equal(rebuilt.person_count, lookup.person_count);
  for (const id of Object.keys(lookup.by_person_id)) {
    assert.ok(rebuilt.by_person_id[id], `rebuild retains person ${id}`);
  }
});

test("lookup never invents person rows without person_id + name", () => {
  const lookup = buildPersonVotesLookup([
    { person_id: "", person_name: "Ghost", vote: "Aye" },
    { person_id: "9", person_name: "", vote: "Aye" },
    { vote_bucket: "aye" },
  ]);
  assert.equal(lookup.person_count, 0);
  assert.equal(lookup.row_count, 0);
});
