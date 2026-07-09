import { vendorStem } from "./lib/compile.mjs";

export function parseMocsPlanRow(row) {
  const agency = row.agency || row.agency_name || row.purchasing_agency || "";
  const description = row.description || row.title || row.contracting_action || row.description_of_planned_services || "";
  const valueBand = row.value_band || row.estimated_cost || row.cost_estimate || row.estimated_value || "";
  const quarter = row.release_quarter || row.anticipated_release_date || row.quarter || row.anticipated_release_quarter || "";

  return {
    agency: String(agency).trim(),
    description: String(description).trim(),
    value_band: String(valueBand).trim(),
    release_quarter: String(quarter).trim()
  };
}

export async function runMocsPlanPipeline(env, mocsDatasetId = "egea-b8r5") {
  const url = `https://data.cityofnewyork.us/resource/${mocsDatasetId}.json`;
  const params = new URLSearchParams({
    "$limit": "5000"
  });

  const r = await fetch(`${url}?${params.toString()}`);
  if (!r.ok) {
    return { error: `MOCS SODA status ${r.status}` };
  }

  const rows = await r.json();
  const agencyMap = new Map();

  for (const row of rows) {
    const parsed = parseMocsPlanRow(row);
    if (!parsed.agency || !parsed.description) continue;
    
    const stem = vendorStem(parsed.agency);
    if (stem.length < 3) continue;

    if (!agencyMap.has(stem)) {
      agencyMap.set(stem, []);
    }
    agencyMap.get(stem).push(parsed);
  }

  const results = {};
  for (const [stem, plans] of agencyMap.entries()) {
    if (env.ALERT_STATE) {
      await env.ALERT_STATE.put(`plan:${stem}`, JSON.stringify(plans));
    }
    results[stem] = plans.length;
  }

  return { status: "success", updated: results };
}
