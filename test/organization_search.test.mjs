// Organization search over the organization index: real organizations, invariants, close-spelling
// thresholds and the index build. The index is built in memory from the committed engine artifacts plus
// the real SBS and register fixture rows, so the test needs no network and no generated index.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { vendorStem } from "../entity_resolution/normalizers/vendor_stem.mjs";
import { vendorStem as siteVendorStem } from "../site/vendor_stem.mjs";
import { readEngineSources, sbsContributions, registerContributions } from "../tools/lib/organization_index_sources.mjs";
import { loadOrganizationNameWithholdings, sha256Hex } from "../tools/lib/organization_name_withholding.mjs";
import { buildIndex, checkFiles } from "../tools/lib/organization_index_build.mjs";
import { measureTypos } from "../tools/lib/organization_typo_measurement.mjs";
import {
  openOrganizationIndex, searchOrganizations, searchByFacets, facetAccounts, parseEntityRef, entityRef,
  MATCH_REASONS, LINK_LABELS, RESULT_KEYS,
} from "../site/organization_search.mjs";
import { assembleOrganizationRecord, withLiveStateRegister, BLOCK_KINDS, BLOCK_STATUSES } from "../site/organization_record.mjs";
import { buildDirectory } from "../warehouse/lib/sbs_certified_business_directory.mjs";
import { openSbsDirectory, getByAccount, filterBusinesses } from "../site/sbs_certified_business_lookup.mjs";
import { normalizeIrsRecord } from "../entity_resolution/registers/irs_eo_bmf.mjs";
import { normalizeDolRow, normalizeScaRows } from "../entity_resolution/registers/table_registers.mjs";
import { buildArtifact, loadArtifact } from "../entity_resolution/registers/register_index.mjs";
import { lookupDosByName, mapDosRow, DOS_RESOURCE_URL } from "../entity_resolution/registers/dos_entities.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");
const json = (p) => JSON.parse(read(p));
const sha = (b) => createHash("sha256").update(b).digest("hex");

// --- inputs: committed engine artifacts + real fixture rows -------------------------------------
const engine = readEngineSources(new URL(".", ROOT).pathname);
const sbsSample = json("test/fixtures/sbs_certified_businesses/sample-rows.json");
const sbsExtra = json("test/fixtures/organization_search/extra-sbs-rows.json").rows.map((r) => r.row);
const sbsMeta = json("test/fixtures/sbs_certified_businesses/fixture-manifest.json");
const sbsDir = buildDirectory([...sbsSample, ...sbsExtra], { collected_at: sbsMeta.collected_at, rows_updated_at: sbsMeta.rows_updated_at, publisher_row_count: sbsMeta.publisher_row_count });
const irsReceipt = json("test/fixtures/entity_registers/irs_eo_bmf_ny.receipt.json");
const irsExtra = json("test/fixtures/organization_search/extra-irs-rows.json");
const irs = [...json("test/fixtures/entity_registers/irs_eo_bmf_ny.sample.json").records,
  ...irsExtra.rows.map((r) => normalizeIrsRecord(r.values, { collected_at: irsReceipt.fetched_at, row_index: r.csv_row_index }))];
const dolReceipt = json("test/fixtures/entity_registers/dol_contractor_registry.receipt.json");
const dol = json("test/fixtures/entity_registers/dol_contractor_registry.sample.json").rows.map((r) => normalizeDolRow(r, { collected_at: dolReceipt.fetched_at }));
const scaReceipt = json("test/fixtures/entity_registers/sca_prequalified_firms.receipt.json");
const sca = normalizeScaRows(json("test/fixtures/entity_registers/sca_prequalified_firms.sample.json").rows, { collected_at: scaReceipt.fetched_at });
const sbs = sbsContributions(sbsDir.manifest, sbsDir.rows);
const contributions = [...engine.contributions, ...sbs.contributions, ...registerContributions(irs), ...registerContributions(dol), ...registerContributions(sca)];
const built = buildIndex(contributions, { built_from: "test", receipts: { ...engine.receipts, sbs_certified_businesses: sbs.receipt } });
const opened = await openOrganizationIndex(async (p) => JSON.parse(built.files.get(p)));

