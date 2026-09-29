import assert from "node:assert/strict";
import test from "node:test";

import { warningAgeFindings } from "../tools/first_class_freshness_warning_alert.mjs";

const REGISTRY = {
  first_class_artifacts: [
    { id: "public-consultations", warning_age_hours: 72, hard_maximum_age_hours: 168 },
    { id: "other-dataset", warning_age_hours: 24, hard_maximum_age_hours: 48 },
  ],
};

function report(surfaces) {
  return { surfaces };
}

test("an artifact past its warning age but still under the hard maximum raises a finding", () => {
  const findings = warningAgeFindings(
    report([{ id: "public-consultations", public_artifact_path: "site/data/consultations.json", freshness_state: "degraded", age_hours: 80, source_vintage: "2026-09-26T00:00:00Z" }]),
    REGISTRY,
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0], /site\/data\/consultations\.json/);
  assert.match(findings[0], /80h/);
  assert.match(findings[0], /72h warning age/);
  assert.match(findings[0], /168h/);
});

test("an artifact inside its warning age raises nothing", () => {
  const findings = warningAgeFindings(
    report([{ id: "public-consultations", public_artifact_path: "site/data/consultations.json", freshness_state: "fresh", age_hours: 10 }]),
    REGISTRY,
  );
  assert.deepEqual(findings, []);
});

test("an artifact that already reached stale or unavailable is not re-raised here", () => {
  // Those states already have their own alarm: the production freshness gate
  // itself, which this file exists to raise something before, not to repeat.
  const findings = warningAgeFindings(
    report([
      { id: "public-consultations", public_artifact_path: "site/data/consultations.json", freshness_state: "stale", age_hours: 200 },
      { id: "other-dataset", public_artifact_path: "site/data/other.json", freshness_state: "unavailable", age_hours: null },
    ]),
    REGISTRY,
  );
  assert.deepEqual(findings, []);
});

test("degraded from a failed acquisition, not from age, raises nothing here", () => {
  // freshness_state can be "degraded" for reasons unrelated to age (a failed
  // acquisition this run, a degraded source-health status). This finding is
  // specifically about age crossing the declared warning threshold.
  const findings = warningAgeFindings(
    report([{ id: "public-consultations", public_artifact_path: "site/data/consultations.json", freshness_state: "degraded", age_hours: 5 }]),
    REGISTRY,
  );
  assert.deepEqual(findings, []);
});

test("a surface with no matching registry entry is skipped rather than crashing", () => {
  const findings = warningAgeFindings(
    report([{ id: "unknown-artifact", public_artifact_path: "site/data/unknown.json", freshness_state: "degraded", age_hours: 1000 }]),
    REGISTRY,
  );
  assert.deepEqual(findings, []);
});
