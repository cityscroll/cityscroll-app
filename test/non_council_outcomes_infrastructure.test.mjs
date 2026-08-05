import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  JOIN_METHOD,
  PRECISION_PROMOTION_BAR,
  USEFULNESS_THRESHOLD,
  buildPrecisionReviewReceipt,
  extractExplicitOutcome,
  joinBridgePromotionDecision,
  joinNonCouncilOutcomes,
  materializeOutcomeLookup,
  matterTokenMatch,
  measureJoinBridge,
  parseSourceIndex,
  publisherMatterTokens,
  reviewJoinCandidates,
} from "../warehouse/lib/non_council_outcomes.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("../warehouse/fixtures/non_council_outcomes.json", import.meta.url),
  "utf8",
));
const registry = JSON.parse(readFileSync(
  new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url),
  "utf8",
));
const receipt = JSON.parse(readFileSync(
  new URL(
    "../site/data/non_council_outcome_sources/verification_receipts/non_council_minutes_votes_2026-08-04.json",
    import.meta.url,
  ),
  "utf8",
));
const lookup = JSON.parse(readFileSync(
  new URL("../site/data/non_council_outcome_lookup.json", import.meta.url),
  "utf8",
));
const collectorSource = readFileSync(
  new URL("../warehouse/scripts/non_council_outcomes.mjs", import.meta.url),
  "utf8",
);
const runnerSource = readFileSync(
  new URL("../warehouse/scripts/non_council_outcomes_run.py", import.meta.url),
  "utf8",
);

