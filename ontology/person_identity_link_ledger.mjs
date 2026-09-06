/**
 * Append-only reviewed same-person identity-link ledger.
 *
 * The ledger is the production store for `person_identity_link.v1` records
 * described by `docs/adr/person-source-identity-seam.md` Layer 2. It is a
 * JSON Lines file: line 1 is an immutable header that states the ledger's own
 * rules, and every later line is one reviewed decision.
 *
 * Appending is the only write. A reviewer who changes their mind appends a new
 * record for the same pair; the earlier record stays on disk and stays
 * inspectable. Nothing in this module opens the ledger for truncation, edits a
 * stored record, or removes a line.
 *
 * Candidate and rejected records are evidence, not identity. Only a pair whose
 * most recent record is `accepted` materializes a `canonical_person_ref`, and
 * the diagnostics listing keeps the non-linking records visible instead of
 * dropping them.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERSON_IDENTITY_LINK_METHOD,
  PERSON_IDENTITY_LINK_RELATION,
  PERSON_IDENTITY_LINK_SCHEMA,
  PERSON_IDENTITY_LINK_VERSION,
  PERSON_LINK_STATUSES,
  applyAcceptedPersonLink,
  buildPersonIdentityLink,
  isPersonIdentity,
} from "./person.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const PERSON_IDENTITY_LINK_LEDGER_SCHEMA = "cityscroll.person_identity_link_ledger.v1";
export const PERSON_IDENTITY_LINK_LEDGER_VERSION = "1.0.0";
export const PERSON_IDENTITY_LINK_LEDGER_RELATIVE_PATH = "ontology/person_identity_links.jsonl";
export const PERSON_IDENTITY_LINK_LEDGER_PATH = resolve(ROOT, PERSON_IDENTITY_LINK_LEDGER_RELATIVE_PATH);

export const LEDGER_HEADER_KIND = "ledger_header";
export const LEDGER_LINK_KIND = "identity_link";

/** Statuses that never publish a canonical person reference. */
export const NON_LINKING_STATUSES = Object.freeze(["candidate", "rejected"]);

/** The rules the header states in-band so the file explains itself. */
export const PERSON_IDENTITY_LINK_LEDGER_POLICY = Object.freeze({
  append_only: true,
  decision_supersedes_by_append: true,
  method: PERSON_IDENTITY_LINK_METHOD,
  relation: PERSON_IDENTITY_LINK_RELATION,
  endpoints: "generic person identities (person:{namespace}[:{scope}]:{native_key})",
  display_name_never_identity: true,
  evidence_source_locator_required: true,
  accepted_only_canonical_person_ref: true,
  source_identity_retained_after_accepted_link: true,
});

const RECORD_ID_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

