/** Stable identity and citation semantics for addressable code provisions. */

import { createHash } from "node:crypto";

export const CODE_PROVISION_SCHEMA = "cityscroll.code_provision.v1";
export const CODE_VERSION_SCHEMA = "cityscroll.code_version.v1";
export const CODE_PROVISION_LEVELS = Object.freeze([
  "title", "chapter", "subchapter", "appendix", "part", "article",
  "subarticle", "section", "subsection", "paragraph", "subparagraph", "item",
]);

function clean(value, max = 2_000) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeCodeCitation(value) {
  const input = clean(value, 240).normalize("NFKC");
  const match = input
    .replace(/[§]/g, " ")
    .replace(/\b(?:NYC|NEW\s+YORK\s+CITY)\s+(?:ADMIN(?:ISTRATIVE)?\s+)?CODE\b/giu, " ")
    .replace(/\bADMIN(?:ISTRATIVE)?\s+CODE\b/giu, " ")
    .replace(/\b(?:SECTION|SEC\.?|S\.)\b/giu, " ")
    .replace(/[(),:]/g, " ")
    .replace(/\b(\d+)\s+([A-Z]?\d)/gi, "$1-$2")
    .trim()
    .match(/^(\d+[A-Z]?-[0-9A-Z]+(?:\.[0-9A-Z]+)*)$/i);
  return match ? match[1].toLowerCase() : null;
}

export function codeProvisionId(section) {
  const citation = normalizeCodeCitation(section);
  if (!citation) throw new TypeError(`Invalid NYC Administrative Code section: ${section}`);
  return `nyc-admin-code:${citation}`;
}

export function provisionHref(sectionOrId) {
  const citation = String(sectionOrId || "").replace(/^nyc-admin-code:/i, "");
  return `/administrative-code/${encodeURIComponent(citation)}/`;
}

export function codeVersionHash(text) {
  return `sha256:${createHash("sha256").update(String(text ?? ""), "utf8").digest("hex")}`;
}

export function codeProvision(value = {}) {
  const citation = normalizeCodeCitation(value.citation || value.section || value.id);
  if (!citation) throw new TypeError("CodeProvision requires a canonical section citation");
  const id = codeProvisionId(citation);
  const level = clean(value.level, 40).toLowerCase() || "section";
  if (!CODE_PROVISION_LEVELS.includes(level)) throw new TypeError(`Unsupported CodeProvision level: ${level}`);
  const textValue = String(value.current_text ?? value.text ?? "");
  return Object.freeze({
    schema: CODE_PROVISION_SCHEMA,
    id,
    corpus_id: "nyc-administrative-code",
    citation: `§ ${citation}`,
    heading: clean(value.heading, 500) || null,
    parent_id: value.parent_id ? clean(value.parent_id, 240) : null,
    level,
    status: clean(value.status, 40).toLowerCase() || "current",
    current_text: textValue,
    source: Object.freeze({
      url: clean(value.source?.url, 2_000) || null,
      system: clean(value.source?.system, 160) || "american_legal_publishing",
      source_ref: clean(value.source?.source_ref, 240) || null,
      observed_at: clean(value.source?.observed_at, 80) || null,
      content_hash: clean(value.source?.content_hash, 120) || codeVersionHash(textValue),
    }),
    hierarchy: Array.isArray(value.hierarchy) ? value.hierarchy.map((item) => Object.freeze({
      level: clean(item?.level, 40).toLowerCase(),
      label: clean(item?.label, 500),
      id: clean(item?.id, 240),
    })).filter((item) => item.level && item.label && item.id) : [],
  });
}

export function codeVersion(value = {}) {
  const provisionId = clean(value.provision_id, 240);
  if (!/^nyc-admin-code:[a-z0-9]+-[a-z0-9.]+$/i.test(provisionId)) {
    throw new TypeError("CodeVersion requires a CodeProvision id");
  }
  const textValue = String(value.text ?? "");
  return Object.freeze({
    schema: CODE_VERSION_SCHEMA,
    provision_id: provisionId,
    valid_from: value.valid_from || null,
    valid_to: value.valid_to || null,
    text: textValue,
    source_ref: clean(value.source_ref, 240) || null,
    observed_at: clean(value.observed_at, 80) || null,
    content_hash: clean(value.content_hash, 120) || codeVersionHash(textValue),
  });
}
