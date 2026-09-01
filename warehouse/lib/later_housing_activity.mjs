/**
 * LDP-17 later housing activity on exact land-use project lots.
 *
 * The join is deliberately narrow: a Housing Database record is admitted only when its exact
 * 10-digit BBL is one of the project's exact tax lots AND the dated housing event falls strictly
 * after the selected land-use milestone. Shared lot identity plus date order is evidence of later
 * activity on the same lot; it is not evidence that the land-use decision produced the housing, so
 * no causal field is emitted and no address, title, owner, name, or proximity key is ever used.
 */
export const HOUSING_DATASET = "br6q-ssj3";
export const HOUSING_DATASET_NAME = "Housing Database Project Level Files";
export const LATER_HOUSING_SCHEMA = "cityscroll.later_housing_activity.v1";
export const LATER_HOUSING_MATCH_VERSION = "ldp17_exact_bbl_post_milestone_v1";
export const LATER_HOUSING_MATCH_METHOD = "exact_bbl_and_post_milestone_event";

/** Land-use milestone precedence. The first present field is the one the retrospective is anchored to. */
export const MILESTONE_PRECEDENCE = ["completed_date", "approval_date"];

/** Dated housing events retained from a project-level job record, in chronological reporting order. */
const EVENT_FIELDS = [
  { type: "application_filed", label: "Application filed", field: "datefiled" },
  { type: "permit_issued", label: "Permit issued", field: "datepermit" },
  { type: "construction_completed", label: "Construction completed", field: "datecomplt" },
];

