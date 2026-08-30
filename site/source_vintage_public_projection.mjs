// Public source-vintage serialization and idempotent finding keys.
// Semantic coverage is independent of the three ingestion-health clocks.

export const SOURCE_VINTAGE_FINDING_SCHEMA = "cityscroll.source_vintage_finding.v1";
export const PUBLIC_SOURCE_VINTAGE_STATUSES = Object.freeze([
  "current",
  "ingestion-stale",
  "source-vintage-stale",
  "unknown",
]);

const PUBLIC_RELATIONS = new Set([
  "same-measure-newer",
  "newer-official-context",
  "alternate-format",
]);

function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function validInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value.trim())) return null;
  const text = value.trim();
  const epoch = Date.parse(
    /T/.test(text) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? `${text}Z` : text,
  );
  if (!Number.isFinite(epoch) || new Date(epoch).getUTCFullYear() <= 1970) return null;
  return new Date(epoch).toISOString();
}

function validFiscalYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
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

function publicCoverage(coverage) {
  const fiscalYear = validFiscalYear(coverage?.max_fiscal_year);
  const date = validInstant(coverage?.max_date);
  if (fiscalYear && date) {
    return { max_fiscal_year: null, max_date: null };
  }
  return {
    max_fiscal_year: fiscalYear,
    max_date: date,
  };
}

function frontierToken(frontier) {
  if (frontier?.kind === "fiscal_year" && validFiscalYear(frontier.value) !== null) {
    return `fiscal_year:${frontier.value}`;
  }
  if (frontier?.kind === "date" && validInstant(frontier.value)) {
    return `date:${validInstant(frontier.value)}`;
  }
  const coverage = publicCoverage(frontier);
  if (coverage.max_fiscal_year !== null) return `fiscal_year:${coverage.max_fiscal_year}`;
  if (coverage.max_date) return `date:${coverage.max_date}`;
  return "unknown";
}

export function unknownPublicSourceVintage() {
  return {
    observed_coverage: { max_fiscal_year: null, max_date: null },
    publisher_vintage: null,
    retrieved_at: null,
    expected_lag_tolerance_days: null,
    current_lag: { value: null, unit: null },
    status: "unknown",
    newer_source: null,
  };
}

function publicCurrentLag(classification) {
  const observed = classification?.observed_frontier;
  const newer = classification?.alternates?.[0]?.frontier;
  if (classification?.status !== "source-vintage-stale") {
    return { value: null, unit: null };
  }
  if (observed?.kind === "fiscal_year" && newer?.kind === "fiscal_year") {
    const delta = Number(newer.value) - Number(observed.value);
    return Number.isFinite(delta) && delta > 0
      ? { value: delta, unit: "fiscal_years" }
      : { value: null, unit: null };
  }
  if (observed?.kind === "date" && newer?.kind === "date") {
    const deltaMs = Date.parse(newer.value) - Date.parse(observed.value);
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return { value: null, unit: null };
    return { value: Math.round(deltaMs / 86_400_000), unit: "days" };
  }
  return { value: null, unit: null };
}

function publicNewerSource(classification, alternate) {
  if (classification?.status !== "source-vintage-stale") return null;
  const id = clean(classification.alternate_source_id || alternate?.alternate_id);
  const url = safeOfficialUrl(alternate?.url);
  const artifactUrl = safeOfficialUrl(alternate?.artifact_url);
  const relation = PUBLIC_RELATIONS.has(alternate?.relation || classification?.alternates?.[0]?.relation)
    ? (alternate?.relation || classification.alternates[0].relation)
    : null;
  if (!id || !url || !relation) return null;
  const coverage = publicCoverage(alternate?.observed_coverage || classification.alternates?.[0]?.frontier);
  return {
    alternate_id: id,
    publisher: clean(alternate?.publisher || alternate?.publisher_name) || null,
    url,
    artifact_url: artifactUrl,
    relation,
    replacement_eligible: classification.replacement_source_ids?.includes(id) === true,
    observed_coverage: coverage,
    publisher_vintage: clean(alternate?.publisher_vintage) || null,
    scope_note: clean(alternate?.semantic_scope) || null,
  };
}

/**
 * Closed public vintage object. Receipts, consumer ids, and internal paths stay off.
 */
export function publicSourceVintage({
  observation = null,
  classification = null,
  alternate = null,
} = {}) {
  const coverage = publicCoverage(observation?.observed_coverage);
  const hasFrontier = coverage.max_fiscal_year !== null || coverage.max_date !== null;
  const classified = PUBLIC_SOURCE_VINTAGE_STATUSES.includes(classification?.status)
    ? classification.status
    : "unknown";
  const status = hasFrontier ? classified : "unknown";
  return {
    observed_coverage: coverage,
    publisher_vintage: clean(observation?.publisher_vintage) || null,
    retrieved_at: validInstant(observation?.cityscroll_retrieval?.retrieved_at || classification?.retrieval?.retrieved_at),
    expected_lag_tolerance_days: finiteNonNegative(
      observation?.expected_lag_tolerance_days ?? classification?.retrieval?.expected_lag_tolerance_days,
    ),
    current_lag: publicCurrentLag({ ...classification, status }),
    status,
    newer_source: publicNewerSource({ ...classification, status }, alternate),
  };
}

export function sourceVintageFindingKey({ source_id, alternate_id, frontier } = {}) {
  const sourceId = clean(source_id);
  const alternateId = clean(alternate_id);
  if (!sourceId || !alternateId) return null;
  return `${sourceId}::${alternateId}::${frontierToken(frontier)}`;
}

