// Vote evidence stays bound to the meeting and the agenda item it was recorded
// on, and a recorded absence stays an absence.
//
//   node --test test/existing_connections_vote_identity.test.mjs
//
// Two separate claims are under test here.
//
// The first is identity. A Council matter is often heard more than once — a
// hearing in March and an approval in April — and a single meeting can take
// more than one action on it. Each of those is its own agenda item with its own
// roll call, or with none at all. Keying vote summaries by matter alone made the
// last roster observed stand in for every appearance, which showed a reader one
// meeting's vote under another meeting's date and filled in a full roster on
// actions where the Council recorded no vote at all.
//
// The second is status. The publisher's own vocabulary distinguishes a cast
// vote from a recorded absence: "Absent", "Bereavement", "Jury Duty" and
// "Medical" are absences, and "Abstain" is a choice made in the room. Folding
// them together describes a member who was not there as one who was there and
// declined to take a position.
//
// The fixtures below are the publisher's own item-level records for the
// meetings named in each case, and the committed artifacts are checked against
// them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  VOTE_BUCKETS,
  isRecordedAbsence,
  isSubstantiveVote,
  summarizePersonVotes,
  voteBucket,
  voteParticipation,
} from "../entity_resolution/officials/index.mjs";
import {
  buildMeetingOutcomes,
  indexVoteSummaries,
  normalizeCouncilAgendaItem,
} from "../worker/src/lib/meeting_outcomes.mjs";
import { compactVotes } from "../site/meeting_outcomes_static.mjs";
import { buildPersonVotesLookup } from "../site/person_votes.mjs";
import {
  buildLegislativeMatterDocument,
  renderLegislativeMatterDocument,
} from "../site/legislative_matter_document.mjs";

const read = (relative) =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

const matterLookup = read("../site/data/legislative_matter_lookup.json");
const people = read("../site/data/people_domain_observations.json");
const personVotes = read("../site/data/person_votes_lookup.json");
const voteTypes = read("../site/data/legistar_sources/vote_types.json");

/** Publisher-shaped agenda items for one meeting. */
const item = (eventId, itemId, matterId, action) => ({
  EventItemId: itemId,
  EventItemEventId: eventId,
  EventItemMatterId: matterId,
  EventItemMatterFile: `LU ${matterId}`,
  EventItemActionName: action,
});

const notice = (requestId, date) => ({
  request_id: requestId,
  short_title: "Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions",
  event_date: date,
});

const event = (eventId, date) => ({
  EventId: eventId,
  EventBodyName: "Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions",
  EventDate: `${date}T00:00:00`,
});

const summary = (eventId, itemId, matterId, rows) => ({
  matter_id: matterId,
  event_id: eventId,
  event_item_id: itemId,
  ...summarizePersonVotes(rows, {
    matterId,
    agendaItemId: itemId,
    eventItemId: itemId,
    eventId,
  }),
});

const person = (personId, name, value) => ({
  VotePersonId: personId,
  VotePersonName: name,
  VoteValueName: value,
});

function bucketsFor(matterId, eventId) {
  const entry = matterLookup.matters[matterId];
  const appearance = entry.appearances.find((row) => row.event.event_id === eventId);
  return appearance;
}

// ---------------------------------------------------------------------------
// Identity: one matter, two meetings.
// ---------------------------------------------------------------------------

test("a matter heard twice keeps each meeting's own vote", () => {
  // Deliberately constructed: the same member votes one way at the earlier
  // meeting and the other way at the later one. Under a matter-keyed map both
  // meetings reported the later vote, so the earlier position disappeared.
  const items = [
    item("22567", "early-item", "79062", "Hearing Held by Committee"),
    item("22526", "later-item", "79062", "Approved by Subcommittee"),
  ];
  const votes = [
    summary("22567", "early-item", "79062", [person(7801, "Christopher Marte", "Affirmative")]),
    summary("22526", "later-item", "79062", [person(7801, "Christopher Marte", "Negative")]),
  ];
  const view = buildMeetingOutcomes(
    [notice("n-early", "2026-07-09"), notice("n-later", "2026-07-14")],
    [event("22567", "2026-07-09"), event("22526", "2026-07-14")],
    items,
    votes,
    [],
  );
  const byDate = view.records.map((record) => [
    record.council_event.event_date,
    record.agenda_items[0].matters[0].votes[0].by_person[0].vote_bucket,
  ]);
  assert.deepEqual(byDate, [["2026-07-09", "aye"], ["2026-07-14", "nay"]]);
});

