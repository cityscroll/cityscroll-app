import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyScope,
  intersectScopes,
  normalizeScope,
  routeHashFromScope,
  scopeFromRouteHash,
  scopeWithEntity,
} from "../site/scope_v0.mjs";
import {
  entityChipHTML,
  entityFromHref,
  entityHref,
  parseEntityRef,
  reconcileAgencyIdentity,
  resolveAgencyIdentity,
} from "../site/entity_pivot.mjs";
import { buildSubjectEntityIndex } from "../tools/lib/entity_intelligence_build.mjs";

const CAMBA = "vendor:stem:CAMBA";
const DSS = "agency:id:homeless-services";
const TIMBALE = "project:2022M0258";

test("typed entity refs fail closed and mint canonical document routes", () => {
  assert.deepEqual(parseEntityRef(CAMBA), {
    kind: "vendor",
    id: "stem:CAMBA",
    ref: CAMBA,
  });
  assert.deepEqual(parseEntityRef("entity:official:7801"), {
    kind: "official",
    id: "7801",
    ref: "entity:official:7801",
  });
  assert.deepEqual(parseEntityRef(TIMBALE), {
    kind: "project",
    id: "2022M0258",
    ref: TIMBALE,
  });
  assert.equal(parseEntityRef("notice:20260706036"), null);
  assert.equal(parseEntityRef("vendor:stem:CAM BA"), null);

  assert.equal(entityHref({ ref: CAMBA, label: "CAMBA" }), "/vendors/CAMBA/");
  assert.equal(entityHref({ ref: TIMBALE, label: "Timbale Terrace" }), "#land/2022M0258");
  assert.equal(
    entityHref({ ref: DSS, label: "Homeless Services" }, { tab: "forecast" }),
    "/agencies/homeless-services/?tab=forecast",
  );
  assert.equal(
    entityHref(
      { ref: "entity:official:7801", label: "Member" },
      { eventId: "22526", noticeId: "20260706036" },
    ),
    "/officials/7801/?event=22526&notice=20260706036",
  );
  assert.equal(entityHref({ ref: "notice:1", label: "not an entity" }), "");
  assert.deepEqual(entityFromHref("#land/2022M0258", "Timbale Terrace"), {
    ref: TIMBALE,
    label: "Timbale Terrace",
    options: { tab: "", eventId: "", noticeId: "" },
  });
});

test("entity chips link accepted refs, band tentative matches, and suppress review candidates", () => {
  const strong = entityChipHTML({
    ref: CAMBA,
    label: "CAMBA & Co",
    link_confidence: "strong",
    relation: "named_vendor",
  });
  assert.match(strong, /<a class="ui-constellation-link pivot entity-pivot" href="\/vendors\/CAMBA\/"[^>]*><span aria-hidden="true">◆<\/span>/);
  assert.match(strong, /CAMBA &amp; Co/);
  assert.doesNotMatch(strong, /Possible match/);

  const tentative = entityChipHTML({
    ref: CAMBA,
    label: "CAMBA",
    link_confidence: "tentative",
    relation: "applicant_vendor",
    evidence: "Primary applicant name",
  });
  assert.match(tentative, /data-link-confidence="tentative"/);
  assert.match(tentative, /Possible match/);
  assert.match(tentative, /Primary applicant name/);

  const review = entityChipHTML({
    ref: CAMBA,
    label: "CAMBA <review>",
    link_confidence: "review_only",
    relation: "possibly_same",
  });
  assert.equal(review, "CAMBA &lt;review&gt;");
  assert.doesNotMatch(review, /href=/);
});

