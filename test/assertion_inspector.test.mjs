import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildPublicAssertionGraph,
  hydratePublicAssertionInspector,
} from "../site/assertion_inspector.mjs";
import pagesEdge, { edgeRequestKind } from "../site/pages_edge.mjs";

const intelligence = JSON.parse(readFileSync(
  new URL("../site/data/entity_intelligence_lookup.json", import.meta.url),
  "utf8",
));
const bundle = intelligence.project_agency_vendor.bundles[0];

function assetEnvironment() {
  return {
    ASSETS: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/data/entity_intelligence_lookup.json") {
          return Response.json(intelligence);
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

test("production snapshot hydrates a standable assertion graph without inflating totals", () => {
  const projection = buildPublicAssertionGraph(intelligence);

  assert.equal(bundle.subject_ref, "notice:20170516111");
  assert.equal(projection.receipt.verified_assertion_count, 3);
  assert.equal(projection.receipt.possible_assertion_count, 0);
  assert.equal(projection.graph.nodes.filter((node) => node.node_type === "assertion").length, 3);

  const subject = hydratePublicAssertionInspector(projection, { subject_ref: bundle.subject_ref });
  assert.equal(subject.target.kind, "subject");
  assert.equal(subject.assertions.length, 3);
  assert.deepEqual(
    subject.assertions.map((assertion) => assertion.relation).sort(),
    ["named_developer", "parcel_links_project", "published_by_agency"],
  );
  assert.ok(subject.assertions.every((assertion) => assertion.evidence.sources.length === 1));
  assert.ok(subject.assertions.every((assertion) => assertion.method.id));
  assert.ok(subject.assertions.every((assertion) => assertion.confidence === "strong"));
  assert.ok(subject.assertions.every((assertion) => assertion.review.state === "accepted"));

  const encoded = JSON.stringify(subject);
  assert.doesNotMatch(encoded, /raw_snapshot|receipt|actor|review_policy|source_record_id/);
});

test("an assertion traverses through real evidence to related assertions and civic objects", () => {
  const projection = buildPublicAssertionGraph(intelligence);
  const assertionId = projection.assertions.find((row) => row.relation === "parcel_links_project").assertion_id;
  const view = hydratePublicAssertionInspector(projection, { assertion_id: assertionId });

  assert.equal(view.target.kind, "assertion");
  assert.equal(view.assertion.assertion_id, assertionId);
  assert.equal(view.assertion.evidence.sources[0].href, "https://zap.planning.nyc.gov/projects/P2016K0185");
  assert.deepEqual(
    view.related_assertions.map((assertion) => assertion.relation).sort(),
    ["named_developer", "published_by_agency"],
  );
  assert.deepEqual(
    new Set(view.related_objects.map((object) => object.ref)),
    new Set([bundle.subject_ref, ...bundle.refs]),
  );
  assert.ok(view.related_objects.every((object) => object.href));
  assert.equal(view.counts.verified_assertions, 3);
  assert.equal(view.counts.possible_assertions, 0);
});

test("provisional or incomplete edges cannot enter the public traversal", () => {
  const candidate = structuredClone(intelligence);
  candidate.project_agency_vendor.bundles[0].edges.push({
    type: "possible_financier",
    from: bundle.subject_ref,
    to: "vendor:stem:UNVERIFIED",
    confidence: "tentative",
    method: "probabilistic_name_v1",
    review_state: "provisional",
    provenance: {
      source_system: "city_record",
      source_record_id: "city_record:20170516111",
      source_fields: ["additional_description_1"],
      observed_at: "2017-05-19T00:00:00.000",
      source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20170516111",
    },
  });

  const projection = buildPublicAssertionGraph(candidate);
  const view = hydratePublicAssertionInspector(projection, { subject_ref: bundle.subject_ref });
  assert.equal(projection.receipt.verified_assertion_count, 3);
  assert.equal(projection.receipt.possible_assertion_count, 1);
  assert.equal(view.assertions.length, 3);
  assert.doesNotMatch(JSON.stringify(view), /possible_financier|UNVERIFIED/);
});

test("Pages edge serves subject and assertion inspector targets from the production snapshot", async () => {
  const projection = buildPublicAssertionGraph(intelligence);
  const assertionId = projection.assertions[0].assertion_id;
  const env = assetEnvironment();

  assert.equal(edgeRequestKind("https://cityscroll.org/assertions/?subject=notice%3A20170516111"), "assertion");
  assert.equal(edgeRequestKind(`https://cityscroll.org/assertions/${encodeURIComponent(assertionId)}/`), "assertion");

  const subjectResponse = await pagesEdge.fetch(
    new Request("https://cityscroll.org/assertions/?subject=notice%3A20170516111"),
    env,
  );
  assert.equal(subjectResponse.status, 200);
  const subjectHtml = await subjectResponse.text();
  assert.match(subjectHtml, /data-civic-object-kind="assertion-inspector"/);
  assert.match(subjectHtml, /3 verified assertions/);
  assert.match(subjectHtml, /Official project/);
  assert.match(subjectHtml, /Inspect this assertion/);

  const assertionResponse = await pagesEdge.fetch(
    new Request(`https://cityscroll.org/assertions/${encodeURIComponent(assertionId)}/`),
    env,
  );
  assert.equal(assertionResponse.status, 200);
  const assertionHtml = await assertionResponse.text();
  assert.match(assertionHtml, /Related assertions/);
  assert.match(assertionHtml, /Related civic objects/);

  const missing = await pagesEdge.fetch(
    new Request("https://cityscroll.org/assertions/assertion%3Amissing%3Av1/"),
    env,
  );
  assert.equal(missing.status, 404);
});
