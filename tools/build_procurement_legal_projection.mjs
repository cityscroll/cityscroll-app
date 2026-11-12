#!/usr/bin/env node
// Builds site/procurement_legal_projection.mjs: the small, browser-safe projection of
// the PPB 3-08 policy registry and the procurement legal register that site modules read.
//
// Site modules ship to browsers and the Pages bundle (no node builtins), so they cannot
// import ontology/load.mjs, ontology/procurement_policy.mjs or the legal register module.
// This tool evaluates the register with its own effectFor at build time and writes plain
// data; no number in the output is typed by hand. `--check` fails when the committed file
// differs from a fresh build (drift guard, also asserted by test/procurement_legal_projection.test.mjs).
//
// Engine path: tools/build_procurement_legal_projection.mjs
//   node tools/build_procurement_legal_projection.mjs --write
//   node tools/build_procurement_legal_projection.mjs --check

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROCUREMENT_LEGAL_PROJECTION_SCHEMA = "cityscroll.procurement_legal_projection.v1";
export const PROJECTION_RELATIVE = "site/procurement_legal_projection.mjs";

const LEGAL_CATEGORIES = ["goods", "standard_services", "professional_services", "construction", "human_services"];
const AWARDEE_FORMS = ["for_profit", "not_for_profit"];
const EARLIEST = "0001-01-01";

// Register category -> policy-registry band category. Authority: 3-08(c)(1)(ii) "goods and
// all services except construction" (resolves kd.policy_registry_category_vocabulary).
const BAND_CATEGORY_AUTHORITY = Object.freeze({
  rule_id: "nyc.ppb.3-08.c.1.ii.micropurchase_limits",
  phrase: "goods and all services except construction",
});
const BAND_CATEGORY_BY_LEGAL_CATEGORY = Object.freeze({
  goods: "goods_and_non_construction_services",
  standard_services: "goods_and_non_construction_services",
  professional_services: "goods_and_non_construction_services",
  human_services: "goods_and_non_construction_services",
  construction: "construction",
});

// Floor kind -> register rule id. Days, units, citations and review status come from the register.
export const FLOOR_RULE_IDS = Object.freeze({
  competitive_sealed_proposal: "app.solicitation_method.response_floor.default_competitive_20_calendar_days",
  competitive_sealed_proposal_section_6_129: "app.solicitation_method.response_floor.section_6_129_27_calendar_days",
  competitive_sealed_bid: "nyc.ppb.3-02.c.bidding_time_15_days",
  competitive_sealed_bid_section_6_129: "nyc.ppb.3-02.e.1.i.section_6_129_bid_notice_22_days",
  accelerated: "app.solicitation_method.response_floor.accelerated_3_business_days",
});

function latestById(entries) {
  const latest = new Map();
  for (const entry of entries) {
    const prior = latest.get(entry.id);
    if (!prior || entry.record_version > prior.record_version) latest.set(entry.id, entry);
  }
  return latest;
}

function breakpointsFor(entries) {
  const dates = new Set([EARLIEST]);
  for (const entry of entries) {
    for (const date of [entry.effective_from, entry.effective_to, entry.in_force_as_of]) {
      if (date) dates.add(date);
    }
  }
  return [...dates].sort();
}

function intervalsOf(points, evaluate) {
  const intervals = [];
  points.forEach((from, index) => {
    const value = evaluate(from);
    const to = points[index + 1] ?? null;
    const prior = intervals.at(-1);
    if (prior && JSON.stringify(prior.value) === JSON.stringify(value)) {
      prior.to = to;
    } else {
      intervals.push({ from, to, value });
    }
  });
  return intervals.map(({ from, to, value }) => ({ from, to, ...value }));
}

function participationKind(result) {
  if (result.value === "not_applicable") return "not_applicable";
  const missing = result.missing_facts || [];
  if (result.value === "unknown"
    && result.reason === "rule_status_unknown"
    && !missing.includes("procurement_category")
    && !missing.some((fact) => fact.startsWith("effective_from_before:"))) {
    return "not_ruled_out";
  }
  return "unknown";
}

function ruleRecord(entry) {
  return {
    record_version: entry.record_version,
    kind: entry.kind,
    instrument: entry.authority.instrument,
    section: entry.authority.section,
    review_status: entry.review.status,
    quote: entry.authority.quote ?? null,
  };
}