test("tentative evidence never renders an empty affordance", () => {
  const withoutEvidence = entityChipHTML({
    ref: CAMBA,
    label: "CAMBA",
    link_confidence: "tentative",
  });
  assert.doesNotMatch(withoutEvidence, /Evidence/);
  assert.doesNotMatch(withoutEvidence, /title=""/);

  const withFeatures = entityChipHTML({
    ref: CAMBA,
    label: "CAMBA",
    link_confidence: "tentative",
    evidence: { comparison_features: { stem_equal: true, shared_tokens: ["CAMBA"] } },
  });
  assert.match(withFeatures, /Evidence/);
  assert.match(withFeatures, /Names reduce to the same name/);
  assert.match(withFeatures, /Names share key terms/);
});

test("unmatched agency identities fail closed instead of creating dead profile pivots", () => {
  assert.equal(
    entityHref({
      ref: "agency:id:edc-economic-development-corporation-for-nyc",
      label: "EDC - Economic Development Corporation for NYC",
    }),
    "",
  );
  const text = entityChipHTML({
    ref: "agency:id:edc-economic-development-corporation-for-nyc",
    label: "EDC - Economic Development Corporation for NYC",
    link_confidence: "tentative",
    evidence: "land_primary_applicant",
  });
  assert.doesNotMatch(text, /href=/);
  assert.match(text, /organization/);
});

test("agency display aliases resolve to the same canonical identity and never enter the href", () => {
  for (const arrival of [
    "Design and Construction",
    "Design and Construction (DDC)",
    "Department of Design and Construction",
    "DESIGN & CONSTRUCTION",
  ]) {
    const identity = resolveAgencyIdentity(arrival);
    assert.equal(identity.canonical_id, "design-and-construction");
    assert.equal(identity.canonical_name, "Design and Construction");
    assert.ok(identity.variants.includes("Design and Construction"));
  }
  const html = entityChipHTML({
    ref: "agency:id:design-and-construction",
    label: "Design and Construction (DDC)",
    link_confidence: "strong",
  });
  assert.match(html, /href="\/agencies\/design-and-construction\/"/);
  assert.match(html, />Design and Construction \(DDC\)<\/a>/);
  assert.doesNotMatch(html, /href="[^"]*DDC/);
});

test("the source crosswalk makes canonical agency ids reversible to every exact source spelling", () => {
  const rows = [
    {
      raw_string: "Triborough Bridge and Tunnel Authority",
      canonical_id: "triborough-bridge-and-tunnel-authority",
      canonical_name: "Triborough Bridge and Tunnel Authority",
      variants: ["TRIBOROUGH BRIDGE & TUNNEL AUTH", "Triborough Bridge and Tunnel Authority"],
    },
  ];
  const identity = reconcileAgencyIdentity("triborough-bridge-and-tunnel-authority", rows);
  assert.equal(identity.canonical_name, "Triborough Bridge and Tunnel Authority");
  assert.deepEqual(identity.variants, [
    "Triborough Bridge and Tunnel Authority",
    "TRIBOROUGH BRIDGE & TUNNEL AUTH",
  ]);
  assert.equal(identity.matched, true);
});

test("scopeWithEntity is normalized, idempotent, and ignores invalid refs", () => {
  const base = emptyScope();
  base.facets.domains = ["money"];
  const once = scopeWithEntity(base, CAMBA);
  const twice = scopeWithEntity(once, CAMBA);
  assert.deepEqual(once, twice);
  assert.deepEqual(once.facets.values.entity_refs_all, [CAMBA]);
  assert.deepEqual(scopeWithEntity(once, "notice:1"), once);

  const project = scopeWithEntity(emptyScope(), TIMBALE);
  project.facets.domains = ["land"];
  const projectHash = routeHashFromScope(project, { surface: "land" });
  assert.deepEqual(scopeFromRouteHash(projectHash).facets.values.entity_refs_all, [TIMBALE]);
});

