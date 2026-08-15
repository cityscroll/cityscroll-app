// Pure builders for daily resident snapshots. Publisher requests belong to the
// acquisition commands; browser filters read the resulting artifacts locally.

export const DATA_PAGE_DATASET = "dg92-zbpx";
export const LAND_DEFAULT_DATASET = "hgx4-8ukb";
export const CITY_RECORD_DATASET = "dg92-zbpx";
export const SODA_BASE = "https://data.cityofnewyork.us/resource";
export const ZAP_OUTCOMES_ENDPOINT = "https://api.cityscroll.org/zap-outcomes";

// List-card fields only for the committed snapshot. project_brief stays off the
// static artifact (publisher text is large and not required to paint the resident list).
export const LAND_DEFAULT_LIST_FIELDS = Object.freeze([
  "project_id",
  "project_name",
  "primary_applicant",
  "public_status",
  "project_status",
  "borough",
  "community_district",
  "actions",
  "mih_flag",
  "current_milestone",
  "current_milestone_date",
  "ulurp_numbers",
]);

export const LAND_DEFAULT_SELECT = LAND_DEFAULT_LIST_FIELDS.join(",");
/** Full detail select for acquisition-time materialization. */
export const LAND_DEFAULT_DETAIL_SELECT = [...LAND_DEFAULT_LIST_FIELDS, "project_brief"].join(",");

export const LAND_DEFAULT_WHERE = "ulurp_non='ULURP' AND project_status='Active'";
export const LAND_DEFAULT_LIMIT = 40;

// Money default open RFP strip — list-card fields only on the committed snapshot so the
// public PR surface does not republish publisher contact emails/phones from City Record.
// Full detail fields are acquired only by precompute jobs that need them.
export const MONEY_DEFAULT_LIST_FIELDS = Object.freeze([
  "request_id",
  "start_date",
  "agency_name",
  "type_of_notice_description",
  "category_description",
  "short_title",
  "pin",
  "contract_amount",
  "vendor_name",
  "due_date",
  "selection_method_description",
]);
export const MONEY_DEFAULT_SELECT = MONEY_DEFAULT_LIST_FIELDS.join(",");
/** Full detail select for acquisition-time materialization (matches core SELECT). */
export const MONEY_DEFAULT_DETAIL_SELECT = [
  ...MONEY_DEFAULT_LIST_FIELDS,
  "address_to_request",
  "contact_name",
  "contact_phone",
  "email",
  "additional_description_1",
  "other_info_1",
].join(",");
export const MONEY_DEFAULT_LIMIT = 40;
export const MONEY_AGENCIES_LIMIT = 600;
export const STAFFING_HIRES_LIMIT = 80;
export const STAFFING_HIRES_SELECT =
  "request_id,start_date,agency_name,short_title,additional_description_1";

export function yearAgoISO(now = new Date()) {
  const d = new Date(now.getTime() - 365 * 86400000);
  return d.toISOString().slice(0, 10);
}

export function dataPageQueries(now = new Date()) {
  const yearAgo = yearAgoISO(now);
  const clean =
    `type_of_notice_description='Award' AND contract_amount > 0 AND contract_amount < 10000000000 AND start_date >= '${yearAgo}T00:00:00'`;
  return {
    year_ago: yearAgo,
    charts: {
      sections: {
        $select: "section_name,count(request_id) AS n",
        $group: "section_name",
        $order: "n DESC",
      },
      volume: {
        $select: "date_trunc_ym(start_date) AS m,count(request_id) AS n",
        $where: `start_date >= '${yearAgo}T00:00:00'`,
        $group: "m",
        $order: "m ASC",
      },
      procmix: {
        $select: "type_of_notice_description AS t,count(request_id) AS n",
        $where: `section_name='Procurement' AND start_date >= '${yearAgo}T00:00:00'`,
        $group: "t",
        $order: "n DESC",
      },
      agencies: {
        $select: "agency_name,sum(contract_amount) AS total",
        $where: clean,
        $group: "agency_name",
        $order: "total DESC",
        $limit: "10",
      },
      vendors: {
        $select: "vendor_name,sum(contract_amount) AS total",
        $where: `${clean} AND vendor_name IS NOT NULL`,
        $group: "vendor_name",
        $order: "total DESC",
        $limit: "10",
      },
    },
  };
}

