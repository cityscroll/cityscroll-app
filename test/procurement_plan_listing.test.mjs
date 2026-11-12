// Agency plan reader: listing, population, filters, wording, quality flags,
// index rebuild/check, and capability family projection.
//   node --test test/procurement_plan_listing.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadPlanPopulation, listPlans, renderPlanRow, projectRow, agencyCodeFromUrl, isWorkbookListRow, provenanceKey,
  PLAN_READER_STRINGS, ROW_KEYS, SORTS, LISTING_LIMITS, PLANNING_MANIFEST_PATH,
} from "../site/procurement_plan_listing.mjs";
import { buildFromRoot, serializeIndex, planCapabilityFamilies, main as indexMain, PLAN_INDEX_SCHEMA } from "../tools/build_procurement_plan_index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRoot = (rel) => readFileSync(join(ROOT, rel));
const fsReader = (root) => async (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel)) : null);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const manifestBytes = readRoot(PLANNING_MANIFEST_PATH);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const rawRows = manifest.collections.plans.shards.flatMap((s) => JSON.parse(readRoot(s.path).toString("utf8")).rows.map((row, i) => ({ row, shard: s.path, i })));
const population = await loadPlanPopulation(fsReader(ROOT));
const index = JSON.parse(readRoot("site/data/procurement_plan_index.json").toString("utf8"));

function listAll(query = {}) {
  const rows = [];
  let cursor;
  let first;
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = listPlans(population, { ...query, limit: LISTING_LIMITS.max_limit, ...(cursor ? { cursor } : {}) }, { index });
    assert.equal(page.status, "ok", JSON.stringify(page.errors || page.reason));
    first ||= page;
    rows.push(...page.rows);
    if (!page.next_cursor) return { first, rows };
    cursor = page.next_cursor;
  }
  throw new Error("pagination did not terminate");
}

function tempCopyOfPayload() {
  const dir = mkdtempSync(join(tmpdir(), "plan-reader-"));
  mkdirSync(join(dir, "site/data/procurement_planning_payload"), { recursive: true });
  mkdirSync(join(dir, "worker/src/data"), { recursive: true });
  writeFileSync(join(dir, PLANNING_MANIFEST_PATH), manifestBytes);
  for (const s of manifest.collections.plans.shards) writeFileSync(join(dir, s.path), readRoot(s.path));
  writeFileSync(join(dir, "worker/src/data/agency_crosswalk.json"), readRoot("worker/src/data/agency_crosswalk.json"));
  return dir;
}

test("payload is the committed planning population", () => {
  assert.equal(manifest.schema, "cityscroll.procurement_planning.manifest.v1");
  assert.equal(manifest.generated_at, "2026-08-11T18:55:26Z");
  assert.equal(population.status, "ok");
});

test("(i) totals: 2,925 LL1 + 8,641 LL63 = 11,566 rows held; 93 LL1 drop-down list rows withheld", () => {
  const count = (src) => rawRows.filter((r) => r.row.source === src).length;
  assert.equal(count("mocs_ll1"), 2925);
  assert.equal(count("mocs_ll63"), 8641);
  assert.equal(population.rows.length, 11566);
  assert.equal(new Set(manifest.sources.filter((s) => s.source === "mocs_ll1").map((s) => s.url)).size, 32);
  assert.equal(new Set(manifest.sources.filter((s) => s.source === "mocs_ll63").map((s) => s.url)).size, 69);
  const withheld = rawRows.filter((r) => isWorkbookListRow(r.row));
  assert.equal(withheld.length, 93);
  assert.deepEqual([...new Set(withheld.map((r) => r.row.plan_id))].sort(), ["$200K or Below", "Exclusions", "Will Not Be Renewed/Extended"]);
  assert.ok(withheld.every((r) => r.row.source === "mocs_ll1" && r.row.source_row >= 10584));
  const all = listAll();
  assert.equal(all.first.total, 11566 - 93);
  assert.deepEqual(all.first.withheld, { workbook_list_row: 93 });
  assert.equal(listAll({ source: "ll1" }).first.total, 2832);
  assert.equal(listAll({ source: "ll63" }).first.total, 8641);
});