test("two actions on one matter at one meeting stay distinguishable", () => {
  // The July 14 Landmarks subcommittee took two actions on this matter. Only
  // the approval was voted on; the hearing was not.
  const items = [
    item("22526", "440248", "79062", "Hearing Held by Committee"),
    item("22526", "440494", "79062", "Approved by Subcommittee"),
  ];
  const votes = [
    summary("22526", "440494", "79062", [
      person(7801, "Christopher Marte", "Affirmative"),
      person(7798, "David M. Carr", "Absent"),
    ]),
  ];
  const view = buildMeetingOutcomes(
    [notice("20260706036", "2026-07-14")],
    [event("22526", "2026-07-14")],
    items,
    votes,
    [],
  );
  const agenda = view.records[0].agenda_items;
  assert.deepEqual(
    agenda.map((row) => [row.agenda_item_id, row.matters[0].votes.length]),
    [["440248", 0], ["440494", 1]],
  );
  const recorded = agenda[1].matters[0].votes[0];
  assert.equal(recorded.event_item_id, "440494");
  assert.equal(recorded.counts.aye, 1);
  assert.equal(recorded.counts.absent, 1);
  assert.equal(recorded.counts.abstain, 0);
});

test("a summary that names no meeting is dropped where attachment is ambiguous", () => {
  // Negative control for the repair itself. A summary carrying only a matter id
  // cannot say which appearance it belongs to. It is attached only where that
  // matter appears exactly once, and never copied across two appearances.
  const twoAppearances = [
    item("22567", "early-item", "79062", "Hearing Held by Committee"),
    item("22526", "later-item", "79062", "Approved by Subcommittee"),
  ].map(normalizeCouncilAgendaItem);
  const unattributed = [{ matter_id: "79062", counts: { aye: 1 }, person_count: 1, by_person: [] }];
  const ambiguous = indexVoteSummaries(unattributed, twoAppearances);
  assert.equal(ambiguous.resolve(twoAppearances[0]), null);
  assert.equal(ambiguous.resolve(twoAppearances[1]), null);

  // The same summary still attaches to a matter observed once, so an older
  // materialization that predates event stamping is not silently discarded.
  const oneAppearance = [item("22526", "later-item", "79062", "Approved by Subcommittee")]
    .map(normalizeCouncilAgendaItem);
  const unambiguous = indexVoteSummaries(unattributed, oneAppearance);
  assert.equal(unambiguous.resolve(oneAppearance[0]), unattributed[0]);

  // Naming the meeting is not enough when that meeting acted twice. A hearing
  // and a layover are two agenda items and only one of them may have a vote.
  const twoActionsOneMeeting = [
    item("22526", "440248", "79062", "Hearing Held by Committee"),
    item("22526", "440494", "79062", "Approved by Subcommittee"),
  ].map(normalizeCouncilAgendaItem);
  const meetingOnly = [{ matter_id: "79062", event_id: "22526", counts: { aye: 1 }, person_count: 1, by_person: [] }];
  const perMeeting = indexVoteSummaries(meetingOnly, twoActionsOneMeeting);
  assert.equal(perMeeting.resolve(twoActionsOneMeeting[0]), null);
  assert.equal(perMeeting.resolve(twoActionsOneMeeting[1]), null);
});

// ---------------------------------------------------------------------------
// Identity, as published: the committed matter histories.
// ---------------------------------------------------------------------------

test("a meeting that recorded no roll call publishes none, even when a later one did", () => {
  // Public School 15 Annex, heard on July 9 and approved on July 14. The
  // publisher records no votes on either July 9 agenda item.
  const july9 = bucketsFor("79062", "22567");
  const july14 = bucketsFor("79062", "22526");
  assert.equal(july9.event.date, "2026-07-09");
  assert.equal(july9.votes, null);
  assert.deepEqual(
    july9.item_actions.map((row) => [row.event_item_id, row.vote_state]),
    [["440187", "no_roll_call_recorded"], ["440237", "no_roll_call_recorded"]],
  );
  assert.equal(july14.event.date, "2026-07-14");
  assert.equal(july14.votes.by_person.length, 7);
  assert.deepEqual(
    july14.item_actions.map((row) => [row.event_item_id, row.vote_state]),
    [["440248", "no_roll_call_recorded"], ["440494", "roll_call_recorded"]],
  );
  assert.equal(july14.item_actions[1].votes.event_item_id, "440494");
});

