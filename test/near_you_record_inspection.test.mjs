// Let Near You readers inspect records before opening evidence or destinations.
//
// Public alias: c0830a62bcc4f
//
// Near You cards used to lead with linked titles and geographic matching
// explanation in the default projection. After enhancement the title-sized
// control inspects in place, geographic evidence stays optional inside the
// inspection dialog, and a separately named full-record link keeps the
// destination. Place roles and meaningful uncertainty remain visible.
//
//   A1 inspect and dismiss while keeping place/topic; optional geographic
//      evidence; explicit full record
//   A2 location evidence tiers and source matching unchanged; uncertainty
//      visible; absent enrichment produces no empty evidence panel
//   A3 positive and negative fixtures distinguish prior title+evidence cards
//      from staged inspection
//   A4 strong/derived/weak placement fixtures with place roles, failed detail,
//      keyboard disclosure, narrow-screen density; journey evidence recorded
//
//   node --test test/near_you_record_inspection.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { withTempDirSync } from "../tools/lib/with_temp_dir.mjs";

import {
  BROWSE_INSPECTION_LEGACY_BASELINE,
  BROWSE_INSPECTION_SURFACES,
} from "../site/browse_inspection_contract.mjs";
import {
  NEAR_YOU_RECORD_FULL_RECORD_CLASS,
  NEAR_YOU_RECORD_INSPECT_CLASS,
  NEAR_YOU_RECORD_INSPECTION_DIALOG_ID,
  NEAR_YOU_RECORD_INSPECTION_READY_ATTRIBUTE,
  NEAR_YOU_RECORD_INSPECTION_TITLE_ID,
  NEAR_YOU_RECORD_TITLE_LINK_CLASS,
  bindNearYouRecordInspection,
  nearYouRecordInspectionFacts,
  renderNearYouRecordInspectionBody,
} from "../site/near_you_record_inspection.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDeferredParts,
} from "../site/near_you_view.mjs";
import { scopeFromLensState } from "../site/scope_v0.mjs";
import { scopeWithPlace } from "../site/near_you_scope_runtime.mjs";
import {
  buildNearYouExplanationCandidates,
} from "../site/near_you_explanation_path.mjs";
import {
  FIXTURE_BOROUGH,
  FIXTURE_COMMUNITY_DISTRICT,
  FIXTURE_GEOGRAPHY_NODES,
  FIXTURE_MANDATE_BACKLINKS,
  FIXTURE_ONE_RECORDS,
} from "./fixtures/place_scope_contract/geography.mjs";
import { click, describeNode, keydown, mountDocument } from "./helpers/preview_dom.mjs";
import { MILLISECONDS_PER_DAY, withPinnedClock } from "./helpers/test_clock.mjs";

const ROOT = process.cwd();
const EVIDENCE_PATH = join("docs", "evidence", "near-you-record-inspection", "acceptance-manifest.json");
const NARROW_DENSITY_PROBE = join("test", "functional", "near_you_record_inspection_narrow_density.py");
const CSS = readFileSync(new URL("../site/civic-documents.css", import.meta.url), "utf8");
const VIEW_SOURCE = readFileSync(new URL("../site/near_you_view.mjs", import.meta.url), "utf8");
const GROUNDED_AT = "31d8fe647c874d3cfa425b031192d1262e9c5a93";
const FIXTURE_CLOCK = "2026-09-17T18:00:00.000Z";
const FIXTURE_BOUNDARY_VINTAGE = "2026-05-26";

function fixtureInstant(days = 0) {
  return new Date(Date.parse(FIXTURE_CLOCK) + days * MILLISECONDS_PER_DAY).toISOString();
}

function pythonPlaywrightChromiumAvailable() {
  const probe = spawnSync(
    "python3",
    [
      "-c",
      "from playwright.sync_api import sync_playwright\n"
      + "with sync_playwright() as p:\n"
      + "    browser = p.chromium.launch(headless=True)\n"
      + "    browser.close()\n",
    ],
    { encoding: "utf8", timeout: 60_000, env: process.env },
  );
  return probe.status === 0;
}

