/** Pure normalization, join measurement, and retention for Checkbook Spending. */

import { createHash } from "node:crypto";
import {
  buildEpinIndex,
  joinPinToEpin,
  normId,
} from "../../worker/src/lib/passport_join.mjs";
import {
  checkbookSpendingSourceSystemId,
  CHECKBOOK_SPENDING_SOURCE_SYSTEM,
} from "../../worker/src/lib/checkbook_source_records.mjs";

export const USEFULNESS_FLOOR = 0.3;
export const PRECISION_FLOOR = 0.95;
export const CHECKBOOK_SPENDING_CATEGORY_CONTRACTS = "c";

const clean = (value) => String(value ?? "")
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, '"')
  .replace(/&apos;/gi, "'")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/\s+/g, " ")
  .trim();

const usable = (value) => {
  const text = clean(value);
  return text && text !== "-" && text.toLowerCase() !== "n/a" ? text : "";
};

/**
 * Normalize one parsed Spending transaction into a retained payment row.
 * Source-null fields stay null. Never invents a payment without a publisher
 * contract_id or document identity.
 */
export function normalizeCheckbookSpendingRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const contractId = usable(row.contractId || row.contract_id || row.prime_contract_id);
  const documentId = usable(
    row.documentId || row.document_id || row.id || row.spendingId || row.transactionId,
  );
  const payee = usable(row.vendor || row.payee_name || row.payee || row.vendor_name);
  const agency = usable(row.agency || row.agency_name);
  const pin = usable(row.pin);
  const issueDate = usable(row.date || row.issue_date || row.check_date);
  const fiscalYear = usable(row.year || row.fiscal_year);
  const amountRaw = row.amount != null && row.amount !== ""
    ? Number(row.amount)
    : row.check_amount != null && row.check_amount !== ""
      ? Number(row.check_amount)
      : null;
  const amount = Number.isFinite(amountRaw) ? amountRaw : null;

  // Retain only contract-linked payments. Payroll / unlinked rows stay out of
  // the payment→contract spine (product rejects PIN-only spending queries).
  if (!contractId) return null;
  if (!documentId && amount == null && !payee) return null;

  const seedContractId = usable(opts.seedContractId || row.seed_contract_id);
  const parsed = {
    document_id: documentId || null,
    contract_id: contractId,
    payee_name: payee || null,
    agency_name: agency || null,
    pin: pin || null,
    check_amount: amount,
    issue_date: issueDate || null,
    fiscal_year: fiscalYear || null,
    spending_category: usable(row.spending_category) || "Contracts",
    seed_contract_id: seedContractId || null,
  };

  // Lifecycle-shaped aliases so dual-write / source_record ids stay stable.
  parsed.id = parsed.document_id;
  parsed.contractId = parsed.contract_id;
  parsed.vendor = parsed.payee_name;
  parsed.agency = parsed.agency_name;
  parsed.amount = parsed.check_amount;
  parsed.date = parsed.issue_date;
  parsed.year = parsed.fiscal_year;

  return parsed;
}

export function normalizeCheckbookSpendingRows(inputRows, opts = {}) {
  const rows = [];
  const blocked = {
    missing_contract_id: 0,
    missing_identity: 0,
    duplicate_source_ids: 0,
  };
  const seen = new Set();
  for (const row of Array.isArray(inputRows) ? inputRows : []) {
    const normalized = normalizeCheckbookSpendingRow(row, opts);
    if (!normalized) {
      const hasContract = usable(row?.contractId || row?.contract_id);
      if (!hasContract) blocked.missing_contract_id += 1;
      else blocked.missing_identity += 1;
      continue;
    }
    const sourceId = checkbookSpendingSourceSystemId(normalized);
    if (seen.has(sourceId)) {
      blocked.duplicate_source_ids += 1;
      continue;
    }
    seen.add(sourceId);
    rows.push({
      ...normalized,
      source_system: CHECKBOOK_SPENDING_SOURCE_SYSTEM,
      source_system_id: sourceId,
    });
  }
  rows.sort((a, b) => {
    const date = clean(b.issue_date).localeCompare(clean(a.issue_date));
    return date || clean(a.document_id).localeCompare(clean(b.document_id))
      || clean(a.contract_id).localeCompare(clean(b.contract_id));
  });
  return {
    rows,
    counts: {
      input_rows: (Array.isArray(inputRows) ? inputRows : []).length,
      retained_payments: rows.length,
      unique_contracts: new Set(rows.map((r) => normId(r.contract_id))).size,
    },
    blocked,
  };
}

/**
 * Project a retained payment row into the immutable source_records envelope
 * used by Worker dual-write (snapshot payload only — no DB write).
 */
