import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  projectNoticeObjectTarget,
} from "../site/notice_object_links.mjs";
import {
  meetingCanonicalHref,
  normalizeCityRecordMeeting,
  normalizeCommunityBoardMeeting,
} from "../site/meeting_object_contract.mjs";
import { materializeMeetingSearchDocument } from "../site/meeting_search_producer.mjs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import { projectMandateSearchDocuments } from "../site/universal_search_mandate_producer.mjs";
import { projectAgencySearchDocument } from "../site/agency_search_producer.mjs";
import { verifyQuote } from "../tools/law_mandates/quote_verify.mjs";
import { publicSearchResult } from "../worker/src/search.mjs";

const GOLD = JSON.parse(readFileSync(
  new URL("./fixtures/universal_search_object_gold.json", import.meta.url),
  "utf8",
));

const COVERAGE_STATES = new Set([
  "matched",
  "empty",
  "partial",
  "not_indexed",
  "provider_unavailable",
]);
const SUBSTANTIVE_TYPES = new Set([
  "procurement",
  "meeting",
  "mandate",
  "rulemaking",
  "land_use_project",
  "person",
  "agency",
  "vendor",
]);

function goldCase(id) {
  const row = GOLD.cases.find((candidate) => candidate.id === id);
  assert.ok(row, `missing gold case: ${id}`);
  return row;
}

function searchableText(row, attachments = []) {
  return [
    row.title,
    row.short_title,
    row.description,
    row.additional_description_1,
    ...attachments,
  ].filter(Boolean).join(" ").toLocaleLowerCase("en-US");
}

function matchesQuery(row, query, attachments = []) {
  return searchableText(row, attachments).includes(query.toLocaleLowerCase("en-US"));
}

function assertGoldContract(actual, expected) {
  assert.equal(actual.object_type, expected.object_type, "object type");
  assert.equal(actual.domain, expected.domain, "product domain");
  assert.equal(actual.canonical_href, expected.canonical_href, "canonical route");
  assert.deepEqual(actual.source_observation_refs, expected.source_observation_refs, "source provenance");
  assert.equal(actual.coverage_state, expected.coverage_state, "coverage state");
}

function expectedFromProjection(row, projection) {
  return {
    object_type: projection.target.kind,
    domain: row.expected.domain,
    canonical_href: projection.target.href,
    source_observation_refs: row.expected.source_observation_refs,
    coverage_state: row.expected.coverage_state,
  };
}

function lawDerivedMandate(row) {
  const quote = verifyQuote(row.verbatim_quote, row.law_text);
  const quoteVerified = row.quote_verified === true && quote.verified;
  const projection = projectMandateSearchDocuments({
    schema: "cityscroll.agency_obligations.v1",
    method: "enacted_law_mandate_extract_v1",
    certification_basis: "auto_certified_quote_verify_v1",
    source_receipt: {
      extraction: "independent_enacted_law_backfill",
      law_count: 1,
      mandate_count: 1,
    },
    by_agency: {
      fixture: {
        obligations: [{
          ...row,
          obligation_id: row.mandate_id,
          source: {
            matter_id: row.matter_id,
            legistar_url: row.source_href,
            citation: row.citation,
          },
          certification: {
            status: quoteVerified ? "auto_certified" : "auto_candidate",
            basis: "auto_certified_quote_verify_v1",
            quote_verified: quoteVerified,
          },
        }],
      },
    },
  });
  return projection.documents[0] || null;
}

test("gold fixture separates retrieval quality from civic-object correctness", () => {
  assert.equal(GOLD.schema, "cityscroll.universal_search_object_gold.v1");
  assert.deepEqual(GOLD.quality_report.retrieval.dimensions, ["recall", "ranking"]);
  assert.deepEqual(GOLD.quality_report.object_contract.dimensions, [
    "type",
    "domain",
    "route",
    "coverage",
    "dedup",
  ]);
  assert.deepEqual(
    GOLD.quality_report.retrieval.dimensions.filter((dimension) => (
      GOLD.quality_report.object_contract.dimensions.includes(dimension)
    )),
    [],
  );
});

