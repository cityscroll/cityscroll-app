/**
 * Guarded Checkbook NYC corroboration for PASSPort-only procurement identities.
 *
 * Checkbook can confirm a PASSPort contract, but its amount and PIN are a
 * different slice of the same (or a related) instrument. A hit is evidence
 * only: it must not overwrite the PASSPort amount, merge a PIN-family sibling
 * as the same contract, or mint a served detail route.
 */

import {
  classifyPinFamilyRow,
  isPublicSameContractCrosswalkRow,
  moneyNumber,
} from "../entity_resolution/cross_domain/pin_family_mismatch.mjs";
import { contractIdKey, pinKey, pinKeysShareFamily } from "./pin_sibling_grouping.mjs";

export const CHECKBOOK_PASSPORT_CORROBORATION_SCHEMA =
  "cityscroll.checkbook_passport_corroboration.v1";
export const CHECKBOOK_PASSPORT_CORROBORATION_VERSION = 1;

const CHECKBOOK_SOURCES = new Set(["checkbook_contracts", "checkbook_spending"]);
const PASSPORT_CONTRACT_SOURCE = "passport_public_contracts";

function text(value) {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  return result || null;
}

function observationRef(record) {
  const system = text(record?.source_system)?.toLowerCase();
  const id = text(record?.source_system_id || record?.source_id);
  return system && id ? `${system}:${id}` : null;
}

function snapshotOf(record) {
  for (const value of [record?.normalized_snapshot, record?.raw_snapshot, record?.snapshot]) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Unreadable payloads cannot contribute identity or amount facts.
    }
  }
  return {};
}

export function constructorSystems(object = {}) {
  return new Set((Array.isArray(object.source_observation_refs) ? object.source_observation_refs : [])
    .map((ref) => String(ref || "").split(":")[0]?.toLowerCase())
    .filter(Boolean));
}

export function isPassportOnlyProcurement(object = {}) {
  const systems = constructorSystems(object);
  return systems.has(PASSPORT_CONTRACT_SOURCE)
    && ![...CHECKBOOK_SOURCES].some((source) => systems.has(source));
}

export function normalizeCheckbookLookupRow(row = {}) {
  return {
    contract_id: text(row.contract_id || row.id || row.prime_contract_id),
    pin: text(row.pin || row.prime_contract_pin || row.epin),
    vendor: text(row.prime_vendor || row.vendor),
    agency: text(row.agency),
    current: moneyNumber(row.current ?? row.current_amount ?? row.prime_contract_current_amount),
    original: moneyNumber(row.original ?? row.original_amount),
    start: text(row.start || row.start_date),
    end: text(row.end || row.end_date),
    registered: text(row.registered || row.registration_date),
    status: text(row.status),
    vendorRecordType: text(row.vendorRecordType || row.vendor_record_type),
  };
}

function uniqueByContract(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = contractIdKey(row.contract_id) || pinKey(row.pin);
    if (!key || map.has(key)) continue;
    map.set(key, row);
  }
  return [...map.values()];
}

function preferPrime(rows) {
  const primes = rows.filter((row) => /prime/i.test(row.vendorRecordType || ""));
  return primes.length ? primes : rows;
}

/**
 * Normalize the Checkbook lookup corpus once and index it by contract id and
 * PIN. The normalization and the prime-vendor preference depend only on the
 * corpus, so classifying many PASSPort identities against the same rows should
 * pay for them once rather than once per identity.
 */
export function prepareCheckbookLookupIndex(checkbookRows = []) {
  const rows = preferPrime((Array.isArray(checkbookRows) ? checkbookRows : [])
    .map(normalizeCheckbookLookupRow)
    .filter((row) => row.contract_id || row.pin));
  const contractKeys = rows.map((row) => contractIdKey(row.contract_id));
  const pinKeys = rows.map((row) => pinKey(row.pin));
  const byContract = new Map();
  const byPin = new Map();
  rows.forEach((row, position) => {
    const contractKey = contractKeys[position];
    if (contractKey) {
      const bucket = byContract.get(contractKey);
      if (bucket) bucket.push(row);
      else byContract.set(contractKey, [row]);
    }
    const key = pinKeys[position];
    if (key) {
      const bucket = byPin.get(key);
      if (bucket) bucket.push(row);
      else byPin.set(key, [row]);
    }
  });
  return { rows, pinKeys, byContract, byPin };
}

