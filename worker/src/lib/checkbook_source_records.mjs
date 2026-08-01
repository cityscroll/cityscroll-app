// Immutable Checkbook Contracts + Spending observations for entity-resolution
// replay. Request-time XML rows are retained when dual-write is enabled;
// lifecycle assembly still collapses Prime/Sub Vendor slices for stage
// classification and summarizes spending into payment totals.
// Shadow only: public lifecycle reads do not consume these rows.

import {
  computeSourceRecordHash,
  SOURCE_RECORD_INSERT_SQL,
  sourceRecordDualWriteEnabled,
} from "./source_records.mjs";

export const CHECKBOOK_SOURCE_RECORD_DUAL_WRITE_FLAG = "CHECKBOOK_SOURCE_RECORD_DUAL_WRITE";
export const CHECKBOOK_CONTRACTS_SOURCE_SYSTEM = "checkbook_contracts";
export const CHECKBOOK_SPENDING_SOURCE_SYSTEM = "checkbook_spending";

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
 * Publisher-stable identity for one Checkbook Spending domain payment row.
 * Spending is keyed by contract_id (PIN is not a valid Spending lookup).
 * document_id / spending_id / transaction_id is preferred; amount anchors
 * rows that lack a publisher document id so multi-check days stay distinct.
 *
 * Shape: payment:<contract_id>:<document_id>:<payee>:<issue_date>:<amount>
 */
export function checkbookSpendingSourceSystemId(row) {
  // contractId is the Spending-domain join key (not PIN). document/payment id
  // lives on parseSpendingTransaction().id (document_id | spending_id | …).
  const contractId = normPart(row?.contractId, "no-contract-id");
  const docId = normPart(
    row?.documentId || row?.id || row?.spendingId || row?.transactionId,
    "no-document-id",
  );
  const payee = normPart(row?.vendor, "no-payee").toUpperCase();
  const when = normPart(row?.date, "nodate");
  const amount = Number.isFinite(Number(row?.amount))
    ? String(Number(row.amount))
    : normPart(row?.amount, "0");
  return `payment:${contractId}:${docId}:${payee}:${when}:${amount}`;
}

/**
 * Fail-soft dual-write of raw Checkbook Contracts rows into source_records.
 * Never throws; never blocks lifecycle assembly when the observation path fails.
 */
export async function dualWriteCheckbookContractObservations(env, rows, ingestedAt) {
  return dualWriteCheckbookObservations(
    env,
    rows,
    ingestedAt,
    CHECKBOOK_CONTRACTS_SOURCE_SYSTEM,
    checkbookContractSourceSystemId,
  );
}

/**
 * Fail-soft dual-write of raw Checkbook Spending payment rows into source_records.
 * Never throws; never blocks lifecycle assembly when the observation path fails.
 * Empty success (healthy feed, zero payments) writes nothing — there is no row.
 */
export async function dualWriteCheckbookSpendingObservations(env, rows, ingestedAt) {
  return dualWriteCheckbookObservations(
    env,
    rows,
    ingestedAt,
    CHECKBOOK_SPENDING_SOURCE_SYSTEM,
    checkbookSpendingSourceSystemId,
  );
}

async function dualWriteCheckbookObservations(env, rows, ingestedAt, sourceSystem, idFn) {
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
        sourceSystem,
        idFn(row),
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