export function normalizeDataPageRows(chartId, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (chartId === "sections") {
    return list.filter((r) => r.section_name).map((r) => ({ section_name: r.section_name, n: Number(r.n) || 0 }));
  }
  if (chartId === "volume") {
    return list
      .filter((r) => r.m)
      .map((r) => ({ m: String(r.m).slice(0, 7), n: Number(r.n) || 0 }));
  }
  if (chartId === "procmix") {
    return list.filter((r) => r.t).map((r) => ({ t: r.t, n: Number(r.n) || 0 }));
  }
  if (chartId === "agencies") {
    return list
      .filter((r) => r.agency_name)
      .map((r) => ({ agency_name: r.agency_name, total: Number(r.total) || 0 }));
  }
  if (chartId === "vendors") {
    return list
      .filter((r) => r.vendor_name)
      .map((r) => ({ vendor_name: r.vendor_name, total: Number(r.total) || 0 }));
  }
  return list;
}

export function buildDataPageSnapshot(rawCharts, { now = new Date(), sourceRows = null } = {}) {
  const { year_ago, charts: queryMeta } = dataPageQueries(now);
  const charts = {};
  for (const id of Object.keys(queryMeta)) {
    charts[id] = normalizeDataPageRows(id, rawCharts?.[id] || []);
  }
  return {
    schema_version: 1,
    delivery_tier: "inline-at-build",
    generated_at: now.toISOString(),
    year_ago,
    source: {
      name: "City Record Online",
      dataset: DATA_PAGE_DATASET,
      url: `https://data.cityofnewyork.us/d/${DATA_PAGE_DATASET}`,
    },
    query: queryMeta,
    charts,
    ...(sourceRows ? { _source_row_counts: sourceRows } : {}),
  };
}

export function landDefaultQuery() {
  return {
    $select: LAND_DEFAULT_SELECT,
    $where: LAND_DEFAULT_WHERE,
    $order: "current_milestone_date DESC",
    $limit: String(LAND_DEFAULT_LIMIT),
  };
}

export function isDefaultLandSearch({ status, boro, kw, communityDistrict, councilDistrict, located } = {}) {
  return (
    (status || "active") === "active" &&
    !boro &&
    !String(kw || "").trim() &&
    !communityDistrict &&
    !councilDistrict &&
    !located
  );
}

/** Calendar day for due_date floors (UTC date string YYYY-MM-DD). */
export function calendarDayISO(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function moneyDefaultOpenWhere(now = new Date()) {
  return `type_of_notice_description='Solicitation' AND due_date > '${calendarDayISO(now)}'`;
}

export function moneyDefaultOpenQuery(now = new Date()) {
  return {
    $select: MONEY_DEFAULT_SELECT,
    $where: moneyDefaultOpenWhere(now),
    $order: "due_date ASC",
    $limit: String(MONEY_DEFAULT_LIMIT),
  };
}

export function moneyAgenciesQuery() {
  return {
    $select: "agency_name",
    $where: "section_name='Procurement' AND agency_name IS NOT NULL",
    $group: "agency_name",
    $order: "agency_name",
    $limit: String(MONEY_AGENCIES_LIMIT),
  };
}

export function staffingHiresQuery() {
  return {
    $select: STAFFING_HIRES_SELECT,
    $where: "section_name='Changes in Personnel' AND short_title='APPOINTED'",
    $order: "start_date DESC, request_id DESC",
    $limit: String(STAFFING_HIRES_LIMIT),
  };
}

/**
 * Default Money tab: open solicitations, no agency/keyword/method/closing-week/NL filters,
 * default due_date sort. Resident filters execute over the bounded artifact.
 */
export function isDefaultMoneySearch({
  mode,
  agency,
  kw,
  methodSel,
  closingWeek,
  minAmount,
  sort,
  nlResolved,
} = {}) {
  const nl = nlResolved && typeof nlResolved === "object" ? nlResolved : {};
  const hasNl =
    Boolean(nl.category) ||
    nl.maxAmount != null ||
    nl.months != null ||
    Boolean(nl.excludeSpecial);
  return (
    (mode || "open") === "open" &&
    !agency &&
    !String(kw || "").trim() &&
    !methodSel &&
    !closingWeek &&
    !minAmount &&
    !hasNl &&
    // Default control value is "deadline" (soonest due_date ASC).
    (!sort || sort === "deadline" || sort === "due" || sort === "due_date" || sort === "")
  );
}

/** Drop snapshot rows whose due_date is no longer after today (stale build-day floor). */
export function filterStillOpenNotices(rows, now = new Date()) {
  const floor = calendarDayISO(now);
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    const due = String(r?.due_date || "").slice(0, 10);
    return due && due > floor;
  });
}

export function projectToMoneyRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const key of MONEY_DEFAULT_LIST_FIELDS) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

