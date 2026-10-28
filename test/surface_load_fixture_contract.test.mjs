// Contract checks for the live surface-load fixture.
//
// The fixture's definitions describe rendered surfaces the daily live sampler
// walks. When a surface moves to a canonical document route or its readiness
// DOM changes, the sampler's root/ready selectors silently stop matching and
// the workflow fails on every run. These checks pin each definition to the
// repository's own routing surfaces so that drift fails here instead.
//
//   node --test test/surface_load_fixture_contract.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { matchSpaHashRoute } from "../site/spa_hash_routes.mjs";
import { migrateLegacyUrl } from "../site/route_migration.mjs";
import { BROWSE_SURFACES } from "../site/browse_surface_contracts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "ontology/fixtures/dimensions/surface_load.json"), "utf8"));
const CANONICAL_ORIGIN = "https://cityscroll.org";

// Migration-target families served by standalone documents rather than the
// topic SPA shell. A legacy hash that forwards into one of these lands on a
// document that never renders the shell's tab/entity ids, so the sampler must
// point at the canonical path and declare that document's own selectors.
const STANDALONE_DOCUMENT_FAMILIES = ["/exams/", "/agencies/", "/following/"];

const BROWSE_CANONICAL_ROUTES = new Set(BROWSE_SURFACES.map((surface) => surface.canonicalRoute));

const ID_TOKEN = /#[A-Za-z][A-Za-z0-9_-]*/g;

function repoPath(relative) {
  return join(ROOT, relative);
}

function readIfExists(relative) {
  const path = repoPath(relative);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function selectorIds(definition) {
  const ids = new Set();
  for (const selector of [definition.root_selector, definition.ready_selector, definition.action_selector]) {
    for (const token of String(selector || "").match(ID_TOKEN) || []) {
      ids.add(token.slice(1));
    }
  }
  return [...ids];
}

function migrationTarget(route) {
  const migrated = migrateLegacyUrl(`${CANONICAL_ORIGIN}/${route}`);
  return migrated?.migrated ? migrated.target : null;
}

function standaloneFamilyTarget(route) {
  const target = migrationTarget(route);
  if (!target) return null;
  return STANDALONE_DOCUMENT_FAMILIES.find((family) => target.startsWith(family)) || null;
}

test("surface-load fixture routes resolve against the repository's routing surfaces", () => {
  assert.ok(FIXTURE.definitions.length >= 10, "fixture must keep sampling the principal surfaces");
  for (const definition of FIXTURE.definitions) {
    const route = String(definition.route || "");
    assert.ok(route, `${definition.id}: route is missing`);
    if (route.startsWith("#")) {
      const family = standaloneFamilyTarget(route);
      assert.ok(
        !family,
        `${definition.id}: legacy hash ${route} forwards into the standalone document family ${family}; `
          + `point the sampler at the canonical path route instead`,
      );
      const registered = matchSpaHashRoute(route);
      const migrated = migrationTarget(route);
      assert.ok(
        registered || migrated,
        `${definition.id}: legacy hash ${route} is neither a registered SPA route nor migrated; `
          + `it would strand the sampler on the Near You root`,
      );
      continue;
    }
    assert.ok(
      route.startsWith("/") && route.endsWith("/"),
      `${definition.id}: canonical route ${route} must be an absolute directory path`,
    );
    if (route.startsWith("/browse/")) {
      assert.ok(
        BROWSE_CANONICAL_ROUTES.has(route),
        `${definition.id}: ${route} is not a registered browse surface canonical route`,
      );
    } else if (/^\/agencies\/[^/]+\/$/.test(route)) {
      const slug = route.split("/")[2];
      const lookup = JSON.parse(readFileSync(repoPath("site/data/agency_constellation_lookup.json"), "utf8"));
      assert.ok(
        Object.hasOwn(lookup.by_id, slug),
        `${definition.id}: agency ${slug} is not published in the agency constellation lookup`,
      );
    } else if (/^\/exams\/\d+\/$/.test(route)) {
      assert.ok(
        existsSync(repoPath(`site${route}index.html`)),
        `${definition.id}: no tracked exam document at ${route}`,
      );
    } else {
      assert.ok(
        existsSync(repoPath(`site${route}index.html`)),
        `${definition.id}: no tracked document at ${route}`,
      );
    }
  }
});

test("surface-load fixture selectors exist in the document that renders each surface", () => {
  for (const definition of FIXTURE.definitions) {
    const owner = definition.file || "site/index.html";
    const sources = [owner, ...(definition.selector_sources || [])];
    for (const relative of sources) {
      assert.ok(existsSync(repoPath(relative)), `${definition.id}: owning source ${relative} does not exist`);
    }
    const texts = sources.map((relative) => readFileSync(repoPath(relative), "utf8"));
    for (const id of selectorIds(definition)) {
      // HTML documents carry the attribute form; document builders construct
      // ids through template attrs, which appear in source as object values.
      const present = texts.some((text) => text.includes(`id="${id}"`) || text.includes(`id: "${id}"`));
      assert.ok(
        present,
        `${definition.id}: selector id #${id} appears in none of ${sources.join(", ")}; `
          + `the readiness contract no longer matches the rendered document`,
      );
    }
  }
});

test("surface-load fixture samples stay aligned with their definitions", () => {
  const byId = new Map(FIXTURE.definitions.map((definition) => [definition.id, definition]));
  for (const surface of FIXTURE.surfaces) {
    const definition = byId.get(surface.id);
    assert.ok(definition, `fixture sample ${surface.id} has no matching definition`);
    assert.equal(surface.route, definition.route, `${surface.id}: sample route drifted from its definition`);
    assert.deepEqual(
      surface.budgets,
      definition.budgets,
      `${surface.id}: sample budgets drifted from its definition`,
    );
  }
});
