/**
 * Exact location and bounded property coverage for tracked issues.
 *
 * A1 — the 3218 Emmons Avenue fixture resolves through the committed PAD
 *       snapshot mechanism to BBL 3088150590, retaining method, PAD version,
 *       and snapshot date, and links the canonical parcel route.
 * A2 — when a bounded property or certificate-of-occupancy lookup has no
 *       observation for the BBL, copy names that dataset and its
 *       checked-through date and never claims the record classes are empty.
 * A3 — exact, ambiguous, and unresolved address fixtures prove only the exact
 *       result emits a parcel link, and later ambiguity suppresses it.
 * A4 — resident copy rejects broad negative phrases whenever the underlying
 *       state is unsearched, unavailable, stale, or absent from a bounded
 *       slice.
 *
 * Journey dimensions (static render, narrow copy, keyboard, no JavaScript,
 * failed load) are asserted against the same rendered fragments the committed
 * capture manifest under docs/evidence/tracked-issue-parcel-coverage/
 * records; proof is the manifest, never a committed image.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildAddressIndexFromPadLines } from "../tools/lib/geocoder_address_index.mjs";
import {
  addressShardKey,
  parseAddressQuery,
  resolveAddressFromShard,
} from "../site/precomputed_address_geocoder.mjs";
import {
  buildTrackedIssueCoverage,
  buildTrackedIssueLocation,
  canonicalParcelRoute,
  renderTrackedIssueLocationHTML,
  TRACKED_ISSUE_COVERAGE_DATASETS,
  TRACKED_ISSUE_LOCATION_SCHEMA,
} from "../site/tracked_issue_location.mjs";
import { ABSENCE_REASONS } from "../site/edge_summary.mjs";

const EMMONS_ADDRESS = "3218 Emmons Avenue, Brooklyn";
const EMMONS_BBL = "3088150590";
const PAD_FIXTURE = new URL("fixtures/geocoder/pad-emmons-parcel.csv", import.meta.url);
const PAD_SNAPSHOT_DATE = "2026-08-17T11:24:50.716Z";
const PAD_VERSION = "26b";

/** Broad negatives the resident surface must never emit for these states. */
const BROAD_NEGATIVE_PHRASES =
  /\b(?:no|zero|without|lacks?|has\s+no|shows\s+no|found\s+no)\s+(?:permits?|violations?|building\s+records?|construction\s+records?|dob\s+records?|property\s+records?|certificates?(?:\s+of\s+occupancy)?|c\.?o\.?s?|occupancy\s+records?)\b/i;

const committedJson = (path) => JSON.parse(readFileSync(new URL(`../site/data/${path}`, import.meta.url), "utf8"));

/** The resident long-form date the copy must carry for a through-date. */
function formattedThroughDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
}

async function emmonsFixtureGeocoderResult() {
  const text = readFileSync(PAD_FIXTURE, "utf8");
  const built = await buildAddressIndexFromPadLines(text.trimEnd().split(/\r?\n/), {
    generatedAt: PAD_SNAPSHOT_DATE,
    sourceSha256: "fixture-sha256",
    sourceVersion: PAD_VERSION,
    shardCount: 64,
  });
  const query = parseAddressQuery(EMMONS_ADDRESS);
  return resolveAddressFromShard(query, built.shards.get(addressShardKey(query.street, 64)), built.manifest);
}

/** Minimal inline shard shaped like the committed PAD snapshot. */
function inlineShard(streets) {
  const key = addressShardKey(Object.keys(streets)[0]);
  return { schema: "cityscroll.address-index-shard.v1", key, streets };
}

const emmonsRangeRow = [3208000, 3218000, 2, EMMONS_BBL, "11235"];

// --- A1: exact PAD evidence is retained and the parcel route is linked ------

