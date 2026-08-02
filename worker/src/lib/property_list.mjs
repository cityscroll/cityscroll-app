// Slim list view for Property first paint.
// Full materialization stays in KV; GET /property-locations defaults to this shape.

/** Body-dump fields not needed for list cards / asset badges (keep additional_description_1). */
export const PROPERTY_LIST_DROP_FIELDS = Object.freeze([
  "additional_description_2",
  "additional_description_3",
  "other_info_1",
  "other_info_2",
  "other_info_3",
  "printout_1",
  "printout_2",
  "printout_3",
]);

export function slimPropertyListRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  for (const key of PROPERTY_LIST_DROP_FIELDS) delete out[key];
  return out;
}

export function slimPropertyListView(view) {
  if (!view || typeof view !== "object") return view;
  const properties = Array.isArray(view.properties)
    ? view.properties.map((row) => slimPropertyListRow(row))
    : [];
  return {
    ...view,
    view: "list",
    schema_version: view.schema_version || 1,
    properties,
  };
}
