#!/usr/bin/env node
// Build per-district per-lens activity aggregates for the map exploration
// surface (cs-geo-04). Reads committed corpora + the cs-geo-02 boundary layer.
// No live GIS.
//
//   node tools/build_district_activity.mjs
//   node tools/build_district_activity.mjs --check

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDistrictActivity, DISTRICT_ACTIVITY_SCHEMA } from "./lib/district_activity.mjs";
import { buildDistrictWeeklyDigests } from "./lib/district_weekly_digest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_OUT = join(ROOT, "site/data/district_activity.json");
const WORKER_OUT = join(ROOT, "worker/src/data/district_activity.json");
const DIGEST_OUT = join(ROOT, "site/data/district_weekly_digests.json");

const PATHS = {
  boundaries: join(ROOT, "site/data/district_boundaries.json"),
  zap: join(ROOT, "site/data/zap_projects_warehouse_lookup.json"),
  property: join(ROOT, "site/data/property_domain_observations.json"),
  meetings: join(ROOT, "site/data/meetings_domain_observations.json"),
  rules: join(ROOT, "site/data/rules_domain_observations.json"),
  // Prefer densified money domain observations (OCP awards + open RFPs with
  // place stamps). Fall back to the slim OCP warehouse lookup when missing.
  money: join(ROOT, "site/data/money_domain_observations.json"),
  moneyFallback: join(ROOT, "site/data/ocp_awards_warehouse_lookup.json"),
  contractActions: join(ROOT, "site/data/contract_action_address_locations.json"),
};

function loadJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadInputs() {
  const boundaries = loadJson(PATHS.boundaries);
  if (!boundaries?.boundary_vintage) {
    throw new Error("missing site/data/district_boundaries.json with boundary_vintage");
  }
  const zap = loadJson(PATHS.zap);
  const property = loadJson(PATHS.property);
  const meetings = loadJson(PATHS.meetings);
  const rules = loadJson(PATHS.rules);
  const money = loadJson(PATHS.money) || loadJson(PATHS.moneyFallback);
  const contractActions = loadJson(PATHS.contractActions);

  return {
    boundaries,
    zapRows: Array.isArray(zap?.rows) ? zap.rows : [],
    propertyRows: Array.isArray(property?.property_rows) ? property.property_rows : [],
    meetingsRows: Array.isArray(meetings?.rows) ? meetings.rows : [],
    rulesRows: Array.isArray(rules?.rows) ? rules.rows : [],
    moneyRows: Array.isArray(money?.rows) ? money.rows : [],
    contractActionRows: Array.isArray(contractActions?.rows) ? contractActions.rows : [],
    districtCorpora: {
      property: {
        path: "data/property_domain_observations.json",
        collection: "property_rows",
        stamp_field: "generated_at",
        stamp_value: property?.generated_at || null,
      },
      meetings: {
        path: "data/meetings_domain_observations.json",
        collection: "rows",
        stamp_field: "retrieved_at",
        stamp_value: meetings?.retrieved_at || null,
      },
    },
  };
}

function build() {
  const inputs = loadInputs();
  const builtAt = new Date().toISOString();
  return {
    activity: buildDistrictActivity({ ...inputs, builtAt }),
    digest: buildDistrictWeeklyDigests({ ...inputs, builtAt }),
  };
}