const sbsOpen = openSbsDirectory({
  manifest: JSON.parse(sbsDir.files.get("data/sbs_certified_businesses.json")),
  names: JSON.parse(sbsDir.files.get("data/sbs_certified_businesses/names.json")),
  facets: JSON.parse(sbsDir.files.get("data/sbs_certified_businesses/facets.json")),
  readShard: (p) => JSON.parse(sbsDir.files.get(p)),
});
const facetsDoc = JSON.parse(sbsDir.files.get("data/sbs_certified_businesses/facets.json"));
const regIndex = (register, records) => loadArtifact(buildArtifact({ register, collected_at: records[0].collected_at, source_url: records[0].source_url, records })).index;
const dosManifest = json("test/fixtures/entity_registers/dos/manifest.json");
const dosRecords = ["nonprofit_single", "llc_single", "exact_batch"].flatMap((id) => {
  const e = dosManifest.entries.find((x) => x.id === id);
  return JSON.parse(read(`test/fixtures/entity_registers/dos/${e.file.split("/").pop()}`)).map((row) => mapDosRow(row, { queried_at: `${dosManifest.recorded_on}T00:00:00Z` }));
});
const dosCommitted = loadArtifact(buildArtifact({ register: "ny_dos_entities", collected_at: `${dosManifest.recorded_on}T00:00:00Z`, source_url: DOS_RESOURCE_URL, records: dosRecords })).index;
const recordedRows = async (url) => {
  const e = dosManifest.entries.find((x) => x.url === url);
  if (!e) throw Object.assign(new Error("not recorded"), { upstream_status: 400 });
  const bytes = readFileSync(new URL(`test/fixtures/entity_registers/dos/${e.file.split("/").pop()}`, ROOT));
  assert.equal(sha(bytes), e.sha256);
  return JSON.parse(bytes);
};
const dbRows = json("site/data/doing_business_warehouse_lookup.json").rows;
const deps = {
  sbs: { directory: sbsOpen.directory, getByAccount },
  registers: { irs_eo_bmf_ny: regIndex("irs_eo_bmf_ny", irs), nys_dol_contractor_registry: regIndex("nys_dol_contractor_registry", dol), nyc_sca_prequalified_firms: regIndex("nyc_sca_prequalified_firms", sca) },
  doingBusiness: (stem) => dbRows.filter((r) => vendorStem(r.organization_name) === stem),
  dosCommitted,
  vendorProfile: async () => ({ status: "not_available", reason: "no KV in unit tests" }),
};
const search = (q, opts) => searchOrganizations(opened, q, { dosCommitted, ...opts });
const real = json("test/fixtures/organization_search/real-organizations.json");

test("the site vendorStem mirror equals the engine normalizer on every indexed name", () => {
  for (const c of contributions) assert.equal(siteVendorStem(c.name), vendorStem(c.name));
});

test("index build is deterministic and integrity-checked", () => {
  assert.equal(opened.status, "ok");
  assert.deepEqual(checkFiles((p) => built.files.get(p)), []);
  const again = buildIndex(contributions, { built_from: "test", receipts: { ...engine.receipts, sbs_certified_businesses: sbs.receipt } });
  for (const [p, t] of built.files) assert.equal(again.files.get(p), t, p);
  const changed = buildIndex(contributions.map((c, i) => (i === 0 ? { ...c, name: `${c.name} X` } : c)), {});
  assert.notEqual(changed.manifest.generation, built.manifest.generation);
});

for (const org of real.organizations.filter((o) => o.stem)) {
  test(`real organization ${org.case}: ${org.stem}`, async () => {
    for (const q of org.queries) {
      const r = await search(q.text);
      assert.equal(r.results[0]?.stem, q.expect_first, q.text);
      assert.equal(r.results[0].match_reason, q.match_reason, q.text);
      assert.deepEqual(r.results[0].sources.map((s) => s.source), org.sources, q.text);
    }
  });
}

