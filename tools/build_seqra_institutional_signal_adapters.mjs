#!/usr/bin/env node
/**
 * SEQRA-07: build/check the public-position and institutional-signal
 * receipt this card's `verify` field names (`npm run warehouse:seqra:ingest`,
 * chained after SEQRA-03's own structured-adapter gate in package.json).
 *
 * Like every SEQRA warehouse builder, default mode rebuilds this receipt
 * purely from committed fixtures under
 * warehouse/fixtures/seqra-institutional-signals/ -- no network access, so
 * two consecutive runs (and `--check` against a committed copy) are
 * byte-identical. The two SODA-backed sources (nyc_elobbyist,
 * nyc_city_record_notices) reuse the SEQRA-03 structured-adapter engine
 * (warehouse/lib/seqra_structured_adapter.mjs) directly. The four sources
 * with no documented bulk API for a SEQRA/CEQR-scoped query
 * (nyc_council_legislative_records, community_board_positions,
 * agency_position_records, nys_coelig_lobbying) get a bounded discovery-probe
 * receipt instead of a row-count receipt, per the commission's negative rule
 * against treating a public website as a stable API.
 *
 * A real live capture for a new named vintage would call the same
 * warehouse/lib/seqra_structured_adapter.mjs primitives against `fetch()`;
 * that capture is a deliberate operator action, not part of this gate (see
 * tools/build_seqra_structured_adapters.mjs's own docstring for the same
 * convention).
 *
 * The second half of this gate exercises the actor-resolution and
 * public-position mechanism this card actually delivers (A1-A5): a small,
 * clearly-labeled synthetic set of positions grounded in real raw actor
 * strings drawn from the committed fixtures above, run through
 * warehouse/lib/seqra_actor_resolution.mjs,
 * warehouse/lib/seqra_public_position_builder.mjs, and
 * warehouse/lib/seqra_issue_coalition_signals.mjs. This mirrors
 * warehouse/lib/seqra_ontology_spec.mjs's own documented convention: the
 * fixtures that exercise entity specs are synthetic identity/shape examples,
 * not claims about a real review.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SeqraSchemaDriftError,
  assertNoSchemaDrift,
  buildFetchReceipt,
  contentHashOf,
  stableJson,
} from "../warehouse/lib/seqra_structured_adapter.mjs";
import {
  SEQRA_INSTITUTIONAL_SIGNAL_SOURCE_IDS,
  getInstitutionalSignalSource,
} from "../warehouse/lib/seqra_institutional_signal_sources.mjs";
import { resolveOrganization, SeqraActorResolutionError } from "../warehouse/lib/seqra_actor_resolution.mjs";
import {
  DEFAULT_SUPPRESSION_RULE,
  SUPPRESSION_REQUIRED_ORGANIZATION_TYPES,
  buildOrganization,
  buildPublicPosition,
  SeqraPublicPositionBuilderError,
} from "../warehouse/lib/seqra_public_position_builder.mjs";
import {
  computeCoalitionContinuity,
  computeIssuePreservation,
} from "../warehouse/lib/seqra_issue_coalition_signals.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_ROOT = path.join(ROOT, "warehouse/fixtures/seqra-institutional-signals");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/seqra_institutional_signal_adapters_latest.json");
const VINTAGE = "2026-09-04-sample";
const RESIDENT_INGESTION_NOTE =
  "Research raw retention only in this card; resident-facing ingestion is not wired and stays disabled until a later owner decision.";

// Forbidden ASSERTIONS the negative rule exists to keep out of any built
// receipt: lobbying, union, developer, or community participation must never
// be characterized as misconduct or motive. This matches
// tools/audit-salience-methodology.mjs's convention -- it targets assertive
// phrasing ("misconduct occurred", "is corrupt"), not the bare words a
// suppression_rule field legitimately uses to state the prohibition itself
// (e.g. "must never be read as misconduct").
const FORBIDDEN_MISCONDUCT_ASSERTIONS = new RegExp(
  "\\b(misconduct (occurred|found|confirmed|detected)|is corrupt\\b|was corrupt\\b|" +
  "engaged in (bribery|collusion|fraud)|is guilty\\b|are guilty\\b|acted illicitly|" +
  "committed (fraud|bribery)|colluded with)\\b",
  "i",
);

function fetchIdFor(sourceId, vintage, slug) {
  return `seqra07-fetch-${sourceId}-${vintage}-${slug}`;
}
function fixtureVintageDir(sourceId, vintage) {
  return path.join(FIXTURES_ROOT, sourceId, vintage);
}
function readJson(absPath) {
  return JSON.parse(readFileSync(absPath, "utf8"));
}
function loadRawText(sourceId, vintage, slug, extension = "json") {
  return readFileSync(path.join(fixtureVintageDir(sourceId, vintage), "raw", `${slug}.${extension}`), "utf8");
}

function fetchReceiptFromFixture({ sourceId, vintage, entry, rawText, rowOrDocumentCount, paginationComplete }) {
  const contentHash = contentHashOf(rawText);
  const byteCount = Buffer.byteLength(rawText, "utf8");
  return buildFetchReceipt({
    fetchId: fetchIdFor(sourceId, vintage, entry.raw_slug),
    sourceId,
    requestedAt: entry.requested_at,
    requestUrlOrQuery: entry.request_url_or_query,
    httpStatus: entry.http_status,
    retrievedAt: entry.retrieved_at,
    sourceVintage: vintage,
    contentType: entry.content_type,
    byteCount,
    contentHash,
    rawObjectPath: path.posix.join(
      "warehouse/fixtures/seqra-institutional-signals", sourceId, vintage, "raw",
      `${entry.raw_slug}.${entry.raw_extension || "json"}`,
    ),
    rowOrDocumentCount,
    paginationComplete,
    warnings: [],
  });
}

/** SODA sources (nyc_elobbyist, nyc_city_record_notices): identical mechanism to SEQRA-03's structured adapters. */
function buildSodaSourceReceipt(sourceId, { columnsOverride = null } = {}) {
  const source = getInstitutionalSignalSource(sourceId);
  const observation = readJson(path.join(fixtureVintageDir(sourceId, VINTAGE), "observation.json"));

  const metaText = loadRawText(sourceId, VINTAGE, "dataset_metadata");
  const columns = columnsOverride ?? JSON.parse(metaText).columns.map((c) => c.fieldName);
  assertNoSchemaDrift({ sourceId, requiredFields: source.required_fields, observedFields: columns });

  const pagesText = observation.page_fetches.map((entry) => loadRawText(sourceId, VINTAGE, entry.raw_slug));
  const pagesRows = pagesText.map((text) => JSON.parse(text));
  const rowCount = pagesRows.reduce((sum, rows) => sum + rows.length, 0);
  const paginationComplete = pagesRows[pagesRows.length - 1].length < observation.page_size;

  const fetches = [
    fetchReceiptFromFixture({
      sourceId, vintage: VINTAGE, entry: observation.dataset_metadata_fetch, rawText: metaText,
      rowOrDocumentCount: 1, paginationComplete: true,
    }),
    ...observation.page_fetches.map((entry, i) => fetchReceiptFromFixture({
      sourceId, vintage: VINTAGE, entry, rawText: pagesText[i], rowOrDocumentCount: pagesRows[i].length, paginationComplete,
    })),
  ];

  return {
    schema: "cityscroll.seqra_adapter_vintage_receipt.v1",
    source_id: sourceId,
    source_name: source.source_name,
    kind: source.kind,
    dataset_id: source.dataset_id,
    vintage: VINTAGE,
    captured_at: observation.page_fetches[0].retrieved_at,
    sample_scope: Boolean(observation.sample_scope),
    sample_scope_note: observation.sample_scope_note ?? null,
    schema_check: { required_fields: source.required_fields, observed_fields: [...columns].sort(), drift: false },
    row_count: rowCount,
    pagination_complete: paginationComplete,
    fetches,
    resident_ingestion: { committed: false, note: RESIDENT_INGESTION_NOTE },
  };
}

