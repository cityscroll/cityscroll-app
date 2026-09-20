import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { test } from "node:test";

import {
  BROWSE_INSPECTION_JOURNEY,
  BROWSE_INSPECTION_SURFACES,
  COMPACT_CALENDAR_HOST_IDS,
  browseInspectionCatalogProjection,
  validateBrowseInspectionContract,
  validateMutatedBrowseInspection,
} from "../site/browse_inspection_contract.mjs";

const ROOT = process.cwd();
const CATALOG_PATH = join(ROOT, "test", "standards", "browse_inspection_catalog.json");
const RETURN_EVIDENCE_PATH = join(ROOT, "docs", "evidence", "browse-return-context", "manifest.json");
const REQUIRED_VARIANTS = [
  "desktop",
  "narrow_touch",
  "keyboard",
  "no_javascript",
  "failed_detail",
  "reversed_response",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function repositoryPath(relative) {
  assert.equal(typeof relative, "string", "owned paths must be strings");
  assert.equal(relative.startsWith("/"), false, `owned path must be repository-relative: ${relative}`);
  const resolved = normalize(join(ROOT, relative));
  assert.equal(
    resolved === ROOT || resolved.startsWith(`${ROOT}/`),
    true,
    `owned path escaped the repository: ${relative}`,
  );
  return resolved;
}

function evidenceProblems(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== "object") return ["evidence manifest must be an object"];
  if (manifest.schema !== "cityscroll.browse_return_evidence.v1") {
    problems.push("browse-return evidence schema is missing");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    problems.push("browse-return evidence must contain capture records");
    return problems;
  }
  for (const [index, entry] of manifest.files.entries()) {
    if (!entry.route || !Array.isArray(entry.viewport) || entry.viewport.length !== 2) {
      problems.push(`capture ${index} lacks route or viewport`);
    }
    if (!entry.revision || !/^[0-9a-f]{40}$/.test(entry.revision)) {
      problems.push(`capture ${index} lacks a revision`);
    }
    if (!entry.data_vintage) problems.push(`capture ${index} lacks data vintage`);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 || "")) {
      problems.push(`capture ${index} lacks a sha256 image proof`);
    }
  }
  if (!/never committed/i.test(manifest.image_policy || "")) {
    problems.push("browse-return evidence must keep images out of the repository");
  }
  return problems;
}

test("registered surfaces have finite ownership and executable journey owners", () => {
  const inventory = new Set(BROWSE_INSPECTION_SURFACES.map((surface) => surface.surface_id));
  assert.equal(new Set(COMPACT_CALENDAR_HOST_IDS).size, 8);

  for (const surface of BROWSE_INSPECTION_SURFACES) {
    assert.ok(inventory.has(surface.surface_id), surface.surface_id);
    assert.ok(existsSync(repositoryPath(surface.domain_adapter)), `${surface.surface_id} domain adapter`);
    assert.ok(existsSync(repositoryPath(surface.render_owner)), `${surface.surface_id} render owner`);
    assert.ok(existsSync(repositoryPath(surface.journey_owner)), `${surface.surface_id} journey owner`);
    if (surface.detail_host_module) {
      assert.ok(existsSync(repositoryPath(surface.detail_host_module)), `${surface.surface_id} detail host`);
    }
    if (surface.restoration_adapter) {
      assert.ok(existsSync(repositoryPath(surface.restoration_adapter)), `${surface.surface_id} restoration`);
    }
    assert.match(surface.route, /^\//, surface.surface_id);
    assert.ok(Array.isArray(surface.principles) && surface.principles.length >= 1, surface.surface_id);
  }

  for (const reference of BROWSE_INSPECTION_JOURNEY.functional_references) {
    assert.ok(existsSync(repositoryPath(reference.path)), reference.path);
    assert.ok(reference.surfaces.length > 0, reference.path);
    for (const surfaceId of reference.surfaces) assert.ok(inventory.has(surfaceId), surfaceId);
    for (const assertion of reference.assertions) assert.match(assertion, /^[a-z_]+$/, reference.path);
  }
});

test("the journey matrix covers every required rendered variant and existing evidence", () => {
  const rendered = BROWSE_INSPECTION_JOURNEY.rendered_reference;
  assert.ok(existsSync(repositoryPath(rendered.harness)), rendered.harness);
  assert.ok(rendered.route, "rendered journey route");
  for (const variant of REQUIRED_VARIANTS) assert.ok(rendered.variants.includes(variant), variant);

  const evidence = readJson(RETURN_EVIDENCE_PATH);
  assert.deepEqual(evidenceProblems(evidence), []);

  const broken = structuredClone(evidence);
  broken.files[0].sha256 = "not-a-hash";
  assert.ok(evidenceProblems(broken).some((problem) => problem.includes("sha256")));
});

test("the catalog projection stays synchronized and retains the required boundary", () => {
  const catalog = readJson(CATALOG_PATH);
  assert.deepEqual(catalog, JSON.parse(JSON.stringify(browseInspectionCatalogProjection())));

  const ids = new Set(BROWSE_INSPECTION_SURFACES.map((surface) => surface.surface_id));
  for (const id of [
    "now-calendar",
    "search-results",
    "land-map-selection",
    "near-you-scope",
  ]) {
    assert.ok(ids.has(id), id);
  }
  assert.equal(
    JSON.stringify(catalog).match(/rolling[-_ ]feed/gi),
    null,
    "a rolling feed identity is not a release requirement",
  );
});

test("negative conformance fixtures reject undeclared and incomplete changed surfaces", () => {
  const healthy = validateBrowseInspectionContract();
  assert.equal(healthy.ok, true, healthy.problems.join("\n"));

  const undeclared = validateMutatedBrowseInspection("undeclared_surface");
  assert.equal(undeclared.ok, false);
  assert.ok(undeclared.problems.some((problem) => problem.includes("undeclared browsing surface")));

  const incomplete = validateBrowseInspectionContract({
    surfaces: BROWSE_INSPECTION_SURFACES.map((surface, index) => (
      index === 0 ? { ...surface, journey_owner: "" } : surface
    )),
  });
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.problems.some((problem) => problem.includes("journey owner for now-calendar")));

  const grown = validateMutatedBrowseInspection("baseline_growth");
  assert.equal(grown.ok, false);
  assert.ok(grown.problems.some((problem) => problem.includes("baseline growth is forbidden")));
});