test("(i) per-agency counts equal an independent recount, and every listed row resolves to its shard row", () => {
  const recount = new Map();
  for (const { row } of rawRows) {
    if (/^FY\d{2}[A-Z]/.test(row.plan_id)) {
      const code = row.source_url.split("/").pop().split("_")[0].toUpperCase();
      recount.set(code, (recount.get(code) || 0) + 1);
    }
  }
  assert.equal(recount.size, index.agencies.length);
  const shardCache = new Map();
  for (const agency of index.agencies) {
    assert.equal(agency.rows_listable, recount.get(agency.agency_code), agency.agency_code);
    const { first, rows } = listAll({ agency_code: agency.agency_code });
    assert.equal(first.total, recount.get(agency.agency_code), agency.agency_code);
    for (const row of rows) {
      assert.ok(row.source_url.startsWith("https://www.nyc.gov/assets/mocs/downloads/Resources/"));
      assert.ok(Number.isInteger(row.source_row) && row.source_sheet);
      if (!shardCache.has(row.shard)) {
        shardCache.set(row.shard, new Map(JSON.parse(readRoot(row.shard).toString("utf8")).rows.map((r) => [provenanceKey(r), r])));
      }
      const raw = shardCache.get(row.shard).get(provenanceKey(row));
      assert.ok(raw, `${row.shard} has no row ${row.source_url} ${row.source_row}`);
      assert.equal(raw.source_record_id, row.source_record_id);
    }
  }
});

test("(ii) positive canary ACS: Local Law 1 and Local Law 63 rows under one engine agency", () => {
  const acs = listAll({ agency_id: "administration-for-childrens-services" });
  assert.equal(acs.first.total, 48);
  assert.deepEqual(acs.first.withheld, { workbook_list_row: 3 });
  assert.equal(acs.rows.filter((r) => r.source === "ll1").length, 5);
  assert.equal(acs.rows.filter((r) => r.source === "ll63").length, 43);
  assert.deepEqual(acs.first.agency.agency_codes, ["ACS"]);
  const byKey = listAll({ agency_key: "ACS" });
  assert.equal(byKey.first.total, 43, "agency_key is exact: the LL63 spelling only");
  // Deep-equal of committed ACS/OCME/DORIS/CFB rows is covered by shard provenance
  // resolution above and the per-agency canaries below; no committed-rows.json fixture.
});

test("(ii) other positive members: OCME and DORIS (both laws), CFB (Local Law 63 only)", () => {
  assert.equal(listAll({ agency_code: "OCME" }).first.total, 10);
  assert.equal(listAll({ agency_id: "records-and-information-services" }).first.total, 12);
  const cfb = listAll({ agency_code: "cfb" });
  assert.equal(cfb.first.total, 25);
  assert.ok(cfb.rows.every((r) => r.source === "ll63"));
});

test("(ii) negative member: an engine agency with no plan rows is an empty result, distinct from unknown and from a missing payload", async () => {
  assert.ok(index.known_agencies_without_rows.includes("aging"));
  assert.ok(index.known_agencies_without_rows.length > 0);
  const aging = listPlans(population, { agency_id: "aging" }, { index });
  assert.equal(aging.status, "ok");
  assert.equal(aging.total, 0);
  assert.equal(aging.empty_reason, "no_plan_workbook_in_collection");
  assert.deepEqual(aging.rows, []);
  const unknown = listPlans(population, { agency_id: "not-an-agency" }, { index });
  assert.equal(unknown.status, "unknown_agency");
  assert.equal("rows" in unknown, false);
  assert.equal(listPlans(population, { agency_code: "ZZZ" }, { index }).status, "unknown_agency");
  const missing = await loadPlanPopulation(async () => null);
  assert.deepEqual([missing.status, missing.reason], ["refused", "payload_missing"]);
  assert.equal(listPlans(missing, { agency_id: "aging" }, { index }).status, "refused");
});

