#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CAPABILITY_REGISTRY } from "../capabilities/registry.mjs";
import {
  NOTICE_SEARCH_CAPABILITY_REFERENCE,
  NOTICE_SEARCH_LIMITS,
  executeNoticeSearch,
  noticeSearchAvailability,
} from "../capabilities/notice_search.mjs";
import {
  ENTITY_DOSSIER_CAPABILITY_REFERENCE,
  executeEntityDossier,
} from "../capabilities/entity_dossier.mjs";
import {
  ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE,
  executeEntityRelationships,
} from "../capabilities/entity_relationships.mjs";
import {
  CITED_PASSAGES_CAPABILITY_REFERENCE,
  CITED_PASSAGES_LIMITS,
  executeCitedPassages,
} from "../capabilities/cited_passages.mjs";
import { workerD1NoticeSearch } from "../worker/src/lib/notices.mjs";
import { workerD1EntityDossier } from "../worker/src/entity_dossier.mjs";
import { workerD1EntityRelationships } from "../worker/src/public_relationship_graph.mjs";
import { workerCitedPassages } from "../worker/src/cited_retrieval.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURE = join(ROOT, "test/fixtures/capability_semantic_scout.json");
const DEFAULT_OUT = join(ROOT, "artifacts/capability-spine/cs-05-semantic-scout.json");
const NOTICE_SCHEMA = readFileSync(join(ROOT, "worker/migrations/0001_notices.sql"), "utf8");
const NOTICE_FACTS_SCHEMA = readFileSync(join(ROOT, "worker/migrations/0010_notice_facts.sql"), "utf8");
const NOTICE_FTS_SCHEMA = readFileSync(join(ROOT, "worker/migrations/0016_notice_fts.sql"), "utf8");
const REQUIRED_REFERENCES = Object.freeze([
  NOTICE_SEARCH_CAPABILITY_REFERENCE,
  ENTITY_DOSSIER_CAPABILITY_REFERENCE,
  ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE,
  CITED_PASSAGES_CAPABILITY_REFERENCE,
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value, { pretty = false } = {}) {
  return JSON.stringify(canonicalize(value), null, pretty ? 2 : 0);
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function publicBoundary(value, forbiddenKeys, forbiddenValues = []) {
  const forbidden = new Set(forbiddenKeys);
  const paths = [];
  function visit(child, path) {
    if (!child || typeof child !== "object") return;
    for (const [key, nested] of Object.entries(child)) {
      const next = path ? `${path}.${key}` : key;
      if (forbidden.has(key)) paths.push(next);
      visit(nested, next);
    }
  }
  visit(value, "");
  const serialized = canonicalJson(value);
  for (const expression of forbiddenValues) {
    if (expression.test(serialized)) paths.push(`value:${expression.source}`);
  }
  return { passed: paths.length === 0, forbidden_paths: paths.sort() };
}

function semanticOutputDigest(result, volatilePaths = []) {
  const clone = structuredClone(result);
  for (const path of volatilePaths) {
    const parts = path.split(".");
    let cursor = clone;
    for (let index = 0; index < parts.length - 1; index += 1) cursor = cursor?.[parts[index]];
    if (cursor && typeof cursor === "object") delete cursor[parts.at(-1)];
  }
  return sha256Canonical(clone);
}

function sourceIdentity(source) {
  return `${source?.system || "unknown"}:${source?.id || "unknown"}`;
}

function projectNoticeSearch(result, input) {
  return {
    capability_reference: NOTICE_SEARCH_CAPABILITY_REFERENCE,
    availability: noticeSearchAvailability(result),
    identity: {
      request_ids: result.results.map(({ request_id: id }) => id),
    },
    counts: {
      total_matches: result.total_matches,
      result_count: result.retrieval.result_count,
    },
    provenance: result.results.map((record) => ({
      request_id: record.request_id,
      match_provenance: record.match_provenance,
    })),
    evidence: {
      terms_used: result.terms_used,
      retrieval_method: result.retrieval.method,
      fallback_reason: result.retrieval.fallback_reason,
      rows_read: result.retrieval.rows_read,
    },
    bounds: {
      requested_limit: input.limit,
      maximum_limit: NOTICE_SEARCH_LIMITS.maximum,
      returned: result.results.length,
    },
    freshness: {
      publication_dates: [...new Set(result.results.map(({ date }) => date).filter(Boolean))].sort(),
    },
    public_redaction: publicBoundary(result, ["_haystack", "raw"]),
    semantic_output_sha256: semanticOutputDigest(result, ["retrieval.duration_ms"]),
  };
}

function projectEntityDossier(result, input) {
  const dossier = result.dossier;
  const assertions = dossier?.assertions || [];
  return {
    capability_reference: result.capability_reference,
    availability: result.availability,
    identity: {
      requested_entity_id: input.entityId,
      entity: dossier?.entity || null,
    },
    counts: {
      linked_records: dossier?.linked_records?.length || 0,
      assertion_groups: assertions.length,
      assertions: assertions.reduce((total, group) => total + group.assertions.length, 0),
      derived_assertions: dossier?.derived_assertions?.length || 0,
    },
    provenance: {
      linked_sources: (dossier?.linked_records || []).map((record) => sourceIdentity(record.source)).sort(),
      assertion_sources: assertions.flatMap((group) => (
        group.assertions.map((assertion) => sourceIdentity(assertion.provenance?.source))
      )).sort(),
    },
    evidence: {
      assertion_statuses: assertions.map(({ fact, status }) => ({ fact, status })),
      disagreement_facts: assertions.filter(({ status }) => status === "disagreement").map(({ fact }) => fact),
      missingness: dossier?.missingness || null,
    },
    bounds: {
      record_limit: dossier?.scope?.record_limit || null,
      truncated: dossier?.scope?.truncated ?? null,
      returned: dossier?.linked_records?.length || 0,
    },
    freshness: {
      observed_from: dossier?.scope?.observed_from || null,
      observed_through: dossier?.scope?.observed_through || null,
    },
    public_redaction: publicBoundary(
      result,
      [
        "raw_snapshot", "normalized_snapshot", "content_hash", "source_record_id",
        "link_confidence_score", "matcher_version", "evidence_json", "resolution_run_id",
        "review_status",
      ],
      [/private-(?:reviewer|evidence)-marker/i, /0\.(?:84|98)/],
    ),
    semantic_output_sha256: semanticOutputDigest(result),
  };
}

function projectEntityRelationships(result, input) {
  const graph = result.graph;
  const edges = graph?.edges || [];
  return {
    capability_reference: result.capability_reference,
    availability: result.availability,
    identity: {
      requested_entity_id: input.entityId,
      root: graph?.root || null,
      node_ids: (graph?.nodes || []).map(({ id }) => id),
      edge_ids: edges.map(({ id }) => id),
    },
    counts: {
      nodes: graph?.nodes?.length || 0,
      edges: edges.length,
    },
    provenance: edges.map((edge) => ({
      edge_id: edge.id,
      source: sourceIdentity(edge.provenance?.source),
      source_fields: edge.provenance?.source_fields || [],
      observed_at: edge.provenance?.observed_at || null,
    })),
    evidence: {
      edge_types: edges.map(({ type }) => type),
      confidence: edges.map(({ id, confidence }) => ({ id, ...confidence })),
    },
    bounds: graph?.bounds || null,
    freshness: {
      observed_at: [...new Set(edges.map((edge) => edge.provenance?.observed_at).filter(Boolean))].sort(),
    },
    public_redaction: publicBoundary(
      result,
      [
        "raw_snapshot", "normalized_snapshot", "content_hash", "source_record_id",
        "link_confidence_score", "confidence_score", "score", "probability", "matcher_version",
        "evidence_json", "resolution_run_id", "review_status", "attrs_json",
      ],
      [/private-(?:reviewer|evidence)-marker/i],
    ),
    semantic_output_sha256: semanticOutputDigest(result),
  };
}

function projectCitedPassages(result, input) {
  return {
    capability_reference: CITED_PASSAGES_CAPABILITY_REFERENCE,
    availability: result.coverage.state,
    identity: {
      citation_ids: result.citations.map(({ citation_id: id }) => id),
    },
    counts: {
      citations: result.citations.length,
    },
    provenance: {
      corpus: result.retrieval.corpus,
      index: result.retrieval.index,
      citations: result.citations.map((citation) => ({
        citation_id: citation.citation_id,
        source_id: citation.source.id,
        source_url: citation.source.url,
        passage_id: citation.passage.id,
      })),
    },
    evidence: {
      exact_joins: result.citations.map(({ citation_id, exact_join_evidence }) => ({
        citation_id,
        ...exact_join_evidence,
      })),
      passage_text_sha256: result.citations.map((citation) => ({
        citation_id: citation.citation_id,
        sha256: createHash("sha256").update(citation.passage.text || "").digest("hex"),
      })),
      hard_scope: result.hard_scope,
    },
    bounds: {
      requested_limit: input.limit ?? CITED_PASSAGES_LIMITS.defaultResults,
      maximum_limit: CITED_PASSAGES_LIMITS.maximumResults,
      returned: result.citations.length,
    },
    freshness: result.citations.map(({ citation_id, freshness }) => ({ citation_id, ...freshness })),
    public_redaction: publicBoundary(
      result,
      ["answer", "synthesis", "action", "legal_conclusion", "graph_edge", "relationship", "score", "cosine", "confidence"],
    ),
    semantic_output_sha256: semanticOutputDigest(result),
  };
}

function createNoticeDatabase(rows) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(NOTICE_SCHEMA);
  sqlite.exec(NOTICE_FACTS_SCHEMA);
  sqlite.exec(NOTICE_FTS_SCHEMA);
  const insert = sqlite.prepare(`INSERT INTO notices
    (request_id, section, agency, type_of_notice, category, short_title, vendor_name,
     description, contract_amount, contract_amount_valid, start_date, due_date, haystack,
     document_urls, n_documents, structured_facts, raw, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, '{}', ?, ?)`);
  for (const row of rows) {
    insert.run(
      row.request_id,
      row.section,
      row.agency,
      row.type_of_notice,
      row.category,
      row.short_title,
      row.vendor_name,
      row.description,
      row.contract_amount,
      row.contract_amount_valid,
      row.start_date,
      row.due_date,
      row.haystack,
      JSON.stringify(row.raw || {}),
      row.ingested_at,
    );
  }
  const DB = {
    prepare(sql) {
      if (/FROM notice_attachments/.test(sql)) {
        return { bind() { return this; }, async all() { return { results: [] }; } };
      }
      const prepared = sqlite.prepare(sql);
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async all() {
          const results = prepared.all(...args);
          return { results, meta: { rows_read: results.length } };
        },
        async first() { return prepared.get(...args) ?? null; },
      };
      return statement;
    },
  };
  return { sqlite, DB };
}

