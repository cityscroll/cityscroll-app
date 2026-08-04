#!/usr/bin/env node
/**
 * Build award → registration dwell for Human Services City Record awards.
 *
 * Data sources (first hit wins for awards):
 *   1) --awards path (JSON array of City Record rows)
 *   2) warehouse/fixtures/award-registration-dwell/city_record_hs_awards.json
 *   3) warehouse DuckDB/parquet city_record when registered (optional)
 *   4) --fetch-awards live SODA Human Services awards (paginated)
 *
 * Registration side-car (first hit wins):
 *   1) --registrations path (JSON array of PASSPort/Checkbook-shaped rows)
 *   2) warehouse/fixtures/award-registration-dwell/passport_registrations.json
 *   3) --fetch-passport live PASSPort Public contractData.js
 *
 * Usage:
 *   node tools/build_award_registration_dwell.mjs --fixture
 *   node tools/build_award_registration_dwell.mjs --fetch-awards --fetch-passport
 *   node tools/build_award_registration_dwell.mjs --check
 *
 * Writes:
 *   site/data/award_registration_dwell.json          (summary + stats; slim)
 *   site/data/award_registration_dwell_observations.json  (per-award rows)
 *   docs/evidence/award-registration-dwell/summary.json
 *   warehouse/receipts/proof/award_registration_dwell_latest.json
 *   site/data/award_sources/verification_receipts/award_registration_dwell_latest.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  buildRegistrationIndex,
  buildAwardRegistrationDwellReport,
  publicSummary,
  HUMAN_SERVICES_CATEGORY,
  AWARD_TYPE,
} from "../worker/src/lib/award_registration_dwell.mjs";
import { parseContractsDump } from "../worker/src/lib/passport_parse.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX_AWARDS = join(
  ROOT,
  "warehouse/fixtures/award-registration-dwell/city_record_hs_awards.json",
);
const FIX_REG = join(
  ROOT,
  "warehouse/fixtures/award-registration-dwell/passport_registrations.json",
);
const OUT_SUMMARY = join(ROOT, "site/data/award_registration_dwell.json");
const OUT_OBS = join(ROOT, "site/data/award_registration_dwell_observations.json");
const OUT_EVIDENCE = join(
  ROOT,
  "docs/evidence/award-registration-dwell/summary.json",
);
const OUT_RECEIPT = join(
  ROOT,
  "warehouse/receipts/proof/award_registration_dwell_latest.json",
);
const OUT_SRC_RECEIPT = join(
  ROOT,
  "site/data/award_sources/verification_receipts/award_registration_dwell_latest.json",
);

const SODA_BASE = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const PASSPORT_CTR_URL =
  "https://a0333-passportpublic.nyc.gov/dataJs/contractData.js";

function parseArgs(argv) {
  const args = {
    awards: null,
    registrations: null,
    fixture: false,
    fetchAwards: false,
    fetchPassport: false,
    check: false,
    help: false,
    limit: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--fixture") args.fixture = true;
    else if (a === "--fetch-awards") args.fetchAwards = true;
    else if (a === "--fetch-passport") args.fetchPassport = true;
    else if (a === "--check") args.check = true;
    else if (a === "--awards") {
      if (!argv[i + 1]) throw new Error("--awards requires a path");
      args.awards = argv[++i];
    } else if (a === "--registrations") {
      if (!argv[i + 1]) throw new Error("--registrations requires a path");
      args.registrations = argv[++i];
    } else if (a === "--limit") {
      if (!argv[i + 1]) throw new Error("--limit requires a number");
      args.limit = Number(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableStringify(value));
}

function loadJsonArray(path) {
  if (!existsSync(path)) {
    throw new Error(`missing file: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${path} must be a JSON array`);
  return raw;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "CityScrollBuild/1.0 (award-registration-dwell)",
    },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} → HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "*/*",
      "User-Agent":
        "Mozilla/5.0 (compatible; CityScrollBuild/1.0; +https://cityscroll.org)",
    },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} → HTTP ${res.status}`);
  }
  return res.text();
}

/**
 * Paginate SODA for Human Services Award rows.
 * City Record Online dg92-zbpx; order for stable paging.
 */
async function fetchHumanServicesAwards({ limit = null } = {}) {
  const pageSize = 1000;
  const rows = [];
  let offset = 0;
  const where =
    "section_name='Procurement'"
    + ` AND type_of_notice_description='${AWARD_TYPE}'`
    + ` AND category_description='${HUMAN_SERVICES_CATEGORY}'`;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const take = limit != null
      ? Math.min(pageSize, Math.max(0, limit - rows.length))
      : pageSize;
    if (take === 0) break;
    const url = new URL(SODA_BASE);
    url.searchParams.set(
      "$select",
      [
        "request_id",
        "start_date",
        "agency_name",
        "type_of_notice_description",
        "category_description",
        "pin",
        "vendor_name",
        "contract_amount",
        "short_title",
        "section_name",
      ].join(","),
    );
    url.searchParams.set("$where", where);
    url.searchParams.set("$order", "start_date DESC, request_id DESC");
    url.searchParams.set("$limit", String(take));
    url.searchParams.set("$offset", String(offset));
    const page = await fetchJson(url.toString());
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    offset += page.length;
    if (page.length < take) break;
    if (limit != null && rows.length >= limit) break;
    // polite pause between pages
    await new Promise((r) => setTimeout(r, 200));
  }
  return rows;
}

async function fetchPassportContracts() {
  const text = await fetchText(PASSPORT_CTR_URL);
  return parseContractsDump(text);
}

/** Optional: read awards from warehouse DuckDB when registered. */
function tryLoadWarehouseAwards() {
  const dbPath = join(ROOT, "warehouse/duckdb/cityscroll.duckdb");
  if (!existsSync(dbPath)) return null;
  const sql = `
    SELECT request_id, start_date, agency_name, type_of_notice_description,
           category_description, pin, vendor_name, contract_amount, short_title,
           section_name
    FROM city_record
    WHERE type_of_notice_description = 'Award'
      AND category_description = 'Human Services/Client Services'
  `;
  const py = `
