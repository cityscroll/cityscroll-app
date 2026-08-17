/**
 * Architectural boundaries consumed by dependency-cruiser and the local
 * architecture fitness runner.
 *
 * The site-to-Worker rule is intentionally a warning while the existing
 * mandate land-use bridge still imports the Worker subject registry. The
 * other boundaries are enforced errors because the current graph satisfies
 * them and they protect deploy and publication ownership.
 */
const forbidden = [
  {
    name: "site-must-not-import-worker-internals",
    severity: "warn",
    comment: "The site has one existing shared-registry exception; migrate it before making this an error.",
    from: { path: "^site/" },
    to: { path: "^worker/" },
  },
  {
    name: "worker-must-not-import-warehouse-batch-jobs",
    severity: "error",
    comment: "Worker request and scheduled code cannot depend on host-only warehouse batch jobs.",
    from: { path: "^worker/" },
    to: { path: "^warehouse/scripts/" },
  },
  {
    name: "source-adapters-must-not-import-ui",
    severity: "warn",
    comment: "The current host retention adapters reuse pure site helpers; split those helpers before making this an error.",
    from: {
      path: "^(?:worker/(?:src/)?(?:.*(?:source_records|adapter|client|lookup).*\\.m?js)|warehouse/lib/.*\\.m?js)$",
    },
    to: { path: "^site/" },
  },
  {
    name: "er-scorers-must-not-write-durable-links",
    severity: "error",
    comment: "Scorers return probability and evidence; policy and publication own durable entity links.",
    from: { path: "^entity_resolution/scorers/" },
    to: {
      path: "^(?:worker/src/|warehouse/scripts/|entity_resolution/(?:publication|review)/)",
    },
  },
  {
    name: "people-owner-must-not-import-exams-owner",
    severity: "error",
    comment: "People and Exams own independent descriptors, read models, filters, and controllers.",
    from: { path: "^site/people_organizations_surface\\.mjs$" },
    to: { path: "^site/exams_surface\\.mjs$" },
  },
  {
    name: "people-owner-must-not-import-staffing-owner",
    severity: "error",
    comment: "People and Staffing own independent descriptors, read models, filters, and controllers.",
    from: { path: "^site/people_organizations_surface\\.mjs$" },
    to: { path: "^site/staffing_surface\\.mjs$" },
  },
  {
    name: "exams-owner-must-not-import-people-owner",
    severity: "error",
    comment: "People and Exams own independent descriptors, read models, filters, and controllers.",
    from: { path: "^site/exams_surface\\.mjs$" },
    to: { path: "^site/people_organizations_surface\\.mjs$" },
  },
  {
    name: "exams-owner-must-not-import-staffing-owner",
    severity: "error",
    comment: "Exams and Staffing own independent descriptors, read models, filters, and controllers.",
    from: { path: "^site/exams_surface\\.mjs$" },
    to: { path: "^site/staffing_surface\\.mjs$" },
  },
  {
    name: "staffing-owner-must-not-import-people-owner",
    severity: "error",
    comment: "Staffing and People own independent descriptors, read models, filters, and controllers.",
    from: { path: "^site/staffing_surface\\.mjs$" },
    to: { path: "^site/people_organizations_surface\\.mjs$" },
  },
  {
    name: "staffing-owner-must-not-import-exams-owner",
    severity: "error",
    comment: "Staffing and Exams own independent descriptors, read models, filters, and controllers.",
    from: { path: "^site/staffing_surface\\.mjs$" },
    to: { path: "^site/exams_surface\\.mjs$" },
  },
];

export default {
  forbidden,
  options: {
    doNotFollow: { path: "(^|/)node_modules/" },
    exclude: "(^|/)(?:node_modules|\.git|\.venv[^/]*)/",
    includeOnly: "\\.(?:c?m?js)$",
    preserveSymlinks: true,
  },
};

export { forbidden };
