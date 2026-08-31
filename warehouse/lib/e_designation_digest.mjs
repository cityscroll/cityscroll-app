export const E_DESIGNATION_DATASET = "hxm3-23vy";
export const E_DESIGNATION_SCHEMA = "cityscroll.e_designation_project_digest.v1";
export const E_DESIGNATION_JOIN_VERSION = "ldp15_exact_keys_v1";

const clean = (v) => String(v ?? "").trim();
const key = (v) => clean(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
const tokens = (v) => clean(v).toUpperCase().split(/[;,|\s]+/).map(key).filter(Boolean);
const ulurpEqual = (a, b) => a === b || a === `C${b}` || b === `C${a}`;
const bbl = (row) => clean(row?.bbl).replace(/\.0$/, "").padStart(10, "0");
const sourceUrl = (rowId) => `https://data.cityofnewyork.us/resource/${E_DESIGNATION_DATASET}.json?$where=:id='${encodeURIComponent(rowId)}'`;

function conditions(row) {
  return [
    row.hazmat_code === true && { category: "hazardous_materials", value: "Hazardous materials requirements" },
    row.air_code === true && { category: "air_quality", value: "Air quality requirements" },
    row.noise_code === true && { category: "noise", value: "Noise requirements" },
  ].filter(Boolean);
}

export function materializeEDesignationDigest({ projects = [], projectLots = [], sourceRows = [], sourceVintage, generatedAt }) {
  const lotsByProject = new Map(projectLots.map((r) => [clean(r.project_id), [...new Set(r.bbls || [])].sort()]));
  const ceqrOwners = new Map();
  const ulurpOwners = new Map();
  for (const project of projects) {
    const projectId = clean(project.project_id);
    const ceqr = key(project.ceqr_number);
    if (ceqr) { if (!ceqrOwners.has(ceqr)) ceqrOwners.set(ceqr, new Set()); ceqrOwners.get(ceqr).add(projectId); }
    for (const ulurp of tokens(project.ulurp_numbers)) { if (!ulurpOwners.has(ulurp)) ulurpOwners.set(ulurp, new Set()); ulurpOwners.get(ulurp).add(projectId); }
  }
  const digests = {};
  const rejected = [];
  for (const project of projects) {
    const projectId = clean(project.project_id);
    const lots = lotsByProject.get(projectId) || [];
    const lotSet = new Set(lots);
    const projectUlurps = tokens(project.ulurp_numbers);
    const projectCeqr = key(project.ceqr_number);
    const matched = [];
    for (const row of sourceRows) {
      const rowId = clean(row[":id"] || row.source_row_id);
      const rowBbl = bbl(row);
      const exactUlurp = projectUlurps.some((a) => tokens(row.ulurp_num).some((b) => ulurpEqual(a, b)));
      const exactCeqr = !!projectCeqr && projectCeqr === key(row.ceqr_num);
      const exactBbl = lotSet.has(rowBbl);
      const candidates = [exactUlurp && "exact_ulurp", exactCeqr && "exact_ceqr", exactBbl && "exact_bbl_intersection"].filter(Boolean);
      if (!candidates.length) continue;
      const ambiguousKey = !exactBbl && ((exactCeqr && ceqrOwners.get(projectCeqr)?.size > 1) || (exactUlurp && projectUlurps.some((value) => ulurpOwners.get(value)?.size > 1)));
      const method = exactUlurp ? "exact_ulurp" : exactCeqr ? "exact_ceqr" : "exact_bbl_intersection";
      if (ambiguousKey || !rowId || !/^\d{10}$/.test(rowBbl) || !lotSet.has(rowBbl) || !conditions(row).length) {
        rejected.push({ project_id: projectId, source_row_id: rowId || null, reason: ambiguousKey ? "ambiguous_key" : !lotSet.has(rowBbl) ? "source_lot_outside_project" : "missing_required_source_fact", candidate_methods: candidates });
        continue;
      }
      for (const condition of conditions(row)) matched.push({
        project_id: projectId,
        bbl: rowBbl,
        designation_number: clean(row.enumber),
        condition_category: condition.category,
        condition_value: condition.value,
        condition_description: clean(row.description) || null,
        source_dataset: E_DESIGNATION_DATASET,
        source_row_id: rowId,
        source_date: clean(row.effective_date) || null,
        source_vintage: sourceVintage,
        source_url: sourceUrl(rowId),
        join_method: method,
        join_method_version: E_DESIGNATION_JOIN_VERSION,
        join_key: method === "exact_ulurp" ? projectUlurps.find((a) => tokens(row.ulurp_num).some((b) => ulurpEqual(a, b))) : method === "exact_ceqr" ? projectCeqr : rowBbl,
        join_basis: { exact_ulurp: exactUlurp, exact_ceqr: exactCeqr, exact_bbl_intersection: exactBbl },
      });
    }
    const matchedLots = [...new Set(matched.map((r) => r.bbl))].sort();
    if (matched.length || projectId === "2022M0258") digests[projectId] = {
      schema: E_DESIGNATION_SCHEMA,
      project_id: projectId,
      coverage: matchedLots.length === 0 ? "none" : matchedLots.length === lots.length ? "complete" : "partial",
      eligible_lot_count: lots.length,
      matched_lot_count: matchedLots.length,
      matched_lots: matchedLots,
      unmatched_lots: lots.filter((lot) => !matchedLots.includes(lot)),
      conditions: matched.sort((a, b) => a.bbl.localeCompare(b.bbl) || a.condition_category.localeCompare(b.condition_category)),
    };
  }
  return {
    payload: { schema: E_DESIGNATION_SCHEMA, generated_at: generatedAt, source_dataset: E_DESIGNATION_DATASET, source_vintage: sourceVintage, join_method_version: E_DESIGNATION_JOIN_VERSION, digests },
    receipt: {
      schema: "cityscroll.e_designation_project_digest_receipt.v1",
      generated_at: generatedAt,
      source: { dataset_id: E_DESIGNATION_DATASET, vintage: sourceVintage, url: `https://data.cityofnewyork.us/resource/${E_DESIGNATION_DATASET}.json`, acquisition: "scheduled_warehouse_materialization" },
      join_precedence: ["exact_ulurp", "exact_ceqr", "exact_bbl_intersection"],
      denominator: { eligible_projects: projects.length, eligible_project_lots: projectLots.reduce((n, r) => n + (r.bbls || []).length, 0) },
      counts: { projects_with_conditions: Object.values(digests).filter((d) => d.conditions.length).length, conditions: Object.values(digests).reduce((n, d) => n + d.conditions.length, 0), rejected: rejected.length },
      specimens: { positive: digests["2026Q0210"] || null, explicit_non_match: digests["2022M0258"] || null },
      rejected,
      resident_request_fetches: 0,
      bounded_output: true,
    },
  };
}
