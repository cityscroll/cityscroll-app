// Organization record: for one entityRef (org:{stem} or org:{stem}#{kind}:{id}) every published fact
// from every source that carries the stem, one block per source record, each with its source name,
// source URL, record id and collection (or query) date. Blocks are side by side; nothing is merged.
//
// Dependencies are injected so the same code runs in the Worker (KV, Pages fetch, data.ny.gov) and in
// tests (recorded files):
//   sbs:           { directory, getByAccount }            certified-business lookup over the static directory
//   vendorProfile: async (stem) -> { status: "present", generated, profile } | { status: "not_available", reason }
//   doingBusiness: (stem) -> rows[] from site/data/doing_business_warehouse_lookup.json with that stem
//   registers:     { irs_eo_bmf_ny, nys_dol_contractor_registry, nyc_sca_prequalified_firms } -> { byId }
//   dosCommitted:  { byId, byStem } from the committed New York State vendor lookup (snapshot)
// The live state-register answer is not fetched here (the record is served by the snapshot-only
// /vendor-profile route); stateRegisterBlocks/withLiveStateRegister merge the /org-register/dos answer.

import { SOURCE_BY_ID, CITY_AWARD_SOURCES } from "./organization_index_contract.mjs";
import { entriesFor, ordinalForStem, parseEntityRef, sourceLinks, READER_STRINGS } from "./organization_search.mjs";

export const RECORD_SCHEMA = "cityscroll.organization_record.v1";
export const BLOCK_KINDS = Object.freeze([
  "sbs_certified_business", "city_awards", "city_record_vendor_profile", "doing_business", "checkbook_mwbe_category",
  "irs_exempt_organization", "state_register", "dol_contractor_registry", "sca_prequalified_firm",
]);
export const BLOCK_STATUSES = Object.freeze(["present", "no_match", "provider_unavailable", "not_available"]);
export const BLOCK_HEADINGS = Object.freeze({
  sbs_certified_business: "City-certified business (SBS Certified Business List)",
  city_awards: "City contracts and awards",
  city_record_vendor_profile: "Award notices in the City Record",
  doing_business: "Doing Business Search",
  checkbook_mwbe_category: "M/WBE category as Checkbook NYC records it",
  irs_exempt_organization: "Tax-exempt organization (IRS)",
  state_register: "New York State corporation and business entity record",
  dol_contractor_registry: "NYS Department of Labor Contractor Registry",
  sca_prequalified_firm: "School Construction Authority prequalified firm",
});
export const BLOCK_STATUS_TEXT = Object.freeze({
  no_match: "This source has no record under this name.",
  provider_unavailable: "This source did not answer just now. The rest of the record is shown.",
  not_available: "This source is not available right now.",
});

const STATE_COMMON = Object.freeze({ source: "ny_dos_entities", source_label: "NYS Department of State active corporations and business entities (data.ny.gov n9v6-gdp6)", source_url: "https://data.ny.gov/d/n9v6-gdp6" });

/**
 * State-register blocks from a registers lookup result (lookupDosByName / lookupDosById envelope, as the
 * /org-register/dos route returns it). A failure marks this block only; every other block stays.
 */
export function stateRegisterBlocks(r) {
  if (!r || r.status === "source_unavailable") return [block("state_register", { ...STATE_COMMON, status: "provider_unavailable", record_id: null, queried_at: null, reason: r?.reason ?? "no_response", status_text: BLOCK_STATUS_TEXT.provider_unavailable })];
  if (r.status === "no_match") return [block("state_register", { ...STATE_COMMON, status: "no_match", record_id: null, queried_at: r.queried_at ?? null, reason: "register_answered_no_row", status_text: BLOCK_STATUS_TEXT.no_match })];
  if (r.status === "refused" || r.status === "query_rejected") return [block("state_register", { ...STATE_COMMON, status: "not_available", record_id: null, queried_at: r.queried_at ?? null, reason: r.reason ?? r.status, status_text: BLOCK_STATUS_TEXT.not_available })];
  return r.records.map((rec) => block("state_register", { ...STATE_COMMON, record_id: rec.register_record_id, queried_at: rec.queried_at, lookup_status: r.status, match_basis: rec.match_basis, link_policy: "candidate_only", record: rec }));
}

/** Replace the snapshot state blocks of a record with a live registers answer (reader-side composition). */
export function withLiveStateRegister(record, lookupResult) {
  if (!record?.blocks) return record;
  return { ...record, blocks: [...record.blocks.filter((b) => b.block !== "state_register"), ...stateRegisterBlocks(lookupResult)] };
}

const collectedAt = (index, id) => index.manifest.sources.find((s) => s.id === id)?.receipt?.collected_at ?? null;