// The register categories a record of each family can legally have, used as the candidate
// set when a record carries no category. Basis: the 3-08 subsection that defines the family.
// Each phrase must occur in the retained ppb-3-08.md text (checked when sources are supplied).
export const FAMILY_CATEGORY_BASIS = Object.freeze({
  ordinary_micropurchase: Object.freeze({
    section: "9 RCNY 3-08(c)(1)(ii)",
    phrases: ["For procurements of goods and all services except construction the value of which is $20,000 or less, and for procurements of construction the value of which is $35,000 or less"],
  }),
  ordinary_5_plus_10: Object.freeze({
    section: "9 RCNY 3-08(c)(1)(iii)",
    phrases: ["for procurements of goods and all services except construction valued over $20,000 through the small purchase limit or procurements of construction valued over $35,000 through the small purchase limit"],
  }),
  mwbe_small_purchase: Object.freeze({
    section: "9 RCNY 3-08(c)(1)(iv)",
    phrases: [
      "No competition is required for the procurement of goods, services, and construction from M/WBE vendors",
      "Additionally, agencies shall not make purchases pursuant to this subparagraph for human services.",
    ],
    exclusion_rule_id: "nyc.ppb.3-08.c.1.iv.mwbe_small_purchase_excludes_human_services",
  }),
});

function legalCategoriesFor(familyId, family, latest, sources) {
  const basis = FAMILY_CATEGORY_BASIS[familyId];
  if (!basis) throw new Error(`projection: no category basis for family ${familyId}`);
  if (sources) {
    const text = String(sources["ppb-3-08.md"] || "").replace(/\s+/g, " ");
    for (const phrase of basis.phrases) {
      if (!text.includes(phrase)) throw new Error(`projection: ${basis.section} phrase not in ppb-3-08.md`);
    }
  }
  const excluded = family.applicability.excluded_categories;
  // Every registry exclusion must be backed by a register rule naming the same categories.
  if (excluded.length) {
    const rule = latest.get(basis.exclusion_rule_id);
    const named = rule?.applies_when?.procurement_category || [];
    if (!rule || rule.review.status === "unreviewed" || JSON.stringify([...named].sort()) !== JSON.stringify([...excluded].sort())) {
      throw new Error(`projection: ${familyId} exclusions are not backed by a checked register rule`);
    }
  }
  return {
    legal_categories: LEGAL_CATEGORIES.filter((c) => !excluded.includes(c)),
    legal_categories_basis: basis.section,
    legal_categories_exclusion_rule_id: basis.exclusion_rule_id || null,
  };
}

function policyProjection(policyRegistry, latest, sources) {
  const families = {};
  for (const family of policyRegistry.method_families) {
    if (!family.applicability.amount_bands?.length) continue;
    families[family.id] = {
      effective_from: family.effective_from,
      effective_to: family.effective_to,
      excluded_categories: [...family.applicability.excluded_categories],
      ...legalCategoriesFor(family.id, family, latest, sources),
      bands: Object.fromEntries(family.applicability.amount_bands.map((band) => [band.procurement_category, {
        min: band.minimum,
        minInclusive: band.minimum_inclusive,
        max: band.maximum,
        maxInclusive: band.maximum_inclusive,
      }])),
      stages: Object.fromEntries(family.stages.map((stage) => [stage.id, {
        publication_obligation: stage.publication_obligation,
        effective_from: stage.effective_from,
        effective_to: stage.effective_to,
      }])),
    };
  }
  return {
    registry_version: policyRegistry.version,
    effective_from: policyRegistry.source.effective_from,
    families,
  };
}

