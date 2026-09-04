/**
 * SEQRA-02 ontology fixture: one project requiring two government actions
 * across two BBLs, each action carrying its own environmental review -- one
 * NYC CEQR review, one state-led NYS SEQRA review under a different lead
 * agency -- plus one organization taking a position on the CEQR review.
 *
 * This is a synthetic identity/relationship-shape example built to exercise
 * the stable-key functions and the relation-integrity validator. It is not a
 * claim about a real project; no adapter has populated any of these keys
 * from a live source.
 */

import { buildActionKey, buildEnvironmentalReviewKey } from "../../lib/seqra_stable_keys.mjs";

const PROJECT_KEY = "project:zap:sample-multi-bbl-001";

const ACTION_REZONING = buildActionKey({ agency: "dcp", sourceSystem: "zap", sourceActionId: "N-2026-0001" });
const ACTION_STATE_PERMIT = buildActionKey({ agency: "dec", sourceSystem: "dart", sourceActionId: "APP-2026-0002" });

const REVIEW_CEQR = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "26DCP001X" });
const REVIEW_SEQRA = buildEnvironmentalReviewKey({
  environmentalRegime: "SEQRA",
  leadAgency: "NYS Department of Environmental Conservation",
  sourceReviewId: "APP-2026-0002",
});

export const SAMPLE_MULTI_BBL_PROJECT_GRAPH = Object.freeze({
  project: [
    {
      project_key: PROJECT_KEY,
      title: "Sample two-lot rezoning and state permit fixture",
      source_system: "zap",
      source_project_id: "sample-multi-bbl-001",
      bbl_list: ["3012340001", "3012340002"],
      borough: "Brooklyn",
      observed_at: "2026-01-05T00:00:00.000Z",
      source_id: "zap_projects",
      source_record_id: "sample-multi-bbl-001",
    },
  ],
  government_action: [
    {
      action_key: ACTION_REZONING,
      project_key: PROJECT_KEY,
      agency: "DCP",
      source_system: "zap",
      source_action_id: "N-2026-0001",
      action_type: "zoning_map_amendment",
      observed_at: "2026-01-05T00:00:00.000Z",
      source_id: "zap_projects",
      source_record_id: "N-2026-0001",
    },
    {
      action_key: ACTION_STATE_PERMIT,
      project_key: PROJECT_KEY,
      agency: "DEC",
      source_system: "dart",
      source_action_id: "APP-2026-0002",
      action_type: "state_permit",
      observed_at: "2026-01-06T00:00:00.000Z",
      source_id: "nys_dec_dart",
      source_record_id: "APP-2026-0002",
    },
  ],
  environmental_review: [
    {
      review_key: REVIEW_CEQR,
      action_key: ACTION_REZONING,
      jurisdiction_level: "NYC",
      environmental_regime: "CEQR",
      review_label_as_published: "CEQR",
      judicial_review_regime: "NY_ARTICLE_78",
      lead_agency: "DCP",
      ceqr_number: "26DCP001X",
      source_review_id: null,
      observed_at: "2026-01-05T00:00:00.000Z",
      source_id: "ceqr_projects",
      source_record_id: "26DCP001X",
    },
    {
      review_key: REVIEW_SEQRA,
      action_key: ACTION_STATE_PERMIT,
      jurisdiction_level: "NYS",
      environmental_regime: "SEQRA",
      review_label_as_published: "SEQR",
      judicial_review_regime: "NY_ARTICLE_78",
      lead_agency: "NYS Department of Environmental Conservation",
      ceqr_number: null,
      source_review_id: "APP-2026-0002",
      observed_at: "2026-01-06T00:00:00.000Z",
      source_id: "nys_dec_dart",
      source_record_id: "APP-2026-0002",
    },
  ],
  organization: [
    {
      organization_key: "organization:community_board:cb6_brooklyn",
      name: "Brooklyn Community Board 6",
      organization_type: "community_board",
      observed_at: "2026-02-01T00:00:00.000Z",
      source_id: "city_record",
      source_record_id: "cb6-resolution-2026-02",
    },
  ],
  public_position: [
    {
      position_key: "public_position:cb6:26DCP001X:2026-02-01",
      organization_key: "organization:community_board:cb6_brooklyn",
      review_key: REVIEW_CEQR,
      position: "conditional",
      named_issue: "requested a shadow study of the adjacent playground",
      observed_at: "2026-02-01T00:00:00.000Z",
      available_to_public_at: "2026-02-03T00:00:00.000Z",
      source_id: "city_record",
      source_record_id: "cb6-resolution-2026-02",
      source_vintage: "2026-02-01",
      evidence: "CB6 resolution, section 3",
      confidence: 0.95,
      rival_explanation: null,
      suppression_rule: null,
    },
  ],
});

export const SAMPLE_MULTI_BBL_PROJECT_KEYS = Object.freeze({
  PROJECT_KEY,
  ACTION_REZONING,
  ACTION_STATE_PERMIT,
  REVIEW_CEQR,
  REVIEW_SEQRA,
});
