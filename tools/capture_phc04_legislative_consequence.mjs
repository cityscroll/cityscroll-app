#!/usr/bin/env node
/**
 * PHC-04 evidence helper: render the meeting detail page (site/meeting_document.mjs's
 * renderMeetingDocument()) for five synthetic City Record records, one per state named
 * in the card (a single exact matter join, several strict matches, an adversarial
 * title-only near-match, a later published vote, and a hearing that is itself a
 * matter's most recent appearance). Writes each rendered document under
 * site/.phc04-capture-tmp/ so tools/capture_phc04_legislative_consequence.py can serve
 * it locally (real /brand.css, /civic-documents.css, /report_issue.mjs) and run axe-core
 * against it. Prints the case manifest (id, path, assertion) as JSON to stdout.
 *
 *   node tools/capture_phc04_legislative_consequence.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { renderMeetingDocument } from "../site/meeting_document.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "site/.phc04-capture-tmp");

const goldFixtures = JSON.parse(
  readFileSync(path.join(ROOT, "test/fixtures/consequence_projection/gold_fixtures.v0.json"), "utf8"),
);
const goldCase = (id) => goldFixtures.cases.find((c) => c.id === id).record;

function fullCouncilRecord(overrides = {}) {
  const record = structuredClone(goldCase("full-council-hearing-land-use-matched-join"));
  record.agency = "City Council";
  return { ...record, ...overrides };
}

function present(matters) {
  return {
    snapshot_state: "present",
    join: { matched: true, method: "exact_date_body_tokens" },
    matters,
  };
}

// Matter 78605 (LU 0056-2026) has two observed appearances in
// site/data/legislative_matter_lookup.json: a 2026-04-22 hearing that laid it
// over, then a 2026-05-19 hearing that recorded a roll-call vote approving it.
function matter78605Record(requestId, { outcome, eventName, eventDate }) {
  return {
    source_system: "city_record",
    meeting_id: `meeting:city_record:${requestId}`,
    request_id: requestId,
    event_date: `${eventDate}T11:00:00-04:00`,
    decides: "Zoning, 147-14 Northern Boulevard Rezoning, Queens (C 220415 ZMQ).",
    council_hearing_kind: "land_use",
    meeting_outcome: {
      request_id: requestId,
      snapshot_state: "present",
      event: { event_id: "any", name: eventName, date: eventDate, url: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=any", documents: [] },
      matters: [{
        matter_id: "78605",
        matter_file: "LU 0056-2026",
        matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=78605",
        title: "Zoning, 147-14 Northern Boulevard Rezoning, Queens (C 220415 ZMQ).",
        outcome,
      }],
      join: { matched: true, method: "exact_date_body_tokens" },
    },
  };
}

const CASES = [
  {
    id: "single_exact_match_process_and_testimony",
    assertion:
      "A1/A4/A5/G1: a single exact matter join renders a consequence block above the existing " +
      "continuation, naming the committee's own recorded process position and where testimony is " +
      "officially recorded, with public testimony and committee questioning described as separate " +
      "activities.",
    record: fullCouncilRecord({
      meeting_id: "meeting:city_record:phc04-cap-single",
      request_id: "phc04-cap-single",
    }),
  },
  {
    id: "several_strict_matches_no_blended_consequence",
    assertion:
      "A2/G2: a request with several strict matches shows no blended consequence block at all — " +
      "the existing continuation still requires the reader to select a matter.",
    record: {
      source_system: "city_record",
      meeting_id: "meeting:city_record:phc04-cap-multiple",
      request_id: "phc04-cap-multiple",
      event_date: "2026-07-21T11:00:00-04:00",
      meeting_outcome: present([
        { matter_id: "79301", matter_file: "LU 0201-2026", title: "Rezoning A", outcome: "Laid Over by Subcommittee" },
        { matter_id: "79302", matter_file: "LU 0202-2026", title: "Rezoning B", outcome: "Laid Over by Subcommittee" },
      ]),
    },
  },
  {
    id: "adversarial_title_only_near_match_mints_nothing",
    assertion:
      "A3/G3: a title-only, non-strict relation renders no consequence block and leaks no matter " +
      "detail, covered as the adversarial near-match case.",
    record: {
      source_system: "city_record",
      meeting_id: "meeting:city_record:phc04-cap-titleonly",
      request_id: "phc04-cap-titleonly",
      event_date: "2026-07-21T11:00:00-04:00",
      meeting_outcome: {
        snapshot_state: "present",
        join: { matched: true, method: "title_similarity" },
        matters: [{ matter_id: "99999", title: "Same words as the hearing", outcome: "Approved by Subcommittee" }],
      },
    },
  },
  {
    id: "later_published_vote_is_next_official_event",
    assertion:
      "A6: a matter whose lookup history carries a later vote surfaces that vote as the next " +
      "official event, never as any individual comment's effect.",
    record: matter78605Record("20260408025", {
      outcome: "Laid Over by Subcommittee",
      eventName: "Subcommittee on Zoning and Franchises",
      eventDate: "2026-04-22",
    }),
  },
  {
    id: "hearing_is_matters_own_latest_appearance_honest_unknown",
    assertion:
      "A6/negative rule: a hearing that is itself a matter's most recent observed appearance — " +
      "even though its own recorded action was a vote — states honestly that no amendment or vote " +
      "has followed yet, rather than mistaking its own action for a future event.",
    record: matter78605Record("20260428021", {
      outcome: "Approved by Subcommittee",
      eventName: "Subcommittee on Zoning and Franchises",
      eventDate: "2026-05-19",
    }),
  },
];

mkdirSync(OUT_DIR, { recursive: true });
const manifestCases = CASES.map(({ id, assertion, record }) => {
  const html = renderMeetingDocument(record);
  const file = path.join(OUT_DIR, `${id}.html`);
  writeFileSync(file, html, "utf8");
  return { id, assertion, path: `/.phc04-capture-tmp/${id}.html`, meeting_id: record.meeting_id };
});

process.stdout.write(JSON.stringify(manifestCases, null, 2));