/** The four bounded discovery-probe sources: reachability + structural markers, never a row count. */
function buildDiscoveryProbeReceipt(sourceId) {
  const source = getInstitutionalSignalSource(sourceId);
  const observation = readJson(path.join(fixtureVintageDir(sourceId, VINTAGE), "observation.json"));
  const entry = observation.probe_fetch;
  const rawText = loadRawText(sourceId, VINTAGE, entry.raw_slug, entry.raw_extension || "html");

  const requiredMarkers = source.required_markers ?? [];
  const markersFound = requiredMarkers.filter((marker) => rawText.includes(marker));
  const markersMissing = requiredMarkers.filter((marker) => !rawText.includes(marker));

  return {
    schema: "cityscroll.seqra_institutional_signal_discovery_receipt.v1",
    source_id: sourceId,
    source_name: source.source_name,
    kind: source.kind,
    base_url: source.base_url,
    vintage: VINTAGE,
    captured_at: entry.retrieved_at,
    sample_scope: Boolean(observation.sample_scope),
    sample_scope_note: observation.sample_scope_note ?? null,
    discovery: {
      http_status: entry.http_status,
      markers_required: requiredMarkers,
      markers_found: markersFound,
      markers_missing: markersMissing,
      not_a_stable_api: true,
      note: source.note,
    },
    row_count: 0,
    pagination_complete: false,
    fetches: [
      fetchReceiptFromFixture({
        sourceId, vintage: VINTAGE, entry, rawText, rowOrDocumentCount: 0, paginationComplete: false,
      }),
    ],
    resident_ingestion: { committed: false, note: RESIDENT_INGESTION_NOTE },
  };
}

