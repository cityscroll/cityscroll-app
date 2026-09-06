/**
 * Repair-observation contract — the structured record that remains after
 * implementation diagnostics leave resident copy.
 *
 * Resident explanation and operational observability are two projections of the
 * same evidence, not one surface with a volume knob. The resident projection
 * says what a reader can and cannot learn; this projection says what an
 * operator can repair. Both read the SAME committed receipts and materialized
 * source states, so neither has to scrape the other: there is no resident
 * string parsing anywhere in this module, and no code path that puts an
 * observation on a public surface.
 *
 * Three properties carry the contract:
 *
 *  - **Closed vocabulary.** A condition is one of the ids below. Unsupported
 *    format, a failed check, an unsearched scope, and an unresolved identity
 *    are DISTINCT conditions, because they are distinct repairs.
 *  - **Stable identity.** The fingerprint digests source, scope, and condition
 *    and nothing else, so repeated observations and reworded presentation copy
 *    resolve to the same record while a different source, scope, or condition
 *    does not.
 *  - **Non-repair is a first-class answer.** An expected-empty source, a source
 *    the publisher does not publish, and two records that correctly do not
 *    correspond are all observations with a NON-repair disposition. Missingness
 *    alone never becomes an engineering defect or a claim against a publisher.
 *
 * Records are built field by field from an allowlist and then re-checked
 * against a deny-list, the same two-step the public source-health serializer
 * uses. Credentials, cookies, request headers, reporter text, and raw source
 * payloads have no field to travel in, and are rejected if one is invented.
 */

import { createHash } from "node:crypto";

export const REPAIR_OBSERVATION_SCHEMA = "cityscroll.repair_observation.v1";
export const REPAIR_OBSERVATION_SET_SCHEMA = "cityscroll.repair_observation_set.v1";

/**
 * What an observation means for work. Only `repair` describes an engineering
 * defect this repository can fix. The other two are recorded so an operator can
 * see that the state was evaluated — not so it can be queued.
 */
export const REPAIR_DISPOSITIONS = Object.freeze([
  "repair",
  "expected-absence",
  "source-policy-limitation",
]);

/**
 * The closed condition vocabulary. `detail` is operator prose about the repair,
 * never about a publisher's competence.
 */
export const REPAIR_OBSERVATION_CONDITIONS = Object.freeze({
  "source-format-unsupported": Object.freeze({
    disposition: "repair",
    detail: "No adapter contract covers the declared source format; the adapter is missing, not the record.",
  }),
  "source-retrieval-failed": Object.freeze({
    disposition: "repair",
    detail: "The source was checked and the check did not complete.",
  }),
  "source-observation-stale": Object.freeze({
    disposition: "repair",
    detail: "The retained observation is older than the source contract allows for serving.",
  }),
  "scope-not-searched": Object.freeze({
    disposition: "repair",
    detail: "A registered source in scope has not been checked in this pass.",
  }),
  "record-identity-unresolved": Object.freeze({
    disposition: "repair",
    detail: "Records were observed but the exact identity the join requires could not be resolved.",
  }),
  "checked-no-records": Object.freeze({
    disposition: "expected-absence",
    detail: "The source was checked successfully and published no matching record.",
  }),
  "records-do-not-correspond": Object.freeze({
    disposition: "expected-absence",
    detail: "Both records carry an explicit identity and the identities differ; not joining them is the correct outcome.",
  }),
  "no-counterpart-record": Object.freeze({
    disposition: "expected-absence",
    detail: "There is no counterpart record to join; the absence is the observation.",
  }),
  "source-not-published": Object.freeze({
    disposition: "source-policy-limitation",
    detail: "No source is registered for this scope and the registry forbids inferring one.",
  }),
});

export const REPAIR_OBSERVATION_CONDITION_IDS = Object.freeze(
  Object.keys(REPAIR_OBSERVATION_CONDITIONS).sort(),
);

/**
 * Materialized source-role states (tools/build_community_board_meeting_index.mjs)
 * mapped onto conditions. `indexed` is deliberately absent: a healthy role is
 * not an observation, and a record whose only content is "fine" is noise an
 * operator has to read past.
 */
const SOURCE_STATE_CONDITIONS = Object.freeze({
  "unsupported-format": "source-format-unsupported",
  unavailable: "source-retrieval-failed",
  stale: "source-observation-stale",
  "not-yet-checked": "scope-not-searched",
  "checked-empty": "checked-no-records",
});

