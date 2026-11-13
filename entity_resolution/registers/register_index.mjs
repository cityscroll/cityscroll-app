// Committed-artifact shape, loader and lookups shared by the bulk registers. A miss (the artifact
// is valid and holds no such record) is a different answer from an invalid artifact (the file
// cannot be trusted), and both differ from a refused query (input too short to match on).

import { vendorStem } from "../normalizers/vendor_stem.mjs";
import { REGISTER_IDS, validateRecord } from "./read_contract.mjs";

export const ARTIFACT_SCHEMA = "cityscroll.entity_register.register_artifact.v1";

export function buildArtifact({ register, collected_at, source_url, records, source_row_count = null, source_receipt = null }) {
  return {
    schema: ARTIFACT_SCHEMA,
    register,
    collected_at,
    source_url,
    row_count: records.length,
    source_row_count,
    source_receipt,
    records,
  };
}

/** -> { ok:true, index } | { ok:false, status:"invalid_artifact", problems } */
export function loadArtifact(doc, { maxProblems = 20 } = {}) {
  const problems = [];
  if (!doc || typeof doc !== "object") return { ok: false, status: "invalid_artifact", problems: ["artifact is not an object"] };
  if (doc.schema !== ARTIFACT_SCHEMA) problems.push(`schema ${doc.schema} is not ${ARTIFACT_SCHEMA}`);
  if (!REGISTER_IDS.includes(doc.register)) problems.push(`register ${doc.register} not in closed list`);
  if (!Array.isArray(doc.records)) problems.push("records is not an array");
  else {
    if (doc.row_count !== doc.records.length) problems.push(`row_count ${doc.row_count} != records.length ${doc.records.length}`);
    if (!doc.collected_at) problems.push("collected_at missing");
    for (let i = 0; i < doc.records.length && problems.length < maxProblems; i++) {
      const p = validateRecord(doc.records[i]);
      if (doc.records[i]?.register !== doc.register) p.push("record register differs from artifact register");
      for (const x of p) problems.push(`record ${i}: ${x}`);
    }
  }
  if (problems.length) return { ok: false, status: "invalid_artifact", problems: problems.slice(0, maxProblems) };
  const byId = new Map();
  const byStem = new Map();
  const byExact = new Map();
  for (const rec of doc.records) {
    const ex = String(rec.name || "").trim().toUpperCase();
    if (ex) {
      if (!byExact.has(ex)) byExact.set(ex, []);
      byExact.get(ex).push(rec);
    }
    if (rec.register_record_id != null) {
      if (!byId.has(rec.register_record_id)) byId.set(rec.register_record_id, []);
      byId.get(rec.register_record_id).push(rec);
    }
    const stems = new Set([rec.name_stem]);
    for (const a of rec.published?.aliases || []) stems.add(vendorStem(a));
    for (const st of stems) {
      if (st.length < 3) continue;
      if (!byStem.has(st)) byStem.set(st, []);
      byStem.get(st).push(rec);
    }
  }
  return { ok: true, index: { register: doc.register, collected_at: doc.collected_at, row_count: doc.row_count, byId, byStem, byExact } };
}

export function lookupById(index, id) {
  const key = String(id ?? "").trim();
  if (!key) return { status: "refused", reason: "empty_id" };
  const hit = index.byId.get(key);
  if (!hit) return { status: "miss", records: [] };
  return { status: hit.length === 1 ? "found" : "several", records: hit };
}

export function lookupByStem(index, name) {
  const stem = vendorStem(name);
  if (stem.length < 3) return { status: "refused", reason: "input_too_short", query_stem: stem };
  const hit = index.byStem.get(stem);
  if (!hit) return { status: "miss", query_stem: stem, records: [] };
  const ids = new Set(hit.map((r) => r.register_record_id));
  return { status: ids.size === 1 ? "found" : "several", query_stem: stem, verdict: ids.size === 1 ? "single_stem_match" : null, records: hit };
}

/**
 * Name lookup used by the organization-search slice: exact published name first (this is the only
 * way to find a name whose stem is shorter than 3 characters, e.g. "HF, LLC"), then stem equality.
 */
export function lookupByName(index, name) {
  const exact = index.byExact.get(String(name ?? "").trim().toUpperCase());
  if (exact && exact.length) {
    const ids = new Set(exact.map((r) => r.register_record_id));
    return { status: ids.size === 1 ? "found" : "several", match_basis: "exact_name", verdict: ids.size === 1 ? "single_name_match" : null, records: exact };
  }
  const r = lookupByStem(index, name);
  return r.status === "found" || r.status === "several" ? { ...r, match_basis: "stem_equal" } : r;
}
