// Dated capital-project comparisons in the procurement research packet.
//   node --test test/ddc_project_history.test.mjs
//
// Named projects and counts below are frozen regression expectations over the
// committed materialization, which is tracked source rather than a build-time
// refreshed window. They assert that a reviewed comparison still reproduces, not
// that the publisher will keep any record available.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROJECT_HISTORY_SCHEMA,
  PROJECT_HISTORY_SOURCE_URL,
  projectHistoryAmount,
  projectHistoryAvailability,
  projectHistoryClaim,
  projectHistoryComparativeSignal,
  projectHistoryDayMovement,
  projectHistoryExport,
  projectHistoryExportFailure,
  projectHistoryFieldRows,
  projectHistoryFind,
  projectHistoryObservations,
  projectHistoryReleaseLabel,
  projectHistorySignedAmount,
} from "../site/procurement_project_history.mjs";
import { normalizeInvestigationComparativeSignal } from "../site/investigation_comparative_signal.mjs";
import {
  finalizeResearchPackage,
  researchPackageJson,
  researchPackageRequestFromInvestigation,
} from "../site/research_package.mjs";
import {
  projectHistoryChangedFixture,
  projectHistoryDisappearedFixture,
  projectHistoryFixtureEnvelope,
  projectHistoryMissingFieldFixture,
  projectHistorySingleObservationFixture,
  projectHistoryUnchangedFixture,
} from "./fixtures/ddc_project_history_fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const history = JSON.parse(readFileSync(join(ROOT, "site/data/procurement_project_history.json"), "utf8"));

function financial(fmsId) {
  const entry = projectHistoryFind(history, { fmsId });
  assert.ok(entry, `missing financial identity ${fmsId}`);
  return entry;
}

function schedule(pid) {
  const entry = projectHistoryFind(history, { pid });
  assert.ok(entry, `missing schedule identity ${pid}`);
  return entry;
}

// ---------------------------------------------------------------------------
// A1 — the museum project's January to May 2026 comparison
// ---------------------------------------------------------------------------

test("A1 museum project reproduces its published budget and spending movement", () => {
  const entry = financial("ACEDCA215");
  assert.equal(entry.managing_agency, "DDC");
  assert.equal(entry.identity_state, "compared");
  assert.equal(entry.changed, true);
  assert.equal(history.transition.before, "202601");
  assert.equal(history.transition.after, "202605");

  const budget = entry.changes.total_budget;
  assert.equal(budget.before, "18061485.81");
  assert.equal(budget.after, "19905485.81");
  assert.equal(budget.delta, "1844000.00");
  assert.equal(budget.state, "changed");

  const spend = entry.changes.spend_to_date;
  assert.equal(spend.delta, "426525.36");
  assert.equal(spend.state, "changed");

  assert.equal(projectHistorySignedAmount(budget.delta), "+$1,844,000.00");
  assert.equal(projectHistorySignedAmount(spend.delta), "+$426,525.36");
});

test("A1 museum project moves phase while its forecast completion holds", () => {
  const entry = schedule("4369");
  assert.equal(entry.changes.current_phase.before, "Design");
  assert.equal(entry.changes.current_phase.after, "Construction Procurement");
  assert.equal(entry.changes.current_phase.state, "changed");

  const forecast = entry.changes.forecast_completion;
  assert.equal(forecast.before, "2029-06-25");
  assert.equal(forecast.after, "2029-06-25");
  assert.equal(forecast.delta_days, 0);
  assert.equal(forecast.state, "unchanged");
});

test("A1 every rendered figure carries a whole-project scope label", () => {
  const rows = projectHistoryFieldRows(financial("ACEDCA215"));
  const labels = Object.fromEntries(rows.map((row) => [row.field, row.scope_label]));
  assert.equal(labels.total_budget, "Whole-project budget");
  assert.equal(labels.spend_to_date, "Recorded whole-project spending");

  const claim = projectHistoryClaim(financial("ACEDCA215"), history.transition);
  assert.match(claim, /whole-project budget \+\$1,844,000\.00/);
  assert.match(claim, /Not a solicitation value, a bid deadline, or a contract term/);
});

// ---------------------------------------------------------------------------
// A2 — an earlier forecast, and a project that did not move at all
// ---------------------------------------------------------------------------

test("A2 second project reproduces a 175-day-earlier forecast and a budget rise", () => {
  const scheduleEntry = schedule("5730");
  const forecast = scheduleEntry.changes.forecast_completion;
  assert.equal(forecast.before, "2028-09-29");
  assert.equal(forecast.after, "2028-04-07");
  assert.equal(forecast.delta_days, -175);
  assert.equal(projectHistoryDayMovement(forecast.delta_days), "175 days earlier");

  assert.equal(financial("PV279ACON").changes.total_budget.delta, "100000.00");
});

