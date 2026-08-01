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
  ENTITY_TYPE_FAMILIES,
  OFFICIAL_ENTITY_TYPE,
  OFFICIAL_PRIMARY_KEY_PATTERN,
  OFFICIAL_TYPE_FAMILY,
  VOTES_ON_LINK_TYPE,
  buildVotesOnEdges,
  measureOfficialVoteMetrics,
  normalizeVotePersonRow,
  officialEntityId,
  summarizePersonVotes,
  voteBucket,
} from "./officials/index.mjs";

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
  DEFAULT_MONITOR_WINDOW_DAYS,
  DEFAULT_SOURCE_STALE_AFTER_DAYS,
  SHADOW_MONITOR_SCHEMA_VERSION,
  SHADOW_MONITOR_VERSION,
  buildShadowMonitorReceipt,
  compareShadowMonitorReceipts,
} from "./evaluation/index.mjs";

export {
  INVESTIGATION_WORKSPACE_VERSION,
  REVIEW_VERSION,
  REVIEW_DECISION,
  buildInvestigationWorkspace,
  toReviewItem,
  toReviewItems,
} from "./review/index.mjs";

export {
  PUBLICATION_VERSION,
  PUBLIC_ENTITY_FIELDS,
  PUBLIC_ENTITY_LINK_FIELDS,
  PUBLIC_DOSSIER_FACT_DEFINITIONS,
  PUBLIC_DOSSIER_VERSION,
  PUBLIC_GRAPH_DEFAULT_DEPTH,
  PUBLIC_GRAPH_DEFAULT_FAN_OUT,
  PUBLIC_GRAPH_EDGE_LABELS,
  PUBLIC_GRAPH_EDGE_TYPES,
  PUBLIC_GRAPH_MAX_DEPTH,
  PUBLIC_GRAPH_MAX_FAN_OUT,
  PUBLIC_GRAPH_NODE_TYPES,
  PUBLIC_RELATIONSHIP_GRAPH_VERSION,
  DESK_ONLY_ENTITY_RESOLUTION_FIELDS,
  serializePublicEntity,
  serializePublicEntityDossier,
  serializePublicEntityLink,
  serializePublicRelationshipGraph,
} from "./publication/index.mjs";
