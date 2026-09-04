/**
 * SEQRA-06 fixture: one project whose single original BBL is subdivided
 * partway through its review, plus per-layer vintage series (PLUTO, zoning,
 * receptor, environmental-site, disadvantaged-community, flood) and DOB/
 * ACRIS implementation events tied to its determination.
 *
 * Synthetic identity/shape example built to exercise the BBL-history,
 * layer-vintage, and implementation/remedy-exposure primitives -- not a
 * claim about a real project or a real publisher release.
 */
import { buildDeterminationKey } from "../../lib/seqra_stable_keys.mjs";

export const PROJECT_KEY = "project:zap:sample-spatial-001";
export const ORIGINAL_BBL = "3099990010";
export const SUBDIVIDED_BBL_A = "3099990020";
export const SUBDIVIDED_BBL_B = "3099990030";
export const SUBDIVISION_DATE = "2020-06-01";

export const DETERMINATION_KEY = buildDeterminationKey({
  agency: "DCP",
  actionId: "N-2019-0100",
  date: "2019-11-15",
});
export const DETERMINATION_DATE = "2019-11-15";

/** Lot-change events for seqra_bbl_lot_history.mjs#buildProjectBblHistory. */
export const SAMPLE_LOT_CHANGE_EVENTS = Object.freeze([
  {
    event_type: "subdivision",
    effective_date: SUBDIVISION_DATE,
    from_bbls: [ORIGINAL_BBL],
    to_bbls: [SUBDIVIDED_BBL_A, SUBDIVIDED_BBL_B],
    source_id: "acris",
    source_record_id: "SUBDIV-2020-0007",
  },
]);

export const SAMPLE_PROJECT_INITIAL_DATE = "2018-03-01";

/**
 * Per-layer vintage series. `pluto` deliberately has no vintage covering
 * anything before 2019-01-01 for the original BBL, so a cutoff of
 * 2018-06-01 exercises the refused-join/coverage-gap path (A5); every other
 * layer/BBL combination has continuous coverage across the fixture's cutoffs.
 */
export function sampleLayerRegistry() {
  return {
    pluto: {
      vintages: [
        { vintage: "19v1", effective_start: "2019-01-01", effective_end: "2020-01-01" },
        { vintage: "20v1", effective_start: "2020-01-01", effective_end: "2021-01-01" },
        { vintage: "21v1", effective_start: "2021-01-01", effective_end: null },
      ],
      layerValuesByVintage: {
        "19v1": { [ORIGINAL_BBL]: { zoning_district: "M1-1", lot_area_sqft: 20000 } },
        "20v1": { [ORIGINAL_BBL]: { zoning_district: "M1-1", lot_area_sqft: 20000 } },
        "21v1": {
          [SUBDIVIDED_BBL_A]: { zoning_district: "M1-1", lot_area_sqft: 12000 },
          [SUBDIVIDED_BBL_B]: { zoning_district: "M1-1", lot_area_sqft: 8000 },
        },
      },
    },
    zoning: {
      vintages: [
        { vintage: "zr-2017-09", effective_start: "2017-09-21", effective_end: "2021-04-20" },
        { vintage: "zr-2021-04", effective_start: "2021-04-20", effective_end: null },
      ],
      layerValuesByVintage: {
        "zr-2017-09": {
          [ORIGINAL_BBL]: { district: "M1-1" },
          [SUBDIVIDED_BBL_A]: { district: "M1-1" },
          [SUBDIVIDED_BBL_B]: { district: "M1-1" },
        },
        "zr-2021-04": {
          [SUBDIVIDED_BBL_A]: { district: "M1-1/R7A" },
          [SUBDIVIDED_BBL_B]: { district: "M1-1/R7A" },
        },
      },
    },
    receptor: {
      vintages: [{ vintage: "receptor-2019", effective_start: "2017-01-01", effective_end: null }],
      layerValuesByVintage: {
        "receptor-2019": {
          [ORIGINAL_BBL]: { nearest_school_ft: 450 },
          [SUBDIVIDED_BBL_A]: { nearest_school_ft: 420 },
          [SUBDIVIDED_BBL_B]: { nearest_school_ft: 500 },
        },
      },
    },
    environmental_site: {
      vintages: [{ vintage: "dec-remediation-2020", effective_start: "2020-01-01", effective_end: null }],
      layerValuesByVintage: {
        "dec-remediation-2020": {
          [SUBDIVIDED_BBL_A]: { remediation_site: false },
          [SUBDIVIDED_BBL_B]: { remediation_site: false },
        },
      },
    },
    disadvantaged_community: {
      vintages: [{ vintage: "dac-2023", effective_start: "2023-01-01", effective_end: null }],
      layerValuesByVintage: {
        "dac-2023": {
          [SUBDIVIDED_BBL_A]: { disadvantaged: true },
          [SUBDIVIDED_BBL_B]: { disadvantaged: true },
        },
      },
    },
    flood: {
      vintages: [
        { vintage: "fema-2015", effective_start: "2015-01-01", effective_end: "2022-01-01" },
        { vintage: "fema-2022", effective_start: "2022-01-01", effective_end: null },
      ],
      layerValuesByVintage: {
        "fema-2015": {
          [ORIGINAL_BBL]: { flood_zone: "X" },
          [SUBDIVIDED_BBL_A]: { flood_zone: "X" },
          [SUBDIVIDED_BBL_B]: { flood_zone: "X" },
        },
        "fema-2022": {
          [SUBDIVIDED_BBL_A]: { flood_zone: "AE" },
          [SUBDIVIDED_BBL_B]: { flood_zone: "X" },
        },
      },
    },
  };
}

