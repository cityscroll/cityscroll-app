export const RULES_SEMANTIC_LANE_SCHEMA = "cityscroll.rules_semantic_lane.v1";

const clean = (value) => String(value == null ? "" : value).trim();
const isoDay = (value) => clean(value).match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;

function processStage(value) {
  const status = clean(value).toLocaleLowerCase();
  if (status === "proposal" || status === "proposed") return "proposal";
  if (["public_process", "public process", "hearing", "comment-open", "comment_open"].includes(status)) return "public_process";
  if (status === "adopted" || status === "adoption") return "adoption";
  if (status === "effective") return "effective";
  return "unstaged";
}

function sourceRecordId(kind, id) {
  return `${clean(kind)}:${encodeURIComponent(clean(id))}`;
}

function candidateVocabulary(candidate) {
  return [
    candidate.query?.text,
    candidate.rule?.title,
    candidate.source_passage?.text,
  ].filter(Boolean).join(" ");
}

const TOKEN_STOP = new Set([
  "a", "an", "and", "around", "for", "how", "in", "of", "on", "or", "the", "to", "with",
  "rule", "rules", "service", "services",
]);

function tokens(value) {
  return [...new Set(clean(value)
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !TOKEN_STOP.has(token)))];
}

function queryMatches(candidate, query) {
  const normalizedQuery = clean(query).toLocaleLowerCase().replace(/\s+/g, " ");
  const reviewedQuery = clean(candidate.query?.text).toLocaleLowerCase().replace(/\s+/g, " ");
  if (!normalizedQuery) return false;
  if (normalizedQuery === reviewedQuery) return true;
  const requested = tokens(normalizedQuery);
  const vocabulary = new Set(tokens(candidateVocabulary(candidate)));
  return requested.filter((token) => vocabulary.has(token)).length >= 2;
}

