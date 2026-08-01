// Immutable Checkbook Contracts observations for entity-resolution replay.
// Request-time XML rows are retained when dual-write is enabled; lifecycle
// assembly still collapses Prime/Sub Vendor slices for stage classification.
// Shadow only: public lifecycle reads do not consume these rows.

import {
  computeSourceRecordHash,
  SOURCE_RECORD_INSERT_SQL,
  sourceRecordDualWriteEnabled,
} from "./source_records.mjs";

export const CHECKBOOK_SOURCE_RECORD_DUAL_WRITE_FLAG = "CHECKBOOK_SOURCE_RECORD_DUAL_WRITE";
export const CHECKBOOK_CONTRACTS_SOURCE_SYSTEM = "checkbook_contracts";

function normPart(value, fallback = "unknown") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

/**
 * Publisher-stable identity for one Checkbook Contracts domain row.
 * Preserves Prime Vendor vs Sub Vendor (and other) slices under the same
 * prime_contract_id so multi-row identity is not collapsed away.
 *
 * Shape: contract:<status>:<prime_contract_id>:<vendor>:<vendor_record_type>:<anchor_date>
 */
export function checkbookContractSourceSystemId(row) {
  const status = normPart(row?.status, "contracts").toLowerCase();
  const id = normPart(row?.id, "no-contract-id");
  const vendor = normPart(row?.vendor, "no-vendor").toUpperCase();
  const vrt = normPart(row?.vendorRecordType, "row")
    .toLowerCase()
    .replace(/\s+/g, "-");
  const when = normPart(
    row?.received || row?.registered || row?.start || row?.end,
    "nodate",
  );
  return `contract:${status}:${id}:${vendor}:${vrt}:${when}`;
}

/**
 * Fail-soft dual-write of raw Checkbook Contracts rows into source_records.
 * Never throws; never blocks lifecycle assembly when the observation path fails.
 */
export async function dualWriteCheckbookContractObservations(env, rows, ingestedAt) {
  if (!sourceRecordDualWriteEnabled(env, CHECKBOOK_SOURCE_RECORD_DUAL_WRITE_FLAG)) {
    return { written: 0, skipped: "flag-off" };
  }
  if (!env?.DB) return { written: 0, skipped: "no-db" };
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return { written: 0, skipped: "empty" };

  let insert;
  try {
    insert = env.DB.prepare(SOURCE_RECORD_INSERT_SQL);
  } catch {
    return { written: 0, skipped: "no-schema" };
  }

  const at = ingestedAt || new Date().toISOString();
  try {
    const stmts = await Promise.all(list.map(async (row) => {
      const snapshot = { ...row };
      return insert.bind(
        CHECKBOOK_CONTRACTS_SOURCE_SYSTEM,
        checkbookContractSourceSystemId(row),
        await computeSourceRecordHash(snapshot),
        JSON.stringify(snapshot),
        JSON.stringify(snapshot),
        at,
      );
    }));
    await env.DB.batch(stmts);
    return { written: list.length, skipped: null };
  } catch {
    return { written: 0, failed: true };
  }
}
