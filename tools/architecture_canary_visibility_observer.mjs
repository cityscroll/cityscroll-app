/**
 * LA7–LA8 visibility observer for frozen architecture-affecting PRs.
 *
 * A case is visible when its required canary paths are observed and its
 * required signals appear in current facts. Historical blindness (unmapped
 * path or missing signal) is the collapsed fixture the backtest must still
 * detect. Re-narrowing the extractor makes the live projection fail.
 */
import { buildFacts } from "./build_architecture_facts.mjs";

export const CANARY_VISIBILITY_SCHEMA = "cityscroll.architecture.canary_visibility.v1";

export const CANARY_VISIBILITY_FINDINGS = Object.freeze({
  UNMAPPED_SURFACE: "unmapped_surface",
  MISSING_SIGNAL: "missing_signal",
});

export const SIGNAL_EXTRACTORS = Object.freeze({
  committees_family(facts) {
    return (facts?.search?.production?.collection_families ?? [])
      .some((item) => item?.family === "committees");
  },
  committees_index_family(facts) {
    return (facts?.search?.keyword_index?.families ?? []).includes("committees");
  },
  graph_cap(facts) {
    return facts?.constellation?.graph?.cap ?? null;
  },
  public_eligibility(facts) {
    return facts?.exams?.surface?.public_eligibility ?? null;
  },
  fail_closed_public_eligibility(facts) {
    return facts?.exams?.surface?.fail_closed_public_eligibility === true;
  },
  interest_multiselect(facts) {
    return facts?.exams?.surface?.interest_multiselect === true;
  },
});

export function signalMatches(actual, expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (Object.hasOwn(expected, "gte")) {
      return Number.isFinite(actual) && actual >= Number(expected.gte);
    }
    return false;
  }
  return Object.is(actual, expected);
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function pathSet(values) {
  return new Set(asList(values).map((item) => String(item || "").trim()).filter(Boolean));
}

function finding(type, target, details = {}) {
  return { type, target, ...details };
}

export function observeCanaryVisibility(observation = {}) {
  const findings = [];
  const requiredPaths = asList(observation.required_paths);
  const observed = pathSet(observation.observed_paths);
  const unmapped = new Set(
    asList(observation.unmapped_surfaces).map((entry) => String(entry?.path || "").trim()).filter(Boolean),
  );
  for (const path of requiredPaths) {
    if (!observed.has(path) || unmapped.has(path)) {
      findings.push(finding(CANARY_VISIBILITY_FINDINGS.UNMAPPED_SURFACE, path));
    }
  }
  const expected = observation.signals && typeof observation.signals === "object"
    ? observation.signals
    : {};
  const actuals = observation.observed_signals && typeof observation.observed_signals === "object"
    ? observation.observed_signals
    : {};
  for (const [name, expectedValue] of Object.entries(expected)) {
    const actual = Object.hasOwn(actuals, name) ? actuals[name] : undefined;
    if (!signalMatches(actual, expectedValue)) {
      findings.push(finding(CANARY_VISIBILITY_FINDINGS.MISSING_SIGNAL, name, {
        expected: expectedValue,
        actual: actual ?? null,
      }));
    }
  }
  return {
    schema: CANARY_VISIBILITY_SCHEMA,
    status: findings.length ? "drift" : "healthy",
    findings,
  };
}

export function extractObservedSignals(facts, signals = {}) {
  const observed = {};
  for (const name of Object.keys(signals || {})) {
    const extractor = SIGNAL_EXTRACTORS[name];
    observed[name] = extractor ? extractor(facts) : null;
  }
  return observed;
}

export function projectCurrentCanaryObservation(spec = {}, facts = null) {
  const live = facts ?? buildFacts({
    generatedAt: "1970-01-01T00:00:00Z",
    commit: "backtest",
  });
  return {
    required_paths: asList(spec.required_paths),
    observed_paths: asList(live.observer_coverage?.observed_paths),
    unmapped_surfaces: asList(live.observer_coverage?.unmapped_surfaces),
    signals: spec.signals && typeof spec.signals === "object" ? spec.signals : {},
    observed_signals: extractObservedSignals(live, spec.signals),
  };
}