export function paymentRowToSourceRecord(row, ingestedAt) {
  if (!row) return null;
  const snapshot = {
    document_id: row.document_id ?? row.id ?? null,
    contract_id: row.contract_id ?? row.contractId ?? null,
    payee_name: row.payee_name ?? row.vendor ?? null,
    agency_name: row.agency_name ?? row.agency ?? null,
    pin: row.pin ?? null,
    check_amount: row.check_amount ?? row.amount ?? null,
    issue_date: row.issue_date ?? row.date ?? null,
    fiscal_year: row.fiscal_year ?? row.year ?? null,
    spending_category: row.spending_category ?? null,
  };
  const sourceSystemId = row.source_system_id || checkbookSpendingSourceSystemId({
    contractId: snapshot.contract_id,
    id: snapshot.document_id,
    vendor: snapshot.payee_name,
    date: snapshot.issue_date,
    amount: snapshot.check_amount,
  });
  return {
    source_system: CHECKBOOK_SPENDING_SOURCE_SYSTEM,
    source_system_id: sourceSystemId,
    payload_json: snapshot,
    normalized_json: snapshot,
    ingested_at: ingestedAt || null,
  };
}

function contractIndex(contractRows) {
  const byId = new Map();
  const pins = [];
  for (const row of Array.isArray(contractRows) ? contractRows : []) {
    const id = normId(row?.contract_id || row?.prime_contract_id || row?.id);
    if (!id) continue;
    byId.set(id, row);
    const pin = usable(row?.pin || row?.epin || row?.epin_norm);
    if (pin) pins.push(pin);
  }
  return { byId, pinIndex: buildEpinIndex(pins) };
}

/**
 * Join one payment to the contract spine.
 * Primary: exact normalized contract_id (product path; PIN rejected on Spending).
 * Secondary: pin_prefix_of_epin / exact pin when payment carries a pin and
 * contract_id is absent from the spine but a unique pin join resolves.
 */
export function joinPaymentToContract(payment, contracts) {
  const index = contracts?.byId ? contracts : contractIndex(contracts);
  const contractId = normId(payment?.contract_id || payment?.contractId);
  if (contractId && index.byId.has(contractId)) {
    return {
      method: "exact_contract_id",
      contract_id: payment.contract_id || payment.contractId,
      matched: true,
      precision_ok: true,
    };
  }

  // Seeded pulls stamp the requested contract_id; if the publisher echoes a
  // different id, treat that as a precision failure rather than inventing a join.
  const seedId = normId(payment?.seed_contract_id);
  if (seedId && contractId && seedId !== contractId) {
    return {
      method: "seed_contract_id_mismatch",
      contract_id: payment.contract_id || payment.contractId,
      matched: false,
      precision_ok: false,
      reason: "publisher contract_id differs from seed",
    };
  }
  if (seedId && index.byId.has(seedId) && contractId && seedId === contractId) {
    return {
      method: "exact_contract_id",
      contract_id: payment.contract_id || payment.contractId,
      matched: true,
      precision_ok: true,
    };
  }

  const pin = usable(payment?.pin);
  if (pin && index.pinIndex) {
    const pinJoin = joinPinToEpin(pin, index.pinIndex);
    if (pinJoin) {
      // Pin strategies only count when the payment also lacks an exact contract
      // hit — they recover residual joins without inventing a payment.
      return {
        method: pinJoin.method,
        contract_id: null,
        epin: pinJoin.epin,
        matched: true,
        precision_ok: true,
      };
    }
  }

  if (contractId) {
    return {
      method: "unmatched_contract_id",
      contract_id: payment.contract_id || payment.contractId,
      matched: false,
      precision_ok: true, // honest publisher id; not a false positive edge
      reason: "contract_id not in seed/spine index",
    };
  }
  return {
    method: "no_join_key",
    matched: false,
    precision_ok: true,
    reason: "no contract_id or joinable pin",
  };
}

/**
 * Kill-sample measurement for payment retention → contract spine.
 *
 * Usefulness: share of seed contracts that retain ≥1 payment row.
 * Precision: among retained payment rows that claim a contract join, share
 * whose publisher contract_id equals the seed (or exact spine id / accepted
 * pin_prefix join). Seed mismatches are false positives.
 */
