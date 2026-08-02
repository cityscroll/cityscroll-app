/**
 * Pure helpers to assemble cross-domain observations for entity intelligence
 * materialization (warehouse fixtures + optional site lookups + domain seeds).
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import {
  observationFromMoneyRow,
  observationFromLandRow,
  observationFromRulesRow,
  observationFromMeetingsRow,
  observationFromPeopleRow,
  observationFromPropertyRow,
  buildIntelligenceCorpus,
  CROSS_DOMAIN_OBJECT_LINK_VERSION,
} from "../../entity_resolution/cross_domain/index.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** Coerce materialization `source` fields that may be objects into a system id. */
function cleanSourceSystem(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    const s = clean(value);
    return s || fallback;
  }
  if (typeof value === "object") {
    const s = clean(value.system || value.id || value.name || value.dataset_id);
    return s || fallback;
  }
  return fallback;
}

/** Minimal CSV parser (warehouse fixtures are simple, no embedded commas in demos). */
export function parseSimpleCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length);
  if (lines.length < 2) return [];
  // Prefer a slightly smarter split for quoted fields when present.
  const headers = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, j) => {
      obj[h] = cols[j] != null && cols[j] !== "" ? cols[j] : null;
    });
    rows.push(obj);
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQ = !inQ;
      }
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function loadCsvIfExists(filePath) {
  if (!existsSync(filePath)) return [];
  return parseSimpleCsv(readFileSync(filePath, "utf8"));
}

export function loadJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * Collect observations from warehouse + site materializations + optional seeds.
 * @param {string} root repo root
 * @param {{ includePeopleEmpty?: boolean }} [opts]
 */
