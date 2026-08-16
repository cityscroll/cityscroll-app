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
  classifyVoteIdentity,
  measureOfficialVoteMetrics,
  normalizeVotePersonRow,
  officialEntityId,
  readVotePersonIdentity,
  readVoteValueLabel,
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
  extractDba,
  extractFeatures,
  normalizeHardIdentifier,
  pinEpinValues,
} from "./features/index.mjs";

export {
  MATCHERS_VERSION,
  scorePair,
} from "./matchers/index.mjs";

export {
  SCORER_CONTRACT_VERSION,
  SCORE_RESULT_SCHEMA_VERSION,
  createScorer,
  hashJson,
  pairId,
  scoreCandidatePairs,
  scorerIdentity,
  sha256,
  stableJson,
  conventionalV2Scorer,
} from "./scorers/index.mjs";

export {
  POLICIES_VERSION,
  buildAliasIndex,
  isAcceptedAliasEntry,
  lookupAlias,
  lookupAliasInRegistry,
  routeDecision,
} from "./policies/index.mjs";

export {
  loadGold,
  loadPredictions,
  loadCandidates,
  computeMetrics,
  predictWithMatcher,
  predictWithPipeline,
  GOLD_V0_PATH,
  GOLD_V1_PATH,
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
  CURATION_EFFECT_VERSION,
  CURATION_PROVISIONAL_STATE,
  CURATION_REVIEW_POLICY_VERSION,
  CURATION_VERDICT,
  CURATION_VERDICT_SCHEMA_VERSION,
  INVESTIGATION_WORKSPACE_VERSION,
  REVIEW_VERSION,
  REVIEW_DECISION,
  buildCurationVerdictReceipt,
  buildInvestigationWorkspace,
  projectCurationVerdictState,
  toReviewItem,
  toReviewItems,
} from "./review/index.mjs";

export {
  PROVENANCE_EDGE_TYPES,
  PROVENANCE_GRAPH_SCHEMA_VERSION,
  PROVENANCE_NODE_TYPES,
  PROVENANCE_PUBLIC_SCHEMA_VERSION,
  buildProvenanceGraph,
  provenanceForAssertion,
  publicProvenanceProjection,
  validateProvenanceGraph,
  versionedAssertionId,
  walkProvenance,
} from "./provenance_graph.mjs";

// Node-only alias proposal tooling is part of the package API, but must remain
// outside the Worker entrypoint graph. Keep this export explicit so a Worker
// import of the desk review helpers cannot pull filesystem dependencies into
// the production bundle.
export {
  ALIAS_ACCEPTED_STATUS,
  ALIAS_PROPOSAL_STATUS,
  ALIAS_PROPOSAL_PROMPT_VERSION,
  ALIAS_PROPOSAL_VERSION,
  ALIAS_REJECTED_STATUS,
  appendProposedAliases,
  buildAliasProposalPrompt,
  generateAliasProposals,
  parseAliasProposalResponse,
  promoteAliasProposal,
  readAliasRegistry,
  reviewAliasProposal,
} from "./review/llm_alias_proposals.mjs";

export {
  CROSS_DOMAIN_OBJECT_LINK_VERSION,
  CROSS_DOMAIN_METHOD,
  CROSS_DOMAIN_METHOD_VERSION,
  CROSS_DOMAIN_DOMAINS,
  CROSS_DOMAIN_LINK_TYPES,
  resolveAgencySubject,
  resolveVendorSubject,
  resolveRootQuery,
  makeProvenance,
  makeObjectLink,
  observationFromMoneyRow,
  observationFromLandRow,
  observationFromRulesRow,
  observationFromMeetingsRow,
  flattenRulesMaterializationRecord,
  flattenMeetingsMaterializationRecord,
  observationsFromRulesMaterialization,
  observationsFromMeetingsMaterialization,
  observationFromPeopleRow,
  observationsFromPeopleMaterialization,
  observationFromFranchise,
  observationFromFranchiseRow,
  observationsFromFranchiseMaterialization,
  linkObservation,
  buildEntityIntelligence,
  buildIntelligenceCorpus,
  lookupEntityIntelligence,
} from "./cross_domain/index.mjs";

export {
  CROSS_SPINE_EDGE_POLICY_SCHEMA,
  CROSS_SPINE_EDGE_POLICY_VERSION,
  CROSS_SPINE_MIN_HELD_OUT_PRECISION,
  CROSS_SPINE_MIN_HELD_OUT_SUPPORT,
  CROSS_SPINE_EDGE_TIERS,
  CROSS_SPINE_RELATION_POLICIES,
  DEFAULT_CROSS_SPINE_EDGE_POLICY,
  CROSS_SPINE_EDGE_POLICY_V1,
  canonicalCrossSpineRelation,
  crossSpineFeaturePasses,
  crossSpineRowFeatures,
  crossSpineEvidenceDecision,
  routeCrossSpineEdge,
  routeCrossSpineEdges,
  policyFromCrossSpineEval,
  checkCrossSpineEdgePolicy,
  promoteCrossSpineEdgePolicy,
  isCrossSpineCandidate,
} from "./cross_domain/edge_policy.mjs";

export {
  CERTIFIED_TO_AGENCY,
  CERTIFIED_TO_AGENCY_LABEL,
  CERTIFICATION_METHOD,
  CERTIFICATION_METHOD_VERSION,
  CERTIFICATION_SOURCE_DATASET,
  buildCertificationEdges,
  examSubjectRef,
  normalizeExamNumber,
} from "./exam_certifications/index.mjs";

export {
  AGENCY_HEAD_ENTITY_TYPE,
  PERSON_LEADER_ENTITY_TYPE,
  PERSON_LEADER_PRIMARY_KEY_PATTERN,
  PERSON_LEADER_RESOLUTION_METHOD,
  PERSON_LEADER_TYPE_FAMILY,
  buildAgencyHeadEntities,
  buildPersonLeaderEntity,
  personLeaderEntityId,
  resolveLeadershipReferent,
} from "./leaders/index.mjs";

export {
  resolveOpaqueReferent,
  resolveReferent,
} from "./referents/index.mjs";

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
  PUBLIC_LINK_CONFIDENCE_READER_LABELS,
  PUBLIC_LINK_CONFIDENCE_STATUSES,
  PUBLIC_LINK_CONFIDENCE_STRONG_MIN,
  PUBLIC_LINK_CONFIDENCE_VERSION,
  DESK_ONLY_ENTITY_RESOLUTION_FIELDS,
  measurePublicEntityLinkConfidenceRate,
  publicEntityLinkConfidence,
  readerLabelForLinkConfidence,
  serializePublicEntity,
  serializePublicEntityDossier,
  serializePublicEntityLink,
  serializePublicRelationshipGraph,
  summarizeLinkConfidence,
} from "./publication/index.mjs";