test("the two Hamilton Avenue matters keep the March hearing separate from the April approval", () => {
  for (const matterId of ["78409", "78411"]) {
    const march = bucketsFor(matterId, "22300");
    const april = bucketsFor(matterId, "22365");
    assert.equal(march.event.date, "2026-03-18");
    assert.equal(march.votes, null, `matter ${matterId} has no March roll call`);
    assert.equal(
      march.item_actions.every((row) => row.vote_state === "no_roll_call_recorded"),
      true,
    );
    assert.equal(april.event.date, "2026-04-14");
    assert.equal(april.votes.by_person.length, 9);
    assert.equal(april.votes.event_item_id, april.item_actions.at(-1).event_item_id);
  }
});

test("no two appearances of one matter share a roll call", () => {
  // The defect's signature was two appearances with byte-identical rosters.
  for (const entry of Object.values(matterLookup.matters)) {
    if (entry.appearances.length < 2) continue;
    const rosters = entry.appearances
      .filter((appearance) => appearance.votes)
      .map((appearance) => JSON.stringify(appearance.votes.by_person));
    assert.equal(
      new Set(rosters).size,
      rosters.length,
      `matter ${entry.matter_id} repeats one roster across appearances`,
    );
  }
});

test("every published roll call names the agenda item it was recorded on", () => {
  for (const entry of Object.values(matterLookup.matters)) {
    for (const appearance of entry.appearances) {
      const itemIds = new Set(appearance.item_actions.map((row) => row.event_item_id));
      for (const row of appearance.item_actions) {
        if (row.vote_state !== "roll_call_recorded") {
          assert.equal(row.votes, null);
          continue;
        }
        assert.ok(row.votes, `${entry.matter_id} claims a roll call with no rows`);
        assert.equal(row.votes.event_item_id, row.event_item_id);
      }
      if (appearance.votes) {
        assert.ok(
          itemIds.has(appearance.votes.event_item_id),
          `matter ${entry.matter_id} shows a vote from outside its own agenda items`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Status: an absence is not a vote.
// ---------------------------------------------------------------------------

test("the classifier follows the publisher's own vote-value vocabulary", () => {
  // The publisher marks each vote value with what it is used for: 1 an
  // attendance roll, 2 a cast vote, 3 a recorded absence.
  for (const type of voteTypes.vote_types) {
    const bucket = voteBucket(type.name);
    assert.ok(VOTE_BUCKETS.includes(bucket), `${type.name} is classified`);
    if (type.used_for === 3) {
      assert.equal(bucket, "absent", `${type.name} is a recorded absence`);
      assert.equal(isRecordedAbsence(bucket), true);
      assert.equal(isSubstantiveVote(bucket), false);
    }
    if (type.result === 1) assert.equal(bucket, "aye");
    if (type.result === 2) assert.equal(bucket, "nay");
  }
  assert.equal(voteBucket("Absent"), "absent");
  assert.equal(voteBucket("Bereavement"), "absent");
  assert.equal(voteBucket("Abstain"), "abstain");
  assert.equal(voteBucket("Recused"), "recused");
  assert.notEqual(voteBucket("Absent"), voteBucket("Abstain"));
  assert.notEqual(voteBucket("Bereavement"), voteBucket("Abstain"));
});

test("an unrecognised or missing label is unknown, never an abstention", () => {
  // Negative control. Inferring an abstention from a blank field would publish a
  // participation claim the source never made.
  assert.equal(voteBucket(""), "unknown");
  assert.equal(voteBucket(null), "unknown");
  assert.equal(voteBucket("Teleconference"), "unknown");
  assert.equal(voteParticipation("unknown"), "unknown");
  assert.equal(voteParticipation("absent"), "absent");
  assert.equal(voteParticipation("abstain"), "declined");
  assert.equal(voteParticipation("aye"), "voted");
});

test("absences are counted apart from abstentions and do not decide the question", () => {
  const rows = [
    person(1, "A", "Affirmative"),
    person(2, "B", "Affirmative"),
    person(3, "C", "Absent"),
    person(4, "D", "Bereavement"),
    person(5, "E", "Abstain"),
    person(6, "F", ""),
  ];
  const result = summarizePersonVotes(rows, { matterId: "m", eventItemId: "i", eventId: "e" });
  assert.equal(result.counts.aye, 2);
  assert.equal(result.counts.nay, 0);
  assert.equal(result.counts.abstain, 1);
  assert.equal(result.counts.absent, 2);
  assert.equal(result.counts.unknown, 1);
  assert.deepEqual(result.participation, { voted: 2, declined: 1, absent: 2, unknown: 1 });
  // The publisher's own words survive with their own counts.
  assert.deepEqual(
    result.published_vote_values.filter((entry) => entry.vote_value !== "(no label published)"),
    [
      { vote_value: "Affirmative", rows: 2 },
      { vote_value: "Absent", rows: 1 },
      { vote_value: "Abstain", rows: 1 },
      { vote_value: "Bereavement", rows: 1 },
    ],
  );
  assert.equal(result.result, "Passed");

  const compact = compactVotes([result]);
  assert.equal(compact.abstain, 1);
  assert.equal(compact.absent, 2);
  assert.equal(compact.by_person.find((row) => row.person_id === "3").vote_value, "Absent");
  assert.equal(compact.by_person.find((row) => row.person_id === "4").vote_bucket, "absent");
});

test("no committed person row calls a recorded absence an abstention", () => {
  assert.ok(people.rows.length > 0);
  for (const row of people.rows) {
    const published = String(row.vote || "");
    const bucket = String(row.vote_bucket || "");
    assert.equal(bucket, voteBucket(published), `${published} is classified consistently`);
    if (/^(Absent|Bereavement|Excused|Medical|Maternity|Paternity|Parental|Jury Duty|Suspended|Conflict|Simultaneous)$/.test(published)) {
      assert.equal(bucket, "absent");
      assert.equal(row.vote_participation, "absent");
    }
    assert.notEqual(
      bucket === "abstain" && published !== "Abstain",
      true,
      `${published} must not be published as an abstention`,
    );
    // Never a bare status with no publisher wording behind it.
    assert.ok(published, "every row keeps the publisher's own label");
    assert.ok(row.event_id && row.event_item_id, "every row names its meeting and agenda item");
  }
  const abstentions = people.rows.filter((row) => row.vote_bucket === "abstain");
  assert.equal(
    abstentions.length,
    people.rows.filter((row) => row.vote === "Abstain").length,
    "abstentions are exactly the rows the Council published as abstentions",
  );
});

// ---------------------------------------------------------------------------
// The published person index and the rendered page.
// ---------------------------------------------------------------------------

test("one official's votes are addressed by agenda item, and repeated notices do not double-count", () => {
  const rows = [
    {
      person_id: "7801", person_name: "Christopher Marte", vote: "Affirmative", vote_bucket: "aye",
      matter_id: "79062", event_id: "22526", event_item_id: "440248", request_id: "a", event_date: "2026-07-14",
    },
    {
      person_id: "7801", person_name: "Christopher Marte", vote: "Affirmative", vote_bucket: "aye",
      matter_id: "79062", event_id: "22526", event_item_id: "440494", request_id: "a", event_date: "2026-07-14",
    },
    // The same agenda item reached through a second notice for one meeting.
    {
      person_id: "7801", person_name: "Christopher Marte", vote: "Affirmative", vote_bucket: "aye",
      matter_id: "79062", event_id: "22526", event_item_id: "440494", request_id: "b", event_date: "2026-07-14",
    },
  ];
  const built = buildPersonVotesLookup(rows);
  const bag = built.by_person_id["7801"];
  assert.equal(bag.vote_count, 2);
  assert.deepEqual(bag.votes.map((row) => row.event_item_id).sort(), ["440248", "440494"]);

  // And the committed index carries the same identity.
  for (const person of Object.values(personVotes.by_person_id)) {
    for (const vote of person.votes) {
      assert.ok(vote.event_item_id, `${person.person_id} has a row with no agenda item`);
    }
  }
});

test("the matter page states the absence and says where no roll call was taken", () => {
  const view = buildLegislativeMatterDocument(matterLookup, "79062");
  const html = renderLegislativeMatterDocument(view, { currentHref: "/matters/79062/", today: "2026-09-07" });

  // The July 9 appearance says, on each of its actions, that no vote was taken.
  assert.match(html, /No roll call was recorded on this action\./);
  assert.equal((html.match(/No roll call was recorded on this action\./g) || []).length, 3);

  // The July 14 approval shows the Council's own word for the member who was
  // not there, counted apart from abstentions.
  assert.match(html, /6 yes · 0 no · 1 not present/);
  assert.match(html, /not present, recorded as Absent/);
  assert.doesNotMatch(html, /1 abstain\b/);

  // Machine attributes carry the same distinction for assistive technology and
  // for anything reading the page rather than looking at it.
  assert.match(html, /data-vote-participation="absent"/);
  assert.match(html, /data-vote-bucket="aye"/);
  assert.match(html, /data-event-item-id="440494"/);
  assert.match(html, /data-vote-state="no_roll_call_recorded"/);

  // The page is a plain document: every appearance renders without script.
  assert.doesNotMatch(html.split("<main")[1] || "", /<script/);
});
