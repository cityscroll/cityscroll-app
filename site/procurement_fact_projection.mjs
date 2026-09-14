/** Pure, provenance-typed facts shared by procurement detail and search views. */

const CONTRACT_SOURCES = new Set([
  "passport_public_contracts",
  "checkbook_contracts",
  "checkbook_nycha_contracts",
  "mta_annual_contracts",
  "mta_cd_awards",
]);

const SOURCE_PRIORITY = new Map([
  ["city_record", 0],
  ["city_record_procurement", 0],
  ["crol", 0],
  ["passport_public_contracts", 1],
  ["checkbook_contracts", 2],
  ["checkbook_nycha_contracts", 3],
]);

function text(value, max = 500) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || null;
}

/** Normalize supported calendar dates and reject impossible round trips. */
export function normalizeProcurementDate(value) {
  const raw = text(value, 40);
  if (!raw) return null;
  let year; let month; let day;
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(raw);
  if (match) {
    [, year, month, day] = match;
  } else {
    match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
    if (!match) return null;
    [, month, day, year] = match;
  }
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

function snapshot(entry) {
  return entry?.snapshot && typeof entry.snapshot === "object" ? entry.snapshot : {};
}

function sourceRef(entry, fallback = null) {
  return text(entry?.source_observation_ref, 320) || fallback;
}

function sourceSystem(entry) {
  return text(entry?.source_system, 100)?.toLowerCase() || null;
}

function candidate(kind, value, entry, sourceField, normalize = (v) => text(v)) {
  const normalized = normalize(value);
  if (normalized == null || normalized === "") return null;
  return {
    kind,
    value: normalized,
    source_system: sourceSystem(entry),
    source_observation_ref: sourceRef(entry),
    source_field: sourceField,
  };
}

function sourceOrder(entry) {
  return SOURCE_PRIORITY.get(sourceSystem(entry)) ?? 99;
}

function sortedCandidates(candidates) {
  return candidates.filter(Boolean).sort((left, right) => (
    (SOURCE_PRIORITY.get(left.source_system) ?? 99) - (SOURCE_PRIORITY.get(right.source_system) ?? 99)
    || String(left.source_observation_ref || "").localeCompare(String(right.source_observation_ref || ""))
    || left.source_field.localeCompare(right.source_field)
    || String(left.value).localeCompare(String(right.value))
  ));
}

function addCandidate(groups, entry) {
  if (!entry) return;
  if (!groups.has(entry.kind)) groups.set(entry.kind, []);
  groups.get(entry.kind).push(entry);
}

function addIdentityCandidates(groups, object, observations) {
  const passport = observations.find((entry) => sourceSystem(entry) === "passport_public_contracts");
  const identityRef = object?.identity_edges?.find((edge) => edge?.status === "accepted")?.source_observation_ref
    || sourceRef(passport);
  const identityEntry = { source_system: passport ? "passport_public_contracts" : "canonical_identity", source_observation_ref: identityRef };
  const contractId = object?.identity_keys?.contract_ids?.[0];
  const epin = object?.identity_keys?.epins?.[0];
  addCandidate(groups, candidate("canonical_contract_id", contractId, identityEntry, "identity_keys.contract_ids"));
  addCandidate(groups, candidate("pin_epin", epin, identityEntry, passport ? "epin" : "identity_keys.epins"));
  if (passport) {
    const row = snapshot(passport);
    addCandidate(groups, candidate("passport_contract_number", row.contract_id, passport, "contract_id"));
  }
}

/**
 * Project one canonical procurement object and its retained observations.
 * `facts` is a compatibility view; `entries` and `conflicts` retain provenance.
 */
export function projectProcurementFacts(object = {}, observations = []) {
  const retained = (Array.isArray(observations) ? observations : [])
    .filter((entry) => entry && typeof entry === "object");
  const groups = new Map();
  addIdentityCandidates(groups, object, retained);

  for (const observation of retained) {
    const system = sourceSystem(observation);
    const row = snapshot(observation);
    const contractOwned = CONTRACT_SOURCES.has(system);
    const cityRecord = ["city_record", "city_record_procurement", "crol"].includes(system);
    const vendorEligible = !(system === "passport_public_rfx"
      && String(row.rfx_status || "").trim().toLowerCase() === "selections made");
    const add = (kind, value, field, normalize = (v) => text(v)) => addCandidate(
      groups, candidate(kind, value, observation, field, normalize),
    );
    add("title", row.short_title || row.title || row.description,
      row.short_title ? "short_title" : row.title ? "title" : "description", (v) => text(v, 500));
    add("agency", row.agency_name || row.agency, row.agency_name ? "agency_name" : "agency", (v) => text(v, 240));
    if (vendorEligible) add("vendor", row.vendor_name || row.vendor || row.prime_vendor || row.payee_name,
      row.vendor_name ? "vendor_name" : row.vendor ? "vendor" : row.prime_vendor ? "prime_vendor" : "payee_name",
      (v) => text(v, 240));
    add("contract_number", row.contract_number || row.transaction_number,
      row.contract_number ? "contract_number" : "transaction_number", (v) => text(v, 240));
    add("amount", row.contract_amount ?? row.award_amount ?? row.current_amount ?? row.current ?? row.amount ?? row.check_amount,
      row.contract_amount != null ? "contract_amount" : row.award_amount != null ? "award_amount" : "current_amount",
      (v) => { const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; });
    add("method", row.selection_method_description || row.procurement_method,
      row.selection_method_description ? "selection_method_description" : "procurement_method", (v) => text(v, 240));
    add("award_date", row.award_date, "award_date", (v) => text(v, 40));
    add("program", row.program, "program", (v) => text(v, 240));
    add("industry", row.industry, "industry", (v) => text(v, 120));
    if (contractOwned) {
      add("contract_start", row.start_date || row.start || row.contract_start_date || row.begin_date,
        row.start_date ? "start_date" : row.start ? "start" : row.contract_start_date ? "contract_start_date" : "begin_date", normalizeProcurementDate);
      add("contract_end", row.end_date || row.end || row.contract_end_date,
        row.end_date ? "end_date" : row.end ? "end" : "contract_end_date", normalizeProcurementDate);
      add("registration_date", row.registration_date, "registration_date", normalizeProcurementDate);
    }
    if (!contractOwned) {
      add("legacy_start_date", row.start_date || row.award_date || row.start || row.registered
        || row.registration_date || row.issue_date || row.date,
      row.start_date ? "start_date" : row.award_date ? "award_date" : row.start ? "start"
        : row.registered ? "registered" : row.registration_date ? "registration_date"
          : row.issue_date ? "issue_date" : "date", (v) => text(v, 40));
      add("legacy_end_date", row.end_date || row.end || row.contract_end_date || row.due_date
        || row.closing_date || row.opening_date,
      row.end_date ? "end_date" : row.end ? "end" : row.contract_end_date ? "contract_end_date"
        : row.due_date ? "due_date" : row.closing_date ? "closing_date" : "opening_date", (v) => text(v, 40));
    }
    if (cityRecord) {
      const noticeDate = normalizeProcurementDate(row.start_date);
      add("notice_publication_date", noticeDate, "start_date", (v) => v);
      if (/award/i.test(text(row.type_of_notice_description || row.type_of_notice, 120) || "")) {
        add("award_date", noticeDate, "start_date", (v) => v);
      }
    }
  }

  const entries = [];
  const values = {};
  const conflicts = {};
  for (const [kind, rawCandidates] of groups) {
    const candidates = sortedCandidates(rawCandidates);
    const distinct = [...new Map(candidates.map((entry) => [String(entry.value), entry])).values()];
    if (!candidates.length) continue;
    values[kind] = candidates[0].value;
    entries.push(...candidates);
    if (distinct.length > 1) conflicts[kind] = Object.freeze({
      chosen: candidates[0],
      candidates: Object.freeze(distinct),
    });
  }
  const fact = (kind) => values[kind] ?? null;
  return Object.freeze({
    entries: Object.freeze(entries),
    facts: Object.freeze({
      title: fact("title") || fact("program") || `Contract ${fact("canonical_contract_id") || fact("pin_epin") || object?.procurement_id || "record"}`,
      agency: fact("agency"), vendor: fact("vendor"), amount: fact("amount"), method: fact("method"),
      program: fact("program"), industry: fact("industry"),
      startDate: fact("contract_start") || fact("legacy_start_date"),
      endDate: fact("contract_end") || fact("legacy_end_date"),
      start_date: fact("contract_start"), end_date: fact("contract_end"),
      contract_start: fact("contract_start"), contract_end: fact("contract_end"),
      registrationDate: fact("registration_date"), awardDate: fact("award_date"),
      noticePublicationDate: fact("notice_publication_date"),
      contractNumber: fact("passport_contract_number") || fact("contract_number"),
      canonicalContractId: fact("canonical_contract_id"), pinEpin: fact("pin_epin"),
    }),
    conflicts: Object.freeze(conflicts),
  });
}

export const projectProcurementFactProjection = projectProcurementFacts;
