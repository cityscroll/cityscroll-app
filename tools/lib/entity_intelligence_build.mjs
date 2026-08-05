/**
 * Pure helpers to assemble cross-domain observations for entity intelligence
 * materialization (warehouse fixtures + optional site lookups + domain seeds).
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { publicRecords } from "./public_payload_integrity.mjs";

import {
  observationFromMoneyRow,
  observationFromPaymentRow,
  observationFromLandRow,
  observationFromRulesRow,
  observationFromMeetingsRow,
  observationFromPeopleRow,
  observationFromFranchise,
  observationsFromRulesMaterialization,
  observationsFromMeetingsMaterialization,
  observationsFromPeopleMaterialization,
  observationsFromFranchiseMaterialization,
  mergeBblsOntoLandObservations,
  observationFromPropertyRow,
  buildIntelligenceCorpus,
  CROSS_DOMAIN_OBJECT_LINK_VERSION,
} from "../../entity_resolution/cross_domain/index.mjs";
import { vendorStem } from "../../entity_resolution/normalizers/vendor_stem.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
export const DEFAULT_ENTITY_MATERIALIZATION_CAP = 200;

export const VENDOR_FOOTPRINT_PROMOTION_GATES = Object.freeze({
  award_linkage_rate: 0.95,
  multi_domain_vendor_rate: 0.5,
  section_denominator_rate: 1,
  precision_reviewed_links: 200,
  precision_false_positive_rate: 0.01,
});

const VENDOR_FOOTPRINT_SECTIONS = Object.freeze([
  "awards",
  "payments",
  "land",
  "property",
  "rules",
  "meetings",
  "franchise",
]);

function roundRate(value) {
  return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null;
}

function percentLabel(rate) {
  if (!Number.isFinite(rate)) return null;
  const value = Math.round(rate * 1_000) / 10;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

function vendorRef(stem) {
  return stem ? `vendor:stem:${encodeURIComponent(stem)}` : "";
}

/**
 * Build the public vendor-footprint coverage contract from committed source
 * materializations and review receipts. Only exact-stem, strong award links
 * contribute to the numerator; tentative and review-only candidates do not.
 */
