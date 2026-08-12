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
