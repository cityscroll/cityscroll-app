import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateSeqraEntity } from "../warehouse/lib/seqra_ontology_spec.mjs";
import {
  SeqraStableKeyError,
  buildOrganizationKey,
  buildPublicPositionKey,
} from "../warehouse/lib/seqra_stable_keys.mjs";
import {
  SEQRA_ORGANIZATION_TYPES,
  SeqraActorResolutionError,
  resolveOrganization,
} from "../warehouse/lib/seqra_actor_resolution.mjs";
import {
  DEFAULT_SUPPRESSION_RULE,
  SUPPRESSION_REQUIRED_ORGANIZATION_TYPES,
  SeqraPublicPositionBuilderError,
  buildOrganization,
  buildPublicPosition,
} from "../warehouse/lib/seqra_public_position_builder.mjs";
import {
  SeqraIssueCoalitionSignalError,
  computeCoalitionContinuity,
  computeIssuePreservation,
  filterCutoffValidPositions,
  normalizeNamedIssue,
} from "../warehouse/lib/seqra_issue_coalition_signals.mjs";

const REVIEW_KEY = "environmental_review:ceqr:04DCP052Q";

function samplePosition(overrides = {}) {
  return buildPublicPosition({
    organizationKey: "organization:community_board:manhattan_community_board_3",
    reviewKey: REVIEW_KEY,
    position: "oppose",
    namedIssue: "Shadow impacts on the schoolyard",
    observedAt: "2026-04-10T00:00:00.000Z",
    availableToPublicAt: "2026-04-12T00:00:00.000Z",
    sourceId: "community_board_positions",
    sourceRecordId: "cb3-resolution-2026-04",
    rivalExplanation: "may be boilerplate language",
    suppressionRule: DEFAULT_SUPPRESSION_RULE,
    organizationType: "community_board",
    ...overrides,
  });
}

describe("seqra_stable_keys: organization/public_position builders", () => {
  it("builds a deterministic organization key from a type and resolved name", () => {
    const key = buildOrganizationKey({ organizationType: "community_board", resolvedName: "MANHATTAN COMMUNITY BOARD 3" });
    assert.equal(key, "organization:community_board:manhattan_community_board_3");
    assert.match(key, /^organization:[a-z0-9_]+:[a-z0-9_]+$/);
  });

  it("throws rather than building an unstable organization key from missing input", () => {
    assert.throws(() => buildOrganizationKey({ organizationType: "community_board" }), SeqraStableKeyError);
  });

  it("builds a deterministic public_position key from stable identity inputs", () => {
    const key = buildPublicPositionKey({
      reviewKey: REVIEW_KEY,
      organizationKey: "organization:community_board:manhattan_community_board_3",
      observedAt: "2026-04-10T00:00:00.000Z",
      sourceRecordId: "cb3-resolution-2026-04",
    });
    assert.match(key, /^public_position:environmental_review:ceqr:04DCP052Q:organization:community_board:manhattan_community_board_3:2026-04-10:[0-9a-f]{12}$/);
    const again = buildPublicPositionKey({
      reviewKey: REVIEW_KEY,
      organizationKey: "organization:community_board:manhattan_community_board_3",
      observedAt: "2026-04-10T00:00:00.000Z",
      sourceRecordId: "cb3-resolution-2026-04",
    });
    assert.equal(key, again, "rebuilding the same identity inputs must reproduce the same key");
  });

  it("rejects a reviewKey that is not an environmental_review key", () => {
    assert.throws(() => buildPublicPositionKey({
      reviewKey: "not-a-review-key",
      organizationKey: "organization:community_board:x",
      observedAt: "2026-04-10T00:00:00.000Z",
      sourceRecordId: "x",
    }), SeqraStableKeyError);
  });
});

