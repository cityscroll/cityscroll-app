import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildSiteLifecycleContext,
  renderSiteLifecycleContext,
  siteLifecycleLoadFailure,
} from "../site/site_lifecycle_context.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const EVIDENCE_ROOT = new URL("../docs/evidence/site-lifecycle-journey/", import.meta.url);
const MANIFEST = JSON.parse(readFileSync(new URL("capture-manifest.json", EVIDENCE_ROOT), "utf8"));
const LAND_SOURCE = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");
const LIFECYCLE_SOURCE = readFileSync(new URL("../site/land_site_lifecycle.mjs", import.meta.url), "utf8");
const TEST_DAY = process.env.CITYSCROLL_TEST_DAY || "2026-09-16";

const LIFECYCLE = {
  schema: "cityscroll.site_lifecycle.v1",
  parcels: {
    "3073670011": {
      parcel_id: "3073670011",
      members: [
        {
          subject_id: "land:project:2020K0270",
          record_kind: "land_project",
          source_title: "2134 Coyle Street Rezoning",
          source_href: "/browse/zoning/#land/2020K0270",
          source_event_date: "2022-02-24",
          source_system: "zap-projects-open-data",
          evidence_path: "https://data.cityofnewyork.us/resource/hgx4-8ukb.json?project_id=2020K0270",
        },
        {
          subject_id: "procurement:contract:CT107120258802303",
          record_kind: "procurement_observation",
          source_title: "Coyle Family Residence",
          subject_href: "/procurements/4965933",
          source_event_date: "2024-11-04",
          source_system: "passport_public_contracts",
          agency: "DHS",
          vendor: "Westhab",
        },
      ],
    },
  },
  reverse: {
    members: {
      "land:project:2020K0270": { parcel_ids: ["3073670011"] },
      "procurement:contract:CT107120258802303": { parcel_ids: ["3073670011"] },
    },
  },
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function capture(relativePath) {
  return readFileSync(new URL(relativePath, EVIDENCE_ROOT), "utf8");
}

function shell(route, body, { focus = "land-item-card", scrollY = 640 } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Site history journey</title></head><body data-route="${route.replaceAll("&", "&amp;")}" data-scroll-y="${scrollY}" data-focus="${focus}"><main id="${focus}" tabindex="-1" aria-current="page"><h1>Land record</h1>${body}</main></body></html>`;
}

function journeyHtml() {
  const land = buildSiteLifecycleContext(LIFECYCLE, {
    subjectId: "land:project:2020K0270",
    surface: "land",
  });
  const context = renderSiteLifecycleContext(land);
  return shell(
    "/browse/zoning/?status=active&borough=Brooklyn#land/2020K0270",
    `${context}<p><a href="/procurements/procurement%3Acontract%3ACT107120258802303">Open native procurement detail</a></p>`,
  );
}

test("A4: focused native journey keeps detail links, evidence, source, Back, focus and modified-click paths", async () => {
  await withPinnedClock(`${TEST_DAY}T12:00:00.000Z`, () => {
    assert.match(LAND_SOURCE, /renderLandSiteLifecycle/);
    assert.match(LIFECYCLE_SOURCE, /siteLifecycleShard from "\.\/data\/site_lifecycle\/0000\.json"/);
    assert.match(LIFECYCLE_SOURCE, /siteLifecycleReverse from "\.\/data\/site_lifecycle\/reverse\.json"/);
    assert.match(LAND_SOURCE, /html=html\.replace\('<div id="slc"><\/div>'/);
    assert.doesNotMatch(LAND_SOURCE, /import\("\.\.\/site_lifecycle_context\.mjs"\)/);
    assert.doesNotMatch(LAND_SOURCE, /loadSiteLifecycleContext\(\)/);
    const html = journeyHtml();
    assert.match(html, /data-route="\/browse\/zoning\/\?status=active&amp;borough=Brooklyn#land\/2020K0270"/);
    assert.match(html, /<details><summary>Source evidence<\/summary>/);
    assert.match(html, /href="\/procurements\/procurement%3Acontract%3ACT107120258802303"/);
    assert.match(html, /href="https:\/\/www\.pasport\.org\/public-search"/);
    assert.match(html, /href="\/parcels\/3073670011\/"/);
    assert.doesNotMatch(html, /onclick=|onauxclick=/i);
    assert.match(html, /data-scroll-y="640"/);
    assert.match(html, /id="land-item-card" tabindex="-1" aria-current="page"/);

  });
});

test("A5: retained desktop and narrow captures prove keyboard, accessibility and failure evidence", async () => {
  await withPinnedClock(`${TEST_DAY}T12:00:00.000Z`, () => {
    assert.equal(MANIFEST.image_binaries_committed, false);
    assert.equal(MANIFEST.capture_policy, "hashes refer only to retained HTML; no image capture was taken");
    assert.deepEqual(MANIFEST.not_taken, []);
    const byCase = new Map(MANIFEST.captures.map((entry) => [entry.case, entry]));
    for (const name of [
      "land-journey-desktop",
      "land-journey-narrow",
      "land-failure-desktop",
      "land-failure-narrow",
    ]) assert.ok(byCase.has(name), name);
    for (const entry of MANIFEST.captures) {
      assert.ok(entry.viewport.width > 0 && entry.viewport.height > 0, entry.case);
      assert.ok(entry.assertion.length > 20, entry.case);
      assert.match(entry.artifact, /^captures\/[a-z-]+\.html$/, entry.case);
      assert.match(entry.render_sha256, /^[a-f0-9]{64}$/, entry.case);
      assert.equal(entry.render_sha256, sha256(capture(entry.artifact)), entry.case);
      assert.equal(entry.accessibility.violations_total, 0, entry.case);
      assert.equal(entry.accessibility.keyboard_path, "passed", entry.case);
    }

    const journeyEntries = MANIFEST.captures.filter((entry) => entry.case.includes("journey"));
    for (const entry of journeyEntries) {
      const journey = capture(entry.artifact);
      assert.match(journey, /href="\/procurements\/procurement%3Acontract%3ACT107120258802303"/);
      assert.match(journey, /href="https:\/\/www\.pasport\.org\/public-search"/);
      assert.doesNotMatch(journey, /onclick=|onauxclick=/i);
      assert.doesNotMatch(journey, /tabindex="[1-9]/);
    }
    const failureEntries = MANIFEST.captures.filter((entry) => entry.case.includes("failure"));
    for (const entry of failureEntries) {
      const failure = capture(entry.artifact);
      assert.match(failure, /data-site-lifecycle-state="unavailable"/);
      assert.match(failure, /Reload this page to retry/);
      assert.doesNotMatch(failure, /no related records|no government activity|none (were )?found/i);
    }
  });
});
