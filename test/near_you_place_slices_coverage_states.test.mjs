// Offline proof that every typed published-coverage state the Near You
// place-slice read-back classifier can emit is reached, typed, and kept
// distinct — with no production capture and no deployed Pages dependency.
//
// Public alias: c76db1a2c9474
//
// The classifier in tools/capture_near_you_place_slices_production_read.py
// reduces a deferred Near You response to exactly one typed state:
// available records, published zero, unavailable source coverage, or
// transient publication failure. Before this file, no test drove that
// classifier — the retained production read-back artifact carried three
// states by value, and the classification itself was unproven for every
// state, including the transient failure no artifact can stage on demand.
//
//   distinct states   positive membership, published zero, unknown
//                     geography, transient KV failure, stale manifest,
//                     and partial publication stay distinct, and no
//                     broader-district record is relabeled neighborhood-local
//   fail-closed       an ambiguous or missing fixture is rejected, never
//                     silently reclassified
//
//   node --test test/near_you_place_slices_coverage_states.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withTempDirSync } from "../tools/lib/with_temp_dir.mjs";

import { handleNearYou } from "../worker/src/near_you.mjs";
import {
  loadNearYouActivity,
  RouteReadModelUnavailable,
} from "../worker/src/lib/route_read_model_kv.mjs";
import {
  buildNearYou,
  decideNearYouManifestActivation,
  requiredNearYouSliceIds,
  residentialPlacesFromNtaLayer,
} from "../tools/build_worker_route_read_models.mjs";

const ROOT = new URL("../", import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));
const committedActivity = readJson("site/data/district_activity.json");
const residentialPlaces = residentialPlacesFromNtaLayer(
  readJson("site/data/geography/layers/nta2020/26B.json"),
);
const PROBE = join("test", "functional", "near_you_place_slice_coverage_classify_probe.py");

const ZERO_COPY = "No records match these filters.";
const UNAVAILABLE_COPY = "This area\u2019s materialized records are unavailable right now.";
const GENERIC_UNAVAILABLE_COPY = "Matching records are not available right now.";
const DEFERRED_SCHEMA = "cityscroll.near_you_deferred.v1";
const DEFERRED_ERROR_SCHEMA = "cityscroll.near_you_deferred_error.v1";
const NEAR_YOU_MANIFEST_KEY = "route-read-model:near-you:manifest:v1";

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function kv(values) {
  return { async get(key) { return values.get(key) || null; } };
}

function materialize(activity, version) {
  const built = buildNearYou(activity, {}, version, { residentialPlaces });
  const values = new Map(built.entries.map(({ key, value }) => [key, value]));
  values.set(NEAR_YOU_MANIFEST_KEY, JSON.stringify(built.manifest));
  return { built, values };
}

const deferredUrl = (code) =>
  `https://cityscroll.org/near-you/deferred.json?geo=nta2020%3A${code}&lens=meetings&surface=map`;

async function serveCase(id, url, kvValues) {
  const response = await handleNearYou(new Request(url), { ALERT_STATE: kv(kvValues) });
  return { id, status: response.status, body: await response.text() };
}