/** Raw DOB/ACRIS implementation events, unattributed, for buildImplementationEvent. */
export const SAMPLE_IMPLEMENTATION_EVENTS_RAW = Object.freeze([
  {
    sourceSystem: "dob_now",
    sourceEventId: "JA-2019-000100",
    eventType: "dob_job_application_filed",
    eventDate: "2019-12-02",
    bbl: SUBDIVIDED_BBL_A,
    observedAt: "2019-12-03T00:00:00.000Z",
    sourceId: "dob_now_job_applications",
    sourceRecordId: "JA-2019-000100",
  },
  {
    sourceSystem: "dob_now",
    sourceEventId: "PE-2020-000200",
    eventType: "dob_permit_issued",
    eventDate: "2020-08-14",
    bbl: SUBDIVIDED_BBL_A,
    observedAt: "2020-08-15T00:00:00.000Z",
    sourceId: "dob_now_approved_permits",
    sourceRecordId: "PE-2020-000200",
  },
  {
    sourceSystem: "acris",
    sourceEventId: "2020091500123001",
    eventType: "acris_document_recorded",
    eventDate: "2020-09-15",
    bbl: SUBDIVIDED_BBL_B,
    observedAt: "2020-09-16T00:00:00.000Z",
    sourceId: "acris_property_records",
    sourceRecordId: "2020091500123001",
  },
  {
    sourceSystem: "dob_now",
    sourceEventId: "TCO-2022-000300",
    eventType: "dob_temporary_certificate_of_occupancy",
    eventDate: "2022-03-01",
    bbl: SUBDIVIDED_BBL_A,
    observedAt: "2022-03-02T00:00:00.000Z",
    sourceId: "dob_now_approved_permits",
    sourceRecordId: "TCO-2022-000300",
  },
  // Filed before the determination -- must stay unattributed, never joined.
  {
    sourceSystem: "dob_now",
    sourceEventId: "JA-2019-000050",
    eventType: "dob_job_application_filed",
    eventDate: "2019-05-01",
    bbl: ORIGINAL_BBL,
    observedAt: "2019-05-02T00:00:00.000Z",
    sourceId: "dob_now_job_applications",
    sourceRecordId: "JA-2019-000050",
  },
]);
