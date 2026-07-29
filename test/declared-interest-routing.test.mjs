import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { routeNotice, validateRoutingOntology } from "../worker/src/lib/declared_interest_routing.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/wave4/routing-fixtures.json", import.meta.url)));
const ontology = JSON.parse(readFileSync(new URL("./fixtures/wave4/generated/routing_ontology.json", import.meta.url)));
const research = JSON.parse(readFileSync(new URL("./fixtures/wave4/subscriber-research.json", import.meta.url)));

test("every route states its declared rule and public inputs", () => {
  for (const fixture of fixtures.routes) {
    const result = routeNotice(fixture.declared, fixture.notice);
    assert.equal(result.matched, fixture.expected, fixture.id);
    assert.equal(result.rule.kind, "declared_interest");
    assert.deepEqual(result.rule.public_inputs, fixture.notice.public_inputs);
    assert.ok(result.reason);
  }
});

test("browser history and inferred context cannot change a route", () => {
  const fixture = fixtures.routes[0];
  const plain = routeNotice(fixture.declared, fixture.notice);
  const surveilled = routeNotice(fixture.declared, fixture.notice, {
    browser_history: ["unrelated searches"],
    inferred_location: "Staten Island",
    identity: "example"
  });
  assert.deepEqual(surveilled, plain);
});

test("public-notice-only routing does not depend on agency cooperation", () => {
  const fixture = fixtures.routes.find((row) => row.id === "noncooperation-public-notice");
  assert.equal(fixture.notice.agency_enrichment, null);
  assert.equal(routeNotice(fixture.declared, fixture.notice).matched, true);
});

test("subscriber research records a denominator without publishing addresses", () => {
  assert.equal(research.survey.invited, 0);
  assert.equal(research.survey.responses, 0);
  assert.equal(research.privacy.subscriber_addresses_in_artifact, 0);
  assert.equal(research.sampling_frame_request.status, "draft_not_sent");
});

test("ontology is explicitly provisional until fieldwork changes it", () => {
  validateRoutingOntology(ontology);
  assert.equal(ontology.research_status, "pre_field");
  assert.ok(ontology.dimensions.every((dimension) => dimension.provisional));
  assert.deepEqual(ontology.behavioral_inputs, []);
});