function fixtureDistrictRecord(key, { confidence = "strong", method } = {}) {
  const { record, locatedEdges } = FIXTURE_ONE_RECORDS[key];
  const edges = method
    ? locatedEdges.map((edge) => ({
      ...edge,
      confidence,
      evidence: { ...edge.evidence, placement_method: method },
    }))
    : locatedEdges.map((edge) => ({ ...edge, confidence }));
  const candidates = buildNearYouExplanationCandidates({
    record,
    lens: "meetings",
    locatedEdges: edges,
    geographyNodes: FIXTURE_GEOGRAPHY_NODES,
    mandateBacklinks: FIXTURE_MANDATE_BACKLINKS,
  });
  return {
    id: record.id,
    title: `${key} meeting`,
    agency: "Transportation",
    type: "Public Hearings",
    date: fixtureInstant(-36),
    basis: record.basis,
    confidence,
    route: `/notices/${record.id}`,
    ...(candidates.length ? { why_here_candidates: candidates } : {}),
  };
}

function fixtureActivity(extraRecords = {}) {
  const keys = ["venueHere", "matterHere", "affectedAreaHere", "weakFallbackOnly"];
  const records = Object.fromEntries([
    ...keys.map((key) => [FIXTURE_ONE_RECORDS[key].record.id, fixtureDistrictRecord(key)]),
    ...Object.entries(extraRecords),
  ]);
  // derived placement: same place role with a non-strong method and mid confidence.
  const derived = fixtureDistrictRecord("affectedAreaHere", {
    confidence: "derived",
    method: "classic_affected_area",
  });
  derived.id = "psc-derived";
  derived.title = "Derived affected-area meeting";
  derived.route = "/notices/psc-derived";
  derived.why_here_candidates = (derived.why_here_candidates || []).map((candidate) => ({
    ...candidate,
    notice_href: "/notices/psc-derived",
    location: { ...candidate.location, tier: "derived", confidence: "derived" },
  }));
  records[derived.id] = derived;

  const ids = Object.keys(records);
  return {
    schema: "cityscroll.district_activity.v1",
    boundary_vintage: FIXTURE_BOUNDARY_VINTAGE,
    built_at: fixtureInstant(-44),
    levels: ["borough", "community_district", "council_district"],
    lenses: ["land", "property", "rules", "meetings", "money"],
    by_level: { borough: {}, community_district: {}, council_district: {} },
    citywide: {},
    virtual: {},
    unlocated: {},
    unlocated_reasons: {},
    sources: {},
    district_items: {
      schema: "cityscroll.district_items.v1",
      by_level: {
        borough: {},
        community_district: { [FIXTURE_COMMUNITY_DISTRICT]: { meetings: ids } },
        council_district: {},
      },
      citywide: { meetings: [] },
      virtual: { meetings: [] },
      unlocated: { meetings: [] },
    },
    records: { meetings: records },
    basis_layers: {},
  };
}

const fixtureBoundaries = {
  schema: "cityscroll.district_boundaries.v1",
  boundary_vintage: FIXTURE_BOUNDARY_VINTAGE,
  community_districts: [],
  council_districts: [],
};

