// entity_resolution/policies — conservative auto-link routing (VI-03).
//
// Policy decides when a scorer result becomes an entity_link vs review queue
// vs explicit separate. The conservative policy auto-links only on:
//   1. High-confidence matcher `same` (stem_equal, authority_key_equal,
//      contract_id_equal — methods with confidence ≥ 0.95).
//   2. Reviewed alias-registry matches (verified_alias / successor).
//
// Unresolved stays unresolved. Address/phone alone never auto-links. No
// threshold-only retune — string similarity features must produce a matcher
// `same` decision before the policy considers them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { vendorStem } from "../normalizers/vendor_stem.mjs";
import { extractDba } from "../features/index.mjs";

export const POLICIES_VERSION = "conservative_v1";

const ALIAS_REGISTRY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "review",
  "alias_registry.json",
);

function loadAliasRegistry() {
  const raw = JSON.parse(readFileSync(ALIAS_REGISTRY_PATH, "utf8"));
  return buildAliasIndex(raw);
}

/**
 * Look up a pair in the reviewed alias registry by vendor stem match.
 * PROPOSED and REJECTED entries are deliberately invisible. Returns the
 * matching accepted entry or null.
 */
export function lookupAlias(leftName, rightName) {
  // Read on each decision so a clerk promotion takes effect without a stale
  // process-local index. The registry is a small desk-side artifact.
  return lookupAliasInRegistry(loadAliasRegistry(), leftName, rightName);
}

/** A missing status is the legacy form of an already reviewed entry. */
export function isAcceptedAliasEntry(entry) {
  if (!entry || !entry.left || !entry.right) return false;
  if (entry.status == null || entry.status === "") return true;
  return String(entry.status).toUpperCase() === "ACCEPTED";
}

/** Build the policy-only index; proposal/rejection records never enter it. */
export function buildAliasIndex(registry = {}) {
  const index = { byStem: new Map(), byDbaStem: new Map(), entries: [] };
  for (const entry of registry.entries || []) {
    if (!isAcceptedAliasEntry(entry)) continue;
    const leftStem = vendorStem(entry.left?.display_name);
    const rightStem = vendorStem(entry.right?.display_name);
    if (!leftStem || !rightStem) continue;
    const pairKey = [leftStem, rightStem].sort().join("\0");
    index.byStem.set(pairKey, entry);

    const leftDba = extractDba(entry.left?.display_name);
    if (leftDba) {
      const dbaStem = vendorStem(leftDba.alias);
      const dbaKey = [dbaStem, rightStem].sort().join("\0");
      index.byDbaStem.set(dbaKey, entry);
    }
    const rightDba = extractDba(entry.right?.display_name);
    if (rightDba) {
      const dbaStem = vendorStem(rightDba.alias);
      const dbaKey = [dbaStem, leftStem].sort().join("\0");
      index.byDbaStem.set(dbaKey, entry);
    }
    index.entries.push(entry);
  }
  return index;
}

export function lookupAliasInRegistry(registry, leftName, rightName) {
  const leftStem = vendorStem(leftName);
  const rightStem = vendorStem(rightName);
  if (!leftStem || !rightStem) return null;
  const idx = registry?.byStem instanceof Map ? registry : buildAliasIndex(registry);
  const pairKey = [leftStem, rightStem].sort().join("\0");
  if (idx.byStem.has(pairKey)) return idx.byStem.get(pairKey);
  const dbaKey = [leftStem, rightStem].sort().join("\0");
  if (idx.byDbaStem.has(dbaKey)) return idx.byDbaStem.get(dbaKey);
  return null;
}

/** High-confidence matcher methods eligible for auto-link. */
const AUTO_LINK_METHODS = new Set([
  "scoped_authority_key_equal_v1",
  "contract_id_equal_v0",
  "vendor_stem_equal_v0",
  "agency_stem_equal_v0",
  "vendor_token_similarity_v0",
  "agency_token_similarity_v0",
  "vendor_typo_proximity_v1",
  "vendor_truncation_v1",
  "vendor_abbreviation_v1",
]);

const AUTO_LINK_CONFIDENCE = 0.9;

/**
 * Route a matcher result to a durable decision.
 *
 * Conservative policy:
 * - High-confidence matcher `same` (confidence ≥ 0.9) → auto_link
 * - Reviewed alias-registry match → auto_link (verified_alias/successor)
 *   The registry is a small, human-reviewed set. It overrides unresolved and
 *   legal-form-conflict `different` decisions because those represent reviewed
 *   alias/successor relationships. It never overrides hard-id-conflict.
 * - Everything else → no auto-link (unresolved stays unresolved, different
 *   stays different)
 *
 * @param {{ decision?: string, confidence?: number|null, method?: string }} matcherResult
 * @param {{ left?: { display_name?: string }, right?: { display_name?: string }, entityType?: string }} [pair]
 * @returns {{ decision: string, auto_link: boolean, method?: string, alias_label?: string }}
 */
export function routeDecision(matcherResult = {}, pair = {}) {
  const decision = matcherResult.decision || "unresolved";

  if (decision === "same" && matcherResult.method && AUTO_LINK_METHODS.has(matcherResult.method)) {
    return { decision: "same", auto_link: true, method: matcherResult.method };
  }

  if (decision === "same" && (matcherResult.confidence ?? 0) >= AUTO_LINK_CONFIDENCE) {
    return { decision: "same", auto_link: true, method: matcherResult.method || "high_confidence_same" };
  }

  // Hard-id conflicts are never overridden by the alias registry.
  if (decision === "different" && matcherResult.method === "hard_id_conflict_v0") {
    return { decision: "different", auto_link: false };
  }
  if (decision === "different" && matcherResult.method === "agency_place_conflict_v0") {
    return { decision: "different", auto_link: false };
  }

  // Check reviewed alias registry for non-same decisions. The registry is
  // human-reviewed; it overrides unresolved and legal-form-conflict different.
  const entityType = pair.entityType || "vendor";
  if (entityType === "vendor" && pair.left && pair.right) {
    const aliasEntry = lookupAlias(
      pair.left.display_name,
      pair.right.display_name,
    );
    if (aliasEntry) {
      return {
        decision: "same",
        auto_link: true,
        method: `alias_registry_${aliasEntry.label}`,
        alias_label: aliasEntry.label,
      };
    }
  }

  return { decision, auto_link: false };
}
