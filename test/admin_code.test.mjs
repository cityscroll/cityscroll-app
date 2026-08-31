import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ADMIN_CODE_MANIFEST,
  adminCodeSearchDocuments,
  lookupAdminCodeCitation,
  normalizeAdminCodeCitation,
  renderAdminCodeProvisionDocument,
  searchAdminCodeDocuments,
} from "../site/admin_code.mjs";
import pagesEdge, { edgeRequestKind } from "../site/pages_edge.mjs";
import { admitSearchDocument } from "../site/search_document_contract.mjs";

function rowFor(entry) {
  const shard = JSON.parse(readFileSync(new URL(`../site/data/legal_code/${entry.shard}`, import.meta.url)));
  return shard.rows.find((row) => row.id === entry.id);
}

test("Administrative Code citation normalization resolves the three launch canaries", () => {
  const cases = [
    ["§ 16-120", "16-120"],
    ["16-120", "16-120"],
    ["Admin Code 16-120", "16-120"],
    ["NYC Administrative Code § 20-912", "20-912"],
    ["section 28-103.22", "28-103.22"],
    ["28 103.22", "28-103.22"],
  ];
  for (const [input, citation] of cases) {
    assert.equal(normalizeAdminCodeCitation(input), citation, input);
    const resolved = lookupAdminCodeCitation(input);
    assert.deepEqual(resolved?.id, `nyc-administrative-code:${citation}`);
    assert.ok(resolved?.shard);
  }
});

test("the materialization retains corpus identity, hierarchy, source provenance, and current text", () => {
  assert.equal(ADMIN_CODE_MANIFEST.corpus.id, "nyc-administrative-code");
  assert.equal(ADMIN_CODE_MANIFEST.source.system, "american_legal_publishing");
  assert.equal(ADMIN_CODE_MANIFEST.source.asset_kind, "bulk_xml_zip");
  for (const citation of ["§ 16-120", "§ 20-912", "§ 28-103.22"]) {
    const row = rowFor(lookupAdminCodeCitation(citation));
    assert.equal(row.corpus_id, "nyc-administrative-code");
    assert.equal(row.level, "section");
    assert.ok(row.source.url.startsWith("https://codelibrary.amlegal.com/"));
    assert.match(row.source.content_hash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(row.hierarchy.length);
  }
  assert.match(rowFor(lookupAdminCodeCitation("16-120")).current_text, /receptacles/i);
  assert.equal(rowFor(lookupAdminCodeCitation("28-103.22")).status, "repealed");
});

test("legal-code search is bounded, typed, and admits exact citation documents", () => {
  assert.equal(adminCodeSearchDocuments().length, ADMIN_CODE_MANIFEST.counts.provisions);
  const exact = searchAdminCodeDocuments("16 120", { limit: 8 });
  assert.equal(exact[0].object_ref, "nyc-administrative-code:16-120");
  const admitted = admitSearchDocument(exact[0]);
  assert.equal(admitted.outcome, "indexed");
  assert.equal(admitted.document.object_type, "legal_code");
  assert.equal(admitted.document.domain, "legal");
  assert.ok(searchAdminCodeDocuments("receptacles", { limit: 3 }).length <= 3);
  assert.equal(searchAdminCodeDocuments("not-a-real-code-term").length, 0);
});

test("provision detail page is source-labeled and does not claim modeled history", () => {
  const row = rowFor(lookupAdminCodeCitation("20-912"));
  const html = renderAdminCodeProvisionDocument(row);
  assert.match(html, /<a class="skip" href="#main">Skip to content<\/a>/);
  assert.match(html, /<main id="main" tabindex="-1">/);
  assert.match(html, /main:focus\{outline:3px solid/);
  assert.match(html, /Administrative Code § 20-912/);
  assert.match(html, /Current text/);
  assert.match(html, /American Legal Publishing/);
  assert.match(html, /No modeled changes yet/);
});

test("provision detail renders the materialized current version and immutable history", () => {
  const row = rowFor(lookupAdminCodeCitation("20-912"));
  const html = renderAdminCodeProvisionDocument(row, {
    versions: [
      { id: "version-old", provision_id: row.id, valid_from: null, valid_to: "2026-11-01", text: "Old text.", status: "superseded" },
      { id: "version-new", provision_id: row.id, valid_from: "2026-11-01", valid_to: null, text: "New text.", status: "current" },
    ],
  });
  assert.match(html, /New text\./);
  assert.match(html, /Version history/);
  assert.match(html, /data-code-version-id="version-old"/);
  assert.match(html, /2026-11-01[\s\S]*current/);
});

test("Pages edge serves provision detail from a committed shard", async () => {
  const entry = lookupAdminCodeCitation("16-120");
  const shard = rowFor(entry);
  const response = await pagesEdge.fetch(
    new Request("https://cityscroll.org/administrative-code/16-120/"),
    {
      ASSETS: {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/data/agency_obligations_lookup.json") {
            return Response.json({ by_agency: {} });
          }
          assert.equal(path, `/data/legal_code/${entry.shard}`);
          return new Response(JSON.stringify({ rows: [shard] }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    },
  );
  assert.equal(edgeRequestKind("https://cityscroll.org/administrative-code/16-120/"), "legal-code");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Receptacles for the removal of waste material/);
});
