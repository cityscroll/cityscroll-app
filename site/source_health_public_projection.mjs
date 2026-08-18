// Public source-health serialization boundary.
//
// Contracts and observations contain operator-facing detail. This module never
// redacts those objects in place: it constructs a new, closed public shape from
// an explicit allowlist and then applies a deny-list as a second safety net.

export const PUBLIC_SOURCE_HEALTH_SCHEMA = "cityscroll.public_source_health.v1";

const PUBLIC_HEALTH_STATUSES = new Set([
  "Healthy",
  "Delayed",
  "Degraded",
  "Source-unavailable",
  "Limited-coverage",
  "Historical",
  "Manual-refresh",
]);

const PUBLIC_HEALTH_REASON_CODES = new Set([
  "acquisition-clock-stale",
  "acquisition-failed",
  "acquisition-held",
  "acquisition-partial",
  "acquisition-status-unknown",
  "historical-source",
  "manual-refresh-condition-unknown",
  "manual-refresh-due",
  "observation-missing",
  "publisher-clock-stale",
  "serving-clock-stale",
  "serving-fallback-unavailable",
  "serving-unavailable",
  "serving-valid-fallback",
  "source-disabled",
]);

const PUBLIC_COVERAGE_REASON_CODES = new Set([
  "relationship-complete-without-rows",
  "relationship-join-failed",
  "relationship-join-held",
]);

const PUBLIC_MODES = new Set([
  "continuous",
  "historical",
  "manual-conditional",
  "periodic",
  "pointer",
]);

const CLOCK_NAMES = Object.freeze([
  "publisher_updated",
  "cityscroll_checked_acquired",
  "cityscroll_serving",
]);

const DENIED_FIELD = /(?:^|_)(?:adapter|auth|backoff|body|denominator|endpoint|env|error|fingerprint|gate|hash|header|job|max_stale|numerator|operator|password|path|precision|raw|receipt|retry|row_count|runbook|secret|threshold|token|usefulness)(?:_|$)/i;
const SECRET_LIKE_VALUE = /(?:\b[A-Z][A-Z0-9]{2,}_(?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD|ENV)\b|\b[a-f0-9]{64}\b|\bError:\s|\bat\s+\S+:\d+:\d+)/;

function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function validInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  const date = new Date(epoch);
  return date.getUTCFullYear() > 1970 ? date.toISOString() : null;
}

function safeOfficialUrl(value) {
  try {
    const url = new URL(clean(value));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function allowedCodes(values, allowlist) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => allowlist.has(value)))].sort();
}

function publicClock(clock, clockName) {
  const at = validInstant(clock?.at);
  if (!at) return { at: null, state: "UNKNOWN", basis: null };
  let basis = "cityscroll_observation";
  if (clockName === "publisher_updated") basis = "publisher_record";
  if (clockName === "cityscroll_serving") basis = "cityscroll_materialization";
  if (clockName === "cityscroll_checked_acquired") {
    basis = clock?.basis === "checked_at" ? "cityscroll_check" : "cityscroll_acquisition";
  }
  return { at, state: "KNOWN", basis };
}

function publicHealth(observation) {
  const health = observation?.health;
  const reasons = allowedCodes(health?.reason_codes, PUBLIC_HEALTH_REASON_CODES);
  const hasOnlyUnknownObservation = reasons.some((reason) => (
    reason === "acquisition-status-unknown" || reason === "observation-missing"
  ));
  const clocks = Object.fromEntries(CLOCK_NAMES.map((clockName) => [
    clockName,
    publicClock(health?.clocks?.[clockName], clockName),
  ]));
  return {
    status: !hasOnlyUnknownObservation && PUBLIC_HEALTH_STATUSES.has(health?.status)
      ? health.status
      : "UNKNOWN",
    reason_codes: reasons,
    clocks,
  };
}

function publicCoverage(coverage) {
  let status = "UNKNOWN";
  if (coverage?.status === "complete" && coverage?.join_status === "accepted") {
    status = "complete_for_declared_scope";
  } else if (["partial", "gap", "empty-declared-live"].includes(coverage?.status)) {
    status = "limited_coverage";
  } else if (
    ["held", "failed"].includes(coverage?.status)
    || ["held", "failed"].includes(coverage?.join_status)
  ) {
    status = "held_or_failed_join";
  }
  return {
    status,
    measured_at: validInstant(coverage?.measured_at),
    reason_codes: allowedCodes(coverage?.reason_codes, PUBLIC_COVERAGE_REASON_CODES),
  };
}

function publicRow(contract, observation) {
  return {
    source_id: contract.id,
    name: clean(contract.name),
    publisher: clean(contract.owner),
    official_url: safeOfficialUrl(contract.landing_page),
    expected_cadence: clean(contract.publisher_cadence),
    mode: PUBLIC_MODES.has(contract?.freshness_contract?.mode)
      ? contract.freshness_contract.mode
      : "UNKNOWN",
    health: publicHealth(observation),
    relationship_coverage: publicCoverage(observation?.relationship_coverage),
  };
}

