// Depot join-graph model and post-ingest re-derivation.
//
// The gap taxonomy registry is the depot: sources declare join keys, crosswalks
// declare realized or candidate edges, and re-derivation refreshes coverage +
// ranking from measured join_measurement on source contracts.
//
//   import { rederiveDepot, renderGapTaxonomyDocument } from "./depot.mjs";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const GAP_TAXONOMY_PATH = fileURLToPath(new URL("../site/data/gap_taxonomy.json", import.meta.url));
export const SOURCE_CONTRACTS_PATH = fileURLToPath(new URL("../site/data/source_contracts.json", import.meta.url));
export const GAP_DOC_PATH = fileURLToPath(new URL("../docs/gap-taxonomy.md", import.meta.url));
export const DEPOT_RECEIPT_DIR = fileURLToPath(new URL("../site/data/depot_receipts/", import.meta.url));

export const SCHEMA_VERSION = 2;

export const FUTURE_WORK_DISPOSITIONS = new Set(["open"]);

/**
 * Key spaces a public catalog can make obtainable before a source is admitted
 * to the depot.  These are deliberately broader than the current source
 * declarations: a bootstrap ranking must be able to reward a dataset for
 * introducing a canonical key that no committed source has declared yet.
 */
export const OBTAINABLE_KEY_SPACES = [
  {
    id: "exam_number",
    entity_type: "exam",
    fields: ["exam_no", "exam_number", "exam_number_code"],
    canonical_keys: ["exam_number", "exam_no"],
    weight: 8,
  },
  {
    id: "civil_service_title_code",
    entity_type: "civil_service_title",
    fields: ["title_code", "title_code_no", "list_title_code", "civil_service_title_code"],
    canonical_keys: ["title_code", "title_code_no", "list_title_code"],
    weight: 8,
  },
  {
    id: "civil_service_title",
    entity_type: "civil_service_title",
    fields: ["civil_service_title", "list_title_desc", "civil_service_title_description"],
    canonical_keys: ["civil_service_title", "list_title_desc"],
    weight: 5,
  },
  {
    id: "agency",
    entity_type: "agency",
    fields: ["agency", "agency_name", "list_agency_code", "list_agency_desc"],
    canonical_keys: ["agency", "agency_name", "list_agency_code", "list_agency_desc"],
    weight: 3,
  },
  {
    id: "request_id",
    entity_type: "notice",
    fields: ["request_id", "request_number", "record_id"],
    canonical_keys: ["request_id"],
    weight: 5,
  },
  {
    id: "contract_id",
    entity_type: "contract",
    fields: ["contract_id", "prime_contract_id", "ct_contract_id"],
    canonical_keys: ["contract_id"],
    weight: 6,
  },
  {
    id: "pin",
    entity_type: "procurement",
    fields: ["pin", "prime_pin", "procurement_id"],
    canonical_keys: ["PIN"],
    weight: 6,
  },
  {
    id: "bbl",
    entity_type: "parcel",
    fields: ["bbl", "borough_block_lot"],
    canonical_keys: ["BBL"],
    weight: 6,
  },
];