export function buildMoneyDefaultOpenSnapshot(rows, { now = new Date() } = {}) {
  const list = Array.isArray(rows)
    ? rows.slice(0, MONEY_DEFAULT_LIMIT).map(projectToMoneyRow)
    : [];
  return {
    schema_version: 1,
    delivery_tier: "inline-at-build",
    generated_at: now.toISOString(),
    open_as_of: calendarDayISO(now),
    source: {
      name: "City Record Online",
      dataset: CITY_RECORD_DATASET,
      url: `https://data.cityofnewyork.us/d/${CITY_RECORD_DATASET}`,
    },
    query: {
      ...moneyDefaultOpenQuery(now),
      note: "Default Money tab acquisition: open solicitations, all agencies, no keyword/method. Resident reads filter the committed snapshot.",
    },
    count: list.length,
    notices: list,
  };
}

export function buildMoneyAgenciesSnapshot(rows, { now = new Date() } = {}) {
  const agencies = (Array.isArray(rows) ? rows : [])
    .map((r) => (typeof r === "string" ? r : r?.agency_name))
    .filter((name) => typeof name === "string" && name.trim())
    .map((name) => name.trim());
  // Stable unique order (SODA already groups; re-sort for determinism).
  const unique = [...new Set(agencies)].sort((a, b) => a.localeCompare(b));
  return {
    schema_version: 1,
    delivery_tier: "inline-at-build",
    generated_at: now.toISOString(),
    source: {
      name: "City Record Online",
      dataset: CITY_RECORD_DATASET,
      url: `https://data.cityofnewyork.us/d/${CITY_RECORD_DATASET}`,
    },
    query: {
      ...moneyAgenciesQuery(),
      note: "Procurement agency dropdown materialized for resident reads.",
    },
    count: unique.length,
    agencies: unique,
  };
}

export function buildStaffingHiresSnapshot(rows, { now = new Date() } = {}) {
  const notices = (Array.isArray(rows) ? rows : []).slice(0, STAFFING_HIRES_LIMIT).map((row) => {
    if (!row || typeof row !== "object") return row;
    const out = {};
    for (const key of STAFFING_HIRES_SELECT.split(",")) {
      if (row[key] !== undefined) out[key] = row[key];
    }
    return out;
  });
  return {
    schema_version: 1,
    delivery_tier: "inline-at-build",
    generated_at: now.toISOString(),
    source: {
      name: "City Record Online — Changes in Personnel (APPOINTED)",
      dataset: CITY_RECORD_DATASET,
      url: `https://data.cityofnewyork.us/d/${CITY_RECORD_DATASET}`,
    },
    query: {
      ...staffingHiresQuery(),
      note: "Staffing appointments materialized for resident keyword and agency filtering.",
    },
    count: notices.length,
    notices,
  };
}

export function projectToLandListRow(project) {
  if (!project || typeof project !== "object") return project;
  const row = {};
  for (const key of LAND_DEFAULT_LIST_FIELDS) {
    if (project[key] !== undefined) row[key] = project[key];
  }
  return row;
}

const ZAP_OUTCOME_SNAPSHOT_FIELDS = Object.freeze([
  "project_id",
  "public_status",
  "portal_url",
  "join",
  "filled",
  "approved_actions",
  "dispositions",
  "documents",
  "n_documents",
  "generated_at",
]);

/** Keep only fields consumed by the Land outcomes renderer and action rail. */
export function compactZapOutcomeRecord(record) {
  if (!record || typeof record !== "object") return null;
  const out = {};
  for (const key of ZAP_OUTCOME_SNAPSHOT_FIELDS) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  if (Array.isArray(out.approved_actions)) out.approved_actions = out.approved_actions.slice(0, 8);
  if (Array.isArray(out.dispositions)) out.dispositions = out.dispositions.slice(0, 6);
  if (Array.isArray(out.documents)) out.documents = out.documents.slice(0, 10);
  out.snapshot_state = record.filled ? "present" : "absent";
  return out;
}

export function buildLandDefaultSnapshot(
  projects,
  { now = new Date(), outcomesByProject = {} } = {},
) {
  const rows = Array.isArray(projects)
    ? projects.slice(0, LAND_DEFAULT_LIMIT).map(projectToLandListRow)
    : [];
  const byProject = {};
  let presentCount = 0;
  let absentCount = 0;
  let missingCount = 0;
  for (const row of rows) {
    const id = String(row?.project_id || "").trim();
    if (!id) continue;
    const outcome = compactZapOutcomeRecord(outcomesByProject[id]);
    if (outcome) {
      byProject[id] = outcome;
      if (outcome.snapshot_state === "present") presentCount += 1;
      else absentCount += 1;
    } else {
      byProject[id] = { project_id: id, snapshot_state: "unavailable" };
      missingCount += 1;
    }
  }
  return {
    schema_version: 1,
    delivery_tier: "inline-at-build",
    generated_at: now.toISOString(),
    source: {
      name: "Zoning Application Portal projects (Open Data)",
      dataset: LAND_DEFAULT_DATASET,
      url: `https://data.cityofnewyork.us/d/${LAND_DEFAULT_DATASET}`,
    },
    query: {
      ...landDefaultQuery(),
      note: "Default Land tab: Active ULURP, all boroughs, no keyword/geo. List fields only; brief hydrates on select.",
    },
    count: rows.length,
    projects: rows,
    outcomes: {
      schema_version: 1,
      delivery_tier: "inline-at-build",
      source: {
        name: "CityScroll ZAP outcomes daily read model",
        endpoint: "https://api.cityscroll.org/zap-outcomes",
      },
      present_count: presentCount,
      absent_count: absentCount,
      missing_count: missingCount,
      by_project: byProject,
    },
  };
}