test("refusals, no_match and not_indexed are distinct", async () => {
  assert.equal((await search("Zxqvbk Quillfeather Holdings")).status, "no_match");
  assert.equal((await search("ab")).reason, "input_too_short");
  assert.equal((await search("***")).reason, "input_has_no_letters_or_digits");
  assert.equal((await searchOrganizations(await openOrganizationIndex(async () => { throw new Error("404"); }), "Xerox")).status, "not_indexed");
  const outside = await search("dos:999999999");
  assert.equal(outside.status, "not_indexed");
  assert.equal(outside.on_demand, "/org-register/dos?dos_id=999999999");
});

test("results: closed reasons and keys, two link labels, no identity claim", async () => {
  for (const q of ["Cogent Infotech", "Learning Center", "Chinatown", "Electric", "New York", "Cogant Infotech"]) {
    const r = await search(q, { limit: 25 });
    for (const x of r.results) {
      assert.ok(MATCH_REASONS.includes(x.match_reason));
      assert.deepEqual(Object.keys(x).filter((k) => k !== "rank").sort(), [...RESULT_KEYS].sort());
      for (const l of x.links) assert.ok(LINK_LABELS.includes(l.label));
      assert.doesNotMatch(JSON.stringify(x), /same_organization|same_entity|merged/i);
    }
    assert.deepEqual(await search(q, { limit: 25 }), r);
  }
});

test("record blocks carry source, URL, record id and date; SBS block keeps every published field; state failure marks one block", async () => {
  const rec = await assembleOrganizationRecord(opened, "org:CHINATOWN MANPOWER PROJECT", deps);
  for (const b of rec.blocks) {
    assert.ok(BLOCK_KINDS.includes(b.block) && BLOCK_STATUSES.includes(b.status));
    assert.ok(b.source && b.source_url);
    if (b.status === "present") assert.ok(b.record_id && (b.collected_at || b.queried_at), b.block);
  }
  assert.equal(rec.blocks.find((b) => b.block === "irs_exempt_organization").record_id, "132755214");
  assert.equal(rec.blocks.find((b) => b.block === "state_register").record_id, "268736");
  const live = withLiveStateRegister(rec, await lookupDosByName(rec.display_name, { readRows: recordedRows }));
  assert.equal(live.blocks.find((b) => b.block === "state_register").status, "present");
  const failed = withLiveStateRegister(rec, await lookupDosByName(rec.display_name, { readRows: async () => { throw Object.assign(new Error("SODA 503"), { upstream_status: 503 }); } }));
  assert.deepEqual(failed.blocks.filter((b) => b.block === "state_register").map((b) => b.status), ["provider_unavailable"]);
  const cog = await assembleOrganizationRecord(opened, "org:COGENT INFOTECH", deps);
  const sb = cog.blocks.find((b) => b.block === "sbs_certified_business");
  for (const f of sbsDir.manifest.fields) assert.ok(f in sb.fields, f);
  const yo = await assembleOrganizationRecord(opened, entityRef("YO RE MI"), deps);
  assert.deepEqual(yo.blocks.filter((b) => b.block === "sbs_certified_business").map((b) => b.record_id), ["264546", "3857"]);
});

test("facets: same accounts as the SBS lookup", async () => {
  for (const c of [{ programme: "WBE" }, { naics6: "237310" }, { nigp: "91200", zip: "11590" }]) {
    const sib = filterBusinesses(sbsOpen.directory, c, { limit: 100000 });
    assert.deepEqual(facetAccounts(facetsDoc, c).accounts, sib.status === "found" ? sib.results.map((r) => r.account_number) : []);
  }
  assert.equal((await searchByFacets(opened, facetsDoc, { programme: "WBE" })).results[0].match_reason, "facet");
});

