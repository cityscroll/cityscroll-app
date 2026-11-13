// Source readers for the organization index. Each reader turns one committed artifact into
// "contributions": { source, name, via, ref, amount, date, agency, zip, extra } where `name` is
// exactly the published string and `via` is "name" (the formal or only name) or "dba".
// An exact-record withheld name is omitted (`name_withheld`); the account, ZIP, and other
// published fields stay on an identifier key and are not given a replacement name.
// Nothing is merged here; aggregation by vendor stem happens in organization_index.mjs.
//
// Engine artifacts are read from the repository root. The certified-business directory is the
// published manifest plus row shards. Register records follow the shared register read contract.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { vendorStem } from "../../entity_resolution/normalizers/vendor_stem.mjs";
import { SOURCES, SOURCE_IDS, SOURCE_BY_ID, SOURCE_BY_CODE, CITY_AWARD_SOURCES } from "../../site/organization_index_contract.mjs";
import {
  SBS_NAME_DATASET, SBS_NAME_PUBLISHER, exactNameWithheld, loadOrganizationNameWithholdings,
} from "./organization_name_withholding.mjs";

export { SOURCES, SOURCE_IDS, SOURCE_BY_ID, SOURCE_BY_CODE, CITY_AWARD_SOURCES };

const text = (v) => (v == null ? "" : String(v));
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** "MM/DD/YYYY" or ISO -> "YYYY-MM-DD"; anything else -> null. */
export function isoDate(v) {
  const s = text(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return null;
}
/** Five-digit ZIP from a published ZIP (ZIP+4 and 4-digit New England losses handled like SBS). */
export function zip5(v) {
  const s = text(v).trim();
  const m = /^(\d{3,5})(?:-\d{4})?$/.exec(s);
  return m ? m[1].padStart(5, "0") : null;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function contribution(source, fields) {
  return {
    source,
    name: fields.name_withheld ? "" : text(fields.name),
    via: fields.via || "name",
    ref: fields.ref == null ? null : text(fields.ref),
    amount: fields.amount ?? null,
    date: fields.date ?? null,
    agency: fields.agency ?? null,
    zip: fields.zip ?? null,
    extra: fields.extra ?? null,
    name_withheld: Boolean(fields.name_withheld),
    index_key: fields.index_key || null,
  };
}

/** Engine committed artifacts. Returns { contributions, receipts }. */
export function readEngineSources(appRoot) {
  const out = [];
  const receipts = {};
  const ocp = readJson(join(appRoot, "site/data/ocp_awards_warehouse_lookup.json"));
  for (const r of ocp.rows) {
    out.push(contribution("ocp_recent_contract_awards", { name: r.vendor_name, ref: r.request_id, amount: num(r.contract_amount), date: isoDate(r.start_date), agency: r.agency_name || null }));
  }
  receipts.ocp_recent_contract_awards = { path: "site/data/ocp_awards_warehouse_lookup.json", rows: ocp.rows.length, collected_at: ocp.materialized_at, dataset_id: ocp.dataset_id };

  const dir = join(appRoot, "site/data/analytics_registered_contracts");
  const head = readJson(join(appRoot, "site/data/analytics_registered_contracts.json"));
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => /^shard-\d+\.json$/.test(x)).sort()) {
    for (const r of readJson(join(dir, f)).rows) {
      n += 1;
      out.push(contribution("checkbook_registered_contracts", {
        name: r.prime_vendor, ref: r.prime_contract_id, amount: num(r.current_registered_amount), date: isoDate(r.registration_date), agency: r.agency || null,
        extra: r.prime_vendor_mwbe_category !== undefined ? { prime_vendor_mwbe_category: r.prime_vendor_mwbe_category } : null,
      }));
    }
  }
  receipts.checkbook_registered_contracts = { path: "site/data/analytics_registered_contracts/shard-*.json", rows: n, collected_at: head.generated_at };

  const spine = readJson(join(appRoot, "site/data/procurement_spine_sources.json"));
  for (const r of spine.rows.passport_contracts || []) {
    out.push(contribution("passport_contracts", { name: r.vendor, ref: r.contract_id || r.epin, amount: num(r.current_amount ?? r.award_amount), date: isoDate(r.registration_date), agency: r.agency || null }));
  }
  for (const r of spine.rows.checkbook_contracts || []) {
    out.push(contribution("checkbook_prime_vendor_contracts", { name: r.prime_vendor, ref: r.contract_id || r.prime_contract_id, date: isoDate(r.registration_date), agency: r.agency || null, extra: { mwbe_category: r.mwbe_category ?? null } }));
  }
  for (const r of spine.rows.checkbook_nycha_contracts || []) {
    out.push(contribution("checkbook_nycha_contracts", { name: r.vendor, ref: r.contract_id || r.id, amount: num(r.current), date: isoDate(r.start), agency: r.agency || null }));
  }
  for (const r of spine.rows.checkbook_spending || []) {
    out.push(contribution("checkbook_spending", { name: r.payee_name, ref: r.document_id, amount: num(r.check_amount), date: isoDate(r.issue_date), agency: r.agency_name || null }));
  }
  for (const k of ["passport_contracts", "checkbook_prime_vendor_contracts", "checkbook_nycha_contracts", "checkbook_spending"]) {
    const key = k === "checkbook_prime_vendor_contracts" ? "checkbook_contracts" : k;
    receipts[k] = { path: `site/data/procurement_spine_sources.json rows.${key}`, rows: (spine.rows[key] || []).length, collected_at: spine.generated_at };
  }

  const db = readJson(join(appRoot, "site/data/doing_business_warehouse_lookup.json"));
  for (const r of db.rows) {
    out.push(contribution("doing_business_entities", { name: r.organization_name, ref: r.organization_name }));
  }
  receipts.doing_business_entities = { path: "site/data/doing_business_warehouse_lookup.json", rows: db.rows.length, collected_at: db.materialized_at, dataset_id: db.dataset_id };
  return { contributions: out, receipts };
}