function classifyCases(cases) {
  return withTempDirSync("near-you-coverage-states-", (dir) => {
    const casePath = join(dir, "served-cases.json");
    writeFileSync(casePath, JSON.stringify(cases));
    const result = spawnSync("python3", [join(ROOT_PATH, PROBE), casePath], {
      cwd: ROOT_PATH,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `classify probe failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  });
}

function servedCount(body) {
  const payload = JSON.parse(body);
  const match = payload.results_html?.match(/data-results-count="(\d+)"/);
  return match ? Number(match[1]) : null;
}

test("the classifier types each served borough fixture into its published-coverage state", async () => {
  const { values } = materialize(committedActivity, "offline-coverage-states");
  const cases = [];
  for (const code of ["MN0102", "BX0101", "BK0101", "QN0103", "SI0101"]) {
    cases.push(await serveCase(code, deferredUrl(code), values));
  }

  // Serving-level distinctness before any classification: populated, empty,
  // and source-unavailable are three different values, not three labels.
  const byId = Object.fromEntries(cases.map((row) => [row.id, row]));
  for (const code of ["BK0101", "QN0103", "SI0101"]) {
    assert.equal(byId[code].status, 200, code);
    assert.equal(JSON.parse(byId[code].body).schema, DEFERRED_SCHEMA, code);
    assert.equal(servedCount(byId[code].body), null, `${code}: unavailable coverage carries no fabricated count`);
    assert.match(byId[code].body, new RegExp(escapeRe(UNAVAILABLE_COPY)), code);
    assert.doesNotMatch(byId[code].body, new RegExp(escapeRe(ZERO_COPY)), code);
  }
  const bxResults = JSON.parse(byId.BX0101.body).results_html;
  assert.match(bxResults, /data-results-count="0"/);
  assert.match(bxResults, new RegExp(escapeRe(ZERO_COPY)));
  assert.equal(servedCount(byId.MN0102.body) >= 1, true, "positive membership publishes a positive count");

  const results = classifyCases(cases);
  const resultById = Object.fromEntries(results.map((row) => [row.id, row]));
  const expected = {
    MN0102: { state: "available_records", count: servedCount(byId.MN0102.body) },
    BX0101: { state: "published_zero", count: 0, typed_copy: ZERO_COPY },
    BK0101: { state: "unavailable_source_coverage", count: null, typed_copy: UNAVAILABLE_COPY },
    QN0103: { state: "unavailable_source_coverage", count: null, typed_copy: UNAVAILABLE_COPY },
    SI0101: { state: "unavailable_source_coverage", count: null, typed_copy: UNAVAILABLE_COPY },
  };
  for (const [code, want] of Object.entries(expected)) {
    const got = resultById[code];
    assert.equal(got.outcome, "classified", `${code}: ${got.error ?? got.state}`);
    assert.equal(got.state, want.state, code);
    assert.equal(got.count, want.count, code);
    if (want.typed_copy) assert.equal(got.typed_copy, want.typed_copy, code);
  }
  assert.equal(resultById.MN0102.typed_copy, null, "available records carry no typed copy");
});

test("unknown geography, transient KV failure, stale manifest, and partial publication stay distinct and never relabel", async () => {
  const { built, values } = materialize(committedActivity, "offline-distinct-failures");

  const staleValues = new Map(values);
  staleValues.set(NEAR_YOU_MANIFEST_KEY, JSON.stringify({ ...built.manifest, schema_version: 0 }));
  const partialManifest = {
    ...built.manifest,
    slices: Object.fromEntries(
      Object.entries(built.manifest.slices)
        .filter(([sliceId]) => !sliceId.startsWith("geography:nta2020:BK0101:")),
    ),
  };
  const partialValues = new Map(built.entries.map(({ key, value }) => [key, value]));
  partialValues.set(NEAR_YOU_MANIFEST_KEY, JSON.stringify(partialManifest));

  const mechanisms = [
    {
      name: "unknown-geography",
      geoKey: "geography:nta2020:BK9999",
      url: deferredUrl("BK9999"),
      values,
      message: /missing near-you slice geography:nta2020:BK9999:meetings/,
    },
    {
      name: "transient-kv-failure",
      geoKey: "geography:nta2020:BK0101",
      url: deferredUrl("BK0101"),
      values: new Map(),
      message: /missing route read-model key route-read-model:near-you:manifest:v1/,
    },
    {
      name: "stale-manifest",
      geoKey: "geography:nta2020:MN0102",
      url: deferredUrl("MN0102"),
      values: staleValues,
      message: /invalid near-you route read-model manifest/,
    },
    {
      name: "partial-publication",
      geoKey: "geography:nta2020:BK0101",
      url: deferredUrl("BK0101"),
      values: partialValues,
      message: /missing near-you slice geography:nta2020:BK0101:meetings/,
    },
  ];

  // Mechanism-level distinctness: each failure source rejects with its own
  // fail-closed message before any response is rendered.
  const requiredSlices = new Set(requiredNearYouSliceIds(residentialPlaces));
  for (const mechanism of mechanisms) {
    const scope = { place: { geographies: [mechanism.geoKey] } };
    await assert.rejects(
      () => loadNearYouActivity({ ALERT_STATE: kv(mechanism.values) }, scope),
      (error) => error instanceof RouteReadModelUnavailable && mechanism.message.test(error.message),
      `${mechanism.name} must reject with its own unavailable message`,
    );
  }
  // A partial publication misses a place the closed-world registry REQUIRES;
  // an unknown geography misses a place the registry never promised.
  assert.equal(requiredSlices.has("geography:nta2020:BK0101:meetings"), true);
  assert.equal(requiredSlices.has("geography:nta2020:BK9999:meetings"), false);
  const refused = decideNearYouManifestActivation({
    previousManifest: { ...built.manifest, version: "prior-good" },
    candidateManifest: partialManifest,
    residentialPlaces,
  });
  assert.equal(refused.activate, false);
  assert.equal(refused.reason, "incomplete_manifest");
  assert.ok(refused.missing.some((sliceId) => sliceId === "geography:nta2020:BK0101:meetings"));

  // Serving-level honesty: every failure mechanism answers with the typed
  // transient error, never a fabricated zero, records, or coverage copy.
  const served = [];
  for (const mechanism of mechanisms) {
    served.push(await serveCase(mechanism.name, mechanism.url, mechanism.values));
  }
  for (const row of served) {
    assert.equal(row.status, 503, row.id);
    const payload = JSON.parse(row.body);
    assert.equal(payload.schema, DEFERRED_ERROR_SCHEMA, row.id);
    assert.equal(payload.reason, "near-you-read-model-unavailable", row.id);
    assert.equal("results_html" in payload, false, `${row.id}: error body carries no results`);
    assert.equal(row.body.includes(ZERO_COPY), false, `${row.id}: transient failure never relabels as published zero`);
    assert.equal(row.body.includes(UNAVAILABLE_COPY), false, `${row.id}: transient failure never relabels as source coverage`);
  }

  // Classifier-level honesty: all four mechanisms classify as the transient
  // state — the one published state no retained artifact can stage.
  const results = classifyCases(served);
  for (const row of results) {
    assert.equal(row.outcome, "classified", `${row.id}: ${row.error ?? row.state}`);
    assert.equal(row.state, "transient_publication_failure", row.id);
    assert.equal(row.count, null, row.id);
    assert.equal(row.typed_copy, null, row.id);
    assert.equal(row.reason, "near-you-read-model-unavailable", row.id);
  }
});

test("fail-closed: ambiguous or missing classifier fixtures are rejected, never silently passed", () => {
  const resultsSection = (inner) => `<section class="near-results" ${inner}</section>`;
  const availableHtml = resultsSection('data-results-count="2"><ol class="near-records"><li class="near-record">a</li></ol>');
  const unavailableHtml = resultsSection(`>${UNAVAILABLE_COPY}`);
  const cases = [
    {
      id: "synthetic-available-records",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: availableHtml }),
    },
    {
      id: "synthetic-published-zero",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: resultsSection(`data-results-count="0">${ZERO_COPY}`) }),
    },
    {
      id: "synthetic-unavailable-source-coverage",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: unavailableHtml }),
    },
    {
      id: "synthetic-transient-publication-failure",
      status: 503,
      body: JSON.stringify({ ok: false, schema: DEFERRED_ERROR_SCHEMA, reason: "near-you-read-model-unavailable" }),
    },
    {
      id: "reject-positive-count-without-record-list",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: resultsSection('data-results-count="3">no list') }),
    },
    {
      id: "reject-zero-count-without-zero-copy",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: resultsSection('data-results-count="0">something else') }),
    },
    {
      id: "reject-unavailable-mixed-with-zero-copy",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: unavailableHtml + ZERO_COPY }),
    },
    {
      id: "reject-unavailable-mixed-with-generic-copy",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: unavailableHtml + GENERIC_UNAVAILABLE_COPY }),
    },
    {
      id: "reject-no-typed-state",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: resultsSection(">unrecognized") }),
    },
    {
      id: "reject-unexpected-schema",
      status: 200,
      body: JSON.stringify({ schema: "cityscroll.other.v1", results_html: availableHtml }),
    },
    {
      id: "reject-missing-results-html",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA }),
    },
    {
      id: "reject-unexpected-http-status",
      status: 500,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: availableHtml }),
    },
    {
      id: "reject-error-status-with-deferred-schema",
      status: 503,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: resultsSection(`data-results-count="0">${ZERO_COPY}`) }),
    },
  ];

  const results = classifyCases(cases);
  const byId = Object.fromEntries(results.map((row) => [row.id, row]));
  const want = {
    "synthetic-available-records": { state: "available_records", count: 2 },
    "synthetic-published-zero": { state: "published_zero", count: 0 },
    "synthetic-unavailable-source-coverage": { state: "unavailable_source_coverage", count: null },
    "synthetic-transient-publication-failure": { state: "transient_publication_failure" },
  };
  for (const [id, expected] of Object.entries(want)) {
    assert.equal(byId[id].outcome, "classified", id);
    assert.equal(byId[id].state, expected.state, id);
    if ("count" in expected) assert.equal(byId[id].count, expected.count, id);
  }
  for (const row of results) {
    if (!row.id.startsWith("reject-")) continue;
    assert.equal(row.outcome, "rejected", `${row.id} must fail closed`);
    assert.equal(typeof row.error, "string", `${row.id}: rejection carries the classifier's message`);
    assert.ok(row.error.length > 0, `${row.id}: rejection message is not empty`);
  }
  assert.match(byId["reject-positive-count-without-record-list"].error, /positive count without a rendered record list/);
  assert.match(byId["reject-zero-count-without-zero-copy"].error, /zero count without the published-zero copy/);
  assert.match(byId["reject-unavailable-mixed-with-zero-copy"].error, /mixed with generic or zero copy/);
  assert.match(byId["reject-unavailable-mixed-with-generic-copy"].error, /mixed with generic or zero copy/);
  assert.match(byId["reject-no-typed-state"].error, /matches no typed published coverage state/);
  assert.match(byId["reject-unexpected-schema"].error, /unexpected schema/);
  assert.match(byId["reject-missing-results-html"].error, /no results_html/);
  assert.match(byId["reject-unexpected-http-status"].error, /unexpected HTTP 500/);
  assert.match(byId["reject-error-status-with-deferred-schema"].error, /unexpected HTTP 503/);
});