test("entityRef format", () => {
  assert.deepEqual(parseEntityRef("org:YO RE MI#sbs:3857"), { ok: true, stem: "YO RE MI", source_record: { kind: "sbs", id: "3857" } });
  assert.equal(parseEntityRef("org:Yo Re Mi").ok, false);
});

test("close spelling: recall@5 >= 0.99 and wrong-first <= 0.01 on 600 one-letter misspellings of 200 real names", async () => {
  const m = await measureTypos(opened);
  assert.equal(m.queries, 600);
  assert.ok(m.recall_at_5 >= 0.99, String(m.recall_at_5));
  assert.ok(m.wrong_first <= 0.01, String(m.wrong_first));
});

const WITHHELD_NOTE = "1 published record name is withheld for a privacy rule.";
const PLACEHOLDER_NAMES = ["Unknown", "Withheld", "Redacted"];

function syntheticSbsRow(fields) {
  return {
    account_number: "880001",
    vendor_formal_name: "NORTHWIND TRADING COMPANY",
    name_stem: "NORTHWIND TRADING",
    vendor_dba: null,
    dba_stem: null,
    zip: "10001",
    certification: ["MBE"],
    borough: "Manhattan",
    id6_digit_naics_code: "541611",
    nigp_codes: ["91800"],
    business_description: "published description stays",
    website: "https://example.test/northwind",
    address1: "1 Example Street",
    ...fields,
  };
}

function nameRulesFor(row) {
  return [
    {
      publisher: "nyc-open-data", dataset: "ci93-uc8s", account_number: String(row.account_number),
      field: "vendor_formal_name", value_sha256: sha256Hex(row.vendor_formal_name),
    },
    {
      publisher: "nyc-open-data", dataset: "ci93-uc8s", account_number: String(row.account_number),
      field: "name_stem", value_sha256: sha256Hex(row.name_stem),
    },
  ];
}