test("A2 a later release alone never manufactures a change", () => {
  const entry = financial("HH112CGIU");
  assert.equal(entry.identity_state, "compared");
  assert.equal(entry.changed, false);
  assert.equal(entry.changes.total_budget.state, "unchanged");
  assert.equal(entry.changes.spend_to_date.state, "unchanged");
  assert.equal(schedule("4207").changes.forecast_completion.state, "unchanged");
  assert.equal(schedule("4207").changes.forecast_completion.delta_days, 0);

  const availability = projectHistoryAvailability(entry);
  assert.equal(availability.kind, "unchanged");
  assert.match(availability.note, /No published figure changed/);
});

test("A2 a forecast movement is never attributed to a contractor", () => {
  const claim = projectHistoryClaim(schedule("5730"), history.transition);
  assert.match(claim, /project forecast completion 175 days earlier/);
  assert.doesNotMatch(claim, /contractor|vendor|awarded|extension/i);
});

// ---------------------------------------------------------------------------
// A3 — separate identities, component agreement, and the states of absence
// ---------------------------------------------------------------------------

test("A3 the two comparison identities stay separate", () => {
  assert.equal(history.financial_identity_rule, "managing_agency + fms_id");
  assert.equal(history.schedule_identity_rule, "managing_agency + nonempty pid");
  for (const entry of history.schedule_projects) {
    assert.ok(entry.pid && entry.pid.length > 0, "schedule identity requires a nonempty project identifier");
  }
});

test("A3 agency-qualified observation identity resolves the repeated source ids", () => {
  const payloadDir = join(ROOT, "site/data/procurement_planning_payload");
  const rows = readdirSync(payloadDir)
    .filter((name) => name.startsWith("capital-projects-") && name.endsWith(".json"))
    .flatMap((name) => JSON.parse(readFileSync(join(payloadDir, name), "utf8")).rows);

  const bySourceId = new Map();
  const byAgencyQualified = new Map();
  for (const row of rows) {
    bySourceId.set(row.source_record_id, (bySourceId.get(row.source_record_id) ?? 0) + 1);
    const key = `${row.agency}|${row.reporting_period}|${row.pid}|${row.fms_id}`;
    byAgencyQualified.set(key, (byAgencyQualified.get(key) ?? 0) + 1);
  }
  const excess = (map) => [...map.values()].reduce((total, count) => total + count - 1, 0);

  assert.equal(rows.length, 50000);
  assert.equal(excess(bySourceId), 96, "publisher source ids collide across agencies");
  assert.equal(excess(byAgencyQualified), 0, "adding managing agency resolves every collision");
});

test("A3 repeated financial components agree and are never summed", () => {
  assert.equal(history.counts.quarantined_financial, 0);
  const entry = financial("ACEDCA215");
  assert.equal(entry.after.total_budget, "19905485.81");
  assert.notEqual(entry.after.total_budget, "39810971.62");
});

test("A3 conflicting schedule components are quarantined, not resolved", () => {
  const conflicts = history.quarantine.schedule.filter((item) => item.reporting_period === "202605");
  assert.equal(conflicts.length, 1);
  const [conflict] = conflicts;
  assert.deepEqual(conflict.identity, ["DDC", "7445"]);
  assert.deepEqual(conflict.conflicting_fields, ["current_phase"]);
  assert.deepEqual(conflict.components, ["HED603", "HWX409"]);

  // Quarantine withholds the value instead of choosing between components: the
  // release's observation keeps its agreed fields and reports the conflicting one
  // as unpublished rather than adopting either component's phase.
  const quarantined = projectHistoryFind(history, { pid: "7445" });
  assert.equal(quarantined.after.reporting_period, "202605");
  assert.equal(quarantined.after.current_phase, null, "a conflicting field yields no agreed value");
  assert.equal(quarantined.after.forecast_completion, "2030-07-16", "agreeing components still collapse");
  assert.equal(projectHistoryAvailability(quarantined).available, false);
});

test("A3 disappearance, missing values and unchanged values stay distinct", () => {
  assert.equal(projectHistoryAvailability(projectHistoryUnchangedFixture).kind, "unchanged");
  assert.equal(projectHistoryAvailability(projectHistoryDisappearedFixture).kind, "disappeared");
  assert.equal(projectHistoryAvailability(projectHistorySingleObservationFixture).kind, "first_observed");

  const missing = projectHistoryFieldRows(projectHistoryMissingFieldFixture)
    .find((row) => row.field === "forecast_completion");
  assert.equal(missing.state, "missing_after");
  assert.equal(missing.delta, null, "a missing value never differences to zero");
  assert.equal(missing.delta_label, null);

  assert.match(
    projectHistoryAvailability(projectHistoryDisappearedFixture).note,
    /not a completed or cancelled project/,
  );
  assert.ok(history.counts.financial.disappeared >= 1);
  assert.ok(history.counts.financial.unchanged >= 1);
  assert.ok(history.counts.financial.single_observation >= 1);
});

