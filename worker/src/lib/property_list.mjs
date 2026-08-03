// Slim list view for Property first paint.
// Full materialization stays in KV; GET /property-locations defaults to this shape.
// Commercial payload (item / price / deal glance) is kept — it is the list prime content.

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

/** Keep a compact commercial bag on the list view (drop long evidence arrays if ever huge). */
export function slimCommercial(commercial) {
  if (!commercial || typeof commercial !== "object") return commercial;
  return {
    schema: commercial.schema,
    request_id: commercial.request_id,
    item: commercial.item,
    quantities: Array.isArray(commercial.quantities) ? commercial.quantities.slice(0, 4) : [],
    price_facts: Array.isArray(commercial.price_facts) ? commercial.price_facts.slice(0, 6) : [],
    primary_price: commercial.primary_price,
    sale_method: commercial.sale_method
      ? {
          method: commercial.sale_method.method,
          confidence: commercial.sale_method.confidence,
        }
      : null,
    participation: commercial.participation
      ? {
          package_url: commercial.participation.package_url,
          has_fields: commercial.participation.has_fields,
          // List does not need full step evidence; detail re-extracts from body when full.
          step_count: Array.isArray(commercial.participation.steps)
            ? commercial.participation.steps.length
            : 0,
        }
      : null,
    deal_signal: commercial.deal_signal
      ? {
          status: commercial.deal_signal.status,
          pct_of_value: commercial.deal_signal.pct_of_value,
          summary: commercial.deal_signal.summary,
          method: commercial.deal_signal.method,
          comparables_slot: commercial.deal_signal.comparables_slot
            ? { status: commercial.deal_signal.comparables_slot.status }
            : null,
        }
      : null,
    close_date: commercial.close_date,
    glance: commercial.glance,
  };
}

export function slimPropertyListRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  for (const key of PROPERTY_LIST_DROP_FIELDS) delete out[key];
  if (out.commercial) out.commercial = slimCommercial(out.commercial);
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