function text(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function requiredTimestamp(value, field) {
  const stamp = text(value, 80);
  if (!stamp) throw new TypeError(`${field} is required`);
  if (Number.isNaN(Date.parse(stamp))) throw new TypeError(`${field} must be an ISO timestamp`);
  return stamp;
}

function requiredRecordId(value) {
  const id = text(value, 120).toLowerCase();
  if (!RECORD_ID_PATTERN.test(id)) {
    throw new TypeError("record_id must be a lowercase dotted or hyphenated token");
  }
  return id;
}

function resolveLedgerPath(path = PERSON_IDENTITY_LINK_LEDGER_PATH) {
  return isAbsolute(path) ? path : resolve(ROOT, path);
}

/** Stable, order-free key for the unordered pair of endpoints. */
export function personIdentityPairKey(leftIdentity, rightIdentity) {
  return [text(leftIdentity, 320), text(rightIdentity, 320)].sort().join("|");
}

/** The immutable first line of a ledger file. */
export function buildPersonIdentityLinkLedgerHeader({ openedAt, note = null } = {}) {
  return Object.freeze({
    schema: PERSON_IDENTITY_LINK_LEDGER_SCHEMA,
    ledger_version: PERSON_IDENTITY_LINK_LEDGER_VERSION,
    record_kind: LEDGER_HEADER_KIND,
    link_schema: PERSON_IDENTITY_LINK_SCHEMA,
    opened_at: requiredTimestamp(openedAt, "opened_at"),
    note: text(note, 500) || null,
    policy: PERSON_IDENTITY_LINK_LEDGER_POLICY,
  });
}

/**
 * Build one storable record: a `person_identity_link.v1` link plus the review
 * bookkeeping that makes an append auditable.
 */
export function buildPersonIdentityLinkRecord({
  recordId,
  appendedAt,
  reviewer,
  reviewNote = null,
  ...linkFields
} = {}) {
  const link = buildPersonIdentityLink(linkFields);
  const reviewerName = text(reviewer, 200);
  if (!reviewerName) throw new TypeError("reviewer is required for a reviewed assertion");
  if (link.status !== "candidate" && !link.reviewed_at) {
    throw new TypeError(`a ${link.status} record requires reviewed_at`);
  }
  return Object.freeze({
    ...link,
    record_kind: LEDGER_LINK_KIND,
    record_id: requiredRecordId(recordId),
    appended_at: requiredTimestamp(appendedAt, "appended_at"),
    reviewer: reviewerName,
    review_note: text(reviewNote, 1_000) || null,
    pair_key: personIdentityPairKey(link.left_identity, link.right_identity),
  });
}

/**
 * Parse ledger text without touching the filesystem. Every line is reported,
 * including one that fails to parse, so the check can name it by line number.
 */
export function parsePersonIdentityLinkLedger(content = "") {
  const raw = String(content ?? "");
  const entries = [];
  let lineNumber = 0;
  for (const line of raw.split("\n")) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      parseError = error.message;
    }
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    entries.push(Object.freeze({
      line: lineNumber,
      raw: line,
      record,
      parse_error: parseError || (parsed !== null && !record ? "line is not a JSON object" : null),
    }));
  }
  return Object.freeze(entries);
}

/** Read a ledger file. A missing file reads as an absent ledger, not as empty. */
export function readPersonIdentityLinkLedger(path = PERSON_IDENTITY_LINK_LEDGER_PATH) {
  const resolved = resolveLedgerPath(path);
  if (!existsSync(resolved)) {
    return Object.freeze({ path: resolved, exists: false, entries: Object.freeze([]) });
  }
  return Object.freeze({
    path: resolved,
    exists: true,
    entries: parsePersonIdentityLinkLedger(readFileSync(resolved, "utf8")),
  });
}

/** Only the link records, in append order. */
export function personIdentityLinkRecords(entries = []) {
  return Object.freeze(entries
    .filter(({ record }) => record?.schema === PERSON_IDENTITY_LINK_SCHEMA)
    .map(({ record, line }) => Object.freeze({ ...record, ledger_line: line })));
}

