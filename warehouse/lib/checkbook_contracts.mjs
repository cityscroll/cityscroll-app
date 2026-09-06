/** Pure normalization, overlap measurement, and graph-slice selection for Checkbook Contracts. */

import { createHash } from "node:crypto";
import { matchesCrolAwardPublication } from "../../site/crol_notice_publication_policy.mjs";
import { normId } from "../../worker/src/lib/passport_join.mjs";

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
    ambiguous_registration_date_contracts: 0,
    ambiguous_start_date_contracts: 0,
    ambiguous_prime_registration_date_contracts: 0,
    ambiguous_prime_start_date_contracts: 0,
    ambiguous_award_method_contracts: 0,
    ambiguous_mwbe_category_contracts: 0,
    ambiguous_duration_contracts: 0,
    ambiguous_includes_subvendors_contracts: 0,
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
    const registrationDates = unique(slices.map((row) => row?.registered || row?.registration_date));
    const startDates = unique(slices.map((row) => row?.start || row?.start_date));
    // A prime contract's dates belong to its prime-vendor observation. Subvendor
    // slices of the same contract publish their own subcontract dates, so
    // reading whichever date happened to be present would let a subcontract
    // window stand in for the prime contract's own start. Selection is explicit
    // here, and every distinct observation stays retained beside it.
    const primeVendorSlices = slices.filter((row) => clean(row?.vendorRecordType).toLowerCase() === "prime vendor");
    const dateOwnerSlices = primeVendorSlices.length ? primeVendorSlices : slices;
    const dateOwner = primeVendorSlices.length ? "prime_vendor_slice" : "only_available_slice";
    const primeRegistrationDates = unique(dateOwnerSlices.map((row) => row?.registered || row?.registration_date));
    const primeStartDates = unique(dateOwnerSlices.map((row) => row?.start || row?.start_date));
    const awardMethods = unique(slices.map((row) => row?.awardMethod || row?.award_method));
    const mwbeCategories = unique(slices.map((row) => row?.mwbe || row?.mwbe_category));
    const durations = unique(slices.map((row) => row?.duration));
    const includesSubvendors = unique(slices.map((row) => row?.subs || row?.includes_subvendors));
    const industries = unique(dateOwnerSlices.map((row) => row?.industry || row?.prime_contract_industry));
    const purposes = unique(dateOwnerSlices.map((row) => row?.purpose || row?.prime_contract_purpose));
    const documentCodes = unique(dateOwnerSlices.map((row) => row?.documentCode || row?.document_code));
    const contractTypes = unique(dateOwnerSlices.map((row) => row?.contractType || row?.prime_contract_type));
    const contractVersions = unique(dateOwnerSlices.map((row) => row?.contractVersion || row?.prime_contract_version));
    const parentContractIds = unique(dateOwnerSlices.map((row) => row?.parentContractId || row?.parent_contract_id));
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
    if (registrationDates.length > 1) blocked.ambiguous_registration_date_contracts += 1;
    if (startDates.length > 1) blocked.ambiguous_start_date_contracts += 1;
    if (primeRegistrationDates.length > 1) blocked.ambiguous_prime_registration_date_contracts += 1;
    if (primeStartDates.length > 1) blocked.ambiguous_prime_start_date_contracts += 1;
    if (awardMethods.length > 1) blocked.ambiguous_award_method_contracts += 1;
    if (mwbeCategories.length > 1) blocked.ambiguous_mwbe_category_contracts += 1;
    if (durations.length > 1) blocked.ambiguous_duration_contracts += 1;
    if (includesSubvendors.length > 1) blocked.ambiguous_includes_subvendors_contracts += 1;

    rows.push({
      prime_contract_id: id,
      contract_id: id,
      prime_vendor: vendors.length === 1 ? vendors[0] : null,
      agency: agencies.length === 1 ? agencies[0] : null,
      pin: pins.length === 1 ? pins[0] : null,
      award_method: awardMethods.length === 1 ? awardMethods[0] : null,
      mwbe_category: mwbeCategories.length === 1 ? mwbeCategories[0] : null,
      duration: durations.length === 1 ? durations[0] : null,
      includes_subvendors: includesSubvendors.length === 1 ? includesSubvendors[0] : null,
      registration_date: primeRegistrationDates.length === 1 ? primeRegistrationDates[0] : null,
      start_date: primeStartDates.length === 1 ? primeStartDates[0] : null,
      date_ownership: {
        owner: dateOwner,
        start_date_observations: startDates,
        registration_date_observations: registrationDates,
        conflicting_start_date_observations: startDates.length > 1,
        conflicting_registration_date_observations: registrationDates.length > 1,
      },
      industry: industries.length === 1 ? industries[0] : null,
      purpose: purposes.length === 1 ? purposes[0] : null,
      document_code: documentCodes.length === 1 ? documentCodes[0] : null,
      contract_type: contractTypes.length === 1 ? contractTypes[0] : null,
      contract_version: contractVersions.length === 1 ? contractVersions[0] : null,
      parent_contract_id: parentContractIds.length === 1 ? parentContractIds[0] : null,
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

/**
 * Project the existing exact-PIN overlap onto each normalized Checkbook row.
 * Missing PINs remain a separate evaluation failure; names never participate.
 */
export function classifyCheckbookCityRecordMatches(rows, cityRecordRows) {
  const list = Array.isArray(rows) ? rows : [];
  const overlap = measureCheckbookOverlap(list, [], cityRecordRows);
  return list.map((row) => ({
    ...row,
    city_record_match: !normId(row?.pin)
      ? "cannot_evaluate_missing_pin"
      : overlap._sets.cityRecordPins.has(normId(row.pin)) ? "exact" : "none",
  }));
}

function rowSort(a, b) {
  const date = clean(b.registered || b.received).localeCompare(clean(a.registered || a.received));
  return date || clean(a.contract_id).localeCompare(clean(b.contract_id));
}

const CROL_GRAPH_STRATEGY = "City Record Award publication: valid amount (0 < x < $10B) and start/registration within 365 days; no separate row cap";

function stampCheckbookRow(row, classification) {
  return { ...row, selection_bucket: classification.bucket };
}

function applyOptionalCap(linked, novel, cap) {
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
  return selected;
}

/** Admit Checkbook rows by the City Record Award window; optional cap is tests-only. */
export function selectCheckbookContractsForGraph(rows, passportRows, cityRecordRows, opts = {}) {
  const cap = opts.cap == null || opts.cap === "" ? null : Math.max(1, Number(opts.cap));
  if (cap != null && !Number.isInteger(cap)) {
    throw new Error("Checkbook graph cap must be a positive integer when set");
  }
  const overlap = measureCheckbookOverlap(rows, passportRows, cityRecordRows);
  const linked = [];
  const novel = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!matchesCrolAwardPublication(row, { now: opts.now })) continue;
    const classification = classifyCheckbookContract(row, overlap._sets);
    const stamped = stampCheckbookRow(row, classification);
    if (classification.bucket === "new_unique") novel.push(stamped);
    else linked.push(stamped);
  }
  linked.sort(rowSort);
  novel.sort(rowSort);
  const selected = cap == null ? [...linked, ...novel].sort(rowSort) : applyOptionalCap(linked, novel, cap);
  const selectedBuckets = Object.fromEntries(
    Object.keys(overlap.exact_overlap_buckets).map((key) => [key, selected.filter((row) => row.selection_bucket === key).length]),
  );
  const { _sets, ...measurement } = overlap;
  return {
    rows: selected,
    cap,
    selected_rows: selected.length,
    selected_buckets: selectedBuckets,
    strategy: cap == null
      ? CROL_GRAPH_STRATEGY
      : `${CROL_GRAPH_STRATEGY}; optional test cap ${cap} still reserves half for overlap and half for new unique ids`,
    measurement,
  };
}

export function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
