import { compactCitationLawKeys, extractRuleEvidenceStamp } from "./rule_evidence_stamps.mjs";
import { adminCodeHref, lookupAdminCodeCitation } from "./admin_code.mjs";
import {
  buildRuleVersionDiff,
  unavailableRuleVersionDiff,
} from "./rule_version_diff.mjs";

export const RULE_VERSIONS_SCHEMA = "cityscroll.rule_versions.v1";
export const RULE_VERSION_SCHEMA = "cityscroll.rule_version.v1";
export const RULE_EFFECT_SCHEMA = "cityscroll.rule_effect.v1";
export const RULE_VERSION_KINDS = Object.freeze(["proposed", "revised", "adopted", "emergency"]);
export const RULE_EFFECT_KINDS = Object.freeze(["adds", "amends", "repeals"]);

const KIND_ORDER = Object.freeze({ proposed: 0, revised: 1, adopted: 2, emergency: 3 });
const clean = (value, max = 50_000) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function isoDay(value) {
  const match = clean(value, 100).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function slug(value) {
  return clean(value, 300).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function sourceId(document) {
  return clean(document.source_id || document.document_id || document.id || document.request_id, 300) || null;
}

function sourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && ["rules.cityofnewyork.us", "a856-cityrecord.nyc.gov"].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function versionKind(document, text) {
  const explicit = clean(document.version_kind || document.kind, 40).toLowerCase();
  if (RULE_VERSION_KINDS.includes(explicit)) return explicit;
  const haystack = `${clean(document.title, 400)} ${clean(text, 1_500)}`;
  if (/\bemergency\s+rule\b/i.test(haystack)) return "emergency";
  if (/\bfinal\s+rule\b|\bnotice\s+of\s+adoption\b|\badopt(?:ed|ing)\b/i.test(haystack)) return "adopted";
  if (/\brevised\s+(?:proposed\s+)?rule\b|\brevision\b/i.test(haystack)) return "revised";
  return "proposed";
}

function versionHref(source) {
  const href = sourceUrl(source.source_url || source.url);
  return href || null;
}

function sourceSpan(text, start, end, field = "document_text") {
  const value = clean(String(text || "").slice(start, end), 1_200);
  return value ? { field, start, end, text: value } : null;
}

function citationLabel(key) {
  const [family, ...parts] = String(key || "").split(":");
  const citation = parts.join(":");
  if (family === "rcny") return `RCNY § ${citation.replace(/^\d+:/, "")}`;
  if (family === "nyc-admin-code") return `NYC Administrative Code § ${citation}`;
  if (family === "nyc-charter") return `NYC Charter § ${citation}`;
  return citation ? `${family} ${citation}` : key;
}

function citationTarget(key) {
  const value = clean(key, 200).toLowerCase();
  if (!value) return null;
  const [family, ...parts] = value.split(":");
  const citation = parts.join(":");
  if (!citation || !["rcny", "nyc-admin-code", "nyc-charter"].includes(family)) return null;
  if (family === "nyc-admin-code") {
    const lookup = lookupAdminCodeCitation(`§ ${citation}`);
    return {
      ref: `legal-code:${family}:${citation}`,
      kind: family,
      citation,
      label: citationLabel(value),
      href: lookup ? adminCodeHref(lookup.citation) : null,
      resolution: lookup ? "resolved" : "unresolved",
    };
  }
  return {
    ref: `legal-code:${family}:${citation}`,
    kind: family,
    citation,
    label: citationLabel(value),
    href: null,
    resolution: "unresolved",
  };
}

function exactCitationKeys(keys = []) {
  const values = [...new Set(keys.map((key) => clean(key, 200).toLowerCase()).filter(Boolean))];
  return values.filter((key) => !values.some((other) => other !== key
    && other.startsWith(`${key}(`)));
}

function authorityObservations(text, evidence) {
  const out = [];
  const seen = new Set();
  const add = (key, span) => {
    const target = citationTarget(key);
    if (!target || seen.has(target.ref)) return;
    seen.add(target.ref);
    out.push({
      ...target,
      basis: "source_stated",
      source_span: span,
      evidence: "The source document states this authority.",
    });
  };
  for (const match of String(text || "").matchAll(/(?:authoriz|pursuant|under|authority|based on)[^.]{0,260}/gi)) {
    const span = sourceSpan(text, match.index, match.index + match[0].length);
    for (const key of exactCitationKeys(compactCitationLawKeys(match[0], { limit: 16 }))) add(key, span);
  }
  return out;
}

function explicitEffects(text) {
  const effects = [];
  const held = [];
  const seen = new Set();
  const effectPattern = /\b(add(?:s|ed|ing)?|amend(?:s|ed|ing)?|repeal(?:s|ed|ing)?)\b/gi;
  const matches = [...String(text || "").matchAll(effectPattern)];
  for (const [index, match] of matches.entries()) {
    const verb = match[1].toLowerCase();
    const kind = verb.startsWith("add") ? "adds" : verb.startsWith("amend") ? "amends" : "repeals";
    const nextVerb = matches[index + 1]?.index;
    const sentenceEnd = String(text || "").slice(match.index).search(/[.!?\n]/);
    const end = nextVerb != null
      ? nextVerb
      : sentenceEnd >= 0 ? match.index + sentenceEnd : Math.min(String(text || "").length, match.index + 280);
    const span = sourceSpan(text, match.index, Math.min(end, match.index + 280));
    const keys = exactCitationKeys(compactCitationLawKeys(String(text || "").slice(match.index, Math.min(end, match.index + 280)), { limit: 16 }))
      .filter((key) => /^(rcny|nyc-admin-code):/.test(key));
    if (!keys.length) {
      if (span) held.push({ status: "held_ambiguous", reason: "effect verb has no exact supported legal-code citation", source_span: span });
      continue;
    }
    for (const key of keys) {
      const target = citationTarget(key);
      if (!target) continue;
      const dedupe = `${kind}:${target.ref}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      effects.push({
        schema: RULE_EFFECT_SCHEMA,
        kind,
        target,
        status: "published",
        basis: "source_stated",
        source_span: span,
      });
    }
  }
  return { effects, held };
}

function effectiveDateFor(document, evidence, context) {
  const explicit = isoDay(document.effective_date || document.effective_on || evidence.effective_date);
  if (explicit) return { value: explicit, basis: "source_stated", source_field: document.effective_date ? "effective_date" : "document_text" };
  const fallback = isoDay(context.effective_date || context.nyc_rules?.effective_date);
  if (fallback && ["adopted", "emergency"].includes(context.version_kind)) {
    return { value: fallback, basis: "lifecycle_observation", source_field: "nyc_rules.effective_date" };
  }
  return { value: null, basis: "unknown", source_field: null };
}

function commentObservation(document, context) {
  const raw = document.comments_observed ?? document.comment_count ?? context.comment_count ?? context.nyc_rules?.comment_count;
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") {
    const count = raw.count != null && raw.count !== "" && Number.isFinite(Number(raw.count))
      ? Number(raw.count)
      : null;
    return {
      status: "observed",
      count,
      source_field: clean(raw.source_field || (document.comment_count != null || context.comment_count != null ? "comment_count" : "comments_observed"), 80),
      source_span: raw.source_span || null,
    };
  }
  const count = typeof raw === "boolean" ? null : Number(raw);
  return {
    status: "observed",
    count: Number.isFinite(count) && count >= 0 ? count : null,
    source_field: document.comment_count != null || context.comment_count != null ? "comment_count" : "comments_observed",
    source_span: null,
  };
}

function agencyExplanation(document, text) {
  const raw = document.agency_explanation ?? document.agency_explanation_text;
  const value = typeof raw === "object" ? raw.text : raw;
  const explanation = clean(value, 2_000);
  if (!explanation) return null;
  const start = String(text || "").indexOf(explanation);
  return {
    status: "published",
    text: explanation,
    source_field: typeof raw === "object" ? clean(raw.source_field || "agency_explanation", 80) : "agency_explanation",
    source_span: typeof raw === "object" && raw.source_span
      ? raw.source_span
      : start >= 0 ? sourceSpan(text, start, start + explanation.length) : null,
    explicit_source_statement: true,
  };
}

export function normalizeRuleVersionDocument(document = {}, context = {}) {
  const source = sourceId(document);
  const text = clean(document.text || document.extracted_text || document.source_text, 50_000);
  const textStatus = text ? "available" : clean(document.text_status, 40) || "not_acquired";
  const kind = versionKind(document, text);
  const rulemakingId = clean(document.rulemaking_id || context.rulemaking_id, 700) || null;
  const evidence = extractRuleEvidenceStamp({
    short_title: document.title || context.title,
    type_of_notice_description: document.document_type,
    additional_description_1: text,
  });
  const effective = effectiveDateFor(document, evidence, { ...context, version_kind: kind });
  const effects = explicitEffects(text);
  const authority = authorityObservations(text, evidence);
  const versionId = rulemakingId && source
    ? `rule-version:${rulemakingId}:${kind}:${slug(source)}`
    : null;
  return {
    schema: RULE_VERSION_SCHEMA,
    id: versionId,
    rulemaking_id: rulemakingId,
    kind,
    source_id: source,
    source_url: versionHref(document),
    source_label: clean(document.source_label || document.title, 300) || null,
    published_at: isoDay(document.published_at || document.publication_date || document.notice_date),
    effective_date: effective.value,
    effective_date_basis: effective.basis,
    effective_date_source_field: effective.source_field,
    text_status: textStatus,
    text: text || null,
    text_preview: text ? text.slice(0, 480).trim() + (text.length > 480 ? "…" : "") : null,
    authority,
    legal_effects: effects.effects,
    held_references: effects.held,
    comment_observation: commentObservation(document, context),
    agency_explanation: agencyExplanation(document, text),
    pairing_key: clean(document.pairing_key, 300) || null,
    source_span: document.source_span || null,
  };
}

export function pairRuleVersions(versions = []) {
  return pairRuleVersionsDetailed(versions).pairs;
}

function pairRuleVersionsDetailed(versions = []) {
  const byKey = new Map();
  const unpaired = versions.filter((version) => !version?.pairing_key).map((version) => ({
    reason_code: "unpaired_versions",
    pairing_key: null,
    proposed_version_ids: ["proposed", "revised"].includes(version.kind) ? [version.id] : [],
    adopted_version_ids: ["adopted", "emergency"].includes(version.kind) ? [version.id] : [],
  }));
  for (const version of versions) {
    if (!version?.pairing_key) continue;
    const key = `${version.rulemaking_id || ""}:${version.pairing_key}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(version);
  }
  const pairs = [];
  const issues = [...unpaired];
  for (const group of byKey.values()) {
    const proposed = group.filter((version) => version.kind === "proposed" || version.kind === "revised");
    const adopted = group.filter((version) => version.kind === "adopted" || version.kind === "emergency");
    if (proposed.length !== 1 || adopted.length !== 1) {
      issues.push({
        reason_code: proposed.length && adopted.length ? "ambiguous_pairing" : "unpaired_versions",
        pairing_key: group[0]?.pairing_key || null,
        proposed_version_ids: proposed.map((version) => version.id),
        adopted_version_ids: adopted.map((version) => version.id),
      });
      continue;
    }
    const proposedVersion = proposed[0];
    const adoptedVersion = adopted[0];
    proposedVersion.superseded_by = adoptedVersion.id;
    adoptedVersion.supersedes = proposedVersion.id;
    pairs.push({ proposed: proposedVersion.id, adopted: adoptedVersion.id, basis: "shared_source_pairing_key" });
  }
  return { pairs, issues };
}

export function buildRuleVersionsProjection(documents = [], context = {}) {
  const versions = documents
    .map((document) => normalizeRuleVersionDocument(document, context))
    .filter((version) => version.id || version.source_id)
    .sort((left, right) => (KIND_ORDER[left.kind] ?? 9) - (KIND_ORDER[right.kind] ?? 9) || String(left.source_id).localeCompare(String(right.source_id)));
  const pairing = pairRuleVersionsDetailed(versions);
  const pairs = pairing.pairs;
  const byId = new Map(versions.map((version) => [version.id, version]));
  const diffs = pairs.map((pair) => buildRuleVersionDiff(byId.get(pair.proposed), byId.get(pair.adopted), pair));
  for (const issue of pairing.issues) {
    const proposed = byId.get(issue.proposed_version_ids[0]) || null;
    const adopted = byId.get(issue.adopted_version_ids[0]) || null;
    diffs.push(unavailableRuleVersionDiff(issue.reason_code, proposed, adopted, {
      basis: "pairing_key",
      pairing_key: issue.pairing_key,
      proposed_version_ids: issue.proposed_version_ids,
      adopted_version_ids: issue.adopted_version_ids,
    }));
  }
  if (!diffs.length && versions.some((version) => version.kind === "proposed" || version.kind === "revised" || version.kind === "adopted" || version.kind === "emergency")) {
    diffs.push(unavailableRuleVersionDiff("unpaired_versions"));
  }
  const legalEffects = versions.flatMap((version) => (version.legal_effects || []).map((effect) => ({
    ...effect,
    version_id: version.id,
    source_id: version.source_id,
  })));
  const held = versions.flatMap((version) => (version.held_references || []).map((reference) => ({
    ...reference,
    version_id: version.id,
    source_id: version.source_id,
  })));
  return {
    schema: RULE_VERSIONS_SCHEMA,
    rulemaking_id: context.rulemaking_id || null,
    versions,
    legal_effects: legalEffects,
    held_references: held,
    pairs,
    diffs,
    comment_observations: versions.filter((version) => version.comment_observation).map((version) => ({
      version_id: version.id,
      source_id: version.source_id,
      ...version.comment_observation,
    })),
    agency_explanations: versions.filter((version) => version.agency_explanation).map((version) => ({
      version_id: version.id,
      source_id: version.source_id,
      source_url: version.source_url,
      ...version.agency_explanation,
    })),
    pairing_issues: pairing.issues,
    coverage: {
      documents: documents.length,
      proposed_documents: versions.filter((version) => version.kind === "proposed" || version.kind === "revised").length,
      adopted_documents: versions.filter((version) => version.kind === "adopted" || version.kind === "emergency").length,
      paired_versions: pairs.length,
      acquisition_failures: versions.filter((version) => version.text_status !== "available").length,
      exact_citations: versions.reduce((sum, version) => sum + version.authority.length + version.legal_effects.length, 0),
      resolvable_targets: legalEffects.filter((effect) => effect.target.resolution === "resolved").length,
      ambiguous_references: held.length,
      unpaired_versions: pairing.issues.filter((issue) => issue.reason_code === "unpaired_versions").length,
      ambiguous_pairings: pairing.issues.filter((issue) => issue.reason_code === "ambiguous_pairing").length,
      version_diff: {
        pairs_considered: pairs.length + pairing.issues.length,
        usable_version_pairs: diffs.filter((diff) => diff.status === "available").length,
        text_extraction: {
          available_versions: versions.filter((version) => version.text_status === "available").length,
          unavailable_versions: versions.filter((version) => version.text_status !== "available").length,
          non_text_failures: versions.filter((version) => /scan|non.?text|image|pdf/i.test(String(version.text_status || ""))).length,
        },
        section_alignment: {
          deterministic_pairs: diffs.filter((diff) => diff.status === "available" && diff.alignment?.deterministic).length,
          comparable_pairs: diffs.filter((diff) => diff.status === "available" && diff.alignment).length,
          rate: pairs.length ? diffs.filter((diff) => diff.status === "available" && diff.alignment?.deterministic).length / pairs.length : null,
        },
        non_text_failures: diffs.filter((diff) => diff.reason_code?.startsWith("non_text_")).length,
        changed_regions: diffs.reduce((sum, diff) => sum + (Number.isFinite(diff.changed_region_count) ? diff.changed_region_count : 0), 0),
        observed_comments: versions.filter((version) => version.comment_observation).length,
        published_agency_explanations: versions.filter((version) => version.agency_explanation).length,
      },
    },
  };
}

export function attachRuleVersionsToRulemaking(object, documents = []) {
  const projection = buildRuleVersionsProjection(documents, {
    rulemaking_id: object?.rulemaking_id,
    title: object?.title,
    effective_date: object?.nyc_rules?.effective_date,
    nyc_rules: object?.nyc_rules,
  });
  return { ...object, ...projection };
}