function fixtureEntityDatabase(rows) {
  const normalized = rows.map((row) => ({
    ...row,
    raw_snapshot: JSON.stringify(row.raw_snapshot || {}),
  }));
  return {
    prepare() {
      return {
        bind() {
          return { async all() { return { results: structuredClone(normalized) }; } };
        },
      };
    },
  };
}

function registryProjection() {
  return CAPABILITY_REGISTRY.map((capability) => ({
    reference: capability.reference,
    provider_id: capability.provider.id,
    input_schema: capability.input.schema,
    output_schema: capability.output.schema,
    availability: capability.output.availability,
    bounds: capability.input.limits || null,
    freshness: capability.freshness,
  }));
}

export function receiptSemanticPayload(receipt, field = "actual_projection") {
  return {
    fixture_id: receipt.fixture.id,
    registry: receipt.registry,
    projections: receipt.checks.map((check) => ({
      capability_reference: check.capability_reference,
      projection: check[field],
    })),
  };
}

async function executeFixtureCases(fixture) {
  const notice = fixture.cases.notice_search;
  const noticeDb = createNoticeDatabase(notice.source_rows);
  let noticeResult;
  try {
    noticeResult = await executeNoticeSearch(workerD1NoticeSearch(noticeDb.DB), notice.input);
  } finally {
    noticeDb.sqlite.close();
  }

  const dossier = fixture.cases.entity_dossier;
  const dossierResult = await executeEntityDossier(
    workerD1EntityDossier(fixtureEntityDatabase(dossier.source_rows)),
    dossier.input,
  );

  const relationships = fixture.cases.entity_relationships;
  const relationshipsResult = await executeEntityRelationships(
    workerD1EntityRelationships(fixtureEntityDatabase(relationships.source_rows)),
    relationships.input,
  );

  const cited = fixture.cases.cited_passages;
  const citedResult = await executeCitedPassages(workerCitedPassages(), cited.input);

  return [
    [notice, projectNoticeSearch(noticeResult, notice.input)],
    [dossier, projectEntityDossier(dossierResult, dossier.input)],
    [relationships, projectEntityRelationships(relationshipsResult, relationships.input)],
    [cited, projectCitedPassages(citedResult, cited.input)],
  ];
}

