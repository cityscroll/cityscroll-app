#!/usr/bin/env node
/**
 * Densify money / procurement location observations for the map surface.
 *
 * OCP Recent Contract Awards (qyyg-4tf5) has no service-borough column. Location
 * is derived from title/body place phrases, citywide wording, facility names,
 * borough-scoped agencies, and (weakly) vendor addresses — never from PIN
 * prefixes alone. Vendor HQ is not treated as service geography when a stronger
 * matter/citywide signal exists.
 *
 * Writes a committed snapshot (like meetings/rules domain observations):
 *   site/data/money_domain_observations.json
 *
 * Usage:
 *   node tools/build_money_domain_observations.mjs
 *   node tools/build_money_domain_observations.mjs --check
 *   node tools/build_money_domain_observations.mjs --limit 300
 *   node tools/build_money_domain_observations.mjs --from-fixture
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compactDerivationStamp,
  placeFromDerivations,
} from "../site/location_derivation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/money_domain_observations.json");
const OPEN_RFPS = join(ROOT, "site/data/money_default_open.json");
const OCP_LOOKUP = join(ROOT, "site/data/ocp_awards_warehouse_lookup.json");
const OCP_SODA = "https://data.cityofnewyork.us/resource/qyyg-4tf5.json";

const SELECT = [
  "request_id",
  "start_date",
  "agency_name",
  "type_of_notice_description",
  "short_title",
  "pin",
  "contract_amount",
  "vendor_name",
  "vendor_address",
  "additional_description_1",
  "other_info_1",
  "category_description",
].join(",");

function parseArgs(argv) {
  const out = { check: false, fromFixture: false, limit: 300 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--check") out.check = true;
    else if (argv[i] === "--from-fixture") out.fromFixture = true;
    else if (argv[i] === "--limit") out.limit = Number(argv[++i]) || 300;
  }
  return out;
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function stampRow(raw, sourceSystem) {
  const row = {
    request_id: raw.request_id || null,
    start_date: raw.start_date || null,
    agency_name: raw.agency_name || null,
    type_of_notice_description: raw.type_of_notice_description || null,
    short_title: raw.short_title || null,
    pin: raw.pin || null,
    contract_amount: raw.contract_amount != null ? raw.contract_amount : null,
    vendor_name: raw.vendor_name || null,
    // Keep vendor_address for offline re-derive / weak fallback; not shown as service place.
    vendor_address: raw.vendor_address || null,
    // Body kept only long enough to derive; stripped from public snapshot below.
    additional_description_1: raw.additional_description_1 || null,
    other_info_1: raw.other_info_1 || null,
    category_description: raw.category_description || null,
    source_system: sourceSystem,
  };
  const place = placeFromDerivations(row, { forLens: "money" });
  const stamp = compactDerivationStamp(place) || {
    scope: "unlocated",
    unlocated_reason: place?.unlocated_reason || "no_place_signal",
  };
  // Public map stamp: scope + boroughs/CDs + methods only.
  // Drop addresses and evidence spans (street text is not needed for choropleth).
  delete stamp.addresses;
  if (stamp.derivation && typeof stamp.derivation === "object") {
    const { methods, confidence, role, confidence_tier } = stamp.derivation;
    stamp.derivation = {
      ...(methods ? { methods } : {}),
      ...(confidence != null ? { confidence } : {}),
      ...(role ? { role } : {}),
      ...(confidence_tier ? { confidence_tier } : {}),
    };
  }
  // Public snapshot: compact place stamp only — no award prose, vendor identity,
  // or address (those can re-derive offline from Open Data if needed).
  return {
    request_id: row.request_id,
    start_date: row.start_date,
    agency_name: row.agency_name,
    type_of_notice_description: row.type_of_notice_description,
    pin: row.pin,
    source_system: sourceSystem,
    place: stamp,
  };
}

async function fetchOcpAwards(limit) {
  const pageSize = Math.min(100, limit);
  const rows = [];
  let offset = 0;
  while (rows.length < limit) {
    const take = Math.min(pageSize, limit - rows.length);
    const url = `${OCP_SODA}?$select=${encodeURIComponent(SELECT)}`
      + `&$order=${encodeURIComponent("start_date DESC")}`
      + `&$limit=${take}&$offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CityScroll-map-money-densify/1.0 (+https://cityscroll.org)",
      },
    });
    if (!res.ok) {
      throw new Error(`OCP SODA HTTP ${res.status} for ${url}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < take) break;
    offset += batch.length;
  }
  return rows;
}

function rowsFromFixture() {
  const ocp = loadJson(OCP_LOOKUP);
  const open = loadJson(OPEN_RFPS);
  const out = [];
  for (const r of ocp?.rows || []) {
    out.push(stampRow(r, "ocp_awards_warehouse_lookup"));
  }
  for (const r of open?.notices || []) {
    out.push(stampRow(r, "money_default_open"));
  }
  return out;
}

function summarize(rows) {
  const byScope = { local: 0, citywide: 0, unlocated: 0 };
  const byMethod = Object.create(null);
  for (const r of rows) {
    const scope = r.place?.scope || "unlocated";
    byScope[scope] = (byScope[scope] || 0) + 1;
    for (const m of r.place?.derivation?.methods || []) {
      byMethod[m] = (byMethod[m] || 0) + 1;
    }
    if (scope === "unlocated") {
      const reason = r.place?.unlocated_reason || "no_place_signal";
      byMethod[`unlocated:${reason}`] = (byMethod[`unlocated:${reason}`] || 0) + 1;
    }
  }
  return { by_scope: byScope, by_method: byMethod };
}

function buildDoc(rows, meta = {}) {
  const agencies = new Set(rows.map((r) => r.agency_name).filter(Boolean));
  return {
    schema_version: 1,
    domain: "money",
    title: "Money domain observations (map densify)",
    description:
      "Recent OCP awards (+ open RFPs) with compact place stamps for the map money lens. "
      + "Place is derived from title/body/agency signals; most contracts are genuinely "
      + "non-spatial or citywide service classes.",
    retrieved_at: meta.retrievedAt || new Date().toISOString(),
    window_days: meta.windowDays || null,
    source: meta.source || "ocp-recent-contract-awards+money_default_open",
    row_count: rows.length,
    agency_count: agencies.size,
    summary: summarize(rows),
    place_stamp_note:
      "place is a compact derivation stamp (scope/boroughs/methods). Raw award body is not committed.",
    rows,
  };
}

function check(doc) {
  if (!doc || doc.domain !== "money") throw new Error("money_domain_observations domain mismatch");
  if (!Array.isArray(doc.rows) || doc.rows.length < 20) {
    throw new Error(`expected densified money corpus (≥20 rows), got ${doc.rows?.length || 0}`);
  }
  const located = doc.rows.filter((r) => r.place?.scope === "local" || r.place?.scope === "citywide");
  if (located.length < 5) {
    throw new Error(`expected some located money rows, got ${located.length}`);
  }
  const citywide = doc.rows.filter((r) => r.place?.scope === "citywide").length;
  const local = doc.rows.filter((r) => r.place?.scope === "local").length;
  // Honest bar: a non-trivial share stays unlocated (citywide services / no place signal).
  const unlocated = doc.rows.length - citywide - local;
  if (unlocated < 1) {
    throw new Error("expected some unlocated money rows — over-geocoding is a bug");
  }
  return { located: located.length, citywide, local, unlocated };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.check) {
    const existing = loadJson(OUT);
    if (!existing) {
      console.error("missing", OUT);
      process.exit(1);
    }
    const stats = check(existing);
    console.log("money_domain_observations ok", {
      rows: existing.row_count,
      ...stats,
      summary: existing.summary,
    });
    process.exit(0);
  }

  let rows;
  let source;
  if (args.fromFixture) {
    rows = rowsFromFixture();
    source = "fixture:ocp_lookup+money_default_open";
  } else {
    const ocp = await fetchOcpAwards(args.limit);
    rows = ocp.map((r) => stampRow(r, "ocp-recent-contract-awards"));
    // Merge open solicitations (title-only place signals) without duplicating request_id.
    const seen = new Set(rows.map((r) => r.request_id).filter(Boolean));
    const open = loadJson(OPEN_RFPS);
    for (const n of open?.notices || []) {
      if (n.request_id && seen.has(n.request_id)) continue;
      rows.push(stampRow(n, "money_default_open"));
      if (n.request_id) seen.add(n.request_id);
    }
    source = "ocp-recent-contract-awards+money_default_open";
  }

  const doc = buildDoc(rows, { source, retrievedAt: new Date().toISOString() });
  const stats = check(doc);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  console.log("wrote", OUT, {
    rows: doc.row_count,
    ...stats,
    by_method: doc.summary.by_method,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