test("A1: the address fixture resolves through the committed PAD snapshot to the exact BBL", async () => {
  const geocode = await emmonsFixtureGeocoderResult();
  assert.equal(geocode.status, "matched");
  assert.equal(geocode.bbl, EMMONS_BBL);
  assert.equal(geocode.method, "nyc_dcp_pad_snapshot");

  const location = buildTrackedIssueLocation({ address: EMMONS_ADDRESS, geocode });
  assert.equal(location.schema, TRACKED_ISSUE_LOCATION_SCHEMA);
  assert.equal(location.exact, true);
  assert.equal(location.bbl, EMMONS_BBL);
  assert.equal(location.method, "nyc_dcp_pad_snapshot");
  assert.equal(location.source_version, PAD_VERSION);
  assert.equal(location.snapshot_date, PAD_SNAPSHOT_DATE);
  assert.equal(location.parcel.subject_ref, `bbl:${EMMONS_BBL}`);
  assert.equal(location.parcel.href, canonicalParcelRoute(EMMONS_BBL));
  assert.equal(location.parcel.href, `/parcels/${EMMONS_BBL}/`);
  assert.match(location.parcel.label, /Brooklyn — Block 8815, Lot 590/);
});

// --- A2: absence copy names the dataset and its through-date ----------------

test("A2: an absent bounded lookup names its dataset and checked-through date without blanket negative claims", () => {
  const cofo = committedJson("dob_cofo_lookup.json");
  const crossDomain = committedJson("property_cross_domain_lookup.json");
  const now = `${cofo.source_generated_at.slice(0, 10)}T12:00:00.000Z`;
  const coverage = buildTrackedIssueCoverage({ bbl: EMMONS_BBL, crossDomain, cofo, now });

  assert.equal(coverage.ok, true);
  assert.equal(coverage.datasets.length, 2);
  for (const entry of coverage.datasets) {
    assert.equal(entry.observation_count, 0, `${entry.dataset_id} should have no rows for this BBL fixture`);
    assert.equal(entry.state, "absent_bounded");
    assert.equal(entry.absence_reason, ABSENCE_REASONS.CHECKED_NO_RECORD);
    assert.ok(entry.dataset_name.length > 5, "dataset must be named");
    assert.ok(
      entry.copy.includes(formattedThroughDate(entry.through_date)),
      `copy must carry the checked-through date ${entry.through_date}: ${entry.copy}`,
    );
    assert.ok(entry.copy.includes(entry.dataset_name), "copy must name the dataset");
    assert.doesNotMatch(entry.copy, BROAD_NEGATIVE_PHRASES);
  }
});

test("A2: an observed bounded lookup keeps its count, dataset name, and through-date", () => {
  const cofo = committedJson("dob_cofo_lookup.json");
  const observedBbl = Object.keys(cofo.by_bbl)[0];
  const now = `${cofo.source_generated_at.slice(0, 10)}T12:00:00.000Z`;
  const coverage = buildTrackedIssueCoverage({ bbl: observedBbl, crossDomain: { provenance: {} }, cofo, now });
  const cofoEntry = coverage.datasets.find((entry) => entry.dataset_id === "certificate_of_occupancy");
  assert.equal(cofoEntry.state, "observed");
  assert.ok(cofoEntry.observation_count > 0);
  assert.ok(cofoEntry.copy.includes(`${cofoEntry.observation_count} records`));
  assert.ok(cofoEntry.copy.includes(cofoEntry.dataset_name));
  assert.ok(cofoEntry.copy.includes(formattedThroughDate(cofoEntry.through_date)));
  assert.doesNotMatch(cofoEntry.copy, BROAD_NEGATIVE_PHRASES);
});

// --- A3: only an exact match links the parcel; later ambiguity suppresses ---

