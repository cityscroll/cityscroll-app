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

function observationVintage(entry) {
  return text(
    entry?.observation_vintage
    || entry?.source_vintage
    || entry?.ingested_at
    || entry?.observed_at
    || entry?.acquired_at
    || null,
  );
}

function candidate(kind, value, entry, sourceField, normalize = (v) => text(v), metadata = {}) {
  const normalized = normalize(value);
  // Keep explicit numeric zero; only drop null/undefined/empty-string.
  if (normalized == null || normalized === "") return null;
  const vintage = observationVintage(entry);
  return {
    kind,
    value: normalized,
    source_system: sourceSystem(entry),
    source_observation_ref: sourceRef(entry),
    source_field: sourceField,
    ...(vintage ? { observation_vintage: vintage } : {}),
    ...metadata,
  };
}

function sourceOrder(entry) {
  return SOURCE_PRIORITY.get(sourceSystem(entry)) ?? 99;
}

function sortedCandidates(candidates) {
  // Source priority first. For the same source system, a strictly newer
  // observation vintage wins when both sides are dated. Never sort by value
  // magnitude (no max-value selection) and never invent missing dates.
  return candidates.filter(Boolean).sort((left, right) => {
    const bySource = (SOURCE_PRIORITY.get(left.source_system) ?? 99)
      - (SOURCE_PRIORITY.get(right.source_system) ?? 99);
    if (bySource !== 0) return bySource;
    const leftVintage = left.observation_vintage || "";
    const rightVintage = right.observation_vintage || "";
    if (leftVintage && rightVintage && leftVintage !== rightVintage) {
      return rightVintage.localeCompare(leftVintage);
    }
    return String(left.source_observation_ref || "").localeCompare(String(right.source_observation_ref || ""))
      || left.source_field.localeCompare(right.source_field)
      || String(left.value).localeCompare(String(right.value));
  });
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
    const add = (kind, value, field, normalize = (v) => text(v), metadata = {}) => addCandidate(
      groups, candidate(kind, value, observation, field, normalize, metadata),
    );
    add("title", row.purpose || row.short_title || row.title || row.description,
      row.purpose ? "purpose" : row.short_title ? "short_title" : row.title ? "title" : "description", (v) => text(v, 500));
    add("agency", row.agency_name || row.agency, row.agency_name ? "agency_name" : "agency", (v) => text(v, 240));
    if (vendorEligible) add("vendor", row.vendor_name || row.vendor || row.prime_vendor || row.payee_name,
      row.vendor_name ? "vendor_name" : row.vendor ? "vendor" : row.prime_vendor ? "prime_vendor" : "payee_name",
      (v) => text(v, 240));
    add("contract_number", row.contract_number || row.transaction_number,
      row.contract_number ? "contract_number" : "transaction_number", (v) => text(v, 240));
    const amount = (v) => { const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };
    const actionRole = row.action_role === "action" ? "action" : "base";
    const amountMetadata = { action_key: row.action_key || row.epin || row.ctr_id || null, action_family_key: row.action_family_key || row.contract_id || row.epin || null, action_role: actionRole };
    if (row.contract_amount != null) add("original_amount", row.contract_amount, "contract_amount", amount, amountMetadata);
    else if (row.award_amount != null) add("original_amount", row.award_amount, "award_amount", amount, amountMetadata);
    if (row.current_amount != null) add(actionRole === "action" ? "action_amount" : "current_amount", row.current_amount, "current_amount", amount, amountMetadata);
    else if (row.current != null) add("current_amount", row.current, "current", amount, amountMetadata);
    else if (row.amount != null) add(actionRole === "action" ? "action_amount" : "current_amount", row.amount, "amount", amount, amountMetadata);
    else if (row.check_amount != null) add("paid_amount", row.check_amount, "check_amount", amount, amountMetadata);
    if (row.encumbered_amount != null) add("encumbered_amount", row.encumbered_amount, "encumbered_amount", amount, amountMetadata);
    if (row.paid_amount != null) add("paid_amount", row.paid_amount, "paid_amount", amount, amountMetadata);
    if (row.spent != null) add("paid_amount", row.spent, "spent", amount, amountMetadata);
    add("method", row.award_method || row.selection_method_description || row.procurement_method,
      row.award_method ? "award_method" : row.selection_method_description ? "selection_method_description" : "procurement_method", (v) => text(v, 240));
    add("award_date", row.award_date, "award_date", (v) => text(v, 40), { date_basis: "award_decision" });
    add("program", row.program, "program", (v) => text(v, 240));
    add("industry", row.industry, "industry", (v) => text(v, 120));
    if (contractOwned) {
      add("contract_type", row.contract_type, "contract_type", (v) => text(v, 160));
      add("document_code", row.document_code, "document_code", (v) => text(v, 80));
    }
    if (contractOwned) {
      add("contract_start", row.start_date || row.start || row.contract_start_date || row.begin_date,
        row.start_date ? "start_date" : row.start ? "start" : row.contract_start_date ? "contract_start_date" : "begin_date", normalizeProcurementDate, { date_basis: "contract" });
      add("contract_end", row.end_date || row.end || row.contract_end_date,
        row.end_date ? "end_date" : row.end ? "end" : "contract_end_date", normalizeProcurementDate);
      add("registration_date", row.registration_date, "registration_date", normalizeProcurementDate, { date_basis: "registration" });
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
      add("notice_publication_date", noticeDate, "start_date", (v) => v, { date_basis: "publication" });
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
      agency: fact("agency"), vendor: fact("vendor"),
      amount: fact("action_amount") ?? fact("current_amount") ?? fact("original_amount") ?? fact("paid_amount"),
      originalAmount: fact("original_amount"), currentAmount: fact("current_amount"), actionAmount: fact("action_amount"),
      paidAmount: fact("paid_amount"), encumberedAmount: fact("encumbered_amount"),
      baseAmount: fact("current_amount") ?? fact("original_amount"), method: fact("method"),
      program: fact("program"), industry: fact("industry"),
      contractType: fact("contract_type"), documentCode: fact("document_code"),
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