function appendLine(resolved, value) {
  if (existsSync(resolved)) {
    const existing = readFileSync(resolved, "utf8");
    if (existing.length > 0 && !existing.endsWith("\n")) {
      throw new Error(`${resolved} does not end with a newline; refusing to append to a truncated ledger`);
    }
  } else {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  appendFileSync(resolved, `${JSON.stringify(value)}\n`, "utf8");
}

/**
 * Open a ledger by appending its header. Refuses to re-open a ledger that
 * already has lines, because a header rewrite would not be an append.
 */
export function openPersonIdentityLinkLedger({ path = PERSON_IDENTITY_LINK_LEDGER_PATH, openedAt, note = null } = {}) {
  const resolved = resolveLedgerPath(path);
  const { entries } = readPersonIdentityLinkLedger(resolved);
  if (entries.length > 0) throw new Error(`${resolved} already has a header; a ledger is opened once`);
  const header = buildPersonIdentityLinkLedgerHeader({ openedAt, note });
  appendLine(resolved, header);
  return header;
}

/**
 * Append one already-built record. The ledger keeps append order, so a record
 * may not reuse a record_id and may not be stamped before the previous line.
 */
export function appendPersonIdentityLinkRecord({ path = PERSON_IDENTITY_LINK_LEDGER_PATH, record } = {}) {
  const resolved = resolveLedgerPath(path);
  if (record?.schema !== PERSON_IDENTITY_LINK_SCHEMA) {
    throw new TypeError(`a ledger record must carry schema ${PERSON_IDENTITY_LINK_SCHEMA}`);
  }
  const { entries, exists } = readPersonIdentityLinkLedger(resolved);
  if (!exists || entries.length === 0) {
    throw new Error(`${resolved} has no header; open the ledger before appending`);
  }
  const stored = personIdentityLinkRecords(entries);
  if (stored.some(({ record_id: id }) => id === record.record_id)) {
    throw new Error(`record_id ${record.record_id} is already stored; a new decision needs a new record_id`);
  }
  const last = stored.at(-1);
  if (last && Date.parse(record.appended_at) < Date.parse(last.appended_at)) {
    throw new Error(`appended_at ${record.appended_at} precedes the last stored record ${last.appended_at}`);
  }
  appendLine(resolved, record);
  return record;
}

/** Build and append one reviewed decision in a single call. */
export function appendPersonIdentityLink({ path = PERSON_IDENTITY_LINK_LEDGER_PATH, ...fields } = {}) {
  return appendPersonIdentityLinkRecord({ path, record: buildPersonIdentityLinkRecord(fields) });
}

/**
 * The latest stored record per endpoint pair. Earlier records for the same
 * pair are superseded, never removed.
 */
export function currentPersonIdentityLinkDecisions(records = []) {
  const current = new Map();
  for (const record of records) {
    current.set(record.pair_key || personIdentityPairKey(record.left_identity, record.right_identity), record);
  }
  return current;
}

/**
 * Accepted-only materialization: identity → canonical person reference. A pair
 * whose current record is candidate or rejected contributes nothing, and an
 * accepted record that was later superseded contributes nothing either.
 */
export function materializeCanonicalPersonRefs(records = []) {
  const refs = new Map();
  for (const record of currentPersonIdentityLinkDecisions(records).values()) {
    if (record.status !== "accepted") continue;
    const canonical = record.canonical_person_ref;
    if (!canonical || !isPersonIdentity(canonical)) continue;
    refs.set(record.left_identity, canonical);
    refs.set(record.right_identity, canonical);
  }
  return refs;
}

/**
 * Apply the ledger to one person projection. Returns the projection unchanged
 * unless an accepted current record names it.
 */
export function applyPersonIdentityLinkLedger(person, records = []) {
  for (const record of currentPersonIdentityLinkDecisions(records).values()) {
    const applied = applyAcceptedPersonLink(person, record);
    if (applied !== person) return applied;
  }
  return person;
}

/**
 * Inspectable listing of every stored record. Candidate and rejected rows stay
 * in the listing as non-linking evidence and always report a null canonical
 * reference, so nothing presents them as accepted identity.
 */
export function personIdentityLinkLedgerDiagnostics(records = []) {
  const current = currentPersonIdentityLinkDecisions(records);
  const rows = records.map((record) => {
    const pairKey = record.pair_key || personIdentityPairKey(record.left_identity, record.right_identity);
    const isCurrent = current.get(pairKey) === record;
    const linking = isCurrent && record.status === "accepted" && Boolean(record.canonical_person_ref);
    return Object.freeze({
      record_id: record.record_id ?? null,
      ledger_line: record.ledger_line ?? null,
      pair_key: pairKey,
      left_identity: record.left_identity,
      right_identity: record.right_identity,
      status: record.status,
      method: record.method,
      reviewer: record.reviewer ?? null,
      reviewed_at: record.reviewed_at ?? null,
      appended_at: record.appended_at ?? null,
      evidence_refs: Object.freeze([...(record.provenance?.evidence_refs || [])]),
      current: isCurrent,
      superseded: !isCurrent,
      linking,
      canonical_person_ref: linking ? record.canonical_person_ref : null,
    });
  });
  const byStatus = (status) => Object.freeze(rows.filter((row) => row.status === status));
  return Object.freeze({
    schema: PERSON_IDENTITY_LINK_LEDGER_SCHEMA,
    total: rows.length,
    accepted: byStatus("accepted"),
    candidate: byStatus("candidate"),
    rejected: byStatus("rejected"),
    superseded: Object.freeze(rows.filter((row) => row.superseded)),
    non_linking: Object.freeze(rows.filter((row) => !row.linking)),
    materialized: Object.freeze([...materializeCanonicalPersonRefs(records)]
      .map(([identity, canonical]) => Object.freeze({ identity, canonical_person_ref: canonical }))),
    rows: Object.freeze(rows),
  });
}

function violation(line, recordId, code, message) {
  return Object.freeze({ line, record_id: recordId || null, code, message });
}

function checkHeader(entry, findings) {
  if (!entry) {
    findings.push(violation(1, null, "missing_header", "ledger has no header line"));
    return;
  }
  const { record, line } = entry;
  if (!record) {
    findings.push(violation(line, null, "unparsable_line", entry.parse_error || "line is not JSON"));
    return;
  }
  if (record.schema !== PERSON_IDENTITY_LINK_LEDGER_SCHEMA) {
    findings.push(violation(line, null, "missing_header",
      `line 1 must be the ${PERSON_IDENTITY_LINK_LEDGER_SCHEMA} header, found ${record.schema || "(no schema)"}`));
    return;
  }
  if (record.link_schema !== PERSON_IDENTITY_LINK_SCHEMA) {
    findings.push(violation(line, null, "header_link_schema",
      `header link_schema must be ${PERSON_IDENTITY_LINK_SCHEMA}, found ${record.link_schema || "(missing)"}`));
  }
  if (record.policy?.append_only !== true) {
    findings.push(violation(line, null, "header_policy", "header policy must declare append_only"));
  }
  if (record.policy?.accepted_only_canonical_person_ref !== true) {
    findings.push(violation(line, null, "header_policy",
      "header policy must declare accepted_only_canonical_person_ref"));
  }
}

function checkEndpoint(record, field, findings) {
  const value = record[field];
  if (isPersonIdentity(value)) return true;
  findings.push(violation(record.ledger_line, record.record_id, "endpoint_not_generic_person_id",
    `${field} must be a generic person identity, found ${JSON.stringify(value ?? null)}`));
  return false;
}

function checkEvidence(record, findings) {
  const evidence = record.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    findings.push(violation(record.ledger_line, record.record_id, "evidence_missing",
      "a reviewed assertion requires at least one evidence entry"));
    return;
  }
  evidence.forEach((item, index) => {
    const locator = item && typeof item === "object" && !Array.isArray(item)
      ? text(item.source_ref || item.source_record_id || item.source_url, 500)
      : "";
    if (!locator) {
      findings.push(violation(record.ledger_line, record.record_id, "evidence_source_locator_missing",
        `evidence[${index}] has no source locator`));
    }
  });
}

