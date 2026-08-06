const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** Build non-empty status facets from the current ZAP inventory. */
export function landStatusFacetOptions(rows = []) {
  const options = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const [field, prefix] of [["project_status", "project"], ["public_status", "public"]]) {
      const label = clean(row?.[field]);
      if (!label) continue;
      const id = `${prefix}:${label}`;
      const option = options.get(id) || { id, label, field, count: 0 };
      option.count += 1;
      options.set(id, option);
    }
  }
  return [...options.values()]
    .filter((option) => option.count > 0)
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

export function landStatusFacetWhere(status) {
  const match = String(status || "").match(/^(project|public):(.*)$/);
  if (!match || !clean(match[2])) return null;
  const value = match[2].replace(/'/g, "''");
  return `${match[1] === "project" ? "project_status" : "public_status"}='${value}'`;
}
