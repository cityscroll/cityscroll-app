/**
 * Every hearing continuation opens a real, honestly labelled destination.
 *
 * The contract under test is site/legislative_matter_availability.mjs: one
 * availability rule shared by the static meeting document, the meetings card,
 * the first-paint outcome snapshot, and the client-rendered outcome list. A
 * matter identity resolves to a published local history, to that matter's own
 * official record, or to a stated absence — never to a local route the
 * published generation does not carry, and never to a substitute destination.
 *
 * The rule is unchanged; the population it answers over is not. Every exact
 * matter this corpus retains now has a published local history, so the
 * official-record and unavailable branches are exercised against constructed
 * identities the corpus does not contain rather than against a retained matter
 * that happens to be unpublished today. The point of the contract is that the
 * three answers stay distinct and that no surface advertises a route the
 * generation does not carry — not that any particular identity is unpublished.
 *
 * Everything asserted here reads the committed offline corpus
 * (site/data/meeting_outcomes_snapshot.json and its published projection). The
 * counts below describe that retained corpus, not live publisher coverage.
 *
 *   node --test test/legislative_matter_continuation_availability.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import edgeWorker, { edgeRequestKind } from "../site/pages_edge.mjs";
import { buildCouncilHearingActionPath } from "../site/council_hearing_action_path.mjs";
import {
  projectCouncilHearingMatterContinuation,
  renderCouncilHearingMatterContinuation,
} from "../site/council_hearing_matter_continuation.mjs";
import {
  MATTER_HISTORY_LABEL,
  MATTER_OFFICIAL_RECORD_LABEL,
  publishedMatterIds,
  resolveMatterDestination,
} from "../site/legislative_matter_availability.mjs";
import { renderMeetingOutcomesFirstPaint } from "../site/meeting_outcomes_static.mjs";

const snapshot = JSON.parse(readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
const lookup = JSON.parse(readFileSync(new URL("../site/data/legislative_matter_lookup.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../docs/evidence/matter-continuation-availability/manifest.json", import.meta.url), "utf8"));

const PUBLISHED = publishedMatterIds(lookup);

/**
 * An exact identity outside the retained corpus that carries its own official
 * address, and one that carries none. They exercise the two non-local answers
 * without pretending the corpus contains an unpublished matter.
 */
const OFFICIAL_ONLY_MATTER = {
  matter_id: "999998",
  matter_file: "LU 9998-2026",
  title: "Retained identity with an official address and no published history.",
  matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=999998",
};
const ADDRESSLESS_MATTER = {
  matter_id: "999999",
  matter_file: "LU 9999-2026",
  title: "Retained identity without an address.",
};

function constructedOutcome(matters) {
  return {
    snapshot_state: "present",
    join: { matched: true, method: "exact_date_body_tokens" },
    matters,
  };
}

function meeting(requestId, outcome = snapshot.by_notice[requestId]) {
  return {
    source_system: "city_record",
    meeting_id: `meeting:city_record:${requestId}`,
    request_id: requestId,
    event_date: "2026-07-22T11:00:00-04:00",
    meeting_outcome: outcome,
  };
}

/** Every href a rendered surface actually advertises. */
function advertisedHrefs(html) {
  return [...String(html).matchAll(/href="([^"]*)"/g)].map((match) => match[1].replaceAll("&amp;", "&"));
}

const lookupEnv = {
  ASSETS: {
    async fetch(request) {
      if (new URL(request.url).pathname === "/data/legislative_matter_lookup.json") return Response.json(lookup);
      return new Response("missing", { status: 404 });
    },
  },
};

// ---------------------------------------------------------------------------
// A1 — the published matter opens its history; an unpublished one opens its
// own official record. Neither advertises a local route that answers 404.
// ---------------------------------------------------------------------------

test("a published matter opens a local history and an unpublished exact matter opens its official record", async () => {
  const published = resolveMatterDestination({ matter_id: "78605" });
  assert.equal(published.availability, "local_history");
  assert.equal(published.href, "/matters/78605/");
  assert.equal(published.label, MATTER_HISTORY_LABEL);
  assert.equal(published.external, false);

  const official = resolveMatterDestination(OFFICIAL_ONLY_MATTER);
  assert.equal(official.availability, "official_record");
  assert.equal(official.href, OFFICIAL_ONLY_MATTER.matter_url);
  assert.equal(official.label, MATTER_OFFICIAL_RECORD_LABEL);
  assert.equal(official.external, true);
  assert.ok(official.href.startsWith("https://"), "an official record is an https publisher address");

  // Both advertised destinations are answerable: the local one is a page, and
  // the local route the unpublished matter is NOT offered would have 404'd.
  assert.equal(edgeRequestKind("https://cityscroll.org/matters/78605/"), "matter");
  assert.equal((await edgeWorker.fetch(new Request("https://cityscroll.org/matters/78605/"), lookupEnv)).status, 200);
  assert.equal((await edgeWorker.fetch(new Request("https://cityscroll.org/matters/999998/"), lookupEnv)).status, 404);

  const officialHtml = renderCouncilHearingMatterContinuation(
    meeting("20260707022", constructedOutcome([OFFICIAL_ONLY_MATTER])),
  );
  assert.ok(!advertisedHrefs(officialHtml).includes("/matters/999998/"), "no surface advertises the 404 route");
  assert.match(officialHtml, /View official matter record/);
});

