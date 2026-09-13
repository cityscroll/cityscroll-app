import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeProcurementDate, projectProcurementFacts } from "../site/procurement_fact_projection.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/procurement-detail-parity/ct107120258801626.json", import.meta.url)));

test("typed specimen facts retain source references and distinct identifiers", () => {
  const projection = projectProcurementFacts(fixture.object, fixture.observations);
  const byKind = Object.fromEntries(projection.entries.map((entry) => [entry.kind, entry]));
  assert.equal(byKind.contract_start.value, "2023-10-11");
  assert.equal(byKind.contract_start.source_observation_ref, "passport_public_contracts:contract:07124E0044001:5050251");
  assert.equal(byKind.contract_end.value, "2026-06-30");
  assert.equal(byKind.registration_date.value, "2024-08-28");
  assert.equal(byKind.notice_publication_date.value, "2024-09-05");
  assert.equal(byKind.canonical_contract_id.value, "CT107120258801626");
  assert.equal(byKind.passport_contract_number.value, "CT1-071-20258801626");
  assert.equal(byKind.pin_epin.value, "07124E0044001");
});

test("notice dates cannot become contract periods and invalid dates are withheld", () => {
  const projection = projectProcurementFacts({ identity_keys: {} }, [{
    source_system: "city_record",
    source_observation_ref: "city_record:award-only",
    snapshot: { start_date: "2024-09-05", type_of_notice_description: "Award" },
  }]);
  assert.equal(projection.facts.contract_start, null);
  assert.equal(projection.facts.noticePublicationDate, "2024-09-05");
  assert.equal(normalizeProcurementDate("02/29/2023"), null);
  assert.equal(normalizeProcurementDate("2024-02-29"), "2024-02-29");
});

test("conflicting valid contract starts are retained with deterministic choice", () => {
  const object = { identity_keys: {} };
  const observations = [
    { source_system: "checkbook_contracts", source_observation_ref: "checkbook_contracts:z", snapshot: { start_date: "2024-01-01" } },
    { source_system: "passport_public_contracts", source_observation_ref: "passport_public_contracts:a", snapshot: { start_date: "2023-01-01" } },
  ];
  const projection = projectProcurementFacts(object, observations);
  assert.equal(projection.facts.contract_start, "2023-01-01");
  assert.equal(projection.conflicts.contract_start.candidates.length, 2);
});