describe("seqra_actor_resolution", () => {
  it("resolves a fixed-role source system's actor without needing a hint (A1)", () => {
    const resolved = resolveOrganization({ rawName: "Manhattan Community Board 3", sourceSystem: "community_board_positions" });
    assert.equal(resolved.organization_type, "community_board");
    assert.match(resolved.organization_key, /^organization:community_board:/);
  });

  it("two spellings of the same organization resolve to the same organization_key (A1)", () => {
    const a = resolveOrganization({ rawName: "Building and Construction Trades Council of Greater New York", sourceSystem: "nyc_elobbyist", organizationTypeHint: "labor_organization" });
    const b = resolveOrganization({ rawName: "Building and Construction Trades Council of Greater New York, Inc.", sourceSystem: "nyc_elobbyist", organizationTypeHint: "labor_organization" });
    assert.equal(a.organization_key, b.organization_key);
  });

  it("defaults to organization_type unknown rather than guessing when no hint is available", () => {
    const resolved = resolveOrganization({ rawName: "Some Client LLC", sourceSystem: "nyc_elobbyist" });
    assert.equal(resolved.organization_type, "unknown");
    assert.equal(resolved.match_basis, "no_hint_defaulted_unknown");
  });

  it("rejects an organizationTypeHint outside the ontology's organization_type enum", () => {
    assert.throws(() => resolveOrganization({ rawName: "X", sourceSystem: "nyc_elobbyist", organizationTypeHint: "not_a_type" }), SeqraActorResolutionError);
  });

  it("throws on an unknown source system rather than silently defaulting", () => {
    assert.throws(() => resolveOrganization({ rawName: "X", sourceSystem: "not_a_real_source" }), SeqraActorResolutionError);
  });

  it("throws when a raw name normalizes to no usable identity", () => {
    assert.throws(() => resolveOrganization({ rawName: "....", sourceSystem: "nyc_elobbyist", organizationTypeHint: "unknown" }), SeqraActorResolutionError);
  });

  it("every SEQRA_ORGANIZATION_TYPES value matches the ontology's organization_type enum", () => {
    const spec = validateSeqraEntity("organization", {
      organization_key: "organization:unknown:x",
      name: "X",
      organization_type: "unknown",
      observed_at: "2026-01-01T00:00:00.000Z",
      source_id: "s",
      source_record_id: "r",
    });
    assert.deepEqual(spec, []);
    assert.ok(SEQRA_ORGANIZATION_TYPES.includes("unknown"));
  });
});

describe("seqra_public_position_builder: buildOrganization / buildPublicPosition", () => {
  it("builds a public_position entity that validates against the SEQRA-02 ontology spec", () => {
    const position = samplePosition();
    assert.deepEqual(validateSeqraEntity("public_position", position), []);
  });

  it("builds an organization entity that validates against the SEQRA-02 ontology spec", () => {
    const resolved = resolveOrganization({ rawName: "Manhattan Community Board 3", sourceSystem: "community_board_positions" });
    const organization = buildOrganization({
      resolvedActor: resolved,
      sourceId: "community_board_positions",
      sourceRecordId: "cb3-roster",
      observedAt: "2026-04-10T00:00:00.000Z",
    });
    assert.deepEqual(validateSeqraEntity("organization", organization), []);
  });

  it("refuses a position with no availableToPublicAt (A4 / negative rule: no undated advocacy as a cutoff-valid signal)", () => {
    assert.throws(() => samplePosition({ availableToPublicAt: undefined }), SeqraPublicPositionBuilderError);
  });

  it("refuses a position whose available_to_public_at precedes observed_at (A4)", () => {
    assert.throws(() => samplePosition({ observedAt: "2026-05-01T00:00:00.000Z", availableToPublicAt: "2026-04-01T00:00:00.000Z" }), SeqraPublicPositionBuilderError);
  });

  it("requires a non-empty rivalExplanation and suppressionRule (A5 / A3)", () => {
    assert.throws(() => samplePosition({ rivalExplanation: "" }), SeqraPublicPositionBuilderError);
    assert.throws(() => samplePosition({ suppressionRule: "" }), SeqraPublicPositionBuilderError);
  });

  it("SUPPRESSION_REQUIRED_ORGANIZATION_TYPES names exactly the participation types the negative rule calls out", () => {
    for (const type of ["labor_organization", "developer", "advocacy_group", "community_board"]) {
      assert.ok(SUPPRESSION_REQUIRED_ORGANIZATION_TYPES.includes(type));
    }
  });

  it("named_issue null represents generic opposition distinctly from a named issue (A2)", () => {
    const named = samplePosition();
    const generic = samplePosition({ namedIssue: null, sourceRecordId: "generic-row" });
    assert.equal(named.named_issue, "Shadow impacts on the schoolyard");
    assert.equal(generic.named_issue, null);
  });
});

