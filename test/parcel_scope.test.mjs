import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildObservedParcelBiography,
  parcelBiographyHref,
  parcelBblFromScope,
  parcelRef,
  scopeWithParcel,
} from "../site/parcel_scope.mjs";
import { entityChipHTML, parseEntityRef } from "../site/entity_pivot.mjs";
import * as scopeTools from "../site/scope_v0.mjs";

const { emptyScope, scopeFromRouteHash } = scopeTools;

const crossDomain = JSON.parse(readFileSync(
  new URL("../site/data/property_cross_domain_lookup.json", import.meta.url),
  "utf8",
));
const taxLien = JSON.parse(readFileSync(
  new URL("../site/data/tax_lien_sale_bbl.json", import.meta.url),
  "utf8",
));
const cofo = JSON.parse(readFileSync(
  new URL("../site/data/dob_cofo_lookup.json", import.meta.url),
  "utf8",
));

test("parcel refs and scopes accept only exact ten-digit BBLs", () => {
  assert.equal(parcelRef("1020260015"), "bbl:1020260015");
  assert.equal(parcelRef("1-02026-0015"), "");
  assert.equal(parcelRef("West 125th Street"), "");
  assert.equal(parcelRef("1020260015 nearby"), "");
  assert.deepEqual(parseEntityRef("bbl:1020260015"), {
    kind: "parcel",
    id: "1020260015",
    ref: "bbl:1020260015",
  });
  assert.equal(parseEntityRef("bbl:West 125th Street"), null);

  const scoped = scopeWithParcel(emptyScope(), "1020260015");
  assert.deepEqual(scoped.facets.values.entity_refs_all, ["bbl:1020260015"]);
  assert.equal(parcelBblFromScope(scoped), "1020260015");
  assert.deepEqual(scopeWithParcel(emptyScope(), "West 125th Street"), emptyScope());
});

test("parcel biography links use the gc-01 canonical scope serializer", () => {
  const base = scopeFromRouteHash("#property?boro=Manhattan&process=hearing");
  const href = parcelBiographyHref("1020260015", { scope: base });
  const roundTrip = scopeFromRouteHash(href);
  assert.match(href, /^#property\?boro=Manhattan&process=hearing&facet=/);
  assert.equal(parcelBblFromScope(roundTrip), "1020260015");

  const chip = entityChipHTML({
    ref: "bbl:1020260015",
    label: "BBL 1020260015",
    link_confidence: "strong",
    relation: "sits_on_parcel",
  }, { scope: base, surface: "property", scopeTools });
  assert.match(chip, /data-entity-ref="bbl:1020260015"/);
  assert.match(chip, /href="#property\?boro=Manhattan&amp;process=hearing&amp;facet=/);
});

test("matched observed biography separates disposition, ZAP, and lien-list evidence", () => {
  const view = buildObservedParcelBiography({
    bbl: "1020260015",
    crossDomain,
    taxLien,
  });
  assert.equal(view.ok, true);
  assert.equal(view.label, "Observed parcel biography");
  assert.equal(view.parcel_ref, "bbl:1020260015");

  assert.equal(view.sections.property.status, "observed");
  assert.ok(view.sections.property.items.length >= 1);
  assert.ok(view.sections.property.items.every((item) => (
    item.source === "City Record Online"
      && item.date
      && item.relation === "sits_on_parcel"
      && item.href.startsWith("#notice/")
  )));

  assert.equal(view.sections.land.status, "observed");
  assert.ok(view.sections.land.items.length >= 1);
  assert.ok(view.sections.land.items.every((item) => (
    item.source === "ZAP / zap-bbl"
      && item.relation === "sits_on_parcel"
      && item.href.startsWith("#land?project=")
  )));

  assert.equal(view.sections.tax_lien.status, "observed");
  assert.equal(view.sections.tax_lien.items[0].relation, "appeared_on_published_list");
  assert.equal(view.sections.tax_lien.items[0].source, "NYC Department of Finance");
  assert.equal(view.sections.tax_lien.items[0].date, taxLien.data_vintage);

  for (const section of Object.values(view.sections)) {
    assert.ok(section.coverage, "each evidence family must carry coverage");
    assert.ok("eligible" in section.coverage);
    assert.ok("linked" in section.coverage);
    assert.ok("rate" in section.coverage);
    assert.ok("vintage" in section.coverage);
    assert.ok(section.coverage.gaps);
  }
  assert.equal("owners" in view.sections, false, "zero-coverage owner blocks stay omitted");
  assert.doesNotMatch(JSON.stringify(view), /complete(?: parcel)? history|every event/i);
});

test("CofO evidence is an exact-BBL graph slice with row provenance", () => {
  const bbl = Object.keys(cofo.by_bbl).find((id) => crossDomain.by_bbl?.[id]);
  assert.ok(bbl, "fixture graph should have one BBL in both read models");
  const view = buildObservedParcelBiography({ bbl, crossDomain, taxLien, cofo });
  assert.equal(view.sections.cofo.status, "observed");
  assert.ok(view.sections.cofo.items.length >= 1);
  assert.ok(view.sections.cofo.items.every((item) => (
    item.source === "NYC Department of Buildings"
      && item.relation === "legal_occupancy_on_parcel"
      && item.confidence === "strong"
      && item.method === "exact_bbl_v1"
  )));
  assert.equal(view.sections.cofo.coverage.eligible, cofo.coverage.eligible);
  assert.equal(view.sections.cofo.coverage.linked, cofo.coverage.linked);
  assert.ok(Object.values(cofo.by_bbl).flat().every((row) => row.provenance?.source_record_id));
});

test("unmatched ZAP section is an explicit corpus gap, not a citywide claim", () => {
  const view = buildObservedParcelBiography({
    bbl: "5006840261",
    crossDomain,
    taxLien,
  });
  assert.equal(view.ok, true);
  assert.equal(view.sections.property.status, "observed");
  assert.equal(view.sections.land.status, "not_observed");
  assert.equal(view.sections.land.items.length, 0);
  assert.match(view.sections.land.note, /not proof/i);
});

test("address and name candidates cannot enter the biography through lookup keys", () => {
  const contaminated = {
    ...crossDomain,
    by_bbl: {
      ...crossDomain.by_bbl,
      "West 125th Street": {
        bbl: "West 125th Street",
        parcel_ref: "bbl:West 125th Street",
        property_notices: [{ request_id: "invented", label: "Possible address match" }],
        land_projects: [{ project_id: "invented" }],
      },
    },
  };
  const view = buildObservedParcelBiography({
    bbl: "West 125th Street",
    crossDomain: contaminated,
    taxLien,
  });
  assert.deepEqual(view, { ok: false, reason: "invalid_bbl" });
});
