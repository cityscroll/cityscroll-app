import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  compactVotes,
  buildMeetingOutcomesSnapshot,
  renderMeetingOutcomesFirstPaint,
} from "../site/meeting_outcomes_static.mjs";
import { measureMeetingPersonVotes } from "../tools/measure_meeting_person_votes.mjs";
import {
  computeNotPublishedRate,
  classifyNotPublishedClaim,
} from "../ontology/dimensions/not_published_rate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_PATH = path.join(
  ROOT,
  "site/data/legistar_sources/verification_receipts/meeting_person_votes_2026-08-11.json",
);
const CLAIMS = JSON.parse(
  readFileSync(
    path.join(ROOT, "ontology/fixtures/dimensions/not_published_claim_samples.json"),
    "utf8",
  ),
);

function rollCallRecord({
  requestId = "20260706036",
  eventId = "22526",
  withPeople = true,
} = {}) {
  return {
    request_id: requestId,
    join: { matched: true, method: "exact_date_body_tokens" },
    notice: { request_id: requestId, agency: "City Council" },
    council_event: {
      event_id: eventId,
      body_name: "Subcommittee on Landmarks",
      event_date: "2026-07-14",
      event_url: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=22526&GID=61&G=abc",
    },
    agenda_items: [{
      matters: [{
        matter_id: "79062",
        matter_file: "LU 0091-2026",
        title: "Landmarks, Public School 15 Annex, Brooklyn",
        outcome: "Approved by Subcommittee",
        matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79062",
        votes: [{
          result: "Passed",
          counts: { aye: 6, nay: 0, abstain: 1 },
          vote_identity: withPeople ? "roll_call" : "tally_only",
          person_count: withPeople ? 7 : 0,
          by_person: withPeople
            ? [
              {
                person_id: "7801",
                person_name: "Christopher Marte",
                vote_bucket: "aye",
              },
              {
                person_id: "5289",
                person_name: "Simcha Felder",
                vote_bucket: "aye",
              },
            ]
            : [],
        }],
      }],
    }],
  };
}

test("compactVotes maps Legistar aye/nay into first-paint yes/no and keeps by_person", () => {
  const compact = compactVotes([{
    result: "Passed",
    counts: { aye: 6, nay: 0, abstain: 1 },
    vote_identity: "roll_call",
    by_person: [
      { person_id: "7801", person_name: "Christopher Marte", vote_bucket: "aye" },
    ],
  }]);
  assert.equal(compact.yes, 6);
  assert.equal(compact.no, 0);
  assert.equal(compact.abstain, 1);
  assert.equal(compact.vote_identity, "roll_call");
  assert.equal(compact.by_person.length, 1);
  assert.equal(compact.by_person[0].person_id, "7801");
});

test("static first paint shows aye/nay tallies and a roll-call name chip", () => {
  const snapshot = buildMeetingOutcomesSnapshot([rollCallRecord()], {
    generatedAt: "2026-08-11T18:00:00Z",
  });
  const matter = snapshot.by_notice["20260706036"].matters[0];
  assert.equal(matter.votes.yes, 6);
  assert.equal(matter.votes.no, 0);
  assert.equal(matter.votes.vote_identity, "roll_call");
  assert.equal(matter.votes.by_person[0].person_name, "Christopher Marte");

  const html = renderMeetingOutcomesFirstPaint(snapshot, "20260706036");
  assert.match(html, /6 yes · 0 no · 1 abstain/);
  assert.match(html, /data-vote-identity="roll_call"/);
  assert.match(html, /Christopher Marte/);
  assert.doesNotMatch(html, /city does not publish/i);
});

test("measureMeetingPersonVotes accepts vote-bearing cohort with full person retention", () => {
  const measured = measureMeetingPersonVotes([
    rollCallRecord({ requestId: "20260706036", eventId: "22526" }),
    rollCallRecord({ requestId: "20260625040", eventId: "22567" }),
    {
      request_id: "20260707022",
      join: { matched: true },
      notice: { agency: "City Council" },
      council_event: { event_id: "22509" },
      agenda_items: [{
        matters: [{
          matter_id: "1",
          matter_file: "LU 1",
          title: "Laid over",
          outcome: "Laid Over by Subcommittee",
          votes: null,
        }],
      }],
    },
  ], { observedAt: "2026-08-11T18:00:00.000Z", source: "fixture" });

  assert.equal(measured.schema, "cityscroll.meeting_person_votes_receipt.v1");
  assert.equal(measured.cohort.matched_council_notices, 3);
  assert.equal(measured.cohort.matched_with_by_person, 2);
  assert.equal(measured.cohort.matched_with_any_votes, 2);
  assert.equal(measured.rates.by_person_of_vote_bearing, 1);
  assert.equal(measured.rates.roll_call_person_retention, 1);
  assert.equal(measured.bridge_status, "accepted");
  assert.equal(measured.usefulness_pass, true);
  assert.equal(measured.precision_pass, true);
  assert.equal(measured.verdict.credibility_red_flag, false);
});

test("committed live receipt clears usefulness and precision gates", () => {
  assert.ok(existsSync(RECEIPT_PATH), "dated receipt must be committed");
  const receipt = JSON.parse(readFileSync(RECEIPT_PATH, "utf8"));
  assert.equal(receipt.bridge_status, "accepted");
  assert.ok(receipt.rates.by_person_of_vote_bearing >= 0.3);
  assert.ok(receipt.rates.roll_call_person_retention >= 0.95);
  assert.equal(receipt.verdict.credibility_red_flag, false);
  assert.ok((receipt.sample_notices || []).includes("20260706036"));
});

test("measure tool --check is deterministic against the committed receipt", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/measure_meeting_person_votes.mjs", "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok /);
});

test("not-published claim sample is healthy (no credibility red flag)", () => {
  const claim = CLAIMS.claims.find((c) => c.id === "meeting-person-votes");
  assert.ok(claim, "meeting-person-votes claim missing");
  const rate = computeNotPublishedRate(claim.sample);
  const classified = classifyNotPublishedClaim(rate, claim);
  assert.equal(classified.red_flag, false);
  assert.equal(classified.classification, "healthy");
  assert.ok(rate.non_null >= 1);
  assert.ok(rate.rate < 0.85);
});