test("A3: exact, ambiguous, and unresolved fixtures emit a parcel link only for the exact case", () => {
  const manifest = { source: { version: PAD_VERSION }, generated_at: PAD_SNAPSHOT_DATE };
  const exactShard = inlineShard({ "EMMONS AVE": [emmonsRangeRow] });
  const ambiguousShard = inlineShard({
    "EMMONS AVE": [
      emmonsRangeRow,
      [3208000, 3218000, 2, "3088150601", "11235"],
    ],
  });
  const emptyShard = inlineShard({ "EMMONS AVE": [] });
  const query = parseAddressQuery(EMMONS_ADDRESS);

  const exact = buildTrackedIssueLocation({
    address: EMMONS_ADDRESS,
    geocode: resolveAddressFromShard(query, exactShard, manifest),
  });
  assert.equal(exact.exact, true);
  assert.ok(exact.parcel, "exact match must link the parcel");

  const ambiguous = buildTrackedIssueLocation({
    address: EMMONS_ADDRESS,
    geocode: resolveAddressFromShard(query, ambiguousShard, manifest),
  });
  assert.equal(ambiguous.exact, false);
  assert.equal(ambiguous.parcel, null);
  assert.equal(ambiguous.unresolved_reason, "ambiguous");

  const unresolved = buildTrackedIssueLocation({
    address: EMMONS_ADDRESS,
    geocode: resolveAddressFromShard(query, emptyShard, manifest),
  });
  assert.equal(unresolved.exact, false);
  assert.equal(unresolved.parcel, null);
  assert.equal(unresolved.unresolved_reason, "not_covered");

  const nonSnapshotMethod = buildTrackedIssueLocation({
    address: EMMONS_ADDRESS,
    geocode: { status: "matched", bbl: EMMONS_BBL, method: "hand_geocode" },
  });
  assert.equal(nonSnapshotMethod.exact, false, "a match without the PAD snapshot method is not exact evidence");
  assert.equal(nonSnapshotMethod.parcel, null);
});