test("every matter surface resolves the same identity to the same destination", () => {
  // Both the first-paint snapshot and the continuation must agree with the
  // shared rule rather than with a locally composed href, whichever answer the
  // rule gives for an identity.
  for (const [requestId, matterId] of [["20260428021", "78605"], ["20260707022", "79200"]]) {
    const firstPaint = renderMeetingOutcomesFirstPaint(snapshot, requestId);
    assert.ok(advertisedHrefs(firstPaint).includes(`/matters/${matterId}/`));
    assert.match(firstPaint, /data-matter-availability="local_history"/);

    const continuation = projectCouncilHearingMatterContinuation(meeting(requestId));
    const matter = continuation.matters.find((row) => row.matter_id === matterId);
    assert.equal(matter.destination.href, `/matters/${matterId}/`);
    assert.equal(matter.canonical_href, `/matters/${matterId}/`);
  }

  // An identity the generation does not publish resolves to its own official
  // record on every surface, and to no local route on any of them.
  const outcome = constructedOutcome([OFFICIAL_ONLY_MATTER]);
  const firstPaintOfficial = renderMeetingOutcomesFirstPaint(
    { ...snapshot, by_notice: { ...snapshot.by_notice, 20260707022: outcome } },
    "20260707022",
  );
  assert.ok(advertisedHrefs(firstPaintOfficial).includes(OFFICIAL_ONLY_MATTER.matter_url));
  assert.ok(!advertisedHrefs(firstPaintOfficial).includes("/matters/999998/"));

  const official = projectCouncilHearingMatterContinuation(meeting("20260707022", outcome));
  assert.equal(official.matters[0].destination.href, OFFICIAL_ONLY_MATTER.matter_url);
  assert.equal(official.matters[0].canonical_href, null);
});

// ---------------------------------------------------------------------------
// A2 — a multi-matter hearing keeps every exact choice; an unmatched notice
// acquires no matter and no substitute destination.
// ---------------------------------------------------------------------------

test("a multi-matter hearing preserves all five exact choices with their own destinations", () => {
  const record = meeting("20260707021");
  const projection = projectCouncilHearingMatterContinuation(record);
  assert.equal(projection.state, "multiple");
  assert.deepEqual(projection.matters.map((matter) => matter.matter_id), ["79201", "79203", "79202", "79204", "79205"]);

  const html = renderCouncilHearingMatterContinuation(record);
  const hrefs = advertisedHrefs(html);
  const offered = new Set();
  for (const matter of projection.matters) {
    // Every matter on this hearing has a published history, so each keeps its
    // own local route. None of them borrows another matter's destination.
    assert.equal(matter.destination.availability, "local_history");
    assert.equal(matter.destination.href, `/matters/${matter.matter_id}/`);
    assert.ok(hrefs.includes(matter.destination.href), `${matter.matter_id} is individually selectable`);
    offered.add(matter.destination.href);
  }
  assert.equal(offered.size, projection.matters.length, "five matters, five distinct destinations");
  // The choice remains the reader's: no single matter is promoted.
  assert.equal(buildCouncilHearingActionPath(record).continuation_cta, false);
  assert.match(html, /Choose a matter to open/);
});