test("registry inventories all 59 boards and five borough presidents without citywide claims", () => {
  assert.equal(registry.schema, "cityscroll.non_council_outcome_source_registry.v1");
  assert.equal(registry.sources.length, 64);
  assert.equal(registry.coverage.community_boards.inventoried, 59);
  assert.equal(registry.coverage.borough_presidents.inventoried, 5);
  assert.equal(registry.coverage.presentation_scope, "board_level");

  const boards = registry.sources.filter((row) => row.body_type === "community_board");
  const presidents = registry.sources.filter((row) => row.body_type === "borough_president");
  assert.equal(boards.length, 59);
  assert.equal(presidents.length, 5);
  assert.deepEqual(
    Object.fromEntries(
      ["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"].map((borough) => [
        borough,
        boards.filter((row) => row.borough === borough).length,
      ]),
    ),
    { Bronx: 12, Brooklyn: 18, Manhattan: 12, Queens: 14, "Staten Island": 3 },
  );

  for (const source of registry.sources) {
    assert.match(source.body_id, /^(bronx|brooklyn|manhattan|queens|staten-island)-(cb-\d{2}|bp)$/);
    assert.match(source.homepage_url, /^https:\/\//);
    assert.ok(["html", "html_pdf", "html_docx", "unknown"].includes(source.format));
    assert.ok(["monthly", "irregular", "unknown"].includes(source.update_cadence));
    assert.ok(Object.hasOwn(source, "archive_depth"));
    assert.ok(["yes", "sometimes", "no", "unknown"].includes(source.full_board_votes));
    assert.ok(["collect", "inventory_only"].includes(source.status));
  }
});

test("publisher matter keys accept ULURP identifiers only", () => {
  assert.deepEqual(publisherMatterTokens(["260190ZSX", "ATLANTIC-REZONING", "HILLSIDE-AVE"]), ["260190ZSX"]);
  assert.deepEqual(publisherMatterTokens(["C240001ZMM"]), ["C240001ZMM"]);
  assert.deepEqual(publisherMatterTokens(["W42ST-PLAN", "HYLAN-REZONING"]), []);
  assert.equal(matterTokenMatch(["260190ZSX"], "260190ZSX. Motion approved 21-0-0.").matched, true);
  assert.equal(matterTokenMatch(["ATLANTIC-REZONING"], "ATLANTIC-REZONING. Motion adopted 31-2-1.").matched, false);
  assert.equal(
    matterTokenMatch(["260115ZMK"], "Different application N250099ZRK. Motion approved 22-4-0.").matched,
    false,
  );
});

test("repaired join accepts only publisher-ULURP body/date matches", () => {
  const measured = measureJoinBridge(fixture.notices, fixture.documents);
  assert.equal(USEFULNESS_THRESHOLD, 0.3);
  assert.equal(PRECISION_PROMOTION_BAR, 1);
  assert.equal(measured.total, 10);
  // Prior 4/7 accepted slug tokens; repair keeps only ULURP publisher ids → 2 joins.
  assert.equal(measured.joined, 2);
  assert.equal(measured.rate, 0.2);
  assert.equal(measured.above_threshold, false);
  assert.equal(measured.false_positive_review.reviewed_pairs, 7);
  assert.equal(measured.false_positive_review.accepted, 2);
  assert.equal(measured.false_positive_review.rejected, 5);
  assert.equal(measured.false_positive_review.precision, 1);
  assert.equal(measured.false_positive_review.clears_precision_bar, true);
  assert.ok(measured.false_positive_review.rejection_reasons.publisher_matter_token_absent >= 1);
  assert.ok(measured.false_positive_review.rejection_reasons.matter_token_mismatch >= 1);
  assert.ok(measured.false_positive_review.rejection_reasons.date_mismatch >= 1);
  assert.deepEqual(measured.sample_by_borough, {
    Bronx: 2,
    Brooklyn: 2,
    Manhattan: 2,
    Queens: 2,
    "Staten Island": 2,
  });
});

test("reviewed sample labels each body-matched candidate and gates promotion at 100% precision", () => {
  const review = reviewJoinCandidates(fixture.notices, fixture.documents);
  assert.equal(review.candidates.length, 7);
  assert.ok(review.candidates.every((row) => row.review_label));
  assert.equal(review.summary.true_positives, 2);
  assert.equal(review.summary.false_positives, 0);
  assert.equal(review.summary.precision, 1);
  assert.equal(review.summary.clears_precision_bar, true);

  const promotion = joinBridgePromotionDecision(measureJoinBridge(fixture.notices, fixture.documents));
  // Precision clears, usefulness does not → outcome edge stays disabled.
  assert.equal(promotion.precision_ok, true);
  assert.equal(promotion.usefulness_ok, false);
  assert.equal(promotion.enabled, false);

  const precisionReceipt = buildPrecisionReviewReceipt({
    notices: fixture.notices,
    documents: fixture.documents,
    observedOn: "2026-08-05",
    joinBridgeEnabled: false,
  });
  assert.equal(precisionReceipt.schema, "cityscroll.non_council_outcomes.precision_review.v1");
  assert.equal(precisionReceipt.authoritative_join_gate.enabled, false);
  assert.equal(precisionReceipt.precision_review.measured_precision, 1);
  assert.equal(precisionReceipt.precision_review.prior_reported_precision, Number((4 / 7).toFixed(4)));
  assert.equal(precisionReceipt.reviewed_candidates.length, 7);
});

test("published real sample kills the below-threshold bridge", () => {
  assert.equal(receipt.usefulness_threshold, 0.3);
  assert.deepEqual(receipt.join_measurement.rates.strict_body_date_matter, {
    joined: 0,
    total: 10,
    rate: 0,
  });
  assert.deepEqual(receipt.join_measurement.sample_by_borough, {
    Bronx: 2,
    Brooklyn: 2,
    Manhattan: 2,
    Queens: 2,
    "Staten Island": 2,
  });
  assert.equal(receipt.join_measurement.cases.length, 10);
  assert.equal(receipt.false_positive_review.reviewed_pairs, 1);
  assert.equal(receipt.false_positive_review.accepted, 0);
  assert.equal(receipt.false_positive_review.rejected, 1);
  assert.match(receipt.verdict, /Below usefulness threshold/i);
  assert.equal(registry.policy.join_bridge_enabled, false);
});

test("strict bridge requires exact body/date and publisher ULURP matter tokens", () => {
  const joined = joinNonCouncilOutcomes(fixture.notices, fixture.documents);
  assert.equal(joined.length, 2);
  assert.ok(joined.every((row) => row.join.method === JOIN_METHOD));
  assert.ok(joined.every((row) => row.provenance.page_url && row.provenance.document_url));
  assert.ok(joined.every((row) => row.outcome?.explicit === true));
  assert.deepEqual(
    joined.map((row) => row.request_id).sort(),
    ["sample-bx-accepted", "sample-mn-accepted"],
  );

  // Slug/name tokens never join even when the document text repeats them.
  const slugOnly = fixture.notices.find((row) => row.request_id === "sample-bk-accepted");
  assert.ok(slugOnly);
  assert.ok(!joined.some((row) => row.request_id === slugOnly.request_id));

  const wrongTopic = fixture.notices.find((row) => row.request_id === "sample-si-topic-miss");
  assert.ok(wrongTopic);
  assert.ok(!joined.some((row) => row.request_id === wrongTopic.request_id));
  const noTokens = { ...fixture.notices[0], request_id: "no-matter", matter_tokens: [] };
  assert.equal(joinNonCouncilOutcomes([noTokens], fixture.documents).length, 0);
});

test("outcomes are extracted only from explicit action and tally language", () => {
  assert.deepEqual(extractExplicitOutcome("Motion approved 34-2-1."), {
    explicit: true,
    action: "approved",
    tally: { yes: 34, no: 2, abstain: 1 },
  });
  assert.deepEqual(extractExplicitOutcome("The board discussed the application."), {
    explicit: false,
    action: null,
    tally: null,
  });
});

test("HTML index parser keeps document provenance and excludes navigation links", () => {
  const documents = parseSourceIndex(
    fixture.source_page.html,
    fixture.source_page.source,
    { observedAt: "2026-08-04T12:00:00.000Z" },
  );
  assert.equal(documents.length, 2);
  assert.ok(documents.every((row) => row.page_url === fixture.source_page.source.source_url));
  assert.ok(documents.every((row) => /^https:\/\//.test(row.document_url)));
  assert.ok(documents.every((row) => row.meeting_date));
  assert.ok(!documents.some((row) => /calendar\.page/.test(row.document_url)));
});

test("payload builder is board-scoped, while the committed killed bridge stays empty", () => {
  const payload = materializeOutcomeLookup(fixture.notices, fixture.documents, {
    generatedAt: "2026-08-05T12:00:00.000Z",
  });
  assert.equal(payload.schema, "cityscroll.non_council_outcome_lookup.v1");
  assert.equal(payload.coverage.scope, "fixed_sample_not_citywide");
  assert.equal(payload.coverage.notices_seen, 10);
  assert.equal(payload.coverage.notices_matched, 2);
  assert.equal(Object.keys(payload.notices).length, 2);
  assert.equal(payload.notices["sample-si-topic-miss"], undefined);
  assert.equal(payload.notices["sample-bk-accepted"], undefined);
  assert.equal(lookup.schema, payload.schema);
  assert.equal(lookup.coverage.scope, "fixed_sample_not_citywide");
  assert.equal(lookup.coverage.notices_seen, 10);
  assert.equal(lookup.coverage.notices_matched, 0);
  assert.equal(lookup.coverage.join_bridge_enabled, false);
  assert.deepEqual(lookup.notices, {});
});

test("collector and warehouse runner enforce polite, checkpointed, bounded collection", () => {
  assert.match(collectorSource, /User-Agent/);
  assert.match(collectorSource, /1200/);
  assert.match(collectorSource, /checkpoint/i);
  assert.match(collectorSource, /HTTP 403/);
  assert.match(collectorSource, /binaries_stored:\s*false/);
  assert.match(collectorSource, /join_bridge_enabled/);
  assert.match(collectorSource, /publisher ULURP|extractUlurpKeys/);
  assert.match(collectorSource, /PRECISION|precision_promotion|precision_review/);
  assert.match(runnerSource, /IngestLock/);
  assert.match(runnerSource, /check_headroom/);
  assert.match(runnerSource, /non_council_outcome_sources/);
  assert.match(runnerSource, /non_council_outcome_documents/);
  assert.match(runnerSource, /non_council_outcome_matches/);
});
