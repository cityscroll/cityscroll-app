import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  USEFULNESS_THRESHOLD,
  extractExplicitOutcome,
  joinNonCouncilOutcomes,
  materializeOutcomeLookup,
  measureJoinBridge,
  parseSourceIndex,
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

test("detector fixture exercises accepted and precision-rejected pairs", () => {
  const measured = measureJoinBridge(fixture.notices, fixture.documents);
  assert.equal(USEFULNESS_THRESHOLD, 0.3);
  assert.equal(measured.total, 10);
  assert.equal(measured.joined, 4);
  assert.equal(measured.rate, 0.4);
  assert.equal(measured.false_positive_review.reviewed_pairs, 7);
  assert.equal(measured.false_positive_review.accepted, 4);
  assert.equal(measured.false_positive_review.rejected, 3);
  assert.deepEqual(measured.sample_by_borough, {
    Bronx: 2,
    Brooklyn: 2,
    Manhattan: 2,
    Queens: 2,
    "Staten Island": 2,
  });

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

test("strict bridge requires exact body/date and conservative matter tokens", () => {
  const joined = joinNonCouncilOutcomes(fixture.notices, fixture.documents);
  assert.equal(joined.length, 4);
  assert.ok(joined.every((row) => row.join.method === "exact_body_date_matter_tokens"));
  assert.ok(joined.every((row) => row.provenance.page_url && row.provenance.document_url));
  assert.ok(joined.every((row) => row.outcome?.explicit === true));

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
    generatedAt: "2026-08-04T12:00:00.000Z",
  });
  assert.equal(payload.schema, "cityscroll.non_council_outcome_lookup.v1");
  assert.equal(payload.coverage.scope, "fixed_sample_not_citywide");
  assert.equal(payload.coverage.notices_seen, 10);
  assert.equal(payload.coverage.notices_matched, 4);
  assert.equal(Object.keys(payload.notices).length, 4);
  assert.equal(payload.notices["sample-si-topic-miss"], undefined);
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
  assert.match(runnerSource, /IngestLock/);
  assert.match(runnerSource, /check_headroom/);
  assert.match(runnerSource, /non_council_outcome_sources/);
  assert.match(runnerSource, /non_council_outcome_documents/);
  assert.match(runnerSource, /non_council_outcome_matches/);
});
