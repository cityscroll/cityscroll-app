import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalizeBrowseUrl, migrateLegacyUrl } from "../site/route_migration.mjs";

test("legacy fragment mappings remain finite and preserve language through docs", () => {
  assert.equal(migrateLegacyUrl("/#exam/7016").target, "/exams/7016/");
  assert.equal(migrateLegacyUrl("/?lang=es#exam/7016").target, "/exams/7016/?lang=es");
  assert.equal(migrateLegacyUrl("/index.html#notice/20240515016").target, "/notices/20240515016");
  assert.equal(migrateLegacyUrl("/#notice/20240515016?w=%7B%22lens%22%3A%22money%22%7D&focus=follow-the-dollars").target,
    "/notices/20240515016?w=%7B%22lens%22%3A%22money%22%7D&focus=follow-the-dollars");
  assert.equal(migrateLegacyUrl("/#people").target, "/browse/people/");
  assert.equal(migrateLegacyUrl("/#staffing").target, "/browse/staffing/");
  assert.equal(migrateLegacyUrl("/#staffing?lang=es&view=guide&window=open").target,
    "/browse/exams/?lang=es&window=open");
  assert.equal(migrateLegacyUrl("/#exam").target, "/browse/exams/");
  assert.equal(migrateLegacyUrl("/#people?view=guide&interest=technology-science").target,
    "/browse/exams/?interest=technology-science");
  assert.equal(migrateLegacyUrl("/#exams?eligibility=promotion").target,
    "/browse/exams/?eligibility=promotion");
});

test("legacy borough scope links still normalize across list lenses", () => {
  assert.equal(migrateLegacyUrl("/#property?boro=Brooklyn").target, "/browse/property/?boro=Brooklyn");
  assert.equal(migrateLegacyUrl("/#land?boro=Queens").target, "/browse/zoning/?boro=Queens");
  assert.equal(migrateLegacyUrl("/#rules?boro=Bronx").target, "/browse/rules/?boro=Bronx");
  assert.equal(migrateLegacyUrl("/#meetings?boro=Manhattan").target, "/browse/meetings/?boro=Manhattan");
});

test("orthogonal Zoning stage and future-action filters survive document migration", () => {
  assert.equal(
    migrateLegacyUrl("/#land?stage=public_review&future=hearing&procedure=elurp&sort=action_date").target,
    "/browse/zoning/?stage=public_review&future=hearing&procedure=elurp&sort=action_date",
  );
});

test("unsupported legacy scope keys are surfaced explicitly", () => {
  const mapped = migrateLegacyUrl("/#notice/20240515016?q=air&retiredMode=secret");
  assert.equal(mapped.target, "/notices/20240515016?legacy=unsupported-filter");
  assert.deepEqual(mapped.unsupported, ["q", "retiredMode"]);
});

test("mixed People, Staffing, and Exams filters fail closed on their intended surface", () => {
  assert.equal(migrateLegacyUrl("/#people?role=Engineer").target,
    "/browse/people/?legacy=unsupported-filter");
  assert.equal(migrateLegacyUrl("/#staffing?interest=technology-science").target,
    "/browse/staffing/?legacy=unsupported-filter");
  assert.equal(migrateLegacyUrl("/#staffing?view=guide&role=Engineer").target,
    "/browse/exams/?legacy=unsupported-filter");
});

test("browse agency aliases normalize to one typed facet serialization", () => {
  const legacy = "/browse/contracts/?mode=award&agency=Housing+Preservation+and+Development&facet="
    + encodeURIComponent(JSON.stringify({ entity_refs_all: ["agency:id:housing-preservation-and-development"], connection_relation: "published_by_agency" }));
  const canonical = canonicalizeBrowseUrl(legacy);
  const params = new URL(canonical, "https://cityscroll.org").searchParams;
  assert.equal(params.has("agency"), false);
  assert.deepEqual(JSON.parse(params.get("facet")), {
    entity_refs_all: ["agency:id:housing-preservation-and-development"],
    connection_relation: "published_by_agency",
  });
  assert.equal(migrateLegacyUrl("/#money?agency=Housing+Preservation+and+Development&facet="
    + encodeURIComponent(JSON.stringify({ entity_refs_all: ["agency:id:housing-preservation-and-development"] }))).target,
    "/browse/contracts/?facet=%7B%22entity_refs_all%22%3A%5B%22agency%3Aid%3Ahousing-preservation-and-development%22%5D%7D");
});

test("Exams aliases retain their public path while normalizing agency scope", () => {
  const url = canonicalizeBrowseUrl("/browse/exams/?agency=Department+of+Parks+and+Recreation");
  assert.match(url, /^\/browse\/exams\/\?facet=/);
  assert.doesNotMatch(url, /agency=/);
});

test("non-converted routes and public invariants stay outside the rewrite bridge", () => {
  assert.equal(migrateLegacyUrl("/#matter/84124P0003001").target, "/#matter/84124P0003001");
  assert.equal(migrateLegacyUrl("/stats.html").target, "/stats.html");
  assert.equal(migrateLegacyUrl("https://api.cityscroll.org/stats").target, "/stats");
  assert.equal(migrateLegacyUrl("/#alerts?foo=1").target, "/following/?legacy=unsupported-filter");
});