export async function buildCapabilitySemanticScoutReceipt(fixture, options = {}) {
  if (fixture?.schema !== "cityscroll.capability_semantic_scout_fixture.v1") {
    throw new TypeError("semantic scout fixture schema is invalid");
  }
  const fixtureReferences = Object.values(fixture.cases || {}).map(({ capability_reference: ref }) => ref);
  if (canonicalJson(fixtureReferences) !== canonicalJson(REQUIRED_REFERENCES)) {
    throw new TypeError("semantic scout fixture must contain the four registered capabilities in order");
  }
  const cases = await executeFixtureCases(fixture);
  const receipt = {
    schema: "cityscroll.capability_semantic_scout_receipt.v1",
    generated_at: options.generatedAt || fixture.generated_at,
    fixture: {
      id: fixture.id,
      schema: fixture.schema,
      sha256: options.fixtureSha256 || sha256Canonical(fixture),
    },
    registry: registryProjection(),
    runtime_boundary: {
      network_calls: 0,
      model_calls: 0,
      browser_actions: 0,
      production_writes: 0,
      cloudflare_os_required: false,
      transport_imports: 0,
    },
    checks: cases.map(([fixtureCase, actual]) => {
      const expected = fixtureCase.expected_projection;
      const staticSha = sha256Canonical(expected);
      const workerSha = sha256Canonical(actual);
      return {
        id: fixtureCase.id,
        capability_reference: fixtureCase.capability_reference,
        provider_id: CAPABILITY_REGISTRY.find(({ reference }) => reference === fixtureCase.capability_reference)?.provider.id,
        input: fixtureCase.input,
        expected_projection: expected,
        actual_projection: actual,
        provider_parity: {
          static_projection_sha256: staticSha,
          worker_projection_sha256: workerSha,
          status: staticSha === workerSha ? "pass" : "fail",
        },
      };
    }),
  };
  receipt.expected_semantic_sha256 = sha256Canonical(receiptSemanticPayload(receipt, "expected_projection"));
  receipt.actual_semantic_sha256 = sha256Canonical(receiptSemanticPayload(receipt, "actual_projection"));
  receipt.status = receipt.expected_semantic_sha256 === receipt.actual_semantic_sha256
    && receipt.checks.every(({ provider_parity: parity }) => parity.status === "pass")
    ? "pass"
    : "fail";
  return receipt;
}