export function sodaUrl(dataset, params) {
  const qs = new URLSearchParams(params);
  return `${SODA_BASE}/${dataset}.json?${qs}`;
}

export async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`fetch ${url} → HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body) && body && typeof body === "object" && body.error) {
    throw new Error(`SODA error: ${body.message || JSON.stringify(body)}`);
  }
  return body;
}

export async function fetchDataPageCharts(fetchImpl = fetch, now = new Date()) {
  const { charts } = dataPageQueries(now);
  const entries = await Promise.all(
    Object.entries(charts).map(async ([id, params]) => {
      const rows = await fetchJson(fetchImpl, sodaUrl(DATA_PAGE_DATASET, params));
      return [id, rows];
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Prefer warehouse zap-projects (WH-05) when DuckDB has the table; otherwise acquire
 * from SODA. Resident parameterized search runs over this and the warehouse artifact.
 */
export async function fetchLandDefaultProjects(fetchImpl = fetch, opts = {}) {
  const preferWarehouse = opts.preferWarehouse !== false;
  if (preferWarehouse) {
    try {
      const { catalogExists } = await import("../../warehouse/lib/catalog.mjs");
      if (catalogExists()) {
        const { exportLandDefaultFromWarehouse } = await import(
          "../../warehouse/lib/zap_lookup.mjs"
        );
        const rows = exportLandDefaultFromWarehouse({ limit: LAND_DEFAULT_LIMIT });
        if (Array.isArray(rows) && rows.length) {
          return rows.map((r) => ({ ...r, lookup_path: "warehouse" }));
        }
      }
    } catch {
      // Fall through to live SODA (table missing, venv down, etc.).
    }
  }
  const rows = await fetchJson(fetchImpl, sodaUrl(LAND_DEFAULT_DATASET, landDefaultQuery()));
  if (!Array.isArray(rows)) throw new Error("land default SODA returned a non-array");
  return rows;
}

/**
 * Read the already-materialized Worker records for the bounded default Land list.
 * The daily Worker cron performs publisher fan-out; this build step only copies the
 * resulting read model into the static first-paint document.
 */
export async function fetchLandOutcomeSnapshots(
  projects,
  fetchImpl = fetch,
  { concurrency = 4 } = {},
) {
  const ids = [...new Set((projects || []).map((row) => String(row?.project_id || "").trim()).filter(Boolean))]
    .slice(0, LAND_DEFAULT_LIMIT);
  const byProject = {};
  let cursor = 0;
  const width = Math.max(1, Math.min(Number(concurrency) || 4, 8));
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const response = await fetchImpl(`${ZAP_OUTCOMES_ENDPOINT}?id=${encodeURIComponent(id)}`, {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) continue;
        const body = await response.json();
        if (body?.ok !== false && body?.record) byProject[id] = body.record;
      } catch {
        // A missing row becomes an explicit unavailable state in the snapshot.
      }
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()));
  return byProject;
}

export async function fetchMoneyDefaultOpen(fetchImpl = fetch, now = new Date()) {
  const rows = await fetchJson(fetchImpl, sodaUrl(CITY_RECORD_DATASET, moneyDefaultOpenQuery(now)));
  if (!Array.isArray(rows)) throw new Error("money default open SODA returned a non-array");
  return rows;
}

export async function fetchMoneyAgencies(fetchImpl = fetch) {
  const rows = await fetchJson(fetchImpl, sodaUrl(CITY_RECORD_DATASET, moneyAgenciesQuery()));
  if (!Array.isArray(rows)) throw new Error("money agencies SODA returned a non-array");
  return rows;
}

export async function fetchStaffingHires(fetchImpl = fetch) {
  const rows = await fetchJson(fetchImpl, sodaUrl(CITY_RECORD_DATASET, staffingHiresQuery()));
  if (!Array.isArray(rows)) throw new Error("staffing hires SODA returned a non-array");
  return rows;
}