test("exact-record withholding omits one published name and keeps other fields", async () => {
  const manifest = { collected_at: "2026-01-01T00:00:00Z", rows_updated_at: "2026-01-01", content_sha256: "abc" };
  const row = syntheticSbsRow();
  const rules = nameRulesFor(row);
  const withheld = sbsContributions(manifest, [row], rules);
  assert.equal(withheld.withheld_published_names, 1);
  assert.equal(withheld.contributions.length, 1);
  assert.equal(withheld.contributions[0].name_withheld, true);
  assert.equal(withheld.contributions[0].name, "");
  assert.equal(withheld.contributions[0].index_key, "sbs:880001");
  assert.equal(withheld.contributions[0].ref, "880001");
  assert.equal(withheld.contributions[0].zip, "10001");

  const built = buildIndex(withheld.contributions, { withheld_published_names: withheld.withheld_published_names });
  assert.equal(built.manifest.withheld_published_names, 1);
  assert.deepEqual(built.manifest.notes, [WITHHELD_NOTE]);
  assert.equal(built.entries.length, 1);
  const entry = built.entries[0];
  assert.equal(entry.display_name, null);
  assert.equal(entry.name_withheld, true);
  assert.deepEqual(entry.names, []);
  assert.equal(entry.stem, "sbs:880001");
  assert.deepEqual(entry.ids.sbs, ["880001"]);
  assert.deepEqual(entry.sources.sbs_certified_businesses.zips, ["10001"]);
  const serialized = [...built.files.values()].join("\n");
  assert.equal(serialized.includes(row.vendor_formal_name), false);
  assert.equal(serialized.includes(row.name_stem), false);
  for (const bad of PLACEHOLDER_NAMES) assert.equal(serialized.includes(bad), false);

  const openedWithheld = await openOrganizationIndex(async (p) => JSON.parse(built.files.get(p)));
  assert.equal((await searchOrganizations(openedWithheld, row.vendor_formal_name)).status, "no_match");
  assert.equal((await searchOrganizations(openedWithheld, row.name_stem)).status, "no_match");
  const byAccount = await searchOrganizations(openedWithheld, "sbs:880001");
  assert.equal(byAccount.status, "matched");
  assert.equal(byAccount.results[0].display_name, null);
  assert.equal(byAccount.results[0].stem, "sbs:880001");
  assert.equal(byAccount.results[0].matched_text, "sbs:880001");
  assert.deepEqual(byAccount.results[0].names, []);
  assert.equal(parseEntityRef("org:sbs:880001").ok, true);
  assert.equal(parseEntityRef("org:sbs:880001").stem, "sbs:880001");

  const record = await assembleOrganizationRecord(openedWithheld, "org:sbs:880001", {
    sbs: {
      directory: null,
      getByAccount: () => ({
        status: "found",
        results: [{
          source_url: "https://data.cityofnewyork.us/d/ci93-uc8s",
          dataset_url: "https://data.cityofnewyork.us/d/ci93-uc8s",
          collected_at: "2026-01-01T00:00:00Z",
          rows_updated_at: "2026-01-01T00:00:00Z",
          row,
        }],
      }),
    },
    dosCommitted: { byStem: new Map(), byId: new Map() },
  });
  assert.equal(record.status, "found");
  assert.equal(record.display_name, null);
  assert.deepEqual(record.names, []);
  const sbsBlock = record.blocks.find((b) => b.block === "sbs_certified_business");
  assert.equal(Object.hasOwn(sbsBlock.fields, "vendor_formal_name"), false);
  assert.equal(Object.hasOwn(sbsBlock.fields, "name_stem"), false);
  assert.equal(sbsBlock.fields.account_number, "880001");
  assert.equal(sbsBlock.fields.zip, "10001");
  assert.equal(sbsBlock.fields.business_description, "published description stays");
  assert.equal(sbsBlock.fields.address1, "1 Example Street");
  const state = record.blocks.find((b) => b.block === "state_register");
  assert.equal(Object.hasOwn(state, "on_demand"), false);
  const recordText = JSON.stringify(record);
  assert.equal(recordText.includes(row.vendor_formal_name), false);
  assert.equal(recordText.includes(row.name_stem), false);
  for (const bad of PLACEHOLDER_NAMES) assert.equal(recordText.includes(bad), false);

  const otherAccount = sbsContributions(manifest, [syntheticSbsRow({ account_number: "880002" })], rules);
  assert.equal(otherAccount.withheld_published_names, 0);
  assert.equal(otherAccount.contributions[0].name, row.vendor_formal_name);
  assert.equal(otherAccount.contributions[0].name_withheld, false);

  const renamed = syntheticSbsRow({ vendor_formal_name: "NORTHWIND OTHER NAME", name_stem: "NORTHWIND OTHER" });
  const differentValue = sbsContributions(manifest, [renamed], rules);
  assert.equal(differentValue.withheld_published_names, 0);
  assert.equal(differentValue.contributions[0].name, "NORTHWIND OTHER NAME");

  const descriptionOnly = [{
    publisher: "nyc-open-data", dataset: "ci93-uc8s", account_number: "880001",
    field: "business_description", value_sha256: sha256Hex(row.business_description),
  }];
  const described = sbsContributions(manifest, [row], descriptionOnly);
  assert.equal(described.withheld_published_names, 0);
  assert.equal(described.contributions[0].name, row.vendor_formal_name);

  const dba = "NORTHWIND SUPPLY";
  const withDba = sbsContributions(manifest, [syntheticSbsRow({ vendor_dba: dba, dba_stem: vendorStem(dba) })], rules);
  assert.equal(withDba.withheld_published_names, 1);
  assert.equal(withDba.contributions.length, 1);
  assert.equal(withDba.contributions[0].name, dba);
  assert.equal(withDba.contributions[0].name_withheld, false);
  assert.equal(withDba.contributions[0].ref, "880001");
  assert.equal(withDba.contributions[0].zip, "10001");
  const builtDba = buildIndex(withDba.contributions, { withheld_published_names: withDba.withheld_published_names });
  const dbaText = [...builtDba.files.values()].join("\n");
  assert.equal(dbaText.includes(row.vendor_formal_name), false);
  assert.equal(dbaText.includes(dba), true);
  const openedDba = await openOrganizationIndex(async (p) => JSON.parse(builtDba.files.get(p)));
  const dbaHit = await searchOrganizations(openedDba, dba);
  assert.equal(dbaHit.results[0].stem, vendorStem(dba));
  assert.equal(dbaHit.results[0].display_name, dba);
  const byDbaAccount = await searchOrganizations(openedDba, "sbs:880001");
  assert.equal(byDbaAccount.results[0].stem, vendorStem(dba));

  const second = syntheticSbsRow({ account_number: "880003", vendor_formal_name: "CONTOSO FABRICATION", name_stem: "CONTOSO FABRICATION" });
  const two = sbsContributions(manifest, [row, second], [...rules, ...nameRulesFor(second)]);
  assert.equal(two.withheld_published_names, 2);
  const builtTwo = buildIndex(two.contributions, { withheld_published_names: two.withheld_published_names });
  assert.deepEqual(builtTwo.manifest.notes, ["2 published record names are withheld for a privacy rule."]);
  assert.equal(builtTwo.entries.filter((e) => e.name_withheld).length, 2);
});

