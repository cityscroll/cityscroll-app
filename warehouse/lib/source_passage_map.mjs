import { createHash } from "node:crypto";

export const SOURCE_PASSAGE_MAP_SCHEMA = "cityscroll.semantic_retrieval.source_passage_map.v1";
export const SOURCE_PASSAGE_MAX_CHARS = 1_200;
export const SOURCE_PASSAGE_OVERLAP_CHARS = 200;

const COVERAGE_SELECTION_FIELD = Object.freeze({
  city_record_notice: "notice_ids",
  attachment_text: "attachment",
  community_board_minutes: "outcome_document",
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function sourceRecordId(document) {
  const family = String(document?.kind || "").trim();
  const nativeId = String(document?.id || "").trim();
  if (!family || !nativeId) throw new Error("source passage records require kind and id");
  return `${family}:${encodeURIComponent(nativeId)}`;
}

function sourceUrl(document) {
  const value = String(document?.source?.url || "").trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`source passage record ${document?.id || "unknown"} requires an absolute source URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`source passage record ${document?.id || "unknown"} requires an HTTP source URL`);
  }
  return value;
}

function coverageFor(corpus, document) {
  const selectionField = COVERAGE_SELECTION_FIELD[document.kind];
  const boundary = selectionField ? corpus?.selection?.[selectionField] : null;
  if (!boundary) return { state: "unknown", boundary: null };
  return { state: "partial", boundary: String(boundary) };
}

function freshnessFor(corpus, document) {
  const observedOn = String(corpus?.observed_on || "").trim() || null;
  const publishedAt = String(document?.published_at || "").trim() || null;
  return {
    state: observedOn && publishedAt ? "observed" : "unknown",
    observed_on: observedOn,
    source_published_at: publishedAt,
  };
}

function passagesFor(document, sourceRecordIdValue) {
  const family = String(document.kind);
  const text = typeof document.text === "string" && document.text.length > 0
    ? document.text
    : null;
  if (text === null) {
    const passageId = `${sourceRecordIdValue}:p0001`;
    return [{
      passage_id: passageId,
      candidate_id: passageId,
      source_record_id: sourceRecordIdValue,
      source_family: family,
      passage_index: 0,
      text_state: "unknown",
      boundary: { unit: "utf16_code_unit", start: null, end: null },
      text: null,
      text_sha256: null,
    }];
  }

  const passages = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + SOURCE_PASSAGE_MAX_CHARS);
    const retainedText = text.slice(start, end);
    const passageId = `${sourceRecordIdValue}:p${String(index + 1).padStart(4, "0")}`;
    passages.push({
      passage_id: passageId,
      candidate_id: passageId,
      source_record_id: sourceRecordIdValue,
      source_family: family,
      passage_index: index,
      text_state: "retained",
      boundary: { unit: "utf16_code_unit", start, end },
      text: retainedText,
      text_sha256: sha256(retainedText),
    });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - SOURCE_PASSAGE_OVERLAP_CHARS);
    index += 1;
  }
  return passages;
}

export function buildSourcePassageMap(corpus, { corpusSha256 = null } = {}) {
  if (!Array.isArray(corpus?.documents)) throw new Error("source passage map requires corpus documents");

  const sources = [];
  const passages = [];
  const sourceIds = new Set();
  for (const document of corpus.documents) {
    const recordId = sourceRecordId(document);
    if (sourceIds.has(recordId)) throw new Error(`duplicate typed source record ${recordId}`);
    sourceIds.add(recordId);
    const sourcePassages = passagesFor(document, recordId);
    sources.push({
      source_record_id: recordId,
      source_native_id: String(document.id),
      source_family: String(document.kind),
      source_system: String(document?.source?.system || "").trim() || null,
      source_url: sourceUrl(document),
      title: String(document?.title || "").trim() || null,
      freshness: freshnessFor(corpus, document),
      coverage: coverageFor(corpus, document),
      passage_ids: sourcePassages.map((passage) => passage.passage_id),
    });
    passages.push(...sourcePassages);
  }

  const byCandidateId = Object.fromEntries(passages.map((passage) => [
    passage.candidate_id,
    {
      source_record_id: passage.source_record_id,
      passage_id: passage.passage_id,
    },
  ]));
  const map = {
    schema: SOURCE_PASSAGE_MAP_SCHEMA,
    observed_on: String(corpus?.observed_on || "").trim() || null,
    corpus_schema: String(corpus?.schema || "").trim() || null,
    corpus_sha256: corpusSha256,
    chunking: {
      boundary_semantics: "zero_based_half_open",
      boundary_unit: "utf16_code_unit",
      max_characters: SOURCE_PASSAGE_MAX_CHARS,
      overlap_characters: SOURCE_PASSAGE_OVERLAP_CHARS,
    },
    source_count: sources.length,
    passage_count: passages.length,
    unknown_passage_count: passages.filter((passage) => passage.text_state === "unknown").length,
    sources,
    passages,
    by_candidate_id: byCandidateId,
  };
  map.map_sha256 = sha256(JSON.stringify({ sources, passages, by_candidate_id: byCandidateId }));
  return validateSourcePassageMap(map);
}

export function validateSourcePassageMap(map) {
  if (map?.schema !== SOURCE_PASSAGE_MAP_SCHEMA) throw new Error("source passage map schema mismatch");
  if (!Array.isArray(map.sources) || !Array.isArray(map.passages)) {
    throw new Error("source passage map requires source and passage arrays");
  }
  if (!map.by_candidate_id || typeof map.by_candidate_id !== "object") {
    throw new Error("source passage map requires candidate lookup");
  }
  if (map.source_count !== map.sources.length || map.passage_count !== map.passages.length) {
    throw new Error("source passage map counts do not match serialized rows");
  }

  const sources = new Map();
  for (const source of map.sources) {
    if (!source.source_record_id || sources.has(source.source_record_id)) {
      throw new Error(`duplicate or missing source record ${source.source_record_id || "unknown"}`);
    }
    if (!source.source_family || !source.source_native_id) throw new Error("typed source identity is incomplete");
    sourceUrl({ id: source.source_native_id, source: { url: source.source_url } });
    if (!new Set(["partial", "complete", "unknown"]).has(source.coverage?.state)) {
      throw new Error(`invalid coverage state for ${source.source_record_id}`);
    }
    if (!new Set(["observed", "stale", "unknown"]).has(source.freshness?.state)) {
      throw new Error(`invalid freshness state for ${source.source_record_id}`);
    }
    sources.set(source.source_record_id, source);
  }

  const passages = new Map();
  for (const passage of map.passages) {
    if (!passage.passage_id || passages.has(passage.passage_id)) {
      throw new Error(`duplicate or missing passage ${passage.passage_id || "unknown"}`);
    }
    const source = sources.get(passage.source_record_id);
    if (!source || source.source_family !== passage.source_family) {
      throw new Error(`passage ${passage.passage_id} has no matching typed source`);
    }
    const boundary = passage.boundary || {};
    if (boundary.unit !== "utf16_code_unit") throw new Error(`invalid passage unit ${passage.passage_id}`);
    if (passage.text_state === "retained") {
      if (!Number.isInteger(boundary.start) || !Number.isInteger(boundary.end) || boundary.end <= boundary.start) {
        throw new Error(`invalid retained passage boundary ${passage.passage_id}`);
      }
      if (typeof passage.text !== "string" || passage.text.length !== boundary.end - boundary.start) {
        throw new Error(`retained passage text does not match boundary ${passage.passage_id}`);
      }
      if (passage.text_sha256 !== sha256(passage.text)) {
        throw new Error(`retained passage checksum mismatch ${passage.passage_id}`);
      }
    } else if (passage.text_state === "unknown") {
      if (passage.text !== null || passage.text_sha256 !== null || boundary.start !== null || boundary.end !== null) {
        throw new Error(`unknown passage must not synthesize text ${passage.passage_id}`);
      }
    } else {
      throw new Error(`invalid passage text state ${passage.passage_id}`);
    }
    passages.set(passage.passage_id, passage);
  }

  const candidates = Object.entries(map.by_candidate_id);
  if (candidates.length !== passages.size) throw new Error("candidate lookup is not one-to-one with passages");
  for (const [candidateId, reference] of candidates) {
    const passage = passages.get(reference?.passage_id);
    if (!passage || passage.candidate_id !== candidateId || passage.source_record_id !== reference.source_record_id) {
      throw new Error(`candidate ${candidateId} does not resolve to exactly one source passage`);
    }
  }
  for (const source of sources.values()) {
    const expectedPassageIds = [...passages.values()]
      .filter((passage) => passage.source_record_id === source.source_record_id)
      .map((passage) => passage.passage_id);
    if (JSON.stringify(source.passage_ids) !== JSON.stringify(expectedPassageIds)) {
      throw new Error(`source passage list mismatch ${source.source_record_id}`);
    }
  }
  const unknownCount = [...passages.values()].filter((passage) => passage.text_state === "unknown").length;
  if (map.unknown_passage_count !== unknownCount) throw new Error("unknown passage count mismatch");
  const expectedMapSha256 = sha256(JSON.stringify({
    sources: map.sources,
    passages: map.passages,
    by_candidate_id: map.by_candidate_id,
  }));
  if (map.map_sha256 !== expectedMapSha256) throw new Error("source passage map checksum mismatch");
  return map;
}

export function resolveSourcePassageCandidate(map, candidateId) {
  validateSourcePassageMap(map);
  const reference = map.by_candidate_id[String(candidateId || "")];
  if (!reference) return null;
  const source = map.sources.find((row) => row.source_record_id === reference.source_record_id);
  const passage = map.passages.find((row) => row.passage_id === reference.passage_id);
  if (!source || !passage) throw new Error(`candidate ${candidateId} has an incomplete source passage`);
  return { candidate_id: String(candidateId), source, passage };
}