/**
 * In-memory Checkbook query against already-fetched contract rows.
 * Live XML uses Contracts-by-PIN and Spending-by-contract_id; this selector
 * is the same join over whatever rows those lookups returned.
 */
export function queryCheckbookRowsForPassport(passport = {}, checkbookRows = [], index = null) {
  const prepared = index || prepareCheckbookLookupIndex(checkbookRows);
  const { rows, pinKeys } = prepared;
  const contract = contractIdKey(passport.contract_id);
  const pin = pinKey(passport.epin || passport.pin);
  const family = [];
  if (pin) {
    for (let position = 0; position < rows.length; position += 1) {
      const candidate = pinKeys[position];
      if (candidate && pinKeysShareFamily(candidate, pin)) family.push(rows[position]);
    }
  }
  return {
    rows,
    exact_contract: uniqueByContract(contract ? prepared.byContract.get(contract) || [] : []),
    exact_pin: uniqueByContract(pin ? prepared.byPin.get(pin) || [] : []),
    pin_family: uniqueByContract(family),
  };
}

function pinsAgree(passport, checkbook) {
  const left = pinKey(passport.epin || passport.pin);
  const right = pinKey(checkbook.pin);
  if (!left || !right) return true;
  return left === right;
}

function receipt(status, passport, checkbook, extra = {}) {
  const passportAmount = moneyNumber(passport?.current_amount ?? passport?.award_amount);
  const checkbookAmount = moneyNumber(checkbook?.current);
  return Object.freeze({
    schema: CHECKBOOK_PASSPORT_CORROBORATION_SCHEMA,
    version: CHECKBOOK_PASSPORT_CORROBORATION_VERSION,
    status,
    identity_class: extra.identity_class || null,
    join_method: extra.join_method || null,
    rule: extra.rule || null,
    rationale: extra.rationale || null,
    passport_contract_id: text(passport?.contract_id),
    checkbook_contract_id: text(checkbook?.contract_id),
    passport_pin: text(passport?.epin || passport?.pin),
    checkbook_pin: text(checkbook?.pin),
    passport_amount: passportAmount,
    checkbook_amount: checkbookAmount,
    amount_disagrees: passportAmount != null && checkbookAmount != null && passportAmount !== checkbookAmount,
    overwrites_passport_amount: false,
    evidence_only: true,
    fabricates_object: false,
    fabricates_route: false,
  });
}

function pinFamilyReceipt(passport, checkbook, joinMethod) {
  const classified = classifyPinFamilyRow({
    status: "matched",
    join_method: joinMethod,
    checkbook_contract_id: checkbook.contract_id,
    passport_contract_id: passport.contract_id,
    checkbook_pin: checkbook.pin,
    passport_epin: passport.epin || passport.pin,
  }, {
    checkbookContracts: [{
      contract_id: checkbook.contract_id,
      prime_vendor: checkbook.vendor,
      vendor: checkbook.vendor,
      agency: checkbook.agency,
      current: checkbook.current,
      original: checkbook.original,
      start: checkbook.start,
      end: checkbook.end,
      registered: checkbook.registered,
      status: checkbook.status,
      pin: checkbook.pin,
    }],
    passportContracts: [{
      contract_id: passport.contract_id,
      epin: passport.epin || passport.pin,
      vendor: passport.vendor,
      agency: passport.agency,
      current_amount: passport.current_amount,
      award_amount: passport.award_amount,
      start_date: passport.start_date || passport.start,
      end_date: passport.end_date || passport.end,
      status: passport.status,
    }],
  });
  const identityClass = classified.identity_class === "same_contract"
    ? "needs_review"
    : classified.identity_class;
  return receipt(identityClass, passport, checkbook, {
    identity_class: identityClass,
    join_method: joinMethod,
    rule: classified.rule,
    rationale: classified.rationale,
  });
}

