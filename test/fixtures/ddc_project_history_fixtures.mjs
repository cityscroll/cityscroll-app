/**
 * Synthetic comparison entries for the project-history reader.
 *
 * These exercise the shapes the reader has to keep apart without depending on a
 * particular published project: an ordinary change, a release in which nothing
 * moved, a field that stopped being published, an identity that disappeared, and
 * one observed only once. The committed materialization covers the real
 * published cases; these cover the boundaries.
 */

export const PROJECT_HISTORY_FIXTURE_TRANSITION = { before: "202601", after: "202605" };

function observation(period, overrides = {}) {
  return {
    reporting_period: period,
    agency_data_date: period === "202601" ? "2026-03-16" : "2026-06-23",
    financial_data_date: period === "202601" ? "2026-02-17" : "2026-05-18",
    managing_agency: "DDC",
    fms_id: "FIXTUREA1",
    pid: "9001",
    total_budget: "1000000.00",
    spend_to_date: "250000.00",
    forecast_completion: "2029-06-25",
    current_phase: "Design",
    ...overrides,
  };
}

/** Budget and spending move; the forecast does not. */
export const projectHistoryChangedFixture = {
  fms_id: "FIXTUREA1",
  managing_agency: "DDC",
  identity_state: "compared",
  changed: true,
  history_depth: 8,
  before: observation("202601"),
  after: observation("202605", { total_budget: "1250000.00", spend_to_date: "400000.00" }),
  changes: {
    total_budget: { before: "1000000.00", after: "1250000.00", state: "changed", delta: "250000.00" },
    spend_to_date: { before: "250000.00", after: "400000.00", state: "changed", delta: "150000.00" },
    forecast_completion: { before: "2029-06-25", after: "2029-06-25", state: "unchanged", delta_days: 0 },
    current_phase: { before: "Design", after: "Design", state: "unchanged" },
  },
};

/** A later release exists and nothing published moved. That is not a change. */
export const projectHistoryUnchangedFixture = {
  fms_id: "FIXTUREB2",
  managing_agency: "DDC",
  identity_state: "compared",
  changed: false,
  history_depth: 8,
  before: observation("202601", { fms_id: "FIXTUREB2" }),
  after: observation("202605", { fms_id: "FIXTUREB2" }),
  changes: {
    total_budget: { before: "1000000.00", after: "1000000.00", state: "unchanged", delta: "0.00" },
    spend_to_date: { before: "250000.00", after: "250000.00", state: "unchanged", delta: "0.00" },
    forecast_completion: { before: "2029-06-25", after: "2029-06-25", state: "unchanged", delta_days: 0 },
    current_phase: { before: "Design", after: "Design", state: "unchanged" },
  },
};

/** An optional field present earlier and absent later is missing, not zero. */
export const projectHistoryMissingFieldFixture = {
  fms_id: "FIXTUREC3",
  managing_agency: "DDC",
  identity_state: "compared",
  changed: false,
  history_depth: 4,
  before: observation("202601", { fms_id: "FIXTUREC3" }),
  after: observation("202605", { fms_id: "FIXTUREC3", forecast_completion: null }),
  changes: {
    total_budget: { before: "1000000.00", after: "1000000.00", state: "unchanged", delta: "0.00" },
    spend_to_date: { before: "250000.00", after: "250000.00", state: "unchanged", delta: "0.00" },
    forecast_completion: { before: "2029-06-25", after: null, state: "missing_after", delta_days: null },
    current_phase: { before: "Design", after: "Design", state: "unchanged" },
  },
};

/** Published earlier, absent later. Absence is not completion or cancellation. */
export const projectHistoryDisappearedFixture = {
  fms_id: "FIXTURED4",
  managing_agency: "DDC",
  identity_state: "disappeared",
  changed: false,
  history_depth: 5,
  before: observation("202601", { fms_id: "FIXTURED4" }),
  after: null,
  changes: {},
};

/** One observation only, so there is nothing to compare it against. */
export const projectHistorySingleObservationFixture = {
  fms_id: "FIXTUREE5",
  managing_agency: "DDC",
  identity_state: "first_observed",
  changed: false,
  history_depth: 1,
  before: null,
  after: observation("202605", { fms_id: "FIXTUREE5" }),
  changes: {},
};

/** Minimal materialization envelope the reader needs around an entry. */
export const projectHistoryFixtureEnvelope = {
  schema: "cityscroll.procurement_project_history.v1",
  materialized_at: "2026-09-05T00:00:00.000Z",
  managing_agency: "DDC",
  financial_identity_rule: "managing_agency + fms_id",
  schedule_identity_rule: "managing_agency + nonempty pid",
  transition: PROJECT_HISTORY_FIXTURE_TRANSITION,
  release_reconciliation: { release_floor: "202401" },
  counts: { admitted_agency_rows: 8070, financial: { compared: 932 }, schedule: { compared: 635 } },
  financial_projects: [projectHistoryChangedFixture, projectHistoryUnchangedFixture],
  schedule_projects: [],
};
