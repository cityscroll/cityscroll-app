#!/usr/bin/env node
/**
 * PHC-02 evidence helper: render the meeting detail page (site/meeting_document.mjs's
 * renderMeetingDocument()) for five synthetic City Record records, one per state named
 * in the card (sourced purpose/authority, an unsourced descriptive meeting, listen-only
 * vs. testimony participation, and a held meeting with no published outcome). Writes each
 * rendered document under site/.phc02-capture-tmp/ so tools/capture_phc02_purpose_and_authority.py
 * can serve it locally (real /brand.css, /civic-documents.css, /report_issue.mjs) and run
 * axe-core against it. Prints the case manifest (id, path, assertion) as JSON to stdout.
 *
 *   node tools/capture_phc02_purpose_and_authority.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { renderMeetingDocument } from "../site/meeting_document.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "site/.phc02-capture-tmp");

const goldFixtures = JSON.parse(
  readFileSync(path.join(ROOT, "test/fixtures/consequence_projection/gold_fixtures.v0.json"), "utf8"),
);
const goldCase = (id) => goldFixtures.cases.find((c) => c.id === id).record;

function fullCouncilRecord(overrides = {}) {
  const record = structuredClone(goldCase("full-council-hearing-land-use-matched-join"));
  record.agency = "City Council";
  return { ...record, ...overrides };
}

const CASES = [
  {
    id: "sourced_purpose_and_authority",
    assertion:
      "A1/A2/G1: a sourced pending question, plain-language body role, record destination, " +
      "and the nearest exact next official action render in one consequence block, before the " +
      "participation controls.",
    record: fullCouncilRecord({
      meeting_id: "meeting:city_record:phc02-cap-sourced",
      request_id: "phc02-cap-sourced",
      participation: { links: [{ url: "https://zoomgov.com/j/phc02cap1", label: "Join online" }] },
    }),
  },
  {
    id: "unsourced_purpose_descriptive_meeting",
    assertion:
      "A3/G2: a City Record \"Public Hearings and Meetings\" row this repository cannot classify " +
      "into a specific proceeding family renders no consequence block at all — never a pending " +
      "question paraphrased from its own title.",
    record: {
      source_system: "city_record",
      meeting_id: "meeting:city_record:phc02-cap-unsourced",
      request_id: "phc02-cap-unsourced",
      title: "Notice of Public Hearing and Meeting",
      section_name: "Public Hearings and Meetings",
      source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/phc02-cap-unsourced",
    },
  },
  {
    id: "listen_only_no_testimony_invite",
    assertion:
      "A4/G3: a hearing with a published venue address (rendered as informational location " +
      "text, per the existing Where section) and no testimony or comment channel renders its " +
      "sourced purpose/authority but no participation-actions list and never invites testimony.",
    record: fullCouncilRecord({
      meeting_id: "meeting:city_record:phc02-cap-listen",
      request_id: "phc02-cap-listen",
      venue: { address: "250 Broadway, New York, NY" },
    }),
  },
  {
    id: "testimony_signup_state",
    assertion:
      "A5: the same sourced hearing shape with a published testimony-signup URL renders " +
      "\"Register to testify\" — a different, evidence-backed participation state on the same " +
      "underlying agenda, contrasted with the listen-only case.",
    record: fullCouncilRecord({
      meeting_id: "meeting:city_record:phc02-cap-testify",
      request_id: "phc02-cap-testify",
      additional_description_1: "Register to testify at https://testimony.example.test/phc02-cap-signup",
    }),
  },
  {
    id: "held_without_outcome_honest_unknown_next_step",
    assertion:
      "A6/negative rule: a hearing whose notice states it was held, with no published outcome, " +
      "keeps its sourced purpose/authority but states the next official step honestly as not yet " +
      "published — never inferring an outcome from the event having been held.",
    record: fullCouncilRecord({
      meeting_id: "meeting:city_record:phc02-cap-held",
      request_id: "phc02-cap-held",
      meeting_outcome: undefined,
      additional_description_1: "This hearing was held on the scheduled date.",
    }),
  },
];

mkdirSync(OUT_DIR, { recursive: true });
const manifestCases = CASES.map(({ id, assertion, record }) => {
  const html = renderMeetingDocument(record);
  const file = path.join(OUT_DIR, `${id}.html`);
  writeFileSync(file, html, "utf8");
  return { id, assertion, path: `/.phc02-capture-tmp/${id}.html`, meeting_id: record.meeting_id };
});

process.stdout.write(JSON.stringify(manifestCases, null, 2));