function buildSourceReceipt(sourceId) {
  return getInstitutionalSignalSource(sourceId).kind === "soda"
    ? buildSodaSourceReceipt(sourceId)
    : buildDiscoveryProbeReceipt(sourceId);
}

// ---------------------------------------------------------------------------
// Actor resolution + public-position + issue-preservation/coalition-continuity
// mechanism exercise. Grounded in real raw actor strings captured in the
// fixtures above; review association, dates, and positions are a small,
// clearly-labeled synthetic identity/shape example (same convention as
// warehouse/lib/seqra_ontology_spec.mjs's own fixtures), not a claim about a
// real environmental review.
// ---------------------------------------------------------------------------

// A real client_name row from the committed nyc_elobbyist fixture (see
// warehouse/fixtures/seqra-institutional-signals/nyc_elobbyist/2026-09-04-sample/raw/page-0000.json).
const REAL_ELOBBYIST_CLIENT_NAME = "Building and Construction Trades Council of Greater New York";
// A real agency_name row from the committed nyc_city_record_notices fixture.
const REAL_CITY_RECORD_AGENCY_NAME = "BOARD OF ELECTION POLL WORKERS";

// A real, already-registered CEQR number from warehouse/fixtures/seqra-adapters/
// ceqr_projects (SEQRA-03) -- reusing an existing identity rather than
// inventing a fake review key.
const DEMO_REVIEW_KEY = "environmental_review:ceqr:04DCP052Q";
const DEMO_NAMED_ISSUE_RAW = "Shadow impacts on the P.S. 123 schoolyard";
// Three cutoffs used to demonstrate cutoff validity (A4): EARLY sits after
// only the April community-board position is public; MID sits after the May
// council-office reaffirmation is public but before the July follow-up;
// LATE sits after every demo position is public.
const EARLY_CUTOFF = "2026-05-01T00:00:00.000Z";
const MID_CUTOFF = "2026-06-01T00:00:00.000Z";
const LATE_CUTOFF = "2026-08-01T00:00:00.000Z";

function demoActor(rawName, sourceSystem, organizationTypeHint = null) {
  return resolveOrganization({ rawName, sourceSystem, organizationTypeHint });
}