export function serializeReceipt(receipt) {
  return `${canonicalJson(receipt, { pretty: true })}\n`;
}

function parseArgs(argv) {
  const args = { fixture: DEFAULT_FIXTURE, out: DEFAULT_OUT, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixture" || arg === "--out") {
      const value = argv[index + 1];
      if (!value) throw new TypeError(`${arg} requires a path`);
      args[arg.slice(2)] = resolve(value);
      index += 1;
    } else if (arg === "--check") {
      args.check = true;
    } else {
      throw new TypeError(`unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function runCapabilitySemanticScout({ fixture: fixturePath, out, check = false }) {
  const fixtureText = readFileSync(fixturePath, "utf8");
  const fixture = JSON.parse(fixtureText);
  const receipt = await buildCapabilitySemanticScoutReceipt(fixture, {
    fixtureSha256: createHash("sha256").update(fixtureText).digest("hex"),
  });
  const serialized = serializeReceipt(receipt);
  if (check) {
    if (!existsSync(out) || readFileSync(out, "utf8") !== serialized) {
      throw new Error(`${out} is stale; rerun the semantic scout`);
    }
    process.stdout.write(`capability semantic scout receipt is current: ${out}\n`);
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, serialized, "utf8");
    process.stdout.write(`wrote capability semantic scout receipt: ${out}\n`);
  }
  return receipt;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await runCapabilitySemanticScout(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
