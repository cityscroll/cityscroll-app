// Pure export of privacy-safe review actions into gold-ready cases.
// Never mutates an existing gold file. Never includes actor, email, IP, note, or session ids.

import { createHash } from "node:crypto";

export const REVIEW_ACTION_EXPORT_SCHEMA_VERSION = 1;
export const REVIEW_ACTION_EXPORT_METHOD = "review_action_export_v1";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function parseObject(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function goldSideFromRecord(record = {}) {
  const sourceSystem = clean(record.source_system);
  const nativeKey = clean(
    record.native_key
    || record.source_system_id
    || record.native_record_id?.split(":").slice(1).join(":")
    || record.source_record_id?.split(":")[1],
  );
  const displayName = clean(record.display_name || record.vendor_name);
  if (!sourceSystem || !nativeKey || !displayName) return null;
  const side = {
    source_system: sourceSystem,
    native_key: nativeKey,
    display_name: displayName,
  };
  const attrs = {};
  const pin = clean(record.pin || record.observed_fields?.pin || record.attrs?.pin);
  const epin = clean(record.epin || record.observed_fields?.epin || record.attrs?.epin);
  if (pin) attrs.pin = pin;
  if (epin) attrs.epin = epin;
  if (Object.keys(attrs).length) side.attrs = attrs;
  return side;
}

function membershipKey(left, right) {
  return [
    left.source_system,
    left.native_key,
    right.source_system,
    right.native_key,
  ].join("::");
}

function labelFromDecision(decision) {
  const cleanDecision = clean(decision).toLowerCase();
  if (cleanDecision === "same" || cleanDecision === "different") return cleanDecision;
  if (cleanDecision === "accept") return "same";
  if (cleanDecision === "reject") return "different";
  return null;
}

/**
 * Normalize one review action export input.
 * Accepts action_log rows, desk disposition events, or a combined fixture row.
 */
export function normalizeReviewActionRow(row = {}) {
  if (!row || typeof row !== "object") return null;
  const curationReceipt = row.schema_version === "cityscroll.curation-verdict.v1";
  if (curationReceipt && (
    row.reversible_effect?.operation !== "export_gold_candidate"
    || row.reversible_effect?.status !== "candidate"
  )) {
    return {
      status: "skipped",
      reason: "not_gold_candidate",
      action_id: clean(row.id) || null,
      pair_id: clean(row.target?.id) || null,
    };
  }
  const metadata = parseObject(row.metadata || row.metadata_json);
  const evidence = parseObject(row.evidence || row.evidence_json);
  const decision = labelFromDecision(
    row.decision
    || metadata.decision
    || row.action_decision,
  );
  const candidate = row.target?.gold_candidate || {};
  const left = goldSideFromRecord(row.left || evidence.left || candidate.left || {});
  const right = goldSideFromRecord(row.right || evidence.right || candidate.right || {});
  const actionId = clean(row.action_id || row.id);
  const pairId = clean(row.pair_id || row.object_id || evidence.pair_id || row.target?.id);
  const ts = clean(row.ts || row.created_at || row.reviewed_at || row.timestamp);
  if (!actionId || !pairId || !left || !right) {
    return {
      status: "skipped",
      reason: !left || !right ? "missing_sides" : "missing_ids",
      action_id: actionId || null,
      pair_id: pairId || null,
    };
  }
  if (!decision) {
    return {
      status: "skipped",
      reason: "non_exportable_decision",
      action_id: actionId,
      pair_id: pairId,
      decision: clean(row.decision || metadata.decision || "unresolved") || "unresolved",
    };
  }
  // Strip any accidental personal fields — export is product-method only.
  return {
    status: "exportable",
    action_id: actionId,
    pair_id: pairId,
    decision,
    ts: ts || null,
    method: clean(row.method || row.method_name || (curationReceipt ? "curation_verdict" : "false_split_desk"))
      || "false_split_desk",
    method_version: clean(row.method_version || (curationReceipt ? row.rule_version : "v1")) || "v1",
    left,
    right,
  };
}

/**
 * Build gold-ready cases + a promotion receipt from review actions.
 * Does not write files. Callers must promote into a new gold_vN only.
 */
export function exportReviewActionsToGoldCases(rows = [], opts = {}) {
  const goldVersion = clean(opts.goldVersion || "v-next");
  const exportedOn = clean(opts.exportedOn || new Date().toISOString().slice(0, 10));
  const seen = new Set();
  const cases = [];
  const skipped = [];

  for (const row of rows) {
    const normalized = normalizeReviewActionRow(row);
    if (!normalized || normalized.status !== "exportable") {
      skipped.push(normalized || { status: "skipped", reason: "invalid_row" });
      continue;
    }
    const key = membershipKey(normalized.left, normalized.right);
    if (seen.has(key)) {
      skipped.push({
        status: "skipped",
        reason: "duplicate_pair",
        action_id: normalized.action_id,
        pair_id: normalized.pair_id,
      });
      continue;
    }
    seen.add(key);
    const seriesLabel = goldVersion.startsWith("v") ? goldVersion : `v${goldVersion}`;
    cases.push({
      id: `g${seriesLabel}-${String(cases.length + 1).padStart(3, "0")}`,
      entity_type: "vendor",
      label: normalized.decision,
      difficulty: "hard",
      sources: [...new Set([normalized.left.source_system, normalized.right.source_system])],
      left: normalized.left,
      right: normalized.right,
      notes: `Promoted from review action ${normalized.action_id} on pair ${normalized.pair_id}; method ${normalized.method} ${normalized.method_version}.`,
      review_action_provenance: {
        action_id: normalized.action_id,
        pair_id: normalized.pair_id,
        method: normalized.method,
        method_version: normalized.method_version,
        decision: normalized.decision,
        ts: normalized.ts,
        export_method: REVIEW_ACTION_EXPORT_METHOD,
      },
    });
  }

  const payload = {
    cases,
    skipped,
    receipt: {
      kind: "review_action_gold_export",
      schema_version: REVIEW_ACTION_EXPORT_SCHEMA_VERSION,
      export_method: REVIEW_ACTION_EXPORT_METHOD,
      exported_on: exportedOn,
      gold_version_target: goldVersion,
      input_rows: rows.length,
      exportable_cases: cases.length,
      skipped_rows: skipped.length,
      skipped_reasons: skipped.reduce((acc, row) => {
        const reason = row?.reason || "unknown";
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {}),
      case_ids: cases.map((item) => item.id),
      action_ids: cases.map((item) => item.review_action_provenance.action_id),
      payload_sha256: sha256(JSON.stringify(cases)),
    },
  };
  return payload;
}

export function formatReviewActionGoldJsonl(cases = [], receipt = {}) {
  const meta = {
    _meta: true,
    kind: "review_action_gold_candidates",
    schema_version: REVIEW_ACTION_EXPORT_SCHEMA_VERSION,
    export_method: REVIEW_ACTION_EXPORT_METHOD,
    exported_on: receipt.exported_on,
    case_count: cases.length,
    payload_sha256: receipt.payload_sha256,
  };
  return `${[meta, ...cases].map((item) => JSON.stringify(item)).join("\n")}\n`;
}
