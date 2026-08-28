import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SOURCE_VINTAGE_ALTERNATES_SCHEMA = "cityscroll.source_vintage_alternates.v1";
export const ALTERNATE_RELATIONS = Object.freeze([
  "same-measure-newer",
  "newer-official-context",
  "alternate-format",
]);
export const VERIFICATION_STATES = Object.freeze([
  "verified",
  "unverified",
  "suspected",
  "held",
  "rejected",
]);

export const REGISTRY_PATH = fileURLToPath(
  new URL("../site/data/source_vintage_alternates.json", import.meta.url),
);

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function validInstant(value) {
  const candidate = text(value);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(candidate)) return null;
  const normalized = /T/.test(candidate) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(candidate)
    ? `${candidate}Z`
    : candidate;
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch) || new Date(epoch).getUTCFullYear() <= 1970) return null;
  return new Date(epoch).toISOString();
}

function validUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function validFiscalYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null;
}

function records(registry) {
  return Array.isArray(registry?.alternates) ? registry.alternates : [];
}

export function loadSourceVintageAlternates() {
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
}

export function validateSourceVintageAlternates(registry, sourceContracts) {
  const errors = [];
  if (registry?.schema !== SOURCE_VINTAGE_ALTERNATES_SCHEMA) {
    errors.push(`schema must be ${SOURCE_VINTAGE_ALTERNATES_SCHEMA}`);
  }
  const alternates = records(registry);
  if (!Array.isArray(registry?.alternates)) errors.push("alternates must be an array");

  const contracts = Array.isArray(sourceContracts?.contracts) ? sourceContracts.contracts : [];
  const contractIds = new Set(contracts.map((contract) => contract.id));
  const contractAlternateIds = new Map();
  for (const contract of contracts) {
    const ids = Array.isArray(contract.alternate_source_ids) ? contract.alternate_source_ids : [];
    for (const id of ids) {
      if (!contractAlternateIds.has(id)) contractAlternateIds.set(id, []);
      contractAlternateIds.get(id).push(contract.id);
    }
  }

  const seen = new Set();
  for (const alternate of alternates) {
    const id = text(alternate?.alternate_id);
    const label = id || "(missing alternate_id)";
    if (!id) errors.push(`${label}: missing alternate_id`);
    if (seen.has(id)) errors.push(`${label}: duplicate alternate_id`);
    seen.add(id);

    const canonicalSourceId = text(alternate?.canonical_source_id);
    if (!canonicalSourceId) errors.push(`${label}: missing canonical_source_id`);
    else if (!contractIds.has(canonicalSourceId)) errors.push(`${label}: orphan canonical_source_id ${canonicalSourceId}`);
    else if (!contractAlternateIds.has(id)) errors.push(`${label}: not declared by canonical source ${canonicalSourceId}`);
    else if (!contractAlternateIds.get(id).includes(canonicalSourceId)) {
      errors.push(`${label}: canonical source does not own alternate`);
    }

    if (!text(alternate?.publisher)) errors.push(`${label}: publisher is required`);
    const relation = text(alternate?.relation);
    if (!ALTERNATE_RELATIONS.includes(relation)) errors.push(`${label}: invalid relation ${relation || "<missing>"}`);
    if (!text(alternate?.semantic_scope)) errors.push(`${label}: semantic_scope is required`);
    if (!text(alternate?.replacement_warning)) errors.push(`${label}: replacement_warning is required`);
    if (relation === "newer-official-context" && alternate?.replacement_eligible !== false) {
      errors.push(`${label}: contextual alternates must set replacement_eligible to false`);
    }

    if (alternate?.url === undefined && alternate?.artifact_url === undefined) {
      errors.push(`${label}: url or artifact_url is required`);
    }
    for (const field of ["url", "artifact_url"]) {
      if (alternate?.[field] !== undefined && !validUrl(alternate[field])) {
        errors.push(`${label}: ${field} must be an https URL`);
      }
    }

    const coverage = alternate?.observed_coverage;
    if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
      errors.push(`${label}: observed_coverage is required`);
    } else {
      const year = validFiscalYear(coverage.max_fiscal_year);
      const date = validInstant(coverage.max_date);
      if ((year === null) === (date === null)) errors.push(`${label}: observed_coverage needs exactly one frontier`);
      if (!text(coverage.basis)) errors.push(`${label}: observed_coverage.basis is required`);
    }
    if (!text(alternate?.publisher_vintage) && !validInstant(alternate?.publisher_last_updated_at)) {
      errors.push(`${label}: publisher_vintage or publisher_last_updated_at is required`);
    }
    if (!validInstant(alternate?.evidence_at)) errors.push(`${label}: evidence_at must be a valid timestamp`);
    if (!VERIFICATION_STATES.includes(alternate?.verification_state)) {
      errors.push(`${label}: invalid verification_state ${alternate?.verification_state || "<missing>"}`);
    }
    if (!text(alternate?.evidence_basis)) errors.push(`${label}: evidence_basis is required`);
  }

  for (const [id, owners] of contractAlternateIds) {
    if (owners.length > 1) errors.push(`${id}: alternate is declared by multiple canonical sources`);
    if (!seen.has(id)) errors.push(`${id}: source contract points to missing alternate`);
  }
  return errors.sort();
}