test("A3: a later ambiguous resolution suppresses a previously exact parcel link", () => {
  const manifest = { source: { version: PAD_VERSION }, generated_at: PAD_SNAPSHOT_DATE };
  const exactShard = inlineShard({ "EMMONS AVE": [emmonsRangeRow] });
  const ambiguousShard = inlineShard({
    "EMMONS AVE": [
      emmonsRangeRow,
      [3208000, 3218000, 2, "3088150601", "11235"],
    ],
  });
  const query = parseAddressQuery(EMMONS_ADDRESS);
  const resolutions = [
    resolveAddressFromShard(query, exactShard, manifest),
    resolveAddressFromShard(query, ambiguousShard, manifest),
  ];
  const location = resolutions.reduce(
    (view, geocode) => buildTrackedIssueLocation({ address: EMMONS_ADDRESS, geocode }),
    null,
  );
  assert.equal(location.exact, false, "the latest resolution governs the link");
  assert.equal(location.parcel, null);
  assert.equal(location.unresolved_reason, "ambiguous");
  const html = renderTrackedIssueLocationHTML(location);
  assert.doesNotMatch(html, /\/parcels\//);
  assert.match(html, /more than one parcel/);
});

// --- A4: no broad negative copy for unsearched, unavailable, stale, absent --

const syntheticCrossDomain = (through, notices) => ({
  generated_at: "2026-09-01T00:00:00.000Z",
  provenance: { property_feed: { source_generated_at: through } },
  by_bbl: notices
    ? { [EMMONS_BBL]: { bbl: EMMONS_BBL, parcel_ref: `bbl:${EMMONS_BBL}`, property_notices: notices } }
    : {},
  coverage: {},
});
const syntheticCofo = (through, rows) => ({
  source_generated_at: through,
  by_bbl: rows ? { [EMMONS_BBL]: rows } : {},
  coverage: {},
});

test("A4: unsearched, unavailable, stale, and bounded-absent states carry distinct honest copy with no broad negatives", () => {
  const states = {
    unsearched: { property: { unsearched: true }, cofo: undefined },
    unavailable: { property: { unavailable: true }, cofo: { unavailable: true } },
    stale: { property: syntheticCrossDomain("2026-01-01T00:00:00.000Z", null), cofo: syntheticCofo("2026-01-01T00:00:00.000Z", null) },
    absent_bounded: { property: syntheticCrossDomain("2026-09-05T00:00:00.000Z", null), cofo: syntheticCofo("2026-09-01T00:00:00.000Z", null) },
  };
  const copies = new Map();
  for (const [state, inputs] of Object.entries(states)) {
    const coverage = buildTrackedIssueCoverage({
      bbl: EMMONS_BBL,
      property: inputs.property,
      certificateOfOccupancy: inputs.cofo,
      now: "2026-09-10T00:00:00.000Z",
    });
    for (const entry of coverage.datasets) {
      assert.equal(entry.state, state, `${entry.dataset_id} expected state ${state}`);
      assert.ok(entry.copy.length > 10, `${state}/${entry.dataset_id} needs copy`);
      assert.doesNotMatch(entry.copy, BROAD_NEGATIVE_PHRASES, `${state}/${entry.dataset_id}: ${entry.copy}`);
      assert.ok(entry.copy.includes(entry.dataset_name), `${state}/${entry.dataset_id} copy must name the dataset`);
      copies.set(`${state}:${entry.dataset_id}`, entry.copy);
    }
  }
  assert.equal(new Set(copies.values()).size, copies.size, "each state and dataset needs distinct copy");

  const staleCopy = copies.get("stale:certificate_of_occupancy");
  assert.match(staleCopy, /January 1, 2026/);
  assert.match(staleCopy, /30-day freshness/);
  const absentCopy = copies.get("absent_bounded:property_disposition");
  assert.match(absentCopy, /Checked City Record property disposition notices through September 5, 2026/);
  assert.match(absentCopy, /not a finding about any other city record/);
});

test("A4: the rendered resident surface keeps the same boundary in every state", () => {
  const manifest = { source: { version: PAD_VERSION }, generated_at: PAD_SNAPSHOT_DATE };
  const exactShard = inlineShard({ "EMMONS AVE": [emmonsRangeRow] });
  const location = buildTrackedIssueLocation({
    address: EMMONS_ADDRESS,
    geocode: resolveAddressFromShard(parseAddressQuery(EMMONS_ADDRESS), exactShard, manifest),
  });
  const scenarios = {
    unsearched: buildTrackedIssueCoverage({ bbl: EMMONS_BBL }),
    unavailable: buildTrackedIssueCoverage({
      bbl: EMMONS_BBL,
      property: { unavailable: true },
      certificateOfOccupancy: { unavailable: true },
    }),
    stale: buildTrackedIssueCoverage({
      bbl: EMMONS_BBL,
      property: syntheticCrossDomain("2026-01-01T00:00:00.000Z", null),
      certificateOfOccupancy: syntheticCofo("2026-01-01T00:00:00.000Z", null),
      now: "2026-09-10T00:00:00.000Z",
    }),
    absent_bounded: buildTrackedIssueCoverage({
      bbl: EMMONS_BBL,
      property: syntheticCrossDomain("2026-09-05T00:00:00.000Z", null),
      certificateOfOccupancy: syntheticCofo("2026-09-01T00:00:00.000Z", null),
      now: "2026-09-10T00:00:00.000Z",
    }),
  };
  for (const [state, coverage] of Object.entries(scenarios)) {
    const html = renderTrackedIssueLocationHTML(location, coverage);
    const text = html.replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(text, BROAD_NEGATIVE_PHRASES, `${state} rendered surface: ${text}`);
    assert.ok((html.match(/data-coverage-state=/g) || []).length >= 2, `${state} needs per-dataset state markers`);
    for (const dataset of Object.values(TRACKED_ISSUE_COVERAGE_DATASETS)) {
      assert.ok(html.includes(`data-coverage-dataset="${dataset.id}"`), `${state} must render ${dataset.id}`);
    }
  }
});

// --- Journey checks: default view, disclosure, no-JS, keyboard, failed load -

test("journey: the default view shows the civic fact statically with script-free provenance disclosure", async () => {
  const location = buildTrackedIssueLocation({ address: EMMONS_ADDRESS, geocode: await emmonsFixtureGeocoderResult() });
  const coverage = buildTrackedIssueCoverage({
    bbl: EMMONS_BBL,
    property: syntheticCrossDomain("2026-09-05T00:00:00.000Z", null),
    certificateOfOccupancy: syntheticCofo("2026-09-01T00:00:00.000Z", null),
    now: "2026-09-10T00:00:00.000Z",
  });
  const html = renderTrackedIssueLocationHTML(location, coverage);

  // No JavaScript is required: the fragment carries no script and every fact
  // is already in the static markup.
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /3218 Emmons Ave, Brooklyn 11235/);
  assert.match(html, /href="\/parcels\/3088150590\/"/);

  // Keyboard: the parcel link is a real anchor; provenance sits in native
  // details/summary disclosures that keyboard and assistive tech can operate.
  const anchors = [...html.matchAll(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([^<]+)<\/a>/g)];
  assert.ok(anchors.length >= 1, "parcel link must be an anchor with a real href");
  for (const [, href] of anchors) assert.ok(/^https?:\/\/|^\//.test(href), `href must be reachable: ${href}`);
  const disclosures = html.match(/<details[^>]*><summary>/g) || [];
  assert.ok(disclosures.length >= 3, "method provenance and each dataset disclosure use details/summary");

  // The exact-parcel method stays behind disclosure, not in default copy.
  const defaultText = html.replace(/<details[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(defaultText, /PAD|snapshot/i);
  assert.match(html, /version 26b/);
  assert.match(html, /August 17, 2026/);
});

test("journey: a failed load keeps the requested scope and offers a truthful retry and source path", async () => {
  const location = buildTrackedIssueLocation({ address: EMMONS_ADDRESS, geocode: await emmonsFixtureGeocoderResult() });
  const coverage = buildTrackedIssueCoverage({
    bbl: EMMONS_BBL,
    property: { unavailable: true },
    certificateOfOccupancy: { unavailable: true },
  });
  const html = renderTrackedIssueLocationHTML(location, coverage);

  // The requested scope survives the failure: address and exact parcel remain.
  assert.match(html, /3218 Emmons Ave, Brooklyn 11235/);
  assert.match(html, /href="\/parcels\/3088150590\/"/);
  const text = html.replace(/<[^>]+>/g, " ");
  for (const dataset of Object.values(TRACKED_ISSUE_COVERAGE_DATASETS)) {
    assert.match(text, new RegExp(dataset.name));
  }
  assert.match(text, /could not be checked just now/);
  assert.match(text, /Reload this page to retry/);
  // A truthful source path exists for each failed dataset.
  for (const dataset of Object.values(TRACKED_ISSUE_COVERAGE_DATASETS)) {
    assert.ok(html.includes(`href="${dataset.official_href}"`), `official source path missing for ${dataset.id}`);
  }
  assert.doesNotMatch(text, BROAD_NEGATIVE_PHRASES);
});

test("journey: unresolved and failed-geocode states stay honest without a parcel link", () => {
  const manifest = { source: { version: PAD_VERSION }, generated_at: PAD_SNAPSHOT_DATE };
  const ambiguousShard = inlineShard({
    "EMMONS AVE": [
      emmonsRangeRow,
      [3208000, 3218000, 2, "3088150601", "11235"],
    ],
  });
  const ambiguous = buildTrackedIssueLocation({
    address: EMMONS_ADDRESS,
    geocode: resolveAddressFromShard(parseAddressQuery(EMMONS_ADDRESS), ambiguousShard, manifest),
  });
  const ambiguousHtml = renderTrackedIssueLocationHTML(ambiguous);
  assert.doesNotMatch(ambiguousHtml, /\/parcels\//);
  assert.match(ambiguousHtml, /more than one parcel/);

  const unavailableGeocode = buildTrackedIssueLocation({
    address: EMMONS_ADDRESS,
    geocode: { status: "unknown", reason: "snapshot_unavailable" },
  });
  const unavailableHtml = renderTrackedIssueLocationHTML(unavailableGeocode);
  assert.doesNotMatch(unavailableHtml, /\/parcels\//);
  assert.match(unavailableHtml, /could not be checked just now/);
  assert.match(unavailableHtml, /Reload this page to retry/);
});
