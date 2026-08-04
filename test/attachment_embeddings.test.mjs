import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  ATTACHMENT_RELATED_SCHEMA,
  EMBED_METHOD_HASHED,
  buildRelatedArtifact,
  cosineSimilarity,
  embedDocument,
  keywordFindsTarget,
  nearestNeighbors,
  publicRelatedPayload,
  relatedForNotice,
} from "../warehouse/lib/attachment_embeddings.mjs";
import { attachmentRelatedHTML } from "../site/attachment_related.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const corpus = JSON.parse(
  readFileSync(new URL("../warehouse/fixtures/attachment_embeddings_corpus.json", import.meta.url), "utf8"),
);
const artifact = JSON.parse(
  readFileSync(new URL("../site/data/attachment_related_notices.json", import.meta.url), "utf8"),
);
const adr = readFileSync(new URL("../docs/adr/attachment-text-embeddings.md", import.meta.url), "utf8");
const demo = JSON.parse(readFileSync(new URL("../site/demo/demo-links.json", import.meta.url), "utf8"));
const receipt = JSON.parse(
  readFileSync(new URL("../warehouse/receipts/proof/att_t3_attachment_embeddings_latest.json", import.meta.url), "utf8"),
);

test("T3 decision record chooses precomputed edges over query-time index", () => {
  assert.match(adr, /precomputed similar-document edges only/i);
  assert.match(adr, /Ship \(b\)/);
  assert.match(adr, /Threshold for revisiting \(a\)/);
  assert.match(adr, /live model API/i);
  assert.match(adr, /query embedding/i);
  assert.match(adr, /no-live-dependency/i);
});

test("T3 hashed embedder is local, deterministic, and L2-normalized", () => {
  const a = embedDocument("hardwood sawtimber shelterwood watershed basin");
  const b = embedDocument("hardwood sawtimber shelterwood watershed basin");
  assert.equal(a.length, 256);
  assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-9);
  const c = embedDocument("cloud migration cybersecurity help desk");
  assert.ok(cosineSimilarity(a, c) < 0.35);
});

test("T3 golden: Cannonsville relates to water-supply forest notices keyword search misses", () => {
  const docs = corpus.documents;
  const nn = nearestNeighbors(docs);
  const related = nn.by_notice["20240515016"] || [];
  const relatedIds = related.map((r) => r.request_id);
  for (const id of corpus.golden.must_relate_ids) {
    assert.ok(relatedIds.includes(id), `expected related edge to ${id}, got ${relatedIds.join(",")}`);
    const target = docs.find((d) => d.id === id);
    assert.equal(
      keywordFindsTarget(corpus.golden.keyword_query, `${target.title}\n${target.text}`),
      false,
      `keyword ${corpus.golden.keyword_query} should miss ${id}`,
    );
  }
  for (const id of corpus.golden.must_not_rank_above_related) {
    const relScore = Math.min(
      ...corpus.golden.must_relate_ids.map((rid) => related.find((r) => r.request_id === rid)?.score ?? 1),
    );
    const dScore = related.find((r) => r.request_id === id)?.score ?? -1;
    assert.ok(dScore < relScore, `distractor ${id} must not outrank related (d=${dScore} rel=${relScore})`);
  }
});

test("T3 materialization is precomputed_related_edges with golden_pass", () => {
  assert.equal(artifact.schema, ATTACHMENT_RELATED_SCHEMA);
  assert.equal(artifact.architecture, "precomputed_related_edges");
  assert.equal(artifact.method, EMBED_METHOD_HASHED);
  assert.equal(artifact.golden?.golden_pass, true);
  assert.equal(artifact.query_time_embedding, undefined);
  const cannonsville = relatedForNotice(artifact, "20240515016");
  assert.ok(cannonsville.length >= 2);
  assert.ok(cannonsville.every((r) => r.basis === "attachment_text_similarity"));
  assert.match(cannonsville[0].title, /Ashokan|timber|forest|reservoir/i);
  const payload = publicRelatedPayload(artifact, "20240515016");
  assert.equal(payload.request_id, "20240515016");
  assert.ok(payload.related.length >= 2);
});

test("T3 UI helpers render related panel and site wires fillContext", () => {
  const html = attachmentRelatedHTML(artifact, "20240515016", {
    t: (k) => ({
      notice_attachment_related_heading: "Related by attachment content",
      notice_attachment_related_lead: "Other notices that share themes.",
    }[k] || k),
  });
  assert.match(html, /attachment-related/);
  assert.match(html, /data-attachment-related/);
  assert.match(html, /#notice\/20230612007/);
  assert.match(html, /Ashokan/);
  assert.match(SITE_SOURCE, /attachmentRelatedHTMLFor/);
  assert.match(SITE_SOURCE, /attachment_related\.mjs/);
  const indexCss = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  assert.match(indexCss, /\.attachment-related\b/);
  const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
  assert.match(i18n, /notice_attachment_related_heading/);
  assert.match(i18n, /notice_attachment_related_lead/);
});

test("T3 demo contract expects related-by-attachment panel on Cannonsville", () => {
  const entry = demo.entries.find((item) => item.id === "notice-cannonsville-attachment");
  assert.ok(entry);
  const related = entry.expectations.visible.find((item) => item.selector?.includes("attachment-related"));
  assert.ok(related, "demo should expect attachment-related panel");
  assert.match(related.text || related.selector, /Related by attachment|attachment-related|Ashokan|Pepacton/i);
});

test("T3 build --check is green and receipt is committed", () => {
  assert.ok(existsSync(new URL("../worker/src/data/attachment_related_notices.json", import.meta.url)));
  assert.equal(receipt.tier, "t3_embeddings");
  assert.equal(receipt.paid_api, false);
  assert.equal(receipt.query_time_embedding, false);
  assert.equal(receipt.golden_pass, true);
  const check = spawnSync("node", ["tools/build_attachment_related.mjs", "--check"], {
    encoding: "utf8",
    cwd: new URL("..", import.meta.url).pathname,
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});

test("T3 artifact builder stamps edge rate metric", () => {
  const nn = nearestNeighbors(corpus.documents);
  const built = buildRelatedArtifact(nn, { sourceCount: 1, targetCount: corpus.documents.length });
  assert.equal(built.notices_with_edges, 1);
  assert.equal(built.attachment_related_edge_rate, 1);
});
