import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPublicSourceHealthProjection,
} from "../site/source_health_public_projection.mjs";
import {
  buildDataHealthView,
  dataHealthRowIsNeverAcquired,
  mappedProductAreaIds,
  productAreaForSource,
  renderDataHealthDocument,
  renderDataHealthPage,
} from "../site/data_health_page.mjs";
import { dataHealthPageHtml } from "../tools/build_data_health_page.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";

const GENERATED_AT = "2026-08-18T12:00:00.000Z";

function contract(id, overrides = {}) {
  return {
    id,
    name: `Source ${id}`,
    owner: "Public publisher",
    landing_page: `https://example.gov/${id}`,
    publisher_cadence: "Daily",
    used_for: "Public records",
    freshness_contract: { mode: "continuous", max_stale_days: 7 },
    health_policy: { public_visibility: "public" },
    ...overrides,
  };
}

function observation(id, overrides = {}) {
  return {
    source_id: id,
    health: {
      status: "Healthy",
      reason_codes: [],
      clocks: {
        publisher_updated: { at: "2026-08-18T09:00:00.000Z", state: "KNOWN", basis: "warehouse_source_summary" },
        cityscroll_checked_acquired: { at: "2026-08-18T10:00:00.000Z", state: "KNOWN", basis: "acquired_at" },
        cityscroll_serving: { at: "2026-08-18T11:00:00.000Z", state: "KNOWN", basis: "serve_contract:private-gate-id" },
      },
    },
    relationship_coverage: {
      status: "complete",
      join_status: "accepted",
      measured_at: "2026-08-18T08:00:00.000Z",
      reason_codes: [],
    },
    ...overrides,
  };
}

function pageFrom(contracts, observations) {
  const projection = buildPublicSourceHealthProjection(
    { contracts },
    { generated_at: GENERATED_AT, observations },
  );
  const view = buildDataHealthView(projection);
  const html = renderDataHealthDocument(view);
  return { projection, view, html };
}

test("data health page materializes the committed public artifact without request-time compute", () => {
  const committed = JSON.parse(readFileSync(new URL("../site/data/source_health_public.json", import.meta.url)));
  const html = renderDataHealthPage(committed);
  const built = readFileSync(new URL("../site/data-health/index.html", import.meta.url), "utf8");

  assert.equal(committed.schema, "cityscroll.public_source_health.v1");
  assert.equal(html, dataHealthPageHtml());
  assert.equal(built, html);
  assert.match(html, /<h1>Data health<\/h1>/);
  assert.match(html, /Publisher updated/);
  assert.match(html, /CityScroll last checked/);
  assert.match(html, /CityScroll serving copy/);
  assert.match(html, /class="data-health-coverage-heading">Coverage<\/p>/);
  assert.doesNotMatch(html, /<h4>|aria-label="Freshness"|aria-label="Coverage"/);
  assert.match(html, /For how many records CityScroll holds, see <a href="\/stats.html">Stats<\/a>/);
  assert.doesNotMatch(html, /all operational|all systems operational|data may be incomplete|may be incomplete/i);
  assert.doesNotMatch(html, /join_coverage|snapshot_sha|contract_fingerprint|row_count|auth_token|runbook|reason_codes|source_id=|date_reported_as_of|Official source/);
  assert.equal(detectNodePageCruft(html).length, 0);
});

test("every committed public source is grouped by a closed product area", () => {
  const committed = JSON.parse(readFileSync(new URL("../site/data/source_health_public.json", import.meta.url)));
  const map = mappedProductAreaIds();
  for (const row of committed.sources) {
    assert.ok(map[row.source_id], `${row.source_id} needs a public product area`);
    assert.notEqual(productAreaForSource(row.source_id), "other", row.source_id);
  }
  const view = buildDataHealthView(committed);
  assert.ok(view.groups.length >= 6);
  assert.ok(view.groups.every((group) => group.sources.length));
  assert.ok(!view.groups.some((group) => group.id === "other"));
});

