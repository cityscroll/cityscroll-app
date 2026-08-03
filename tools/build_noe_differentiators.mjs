#!/usr/bin/env node
/**
 * Build-time NOE differentiator densify.
 *
 * Interface choice (best available first):
 * 1. NYC Open Data — no NOE body corpus (schedule `4ptz-hmtc`, lists `vx8i-nprf` only).
 * 2. OASys `GET /OASysWeb/api/Exam/GetActiveExams` — structured fee, promotional,
 *    examParts (EEE/MC), PDF URL for every open exam.
 * 3. OASys NOE HTML ` /OASysWeb/noe?examId=` — full notice text; polite sequential
 *    fetch (rate-limited), cached as this densify artifact. No live fetch at render.
 *
 * Usage:
 *   node tools/build_noe_differentiators.mjs              # live fetch active NOEs
 *   node tools/build_noe_differentiators.mjs --from-text-fixtures
 *   node tools/build_noe_differentiators.mjs --check
 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OASY_API_ACTIVE_EXAMS,
  oasysNoeUrl,
  normalizeExamNumber,
  normalizeOasysActiveExam,
  buildOasysExamMap,
} from "./lib/oasys_exam_map.mjs";
import {
  parseNoeDifferentiators,
  classifyCorpusBoilerplate,
  examFormatFromOasysParts,
} from "../worker/src/lib/noe_differentiators.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "site", "data", "exam_sources");
const OUTPUT = path.join(SOURCE_DIR, "noe_differentiators.json");
const RECEIPT_DIR = path.join(SOURCE_DIR, "verification_receipts");
const TEXT_FIXTURE_DIR = path.join(SOURCE_DIR, "fixtures", "noe_text");
const OASY_FIXTURE = path.join(SOURCE_DIR, "oasys_active_exams_fixture.json");
const USER_AGENT = "CityScrollNoeDifferentiators/1.0 (+https://cityscroll.org)";
const MIN_DELAY_MS = 1200;

const EXEMPLARS = Object.freeze({
  "7013": { title: "Automotive Service Worker", oasys_exam_id: "9628" },
  "7016": { title: "Caseworker", oasys_exam_id: "9629" },
  "7312": { title: "Police Officer", oasys_exam_id: "9646" },
});

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadOasysPayload(useFixture) {
  if (useFixture) {
    const raw = JSON.parse(await readFile(OASY_FIXTURE, "utf8"));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.payload)) return raw.payload;
    throw new Error("oasys fixture missing payload array");
  }
  const response = await fetch(OASY_API_ACTIVE_EXAMS, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new Error(`GetActiveExams HTTP ${response.status}`);
  return response.json();
}

async function fetchNoeHtml(examId) {
  const url = oasysNoeUrl(examId);
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`NOE HTML HTTP ${response.status} for examId=${examId}`);
  return { url, html: await response.text() };
}

async function loadTextFixture(examId) {
  const file = path.join(TEXT_FIXTURE_DIR, `examId_${examId}.txt`);
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Build densify records from OASys rows + NOE text.
 * @param {Array<object>} oasysPayload
 * @param {(examId: string) => Promise<string|null>} loadBody
 * @param {{ mode: string }} meta
 */
