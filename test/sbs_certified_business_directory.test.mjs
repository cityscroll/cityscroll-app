// SBS Certified Business List directory (source contract sbs-certified-business-list).
// verify: node --test test/sbs_certified_business_directory.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { vendorStem } from "../entity_resolution/normalizers/vendor_stem.mjs";
import { vendorStem as siteVendorStem } from "../site/vendor_stem.mjs";
import { JOIN_GATE_TIERS, resolveJoinGateTier } from "../ontology/join_gate_policy.mjs";
import { publicPayloadFindings } from "../tools/lib/public_payload_integrity.mjs";
import { withTempDirSync } from "../tools/lib/with_temp_dir.mjs";
import {
  SBS_FIELDS, SBS_QUALITY_FLAGS, buildDirectory, MANIFEST_PATH, normalizeRow, pullAll, sha256Hex, verifyDirectoryFiles,
} from "../warehouse/lib/sbs_certified_business_directory.mjs";
import { filterBusinesses, findByDba, findByName, getByAccount, openSbsDirectory, shardPathsForAccounts } from "../site/sbs_certified_business_lookup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test/fixtures/sbs_certified_businesses");
const FIXTURE_LIMITS = Object.freeze({ max_rows: 50, max_bytes: 1024 * 1024, max_index_bytes: 512 * 1024 });
const TOOL = join(ROOT, "tools/build_sbs_certified_business_directory.mjs");
const J = (p) => JSON.parse(readFileSync(join(FIXTURES, p), "utf8"));
const rawRows = J("sample-rows.json");
const fixtureManifest = J("fixture-manifest.json");
const DIRROOT = join(FIXTURES, "directory");
const read = (p) => readFileSync(join(DIRROOT, p), "utf8");
const verifyDirectory = (root) => verifyDirectoryFiles((p) => readFileSync(join(root, p), "utf8"));
const fixtureBuild = () => buildDirectory(rawRows, { collected_at: fixtureManifest.collected_at, rows_updated_at: fixtureManifest.rows_updated_at, publisher_row_count: fixtureManifest.publisher_row_count }, FIXTURE_LIMITS);
function open(overrides = {}) {
  const manifest = JSON.parse(read(MANIFEST_PATH));
  const r = openSbsDirectory({
    manifest, names: JSON.parse(read(manifest.names.path)), facets: JSON.parse(read(manifest.facets.path)),
    readShard: (p) => JSON.parse(read(p)), ...overrides,
  });
  return r;
}
const opened = open();
assert.equal(opened.status, "ok", JSON.stringify(opened));
const dir = opened.directory;
const norm = rawRows.map(normalizeRow);
const byAcct = new Map(norm.map((r) => [r.account_number, r]));

// ---------------------------------------------------------------- (i) normalization
test("(i) every row is kept and every published field is present in the output", () => {
  assert.equal(SBS_FIELDS.length, 56);
  assert.equal(norm.length, rawRows.length);
  assert.equal(new Set(norm.map((r) => r.account_number)).size, rawRows.length);
  for (const raw of rawRows) for (const k of Object.keys(raw)) assert.ok(SBS_FIELDS.includes(k), `unknown published field ${k}`);
  for (const r of norm) for (const f of SBS_FIELDS) assert.ok(Object.hasOwn(r, f), `${r.account_number} missing ${f}`);
  // verbatim untouched fields survive byte for byte
  for (const raw of rawRows) {
    const r = byAcct.get(raw.account_number);
    for (const f of ["vendor_formal_name", "telephone", "address1", "website", "business_description", "bbl", "latitude"]) assert.equal(r[f], raw[f] ?? null);
  }
  const built = fixtureBuild();
  assert.equal(built.rows.length, rawRows.length);
  assert.equal(built.manifest.shards.reduce((n, s) => n + s.rows, 0), rawRows.length);
});

