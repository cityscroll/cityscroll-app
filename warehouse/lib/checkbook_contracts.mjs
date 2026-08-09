/** Pure normalization, overlap measurement, and graph-slice selection for Checkbook Contracts. */

import { createHash } from "node:crypto";
import { normId } from "../../worker/src/lib/passport_join.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const usable = (value) => {
  const text = clean(value);
  return text && text !== "-" && text.toLowerCase() !== "n/a" ? text : "";
};

function unique(values) {
  return [...new Set(values.map(usable).filter(Boolean))].sort();
}

function amountScore(row) {
  return Math.max(
    Number(row?.current) || 0,
    Number(row?.original) || 0,
    Number(row?.spent) || 0,
  );
}

function bestSlice(rows) {
  const prime = rows.filter((row) => clean(row?.vendorRecordType).toLowerCase() === "prime vendor");
  return (prime.length ? prime : rows).slice().sort((a, b) => {
    const amount = amountScore(b) - amountScore(a);
    if (amount) return amount;
    return clean(b?.registered || b?.received).localeCompare(clean(a?.registered || a?.received));
  })[0] || {};
}

/**
 * Collapse fiscal-year, prime-vendor, and subvendor slices to one contract row.
 * Exact contract identity is the publisher's prime_contract_id. Names never
 * participate in grouping. Ambiguous PIN/vendor/agency fields remain null and
 * are counted instead of being guessed.
 */
export function normalizeCheckbookContractRows(inputRows) {
  const groups = new Map();
  let missingContractId = 0;
  for (const row of Array.isArray(inputRows) ? inputRows : []) {
    const id = usable(row?.id || row?.prime_contract_id || row?.contract_id);
    if (!id) {
      missingContractId += 1;
      continue;
    }
    const key = normId(id);
    if (!groups.has(key)) groups.set(key, { id, rows: [] });
    groups.get(key).rows.push(row);
  }

  const rows = [];
  const blocked = {
    missing_contract_id_slices: missingContractId,
    ambiguous_pin_contracts: 0,
    missing_pin_contracts: 0,
    ambiguous_prime_vendor_contracts: 0,
    missing_prime_vendor_contracts: 0,
    ambiguous_agency_contracts: 0,
    missing_agency_contracts: 0,
  };
  let primeSlices = 0;
  let subvendorSlices = 0;
  let otherSlices = 0;

  for (const { id, rows: slices } of groups.values()) {
    const best = bestSlice(slices);
    const types = unique(slices.map((row) => row?.vendorRecordType));
    const pins = unique(slices.map((row) => row?.pin || row?.prime_contract_pin));
    const vendors = unique(slices.map((row) => row?.vendor || row?.prime_vendor));
    const agencies = unique(slices.map((row) => row?.agency || row?.agency_name || row?.prime_contracting_agency));
    const fiscalYears = unique(slices.flatMap((row) => row?.sourceFiscalYears || row?.source_fiscal_years || []));
    const subVendors = unique(slices.map((row) => row?.subVendor || row?.sub_vendor));
    const sliceCounts = { prime: 0, subvendor: 0, other: 0 };
    for (const type of slices.map((row) => clean(row?.vendorRecordType).toLowerCase())) {
      if (type === "prime vendor") sliceCounts.prime += 1;
      else if (type === "sub vendor") sliceCounts.subvendor += 1;
      else sliceCounts.other += 1;
    }
    primeSlices += sliceCounts.prime;
    subvendorSlices += sliceCounts.subvendor;
    otherSlices += sliceCounts.other;

    if (pins.length > 1) blocked.ambiguous_pin_contracts += 1;
    else if (!pins.length) blocked.missing_pin_contracts += 1;
    if (vendors.length > 1) blocked.ambiguous_prime_vendor_contracts += 1;
    else if (!vendors.length) blocked.missing_prime_vendor_contracts += 1;
    if (agencies.length > 1) blocked.ambiguous_agency_contracts += 1;
    else if (!agencies.length) blocked.missing_agency_contracts += 1;

    rows.push({
      prime_contract_id: id,
      contract_id: id,
      prime_vendor: vendors.length === 1 ? vendors[0] : null,
      agency: agencies.length === 1 ? agencies[0] : null,
      pin: pins.length === 1 ? pins[0] : null,
      status: usable(best.status) || "registered",
      current: Number(best.current) || 0,
      original: Number(best.original) || 0,
      spent: Number(best.spent) || 0,
      start: usable(best.start) || null,
      end: usable(best.end) || null,
      registered: usable(best.registered) || null,
      received: usable(best.received) || null,
      source_fiscal_years: fiscalYears,
      vendor_record_types: types,
      slice_counts: sliceCounts,
      subvendor_count: subVendors.length,
      exact_key_status: {
        contract_id: "exact",
        pin: pins.length === 1 ? "exact" : pins.length ? "ambiguous" : "missing",
      },
    });
  }

  rows.sort((a, b) => {
    const date = clean(b.registered || b.received).localeCompare(clean(a.registered || a.received));
    return date || a.contract_id.localeCompare(b.contract_id);
  });
  return {
    rows,
    counts: {
      input_slices: (Array.isArray(inputRows) ? inputRows : []).length,
      unique_contracts: rows.length,
      duplicate_slices_collapsed: Math.max(0, (Array.isArray(inputRows) ? inputRows : []).length - missingContractId - rows.length),
      prime_slices: primeSlices,
      subvendor_slices: subvendorSlices,
      other_slices: otherSlices,
    },
    blocked,
  };
}