const clean = (value) => String(value ?? "").trim();
const day = (value) => {
  const text = clean(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
};
const lot = (value) => clean(value).replace(/\.0$/, "").padStart(10, "0");
const count = (value) => {
  const text = clean(value);
  return text && Number.isFinite(Number(text)) ? Number(text) : null;
};
const sourceUrl = (rowId) =>
  `https://data.cityofnewyork.us/resource/${HOUSING_DATASET}.json?$where=:id='${encodeURIComponent(rowId)}'`;

export function isCompletedLandProject(project) {
  return ["completed", "complete"].includes(clean(project?.public_status).toLowerCase())
    || ["completed", "complete"].includes(clean(project?.project_status).toLowerCase());
}

export function selectLandMilestone(project) {
  for (const field of MILESTONE_PRECEDENCE) {
    const date = day(project?.[field]);
    if (date) return { field, date };
  }
  return null;
}

export function materializeLaterHousingActivity({
  projects = [],
  projectLots = [],
  sourceRows = [],
  sourceVintage,
  generatedAt,
}) {
  const lotsByProject = new Map(
    projectLots.map((row) => [clean(row.project_id), [...new Set((row.bbls || []).map(lot))].sort()]),
  );
  const digests = {};
  const rejected = [];
  let eligibleProjects = 0;
  let eligibleLots = 0;

  for (const project of projects) {
    const projectId = clean(project.project_id);
    if (!projectId || !isCompletedLandProject(project)) continue;
    const milestone = selectLandMilestone(project);
    if (!milestone) continue;
    const lots = lotsByProject.get(projectId) || [];
    const lotSet = new Set(lots);
    eligibleProjects += 1;
    eligibleLots += lots.length;

    const events = [];
    let preMilestoneEvents = 0;
    for (const row of sourceRows) {
      const rowBbl = lot(row.bbl);
      if (!lotSet.has(rowBbl)) continue;
      const rowId = clean(row[":id"] || row.source_row_id);
      const jobNumber = clean(row.job_number);
      if (!/^\d{10}$/.test(rowBbl) || !rowId || !jobNumber) {
        rejected.push({ project_id: projectId, source_row_id: rowId || null, bbl: rowBbl, reason: "missing_required_source_fact" });
        continue;
      }
      if (clean(row.residflag).toLowerCase() !== "residential") {
        rejected.push({ project_id: projectId, source_row_id: rowId, bbl: rowBbl, reason: "non_residential_record" });
        continue;
      }
      const filedDate = day(row.datefiled) || null;
      for (const event of EVENT_FIELDS) {
        const eventDate = day(row[event.field]);
        if (!eventDate) continue;
        if (eventDate <= milestone.date) {
          preMilestoneEvents += 1;
          rejected.push({
            project_id: projectId,
            source_row_id: rowId,
            bbl: rowBbl,
            housing_job_number: jobNumber,
            event_type: event.type,
            event_date: eventDate,
            land_use_milestone_date: milestone.date,
            reason: eventDate === milestone.date ? "event_on_milestone_date" : "event_before_milestone",
          });
          continue;
        }
        events.push({
          project_id: projectId,
          bbl: rowBbl,
          housing_job_number: jobNumber,
          event_type: event.type,
          event_label: event.label,
          event_date: eventDate,
          land_use_milestone: milestone.field,
          land_use_milestone_date: milestone.date,
          job_type: clean(row.job_type) || null,
          job_status: clean(row.job_status) || null,
          job_filed_date: filedDate,
          filed_before_land_use_milestone: !!filedDate && filedDate <= milestone.date,
          units_existing: count(row.classainit),
          units_proposed: count(row.classaprop),
          units_net: count(row.classanet),
          units_certificate_of_occupancy: count(row.units_co),
          ownership: clean(row.ownership) || null,
          source_dataset: HOUSING_DATASET,
          source_dataset_name: HOUSING_DATASET_NAME,
          source_row_id: rowId,
          source_vintage: sourceVintage,
          source_url: sourceUrl(rowId),
          match_method: LATER_HOUSING_MATCH_METHOD,
          match_version: LATER_HOUSING_MATCH_VERSION,
          match_basis: { exact_bbl: true, event_strictly_after_land_use_milestone: true },
        });
      }
    }

    events.sort((a, b) =>
      a.event_date.localeCompare(b.event_date)
      || a.bbl.localeCompare(b.bbl)
      || a.housing_job_number.localeCompare(b.housing_job_number)
      || a.event_type.localeCompare(b.event_type));
    const matchedLots = [...new Set(events.map((row) => row.bbl))].sort();
    digests[projectId] = {
      schema: LATER_HOUSING_SCHEMA,
      project_id: projectId,
      coverage: matchedLots.length === 0 ? "none" : matchedLots.length === lots.length ? "complete" : "partial",
      land_use_milestone: milestone.field,
      land_use_milestone_date: milestone.date,
      eligible_lot_count: lots.length,
      matched_lot_count: matchedLots.length,
      matched_lots: matchedLots,
      unmatched_lots: lots.filter((value) => !matchedLots.includes(value)),
      matched_job_count: new Set(events.map((row) => row.housing_job_number)).size,
      pre_milestone_event_count: preMilestoneEvents,
      source_dataset: HOUSING_DATASET,
      source_vintage: sourceVintage,
      match_version: LATER_HOUSING_MATCH_VERSION,
      events,
    };
  }

  const allEvents = Object.values(digests).flatMap((digest) => digest.events);
  return {
    payload: {
      schema: LATER_HOUSING_SCHEMA,
      generated_at: generatedAt,
      source_dataset: HOUSING_DATASET,
      source_dataset_name: HOUSING_DATASET_NAME,
      source_vintage: sourceVintage,
      match_version: LATER_HOUSING_MATCH_VERSION,
      digests,
    },
    receipt: {
      schema: "cityscroll.later_housing_activity_receipt.v1",
      generated_at: generatedAt,
      source: {
        dataset_id: HOUSING_DATASET,
        dataset_name: HOUSING_DATASET_NAME,
        vintage: sourceVintage,
        url: `https://data.cityofnewyork.us/resource/${HOUSING_DATASET}.json`,
        coverage_note: "DOB residential job records since 2010, as published by the Housing Database project-level file.",
        acquisition: "scheduled_warehouse_materialization",
      },
      match: {
        method: LATER_HOUSING_MATCH_METHOD,
        version: LATER_HOUSING_MATCH_VERSION,
        required_keys: ["exact_bbl"],
        required_order: "housing event date strictly after the selected land-use milestone date",
        milestone_precedence: MILESTONE_PRECEDENCE,
        retained_event_types: EVENT_FIELDS.map((event) => event.type),
        prohibited_keys: ["address", "title", "owner", "name", "spatial_proximity"],
        emits_causal_claim: false,
      },
      denominator: { eligible_completed_projects: eligibleProjects, eligible_project_lots: eligibleLots },
      counts: {
        projects_with_later_activity: Object.values(digests).filter((digest) => digest.events.length).length,
        projects_without_later_activity: Object.values(digests).filter((digest) => !digest.events.length).length,
        later_activity_events: allEvents.length,
        matched_jobs: new Set(allEvents.map((row) => row.housing_job_number)).size,
        rejected: rejected.length,
      },
      specimens: { positive: digests["2022M0258"] || null },
      rejected,
      resident_request_fetches: 0,
      bounded_output: true,
    },
  };
}