export function publicSourceHealthProjectionLeaks(value) {
  const findings = [];
  function inspect(current, path) {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => inspect(entry, `${path}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") {
      if (typeof current === "string" && SECRET_LIKE_VALUE.test(current)) {
        findings.push(`${path}: secret-like or operator-only value`);
      }
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      const entryPath = path ? `${path}.${key}` : key;
      if (DENIED_FIELD.test(key)) findings.push(`${entryPath}: denied public field`);
      inspect(entry, entryPath);
    }
  }
  inspect(value, "");
  return [...new Set(findings)].sort();
}

function unexpectedKeys(value, allowed, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: field is not in the public allowlist`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: missing public field`);
  }
}

export function validatePublicSourceHealthProjection(projection, registry = null) {
  const errors = publicSourceHealthProjectionLeaks(projection);
  unexpectedKeys(
    projection,
    ["schema", "generated_at", "available", "source_count", "sources"],
    "projection",
    errors,
  );
  if (projection?.schema !== PUBLIC_SOURCE_HEALTH_SCHEMA) errors.push("projection.schema: invalid schema");
  if (projection?.available !== true) errors.push("projection.available: generated artifact must be available");
  if (validInstant(projection?.generated_at) !== projection?.generated_at) {
    errors.push("projection.generated_at: invalid timestamp");
  }
  if (!Array.isArray(projection?.sources)) {
    errors.push("projection.sources must be an array");
    return [...new Set(errors)].sort();
  }
  if (projection.source_count !== projection.sources.length) {
    errors.push("projection.source_count must equal sources.length");
  }

  const canonical = registry
    ? new Set((registry?.contracts || []).map((contract) => contract.id))
    : null;
  const seen = new Set();
  projection.sources.forEach((row, index) => {
    const path = `projection.sources[${index}]`;
    unexpectedKeys(row, [
      "source_id",
      "name",
      "publisher",
      "official_url",
      "expected_cadence",
      "mode",
      "health",
      "relationship_coverage",
    ], path, errors);
    if (!clean(row?.source_id)) errors.push(`${path}.source_id: missing canonical id`);
    if (seen.has(row?.source_id)) errors.push(`${path}.source_id: duplicate public row`);
    seen.add(row?.source_id);
    if (canonical && !canonical.has(row?.source_id)) errors.push(`${path}.source_id: no canonical contract`);
    unexpectedKeys(row?.health, ["status", "reason_codes", "clocks"], `${path}.health`, errors);
    unexpectedKeys(
      row?.health?.clocks,
      CLOCK_NAMES,
      `${path}.health.clocks`,
      errors,
    );
    for (const clockName of CLOCK_NAMES) {
      const clock = row?.health?.clocks?.[clockName];
      unexpectedKeys(clock, ["at", "state", "basis"], `${path}.health.clocks.${clockName}`, errors);
      if (clock?.state === "UNKNOWN" && (clock.at !== null || clock.basis !== null)) {
        errors.push(`${path}.health.clocks.${clockName}: UNKNOWN clock must use null values`);
      }
      if (clock?.state === "KNOWN" && !validInstant(clock.at)) {
        errors.push(`${path}.health.clocks.${clockName}: KNOWN clock needs a valid timestamp`);
      }
    }
    unexpectedKeys(
      row?.relationship_coverage,
      ["status", "measured_at", "reason_codes"],
      `${path}.relationship_coverage`,
      errors,
    );
  });
  return [...new Set(errors)].sort();
}

export function buildPublicSourceHealthProjection(registry, observations) {
  const contracts = Array.isArray(registry?.contracts) ? registry.contracts : [];
  const contractIds = new Set();
  for (const contract of contracts) {
    if (!clean(contract?.id)) throw new Error("source contract is missing a canonical id");
    if (contractIds.has(contract.id)) throw new Error(`${contract.id}: duplicate source contract`);
    contractIds.add(contract.id);
  }

  const observationById = new Map();
  for (const observation of Array.isArray(observations?.observations) ? observations.observations : []) {
    const id = clean(observation?.source_id);
    if (!contractIds.has(id)) throw new Error(`${id || "(missing source_id)"}: observation has no canonical contract`);
    if (observationById.has(id)) throw new Error(`${id}: duplicate observation`);
    observationById.set(id, observation);
  }

  const sources = contracts
    .filter((contract) => contract?.health_policy?.public_visibility === "public")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((contract) => publicRow(contract, observationById.get(contract.id)));
  const projection = {
    schema: PUBLIC_SOURCE_HEALTH_SCHEMA,
    generated_at: validInstant(observations?.generated_at),
    available: true,
    source_count: sources.length,
    sources,
  };
  const errors = validatePublicSourceHealthProjection(projection, registry);
  if (errors.length) throw new Error(`invalid public source-health projection:\n${errors.join("\n")}`);
  return projection;
}

export function publicSourceHealthProjectionText(projection) {
  return `${JSON.stringify(projection, null, 2)}\n`;
}
