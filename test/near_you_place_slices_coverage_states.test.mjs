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
  decideLocalGeographyPublicationActivation,
  decideNearYouManifestActivation,
  placeCoverageState,
  requiredNearYouSliceIds,
  residentialPlacesFromNtaLayer,
} from "../tools/build_worker_route_read_models.mjs";
import {
  geographyCoverageForLens,
  geographyRecordProjection,
} from "../site/geography_navigation_records.mjs";
import {
  LAND_GEOGRAPHY_ARTIFACT_UNAVAILABLE,
  landNtaWatchMatchingIds,
  transformLandGeographyWatchRows,
} from "../site/land_nta_watch_scope.mjs";

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
// Current resident copy for the structured local recovery states.
const LOCAL_UNSUPPORTED_COPY = "We can\u2019t filter these meetings to this neighborhood yet.";
const LOCAL_ZERO_COPY = "No mapped meetings match these filters.";
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
    const unavailableResults = JSON.parse(byId[code].body).results_html;
    assert.match(unavailableResults, /data-near-local-recovery="unsupported"/, code);
    assert.match(unavailableResults, new RegExp(escapeRe(LOCAL_UNSUPPORTED_COPY)), code);
    assert.doesNotMatch(unavailableResults, new RegExp(escapeRe(LOCAL_ZERO_COPY)), code);
  }
  const bxResults = JSON.parse(byId.BX0101.body).results_html;
  assert.match(bxResults, /data-results-count="0"/);
  assert.match(bxResults, /data-near-local-recovery="zero"/);
  assert.match(bxResults, new RegExp(escapeRe(LOCAL_ZERO_COPY)));
  assert.equal(servedCount(byId.MN0102.body) >= 1, true, "positive membership publishes a positive count");

  const results = classifyCases(cases);
  const resultById = Object.fromEntries(results.map((row) => [row.id, row]));
  const expected = {
    MN0102: { state: "available_records", count: servedCount(byId.MN0102.body) },
    BX0101: { state: "published_zero", count: 0, typed_copy: LOCAL_ZERO_COPY },
    BK0101: { state: "unavailable_source_coverage", count: null, typed_copy: LOCAL_UNSUPPORTED_COPY },
    QN0103: { state: "unavailable_source_coverage", count: null, typed_copy: LOCAL_UNSUPPORTED_COPY },
    SI0101: { state: "unavailable_source_coverage", count: null, typed_copy: LOCAL_UNSUPPORTED_COPY },
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
    assert.equal(row.body.includes("data-near-local-recovery"), false, `${row.id}: transient failure never renders a local recovery state`);
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
  const recoveryBlock = (state, copy) =>
    `<div class="near-coverage near-local-recovery" data-near-local-recovery="${state}" data-near-local-recovery-surface="records" role="note">\n      <strong>${copy}</strong></div>`;
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
      id: "synthetic-recovery-published-zero",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: resultsSection(`data-results-count="0">${recoveryBlock("zero", LOCAL_ZERO_COPY)}`) }),
    },
    {
      id: "synthetic-recovery-unavailable-source-coverage",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: resultsSection(`>${recoveryBlock("unsupported", "We can&#39;t filter these meetings to this neighborhood yet.")}`) }),
    },
    {
      id: "reject-two-recovery-states",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: resultsSection(`>${recoveryBlock("unsupported", LOCAL_UNSUPPORTED_COPY)}${recoveryBlock("zero", LOCAL_ZERO_COPY)}`) }),
    },
    {
      id: "reject-recovery-zero-mixed-with-legacy-zero-copy",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: resultsSection(`data-results-count="0">${recoveryBlock("zero", LOCAL_ZERO_COPY)}${ZERO_COPY}`) }),
    },
    {
      id: "reject-recovery-unsupported-mixed-with-legacy-unavailable-copy",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: resultsSection(`>${recoveryBlock("unsupported", LOCAL_UNSUPPORTED_COPY)}${UNAVAILABLE_COPY}`) }),
    },
    {
      id: "reject-recovery-state-without-typed-copy",
      status: 200,
      body: JSON.stringify({ schema: DEFERRED_SCHEMA, results_html: resultsSection(`>${recoveryBlock("unsupported", "")}`) }),
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
    "synthetic-recovery-published-zero": { state: "published_zero", count: 0, typed_copy: LOCAL_ZERO_COPY },
    "synthetic-recovery-unavailable-source-coverage": {
      state: "unavailable_source_coverage",
      count: null,
      typed_copy: "We can't filter these meetings to this neighborhood yet.",
    },
  };
  for (const [id, expected] of Object.entries(want)) {
    assert.equal(byId[id].outcome, "classified", id);
    assert.equal(byId[id].state, expected.state, id);
    if ("count" in expected) assert.equal(byId[id].count, expected.count, id);
    if ("typed_copy" in expected) assert.equal(byId[id].typed_copy, expected.typed_copy, id);
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
  assert.match(byId["reject-two-recovery-states"].error, /more than one local recovery state/);
  assert.match(byId["reject-recovery-zero-mixed-with-legacy-zero-copy"].error, /zero count without the published-zero copy/);
  assert.match(byId["reject-recovery-unsupported-mixed-with-legacy-unavailable-copy"].error, /mixed with generic or zero copy/);
  assert.match(byId["reject-recovery-state-without-typed-copy"].error, /matches no typed published coverage state/);
  assert.match(byId["reject-unexpected-schema"].error, /unexpected schema/);
  assert.match(byId["reject-missing-results-html"].error, /no results_html/);
  assert.match(byId["reject-unexpected-http-status"].error, /unexpected HTTP 500/);
  assert.match(byId["reject-error-status-with-deferred-schema"].error, /unexpected HTTP 503/);
});

