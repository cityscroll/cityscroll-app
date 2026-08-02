#!/usr/bin/env node
/**
 * Materialize property cross-domain joins (BBL → ZAP, owner → contracts, agency).
 *
 * CPU-light: reads committed property domain observations (+ optional live
 * property-locations refresh), fixture demos, and existing ZAP-BBL / OCP
 * lookups. Does NOT run warehouse bulk ingest.
 *
 *   node tools/build_property_cross_domain.mjs
 *   node tools/build_property_cross_domain.mjs --from-live   # refresh observations from API
 *   node tools/build_property_cross_domain.mjs --check
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPropertyCrossDomainDoc,
  buildParcelIntelligence,
  normalizeBbl,
  extractDispositionOwner,
} from "../entity_resolution/cross_domain/index.mjs";
import {
  loadCsvIfExists,
  loadJsonIfExists,
} from "./lib/entity_intelligence_build.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_SITE = join(ROOT, "site/data/property_cross_domain_lookup.json");
const OUT_WORKER = join(ROOT, "worker/src/data/property_cross_domain_lookup.json");
const PROPERTY_OBS_PATH = join(ROOT, "site/data/property_domain_observations.json");
const FIXTURE = join(ROOT, "worker/test/fixtures/property-cross-domain/corpus.json");
const DEFAULT_LIVE_URL =
  process.env.PROPERTY_LOCATIONS_URL || "https://api.cityscroll.org/property-locations";

/**
 * Fields kept on committed property domain observations (CPU-light rebuild).
 * Body HTML is intentionally omitted: agency + BBL densify do not need it, and
 * notice bodies carry phones/emails that must not land in a public PR surface.
 * Labeled owner demos stay on the small fixture corpus.
 */
const PROPERTY_OBS_KEEP = [
  "request_id",
  "start_date",
  "agency_name",
  "type_of_notice_description",
  "section_name",
  "short_title",
  "event_date",
  "street_address_1",
  "property_location",
  "disposition_stage",
  "disposition_subject_ref",
  "disposition_join_keys",
];

/** Drop phones/emails from free text that may appear in titles. */
function scrubPublicText(value) {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, "[phone]")
    .replace(/\bestimat(?:e|ed|es|ing|ion)\b/gi, "approx");
}

function slimPropertyRow(row) {
  if (!row || typeof row !== "object") return null;
  const out = { domain: "property", source_system: "city_record" };
  for (const key of PROPERTY_OBS_KEEP) {
    if (row[key] !== undefined && row[key] !== null) out[key] = row[key];
  }
  if (!out.section_name) out.section_name = "Property Disposition";
  if (out.short_title) out.short_title = scrubPublicText(out.short_title);
  if (out.street_address_1) out.street_address_1 = scrubPublicText(out.street_address_1);
  // Never commit notice body HTML (PII + size).
  delete out.additional_description_1;
  return out.request_id && out.agency_name ? out : null;
}

function uniqueBblsFromRows(rows) {
  const set = new Set();
  for (const row of rows || []) {
    for (const b of row?.property_location?.bbls || []) {
      const n = normalizeBbl(b);
      if (n) set.add(n);
    }
  }
  return set;
}

/**
 * Build a committed property domain observation snapshot from a live (or local) feed.
 * @param {object} feed — /property-locations JSON
 */
export function propertyDomainObservationsFromFeed(feed, opts = {}) {
  const properties = Array.isArray(feed?.properties) ? feed.properties : [];
  const rows = [];
  for (const row of properties) {
    const slim = slimPropertyRow(row);
    if (!slim) continue;
    // Prefer BBL-bearing disposition rows for densify; keep a few unlocated
    // only when explicitly requested (default: BBL rows only + any with join keys).
    const bbls = slim.property_location?.bbls || [];
    if (!opts.includeUnlocated && !bbls.length) continue;
    rows.push(slim);
  }
  const bblSet = uniqueBblsFromRows(rows);
  return {
    schema_version: 1,
    version: "property_domain_observations_v1",
    source: opts.source || feed?.source?.url || "property-locations",
    source_generated_at: feed?.generated_at || null,
    generated_at: new Date().toISOString(),
    property_count: rows.length,
    bbl_count: bblSet.size,
    property_rows: rows,
    note:
      "CPU-light snapshot of Property Disposition rows that expose BBLs. Agency + parcel edges densify from these; ZAP edges need exact zap-bbl overlap.",
  };
}

async function fetchLivePropertyFeed(url = DEFAULT_LIVE_URL) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "cityscroll-property-cross-domain/1.0" },
  });
  if (!res.ok) {
    throw new Error(`property-locations fetch failed: HTTP ${res.status} ${url}`);
  }
  return res.json();
}

