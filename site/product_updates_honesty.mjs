/**
 * Fail-closed consistency gate for a batch of product-update candidates
 * assembled outside this repository.
 *
 * An external assembler may propose a batch of items drawn from the public
 * product-updates artifact (`site/product_updates_source.mjs`). This module
 * re-derives every fact a batch item claims (its source event, capability
 * reference and version, demo route, regression coverage, and bounded claim)
 * from the same public artifact and demo manifest this repository already
 * publishes, and refuses the batch the moment any item disagrees with that
 * public record. It never repairs or substitutes a corrected value: a
 * mismatch excludes the item, naming the field that disagreed, and any
 * disagreement anywhere in the batch marks the whole batch not deliverable.
 */

import { sha256Hex } from "../entity_resolution/hash.mjs";
import { validatePublicProductUpdatesArtifact } from "./product_updates_source.mjs";

export const PRODUCT_UPDATES_HONESTY_RECEIPT_SCHEMA = "cityscroll.product_updates_honesty_receipt.v1";
export const PRODUCT_UPDATES_HONESTY_METHOD = "product_updates_honesty_check_v1";

export const HONESTY_BATCH_CANDIDATE_FIELDS = Object.freeze([
  "claim",
  "capability_ref",
  "capability_version",
  "demo_id",
  "demo_route",
  "source_event",
  "as_of",
]);

export const REGRESSION_STATES = Object.freeze(["passing", "broken", "missing"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sorted(value[key])]),
    );
  }
  return value;
}

function normalized(value) {
  return value === undefined ? null : value;
}

function fieldResult(name, expected, actual) {
  const pass = normalized(expected) === normalized(actual);
  return { name, pass, expected: normalized(expected), actual: normalized(actual) };
}

/**
 * The regression coverage a demo entry currently offers, derived only from
 * the public demo manifest (`site/demo/demo-links.json`) — the same manifest
 * `test/functional/20_demo_links.py` turns into one Playwright check per
 * entry. An entry that vanished, lost its route, or lost every visible
 * assertion can no longer be regression-checked, so it reads as "broken"
 * rather than "passing" even though nothing here re-runs the browser suite.
 */
export function deriveDemoRegressionState(demoManifest, demoId) {
  const id = clean(demoId, 80);
  const entries = Array.isArray(demoManifest?.entries) ? demoManifest.entries : [];
  if (!id) return "missing";
  const entry = entries.find((row) => row?.id === id) || null;
  if (!entry) return "missing";
  const hasRoute = typeof entry.url === "string" && entry.url.length > 0;
  const visible = entry?.expectations?.visible;
  const wellFormed = Array.isArray(visible)
    && visible.length > 0
    && visible.every((locator) => locator && typeof locator.selector === "string" && locator.selector.length > 0);
  return hasRoute && wellFormed ? "passing" : "broken";
}

function sourceEventFingerprint(sourceEvent) {
  const kind = clean(sourceEvent?.kind, 40) || null;
  const path = clean(sourceEvent?.path, 300) || null;
  if (kind === "changelog") {
    const pr = Number(sourceEvent?.pr);
    return { kind, path, pr: Number.isInteger(pr) && pr > 0 ? pr : null };
  }
  if (kind === "architecture_reconciliation") {
    return { kind, path, status: clean(sourceEvent?.status, 40) || null };
  }
  return { kind, path };
}

function artifactCandidatesById(artifact) {
  const map = new Map();
  for (const candidate of Array.isArray(artifact?.candidates) ? artifact.candidates : []) {
    if (candidate?.id != null) map.set(candidate.id, candidate);
  }
  return map;
}

