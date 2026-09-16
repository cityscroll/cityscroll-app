import assert from "node:assert/strict";
import test from "node:test";
import { withPinnedClock } from "./helpers/test_clock.mjs";
import {
  buildSiteLifecycleContext,
  loadSiteLifecycleContext,
  mountSiteLifecycleContext,
  nativeSourceHrefForSubject,
  renderSiteLifecycleContext,
  siteLifecycleLoadFailure,
  siteLifecycleMembersForSubject,
  SITE_LIFECYCLE_LOAD_FAILED_SCHEMA,
} from "../site/site_lifecycle_context.mjs";

const lifecycle = {
  schema: "cityscroll.site_lifecycle.v1",
  parcels: {
    "3073670011": { parcel_id: "3073670011", members: [
      { subject_id: "land:project:2020K0270", record_kind: "land_project", source_title: "2134 Coyle Street Rezoning", subject_href: "/browse/zoning/#land/2020K0270", source_event_date: "2022-02-24", source_system: "zap-projects-open-data", evidence_path: "zap-projects-open-data:2020K0270" },
      { subject_id: "land:application:C210239ZMK", record_kind: "land_application", source_title: "C210239ZMK", subject_href: "/browse/zoning/#land/2020K0270", source_event_date: "2022-02-24", source_system: "zap-projects-open-data" },
      { subject_id: "land:application:N210240ZRK", record_kind: "land_application", source_title: "N210240ZRK", subject_href: "/browse/zoning/#land/2020K0270", source_event_date: "2022-02-24", source_system: "zap-projects-open-data" },
      { subject_id: "procurement:contract:CT107120258802303", record_kind: "procurement_observation", source_title: "Coyle Family Residence", subject_href: "/procurements/4965933", source_event_date: "2024-11-04", source_system: "passport_public_contracts", agency: "DHS", vendor: "Westhab" },
    ] },
    "3073670029": { parcel_id: "3073670029", members: [] },
  },
  members: {
    "land:project:2020K0270": { parcel_ids: ["3073670011", "3073670029"] },
    "procurement:contract:CT107120258802303": { parcel_ids: ["3073670011"] },
  },
};

test("reciprocal Coyle context uses one accepted parcel membership and native links", () => {
  withPinnedClock("2026-09-15T12:00:00.000Z", () => {
    const land = buildSiteLifecycleContext(lifecycle, { subjectId: "land:project:2020K0270", surface: "land" });
    const procurement = buildSiteLifecycleContext(lifecycle, { subjectId: "procurement:contract:CT107120258802303", surface: "procurement" });
    assert.equal(land.parcel_id, procurement.parcel_id);
    assert.deepEqual(land.members.map((member) => member.subject_id), ["procurement:contract:CT107120258802303"]);
    assert.deepEqual(procurement.members.map((member) => member.subject_id), ["land:project:2020K0270", "land:application:C210239ZMK", "land:application:N210240ZRK"]);
    const html = renderSiteLifecycleContext(procurement);
    assert.match(html, /Land-use history at this site/);
    assert.match(html, /C210239ZMK/);
    assert.match(html, /N210240ZRK/);
    assert.match(html, /not one continuous project/); // boundary copy is negated, not asserted.
    const landHtml = renderSiteLifecycleContext(land);
    assert.match(landHtml, /Other government activity at this site/);
    assert.match(landHtml, /Coyle Family Residence/);
    assert.match(landHtml, /href="\/procurements\/procurement%3Acontract%3ACT107120258802303"/);
    assert.match(landHtml, /3073670011 and 3073670029/);
  });
});

test("context omits absent optional history and keeps reverse lookup bounded", () => {
  assert.deepEqual(siteLifecycleMembersForSubject(lifecycle, "missing"), { parcelId: null, parcelIds: [], members: [] });
  assert.equal(buildSiteLifecycleContext(lifecycle, { subjectId: "missing", surface: "land" }), null);
  assert.equal(renderSiteLifecycleContext(null), "");
});

test("A3: failed site-history load offers recovery and differs from absent context", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", async () => {
    const absentHtml = renderSiteLifecycleContext(null);
    assert.equal(absentHtml, "");

    const failure = siteLifecycleLoadFailure({
      subjectId: "land:project:2020K0270",
      reason: "site_lifecycle_shard_http_503",
    });
    assert.equal(failure.schema, SITE_LIFECYCLE_LOAD_FAILED_SCHEMA);
    assert.equal(failure.status, "unavailable");
    assert.equal(
      failure.source_href,
      "https://zap.planning.nyc.gov/projects/2020K0270",
    );
    assert.equal(
      nativeSourceHrefForSubject("land:project:2020K0270"),
      "https://zap.planning.nyc.gov/projects/2020K0270",
    );

    const failedHtml = renderSiteLifecycleContext(failure);
    assert.notEqual(failedHtml, absentHtml);
    assert.match(failedHtml, /data-site-lifecycle-state="unavailable"/);
    assert.match(failedHtml, /could not be loaded just now/);
    assert.match(failedHtml, /failure to read them, not a finding that none exist/);
    assert.match(failedHtml, /Reload this page to retry/);
    assert.match(failedHtml, /href="https:\/\/zap\.planning\.nyc\.gov\/projects\/2020K0270"/);
    assert.doesNotMatch(failedHtml, /no related records|no government activity|none (were )?found|not observed/i);

    // A failed fetch must not become an empty successful document.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => null });
    try {
      const loaded = await loadSiteLifecycleContext();
      assert.equal(loaded.schema, SITE_LIFECYCLE_LOAD_FAILED_SCHEMA);
      assert.equal(loaded.status, "unavailable");
      assert.match(loaded.reason, /http_503/);
      const host = { innerHTML: "stale" };
      mountSiteLifecycleContext(host, loaded, "land:project:2020K0270");
      assert.match(host.innerHTML, /data-site-lifecycle-state="unavailable"/);
      assert.match(host.innerHTML, /Reload this page to retry/);
      assert.notEqual(host.innerHTML, "");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