// --- Coverage metadata through route publication (public alias c419deec4d475)
//
// A compact fixture extracted verbatim from a pinned commit carries the Land
// coverage shape (index status, per-lens generation and source dates, and the
// nta2020 type row) with the BK1503 missing-meetings, BX0101 explicit [] and
// MN0102 positive memberships. Each case compares the same key/lens projection
// on the full artifact with the one read back through the real builder, an
// in-memory KV, and loadNearYouActivity.

const pinned = readJson("test/fixtures/near_you_coverage_semantics.v1.json");
const PINNED_KEYS = pinned.keys;
const PINNED_RESIDENTIAL = pinned.residential_places;

function pinnedActivity(mutate = () => {}) {
  const activity = structuredClone(pinned.activity);
  mutate(activity);
  return activity;
}

function readCountingKv(values) {
  const reads = [];
  return { reads, store: { async get(key) { reads.push(key); return values.get(key) || null; } } };
}

// Publish through the real builder, load through the real loader, and require
// that the observation actually traversed the published slice: a loader stub
// that returns the source object (or any value not read from KV) is refused.
async function publishAndLoad(activity, key, lens, { load = loadNearYouActivity, transform = (v) => v } = {}) {
  const version = `coverage-${lens}`;
  const built = buildNearYou(activity, {}, version, { residentialPlaces: PINNED_RESIDENTIAL });
  const values = new Map(built.entries.map(({ key: k, value }) => [k, transform(value)]));
  values.set(NEAR_YOU_MANIFEST_KEY, JSON.stringify(built.manifest));
  const sliceKey = built.manifest.slices[`${key}:${lens}`];
  const { reads, store } = readCountingKv(values);
  const loaded = await load({ ALERT_STATE: store }, { place: { geographies: [key] }, facets: { domains: [lens] } }, lens);
  const traversed = reads.includes(sliceKey) && loaded?.version === version && loaded.activity !== activity;
  return { built, values, sliceKey, loaded, traversed, slice: JSON.parse(values.get(sliceKey)) };
}

function projectionFacts(projection) {
  return { state: projection.state, exact: projection.exact, count: projection.count, ids: [...projection.ids] };
}

// Findings, never a bare boolean: a failure names what diverged.
async function roundTripFindings(activity, key, lens, options = {}) {
  const findings = [];
  const before = geographyRecordProjection(activity, { key, lens });
  const { loaded, traversed, slice } = await publishAndLoad(activity, key, lens, options);
  if (!traversed) findings.push("observation did not traverse the published slice");
  const after = geographyRecordProjection(loaded.activity, { key, lens });
  if (JSON.stringify(projectionFacts(before)) !== JSON.stringify(projectionFacts(after))) {
    findings.push(`projection ${JSON.stringify(projectionFacts(before))} became ${JSON.stringify(projectionFacts(after))}`);
  }
  const expectedCoverage = geographyCoverageForLens(activity.geography_items.coverage, lens);
  const loadedCoverage = loaded.activity.geography_items?.coverage;
  if (JSON.stringify(expectedCoverage) !== JSON.stringify(loadedCoverage)) {
    findings.push(`coverage ${JSON.stringify(expectedCoverage)?.slice(0, 80)} became ${JSON.stringify(loadedCoverage)?.slice(0, 80)}`);
  }
  return { findings, before, after, loaded, slice };
}