/**
 * A role with no registered source URL is the board registry's `no_url_inference`
 * policy holding, not a check nobody ran.
 */
const UNPUBLISHED_SOURCE_REASONS = Object.freeze(["no_explicit_source_observed"]);

/**
 * Join outcomes (site/community_board_source_join.mjs) mapped onto conditions.
 * A MISMATCH between two explicit identities is a correct non-join; only a
 * MISSING or ambiguous identity is repairable.
 */
export const JOIN_REASON_CONDITIONS = Object.freeze({
  board_identity_missing: "record-identity-unresolved",
  publisher_identifier_missing: "record-identity-unresolved",
  ambiguous_source_records: "record-identity-unresolved",
  body_evidence_mismatch: "record-identity-unresolved",
  date_missing: "record-identity-unresolved",
  receipt_unavailable: "source-retrieval-failed",
  receipt_date_invalid: "source-retrieval-failed",
  source_stale: "source-observation-stale",
  board_identity_mismatch: "records-do-not-correspond",
  publisher_identifier_mismatch: "records-do-not-correspond",
  date_mismatch: "records-do-not-correspond",
  no_city_record_notice: "no-counterpart-record",
  source_record_missing: "no-counterpart-record",
});

/** Scope kinds an observation may describe. */
export const REPAIR_SCOPE_KINDS = Object.freeze([
  "community_board_source_role",
  "canonical_source",
]);

/**
 * Field names that exist ONLY in this operator projection. A public payload
 * carrying any of them has leaked the backstage record; the contract tests
 * assert their absence rather than trusting a renderer to stay disciplined.
 *
 * `evidence.receipt_ref` is deliberately not listed. The record carries it, but
 * the board inventory's existing public machine channel already publishes a
 * field of that name, so it cannot tell a leak from committed public data —
 * and a token that cannot discriminate makes the check worse, not stricter.
 */
export const REPAIR_OBSERVATION_OPERATOR_FIELDS = Object.freeze([
  "repair_observations",
  "repair_observation",
  "fingerprint",
  "disposition",
  "detail_code",
  "first_observed_at",
  "last_observed_at",
  "observation_count",
  "code_revision",
  "evidence_locator",
  "receipt_status",
  "affected_record_count",
]);

/**
 * Second safety net over the constructed record. Anything shaped like a
 * credential, a cookie, a request header, reporter prose, or a retained source
 * payload is rejected even if a future caller adds a field for it.
 */
// `body_id` is this domain's civic-body identifier, not an HTTP body, so the
// response-payload rule names its shapes exactly instead of banning the word.
const DENIED_FIELD = /(?:^|_)(?:auth|authorization|bearer|cookie|credential|header|headers|html|note|notes|password|payload|raw|reporter|secret|session|snapshot|token)(?:_|$)|(?:^|_)(?:request|response|source|raw)_body(?:_|$)|(?:^|_)body$/i;
// A fingerprint is legitimately 64 hex characters, so a bare hex-digest rule
// would reject every valid record. Match credential SHAPES instead.
const CREDENTIAL_SHAPED_VALUE = /(?:\b[A-Z][A-Z0-9]{2,}_(?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD)\b|\bBearer\s+\S|\b(?:Set-)?Cookie:|\bAuthorization:)/i;

const MAX_TEXT = 240;
const MAX_EXAMPLES = 3;
const UNIT_SEPARATOR = "\u001f";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function clean(value, max = MAX_TEXT) {
  if (value == null) return null;
  const out = String(value).replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return out ? out.slice(0, max) : null;
}

