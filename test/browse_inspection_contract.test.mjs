import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";

import {
  BROWSE_CLASSIFICATIONS,
  BROWSE_DETAIL_HOSTS,
  BROWSE_INSPECTION_CATALOG_SCHEMA,
  BROWSE_INSPECTION_CONTRACT_ID,
  BROWSE_INSPECTION_JOURNEY,
  BROWSE_INSPECTION_LEGACY_BASELINE,
  BROWSE_INSPECTION_PRINCIPLES,
  BROWSE_INSPECTION_SURFACES,
  BROWSE_PRIMARY_INTENTS,
  COMPACT_CALENDAR_HOST_IDS,
  acceptDirectoryNavigationFixture,
  browseInspectionCatalogProjection,
  mutateBrowseInspectionContract,
  validateBrowseInspectionContract,
  validateMutatedBrowseInspection,
} from "../site/browse_inspection_contract.mjs";

const ROOT = process.cwd();
const CATALOG_PATH = join("test", "standards", "browse_inspection_catalog.json");
const ADR_PATH = join("docs", "adr", "browse-inspection-continuity.md");
const EVIDENCE_PATH = join("docs", "evidence", "browse-inspection-contract", "acceptance-manifest.json");
const ARCHITECTURE_PATH = join("docs", "architecture.md");
const DESIGN_PATH = join("docs", "design-principles-contextual-ux.md");

function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

function sourceTextsForBaseline(baseline = BROWSE_INSPECTION_LEGACY_BASELINE) {
  const texts = {};
  for (const entry of baseline) {
    texts[entry.path] = read(entry.path);
  }
  return texts;
}

test("A1: contract principles cover overview through accessibility", () => {
  for (const key of [
    "overview",
    "useful_inspection",
    "explicit_navigation_and_actions",
    "coherent_restoration",
    "identity",
    "failure",
    "accessibility",
  ]) {
    assert.equal(typeof BROWSE_INSPECTION_PRINCIPLES[key], "string");
    assert.ok(BROWSE_INSPECTION_PRINCIPLES[key].length > 40, key);
  }
});

test("A1: every audited family and all eight compact-calendar hosts are classified", () => {
  const byId = new Map(BROWSE_INSPECTION_SURFACES.map((row) => [row.surface_id, row]));
  for (const id of [
    "now-calendar",
    "now-cards",
    "contracts-money-list",
    "board-land-positions",
    "search-results",
    "near-you-records",
    "near-you-scope",
    "land-map-selection",
  ]) {
    assert.ok(byId.has(id), id);
    assert.ok(BROWSE_CLASSIFICATIONS.includes(byId.get(id).classification), id);
  }
  assert.equal(COMPACT_CALENDAR_HOST_IDS.length, 8);
  for (const hostId of COMPACT_CALENDAR_HOST_IDS) {
    const host = byId.get(hostId);
    assert.ok(host, hostId);
    assert.equal(host.kind, "compact_calendar_host");
    assert.ok(BROWSE_PRIMARY_INTENTS.includes(host.primary_intent));
    assert.ok(BROWSE_DETAIL_HOSTS.includes(host.detail_host));
    assert.ok(host.domain_adapter.startsWith("site/"));
    assert.ok(host.render_owner.startsWith("site/"));
    assert.ok(host.journey_owner.startsWith("test/"));
    assert.ok(host.restoration_adapter);
    assert.ok(host.canonical_destination_policy);
  }
});

test("A1: each surface declares intent, adapter, canonical link, host, restoration, and journey ownership", () => {
  for (const surface of BROWSE_INSPECTION_SURFACES) {
    assert.ok(BROWSE_PRIMARY_INTENTS.includes(surface.primary_intent), surface.surface_id);
    assert.ok(surface.domain_adapter, surface.surface_id);
    assert.ok(surface.canonical_destination_policy, surface.surface_id);
    assert.ok(BROWSE_DETAIL_HOSTS.includes(surface.detail_host), surface.surface_id);
    assert.ok(surface.journey_owner, surface.surface_id);
    if (surface.classification === "directory_navigation") {
      assert.equal(surface.restoration_adapter, null);
    } else {
      assert.ok(surface.restoration_adapter, surface.surface_id);
    }
  }
});

test("A2: ADR and architecture pointer keep ordinary navigation public and private plans out", () => {
  const privatePlanning = /needs_james|card_standard|richness_profile|autodispatch|realization_gate/;
  const adr = read(ADR_PATH);
  assert.match(adr, /Status \| Accepted/);
  assert.match(adr, /directory_navigation|Ordinary navigation/i);
  assert.doesNotMatch(adr, privatePlanning);

  const architecture = read(ARCHITECTURE_PATH);
  assert.match(architecture, /Browse inspection continuity/);
  assert.match(architecture, /browse_inspection_contract\.mjs/);
  assert.match(architecture, /directory_navigation/);
  assert.doesNotMatch(architecture, privatePlanning);

  const design = read(DESIGN_PATH);
  assert.match(design, /Browse inspection continuity/);
  assert.match(design, /browse-inspection-continuity\.md/);
  assert.doesNotMatch(design, privatePlanning);
});