/**
 * Published SBS fields for one organization record. A name-withheld entry keeps every other
 * published field and omits the formal name and stem. A DBA is omitted only when it is that
 * same value. Nothing is written in their place.
 */
export function sbsFieldsForRecord(row, entry) {
  if (!entry?.name_withheld || !row || typeof row !== "object") return row;
  const fields = { ...row };
  const formal = fields.vendor_formal_name;
  const stem = fields.name_stem;
  delete fields.vendor_formal_name;
  delete fields.name_stem;
  if (fields.vendor_dba != null && (fields.vendor_dba === formal || fields.vendor_dba === stem)) delete fields.vendor_dba;
  if (fields.dba_stem != null && (fields.dba_stem === formal || fields.dba_stem === stem)) delete fields.dba_stem;
  return fields;
}

function block(kind, fields) {
  return { block: kind, heading: BLOCK_HEADINGS[kind], status: "present", ...fields };
}

export async function assembleOrganizationRecord(opened, ref, deps = {}) {
  if (!opened || opened.status !== "ok") return { schema: RECORD_SCHEMA, ok: false, status: "not_indexed", reason: opened?.reason ?? "index_not_open", message: READER_STRINGS.status.not_indexed };
  const p = parseEntityRef(ref);
  if (!p.ok) return { schema: RECORD_SCHEMA, ok: false, status: "query_refused", reason: p.reason, message: READER_STRINGS.status.query_refused };
  const index = opened.index;
  const o = ordinalForStem(index, p.stem);
  if (o < 0) return { schema: RECORD_SCHEMA, ok: true, status: "no_match", entity_ref: ref, message: READER_STRINGS.status.no_match, blocks: [] };
  const loaded = await entriesFor(index, [o]);
  if (loaded.error) return { schema: RECORD_SCHEMA, ok: false, status: "not_indexed", reason: loaded.error, message: READER_STRINGS.status.not_indexed };
  const entry = loaded.entries.get(o);
  if (p.source_record && p.source_record.kind !== "dos" && !(entry.ids[p.source_record.kind] || []).includes(p.source_record.id)) {
    return { schema: RECORD_SCHEMA, ok: true, status: "no_match", reason: "source_record_not_on_entry", entity_ref: ref, message: READER_STRINGS.status.no_match, blocks: [] };
  }
  const blocks = [];

  // SBS: one block per account, every published field as published.
  for (const acct of entry.ids.sbs || []) {
    if (!deps.sbs) { blocks.push(block("sbs_certified_business", { status: "not_available", source: "sbs_certified_businesses", source_label: SOURCE_BY_ID.sbs_certified_businesses.label, source_url: SOURCE_BY_ID.sbs_certified_businesses.url, record_id: acct, collected_at: collectedAt(index, "sbs_certified_businesses"), reason: "sbs_directory_not_configured" })); continue; }
    const r = deps.sbs.getByAccount(deps.sbs.directory, acct);
    if (r.status === "found") {
      const hit = r.results[0];
      blocks.push(block("sbs_certified_business", {
        source: "sbs_certified_businesses", source_label: SOURCE_BY_ID.sbs_certified_businesses.label,
        source_url: hit.source_url, dataset_url: hit.dataset_url, record_id: acct,
        collected_at: hit.collected_at, publisher_updated_at: hit.rows_updated_at,
        listed_under_this_name_as: entry.sources.sbs_certified_businesses.via,
        fields: sbsFieldsForRecord(hit.row, entry),
      }));
    } else {
      blocks.push(block("sbs_certified_business", { status: r.status === "not_found" ? "no_match" : "not_available", source: "sbs_certified_businesses", source_label: SOURCE_BY_ID.sbs_certified_businesses.label, source_url: SOURCE_BY_ID.sbs_certified_businesses.url, record_id: acct, collected_at: collectedAt(index, "sbs_certified_businesses"), reason: r.reason ?? null }));
    }
  }

  // City awards: one block per award source the index carries (counts, totals, latest, record ids).
  for (const id of CITY_AWARD_SOURCES.concat(["checkbook_spending"])) {
    const s = entry.sources[id];
    if (!s) continue;
    blocks.push(block("city_awards", {
      source: id, source_label: SOURCE_BY_ID[id].label, source_url: SOURCE_BY_ID[id].url,
      record_id: s.refs[0] ?? null, record_ids: s.refs, record_count: s.ref_count, rows: s.records,
      amount_total: s.amount_total, latest_date: s.last_date, collected_at: collectedAt(index, id),
    }));
  }
  // The existing vendor profile (City Record award notices folded daily into KV): agencies, recent notices.
  if (deps.vendorProfile) {
    const vp = await deps.vendorProfile(entry.stem);
    blocks.push(vp.status === "present"
      ? block("city_record_vendor_profile", { source: "city_record_vendor_profile", source_label: "City Record Online award notices (daily vendor profile)", source_url: "https://data.cityofnewyork.us/d/dg92-zbpx", record_id: entry.stem, collected_at: vp.generated, profile: vp.profile })
      : block("city_record_vendor_profile", { status: vp.status === "no_match" ? "no_match" : "not_available", source: "city_record_vendor_profile", source_label: "City Record Online award notices (daily vendor profile)", source_url: "https://data.cityofnewyork.us/d/dg92-zbpx", record_id: entry.stem, collected_at: null, reason: vp.reason ?? null }));
  }

  // Doing Business Search entities: every published field of each row on this stem.
  if (entry.sources.doing_business_entities && deps.doingBusiness) {
    for (const row of deps.doingBusiness(entry.stem)) {
      blocks.push(block("doing_business", { source: "doing_business_entities", source_label: SOURCE_BY_ID.doing_business_entities.label, source_url: SOURCE_BY_ID.doing_business_entities.url, record_id: row.organization_name, collected_at: collectedAt(index, "doing_business_entities"), fields: row }));
    }
  }

  // Checkbook M/WBE category of the prime vendor, as Checkbook records it.
  const mw = entry.sources.checkbook_prime_vendor_contracts?.mwbe_categories || entry.sources.checkbook_registered_contracts?.mwbe_categories;
  if (mw) {
    const src = entry.sources.checkbook_prime_vendor_contracts ? "checkbook_prime_vendor_contracts" : "checkbook_registered_contracts";
    blocks.push(block("checkbook_mwbe_category", { source: src, source_label: SOURCE_BY_ID[src].label, source_url: SOURCE_BY_ID[src].url, record_id: entry.sources[src].refs[0] ?? null, record_ids: entry.sources[src].refs, collected_at: collectedAt(index, src), prime_vendor_mwbe_category: mw, label_note: "This is the category Checkbook NYC records for the prime vendor on these contracts." }));
  }

  // Bulk registers (IRS, DOL, SCA): full read-contract record per id.
  const regs = [["irs_eo_bmf_ny", "ein", "irs_exempt_organization"], ["nys_dol_contractor_registry", "dol", "dol_contractor_registry"], ["nyc_sca_prequalified_firms", "sca", "sca_prequalified_firm"]];
  for (const [reg, kind, blk] of regs) {
    for (const id of entry.ids[kind] || []) {
      const ix = deps.registers?.[reg];
      const hit = ix ? ix.byId.get(id) : null;
      if (!hit) { blocks.push(block(blk, { status: ix ? "no_match" : "not_available", source: reg, source_label: SOURCE_BY_ID[reg].label, source_url: SOURCE_BY_ID[reg].url, record_id: id, collected_at: collectedAt(index, reg) })); continue; }
      for (const rec of hit) blocks.push(block(blk, { source: reg, source_label: SOURCE_BY_ID[reg].label, source_url: rec.source_url, record_id: rec.register_record_id, collected_at: rec.collected_at, record: rec }));
    }
  }

  // State register, snapshot: the committed New York State lookup for indexed vendor stems.
  // The live answer comes from the registers route and is merged by stateRegisterBlocks (below).
  if (deps.dosCommitted) {
    const hit = deps.dosCommitted.byStem.get(entry.stem) || [];
    if (hit.length) for (const rec of hit) blocks.push(block("state_register", { ...STATE_COMMON, record_id: rec.register_record_id, queried_at: rec.queried_at, lookup_status: hit.length === 1 ? "one_match" : "several_matches", match_basis: "stem_equal", link_policy: "candidate_only", record: rec }));
    else blocks.push(block("state_register", { ...STATE_COMMON, status: "not_available", record_id: null, queried_at: null, reason: "not_in_committed_state_lookup", ...(entry.display_name ? { on_demand: `/org-register/dos?name=${encodeURIComponent(entry.display_name)}` } : {}), status_text: BLOCK_STATUS_TEXT.not_available }));
  }

  return {
    schema: RECORD_SCHEMA,
    ok: true,
    status: "found",
    entity_ref: ref,
    requested_source_record: p.source_record,
    stem: entry.stem,
    display_name: entry.display_name,
    names: entry.names,
    sources: entry.source_ids,
    links: sourceLinks(entry),
    facets: entry.facets,
    identity_note: READER_STRINGS.identity_note,
    index_generation: index.manifest.generation,
    blocks,
  };
}