// ---------------------------------------------------------------------------
// A4 — three different dates, and only releases proven complete
// ---------------------------------------------------------------------------

test("A4 reporting period, agency date and financial date are kept apart", () => {
  const after = financial("ACEDCA215").after;
  assert.equal(after.reporting_period, "202605");
  assert.equal(projectHistoryReleaseLabel(after.reporting_period), "May 2026");
  assert.equal(after.agency_data_date, "2026-06-23");
  assert.equal(after.financial_data_date, "2026-05-18");
  assert.notEqual(after.agency_data_date, after.financial_data_date);

  const observations = projectHistoryObservations(financial("ACEDCA215"));
  assert.equal(observations.length, 2);
  assert.equal(observations[1].reporting_period_label, "May 2026");
  assert.equal(observations[1].agency_data_date, "2026-06-23");
  assert.equal(observations[1].financial_data_date, "2026-05-18");
});

test("A4 history starts at the first completely retained release", () => {
  const reconciliation = history.release_reconciliation;
  assert.equal(reconciliation.release_floor, "202401");
  assert.deepEqual(reconciliation.admitted_releases, [
    "202401", "202405", "202409", "202501", "202505", "202509", "202601", "202605",
  ]);
  assert.equal(reconciliation.complete, true);

  const excluded = Object.fromEntries(
    reconciliation.excluded_releases.map((item) => [item.reporting_period, item]),
  );
  assert.equal(excluded["202309"].retained_complete, false);
  assert.ok(excluded["202309"].retained_rows < excluded["202309"].publisher_rows);
  assert.equal(excluded["202305"].retained_rows, 0);
  for (const period of Object.keys(excluded)) {
    assert.ok(period < "202401", "only releases below the floor are excluded");
  }
});

test("A4 the normalized term field is published as a project forecast", () => {
  const rows = projectHistoryFieldRows(schedule("4369"));
  const forecast = rows.find((row) => row.field === "forecast_completion");
  assert.equal(forecast.scope_label, "Project forecast completion");
  assert.doesNotMatch(forecast.scope_label, /contract/i);
  const exported = projectHistoryExport(schedule("4369"), history);
  assert.doesNotMatch(JSON.stringify(exported.calculations), /contract end|term_end/i);
});

// ---------------------------------------------------------------------------
// A5 — export through the existing research package, and a recoverable failure
// ---------------------------------------------------------------------------

test("A5 a comparison exports through the existing research-package mechanism", () => {
  const entry = financial("ACEDCA215");
  const signal = projectHistoryComparativeSignal(entry, history);
  assert.ok(signal, "comparison projects into a comparative signal");

  const normalized = normalizeInvestigationComparativeSignal(signal);
  assert.ok(normalized, "signal satisfies the Investigation item contract");
  assert.equal(normalized.subject.id, "ACEDCA215");
  assert.equal(normalized.comparison_receipt.peer_basis.identity_gate, "managing agency + FMS identifier");

  const request = researchPackageRequestFromInvestigation(
    { name: "Project research", items: [normalized] },
    { title: "Project research", question: "What changed between published releases?" },
  );
  assert.ok(request, "the package accepts the projected observation");

  const frozen = finalizeResearchPackage(request, {
    packageId: "pkg-project-history",
    versionId: "ver-1",
    generatedAt: "2026-09-05T00:00:00.000Z",
  });
  assert.ok(frozen);
  const exported = researchPackageJson(frozen);
  assert.ok(exported, "the frozen package renders a bounded export");

  assert.match(exported, /ACEDCA215/);
  assert.match(exported, /fb86-vt7u/);
});

test("A5 displayed and exported numbers agree", () => {
  const entry = financial("ACEDCA215");
  const displayed = projectHistoryFieldRows(entry);
  const exported = projectHistoryExport(entry, history);
  assert.deepEqual(exported.calculations, displayed);

  const budget = displayed.find((row) => row.field === "total_budget");
  const signal = projectHistoryComparativeSignal(entry, history);
  assert.ok(signal.claim.includes(budget.delta_label));
  assert.equal(exported.claim, signal.claim);

  assert.deepEqual(exported.observations, projectHistoryObservations(entry));
  assert.equal(exported.source_url, PROJECT_HISTORY_SOURCE_URL);
  assert.equal(exported.dataset_id, "fb86-vt7u");
  assert.equal(exported.schema, PROJECT_HISTORY_SCHEMA);
  assert.equal(exported.identity_rule, "managing_agency + fms_id");
});