function buildDemoPositions() {
  // Two organizations, resolved from two different source systems, both
  // naming the *same* normalized issue on two different dates -- this is
  // the shape a real named/preserved coalition takes (A2).
  const communityBoard = demoActor("Manhattan Community Board 3", "community_board_positions");
  const councilOffice = demoActor("Council Member Christopher Marte's Office", "nyc_council_legislative_records");
  // The real eLobbyist client, resolved with an explicit, source-independent
  // hint rather than guessed from the name -- and required by the builder to
  // carry a suppression rule (A3).
  const laborClient = demoActor(REAL_ELOBBYIST_CLIENT_NAME, "nyc_elobbyist", "labor_organization");
  // A generic-opposition actor: takes a position, but names no specific issue.
  const cityRecordAgency = demoActor(REAL_CITY_RECORD_AGENCY_NAME, "nyc_city_record_notices", "government_agency");

  const positions = [
    buildPublicPosition({
      organizationKey: communityBoard.organization_key,
      organizationType: communityBoard.organization_type,
      reviewKey: DEMO_REVIEW_KEY,
      position: "oppose",
      namedIssue: DEMO_NAMED_ISSUE_RAW,
      observedAt: "2026-04-10T00:00:00.000Z",
      availableToPublicAt: "2026-04-12T00:00:00.000Z",
      sourceId: "community_board_positions",
      sourceRecordId: "cb3-resolution-2026-04",
      evidence: "Community Board 3 full-board resolution, April 2026 meeting minutes.",
      confidence: 0.9,
      rivalExplanation:
        "A single board's resolution language may echo standard boilerplate schoolyard-shadow language used across many unrelated reviews rather than reflecting this review's site-specific conditions.",
      suppressionRule: DEFAULT_SUPPRESSION_RULE,
    }),
    buildPublicPosition({
      organizationKey: councilOffice.organization_key,
      organizationType: councilOffice.organization_type,
      reviewKey: DEMO_REVIEW_KEY,
      position: "conditional",
      namedIssue: DEMO_NAMED_ISSUE_RAW,
      observedAt: "2026-05-20T00:00:00.000Z",
      availableToPublicAt: "2026-05-21T00:00:00.000Z",
      sourceId: "nyc_council_legislative_records",
      sourceRecordId: "council-testimony-2026-05-20",
      evidence: "Council district office public hearing testimony, May 2026.",
      confidence: 0.7,
      rivalExplanation:
        "A district office restating a constituent-raised concern is dated process evidence of what was raised, not evidence the office independently verified or endorsed the underlying technical claim.",
      suppressionRule: DEFAULT_SUPPRESSION_RULE,
    }),
    buildPublicPosition({
      organizationKey: laborClient.organization_key,
      organizationType: laborClient.organization_type,
      reviewKey: DEMO_REVIEW_KEY,
      position: "no_position_recorded",
      namedIssue: null,
      observedAt: "2026-03-01T00:00:00.000Z",
      availableToPublicAt: "2026-05-01T00:00:00.000Z",
      sourceId: "nyc_elobbyist",
      sourceRecordId: "elobbyist-fmf3-knd8-demo-row",
      evidence: "NYC eLobbyist filing recording dated lobbying activity; no support/oppose stance is stated in the filing.",
      confidence: 0.5,
      rivalExplanation:
        "Registered lobbying activity on a related legislative matter does not establish that this organization took any position on this specific environmental review.",
      suppressionRule: DEFAULT_SUPPRESSION_RULE,
    }),
    buildPublicPosition({
      organizationKey: cityRecordAgency.organization_key,
      organizationType: cityRecordAgency.organization_type,
      reviewKey: DEMO_REVIEW_KEY,
      position: "oppose",
      namedIssue: null, // generic opposition: no specific issue named (A2 contrast case)
      observedAt: "2026-04-15T00:00:00.000Z",
      availableToPublicAt: "2026-04-16T00:00:00.000Z",
      sourceId: "nyc_city_record_notices",
      sourceRecordId: "cityrecord-demo-row",
      evidence: "City Record notice recording a comment opposing the action without naming a specific technical issue.",
      confidence: 0.4,
      rivalExplanation: "Recorded opposition with no named issue may reflect an incomplete transcription of a more specific comment rather than genuinely undifferentiated opposition.",
      suppressionRule: DEFAULT_SUPPRESSION_RULE,
    }),
    // Deliberately excluded from any as-of-DEMO_CUTOFF signal: available to
    // the public only after the cutoff (A4 / negative rule).
    buildPublicPosition({
      organizationKey: communityBoard.organization_key,
      organizationType: communityBoard.organization_type,
      reviewKey: DEMO_REVIEW_KEY,
      position: "oppose",
      namedIssue: DEMO_NAMED_ISSUE_RAW,
      observedAt: "2026-07-01T00:00:00.000Z",
      availableToPublicAt: "2026-07-03T00:00:00.000Z",
      sourceId: "community_board_positions",
      sourceRecordId: "cb3-followup-2026-07",
      evidence: "Community Board 3 follow-up resolution, July 2026 meeting minutes.",
      confidence: 0.9,
      rivalExplanation: "A follow-up resolution restating an earlier concern may reflect routine procedural re-adoption rather than a new, independent reaffirmation.",
      suppressionRule: DEFAULT_SUPPRESSION_RULE,
    }),
  ];

  const organizations = [communityBoard, councilOffice, laborClient, cityRecordAgency].map((actor, i) =>
    buildOrganization({
      resolvedActor: actor,
      sourceId: positions[i].source_id,
      sourceRecordId: positions[i].source_record_id,
      observedAt: positions[i].observed_at,
    }));

  return { positions, organizations };
}