function flipNtaLandCoverage(activity) {
  activity.geography_items.coverage.by_lens.land.types.nta2020.status = "unavailable";
  activity.geography_items.coverage.by_lens.land.types.nta2020.reason = "source_generation_failed";
}

test("A1: an unavailable nta2020 Land coverage never publishes its old IDs as current exact membership", async () => {
  const key = PINNED_KEYS.positive_meetings;
  const flipped = pinnedActivity(flipNtaLandCoverage);
  const oldIds = flipped.geography_items.by_key[key].land;
  assert.ok(oldIds.length > 0, "the old IDs are still present in the source");

  const before = geographyRecordProjection(flipped, { key, lens: "land" });
  assert.deepEqual(projectionFacts(before), { state: "unavailable", exact: false, count: null, ids: [] });

  const { findings, after, loaded, slice } = await roundTripFindings(flipped, key, "land");
  assert.deepEqual(findings, []);
  assert.deepEqual(projectionFacts(after), { state: "unavailable", exact: false, count: null, ids: [] });
  // The failure is carried, not the absence of data: the slice still lists the
  // old IDs, and its coverage row is what keeps them from counting.
  assert.deepEqual(slice.activity.geography_items.by_key[key].land, oldIds);
  assert.equal(slice.activity.geography_items.coverage.by_lens.land.types.nta2020.status, "unavailable");
  assert.equal(slice.coverage.state, "source_unavailable");
  assert.equal(placeCoverageState(flipped, key, "land"), "source_unavailable");

  // The Worker Land watch reads the same loaded metadata and refuses too.
  assert.throws(
    () => transformLandGeographyWatchRows(loaded, { status: "all", stage: "any", geographies: [key] }, { catalogRows: [] }),
    (error) => error?.code === LAND_GEOGRAPHY_ARTIFACT_UNAVAILABLE,
  );

  // Converse control: the unflipped pinned coverage publishes the same IDs as
  // current exact membership, and the watch accepts the loaded artifact.
  const ready = await roundTripFindings(pinnedActivity(), key, "land");
  assert.deepEqual(ready.findings, []);
  assert.deepEqual(projectionFacts(ready.after), { state: "ready", exact: true, count: oldIds.length, ids: [...oldIds].map(String).sort() });
  assert.equal(ready.slice.coverage.state, "ready");
  const watch = landNtaWatchMatchingIds({
    filter: { status: "all", stage: "any", geographies: [key] }, activityPayload: ready.loaded, source: "activity",
  });
  assert.equal(watch.status, "ready");
});

