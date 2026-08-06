// Characterization tests for the depot join graph + post-ingest re-derivation.
// Field case: PASSPort landing (predicted high-risk vs realized 78% either-source),
// EPIN entering the graph, EPIN/contract_id × Checkbook as a newly-feasible candidate.
//
//   node --test test/depot_rederive.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SCHEMA_VERSION,
  canonicalizeJoinKey,
  checkDepotFreshness,
  loadGapTaxonomy,
  loadSourceContracts,
  rankObtainableCatalogCandidates,
  rederiveDepot,
  renderGapTaxonomyDocument,
  resolveSourceId,
} from "../tools/depot.mjs";
import { buildCatalogSweepReceipt } from "../tools/depot_catalog_sweep.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("canonicalizeJoinKey maps PIN/EPIN/contract_id aliases", () => {
  assert.equal(canonicalizeJoinKey("prime_pin"), "PIN");
  assert.equal(canonicalizeJoinKey("pin"), "PIN");
  assert.equal(canonicalizeJoinKey("EPIN"), "EPIN");
  assert.equal(canonicalizeJoinKey("epin"), "EPIN");
  assert.equal(canonicalizeJoinKey("prime_contract_id"), "contract_id");
  assert.equal(canonicalizeJoinKey("CT contract id"), "contract_id");
  assert.equal(canonicalizeJoinKey("exam_number"), "exam_number");
  assert.equal(canonicalizeJoinKey("bbl"), "BBL");
  assert.equal(canonicalizeJoinKey("matter file"), "matter_id");
});

test("committed depot registry is schema v2 with join graph", () => {
  const registry = loadGapTaxonomy();
  assert.equal(registry.schema_version, SCHEMA_VERSION);
  assert.ok(Array.isArray(registry.sources) && registry.sources.length >= 10);
  assert.ok(Array.isArray(registry.crosswalks) && registry.crosswalks.length >= 5);
  assert.ok(registry.depot_refresh?.source_contracts_fingerprint);

  for (const src of registry.sources) {
    assert.ok(src.id, "source id");
    assert.ok(Array.isArray(src.join_keys), src.id);
  }
  for (const cw of registry.crosswalks) {
    assert.ok(cw.id && cw.source_a && cw.source_b, cw.id);
    assert.ok(["materialized", "candidate"].includes(cw.status), cw.id);
    assert.ok(Array.isArray(cw.key_path) && cw.key_path.length >= 1, cw.id);
    if (cw.status === "candidate") {
      assert.ok(["yes", "maybe", "no"].includes(cw.worth_materializing), cw.id);
    }
  }
  assert.equal(
    registry.sources.some((source) => source.id === "recent-contract-awards-ocp"),
    false,
    "the legacy duplicate OCP identity is removed",
  );
  for (const id of ["ocp-recent-contract-awards", "zap-projects", "zap-bbl"]) {
    assert.equal(registry.sources.find((source) => source.id === id)?.status, "landed");
  }
});

test("PASSPort field case: predicted high-risk vs realized 78%, EPIN in graph", () => {
  const registry = loadGapTaxonomy();
  const contracts = registry.sources.find((s) => s.id === "passport-public-contracts");
  const rfx = registry.sources.find((s) => s.id === "passport-public-rfx");
  assert.ok(contracts, "passport-public-contracts source");
  assert.ok(rfx, "passport-public-rfx source");

  assert.equal(contracts.join_coverage?.predicted?.grade, "high-risk");
  assert.equal(rfx.join_coverage?.predicted?.grade, "high-risk");
  assert.ok(contracts.join_keys.includes("EPIN"), "EPIN on contracts source");
  assert.ok(rfx.join_keys.includes("EPIN"), "EPIN on rfx source");
  assert.ok(contracts.join_keys.includes("contract_id"), "contract_id on passport contracts");

  // Realized either-source headline lives on rfx measurement (either_contracts_or_rfx)
  const either = rfx.join_coverage?.realized;
  assert.ok(either, "realized coverage on passport rfx");
  assert.equal(either.metric, "either_contracts_or_rfx");
  assert.equal(either.rate, 0.78);
  assert.equal(either.joined, 5660);
  assert.equal(either.total, 7254);

  // Contracts side keeps its own all_notices_to_contracts rate
  assert.equal(contracts.join_coverage?.realized?.rate, 0.74);

  // PASSPort is retained in the source graph, but its landed collector is no
  // longer presented as future acquisition work.
  const passportRank = registry.ranked_ingest_list.find((r) => /PASSPort/i.test(r.source));
  assert.equal(passportRank, undefined);
});

