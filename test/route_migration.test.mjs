import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalizeBrowseUrl, migrateLegacyUrl } from "../site/route_migration.mjs";
import { appendTraversalHop, decodeTraversalPath, traversalFromHref, traversalBackHref, traversalRestartHref } from "../site/traversal_path.mjs";

test("an agency to vendor to award trail survives notice forwarding and fresh URL replay", () => {
  // Synthetic identities: this regression must not depend on a rolling publisher window.
  const agency = { kind: "agency", id: "example-agency", name: "Example agency", href: "/agencies/example-agency/" };
  const vendor = { kind: "vendor", id: "example-vendor", name: "Example vendor", href: "/vendors/example-vendor/" };
  const award = { kind: "notice", id: "example-award", name: "Example award", href: "#notice/example-award" };
  const first = appendTraversalHop(vendor.href, { source: agency, relation: "published by agency", destination: vendor });
  const second = appendTraversalHop(award.href, { source: vendor, relation: "received award", destination: award }, traversalFromHref(first.href));
  const mapped = migrateLegacyUrl(`/?lang=es${second.href}&focus=source`);
  const copied = new URL(mapped.target, "https://cityscroll.org");
  assert.equal(copied.pathname, "/notices/example-award");
  assert.equal(copied.searchParams.get("lang"), "es");
  assert.equal(copied.searchParams.get("focus"), "source");
  assert.deepEqual(mapped.unsupported, []);
  // Only the copied address is supplied: no session state or prepared final token.
  const reopened = traversalFromHref(copied.href);
  assert.equal(reopened.hops.length, 2);
  assert.deepEqual(reopened, second.state);
  assert.equal(traversalFromHref(traversalBackHref(reopened)).hops.length, 1);
  assert.equal(traversalRestartHref(reopened), agency.href);
  const duplicate = migrateLegacyUrl(`${second.href}&walk=${copied.searchParams.get("walk")}`);
  assert.equal(duplicate.target, "/notices/example-award?legacy=unsupported-filter");
  assert.deepEqual(duplicate.unsupported, ["walk"]);
});

test("notice forwarding rejects malformed, oversized and unsupported walk payloads", () => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const token of ["not-json", "a".repeat(6001), encode({ schema: "unknown", version: 1 }),
    encode({ schema: "cityscroll.traversal.v1", version: 1, hops: [{ source: { href: "/unsupported/" }, destination: { href: "/notices/example" } }] })]) {
    assert.equal(decodeTraversalPath(token).status, "held");
    const mapped = migrateLegacyUrl(`/#notice/example?walk=${token}`);
    assert.equal(mapped.target, "/notices/example?legacy=unsupported-filter");
    assert.deepEqual(mapped.unsupported, ["walk"]);
  }
  assert.equal(migrateLegacyUrl("/#notice/example").target, "/notices/example");
  for (const hops of [undefined, "invalid", []]) {
    const token = encode({ schema: "cityscroll.traversal.v1", version: 1, hops });
    assert.equal(migrateLegacyUrl(`/#notice/example?walk=${token}`).target, "/notices/example?legacy=unsupported-filter");
  }
  assert.equal(migrateLegacyUrl("/#money?walk=not-json").target, "/browse/contracts/?legacy=unsupported-filter");
});

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