function checkRecord(record, seenRecordIds, previous, findings) {
  const line = record.ledger_line;
  if (record.method !== PERSON_IDENTITY_LINK_METHOD) {
    findings.push(violation(line, record.record_id, "method_not_reviewed_assertion",
      `method must be ${PERSON_IDENTITY_LINK_METHOD}, found ${record.method || "(missing)"}`));
  }
  if (record.relation !== PERSON_IDENTITY_LINK_RELATION) {
    findings.push(violation(line, record.record_id, "relation_not_same_person",
      `relation must be ${PERSON_IDENTITY_LINK_RELATION}, found ${record.relation || "(missing)"}`));
  }
  if (record.version !== PERSON_IDENTITY_LINK_VERSION) {
    findings.push(violation(line, record.record_id, "unexpected_link_version",
      `version must be ${PERSON_IDENTITY_LINK_VERSION}, found ${record.version || "(missing)"}`));
  }
  const leftOk = checkEndpoint(record, "left_identity", findings);
  const rightOk = checkEndpoint(record, "right_identity", findings);
  if (leftOk && rightOk && record.left_identity === record.right_identity) {
    findings.push(violation(line, record.record_id, "endpoints_not_distinct",
      "left_identity and right_identity name the same identity"));
  }
  checkEvidence(record, findings);

  if (!PERSON_LINK_STATUSES.includes(record.status)) {
    findings.push(violation(line, record.record_id, "invalid_status",
      `status must be one of ${PERSON_LINK_STATUSES.join(", ")}, found ${record.status || "(missing)"}`));
  } else if (record.status === "accepted") {
    if (record.canonical_person_ref && !isPersonIdentity(record.canonical_person_ref)) {
      findings.push(violation(line, record.record_id, "canonical_ref_not_generic",
        `canonical_person_ref must be a generic person identity, found ${JSON.stringify(record.canonical_person_ref)}`));
    }
  } else if (record.canonical_person_ref) {
    findings.push(violation(line, record.record_id, "canonical_ref_on_non_accepted",
      `a ${record.status} record must leave canonical_person_ref empty`));
  }
  if (record.status !== "candidate" && !record.reviewed_at) {
    findings.push(violation(line, record.record_id, "missing_reviewed_at",
      `a ${record.status || "(missing status)"} record requires reviewed_at`));
  }
  if (!text(record.reviewer, 200)) {
    findings.push(violation(line, record.record_id, "missing_reviewer",
      "a reviewed assertion requires a named reviewer"));
  }
  if (!record.record_id || !RECORD_ID_PATTERN.test(String(record.record_id))) {
    findings.push(violation(line, record.record_id, "invalid_record_id",
      `record_id must be a lowercase dotted or hyphenated token, found ${JSON.stringify(record.record_id ?? null)}`));
  } else if (seenRecordIds.has(record.record_id)) {
    findings.push(violation(line, record.record_id, "duplicate_record_id",
      `record_id ${record.record_id} is stored more than once`));
  }
  seenRecordIds.add(record.record_id);

  if (!record.appended_at || Number.isNaN(Date.parse(record.appended_at))) {
    findings.push(violation(line, record.record_id, "invalid_appended_at",
      `appended_at must be an ISO timestamp, found ${JSON.stringify(record.appended_at ?? null)}`));
  } else if (previous?.appended_at && Date.parse(record.appended_at) < Date.parse(previous.appended_at)) {
    findings.push(violation(line, record.record_id, "appended_out_of_order",
      `appended_at ${record.appended_at} precedes line ${previous.ledger_line} (${previous.appended_at})`));
  }
}

