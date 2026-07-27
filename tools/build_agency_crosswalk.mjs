// Build the agency-identity crosswalk bundled with the Worker.
//
// City Record notices carry a free-text agency string in two naming conventions — legacy
// UPPERCASE ("DEPT OF PARKS & RECREATION") and modern mixed-case ("Parks and Recreation").
// This script resolves those strings, ONCE at preprocess time, to a canonical identity card
// sourced entirely from the City's own open data, and emits a compact static lookup the Worker
// joins against in-process at response time (never a live third-party call on the request path).
//
// Sources (all NYC / NY State Open Data):
//   t3jq-9nkf  NYC Agencies and Governance Organizations (Office of Technology & Innovation)
//              → canonical name, acronym, website (url), principal officer (head + title),
//                organization type, reports-to. The identity card.
//   mwzb-yiwb  Expense Budget (Mayor's Office of Management & Budget)
//              → budget code (agency_number) + latest adopted budget total. The budget line.
//   dg92-zbpx  The City Record Online (DCAS) — read only to enumerate the DISTINCT agency
//                strings that actually appear in notices, so the crosswalk covers real keys.
//
// Matching is deterministic: normalize both sides to a comparison key (expand the City
// Record's abbreviations, drop filler + the "New York City" prefix), match on canonical name /
// acronym / alternate names, with a small hand-verified ALIAS table for strings the normalizer
// cannot bridge on its own (e.g. "HRA/DEPT OF SOCIAL SERVICES"). The output records a
// match_method per key so the coverage is auditable, not asserted.
//
// Run:  node tools/build_agency_crosswalk.mjs           (writes the bundle + a match report)
//       node tools/build_agency_crosswalk.mjs --dry     (prints coverage, writes nothing)
//
// Refresh cadence: the source datasets update roughly quarterly (budget) / continuously but
// slowly (roster). Re-run this script to refresh; the bundle is a static snapshot stamped with
// each source's own last-updated date and the download date.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { normalizeAgencyKey, aliasTargetFor } from "../worker/src/lib/agency_identity.mjs";
import { canonicalAgency } from "../worker/src/lib/agencies.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_BUNDLE = join(HERE, "..", "worker", "src", "data", "agency_crosswalk.json");
const OUT_REPORT = join(HERE, "..", "worker", "src", "data", "agency_crosswalk.report.md");

const ROSTER_DATASET = "t3jq-9nkf";
const BUDGET_DATASET = "mwzb-yiwb";
const CITYRECORD_DATASET = "dg92-zbpx";
const SODA = "https://data.cityofnewyork.us/resource";
const VIEW = "https://data.cityofnewyork.us/api/views";