export function buildVendorFootprintCoverage(doc = {}, ocpLookup = {}, erReceipt = {}) {
  const knownByRef = new Map();
  for (const row of Array.isArray(ocpLookup?.rows) ? ocpLookup.rows : []) {
    const stem = vendorStem(row?.vendor_name);
    const ref = vendorRef(stem);
    const requestId = clean(row?.request_id);
    if (!ref || !requestId) continue;
    if (!knownByRef.has(ref)) knownByRef.set(ref, new Set());
    knownByRef.get(ref).add(requestId);
  }

  const linkedByRef = new Map();
  for (const [ref, dossier] of Object.entries(doc?.by_ref || {})) {
    if (dossier?.root?.kind !== "vendor") continue;
    const known = knownByRef.get(ref) || new Set();
    const linked = new Set();
    for (const object of dossier?.domains?.money?.objects || []) {
      const requestId = clean(object?.request_id);
      if (object?.object_kind !== "award" || object?.confidence !== "strong" || !known.has(requestId)) continue;
      linked.add(requestId);
    }
    linkedByRef.set(ref, linked);
  }

  const awardsByRef = {};
  let knownAwards = 0;
  let linkedAwards = 0;
  for (const [ref, known] of [...knownByRef.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const linked = linkedByRef.get(ref) || new Set();
    const eligible = known.size;
    const linkedCount = linked.size;
    const rate = eligible ? linkedCount / eligible : null;
    knownAwards += eligible;
    linkedAwards += linkedCount;
    awardsByRef[ref] = {
      linked: linkedCount,
      eligible,
      rate: roundRate(rate),
      label: `showing ${linkedCount} of ${eligible} known awards linked so far (${percentLabel(rate)})`,
    };
  }

  const vendorEntities = (doc?.entities || []).filter((entity) => entity?.root?.kind === "vendor");
  const multiDomainVendors = vendorEntities.filter((entity) => (entity?.metrics?.domains_matched || 0) >= 2).length;
  const awardLinkageRate = knownAwards ? linkedAwards / knownAwards : null;
  const multiDomainVendorRate = vendorEntities.length ? multiDomainVendors / vendorEntities.length : null;
  // Awards have a full materialized denominator. The other shipped sections
  // remain bounded observations and therefore retain explicit unknown coverage.
  const sectionsWithMeasuredDenominator = 1;
  const sectionDenominatorRate = sectionsWithMeasuredDenominator / VENDOR_FOOTPRINT_SECTIONS.length;
  const review = erReceipt?.quality_review || {};
  const reviewedLinks = Number(review.accepted_pair_candidates_reviewed) || 0;
  const falsePositives = Number(review.confirmed_false_positives) || 0;
  const falsePositiveRate = reviewedLinks ? falsePositives / reviewedLinks : null;
  const fullCorpusPrecision = !/does not support a full-corpus precision claim/i.test(
    String(review.unreviewed_residual || erReceipt?.residual || ""),
  );

  const gates = {
    award_linkage_rate: {
      threshold: VENDOR_FOOTPRINT_PROMOTION_GATES.award_linkage_rate,
      actual: roundRate(awardLinkageRate),
      passed: Number.isFinite(awardLinkageRate)
        && awardLinkageRate >= VENDOR_FOOTPRINT_PROMOTION_GATES.award_linkage_rate,
    },
    multi_domain_vendor_rate: {
      threshold: VENDOR_FOOTPRINT_PROMOTION_GATES.multi_domain_vendor_rate,
      actual: roundRate(multiDomainVendorRate),
      passed: Number.isFinite(multiDomainVendorRate)
        && multiDomainVendorRate >= VENDOR_FOOTPRINT_PROMOTION_GATES.multi_domain_vendor_rate,
    },
    section_denominator_rate: {
      threshold: VENDOR_FOOTPRINT_PROMOTION_GATES.section_denominator_rate,
      actual: roundRate(sectionDenominatorRate),
      measured_sections: sectionsWithMeasuredDenominator,
      total_sections: VENDOR_FOOTPRINT_SECTIONS.length,
      passed: sectionDenominatorRate >= VENDOR_FOOTPRINT_PROMOTION_GATES.section_denominator_rate,
    },
    precision_review: {
      reviewed_links_threshold: VENDOR_FOOTPRINT_PROMOTION_GATES.precision_reviewed_links,
      reviewed_links_actual: reviewedLinks,
      false_positive_rate_threshold: VENDOR_FOOTPRINT_PROMOTION_GATES.precision_false_positive_rate,
      false_positive_rate_actual: roundRate(falsePositiveRate),
      full_corpus: fullCorpusPrecision,
      passed: reviewedLinks >= VENDOR_FOOTPRINT_PROMOTION_GATES.precision_reviewed_links
        && Number.isFinite(falsePositiveRate)
        && falsePositiveRate <= VENDOR_FOOTPRINT_PROMOTION_GATES.precision_false_positive_rate
        && fullCorpusPrecision,
    },
  };
  const promoted = Object.values(gates).every((gate) => gate.passed);

  return {
    schema_version: 1,
    status: promoted ? "promoted" : "qualified",
    qualifier_required: !promoted,
    sections: [...VENDOR_FOOTPRINT_SECTIONS],
    excluded_confidence: ["tentative", "review_only", "not_scored"],
    summary: {
      known_awards: knownAwards,
      linked_awards: linkedAwards,
      award_linkage_rate: roundRate(awardLinkageRate),
      vendor_roots: vendorEntities.length,
      multi_domain_vendor_roots: multiDomainVendors,
      multi_domain_vendor_rate: roundRate(multiDomainVendorRate),
    },
    promotion: { eligible: promoted, gates },
    awards_by_ref: awardsByRef,
    provenance: {
      denominator: "site/data/ocp_awards_warehouse_lookup.json",
      denominator_dataset_id: ocpLookup?.dataset_id || null,
      denominator_materialized_at: ocpLookup?.materialized_at || null,
      denominator_row_count: Number(ocpLookup?.row_count) || knownAwards,
      numerator: "site/data/entity_intelligence_lookup.json strong named_vendor award objects",
      precision_receipt: "warehouse/receipts/proof/wh04_er_batch_latest.json",
    },
  };
}

/**
 * Compact public reverse index: observed subject_ref → published entity pivots.
 * Numeric matcher scores and review-queue candidates never enter this artifact.
 */
export function buildSubjectEntityIndex(doc = {}) {
  const grouped = new Map();
  for (const dossier of Object.values(doc.by_ref || {})) {
    const root = dossier?.root || {};
    const entityRef = clean(root.ref);
    if (!entityRef) continue;
    for (const link of dossier.links || []) {
      const confidence = clean(link?.confidence || link?.link_confidence).toLowerCase();
      if (!new Set(["strong", "tentative"]).has(confidence)) continue;
      const from = clean(link.from);
      const to = clean(link.to);
      const subjectRef = from === entityRef ? to : to === entityRef ? from : "";
      if (!subjectRef || subjectRef === entityRef) continue;
      const entry = {
        entity_ref: entityRef,
        relation: clean(link.type),
        confidence,
      };
      const key = [entry.entity_ref, entry.relation, entry.confidence].join("|");
      if (!grouped.has(subjectRef)) grouped.set(subjectRef, new Map());
      grouped.get(subjectRef).set(key, entry);
    }
  }
  return Object.fromEntries([...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([subjectRef, entries]) => [
      subjectRef,
      [...entries.values()].sort((a, b) =>
        a.entity_ref.localeCompare(b.entity_ref)
        || a.relation.localeCompare(b.relation)
        || a.confidence.localeCompare(b.confidence)),
    ]));
}

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
    ...(opts.include_test_fixtures
      ? [path.join(root, "warehouse/fixtures/ocp-recent-contract-awards/sample.csv")]
      : []),
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
    ...(opts.include_test_fixtures
      ? [path.join(root, "warehouse/fixtures/zap-projects/sample.csv")]
      : []),
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

  // --- Land tax lots (WH-06): ZAP BBL fixtures + warehouse materialization ---
  const bblJoinRows = [];
  const bblPaths = [
    path.join(root, "warehouse/fixtures/zap-bbl/product_seed.csv"),
    ...(opts.include_test_fixtures
      ? [path.join(root, "warehouse/fixtures/zap-bbl/sample.csv")]
      : []),
  ];
  for (const p of bblPaths) {
    for (const row of loadCsvIfExists(p)) {
      if (row?.project_id && row?.bbl) bblJoinRows.push(row);
    }
  }
  const bblLookup = loadJsonIfExists(
    path.join(root, "site/data/zap_bbl_warehouse_lookup.json"),
  );
  if (bblLookup && Array.isArray(bblLookup.rows)) {
    for (const entry of bblLookup.rows.slice(0, 500)) {
      if (entry?.project_id && Array.isArray(entry.bbls)) {
        bblJoinRows.push({ project_id: entry.project_id, bbls: entry.bbls });
      }
    }
  }
  if (bblJoinRows.length) {
    const merged = mergeBblsOntoLandObservations(observations, bblJoinRows);
    observations.length = 0;
    observations.push(...merged);
  }

  // --- Money payments: Checkbook spending fixtures (vendor ↔ awards ↔ payments) ---
  const paymentPaths = [
    path.join(root, "warehouse/fixtures/checkbook-spending/product_seed.csv"),
    ...(opts.include_test_fixtures
      ? [path.join(root, "warehouse/fixtures/checkbook-spending/sample.csv")]
      : []),
  ];
  for (const p of paymentPaths) {
    for (const row of loadCsvIfExists(p)) {
      const obs = observationFromPaymentRow(row, {
        sourceSystem: "checkbook-spending",
      });
      if (obs) observations.push(obs);
    }
  }

  // --- Rules: live City Record Agency Rules snapshot (rules:materialized:v2-compatible) ---
  // Cap keeps materialization CPU-light; provenance stays on each row.
  const rulesLimit = Number.isFinite(opts.rules_limit) ? opts.rules_limit : 200;
  const rulesSnapshots = [
    path.join(root, "site/data/rules_domain_observations.json"),
    ...(opts.include_test_fixtures
      ? [path.join(root, "worker/test/fixtures/entity-intelligence/rules_materialized_v2.json")]
      : []),
  ];
  for (const p of rulesSnapshots) {
    const doc = loadJsonIfExists(p);
    if (!doc) continue;
    const sourceSystem = cleanSourceSystem(
      doc.source?.system || doc.source_system,
      "city_record",
    );
    for (const obs of observationsFromRulesMaterialization(doc, {
      sourceSystem,
      limit: rulesLimit,
    })) {
      observations.push(obs);
    }
  }

  // --- Meetings: live City Record hearings snapshot (meeting-outcomes-compatible) ---
  const meetingsLimit = Number.isFinite(opts.meetings_limit) ? opts.meetings_limit : 250;
  const meetingsSnapshots = [
    path.join(root, "site/data/meetings_domain_observations.json"),
    ...(opts.include_test_fixtures
      ? [path.join(root, "worker/test/fixtures/entity-intelligence/meeting_outcomes_materialized_v2.json")]
      : []),
  ];
  for (const p of meetingsSnapshots) {
    const doc = loadJsonIfExists(p);
    if (!doc) continue;
    const sourceSystem = cleanSourceSystem(
      doc.source?.system || doc.source_system,
      "city_record",
    );
    for (const obs of observationsFromMeetingsMaterialization(doc, {
      sourceSystem,
      limit: meetingsLimit,
    })) {
      observations.push(obs);
    }
  }

  // --- People: person-level Legistar votes retained on meeting-outcomes ---
  // Prefer the people domain snapshot (built from live by_person). Fallback walks
  // meeting-outcomes fixtures that carry by_person. Never invents officials.
  // Densified people snapshot can hold hundreds of person×matter×event vote rows
  // across multiple roll-call notices (distinct officials still dedupe on EI).
  const peopleLimit = Number.isFinite(opts.people_limit) ? opts.people_limit : 500;
  const peopleSnapshots = [
    path.join(root, "site/data/people_domain_observations.json"),
    ...(opts.include_test_fixtures
      ? [
          path.join(root, "worker/test/fixtures/entity-intelligence/people_domain_observations.json"),
          path.join(root, "worker/test/fixtures/entity-intelligence/meeting_outcomes_materialized_v2.json"),
        ]
      : []),
  ];
  let peopleLoaded = 0;
  for (const p of peopleSnapshots) {
    if (peopleLoaded > 0 && p.endsWith("meeting_outcomes_materialized_v2.json")) {
      // Domain snapshot already supplied people; skip the meetings fixture walk.
      continue;
    }
    const doc = loadJsonIfExists(p);
    if (!doc) continue;
    const sourceSystem = cleanSourceSystem(
      doc.source?.system || doc.source_system,
      "legistar",
    );
    const batch = observationsFromPeopleMaterialization(doc, {
      sourceSystem,
      limit: peopleLimit,
    });
    for (const obs of batch) {
      observations.push(obs);
      peopleLoaded += 1;
    }
    if (peopleLoaded > 0 && String(p).includes("people_domain_observations")) break;
  }

  // --- Seed: property multi-domain demos + optional people (only when person_id present) ---
  // Rules/meetings seeds are no longer the primary materialization (live snapshots above).
  // Seed rules/meetings rows remain as fallback anchors when snapshots are missing.
  const seed = opts.include_test_fixtures
    ? loadJsonIfExists(
        path.join(root, "worker/test/fixtures/entity-intelligence/domain_observations.json"),
      )
    : null;
  if (seed) {
    const haveLiveRules = observations.some((o) => o.domain === "rules");
    const haveLiveMeetings = observations.some((o) => o.domain === "meetings");
    if (!haveLiveRules) {
      for (const row of seed.rules || []) {
        const obs = observationFromRulesRow(row);
        if (obs) observations.push(obs);
      }
    }
    if (!haveLiveMeetings) {
      for (const row of seed.meetings || []) {
        const obs = observationFromMeetingsRow(row);
        if (obs) observations.push(obs);
      }
    }
    // People seed only when no live people observations were loaded.
    if (peopleLoaded === 0) {
      for (const row of seed.people || []) {
        const obs = observationFromPeopleRow(row);
        if (obs) observations.push(obs);
      }
    }
    // Optional extra money/land/payment rows for multi-domain demos
    for (const row of seed.money || []) {
      const obs = observationFromMoneyRow(row);
      if (obs) observations.push(obs);
    }
    for (const row of seed.payments || []) {
      const obs = observationFromPaymentRow(row);
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

  // --- Property: live domain observations (BBL densify) + fixture demos ---
  // site/data/property_domain_observations.json is the CPU-light snapshot of
  // /property-locations rows that already expose BBLs (~320 unique). Fixtures
  // keep hand-labelled owner / ZAP demo lots that may sit outside the live window.
  const propPaths = [
    path.join(root, "site/data/property_domain_observations.json"),
    ...(opts.include_test_fixtures
      ? [
          path.join(root, "worker/test/fixtures/property-cross-domain/corpus.json"),
          path.join(root, "test/fixtures/property_disposition/multi_notice_bbl.json"),
        ]
      : []),
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

  // --- Franchise / concession: densify fixtures + optional domain snapshot ---
  // Field cases include multi-notice party chains (OneChronos, Flushing GC) so
  // vendor lens gains named_franchisee edges. Calendar-only FCRC meetings
  // without parties are skipped by observationFromFranchise.
  const franchiseLimit = Number.isFinite(opts.franchise_limit) ? opts.franchise_limit : 200;
  const franchisePaths = [
    path.join(root, "site/data/franchise_domain_observations.json"),
    ...(opts.include_test_fixtures
      ? [
          path.join(root, "test/fixtures/franchise_concession/field_cases.json"),
          path.join(root, "test/fixtures/franchise_concession/multi_notice_densify.json"),
        ]
      : []),
  ];
  for (const p of franchisePaths) {
    const doc = loadJsonIfExists(p);
    if (!doc) continue;
    for (const obs of observationsFromFranchiseMaterialization(doc, {
      sourceSystem: cleanSourceSystem(
        doc.source?.system || doc.source_system,
        "city_record",
      ),
      limit: franchiseLimit,
    })) {
      observations.push(obs);
    }
  }
  // Optional seed franchise rows (hand-labelled firm parties).
  if (seed?.franchise) {
    for (const row of seed.franchise) {
      const obs = observationFromFranchise(row);
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
  return publicRecords(out, "entity intelligence observations");
}

/**
 * Build the materialization document written to site/ + worker/ data.
 */
export function buildEntityIntelligenceDoc(root, opts = {}) {
  const observations = collectCrossDomainObservations(root, opts);
  const corpus = buildIntelligenceCorpus(observations, {
    max_per_domain: opts.max_per_domain || 6,
    // The former fixture-era cap of 40 hid roots discovered by bulk lookups.
    // Keep the edge document bounded while retaining a useful densified corpus.
    max_entities: opts.max_entities || DEFAULT_ENTITY_MATERIALIZATION_CAP,
  });
  const vendorFootprint = buildVendorFootprintCoverage(
    corpus,
    loadJsonIfExists(path.join(root, "site/data/ocp_awards_warehouse_lookup.json")) || {},
    loadJsonIfExists(path.join(root, "warehouse/receipts/proof/wh04_er_batch_latest.json")) || {},
  );

  // Prefer a multi-domain demo that includes live people when present; else Parks;
  // else the first multi-domain entity.
  const multi = corpus.entities.filter((e) => (e.metrics?.domains_matched || 0) >= 2);
  const withPeople = multi.find((e) => e.domains?.people?.status === "matched");
  const parks = corpus.entities.find(
    (e) => e.root?.kind === "agency" && /parks/i.test(e.root?.ref || e.root?.canonical_id || ""),
  );
  // Demo must show people when the domain is productized (acceptance: people matched).
  // City Council (meetings + people) qualifies; Parks remains the densest multi-domain
  // when people is empty on other roots.
  const demoEntity = withPeople || parks || multi[0] || null;

  const bySubjectRef = buildSubjectEntityIndex(corpus);
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
    verified_demo: demoEntity
      ? {
          ref: demoEntity.root.ref,
          display_name: demoEntity.root.display_name,
          domains_matched: demoEntity.metrics.domains_matched,
          total_linked_objects: demoEntity.metrics.total_linked_objects,
          domain_status: Object.fromEntries(
            Object.entries(demoEntity.domains).map(([k, v]) => [k, { status: v.status, count: v.count }]),
          ),
        }
      : null,
    entities: corpus.entities,
    by_ref: corpus.by_ref,
    by_subject_ref: bySubjectRef,
    vendor_footprint: vendorFootprint,
    provenance: {
      sources: [
        "warehouse/fixtures/ocp-recent-contract-awards/product_seed.csv",
        "warehouse/fixtures/checkbook-spending/product_seed.csv",
        "warehouse/fixtures/zap-projects/product_seed.csv",
        "warehouse/fixtures/zap-bbl/product_seed.csv",
        "site/data/ocp_awards_warehouse_lookup.json",
        "site/data/zap_projects_warehouse_lookup.json",
        "site/data/zap_bbl_warehouse_lookup.json",
        "site/data/land_default_ulurp.json",
        "site/data/rules_domain_observations.json",
        "site/data/meetings_domain_observations.json",
        "site/data/people_domain_observations.json",
        "site/data/property_domain_observations.json",
        "site/data/franchise_domain_observations.json",
      ],
      methods: [
        "agency_canonical_v1",
        "vendor_stem_v1",
        "cross_domain_identity_v2",
        "zap_bbl_project_id_v1",
        "pin_authority_key_v1",
        "contract_id_join_v1",
        "checkbook_payment_v1",
        "exact_bbl_v1",
        "disposition_owner_label_v1",
        "rules_agency_issued_v1",
        "meetings_agency_hosts_v1",
        "people_votes_as_official_v1",
        "exact_ulurp_token_v1",
        "zap_project_ref_v1",
        "franchise_party_stem_v1",
      ],
      note:
        "Links only when identity normalizers or join keys resolve. Identity: agency/vendor across money/land/property/rules/meetings/people/franchise. Join keys: PIN (shares_authority_key), contract_id (references_contract / payment_on_contract), BBL (sited_on_parcel / property exact BBL), payee (paid_to_vendor), meeting body ULURP/ZAP → decides_land_project when the land project is in corpus, franchise party stem (named_franchisee). Rules and meetings densify from City Record domain snapshots; people densify from Legistar by_person retained on meeting-outcomes (never invented tallies). Property attaches via City Record agency_name and labeled disposition owners. Franchise densifies from FCRC / joint concession notices with confident firm counterparties only. Empty domains are explicit per entity.",
    },
  };
}

export function slimDocForWorker(doc) {
  // Worker payload: keep by_ref + summary; drop full entities array duplicate if large
  const footprint = doc.vendor_footprint
    ? (() => {
        const { awards_by_ref: awardsByRef = {}, ...meta } = doc.vendor_footprint;
        void awardsByRef;
        return meta;
      })()
    : null;
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
    by_subject_ref: doc.by_subject_ref,
    vendor_footprint: footprint,
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
