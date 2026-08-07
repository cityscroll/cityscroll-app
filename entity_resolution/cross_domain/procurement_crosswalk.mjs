/**
 * Strict Checkbook Contracts ↔ PASSPort Public contract crosswalk.
 *
 * This is evidence stitching, not vendor identity resolution. A row is accepted
 * only on an exact contract id or the existing strict PIN↔EPIN join strategy;
 * names are never used as a fallback. Ambiguous keys stay visible as ambiguous
 * and do not produce a contract corroboration edge.
 */

import { buildEpinIndex, joinPinToEpin, normId } from "../../worker/src/lib/passport_join.mjs";

export const PROCUREMENT_CROSSWALK_VERSION = "passport_checkbook_crosswalk_v1";
export const PROCUREMENT_CROSSWALK_METHOD = "passport_checkbook_crosswalk_v1";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function sourceRecordId(row, fallback) {
  return clean(
    row?.source_record_id
      || row?.source_system_id
      || row?.source_record
      || row?.id
      || fallback,
  );
}

function passportRecord(row, index) {
  const contractId = clean(row?.contract_id || row?.prime_contract_id || row?.ctr_id);
  const epin = clean(row?.epin || row?.epin_norm || row?.pin);
  return {
    source_record_id: sourceRecordId(row, `passport:contract:${contractId || epin || index}`),
    subject_ref: clean(row?.subject_ref || (contractId ? `contract:${contractId}` : "")),
    contract_id: contractId || null,
    epin: epin || null,
    epin_norm: normId(epin) || null,
  };
}

function checkbookRecord(row, index) {
  const contractId = clean(row?.contract_id || row?.prime_contract_id || row?.id);
  const pin = clean(row?.pin || row?.epin);
  return {
    source_record_id: sourceRecordId(row, `checkbook:contract:${contractId || pin || index}`),
    subject_ref: clean(row?.subject_ref || (contractId ? `contract:${contractId}` : "")),
    contract_id: contractId || null,
    pin: pin || null,
    pin_norm: normId(pin) || null,
  };
}

function uniqueBySubject(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = row.subject_ref || row.source_record_id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @param {{passportContracts?: object[], checkbookContracts?: object[]}} input
 * @returns {{rows: object[], metrics: object}}
 */
export function buildPassportCheckbookCrosswalk(input = {}) {
  const passport = (Array.isArray(input.passportContracts) ? input.passportContracts : [])
    .map(passportRecord)
    .filter((row) => row.subject_ref && (row.contract_id || row.epin_norm));
  const checkbook = (Array.isArray(input.checkbookContracts) ? input.checkbookContracts : [])
    .map(checkbookRecord)
    .filter((row) => row.subject_ref && (row.contract_id || row.pin_norm));

  const passportByContractId = new Map();
  const passportByEpin = new Map();
  for (const row of passport) {
    if (row.contract_id) {
      const key = normId(row.contract_id);
      if (!passportByContractId.has(key)) passportByContractId.set(key, []);
      passportByContractId.get(key).push(row);
    }
    if (row.epin_norm) {
      if (!passportByEpin.has(row.epin_norm)) passportByEpin.set(row.epin_norm, []);
      passportByEpin.get(row.epin_norm).push(row);
    }
  }
  const epinIndex = buildEpinIndex(passport.map((row) => row.epin));
  const rows = [];

  for (const check of checkbook) {
    let candidates = [];
    let joinMethod = null;
    let inputValue = check.contract_id || check.pin;

    if (check.contract_id) {
      candidates = passportByContractId.get(normId(check.contract_id)) || [];
      if (candidates.length) joinMethod = "contract_id_exact";
    }

    if (!candidates.length && check.pin_norm) {
      inputValue = check.pin;
      candidates = passportByEpin.get(check.pin_norm) || [];
      if (candidates.length) joinMethod = "pin_epin_exact";
      if (!candidates.length) {
        const joined = joinPinToEpin(check.pin, epinIndex);
        if (joined?.epin) {
          candidates = passportByEpin.get(joined.epin) || [];
          if (candidates.length) {
            joinMethod = joined.method === "exact" ? "pin_epin_exact" : joined.method;
            inputValue = check.pin;
          }
        }
      }
    }

    candidates = uniqueBySubject(candidates);
    const status = candidates.length === 1
      ? "matched"
      : candidates.length > 1
        ? "ambiguous"
        : "unmatched";
    const match = status === "matched" ? candidates[0] : null;
    rows.push({
      status,
      join_method: status === "matched" ? joinMethod : null,
      checkbook_source_record_id: check.source_record_id,
      checkbook_subject_ref: check.subject_ref,
      checkbook_contract_id: check.contract_id,
      checkbook_pin: check.pin,
      passport_source_record_id: match?.source_record_id || null,
      passport_subject_ref: match?.subject_ref || null,
      passport_contract_id: match?.contract_id || null,
      passport_epin: match?.epin || null,
      input_value: status === "matched" ? inputValue : null,
      candidate_subject_refs: candidates.map((candidate) => candidate.subject_ref).sort(),
      provenance: status === "matched"
        ? {
            method: PROCUREMENT_CROSSWALK_METHOD,
            source_fields: joinMethod === "contract_id_exact"
              ? ["contract_id"]
              : ["pin", "epin"],
          }
        : null,
    });
  }

  const matched = rows.filter((row) => row.status === "matched").length;
  const ambiguous = rows.filter((row) => row.status === "ambiguous").length;
  const eligible = rows.length;
  return {
    rows,
    metrics: {
      version: PROCUREMENT_CROSSWALK_VERSION,
      checkbook_contracts: eligible,
      matched,
      ambiguous,
      unmatched: eligible - matched - ambiguous,
      coverage_rate: eligible ? matched / eligible : null,
      denominator: "materialized Checkbook Contracts rows with contract_id or PIN",
      acceptance_rule: "exact contract_id or strict PIN↔EPIN only; ambiguous candidates excluded",
    },
  };
}
