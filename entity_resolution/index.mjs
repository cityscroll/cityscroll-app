// entity_resolution — modular monolith package root (er-08).
//
// Semantic boundary for identity work inside the existing Worker/D1 deploy
// surface. Not an HTTP service. Import subpackages directly when possible;
// this root re-exports the stable public surface for tests and thin shims.

export {
  AUTHORITY_KEY_REGISTRY,
  AUTHORITY_KEY_REGISTRY_VERSION,
  authorityKeyId,
  authorityKeysForSide,
  parseAuthorityKey,
  sharedAuthorityKeys,
} from "./authority_keys/index.mjs";

export {
  VENDOR_STEM_METHOD,
  VENDOR_STEM_VERSION,
  VENDOR_SUFFIX,
  vendorStem,
  sameVendorStem,
  canonicalAgency,
  agencyCanonicalId,
  sameAgency,
  normalizeEntity,
} from "./normalizers/index.mjs";

export {
  CANDIDATE_GENERATION_VERSION,
  generateCandidates,
} from "./candidate_generation/index.mjs";

export {
  FEATURES_VERSION,
  contractIdValues,
  extractFeatures,
  normalizeHardIdentifier,
  pinEpinValues,
} from "./features/index.mjs";

export {
  MATCHERS_VERSION,
  scorePair,
} from "./matchers/index.mjs";

export {
  POLICIES_VERSION,
  routeDecision,
} from "./policies/index.mjs";

export {
  loadGold,
  loadPredictions,
  loadCandidates,
  computeMetrics,
  GOLD_V0_PATH,
  AUTHORITY_LABEL,
  AUTHORITY_VERSION,
  AUTHORITY_FIXTURE_V0_PATH,
  buildAuthorityReport,
  computeAuthorityMetrics,
  deriveAuthorityCases,
  latestSourceRecords,
  loadSourceRecords,
  predictAuthorityCases,
  CLERICAL_AUDIT_SCHEMA_VERSION,
  buildClericalAudit,
  formatAuditJsonl,
  formatLabelSheet,
  parseLabelSheet,
  promoteLabelsToGold,
} from "./evaluation/index.mjs";

export {
  REVIEW_VERSION,
  REVIEW_DECISION,
  toReviewItem,
  toReviewItems,
} from "./review/index.mjs";