test("A2: ready, explicit zero, unfilterable, incomplete and error round-trip with their generation fields", async () => {
  const landGeneration = pinned.activity.geography_items.coverage.by_lens.land;
  const cases = [
    { name: "positive meetings (MN0102)", key: PINNED_KEYS.positive_meetings, lens: "meetings", state: "ready" },
    { name: "positive land (MN0102)", key: PINNED_KEYS.positive_meetings, lens: "land", state: "ready" },
    { name: "explicit zero meetings (BX0101)", key: PINNED_KEYS.explicit_zero_meetings, lens: "meetings", state: "zero" },
    { name: "missing meetings lens (BK1503)", key: PINNED_KEYS.unfilterable_meetings, lens: "meetings", state: "unfilterable" },
    {
      name: "non-list membership",
      key: PINNED_KEYS.explicit_zero_meetings,
      lens: "meetings",
      state: "incomplete",
      mutate: (a) => { a.geography_items.by_key[PINNED_KEYS.explicit_zero_meetings].meetings = null; },
    },
    {
      name: "partial Land lens coverage",
      key: PINNED_KEYS.explicit_zero_meetings,
      lens: "land",
      state: "incomplete",
      mutate: (a) => { a.geography_items.coverage.by_lens.land.status = "partial"; },
    },
    {
      name: "failed coverage index",
      key: PINNED_KEYS.positive_meetings,
      lens: "meetings",
      state: "error",
      mutate: (a) => { a.geography_items.coverage.status = "error"; },
    },
    { name: "unpublished residential neighborhood", key: PINNED_KEYS.unpublished, lens: "meetings", state: "unavailable" },
  ];
  for (const row of cases) {
    const activity = pinnedActivity(row.mutate);
    const { findings, before, after, loaded } = await roundTripFindings(activity, row.key, row.lens);
    assert.deepEqual(findings, [], row.name);
    assert.equal(before.state, row.state, row.name);
    assert.equal(after.state, row.state, row.name);
    assert.equal(after.exact, row.state === "ready" || row.state === "zero", row.name);
    assert.equal(after.count === null, !(row.state === "ready" || row.state === "zero"), row.name);
    if (row.lens === "land") {
      const lensCoverage = loaded.activity.geography_items.coverage.by_lens.land;
      assert.equal(lensCoverage.generation_id, landGeneration.generation_id, row.name);
      assert.equal(lensCoverage.content_id, landGeneration.content_id, row.name);
      assert.deepEqual(lensCoverage.source_dates, landGeneration.source_dates, row.name);
      assert.equal(lensCoverage.types.nta2020.generation_id, landGeneration.types.nta2020.generation_id, row.name);
    } else {
      // Bounded to the requested category: a meetings slice carries no Land row.
      assert.deepEqual(Object.keys(loaded.activity.geography_items.coverage.by_lens), [], row.name);
    }
  }

  // The producer's three meetings shapes stay distinct, and no Land or
  // Property member is lent to BK1503 as meetings membership.
  const { after: bk } = await roundTripFindings(pinnedActivity(), PINNED_KEYS.unfilterable_meetings, "meetings");
  assert.deepEqual(bk.ids, []);
  assert.equal(bk.count, null);
  assert.equal(Object.hasOwn(pinned.activity.geography_items.by_key[PINNED_KEYS.unfilterable_meetings], "meetings"), false);
});

test("A4: a legacy slice without coverage keeps explicit membership and unavailable-key behavior", async () => {
  const legacy = pinnedActivity((a) => { delete a.geography_items.coverage; });
  const expected = [
    [PINNED_KEYS.positive_meetings, "meetings", "ready"],
    [PINNED_KEYS.explicit_zero_meetings, "meetings", "zero"],
    [PINNED_KEYS.unfilterable_meetings, "meetings", "unfilterable"],
    [PINNED_KEYS.unpublished, "meetings", "unavailable"],
    [PINNED_KEYS.unpublished, "land", "unavailable"],
  ];
  for (const [key, lens, state] of expected) {
    const { findings, after, slice } = await roundTripFindings(legacy, key, lens);
    assert.deepEqual(findings, [], `${key}:${lens}`);
    assert.equal(after.state, state, `${key}:${lens}`);
    assert.equal(Object.hasOwn(slice.activity.geography_items, "coverage"), false, "no coverage is invented for a legacy source");
  }

  // Absent coverage is not permission to publish zero: every published zero
  // corresponds to an explicit [] in the source membership.
  const built = buildNearYou(legacy, {}, "legacy-census", { residentialPlaces: PINNED_RESIDENTIAL });
  const zeros = Object.entries(built.coverageBySlice).filter(([sliceId, state]) => state === "zero" && sliceId.startsWith("geography:"));
  assert.ok(zeros.length > 0, "the census includes explicit zeros");
  for (const [sliceId] of zeros) {
    const lens = sliceId.split(":").at(-1);
    const key = sliceId.slice(0, -(lens.length + 1));
    const source = legacy.geography_items.by_key[key]?.[lens];
    assert.ok(Array.isArray(source) && source.length === 0, `${sliceId} published zero without an explicit []`);
  }
  assert.equal(built.coverageBySlice[`${PINNED_KEYS.unpublished}:meetings`], "source_unavailable");
  assert.equal(built.coverageBySlice[`${PINNED_KEYS.unfilterable_meetings}:meetings`], "source_unavailable");
});