/** Certified-business directory: <dir>/data/sbs_certified_businesses.json plus row shards. */
export function readSbsDirectory(rootDir) {
  const manifest = readJson(join(rootDir, "data/sbs_certified_businesses.json"));
  const rows = manifest.shards.flatMap((s) => readJson(join(rootDir, s.path)).rows);
  return sbsContributions(manifest, rows);
}

/**
 * True when publishing `name` would copy a withheld string: the name itself, or the
 * stem the index would store for it. Other fields and other accounts stay.
 */
function dropPublishedName(rules, account, name, publishedStem) {
  if (!name) return false;
  const identity = { publisher: SBS_NAME_PUBLISHER, dataset: SBS_NAME_DATASET, account };
  if (exactNameWithheld(rules, { ...identity, value: name })) return true;
  const derived = vendorStem(name);
  if (derived && exactNameWithheld(rules, { ...identity, value: derived })) return true;
  if (publishedStem && publishedStem === derived && exactNameWithheld(rules, { ...identity, value: publishedStem })) return true;
  return false;
}

/** Normalized certified-business rows. Formal name and DBA each count. One exact-record name may be withheld. */
export function sbsContributions(manifest, rows, rules = undefined) {
  const active = rules === undefined ? loadOrganizationNameWithholdings() : rules;
  const out = [];
  let withheldPublishedNames = 0;
  for (const r of rows) {
    const extra = { certification: r.certification || [], borough: r.borough ?? null, naics6: r.id6_digit_naics_code ?? null, nigp: r.nigp_codes || [] };
    const account = r.account_number == null ? "" : String(r.account_number);
    const dropFormal = dropPublishedName(active, account, r.vendor_formal_name, r.name_stem);
    const dropDba = dropPublishedName(active, account, r.vendor_dba, r.dba_stem);
    if (dropFormal || dropDba) withheldPublishedNames += 1;
    if (r.name_stem && r.vendor_formal_name && !dropFormal) {
      out.push(contribution("sbs_certified_businesses", { name: r.vendor_formal_name, via: "name", ref: account, zip: r.zip ?? null, extra }));
    }
    if (r.dba_stem && r.vendor_dba && !dropDba) {
      out.push(contribution("sbs_certified_businesses", { name: r.vendor_dba, via: "dba", ref: account, zip: r.zip ?? null, extra }));
    }
    const keptName = (r.name_stem && r.vendor_formal_name && !dropFormal) || (r.dba_stem && r.vendor_dba && !dropDba);
    if ((dropFormal || dropDba) && !keptName && account) {
      out.push(contribution("sbs_certified_businesses", {
        name_withheld: true, index_key: `sbs:${account}`, via: "name", ref: account, zip: r.zip ?? null, extra,
      }));
    }
  }
  return {
    contributions: out,
    withheld_published_names: withheldPublishedNames,
    receipt: { path: "site/data/sbs_certified_businesses.json", rows: rows.length, collected_at: manifest.collected_at, rows_updated_at: manifest.rows_updated_at, content_sha256: manifest.content_sha256 },
    manifest,
  };
}

/**
 * Register records (shared read contract). IRS, DOL and SCA are bulk registers; their
 * `published.aliases` (DOL dba_name) become "dba" contributions. DOS is on demand and not indexed.
 */
export function registerContributions(records) {
  const out = [];
  for (const rec of records) {
    if (!rec.name_stem) continue;
    const z = zip5(rec.address?.zip);
    const extra = { entity_class: rec.entity_class ?? null, status: rec.status ?? null, ntee: rec.published?.ntee_cd ?? null };
    out.push(contribution(rec.register, { name: rec.name, via: "name", ref: rec.register_record_id, zip: z, extra }));
    for (const a of rec.published?.aliases || []) {
      out.push(contribution(rec.register, { name: a, via: "dba", ref: rec.register_record_id, zip: z, extra }));
    }
  }
  return out;
}
