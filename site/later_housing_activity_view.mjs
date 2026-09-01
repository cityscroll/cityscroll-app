export const LATER_HOUSING_ACTIVITY_URL = "data/later_housing_activity.json";
let laterHousingLookup = {};
export function rememberLaterHousingActivity(payload) { laterHousingLookup = payload?.digests || {}; return laterHousingLookup; }
export function attachLaterHousingActivity(target, payload) { if (payload) rememberLaterHousingActivity(payload); for (const row of target?.projects || target || []) if (laterHousingLookup[row.project_id]) row.later_housing_activity = laterHousingLookup[row.project_id]; return target; }
export function loadLaterHousingActivity() { return fetch(LATER_HOUSING_ACTIVITY_URL, { cache: "force-cache", credentials: "omit" }).then((r) => r.ok ? r.json() : null).then(rememberLaterHousingActivity).catch(() => rememberLaterHousingActivity(null)); }

const unitsText = (row) => [
  Number.isFinite(row.units_certificate_of_occupancy) ? `${row.units_certificate_of_occupancy} homes with a certificate of occupancy` : null,
  Number.isFinite(row.units_net) ? `${row.units_net > 0 ? "+" : ""}${row.units_net} net homes on the job record` : null,
].filter(Boolean).join(" · ");

export function laterHousingActivityHTML(digest, { escape = (v) => String(v ?? "") } = {}) {
  if (!digest?.events?.length) return "";
  const esc = escape;
  const milestone = `${digest.land_use_milestone.replaceAll("_", " ")} ${digest.land_use_milestone_date}`;
  const rows = digest.events.map((row) => {
    const units = unitsText(row);
    const filedNote = row.filed_before_land_use_milestone && row.job_filed_date
      ? `<span class="note" data-later-housing-filed-before="1">Job application filed ${esc(row.job_filed_date)}, before this land-use milestone.</span>`
      : "";
    return `<li data-later-housing-event="${esc(row.event_type)}" data-later-housing-bbl="${esc(row.bbl)}" data-later-housing-job="${esc(row.housing_job_number)}">`
      + `<b>${esc(row.event_label)} ${esc(row.event_date)}</b> · <a href="#property?bbl=${esc(row.bbl)}">BBL ${esc(row.bbl)}</a>`
      + ` · ${esc(row.job_type || "Housing job")} (${esc(row.job_status || "status not published")})`
      + (units ? ` · ${esc(units)}` : "")
      + ` · <a href="${esc(row.source_url)}" target="_blank" rel="noopener noreferrer">job ${esc(row.housing_job_number)} source record</a>`
      + (filedNote ? ` ${filedNote}` : "")
      + `</li>`;
  }).join("");
  const partial = digest.coverage === "partial"
    ? `<p class="note" data-later-housing-partial="1">${esc(`${digest.matched_lot_count} of ${digest.eligible_lot_count} exact project lots ${digest.matched_lot_count === 1 ? "has" : "have"} a later housing record in the retained source. The other lots have no later record; that is not a statement that nothing happened there.`)}</p>`
    : "";
  const excluded = digest.pre_milestone_event_count
    ? `<p class="note" data-later-housing-excluded="${esc(digest.pre_milestone_event_count)}">${esc(`${digest.pre_milestone_event_count} housing event${digest.pre_milestone_event_count === 1 ? "" : "s"} on these lots ${digest.pre_milestone_event_count === 1 ? "is" : "are"} dated on or before the land-use milestone and ${digest.pre_milestone_event_count === 1 ? "is" : "are"} not listed here.`)}</p>`
    : "";
  return `<section class="land-later-housing" data-later-housing-activity="1">`
    + `<h3>Later housing activity on project lots</h3>`
    + `<p class="note">These housing records share an exact tax lot with this land-use project and are dated after ${esc(milestone)}. Same lot and later date show what happened afterwards on the same land; they do not show that this land-use decision produced the housing.</p>`
    + `<ul>${rows}</ul>${partial}${excluded}`
    + `<p class="note">Source ${esc(digest.events[0].source_dataset_name)} (${esc(digest.source_dataset)}) · vintage ${esc(digest.source_vintage)} · Match basis exact BBL and event date after the land-use milestone · Match version ${esc(digest.match_version)}</p>`
    + `</section>`;
}