test("newly-feasible pair: passport contract_id × checkbook is enumerated", () => {
  const registry = loadGapTaxonomy();
  const candidates = registry.crosswalks.filter((c) => c.status === "candidate");
  const passportCheckbook = candidates.filter((c) => {
    const pair = `${c.source_a}|${c.source_b}`;
    return pair.includes("passport-public") && pair.includes("checkbook");
  });
  assert.ok(passportCheckbook.length >= 1, "at least one passport×checkbook candidate");

  // Expected example: shared contract_id (CT id) and/or PIN between
  // passport-public-contracts and checkbook-contracts
  const direct = passportCheckbook.find((c) => (
    (c.source_a === "passport-public-contracts" || c.source_b === "passport-public-contracts")
    && (c.source_a === "checkbook-contracts" || c.source_b === "checkbook-contracts")
    && c.key_path.includes("contract_id")
  ));
  assert.ok(direct, "passport contracts × checkbook contracts via contract_id");
  assert.equal(direct.worth_materializing, "yes");
  assert.ok(direct.score >= 1);
  assert.ok(
    (direct.gaps_would_close || []).some((g) => g.startsWith("procurement-")),
    "candidate scores procurement gaps",
  );
});

test("materialized crosswalks include city-record PIN × passport EPIN with coverage", () => {
  const registry = loadGapTaxonomy();
  const mat = registry.crosswalks.filter((c) => c.status === "materialized");
  const pinEpin = mat.find((c) => c.id === "city-record-pin-x-passport-contracts-epin");
  assert.ok(pinEpin);
  assert.deepEqual(pinEpin.key_path, ["PIN", "EPIN"]);
  assert.ok(pinEpin.realized_coverage?.rate >= 0.3);
  assert.equal(pinEpin.lineage?.code, "worker/src/lib/passport_join.mjs");
});

test("re-derivation is deterministic and --check passes on committed registry", () => {
  const registry = loadGapTaxonomy();
  const sourceContracts = loadSourceContracts();
  const a = rederiveDepot(registry, sourceContracts, { observedOn: "2026-07-30" });
  const b = rederiveDepot(registry, sourceContracts, { observedOn: "2026-07-30" });
  assert.equal(JSON.stringify(a.registry.sources), JSON.stringify(b.registry.sources));
  assert.equal(JSON.stringify(a.registry.crosswalks), JSON.stringify(b.registry.crosswalks));
  assert.equal(a.receipt.registry_sha256, b.receipt.registry_sha256);

  const check = checkDepotFreshness(registry, sourceContracts, { observedOn: "2026-07-30" });
  assert.equal(check.ok, true, check.mismatches?.join("; "));
});

test("re-derivation preserves partnership-blocked wishlist sources", () => {
  const registry = loadGapTaxonomy();
  const sourceContracts = loadSourceContracts();
  const { registry: next } = rederiveDepot(registry, sourceContracts, { observedOn: "2026-08-05" });
  assert.deepEqual(next.partnership_blocked_sources, registry.partnership_blocked_sources);
  assert.ok(next.partnership_blocked_sources.some((source) => source.wishlist_gap_id === "money-location-residual"));
});

test("drift gate fails when realized coverage is stripped from a landed source", () => {
  const registry = structuredClone(loadGapTaxonomy());
  const sourceContracts = loadSourceContracts();
  const passport = registry.sources.find((s) => s.id === "passport-public-rfx");
  assert.ok(passport?.join_coverage?.realized);
  delete passport.join_coverage.realized;

  const check = checkDepotFreshness(registry, sourceContracts, { observedOn: "2026-07-30" });
  assert.equal(check.ok, false);
  assert.ok(check.mismatches.some((m) => /sources: stale/.test(m)));
});

test("class change is flagged loudly when a not_published gap becomes derivable", () => {
  const registry = structuredClone(loadGapTaxonomy());
  const sourceContracts = loadSourceContracts();

  // Inject a synthetic class-b gap that names a landed public source with join keys
  registry.gaps.push({
    id: "synthetic-derivable-pending",
    surface: "test · synthetic",
    class: "not_published",
    would_appear_in: "PASSPort Public contracts if released",
    public_source: {
      name: "PASSPort Public contracts",
      join_keys: ["EPIN", "PIN"],
      landing_page: "https://a0333-passportpublic.nyc.gov/contracts.html",
    },
    evidence: "Synthetic fixture for class-change detection.",
  });

  const { registry: next, receipt } = rederiveDepot(registry, sourceContracts, {
    observedOn: "2026-07-30",
  });
  const changed = next.gaps.find((g) => g.id === "synthetic-derivable-pending");
  assert.equal(changed.class, "not_yet_ingested");
  assert.ok(changed.class_change);
  assert.equal(changed.class_change.from, "not_published");
  assert.ok(receipt.class_changes_loud.some((line) => /CLASS CHANGE/.test(line)));
  assert.ok(receipt.class_changes.some((c) => c.gap_id === "synthetic-derivable-pending"));
});