test("(i) zip is left-padded with the raw value kept", () => {
  const short = rawRows.filter((r) => (r.zip || "").length === 4);
  assert.ok(short.length >= 5, "fixture needs short-zip rows");
  for (const raw of short) {
    const r = byAcct.get(raw.account_number);
    assert.equal(r.zip, `0${raw.zip}`); assert.equal(r.zip_raw, raw.zip);
  }
  for (const st of ["NJ", "CT"]) assert.ok(short.some((r) => r.state === st), `short zip in ${st}`);
  assert.ok(rawRows.some((r) => r.state === "PA" && r.zip.length === 5), "PA rows present (the full pull has no PA short zip)");
  const three = rawRows.find((r) => (r.zip || "").length === 3);
  assert.equal(byAcct.get(three.account_number).zip, `00${three.zip}`);
  assert.ok(byAcct.get(three.account_number).quality_flags.includes("zip_padded_three_digits"));
  for (const raw of rawRows.filter((r) => (r.zip || "").length === 5)) assert.equal(byAcct.get(raw.account_number).zip, raw.zip);
});

test("(i) nigp_codes and certification split, dates and amounts parse, raw kept", () => {
  for (const raw of rawRows) {
    const r = byAcct.get(raw.account_number);
    assert.equal(r.nigp_codes_raw, raw.nigp_codes ?? null);
    assert.deepEqual(r.nigp_codes, raw.nigp_codes === undefined ? null : raw.nigp_codes.split("|").map((s) => s.trim()).filter(Boolean));
    assert.equal(r.certification_raw, raw.certification);
    assert.deepEqual(r.certification, [...new Set(raw.certification.split(",").map((s) => s.trim()))].sort());
    assert.equal(r.cert_renewal_date_raw, raw.cert_renewal_date ?? null);
  }
  const combos = new Set(rawRows.map((r) => r.certification));
  for (const c of ["MBE", "WBE", "MBE,WBE", "EBE", "LBE", "MBE,EBE", "WBE,EBE", "MBE,LBE", "MBE,WBE,EBE"]) assert.ok(combos.has(c), `fixture lacks certification ${c}`);
  const iso = rawRows.find((r) => /^\d{4}-\d\d-\d\dT00:00:00\.000$/.test(r.cert_renewal_date || ""));
  assert.deepEqual(byAcct.get(iso.account_number).cert_renewal_date, [iso.cert_renewal_date.slice(0, 10)]);
  const multi = rawRows.find((r) => (r.cert_renewal_date || "").split(";").length === 3);
  const parsed = byAcct.get(multi.account_number);
  assert.equal(parsed.cert_renewal_date.length, 3);
  assert.ok(parsed.cert_renewal_date.every((d) => /^\d{4}-\d\d-\d\d$/.test(d)));
  assert.ok(parsed.quality_flags.includes("multi_valued_date"));
  const [mm, dd, yy] = multi.cert_renewal_date.split(";")[0].split("/");
  assert.equal(parsed.cert_renewal_date[0], `${yy}-${mm}-${dd}`);
  const amt = rawRows.find((r) => r.aggregate_bonding_limit && Number(r.aggregate_bonding_limit) > 0);
  assert.equal(byAcct.get(amt.account_number).aggregate_bonding_limit, Number(amt.aggregate_bonding_limit));
  assert.equal(byAcct.get(amt.account_number).aggregate_bonding_limit_raw, amt.aggregate_bonding_limit);
  const e = rawRows.find((r) => r.date_of_establishment);
  assert.equal(byAcct.get(e.account_number).date_of_establishment, e.date_of_establishment.slice(0, 10));
  assert.equal(byAcct.get(e.account_number).date_of_establishment_raw, e.date_of_establishment);
});

