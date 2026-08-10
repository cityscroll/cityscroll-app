// Identity-aware enqueue for the carry-forward digest outbox.
//
// This module is deliberately an additive seam. It evaluates no watches and
// performs no delivery work: callers pass an already-evaluated section and
// receive the section status plus the rows that were inserted (or already
// present) in D1.

import { ruleActionKey } from "./alert_temporal.mjs";

export const SECTION_STATUS = Object.freeze({
  SUCCESS: "success",
  PARTIAL_ERROR: "partial_error",
  FAILED: "failed",
  SKIPPED: "skipped",
});

const NOTICE_LENSES = new Set(["money", "property", "meetings", "entity"]);
const INSERT_OUTBOX_ITEM = `
  INSERT INTO digest_outbox_items
    (watch_id, subscriber_id, item_id, lens, item_kind, payload_json,
     source_observed_at, first_owed_at, owed_origin, status, delivered_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'owed', NULL)
  ON CONFLICT (watch_id, item_id) DO NOTHING
`;

function text(value) {
  return value == null ? "" : String(value).trim();
}
function firstText(...values) {
  for (const value of values) {
    const clean = text(value);
    if (clean) return clean;
  }
  return "";
}

function actionKeyForRule(row) {
  const direct = firstText(
    row?.action_key,
    row?.actionKey,
    row?.rules_action_key,
    row?.rulesActionKey,
    row?.temporal_action?.action_key,
    row?.temporal_action?.actionKey,
    row?.temporal_action?.key,
  );
  if (direct) return direct;

  // evaluateSubSection currently carries temporal_action without its key. Keep
  // the semantic action identity by deriving the same key used by the temporal
  // reconciler, rather than falling back to the notice content or request id.
  const temporal = row?.temporal_action;
  const requestId = firstText(row?.request_id);
  const eventAt = firstText(temporal?.event_at).slice(0, 10);
  if (requestId && eventAt && temporal?.kind === "rules-comment-open") {
    return `temporal:rules:${requestId}:comment-open:${eventAt}`;
  }

  // Some callers retain the source-shaped rules record instead of the
  // reconciled row. This is still the canonical action policy, not a generic
  // content fingerprint.
  return firstText(ruleActionKey(row));
}

function sectionAndRow(input, maybeRow) {
  if (typeof input === "string") return { lens: input, row: maybeRow };
  if (input && typeof input === "object") {
    if (input.row && typeof input.row === "object") return { ...input, row: input.row };
    return { ...input, row: maybeRow || input.item || input.observation };
  }
  return { lens: "", row: maybeRow };
}

/**
 * Extract the stable source identity for one evaluated item.
 *
 * The returned item_id is intentionally lens-qualified where a source id is
 * otherwise too broad. There is no content-fingerprint fallback: an item with
 * no declared identity is rejected so a new lens cannot silently inherit the
 * wrong deduplication policy.
 */
export function extractLensIdentity(input, maybeRow) {
  const { lens: rawLens, row, kind } = sectionAndRow(input, maybeRow);
  const lens = text(rawLens).toLowerCase();
  if (!lens || !row || typeof row !== "object") {
    throw new TypeError("outbox item requires a lens and source row");
  }

  if (lens === "land") {
    const value = firstText(row.project_id);
    if (!value) throw new TypeError("land outbox item requires project_id");
    return { identityField: "project_id", identityValue: value, itemId: `land:${value}`, itemKind: text(kind) || "land" };
  }

  if (lens === "rules") {
    const value = actionKeyForRule(row);
    if (!value) throw new TypeError("rules outbox item requires an action key");
    return { identityField: "action_key", identityValue: value, itemId: `rules:${value}`, itemKind: text(kind) || "rules" };
  }

  if (NOTICE_LENSES.has(lens)) {
    const value = firstText(row.request_id);
    if (!value) throw new TypeError(`${lens} outbox item requires request_id`);
    return { identityField: "request_id", identityValue: value, itemId: `notice:${value}`, itemKind: text(kind) || lens };
  }

  if (lens === "district") {
    const value = firstText(row.district_item_id);
    if (!value) throw new TypeError("district outbox item requires district_item_id");
    return { identityField: "district_item_id", identityValue: value, itemId: `district:${value}`, itemKind: text(kind) || "district" };
  }

  if (lens === "people" || lens === "mandates" || lens === "obligations") {
    const value = firstText(row.alert_id);
    if (!value) throw new TypeError(`${lens} outbox item requires alert_id`);
    return { identityField: "alert_id", identityValue: value, itemId: value, itemKind: text(kind) || lens };
  }

  if (lens === "award") {
    const value = firstText(row.key, row.candidate_key, row.candidateKey);
    if (!value) throw new TypeError("award outbox item requires candidate key");
    return { identityField: "candidate_key", identityValue: value, itemId: value, itemKind: text(kind) || "award" };
  }

  throw new TypeError(`no outbox identity policy for lens: ${lens}`);
}

function explicitSectionStatus(section) {
  const value = text(section?.status || section?.section_status || section?.sectionStatus || section?.resultStatus).toLowerCase();
  if ([SECTION_STATUS.SUCCESS, "ok", "complete", "completed"].includes(value)) return SECTION_STATUS.SUCCESS;
  if ([SECTION_STATUS.PARTIAL_ERROR, "partial", "partial-error"].includes(value)) return SECTION_STATUS.PARTIAL_ERROR;
  if ([SECTION_STATUS.FAILED, "error", "failure"].includes(value)) return SECTION_STATUS.FAILED;
  if ([SECTION_STATUS.SKIPPED, "skip"].includes(value)) return SECTION_STATUS.SKIPPED;
  return null;
}

