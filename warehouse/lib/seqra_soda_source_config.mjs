/**
 * Query configuration for the seven Tier-1 sources this card profiles live
 * over the Socrata SODA API. Each source declares its own breakdown fields
 * because the publishers do not share one schema; a field absent from a
 * source is `not_applicable` in the profile, never zero.
 *
 * `dedupeKeyFields` is the candidate natural key used for the duplicate-key
 * measurement query. It is a documented candidate, not an asserted identity
 * key -- this inventory measures duplication, it does not perform an
 * identity join (see warehouse/lib/ceqr_project_milestone_reconciliation.mjs
 * for the existing exact-key CEQR join).
 */

export const SEQRA_SODA_SOURCE_CONFIG = Object.freeze({
  ceqr_projects: {
    domain: "data.cityofnewyork.us",
    datasetId: "gezn-7mgk",
    dedupeKeyFields: ["ceqr"],
    dateField: null,
    yearField: null,
    agencyField: "lead_agency",
    eventTypeField: null,
    reviewStatusField: null,
    regimeLabelField: null,
    missingnessFields: ["ceqr", "lead_agency", "project_name"],
  },
  ceqr_project_milestones: {
    domain: "data.cityofnewyork.us",
    datasetId: "8fj8-3sgg",
    dedupeKeyFields: ["ceqr", "milestone_name", "milestone_date"],
    dateField: "milestone_date",
    yearField: "milestone_date",
    agencyField: null,
    eventTypeField: "milestone_name",
    reviewStatusField: null,
    regimeLabelField: null,
    missingnessFields: ["ceqr", "milestone_name", "milestone_date"],
  },
  zap_projects: {
    domain: "data.cityofnewyork.us",
    datasetId: "hgx4-8ukb",
    dedupeKeyFields: ["project_id"],
    dateField: "app_filed_date",
    yearField: "app_filed_date",
    agencyField: "ceqr_leadagency",
    eventTypeField: "current_envmilestone",
    reviewStatusField: "project_status",
    regimeLabelField: "ceqr_type",
    missingnessFields: ["project_id", "ceqr_number", "ceqr_leadagency", "current_envmilestone", "project_status"],
  },
  zap_bbl: {
    domain: "data.cityofnewyork.us",
    datasetId: "2iga-a6mk",
    dedupeKeyFields: ["project_id", "bbl"],
    dateField: "validated_date",
    yearField: null,
    agencyField: null,
    eventTypeField: null,
    reviewStatusField: null,
    regimeLabelField: null,
    missingnessFields: ["project_id", "bbl"],
  },
  nys_dec_dart: {
    domain: "data.ny.gov",
    datasetId: "mbk7-f2r2",
    dedupeKeyFields: ["application_id"],
    dateField: "date_received",
    yearField: "date_received",
    agencyField: "lead_agency",
    eventTypeField: "permit_type",
    reviewStatusField: "seqr_determination",
    regimeLabelField: "seqr_class",
    missingnessFields: ["application_id", "seqr_class", "seqr_determination", "lead_agency"],
  },
  nyc_elobbyist: {
    domain: "data.cityofnewyork.us",
    datasetId: "fmf3-knd8",
    dedupeKeyFields: ["client_id", "lobbyist_id", "periodic_id"],
    dateField: null,
    yearField: "report_year",
    agencyField: null,
    eventTypeField: null,
    reviewStatusField: null,
    regimeLabelField: null,
    missingnessFields: ["client_id", "lobbyist_id", "report_year"],
  },
  nyc_city_record_corpus: {
    domain: "data.cityofnewyork.us",
    datasetId: "dg92-zbpx",
    dedupeKeyFields: ["request_id"],
    dateField: "start_date",
    yearField: "start_date",
    agencyField: "agency_name",
    eventTypeField: "type_of_notice_description",
    reviewStatusField: null,
    regimeLabelField: null,
    missingnessFields: ["request_id", "agency_name", "type_of_notice_description", "start_date"],
  },
});

export const SEQRA_SODA_SOURCE_IDS = Object.freeze(Object.keys(SEQRA_SODA_SOURCE_CONFIG));
