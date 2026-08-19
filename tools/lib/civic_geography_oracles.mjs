// MODA is an external QA oracle only. Comparison is fail-closed: every
// required source vintage and identity strategy must agree before overlap
// rows can be considered. A mismatch is skipped, never reported as passed.

const ORACLE_TYPE_IDS = Object.freeze({
  nta2020: "nta2020",
  police_precinct: "police_precinct",
});

export function evaluateModaGeographyOracle(registry = {}, oracle = {}) {
  if (oracle.schema !== "cityscroll.geography_crosswalk_oracle_pin.v1") {
    return { status: "skipped", reason: "invalid_oracle_pin", mismatches: [] };
  }
  const byType = new Map((registry.layers || []).map((layer) => [layer.type, layer]));
  const mismatches = [];
  for (const [oracleType, registryType] of Object.entries(ORACLE_TYPE_IDS)) {
    const expected = String(oracle.oracle_source_vintages?.[oracleType] || "").toUpperCase();
    const current = String(byType.get(registryType)?.boundary_vintage || "").toUpperCase();
    if (!expected || !current || expected !== current) {
      mismatches.push({ type: registryType, oracle: expected || null, current: current || null });
    }
  }
  if (mismatches.length) return { status: "skipped", reason: "vintage_mismatch", mismatches };
  if ((oracle.evaluation?.uncomparable || []).length) {
    return {
      status: "skipped",
      reason: "identity_or_vintage_not_declared",
      mismatches: [],
      uncomparable: oracle.evaluation.uncomparable,
    };
  }
  return { status: "ready", reason: null, mismatches: [] };
}
