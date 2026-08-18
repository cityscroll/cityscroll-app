import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { contractSearchDocumentToMoneyRow } from "../site/contract_search_bridge.mjs";
import { countOpenMatches } from "../site/following_suggestions.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { procurementLifecycleForObject } from "../worker/src/checkbook_lifecycle.mjs";

const cohort = JSON.parse(readFileSync(
  new URL("./fixtures/procurement_search/golden_cohort.json", import.meta.url),
  "utf8",
));
const model = buildSharedProcurementReadModel({
  sourceRecords: cohort.source_records,
  generatedAt: cohort.generated_at,
});
const corpus = buildProcurementSearchDocuments(model);

test("Following counts a canonical CROL-negative procurement once across ordering", () => {
  const row = contractSearchDocumentToMoneyRow(corpus.documents.find((document) => (
    document.object_ref === "procurement:contract:CT101520271400806"
  )));
  const watch = {
    lens: "money",
    filter: { agency: "Office of the Comptroller", procurementStages: ["registered"] },
  };
  const first = countOpenMatches(watch, { money: [row, { ...row }] });
  const reordered = countOpenMatches(watch, { money: [{ ...row }, row].reverse() });
  assert.equal(first.count, 1);
  assert.equal(reordered.count, 1);
  assert.deepEqual([...first.ids], ["procurement:contract:CT101520271400806"]);
  assert.deepEqual([...reordered.ids], [...first.ids]);
});

test("lifecycle projects typed observed stages from procurement identity without request_id", () => {
  const object = model.rows.find((row) => row.procurement_id === "procurement:contract:CT101520271400806");
  const lifecycle = procurementLifecycleForObject(object, model.observations);
  assert.equal(lifecycle.procurement_id, object.procurement_id);
  assert.equal(Object.hasOwn(lifecycle, "request_id"), false);
  assert.deepEqual(lifecycle.timeline.map((entry) => entry.stage), ["registered"]);
  assert.equal(lifecycle.timeline[0].status, "matched");
  assert.match(lifecycle.timeline[0].source_observation_refs[0], /^checkbook_contracts:/);
});