function narrowDensityDocumentHtml() {
  const view = buildNearYouViewModel(placeScope({ placeRole: "venue" }), fixtureActivity(), fixtureBoundaries);
  const resultsHtml = renderNearYouDeferredParts(view).resultsHtml;
  const facts = nearYouRecordInspectionFacts(view.results.records[0]);
  const body = renderNearYouRecordInspectionBody(facts);
  const brandHref = pathToFileURL(join(ROOT, "site", "brand.css")).href;
  const civicHref = pathToFileURL(join(ROOT, "site", "civic-documents.css")).href;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${brandHref}">
<link rel="stylesheet" href="${civicHref}">
</head>
<body>
<div data-near-you-root ${NEAR_YOU_RECORD_INSPECTION_READY_ATTRIBUTE} data-lens="meetings">
${resultsHtml}
</div>
<dialog id="${NEAR_YOU_RECORD_INSPECTION_DIALOG_ID}" class="near-you-record-inspection-dialog" open>
  <div class="near-you-record-inspection-inner">
    <button class="near-you-record-inspection-close" type="button" data-near-you-record-inspection-close>Close</button>
    ${body}
  </div>
</dialog>
</body>
</html>`;
}

function placeScope({ placeRole = null } = {}) {
  return scopeWithPlace(
    scopeFromLensState("meetings", { agency: "Transportation", place_role: placeRole }),
    { borough: FIXTURE_BOROUGH, communityDistrict: FIXTURE_COMMUNITY_DISTRICT },
  );
}

function resultsHTML(placeRole = null) {
  const view = buildNearYouViewModel(placeScope({ placeRole }), fixtureActivity(), fixtureBoundaries);
  return renderNearYouDeferredParts(view).resultsHtml;
}

function firstItemHTML(html = resultsHTML("venue")) {
  return html.match(/<li class="near-record"[\s\S]*?<\/li>/)[0];
}

function mountResults(placeRole = "venue", bindOptions = {}) {
  const html = `<div data-near-you-root data-lens="meetings">${resultsHTML(placeRole)}</div>`;
  const { doc, container } = mountDocument(html, { containerClass: "near-you-host" });
  const root = container.querySelector("[data-near-you-root]") || container;
  const controller = bindNearYouRecordInspection(root, bindOptions);
  const dialog = doc.getElementById(NEAR_YOU_RECORD_INSPECTION_DIALOG_ID);
  return { doc, container, root, controller, dialog, html };
}

function inspectButton(container, uid) {
  const nodes = [...container.querySelectorAll("[data-near-you-record-inspection-uid]")];
  if (!uid) return nodes[0] || null;
  return nodes.find((node) => node.getAttribute("data-near-you-record-inspection-uid") === uid) || null;
}

function fullRecordLink(container, uid) {
  const nodes = [...container.querySelectorAll(`.${NEAR_YOU_RECORD_FULL_RECORD_CLASS}`)];
  if (!uid) return nodes[0] || null;
  return nodes.find((node) => node.getAttribute("data-browse-return-uid") === uid) || null;
}

function titleLink(container) {
  return container.querySelector(`.${NEAR_YOU_RECORD_TITLE_LINK_CLASS}`);
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function assertFocused(doc, expected, message) {
  assert.ok(doc.activeElement === expected,
    `${message} — focus is on ${describeNode(doc.activeElement)}, expected ${describeNode(expected)}`);
}

/* ---------- A3: positive vs prior negative hierarchy ---------- */

test("A3 negative fixture: default cards no longer lead with linked titles and open geographic evidence", () => {
  assert.doesNotMatch(
    VIEW_SOURCE,
    /function whyHerePath\(/,
    "why-here must not remain a default-card renderer",
  );
  assert.doesNotMatch(
    VIEW_SOURCE,
    /function geographyEvidence\(/,
    "geography evidence must not remain a default-card renderer",
  );
  const item = firstItemHTML();
  assert.doesNotMatch(item, /data-why-here-path="1"/);
  assert.doesNotMatch(item, /data-geography-evidence="1"/);
  assert.doesNotMatch(item, /data-located-in-method=/);
  assert.doesNotMatch(item, /data-cross-spine-method=/);
  assert.doesNotMatch(item, /class="near-record-why"/);
});

test("A3 positive fixture: static title link, title-sized inspect, named full-record link", () => {
  const item = firstItemHTML();
  assert.match(item, new RegExp(`class="${NEAR_YOU_RECORD_TITLE_LINK_CLASS} near-record-title"`));
  assert.match(item, new RegExp(`class="${NEAR_YOU_RECORD_INSPECT_CLASS} near-record-title"`));
  assert.match(item, new RegExp(`class="${NEAR_YOU_RECORD_FULL_RECORD_CLASS}"`));
  assert.match(item, />Open the full record</);
  assert.match(item, /data-place-role="venue"/);
  assert.match(item, /Happening here/);
  assert.match(item, /Venue \/ logistics/);
  assert.doesNotMatch(item, /onclick=/);
});

/* ---------- A1: inspect, dismiss, keep scope, open full record ---------- */

test("A1: the enhanced primary control inspects without leaving the Near You collection", () => {
  const { root, dialog, container } = mountResults("venue");
  assert.ok(root.hasAttribute(NEAR_YOU_RECORD_INSPECTION_READY_ATTRIBUTE));
  assert.equal(root.getAttribute("data-lens"), "meetings");
  const invoker = inspectButton(container);
  assert.ok((invoker.getAttribute("class") || "").split(/\s+/).includes(NEAR_YOU_RECORD_INSPECT_CLASS));
  click(invoker);
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /venueHere meeting/);
  assert.match(dialog.textContent, /Happening here/);
  assert.match(dialog.textContent, /Venue \/ logistics/);
  assert.equal(root.getAttribute("data-lens"), "meetings");
  assert.equal(container.querySelectorAll(".near-record").length >= 1, true);
});

test("A1: dismiss returns focus and keeps the selected topic on the collection", () => {
  const { doc, root, dialog, container } = mountResults("venue");
  const button = inspectButton(container);
  click(button);
  assert.equal(dialog.open, true);
  click(dialog.querySelector("[data-near-you-record-inspection-close]"));
  assert.equal(dialog.open, false);
  assertFocused(doc, button, "dismiss returns focus to the inspected record control");
  assert.equal(root.getAttribute("data-lens"), "meetings");
});

test("A1: geographic evidence is optional inside inspection and the full-record link stays explicit", () => {
  const { container, dialog } = mountResults("venue");
  const link = fullRecordLink(container);
  assert.equal(link.getAttribute("href"), "/notices/psc-201");
  assert.equal(link.querySelector("button"), null);
  assert.equal(link.closest("button"), null);
  click(inspectButton(container));
  const disclosure = dialog.querySelector("[data-why-here-path='1']");
  assert.ok(disclosure, "why-here evidence is available inside inspection");
  assert.equal(disclosure.tagName, "details");
  assert.match(disclosure.textContent, /Why this appears/);
  assert.match(disclosure.textContent, /Meeting venue/);
  assert.equal(
    dialog.querySelector("[data-near-you-record-inspection-open]").getAttribute("href"),
    "/notices/psc-201",
  );
});

test("A1: near-you-records is conforming and the legacy title-navigates baseline is gone", () => {
  const surface = BROWSE_INSPECTION_SURFACES.find((row) => row.surface_id === "near-you-records");
  assert.ok(surface);
  assert.equal(surface.classification, "conforming");
  assert.equal(surface.baseline_id, null);
  assert.equal(surface.detail_host, "modal_preview");
  assert.equal(surface.detail_host_module, "site/near_you_record_inspection.mjs");
  assert.equal(surface.journey_owner, "test/near_you_record_inspection.test.mjs");
  assert.equal(
    BROWSE_INSPECTION_LEGACY_BASELINE.some((row) => row.id === "near-you-title-navigates"),
    false,
  );
});

/* ---------- A2: tiers, matching, absence ---------- */

test("A2: strong, derived, and weak placement fixtures keep distinct tiers and place roles", () => {
  const view = buildNearYouViewModel(placeScope(), fixtureActivity(), fixtureBoundaries);
  const byId = Object.fromEntries(view.results.records.map((record) => [record.id, record]));
  assert.ok(byId["psc-201"]?.why_here);
  assert.equal(byId["psc-201"].why_here.location.place_role, "venue");
  assert.equal(byId["psc-201"].why_here.location.tier, "strong");

  assert.ok(byId["psc-202"]?.why_here);
  assert.equal(byId["psc-202"].why_here.location.place_role, "matter");
  assert.equal(byId["psc-202"].why_here.location.tier, "strong");

  assert.ok(byId["psc-derived"]?.why_here);
  assert.equal(byId["psc-derived"].why_here.location.place_role, "affected_area");
  assert.equal(byId["psc-derived"].why_here.location.tier, "derived");

  // Weak exact-place methods are excluded from explanation paths; the record
  // remains listed with its consequential basis and no empty evidence panel.
  assert.ok(byId["psc-204"]);
  assert.equal(byId["psc-204"].why_here, null);
  assert.equal(byId["psc-204"].basis, "Weak fallback");
  const weakFacts = nearYouRecordInspectionFacts(byId["psc-204"]);
  const body = renderNearYouRecordInspectionBody(weakFacts);
  assert.doesNotMatch(body, /data-geography-evidence=/);
  assert.doesNotMatch(body, /data-why-here-path=/);
  assert.doesNotMatch(body, /agency_hq|placement_method|located_in_method/);
});

test("A2: weak place matches announce approximate certainty without raw adapter enums", () => {
  const record = {
    id: "weak-geo",
    title: "Approximate match hearing",
    agency: "Transportation",
    type: "Public Hearings",
    date: fixtureInstant(-36),
    basis: "Affected area",
    route: "/notices/weak-geo",
    matched_place_role: "affected_area",
    geography_evidence: {
      schema: "cityscroll.near_you_geography_evidence.v1",
      key: "geography:nta2020:BK1801",
      type: "nta2020",
      label: "Canarsie",
      location_role: "affected_area",
      basis: "Affected area",
      tier: "weak",
      confidence: "weak",
      method: "agency_hq",
      source_id: "fixture",
      boundary_vintage: FIXTURE_BOUNDARY_VINTAGE,
    },
  };
  const facts = nearYouRecordInspectionFacts(record);
  assert.equal(facts.uncertainty, "Place match is approximate");
  const body = renderNearYouRecordInspectionBody(facts);
  assert.match(body, /Place match is approximate/);
  assert.match(body, /Why this place matched/);
  assert.doesNotMatch(body, /agency_hq|placement_method|data-geography-source|data-located-in-method/);
  const item = renderNearYouDeferredParts({
    ...buildNearYouViewModel(placeScope(), fixtureActivity(), fixtureBoundaries),
    results: {
      ids: [record.id],
      count: 1,
      records: [record],
    },
  }).resultsHtml;
  assert.match(item, /Place match is approximate/);
  assert.doesNotMatch(item, /agency_hq/);
});

test("A2: location evidence tiers and source matching stay owned by the explanation path", () => {
  const view = buildNearYouViewModel(placeScope({ placeRole: "venue" }), fixtureActivity(), fixtureBoundaries);
  assert.deepEqual(view.results.ids, ["psc-201"]);
  assert.equal(view.results.records[0].matched_place_role, "venue");
  assert.equal(view.results.records[0].why_here.location.placement_method, "venue_line");
  assert.equal(view.results.records[0].why_here.location.tier, "strong");
});

/* ---------- A4: progressive enhancement, keyboard, failure, density ---------- */

test("A4: without the ready marker CSS keeps the title link and hides inspect plus full-record", () => {
  assert.match(CSS, /\.near-record-inspect,\s*\n\.near-record-full-record\s*\{\s*\n\s*display:\s*none/);
  assert.match(CSS, new RegExp(`\\[${NEAR_YOU_RECORD_INSPECTION_READY_ATTRIBUTE}\\] \\.near-record-title-link\\s*\\{[^}]*display:\\s*none`));
  assert.match(CSS, new RegExp(`\\[${NEAR_YOU_RECORD_INSPECTION_READY_ATTRIBUTE}\\] \\.near-record-inspect\\s*\\{`));
  assert.match(CSS, new RegExp(`\\[${NEAR_YOU_RECORD_INSPECTION_READY_ATTRIBUTE}\\] \\.near-record-full-record\\s*\\{[^}]*display:\\s*inline-block`));
  const { container } = mountDocument(`<div>${resultsHTML("venue")}</div>`);
  assert.equal(container.hasAttribute(NEAR_YOU_RECORD_INSPECTION_READY_ATTRIBUTE), false);
  assert.ok(titleLink(container));
});

test("A4: narrow-screen default density is observed at 390px rather than only declared", async (t) => {
  if (!pythonPlaywrightChromiumAvailable()) {
    t.skip("Python playwright Chromium is not launchable in this lane");
    return;
  }
  assert.equal(existsSync(join(ROOT, NARROW_DENSITY_PROBE)), true);
  await withPinnedClock(FIXTURE_CLOCK, () => {
    withTempDirSync("near-you-narrow-density", (dir) => {
      const documentPath = join(dir, "index.html");
      writeFileSync(documentPath, narrowDensityDocumentHtml());
      const result = spawnSync("python3", [join(ROOT, NARROW_DENSITY_PROBE), documentPath], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 120_000,
        env: process.env,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema, "cityscroll.near_you_record_inspection_narrow_density.v1");
      const byId = Object.fromEntries(payload.observations.map((row) => [row.id, row]));
      const narrow = byId.narrow_touch;
      const desktop = byId.desktop;
      assert.ok(narrow && desktop);
      assert.deepEqual(narrow.viewport, { width: 390, height: 844 });
      assert.deepEqual(desktop.viewport, { width: 1440, height: 900 });

      const seen = narrow.observed;
      assert.equal(seen.place_role, "Happening here");
      assert.equal(seen.basis, "Venue / logistics");
      assert.match(seen.record_text || "", /venueHere meeting/);
      assert.equal(seen.inspection_title, "venueHere meeting");
      assert.equal(seen.inspect?.visible, true);
      assert.ok(seen.inspect.height >= 40, "inspect control stays large enough to use on a narrow screen");
      assert.equal(seen.title_link?.visible, false);
      assert.equal(seen.full_record?.visible, true);
      assert.equal(seen.fact_rows_stacked, true);
      assert.equal(seen.fact_rows_side_by_side, false);
      assert.equal(seen.no_horizontal_overflow, true);
      assert.equal(seen.evidence_count >= 1, true);
      assert.ok(seen.evidence_open.every((open) => open === false));
      assert.equal(seen.record_padding_top_px, 12);

      const wide = desktop.observed;
      assert.equal(wide.fact_rows_stacked, false);
      assert.equal(wide.fact_rows_side_by_side, true);
      assert.equal(wide.record_padding_top_px, 16);
      assert.notEqual(
        seen.record_padding_top_px,
        wide.record_padding_top_px,
        "narrow density must differ from desktop density",
      );
      assert.notEqual(
        seen.fact_rows_stacked,
        wide.fact_rows_stacked,
        "narrow inspection rows must stack while desktop rows stay side-by-side",
      );
    });
  });
});

test("A4: no-JavaScript keeps the grounded title link", () => {
  const html = firstItemHTML();
  assert.match(html, /class="near-record-title-link near-record-title" href="\/notices\/psc-201"/);
});

test("A4: opening inspection never navigates, submits, or fetches a publisher", () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    requests.push(args);
    return Promise.reject(new Error("no request expected"));
  };
  try {
    const { container, dialog, root } = mountResults("venue");
    const hrefBefore = titleLink(container).getAttribute("href");
    const lensBefore = root.getAttribute("data-lens");
    click(inspectButton(container));
    assert.equal(dialog.open, true);
    assert.equal(titleLink(container).getAttribute("href"), hrefBefore);
    assert.equal(root.getAttribute("data-lens"), lensBefore);
    assert.equal(requests.length, 0);
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test("A4: Escape, Close, Tab containment, keyboard disclosure, and disappeared-trigger fallback", () => {
  const { doc, container, dialog } = mountResults("venue");
  const button = inspectButton(container);
  click(button);
  const close = dialog.querySelector("[data-near-you-record-inspection-close]");
  assertFocused(doc, close, "opening moves focus inside the dialog");

  const disclosure = dialog.querySelector("[data-why-here-path='1']");
  assert.ok(disclosure);
  assert.equal(disclosure.open, false);
  disclosure.open = true;
  assert.equal(disclosure.open, true);
  assert.match(disclosure.textContent, /Transportation/);

  const focusable = [...dialog.querySelectorAll("a[href], button:not([disabled])")];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  last.focus();
  keydown(dialog, "Tab");
  assertFocused(doc, first, "Tab wraps inside the dialog");
  first.focus();
  keydown(dialog, "Tab", { shiftKey: true });
  assertFocused(doc, last, "Shift+Tab wraps inside the dialog");

  click(close);
  assert.equal(dialog.open, false);
  assertFocused(doc, button, "Close returns focus to the invoker");

  dialog.showModal = undefined;
  click(button);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  keydown(dialog, "Escape");
  assert.equal(dialog.open, false);
  assertFocused(doc, button, "Escape closes the fallback dialog");

  click(button);
  container.querySelector("[data-near-you-root]").innerHTML = resultsHTML("venue");
  const survivor = inspectButton(container);
  dialog.close();
  assertFocused(doc, survivor, "focus follows a replaced trigger for the same record");
});

test("A4: rapid selection and failed detail keep the coherent summary and record link", async () => {
  const resolvers = new Map();
  const { doc, container, dialog } = mountResults(null, {
    loadDetail: (facts) => new Promise((resolve, reject) => {
      resolvers.set(facts.uid, { resolve, reject });
    }),
  });
  const firstUid = "psc-201";
  const secondUid = "psc-202";
  click(inspectButton(container, firstUid));
  click(inspectButton(container, secondUid));
  await tick();
  resolvers.get(firstUid)?.resolve("Stale detail for the record the reader left");
  await tick();
  assert.match(dialog.textContent, /matterHere meeting/);
  assert.doesNotMatch(dialog.textContent, /Stale detail/);

  resolvers.get(secondUid)?.reject(new Error("detail unavailable"));
  await tick();
  assert.match(dialog.textContent, /matterHere meeting/);
  assert.match(dialog.textContent, /Further detail did not load/);
  assert.equal(
    dialog.querySelector("[data-near-you-record-inspection-open]").getAttribute("href"),
    "/notices/psc-202",
  );
  assert.equal(doc.getElementById(NEAR_YOU_RECORD_INSPECTION_TITLE_ID).textContent, "matterHere meeting");
});

test("A4: modified click on inspect still inspects rather than navigating", () => {
  const { container, dialog } = mountResults("venue");
  const button = inspectButton(container);
  click(button, { metaKey: true });
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /venueHere meeting/);
});

/* ---------- A4 journey evidence ---------- */

test("A4: acceptance manifest records the rendered journey with revision, route, viewport, and fixture vintage", () => {
  assert.equal(existsSync(join(ROOT, EVIDENCE_PATH)), true);
  const manifest = JSON.parse(readFileSync(join(ROOT, EVIDENCE_PATH), "utf8"));
  assert.equal(manifest.schema, "cityscroll.near_you_record_inspection_acceptance.v1");
  assert.equal(manifest.record, "cityscroll-engineering/c0830a62bcc4f");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.equal(manifest.revision, GROUNDED_AT);
  assert.equal(manifest.grounded_at, GROUNDED_AT);
  assert.equal(manifest.route, "/near-you/?v=0&level=community_district&lens=meetings&boro=Brooklyn&cd=K18");
  assert.equal(manifest.fixture_vintage, FIXTURE_BOUNDARY_VINTAGE);
  assert.deepEqual(manifest.viewport, [1440, 900]);
  assert.deepEqual(manifest.viewports, [[1440, 900], [390, 844]]);
  assert.ok(Array.isArray(manifest.assertions) && manifest.assertions.length >= 4);
  assert.ok(manifest.assertions.some((row) => row.id === "primary-inspect-keeps-scope" && row.result === "accepted"));
  assert.ok(manifest.assertions.some((row) => row.id === "optional-geography-evidence" && row.result === "accepted"));
  assert.ok(manifest.assertions.some((row) => row.id === "reject-default-title-and-geography" && row.result === "rejected"));
  assert.ok(manifest.assertions.some((row) => row.id === "strong-derived-weak-place-roles" && row.result === "accepted"));
  assert.ok(manifest.assertions.some((row) => row.id === "failed-detail-keeps-summary-and-record-link" && row.result === "accepted"));
  assert.ok(manifest.assertions.some((row) => row.id === "keyboard-disclosure-operation" && row.result === "accepted"));
  const narrowDensity = manifest.assertions.find((row) => row.id === "narrow-screen-default-density-observed");
  assert.ok(narrowDensity);
  assert.equal(narrowDensity.result, "accepted");
  assert.match(narrowDensity.assertion, /390px/);
  assert.match(narrowDensity.assertion, /stack/);
  assert.equal(narrowDensity.fixture, "near-you-record-inspection-narrow-density");
  assert.equal(
    manifest.assertions.some((row) => row.id === "narrow-and-keyboard-density"),
    false,
    "declared-only narrow density claim must not remain",
  );
  assert.ok(manifest.journey?.sequence?.includes("inspect"));
  assert.ok(manifest.journey?.sequence?.includes("open_full_record"));
  assert.ok(manifest.journey?.sequence?.includes("continue"));
  assert.ok(manifest.journey?.variants?.includes("narrow_touch"));
  assert.ok(manifest.journey?.variants?.includes("keyboard"));
  assert.ok(manifest.journey?.variants?.includes("no_javascript"));
  assert.ok(manifest.journey?.variants?.includes("failed_detail"));
  assert.equal(
    manifest.journey?.rendered_reference?.narrow_density_harness,
    "test/functional/near_you_record_inspection_narrow_density.py",
  );
  for (const banned of ["needs_james", "card_standard", "richness_profile", "autodispatch", "realization_gate"]) {
    assert.equal(JSON.stringify(manifest).includes(banned), false, banned);
  }
  const digest = createHash("sha256").update(JSON.stringify(manifest.assertions) + "\n").digest("hex");
  assert.equal(manifest.assertions_sha256, digest);
});
