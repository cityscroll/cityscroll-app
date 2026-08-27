const DAY_MS = 86_400_000;

export const HEALTH_STATUSES = Object.freeze([
  "Healthy",
  "Delayed",
  "Degraded",
  "Source-unavailable",
  "Limited-coverage",
  "Historical",
  "Manual-refresh",
]);

function reasonCodes(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function validInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const text = value.trim();
  const epoch = Date.parse(
    /T/.test(text) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? `${text}Z` : text,
  );
  if (!Number.isFinite(epoch)) return null;
  const date = new Date(epoch);
  if (date.getUTCFullYear() <= 1970) return null;
  return date.toISOString();
}

export function normalizeClock(value, basis = null) {
  const at = validInstant(value);
  return at
    ? { at, state: "KNOWN", basis: basis || "reported_timestamp" }
    : { at: null, state: "UNKNOWN", basis: null };
}

function clockAgeDays(clock, nowMs) {
  if (clock?.state !== "KNOWN") return null;
  return (nowMs - Date.parse(clock.at)) / DAY_MS;
}

function selectedAcquisitionClock(observation) {
  const acquired = normalizeClock(observation?.acquired_at, "acquired_at");
  if (acquired.state === "KNOWN") return acquired;
  return normalizeClock(observation?.checked_at, "checked_at");
}

function servingClock(observation) {
  return normalizeClock(observation?.serving?.at, observation?.serving?.basis || "serving_materialized_at");
}

function publisherClock(observation) {
  return normalizeClock(observation?.publisher_updated_at, observation?.publisher_clock_basis || "publisher_updated_at");
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function servingMaxAge(contract, observation) {
  return finitePositive(observation?.serving?.max_age_days)
    || finitePositive(contract?.freshness_contract?.serving_max_age_days)
    || finitePositive(contract?.freshness_contract?.max_stale_days);
}

function servingIsValid(contract, observation, clock, nowMs) {
  if (!observation?.serving?.fallback_valid || clock.state !== "KNOWN") return false;
  const maxAge = servingMaxAge(contract, observation);
  return maxAge == null || clockAgeDays(clock, nowMs) <= maxAge;
}

function result(status, reasons, clocks) {
  return {
    status,
    reason_codes: reasonCodes(reasons),
    clocks,
  };
}

/**
 * Evaluate source freshness only. Relationship/source_records coverage is a
 * separate projection and deliberately does not enter this function.
 */
export function evaluateSourceHealth(contract, observation = null, options = {}) {
  const now = normalizeClock(
    options.now instanceof Date ? options.now.toISOString() : options.now,
    "evaluation_time",
  );
  if (now.state !== "KNOWN") throw new Error("source health evaluation requires a valid now timestamp");
  const nowMs = Date.parse(now.at);
  const publisher = publisherClock(observation);
  const acquisition = selectedAcquisitionClock(observation);
  const serving = servingClock(observation);
  const clocks = {
    publisher_updated: publisher,
    cityscroll_checked_acquired: acquisition,
    cityscroll_serving: serving,
  };
  const mode = contract?.freshness_contract?.mode || "periodic";
  const acquisitionStatus = String(observation?.acquisition_status || "unknown");
  const servingStatus = String(observation?.serving?.status || "unknown");

  if (["failed", "held"].includes(acquisitionStatus)) {
    const acquisitionReason = acquisitionStatus === "held" ? "acquisition-held" : "acquisition-failed";
    if (servingIsValid(contract, observation, serving, nowMs)) {
      return result("Degraded", [acquisitionReason, "serving-valid-fallback"], clocks);
    }
    return result("Source-unavailable", [acquisitionReason, "serving-fallback-unavailable"], clocks);
  }

  if (acquisitionStatus === "partial") {
    return result("Limited-coverage", ["acquisition-partial"], clocks);
  }

  if (mode === "historical") {
    return result("Historical", ["historical-source"], clocks);
  }

  if (contract?.status === "disabled") {
    return result("Source-unavailable", ["source-disabled"], clocks);
  }

  if (mode === "manual-conditional") {
    if (observation?.manual_refresh?.due === false && acquisitionStatus === "succeeded") {
      return result("Healthy", [], clocks);
    }
    return result("Manual-refresh", [
      observation?.manual_refresh?.due === true
        ? "manual-refresh-due"
        : "manual-refresh-condition-unknown",
    ], clocks);
  }

  const maxStaleDays = finitePositive(contract?.freshness_contract?.max_stale_days);
  const clockBasis = contract?.freshness_contract?.clock_basis || "publisher_updated";
  const freshnessClock = clockBasis === "checked_acquired" ? acquisition : publisher;
  if (maxStaleDays != null && clockAgeDays(freshnessClock, nowMs) > maxStaleDays) {
    return result("Delayed", [
      clockBasis === "checked_acquired" ? "acquisition-clock-stale" : "publisher-clock-stale",
    ], clocks);
  }

  const maxServeAge = servingMaxAge(contract, observation);
  if (
    serving.state === "KNOWN"
    && maxServeAge != null
    && clockAgeDays(serving, nowMs) > maxServeAge
  ) {
    return result("Degraded", ["serving-clock-stale"], clocks);
  }
  if (servingStatus === "unavailable" && acquisitionStatus === "succeeded") {
    return result("Degraded", ["serving-unavailable"], clocks);
  }

  if (acquisitionStatus === "succeeded") return result("Healthy", [], clocks);
  return result("Source-unavailable", [
    observation ? "acquisition-status-unknown" : "observation-missing",
  ], clocks);
}

export function normalizeRelationshipCoverage(coverage = null) {
  const rowCount = Number.isFinite(Number(coverage?.row_count))
    ? Number(coverage.row_count)
    : null;
  const measured = normalizeClock(coverage?.measured_at, "coverage_census");
  const reasons = [];
  let status = String(coverage?.status || "not-declared");
  const joinStatus = String(coverage?.join_status || "unknown");

  if (joinStatus === "held") {
    status = "held";
    reasons.push("relationship-join-held");
  } else if (joinStatus === "failed") {
    status = "failed";
    reasons.push("relationship-join-failed");
  } else if (status === "complete" && !(rowCount > 0)) {
    status = "empty-declared-live";
    reasons.push("relationship-complete-without-rows");
  }

  return {
    status,
    join_status: joinStatus,
    row_count: rowCount,
    measured_at: measured.at,
    reason_codes: reasonCodes(reasons),
  };
}
