#!/usr/bin/env node
/**
 * Render the matter-continuation specimens exactly as a materialized meeting
 * document carries them, and print them as JSON.
 *
 * The continuation is server-rendered in production, so an evidence capture
 * should read the same markup a reader receives rather than a browser-built
 * approximation. tools/capture_matter_continuation_evidence.py injects each
 * rendered section into test/harness/matter_continuation_harness.html and drives
 * the result in a real engine.
 *
 *   node tools/render_matter_continuation_fixtures.mjs
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { renderCouncilHearingMatterContinuation } from "../site/council_hearing_matter_continuation.mjs";

const snapshot = JSON.parse(readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));

function meeting(requestId, outcome = snapshot.by_notice[requestId]) {
  return {
    source_system: "city_record",
    meeting_id: `meeting:city_record:${requestId}`,
    request_id: requestId,
    event_date: "2026-07-22T11:00:00-04:00",
    meeting_outcome: outcome,
  };
}

/**
 * One specimen per availability state a reader can meet. The first four are
 * retained City Record notices; the last is an exact identity the retained
 * record carries no address for, which the corpus itself does not contain and
 * which is therefore stated as a constructed boundary rather than as an
 * observed one.
 */
export const CONTINUATION_FIXTURES = Object.freeze({
  "published-local-history": { request_id: "20260428021", basis: "retained" },
  "single-exact-official-record": { request_id: "20260707022", basis: "retained" },
  "multiple-exact-matters": { request_id: "20260707021", basis: "retained" },
  "unmatched-notice": { request_id: "20260728026", basis: "retained" },
  "unavailable-destination": {
    request_id: "20260827004",
    basis: "constructed_boundary",
    outcome: {
      snapshot_state: "present",
      join: { matched: true, method: "exact_date_body_tokens" },
      matters: [{
        matter_id: "999999",
        matter_file: "LU 9999-2026",
        title: "Retained identity without a published history or an official address.",
      }],
    },
  },
});

export function renderContinuationFixtures() {
  const rendered = {};
  for (const [name, spec] of Object.entries(CONTINUATION_FIXTURES)) {
    rendered[name] = {
      request_id: spec.request_id,
      basis: spec.basis,
      html: renderCouncilHearingMatterContinuation(meeting(spec.request_id, spec.outcome)),
    };
  }
  return { data_vintage: snapshot.generated_at, fixtures: rendered };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(renderContinuationFixtures(), null, 2)}\n`);
}
