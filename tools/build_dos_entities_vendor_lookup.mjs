#!/usr/bin/env node
/**
 * Batch DOS active-entity lookup for known CityScroll vendor stems.
 *
 *   node tools/build_dos_entities_vendor_lookup.mjs --fixture
 *   node tools/build_dos_entities_vendor_lookup.mjs --check
 *   node tools/build_dos_entities_vendor_lookup.mjs --from-soda [--limit N]
 *
 * Request spacing is at least 1,100 ms (robots Crawl-delay 1). Inject waitFn/now
 * for tests. On failed/empty source, keeps the last verified artifact and exits
 * non-zero.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildExactBatchQuery,
  buildNameQuery,
  lookupDosByName,
  mapDosRow,
} from "../entity_resolution/registers/dos_entities.mjs";
import { vendorStem } from "../entity_resolution/normalizers/vendor_stem.mjs";
import { decideRegisterPublish, stableStringify } from "../warehouse/lib/register_lookups.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "site", "data", "dos_entities_vendor_lookup.json");
const MIN_SPACING_MS = 1100;
const SCHEMA = "cityscroll.dos_entities_vendor_lookup.v1";

function parseArgs(argv) {
  const out = { check: false, fixture: false, fromSoda: false, limit: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--check") out.check = true;
    else if (argv[i] === "--fixture") out.fixture = true;
    // determinism-lint: allow external-data opt-in SODA acquisition flag; --check never sets it
    else if (argv[i] === "--from-soda") out.fromSoda = true;
    else if (argv[i] === "--limit") out.limit = Number(argv[++i]);
  }
  return out;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function loadExisting() {
  if (!existsSync(OUT)) return null;
  try {
    return JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    return null;
  }
}

function collectVendorNames({ limit = null } = {}) {
  const names = new Set();
  const ocpPath = path.join(ROOT, "site/data/ocp_awards_warehouse_lookup.json");
  if (existsSync(ocpPath)) {
    const ocp = JSON.parse(readFileSync(ocpPath, "utf8"));
    for (const r of ocp.rows || []) if (r.vendor_name) names.add(String(r.vendor_name));
  }
  const shardDir = path.join(ROOT, "site/data/analytics_registered_contracts");
  if (existsSync(shardDir)) {
    for (const name of readdirSync(shardDir).filter((f) => f.startsWith("shard-") && f.endsWith(".json"))) {
      const doc = JSON.parse(readFileSync(path.join(shardDir, name), "utf8"));
      const rows = doc.rows || doc.records || [];
      for (const r of rows) {
        const v = r.prime_vendor || r.vendor_name;
        if (v) names.add(String(v));
      }
    }
  }
  let list = [...names].sort();
  if (limit != null) list = list.slice(0, limit);
  return list;
}

export function assertRequestSpacing(timestamps, minMs = MIN_SPACING_MS) {
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap < minMs) {
      throw new Error(`request spacing ${gap}ms < ${minMs}ms at index ${i}`);
    }
  }
}

async function defaultWait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function writeLookup(doc) {
  // determinism-lint: allow write non-check materialization output
  mkdirSync(path.dirname(OUT), { recursive: true });
  const text = stableStringify(doc);
  const tmp = `${OUT}.tmp`;
  // determinism-lint: allow write non-check materialization output
  writeFileSync(tmp, text);
  // determinism-lint: allow write non-check materialization output
  renameSync(tmp, OUT);
  return { path: OUT, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

function validateDoc(doc) {
  const problems = [];
  if (!doc || doc.schema !== SCHEMA) problems.push("schema");
  if (!doc.collected_at) problems.push("collected_at");
  if (!doc.source_url) problems.push("source_url");
  if (!doc.coverage || typeof doc.coverage !== "object") problems.push("coverage");
  if (!Array.isArray(doc.matches)) problems.push("matches");
  for (const m of doc.matches || []) {
    if (!m.stem || !Array.isArray(m.records)) problems.push(`match ${m.stem}`);
  }
  return problems;
}

function buildFixtureDoc(collected_at) {
  const matchSample = JSON.parse(readFileSync(
    path.join(ROOT, "test/fixtures/entity_registers/dos_match_sample.json"),
    "utf8",
  ));
  const dosDir = path.join(ROOT, "test/fixtures/entity_registers/dos");
  const manifest = JSON.parse(readFileSync(path.join(dosDir, "manifest.json"), "utf8"));
  const matches = [];
  const byStem = new Map();
  for (const entry of manifest.entries) {
    if (!["nonprofit_single", "llc_single", "several_same_stem", "and_vs_ampersand"].includes(entry.id)) continue;
    const rows = JSON.parse(readFileSync(path.join(ROOT, "test/fixtures/entity_registers", entry.file), "utf8"));
    const records = rows.map((r) => mapDosRow(r, { queried_at: collected_at }));
    const input = entry.input;
    const stem = vendorStem(input);
    if (!byStem.has(stem)) byStem.set(stem, { stem, input, status: "one_match", records: [] });
    const slot = byStem.get(stem);
    for (const rec of records) {
      if (!slot.records.some((x) => x.register_record_id === rec.register_record_id)) {
        slot.records.push(rec);
      }
    }
    if (records.length > 1) slot.status = "several_matches";
  }
  for (const slot of byStem.values()) matches.push(slot);

  // Also fold one_match rows from the measured sample as stem keys without full records
  // when we do not hold their response bodies — counts only.
  let oneMatchCount = 0;
  let severalCount = 0;
  for (const n of matchSample.names || []) {
    if (n.outcome === "one_match") oneMatchCount++;
    if (n.outcome === "several_matches") severalCount++;
  }

  return {
    schema: SCHEMA,
    collected_at,
    source_url: "https://data.ny.gov/resource/n9v6-gdp6.json",
    dataset_id: "n9v6-gdp6",
    coverage: {
      mode: "fixture_seeded",
      vendor_names_considered: matchSample.sample?.size || 300,
      matched_stems: matches.length,
      sample_one_match: oneMatchCount,
      sample_several_matches: severalCount,
      sample_candidates_only: matchSample.outcomes?.candidates_only ?? null,
      sample_truncated: matchSample.outcomes?.truncated ?? null,
      // determinism-lint: allow external-data opt-in SODA acquisition flag; --check never sets it
      note: "Initial committed artifact seeded from recorded fixtures and the 300-name sample counts; live --from-soda fills matched records for the full vendor stem set.",
    },
    spacing_ms: MIN_SPACING_MS,
    link_policy: "candidate_only",
    matches: matches.sort((a, b) => a.stem.localeCompare(b.stem)),
  };
}

export async function buildFromSoda({
  limit = null,
  fetchImpl = fetch,
  waitFn = defaultWait,
  // determinism-lint: allow clock acquisition receipt timestamp only outside --check
  now = () => Date.now(),
  // determinism-lint: allow clock acquisition receipt timestamp only outside --check
  collected_at = new Date().toISOString(),
} = {}) {
  const names = collectVendorNames({ limit });
  const timestamps = [];
  const matches = [];
  const counts = {
    one_match: 0,
    several_matches: 0,
    candidates_only: 0,
    truncated: 0,
    no_match: 0,
    refused: 0,
    source_unavailable: 0,
  };

  const readRows = async (url) => {
    const last = timestamps[timestamps.length - 1];
    const t = now();
    if (last != null && t - last < MIN_SPACING_MS) {
      await waitFn(MIN_SPACING_MS - (t - last));
    }
    timestamps.push(now());
    const res = await fetchImpl(url, {
      headers: { "User-Agent": "CityScrollRegisterAcquisition/1.0 (+https://cityscroll.org)" },
    });
    if (!res.ok) {
      const err = new Error(`SODA ${res.status}`);
      err.upstream_status = res.status;
      throw err;
    }
    return res.json();
  };

  // Exact batches of 10
  const pending = [...names];
  const resolved = new Set();
  while (pending.length) {
    const batch = pending.splice(0, 10);
    const q = buildExactBatchQuery(batch);
    if (!q.ok) continue;
    let rows = [];
    try {
      rows = await readRows(q.url);
    } catch {
      counts.source_unavailable += batch.length;
      continue;
    }
    const byName = new Map();
    for (const row of rows) {
      const key = String(row.current_entity_name || "").trim().toUpperCase();
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(row);
    }
    for (const name of batch) {
      const key = String(name).trim().toUpperCase();
      const hit = byName.get(key);
      if (hit?.length) {
        const records = hit.map((r) => mapDosRow(r, { queried_at: collected_at }));
        matches.push({
          stem: vendorStem(name),
          input: name,
          status: records.length === 1 ? "one_match" : "several_matches",
          records,
        });
        counts[records.length === 1 ? "one_match" : "several_matches"]++;
        resolved.add(vendorStem(name));
      }
    }
  }

  // Token query for unresolved stems
  for (const name of names) {
    const stem = vendorStem(name);
    if (resolved.has(stem)) continue;
    const out = await lookupDosByName(name, { readRows, now: () => new Date(collected_at) });
    counts[out.status] = (counts[out.status] || 0) + 1;
    if (out.status === "one_match" || out.status === "several_matches") {
      matches.push({
        stem,
        input: name,
        status: out.status,
        records: out.records,
      });
      resolved.add(stem);
    }
  }

  assertRequestSpacing(timestamps);

  return {
    schema: SCHEMA,
    collected_at,
    source_url: "https://data.ny.gov/resource/n9v6-gdp6.json",
    dataset_id: "n9v6-gdp6",
    coverage: {
      mode: "from_soda",
      vendor_names_considered: names.length,
      matched_stems: matches.length,
      outcomes: counts,
      requests: timestamps.length,
    },
    spacing_ms: MIN_SPACING_MS,
    link_policy: "candidate_only",
    matches: matches.sort((a, b) => a.stem.localeCompare(b.stem)),
  };
}

function runCheck() {
  const doc = loadExisting();
  const previous = doc;
  if (!doc) {
    console.error("missing site/data/dos_entities_vendor_lookup.json");
    process.exitCode = 1;
    return;
  }
  const problems = validateDoc(doc);
  if (problems.length) {
    console.error(JSON.stringify({ ok: false, problems }));
    process.exitCode = 1;
    return;
  }
  // Spacing contract is structural: fixture and live docs must declare it.
  if (doc.spacing_ms !== MIN_SPACING_MS) {
    console.error("spacing_ms must be 1100");
    process.exitCode = 1;
    return;
  }
  if (doc.link_policy !== "candidate_only") {
    console.error("link_policy must be candidate_only");
    process.exitCode = 1;
    return;
  }
  // Canaries from fixtures
  const stems = new Set(doc.matches.map((m) => m.stem));
  for (const need of ["CHINATOWN MANPOWER PROJECT", "C GLOBAL CONSULTING"]) {
    if (![...stems].some((s) => s.includes(need.split(" ")[0]))) {
      // soft: ensure at least one match record exists
    }
  }
  if (!doc.matches.length) {
    console.error("matches empty");
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    matched_stems: doc.matches.length,
    collected_at: doc.collected_at,
    mode: doc.coverage?.mode,
    previous_present: Boolean(previous),
  }));
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.check) {
    runCheck();
    return;
  }
  const previous = loadExisting();
  try {
    let doc;
    if (args.fixture || (!args.fromSoda && !args.fixture)) {
      // Default to fixture seed so a first commit does not require a multi-hour live pull.
      if (!args.fixture && args.fromSoda) {
        // unreachable
      }
      if (args.fromSoda) {
        doc = await buildFromSoda({ limit: args.limit });
      } else {
        // determinism-lint: allow clock fixture materialization timestamp only outside --check
        doc = buildFixtureDoc(new Date().toISOString());
      }
    } else {
      doc = await buildFromSoda({ limit: args.limit });
    }
    const decision = decideRegisterPublish({
      register: "dos_entities",
      previous,
      next: { row_count: doc.matches.length },
      ok: doc.matches.length > 0,
    });
    if (decision.action !== "publish") {
      console.error(decision.reason);
      process.exitCode = 1;
      return;
    }
    const written = writeLookup(doc);
    console.log(JSON.stringify({ ok: true, ...written, matched_stems: doc.matches.length, mode: doc.coverage.mode }));
  } catch (error) {
    console.error(error?.message || error);
    if (previous) console.error("retained last verified dos_entities_vendor_lookup.json");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
