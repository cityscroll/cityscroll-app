// Common read contract for every register in this slice. A later organization-search slice
// consumes these records uniformly. No merged identity across registers: a record belongs to
// exactly one register and carries that register's own record id.

import { vendorStem } from "../normalizers/vendor_stem.mjs";

export const REGISTER_IDS = Object.freeze([
  "ny_dos_entities",
  "irs_eo_bmf_ny",
  "nys_dol_contractor_registry",
  "nyc_sca_prequalified_firms",
]);

export const ENTITY_CLASSES = Object.freeze([
  "business_corporation",
  "llc",
  "not_for_profit",
  "professional",
  "limited_partnership",
  "llp",
  "other",
]);

export const RECORD_KEYS = Object.freeze([
  "register",
  "register_record_id",
  "name",
  "name_stem",
  "entity_class",
  "entity_type",
  "address",
  "status",
  "status_basis",
  "source_url",
  "collected_at",
  "queried_at",
  "flags",
  "published",
  "raw",
]);

export const FLAGS = Object.freeze([
  "missing_record_id",
  "missing_name",
  "stem_too_short",
  "ragged_row",
  "invalid_date",
  "unmapped_entity_type",
]);

const clean = (v) => (v == null ? "" : String(v));

/** Trim only the outer whitespace for comparison; the raw value is always kept untouched. */
export function nonEmpty(v) {
  return clean(v).trim() !== "";
}

export function addressFrom(parts) {
  const street = clean(parts.street).trim();
  const street2 = clean(parts.street_2).trim();
  const city = clean(parts.city).trim();
  const state = clean(parts.state).trim();
  const zip = clean(parts.zip).trim();
  if (!street && !street2 && !city && !state && !zip) return null;
  const line = [street, street2].filter(Boolean).join(" ");
  const tail = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return {
    street: street || null,
    street_2: street2 || null,
    city: city || null,
    state: state || null,
    zip: zip || null,
    text: [line, tail].filter(Boolean).join(", "),
    ...(parts.role ? { role: parts.role } : {}),
  };
}

/**
 * Build one contract record. Never throws and never drops: a missing id or name, a stem that
 * is too short to match on, or a ragged row become flags on the kept record.
 */
export function makeRecord(input) {
  const flags = [...(input.flags || [])];
  const id = clean(input.register_record_id).trim();
  const name = clean(input.name);
  if (!id) flags.push("missing_record_id");
  if (!nonEmpty(name)) flags.push("missing_name");
  const stem = vendorStem(name);
  if (nonEmpty(name) && stem.length < 3) flags.push("stem_too_short");
  return {
    register: input.register,
    register_record_id: id || null,
    name,
    name_stem: stem,
    entity_class: input.entity_class ?? null,
    entity_type: input.entity_type ?? null,
    address: input.address ?? null,
    status: input.status ?? null,
    status_basis: input.status_basis ?? null,
    source_url: input.source_url,
    collected_at: input.collected_at ?? null,
    queried_at: input.queried_at ?? null,
    flags: [...new Set(flags)],
    published: input.published ?? {},
    raw: input.raw,
  };
}

/** Structural check used by tests and by artifact loaders. Returns a list of problems. */
export function validateRecord(rec) {
  const problems = [];
  if (!rec || typeof rec !== "object") return ["not an object"];
  for (const k of RECORD_KEYS) if (!(k in rec)) problems.push(`missing key ${k}`);
  for (const k of Object.keys(rec)) if (!RECORD_KEYS.includes(k)) problems.push(`unknown key ${k}`);
  if (!REGISTER_IDS.includes(rec.register)) problems.push(`register ${rec.register} not in closed list`);
  if (rec.entity_class !== null && !ENTITY_CLASSES.includes(rec.entity_class)) problems.push(`entity_class ${rec.entity_class} not closed`);
  if (typeof rec.name_stem !== "string") problems.push("name_stem not a string");
  else if (rec.name_stem !== vendorStem(rec.name)) problems.push("name_stem differs from vendorStem(name)");
  if (!rec.collected_at && !rec.queried_at) problems.push("neither collected_at nor queried_at");
  if (rec.collected_at && rec.queried_at) problems.push("both collected_at and queried_at");
  if (!rec.source_url) problems.push("missing source_url");
  if (!Array.isArray(rec.flags)) problems.push("flags not an array");
  else for (const f of rec.flags) if (!FLAGS.includes(f)) problems.push(`flag ${f} not closed`);
  if (rec.register_record_id === null && !(rec.flags || []).includes("missing_record_id")) problems.push("null id without flag");
  if (!rec.raw || typeof rec.raw !== "object") problems.push("raw missing");
  return problems;
}
