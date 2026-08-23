import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { contractSearchDocumentToMoneyRow } from "../site/contract_search_bridge.mjs";
import {
  isCrolNegativeProcurement,
  matchProcurementDigestRows,
} from "../site/procurement_digest_compile.mjs";
import {
  procurementContractWatchHref,
  procurementVendorFollowHref,
  renderProcurementDocument,
} from "../site/procurement_document.mjs";
import { countOpenMatches } from "../site/following_suggestions.mjs";
import { watchFromFollowingParams } from "../site/following_view.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { procurementLifecycleForObject } from "../worker/src/checkbook_lifecycle.mjs";
import { compileSub, useProcurementDigestSnapshot } from "../worker/src/lib/compile.mjs";
import { sanitize } from "../worker/src/lib/filter.mjs";

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

test("Watch this contract creates a money watch that compiles the CROL-negative object", () => {
  const object = model.rows.find((row) => row.procurement_id === "procurement:contract:CT101520271400806");
  assert.equal(isCrolNegativeProcurement(object), true);
  const html = renderProcurementDocument(object, model.observations);
  assert.match(html, /data-procurement-watch="procurement:contract:CT101520271400806"/);
  assert.match(html, />Watch this contract</);
  assert.match(html, />Follow this vendor</);
  assert.doesNotMatch(html, /City Record notice/);
  const href = procurementContractWatchHref(object.procurement_id);
  const watch = watchFromFollowingParams(new URL(href, "https://cityscroll.org").searchParams);
  assert.equal(watch.lens, "money");
  assert.equal(watch.filter.procurement_id, object.procurement_id);
  assert.equal(watch.filter.noticeType, "award");
  const sanitized = sanitize("money", watch.filter);
  assert.equal(sanitized.procurement_id, object.procurement_id);
  const restore = useProcurementDigestSnapshot(model);
  try {
    const query = compileSub({ lens: "money", filter: sanitized }, "2026-08-18");
    const rows = query.readRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].procurement_id, object.procurement_id);
    assert.equal(Object.hasOwn(rows[0], "request_id"), false);
    assert.match(rows[0].canonical_href, /^\/procurements\//);
  } finally {
    restore();
  }
  const vendorHref = procurementVendorFollowHref("BILLIG LAW PC");
  assert.match(vendorHref, /lens=entity/);
  const vendorWatch = watchFromFollowingParams(new URL(vendorHref, "https://cityscroll.org").searchParams);
  assert.equal(vendorWatch.lens, "entity");
  assert.equal(vendorWatch.filter.kind, "vendor");
  assert.equal(vendorWatch.filter.name, "BILLIG LAW PC");
});

test("CROL-negative snapshot matches compile without a City Record request_id", () => {
  const rows = matchProcurementDigestRows(model, {
    noticeType: "award",
    agency: "Office of the Comptroller",
  }, { lens: "money" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].procurement_id, "procurement:contract:CT101520271400806");
  assert.equal(rows[0].request_id, undefined);
  assert.doesNotMatch(JSON.stringify(rows[0]), /20260623008/);
  const cityRecordBacked = matchProcurementDigestRows(model, {
    noticeType: "award",
    agency: "Department of Transportation",
  }, { lens: "money" });
  assert.equal(cityRecordBacked.length, 0);
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