function instant(value) {
  const text = clean(value, 40);
  if (!text || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(text)) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function byFingerprint(left, right) {
  return left.fingerprint < right.fingerprint ? -1 : left.fingerprint > right.fingerprint ? 1 : 0;
}

/**
 * The stable identity. Source, scope, and condition only: a second observation
 * of the same problem, or a reworded resident sentence about it, resolves to
 * this same value, while a different source, scope, or condition does not.
 */
export function repairObservationFingerprint({
  source_contract_id = "",
  source_id = "",
  scope_kind = "",
  scope_id = "",
  condition = "",
} = {}) {
  return sha256([
    REPAIR_OBSERVATION_SCHEMA,
    clean(source_contract_id) || "",
    clean(source_id) || "",
    clean(scope_kind) || "",
    clean(scope_id) || "",
    clean(condition) || "",
  ].join(UNIT_SEPARATOR));
}

/**
 * A deterministic revision for the code that produced a condition. Digesting
 * the owning sources means the value moves when the adapter or join changes and
 * stays put when an unrelated file does — which is what an operator comparing
 * two passes actually wants to know.
 */
export function repairCodeRevision(sources = []) {
  const rows = (Array.isArray(sources) ? sources : [])
    .map((row) => ({ path: clean(row?.path, 300), text: typeof row?.text === "string" ? row.text : "" }))
    .filter((row) => row.path)
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (!rows.length) return null;
  return sha256(rows.map((row) => `${row.path}${UNIT_SEPARATOR}${sha256(row.text)}`).join("\n")).slice(0, 16);
}

function conditionEntry(id) {
  const entry = REPAIR_OBSERVATION_CONDITIONS[id];
  if (!entry) throw new Error(`unknown repair condition: ${id}`);
  return entry;
}

/**
 * Build one record from an explicit allowlist. Every field is named here, so a
 * caller cannot widen the shape by passing extra keys.
 */
export function buildRepairObservation(input = {}) {
  const condition = clean(input.condition, 80);
  const entry = conditionEntry(condition);
  const scopeKind = clean(input.scope_kind, 80);
  if (!REPAIR_SCOPE_KINDS.includes(scopeKind)) throw new Error(`unknown repair scope kind: ${scopeKind}`);
  const sourceContractId = clean(input.source_contract_id, 120);
  const sourceId = clean(input.source_id, 200);
  const scopeId = clean(input.scope_id, 200);
  const observedAt = instant(input.observed_at);
  const observation = {
    schema: REPAIR_OBSERVATION_SCHEMA,
    fingerprint: repairObservationFingerprint({
      source_contract_id: sourceContractId,
      source_id: sourceId,
      scope_kind: scopeKind,
      scope_id: scopeId,
      condition,
    }),
    source: {
      contract_id: sourceContractId,
      id: sourceId,
      adapter: clean(input.adapter, 80),
      origin_url: clean(input.origin_url, 500),
    },
    scope: {
      kind: scopeKind,
      id: scopeId,
      body_id: clean(input.body_id, 100),
      role: clean(input.role, 80),
      affected_record_count: Number.isInteger(input.affected_record_count) ? input.affected_record_count : 0,
    },
    condition: {
      id: condition,
      disposition: entry.disposition,
      detail_code: clean(input.detail_code, 120),
      detail: entry.detail,
    },
    owner: {
      source_contract_id: sourceContractId,
      publisher: clean(input.publisher, 240),
      code_paths: [...new Set((Array.isArray(input.code_paths) ? input.code_paths : [])
        .map((path) => clean(path, 300))
        .filter(Boolean))].sort(),
    },
    first_observed_at: observedAt,
    last_observed_at: observedAt,
    observation_count: 1,
    revision: {
      source_vintage: instant(input.source_vintage),
      code_revision: clean(input.code_revision, 80),
    },
    evidence: {
      locator: clean(input.evidence_locator, 400),
      receipt_ref: clean(input.receipt_ref, 400),
      receipt_status: clean(input.receipt_status, 40),
      fetch_status: clean(input.fetch_status, 40),
      examples: (Array.isArray(input.evidence_examples) ? input.evidence_examples : [])
        .map((row) => clean(row, 300))
        .filter(Boolean)
        .slice(0, MAX_EXAMPLES),
    },
  };
  const findings = validateRepairObservation(observation);
  if (findings.length) throw new Error(`repair observation rejected: ${findings.join("; ")}`);
  return Object.freeze(observation);
}

function walk(value, path, visit) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, visit));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      visit(key, item, at);
      walk(item, at, visit);
    }
  }
}