test("A5 the export carries native identities, dates and scope labels", () => {
  const exported = projectHistoryExport(financial("ACEDCA215"), history);
  assert.equal(exported.managing_agency, "DDC");
  assert.equal(exported.fms_id, "ACEDCA215");
  assert.deepEqual(exported.transition, { before: "202601", after: "202605" });
  assert.match(exported.scope_note, /Not a solicitation value/);
  for (const observation of exported.observations) {
    assert.ok(observation.reporting_period);
    assert.ok(observation.agency_data_date);
    assert.ok(observation.financial_data_date);
  }
  for (const calculation of exported.calculations) {
    assert.ok(calculation.scope_label, "every exported calculation is scope-labelled");
  }
});

test("A5 an entry with nothing to compare exports no comparative claim", () => {
  assert.equal(
    projectHistoryComparativeSignal(projectHistoryDisappearedFixture, projectHistoryFixtureEnvelope),
    null,
  );
  assert.equal(
    projectHistoryComparativeSignal(projectHistorySingleObservationFixture, projectHistoryFixtureEnvelope),
    null,
  );
  const exported = projectHistoryExport(projectHistorySingleObservationFixture, projectHistoryFixtureEnvelope);
  assert.equal(exported.availability.available, false);
  assert.deepEqual(exported.calculations, []);
});

test("A5 a failed export preserves the comparison and offers a retry", () => {
  let attempts = 0;
  const retry = () => { attempts += 1; return true; };
  const failure = projectHistoryExportFailure(new Error("network unavailable"), { retry });
  assert.equal(failure.ok, false);
  assert.equal(failure.can_retry, true);
  assert.equal(failure.retry_label, "Try the export again");
  assert.match(failure.message, /comparison below is unchanged/);
  assert.equal(failure.detail, "network unavailable");
  assert.equal(failure.retry(), true);
  assert.equal(attempts, 1);

  const stillRenders = projectHistoryFieldRows(projectHistoryChangedFixture);
  assert.equal(stillRenders.length, 4);
});

test("A5 exact amounts survive formatting without floating-point drift", () => {
  assert.equal(projectHistoryAmount("19905485.81"), "$19,905,485.81");
  assert.equal(projectHistoryAmount("426525.36"), "$426,525.36");
  assert.equal(projectHistorySignedAmount("-100.5"), "-$100.50");
  assert.equal(projectHistoryAmount("not-a-number"), null);
  assert.equal(projectHistoryDayMovement(null), null);
  assert.equal(projectHistoryDayMovement(1), "1 day later");
});

// ---------------------------------------------------------------------------
// A6 — related contracts keep their published roles
// ---------------------------------------------------------------------------

test("A6 the three trade awards stay separate contracts with separate contractors", () => {
  const contracts = JSON.parse(
    readFileSync(join(ROOT, "site/data/procurement_spine_sources.json"), "utf8"),
  ).rows.passport_contracts;
  const awards = contracts.filter((row) => (row.title ?? "").includes("PV669-NPC"));
  assert.equal(awards.length, 3);
  assert.deepEqual(
    awards.map((row) => row.contract_id).sort(),
    ["CT1-850-20248805408", "CT1-850-20248805565", "CT1-850-20248805590"],
  );
  assert.equal(new Set(awards.map((row) => row.vendor)).size, 3);
});

test("A6 the shared project forecast movement is not a contract extension", () => {
  const entry = schedule("4205");
  const forecast = entry.changes.forecast_completion;
  assert.equal(forecast.before, "2026-07-31");
  assert.equal(forecast.after, "2026-11-10");
  assert.equal(forecast.delta_days, 102);
  assert.equal(projectHistoryDayMovement(forecast.delta_days), "102 days later");

  const claim = projectHistoryClaim(entry, history.transition);
  assert.match(claim, /project forecast completion 102 days later/);
  assert.doesNotMatch(claim, /extension|responsib|contractor|vendor/i);
});

test("A6 published contract roles are retained rather than flattened", () => {
  const contracts = JSON.parse(
    readFileSync(join(ROOT, "site/data/procurement_spine_sources.json"), "utf8"),
  ).rows.passport_contracts;

  const stipends = contracts.filter((row) => (row.title ?? "").includes("HWCRCDB") && /Stipend/i.test(row.title));
  assert.equal(stipends.length, 2, "two stipend records are not two construction awards");
  assert.equal(new Set(stipends.map((row) => row.contract_id)).size, 2);

  const masters = contracts.filter((row) => (row.title ?? "").includes("PROCONTRL"));
  assert.ok(masters.length > 1, "master agreements are several records, not one physical asset");
  assert.ok(masters.every((row) => row.contract_id.startsWith("MMA1-")));
});

test("A6 the packet does not claim a complete contract inventory", () => {
  const exported = projectHistoryExport(financial("PV669-NPC"), history);
  assert.equal(Object.hasOwn(exported, "contracts"), false);
  assert.doesNotMatch(JSON.stringify(exported), /complete (package|contract) inventory/i);
});