export function measurePaymentContractJoin(seedContracts, paymentRows, opts = {}) {
  const seeds = Array.isArray(seedContracts) ? seedContracts : [];
  const payments = Array.isArray(paymentRows) ? paymentRows : [];
  const index = contractIndex(seeds);
  const bySeed = new Map(seeds.map((row) => {
    const id = normId(row.contract_id || row.prime_contract_id || row.id);
    return [id, { contract: row, payments: [] }];
  }));

  let retained = 0;
  let joinAttempts = 0;
  let truePositives = 0;
  let falsePositives = 0;
  const byMethod = {};
  const reviewed = [];

  for (const payment of payments) {
    retained += 1;
    const join = joinPaymentToContract(payment, index);
    byMethod[join.method] = (byMethod[join.method] || 0) + 1;
    const seedId = normId(payment.seed_contract_id || payment.contract_id || payment.contractId);
    if (seedId && bySeed.has(seedId)) bySeed.get(seedId).payments.push(payment);

    // Precision denominator: rows that would emit a payment_on_contract edge.
    if (join.matched || join.method === "seed_contract_id_mismatch") {
      joinAttempts += 1;
      if (join.matched && join.precision_ok) truePositives += 1;
      else falsePositives += 1;
    }
    if (opts.include_reviews) {
      reviewed.push({
        document_id: payment.document_id || payment.id || null,
        contract_id: payment.contract_id || payment.contractId || null,
        seed_contract_id: payment.seed_contract_id || null,
        payee_name: payment.payee_name || payment.vendor || null,
        check_amount: payment.check_amount ?? payment.amount ?? null,
        issue_date: payment.issue_date || payment.date || null,
        join,
      });
    }
  }

  let contractsWithPayments = 0;
  for (const entry of bySeed.values()) {
    if (entry.payments.length > 0) contractsWithPayments += 1;
  }

  const usefulnessRate = seeds.length ? contractsWithPayments / seeds.length : null;
  const precisionRate = joinAttempts ? truePositives / joinAttempts : null;
  const materialize = usefulnessRate != null
    && precisionRate != null
    && usefulnessRate >= USEFULNESS_FLOOR
    && precisionRate >= PRECISION_FLOOR;

  return {
    sample: {
      seed_contracts: seeds.length,
      retained_payments: retained,
      contracts_with_payments: contractsWithPayments,
      join_attempts: joinAttempts,
      true_positives: truePositives,
      false_positives: falsePositives,
    },
    methods: byMethod,
    usefulness: {
      joined: contractsWithPayments,
      total: seeds.length,
      rate: usefulnessRate,
      floor: USEFULNESS_FLOOR,
      denominator: "seed contracts from the population-backed Checkbook Contracts graph",
      numerator: "seed contracts with ≥1 retained Checkbook Spending payment row",
    },
    precision: {
      true_positives: truePositives,
      false_positives: falsePositives,
      attempts: joinAttempts,
      rate: precisionRate,
      floor: PRECISION_FLOOR,
      basis: "publisher contract_id equals seed / exact spine id; seed mismatches are false positives; pin_prefix_of_epin accepted only for residual pin joins",
    },
    gates: {
      usefulness_floor: USEFULNESS_FLOOR,
      precision_floor: PRECISION_FLOOR,
      usefulness_cleared: usefulnessRate != null && usefulnessRate >= USEFULNESS_FLOOR,
      precision_cleared: precisionRate != null && precisionRate >= PRECISION_FLOOR,
      materialize,
    },
    acceptance_rule: "exact contract_id join (product path); pin_prefix_of_epin / epin_prefix_of_pin only as residual when a payment pin uniquely resolves; never invent payments",
    reviews: opts.include_reviews ? reviewed : undefined,
  };
}

/** Cap retained payments for the public graph slice, preferring newest first. */
export function selectCheckbookSpendingForGraph(rows, opts = {}) {
  const cap = Math.max(1, Number(opts.cap) || 500);
  const list = Array.isArray(rows) ? rows.slice() : [];
  list.sort((a, b) => {
    const date = clean(b.issue_date || b.date).localeCompare(clean(a.issue_date || a.date));
    return date || clean(a.document_id || a.id).localeCompare(clean(b.document_id || b.id));
  });
  const selected = list.slice(0, cap).map((row) => ({
    document_id: row.document_id || row.id || null,
    issue_date: row.issue_date || row.date || null,
    payee_name: row.payee_name || row.vendor || null,
    contract_id: row.contract_id || row.contractId || null,
    check_amount: row.check_amount != null
      ? String(row.check_amount)
      : row.amount != null
        ? String(row.amount)
        : null,
    agency_name: row.agency_name || row.agency || null,
    pin: row.pin || null,
    source_system_id: row.source_system_id || null,
  }));
  return {
    rows: selected,
    cap,
    selected_rows: selected.length,
    strategy: "newest issue_date first; retain individual payment rows (not spent-to-date summaries)",
  };
}

export function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sha256Text(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}
