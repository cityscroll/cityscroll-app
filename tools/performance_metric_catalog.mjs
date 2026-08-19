import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PERFORMANCE_CATALOG_PATH = resolve(
  ROOT,
  "architecture/performance-observability.v1.json",
);
export const PERFORMANCE_CATALOG_SCHEMA_PATH = resolve(
  ROOT,
  "architecture/performance-observability.v1.schema.json",
);

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STABLE_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const NON_MEASUREMENT_STATES = new Set([
  "missing",
  "unsupported",
  "background",
  "no_interaction",
]);
const UNITS = new Set(["ms", "score"]);
const FORBIDDEN_POLICY_KEYS = /(?:^|_)(?:threshold|budget|ceiling|slo|objective)(?:_|$)/i;

function fail(message) {
  throw new TypeError(`invalid performance metric catalog: ${message}`);
}

function exactKeys(value, expected, context) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${context} keys must be exactly ${wanted.join(", ")}`);
  }
}

function assertArray(value, context, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${context} must be ${allowEmpty ? "an array" : "a non-empty array"}`);
  }
}

function assertUniqueStrings(value, context, { allowEmpty = false } = {}) {
  assertArray(value, context, { allowEmpty });
  if (value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail(`${context} must contain non-empty strings`);
  }
  if (new Set(value).size !== value.length) fail(`${context} must be unique`);
}