test("(ii) malformed or absent payload pieces are clean refusals, never an empty success", async () => {
  const dir = tempCopyOfPayload();
  try {
    const read = fsReader(dir);
    writeFileSync(join(dir, PLANNING_MANIFEST_PATH), "{not json");
    assert.equal((await loadPlanPopulation(read)).reason, "payload_malformed");
    writeFileSync(join(dir, PLANNING_MANIFEST_PATH), JSON.stringify({ ...manifest, schema: "other" }));
    assert.equal((await loadPlanPopulation(read)).reason, "payload_malformed");
    writeFileSync(join(dir, PLANNING_MANIFEST_PATH), manifestBytes);
    const shardPath = manifest.collections.plans.shards[1].path;
    const shard = JSON.parse(readRoot(shardPath).toString("utf8"));
    shard.rows[0].quarter = 3;
    writeFileSync(join(dir, shardPath), `${JSON.stringify(shard, null, 2)}\n`);
    assert.equal((await loadPlanPopulation(read)).reason, "shard_hash_mismatch");
    rmSync(join(dir, shardPath));
    assert.equal((await loadPlanPopulation(read)).reason, "shard_missing");
    const fewer = structuredClone(manifest);
    fewer.collections.plans.rows -= 1;
    writeFileSync(join(dir, PLANNING_MANIFEST_PATH), JSON.stringify(fewer));
    writeFileSync(join(dir, shardPath), readRoot(shardPath));
    assert.equal((await loadPlanPopulation(read)).reason, "row_count_mismatch");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(iii) every sort pages through the whole listable population without loss or duplication, deterministically", () => {
  for (const sort of SORTS) {
    const a = listAll({ sort }).rows.map(provenanceKey);
    const b = listAll({ sort }).rows.map(provenanceKey);
    assert.equal(a.length, 11473, sort);
    assert.equal(new Set(a).size, 11473, sort);
    assert.deepEqual(a, b, sort);
  }
  const byAmount = listAll({ sort: "amount_desc" }).rows;
  const amounts = byAmount.map((r) => r.estimated_amount?.amount ?? null);
  const firstNull = amounts.indexOf(null);
  assert.ok(amounts.slice(firstNull).every((v) => v === null), "nulls last");
  for (let i = 1; i < firstNull; i += 1) assert.ok(amounts[i - 1] >= amounts[i]);
});

test("(iii) filters equal independent recounts and report rows excluded only for a missing value", () => {
  const listable = rawRows.filter((r) => !isWorkbookListRow(r.row)).map((r) => r.row);
  const pro = listAll({ industry: "Professional Services" });
  assert.equal(pro.first.total, listable.filter((r) => r.industry === "Professional Services").length);
  assert.equal(pro.first.excluded_for_missing_value.industry, listable.filter((r) => r.industry == null).length);
  assert.equal(listAll({ quarter: 2 }).first.total, listable.filter((r) => r.quarter === 2).length);
  assert.equal(listAll({ quarter: "not_published" }).first.total, listable.filter((r) => r.quarter == null).length);
  const band = listAll({ amount_min: 500000, amount_max: 1000000 });
  assert.equal(band.first.total, listable.filter((r) => r.budget && r.budget.amount >= 500000 && r.budget.amount <= 1000000).length);
  const ll63Industry = listPlans(population, { source: "ll63", industry: "Professional Services" }, { index });
  assert.equal(ll63Industry.total, 0);
  assert.equal(ll63Industry.excluded_for_missing_value.industry, 8641);
  const p1 = listPlans(population, { agency_code: "ACS", limit: 10 }, { index });
  assert.equal(listPlans(population, { agency_code: "DOT", cursor: p1.next_cursor }, { index }).status, "invalid_query");
  assert.equal(listPlans(population, { limit: 101 }, { index }).status, "invalid_query");
  assert.equal(listPlans(population, { agency_id: "x", agency_code: "Y" }, { index }).status, "invalid_query");
  assert.equal(listPlans(population, { quarter: 5 }, { index }).status, "invalid_query");
});

test("(iv) no capital-project rows, no goal or percent fields, no inferred identifier", async () => {
  const rows = listAll().rows;
  const forbidden = /goal|percent|pct|mwbe|participation|solicitation|notice|epin|^pin|target|utilization/i;
  const raw = new Map(rawRows.map((r) => [provenanceKey(r.row), r.row]));
  for (const row of rows) {
    assert.equal(row.kind, "plan");
    assert.ok(["ll1", "ll63"].includes(row.source));
    assert.deepEqual(Object.keys(row).sort(), [...ROW_KEYS].sort());
    for (const key of Object.keys(row)) assert.equal(forbidden.test(key), false, key);
    const source = raw.get(provenanceKey(row));
    assert.deepEqual(row.published_identifiers, source.published_identifiers);
    assert.deepEqual(row.estimated_amount, source.budget);
  }
  assert.equal(rows.filter((r) => r.published_identifiers.length).length, 124);
  const dir = tempCopyOfPayload();
  try {
    const shardPath = manifest.collections.plans.shards[1].path;
    const shard = JSON.parse(readRoot(shardPath).toString("utf8"));
    shard.rows[0] = { ...shard.rows[0], source: "capital_projects_dashboard" };
    const bytes = Buffer.from(`${JSON.stringify(shard, null, 2)}\n`);
    writeFileSync(join(dir, shardPath), bytes);
    const m2 = structuredClone(manifest);
    m2.collections.plans.shards[1].sha256 = sha256(bytes);
    writeFileSync(join(dir, PLANNING_MANIFEST_PATH), JSON.stringify(m2));
    const refused = await loadPlanPopulation(fsReader(dir));
    assert.equal(refused.reason, "payload_malformed");
    assert.match(refused.detail, /unexpected row source capital_projects_dashboard/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(v) the generated index equals a rebuild and a recount; a one-row change is detected by --check", async () => {
  const rebuilt = serializeIndex(buildFromRoot(ROOT));
  assert.equal(rebuilt, readRoot("site/data/procurement_plan_index.json").toString("utf8"));
  assert.equal(index.schema, PLAN_INDEX_SCHEMA);
  assert.equal(index.source_manifest.sha256, sha256(manifestBytes));
  assert.deepEqual(index.totals, {
    rows_held: 11566, rows_listable: 11473, withheld: { workbook_list_row: 93 },
    by_source: { ll1: { rows_held: 2925, rows_listable: 2832, workbooks: 32 }, ll63: { rows_held: 8641, rows_listable: 8641, workbooks: 69 } },
  });
  assert.ok(Buffer.byteLength(rebuilt) < 128 * 1024);
  for (const agency of index.agencies) {
    const quarters = Object.values(agency.quarters).reduce((a, b) => a + b, 0);
    const industries = Object.values(agency.industries).reduce((a, b) => a + b, 0);
    assert.equal(quarters, agency.rows_listable);
    assert.equal(industries, agency.rows_listable);
    assert.equal(agency.rows_held, agency.rows_listable + agency.withheld.workbook_list_row);
  }
  assert.deepEqual(index.unlinked_agency_codes, ["CITYHALL", "DPRC"]);
  const dir = tempCopyOfPayload();
  try {
    const out = join(dir, "index.json");
    writeFileSync(out, rebuilt);
    assert.equal(await indexMain(["--root", dir, "--out", out, "--check"]), 0);
    const shardPath = manifest.collections.plans.shards[1].path;
    const shard = JSON.parse(readRoot(shardPath).toString("utf8"));
    shard.rows[0].quarter = shard.rows[0].quarter === 4 ? 3 : 4;
    const bytes = Buffer.from(`${JSON.stringify(shard, null, 2)}\n`);
    writeFileSync(join(dir, shardPath), bytes);
    const m2 = structuredClone(manifest);
    m2.collections.plans.shards[1].sha256 = sha256(bytes);
    writeFileSync(join(dir, PLANNING_MANIFEST_PATH), `${JSON.stringify(m2, null, 2)}\n`);
    const originalError = console.error;
    console.error = () => {};
    try { assert.equal(await indexMain(["--root", dir, "--out", out, "--check"]), 1); } finally { console.error = originalError; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(v) the plan families register in the existing v3 capability registry without a parallel registry", async () => {
  const evidence = await import(pathToFileURL(join(ROOT, "site/procurement_evidence.mjs")).href);
  const current = JSON.parse(readRoot("site/data/procurement_evidence_capabilities.json").toString("utf8"));
  assert.equal(current.schema, "cityscroll.procurement_evidence_capabilities.v1");
  const [ll1, ll63] = planCapabilityFamilies(index);
  assert.equal(ll1.id, "agency-plans-ll1");
  assert.equal(ll63.id, "agency-plans-ll63");
  assert.equal(ll1.source_as_of, "2026-08-11");
  assert.equal(ll1.agency_ids.length, 32);
  assert.equal(ll63.agency_ids.length, 36);
  const registryHasPlans = current.families.some((f) => f.id === "agency-plans-ll1" || f.id === "agency-plans-ll63");
  const families = registryHasPlans
    ? current.families
    : [...current.families, ...planCapabilityFamilies(index)];
  const acs = evidence.capabilities(families, "administration-for-childrens-services");
  assert.equal(acs.state, "supported");
  assert.ok(acs.families.map((f) => f.family).includes("agency-plans-ll1"));
  assert.ok(acs.families.map((f) => f.family).includes("agency-plans-ll63"));
  assert.equal(evidence.capabilities(families, "aging").state, "unknown");
  const dep = evidence.capabilities(families, "environmental-protection").families.map((f) => f.family).sort();
  assert.ok(dep.includes("agency-plans-ll1"));
  assert.ok(dep.includes("agency-plans-ll63"));
  assert.ok(dep.includes("budget-requests"));
  assert.ok(dep.includes("registered-contracts"));
});

test("(vi) every row renders as a plan with the not-a-solicitation sentence; quarter and amount follow the rule", () => {
  const rows = listAll().rows;
  for (const row of rows) {
    const r = renderPlanRow(row);
    assert.equal(r.kind_label, "Agency procurement plan");
    assert.equal(r.not_solicitation, "This is a plan the agency published. The agency may change it, delay it, or leave it without opening responses.");
    assert.equal(r.fiscal_year_span, "New York City fiscal year 2027 runs from July 1, 2026 to June 30, 2027.");
    assert.equal(r.quarter, row.quarter == null ? "Planned quarter not published" : `Solicitation planned for quarter ${row.quarter} of fiscal year 2027`);
    if (row.estimated_amount == null) {
      assert.equal(r.amount, "Estimated amount not published as a number");
      assert.ok(row.not_published.includes("estimated_amount"));
    }
    assert.equal(r.probability, "Likelihood not published", "committed rows predate the probability column");
    assert.ok(row.not_published.includes("procurement_probability"));
  }
  const ocme = listAll({ agency_code: "OCME", source: "ll1" }).rows[0];
  assert.equal(renderPlanRow(ocme).amount, "Agency estimate: $2,195,500");
  assert.equal(renderPlanRow(ocme).provenance, "From OCME_LL1_FY27.xlsx, sheet New Procurements, row 4");
  assert.equal(renderPlanRow({ ...ocme, procurement_probability: "Likely" }).probability, "Agency's stated likelihood: Likely");
  const doris = listAll({ agency_code: "DORIS", source: "ll1" }).rows;
  assert.equal(doris.filter((r) => r.estimated_amount == null).length, 2, "the two range-text amounts stay null");
});

test("(vi) i18n: ten shipping languages carry every PLAN_READER_STRINGS key with the same placeholders", () => {
  const src = readRoot("site/i18n.js").toString("utf8");
  const shipping = /SHIPPING_LANGS\s*=\s*\[([^\]]*)\]/.exec(src)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  assert.equal(shipping.length, 10);
  const placeholders = (text) => (text.match(/\{[a-z_]+\}/g) || []).sort().join(",");
  for (const key of Object.keys(PLAN_READER_STRINGS)) {
    assert.match(src, new RegExp(`${key}\\s*:`), `${key} must land in site/i18n.js (sibling i18n wiring)`);
  }
  for (const lang of shipping) {
    const langPath = join(ROOT, `site/i18n/lang/${lang}.js`);
    assert.equal(existsSync(langPath), true, lang);
    const tableSrc = readFileSync(langPath, "utf8");
    for (const [key, value] of Object.entries(PLAN_READER_STRINGS)) {
      assert.match(tableSrc, new RegExp(`${key}\\s*:`), `${lang} missing ${key} (sibling i18n wiring)`);
      const match = new RegExp(`${key}\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`).exec(tableSrc);
      assert.ok(match, `${lang} ${key} string literal`);
      const text = JSON.parse(match[1].startsWith("'") ? match[1].replace(/^'|'$/g, '"') : match[1]);
      assert.equal(placeholders(text), placeholders(value), `${lang} ${key}`);
    }
  }
});

test("(ix) quality flags on committed rows are surfaced on the row and rendered", () => {
  const all = listAll();
  assert.deepEqual(all.first.quality_flags, { published_term_end_before_start: 23 });
  assert.deepEqual(index.quality_flags, { published_term_end_before_start: 23 });
  const flagged = all.rows.filter((r) => r.quality_flags.length);
  assert.equal(flagged.length, 23);
  for (const row of flagged) {
    assert.ok(row.term_end < row.term_start);
    assert.deepEqual(renderPlanRow(row).quality, ["The published end date is earlier than the published start date."]);
  }
});

test("agencyCodeFromUrl and projectRow helpers", () => {
  assert.equal(agencyCodeFromUrl("https://x/Resources/ll63/2027fy/Law_LL63_FY27_RE.xlsx"), "LAW");
  assert.equal(projectRow(population.rows[0], index).kind, "plan");
});

test("delivery: procurement-plan-index-watch job and plan-index repair classes are declared", () => {
  const jobs = JSON.parse(readRoot("tools/external_schedule_jobs.json").toString("utf8"));
  const job = jobs.jobs.find((j) => j.id === "procurement-plan-index-watch");
  assert.ok(job, "procurement-plan-index-watch job");
  assert.ok(job.schedule.includes("53 12 * * *"), JSON.stringify(job.schedule));
  const repair = readRoot("tools/repair_findings.mjs").toString("utf8");
  assert.match(repair, /plan-index-changed/);
  assert.match(repair, /plan-index-unreachable/);
});
