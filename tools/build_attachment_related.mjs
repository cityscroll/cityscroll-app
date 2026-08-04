#!/usr/bin/env node
/**
 * Materialize T3 attachment-content related-notice edges (precompute-first).
 *
 * Usage:
 *   node tools/build_attachment_related.mjs              # fixture corpus
 *   node tools/build_attachment_related.mjs --from-fixture
 *   node tools/build_attachment_related.mjs --check
 *   node tools/build_attachment_related.mjs --inventory path/to/attachments_with_text.jsonl
 *
 * Default embedder is pure JS (hashed n-gram TF-IDF). Optional:
 *   --method sentence-transformers  (requires warehouse/.venv + sentence-transformers;
 *                                    falls back with a clear error rather than silent skip)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  ATTACHMENT_RELATED_SCHEMA,
  EMBED_METHOD_HASHED,
  buildRelatedArtifact,
  keywordFindsTarget,
  nearestNeighbors,
} from "../warehouse/lib/attachment_embeddings.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = resolve(ROOT, "warehouse/fixtures/attachment_embeddings_corpus.json");
const LOOKUP = resolve(ROOT, "site/data/attachment_metadata_lookup.json");
const OUT_SITE = resolve(ROOT, "site/data/attachment_related_notices.json");
const OUT_WORKER = resolve(ROOT, "worker/src/data/attachment_related_notices.json");
const OUT_RECEIPT = resolve(ROOT, "warehouse/receipts/proof/att_t3_attachment_embeddings_latest.json");

function parseArgs(argv) {
  const out = {
    fixture: true,
    check: false,
    inventory: null,
    method: EMBED_METHOD_HASHED,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from-fixture" || arg === "--fixture") out.fixture = true;
    else if (arg === "--check") out.check = true;
    else if (arg === "--inventory") {
      out.inventory = resolve(argv[++i]);
      out.fixture = false;
    }
    else if (arg === "--method") out.method = String(argv[++i] || "");
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function loadFixtureDocs() {
  const corpus = JSON.parse(readFileSync(FIXTURE, "utf8"));
  // Fixture corpus is the sole source for offline golden rebuilds (keeps CI
  // independent of T1 product extract wording).
  const docs = (corpus.documents || []).map((d) => ({
    id: d.id,
    text: d.text,
    title: d.title,
    section: d.section,
    role: d.role || "both",
  }));
  return { docs, golden: corpus.golden || null };
}

function loadInventoryDocs(path) {
  const raw = readFileSync(path, "utf8");
  const byNotice = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const id = String(row.request_id || "");
    const text = String(row.extracted_text || "").trim();
    if (!id || !text) continue;
    if (!byNotice.has(id)) {
      byNotice.set(id, {
        id,
        texts: [],
        title: row.notice_title || row.title || null,
        section: row.section_name || row.section || null,
        role: "source",
      });
    }
    byNotice.get(id).texts.push(text);
  }
  const docs = [...byNotice.values()].map((d) => ({
    id: d.id,
    text: d.texts.join("\n\n"),
    title: d.title,
    section: d.section,
    role: "source",
  }));
  return { docs, golden: null };
}

function evaluateGolden(artifact, docs, golden) {
  if (!golden?.source_id) return null;
  const related = artifact.by_notice?.[golden.source_id]?.related || [];
  const relatedIds = new Set(related.map((r) => r.request_id));
  const docById = new Map(docs.map((d) => [d.id, d]));
  const source = docById.get(golden.source_id);
  const keywordQuery = golden.keyword_query || ["cannonsville"];

  const mustRelate = golden.must_relate_ids || [];
  const hits = mustRelate.filter((id) => relatedIds.has(id));
  const misses = mustRelate.filter((id) => !relatedIds.has(id));

  const keywordOnlyMisses = mustRelate.filter((id) => {
    const target = docById.get(id);
    if (!target) return false;
    // Keyword search for the distinctive source token does not find the target.
    return !keywordFindsTarget(keywordQuery, `${target.title || ""}\n${target.text || ""}`);
  });

  // Top related scores should beat known distractors when both appear.
  const mustNotAbove = golden.must_not_rank_above_related || [];
  const scoreOf = (id) => related.find((r) => r.request_id === id)?.score ?? -1;
  const minRelatedScore = mustRelate.length
    ? Math.min(...mustRelate.map((id) => scoreOf(id)))
    : 0;
  const distractorAbove = mustNotAbove.filter((id) => scoreOf(id) >= minRelatedScore && scoreOf(id) >= 0);

  const comparison = {
    source_id: golden.source_id,
    keyword_query: keywordQuery,
    related_ids: related.map((r) => r.request_id),
    must_relate_ids: mustRelate,
    embedding_hits: hits,
    embedding_misses: misses,
    keyword_misses_among_must_relate: keywordOnlyMisses,
    distractors_ranked_above_related: distractorAbove,
    // Success: every must-relate is an embedding hit AND a keyword miss;
    // known distractors do not outrank the weakest must-relate hit.
    golden_pass:
      misses.length === 0
      && keywordOnlyMisses.length === mustRelate.length
      && mustRelate.length > 0
      && distractorAbove.length === 0,
    source_preview: (source?.text || "").slice(0, 160),
  };
  return comparison;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function stripBuiltAt(doc) {
  const { built_at, ...rest } = doc;
  return rest;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: build_attachment_related.mjs [--from-fixture|--inventory FILE] [--check] [--method hashed_ngram_tfidf_v0]");
    process.exit(0);
  }

  if (args.method && args.method !== EMBED_METHOD_HASHED && args.method !== "sentence-transformers") {
    throw new Error(`unsupported --method ${args.method}`);
  }
  if (args.method === "sentence-transformers") {
    // Optional path — intentionally not the CI default. Fail closed if requested.
    const py = existsSync(resolve(ROOT, "warehouse/.venv/bin/python"))
      ? resolve(ROOT, "warehouse/.venv/bin/python")
      : "python3";
    const helper = resolve(ROOT, "warehouse/lib/attachment_embed_st.py");
    if (!existsSync(helper)) {
      console.error("sentence-transformers helper missing; use default hashed method");
      process.exit(2);
    }
    const result = spawnSync(py, [helper, "--help"], { encoding: "utf8" });
    if (result.status !== 0) {
      console.error("sentence-transformers path unavailable:", result.stderr || result.stdout);
      process.exit(2);
    }
    console.error("sentence-transformers full re-embed is optional; this build uses hashed_ngram_tfidf_v0 for CI safety.");
  }

  const { docs, golden } = args.inventory
    ? loadInventoryDocs(args.inventory)
    : loadFixtureDocs();

  const sources = docs.filter((d) => d.role === "source" || d.role === "both");
  const nn = nearestNeighbors(docs, {});
  const goldenEval = evaluateGolden(
    { by_notice: Object.fromEntries(
      Object.entries(nn.by_notice).map(([id, related]) => [id, { related }]),
    ) },
    docs,
    golden,
  );

  const artifact = buildRelatedArtifact(nn, {
    builtAt: new Date().toISOString(),
    sourceCount: sources.length,
    targetCount: docs.length,
    golden: goldenEval,
  });

  if (args.check) {
    if (!existsSync(OUT_SITE) || !existsSync(OUT_WORKER)) {
      console.error("attachment related lookup missing — run without --check");
      process.exit(1);
    }
    const site = JSON.parse(readFileSync(OUT_SITE, "utf8"));
    const worker = JSON.parse(readFileSync(OUT_WORKER, "utf8"));
    if (JSON.stringify(stripBuiltAt(site)) !== JSON.stringify(stripBuiltAt(worker))) {
      console.error("attachment related site/worker drift — rebuild");
      process.exit(1);
    }
    if (site.schema !== ATTACHMENT_RELATED_SCHEMA) {
      console.error("unexpected schema", site.schema);
      process.exit(1);
    }
    if (site.architecture !== "precomputed_related_edges") {
      console.error("architecture must be precomputed_related_edges");
      process.exit(1);
    }
    // Golden must stay green on committed fixture artifact.
    if (site.golden && site.golden.golden_pass !== true) {
      console.error("golden case failed on committed artifact", site.golden);
      process.exit(1);
    }
    const cannonsville = site.by_notice?.["20240515016"]?.related || [];
    if (!cannonsville.length) {
      console.error("Cannonsville must have related edges");
      process.exit(1);
    }
    console.log(
      `attachment related ok: sources=${site.source_count} edges=${site.edge_count} edge_rate=${site.attachment_related_edge_rate} method=${site.method}`,
    );
    return;
  }

  if (goldenEval && !goldenEval.golden_pass) {
    console.error("golden case failed — refusing to write artifact", JSON.stringify(goldenEval, null, 2));
    process.exit(1);
  }

  writeJson(OUT_SITE, artifact);
  writeJson(OUT_WORKER, artifact);

  const receipt = {
    schema: "cityscroll.attachment_embeddings.receipt.v1",
    tier: "t3_embeddings",
    architecture: "precomputed_related_edges",
    method: artifact.method,
    dim: artifact.dim,
    started_at: artifact.built_at,
    finished_at: artifact.built_at,
    mode: args.inventory ? "inventory" : "fixture",
    source_count: artifact.source_count,
    target_count: artifact.target_count,
    notices_with_edges: artifact.notices_with_edges,
    edge_count: artifact.edge_count,
    attachment_related_edge_rate: artifact.attachment_related_edge_rate,
    golden_pass: artifact.golden?.golden_pass ?? null,
    paid_api: false,
    query_time_embedding: false,
    binaries_stored: false,
  };
  writeJson(OUT_RECEIPT, receipt);

  console.log(
    `wrote ${OUT_SITE.replace(ROOT + "/", "")} and worker twin — sources=${artifact.source_count} edges=${artifact.edge_count} golden_pass=${artifact.golden?.golden_pass}`,
  );
}

main();