function rejectPolicyKeys(value, context = "catalog") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPolicyKeys(item, `${context}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_POLICY_KEYS.test(key)) fail(`${context}.${key} is an enforcement-policy key`);
    rejectPolicyKeys(child, `${context}.${key}`);
  }
}

export function loadPerformanceMetricCatalog(path = PERFORMANCE_CATALOG_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validatePerformanceMetricCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) fail("root must be an object");
  exactKeys(
    catalog,
    [
      "$schema",
      "schema",
      "catalog_version",
      "registry_version",
      "manifest_version",
      "description",
      "observation_contract",
      "metrics",
      "phase_decompositions",
      "delivery_classes",
      "lifecycle_states",
      "projection_policy",
      "semantic_readiness_contracts",
      "surfaces",
      "components",
    ],
    "root",
  );
  if (catalog.$schema !== "./performance-observability.v1.schema.json") fail("unexpected $schema");
  if (catalog.schema !== "cityscroll.performance_observability.v1") fail("unexpected schema id");
  if (!SEMVER.test(catalog.catalog_version)) fail("catalog_version must be semantic versioning");
  rejectPolicyKeys(catalog);

  const observationContract = catalog.observation_contract;
  exactKeys(
    observationContract,
    ["schema", "measured_state", "non_measurement_states", "zero_rule"],
    "observation_contract",
  );
  if (observationContract.schema !== "cityscroll.performance_observation.v1") {
    fail("unexpected observation schema id");
  }
  if (observationContract.measured_state !== "measured") fail("measured state must be explicit");
  assertUniqueStrings(observationContract.non_measurement_states, "non_measurement_states");
  if (
    observationContract.non_measurement_states.length !== NON_MEASUREMENT_STATES.size ||
    observationContract.non_measurement_states.some((state) => !NON_MEASUREMENT_STATES.has(state))
  ) {
    fail("non-measurement states must preserve missing, unsupported, background, and no_interaction");
  }
  if (!observationContract.zero_rule.includes("state=measured") || !observationContract.zero_rule.includes("forbids value")) {
    fail("zero_rule must distinguish measured zero from non-measurement states");
  }

  assertArray(catalog.metrics, "metrics");
  const metricIds = new Set();
  for (const metric of catalog.metrics) {
    exactKeys(
      metric,
      ["id", "version", "unit", "raw", "derived", "description", "numeric_domain", "lifecycle", "derived_from", "synthetic_mapping"],
      `metric ${metric?.id ?? "<unknown>"}`,
    );
    if (!STABLE_ID.test(metric.id)) fail(`metric id ${metric.id} is not stable`);
    if (metricIds.has(metric.id)) fail(`duplicate metric id ${metric.id}`);
    metricIds.add(metric.id);
    if (!SEMVER.test(metric.version)) fail(`${metric.id}.version must be semantic versioning`);
    if (!UNITS.has(metric.unit)) fail(`${metric.id}.unit is unsupported`);
    if (typeof metric.raw !== "boolean" || typeof metric.derived !== "boolean" || metric.raw === metric.derived) {
      fail(`${metric.id} must be exactly one of raw or derived`);
    }
    if (typeof metric.description !== "string" || metric.description.length === 0) {
      fail(`${metric.id}.description must be non-empty`);
    }
    exactKeys(metric.numeric_domain, ["finite", "minimum", "measured_zero_valid"], `${metric.id}.numeric_domain`);
    if (
      metric.numeric_domain.finite !== true ||
      metric.numeric_domain.minimum !== 0 ||
      metric.numeric_domain.measured_zero_valid !== true
    ) {
      fail(`${metric.id}.numeric_domain must admit only finite nonnegative measurements and preserve measured zero`);
    }

    const lifecycle = metric.lifecycle;
    exactKeys(
      lifecycle,
      ["scope", "start_landmark", "end_landmark", "finalize_condition", "valid_when", "non_measurement_states"],
      `${metric.id}.lifecycle`,
    );
    if (!["page", "component", "interaction"].includes(lifecycle.scope)) fail(`${metric.id}.lifecycle.scope is unsupported`);
    if (!STABLE_ID.test(lifecycle.start_landmark) || !STABLE_ID.test(lifecycle.end_landmark)) {
      fail(`${metric.id}.lifecycle landmarks must be stable ids`);
    }
    if (typeof lifecycle.finalize_condition !== "string" || lifecycle.finalize_condition.length === 0) {
      fail(`${metric.id}.lifecycle.finalize_condition must be non-empty`);
    }
    assertUniqueStrings(lifecycle.valid_when, `${metric.id}.lifecycle.valid_when`);
    assertUniqueStrings(lifecycle.non_measurement_states, `${metric.id}.lifecycle.non_measurement_states`);
    if (lifecycle.non_measurement_states.some((state) => !NON_MEASUREMENT_STATES.has(state))) {
      fail(`${metric.id}.lifecycle contains an unknown non-measurement state`);
    }

    assertUniqueStrings(metric.derived_from, `${metric.id}.derived_from`, { allowEmpty: true });
    if (metric.raw && metric.derived_from.length > 0) fail(`${metric.id} is raw but declares derived inputs`);

    const mapping = metric.synthetic_mapping;
    exactKeys(mapping, ["status", "names", "incompatible_names", "reason"], `${metric.id}.synthetic_mapping`);
    if (!["exact", "conditional", "scoped", "none"].includes(mapping.status)) {
      fail(`${metric.id}.synthetic_mapping.status is unsupported`);
    }
    assertArray(mapping.names, `${metric.id}.synthetic_mapping.names`, { allowEmpty: true });
    if ((mapping.status === "none") !== (mapping.names.length === 0)) {
      fail(`${metric.id}.synthetic_mapping none status must have no compatible names and vice versa`);
    }
    const compatibleNames = new Set();
    for (const mapped of mapping.names) {
      exactKeys(mapped, ["name", "fixture_scope", "compatibility_condition"], `${metric.id}.synthetic_mapping name`);
      if (typeof mapped.name !== "string" || mapped.name.length === 0 || compatibleNames.has(mapped.name)) {
        fail(`${metric.id}.synthetic_mapping names must be non-empty and unique`);
      }
      compatibleNames.add(mapped.name);
      assertUniqueStrings(mapped.fixture_scope, `${metric.id}.${mapped.name}.fixture_scope`);
      if (typeof mapped.compatibility_condition !== "string" || mapped.compatibility_condition.length === 0) {
        fail(`${metric.id}.${mapped.name}.compatibility_condition must be non-empty`);
      }
    }
    assertUniqueStrings(mapping.incompatible_names, `${metric.id}.synthetic_mapping.incompatible_names`, { allowEmpty: true });
    if (mapping.incompatible_names.some((name) => compatibleNames.has(name))) {
      fail(`${metric.id} maps the same synthetic name as compatible and incompatible`);
    }
    if (typeof mapping.reason !== "string" || mapping.reason.length === 0) {
      fail(`${metric.id}.synthetic_mapping.reason must be non-empty`);
    }
  }

  for (const metric of catalog.metrics) {
    for (const input of metric.derived_from) {
      if (!metricIds.has(input)) fail(`${metric.id}.derived_from references unknown metric ${input}`);
    }
  }

  assertArray(catalog.phase_decompositions, "phase_decompositions");
  const phaseIds = new Set();
  for (const phase of catalog.phase_decompositions) {
    exactKeys(
      phase,
      ["phase_id", "metric_id", "start_landmark", "end_landmark", "operation", "derive_in", "preconditions", "invalid_result", "negative_result"],
      `phase ${phase?.phase_id ?? "<unknown>"}`,
    );
    if (!STABLE_ID.test(phase.phase_id) || phaseIds.has(phase.phase_id)) fail(`phase id ${phase.phase_id} is invalid or duplicated`);
    phaseIds.add(phase.phase_id);
    if (!metricIds.has(phase.metric_id)) fail(`${phase.phase_id} references unknown metric ${phase.metric_id}`);
    if (!STABLE_ID.test(phase.start_landmark) || !STABLE_ID.test(phase.end_landmark)) {
      fail(`${phase.phase_id} landmarks must be stable ids`);
    }
    if (phase.operation !== "end_minus_start" || phase.derive_in !== "browser") {
      fail(`${phase.phase_id} must be derived in the browser as end minus start`);
    }
    const requiredPreconditions = ["all_landmarks_present", "all_landmarks_finite", "landmarks_ordered"];
    if (JSON.stringify(phase.preconditions) !== JSON.stringify(requiredPreconditions)) {
      fail(`${phase.phase_id} must require present, finite, ordered landmarks`);
    }
    if (phase.invalid_result !== "omit" || phase.negative_result !== "omit_never_clamp") {
      fail(`${phase.phase_id} must omit invalid or negative results without clamping`);
    }
  }

  return catalog;
}

export function validatePerformanceObservation(observation, catalog = loadPerformanceMetricCatalog()) {
  validatePerformanceMetricCatalog(catalog);
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw new TypeError("invalid performance observation: observation must be an object");
  }
  const metric = catalog.metrics.find((candidate) => candidate.id === observation.metric_id);
  if (!metric) throw new TypeError(`invalid performance observation: unknown metric ${observation.metric_id}`);
  if (observation.metric_version !== metric.version) {
    throw new TypeError(`invalid performance observation: version mismatch for ${metric.id}`);
  }
  if (observation.unit !== metric.unit) {
    throw new TypeError(`invalid performance observation: unit mismatch for ${metric.id}`);
  }
  if (observation.state === "measured") {
    exactObservationKeys(observation, ["metric_id", "metric_version", "unit", "state", "value"]);
    if (typeof observation.value !== "number" || !Number.isFinite(observation.value) || observation.value < 0) {
      throw new TypeError("invalid performance observation: measured value must be finite and nonnegative");
    }
    return observation;
  }
  if (!NON_MEASUREMENT_STATES.has(observation.state)) {
    throw new TypeError(`invalid performance observation: unknown state ${observation.state}`);
  }
  exactObservationKeys(observation, ["metric_id", "metric_version", "unit", "state"]);
  if (!metric.lifecycle.non_measurement_states.includes(observation.state)) {
    throw new TypeError(`invalid performance observation: ${observation.state} does not apply to ${metric.id}`);
  }
  return observation;
}

function exactObservationKeys(observation, expected) {
  const actual = Object.keys(observation).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`invalid performance observation: keys must be exactly ${wanted.join(", ")}`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  validatePerformanceMetricCatalog(loadPerformanceMetricCatalog());
  process.stdout.write("performance metric catalog valid\n");
}
