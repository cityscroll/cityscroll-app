const residentSnapshotClean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const residentSnapshotLower = (value) => residentSnapshotClean(value).toLowerCase();

function residentSnapshotRowText(row) {
  return Object.values(row || {})
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(residentSnapshotClean)
    .join(" ")
    .toLowerCase();
}

function residentSnapshotNumeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function moneySnapshotRows(payload) {
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

export function filterMoneySnapshot(rows, {
  mode = "open",
  agency = "",
  keyword = "",
  method = "",
  closingWeek = false,
  minAmount = null,
  maxAmount = null,
  category = "",
  months = null,
  excludeSpecial = false,
  sort = "deadline",
  today,
  weekEnd,
  monthEnd,
  limit = 40,
} = {}) {
  const floor = String(today || "").slice(0, 10);
  const query = residentSnapshotLower(keyword);
  const selected = (Array.isArray(rows) ? rows : []).filter((row) => {
    const type = residentSnapshotClean(row?.type_of_notice_description);
    if (mode === "award" && type !== "Award") return false;
    if (mode === "archive" && type !== "Award" && type !== "Solicitation") return false;
    if ((mode === "open" || mode === "allrfp") && type !== "Solicitation") return false;
    const due = String(row?.due_date || "").slice(0, 10);
    if (mode === "open" && (!due || (floor && due <= floor))) return false;
    if (mode === "open" && closingWeek && weekEnd && due > String(weekEnd).slice(0, 10)) return false;
    if (agency && residentSnapshotClean(row?.agency_name) !== residentSnapshotClean(agency)) return false;
    if (query && !residentSnapshotRowText(row).includes(query)) return false;
    const amount = residentSnapshotNumeric(row?.contract_amount);
    if (mode === "award" && minAmount != null && (amount == null || amount < Number(minAmount))) return false;
    if (mode === "award" && maxAmount != null && (amount == null || amount > Number(maxAmount))) return false;
    if (category && residentSnapshotClean(row?.category_description) !== residentSnapshotClean(category)) return false;
    if (mode === "open" && months && monthEnd && due > String(monthEnd).slice(0, 10)) return false;
    if (excludeSpecial && /special/i.test(residentSnapshotClean(row?.selection_method_description))) return false;
    if (method && residentSnapshotClean(row?.selection_method_description) !== residentSnapshotClean(method)) return false;
    return true;
  });
  selected.sort((left, right) => {
    if (sort === "amount") return (residentSnapshotNumeric(right?.contract_amount) || 0) - (residentSnapshotNumeric(left?.contract_amount) || 0);
    if (sort === "newest" || mode === "award" || mode === "archive") {
      return String(right?.start_date || "").localeCompare(String(left?.start_date || ""));
    }
    if (mode === "allrfp") return String(right?.due_date || "").localeCompare(String(left?.due_date || ""));
    return String(left?.due_date || "").localeCompare(String(right?.due_date || ""));
  });
  return selected.slice(0, limit);
}

export function moneyMethodFacet(rows, limit = 7) {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const method = residentSnapshotClean(row?.selection_method_description);
    if (method) counts.set(method, (counts.get(method) || 0) + 1);
  }
  return [...counts].map(([selection_method_description, n]) => ({ selection_method_description, n }))
    .sort((left, right) => right.n - left.n || left.selection_method_description.localeCompare(right.selection_method_description))
    .slice(0, limit);
}

export function moneyLineageRows(rows, target) {
  const pin = residentSnapshotClean(target?.pin);
  const agency = residentSnapshotClean(target?.agency_name);
  if (!pin || !agency) return target ? [target] : [];
  const base = pin.replace(/R0\d+$/, "");
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (residentSnapshotClean(row?.agency_name) !== agency) return false;
    const candidate = residentSnapshotClean(row?.pin);
    return base !== pin ? candidate.startsWith(base) : candidate === pin;
  }).sort((left, right) => String(left?.start_date || "").localeCompare(String(right?.start_date || "")));
}

export function mergeLandProjects(...payloads) {
  const byId = new Map();
  for (const payload of payloads) {
    const rows = Array.isArray(payload) ? payload : payload?.projects || payload?.rows || [];
    for (const row of rows) {
      const id = residentSnapshotClean(row?.project_id);
      if (!id) continue;
      byId.set(id, { ...(byId.get(id) || {}), ...row });
    }
  }
  return [...byId.values()];
}

