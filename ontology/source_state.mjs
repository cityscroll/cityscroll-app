/**
 * Normalize the independent source-state axes used by acquisition, product
 * delivery, warehouse retention, and immutable D1 observations.
 *
 * Warehouse snapshots describe build/runtime product inputs. They never imply
 * that production D1 `source_records` contains the same observations.
 */
export function normalizeSourceState({ contract = {}, coverage = null, coverageId = null } = {}) {
  const warehouse = contract.warehouse_snapshot || null;
  const liveObservation = coverage?.live_observation || null;
  const dualWriteStatus = coverage?.dual_write?.after || null;
  const coverageStatus = coverage
    ? String(liveObservation?.status || dualWriteStatus || "unknown")
    : contract.observation_coverage === false
      ? "not-applicable"
      : "not-declared";

  return {
    acquisition_status: String(contract.status || "unknown"),
    product_delivery_tier: contract.delivery_tier || null,
    warehouse_snapshot: warehouse
      ? {
          status: String(warehouse.status || "materialized"),
          artifact: warehouse.artifact || null,
          materialized_at: warehouse.materialized_at || null,
          row_count: Number.isFinite(warehouse.row_count) ? warehouse.row_count : null,
          project_count: Number.isFinite(warehouse.project_count) ? warehouse.project_count : null,
        }
      : {
          status: "none",
          artifact: null,
          materialized_at: null,
          row_count: null,
          project_count: null,
        },
    source_records_coverage: {
      coverage_id: coverageId || coverage?.id || contract.id || null,
      status: coverageStatus,
      dual_write_status: dualWriteStatus,
      live_status: liveObservation?.status || null,
      row_count: Number.isFinite(liveObservation?.row_count) ? liveObservation.row_count : null,
      measured_at: liveObservation?.measured_at || null,
      known_gap: coverage?.known_gap || null,
    },
  };
}

export function isProductMaterialized(sourceState) {
  return sourceState?.warehouse_snapshot?.status === "materialized"
    || ["edge-materialized", "inline-at-build"].includes(sourceState?.product_delivery_tier);
}