// ---------------------------------------------------------------------------
// Gate checks
// ---------------------------------------------------------------------------
const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, result: "pass" });
  } catch (error) {
    checks.push({ name, result: "fail", message: error.message });
  }
}
function assertTrue(value, message) {
  if (!value) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let sourceReceipts = {};
await check("every registered SEQRA-07 source builds a receipt from its committed fixture", () => {
  for (const sourceId of SEQRA_INSTITUTIONAL_SIGNAL_SOURCE_IDS) sourceReceipts[sourceId] = buildSourceReceipt(sourceId);
  assertEqual(Object.keys(sourceReceipts).length, 6, "institutional-signal source count");
});

await check("re-running a named vintage produces an identical content hash for every source", () => {
  for (const sourceId of SEQRA_INSTITUTIONAL_SIGNAL_SOURCE_IDS) {
    const first = stableJson(buildSourceReceipt(sourceId));
    const second = stableJson(buildSourceReceipt(sourceId));
    assertEqual(first, second, `${sourceId}: rebuilding the same vintage twice`);
  }
});

await check("a missing required SODA field fails the adapter visibly instead of silently parsing", () => {
  let threw = false;
  try {
    buildSodaSourceReceipt("nyc_elobbyist", { columnsOverride: ["client_id", "report_year"] });
  } catch (error) {
    threw = error instanceof SeqraSchemaDriftError;
    assertTrue(threw, `expected SeqraSchemaDriftError, got ${error}`);
  }
  assertTrue(threw, "dropping a required column must throw, not silently build a receipt");
});

await check("every discovery-probe source records not_a_stable_api and never asserts a row count", () => {
  for (const sourceId of SEQRA_INSTITUTIONAL_SIGNAL_SOURCE_IDS) {
    const receipt = sourceReceipts[sourceId];
    if (receipt.kind !== "bounded_discovery_probe") continue;
    assertEqual(receipt.discovery.not_a_stable_api, true, `${sourceId}: not_a_stable_api`);
    assertEqual(receipt.row_count, 0, `${sourceId}: row_count must stay 0 for a discovery probe`);
    assertEqual(receipt.pagination_complete, false, `${sourceId}: pagination_complete`);
  }
});

let demo = null;
await check("actor resolution attributes every demo position to a resolved organization with a source record (A1)", () => {
  demo = buildDemoPositions();
  assertEqual(demo.positions.length, 5, "demo position count");
  for (const position of demo.positions) {
    assertTrue(position.organization_key.startsWith("organization:"), "organization_key shape");
    assertTrue(typeof position.source_id === "string" && position.source_id.length > 0, "source_id present");
    assertTrue(typeof position.source_record_id === "string" && position.source_record_id.length > 0, "source_record_id present");
  }
  const distinctOrganizations = new Set(demo.positions.map((p) => p.organization_key));
  assertEqual(distinctOrganizations.size, 4, "four distinct resolved actors across four source systems");
});

await check("the same raw actor name resolves to the same organization_key across repeated resolution (A1)", () => {
  const first = resolveOrganization({ rawName: REAL_ELOBBYIST_CLIENT_NAME, sourceSystem: "nyc_elobbyist", organizationTypeHint: "labor_organization" });
  const second = resolveOrganization({ rawName: REAL_ELOBBYIST_CLIENT_NAME, sourceSystem: "nyc_elobbyist", organizationTypeHint: "labor_organization" });
  assertEqual(first.organization_key, second.organization_key, "repeated resolution of the same raw name");
});

await check("resolving an actor with no usable identity throws rather than minting an unstable key", () => {
  let threw = false;
  try {
    resolveOrganization({ rawName: "....", sourceSystem: "nyc_elobbyist", organizationTypeHint: "unknown" });
  } catch (error) {
    threw = error instanceof SeqraActorResolutionError;
  }
  assertTrue(threw, "a junk actor name must throw, not silently resolve");
});

await check("before a second organization's position is public, the issue is named but not yet a coalition or preserved (A2 baseline)", () => {
  const preservation = computeIssuePreservation(demo.positions, { asOfCutoff: EARLY_CUTOFF });
  const coalition = computeCoalitionContinuity(demo.positions, { asOfCutoff: EARLY_CUTOFF });

  assertEqual(preservation.issues.length, 1, "exactly one named issue as of the early cutoff");
  assertTrue(preservation.generic_opposition_count >= 1, "at least one generic-opposition position recorded distinctly");
  assertEqual(preservation.issues[0].preserved, false, "one organization's single mention is not yet preservation");
  assertEqual(preservation.issues[0].distinct_organization_count, 1, "only the community board's position is public this early");
  assertEqual(coalition.coalitions[0].coalition, false, "one organization alone is not yet a coalition");
});

await check("named-issue evidence becomes a measurable coalition once a second organization's position is public (A2)", () => {
  const preservation = computeIssuePreservation(demo.positions, { asOfCutoff: MID_CUTOFF });
  const coalition = computeCoalitionContinuity(demo.positions, { asOfCutoff: MID_CUTOFF });

  assertEqual(preservation.issues[0].preserved, true, "a second organization naming the same issue on a later date preserves it");
  assertEqual(preservation.issues[0].distinct_organization_count, 2, "two distinct organizations named the same issue");
  assertEqual(coalition.coalitions[0].coalition, true, "two distinct organizations forms a coalition");
});

await check("a later cutoff never surfaces a reaffirmation before it was itself public (A4: no position enters a cutoff before it was public)", () => {
  const mid = computeIssuePreservation(demo.positions, { asOfCutoff: MID_CUTOFF });
  const late = computeIssuePreservation(demo.positions, { asOfCutoff: LATE_CUTOFF });
  assertEqual(mid.issues[0].distinct_observation_date_count, 2, "the July follow-up is excluded before its own public availability");
  assertEqual(late.issues[0].distinct_observation_date_count, 3, "the July follow-up counts once its own public availability has passed");
});

await check("a position missing available_to_public_at is refused at construction, never accepted as cutoff-valid (A4 / negative rule)", () => {
  let threw = false;
  try {
    buildPublicPosition({
      organizationKey: "organization:advocacy_group:demo",
      reviewKey: DEMO_REVIEW_KEY,
      position: "oppose",
      namedIssue: null,
      observedAt: "2026-05-01T00:00:00.000Z",
      availableToPublicAt: undefined,
      sourceId: "nyc_city_record_notices",
      sourceRecordId: "undated-demo-row",
      rivalExplanation: "n/a",
      suppressionRule: DEFAULT_SUPPRESSION_RULE,
    });
  } catch (error) {
    threw = error instanceof SeqraPublicPositionBuilderError;
  }
  assertTrue(threw, "an undated position must be refused, not treated as a cutoff-valid signal");
});

await check("a position cannot be public before it was observed (A4)", () => {
  let threw = false;
  try {
    buildPublicPosition({
      organizationKey: "organization:advocacy_group:demo",
      reviewKey: DEMO_REVIEW_KEY,
      position: "oppose",
      namedIssue: null,
      observedAt: "2026-05-10T00:00:00.000Z",
      availableToPublicAt: "2026-05-01T00:00:00.000Z",
      sourceId: "nyc_city_record_notices",
      sourceRecordId: "impossible-order-demo-row",
      rivalExplanation: "n/a",
      suppressionRule: DEFAULT_SUPPRESSION_RULE,
    });
  } catch (error) {
    threw = error instanceof SeqraPublicPositionBuilderError;
  }
  assertTrue(threw, "available_to_public_at before observed_at must be refused");
});

await check("every position from a suppression-required organization type carries a non-empty suppression rule (A3)", () => {
  for (const position of demo.positions) {
    const organization = demo.organizations.find((o) => o.organization_key === position.organization_key);
    if (!organization || !SUPPRESSION_REQUIRED_ORGANIZATION_TYPES.includes(organization.organization_type)) continue;
    assertTrue(typeof position.suppression_rule === "string" && position.suppression_rule.trim().length > 0,
      `${position.position_key}: suppression_rule required for organization_type ${organization.organization_type}`);
  }
});

await check("no built receipt, position, or derived signal asserts misconduct/motive (A3 / negative rule)", () => {
  const bundle = stableJson({ sourceReceipts, positions: demo.positions, organizations: demo.organizations });
  assertTrue(!FORBIDDEN_MISCONDUCT_ASSERTIONS.test(bundle), "a misconduct/motive assertion must never appear");
});

await check("every derived issue-preservation and coalition-continuity signal retains a rival explanation (A5)", () => {
  const preservation = computeIssuePreservation(demo.positions, { asOfCutoff: LATE_CUTOFF });
  const coalition = computeCoalitionContinuity(demo.positions, { asOfCutoff: LATE_CUTOFF });
  for (const issue of preservation.issues) {
    assertTrue(typeof issue.rival_explanation === "string" && issue.rival_explanation.length > 0, "issue rival_explanation");
    assertTrue(typeof issue.suppression_rule === "string" && issue.suppression_rule.length > 0, "issue suppression_rule");
  }
  for (const entry of coalition.coalitions) {
    assertTrue(typeof entry.rival_explanation === "string" && entry.rival_explanation.length > 0, "coalition rival_explanation");
    assertTrue(typeof entry.suppression_rule === "string" && entry.suppression_rule.length > 0, "coalition suppression_rule");
  }
});

await check("resident ingestion remains disabled and every source receipt records it as not committed", () => {
  for (const [sourceId, receipt] of Object.entries(sourceReceipts)) {
    assertEqual(receipt.resident_ingestion.committed, false, `${sourceId}: resident_ingestion.committed`);
  }
});

await check("the existing SEQRA ontology unit tests for organization/public_position stay green", () => {
  execFileSync(process.execPath, ["--test", "test/seqra_public_position.test.mjs"], { cwd: ROOT, stdio: "pipe" });
});

const failed = checks.filter((c) => c.result === "fail");
const gateResult = failed.length === 0 ? "pass" : "fail";

const demoForReceipt = demo ?? { positions: [], organizations: [] };
const receipt = {
  schema: "cityscroll.seqra_institutional_signal_adapters_receipt.v1",
  source_count: SEQRA_INSTITUTIONAL_SIGNAL_SOURCE_IDS.length,
  sources: sourceReceipts,
  demo_positions: demoForReceipt.positions,
  demo_organizations: demoForReceipt.organizations,
  demo_issue_preservation: demo ? computeIssuePreservation(demo.positions, { asOfCutoff: LATE_CUTOFF }) : null,
  demo_coalition_continuity: demo ? computeCoalitionContinuity(demo.positions, { asOfCutoff: LATE_CUTOFF }) : null,
  checks,
  gate: { result: gateResult, failed_check_count: failed.length, resident_ingestion_committed: false },
};

const next = stableJson(receipt);
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== "--check") throw new Error("Usage: node tools/build_seqra_institutional_signal_adapters.mjs [--check]");
}

if (args.has("--check")) {
  let current = null;
  try {
    current = readFileSync(RECEIPT, "utf8");
  } catch {
    current = null;
  }
  if (current !== next) {
    console.error(next);
    throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run: node tools/build_seqra_institutional_signal_adapters.mjs`);
  }
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
}

if (gateResult !== "pass") {
  console.error(next);
  throw new Error(`SEQRA-07 institutional-signal-adapters gate failed: ${failed.map((c) => `${c.name}: ${c.message}`).join(" | ")}`);
}
console.log(`SEQRA institutional-signal-adapters gate OK (${checks.length} checks, ${SEQRA_INSTITUTIONAL_SIGNAL_SOURCE_IDS.length} sources)`);