function check(doc) {
  if (!doc || doc.schema !== DISTRICT_ACTIVITY_SCHEMA) {
    throw new Error("district_activity schema mismatch");
  }
  if (!doc.boundary_vintage) throw new Error("missing boundary_vintage");
  if (!doc.by_level?.borough || !doc.by_level?.community_district || !doc.by_level?.council_district) {
    throw new Error("missing by_level bags");
  }
  const itemIndex = doc.district_items;
  if (
    itemIndex?.schema !== "cityscroll.district_items.v1"
    || itemIndex.boundary_vintage !== doc.boundary_vintage
    || itemIndex.built_at !== doc.built_at
  ) throw new Error("district item index stamp mismatch");
  for (const lens of ["property", "meetings"]) {
    const corpus = itemIndex.corpora?.[lens];
    if (!corpus?.path || !corpus?.collection || !corpus?.stamp_field || !corpus?.stamp_value) {
      throw new Error(`${lens} district item corpus descriptor missing`);
    }
    const sourceDoc = loadJson(join(ROOT, "site", corpus.path));
    if (sourceDoc?.[corpus.stamp_field] !== corpus.stamp_value) {
      throw new Error(`${lens} district item corpus stamp mismatch`);
    }
    const sourceRows = Array.isArray(sourceDoc?.[corpus.collection])
      ? sourceDoc[corpus.collection]
      : [];
    const sourceIds = new Set(sourceRows.map((row) => String(row?.request_id || "")).filter(Boolean));
    if ((doc.sources?.[lens]?.indexed || 0) !== (doc.sources?.[lens]?.counted || 0)) {
      throw new Error(`${lens} item index does not cover its counted corpus`);
    }
    for (const level of ["borough", "community_district", "council_district"]) {
      for (const [id, counts] of Object.entries(doc.by_level[level] || {})) {
        const special = level === "borough" && id === "Citywide"
          ? itemIndex.citywide?.[lens]
          : level === "borough" && id === "Virtual"
            ? itemIndex.virtual?.[lens]
            : itemIndex.by_level?.[level]?.[id]?.[lens];
        if ((counts?.[lens] || 0) !== (special?.length || 0)) {
          throw new Error(`${lens} ${level} ${id} count/list drift`);
        }
        for (const requestId of special || []) {
          if (!sourceIds.has(String(requestId))) {
            throw new Error(`${lens} ${level} ${id} member missing from stamped corpus`);
          }
        }
      }
    }
  }
  const boroughKeys = Object.keys(doc.by_level.borough);
  if (boroughKeys.length < 5) throw new Error("expected 5 boroughs");
  const cdKeys = Object.keys(doc.by_level.community_district);
  if (cdKeys.length < 50) throw new Error("expected regular community districts");
  const councilKeys = Object.keys(doc.by_level.council_district);
  if (councilKeys.length < 51) throw new Error("expected 51 council districts");
  // At least land + property should have some located rows.
  if ((doc.sources?.land?.located || 0) < 1) {
    throw new Error("expected some located land activity");
  }
  if ((doc.sources?.property?.located || 0) < 1) {
    throw new Error("expected some located property activity");
  }
  // Meetings is the place-based lens — zero located across the corpus is a wiring bug.
  if ((doc.sources?.meetings?.counted || 0) > 0 && (doc.sources?.meetings?.located || 0) < 1) {
    throw new Error("expected some located meetings activity when the corpus is non-empty");
  }
  // Granularity gates: land + meetings must resolve to council districts when coarser density exists.
  const sumLevel = (level, lens) => {
    const bag = doc.by_level?.[level] || {};
    let sum = 0;
    for (const [id, counts] of Object.entries(bag)) {
      if (level === "borough" && (id === "Citywide" || id === "Virtual")) continue;
      sum += Number(counts?.[lens]) || 0;
    }
    return sum;
  };
  if (sumLevel("community_district", "land") > 0 && sumLevel("council_district", "land") < 1) {
    throw new Error("land has community-district density but council_district is all-zero");
  }
  if (sumLevel("borough", "meetings") > 0 && sumLevel("council_district", "meetings") < 1) {
    throw new Error("meetings has borough density but council_district is all-zero");
  }
  // Citywide first-class bag when rules default citywide.
  if ((doc.sources?.rules?.located || 0) > 0) {
    const cw = Number(doc.citywide?.rules) || Number(doc.by_level?.borough?.Citywide?.rules) || 0;
    const localRules = sumLevel("borough", "rules") + sumLevel("community_district", "rules");
    // At least one of citywide bag or local borough/CD density must hold rules.
    if (cw < 1 && localRules < 1) {
      throw new Error("rules located but neither citywide bag nor local density holds them");
    }
  }
  // Money corpus: when densified, require some located rows OR an explicit
  // citywide/unlocated framing signal (zeros that look broken are not OK).
  if ((doc.sources?.money?.counted || 0) >= 20) {
    const moneyLocated = Number(doc.sources?.money?.located) || 0;
    const moneyCw = Number(doc.citywide?.money) || Number(doc.by_level?.borough?.Citywide?.money) || 0;
    const moneyUnloc = Number(doc.unlocated?.money) || 0;
    if (moneyLocated < 1 && moneyCw < 1) {
      throw new Error("money corpus counted but neither located nor citywide density exists");
    }
    if (moneyUnloc < 1 && moneyLocated === (doc.sources?.money?.counted || 0)) {
      // Allow all-located corpora; only fail when framing metadata is missing.
    }
  }
  const actionLayer = doc.basis_layers?.contract_action_address;
  if (actionLayer?.sources?.money?.counted > 0) {
    if (actionLayer.is_place_of_performance !== false) {
      throw new Error("contract action-address layer must remain non-performance geography");
    }
    if ((actionLayer.sources.money.with_address || 0) > 0 && (actionLayer.sources.money.located || 0) < 1) {
      throw new Error("contract action-address corpus has addresses but no resolved locations");
    }
  }
}

