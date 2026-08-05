// Agency-name reconciliation for the City Record's historical spelling conventions.
//
// The source publishes agency_name as free text. Older rows are commonly ALL-CAPS and
// abbreviated; newer rows generally use Title Case. This module gives each known spelling a
// stable site id without replacing the source string. Unknown strings remain visible under
// their own deterministic id until a reviewed alias connects them.

import { canonicalAgency } from "../../../site/agency_identity.mjs";
export { canonicalAgency } from "../../../site/agency_identity.mjs";

function rawSort(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildAgencyCrosswalk(sourceRows) {
  const rawRows = new Set();
  for (const source of Array.isArray(sourceRows) ? sourceRows : []) {
    const raw = String(source?.agency_name || "").replace(/\s+/g, " ").trim();
    if (!raw) continue;
    rawRows.add(raw);
  }

  const base = [...rawRows].map((raw_string) => ({
    raw_string,
    ...canonicalAgency(raw_string),
  }));
  const variantsById = new Map();
  for (const row of base) {
    if (!variantsById.has(row.canonical_id)) variantsById.set(row.canonical_id, []);
    variantsById.get(row.canonical_id).push(row.raw_string);
  }
  for (const variants of variantsById.values()) variants.sort(rawSort);

  const rows = base
    .sort((a, b) => rawSort(a.raw_string, b.raw_string))
    .map((row) => ({ ...row, variants: variantsById.get(row.canonical_id) }));
  return {
    row_count: rows.length,
    canonical_count: variantsById.size,
    rows,
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function crosswalkCSV(rows) {
  const header = ["raw_string", "canonical_id", "canonical_name", "variants"];
  const lines = (Array.isArray(rows) ? rows : []).map((row) => [
    row.raw_string,
    row.canonical_id,
    row.canonical_name,
    JSON.stringify(row.variants || []),
  ].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\n") + "\n";
}
