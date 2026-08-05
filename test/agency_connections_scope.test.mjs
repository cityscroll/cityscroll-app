import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildAgencyConnectionView,
  connectionScopeHash,
} from "../site/agency_connections.mjs";
import * as CrolScope from "../site/scope_v0.mjs";

const { scopeFromRouteHash } = CrolScope;

const materialization = JSON.parse(
  readFileSync(new URL("../site/data/entity_intelligence_lookup.json", import.meta.url), "utf8"),
);
const HPD_REF = "agency:id:housing-preservation-and-development";
const hpd = {
  ...materialization.by_ref[HPD_REF],
  materialization_meta: {
    generated_at: materialization.generated_at,
    observation_count: materialization.observation_count,
  },
};

test("HPD connection view separates verified records from possible matches across five domains", () => {
  const view = buildAgencyConnectionView(hpd, {
    currentHash: "#money?mode=award",
    scope: CrolScope,
  });

  assert.equal(view.groups.filter((group) => group.status === "matched").length, 5);
  assert.equal(view.summary.strong_count, 18);
  assert.equal(view.summary.tentative_count, 2);
  assert.equal(view.summary.coverage_eligible, null);
  assert.equal(view.summary.coverage_linked, 18);
  assert.equal(view.summary.vintage, materialization.generated_at);
  assert.deepEqual(
    view.groups.filter((group) => group.status === "matched").map((group) => group.role_key),
    [
      "entity_intel_role_bought",
      "entity_intel_role_land",
      "entity_intel_role_property",
      "entity_intel_role_rules",
      "entity_intel_role_meetings",
    ],
  );
  assert.equal(view.groups.find((group) => group.domain === "land").strong_count, 0);
  assert.equal(view.groups.find((group) => group.domain === "land").tentative_count, 2);
});

test("connection and apply links round-trip as canonical typed scopes", () => {
  const view = buildAgencyConnectionView(hpd, {
    currentHash: "#money?mode=award&min=100000",
    scope: CrolScope,
  });
  const applied = scopeFromRouteHash(view.apply_scope_href);
  assert.deepEqual(applied.facets.domains, ["money"]);
  assert.deepEqual(applied.facets.agencies, ["Housing Preservation and Development"]);
  assert.deepEqual(applied.facets.values.entity_refs_all, [HPD_REF]);
  assert.equal(applied.facets.values.mode, "award");
  assert.equal(applied.facets.values.minAmount, 100000);

  const money = view.groups.find((group) => group.domain === "money");
  const roundTripped = scopeFromRouteHash(money.view_all_href);
  assert.deepEqual(roundTripped.facets.domains, ["money"]);
  assert.deepEqual(roundTripped.facets.agencies, ["Housing Preservation and Development"]);
  assert.deepEqual(roundTripped.facets.values.entity_refs_all, [HPD_REF]);
  assert.equal(roundTripped.facets.values.connection_relation, "published_by_agency");
  assert.equal(roundTripped.facets.values.mode, "award");
  assert.equal(connectionScopeHash(hpd, "money", { scope: CrolScope }), money.view_all_href);
});

test("empty and not-yet-ingested states stay distinct", () => {
  const response = structuredClone(hpd);
  response.domains.people = {
    status: "not_yet_ingested",
    gap_class: "source_not_ingested",
    note: "People coverage is not loaded.",
    objects: [],
    count: 0,
  };
  response.domains.franchise = {
    status: "empty",
    gap_class: "empty_in_corpus",
    note: "No franchise records resolved.",
    objects: [],
    count: 0,
  };

  const view = buildAgencyConnectionView(response, { scope: CrolScope });
  assert.equal(view.groups.find((group) => group.domain === "people").status, "not_yet_ingested");
  assert.equal(view.groups.find((group) => group.domain === "franchise").status, "empty");
});

test("weak and review-only candidates never enter the connection view", () => {
  const response = structuredClone(hpd);
  response.domains.money.objects.unshift(
    {
      subject_ref: "notice:weak",
      label: "Weak candidate",
      confidence: "weak",
      link_type: "weak_relation",
    },
    {
      subject_ref: "notice:review",
      label: "Review candidate",
      confidence: "review_only",
      link_type: "review_relation",
    },
  );

  const money = buildAgencyConnectionView(response, { scope: CrolScope })
    .groups.find((group) => group.domain === "money");
  assert.equal(money.strong_count, hpd.domains.money.objects.length);
  assert.equal(money.tentative_count, 0);
  assert.equal(money.relation, "published_by_agency");
  assert.ok(money.objects.every((object) => ["strong", "tentative"].includes(object.confidence)));
  assert.ok(money.objects.every((object) => !object.label?.includes("candidate")));
});