test("an unmatched notice acquires no matter, no local route, and no substitute destination", () => {
  const record = meeting("20260728026");
  assert.equal(snapshot.by_notice["20260728026"].snapshot_state, "absent");
  const projection = projectCouncilHearingMatterContinuation(record);
  assert.equal(projection.state, "unmatched");
  assert.equal(projection.matters.length, 0);

  const html = renderCouncilHearingMatterContinuation(record);
  assert.deepEqual(advertisedHrefs(html), []);
  assert.doesNotMatch(html, /data-action-path-continuation/);
  assert.doesNotMatch(html, /committee|Gateway\.aspx|\/matters\//i);
  assert.equal(buildCouncilHearingActionPath(record).continuation, null);
});

// ---------------------------------------------------------------------------
// A3 — navigation copy says what the reader will see, and claims nothing else.
// ---------------------------------------------------------------------------

test("continuation copy names a destination and never claims tracking, subscription, or attribution", () => {
  const surfaces = [
    renderCouncilHearingMatterContinuation(meeting("20260707022")),
    renderCouncilHearingMatterContinuation(meeting("20260707021")),
    renderCouncilHearingMatterContinuation(meeting("20260428021")),
    renderCouncilHearingMatterContinuation(meeting("20260707022", constructedOutcome([OFFICIAL_ONLY_MATTER]))),
    renderMeetingOutcomesFirstPaint(snapshot, "20260428021"),
    renderMeetingOutcomesFirstPaint(snapshot, "20260707022"),
  ];
  const forbidden = [
    /\bfollow(ing|ed|s)?\b/i,
    /\bwatch(ing|ed|es)?\b/i,
    /\bsubscrib/i,
    /\bnotify|notification/i,
    /\bsaved?\b/i,
    /\btrack(ing|ed|s)?\b/i,
    /\btestimony|testif/i,
    /\bsubmitted\b/i,
    /\balert/i,
  ];
  for (const html of surfaces) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(html, pattern, `continuation copy must not claim ${pattern}`);
    }
  }
  assert.match(surfaces[0], new RegExp(MATTER_HISTORY_LABEL));
  assert.match(surfaces[3], new RegExp(MATTER_OFFICIAL_RECORD_LABEL));
});

test("a matter with no reachable destination states that instead of offering a dead control", () => {
  // An exact identity the retained record carries no address for, and which
  // the published generation does not publish either.
  const record = meeting("20260827004", constructedOutcome([ADDRESSLESS_MATTER]));
  const projection = projectCouncilHearingMatterContinuation(record);
  assert.equal(projection.matters[0].destination.availability, "unavailable");
  const html = renderCouncilHearingMatterContinuation(record);
  assert.deepEqual(advertisedHrefs(html), []);
  assert.match(html, /No matter record is available to open/);
  assert.match(html, /LU 9999-2026/, "the identity itself stays visible");
});

// ---------------------------------------------------------------------------
// A4 — the controls are ordinary anchors.
// ---------------------------------------------------------------------------

