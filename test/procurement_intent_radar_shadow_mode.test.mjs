import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildShadowArtifact,
  checkShadowMode,
  reportMarkdown,
} from "../tools/run_procurement_intent_shadow_mode.mjs";
import {
  SHADOW_MODE_SCHEMA,
  SHADOW_VISIBILITY,
  partitionArrivals,
  runAssertionPhase,
  runResolutionPhase,
  runShadowMode,
  shadowLeakageFindings,
} from "../warehouse/lib/procurement_intent_shadow.mjs";
import { reconcileDerivedArchitectureEvidence } from "../tools/architecture_evidence_shards.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STREAM_PATH = join(ROOT, "test/fixtures/procurement_intent_radar/shadow_arrivals.v0.json");

function readStream() {
  return JSON.parse(readFileSync(STREAM_PATH, "utf8"));
}

function intentFor(artifact, processRef, assertedAt = null) {
  return artifact.intents.find((intent) => intent.process_ref === processRef
    && (!assertedAt || intent.assertion.asserted_at === assertedAt));
}

test("A1: arriving evidence opens internal intents with receipts, provisional identity, and conservative claims", () => {
  const artifact = buildShadowArtifact();
  assert.equal(artifact.schema, SHADOW_MODE_SCHEMA);
  assert.equal(artifact.intents.length, 7);
  for (const intent of artifact.intents) {
    const { source_evidence: evidence, provisional_identity: identity, claims } = intent.assertion;
    assert.ok(evidence.source_record_id, intent.intent_id);
    assert.ok(evidence.source_event_id, intent.intent_id);
    assert.ok(evidence.source_span_text.trim(), intent.intent_id);
    assert.ok(evidence.citations.length >= 1, intent.intent_id);
    assert.ok(evidence.citations.every((citation) => citation.url), intent.intent_id);
    assert.equal(intent.assertion.asserted_at, evidence.citations.length ? intent.assertion.asserted_at : null);
    assert.equal(identity.status, "prospective");
    assert.deepEqual([identity.epin, identity.pin, identity.procurement_id, identity.publisher_identity], [null, null, null, null]);
    assert.deepEqual(identity.realized_by, []);
    assert.ok(identity.subject_ref.startsWith("procurement-intent:"), identity.subject_ref);
    // Occurrence and timing stay separate registers and neither is a public score.
    assert.equal(claims.occurrence.claim, "occurrence");
    assert.equal(claims.timing.claim, "timing");
    for (const claim of [claims.occurrence, claims.timing]) {
      assert.ok(["open", "abstained"].includes(claim.status), claim.status);
      if (claim.status === "abstained") assert.ok(claim.abstention_reason);
      else assert.equal(claim.probability_basis, "uncalibrated_neutral_placeholder");
    }
  }
  const open = artifact.intents.filter((intent) => intent.state === "open");
  assert.equal(open.length, 2);
  assert.ok(open.every((intent) => intent.resolution.accepted_edges.length === 0));
});

test("A2: nothing is published, and no public realized edge is created before authorization", () => {
  const artifact = buildShadowArtifact();
  assert.equal(artifact.visibility, SHADOW_VISIBILITY);
  const boundary = artifact.publication_boundary;
  assert.deepEqual(boundary.public_routes, []);
  assert.equal(boundary.public_search_documents, 0);
  assert.equal(boundary.public_follow_targets, 0);
  assert.equal(boundary.notifications_emitted, 0);
  assert.equal(boundary.resident_facing_claims, 0);
  assert.equal(boundary.public_realized_edges, 0);
  assert.ok(boundary.internal_realized_edges > 0);
  assert.ok(artifact.intents.every((intent) => intent.published_publicly === false));
  assert.ok(artifact.intents.every((intent) => intent.resolution.accepted_edges
    .every((edge) => edge.published_publicly === false)));
  assert.equal(artifact.promotion.product_promotion_allowed, false);
  assert.equal(artifact.promotion.gates.recurrent_arrival_corpus.passed, false);
});

