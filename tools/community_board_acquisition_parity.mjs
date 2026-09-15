/**
 * Read-only parity envelope for a bounded set of community-board acquisitions.
 *
 * This is deliberately a report builder, not an acquisition runner: callers
 * supply the receipts and consumer read-back from the environment they ran.
 * That keeps a local replay from being mislabeled as deployed evidence while
 * giving every run the same admission and comparison rules.
 */

export const COMMUNITY_BOARD_ACQUISITION_PARITY_SCHEMA =
  "cityscroll.community_board_acquisition_parity.v1";

function ageHours(observedAt, asOf) {
  const observed = Date.parse(observedAt || "");
  const current = Date.parse(asOf || "");
  if (!Number.isFinite(observed) || !Number.isFinite(current)) return null;
  return Math.max(0, (current - observed) / 3_600_000);
}

function sourceKey(observation) {
  return observation.source_id || observation.source?.source_id
    || observation.source?.board_id || observation.board_id || null;
}

function admitted(record) {
  return Boolean(record?.record_id && record?.date && record?.title
    && record?.source_url && record?.observed_receipt?.status === "ok");
}

function identity(record) {
  return `${record.record_id}|${record.date}`;
}

function metrics(receipt = {}) {
  const stats = receipt.acquisition?.stats || receipt.stats || {};
  return {
    requests: Number.isFinite(stats.requests) ? stats.requests : null,
    bytes: Number.isFinite(stats.bytes) ? stats.bytes : null,
    duration_ms: Number.isFinite(stats.elapsed_ms) ? stats.elapsed_ms
      : (Number.isFinite(stats.duration_ms) ? stats.duration_ms : null),
  };
}

function sourceResult(observation, consumerRecords, asOf) {
  const receipt = observation.receipt || {};
  const records = Array.isArray(observation.records) ? observation.records : [];
  const usable = records.filter(admitted);
  const failures = [];
  if (receipt.status !== "ok") failures.push(receipt.reason || "acquisition_failed");
  if (!usable.length) failures.push("no_usable_records");
  if (!Array.isArray(consumerRecords)) failures.push("consumer_readback_missing");
  const sourceVintage = receipt.observed_at || null;
  return {
    source_id: sourceKey(observation),
    status: failures.length ? "open" : "pass",
    source_vintage: sourceVintage,
    record_count: usable.length,
    identities: usable.map(identity).sort(),
    consumer_record_count: Array.isArray(consumerRecords) ? consumerRecords.length : null,
    consumer_identities: Array.isArray(consumerRecords)
      ? consumerRecords.filter(admitted).map(identity).sort() : [],
    consumer_readback: Array.isArray(consumerRecords)
      && consumerRecords.filter(admitted).length === usable.length
      && consumerRecords.filter(admitted).every((record) => usable.some((row) => identity(row) === identity(record))),
    resource_use: metrics(receipt),
    failures,
    last_good_age_hours: receipt.status === "ok" ? 0 : ageHours(
      observation.last_good_observed_at, asOf,
    ),
  };
}

export function buildCommunityBoardAcquisitionParityReport({
  observations = [], consumerReadback = {}, revision = null,
  environment = "unknown", observedAt = new Date().toISOString(),
  scheduled = false, historicalBaseline = null,
} = {}) {
  const sources = observations.map((observation) => sourceResult(
    observation, consumerReadback[sourceKey(observation)] || null, observedAt,
  ));
  const vintages = new Set(sources.map((source) => source.source_vintage).filter(Boolean));
  const comparable = vintages.size === 1;
  const currentIdentities = sources.flatMap((source) => source.identities).sort();
  const currentRecordCount = currentIdentities.length;
  const historicalRecordCount = Number.isFinite(historicalBaseline?.record_count)
    ? historicalBaseline.record_count : null;
  return {
    schema: COMMUNITY_BOARD_ACQUISITION_PARITY_SCHEMA,
    revision, environment, observed_at: observedAt, scheduled,
    source_count: sources.length,
    sources,
    comparison: {
      same_vintage: comparable,
      source_vintages: [...vintages].sort(),
      // A current observation is not a historical baseline. Keep both values
      // named and scoped so a changing publisher window cannot be read as a
      // regression or recovery against an unrelated point-in-time count.
      current_record_count: currentRecordCount,
      current_unique_identities: new Set(currentIdentities).size,
      historical_record_count: historicalRecordCount,
      historical_vintage: historicalBaseline?.observed_at || null,
      count_comparison: historicalRecordCount === null ? {
        status: "not_provided",
        note: "current observation is not a historical baseline",
      } : {
        status: "context_only",
        current_record_count: currentRecordCount,
        historical_record_count: historicalRecordCount,
        delta: currentRecordCount - historicalRecordCount,
        note: "current and historical counts are distinct observations; delta is descriptive only",
      },
      total_records: currentRecordCount,
      unique_identities: new Set(currentIdentities).size,
      duplicate_identities: currentIdentities.filter((id, index, all) => all.indexOf(id) !== index),
    },
    status: sources.length > 0 && sources.every((source) => source.status === "pass")
      && sources.every((source) => source.consumer_readback)
      ? "pass" : "open",
  };
}

export function validateCommunityBoardAcquisitionParityReport(report, {
  expectedSourceCount = 7,
} = {}) {
  const errors = [];
  if (report?.schema !== COMMUNITY_BOARD_ACQUISITION_PARITY_SCHEMA) errors.push("schema");
  if (report?.source_count !== expectedSourceCount) errors.push("source_count");
  if (!report?.revision || !report?.environment || !report?.observed_at) errors.push("run_metadata");
  for (const source of report?.sources || []) {
    if (!source.source_id || source.status !== "pass") errors.push(`${source.source_id || "unknown"}:status`);
    if (!source.consumer_readback) errors.push(`${source.source_id || "unknown"}:consumer_readback`);
    for (const field of ["requests", "bytes", "duration_ms"]) {
      if (!Number.isFinite(source.resource_use?.[field])) errors.push(`${source.source_id}:resource_${field}`);
    }
  }
  if (!report?.comparison?.same_vintage) errors.push("same_vintage");
  if (report?.comparison?.count_comparison?.status === "context_only"
    && report.comparison.count_comparison.current_record_count
      !== report.comparison.current_record_count) {
    errors.push("current_count_mismatch");
  }
  if (report?.comparison?.count_comparison?.status === "context_only"
    && report.comparison.count_comparison.historical_record_count
      !== report.comparison.historical_record_count) {
    errors.push("historical_count_mismatch");
  }
  return { valid: errors.length === 0, errors };
}