test("(i) quality flags on every known-dirty fixture row, checked against independent predicates; clean rows carry none of them", () => {
  const checks = {
    name_error_token: (r) => /ERROR:|#NAME\?/.test(r.vendor_formal_name),
    multi_valued_date: (r) => (r.cert_renewal_date || "").includes(";"),
    website_is_email_address: (r) => (r.website || "").includes("@"),
    negative_amount: (r) => ["aggregate_bonding_limit", "largest_value_of_contract", "value_of_contract_job_exp_2", "value_of_contract_job_exp_3"].some((k) => r[k] !== undefined && Number(r[k]) < 0),
    date_out_of_range: (r) => ["date_of_establishment", "date_of_work_job_exp_1", "date_of_work_job_exp_2", "date_of_work_job_exp_3"].some((k) => r[k] && (Number(r[k].slice(0, 4)) > 2100 || Number(r[k].slice(0, 4)) < 1800)),
    phone_not_ten_digits: (r) => !/^\d{10}$/.test(r.telephone || ""),
    phone_placeholder: (r) => /^(\d)\1{9}$/.test(r.telephone || ""),
    zip_padded_three_digits: (r) => (r.zip || "").length === 3,
  };
  for (const [flag, pred] of Object.entries(checks)) {
    const dirty = rawRows.filter(pred);
    assert.ok(dirty.length >= 1, `fixture has a ${flag} row`);
    for (const raw of rawRows) assert.equal(byAcct.get(raw.account_number).quality_flags.includes(flag), pred(raw), `${flag} on ${raw.account_number}`);
  }
  for (const r of norm) for (const f of r.quality_flags) assert.ok(SBS_QUALITY_FLAGS.includes(f));
  const err = norm.find((r) => r.quality_flags.includes("name_error_token"));
  assert.equal(err.name_stem, null);
  assert.equal(err.vendor_formal_name, "ERROR: #NAME?");
  assert.ok(norm.some((r) => r.quality_flags.length === 0), "some rows are clean");
  assert.ok(dir.manifest.quality_flag_counts.name_error_token === 1);
});

// ---------------------------------------------------------------- (ii) population rule
test("(ii) positive canary by formal-name stem, another by DBA stem, a real absent organization, and the flagged row", () => {
  const stemCounts = new Map(); for (const r of norm) if (r.name_stem) stemCounts.set(r.name_stem, (stemCounts.get(r.name_stem) || 0) + 1);
  const canary = norm.find((r) => r.name_stem && stemCounts.get(r.name_stem) === 1 && /,?\s(Inc|LLC)\.?$/i.test(r.vendor_formal_name));
  const hit = findByName(dir, canary.vendor_formal_name);
  assert.equal(hit.status, "found");
  assert.equal(hit.results[0].account_number, canary.account_number);
  assert.equal(hit.results[0].matched_on, "name_stem");
  assert.equal(hit.results[0].source_url, `https://data.cityofnewyork.us/resource/ci93-uc8s.json?account_number=${canary.account_number}`);
  assert.equal(hit.results[0].collected_at, fixtureManifest.collected_at);
  assert.equal(hit.results[0].rows_updated_at, fixtureManifest.rows_updated_at);
  // a different spelling of the same name (case, punctuation, legal suffix) finds the same firm
  const variant = canary.vendor_formal_name.toUpperCase().replace(/[.,]/g, "").replace(/\s(INC|LLC)$/, "");
  assert.equal(findByName(dir, variant).results[0].account_number, canary.account_number);

  const dbaCounts = new Map(); for (const r of norm) if (r.dba_stem) dbaCounts.set(r.dba_stem, (dbaCounts.get(r.dba_stem) || 0) + 1);
  const dbaRow = norm.find((r) => r.dba_stem && dbaCounts.get(r.dba_stem) === 1);
  const dba = findByDba(dir, dbaRow.vendor_dba);
  assert.equal(dba.status, "found");
  assert.equal(dba.results[0].account_number, dbaRow.account_number);
  assert.equal(dba.results[0].matched_on, "dba_stem");

  for (const absent of ["Consolidated Edison Company of New York, Inc.", "Metropolitan Transportation Authority"]) {
    const miss = findByName(dir, absent);
    assert.equal(miss.status, "not_found");
    assert.deepEqual(miss.results, []);
    assert.equal(miss.population.row_count, rawRows.length);
    assert.notEqual(miss.status, "refused");
  }
  const flagged = findByName(dir, "ERROR: #NAME?");
  assert.equal(flagged.status, "not_found", "a spreadsheet error token never joins");
  assert.equal(getByAccount(dir, "99999999").status, "not_found");
  assert.equal(getByAccount(dir, "x1").status, "refused");
  assert.equal(findByName(dir, "   ").status, "refused");
});