test("A5 positive controls: a serializer that drops coverage, and a loader that never reads KV, both fail", async () => {
  const key = PINNED_KEYS.positive_meetings;
  const flipped = pinnedActivity(flipNtaLandCoverage);

  // Mutation: strip coverage from every serialized slice, as the serializer did
  // before this change. The same round-trip checker must report the loss, and
  // the stale IDs would read as current exact membership.
  const stripCoverage = (raw) => {
    const value = JSON.parse(raw);
    if (value.activity?.geography_items) delete value.activity.geography_items.coverage;
    return JSON.stringify(value);
  };
  const mutated = await roundTripFindings(flipped, key, "land", { transform: stripCoverage });
  assert.ok(mutated.findings.some((finding) => finding.startsWith("projection ")), mutated.findings.join("; "));
  assert.ok(mutated.findings.some((finding) => finding.startsWith("coverage ")), mutated.findings.join("; "));
  assert.equal(mutated.after.state, "ready");
  assert.equal(mutated.after.exact, true);

  // A shared constant is not evidence: a loader that hands back the source
  // object makes before and after trivially equal without any publication.
  const echo = async () => ({ activity: flipped, version: "coverage-land" });
  const echoed = await roundTripFindings(flipped, key, "land", { load: echo });
  assert.deepEqual(echoed.findings, ["observation did not traverse the published slice"]);
  const constant = await roundTripFindings(flipped, key, "land", {
    load: async () => ({ activity: structuredClone(flipped), version: "coverage-land" }),
  });
  assert.deepEqual(constant.findings, ["observation did not traverse the published slice"]);
});

test("A6: an invalid candidate built from the pinned rows leaves the prior generation active", () => {
  const prior = buildNearYou(pinnedActivity(), {}, "prior-good", { residentialPlaces: PINNED_RESIDENTIAL });
  const candidate = buildNearYou(pinnedActivity(flipNtaLandCoverage), {}, "candidate", { residentialPlaces: PINNED_RESIDENTIAL });
  const meetingsManifest = { schema_version: 1, kind: "meetings", version: "candidate", slices: {}, id_to_slice: {} };
  const previous = { nearYouManifest: prior.manifest, meetingsManifest: { ...meetingsManifest, version: "prior-good" } };

  // Missing generation dependencies refuse activation.
  const dependencyRefusal = decideLocalGeographyPublicationActivation({
    previous,
    candidate: { nearYouManifest: candidate.manifest, meetingsManifest, nearYouEntries: candidate.entries, meetingsEntries: [] },
    residentialPlaces: PINNED_RESIDENTIAL,
    dependencies: { parcel_membership_generation: null, parcel_coordinate_vintage: "pluto_25v4", assertion_generation: "a", source_generation: "s" },
  });
  assert.equal(dependencyRefusal.activate, false);
  assert.equal(dependencyRefusal.reason, "missing_publication_dependencies");
  assert.equal(dependencyRefusal.active.nearYouManifest.version, "prior-good");

  // An incomplete candidate (a required residential slice missing) refuses.
  const unpublishedSlice = `${PINNED_KEYS.unpublished}:land`;
  const incomplete = {
    ...candidate.manifest,
    slices: Object.fromEntries(Object.entries(candidate.manifest.slices).filter(([sliceId]) => sliceId !== unpublishedSlice)),
  };
  const incompleteRefusal = decideNearYouManifestActivation({
    previousManifest: prior.manifest, candidateManifest: incomplete, residentialPlaces: PINNED_RESIDENTIAL,
  });
  assert.equal(incompleteRefusal.activate, false);
  assert.deepEqual(incompleteRefusal.missing, [unpublishedSlice]);
  assert.equal(incompleteRefusal.activeManifest.version, "prior-good");

  // Converse control: the complete candidate with named dependencies
  // activates, carrying its unavailable coverage as a published state.
  const accepted = decideLocalGeographyPublicationActivation({
    previous,
    candidate: { nearYouManifest: candidate.manifest, meetingsManifest, nearYouEntries: [], meetingsEntries: [] },
    residentialPlaces: PINNED_RESIDENTIAL,
    dependencies: { parcel_membership_generation: "p", parcel_coordinate_vintage: "pluto_25v4", assertion_generation: "a", source_generation: "s" },
  });
  assert.equal(accepted.activate, true);
  assert.equal(accepted.active.nearYouManifest.version, "candidate");
  assert.equal(candidate.coverageBySlice[`${PINNED_KEYS.positive_meetings}:land`], "source_unavailable");
  assert.equal(prior.coverageBySlice[`${PINNED_KEYS.positive_meetings}:land`], "ready");
});
