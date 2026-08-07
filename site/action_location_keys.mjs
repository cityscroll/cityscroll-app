/**
 * Lightweight action-location facet vocabulary shared by scope parsing and
 * the response-address implementation.
 *
 * Keep this module free of address parsing and district dependencies. Near-you
 * links are part of the home cold path and only need the vocabulary.
 */

export const ACTION_LOCATION_FACET_KEYS = Object.freeze([
  "contract_action_address",
  "submission_address",
  "pre_bid_venue",
  "document_pickup",
]);