test("(ii) a malformed or missing artifact is a refusal, never an empty success", () => {
  const manifest = JSON.parse(read(MANIFEST_PATH));
  const base = { manifest, names: JSON.parse(read(manifest.names.path)), facets: JSON.parse(read(manifest.facets.path)), readShard: (p) => JSON.parse(read(p)) };
  const refused = (o, code) => { const r = openSbsDirectory(o); assert.equal(r.status, "refused"); assert.equal(r.reason, code); assert.equal(r.results, undefined); };
  refused({}, "manifest_missing");
  refused({ ...base, manifest: { ...manifest, schema: "cityscroll.other.v1" } }, "manifest_schema");
  refused({ ...base, manifest: { ...manifest, row_count: manifest.row_count + 1 } }, "manifest_row_count");
  refused({ ...base, manifest: { ...manifest, collected_at: null } }, "manifest_freshness");
  refused({ ...base, names: null }, "names_invalid");
  refused({ ...base, facets: { schema: "x" } }, "facets_invalid");
  refused({ ...base, readShard: undefined }, "reader_missing");
  const target = norm.find((r) => r.name_stem);
  const q = (o) => findByName(openSbsDirectory({ ...base, ...o }).directory, target.vendor_formal_name);
  const shardOf = (a) => manifest.shards.find((s) => Number(a) >= Number(s.first_account) && Number(a) <= Number(s.last_account)).path;
  assert.equal(q({ readShard: () => undefined }).reason, "shard_missing");
  assert.equal(q({ readShard: () => { throw new Error("boom"); } }).reason, "shard_unreadable");
  assert.equal(q({ readShard: (p) => { const d = JSON.parse(read(p)); if (p === shardOf(target.account_number)) d.rows.splice(1, 1); return d; } }).reason, "shard_row_count");
  assert.equal(q({ readShard: (p) => ({ ...JSON.parse(read(p)), schema: "bad" }) }).reason, "shard_schema");
  const bad = structuredClone(base.names); bad.by_name_stem[target.name_stem] = ["999999999"];
  assert.equal(q({ names: bad }).reason, "index_points_outside_shards");
});