export function sourceVintageFindingIntent({
  source_id,
  alternate_id,
  frontier,
  evidence = null,
} = {}) {
  const finding_key = sourceVintageFindingKey({ source_id, alternate_id, frontier });
  if (!finding_key) return null;
  const publicEvidence = {
    observed_coverage: publicCoverage(evidence?.observed_coverage),
    publisher_vintage: clean(evidence?.publisher_vintage) || null,
    retrieved_at: validInstant(evidence?.retrieved_at),
    alternate_url: safeOfficialUrl(evidence?.alternate_url),
    evidence_at: validInstant(evidence?.evidence_at),
  };
  return {
    schema: SOURCE_VINTAGE_FINDING_SCHEMA,
    finding_key,
    source_id: clean(source_id),
    alternate_id: clean(alternate_id),
    frontier: {
      kind: frontier?.kind || null,
      value: frontier?.kind === "fiscal_year"
        ? validFiscalYear(frontier.value)
        : (validInstant(frontier?.value) || frontier?.value || null),
    },
    diagnosis: "source-vintage-stale",
    evidence: publicEvidence,
    card_intent: {
      id: `source-vintage-stale:${finding_key}`,
      kind: "source-vintage-stale",
    },
  };
}

export function collectSourceVintageFindings(intents) {
  const byKey = new Map();
  for (const intent of Array.isArray(intents) ? intents : []) {
    if (!intent?.finding_key || intent.diagnosis !== "source-vintage-stale") continue;
    if (!byKey.has(intent.finding_key)) byKey.set(intent.finding_key, intent);
  }
  return [...byKey.values()].sort((left, right) => left.finding_key.localeCompare(right.finding_key));
}

export function findingsFromVintageClassifications(classifications, {
  observationsById = new Map(),
  alternatesById = new Map(),
} = {}) {
  const intents = [];
  for (const row of Array.isArray(classifications) ? classifications : []) {
    if (row?.status !== "source-vintage-stale") continue;
    const observation = observationsById.get(row.source_id) || null;
    for (const alternate of row.alternates || []) {
      const record = alternatesById.get(alternate.alternate_source_id) || null;
      intents.push(sourceVintageFindingIntent({
        source_id: row.source_id,
        alternate_id: alternate.alternate_source_id,
        frontier: alternate.frontier,
        evidence: {
          observed_coverage: observation?.observed_coverage,
          publisher_vintage: observation?.publisher_vintage,
          retrieved_at: observation?.cityscroll_retrieval?.retrieved_at,
          alternate_url: record?.url,
          evidence_at: record?.evidence_at || record?.evidence_timestamp,
        },
      }));
    }
  }
  return collectSourceVintageFindings(intents);
}

export function unknownBackstageSourceVintage() {
  return {
    status: "unknown",
    ingestion_stale: null,
    observed_coverage: {
      max_fiscal_year: null,
      max_date: null,
      fiscal_year_count: null,
      row_count: null,
      basis: null,
    },
    publisher_vintage: null,
    publisher_vintage_basis: null,
    retrieved_at: null,
    retrieval: {
      status: "unknown",
      retrieved_at: null,
      receipt_ref: null,
      receipt_schema: null,
      run_id: null,
    },
    expected_lag_tolerance_days: null,
    current_lag: { value: null, unit: null, basis: null },
    downstream_consumer_ids: [],
    newer_alternates: [],
    findings: [],
  };
}

export function backstageSourceVintage({
  observation = null,
  classification = null,
  alternate = null,
  findings = [],
} = {}) {
  const publicSlice = publicSourceVintage({ observation, classification, alternate });
  const retrieval = observation?.cityscroll_retrieval || {};
  return {
    status: publicSlice.status,
    ingestion_stale: typeof classification?.ingestion_stale === "boolean"
      ? classification.ingestion_stale
      : null,
    ingestion_status: classification?.ingestion_status || null,
    observed_coverage: observation?.observed_coverage || unknownBackstageSourceVintage().observed_coverage,
    publisher_vintage: observation?.publisher_vintage ?? null,
    publisher_vintage_basis: observation?.publisher_vintage_basis ?? null,
    retrieved_at: publicSlice.retrieved_at,
    retrieval: {
      status: retrieval.status || "unknown",
      retrieved_at: validInstant(retrieval.retrieved_at),
      receipt_ref: clean(retrieval.receipt_ref) || null,
      receipt_schema: clean(retrieval.receipt_schema) || null,
      run_id: clean(retrieval.run_id) || null,
    },
    expected_lag_tolerance_days: publicSlice.expected_lag_tolerance_days,
    current_lag: {
      ...publicSlice.current_lag,
      basis: observation?.current_lag?.basis || (publicSlice.current_lag.value !== null ? "alternate_frontier_delta" : null),
    },
    downstream_consumer_ids: Array.isArray(observation?.downstream_consumer_ids)
      ? [...observation.downstream_consumer_ids]
      : [],
    newer_alternates: (classification?.alternates || []).map((row) => ({
      alternate_id: row.alternate_source_id,
      relation: row.relation,
      frontier: row.frontier,
      replacement_eligible: row.replacement_eligible === true,
      url: alternate?.alternate_id === row.alternate_source_id ? safeOfficialUrl(alternate.url) : null,
      artifact_url: alternate?.alternate_id === row.alternate_source_id
        ? safeOfficialUrl(alternate.artifact_url)
        : null,
      replacement_warning: alternate?.alternate_id === row.alternate_source_id
        ? (clean(alternate.replacement_warning) || null)
        : null,
    })),
    findings,
  };
}
