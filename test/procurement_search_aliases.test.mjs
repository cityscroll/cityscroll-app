import assert from "node:assert/strict";
import test from "node:test";

import { readSharedProcurementReadModel } from "../tools/lib/procurement_read_model_io.mjs";
import { keywordTextMatches, resolveKeywordQuery } from "../site/keyword_matcher.mjs";
import {
  buildProcurementSearchDocuments,
  materializeProcurementSearchDocument,
} from "../site/procurement_search_producer.mjs";
import { DEFAULT_PROCUREMENT_SEARCH_ALIAS_REGISTRY } from "../site/procurement_search_aliases.mjs";

const MODEL = readSharedProcurementReadModel(new URL("../site/data/shared_procurement_read_model.json", import.meta.url));
const TARGET = "procurement:contract:CT107120258801626";
const NEARBY = "procurement:contract:CT107120238806236";

function targetDocument(registry = DEFAULT_PROCUREMENT_SEARCH_ALIAS_REGISTRY) {
  return buildProcurementSearchDocuments(MODEL, { aliasRegistry: registry }).documents
    .find((document) => document.object_ref === TARGET);
}

test("reviewed resident aliases find the exact canonical procurement", () => {
  const document = targetDocument();
  assert.ok(document);
  assert.equal(document.canonical_href, "/procurements/procurement%3Acontract%3ACT107120258801626");
  for (const query of ["3218 Emmons", "Gold Star Inn", "Comfort Inn Sheepshead Bay", "Sheepshead Bay shelter"]) {
    assert.equal(keywordTextMatches(document.search_text, resolveKeywordQuery(query)), true, query);
  }
});

test("aliases are additive search metadata and cannot replace canonical facts", () => {
  const row = MODEL.rows.find((candidate) => candidate.procurement_id === TARGET);
  const withoutAliases = materializeProcurementSearchDocument(row, MODEL, null, { aliasRegistry: { schema: "cityscroll.procurement_search_alias_registry.v1", aliases: [] } });
  const withAliases = targetDocument();
  assert.deepEqual(
    { ...withAliases, search_text: withoutAliases.search_text, provenance: { ...withAliases.provenance, search_aliases: undefined } },
    { ...withoutAliases, provenance: { ...withoutAliases.provenance, search_aliases: undefined } },
  );
  assert.deepEqual(withAliases.provenance.search_aliases.map(({ alias }) => alias), [
    "3218 Emmons Avenue", "Comfort Inn Sheepshead Bay", "Gold Star Inn", "Sheepshead Bay shelter",
  ]);
  assert.equal(withAliases.provenance.browse_record.vendor_name, withoutAliases.provenance.browse_record.vendor_name);
  assert.equal(withAliases.provenance.browse_record.contract_amount, withoutAliases.provenance.browse_record.contract_amount);
});

test("the distinct nearby address remains a distinct procurement", () => {
  const corpus = buildProcurementSearchDocuments(MODEL);
  const exact = corpus.documents.find((document) => document.object_ref === TARGET);
  const older = corpus.documents.find((document) => document.object_ref === NEARBY);
  assert.ok(exact);
  assert.ok(older);
  assert.equal(keywordTextMatches(exact.search_text, resolveKeywordQuery("3206 Emmons")), false);
  assert.equal(keywordTextMatches(older.search_text, resolveKeywordQuery("3206 Emmons")), true);
  assert.equal(keywordTextMatches(older.search_text, resolveKeywordQuery("3218 Emmons")), false);
});

test("an alias target must already be an admitted canonical object", () => {
  assert.throws(
    () => buildProcurementSearchDocuments(MODEL, {
      aliasRegistry: {
        schema: "cityscroll.procurement_search_alias_registry.v1",
        aliases: [{
          alias: "invented shelter",
          canonical_object_ref: "procurement:contract:not-admitted",
          provenance: { source: "test", basis: "test" },
        }],
      },
    }),
    /not an admitted canonical object/,
  );
});