test("continuation destinations are native anchors with no scripted activation", () => {
  for (const requestId of ["20260707022", "20260707021", "20260428021"]) {
    const html = renderCouncilHearingMatterContinuation(meeting(requestId));
    assert.doesNotMatch(html, /<button/i, "a destination is a link, not a scripted control");
    assert.doesNotMatch(html, /\son[a-z]+="/i, "no inline event handlers");
    assert.doesNotMatch(html, /href="javascript:/i);
    for (const href of advertisedHrefs(html)) {
      assert.ok(href.startsWith("/") || href.startsWith("https://"), `${href} is resolvable without scripting`);
    }
  }
});

// ---------------------------------------------------------------------------
// A5 — every numeric matter continuation in the frozen corpus, enumerated.
// ---------------------------------------------------------------------------

test("no advertised local destination in the frozen corpus is absent from the published lookup", () => {
  const seen = new Map();
  let appearances = 0;
  let advertisedLocal = 0;
  let advertisedOfficial = 0;
  const unavailable = [];

  for (const requestId of Object.keys(snapshot.by_notice)) {
    const projection = projectCouncilHearingMatterContinuation(meeting(requestId));
    if (!projection.strict_join) continue;
    for (const matter of projection.matters) {
      appearances += 1;
      if (!/^\d+$/.test(matter.matter_id)) continue;
      seen.set(matter.matter_id, (seen.get(matter.matter_id) || 0) + 1);
      const { availability, href } = matter.destination;
      if (availability === "local_history") {
        advertisedLocal += 1;
        assert.ok(PUBLISHED.has(matter.matter_id), `${matter.matter_id} advertises a local route it does not publish`);
        assert.equal(href, `/matters/${matter.matter_id}/`);
      } else if (availability === "official_record") {
        advertisedOfficial += 1;
        assert.ok(!PUBLISHED.has(matter.matter_id));
        assert.match(href, /^https:\/\//);
      } else {
        unavailable.push(matter.matter_id);
        assert.equal(href, null);
      }
    }
  }

  // The retained corpus, described rather than summarized: 66 distinct matter
  // identities across 78 appearances, every one of them published locally.
  assert.equal(appearances, 78);
  assert.equal(seen.size, 66);
  assert.deepEqual([...PUBLISHED].sort(), [...seen.keys()].sort());
  assert.equal(advertisedLocal + advertisedOfficial + unavailable.length, 78);
  assert.equal(advertisedLocal, [...seen.entries()].filter(([id]) => PUBLISHED.has(id)).reduce((sum, [, n]) => sum + n, 0));
  assert.equal(advertisedOfficial, 0, "no retained matter falls back to its publisher record");
  assert.deepEqual(unavailable, [], "every exact matter in this corpus resolves to a destination");

  // Every local route advertised anywhere in the corpus is one the generation
  // publishes, and nothing else is advertised as local.
  const advertised = new Set();
  for (const requestId of Object.keys(snapshot.by_notice)) {
    for (const href of advertisedHrefs(renderCouncilHearingMatterContinuation(meeting(requestId)))) {
      if (href.startsWith("/matters/")) advertised.add(href);
    }
  }
  assert.deepEqual(
    [...advertised].sort(),
    [...seen.keys()].sort().map((id) => `/matters/${id}/`),
  );
});

test("resolution preserves source URLs, native identity, observation times and repeated references", () => {
  // Two notices reference the same matter/event pair. That is provenance, not a
  // second hearing: the identity resolves once, to one destination, and both
  // references keep their own request id and observed event.
  const duplicates = ["20260430007", "20260422047"];
  const destinations = new Set();
  for (const requestId of duplicates) {
    const projection = projectCouncilHearingMatterContinuation(meeting(requestId));
    const matter = projection.matters.find((row) => row.matter_id === "78758");
    assert.ok(matter, `${requestId} keeps its reference to matter 78758`);
    assert.equal(projection.request_id, requestId);
    assert.equal(snapshot.by_notice[requestId].event.event_id, "22396");
    destinations.add(matter.destination.href);
  }
  assert.equal(destinations.size, 1, "one identity, one destination, however many references");

  // The published matter keeps its retained appearance history, its source URLs
  // and its observation time. A single-appearance matter is not a failed
  // refresh and no later action is asserted for it.
  const entry = lookup.matters["78605"];
  assert.equal(entry.appearances.length, 2);
  assert.equal(lookup.generated_at, snapshot.generated_at);
  for (const appearance of entry.appearances) {
    assert.match(appearance.event.url, /^https:\/\//);
    assert.ok(appearance.event.event_id);
    assert.equal(appearance.source_receipt.snapshot_generated_at, snapshot.generated_at);
  }
  const single = projectCouncilHearingMatterContinuation(meeting("20260707022"));
  assert.equal(single.state, "single");
  assert.equal(single.matters[0].outcome, "Laid Over by Subcommittee");
});

test("resolving a destination creates no saved watch and reads no publisher at request time", () => {
  const before = JSON.stringify(lookup);
  resolveMatterDestination({ matter_id: "78605" });
  resolveMatterDestination({ matter_id: "79200", matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79200" });
  renderCouncilHearingMatterContinuation(meeting("20260707021"));
  assert.equal(JSON.stringify(lookup), before, "resolution is a read projection with no state of its own");

  // Read the module's executable body, with its prose stripped, so the
  // assertion is about what the resolver does rather than what it explains.
  const code = readFileSync(new URL("../site/legislative_matter_availability.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket/, "the resolver contacts no publisher");
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\./, "the resolver stores nothing");
});

// ---------------------------------------------------------------------------
// A6 — the render manifest is the tracked capture proof.
// ---------------------------------------------------------------------------

test("the render manifest describes every capture without committing an image", () => {
  assert.equal(manifest.schema, "cityscroll.legislative_matter_continuation_evidence.v1");
  assert.equal(manifest.engineering_record, "cityscroll-engineering/legislative-matter-continuation-availability");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.equal(manifest.fixture_digest, createHash("sha256").update(readFileSync(new URL("../test/harness/matter_continuation_harness.html", import.meta.url))).digest("hex"));
  assert.equal(manifest.data_vintage, snapshot.generated_at);

  const specimens = new Set();
  const viewports = new Set();
  for (const row of manifest.files) {
    for (const field of ["name", "specimen", "route", "viewport", "revision", "data_vintage", "assertion", "observations", "sha256", "axe"]) {
      assert.ok(row[field] !== undefined, `${row.name} is missing ${field}`);
    }
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
    assert.equal(row.axe.passes, true, `${row.name} has an accessibility violation`);
    assert.doesNotMatch(JSON.stringify(row), /follow|subscrib|testimon/i);
    specimens.add(row.specimen);
    viewports.add(row.viewport.join("x"));
  }
  assert.deepEqual([...viewports].sort(), ["1440x900", "390x844"]);
  for (const specimen of ["published-local-history", "single-exact-official-record", "multiple-exact-matters", "unmatched-notice", "unavailable-destination", "without-scripting", "keyboard-and-return", "modified-click", "two-hundred-percent-zoom"]) {
    assert.ok(specimens.has(specimen), `missing capture specimen ${specimen}`);
  }
});