function normalizeCatalogField(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function catalogResource(row) {
  return row?.resource || row || {};
}

/**
 * Infer candidate-only key spaces from catalog metadata.  This uses field
 * names, not row values, so it can rank an obtainable source without implying
 * that any row-level join has been measured.
 */
export function inferObtainableKeySpaces(row) {
  const resource = catalogResource(row);
  const fields = new Set([
    ...(resource.columns_field_name || []),
    ...(resource.columns_name || []),
  ].map(normalizeCatalogField));

  return OBTAINABLE_KEY_SPACES
    .map((space) => {
      const matched_fields = space.fields.filter((field) => fields.has(normalizeCatalogField(field)));
      if (!matched_fields.length) return null;
      return {
        id: space.id,
        entity_type: space.entity_type,
        matched_fields,
        canonical_keys: [...space.canonical_keys],
      };
    })
    .filter(Boolean);
}

function obtainableBundleScore(keySpaces) {
  const ids = new Set(keySpaces.map((space) => space.id));
  let score = 0;
  if (ids.has("exam_number") && ids.has("agency")) score += 7;
  if (ids.has("civil_service_title_code") && ids.has("civil_service_title") && ids.has("agency")) score += 10;
  return score;
}

/**
 * Rank public catalog resources using obtainable key spaces first.  Committed
 * source overlap is reported as supporting evidence only; it cannot be the
 * condition that makes a candidate visible.
 */
export function rankObtainableCatalogCandidates(rows = [], { sources = [] } = {}) {
  const committedKeys = new Set(sources.flatMap((source) => source.join_keys || []));
  return rows.map((row) => {
    const resource = catalogResource(row);
    const key_spaces = inferObtainableKeySpaces(resource);
    const obtainable_key_space_score = key_spaces.reduce((sum, space) => {
      const definition = OBTAINABLE_KEY_SPACES.find((candidate) => candidate.id === space.id);
      return sum + (definition?.weight || 0);
    }, 0) + obtainableBundleScore(key_spaces);
    const committed_key_overlap = key_spaces.flatMap((space) => (
      space.canonical_keys.filter((key) => committedKeys.has(key))
    ));
    const score = obtainable_key_space_score + Math.min(committed_key_overlap.length, 2);

    return {
      dataset_id: resource.id || null,
      name: resource.name || null,
      score,
      obtainable_key_space_score,
      committed_key_overlap,
      key_spaces,
      candidate_status: "candidate",
      coverage_status: "unknown_until_reviewed",
      evidence: "Socrata catalog column metadata only; no row-level join coverage measured.",
      landing_page: resource.id ? `https://data.cityofnewyork.us/d/${resource.id}` : null,
    };
  })
    .filter((candidate) => candidate.key_spaces.length > 0)
    .sort((a, b) => (b.score - a.score)
      || (b.obtainable_key_space_score - a.obtainable_key_space_score)
      || String(a.dataset_id).localeCompare(String(b.dataset_id)));
}

/** Canonical join-key aliases used for graph edges (case-insensitive match). */
export const KEY_ALIASES = {
  pin: "PIN",
  prime_pin: "PIN",
  procurement_id: "PIN",
  epin: "EPIN",
  contract_id: "contract_id",
  prime_contract_id: "contract_id",
  ct_contract_id: "contract_id",
  "ct contract id": "contract_id",
  ctr_id: "contract_id",
  request_id: "request_id",
  exam_number: "exam_number",
  bbl: "BBL",
  bin: "BIN",
  matter_id: "matter_id",
  "matter file": "matter_id",
  event_id: "event_id",
  event_item_id: "event_item_id",
  project_id: "project_id",
  ulurp_numbers: "ulurp_numbers",
  ulurp_number: "ulurp_numbers",
  ulurp_number_s: "ulurp_numbers",
  ulurp_application_number: "ulurp_numbers",
  job_number: "job_number",
  bid_number: "bid_number",
  agency: "agency",
  agency_name: "agency",
  "agency/body": "agency",
};

/**
 * Seed join keys for source-contract ids when the contract row has not yet
 * declared them. Measured keys from live product code only — not guesses.
 */
export const SEED_SOURCE_JOIN_KEYS = {
  "city-record": ["PIN", "request_id", "agency"],
  "checkbook-contracts": ["PIN", "contract_id"],
  "checkbook-spending": ["PIN", "contract_id"],
  "checkbook-nycha-contracts": ["contract_id"],
  "passport-public-contracts": ["EPIN", "PIN", "contract_id"],
  "passport-public-rfx": ["EPIN", "PIN"],
  "nyc-council-legistar": ["matter_id", "event_id", "event_item_id", "agency"],
  "city-council-meetings-open-data": ["event_id", "agency", "event_title", "start_time"],
  "dcas-annual-exam-outcomes": ["exam_number"],
  "dcas-exam-notices": ["exam_number"],
  "zap-projects": ["project_id", "BBL", "ulurp_numbers"],
  "zap-bbl": ["BBL", "project_id"],
  "mappluto": ["BBL"],
  "dob-now-job-filings": ["BBL", "BIN", "job_number"],
  "legacy-dob-job-filings": ["BBL", "BIN", "job_number"],
  "nycida-build-nyc-projects": ["request_id", "project_id"],
  "nyc-rules-rss": ["agency"],
  "bid-tabulations-historical": ["bid_number", "PIN"],
  "zap-api-outcomes": ["project_id", "ulurp_numbers"],
  "doing-business-entities": ["organization_name", "vendor_name"],
  "ulurp-recommendations": ["ulurp_numbers"],
  "ulurp-recommendation-pdfs": ["ulurp_numbers"],
};

/**
 * Known materialized crosswalks (already shipped in product code).
 * Coverage is filled from join_measurement when present.
 */
export const SEED_MATERIALIZED_CROSSWALKS = [
  {
    id: "city-record-pin-x-passport-contracts-epin",
    source_a: "city-record",
    source_b: "passport-public-contracts",
    key_path: ["PIN", "EPIN"],
    status: "materialized",
    lineage: {
      code: "worker/src/lib/passport_join.mjs",
      strategy: "exact | pin_strip_suffix | pin_prefix_of_epin | epin_prefix_of_pin",
      measurement_contract: "passport-public-contracts",
      measurement_rate_key: "all_notices_to_contracts",
    },
  },
  {
    id: "city-record-pin-x-passport-rfx-epin",
    source_a: "city-record",
    source_b: "passport-public-rfx",
    key_path: ["PIN", "EPIN"],
    status: "materialized",
    lineage: {
      code: "worker/src/lib/passport_join.mjs",
      strategy: "exact | pin_strip_suffix | pin_prefix_of_epin | epin_prefix_of_pin",
      measurement_contract: "passport-public-rfx",
      measurement_rate_key: "solicitation_to_rfx",
    },
  },
  {
    id: "city-record-pin-x-checkbook-contracts",
    source_a: "city-record",
    source_b: "checkbook-contracts",
    key_path: ["PIN"],
    status: "materialized",
    lineage: {
      code: "worker/src/checkbook_lifecycle.mjs",
      strategy: "PIN lookup against Checkbook Contracts feed",
    },
  },
  {
    id: "city-record-pin-x-checkbook-spending",
    source_a: "city-record",
    source_b: "checkbook-spending",
    key_path: ["PIN"],
    status: "materialized",
    lineage: {
      code: "worker/src/checkbook_lifecycle.mjs",
      strategy: "PIN lookup against Checkbook Spending feed",
    },
  },
  {
    id: "exam-number-x-dcas-outcomes",
    source_a: "dcas-exam-notices",
    source_b: "dcas-annual-exam-outcomes",
    key_path: ["exam_number"],
    status: "materialized",
    lineage: {
      code: "tools/build_staffing_exams.mjs",
      strategy: "exact exam_number on precomputed staffing_exams artifact",
    },
  },
  {
    id: "city-record-request-x-nycida-projects",
    source_a: "city-record",
    source_b: "nycida-build-nyc-projects",
    key_path: ["request_id"],
    status: "materialized",
    lineage: {
      code: "worker/src/lib/subsidy_lifecycle.mjs",
      strategy: "request_id plus fuzzy name/address fallback",
    },
  },
  {
    id: "city-record-x-legistar-events",
    source_a: "city-record",
    source_b: "nyc-council-legistar",
    key_path: ["event_date", "committee/body_name_in_notice_title"],
    status: "materialized",
    lineage: {
      code: "worker/src/lib/legistar_join.mjs",
      strategy: "exact_date_body_tokens (EventBodyName + EventDate); nested EventItems → Votes/Attachments under LEGISTAR_API_TOKEN",
      measurement_contract: "nyc-council-legistar",
      measurement_rate_key: "modern_notices_strict",
    },
  },
  {
    id: "zap-project-x-bbl",
    source_a: "zap-projects",
    source_b: "zap-bbl",
    key_path: ["project_id", "BBL"],
    status: "materialized",
    lineage: {
      code: "worker/src/property.mjs",
      strategy: "project_id + BBL lot expansion",
    },
  },
  {
    id: "zap-projects-x-zap-api-outcomes",
    source_a: "zap-projects",
    source_b: "zap-api-outcomes",
    key_path: ["project_id"],
    status: "materialized",
    lineage: {
      code: "worker/src/lib/zap_outcomes.mjs",
      strategy: "exact_project_id Open Data → ZAP API project detail (documents, dispositions, actions)",
      measurement_contract: "zap-api-outcomes",
      measurement_rate_key: "ulurp_complete_useful_outcome",
    },
  },
  {
    id: "zap-bbl-x-dob-now-filings",
    source_a: "zap-bbl",
    source_b: "dob-now-job-filings",
    key_path: ["BBL"],
    status: "materialized",
    lineage: {
      code: "worker/src/zap_outcomes.mjs",
      strategy: "exact_bbl tax lots → DOB NOW filings side-car on land outcomes",
      measurement_contract: "zap-api-outcomes",
      measurement_rate_key: "complete_sample_dob_any_filing",
    },
  },
  {
    id: "city-record-vendor-x-doing-business-entities",
    source_a: "city-record",
    source_b: "doing-business-entities",
    key_path: ["vendor_name", "organization_name"],
    status: "materialized",
    lineage: {
      code: "worker/src/lib/doing_business_join.mjs",
      strategy: "vendor_stem (product vendorStem on organization_name equals vendorStem(vendor_name))",
      measurement_contract: "doing-business-entities",
      measurement_rate_key: "modern_awards_stem_notices",
    },
  },
];

/** Pre-landing predicted join grades retained for comparison against realized rates. */
export const PREDICTED_JOIN_GRADES = {
  "passport-public-contracts": {
    grade: "high-risk",
    note: "Pre-landing estimate: EPIN↔PIN strictness unknown; weak prefix joins risk false matches.",
  },
  "passport-public-rfx": {
    grade: "high-risk",
    note: "Pre-landing estimate: solicitation EPINs expected to join less cleanly than awards.",
  },
  "dcas-annual-exam-outcomes": {
    grade: "medium",
    note: "exam_number collisions across years; aggregate-only privacy must hold.",
  },
  "bid-tabulations-historical": {
    grade: "high-risk",
    note: "Pre-recon estimate: bid_number rarely equals City Record PIN; historical coverage only.",
  },
  "doing-business-entities": {
    grade: "medium",
    note: "Pre-recon estimate: organization name normalization against award vendor_name.",
  },
  "ulurp-recommendations": {
    grade: "high-risk",
    note: "Pre-recon estimate: borough-scoped historical BP recommendations; tiny absolute N vs citywide ZAP ULURP projects.",
  },
  "ulurp-recommendation-pdfs": {
    grade: "high-risk",
    note: "Pre-recon estimate: small historical PDF companion; not a citywide live letter feed.",
  },
};

export function loadGapTaxonomy(path = GAP_TAXONOMY_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadSourceContracts(path = SOURCE_CONTRACTS_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function canonicalizeJoinKey(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  // Preserve known canonical forms
  if (s === "PIN" || s === "EPIN" || s === "BBL" || s === "BIN") return s;
  return s.replace(/\s+/g, "_");
}

export function canonicalizeJoinKeys(keys) {
  const out = [];
  const seen = new Set();
  for (const raw of keys || []) {
    const k = canonicalizeJoinKey(raw);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function contractById(sourceContracts) {
  const map = new Map();
  for (const c of sourceContracts?.contracts || []) map.set(c.id, c);
  return map;
}

function stablePairId(a, b, keys) {
  const [left, right] = [a, b].sort();
  const keyPart = [...keys].sort().join("+");
  return `${left}-x-${right}-via-${keyPart}`;
}

function measurementCoverage(contract, rateKey) {
  const jm = contract?.join_measurement;
  if (!jm) return null;
  const rates = jm.rates || {};
  const pick = rateKey && rates[rateKey]
    ? { key: rateKey, ...rates[rateKey] }
    : pickPrimaryRate(rates);
  if (!pick) return null;
  return {
    rate: pick.rate,
    joined: pick.joined,
    total: pick.total,
    metric: pick.key,
    observed_on: jm.observed_on || null,
    universe: jm.universe || null,
    strategy: jm.strategy || null,
    verdict: jm.verdict || null,
    source: "source_contracts.join_measurement",
  };
}

function pickPrimaryRate(rates) {
  const preferred = [
    "either_contracts_or_rfx",
    "all_notices_to_contracts",
    "all_notices_to_rfx",
    "award_to_contracts",
    "solicitation_to_rfx",
    // Bid tabulations recon (disabled source; keep modern headline)
    "modern_notices_strict",
    "historical_notices_strict",
    // Doing Business vendor identity enrichment
    "modern_awards_stem_notices",
    "modern_awards_stem_vendors",
    // ULURP recommendations recon (disabled; ZAP-side either-source headline)
    "zap_ulurp_numbered_either",
    "zap_ulurp_numbered_recommendations",
    "zap_ulurp_numbered_pdfs",
    "ulurp_complete_useful_outcome",
    "mixed_sample_any_documents",
    "complete_sample_dob_any_filing",
  ];
  for (const key of preferred) {
    if (rates[key]) return { key, ...rates[key] };
  }
  const first = Object.entries(rates)[0];
  if (!first) return null;
  return { key: first[0], ...first[1] };
}

function sourceStatus(contract) {
  if (!contract) return "unknown";
  if (contract.status === "disabled") return "disabled";
  if (contract.status === "live" || contract.status === "build-time" || contract.status === "manual") {
    return contract.delivery_tier === "edge-materialized" || contract.delivery_tier === "inline-at-build"
      ? "landed"
      : "live-only";
  }
  return contract.status || "unknown";
}

function slugifyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

/**
 * Map free-text source names from gap rows onto source-contract ids when possible.
 */
export function resolveSourceId(name, contractsById) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  const rules = [
    [/passport.*contract/, "passport-public-contracts"],
    [/passport.*rfx|passport.*solicit/, "passport-public-rfx"],
    [/checkbook.*spend/, "checkbook-spending"],
    [/checkbook/, "checkbook-contracts"],
    [/city record/, "city-record"],
    [/council meetings.*open data|m48u-yjt8/, "city-council-meetings-open-data"],
    [/legistar/, "nyc-council-legistar"],
    [/dcas.*outcome|exam outcome/, "dcas-annual-exam-outcomes"],
    [/dcas.*exam|open.?competitive/, "dcas-exam-notices"],
    [/nycida|build nyc/, "nycida-build-nyc-projects"],
    [/zap api|zap-api-outcomes|decision document/, "zap-api-outcomes"],
    [/zap/, "zap-projects"],
    [/dob now|dob-now/, "dob-now-job-filings"],
    [/current solicitations|3khw-qi8f/, "current-solicitations-ocp"],
    [/recent contract awards|qyyg-4tf5/, "ocp-recent-contract-awards"],
    [/bid tabulation|9k82-ys7w/, "bid-tabulations-historical"],
    [/doing business|72mk-a8z7/, "doing-business-entities"],
    [/abo|authorities budget/, "abo-local-authorities"],
  ];
  for (const [re, id] of rules) {
    if (re.test(n)) {
      if (contractsById.has(id) || id.includes("-ocp") || id.includes("bid-") || id.includes("doing-")) {
        return id;
      }
    }
  }
  // Fall back to exact contract name match
  for (const [id, c] of contractsById) {
    if (String(c.name || "").toLowerCase() === n) return id;
  }
  return `unregistered-${slugifyName(name)}`;
}

function collectDepotSources(registry, sourceContracts) {
  const byId = contractById(sourceContracts);
  const sources = new Map();

  function upsert(id, patch) {
    const prev = sources.get(id) || {
      id,
      name: id,
      source_contract_id: byId.has(id) ? id : null,
      status: "unknown",
      join_keys: [],
      join_coverage: {},
    };
    const keys = canonicalizeJoinKeys([...(prev.join_keys || []), ...(patch.join_keys || [])]);
    const next = {
      ...prev,
      ...patch,
      id,
      join_keys: keys,
      join_coverage: { ...(prev.join_coverage || {}), ...(patch.join_coverage || {}) },
    };
    if (patch.name && prev.name && prev.name !== id && patch.name === id) {
      next.name = prev.name;
    }
    sources.set(id, next);
  }

  // Seed from source contracts
  for (const contract of sourceContracts.contracts || []) {
    const seedKeys = SEED_SOURCE_JOIN_KEYS[contract.id] || [];
    const declared = contract.join_keys || [];
    upsert(contract.id, {
      name: contract.name,
      source_contract_id: contract.id,
      status: sourceStatus(contract),
      join_keys: [...declared, ...seedKeys],
      landing_page: contract.landing_page || null,
      delivery_tier: contract.delivery_tier || null,
    });
  }

  // Preserve hand-authored sources from an existing depot registry.
  // When a source contract exists, its landing_page / delivery_tier / status win
  // so a moved publisher URL does not stay stuck on a stale depot copy.
  for (const src of registry.sources || []) {
    if (!src?.id) continue;
    if (src.id === "recent-contract-awards-ocp") continue;
    const fromContract = byId.get(src.id);
    upsert(src.id, {
      name: src.name || src.id,
      source_contract_id: src.source_contract_id ?? (byId.has(src.id) ? src.id : null),
      status: fromContract ? sourceStatus(fromContract) : src.status,
      join_keys: src.join_keys || [],
      landing_page: fromContract?.landing_page || src.landing_page,
      delivery_tier: fromContract?.delivery_tier || src.delivery_tier,
      join_coverage: src.join_coverage || {},
    });
  }

  // Harvest from gap public_source / also_published
  for (const gap of registry.gaps || []) {
    const pubs = [gap.public_source, ...(gap.also_published || [])].filter(Boolean);
    for (const pub of pubs) {
      const id = resolveSourceId(pub.name, byId);
      upsert(id, {
        name: pub.name,
        join_keys: pub.join_keys || [],
        landing_page: pub.landing_page || null,
        status: byId.has(id) ? sourceStatus(byId.get(id)) : "not_ingested",
      });
    }
  }

  // Attach predicted grades + realized measurement from source contracts
  for (const [id, src] of sources) {
    const contract = byId.get(id);
    const predicted = PREDICTED_JOIN_GRADES[id] || src.join_coverage?.predicted || null;
    let realized = null;
    if (contract?.join_measurement) {
      // For passport pair, surface the either-source headline when available
      if (id === "passport-public-contracts" || id === "passport-public-rfx") {
        const rfx = byId.get("passport-public-rfx");
        const either = rfx?.join_measurement?.rates?.either_contracts_or_rfx;
        if (either && id === "passport-public-rfx") {
          realized = {
            rate: either.rate,
            joined: either.joined,
            total: either.total,
            metric: "either_contracts_or_rfx",
            observed_on: rfx.join_measurement.observed_on,
            universe: rfx.join_measurement.universe,
            strategy: rfx.join_measurement.strategy,
            verdict: rfx.join_measurement.verdict,
            source: "source_contracts.join_measurement",
          };
        } else {
          realized = measurementCoverage(contract, "all_notices_to_contracts")
            || measurementCoverage(contract, null);
        }
      } else {
        realized = measurementCoverage(contract, null);
      }
    } else if (src.join_coverage?.realized) {
      realized = src.join_coverage.realized;
    }

    src.join_coverage = {};
    if (predicted) src.join_coverage.predicted = predicted;
    if (realized) src.join_coverage.realized = realized;
  }

  return [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function coverageFromLineage(crosswalk, byId) {
  const mid = crosswalk.lineage?.measurement_contract;
  const rateKey = crosswalk.lineage?.measurement_rate_key;
  if (!mid) return crosswalk.realized_coverage || null;
  const contract = byId.get(mid);
  return measurementCoverage(contract, rateKey) || crosswalk.realized_coverage || null;
}

function gapsForSourcePairSimple(registry, idA, idB, sharedKeys, nameIndex) {
  const closed = [];
  for (const gap of registry.gaps || []) {
    if (gap.class !== "not_yet_ingested") continue;
    const pubs = [gap.public_source, ...(gap.also_published || [])].filter(Boolean);
    const pubIds = pubs.map((p) => nameIndex.get(String(p.name || "").toLowerCase()) || resolveSourceId(p.name, new Map()));
    const gapKeys = canonicalizeJoinKeys(pubs.flatMap((p) => p.join_keys || []));
    const keyHit = sharedKeys.some((k) => gapKeys.includes(k));
    const idHit = pubIds.some((id) => id === idA || id === idB);
    // Also match source id tokens inside gap id / surface
    const blob = `${gap.id} ${gap.surface} ${pubs.map((p) => p.name).join(" ")}`.toLowerCase();
    const tokenHit = [idA, idB].some((id) => {
      const token = id.replace(/^passport-public-/, "passport").replace(/-/g, " ");
      return blob.includes(token.split(" ")[0]) && (id.includes("passport") ? blob.includes("passport") || blob.includes("procurement") : true);
    });
    if (idHit || (keyHit && tokenHit) || idHit) closed.push(gap.id);
  }
  // Procurement-specific scoring for passport × checkbook
  if (
    (idA.includes("passport") && idB.includes("checkbook"))
    || (idB.includes("passport") && idA.includes("checkbook"))
  ) {
    for (const gap of registry.gaps || []) {
      if (gap.class !== "not_yet_ingested") continue;
      if (/procurement-(pending|registered|payment|solicitation|bid|ocp)/.test(gap.id)) {
        if (!closed.includes(gap.id)) closed.push(gap.id);
      }
    }
  }
  return closed;
}

function collectCrosswalks(registry, sources, sourceContracts) {
  const byId = contractById(sourceContracts);
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  const nameIndex = new Map(sources.map((s) => [String(s.name || "").toLowerCase(), s.id]));

  const materialized = new Map();

  // Seed known shipped edges
  for (const seed of SEED_MATERIALIZED_CROSSWALKS) {
    if (!sourceMap.has(seed.source_a) || !sourceMap.has(seed.source_b)) continue;
    const realized = coverageFromLineage(seed, byId);
    materialized.set(seed.id, {
      ...seed,
      key_path: canonicalizeJoinKeys(seed.key_path),
      realized_coverage: realized,
      worth_materializing: "already_materialized",
      gaps_would_close: gapsForSourcePairSimple(registry, seed.source_a, seed.source_b, seed.key_path, nameIndex),
    });
  }

  // Preserve prior materialized entries from registry (except candidates)
  for (const cw of registry.crosswalks || []) {
    if (cw.status !== "materialized") continue;
    if (materialized.has(cw.id)) {
      // Keep richer hand fields if measurement missing
      const cur = materialized.get(cw.id);
      if (!cur.realized_coverage && cw.realized_coverage) {
        cur.realized_coverage = cw.realized_coverage;
      }
      continue;
    }
    materialized.set(cw.id, {
      ...cw,
      key_path: canonicalizeJoinKeys(cw.key_path),
      worth_materializing: "already_materialized",
    });
  }

  // Enumerate candidate edges: shared keys, not already materialized
  const candidates = [];
  const sourceList = sources.filter((s) => s.status === "landed" || s.status === "live-only" || s.status === "not_ingested");
  for (let i = 0; i < sourceList.length; i++) {
    for (let j = i + 1; j < sourceList.length; j++) {
      const a = sourceList[i];
      const b = sourceList[j];
      const shared = a.join_keys.filter((k) => b.join_keys.includes(k));
      if (!shared.length) continue;

      // Skip if a materialized edge already covers this pair (any key overlap)
      const already = [...materialized.values()].some((cw) => {
        const pair = new Set([cw.source_a, cw.source_b]);
        return pair.has(a.id) && pair.has(b.id);
      });
      if (already) continue;

      // Skip pure agency-only edges — too weak to score as join candidates
      const strong = shared.filter((k) => k !== "agency");
      if (!strong.length) continue;

      const id = stablePairId(a.id, b.id, strong);
      const gaps = gapsForSourcePairSimple(registry, a.id, b.id, strong, nameIndex);
      const score = gaps.length;
      const bothLanded = (a.status === "landed" || a.status === "live-only")
        && (b.status === "landed" || b.status === "live-only");
      let verdict = "no";
      if (score >= 2 && bothLanded) verdict = "yes";
      else if (score >= 1 && bothLanded) verdict = "maybe";
      else if (score >= 1) verdict = "maybe";
      else if (bothLanded && strong.includes("contract_id")) verdict = "maybe";
      else verdict = "no";

      // Special case: EPIN-bearing passport × checkbook contract_id is the
      // expected newly-feasible pair after PASSPort landing (verify: both
      // publish contract_id-class fields; direct equality is unmeasured).
      const passportCheckbook = (
        (a.id.startsWith("passport-public") && b.id.startsWith("checkbook"))
        || (b.id.startsWith("passport-public") && a.id.startsWith("checkbook"))
      );
      if (passportCheckbook && strong.includes("contract_id")) {
        verdict = "yes";
      }

      candidates.push({
        id,
        source_a: a.id,
        source_b: b.id,
        key_path: strong,
        status: "candidate",
        realized_coverage: null,
        worth_materializing: verdict,
        gaps_would_close: gaps,
        score,
        evidence: passportCheckbook && strong.includes("contract_id")
          ? "PASSPort Public contract rows expose contract_id alongside EPIN; Checkbook Contracts expose prime_contract_id (canonicalized to contract_id). Direct equality is not yet measured — candidate only. Transitive path already exists via City Record PIN."
          : `Shared keys ${strong.join(", ")}; ${gaps.length} taxonomy gap(s) could close.`,
      });
    }
  }

  // Transitive candidates: A and B share no direct key but both connect via PIN/EPIN hub
  for (let i = 0; i < sourceList.length; i++) {
    for (let j = i + 1; j < sourceList.length; j++) {
      const a = sourceList[i];
      const b = sourceList[j];
      const shared = a.join_keys.filter((k) => b.join_keys.includes(k));
      if (shared.filter((k) => k !== "agency").length) continue;
      const aToHub = a.join_keys.includes("PIN") || a.join_keys.includes("EPIN") || a.id === "city-record";
      const bToHub = b.join_keys.includes("PIN") || b.join_keys.includes("EPIN") || b.id === "city-record";
      if (!(aToHub && bToHub)) continue;
      if (a.id === "city-record" || b.id === "city-record") continue;
      const already = [...materialized.values(), ...candidates].some((cw) => {
        const pair = new Set([cw.source_a, cw.source_b]);
        return pair.has(a.id) && pair.has(b.id);
      });
      if (already) continue;

      // Only emit high-value transitive pairs involving passport + checkbook
      const interesting = (
        (a.id.startsWith("passport-public") && b.id.startsWith("checkbook"))
        || (b.id.startsWith("passport-public") && a.id.startsWith("checkbook"))
      );
      if (!interesting) continue;

      const id = stablePairId(a.id, b.id, ["PIN", "EPIN"]);
      const gaps = gapsForSourcePairSimple(registry, a.id, b.id, ["PIN", "EPIN"], nameIndex);
      candidates.push({
        id: `${id}-transitive`,
        source_a: a.id,
        source_b: b.id,
        key_path: ["EPIN", "PIN"],
        status: "candidate",
        join_mode: "transitive_via_city_record_pin",
        realized_coverage: null,
        worth_materializing: "maybe",
        gaps_would_close: gaps,
        score: gaps.length,
        evidence: "Transitive: PASSPort EPIN↔City Record PIN is materialized; Checkbook joins City Record by PIN. A dedicated PASSPort↔Checkbook crosswalk is not yet materialized.",
      });
    }
  }

  candidates.sort((x, y) => (y.score - x.score) || x.id.localeCompare(y.id));

  return {
    materialized: [...materialized.values()].sort((a, b) => a.id.localeCompare(b.id)),
    candidates,
  };
}

/**
 * Re-classify gaps when a join path now exists for a formerly not-published slot.
 */
export function reclassifyGaps(registry, sources, crosswalks) {
  const landed = new Set(
    sources.filter((s) => s.status === "landed" || s.status === "live-only").map((s) => s.id),
  );
  const classChanges = [];
  const gaps = (registry.gaps || []).map((gap) => {
    if (gap.class !== "not_published") return { ...gap };

    // A not_published gap becomes derivable when it names a public_source that
    // has landed OR when also_published sources are now joined into the depot.
    const pubs = [gap.public_source, ...(gap.also_published || [])].filter(Boolean);
    if (!pubs.length) {
      // Heuristic: would_appear_in mentions a landed source name + join keys exist
      const would = String(gap.would_appear_in || "").toLowerCase();
      for (const src of sources) {
        if (!landed.has(src.id)) continue;
        const nameHit = would.includes(String(src.name || "").toLowerCase().slice(0, 12));
        if (!nameHit) continue;
        // Only flip when the registry already carries an explicit derivable_hint
        // or the gap was misclassified (has public_source shape elsewhere).
      }
      return { ...gap };
    }

    const pubIds = pubs.map((p) => resolveSourceId(p.name, new Map(sources.map((s) => [s.id, s]))));
    const landedPub = pubIds.find((id) => landed.has(id));
    if (!landedPub) return { ...gap };

    // Require a join path from the public source to city-record (or any hub)
    const path = crosswalks.find((cw) => {
      if (cw.status !== "materialized") return false;
      const pair = new Set([cw.source_a, cw.source_b]);
      return pair.has(landedPub) && (pair.has("city-record") || pair.has("dcas-exam-notices"));
    });
    if (!path && !SEED_SOURCE_JOIN_KEYS[landedPub]) return { ...gap };

    const next = {
      ...gap,
      class: "not_yet_ingested",
      class_change: {
        from: "not_published",
        to: "not_yet_ingested",
        reason: `Join path available via landed source ${landedPub}`,
        via_crosswalk: path?.id || null,
      },
    };
    // Promote would_appear_in into public_source shape when missing
    if (!next.public_source && pubs[0]) {
      next.public_source = pubs[0];
    }
    classChanges.push({
      gap_id: gap.id,
      from: "not_published",
      to: "not_yet_ingested",
      reason: next.class_change.reason,
      via_crosswalk: path?.id || null,
    });
    return next;
  });

  return { gaps, classChanges };
}

/**
 * Re-rank the un-ingested queue using updated value evidence.
 */
export function rerankIngestList(registry, sources, candidates) {
  const gapById = new Map((registry.gaps || []).map((gap) => [gap.id, gap]));
  // The ranked list is a forward queue, not a history of successful or stopped
  // collectors. Historical gaps remain in `gaps` with their receipts.
  const prior = (registry.ranked_ingest_list || []).filter((row) => {
    const linked = (row.gaps_filled || []).map((id) => gapById.get(id)).filter(Boolean);
    return linked.length > 0
      && linked.every((gap) => FUTURE_WORK_DISPOSITIONS.has(gap.disposition));
  });
  // Build candidate score index by source id
  const candScore = new Map();
  for (const c of candidates) {
    for (const sid of [c.source_a, c.source_b]) {
      candScore.set(sid, Math.max(candScore.get(sid) || 0, c.score || 0));
    }
  }

  const scored = prior.map((row, idx) => {
    const blob = String(row.source || "").toLowerCase();
    let realizedRate = null;
    let predictedGrade = null;

    for (const src of sources) {
      const id = src.id;
      if (blob.includes("passport") && id.startsWith("passport-public")) {
        realizedRate = src.join_coverage?.realized?.rate ?? realizedRate;
        predictedGrade = src.join_coverage?.predicted?.grade ?? predictedGrade;
      }
      if ((blob.includes("zap") || blob.includes("land")) && (id === "zap-api-outcomes" || id === "zap-projects")) {
        realizedRate = src.join_coverage?.realized?.rate ?? realizedRate;
        predictedGrade = src.join_coverage?.predicted?.grade ?? predictedGrade;
      }
    }

    const gapsFilled = (row.gaps_filled || []).length;
    // Value score: more gaps + realized coverage evidence + not-yet-done work
    // Landed sources with remaining UI gaps still rank (PASSPort landed but
    // lifecycle slots may still show unmatched until join completes per notice).
    let valueScore = gapsFilled * 10;
    if (realizedRate != null) valueScore += realizedRate * 20;
    if (predictedGrade === "high-risk" && realizedRate != null && realizedRate >= 0.3) {
      // Predicted high-risk but realized useful — still high value, demote risk
      valueScore += 5;
    }
    valueScore += (candScore.get("passport-public-contracts") || 0);
    // Prefer unfinished ingest: if effort says "Already built" keep near top
    if (/already built/i.test(String(row.effort_guess || ""))) valueScore += 8;
    if (/high/i.test(String(row.join_risk || "")) && realizedRate == null) valueScore -= 5;

    // Update join_risk text when realized coverage is available for PASSPort
    let join_risk = row.join_risk;
    let effort_guess = row.effort_guess;
    if (blob.includes("passport") && realizedRate != null) {
      const pct = Math.round(realizedRate * 1000) / 10;
      join_risk = `Measured ${pct}% either-source EPIN↔PIN on PIN-bearing Procurement notices since 2025-01-01 (predicted pre-landing grade: high-risk).`;
    }

    // Preserve main-line bid recon wording; stamp realized rate from measurement
    if (blob.includes("bid tabulation") || blob.includes("9k82")) {
      const bid = sources.find((s) => s.id === "bid-tabulations-historical");
      const bidRate = bid?.join_coverage?.realized?.rate;
      if (bidRate != null) {
        realizedRate = bidRate;
        predictedGrade = bid?.join_coverage?.predicted?.grade || "high-risk";
        // Keep recon-authored risk/effort when present (disabled below usefulness)
        if (!/measured|0%|usefulness/i.test(String(join_risk || ""))) {
          join_risk = `High — measured strict join ${Math.round(bidRate * 1000) / 10}% on modern notices; below usefulness threshold.`;
        }
      }
      // Demote hard when measured below usefulness
      if (realizedRate != null && realizedRate < 0.3) valueScore -= 15;
    }

    // Doing Business vendor identity enrichment
    if (blob.includes("doing business") || blob.includes("72mk-a8z7")) {
      const db = sources.find((s) => s.id === "doing-business-entities");
      const dbRate = db?.join_coverage?.realized?.rate;
      if (dbRate != null) {
        realizedRate = dbRate;
        predictedGrade = db?.join_coverage?.predicted?.grade || "medium";
        if (dbRate >= 0.3) {
          join_risk = `Measured ${Math.round(dbRate * 1000) / 10}% modern award notice-level vendor_stem join (predicted pre-landing grade: medium).`;
          effort_guess = "Measured — stem join above usefulness; edge-materialized onto vendor profiles.";
          valueScore += 8;
        } else if (!/measured|usefulness/i.test(String(join_risk || ""))) {
          join_risk = `Medium — measured stem join ${Math.round(dbRate * 1000) / 10}%; below usefulness for vendor enrichment.`;
        }
      }
      if (realizedRate != null && realizedRate < 0.3) valueScore -= 15;
    }

    // ULURP Borough President recommendations recon (disabled below usefulness)
    if (
      blob.includes("ulurp recommendation")
      || blob.includes("4j6i-9rmr")
      || blob.includes("gt5i-dmde")
      || blob.includes("borough president")
    ) {
      const ulurp = sources.find((s) => s.id === "ulurp-recommendations")
        || sources.find((s) => s.id === "ulurp-recommendation-pdfs");
      const ulurpRate = ulurp?.join_coverage?.realized?.rate;
      if (ulurpRate != null) {
        realizedRate = ulurpRate;
        predictedGrade = ulurp?.join_coverage?.predicted?.grade || "high-risk";
        if (!/measured|0%|usefulness/i.test(String(join_risk || ""))) {
          join_risk = `High — measured strict ULURP-token join ${Math.round(ulurpRate * 1000) / 10}% on ZAP projects with ulurp_numbers; below usefulness threshold.`;
        }
      }
      if (realizedRate != null && realizedRate < 0.3) valueScore -= 15;
    }

    // Legistar depth: prefer authenticated Web API measurement on nyc-council-legistar
    if (blob.includes("legistar") || blob.includes("meeting-outcomes") || blob.includes("agenda/vote")) {
      const meetings = sources.find((s) => s.id === "city-council-meetings-open-data");
      const legistar = sources.find((s) => s.id === "nyc-council-legistar");
      const modernRate = legistar?.join_coverage?.realized?.rate
        ?? meetings?.join_coverage?.realized?.rate
        ?? null;
      if (modernRate != null) {
        realizedRate = modernRate;
        predictedGrade = legistar?.join_coverage?.predicted?.grade
          || meetings?.join_coverage?.predicted?.grade
          || "medium";
        if (modernRate >= 0.3) {
          join_risk = `Measured ${Math.round(modernRate * 1000) / 10}% modern City Council notice → Legistar event join with LEGISTAR_API_TOKEN (predicted pre-auth grade: medium).`;
          effort_guess = "Already built — daily edge materialization of Events→EventItems→Votes/Attachments with Worker secret LEGISTAR_API_TOKEN.";
          valueScore += 10;
        } else if (!/measured|0%|token|usefulness/i.test(String(join_risk || ""))) {
          join_risk = `High — measured modern join ${Math.round(modernRate * 1000) / 10}%; below usefulness for vote/agenda depth.`;
        }
      }
      if (realizedRate != null && realizedRate < 0.3) valueScore -= 15;
    }

    return {
      row: {
        ...row,
        join_risk,
        effort_guess,
        value_score: Math.round(valueScore * 100) / 100,
        realized_join_rate: realizedRate,
        predicted_join_grade: predictedGrade,
      },
      valueScore,
      priorRank: row.rank ?? idx + 1,
    };
  });

  scored.sort((a, b) => (b.valueScore - a.valueScore) || (a.priorRank - b.priorRank));
  return scored.map((s, i) => ({
    ...s.row,
    rank: i + 1,
  }));
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Full re-derivation pass. Pure: does not touch the filesystem.
 */
export function rederiveDepot(registry, sourceContracts, options = {}) {
  const observedOn = options.observedOn || new Date().toISOString().slice(0, 10);
  const sources = collectDepotSources(registry, sourceContracts);
  const { materialized, candidates } = collectCrosswalks(registry, sources, sourceContracts);
  const allCrosswalks = [...materialized, ...candidates];

  const { gaps, classChanges } = reclassifyGaps(registry, sources, materialized);
  const working = { ...registry, gaps };
  const ranked = rerankIngestList(working, sources, candidates);

  // Passport headline for receipt
  const passportRfx = sources.find((s) => s.id === "passport-public-rfx");
  const passportContracts = sources.find((s) => s.id === "passport-public-contracts");
  const realizedEither = passportRfx?.join_coverage?.realized
    || (passportContracts?.join_coverage?.realized?.metric === "either_contracts_or_rfx"
      ? passportContracts.join_coverage.realized
      : null);

  // Prefer either_contracts_or_rfx from source contracts directly
  const rfxContract = (sourceContracts.contracts || []).find((c) => c.id === "passport-public-rfx");
  const eitherRate = rfxContract?.join_measurement?.rates?.either_contracts_or_rfx || null;

  const next = {
    schema_version: SCHEMA_VERSION,
    generated_document: registry.generated_document || "docs/gap-taxonomy.md",
    doctrine: registry.doctrine,
    partnership_blocked_sources: registry.partnership_blocked_sources || [],
    sources,
    crosswalks: allCrosswalks,
    gaps,
    ranked_ingest_list: ranked,
    operational_messages_not_in_taxonomy: registry.operational_messages_not_in_taxonomy || [],
    verified_at: registry.verified_at || observedOn,
    verification_notes: registry.verification_notes || [],
    depot_refresh: {
      observed_on: observedOn,
      source_contracts_fingerprint: fingerprintSourceContracts(sourceContracts),
      materialized_crosswalks: materialized.length,
      candidate_crosswalks: candidates.length,
      class_changes: classChanges.length,
      passport_realized_either_rate: eitherRate?.rate ?? realizedEither?.rate ?? null,
    },
  };

  const receipt = {
    schema_version: 1,
    kind: "depot_rederive",
    observed_on: observedOn,
    class_changes: classChanges,
    class_changes_loud: classChanges.length
      ? classChanges.map((c) => `CLASS CHANGE: ${c.gap_id} ${c.from} → ${c.to} (${c.reason})`)
      : [],
    sources_count: sources.length,
    materialized_crosswalks: materialized.map((c) => ({
      id: c.id,
      rate: c.realized_coverage?.rate ?? null,
      metric: c.realized_coverage?.metric ?? null,
    })),
    candidate_crosswalks: candidates.map((c) => ({
      id: c.id,
      worth_materializing: c.worth_materializing,
      score: c.score,
      key_path: c.key_path,
      gaps_would_close: c.gaps_would_close,
    })),
    passport_field_case: {
      predicted_grade: PREDICTED_JOIN_GRADES["passport-public-contracts"]?.grade || "high-risk",
      realized_either_rate: eitherRate?.rate ?? null,
      realized_either_joined: eitherRate?.joined ?? null,
      realized_either_total: eitherRate?.total ?? null,
      epin_in_graph: sources.some((s) => s.join_keys.includes("EPIN")),
      passport_checkbook_candidates: candidates
        .filter((c) => {
          const pair = `${c.source_a} ${c.source_b}`;
          return pair.includes("passport") && pair.includes("checkbook");
        })
        .map((c) => c.id),
    },
    ranked_ingest_top: ranked.slice(0, 5).map((r) => ({
      rank: r.rank,
      source: r.source,
      value_score: r.value_score,
      realized_join_rate: r.realized_join_rate ?? null,
    })),
    registry_sha256: sha256Json(next),
  };

  return { registry: next, receipt };
}

function fingerprintSourceContracts(sourceContracts) {
  const slim = (sourceContracts.contracts || []).map((c) => ({
    id: c.id,
    status: c.status,
    join_keys: c.join_keys || [],
    join_measurement: c.join_measurement
      ? {
          observed_on: c.join_measurement.observed_on,
          rates: c.join_measurement.rates,
          verdict: c.join_measurement.verdict,
        }
      : null,
  }));
  return sha256Json(slim);
}

export function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function registriesEqual(a, b) {
  // Compare without volatile observed_on inside depot_refresh if needed —
  // full structural compare of re-derived content excluding receipt clock.
  const strip = (reg) => {
    const copy = structuredClone(reg);
    if (copy.depot_refresh) {
      // Keep fingerprint and counts; observed_on may differ by day in CI
      delete copy.depot_refresh.observed_on;
    }
    return copy;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/**
 * Drift check: re-derive and compare to committed registry.
 * Returns { ok, mismatches[], receipt, expected }.
 */
export function checkDepotFreshness(registry, sourceContracts, options = {}) {
  const { registry: expected, receipt } = rederiveDepot(registry, sourceContracts, options);
  const mismatches = [];

  if (registry.schema_version !== SCHEMA_VERSION) {
    mismatches.push(`schema_version: committed ${registry.schema_version}, expected ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(registry.sources) || registry.sources.length === 0) {
    mismatches.push("sources: missing join-graph source nodes");
  }
  if (!Array.isArray(registry.crosswalks) || registry.crosswalks.length === 0) {
    mismatches.push("crosswalks: missing join-graph edges");
  }

  // Compare deterministic slices
  const committedSources = JSON.stringify(registry.sources || []);
  const expectedSources = JSON.stringify(expected.sources || []);
  if (committedSources !== expectedSources) {
    mismatches.push("sources: stale relative to re-derivation (run node tools/depot_rederive.mjs)");
  }

  const committedCw = JSON.stringify(registry.crosswalks || []);
  const expectedCw = JSON.stringify(expected.crosswalks || []);
  if (committedCw !== expectedCw) {
    mismatches.push("crosswalks: stale relative to re-derivation (run node tools/depot_rederive.mjs)");
  }

  const committedRank = JSON.stringify(
    (registry.ranked_ingest_list || []).map((r) => ({
      rank: r.rank,
      source: r.source,
      gaps_filled: r.gaps_filled,
      value_score: r.value_score,
      realized_join_rate: r.realized_join_rate,
    })),
  );
  const expectedRank = JSON.stringify(
    (expected.ranked_ingest_list || []).map((r) => ({
      rank: r.rank,
      source: r.source,
      gaps_filled: r.gaps_filled,
      value_score: r.value_score,
      realized_join_rate: r.realized_join_rate,
    })),
  );
  if (committedRank !== expectedRank) {
    mismatches.push("ranked_ingest_list: stale relative to re-derivation");
  }

  // Fingerprint must match source contracts measurement inputs
  if (
    registry.depot_refresh?.source_contracts_fingerprint
    && registry.depot_refresh.source_contracts_fingerprint
      !== expected.depot_refresh.source_contracts_fingerprint
  ) {
    mismatches.push("depot_refresh.source_contracts_fingerprint: source-contract measurements changed");
  }

  return { ok: mismatches.length === 0, mismatches, receipt, expected };
}

function mdCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function pct(rate) {
  if (rate == null || !Number.isFinite(+rate)) return "—";
  return `${Math.round(+rate * 1000) / 10}%`;
}

/**
 * Backstage direction page: human report generated from the depot registry.
 */
export function renderGapTaxonomyDocument(registry) {
  const gaps = registry.gaps || [];
  const sources = registry.sources || [];
  const crosswalks = registry.crosswalks || [];
  const materialized = crosswalks.filter((c) => c.status === "materialized");
  const candidates = crosswalks.filter((c) => c.status === "candidate");
  const ranked = registry.ranked_ingest_list || [];

  const inventoryRows = gaps.map((g) => {
    const home = g.class === "not_yet_ingested"
      ? (g.public_source?.name || "—")
      : (g.would_appear_in || "—");
    const cls = g.class === "not_yet_ingested" ? "a" : "b";
    const flag = g.class_change ? " **CLASS CHANGE**" : "";
    const receipt = g.closure_receipt
      ? `[receipt](${g.closure_receipt})`
      : "—";
    return `| ${mdCell(g.surface || g.id)}${flag} | ${cls} | ${mdCell(g.disposition || "open")} | ${mdCell(home)} | ${receipt} |`;
  });

  const sourceRows = sources
    .filter((s) => (s.join_keys || []).length > 0)
    .map((s) => {
      const pred = s.join_coverage?.predicted?.grade || "—";
      const real = s.join_coverage?.realized;
      const realCell = real ? `${pct(real.rate)} (${real.metric || "rate"})` : "—";
      return `| \`${s.id}\` | ${mdCell(s.status)} | ${mdCell((s.join_keys || []).join(", "))} | ${mdCell(pred)} | ${mdCell(realCell)} |`;
    });

  const matRows = materialized.map((c) => {
    const rate = c.realized_coverage ? pct(c.realized_coverage.rate) : "—";
    return `| \`${c.id}\` | \`${c.source_a}\` × \`${c.source_b}\` | ${mdCell((c.key_path || []).join(" · "))} | ${rate} |`;
  });

  const candRows = candidates.slice(0, 20).map((c) => (
    `| \`${c.id}\` | \`${c.source_a}\` × \`${c.source_b}\` | ${mdCell((c.key_path || []).join(" · "))} | ${mdCell(c.worth_materializing)} | ${(c.gaps_would_close || []).length} |`
  ));

  // Mermaid join graph (materialized solid, candidates dotted)
  const mermaidLines = ["```mermaid", "graph LR"];
  const nodeIds = new Map();
  function nid(id) {
    if (!nodeIds.has(id)) nodeIds.set(id, id.replace(/[^a-zA-Z0-9]/g, "_"));
    return nodeIds.get(id);
  }
  for (const c of materialized) {
    mermaidLines.push(`  ${nid(c.source_a)}[${c.source_a}] -->|${(c.key_path || []).join("/")}| ${nid(c.source_b)}[${c.source_b}]`);
  }
  for (const c of candidates.filter((x) => x.worth_materializing === "yes").slice(0, 8)) {
    mermaidLines.push(`  ${nid(c.source_a)}-.->|${(c.key_path || []).join("/")} candidate| ${nid(c.source_b)}`);
  }
  mermaidLines.push("```");

  const rankLines = ranked.map((r, i) => {
    const rate = r.realized_join_rate != null ? ` Measured join **${pct(r.realized_join_rate)}**.` : "";
    const pred = r.predicted_join_grade ? ` Predicted grade: **${r.predicted_join_grade}**.` : "";
    // Surface recon/disabled wording from the ranked row when present
    const risk = /below usefulness|disabled|0%|measured/i.test(String(r.join_risk || ""))
      ? ` ${r.join_risk}`
      : "";
    const effort = /measured|disabled|threshold/i.test(String(r.effort_guess || ""))
      ? ` ${r.effort_guess}`
      : "";
    return `${i + 1}. **${r.source}** — ${(r.gaps_filled || []).join(", ") || "secondary enrichment"}.${rate}${pred}${risk}${effort}`;
  });

  const classChangeSection = gaps.some((g) => g.class_change)
    ? [
        "",
        "## Class changes (loud)",
        "",
        ...gaps.filter((g) => g.class_change).map((g) => (
          `- **CLASS CHANGE** \`${g.id}\`: ${g.class_change.from} → ${g.class_change.to} — ${g.class_change.reason}`
        )),
        "",
      ]
    : [];

  return [
    "<!-- Generated by tools/depot_rederive.mjs from site/data/gap_taxonomy.json. Do not edit by hand. -->",
    "",
    "# Lifecycle gap taxonomy",
    "",
    "When a lifecycle slot is empty, the reader must see **which kind of gap** it is.",
    "",
    "| Class | Register | Meaning |",
    "|---|---|---|",
    "| **not_yet_ingested** (a) | “Not yet shown here — … live in *source*.” | A public source publishes this field. Empty means incomplete join or missing adapter. |",
    "| **not_published** (b) | “The city does not publish this — it would appear in *where* if released.” | No public, joinable release is known. Name the logical home when one exists. |",
    "",
    "Operational messages (source unreachable, ambiguous multi-match) stay outside this taxonomy.",
    "",
    "The executable inventory is [`site/data/gap_taxonomy.json`](../site/data/gap_taxonomy.json).",
    "The **depot** is the join graph in that file (`sources` + `crosswalks`), not the gap list alone.",
    "Refresh with `node tools/depot_rederive.mjs` after any source-contract or taxonomy change.",
    "",
    "## Inventory summary",
    "",
    "| Gap | Class | Disposition | Public home or “would appear in” | Closure receipt |",
    "|---|---|---|---|---|",
    ...inventoryRows,
    "",
    "## Join graph (sources)",
    "",
    "| Source | Status | Join keys | Predicted grade | Realized coverage |",
    "|---|---|---|---|---|",
    ...sourceRows,
    "",
    "## Materialized crosswalks",
    "",
    "| Crosswalk | Pair | Key path | Realized rate |",
    "|---|---|---|---|",
    ...matRows,
    "",
    "## Candidate crosswalks (worth materializing?)",
    "",
    "| Candidate | Pair | Key path | Verdict | Gaps |",
    "|---|---|---|---|---|",
    ...candRows,
    "",
    "## Graph view",
    "",
    ...mermaidLines,
    "",
    "## Ranked class-(a) ingest list",
    "",
    "Ordered for dispatch. Full rows (effort, join risk, value scores) live in",
    "`site/data/gap_taxonomy.json` → `ranked_ingest_list`.",
    "",
    ...rankLines,
    ...classChangeSection,
    "",
    `## Verification notes (${registry.verified_at || "n/a"})`,
    "",
    ...(registry.verification_notes || []).map((n) => `- ${n}`),
    "",
    "## UI copy keys (two registers)",
    "",
    "Class **a** keys use the “Not yet shown here” register with per-slot specificity (pending vs registered vs payments vs votes vs subsidy stages).",
    "",
    "Class **b** keys use the “The city does not publish this” register with a concrete “would appear in …” pointer.",
    "",
    "Operational keys unchanged: `lifecycle_unknown_html`, `lifecycle_ambiguous_html`, `subsidy_source_unavailable_html`.",
    "",
    "## Depot refresh",
    "",
    "```sh",
    "node tools/depot_rederive.mjs          # write registry + docs + receipt",
    "node tools/depot_rederive.mjs --check  # CI drift gate (no writes)",
    "```",
    "",
    registry.depot_refresh
      ? `Last refresh fingerprint: \`${registry.depot_refresh.source_contracts_fingerprint?.slice(0, 12) || "—"}…\` · materialized ${registry.depot_refresh.materialized_crosswalks} · candidates ${registry.depot_refresh.candidate_crosswalks} · class changes ${registry.depot_refresh.class_changes}.`
      : "Run the re-derivation pass to stamp depot_refresh metadata.",
    "",
  ].join("\n");
}

export function formatRegistryJson(registry) {
  return stableStringify(registry);
}