/**
 * Classify a Checkbook lookup against one PASSPort identity.
 * Exact contract-id and PIN: evidence-only same-contract corroboration.
 * PIN-family or a non-exact disagreement: related-instrument or needs-review.
 * No Checkbook row: honest unknown. Never a constructor or route.
 */
export function classifyCheckbookPassportCorroboration({ passport = {}, checkbookRows = [], checkbookIndex = null } = {}) {
  const identity = {
    contract_id: text(passport.contract_id),
    epin: text(passport.epin || passport.pin),
    pin: text(passport.pin || passport.epin),
    vendor: text(passport.vendor),
    agency: text(passport.agency),
    current_amount: moneyNumber(passport.current_amount ?? passport.award_amount),
    award_amount: moneyNumber(passport.award_amount),
    start: text(passport.start_date || passport.start),
    end: text(passport.end_date || passport.end),
    start_date: text(passport.start_date || passport.start),
    end_date: text(passport.end_date || passport.end),
    status: text(passport.status),
  };
  const queried = queryCheckbookRowsForPassport(identity, checkbookRows, checkbookIndex);

  if (!queried.rows.length) return receipt("unknown", identity, null);

  const exactIdAndPin = queried.exact_contract.filter((row) => pinsAgree(identity, row));
  if (exactIdAndPin.length === 1) {
    const checkbook = exactIdAndPin[0];
    const classified = receipt("corroborated", identity, checkbook, {
      identity_class: "same_contract",
      join_method: "contract_id_exact",
      rationale: "Exact FMS contract-id and PIN. Checkbook is corroborating evidence; the PASSPort amount stays on the object.",
    });
    const crosswalkRow = {
      status: "matched",
      join_method: "contract_id_exact",
      checkbook_contract_id: checkbook.contract_id,
      passport_contract_id: identity.contract_id,
    };
    if (!isPublicSameContractCrosswalkRow(crosswalkRow)) {
      return pinFamilyReceipt(identity, checkbook, "pin_epin_exact");
    }
    return classified;
  }

  if (queried.exact_contract.length === 1 && !pinsAgree(identity, queried.exact_contract[0])) {
    return pinFamilyReceipt(identity, queried.exact_contract[0], "pin_family");
  }

  const familyCandidates = uniqueByContract([
    ...queried.exact_pin.filter((row) => contractIdKey(row.contract_id) !== contractIdKey(identity.contract_id)),
    ...queried.pin_family.filter((row) => pinKey(row.pin) !== pinKey(identity.epin)
      || contractIdKey(row.contract_id) !== contractIdKey(identity.contract_id)),
  ]);
  if (familyCandidates.length === 1) {
    const joinMethod = pinKey(familyCandidates[0].pin) === pinKey(identity.epin)
      ? "pin_epin_exact"
      : "pin_family";
    return pinFamilyReceipt(identity, familyCandidates[0], joinMethod);
  }
  if (familyCandidates.length > 1 || queried.exact_contract.length > 1) {
    const checkbook = familyCandidates[0] || queried.exact_contract[0];
    return receipt("needs_review", identity, checkbook, {
      identity_class: "needs_review",
      join_method: "pin_family",
      rationale: "Multiple Checkbook rows share this PASSPort identity's PIN family or contract id.",
    });
  }

  return receipt("unknown", identity, null);
}

/**
 * Index the PASSPort contract records by observation ref, keeping their
 * position, so resolving one object's PASSPort identity is a lookup over that
 * object's own refs instead of a scan of every source record.
 */
