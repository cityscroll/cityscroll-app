/**
 * Receipt-gated procurement planning joins for the Money lifecycle.
 *
 * The RC-1 materializer writes bridge_edges only after a source path clears its
 * fixed-sample usefulness and precision-review gates. This reader therefore
 * consumes materialized edges as the acceptance boundary; it never recreates a
 * fuzzy match in the browser. An absent payload or an empty edge array is a
 * clean no-op.
 */

export const PROCUREMENT_PLANNING_SCHEMA = "cityscroll.procurement_planning.v1";

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

/** Collect the publisher record identifiers represented by one lifecycle thread. */
export function procurementThreadRefs(lifecycle = {}, notice = {}) {
  const refs = new Map();
  const identifiers = new Set();

  addRef(refs, "city_record", notice.request_id);
  addIdentifier(identifiers, notice.pin);
  addIdentifier(identifiers, lifecycle.pin);

  const visitDetail = (detail = {}) => {
    addRef(refs, "city_record", detail.request_id);
    addRef(refs, "passport_contract", detail.passport_record_id || detail.ctr_id);
    addRef(refs, "passport_rfx", detail.rfp_id);
    addIdentifier(identifiers, detail.pin);
    addIdentifier(identifiers, detail.epin);
    addIdentifier(identifiers, detail.contract_id);
    const rfx = detail.rfx || {};
    addRef(refs, "passport_rfx", rfx.rfp_id);
    addIdentifier(identifiers, rfx.epin);
  };

  for (const entry of lifecycle.timeline || []) {
    visitDetail(entry?.detail || {});
    visitDetail(entry?.rfx?.detail || {});
  }
  visitDetail(lifecycle.rfx_detail?.detail || {});

  return { refs, identifiers };
}

function edgeBelongsToThread(edge, thread) {
  const target = clean(edge?.target_id);
  const source = clean(edge?.target_source);
  const sourceRefs = source ? thread.refs.get(source) : null;
  if (target && sourceRefs?.size) return sourceRefs.has(target);
  const identifier = idKey(edge?.identifier);
  return !!identifier && thread.identifiers.has(identifier);
}

function acceptedPayload(payload) {
  return !!(
    payload &&
    payload.schema === PROCUREMENT_PLANNING_SCHEMA &&
    payload.contract?.unmatched_rows_remain_unmatched === true &&
    payload.contract?.infer_budget_from_agency_total === false &&
    payload.contract?.budget_provenance_required === true &&
    Array.isArray(payload.plans) &&
    Array.isArray(payload.bridge_edges)
  );
}

/**
 * Return MOCS plan rows joined to this thread by materialized RC-1 edges.
 * Capital-project rows remain separate: this surface is for publisher plan rows.
 */
export function planningEntriesForThread(payload, lifecycle = {}, notice = {}) {
  if (!acceptedPayload(payload) || payload.bridge_edges.length === 0) return [];
  const thread = procurementThreadRefs(lifecycle, notice);
  const plans = new Map(
    payload.plans
      .filter((plan) => plan?.source === "mocs_ll63" || plan?.source === "mocs_ll1")
      .map((plan) => [clean(plan.source_record_id), plan]),
  );
  const seen = new Set();
  const entries = [];

  for (const edge of payload.bridge_edges) {
    if (!edgeBelongsToThread(edge, thread)) continue;
    const planId = clean(edge.plan_source_record_id);
    const plan = plans.get(planId);
    if (!plan || edge.plan_source !== plan.source || seen.has(planId)) continue;
    seen.add(planId);
    entries.push({
      stage: "planning",
      status: "matched",
      source: "mocs-procurement-plan",
      date: null,
      source_timestamp: payload.generated_at || null,
      detail: {
        plan,
        bridge: {
          method: edge.method,
          score: edge.score,
          target_source: edge.target_source,
          target_id: edge.target_id,
        },
        fiscal_year: payload.fiscal_year,
      },
    });
  }

  return entries.sort((a, b) =>
    String(a.detail.plan.source_record_id).localeCompare(String(b.detail.plan.source_record_id)),
  );
}

/** Add accepted planning entries ahead of the existing lifecycle, or return it unchanged. */
export function attachPlanningPhase(payload, lifecycle = {}, notice = {}) {
  const planning = planningEntriesForThread(payload, lifecycle, notice);
  if (planning.length === 0) return lifecycle;
  return {
    ...lifecycle,
    timeline: [...planning, ...(lifecycle.timeline || [])],
  };
}