/** Pure build: { register, policyRegistry, legal: { effectFor, validateLegalRegister } } -> projection object. */
export function buildProcurementLegalProjection({ register, policyRegistry, legal, sources = null }) {
  if (sources) legal.validateLegalRegister(register, { policyRegistry, sources });
  const latest = latestById(register.entries);
  const ctx = { register, policyRegistry };
  const rules = new Map();
  const cite = (id) => {
    const entry = latest.get(id);
    if (!entry) throw new Error(`projection: rule ${id} is not in the register`);
    rules.set(id, ruleRecord(entry));
    return entry;
  };

  const authority = cite(BAND_CATEGORY_AUTHORITY.rule_id);
  if (authority.review.status === "unreviewed"
    || !String(authority.authority.quote || "").includes(BAND_CATEGORY_AUTHORITY.phrase)) {
    throw new Error("projection: band-category translation lost its source-checked authority");
  }

  // Publisher category labels -> candidate sets (register vocabulary_mapping entries).
  const category_labels = {};
  for (const entry of [...latest.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const label = entry.effect?.publisher_category_label;
    if (entry.kind !== "vocabulary_mapping" || typeof label !== "string") continue;
    if (entry.effective_to !== null) continue;
    const candidates = entry.applies_when?.procurement_category;
    if (!Array.isArray(candidates) || candidates.length === 0) continue;
    if (category_labels[label]) throw new Error(`projection: label ${label} is mapped twice`);
    cite(entry.id);
    category_labels[label] = { candidates: [...candidates].sort(), rule_id: entry.id };
  }

  // 6-129 participation requirement over the facts a page can supply.
  const participationEntries = [...latest.values()].filter((e) => "mwbe_participation_requirement" in e.effect);
  const participationPoints = breakpointsFor(participationEntries);
  const participation = {};
  for (const category of [...LEGAL_CATEGORIES, null]) {
    for (const form of [null, ...AWARDEE_FORMS]) {
      const key = `${category ?? "_"}|${form ?? "_"}`;
      participation[key] = intervalsOf(participationPoints, (date) => {
        const facts = { occurred_on: date };
        if (category) facts.procurement_category = category;
        if (form) facts.awardee_legal_form = form;
        const result = legal.effectFor(facts, "mwbe_participation_requirement", ctx);
        result.rule_ids.forEach(cite);
        return {
          value: result.value,
          kind: participationKind(result),
          rule_ids: [...result.rule_ids].sort(),
          review_status: result.value === "not_applicable" ? result.review_status : null,
        };
      });
    }
  }

  // Charter 311(i)(1) ceiling as the register records it (kd.mwbe_small_purchase_ceiling_dates).
  const ceilingEntries = [...latest.values()].filter((e) => "mwbe_small_purchase_max_usd" in e.effect);
  const mwbe_small_purchase_ceiling = intervalsOf(breakpointsFor(ceilingEntries), (date) => {
    const result = legal.effectFor({}, "mwbe_small_purchase_max_usd", { ...ctx, asOf: date });
    result.rule_ids.forEach(cite);
    return {
      max_usd: typeof result.value === "number" ? result.value : null,
      rule_ids: [...result.rule_ids].sort(),
      review_status: typeof result.value === "number" ? result.review_status : null,
    };
  });

  const floors = {};
  for (const [kind, id] of Object.entries(FLOOR_RULE_IDS)) {
    const entry = cite(id);
    const calendar = entry.effect.minimum_response_calendar_days;
    const business = entry.effect.minimum_response_business_days;
    if (!Number.isInteger(calendar ?? business)) throw new Error(`projection: floor ${id} has no day count`);
    floors[kind] = {
      rule_id: id,
      days: calendar ?? business,
      day_unit: calendar != null ? "calendar_days" : "business_days",
      in_force_from: entry.effective_from ?? entry.in_force_as_of,
      in_force_to: entry.effective_to,
      before_in_force_from: entry.effective_from ? "not_in_force" : "unknown",
    };
  }

  return {
    schema: PROCUREMENT_LEGAL_PROJECTION_SCHEMA,
    generated_from: {
      legal_register_version: register.version,
      policy_registry_version: policyRegistry.version,
    },
    policy: policyProjection(policyRegistry, latest, sources),
    band_category_by_legal_category: { ...BAND_CATEGORY_BY_LEGAL_CATEGORY },
    band_category_rule_id: BAND_CATEGORY_AUTHORITY.rule_id,
    category_labels,
    participation: { effect_key: "mwbe_participation_requirement", key_format: "procurement_category|awardee_legal_form", table: participation },
    mwbe_small_purchase_ceiling,
    floors,
    rules: Object.fromEntries([...rules.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function renderProcurementLegalProjectionModule(projection) {
  return [
    "// GENERATED by tools/build_procurement_legal_projection.mjs. Do not edit.",
    "// Sources: ontology/registry.v0.json (procurement_policy_registry) and",
    "// ontology/procurement_legal_register.v1.json, evaluated with the register's effectFor.",
    "// Browser-safe (no imports). Drift check: node tools/build_procurement_legal_projection.mjs --check",
    "",
    "function deepFreeze(value) {",
    "  if (value && typeof value === \"object\") {",
    "    for (const child of Object.values(value)) deepFreeze(child);",
    "    Object.freeze(value);",
    "  }",
    "  return value;",
    "}",
    "",
    `export const PROCUREMENT_LEGAL_PROJECTION = deepFreeze(${JSON.stringify(projection, null, 1)});`,
    "",
  ].join("\n");
}

async function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const mode = argv.includes("--write") ? "write" : argv.includes("--check") ? "check" : null;
  if (!mode) throw new Error("usage: build_procurement_legal_projection.mjs --write|--check");
  const legal = await import(pathToFileURL(join(root, "ontology/procurement_legal_register.mjs")).href);
  const { loadOntologyRegistry } = await import(pathToFileURL(join(root, "ontology/load.mjs")).href);
  const register = legal.loadProcurementLegalRegister();
  const policyRegistry = loadOntologyRegistry().procurement_policy_registry;
  const sources = Object.fromEntries(Object.keys(register.sources.files).map((file) => (
    [file, readFileSync(join(root, register.sources.root, file), "utf8")]
  )));
  const text = renderProcurementLegalProjectionModule(
    buildProcurementLegalProjection({ register, policyRegistry, legal, sources }),
  );
  const out = join(root, PROJECTION_RELATIVE);
  if (mode === "write") {
    writeFileSync(out, text);
    return 0;
  }
  if (readFileSync(out, "utf8") !== text) {
    console.error(`${PROJECTION_RELATIVE} is stale; run node tools/build_procurement_legal_projection.mjs --write`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