/** The deny-list net. Returns a finding per violation; empty means clean. */
export function validateRepairObservation(observation) {
  const findings = [];
  if (observation?.schema !== REPAIR_OBSERVATION_SCHEMA) findings.push("schema is not the repair-observation schema");
  if (!/^[a-f0-9]{64}$/.test(String(observation?.fingerprint || ""))) findings.push("fingerprint is not a sha256 digest");
  if (!REPAIR_DISPOSITIONS.includes(observation?.condition?.disposition)) findings.push("disposition is outside the closed vocabulary");
  if (!REPAIR_OBSERVATION_CONDITION_IDS.includes(observation?.condition?.id)) findings.push("condition is outside the closed vocabulary");
  if (!REPAIR_SCOPE_KINDS.includes(observation?.scope?.kind)) findings.push("scope kind is outside the closed vocabulary");
  if (!observation?.source?.contract_id) findings.push("source contract id is required");
  if (!observation?.source?.id) findings.push("source id is required");
  if (!observation?.scope?.id) findings.push("scope id is required");
  if (!observation?.evidence?.locator) findings.push("evidence locator is required");
  walk(observation, "", (key, value, at) => {
    if (DENIED_FIELD.test(key)) findings.push(`denied field ${at}`);
    if (typeof value === "string" && CREDENTIAL_SHAPED_VALUE.test(value)) findings.push(`credential-shaped value at ${at}`);
  });
  return findings;
}

/**
 * Fold a new pass into the retained set. A repeated observation keeps its first
 * sighting and advances its last, so an operator sees persistence rather than a
 * fresh row per pass; a fingerprint absent from the new pass is retained and
 * marked resolved rather than deleted.
 */
export function mergeRepairObservations(previous = [], next = [], { observedAt = null, monitoringAvailable = true } = {}) {
  const at = instant(observedAt);
  const rows = new Map();
  const resolveAbsent = monitoringAvailable !== false;
  for (const row of Array.isArray(previous) ? previous : []) {
    if (row?.fingerprint) rows.set(row.fingerprint, { ...row, resolved: resolveAbsent });
  }
  for (const row of Array.isArray(next) ? next : []) {
    if (!row?.fingerprint) continue;
    const prior = rows.get(row.fingerprint);
    if (!prior) {
      rows.set(row.fingerprint, { ...row, resolved: false });
      continue;
    }
    const first = [prior.first_observed_at, row.first_observed_at].filter(Boolean).sort()[0] || null;
    const last = [prior.last_observed_at, row.last_observed_at, at].filter(Boolean).sort().at(-1) || null;
    rows.set(row.fingerprint, {
      ...row,
      first_observed_at: first,
      last_observed_at: last,
      observation_count: (Number.isInteger(prior.observation_count) ? prior.observation_count : 0)
        + (Number.isInteger(row.observation_count) ? row.observation_count : 1),
      resolved: false,
    });
  }
  return [...rows.values()].sort(byFingerprint);
}

/** Only repairable conditions are engineering work. */
export function repairWorkObservations(observations = []) {
  return (Array.isArray(observations) ? observations : [])
    .filter((row) => row?.condition?.disposition === "repair");
}

/**
 * Group repeated symptoms so one adapter failure across many boards reads as
 * one repair with an affected-scope count rather than one row per board.
 */
export function groupRepairObservations(observations = []) {
  const groups = new Map();
  for (const row of Array.isArray(observations) ? observations : []) {
    if (!row?.condition?.id) continue;
    const key = [row.source?.contract_id || "", row.condition.id, row.source?.adapter || ""].join(UNIT_SEPARATOR);
    const group = groups.get(key) || {
      source_contract_id: row.source?.contract_id || null,
      condition: row.condition.id,
      disposition: row.condition.disposition,
      adapter: row.source?.adapter || null,
      affected_scopes: 0,
      fingerprints: [],
    };
    group.affected_scopes += 1;
    group.fingerprints.push(row.fingerprint);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, fingerprints: group.fingerprints.slice().sort() }))
    .sort((left, right) => (
      right.affected_scopes - left.affected_scopes
      || (left.condition < right.condition ? -1 : left.condition > right.condition ? 1 : 0)
      || (String(left.adapter) < String(right.adapter) ? -1 : String(left.adapter) > String(right.adapter) ? 1 : 0)
    ));
}

/**
 * Contract check for the other direction: does a PUBLIC payload carry anything
 * from this projection? Scans for the operator field names, the condition and
 * disposition vocabulary, and the fingerprints themselves. Every token here is
 * a machine identifier with no reason to appear in resident copy, so a hit is a
 * leak rather than a coincidence.
 */