function exactSets(passportRows, cityRecordRows) {
  const passportContractIds = new Set();
  const passportEpins = new Set();
  for (const row of Array.isArray(passportRows) ? passportRows : []) {
    const contractId = normId(row?.contract_id || row?.prime_contract_id || row?.ctr_id);
    const epin = normId(row?.epin || row?.epin_norm || row?.pin);
    if (contractId) passportContractIds.add(contractId);
    if (epin) passportEpins.add(epin);
  }
  const cityRecordPins = new Set();
  const modernCityRecordRows = [];
  for (const row of Array.isArray(cityRecordRows) ? cityRecordRows : []) {
    const start = clean(row?.start_date);
    const pin = normId(row?.pin);
    if (!pin || (start && start < "2025-01-01")) continue;
    cityRecordPins.add(pin);
    modernCityRecordRows.push(row);
  }
  return { passportContractIds, passportEpins, cityRecordPins, modernCityRecordRows };
}

export function classifyCheckbookContract(row, sets) {
  const contractId = normId(row?.contract_id || row?.prime_contract_id);
  const pin = normId(row?.pin);
  const passportContractId = Boolean(contractId && sets.passportContractIds.has(contractId));
  const passportPin = Boolean(pin && sets.passportEpins.has(pin));
  const cityRecordPin = Boolean(pin && sets.cityRecordPins.has(pin));
  const passport = passportContractId || passportPin;
  return {
    passport,
    passport_contract_id: passportContractId,
    passport_pin: passportPin,
    city_record: cityRecordPin,
    bucket: passport && cityRecordPin
      ? "passport_and_city_record"
      : passport
        ? "passport_only"
        : cityRecordPin
          ? "city_record_only"
          : "new_unique",
  };
}