test("A3: healthy inventory validates with current source markers", () => {
  const result = validateBrowseInspectionContract({
    sourceTexts: sourceTextsForBaseline(),
  });
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.equal(result.contract_id, BROWSE_INSPECTION_CONTRACT_ID);
  assert.equal(result.compact_calendar_host_count, 8);
  assert.ok(result.directory_navigation_count >= 1);
  assert.equal(result.baseline_count, BROWSE_INSPECTION_LEGACY_BASELINE.length);
});

test("A3/A4: rejected undeclared surface is a behavioral failure", () => {
  const healthy = validateBrowseInspectionContract({ sourceTexts: sourceTextsForBaseline() });
  assert.equal(healthy.ok, true, healthy.problems.join("\n"));

  const undeclared = validateMutatedBrowseInspection("undeclared_surface", {
    sourceTexts: sourceTextsForBaseline(),
  });
  assert.equal(undeclared.ok, false);
  assert.ok(
    undeclared.problems.some((problem) => problem.includes("undeclared browsing surface: undeclared-browsing-surface")),
    undeclared.problems.join("\n"),
  );
  assert.equal(
    undeclared.problems.some((problem) => problem.includes("baseline growth")),
    false,
    undeclared.problems.join("\n"),
  );
});

test("A3/A4: rejected baseline addition is a behavioral failure", () => {
  const grown = validateMutatedBrowseInspection("baseline_growth", {
    sourceTexts: sourceTextsForBaseline(),
  });
  assert.equal(grown.ok, false);
  assert.ok(
    grown.problems.some((problem) => problem.includes("baseline growth is forbidden: invented-legacy-exception")),
    grown.problems.join("\n"),
  );
  assert.equal(
    grown.problems.some((problem) => problem.includes("undeclared browsing surface")),
    false,
    grown.problems.join("\n"),
  );
  const mutation = mutateBrowseInspectionContract("baseline_growth");
  assert.ok(mutation.baseline.length > BROWSE_INSPECTION_LEGACY_BASELINE.length);
});

test("A3/A4: accepted explicit directory-navigation fixture", () => {
  const directory = BROWSE_INSPECTION_SURFACES.find((row) => row.surface_id === "agency-directory");
  assert.ok(directory);
  const accepted = acceptDirectoryNavigationFixture(directory);
  assert.equal(accepted.ok, true, accepted.problems.join("\n"));
  assert.equal(accepted.surface_id, "agency-directory");

  const broken = validateMutatedBrowseInspection("directory_navigation_without_reason", {
    sourceTexts: sourceTextsForBaseline(),
  });
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some((problem) => problem.includes("directory navigation lacks semantic reason")));
  assert.ok(broken.problems.some((problem) => problem.includes("directory navigation lacks positive fixture")));
});

test("A3: dropping a compact-calendar host fails closed", () => {
  const dropped = validateMutatedBrowseInspection("drop_calendar_host", {
    sourceTexts: sourceTextsForBaseline(),
  });
  assert.equal(dropped.ok, false);
  assert.ok(dropped.problems.some((problem) => problem.includes("compact calendar host missing from inventory: calendar-host-property")));
});

test("A3: catalog JSON projection matches the maintained module and passes the surface-catalog check", () => {
  assert.equal(existsSync(CATALOG_PATH), true);
  const onDisk = JSON.parse(read(CATALOG_PATH));
  const projected = browseInspectionCatalogProjection();
  assert.equal(onDisk.schema, BROWSE_INSPECTION_CATALOG_SCHEMA);
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(projected)));

  const check = spawnSync(
    "python3",
    ["test/standards/resident_surface_catalog.py", "--check-browse-inspection", "--json"],
    { encoding: "utf8", cwd: ROOT },
  );
  assert.equal(check.status, 0, `${check.stderr}\n${check.stdout}`);
  const report = JSON.parse(check.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.surface_count, BROWSE_INSPECTION_SURFACES.length);
  assert.equal(report.compact_calendar_host_count, 8);
});

test("A4: acceptance manifest records the enforcement journey with revision, route, viewport, and fixture vintage", () => {
  assert.equal(existsSync(EVIDENCE_PATH), true);
  const manifest = JSON.parse(read(EVIDENCE_PATH));
  assert.equal(manifest.schema, "cityscroll.browse_inspection_acceptance.v1");
  assert.equal(manifest.contract_id, BROWSE_INSPECTION_CONTRACT_ID);
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.ok(manifest.route);
  assert.ok(Array.isArray(manifest.viewport) && manifest.viewport.length === 2);
  assert.ok(manifest.fixture_vintage);
  assert.ok(Array.isArray(manifest.assertions));
  assert.ok(manifest.assertions.some((row) => row.id === "reject-undeclared-surface" && row.result === "rejected"));
  assert.ok(manifest.assertions.some((row) => row.id === "reject-baseline-growth" && row.result === "rejected"));
  assert.ok(manifest.assertions.some((row) => row.id === "accept-directory-navigation" && row.result === "accepted"));
  assert.deepEqual(manifest.journey.sequence, [...BROWSE_INSPECTION_JOURNEY.sequence]);
  assert.ok(manifest.rendered_reference.harness.includes("browse_return_harness"));
  for (const banned of ["needs_james", "card_standard", "richness_profile", "autodispatch", "realization_gate"]) {
    assert.equal(JSON.stringify(manifest).includes(banned), false, banned);
  }
  const digest = createHash("sha256").update(JSON.stringify(manifest.assertions) + "\n").digest("hex");
  assert.equal(manifest.assertions_sha256, digest);
});