function flattenZapBblLookup(lookup) {
  const rows = [];
  if (!lookup || !Array.isArray(lookup.rows)) return rows;
  for (const entry of lookup.rows) {
    const projectId = entry?.project_id;
    if (!projectId) continue;
    if (Array.isArray(entry.bbls)) {
      for (const bbl of entry.bbls) {
        const n = normalizeBbl(bbl);
        if (n) rows.push({ project_id: projectId, bbl: n, source_system: "zap-bbl" });
      }
    } else if (entry.bbl) {
      const n = normalizeBbl(entry.bbl);
      if (n) rows.push({ project_id: projectId, bbl: n, source_system: "zap-bbl" });
    }
  }
  return rows;
}

function mergePropertyLocation(a, b) {
  const left = a && typeof a === "object" ? a : {};
  const right = b && typeof b === "object" ? b : {};
  const bbls = new Set();
  for (const src of [left, right]) {
    for (const raw of src.bbls || []) {
      const n = normalizeBbl(raw);
      if (n) bbls.add(n);
    }
  }
  // Prefer the location that already carries BBLs / geometry; union BBL lists.
  const base =
    (right.bbls || []).length >= (left.bbls || []).length ? { ...left, ...right } : { ...right, ...left };
  if (bbls.size) base.bbls = [...bbls].sort();
  return base;
}

function dedupePropertyRows(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    const id = String(row?.request_id || "").trim();
    if (!id) continue;
    // Prefer richer rows when merging fixture + live:
    // union BBLs, keep labeled-owner body language, prefer non-empty stage.
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, row);
      continue;
    }
    const prevOwner = extractDispositionOwner(prev);
    const nextOwner = extractDispositionOwner(row);
    const preferNextBody = Boolean(nextOwner) && !prevOwner;
    const preferPrevBody = Boolean(prevOwner) && !nextOwner;
    const merged = {
      ...prev,
      ...row,
      // Keep the description that yields a labeled owner when only one does.
      additional_description_1: preferNextBody
        ? row.additional_description_1
        : preferPrevBody
          ? prev.additional_description_1
          : row.additional_description_1 || prev.additional_description_1,
      short_title: preferPrevBody
        ? prev.short_title || row.short_title
        : row.short_title || prev.short_title,
      agency_name: row.agency_name || prev.agency_name,
      disposition_stage: row.disposition_stage || prev.disposition_stage,
      property_location: mergePropertyLocation(prev.property_location, row.property_location),
    };
    byId.set(id, merged);
  }
  return [...byId.values()];
}

function collectCorpus(root, propertyObsDoc) {
  const fixture = loadJsonIfExists(FIXTURE) || {};
  const propertyRows = [...(fixture.property_rows || [])];
  const zapBblRows = [...(fixture.zap_bbl_rows || [])];
  const zapProjects = [...(fixture.zap_projects || [])];
  const moneyRows = [...(fixture.money_rows || [])];

  // Live / committed property materialization (main densify source)
  if (propertyObsDoc?.property_rows?.length) {
    for (const row of propertyObsDoc.property_rows) {
      propertyRows.push({
        ...row,
        section_name: row.section_name || "Property Disposition",
        domain: "property",
        source_system: row.source_system || "city_record",
      });
    }
  }

  for (const p of [
    join(root, "warehouse/fixtures/zap-bbl/sample.csv"),
    join(root, "warehouse/fixtures/zap-bbl/product_seed.csv"),
  ]) {
    for (const row of loadCsvIfExists(p)) {
      if (row.project_id && row.bbl) zapBblRows.push({ ...row, source_system: "zap-bbl" });
    }
  }

  // Committed WH-06 lookup (fixture-scale until Mini bulk) — exact BBL only
  const bblLookup = loadJsonIfExists(join(root, "site/data/zap_bbl_warehouse_lookup.json"));
  for (const row of flattenZapBblLookup(bblLookup)) zapBblRows.push(row);

  const multi = loadJsonIfExists(
    join(root, "test/fixtures/property_disposition/multi_notice_bbl.json"),
  );
  if (multi?.notices) {
    for (const n of multi.notices) {
      propertyRows.push({ ...n, section_name: n.section_name || "Property Disposition" });
    }
  }

  for (const p of [
    join(root, "warehouse/fixtures/ocp-recent-contract-awards/product_seed.csv"),
    join(root, "warehouse/fixtures/ocp-recent-contract-awards/sample.csv"),
  ]) {
    for (const row of loadCsvIfExists(p)) moneyRows.push(row);
  }
  const ocpLookup = loadJsonIfExists(join(root, "site/data/ocp_awards_warehouse_lookup.json"));
  if (ocpLookup?.rows) {
    for (const row of ocpLookup.rows.slice(0, 200)) moneyRows.push(row);
  }

  for (const p of [
    join(root, "warehouse/fixtures/zap-projects/product_seed.csv"),
    join(root, "warehouse/fixtures/zap-projects/sample.csv"),
  ]) {
    for (const row of loadCsvIfExists(p)) zapProjects.push(row);
  }
  const zapLookup = loadJsonIfExists(join(root, "site/data/zap_projects_warehouse_lookup.json"));
  if (zapLookup?.rows) {
    for (const row of zapLookup.rows.slice(0, 300)) zapProjects.push(row);
  }

  return {
    propertyRows: dedupePropertyRows(propertyRows),
    zapBblRows,
    zapProjects,
    moneyRows,
    property_source: propertyObsDoc
      ? {
          path: "site/data/property_domain_observations.json",
          bbl_count: propertyObsDoc.bbl_count,
          property_count: propertyObsDoc.property_count,
          source_generated_at: propertyObsDoc.source_generated_at,
        }
      : null,
  };
}

