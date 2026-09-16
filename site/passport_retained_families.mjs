/**
 * Admit retained PASSPort contract-action families into a publication spine.
 *
 * Award-corroborated spine selection can omit bases, sibling revisions, and
 * newer observations. This module overlays frozen publisher rows by ctr_id so
 * the acquisition → spine → shard handoff carries complete families without
 * inventing amounts or refreshing acquisition timestamps.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { passportActionFields } from "../worker/src/lib/passport_parse.mjs";

export const RETAINED_CONTRACT_FAMILIES_PATH = new URL(
  "./data/passport_sources/retained_contract_families.json",
  import.meta.url,
);

const PUBLISHER_FIELDS = Object.freeze([
  "epin",
  "epin_norm",
  "contract_id",
  "title",
  "agency",
  "vendor",
  "program",
  "procurement_method",
  "contract_type",
  "status",
  "award_amount",
  "current_amount",
  "encumbered_amount",
  "paid_amount",
  "start_date",
  "end_date",
  "registration_date",
  "industry",
]);

function text(value) {
  const out = String(value ?? "").trim();
  return out || null;
}

function ctrKey(row = {}) {
  return text(row.ctr_id);
}

function cloneRow(row = {}) {
  return { ...row };
}

function sameMoney(left, right) {
  if (left == null && right == null) return true;
  if (left == null || right == null) return false;
  return Number(left) === Number(right);
}

function fieldChanged(prior, retained, field) {
  if (field.endsWith("_amount")) return !sameMoney(prior?.[field], retained?.[field]);
  return text(prior?.[field]) !== text(retained?.[field]);
}

function applyRetainedFields(prior, retained) {
  const next = cloneRow(prior);
  const changed = [];
  for (const field of PUBLISHER_FIELDS) {
    if (!Object.hasOwn(retained, field)) continue;
    if (!fieldChanged(prior, retained, field) && Object.hasOwn(next, field)) continue;
    if (retained[field] == null && !Object.hasOwn(prior, field)) continue;
    if (fieldChanged(prior, retained, field) || !Object.hasOwn(next, field)) {
      next[field] = retained[field];
      changed.push(field);
    }
  }
  Object.assign(next, passportActionFields(next));
  return { row: next, changed };
}

/**
 * Merge retained publisher rows into a spine passport_contracts population.
 * Missing ctr_ids are admitted; existing ctr_ids receive retained publisher
 * fields. Acquisition timestamps on the enclosing spine are left untouched.
 */
export function mergeRetainedPassportFamilies(spineRows = [], retainedRows = []) {
  const input = Array.isArray(spineRows) ? spineRows.map(cloneRow) : [];
  const retained = Array.isArray(retainedRows) ? retainedRows : [];
  const byCtr = new Map();
  for (let index = 0; index < input.length; index += 1) {
    const key = ctrKey(input[index]);
    if (key && !byCtr.has(key)) byCtr.set(key, index);
  }

  const admitted = [];
  const refreshed = [];
  const unchanged = [];
  const excluded = [];
  const replacements = [];

  for (const retainedRow of retained) {
    const key = ctrKey(retainedRow);
    if (!key) {
      excluded.push({ ctr_id: null, reason: "retained_row_missing_ctr_id" });
      continue;
    }
    if (!text(retainedRow.epin) && !text(retainedRow.epin_norm)) {
      excluded.push({ ctr_id: key, reason: "retained_row_missing_epin" });
      continue;
    }
    const prepared = {
      ...cloneRow(retainedRow),
      epin_norm: text(retainedRow.epin_norm) || text(retainedRow.epin),
      ...passportActionFields(retainedRow),
    };
    if (!byCtr.has(key)) {
      input.push(prepared);
      byCtr.set(key, input.length - 1);
      admitted.push(key);
      continue;
    }
    const index = byCtr.get(key);
    const prior = input[index];
    const { row, changed } = applyRetainedFields(prior, prepared);
    if (!changed.length) {
      unchanged.push(key);
      input[index] = { ...row };
      continue;
    }
    const priorSlice = Object.fromEntries(changed.map((field) => [field, prior[field] ?? null]));
    const retainedSlice = Object.fromEntries(changed.map((field) => [field, row[field] ?? null]));
    replacements.push({
      ctr_id: key,
      fields: changed,
      prior: priorSlice,
      retained: retainedSlice,
    });
    refreshed.push(key);
    input[index] = row;
  }

  return {
    rows: input,
    stages: {
      input_spine: Array.isArray(spineRows) ? spineRows.length : 0,
      retained_supplied: retained.length,
      admitted_missing: admitted.length,
      refreshed_existing: refreshed.length,
      unchanged_existing: unchanged.length,
      excluded: excluded.length,
      selected: input.length,
    },
    admitted_ctr_ids: admitted.sort(),
    refreshed_ctr_ids: refreshed.sort(),
    unchanged_ctr_ids: unchanged.sort(),
    excluded,
    replacements,
  };
}

export function loadRetainedContractFamilies(path = RETAINED_CONTRACT_FAMILIES_PATH) {
  const filePath = typeof path === "string" ? path : fileURLToPath(path);
  const payload = JSON.parse(readFileSync(filePath, "utf8"));
  if (!payload || payload.schema !== "cityscroll.passport_retained_contract_families.v1") {
    throw new Error("retained contract families fixture has unexpected schema");
  }
  if (!Array.isArray(payload.rows) || payload.rows.length < 1) {
    throw new Error("retained contract families fixture has no rows");
  }
  return payload;
}

/**
 * Apply the frozen retained-families fixture to a spine document in memory.
 * Preserves spine.generated_at / observed_on so an older acquisition is not
 * relabeled as a fresh publisher pull.
 */
export function applyRetainedContractFamiliesToSpine(spine, retained = loadRetainedContractFamilies()) {
  const current = Array.isArray(spine?.rows?.passport_contracts) ? spine.rows.passport_contracts : [];
  const merged = mergeRetainedPassportFamilies(current, retained.rows);
  const next = {
    ...spine,
    rows: {
      ...spine.rows,
      passport_contracts: merged.rows,
    },
    receipts: {
      ...(spine.receipts || {}),
      retained_passport_families: "site/data/passport_sources/retained_contract_families.json",
    },
  };
  return {
    spine: next,
    merge: merged,
    receipt: {
      schema: "cityscroll.passport_retained_families_merge.v1",
      review_date: retained.review_date || null,
      spine_observed_on: spine?.observed_on || null,
      spine_generated_at: spine?.generated_at || null,
      acquisition_timestamps_preserved: true,
      stages: merged.stages,
      admitted_ctr_ids: merged.admitted_ctr_ids,
      refreshed_ctr_ids: merged.refreshed_ctr_ids,
      unchanged_ctr_ids: merged.unchanged_ctr_ids,
      excluded: merged.excluded,
      replacements: merged.replacements,
    },
  };
}