export function projectIdsForBlock(bblRows, block) {
  const prefix = String(block || "").replace(/\D/g, "").slice(0, 6);
  if (prefix.length !== 6) return [];
  return (Array.isArray(bblRows) ? bblRows : [])
    .filter((row) => (row?.bbls || []).some((bbl) => String(bbl).padStart(10, "0").startsWith(prefix)))
    .map((row) => row.project_id)
    .filter(Boolean);
}

export function bblsForProject(bblRows, projectId) {
  const row = (Array.isArray(bblRows) ? bblRows : []).find((item) => item?.project_id === projectId);
  return Array.isArray(row?.bbls) ? row.bbls.map(String) : [];
}

export function filterLandSnapshot(rows, {
  status = "active",
  borough = "",
  keyword = "",
  communityDistrict = "",
  councilDistrict = "",
  projectIds = null,
  limit = 40,
} = {}) {
  const query = residentSnapshotLower(keyword);
  const ids = projectIds ? new Set(projectIds) : null;
  const statusMatch = String(status || "active").match(/^(project|public):(.*)$/);
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (row?.ulurp_non && row.ulurp_non !== "ULURP") return false;
    if (status === "active" && residentSnapshotClean(row?.project_status) !== "Active") return false;
    if (statusMatch) {
      const field = statusMatch[1] === "project" ? "project_status" : "public_status";
      if (residentSnapshotClean(row?.[field]) !== residentSnapshotClean(statusMatch[2])) return false;
    }
    if (borough && residentSnapshotClean(row?.borough) !== residentSnapshotClean(borough)) return false;
    if (communityDistrict && !residentSnapshotClean(row?.community_district).includes(residentSnapshotClean(communityDistrict))) return false;
    if (councilDistrict) {
      const padded = String(councilDistrict).padStart(2, "0");
      const districts = residentSnapshotClean(row?.cc_district);
      if (!districts || (!districts.includes(padded) && districts !== String(councilDistrict))) return false;
    }
    if (ids && !ids.has(row?.project_id)) return false;
    if (query && !residentSnapshotRowText(row).includes(query)) return false;
    return true;
  }).sort((left, right) => String(right?.current_milestone_date || "").localeCompare(String(left?.current_milestone_date || "")))
    .slice(0, limit);
}

export function staffingRolesFromExamples(examples, keyword, limit = 40) {
  const query = residentSnapshotLower(keyword);
  const rows = new Map();
  for (const example of Array.isArray(examples) ? examples : []) {
    const candidates = [
      {
        title_description: example.official_title,
        n: Number(example.headcount) || 0,
        mn: residentSnapshotNumeric(example.base_min),
        mx: residentSnapshotNumeric(example.base_max),
        avg: residentSnapshotNumeric(example.base_median),
        competitive: Boolean(example.competitive),
      },
      ...(example.ladder || []).map((item) => ({
        title_description: item.title,
        n: item.title === example.official_title ? Number(example.headcount) || 0 : 0,
        mn: residentSnapshotNumeric(item.avg),
        mx: residentSnapshotNumeric(item.avg),
        avg: residentSnapshotNumeric(item.avg),
        competitive: item.title === example.official_title && Boolean(example.competitive),
      })),
    ];
    for (const row of candidates) {
      const title = residentSnapshotClean(row.title_description);
      if (!title || (query && !residentSnapshotLower(title).includes(query))) continue;
      const prior = rows.get(title);
      rows.set(title, prior ? {
        ...prior,
        n: Math.max(prior.n, row.n),
        competitive: prior.competitive || row.competitive,
      } : row);
    }
  }
  return [...rows.values()].sort((left, right) => (right.avg || 0) - (left.avg || 0)).slice(0, limit);
}

export function staffingPeopleFromAppointments(notices, keyword) {
  const query = residentSnapshotLower(keyword);
  const people = new Map();
  for (const row of Array.isArray(notices) ? notices : []) {
    if (query && !residentSnapshotRowText(row).includes(query)) continue;
    const text = residentSnapshotClean(row?.additional_description_1);
    const name = text.match(/Employee Name:\s*([^.]+?)\s*\.?\s*$/i)?.[1]?.trim();
    if (!name) continue;
    const key = `${name.toUpperCase()}|${residentSnapshotClean(row?.agency_name)}`;
    if (!people.has(key)) people.set(key, { name, agency: row.agency_name, rows: [] });
    people.get(key).rows.push(row);
  }
  return [...people.values()].sort((left, right) => right.rows.length - left.rows.length);
}

export function domainRows(payload, key = "rows") {
  return Array.isArray(payload?.[key]) ? payload[key] : [];
}