export async function buildDifferentiatorRecords(oasysPayload, loadBody, meta = {}) {
  const map = buildOasysExamMap(oasysPayload);
  const records = [];
  let bodies = 0;
  let api_only = 0;

  for (const row of oasysPayload || []) {
    const norm = normalizeOasysActiveExam(row);
    if (!norm) continue;
    const examParts = row.examParts || row.exam_parts || [];
    const body = await loadBody(norm.oasys_exam_id);
    let parsed;
    if (body) {
      bodies += 1;
      parsed = parseNoeDifferentiators(body, {
        examParts,
        source_url: norm.noe_page_url,
        oasys_exam_id: norm.oasys_exam_id,
      });
    } else {
      api_only += 1;
      const fmt = examFormatFromOasysParts(examParts);
      parsed = parseNoeDifferentiators("", {
        examParts,
        source_url: norm.noe_page_url,
        oasys_exam_id: norm.oasys_exam_id,
      });
      // Prefer API fee when body missing.
      if (parsed.fee == null && norm.filing_fee != null) {
        parsed.fee = norm.filing_fee;
        parsed.fee_level = parsed.fee === 0 ? "none" : parsed.fee_level;
        parsed.provenance = {
          ...parsed.provenance,
          fee: {
            source: "oasys_get_active_exams",
            field: "filingFee",
          },
        };
      }
      if (!parsed.exam_format && fmt.exam_format) {
        parsed.exam_format = fmt.exam_format;
        parsed.part_type_codes = fmt.part_type_codes;
        parsed.test_method = parsed.test_method
          || (fmt.exam_format === "education_experience"
            ? "Education and experience exam"
            : fmt.exam_format === "multiple_choice"
              ? "Multiple-choice test"
              : null);
        parsed.provenance = {
          ...parsed.provenance,
          exam_format: fmt.provenance,
        };
      }
    }

    // API fee fills when body parse misses (should be rare).
    if (parsed.fee == null && norm.filing_fee != null) {
      parsed.fee = Number(norm.filing_fee);
    }
    // API promotional flag.
    const is_promotional = Boolean(norm.is_promotional);

    records.push({
      exam_number: norm.exam_number,
      title: norm.title,
      oasys_exam_id: norm.oasys_exam_id,
      is_promotional,
      eligibility: is_promotional ? "promotion" : "open_competitive",
      notice_url: norm.noe_pdf_url || null,
      noe_page_url: norm.noe_page_url,
      fee: parsed.fee,
      salary_min: parsed.salary_min,
      salary_max: parsed.salary_max,
      salary_note: parsed.salary_note,
      salary_band: parsed.salary_band,
      fee_level: parsed.fee_level,
      exam_format: parsed.exam_format,
      part_type_codes: parsed.part_type_codes || [],
      test_method: parsed.test_method,
      qualifications: parsed.qualifications,
      education_level: parsed.education_level,
      no_experience_required: parsed.no_experience_required,
      residency: parsed.residency,
      residency_required: parsed.residency_required,
      has_selective_certification: parsed.has_selective_certification,
      selective_certification_summary: parsed.selective_certification_summary,
      fee_waiver: parsed.fee_waiver,
      fee_waiver_is_boilerplate: parsed.fee_waiver_is_boilerplate,
      summary: parsed.summary,
      densify_method: body ? "oasys_noe_html_body" : "oasys_get_active_exams_only",
      source_interface: body ? "oasys_noe_html" : "oasys_get_active_exams",
      source_url: norm.noe_page_url,
      provenance: parsed.provenance,
    });
  }

  // Also densify multi-exam police series from 7312 body when present (7311–7322 share NOE).
  const police = records.find((r) => r.exam_number === "7312" && r.qualifications);
  if (police) {
    // No extra numbers in current active set; keep single active police row.
  }

  const corpus = classifyCorpusBoilerplate(records);
  for (const rec of records) {
    const leads = corpus.per_record_leads[rec.exam_number] || [];
    rec.card_leads = leads;
  }

  return {
    schema_version: 1,
    source: {
      id: "dcas-noe-differentiators",
      name: "OASys NOE differentiators densify",
      role:
        "Structured filter facets and card leads from OASys GetActiveExams + NOE HTML body parse. Open Data has no NOE body dataset.",
      oasys_api: OASY_API_ACTIVE_EXAMS,
      open_data_checked: [
        { id: "4ptz-hmtc", name: "Annual Examination Schedule", noe_body: false },
        { id: "vx8i-nprf", name: "Civil Service List (Active)", noe_body: false },
      ],
      interface_choice:
        "bulk Open Data (schedule/list only) < OASys GetActiveExams JSON < polite NOE HTML parse",
      fetched_at: meta.fetched_at || new Date().toISOString().slice(0, 10),
      verified_at: meta.fetched_at || new Date().toISOString().slice(0, 10),
      stale_after_days: 45,
      mode: meta.mode || "live",
      min_request_interval_ms: MIN_DELAY_MS,
    },
    densify_policy: {
      never_fabricate: true,
      precompute_first: true,
      no_live_fetch_at_render: true,
      rate_limit_ms: MIN_DELAY_MS,
    },
    corpus: {
      field_stats: corpus.field_stats,
      boilerplate_fields: corpus.boilerplate_fields,
      distinctive_fields: corpus.distinctive_fields,
    },
    summary: {
      oasys_rows: map.summary.mapped,
      records: records.length,
      bodies_parsed: bodies,
      api_only: api_only,
    },
    records: records.sort((a, b) => a.exam_number.localeCompare(b.exam_number)),
  };
}