function writeTwin(doc) {
  const text = JSON.stringify(doc) + "\n";
  mkdirSync(dirname(SITE_OUT), { recursive: true });
  writeFileSync(SITE_OUT, text);
  mkdirSync(dirname(WORKER_OUT), { recursive: true });
  writeFileSync(WORKER_OUT, text);
}

function checkDigest(doc) {
  if (doc?.schema !== "district_weekly_digests.v1") throw new Error("district weekly digest schema mismatch");
  if (Object.keys(doc.by_council_district || {}).length !== 51) throw new Error("district weekly digest requires 51 districts");
  for (const [id, record] of Object.entries(doc.by_council_district || {})) {
    const items = Array.isArray(record?.items) ? record.items : [];
    if (record.total !== items.length) throw new Error(`district ${id} count/list drift`);
    if (items.length > (doc.performance?.max_items_per_district || 100)) throw new Error(`district ${id} exceeds item cap`);
  }
  if ((doc.performance?.measured_bytes || Infinity) > (doc.performance?.ceiling_bytes || 0)) {
    throw new Error("district weekly digest exceeds payload ceiling");
  }
}

function writeDigest(doc) {
  mkdirSync(dirname(DIGEST_OUT), { recursive: true });
  writeFileSync(DIGEST_OUT, JSON.stringify(doc) + "\n");
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

if (checkOnly) {
  const existing = loadJson(SITE_OUT);
  if (!existing) {
    console.error("missing", SITE_OUT);
    process.exit(1);
  }
  check(existing);
  // Rebuild and compare shape invariants (not full byte equality — built_at moves).
  const existingDigest = loadJson(DIGEST_OUT);
  checkDigest(existingDigest);
  const fresh = build();
  check(fresh.activity);
  checkDigest(fresh.digest);
  if (existing.boundary_vintage !== fresh.activity.boundary_vintage) {
    console.error("boundary_vintage drift vs boundary layer");
    process.exit(1);
  }
  console.log("district_activity ok", {
    boundary_vintage: existing.boundary_vintage,
    land_located: existing.sources?.land?.located,
    property_located: existing.sources?.property?.located,
    meetings_located: existing.sources?.meetings?.located,
    rules_located: existing.sources?.rules?.located,
    money_located: existing.sources?.money?.located,
    district_digest_bytes: existingDigest.performance?.measured_bytes,
  });
  process.exit(0);
}

const { activity: doc, digest } = build();
check(doc);
checkDigest(digest);
writeTwin(doc);
writeDigest(digest);
console.log("wrote", SITE_OUT, {
  boundary_vintage: doc.boundary_vintage,
  sources: doc.sources,
  district_digest_bytes: digest.performance.measured_bytes,
});