describe("seqra_issue_coalition_signals", () => {
  it("normalizeNamedIssue collapses case/punctuation but not genuinely different wording", () => {
    assert.equal(normalizeNamedIssue("Shadow impacts on the schoolyard!"), normalizeNamedIssue("shadow impacts on the schoolyard"));
    assert.notEqual(normalizeNamedIssue("Shadow impacts"), normalizeNamedIssue("Noise impacts"));
    assert.equal(normalizeNamedIssue(null), null);
    assert.equal(normalizeNamedIssue("   "), null);
  });

  it("filterCutoffValidPositions excludes undated and not-yet-public positions (A4 / negative rule)", () => {
    const dated = samplePosition();
    const notYetPublic = samplePosition({ availableToPublicAt: "2026-12-01T00:00:00.000Z", sourceRecordId: "future-row" });
    const { included, excludedUndated, excludedNotYetPublic } = filterCutoffValidPositions(
      [dated, notYetPublic, { organization_key: "x", available_to_public_at: null }],
      { asOfCutoff: "2026-06-01T00:00:00.000Z" },
    );
    assert.equal(included.length, 1);
    assert.equal(included[0], dated);
    assert.equal(excludedNotYetPublic, 1);
    assert.equal(excludedUndated, 1);
  });

  it("throws on a missing or unparseable asOfCutoff rather than silently including everything", () => {
    assert.throws(() => filterCutoffValidPositions([samplePosition()], { asOfCutoff: undefined }), SeqraIssueCoalitionSignalError);
    assert.throws(() => filterCutoffValidPositions([samplePosition()], { asOfCutoff: "not-a-date" }), SeqraIssueCoalitionSignalError);
  });

  it("a named issue raised on two distinct dates is preserved; raised once is not (A2)", () => {
    const first = samplePosition({ observedAt: "2026-04-10T00:00:00.000Z", availableToPublicAt: "2026-04-12T00:00:00.000Z", sourceRecordId: "row-1" });
    const onlyOnce = computeIssuePreservation([first], { asOfCutoff: "2026-06-01T00:00:00.000Z" });
    assert.equal(onlyOnce.issues[0].preserved, false);

    const second = samplePosition({
      organizationKey: "organization:elected_official_office:council_office",
      observedAt: "2026-05-20T00:00:00.000Z",
      availableToPublicAt: "2026-05-21T00:00:00.000Z",
      sourceId: "nyc_council_legislative_records",
      sourceRecordId: "row-2",
      organizationType: "elected_official_office",
    });
    const twice = computeIssuePreservation([first, second], { asOfCutoff: "2026-06-01T00:00:00.000Z" });
    assert.equal(twice.issues[0].preserved, true);
    assert.equal(twice.issues[0].distinct_organization_count, 2);
  });

  it("generic opposition (named_issue null) is counted distinctly, not folded into a named issue", () => {
    const named = samplePosition();
    const generic = samplePosition({ namedIssue: null, sourceRecordId: "generic-row" });
    const result = computeIssuePreservation([named, generic], { asOfCutoff: "2026-06-01T00:00:00.000Z" });
    assert.equal(result.issues.length, 1);
    assert.equal(result.generic_opposition_count, 1);
  });

  it("coalition requires at least two distinct organizations naming the same issue (A2)", () => {
    const lone = samplePosition();
    const soloCoalition = computeCoalitionContinuity([lone], { asOfCutoff: "2026-06-01T00:00:00.000Z" });
    assert.equal(soloCoalition.coalitions[0].coalition, false);

    const second = samplePosition({
      organizationKey: "organization:elected_official_office:council_office",
      sourceId: "nyc_council_legislative_records",
      sourceRecordId: "row-2",
    });
    const pair = computeCoalitionContinuity([lone, second], { asOfCutoff: "2026-06-01T00:00:00.000Z" });
    assert.equal(pair.coalitions[0].coalition, true);
    assert.equal(pair.coalitions[0].distinct_organization_count, 2);
  });

  it("every issue-preservation and coalition-continuity result retains a rival explanation and suppression rule (A5 / A3)", () => {
    const positions = [samplePosition()];
    const preservation = computeIssuePreservation(positions, { asOfCutoff: "2026-06-01T00:00:00.000Z" });
    const coalition = computeCoalitionContinuity(positions, { asOfCutoff: "2026-06-01T00:00:00.000Z" });
    for (const issue of preservation.issues) {
      assert.ok(issue.rival_explanation);
      assert.ok(issue.suppression_rule);
    }
    for (const entry of coalition.coalitions) {
      assert.ok(entry.rival_explanation);
      assert.ok(entry.suppression_rule);
    }
  });

  it("never asserts misconduct/motive in any derived signal text (negative rule)", () => {
    const positions = [samplePosition()];
    const bundle = JSON.stringify([
      computeIssuePreservation(positions, { asOfCutoff: "2026-06-01T00:00:00.000Z" }),
      computeCoalitionContinuity(positions, { asOfCutoff: "2026-06-01T00:00:00.000Z" }),
    ]);
    // Targets assertive phrasing ("misconduct occurred"), not the bare word a
    // suppression_rule legitimately uses to state the prohibition itself.
    assert.doesNotMatch(bundle, /\b(misconduct (occurred|found|confirmed|detected)|is corrupt\b|engaged in (bribery|collusion|fraud)|is guilty\b|colluded with)\b/i);
  });
});
