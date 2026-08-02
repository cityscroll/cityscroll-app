// Pure builders for wave-2 batch-precompute snapshots (BATCHABLE / hybrid defaults).
// Live fetches stay live for parameterized search; these cover stable default/first-paint surfaces.

export const DATA_PAGE_DATASET = "dg92-zbpx";
export const LAND_DEFAULT_DATASET = "hgx4-8ukb";
export const SODA_BASE = "https://data.cityofnewyork.us/resource";

// List-card fields only for the committed snapshot. project_brief stays off the
// static artifact (publisher text is large and not required to paint the default list);
// landSelect hydrates the brief from live SODA when missing.
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
/** Full detail select (list fields + brief) for live SODA paths. */
export const LAND_DEFAULT_DETAIL_SELECT = [...LAND_DEFAULT_LIST_FIELDS, "project_brief"].join(",");

export const LAND_DEFAULT_WHERE = "ulurp_non='ULURP' AND project_status='Active'";
export const LAND_DEFAULT_LIMIT = 40;

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

export function isDefaultLandSearch({ status, boro, kw, communityDistrict, located } = {}) {
  return (
    (status || "active") === "active" &&
    !boro &&
    !String(kw || "").trim() &&
    !communityDistrict &&
    !located
  );
}

export function projectToLandListRow(project) {
  if (!project || typeof project !== "object") return project;
  const row = {};
  for (const key of LAND_DEFAULT_LIST_FIELDS) {
    if (project[key] !== undefined) row[key] = project[key];
  }
  return row;
}

export function buildLandDefaultSnapshot(projects, { now = new Date() } = {}) {
  const rows = Array.isArray(projects)
    ? projects.slice(0, LAND_DEFAULT_LIMIT).map(projectToLandListRow)
    : [];
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

export async function fetchLandDefaultProjects(fetchImpl = fetch) {
  const rows = await fetchJson(fetchImpl, sodaUrl(LAND_DEFAULT_DATASET, landDefaultQuery()));
  if (!Array.isArray(rows)) throw new Error("land default SODA returned a non-array");
  return rows;
}
