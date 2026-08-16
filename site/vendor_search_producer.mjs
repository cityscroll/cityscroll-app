/** Canonical Vendor SearchDocuments from the cross-domain entity read model. */

import { vendorStem } from "../entity_resolution/normalizers/vendor_stem.mjs";
import { isAcceptedAliasEntry } from "../entity_resolution/policies/index.mjs";
import { rankSearchDocuments, SEARCH_TEXT_MAX_LENGTH } from "./search_document_contract.mjs";
import {
  admitProjectedSearchDocument,
  cleanSearchText,
  failedSearchProjection,
  freezeSearchValue,
  searchProducerCorpus,
  unavailableSearchProducerCorpus,
  uniqueSearchText,
} from "./search_producer_support.mjs";

export const VENDOR_SEARCH_PRODUCER_SCHEMA = "cityscroll.vendor_search_producer.v1";
export const VENDOR_SEARCH_PRODUCER = "vendor_search_document.v1";
const READ_MODEL_VERSION = "cross_domain_object_link_v2";

function identityFor(refValue, dossier = {}) {
  const ref = cleanSearchText(refValue, 320);
  const root = dossier?.root || {};
  const stem = cleanSearchText(root.stem, 240);
  const expected = stem ? `vendor:stem:${encodeURIComponent(stem)}` : "";
  if (!stem || ref !== expected || root.ref !== ref || root.kind !== "vendor") return null;
  return { ref, stem, href: `/vendors/${encodeURIComponent(stem)}/` };
}

function reviewedAliases(stem, registry = {}) {
  const aliases = [];
  const receipts = [];
  for (const entry of Array.isArray(registry?.entries) ? registry.entries : []) {
    if (!isAcceptedAliasEntry(entry)) continue;
    const left = cleanSearchText(entry.left?.display_name, 500);
    const right = cleanSearchText(entry.right?.display_name, 500);
    const leftStem = vendorStem(left);
    const rightStem = vendorStem(right);
    const alias = leftStem === stem && rightStem !== stem
      ? right
      : rightStem === stem && leftStem !== stem
        ? left
        : null;
    if (!alias) continue;
    aliases.push(alias);
    receipts.push({
      id: cleanSearchText(entry.id, 120) || null,
      label: cleanSearchText(entry.label, 80) || "verified_alias",
      reviewed_date: cleanSearchText(entry.reviewed_date, 40) || null,
    });
  }
  return {
    aliases: uniqueSearchText(aliases),
    receipts,
  };
}

function evidenceFor(ref, dossier = {}) {
  return uniqueSearchText((Array.isArray(dossier.links) ? dossier.links : [])
    .filter((link) => link?.to === ref && link?.confidence === "strong")
    .map((link) => link?.provenance?.source_record_id), 240).slice(0, 100);
}

