import {
  fetchBrowseScoped,
  projectBrowseScopedRows,
} from "../browse_scoped_adapters.mjs";

const serials = {};
const meetingState = { query: "", outcome: null, serial: 0 };

export function meetingScopedKeywordState() {
  return meetingState;
}

export function meetingScopedDisclosureHTML({ outcome, keyword, t, escUiHtml }) {
  if (!outcome || outcome.query !== keyword) return "";
  if (outcome.outcome === "unavailable") return `<div class="note" data-browse-scope-disclosure role="status">${escUiHtml(t("browse_scope_unavailable_snapshot", { source: "meeting" }))}</div>`;
  if (outcome.outcome === "partial") return `<div class="note" data-browse-scope-disclosure role="status">${escUiHtml(t("browse_scope_partial_records", { source: "meetings" }))}</div>`;
  return "";
}

export function startMeetingScopedKeyword({ keyword, baseRows, render }) {
  meetingState.query = keyword;
  const serial = ++meetingState.serial;
  if (!keyword) {
    meetingState.outcome = null;
    return;
  }
  fetchBrowseScoped("meetings", keyword).then((outcome) => {
    if (serial !== meetingState.serial || keyword !== meetingState.query) return;
    meetingState.outcome = outcome;
    const rows = outcome.outcome === "unavailable"
      ? baseRows
      : projectBrowseScopedRows(outcome, baseRows, (row) => row?.meeting_id || "").rows;
    render(rows);
  });
}

function rowReferences(key, row) {
  if (key === "rules") return ["rulemaking", "notice", row?.request_id || ""].join(":");
  if (key === "meetings") return row?.meeting_id || "";
  if (key === "property") {
    const locations = row?._location || row?.property_location || {};
    return Array.isArray(locations.bbls) ? locations.bbls.map((bbl) => `bbl:${bbl}`) : [];
  }
  return "";
}

export async function refreshFeedScopedKeyword({
  key,
  query,
  sourceRows,
  agency,
  stale,
  filterFeedRowsToDistrictBag,
  ruleLocationTools,
  normalizeHearingRow,
  propertyLocationTools,
  onRulesRows,
  onPropertyRows,
  renderRulesExplorer,
  renderPropExplorer,
  t,
  escUiHtml,
}) {
  const normalized = String(query || "").trim();
  const serial = (serials[key] || 0) + 1;
  serials[key] = serial;
  if (!normalized) return;
  const outcome = await fetchBrowseScoped(key, normalized);
  if (stale() || serials[key] !== serial) return;
  const feed = document.querySelector(`#${key}feed`);
  if (feed) feed.querySelector("[data-browse-scope-disclosure]")?.remove();
  if (outcome.outcome === "unavailable") {
    if (feed) {
      feed.dataset.browseScopeState = "unavailable";
      feed.insertAdjacentHTML("afterbegin", `<p class="note" data-browse-scope-disclosure>${escUiHtml(t("browse_scope_unavailable_snapshot", { source: "record" }))}</p>`);
    }
    return;
  }
  let projected = projectBrowseScopedRows(outcome, sourceRows, (row) => rowReferences(key, row)).rows;
  projected = projected.filter((row) => !agency || row.agency_name === agency);
  if (key === "rules") {
    const tools = await ruleLocationTools();
    projected.forEach((row) => {
      const hearingArea = tools.isRuleHearing(row) ? normalizeHearingRow(row).affected_area : null;
      row._ruleLocation = tools.ruleLocationFromRow(row, { hearingArea });
    });
    onRulesRows(projected);
    renderRulesExplorer();
  } else {
    const tools = await propertyLocationTools();
    projected.forEach((row) => { row._location = row.property_location || tools.propertyLocationFromRow(row); });
    projected = await filterFeedRowsToDistrictBag("property", projected);
    if (stale() || serials[key] !== serial) return;
    onPropertyRows(projected);
    renderPropExplorer();
  }
  if (feed) {
    feed.dataset.browseScopeState = outcome.outcome;
    feed.dataset.browseScopeCoverage = outcome.coverage_state || "";
    if (outcome.outcome === "partial") feed.insertAdjacentHTML("afterbegin", `<p class="note" data-browse-scope-disclosure>${escUiHtml(t("browse_scope_partial_records", { source: "records" }))}</p>`);
  }
}