test("A2: no public surface references the shadow runner or its artifact", () => {
  // git grep exits 1 when nothing matches, which is the passing condition here.
  const result = spawnSync("git", [
    "grep", "--cached", "-l",
    "-e", "procurement_intent_shadow",
    "-e", "shadow_mode.v1.json",
    "-e", "shadow_arrivals.v0.json",
    "--", "site", "worker",
  ], { cwd: ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.ok([0, 1].includes(result.status), `git grep failed: ${result.stderr}`);
  assert.deepEqual(result.stdout.split("\n").filter(Boolean), []);
});

test("A2: the assertion-time projection cannot read a later solicitation title, vendor, EPIN, or coverage", () => {
  const stream = readStream();
  const { sourceArrivals, solicitationArrivals } = partitionArrivals(stream);
  const { intents } = runAssertionPhase(sourceArrivals);
  assert.ok(intents.length > 0);
  const serialized = JSON.stringify(intents);
  for (const arrival of solicitationArrivals) {
    for (const field of ["epin", "source_system_id", "title", "citation_url"]) {
      const value = String(arrival.solicitation[field] || "");
      assert.equal(serialized.includes(value), false, `${field} ${value} leaked into the assertion phase`);
    }
  }
  for (const intent of intents) {
    assert.deepEqual(shadowLeakageFindings(intent.assertion, solicitationArrivals), []);
  }
  // The assertion phase is handed the source projection only; a solicitation
  // payload reaching it is a contract violation rather than a silent no-op.
  assert.throws(
    () => runAssertionPhase([{ arrival_id: "arr-x", arrived_at: "2026-01-01", solicitation: { epin: "26026P0031" } }]),
    /must not receive solicitation observations/,
  );
});

test("A2: a deliberate future-feature injection is a hard failure, not a caveat", () => {
  const stream = readStream();
  const solicitation = stream.arrivals.find((row) => row.arrival_kind === "solicitation_observation");
  const injected = {
    ...stream,
    arrivals: stream.arrivals.map((arrival) => (arrival.arrival_id === "arr-2026-0007"
      ? {
        ...arrival,
        source: {
          ...arrival.source,
          epin: solicitation.solicitation.epin,
          vendor_name: "Future Vendor LLC",
          later_title: solicitation.solicitation.title,
          published_at: solicitation.solicitation.published_at,
        },
      }
      : arrival)),
  };
  // Sealing removes the injected hindsight fields, so the run still succeeds
  // and the assertion carries none of them.
  const sealedRun = runShadowMode(injected);
  const serialized = JSON.stringify(sealedRun.intents.map((intent) => intent.assertion));
  assert.equal(serialized.includes(solicitation.solicitation.epin), false);
  assert.equal(serialized.includes("Future Vendor LLC"), false);

  // An injection that survives sealing is refused outright.
  const leaked = {
    source_evidence: { source_span_text: "DYCD will release the COMPASS request for proposals." },
    stated_intent: { object_text: solicitation.solicitation.title },
    provisional_identity: { epin: solicitation.solicitation.epin, pin: null, realized_by: [] },
  };
  const findings = shadowLeakageFindings(leaked, [solicitation]);
  assert.ok(findings.some((finding) => finding.type === "populated_hindsight_field" && finding.field === "epin"));
  assert.ok(findings.some((finding) => finding.type === "future_value_in_assertion" && finding.field === "title"));
});

test("A2: an explicit null publisher identity is an unknown, not leakage", () => {
  const artifact = buildShadowArtifact();
  const stream = readStream();
  const { solicitationArrivals } = partitionArrivals(stream);
  for (const intent of artifact.intents) {
    assert.deepEqual(shadowLeakageFindings(intent.assertion, solicitationArrivals), []);
  }
  assert.equal(artifact.temporal_integrity.leakage_failures.length, 0);
  assert.equal(artifact.temporal_integrity.assertion_phase_saw_solicitations, false);
  assert.equal(artifact.temporal_integrity.assertions_rewritten_after_resolution, 0);
});

test("A3: later solicitations resolve or flag review without rewriting the earlier assertion", () => {
  const artifact = buildShadowArtifact();
  const resolved = intentFor(artifact, "procurement-intent:acs-request-for-proposals-2026");
  assert.equal(resolved.state, "resolved");
  assert.equal(resolved.resolution.prospective_outcome.occurrence, "realized");
  assert.equal(resolved.resolution.prospective_outcome.timing, "hit");
  assert.equal(resolved.resolution.prospective_outcome.lead_days, 175);
  assert.equal(resolved.resolution.accepted_edges.length, 1);
  assert.equal(resolved.resolution.resolved_by_arrival_id, "arr-2026-0011");
  // The resolving observation arrived after the assertion, never before it.
  assert.ok(resolved.resolution.resolution_recorded_at > resolved.assertion.arrived_at);
  assert.equal(resolved.resolution.assertion_rewritten, false);
  assert.equal(resolved.assertion_immutable, true);

  const ambiguous = intentFor(artifact, "procurement-intent:dss-solicitation-2026");
  assert.equal(ambiguous.state, "ambiguous");
  assert.equal(ambiguous.resolution.review_required, true);
  assert.equal(ambiguous.resolution.accepted_edges.length, 0);
  assert.equal(ambiguous.resolution.candidates.length, 1);
  assert.equal(ambiguous.resolution.candidates[0].decision, "review");
});

test("A3: shadow mode declares and needs no CityMeetings runtime dependency", () => {
  const artifact = buildShadowArtifact();
  assert.equal(artifact.protocol.runtime_dependencies.citymeetings_runtime_dependency, false);
  assert.equal(artifact.protocol.runtime_dependencies.network_access, false);
  assert.equal(artifact.protocol.runtime_dependencies.reproducible_from_retained_inputs, true);
  const sources = [
    "warehouse/lib/procurement_intent_shadow.mjs",
    "tools/run_procurement_intent_shadow_mode.mjs",
  ].map((path) => readFileSync(join(ROOT, path), "utf8"));
  for (const source of sources) {
    assert.equal(/\bfetch\s*\(/u.test(source), false);
    assert.equal(/node:https?|undici|axios/u.test(source), false);
  }
});

test("open, unmatched, ambiguous, one-to-many, and superseded states stay distinct", () => {
  const artifact = buildShadowArtifact();
  assert.deepEqual(
    Object.fromEntries(Object.entries(artifact.metrics.intent_states).filter(([key]) => !["value_type", "denominator"].includes(key))),
    { open: 2, resolved: 2, ambiguous: 1, unmatched: 1, superseded: 1 },
  );
  // An open intent has not failed to be realized; it has not been observed yet.
  const unmatched = intentFor(artifact, "procurement-intent:agency-unresolved-solicitation-2026");
  assert.equal(unmatched.state, "unmatched");
  assert.equal(unmatched.resolution.prospective_outcome.occurrence, "not_observed_in_stated_window");
  assert.equal(unmatched.resolution.candidates.length, 0);
  const open = intentFor(artifact, "procurement-intent:dycd-competitive-procurement-2026");
  assert.equal(open.resolution.prospective_outcome.occurrence, "not_observed_yet");
  assert.equal(artifact.metrics.occurrence.not_observed_yet, 3);
  assert.equal(artifact.metrics.occurrence.not_observed_in_stated_window, 1);

  const oneToMany = intentFor(artifact, "procurement-intent:dycd-request-for-proposals-2026");
  assert.equal(oneToMany.resolution.matcher_outcome.cardinality.relation, "one_to_many");
  assert.equal(oneToMany.resolution.accepted_edges.length, 2);
  assert.equal(artifact.metrics.realization_cardinality.one_to_many, 1);
  assert.equal(artifact.metrics.realization_cardinality.one_to_one, 1);
});

test("occurrence and timing are never collapsed into one score", () => {
  const artifact = buildShadowArtifact();
  const late = intentFor(artifact, "procurement-intent:dycd-request-for-proposals-2026");
  // Realized, but outside the window the agency stated.
  assert.equal(late.resolution.prospective_outcome.occurrence, "realized");
  assert.equal(late.resolution.prospective_outcome.timing, "miss");
  assert.equal(artifact.metrics.timing.hit, 1);
  assert.equal(artifact.metrics.timing.miss, 1);
  assert.equal(artifact.metrics.timing.claims_abstained, 1);
  const noWindow = intentFor(artifact, "procurement-intent:dss-solicitation-2026");
  assert.equal(noWindow.assertion.claims.timing.status, "abstained");
  assert.equal(noWindow.assertion.claims.timing.abstention_reason, "no_stated_timing_window_in_source");
  assert.ok(noWindow.assertion.unknowns.includes("timing_prediction_window"));
});

test("supersession keeps the earlier assertion verbatim", () => {
  const artifact = buildShadowArtifact();
  const earlier = intentFor(artifact, "procurement-intent:acs-solicitation-2026", "2026-07-15");
  const later = intentFor(artifact, "procurement-intent:acs-solicitation-2026", "2026-08-12");
  assert.equal(earlier.state, "superseded");
  assert.equal(earlier.supersession.superseded, true);
  assert.equal(earlier.supersession.superseded_by, later.intent_id);
  assert.equal(later.supersession.superseded, false);
  assert.equal(later.supersession.supersedes, earlier.intent_id);
  assert.equal(earlier.assertion.source_evidence.source_span_text,
    "ACS plans to publish a solicitation for supportive housing case aides in the fall.");
  assert.equal(earlier.assertion.stated_intent.expected_window.latest, "2026-11-30");
  assert.equal(later.assertion.stated_intent.expected_window.latest, "2026-12-31");
  assert.equal(artifact.metrics.supersession.superseded_intents, 1);
});

test("stale and duplicate arrivals are recorded, and a replay opens no second intent", () => {
  const artifact = buildShadowArtifact();
  const replay = artifact.arrivals.find((row) => row.arrival_id === "arr-2026-0012");
  assert.equal(replay.disposition, "duplicate_replay");
  assert.equal(replay.first_arrival_id, "arr-2026-0007");
  assert.equal(replay.assertion_rewritten, false);
  assert.equal(replay.freshness.stale_arrival, true);
  assert.equal(replay.freshness.arrival_lag_days, 131);
  assert.equal(artifact.metrics.idempotency.duplicate_replays, 1);
  assert.equal(artifact.metrics.idempotency.assertions_rewritten_by_replay, 0);
  assert.deepEqual(artifact.metrics.freshness.stale_arrival_ids, ["arr-2026-0012", "arr-2026-0015"]);
  assert.equal(artifact.metrics.freshness.maximum_arrival_lag_days, 131);
  const original = artifact.intents.filter((intent) => intent.assertion.arrival_id === "arr-2026-0007");
  assert.equal(original.length, 1);
});

test("missing or insufficient source evidence and extractor abstentions are never dropped", () => {
  const artifact = buildShadowArtifact();
  const missingSpan = artifact.arrivals.find((row) => row.arrival_id === "arr-2026-0004");
  const missingCitation = artifact.arrivals.find((row) => row.arrival_id === "arr-2026-0005");
  const abstained = artifact.arrivals.find((row) => row.arrival_id === "arr-2026-0006");
  assert.deepEqual(missingSpan.reasons, ["missing_source_span"]);
  assert.equal(missingSpan.intent_id, null);
  assert.deepEqual(missingCitation.reasons, ["missing_source_citation"]);
  assert.equal(missingCitation.intent_id, null);
  assert.equal(abstained.disposition, "abstained");
  assert.ok(abstained.reasons.includes("past_tense"));
  // The past-tense control carries the RFP substring the extractor must reject.
  assert.equal(abstained.contains_rfp_baseline, true);
  assert.equal(artifact.metrics.abstention.insufficient_source_evidence, 2);
  assert.equal(artifact.metrics.abstention.extraction_abstentions, 1);
  assert.equal(
    artifact.metrics.arrival_dispositions.opened_intent
      + artifact.metrics.arrival_dispositions.duplicate_replay
      + artifact.metrics.arrival_dispositions.insufficient_evidence
      + artifact.metrics.arrival_dispositions.abstained
      + artifact.metrics.arrival_dispositions.resolution_observation
      + artifact.metrics.arrival_dispositions.malformed,
    artifact.metrics.arrival_dispositions.denominator,
  );
});

test("replaying the retained stream twice is byte-identical", () => {
  const first = buildShadowArtifact();
  const second = buildShadowArtifact();
  assert.equal(JSON.stringify(first, null, 2), JSON.stringify(second, null, 2));
  assert.equal(reportMarkdown(first), reportMarkdown(second));
  // Arrival order in the file must not change the result.
  const stream = readStream();
  const reversed = { ...stream, arrivals: [...stream.arrivals].reverse() };
  const replayed = runShadowMode(reversed, {
    streamArtifact: first.input_coverage.stream_artifact,
    streamSha256: first.input_coverage.stream_sha256,
  });
  assert.equal(JSON.stringify(replayed), JSON.stringify(first));
});

test("resolution refuses an as-of clock it cannot honour", () => {
  const stream = readStream();
  const { sourceArrivals } = partitionArrivals(stream);
  const { intents } = runAssertionPhase(sourceArrivals);
  assert.throws(() => runResolutionPhase(intents, [], {}), /ISO as_of clock/);
});

test("committed shadow JSON and report stay in lockstep", () => {
  const artifact = checkShadowMode();
  assert.equal(artifact.temporal_integrity.leakage_failures.length, 0);
  assert.equal(artifact.promotion.product_promotion_allowed, false);
  assert.equal(artifact.visibility, SHADOW_VISIBILITY);
});

test("architecture-evidence projections reconcile the PIR-5 card", () => {
  const result = reconcileDerivedArchitectureEvidence();
  assert.equal(result.status, "PASS", result.findings.join("; "));
  assert.equal(
    result.evidence.projections["warehouse/fixtures/procurement-intent-radar/shadow_mode.v1.json"]
      .represented_card_ids.includes("cityscroll-procurement-intent-radar/pir-5"),
    true,
  );
});