function receiptFor(artifact) {
  const byNumber = Object.fromEntries(
    (artifact.records || []).map((r) => [r.exam_number, r]),
  );
  const exemplars = {};
  for (const [num, expect] of Object.entries(EXEMPLARS)) {
    const row = byNumber[num];
    exemplars[num] = row
      ? {
        title: row.title,
        fee: row.fee,
        salary_min: row.salary_min,
        salary_max: row.salary_max,
        exam_format: row.exam_format,
        no_experience_required: row.no_experience_required,
        qualifications: row.qualifications,
        residency_required: row.residency_required,
        test_method: row.test_method,
        card_leads: row.card_leads,
        matched_title: expect.title,
      }
      : { missing: true };
  }
  return {
    schema: "noe_differentiators_receipt.v1",
    generated_at: new Date().toISOString(),
    source: artifact.source,
    summary: artifact.summary,
    corpus: artifact.corpus,
    exemplars,
  };
}

function assertExemplars(artifact) {
  const by = Object.fromEntries(artifact.records.map((r) => [r.exam_number, r]));
  const auto = by["7013"];
  const caseworker = by["7016"];
  const police = by["7312"];
  assert.ok(auto, "Automotive Service Worker 7013");
  assert.ok(caseworker, "Caseworker 7016");
  assert.ok(police, "Police Officer 7312");

  assert.equal(auto.fee, 61);
  assert.equal(auto.salary_min, 42387);
  assert.equal(auto.exam_format, "education_experience");
  assert.equal(auto.no_experience_required, false);
  assert.match(String(auto.qualifications || ""), /automotive|experience|trade/i);

  assert.equal(caseworker.fee, 68);
  assert.equal(caseworker.salary_min, 48206);
  assert.equal(caseworker.exam_format, "education_experience");
  assert.equal(caseworker.no_experience_required, true);
  assert.match(String(caseworker.qualifications || ""), /baccalaureate|bachelor/i);
  assert.equal(caseworker.residency_required, false);

  assert.equal(police.fee, 0);
  assert.equal(police.salary_min, 55942);
  assert.equal(police.salary_max, 109352);
  assert.equal(police.exam_format, "multiple_choice");
  assert.equal(police.residency_required, true);
  assert.match(String(police.test_method || ""), /multiple/i);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const check = args.has("--check");
  const fromFixtures = args.has("--from-text-fixtures") || args.has("--fixture");
  const useOasysFixture = fromFixtures || args.has("--oasys-fixture");

  if (check) {
    const artifact = JSON.parse(await readFile(OUTPUT, "utf8"));
    assertExemplars(artifact);
    assert.ok(artifact.records.length >= 3, "densify must cover active exemplars");
    assert.ok(artifact.corpus, "corpus boilerplate classification required");
    console.log(
      `noe_differentiators check ok: ${artifact.records.length} records, `
      + `boilerplate=${(artifact.corpus.boilerplate_fields || []).join(",") || "none"}`,
    );
    return;
  }

  const payload = await loadOasysPayload(useOasysFixture);
  const fetched_at = new Date().toISOString().slice(0, 10);

  let lastFetch = 0;
  const loadBody = async (examId) => {
    if (fromFixtures) {
      return loadTextFixture(examId);
    }
    // Prefer fixture text when present (deterministic CI), else live.
    const fixture = await loadTextFixture(examId);
    if (fixture && args.has("--prefer-fixtures")) return fixture;
    const elapsed = Date.now() - lastFetch;
    if (elapsed < MIN_DELAY_MS) await sleep(MIN_DELAY_MS - elapsed);
    const { html } = await fetchNoeHtml(examId);
    lastFetch = Date.now();
    // Strip to text via the same plain parser path (HTML tags).
    return html;
  };

  const artifact = await buildDifferentiatorRecords(payload, loadBody, {
    fetched_at,
    mode: fromFixtures ? "text_fixtures" : "live_noe_html",
  });

  assertExemplars(artifact);

  await mkdir(SOURCE_DIR, { recursive: true });
  await mkdir(RECEIPT_DIR, { recursive: true });
  await writeFile(OUTPUT, stableJson(artifact));
  const receipt = receiptFor(artifact);
  await writeFile(
    path.join(RECEIPT_DIR, "noe_differentiators_latest.json"),
    stableJson(receipt),
  );
  console.log(
    `wrote ${OUTPUT} (${artifact.records.length} records, `
    + `bodies=${artifact.summary.bodies_parsed}, api_only=${artifact.summary.api_only})`,
  );
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
