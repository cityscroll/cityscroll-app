/**
 * SEQRA-03 adapter registry: the six sources this card delivers incremental
 * adapters for, with the field lists each adapter depends on and the paging
 * shape of its interface. Dataset ids and domains are read from the SEQRA-01
 * SODA source config (warehouse/lib/seqra_soda_source_config.mjs) rather than
 * re-declared, so the two cards can never register a different dataset id for
 * the same source. Required field lists reuse the constants the existing
 * ZAP/CEQR projection and reconciliation modules already depend on
 * (warehouse/lib/zap_environmental_projection.mjs,
 * warehouse/lib/ceqr_project_milestone_reconciliation.mjs,
 * warehouse/lib/zap_bbl_lookup.mjs) instead of re-typing a second, driftable
 * copy of each publisher's column names.
 *
 * `kind: "soda"` sources are walked as Socrata SODA JSON pages ordered by the
 * publisher's stable `:id` column. `kind: "html_discovery"` is the DEC
 * Environmental Notice Bulletin: a public search page, not a documented API
 * (see warehouse/lib/seqra_dec_enb_notice_parser.mjs and the commission's
 * negative rule against treating a website as a stable API without a
 * discovery receipt). Its `max_pages` bound is deliberately small: the ENB
 * listing is a rolling/historical archive of 10,000+ notices, not a bounded
 * Tier-1 table, so a capped walk marks `pagination_complete: false` and
 * records the total instead of throwing the way the SODA sources do.
 */

import { CEQR_MILESTONE_SOURCE_FIELDS, CEQR_PROJECT_SOURCE_FIELDS } from "./ceqr_project_milestone_reconciliation.mjs";
import { ZAP_ENVIRONMENTAL_SOURCE_COLS } from "./zap_environmental_projection.mjs";
import { ZAP_BBL_SELECT_COLS } from "./zap_bbl_lookup.mjs";
import { SEQRA_SODA_SOURCE_CONFIG } from "./seqra_soda_source_config.mjs";

const SODA_PAGE_SIZE = 1000;
const SODA_MAX_PAGES = 200; // 200k rows -- well above every Tier-1 source's measured population

export const SEQRA_STRUCTURED_ADAPTER_SOURCES = Object.freeze({
  ceqr_projects: Object.freeze({
    source_id: "ceqr_projects",
    source_name: "CEQR Projects",
    kind: "soda",
    domain: SEQRA_SODA_SOURCE_CONFIG.ceqr_projects.domain,
    dataset_id: SEQRA_SODA_SOURCE_CONFIG.ceqr_projects.datasetId,
    order_field: ":id",
    page_size: SODA_PAGE_SIZE,
    max_pages: SODA_MAX_PAGES,
    required_fields: CEQR_PROJECT_SOURCE_FIELDS,
  }),
  ceqr_project_milestones: Object.freeze({
    source_id: "ceqr_project_milestones",
    source_name: "CEQR Project Milestones",
    kind: "soda",
    domain: SEQRA_SODA_SOURCE_CONFIG.ceqr_project_milestones.domain,
    dataset_id: SEQRA_SODA_SOURCE_CONFIG.ceqr_project_milestones.datasetId,
    order_field: ":id",
    page_size: SODA_PAGE_SIZE,
    max_pages: SODA_MAX_PAGES,
    required_fields: CEQR_MILESTONE_SOURCE_FIELDS,
  }),
  zap_projects: Object.freeze({
    source_id: "zap_projects",
    source_name: "ZAP Projects",
    kind: "soda",
    domain: SEQRA_SODA_SOURCE_CONFIG.zap_projects.domain,
    dataset_id: SEQRA_SODA_SOURCE_CONFIG.zap_projects.datasetId,
    order_field: ":id",
    page_size: SODA_PAGE_SIZE,
    max_pages: SODA_MAX_PAGES,
    required_fields: Object.freeze(["project_id", ...ZAP_ENVIRONMENTAL_SOURCE_COLS]),
  }),
  zap_bbl: Object.freeze({
    source_id: "zap_bbl",
    source_name: "ZAP BBL",
    kind: "soda",
    domain: SEQRA_SODA_SOURCE_CONFIG.zap_bbl.domain,
    dataset_id: SEQRA_SODA_SOURCE_CONFIG.zap_bbl.datasetId,
    order_field: ":id",
    page_size: SODA_PAGE_SIZE,
    max_pages: SODA_MAX_PAGES,
    required_fields: ZAP_BBL_SELECT_COLS,
  }),
  nys_dec_dart: Object.freeze({
    source_id: "nys_dec_dart",
    source_name: "NYS DEC DART (Department Application Review and Tracking)",
    kind: "soda",
    domain: SEQRA_SODA_SOURCE_CONFIG.nys_dec_dart.domain,
    dataset_id: SEQRA_SODA_SOURCE_CONFIG.nys_dec_dart.datasetId,
    order_field: ":id",
    page_size: SODA_PAGE_SIZE,
    max_pages: SODA_MAX_PAGES,
    required_fields: Object.freeze([
      "application_id",
      "date_received",
      "lead_agency",
      "permit_type",
      "seqr_determination",
      "seqr_class",
    ]),
  }),
  nys_dec_enb_notice_metadata: Object.freeze({
    source_id: "nys_dec_enb_notice_metadata",
    source_name: "NYS DEC Environmental Notice Bulletin (notice metadata)",
    kind: "html_discovery",
    base_url: "https://dec.ny.gov/news/environmental-notice-bulletin",
    page_size: 50, // the publisher's own per-page count, observed via the discovery receipt -- not a CityScroll choice
    max_pages: 3, // bounded by design; see module docstring
    required_fields: Object.freeze(["title", "url", "publish_date", "region_or_county", "notice_type"]),
  }),
});

export const SEQRA_STRUCTURED_ADAPTER_SOURCE_IDS = Object.freeze(Object.keys(SEQRA_STRUCTURED_ADAPTER_SOURCES));

export function getStructuredAdapterSource(sourceId) {
  const entry = SEQRA_STRUCTURED_ADAPTER_SOURCES[sourceId];
  if (!entry) throw new Error(`unknown SEQRA-03 adapter source: ${sourceId}`);
  return entry;
}
