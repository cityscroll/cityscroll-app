export const PROCUREMENT_PLANNING_LOOKUP_SCHEMA = "cityscroll.procurement_planning.thread-lookup.v1";

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function idKey(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function addRef(refs, source, value) {
  const key = clean(value);
  if (!key) return;
  if (!refs.has(source)) refs.set(source, new Set());
  refs.get(source).add(key);
}

function addIdentifier(identifiers, value) {
  const key = idKey(value);
  if (key) identifiers.add(key);
}

/** Collect exact publisher references represented by one procurement thread. */
export function procurementThreadRefs(lifecycle = {}, notice = {}) {
  const refs = new Map();
  const identifiers = new Set();
  addRef(refs, "city_record", notice.request_id);
  addIdentifier(identifiers, notice.pin);
  addIdentifier(identifiers, lifecycle.pin);

  const visit = (detail = {}) => {
    addRef(refs, "city_record", detail.request_id);
    addRef(refs, "passport_contract", detail.passport_record_id || detail.ctr_id);
    addRef(refs, "passport_rfx", detail.rfp_id);
    addIdentifier(identifiers, detail.pin);
    addIdentifier(identifiers, detail.epin);
    addIdentifier(identifiers, detail.contract_id);
    addRef(refs, "passport_rfx", detail.rfx?.rfp_id);
    addIdentifier(identifiers, detail.rfx?.epin);
  };
  for (const entry of lifecycle.timeline || []) {
    visit(entry?.detail);
    visit(entry?.rfx?.detail);
  }
  visit(lifecycle.rfx_detail?.detail);
  return { refs, identifiers };
}

export function edgeBelongsToThread(edge, thread) {
  const target = clean(edge?.target_id);
  const refs = thread.refs.get(clean(edge?.target_source));
  if (target && refs?.size) return refs.has(target);
  const identifier = idKey(edge?.identifier);
  return !!identifier && thread.identifiers.has(identifier);
}

/** Return only receipt-passed lookup rows belonging to this exact thread. */
export function planningRowsForThread(lookup, lifecycle = {}, notice = {}) {
  if (
    lookup?.schema !== PROCUREMENT_PLANNING_LOOKUP_SCHEMA ||
    lookup.contract?.unmatched_rows_remain_unmatched !== true ||
    lookup.contract?.infer_budget_from_agency_total !== false ||
    lookup.contract?.budget_provenance_required !== true ||
    !Array.isArray(lookup.rows) || !lookup.rows.length
  ) return [];
  const thread = procurementThreadRefs(lifecycle, notice);
  return lookup.rows.filter((row) => row?.plan && edgeBelongsToThread(row.edge, thread));
}

let lookupPromise;

/** Load and attach planning detail only after an intentional thread-detail request. */
export async function attachAvailablePlanning(lifecycle, notice) {
  lookupPromise ||= fetch("./data/procurement_planning_thread_lookup.json", {
    credentials: "omit",
    cache: "no-cache",
  }).then((response) => response?.ok ? response.json() : null).catch(() => null);
  const lookup = await lookupPromise;
  if (!planningRowsForThread(lookup, lifecycle, notice).length) return lifecycle;
  return import("./procurement_planning_surface.mjs")
    .then((tools) => tools.attachPlanningLookup(lookup, lifecycle, notice))
    .catch(() => lifecycle);
}