function walkStrings(value, visit) {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const item of value) walkStrings(item, visit);
  else if (value && typeof value === "object") for (const item of Object.values(value)) walkStrings(item, visit);
}

test("committed organization index withholds one published record name", () => {
  const account = "387393";
  const rules = loadOrganizationNameWithholdings().filter((rule) => String(rule.account_number) === account && (rule.field === "vendor_formal_name" || rule.field === "name_stem"));
  assert.equal(rules.length, 2);
  const sbsManifest = json("site/data/sbs_certified_businesses.json");
  let row = null;
  for (const shard of sbsManifest.shards) {
    const found = json(`site/${shard.path}`).rows.find((candidate) => String(candidate.account_number) === account);
    if (found) { row = found; break; }
  }
  assert.ok(row);
  const banned = new Set([sha256Hex(row.vendor_formal_name), sha256Hex(row.name_stem)]);
  assert.equal(rules.some((rule) => rule.field === "vendor_formal_name" && rule.value_sha256 === sha256Hex(row.vendor_formal_name)), true);
  assert.equal(rules.some((rule) => rule.field === "name_stem" && rule.value_sha256 === sha256Hex(row.name_stem)), true);
  const indexManifest = json("site/data/organization_index.json");
  assert.equal(indexManifest.withheld_published_names, 1);
  assert.deepEqual(indexManifest.notes, [WITHHELD_NOTE]);
  const paths = [indexManifest.stems.path, ...indexManifest.entry_shards.map((shard) => shard.path), ...indexManifest.id_shards.map((shard) => shard.path)];
  let hashHits = 0;
  const flagged = [];
  for (const path of paths) {
    const doc = json(`site/${path}`);
    walkStrings(doc, (value) => { if (banned.has(sha256Hex(value))) hashHits += 1; });
    if (Array.isArray(doc.entries)) for (const candidate of doc.entries) if (candidate.w === 1) flagged.push(candidate);
  }
  assert.equal(hashHits, 0);
  assert.equal(flagged.length, 1);
  const entry = flagged[0];
  assert.equal(entry.s, `sbs:${account}`);
  assert.equal(Object.hasOwn(entry, "n"), false);
  assert.equal(Object.hasOwn(entry, "d"), false);
  assert.deepEqual(entry.x.sbs.i, [account]);
  assert.ok(entry.x.sbs.z.length > 0);
  const rendered = JSON.stringify(entry);
  assert.equal(rendered.includes(row.vendor_formal_name), false);
  assert.equal(rendered.includes(row.name_stem), false);
  for (const bad of PLACEHOLDER_NAMES) assert.equal(rendered.includes(bad), false);
  const stemRow = json(`site/${indexManifest.stems.path}`).stems.find((candidate) => candidate[0] === `sbs:${account}`);
  assert.equal(stemRow[2], 1);
});