export function repairObservationLeakFindings(payload, { label = "public payload", observations = [] } = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  const findings = [];
  const seen = new Set();
  const flag = (kind, token) => {
    const key = `${kind}${UNIT_SEPARATOR}${token}`;
    if (seen.has(key) || !text.includes(token)) return;
    seen.add(key);
    findings.push({ label, kind, token });
  };
  for (const field of REPAIR_OBSERVATION_OPERATOR_FIELDS) flag("operator-field", field);
  for (const condition of REPAIR_OBSERVATION_CONDITION_IDS) flag("condition", condition);
  for (const disposition of REPAIR_DISPOSITIONS) flag("disposition", disposition);
  for (const schema of [REPAIR_OBSERVATION_SCHEMA, REPAIR_OBSERVATION_SET_SCHEMA]) flag("schema", schema);
  for (const row of Array.isArray(observations) ? observations : []) {
    if (row?.fingerprint) flag("fingerprint", row.fingerprint);
  }
  return findings;
}

function unpublishedSource(receipt) {
  return UNPUBLISHED_SOURCE_REASONS.includes(String(receipt?.state_reason || ""))
    || (!receipt?.source_url && receipt?.state === "not-yet-checked");
}

/**
 * Project the retained community-board source receipts and materialized source
 * states onto repair observations.
 *
 * Inputs are the artifacts that already exist: the meeting index's per-role
 * receipts, the board inventory (for the publisher and its verification receipt
 * reference), and the source-contract registry (for the owner and the code
 * references). Nothing here reads a rendered page.
 */
export function buildCommunityBoardRepairObservations({
  index = {},
  inventory = {},
  contract = {},
  codeRevision = null,
  indexPath = "site/data/community_board_meeting_index.json",
} = {}) {
  const inventoryByScope = new Map();
  for (const board of Array.isArray(inventory?.boards) ? inventory.boards : []) {
    for (const [role, source] of [["upcoming_meetings", board?.upcoming], ["minutes", board?.minutes]]) {
      inventoryByScope.set(`${board?.id}:${role}`, {
        publisher: source?.publisher || null,
        receipt_ref: source?.verification?.receipt_ref || null,
      });
    }
  }
  const codePaths = (contract?.code_references || []).map((row) => row?.path).filter(Boolean);
  const receipts = Array.isArray(index?.receipts) ? index.receipts : [];
  const observations = [];
  receipts.forEach((receipt, position) => {
    const scopeId = `${receipt?.board_id}:${receipt?.role}`;
    const state = String(receipt?.state || "");
    const condition = unpublishedSource(receipt) ? "source-not-published" : SOURCE_STATE_CONDITIONS[state];
    if (!condition) return;
    const inventoryRow = inventoryByScope.get(scopeId) || {};
    observations.push(buildRepairObservation({
      condition,
      detail_code: receipt?.state_reason || state || null,
      source_contract_id: contract?.id || null,
      source_id: scopeId,
      adapter: receipt?.adapter || null,
      origin_url: receipt?.source_url || null,
      scope_kind: "community_board_source_role",
      scope_id: scopeId,
      body_id: receipt?.board_id || null,
      role: receipt?.role || null,
      affected_record_count: Number.isInteger(receipt?.materialized_record_count) ? receipt.materialized_record_count : 0,
      publisher: inventoryRow.publisher,
      code_paths: codePaths,
      observed_at: index?.generated_at,
      source_vintage: index?.generated_at,
      code_revision: codeRevision,
      evidence_locator: `${indexPath}#/receipts/${position}`,
      receipt_ref: inventoryRow.receipt_ref,
      receipt_status: receipt?.observed_receipt?.status || null,
      fetch_status: receipt?.observed_receipt?.fetch_status || null,
    }));
  });
  return observations.sort(byFingerprint);
}

/**
 * Project join outcomes onto observations at the same (body, role) scope the
 * source receipts use, so a rolling set of meetings does not churn identities.
 * A join that failed because two explicit identities differ is recorded as a
 * correct non-correspondence, not as a defect.
 */
