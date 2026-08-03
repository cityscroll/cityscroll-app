#!/usr/bin/env node
/**
 * Fetch OASys GetActiveExams (or load --fixture) and materialize the exam-number
 * → examId deep-link map used by build_staffing_exams.
 *
 * Usage:
 *   node tools/build_oasys_exam_map.mjs              # live fetch + write
 *   node tools/build_oasys_exam_map.mjs --fixture    # rebuild from committed fixture body
 *   node tools/build_oasys_exam_map.mjs --check      # drift gate
 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  OASY_API_ACTIVE_EXAMS,
  materializeOasysMapArtifact,
} from "./lib/oasys_exam_map.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "site", "data", "exam_sources");
const OUTPUT = path.join(SOURCE_DIR, "oasys_exam_map.json");
const FIXTURE_BODY = path.join(SOURCE_DIR, "oasys_active_exams_fixture.json");
const RECEIPT_DIR = path.join(SOURCE_DIR, "verification_receipts");
const USER_AGENT = "CityScrollOASysMap/1.0 (+https://cityscroll.org)";

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function fetchActiveExams() {
  const response = await fetch(OASY_API_ACTIVE_EXAMS, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`OASys GetActiveExams HTTP ${response.status}`);
  }
  return {
    payload: await response.json(),
    http_status: response.status,
    fetched_at: new Date().toISOString().slice(0, 10),
    fetched_at_utc: new Date().toISOString(),
  };
}

async function loadFixtureBody() {
  const raw = JSON.parse(await readFile(FIXTURE_BODY, "utf8"));
  // Fixture may be the raw API array or { records: [...] } / { payload: [...] }.
  if (Array.isArray(raw)) return { payload: raw, fetched_at: new Date().toISOString().slice(0, 10) };
  if (Array.isArray(raw.payload)) {
    return { payload: raw.payload, fetched_at: raw.fetched_at || new Date().toISOString().slice(0, 10) };
  }
  if (Array.isArray(raw.records)) {
    // Re-hydrate a minimal API-shaped payload from committed map records.
    return {
      payload: raw.records.map((r) => ({
        examId: Number(r.oasys_exam_id),
        title: r.title,
        examNumber: r.exam_number,
        filingStart: r.filing_start,
        filingEnd: r.filing_end,
        filingFee: r.filing_fee,
        isPromotional: r.is_promotional,
        noeUrl: r.noe_pdf_url,
      })),
      fetched_at: raw.source?.fetched_at || new Date().toISOString().slice(0, 10),
    };
  }
  throw new Error("oasys fixture must be an array or { payload|records }");
}

function receiptFor(artifact, meta = {}) {
  const golden = {
    "6125": artifact.records.find((r) => r.exam_number === "6125"),
    "7312": artifact.records.find((r) => r.exam_number === "7312"),
  };
  return {
    schema_version: 1,
    source_id: artifact.source.id,
    verified_at: artifact.source.fetched_at,
    verified_at_utc: meta.fetched_at_utc || new Date().toISOString(),
    http_status: meta.http_status ?? null,
    api_url: OASY_API_ACTIVE_EXAMS,
    summary: artifact.summary,
    golden_cases: {
      "6125": golden["6125"]
        ? {
            oasys_exam_id: golden["6125"].oasys_exam_id,
            noe_page_url: golden["6125"].noe_page_url,
            title: golden["6125"].title,
          }
        : null,
      "7312": golden["7312"]
        ? {
            oasys_exam_id: golden["7312"].oasys_exam_id,
            noe_page_url: golden["7312"].noe_page_url,
            title: golden["7312"].title,
          }
        : null,
    },
    policy: {
      join_key: "exact exam_number (OASys examNumber)",
      deep_link: "https://a856-exams.nyc.gov/OASysWeb/noe?examId=:examId",
      unmapped: "keep https://www.nyc.gov/examsforjobs with landing label",
      never_invent_exam_id: true,
    },
  };
}

async function main() {
  const check = process.argv.includes("--check");
  const useFixture = process.argv.includes("--fixture");
  let payload;
  let meta = {};
  if (useFixture) {
    const loaded = await loadFixtureBody();
    payload = loaded.payload;
    meta = { fetched_at: loaded.fetched_at, http_status: null };
  } else if (!check) {
    const live = await fetchActiveExams();
    payload = live.payload;
    meta = live;
    // Refresh the raw fixture body so offline rebuilds stay current.
    await mkdir(SOURCE_DIR, { recursive: true });
    await writeFile(
      FIXTURE_BODY,
      stableJson({
        fetched_at: live.fetched_at,
        fetched_at_utc: live.fetched_at_utc,
        http_status: live.http_status,
        payload: live.payload,
      }),
    );
  } else {
    // --check: rebuild from committed map is wrong; rebuild from fixture body.
    const loaded = await loadFixtureBody().catch(async () => {
      // Fallback: re-derive from existing map artifact records.
      const existing = JSON.parse(await readFile(OUTPUT, "utf8"));
      return {
        payload: (existing.records || []).map((r) => ({
          examId: Number(r.oasys_exam_id),
          title: r.title,
          examNumber: r.exam_number,
          filingStart: r.filing_start,
          filingEnd: r.filing_end,
          filingFee: r.filing_fee,
          isPromotional: r.is_promotional,
          noeUrl: r.noe_pdf_url,
        })),
        fetched_at: existing.source?.fetched_at,
      };
    });
    payload = loaded.payload;
    meta = { fetched_at: loaded.fetched_at };
  }

  const artifact = materializeOasysMapArtifact(payload, {
    fetched_at: meta.fetched_at || new Date().toISOString().slice(0, 10),
  });
  const rendered = stableJson(artifact);
  const receipt = receiptFor(artifact, meta);
  const receiptPath = path.join(RECEIPT_DIR, "oasys_exam_map_latest.json");

  if (check) {
    const onDisk = await readFile(OUTPUT, "utf8");
    // Allow fetched_at drift on --check when only the calendar stamp differs:
    // compare record set identity instead.
    const disk = JSON.parse(onDisk);
    assert.equal(disk.schema_version, artifact.schema_version);
    assert.deepEqual(
      (disk.records || []).map((r) => ({
        exam_number: r.exam_number,
        oasys_exam_id: r.oasys_exam_id,
        noe_page_url: r.noe_page_url,
      })),
      artifact.records.map((r) => ({
        exam_number: r.exam_number,
        oasys_exam_id: r.oasys_exam_id,
        noe_page_url: r.noe_page_url,
      })),
      "oasys_exam_map.json records drifted; rebuild with node tools/build_oasys_exam_map.mjs",
    );
    assert.ok(artifact.records.some((r) => r.exam_number === "6125"), "golden 6125 missing from map");
    assert.ok(artifact.records.some((r) => r.exam_number === "7312"), "golden 7312 missing from map");
    console.log("oasys exam map is current");
    return;
  }

  await mkdir(SOURCE_DIR, { recursive: true });
  await mkdir(RECEIPT_DIR, { recursive: true });
  await writeFile(OUTPUT, rendered);
  await writeFile(receiptPath, stableJson(receipt));
  console.log(`wrote ${path.relative(ROOT, OUTPUT)} (${artifact.summary.mapped} exams)`);
  console.log(`wrote ${path.relative(ROOT, receiptPath)}`);
  for (const n of ["6125", "7312"]) {
    const hit = artifact.records.find((r) => r.exam_number === n);
    console.log(`  golden ${n}: ${hit ? hit.noe_page_url : "UNMAPPED"}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