function checkCandidate(batchCandidate, byId, demoManifest) {
  const candidateId = clean(batchCandidate?.candidate_id, 200) || null;
  const artifactCandidate = candidateId ? byId.get(candidateId) || null : null;
  const predicates = [];
  const mismatchedFields = [];
  const excludedReasons = [];

  const known = { name: "known_candidate", pass: Boolean(artifactCandidate) };
  predicates.push(known);
  if (!known.pass) {
    excludedReasons.push("unknown_candidate");
    return deepFreeze({
      candidate_id: candidateId,
      outcome: "excluded",
      predicates,
      mismatched_fields: mismatchedFields,
      excluded_reasons: excludedReasons,
    });
  }

  const currentlyEligible = artifactCandidate.state === "eligible" && artifactCandidate.eligible === true;
  const eligibility = {
    name: "artifact_currently_eligible",
    pass: currentlyEligible,
    detail: currentlyEligible ? null : clean(artifactCandidate.reason_detail || artifactCandidate.reason, 200) || null,
  };
  predicates.push(eligibility);
  if (!eligibility.pass) excludedReasons.push("artifact_ineligible");

  const fieldChecks = [
    fieldResult("claim", artifactCandidate.claim, batchCandidate?.claim),
    fieldResult("capability_ref", artifactCandidate.capability?.reference ?? null, batchCandidate?.capability_ref),
    fieldResult("capability_version", artifactCandidate.capability?.version ?? null, batchCandidate?.capability_version),
    fieldResult("demo_id", artifactCandidate.demo?.id ?? null, batchCandidate?.demo_id),
    fieldResult("demo_route", artifactCandidate.demo?.pathname ?? null, batchCandidate?.demo_route),
    fieldResult("as_of", artifactCandidate.as_of ?? null, batchCandidate?.as_of),
  ];
  const sourceEventMatch = JSON.stringify(sorted(sourceEventFingerprint(artifactCandidate.source_event)))
    === JSON.stringify(sorted(sourceEventFingerprint(batchCandidate?.source_event)));
  fieldChecks.push({
    name: "source_event",
    pass: sourceEventMatch,
    expected: sorted(sourceEventFingerprint(artifactCandidate.source_event)),
    actual: sorted(sourceEventFingerprint(batchCandidate?.source_event)),
  });

  for (const field of fieldChecks) {
    predicates.push(field);
    if (!field.pass) mismatchedFields.push(field.name);
  }
  if (mismatchedFields.length) excludedReasons.push("field_mismatch");

  const expectedRegressionState = deriveDemoRegressionState(demoManifest, artifactCandidate.demo?.id ?? null);
  const regression = {
    name: "regression_state",
    pass: normalized(expectedRegressionState) === normalized(batchCandidate?.regression_state)
      && expectedRegressionState === "passing",
    expected: expectedRegressionState,
    actual: normalized(batchCandidate?.regression_state),
  };
  predicates.push(regression);
  if (!regression.pass) excludedReasons.push("regression_mismatch");

  const outcome = excludedReasons.length === 0 ? "eligible" : "excluded";
  return deepFreeze({
    candidate_id: candidateId,
    outcome,
    predicates,
    mismatched_fields: mismatchedFields,
    excluded_reasons: excludedReasons,
  });
}

/**
 * Check an externally assembled batch against the public product-updates
 * artifact and demo manifest. Pure and deterministic: the same three inputs
 * always produce the same receipt, including its content hash.
 */
export function checkBatchHonesty({ artifact, demoManifest, batch } = {}) {
  const artifactErrors = validatePublicProductUpdatesArtifact(artifact);
  const batchId = clean(batch?.batch_id, 200) || null;
  const declaredHash = clean(batch?.source_artifact_hash, 64) || null;
  const artifactHash = clean(artifact?.content_hash, 64) || null;
  const hashMatch = artifactErrors.length === 0 && Boolean(declaredHash) && declaredHash === artifactHash;
  const candidates = Array.isArray(batch?.candidates) ? batch.candidates : [];
  const byId = artifactCandidatesById(artifact);

  const items = candidates.map((candidate) => {
    const checked = checkCandidate(candidate, byId, demoManifest);
    if (hashMatch) return checked;
    return deepFreeze({
      ...checked,
      outcome: "excluded",
      excluded_reasons: [...checked.excluded_reasons, "source_artifact_hash_mismatch"],
    });
  });

  const eligibleIds = items.filter((item) => item.outcome === "eligible").map((item) => item.candidate_id);
  const excludedIds = items.filter((item) => item.outcome !== "eligible").map((item) => item.candidate_id);

  const deliverable = artifactErrors.length === 0
    && hashMatch
    && candidates.length > 0
    && items.every((item) => item.outcome === "eligible");

  const receipt = {
    schema: PRODUCT_UPDATES_HONESTY_RECEIPT_SCHEMA,
    method: PRODUCT_UPDATES_HONESTY_METHOD,
    batch_id: batchId,
    artifact_checked: {
      schema: artifact?.schema ?? null,
      method: artifact?.method ?? null,
      as_of: artifact?.as_of ?? null,
      observed_commit: artifact?.observed_commit ?? null,
      content_hash: artifactHash,
    },
    artifact_valid: artifactErrors.length === 0,
    artifact_errors: artifactErrors,
    source_artifact_hash: declaredHash,
    source_artifact_hash_match: hashMatch,
    items,
    eligible_ids: eligibleIds,
    excluded_ids: excludedIds,
    deliverable,
  };
  receipt.content_hash = hashHonestyReceipt(receipt);
  return deepFreeze(receipt);
}

export function honestyReceiptEvidence(receipt) {
  const { content_hash: _hash, ...rest } = receipt || {};
  return sorted(rest);
}

export function hashHonestyReceipt(receipt) {
  return sha256Hex(JSON.stringify(honestyReceiptEvidence(receipt)));
}

export function serializeHonestyReceipt(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}
