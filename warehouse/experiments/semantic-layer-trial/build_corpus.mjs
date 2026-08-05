#!/usr/bin/env node
/**
 * Acquire the fixed public-text corpus for the offline semantic-layer trial.
 *
 * Network access is isolated to this explicit acquisition step. The evaluation
 * harness reads the committed corpus and never reaches a production service.
 * Contact strings are redacted before text is written to the fixture.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanNoticeText } from "../../../site/text_clean.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const MANIFEST_PATH = join(HERE, "source_manifest.json");
const OUT_PATH = join(HERE, "corpus.json");
const ATTACHMENT_PATH = join(ROOT, "site/data/attachment_metadata_lookup.json");
const EXTRACTOR_PATH = join(ROOT, "warehouse/lib/attachment_text_extract.py");
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
// Keep enough of long minutes to reach late agenda/outcome sections. The trial
// harness chunks this text before embedding so model token limits do not erase
// later matters.
const MAX_TEXT_CHARS = 24_000;
const NOTICE_FIELDS = [
  "request_id", "start_date", "agency_name", "type_of_notice_description",
  "section_name", "short_title", "event_date", "additional_description_1",
  "additional_description_2", "additional_description_3", "other_info_1", "printout_1",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function redactForPublication(value) {
  const counts = { email: 0, phone: 0, meeting_credential: 0, place_name: 0 };
  let text = String(value || "");
  // Meeting credentials must be removed before the phone pattern can consume
  // a ten-digit substring from a longer meeting number.
  text = text.replace(/\bmeeting number\s*\(\s*access code\s*\)\s*\d+\b/gi, () => {
    counts.meeting_credential += 1;
    return "[meeting placeholder]";
  });
  text = text.replace(/([?&])p[w]d=[^&\s]+/gi, (_match, separator) => {
    counts.meeting_credential += 1;
    return `${separator}[meeting-placeholder]`;
  });
  text = text.replace(/\b(?:Passcode|Password)\s*:?\s*\S+/gi, () => {
    counts.meeting_credential += 1;
    return "[meeting placeholder]";
  });
  text = text.replace(/\bAccess Code\s*:?\s*\d(?:[\d ]*\d)?/gi, () => {
    counts.meeting_credential += 1;
    return "[meeting placeholder]";
  });
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => {
    counts.email += 1;
    return "[email redacted]";
  });
  text = text.replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, () => {
    counts.phone += 1;
    return "[phone redacted]";
  });
  // A real NYC place name also collides with a reserved publication term.
  // The name is irrelevant to this experiment; the street address remains.
  text = text.replace(/\bGotham\b/gi, () => {
    counts.place_name += 1;
    return "[place name redacted]";
  });
  return { text, counts };
}

function compactText(parts) {
  const cleaned = parts.map(cleanNoticeText).filter(Boolean).join("\n");
  const redacted = redactForPublication(cleaned);
  const repeated = redactForPublication(redacted.text);
  if (repeated.text !== redacted.text || Object.values(repeated.counts).some(Boolean)) {
    throw new Error("publication sanitizer is not idempotent");
  }
  return {
    text: redacted.text.slice(0, MAX_TEXT_CHARS),
    publication_redactions: redacted.counts,
    truncated: redacted.text.length > MAX_TEXT_CHARS,
  };
}

async function fetchNotices(ids) {
  const rows = [];
  for (let start = 0; start < ids.length; start += 40) {
    const chunk = ids.slice(start, start + 40);
    const params = new URLSearchParams({
      $select: NOTICE_FIELDS.join(","),
      $where: `request_id in (${chunk.map((id) => `'${id}'`).join(",")})`,
      $order: "request_id",
      $limit: "50",
    });
    const response = await fetch(`${SODA}?${params}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CityScroll semantic-layer offline trial (+https://cityscroll.org)",
      },
    });
    if (!response.ok) throw new Error(`City Record SODA HTTP ${response.status}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("City Record returned a non-array response");
    rows.push(...batch);
  }
  const byId = new Map(rows.map((row) => [String(row.request_id), row]));
  const missing = ids.filter((id) => !byId.has(String(id)));
  if (missing.length) throw new Error(`City Record fixture is missing ${missing.join(", ")}`);
  return ids.map((id) => byId.get(String(id)));
}

function noticeDocument(row, residualById) {
  const content = compactText([
    row.short_title, row.agency_name, row.section_name,
    row.additional_description_1, row.additional_description_2,
    row.additional_description_3, row.other_info_1, row.printout_1,
  ]);
  const residual = residualById.get(String(row.request_id));
  return {
    id: String(row.request_id),
    request_id: String(row.request_id),
    kind: "city_record_notice",
    title: cleanNoticeText(row.short_title),
    agency: cleanNoticeText(row.agency_name),
    section: cleanNoticeText(row.section_name),
    published_at: row.start_date || null,
    event_date: row.event_date || null,
    body_id: residual?.body_id || null,
    text: content.text,
    text_sha256: sha256(content.text),
    publication_redactions: content.publication_redactions,
    truncated: content.truncated,
    source: {
      system: "NYC City Record",
      dataset_id: "dg92-zbpx",
      url: `https://a856-cityrecord.nyc.gov/RequestDetail/${row.request_id}`,
    },
  };
}

function attachmentDocument() {
  const lookup = JSON.parse(readFileSync(ATTACHMENT_PATH, "utf8"));
  const item = lookup?.notices?.["20240515016"]?.[0];
  if (!item?.extracted_text) throw new Error("committed T1 attachment extraction is missing");
  const content = compactText([item.title, item.extracted_text]);
  return {
    id: "20240515016#attachment-37470",
    request_id: "20240515016",
    kind: "attachment_text",
    title: item.title,
    agency: "Environmental Protection",
    section: "Property Disposition",
    published_at: "2024-05-15",
    event_date: null,
    body_id: null,
    text: content.text,
    text_sha256: sha256(content.text),
    publication_redactions: content.publication_redactions,
    truncated: content.truncated,
    source: {
      system: "NYC City Record attachment",
      document_id: String(item.document_id),
      url: item.url,
      extraction_method: item.text_method,
    },
  };
}

async function outcomeDocument(item) {
  const response = await fetch(item.url, {
    headers: {
      Accept: "application/pdf",
      "User-Agent": "CityScroll semantic-layer offline trial (+https://cityscroll.org)",
    },
  });
  if (!response.ok) throw new Error(`outcome document HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const python = process.env.CITYSCROLL_WAREHOUSE_PYTHON || "python3";
  const extraction = spawnSync(python, [EXTRACTOR_PATH, "--kind", "pdf"], {
    input: buffer,
    encoding: "buffer",
    maxBuffer: 8_000_000,
  });
  if (extraction.status !== 0) {
    throw new Error(extraction.stderr?.toString("utf8") || "outcome PDF extraction failed");
  }
  const parsed = JSON.parse(extraction.stdout.toString("utf8"));
  if (parsed.status !== "ok") throw new Error(`outcome text unavailable: ${parsed.reason}`);
  const content = compactText([item.title, parsed.text]);
  return {
    id: item.id,
    request_id: null,
    kind: "community_board_minutes",
    title: item.title,
    agency: "Queens Community Board 8",
    section: "Non-Council outcome source",
    published_at: item.meeting_date,
    event_date: item.meeting_date,
    body_id: item.body_id,
    text: content.text,
    text_sha256: sha256(content.text),
    publication_redactions: content.publication_redactions,
    truncated: content.truncated,
    source: {
      system: "Queens Community Board 8",
      url: item.url,
      extraction_method: parsed.method,
    },
  };
}

const PUBLICATION_RULES = [
  {
    id: "unredacted_email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  {
    id: "url_password_parameter",
    pattern: /[?&]p[w]d=[^&\s]+/i,
  },
  {
    id: "meeting_credential_marker",
    pattern: /\b(?:passcode|password|access code)\b.{0,80}/i,
  },
  {
    id: "reserved_publication_term",
    pattern: /\bGotham\b/i,
  },
];

export function publicationValidationFinding(row) {
  for (const rule of PUBLICATION_RULES) {
    const match = rule.pattern.exec(row.text);
    if (match) return { record_id: String(row.id), rule: rule.id, match: match[0] };
  }
  const repeated = redactForPublication(row.text);
  if (repeated.text !== row.text || Object.values(repeated.counts).some(Boolean)) {
    let offset = 0;
    while (offset < row.text.length && row.text[offset] === repeated.text[offset]) offset += 1;
    return {
      record_id: String(row.id),
      rule: "sanitizer_not_idempotent",
      match: row.text.slice(Math.max(0, offset - 24), offset + 80),
    };
  }
  return null;
}

function validate(corpus, manifest) {
  if (corpus?.schema !== "cityscroll.semantic_layer_trial.corpus.v1") {
    throw new Error("semantic trial corpus schema mismatch");
  }
  if (corpus.documents?.length !== manifest.city_record_notice_ids.length + 2) {
    throw new Error(`expected ${manifest.city_record_notice_ids.length + 2} documents`);
  }
  if (new Set(corpus.documents.map((row) => row.id)).size !== corpus.documents.length) {
    throw new Error("semantic trial corpus contains duplicate document ids");
  }
  if (corpus.documents.some((row) => !row.text || !row.text_sha256)) {
    throw new Error("semantic trial corpus contains an empty document");
  }
  for (const row of corpus.documents) {
    const finding = publicationValidationFinding(row);
    if (finding) {
      throw new Error(
        `semantic trial corpus validation failed record=${finding.record_id} `
        + `rule=${finding.rule} match=${JSON.stringify(finding.match)}`,
      );
    }
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (process.argv.includes("--check")) {
    if (!existsSync(OUT_PATH)) throw new Error("semantic trial corpus is missing");
    const corpus = JSON.parse(readFileSync(OUT_PATH, "utf8"));
    validate(corpus, manifest);
    console.log(`semantic trial corpus ok documents=${corpus.documents.length}`);
    return;
  }
  const residualById = new Map(
    manifest.non_council_residual.map((row) => [String(row.request_id), row]),
  );
  const notices = await fetchNotices(manifest.city_record_notice_ids);
  const documents = notices.map((row) => noticeDocument(row, residualById));
  documents.push(attachmentDocument());
  for (const item of manifest.outcome_documents) documents.push(await outcomeDocument(item));
  const corpus = {
    schema: "cityscroll.semantic_layer_trial.corpus.v1",
    observed_on: manifest.observed_on,
    selection: manifest.selection,
    honest_label: "Fixed offline evaluation corpus; semantic scores are candidates, not facts or links.",
    document_count: documents.length,
    documents,
  };
  validate(corpus, manifest);
  writeFileSync(OUT_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
  console.log(`wrote ${OUT_PATH} documents=${documents.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
