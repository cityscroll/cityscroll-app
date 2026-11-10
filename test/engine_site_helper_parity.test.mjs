/**
 * Engine (capabilities/) and browser (site/) keep separate copies of the same
 * pure helpers so the static surface never imports across the engine boundary.
 * This test fails when representative outputs diverge between those copies.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as engineIdentity from "../capabilities/procurement_identity_key.mjs";
import * as siteIdentity from "../site/procurement_identity_key.mjs";
import * as engineHref from "../capabilities/procurement_canonical_href.mjs";
import * as siteHref from "../site/procurement_route.mjs";
import * as engineAvailability from "../capabilities/meeting_availability.mjs";
import * as siteAvailability from "../site/meeting_availability_filter.mjs";
import * as engineAttendance from "../capabilities/meetings_attendance.mjs";
import * as siteAttendance from "../site/meetings_attendance.mjs";
import * as engineProcess from "../capabilities/meeting_process_profile.mjs";
import * as siteProcess from "../site/meeting_process_profile.mjs";
import * as engineAnalytical from "../capabilities/analytical_projection.mjs";
import * as siteAnalytical from "../site/analytical_projection.mjs";
import * as engineContractsProjection from "../capabilities/contracts_analysis_projection.mjs";
import * as siteContractsProjection from "../site/contracts_analysis_projection.mjs";
import * as engineDetailIndex from "../capabilities/procurement_detail_index.mjs";
import * as siteDetailIndex from "../site/procurement_detail_index.mjs";
import * as engineBrowseRead from "../capabilities/procurement_browse_capability_read.mjs";
import * as siteBrowse from "../site/procurement_browse_capability_index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const BROWSER_SAFE_SITE_MODULES = [
  "site/procurement_identity_key.mjs",
  "site/procurement_route.mjs",
  "site/meeting_availability_filter.mjs",
  "site/meetings_attendance.mjs",
  "site/meeting_process_profile.mjs",
  "site/analytical_projection.mjs",
  "site/procurement_browse_capability_index.mjs",
];

function meetingRow(id, schedule, extra = {}) {
  return {
    meeting_id: `meeting:parity:${id}`,
    event_date: schedule?.raw_date || schedule?.starts_at || "2026-09-30T17:00:00",
    schedule,
    ...extra,
  };
}

const AVAILABILITY = {
  timezone: "America/New_York",
  windows: [
    { weekdays: [1, 2, 3, 4, 5], start: "17:00" },
    { weekdays: [0, 6] },
  ],
};

const DETAIL_MODEL = {
  generated_at: "2026-09-01T12:00:00Z",
  rows: [
    {
      procurement_id: "procurement:contract:CT1234AB",
      identity_keys: { contract_ids: ["CT-1234-AB", "ct1234ab"] },
    },
    {
      procurement_id: "procurement:contract:OTHER1",
      identity_keys: { contract_ids: ["OTHER-1"] },
    },
  ],
};

const BROWSE_ENTRY = {
  search_text: "dept of parks vendor co ct1234ab landscaping",
  agency: "department of parks and recreation",
  vendor: "vendor co",
  stages: ["registered"],
  source_systems: ["checkbook"],
  amount_valid: true,
  amount_value: 250000,
};

test("browser-safe site helper copies do not import capabilities across the static boundary", () => {
  const pattern = /from\s+["']\.\.\/capabilities\//;
  for (const relative of BROWSER_SAFE_SITE_MODULES) {
    const source = readFileSync(join(root, relative), "utf8");
    assert.equal(
      pattern.test(source),
      false,
      `${relative} imports ../capabilities/ across the static boundary`,
    );
  }
});

test("procurement identity key and canonical href stay aligned", () => {
  const samples = [
    "CT-1234-AB",
    " ct1234ab ",
    "CT 12/34#AB",
    "",
    null,
    undefined,
    42,
  ];
  for (const sample of samples) {
    assert.equal(
      engineIdentity.procurementContractIdentityKey(sample),
      siteIdentity.procurementContractIdentityKey(sample),
      `identity key diverged for ${JSON.stringify(sample)}`,
    );
  }

  const hrefSamples = [
    "procurement:contract:CT1234AB",
    { procurement_id: "procurement:contract:CT1234AB" },
    { procurement_id: "" },
    null,
    undefined,
    {},
  ];
  for (const sample of hrefSamples) {
    assert.equal(
      engineHref.procurementCanonicalHref(sample),
      siteHref.procurementCanonicalHref(sample),
      `canonical href diverged for ${JSON.stringify(sample)}`,
    );
  }
});

test("meeting availability pure helpers stay aligned", () => {
  assert.equal(
    engineAvailability.MEETING_AVAILABILITY_SCHEMA,
    siteAvailability.MEETING_AVAILABILITY_SCHEMA,
  );
  assert.deepEqual(
    engineAvailability.MEETING_AVAILABILITY_UNKNOWN_START_POLICIES,
    siteAvailability.MEETING_AVAILABILITY_UNKNOWN_START_POLICIES,
  );
  assert.deepEqual(
    engineAvailability.EVENINGS_WEEKENDS_AVAILABILITY,
    siteAvailability.EVENINGS_WEEKENDS_AVAILABILITY,
  );

  assert.deepEqual(
    engineAvailability.validateMeetingAvailability(AVAILABILITY),
    siteAvailability.validateMeetingAvailability(AVAILABILITY),
  );
  assert.deepEqual(
    engineAvailability.canonicalMeetingAvailability(AVAILABILITY),
    siteAvailability.canonicalMeetingAvailability(AVAILABILITY),
  );

  const rows = [
    meetingRow("weekday-boundary", {
      status: "resolved",
      precision: "exact_time",
      starts_at: "2026-09-30T17:00:00",
      timezone: "America/New_York",
      raw_date: "2026-09-30",
      raw_time: "17:00",
    }),
    meetingRow("weekday-before", {
      status: "resolved",
      precision: "exact_time",
      starts_at: "2026-09-30T16:59:00",
      timezone: "America/New_York",
      raw_date: "2026-09-30",
      raw_time: "16:59",
    }),
    meetingRow("weekend", {
      status: "resolved",
      precision: "exact_time",
      starts_at: "2026-10-04T10:00:00",
      timezone: "America/New_York",
      raw_date: "2026-10-04",
      raw_time: "10:00",
    }),
    meetingRow("date-only", {
      status: "date_only",
      precision: "date_only",
      raw_date: "2026-10-04",
      timezone: "America/New_York",
    }),
  ];

  for (const row of rows) {
    assert.deepEqual(
      engineAvailability.evaluateMeetingAvailability(row, AVAILABILITY),
      siteAvailability.evaluateMeetingAvailability(row, AVAILABILITY),
      `evaluateMeetingAvailability diverged for ${row.meeting_id}`,
    );
  }

  assert.deepEqual(
    engineAvailability.evaluateMeetingAvailabilityRows(rows, AVAILABILITY, { asOf: "2026-09-01" }),
    siteAvailability.evaluateMeetingAvailabilityRows(rows, AVAILABILITY, { asOf: "2026-09-01" }),
  );
});

test("attendance mode buckets and domain classification stay aligned", () => {
  assert.deepEqual(
    engineAttendance.MEETINGS_ATTENDANCE_MODES,
    siteAttendance.MEETINGS_ATTENDANCE_MODES,
  );

  const modeSamples = [
    ["attend_in_person", "join_remote"],
    ["join_remote"],
    ["attend_in_person"],
    ["watch"],
    ["watch", "register_to_testify"],
    ["register_to_testify"],
    ["submit_written"],
    [],
    undefined,
  ];
  for (const modes of modeSamples) {
    assert.equal(
      engineAttendance.attendanceModeFromParticipation(modes),
      siteAttendance.attendanceModeFromParticipation(modes),
      `attendanceModeFromParticipation diverged for ${JSON.stringify(modes)}`,
    );
  }

  assert.equal(
    engineAttendance.attendanceDomainForRecord({ agency: "New York City Council" }),
    siteAttendance.attendanceDomainForRecord({ agency: "New York City Council" }),
  );
  assert.equal(
    engineAttendance.attendanceDomainForRecord({ agency: "Community Board 7" }),
    siteAttendance.attendanceDomainForRecord({ agency: "Community Board 7" }),
  );
});

test("meeting process profile projections stay aligned", () => {
  const records = [
    {
      event_date: "2026-07-20",
      notice_type: "Meeting",
      participation: { links: [{ label: "Join online", url: "https://meet.example.test/room" }] },
    },
    { event_status: "held", meeting_documents: [{ role: "agenda", attachment_status: "attached" }] },
    { meeting_family: "agency_rulemaking_hearing", event_date: "2026-08-20" },
    { source_system: "community_board" },
    { source_system: "pdc_calendar" },
    { meeting_family: "unregistered_family" },
  ];

  for (const record of records) {
    assert.equal(
      engineProcess.resolveMeetingFamily(record),
      siteProcess.resolveMeetingFamily(record),
      `resolveMeetingFamily diverged for ${JSON.stringify(record)}`,
    );
    assert.deepEqual(
      engineProcess.meetingProcessProfile(record),
      siteProcess.meetingProcessProfile(record),
      `meetingProcessProfile diverged for ${JSON.stringify(record)}`,
    );
    assert.deepEqual(
      engineProcess.meetingObservedState(record),
      siteProcess.meetingObservedState(record),
      `meetingObservedState diverged for ${JSON.stringify(record)}`,
    );
    assert.deepEqual(
      engineProcess.meetingProcessProjection(record),
      siteProcess.meetingProcessProjection(record),
      `meetingProcessProjection diverged for ${JSON.stringify(record)}`,
    );
  }
});

test("analytical projection pure helpers stay aligned", () => {
  assert.deepEqual(engineAnalytical.ANALYTICAL_GROUPS, siteAnalytical.ANALYTICAL_GROUPS);
  assert.deepEqual(engineAnalytical.ANALYTICAL_MEASURES, siteAnalytical.ANALYTICAL_MEASURES);

  for (const value of ["2025-06-30", "2025-07-01", "not-a-date", null]) {
    assert.equal(
      engineAnalytical.registrationFiscalYear(value),
      siteAnalytical.registrationFiscalYear(value),
      `registrationFiscalYear diverged for ${JSON.stringify(value)}`,
    );
  }
  for (const value of [0, 99999, 100000, 1000000, null]) {
    assert.equal(
      engineAnalytical.contractAmountBand(value),
      siteAnalytical.contractAmountBand(value),
      `contractAmountBand diverged for ${JSON.stringify(value)}`,
    );
  }

  const row = {
    prime_contract_id: "CT-1234-AB",
    agency: "Parks",
    prime_vendor: "Vendor Co",
    registration_date: "2025-06-15",
    start_date: "2025-07-01",
    current_amount: 250000,
    original_amount: 200000,
  };
  assert.deepEqual(
    engineAnalytical.normalizeAnalyticalContractRow(row),
    siteAnalytical.normalizeAnalyticalContractRow(row),
  );
  assert.equal(
    engineAnalytical.registrationLagDaysBetween("2025-06-15", "2025-07-01"),
    siteAnalytical.registrationLagDaysBetween("2025-06-15", "2025-07-01"),
  );
  assert.equal(
    engineAnalytical.formatRegisteredValue(250000),
    siteAnalytical.formatRegisteredValue(250000),
  );
  assert.equal(
    engineAnalytical.analyticalReaderLabel("current"),
    siteAnalytical.analyticalReaderLabel("current"),
  );

  const drill = {
    agency: "Parks",
    prime_vendor: "Vendor Co",
    registration_fiscal_year: 2025,
    contract_amount_band: "$100,000–$999,999",
  };
  assert.equal(
    engineAnalytical.analyticalDrillThroughHref(drill),
    siteAnalytical.analyticalDrillThroughHref(drill),
  );
});

test("contracts analysis projection filters stay aligned", () => {
  const inputs = [
    {},
    { groupBy: "agency", measure: "current", topN: 10 },
    { agency: "Parks", vendor: "Vendor", registration_fiscal_year: "2025" },
    { min_amount: "100000", max_amount: "999999", retroactive: "yes" },
  ];
  for (const input of inputs) {
    assert.deepEqual(
      engineContractsProjection.analyticalFilters(input),
      siteContractsProjection.analyticalFilters(input),
      `analyticalFilters diverged for ${JSON.stringify(input)}`,
    );
  }
});

test("procurement detail index resolution stays aligned", () => {
  const engineIndex = engineDetailIndex.procurementDetailIndex(DETAIL_MODEL);
  const siteIndex = siteDetailIndex.procurementDetailIndex(DETAIL_MODEL);
  assert.ok(engineIndex);
  assert.ok(siteIndex);
  assert.equal(engineIndex.schema, siteIndex.schema);
  assert.equal(engineIndex.resolution, siteIndex.resolution);
  assert.equal(engineIndex.generated_at, siteIndex.generated_at);
  assert.equal(engineIndex.procurement_id_count, siteIndex.procurement_id_count);

  const ids = ["CT-1234-AB", "ct1234ab", "OTHER-1", "missing", "", null];
  for (const id of ids) {
    assert.equal(
      engineIndex.procurementIdFor(id),
      siteIndex.procurementIdFor(id),
      `procurementIdFor diverged for ${JSON.stringify(id)}`,
    );
  }
  assert.deepEqual(
    engineDetailIndex.resolveProcurementDetailIds(engineIndex, ids),
    siteDetailIndex.resolveProcurementDetailIds(siteIndex, ids),
  );

  const publishedModel = {
    generated_at: "2026-09-02T00:00:00Z",
    procurement_shard_by_id: {
      "procurement:contract:CT1234AB": "shard-1.json",
      "procurement:contract:OTHER1": "shard-2.json",
    },
  };
  const enginePublished = engineDetailIndex.procurementDetailIndex(publishedModel);
  const sitePublished = siteDetailIndex.procurementDetailIndex(publishedModel);
  assert.equal(enginePublished.resolution, sitePublished.resolution);
  assert.equal(
    enginePublished.procurementIdFor("CT-1234-AB"),
    sitePublished.procurementIdFor("CT-1234-AB"),
  );
  assert.equal(
    enginePublished.procurementIdFor("missing"),
    sitePublished.procurementIdFor("missing"),
  );
});

test("procurement browse capability read helpers stay aligned", () => {
  assert.equal(
    engineBrowseRead.PROCUREMENT_BROWSE_CAPABILITY_INDEX_SCHEMA,
    siteBrowse.PROCUREMENT_BROWSE_CAPABILITY_INDEX_SCHEMA,
  );
  assert.equal(
    engineBrowseRead.PROCUREMENT_BROWSE_CAPABILITY_MAXIMUM_PAGE,
    siteBrowse.PROCUREMENT_BROWSE_CAPABILITY_MAXIMUM_PAGE,
  );
  assert.equal(
    engineBrowseRead.procurementBrowseCapabilityFilterShardPath(3),
    siteBrowse.procurementBrowseCapabilityFilterShardPath(3),
  );
  assert.equal(
    engineBrowseRead.procurementBrowseCapabilityDetailShardPath(7),
    siteBrowse.procurementBrowseCapabilityDetailShardPath(7),
  );
  assert.equal(
    engineBrowseRead.procurementBrowseCapabilityReadBudgetBytes(2, 5),
    siteBrowse.procurementBrowseCapabilityReadBudgetBytes(2, 5),
  );

  const matchInputs = [
    {},
    { query: "parks landscaping" },
    { query: "missing-term" },
    { agency: "parks" },
    { vendor: "vendor" },
    { stage: "registered" },
    { stage: "solicitation" },
    { sourceSystem: "checkbook" },
    { minAmount: 100000, maxAmount: 300000 },
    { minAmount: 300000 },
  ];
  for (const input of matchInputs) {
    assert.equal(
      engineBrowseRead.procurementBrowseCapabilityEntryMatches(BROWSE_ENTRY, input),
      siteBrowse.procurementBrowseCapabilityEntryMatches(BROWSE_ENTRY, input),
      `entryMatches diverged for ${JSON.stringify(input)}`,
    );
  }

  const envelopeModel = {
    schema: engineBrowseRead.PROCUREMENT_BROWSE_CAPABILITY_SOURCE_MODEL_SCHEMA,
    generated_at: "2026-09-01T12:00:00Z",
    freshness: { generated_at: "2026-09-01T12:00:00Z" },
    source_envelopes: [{ source_system: "checkbook" }],
    publication_policy: { retention_days: 30 },
    objects: [],
  };
  assert.deepEqual(
    engineBrowseRead.procurementBrowseCapabilityEnvelope(envelopeModel),
    siteBrowse.procurementBrowseCapabilityEnvelope(envelopeModel),
  );
});