test("structured scope intersection is commutative, idempotent, and closed", () => {
  const awards = scopeFromRouteHash("#money?mode=award&agency=Homeless+Services");
  awards.time_window.start = "2026-01-01";
  awards.time_window.end = "2026-12-31";
  awards.topic.keywords = ["shelter"];

  const vendor = scopeWithEntity(emptyScope(), CAMBA);
  vendor.facets.domains = ["money", "land"];
  vendor.time_window.start = "2026-04-01";
  vendor.time_window.end = "2027-03-31";
  vendor.topic.keywords = ["services", "shelter"];

  const left = intersectScopes(awards, vendor);
  const right = intersectScopes(vendor, awards);
  assert.deepEqual(left, right);
  assert.deepEqual(intersectScopes(left, left), left);
  assert.deepEqual(left.facets.domains, ["money"]);
  assert.deepEqual(left.facets.agencies, ["Homeless Services"]);
  assert.deepEqual(left.facets.values.entity_refs_all, [CAMBA]);
  assert.equal(left.facets.values.mode, "award");
  assert.equal(left.time_window.start, "2026-04-01");
  assert.equal(left.time_window.end, "2026-12-31");
  assert.deepEqual(left.topic.keywords, ["services", "shelter"]);

  const urlScope = intersectScopes(
    scopeFromRouteHash("#money?mode=award&agency=Homeless+Services"),
    scopeWithEntity(emptyScope(), CAMBA),
  );
  const hash = routeHashFromScope(urlScope, { surface: "money" });
  assert.match(hash, /^#money\?mode=award&agency=Homeless\+Services&/);
  assert.match(hash, /(?:^|&)facet=/);
  assert.deepEqual(scopeFromRouteHash(hash), normalizeScope(urlScope));
});

test("disjoint allowlists, inverted dates, and unsupported query conjunctions produce bottom", () => {
  const money = emptyScope();
  money.facets.domains = ["money"];
  const land = emptyScope();
  land.facets.domains = ["land"];
  assert.equal(intersectScopes(money, land).facets.values.match_none, true);

  const early = emptyScope();
  early.time_window.start = "2026-08-01";
  const ended = emptyScope();
  ended.time_window.end = "2026-07-31";
  assert.equal(intersectScopes(early, ended).facets.values.match_none, true);

  const roofs = emptyScope();
  roofs.topic.query = "roof repair";
  const boilers = emptyScope();
  boilers.topic.query = "boiler replacement";
  const unsupported = intersectScopes(roofs, boilers);
  assert.equal(unsupported.facets.values.match_none, true);
  assert.deepEqual(unsupported.facets.values.composition_unsupported, ["topic.query"]);
});

test("required entity refs union while OR-like value allowlists meet", () => {
  const a = scopeWithEntity(emptyScope(), CAMBA);
  a.facets.values.notice_types = ["Award", "Solicitation"];
  const b = scopeWithEntity(emptyScope(), DSS);
  b.facets.values.notice_types = ["Award", "Hearing"];
  const met = intersectScopes(a, b);
  assert.deepEqual(met.facets.values.entity_refs_all, [DSS, CAMBA]);
  assert.deepEqual(met.facets.values.notice_types, ["Award"]);
});

test("subject reverse index exposes only public strong or tentative entity links", () => {
  const bySubject = buildSubjectEntityIndex({
    by_ref: {
      [DSS]: {
        root: { ref: DSS, kind: "agency", display_name: "Homeless Services" },
        links: [
          { type: "published_by_agency", from: "notice:1", to: DSS, confidence: "strong", domain: "money" },
          { type: "applicant_agency", from: "project:2", to: DSS, confidence: "tentative", domain: "land" },
          { type: "possibly_same", from: "vendor:stem:MAYBE", to: DSS, confidence: "review_only", domain: "money" },
        ],
      },
    },
  });
  assert.deepEqual(bySubject["notice:1"], [{
    entity_ref: DSS,
    relation: "published_by_agency",
    confidence: "strong",
  }]);
  assert.equal(bySubject["vendor:stem:MAYBE"], undefined);
  assert.equal(bySubject[DSS], undefined);
});