export function collectCrossDomainObservations(root, opts = {}) {
  const observations = [];

  // --- Money: warehouse OCP fixtures + product lookup ---
  const ocpPaths = [
    path.join(root, "warehouse/fixtures/ocp-recent-contract-awards/product_seed.csv"),
    path.join(root, "warehouse/fixtures/ocp-recent-contract-awards/sample.csv"),
  ];
  for (const p of ocpPaths) {
    for (const row of loadCsvIfExists(p)) {
      const obs = observationFromMoneyRow(row, {
        sourceSystem: "ocp-recent-contract-awards",
      });
      if (obs) observations.push(obs);
    }
  }
  const ocpLookup = loadJsonIfExists(
    path.join(root, "site/data/ocp_awards_warehouse_lookup.json"),
  );
  if (ocpLookup && Array.isArray(ocpLookup.rows)) {
    const ocpSource = cleanSourceSystem(ocpLookup.source, "ocp-recent-contract-awards");
    for (const row of ocpLookup.rows.slice(0, 500)) {
      const obs = observationFromMoneyRow(row, { sourceSystem: ocpSource });
      if (obs) observations.push(obs);
    }
  }

  // --- Land: warehouse ZAP fixtures + land default + zap lookup ---
  const zapPaths = [
    path.join(root, "warehouse/fixtures/zap-projects/product_seed.csv"),
    path.join(root, "warehouse/fixtures/zap-projects/sample.csv"),
  ];
  for (const p of zapPaths) {
    for (const row of loadCsvIfExists(p)) {
      const obs = observationFromLandRow(row, { sourceSystem: "zap-projects" });
      if (obs) observations.push(obs);
    }
  }
  const landDefault = loadJsonIfExists(
    path.join(root, "site/data/land_default_ulurp.json"),
  );
  if (landDefault && Array.isArray(landDefault.projects)) {
    const landSource = cleanSourceSystem(landDefault.source, "zap-projects");
    for (const row of landDefault.projects) {
      const obs = observationFromLandRow(row, { sourceSystem: landSource });
      if (obs) observations.push(obs);
    }
  }
  const zapLookup = loadJsonIfExists(
    path.join(root, "site/data/zap_projects_warehouse_lookup.json"),
  );
  if (zapLookup && Array.isArray(zapLookup.rows)) {
    const zapSource = cleanSourceSystem(zapLookup.source, "zap-projects");
    for (const row of zapLookup.rows.slice(0, 500)) {
      const obs = observationFromLandRow(row, { sourceSystem: zapSource });
      if (obs) observations.push(obs);
    }
  }

  // --- Rules / meetings / people: committed seed observations (honest, small) ---
  const seedPath = path.join(
    root,
    "worker/test/fixtures/entity-intelligence/domain_observations.json",
  );
  const seed = loadJsonIfExists(seedPath);
  if (seed) {
    for (const row of seed.rules || []) {
      const obs = observationFromRulesRow(row);
      if (obs) observations.push(obs);
    }
    for (const row of seed.meetings || []) {
      const obs = observationFromMeetingsRow(row);
      if (obs) observations.push(obs);
    }
    for (const row of seed.people || []) {
      const obs = observationFromPeopleRow(row);
      if (obs) observations.push(obs);
    }
    // Optional extra money/land rows for multi-domain demos
    for (const row of seed.money || []) {
      const obs = observationFromMoneyRow(row);
      if (obs) observations.push(obs);
    }
    for (const row of seed.land || []) {
      const obs = observationFromLandRow(row);
      if (obs) observations.push(obs);
    }
    for (const row of seed.property || []) {
      const obs = observationFromPropertyRow(row);
      if (obs) observations.push(obs);
    }
  }

  // --- Property: disposition fixtures + property cross-domain corpus ---
  const propPaths = [
    path.join(root, "worker/test/fixtures/property-cross-domain/corpus.json"),
    path.join(root, "test/fixtures/property_disposition/multi_notice_bbl.json"),
  ];
  for (const p of propPaths) {
    const doc = loadJsonIfExists(p);
    if (!doc) continue;
    const rows = doc.property_rows || doc.notices || [];
    for (const row of rows) {
      const obs = observationFromPropertyRow({
        ...row,
        section_name: row.section_name || "Property Disposition",
        source_system: row.source_system || "city_record",
      });
      if (obs) observations.push(obs);
    }
  }

  // Dedupe by source_record_id + domain
  const seen = new Set();
  const out = [];
  for (const obs of observations) {
    const key = `${obs.domain}|${obs.source_record_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(obs);
  }
  return out;
}

/**
 * Build the materialization document written to site/ + worker/ data.
 */
export function buildEntityIntelligenceDoc(root, opts = {}) {
  const observations = collectCrossDomainObservations(root, opts);
  const corpus = buildIntelligenceCorpus(observations, {
    max_per_domain: opts.max_per_domain || 6,
    max_entities: opts.max_entities || 40,
  });

  // Pick a verified multi-domain demo (prefer Parks — money fixture + land applicant)
  const parks = corpus.entities.find(
    (e) => e.root?.kind === "agency" && /parks/i.test(e.root?.ref || e.root?.canonical_id || ""),
  );
  const multi = corpus.entities.filter((e) => (e.metrics?.domains_matched || 0) >= 2);

  return {
    schema_version: 1,
    phase: "cross-domain-object-links",
    title: "Entity intelligence — cross-domain object links",
    version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
    generated_at: corpus.generated_at,
    observation_count: observations.length,
    entity_count: corpus.entity_count,
    multi_domain_count: corpus.multi_domain_count,
    domains: corpus.domains,
    demo_refs: corpus.demo_refs,
    verified_demo: parks
      ? {
          ref: parks.root.ref,
          display_name: parks.root.display_name,
          domains_matched: parks.metrics.domains_matched,
          total_linked_objects: parks.metrics.total_linked_objects,
          domain_status: Object.fromEntries(
            Object.entries(parks.domains).map(([k, v]) => [k, { status: v.status, count: v.count }]),
          ),
        }
      : multi[0]
        ? {
            ref: multi[0].root.ref,
            display_name: multi[0].root.display_name,
            domains_matched: multi[0].metrics.domains_matched,
            total_linked_objects: multi[0].metrics.total_linked_objects,
          }
        : null,
    entities: corpus.entities,
    by_ref: corpus.by_ref,
    provenance: {
      sources: [
        "warehouse/fixtures/ocp-recent-contract-awards",
        "warehouse/fixtures/zap-projects",
        "site/data/ocp_awards_warehouse_lookup.json",
        "site/data/zap_projects_warehouse_lookup.json",
        "site/data/land_default_ulurp.json",
        "worker/test/fixtures/entity-intelligence/domain_observations.json",
        "worker/test/fixtures/property-cross-domain/corpus.json",
        "test/fixtures/property_disposition/multi_notice_bbl.json",
      ],
      methods: [
        "agency_canonical_v1",
        "vendor_stem_v1",
        "cross_domain_identity_v1",
        "exact_bbl_v1",
        "disposition_owner_label_v1",
      ],
      note:
        "Links only when identity normalizers resolve the same root. Property attaches via City Record agency_name and labeled disposition owners. Empty domains are explicit; people defaults to not_yet_ingested without by_person rows.",
    },
  };
}

export function slimDocForWorker(doc) {
  // Worker payload: keep by_ref + summary; drop full entities array duplicate if large
  return {
    schema_version: doc.schema_version,
    phase: doc.phase,
    title: doc.title,
    version: doc.version,
    generated_at: doc.generated_at,
    observation_count: doc.observation_count,
    entity_count: doc.entity_count,
    multi_domain_count: doc.multi_domain_count,
    domains: doc.domains,
    demo_refs: doc.demo_refs,
    verified_demo: doc.verified_demo,
    by_ref: doc.by_ref,
    // Compact entity list for /entity-intelligence?list=1
    entity_index: (doc.entities || []).map((e) => ({
      ref: e.root?.ref,
      kind: e.root?.kind,
      display_name: e.root?.display_name,
      domains_matched: e.metrics?.domains_matched,
      total_linked_objects: e.metrics?.total_linked_objects,
      coverage_rate: e.metrics?.coverage_rate,
    })),
    provenance: doc.provenance,
  };
}