export function measureCheckbookOverlap(rows, passportRows, cityRecordRows) {
  const list = Array.isArray(rows) ? rows : [];
  const sets = exactSets(passportRows, cityRecordRows);
  const buckets = {
    passport_and_city_record: 0,
    passport_only: 0,
    city_record_only: 0,
    new_unique: 0,
  };
  let passportContractId = 0;
  let passportPin = 0;
  let cityRecord = 0;
  const checkbookPins = new Set();
  for (const row of list) {
    const classification = classifyCheckbookContract(row, sets);
    buckets[classification.bucket] += 1;
    if (classification.passport_contract_id) passportContractId += 1;
    if (classification.passport_pin) passportPin += 1;
    if (classification.city_record) cityRecord += 1;
    const pin = normId(row?.pin);
    if (pin) checkbookPins.add(pin);
  }
  const matchedCityRecordRows = sets.modernCityRecordRows.filter((row) => checkbookPins.has(normId(row?.pin)));
  const uniqueMatchedCityRecord = new Set(matchedCityRecordRows.map((row) => clean(row?.request_id) || normId(row?.pin)));
  const uniqueModernCityRecord = new Set(sets.modernCityRecordRows.map((row) => clean(row?.request_id) || normId(row?.pin)));
  const passportMatched = buckets.passport_and_city_record + buckets.passport_only;
  return {
    checkbook_contracts: list.length,
    exact_overlap_buckets: buckets,
    passport: {
      matched_contracts: passportMatched,
      by_contract_id: passportContractId,
      by_pin_epin: passportPin,
      rate: list.length ? passportMatched / list.length : null,
      denominator: "normalized Checkbook contracts in the collected fiscal-year window",
    },
    city_record: {
      matched_checkbook_contracts: cityRecord,
      checkbook_rate: list.length ? cityRecord / list.length : null,
      matched_modern_awards: uniqueMatchedCityRecord.size,
      modern_awards_with_pin: uniqueModernCityRecord.size,
      modern_award_rate: uniqueModernCityRecord.size ? uniqueMatchedCityRecord.size / uniqueModernCityRecord.size : null,
      denominator: "City Record Recent Contract Awards since 2025-01-01 with an exact PIN",
    },
    new_unique_contract_ids: buckets.new_unique,
    acceptance_rule: "normalized exact contract_id or exact PIN/EPIN only; names are not join keys",
    _sets: sets,
  };
}

function rowSort(a, b) {
  const date = clean(b.registered || b.received).localeCompare(clean(a.registered || a.received));
  return date || clean(a.contract_id).localeCompare(clean(b.contract_id));
}

/** Keep both corroborating and novel contracts inside the public graph budget. */
export function selectCheckbookContractsForGraph(rows, passportRows, cityRecordRows, opts = {}) {
  const cap = Math.max(1, Number(opts.cap) || 500);
  const overlap = measureCheckbookOverlap(rows, passportRows, cityRecordRows);
  const linked = [];
  const novel = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const classification = classifyCheckbookContract(row, overlap._sets);
    const stamped = { ...row, selection_bucket: classification.bucket };
    if (classification.bucket === "new_unique") novel.push(stamped);
    else linked.push(stamped);
  }
  linked.sort(rowSort);
  novel.sort(rowSort);
  const linkedTarget = Math.ceil(cap / 2);
  const novelTarget = Math.floor(cap / 2);
  const selected = [...linked.slice(0, linkedTarget), ...novel.slice(0, novelTarget)];
  if (selected.length < cap) {
    const seen = new Set(selected.map((row) => normId(row.contract_id)));
    for (const row of [...linked.slice(linkedTarget), ...novel.slice(novelTarget)]) {
      const id = normId(row.contract_id);
      if (!id || seen.has(id)) continue;
      selected.push(row);
      seen.add(id);
      if (selected.length >= cap) break;
    }
  }
  const selectedBuckets = Object.fromEntries(
    Object.keys(overlap.exact_overlap_buckets).map((key) => [key, selected.filter((row) => row.selection_bucket === key).length]),
  );
  const { _sets, ...measurement } = overlap;
  return {
    rows: selected,
    cap,
    selected_rows: selected.length,
    selected_buckets: selectedBuckets,
    strategy: "reserve half the cap for exact PASSPort/City Record overlap and half for new unique contract ids; fill unused capacity deterministically newest-first",
    measurement,
  };
}

export function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