test("three clocks stay labeled, coverage stays beside health, and UNKNOWN never becomes 1970 or zero", () => {
  const { view, html } = pageFrom(
    [contract("city-record"), contract("missing-obs")],
    [observation("city-record", {
      health: {
        status: "Delayed",
        reason_codes: ["publisher-clock-stale"],
        clocks: {
          publisher_updated: { at: "1970-01-01T00:00:00.000Z", state: "KNOWN" },
          cityscroll_checked_acquired: { at: "not-a-date" },
          cityscroll_serving: { at: "2026-08-18T11:00:00.000Z", state: "KNOWN" },
        },
      },
      relationship_coverage: {
        status: "partial",
        join_status: "accepted",
        measured_at: "2026-08-02T17:02:36.000Z",
      },
    })],
  );

  const delayed = view.groups.flatMap((group) => group.sources).find((card) => card.source_id === "city-record");
  const missing = view.groups.flatMap((group) => group.sources).find((card) => card.source_id === "missing-obs");
  assert.equal(delayed.health_status, "Delayed");
  assert.equal(delayed.clocks[0].display, "UNKNOWN");
  assert.equal(delayed.clocks[1].display, "UNKNOWN");
  assert.equal(delayed.clocks[2].display, "August 18, 2026");
  assert.equal(delayed.clocks[2].basis_label, "from the copy CityScroll is serving");
  assert.equal(delayed.coverage_label, "Limited coverage");
  assert.ok(missing);
  assert.ok(missing.clocks.every((clock) => clock.display === "UNKNOWN"));

  assert.match(html, /data-health-status="Delayed"/);
  assert.match(html, /Source missing-obs/);
  assert.match(html, /The publisher&#39;s last update is older than this source&#39;s expected cadence/);
  assert.match(html, /Limited coverage/);
  assert.doesNotMatch(html, /1970|January 1, 1970|>0<|>—<|>-<\/dd>/);
  assert.doesNotMatch(html, /--color-success|#0f0|background:\s*green/i);
  assert.ok(html.indexOf("data-health-condition") < html.indexOf("data-health-coverage"));
});

test("served sources stay when clocks are unknown; only unused disabled sources drop", () => {
  const unknownClocks = {
    publisher_updated: { at: null, state: "UNKNOWN" },
    cityscroll_checked_acquired: { at: null, state: "UNKNOWN" },
    cityscroll_serving: { at: null, state: "UNKNOWN" },
  };
  const { view, html } = pageFrom(
    [
      contract("checkbook-nycha-contracts"),
      contract("city-record"),
      contract("abo-local-authorities"),
      contract("passport-public-contracts"),
    ],
    [
      observation("city-record", {
        health: {
          status: "Degraded",
          reason_codes: ["acquisition-failed", "serving-valid-fallback"],
          clocks: {
            publisher_updated: { at: "2026-08-01T00:00:00.000Z", state: "KNOWN" },
            cityscroll_checked_acquired: { at: "2026-08-18T10:00:00.000Z", state: "KNOWN" },
            cityscroll_serving: { at: "2026-08-01T00:00:00.000Z", state: "KNOWN" },
          },
        },
      }),
      observation("abo-local-authorities", {
        health: {
          status: "UNKNOWN",
          reason_codes: ["acquisition-status-unknown"],
          clocks: {
            publisher_updated: { at: "2024-06-26T00:00:00.000Z", state: "KNOWN" },
            cityscroll_checked_acquired: { at: "2026-08-04T11:26:00.000Z", state: "KNOWN" },
            cityscroll_serving: { at: "2026-08-04T11:26:00.000Z", state: "KNOWN" },
          },
        },
      }),
      observation("passport-public-contracts", {
        health: {
          status: "UNKNOWN",
          reason_codes: ["acquisition-status-unknown"],
          clocks: unknownClocks,
        },
      }),
      observation("checkbook-nycha-contracts", {
        health: {
          status: "Source-unavailable",
          reason_codes: ["source-disabled"],
          clocks: unknownClocks,
        },
      }),
    ],
  );

  const cards = view.groups.flatMap((group) => group.sources);
  assert.deepEqual(
    cards.map((card) => card.source_id).sort(),
    ["abo-local-authorities", "city-record", "passport-public-contracts"],
  );
  assert.equal(cards.find((card) => card.source_id === "city-record").health_status, "Degraded");
  assert.equal(dataHealthRowIsNeverAcquired({
    source_id: "abo-local-authorities",
    health: { status: "UNKNOWN", reason_codes: ["acquisition-status-unknown"], clocks: {
      publisher_updated: { at: "2024-06-26T00:00:00.000Z", state: "KNOWN" },
    } },
  }), false);
  assert.equal(dataHealthRowIsNeverAcquired({
    source_id: "passport-public-contracts",
    health: { status: "UNKNOWN", reason_codes: ["acquisition-status-unknown"], clocks: unknownClocks },
  }), false);
  assert.equal(dataHealthRowIsNeverAcquired({
    source_id: "checkbook-nycha-contracts",
    health: { status: "Source-unavailable", reason_codes: ["source-disabled"], clocks: unknownClocks },
  }), true);
  assert.match(html, /Source city-record/);
  assert.match(html, /Source abo-local-authorities/);
  assert.match(html, /Source passport-public-contracts/);
  assert.match(html, /data-health-status="Degraded"/);
  assert.doesNotMatch(html, /checkbook-nycha-contracts|Source checkbook-nycha-contracts/);
});

test("committed ABO family and checkbook-contracts stay on the page with real clocks", () => {
  const committed = JSON.parse(readFileSync(new URL("../site/data/source_health_public.json", import.meta.url)));
  const committedView = buildDataHealthView(committed);
  const committedCards = committedView.groups.flatMap((group) => group.sources);
  const byId = Object.fromEntries(committedCards.map((card) => [card.source_id, card]));
  const required = [
    "abo-local-authorities",
    "abo-local-development-corporations",
    "abo-state-authorities",
    "checkbook-contracts",
    "city-record",
  ];
  for (const id of required) {
    const card = byId[id];
    assert.ok(card, `${id} must stay on the Data health page`);
    assert.ok(
      card.clocks.some((clock) => clock.state === "KNOWN" && clock.display !== "UNKNOWN"),
      `${id} must carry at least one real clock`,
    );
    assert.ok(
      card.clocks.every((clock) => clock.display !== "January 1, 1970"),
      `${id} must not fabricate an epoch date`,
    );
  }
  const rendered = renderDataHealthPage(committed);
  assert.match(rendered, /NYS Authorities Budget Office/);
  assert.match(rendered, /Checkbook NYC registered contracts/);
  assert.match(rendered, /City Record Online/);
  assert.doesNotMatch(rendered, /Checkbook NYC NYCHA contracts/);
});

test("historical and manual composite states render, and degraded names the failure plus retained serving", () => {
  const { view, html } = pageFrom(
    [
      contract("bid-tabulations-historical", { freshness_contract: { mode: "historical" } }),
      contract("dcas-exam-notices", { freshness_contract: { mode: "manual-conditional" } }),
      contract("nycida-build-nyc-projects", { freshness_contract: { mode: "periodic" } }),
    ],
    [
      observation("bid-tabulations-historical", {
        health: {
          status: "Historical",
          reason_codes: ["historical-source"],
          clocks: {
            publisher_updated: { at: "2024-12-19T00:00:00.000Z", state: "KNOWN" },
            cityscroll_checked_acquired: { at: "2026-08-18T10:00:00.000Z", state: "KNOWN" },
            cityscroll_serving: { at: "2026-08-18T11:00:00.000Z", state: "KNOWN" },
          },
        },
      }),
      observation("dcas-exam-notices", {
        health: {
          status: "Healthy",
          reason_codes: [],
          clocks: {
            publisher_updated: { at: "2026-08-01T00:00:00.000Z", state: "KNOWN" },
            cityscroll_checked_acquired: { at: "2026-08-18T10:00:00.000Z", state: "KNOWN" },
            cityscroll_serving: { at: "2026-08-18T11:00:00.000Z", state: "KNOWN" },
          },
        },
      }),
      observation("nycida-build-nyc-projects", {
        health: {
          status: "Degraded",
          reason_codes: ["acquisition-failed", "serving-valid-fallback"],
          clocks: {
            publisher_updated: { at: "2026-07-01T00:00:00.000Z", state: "KNOWN" },
            cityscroll_checked_acquired: { at: "2026-08-18T10:00:00.000Z", state: "KNOWN" },
            cityscroll_serving: { at: "2026-08-01T00:00:00.000Z", state: "KNOWN" },
          },
        },
        relationship_coverage: {
          status: "held",
          join_status: "held",
          reason_codes: ["relationship-join-held"],
        },
      }),
    ],
  );

  const cards = Object.fromEntries(view.groups.flatMap((group) => group.sources).map((card) => [card.source_id, card]));
  assert.equal(cards["bid-tabulations-historical"].health_label, "Historical");
  assert.match(cards["bid-tabulations-historical"].health_note, /no longer receives new updates/);
  assert.equal(cards["dcas-exam-notices"].health_label, "Manual refresh · on schedule");
  assert.equal(cards["nycida-build-nyc-projects"].health_status, "Degraded");
  assert.match(cards["nycida-build-nyc-projects"].health_note, /latest automated check did not succeed/);
  assert.match(cards["nycida-build-nyc-projects"].health_note, /previously verified copy is still being served/);
  assert.equal(cards["nycida-build-nyc-projects"].coverage_label, "Held or failed relationship match");

  assert.match(html, /Historical/);
  assert.match(html, /Manual refresh · on schedule/);
  assert.match(html, /The latest automated check did not succeed/);
  assert.match(html, /A previously verified copy is still being served/);
  assert.match(html, /Held or failed relationship match/);
  assert.doesNotMatch(html, /bot-blocked|403|RequestDetail|dataJs|join_measurement/i);
});

test("an unavailable or unsafe artifact stays explicit and does not fabricate a healthy empty page", () => {
  const html = renderDataHealthPage({
    schema: "cityscroll.public_source_health.v1",
    generated_at: null,
    available: false,
    source_count: null,
    sources: null,
  });
  const unsafe = renderDataHealthPage({
    schema: "cityscroll.public_source_health.v1",
    generated_at: GENERATED_AT,
    available: true,
    source_count: 1,
    sources: [{ source_id: "unsafe", raw_error_body: "secret" }],
  });

  assert.match(html, /Source freshness is unavailable right now/);
  assert.doesNotMatch(html, /data-health-status="Healthy"|0 sources|0<\/|Healthy/);
  assert.match(unsafe, /Source freshness is unavailable right now/);
  assert.doesNotMatch(unsafe, /secret|raw_error/);
});