/** Classify an evaluated section without changing the live evaluator. */
export function sectionResultStatus(section) {
  const explicit = explicitSectionStatus(section);
  if (explicit) return explicit;
  if (section?.partial_error || section?.partialError || (Array.isArray(section?.errors) && section.errors.length > 0)) {
    return SECTION_STATUS.PARTIAL_ERROR;
  }
  if (section?.failed || section?.error) return SECTION_STATUS.FAILED;
  if (section?.skipped) return SECTION_STATUS.SKIPPED;
  return SECTION_STATUS.SUCCESS;
}

function sectionRows(section) {
  for (const candidate of [section?.freshRows, section?.items, section?.rows, section?.awardCandidates]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function renderSnapshot(section, row, index) {
  if (Array.isArray(section?.renderSnapshots)) return section.renderSnapshots[index] ?? row;
  if (typeof section?.renderSnapshot === "function") return section.renderSnapshot(row, index);
  if (section?.renderSnapshot && typeof section.renderSnapshot === "object") return section.renderSnapshot;
  if (row && row.render_snapshot !== undefined) return row.render_snapshot;
  if (row && row.renderSnapshot !== undefined) return row.renderSnapshot;
  if (row && row.payload !== undefined) return row.payload;
  return row;
}

function sectionId(section, ...keys) {
  return firstText(...keys.map((key) => section?.[key]), section?.watch?.[keys[0]], section?.subscription?.[keys[0]]);
}

function nowISO(value) {
  if (value instanceof Date) return value.toISOString();
  const clean = text(value);
  return clean || new Date().toISOString();
}

function insertParams(item) {
  return [
    item.watchId,
    item.subscriberId,
    item.itemId,
    item.lens,
    item.itemKind,
    item.payloadJson,
    item.sourceObservedAt,
    item.firstOwedAt,
    item.owedOrigin,
  ];
}

async function runInsert(db, params) {
  const statement = db.prepare(INSERT_OUTBOX_ITEM);
  if (typeof statement.bind === "function") return statement.bind(...params).run();
  return statement.run(...params);
}

function changesFrom(result) {
  const changes = result?.meta?.changes ?? result?.changes;
  return Number.isFinite(Number(changes)) ? Number(changes) : null;
}

function buildItem(section, row, index, options) {
  const lens = text(section?.lens || options?.lens).toLowerCase();
  const identity = extractLensIdentity({ lens, row, kind: section?.kind || options?.itemKind });
  const watchId = firstText(options?.watchId, sectionId(section, "watch_id", "watchId"));
  const subscriberId = firstText(options?.subscriberId, sectionId(section, "subscriber_id", "subscriberId"));
  if (!watchId || !subscriberId) throw new TypeError("outbox enqueue requires watchId and subscriberId");

  const payload = renderSnapshot(section, row, index);
  const payloadJson = JSON.stringify(payload);
  if (payloadJson === undefined) throw new TypeError("outbox render snapshot must be JSON-serializable");

  const observed = nowISO(options?.sourceObservedAt || section?.source_observed_at || section?.sourceObservedAt || row?.source_observed_at || row?.observed_at);
  return {
    watchId,
    subscriberId,
    itemId: identity.itemId,
    lens,
    itemKind: identity.itemKind,
    payloadJson,
    sourceObservedAt: observed,
    firstOwedAt: nowISO(options?.now || section?.now),
    owedOrigin: firstText(options?.owedOrigin, section?.owed_origin, section?.owedOrigin) || "section-evaluation",
  };
}

/**
 * Enqueue one evaluated section. Failed, partial, and skipped sections are
 * returned to the caller untouched; existing owed rows are not modified.
 */
export async function enqueueEvaluatedSection(db, section, options = {}) {
  const status = sectionResultStatus(section);
  const result = {
    status,
    section_status: status,
    attempted: 0,
    enqueued: 0,
    duplicates: 0,
    item_ids: [],
  };
  if (status !== SECTION_STATUS.SUCCESS) return result;
  if (!db?.prepare) throw new TypeError("outbox enqueue requires a D1 database");

  for (const [index, row] of sectionRows(section).entries()) {
    const item = buildItem(section, row, index, options);
    result.attempted++;
    const changes = changesFrom(await runInsert(db, insertParams(item)));
    if (changes === 0) result.duplicates++;
    else result.enqueued++;
    result.item_ids.push(item.itemId);
  }
  return result;
}

/** Enqueue a set of sections and preserve each section's delivery status. */
export async function enqueueEvaluatedSections(db, sections, options = {}) {
  const results = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    results.push(await enqueueEvaluatedSection(db, section, options));
  }
  const statuses = new Set(results.map((result) => result.status));
  const status = statuses.has(SECTION_STATUS.FAILED)
    ? SECTION_STATUS.FAILED
    : statuses.has(SECTION_STATUS.PARTIAL_ERROR)
      ? SECTION_STATUS.PARTIAL_ERROR
      : SECTION_STATUS.SUCCESS;
  return {
    status,
    sections: results,
    attempted: results.reduce((sum, result) => sum + result.attempted, 0),
    enqueued: results.reduce((sum, result) => sum + result.enqueued, 0),
    duplicates: results.reduce((sum, result) => sum + result.duplicates, 0),
  };
}