for (const row of GOLD.cases) {
  test(`gold object contract: ${row.id}`, () => {
    const { expected } = row;
    assert.ok(expected.object_ref, "canonical identity");
    assert.ok(expected.object_type, "object type");
    assert.ok(Object.hasOwn(expected, "domain"), "product domain projection");
    assert.match(expected.canonical_href, /^\/(?:agencies\/|browse\/|contracts\/|mandates\/|meetings\/|notices\/)/);
    assert.ok(expected.source_observation_refs.length > 0, "source provenance");
    assert.ok(COVERAGE_STATES.has(expected.coverage_state), "registered coverage state");
    if (SUBSTANTIVE_TYPES.has(expected.object_type)) {
      assert.doesNotMatch(expected.canonical_href, /^\/notices\//);
    }
    if (expected.outcome === "evidence_only") {
      assert.equal(SUBSTANTIVE_TYPES.has(expected.object_type), false);
      assert.equal(expected.domain, null);
    }
  });
}

test("mosquito notice is a procurement object on the canonical Contracts route", () => {
  const row = goldCase("mosquito-procurement");
  const projection = projectNoticeObjectTarget(row.source_observation);
  assert.equal(projection.state, "matched");
  assertGoldContract(expectedFromProjection(row, projection), row.expected);
  assert.equal(projection.target.id, "81626S0021001");
  assert.notEqual(projection.target.kind, "mandate");
  assert.notEqual(row.expected.domain, "mandates");
  assert.equal(lawDerivedMandate(row.source_observation), null);
  assert.notEqual(projection.target.href, projection.evidence.href);
});

test("unknown publisher observations fail closed without a substantive lane", () => {
  const row = goldCase("unknown-observation");
  assert.ok(["evidence_only", "unclassified"].includes(row.expected.outcome)
    || ["evidence_only", "unclassified"].includes(row.expected.object_type));
  assert.equal(SUBSTANTIVE_TYPES.has(row.expected.object_type), false);
  assert.equal(row.expected.domain, null);

  const current = publicSearchResult(row.source_observation);
  assertGoldContract(current, row.expected);
  assert.equal(current.outcome, "evidence_only");
  assert.equal(current.classification.method, "fail_closed");
  assert.equal(current.domain, null);
});

test("City Record rules originate in the bounded rule projection", () => {
  const row = goldCase("city-record-rule");
  const current = publicSearchResult(row.source_observation);
  assertGoldContract(current, row.expected);
  assert.equal(current.outcome, "indexed");
  assert.equal(current.classification.method, "canonical_rule_projection");
  assert.equal(current.process_role, "public_process");
  assert.match(current.classification.basis, /rules_domain_observations/);
  assert.deepEqual(current.provenance.evidence_hrefs, ["/notices/20260728026"]);
});

test("mandates originate in quote-verified law; notices remain separate evidence", () => {
  const row = goldCase("law-derived-mandate");
  const document = lawDerivedMandate(row.source_observation);
  assert.ok(document);
  assert.equal(document.object_type, row.expected.object_type);
  assert.equal(document.domain, row.expected.domain);
  assert.equal(document.canonical_href, row.expected.canonical_href);
  assert.deepEqual(document.source_observation_refs, ["law:66056"]);
  assert.deepEqual(document.provenance.notice_evidence_refs, ["notice:20210820102"]);
  assert.notDeepEqual(document.provenance.notice_evidence_refs, document.source_observation_refs);

  assert.equal(lawDerivedMandate({ ...row.source_observation, quote_verified: false }), null);
  assert.equal(lawDerivedMandate({
    ...row.source_observation,
    verbatim_quote: "The department may consider renegotiation.",
  }), null);
  assert.equal(lawDerivedMandate({ ...row.source_observation, matter_id: null }), null);
});

test("source-qualified meetings retain provenance and their own canonical routes", () => {
  const cases = [
    ["city-record-meeting", normalizeCityRecordMeeting],
    ["community-board-meeting", normalizeCommunityBoardMeeting],
  ];
  for (const [id, normalize] of cases) {
    const row = goldCase(id);
    const meeting = normalize(row.source_observation);
    assert.equal(meeting.object_type, row.expected.object_type, id);
    assert.equal(meeting.meeting_id, row.expected.object_ref, id);
    assert.equal(meetingCanonicalHref(meeting), row.expected.canonical_href, id);
    assert.match(meeting.meeting_id, /^meeting:[^:]+:.+$/, id);
    assert.ok(meeting.source_keys.length > 0, id);
    assert.ok(meeting.publisher_identifier, id);
    assert.notEqual(row.expected.canonical_href, `/notices/${meeting.publisher_identifier}`, id);

    const document = materializeMeetingSearchDocument(meeting);
    assertGoldContract(document, row.expected);
    assert.equal(document.object_ref, meeting.meeting_id, id);
    assert.deepEqual(document.provenance.source_keys, meeting.source_keys, id);
  }
});

test("meeting dedup uses exact canonical identity, never title and date", () => {
  const city = goldCase("city-record-meeting").source_observation;
  const board = goldCase("community-board-meeting").source_observation;
  const readModel = buildSharedMeetingReadModel({
    cityRecordRows: [city, { ...city }],
    communityBoardIndex: {
      schema: "fixture",
      generated_at: "2026-08-14T12:00:00Z",
      rows: [board, { ...board }],
    },
    generatedAt: "2026-08-14T12:00:00Z",
    now: "2026-08-14T12:00:00Z",
  });
  assert.deepEqual(readModel.rows.map((row) => row.meeting_id).sort(), [
    "meeting:city_record:20260814001",
    "meeting:community_board:event-abc-123",
  ]);
  assert.equal(new Set(readModel.rows.map((row) => `${row.title}|${row.event_date}`)).size, 1);
});

test("agency gold case uses the canonical agency read-model projection", () => {
  const row = goldCase("parks-agency");
  const result = projectAgencySearchDocument(
    row.source_observation.agency_id,
    row.source_observation,
    {
      lookup: {
        schema: "cityscroll.agency_constellation.v1",
        method: "agency_constellation_v1",
        er_match_basis: "agency_canonical_v1",
        generated_at: "2026-08-15T12:00:00Z",
        aliases: {},
        provenance: { intelligence_generated_at: "2026-08-15T10:00:00Z" },
      },
    },
  );
  assert.equal(result.outcome, "indexed");
  assertGoldContract({ ...result.document, coverage_state: "matched" }, row.expected);
  assert.equal(result.document.classification.method, "canonical_agency_read_model");
  assert.equal(result.document.provenance.producer, "agency_search_document.v1");
});

for (const coverage of GOLD.coverage) {
  test(`coverage is explicit: ${coverage.producer} is ${coverage.state}`, () => {
    assert.ok(COVERAGE_STATES.has(coverage.state));
    assert.ok(coverage.domain);
    assert.ok(coverage.reason);
    assert.notEqual(coverage.reason, "No matches");
  });
}

test("attachment text may add recall but cannot change type, domain, route, coverage, or identity", () => {
  const row = goldCase("attachment-enrichment");
  const query = GOLD.quality_report.retrieval.attachment_query;
  const baselineProjection = projectNoticeObjectTarget(row.source_observation);
  const enrichedProjection = projectNoticeObjectTarget({
    ...row.source_observation,
    attachments: [{ text: row.attachment_text }],
  });

  assert.equal(matchesQuery(row.source_observation, query), false);
  assert.equal(matchesQuery(row.source_observation, query, [row.attachment_text]), true);
  assert.deepEqual(GOLD.quality_report.retrieval.baseline_ordered_object_refs, []);
  assert.deepEqual(GOLD.quality_report.retrieval.enriched_ordered_object_refs, [row.expected.object_ref]);
  assert.deepEqual(enrichedProjection.target, baselineProjection.target);
  assertGoldContract(expectedFromProjection(row, enrichedProjection), row.expected);
});

test("canonical adapter resolves semantic type before search presentation", () => {
  const row = goldCase("mosquito-procurement");
  const current = publicSearchResult(row.source_observation);
  assertGoldContract(current, row.expected);
  assert.equal(current.outcome, "indexed");
  assert.equal(current.classification.method, "canonical_procurement_projection");
  assert.deepEqual(current.provenance.evidence_hrefs, ["/notices/20260710020"]);
  assert.notEqual(current.canonical_href, current.provenance.evidence_hrefs[0]);
});

for (const id of ["mosquito-procurement", "unknown-observation"]) {
  test(`canonical SearchDocument adapter: ${id}`, () => {
    const row = goldCase(id);
    assertGoldContract(publicSearchResult(row.source_observation), row.expected);
  });
}
