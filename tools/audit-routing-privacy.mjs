import assert from "node:assert/strict";
import { readJson } from "./lib/wave4-build.mjs";

const ontology = readJson("test/fixtures/wave4/generated/routing_ontology.json");
const research = readJson("test/fixtures/wave4/subscriber-research.json");
assert.equal(ontology.profile_storage, false);
assert.deepEqual(ontology.behavioral_inputs, []);
assert.ok(ontology.excluded_inferences.includes("browser_history"));
assert.equal(research.privacy.subscriber_addresses_in_artifact, 0);
assert.equal(research.privacy.findings_publication_level, "aggregate_only");
for (const fixture of ontology.fixtures) {
  assert.equal(fixture.result.matched, fixture.expected, fixture.id);
  assert.ok(fixture.result.rule);
  assert.ok(fixture.public_inputs.length);
}
const nonCooperation = ontology.fixtures.find((fixture) => fixture.id === "noncooperation-public-notice");
assert.equal(nonCooperation.result.matched, true);
assert.equal(nonCooperation.agency_enrichment_required, false);
console.log(`audited ${ontology.fixtures.length} declared-interest routes`);