// ---------------------------------------------------------------- (iii) filters vs independent recounts
test("(iii) programme, NAICS, NIGP, borough and zip filters agree with independent recounts", () => {
  const accts = (res) => (res.status === "found" ? res.results.map((x) => x.account_number) : []).sort();
  const recount = (pred) => rawRows.filter(pred).map((r) => r.account_number).sort();
  const opts = { limit: 1000 };
  for (const p of ["MBE", "WBE", "EBE", "LBE"]) {
    assert.deepEqual(accts(filterBusinesses(dir, { programme: p }, opts)), recount((r) => r.certification.split(",").includes(p)), p);
  }
  assert.deepEqual(accts(filterBusinesses(dir, { programme: "mbe" }, opts)), recount((r) => r.certification.split(",").includes("MBE")));
  const n6 = rawRows.find((r) => r.id6_digit_naics_code).id6_digit_naics_code;
  assert.deepEqual(accts(filterBusinesses(dir, { naics6: n6 }, opts)), recount((r) => r.id6_digit_naics_code === n6));
  const sec = rawRows.find((r) => r.naics_sector).naics_sector;
  assert.deepEqual(accts(filterBusinesses(dir, { naics_sector: sec.toLowerCase() }, opts)), recount((r) => r.naics_sector === sec));
  const code = rawRows.find((r) => r.nigp_codes).nigp_codes.match(/\d+/)[0];
  assert.deepEqual(accts(filterBusinesses(dir, { nigp: code }, opts)), recount((r) => (r.nigp_codes || "").split("|").map((s) => s.trim()).includes(code)));
  for (const b of new Set(rawRows.map((r) => r.borough).filter(Boolean))) assert.deepEqual(accts(filterBusinesses(dir, { borough: b }, opts)), recount((r) => r.borough === b), b);
  const nj = rawRows.find((r) => r.state === "NJ" && r.zip.length === 4);
  assert.deepEqual(accts(filterBusinesses(dir, { zip: `0${nj.zip}` }, opts)), recount((r) => (r.zip.length === 4 ? `0${r.zip}` : r.zip) === `0${nj.zip}`));
  assert.deepEqual(accts(filterBusinesses(dir, { zip: nj.zip }, opts)), accts(filterBusinesses(dir, { zip: `0${nj.zip}` }, opts)));
  assert.deepEqual(accts(filterBusinesses(dir, { programme: "WBE", borough: "BROOKLYN" }, opts)), recount((r) => r.certification.split(",").includes("WBE") && r.borough === "BROOKLYN"));
  assert.equal(filterBusinesses(dir, { programme: "XYZ" }).status, "not_found");
  assert.equal(filterBusinesses(dir, {}).status, "refused");
  assert.equal(filterBusinesses(dir, { colour: "red" }).reason, "unknown_criterion");
  assert.equal(filterBusinesses(dir, { naics6: "12" }).reason, "invalid_naics6");
  const page = filterBusinesses(dir, { programme: "MBE" }, { limit: 5, offset: 2 });
  assert.equal(page.results.length, 5); assert.equal(page.total, recount((r) => r.certification.split(",").includes("MBE")).length);
});

// ---------------------------------------------------------------- (iv) shard / index integrity
test("(iv) every row is reachable by account and by stem; no duplicates; limits respected", () => {
  assert.deepEqual(verifyDirectory(DIRROOT), []);
  const m = dir.manifest;
  assert.ok(m.shards.length >= 3);
  const seen = new Set();
  for (const s of m.shards) {
    const doc = JSON.parse(read(s.path));
    assert.ok(doc.rows.length <= m.shard_contract.max_rows && s.bytes <= m.shard_contract.max_bytes);
    for (const r of doc.rows) { assert.ok(!seen.has(r.account_number), "duplicate across shards"); seen.add(r.account_number); }
  }
  for (let i = 1; i < m.shards.length; i += 1) assert.ok(Number(m.shards[i].first_account) > Number(m.shards[i - 1].last_account));
  assert.equal(seen.size, rawRows.length);
  for (const r of norm) {
    const g = getByAccount(dir, r.account_number);
    assert.equal(g.status, "found", r.account_number);
    assert.equal(g.results[0].row.account_number, r.account_number);
    if (r.name_stem) assert.ok(findByName(dir, r.vendor_formal_name).results.some((x) => x.account_number === r.account_number));
    if (r.dba_stem) assert.ok(findByDba(dir, r.vendor_dba).results.some((x) => x.account_number === r.account_number));
  }
  for (const list of [...Object.values(dir.names.by_name_stem), ...Object.values(dir.names.by_dba_stem), ...Object.values(dir.facets).flatMap((g) => Object.values(g))]) for (const a of list) assert.ok(seen.has(a), `index names unknown account ${a}`);
  assert.deepEqual(shardPathsForAccounts(dir, [norm[0].account_number, norm.at(-1).account_number]).length, 2);
  // full-size limits on a larger synthetic set built from real rows with distinct accounts
  const big = []; for (let k = 0; k < 45; k += 1) for (const r of rawRows) big.push({ ...r, account_number: String(Number(r.account_number) + k * 1000000) });
  const b = buildDirectory(big, { collected_at: "2026-11-11T00:00:00Z", rows_updated_at: "2026-11-10T00:00:00Z", publisher_row_count: big.length });
  assert.equal(b.manifest.row_count, big.length);
  assert.ok(b.manifest.shards.length >= 9);
  for (const s of b.manifest.shards) assert.ok(s.rows <= 1000 && s.bytes <= 6 * 1024 * 1024);
  const tight = buildDirectory(rawRows, { collected_at: "x", rows_updated_at: "y", publisher_row_count: rawRows.length }, { max_rows: 1000, max_bytes: 120000, max_index_bytes: 2 * 1024 * 1024 });
  assert.ok(tight.manifest.shards.length >= 3 && tight.manifest.shards.every((s) => s.bytes <= 120000), "the byte limit splits shards before the row limit does");
  assert.throws(() => buildDirectory([...rawRows, rawRows[0]], { collected_at: "x", rows_updated_at: "y", publisher_row_count: 1 }), /duplicate account_number/);
});