export function projectVendorSearchDocument(ref, dossier = {}, options = {}) {
  const lookup = options.lookup || {};
  if (lookup.schema_version !== 1 || lookup.version !== READ_MODEL_VERSION) {
    return failedSearchProjection("not_indexed", "unsupported_vendor_read_model", ["read_model"]);
  }
  const identity = identityFor(ref, dossier);
  if (!identity) {
    return failedSearchProjection("unclassified", "unresolved_exact_vendor_identity", ["object_ref"]);
  }
  const title = cleanSearchText(dossier.root?.display_name, 500);
  if (!title || vendorStem(title) !== identity.stem) {
    return failedSearchProjection("unclassified", "vendor_display_name_does_not_resolve_to_stem", ["title"]);
  }
  const refs = evidenceFor(identity.ref, dossier);
  if (!refs.length) {
    return failedSearchProjection("not_indexed", "missing_vendor_source_observation", ["source_observation_refs"]);
  }
  const aliases = reviewedAliases(identity.stem, options.aliasRegistry);
  const matchedDomains = Object.entries(dossier.domains || {})
    .filter(([, value]) => value?.status === "matched")
    .map(([domain]) => domain);
  const searchText = uniqueSearchText([
    title,
    identity.stem,
    ...aliases.aliases,
    ...matchedDomains,
  ]).join(" ").slice(0, SEARCH_TEXT_MAX_LENGTH);

  return admitProjectedSearchDocument({
    object_ref: identity.ref,
    object_type: "vendor",
    domain: "contracts",
    canonical_href: identity.href,
    title,
    summary: matchedDomains.length
      ? `Vendor with linked public records in ${matchedDomains.join(", ")}.`
      : "Vendor identified in public procurement records.",
    search_text: searchText,
    source_family: "cross_domain_entity_intelligence",
    source_observation_refs: refs,
    process_role: null,
    classification: {
      method: "canonical_vendor_read_model",
      basis: "exact vendor stem identity in cross_domain_object_link_v2; reviewed aliases only",
    },
    provenance: {
      producer: VENDOR_SEARCH_PRODUCER,
      read_model_version: lookup.version,
      read_model_generated_at: lookup.generated_at || null,
      identity_method: "vendor_stem_v1",
      identity_state: "resolved",
      reviewed_aliases: aliases.aliases,
      alias_receipts: aliases.receipts,
      matched_domains: matchedDomains,
      source_receipts: (dossier.links || [])
        .filter((link) => link?.to === identity.ref && link?.confidence === "strong")
        .map((link) => ({
          relation: link.type || null,
          method: link.method || null,
          source_system: link.provenance?.source_system || null,
          source_record_id: link.provenance?.source_record_id || null,
          observed_at: link.provenance?.observed_at || null,
        })),
    },
  }, "exact_vendor_stem_identity");
}

export function buildVendorSearchDocuments(lookup = {}, options = {}) {
  if (lookup.schema_version !== 1 || lookup.version !== READ_MODEL_VERSION
    || !lookup.by_ref || typeof lookup.by_ref !== "object" || Array.isArray(lookup.by_ref)) {
    return unavailableSearchProducerCorpus({
      schema: VENDOR_SEARCH_PRODUCER_SCHEMA,
      producer: VENDOR_SEARCH_PRODUCER,
      objectType: "vendor",
      domain: "contracts",
      reason: "unsupported_vendor_read_model",
    });
  }
  const rows = (Array.isArray(lookup.entity_index) ? lookup.entity_index : [])
    .filter((row) => row?.kind === "vendor")
    .sort((left, right) => String(left.ref).localeCompare(String(right.ref), "en-US"));
  const outcomes = rows.map((row) => freezeSearchValue({
    entity_ref: row.ref,
    ...projectVendorSearchDocument(row.ref, lookup.by_ref[row.ref], { ...options, lookup }),
  }));
  return searchProducerCorpus({
    schema: VENDOR_SEARCH_PRODUCER_SCHEMA,
    producer: VENDOR_SEARCH_PRODUCER,
    objectType: "vendor",
    domain: "contracts",
    outcomes,
    reasons: {
      matched: "vendor_read_model_indexed",
      empty: "vendor_read_model_has_no_entries",
      partial: "some_vendor_entries_failed_admission",
      not_indexed: "no_vendor_entries_passed_admission",
    },
  });
}

export function rankVendorSearchDocuments(documents = [], query = "", { limit = 40 } = {}) {
  const needle = cleanSearchText(query, 240).toLocaleLowerCase("en-US");
  if (!needle || !Array.isArray(documents)) return Object.freeze([]);
  const tokens = needle.split(/\s+/).filter(Boolean);
  const matches = documents.filter((document) => {
    const haystack = cleanSearchText(document?.search_text, SEARCH_TEXT_MAX_LENGTH)
      .toLocaleLowerCase("en-US");
    return tokens.every((token) => haystack.includes(token));
  });
  return Object.freeze(rankSearchDocuments(matches, (document) => {
    const title = document.title.toLocaleLowerCase("en-US");
    const aliases = (document.provenance?.reviewed_aliases || [])
      .map((alias) => alias.toLocaleLowerCase("en-US"));
    return title === needle ? 100 : aliases.includes(needle) ? 90 : title.startsWith(needle) ? 80 : 20;
  }).slice(0, Math.max(0, Number(limit) || 0)));
}
