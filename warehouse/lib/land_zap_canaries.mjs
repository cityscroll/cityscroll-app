/**
 * Field-case land projects that must stay in the sell-facing lookup + keyword
 * index. Kept fs-free so the keyword miss-fill path can reuse the same list.
 */
export const LAND_ZAP_FRESHNESS_CANARIES = Object.freeze([
  Object.freeze({
    project_id: "2025Q0331",
    label: "44-17 Greenpoint Avenue Rezoning",
  }),
  Object.freeze({
    project_id: "2026K0123",
    label: "1550 Bedford Avenue Rezoning",
  }),
]);
