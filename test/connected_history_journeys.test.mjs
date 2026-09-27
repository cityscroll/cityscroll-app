/**
 * Fixed-dossier resident journeys for source-backed civic histories.
 *
 *   node --test test/connected_history_journeys.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CONNECTED_HISTORY_CASES,
  connectedHistoryCaseForQuery,
  projectConnectedHistoryJourney,
  renderConnectedHistoryFailure,
  renderConnectedHistoryJourney,
} from "../site/connected_history_journeys.mjs";
import { renderLandSiteLifecycle } from "../site/land_site_lifecycle.mjs";

const ROOT = process.cwd();
const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const ARTIFACTS = Object.freeze({
  relations: readJson("site/data/connected_history_relations.json"),
  time: readJson("site/data/connected_history_time.json"),
  roles: readJson("site/data/connected_history_roles.json"),
});
const MANIFEST = readJson("docs/evidence/documented-history-journeys/capture-manifest.json");

function clone(value) {
  return structuredClone(value);
}

function dateKey(event) {
  return event.date?.start || event.date?.value || "9999-99-99";
}

test("A1: every fixed exact query reaches one distinct, source-backed history", () => {
  assert.equal(CONNECTED_HISTORY_CASES.length, 6);
  const families = new Set();
  for (const entry of CONNECTED_HISTORY_CASES) {
    families.add(entry.family_id);
    for (const query of entry.queries) {
      assert.equal(connectedHistoryCaseForQuery(query)?.family_id, entry.family_id, query);
      const journey = projectConnectedHistoryJourney(ARTIFACTS, query);
      assert.equal(journey.family_id, entry.family_id);
      assert.equal(journey.matched_query, query);
      assert.ok(journey.events.length > 0, entry.family_id);
      assert.ok(journey.identities.length >= 2, entry.family_id);
      assert.ok(journey.sources.every((source) => /^https:\/\//.test(source.href)), entry.family_id);
      assert.ok(journey.events.every((event) => event.evidence?.quote), entry.family_id);
      const html = renderConnectedHistoryJourney(journey);
      assert.match(html, /Inspect source-backed event/);
      assert.match(html, /data-connected-history-open/);
      assert.match(html, /data-connected-history-continue/);
      assert.doesNotMatch(html, /candidate_id|identities_merged|method_version|join diagnostic/i);
    }
  }
  assert.equal(families.size, 6);

  // Positive and converse controls: the exact aliases match, but named
  // confusions and a merely similar address do not expand the closed dossier.
  assert.equal(connectedHistoryCaseForQuery("31st Avenue")?.family_id, "thirty-first-avenue");
  for (const negative of ["31st Street", "Emmons Avenue", "Stapleton", "964 Franklin Avenue"]) {
    assert.equal(connectedHistoryCaseForQuery(negative), null, negative);
  }
});

test("A1: chronological claims hold at an intermediate state and respond to a converse mutation", () => {
  const baseline = projectConnectedHistoryJourney(ARTIFACTS, "Kingsbridge Armory");
  const keys = baseline.events.map(dateKey);
  assert.deepEqual(keys, [...keys].sort(), "module oracle: projection order is deterministic");

  const intermediate = baseline.events.filter((event) => dateKey(event) <= "2013-12-31");
  assert.ok(intermediate.some((event) => event.id === "kingsbridge-retail-2009"));
  assert.ok(intermediate.some((event) => event.id === "kingsbridge-ice-center-2013"));
  assert.ok(intermediate.some((event) => event.id === "kingsbridge-operation-forecast-2018"));
  assert.ok(intermediate.every((event) => !event.id.includes("2025")));

  const mutated = clone(ARTIFACTS);
  const later = mutated.time.observations.find((row) => row.observation_id === "kingsbridge-redevelopment-2025");
  later.event_time = { value: "2008", precision: "year", start: "2008-01-01", end: "2008-12-31" };
  const converse = projectConnectedHistoryJourney(mutated, "Kingsbridge Armory");
  const changedIntermediate = converse.events.filter((event) => dateKey(event) <= "2013-12-31");
  assert.ok(changedIntermediate.some((event) => event.id === "kingsbridge-redevelopment-2025"));
  assert.notDeepEqual(changedIntermediate.map((event) => event.id), intermediate.map((event) => event.id));
});

test("A2: existing reciprocal site behavior remains and resident projection omits empty optional panels", () => {
  const reciprocal = renderLandSiteLifecycle("2020K0270");
  assert.match(reciprocal, /Other government activity at this site/);
  assert.match(reciprocal, /procurement%3Acontract%3ACT107120258802303/);
  assert.match(reciprocal, /\/parcels\/3073670011\//);

  const coyle = renderConnectedHistoryJourney(projectConnectedHistoryJourney(ARTIFACTS, "2025-54-A"));
  const franklin = renderConnectedHistoryJourney(projectConnectedHistoryJourney(ARTIFACTS, "960 Franklin Avenue"));
  assert.doesNotMatch(coyle, /Documented participants/);
  assert.match(franklin, /Documented participants/);
  assert.match(franklin, /year precision/);
  assert.match(coyle, /day precision/);

  const failure = renderConnectedHistoryFailure("Kingsbridge Armory");
  assert.match(failure, /Kingsbridge Armory/);
  assert.match(failure, /data-connected-history-retry/);
  assert.match(failure, /https:\/\//);
  assert.match(failure, /unavailable result/);
  assert.doesNotMatch(failure, /no history|no matches|nothing found/i);
});

test("A2: malformed or identity-collapsed inputs fail closed with positive controls", () => {
  const valid = projectConnectedHistoryJourney(ARTIFACTS, "2025-54-A");
  assert.equal(valid.family_id, "coyle");

  const malformed = clone(ARTIFACTS);
  malformed.relations.schema = "wrong";
  assert.throws(() => projectConnectedHistoryJourney(malformed, "2025-54-A"), /invalid/);

  const collapsed = clone(ARTIFACTS);
  collapsed.relations.relations = [collapsed.relations.relations.find((row) => row.family_id === "coyle")];
  collapsed.relations.relations[0].to = collapsed.relations.relations[0].from;
  assert.throws(() => projectConnectedHistoryJourney(collapsed, "2025-54-A"), /identities collapsed/);
});

test("A3: retained Chromium measurements cover all six at named viewports and no-JavaScript", () => {
  assert.equal(MANIFEST.schema, "cityscroll.documented_history_journey_manifest.v1");
  assert.equal(MANIFEST.evidence_class, "runtime_browser_measurement");
  assert.equal(MANIFEST.image_binaries_committed, false);
  assert.equal(MANIFEST.production_measurement.state, "awaiting_landed_deploy");

  const run = spawnSync(
    process.env.CITYSCROLL_BROWSER_PYTHON || "python3",
    ["tools/capture_documented_history_journeys.py"],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.browser, "Chromium");
  assert.equal(receipt.mode, "hermetic_fixture");
  assert.equal(receipt.evidence_class, "runtime_browser_measurement");

  const observed = new Map(receipt.captures.map((capture) => [capture.case, capture]));
  const retained = new Map(MANIFEST.captures.map((capture) => [capture.case, capture]));
  for (const entry of CONNECTED_HISTORY_CASES) {
    for (const [suffix, width, height] of [
      ["desktop-keyboard", 1440, 900],
      ["narrow-touch", 390, 844],
      ["no-javascript", 1440, 900],
    ]) {
      const id = `${entry.family_id}-${suffix}`;
      const actual = observed.get(id);
      const manifest = retained.get(id);
      assert.ok(actual, id);
      assert.ok(manifest, id);
      assert.deepEqual(actual.viewport, { name: suffix, width, height });
      assert.equal(actual.render_sha256, manifest.sha256, id);
      assert.match(actual.render_sha256, /^[a-f0-9]{64}$/);
      assert.equal(actual.runtime.query, entry.queries[0], id);
      if (suffix !== "no-javascript") {
        assert.equal(actual.runtime.horizontal_overflow, false, id);
        assert.equal(actual.runtime.positive_tabindex_count, 0, id);
      }
    }
  }

  const failure = observed.get("history-materialization-failure-positive-control");
  assert.ok(failure);
  assert.equal(failure.render_sha256, retained.get(failure.case).sha256);
});

test("A3: production instrumentation pins the landed Pages revision and served data in-run", () => {
  const source = readFileSync(new URL("../tools/capture_documented_history_journeys.py", import.meta.url), "utf8");
  assert.match(source, /require_served_page_revision_contains_delivery/);
  assert.match(source, /--production requires --landed-commit/);
  assert.match(source, /served materialization has no generated_at/);
  assert.match(source, /request_receipts/);
  assert.match(source, /runtime_browser_measurement/);

  // Converse control: production cannot be invoked without its landed pin.
  const refusal = spawnSync(
    process.env.CITYSCROLL_BROWSER_PYTHON || "python3",
    ["tools/capture_documented_history_journeys.py", "--production"],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  );
  assert.notEqual(refusal.status, 0);
  assert.match(`${refusal.stderr}${refusal.stdout}`, /requires --landed-commit/);
});

test("A4: a missing fixed case is reported rather than replaced", () => {
  assert.ok(projectConnectedHistoryJourney(ARTIFACTS, "Sixth Avenue").events.length > 0);
  const missing = clone(ARTIFACTS);
  missing.relations.relations = missing.relations.relations.filter((row) => row.family_id !== "sixth-avenue");
  assert.throws(
    () => projectConnectedHistoryJourney(missing, "Sixth Avenue"),
    /connected history unavailable for sixth-avenue/,
  );
  assert.equal(connectedHistoryCaseForQuery("Replacement corridor"), null);
});