async function soda(dataset, params) {
  const url = `${SODA}/${dataset}.json?${new URLSearchParams(params)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`SODA ${dataset} ${r.status}: ${await r.text()}`);
  return r.json();
}

// A dataset's own "rows last updated" date — the honest snapshot date for provenance.
async function datasetUpdatedISO(dataset) {
  const r = await fetch(`${VIEW}/${dataset}.json`);
  if (!r.ok) return null;
  const meta = await r.json();
  return typeof meta.rowsUpdatedAt === "number"
    ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10)
    : null;
}

function cleanUrl(u) {
  // Socrata URL-type columns arrive as { url, description }, not a bare string.
  const raw = u && typeof u === "object" ? u.url : u;
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^www\./i.test(s) || /\.[a-z]{2,}(\/|$)/i.test(s)) return "https://" + s;
  return null;
}

async function main() {
  const dry = process.argv.includes("--dry");
  const downloadedISO = new Date().toISOString().slice(0, 10);

  // 1. Canonical roster (the identity cards).
  const roster = await soda(ROSTER_DATASET, { $limit: "2000" });
  const rosterUpdated = await datasetUpdatedISO(ROSTER_DATASET);

  // Build canonical key → record, indexing every name/acronym/alias each record answers to.
  const canonByKey = new Map();
  const canon = [];
  for (const row of roster) {
    if (String(row.operational_status || "").toLowerCase() === "inactive") continue;
    const head = row.principal_officer_full_name
      ? String(row.principal_officer_full_name).trim()
      : null;
    const rec = {
      canonical_name: String(row.name || "").trim(),
      acronym: row.acronym ? String(row.acronym).trim() : null,
      org_type: row.organization_type ? String(row.organization_type).trim() : null,
      url: cleanUrl(row.url),
      head_name: head,
      head_title: row.principal_officer_title ? String(row.principal_officer_title).trim() : null,
      reports_to: row.reports_to ? String(row.reports_to).trim() : null,
      record_id: row.record_id || null,
    };
    if (!rec.canonical_name) continue;
    canon.push(rec);
    const surfaces = [rec.canonical_name, rec.acronym];
    for (const alt of String(row.alternate_or_former_names || "").split(/;|,/)) surfaces.push(alt);
    for (const alt of String(row.alternate_or_former_acronyms || "").split(/;|,/)) surfaces.push(alt);
    for (const s of surfaces) {
      const k = normalizeAgencyKey(s);
      if (k && !canonByKey.has(k)) canonByKey.set(k, rec);
    }
  }

  // 2. Budget lines (budget code + adopted total per agency). The Expense Budget dataset restates
  // every line item at several publication snapshots per fiscal year, so the total must be pinned
  // to ONE (fiscal_year, publication_date) slice — the latest year's latest (adopted) publication —
  // or the sum multi-counts. See tools/build_agency_crosswalk.report.md.
  const budgetUpdated = await datasetUpdatedISO(BUDGET_DATASET);
  const [{ fy: latestFyStr } = {}] = await soda(BUDGET_DATASET, { $select: "max(fiscal_year) as fy", $limit: "1" });
  const latestFy = +latestFyStr || 0;
  const [{ pub: latestPub } = {}] = await soda(BUDGET_DATASET, {
    $select: "max(publication_date) as pub", $where: `fiscal_year=${latestFy}`, $limit: "1",
  });
  const budgetRows = await soda(BUDGET_DATASET, {
    $select: "agency_number, agency_name, sum(adopted_budget_amount) as adopted",
    $where: `fiscal_year=${latestFy} AND publication_date='${latestPub}'`,
    $group: "agency_number, agency_name",
    $limit: "2000",
  });
  const budgetByKey = new Map();
  for (const r of budgetRows) {
    const k = normalizeAgencyKey(r.agency_name);
    if (!k) continue;
    const prev = budgetByKey.get(k);
    const adopted = Math.round(+r.adopted || 0);
    // Same normalized agency can appear under sibling budget codes; keep the largest line.
    if (!prev || adopted > prev.adopted) {
      budgetByKey.set(k, { budget_code: String(r.agency_number || "").trim(), adopted, fy: latestFy });
    }
  }

  // 3. The real City Record agency strings (so coverage is measured against actual keys).
  const crRows = await soda(CITYRECORD_DATASET, {
    $select: "agency_name, count(*) as n",
    $group: "agency_name",
    $order: "n desc",
    $limit: "400",
  });
  const crUpdated = await datasetUpdatedISO(CITYRECORD_DATASET);

  // 4. Resolve each City Record string to the site's canonical agency (via the shared
  // canonicalAgency crosswalk), then attach the identity + budget keyed by canonical_id. Raw
  // spelling variants that share a canonical_id share one identity card; their notice volumes add.
  //
  // Match a canonical agency to the roster/budget by trying my build-time normalizer against a
  // list of candidate names (the canonical name first, then each raw variant) — never on the
  // request path, only here.
  function matchDatasets(candidates) {
    for (const cand of candidates) {
      const key = normalizeAgencyKey(cand);
      if (!key) continue;
      const aliasTarget = aliasTargetFor(key);
      const lookupKey = aliasTarget ? normalizeAgencyKey(aliasTarget) : key;
      const rec = canonByKey.get(lookupKey) || null;
      const budget = budgetByKey.get(lookupKey) || budgetByKey.get(key) || null;
      if (rec || budget) {
        let method = rec ? (aliasTarget ? "alias" : "normalized") : "budget-only";
        if (rec && budget && method !== "alias") method = "normalized+budget";
        return { rec, budget, method };
      }
    }
    return { rec: null, budget: null, method: null };
  }

  const entries = {};
  const variantsById = {}; // canonical_id → the raw City Record strings seen (for matching + report)
  const report = [];
  let volCovered = 0, volTotal = 0;
  const idVolume = {};
  for (const row of crRows) {
    const raw = String(row.agency_name || "").trim();
    if (!raw) continue;
    const n = +row.n || 0;
    volTotal += n;
    const { canonical_id, canonical_name } = canonicalAgency(raw);
    (variantsById[canonical_id] ||= []).push(raw);
    idVolume[canonical_id] = (idVolume[canonical_id] || 0) + n;
    report.push({ raw, canonical_id, canonical_name, n });
  }
  // Resolve one identity per canonical agency. The canonical_id (the join key) comes from the
  // site's shared crosswalk; the display name prefers the roster's official agency name (the
  // identity source, t3jq-9nkf), falling back to the site's canonical name for budget-only rows.
  for (const [canonical_id, variants] of Object.entries(variantsById)) {
    const { canonical_name: site_name } = canonicalAgency(variants[0]);
    const { rec, budget, method } = matchDatasets([site_name, ...variants]);
    if (!rec && !budget) continue; // no identity data → graceful no-match at request time
    entries[canonical_id] = {
      canonical_name: rec ? rec.canonical_name : site_name, // official roster name, else site name
      acronym: rec ? rec.acronym : null,
      org_type: rec ? rec.org_type : null,
      url: rec ? rec.url : null,
      head_name: rec ? rec.head_name : null,
      head_title: rec ? rec.head_title : null,
      reports_to: rec ? rec.reports_to : null,
      budget_code: budget ? budget.budget_code : null,
      budget_adopted: budget ? budget.adopted : null,
      budget_fy: budget ? budget.fy : null,
      match_method: method,
    };
    volCovered += idVolume[canonical_id] || 0;
  }
  // Annotate the per-row report with whether its canonical agency resolved.
  for (const r of report) r.method = entries[r.canonical_id] ? entries[r.canonical_id].match_method : "unmatched";

  const bundle = {
    _provenance: {
      description:
        "Agency-identity crosswalk: City Record agency strings → canonical identity + budget, " +
        "joined from NYC/NYS Open Data. Static snapshot; regenerate with tools/build_agency_crosswalk.mjs.",
      downloaded: downloadedISO,
      sources: [
        {
          id: ROSTER_DATASET,
          name: "NYC Agencies and Governance Organizations",
          attribution: "Office of Technology and Innovation (OTI)",
          url: `https://data.cityofnewyork.us/d/${ROSTER_DATASET}`,
          rows: roster.length,
          updated: rosterUpdated,
          provides: ["canonical_name", "acronym", "org_type", "url", "head_name", "head_title", "reports_to"],
        },
        {
          id: BUDGET_DATASET,
          name: "Expense Budget",
          attribution: "Mayor's Office of Management & Budget (OMB)",
          url: `https://data.cityofnewyork.us/d/${BUDGET_DATASET}`,
          rows: budgetRows.length,
          updated: budgetUpdated,
          fiscal_year: latestFy,
          provides: ["budget_code", "budget_adopted"],
        },
        {
          id: CITYRECORD_DATASET,
          name: "The City Record Online",
          attribution: "Department of Citywide Administrative Services (DCAS)",
          url: `https://data.cityofnewyork.us/d/${CITYRECORD_DATASET}`,
          updated: crUpdated,
          role: "enumerated the distinct agency strings that appear in notices",
        },
      ],
      canonical_agencies: Object.keys(entries).length,
      city_record_strings_scanned: crRows.length,
      volume_coverage: volTotal ? +(volCovered / volTotal).toFixed(4) : 0,
    },
    entries,
  };

  const covPct = (bundle._provenance.volume_coverage * 100).toFixed(1);
  console.log(
    `Enriched ${Object.keys(entries).length} canonical agencies (of ${crRows.length} distinct ` +
    `City Record strings) → ${covPct}% of notice volume covered.`
  );
  const unmatched = report.filter((r) => r.method === "unmatched").sort((a, b) => b.n - a.n);
  console.log(`Top unmatched by volume:`);
  for (const u of unmatched.slice(0, 15)) console.log(`  ${String(u.n).padStart(7)}  ${u.raw}  [${u.canonical_id}]`);

  if (dry) { console.log("\n--dry: nothing written."); return; }

  writeFileSync(OUT_BUNDLE, JSON.stringify(bundle, null, 2) + "\n");
  const reportMd =
    `# Agency-identity crosswalk — build report\n\n` +
    `Generated by \`tools/build_agency_crosswalk.mjs\`. Do not edit by hand.\n\n` +
    `Enrichment layer on top of the site's agency-name crosswalk (\`worker/src/lib/agencies.mjs\`):\n` +
    `each City Record agency string is resolved to its canonical id by \`canonicalAgency()\`, then\n` +
    `keyed to a NYC/NYS Open Data identity + budget line. Keyed by \`canonical_id\`.\n\n` +
    `- Downloaded: ${downloadedISO}\n` +
    `- Roster (${ROSTER_DATASET}) rows: ${roster.length}, updated ${rosterUpdated}\n` +
    `- Budget (${BUDGET_DATASET}) rows: ${budgetRows.length}, FY${latestFy}, updated ${budgetUpdated}\n` +
    `- City Record strings scanned: ${crRows.length}\n` +
    `- Canonical agencies enriched: ${Object.keys(entries).length}\n` +
    `- Notice-volume coverage: ${covPct}%\n\n` +
    `## Resolved (top 60 by notice volume)\n\n` +
    `| notices | City Record string | method | canonical | head | budget code |\n` +
    `|--:|---|---|---|---|---|\n` +
    report.filter((r) => r.method !== "unmatched").slice(0, 60).map((r) => {
      const c = entries[r.canonical_id];
      return `| ${r.n} | ${r.raw} | ${r.method} | ${c.canonical_name} | ${c.head_name || "—"} | ${c.budget_code || "—"} |`;
    }).join("\n") +
    `\n\n## Unmatched (top 40 by notice volume)\n\n` +
    `These degrade gracefully — the profile shows the City Record string with no identity card.\n\n` +
    `| notices | City Record string | canonical id |\n|--:|---|---|\n` +
    unmatched.slice(0, 40).map((r) => `| ${r.n} | ${r.raw} | ${r.canonical_id} |`).join("\n") +
    `\n`;
  writeFileSync(OUT_REPORT, reportMd);
  console.log(`\nWrote ${OUT_BUNDLE}\nWrote ${OUT_REPORT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