import json, sys
try:
    import duckdb
except ImportError:
    sys.exit(2)
con = duckdb.connect(${JSON.stringify(dbPath)}, read_only=True)
try:
    rows = con.execute(${JSON.stringify(sql)}).fetchdf()
except Exception as e:
    sys.stderr.write(str(e) + "\\n")
    sys.exit(3)
print(rows.to_json(orient="records", date_format="iso"))
`;
  const res = spawnSync("python3", ["-c", py], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) return null;
  try {
    const rows = JSON.parse(res.stdout);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

async function loadAwards(args) {
  if (args.awards) {
    return {
      rows: loadJsonArray(args.awards),
      path: args.awards,
      mode: "file",
    };
  }
  if (args.fixture && !args.fetchAwards) {
    return { rows: loadJsonArray(FIX_AWARDS), path: FIX_AWARDS, mode: "fixture" };
  }
  if (args.fetchAwards) {
    const rows = await fetchHumanServicesAwards({ limit: args.limit });
    return {
      rows,
      path: SODA_BASE,
      mode: "soda_live",
      row_count: rows.length,
    };
  }
  const warehouse = tryLoadWarehouseAwards();
  if (warehouse?.length) {
    return {
      rows: warehouse,
      path: "warehouse/duckdb/cityscroll.duckdb#city_record",
      mode: "warehouse",
      row_count: warehouse.length,
    };
  }
  // Default: fixture so --check and local builds stay offline-safe.
  return { rows: loadJsonArray(FIX_AWARDS), path: FIX_AWARDS, mode: "fixture" };
}

async function loadRegistrations(args) {
  if (args.registrations) {
    return {
      rows: loadJsonArray(args.registrations),
      path: args.registrations,
      mode: "file",
    };
  }
  if (args.fixture && !args.fetchPassport) {
    return { rows: loadJsonArray(FIX_REG), path: FIX_REG, mode: "fixture" };
  }
  if (args.fetchPassport) {
    const rows = await fetchPassportContracts();
    return {
      rows,
      path: PASSPORT_CTR_URL,
      mode: "passport_live",
      row_count: rows.length,
    };
  }
  return { rows: loadJsonArray(FIX_REG), path: FIX_REG, mode: "fixture" };
}

function buildReceipt(report, awardMeta, regMeta) {
  const s = report.stats || {};
  return {
    schema_version: 1,
    model_name: report.model_name,
    model_version: report.model_version,
    observed_at: report.generated_at,
    category: report.category,
    awards: {
      mode: awardMeta.mode,
      path: awardMeta.path,
      n: s.n_awards,
    },
    registrations: {
      mode: regMeta.mode,
      path: regMeta.path,
      n_input: regMeta.row_count ?? regMeta.rows?.length ?? null,
    },
    stats: {
      n_awards: s.n_awards,
      n_found: s.n_found,
      n_unknown: s.n_unknown,
      join_rate: s.join_rate,
      unknown_rate: s.unknown_rate,
      dwell_days_non_negative: s.dwell_days_non_negative,
      dwell_days_registration_prior: s.dwell_days_registration_prior,
      honesty_violations: s.honesty_violations,
      by_join_method: s.by_join_method,
      by_registration_source: s.by_registration_source,
    },
    honesty: report.honesty,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node tools/build_award_registration_dwell.mjs [--fixture]
  node tools/build_award_registration_dwell.mjs --fetch-awards --fetch-passport
  node tools/build_award_registration_dwell.mjs --awards path.json --registrations path.json
  node tools/build_award_registration_dwell.mjs --check`);
    process.exit(0);
  }

  const awardMeta = await loadAwards(args);
  const regMeta = await loadRegistrations(args);
  const regIndex = buildRegistrationIndex(regMeta.rows);

  const report = buildAwardRegistrationDwellReport(awardMeta.rows, regIndex, {
    generatedAt: new Date().toISOString(),
    corpus: {
      awards_mode: awardMeta.mode,
      awards_path: awardMeta.path,
      awards_n_input: awardMeta.rows.length,
      registrations_mode: regMeta.mode,
      registrations_path: regMeta.path,
      registrations_n_input: regMeta.rows.length,
      city_record_dataset: "dg92-zbpx",
      registration_join: "passport_epin_via_pin",
    },
  });

  const summary = publicSummary(report);
  // Materialize every award: found rows carry dwell evidence; unknown rows are
  // listed with award anchors only (dwell_days omitted — never 0 for unknown).
  const found = [];
  const unknown = [];
  for (const o of report.observations) {
    if (o.registration_status === "found") {
      found.push({
        request_id: o.request_id,
        pin: o.pin,
        agency_name: o.agency_name,
        award_date: o.award_date,
        registration_date: o.registration_date,
        dwell_days: o.dwell_days,
        registration_source: o.registration_source,
        join_method: o.join_method,
        registration_epin: o.registration_epin,
        registration_contract_id: o.registration_contract_id,
      });
    } else {
      unknown.push({
        request_id: o.request_id,
        pin: o.pin,
        agency_name: o.agency_name,
        award_date: o.award_date,
        registration_status: "unknown",
        dwell_days: null,
      });
    }
  }
  const observationsDoc = {
    schema_version: 1,
    model_name: report.model_name,
    model_version: report.model_version,
    generated_at: report.generated_at,
    n: report.observations.length,
    n_found: found.length,
    n_unknown: unknown.length,
    honesty: {
      unknown_never_zero: true,
      note: "unknown.dwell_days is always null; found.dwell_days may be 0 for same-day registration",
    },
    found,
    unknown,
  };
  const receipt = buildReceipt(report, awardMeta, regMeta);

  if (args.check) {
    // Live corpus is not committed (warehouse bulk / SODA). --check validates the
    // committed summary + observations honesty contract, and that the pure rebuild
    // from fixtures stays clean. It does not require live SODA/PASSPort.
    if (!existsSync(OUT_SUMMARY)) {
      console.error("award_registration_dwell.json missing — run build without --check");
      process.exit(1);
    }
    const existing = JSON.parse(readFileSync(OUT_SUMMARY, "utf8"));
    if (existing.model_name !== "award_registration_dwell") {
      console.error("unexpected model_name on committed summary");
      process.exit(1);
    }
    if (existing.stats?.honesty_violations !== 0) {
      console.error("committed honesty_violations must be 0");
      process.exit(1);
    }
    if (!(existing.stats?.n_awards > 0)) {
      console.error("committed n_awards must be > 0");
      process.exit(1);
    }
    if (existing.honesty?.unknown_never_zero !== true) {
      console.error("committed honesty.unknown_never_zero must be true");
      process.exit(1);
    }
    if (existsSync(OUT_OBS)) {
      const obs = JSON.parse(readFileSync(OUT_OBS, "utf8"));
      const badFound = (obs.found || []).filter(
        (r) => r.dwell_days == null || !Number.isFinite(r.dwell_days),
      );
      const badUnknown = (obs.unknown || []).filter((r) => r.dwell_days != null);
      if (badFound.length || badUnknown.length) {
        console.error(
          `observations honesty fail: bad_found=${badFound.length} bad_unknown=${badUnknown.length}`,
        );
        process.exit(1);
      }
      if (obs.n_found + obs.n_unknown !== obs.n) {
        console.error("observations n_found + n_unknown must equal n");
        process.exit(1);
      }
    }
    // Fixture pure-path smoke (offline).
    const fixAwards = loadJsonArray(FIX_AWARDS);
    const fixReg = buildRegistrationIndex(loadJsonArray(FIX_REG));
    const fixReport = buildAwardRegistrationDwellReport(fixAwards, fixReg, {
      generatedAt: "1970-01-01T00:00:00.000Z",
      corpus: { mode: "fixture" },
    });
    if (fixReport.stats.honesty_violations !== 0) {
      console.error("fixture rebuild honesty_violations must be 0");
      process.exit(1);
    }
    if (fixReport.stats.n_awards < 1) {
      console.error("fixture rebuild produced no awards");
      process.exit(1);
    }
    console.log(
      "ok award_registration_dwell",
      JSON.stringify({
        committed_n_awards: existing.stats.n_awards,
        committed_n_found: existing.stats.n_found,
        committed_n_unknown: existing.stats.n_unknown,
        committed_join_rate: existing.stats.join_rate,
        committed_p50_non_neg: existing.stats.dwell_days_non_negative?.p50,
        fixture_n_awards: fixReport.stats.n_awards,
        fixture_n_found: fixReport.stats.n_found,
      }),
    );
    process.exit(0);
  }

  writeJson(OUT_SUMMARY, summary);
  writeJson(OUT_OBS, observationsDoc);
  writeJson(OUT_EVIDENCE, summary);
  writeJson(OUT_RECEIPT, receipt);
  writeJson(OUT_SRC_RECEIPT, receipt);

  console.log(
    JSON.stringify(
      {
        awards_mode: awardMeta.mode,
        registrations_mode: regMeta.mode,
        n_awards: report.stats.n_awards,
        n_found: report.stats.n_found,
        n_unknown: report.stats.n_unknown,
        join_rate: report.stats.join_rate,
        dwell_days_non_negative: report.stats.dwell_days_non_negative,
        dwell_days_registration_prior: report.stats.dwell_days_registration_prior,
        honesty_violations: report.stats.honesty_violations,
        out: [OUT_SUMMARY, OUT_OBS, OUT_EVIDENCE, OUT_RECEIPT],
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
