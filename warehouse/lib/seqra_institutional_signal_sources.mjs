/**
 * SEQRA-07 institutional-signal source registry: the six adapters this card
 * delivers (Council, City Record, Community Board, agency, eLobbyist,
 * COELIG). Dataset ids and domains for the two SODA-backed sources are read
 * from the SEQRA-01 SODA source config
 * (warehouse/lib/seqra_soda_source_config.mjs) rather than re-declared, the
 * same convention warehouse/lib/seqra_structured_adapter_sources.mjs (SEQRA-03)
 * already established.
 *
 * `kind: "soda"` sources reuse the SEQRA-03 structured-adapter engine
 * (warehouse/lib/seqra_structured_adapter.mjs) directly. `kind:
 * "bounded_discovery_probe"` sources have no documented bulk API for a
 * SEQRA/CEQR-scoped query (Council/Legistar requires an application token
 * this workstream has not been issued; Community Board and agency records
 * are heterogeneous per-body web pages; COELIG's public search sits behind
 * an anti-bot interstitial) -- per the commission's negative rule, none of
 * these three is ever treated as a stable API. Their adapter is a single
 * bounded, polite reachability + structural-marker probe
 * (warehouse/lib/seqra_institutional_signal_adapter.mjs#buildDiscoveryProbeReceipt),
 * honestly recording what was and was not observable, never a population
 * count.
 */

import { SEQRA_SODA_SOURCE_CONFIG } from "./seqra_soda_source_config.mjs";

const SODA_PAGE_SIZE = 1000;
const SODA_MAX_PAGES = 200;

export const SEQRA_INSTITUTIONAL_SIGNAL_SOURCES = Object.freeze({
  nyc_council_legislative_records: Object.freeze({
    source_id: "nyc_council_legislative_records",
    source_name: "NYC Council legislative records",
    kind: "bounded_discovery_probe",
    base_url: "https://webapi.legistar.com/v1/nyc/matters",
    organization_type: "elected_official_office",
    required_markers: [],
    note:
      "Legistar exposes a documented API, but every request requires an application token this " +
      "workstream has not been issued (observed: HTTP 403 'Token is required'); a land-use/" +
      "environmental-review-scoped matter query remains undesigned. The discovery receipt records " +
      "reachability and the token requirement, never a matter count.",
  }),
  nyc_city_record_notices: Object.freeze({
    source_id: "nyc_city_record_notices",
    source_name: "NYC City Record Online (SEQRA/CEQR-relevant notice types)",
    kind: "soda",
    domain: SEQRA_SODA_SOURCE_CONFIG.nyc_city_record_corpus.domain,
    dataset_id: SEQRA_SODA_SOURCE_CONFIG.nyc_city_record_corpus.datasetId,
    order_field: ":id",
    page_size: SODA_PAGE_SIZE,
    max_pages: SODA_MAX_PAGES,
    organization_type: null, // agency_name varies per row; resolved per record, not fixed per source
    required_fields: Object.freeze(["request_id", "start_date", "agency_name", "type_of_notice_description", "short_title"]),
    note:
      "Whole-corpus SODA dataset (dg92-zbpx), queried directly rather than through the existing " +
      "City Record PIN-chain lookup (warehouse/lib/city_record_pin_chain_lookup.mjs, built for a " +
      "different purpose) so every count traces to its own fetch receipt. Not source-filtered to " +
      "environmental-review notice types by this registry entry; scoping a query is an adapter-time " +
      "concern, not a registry-time one.",
  }),
  community_board_positions: Object.freeze({
    source_id: "community_board_positions",
    source_name: "Community Board resolutions and vote records",
    kind: "bounded_discovery_probe",
    base_url: "https://www.nyc.gov/site/manhattancb3/minutes/meeting-vote-records.page",
    organization_type: "community_board",
    required_markers: Object.freeze(["votereso", "minutes"]),
    note:
      "No single documented interface across NYC's ~59 community boards (commission constraint); " +
      "each board publishes its own vote-record/minutes page. This entry probes one representative " +
      "board page for reachability and the presence of dated vote/minutes document links; per-board " +
      "discovery beyond this sample is out of this card's scope. See also the existing, broader " +
      "site/community_board_source_adapters.mjs, which this adapter's organization_type mapping " +
      "stays consistent with rather than duplicating.",
  }),
  agency_position_records: Object.freeze({
    source_id: "agency_position_records",
    source_name: "Agency (CPC, BSA, LPC, HPD, EDC, Borough President) position records",
    kind: "bounded_discovery_probe",
    base_url: "https://www.nyc.gov/site/planning/about/commission-meetings.page",
    organization_type: "government_agency",
    required_markers: Object.freeze(["commission"]),
    note:
      "Heterogeneous set of resolutions, recommendations, appeals, and conditions across multiple " +
      "discretionary-review bodies (commission constraint: no single documented interface). This " +
      "entry probes the City Planning Commission meetings page as the representative sample.",
  }),
  nyc_elobbyist: Object.freeze({
    source_id: "nyc_elobbyist",
    source_name: "NYC eLobbyist",
    kind: "soda",
    domain: SEQRA_SODA_SOURCE_CONFIG.nyc_elobbyist.domain,
    dataset_id: SEQRA_SODA_SOURCE_CONFIG.nyc_elobbyist.datasetId,
    order_field: ":id",
    page_size: SODA_PAGE_SIZE,
    max_pages: SODA_MAX_PAGES,
    organization_type: null, // client_name is a lobbying client of any type; never inferred from the name alone
    required_fields: Object.freeze(["client_id", "client_name", "lobbyist_name", "lobbyist_activities", "report_year", "start_date"]),
    note:
      "Dated institutional-activity context (a client retained a lobbyist to lobby on a described " +
      "activity), not a review population and not itself a support/oppose stance. Every position " +
      "built from this source carries the G3 suppression rule: lobbying activity is process evidence, " +
      "never a misconduct or motive label.",
  }),
  nys_coelig_lobbying: Object.freeze({
    source_id: "nys_coelig_lobbying",
    source_name: "NYS COELIG lobbying records",
    kind: "bounded_discovery_probe",
    base_url: "https://ethics.ny.gov/lobbying-data-0",
    organization_type: null,
    required_markers: [],
    note:
      "No documented bulk-download or API interface (commission constraint). The public search page " +
      "itself sits behind an automated-request interstitial (observed: HTTP 200 body is a bot-check " +
      "challenge page, not lobbying data) -- recorded honestly as 'reachable, content not fetchable ' " +
      "'by a bounded HTTP request' rather than parsed as if it were lobbying rows.",
  }),
});

export const SEQRA_INSTITUTIONAL_SIGNAL_SOURCE_IDS = Object.freeze(Object.keys(SEQRA_INSTITUTIONAL_SIGNAL_SOURCES));

export function getInstitutionalSignalSource(sourceId) {
  const entry = SEQRA_INSTITUTIONAL_SIGNAL_SOURCES[sourceId];
  if (!entry) throw new Error(`unknown SEQRA-07 institutional-signal source: ${sourceId}`);
  return entry;
}
