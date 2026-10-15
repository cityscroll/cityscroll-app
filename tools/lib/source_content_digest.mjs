import { createHash } from "node:crypto";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rowField(row, field) {
  if (row && Object.prototype.hasOwnProperty.call(row, field)) return row[field];
  // Socrata GeoJSON exports move the geometry column (multipolygon on newer
  // datasets, the_geom on legacy ones) from properties onto the feature.
  if ((field === "multipolygon" || field === "the_geom") && row?.geometry !== undefined) return row.geometry;
  return row?.properties?.[field];
}

export function contentDigest(rows, requiredFields) {
  const records = rows.map((row) => Object.fromEntries(
    requiredFields.map((field) => [field, rowField(row, field)]),
  )).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return createHash("sha256").update(canonicalJson(records)).digest("hex");
}