test("direction page generator renders join graph fields and degrades cleanly", () => {
  const registry = loadGapTaxonomy();
  const doc = renderGapTaxonomyDocument(registry);
  assert.match(doc, /Generated by tools\/depot_rederive\.mjs/);
  assert.match(doc, /Join graph \(sources\)/);
  assert.match(doc, /Materialized crosswalks/);
  assert.match(doc, /Candidate crosswalks/);
  assert.match(doc, /passport-public-contracts/);
  assert.match(doc, /EPIN/);
  assert.match(doc, /0\.78|78%/);
  assert.match(doc, /high-risk/);
  assert.match(doc, /mermaid/);
  assert.match(doc, /worth materializing/i);

  // Empty/minimal registry still renders without throw
  const minimal = renderGapTaxonomyDocument({
    schema_version: 2,
    gaps: [],
    sources: [],
    crosswalks: [],
    ranked_ingest_list: [],
    doctrine: {},
  });
  assert.match(minimal, /Lifecycle gap taxonomy/);
  assert.match(minimal, /Join graph/);
});

test("committed direction page matches generator output", () => {
  const registry = loadGapTaxonomy();
  const expected = renderGapTaxonomyDocument(registry);
  const actual = readFileSync(join(ROOT, "docs", "gap-taxonomy.md"), "utf8");
  assert.equal(actual, expected.endsWith("\n") ? expected : `${expected}\n`);
});

test("receipt records passport field case and checkbook candidates", () => {
  const receiptPath = join(ROOT, "site", "data", "depot_receipts", "latest.json");
  assert.ok(existsSync(receiptPath), "latest receipt exists");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.kind, "depot_rederive");
  assert.equal(receipt.passport_field_case.predicted_grade, "high-risk");
  assert.equal(receipt.passport_field_case.realized_either_rate, 0.78);
  assert.equal(receipt.passport_field_case.epin_in_graph, true);
  assert.ok(receipt.passport_field_case.passport_checkbook_candidates.length >= 1);
});

test("CI workflow runs depot drift gate without cron", () => {
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /depot_rederive\.mjs --check/);
  // Gauge-fired on PR/push paths — never a scheduled cron for re-derivation
  assert.doesNotMatch(ci, /depot_rederive[\s\S]*cron:/);
  const live = readFileSync(join(ROOT, ".github", "workflows", "source-contracts-live.yml"), "utf8");
  assert.doesNotMatch(live, /depot_rederive/);
});

test("resolveSourceId maps PASSPort and Checkbook names", () => {
  const contracts = new Map([
    ["passport-public-contracts", { id: "passport-public-contracts", name: "PASSPort Public contracts" }],
    ["checkbook-contracts", { id: "checkbook-contracts", name: "Checkbook NYC registered contracts" }],
  ]);
  assert.equal(resolveSourceId("PASSPort Public contracts", contracts), "passport-public-contracts");
  assert.equal(resolveSourceId("Checkbook NYC Contracts", contracts), "checkbook-contracts");
});

test("catalog ranking surfaces obtainable key spaces without committed source rows", () => {
  const rows = [
    {
      resource: {
        id: "a9md-ynri",
        name: "Civil Service List Certification",
        columns_field_name: ["exam_no", "list_title_code", "list_title_desc", "list_agency_code"],
      },
    },
    {
      resource: {
        id: "kpav-sd4t",
        name: "Jobs NYC Postings",
        columns_field_name: ["agency", "civil_service_title", "title_classification", "title_code_no"],
      },
    },
  ];
  const registry = loadGapTaxonomy();
  const ranked = rankObtainableCatalogCandidates(rows, { sources: registry.sources });
  assert.deepEqual(ranked.map((row) => row.dataset_id), ["a9md-ynri", "kpav-sd4t"]);
  assert.ok(ranked.every((row) => row.candidate_status === "candidate"));
  assert.ok(ranked.every((row) => row.coverage_status === "unknown_until_reviewed"));
  assert.ok(ranked[0].key_spaces.some((space) => space.id === "exam_number"));
  assert.ok(ranked[1].key_spaces.some((space) => space.id === "civil_service_title_code"));
  assert.ok(ranked[0].obtainable_key_space_score > 0);
  assert.ok(ranked[1].obtainable_key_space_score > 0);
});

test("catalog sweep receipt labels validation datasets as candidates, not facts", () => {
  const receipt = buildCatalogSweepReceipt({
    resultSetSize: 2,
    results: [
      { resource: { id: "a9md-ynri", name: "Civil Service List Certification", columns_field_name: ["exam_no", "list_agency_code"] } },
      { resource: { id: "kpav-sd4t", name: "Jobs NYC Postings", columns_field_name: ["agency", "civil_service_title", "title_code_no"] } },
    ],
  }, { sources: [] }, { observedOn: "2026-08-06" });
  assert.equal(receipt.observed_on, "2026-08-06");
  assert.deepEqual(receipt.validation.map((row) => row.surfaced), [true, true]);
  assert.match(receipt.ranking.coverage_policy, /unknown until reviewed/i);
  assert.ok(receipt.top_candidates.every((row) => row.candidate_status === "candidate"));
  assert.ok(receipt.top_candidates.every((row) => /metadata only/i.test(row.evidence)));
});
