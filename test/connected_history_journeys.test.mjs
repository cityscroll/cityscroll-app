/**
 * Fixed-dossier resident journeys for source-backed civic histories.
 *
 *   node --test test/connected_history_journeys.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CONNECTED_HISTORY_CASES,
  connectedHistoryCaseForQuery,
  projectConnectedHistoryJourney,
  renderConnectedHistoryFailure,
  renderConnectedHistoryJourney,
} from "../site/connected_history_journeys.mjs";
import { renderLandSiteLifecycle } from "../site/land_site_lifecycle.mjs";
import { retainedMeasurementStatus } from "../tools/repository_revision.mjs";

const ROOT = process.cwd();
const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const ARTIFACTS = Object.freeze({
  relations: readJson("site/data/connected_history_relations.json"),
  time: readJson("site/data/connected_history_time.json"),
  roles: readJson("site/data/connected_history_roles.json"),
});
const MANIFEST = readJson("docs/evidence/documented-history-journeys/capture-manifest.json");
const ADDRESS_REFRESH_REGISTRY = readJson("ops/address-index-refresh/dependent-geography.json");
const PRODUCTION_DATA_PATHS = Object.freeze([
  "/data/connected_history_relations.json",
  "/data/connected_history_roles.json",
  "/data/connected_history_time.json",
]);

// The scheduled refresh owns this registry. Keeping the control registry-driven
// means a newly published geography output must remain outside both the static
// input closure and the browser's observed requests, or this test fails.
const ADDRESS_REFRESH_ROOTS = Object.freeze([
  ...ADDRESS_REFRESH_REGISTRY.refreshed_input_paths,
  ...ADDRESS_REFRESH_REGISTRY.published_paths.map((entry) => entry.path),
]);

function belongsToAddressRefresh(path) {
  return ADDRESS_REFRESH_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

function clone(value) {
  return structuredClone(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
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
  assert.equal(MANIFEST.production_measurement.state, "measured");

  const production = MANIFEST.production_measurement;
  const productionReceipt = production.run_receipt;
  assert.equal(productionReceipt.schema, "cityscroll.documented_history_production_read.v1");
  assert.equal(productionReceipt.evidence_class, "deployed-production-read-back");
  assert.equal(productionReceipt.origin, "https://cityscroll.org");
  assert.match(productionReceipt.repository_revision, /^[a-f0-9]{40}$/);
  assert.match(productionReceipt.required_landed_commit, /^[a-f0-9]{40}$/);
  assert.equal(productionReceipt.served_revision_after, productionReceipt.served_revision);
  assert.equal(productionReceipt.image_binaries_committed, false);
  assert.equal(productionReceipt.capture_count, 18);
  assert.equal(productionReceipt.captures.length, 18);
  assert.deepEqual(
    new Set(productionReceipt.captures.map((capture) => capture.case)),
    new Set(CONNECTED_HISTORY_CASES.flatMap((entry) => [
      `${entry.family_id}-desktop-keyboard`,
      `${entry.family_id}-narrow-touch`,
      `${entry.family_id}-no-javascript`,
    ])),
  );
  assert.equal(productionReceipt.request_receipts.length, 3);
  assert.deepEqual(
    productionReceipt.request_receipts.map((entry) => new URL(entry.url).pathname).sort(),
    [...PRODUCTION_DATA_PATHS].sort(),
  );
  for (const entry of productionReceipt.request_receipts) {
    assert.equal(entry.http_status, 200);
    assert.equal(entry.served_revision, productionReceipt.served_revision);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.headers.Date);
    assert.ok(entry.headers["CF-Ray"]);
  }
  for (const capture of productionReceipt.captures) {
    assert.equal(capture.revision, productionReceipt.served_revision, capture.case);
    assert.ok(capture.data_vintage, capture.case);
    assert.ok(capture.assertion, capture.case);
    assert.match(capture.sha256, /^[a-f0-9]{64}$/, capture.case);
    assert.match(capture.render_sha256, /^[a-f0-9]{64}$/, capture.case);
    assert.equal(
      capture.hash_kind,
      capture.case.endsWith("-no-javascript") ? "rendered_markup" : "screenshot",
      capture.case,
    );
  }
  const publicReceipt = JSON.stringify(productionReceipt);
  assert.doesNotMatch(publicReceipt, /(?:\/Users\/|\/private\/tmp\/|local_path|screenshot_directory)/);
  const productionDigest = createHash("sha256")
    .update(canonicalJson(productionReceipt))
    .digest("hex");
  assert.equal(production.run_receipt_sha256, productionDigest);

  const captureTemp = mkdtempSync(join(tmpdir(), "connected-history-runner-"));
  const captureEnv = { ...process.env, TMPDIR: captureTemp };
  delete captureEnv.FM_TASK_SCRATCH;
  let receipt;
  try {
    const run = spawnSync(
      process.env.CITYSCROLL_BROWSER_PYTHON || "python3",
      ["tools/capture_documented_history_journeys.py"],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
        env: captureEnv,
      },
    );
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    receipt = JSON.parse(run.stdout);
    const runnerOwnedTemps = readdirSync(captureTemp)
      .filter((name) => name.startsWith("documented-history-captures-"));
    assert.deepEqual(runnerOwnedTemps, [], "capture runner must remove its fallback screenshot directory");
  } finally {
    rmSync(captureTemp, { recursive: true, force: true });
  }
  assert.equal(receipt.browser, "Chromium");
  assert.equal(receipt.mode, "hermetic_fixture");
  assert.equal(receipt.evidence_class, "runtime_browser_measurement");
  assert.match(receipt.repository_revision, /^[a-f0-9]{40}$/);
  assert.match(receipt.capture_revision, /^[a-f0-9]{40}$/);

  const provenance = MANIFEST.measurement_provenance;
  assert.match(provenance.revision, /^[a-f0-9]{40}$/);
  assert.ok(provenance.inputs.length > 0);
  assert.deepEqual(
    provenance.inputs.map((input) => input.path),
    [...provenance.inputs.map((input) => input.path)].sort(),
  );
  assert.deepEqual(receipt.measured_inputs, provenance.inputs);
  assert.deepEqual(
    receipt.measured_inputs.map((input) => input.path).filter(belongsToAddressRefresh),
    [],
    "address-refresh outputs are outside the declared measurement closure",
  );
  assert.deepEqual(
    receipt.local_request_paths
      .map((path) => `site${path}`)
      .filter(belongsToAddressRefresh),
    [],
    "the six measured journeys do not request address-refresh outputs",
  );
  for (const path of [
    "/data/connected_history_relations.json",
    "/data/connected_history_roles.json",
    "/data/connected_history_time.json",
  ]) {
    assert.ok(receipt.local_request_paths.includes(path), `runtime request control observed ${path}`);
  }
  const retainedStatus = retainedMeasurementStatus(ROOT, {
    revision: provenance.revision,
    head: receipt.capture_revision,
    inputs: provenance.inputs,
  });
  assert.equal(retainedStatus.ok, true, `${retainedStatus.reason}: ${retainedStatus.changedInputs.join(", ")}`);
  assert.equal(productionReceipt.retained_measurement.revision, provenance.revision);
  assert.equal(productionReceipt.retained_measurement.inputs_ref, "#/measurement_provenance/inputs");
  const productionStatus = retainedMeasurementStatus(ROOT, {
    revision: productionReceipt.repository_revision,
    inputs: provenance.inputs,
  });
  assert.equal(productionStatus.ok, true, `${productionStatus.reason}: ${productionStatus.changedInputs.join(", ")}`);
  assert.equal(
    spawnSync(
      "git",
      ["merge-base", "--is-ancestor", productionReceipt.required_landed_commit, productionReceipt.served_revision],
      { cwd: ROOT, stdio: "ignore" },
    ).status,
    0,
    "served revision contains the required landed commit",
  );

  const observed = new Map(receipt.captures.map((capture) => [capture.case, capture]));
  const retained = new Map(MANIFEST.captures.map((capture) => [capture.case, capture]));
  assert.deepEqual(new Set(MANIFEST.captures.map((capture) => capture.revision)), new Set([provenance.revision]));
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
      assert.equal(manifest.revision, provenance.revision, id);
      assert.deepEqual(actual.viewport, { name: suffix, width, height });
      assert.equal(actual.render_sha256, manifest.sha256, id);
      assert.match(actual.render_sha256, /^[a-f0-9]{64}$/);
      assert.equal(actual.runtime.query, entry.queries[0], id);
      if (suffix !== "no-javascript") {
        assert.equal(actual.runtime.horizontal_overflow, false, id);
        assert.equal(actual.runtime.positive_tabindex_count, 0, id);
        assert.match(actual.runtime.official_source_destination, /^https?:\/\//, id);
        assert.equal(typeof actual.runtime.official_source_document_departed, "boolean", id);
        assert.match(actual.runtime.continue_destination, /^https?:\/\//, id);
        assert.equal(typeof actual.runtime.continue_document_departed, "boolean", id);
      }
    }
  }

  const failure = observed.get("history-materialization-failure-positive-control");
  assert.ok(failure);
  assert.equal(retained.get(failure.case).revision, provenance.revision);
  assert.equal(failure.render_sha256, retained.get(failure.case).sha256);
});

test("A3: production instrumentation pins the landed Pages revision and served data in-run", () => {
  const source = readFileSync(new URL("../tools/capture_documented_history_journeys.py", import.meta.url), "utf8");
  assert.match(source, /require_served_page_revision_contains_delivery/);
  assert.match(source, /--production requires --landed-commit/);
  assert.match(source, /served materialization has no generated_at/);
  assert.match(source, /served revision changed during capture/);
  assert.match(source, /request_receipts/);
  assert.match(source, /activate_link/);
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