/** Pick demo BBLs: known field cases when present + live lots beyond the hand-picked pair. */
function pickDemoBbls(corpus, byBbl) {
  const preferred = ["1006440001", "3025180036", "3044440001", "5006840261"];
  const demos = [];
  for (const bbl of preferred) {
    if (byBbl?.[bbl]?.property_notices?.length) demos.push(bbl);
  }
  for (const bbl of Object.keys(byBbl || {}).sort()) {
    if (demos.includes(bbl)) continue;
    const bucket = byBbl[bbl];
    if (!bucket?.property_notices?.length) continue;
    demos.push(bbl);
    if (demos.length >= 7) break;
  }
  return demos;
}

async function main() {
  const check = process.argv.includes("--check");
  const fromLive = process.argv.includes("--from-live");
  const localFeed = process.env.PROPERTY_LOCATIONS_PATH || null;

  let propertyObsDoc = loadJsonIfExists(PROPERTY_OBS_PATH);

  // Refresh the committed property domain snapshot only on explicit --from-live.
  // PROPERTY_LOCATIONS_PATH (optional) points at a local feed JSON instead of the API.
  // --check never rewrites inputs — it rebuilds from the committed snapshot only.
  if (fromLive && !check) {
    let feed;
    if (localFeed) {
      if (!existsSync(localFeed)) {
        console.error("PROPERTY_LOCATIONS_PATH missing:", localFeed);
        process.exit(1);
      }
      feed = JSON.parse(readFileSync(localFeed, "utf8"));
    } else {
      console.log("fetching live property feed", DEFAULT_LIVE_URL);
      feed = await fetchLivePropertyFeed();
    }
    propertyObsDoc = propertyDomainObservationsFromFeed(feed, {
      source: localFeed || DEFAULT_LIVE_URL,
    });
    mkdirSync(dirname(PROPERTY_OBS_PATH), { recursive: true });
    writeFileSync(PROPERTY_OBS_PATH, `${JSON.stringify(propertyObsDoc, null, 2)}\n`);
    console.log(
      "wrote property domain observations",
      PROPERTY_OBS_PATH,
      "rows",
      propertyObsDoc.property_count,
      "bbls",
      propertyObsDoc.bbl_count,
    );
  }

  if (!propertyObsDoc?.property_rows?.length) {
    console.warn(
      "warning: no site/data/property_domain_observations.json — densify limited to fixtures. Re-run with --from-live.",
    );
  }

  const corpus = collectCorpus(ROOT, propertyObsDoc);
  const doc = buildPropertyCrossDomainDoc(corpus);

  // Provenance: stamp property source + honest ZAP sparsity note
  if (corpus.property_source) {
    doc.provenance = {
      ...doc.provenance,
      property_feed: corpus.property_source,
    };
  }

  const demoBbls = pickDemoBbls(corpus, doc.by_bbl);
  const demos = {};
  for (const bbl of demoBbls) {
    demos[bbl] = buildParcelIntelligence(bbl, corpus);
  }
  const out = {
    ...doc,
    demos,
    demo_bbls: demoBbls,
  };

  if (check) {
    if (!existsSync(OUT_SITE)) {
      console.error("missing", OUT_SITE);
      process.exit(1);
    }
    const existing = JSON.parse(readFileSync(OUT_SITE, "utf8"));
    const pick = (d) => ({
      version: d.version,
      metrics: d.metrics,
      coverage: d.coverage,
      demo_bbls: d.demo_bbls,
      by_bbl_count: Object.keys(d.by_bbl || {}).length,
    });
    const a = JSON.stringify(pick(existing));
    const b = JSON.stringify(pick(out));
    if (a !== b) {
      console.error("property_cross_domain_lookup.json drift — re-run without --check");
      process.exit(1);
    }
    console.log("property cross-domain lookup OK", {
      by_bbl: Object.keys(out.by_bbl || {}).length,
      metrics: out.metrics,
      coverage: out.coverage,
    });
    return;
  }

  mkdirSync(dirname(OUT_SITE), { recursive: true });
  mkdirSync(dirname(OUT_WORKER), { recursive: true });
  const text = `${JSON.stringify(out, null, 2)}\n`;
  writeFileSync(OUT_SITE, text);
  writeFileSync(OUT_WORKER, text);
  console.log(
    "wrote property cross-domain lookup",
    OUT_SITE,
    "bbls",
    Object.keys(out.by_bbl || {}).length,
    "coverage",
    out.coverage,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