// ---------------------------------------------------------------- (v) --check
test("(v) --check passes the committed artifact and detects a one-row change", () => {
  const run = (...a) => spawnSync(process.execPath, [TOOL, ...a], { encoding: "utf8" });
  const ok = run("--check"); assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(verifyDirectory(DIRROOT), []);
  withTempDirSync("sbs-check", (tmp) => {
    mkdirSync(join(tmp, "data"), { recursive: true });
    cpSync(join(ROOT, "site/data/sbs_certified_businesses"), join(tmp, "data/sbs_certified_businesses"), { recursive: true });
    cpSync(join(ROOT, "site/data/sbs_certified_businesses.json"), join(tmp, "data/sbs_certified_businesses.json"));
    assert.equal(run("--check", "--site-dir", tmp).status, 0);
    const manifest = JSON.parse(readFileSync(join(tmp, MANIFEST_PATH), "utf8"));
    const shardPath = join(tmp, manifest.shards[1].path);
    const text = readFileSync(shardPath, "utf8");
    const changed = text.replace(/"telephone":"(\d)/, (m, d) => `"telephone":"${(Number(d) + 1) % 10}`);
    assert.notEqual(changed, text); writeFileSync(shardPath, changed);
    const bad = run("--check", "--site-dir", tmp);
    assert.equal(bad.status, 1); assert.match(bad.stderr, /sha256 differs/);
  });
  const rows = structuredClone(rawRows); rows[10].telephone = "0000000000";
  const b = buildDirectory(rows, { collected_at: fixtureManifest.collected_at, rows_updated_at: fixtureManifest.rows_updated_at, publisher_row_count: rows.length }, FIXTURE_LIMITS);
  const diff = [...b.files].filter(([p, t]) => read(p) !== t).map(([p]) => p);
  assert.ok(diff.length >= 1 && diff.includes(MANIFEST_PATH));
  withTempDirSync("sbs-fixture", (out) => {
    assert.equal(run("--fixture", "--out", out).status, 0);
    for (const [p, t] of fixtureBuild().files) assert.equal(readFileSync(join(out, p), "utf8"), t, `fixture rebuild differs at ${p}`);
  });
});

test("(v) the pull refuses a short or duplicated source instead of publishing it", async () => {
  const page = (n, start) => Array.from({ length: n }, (_, i) => ({ account_number: String(start + i) }));
  const mk = (rows, count) => async (url) => {
    const body = url.includes("api/views") ? { rowsUpdatedAt: 1794321558 } : url.includes("$select") ? [{ count: String(count) }] : rows.splice(0, 2000);
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer };
  };
  const good = await pullAll({ fetchImpl: mk(page(2500, 1), 2500), sleep: async () => {} });
  assert.equal(good.rows.length, 2500); assert.equal(good.requests.length, 4); assert.equal(good.rowsUpdatedAt, "2026-11-10T14:39:18.000Z");
  await assert.rejects(pullAll({ fetchImpl: mk(page(2500, 1), 2600), sleep: async () => {} }), /incomplete/);
  await assert.rejects(pullAll({ fetchImpl: mk([...page(1000, 1), ...page(1000, 1)], 2000), sleep: async () => {} }), /not unique/);
  const sleeps = []; await pullAll({ fetchImpl: mk(page(10, 1), 10), sleep: async (ms) => sleeps.push(ms) });
  assert.ok(sleeps.length >= 2 && sleeps.every((ms) => ms >= 1000), "Crawl-delay 1 honoured between requests");
});


// ---------------------------------------------------------------- (vi) stems come from the engine function
test("(vi) name_stem and dba_stem are the engine vendor_stem, and the site mirror agrees", () => {
  const names = rawRows.flatMap((r) => [r.vendor_formal_name, r.vendor_dba]).filter(Boolean);
  names.push("", null, undefined, "<b>Acme</b> Co.", "O\u2019Brien & Sons, L.L.C.", "Foo Inc. Inc.", "X INC", "A OF NEW YORK");
  for (const n of names) assert.equal(siteVendorStem(n), vendorStem(n), String(n));
  for (const r of norm) {
    if (r.name_stem !== null) assert.equal(r.name_stem, vendorStem(r.vendor_formal_name));
    if (r.dba_stem !== null) assert.equal(r.dba_stem, vendorStem(r.vendor_dba));
  }
});

// ---------------------------------------------------------------- (vii) contract join measurement
test("(vii) the registered join measurement is internally consistent and gates out an automatic link", async () => {
  const contract = JSON.parse(readFileSync(join(ROOT, "site/data/source_contracts.json"), "utf8")).contracts.find((c) => c.id === "sbs-certified-business-list");
  const jm = contract.join_measurement;
  for (const rate of Object.values(jm.rates)) assert.equal(rate.rate, Number((rate.joined / rate.total).toFixed(4)));
  const s = jm.precision_sample;
  assert.equal(s.same + s.different + s.cannot_tell, s.size);
  const tier = resolveJoinGateTier({ usefulness: jm.rates.firms_by_formal_name_stem.rate, precision: s.same / s.size });
  assert.equal(tier.materialize, false);
  assert.ok(JOIN_GATE_TIERS.some((t) => t.id === tier.tier));
  assert.equal(contract.health_policy.public_visibility, "backstage-only");
  assert.equal(contract.freshness_contract.mode, "periodic");
});

test("fixture provenance and the engine public-payload gate", () => {
  assert.equal(sha256Hex(readFileSync(join(FIXTURES, "sample-rows.json"))), fixtureManifest.selection.sha256);
  assert.equal(fixtureManifest.selection.rows, rawRows.length);
  const receipt = J("full-pull-receipt.json");
  assert.equal(receipt.row_count, receipt.distinct_accounts);
  assert.equal(readdirSync(join(DIRROOT, "data/sbs_certified_businesses")).filter((f) => f.startsWith("rows-")).length, dir.manifest.shards.length);
  const placeholder = rawRows.filter((r) => r.telephone === "5555555555");
  assert.ok(placeholder.length >= 1);
  assert.deepEqual(publicPayloadFindings(placeholder, { source: "site/data/sbs_certified_businesses/rows-000.json" }), []);
  assert.ok(publicPayloadFindings(placeholder, { source: "site/data/other_lookup/rows-000.json" }).length >= 1);
});

test("the committed site artifact is populated, unique and fresh in shape (population properties only)", () => {
  const m = JSON.parse(readFileSync(join(ROOT, "site/data/sbs_certified_businesses.json"), "utf8"));
  assert.equal(m.schema, "cityscroll.sbs_certified_businesses.v1");
  assert.ok(m.row_count >= 10000 && m.distinct_accounts === m.row_count && m.row_count === m.publisher_row_count);
  assert.ok(m.facets.groups.programme >= 2 && m.names.name_stems > 10000);
  assert.ok(Date.parse(m.collected_at) >= Date.parse(m.rows_updated_at));
  for (const s of m.shards) assert.ok(s.bytes <= m.shard_contract.max_bytes && s.rows <= m.shard_contract.max_rows);
  assert.equal(SBS_FIELDS.length, 56); assert.ok(SBS_QUALITY_FLAGS.length >= 10);
});

// sbs-certified-business-list