export function buildJoinRepairObservations({
  joins = [],
  contract = {},
  role = "upcoming_meetings",
  observedAt = null,
  sourceVintage = null,
  codeRevision = null,
  evidenceLocator = "site/community_board_source_join.mjs",
} = {}) {
  const byScope = new Map();
  for (const join of Array.isArray(joins) ? joins : []) {
    if (join?.official) continue;
    const condition = JOIN_REASON_CONDITIONS[String(join?.reason || join?.join?.reason || "")];
    if (!condition) continue;
    const bodyId = join?.board_id || null;
    if (!bodyId) continue;
    const scopeId = `${bodyId}:${role}`;
    const key = `${scopeId}${UNIT_SEPARATOR}${condition}`;
    const group = byScope.get(key)
      || { scopeId, bodyId, condition, count: 0, examples: [], detail_code: join?.reason || null };
    group.count += 1;
    const example = join?.source_record_id || join?.source_url || null;
    if (example && group.examples.length < MAX_EXAMPLES) group.examples.push(example);
    byScope.set(key, group);
  }
  const codePaths = (contract?.code_references || []).map((row) => row?.path).filter(Boolean);
  return [...byScope.values()].map((group) => buildRepairObservation({
    condition: group.condition,
    detail_code: group.detail_code,
    source_contract_id: contract?.id || null,
    source_id: group.scopeId,
    scope_kind: "community_board_source_role",
    scope_id: group.scopeId,
    body_id: group.bodyId,
    role,
    affected_record_count: group.count,
    code_paths: codePaths,
    observed_at: observedAt,
    source_vintage: sourceVintage,
    code_revision: codeRevision,
    evidence_locator: evidenceLocator,
    evidence_examples: group.examples,
  })).sort(byFingerprint);
}

/**
 * Project source-health findings onto the existing repair identity. Missing
 * monitoring is not a successful recheck and never appears here as a resolving
 * pass — callers pass monitoringAvailable=false into mergeRepairObservations.
 */
export function buildHealthRepairObservations({
  observations = [],
  contracts = [],
  observedAt = null,
  codeRevision = null,
  evidenceLocator = "site/data/source_health_observations.json",
} = {}) {
  const byId = new Map((contracts || []).map((row) => [row.id, row]));
  const rows = [];
  observations.forEach((observation, position) => {
    const sourceId = observation?.source_id;
    if (!sourceId) return;
    const contract = byId.get(sourceId) || { id: sourceId, code_references: [] };
    const locator = `${evidenceLocator}#/observations/${position}`;
    const acquisitionFailed = ["failed", "held"].includes(observation?.acquisition_status)
      || (observation?.health?.reason_codes || []).includes("acquisition-failed")
      || observation?.health?.status === "Source-unavailable"
        && (observation?.operator?.runs || []).some((run) => run.status === "failed");
    const unsearched = !observation?.health?.clocks?.cityscroll_checked_acquired?.at
      && observation?.acquisition_status !== "succeeded"
      && observation?.check_status !== "succeeded";
    const staleServing = observation?.health?.status === "Degraded"
      && (observation?.health?.reason_codes || []).some((code) => /serving|stale/i.test(code));
    const conditions = [];
    if (acquisitionFailed) conditions.push("source-retrieval-failed");
    else if (unsearched) conditions.push("scope-not-searched");
    if (staleServing) conditions.push("source-observation-stale");
    for (const condition of conditions) {
      rows.push(buildRepairObservation({
        condition,
        source_contract_id: contract.id,
        source_id: sourceId,
        adapter: observation?.operator?.runs?.[0]?.adapter || "source-health",
        scope_kind: "canonical_source",
        scope_id: sourceId,
        code_paths: (contract.code_references || []).map((row) => row.path).filter(Boolean),
        observed_at: observedAt || observation?.freshness_watchdog?.observed_at,
        code_revision: codeRevision,
        evidence_locator: locator,
        receipt_status: observation?.acquisition_status || null,
      }));
    }
  });
  return rows.sort(byFingerprint);
}

/** Wrap a pass in its set envelope for the private consumer. */
export function repairObservationSet(observations = [], { observedAt = null, sourceVintage = null } = {}) {
  const rows = (Array.isArray(observations) ? observations : []).slice().sort(byFingerprint);
  const counts = { total: rows.length };
  for (const disposition of REPAIR_DISPOSITIONS) {
    counts[disposition] = rows.filter((row) => row?.condition?.disposition === disposition).length;
  }
  return {
    schema: REPAIR_OBSERVATION_SET_SCHEMA,
    observation_schema: REPAIR_OBSERVATION_SCHEMA,
    visibility: "private",
    consumer: "authenticated desk",
    observed_at: instant(observedAt),
    source_vintage: instant(sourceVintage),
    conditions: REPAIR_OBSERVATION_CONDITION_IDS,
    dispositions: REPAIR_DISPOSITIONS,
    counts,
    groups: groupRepairObservations(rows),
    observations: rows,
  };
}
