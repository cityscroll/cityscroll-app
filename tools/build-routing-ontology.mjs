import { readJson, sha256, writeOrCheck } from "./lib/wave4-build.mjs";
import { routeNotice, validateRoutingOntology } from "../worker/src/lib/declared_interest_routing.mjs";

const check = process.argv.includes("--check");
const research = readJson("data/subscriber-research/latest.json");
const fixtures = readJson("data/wave4/routing-fixtures.json");
const ontology = validateRoutingOntology({
  schema_version: "1.0.0",
  snapshot_date: fixtures.snapshot_date,
  research_status: research.status,
  research_artifact_hash: sha256(research),
  profile_storage: false,
  behavioral_inputs: [],
  dimensions: [
    {id: "topics", source: "subscriber_declaration", provisional: !research.survey.fielded},
    {id: "places", source: "subscriber_declaration", provisional: !research.survey.fielded},
    {id: "actions", source: "subscriber_declaration", provisional: !research.survey.fielded}
  ],
  excluded_inferences: ["identity", "occupation", "protected_class", "union_membership", "visitor_location", "browser_history"],
  fixtures: fixtures.routes.map((fixture) => ({
    id: fixture.id,
    expected: fixture.expected,
    result: routeNotice(fixture.declared, fixture.notice),
    public_inputs: fixture.notice.public_inputs,
    agency_enrichment_required: false
  }))
});
writeOrCheck("data/routing_ontology.json", ontology, check);
