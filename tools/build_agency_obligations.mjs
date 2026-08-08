#!/usr/bin/env node
/**
 * Materialize agency-scoped statutory obligations from the independent
 * enacted-law mandate backfill (cityscroll-mandates-backfill-v1).
 *
 * Input is local/gitignored tools/law_mandates/output/our.json (or --input).
 * Does not read private oracle comparison corpora. Public artifact only.
 *
 *   node tools/build_agency_obligations.mjs
 *   node tools/build_agency_obligations.mjs --input path/to/our.json
 *   node tools/build_agency_obligations.mjs --fixture
 *   node tools/build_agency_obligations.mjs --check
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENCY_OBLIGATIONS_CERTIFICATION,
  AGENCY_OBLIGATIONS_METHOD,
  AGENCY_OBLIGATIONS_SCHEMA,
  buildAgencyObligationsLookup,
} from "../site/agency_obligations.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const OUT = join(SITE, "data/agency_obligations_lookup.json");
const DEFAULT_INPUT = join(ROOT, "tools/law_mandates/output/our.json");
const FIXTURE = join(ROOT, "test/fixtures/agency_obligations/our_sample.json");

function parseArgs(argv) {
  const args = { check: false, fixture: false, input: null };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--check") args.check = true;
    else if (key === "--fixture") args.fixture = true;
    else if (key === "--input") {
      args.input = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${key}`);
    }
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadFixturePayload() {
  if (existsSync(FIXTURE)) return readJson(FIXTURE);
  // Minimal self-contained sample when fixture not yet written (bootstrap).
  return {
    schema_version: "cityscroll-mandates-backfill-v1",
    generated_at: "2026-08-07T23:52:53.226Z",
    model: "fixture",
    prompt_version: "cityscroll-mandates-prompt-v1",
    laws: [{
      matter_id: "48909",
      source: { url: "https://example.test/law.pdf", fetched_at: "2026-08-07T00:00:00.000Z", sha256: "abc" },
      file_number: "Int 0859-2012",
      mandates: [],
    }],
    mandates: [{
      mandate_id: "48909-001",
      matter_id: "48909",
      agency: "Department of Parks and Recreation",
      duty_text: "Submit quarterly major-felony crime reports for large parks.",
      deliverable_type: "report",
      deadline: { kind: "none", fixed_date: null, offset_days: null, text: "Beginning January 1, 2015", computed_date: null },
      recurrence: "quarterly",
      citation: "Administrative Code § 14-150(a)(4)",
      verbatim_quote: "Such report shall also include the total number of major felony crime complaints",
      quote_verified: true,
      status: "verified",
      file_number: "Int 0859-2012",
    }, {
      mandate_id: "8122647-001",
      matter_id: "8122647",
      agency: "HPD",
      duty_text: "Begin the rental assistance voucher application process.",
      deliverable_type: "program",
      deadline: { kind: "days_after_enactment", fixed_date: null, offset_days: 240, text: "no later than 240 days after enactment", computed_date: "2027-03-27" },
      recurrence: "one-time",
      citation: "NYC Admin. Code § 26-3902",
      verbatim_quote: "eligibility determinations shall begin no later than 240 days",
      quote_verified: true,
      status: "verified",
      file_number: "Int 0966-2026",
    }],
    receipt: { law_count: 2, mandate_count: 2 },
  };
}

function loadPayload(args) {
  if (args.fixture) return loadFixturePayload();
  const input = resolve(args.input || process.env.CROL_MANDATES_OUR_JSON || DEFAULT_INPUT);
  if (!existsSync(input)) {
    throw new Error(
      `Missing mandate backfill payload at ${input}. Pass --input, set CROL_MANDATES_OUR_JSON, or use --fixture.`,
    );
  }
  return readJson(input);
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function materializeAgencyObligations(payload) {
  return buildAgencyObligationsLookup(payload);
}

function writeLookup(lookup) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, stableStringify(lookup), "utf8");
}

function checkLookup(lookup) {
  if (!existsSync(OUT)) {
    throw new Error("Missing site/data/agency_obligations_lookup.json; rebuild first");
  }
  const existing = readJson(OUT);
  // Allow generated_at / as_of drift only when summary counts match (check is structural).
  const keys = ["schema", "method", "certification_basis", "er_match_basis", "iteration", "summary", "by_agency"];
  for (const key of keys) {
    if (key === "by_agency") {
      const leftIds = Object.keys(existing.by_agency || {}).sort();
      const rightIds = Object.keys(lookup.by_agency || {}).sort();
      if (JSON.stringify(leftIds) !== JSON.stringify(rightIds)) {
        throw new Error("agency_obligations by_agency keys drift");
      }
      for (const id of leftIds) {
        if ((existing.by_agency[id]?.count || 0) !== (lookup.by_agency[id]?.count || 0)) {
          throw new Error(`agency_obligations count drift for ${id}`);
        }
      }
      continue;
    }
    if (JSON.stringify(existing[key]) !== JSON.stringify(lookup[key])) {
      throw new Error(`agency_obligations field drift: ${key}`);
    }
  }
  if (existing.schema !== AGENCY_OBLIGATIONS_SCHEMA) {
    throw new Error("schema mismatch");
  }
  if (existing.method !== AGENCY_OBLIGATIONS_METHOD) {
    throw new Error("method mismatch");
  }
  if (existing.certification_basis !== AGENCY_OBLIGATIONS_CERTIFICATION) {
    throw new Error("certification basis mismatch");
  }
  return true;
}

function main() {
  const args = parseArgs(process.argv);
  const payload = loadPayload(args);
  const lookup = materializeAgencyObligations(payload);

  if (args.check) {
    checkLookup(lookup);
    console.log(`ok agency_obligations agencies=${lookup.summary.agency_count} obligations=${lookup.summary.obligation_count}`);
    return;
  }

  writeLookup(lookup);
  // Keep a tiny fixture for offline tests when building from the full corpus.
  if (!args.fixture && existsSync(DEFAULT_INPUT)) {
    const parks = lookup.by_agency["parks-and-recreation"]?.obligations?.slice(0, 3) || [];
    const hpd = lookup.by_agency["housing-preservation-and-development"]?.obligations?.slice(0, 2) || [];
    const sampleMandates = [...parks, ...hpd].map((row) => ({
      mandate_id: row.obligation_id,
      matter_id: row.matter_id,
      agency: row.agency_raw || row.agency_name,
      duty_text: row.duty_text,
      deliverable_type: row.deliverable_type,
      deadline: row.deadline,
      recurrence: row.recurrence,
      citation: row.citation,
      quote_verified: row.certification?.quote_verified === true,
      status: row.certification?.quote_verified ? "verified" : "candidate",
      file_number: row.file_number,
    }));
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, stableStringify({
      schema_version: payload.schema_version || "cityscroll-mandates-backfill-v1",
      generated_at: payload.generated_at || lookup.generated_at,
      model: "fixture-slice",
      prompt_version: payload.prompt_version || null,
      laws: [],
      mandates: sampleMandates,
      receipt: { law_count: 0, mandate_count: sampleMandates.length },
    }), "utf8");
  }

  console.log(
    `wrote ${OUT} agencies=${lookup.summary.agency_count} matched=${lookup.summary.matched_obligation_count}/${lookup.summary.obligation_count} parks=${lookup.by_agency["parks-and-recreation"]?.count || 0}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("build_agency_obligations.mjs")) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}
