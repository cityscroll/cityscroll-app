import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_BODY_CALENDAR_CONTRACT_IDS,
  PUBLIC_BODY_CALENDAR_CONTRACT_REGISTRY,
  assertNoPublicBodyCalendarIdentityCollisions,
  buildPublicBodyCalendarCoverage,
  normalizePublicBodyCalendarInput,
  normalizePublicBodyCalendarMeeting,
  publicBodyCalendarIdentity,
  validatePublicBodyCalendarRegistry,
} from "../site/public_body_calendar_contract.mjs";
import {
  MEETING_OBJECT_SCHEMA,
  MEETING_SOURCE_SYSTEMS,
  meetingIdForSource,
} from "../site/meeting_object_contract.mjs";

const NOW = "2026-09-20T12:00:00.000Z";

test("the public-body registry is frozen to the five admitted contracts", () => {
  assert.deepEqual(PUBLIC_BODY_CALENDAR_CONTRACT_IDS, [
    "nycps_pep",
    "ccrb_board",
    "brooklyn_borough_board",
    "brooklyn_bp_ulurp",
    "hplus_h_cab",
  ]);
  assert.deepEqual(validatePublicBodyCalendarRegistry(PUBLIC_BODY_CALENDAR_CONTRACT_REGISTRY), []);
  assert.ok(MEETING_SOURCE_SYSTEMS.includes("public_body_calendar"));
});

test("contract-scoped identity never collides across publishers", () => {
  assert.equal(
    publicBodyCalendarIdentity({ source_contract_id: "nycps_pep", publisher_identifier: "2026-09-30" }),
    "meeting:public_body_calendar:nycps_pep:2026-09-30",
  );
  assert.equal(
    meetingIdForSource("public_body_calendar", "nycps_pep:2026-09-30"),
    "meeting:public_body_calendar:nycps_pep:2026-09-30",
  );
  const first = { source_contract_id: "nycps_pep", publisher_identifier: "2026-09-30" };
  const second = { source_contract_id: "ccrb_board", publisher_identifier: "2026-09-30" };
  assert.doesNotThrow(() => assertNoPublicBodyCalendarIdentityCollisions([first, second]));
  assert.throws(
    () => assertNoPublicBodyCalendarIdentityCollisions([first, { ...first }]),
    /identity collision/,
  );
});

test("the generic input requires a registered contract, receipt, identity, and temporal basis", () => {
  const input = normalizePublicBodyCalendarInput({
    source_contract_id: "nycps_pep",
    publisher_identifier: "2026-09-30",
    source_url: "https://example.test/pep",
    source_receipt: { observed_at: NOW, status: "ok" },
    temporal_basis: "explicit_instance",
  });
  assert.equal(input.schema, "cityscroll.public_body_calendar_input.v1");
  assert.equal(input.source_system, "public_body_calendar");
  assert.equal(input.institution_ref, "nycps:panel-for-educational-policy");
  assert.throws(() => normalizePublicBodyCalendarInput({
    source_contract_id: "cec_unknown",
    publisher_identifier: "2026-09-30",
    source_url: "https://example.test/cec",
    source_receipt: { observed_at: NOW },
  }), /unsupported public body calendar source_contract_id/);
  assert.throws(() => normalizePublicBodyCalendarInput({
    source_contract_id: "nycps_pep",
    publisher_identifier: "2026-09-30",
    source_url: "https://example.test/pep",
  }), /source_receipt is required/);
});

test("coverage keeps fresh-empty, stale, failed, and unobserved distinct", () => {
  const coverage = buildPublicBodyCalendarCoverage({
    now: NOW,
    observations: [
      { source_contract_id: "nycps_pep", observed_at: NOW, row_count: 0 },
      { source_contract_id: "ccrb_board", observed_at: "2026-09-18T00:00:00.000Z", row_count: 2 },
      { source_contract_id: "brooklyn_borough_board", observed_at: NOW, row_count: 1 },
      { source_contract_id: "brooklyn_bp_ulurp", status: "failed", observed_at: NOW },
    ],
  });
  assert.deepEqual(
    Object.fromEntries(coverage.contracts.map((row) => [row.source_contract_id, row.status])),
    {
      nycps_pep: "fresh-empty",
      ccrb_board: "stale",
      brooklyn_borough_board: "fresh",
      brooklyn_bp_ulurp: "failed",
      hplus_h_cab: "unobserved",
    },
  );
});

test("public-body rows normalize into the shared meeting object", () => {
  const record = normalizePublicBodyCalendarMeeting({
    source_contract_id: "nycps_pep",
    publisher_identifier: "2026-09-30",
    title: "Panel for Educational Policy Meeting",
    event_date: "2026-09-30T18:00:00",
    timezone: "America/New_York",
    source_raw_timezone: "EST",
    source_url: "https://example.test/pep/2026-09-30",
    source_receipt: { observed_at: NOW, status: "ok" },
    temporal_basis: "explicit_instance",
    institution_ref: "nycps:panel-for-educational-policy",
  });
  assert.equal(record.schema, MEETING_OBJECT_SCHEMA);
  assert.equal(record.meeting_id, "meeting:public_body_calendar:nycps_pep:2026-09-30");
  assert.equal(record.source_contract_id, "nycps_pep");
  assert.equal(record.source_keys[0].publisher_identifier, "2026-09-30");
  assert.equal(record.source_raw_timezone, "EST");
  assert.equal(record.schedule.timezone, "America/New_York");
  assert.equal(record.institution_refs.institution_ref, "nycps:panel-for-educational-policy");
});

test("the registry boundary rejects an extra unnamed or uncommissioned contract", () => {
  const invalid = {
    ...PUBLIC_BODY_CALENDAR_CONTRACT_REGISTRY,
    contracts: [...PUBLIC_BODY_CALENDAR_CONTRACT_REGISTRY.contracts, {
      id: "precinct_council",
      source_contract_id: "precinct_council",
      institution_ref: "nypd:precinct-council",
      name: "Precinct Council",
      official_source_url: "https://example.test/precinct",
      format: "html",
      temporal_basis: "published_recurrence",
      schedule_basis: "typical_recurrence",
      cadence: { minimum_observation_hours: 168, max_stale_hours: 192 },
      freshness: { max_age_hours: 192 },
      health_states: ["fresh-empty", "stale", "failed", "unobserved"],
    }],
  };
  assert.match(validatePublicBodyCalendarRegistry(invalid).join("\n"), /exactly the five/);
});