function normalizedAgency(value) {
  return clean(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function candidateMeetsFilters(candidate, options) {
  const requestedAgency = normalizedAgency(options.agency);
  if (requestedAgency) {
    const candidateAgency = normalizedAgency(candidate.rule?.agency);
    if (!candidateAgency || (!candidateAgency.includes(requestedAgency) && !requestedAgency.includes(candidateAgency))) return false;
  }
  const requestedProcess = clean(options.process).toLocaleLowerCase();
  if (requestedProcess && requestedProcess !== "all" && candidate.rule?.process_stage !== requestedProcess) return false;
  const requestedGeography = clean(options.geography || options.borough).toLocaleLowerCase();
  if (requestedGeography && requestedGeography !== "all") {
    const geography = candidate.rule?.geography || {};
    const values = [geography.scope, geography.borough, ...(geography.boroughs || [])]
      .filter(Boolean)
      .map((value) => clean(value).toLocaleLowerCase());
    if (!values.includes(requestedGeography)) return false;
  }
  const date = isoDay(candidate.rule?.published_at);
  const dateFrom = isoDay(options.date_from);
  const dateTo = isoDay(options.date_to);
  if (dateFrom && (!date || date < dateFrom)) return false;
  if (dateTo && (!date || date > dateTo)) return false;
  return true;
}

export function buildRulesSemanticLane({
  corpusManifest,
  passageMap,
  retrievalReview,
  rulesSnapshot,
} = {}) {
  if (corpusManifest?.schema !== "cityscroll.semantic_retrieval.corpus_manifest.v1") {
    throw new Error("Rules semantic lane requires the versioned corpus manifest");
  }
  if (corpusManifest.authorization?.runtime_semantic_retrieval !== false) {
    throw new Error("Rules semantic lane cannot authorize runtime semantic retrieval");
  }
  if (passageMap?.corpus_sha256 !== corpusManifest.input_receipts?.corpus?.sha256) {
    throw new Error("Rules semantic lane passage map does not match the corpus manifest input");
  }
  const rules = Array.isArray(rulesSnapshot?.rows) ? rulesSnapshot.rows : [];
  const rulesById = new Map(rules
    .filter((row) => clean(row?.request_id) && row?.section_name === "Agency Rules")
    .map((row) => [clean(row.request_id), row]));
  const manifestById = new Map((corpusManifest.records || []).map((row) => [row.source_record_id, row]));
  const sourceById = new Map((passageMap.sources || []).map((row) => [row.source_record_id, row]));
  const passageBySource = new Map();
  for (const passage of passageMap.passages || []) {
    if (passage.text_state === "retained" && !passageBySource.has(passage.source_record_id)) {
      passageBySource.set(passage.source_record_id, passage);
    }
  }

  const candidates = [];
  const held = [];
  for (const query of retrievalReview?.queries || []) {
    const lexicalIds = new Set((query.methods?.bm25 || []).map((row) => clean(row.document_id)));
    const semanticOnly = (query.methods?.semantic || []).filter((row) => (
      row?.relevant === true
      && row?.honest_label === "retrieval_candidate"
      && !lexicalIds.has(clean(row.document_id))
    ));
    for (const result of semanticOnly) {
      const requestId = clean(result.document_id);
      const rule = rulesById.get(requestId);
      const recordId = sourceRecordId(result.kind, requestId);
      const manifestRecord = manifestById.get(recordId);
      const source = sourceById.get(recordId);
      const passage = passageBySource.get(recordId);
      if (!rule || result.kind !== "city_record_notice") {
        held.push({ query_id: clean(query.query_id), source_native_id: requestId, reason: "not_typed_rule" });
        continue;
      }
      if (!manifestRecord || !source || !passage) {
        held.push({ query_id: clean(query.query_id), source_native_id: requestId, reason: "incomplete_source_receipt" });
        continue;
      }
      const title = clean(rule.short_title || source.title || result.title);
      candidates.push({
        candidate_id: `rules-related-language:${clean(query.query_id)}:${requestId}`,
        record_type: "rule",
        query: {
          query_id: clean(query.query_id),
          text: clean(query.query),
        },
        retrieval: {
          method: "reviewed_semantic_only",
          honest_label: "related_language_candidate",
          reviewed_on: retrievalReview.observed_on || null,
        },
        rule: {
          request_id: requestId,
          title,
          agency: clean(rule.agency_name) || null,
          canonical_url: `/notices/${encodeURIComponent(requestId)}`,
          process_stage: processStage(rule.rule_evidence?.lifecycle_status),
          lifecycle_status: clean(rule.rule_evidence?.lifecycle_status) || "unknown",
          published_at: isoDay(rule.start_date || manifestRecord.dates?.published_at),
          geography: rule.rule_location || rule.affected_area || { scope: "unknown" },
        },
        source: {
          source_record_id: recordId,
          source_system: source.source_system || manifestRecord.source_system || null,
          source_url: source.source_url || manifestRecord.source_url,
          freshness: source.freshness || manifestRecord.freshness_receipt,
        },
        source_passage: {
          passage_id: passage.passage_id,
          text_state: passage.text_state,
          text: passage.text,
          boundary: passage.boundary,
          text_sha256: passage.text_sha256,
        },
        coverage: source.coverage || {
          state: manifestRecord.coverage_state,
          boundary: corpusManifest.coverage?.boundary || null,
        },
      });
    }
  }
  candidates.sort((a, b) => a.query.query_id.localeCompare(b.query.query_id)
    || a.rule.request_id.localeCompare(b.rule.request_id));
  held.sort((a, b) => a.query_id.localeCompare(b.query_id)
    || a.source_native_id.localeCompare(b.source_native_id));

  const artifact = {
    schema: RULES_SEMANTIC_LANE_SCHEMA,
    artifact_version: 1,
    rules_snapshot_observed_at: rulesSnapshot?.retrieved_at || null,
    corpus_observed_on: corpusManifest.observed_on || retrievalReview?.observed_on || null,
    authorization: {
      runtime_semantic_retrieval: false,
      publication_scope: "precomputed_rules_related_language_pilot",
    },
    corpus_manifest: {
      schema: corpusManifest.schema,
      manifest_sha256: corpusManifest.manifest_sha256,
      corpus_sha256: corpusManifest.corpus_sha256,
    },
    passage_map: {
      schema: passageMap.schema,
      map_sha256: passageMap.map_sha256,
    },
    coverage: {
      state: "partial",
      boundary: "Reviewed semantic-only wins that resolve to typed Rules records in the bounded corpus.",
    },
    candidate_count: candidates.length,
    held_candidate_count: held.length,
    candidates,
    held_candidates: held,
  };
  return validateRulesSemanticLane(artifact);
}

export function validateRulesSemanticLane(artifact) {
  if (!artifact || artifact.schema !== RULES_SEMANTIC_LANE_SCHEMA || artifact.artifact_version !== 1) {
    throw new Error("Rules semantic lane schema mismatch");
  }
  if (artifact.authorization?.runtime_semantic_retrieval !== false) {
    throw new Error("Rules semantic lane must stay precomputed");
  }
  if (artifact.coverage?.state !== "partial" || !clean(artifact.coverage?.boundary)) {
    throw new Error("Rules semantic lane must declare its partial coverage boundary");
  }
  if (!Array.isArray(artifact.candidates) || !Array.isArray(artifact.held_candidates)) {
    throw new Error("Rules semantic lane candidate arrays are missing");
  }
  if (artifact.candidate_count !== artifact.candidates.length
    || artifact.held_candidate_count !== artifact.held_candidates.length) {
    throw new Error("Rules semantic lane counts do not match rows");
  }
  const ids = new Set();
  for (const candidate of artifact.candidates) {
    if (!clean(candidate.candidate_id) || ids.has(candidate.candidate_id)) throw new Error("Rules semantic candidate id is missing or duplicated");
    ids.add(candidate.candidate_id);
    if (candidate.record_type !== "rule" || candidate.retrieval?.method !== "reviewed_semantic_only") {
      throw new Error("Rules semantic candidate changed type or method");
    }
    if (!/^\/notices\/[A-Za-z0-9_-]+$/.test(clean(candidate.rule?.canonical_url))) {
      throw new Error("Rules semantic candidate canonical URL is invalid");
    }
    if (candidate.source_passage?.text_state !== "retained"
      || !clean(candidate.source_passage?.text)
      || !/^[a-f0-9]{64}$/.test(clean(candidate.source_passage?.text_sha256))) {
      throw new Error("Rules semantic candidate source passage is incomplete");
    }
    if (!/^https:\/\//.test(clean(candidate.source?.source_url))) {
      throw new Error("Rules semantic candidate source URL is invalid");
    }
  }
  return artifact;
}

export function resolveRulesSemanticLane(artifact, options = {}) {
  const query = clean(options.query);
  if (!query) return { state: "idle", coverage: { state: "partial" }, candidates: [] };
  if (!artifact) return { state: "unavailable", coverage: { state: "unavailable" }, candidates: [] };
  try { validateRulesSemanticLane(artifact); } catch (_error) {
    return { state: "unavailable", coverage: { state: "unavailable" }, candidates: [] };
  }
  const related = artifact.candidates.filter((candidate) => queryMatches(candidate, query));
  if (!related.length) {
    return { state: "not_yet_observed", coverage: artifact.coverage, candidates: [] };
  }
  const lexicalIds = new Set((options.lexical_request_ids || []).map(clean));
  const semanticOnly = related.filter((candidate) => !lexicalIds.has(candidate.rule.request_id));
  if (!semanticOnly.length) {
    return { state: "lexical_only", coverage: artifact.coverage, candidates: [] };
  }
  const filtered = semanticOnly.filter((candidate) => candidateMeetsFilters(candidate, options));
  if (!filtered.length) {
    return {
      state: "held",
      coverage: { ...artifact.coverage, reason: "hard_filters" },
      candidates: [],
    };
  }
  return { state: "matched", coverage: artifact.coverage, candidates: filtered };
}

function defaultEscape(value) {
  return clean(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderRulesSemanticLane(projection, options = {}) {
  if (!projection || ["idle", "lexical_only"].includes(projection.state)) return "";
  const t = typeof options.t === "function" ? options.t : (key) => key;
  const escape = typeof options.escape === "function" ? options.escape : defaultEscape;
  const heading = escape(t("rules_semantic_heading"));
  const statusCopy = projection.state === "unavailable"
    ? t("rules_semantic_unavailable")
    : projection.state === "held"
      ? t("rules_semantic_held")
      : projection.state === "not_yet_observed"
        ? t("rules_semantic_not_yet_observed")
        : t("rules_semantic_partial");
  const cards = (projection.candidates || []).map((candidate) => {
    const passage = escape(candidate.source_passage.text).replaceAll("\n", "<br>");
    const date = candidate.rule.published_at
      ? `<time datetime="${escape(candidate.rule.published_at)}">${escape(candidate.rule.published_at)}</time>`
      : "";
    const agency = candidate.rule.agency ? escape(candidate.rule.agency) : "";
    const meta = [agency, date].filter(Boolean).join(" · ");
    return `<article class="rules-semantic-card" data-record-type="rule" data-request-id="${escape(candidate.rule.request_id)}">
      <p class="rules-semantic-match">${escape(t("rules_semantic_match"))}</p>
      <h4><a href="${escape(candidate.rule.canonical_url)}">${escape(candidate.rule.title)}</a></h4>
      ${meta ? `<p class="rules-semantic-meta">${meta}</p>` : ""}
      <p class="rules-semantic-passage-label">${escape(t("rules_semantic_source_passage"))}</p>
      <blockquote lang="en" translate="no">${passage}</blockquote>
      <p><a class="act mini" href="${escape(candidate.rule.canonical_url)}">${escape(t("rules_semantic_open_rule"))}</a></p>
    </article>`;
  }).join("");
  return `<section class="rules-semantic-lane" data-rules-semantic-lane="${escape(projection.state)}" aria-labelledby="rules-semantic-heading">
    <div class="rules-semantic-lane-head"><h3 id="rules-semantic-heading">${heading}</h3><p>${escape(statusCopy)}</p></div>
    ${cards ? `<div class="rules-semantic-cards">${cards}</div>` : ""}
  </section>`;
}
