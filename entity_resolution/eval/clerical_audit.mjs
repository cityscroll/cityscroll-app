// Deterministic, read-only clerical-audit sampling for entity resolution.
// The audit has two strata: proposed auto-links (false-merge control) and
// high-similarity non-links (false-split priority). Label promotion is
// append-only into a new gold_vN series; existing gold files are never edited.

import { createHash } from "node:crypto";
import { generateCandidates, CANDIDATE_GENERATION_VERSION } from "../candidate_generation/index.mjs";
import { extractFeatures, FEATURES_VERSION } from "../features/index.mjs";
import { MATCHERS_VERSION, scorePair } from "../matchers/index.mjs";
import {
  VENDOR_STEM_METHOD,
  VENDOR_STEM_VERSION,
  vendorStem,
} from "../normalizers/vendor_stem.mjs";

export const CLERICAL_AUDIT_SCHEMA_VERSION = 1;
export const DEFAULT_AUTO_LINK_SIZE = 30;
export const DEFAULT_NEAR_MISS_SIZE = 60;
export const DEFAULT_NEAR_MISS_MIN_SIMILARITY = 0.3;

const LABEL_COLUMNS = [
  "audit_id",
  "stratum",
  "audit_priority",
  "entity_type",
  "matcher_decision",
  "confidence",
  "token_jaccard",
  "shared_keys",
  "left_source_system",
  "left_native_key",
  "left_source_record_id",
  "left_display_name",
  "left_pin",
  "right_source_system",
  "right_native_key",
  "right_source_record_id",
  "right_display_name",
  "right_pin",
  "label",
  "reviewer",
  "reviewed_at",
  "notes",
];

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function parseObject(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeObservation(row, index) {
  if (!row || typeof row !== "object") return null;
  const snapshot = parseObject(row.normalized_snapshot);
  const sourceSystem = clean(row.source_system || "city_record");
  const nativeKey = clean(row.source_system_id || row.request_id || row.native_key);
  const displayName = clean(row.vendor_name || row.display_name || snapshot.vendor_name);
  if (!sourceSystem || !nativeKey || !displayName) return null;
  const sourceRecordId = clean(row.source_record_id)
    || [sourceSystem, nativeKey, clean(row.content_hash)].filter(Boolean).join(":");
  const canonicalEntityIds = Array.isArray(row.canonical_entity_ids)
    ? row.canonical_entity_ids.map(clean).filter(Boolean)
    : clean(row.canonical_entity_ids).split(",").map(clean).filter(Boolean);
  return {
    source_system: sourceSystem,
    source_system_id: nativeKey,
    native_key: nativeKey,
    source_record_id: sourceRecordId || `${sourceSystem}:row-${index + 1}`,
    display_name: displayName,
    vendor_name: displayName,
    pin: clean(row.pin || snapshot.pin),
    ingested_at: clean(row.ingested_at),
    entity_type: "vendor",
    link_state_available: row.link_state_available === true || Number(row.link_state_available) === 1,
    canonical_entity_ids: canonicalEntityIds,
  };
}

function sideForAudit(observation) {
  return {
    source_system: observation.source_system,
    native_key: observation.native_key,
    source_record_id: observation.source_record_id,
    display_name: observation.display_name,
    pin: observation.pin,
  };
}

function pairIdentity(left, right) {
  return [left.source_record_id, right.source_record_id].sort().join("::");
}

function auditId(left, right) {
  return `era-${sha256(pairIdentity(left, right)).slice(0, 16)}`;
}

function auditPair(candidate, stratum, score, features, linkEvidence) {
  const left = sideForAudit(candidate.left);
  const right = sideForAudit(candidate.right);
  return {
    audit_id: auditId(left, right),
    stratum,
    audit_priority: stratum === "near_miss" ? "false_split" : "false_merge",
    entity_type: "vendor",
    left,
    right,
    shared_keys: candidate.shared_keys,
    matcher_decision: score.decision,
    confidence: score.confidence,
    method: score.method,
    matcher_version: score.matcher_version,
    features: {
      token_jaccard: features.token_jaccard,
      stem_equal: features.stem_equal,
      length_ratio: features.length_ratio,
      name_containment: features.name_containment,
      legal_form_conflict: features.legal_form_conflict,
      shared_tokens: features.shared_tokens,
    },
    link_evidence: linkEvidence,
    label: "",
    reviewer: "",
    reviewed_at: "",
    notes: "",
  };
}

function sharedCanonicalEntityIds(left, right) {
  const rightIds = new Set(right.canonical_entity_ids || []);
  return (left.canonical_entity_ids || []).filter((id) => rightIds.has(id)).sort();
}

function compareNearMiss(a, b) {
  return b.features.token_jaccard - a.features.token_jaccard
    || b.confidence - a.confidence
    || b.features.length_ratio - a.features.length_ratio
    || a.audit_id.localeCompare(b.audit_id);
}

function compareAutoLink(a, b) {
  return sha256(a.audit_id).localeCompare(sha256(b.audit_id));
}

function pairShape(item) {
  return [item.left.display_name, item.right.display_name]
    .map((name) => clean(name).toUpperCase())
    .sort()
    .join("::");
}

function diverseSample(sorted, limit, groupKey) {
  if (limit <= 0) return [];
  const selected = [];
  const selectedIds = new Set();
  const seenGroups = new Set();
  for (const item of sorted) {
    const key = groupKey(item);
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    selected.push(item);
    selectedIds.add(item.audit_id);
    if (selected.length === limit) return selected;
  }
  // If the requested sample is larger than the number of distinct pair
  // shapes, fill deterministically with remaining live attempts.
  for (const item of sorted) {
    if (selectedIds.has(item.audit_id)) continue;
    selected.push(item);
    if (selected.length === limit) break;
  }
  return selected;
}

/**
 * Build a reproducible two-stratum audit sample from live observations.
 * This function is pure: it does not read or write D1.
 */
export function buildClericalAudit(rows = [], opts = {}) {
  const observedOn = clean(opts.observedOn || new Date().toISOString().slice(0, 10));
  const autoLinkSize = Math.max(0, Number(opts.autoLinkSize ?? DEFAULT_AUTO_LINK_SIZE));
  const nearMissSize = Math.max(0, Number(opts.nearMissSize ?? DEFAULT_NEAR_MISS_SIZE));
  const nearMissMinSimilarity = Math.max(
    0,
    Math.min(1, Number(opts.nearMissMinSimilarity ?? DEFAULT_NEAR_MISS_MIN_SIMILARITY)),
  );
  const observations = (Array.isArray(rows) ? rows : [])
    .map(normalizeObservation)
    .filter(Boolean);
  const candidates = generateCandidates(observations, {
    blocker: "token_v0",
    entityType: "vendor",
  });
  const autoEligible = [];
  const nearEligible = [];

  for (const candidate of candidates) {
    if (candidate.left.source_record_id === candidate.right.source_record_id) continue;
    const features = extractFeatures(candidate.left, candidate.right, { entityType: "vendor" });
    const score = scorePair(candidate.left, candidate.right, features);
    const exactStemAuto = Boolean(
      features.left_stem
      && features.left_stem === features.right_stem
      && vendorStem(candidate.left.display_name) === vendorStem(candidate.right.display_name),
    );
    const storedLinkState = candidate.left.link_state_available && candidate.right.link_state_available;
    const sharedCanonicalIds = sharedCanonicalEntityIds(candidate.left, candidate.right);
    const acceptedAutoLink = storedLinkState ? sharedCanonicalIds.length > 0 : exactStemAuto;
    const linkEvidence = {
      mode: storedLinkState ? "stored_links" : "policy_replay",
      shared_canonical_entity_ids: sharedCanonicalIds,
      exact_stem_policy_match: exactStemAuto,
    };
    if (acceptedAutoLink) {
      autoEligible.push(auditPair(candidate, "auto_link", score, features, linkEvidence));
      continue;
    }
    if (features.token_jaccard >= nearMissMinSimilarity) {
      nearEligible.push(auditPair(candidate, "near_miss", score, features, linkEvidence));
    }
  }

  autoEligible.sort(compareAutoLink);
  nearEligible.sort(compareNearMiss);
  const autoSample = diverseSample(
    autoEligible,
    autoLinkSize,
    (item) => vendorStem(item.left.display_name),
  );
  const nearSample = diverseSample(nearEligible, nearMissSize, pairShape);
  // FALSE-SPLIT is the primary maturity signal, so near-misses lead the sheet.
  const sample = [...nearSample, ...autoSample];
  const sampleDigest = sha256(sample.map((row) => row.audit_id).join("\n"));
  const receipt = {
    kind: "er_clerical_audit",
    schema_version: CLERICAL_AUDIT_SCHEMA_VERSION,
    observed_on: observedOn,
    primary_signal: "false_split",
    secondary_control: "false_merge",
    input_records: observations.length,
    candidate_pairs: candidates.length,
    strata: {
      auto_link: { eligible: autoEligible.length, sampled: autoSample.length },
      near_miss: { eligible: nearEligible.length, sampled: nearSample.length },
    },
    parameters: {
      auto_link_size: autoLinkSize,
      near_miss_size: nearMissSize,
      near_miss_min_similarity: nearMissMinSimilarity,
    },
    versions: {
      candidate_generation: CANDIDATE_GENERATION_VERSION,
      features: FEATURES_VERSION,
      matcher: MATCHERS_VERSION,
      auto_link_method: VENDOR_STEM_METHOD,
      auto_link_matcher_version: VENDOR_STEM_VERSION,
    },
    sample_sha256: sampleDigest,
  };
  return { sample, receipt };
}

function csvValue(value) {
  const text = Array.isArray(value) ? value.join("|") : String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function formatLabelSheet(sample = []) {
  const lines = [LABEL_COLUMNS.join(",")];
  for (const item of sample) {
    const row = {
      audit_id: item.audit_id,
      stratum: item.stratum,
      audit_priority: item.audit_priority,
      entity_type: item.entity_type,
      matcher_decision: item.matcher_decision,
      confidence: item.confidence,
      token_jaccard: item.features?.token_jaccard,
      shared_keys: item.shared_keys,
      left_source_system: item.left?.source_system,
      left_native_key: item.left?.native_key,
      left_source_record_id: item.left?.source_record_id,
      left_display_name: item.left?.display_name,
      left_pin: item.left?.pin,
      right_source_system: item.right?.source_system,
      right_native_key: item.right?.native_key,
      right_source_record_id: item.right?.source_record_id,
      right_display_name: item.right?.display_name,
      right_pin: item.right?.pin,
      label: item.label,
      reviewer: item.reviewer,
      reviewed_at: item.reviewed_at,
      notes: item.notes,
    };
    lines.push(LABEL_COLUMNS.map((column) => csvValue(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Minimal RFC 4180 parser for the generated review sheet. */
export function parseLabelSheet(text) {
  const table = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = String(text || "");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      table.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("label sheet has an unterminated quoted field");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    table.push(row);
  }
  const [header, ...body] = table.filter((cells) => cells.some((cell) => cell !== ""));
  if (!header) throw new Error("label sheet is empty");
  for (const required of LABEL_COLUMNS) {
    if (!header.includes(required)) throw new Error(`label sheet missing column ${required}`);
  }
  return body.map((cells, rowIndex) => {
    if (cells.length !== header.length) {
      throw new Error(`label sheet row ${rowIndex + 2} has ${cells.length} columns; expected ${header.length}`);
    }
    return Object.fromEntries(header.map((column, index) => [column, cells[index]]));
  });
}

function parseGold(text) {
  const records = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`base gold line ${index + 1} is invalid JSON: ${error.message}`);
      }
    });
  const meta = records[0];
  if (!meta?._meta || !/^v\d+$/.test(meta.gold_version || "")) {
    throw new Error("base gold requires a leading versioned _meta record");
  }
  const cases = records.slice(1);
  if (meta.case_count !== cases.length) {
    throw new Error(`base gold case_count=${meta.case_count} but contains ${cases.length} cases`);
  }
  return { meta, cases };
}

function sideMembershipKey(side = {}) {
  return [
    clean(side.source_system).toLowerCase(),
    clean(side.native_key || side.source_record_id || side.display_name).toLowerCase(),
  ].join(":");
}

function membershipKey(left, right) {
  return [sideMembershipKey(left), sideMembershipKey(right)].sort().join("::");
}

function goldSide(row, prefix) {
  const attrs = {};
  if (clean(row[`${prefix}_pin`])) attrs.pin = clean(row[`${prefix}_pin`]);
  return {
    source_system: clean(row[`${prefix}_source_system`]),
    native_key: clean(row[`${prefix}_native_key`]),
    display_name: clean(row[`${prefix}_display_name`]),
    attrs,
  };
}

/**
 * Append reviewed audit rows to a new in-memory gold version.
 * Filesystem overwrite protection belongs to the CLI; this helper enforces
 * semantic version, review-evidence, and duplicate-membership guards.
 */
export function promoteLabelsToGold({
  baseGoldText,
  labelSheetText,
  goldVersion,
  promotedOn = new Date().toISOString().slice(0, 10),
}) {
  const { meta: baseMeta, cases: baseCases } = parseGold(baseGoldText);
  const baseVersion = Number(baseMeta.gold_version.slice(1));
  const match = /^v(\d+)$/.exec(clean(goldVersion));
  if (!match || Number(match[1]) <= baseVersion) {
    throw new Error(`gold version must be newer than base ${baseMeta.gold_version}`);
  }
  const version = `v${Number(match[1])}`;
  const labels = parseLabelSheet(labelSheetText);
  const existing = new Set(baseCases.map((item) => membershipKey(item.left, item.right)));
  const promoted = [];
  let skippedUnlabeled = 0;

  for (const row of labels) {
    const label = clean(row.label).toLowerCase();
    if (!label) {
      skippedUnlabeled += 1;
      continue;
    }
    if (!new Set(["same", "different"]).has(label)) {
      throw new Error(`audit ${row.audit_id} label must be same or different`);
    }
    if (!clean(row.reviewer) || !clean(row.reviewed_at)) {
      throw new Error(`audit ${row.audit_id} requires reviewer and reviewed_at before promotion`);
    }
    const left = goldSide(row, "left");
    const right = goldSide(row, "right");
    const key = membershipKey(left, right);
    if (existing.has(key)) {
      throw new Error(`audit ${row.audit_id} pair already exists in base gold or this promotion`);
    }
    existing.add(key);
    const id = `g${version}-${String(promoted.length + 1).padStart(3, "0")}`;
    const reviewerNote = `Clerical audit ${clean(row.audit_id)}; ${clean(row.stratum)} stratum; reviewed ${clean(row.reviewed_at)} by ${clean(row.reviewer)}`;
    promoted.push({
      id,
      entity_type: clean(row.entity_type || "vendor"),
      label,
      difficulty: row.stratum === "near_miss" ? "hard" : "medium",
      sources: [...new Set([left.source_system, right.source_system])].filter(Boolean),
      left,
      right,
      notes: clean(row.notes) ? `${reviewerNote}. ${clean(row.notes)}` : reviewerNote,
      audit_provenance: {
        audit_id: clean(row.audit_id),
        stratum: clean(row.stratum),
        reviewer: clean(row.reviewer),
        reviewed_at: clean(row.reviewed_at),
      },
    });
  }
  if (!promoted.length) throw new Error("no reviewed labels are eligible for promotion");

  const nextMeta = {
    ...baseMeta,
    gold_version: version,
    case_count: baseCases.length + promoted.length,
    description: `Entity-resolution gold ${version}; ${promoted.length} clerical-audit cases promoted on ${promotedOn} from ${baseMeta.gold_version}. Existing case identities and labels are preserved.`,
  };
  const text = `${[nextMeta, ...baseCases, ...promoted].map((item) => JSON.stringify(item)).join("\n")}\n`;
  return {
    text,
    receipt: {
      kind: "er_gold_promotion",
      schema_version: 1,
      promoted_on: promotedOn,
      base_gold_version: baseMeta.gold_version,
      gold_version: version,
      base_cases: baseCases.length,
      promoted_cases: promoted.length,
      skipped_unlabeled: skippedUnlabeled,
      promoted_audit_ids: promoted.map((item) => item.audit_provenance.audit_id),
      gold_sha256: sha256(text),
    },
  };
}

export function formatAuditJsonl(sample = [], receipt = {}) {
  const meta = {
    _meta: true,
    kind: "er_clerical_audit_sample",
    schema_version: CLERICAL_AUDIT_SCHEMA_VERSION,
    observed_on: receipt.observed_on,
    case_count: sample.length,
    sample_sha256: receipt.sample_sha256,
  };
  return `${[meta, ...sample].map((item) => JSON.stringify(item)).join("\n")}\n`;
}