/**
 * Check every stored line. Returns one finding per violation; a clean ledger
 * (including a ledger holding only its header) returns no findings.
 */
export function checkPersonIdentityLinkLedger(entries = []) {
  const findings = [];
  const [header, ...rest] = entries;
  checkHeader(header, findings);

  const seenRecordIds = new Set();
  let previous = null;
  for (const entry of rest) {
    if (!entry.record) {
      findings.push(violation(entry.line, null, "unparsable_line", entry.parse_error || "line is not JSON"));
      continue;
    }
    if (entry.record.schema !== PERSON_IDENTITY_LINK_SCHEMA) {
      findings.push(violation(entry.line, entry.record.record_id || null, "unexpected_schema",
        `stored records must carry schema ${PERSON_IDENTITY_LINK_SCHEMA}, found ${entry.record.schema || "(missing)"}`));
      continue;
    }
    const record = { ...entry.record, ledger_line: entry.line };
    checkRecord(record, seenRecordIds, previous, findings);
    previous = record;
  }
  const sorted = findings.slice().sort((a, b) => a.line - b.line);
  return Object.freeze({
    ok: sorted.length === 0,
    checked: entries.length,
    link_records: rest.length,
    findings: Object.freeze(sorted),
  });
}

/** One line per violation, prefixed with the ledger path and line number. */
export function formatPersonIdentityLinkLedgerFindings(findings = [], label = PERSON_IDENTITY_LINK_LEDGER_RELATIVE_PATH) {
  return findings
    .map(({ line, record_id: recordId, code, message }) => [
      `${label}:${line}`,
      `[${code}]`,
      recordId ? `${recordId}:` : null,
      message,
    ].filter(Boolean).join(" "))
    .join("\n");
}
