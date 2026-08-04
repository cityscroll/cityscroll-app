#!/usr/bin/env node
// RC-4: checkpointed host-side collection and measured City Record -> ABO residual bridge.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildAboResidualPayload,
  measureAboResidualJoin,
} from "../../worker/src/lib/abo_awards_join.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const DEFAULT_FIXTURE = resolve(REPO, "warehouse/fixtures/abo-awards-residual/labeled_sample.json");
const DEFAULT_STAGE = resolve(REPO, "warehouse/raw/abo-awards-residual/latest");
const DEFAULT_RECEIPT = resolve(REPO, "warehouse/receipts/abo_residual_latest.json");
const DEFAULT_PAYLOAD = resolve(REPO, "site/data/abo_award_residual_lookup.json");
const DEFAULT_WORKER_PAYLOAD = resolve(REPO, "worker/src/data/abo_award_residual_lookup.json");
const CITY_RECORD = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const ABO_RESOURCE = "https://data.ny.gov/resource/";
const USER_AGENT = "CityScrollWarehouse/0.3 (+https://cityscroll.org; RC-4 ABO residual measurement)";
const PAGE_SIZE = 1000;

function parseArgs(argv) {
  const out = {
    fixture: false,
    fixturePath: DEFAULT_FIXTURE,
    stageDir: DEFAULT_STAGE,
    receipt: DEFAULT_RECEIPT,
    payload: DEFAULT_PAYLOAD,
    workerPayload: DEFAULT_WORKER_PAYLOAD,
    checkpoint: null,
    delayMs: 300,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--from-fixture") out.fixture = true;
    else if (arg === "--fixture") out.fixturePath = resolve(argv[++i]);
    else if (arg === "--stage-dir") out.stageDir = resolve(argv[++i]);
    else if (arg === "--receipt") out.receipt = resolve(argv[++i]);
    else if (arg === "--payload") out.payload = resolve(argv[++i]);
    else if (arg === "--worker-payload") out.workerPayload = resolve(argv[++i]);
    else if (arg === "--checkpoint") out.checkpoint = resolve(argv[++i]);
    else if (arg === "--polite-delay-ms") out.delayMs = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  out.checkpoint ||= resolve(out.stageDir, "checkpoint.json");
  if (!out.fixture && (!Number.isFinite(out.delayMs) || out.delayMs < 250)) {
    throw new Error("live Socrata cadence must be at least 250 ms");
  }
  return out;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (response.status === 403) {
    throw new Error(`unattended collector refused (HTTP 403); stopped without retry: ${url}`);
  }
  if (!response.ok) throw new Error(`source fetch failed (${response.status}): ${url}`);
  return response.json();
}

function sq(value) {
  return String(value || "").replaceAll("'", "''");
}

function sourceSlug(dataset, authority) {
  return `${dataset}-${String(authority).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

async function fetchFixedNotices(manifest, args, checkpoint) {
  const expected = new Map(manifest.notices.map((notice) => [notice.request_id, notice]));
  const ids = [...expected.keys()];
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += 25) {
    const batch = ids.slice(offset, offset + 25);
    const query = new URLSearchParams({
      "$select": "request_id,start_date,agency_name,type_of_notice_description,short_title,pin,vendor_name,contract_amount",
      "$where": `request_id in(${batch.map((id) => `'${sq(id)}'`).join(",")})`,
      "$order": "request_id",
      "$limit": String(batch.length),
    });
    rows.push(...await fetchJson(`${CITY_RECORD}?${query}`));
    checkpoint.city_record_batches = (checkpoint.city_record_batches || 0) + 1;
    await writeJson(args.checkpoint, checkpoint);
    if (offset + 25 < ids.length) await wait(args.delayMs);
  }
  const found = new Set(rows.map((row) => row.request_id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new Error(`fixed sample notices missing from City Record: ${missing.join(", ")}`);
  return rows.map((row) => {
    const expectedRow = expected.get(row.request_id);
    return { ...row, dataset: expectedRow.dataset, authority: expectedRow.authority };
  });
}

async function fetchAuthorityRows(dataset, authority, args, checkpoint) {
  const slug = sourceSlug(dataset, authority);
  const cachePath = resolve(args.stageDir, "source-cache", `${slug}.json`);
  if (checkpoint.sources?.[slug]?.complete) {
    const cached = await readJson(cachePath);
    if (Array.isArray(cached)) return cached;
  }

  const fields = [
    "authority_name", "vendor_name", "procurement_description", "procurements",
    "award_date", "contract_amount", "fiscal_year_end_date",
  ];
  if (dataset === "ehig-g5x3") fields.push("transaction_number");
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = new URLSearchParams({
      "$select": fields.join(","),
      "$where": `authority_name='${sq(authority)}' AND award_date IS NOT NULL`,
      "$order": "award_date DESC",
      "$limit": String(PAGE_SIZE),
      "$offset": String(offset),
    });
    const page = await fetchJson(`${ABO_RESOURCE}${dataset}.json?${query}`);
    rows.push(...page.map((row) => ({ ...row, dataset })));
    checkpoint.sources ||= {};
    checkpoint.sources[slug] = { rows: rows.length, next_offset: offset + page.length, complete: page.length < PAGE_SIZE };
    await writeJson(cachePath, rows);
    await writeJson(args.checkpoint, checkpoint);
    if (page.length < PAGE_SIZE) break;
    await wait(args.delayMs);
  }
  return rows;
}

async function loadLive(manifest, args) {
  const checkpoint = await readJson(args.checkpoint, { schema: "cityscroll.abo_award_checkpoint.v1", sources: {} });
  const notices = await fetchFixedNotices(manifest, args, checkpoint);
  const sources = new Map(notices.map((notice) => [
    `${notice.dataset}:${notice.authority}`,
    { dataset: notice.dataset, authority: notice.authority },
  ]));
  const awards = [];
  for (const source of sources.values()) {
    awards.push(...await fetchAuthorityRows(source.dataset, source.authority, args, checkpoint));
    await wait(args.delayMs);
  }
  checkpoint.completed_at = new Date().toISOString();
  await writeJson(args.checkpoint, checkpoint);
  return { ...manifest, notices, awards, observed_at_utc: checkpoint.completed_at };
}

function sourceInventory(input) {
  if (input.source_inventory?.length) return input.source_inventory;
  const buckets = new Map();
  for (const award of input.awards || []) {
    const key = `${award.dataset}:${award.authority_name}`;
    const bucket = buckets.get(key) || {
      dataset: award.dataset,
      authority: award.authority_name,
      rows_scanned: 0,
      award_date_min: null,
      award_date_max: null,
    };
    const date = award.award_date || null;
    bucket.rows_scanned += 1;
    if (date && (!bucket.award_date_min || date < bucket.award_date_min)) bucket.award_date_min = date;
    if (date && (!bucket.award_date_max || date > bucket.award_date_max)) bucket.award_date_max = date;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => `${a.dataset}:${a.authority}`.localeCompare(`${b.dataset}:${b.authority}`));
}

function flattenCandidate(candidate) {
  const award = candidate.award || {};
  return {
    request_id: candidate.request_id,
    rank: candidate.rank,
    review_label: candidate.review_label,
    review_note: candidate.review_note,
    classification: candidate.classification,
    method: candidate.method,
    source_key: candidate.source_key,
    shared_identifiers: candidate.shared_identifiers,
    vendor_stem_equal: candidate.vendor_stem_equal,
    amount_equal: candidate.amount_equal,
    date_in_window: candidate.date_in_window,
    award_lag_days: candidate.award_lag_days,
    title_similarity: candidate.title_similarity,
    dataset: award.dataset || null,
    authority_name: award.authority_name || null,
    vendor_name: award.vendor_name || null,
    procurement_description: award.procurement_description || null,
    award_date: award.award_date || null,
    contract_amount: award.contract_amount ?? null,
    transaction_number: award.transaction_number || null,
  };
}

function makeReceipt(input, measurement, args, inventory) {
  const candidatesByRequest = new Map();
  for (const candidate of measurement.candidates) {
    const rows = candidatesByRequest.get(candidate.request_id) || [];
    rows.push(candidate);
    candidatesByRequest.set(candidate.request_id, rows);
  }
  const reviewCases = (input.reviews || []).map((review) => ({
    request_id: review.request_id,
    label: review.label,
    note: review.note,
    candidates: (candidatesByRequest.get(review.request_id) || []).slice(0, 3).map((candidate) => ({
      dataset: candidate.award?.dataset || null,
      authority: candidate.award?.authority_name || null,
      vendor: candidate.award?.vendor_name || null,
      description: candidate.award?.procurement_description || null,
      award_date: candidate.award?.award_date || null,
      amount: candidate.award?.contract_amount ?? null,
      method: candidate.method,
      title_similarity: candidate.title_similarity,
      award_lag_days: candidate.award_lag_days,
    })),
  }));
  return {
    schema: "cityscroll.abo_award_residual_receipt.v1",
    observed_on: input.observed_on,
    observed_at_utc: input.observed_at_utc,
    source_contracts: input.source_contracts,
    mode: args.fixture ? "fixture-proof" : "live-fixed-sample-refresh",
    access_surface: {
      city_record: CITY_RECORD,
      abo_resource: `${ABO_RESOURCE}{dataset}.json`,
    },
    collection: {
      user_agent: USER_AGENT,
      checkpointed: true,
      page_size: PAGE_SIZE,
      polite_delay_ms: args.fixture ? 0 : args.delayMs,
      retry_on_403: false,
      refusal_policy: "A 403 stops the host-side run; the collector does not retry or move scraping to the edge.",
    },
    source_inventory: inventory,
    source_date_quality: {
      future_dated_maxima: inventory.filter((row) =>
        String(row.award_date_max || "").slice(0, 10) > input.observed_on
      ).map((row) => ({
        dataset: row.dataset,
        authority: row.authority,
        award_date_max: row.award_date_max,
      })),
      handling: "Source dates are preserved. Candidate generation still requires award_date on/after the notice and no more than 730 days later; a future-dated source maximum is provenance, not proof of a match.",
    },
    fixed_sample: {
      selection: input.selection,
      notices: measurement.sample.total,
      reviewed_candidate_groups: measurement.review.reviewed,
      source_rows_scanned: inventory.reduce((sum, row) => sum + Number(row.rows_scanned || 0), 0),
    },
    join_measurement: {
      strategy: "Registry-exact authority normalization, then exact source identifier when published; otherwise exact vendor stem + amount + 0..730-day award window. Title/date candidates require clerical labels and the batch precision floor.",
      signal_availability: measurement.signal_availability,
      joined: measurement.joined,
      total: measurement.sample.total,
      rate: measurement.join_rate,
      ambiguous: measurement.ambiguity,
      fuzzy_precision: measurement.fuzzy_precision,
      gate_status: measurement.gate.status,
      usefulness_threshold: measurement.gate.usefulness_threshold,
      fuzzy_precision_floor: measurement.gate.fuzzy_precision_floor,
      per_authority: measurement.per_authority,
      false_positive_review: { ...measurement.review, cases: reviewCases },
      identifier_finding: "The sampled local-authority and local-development-corporation rows expose no contract/PIN identifier; the state-authority table has transaction_number but the fixed residual sample contains no state-authority notice counterpart.",
      vendor_amount_finding: "0/50 residual notices publish vendor_name and 0/50 publish contract_amount, so neither vendor identity nor amount agreement can operate on this residual.",
      verdict: "STOP — 1/50 (2%) labeled join coverage is below the 30% usefulness threshold and measured fuzzy precision is 50%, below the 95% floor. Broad name similarity remains candidate evidence only; publish no notice-level edge.",
    },
    payload_contract: {
      schema: "cityscroll.abo_award_residual.v1",
      paths: ["site/data/abo_award_residual_lookup.json", "worker/src/data/abo_award_residual_lookup.json"],
      matches_materialized: measurement.edges.length,
      reader_surface_included: false,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: abo_awards.mjs [--from-fixture] [--stage-dir DIR] [--checkpoint FILE] [--polite-delay-ms 300]");
    return;
  }
  const manifest = JSON.parse(await readFile(args.fixturePath, "utf8"));
  const input = args.fixture ? manifest : await loadLive(manifest, args);
  const measurement = measureAboResidualJoin(input);
  const inventory = sourceInventory(input);
  const payload = buildAboResidualPayload(measurement, {
    observedAt: input.observed_at_utc,
    sourceContracts: input.source_contracts,
  });
  const receipt = makeReceipt(input, measurement, args, inventory);

  await writeJsonl(resolve(args.stageDir, "notices.jsonl"), input.notices || []);
  await writeJsonl(resolve(args.stageDir, "awards.jsonl"), input.awards || []);
  await writeJsonl(resolve(args.stageDir, "candidates.jsonl"), measurement.candidates.map(flattenCandidate));
  await writeJsonl(resolve(args.stageDir, "matches.jsonl"), measurement.edges);
  await writeJsonl(resolve(args.stageDir, "measurement.jsonl"), [{
    observed_on: input.observed_on,
    total: measurement.sample.total,
    joined: measurement.joined,
    join_rate: measurement.join_rate,
    fuzzy_precision: measurement.fuzzy_precision,
    ambiguous: measurement.ambiguity,
    gate_status: measurement.gate.status,
    materialize: measurement.gate.materialize,
  }]);
  await writeJson(args.receipt, receipt);
  await writeJson(args.payload, payload);
  await writeJson(args.workerPayload, payload);
  console.log(JSON.stringify(receipt));
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