export function preparePassportRecordIndex(sourceRecords = []) {
  const byRef = new Map();
  (Array.isArray(sourceRecords) ? sourceRecords : []).forEach((record, position) => {
    if (text(record?.source_system)?.toLowerCase() !== PASSPORT_CONTRACT_SOURCE) return;
    const ref = observationRef(record);
    // First record wins on a repeated ref, matching the linear find it replaces.
    if (!ref || byRef.has(ref)) return;
    byRef.set(ref, { position, record });
  });
  return byRef;
}

function passportRecordFor(object, index) {
  let found = null;
  for (const ref of object.source_observation_refs || []) {
    const entry = index.get(ref);
    if (entry && (!found || entry.position < found.position)) found = entry;
  }
  return found?.record;
}

export function passportIdentityFromObject(object = {}, sourceRecords = [], passportIndex = null) {
  const passportRecord = passportRecordFor(
    object,
    passportIndex || preparePassportRecordIndex(sourceRecords),
  );
  const snapshot = snapshotOf(passportRecord);
  return {
    contract_id: object.identity_keys?.contract_ids?.[0] || snapshot.contract_id,
    epin: object.identity_keys?.epins?.[0] || snapshot.epin || snapshot.epin_norm,
    vendor: snapshot.vendor,
    agency: snapshot.agency,
    current_amount: snapshot.current_amount,
    award_amount: snapshot.award_amount,
    start_date: snapshot.start_date,
    end_date: snapshot.end_date,
    status: snapshot.status,
  };
}

/**
 * Stamp evidence onto existing PASSPort-only objects. Lookup rows never become
 * constructors and never add a procurement object.
 */
export function attachCheckbookPassportCorroboration(objects = [], {
  sourceRecords = [],
  checkbookLookupRows = null,
  includeUnknown = false,
} = {}) {
  if (!Array.isArray(checkbookLookupRows) || !Array.isArray(objects)) return objects;
  const checkbookIndex = prepareCheckbookLookupIndex(checkbookLookupRows);
  const passportIndex = preparePassportRecordIndex(sourceRecords);
  for (const object of objects) {
    if (!isPassportOnlyProcurement(object)) continue;
    const passport = passportIdentityFromObject(object, sourceRecords, passportIndex);
    const classified = classifyCheckbookPassportCorroboration({
      passport,
      checkbookRows: checkbookLookupRows,
      checkbookIndex,
    });
    if (classified.status === "unknown" && !includeUnknown) continue;
    object.checkbook_corroboration = classified;
  }
  return objects;
}

export function snapshotsForPublicAmount(object, observations = []) {
  const rows = (Array.isArray(observations) ? observations : [])
    .map((entry) => ({
      source_system: text(entry?.source_system)?.toLowerCase(),
      snapshot: entry?.snapshot && typeof entry.snapshot === "object" ? entry.snapshot : snapshotOf(entry),
    }));
  if (object?.checkbook_corroboration?.overwrites_passport_amount === false) {
    const passport = rows.filter((entry) => entry.source_system === PASSPORT_CONTRACT_SOURCE);
    if (passport.length) return passport.map((entry) => entry.snapshot);
  }
  return rows.map((entry) => entry.snapshot).filter(Boolean);
}

export function publicProcurementAmount(object, observations = []) {
  if (object?.checkbook_corroboration && object.checkbook_corroboration.overwrites_passport_amount === false) {
    const amount = moneyNumber(object.checkbook_corroboration.passport_amount);
    if (amount != null) return amount;
  }
  const snapshots = snapshotsForPublicAmount(object, observations);
  for (const snapshot of snapshots) {
    const amount = moneyNumber(
      snapshot?.contract_amount ?? snapshot?.award_amount ?? snapshot?.current_amount
      ?? snapshot?.current ?? snapshot?.amount ?? snapshot?.check_amount,
    );
    if (amount != null) return amount;
  }
  return null;
}

/** A Checkbook hit is never enough to serve /procurements/<id>. */
export function servedProcurementForCorroboration(procurementId, objects = [], _receipt = null) {
  const id = text(procurementId);
  if (!id) return null;
  return (Array.isArray(objects) ? objects : []).find((object) => object?.procurement_id === id) || null;
}
